// The keeper's all-time figures (apps/keeper/src/stats.ts) over a transaction the RPC keeps
// failing to return: it is retried in order a few ticks, then set aside so that every later one
// is still counted, read again on its own backoff, and counted once when it is served. The
// Durable Object runs over SQLite in memory and a scripted RPC.
import { DatabaseSync } from "node:sqlite";
import { getBase58Decoder, type Address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findIntegratorPda,
  getRoundTicketReturnedEventEncoder,
  getRoundTicketSettledEventEncoder,
  getTicketJoinedEventEncoder,
  getTicketOpenedEventEncoder,
  getTicketSettledEventEncoder,
} from "../../../clients/js/src/generated/fade/index.ts";
import { cfg } from "../../../apps/keeper/src/chain.ts";
import { RECORDED_EVENTS_VERSION } from "../../../apps/keeper/src/vaultIndex.ts";
import { EVENT_IX_TAG, PROGRAM } from "../../../apps/keeper/src/chain.ts";
import { BOOSTER_PAYOUT } from "../../../apps/web/src/lib/ticketKind.ts";

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

type WinView = { kind: string | null; ticket: string; payout: string } | null;
type SplitView = {
  ticketsOpened: number;
  ticketsDrawn: number;
  ticketsExpired: number;
  wins: number;
  paid: string;
  biggestWin: WinView;
  lastWin: WinView;
};
/** The Durable Object, as this test drives it. */
type StatsObject = {
  stats(): Promise<{
    syncing: boolean;
    indexed: { transactions: number; replaying: boolean };
    all: SplitView;
  }>;
};
// Imported by a computed path: the Workers types it needs are the keeper's own typecheck's, not
// the test tree's.
const STATS_MODULE = "../../../apps/keeper/src/stats.ts";
const { Stats } = (await import(STATS_MODULE)) as {
  Stats: new (ctx: unknown, env: unknown) => StatsObject;
};

/**
 * The part of a Durable Object's state `Stats` uses, over SQLite in memory.
 * `refuse` throws for a statement it matches, as the Workers SQLite
 * authorizer refuses what it does not allow.
 */
