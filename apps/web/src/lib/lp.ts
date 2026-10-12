// The liquidity-provider side: request a deposit or a withdrawal, strike an
// epoch, claim either. Claims are permissionless: the keeper sends them, and
// any signer may send them instead.
import { AccountRole, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import {
  getClaimDepositInstructionAsync,
  getClaimWithdrawInstructionAsync,
  getRequestDepositInstructionAsync,
  getRequestWithdrawInstructionAsync,
  getStrikeEpochInstructionAsync,
} from "../../../../clients/js/src/generated/fade";
import {
  ATA_PROGRAM,
  PROGRAM,
  PROGRAM_CONFIG,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
} from "./config";
import { CHAIN_R_MIN, withdrawDue } from "./shares";
import {
  ata,
  chainNow,
  depositRequestPda,
  epochRecordPda,
  fetchEpochRecord,
  joiningEpochId,
  pdas,
  withdrawRequestPda,
  type DepositRequest,
  type EpochRecord,
  type Queue,
  type WithdrawRequest,
} from "./fade";

/**
 * A request joins the epoch the chain's clock picks when it executes; the account is derived from
 * the epoch it would join now. `epochId` is that epoch: if the epoch moves before the transaction
 * lands (a long wallet prompt across a close), the program refuses the seeds and the caller
 * rebuilds.
 */
export type RequestInstruction = { ix: Instruction; epochId: bigint };

export async function requestDepositInstruction(
  owner: TransactionSigner,
  queue: Queue,
  amount: bigint,
): Promise<RequestInstruction> {
  const p = await pdas();
  const epochId = joiningEpochId(queue, await chainNow());
  const ix = await getRequestDepositInstructionAsync(
    {
      owner,
      ownerUsdc: await ata(owner.address),
      usdcMint: USDC_MINT,
      request: await depositRequestPda(epochId, owner.address),
      eventAuthority: p.eventAuthority,
      program: PROGRAM,
      amount,
    },
    PROGRAM_CONFIG,
  );
  return { ix, epochId };
}

export async function strikeInstruction(
  caller: TransactionSigner,
  epochId: bigint,
): Promise<Instruction> {
  const p = await pdas();
  return getStrikeEpochInstructionAsync(
    {
      caller,
      record: await epochRecordPda(epochId),
      usdcMint: USDC_MINT,
      eventAuthority: p.eventAuthority,
      program: PROGRAM,
    },
    PROGRAM_CONFIG,
  );
}

/**
 * Creates `owner`'s associated token account for `mint` if it is missing, paid by `payer` (the
 * Associated Token program's CreateIdempotent). A parked claim needs the account to exist.
 */
export async function createAtaIdempotent(
  payer: TransactionSigner,
  owner: Address,
  mint: Address,
): Promise<Instruction> {
  return {
    programAddress: ATA_PROGRAM,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: await ata(owner, mint), role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]),
  } as Instruction;
}

/**
 * The deposit claim, as the keeper sends it. A parked one (the owner's share account could not
 * receive) first creates that account if it is missing.
 */
export async function claimDepositInstruction(
  caller: TransactionSigner,
  request: { address: Address; data: DepositRequest },
): Promise<Instruction[]> {
  const p = await pdas();
  const record = request.data.parked ? null : await fetchEpochRecord(request.data.epochId);
  const create = request.data.parked
    ? [await createAtaIdempotent(caller, request.data.owner, p.shareMint)]
    : [];
  const ix = await getClaimDepositInstructionAsync(
    {
      caller,
      request: request.address,
      owner: request.data.owner,
      ...(record
        ? { record: await epochRecordPda(request.data.epochId), rentReceiver: record.rentPayer }
        : {}),
      ownerShares: await ata(request.data.owner, p.shareMint),
      eventAuthority: p.eventAuthority,
      program: PROGRAM,
    },
    PROGRAM_CONFIG,
  );
  return [...create, ix];
}

/** `shares` of the owner's vault shares, priced at the strike of the epoch it lands in. */
export async function requestWithdrawInstruction(
  owner: TransactionSigner,
  queue: Queue,
  shares: bigint,
): Promise<RequestInstruction> {
  const p = await pdas();
  const epochId = joiningEpochId(queue, await chainNow());
  const ix = await getRequestWithdrawInstructionAsync(
    {
      owner,
      ownerShares: await ata(owner.address, p.shareMint),
      usdcMint: USDC_MINT,
      request: await withdrawRequestPda(epochId, owner.address),
      eventAuthority: p.eventAuthority,
      program: PROGRAM,
      shares,
    },
    PROGRAM_CONFIG,
  );
  return { ix, epochId };
}

