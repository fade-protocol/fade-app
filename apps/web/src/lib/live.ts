// The keeper's live push as the app reads it (GET /v1/live, lib/liveProtocol): one WebSocket per
// page, opened while something on the page subscribes and closed a little after the last one
// leaves. A topic's answer arrives as its route serves it (the same parse applies), and a
// subscribed wallet is notified when the keeper indexed new transactions of it.
//
// Push is an accelerator, never a dependency: a topic is live only while the connection is open
// and its answer arrived in the last LIVE_REFRESH_MS × 2.5 (the keeper sends it at least every
// LIVE_REFRESH_MS). Otherwise the page polls the route as it always did (lib/hooks
// `usePolling`), and it starts again at once when the connection drops. A dead connection is
// found by its heartbeat ("ping" every HEARTBEAT_MS, answered "pong"): nothing heard for
// SILENCE_MS closes it. A lost connection is opened again after a backoff (doubling from
// BACKOFF_MIN_MS to BACKOFF_MAX_MS, with jitter), reset once the keeper answers again.
//
// A tab hidden for HIDDEN_CLOSE_MS closes its connection and opens none while it stays hidden
// (its polls pause too, lib/hooks `usePolling`): the keeper keeps building the views only for
// pages someone watches, and a forgotten tab holds none of its connection slots. It connects
// again, with its subscriptions, as soon as it is shown.
//
// A wallet's notifications come only for the transactions the keeper indexed, so a confirmed
// subscription alone does not let the page poll its history less often: `walletPollMs` also asks
// for the keeper's last answer of it to be fresh.
import { API_URL } from "./config";
import {
  LIVE_PATH,
  LIVE_PING,
  LIVE_PONG,
  LIVE_REFRESH_MS,
  encodeLiveOp,
  parseLiveMessage,
  type LiveTopic,
  type LiveWalletMessage,
} from "./liveProtocol";

export type { LiveTopic, LiveWalletMessage } from "./liveProtocol";

/** The keeper's push, on the API's host. */
export const LIVE_URL = `${API_URL.replace(/^http/, "ws")}${LIVE_PATH}`;

export const HEARTBEAT_MS = 25_000;
export const SILENCE_MS = 60_000;
export const TOPIC_SILENCE_MS = LIVE_REFRESH_MS * 2.5;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** How long the connection stays open once nothing subscribes: a page change keeps it. */
export const LINGER_MS = 10_000;
/** How long a hidden tab keeps its connection: a quick switch of tabs keeps it. */
export const HIDDEN_CLOSE_MS = 30_000;

/** How often a wallet's history is polled while the keeper's notifications cannot be relied on. */
export const WALLET_POLL_MS = 30_000;
/**
 * How often it is polled while they can: a safety net, the notifications bring the changes. A
 * keeper that stops indexing is noticed at the next of these polls (`walletPollMs`), and that
 * poll already merges the wallet's newer transactions read from the chain (lib/keeperWallet).
 */
export const WALLET_LIVE_POLL_MS = 120_000;
/**
 * How old (seconds) the keeper's last answer of a wallet may be, by its `through`, for its
 * notifications to be relied on: the keeper's lag behind finality (WALLET_FINALITY_S, 60 s),
 * its loop (at most 20 s), its build (10 s) and the browser's cache of the route (15 s), with
 * room to spare. Older, the keeper is behind or stalled and sends no notification.
 */
export const WALLET_LIVE_FRESH_S = 150;

/**
 * How often a wallet's history is polled: WALLET_LIVE_POLL_MS only while the keeper confirmed
 * its notifications (`notified`) and the last read was the keeper's answer (`through`, Unix
 * seconds; null when the app read the history itself or nothing was read yet) no older than
 * WALLET_LIVE_FRESH_S at `now` (Unix seconds): the keeper is demonstrably indexing. Otherwise
 * WALLET_POLL_MS, the app's own reads at their usual pace.
 */
export function walletPollMs(notified: boolean, through: number | null, now: number): number {
  return notified && through !== null && now - through <= WALLET_LIVE_FRESH_S
    ? WALLET_LIVE_POLL_MS
    : WALLET_POLL_MS;
}

