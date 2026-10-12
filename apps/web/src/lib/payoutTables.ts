// The demo payout tables. Probabilities are the exact integers the program stores
// (out of 1 000 000 000), multipliers are in basis points (10 000 = 1×).
import { odds } from "./format";
import {
  BPS,
  P_SCALE,
  allOrNothing,
  marginBps,
  payout,
  quote,
  rtpBps,
  summarize,
  type Outcome,
  type Vault,
} from "./math";
import type { RiskParams } from "./fade";
import { CENT, ticketSteps } from "./tickets";

/** The cart of Demo A, in micro-USDC. */
export const CART = {
  items: [
    { label: "Headphones", amount: 179_000_000n },
    { label: "Shipping", amount: 6_900_000n },
  ],
  total: 185_900_000n,
} as const;

/** The margin the demos keep, in bps: 3.5 %. */
export const DEMO_MARGIN_BPS = 350n;

/** The demo app keeps no share of its own: the whole margin goes to the vault and the protocol. */
export const DEMO_APP_SHARE_BPS = 0n;

/**
 * Win back `amount` and the ticket itself, or nothing, for a ticket of `price`,
 * keeping the demo margin: a win leaves the buyer with nothing paid at all, so the
 * receipt's total is 0.00, ticket included.
 */
export const winBackPayoutTable = (price: bigint, amount: bigint): Outcome[] =>
  allOrNothing(price, amount + price, DEMO_MARGIN_BPS);

/** What a checkout win sends back: the whole order, half of it, or a tenth of it. */
export type CheckoutBack = "whole" | "half" | "tenth";

/** The checkout's choices, from the largest win to the smallest. */
export const CHECKOUT_BACKS: readonly CheckoutBack[] = ["whole", "half", "tenth"];

/** The part of the cart a checkout win sends back, in micro-USDC (whole cents on the demo cart). */
export const checkoutBackAmount = (back: CheckoutBack): bigint =>
  back === "whole" ? CART.total : back === "half" ? CART.total / 2n : CART.total / 10n;

/** Demo A: win back `back` of the cart and the ticket, or nothing, for a ticket of `price`. */
export const checkoutPayoutTableFor =
  (back: CheckoutBack) =>
  (price: bigint): Outcome[] =>
    winBackPayoutTable(price, checkoutBackAmount(back));

/** Demo A: win back the whole cart, or nothing, for a ticket of `price`. */
export const checkoutPayoutTable = checkoutPayoutTableFor("whole");

/**
 * Demo B, the swap: the swap leg is simulated on devnet at this indicative
 * price (micro-USDC per SOL); the payout that may pay back the trade is real.
 */
export const SOL_PRICE = 148_200_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const SWAP_PRESETS_LAMPORTS = [100_000_000n, 250_000_000n, 500_000_000n, 1_000_000_000n];

/** Test USDC out for `lamports` in, at the simulated price. */
export const swapOut = (lamports: bigint) => (lamports * SOL_PRICE) / LAMPORTS_PER_SOL;

/**
 * The largest amount a full win-back payout table on `price` can promise against the
 * vault as read: the program's whole admission (per-ticket cap, app ceiling,
 * utilisation, exposure) decides, searched to the cent.
 */
export function largestWinBack(args: {
  price: bigint;
  params: RiskParams;
  vault: Vault;
  halved?: boolean;
  integratorReserved?: bigint;
}): bigint {
  const fits = (amount: bigint) =>
    quote({
      outcomes: winBackPayoutTable(args.price, amount),
      price: args.price,
      appShareBps: DEMO_APP_SHARE_BPS,
      params: args.params,
      vault: args.vault,
      ...(args.halved !== undefined ? { halved: args.halved } : {}),
      ...(args.integratorReserved !== undefined
        ? { integratorReserved: args.integratorReserved }
        : {}),
    }).refusal === null;
  const cent = 10_000n;
  const first = args.price * 2n;
  if (!fits(first)) return 0n;
  let hi = first * 2n;
  while (fits(hi) && hi < 1_000_000_000_000n) hi *= 2n;
  // in whole cents: `lo` fits, `hi` does not (or is the search's ceiling)
  let lo = first / cent;
  hi = (hi + cent - 1n) / cent;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (fits(mid * cent)) lo = mid;
    else hi = mid;
  }
  return lo * cent;
}

