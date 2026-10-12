// Fade's admission arithmetic, mirrored from crates/fade-math in exact bigint
// integers. The program is the authority: the app uses these to explain a
// payout table and to predict a refusal before asking for a signature, and every
// transaction is still simulated against the program before it is signed.
import type { RiskParams } from "./fade";

export const P_SCALE = 1_000_000_000n;
export const BPS = 10_000n;
export const MAX_OUTCOMES = 32;
export const M_CEILING_BPS = 10_000n * BPS;

export type Outcome = { p: bigint; m: bigint };

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const mulBps = (amount: bigint, bps: bigint) => (amount * bps) / BPS;

/** What an outcome pays on a ticket of `price`, rounded down (fade-math `payout_table::payout`). */
export const payout = (price: bigint, mBps: bigint) => (price * mBps) / BPS;

export type Summary = { lhs: bigint; maxM: bigint };

export type PayoutTableProblem =
  | "OutcomeCount"
  | "ProbabilityRange"
  | "ProbabilitySum"
  | "MultiplierCeiling"
  | "PayoutTableOverpays";

/** `validate`: shape and sums. The margin is checked separately. */
export function summarize(outcomes: readonly Outcome[]): Summary | { problem: PayoutTableProblem } {
  if (outcomes.length === 0 || outcomes.length > MAX_OUTCOMES) return { problem: "OutcomeCount" };
  let lhs = 0n;
  let sum = 0n;
  let maxM = 0n;
  for (const b of outcomes) {
    if (b.p <= 0n || b.p > P_SCALE) return { problem: "ProbabilityRange" };
    if (b.m > M_CEILING_BPS) return { problem: "MultiplierCeiling" };
    sum += b.p;
    lhs += b.p * b.m;
    if (b.m > maxM) maxM = b.m;
  }
  if (sum !== P_SCALE) return { problem: "ProbabilitySum" };
  return { lhs, maxM };
}

/** The margin a payout table carries, in bps, rounded down; null when it pays out more than it takes in. */
export function marginBps(lhs: bigint): bigint | null {
  const rtp = ceilDiv(lhs, P_SCALE);
  return rtp > BPS ? null : BPS - rtp;
}

/** Expected return in bps, rounded up as the program rounds it. */
export const rtpBps = (lhs: bigint) => ceilDiv(lhs, P_SCALE);

export type Vault = { assets: bigint; reserved: bigint; openCredits: bigint };

export const freeBalance = (vault: Vault) => {
  const f = vault.assets - vault.reserved - vault.openCredits;
  return f > 0n ? f : 0n;
};

/**
 * The most that may leave the vault at a close, keeping gross solvency and `reserved ≤ κ · assets`
 * (fade-math `risk::withdrawable`): `assets − max(reserved + open credits, ceil(reserved · BPS / κ))`.
 */
export function withdrawable(vault: Vault, kappaBps: bigint): bigint {
  const committed = vault.reserved + vault.openCredits;
  const forKappa = kappaBps === 0n ? vault.assets : ceilDiv(vault.reserved * BPS, kappaBps);
  const keep = committed > forKappa ? committed : forKappa;
  return vault.assets > keep ? vault.assets - keep : 0n;
}

/** `min(kelly_fraction · margin · free, censorship · assets)`, halved after a drawdown. */
export function perTicketCap(
  vault: Vault,
  vaultMarginBps: bigint,
  params: RiskParams,
  halved = false,
) {
  const kelly = mulBps(mulBps(freeBalance(vault), vaultMarginBps), params.kellyFractionBps);
  const censor = mulBps(vault.assets, params.censorshipBps);
  const cap = kelly < censor ? kelly : censor;
  return halved ? cap / 2n : cap;
}

export type Refusal =
  | PayoutTableProblem
  | "MarginFloor"
  | "AppShareTooHigh"
  | "PriceBounds"
  | "PerTicketCap"
  | "IntegratorCap"
  | "UtilisationBreaker"
  | "GlobalExposure"
  | "Insolvent";

export type Quote = {
  price: bigint;
  vaultCredit: bigint;
  payoutMax: bigint;
  liability: bigint;
  marginBps: bigint | null;
  vaultMarginBps: bigint | null;
  cap: bigint | null;
  refusal: Refusal | null;
};

/**
 * What `open_ticket` would decide for this price and payout table against the vault
 * as read, in the program's order: payout table, split, price bounds, per-ticket
 * cap, integrator ceiling, utilisation, kappa, solvency.
 */
