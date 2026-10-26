// The beacon's addresses the generated client cannot derive on its own:
// Codama derives a PDA only from an instruction's accounts and arguments,
// and a round's id, a payout table's hash and an ORAO request's seed are
// read from state. The others (`findRoundVrfPda`, `findRoundTicketPda`,
// `findSponsorshipPda`, ...) are the generated ones.
import {
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  type Address,
  type ProgramDerivedAddress,
} from "@solana/kit";
import {
  FADE_PROGRAM_ADDRESS,
  PAYOUT_TABLE_SEED,
  PAYOUT_TABLE_TAG,
  ROUND_SEED,
  type OutcomeArgs,
} from "../generated/fade/index.ts";
import {
  ORAO_NETWORK_STATE_SEED,
  ORAO_REQUEST_SEED,
  ORAO_VRF_PROGRAM_ADDRESS,
} from "./constants.ts";
import { u64 } from "./math.ts";

type ProgramConfig = { programAddress?: Address };

/** `SHA256` of the concatenated parts, through Web Crypto (Node, browsers, Workers). */
export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

function le64(v: bigint): Uint8Array {
  return new Uint8Array(getU64Encoder().encode(u64(v, "value")));
}

/**
 * `["round", id]`: round `id` (ids start at 1). The generated `findRoundPda`
 * (from `sweep_round_vrf`'s `round_id`) derives the same address from
 * `{ roundId }`; this one takes the id itself and refuses 0, and is the one
 * the beacon helpers export.
 */
export async function findRoundPda(
  id: bigint,
  config: ProgramConfig = {},
): Promise<ProgramDerivedAddress> {
  if (id <= 0n) throw new Error("round ids start at 1");
  return getProgramDerivedAddress({
    programAddress: config.programAddress ?? FADE_PROGRAM_ADDRESS,
    seeds: [ROUND_SEED, le64(id)],
  });
}

/**
 * `SHA256("FADE/PAYOUT-TABLE/v1" ‖ len ‖ p₀ ‖ m₀ ‖ … )`, little-endian `u64`s
 * (`beacon::payout_table_preimage`): what the program hashes the outcomes to.
 */
export async function payoutTableHash(outcomes: readonly OutcomeArgs[]): Promise<Uint8Array> {
  if (outcomes.length === 0 || outcomes.length > 32) throw new Error("1 to 32 outcomes");
  const parts: Uint8Array[] = [new Uint8Array(PAYOUT_TABLE_TAG), Uint8Array.of(outcomes.length)];
  for (const o of outcomes) parts.push(le64(BigInt(o.p)), le64(BigInt(o.m)));
  return sha256(...parts);
}

/** `["payout-table", hash]`: where a payout table is registered. */
export async function findPayoutTablePda(
  outcomes: readonly OutcomeArgs[],
  config: ProgramConfig = {},
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: config.programAddress ?? FADE_PROGRAM_ADDRESS,
    seeds: [PAYOUT_TABLE_SEED, await payoutTableHash(outcomes)],
  });
}

/** `["__event_authority"]`, which every `emit_cpi!` instruction takes. */
export async function findEventAuthorityPda(
  config: ProgramConfig = {},
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: config.programAddress ?? FADE_PROGRAM_ADDRESS,
    seeds: [new TextEncoder().encode("__event_authority")],
  });
}

/** ORAO's network state, which holds its fee and treasury. */
export async function findOraoNetworkStatePda(): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: ORAO_VRF_PROGRAM_ADDRESS,
    seeds: [ORAO_NETWORK_STATE_SEED],
  });
}

/** ORAO's request account for `seed`. */
export async function findOraoRequestPda(seed: Uint8Array): Promise<ProgramDerivedAddress> {
  if (seed.length !== 32) throw new Error("an ORAO seed is 32 bytes");
  return getProgramDerivedAddress({
    programAddress: ORAO_VRF_PROGRAM_ADDRESS,
    seeds: [ORAO_REQUEST_SEED, seed],
  });
}

/** The 32 bytes of an address. */
export function addressBytes(a: Address): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(a));
}
