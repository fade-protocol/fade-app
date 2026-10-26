// The app's side of the keeper's wallet history (GET /v1/wallet/:owner): reading the answer, and
// the wallet's tickets and deposits and withdrawals the dashboard shows, against a local stub of
// the route (serving what the keeper builds) and of the chain's JSON-RPC: the keeper's answer
// with the chain's transactions since it merged in, equal to the app's own reading of the whole
// history; the app's own reads whenever the keeper fails, is syncing, is too old, or the wallet
// has more new transactions than the merge reads; one request for every caller.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Address } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPayoutTableDecoder,
  getPayoutTableEncoder,
  getPayoutTableSize,
} from "../../../clients/js/src/generated/fade/index.ts";
import { PROGRAM } from "../../../apps/keeper/src/chain.ts";
import {
  walletView,
  type WalletTx,
  type WalletView,
} from "../../../apps/keeper/src/walletIndex.ts";
import { programEventsOf } from "../../../apps/web/src/lib/fadeEvents.ts";
import { walletTotals, type WalletKeys } from "../../../apps/web/src/lib/walletHistory.ts";
import {
  A,
  NOW,
  TABLE,
  TABLE_LHS,
  USDC,
  WALLETS,
  appWallet,
  eventTx,
  ev,
  plainEnd,
  sig,
  walletHistory,
  walletKeys,
  type HistoryTx,
} from "../keeper/walletFixtures.ts";

/** The keeper's answer is complete up to here; the chain's newer transactions are the tail. */
const CUT = NOW - 300;
const W = WALLETS[0];

let keys: WalletKeys;
let shareAccount: Address;
/** Every transaction of the chain, oldest first, and the accounts each one touches. */
let chain: HistoryTx[] = [];
const touched = new Map<string, Set<string>>();
/** GET /v1/wallet/:owner: its body, or an HTTP status. */
let answer: WalletView | { status: number } | unknown = { status: 503 };
const calls = { wallet: 0, signatures: [] as { account: string; limit: number }[] };
/** Accounts the stub lists as having more new transactions than any page. */
const busy = new Set<string>();

const base64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const zeroTable = getPayoutTableDecoder().decode(new Uint8Array(getPayoutTableSize()));
const tableData = base64(
  Uint8Array.from(getPayoutTableEncoder().encode({ ...zeroTable, lhs: TABLE_LHS })),
);

/** The accounts a transaction writes, as the chain would list it under them. */
function touches(x: HistoryTx): Set<string> {
  const out = new Set<string>();
  for (const e of programEventsOf(x.tx, PROGRAM)) {
    const d = e.data as Record<string, unknown>;
    for (const k of ["ticket", "integrator", "beneficiary"])
      if (typeof d[k] === "string") out.add(d[k] as string);
    if (typeof d.owner === "string" && d.owner === keys.owner)
      for (const a of [keys.owner, keys.usdcAccount, shareAccount]) out.add(a);
  }
  return out;
}

function setChain(h: HistoryTx[]) {
  chain = [...h].sort((a, b) => a.at - b.at || a.signature.localeCompare(b.signature));
  touched.clear();
  for (const x of chain) touched.set(x.signature, touches(x));
}

type RpcCall = { id: number; method: string; params: unknown[] };
function rpcAnswer(c: RpcCall): unknown {
  if (c.method === "getSignaturesForAddress") {
    const [account, opts] = c.params as [string, { limit?: number; before?: string }];
    calls.signatures.push({ account, limit: opts.limit ?? 1_000 });
    if (busy.has(account))
      return Array.from({ length: opts.limit ?? 1_000 }, (_, i) => ({
        signature: sig(500_000 + i),
        slot: 1,
        err: null,
        memo: null,
        blockTime: NOW - 1,
        confirmationStatus: "confirmed",
      }));
    let list = [...chain].reverse().filter((x) => touched.get(x.signature)!.has(account));
    if (opts.before) list = list.slice(list.findIndex((x) => x.signature === opts.before) + 1);
    return list.slice(0, opts.limit ?? 1_000).map((x) => ({
      signature: x.signature,
      slot: 1,
      err: null,
      memo: null,
      blockTime: x.at,
      confirmationStatus: "confirmed",
    }));
  }
  if (c.method === "getTransaction") {
    const x = chain.find((y) => y.signature === c.params[0]);
    return x ? { ...x.tx, slot: 1, blockTime: x.at, version: 0 } : null;
  }
  if (c.method === "getMultipleAccounts") {
    const [list] = c.params as [string[]];
    return {
      context: { slot: 1 },
      value: list.map((a) =>
        a === TABLE
          ? {
              data: [tableData, "base64"],
              owner: PROGRAM,
              lamports: 1,
              executable: false,
              space: 0,
              rentEpoch: 0,
            }
          : null,
      ),
    };
  }
  throw new Error(`unexpected ${c.method}`);
}

