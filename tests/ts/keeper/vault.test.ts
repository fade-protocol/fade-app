// The vault page's public history as the keeper serves it (GET /v1/vault and GET /v1/feed,
// apps/keeper/src/vaultIndex.ts and the Stats Durable Object, stats.ts): the events it records,
// the answers equal to the app's own arithmetic and ticket rows over the same transactions,
// whatever the order they are read in, the closes kept for every lookup the app makes, the
// one-time replay an index that recorded the APR alone runs (the APR served meanwhile, and each
// part of the views syncing until it is read), and the views falling back to the app once the
// loop stops reading the program. The Durable Object runs over SQLite in memory and a scripted
// RPC.
import { DatabaseSync } from "node:sqlite";
import { getBase58Decoder, type Address, type Signature } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findConfigPda,
  findIntegratorPda,
  findVaultPda,
  getConfigDecoder,
  getConfigEncoder,
  getConfigSize,
  getDepositRequestedEventEncoder,
  getEpochStruckEventEncoder,
  getIntegratorDecoder,
  getIntegratorEncoder,
  getIntegratorSize,
  getPayoutTableDecoder,
  getPayoutTableEncoder,
  getPayoutTableSize,
  getRoundPayoutClaimedEventEncoder,
  getRoundTicketReturnedEventEncoder,
  getRoundTicketSettledEventEncoder,
  getTicketExpiredEventEncoder,
  getTicketJoinedEventEncoder,
  getTicketOpenedEventEncoder,
  getTicketSettledEventEncoder,
  getVaultDecoder,
  getVaultEncoder,
  getVaultSize,
  getWithdrawRequestedEventEncoder,
} from "../../../clients/js/src/generated/fade/index.ts";
import type { AprView } from "../../../apps/keeper/src/aprIndex.ts";
import { EVENT_IX_TAG, PROGRAM, cfg } from "../../../apps/keeper/src/chain.ts";
import {
  FEED_REQUESTS,
  FEED_TICKETS,
  INDEX_FRESH_S,
  RECORDED_EVENTS_VERSION,
  SERIES_DAYS,
  vaultEventsOf,
  vaultView,
  viewTicketOf,
  type FeedView,
  type StoredVaultTicket,
  type VaultView,
} from "../../../apps/keeper/src/vaultIndex.ts";
import { eventsOf, type FadeEvent } from "../../../apps/web/src/lib/events.ts";
import { strikeSeries, type LpItem } from "../../../apps/web/src/lib/history.ts";
import { parseKeeperFeed, parseKeeperVault } from "../../../apps/web/src/lib/keeperViews.ts";
import { BPS, P_SCALE } from "../../../apps/web/src/lib/math.ts";
import {
  statsByApp,
  ticketLogOf,
  withBeaconMargins,
  type TicketLog,
} from "../../../apps/web/src/lib/ticketLog.ts";
import { vaultLine } from "../../../apps/web/src/lib/ticketWords.ts";
import { priceAt } from "../../../apps/web/src/lib/positionPnl.ts";
import { activityFigures, chartView } from "../../../apps/web/src/lib/vaultFigures.ts";
import {
  activityTickets,
  afterStrike,
  thinStrikes,
  volumeSums,
} from "../../../apps/web/src/lib/vaultViews.ts";
import { rng } from "../web/fixtures.ts";

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

type StatsObject = {
  apr(): Promise<AprView>;
  vault(): Promise<VaultView>;
  feed(): Promise<FeedView>;
  alarm(): Promise<void>;
};
// Imported by a computed path: the Workers types it needs are the keeper's own typecheck's.
const STATS_MODULE = "../../../apps/keeper/src/stats.ts";
const { Stats } = (await import(STATS_MODULE)) as {
  Stats: new (ctx: unknown, env: unknown) => StatsObject;
};

