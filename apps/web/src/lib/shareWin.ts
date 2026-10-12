// A win, as the card a buyer shares and the post that goes with it: which sentence, which
// amount, which line under it, and the X post's text. Pure words and numbers, no canvas: the
// drawing is components/shareCard.ts. Only a win has a card; a draw that paid nothing never does.
import { drawUrl } from "./drawLink";
import { odds, usdc } from "./format";
import {
  PACK_TICKETS,
  PREMIUM,
  SECOND_PACK,
  boosterPayoutTableAt,
  type CheckoutBack,
} from "./payoutTables";
import { boosterExtra } from "./ticketWords";
import { checkoutBackOf, kindOf, type TicketKind } from "./ticketKind";
import { oddsOf, type TicketRow } from "./ticketLog";

/** Where the card sends people: written plainly, nothing on a PNG is clickable. */
export const CARD_SITE = "fade.finance";

/** The card's three sizes: an X post, a square, a story. */
export type ShareFormat = "post" | "square" | "story";
export const SHARE_FORMATS: readonly ShareFormat[] = ["post", "square", "story"];
export const FORMAT_SIZE: Record<ShareFormat, { w: number; h: number }> = {
  post: { w: 1200, h: 675 },
  square: { w: 1080, h: 1080 },
  story: { w: 1080, h: 1920 },
};
export const FORMAT_LABEL: Record<ShareFormat, string> = {
  post: "Post",
  square: "Square",
  story: "Story",
};

/** A win, as the card needs it. */
export type ShareWin = {
  kind: TicketKind;
  /** What the win paid, micro-USDC; above zero. */
  payout: bigint;
  /** The ticket price, micro-USDC (the booster's add-on). */
  price: bigint;
  /** "1 in 100", already rounded by the shared helpers; null when unknown. */
  oneIn: string | null;
  /** A checkout's part of the order that came back. */
  back?: CheckoutBack;
  /** A swap's trade, as written ("0.5 SOL"), when known. */
  traded?: string;
  /** When the draw landed. */
  at: Date;
  /** The ticket: its draw's page (lib/drawLink) is the QR code's target and the post's link. */
  ticket: string;
};

/** How the amount reads on the card: mint for money back, violet for a booster's extra pack. */
export type CardAccent = "mint" | "violet";

/**
 * The card's words. A whole order reads as the big word ("My order came back" / "free."); every
 * other win as one headline sentence. `amount` is the signed figure, `unit` what follows it.
 */
export type CardCopy = {
  lead: string | null;
  headline: string;
  /** The whole order's big word: the headline is drawn huge, in mint. */
  bigWord: boolean;
  amount: string;
  unit: string;
  accent: CardAccent;
  detail: string;
};

/** "9 OCT 2026". */
export function cardDate(d: Date): string {
  const month = d.toLocaleDateString("en-GB", { month: "short" }).slice(0, 3).toUpperCase();
  return `${d.getDate()} ${month} ${d.getFullYear()}`;
}

/** " 1 in 100." after a sentence, or nothing when the odds are unknown. */
const oddsSentence = (w: ShareWin) => (w.oneIn ? ` ${capitalOdds(w.oneIn)}.` : "");
const capitalOdds = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The booster's extra, from its payout: a premium pack or a second pack. */
const extraOf = (w: ShareWin) => boosterExtra({ price: w.price }, w.payout);

const CHECKOUT_HEADLINE: Record<Exclude<CheckoutBack, "whole">, string> = {
  half: "Half my order came back.",
  tenth: "10% of my order came back.",
};

export function cardCopy(w: ShareWin): CardCopy {
  const amount = `+${usdc(w.payout)}`;
  const ticket = `${usdc(w.price)} USDC`;
  if (w.kind === "Checkout") {
    const detail = `${ticket} added at checkout.${oddsSentence(w)}`;
    if (!w.back || w.back === "whole")
      return {
        lead: "My order came back",
        headline: "free.",
        bigWord: true,
        amount,
        unit: "USDC back to my wallet",
        accent: "mint",
        detail,
      };
    return {
      lead: null,
      headline: CHECKOUT_HEADLINE[w.back],
      bigWord: false,
      amount,
      unit: "USDC",
      accent: "mint",
      detail,
    };
  }
  if (w.kind === "Swap") {
    const traded = w.traded
      ? `${w.traded} swapped, the whole trade won back.`
      : "The whole trade won back.";
    return {
      lead: null,
      headline: "This trade was free.",
      bigWord: false,
      amount,
      unit: "USDC",
      accent: "mint",
      detail: `${traded} ${ticket} ticket.${oddsSentence(w)}`,
    };
  }
  if (w.kind === "Booster") {
    const premium = extraOf(w) === "premium pack";
    const pack = usdc(w.price * PACK_TICKETS, (w.price * PACK_TICKETS) % 1_000_000n === 0n ? 0 : 2);
    return {
      lead: null,
      headline: premium ? "Premium pack, on us." : "A second pack, on us.",
      bigWord: false,
      amount,
      unit: "USDC",
      accent: "violet",
      detail: `Bought a ${pack} USDC pack, added ${usdc(w.price)}, pulled ${premium ? "the premium" : "a second pack"}.${oddsSentence(w)}`,
    };
  }
  return {
    lead: null,
    headline: "My ticket came back.",
    bigWord: false,
    amount,
    unit: "USDC",
    accent: "mint",
    detail: `${ticket} ticket.${oddsSentence(w)}`,
  };
}

