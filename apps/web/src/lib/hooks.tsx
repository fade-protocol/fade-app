import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetchProtocolState, type ProtocolState } from "./fade";
import type { Address } from "@solana/kit";
import { fetchStats } from "./stats";
import { fetchProgramTickets, fetchWalletTickets, type WalletTickets } from "./ticketLog";

type Loaded<T> = { data: T | null; error: string | null; loading: boolean; refresh: () => void };

const REFRESH_EVENT = "fade:refresh";

/** Makes every poll on the page read again now, e.g. after funds arrived from the faucet. */
export function refreshAll(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

/** Polls `fn` every `ms`, pausing while the tab is hidden. */
export function usePolling<T>(
  fn: () => Promise<T>,
  ms: number,
  deps: readonly unknown[] = [],
): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    window.addEventListener(REFRESH_EVENT, refresh);
    return () => window.removeEventListener(REFRESH_EVENT, refresh);
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(run, ms);
        return;
      }
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
          timer = setTimeout(run, ms);
        }
      }
    };
    void run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, tick, ...deps]);

  return { data, error, loading, refresh };
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

/** The program's recent tickets (lib/ticketLog), read every 20 s; callers share one read. */
export function useProgramTickets() {
  return usePolling(fetchProgramTickets, 20_000);
}

/** The keeper's all-time figures (lib/stats), read every 30 s: what the endpoint caches them for. */
export function useStats() {
  return usePolling(fetchStats, 30_000);
}

/**
 * One wallet's tickets (lib/ticketLog), read every 30 s and again shortly after a demo's draw
 * ends in this browser. Only what was read for this wallet: a poll keeps its last data otherwise.
 */
export function useWalletTickets(owner: Address | undefined): Loaded<WalletTickets> {
  const read = usePolling(async () => (owner ? fetchWalletTickets(owner) : null), 30_000, [owner]);
  const { refresh } = read;
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
  return { ...read, data: read.data && read.data.owner === owner ? read.data : null };
}
