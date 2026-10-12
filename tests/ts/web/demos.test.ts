// The demos' payout tables and the terms they show: the checkout at every ticket the slider
// offers, the swap at several trades and tickets, the booster at 5, 10, 25 and 100 USDC packs.
// Every table must pass the program's own check (Σ p·m ≤ (1 − margin) · 10⁹ over probabilities
// summing to 10⁹), and the ticket price, odds, payout and expected return on screen must be the
// table's, as the program pays it.
import { describe, expect, it } from "vitest";
import { odds, oneInOf, usdc } from "../../../apps/web/src/lib/format.ts";
import {
  BPS,
  M_CEILING_BPS,
  MAX_OUTCOMES,
  P_SCALE,
  marginBps,
  payout,
  quote,
  rtpBps,
  summarize,
  type Outcome,
} from "../../../apps/web/src/lib/math.ts";
import {
  CART,
  DEMO_APP_SHARE_BPS,
  DEMO_MARGIN_BPS,
  LAMPORTS_PER_SOL,
  NO_EXTRA,
  PACK_RANGE,
  PACK_TICKETS,
  PREMIUM,
  SECOND_PACK,
  SOL_PRICE,
  SWAP_PRESETS_LAMPORTS,
  boosterPayoutTable,
  boosterPayouts,
  boosterWinP,
  checkoutPayoutTable,
  largestWinBack,
  packSteps,
  packTicket,
  payoutRow,
  payoutTableFooter,
  swapOut,
  winBackPayoutTable,
} from "../../../apps/web/src/lib/payoutTables.ts";
import { kindOf, oddsOf } from "../../../apps/web/src/lib/ticketLog.ts";
import {
  CENT,
  MAX_WIN_BACK_P,
  TIDY_TICKETS,
  expectedReturn,
  snapTicket,
  ticketForChance,
  ticketSteps,
} from "../../../apps/web/src/lib/tickets.ts";
import { DEVNET, USDC, rng } from "./fixtures.ts";

/** The program's acceptance of a payout table at the demos' margin (validate_with_margin). */
function acceptedByProgram(outcomes: readonly Outcome[]): boolean {
  if (outcomes.length === 0 || outcomes.length > MAX_OUTCOMES) return false;
  let sum = 0n;
  let lhs = 0n;
  for (const b of outcomes) {
    if (b.p <= 0n || b.p > P_SCALE || b.m > M_CEILING_BPS) return false;
    sum += b.p;
    lhs += b.p * b.m;
  }
  return sum === P_SCALE && lhs <= (BPS - DEMO_MARGIN_BPS) * P_SCALE;
}

/** The expected return to a tenth of a percent, from Σ p·m directly. */
const erTenths = (outcomes: readonly Outcome[]) => {
  const lhs = outcomes.reduce((s, b) => s + b.p * b.m, 0n);
  return Math.round(Number(lhs) / 1e10) / 10;
};

/** Every term the demo panels show for an all-or-nothing win-back of `target` on `price`. */
function winBackTerms(price: bigint, target: bigint) {
  const t = winBackPayoutTable(price, target - price);
  return { t, win: t[0]!, odds: odds(t[0]!.p), payout: payout(price, t[0]!.m) };
}

const admitted = (outcomes: Outcome[], price: bigint, assets: bigint) =>
  quote({
    outcomes,
    price,
    appShareBps: DEMO_APP_SHARE_BPS,
    params: DEVNET,
    vault: { assets, reserved: 0n, openCredits: 0n },
  });

describe("checkout", () => {
  // every whole-cent ticket from the minimum to 1 in 2 a slider can show
  const top = ticketForChance(CART.total, DEMO_MARGIN_BPS, MAX_WIN_BACK_P, checkoutPayoutTable);
  const prices = ticketSteps(DEVNET.minPrice, top, () => true);

  it("offers tickets from 0.10 USDC up to a 1 in 2 chance", () => {
    expect(prices[0]).toBe(100_000n);
    expect(prices.at(-1)).toBe(top);
    expect(checkoutPayoutTable(top)[0]!.p).toBeLessThanOrEqual(MAX_WIN_BACK_P);
    expect(checkoutPayoutTable(top + CENT)[0]!.p).toBeGreaterThan(MAX_WIN_BACK_P);
    for (const p of prices) expect(p % CENT).toBe(0n);
  });

  it.each(prices.map((p) => [usdc(p), p] as const))(
    "is accepted by the program and pays the cart and the ticket back for %s USDC",
    (_, price) => {
      const t = checkoutPayoutTable(price);
      expect(acceptedByProgram(t)).toBe(true);
      expect(payoutTableFooter(t)!.marginBps).toBe(DEMO_MARGIN_BPS);
      const won = payout(price, t[0]!.m);
      // a win leaves nothing paid: the order and the ticket, never less, and at most a
      // ten-thousandth of the ticket more (the multiplier is rounded up to a basis point)
      expect(won).toBeGreaterThanOrEqual(CART.total + price);
      expect(won - (CART.total + price)).toBeLessThanOrEqual(price / BPS);
      // under 100 USDC that rounding stays under a cent: the panel reads the target itself
      if (price < 100n * USDC) expect(usdc(won)).toBe(usdc(CART.total + price));
      expect(expectedReturn(t)).toBe("96.5 %");
    },
  );

  it("shows odds that tell the table's probability, in the panel and the live draws", () => {
    for (const price of prices) {
      const t = checkoutPayoutTable(price);
      const terms = winBackTerms(price, CART.total + price);
      const row = payoutRow(t[0]!, price);
      expect(row.pays).toBe(terms.payout);
      expect(row.oneIn).toBe(terms.odds.oneIn);
      // the live draws rebuild the odds from the ticket's price, margin and worst case only
      const live = oddsOf({ price, payoutMax: terms.payout, marginBps: DEMO_MARGIN_BPS });
      expect(live).toBe(terms.odds.oneIn);
      expect(kindOf({ price, payoutMax: terms.payout }, true)).toBe("Checkout");
    }
  });
});

