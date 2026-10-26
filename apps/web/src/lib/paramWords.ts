// What the vault page calls each risk parameter when a governance change is
// pending, and how it writes its value. Every field of `RiskParams` has a name
// here, so that no pending change, a loosening included, can show as "no
// visible change", and every value is written exactly, so that none shows as
// "0.0000 SOL to 0.0000 SOL" either.
import { SHARE_DECIMALS, USDC_DECIMALS } from "./config";
import type { RiskParams } from "./fade";
import { bps, fixed, fv, sol, usdc } from "./format";

export const PARAM_WORDS: Record<keyof RiskParams, string> = {
  kellyFractionBps: "Kelly fraction",
  censorshipBps: "Cap on one payout",
  whaleBps: "Cap per app",
  utilisationBreakerBps: "Utilisation breaker",
  kappaBps: "Reserve ratio κ",
  drawdownBps: "Drawdown breaker",
  minPrice: "Minimum ticket price",
  maxPrice: "Maximum ticket price",
  minVaultMarginBps: "Vault margin floor",
  protocolShareBps: "Protocol share",
  maxAppShareBps: "Maximum app share",
  tSettleSlots: "Draw window",
  crankRequestLamports: "Draw request reward",
  crankSettleLamports: "Payout delivery reward",
  epochLengthSeconds: "Time between closes",
  claimFeeLamports: "Delivery fee",
  strikeFeeLamports: "Pricing fee",
  strikeRewardLamports: "Pricing reward",
  fundTargetLamports: "Pricing fund target",
  minDeposit: "Minimum deposit",
  minWithdrawShares: "Minimum withdrawal",
  minFirstDeposit: "Minimum first deposit",
  creditEnabled: "Credit",
  creditBase: "Credit base",
  creditRateBps: "Credit rate",
  // the shared draw of small tickets (Spec 09): a pending change to any of them is shown too
  beaconMinPrice: "Shared draw minimum ticket",
  beaconThreshold: "Shared draw threshold",
  roundK: "Payout caps per shared draw",
  tickSlots: "Shared draw tick",
  refundSlots: "Shared draw refund window",
  crankRoundSettleLamports: "Shared draw payout reward",
};

/**
 * The fewest decimals (at least `min`) that write `v`, a fixed-point value
 * with `decimals`, exactly: a pending change is never hidden by truncation.
 */
function exactDigits(v: bigint, decimals: number, min: number): number {
  let digits = decimals;
  let rest = v < 0n ? -v : v;
  while (digits > min && rest % 10n === 0n) {
    rest /= 10n;
    digits--;
  }
  return digits;
}

/** Lamports a 4-decimal SOL figure would truncate are written as whole lamports. */
const SOL_DIGITS = 4;

/**
 * A risk parameter's value as the pending-change panel writes it. Lossless:
 * two different values of one parameter never read the same, so a change
 * the council proposes, a loosening included, is always visible.
 */
export function formatParam(key: string, v: unknown): string {
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v !== "bigint") return String(v);
  if (key.endsWith("Bps")) return bps(v, exactDigits(v, 2, 2));
  if (key.endsWith("Lamports"))
    return exactDigits(v, 9, SOL_DIGITS) > SOL_DIGITS
      ? `${fixed(v, 0, 0)} lamports`
      : `${sol(v, SOL_DIGITS)} SOL`;
  if (key.endsWith("Seconds")) return `${v.toString()} s`;
  if (key.endsWith("Slots")) return `${v.toString()} slots`;
  if (key === "minWithdrawShares") return fv(v, exactDigits(v, SHARE_DECIMALS, 2));
  if (key === "roundK") return v.toString();
  return `${usdc(v, exactDigits(v, USDC_DECIMALS, 2))} USDC`;
}
