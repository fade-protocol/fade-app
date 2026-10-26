// The liquidity providers as the keeper serves them (GET /v1/providers,
// apps/keeper/src/providersIndex.ts and the Stats Durable Object, stats.ts): the answer equal to
// the app's own list over the same accounts (lib/providers, the app's own scan), each owner's
// first deposit request read from the Queue's history whatever the order and however often, the
// first deposits served only once that history is read back to the start, the answer kept and
// built again at most every 2 minutes, and the Queue's history followed only while the list is
// asked for. The Durable Object runs over SQLite in memory and a scripted RPC.
import { DatabaseSync } from "node:sqlite";
import {
  getAddressEncoder,
  getBase58Decoder,
  SolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND,
  type Address,
} from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findQueuePda,
  findShareMintPda,
  findVaultAuthorityPda,
  findVaultPda,
  getDepositRequestDecoder,
  getDepositRequestEncoder,
  getDepositRequestSize,
  getDepositRequestedEventEncoder,
  getEpochRecordDecoder,
  getEpochRecordEncoder,
  getEpochRecordSize,
  getEpochStruckEventEncoder,
  getVaultDecoder,
  getVaultEncoder,
  getVaultSize,
  getWithdrawRequestDecoder,
  getWithdrawRequestEncoder,
  getWithdrawRequestSize,
  getWithdrawRequestedEventEncoder,
  type DepositRequest,
  type EpochRecord,
  type Vault,
  type WithdrawRequest,
} from "../../../clients/js/src/generated/fade/index.ts";
import { EVENT_IX_TAG, PROGRAM, TOKEN, cfg } from "../../../apps/keeper/src/chain.ts";
import { REFUSALS_TO_CONFIRM } from "../../../apps/keeper/src/rpcHistory.ts";
import {
  depositOwnersOf,
  providersView,
  type ProvidersView,
} from "../../../apps/keeper/src/providersIndex.ts";
import { parseKeeperProviders } from "../../../apps/web/src/lib/keeperViews.ts";
import {
  TOKEN_ACCOUNT_SIZE,
  providerLines,
  providerRows,
  shareHoldersOf,
  valueOf,
} from "../../../apps/web/src/lib/providers.ts";
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

type StatsObject = { providers(): Promise<ProvidersView>; alarm(): Promise<void> };
// Imported by a computed path: the Workers types it needs are the keeper's own typecheck's.
const STATS_MODULE = "../../../apps/keeper/src/stats.ts";
const { Stats } = (await import(STATS_MODULE)) as {
  Stats: new (ctx: unknown, env: unknown) => StatsObject;
};

