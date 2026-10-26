// The pure part of the live push (GET /v1/live, served by the Stats Durable Object, stats.ts):
// who is connected, what each connection subscribed to, and what each one is sent. The Durable
// Object accepts the connections with the WebSocket Hibernation API, so an open page never keeps
// it in memory; what the hub knows of a connection is also its attachment, and a hub built again
// after the object woke up is restored from them.
//
// Fan-out: a view (one route's answer) is serialized once and the same text is sent to every
// connection subscribed to its topic. It is sent when it changed (the answer without its
// `updatedAt`) or when the last one sent is LIVE_REFRESH_MS old, so a quiet vault still reads
// as fresh. A wallet notification goes to the connections subscribed to a wallet the
// transaction names (its owner, its integrator record or its USDC account, the Durable Object
// adding those a ticket's opening names for its later events).
//
// Bounds: LIVE_MAX_CONNECTIONS in all and LIVE_MAX_PER_IP from one address (`clientKey`: an
// IPv6 address counts by its /64, the block one subscriber is handed; the Worker rate-limits
// connection attempts by the same key); a connection subscribed to nothing for LIVE_BARE_MS is
// closed (`reap`, at the end of each alarm), so held sockets cannot keep the slots; per connection, ops of LIVE_MAX_OP_BYTES at most,
// LIVE_OPS_PER_MINUTE of them, LIVE_MAX_WALLETS wallets; a message of LIVE_MAX_MESSAGE_BYTES at
// most. Backpressure: the Workers WebSocket has no send buffer to read, so each connection gets
// a budget of LIVE_OUT_BYTES_PER_MINUTE (a bucket refilled over a minute). What does not fit
// waits, one message per topic and per wallet, the newest replacing an older one never sent,
// and goes out once the budget allows: a slow or flooded connection is never sent a backlog,
// only the latest state. A connection whose send throws is dropped.
import {
  LIVE_MAX_OP_BYTES,
  LIVE_MAX_WALLETS,
  LIVE_REFRESH_MS,
  LIVE_TOPICS,
  parseLiveOp,
  viewMessage,
  type LiveTopic,
  type LiveWalletMessage,
} from "../../web/src/lib/liveProtocol.ts";

export const LIVE_MAX_CONNECTIONS = 2_000;
export const LIVE_MAX_PER_IP = 8;
export const LIVE_OPS_PER_MINUTE = 120;
export const LIVE_OUT_BYTES_PER_MINUTE = 4 * 1024 * 1024;
export const LIVE_MAX_MESSAGE_BYTES = 512 * 1024;
/**
 * How long a connection may stay subscribed to nothing: the app subscribes as it opens and closes
 * its connection LINGER_MS (10 s) after its last subscription leaves (lib/live).
 */
export const LIVE_BARE_MS = 45_000;

/**
 * The key a connection's address counts under: an IPv4 address as it is, an IPv6 one by its /64
 * (the block a single subscriber is handed, any address of which it may use), lower case.
 */
export function clientKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const bare = ip.split("%")[0]!.toLowerCase();
  // an IPv4 address mapped into IPv6
  const mapped = /^(?:0{0,4}:){0,5}ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare.replace(/^::/, ""));
  if (mapped?.[1]) return mapped[1];
  const [head = "", tail] = bare.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return bare;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

export type HubLimits = {
  connections: number;
  perIp: number;
  opsPerMinute: number;
  outBytesPerMinute: number;
  messageBytes: number;
  refreshMs: number;
  bareMs: number;
};

export const LIVE_LIMITS: HubLimits = {
  connections: LIVE_MAX_CONNECTIONS,
  perIp: LIVE_MAX_PER_IP,
  opsPerMinute: LIVE_OPS_PER_MINUTE,
  outBytesPerMinute: LIVE_OUT_BYTES_PER_MINUTE,
  messageBytes: LIVE_MAX_MESSAGE_BYTES,
  refreshMs: LIVE_REFRESH_MS,
  bareMs: LIVE_BARE_MS,
};

/** What the hub needs of a WebSocket: the Workers one, or a test's. */
export interface HubSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
}

/** What a connection's attachment keeps: all the hub needs to restore it. */
export type LiveAttachment = {
  /** The address's key (`clientKey`). */
  ip: string;
  topics: LiveTopic[];
  wallets: { owner: string; keys: string[] }[];
  /** Since when (milliseconds) it is subscribed to nothing; null while it is subscribed. */
  bareSince: number | null;
};

/** A transaction just indexed, by the accounts a wallet's history finds it by. */
export type LiveTx = { signature: string; at: number | null; keys: Iterable<string> };

