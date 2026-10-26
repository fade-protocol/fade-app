// One ticket, end to end, from the app's side: open it with a payout table, request
// the oracle's randomness once the slot after the open is final, wait for ORAO
// to fulfil, then settle. The keeper normally sends the last two; the user's
// wallet can send them too, and every step is simulated first.
import {
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getU64Encoder,
  type Address,
  type Instruction,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import {
  fetchMaybeTicket,
  findTicketPda,
  getOpenTicketInstructionAsync,
  getRequestRandomnessInstructionAsync,
  getSettleTicketInstructionAsync,
  REFUND_OUTCOME,
  TicketStatus,
  type Ticket,
} from "../../../../clients/js/src/generated/fade";
import type { TicketExpiredRecord } from "../../../../clients/js/src/direct/index.ts";
import { ORAO, PROGRAM, PROGRAM_CONFIG, SLOT_HASHES, USDC_MINT } from "./config";
import { eventsOf, fetchJsonTx } from "./events";
import { ata, fetchIntegrator, integratorPda, pdas, tokenBalance } from "./fade";
import type { Outcome } from "./math";
import { rpc, sleep } from "./rpc";

export type { Ticket };

const addressBytes = (a: Address) => new Uint8Array(getAddressEncoder().encode(a));
const u64 = (v: bigint) => new Uint8Array(getU64Encoder().encode(v));

async function accountBytes(a: Address): Promise<Uint8Array | null> {
  const { value } = await rpc
    .getAccountInfo(a, { encoding: "base64", commitment: "confirmed" })
    .send();
  return value ? new Uint8Array(getBase64Encoder().encode(value.data[0])) : null;
}

/**
 * Who opens the ticket. In these demos the user's wallet is its own app: it
 * signs as the integrator, pays the rent and the ticket price from its own USDC
 * account, and is the beneficiary. Its integrator record is created by its
 * first ticket.
 */
export type Opener = {
  owner: Address;
  usdcAccount: Address;
  usdcBalance: bigint | null;
  integrator: Address;
  shareAccount: Address;
  nonce: bigint;
  /** Liability the opener's integrator record already holds. */
  reserved: bigint;
};

export async function resolveOpener(owner: Address): Promise<Opener> {
  const usdcAccount = await ata(owner);
  const [usdcBalance, integrator, record] = await Promise.all([
    tokenBalance(usdcAccount),
    integratorPda(owner),
    fetchIntegrator(owner),
  ]);
  return {
    owner,
    usdcAccount,
    usdcBalance,
    integrator,
    shareAccount: record?.shareAccount ?? usdcAccount,
    nonce: record?.nextNonce ?? 0n,
    reserved: record?.reservedLiability ?? 0n,
  };
}

export async function ticketAddress(integrator: Address, nonce: bigint) {
  return (await findTicketPda({ integrator, nonce }, PROGRAM_CONFIG))[0];
}

export type OpenArgs = {
  signer: TransactionSigner;
  opener: Opener;
  treasury: Address;
  outcomes: readonly Outcome[];
  price: bigint;
  appShareBps: bigint;
};

export async function openTicketInstruction(a: OpenArgs): Promise<Instruction> {
  const p = await pdas();
  return getOpenTicketInstructionAsync(
    {
      integratorAuthority: a.signer,
      payer: a.signer,
      funder: a.signer,
      funderUsdc: a.opener.usdcAccount,
      shareAccount: a.opener.shareAccount,
      protocolTreasury: a.treasury,
      beneficiary: a.opener.usdcAccount,
      usdcMint: USDC_MINT,
      eventAuthority: p.eventAuthority,
      program: PROGRAM,
      price: a.price,
      payoutTable: a.outcomes.map((b) => ({ p: b.p, m: b.m })),
      appShareBps: a.appShareBps,
      nonce: a.opener.nonce,
    },
    PROGRAM_CONFIG,
  );
}

export async function fetchTicket(ticket: Address): Promise<Ticket | null> {
  const w = await fetchMaybeTicket(rpc, ticket, { commitment: "confirmed" });
  return w.exists ? w.data : null;
}

// --- randomness ----------------------------------------------------------------------

export async function oraoNetwork() {
  const [networkState] = await getProgramDerivedAddress({
    programAddress: ORAO,
    seeds: ["orao-vrf-network-configuration"],
  });
  const state = await accountBytes(networkState);
  if (!state) throw new Error("ORAO's network state is not readable on this cluster");
  const treasury = getAddressDecoder().decode(state.subarray(40, 72));
  const requestFee = new DataView(state.buffer, state.byteOffset + 72, 8).getBigUint64(0, true);
  return { networkState, treasury, requestFee };
}

/** The first SlotHashes entry strictly after `slot`, as the program reads it. */
export async function firstSlotHashAfter(
  slot: bigint,
): Promise<{ slot: bigint; hash: Uint8Array } | null> {
  const data = await accountBytes(SLOT_HASHES);
  if (!data) return null;
  const view = new DataView(data.buffer, data.byteOffset);
  const n = Number(view.getBigUint64(0, true));
  let found: { slot: bigint; hash: Uint8Array } | null = null;
  for (let i = 0; i < n; i++) {
    const off = 8 + i * 40;
    const s = view.getBigUint64(off, true);
    if (s <= slot) break;
    found = { slot: s, hash: data.slice(off + 8, off + 40) };
  }
  return found;
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

/** `SHA256("FADE/ORAO-SEED/v1" ‖ program ‖ ticket ‖ open_slot ‖ s* ‖ h*)` (Technical Specification §3.6). */
export function oraoSeed(
  ticket: Address,
  openSlot: bigint,
  entropySlot: bigint,
  entropyHash: Uint8Array,
) {
  return sha256(
    new TextEncoder().encode("FADE/ORAO-SEED/v1"),
    addressBytes(PROGRAM),
    addressBytes(ticket),
    u64(openSlot),
    u64(entropySlot),
    entropyHash,
  );
}

export async function oraoRequestAddress(seed: Uint8Array) {
  return (
    await getProgramDerivedAddress({
      programAddress: ORAO,
      seeds: ["orao-vrf-randomness-request", seed],
    })
  )[0];
}

/**
 * Waits until the first slot after the open is final in SlotHashes (two slots
 * after the open), then builds `request_randomness` for it.
 */
export async function requestRandomnessInstruction(
  caller: TransactionSigner,
  ticket: Address,
  openSlot: bigint,
  onWait?: (slotsLeft: bigint) => void,
): Promise<{ instruction: Instruction; request: Address }> {
  let entropy: Awaited<ReturnType<typeof firstSlotHashAfter>> = null;
  for (let i = 0; i < 90 && !entropy; i++) {
    const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
    if (slot >= openSlot + 2n) entropy = await firstSlotHashAfter(openSlot);
    else onWait?.(openSlot + 2n - slot);
    if (!entropy) await sleep(500);
  }
  if (!entropy) throw new Error("no slot after the open appeared in SlotHashes");
  const seed = await oraoSeed(ticket, openSlot, entropy.slot, entropy.hash);
  const request = await oraoRequestAddress(seed);
  const { treasury } = await oraoNetwork();
  const p = await pdas();
  const instruction = await getRequestRandomnessInstructionAsync(
    {
      caller,
      ticket,
      oraoTreasury: treasury,
      request,
      eventAuthority: p.eventAuthority,
      program: PROGRAM,
    },
    PROGRAM_CONFIG,
  );
  return { instruction, request };
}

/** ORAO's randomness v2 account: pending (tag 0) or fulfilled (tag 1, 137 bytes). */
export async function isFulfilled(request: Address): Promise<boolean> {
  const data = await accountBytes(request);
  return !!data && data[8] === 1 && data.length >= 137;
}

export async function waitFulfilled(request: Address, timeoutMs = 180_000): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (await isFulfilled(request)) return (Date.now() - started) / 1000;
    if (Date.now() - started > timeoutMs)
      throw new Error(
        "the oracle did not answer within 3 minutes; the draw can still finish later",
      );
    await sleep(1_200);
  }
}

