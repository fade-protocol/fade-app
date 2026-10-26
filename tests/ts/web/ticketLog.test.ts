// The app's figures from the program's tickets: the vault's APR now and over time, what each app
// brought in, which demo a ticket came from and its odds.
import type { Address, Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { FadeEvent } from "../../../apps/web/src/lib/events.ts";
import { BEACON_PAYOUT_TABLE } from "../../../apps/web/src/lib/beacon.ts";
import {
  APR_MIN_TICKETS,
  appShareOf,
  aprSeries,
  coveredFrom,
  estimateApr,
  kindOf,
  oddsOf,
  statsByApp,
  ticketLogOf,
  vaultMarginOf,
  volumeSeries,
  withBeaconMargins,
  type TicketLog,
  type TicketRow,
} from "../../../apps/web/src/lib/ticketLog.ts";
import { payout } from "../../../apps/web/src/lib/math.ts";
import {
  CART,
  checkoutPayoutTableFor,
  type CheckoutBack,
} from "../../../apps/web/src/lib/payoutTables.ts";
import { checkoutBackOf } from "../../../apps/web/src/lib/ticketKind.ts";
import { buyerLine, vaultLine, winWords } from "../../../apps/web/src/lib/ticketWords.ts";
import { rng } from "./fixtures.ts";

const A = (s: string) => s.padEnd(32, "1") as Address;
const NOW = 1_800_000_000;
const USDC = 1_000_000n;

const row = (over: Partial<TicketRow>): TicketRow => ({
  ticket: A("t"),
  integrator: A("i"),
  beneficiary: A("b"),
  price: USDC,
  payoutMax: 2n * USDC,
  vaultCredit: USDC,
  marginBps: 350n,
  appShareBps: 0n,
  openedAt: NOW - 60,
  openSig: "s" as Signature,
  end: null,
  ...over,
});
const log = (rows: TicketRow[], over: Partial<TicketLog> = {}): TicketLog => ({
  rows,
  loneEnds: [],
  from: NOW - 7 * 86400,
  truncated: false,
  ...over,
});

describe("the vault's APR", () => {
  it("annualises the vault margin of the last 7 days over the vault's assets", () => {
    // 10 tickets of 1 USDC at 3.5 % margin, 0.2 % protocol share: 0.33 USDC a week
    const rows = Array.from({ length: 10 }, (_, i) => row({ ticket: A(`t${i}`) }));
    // one older than 7 days does not count
    rows.push(row({ ticket: A("old"), openedAt: NOW - 8 * 86400, price: 1000n * USDC }));
    const apr = estimateApr(log(rows), 1000n * USDC, 20n, NOW);
    expect(apr.tickets).toBe(10);
    expect(apr.volume).toBe(10n * USDC);
    expect(apr.margin).toBe(330_000n);
    expect(apr.pct).toBeCloseTo((0.33 * 365 * 100) / 7 / 1000, 6);
  });

  it("leaves the app share out of the vault's margin", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ ticket: A(`t${i}`), appShareBps: 100n }),
    );
    expect(estimateApr(log(rows), 1000n * USDC, 20n, NOW).margin).toBe(115_000n);
  });

  it("says nothing with too few tickets", () => {
    expect(estimateApr(log([row({})]), 1000n * USDC, 20n, NOW).pct).toBeNull();
  });

  it("scales a read capped inside the 7 days up to them", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ ticket: A(`t${i}`) }));
    const capped = estimateApr(
      log(rows, { truncated: true, from: NOW - 21_600 }),
      1000n * USDC,
      20n,
      NOW,
    );
    expect(capped.volume).toBe(168n * USDC);
  });
});

