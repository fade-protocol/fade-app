// A win the settlement could not deliver: the beneficiary's USDC account was missing, frozen or
// not a USDC account, so the payout waits in the program's escrow and the ticket stays open as
// PayoutPending. `claim_payout` (permissionless) delivers it to that same account once it can
// receive. The wallet's ticket log only tells that a payout was parked; whether it still waits,
// and whether a claim would go through now, is read from the chain here.
import {
  fetchEncodedAccounts,
  getAddressDecoder,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  decodeTicket,
  getClaimPayoutInstructionAsync,
  TicketStatus,
  type Ticket,
} from "../../../../clients/js/src/generated/fade";
import { PROGRAM, PROGRAM_CONFIG, TOKEN_PROGRAM, USDC_MINT } from "./config";
import { ata, pdas } from "./fade";
import { createAtaIdempotent } from "./lp";
import { rpc } from "./rpc";
import type { TicketRow } from "./ticketLog";

/** An SPL token account's size, and where its fields sit. */
const TOKEN_ACCOUNT_LEN = 165;
const STATE_OFFSET = 108;
const INITIALIZED = 1;
const FROZEN = 2;

/** Whether an account could receive a USDC transfer, as the program's `can_receive` decides. */
export type Receiver = "ok" | "missing" | "frozen" | "unusable";

export function receiverOf(
  account: { programAddress: Address; data: Uint8Array } | null,
  mint: Address,
): Receiver {
  if (!account) return "missing";
  const { programAddress, data } = account;
  if (programAddress !== TOKEN_PROGRAM || data.length !== TOKEN_ACCOUNT_LEN) return "unusable";
  if (getAddressDecoder().decode(data.subarray(0, 32)) !== mint) return "unusable";
  const state = data[STATE_OFFSET];
  if (state === FROZEN) return "frozen";
  return state === INITIALIZED ? "ok" : "unusable";
}

/**
 * Where a parked payout stands:
 * - `claimable`: the ticket still holds it and its beneficiary can receive now, or is the
 *   wallet's own USDC account, missing, which the claim creates first (`createAccount`);
 * - `blocked`: it still waits, but a claim would fail (frozen, or not a USDC account);
 * - `claimed`: the ticket is closed, so the payout was delivered.
 */
export type Escrow =
  | { state: "claimable"; createAccount: boolean; ticket: Ticket }
  | { state: "blocked"; receiver: Receiver }
  | { state: "claimed" };

export function escrowOf(
  ticket: Ticket | null,
  receiver: Receiver,
  /** The beneficiary is the wallet's own USDC account (its associated token account). */
  ownAccount: boolean,
): Escrow | null {
  if (!ticket) return { state: "claimed" };
  if (ticket.status !== TicketStatus.PayoutPending) return null;
  if (receiver === "ok") return { state: "claimable", createAccount: false, ticket };
  if (receiver === "missing" && ownAccount)
    return { state: "claimable", createAccount: true, ticket };
  return { state: "blocked", receiver };
}

/** Tickets whose settlement parked a payout. */
export const parkedPayouts = (rows: readonly TicketRow[]) =>
  rows.filter((r) => r.end?.kind === "settled" && r.end.pending && r.end.payout > 0n);

/** The parked payouts of these tickets, read in one call: each ticket and its beneficiary. */
export async function readEscrows(
  rows: readonly TicketRow[],
  usdcAccount: Address,
): Promise<Map<Address, Escrow>> {
  const parked = parkedPayouts(rows);
  const out = new Map<Address, Escrow>();
  if (parked.length === 0) return out;
  const addresses = parked.flatMap((r) => [r.ticket, r.beneficiary]);
  const accounts = await fetchEncodedAccounts(rpc, addresses, { commitment: "confirmed" });
  parked.forEach((r, i) => {
    const t = accounts[2 * i]!;
    const b = accounts[2 * i + 1]!;
    const ticket = t.exists && t.programAddress === PROGRAM ? decodeTicket(t).data : null;
    const receiver = receiverOf(b.exists ? b : null, USDC_MINT);
    const escrow = escrowOf(ticket, receiver, r.beneficiary === usdcAccount);
    if (escrow) out.set(r.ticket, escrow);
  });
  return out;
}

/** `claim_payout` for a parked payout, after creating the wallet's USDC account if it is missing. */
export async function claimPayoutInstructions(
  caller: TransactionSigner,
  ticket: Address,
  escrow: Extract<Escrow, { state: "claimable" }>,
): Promise<Instruction[]> {
  const p = await pdas();
  // only the caller's own account is created, and only when it is the ticket's beneficiary
  const own = (await ata(caller.address)) === escrow.ticket.beneficiary;
  const create =
    escrow.createAccount && own
      ? [await createAtaIdempotent(caller, caller.address, USDC_MINT)]
      : [];
  const ix = await getClaimPayoutInstructionAsync(
    {
      caller,
      ticket,
      beneficiary: escrow.ticket.beneficiary,
      payer: escrow.ticket.payer,
      usdcMint: USDC_MINT,
      eventAuthority: p.eventAuthority,
      program: PROGRAM,
    },
    PROGRAM_CONFIG,
  );
  return [...create, ix];
}
