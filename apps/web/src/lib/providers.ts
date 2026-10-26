// The vault's liquidity providers, and the share price they are valued at: every holder of the
// share mint and everyone with a request still open, with their fvUSDC, their deposits waiting
// for a price and their shares queued out. Pure: the keeper works the list out from its own reads
// of the chain (GET /v1/providers, apps/keeper/src/providersIndex.ts) and the app from its own
// when the keeper cannot serve it, with these same functions, so both agree on the same accounts.
import { getBase58Decoder, type Address } from "@solana/kit";
import type {
  DepositRequest,
  EpochRecord,
  Vault,
  WithdrawRequest,
} from "../../../../clients/js/src/generated/fade";
import { stillQueued } from "./shares";

export type Rec = { address: Address; data: EpochRecord };
export type DepositReq = { address: Address; data: DepositRequest };
export type WithdrawReq = { address: Address; data: WithdrawRequest };

/** What the share price reads of the vault. */
export type VaultTotals = Pick<Vault, "totalAssets" | "openVaultCredits" | "totalShares">;

/**
 * The program prices shares against its settled assets with virtual offsets (fade-math
 * shares.rs): `A + 1` assets for `S + 1000` shares, so the first deposit mints at 1 USDC per share
 * (6 vs 9 decimals) and no division is ever by zero.
 */
const VIRTUAL_SHARES = 1_000n;
const VIRTUAL_ASSETS = 1n;
const settledAssets = (vault: VaultTotals) => {
  const a = vault.totalAssets - vault.openVaultCredits;
  return a > 0n ? a : 0n;
};

/** Micro-USDC value of `shares` at the vault's live settled price. */
export function valueOf(shares: bigint, vault: VaultTotals): bigint {
  return (shares * (settledAssets(vault) + VIRTUAL_ASSETS)) / (vault.totalShares + VIRTUAL_SHARES);
}

/** Shares `amount` micro-USDC buys at the live price (the strike's may differ). */
export function sharesFor(amount: bigint, vault: VaultTotals): bigint {
  return (amount * (vault.totalShares + VIRTUAL_SHARES)) / (settledAssets(vault) + VIRTUAL_ASSETS);
}

/** The fewest shares worth at least `amount` micro-USDC: a withdrawal typed in USDC leaves no dust. */
export function sharesWorth(amount: bigint, vault: VaultTotals): bigint {
  const d = settledAssets(vault) + VIRTUAL_ASSETS;
  return (amount * (vault.totalShares + VIRTUAL_SHARES) + d - 1n) / d;
}

/** A holding of `held` shares as a share of `total`, in basis points, rounded down. */
export const shareOfBps = (held: bigint, total: bigint) =>
  total === 0n ? 0n : (held * 10_000n) / total;

/**
 * Shares a withdrawal request still has queued: all of them until its first strike, then what its
 * chain's latest record leaves (`still_queued`).
 */
export function queuedOf(r: WithdrawRequest, records: readonly Rec[]): bigint {
  if (r.rEntry === 0n) return r.shares;
  let latest: Rec | null = null;
  for (const rec of records)
    if (rec.data.chainId === r.chainId && (!latest || rec.data.epochId > latest.data.epochId))
      latest = rec;
  return latest ? (stillQueued(r.shares, r.rEntry, latest.data.rAfter) ?? r.shares) : r.shares;
}

/** A token account's size (SPL Token), and where its owner and amount sit in it. */
export const TOKEN_ACCOUNT_SIZE = 165;

/**
 * The fvUSDC each wallet holds, from the share mint's token accounts (their raw data): a wallet's
 * accounts summed, empty ones and the vault's own (escrow, claims, owned by `vaultAuthority`)
 * left out.
 */
export function shareHoldersOf(
  accounts: readonly Uint8Array[],
  vaultAuthority: Address,
): { owner: Address; amount: bigint }[] {
  const out = new Map<Address, bigint>();
  const b58 = getBase58Decoder();
  for (const d of accounts) {
    if (d.length < 72) continue;
    const owner = b58.decode(d.subarray(32, 64)) as Address;
    const amount = new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(64, true);
    if (owner === vaultAuthority || amount === 0n) continue;
    out.set(owner, (out.get(owner) ?? 0n) + amount);
  }
  return [...out].map(([owner, amount]) => ({ owner, amount }));
}

/**
 * Everyone with a claim on the vault: share holders, and the owners of every deposit or withdrawal
 * request still open (parked ones included).
 */