describe("what a ticket was", () => {
  it("tells the demos apart by their worst case", () => {
    // a 5 USDC pack and its 0.10 USDC add-on: the worst case is a premium pack, 50 USDC
    expect(kindOf({ price: USDC / 10n, payoutMax: 50n * USDC }, true)).toBe("Booster");
    expect(kindOf({ price: USDC / 10n, payoutMax: 5n * USDC + USDC / 10n }, true)).toBe("Swap");
    expect(kindOf({ price: USDC, payoutMax: CART.total + USDC }, true)).toBe("Checkout");
    expect(kindOf({ price: USDC, payoutMax: 50n * USDC }, true)).toBe("Swap");
    expect(kindOf({ price: USDC, payoutMax: 50n * USDC }, false)).toBe("Ticket");
  });

  it("tells what a checkout win sends back: the whole order, half or a tenth of it", () => {
    const worst = (back: CheckoutBack, price: bigint) =>
      payout(price, checkoutPayoutTableFor(back)(price)[0]!.m);
    for (const price of [100_000n, 1_310_000n, 5_080_000n]) {
      for (const back of ["whole", "half", "tenth"] as const) {
        const r = { price, payoutMax: worst(back, price) };
        expect(checkoutBackOf(r)).toBe(back);
        expect(kindOf(r, true)).toBe("Checkout");
        expect(kindOf(r, false)).toBe("Checkout");
      }
    }
    // a swap that pays back a trade is no part of the order
    expect(checkoutBackOf({ price: USDC, payoutMax: 50n * USDC })).toBeNull();
    expect(checkoutBackOf({ price: 0n, payoutMax: 0n })).toBeNull();
  });

  it("names a checkout win by what came back, never a free order for a part of it", () => {
    const price = 1_310_000n;
    const lines = (["whole", "half", "tenth"] as const).map((back) => {
      const max = payout(price, checkoutPayoutTableFor(back)(price)[0]!.m);
      const r = row({
        price,
        payoutMax: max,
        end: { kind: "settled", payout: max, pending: false, at: NOW, signature: "e" as Signature },
      });
      return [
        winWords("Checkout", price, max),
        buyerLine(r, true).detail,
        vaultLine(r, true).title,
      ];
    });
    expect(lines).toEqual([
      ["free order", "came back free", "Order came back free"],
      ["half the order back", "half the order came back", "Half an order came back"],
      ["10% of the order back", "10% of the order came back", "10% of an order came back"],
    ]);
    // without the price, a checkout win reads as the whole order
    expect(winWords("Checkout", null, 94_260_002n)).toBe("free order");
  });

  it("reads the odds of an all-or-nothing ticket", () => {
    // p = 1 × 0.965 / 96.5 = 1 in 100
    const r = { price: USDC, payoutMax: 96_500_000n, marginBps: 350n };
    expect(oddsOf(r)).toBe("1 in 100");
  });

  it("reads the odds of any win of a booster add-on", () => {
    // 0.10 USDC on a 5 USDC pack: 965 000 + 9 650 000 out of 10⁹, 1 in 94.2, read as 1 in 95
    expect(oddsOf({ price: USDC / 10n, payoutMax: 50n * USDC, marginBps: 350n })).toBe("1 in 95");
    // the same shape on a 100 USDC pack
    expect(oddsOf({ price: 2n * USDC, payoutMax: 1000n * USDC, marginBps: 350n })).toBe("1 in 95");
  });
});

describe("per app", () => {
  it("counts the volume, and the vault's result on the tickets drawn", () => {
    const end = (payout: bigint) => ({
      kind: "settled" as const,
      payout,
      pending: false,
      at: NOW,
      signature: "e" as Signature,
    });
    const m = statsByApp(
      log([
        row({ ticket: A("a"), end: end(0n) }),
        row({ ticket: A("b"), end: end(3n * USDC) }),
        row({ ticket: A("c") }),
      ]),
    );
    const s = m.get(A("i"))!;
    expect(s.tickets).toBe(3);
    expect(s.volume).toBe(3n * USDC);
    expect(s.settled).toBe(2);
    expect(s.result).toBe(2n * USDC - 3n * USDC);
    expect(s.paidOut).toBe(3n * USDC);
  });

  it("buckets the volume over time", () => {
    const pts = volumeSeries(
      log([row({ openedAt: NOW - 10 }), row({ openedAt: NOW - 3_000 })]),
      NOW - 7_200,
      NOW,
      3_600,
    );
    expect(pts.map((p) => p.v)).toEqual([0, 2]);
  });
});

