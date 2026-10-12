// The checkout's chance picker: each preset's ticket, snapped to a whole cent, buys odds whose
// "1 in N" never reads better than the payout table's probability, pays what the program pays,
// and is the share of the order the card says; the custom picker stays within its bounds, for a
// win of the whole order, half of it or a tenth of it.
import { describe, expect, it } from "vitest";
import {
  CHANCE_PRESETS,
  CUSTOM_RANGE,
  SWAP_DEFAULT_ONE_IN,
  chanceTerms,
  customTickets,
  honestOneIn,
  honestOneInOf,
  marginPct,
  nearestByOdds,
  shareOf,
  swapDefaultTicket,
  ticketForOneIn,
} from "../../../apps/web/src/lib/chances.ts";
import { P_SCALE, payout, quote } from "../../../apps/web/src/lib/math.ts";
import {
  CART,
  CHECKOUT_BACKS,
  DEMO_APP_SHARE_BPS,
  DEMO_MARGIN_BPS,
  checkoutBackAmount,
  checkoutPayoutTable,
  checkoutPayoutTableFor,
  SWAP_PRESETS_LAMPORTS,
  swapOut,
  winBackPayoutTable,
} from "../../../apps/web/src/lib/payoutTables.ts";
import { usdc } from "../../../apps/web/src/lib/format.ts";
import { CENT, ticketSteps } from "../../../apps/web/src/lib/tickets.ts";
import { DEVNET, USDC } from "./fixtures.ts";

const winP = (t: bigint) => checkoutPayoutTable(t)[0]!.p;

describe("the checkout presets", () => {
  it.each(CHANCE_PRESETS.map((n) => [n] as const))("1 in %i", (n) => {
    const t = ticketForOneIn(n, DEVNET, checkoutPayoutTable);
    expect(t % CENT).toBe(0n);
    expect(t >= DEVNET.minPrice && t <= DEVNET.maxPrice).toBe(true);
    const terms = chanceTerms(t, CART.total, checkoutPayoutTable);
    // the label never promises better odds than the table: 1/N ≤ p
    expect(BigInt(terms.oneInN) * terms.p >= P_SCALE).toBe(true);
    // the cheapest such ticket: a cent less no longer reaches 1 in n, so the preset reads "1 in n"
    expect(winP(t) * BigInt(n) >= P_SCALE).toBe(true);
    expect(winP(t - CENT) * BigInt(n) < P_SCALE).toBe(true);
    expect(terms.oneIn).toBe(`1 in ${n}`);
    // the payout is the program's, and a win leaves the order and the ticket paid back
    expect(terms.payout).toBe(payout(t, checkoutPayoutTable(t)[0]!.m));
    expect(terms.payout >= CART.total + t).toBe(true);
    // the share of the order, to a hundredth of a percent, rounded to nearest
    const exact = (Number(t) / Number(CART.total)) * 100;
    expect(Math.abs(Number(terms.share.replace("%", "")) - exact)).toBeLessThanOrEqual(0.005);
    expect(terms.marginBps).toBe(DEMO_MARGIN_BPS);
    expect(marginPct(terms.marginBps!)).toBe("3.5%");
  });

  it("are the tickets the demo shows on the 185.90 USDC cart", () => {
    const shown = CHANCE_PRESETS.map((n) => {
      const t = chanceTerms(
        ticketForOneIn(n, DEVNET, checkoutPayoutTable),
        CART.total,
        checkoutPayoutTable,
      );
      return [t.oneIn, t.price, t.share, t.payout];
    });
    expect(shown).toEqual([
      ["1 in 200", 970_000n, "0.52%", 186_870_015n],
      ["1 in 100", 1_950_000n, "1.05%", 187_850_130n],
      ["1 in 50", 3_940_000n, "2.12%", 189_840_232n],
    ]);
  });

  it("are admitted by the program against a 20 000 USDC vault", () => {
    for (const n of CHANCE_PRESETS) {
      const t = ticketForOneIn(n, DEVNET, checkoutPayoutTable);
      const q = quote({
        outcomes: checkoutPayoutTable(t),
        price: t,
        appShareBps: DEMO_APP_SHARE_BPS,
        params: DEVNET,
        vault: { assets: 20_000n * USDC, reserved: 0n, openCredits: 0n },
      });
      expect(q.refusal).toBeNull();
    }
  });

  it("falls back to the ticket the bounds allow, with that ticket's own odds", () => {
    // a maximum price below 1 in 50: the label shows the worse odds the largest ticket gets
    const capped = { minPrice: DEVNET.minPrice, maxPrice: 2_000_000n };
    const t = ticketForOneIn(50, capped, checkoutPayoutTable);
    expect(t).toBe(2_000_000n);
    const terms = chanceTerms(t, CART.total, checkoutPayoutTable);
    expect(terms.oneInN).toBeGreaterThan(50);
    expect(BigInt(terms.oneInN) * terms.p >= P_SCALE).toBe(true);
    // a minimum price above 1 in 1 000: the smallest ticket, whose odds are better
    expect(
      ticketForOneIn(1000, { minPrice: 500_000n, maxPrice: DEVNET.maxPrice }, checkoutPayoutTable),
    ).toBe(500_000n);
  });
});

