// One wallet's history as the keeper serves it (GET /v1/wallet/:owner, apps/keeper/src/walletIndex.ts
// and the Stats Durable Object, stats.ts): the events it stores and the accounts it finds them
// by, the answer equal to the app's own reading of the same transactions (its tickets, its
// beneficiary rules, its deposits and withdrawals), bounded with the counts over every ticket,
// up to when every transaction is in it, the one-time replay an index counted before the wallets
// runs, and the route. The Durable Object runs over SQLite in memory and a scripted RPC.
import { DatabaseSync } from "node:sqlite";
import {
  isSolanaError,
  SolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  type Address,
} from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPayoutTableDecoder,
  getPayoutTableEncoder,
  getPayoutTableSize,
} from "../../../clients/js/src/generated/fade/index.ts";
import { PROGRAM } from "../../../apps/keeper/src/chain.ts";
import { INDEX_FRESH_S } from "../../../apps/keeper/src/vaultIndex.ts";
import { REFUSAL_SPAN_MS, REFUSALS_TO_CONFIRM } from "../../../apps/keeper/src/rpcHistory.ts";
import {
  WALLET_EVENTS_VERSION,
  WALLET_FINALITY_S,
  WALLET_LP_MAX,
  WALLET_READ_MAX,
  WALLET_TICKETS_MAX,
  eventsFrom,
  eventsJson,
  walletEventsOf,
  walletView,
  type WalletTx,
  type WalletView,
} from "../../../apps/keeper/src/walletIndex.ts";
import { parseKeeperWallet } from "../../../apps/web/src/lib/keeperWallet.ts";
import { programEventsOf } from "../../../apps/web/src/lib/fadeEvents.ts";
import { walletTotals } from "../../../apps/web/src/lib/walletHistory.ts";
import { parkedPayouts } from "../../../apps/web/src/lib/payoutEscrow.ts";
import { winPayout } from "../../../apps/web/src/lib/ticketRows.ts";
import {
  A,
  DAY,
  NOW,
  TABLE,
  TABLE_LHS,
  USDC,
  WALLETS,
  appWallet,
  eventTx,
  ev,
  sig,
  walletHistory,
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

type StatsObject = { wallet(owner: Address): Promise<WalletView> };
// Imported by a computed path: the Workers types it needs are the keeper's own typecheck's.
const STATS_MODULE = "../../../apps/keeper/src/stats.ts";
const { Stats } = (await import(STATS_MODULE)) as {
  Stats: new (ctx: unknown, env: unknown) => StatsObject;
};
const INDEX_MODULE = "../../../apps/keeper/src/index.ts";
const worker = (
  (await import(INDEX_MODULE)) as {
    default: { fetch(request: Request, env: unknown): Promise<Response> };
  }
).default;

/** Durable Object SQLite's limit on the parameters one statement binds. */
const MAX_BOUND = 100;
/** Statements run, and the most parameters any of them bound. */
const bound = { max: 0 };

function memoryState(db = new DatabaseSync(":memory:")) {
  const sql = {
    exec: (q: string, ...b: (string | number | null)[]) => {
      // refused as workerd refuses it (node:sqlite allows 32 766)
      if (b.length > MAX_BOUND) throw new Error("too many SQL variables: SQLITE_ERROR");
      bound.max = Math.max(bound.max, b.length);
      const rows = db.prepare(q).all(...b);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
  return {
    storage: {
      sql,
      transactionSync: <T>(fn: () => T) => fn(),
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
  };
}

const base64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const zeroTable = getPayoutTableDecoder().decode(new Uint8Array(getPayoutTableSize()));
const tableAccount = {
  data: [
    base64(Uint8Array.from(getPayoutTableEncoder().encode({ ...zeroTable, lhs: TABLE_LHS }))),
    "base64",
  ],
  owner: PROGRAM,
  lamports: 1n,
  executable: false,
  space: 0n,
};

/** A Stats Durable Object reading `h` through a scripted RPC; `reads` lists each transaction read. */
function statsOver(h: HistoryTx[]) {
  const reads: string[] = [];
  const tables: string[][] = [];
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
        return list
          .slice(0, 1_000)
          .map((x) => ({ signature: x.signature, err: null, blockTime: BigInt(x.at) }));
      },
    }),
    getTransaction: (signature: string) => ({
      send: async () => {
        reads.push(signature);
        const x = h.find((y) => y.signature === signature)!;
        return { ...x.tx, blockTime: BigInt(x.at), version: 1 };
      },
    }),
    getMultipleAccounts: (list: string[]) => ({
      send: async () => {
        tables.push(list);
        return { value: list.map((a) => (a === TABLE ? tableAccount : null)) };
      },
    }),
  };
  const state = memoryState();
  const stats = new Stats(state, { RPC_URL: "http://localhost:0" });
  (stats as unknown as { rpc: unknown }).rpc = rpc;
  const tick = () => (stats as unknown as { tick(): Promise<boolean> }).tick();
  const meta = (k: string) =>
    (
      state.storage.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0] as
        { v: string } | undefined
    )?.v;
  return { stats, state, tick, reads, tables, meta };
}

/** The keeper's answer for `owner`, as the app reads it, against the app's own reading of `h`. */
async function expectSameAsApp(stats: StatsObject, h: readonly HistoryTx[], owner: Address) {
  const keys = await walletKeys(owner);
  const view = await stats.wallet(owner);
  const k = parseKeeperWallet(JSON.parse(JSON.stringify(view)))!;
  expect(k).not.toBeNull();
  expect(k.syncing).toBe(false);
  expect({ owner: k.owner, integrator: k.integrator, usdcAccount: k.usdcAccount }).toEqual(keys);
  const own = appWallet(h, keys);
  expect(k.tickets.rows).toEqual(own.rows);
  expect(k.tickets.complete).toEqual({ buyer: true, app: true });
  expect(k.tickets.totals).toEqual(walletTotals(own.rows, keys));
  expect(k.lp.items).toEqual(own.items);
  expect(k.lp.complete).toBe(true);
  return { k, own };
}