export async function settleInstruction(
  caller: TransactionSigner,
  ticket: Address,
  w: Pick<Ticket, "integrator" | "randomness" | "beneficiary" | "payer">,
): Promise<Instruction> {
  const p = await pdas();
  return getSettleTicketInstructionAsync(
    {
      caller,
      integrator: w.integrator,
      ticket,
      randomness: w.randomness,
      beneficiary: w.beneficiary,
      payer: w.payer,
      usdcMint: USDC_MINT,
      eventAuthority: p.eventAuthority,
      program: PROGRAM,
    },
    PROGRAM_CONFIG,
  );
}

/**
 * The opener's most recent tickets still waiting for a step: requested and not
 * settled, or open and still inside the request window.
 */
export async function findUnfinished(
  owner: Address,
  lookBack = 3n,
): Promise<{ ticket: Address; data: Ticket }[]> {
  const opener = await resolveOpener(owner);
  const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
  const out: { ticket: Address; data: Ticket }[] = [];
  for (let n = opener.nonce > lookBack ? opener.nonce - lookBack : 0n; n < opener.nonce; n++) {
    const ticket = await ticketAddress(opener.integrator, n);
    const w = await fetchTicket(ticket);
    if (!w) continue;
    if (w.status === 1 || (w.status === 0 && slot <= w.expirySlot)) out.push({ ticket, data: w });
  }
  return out;
}

