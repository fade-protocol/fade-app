// What a ticket's end could not deliver: the beneficiary's USDC account was missing, frozen or
// not a USDC account, so the payout waits in the program's escrow and the ticket stays open. A
// direct ticket stays PayoutPending until `claim_payout` delivers it; a beacon ticket stays
// PayoutParked, or ReturnParked for a refunded round's ticket price that its funder's account
// could not receive, until `claim_round_payout` does. Both claims are permissionless and pay
// that same account once it can receive. The wallet's ticket log only tells that something was
// parked; whether it still waits, and whether a claim would go through now, is read from the
// chain here.
import {
  fetchEncodedAccounts,
  getAddressDecoder,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getBeaconClaimPayoutInstructionAsync } from "../../../../clients/js/src/beacon/index.ts";
import {
  decodeRoundTicket,
  decodeTicket,
  getClaimPayoutInstructionAsync,
  RoundTicketStatus,
  TicketStatus,
  type RoundTicket,
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
 * Where a parked payout (or a parked beacon return) stands:
 * - `claimable`: the ticket still holds it and its destination can receive now, or is the
 *   wallet's own USDC account, missing, which the claim creates first (`createAccount`); a
 *   direct ticket carries `ticket`, a beacon one `roundTicket`;
 * - `blocked`: it still waits, but a claim would fail (frozen, or not a USDC account);
 * - `claimed`: the ticket is closed, so what it held was delivered.
 */
export type Escrow =
  | { state: "claimable"; createAccount: boolean; ticket: Ticket }
  | { state: "claimable"; createAccount: boolean; roundTicket: RoundTicket }
  | { state: "blocked"; receiver: Receiver }
  | { state: "claimed" };

type Claimable = Extract<Escrow, { state: "claimable" }>;

/** Where it stands once the ticket is known to still hold something parked. */
function parkedEscrow(
  holder: { ticket: Ticket } | { roundTicket: RoundTicket },
  receiver: Receiver,
  ownAccount: boolean,
): Escrow {
  if (receiver === "ok") return { state: "claimable", createAccount: false, ...holder };
  if (receiver === "missing" && ownAccount)
    return { state: "claimable", createAccount: true, ...holder };
  return { state: "blocked", receiver };
}

export function escrowOf(
  ticket: Ticket | null,
  receiver: Receiver,
  /** The beneficiary is the wallet's own USDC account (its associated token account). */
  ownAccount: boolean,
): Escrow | null {
  if (!ticket) return { state: "claimed" };
  if (ticket.status !== TicketStatus.PayoutPending) return null;
  return parkedEscrow({ ticket }, receiver, ownAccount);
}

/** Where a beacon ticket's parked payout or return stands; `receiver` is its destination's. */
export function roundEscrowOf(
  roundTicket: RoundTicket | null,
  receiver: Receiver,
  /** The destination is the wallet's own USDC account (its associated token account). */
  ownAccount: boolean,
): Escrow | null {
  if (!roundTicket) return { state: "claimed" };
  if (roundTicket.status === RoundTicketStatus.Joined) return null;
  return parkedEscrow({ roundTicket }, receiver, ownAccount);
}

/** Where a parked beacon ticket's claim pays: its beneficiary for a payout, its funder for a return. */
export const roundDestination = (t: RoundTicket): Address =>
  t.status === RoundTicketStatus.ReturnParked ? t.refundTo : t.beneficiary;

/**
 * Tickets whose end parked something for `usdcAccount` (the wallet's USDC account): a direct or
 * beacon win whose payout waits, a refunded direct ticket whose credit waits for its
 * beneficiary, or a refunded beacon ticket whose price waits to return there. A return to
 * another funder (an app that funded the ticket for the wallet) is that funder's.
 */
export const parkedPayouts = (rows: readonly TicketRow[], usdcAccount: Address) =>
  rows.filter(
    (r) =>
      !!r.end?.pending &&
      (r.end.kind === "settled"
        ? r.end.payout > 0n
        : r.end.creditReturned === true ||
          (r.end.refunded === true && r.beacon?.refundTo === usdcAccount)),
  );

/**
 * The parked payouts of these tickets: each ticket in one call, then the destinations of those
 * that still hold something (a beacon return's is its funder's account, read from the ticket).
 * A parked return to another funder is left out (`parkedPayouts`): no claim of it is offered.
 */
export async function readEscrows(
  rows: readonly TicketRow[],
  usdcAccount: Address,
): Promise<Map<Address, Escrow>> {
  const parked = parkedPayouts(rows, usdcAccount);
  const out = new Map<Address, Escrow>();
  if (parked.length === 0) return out;
  const held = await fetchEncodedAccounts(
    rpc,
    parked.map((r) => r.ticket),
    { commitment: "confirmed" },
  );
  // null: closed (or no longer the program's), so what it held was delivered
  const tickets = parked.map((r, i): { ticket: Ticket } | { roundTicket: RoundTicket } | null => {
    const t = held[i]!;
    if (!t.exists || t.programAddress !== PROGRAM) return null;
    return r.beacon ? { roundTicket: decodeRoundTicket(t).data } : { ticket: decodeTicket(t).data };
  });
  const destinations = tickets.map((t) =>
    t === null ? null : "roundTicket" in t ? roundDestination(t.roundTicket) : t.ticket.beneficiary,
  );
  const open = destinations.filter((d): d is Address => d !== null);
  const accounts = open.length
    ? await fetchEncodedAccounts(rpc, open, { commitment: "confirmed" })
    : [];
  let next = 0;
  parked.forEach((r, i) => {
    const t = tickets[i] ?? null;
    const d = destinations[i] ?? null;
    let escrow: Escrow | null;
    if (t === null || d === null) escrow = { state: "claimed" };
    else {
      const a = accounts[next++]!;
      const receiver = receiverOf(a.exists ? a : null, USDC_MINT);
      escrow =
        "roundTicket" in t
          ? roundEscrowOf(t.roundTicket, receiver, d === usdcAccount)
          : escrowOf(t.ticket, receiver, d === usdcAccount);
    }
    if (escrow) out.set(r.ticket, escrow);
  });
  return out;
}

/**
 * The claim of a parked payout (`claim_payout`, or `claim_round_payout` for a beacon ticket),
 * after creating the wallet's USDC account if it is the missing destination.
 */
export async function claimPayoutInstructions(
  caller: TransactionSigner,
  ticket: Address,
  escrow: Claimable,
): Promise<Instruction[]> {
  const destination =
    "roundTicket" in escrow ? roundDestination(escrow.roundTicket) : escrow.ticket.beneficiary;
  // only the caller's own account is created, and only when it is the ticket's destination
  const own = (await ata(caller.address)) === destination;
  const create =
    escrow.createAccount && own
      ? [await createAtaIdempotent(caller, caller.address, USDC_MINT)]
      : [];
  if ("roundTicket" in escrow)
    return [
      ...create,
      await getBeaconClaimPayoutInstructionAsync(
        caller,
        { address: ticket, data: escrow.roundTicket },
        USDC_MINT,
        PROGRAM_CONFIG,
      ),
    ];
  const p = await pdas();
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