/** The post's first sentence, by kind. */
function postOpening(w: ShareWin): string {
  if (w.kind === "Checkout") {
    if (w.back === "half") return "Half my order just came back on Fade.";
    if (w.back === "tenth") return "10% of my order just came back on Fade.";
    return "My order just came back free on Fade.";
  }
  if (w.kind === "Swap") return "My trade just came back free on Fade.";
  if (w.kind === "Booster")
    return extraOf(w) === "premium pack"
      ? "My booster just pulled a premium pack on Fade."
      : "My booster just pulled a second pack on Fade.";
  return `My ticket just paid ${usdc(w.payout)} USDC on Fade.`;
}

/**
 * "My order just came back free on Fade. Drawn on Solana, odds 1 in 100.
 * https://app.fade.finance/w/<ticket>": the link opens the draw, as the card's QR code does.
 */
export function postText(w: ShareWin): string {
  const drawn = w.oneIn ? `Drawn on Solana, odds ${w.oneIn}.` : "Drawn on Solana.";
  return `${postOpening(w)} ${drawn} ${drawUrl(w.ticket)}`;
}

/** X's post composer, prefilled. An intent cannot carry an image: the sheet says to paste it. */
export const xIntentUrl = (w: ShareWin) =>
  `https://x.com/intent/post?text=${encodeURIComponent(postText(w))}`;

/** "fade-win-2026-10-09-post.png" */
export function fileName(w: ShareWin, format: ShareFormat): string {
  const d = w.at;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `fade-win-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${format}.png`;
}

/**
 * The largest font size, from `start` down to `min`, at which `text` fits `maxWidth`. `measure`
 * returns the text's width at a given size (a canvas in the app, a stub in the tests).
 */
export function fitFont(
  measure: (size: number) => number,
  maxWidth: number,
  start: number,
  min: number,
): number {
  let size = start;
  while (size > min && measure(size) > maxWidth) size -= 2;
  return Math.max(size, min);
}

/**
 * Splits `text` into lines no wider than `maxWidth` at the current font, word by word; a word
 * wider than the line keeps a line of its own.
 */
export function wrapWords(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * `text` in exactly as many lines as a greedy wrap needs at `maxWidth`, with the breaks chosen so
 * the longest line is as short as it can be ("Premium pack, / on us." rather than "Premium pack,
 * on / us."). Null when it takes more than `maxLines`.
 */
export function balancedLines(
  text: string,
  maxLines: number,
  maxWidth: number,
  measure: (s: string) => number,
): string[] | null {
  const n = wrapWords(text, maxWidth, measure).length;
  if (n > maxLines) return null;
  const words = text.split(" ");
  let best: { lines: string[]; widest: number } | null = null;
  // every way to cut the words into n lines: a handful of words, a handful of cuts
  const cut = (from: number, left: number, acc: string[]) => {
    if (left === 1) {
      const lines = [...acc, words.slice(from).join(" ")];
      const widest = Math.max(...lines.map(measure));
      if (widest <= maxWidth && (!best || widest < best.widest)) best = { lines, widest };
      return;
    }
    for (let i = from + 1; i <= words.length - left + 1; i++)
      cut(i, left - 1, [...acc, words.slice(from, i).join(" ")]);
  };
  cut(0, n, []);
  return (best as { lines: string[] } | null)?.lines ?? wrapWords(text, maxWidth, measure);
}

/** The odds of a booster's own extra: the premium pack's or the second pack's, not either. */
function boosterOdds(r: Pick<TicketRow, "price" | "marginBps">, payout: bigint): string | null {
  const table = boosterPayoutTableAt(r.price * PACK_TICKETS, r.marginBps);
  const extra = boosterExtra(r, payout);
  const win = table[extra === "premium pack" ? PREMIUM : SECOND_PACK];
  return win && win.p > 0n ? odds(win.p).oneIn : null;
}

/**
 * A won ticket of a wallet's history as a card; null for a ticket that paid nothing, is still
 * drawing or expired. The QR code opens the ticket's draw.
 */
export function shareWinOfRow(r: TicketRow, demoApp: boolean): ShareWin | null {
  const end = r.end;
  if (!end || end.kind !== "settled" || end.payout <= 0n) return null;
  const kind = kindOf(r, demoApp);
  const oneIn = kind === "Booster" ? boosterOdds(r, end.payout) : oddsOf(r);
  return {
    kind,
    payout: end.payout,
    price: r.price,
    oneIn: oneIn === "–" ? null : oneIn,
    ...(kind === "Checkout" ? { back: checkoutBackOf(r) ?? "whole" } : {}),
    at: new Date((end.at ?? r.openedAt ?? Date.now() / 1000) * 1000),
    ticket: r.ticket,
  };
}