let server: Server;
let lib: typeof import("../../../apps/web/src/lib/keeperWallet.ts");
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/v1/wallet/")) {
        calls.wallet += 1;
        const a = answer as { status?: number };
        if (typeof a.status === "number") res.writeHead(a.status).end();
        else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
        return;
      }
      if (req.url === "/v1/rpc" && req.method === "POST") {
        const parsed = JSON.parse(body) as RpcCall | RpcCall[];
        const reply = (c: RpcCall) => ({ jsonrpc: "2.0", id: c.id, result: rpcAnswer(c) });
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(Array.isArray(parsed) ? parsed.map(reply) : reply(parsed)));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.VITE_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  delete process.env.VITE_RPC_URL;
  // the app's config, read again with it
  vi.resetModules();
  lib = await import("../../../apps/web/src/lib/keeperWallet.ts");
  const fade = await import("../../../apps/web/src/lib/fade.ts");
  keys = await walletKeys(W);
  shareAccount = await fade.ata(W, (await fade.pdas()).shareMint);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const stored = (h: readonly HistoryTx[]): WalletTx[] =>
  h.map((x) => ({
    signature: x.signature,
    at: x.at,
    slot: 0,
    events: programEventsOf(x.tx, PROGRAM),
  }));

/** What the keeper serves over `h`, complete up to `through`. */
const keeperOver = (h: readonly HistoryTx[], through = CUT, syncing = false) =>
  JSON.parse(
    JSON.stringify(
      walletView({
        keys,
        txs: stored(h),
        lhs: new Map([[TABLE, TABLE_LHS]]),
        through,
        syncing,
        now: NOW,
      }),
    ),
  ) as WalletView;

/**
 * A history whose last transactions come after CUT: a ticket the keeper saw opened is drawn with
 * a win, a beacon ticket of the wallet's own app joins and draws, another app opens one paying the
 * wallet (still drawing), and the wallet asks for a deposit.
 */
async function history() {
  const base = (await walletHistory(91, 50)).filter((x) => x.at < CUT - 1_000);
  let n = 900;
  const at = (t: number, ...datas: string[]): HistoryTx => ({
    signature: sig(++n),
    at: t,
    tx: eventTx(...datas),
  });
  const before = [
    at(CUT - 100, ev.opened(A("waiting"), keys.integrator, keys.usdcAccount, USDC, 40n * USDC)),
  ];
  const tail = [
    at(CUT + 20, ev.settled(A("waiting"), keys.integrator, 40n * USDC, false)),
    at(
      CUT + 30,
      ev.joined(A("new-beacon"), keys.integrator, keys.usdcAccount, keys.usdcAccount, 2n * USDC),
    ),
    at(CUT + 40, ev.roundSettled(A("new-beacon"), keys.integrator, 0n, false)),
    at(CUT + 50, ev.opened(A("new-direct"), A("OtherApp"), keys.usdcAccount, USDC, 30n * USDC)),
    at(CUT + 60, ev.deposit(keys.owner, 77n, 25n * USDC)),
  ];
  return { keeperPart: [...base, ...before], all: [...base, ...before, ...tail] };
}

const plain = <T extends { rows: Parameters<typeof plainEnd>[0][] }>(t: T) => ({
  ...t,
  rows: t.rows.map(plainEnd),
});