describe("honest odds", () => {
  it("round N up, so the chance read is never better than the probability", () => {
    expect(honestOneIn(P_SCALE / 100n)).toBe("1 in 100");
    expect(honestOneIn(P_SCALE / 100n - 1n)).toBe("1 in 101");
    expect(honestOneIn(9_966_455n)).toBe("1 in 101");
    expect(honestOneIn(P_SCALE / 1000n)).toBe("1 in 1,000");
    expect(honestOneIn(P_SCALE / 4n)).toBe("1 in 4.0");
    expect(honestOneIn(300_000_000n)).toBe("1 in 3.4");
    expect(honestOneInOf(0n)).toBeNull();
    for (let p = 1_000_000n; p < P_SCALE; p += 7_777_777n) {
      const n = honestOneInOf(p)!;
      expect(n * Number(p)).toBeGreaterThanOrEqual(Number(P_SCALE) * (1 - 1e-12));
    }
  });

  it("give a share of the order to the digits asked", () => {
    expect(shareOf(1_950_000n, CART.total)).toBe("1.05%");
    expect(shareOf(2_610_000n, CART.total, 1)).toBe("1.4%");
    expect(shareOf(10_160_000n, CART.total, 0)).toBe("5%");
  });
});

describe("the custom picker", () => {
  const stops = customTickets(DEVNET, checkoutPayoutTable);

  it("offers whole-cent tickets from about 1 in 20 to about 1 in 1 000, dearest first", () => {
    expect(stops.length).toBeGreaterThan(30);
    for (const [i, t] of stops.entries()) {
      expect(t % CENT).toBe(0n);
      const n = honestOneInOf(winP(t))!;
      expect(n).toBeGreaterThanOrEqual(CUSTOM_RANGE.best);
      expect(n).toBeLessThanOrEqual(CUSTOM_RANGE.worst);
      if (i > 0) expect(t < stops[i - 1]!).toBe(true);
    }
    const best = chanceTerms(stops[0]!, CART.total, checkoutPayoutTable);
    const worst = chanceTerms(stops.at(-1)!, CART.total, checkoutPayoutTable);
    expect(best.oneIn).toBe("1 in 20");
    // the best odds cost about 5% of the order, never more than 6%
    expect(stops[0]! * 100n <= CART.total * 6n).toBe(true);
    expect(worst.oneInN).toBeGreaterThan(900);
  });

  it("never reads better odds than the table, and pays what the program pays", () => {
    for (const t of stops) {
      const terms = chanceTerms(t, CART.total, checkoutPayoutTable, 1);
      expect(BigInt(terms.oneInN) * terms.p >= P_SCALE).toBe(true);
      expect(terms.payout).toBe(payout(t, checkoutPayoutTable(t)[0]!.m));
    }
  });

  it("keeps within the price bounds", () => {
    const narrow = { minPrice: 1_000_000n, maxPrice: 5_000_000n };
    for (const t of customTickets(narrow, checkoutPayoutTable))
      expect(t >= narrow.minPrice && t <= narrow.maxPrice).toBe(true);
  });
});

