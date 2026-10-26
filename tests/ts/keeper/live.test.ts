// The keeper's live push (GET /v1/live, apps/keeper/src/liveHub.ts and the Stats Durable Object,
// stats.ts): the hub's fan-out, its subscriptions, its bounds (an IPv6 address counted by its
// /64, a connection subscribed to nothing closed) and its backpressure, a hub built again from
// the connections' attachments; then the Durable Object over SQLite in memory and a scripted
// RPC: a subscriber gets each topic's answer exactly as its route serves it, the transactions
// counted go out to the wallets they concern (through their tickets' openings too), the kept
// answer of those wallets dropped first, the subscriptions surviving hibernation in the
// attachments, the heartbeat answered by the runtime, the loop paced by what is subscribed and
// the answers built again only when what they show changed; and the route.
import { DatabaseSync } from "node:sqlite";
import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_BARE_MS,
  LIVE_LIMITS,
  LiveHub,
  clientKey,
  type HubLimits,
  type HubSocket,
} from "../../../apps/keeper/src/liveHub.ts";
import {
  LIVE_MAX_OP_BYTES,
  LIVE_MAX_WALLETS,
  parseLiveMessage,
  viewMessage,
  type LiveMessage,
} from "../../../apps/web/src/lib/liveProtocol.ts";
import { parseKeeperFeed, type KeeperFeed } from "../../../apps/web/src/lib/keeperViews.ts";
import { parseStats } from "../../../apps/web/src/lib/stats.ts";
import { parseKeeperWallet } from "../../../apps/web/src/lib/keeperWallet.ts";
import {
  A,
  NOW,
  USDC,
  WALLETS,
  eventTx,
  ev,
  sig,
  walletKeys,
  type HistoryTx,
} from "./walletFixtures.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