describe("the wallet history's events", () => {
  it("keeps the tickets' and the LP owners' events, found by integrator, beneficiary, ticket and owner", async () => {
    const [t, b] = [A("direct"), A("beacon")];
    const w = await walletKeys(WALLETS[0]);
    const tx = eventTx(
      ev.opened(t, w.integrator, A("customer"), 2n * USDC, 40n * USDC),
      ev.joined(b, A("App"), w.usdcAccount, A("Funder"), USDC),
      ev.settled(t, w.integrator, 0n, false),
      ev.claimed(b),
      ev.deposit(w.owner, 3n, 5n * USDC),
      ev.struck(3n),
    );
    const found = walletEventsOf(tx, PROGRAM)!;
    // the close is the vault's, not a wallet's
    expect(found.events.map((e) => e.kind)).toEqual([
      "TicketOpened",
      "TicketJoined",
      "TicketSettled",
      "RoundPayoutClaimed",
      "DepositRequested",
    ]);
    expect(found.keys).toEqual(
      new Set([t, w.integrator, A("customer"), b, A("App"), w.usdcAccount, w.owner]),
    );
    // stored and read back as decoded
    expect(eventsFrom(eventsJson(found.events))).toEqual(programEventsOf(tx, PROGRAM).slice(0, 5));
    // nothing of a failed transaction, or of one without a wallet's event
    expect(walletEventsOf({ ...tx, meta: { ...tx.meta, err: { x: 1 } } }, PROGRAM)).toBeNull();
    expect(walletEventsOf(eventTx(ev.struck(4n)), PROGRAM)).toBeNull();
  });
});

describe("the wallet history's answer", () => {
  it("lists the newest tickets and its best win, with the counts over every ticket", async () => {
    const keys = await walletKeys(WALLETS[0]);
    const txs: WalletTx[] = [];
    const n = WALLET_TICKETS_MAX + 20;
    for (let i = 0; i < n; i++) {
      const ticket = A(`bounded-${i}`);
      const at = NOW - (n - i) * 60;
      // the oldest ticket wins the most
      const payout = i === 0 ? 900n * USDC : i % 7 === 0 ? 3n * USDC : 0n;
      for (const [j, datas] of [
        [0, ev.opened(ticket, A("App"), keys.usdcAccount, USDC, 1_000n * USDC)],
        [1, ev.settled(ticket, A("App"), payout, false)],
      ] as const)
        txs.push({
          signature: sig(2 * i + j + 1),
          at: at + j,
          slot: 0,
          events: programEventsOf(eventTx(datas), PROGRAM),
        });
    }
    for (let i = 0; i < WALLET_LP_MAX + 5; i++)
      txs.push({
        signature: sig(10_000 + i),
        at: NOW - i,
        slot: 0,
        events: programEventsOf(eventTx(ev.deposit(keys.owner, BigInt(i), USDC)), PROGRAM),
      });
    const view = walletView({ keys, txs, lhs: new Map(), through: NOW, syncing: false, now: NOW });
    const k = parseKeeperWallet(JSON.parse(JSON.stringify(view)))!;
    expect(k.tickets.complete).toEqual({ buyer: false, app: true });
    expect(k.tickets.rows.length).toBe(WALLET_TICKETS_MAX + 1);
    expect(k.tickets.rows.at(-1)!.ticket).toBe(A("bounded-0"));
    expect(k.tickets.rows[0]!.ticket).toBe(A(`bounded-${n - 1}`));
    expect(k.tickets.totals.tickets).toBe(n);
    expect(k.tickets.totals.best).toBe(A("bounded-0"));
    // the counts over every ticket, as the app counts them
    expect(k.tickets.totals.buyer.draws).toBe(n);
    expect(k.tickets.totals.buyer.won).toBe(
      900n * USDC + 3n * USDC * BigInt(Math.floor((n - 1) / 7)),
    );
    expect(k.tickets.totals.buyer.spent).toBe(BigInt(n) * USDC);
    expect(k.lp.complete).toBe(false);
    expect(k.lp.items.length).toBe(WALLET_LP_MAX);
    expect(view.lp.count).toBe(WALLET_LP_MAX + 5);
  });

  it("reads a version-2 expiry stored with a version-1 decoder's fields alone as a forfeiture", async () => {
    // A keeper older than the program's upgrade stored a version-2 `TicketExpired` as far as its
    // version-1 decoder read it: no request findings, refund or parked flag. Stored events are
    // replayed as stored, so the answer must still read.
    const keys = await walletKeys(WALLETS[0]);
    const ticket = A("stored-v2-expiry");
    const opened: WalletTx = {
      signature: sig(1),
      at: NOW - 600,
      slot: 0,
      events: programEventsOf(
        eventTx(ev.opened(ticket, A("App"), keys.usdcAccount, USDC, 50n * USDC)),
        PROGRAM,
      ),
    };
    const stored = eventsJson([
      {
        kind: "TicketExpired",
        data: { version: 2, ticket, integrator: A("App"), forfeited: USDC },
      } as unknown as WalletTx["events"][number],
    ]);
    const expired: WalletTx = {
      signature: sig(2),
      at: NOW - 300,
      slot: 0,
      events: eventsFrom(stored),
    };
    const view = walletView({
      keys,
      txs: [opened, expired],
      lhs: new Map(),
      through: NOW,
      syncing: false,
      now: NOW,
    });
    const k = parseKeeperWallet(JSON.parse(JSON.stringify(view)));
    expect(k).not.toBeNull();
    expect(k!.tickets.rows).toHaveLength(1);
    expect(k!.tickets.rows[0]!.end).toMatchObject({ kind: "expired", payout: 0n, pending: false });
    expect(k!.tickets.rows[0]!.end!.creditReturned).toBeUndefined();
  });

  it("keeps a refunded direct ticket's returned credit on the wire, its parked one offered a claim", async () => {
    // `ticketRowJson` serves the keeper's rows: a refund is an expiry whose `payout` is the vault
    // credit back, which only `creditReturned` tells apart from a win.
    const keys = await walletKeys(WALLETS[0]);
    const credit = 95n * (USDC / 100n);
    const txs: WalletTx[] = [];
    const tickets = [A("refund-paid"), A("refund-parked")];
    tickets.forEach((ticket, i) =>
      txs.push(
        ...[
          ev.opened(ticket, A("App"), keys.usdcAccount, USDC, 50n * USDC),
          ev.refundedDirect(ticket, A("App"), credit, i === 1),
        ].map((datas, j) => ({
          signature: sig(10 + 2 * i + j),
          at: NOW - 600 + 2 * i + j,
          slot: 0,
          events: programEventsOf(eventTx(datas), PROGRAM),
        })),
      ),
    );
    const view = walletView({ keys, txs, lhs: new Map(), through: NOW, syncing: false, now: NOW });
    const k = parseKeeperWallet(JSON.parse(JSON.stringify(view)))!;
    const byTicket = new Map(k.tickets.rows.map((r) => [r.ticket, r]));
    expect(byTicket.get(tickets[0]!)!.end).toEqual(
      expect.objectContaining({
        kind: "expired",
        payout: credit,
        pending: false,
        creditReturned: true,
      }),
    );
    expect(byTicket.get(tickets[1]!)!.end).toEqual(
      expect.objectContaining({
        kind: "expired",
        payout: credit,
        pending: true,
        creditReturned: true,
      }),
    );
    // neither is a win, and the parked credit is claimable from the dashboard
    expect(k.tickets.rows.map((r) => winPayout(r.end))).toEqual([0n, 0n]);
    expect(k.tickets.totals.buyer.wins).toBe(0);
    expect(k.tickets.totals.buyer.won).toBe(0n);
    expect(parkedPayouts(k.tickets.rows, keys.usdcAccount).map((r) => r.ticket)).toEqual([
      tickets[1],
    ]);
  });

  /** A ticket opened and drawn, as the index stores it: two transactions from `n`. */
  const drawn = (
    n: number,
    at: number,
    ticket: Address,
    integrator: Address,
    beneficiary: Address,
    payout: bigint,
    pending: boolean,
  ): WalletTx[] =>
    [
      ev.opened(ticket, integrator, beneficiary, USDC, 50n * USDC),
      ev.settled(ticket, integrator, payout, pending),
    ].map((datas, j) => ({
      signature: sig(n + j),
      at: at + j,
      slot: 0,
      events: programEventsOf(eventTx(datas), PROGRAM),
    }));

  it("bounds the app's tickets apart from the wallet's own draws, its parked payouts kept", async () => {
    const keys = await walletKeys(WALLETS[0]);
    const txs: WalletTx[] = [];
    // three draws of the wallet's own, the newest with a payout parked for it
    const own = [A("own-0"), A("own-1"), A("own-2")];
    own.forEach((t, i) =>
      txs.push(
        ...drawn(
          2 * i + 1,
          NOW - 10 * DAY + i * 60,
          t,
          A("OtherApp"),
          keys.usdcAccount,
          i === 2 ? 4n * USDC : 0n,
          i === 2,
        ),
      ),
    );
    // then more of its app's tickets, for its customers, than an answer lists
    const n = WALLET_TICKETS_MAX + 100;
    for (let i = 0; i < n; i++)
      txs.push(
        ...drawn(
          1_000 + 2 * i,
          NOW - 5 * DAY + i * 60,
          A(`app-${i}`),
          keys.integrator,
          A(`customer-${i}`),
          0n,
          false,
        ),
      );
    const view = walletView({ keys, txs, lhs: new Map(), through: NOW, syncing: false, now: NOW });
    const k = parseKeeperWallet(JSON.parse(JSON.stringify(view)))!;
    expect(k.tickets.complete).toEqual({ buyer: true, app: false });
    const buyerRows = k.tickets.rows.filter((r) => r.beneficiary === keys.usdcAccount);
    expect(buyerRows.map((r) => r.ticket)).toEqual([...own].reverse());
    expect(buyerRows[0]!.end).toMatchObject({ pending: true, payout: 4n * USDC });
    expect(k.tickets.rows.filter((r) => r.integrator === keys.integrator).length).toBe(
      WALLET_TICKETS_MAX,
    );
    // newest first, as the app lists them
    expect(k.tickets.rows[0]!.ticket).toBe(A(`app-${n - 1}`));
    expect(k.tickets.rows.at(-1)!.ticket).toBe(own[0]);
    expect(k.tickets.totals.app.tickets).toBe(n);
    expect(k.tickets.totals.buyer.draws).toBe(3);

    // past the bound of its own draws, a parked payout is listed whatever its age
    const many: WalletTx[] = [
      ...drawn(
        1,
        NOW - 30 * DAY,
        A("parked-old"),
        A("OtherApp"),
        keys.usdcAccount,
        2n * USDC,
        true,
      ),
    ];
    for (let i = 0; i < WALLET_TICKETS_MAX + 10; i++)
      many.push(
        ...drawn(
          10 + 2 * i,
          NOW - 20 * DAY + i * 60,
          A(`draw-${i}`),
          A("OtherApp"),
          keys.usdcAccount,
          // the best win is a newer one: the old parked payout is kept as parked
          i === WALLET_TICKETS_MAX + 9 ? 9n * USDC : 0n,
          false,
        ),
      );
    const bounded = parseKeeperWallet(
      JSON.parse(
        JSON.stringify(
          walletView({ keys, txs: many, lhs: new Map(), through: NOW, syncing: false, now: NOW }),
        ),
      ),
    )!;
    expect(bounded.tickets.complete).toEqual({ buyer: false, app: true });
    expect(bounded.tickets.rows.length).toBe(WALLET_TICKETS_MAX + 1);
    expect(bounded.tickets.totals.best).toBe(A(`draw-${WALLET_TICKETS_MAX + 9}`));
    expect(bounded.tickets.rows.at(-1)!.ticket).toBe(A("parked-old"));
    expect(bounded.tickets.totals.buyer.draws).toBe(WALLET_TICKETS_MAX + 11);
  });
});