function memoryState() {
  const db = new DatabaseSync(":memory:");
  return {
    storage: {
      sql: {
        exec: (q: string, ...b: (string | number | null)[]) => {
          const rows = db.prepare(q).all(...b);
          return { toArray: () => rows, one: () => rows[0] };
        },
      },
      transactionSync: <T>(fn: () => T) => fn(),
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
  };
}

const NOW = 1_800_000_000;
const DAY = 86_400;
const USDC = 1_000_000n;
const SHARE = 1_000_000_000n;
const b58 = (bytes: ArrayLike<number>) => getBase58Decoder().decode(Uint8Array.from(bytes));
const A = (s: string) =>
  b58(Array.from({ length: 32 }, (_, i) => s.charCodeAt(i % s.length) + i)) as Address;
const sig = (n: number) =>
  b58(Array.from({ length: 64 }, (_, i) => (i < 4 ? (n >> (i * 8)) & 255 : (i * 5 + 1) % 256)));
const base64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const emitted = (body: ArrayLike<number>) => b58([...EVENT_IX_TAG, ...Array.from(body)]);

const [[shareMint], [vaultAuthority], [vaultPda], [queue]] = await Promise.all([
  findShareMintPda(cfg),
  findVaultAuthorityPda(cfg),
  findVaultPda(cfg),
  findQueuePda(cfg),
]);

/** A token account of `mint` held by `owner`. */
function tokenAccount(owner: Address, amount: bigint, mint: Address = shareMint): Uint8Array {
  const d = new Uint8Array(TOKEN_ACCOUNT_SIZE);
  d.set(getAddressEncoder().encode(mint), 0);
  d.set(getAddressEncoder().encode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
}

const zero = <T>(decode: (b: Uint8Array) => T, size: number) => decode(new Uint8Array(size));

/** Every account the list is made of: share accounts, open requests and records, the vault. */
function chainState(seed: number) {
  const r = rng(seed);
  const owners = Array.from({ length: 14 }, (_, i) => A(`lp${i}`));
  const tokens: Uint8Array[] = [];
  for (const [i, o] of owners.entries()) {
    if (i % 5 === 4) continue; // a depositor still waiting for its first price
    tokens.push(tokenAccount(o, r.big(1n, 5_000n) * SHARE));
    if (i % 3 === 0) tokens.push(tokenAccount(o, r.big(1n, 50n) * SHARE)); // a second account
  }
  tokens.push(tokenAccount(A("emptied"), 0n));
  tokens.push(tokenAccount(vaultAuthority, 900n * SHARE)); // the vault's escrow
  const zd = zero((b) => getDepositRequestDecoder().decode(b), getDepositRequestSize());
  const zw = zero((b) => getWithdrawRequestDecoder().decode(b), getWithdrawRequestSize());
  const zr = zero((b) => getEpochRecordDecoder().decode(b), getEpochRecordSize());
  const deposits: DepositRequest[] = owners
    .filter((_, i) => i % 5 === 4 || i % 4 === 1)
    .map((owner, k) => ({
      ...zd,
      owner,
      epochId: 40n + BigInt(k % 2),
      amount: r.big(1n, 900n) * USDC,
      parked: k === 2,
    }));
  const records: EpochRecord[] = [
    { ...zr, epochId: 38n, chainId: 7n, rAfter: 600_000_000_000_000_000n },
    { ...zr, epochId: 39n, chainId: 7n, rAfter: 250_000_000_000_000_000n },
  ];
  const withdraws: WithdrawRequest[] = owners
    .filter((_, i) => i % 4 === 2)
    .map((owner, k) => ({
      ...zw,
      owner,
      epochId: 37n + BigInt(k),
      shares: r.big(1n, 800n) * SHARE,
      rEntry: k % 2 ? 1_000_000_000_000_000_000n : 0n,
      chainId: 7n,
      parked: k === 3,
    }));
  const vault: Vault = {
    ...zero((b) => getVaultDecoder().decode(b), getVaultSize()),
    totalAssets: 61_000n * USDC,
    openVaultCredits: 900n * USDC,
    totalShares: 57_500n * SHARE,
  };
  return { tokens, deposits, withdraws, records, vault };
}
type ChainState = ReturnType<typeof chainState>;

/** The list the app works out over the same accounts, read and decoded its own way. */
function appLines(s: ChainState, first: ReadonlyMap<Address, number> = new Map()) {
  const at = (data: unknown, i: number, k: string) => ({ address: A(`${k}${i}`), data }) as never;
  return providerLines(
    providerRows(
      shareHoldersOf(s.tokens, vaultAuthority),
      s.deposits.map((d, i) => at(d, i, "dep")),
      s.withdraws.map((w, i) => at(w, i, "wd")),
      s.records.map((r, i) => at(r, i, "rec")),
    ),
    s.vault,
    first,
  );
}

const depositTx = (...owners: Address[]) => ({
  meta: {
    err: null,
    innerInstructions: [
      {
        instructions: [
          ...owners.map((owner) => ({
            programIdIndex: 1,
            data: emitted(
              getDepositRequestedEventEncoder().encode({
                version: 1,
                owner,
                epochId: 40n,
                amount: USDC,
              }),
            ),
          })),
          // what a Queue transaction also says, which the first deposits ignore
          {
            programIdIndex: 1,
            data: emitted(
              getWithdrawRequestedEventEncoder().encode({
                version: 1,
                owner: A("lp2"),
                epochId: 40n,
                shares: SHARE,
              }),
            ),
          },
        ],
      },
    ],
  },
  transaction: { message: { accountKeys: [A("Payer"), PROGRAM] } },
});
const strikeTx = () => ({
  meta: {
    err: null,
    innerInstructions: [
      {
        instructions: [
          {
            programIdIndex: 1,
            data: emitted(
              getEpochStruckEventEncoder().encode({
                version: 1,
                epochId: 39n,
                totalAssets: 1n,
                totalShares: 1n,
                deposits: 0n,
                sharesMinted: 0n,
                withdrawShares: 0n,
                assetsOwed: 0n,
                assetsPaid: 0n,
                sharesBurnt: 0n,
                reward: 0n,
              }),
            ),
          },
        ],
      },
    ],
  },
  transaction: { message: { accountKeys: [A("Payer"), PROGRAM] } },
});

type QueueTx = { signature: string; at: number; tx: ReturnType<typeof depositTx> };

/** The Queue's history, oldest first: deposits of `lp0`..`lp13`, several each, and closes. */
function queueHistory(seed: number, n: number): QueueTx[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const at = NOW - 40 * DAY + i * 600;
    const tx =
      r.int(4) === 0
        ? (strikeTx() as never)
        : depositTx(...Array.from({ length: 1 + r.int(2) }, () => A(`lp${r.int(14)}`)));
    return { signature: sig(i + 1), at, tx };
  });
}

