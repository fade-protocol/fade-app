// The keeper's all-time figures (apps/keeper/src/statsIndex.ts): the ticket events read back
// from a transaction's `emit_cpi!` inner instructions, and the totals they add up to.
import { getBase58Decoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  getPayoutClaimedEventEncoder,
  getRoundPayoutClaimedEventEncoder,
  getRoundTicketReturnedEventEncoder,
  getRoundTicketSettledEventEncoder,
  getTicketExpiredEventEncoder,
  getTicketJoinedEventEncoder,
  getTicketOpenedEventEncoder,
  getTicketSettledEventEncoder,
} from "../../../clients/js/src/generated/fade/index.ts";
import { EVENT_IX_TAG, PROGRAM } from "../../../apps/keeper/src/chain.ts";
import {
  applyTx,
  emptyTotals,
  splitFrom,
  splitJson,
  ticketEventsOf,
  type JsonTx,
  type OpenTicket,
  type TicketEvent,
  type Totals,
} from "../../../apps/keeper/src/statsIndex.ts";
import { payout } from "../../../apps/web/src/lib/math.ts";
import { BOOSTER_PAYOUT } from "../../../apps/web/src/lib/ticketKind.ts";
import { checkoutPayoutTable } from "../../../apps/web/src/lib/payoutTables.ts";

const b58 = (bytes: ArrayLike<number>) => getBase58Decoder().decode(Uint8Array.from(bytes));
/** A valid address named after `s`: its bytes are the name's, padded. */
const A = (s: string) =>
  b58(Array.from({ length: 32 }, (_, i) => s.charCodeAt(i % s.length) + i)) as Address;
const SECOND_APP = A("SecondApp");
const APP = A("App");
const OTHER_PROGRAM = A("Other");
const USDC = 1_000_000n;

const emitted = (body: ArrayLike<number>) => b58([...EVENT_IX_TAG, ...Array.from(body)]);

const openedData = (ticket: Address, integrator: Address, price: bigint, payoutMax: bigint) =>
  emitted(
    getTicketOpenedEventEncoder().encode({
      version: 1,
      ticket,
      integrator,
      nonce: 1,
      beneficiary: A("Ben"),
      price,
      vaultCredit: price,
      payoutMax,
      reservedLiability: payoutMax,
      cap: payoutMax,
      marginBps: 350,
      appShareBps: 0,
      openSlot: 10,
    }),
  );
const settledData = (ticket: Address, integrator: Address, paid: bigint) =>
  emitted(
    getTicketSettledEventEncoder().encode({
      version: 1,
      ticket,
      integrator,
      outcome: paid > 0n ? 1 : 0,
      payout: paid,
      pending: false,
    }),
  );
const expiredData = (ticket: Address, integrator: Address) =>
  emitted(
    getTicketExpiredEventEncoder().encode({
      version: 2,
      ticket,
      integrator,
      forfeited: 0,
      requested: false,
      requestFound: false,
      checked: true,
      pending: false,
      refunded: false,
      refund: 0,
      parked: false,
      ticketForfeitsWithheld: 0,
    }),
  );
const ROUND = A("Round");
const joinedData = (ticket: Address, integrator: Address, price: bigint, payoutMax: bigint) =>
  emitted(
    getTicketJoinedEventEncoder().encode({
      version: 1,
      ticket,
      round: ROUND,
      integrator,
      nonce: 1,
      beneficiary: A("Ben"),
      refundTo: A("Ben"),
      payoutTable: A("Table"),
      price,
      vaultCredit: price,
      payoutMax,
      reservedLiability: payoutMax,
      cap: payoutMax,
      usage: payoutMax,
      protocolShare: 0,
      appShare: 0,
      prepay: 5_000,
      slot: 10,
      payer: A("Payer"),
      funder: A("Payer"),
      settleShare: 2_000,
    }),
  );
const roundSettledData = (ticket: Address, integrator: Address, paid: bigint, pending = false) =>
  emitted(
    getRoundTicketSettledEventEncoder().encode({
      version: 1,
      ticket,
      round: ROUND,
      integrator,
      outcome: paid > 0n ? 0 : 1,
      payout: paid,
      charge: 1_500,
      pending,
    }),
  );