class FakeSocket implements HubSocket {
  sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;
  attachment: unknown = null;
  failing = false;
  send(m: string) {
    if (this.failing) throw new Error("gone");
    this.sent.push(m);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  serializeAttachment(v: unknown) {
    this.attachment = structuredClone(v);
  }
  deserializeAttachment() {
    return this.attachment;
  }
  messages(): LiveMessage[] {
    return this.sent.map((m) => parseLiveMessage(m)!);
  }
  views(topic: string) {
    return this.messages().filter((m) => m.type === "view" && m.topic === topic);
  }
}

const op = (o: unknown) => JSON.stringify(o);
const sub = (topics: string[], wallets: string[] = []) => op({ op: "subscribe", topics, wallets });
const view = (n: number, updatedAt = "2026-10-21T00:00:00.000Z") => ({ updatedAt, n, rows: [n] });

function hubWith(limits: Partial<HubLimits> = {}) {
  let t = 1_000_000;
  const hub = new LiveHub<FakeSocket>({ ...LIVE_LIMITS, ...limits }, () => t);
  return { hub, advance: (ms: number) => (t += ms) };
}

function connected(hub: LiveHub<FakeSocket>, ip = "1.1.1.1") {
  const s = new FakeSocket();
  hub.add(s, ip);
  return s;
}

describe("the live hub", () => {
  it("fans one answer out to every subscriber of its topic, serialized once", () => {
    const { hub } = hubWith();
    const [a, b, c] = [connected(hub), connected(hub), connected(hub)];
    expect(hub.handle(a, sub(["feed"]))).toEqual({
      kind: "subscribe",
      topics: ["feed"],
      wallets: [],
    });
    hub.handle(b, sub(["feed", "stats"]));
    hub.handle(c, sub(["stats"]));
    expect(hub.wanted()).toEqual(new Set(["feed", "stats"]));
    const v = view(1);
    expect(hub.publish("feed", v)).toBe(2);
    const expected = viewMessage("feed", JSON.stringify(v), 1_000);
    expect(a.sent.at(-1)).toBe(expected);
    expect(b.sent.at(-1)).toBe(expected);
    // made at the keeper's clock: the app weighs the answer's age by it
    expect(a.messages().at(-1)).toMatchObject({ type: "view", topic: "feed", at: 1_000 });
    expect(c.views("feed")).toEqual([]);
    // each got its acknowledgement first
    expect(a.messages()[0]).toEqual({ type: "subscribed", topics: ["feed"], wallets: [] });
    expect(b.messages()[0]).toEqual({ type: "subscribed", topics: ["feed", "stats"], wallets: [] });
  });

  it("sends an answer again when it changed, or once it is as old as the refresh", () => {
    const { hub, advance } = hubWith();
    const s = connected(hub);
    hub.handle(s, sub(["feed"]));
    expect(hub.publish("feed", view(1))).toBe(1);
    // built again, the same content: not sent
    advance(5_000);
    expect(hub.publish("feed", view(1, "2026-10-21T00:00:05.000Z"))).toBe(0);
    expect(hub.publish("feed", view(2, "2026-10-21T00:00:05.000Z"))).toBe(1);
    advance(LIVE_LIMITS.refreshMs);
    expect(hub.publish("feed", view(2, "2026-10-21T00:01:05.000Z"))).toBe(1);
    expect(s.views("feed").map((m) => (m as { data: { n: number } }).data.n)).toEqual([1, 2, 2]);
  });

  it("subscribes and unsubscribes, a new subscriber getting the last answer at once", () => {
    const { hub } = hubWith();
    const a = connected(hub);
    hub.handle(a, sub(["feed"]));
    hub.publish("feed", view(1));
    const b = connected(hub);
    const opB = hub.handle(b, sub(["feed", "apr"]));
    expect(opB).toEqual({ kind: "subscribe", topics: ["feed", "apr"], wallets: [] });
    expect(hub.hasView("feed")).toBe(true);
    expect(hub.hasView("apr")).toBe(false);
    expect(hub.sendView(b, "feed")).toBe(true);
    expect(hub.sendView(b, "apr")).toBe(false);
    expect(b.views("feed")).toHaveLength(1);
    // subscribing again to a topic it has: nothing new
    expect(hub.handle(b, sub(["feed"]))).toEqual({ kind: "none" });
    expect(hub.handle(a, op({ op: "unsubscribe", topics: ["feed"] }))).toEqual({ kind: "none" });
    expect(a.messages().at(-1)).toEqual({ type: "subscribed", topics: [], wallets: [] });
    expect(hub.publish("feed", view(2))).toBe(1);
    expect(a.views("feed")).toHaveLength(1);
    expect(b.views("feed")).toHaveLength(2);
    hub.remove(b);
    expect(hub.wanted()).toEqual(new Set());
    expect(hub.publish("feed", view(3))).toBe(0);
  });

  it("sends a wallet's notification to its subscribers, by any of its accounts", () => {
    const { hub } = hubWith();
    const [a, b] = [connected(hub), connected(hub)];
    const W = WALLETS[0];
    expect(hub.handle(a, sub([], [W]))).toEqual({ kind: "subscribe", topics: [], wallets: [W] });
    // no acknowledgement until its accounts are known
    expect(a.sent).toEqual([]);
    hub.subscribeWallet(a, W, [W, "Integrator", "UsdcAccount"]);
    expect(a.messages()).toEqual([{ type: "subscribed", topics: [], wallets: [W] }]);
    hub.handle(b, sub(["feed"]));
    expect(hub.hasWallets()).toBe(true);
    const matches = hub.matchWallets([
      { signature: "s1", at: 10, keys: ["Ticket", "Integrator", "Customer"] },
      { signature: "s2", at: 12, keys: ["Other"] },
      { signature: "s3", at: 11, keys: ["UsdcAccount"] },
    ]);
    expect(matches).toEqual(new Map([[W, { signatures: ["s1", "s3"], at: 11 }]]));
    hub.notifyWallets(matches);
    expect(a.messages().at(-1)).toEqual({
      type: "wallet",
      wallet: W,
      signatures: ["s1", "s3"],
      at: 11,
    });
    expect(b.messages().some((m) => m.type === "wallet")).toBe(false);
    hub.handle(a, op({ op: "unsubscribe", wallets: [W] }));
    expect(hub.hasWallets()).toBe(false);
    expect(hub.matchWallets([{ signature: "s4", at: 13, keys: [W] }]).size).toBe(0);
  });

  it("is restored from the connections' attachments after the object woke up", () => {
    const { hub } = hubWith();
    const W = WALLETS[1];
    const [a, b] = [connected(hub, "9.9.9.9"), connected(hub, "9.9.9.9")];
    hub.handle(a, sub(["stats", "feed"]));
    hub.handle(b, sub([], [W]));
    hub.subscribeWallet(b, W, [W, "Integrator"]);
    // hibernation: the hub is gone, the sockets and their attachments stay
    const again = new LiveHub<FakeSocket>({ ...LIVE_LIMITS, perIp: 2 });
    for (const s of [a, b]) again.restore(s, s.deserializeAttachment());
    expect(again.size).toBe(2);
    expect(again.wanted()).toEqual(new Set(["stats", "feed"]));
    expect(again.admit("9.9.9.9")).not.toBeNull();
    expect(again.publish("stats", view(1))).toBe(1);
    expect(a.views("stats")).toHaveLength(1);
    expect([
      ...again.matchWallets([{ signature: "s", at: 1, keys: ["Integrator"] }]).keys(),
    ]).toEqual([W]);
    // an attachment it cannot read: a connection subscribed to nothing
    const c = new FakeSocket();
    again.restore(c, { topics: ["nope"], wallets: [{ owner: 3 }] });
    expect(again.size).toBe(3);
  });

  it("closes a connection subscribed to nothing for LIVE_BARE_MS, its time kept in its attachment", () => {
    let t = 1_000_000;
    const clock = () => t;
    const hub = new LiveHub<FakeSocket>(LIVE_LIMITS, clock);
    const [bare, held, left] = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
    for (const s of [bare, held, left]) hub.add(s, "7.7.7.7");
    hub.handle(held, sub(["feed"]));
    hub.handle(left, sub(["feed"]));
    t += LIVE_BARE_MS - 15_000;
    // the page left its last view: subscribed to nothing from now on
    hub.handle(left, op({ op: "unsubscribe", topics: ["feed"] }));
    t += 15_000;
    expect(hub.reap()).toBe(1);
    expect(bare.closed).toEqual({ code: 1000, reason: "nothing subscribed" });
    expect(hub.size).toBe(2);
    expect(hub.admit("7.7.7.7")).toBeNull();
    // hibernation: the hub built again reaps the other on time, from its attachment
    const woken = new LiveHub<FakeSocket>(LIVE_LIMITS, clock);
    for (const s of [held, left]) woken.restore(s, s.deserializeAttachment());
    t += LIVE_BARE_MS - 15_001;
    expect(woken.reap()).toBe(0);
    t += 1;
    expect(woken.reap()).toBe(1);
    expect(left.closed?.reason).toBe("nothing subscribed");
    expect(held.closed).toBeNull();
    // a subscribed connection is never reaped, however long it stays quiet
    t += 24 * 3_600_000;
    expect(woken.reap()).toBe(0);
    expect(woken.wanted()).toEqual(new Set(["feed"]));
  });

  it("counts an IPv6 address by its /64, the block one subscriber is handed", () => {
    expect(clientKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8::7")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("unknown")).toBe("unknown");
    const { hub } = hubWith({ perIp: 2 });
    const a = connected(hub, "2001:db8:1:2::1");
    connected(hub, "2001:db8:1:2:ffff:1:2:3");
    expect(hub.admit("2001:db8:1:2:9::77")).toMatch(/this address/);
    expect(hub.admit("2001:db8:1:3::1")).toBeNull();
    expect((a.deserializeAttachment() as { ip: string }).ip).toBe("2001:db8:1:2::/64");
  });

  it("bounds the connections, in all and from one address", () => {
    const { hub } = hubWith({ connections: 3, perIp: 2 });
    connected(hub, "a");
    connected(hub, "a");
    expect(hub.admit("a")).toMatch(/this address/);
    expect(hub.admit("b")).toBeNull();
    const last = connected(hub, "b");
    expect(hub.admit("c")).toMatch(/too many connections/);
    hub.remove(last);
    expect(hub.admit("c")).toBeNull();
  });

  it("closes a connection that sends too much, too often, too many wallets or something unreadable", () => {
    const { hub, advance } = hubWith({ opsPerMinute: 3 });
    const big = connected(hub);
    hub.handle(big, "x".repeat(LIVE_MAX_OP_BYTES + 1));
    expect(big.closed?.code).toBe(1009);
    const binary = connected(hub);
    hub.handle(binary, new ArrayBuffer(4));
    expect(binary.closed?.code).toBe(1003);
    const junk = connected(hub);
    hub.handle(junk, op({ op: "subscribe", topics: ["secrets"] }));
    expect(junk.closed?.code).toBe(1008);
    expect(junk.messages().at(-1)).toEqual({ type: "error", error: "unreadable message" });
    const chatty = connected(hub);
    for (let i = 0; i < 3; i++) hub.handle(chatty, sub(["feed"]));
    expect(chatty.closed).toBeNull();
    hub.handle(chatty, sub(["feed"]));
    expect(chatty.closed?.code).toBe(1008);
    // a minute later the budget of ops is whole again
    const calm = connected(hub);
    for (let i = 0; i < 3; i++) hub.handle(calm, sub(["feed"]));
    advance(60_000);
    hub.handle(calm, sub(["stats"]));
    expect(calm.closed).toBeNull();
    const greedy = connected(hub);
    for (let i = 0; i < LIVE_MAX_WALLETS; i++) {
      hub.handle(greedy, sub([], [A(`w${i}`)]));
      hub.subscribeWallet(greedy, A(`w${i}`), []);
    }
    hub.handle(greedy, sub([], [A("one-too-many")]));
    expect(greedy.closed?.code).toBe(1008);
    // every closed connection is forgotten
    expect(hub.size).toBe(1);
  });

  it("keeps only the newest answer per topic for a connection over its budget, sent once it refills", () => {
    const { hub, advance } = hubWith({ outBytesPerMinute: 6_000 });
    const slow = connected(hub);
    const other = connected(hub);
    hub.handle(slow, sub(["feed", "stats"]));
    hub.handle(other, sub(["feed"]));
    const big = (n: number) => ({ n, pad: "x".repeat(2_500) });
    hub.publish("feed", big(1));
    hub.publish("feed", big(2));
    // the third does not fit: it waits, and the fourth replaces it
    hub.publish("feed", big(3));
    hub.publish("feed", big(4));
    hub.publish("stats", view(1));
    const ns = () => slow.views("feed").map((m) => (m as { data: { n: number } }).data.n);
    expect(ns()).toEqual([1, 2]);
    expect(slow.views("stats")).toHaveLength(0);
    advance(30_000);
    hub.flush();
    // the newest feed, then the stats, in the order they were published
    expect(ns()).toEqual([1, 2, 4]);
    expect(slow.views("stats")).toHaveLength(1);
    expect(other.views("feed")).toHaveLength(3);
    // an answer larger than a message may be is sent to no one
    const { hub: h2 } = hubWith({ messageBytes: 1_000 });
    const s = connected(h2);
    h2.handle(s, sub(["vault"]));
    expect(h2.publish("vault", big(5))).toBe(-1);
    expect(s.views("vault")).toHaveLength(0);
  });

  it("drops a connection whose send fails", () => {
    const { hub } = hubWith();
    const [a, b] = [connected(hub), connected(hub)];
    hub.handle(a, sub(["feed"]));
    hub.handle(b, sub(["feed"]));
    a.failing = true;
    hub.publish("feed", view(1));
    expect(a.closed?.code).toBe(1011);
    expect(hub.size).toBe(1);
    expect(b.views("feed")).toHaveLength(1);
  });
});

// --- the Durable Object -------------------------------------------------------------------

type LiveStats = {
  feed(): Promise<unknown>;
  stats(): Promise<unknown>;
  wallet(owner: Address): Promise<unknown>;
  alarm(): Promise<void>;
  acceptLive(ws: FakeSocket, ip: string): void;
  webSocketMessage(ws: FakeSocket, m: string): Promise<void>;
  webSocketClose(ws: FakeSocket, code: number, reason: string): Promise<void>;
  tick(): Promise<boolean>;
  wallets: Map<string, unknown>;
  hub: unknown;
};
const STATS_MODULE = "../../../apps/keeper/src/stats.ts";
const { Stats } = (await import(STATS_MODULE)) as {
  Stats: new (ctx: unknown, env: unknown) => LiveStats;
};

function liveState() {
  const db = new DatabaseSync(":memory:");
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    storage: {
      sql: {
        exec: (q: string, ...b: (string | number | null)[]) => {
          const rows = db.prepare(q).all(...b);
          return { toArray: () => rows, one: () => rows[0] };
        },
      },
      transactionSync: <T>(fn: () => T) => fn(),
      getAlarm: async () => null,
      setAlarm: async (t: number) => void alarms.push(t),
    },
    getWebSockets: () => sockets.filter((s) => !s.closed),
    acceptWebSocket: (ws: FakeSocket) => sockets.push(ws),
    autoResponse: null as unknown,
    setWebSocketAutoResponse(pair: unknown) {
      this.autoResponse = pair;
    },
  };
}
const alarms: number[] = [];

function statsOver(h: HistoryTx[]) {
  const rpc = {
    getSignaturesForAddress: (_p: unknown, o: { until?: string; before?: string }) => ({
      send: async () => {
        let list = [...h].reverse();
        if (o.before !== undefined)
          list = list.slice(list.findIndex((x) => x.signature === o.before) + 1);
        if (o.until !== undefined)
          list = list.slice(
            0,
            list.findIndex((x) => x.signature === o.until),
          );
        return list.map((x) => ({ signature: x.signature, err: null, blockTime: BigInt(x.at) }));
      },
    }),
    getTransaction: (signature: string) => ({
      send: async () => {
        const x = h.find((y) => y.signature === signature)!;
        return { ...x.tx, blockTime: BigInt(x.at), version: 1 };
      },
    }),
    getMultipleAccounts: (list: string[]) => ({
      send: async () => ({ value: list.map(() => null) }),
    }),
  };
  const state = liveState();
  const stats = new Stats(state, { RPC_URL: "http://localhost:0" });
  (stats as unknown as { rpc: unknown }).rpc = rpc;
  return { stats, state };
}

describe("the live push of the Stats Durable Object", () => {
  afterEach(() => vi.useRealTimers());

  it("pushes each topic as its route serves it, and the wallets their new transactions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1_000);
    const W = WALLETS[0];
    const keys = await walletKeys(W);
    const ticket = A("live-ticket");
    const other = A("other-ticket");
    // the wallet's app opens a ticket for a customer; another app one for someone else
    const h: HistoryTx[] = [
      {
        signature: sig(1),
        at: NOW - 60,
        tx: eventTx(ev.opened(ticket, keys.integrator, A("customer"), USDC, 20n * USDC)),
      },
      {
        signature: sig(2),
        at: NOW - 50,
        tx: eventTx(ev.opened(other, A("OtherApp"), A("someone"), USDC, 20n * USDC)),
      },
    ];
    const { stats, state } = statsOver(h);
    while (await stats.tick());
    // no connection yet: what was counted so far concerns no subscriber
    await stats.alarm();

    const ws = new FakeSocket();
    stats.acceptLive(ws, "1.2.3.4");
    const quiet = new FakeSocket();
    stats.acceptLive(quiet, "1.2.3.4");
    expect(state.sockets).toEqual([ws, quiet]);
    await stats.webSocketMessage(ws, sub(["feed", "stats"], [W]));
    await stats.webSocketMessage(quiet, sub(["stats"]));
    expect(ws.messages().find((m) => m.type === "subscribed")).toEqual({
      type: "subscribed",
      topics: ["feed", "stats"],
      wallets: [W],
    });
    // the very answers the routes serve, read by the app the same way
    const feedPushed = ws.views("feed")[0] as { data: unknown };
    const feedServed = JSON.parse(JSON.stringify(await stats.feed()));
    expect(feedPushed.data).toEqual(feedServed);
    expect(parseKeeperFeed(feedPushed.data)).toEqual(parseKeeperFeed(feedServed));
    const statsPushed = ws.views("stats")[0] as { data: unknown };
    expect(parseStats(statsPushed.data)).toEqual(
      parseStats(JSON.parse(JSON.stringify(await stats.stats()))),
    );
    expect(quiet.views("stats")).toHaveLength(1);
    expect(quiet.views("feed")).toHaveLength(0);

    // the wallet's answer kept, then its ticket ends and an unrelated one too
    await stats.wallet(W);
    expect(stats.wallets.has(W)).toBe(true);
    h.push(
      {
        signature: sig(3),
        at: NOW - 5,
        tx: eventTx(ev.settled(ticket, keys.integrator, 0n, false)),
      },
      {
        signature: sig(4),
        at: NOW - 4,
        tx: eventTx(ev.settled(other, A("OtherApp"), 0n, false)),
      },
    );
    vi.setSystemTime((NOW + 10) * 1_000);
    const before = ws.sent.length;
    await stats.alarm();
    const after = ws.messages().slice(before);
    // found through the ticket's opening, which names the wallet's integrator record
    expect(after.filter((m) => m.type === "wallet")).toEqual([
      { type: "wallet", wallet: W, signatures: [sig(3)], at: NOW - 5 },
    ]);
    expect(stats.wallets.has(W)).toBe(false);
    const k = parseKeeperWallet(JSON.parse(JSON.stringify(await stats.wallet(W))))!;
    expect(k.tickets.rows.find((r) => r.ticket === ticket)?.end).not.toBeNull();
    // the feed changed: pushed again, with the ticket's end
    const feeds = after.filter((m) => m.type === "view" && m.topic === "feed") as {
      data: unknown;
    }[];
    expect(feeds).toHaveLength(1);
    const feed = parseKeeperFeed(feeds[0]!.data) as KeeperFeed;
    expect(feed.rows.find((r) => r.ticket === ticket)?.end?.signature).toBe(sig(3));
    expect(feed).toEqual(parseKeeperFeed(JSON.parse(JSON.stringify(await stats.feed()))));
    // nothing new: nothing sent
    const settled = ws.sent.length;
    vi.setSystemTime((NOW + 20) * 1_000);
    await stats.alarm();
    expect(
      ws
        .messages()
        .slice(settled)
        .filter((m) => m.type !== "subscribed"),
    ).toEqual([]);

    // a closed connection is forgotten
    await stats.webSocketClose(ws, 1006, "");
    expect(ws.closed?.code).toBe(1000);
    await stats.webSocketMessage(ws, sub(["vault"]));
    expect(ws.views("vault")).toHaveLength(0);
  });

  it("notifies every player of a full round settled in one transaction, by their openings", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1_000);
    // a round batch as large as the program settles in one transaction (MAX_ROUND_BATCH), of 32
    // players under two apps: 32 tickets, 2 integrator records and 32 beneficiaries in all
    const BATCH = 32;
    const players = Array.from({ length: BATCH }, (_, i) => A(`round-player-${i}`));
    const keys = await Promise.all(players.map((p) => walletKeys(p)));
    const tickets = players.map((_, i) => A(`round-ticket-${i}`));
    const apps = [A("RoundAppOne"), A("RoundAppTwo")];
    const h: HistoryTx[] = players.map((_, i) => ({
      signature: sig(100 + i),
      at: NOW - 60 + i,
      tx: eventTx(
        ev.joined(tickets[i]!, apps[i % 2]!, keys[i]!.usdcAccount, A("Funder"), 100_000n),
      ),
    }));
    const { stats } = statsOver(h);
    while (await stats.tick());
    await stats.alarm();

    // each player watches their own wallet, one page each
    const pages = players.map((p, i) => {
      const ws = new FakeSocket();
      stats.acceptLive(ws, `10.0.0.${i}`);
      return { ws, owner: p };
    });
    for (const { ws, owner } of pages) await stats.webSocketMessage(ws, sub([], [owner]));

    // one transaction settles the whole round: its events name only the tickets
    h.push({
      signature: sig(200),
      at: NOW - 5,
      tx: eventTx(...tickets.map((t, i) => ev.roundSettled(t, apps[i % 2]!, 0n, false))),
    });
    vi.setSystemTime((NOW + 10) * 1_000);
    const before = pages.map(({ ws }) => ws.sent.length);
    await stats.alarm();
    pages.forEach(({ ws, owner }, i) => {
      expect(
        ws
          .messages()
          .slice(before[i])
          .filter((m) => m.type === "wallet"),
      ).toEqual([{ type: "wallet", wallet: owner, signatures: [sig(200)], at: NOW - 5 }]);
    });
  });

  it("keeps a wallet's subscription across hibernation, in the connection's attachment", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1_000);
    const W = WALLETS[0];
    const keys = await walletKeys(W);
    const ticket = A("hibernated-ticket");
    const h: HistoryTx[] = [
      {
        signature: sig(300),
        at: NOW - 60,
        tx: eventTx(ev.opened(ticket, keys.integrator, A("customer"), USDC, 20n * USDC)),
      },
    ];
    const { stats, state } = statsOver(h);
    while (await stats.tick());
    const ws = new FakeSocket();
    stats.acceptLive(ws, "1.2.3.4");
    await stats.webSocketMessage(ws, sub(["stats"], [W]));
    // hibernation: a new object over the same storage and sockets, then the ticket ends
    const woken = new Stats(state, { RPC_URL: "http://localhost:0" });
    (woken as unknown as { rpc: unknown }).rpc = (stats as unknown as { rpc: unknown }).rpc;
    h.push({
      signature: sig(301),
      at: NOW - 5,
      tx: eventTx(ev.settled(ticket, keys.integrator, 0n, false)),
    });
    vi.setSystemTime((NOW + 10) * 1_000);
    const before = ws.sent.length;
    await woken.alarm();
    expect(
      ws
        .messages()
        .slice(before)
        .filter((m) => m.type === "wallet"),
    ).toEqual([{ type: "wallet", wallet: W, signatures: [sig(301)], at: NOW - 5 }]);
  });

  it("answers the heartbeat by the runtime, set up on every wake-up before any connection", () => {
    const Pair = class {
      constructor(
        readonly request: string,
        readonly response: string,
      ) {}
    };
    const g = globalThis as { WebSocketRequestResponsePair?: unknown };
    g.WebSocketRequestResponsePair = Pair;
    try {
      const state = liveState();
      new Stats(state, { RPC_URL: "http://localhost:0" });
      expect(state.autoResponse).toEqual(new Pair("ping", "pong"));
    } finally {
      delete g.WebSocketRequestResponsePair;
    }
  });

  it("closes the connections subscribed to nothing, and paces its loop by what is subscribed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1_000);
    const { stats } = statsOver([]);
    while (await stats.tick());
    const bare = new FakeSocket();
    stats.acceptLive(bare, "1.2.3.4");
    const page = new FakeSocket();
    stats.acceptLive(page, "1.2.3.5");
    await stats.webSocketMessage(page, sub(["stats", "vault"]));
    // open connections alone do not make the loop follow the program faster
    alarms.length = 0;
    await stats.alarm();
    expect(alarms.at(-1)).toBe(NOW * 1_000 + 60_000);
    vi.setSystemTime(NOW * 1_000 + LIVE_BARE_MS);
    await stats.alarm();
    expect(bare.closed?.reason).toBe("nothing subscribed");
    expect(page.closed).toBeNull();
    // the feed, or a wallet, subscribed: every 20 s
    await stats.webSocketMessage(page, sub(["feed"]));
    await stats.alarm();
    expect(alarms.at(-1)).toBe(NOW * 1_000 + LIVE_BARE_MS + 20_000);
  });

  it("builds the feed again for the push only when a transaction changed it, or once a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let t = NOW * 1_000;
    vi.setSystemTime(t);
    const h: HistoryTx[] = [
      {
        signature: sig(400),
        at: NOW - 60,
        tx: eventTx(ev.opened(A("feed-ticket"), A("SomeApp"), A("x"), USDC, 2n * USDC)),
      },
    ];
    const { stats } = statsOver(h);
    while (await stats.tick());
    const o = stats as unknown as { buildFeed(): Promise<unknown> };
    const build = o.buildFeed.bind(stats);
    let builds = 0;
    o.buildFeed = () => {
      builds++;
      return build();
    };
    // subscribed a moment after the transaction was recorded
    t += 1;
    vi.setSystemTime(t);
    const ws = new FakeSocket();
    stats.acceptLive(ws, "1.2.3.4");
    await stats.webSocketMessage(ws, sub(["feed"]));
    expect(builds).toBe(1);
    // the alarms of a quiet minute: the kept answer, built once
    for (let i = 0; i < 5; i++) {
      t += 10_000;
      vi.setSystemTime(t);
      await stats.alarm();
    }
    expect(builds).toBe(1);
    t += 10_000;
    vi.setSystemTime(t);
    await stats.alarm();
    expect(builds).toBe(2);
    // a ticket counted: built again with this alarm's push
    h.push({
      signature: sig(401),
      at: NOW - 5,
      tx: eventTx(ev.settled(A("feed-ticket"), A("SomeApp"), 0n, false)),
    });
    t += 10_000;
    vi.setSystemTime(t);
    const before = ws.views("feed").length;
    await stats.alarm();
    expect(builds).toBe(3);
    expect(ws.views("feed").length).toBe(before + 1);
  });

  it("serves a hub built again from the connections it holds after a wake-up", async () => {
    const { stats, state } = statsOver([]);
    const ws = new FakeSocket();
    stats.acceptLive(ws, "1.2.3.4");
    await stats.webSocketMessage(ws, sub(["stats"]));
    // hibernation: a new object over the same storage and sockets
    const woken = new Stats(state, { RPC_URL: "http://localhost:0" });
    await woken.alarm();
    expect(ws.views("stats").length).toBeGreaterThanOrEqual(1);
    const n = ws.sent.length;
    await woken.webSocketMessage(ws, sub(["feed"]));
    expect(ws.sent.length).toBeGreaterThan(n);
  });
});

