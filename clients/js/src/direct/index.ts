// Hand-written helpers for the direct path, next to the generated client
// (clients/js/src/generated/fade): a ticket's ORAO seed and request address
// as the program finds them (recorded, else proven by SlotHashes), the end a
// ticket past `T_SETTLE` takes, and `TicketExpired` decoded whatever its
// schema version. The program recomputes all of it: a wrong prediction is a
// refused transaction, never a wrong payment.
import {
  getAddressDecoder,
  getStructDecoder,
  getU64Decoder,
  getU8Decoder,
  getU64Encoder,
  type Address,
} from "@solana/kit";
import {
  FADE_PROGRAM_ADDRESS,
  TICKET_EXPIRED_EVENT_DISCRIMINATOR,
  TicketStatus,
  getTicketExpiredEventDecoder,
  type Ticket,
  type TicketExpiredEvent,
} from "../generated/fade/index.ts";
import { ORAO_VRF_PROGRAM_ADDRESS } from "../beacon/constants.ts";
import {
  firstSlotAfter,
  firstSlotAfterRetained,
  oraoPendingV2Client,
  oraoRandomness,
  type SlotHash,
} from "../beacon/entropy.ts";
import { addressBytes, findOraoRequestPda, sha256 } from "../beacon/pdas.ts";
import type { AccountRead, Held } from "../beacon/rounds.ts";

type ProgramConfig = { programAddress?: Address };
const programOf = (c: ProgramConfig) => c.programAddress ?? FADE_PROGRAM_ADDRESS;
const le64 = (v: bigint) => new Uint8Array(getU64Encoder().encode(v));

/** Domain tag of a direct ticket's ORAO seed (`ORAO_SEED_TAG`). */
const ORAO_SEED_TAG = new TextEncoder().encode("FADE/ORAO-SEED/v1");

/**
 * A direct ticket's ORAO seed, `SHA256("FADE/ORAO-SEED/v1" ‖ program ‖
 * ticket ‖ open_slot ‖ s* ‖ h*)` (Technical Specification §3.6).
 */
export async function ticketSeed(
  program: Address,
  ticket: Address,
  openSlot: bigint,
  entropy: SlotHash,
): Promise<Uint8Array> {
  if (entropy.hash.length !== 32) throw new Error("a slot hash is 32 bytes");
  return sha256(
    ORAO_SEED_TAG,
    addressBytes(program),
    addressBytes(ticket),
    le64(openSlot),
    le64(entropy.slot),
    entropy.hash,
  );
}

/**
 * Whether the ticket's seed is recorded (`record_ticket_entropy` or
 * `request_randomness`): `s*` follows the open, so a recorded entropy slot is
 * never 0. Once recorded, its ORAO request address no longer depends on
 * SlotHashes.
 */
export function ticketEntropyRecorded(t: Ticket): boolean {
  return t.entropySlot !== 0n;
}

/**
 * The ticket's seed as the program finds it: the recorded one, whatever
 * SlotHashes holds; otherwise the one SlotHashes proves
 * (`first_after_retained(open_slot)`); null when neither.
 */
export async function ticketSeedOf(
  ticket: Held<Ticket>,
  slotHashes: Uint8Array,
  config: ProgramConfig = {},
): Promise<Uint8Array | null> {
  const t = ticket.data;
  if (ticketEntropyRecorded(t)) return new Uint8Array(t.seed);
  const entropy = firstSlotAfterRetained(slotHashes, t.openSlot);
  if (!entropy) return null;
  return ticketSeed(programOf(config), ticket.address, t.openSlot, entropy);
}

/**
 * The ORAO request an Open ticket's request, late binding or expiry names:
 * ORAO's address for its seed (see `ticketSeedOf`), or null once the seed
 * can no longer be derived (then `refund_expired_ticket` is its end).
 */
export async function ticketRequestAddress(
  ticket: Held<Ticket>,
  slotHashes: Uint8Array,
  config: ProgramConfig = {},
): Promise<{ request: Address; seed: Uint8Array } | null> {
  const seed = await ticketSeedOf(ticket, slotHashes, config);
  if (!seed) return null;
  const [request] = await findOraoRequestPda(seed);
  return { request, seed };
}

/** Whether `read` is an ORAO request fulfilled with a non-zero randomness. */
export function oraoFulfilledNonZero(read: AccountRead | null): boolean {
  if (read === null || read.owner !== ORAO_VRF_PROGRAM_ADDRESS) return false;
  const parsed = oraoRandomness(read.data);
  return parsed !== null && parsed.fulfilled && parsed.randomness.some((b) => b !== 0);
}

