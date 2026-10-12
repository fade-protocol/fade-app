// The checkout's chance picker: the buyer picks odds ("1 in 100"), the app finds the ticket
// price that buys them under the win-back payout table, to the cent, and shows the odds that
// price really gets. Snapping only ever moves to the first cent that reaches the chance, and the
// "1 in N" shown is rounded up, so a label never promises better odds than the table carries.
import { P_SCALE, marginBps, payout, summarize, type Outcome } from "./math";
import { fixed, honestOneInOf } from "./format";

export { honestOneInOf };
import { winBackPayoutTable } from "./payoutTables";
import { CENT, snapTicket } from "./tickets";

/** The presets, as N in "1 in N", from the rarest to the likeliest. */
export const CHANCE_PRESETS = [200, 100, 50] as const;

/** The preset selected first, tagged as the popular one. */
export const POPULAR_CHANCE = 100;

/**
 * The swap's first ticket, as N in "1 in N": the cheapest ticket that wins the whole trade back
 * at this chance, about 1.4 % of the trade under the demo margin.
 */
export const SWAP_DEFAULT_ONE_IN = 75;

/** The custom picker's range, as N in "1 in N": from the likeliest to the rarest. */
export const CUSTOM_RANGE = { best: 20, worst: 1000 } as const;

/** How many stops the custom picker offers between its bounds, on a log scale. */
const CUSTOM_STOPS = 60;

export type PriceBounds = { minPrice: bigint; maxPrice: bigint };

/** The bounds in whole cents: the program's minimum rounded up, its maximum rounded down. */
function centBounds({ minPrice, maxPrice }: PriceBounds): [bigint, bigint] {
  const lo = ((minPrice + CENT - 1n) / CENT) * CENT;
  return [lo > 0n ? lo : CENT, (maxPrice / CENT) * CENT];
}

/**
 * The cheapest whole-cent ticket whose win-back pays at least a 1 in `n` chance, within the price
 * bounds. The win's probability never falls as the ticket grows, so a binary search over cents
 * finds it. When even the largest ticket falls short, that largest ticket; when the smallest
 * already beats the chance, the smallest. Either way the odds shown are the ticket's own.
 */
export function ticketForOneIn(
  n: number,
  bounds: PriceBounds,
  payoutTable: (ticket: bigint) => readonly Outcome[],
): bigint {
  const [lo, hi] = centBounds(bounds);
  if (hi < lo) return lo;
  const reaches = (t: bigint) => (payoutTable(t)[0]?.p ?? 0n) * BigInt(n) >= P_SCALE;
  if (!reaches(hi)) return hi;
  // in cents: `a` falls short (or is below the bounds), `b` reaches
  let a = lo / CENT - 1n;
  let b = hi / CENT;
  while (b - a > 1n) {
    const mid = (a + b) / 2n;
    if (reaches(mid * CENT)) b = mid;
    else a = mid;
  }
  return b * CENT;
}

/** "1 in 101", "1 in 1,000": the honest odds of a probability in 1e9 units. */
export function honestOneIn(p: bigint): string {
  const n = honestOneInOf(p);
  if (n === null) return "never";
  return `1 in ${n >= 10 ? n.toLocaleString("en-US") : n.toFixed(1)}`;
}

/** "1.05%": `part` as a share of `whole`, rounded to `digits` decimals. */
export function shareOf(part: bigint, whole: bigint, digits = 2): string {
  if (whole <= 0n) return "0%";
  const scale = 10n ** BigInt(digits);
  const units = (part * 100n * scale * 2n + whole) / (whole * 2n);
  return `${fixed(units, digits, digits)}%`;
}

/** "1.00%": a probability in 1e9 units as a percentage, truncated (never more than it is). */
export const pctOf = (p: bigint, digits = 2) => `${fixed(p, 7, digits)}%`;

/** "3.5%": a margin in bps, without trailing zeros. */
export const marginPct = (bps: bigint) => `${fixed(bps, 2, 2).replace(/\.?0+$/, "")}%`;

export type ChanceTerms = {
  price: bigint;
  outcomes: Outcome[];
  /** The win's probability, out of P_SCALE. */
  p: bigint;
  /** "1 in 100", never better than `p`. */
  oneIn: string;
  oneInN: number;
  /** "1.00%", truncated. */
  pct: string;
  /** What a win pays, as the program pays it. */
  payout: bigint;
  /** The ticket as a share of the order, "1.05%". */
  share: string;
  /** The margin the table keeps, in bps; null for a table the program refuses outright. */
  marginBps: bigint | null;
};

/** What a ticket of `price` buys on an order of `order` under `payoutTable`. */
export function chanceTerms(
  price: bigint,
  order: bigint,
  payoutTable: (ticket: bigint) => Outcome[],
  shareDigits = 2,
): ChanceTerms {
  const outcomes = payoutTable(price);
  const win = outcomes[0] ?? { p: 0n, m: 0n };
  const s = summarize(outcomes);
  return {
    price,
    outcomes,
    p: win.p,
    oneIn: honestOneIn(win.p),
    oneInN: honestOneInOf(win.p) ?? Infinity,
    pct: pctOf(win.p),
    payout: payout(price, win.m),
    share: shareOf(price, order, shareDigits),
    marginBps: "problem" in s ? null : marginBps(s.lhs),
  };
}

/**
 * The custom picker's tickets: the cheapest ticket for each of CUSTOM_STOPS chances spaced evenly
 * on a log scale from 1 in `best` to 1 in `worst`, without repeats, from the likeliest (the
 * dearest) to the rarest. A ticket whose own odds fall outside the range is left out.
 */
export function customTickets(
  bounds: PriceBounds,
  payoutTable: (ticket: bigint) => readonly Outcome[],
  range: { best: number; worst: number } = CUSTOM_RANGE,
): bigint[] {
  const out: bigint[] = [];
  const ratio = range.worst / range.best;
  for (let i = 0; i <= CUSTOM_STOPS; i++) {
    const n = Math.round(range.best * ratio ** (i / CUSTOM_STOPS));
    const t = ticketForOneIn(n, bounds, payoutTable);
    const shown = honestOneInOf(payoutTable(t)[0]?.p ?? 0n);
    if (shown === null || shown < range.best || shown > range.worst) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
}

/**
 * The stop whose odds sit closest to 1 in `n` on the log scale (the first of two equally close):
 * where the custom picker lands when the chance it held is re-priced for another win.
 */
export function nearestByOdds<T extends { oneInN: number }>(
  stops: readonly T[],
  n: number,
): T | undefined {
  let best: T | undefined;
  let gap = Infinity;
  for (const s of stops) {
    const d = Math.abs(Math.log(s.oneInN / n));
    if (d < gap) {
      best = s;
      gap = d;
    }
  }
  return best;
}

/**
 * The ticket the swap starts on for a trade worth `prize`: the cheapest whole-cent ticket whose
 * win-back reaches 1 in SWAP_DEFAULT_ONE_IN within the price bounds. When the vault (or the
 * win-back's 1 in 2 ceiling) refuses it, the accepted step closest to it; `steps` holds only
 * tickets `accepts` takes. Falls back to the smallest price when there is no step at all.
 */
export function swapDefaultTicket(
  prize: bigint,
  bounds: PriceBounds,
  steps: readonly bigint[],
  accepts: (ticket: bigint) => boolean,
): bigint {
  const t = ticketForOneIn(SWAP_DEFAULT_ONE_IN, bounds, (x) => winBackPayoutTable(x, prize));
  if (accepts(t)) return t;
  return steps.length > 0 ? snapTicket(steps, t) : bounds.minPrice;
}
