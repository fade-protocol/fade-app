// The vault's APR as the keeper serves it (GET /v1/apr, apps/keeper/src/aprIndex.ts and the
// Stats Durable Object, stats.ts): the events it records, the answer equal to the app's own
// arithmetic on the same tickets, refunds left out, the hourly series, and the one-time replay
// that an index counted before it records the APR runs. The Durable Object runs over SQLite in
// memory and a scripted RPC.
import { DatabaseSync } from "node:sqlite";
import { getBase58Decoder, type Address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findConfigPda,
  findVaultPda,
  getConfigDecoder,
  getConfigEncoder,
  getConfigSize,
  getEpochStruckEventEncoder,
  getPayoutTableDecoder,
  getPayoutTableEncoder,
  getPayoutTableSize,
  getRoundTicketReturnedEventEncoder,
  getTicketExpiredEventEncoder,
  getTicketJoinedEventEncoder,
  getTicketOpenedEventEncoder,
  getVaultDecoder,
  getVaultEncoder,
  getVaultSize,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  APR_KEPT_S,
  APR_SERIES_DAYS,
  aprEventsOf,
  aprTicketOf,
  aprView,
  type AprView,
  type StoredTicket,
} from "../../../apps/keeper/src/aprIndex.ts";
import { EVENT_IX_TAG, PROGRAM, cfg } from "../../../apps/keeper/src/chain.ts";
import { RECORDED_EVENTS_VERSION } from "../../../apps/keeper/src/vaultIndex.ts";
import {
  APR_MIN_TICKETS,
  APR_WINDOW_S,
  coveredFrom,
  estimateApr,
  isRefunded,
  vaultMarginOf,
  type AssetsPoint,
} from "../../../apps/web/src/lib/apr.ts";
import { BPS, P_SCALE } from "../../../apps/web/src/lib/math.ts";
import {
  withBeaconMargins,
  type TicketLog,
  type TicketRow,
} from "../../../apps/web/src/lib/ticketLog.ts";
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

type StatsObject = { apr(): Promise<AprView> };
// Imported by a computed path: the Workers types it needs are the keeper's own typecheck's.
const STATS_MODULE = "../../../apps/keeper/src/stats.ts";
const { Stats } = (await import(STATS_MODULE)) as {
  Stats: new (ctx: unknown, env: unknown) => StatsObject;
};

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
      setAlarm: async () => {},
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
const sig = (n: number) => b58(Array.from({ length: 64 }, (_, i) => (n * 7 + i * 13) % 256 || 1));
const emitted = (body: ArrayLike<number>) => b58([...EVENT_IX_TAG, ...Array.from(body)]);
const eventTx = (...datas: string[]) => ({
  meta: {
    err: null,
    innerInstructions: [{ instructions: datas.map((data) => ({ programIdIndex: 1, data })) }],
  },
  transaction: { message: { accountKeys: [A("Payer"), PROGRAM] } },
});

const opened = (ticket: Address, price: bigint, marginBps: bigint, appShareBps = 0n) =>
  emitted(
    getTicketOpenedEventEncoder().encode({
      version: 1,
      ticket,
      integrator: A("App"),
      nonce: 1,
      beneficiary: A("Ben"),
      price,
      vaultCredit: price,
      payoutMax: price * 20n,
      reservedLiability: price * 20n,
      cap: price * 20n,
      marginBps,
      appShareBps,
      openSlot: 10,
    }),
  );
const joined = (
  ticket: Address,
  price: bigint,
  table: Address,
  appShare: bigint,
  protocolShare: bigint,
) =>
  emitted(
    getTicketJoinedEventEncoder().encode({
      version: 1,
      ticket,
      round: A("Round"),
      integrator: A("App"),
      nonce: 1,
      beneficiary: A("Ben"),
      refundTo: A("Ben"),
      payoutTable: table,
      price,
      vaultCredit: price,
      payoutMax: price * 2n,
      reservedLiability: price,
      cap: price,
      usage: price,
      protocolShare,
      appShare,
      prepay: 5_000,
      slot: 10,
      payer: A("Payer"),
      funder: A("Payer"),
      settleShare: 2_000,
    }),
  );
