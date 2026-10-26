// The beacon arithmetic a client needs before it sends anything, mirrored
// from `fade_math::beacon` (Spec 08 §13.4) in exact integers: what a join
// prepays, when a round is paid, the sponsorship that pays it, the close
// slot and the windows, and a settled ticket's charge and payout. The
// program decides; these only predict, so that a client sends the right
// lamports and accounts. tests/ts/fade/beaconMath.test.ts checks every
// function against crates/fade-math/tests/vectors/beacon.json, which the
// Rust crate and scripts/oracle/fade_ref.py are checked against too.
import { BPS, REQUEST_DELAY_SLOTS, UNPAID_HEADROOM_BPS, USAGE_SCALE } from "./constants.ts";

const U64_MAX = (1n << 64n) - 1n;

/** `v` as a `u64`, or a thrown error naming `what`: the program's `Overflow`. */
export function u64(v: bigint, what: string): bigint {
  if (v < 0n || v > U64_MAX) throw new RangeError(`${what} is not a u64`);
  return v;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** What a round snapshots at its creation and runs on. */
export type Terms = { threshold: bigint; drawMax: bigint; roundK: bigint };

function checked(t: Terms): Terms {
  if (t.threshold <= 0n || t.drawMax <= 0n || t.roundK <= 0n) {
    throw new RangeError("a round's threshold, prefund and k are non-zero");
  }
  return t;
}

/** A round's terms, from its account. */
export function roundTerms(round: { threshold: bigint; drawMax: bigint; roundK: number }): Terms {
  return { threshold: round.threshold, drawMax: round.drawMax, roundK: BigInt(round.roundK) };
}

/** `D_r = 2 × fee + pending_rent + request_share`. */
export function prefund(oraoFee: bigint, pendingRent: bigint, requestShare: bigint): bigint {
  return u64(
    2n * u64(oraoFee, "fee") + u64(pendingRent, "rent") + u64(requestShare, "share"),
    "prefund",
  );
}

/** `fee + pending_rent + request_share ≤ D_r`: the draw still fits the round's prefund. */
export function requestFits(
  oraoFee: bigint,
  pendingRent: bigint,
  requestShare: bigint,
  drawMax: bigint,
): boolean {
  const needed = oraoFee + pendingRent + requestShare;
  return needed <= U64_MAX && needed <= drawMax;
}

/** `ceil(D_r × price / T_r)`: the lamports a join moves to the round for its draw. */
export function prepay(terms: Terms, price: bigint): bigint {
  const t = checked(terms);
  return u64(ceilDiv(t.drawMax * u64(price, "price"), t.threshold), "prepay");
}

/** `min(T_r · D_r, R · D_r + S · T_r)`. */
export function paidUnits(terms: Terms, prices: bigint, sponsorship: bigint): bigint {
  const whole = terms.threshold * terms.drawMax;
  const v = prices * terms.drawMax + sponsorship * terms.threshold;
  return v < whole ? v : whole;
}

/** `R × D_r + S × T_r ≥ T_r × D_r`. */
export function isPaid(terms: Terms, prices: bigint, sponsorship: bigint): boolean {
  if (terms.threshold <= 0n || terms.drawMax <= 0n || terms.roundK <= 0n) return false;
  return paidUnits(terms, prices, sponsorship) >= terms.threshold * terms.drawMax;
}

/**
 * `ceil(D_r × (T_r − R) / T_r) − S`, 0 once paid: what a sponsor, or a
 * join's own sponsorship, adds to a round holding `prices` and `sponsorship`
 * to make it paid at once.
 */
export function sponsorshipToPay(terms: Terms, prices: bigint, sponsorship: bigint): bigint {
  const t = checked(terms);
  const missing = t.threshold > prices ? t.threshold - prices : 0n;
  const total = u64(ceilDiv(t.drawMax * missing, t.threshold), "sponsorship");
  return total > sponsorship ? total - sponsorship : 0n;
}

/** `ceil(l × USAGE_SCALE / cap)`, 0 without liability. */
export function usage(liability: bigint, cap: bigint): bigint {
  if (liability === 0n) return 0n;
  if (liability > cap) throw new RangeError("liability above the per-ticket cap");
  return u64(ceilDiv(liability * USAGE_SCALE, cap), "usage");
}

/**
 * The capacity rule: a paid round holds `U ≤ k × USAGE_SCALE`; an unpaid one
 * `U × T_r × D_r ≤ k × USAGE_SCALE × (1 − h) × (R × D_r + S × T_r)`, `h` the
 * headroom an unpaid round keeps for the join that pays it.
 */
export function fits(
  terms: Terms,
  usageTotal: bigint,
  prices: bigint,
  sponsorship: bigint,
): boolean {
  if (terms.threshold <= 0n || terms.drawMax <= 0n || terms.roundK <= 0n) return false;
  if (isPaid(terms, prices, sponsorship)) return usageTotal <= terms.roundK * USAGE_SCALE;
  const lhs = terms.threshold * terms.drawMax * usageTotal * BPS;
  const unpaid = terms.roundK * USAGE_SCALE * (BPS - UNPAID_HEADROOM_BPS);
  return lhs <= paidUnits(terms, prices, sponsorship) * unpaid;
}

/**
 * The share of a round, paid or not, one join may take (`within_join_share`):
 * at most `k · min(1, price/T_r + sponsorship/D_r)` caps, `price` and
 * `sponsorship` what this join brings, or `h · k` caps if more for the join
 * that makes the round paid (`paysRound`). Taking a round's room costs about
 * the payment that bought it, not cheap tickets.
 */
export function withinJoinShare(
  terms: Terms,
  usage: bigint,
  price: bigint,
  sponsorship: bigint,
  paysRound: boolean,
): boolean {
  if (terms.threshold <= 0n || terms.drawMax <= 0n || terms.roundK <= 0n) return false;
  if (paysRound && usage * BPS <= terms.roundK * USAGE_SCALE * UNPAID_HEADROOM_BPS) return true;
  return (
    usage * terms.threshold * terms.drawMax <=
    terms.roundK * USAGE_SCALE * paidUnits(terms, price, sponsorship)
  );
}

/**
 * Whether a join of `usage`, `price` and `sponsorship` fits a round holding
 * `book` (`Book::join`'s capacity decision): the round after it within the
 * capacity rule (`fits`), and the join within its share (`withinJoinShare`),
 * whether the round is paid or not. A join refused here is refused `RoundCapacity`, or,
 * from a round already paid, sent to the next round, where the same join
 * alone is refused at the same terms.
 */
export function joinFits(
  terms: Terms,
  book: { usage: bigint; prices: bigint; sponsorship: bigint },
  usage: bigint,
  price: bigint,
  sponsorship: bigint,
): boolean {
  const prices = book.prices + price;
  const sponsored = book.sponsorship + sponsorship;
  if (!fits(terms, book.usage + usage, prices, sponsored)) return false;
  const paysRound =
    !isPaid(terms, book.prices, book.sponsorship) && isPaid(terms, prices, sponsored);
  return withinJoinShare(terms, usage, price, sponsorship, paysRound);
}

/** The first multiple of `tick_slots` strictly after `paid_slot`. */
export function closeSlot(paidSlot: bigint, tickSlots: bigint): bigint {
  if (tickSlots <= 0n) throw new RangeError("tick_slots is non-zero");
  return u64((paidSlot / tickSlots + 1n) * tickSlots, "close slot");
}

/** A paid round takes joins while `slot < close_slot`. */
export function acceptsJoins(slot: bigint, close: bigint): boolean {
  return slot < close;
}

/** `a + b` saturated at `u64::MAX`, as the program's `saturating_add`. */
const satAdd = (a: bigint, b: bigint) => (a + b > U64_MAX ? U64_MAX : a + b);

/** `close_slot + 2 ≤ slot ≤ close_slot + t_settle_slots`, both bounds saturating. */
export function inRequestWindow(slot: bigint, close: bigint, tSettleSlots: bigint): boolean {
  return satAdd(close, REQUEST_DELAY_SLOTS) <= slot && slot <= satAdd(close, tSettleSlots);
}

/** `slot > close_slot + t_settle_slots`, the bound saturating. */
export function isExpired(slot: bigint, close: bigint, tSettleSlots: bigint): boolean {
  return slot > satAdd(close, tSettleSlots);
}

/**
 * `slot ≥ from + refund_slots`, the bound saturating, `from` the slot the
 * window counts from: the round's latest join (`refundFrom`).
 */
export function refundOpen(slot: bigint, from: bigint, refundSlots: bigint): boolean {
  return slot >= satAdd(from, refundSlots);
}

/**
 * The slot a round's refund window counts from (`Round::refund_from`): its
 * latest join, or its first for a round written before `last_join_slot`.
 */
export function refundFrom(round: { firstSlot: bigint; lastJoinSlot: bigint }): bigint {
  return round.lastJoinSlot > round.firstSlot ? round.lastJoinSlot : round.firstSlot;
}

/** `C = funded + request_share − min(refund, funded)`. */
export function drawCost(funded: bigint, requestShare: bigint, refund: bigint): bigint {
  return u64(funded + requestShare - (refund < funded ? refund : funded), "draw cost");
}

/** `ceil((C − min(S, C)) × price / R)`: a settled ticket's share of the draw. */
export function charge(cost: bigint, sponsorship: bigint, prices: bigint, price: bigint): bigint {
  if (price > prices) throw new RangeError("a ticket's price above the round's");
  if (price === 0n) return 0n;
  const charged = cost > sponsorship ? cost - sponsorship : 0n;
  return u64(ceilDiv(charged * price, prices), "charge");
}

/** `floor((S − min(S, C)) × amount / S)`, or all of `amount` if the round was never drawn. */
export function sponsorReturn(
  cost: bigint,
  sponsorship: bigint,
  amount: bigint,
  drawn: boolean,
): bigint {
  if (amount > sponsorship) throw new RangeError("a sponsorship above the round's");
  if (!drawn || amount === 0n) return amount;
  const left = sponsorship > cost ? sponsorship - cost : 0n;
  return (left * amount) / sponsorship;
}

/** `floor(price × m / BPS)` (`payout_table::payout`). */
export function payout(price: bigint, mBps: bigint): bigint {
  return u64((price * mBps) / BPS, "payout");
}
