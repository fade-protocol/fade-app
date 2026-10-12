// The ticket a user picks: the amounts a slider offers, and the bounds that
// keep them sensible. Every bound comes from the live Config and vault through
// `quote`, the app's mirror of the program's admission; nothing here is a
// protocol parameter.
import { BPS, P_SCALE, summarize, type Outcome } from "./math";

/** One cent of USDC, in micro-USDC: tickets are whole cents. */
export const CENT = 10_000n;

/** A win-back payout table never offers better than this chance: 1 in 2. */
export const MAX_WIN_BACK_P = P_SCALE / 2n;

/** Tidy amounts per decade, in tenths: 1, 1.5, 2, 2.5, 3, 4, 5, 7.5. */
const MANTISSAS = [10n, 15n, 20n, 25n, 30n, 40n, 50n, 75n];

/** Tidy ticket amounts from 0.01 to 75 000 USDC, in micro-USDC, ascending. */
export const TIDY_TICKETS: readonly bigint[] = Array.from({ length: 7 }, (_, d) =>
  MANTISSAS.map((m) => (CENT * 10n ** BigInt(d) * m) / 10n),
).flat();

/**
 * The tickets a slider offers: the smallest, every tidy amount in between and
 * the largest, keeping only those `ok` accepts. A tidy amount within 5 % below
 * the largest is dropped so the last two stops stay distinct.
 */
export function ticketSteps(min: bigint, max: bigint, ok: (ticket: bigint) => boolean): bigint[] {
  if (max < min) return [];
  const inner = TIDY_TICKETS.filter((t) => t > min && t < max && t * 105n < max * 100n);
  return [min, ...inner, ...(max > min ? [max] : [])].filter(ok);
}

/** The step closest to `wanted` on a log scale; `wanted` itself when there are no steps. */
export function snapTicket(steps: readonly bigint[], wanted: bigint): bigint {
  let best = steps[0];
  if (best === undefined) return wanted;
  // Compare ratios: |log(a/w)| < |log(b/w)| ⇔ max(a,w)/min(a,w) < max(b,w)/min(b,w).
  const ratio = (a: bigint) => (a > wanted ? [a, wanted] : [wanted, a]) as [bigint, bigint];
  for (const t of steps) {
    const [n1, d1] = ratio(t);
    const [n2, d2] = ratio(best);
    if (n1 * d2 < n2 * d1) best = t;
  }
  return best;
}

/**
 * The largest whole-cent ticket whose all-or-nothing win-back of `prize` keeps
 * the win's probability at or below `pMax`, checked against the exact integer
 * payout table. The chance grows with the ticket, so the search starts from
 * `p = ticket · (1 − margin) / prize` (a lower bound when the table also pays
 * the ticket back) and moves by whole cents.
 */
export function ticketForChance(
  prize: bigint,
  marginBps: bigint,
  pMax: bigint,
  payoutTable: (ticket: bigint) => readonly Outcome[],
): bigint {
  const ok = (t: bigint) => (payoutTable(t)[0]?.p ?? P_SCALE) <= pMax;
  let lo = ((pMax * prize * BPS) / ((BPS - marginBps) * P_SCALE) / CENT) * CENT;
  while (lo > 0n && !ok(lo)) lo -= CENT;
  if (lo === 0n) return 0n;
  // gallop up to a ticket past the chance, then halve the gap down to a cent
  let step = CENT;
  while (ok(lo + step)) {
    lo += step;
    step *= 2n;
  }
  let hi = lo + step;
  while (hi - lo > CENT) {
    const mid = lo + ((hi - lo) / 2n / CENT) * CENT;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** "96.5 %": the share of a ticket that comes back on average, Σ p·m, to a tenth of a percent. */
export function expectedReturn(outcomes: readonly Outcome[]): string | null {
  const s = summarize(outcomes);
  if ("problem" in s) return null;
  const tenths = (s.lhs + (P_SCALE * 10n) / 2n) / (P_SCALE * 10n);
  return `${tenths / 10n}.${tenths % 10n} %`;
}