function memoryState(db = new DatabaseSync(":memory:"), refuse?: RegExp) {
  const sql = {
    exec: (q: string, ...b: (string | number | null)[]) => {
      if (refuse?.test(q)) throw new Error(`not authorized: ${q}`);
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

const sig = (c: string) => c.repeat(64);
/** A landed transaction with no ticket event: it counts as one transaction read. */
const emptyTx = {
  meta: { err: null, innerInstructions: [] },
  transaction: { message: { accountKeys: [] } },
};

const b58 = (bytes: ArrayLike<number>) => getBase58Decoder().decode(Uint8Array.from(bytes));
const A = (s: string) =>
  b58(Array.from({ length: 32 }, (_, i) => s.charCodeAt(i % s.length) + i)) as Address;
const emitted = (body: ArrayLike<number>) => b58([...EVENT_IX_TAG, ...Array.from(body)]);
/** A landed program transaction whose inner instructions carry `datas`. */
const eventTx = (...datas: string[]) => ({
  meta: {
    err: null,
    innerInstructions: [{ instructions: datas.map((data) => ({ programIdIndex: 1, data })) }],
  },
  transaction: { message: { accountKeys: [A("Payer"), PROGRAM] } },
});

const joinedData = (ticket: Address, integrator: Address, price: bigint) =>
  emitted(
    getTicketJoinedEventEncoder().encode({
      version: 1,
      ticket,
      round: A("Round"),
      integrator,
      nonce: 1,
      beneficiary: A("Ben"),
      refundTo: A("Ben"),
      payoutTable: A("Table"),
      price,
      vaultCredit: price,
      payoutMax: (price * 19_560n) / 10_000n,
      reservedLiability: price,
      cap: price,
      usage: price,
      protocolShare: 0,
      appShare: 0,
      prepay: 5_000,
      slot: 10,
      payer: A("Payer"),
      funder: A("Payer"),
      settleShare: 2_000,
    }),
  );
const roundSettledData = (ticket: Address, integrator: Address, payout: bigint, pending = false) =>
  emitted(
    getRoundTicketSettledEventEncoder().encode({
      version: 1,
      ticket,
      round: A("Round"),
      integrator,
      outcome: payout > 0n ? 0 : 1,
      payout,
      charge: 1_500,
      pending,
    }),
  );
const settledData = (ticket: Address, integrator: Address, payout: bigint) =>
  emitted(
    getTicketSettledEventEncoder().encode({
      version: 1,
      ticket,
      integrator,
      outcome: 1,
      payout,
      pending: false,
    }),
  );

describe("the stats backlog", () => {
  let now = 1_000_000;
  const warnings: string[] = [];
  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "warn").mockImplementation((m: string) => {
      warnings.push(m);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets aside a transaction the RPC keeps failing to return, counts the rest, and counts it once when served", async () => {
    // Newest first, as getSignaturesForAddress lists them: c is the newest, a the oldest.
    const [a, b, c] = [sig("2"), sig("3"), sig("4")];
    let bServed = false;
    const asked: string[] = [];
    const rpc = {
      // The whole history once; nothing newer than the cursor afterwards.
      getSignaturesForAddress: (_program: unknown, options: { until?: string }) => ({
        send: async () =>
          options.until
            ? []
            : [c, b, a].map((signature) => ({ signature, err: null, blockTime: 1_700_000_000n })),
      }),
      getTransaction: (signature: string, config: { maxSupportedTransactionVersion: number }) => ({
        send: async () => {
          asked.push(`${signature[0]}v${config.maxSupportedTransactionVersion}`);
          if (signature === b && !bServed)
            throw new Error("Transaction version (1) is not supported");
          return emptyTx;
        },
      }),
    };
    const stats = new Stats(memoryState(), { RPC_URL: "http://localhost:0" });
    (stats as unknown as { rpc: unknown }).rpc = rpc;
    const tick = () => (stats as unknown as { tick(): Promise<boolean> }).tick();
    const read = async () => (await stats.stats()).indexed.transactions;

    // Ticks 1 and 2: a is counted, b fails and holds c back (retried in order).
    expect(await tick()).toBe(true);
    expect(await read()).toBe(1);
    expect(await tick()).toBe(true);
    expect(await read()).toBe(1);
    expect(asked.filter((x) => x.startsWith("4"))).toEqual([]);
    // Tick 3: b fails a third time, is set aside, and c is counted.
    expect(await tick()).toBe(false); // only b left, set aside: no busy period
    expect(await read()).toBe(2);
    expect(asked.filter((x) => x.startsWith("4"))).toEqual(["4v1"]);
    expect(warnings.at(-1)).toMatch(/3 tries.*set aside, read again in 60 s/);
    const s = await stats.stats();
    expect(s.syncing).toBe(true); // b is still queued
    // Before its backoff, b is not read again.
    const before = asked.length;
    await tick();
    expect(asked.length).toBe(before);
    // After it, b is served: counted, and the backlog is empty.
    now += 60_000;
    bServed = true;
    await tick();
    expect(await read()).toBe(3);
    expect((await stats.stats()).syncing).toBe(false);
    // Never counted twice.
    await tick();
    expect(await read()).toBe(3);
    // Every read asked version 1 first.
    expect(asked.filter((x) => x.endsWith("v1")).length).toBeGreaterThan(0);
    expect(asked.every((x, i) => x.endsWith("v1") || asked[i - 1] === `${x[0]}v1`)).toBe(true);
  });
  it("a win counted before its ticket's opening gets its kind once the opening is counted", async () => {
    const [ticket, app] = [A("Ticket"), A("App")];
    const price = 1_000_000n;
    const opened = eventTx(
      emitted(
        getTicketOpenedEventEncoder().encode({
          version: 1,
          ticket,
          integrator: app,
          nonce: 1,
          beneficiary: A("Ben"),
          price,
          vaultCredit: price,
          payoutMax: price * BOOSTER_PAYOUT,
          reservedLiability: price * BOOSTER_PAYOUT,
          cap: price * BOOSTER_PAYOUT,
          marginBps: 350,
          appShareBps: 0,
          openSlot: 10,
        }),
      ),
    );
    const settled = eventTx(
      emitted(
        getTicketSettledEventEncoder().encode({
          version: 1,
          ticket,
          integrator: app,
          outcome: 1,
          payout: 5n * price,
          pending: false,
        }),
      ),
    );
    // The opening (oldest) is not served until later; its settlement is.
    const [open, settle] = [sig("5"), sig("6")];
    let openServed = false;
    const rpc = {
      getSignaturesForAddress: (_program: unknown, options: { until?: string }) => ({
        send: async () =>
          options.until
            ? []
            : [settle, open].map((signature) => ({
                signature,
                err: null,
                blockTime: 1_700_000_000n,
              })),
      }),
      getTransaction: (signature: string) => ({
        send: async () => {
          if (signature === open) {
            if (!openServed) throw new Error("unavailable");
            return opened;
          }
          return settled;
        },
      }),
    };
    const stats = new Stats(memoryState(), { RPC_URL: "http://localhost:0" });
    (stats as unknown as { rpc: unknown }).rpc = rpc;
    const tick = () => (stats as unknown as { tick(): Promise<boolean> }).tick();
    const openRows = () =>
      (stats as unknown as { sql: { exec(q: string): { toArray(): unknown[] } } }).sql
        .exec("SELECT ticket FROM open_tickets")
        .toArray().length;

    // Three failed reads set the opening aside; the settlement is counted without a kind.
    for (let i = 0; i < 3; i++) await tick();
    let all = (await stats.stats()).all;
    expect(all.wins).toBe(1);
    expect(all.biggestWin).toMatchObject({ ticket, kind: null });
    // Once served, the opening fills the win's kind in and leaves no ticket open.
    now += 60_000;
    openServed = true;
    await tick();
    all = (await stats.stats()).all;
    expect(all.wins).toBe(1);
    expect(all.biggestWin).toMatchObject({ ticket, kind: "Booster" });
    expect(all.lastWin).toMatchObject({ ticket, kind: "Booster" });
    expect(openRows()).toBe(0);
    expect((await stats.stats()).syncing).toBe(false);
  });
  it("a beacon return counted before its join is split by the join once it is counted", async () => {
    const [ticket, app] = [A("Ticket"), A("App")];
    const price = 100_000n;
    const joined = eventTx(joinedData(ticket, app, price));
    const returned = eventTx(
      emitted(
        getRoundTicketReturnedEventEncoder().encode({
          version: 1,
          ticket,
          round: A("Round"),
          refunded: true,
          price,
          lamports: 5_000,
          parked: false,
          charge: 0,
        }),
      ),
    );
    const [join, ret] = [sig("7"), sig("8")];
    let joinServed = false;
    const rpc = {
      getSignaturesForAddress: (_program: unknown, options: { until?: string }) => ({
        send: async () =>
          options.until
            ? []
            : [ret, join].map((signature) => ({
                signature,
                err: null,
                blockTime: 1_800_000_000n,
              })),
      }),
      getTransaction: (signature: string) => ({
        send: async () => {
          if (signature === join) {
            if (!joinServed) throw new Error("unavailable");
            return joined;
          }
          return returned;
        },
      }),
    };
    const stats = new Stats(memoryState(), { RPC_URL: "http://localhost:0" });
    (stats as unknown as { rpc: unknown }).rpc = rpc;
    const tick = () => (stats as unknown as { tick(): Promise<boolean> }).tick();

    for (let i = 0; i < 3; i++) await tick();
    let s = await stats.stats();
    // a return is never a win; its join is not read yet
    expect(s.all).toMatchObject({ ticketsExpired: 1, wins: 0, ticketsOpened: 0 });
    now += 60_000;
    joinServed = true;
    await tick();
    s = await stats.stats();
    expect(s.all).toMatchObject({ ticketsOpened: 1, ticketsExpired: 1, wins: 0 });
    expect(s.syncing).toBe(false);
  });

  it("replays, once, the beacon events of what an index without them counted", async () => {
    const [other] = await findIntegratorPda({ integratorAuthority: A("OtherApp") }, cfg);
    const price = 100_000n;
    const won = 195_600n;
    const [early, late, queued, fresh, tooOld] = ["E", "L", "Q", "F", "O"].map((n) =>
      A(`T${n}`),
    ) as [Address, Address, Address, Address, Address];
    const direct = A("Direct");
    // Oldest first. `cursorSig` is the cursor the earlier index left, `queuedSig` the one it
    // listed and had not counted yet; `newSig` landed after the cursor.
    const [oldSig, joinSig, queuedSig, cursorSig, newSig] = [
      sig("A"),
      sig("B"),
      sig("C"),
      sig("D"),
      sig("E"),
    ];
    const txs: Record<string, ReturnType<typeof eventTx>> = {
      // older than REPLAY_FROM: never read again
      [oldSig]: eventTx(joinedData(tooOld, A("App"), price)),
      // counted before, direct events and all: only its beacon events are replayed
      [joinSig]: eventTx(
        joinedData(early, A("App"), price),
        joinedData(late, other, price),
        settledData(direct, A("App"), 7n),
      ),
      [cursorSig]: eventTx(roundSettledData(early, A("App"), won, true)),
      // still queued when the replay starts: counted in full by the backlog, not replayed
      [queuedSig]: eventTx(joinedData(queued, A("App"), price)),
      // listed after the replay starts: counted in full
      [newSig]: eventTx(roundSettledData(late, other, 0n), roundSettledData(fresh, A("App"), won)),
    };
    const at: Record<string, bigint> = {
      [oldSig]: 1_792_000_000n,
      [joinSig]: 1_792_300_000n,
      [queuedSig]: 1_792_300_050n,
      [cursorSig]: 1_792_300_100n,
      [newSig]: 1_792_300_300n,
    };
    const listing = (sigs: string[]) =>
      sigs.map((signature) => ({ signature, err: null, blockTime: at[signature]! }));
    const reads: string[] = [];
    const rpc = {
      getSignaturesForAddress: (_program: unknown, o: { until?: string; before?: string }) => ({
        send: async () => {
          if (o.until === cursorSig) return listing([newSig]);
          if (o.until === newSig) return [];
          if (o.before === cursorSig) return listing([queuedSig, joinSig, oldSig]);
          throw new Error(`unexpected listing ${JSON.stringify(o)}`);
        },
      }),
      getTransaction: (signature: string, config: { maxSupportedTransactionVersion: number }) => ({
        send: async () => {
          reads.push(`${signature[0]}v${config.maxSupportedTransactionVersion}`);
          return { ...txs[signature]!, blockTime: at[signature]!, version: 1 };
        },
      }),
    };
    const state = memoryState();
    const stats = new Stats(state, { RPC_URL: "http://localhost:0" });
    (stats as unknown as { rpc: unknown }).rpc = rpc;
    const tick = () => (stats as unknown as { tick(): Promise<boolean> }).tick();
    // The earlier index: caught up to `cursorSig`, its direct win counted, `queuedSig` still queued.
    // It records the APR and the vault views already: their replay (step 4) is tested on its own.
    const sql = state.storage.sql;
    for (const [k, v] of [
      ["cursor", cursorSig],
      ["round", "1"],
      ["completed_round", "1"],
      ["caught_up", "1"],
      ["transactions", "3"],
      ["apr_version", String(RECORDED_EVENTS_VERSION)],
      // it stores the wallets already: their replay (step 5) is tested on its own
      ["wallet_version", "1"],
      ["wallet_covered", "1"],
    ] as const)
      sql.exec("INSERT INTO meta (k, v) VALUES (?, ?)", k, v);
    sql.exec(
      "INSERT INTO backlog (signature, round, idx, block_time) VALUES (?, 1, 0, ?)",
      queuedSig,
      Number(at[queuedSig]),
    );
    const before = {
      ticketsOpened: 0,
      ticketsDrawn: 1,
      ticketsExpired: 0,
      wins: 1,
      paid: "7",
      biggestWin: {
        payout: "7",
        kind: null,
        ticket: direct,
        at: 1_792_300_000,
        signature: joinSig,
      },
      lastWin: { payout: "7", kind: null, ticket: direct, at: 1_792_300_000, signature: joinSig },
    };
    sql.exec("INSERT INTO totals (split, json) VALUES (?, ?)", "all", JSON.stringify(before));

    for (let i = 0; i < 6; i++) await tick();
    const s = await stats.stats();
    expect(s.indexed.replaying).toBe(false);
    expect(s.syncing).toBe(false);
    // the backlog's two (queuedSig, newSig) are counted as transactions; the replay adds none
    expect(s.indexed.transactions).toBe(5);
    // opened: early and late (replayed), queued (backlog); drawn: the direct one, early, late, fresh
    expect(s.all).toMatchObject({ ticketsOpened: 3, ticketsDrawn: 4, wins: 3 });
    expect(s.all.paid).toBe(String(7n + 2n * won));
    expect(s.all.lastWin).toMatchObject({ ticket: fresh, kind: "Small ticket" });
    // read once each, the transaction older than REPLAY_FROM never, every read asked version 1
    const once = (c: string) => reads.filter((r) => r.startsWith(c)).length;
    expect([once("A"), once("B"), once("C"), once("D"), once("E")]).toEqual([0, 1, 1, 1, 1]);
    expect(reads.every((r) => r.endsWith("v1"))).toBe(true);
    // nothing more on later ticks
    for (let i = 0; i < 3; i++) await tick();
    expect((await stats.stats()).all).toEqual(s.all);
    expect(reads.length).toBe(4);
  });

  it("a new index records the beacon's events from its first read, and replays nothing", async () => {
    const t = A("T");
    const rpc = {
      getSignaturesForAddress: (_program: unknown, o: { until?: string; before?: string }) => ({
        send: async () =>
          o.until || o.before
            ? []
            : [{ signature: sig("9"), err: null, blockTime: 1_792_300_000n }],
      }),
      getTransaction: () => ({
        send: async () =>
          eventTx(joinedData(t, A("App"), 100_000n), roundSettledData(t, A("App"), 5n)),
      }),
    };
    const stats = new Stats(memoryState(), { RPC_URL: "http://localhost:0" });
    (stats as unknown as { rpc: unknown }).rpc = rpc;
    const tick = () => (stats as unknown as { tick(): Promise<boolean> }).tick();
    await tick();
    await tick();
    const s = await stats.stats();
    expect(s.indexed.replaying).toBe(false);
    expect(s.all).toMatchObject({ ticketsOpened: 1, ticketsDrawn: 1, wins: 1, paid: "5" });
  });

  it("adds the columns an earlier index lacks with the PRAGMA statement, once", () => {
    const db = new DatabaseSync(":memory:");
    // The tables as an index created before these columns left them.
    db.exec("CREATE TABLE closed_unopened (ticket TEXT PRIMARY KEY, closed_at INTEGER NOT NULL)");
    db.exec(`CREATE TABLE open_tickets (
      ticket TEXT PRIMARY KEY,
      price TEXT NOT NULL,
      payout_max TEXT NOT NULL,
      opened_at INTEGER
    )`);
    db.exec("INSERT INTO open_tickets (ticket, price, payout_max) VALUES ('t', '1', '2')");
    // The table-valued pragma form refused, as the Workers authorizer may: only the statement runs.
    const state = () => memoryState(db, /pragma_table_info/i);
    new Stats(state(), { RPC_URL: "http://localhost:0" });
    new Stats(state(), { RPC_URL: "http://localhost:0" });
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("closed_unopened")).toEqual(["ticket", "closed_at"]);
    expect(columns("open_tickets")).toEqual([
      "ticket",
      "price",
      "payout_max",
      "opened_at",
      "integrator",
      "beacon",
    ]);
    expect(db.prepare("SELECT integrator, beacon FROM open_tickets").all()).toEqual([
      { integrator: null, beacon: 0 },
    ]);
  });
});
