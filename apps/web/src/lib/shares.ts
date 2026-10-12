// The share arithmetic of fade-math (crates/fade-math/src/shares.rs), in bigints: what a deposit
// is due at its strike, and what a withdrawal is due along the chain of strikes it rides.
// Same floors as the program, so the page shows exactly what a claim pays.

/** The chain indices' scale (`INDEX_SCALE`): `r` starts there and only shrinks. */
export const INDEX_SCALE = 1_000_000_000_000_000_000n;
/** A record whose `r_after` is below this (and not 0) splits the chain (`CHAIN_R_MIN`). */
export const CHAIN_R_MIN = 1_000_000_000_000n;

/**
 * Assets due in total to `shares` that entered a chain at `(rEntry, vEntry)`, read at a later
 * record whose `v` is `vNow` (`withdraw_due`). Null where the program would refuse.
 */
export function withdrawDue(
  shares: bigint,
  rEntry: bigint,
  vEntry: bigint,
  vNow: bigint,
): bigint | null {
  if (rEntry === 0n || vNow < vEntry) return null;
  return (shares * (vNow - vEntry)) / rEntry;
}

/** Shares of the same withdrawal still queued at a record whose `r` is `rNow` (`still_queued`). */
export function stillQueued(shares: bigint, rEntry: bigint, rNow: bigint): bigint | null {
  if (rEntry === 0n) return null;
  return (shares * rNow) / rEntry;
}

/** Shares due to a deposit of `amount` in an epoch that minted `minted` for `deposits` (`deposit_due`). */
export function depositDue(amount: bigint, deposits: bigint, minted: bigint): bigint | null {
  if (deposits === 0n || amount > deposits) return null;
  return (amount * minted) / deposits;
}