describe("the custom picker's smaller wins", () => {
  it("send back the whole cart, half of it or a tenth of it, in whole cents", () => {
    expect(CHECKOUT_BACKS.map(checkoutBackAmount)).toEqual([
      185_900_000n,
      92_950_000n,
      18_590_000n,
    ]);
    for (const back of CHECKOUT_BACKS) expect(checkoutBackAmount(back) % CENT).toBe(0n);
  });

  it.each([["half"], ["tenth"]] as const)(
    "price each stop for the %s: odds never better, the program's payout, the right share",
    (back) => {
      const table = checkoutPayoutTableFor(back);
      const stops = customTickets(DEVNET, table);
      expect(stops.length).toBeGreaterThan(back === "half" ? 30 : 20);
      for (const [i, t] of stops.entries()) {
        expect(t % CENT).toBe(0n);
        expect(t >= DEVNET.minPrice && t <= DEVNET.maxPrice).toBe(true);
        if (i > 0) expect(t < stops[i - 1]!).toBe(true);
        const terms = chanceTerms(t, CART.total, table, 1);
        // the label never promises better odds than the table, and stays in the picker's range
        expect(BigInt(terms.oneInN) * terms.p >= P_SCALE).toBe(true);
        expect(terms.oneInN).toBeGreaterThanOrEqual(CUSTOM_RANGE.best);
        expect(terms.oneInN).toBeLessThanOrEqual(CUSTOM_RANGE.worst);
        // a win pays exactly what the program pays: that part of the order and the ticket
        const win = table(t)[0]!;
        expect(terms.payout).toBe(payout(t, win.m));
        expect(terms.payout >= checkoutBackAmount(back) + t).toBe(true);
        expect(terms.payout < CART.total).toBe(true);
        // the ticket's share of the whole order, to a tenth of a percent
        const exact = (Number(t) / Number(CART.total)) * 100;
        expect(Math.abs(Number(terms.share.replace("%", "")) - exact)).toBeLessThanOrEqual(0.05);
        expect(terms.marginBps).toBe(DEMO_MARGIN_BPS);
      }
    },
  );

  it("are the stops the demo shows at the ends and around 1 in 75", () => {
    const at = (back: "half" | "tenth") => {
      const table = checkoutPayoutTableFor(back);
      const stops = customTickets(DEVNET, table).map((t) => chanceTerms(t, CART.total, table, 1));
      const t75 = chanceTerms(ticketForOneIn(75, DEVNET, table), CART.total, table, 1);
      return [stops[0]!, t75, stops.at(-1)!].map((s) => [s.oneIn, s.price, s.share, s.payout]);
    };
    expect(at("half")).toEqual([
      ["1 in 20", 5_080_000n, "2.7%", 98_030_284n],
      ["1 in 75", 1_310_000n, "0.7%", 94_260_002n],
      ["1 in 965", 100_000n, "0.1%", 93_050_000n],
    ]);
    // a tenth of the order: the program's minimum price stops the slider near 1 in 194, and the
    // cent that buys 1 in 75 reads as the 1 in 73 it really is
    expect(at("tenth")).toEqual([
      ["1 in 20", 1_020_000n, "0.5%", 19_610_010n],
      ["1 in 73", 270_000n, "0.1%", 18_860_013n],
      ["1 in 194", 100_000n, "0.1%", 18_690_000n],
    ]);
  });

  it("buy a smaller win more often for the same price", () => {
    for (const t of [200_000n, 1_000_000n, 5_000_000n]) {
      const [whole, half, tenth] = CHECKOUT_BACKS.map((b) => checkoutPayoutTableFor(b)(t)[0]!.p);
      expect(half! > whole!).toBe(true);
      expect(tenth! > half!).toBe(true);
    }
  });

  it("keep the chance held when the win changes, at the closest stop on the log scale", () => {
    const stops = [{ oneInN: 20 }, { oneInN: 50 }, { oneInN: 100 }, { oneInN: 194 }];
    expect(nearestByOdds(stops, 75)?.oneInN).toBe(100);
    expect(nearestByOdds(stops, 60)?.oneInN).toBe(50);
    expect(nearestByOdds(stops, 1000)?.oneInN).toBe(194);
    expect(nearestByOdds([], 75)).toBeUndefined();
  });
});

describe("the swap's default ticket", () => {
  const all = () => true;
  const terms = (lamports: bigint) => {
    const out = swapOut(lamports);
    const table = (t: bigint) => winBackPayoutTable(t, out);
    return chanceTerms(swapDefaultTicket(out, DEVNET, [], all), out, table);
  };

  it("starts the 0.5 SOL trade on a 1.04 USDC ticket, 1 in 75, the whole trade back", () => {
    const t = terms(500_000_000n);
    expect([usdc(t.price), t.oneIn, usdc(t.payout), t.share]).toEqual([
      "1.04",
      "1 in 75",
      "75.14",
      "1.40%",
    ]);
  });

  it("reads 1 in 100 or better, and 1 in 50 or worse, on every preset trade", () => {
    expect(SWAP_DEFAULT_ONE_IN).toBeLessThanOrEqual(100);
    for (const lamports of SWAP_PRESETS_LAMPORTS) {
      const out = swapOut(lamports);
      const t = terms(lamports);
      expect(t.oneInN).toBeLessThanOrEqual(100);
      expect(t.oneInN).toBeGreaterThanOrEqual(50);
      // the label never reads better than the table, and a cent less would miss the chance
      expect(BigInt(t.oneInN) * t.p >= P_SCALE).toBe(true);
      const less = winBackPayoutTable(t.price - CENT, out)[0]!.p;
      expect(less * BigInt(SWAP_DEFAULT_ONE_IN) < P_SCALE).toBe(true);
      expect(t.payout).toBeGreaterThanOrEqual(out + t.price);
      const q = quote({
        outcomes: t.outcomes,
        price: t.price,
        appShareBps: DEMO_APP_SHARE_BPS,
        params: DEVNET,
        vault: { assets: 20_000n * USDC, reserved: 0n, openCredits: 0n },
      });
      expect(q.refusal).toBeNull();
    }
  });

  it("falls back to the closest accepted step when the vault refuses it", () => {
    const out = swapOut(500_000_000n);
    const steps = ticketSteps(DEVNET.minPrice, 750_000n, all);
    const capped = (t: bigint) => t <= 750_000n;
    expect(swapDefaultTicket(out, DEVNET, steps, capped)).toBe(750_000n);
    expect(swapDefaultTicket(out, DEVNET, [], () => false)).toBe(DEVNET.minPrice);
  });
});