const returned = (ticket: Address, refunded: boolean) =>
  emitted(
    getRoundTicketReturnedEventEncoder().encode({
      version: 1,
      ticket,
      round: A("Round"),
      refunded,
      price: 100_000,
      lamports: 5_000,
      parked: false,
      charge: 0,
    }),
  );
/** A direct ticket's version-2 `TicketExpired`: refunded (its vault credit back) or forfeited. */
const expired = (ticket: Address, refunded: boolean) =>
  emitted(
    getTicketExpiredEventEncoder().encode({
      version: 2,
      ticket,
      integrator: A("App"),
      forfeited: refunded ? 0n : USDC,
      requested: false,
      requestFound: false,
      checked: !refunded,
      pending: false,
      refunded,
      refund: refunded ? USDC : 0n,
      parked: false,
      ticketForfeitsWithheld: refunded ? 1n : 0n,
    }),
  );
const struck = (epochId: bigint, totalAssets: bigint, deposits: bigint, assetsPaid: bigint) =>
  emitted(
    getEpochStruckEventEncoder().encode({
      version: 1,
      epochId,
      totalAssets,
      totalShares: 1n,
      deposits,
      sharesMinted: 0n,
      withdrawShares: 0n,
      assetsOwed: assetsPaid,
      assetsPaid,
      sharesBurnt: 0n,
      reward: 0n,
    }),
  );

/** `Σ p·m` of a payout table whose margin is `bps`. */
const lhsFor = (bps: bigint) => (BPS - bps) * P_SCALE;

/** The pre-prefix-sum series, a pass over every ticket per point: what `aprSeries` must equal. */
function naiveSeries(
  log: Pick<TicketLog, "rows" | "from" | "truncated" | "since">,
  assets: readonly AssetsPoint[],
  protocolShareBps: bigint,
  times: readonly number[],
) {
  const covered = coveredFrom(log);
  return times.map((t, i) => {
    const since = t - APR_WINDOW_S;
    const last = i === times.length - 1;
    const at = assets.filter((a) => a.t <= t).at(-1)?.assets ?? 0n;
    if (since < covered || at === 0n) return { t, pct: null };
    let margin = 0n;
    let tickets = 0;
    for (const r of log.rows) {
      if (r.openedAt === null || r.openedAt < since || isRefunded(r)) continue;
      if (!last && r.openedAt > t) continue;
      tickets += 1;
      margin += vaultMarginOf(r, protocolShareBps);
    }
    return {
      t,
      pct:
        tickets < APR_MIN_TICKETS
          ? null
          : (Number(margin) * 365 * DAY * 100) / (APR_WINDOW_S * Number(at)),
    };
  });
}

describe("the APR's events", () => {
  it("reads the openings of both paths, refunds only (direct ones included), and the assets after each close", () => {
    const [d, b, r, f, dr, df] = [A("D"), A("B"), A("R"), A("F"), A("DR"), A("DF")];
    const events = aprEventsOf(
      eventTx(
        opened(d, 2n * USDC, 350n, 100n),
        joined(b, USDC / 10n, A("Table"), 500n, 200n),
        returned(r, true),
        returned(f, false),
        expired(dr, true),
        expired(df, false),
        struck(7n, 1_000n * USDC, 50n * USDC, 20n * USDC),
      ),
      PROGRAM,
    );
    expect(events).toEqual([
      { kind: "direct", ticket: d, price: 2n * USDC, marginBps: 350n, appShareBps: 100n },
      {
        kind: "beacon",
        ticket: b,
        price: USDC / 10n,
        payoutTable: A("Table"),
        appShare: 500n,
        protocolShare: 200n,
      },
      { kind: "refunded", ticket: r },
      // a direct refund leaves its ticket out as a beacon one does; a forfeiture says nothing
      { kind: "refunded", ticket: dr },
      { kind: "struck", epochId: 7n, assets: 1_030n * USDC },
    ]);
    // another program's inner instructions, or a failed transaction, say nothing
    expect(aprEventsOf(eventTx(opened(d, USDC, 350n)), A("Other") as Address)).toEqual([]);
    expect(
      aprEventsOf(
        { ...eventTx(opened(d, USDC, 350n)), meta: { err: {}, innerInstructions: [] } },
        PROGRAM,
      ),
    ).toEqual([]);
  });
});

