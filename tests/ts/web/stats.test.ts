// The all-time figures as the app reads them from the keeper (lib/stats), and the words of a
// live draw's win (lib/ticketWords): what it was.
import { describe, expect, it } from "vitest";
import { parseSplit } from "../../../apps/web/src/lib/stats.ts";
import { PACK_TICKETS, PREMIUM_PACKS } from "../../../apps/web/src/lib/payoutTables.ts";
import { winWords } from "../../../apps/web/src/lib/ticketWords.ts";

describe("the keeper's figures", () => {
  const split = {
    ticketsOpened: 12,
    ticketsDrawn: 10,
    ticketsExpired: 1,
    wins: 3,
    paid: "9007199254740993",
    biggestWin: { payout: "186900000", kind: "Checkout", ticket: "T", at: 5, signature: "s" },
    lastWin: { payout: "1", kind: "Mystery", ticket: "U", at: null, signature: "t" },
  };

  it("reads amounts as exact integers and unknown kinds as none", () => {
    const s = parseSplit(split)!;
    expect(s.paid).toBe(9_007_199_254_740_993n);
    expect(s.biggestWin).toEqual({ payout: 186_900_000n, kind: "Checkout", ticket: "T", at: 5 });
    expect(s.lastWin).toEqual({ payout: 1n, kind: null, ticket: "U", at: null });
  });

  it("refuses a body that does not read as figures", () => {
    expect(parseSplit(null)).toBeNull();
    expect(parseSplit({ ...split, paid: 12 })).toBeNull();
    expect(parseSplit({ ...split, wins: -1 })).toBeNull();
    expect(parseSplit({ ...split, ticketsDrawn: "10" })).toBeNull();
    expect(parseSplit({ ...split, biggestWin: { payout: "x" } })!.biggestWin).toBeNull();
  });
});

describe("a live draw's words", () => {
  it("names each win", () => {
    const price = 100_000n;
    const pack = price * PACK_TICKETS;
    expect(winWords("Checkout", 2_500_000n, 186_900_000n)).toBe("free order");
    expect(winWords("Swap", 250_000n, 74_350_000n)).toBe("trade won back");
    expect(winWords("Booster", price, pack * PREMIUM_PACKS)).toBe("premium pack");
    expect(winWords("Booster", price, pack)).toBe("second pack");
    expect(winWords("Booster", null, pack)).toBe("won");
    expect(winWords("Ticket", null, 1n)).toBe("won");
  });
});