describe("GET /v1/live", () => {
  const INDEX_MODULE = "../../../apps/keeper/src/index.ts";
  const env = (success: boolean, seen: Request[]) => ({
    STATS: {
      idFromName: () => "stats",
      get: () => ({
        fetch: async (r: Request) => {
          seen.push(r);
          return new Response("upgraded");
        },
      }),
    },
    RATE_LIMITER: { limit: async () => ({ success }) },
  });
  it("limits the attempts of an IPv6 address by its /64", async () => {
    const worker = (
      (await import(INDEX_MODULE)) as {
        default: { fetch(request: Request, env: unknown): Promise<Response> };
      }
    ).default;
    const keys: string[] = [];
    const e = {
      ...env(true, []),
      RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: true };
        },
      },
    };
    for (const ip of ["2001:db8:5:6::1", "2001:db8:5:6:abcd::2"])
      await worker.fetch(
        new Request("https://api.fade.finance/v1/live", {
          headers: { Upgrade: "websocket", "CF-Connecting-IP": ip },
        }),
        e,
      );
    expect(keys).toEqual(["live:2001:db8:5:6::/64", "live:2001:db8:5:6::/64"]);
  });

  it("hands an upgrade to the Stats object, refuses anything else, and limits attempts per IP", async () => {
    const worker = (
      (await import(INDEX_MODULE)) as {
        default: { fetch(request: Request, env: unknown): Promise<Response> };
      }
    ).default;
    const seen: Request[] = [];
    const upgrade = { headers: { Upgrade: "websocket", "CF-Connecting-IP": "5.6.7.8" } };
    const ok = await worker.fetch(
      new Request("https://api.fade.finance/v1/live", upgrade),
      env(true, seen),
    );
    expect(await ok.text()).toBe("upgraded");
    expect(seen[0]?.headers.get("CF-Connecting-IP")).toBe("5.6.7.8");
    const plain = await worker.fetch(
      new Request("https://api.fade.finance/v1/live"),
      env(true, seen),
    );
    expect(plain.status).toBe(426);
    const limited = await worker.fetch(
      new Request("https://api.fade.finance/v1/live", upgrade),
      env(false, seen),
    );
    expect(limited.status).toBe(429);
    expect(seen).toHaveLength(1);
  });
});