describe("beacon tickets", () => {
  const price = 100_000n;
  // the demo table's `Σ p·m`, as the program stores it on its PayoutTable
  const lhs = BEACON_PAYOUT_TABLE.reduce((n, o) => n + BigInt(o.p) * BigInt(o.m), 0n);
  const table = A("table");
  const joined = (ticket: Address, integrator = A("i"), appShare = 0n): FadeEvent =>
    ({
      kind: "TicketJoined",
      data: {
        ticket,
        round: A("round"),
        integrator,
        beneficiary: A("b"),
        payoutTable: table,
        price,
        vaultCredit: price - appShare - 200n,
        payoutMax: 195_600n,
        appShare,
        protocolShare: 200n,
      },
    }) as unknown as FadeEvent;
  const settled = (ticket: Address, payoutAmount: bigint, pending = false): FadeEvent =>
    ({
      kind: "RoundTicketSettled",
      data: { ticket, integrator: A("i"), payout: payoutAmount, pending },
    }) as unknown as FadeEvent;
  const returned = (ticket: Address, refunded: boolean, parked = false): FadeEvent =>
    ({ kind: "RoundTicketReturned", data: { ticket, refunded, parked } }) as unknown as FadeEvent;
  const claimed = (ticket: Address): FadeEvent =>
    ({ kind: "RoundPayoutClaimed", data: { ticket } }) as unknown as FadeEvent;
  /** One transaction per entry, oldest first; listed newest first, as the RPC lists them. */
  const logOf = (txs: FadeEvent[][]) => {
    const sigs = txs.map((_, i) => ({ signature: `s${i}` as Signature, blockTime: NOW - 600 + i }));
    const known = new Map(sigs.map((s, i) => [s.signature, { events: txs[i]! }]));
    return ticketLogOf([...sigs].reverse(), known, 1_000, NOW - 86_400);
  };

  it("reads a join as a ticket, its round settlement as its draw, a return as no draw", () => {
    const [w, l, r, f, lone] = ["w", "l", "r", "f", "lone"].map(A) as [
      Address,
      Address,
      Address,
      Address,
      Address,
    ];
    const log = logOf([
      [joined(w), joined(l), joined(r), joined(f)],
      [settled(w, 195_600n, true), settled(l, 0n)],
      [returned(r, true), returned(f, false), settled(lone, 195_600n)],
    ]);
    const byTicket = new Map(log.rows.map((x) => [x.ticket, x]));
    expect(log.rows).toHaveLength(4);
    expect(byTicket.get(w)!.end).toMatchObject({
      kind: "settled",
      payout: 195_600n,
      pending: true,
    });
    expect(byTicket.get(l)!.end).toMatchObject({ kind: "settled", payout: 0n });
    expect(byTicket.get(r)!.end).toMatchObject({ kind: "expired", payout: 0n, refunded: true });
    expect(byTicket.get(f)!.end).toMatchObject({ kind: "expired", payout: 0n });
    expect(byTicket.get(f)!.end!.refunded).toBeUndefined();
    expect(byTicket.get(w)!.beacon).toEqual({
      round: A("round"),
      payoutTable: table,
      appShare: 0n,
      protocolShare: 200n,
    });
    // every beacon ticket is the beacon demo's small ticket
    expect(log.rows.map((x) => kindOf(x, true))).toEqual(Array(4).fill("Small ticket"));
    expect(kindOf(byTicket.get(w)!, false)).toBe("Ticket");
    // a settlement whose join is older than the read
    expect(log.loneEnds).toEqual([
      expect.objectContaining({ ticket: lone, kind: "settled", payout: 195_600n, beacon: true }),
    ]);
  });

  it("keeps a parked return's price waiting until its claim, and a parked win's payout", () => {
    const [p, w, back] = ["p", "w", "back"].map(A) as [Address, Address, Address];
    const parked = logOf([
      [joined(p), joined(w), joined(back)],
      [returned(p, true, true), settled(w, 195_600n, true), returned(back, true)],
    ]);
    const byTicket = new Map(parked.rows.map((x) => [x.ticket, x]));
    expect(byTicket.get(p)!.end).toMatchObject({ kind: "expired", refunded: true, pending: true });
    expect(byTicket.get(back)!.end).toMatchObject({ refunded: true, pending: false });
    expect(byTicket.get(w)!.end).toMatchObject({ kind: "settled", pending: true });
    // claim_round_payout delivered both: nothing waits any more, the rest of the end stays
    const delivered = logOf([
      [joined(p), joined(w)],
      [returned(p, true, true), settled(w, 195_600n, true)],
      [claimed(p), claimed(w)],
    ]);
    for (const r of delivered.rows) expect(r.end!.pending).toBe(false);
    expect(delivered.rows.find((r) => r.ticket === p)!.end).toMatchObject({ refunded: true });
    expect(delivered.rows.find((r) => r.ticket === w)!.end!.payout).toBe(195_600n);
    // a claimed lone end too
    const lone = logOf([[settled(A("lone"), 195_600n, true)], [claimed(A("lone"))]]);
    expect(lone.loneEnds[0]).toMatchObject({ ticket: A("lone"), pending: false });
  });

  it("names a return whose join was not read with no integrator", () => {
    const log = logOf([[returned(A("x"), true)]]);
    expect(log.loneEnds).toEqual([
      expect.objectContaining({ ticket: A("x"), integrator: null, refunded: true, beacon: true }),
    ]);
  });

  it("reads a beacon ticket's margin from its payout table, and its odds from that", () => {
    const log = logOf([[joined(A("w"))]]);
    expect(log.rows[0]!.marginBps).toBe(0n);
    withBeaconMargins(log, new Map([[table, lhs]]));
    expect(log.rows[0]!.marginBps).toBe(220n);
    expect(oddsOf(log.rows[0]!)).toBe("1 in 2.0");
    // an unread table leaves it as it is
    const other = logOf([[joined(A("v"))]]);
    withBeaconMargins(other, new Map());
    expect(other.rows[0]!.marginBps).toBe(0n);
  });

  it("counts beacon volume in the estimated APR, at its margin less the shares its join took", () => {
    const beaconRows = withBeaconMargins(
      logOf(Array.from({ length: 5 }, (_, i) => [joined(A(`j${i}`), A("i"), 100n)])),
      new Map([[table, lhs]]),
    ).rows;
    const apr = estimateApr(log([...beaconRows, row({ ticket: A("d") })]), 1000n * USDC, 20n, NOW);
    expect(apr.tickets).toBe(6);
    expect(apr.volume).toBe(5n * price + USDC);
    // each: 100 000 · 2.2 % − 100 app − 200 protocol = 1 900; the direct one: 1 USDC · 3.3 %
    expect(apr.margin).toBe(5n * 1_900n + 33_000n);
    // a beacon ticket's margin below its shares adds nothing
    const thin = beaconRows.map((r) => ({ ...r, marginBps: 10n }));
    expect(estimateApr(log(thin), 1000n * USDC, 20n, NOW).margin).toBe(0n);
  });

  it("books nothing for a refunded return, and a forfeit's credit and shares as kept", () => {
    const rows = withBeaconMargins(
      logOf([
        [joined(A("r"), A("app"), 300n), joined(A("f"), A("app"), 300n)],
        [returned(A("r"), true), returned(A("f"), false)],
      ]),
      new Map([[table, lhs]]),
    ).rows;
    const refunded = rows.find((r) => r.ticket === A("r"))!;
    const forfeited = rows.find((r) => r.ticket === A("f"))!;
    expect(appShareOf(refunded)).toBe(0n);
    expect(vaultMarginOf(refunded, 20n)).toBe(0n);
    expect(appShareOf(forfeited)).toBe(300n);
    // 100 000 · 2.2 % − 300 app − 200 protocol
    expect(vaultMarginOf(forfeited, 20n)).toBe(1_700n);

    const s = statsByApp(log(rows)).get(A("app"))!;
    expect(s).toMatchObject({ tickets: 2, settled: 2, paidOut: 0n, appShare: 300n, volume: price });
    // only the forfeit's credit stays with the vault
    expect(s.result).toBe(price - 300n - 200n);

    // a refund is left out of the APR's tickets, volume and margin
    const apr = estimateApr(log(rows), 1000n * USDC, 20n, NOW);
    expect(apr).toMatchObject({ tickets: 1, volume: price, margin: 1_700n });
    // nor in the volume chart: 0.10 opened in the window, the forfeit's
    const pts = volumeSeries(log(rows), NOW - 3_600, NOW, 3_600);
    expect(pts.map((p) => p.v)).toEqual([Number(price) / 1e6]);
    const onlyRefunds = Array.from({ length: APR_MIN_TICKETS }, () => refunded);
    expect(estimateApr(log(onlyRefunds), 1000n * USDC, 20n, NOW)).toMatchObject({
      pct: null,
      tickets: 0,
      volume: 0n,
      margin: 0n,
    });
  });

  it("does not tell a beacon ticket's odds before its payout table is read", () => {
    const log = logOf([[joined(A("w"))]]);
    expect(oddsOf(log.rows[0]!)).toBe("–");
  });

  it("takes a beacon ticket's app share from its join", () => {
    const rows = logOf([[joined(A("a"), A("app"), 300n)], [settled(A("a"), 195_600n)]]).rows;
    const s = statsByApp(log(rows)).get(A("app"))!;
    expect(s).toMatchObject({ tickets: 1, appShare: 300n, settled: 1, paidOut: 195_600n });
    expect(s.result).toBe(price - 300n - 200n - 195_600n);
  });

  it("words a beacon ticket's ends: a win is a win, a refund a cancelled draw, never a win", () => {
    // the wallet's USDC account, the funder's of the tickets below unless said otherwise
    const wallet = A("wallet");
    const withEnd = (end: TicketRow["end"]): TicketRow => ({
      ...row({ price, payoutMax: 195_600n, vaultCredit: 99_800n, marginBps: 220n, end }),
      beacon: {
        round: A("round"),
        payoutTable: table,
        refundTo: wallet,
        appShare: 0n,
        protocolShare: 200n,
      },
    });
    const at = { at: NOW, signature: "x" as Signature };
    const win = withEnd({ kind: "settled", payout: 195_600n, pending: false, ...at });
    expect(buyerLine(win, true)).toMatchObject({
      kind: "Small ticket",
      title: "Small ticket",
      detail: "0.10 USDC, won",
      amount: "+0.19",
      tone: "won",
    });
    expect(vaultLine(win, true)).toMatchObject({ title: "Small ticket won", tone: "won" });
    const refunded = withEnd({
      kind: "expired",
      payout: 0n,
      pending: false,
      refunded: true,
      ...at,
    });
    expect(buyerLine(refunded, true, wallet)).toMatchObject({
      detail: "0.10 USDC, draw cancelled",
      amount: "0.10 back",
      tone: "muted",
    });
    expect(vaultLine(refunded, true)).toMatchObject({
      title: "Small ticket",
      detail: "0.10 USDC, draw cancelled",
      amount: "0.10 back",
      tone: "muted",
    });
    // a price its funder's account could not receive waits in escrow: never worded as back
    const parked = withEnd({
      kind: "expired",
      payout: 0n,
      pending: true,
      refunded: true,
      ...at,
    });
    for (const l of [buyerLine(parked, true, wallet), vaultLine(parked, true)])
      expect(l).toMatchObject({
        detail: "0.10 USDC, draw cancelled, waits to be claimed",
        amount: "0.10 to claim",
        tone: "muted",
      });
    // "refund" and "refunded" appear in no copy
    // another app funded it for this wallet: its price goes back to that app, none to the wallet
    for (const r of [refunded, parked])
      expect(buyerLine(r, false, A("elsewhere"))).toMatchObject({
        detail: "0.10 USDC, draw cancelled",
        amount: "back to its app",
        tone: "muted",
      });
    for (const l of [refunded, parked].flatMap((r) => [
      buyerLine(r, true, wallet),
      buyerLine(r, false, A("elsewhere")),
      vaultLine(r, true),
    ]))
      expect(Object.values(l).join(" ")).not.toMatch(/refund/i);
    const forfeited = withEnd({ kind: "expired", payout: 0n, pending: false, ...at });
    expect(buyerLine(forfeited, true)).toMatchObject({ amount: "no draw" });
    expect(vaultLine(forfeited, true)).toMatchObject({ amount: "+0.09", tone: "kept" });
  });
});