export function quote(args: {
  outcomes: readonly Outcome[];
  price: bigint;
  appShareBps: bigint;
  params: RiskParams;
  vault: Vault;
  integratorReserved?: bigint;
  halved?: boolean;
}): Quote {
  const { outcomes, price, appShareBps, params, vault } = args;
  const appShare = mulBps(price, appShareBps);
  const protocolShare = mulBps(price, params.protocolShareBps);
  const vaultCredit = price - appShare - protocolShare;
  const base: Quote = {
    price,
    vaultCredit,
    payoutMax: 0n,
    liability: 0n,
    marginBps: null,
    vaultMarginBps: null,
    cap: null,
    refusal: null,
  };
  const s = summarize(outcomes);
  if ("problem" in s) return { ...base, refusal: s.problem };
  const payoutMax = payout(price, s.maxM);
  const liability = payoutMax > vaultCredit ? payoutMax - vaultCredit : 0n;
  const q: Quote = { ...base, payoutMax, liability };
  const margin = marginBps(s.lhs);
  if (margin === null) return { ...q, refusal: "PayoutTableOverpays" };
  q.marginBps = margin;
  if (appShareBps > params.maxAppShareBps) return { ...q, refusal: "AppShareTooHigh" };
  const vaultMargin = margin - appShareBps - params.protocolShareBps;
  if (vaultMargin < params.minVaultMarginBps) return { ...q, refusal: "MarginFloor" };
  q.vaultMarginBps = vaultMargin;
  const floor = params.minVaultMarginBps + params.protocolShareBps + appShareBps;
  if (floor > BPS || s.lhs > (BPS - floor) * P_SCALE) return { ...q, refusal: "MarginFloor" };
  if (price < params.minPrice || price > params.maxPrice) return { ...q, refusal: "PriceBounds" };
  const cap = perTicketCap(vault, vaultMargin, params, args.halved ?? false);
  q.cap = cap;
  if (liability > cap) return { ...q, refusal: "PerTicketCap" };
  const ceiling = mulBps(vault.assets, params.whaleBps);
  if ((args.integratorReserved ?? 0n) + liability > ceiling)
    return { ...q, refusal: "IntegratorCap" };
  const after = {
    assets: vault.assets + vaultCredit,
    reserved: vault.reserved + liability,
    openCredits: vault.openCredits + vaultCredit,
  };
  const committed = after.reserved + after.openCredits;
  if (committed * BPS > after.assets * params.utilisationBreakerBps)
    return { ...q, refusal: "UtilisationBreaker" };
  if (after.reserved * BPS > after.assets * params.kappaBps)
    return { ...q, refusal: "GlobalExposure" };
  if (committed > after.assets) return { ...q, refusal: "Insolvent" };
  return q;
}

/**
 * The smallest vault whose per-ticket cap carries `liability` at `vaultMarginBps`,
 * if the vault's current commitments stay as they are: both the censorship
 * bound on assets and the Kelly bound on the free balance must reach it, through
 * the same floors as `perTicketCap`, and twice over while the cap is halved.
 */
export function assetsNeededFor(
  liability: bigint,
  vaultMarginBps: bigint,
  params: RiskParams,
  vault: Vault,
  halved = false,
): bigint {
  // `cap / 2 ≥ L` ⇔ `cap ≥ 2L`; `floor(x · b / BPS) ≥ y` ⇔ `x ≥ ceil(y · BPS / b)`
  const need = halved ? liability * 2n : liability;
  const atLeast = (y: bigint, b: bigint) => ceilDiv(y * BPS, b);
  const byCensor = atLeast(need, params.censorshipBps);
  const freeNeeded = atLeast(atLeast(need, params.kellyFractionBps), vaultMarginBps);
  const byKelly = freeNeeded + vault.reserved + vault.openCredits;
  return byCensor > byKelly ? byCensor : byKelly;
}

/**
 * "The whole amount or nothing": the two-outcome payout table whose win pays at
 * least `target` on `price`, with the largest probability that still keeps
 * `marginBps`. Integer-exact: `p · m ≤ (BPS − margin) · P_SCALE`.
 */
export function allOrNothing(price: bigint, target: bigint, margin: bigint): Outcome[] {
  const m = ceilDiv(target * BPS, price);
  const p = ((BPS - margin) * P_SCALE) / m;
  return [
    { p, m },
    { p: P_SCALE - p, m: 0n },
  ];
}