/**
 * Whether ORAO still owes `vrfPayer` a rent refund for `read`, the program's `TicketExpired.pending`
 * rule: a pending `RandomnessV2` whose client is the ticket's vrf_payer. A legacy request never
 * refunds, and one someone else paid for refunds its own creator.
 */
export function oraoRefundsTo(read: AccountRead | null, vrfPayer: Address): boolean {
  if (read === null || read.owner !== ORAO_VRF_PROGRAM_ADDRESS) return false;
  return oraoPendingV2Client(read.data) === vrfPayer;
}

/**
 * How an Open ticket past its expiry slot ends, from the account read at its
 * request address (`ticketRequestAddress`; null for none):
 *
 *   bind    a request someone created there, fulfilled with a non-zero
 *           randomness: `request_randomness` binds it late, then
 *           `settle_ticket` pays the draw (an expiry is refused,
 *           `AlreadyFulfilled`);
 *   expire  `record_ticket_entropy` (unless recorded), then `expire_ticket`
 *           naming the derived address: forfeited;
 *   refund  the seed was never recorded and SlotHashes no longer proves it:
 *           `refund_expired_ticket` returns the vault credit.
 */
export type OpenExpiry =
  | { kind: "bind"; request: Address; seed: Uint8Array }
  | { kind: "expire"; request: Address; seed: Uint8Array; record: boolean }
  | { kind: "refund" };

export async function openTicketExpiry(
  ticket: Held<Ticket>,
  slotHashes: Uint8Array,
  request: AccountRead | null,
  config: ProgramConfig = {},
): Promise<OpenExpiry> {
  const t = ticket.data;
  if (t.status !== TicketStatus.Open) throw new Error("only an Open ticket has this choice");
  const found = await ticketRequestAddress(ticket, slotHashes, config);
  if (!found) {
    if (!firstSlotAfter(slotHashes, t.openSlot))
      throw new Error("SlotHashes does not hold the ticket's entropy slot yet");
    return { kind: "refund" };
  }
  if (request !== null && request.address !== found.request)
    throw new Error(`the account read is ${request.address}, the request is ${found.request}`);
  if (oraoFulfilledNonZero(request)) return { kind: "bind", ...found };
  return { kind: "expire", ...found, record: !ticketEntropyRecorded(t) };
}

/** A `TicketExpired` event, whatever its schema version. */
export type TicketExpiredRecord =
  | ({ version: 1 } & Pick<TicketExpiredEvent, "ticket" | "integrator" | "forfeited">)
  | (TicketExpiredEvent & { version: 2 });

/** The version-1 body: the fields before the ones version 2 appended. */
const v1Decoder = () =>
  getStructDecoder([
    ["discriminator", getU64Decoder()],
    ["version", getU8Decoder()],
    ["ticket", getAddressDecoder()],
    ["integrator", getAddressDecoder()],
    ["forfeited", getU64Decoder()],
  ]);

/**
 * Decodes a `TicketExpired` event body (discriminator first), dispatching on
 * the version byte after the discriminator: a version-1 body (programs before
 * the audit fixes of 22 October 2026) ends after `forfeited` and never goes
 * through the version-2 decoder, so that history replays; a version-2 body
 * carries the request findings, the refund and the withheld count. Throws on
 * any other discriminator or version.
 */
export function decodeTicketExpired(body: Uint8Array): TicketExpiredRecord {
  const disc = TICKET_EXPIRED_EVENT_DISCRIMINATOR;
  if (body.length < 9 || disc.some((b, i) => body[i] !== b))
    throw new Error("not a TicketExpired event");
  const version = body[8];
  if (version === 1) {
    const e = v1Decoder().decode(body);
    return { version: 1, ticket: e.ticket, integrator: e.integrator, forfeited: e.forfeited };
  }
  if (version === 2) return { ...getTicketExpiredEventDecoder().decode(body), version: 2 };
  throw new Error(`TicketExpired version ${version} is unknown`);
}

/**
 * Whether an expiry counts as one a withheld draw may explain, the
 * program's `withheld_forfeit`: all but a ticket never requested whose
 * request was looked for and not found (the keepers' failure). Unknown for
 * a version-1 event, which carries no findings.
 */
export function ticketExpiryWithheld(e: TicketExpiredRecord): boolean | null {
  if (e.version === 1) return null;
  return e.requested || e.requestFound || !e.checked;
}