export function providerOwners(
  holders: readonly { owner: Address }[],
  deposits: readonly DepositReq[],
  withdraws: readonly WithdrawReq[],
): Set<Address> {
  return new Set([
    ...holders.map((h) => h.owner),
    ...deposits.map((d) => d.data.owner),
    ...withdraws.map((w) => w.data.owner),
  ]);
}

export type ProviderRow = {
  owner: Address;
  /** fvUSDC in the wallet. */
  shares: bigint;
  /** USDC of deposits not priced yet. */
  depositIn: bigint;
  /** fvUSDC still queued for withdrawal, in the vault's escrow. */
  sharesOut: bigint;
};

/** Largest holding (wallet and queued out) first, then the largest deposit waiting. */
const byHolding = (a: ProviderRow, b: ProviderRow) => {
  const ha = a.shares + a.sharesOut;
  const hb = b.shares + b.sharesOut;
  if (ha !== hb) return hb > ha ? 1 : -1;
  return b.depositIn === a.depositIn ? 0 : b.depositIn > a.depositIn ? 1 : -1;
};

/**
 * The Providers table: one row per provider, its fvUSDC, its deposits waiting for a price and its
 * shares queued out (a rationed withdrawal holds only the shares still queued: the rest was burnt
 * and paid; parked requests hold no shares). Largest holding first.
 */
export function providerRows(
  holders: readonly { owner: Address; amount: bigint }[],
  deposits: readonly DepositReq[],
  withdraws: readonly WithdrawReq[],
  records: readonly Rec[],
): ProviderRow[] {
  const rows = new Map<Address, ProviderRow>();
  const row = (a: Address) => {
    let r = rows.get(a);
    if (!r) {
      r = { owner: a, shares: 0n, depositIn: 0n, sharesOut: 0n };
      rows.set(a, r);
    }
    return r;
  };
  for (const o of providerOwners(holders, deposits, withdraws)) row(o);
  for (const h of holders) row(h.owner).shares += h.amount;
  for (const d of deposits) if (!d.data.parked) row(d.data.owner).depositIn += d.data.amount;
  for (const w of withdraws)
    if (!w.data.parked) row(w.data.owner).sharesOut += queuedOf(w.data, records);
  return [...rows.values()].sort(byHolding);
}

/** A provider as the Providers table shows it. */
export type ProviderLine = ProviderRow & {
  /** Micro-USDC: the wallet's and the queued fvUSDC at the vault's settled price. */
  value: bigint;
  /** The wallet's and the queued fvUSDC over every share, in basis points, rounded down. */
  shareBps: bigint;
  /** Unix seconds of the provider's first deposit request; null when not known. */
  firstDepositAt: number | null;
};

/** The rows valued at `vault`, with each first deposit `firstDeposits` knows. */
export function providerLines(
  rows: readonly ProviderRow[],
  vault: VaultTotals,
  firstDeposits: ReadonlyMap<Address, number> = new Map(),
): ProviderLine[] {
  return rows.map((r) => {
    const held = r.shares + r.sharesOut;
    return {
      ...r,
      value: valueOf(held, vault),
      shareBps: shareOfBps(held, vault.totalShares),
      firstDepositAt: firstDeposits.get(r.owner) ?? null,
    };
  });
}

/**
 * The list with `owner`'s line as the app reads it from the chain (`own`: every share account
 * it owns and its open requests, valued at the live `vault`; `providerRows` over them) in place of
 * the one listed: added when the list does not have it yet, left out (`own` null) when the owner
 * no longer holds fvUSDC nor has a request open. Its first deposit is the earliest of the one
 * listed and `ownFirstDepositAt` (the owner's own history: a request the list has not read yet).
 * Largest holding first.
 */
export function withOwnLine(
  lines: readonly ProviderLine[],
  owner: Address,
  own: ProviderRow | null,
  vault: VaultTotals,
  ownFirstDepositAt: number | null = null,
): ProviderLine[] {
  const listed = lines.find((l) => l.owner === owner)?.firstDepositAt ?? null;
  const rest = lines.filter((l) => l.owner !== owner);
  if (!own) return rest;
  const [line] = providerLines([own], vault);
  const firstDepositAt =
    listed === null
      ? ownFirstDepositAt
      : ownFirstDepositAt === null
        ? listed
        : Math.min(listed, ownFirstDepositAt);
  return [...rest, { ...line!, firstDepositAt }].sort(byHolding);
}