/** The earliest deposit request of each owner in `h`. */
function firstOf(h: readonly QueueTx[]): Map<Address, number> {
  const out = new Map<Address, number>();
  for (const x of h)
    for (const owner of depositOwnersOf(x.tx, PROGRAM))
      if (!out.has(owner) || x.at < out.get(owner)!) out.set(owner, x.at);
  return out;
}

const disc = (o: { filters?: { memcmp?: { bytes: string } }[] }) =>
  o.filters?.find((f) => f.memcmp)?.memcmp?.bytes;

/** A Stats Durable Object over `s` and the Queue's history `h` through a scripted RPC. */
function statsOver(s: ChainState, h: readonly QueueTx[]) {
  const calls = {
    programAccounts: 0,
    queueListings: 0,
    reads: [] as string[],
    fail: new Set(),
    // the signatures the RPC lists (a node's bounded history)
    held: (_s: string) => true,
    // whether it refuses a listing bounded by `bound` with -32020, as Agave refuses one it does
    // not hold (or a node behind one it has not seen yet); asked once a bound a call
    refuses: (bound: string): boolean => !calls.held(bound),
    refused: [] as string[],
  };
  const account = (data: Uint8Array) => ({
    data: [base64(data), "base64"],
    owner: PROGRAM,
    lamports: 1n,
    executable: false,
    space: BigInt(data.length),
  });
  const listed = (bytes: Uint8Array[], k: string) =>
    bytes.map((d, i) => ({ pubkey: A(`${k}${i}`), account: account(d) }));
  const byNewest = () => [...h].reverse();
  const rpc = {
    getProgramAccounts: (program: string, o: { filters?: { memcmp?: { bytes: string } }[] }) => ({
      send: async () => {
        calls.programAccounts += 1;
        if (program === TOKEN) {
          expect(disc(o)).toBe(shareMint);
          return listed(s.tokens, "tok");
        }
        const d = disc(o);
        const enc = <T>(list: T[], e: { encode(v: T): ArrayLike<number> }, k: string) =>
          listed(
            list.map((v) => Uint8Array.from(e.encode(v))),
            k,
          );
        const dep = enc(s.deposits, getDepositRequestEncoder(), "dep");
        const wd = enc(s.withdraws, getWithdrawRequestEncoder(), "wd");
        const rec = enc(s.records, getEpochRecordEncoder(), "rec");
        const first8 = (x: { account: { data: string[] } }) =>
          b58(Buffer.from(x.account.data[0]!, "base64").subarray(0, 8));
        return [...dep, ...wd, ...rec].filter((x) => first8(x) === d);
      },
    }),
    getAccountInfo: (a: string) => ({
      send: async () => ({
        value: a === vaultPda ? account(Uint8Array.from(getVaultEncoder().encode(s.vault))) : null,
      }),
    }),
    getSignaturesForAddress: (
      a: string,
      o: { until?: string; before?: string; limit: number },
    ) => ({
      send: async () => {
        if (a !== queue) return [];
        calls.queueListings += 1;
        for (const bound of [o.until, o.before])
          if (bound !== undefined && calls.refuses(bound)) {
            calls.refused.push(bound);
            throw new SolanaError(
              SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND,
              { __serverMessage: `Transaction ${bound} not found` },
            );
          }
        // each listed at its slot: its index in `h`, plus one
        const slot = new Map(h.map((x, i) => [x.signature, BigInt(i + 1)]));
        const kept = new Set(h.map((x) => x.signature).filter((s) => calls.held(s)));
        let list = byNewest().filter((x) => kept.has(x.signature));
        if (o.before !== undefined)
          list = list.slice(list.findIndex((x) => x.signature === o.before) + 1);
        if (o.until !== undefined) {
          const k = list.findIndex((x) => x.signature === o.until);
          if (k !== -1) list = list.slice(0, k);
        }
        return list.slice(0, o.limit).map((x) => ({
          signature: x.signature,
          slot: slot.get(x.signature)!,
          err: null,
          blockTime: BigInt(x.at),
        }));
      },
    }),
    getTransaction: (signature: string) => ({
      send: async () => {
        calls.reads.push(signature);
        if (calls.fail.has(signature)) return null;
        const x = h.find((y) => y.signature === signature)!;
        return { ...x.tx, blockTime: BigInt(x.at), version: 1 };
      },
    }),
    getMultipleAccounts: (list: string[]) => ({
      send: async () => ({ value: list.map(() => null) }),
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
  return { stats, tick, calls, meta };
}

/** The keeper's answer as the app reads it. */
const asRead = (v: ProvidersView) => parseKeeperProviders(JSON.parse(JSON.stringify(v)))!;

describe("the providers' answer", () => {
  it("is the app's own list over the same accounts, largest holding first, the vault's escrow left out", () => {
    for (const seed of [1, 2, 3]) {
      const s = chainState(seed);
      const at = (data: unknown, i: number, k: string) =>
        ({ address: A(`${k}${i}`), data }) as never;
      const view = providersView({
        holders: shareHoldersOf(s.tokens, vaultAuthority),
        deposits: s.deposits.map((d, i) => at(d, i, "dep")),
        withdraws: s.withdraws.map((w, i) => at(w, i, "wd")),
        records: s.records.map((r, i) => at(r, i, "rec")),
        vault: s.vault,
        firstDeposits: new Map([[A("lp0"), NOW - DAY]]),
        firstDepositsKnown: true,
        now: NOW,
      });
      const read = asRead(view);
      expect(read.lines).toEqual(appLines(s, new Map([[A("lp0"), NOW - DAY]])));
      expect(view.count).toBe(read.lines.length);
      expect(read.firstDepositsSyncing).toBe(false);
      expect(read.lines.some((l) => l.owner === vaultAuthority)).toBe(false);
      expect(read.lines.some((l) => l.owner === A("emptied"))).toBe(false);
      for (const l of read.lines) expect(l.value).toBe(valueOf(l.shares + l.sharesOut, s.vault));
      // a provider waiting for its first price is listed, with nothing in its wallet
      expect(read.lines.find((l) => l.owner === A("lp4"))).toMatchObject({ shares: 0n });
    }
  });

  it("knows no first deposit until the Queue's history is read back to the start", () => {
    const s = chainState(4);
    const view = providersView({
      holders: shareHoldersOf(s.tokens, vaultAuthority),
      deposits: [],
      withdraws: [],
      records: [],
      vault: s.vault,
      firstDeposits: new Map([[A("lp0"), NOW - DAY]]),
      firstDepositsKnown: false,
      now: NOW,
    });
    expect(view.firstDepositsSyncing).toBe(true);
    expect(view.rows.every((r) => r.firstDepositAt === null)).toBe(true);
  });

  it("reads the owners of the deposit requests a transaction emits, and nothing of a failed one", () => {
    expect(depositOwnersOf(depositTx(A("lp1"), A("lp2")), PROGRAM)).toEqual([A("lp1"), A("lp2")]);
    expect(depositOwnersOf(strikeTx() as never, PROGRAM)).toEqual([]);
    const failed = depositTx(A("lp1"));
    expect(depositOwnersOf({ ...failed, meta: { ...failed.meta, err: {} } }, PROGRAM)).toEqual([]);
  });
});

describe("the Stats Durable Object's providers", () => {
  let now = NOW * 1_000;
  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    now = NOW * 1_000;
  });

  it("serves the app's list at once, then the first deposits once the Queue's history is read", async () => {
    const s = chainState(5);
    const h = queueHistory(6, 2_300);
    const { stats, tick, calls } = statsOver(s, h);
    const first = asRead(await stats.providers());
    expect(first.firstDepositsSyncing).toBe(true);
    expect(first.lines).toEqual(appLines(s));
    // one read of the share accounts, the three kinds of requests and records
    expect(calls.programAccounts).toBe(4);

    for (let i = 0; i < 200 && (await tick()); i++);
    // every Queue transaction read, each once while none failed
    expect(new Set(calls.reads).size).toBe(h.length);
    expect(calls.reads.length).toBe(h.length);
    now += 120_000;
    await tick();
    const known = asRead(await stats.providers());
    expect(known.firstDepositsSyncing).toBe(false);
    expect(known.lines).toEqual(appLines(s, firstOf(h)));
    expect(known.lines.filter((l) => l.firstDepositAt !== null).length).toBeGreaterThan(5);
  });

  it("follows the Queue's new transactions, a later deposit never moving a first one", async () => {
    const s = chainState(7);
    const all = queueHistory(8, 300);
    const h = all.slice(0, 200);
    const { stats, tick, calls } = statsOver(s, h);
    await stats.providers();
    for (let i = 0; i < 50 && (await tick()); i++);
    const listings = calls.queueListings;
    // newer transactions: once the first deposits are known, a round starts every 10 minutes
    // (step 2 keeps them meanwhile), and lists them alone, back to the cursor
    h.push(...all.slice(200));
    for (let i = 0; i < 5; i++) await tick();
    expect(calls.queueListings).toBe(listings);
    now += 10 * 60_000;
    for (let i = 0; i < 50 && (await tick()); i++);
    expect(calls.queueListings).toBeGreaterThan(listings);
    expect(new Set(calls.reads).size).toBe(all.length);
    expect(calls.reads.length).toBe(all.length);
    now += 120_000;
    await tick();
    expect(asRead(await stats.providers()).lines).toEqual(appLines(s, firstOf(all)));
  });

  it("waits for a Queue transaction the RPC does not serve before saying the first deposits are known", async () => {
    const s = chainState(9);
    const h = queueHistory(10, 120);
    const { stats, tick, calls } = statsOver(s, h);
    calls.fail.add(h[0]!.signature);
    await stats.providers();
    for (let i = 0; i < 30; i++) await tick();
    now += 120_000;
    await tick();
    expect((await stats.providers()).firstDepositsSyncing).toBe(true);
    // served again, after its backoff
    calls.fail.clear();
    now += 3_600_000;
    for (let i = 0; i < 5; i++) await tick();
    now += 120_000;
    await tick();
    const known = asRead(await stats.providers());
    expect(known.firstDepositsSyncing).toBe(false);
    expect(known.lines).toEqual(appLines(s, firstOf(h)));
  });

  it("serves the first deposits without a Queue transaction the RPC never serves, and keeps it once served", async () => {
    const s = chainState(14);
    const h = queueHistory(15, 120);
    // the oldest deposit transaction, the only one holding its owner's first request
    const lost = h.find((x) => depositOwnersOf(x.tx, PROGRAM).length > 0)!;
    const { stats, tick, calls } = statsOver(s, h);
    calls.fail.add(lost.signature);
    await stats.providers();
    for (let i = 0; i < 30; i++) await tick();
    // read again on its backoff (1 min doubling, capped at an hour) until it is given up on
    let tries = 1;
    for (let i = 0; i < 12 && tries < 8; i++) {
      now += 3_600_000;
      await tick();
      tries = calls.reads.filter((r) => r === lost.signature).length;
      now += 120_000;
      await tick();
      if (tries < 8) expect((await stats.providers()).firstDepositsSyncing).toBe(true);
    }
    expect(tries).toBe(8);
    now += 120_000;
    await tick();
    const without = asRead(await stats.providers());
    expect(without.firstDepositsSyncing).toBe(false);
    const rest = firstOf(h.filter((x) => x !== lost));
    expect(rest).not.toEqual(firstOf(h));
    expect(without.lines).toEqual(appLines(s, rest));
    // still read every hour: once served, its owners' earliest requests are kept
    calls.fail.clear();
    now += 3_600_000;
    for (let i = 0; i < 3; i++) await tick();
    now += 120_000;
    await tick();
    const known = asRead(await stats.providers());
    expect(known.firstDepositsSyncing).toBe(false);
    expect(known.lines).toEqual(appLines(s, firstOf(h)));
  });

  it("takes one refusal of the Queue's cursor, from a node behind, as nothing: the next tick lists from it", async () => {
    const s = chainState(14);
    const all = queueHistory(15, 300);
    const h = all.slice(0, 200);
    const { stats, tick, calls, meta } = statsOver(s, h);
    await stats.providers();
    for (let i = 0; i < 50 && (await tick()); i++);
    const cursor = meta("lp_cursor")!;
    expect(cursor).toBe(h.at(-1)!.signature);
    expect(meta("lp_cursor_slot")).toBe(String(h.length));
    h.push(...all.slice(200));
    // a load-balanced provider's node a slot or two behind refuses the fresh cursor, once
    let lagging = true;
    calls.refuses = (bound) => {
      if (bound !== cursor || !lagging) return false;
      lagging = false;
      return true;
    };
    now += 10 * 60_000;
    await tick();
    // nothing irreversible: the cursor kept, the refusal noted alone
    expect(calls.refused).toEqual([cursor]);
    expect(meta("lp_cursor")).toBe(cursor);
    expect(meta("lp_round_cursor_lost")).toBeUndefined();
    expect(JSON.parse(meta("refusal_lp")!)).toMatchObject({ bound: cursor, count: 1 });
    // asked again on the next tick, which lists the new transactions alone
    for (let i = 0; i < 50 && (await tick()); i++);
    expect(calls.refused).toEqual([cursor]);
    expect(meta("refusal_lp")).toBeUndefined();
    expect(meta("lp_cursor")).toBe(all.at(-1)!.signature);
    expect(calls.reads.length).toBe(all.length);
    expect(new Set(calls.reads).size).toBe(all.length);
    now += 120_000;
    await tick();
    expect(asRead(await stats.providers()).lines).toEqual(appLines(s, firstOf(all)));
  });

  it("lists back to the Queue's cursor's slot alone once the RPC lastingly refuses the cursor, reading nothing older again", async () => {
    const s = chainState(16);
    const all = queueHistory(17, 300);
    const h = all.slice(0, 200);
    const { stats, tick, calls, meta } = statsOver(s, h);
    await stats.providers();
    for (let i = 0; i < 50 && (await tick()); i++);
    const cursor = meta("lp_cursor")!;
    h.push(...all.slice(200));
    // the cursor alone gone (a `confirmed` signature its fork dropped), every older one held
    calls.held = (sig) => sig !== cursor;
    now += 10 * 60_000;
    for (let i = 0; i < 20 && meta("lp_cursor") === cursor; i++) {
      await tick();
      now += 30_000;
    }
    expect(calls.refused).toEqual(Array(REFUSALS_TO_CONFIRM).fill(cursor));
    for (let i = 0; i < 50 && (await tick()); i++);
    // the new transactions read, nothing listed before the cursor's slot read again
    expect(calls.reads.length).toBe(all.length);
    expect(new Set(calls.reads).size).toBe(all.length);
    expect(meta("lp_cursor")).toBe(all.at(-1)!.signature);
    expect(meta("lp_cursor_slot")).toBe(String(all.length));
    expect(meta("lp_round_cursor_lost")).toBeUndefined();
    expect(meta("refusal_lp")).toBeUndefined();
    now += 120_000;
    await tick();
    expect(asRead(await stats.providers()).lines).toEqual(appLines(s, firstOf(all)));
  });

  it.each([
    ["once, by a node behind: the round lists on past it", 1],
    ["lastingly: the round ends with what it listed", Infinity],
  ] as const)("takes a refusal of where the Queue's listing stopped %s", async (_, times) => {
    const s = chainState(18);
    const h = queueHistory(19, 2_300);
    const { stats, tick, calls, meta } = statsOver(s, h);
    // the third page's bound, newest first: the last of the second page
    const stop = [...h].reverse()[1_999]!.signature;
    let left = times;
    calls.refuses = (bound) => bound === stop && left-- > 0;
    await stats.providers();
    for (let i = 0; i < 200; i++) {
      await tick();
      now += 30_000;
    }
    expect(calls.refused).toEqual(Array(times === 1 ? 1 : REFUSALS_TO_CONFIRM).fill(stop));
    expect(meta("refusal_lp")).toBeUndefined();
    expect(meta("lp_round_before")).toBeUndefined();
    expect(meta("lp_cursor")).toBe(h.at(-1)!.signature);
    // each listed transaction read once: the whole history, or the 2 000 newest
    expect(calls.reads.length).toBe(times === 1 ? h.length : 2_000);
    expect(new Set(calls.reads).size).toBe(calls.reads.length);
  });

  it("keeps the answer, builds it again at most every 2 minutes, and waits for one past 10", async () => {
    const s = chainState(11);
    const { stats, calls } = statsOver(s, []);
    const a = await stats.providers();
    expect(calls.programAccounts).toBe(4);
    now += 60_000;
    expect(await stats.providers()).toEqual(a);
    expect(calls.programAccounts).toBe(4);
    // two minutes old: the kept one served, a new read in the background
    s.vault = { ...s.vault, totalAssets: s.vault.totalAssets * 2n };
    now += 61_000;
    expect(await stats.providers()).toEqual(a);
    await vi.waitFor(async () => expect((await stats.providers()).updatedAt).not.toBe(a.updatedAt));
    expect(calls.programAccounts).toBe(8);
    const b = await stats.providers();
    expect(asRead(b).lines).toEqual(appLines(s));
    // past ten minutes: the request waits for a new read
    now += 11 * 60_000;
    const c = await stats.providers();
    expect(calls.programAccounts).toBe(12);
    expect(c.updatedAt).toBe(new Date(now).toISOString().replace(/\.\d{3}Z$/, ".000Z"));
  });

  it("reads neither the accounts nor the Queue's history while nobody asks for the list", async () => {
    const s = chainState(12);
    const { stats, tick, calls } = statsOver(s, queueHistory(13, 50));
    for (let i = 0; i < 5; i++) await tick();
    expect(calls.programAccounts).toBe(0);
    expect(calls.queueListings).toBe(0);
    await stats.providers();
    await tick();
    expect(calls.queueListings).toBeGreaterThan(0);
    // an hour and more without a request: the loop stops following it
    now += 3_601_000;
    const listings = calls.queueListings;
    const reads = calls.programAccounts;
    for (let i = 0; i < 3; i++) await tick();
    expect(calls.queueListings).toBe(listings);
    expect(calls.programAccounts).toBe(reads);
  });
});
