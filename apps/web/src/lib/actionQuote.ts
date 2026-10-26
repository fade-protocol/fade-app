// The deposit / withdraw card's figures: the amount a request carries, what it is estimated to
// receive, its fees in SOL and the deposit's projection at the vault's APR. Pure, so
// each is tested against the program's share arithmetic (tests/ts/web/actionQuote.test.ts).
import type { RiskParams, Vault } from "./fade";
import { parseUsdc } from "./format";
import { sharesFor, sharesWorth, valueOf } from "./providers";

/** Rent-exempt minimum of an account of `size` bytes (Solana's fixed rent schedule). */
export const rentFor = (size: number) => BigInt((128 + size) * 3480 * 2);
export const DEPOSIT_REQUEST_SPACE = 67;
export const WITHDRAW_REQUEST_SPACE = 115;
/** A transaction's signature fee plus its small priority fee, rounded up. */
export const TX_FEE = 10_000n;
/** Rent of a token account (165 bytes), created on a first deposit or a first withdrawal. */
export const TOKEN_ACCOUNT_RENT = rentFor(165);
/** One cent: the card shows USDC to the cent. */
const CENT = 10_000n;
/** A USDC amount typed for a withdrawal takes the whole position when it is within this many shares of it. */
export const DUST_SHARES = 1_000n;

export type Side = "deposit" | "withdraw";

/**
 * The amount of a request and its estimate at today's price. Deposit: micro-USDC in, shares
 * out. Withdrawal: shares in, micro-USDC out; a USDC amount typed in takes the fewest shares
 * worth it, or the whole position when that is a dust away or the position's value as shown.
 */
export function requestAmount(args: {
  side: Side;
  /** A quick pick, in percent of the balance; null when an amount is typed. */
  pct: number | null;
  text: string;
  usdcBalance: bigint;
  shareBalance: bigint;
  vault: Vault;
}): { amount: bigint | null; estimate: bigint | null } {
  const { side, pct, text, usdcBalance, shareBalance, vault } = args;
  if (side === "deposit") {
    const amount = pct !== null ? (usdcBalance * BigInt(pct)) / 100n : parseUsdc(text);
    return { amount, estimate: amount === null ? null : sharesFor(amount, vault) };
  }
  let amount: bigint | null;
  if (pct !== null) amount = pct === 100 ? shareBalance : (shareBalance * BigInt(pct)) / 100n;
  else {
    const asUsdc = parseUsdc(text);
    const need = asUsdc === null ? null : sharesWorth(asUsdc, vault);
    // the position as the card shows it, to the cent, is the whole position
    const value = valueOf(shareBalance, vault);
    const shown = asUsdc !== null && asUsdc <= value && value - asUsdc < CENT;
    amount =
      need === null
        ? null
        : shareBalance > 0n &&
            (shown || (need > shareBalance && need - shareBalance <= DUST_SHARES))
          ? shareBalance
          : need;
  }
  return { amount, estimate: amount === null ? null : valueOf(amount, vault) };
}

/**
 * A request's SOL: the delivery fee unless a request of the same epoch already paid it, the
 * pricing fee while the pricing fund is under its target, the network fee, and the rent of the
 * request account (returned at delivery) and of a token account created on the way. `fees` is
 * what is spent; `needed` what the wallet must hold.
 */
export function requestFees(args: {
  side: Side;
  params: Pick<RiskParams, "claimFeeLamports" | "strikeFeeLamports" | "fundTargetLamports">;
  /** The owner already has a request in the epoch this one joins: same account, fee paid. */
  hasRequest: boolean;
  /** The pricing fund, lamports; null while unread. */
  fund: bigint | null;
  /** The token account the request delivers to is missing: the request creates it. */
  createsTokenAccount: boolean;
}) {
  const { side, params, hasRequest, fund, createsTokenAccount } = args;
  const claimFee = hasRequest ? 0n : params.claimFeeLamports;
  const strikeFee =
    fund !== null && fund < params.fundTargetLamports ? params.strikeFeeLamports : 0n;
  const rent = hasRequest
    ? 0n
    : rentFor(side === "deposit" ? DEPOSIT_REQUEST_SPACE : WITHDRAW_REQUEST_SPACE);
  const tokenRent = createsTokenAccount ? TOKEN_ACCOUNT_RENT : 0n;
  return {
    claimFee,
    strikeFee,
    rent,
    tokenRent,
    fees: claimFee + strikeFee + TX_FEE,
    needed: claimFee + strikeFee + rent + tokenRent + TX_FEE,
  };
}

/**
 * A deposit's projection over a year at `aprPct` percent, in micro-USDC, rounded down; null
 * without an APR or an amount (never from a number that is not finite).
 */
export function projectedPerYear(amount: bigint | null, aprPct: number | null): bigint | null {
  if (aprPct === null || !Number.isFinite(aprPct) || !amount) return null;
  return (amount * BigInt(Math.round(aprPct * 100))) / 10_000n;
}