/** What a wallet's notification says: the transactions found for it, the newest's time. */
export type WalletMatch = { signatures: string[]; at: number | null };

/** What the Durable Object does after an op: nothing, or the new subscriptions' first answers. */
export type HubOp =
  { kind: "none" } | { kind: "subscribe"; topics: LiveTopic[]; wallets: string[] };

type Conn = {
  ip: string;
  topics: Set<LiveTopic>;
  wallets: Set<string>;
  bareSince: number | null;
  /** When its last ops were read (milliseconds), within the last minute. */
  ops: number[];
  tokens: number;
  refilledAt: number;
  /** Messages waiting for the budget, by slot (`view:<topic>`, `wallet:<owner>`). */
  pending: Map<string, string>;
};

const MINUTE_MS = 60_000;

/** The view without its `updatedAt`: what tells a changed answer from the same one built again. */
function contentOf(view: unknown): string {
  if (view && typeof view === "object" && !Array.isArray(view)) {
    const { updatedAt: _updatedAt, ...rest } = view as Record<string, unknown>;
    return JSON.stringify(rest);
  }
  return JSON.stringify(view);
}

const isTopic = (v: unknown): v is LiveTopic => LIVE_TOPICS.includes(v as LiveTopic);

export class LiveHub<S extends HubSocket> {
  private readonly conns = new Map<S, Conn>();
  private readonly perIp = new Map<string, number>();
  /** Each wallet subscribed: the accounts it is found by, and its connections. */
  private readonly owners = new Map<string, { keys: string[]; sockets: Set<S> }>();
  /** Each of those accounts: the wallets it finds. */
  private readonly keyOwners = new Map<string, Set<string>>();
  /** Each topic's last view sent: its content, its message, when (milliseconds). */
  private readonly last = new Map<LiveTopic, { content: string; message: string; at: number }>();