describe("the APR's answer", () => {
  const TABLES = [A("T1"), A("T2"), A("T3")] as const;
  // the third table is not read yet: its tickets keep a zero margin, as in the app
  const lhs = new Map<Address, bigint>([
    [TABLES[0], lhsFor(350n)],
    [TABLES[1], lhsFor(1_200n)],
  ]);

  /** The same ticket as the keeper stores it and as the app reads it (joinedRow, withBeaconMargins). */
  function both(r: ReturnType<typeof rng>, i: number): { stored: StoredTicket; row: TicketRow } {
    const openedAt = NOW - r.int(APR_KEPT_S - DAY) + (r.int(4) === 0 ? 0 : 30);
    const price = r.big(100_000n, 50n * USDC);
    const refunded = r.int(8) === 0;
    const base = {
      ticket: A(`t${i}`),
      integrator: A("App"),
      beneficiary: A("Ben"),
      price,
      payoutMax: price * 2n,
      vaultCredit: price,
      openedAt,
      openSig: sig(i) as TicketRow["openSig"],
    };
    if (r.int(2) === 0) {
      const marginBps = BigInt(r.int(1_500));
      const appShareBps = BigInt(r.int(300));
      return {
        stored: {
          openedAt,
          price,
          direct: { marginBps, appShareBps },
          beacon: null,
          refunded: false,
        },
        row: { ...base, marginBps, appShareBps, end: null },
      };
    }
    const table = TABLES[r.int(3)]!;
    const appShare = (price * BigInt(r.int(400))) / BPS;
    const protocolShare = (price * BigInt(r.int(50))) / BPS;
    return {
      stored: {
        openedAt,
        price,
        direct: null,
        beacon: { payoutTable: table, appShare, protocolShare },
        refunded,
      },
      row: {
        ...base,
        marginBps: 0n,
        appShareBps: (appShare * BPS) / price,
        end: refunded
          ? {
              kind: "expired",
              payout: 0n,
              pending: false,
              refunded: true,
              at: openedAt + 60,
              signature: sig(i) as TicketRow["openSig"],
            }
          : null,
        beacon: {
          round: A("Round"),
          payoutTable: table,
          refundTo: A("Ben"),
          appShare,
          protocolShare,
        },
      },
    };
  }

  it("equals the app's own figure on the same tickets, now and at every hour", () => {
    const r = rng(2610);
    for (let k = 0; k < 40; k++) {
      const pairs = Array.from({ length: 5 + r.int(400) }, (_, i) => both(r, i));
      const strikes: AssetsPoint[] = [];
      for (let t = NOW - APR_KEPT_S + r.int(DAY); t < NOW; t += HOUR * (1 + r.int(12)))
        strikes.push({ t, assets: r.big(1n, 10n ** 12n) });
      const totalAssets = r.int(12) === 0 ? 0n : r.big(1n, 10n ** 12n);
      const protocolShareBps = BigInt(r.int(50));
      const view = aprView({
        tickets: pairs.map((p) => aprTicketOf(p.stored, lhs)),
        strikes,
        totalAssets,
        protocolShareBps,
        now: NOW,
        coveredFrom: 0,
        syncing: false,
      });
      // the app's log of the same tickets, its beacon margins read from the same tables
      const appLog: TicketLog = withBeaconMargins(
        {
          rows: pairs.map((p) => p.row).sort((a, b) => b.openedAt! - a.openedAt!),
          loneEnds: [],
          from: NOW - 2 * APR_WINDOW_S,
          truncated: false,
          since: NOW - 2 * APR_WINDOW_S,
        },
        lhs,
      );
      const app = estimateApr(appLog, totalAssets, protocolShareBps, NOW);
      expect(view.now).toEqual({
        pct: app.pct,
        tickets: app.tickets,
        volume: app.volume.toString(),
        margin: app.margin.toString(),
      });
      // every point as the per-point pass over the app's tickets reads it, the last the headline
      const assets = [...strikes, { t: NOW, assets: totalAssets }];
      const fullLog = { ...appLog, from: null, since: 0 };
      expect(view.series).toEqual(
        naiveSeries(
          fullLog,
          assets,
          protocolShareBps,
          view.series.map((p) => p.t),
        ),
      );
      expect(view.series.at(-1)).toEqual({ t: NOW, pct: app.pct });
    }
  });

  it("serves a point each whole hour over the last 30 days, then now", () => {
    const tickets = Array.from({ length: 2_000 }, (_, i) =>
      aprTicketOf(
        {
          openedAt: NOW - 45 * DAY + i * 1_900,
          price: USDC,
          direct: { marginBps: 350n, appShareBps: 0n },
          beacon: null,
          refunded: false,
        },
        new Map(),
      ),
    );
    const strikes = [{ t: NOW - 60 * DAY, assets: 1_000n * USDC }];
    const view = aprView({
      tickets,
      strikes,
      totalAssets: 1_000n * USDC,
      protocolShareBps: 20n,
      now: NOW + 1_234,
      coveredFrom: 0,
      syncing: false,
    });
    expect(view.windowDays).toBe(7);
    expect(view.series.at(-1)!.t).toBe(NOW + 1_234);
    const hours = view.series.slice(0, -1);
    expect(hours.length).toBe(APR_SERIES_DAYS * 24);
    expect(hours[0]!.t).toBe(Math.ceil((NOW + 1_234 - APR_SERIES_DAYS * DAY) / HOUR) * HOUR);
    expect(
      hours.every((p, i) => p.t % HOUR === 0 && (i === 0 || p.t - hours[i - 1]!.t === HOUR)),
    ).toBe(true);
    // a ticket every half hour or so: no week without its five, no gap
    expect(view.series.every((p) => p.pct !== null && p.pct > 0)).toBe(true);
  });

  it("starts a young vault at its first ticket, a gap only while a week has fewer than five", () => {
    const tickets = Array.from({ length: 8 }, (_, i) =>
      aprTicketOf(
        {
          openedAt: NOW - 3 * DAY + i * HOUR,
          price: USDC,
          direct: { marginBps: 350n, appShareBps: 0n },
          beacon: null,
          refunded: false,
        },
        new Map(),
      ),
    );
    const view = aprView({
      tickets,
      strikes: [{ t: NOW - 4 * DAY, assets: 100n * USDC }],
      totalAssets: 100n * USDC,
      protocolShareBps: 20n,
      now: NOW,
      coveredFrom: 0,
      syncing: false,
    });
    expect(view.series[0]!.t).toBe(NOW - 3 * DAY);
    // the first four hours hold one to four tickets; from the fifth the week has its five
    expect(view.series.slice(0, 4).every((p) => p.pct === null)).toBe(true);
    expect(view.series.slice(4).every((p) => p.pct !== null)).toBe(true);
  });

  it("leaves refunded tickets out, from the count as from the margin", () => {
    const ticket = (refunded: boolean, i: number): StoredTicket => ({
      openedAt: NOW - i * HOUR,
      price: USDC,
      direct: null,
      beacon: { payoutTable: TABLES[0], appShare: 0n, protocolShare: 0n },
      refunded,
    });
    const view = (stored: StoredTicket[]) =>
      aprView({
        tickets: stored.map((t) => aprTicketOf(t, lhs)),
        strikes: [{ t: NOW - 10 * DAY, assets: 100n * USDC }],
        totalAssets: 100n * USDC,
        protocolShareBps: 20n,
        now: NOW,
        coveredFrom: 0,
        syncing: false,
      }).now;
    const five = [0, 1, 2, 3, 4].map((i) => ticket(false, i));
    expect(view(five)).toMatchObject({ tickets: 5, volume: String(5n * USDC), margin: "175000" });
    // four tickets and a refunded one: too few, and nothing of the refunded one counted
    const four = [...five.slice(0, 4), ticket(true, 4)];
    expect(view(four)).toEqual({
      pct: null,
      tickets: 4,
      volume: String(4n * USDC),
      margin: "140000",
    });
  });

  it("scales the headline and draws no point before the history it covers", () => {
    const tickets = Array.from({ length: 20 }, (_, i) =>
      aprTicketOf(
        {
          openedAt: NOW - i * HOUR,
          price: USDC,
          direct: { marginBps: 350n, appShareBps: 0n },
          beacon: null,
          refunded: false,
        },
        new Map(),
      ),
    );
    const input = {
      tickets,
      strikes: [{ t: NOW - 20 * DAY, assets: 100n * USDC }],
      totalAssets: 100n * USDC,
      protocolShareBps: 20n,
      now: NOW,
      syncing: true,
    };
    // a replay that reached back a day: the headline scales that day to 7, the series is only now
    const partial = aprView({ ...input, coveredFrom: NOW - DAY });
    expect(partial.syncing).toBe(true);
    expect(partial.now.volume).toBe(String(7n * 20n * USDC));
    expect(partial.series).toEqual([{ t: NOW, pct: null }]);
    // nothing listed yet
    expect(aprView({ ...input, coveredFrom: Infinity }).series).toEqual([{ t: NOW, pct: null }]);
  });
});

