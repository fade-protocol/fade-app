// The app's side of the keeper's live push (GET /v1/live, lib/live), against a local stub of the
// keeper (wsStub.ts): a topic's answer pushed is read as the route's own answer; a topic is live
// only while the connection is open and its answer keeps coming, so the page polls the route
// again the moment the push is refused, drops, goes silent or goes quiet; and a lost connection
// is opened again with a backoff, its subscriptions sent again. A tab hidden long enough closes
// its connection and opens it again when shown; and a wallet's history is polled less often only
// while the keeper is demonstrably indexing it.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { aprTicketOf, aprView, type AprView } from "../../../apps/keeper/src/aprIndex.ts";
import { viewMessage } from "../../../apps/web/src/lib/liveProtocol.ts";
import type { LiveClient, LiveOptions, Visibility } from "../../../apps/web/src/lib/live.ts";
import { USDC } from "./fixtures.ts";
import { startStub, until, type StubConn } from "./wsStub.ts";

const NOW = 1_800_000_000;
const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

const answer = (): AprView =>
  aprView({
    tickets: Array.from({ length: 200 }, (_, i) =>
      aprTicketOf(
        {
          openedAt: NOW - i * 1_200,
          price: USDC,
          direct: { marginBps: 300n + BigInt(i % 50), appShareBps: 0n },
          beacon: null,
          refunded: false,
        },
        new Map(),
      ),
    ),
    strikes: [{ t: NOW - 50 * 86_400, assets: 1_000n * USDC }],
    totalAssets: 2_000n * USDC,
    protocolShareBps: 20n,
    now: NOW,
    coveredFrom: 0,
    syncing: false,
  });

let refuse: number | null = null;
let answerPings = true;
let onConnection: (c: StubConn) => void = () => {};
let stub: Awaited<ReturnType<typeof startStub>>;
let mod: typeof import("../../../apps/web/src/lib/live.ts");
let vaultApr: typeof import("../../../apps/web/src/lib/vaultApr.ts");
const clients: LiveClient[] = [];

beforeAll(async () => {
  stub = await startStub({
    refuse: () => refuse,
    answerPings: () => answerPings,
    onConnection: (c) => onConnection(c),
    http: (req, res) => {
      if (req.url !== "/v1/apr") return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer()));
    },
  });
  process.env.VITE_API_URL = stub.url;
  vi.resetModules();
  mod = await import("../../../apps/web/src/lib/live.ts");
  vaultApr = await import("../../../apps/web/src/lib/vaultApr.ts");
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  refuse = null;
  answerPings = true;
  onConnection = () => {};
});
afterAll(() => stub.stop());

const client = (o: LiveOptions = {}) => {
  const c = new mod.LiveClient({ backoffMinMs: 30, backoffMaxMs: 120, lingerMs: 50, ...o });
  clients.push(c);
  return c;
};
/** Answers each subscription to `apr` with the keeper's answer, as the keeper does. */
const servingApr = (c: StubConn) => {
  const sent = c.received.length;
  void until(() => c.received.length > sent).then(() => {
    if (c.received.some((m) => m.includes('"apr"')))
      c.send(viewMessage("apr", JSON.stringify(answer()), NOW));
  });
};