  constructor(
    private readonly limits: HubLimits = LIVE_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Open connections. */
  get size(): number {
    return this.conns.size;
  }

  /** Why a new connection from `ip` is refused; null when it is admitted. */
  admit(ip: string): string | null {
    if (this.conns.size >= this.limits.connections) return "too many connections, retry later";
    if ((this.perIp.get(clientKey(ip)) ?? 0) >= this.limits.perIp)
      return "too many connections from this address";
    return null;
  }

  /** A connection just accepted, subscribed to nothing yet. */
  add(socket: S, ip: string): void {
    this.track(socket, clientKey(ip), [], [], this.now());
    this.save(socket);
  }

  /** A connection accepted before the object woke up, from its attachment. */
  restore(socket: S, attachment: unknown): void {
    if (this.conns.has(socket)) return;
    const a = (attachment ?? {}) as Partial<LiveAttachment>;
    const topics = Array.isArray(a.topics) ? a.topics.filter(isTopic) : [];
    const wallets = Array.isArray(a.wallets)
      ? a.wallets
          .filter(
            (w): w is LiveAttachment["wallets"][number] =>
              !!w && typeof w.owner === "string" && Array.isArray(w.keys),
          )
          .slice(0, LIVE_MAX_WALLETS)
      : [];
    const bareSince =
      typeof a.bareSince === "number" && Number.isFinite(a.bareSince)
        ? a.bareSince
        : topics.length || wallets.length
          ? null
          : this.now();
    this.track(
      socket,
      clientKey(typeof a.ip === "string" ? a.ip : "unknown"),
      topics,
      wallets,
      bareSince,
    );
  }

  private track(
    socket: S,
    ip: string,
    topics: readonly LiveTopic[],
    wallets: LiveAttachment["wallets"],
    bareSince: number | null,
  ): void {
    this.conns.set(socket, {
      ip,
      topics: new Set(topics),
      wallets: new Set(),
      bareSince,
      ops: [],
      tokens: this.limits.outBytesPerMinute,
      refilledAt: this.now(),
      pending: new Map(),
    });
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    for (const w of wallets) this.index(socket, w.owner, w.keys);
  }

  /** A connection closed: forgets it and its subscriptions. */
  remove(socket: S): void {
    const c = this.conns.get(socket);
    if (!c) return;
    for (const owner of c.wallets) this.unindex(socket, owner);
    this.conns.delete(socket);
    const n = (this.perIp.get(c.ip) ?? 1) - 1;
    if (n > 0) this.perIp.set(c.ip, n);
    else this.perIp.delete(c.ip);
  }

  /** Closes a connection that broke a limit, saying why. */
  private refuse(socket: S, code: number, why: string): HubOp {
    try {
      socket.send(JSON.stringify({ type: "error", error: why }));
      socket.close(code, why);
    } catch {
      // closed already
    }
    this.remove(socket);
    return { kind: "none" };
  }

  /**
   * One message of a connection. Subscribing to a topic is answered by its last view (the
   * Durable Object builds one first when there is none, `hasView`); subscribing to a wallet
   * waits for its accounts (`subscribeWallet`). Returns what is left to the Durable Object.
   */
  handle(socket: S, message: string | ArrayBuffer): HubOp {
    const c = this.conns.get(socket);
    if (!c) return { kind: "none" };
    if (typeof message !== "string") return this.refuse(socket, 1003, "text messages only");
    if (message.length > LIVE_MAX_OP_BYTES) return this.refuse(socket, 1009, "message too large");
    const now = this.now();
    c.ops = c.ops.filter((t) => now - t < MINUTE_MS);
    if (c.ops.length >= this.limits.opsPerMinute)
      return this.refuse(socket, 1008, "too many messages");
    c.ops.push(now);
    const op = parseLiveOp(message);
    if (!op) return this.refuse(socket, 1008, "unreadable message");
    if (op.op === "unsubscribe") {
      for (const t of op.topics) {
        c.topics.delete(t);
        c.pending.delete(`view:${t}`);
      }
      for (const w of op.wallets) this.unindex(socket, w);
      this.save(socket);
      this.acknowledge(socket);
      return { kind: "none" };
    }
    const topics = op.topics.filter((t) => !c.topics.has(t));
    for (const t of topics) c.topics.add(t);
    const wallets = op.wallets.filter((w) => !c.wallets.has(w));
    if (c.wallets.size + wallets.length > LIVE_MAX_WALLETS)
      return this.refuse(socket, 1008, `${LIVE_MAX_WALLETS} wallets at most`);
    this.save(socket);
    if (!wallets.length) this.acknowledge(socket);
    return topics.length || wallets.length
      ? { kind: "subscribe", topics, wallets }
      : { kind: "none" };
  }

  /** Subscribes a connection to a wallet, found by `keys` (its own address among them). */
  subscribeWallet(socket: S, owner: string, keys: readonly string[]): void {
    const c = this.conns.get(socket);
    if (!c || c.wallets.has(owner) || c.wallets.size >= LIVE_MAX_WALLETS) return;
    this.index(socket, owner, [...new Set([owner, ...keys])]);
    this.save(socket);
    this.acknowledge(socket);
  }

  private index(socket: S, owner: string, keys: readonly string[]): void {
    const c = this.conns.get(socket);
    if (!c) return;
    c.wallets.add(owner);
    let o = this.owners.get(owner);
    if (!o) {
      o = { keys: [...keys], sockets: new Set() };
      this.owners.set(owner, o);
      for (const k of o.keys) {
        let set = this.keyOwners.get(k);
        if (!set) this.keyOwners.set(k, (set = new Set()));
        set.add(owner);
      }
    }
    o.sockets.add(socket);
  }

  private unindex(socket: S, owner: string): void {
    const c = this.conns.get(socket);
    c?.wallets.delete(owner);
    c?.pending.delete(`wallet:${owner}`);
    const o = this.owners.get(owner);
    if (!o) return;
    o.sockets.delete(socket);
    if (o.sockets.size) return;
    this.owners.delete(owner);
    for (const k of o.keys) {
      const set = this.keyOwners.get(k);
      set?.delete(owner);
      if (set && !set.size) this.keyOwners.delete(k);
    }
  }

  /** Tells a connection what it is subscribed to. */
  acknowledge(socket: S): void {
    const c = this.conns.get(socket);
    if (!c) return;
    this.deliver(
      socket,
      "subscribed",
      JSON.stringify({ type: "subscribed", topics: [...c.topics], wallets: [...c.wallets] }),
    );
  }

  private save(socket: S): void {
    const c = this.conns.get(socket);
    if (!c) return;
    // subscribed to nothing from now on, or since it last was
    c.bareSince = c.topics.size || c.wallets.size ? null : (c.bareSince ?? this.now());
    const attachment: LiveAttachment = {
      ip: c.ip,
      topics: [...c.topics],
      wallets: [...c.wallets].map((owner) => ({
        owner,
        keys: this.owners.get(owner)?.keys ?? [owner],
      })),
      bareSince: c.bareSince,
    };
    try {
      socket.serializeAttachment(attachment);
    } catch {
      // a closed socket: its close removes it
    }
  }

  /**
   * Closes the connections subscribed to nothing for LIVE_BARE_MS: the app's never stay so (it
   * closes its own 10 s after its last subscription leaves). Returns how many it closed.
   */
  reap(): number {
    const now = this.now();
    let n = 0;
    for (const [socket, c] of [...this.conns])
      if (c.bareSince !== null && now - c.bareSince >= this.limits.bareMs) {
        try {
          socket.close(1000, "nothing subscribed");
        } catch {
          // closed already
        }
        this.remove(socket);
        n++;
      }
    return n;
  }

  /** The topics some connection subscribed to. */
  wanted(): Set<LiveTopic> {
    const out = new Set<LiveTopic>();
    for (const c of this.conns.values()) for (const t of c.topics) out.add(t);
    return out;
  }

  /** Whether some connection subscribed to a wallet. */
  hasWallets(): boolean {
    return this.owners.size > 0;
  }

  /** Whether a view of `topic` was sent already, the one a new subscriber is sent. */
  hasView(topic: LiveTopic): boolean {
    return this.last.has(topic);
  }

  /**
   * Sends `view` (the answer of GET /v1/<topic>) to the connections subscribed to `topic`, when
   * it changed or the last one sent is `refreshMs` old. Returns the connections it went to, -1
   * when it is larger than a message may be.
   */
  publish(topic: LiveTopic, view: unknown): number {
    const content = contentOf(view);
    const prev = this.last.get(topic);
    const now = this.now();
    if (prev && prev.content === content && now - prev.at < this.limits.refreshMs) return 0;
    const message = viewMessage(topic, JSON.stringify(view), now / 1_000);
    if (message.length > this.limits.messageBytes) return -1;
    this.last.set(topic, { content, message, at: now });
    let n = 0;
    for (const [socket, c] of [...this.conns])
      if (c.topics.has(topic)) {
        this.deliver(socket, `view:${topic}`, message);
        n++;
      }
    return n;
  }

  /** Sends the last view of `topic` to one connection (a new subscriber); false when there is none. */
  sendView(socket: S, topic: LiveTopic): boolean {
    const last = this.last.get(topic);
    const c = this.conns.get(socket);
    if (!last || !c?.topics.has(topic)) return false;
    this.deliver(socket, `view:${topic}`, last.message);
    return true;
  }

  /** The subscribed wallets these transactions concern, each with what its notification says. */
  matchWallets(txs: readonly LiveTx[]): Map<string, WalletMatch> {
    const out = new Map<string, WalletMatch>();
    for (const tx of txs) {
      const owners = new Set<string>();
      for (const k of tx.keys) for (const o of this.keyOwners.get(k) ?? []) owners.add(o);
      for (const o of owners) {
        const m = out.get(o) ?? { signatures: [], at: null };
        if (!m.signatures.includes(tx.signature)) m.signatures.push(tx.signature);
        if (tx.at !== null && (m.at === null || tx.at > m.at)) m.at = tx.at;
        out.set(o, m);
      }
    }
    return out;
  }

  /** Sends each wallet's notification to its connections. */
  notifyWallets(matches: ReadonlyMap<string, WalletMatch>): void {
    for (const [owner, m] of matches) {
      const sockets = this.owners.get(owner)?.sockets;
      if (!sockets) continue;
      const message: LiveWalletMessage = {
        type: "wallet",
        wallet: owner,
        signatures: m.signatures.slice(-20),
        at: m.at,
      };
      const text = JSON.stringify(message);
      for (const socket of [...sockets]) this.deliver(socket, `wallet:${owner}`, text);
    }
  }

  /** Sends what waited for the budget, to every connection whose budget allows it now. */
  flush(): void {
    for (const [socket, c] of [...this.conns]) if (c.pending.size) this.drain(socket, c);
  }

  /** Puts a message in its slot (replacing one not sent yet) and sends what the budget allows. */
  private deliver(socket: S, slot: string, message: string): void {
    const c = this.conns.get(socket);
    if (!c) return;
    // the newest goes last: a slot replaced is sent in the order it was published
    c.pending.delete(slot);
    c.pending.set(slot, message);
    this.drain(socket, c);
  }

  private drain(socket: S, c: Conn): void {
    const now = this.now();
    const cap = this.limits.outBytesPerMinute;
    c.tokens = Math.min(cap, c.tokens + ((now - c.refilledAt) * cap) / MINUTE_MS);
    c.refilledAt = now;
    for (const [slot, message] of c.pending) {
      if (message.length > c.tokens) return;
      try {
        socket.send(message);
      } catch {
        try {
          socket.close(1011, "send failed");
        } catch {
          // closed already
        }
        this.remove(socket);
        return;
      }
      c.tokens -= message.length;
      c.pending.delete(slot);
    }
  }
}
