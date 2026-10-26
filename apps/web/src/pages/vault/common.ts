import type { Address, TransactionSigner } from "@solana/kit";
import type { ProtocolState } from "../../lib/fade";
import type { LpItem, LpLog } from "../../lib/history";
import type { PendingRequest, Summary } from "../../lib/position";
import type { DepositReq, ProviderLine, Rec, WithdrawReq } from "../../lib/providers";
import { TxError, type ProgramFailure } from "../../lib/tx";

export type Live = Extract<ProtocolState, { initialized: true }>;

export type Requests = {
  deposits: DepositReq[];
  withdraws: WithdrawReq[];
  records: Rec[];
  /**
   * Whose requests were read: everyone's while the app lists the providers itself, else the
   * owner's alone (none without an owner). The open epoch records are read in full either way.
   */
  scope: "all" | Address | null;
};

export type WalletBalances = {
  usdc: bigint | null;
  shares: bigint;
  sol: bigint;
  /** The owner's share account exists: a first deposit creates it (and pays its rent). */
  hasShareAccount: boolean;
  /** The owner's USDC account exists: a withdrawal creates it if not. */
  hasUsdcAccount: boolean;
};

/** Everything the vault page reads, shared by its panels. */
export type VaultData = {
  state: Live;
  /** The connected wallet, or the address viewed read-only. */
  owner: Address | undefined;
  signer: TransactionSigner | undefined;
  log: LpLog | null;
  logError: string | null;
  requests: Requests | null;
  /**
   * The liquidity providers, largest holding first (lib/keeperViews `chooseProviders`): the
   * keeper's list, or the app's own scan while the keeper cannot serve it, with the owner's own
   * line read from the chain. `firstDeposits`: each line's first deposit is known where it has one.
   * Null while waiting, and on a page that does not show them (`useVaultData` `providers: false`).
   */
  providers: { lines: ProviderLine[]; firstDeposits: boolean } | null;
  wallet: WalletBalances | null;
  ownerLog: LpItem[] | null;
  /** The owner's open requests with their phase. */
  pending: PendingRequest[] | null;
  summary: Summary | null;
  /** The strike fund: the Queue's spare lamports. */
  fund: bigint | null;
  refresh: () => void;
};

export const asFailure = (e: unknown): ProgramFailure =>
  e instanceof TxError
    ? e.failure
    : e instanceof Error && /reject|denied|cancel/i.test(e.message)
      ? { code: null, name: CANCELLED, message: "The wallet declined to sign.", logs: [] }
      : {
          code: null,
          name: null,
          message: e instanceof Error ? e.message : String(e),
          logs: [],
        };

const CANCELLED = "Cancelled";

/** The user declined in the wallet: nothing happened, and it is not an error. */
export const isCancelled = (f: ProgramFailure) => f.name === CANCELLED;

/**
 * The keeper got there first: the request or record is already closed (AccountNotInitialized,
 * 3012), a partial claim already taken (NothingToClaim, 6049), or the epoch already struck
 * (ConstraintSeeds, 2006, or the record already in use).
 */
export function doneByKeeper(f: ProgramFailure, what: "claim" | "strike"): boolean {
  if (f.code === 3012 || f.name === "AccountNotInitialized") return true;
  if (what === "claim") return f.code === 6049 || f.name === "NothingToClaim";
  return f.code === 2006 || f.name === "ConstraintSeeds" || /already in use/i.test(f.message);
}

/** The program refused the request account's seeds: the epoch moved while the wallet was open. */
export const epochMoved = (f: ProgramFailure) => f.code === 2006 || f.name === "ConstraintSeeds";

/** "~3 min" / "~40 s" for a wait in seconds. */
export function about(seconds: number): string {
  if (seconds <= 0) return "moments";
  if (seconds < 90) return `~${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  return `~${Math.round(seconds / 60)} min`;
}

/** How long after its strike a claim may wait before the page offers to send it. */
export const KEEPER_GRACE_SECONDS = 90;