describe("the Stats Durable Object's wallet history", () => {
  let now = NOW * 1_000;
  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    now = NOW * 1_000;
  });

  it("a new index serves each wallet the app's own reading of the same transactions", async () => {
    const h = await walletHistory(81);
    const { stats, tick, reads } = statsOver(h);
    for (let i = 0; i < 60 && (await tick()); i++);
    expect(new Set(reads).size).toBe(h.length);
    let seen = 0;
    const shapes = new Set<string>();
    for (const owner of WALLETS) {
      const { k, own } = await expectSameAsApp(stats, h, owner);
      seen += own.rows.length + own.items.length;
      // what the app tells its rows by: a refund owed to another funder, a parked payout, an app's
      for (const r of own.rows) {
        if (r.beacon && r.beacon.refundTo !== k.usdcAccount) shapes.add("other funder");
        if (r.end?.pending) shapes.add("parked");
        if (r.end?.refunded) shapes.add("refunded");
        if (r.integrator === k.integrator && r.beneficiary !== k.usdcAccount) shapes.add("app");
      }
    }
    expect(seen).toBeGreaterThan(80);
    expect([...shapes].sort()).toEqual(["app", "other funder", "parked", "refunded"]);
    // a wallet with no history: empty, not syncing
    const empty = parseKeeperWallet(JSON.parse(JSON.stringify(await stats.wallet(A("nobody")))))!;
    expect(empty.tickets.rows).toEqual([]);
    expect(empty.lp.items).toEqual([]);
    expect(empty.syncing).toBe(false);
  });

  it("serves every program transaction up to `through`, and says it is syncing once the loop stalls", async () => {
    const h = await walletHistory(82, 30);
    const { stats, state, tick } = statsOver(h);
    for (let i = 0; i < 60 && (await tick()); i++);
    const newest = h.at(-1)!.at;
    let view = await stats.wallet(WALLETS[0]);
    // caught up just now: back to the last listing, less the finality margin
    expect(view.through).toBe(Math.max(newest, NOW - WALLET_FINALITY_S));
    // a transaction listed and not read yet holds it back
    state.storage.sql.exec(
      "INSERT INTO backlog (signature, round, idx, block_time) VALUES (?, 1, 0, ?)",
      sig(99_999),
      NOW - DAY,
    );
    now += 10_000;
    view = await stats.wallet(WALLETS[0]);
    expect(view.through).toBe(NOW - DAY - 1);
    state.storage.sql.exec("DELETE FROM backlog");
    expect(view.syncing).toBe(false);
    // the loop stopped reading the program
    now += (INDEX_FRESH_S + 10) * 1_000;
    expect((await stats.wallet(WALLETS[0])).syncing).toBe(true);
  });

  /** A -32020 as Agave sends it, naming `bound` (or, `named` false, no signature at all). */
  const refusalOf = (bound: string, named = true) =>
    new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND, {
      __serverMessage: named
        ? `Transaction ${bound} not found`
        : "Transaction history is not available from this node",
    });

  /**
   * `stats`'s RPC, restricted to the transactions `held` keeps (a node's bounded history, or a
   * dropped signature), each listed with its slot (its index in `h`, plus one): a call bounded by a
   * signature it does not hold is refused with -32020, as Agave refuses it (naming it, unless
   * `named` is false). `held` is asked of the bounds first, once a call.
   */
  function boundedHistory(
    stats: StatsObject,
    h: HistoryTx[],
    held: (s: string) => boolean,
    named = true,
  ) {
    const rpc = (
      stats as unknown as {
        rpc: {
          getSignaturesForAddress: (p: unknown, o: { until?: string; before?: string }) => unknown;
        };
      }
    ).rpc;
    const refused: string[] = [];
    rpc.getSignaturesForAddress = (_p, o) => ({
      send: async () => {
        for (const bound of [o.until, o.before])
          if (bound !== undefined && !held(bound)) {
            refused.push(bound);
            throw refusalOf(bound, named);
          }
        const kept = new Set(h.map((x) => x.signature).filter(held));
        const slot = new Map(h.map((x, i) => [x.signature, BigInt(i + 1)]));
        let list = [...h].reverse().filter((x) => kept.has(x.signature));
        if (o.before !== undefined)
          list = list.slice(list.findIndex((x) => x.signature === o.before) + 1);
        if (o.until !== undefined)
          list = list.slice(
            0,
            list.findIndex((x) => x.signature === o.until),
          );
        return list.slice(0, 1_000).map((x) => ({
          signature: x.signature,
          slot: slot.get(x.signature)!,
          err: null,
          blockTime: BigInt(x.at),
        }));
      },
    });
    return refused;
  }

  /**
   * Ticks until there is nothing more to read right away, or `n` ticks. A tick a refusal fails
   * (the alarm logs it, and its next tick asks again) moves the clock 30 s, as the idle alarm
   * does. The ticks a refusal failed.
   */
  async function settle(tick: () => Promise<boolean>, n = 60) {
    let failed = 0;
    for (let i = 0; i < n; i++) {
      try {
        if (!(await tick())) return failed;
      } catch (e) {
        if (!isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND))
          throw e;
        failed++;
        now += 30_000;
      }
    }
    return failed;
  }

  /** Whether `console.warn` said the RPC no longer holds a signature. */
  const saidGone = () =>
    vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes("no longer holds"));

  it("follows the program again once the RPC lastingly refuses its cursor, as a short-retention node prunes it", async () => {
    const all = await walletHistory(91, 45);
    const h = all.splice(0, 60);
    expect(all.length).toBeGreaterThan(20);
    const { stats, tick, reads, meta } = statsOver(h);
    for (let i = 0; i < 60 && (await tick()); i++);
    const cursor = meta("cursor")!;
    expect(cursor).toBe(h.at(-1)!.signature);
    // New activity, while the node prunes everything up to and including the cursor (a local
    // validator's ledger keeps a few minutes of it): every call bounded by it is refused.
    const old = new Set(h.map((x) => x.signature));
    h.push(...all.splice(0, all.length - 10));
    const refused = boundedHistory(stats, h, (s) => !old.has(s));
    now += 60_000;
    // refused until it lasts (REFUSALS_TO_CONFIRM refusals over REFUSAL_SPAN_MS), each refusal
    // before failing its tick; the round then lists back to the oldest signature the node holds
    expect(await settle(tick)).toBe(REFUSALS_TO_CONFIRM - 1);
    expect(refused).toEqual(Array(REFUSALS_TO_CONFIRM).fill(cursor));
    expect(meta("cursor")).toBe(h.at(-1)!.signature);
    expect(meta("round_cursor_lost")).toBeUndefined();
    expect(meta("refusal_round")).toBeUndefined();
    expect(saidGone()).toBe(true);
    expect(new Set(reads).size).toBe(reads.length);
    expect(new Set(reads).size).toBe(h.length);
    // the feed's and the wallets' answers hold every transaction, and are not syncing
    for (const owner of WALLETS) await expectSameAsApp(stats, h, owner);
    // and the next activity is followed from the new cursor, nothing refused again
    h.push(...all.splice(0));
    now += 60_000;
    expect(await settle(tick)).toBe(0);
    expect(refused).toEqual(Array(REFUSALS_TO_CONFIRM).fill(cursor));
    expect(new Set(reads).size).toBe(h.length);
    for (const owner of WALLETS) await expectSameAsApp(stats, h, owner);
  });

  it("lists back to its cursor's slot alone when the RPC dropped the cursor but holds what is older", async () => {
    const all = await walletHistory(94, 30);
    const h = all.splice(0, 50);
    expect(all.length).toBeGreaterThan(10);
    const { stats, tick, reads, meta } = statsOver(h);
    // the slots are those boundedHistory lists, from the first round on
    const cursorOf = h.at(-1)!.signature;
    boundedHistory(stats, h, () => true);
    for (let i = 0; i < 60 && (await tick()); i++);
    expect(meta("cursor")).toBe(cursorOf);
    expect(meta("cursor_slot")).toBe(String(h.length));
    // the cursor alone gone (a `confirmed` signature its fork dropped, say)
    h.push(...all.splice(0));
    const refused = boundedHistory(stats, h, (s) => s !== cursorOf);
    const before = reads.length;
    now += 60_000;
    expect(await settle(tick)).toBe(REFUSALS_TO_CONFIRM - 1);
    expect(refused).toEqual(Array(REFUSALS_TO_CONFIRM).fill(cursorOf));
    // nothing older than the cursor's slot read again
    const older = new Set(h.slice(0, 50).map((x) => x.signature));
    expect(reads.slice(before).filter((s) => older.has(s))).toEqual([]);
    expect(new Set(reads).size).toBe(reads.length);
    expect(meta("cursor")).toBe(h.at(-1)!.signature);
    expect(meta("cursor_slot")).toBe(String(h.length));
    for (const owner of WALLETS) await expectSameAsApp(stats, h, owner);
  });

  it("lists back to the newest transaction counted when the cursor, stored without its slot, is dropped and the node holds what is older", async () => {
    // block times in the order of the signatures, as the chain's are
    const all = (await walletHistory(95, 30)).map((x, i) => ({
      ...x,
      at: NOW - 10 * DAY + i * 60,
    }));
    const h = all.splice(0, 50);
    expect(all.length).toBeGreaterThan(10);
    // a cursor stored before its slot was: the plain RPC lists no slot
    const { stats, tick, reads, meta } = statsOver(h);
    for (let i = 0; i < 60 && (await tick()); i++);
    const cursorOf = h.at(-1)!.signature;
    expect(meta("cursor")).toBe(cursorOf);
    expect(meta("cursor_slot")).toBeUndefined();
    expect(meta("through")).toBe(String(h.at(-1)!.at));
    // the cursor alone gone, every older signature still held
    h.push(...all.splice(0));
    const refused = boundedHistory(stats, h, (s) => s !== cursorOf);
    const before = reads.length;
    now += 60_000;
    expect(await settle(tick)).toBe(REFUSALS_TO_CONFIRM - 1);
    expect(refused).toEqual(Array(REFUSALS_TO_CONFIRM).fill(cursorOf));
    // the listing stopped at `through`: nothing counted before read again
    const older = new Set(h.slice(0, 50).map((x) => x.signature));
    expect(reads.slice(before).filter((s) => older.has(s))).toEqual([]);
    expect(new Set(reads).size).toBe(reads.length);
    expect(new Set(reads).size).toBe(h.length);
    // the new cursor has its slot
    expect(meta("cursor")).toBe(h.at(-1)!.signature);
    expect(meta("cursor_slot")).toBe(String(h.length));
    for (const owner of WALLETS) await expectSameAsApp(stats, h, owner);
  });

  it.each([
    ["naming it", true],
    ["naming no signature", false],
  ] as const)(
    "takes one refusal of its cursor (%s), from a node behind, as nothing to act on: asked again next tick, nothing skipped",
    async (_, named) => {
      const all = await walletHistory(96, 40);
      const h = all.splice(0, 50);
      const { stats, tick, reads, meta } = statsOver(h);
      for (let i = 0; i < 60 && (await tick()); i++);
      const cursor = meta("cursor")!;
      // a load-balanced provider's node a slot or two behind refuses the fresh cursor, once
      h.push(...all.splice(0));
      let lagging = true;
      const refused = boundedHistory(
        stats,
        h,
        (s) => {
          if (s !== cursor || !lagging) return true;
          lagging = false;
          return false;
        },
        named,
      );
      const before = reads.length;
      now += 60_000;
      await expect(tick()).rejects.toSatisfy((e) =>
        isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND),
      );
      // nothing irreversible: the cursor kept and still asked for, the refusal noted alone
      expect(reads.length).toBe(before);
      expect(meta("cursor")).toBe(cursor);
      expect(meta("round_cursor_lost")).toBeUndefined();
      expect(meta("round_head")).toBeUndefined();
      expect(JSON.parse(meta("refusal_round")!)).toMatchObject({ bound: cursor, count: 1 });
      // the next tick asks again, and reads the round as if nothing happened
      now += 30_000;
      expect(await settle(tick)).toBe(0);
      expect(refused).toEqual([cursor]);
      expect(meta("refusal_round")).toBeUndefined();
      expect(saidGone()).toBe(false);
      expect(meta("cursor")).toBe(h.at(-1)!.signature);
      expect(new Set(reads).size).toBe(reads.length);
      expect(new Set(reads).size).toBe(h.length);
      for (const owner of WALLETS) await expectSameAsApp(stats, h, owner);
    },
  );

  it.each([
    ["once, by a node behind: the round lists on past it next tick", 1],
    ["lastingly: the round ends with what it listed", Infinity],
  ] as const)("takes a refusal of where the round's listing stopped %s", async (_, times) => {
    const all = await walletHistory(100, 40);
    const h = all.splice(0, 50);
    const { stats, state, tick, reads, meta } = statsOver(h);
    for (let i = 0; i < 60 && (await tick()); i++);
    const cursor = meta("cursor")!;
    // a round under way: its first page listed the newest half of the new transactions
    // (a page is 1 000 signatures), its listing stopped at `stop`
    const fresh = all.splice(0);
    h.push(...fresh);
    const stop = fresh[Math.floor(fresh.length / 2)]!;
    const between = fresh.slice(0, fresh.indexOf(stop)).map((x) => x.signature);
    for (const [k, v] of [
      ["round_head", h.at(-1)!.signature],
      ["round_before", stop.signature],
      ["round_listed", "0"],
    ] as const)
      state.storage.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, v);
    let left = times;
    const refused = boundedHistory(stats, h, (s) => s !== stop.signature || left-- <= 0);
    expect(await settle(tick)).toBe(times === 1 ? 1 : REFUSALS_TO_CONFIRM - 1);
    expect(refused).toEqual(Array(times === 1 ? 1 : REFUSALS_TO_CONFIRM).fill(stop.signature));
    expect(meta("refusal_round")).toBeUndefined();
    expect(meta("round_before")).toBeUndefined();
    // the round completed: its head is the cursor
    expect(meta("cursor")).toBe(h.at(-1)!.signature);
    expect(meta("cursor")).not.toBe(cursor);
    const read = new Set(reads);
    if (times === 1) {
      // listed on past the refusal, back to the cursor
      expect(between.every((s) => read.has(s))).toBe(true);
      expect(saidGone()).toBe(false);
    } else {
      // what lay between the cursor and where the listing stopped is not listed
      expect(between.some((s) => read.has(s))).toBe(false);
      expect(saidGone()).toBe(true);
    }
    expect(new Set(reads).size).toBe(reads.length);
  });

  it("throws any other error of a call bounded by its cursor as it is, never reading it as pruning", async () => {
    const all = await walletHistory(97, 40);
    const h = all.splice(0, 50);
    const { stats, tick, reads, meta } = statsOver(h);
    for (let i = 0; i < 60 && (await tick()); i++);
    const cursor = meta("cursor")!;
    h.push(...all.splice(0));
    const rpc = (
      stats as unknown as {
        rpc: { getSignaturesForAddress: (p: unknown, o: { until?: string }) => unknown };
      }
    ).rpc;
    const list = rpc.getSignaturesForAddress;
    let unhealthy = true;
    rpc.getSignaturesForAddress = (p, o) =>
      unhealthy && o.until === cursor
        ? {
            send: async () => {
              throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY, {
                numSlotsBehind: 3,
              });
            },
          }
        : list(p, o);
    for (let i = 0; i < 2 * REFUSALS_TO_CONFIRM; i++) {
      now += REFUSAL_SPAN_MS;
      await expect(tick()).rejects.toSatisfy((e) =>
        isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY),
      );
    }
    expect(meta("cursor")).toBe(cursor);
    expect(meta("round_cursor_lost")).toBeUndefined();
    expect(meta("refusal_round")).toBeUndefined();
    unhealthy = false;
    expect(await settle(tick)).toBe(0);
    expect(saidGone()).toBe(false);
    expect(new Set(reads).size).toBe(h.length);
    for (const owner of WALLETS) await expectSameAsApp(stats, h, owner);
  });

  /** The meta of an index caught up to the newest of `h`, every replay done but `replay`'s. */
  const REPLAYS = [
    {
      replay: "replay",
      listing: "replay_listing",
      refusal: "refusal_replay",
      done: [
        ["apr_version", "2"],
        ["apr_covered", "0"],
        ["views_covered", "0"],
        ["wallet_version", String(WALLET_EVENTS_VERSION)],
        ["wallet_covered", "1"],
      ],
    },
    {
      replay: "APR replay",
      listing: "apr_replay_listing",
      refusal: "refusal_apr_replay",
      done: [
        ["events_version", "2"],
        ["wallet_version", String(WALLET_EVENTS_VERSION)],
        ["wallet_covered", "1"],
      ],
    },
    {
      replay: "wallets' replay",
      listing: "wallet_replay_listing",
      refusal: "refusal_wallet_replay",
      done: [
        ["events_version", "2"],
        ["apr_version", "2"],
        ["apr_covered", "0"],
        ["views_covered", "0"],
      ],
    },
  ] as const;

  /**
   * An index over `h` caught up to its newest transaction with `done`'s replays done, whose RPC
   * refuses its cursor as a `before` (where every replay's listing starts) the first `times`
   * calls. The refusals so far.
   */
  function replayingOver(
    h: HistoryTx[],
    done: readonly (readonly [string, string])[],
    times: number,
  ) {
    const over = statsOver(h);
    const cursor = h.at(-1)!.signature;
    for (const [k, v] of [
      ["cursor", cursor],
      ["round", "1"],
      ["completed_round", "1"],
      ["caught_up", "1"],
      ["transactions", String(h.length)],
      ["through", String(Math.max(...h.map((x) => x.at)))],
      ["current_at", String(NOW)],
      ...done,
    ] as const)
      over.state.storage.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?)", k, v);
    const rpc = (
      over.stats as unknown as {
        rpc: { getSignaturesForAddress: (p: unknown, o: { before?: string }) => unknown };
      }
    ).rpc;
    const list = rpc.getSignaturesForAddress;
    const refused: string[] = [];
    rpc.getSignaturesForAddress = (p, o) =>
      o.before === cursor && refused.length < times
        ? {
            send: async () => {
              refused.push(cursor);
              throw refusalOf(cursor);
            },
          }
        : list(p, o);
    return { ...over, cursor, refused };
  }

  it.each(REPLAYS)(
    "takes one refusal of where the $replay lists from as nothing to act on: it lists the whole history next tick",
    async ({ listing, refusal, done }) => {
      const h = await walletHistory(98, 30);
      const { tick, reads, meta, cursor, refused } = replayingOver(h, done, 1);
      await expect(tick()).rejects.toSatisfy((e) =>
        isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND),
      );
      // the listing not ended, the refusal noted alone
      expect(meta(listing)).toBe("1");
      expect(JSON.parse(meta(refusal)!)).toMatchObject({ bound: cursor, count: 1 });
      now += 30_000;
      for (let i = 0; i < 4; i++) {
        await settle(tick);
        now += 3_600_000;
      }
      expect(refused).toEqual([cursor]);
      expect(meta(listing)).toBeUndefined();
      expect(meta(refusal)).toBeUndefined();
      expect(saidGone()).toBe(false);
      // every transaction replayed, the history not cut at the refusal
      expect(new Set(reads).size).toBe(h.length);
    },
  );

  it.each(REPLAYS)(
    "ends the $replay's listing where the RPC lastingly refuses it, with what it listed",
    async ({ listing, refusal, done }) => {
      const h = await walletHistory(99, 30);
      const { tick, reads, meta, cursor, refused } = replayingOver(h, done, Infinity);
      expect(await settle(tick)).toBe(REFUSALS_TO_CONFIRM - 1);
      expect(refused).toEqual(Array(REFUSALS_TO_CONFIRM).fill(cursor));
      expect(meta(listing)).toBeUndefined();
      expect(meta(refusal)).toBeUndefined();
      expect(saidGone()).toBe(true);
      // the cursor alone replayed, and the listing asked for no more
      for (let i = 0; i < 4; i++) {
        await settle(tick);
        now += 3_600_000;
      }
      expect(refused.length).toBe(REFUSALS_TO_CONFIRM);
      expect(new Set(reads)).toEqual(new Set([cursor]));
    },
  );

  it("builds a wallet's answer at most every 10 s, reading its payout tables once", async () => {
    const h = await walletHistory(83, 40);
    const { stats, tick, tables } = statsOver(h);
    for (let i = 0; i < 60 && (await tick()); i++);
    const first = await stats.wallet(WALLETS[1]);
    now += 5_000;
    expect(await stats.wallet(WALLETS[1])).toBe(first);
    now += 6_000;
    const next = await stats.wallet(WALLETS[1]);
    expect(next).not.toBe(first);
    expect(next.updatedAt).not.toBe(first.updatedAt);
    expect(tables.filter((l) => l.includes(TABLE)).length).toBeLessThanOrEqual(1);
    // an answer is not kept in memory once it can no longer be served
    const kept = (stats as unknown as { wallets: Map<Address, unknown> }).wallets;
    await stats.wallet(WALLETS[0]);
    expect(kept.size).toBe(2);
    now += 10_000;
    await stats.wallet(WALLETS[2]);
    expect([...kept.keys()]).toEqual([WALLETS[2]]);
  });

  it("replays, once, newest first, the whole history of an index counted before the wallets", async () => {
    const h = await walletHistory(84);
    const { stats, state, tick, reads, meta } = statsOver(h);
    // An index caught up to the newest transaction, recording everything but the wallets.
    for (const [k, v] of [
      ["cursor", h.at(-1)!.signature],
      ["round", "1"],
      ["completed_round", "1"],
      ["caught_up", "1"],
      ["transactions", String(h.length)],
      ["through", String(h.at(-1)!.at)],
      ["events_version", "2"],
      ["apr_version", "2"],
      ["apr_covered", "0"],
      ["views_covered", "0"],
      ["current_at", String(NOW)],
    ] as const)
      state.storage.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?)", k, v);
    expect((await stats.wallet(WALLETS[0])).syncing).toBe(true);
    // one tick lists it, the next ones read it newest first
    await tick();
    await tick();
    expect(reads.slice(0, 5)).toEqual(
      [...h]
        .reverse()
        .slice(0, 5)
        .map((x) => x.signature),
    );
    expect((await stats.wallet(WALLETS[0])).syncing).toBe(true);
    for (let i = 0; i < 20 && (await tick()); i++);
    expect(new Set(reads).size).toBe(h.length);
    expect(meta("wallet_version")).toBe(String(WALLET_EVENTS_VERSION));
    expect(meta("wallet_covered")).toBe("1");
    for (const owner of WALLETS) await expectSameAsApp(stats, h, owner);
    // nothing read again on later ticks
    const n = reads.length;
    for (let i = 0; i < 3; i++) await tick();
    expect(reads.length).toBe(n);
  });

  it("serves a wallet without a replayed transaction the RPC never returns, and keeps it once served", async () => {
    const h = await walletHistory(85, 30);
    const { stats, state, tick, meta } = statsOver(h);
    for (const [k, v] of [
      ["cursor", h.at(-1)!.signature],
      ["round", "1"],
      ["completed_round", "1"],
      ["caught_up", "1"],
      ["events_version", "2"],
      ["apr_version", "2"],
      ["apr_covered", "0"],
      ["views_covered", "0"],
    ] as const)
      state.storage.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?)", k, v);
    const rpc = (stats as unknown as { rpc: { getTransaction: (s: string) => unknown } }).rpc;
    const read = rpc.getTransaction;
    const lost = h[0]!.signature;
    let served = false;
    rpc.getTransaction = (s: string) =>
      s === lost && !served ? { send: async () => null } : read(s);
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 5; j++) await tick();
      now += 3_600_000;
    }
    expect(meta("wallet_covered")).toBe("1");
    served = true;
    now += 3_600_000;
    for (let i = 0; i < 5; i++) await tick();
    expect(
      state.storage.sql.exec("SELECT 1 FROM wallet_txs WHERE signature = ?", lost).toArray().length,
    ).toBe(1);
  });
});