const returnedData = (ticket: Address, refunded: boolean, price: bigint) =>
  emitted(
    getRoundTicketReturnedEventEncoder().encode({
      version: 1,
      ticket,
      round: ROUND,
      refunded,
      price: refunded ? price : 0n,
      lamports: 5_000,
      parked: false,
      charge: 0,
    }),
  );

/** A transaction whose inner instructions carry `datas`, each from `programs[i]` (the program by default). */
function tx(datas: string[], opts: { err?: unknown; programs?: Address[] } = {}): JsonTx {
  const keys = [A("Payer"), PROGRAM, OTHER_PROGRAM];
  return {
    meta: {
      err: opts.err ?? null,
      innerInstructions: [
        {
          instructions: datas.map((data, i) => ({
            programIdIndex: keys.indexOf(opts.programs?.[i] ?? PROGRAM),
            data,
          })),
        },
      ],
    },
    transaction: { message: { accountKeys: keys } },
  };
}

/** Feeds transactions in order, keeping the openings the way the Durable Object does. */
function run(txs: { events: TicketEvent[]; at: number; sig: string }[]): Totals {
  let totals = emptyTotals();
  const open = new Map<Address, OpenTicket>();
  for (const t of txs) {
    const r = applyTx(totals, t.events, {
      signature: t.sig,
      at: t.at,
      openOf: (k) => open.get(k) ?? null,
    });
    totals = r.totals;
    for (const [k, o] of r.opened) open.set(k, o);
    for (const k of r.closed) open.delete(k);
  }
  return totals;
}

describe("ticket events of a transaction", () => {
  it("decodes openings, settlements and expiries, in order", () => {
    const t1 = A("T1");
    const t2 = A("T2");
    const events = ticketEventsOf(
      tx([
        openedData(t1, APP, 2n * USDC, 50n * USDC),
        settledData(t1, APP, 50n * USDC),
        expiredData(t2, SECOND_APP),
      ]),
      PROGRAM,
    );
    expect(events).toEqual([
      {
        kind: "opened",
        ticket: t1,
        integrator: APP,
        price: 2n * USDC,
        payoutMax: 50n * USDC,
        beacon: false,
      },
      { kind: "settled", ticket: t1, integrator: APP, payout: 50n * USDC, beacon: false },
      { kind: "expired", ticket: t2, integrator: SECOND_APP },
    ]);
  });

  it("ignores failed transactions, other programs, other events and garbage", () => {
    const t = A("T");
    expect(ticketEventsOf(tx([settledData(t, APP, 1n)], { err: { Custom: 1 } }), PROGRAM)).toEqual(
      [],
    );
    expect(
      ticketEventsOf(tx([settledData(t, APP, 1n)], { programs: [OTHER_PROGRAM] }), PROGRAM),
    ).toEqual([]);
    const claimed = emitted(
      getPayoutClaimedEventEncoder().encode({
        version: 1,
        ticket: t,
        beneficiary: A("Ben"),
        payout: 5n,
      }),
    );
    // another event, a settlement cut short, an instruction that is not an event, invalid base58
    const short = b58([...EVENT_IX_TAG, 72, 40, 13, 3, 184, 159, 190, 211, 1, 2]);
    const valid = settledData(t, APP, 1n);
    expect(
      ticketEventsOf(tx([claimed, short, b58([1, 2, 3]), "0OIl", valid]), PROGRAM).map(
        (e) => e.kind,
      ),
    ).toEqual(["settled"]);
    expect(ticketEventsOf({ ...tx([]), meta: null }, PROGRAM)).toEqual([]);
  });
});