describe("the keeper's push, read by the app", () => {
  it("connects on its host, and reads a pushed answer exactly as the route's", async () => {
    expect(mod.LIVE_URL).toBe(`${stub.url.replace("http", "ws")}/v1/live`);
    onConnection = servingApr;
    const c = client();
    const pushed: unknown[] = [];
    let changes = 0;
    c.watch(() => changes++);
    c.topic("apr", (d) => pushed.push(d));
    expect(c.isLive("apr")).toBe(false);
    await until(() => pushed.length === 1);
    expect(c.isLive("apr")).toBe(true);
    expect(changes).toBe(1);
    const conn = stub.conns.at(-1)!;
    expect(JSON.parse(conn.received[0]!)).toEqual({
      op: "subscribe",
      topics: ["apr"],
      wallets: [],
    });
    // the same answer as GET /v1/apr serves, read the same way
    const viaPush = vaultApr.acceptVaultApr(pushed[0]);
    const viaRoute = await vaultApr.fetchVaultApr();
    expect(viaPush).not.toBeNull();
    expect(viaPush).toEqual(viaRoute);
  });

  it("is not live while the push is refused, and keeps trying with a growing backoff", async () => {
    refuse = 429;
    const before = stub.upgrades();
    const c = client();
    c.topic("apr", () => {});
    await until(() => stub.upgrades() - before >= 3, 5_000);
    expect(c.isLive("apr")).toBe(false);
    // the page polls the route meanwhile: it answers
    expect((await vaultApr.fetchVaultApr()).now.tickets).toBe(answer().now.tickets);
    refuse = null;
    onConnection = servingApr;
    await until(() => c.isLive("apr"), 5_000);
  });

  it("stops being live the moment the connection drops, then opens it again with its subscriptions", async () => {
    onConnection = servingApr;
    const c = client();
    const states: boolean[] = [];
    c.watch(() => states.push(c.isLive("apr")));
    c.topic("apr", () => {});
    c.wallet(WALLET, () => {});
    await until(() => c.isLive("apr"));
    const first = stub.conns.at(-1)!;
    first.drop();
    await until(() => !c.isLive("apr"));
    expect(states.slice(0, 2)).toEqual([true, false]);
    await until(() => stub.conns.at(-1) !== first && c.isLive("apr"));
    const again = stub.conns.at(-1)!;
    expect(JSON.parse(again.received[0]!)).toEqual({
      op: "subscribe",
      topics: ["apr"],
      wallets: [WALLET],
    });
  });

  it("closes a connection gone silent (its pings unanswered) and opens another", async () => {
    onConnection = servingApr;
    const c = client({ heartbeatMs: 20, silenceMs: 80 });
    c.topic("apr", () => {});
    await until(() => c.isLive("apr"));
    const first = stub.conns.at(-1)!;
    await until(() => first.received.includes("ping"));
    answerPings = false;
    await until(() => !c.isLive("apr"));
    answerPings = true;
    await until(() => stub.conns.at(-1) !== first && c.isLive("apr"));
  });

  it("stops being live for a topic whose answer stops coming, the connection still open", async () => {
    onConnection = servingApr;
    const c = client({ heartbeatMs: 20, topicSilenceMs: 60 });
    c.topic("apr", () => {});
    await until(() => c.isLive("apr"));
    const conn = stub.conns.at(-1)!;
    await until(() => !c.isLive("apr"));
    expect(conn.closed).toBe(false);
    // the next answer makes it live again
    conn.send(viewMessage("apr", JSON.stringify(answer()), NOW));
    await until(() => c.isLive("apr"));
  });

  it("is live for a wallet once the keeper confirms it, and passes its notifications on", async () => {
    let conn: StubConn | null = null;
    onConnection = (x) => (conn = x);
    const c = client();
    const got: unknown[] = [];
    c.wallet(WALLET, (m) => got.push(m));
    await until(() => conn !== null && conn.received.length > 0);
    expect(c.walletLive(WALLET)).toBe(false);
    conn!.send(JSON.stringify({ type: "subscribed", topics: [], wallets: [WALLET] }));
    await until(() => c.walletLive(WALLET));
    const note = { type: "wallet", wallet: WALLET, signatures: ["sig"], at: NOW };
    conn!.send(JSON.stringify(note));
    // an unreadable message changes nothing
    conn!.send("{");
    await until(() => got.length === 1);
    expect(got[0]).toEqual(note);
  });

  it("unsubscribes, then closes the connection once nothing subscribes", async () => {
    onConnection = servingApr;
    const c = client();
    const off = c.topic("apr", () => {});
    await until(() => c.isLive("apr"));
    const conn = stub.conns.at(-1)!;
    off();
    expect(c.isLive("apr")).toBe(false);
    await until(() => conn.received.length >= 2);
    expect(JSON.parse(conn.received.at(-1)!)).toEqual({
      op: "unsubscribe",
      topics: ["apr"],
      wallets: [],
    });
    await until(() => conn.closed);
  });

  it("sends one op for the views a page mounts or leaves together", async () => {
    onConnection = servingApr;
    const c = client();
    c.topic("apr", () => {});
    await until(() => c.isLive("apr"));
    const conn = stub.conns.at(-1)!;
    const n = conn.received.filter((m) => m !== "ping").length;
    const offs = [
      c.topic("feed", () => {}),
      c.topic("stats", () => {}),
      c.wallet(WALLET, () => {}),
    ];
    await until(() => conn.received.filter((m) => m !== "ping").length > n);
    for (const off of offs) off();
    await until(() => conn.received.filter((m) => m !== "ping").length > n + 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(
      conn.received
        .filter((m) => m !== "ping")
        .slice(n)
        .map((m) => JSON.parse(m)),
    ).toEqual([
      { op: "subscribe", topics: ["feed", "stats"], wallets: [WALLET] },
      { op: "unsubscribe", topics: ["feed", "stats"], wallets: [WALLET] },
    ]);
  });

  it("never connects without a WebSocket: the page polls as it did", () => {
    const c = client({ WebSocket: null });
    c.topic("apr", () => {});
    expect(c.isLive("apr")).toBe(false);
  });

  it("closes the connection of a tab hidden for a while, and opens it again once shown", async () => {
    onConnection = servingApr;
    let hidden = false;
    const listeners = new Set<() => void>();
    const page: Visibility = {
      hidden: () => hidden,
      listen: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    const show = (h: boolean) => {
      hidden = h;
      for (const cb of listeners) cb();
    };
    const c = client({ visibility: page, hiddenCloseMs: 60 });
    c.topic("apr", () => {});
    c.wallet(WALLET, () => {});
    await until(() => c.isLive("apr"));
    const first = stub.conns.at(-1)!;
    // a quick switch of tabs keeps the connection
    show(true);
    show(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(first.closed).toBe(false);
    expect(c.isLive("apr")).toBe(true);
    // hidden for longer, it closes and none is opened while the tab stays hidden
    const before = stub.upgrades();
    show(true);
    await until(() => first.closed);
    expect(c.isLive("apr")).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(stub.upgrades()).toBe(before);
    // shown, it connects again at once with its subscriptions
    show(false);
    await until(() => stub.conns.at(-1) !== first && c.isLive("apr"));
    expect(JSON.parse(stub.conns.at(-1)!.received[0]!)).toEqual({
      op: "subscribe",
      topics: ["apr"],
      wallets: [WALLET],
    });
  });

  it("does not connect while the tab is hidden from the start, past the grace", async () => {
    const before = stub.upgrades();
    const c = client({
      visibility: { hidden: () => true, listen: () => () => {} },
      hiddenCloseMs: 30,
    });
    c.topic("apr", () => {});
    // it connected at first (the grace), then closed: no new connection follows
    await until(() => stub.conns.at(-1)?.closed === true);
    const n = stub.upgrades();
    expect(n - before).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(stub.upgrades()).toBe(n);
  });
});

describe("a wallet's history poll", () => {
  it("is slower only while notifications are confirmed and the keeper's last answer is fresh", () => {
    const { walletPollMs, WALLET_POLL_MS, WALLET_LIVE_POLL_MS, WALLET_LIVE_FRESH_S } = mod;
    expect(WALLET_LIVE_POLL_MS).toBeGreaterThan(WALLET_POLL_MS);
    // the keeper indexing: notified, its answer a little behind finality
    expect(walletPollMs(true, NOW - 90, NOW)).toBe(WALLET_LIVE_POLL_MS);
    expect(walletPollMs(true, NOW - WALLET_LIVE_FRESH_S, NOW)).toBe(WALLET_LIVE_POLL_MS);
    // the subscription confirmed, but the keeper behind or stalled: its answer is old
    expect(walletPollMs(true, NOW - WALLET_LIVE_FRESH_S - 1, NOW)).toBe(WALLET_POLL_MS);
    // the subscription confirmed, but the app read the history itself (the keeper syncing, its
    // answer unmergeable or unreachable) or nothing was read yet
    expect(walletPollMs(true, null, NOW)).toBe(WALLET_POLL_MS);
    // no notifications: the usual pace, however fresh the answer
    expect(walletPollMs(false, NOW, NOW)).toBe(WALLET_POLL_MS);
  });
});
