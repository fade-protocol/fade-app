// The keeper's all-time figures (apps/keeper/src/statsIndex.ts): the ticket events read back
// from a transaction's `emit_cpi!` inner instructions, and the totals they add up to.
import { getBase58Decoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  getPayoutClaimedEventEncoder,
  getTicketExpiredEventEncoder,
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
  emitted(getTicketExpiredEventEncoder().encode({ version: 1, ticket, integrator, forfeited: 0 }));

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
      { kind: "opened", ticket: t1, integrator: APP, price: 2n * USDC, payoutMax: 50n * USDC },
      { kind: "settled", ticket: t1, integrator: APP, payout: 50n * USDC },
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
    }),
    settle: (t: Address, i: Address, paid: bigint): TicketEvent => ({
      kind: "settled",
      ticket: t,
      integrator: i,
      payout: paid,
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