const alarms: number[] = [];
function memoryState(db = new DatabaseSync(":memory:")) {
  const sql = {
    exec: (q: string, ...b: (string | number | null)[]) => {
      const rows = db.prepare(q).all(...b);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
  return {
    storage: {
      sql,
      transactionSync: <T>(fn: () => T) => fn(),
      getAlarm: async () => null,
      setAlarm: async (t: number) => {
        alarms.push(t);
      },
    },
  };
}

const HOUR = 3_600;
const DAY = 86_400;
const NOW = 1_800_000_000;
const USDC = 1_000_000n;
const b58 = (bytes: ArrayLike<number>) => getBase58Decoder().decode(Uint8Array.from(bytes));
const A = (s: string) =>
  b58(Array.from({ length: 32 }, (_, i) => s.charCodeAt(i % s.length) + i)) as Address;
const sig = (n: number) =>
  b58(Array.from({ length: 64 }, (_, i) => (i < 4 ? (n >> (i * 8)) & 255 : (i * 7 + 3) % 256)));
const emitted = (body: ArrayLike<number>) => b58([...EVENT_IX_TAG, ...Array.from(body)]);
const THIRD_APP = A("AppThreeKey");
const [THIRD_INTEGRATOR] = await findIntegratorPda({ integratorAuthority: THIRD_APP }, cfg);

type Tx = ReturnType<typeof eventTx>;
/** A transaction of the program emitting `datas`. */
const eventTx = (...datas: string[]) => ({
  meta: {
    err: null,
    innerInstructions: [{ instructions: datas.map((data) => ({ programIdIndex: 1, data })) }],
  },
  transaction: {
    message: { accountKeys: [A("Payer"), PROGRAM] },
  },
});

const ROUND = A("Round");
const opened = (ticket: Address, integrator: Address, price: bigint, payoutMax: bigint) =>
  emitted(
    getTicketOpenedEventEncoder().encode({
      version: 1,
      ticket,
      integrator,
      nonce: 1,
      beneficiary: A("Ben"),
      price,
      vaultCredit: price - (price * 20n) / BPS,
      payoutMax,
      reservedLiability: payoutMax,
      cap: payoutMax,
      marginBps: 350n,
      appShareBps: 50n,
      openSlot: 10,
    }),
  );
const joined = (ticket: Address, integrator: Address, price: bigint, table: Address) =>
  emitted(
    getTicketJoinedEventEncoder().encode({
      version: 1,
      ticket,
      round: ROUND,
      integrator,
      nonce: 1,
      beneficiary: A("Ben"),
      refundTo: A("Ben"),
      payoutTable: table,
      price,
      vaultCredit: price - 700n,
      payoutMax: price * 2n,
      reservedLiability: price,
      cap: price,
      usage: price,
      protocolShare: 200n,
      appShare: 500n,
      prepay: 5_000,
      slot: 10,
      payer: A("Payer"),
      funder: A("Payer"),
      settleShare: 2_000,
    }),
  );
const settled = (ticket: Address, integrator: Address, payout: bigint, pending: boolean) =>
  emitted(
    getTicketSettledEventEncoder().encode({
      version: 1,
      ticket,
      integrator,
      outcome: payout > 0n ? 0 : 1,
      payout,
      pending,
    }),
  );
const roundSettled = (ticket: Address, integrator: Address, payout: bigint, pending: boolean) =>
  emitted(
    getRoundTicketSettledEventEncoder().encode({
      version: 1,
      ticket,
      round: ROUND,
      integrator,
      outcome: payout > 0n ? 0 : 1,
      payout,
      charge: 1_000n,
      pending,
    }),
  );
const expired = (ticket: Address, integrator: Address) =>
  emitted(
    getTicketExpiredEventEncoder().encode({
      version: 2,
      ticket,
      integrator,
      forfeited: 0n,
      requested: false,
      requestFound: false,
      checked: true,
      pending: false,
      refunded: false,
      refund: 0n,
      parked: false,
      ticketForfeitsWithheld: 0n,
    }),
  );
const returned = (ticket: Address, refunded: boolean, parked: boolean) =>
  emitted(
    getRoundTicketReturnedEventEncoder().encode({
      version: 1,
      ticket,
      round: ROUND,
      refunded,
      price: 100_000,
      lamports: 5_000,
      parked,
      charge: 0,
    }),
  );
const claimed = (ticket: Address) =>
  emitted(
    getRoundPayoutClaimedEventEncoder().encode({
      version: 1,
      ticket,
      destination: A("Ben"),
      amount: 1n,
    }),
  );
const struck = (epochId: bigint, totalAssets: bigint, deposits: bigint, assetsPaid: bigint) =>
  emitted(
    getEpochStruckEventEncoder().encode({
      version: 1,
      epochId,
      totalAssets,
      totalShares: 1_000n * 1_000_000_000n,
      deposits,
      sharesMinted: 3n * 1_000_000_000n,
      withdrawShares: 0n,
      assetsOwed: assetsPaid,
      assetsPaid,
      sharesBurnt: 1_000_000_000n,
      reward: 0n,
    }),
  );
const deposit = (owner: Address, amount: bigint) =>
  emitted(getDepositRequestedEventEncoder().encode({ version: 1, owner, epochId: 1n, amount }));
const withdrawal = (owner: Address, shares: bigint) =>
  emitted(getWithdrawRequestedEventEncoder().encode({ version: 1, owner, epochId: 1n, shares }));

/** `Σ p·m` of a payout table whose margin is `bps`. */
const lhsFor = (bps: bigint) => (BPS - bps) * P_SCALE;
const TABLE = A("Table");
const UNREAD_TABLE = A("Unread");
const APPS = [A("AppOne"), A("AppTwo"), THIRD_INTEGRATOR] as const;

type HistoryTx = { signature: string; at: number; tx: Tx };

/**
 * A random history over the last 10 days, oldest first: tickets of both paths and three apps
 * opened, drawn, won, expired, forfeited or refunded, some of their
 * payouts parked and claimed, closes every few hours, and deposit and withdrawal requests.
 */
function history(seed: number, tickets = 80): HistoryTx[] {
  const r = rng(seed);
  const out: HistoryTx[] = [];
  let n = 0;
  const push = (at: number, ...datas: string[]) =>
    out.push({ signature: sig(++n), at, tx: eventTx(...datas) });
  for (let i = 0; i < tickets; i++) {
    const ticket = A(`ticket${seed}-${i}`);
    const app = APPS[r.int(3)]!;
    const at = NOW - 10 * DAY + r.int(10 * DAY - HOUR);
    const price = r.big(10_000n, 20n * USDC);
    const beacon = r.int(3) === 0;
    const end = at + 5 + r.int(600);
    if (beacon) {
      push(at, joined(ticket, app, price, r.int(4) === 0 ? UNREAD_TABLE : TABLE));
      const k = r.int(6);
      if (k === 0) continue; // still drawing
      if (k === 1) push(end, returned(ticket, true, r.int(2) === 0));
      else if (k === 2) push(end, returned(ticket, false, false));
      else {
        const payout = k === 3 ? price * 2n : 0n;
        const parked = payout > 0n && r.int(2) === 0;
        push(end, roundSettled(ticket, app, payout, parked));
        if (parked && r.int(2) === 0) push(end + 30, claimed(ticket));
      }
    } else {
      const payoutMax = price * BigInt(2 + r.int(40));
      push(at, opened(ticket, app, price, payoutMax));
      const k = r.int(6);
      if (k === 0) continue;
      if (k === 1) push(end, expired(ticket, app));
      else push(end, settled(ticket, app, k === 2 ? payoutMax : 0n, false));
    }
  }
  for (let t = NOW - 10 * DAY + r.int(HOUR); t < NOW; t += HOUR * (1 + r.int(5))) {
    const datas = [
      struck(
        BigInt(t),
        r.big(1_000n * USDC, 2_000n * USDC),
        r.big(0n, 50n * USDC),
        r.big(0n, 30n * USDC),
      ),
    ];
    if (r.int(3) === 0) datas.unshift(deposit(A("Lp"), r.big(USDC, 100n * USDC)));
    if (r.int(4) === 0) datas.unshift(withdrawal(A("Lp"), r.big(1n, 10n) * 1_000_000_000n));
    push(t, ...datas);
  }
  return out.sort((a, b) => a.at - b.at || a.signature.localeCompare(b.signature));
}

/** The app's own reads of the same transactions: its ticket rows and the vault's history. */
function appReads(h: readonly HistoryTx[]) {
  const newest = [...h].reverse();
  const sigs = newest.map((x) => ({ signature: x.signature as Signature, blockTime: x.at }));
  const known = new Map(
    newest.map((x) => {
      return [
        x.signature as Signature,
        { events: eventsOf({ ...x.tx, slot: 1n } as never) },
      ] as const;
    }),
  );
  const log: TicketLog = withBeaconMargins(
    ticketLogOf(sigs, known, Infinity, 0),
    new Map([[TABLE, lhsFor(220n)]]),
  );
  const LP = new Set<FadeEvent["kind"]>(["DepositRequested", "WithdrawRequested", "EpochStruck"]);
  const items: LpItem[] = newest.flatMap((x) => {
    const events = known.get(x.signature as Signature)!.events.filter((e) => LP.has(e.kind));
    return events.length ? [{ signature: x.signature as Signature, blockTime: x.at, events }] : [];
  });
  return { log, items };
}

const base64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
async function liveAccounts() {
  const [[config], [vault]] = await Promise.all([findConfigPda(cfg), findVaultPda(cfg)]);
  const zeroConfig = getConfigDecoder().decode(new Uint8Array(getConfigSize()));
  const zeroVault = getVaultDecoder().decode(new Uint8Array(getVaultSize()));
  const zeroTable = getPayoutTableDecoder().decode(new Uint8Array(getPayoutTableSize()));
  const zeroIntegrator = getIntegratorDecoder().decode(new Uint8Array(getIntegratorSize()));
  const account = (data: ArrayLike<number>) => ({
    data: [base64(Uint8Array.from(data)), "base64"],
    owner: PROGRAM,
    lamports: 1n,
    executable: false,
    space: 0n,
  });
  return new Map<string, ReturnType<typeof account>>([
    [
      config,
      account(
        getConfigEncoder().encode({
          ...zeroConfig,
          params: { ...zeroConfig.params, protocolShareBps: 20n },
        }),
      ),
    ],
    [vault, account(getVaultEncoder().encode({ ...zeroVault, totalAssets: 2_000n * USDC }))],
    [TABLE, account(getPayoutTableEncoder().encode({ ...zeroTable, lhs: lhsFor(220n) }))],
    ...APPS.map(
      (app) =>
        [
          app,
          account(
            getIntegratorEncoder().encode({
              ...zeroIntegrator,
              authority: app === THIRD_INTEGRATOR ? THIRD_APP : A(`key-${app}`),
            }),
          ),
        ] as const,
    ),
  ]);
}

/** A Stats Durable Object reading `h` through a scripted RPC; `reads` lists each transaction read. */
async function statsOver(h: readonly HistoryTx[], listed = h) {
  const live = await liveAccounts();
  const reads: string[] = [];
  const byAt = [...listed].reverse();
  const rpc = {
    getSignaturesForAddress: (_p: unknown, o: { until?: string; before?: string }) => ({
      send: async () => {
        let list = byAt;
        if (o.before !== undefined)
          list = list.slice(list.findIndex((x) => x.signature === o.before) + 1);
        if (o.until !== undefined)
          list = list.slice(
            0,
            list.findIndex((x) => x.signature === o.until),
          );
        return list.slice(0, 1_000).map((x) => ({
          signature: x.signature,
          err: null,
          blockTime: BigInt(x.at),
        }));
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
      send: async () => ({ value: list.map((a) => live.get(a) ?? null) }),
    }),
  };
  const state = memoryState();
  const stats = new Stats(state, { RPC_URL: "http://localhost:0" });
  (stats as unknown as { rpc: unknown }).rpc = rpc;
  const tick = () => (stats as unknown as { tick(): Promise<boolean> }).tick();
  return { stats, state, tick, reads };
}

/** The keeper's answers as the app reads them, against the app's own over the same history. */
async function expectSameAsApp(stats: StatsObject, h: readonly HistoryTx[]) {
  const { log, items } = appReads(h);
  const vault = await stats.vault();
  expect(vault.syncing).toBe(false);
  expect(vault.seriesSyncing).toBe(false);
  const parsed = parseKeeperVault(JSON.parse(JSON.stringify(vault)))!;
  expect(parsed).not.toBeNull();

  // each app over the last 7 days, named from its integrator record
  const own = statsByApp({ rows: log.rows.filter((r) => r.openedAt! >= NOW - 7 * DAY) });
  expect(parsed.apps.length).toBe(own.size);
  for (const a of parsed.apps) {
    const s = own.get(a.integrator)!;
    expect(a).toEqual({
      integrator: a.integrator,
      authority: a.integrator === THIRD_INTEGRATOR ? THIRD_APP : A(`key-${a.integrator}`),
      tickets: s.tickets,
      volume: s.volume,
      result: s.result,
      settled: s.settled,
    });
  }
  expect(parsed.apps.map((a) => a.volume)).toEqual(
    [...parsed.apps.map((a) => a.volume)].sort((x, y) => (x > y ? -1 : x < y ? 1 : 0)),
  );

  // the Activity tab's 24 h
  const f = activityFigures(log, items, NOW);
  expect(parsed.activity).toEqual({ n: f.n, paid: f.paid, result: f.result, net: f.net });

  // the closes as the chart reads them (the live point is the app's), and the hourly volume
  const empty = { totalAssets: 0n, openVaultCredits: 0n, totalShares: 0n } as never;
  const closes = strikeSeries(items, empty, NOW).filter((p) => p.epochId !== null);
  const withdrawalsAt = items
    .filter((x) => x.events.some((e) => e.kind === "WithdrawRequested"))
    .map((x) => x.blockTime!);
  expect(parsed.strikes).toEqual(thinStrikes(closes, NOW, withdrawalsAt));
  const first = Math.min(...log.rows.map((r) => r.openedAt!));
  expect(parsed.volume.from).toBe(
    Math.max(Math.floor(first / HOUR) * HOUR, Math.floor((NOW - SERIES_DAYS * DAY) / HOUR) * HOUR),
  );
  expect(parsed.volume.sums).toEqual(volumeSums(log, parsed.volume.from, NOW, HOUR));

  // the feed: the same rows the app builds, each told in the same words
  const feed = parseKeeperFeed(JSON.parse(JSON.stringify(await stats.feed())))!;
  expect(feed.syncing).toBe(false);
  expect(feed.requestsSyncing).toBe(false);
  expect(feed.loneEnds).toEqual([]);
  const appRows = new Map(log.rows.map((r) => [r.ticket, r] as const));
  expect(feed.rows.length).toBe(Math.min(FEED_TICKETS, appRows.size));
  const lastOf = (r: { openedAt: number | null; end: { at: number | null } | null }) =>
    Math.max(r.openedAt ?? 0, r.end?.at ?? 0);
  for (let i = 1; i < feed.rows.length; i++)
    expect(lastOf(feed.rows[i - 1]!)).toBeGreaterThanOrEqual(lastOf(feed.rows[i]!));
  for (const row of feed.rows) {
    const app = appRows.get(row.ticket)!;
    expect(row).toEqual({
      ticket: app.ticket,
      price: app.price,
      payoutMax: app.payoutMax,
      vaultCredit: app.vaultCredit,
      marginBps: app.marginBps,
      openedAt: app.openedAt,
      openSig: app.openSig,
      end: app.end && {
        kind: app.end.kind,
        payout: app.end.payout,
        pending: app.end.pending,
        ...(app.end.refunded ? { refunded: true } : {}),
        at: app.end.at,
        signature: app.end.signature,
      },
      ...(app.beacon ? { beacon: true } : {}),
    });
    expect(vaultLine(row, false)).toEqual(vaultLine(app, false));
  }
  // the requests, newest first
  const said = (r: { kind: string; at: number | null; amount?: bigint; shares?: bigint }) =>
    `${r.kind} ${r.at} ${r.amount ?? r.shares}`;
  const requests = items.flatMap((x) =>
    x.events.flatMap((e) =>
      e.kind === "DepositRequested"
        ? [said({ kind: "deposit", amount: e.data.amount, at: x.blockTime })]
        : e.kind === "WithdrawRequested"
          ? [said({ kind: "withdrawal", shares: e.data.shares, at: x.blockTime })]
          : [],
    ),
  );
  expect(feed.requests.map(said)).toEqual(requests.slice(0, feed.requests.length));
  expect(feed.requests.length).toBe(Math.min(FEED_REQUESTS, requests.length));
  return { vault, feed };
}

describe("the vault views' events", () => {
  it("reads both paths' openings and ends, the claims, the closes and the requests", () => {
    const [d, b] = [A("D"), A("B")];
    const app = A("App");
    const events = vaultEventsOf(
      eventTx(
        opened(d, app, USDC, 20n * USDC),
        joined(b, app, USDC / 10n, TABLE),
        settled(d, app, 0n, false),
        roundSettled(b, app, 200_000n, true),
        expired(d, app),
        returned(b, true, true),
        claimed(b),
        struck(4n, 1_000n * USDC, 50n * USDC, 20n * USDC),
        deposit(A("Lp"), 5n * USDC),
        withdrawal(A("Lp"), 2n),
      ),
      PROGRAM,
    );
    expect(events.map((e) => e.kind)).toEqual([
      "opened",
      "joined",
      "settled",
      "settled",
      "expired",
      "returned",
      "claimed",
      "struck",
      "deposit",
      "withdrawal",
    ]);
    expect(events[0]).toMatchObject({
      ticket: d,
      integrator: app,
      price: USDC,
      payoutMax: 20n * USDC,
    });
    expect(events[1]).toMatchObject({
      ticket: b,
      integrator: app,
      payoutTable: TABLE,
      appShare: 500n,
    });
    expect(events[3]).toMatchObject({ payout: 200_000n, pending: true, beacon: true });
    expect(events[5]).toEqual({ kind: "returned", ticket: b, refunded: true, parked: true });
    expect(events[7]).toMatchObject({ epochId: 4n, deposits: 50n * USDC, assetsPaid: 20n * USDC });
    expect(events[9]).toEqual({ kind: "withdrawal", shares: 2n });
    // another program's inner instructions say nothing
    expect(vaultEventsOf(eventTx(opened(d, app, USDC, 2n * USDC)), A("Other"))).toEqual([]);
  });

  it("tells the shared figures a direct ticket's credit back from a payout", () => {
    const stored = (
      ticket: string,
      payout: bigint,
      creditReturned: boolean,
    ): StoredVaultTicket => ({
      ticket: A(ticket),
      integrator: A("App"),
      beacon: false,
      opened: {
        at: 1_000,
        signature: "o",
        price: 1_000_000n,
        payoutMax: 10_000_000n,
        vaultCredit: 950_000n,
        marginBps: 500n,
        appShareBps: 0n,
        payoutTable: null,
        appShare: 0n,
      },
      end: {
        kind: creditReturned ? "expired" : "settled",
        payout,
        pending: false,
        refunded: false,
        creditReturned,
        at: 2_000,
        signature: "e",
      },
      claimed: false,
    });
    const rows = [stored("Back", 950_000n, true), stored("Won", 3_000_000n, false)].map((t) =>
      viewTicketOf(t)!,
    );
    expect(rows[0]!.end).toMatchObject({ payout: 950_000n, creditReturned: true });
    // no draw ran for the credit back: nobody was paid, and the vault kept nothing of it
    expect(activityTickets(rows.slice(0, 1), 0)).toEqual({ n: 1, paid: 0n, result: 0n });
    expect(activityTickets(rows, 0)).toEqual({
      n: 2,
      paid: 3_000_000n,
      result: 950_000n - 3_000_000n,
    });
    const s = statsByApp({ rows }).get(A("App"))!;
    expect(s.paidOut).toBe(3_000_000n);
    expect(s.result).toBe(950_000n - 3_000_000n);
  });
});

describe("the vault views' answers", () => {
  it("keeps every close of the last day, and before it the last of each hour", () => {
    const ticket = (at: number): StoredVaultTicket => ({
      ticket: A(`t${at}`),
      integrator: A("App"),
      beacon: false,
      opened: {
        at,
        signature: "s",
        price: USDC,
        payoutMax: 2n * USDC,
        vaultCredit: USDC,
        marginBps: 350n,
        appShareBps: 0n,
        payoutTable: null,
        appShare: 0n,
      },
      end: null,
      claimed: false,
    });
    // a close every 10 minutes over 40 days
    const strikes = Array.from({ length: 40 * 144 }, (_, i) => ({
      t: NOW - 40 * DAY + i * 600 + 60,
      epochId: BigInt(i),
      totalAssets: 1_000n * USDC + BigInt(i),
      totalShares: 1_000n * 1_000_000_000n,
      deposits: 0n,
      sharesMinted: 0n,
      assetsPaid: 0n,
      sharesBurnt: 0n,
    }));
    const view = vaultView({
      tickets: [ticket(NOW - 3 * DAY + 10), ticket(NOW - 10)],
      strikes,
      authorities: new Map(),
      now: NOW,
      coveredFrom: 0,
      caughtUp: true,
      currentAt: NOW,
      withdrawalsAt: [],
    });
    const ts = view.series.strikes.map((p) => p.t);
    const lastDay = ts.filter((t) => t >= NOW - DAY);
    expect(lastDay.length).toBe(144);
    // hourly before the last day, from the close before the 30 days on, but around the starts
    // of the 7D and 1M ranges and the hour before the day, where every close is kept
    const older = ts.filter((t) => t < NOW - DAY);
    expect(older[0]).toBeLessThan(NOW - SERIES_DAYS * DAY);
    const nearStart = (t: number) =>
      [DAY, 7 * DAY, 30 * DAY].some((r) => t >= NOW - r - 2 * HOUR && t < NOW - r + 2 * HOUR);
    const hourly = older.filter((t) => !nearStart(t));
    expect(
      hourly.slice(1).every((t, i) => Math.floor(t / HOUR) !== Math.floor(hourly[i]! / HOUR)),
    ).toBe(true);
    expect(older.length).toBeLessThanOrEqual(SERIES_DAYS * 24 + 1 + 3 * 4 * 6);
    // the volume from the first ticket's hour, an hour a bucket, the last to now
    expect(view.series.volume.from).toBe(Math.floor((NOW - 3 * DAY + 10) / HOUR) * HOUR);
    expect(view.series.volume.sums.length).toBe(3 * 24);
    expect(view.series.volume.sums[0]).toBe(String(USDC));
    expect(view.series.volume.sums.at(-1)).toBe(String(USDC));
    expect(view.syncing).toBe(false);
  });

  it("says it is syncing, and counts from where it reached, while the last 7 days are not read", () => {
    // a ticket three days back: the volume would start at its hour if the history were covered
    const old: StoredVaultTicket = {
      ticket: A("old"),
      integrator: A("App"),
      beacon: false,
      opened: {
        at: NOW - 3 * DAY,
        signature: "s",
        price: USDC,
        payoutMax: 2n * USDC,
        vaultCredit: USDC,
        marginBps: 350n,
        appShareBps: 0n,
        payoutTable: null,
        appShare: 0n,
      },
      end: null,
      claimed: false,
    };
    const input = {
      tickets: [old],
      strikes: [],
      authorities: new Map(),
      now: NOW,
      caughtUp: true,
      currentAt: NOW - 20,
      withdrawalsAt: [],
    };
    const partial = vaultView({ ...input, coveredFrom: NOW - DAY - 1_800 });
    expect(partial.syncing).toBe(true);
    expect(partial.seriesSyncing).toBe(true);
    expect(partial.coveredFrom).toBe(NOW - DAY - 1_800);
    expect(partial.series.volume.from).toBe(Math.ceil((NOW - DAY - 1_800) / HOUR) * HOUR);
    expect(vaultView({ ...input, coveredFrom: Infinity })).toMatchObject({
      syncing: true,
      coveredFrom: null,
    });
    // the 7 days read: the per-app figures complete, the 30-day series not yet
    expect(vaultView({ ...input, coveredFrom: NOW - 8 * DAY })).toMatchObject({
      syncing: false,
      seriesSyncing: true,
    });
    expect(vaultView({ ...input, coveredFrom: NOW - SERIES_DAYS * DAY })).toMatchObject({
      syncing: false,
      seriesSyncing: false,
    });
    expect(vaultView({ ...input, coveredFrom: 0, caughtUp: false }).syncing).toBe(true);
    // the loop stopped reading the program: every part syncing, so the app reads its own
    expect(
      vaultView({ ...input, coveredFrom: 0, currentAt: NOW - INDEX_FRESH_S - 1 }),
    ).toMatchObject({ syncing: true, seriesSyncing: true });
    expect(vaultView({ ...input, coveredFrom: 0, currentAt: null }).syncing).toBe(true);
    expect(vaultView({ ...input, coveredFrom: 0, currentAt: NOW - INDEX_FRESH_S }).syncing).toBe(
      false,
    );
  });

  it("keeps every close the app looks up: each range's start whatever its clock, each withdrawal", () => {
    const r = rng(41);
    // a close every few minutes over 40 days, the price moving at each
    const strikes: Parameters<typeof vaultView>[0]["strikes"][number][] = [];
    for (let t = NOW - 40 * DAY + r.int(600), i = 0; t < NOW; t += 60 + r.int(900), i++)
      strikes.push({
        t,
        epochId: BigInt(i),
        totalAssets: r.big(1_000n * USDC, 2_000n * USDC),
        totalShares: 1_000n * 1_000_000_000n,
        deposits: r.big(0n, 10n * USDC),
        sharesMinted: 0n,
        assetsPaid: 0n,
        sharesBurnt: 0n,
      });
    // withdrawals over the 31 days the feed reaches back, the day before the series' lead among
    // them, and on each side of its start
    const withdrawalsAt = [
      NOW - 31 * DAY,
      NOW - 30.9 * DAY,
      NOW - 30.5 * DAY,
      NOW - 30 * DAY - 2 * HOUR - 1,
      NOW - 30 * DAY - 2 * HOUR,
      NOW - 30 * DAY - HOUR,
      NOW - 30 * DAY,
      NOW - 29.5 * DAY,
      NOW - 14 * DAY,
      NOW - 7 * DAY - 5,
      NOW - 3 * DAY,
      NOW - 2 * HOUR,
      NOW - 90,
    ];
    const served = vaultView({
      tickets: [],
      strikes,
      authorities: new Map(),
      now: NOW,
      coveredFrom: 0,
      caughtUp: true,
      currentAt: NOW,
      withdrawalsAt,
    });
    const parsed = parseKeeperVault(JSON.parse(JSON.stringify(served)))!;
    // far fewer points than closes
    expect(parsed.strikes.length).toBeLessThan(strikes.length / 3);
    // the app's own series: every close, back from 30 days
    const all = strikes.flatMap((s) => {
      const { assets, price } = afterStrike(s);
      return price === null ? [] : [{ t: s.t, epochId: s.epochId, price, assets }];
    });
    const own = all;
    const live = { t: 0, price: 1_234_567n, assets: 1_500n * USDC, epochId: null };
    // the 7D and 1M change, the app's clock up to a minute behind the build or minutes after it
    for (const appNow of [NOW - 59, NOW, NOW + 60, NOW + 7 * 60, NOW + 1_800]) {
      const at = { ...live, t: appNow };
      for (const series of ["price", "deposits"] as const)
        for (const range of ["1D", "7D", "1M"] as const) {
          const keeper = chartView(series, range, [...parsed.strikes, at], null, appNow)!;
          const app = chartView(series, range, [...own, at], null, appNow)!;
          expect(keeper.change).toBe(app.change);
          expect(keeper.headline).toBe(app.headline);
        }
    }
    // each withdrawal valued at the close in force at its time, as over every close
    for (const t of withdrawalsAt) expect(priceAt(parsed.strikes, t)).toBe(priceAt(own, t));
  });
});

describe("the Stats Durable Object's vault views", () => {
  let now = NOW * 1_000;
  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    alarms.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    now = NOW * 1_000;
  });

  it("a new index serves what the app works out from the same transactions, read oldest first", async () => {
    const h = history(71);
    const { stats, tick, reads } = await statsOver(h);
    for (let i = 0; i < 60 && (await tick()); i++);
    expect(new Set(reads).size).toBe(h.length);
    await expectSameAsApp(stats, h);
  });

  it("serves the newest tickets by their last event, as many as the feed holds", async () => {
    const h = history(72, FEED_TICKETS + 40);
    const { stats, tick } = await statsOver(h);
    for (let i = 0; i < 80 && (await tick()); i++);
    const { feed } = await expectSameAsApp(stats, h);
    expect(feed.rows.length).toBe(FEED_TICKETS);
  });

  it("replays, once, newest first, what an index that recorded the APR alone read; the APR stays served", async () => {
    const h = history(73);
    const cursor = h.at(-1)!;
    const { stats, state, tick, reads } = await statsOver(h);
    const sql = state.storage.sql;
    // An index caught up to the newest transaction that recorded the APR (version 1) and its
    // whole history, and nothing of the vault views.
    for (const [k, v] of [
      ["cursor", cursor.signature],
      ["round", "1"],
      ["completed_round", "1"],
      ["caught_up", "1"],
      ["transactions", String(h.length)],
      ["events_version", "2"],
      ["apr_version", "1"],
      ["apr_covered", "0"],
      // it stores the wallets already: their replay (step 5) is tested on its own
      ["wallet_version", "1"],
      ["wallet_covered", "1"],
    ] as const)
      sql.exec("INSERT INTO meta (k, v) VALUES (?, ?)", k, v);

    // Before the replay: the vault views say they are syncing; the APR does not.
    expect((await stats.vault()).syncing).toBe(true);
    expect((await stats.apr()).syncing).toBe(false);
    // One tick lists it, the next ones read it newest first.
    await tick();
    await tick();
    expect(reads.slice(0, 5)).toEqual(
      [...h]
        .reverse()
        .slice(0, 5)
        .map((x) => x.signature),
    );
    expect((await stats.apr()).syncing).toBe(false);
    for (let i = 0; i < 20 && (await tick()); i++);
    expect(new Set(reads).size).toBe(h.length);
    // read newest first, every part of a ticket in its place: the same answers as the app's
    await expectSameAsApp(stats, h);
    const meta = (k: string) =>
      (sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0] as { v: string } | undefined)?.v;
    expect(meta("apr_version")).toBe(String(RECORDED_EVENTS_VERSION));
    expect(meta("apr_covered")).toBe("0");
    // the listing reached the deploy: the whole history is recorded
    expect(meta("views_covered")).toBe("0");
    // nothing read again on later ticks
    const n = reads.length;
    for (let i = 0; i < 3; i++) await tick();
    expect(reads.length).toBe(n);
  });

  it("says the requests are syncing while the replay has not reached those older than the tickets served", async () => {
    // one app's tickets over the last hours, and deposits and withdrawals over 10 days
    const h = history(75, 0);
    let n = 50_000;
    for (let i = 0; i < FEED_TICKETS + 40; i++)
      h.push({
        signature: sig(++n),
        at: NOW - 6 * HOUR + i * 60,
        tx: eventTx(opened(A(`t${i}`), THIRD_INTEGRATOR, USDC, 2n * USDC)),
      });
    h.sort((a, b) => a.at - b.at || a.signature.localeCompare(b.signature));
    const oldest = h.find((x) => vaultEventsOf(x.tx, PROGRAM).some((e) => e.kind === "deposit"))!;
    expect(oldest.at).toBeLessThan(NOW - 2 * DAY);
    const { stats, state, tick, reads } = await statsOver(h);
    for (const [k, v] of [
      ["cursor", h.at(-1)!.signature],
      ["round", "1"],
      ["completed_round", "1"],
      ["caught_up", "1"],
      ["transactions", String(h.length)],
      ["events_version", "2"],
      ["apr_version", "1"],
      ["apr_covered", "0"],
      // it stores the wallets already: their replay (step 5) is tested on its own
      ["wallet_version", "1"],
      ["wallet_covered", "1"],
    ] as const)
      state.storage.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?)", k, v);
    const build = () =>
      (stats as unknown as { buildFeed(): Promise<FeedView> }).buildFeed().then((f) => f);
    await stats.vault();
    let ticketsDoneFirst = false;
    for (let i = 0; i < 40; i++) {
      const busy = await tick();
      const feed = await build();
      const replayed = reads.includes(oldest.signature);
      // the tickets served are read long before the oldest deposit is
      if (!feed.syncing && !replayed) {
        ticketsDoneFirst = true;
        expect(feed.requestsSyncing).toBe(true);
      }
      // complete only once every request it reaches back to is read
      if (!feed.requestsSyncing) expect(replayed).toBe(true);
      if (!busy) break;
    }
    expect(ticketsDoneFirst).toBe(true);
    expect(new Set(reads).size).toBe(h.length);
    const { feed } = await expectSameAsApp(stats, h);
    expect(feed.requests.at(-1)!.at).toBe(Math.min(...feed.requests.map((r) => r.at!)));
  });

  it("says every part is syncing once the loop has not read the program for a while", async () => {
    const h = history(76, 20);
    const { stats, tick } = await statsOver(h);
    for (let i = 0; i < 20 && (await tick()); i++);
    const built = () => {
      const o = stats as unknown as {
        buildVault(): Promise<VaultView>;
        buildFeed(): Promise<FeedView>;
      };
      return Promise.all([o.buildVault(), o.buildFeed()]);
    };
    let [vault, feed] = await built();
    expect([vault.syncing, vault.seriesSyncing, feed.syncing, feed.requestsSyncing]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // the RPC down: every tick fails, the index stays caught up but stops reading
    (
      stats as unknown as { rpc: { getSignaturesForAddress: unknown } }
    ).rpc.getSignaturesForAddress = () => ({
      send: async () => {
        throw new Error("rpc down");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    now += INDEX_FRESH_S * 1_000;
    await stats.alarm();
    [vault, feed] = await built();
    expect(vault.syncing || feed.syncing).toBe(false);
    now += 1_000;
    await stats.alarm();
    [vault, feed] = await built();
    expect([vault.syncing, vault.seriesSyncing, feed.syncing, feed.requestsSyncing]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("builds the feed at most every 5 s, and follows the program faster while it is asked for", async () => {
    const h = history(74, 20);
    const { stats, tick } = await statsOver(h);
    for (let i = 0; i < 20 && (await tick()); i++);
    await stats.alarm();
    // nobody asked for the feed: the loop waits 60 s once caught up
    expect(alarms.at(-1)).toBe(now + 60_000);
    const first = await stats.feed();
    await stats.alarm();
    expect(alarms.at(-1)).toBe(now + 20_000);
    // a new ticket recorded: within 5 s the kept answer is served
    const extra = {
      signature: sig(9_999),
      at: NOW - 30,
      tx: eventTx(opened(A("late"), APPS[0], USDC, 2n * USDC)),
    };
    (stats as unknown as { recordViews(s: string, e: unknown[], at: number): void }).recordViews(
      extra.signature,
      vaultEventsOf(extra.tx, PROGRAM),
      extra.at,
    );
    now += 4_000;
    expect(await stats.feed()).toBe(first);
    // older than 5 s: the kept one once more while a new one is built, then the new one
    now += 2_000;
    expect(await stats.feed()).toBe(first);
    await new Promise((r) => setTimeout(r, 0));
    const next = await stats.feed();
    expect(next).not.toBe(first);
    expect(next.tickets.length).toBe(first.tickets.length + 1);
    // two minutes without a request: the usual pace again
    now += 121_000;
    await stats.alarm();
    expect(alarms.at(-1)).toBe(now + 60_000);
  });

  /** The meta of an index caught up to `h` that recorded the APR alone (version 1). */
  const recordedTheAprAlone = (
    sql: { exec(q: string, ...b: string[]): unknown },
    h: HistoryTx[],
  ) => {
    for (const [k, v] of [
      ["cursor", h.at(-1)!.signature],
      ["round", "1"],
      ["completed_round", "1"],
      ["caught_up", "1"],
      ["transactions", String(h.length)],
      ["events_version", "2"],
      ["apr_version", "1"],
      ["apr_covered", "0"],
      ["wallet_version", "1"],
      ["wallet_covered", "1"],
    ] as const)
      sql.exec("INSERT INTO meta (k, v) VALUES (?, ?)", k, v);
  };
  type Rpc = { getTransaction(s: string): { send(): Promise<unknown> } };
  const rpcOf = (stats: StatsObject) => (stats as unknown as { rpc: Rpc }).rpc;

  it("gives up on a replayed transaction the RPC never serves: the views stop syncing, and record it once served", async () => {
    const h = history(77);
    const { stats, state, tick, reads } = await statsOver(h);
    const sql = state.storage.sql;
    recordedTheAprAlone(sql, h);
    const meta = (k: string) =>
      (sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0] as { v: string } | undefined)?.v;
    // a transaction of the last day, with events of the views, the RPC never returns
    const lost = [...h]
      .reverse()
      .find((x) => x.at > NOW - DAY && vaultEventsOf(x.tx, PROGRAM).length > 0)!;
    const rpc = rpcOf(stats);
    const serve = rpc.getTransaction.bind(rpc);
    let refused = true;
    rpc.getTransaction = (signature) =>
      signature === lost.signature && refused
        ? {
            send: async () => {
              reads.push(signature);
              return null;
            },
          }
        : serve(signature);
    for (let i = 0; i < 30 && (await tick()); i++);
    expect(meta("views_covered")).toBeUndefined();
    expect((await stats.vault()).syncing).toBe(true);
    // read again on its backoff (a minute doubling, an hour at most) until it is given up on
    for (let i = 0; i < 10; i++) {
      now += 3_600_000;
      await tick();
    }
    expect(reads.filter((r) => r === lost.signature).length).toBeGreaterThanOrEqual(8);
    // the views count from the replay's floor, and no longer say they are syncing
    expect(meta("views_covered")).toBe("0");
    expect(meta("apr_covered")).toBe("0");
    const vault = await stats.vault();
    expect([vault.syncing, vault.seriesSyncing]).toEqual([false, false]);
    // still read every hour: recorded once the RPC serves it
    refused = false;
    now += 3_600_000;
    await tick();
    expect(sql.exec("SELECT COUNT(*) AS n FROM apr_replay").one()).toEqual({ n: 0 });
    const ticket = vaultEventsOf(lost.tx, PROGRAM).find((e) => "ticket" in e) as
      { ticket: string } | undefined;
    if (ticket)
      expect(
        sql.exec("SELECT COUNT(*) AS n FROM vault_tickets WHERE ticket = ?", ticket.ticket).one(),
      ).toEqual({ n: 1 });
  });

  it("bounds the replays by the object's time: a few seconds a tick, paced, three hours a day", async () => {
    const h = history(78);
    const { stats, state, tick, reads } = await statsOver(h);
    const sql = state.storage.sql;
    recordedTheAprAlone(sql, h);
    const meta = (k: string) =>
      (sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0] as { v: string } | undefined)?.v;
    // each read keeps the object awake a second (the RPC's answer awaited)
    const rpc = rpcOf(stats);
    const serve = rpc.getTransaction.bind(rpc);
    rpc.getTransaction = (signature) => ({
      send: async () => {
        now += 1_000;
        return serve(signature).send();
      },
    });
    await tick(); // lists the replay
    const before = reads.length;
    await stats.alarm();
    // 5 s of reads, not the 50 a tick may read; the next tick 15 s later, not 2 s
    expect(reads.length - before).toBe(5);
    expect(alarms.at(-1)).toBe(now + 15_000);
    expect(Number(meta("replay_ms"))).toBeGreaterThanOrEqual(5_000);
    // the day's three hours spent: nothing read until the next UTC day, at the idle pace
    const day = Math.floor(now / 86_400_000);
    sql.exec(
      "INSERT OR REPLACE INTO meta (k, v) VALUES ('replay_day', ?), ('replay_ms', ?)",
      String(day),
      String(3 * 3_600_000),
    );
    const n = reads.length;
    await stats.alarm();
    expect(reads.length).toBe(n);
    expect(alarms.at(-1)).toBe(now + 60_000);
    now = (day + 1) * 86_400_000 + 1_000;
    await stats.alarm();
    expect(reads.length).toBe(n + 5);
    expect(meta("replay_day")).toBe(String(day + 1));
  });

  it("builds the APR's answer again for the loop once a transaction was counted, else every 10 minutes", async () => {
    const h = history(79, 30);
    const { stats, state, tick } = await statsOver(h);
    for (let i = 0; i < 30 && (await tick()); i++);
    const builtAt = () =>
      (
        state.storage.sql.exec("SELECT v FROM meta WHERE k = 'apr_view_at'").toArray()[0] as {
          v: string;
        }
      ).v;
    await stats.apr();
    const first = builtAt();
    // asked, nothing new counted: the minutes pass without a read of the vault
    for (let i = 0; i < 5; i++) {
      now += 61_000;
      await tick();
    }
    expect(builtAt()).toBe(first);
    // a transaction counted: built again at the next tick
    const extra = {
      signature: sig(9_998),
      at: NOW - 20,
      tx: eventTx(opened(A("apr-late"), APPS[0], USDC, 2n * USDC)),
    };
    (stats as unknown as { count(s: string, tx: unknown, at: number): void }).count(
      extra.signature,
      { ...extra.tx, blockTime: BigInt(extra.at) },
      extra.at,
    );
    await tick();
    const second = builtAt();
    expect(second).not.toBe(first);
    // nothing new again: the next build waits for its window to slide 10 minutes
    now += 5 * 60_000;
    await tick();
    expect(builtAt()).toBe(second);
    now += 5 * 60_000;
    await tick();
    expect(builtAt()).not.toBe(second);
  });

  it("serves in the feed every ticket opened since its horizon, and the newest events", async () => {
    const h = history(80, FEED_TICKETS + 60);
    const { stats, state, tick } = await statsOver(h);
    for (let i = 0; i < 80 && (await tick()); i++);
    const feed = await stats.feed();
    const stored = state.storage.sql
      .exec("SELECT ticket, opened_at, end_at, last_at FROM vault_tickets")
      .toArray() as { ticket: string; opened_at: number | null; last_at: number }[];
    const served = new Set(feed.tickets.map((t) => t.ticket));
    const opened = stored
      .filter((t) => t.opened_at !== null)
      .sort((a, b) => b.opened_at! - a.opened_at!);
    expect(feed.ticketsFrom).toBe(opened[FEED_TICKETS - 1]!.opened_at);
    for (const t of opened.filter((t) => t.opened_at! >= feed.ticketsFrom))
      expect(served.has(t.ticket)).toBe(true);
    const newest = [...stored].sort((a, b) => b.last_at - a.last_at).slice(0, FEED_TICKETS);
    for (const t of newest) expect(served.has(t.ticket)).toBe(true);
    expect(served.size).toBe(feed.tickets.length);
  });
});