type Socket = {
  readonly readyState: number;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
type SocketCtor = new (url: string) => Socket;

/** Whether the page is hidden, and its changes (the document's, by default). */
export type Visibility = {
  hidden(): boolean;
  /** Calls `cb` each time it changes; returns the unlisten. */
  listen(cb: () => void): () => void;
};

/** The document's visibility; null where there is no document. */
function documentVisibility(): Visibility | null {
  const d = (globalThis as { document?: Document }).document;
  if (!d || typeof d.addEventListener !== "function") return null;
  return {
    hidden: () => d.visibilityState === "hidden",
    listen: (cb) => {
      d.addEventListener("visibilitychange", cb);
      return () => d.removeEventListener("visibilitychange", cb);
    },
  };
}

export type LiveOptions = {
  url?: string;
  /** null: no push (the page polls); the global WebSocket by default. */
  WebSocket?: SocketCtor | null;
  heartbeatMs?: number;
  silenceMs?: number;
  topicSilenceMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  lingerMs?: number;
  hiddenCloseMs?: number;
  /** null: the connection ignores whether the page is hidden; the document's by default. */
  visibility?: Visibility | null;
  random?: () => number;
  now?: () => number;
};

const OPEN = 1;

export class LiveClient {
  private readonly url: string;
  private readonly Ctor: SocketCtor | null;
  private readonly o: Required<Omit<LiveOptions, "url" | "WebSocket" | "visibility">>;
  private readonly visibility: Visibility | null;
  private unlisten: (() => void) | undefined;
  /** The page has been hidden for hiddenCloseMs: no connection until it is shown again. */
  private asleep = false;
  private hiding: ReturnType<typeof setTimeout> | undefined;
  private ws: Socket | null = null;
  private opened = false;
  private failures = 0;
  private lastHeard = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private linger: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly topics = new Map<LiveTopic, Set<(data: unknown, at: number | null) => void>>();
  /** The topics whose answer arrived on this connection, and when (milliseconds). */
  private readonly fresh = new Map<LiveTopic, number>();
  private readonly wallets = new Map<string, Set<(m: LiveWalletMessage) => void>>();
  /** The wallets the keeper says this connection is subscribed to. */
  private readonly walletsOn = new Set<string>();
  private readonly watchers = new Set<() => void>();
  /** What the keeper was told this connection subscribes to, and whether a sync is queued. */
  private sentTopics = new Set<LiveTopic>();
  private sentWallets = new Set<string>();
  private syncing = false;

  constructor(opts: LiveOptions = {}) {
    this.url = opts.url ?? LIVE_URL;
    const global = (globalThis as { WebSocket?: SocketCtor }).WebSocket ?? null;
    this.Ctor = opts.WebSocket === undefined ? global : opts.WebSocket;
    this.o = {
      heartbeatMs: opts.heartbeatMs ?? HEARTBEAT_MS,
      silenceMs: opts.silenceMs ?? SILENCE_MS,
      topicSilenceMs: opts.topicSilenceMs ?? TOPIC_SILENCE_MS,
      backoffMinMs: opts.backoffMinMs ?? BACKOFF_MIN_MS,
      backoffMaxMs: opts.backoffMaxMs ?? BACKOFF_MAX_MS,
      lingerMs: opts.lingerMs ?? LINGER_MS,
      hiddenCloseMs: opts.hiddenCloseMs ?? HIDDEN_CLOSE_MS,
      random: opts.random ?? Math.random,
      now: opts.now ?? Date.now,
    };
    this.visibility = opts.visibility === undefined ? documentVisibility() : opts.visibility;
  }

  /**
   * Subscribes to a topic's answers, each with when the keeper sent it (its clock, Unix seconds;
   * null when it does not say); returns the unsubscribe.
   */
  topic(topic: LiveTopic, onData: (data: unknown, at: number | null) => void): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      this.topics.set(topic, (set = new Set()));
      this.sync();
    }
    set.add(onData);
    this.ensure();
    return () => {
      const s = this.topics.get(topic);
      if (!s?.delete(onData) || s.size) return;
      this.topics.delete(topic);
      if (this.fresh.delete(topic)) this.changed();
      this.sync();
      this.idle();
    };
  }

  /** Subscribes to a wallet's notifications; returns the unsubscribe. */
  wallet(owner: string, onPush: (m: LiveWalletMessage) => void): () => void {
    let set = this.wallets.get(owner);
    if (!set) {
      this.wallets.set(owner, (set = new Set()));
      this.sync();
    }
    set.add(onPush);
    this.ensure();
    return () => {
      const s = this.wallets.get(owner);
      if (!s?.delete(onPush) || s.size) return;
      this.wallets.delete(owner);
      if (this.walletsOn.delete(owner)) this.changed();
      this.sync();
      this.idle();
    };
  }

  /** Whether a topic's answers come by push now: the page need not poll its route. */
  isLive(topic: LiveTopic): boolean {
    const at = this.fresh.get(topic);
    return this.opened && at !== undefined && this.o.now() - at <= this.o.topicSilenceMs;
  }

  /** Whether the keeper notifies this page of a wallet's new transactions now. */
  walletLive(owner: string): boolean {
    return this.opened && this.walletsOn.has(owner);
  }

  /** Called whenever what is live changes; returns the unwatch. */
  watch(cb: () => void): () => void {
    this.watchers.add(cb);
    return () => this.watchers.delete(cb);
  }

  /** Closes the connection and forgets every subscription (tests, and a page torn down). */
  close(): void {
    this.topics.clear();
    this.wallets.clear();
    clearTimeout(this.retry);
    clearTimeout(this.linger);
    clearTimeout(this.hiding);
    this.retry = this.linger = this.hiding = undefined;
    this.unlisten?.();
    this.unlisten = undefined;
    this.asleep = false;
    const ws = this.ws;
    if (ws) {
      this.lost(ws);
      try {
        ws.close(1000, "closed");
      } catch {
        // closed already
      }
    }
  }

  private subscribed(): boolean {
    return this.topics.size > 0 || this.wallets.size > 0;
  }

  private changed(): void {
    for (const cb of [...this.watchers]) cb();
  }

  /**
   * Tells the keeper what the page subscribes to now, once the changes of this task are in: a
   * page that mounts or leaves several views sends one op each way, not one per view.
   */
  private sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    queueMicrotask(() => {
      this.syncing = false;
      const ws = this.ws;
      if (!ws || !this.opened || ws.readyState !== OPEN) return;
      const topics = [...this.topics.keys()];
      const wallets = [...this.wallets.keys()];
      const add = {
        topics: topics.filter((t) => !this.sentTopics.has(t)),
        wallets: wallets.filter((w) => !this.sentWallets.has(w)),
      };
      const drop = {
        topics: [...this.sentTopics].filter((t) => !this.topics.has(t)),
        wallets: [...this.sentWallets].filter((w) => !this.wallets.has(w)),
      };
      try {
        if (drop.topics.length || drop.wallets.length)
          ws.send(encodeLiveOp({ op: "unsubscribe", ...drop }));
        if (add.topics.length || add.wallets.length)
          ws.send(encodeLiveOp({ op: "subscribe", ...add }));
      } catch {
        // its close follows, and the next connection sends everything
        return;
      }
      this.sentTopics = new Set(topics);
      this.sentWallets = new Set(wallets);
    });
  }

  private ensure(): void {
    clearTimeout(this.linger);
    this.linger = undefined;
    this.watchVisibility();
    if (!this.ws && this.retry === undefined && this.Ctor && !this.asleep) this.connect();
  }

  /** Follows the page's visibility from the first subscription on (`hidden`). */
  private watchVisibility(): void {
    if (this.unlisten || !this.visibility || !this.Ctor) return;
    this.unlisten = this.visibility.listen(() => this.hidden());
    this.hidden();
  }

  /**
   * The page was hidden or shown: hidden for hiddenCloseMs, its connection closes and none is
   * opened; shown, it connects again at once while something subscribes.
   */
  private hidden(): void {
    if (this.visibility?.hidden()) {
      if (this.asleep || this.hiding !== undefined) return;
      this.hiding = setTimeout(() => {
        this.hiding = undefined;
        this.asleep = true;
        clearTimeout(this.retry);
        this.retry = undefined;
        const ws = this.ws;
        if (!ws) return;
        this.lost(ws);
        try {
          ws.close(1000, "hidden");
        } catch {
          // closed already
        }
      }, this.o.hiddenCloseMs);
      return;
    }
    clearTimeout(this.hiding);
    this.hiding = undefined;
    if (!this.asleep) return;
    this.asleep = false;
    this.failures = 0;
    if (this.subscribed() && !this.ws && this.retry === undefined && this.Ctor) this.connect();
  }

  /** Nothing subscribes any more: the connection closes after LINGER_MS unless one comes back. */
  private idle(): void {
    if (this.subscribed() || this.linger !== undefined) return;
    this.linger = setTimeout(() => {
      this.linger = undefined;
      if (this.subscribed()) return;
      clearTimeout(this.retry);
      this.retry = undefined;
      const ws = this.ws;
      if (!ws) return;
      this.lost(ws);
      try {
        ws.close(1000, "idle");
      } catch {
        // closed already
      }
    }, this.o.lingerMs);
  }

  private connect(): void {
    let ws: Socket;
    try {
      ws = new this.Ctor!(this.url);
    } catch {
      this.again();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.opened = true;
      this.lastHeard = this.o.now();
      this.sentTopics = new Set();
      this.sentWallets = new Set();
      this.sync();
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.beat(ws), this.o.heartbeatMs);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== "string") return;
      this.lastHeard = this.o.now();
      if (e.data === LIVE_PONG) return;
      const m = parseLiveMessage(e.data);
      if (!m) return;
      if (m.type === "view") {
        this.failures = 0;
        const was = this.isLive(m.topic);
        this.fresh.set(m.topic, this.o.now());
        for (const cb of [...(this.topics.get(m.topic) ?? [])]) cb(m.data, m.at);
        if (!was) this.changed();
      } else if (m.type === "wallet") {
        for (const cb of [...(this.wallets.get(m.wallet) ?? [])]) cb(m);
      } else if (m.type === "subscribed") {
        this.failures = 0;
        const before = [...this.walletsOn].join();
        this.walletsOn.clear();
        for (const w of m.wallets) if (this.wallets.has(w)) this.walletsOn.add(w);
        if ([...this.walletsOn].join() !== before) this.changed();
      }
    };
    ws.onclose = () => this.lost(ws);
    ws.onerror = () => {
      // its close follows
    };
  }

  /** The heartbeat: a ping, a dead connection closed, a topic gone quiet no longer live. */
  private beat(ws: Socket): void {
    if (this.ws !== ws) return;
    const now = this.o.now();
    if (now - this.lastHeard > this.o.silenceMs) {
      this.lost(ws);
      try {
        ws.close(4000, "silent");
      } catch {
        // closed already
      }
      return;
    }
    try {
      ws.send(LIVE_PING);
    } catch {
      // its close follows
    }
    let quiet = false;
    for (const [t, at] of this.fresh)
      if (now - at > this.o.topicSilenceMs) {
        this.fresh.delete(t);
        quiet = true;
      }
    if (quiet) this.changed();
  }

  /** The connection is gone: nothing is live, and it is opened again while something subscribes. */
  private lost(ws: Socket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.opened = false;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const had = this.fresh.size > 0 || this.walletsOn.size > 0;
    this.fresh.clear();
    this.walletsOn.clear();
    if (had) this.changed();
    if (this.subscribed() && !this.asleep) this.again();
  }

  private again(): void {
    if (this.retry !== undefined) return;
    const base = Math.min(this.o.backoffMaxMs, this.o.backoffMinMs * 2 ** this.failures);
    this.failures++;
    const delay = base / 2 + (this.o.random() * base) / 2;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.subscribed() && !this.ws && !this.asleep) this.connect();
    }, delay);
  }
}

/** The page's connection. */
export const live = new LiveClient();