describe("beacon ticket events", () => {
  it("decodes joins, round settlements and returns, from a version-1 transaction", () => {
    const [t1, t2] = [A("J1"), A("J2")];
    // A version-1 transaction lists every account in its message: no loaded addresses.
    const v1 = {
      ...tx([
        joinedData(t1, APP, USDC / 10n, 195_600n),
        roundSettledData(t1, APP, 195_600n, true),
        returnedData(t2, true, USDC / 10n),
        returnedData(A("J3"), false, USDC / 10n),
      ]),
      version: 1,
    };
    expect(ticketEventsOf(v1, PROGRAM)).toEqual([
      {
        kind: "opened",
        ticket: t1,
        integrator: APP,
        price: USDC / 10n,
        payoutMax: 195_600n,
        beacon: true,
      },
      { kind: "settled", ticket: t1, integrator: APP, payout: 195_600n, beacon: true },
      { kind: "returned", ticket: t2 },
      { kind: "returned", ticket: A("J3") },
    ]);
  });

  it("does not take a parked payout's later claim for another payout", () => {
    const t = A("J");
    const claim = emitted(
      getRoundPayoutClaimedEventEncoder().encode({
        version: 1,
        ticket: t,
        destination: A("Ben"),
        amount: 195_600n,
      }),
    );
    expect(ticketEventsOf(tx([claim]), PROGRAM)).toEqual([]);
  });

  it("counts a join as opened, a settlement as drawn, its payout as a win, a return as no draw", () => {
    const price = USDC / 10n;
    const [won, lost, refunded, forfeited, mine] = ["W", "L", "R", "F", "M"].map(A) as [
      Address,
      Address,
      Address,
      Address,
      Address,
    ];
    const events = (datas: string[]) => ticketEventsOf(tx(datas), PROGRAM);
    const t = run([
      {
        sig: "1",
        at: 100,
        events: events([
          joinedData(won, SECOND_APP, price, 195_600n),
          joinedData(lost, SECOND_APP, price, 195_600n),
          joinedData(refunded, APP, price, 195_600n),
          joinedData(forfeited, APP, price, 195_600n),
          joinedData(mine, APP, price, 195_600n),
        ]),
      },
      // the winner's payout parked in escrow: counted, it is owed to the winner
      { sig: "2", at: 110, events: events([roundSettledData(won, SECOND_APP, 195_600n, true)]) },
      { sig: "3", at: 120, events: events([roundSettledData(lost, SECOND_APP, 0n)]) },
      {
        sig: "4",
        at: 130,
        events: events([
          returnedData(refunded, true, price),
          returnedData(forfeited, false, price),
        ]),
      },
      { sig: "5", at: 140, events: events([roundSettledData(mine, APP, 195_600n)]) },
    ]);
    expect(t.all).toMatchObject({
      ticketsOpened: 5,
      ticketsDrawn: 3,
      ticketsExpired: 2,
      wins: 2,
      paid: 2n * 195_600n,
    });
    expect(t.all.lastWin).toEqual({
      payout: 195_600n,
      kind: "Small ticket",
      ticket: mine,
      at: 140,
      signature: "5",
    });
    expect(t.all.biggestWin).toMatchObject({ ticket: won, kind: "Small ticket" });
  });

  it("names a beacon win a small ticket even when its join was not read", () => {
    const t = A("N");
    const totals = run([
      { sig: "1", at: 5, events: ticketEventsOf(tx([roundSettledData(t, APP, 9n)]), PROGRAM) },
    ]);
    expect(totals.all.lastWin).toMatchObject({ ticket: t, kind: "Small ticket" });
  });

  it("counts a return whose join was not read", () => {
    const [t, d] = [A("T"), A("D")];
    const r = applyTx(
      emptyTotals(),
      [
        { kind: "returned", ticket: t },
        { kind: "returned", ticket: d },
      ],
      { signature: "1", at: 1, openOf: () => null },
    );
    expect(r.totals.all.ticketsExpired).toBe(2);
    expect(r.totals.all.wins).toBe(0);
  });
});