type Record_ = { address: Address; data: EpochRecord };

export type WithdrawPick = {
  /** The record the claim reads the chain at. */
  at: Record_;
  /** The request's own record, on its first claim when `at` is another one. */
  entry: Record_ | null;
  /** The chain still runs at `at`: this claim pays what is due so far, the rest stays queued. */
  partial: boolean;
  /** USDC this claim pays (before any parked amount): due at `at` less what was paid already. */
  dueNow: bigint;
  /** The chain indices the request entered at: its own, or the entry record's on a first claim. */
  rEntry: bigint;
  vEntry: bigint;
};

/**
 * The records a withdrawal claim reads, as the program allows (claims.rs `claim_withdraw`):
 * - the first record of the request's chain that ends or splits it, where the claim settles it;
 * - otherwise the latest record of the chain still open, where a partial claim pays what the
 *   strikes so far delivered (only when that is more than what was already paid);
 * plus the request's own record on its first claim when that is another one. Null while nothing
 * is claimable: not struck yet, or rationed with nothing new to pay.
 */
export function withdrawClaimRecords(
  request: WithdrawRequest,
  records: readonly Record_[],
): WithdrawPick | null {
  if (request.parked) return null;
  const byEpoch = new Map(records.map((r) => [r.data.epochId, r]));
  const first = request.rEntry === 0n;
  const own = byEpoch.get(request.epochId) ?? null;
  if (first && !own) return null;
  const chain = first && own ? own.data.chainId : request.chainId;
  const from = first || request.chainId < request.epochId ? request.epochId : request.chainId;
  let end: Record_ | null = null;
  let latest: Record_ | null = null;
  for (const rec of records) {
    const { epochId, chainId, rAfter } = rec.data;
    if (epochId < from || chainId !== chain) continue;
    if (!latest || epochId > latest.data.epochId) latest = rec;
    if (rAfter !== 0n && rAfter >= CHAIN_R_MIN) continue;
    if (!end || epochId < end.data.epochId) end = rec;
  }
  const at = end ?? latest;
  if (!at) return null;
  // the indices the request entered the chain at: set by its first claim from the record it
  // read the chain from (its own if that is `at`, else its own record as the entry)
  const enteredAt = first ? (at.data.epochId === request.epochId ? at : own!) : null;
  const rEntry = enteredAt ? enteredAt.data.rBefore : request.rEntry;
  const vEntry = enteredAt ? enteredAt.data.vBefore : request.vEntry;
  const due = withdrawDue(request.shares, rEntry, vEntry, at.data.vAfter);
  if (due === null) return null;
  const dueNow = due > request.paid ? due - request.paid : 0n;
  const partial = end === null;
  // a partial claim must pay something; a chain read (end or split) settles the request anyway
  if (partial && dueNow === 0n) return null;
  return {
    at,
    entry: first && at.data.epochId !== request.epochId ? own : null,
    partial,
    dueNow,
    rEntry,
    vEntry,
  };
}

/**
 * The claim the keeper would send for this request, sent by `caller`
 * instead. A parked request reads no record: it delivers to the owner's
 * USDC account once that account can receive.
 */
export async function claimWithdrawInstruction(
  caller: TransactionSigner,
  request: { address: Address; data: WithdrawRequest },
  records: readonly Record_[],
): Promise<Instruction[]> {
  const p = await pdas();
  const pick = request.data.parked ? null : withdrawClaimRecords(request.data, records);
  if (!request.data.parked && !pick) throw new Error("nothing to claim yet: not priced");
  const create = request.data.parked
    ? [await createAtaIdempotent(caller, request.data.owner, USDC_MINT)]
    : [];
  const ix = await getClaimWithdrawInstructionAsync(
    {
      caller,
      request: request.address,
      owner: request.data.owner,
      ...(pick
        ? {
            atRecord: pick.at.address,
            rentReceiver: pick.at.data.rentPayer,
            ...(pick.entry
              ? { entryRecord: pick.entry.address, entryRentReceiver: pick.entry.data.rentPayer }
              : {}),
          }
        : {}),
      ownerUsdc: await ata(request.data.owner, USDC_MINT),
      usdcMint: USDC_MINT,
      eventAuthority: p.eventAuthority,
      program: PROGRAM,
    },
    PROGRAM_CONFIG,
  );
  return [...create, ix];
}