describe("the vault's APR over time", () => {
  const DAY = 86400;
  const WEEK = 7 * DAY;
  const ASSETS = [{ t: NOW - 30 * DAY, assets: 1000n * USDC }];
  /** `n` tickets of 1 USDC at 3.5 %, opened `at`: 0.033 USDC of vault margin each. */
  const batch = (n: number, at: number, tag: string) =>
    Array.from({ length: n }, (_, i) => row({ ticket: A(`${tag}${i}`), openedAt: at }));
  const refunded = (tag: string, at: number): TicketRow =>
    row({
      ticket: A(tag),
      openedAt: at,
      end: {
        kind: "expired",
        payout: 0n,
        pending: false,
        refunded: true,
        at,
        signature: "r" as Signature,
      },
      beacon: {
        round: A("round"),
        payoutTable: A("table"),
        refundTo: A("funder"),
        appShare: 0n,
        protocolShare: 0n,
      },
    });
  /** The APR of `n` such tickets over 7 days and `assets` USDC, in percent. */
  const pct = (n: number, assets: number) => (n * 33_000 * 365 * 100) / 7 / (assets * 1e6);
  /** A log read back to 14 days, as the app reads the program's. */
  const full = (rows: TicketRow[]) => log(rows, { since: NOW - 2 * WEEK, from: NOW - 2 * WEEK });

  it("counts the tickets of the 7 days up to each point, the window's first second included", () => {
    const rows = [...batch(5, NOW - 9 * DAY, "a"), ...batch(5, NOW - 3600, "b")];
    const pts = aprSeries(log(rows), ASSETS, 20n, [NOW - 9 * DAY + 60, NOW - DAY, NOW]);
    expect(pts[0]!.v).toBeCloseTo(pct(5, 1000), 9);
    // a week and more after the first batch, before the second: none in the window
    expect(pts[1]!.v).toBeNull();
    expect(pts[2]!.v).toBeCloseTo(pct(5, 1000), 9);
    // exactly 7 days after the first batch, the window still opens on it; a second later it does not
    const edge = aprSeries(log(rows), ASSETS, 20n, [NOW - 2 * DAY, NOW - 2 * DAY + 1, NOW]);
    expect(edge[0]!.v).toBeCloseTo(pct(5, 1000), 9);
    expect(edge[1]!.v).toBeNull();
    // a ticket opened after a point is not in its window
    const before = aprSeries(log(batch(5, NOW - 60, "c")), ASSETS, 20n, [NOW - 120, NOW]);
    expect(before.map((p) => p.v === null)).toEqual([true, false]);
  });

  it("draws no gap through a 2-day outage inside the week", () => {
    // 3 tickets every 6 hours over 14 days, none at all from 5 to 3 days ago
    const rows: TicketRow[] = [];
    for (let t = NOW - 2 * WEEK + 60; t <= NOW; t += 6 * 3600)
      if (t < NOW - 5 * DAY || t > NOW - 3 * DAY) rows.push(...batch(3, t, `x${t}-`));
    const l = full(rows);
    const times: number[] = [];
    for (let t = NOW - WEEK; t < NOW; t += 6 * 3600) times.push(t);
    times.push(NOW);
    const pts = aprSeries(l, ASSETS, 20n, times);
    expect(pts.every((p) => p.v !== null && p.v > 0)).toBe(true);
    // the outage lowers the figure, never blanks it: the points inside it still read 5 days
    const inside = pts.find((p) => p.t === NOW - 4 * DAY)!;
    expect(inside.v).not.toBeNull();
    // and the headline agrees with the chart's last point
    expect(pts.at(-1)!.v).toBe(estimateApr(l, 1000n * USDC, 20n, NOW).pct);
  });

  it("leaves refunded tickets out, from the count as from the margin", () => {
    const refunds = Array.from({ length: 5 }, (_, i) => refunded(`r${i}`, NOW - 600));
    const four = [...batch(4, NOW - 600, "a"), ...refunds];
    expect(aprSeries(log(four), ASSETS, 20n, [NOW])[0]!.v).toBeNull();
    const five = [...batch(5, NOW - 600, "a"), ...refunds];
    expect(aprSeries(log(five), ASSETS, 20n, [NOW])[0]!.v).toBeCloseTo(pct(5, 1000), 9);
  });

  it("annualises over the assets known at each point", () => {
    const rows = [...batch(5, NOW - 10 * DAY, "a"), ...batch(5, NOW - 600, "b")];
    const assets = [
      { t: NOW - 11 * DAY, assets: 500n * USDC },
      { t: NOW - DAY, assets: 2000n * USDC },
      { t: NOW, assets: 0n },
    ];
    const pts = aprSeries(log(rows), assets, 20n, [NOW - 10 * DAY + 60, NOW - 60, NOW]);
    expect(pts[0]!.v).toBeCloseTo(pct(5, 500), 9);
    expect(pts[1]!.v).toBeCloseTo(pct(5, 2000), 9);
    // an empty vault has no APR
    expect(pts[2]!.v).toBeNull();
    // nor a point before any assets are known
    expect(aprSeries(log(rows), assets.slice(1), 20n, [NOW - 10 * DAY + 60])[0]!.v).toBeNull();
  });

  it("leaves a gap only below the minimum number of tickets in a whole week", () => {
    const rows = batch(APR_MIN_TICKETS - 1, NOW - 6 * DAY, "a");
    expect(aprSeries(log(rows), ASSETS, 20n, [NOW])[0]!.v).toBeNull();
    rows.push(row({ ticket: A("last"), openedAt: NOW - 60 }));
    expect(aprSeries(log(rows), ASSETS, 20n, [NOW])[0]!.v).toBeCloseTo(pct(5, 1000), 9);
  });

  it("plots no point whose 7 days start before the log lists every ticket", () => {
    const rows = batch(10, NOW - 600, "a");
    // a read capped 6 h back: no 7 days are complete, and the headline's extrapolation is not drawn
    const capped = log(rows, { truncated: true, from: NOW - 6 * 3600 });
    expect(coveredFrom(capped)).toBe(NOW - 6 * 3600);
    const short = aprSeries(capped, ASSETS, 20n, [NOW - 3600, NOW]);
    expect(short.map((p) => p.v)).toEqual([null, null]);
    expect(estimateApr(capped, 1000n * USDC, 20n, NOW).pct).not.toBeNull();
    // capped eight days back: the last 7 days are complete
    const deep = log(rows, { truncated: true, from: NOW - 8 * DAY });
    const pts = aprSeries(deep, ASSETS, 20n, [NOW - DAY - 3600, NOW]);
    expect(pts[0]!.v).toBeNull();
    expect(pts[1]!.v).toBeCloseTo(pct(10, 1000), 9);
    // a read that was not capped is complete from its start
    const whole = log(rows, { since: NOW - 2 * WEEK, from: NOW - 600 });
    expect(coveredFrom(whole)).toBe(NOW - 2 * WEEK);
    const old = [...batch(5, NOW - 2 * WEEK, "o"), ...rows];
    const wholeOld = log(old, { since: NOW - 2 * WEEK, from: NOW - 2 * WEEK });
    const edges = aprSeries(wholeOld, ASSETS, 20n, [NOW - WEEK - 60, NOW - WEEK, NOW]);
    // a minute before the first complete window: not drawn; at it: drawn
    expect(edges[0]!.v).toBeNull();
    expect(edges[1]!.v).toBeCloseTo(pct(5, 1000), 9);
    expect(edges[2]!.v).toBeCloseTo(pct(10, 1000), 9);
    // a capped read without a time covers nothing
    expect(coveredFrom(log(rows, { truncated: true, from: null }))).toBe(Infinity);
  });

  it("ends on the headline estimate, and is never negative, over random logs", () => {
    const r = rng(2026);
    for (let k = 0; k < 300; k++) {
      const rows = Array.from({ length: r.int(30) }, (_, i) => {
        // some opened in the last minutes after the chart's minute: the last point counts them
        const at = NOW - r.int(10 * DAY) + 120;
        if (r.int(6) === 0) return refunded(`r${i}`, at);
        return row({
          ticket: A(`t${i}`),
          openedAt: r.int(20) === 0 ? null : at,
          price: r.big(100_000n, 50n * USDC),
          marginBps: r.big(0n, 900n),
          appShareBps: r.big(0n, 500n),
        });
      });
      const truncated = r.int(3) === 0;
      const l = log(rows, {
        truncated,
        // a capped read that still covers the last 7 days, so the headline is not extrapolated
        from: truncated ? NOW - WEEK - r.int(WEEK) : NOW - 2 * WEEK,
        since: NOW - 2 * WEEK,
      });
      const assets = r.int(10) === 0 ? 0n : r.big(1n, 10n ** 12n);
      const protocol = r.big(0n, 50n);
      const history = [
        { t: NOW - 12 * DAY, assets: r.big(1n, 10n ** 12n) },
        { t: NOW, assets },
      ];
      const series = aprSeries(l, history, protocol, [NOW - DAY, NOW - 3600, NOW]);
      expect(series.at(-1)!.v).toBe(estimateApr(l, assets, protocol, NOW).pct);
      for (const p of series) if (p.v !== null) expect(p.v).toBeGreaterThanOrEqual(0);
    }
  });
});