/**
 * Demo C, the booster: a pack of cards on a shop, and an add-on of a fiftieth (2%) of its price for a
 * chance at more packs. The pack is always opened: it is the purchase. The add-on is the ticket;
 * a win pays, in USDC to the buyer's wallet, the value of a premium pack or of a second pack.
 */
export const PACK_TICKETS = 50n;

/** The packs the shop sells, in micro-USDC. */
export const PACK_RANGE = [5_000_000n, 100_000_000n] as const;

/** A premium pack is worth this many standard packs. */
export const PREMIUM_PACKS = 10n;

/** The booster's outcomes, in payout table order. */
export const BOOSTER_OUTCOMES = ["Premium pack", "Second pack", "No extra"] as const;
export const PREMIUM = 0;
export const SECOND_PACK = 1;
export const NO_EXTRA = 2;

/** The add-on, the ticket, for a pack of `pack`. */
export const packTicket = (pack: bigint) => pack / PACK_TICKETS;

/** What each outcome of the booster pays for a pack of `pack`, in micro-USDC. */
export const boosterPayouts = (pack: bigint) => [PREMIUM_PACKS * pack, pack, 0n] as const;

/**
 * A premium pack (ten packs' value), a second pack (one pack's value) or no extra, keeping
 * `margin`. Each win takes half of what the payout table may return, Σ p·m ≤ (1 − margin) · P_SCALE,
 * its probability rounded down, so the payout table never returns more than that; "no extra"
 * takes the rest of the 10⁹.
 */
export function boosterPayoutTableAt(pack: bigint, margin: bigint): Outcome[] {
  const price = packTicket(pack);
  const half = ((BPS - margin) * P_SCALE) / 2n;
  const wins = boosterPayouts(pack)
    .slice(0, NO_EXTRA)
    .map((amount) => {
      const m = (amount * BPS + price - 1n) / price;
      return { p: half / m, m };
    });
  const [premium, second] = wins as [Outcome, Outcome];
  return [premium, second, { p: P_SCALE - premium.p - second.p, m: 0n }];
}

/** The booster's payout table at the demo margin. */
export const boosterPayoutTable = (pack: bigint): Outcome[] =>
  boosterPayoutTableAt(pack, DEMO_MARGIN_BPS);

/** The chance of any win (a premium or a second pack), out of P_SCALE. */
export const boosterWinP = (outcomes: readonly Outcome[]) =>
  outcomes.reduce((sum, b) => (b.m > 0n ? sum + b.p : sum), 0n);

/**
 * The pack prices the shop's slider offers: tidy amounts in PACK_RANGE whose add-on lies within
 * the live price bounds and is a whole number of cents, keeping those `ok` accepts.
 */
export function packSteps(
  params: Pick<RiskParams, "minPrice" | "maxPrice">,
  ok: (pack: bigint) => boolean,
): bigint[] {
  const unit = PACK_TICKETS * CENT;
  const atLeast = params.minPrice * PACK_TICKETS;
  const atMost = params.maxPrice * PACK_TICKETS;
  const lo = ((atLeast > PACK_RANGE[0] ? atLeast : PACK_RANGE[0]) + unit - 1n) / unit;
  const hi = (atMost < PACK_RANGE[1] ? atMost : PACK_RANGE[1]) / unit;
  return ticketSteps(lo * unit, hi * unit, ok).filter((p) => p % unit === 0n);
}

// --- a payout table as the app shows it --------------------------------------------------------

/**
 * One row of a payout table as PayoutTableView shows it: the odds ("1 in 26", "3.89 %"), the
 * multiplier and what it pays on `price`, as the program pays it (rounded down).
 */
export const payoutRow = (b: Outcome, price: bigint) => ({
  ...odds(b.p),
  pays: payout(price, b.m),
});

/**
 * The table's footer: its expected return (rounded up, as the program rounds it), its margin (the
 * rest, rounded down) and Σ p × m; null for a table the program would refuse outright.
 */
export function payoutTableFooter(outcomes: readonly Outcome[]) {
  const s = summarize(outcomes);
  if ("problem" in s) return null;
  return { rtpBps: rtpBps(s.lhs), marginBps: marginBps(s.lhs), lhs: s.lhs };
}