describe("swap", () => {
  const vaultAssets = 20_000n * USDC;

  it("values a trade at the indicative price", () => {
    expect(swapOut(LAMPORTS_PER_SOL)).toBe(SOL_PRICE);
    expect(SWAP_PRESETS_LAMPORTS.map((l) => usdc(swapOut(l)))).toEqual([
      "14.82",
      "37.05",
      "74.10",
      "148.20",
    ]);
  });

  it("is accepted and pays the trade and the ticket back, at several trades and tickets", () => {
    const r = rng(30);
    const trades = [
      ...SWAP_PRESETS_LAMPORTS,
      ...Array.from({ length: 40 }, () => r.big(10_000_000n, 3n * LAMPORTS_PER_SOL)),
    ];
    for (const lamports of trades) {
      const out = swapOut(lamports);
      if (out < DEVNET.minPrice * 2n) continue;
      const top = ticketForChance(out, DEMO_MARGIN_BPS, MAX_WIN_BACK_P, (t) =>
        winBackPayoutTable(t, out),
      );
      for (const price of ticketSteps(DEVNET.minPrice, top, () => true)) {
        const t = winBackPayoutTable(price, out);
        expect(acceptedByProgram(t)).toBe(true);
        expect(t[0]!.p).toBeLessThanOrEqual(MAX_WIN_BACK_P);
        const won = payout(price, t[0]!.m);
        expect(won).toBeGreaterThanOrEqual(out + price);
        // the program's payout: at most a ten-thousandth of the ticket above the target
        expect(won - (out + price)).toBeLessThanOrEqual(price / BPS);
        const live = oddsOf({ price, payoutMax: won, marginBps: DEMO_MARGIN_BPS });
        expect(live).toBe(odds(t[0]!.p).oneIn);
        expect(expectedReturn(t)).toBe("96.5 %");
      }
    }
  });

  it("covers the largest trade the program admits, to the cent", () => {
    for (const assets of [1_000n, 20_000n, 250_000n].map((n) => n * USDC)) {
      const vault = { assets, reserved: 0n, openCredits: 0n };
      const most = largestWinBack({ price: DEVNET.minPrice, params: DEVNET, vault });
      const ok = (amount: bigint) =>
        admitted(winBackPayoutTable(DEVNET.minPrice, amount), DEVNET.minPrice, assets).refusal;
      expect(ok(most)).toBeNull();
      expect(ok(most + CENT)).not.toBeNull();
      expect(most % CENT).toBe(0n);
    }
    // a vault too small for even the smallest win-back covers nothing
    const tiny = { assets: 1n * USDC, reserved: 0n, openCredits: 0n };
    expect(largestWinBack({ price: DEVNET.minPrice, params: DEVNET, vault: tiny })).toBe(0n);
    expect(vaultAssets > 0n).toBe(true);
  });
});

