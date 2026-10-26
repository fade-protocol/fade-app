import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetchProtocolState, type ProtocolState } from "./fade";
import type { Address } from "@solana/kit";
import { fetchStats, parseStats } from "./stats";
import { markWalletChanged, walletTicketsRead } from "./keeperWallet";
import { live, walletPollMs, type LiveTopic, type LiveWalletMessage } from "./live";
import { fetchProgramTickets, type WalletTickets } from "./ticketLog";
import { acceptVaultApr, fetchVaultApr, lastVaultApr } from "./vaultApr";
import {
  acceptKeeperFeed,
  acceptKeeperProviders,
  acceptKeeperVault,
  feedAsRead,
  fetchKeeperFeed,
  fetchKeeperProviders,
  fetchKeeperVault,
  keeperAsRead,
  lastKeeperFeed,
  lastKeeperProviders,
  lastKeeperVault,
  providersAsRead,
  vaultAsRead,
} from "./keeperViews";

type Loaded<T> = { data: T | null; error: string | null; loading: boolean; refresh: () => void };

const REFRESH_EVENT = "fade:refresh";

/** Makes every poll on the page read again now, e.g. after funds arrived from the faucet. */
export function refreshAll(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

/**
 * A keeper route's live push (lib/live): its topic, and the parse of its answer, sent at `at`
 * (the keeper's clock, Unix seconds; null when it does not say); null: unreadable.
 */
export type LiveSource<T> = {
  topic: LiveTopic;
  parse: (j: unknown, at: number | null) => T | null;
};

/**
 * Subscribes to a topic of the keeper's push while `topic` is set, each answer to `onData`.
 * Returns whether the topic is live now: its answers come by push, the page need not poll.
 */
export function useLiveTopic(
  topic: LiveTopic | null,
  onData: (data: unknown, at: number | null) => void,
): boolean {
  const ref = useRef(onData);
  ref.current = onData;
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!topic) {
      setOn(false);
      return;
    }
    const unwatch = live.watch(() => setOn(live.isLive(topic)));
    const off = live.topic(topic, (d, at) => ref.current(d, at));
    setOn(live.isLive(topic));
    return () => {
      off();
      unwatch();
    };
  }, [topic]);
  return on;
}

/**
 * Subscribes to the keeper's notifications of `owner`'s new transactions while it is set, each
 * to `onPush`. Returns whether the keeper notifies this page of them now.
 */
export function useLiveWallet(
  owner: Address | undefined,
  onPush: (m: LiveWalletMessage) => void,
): boolean {
  const ref = useRef(onPush);
  ref.current = onPush;
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!owner) {
      setOn(false);
      return;
    }
    const unwatch = live.watch(() => setOn(live.walletLive(owner)));
    const off = live.wallet(owner, (m) => ref.current(m));
    setOn(live.walletLive(owner));
    return () => {
      off();
      unwatch();
    };
  }, [owner]);
  return on;
}

const intervalOf = (ms: number | (() => number)) => (typeof ms === "function" ? ms() : ms);

/** A poll's answer, and `reschedule`: the pending poll brought forward to the interval now. */
export type Polled<T> = Loaded<T> & { reschedule: () => void };

/**
 * Polls `fn` every `ms`, pausing while the tab is hidden: a poll that came due (or a `refresh`
 * asked) while it was hidden reads as soon as it is shown again. `ms` may be a function, asked
 * each time a poll is scheduled: a change of what it returns sets only the next delay, it never
 * reads at once (`reschedule` brings a pending poll forward to it). With `live`, the route's
 * answers also come by the keeper's push (lib/live): each one pushed is the data, and the polls
 * stop while the topic is live and its answers read; they start again at once when it is not
 * (the connection dropped, or the topic went quiet), the last answer kept on screen meanwhile,
 * and when a pushed answer does not read (`error` says so): the polls, and the fallback their
 * own errors start, then decide.
 */