describe("the Stats Durable Object's wallet builds", () => {
  let now = NOW * 1_000;
  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    now = NOW * 1_000;
  });

  it("serves a wallet with hundreds of tickets, binding at most 100 parameters a statement", async () => {
    const w = await walletKeys(WALLETS[0]);
    const h: HistoryTx[] = [];
    const n = 260;
    for (let i = 0; i < n; i++) {
      const ticket = A(`many-${i}`);
      const at = NOW - DAY + i * 60;
      h.push({
        signature: sig(2 * i + 1),
        at,
        tx: eventTx(ev.opened(ticket, w.integrator, w.usdcAccount, USDC, 2n * USDC)),
      });
      if (i % 5 !== 0)
        h.push({
          signature: sig(2 * i + 2),
          at: at + 10,
          tx: eventTx(ev.settled(ticket, w.integrator, i % 3 === 0 ? 2n * USDC : 0n, false)),
        });
    }
    const { stats, tick } = statsOver(h);
    for (let i = 0; i < 80 && (await tick()); i++);
    bound.max = 0;
    const { k } = await expectSameAsApp(stats, h, w.owner);
    expect(k.tickets.totals.tickets).toBe(n);
    expect(bound.max).toBeGreaterThan(50);
    expect(bound.max).toBeLessThanOrEqual(MAX_BOUND);
  });

  it("answers a wallet past what one build reads as oversized and syncing, without reading it", async () => {
    const h = await walletHistory(86, 20);
    const { stats, state, tick } = statsOver(h);
    for (let i = 0; i < 40 && (await tick()); i++);
    const busy = await walletKeys(WALLETS[1]);
    // as many stored transactions as a busy app's integrator finds
    state.storage.sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO wallet_keys (key, signature) SELECT ?, 'busy-' || i FROM n`,
      WALLET_READ_MAX,
      busy.integrator,
    );
    const parse = vi.spyOn(JSON, "parse");
    const view = await stats.wallet(WALLETS[1]);
    expect(parse).not.toHaveBeenCalled();
    expect(view.oversized).toBe(true);
    expect(view.syncing).toBe(true);
    expect(view.tickets.rows).toEqual([]);
    const k = parseKeeperWallet(JSON.parse(JSON.stringify(view)))!;
    expect(k.syncing).toBe(true);
    // a wallet under the bound is served as before
    expect((await stats.wallet(WALLETS[0])).oversized).toBe(false);
  });

  it("shares one build between the requests that wait for it", async () => {
    const h = await walletHistory(87, 30);
    const { stats, tick } = statsOver(h);
    for (let i = 0; i < 40 && (await tick()); i++);
    const build = vi.spyOn(stats as unknown as { buildWallet(o: Address): unknown }, "buildWallet");
    const [a, b, c] = await Promise.all([
      stats.wallet(WALLETS[2]),
      stats.wallet(WALLETS[2]),
      stats.wallet(WALLETS[2]),
    ]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
    // a build that fails is not kept: the next request builds again
    now += 11_000;
    build.mockRejectedValueOnce(new Error("boom"));
    await expect(stats.wallet(WALLETS[2])).rejects.toThrow("boom");
    expect(await stats.wallet(WALLETS[2])).not.toBe(a);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it("says up to when the answer holds every transaction as of its reads, not after its payout tables' read", async () => {
    const h = await walletHistory(88, 40);
    const { stats, state, tick } = statsOver(h);
    for (let i = 0; i < 60 && (await tick()); i++);
    const rpc = (stats as unknown as { rpc: { getMultipleAccounts: (l: string[]) => unknown } })
      .rpc;
    const read = rpc.getMultipleAccounts;
    let asked = 0;
    rpc.getMultipleAccounts = (l: string[]) => {
      asked += 1;
      // the loop counts a newer transaction while the build waits for the RPC
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO meta (k, v) VALUES ('through', ?), ('current_at', ?)",
        String(NOW + 600),
        String(NOW + 600),
      );
      return read(l);
    };
    const before = Math.max(h.at(-1)!.at, NOW - WALLET_FINALITY_S);
    // a wallet with a beacon ticket: its build reads the payout table
    let owner: Address | undefined;
    for (const w of WALLETS)
      if (!owner && appWallet(h, await walletKeys(w)).rows.some((r) => r.beacon)) owner = w;
    const view = await stats.wallet(owner!);
    expect(asked).toBe(1);
    expect(view.through).toBe(before);
  });

  it("stops holding `through` back for a listed transaction the RPC keeps failing to return", async () => {
    const h = await walletHistory(89, 20);
    const { stats, state, tick } = statsOver(h);
    for (let i = 0; i < 40 && (await tick()); i++);
    const caught = (await stats.wallet(WALLETS[0])).through!;
    state.storage.sql.exec(
      "INSERT INTO backlog (signature, round, idx, block_time) VALUES (?, 1, 0, ?)",
      sig(77_777),
      NOW - DAY,
    );
    const failures = (tries: number) =>
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO failures (signature, tries, retry_at) VALUES (?, ?, ?)",
        sig(77_777),
        tries,
        now + 3_600_000,
      );
    // set aside, still read again soon: it holds `through` back
    failures(5);
    now += 11_000;
    expect((await stats.wallet(WALLETS[0])).through).toBe(NOW - DAY - 1);
    // given up on for the wallets: `through` goes past it
    failures(6);
    now += 11_000;
    const view = await stats.wallet(WALLETS[0]);
    expect(view.through).toBeGreaterThanOrEqual(caught);
    expect(view.syncing).toBe(false);
  });

  it("follows the Queue for the providers before the wallets' replay takes a tick", async () => {
    const h = await walletHistory(90, 10);
    const { stats, tick } = statsOver(h);
    for (let i = 0; i < 40 && (await tick()); i++);
    const o = stats as unknown as {
      providersAskedAt: number;
      followLp(): Promise<boolean>;
      walletReplay(): Promise<boolean>;
    };
    o.providersAskedAt = now;
    const lp = vi.spyOn(o, "followLp").mockResolvedValue(true);
    const replay = vi.spyOn(o, "walletReplay").mockResolvedValue(true);
    expect(await tick()).toBe(true);
    expect(lp).toHaveBeenCalledTimes(1);
    expect(replay).not.toHaveBeenCalled();
    // the Queue read: the replay takes the tick
    lp.mockResolvedValue(false);
    await tick();
    expect(replay).toHaveBeenCalledTimes(1);
  });
});

describe("GET /v1/wallet/:address", () => {
  const view = { owner: "x" };
  const env = (success: boolean) => ({
    STATS: { idFromName: () => "stats", get: () => ({ wallet: async () => view }) },
    RATE_LIMITER: { limit: async () => ({ success }) },
  });
  const get = (path: string, ok = true) =>
    worker.fetch(new Request(`https://api.fade.finance${path}`), env(ok));

  it("serves the wallet's answer to any origin, cached 15 s, rate-limited per IP", async () => {
    const res = await get(`/v1/wallet/${WALLETS[0]}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=15");
    expect(await res.json()).toEqual(view);
    expect((await get(`/v1/wallet/${WALLETS[0]}`, false)).status).toBe(429);
    // base58 of the right length that is not 32 bytes
    expect((await get(`/v1/wallet/${"1".repeat(44)}`)).status).toBe(400);
    expect((await get("/v1/wallet/not-an-address")).status).toBe(404);
  });
});

// The beneficiary rules, read on a hand-made history: the wallet's own tickets, another app's
// for it, its app's for a customer; never a stranger's.
describe("the wallet's tickets", () => {
  it("are those its app opened and those paying out to it or to its USDC account", async () => {
    const w = await walletKeys(WALLETS[2]);
    const at = NOW - DAY;
    const h: HistoryTx[] = [
      [ev.opened(A("mine"), w.integrator, w.usdcAccount, USDC, 2n * USDC)],
      [ev.opened(A("for-me"), A("App"), w.owner, USDC, 2n * USDC)],
      [ev.joined(A("customer"), w.integrator, A("customerUsdc"), A("customerUsdc"), USDC)],
      [ev.joined(A("refunded"), A("App"), w.usdcAccount, A("FunderUsdc"), USDC)],
      [ev.returned(A("refunded"), true, false)],
      [ev.opened(A("stranger"), A("App"), A("strangerUsdc"), USDC, 2n * USDC)],
    ].map((datas, i) => ({ signature: sig(i + 1), at: at + i, tx: eventTx(...datas) }));
    const { stats, tick } = statsOver(h);
    for (let i = 0; i < 20 && (await tick()); i++);
    const { k } = await expectSameAsApp(stats, h, w.owner);
    expect(k.tickets.rows.map((r) => r.ticket)).toEqual([
      A("refunded"),
      A("customer"),
      A("for-me"),
      A("mine"),
    ]);
    const refunded = k.tickets.rows[0]!;
    expect(refunded.end).toMatchObject({ kind: "expired", refunded: true });
    expect(refunded.beacon!.refundTo).toBe(A("FunderUsdc"));
    expect(refunded.marginBps).toBe(220n);
    expect(k.tickets.totals.buyer).toEqual({ draws: 3, wins: 0, won: 0n, spent: 2n * USDC });
    expect(k.tickets.totals.app).toMatchObject({ tickets: 2 });
  });
});