describe("booster", () => {
  const packs = [5n, 10n, 25n, 100n].map((n) => n * USDC);

  it.each(packs.map((p) => [usdc(p, 0), p] as const))(
    "is accepted and shows the table's terms for a %s USDC pack",
    (_, pack) => {
      const addOn = packTicket(pack);
      // the add-on is 2 % of the pack, exactly
      expect(addOn * 100n).toBe(pack * 2n);
      const t = boosterPayoutTable(pack);
      expect(acceptedByProgram(t)).toBe(true);
      // what each outcome pays, on screen and on chain
      expect(t.map((b) => payout(addOn, b.m))).toEqual([...boosterPayouts(pack)]);
      expect(t.map((b) => payoutRow(b, addOn).pays)).toEqual([10n * pack, pack, 0n]);
      // the odds of any win, those of each, and the expected return
      expect(odds(boosterWinP(t)).oneIn).toBe("1 in 95");
      expect(odds(t[SECOND_PACK]!.p).oneIn).toBe("1 in 104");
      expect(odds(t[PREMIUM]!.p).oneIn).toBe("1 in 1,037");
      expect(boosterWinP(t)).toBe(t[PREMIUM]!.p + t[SECOND_PACK]!.p);
      expect(t[NO_EXTRA]!.p).toBe(P_SCALE - boosterWinP(t));
      expect(expectedReturn(t)).toBe("96.5 %");
      expect(erTenths(t)).toBe(96.5);
      const foot = payoutTableFooter(t)!;
      expect(foot.rtpBps + foot.marginBps!).toBe(BPS);
      expect(foot.marginBps).toBe(DEMO_MARGIN_BPS);
      // the live draws read it back as a booster with the same odds
      expect(kindOf({ price: addOn, payoutMax: 10n * pack }, true)).toBe("Booster");
      expect(oddsOf({ price: addOn, payoutMax: 10n * pack, marginBps: DEMO_MARGIN_BPS })).toBe(
        "1 in 95",
      );
    },
  );

  it("offers only packs whose add-on is a whole number of cents within the price bounds", () => {
    const steps = packSteps(DEVNET, () => true);
    expect(steps[0]).toBe(PACK_RANGE[0]);
    expect(steps.at(-1)).toBe(PACK_RANGE[1]);
    for (const p of steps) {
      expect(p % (PACK_TICKETS * CENT)).toBe(0n);
      expect(packTicket(p) >= DEVNET.minPrice && packTicket(p) <= DEVNET.maxPrice).toBe(true);
      expect(acceptedByProgram(boosterPayoutTable(p))).toBe(true);
    }
    // with the specification's 7.50 USDC minimum, no pack of the shop is small enough
    expect(packSteps({ minPrice: 7_500_000n, maxPrice: DEVNET.maxPrice }, () => true)).toEqual([]);
  });

  it("is admitted by a 20 000 USDC vault for the 5 USDC pack, not for the 100 USDC one", () => {
    const at = (pack: bigint, assets: bigint) =>
      admitted(boosterPayoutTable(pack), packTicket(pack), assets).refusal;
    expect(at(5n * USDC, 20_000n * USDC)).toBeNull();
    expect(at(100n * USDC, 20_000n * USDC)).toBe("PerTicketCap");
    expect(at(100n * USDC, 1_000_000n * USDC)).toBeNull();
  });
});

describe("the ticket slider", () => {
  it("offers tidy amounts in order, the bounds included, close stops dropped", () => {
    expect(TIDY_TICKETS[0]).toBe(CENT);
    expect(TIDY_TICKETS.at(-1)).toBe(75_000n * USDC);
    const steps = ticketSteps(100_000n, 2_000_000n, () => true);
    expect(steps).toEqual([
      100_000n,
      150_000n,
      200_000n,
      250_000n,
      300_000n,
      400_000n,
      500_000n,
      750_000n,
      1_000_000n,
      1_500_000n,
      2_000_000n,
    ]);
    expect(ticketSteps(100_000n, 1_960_000n, () => true).at(-2)).toBe(1_500_000n);
    expect(ticketSteps(5n, 4n, () => true)).toEqual([]);
    expect(snapTicket(steps, 1_100_000n)).toBe(1_000_000n);
    expect(snapTicket(steps, 1_300_000n)).toBe(1_500_000n);
    expect(snapTicket([], 7n)).toBe(7n);
  });

  it("finds the largest whole-cent ticket at or under a chance, exactly", () => {
    const r = rng(31);
    for (let i = 0; i < 300; i++) {
      const prize = r.big(USDC, 5_000n * USDC);
      const t = ticketForChance(prize, DEMO_MARGIN_BPS, MAX_WIN_BACK_P, (x) =>
        winBackPayoutTable(x, prize),
      );
      if (t === 0n) continue;
      expect(t % CENT).toBe(0n);
      expect(winBackPayoutTable(t, prize)[0]!.p).toBeLessThanOrEqual(MAX_WIN_BACK_P);
      expect(winBackPayoutTable(t + CENT, prize)[0]!.p).toBeGreaterThan(MAX_WIN_BACK_P);
    }
  });
});

describe("odds and expected return over random win-back tables", () => {
  it("agree between the panel, the payout table, the live draws and the program", () => {
    const r = rng(32);
    for (let i = 0; i < 3000; i++) {
      const price = (r.big(10_000n, 500n * USDC) / CENT) * CENT || CENT;
      // up to the multiplier ceiling, 10 000×
      const target = r.big(price * 2n, price * 9_000n);
      const t = winBackPayoutTable(price, target - price);
      expect(acceptedByProgram(t)).toBe(true);
      const s = summarize(t);
      if ("problem" in s) throw new Error(s.problem);
      expect(rtpBps(s.lhs)).toBeLessThanOrEqual(BPS - DEMO_MARGIN_BPS);
      const won = payout(price, t[0]!.m);
      expect(won).toBeGreaterThanOrEqual(target);
      const n = oneInOf(t[0]!.p)!;
      expect(oddsOf({ price, payoutMax: won, marginBps: DEMO_MARGIN_BPS })).toBe(
        odds(t[0]!.p).oneIn,
      );
      expect(Number.isFinite(n)).toBe(true);
    }
  });
});
