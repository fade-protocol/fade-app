// The pure part of the liquidity providers' list (GET /v1/providers, served by the Stats Durable
// Object, stats.ts): the answer built from one read of the share mint's token accounts, the open
// deposit and withdrawal requests, the open epoch records and the vault, and the first deposit
// request of each owner, read from the Queue's history (every `request_deposit` writes the
// Queue). The arithmetic is the app's own (apps/web/src/lib/providers.ts), so the keeper's list
// and the one the app falls back on agree on the same accounts.
import type { Address } from "@solana/kit";
import {
  DEPOSIT_REQUESTED_EVENT_DISCRIMINATOR,
  getDepositRequestedEventDecoder,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  providerLines,
  providerRows,
  type DepositReq,
  type Rec,
  type VaultTotals,
  type WithdrawReq,
} from "../../web/src/lib/providers.ts";
import { startsWith } from "./chain.ts";
import { eventBodiesOf, type JsonTx } from "./statsIndex.ts";

/** GET /v1/providers: every liquidity provider, largest holding first. */
export type ProvidersView = {
  /** ISO 8601: when the accounts behind this answer were read. */
  updatedAt: string;
  /**
   * The Queue's history is not read back to the program's start yet: the first deposits are not
   * known (each `firstDepositAt` is null meanwhile).
   */
  firstDepositsSyncing: boolean;
  /** How many providers: holders of fvUSDC, and owners of a request still open. */
  count: number;
  /** Every fvUSDC, as the vault read with the accounts counts them. */
  totalShares: string;
  /** Shares in fvUSDC base units, value in micro-USDC, as decimal strings. */
  rows: {
    owner: string;
    /** fvUSDC in the wallet. */
    shares: string;
    /** USDC of deposits not priced yet. */
    depositIn: string;
    /** fvUSDC still queued for withdrawal, in the vault's escrow. */
    sharesOut: string;
    /** The wallet's and the queued fvUSDC at the vault's settled price. */
    value: string;
    /** The wallet's and the queued fvUSDC over every share, in basis points, rounded down. */
    shareBps: string;
    /** Unix seconds of the owner's first deposit request; null when not known. */
    firstDepositAt: number | null;
  }[];
};

export type ProvidersInputs = {
  holders: readonly { owner: Address; amount: bigint }[];
  deposits: readonly DepositReq[];
  withdraws: readonly WithdrawReq[];
  records: readonly Rec[];
  vault: VaultTotals;
  /** The first deposit request read of each owner, Unix seconds. */
  firstDeposits: ReadonlyMap<Address, number>;
  /** The Queue's history is read back to the program's start. */
  firstDepositsKnown: boolean;
  /** Unix seconds: when the accounts were read. */
  now: number;
};

/** The answer of GET /v1/providers from one read of the accounts. */
export function providersView(i: ProvidersInputs): ProvidersView {
  const lines = providerLines(
    providerRows(i.holders, i.deposits, i.withdraws, i.records),
    i.vault,
    i.firstDepositsKnown ? i.firstDeposits : new Map(),
  );
  return {
    updatedAt: new Date(i.now * 1_000).toISOString(),
    firstDepositsSyncing: !i.firstDepositsKnown,
    count: lines.length,
    totalShares: i.vault.totalShares.toString(),
    rows: lines.map((l) => ({
      owner: l.owner,
      shares: l.shares.toString(),
      depositIn: l.depositIn.toString(),
      sharesOut: l.sharesOut.toString(),
      value: l.value.toString(),
      shareBps: l.shareBps.toString(),
      firstDepositAt: l.firstDepositAt,
    })),
  };
}

/** The owners of the deposit requests a successful transaction emits. */
export function depositOwnersOf(tx: JsonTx, program: Address): Address[] {
  const out: Address[] = [];
  for (const body of eventBodiesOf(tx, program)) {
    if (!startsWith(body, DEPOSIT_REQUESTED_EVENT_DISCRIMINATOR)) continue;
    try {
      out.push(getDepositRequestedEventDecoder().decode(body).owner);
    } catch {
      // not a decodable Fade event
    }
  }
  return out;
}