export function usePolling<T>(
  fn: () => Promise<T>,
  ms: number | (() => number),
  deps: readonly unknown[] = [],
  live: LiveSource<T> | null = null,
): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const msRef = useRef(ms);
  msRef.current = ms;
  // the pending poll, while one is scheduled: its run and when it is due (milliseconds)
  const pending = useRef<{
    timer: ReturnType<typeof setTimeout>;
    run: () => void;
    due: number;
  } | null>(null);
  const reschedule = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    const at = Date.now() + intervalOf(msRef.current);
    if (at >= p.due) return;
    clearTimeout(p.timer);
    pending.current = { ...p, timer: setTimeout(p.run, at - Date.now()), due: at };
  }, []);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const liveRef = useRef(live);
  liveRef.current = live;
  // the last answer pushed did not read: the topic does not count as live
  const [pushUnread, setPushUnread] = useState(false);
  const liveOn = useLiveTopic(live?.topic ?? null, (j, at) => {
    const v = liveRef.current?.parse(j, at) ?? null;
    setLoading(false);
    if (v === null) {
      setPushUnread(true);
      setError("the keeper pushed an unreadable answer");
      return;
    }
    setPushUnread(false);
    setData(v);
    setError(null);
  });
  const pushed = liveOn && !pushUnread;

  useEffect(() => {
    window.addEventListener(REFRESH_EVENT, refresh);
    return () => window.removeEventListener(REFRESH_EVENT, refresh);
  }, [refresh]);

  useEffect(() => {
    if (pushed) return;
    let alive = true;
    // a poll that came due while the tab was hidden: read once it is shown
    let missed = false;
    const schedule = () => {
      const ms = intervalOf(msRef.current);
      const again = () => void run();
      pending.current = { timer: setTimeout(again, ms), run: again, due: Date.now() + ms };
    };
    const run = async () => {
      pending.current = null;
      if (document.visibilityState === "hidden") {
        missed = true;
        schedule();
        return;
      }
      missed = false;
      try {
        const v = await fnRef.current();
        if (!alive) return;
        setData(v);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) {
          setLoading(false);
          schedule();
        }
      }
    };
    const shown = () => {
      if (!missed || document.visibilityState === "hidden") return;
      if (pending.current) clearTimeout(pending.current.timer);
      void run();
    };
    document.addEventListener("visibilitychange", shown);
    void run();
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", shown);
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = null;
    };
    // a function `ms` is asked at each poll: only a fixed one starts the polls again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeof ms === "function" ? null : ms, tick, pushed, ...deps]);

  return { data, error, loading, refresh, reschedule };
}

const ProtocolContext = createContext<Loaded<ProtocolState> | null>(null);

export function ProtocolProvider({ children }: { children: ReactNode }) {
  const state = usePolling(fetchProtocolState, 10_000);
  return <ProtocolContext.Provider value={state}>{children}</ProtocolContext.Provider>;
}

/** Config, Vault and Queue, refreshed every 10 s and shared by every page. */
export function useProtocol(): Loaded<ProtocolState> {
  const v = useContext(ProtocolContext);
  if (!v) throw new Error("useProtocol outside ProtocolProvider");
  return v;
}

/**
 * Chain time in seconds, ticking every second between two reads of the state: the last read's
 * chain clock, plus the local time since that read.
 */
export function useChainNow(state: { now: bigint; fetchedAt: number }): number {
  return Number(state.now) + (useNow() - state.fetchedAt);
}

/** The current time in seconds, ticking every second. */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * The program's recent tickets, read only while `needed`: the fallback of the APR, the vault's
 * history and the live feed when the keeper cannot serve them (pages/vault/Apr.tsx, Vault.tsx,
 * Home.tsx). Callers share one read.
 */
export function useProgramTicketsWhen(needed: boolean) {
  return usePolling(async () => (needed ? fetchProgramTickets() : null), 20_000, [needed]);
}

const APR_LIVE: LiveSource<Awaited<ReturnType<typeof fetchVaultApr>>> = {
  topic: "apr",
  parse: acceptVaultApr,
};
const VAULT_LIVE: LiveSource<Awaited<ReturnType<typeof fetchKeeperVault>>> = {
  topic: "vault",
  parse: acceptKeeperVault,
};
const FEED_LIVE: LiveSource<Awaited<ReturnType<typeof fetchKeeperFeed>> | null> = {
  topic: "feed",
  parse: acceptKeeperFeed,
};
const PROVIDERS_LIVE: LiveSource<Awaited<ReturnType<typeof fetchKeeperProviders>> | null> = {
  topic: "providers",
  parse: acceptKeeperProviders,
};
const STATS_LIVE: LiveSource<Awaited<ReturnType<typeof fetchStats>>> = {
  topic: "stats",
  parse: parseStats,
};

/**
 * The keeper's APR (lib/vaultApr), pushed as it changes (lib/live), else read every 30 s: what
 * the endpoint caches it for. A page opened later starts from the last answer.
 */
export function useVaultApr() {
  const loaded = usePolling(fetchVaultApr, 30_000, [], APR_LIVE);
  return loaded.data ? loaded : { ...loaded, data: lastVaultApr() };
}

/**
 * The keeper's vault history (lib/keeperViews, GET /v1/vault), pushed as it changes, else read
 * every 30 s: what the endpoint caches it for. A page opened later starts from the last answer, shown as it is until this
 * page's first read settles (`keeperAsRead`). Weighed against the latest read: syncing once that
 * read failed or the answer is old (`vaultAsRead`).
 */
