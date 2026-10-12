// The app's figures from the program's tickets: the vault's estimated APR, what each app
// brought in, which demo a ticket came from and its odds.
import type { Address, Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  estimateApr,
  kindOf,
  oddsOf,
  statsByApp,
  volumeSeries,
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

describe("estimated APR", () => {
  it("annualises the vault margin of the last 24 h over the vault's assets", () => {
    // 10 tickets of 1 USDC at 3.5 % margin, 0.2 % protocol share: 0.33 USDC a day
    const rows = Array.from({ length: 10 }, (_, i) => row({ ticket: A(`t${i}`) }));
    // one older than 24 h does not count
    rows.push(row({ ticket: A("old"), openedAt: NOW - 2 * 86400, price: 1000n * USDC }));
    const apr = estimateApr(log(rows), 1000n * USDC, 20n, NOW);
    expect(apr.tickets).toBe(10);
    expect(apr.volume).toBe(10n * USDC);
    expect(apr.margin).toBe(330_000n);
    expect(apr.pct).toBeCloseTo((0.33 * 365 * 100) / 1000, 6);
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

  it("scales a read capped inside the day up to a day", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ ticket: A(`t${i}`) }));
    const capped = estimateApr(
      log(rows, { truncated: true, from: NOW - 21_600 }),
      1000n * USDC,
      20n,
      NOW,
    );
    expect(capped.volume).toBe(24n * USDC);
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
