// The share card's words: one sentence per kind of win, the amount, the line under it, the X
// post, the date and the file name; a win only, never a loss; and the layout helpers that keep a
// long amount or headline inside the card.
import type { Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { drawUrl } from "../../../apps/web/src/lib/drawLink.ts";
import { odds } from "../../../apps/web/src/lib/format.ts";
import { payout } from "../../../apps/web/src/lib/math.ts";
import {
  PACK_TICKETS,
  PREMIUM,
  SECOND_PACK,
  boosterPayoutTableAt,
  boosterPayouts,
  checkoutPayoutTableFor,
  type CheckoutBack,
} from "../../../apps/web/src/lib/payoutTables.ts";
import { qrMatrix } from "../../../apps/web/src/lib/qr.ts";
import {
  FORMAT_SIZE,
  cardCopy,
  cardDate,
  fileName,
  fitFont,
  postText,
  shareWinOfRow,
  wrapWords,
  xIntentUrl,
  type ShareWin,
} from "../../../apps/web/src/lib/shareWin.ts";
import { oddsOf } from "../../../apps/web/src/lib/ticketLog.ts";
import { T0, USDC, ticketRow } from "./fixtures.ts";

const AT = new Date(2026, 9, 9, 18, 18);
const TICKET = "13uJdCsEg4J94KDNRPbsUCWQwYdhuG3ARvgLcUD5CfN8";
const LINK = `https://app.fade.finance/w/${TICKET}`;
const SIG =
  "5VfYmGBjvQKe3ruXy7wTqfBFKNJmvXc1HsZ3dKa9pRrN2yEoLwXtUuHq8sJcWbGmT4nDkPzA6vYi7xQeR1fLhZoM";

const win = (over: Partial<ShareWin>): ShareWin => ({
  kind: "Checkout",
  payout: 188_860_000n,
  price: 1_960_000n,
  oneIn: "1 in 100",
  back: "whole",
  at: AT,
  ticket: TICKET,
  ...over,
});

const pack = 5n * USDC;
const addOn = pack / PACK_TICKETS;
const [premiumValue, secondValue] = boosterPayouts(pack);

/** Every word a card or a post shows, for the wording rules. */
const allWords = (w: ShareWin) => {
  const c = cardCopy(w);
  return [c.lead ?? "", c.headline, c.amount, c.unit, c.detail, postText(w)].join(" ");
};

describe("cardCopy", () => {
  it("writes a whole order as the big word, free", () => {
    expect(cardCopy(win({}))).toEqual({
      lead: "My order came back",
      headline: "free.",
      bigWord: true,
      amount: "+188.86",
      unit: "USDC back to my wallet",
      accent: "mint",
      detail: "1.96 USDC added at checkout. 1 in 100.",
    });
  });

  it("writes half or a tenth of an order as what came back, never as free", () => {
    const half = cardCopy(win({ back: "half", payout: 94_910_000n, oneIn: "1 in 50" }));
    expect(half.headline).toBe("Half my order came back.");
    expect(half.bigWord).toBe(false);
    expect(half.amount).toBe("+94.91");
    expect(half.detail).toBe("1.96 USDC added at checkout. 1 in 50.");
    const tenth = cardCopy(win({ back: "tenth" }));
    expect(tenth.headline).toBe("10% of my order came back.");
    expect(`${half.headline} ${tenth.headline}`).not.toMatch(/free/);
  });

  it("writes a swap as a free trade, with the trade when it is known", () => {
    const c = cardCopy(
      win({
        kind: "Swap",
        payout: 74_350_000n,
        price: 250_000n,
        oneIn: "1 in 308",
        traded: "0.5 SOL",
      }),
    );
    expect(c.headline).toBe("This trade was free.");
    expect(`${c.amount} ${c.unit}`).toBe("+74.35 USDC");
    expect(c.accent).toBe("mint");
    expect(c.detail).toBe("0.5 SOL swapped, the whole trade won back. 0.25 USDC ticket. 1 in 308.");
    const unknown = cardCopy(win({ kind: "Swap", price: 250_000n, oneIn: null }));
    expect(unknown.detail).toBe("The whole trade won back. 0.25 USDC ticket.");
  });

  it("writes a booster's premium pack and second pack in violet", () => {
    const premium = cardCopy(
      win({ kind: "Booster", payout: premiumValue, price: addOn, oneIn: "1 in 1,037" }),
    );
    expect(premium.headline).toBe("Premium pack, on us.");
    expect(premium.amount).toBe("+50.00");
    expect(premium.accent).toBe("violet");
    expect(premium.detail).toBe(
      "Bought a 5 USDC pack, added 0.10, pulled the premium. 1 in 1,037.",
    );
    const second = cardCopy(
      win({ kind: "Booster", payout: secondValue, price: addOn, oneIn: "1 in 52" }),
    );
    expect(second.headline).toBe("A second pack, on us.");
    expect(second.detail).toBe("Bought a 5 USDC pack, added 0.10, pulled a second pack. 1 in 52.");
  });

  it("keeps a large amount whole, with its separators", () => {
    expect(cardCopy(win({ payout: 12_345_670_000n })).amount).toBe("+12,345.67");
  });

  it("never says refund, test, or a separator the app does not write", () => {
    const wins = [
      win({}),
      win({ back: "half" }),
      win({ back: "tenth" }),
      win({ kind: "Swap", traded: "1 SOL" }),
      win({ kind: "Booster", payout: premiumValue, price: addOn }),
      win({ kind: "Booster", payout: secondValue, price: addOn }),
      win({ kind: "Ticket" }),
    ];
    for (const w of wins) {
      const text = allWords(w);
      expect(text).not.toMatch(/refund|test|devnet|bot|bet|wager|jackpot/i);
      expect(text).not.toMatch(/[\u2014\u00b7\u2192\u2026]/);
    }
  });
});

describe("the X post", () => {
  it("reads per kind, with the odds and the link to the draw", () => {
    expect(postText(win({}))).toBe(
      `My order just came back free on Fade. Drawn on Solana, odds 1 in 100. ${LINK}`,
    );
    expect(postText(win({ back: "half", oneIn: "1 in 50" }))).toBe(
      `Half my order just came back on Fade. Drawn on Solana, odds 1 in 50. ${LINK}`,
    );
    expect(postText(win({ kind: "Swap", oneIn: "1 in 308" }))).toBe(
      `My trade just came back free on Fade. Drawn on Solana, odds 1 in 308. ${LINK}`,
    );
    expect(postText(win({ kind: "Booster", payout: premiumValue, price: addOn }))).toMatch(
      /^My booster just pulled a premium pack on Fade\./,
    );
    expect(postText(win({ oneIn: null }))).toBe(
      `My order just came back free on Fade. Drawn on Solana. ${LINK}`,
    );
  });

  it("opens X's composer with the text encoded", () => {
    const url = new URL(xIntentUrl(win({})));
    expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
    expect(url.searchParams.get("text")).toBe(postText(win({})));
  });
});

describe("date, file name, formats", () => {
  it("writes the date as on the card and names the file after it", () => {
    expect(cardDate(AT)).toBe("9 OCT 2026");
    expect(cardDate(new Date(2027, 0, 31))).toBe("31 JAN 2027");
    expect(fileName(win({}), "story")).toBe("fade-win-2026-10-09-story.png");
  });

  it("draws at the platforms' sizes", () => {
    expect(FORMAT_SIZE).toEqual({
      post: { w: 1200, h: 675 },
      square: { w: 1080, h: 1080 },
      story: { w: 1080, h: 1920 },
    });
  });
});

describe("layout helpers", () => {
  // a stub font: every character is 0.6 em wide
  const width = (text: string) => (size: number) => text.length * size * 0.6;

  it("shrinks a line until it fits, never below the floor", () => {
    const size = fitFont(width("+12,345.67 USDC back to my wallet"), 1000, 46, 22);
    expect(width("+12,345.67 USDC back to my wallet")(size)).toBeLessThanOrEqual(1000);
    expect(size).toBeLessThanOrEqual(46);
    expect(fitFont(width("short"), 1000, 46, 22)).toBe(46);
    expect(fitFont(width("x".repeat(500)), 100, 46, 22)).toBe(22);
  });

  it("wraps words to the width, a long word on a line of its own", () => {
    const m = (s: string) => s.length * 10;
    expect(wrapWords("Premium pack, on us.", 120, m)).toEqual(["Premium", "pack, on us."]);
    expect(wrapWords("Premium pack, on us.", 1000, m)).toEqual(["Premium pack, on us."]);
    expect(wrapWords("Supercalifragilistic is long", 100, m)).toEqual([
      "Supercalifragilistic",
      "is long",
    ]);
  });
});

describe("shareWinOfRow", () => {
  const sig = SIG as Signature;
  const settled = (paid: bigint) => ({
    kind: "settled" as const,
    payout: paid,
    pending: false,
    at: T0,
    signature: sig,
  });
  const checkoutRow = (back: CheckoutBack, price: bigint) => {
    const max = payout(price, checkoutPayoutTableFor(back)(price)[0]!.m);
    return ticketRow({ price, payoutMax: max, end: settled(max) });
  };

  it("has no card for a loss, a draw still running or an expiry", () => {
    expect(shareWinOfRow(ticketRow(), true)).toBeNull();
    expect(shareWinOfRow(ticketRow({ end: settled(0n) }), true)).toBeNull();
    expect(shareWinOfRow(ticketRow({ end: { ...settled(0n), kind: "expired" } }), true)).toBeNull();
  });

  it("reads a checkout win's part of the order, its odds and its ticket", () => {
    for (const back of ["whole", "half", "tenth"] as const) {
      const r = checkoutRow(back, 2n * USDC);
      const w = shareWinOfRow(r, true)!;
      expect(w.kind).toBe("Checkout");
      expect(w.back).toBe(back);
      expect(w.oneIn).toBe(oddsOf(r));
      expect(w.payout).toBe(r.payoutMax);
      expect(w.ticket).toBe(r.ticket);
      expect(drawUrl(w.ticket)).toBe(`https://app.fade.finance/w/${r.ticket}`);
      expect(w.at.getTime()).toBe(T0 * 1000);
    }
  });

  it("gives a booster win the odds of its own extra, not of any win", () => {
    const max = addOn * 500n;
    const premium = ticketRow({ price: addOn, payoutMax: max, end: settled(premiumValue) });
    const table = boosterPayoutTableAt(pack, premium.marginBps);
    const w = shareWinOfRow(premium, true)!;
    expect(w.kind).toBe("Booster");
    expect(w.oneIn).toBe(odds(table[PREMIUM]!.p).oneIn);
    expect(w.oneIn).not.toBe(oddsOf(premium));
    const second = shareWinOfRow({ ...premium, end: settled(secondValue) }, true)!;
    expect(second.oneIn).toBe(odds(table[SECOND_PACK]!.p).oneIn);
    expect(cardCopy(second).headline).toBe("A second pack, on us.");
  });
});

describe("qrMatrix", () => {
  it("is a square of modules with the three finder patterns", () => {
    const m = qrMatrix(drawUrl(TICKET));
    const n = m.length;
    expect((n - 17) % 4).toBe(0);
    expect(m.every((row) => row.length === n)).toBe(true);
    // a finder: a dark 7x7 ring around a dark 3x3 centre, at three corners
    const finder = (r0: number, c0: number) =>
      [0, 1, 2, 3, 4, 5, 6].every((i) =>
        [0, 1, 2, 3, 4, 5, 6].every((j) => {
          const ring = i === 0 || i === 6 || j === 0 || j === 6;
          const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
          return m[r0 + i]![c0 + j] === (ring || core);
        }),
      );
    expect(finder(0, 0)).toBe(true);
    expect(finder(0, n - 7)).toBe(true);
    expect(finder(n - 7, 0)).toBe(true);
  });
});