export function useKeeperVault() {
  const loaded = usePolling(fetchKeeperVault, 30_000, [], VAULT_LIVE);
  const { data, error, loading } = loaded;
  const view = useMemo(
    () =>
      keeperAsRead({ data, error, loading }, lastKeeperVault(), vaultAsRead, Date.now() / 1_000),
    [data, error, loading],
  );
  return { ...loaded, data: view };
}

/**
 * The keeper's feed of the newest tickets and requests (lib/keeperViews, GET /v1/feed), pushed as
 * it changes, else read every 10 s, while `enabled`. A page opened later starts from the last answer. Weighed against
 * the latest read as `useKeeperVault` (`feedAsRead`).
 */
export function useKeeperFeed(enabled = true) {
  const loaded = usePolling(
    async () => (enabled ? fetchKeeperFeed() : null),
    10_000,
    [enabled],
    enabled ? FEED_LIVE : null,
  );
  const { data, error, loading } = loaded;
  const view = useMemo(
    () => keeperAsRead({ data, error, loading }, lastKeeperFeed(), feedAsRead, Date.now() / 1_000),
    [data, error, loading],
  );
  return { ...loaded, data: view };
}

/**
 * The keeper's liquidity providers (lib/keeperViews, GET /v1/providers), pushed as they change,
 * else read every 60 s, while `enabled`: what the endpoint caches them for. A page opened later starts from the last answer.
 * Weighed against the latest read as `useKeeperVault` (`providersAsRead`).
 */
export function useKeeperProviders(enabled = true) {
  const loaded = usePolling(
    async () => (enabled ? fetchKeeperProviders() : null),
    60_000,
    [enabled],
    enabled ? PROVIDERS_LIVE : null,
  );
  const { data, error, loading } = loaded;
  const view = useMemo(
    () =>
      keeperAsRead(
        { data, error, loading },
        lastKeeperProviders(),
        providersAsRead,
        Date.now() / 1_000,
      ),
    [data, error, loading],
  );
  return { ...loaded, data: view };
}

/**
 * The keeper's all-time figures (lib/stats), pushed as they change, else read every 30 s: what the
 * endpoint caches them for.
 */
export function useStats() {
  return usePolling(fetchStats, 30_000, [], STATS_LIVE);
}

/** How long a wallet's notification waits for the next one before the page reads again. */
const WALLET_PUSH_SETTLE_MS = 1_000;

/**
 * Reads again shortly after the keeper says it indexed new transactions of `owner` (lib/live),
 * past the browser's cache of the route; notifications close together make one read. Returns
 * whether those notifications come now.
 */
export function useWalletPush(owner: Address | undefined, refresh: () => void): boolean {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useLiveWallet(owner, () => {
    if (!owner) return;
    markWalletChanged(owner);
    clearTimeout(timer.current);
    timer.current = setTimeout(refresh, WALLET_PUSH_SETTLE_MS);
  });
}

/**
 * One wallet's tickets (lib/keeperWallet: the keeper's history with the newest transactions
 * merged in, else the app's own reads), read again when the keeper says it indexed new
 * transactions of it (lib/live) and shortly after a demo's draw ends in this browser; polled as
 * lib/live `walletPollMs` says: less often only while those notifications are confirmed and the
 * last read was the keeper's fresh answer. Only what was read for this wallet: a poll keeps its
 * last data otherwise.
 */
export function useWalletTickets(owner: Address | undefined): Loaded<WalletTickets> {
  const refreshRef = useRef<() => void>(() => {});
  const pushed = useWalletPush(owner, () => refreshRef.current());
  // the last read's `through`, asked when the next poll is scheduled: it never starts a read
  const through = useRef<{ owner: Address; at: number | null } | null>(null);
  const read = usePolling(
    async () => {
      if (!owner) return null;
      const r = await walletTicketsRead(owner);
      through.current = { owner, at: r.through };
      return r.tickets;
    },
    () => {
      const last = through.current;
      return walletPollMs(
        pushed,
        last && last.owner === owner ? last.at : null,
        Date.now() / 1_000,
      );
    },
    [owner],
  );
  const { refresh, reschedule } = read;
  refreshRef.current = refresh;
  // notifications no longer confirmed: a pending poll comes no later than the usual pace
  useEffect(() => {
    if (!pushed) reschedule();
  }, [pushed, reschedule]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      clearTimeout(t);
      t = setTimeout(refresh, 2_500);
    };
    window.addEventListener("fade:draws", on);
    return () => {
      clearTimeout(t);
      window.removeEventListener("fade:draws", on);
    };
  }, [refresh]);
  return {
    data: read.data && read.data.owner === owner ? read.data : null,
    error: read.error,
    loading: read.loading,
    refresh,
  };
}