describe("the keeper's wallet history, read by the app", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => NOW * 1_000);
    calls.wallet = 0;
    calls.signatures.length = 0;
    busy.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("reads the answer as the keeper wrote it, and refuses one that does not read", async () => {
    const { all } = await history();
    const v = keeperOver(all);
    const k = lib.parseKeeperWallet(v)!;
    const own = appWallet(all, keys);
    expect(k.tickets.rows).toEqual(own.rows);
    expect(k.tickets.totals).toEqual(walletTotals(own.rows, keys));
    expect(k.lp.items).toEqual(own.items);
    expect(k.through).toBe(CUT);
    expect(k.syncing).toBe(false);
    const broken = (f: (j: WalletView) => void) => {
      const j = JSON.parse(JSON.stringify(v)) as WalletView;
      f(j);
      return lib.parseKeeperWallet(j);
    };
    expect(broken((j) => ((j.tickets.rows[0] as { price: unknown }).price = 12))).toBeNull();
    expect(
      broken((j) => ((j.lp.items[0]!.events[0] as { kind: string }).kind = "EpochStruck")),
    ).toBeNull();
    expect(broken((j) => delete (j.tickets as { totals?: unknown }).totals)).toBeNull();
    // an answer that does not say it is complete: taken as syncing
    expect(broken((j) => delete (j as { syncing?: boolean }).syncing)!.syncing).toBe(true);
  });

  it("merges the chain's transactions since the keeper's answer: the app's own reading of the whole history", async () => {
    const { keeperPart, all } = await history();
    setChain(all);
    answer = keeperOver(keeperPart);
    const [tickets, log] = await Promise.all([lib.walletTickets(W), lib.walletLog(W, null)]);
    // one request to the keeper for both
    expect(calls.wallet).toBe(1);
    const own = appWallet(all, keys);
    expect(plain(tickets)).toEqual({
      ...keys,
      rows: own.rows,
      totals: walletTotals(own.rows, keys),
      complete: { buyer: true, app: true },
    });
    expect(tickets.rows.slice(0, 2).map((r) => r.ticket)).toEqual([
      A("new-direct"),
      A("new-beacon"),
    ]);
    expect(tickets.rows.find((r) => r.ticket === A("waiting"))!.end?.payout).toBe(40n * USDC);
    // the new beacon ticket's margin, read from its payout table
    expect(tickets.rows[1]!.marginBps).toBe(220n);
    expect(log).toEqual(own.items);
    expect(log![0]!.events[0]).toMatchObject({ kind: "DepositRequested" });
    // the merge reads a page of each of the wallet's three accounts, no more
    expect(calls.signatures.every((c) => c.limit === lib.WALLET_TAIL_PAGE)).toBe(true);
    expect(new Set(calls.signatures.map((c) => c.account))).toEqual(
      new Set([keys.integrator, keys.usdcAccount, shareAccount]),
    );
    // the read says how fresh the keeper's index of the wallet is (lib/live `walletPollMs`)
    const read = await lib.walletTicketsRead(W);
    expect(read.through).toBe(CUT);
    expect(read.tickets.rows).toEqual(tickets.rows);
  });

  it("merges into a bounded answer with the counts over every ticket", async () => {
    const { keeperPart, all } = await history();
    setChain(all);
    const v = keeperOver(keeperPart);
    // as if the keeper listed only its newest two tickets
    const k = lib.parseKeeperWallet(v)!;
    const listed = k.tickets.rows.slice(0, 2);
    const t = lib.mergedHistory(
      { ...k, tickets: { ...k.tickets, rows: listed, complete: { buyer: false, app: false } } },
      { rows: [], loneEnds: [], from: null, truncated: false },
      [],
    ).tickets;
    expect(t.rows).toEqual(listed);
    expect(t.totals).toEqual(k.tickets.totals);
    expect(t.complete).toEqual({ buyer: false, app: false });
  });

  it("reads the wallet's history itself while the keeper fails, syncs, is too old, or the tail is too long", async () => {
    const { keeperPart, all } = await history();
    setChain(all);
    const ownRead = () => calls.signatures.some((c) => c.limit === 600);
    const cases: [string, () => void][] = [
      ["fails", () => (answer = { status: 503 })],
      ["syncs", () => (answer = keeperOver(keeperPart, CUT, true))],
      ["is too old", () => (answer = keeperOver(keeperPart, NOW - lib.WALLET_TAIL_MAX_S - 1))],
      [
        "has too long a tail",
        () => {
          answer = keeperOver(keeperPart);
          busy.add(keys.usdcAccount);
        },
      ],
      ["answers someone else", () => (answer = { ...keeperOver(keeperPart), owner: WALLETS[1] })],
    ];
    for (const [what, set] of cases) {
      calls.signatures.length = 0;
      busy.clear();
      set();
      const { tickets: t, through } = await lib.walletTicketsRead(W);
      expect(ownRead(), what).toBe(true);
      // the app's own reads: nothing says the keeper is indexing the wallet
      expect(through, what).toBeNull();
      expect(t.complete, what).toEqual({ buyer: true, app: true });
      expect(t.owner).toBe(W);
    }
    // the deposits and withdrawals wait for the vault's history, then read it
    answer = { status: 503 };
    expect(await lib.walletLog(W, null)).toBeNull();
    const vaultLog = all.flatMap((x) => {
      const events = programEventsOf(x.tx, PROGRAM).filter((e) => e.kind === "DepositRequested");
      return events.length ? [{ signature: x.signature as never, blockTime: x.at, events }] : [];
    });
    const log = await lib.walletLog(W, vaultLog);
    expect(log?.some((i) => i.events.some((e) => e.kind === "DepositRequested"))).toBe(true);
  });

  it("reads the owner's deposits and withdrawals itself when the keeper lists only the newest", async () => {
    const { keeperPart, all } = await history();
    setChain(all);
    const v = keeperOver(keeperPart);
    // as if the owner had more LP transactions than the keeper lists
    answer = { ...v, lp: { ...v.lp, truncated: true, items: v.lp.items.slice(0, 1) } };
    const vaultLog = all.flatMap((x) => {
      const events = programEventsOf(x.tx, PROGRAM).filter((e) => e.kind === "DepositRequested");
      return events.length ? [{ signature: x.signature as never, blockTime: x.at, events }] : [];
    });
    // never the keeper's newest alone: the app's own reading over the vault's history
    expect(await lib.walletLog(W, null)).toBeNull();
    const log = await lib.walletLog(W, vaultLog);
    const own = appWallet(all, keys).items.filter((i) =>
      i.events.some((e) => e.kind === "DepositRequested"),
    );
    expect(log!.length).toBeGreaterThan(1);
    expect(log!.filter((i) => i.events.some((e) => e.kind === "DepositRequested")).length).toBe(
      own.length,
    );
    const { fetchOwnerLog } = await import("../../../apps/web/src/lib/history.ts");
    expect(log).toEqual(await fetchOwnerLog(W, vaultLog));
    // its tickets still come from the keeper
    const t = await lib.walletTickets(W);
    expect(plain(t).rows).toEqual(appWallet(all, keys).rows);
    expect(calls.signatures.some((c) => c.limit === 600)).toBe(false);
  });

  it("keeps the owner's last history on screen when a poll fails before the vault's history is read", async () => {
    const { keeperPart, all } = await history();
    setChain(all);
    answer = keeperOver(keeperPart);
    const first = await lib.ownerLogPoll(W, null, null);
    expect(first?.owner).toBe(W);
    expect(first!.items).toEqual(appWallet(all, keys).items);
    // the keeper fails while the vault's history is still loading: the last answer stays
    answer = { status: 503 };
    expect(await lib.ownerLogPoll(W, null, first)).toBe(first);
    // nothing before the first answer, and never another owner's
    expect(await lib.ownerLogPoll(W, null, null)).toBeNull();
    expect(await lib.ownerLogPoll(WALLETS[1], null, first)).toBeNull();
    // once the vault's history is read, the app's own reading over it
    const vaultLog = all.flatMap((x) => {
      const events = programEventsOf(x.tx, PROGRAM).filter((e) => e.kind === "DepositRequested");
      return events.length ? [{ signature: x.signature as never, blockTime: x.at, events }] : [];
    });
    const own = await lib.ownerLogPoll(W, vaultLog, first);
    expect(own).not.toBe(first);
    expect(own!.items.some((i) => i.events.some((e) => e.kind === "DepositRequested"))).toBe(true);
  });

  it("keeps the keeper's answer as served when the chain has nothing newer", async () => {
    const { keeperPart } = await history();
    setChain(keeperPart);
    answer = keeperOver(keeperPart);
    const t = await lib.walletTickets(W);
    const own = appWallet(keeperPart, keys);
    expect(t.rows).toEqual(own.rows);
    expect(calls.signatures.some((c) => c.limit === 600)).toBe(false);
  });
});