/**
 * A direct ticket's vault credit returned (`refund_expired_ticket`: its seed was never recorded
 * and can no longer be proven): no draw ran. `pending`: it waits in escrow for `claim_payout`.
 */
export type CreditRefund = { amount: bigint; pending: boolean };

/**
 * How a ticket ended, read back from its last transactions: drawn and settled (a late binding
 * included), or closed without a draw, forfeited or, `refund`, its vault credit returned. An
 * expiry read from the chain alone (a refund parked in escrow) may come without its signature.
 */
export type TicketEnd =
  | { kind: "settled"; outcome: number; payout: bigint; pending: boolean; signature: Signature }
  | { kind: "expired"; signature: Signature | null; refund?: CreditRefund };

/** The end a `TicketExpired` describes: a forfeiture, or a refund of the vault credit. */
export function expiryEnd(e: TicketExpiredRecord, signature: Signature | null): TicketEnd {
  return e.version === 2 && e.refunded
    ? { kind: "expired", signature, refund: { amount: e.refund, pending: e.parked } }
    : { kind: "expired", signature };
}

/** A `PayoutPending` ticket's `outcome` when what waits is a refunded credit, not a payout. */
export const isParkedRefund = (t: Pick<Ticket, "status" | "outcome">) =>
  t.status === TicketStatus.PayoutPending && t.outcome === REFUND_OUTCOME;

/**
 * A closed ticket's account is gone: its settle or expire transaction says how
 * it ended. Null while the RPC has not indexed it yet.
 */
export async function findTicketEnd(ticket: Address): Promise<TicketEnd | null> {
  const sigs = await rpc
    .getSignaturesForAddress(ticket, { limit: 8, commitment: "confirmed" })
    .send();
  for (const s of sigs) {
    if (s.err !== null) continue;
    const tx = await fetchJsonTx(s.signature).catch(() => null);
    if (!tx) continue;
    for (const e of eventsOf(tx)) {
      if (e.kind === "TicketSettled" && e.data.ticket === ticket)
        return {
          kind: "settled",
          outcome: e.data.outcome,
          payout: e.data.payout,
          pending: e.data.pending,
          signature: s.signature,
        };
      if (e.kind === "TicketExpired" && e.data.ticket === ticket)
        return expiryEnd(e.data, s.signature);
    }
  }
  return null;
}

/** What the chain says about a ticket right now. */
export type ChainView =
  | { gone: false; ticket: Ticket; slot: bigint; fulfilled: boolean }
  | { gone: true; slot: bigint; end: TicketEnd | null };

export async function readTicket(ticket: Address): Promise<ChainView> {
  const [w, slot] = await Promise.all([
    fetchTicket(ticket),
    rpc.getSlot({ commitment: "confirmed" }).send(),
  ]);
  if (!w) return { gone: true, slot, end: await findTicketEnd(ticket) };
  const fulfilled = w.status === TicketStatus.Requested ? await isFulfilled(w.randomness) : false;
  return { gone: false, ticket: w, slot, fulfilled };
}