describe("all-time totals", () => {
  const checkoutPrice = 2_500_000n;
  const checkoutMax = payout(checkoutPrice, checkoutPayoutTable(checkoutPrice)[0]!.m);
  const ev = {
    open: (t: Address, i: Address, price: bigint, payoutMax: bigint): TicketEvent => ({
      kind: "opened",
      ticket: t,
      integrator: i,
      price,
      payoutMax,
      beacon: false,
    }),
    settle: (t: Address, i: Address, paid: bigint): TicketEvent => ({
      kind: "settled",
      ticket: t,
      integrator: i,
      payout: paid,
      beacon: false,
    }),
    expire: (t: Address, i: Address): TicketEvent => ({
      kind: "expired",
      ticket: t,
      integrator: i,
    }),
  };

  it("counts draws, wins and payouts across every app", () => {
    const [c, s, b, x, n] = ["C", "S", "B", "X", "N"].map(A) as [
      Address,
      Address,
      Address,
      Address,
      Address,
    ];
    const t = run([
      { sig: "1", at: 100, events: [ev.open(c, APP, checkoutPrice, checkoutMax)] },
      { sig: "2", at: 110, events: [ev.open(s, SECOND_APP, USDC, 3n * USDC)] },
      {
        sig: "3",
        at: 120,
        events: [ev.open(b, SECOND_APP, USDC / 10n, (USDC / 10n) * BOOSTER_PAYOUT)],
      },
      { sig: "4", at: 130, events: [ev.settle(c, APP, checkoutMax)] },
      { sig: "5", at: 140, events: [ev.settle(s, SECOND_APP, 3n * USDC)] },
      { sig: "6", at: 150, events: [ev.settle(b, SECOND_APP, 0n)] },
      { sig: "7", at: 160, events: [ev.open(x, APP, USDC, 2n * USDC), ev.expire(x, APP)] },
      // a settlement whose opening was never read: counted, its kind unknown
      { sig: "8", at: 170, events: [ev.settle(n, SECOND_APP, 1n)] },
    ]);
    expect(t.all).toMatchObject({
      ticketsOpened: 4,
      ticketsDrawn: 4,
      ticketsExpired: 1,
      wins: 3,
      paid: checkoutMax + 3n * USDC + 1n,
    });
    expect(t.all.biggestWin).toEqual({
      payout: checkoutMax,
      kind: "Checkout",
      ticket: c,
      at: 130,
      signature: "4",
    });
    expect(t.all.lastWin).toMatchObject({ ticket: n, kind: null, at: 170, payout: 1n });
  });

  it("names the kind of a win from its opening: booster, checkout, else a swap", () => {
    const b = A("B");
    const s = A("S");
    const price = USDC / 10n;
    const t = run([
      {
        sig: "1",
        at: 1,
        events: [ev.open(b, APP, price, price * BOOSTER_PAYOUT), ev.settle(b, APP, price * 50n)],
      },
      { sig: "2", at: 2, events: [ev.open(s, APP, USDC, 7n * USDC)] },
      { sig: "3", at: 3, events: [ev.settle(s, APP, 7n * USDC)] },
    ]);
    expect(t.all.biggestWin).toMatchObject({ kind: "Swap", payout: 7n * USDC });
    expect(t.all.lastWin).toMatchObject({ kind: "Swap" });
    const only = run([
      {
        sig: "1",
        at: 1,
        events: [ev.open(b, APP, price, price * BOOSTER_PAYOUT), ev.settle(b, APP, price * 50n)],
      },
    ]);
    expect(only.all.biggestWin?.kind).toBe("Booster");
  });

  it("keeps the first of two equal biggest wins, and the latest as the last win", () => {
    const [p, q] = [A("P"), A("Q")];
    const t = run([
      { sig: "1", at: 10, events: [ev.settle(p, APP, 5n)] },
      { sig: "2", at: 20, events: [ev.settle(q, APP, 5n)] },
    ]);
    expect(t.all.biggestWin?.ticket).toBe(p);
    expect(t.all.lastWin?.ticket).toBe(q);
  });

  it("an empty transaction changes nothing", () => {
    const before = emptyTotals();
    const r = applyTx(before, [], {
      signature: "x",
      at: 1,
      openOf: () => null,
    });
    expect(r.totals).toEqual(before);
    expect(r.opened.size + r.closed.size).toBe(0);
  });

  it("round-trips through storage, payouts beyond 2^53 included", () => {
    const big = 2n ** 60n + 7n;
    const t = run([{ sig: "9", at: 5, events: [ev.settle(A("Z"), APP, big)] }]);
    const back = splitFrom(JSON.stringify(splitJson(t.all)));
    expect(back).toEqual(t.all);
    expect(splitJson(t.all).paid).toBe(big.toString());
    expect(splitFrom(null)).toEqual(emptyTotals().all);
  });
});