describe("the Stats Durable Object's APR", () => {
  let now = NOW * 1_000;
  const warnings: string[] = [];
  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "warn").mockImplementation((m: string) => {
      warnings.push(m);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    now = NOW * 1_000;
  });

  const TABLE = A("Table");
  const base64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  async function accounts(totalAssets: bigint, protocolShareBps: bigint) {
    const [[config], [vault]] = await Promise.all([findConfigPda(cfg), findVaultPda(cfg)]);
    const zeroConfig = getConfigDecoder().decode(new Uint8Array(getConfigSize()));
    const zeroVault = getVaultDecoder().decode(new Uint8Array(getVaultSize()));
    const zeroTable = getPayoutTableDecoder().decode(new Uint8Array(getPayoutTableSize()));
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
            params: { ...zeroConfig.params, protocolShareBps },
          }),
        ),
      ],
      [vault, account(getVaultEncoder().encode({ ...zeroVault, totalAssets }))],
      [TABLE, account(getPayoutTableEncoder().encode({ ...zeroTable, lhs: lhsFor(350n) }))],
    ]);
  }

  it("replays, once, the last 38 days of an index counted before the APR, newest first", async () => {
    // An index caught up to `cursor` that recorded nothing for the APR. Its history, newest
    // first: the cursor, a refund of a beacon ticket (read before its join), the beacon
    // ticket's join, six direct openings and a close, all within the kept window; then one
    // opening older than it, never read.
    const t = (n: number) => NOW - n * HOUR;
    const direct = Array.from({ length: 6 }, (_, i) => A(`d${i}`));
    const beacon = [A("b0"), A("b1")];
    const history: { signature: string; at: number; tx: ReturnType<typeof eventTx> }[] = [
      { signature: sig(1), at: t(1), tx: eventTx(opened(direct[0]!, USDC, 350n)) },
      { signature: sig(2), at: t(2), tx: eventTx(returned(beacon[1]!, true)) },
      {
        signature: sig(3),
        at: t(3),
        tx: eventTx(
          joined(beacon[0]!, USDC, TABLE, 0n, 1_000n),
          joined(beacon[1]!, USDC, TABLE, 0n, 1_000n),
        ),
      },
      ...direct.slice(1).map((d, i) => ({
        signature: sig(10 + i),
        at: t(10 + i),
        tx: eventTx(opened(d, USDC, 350n)),
      })),
      { signature: sig(30), at: t(30), tx: eventTx(struck(1n, 900n * USDC, 100n * USDC, 0n)) },
      {
        signature: sig(40),
        at: NOW - APR_KEPT_S - DAY,
        tx: eventTx(opened(A("old"), 1_000n * USDC, 350n)),
      },
    ];
    const [cursor, ...older] = history;
    const reads: string[] = [];
    let accountReads = 0;
    const live = await accounts(2_000n * USDC, 20n);
    const rpc = {
      getSignaturesForAddress: (_p: unknown, o: { until?: string; before?: string }) => ({
        send: async () => {
          if (o.until !== undefined) return [];
          if (o.before === cursor!.signature)
            return older.map((h) => ({
              signature: h.signature,
              err: null,
              blockTime: BigInt(h.at),
            }));
          throw new Error(`unexpected listing ${JSON.stringify(o)}`);
        },
      }),
      getTransaction: (signature: string) => ({
        send: async () => {
          reads.push(signature);
          const h = history.find((x) => x.signature === signature)!;
          return { ...h.tx, blockTime: BigInt(h.at), version: 1 };
        },
      }),
      getMultipleAccounts: (list: string[]) => ({
        send: async () => {
          accountReads += 1;
          return { value: list.map((a) => live.get(a) ?? null) };
        },
      }),
    };
    const state = memoryState();
    const stats = new Stats(state, { RPC_URL: "http://localhost:0" });
    (stats as unknown as { rpc: unknown }).rpc = rpc;
    const tick = () => (stats as unknown as { tick(): Promise<boolean> }).tick();
    const sql = state.storage.sql;
    for (const [k, v] of [
      ["cursor", cursor!.signature],
      ["round", "1"],
      ["completed_round", "1"],
      ["caught_up", "1"],
      ["transactions", String(history.length)],
      ["events_version", "2"],
      // it stores the wallets already: their replay (step 5) is tested on its own
      ["wallet_version", "1"],
      ["wallet_covered", "1"],
    ] as const)
      sql.exec("INSERT INTO meta (k, v) VALUES (?, ?)", k, v);

    // Before the replay starts: syncing, nothing to show yet.
    let view = await stats.apr();
    expect(view.syncing).toBe(true);
    // One tick lists it, the next reads it all (fewer than a tick's worth), newest first.
    await tick();
    await tick();
    expect(reads).toEqual(history.slice(0, -1).map((h) => h.signature));
    // the tick that finished the replay built the answer again
    view = await stats.apr();
    expect(view.syncing).toBe(false);
    // six direct tickets and the beacon one that was not refunded: 1 USDC each at 3.5 %, less
    // 0.2 % protocol share for the direct ones and 0.1 USDC for the beacon one's
    const margin = 6n * 33_000n + (35_000n - 1_000n);
    expect(view.now).toMatchObject({
      tickets: 7,
      volume: String(7n * USDC),
      margin: String(margin),
    });
    expect(view.now.pct).toBeCloseTo((Number(margin) * 365 * 100) / 7 / 2_000e6, 9);
    expect(view.series.at(-1)).toEqual({ t: NOW, pct: view.now.pct });
    // from the oldest ticket kept, hourly
    expect(view.series[0]!.t).toBe(t(14));
    // Kept: a request within the minute is served the same answer, no account read.
    const before = accountReads;
    expect(await stats.apr()).toEqual(view);
    expect(accountReads).toBe(before);
    // Nothing read again on later ticks.
    for (let i = 0; i < 3; i++) await tick();
    expect(reads.length).toBe(history.length - 1);
    const meta = (k: string) =>
      (sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0] as { v: string } | undefined)?.v;
    expect(meta("apr_version")).toBe(String(RECORDED_EVENTS_VERSION));
    expect(meta("views_covered")).toBe(String(NOW - APR_KEPT_S));
    expect(meta("apr_covered")).toBe(String(NOW - APR_KEPT_S));
  });

  it("a new index records the APR from its first read, and replays nothing", async () => {
    const tickets = Array.from({ length: 5 }, (_, i) => A(`n${i}`));
    const history = [
      {
        signature: sig(50),
        at: NOW - HOUR,
        tx: eventTx(...tickets.map((d) => opened(d, USDC, 350n))),
      },
      { signature: sig(51), at: NOW - DAY, tx: eventTx(struck(3n, 500n * USDC, 0n, 0n)) },
    ];
    const live = await accounts(500n * USDC, 20n);
    const reads: string[] = [];
    const rpc = {
      getSignaturesForAddress: (_p: unknown, o: { until?: string; before?: string }) => ({
        send: async () =>
          o.until || o.before
            ? []
            : history.map((h) => ({ signature: h.signature, err: null, blockTime: BigInt(h.at) })),
      }),
      getTransaction: (signature: string) => ({
        send: async () => {
          reads.push(signature);
          const h = history.find((x) => x.signature === signature)!;
          return { ...h.tx, blockTime: BigInt(h.at), version: 1 };
        },
      }),
      getMultipleAccounts: (list: string[]) => ({
        send: async () => ({ value: list.map((a) => live.get(a) ?? null) }),
      }),
    };
    const stats = new Stats(memoryState(), { RPC_URL: "http://localhost:0" });
    (stats as unknown as { rpc: unknown }).rpc = rpc;
    const tick = () => (stats as unknown as { tick(): Promise<boolean> }).tick();
    await tick();
    await tick();
    const view = await stats.apr();
    expect(reads.sort()).toEqual(history.map((h) => h.signature).sort());
    expect(view.syncing).toBe(false);
    expect(view.now).toMatchObject({ tickets: 5, margin: String(5n * 33_000n) });
    expect(view.now.pct).toBeCloseTo((5 * 0.033 * 365 * 100) / 7 / 500, 9);
  });
});
