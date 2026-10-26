// A round's seed and its tickets' outcomes, computed the way the program
// computes them (Spec 08 §13.4, Spec 02 §6), so that a keeper can request a
// draw at the right ORAO address and tell winners from losers before it
// builds a settlement batch. The program recomputes all of it: a wrong
// prediction is a refused transaction (`MalformedBatch`,
// `WrongRandomnessAccount`), never a wrong payment.
import type { Address } from "@solana/kit";
import { BEACON_OUTCOME_TAG, BEACON_SEED_TAG, type Outcome } from "../generated/fade/index.ts";
import {
  ORAO_RANDOMNESS_V1_DISCRIMINATOR,
  ORAO_RANDOMNESS_V2_DISCRIMINATOR,
  ORAO_REQUEST_FEE_OFFSET,
  ORAO_TREASURY_OFFSET,
  OUTCOME_ROUNDS,
  P_SCALE,
} from "./constants.ts";
import { payout } from "./math.ts";
import { addressBytes, sha256 } from "./pdas.ts";
import { getAddressDecoder, getU64Encoder } from "@solana/kit";

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const le64 = (v: bigint) => new Uint8Array(getU64Encoder().encode(v));

/** An entry of the SlotHashes sysvar. */
export type SlotHash = { slot: bigint; hash: Uint8Array };

function slotHashesLen(data: Uint8Array): number {
  if (data.length < 8) throw new Error("SlotHashes: truncated");
  const n = view(data).getBigUint64(0, true);
  if (n > 512n || data.length < 8 + Number(n) * 40) throw new Error("SlotHashes: malformed");
  return Number(n);
}

function slotHashAt(data: Uint8Array, i: number): SlotHash {
  const off = 8 + i * 40;
  return { slot: view(data).getBigUint64(off, true), hash: data.slice(off + 8, off + 40) };
}

/**
 * The oldest entry whose slot is strictly after `t` (entries are newest
 * first), or null: `slot_hashes::first_after`.
 */
export function firstSlotAfter(data: Uint8Array, t: bigint): SlotHash | null {
  const n = slotHashesLen(data);
  if (n === 0 || slotHashAt(data, 0).slot <= t) return null;
  let lo = 0;
  let hi = n;
  while (lo + 1 < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (slotHashAt(data, mid).slot > t) lo = mid;
    else hi = mid;
  }
  const found = slotHashAt(data, lo);
  return found.slot > t ? found : null;
}

/**
 * `firstSlotAfter(t)` only while the sysvar still proves it is the first
 * slot after `t` (an entry at or before `t` retained, or the entry is
 * `t + 1`): `slot_hashes::first_after_retained`, what the request and the
 * expiry read.
 */
export function firstSlotAfterRetained(data: Uint8Array, t: bigint): SlotHash | null {
  const found = firstSlotAfter(data, t);
  if (!found) return null;
  const oldest = slotHashAt(data, slotHashesLen(data) - 1);
  return oldest.slot <= t || found.slot === t + 1n ? found : null;
}

/**
 * The round's ORAO seed, `SHA256("FADE/BEACON-SEED/v1" ‖ program ‖ round ‖
 * close_slot ‖ s* ‖ h*)`.
 */
export async function roundSeed(
  program: Address,
  round: Address,
  close: bigint,
  entropy: SlotHash,
): Promise<Uint8Array> {
  if (entropy.hash.length !== 32) throw new Error("a slot hash is 32 bytes");
  return sha256(
    new Uint8Array(BEACON_SEED_TAG),
    addressBytes(program),
    addressBytes(round),
    le64(close),
    le64(entropy.slot),
    entropy.hash,
  );
}

/** `SHA256("FADE/BEACON-OUTCOME/v1" ‖ program ‖ round ‖ ticket ‖ R ‖ i)`. */
export async function outcomeHash(
  program: Address,
  round: Address,
  ticket: Address,
  randomness: Uint8Array,
  i: number,
): Promise<Uint8Array> {
  if (randomness.length !== 64) throw new Error("ORAO randomness is 64 bytes");
  return sha256(
    new Uint8Array(BEACON_OUTCOME_TAG),
    addressBytes(program),
    addressBytes(round),
    addressBytes(ticket),
    randomness,
    Uint8Array.of(i),
  );
}

const LIMIT = (1n << 128n) - 1n - (((1n << 128n) - 1n) % P_SCALE);

function reduceWord(bytes: Uint8Array): bigint | null {
  let w = 0n;
  for (let i = 15; i >= 0; i--) w = (w << 8n) | BigInt(bytes[i] ?? 0);
  return w >= LIMIT ? null : w % P_SCALE;
}

/** `select::draw` over the outcome hashes: a value in `[0, P_SCALE)`, or null. */
export async function drawValue(
  program: Address,
  round: Address,
  ticket: Address,
  randomness: Uint8Array,
): Promise<bigint | null> {
  for (let i = 0; i < OUTCOME_ROUNDS; i++) {
    const h = await outcomeHash(program, round, ticket, randomness, i);
    const lo = reduceWord(h.subarray(0, 16));
    if (lo !== null) return lo;
    const hi = reduceWord(h.subarray(16, 32));
    if (hi !== null) return hi;
  }
  return null;
}

/** A ticket's outcome index and payout on `outcomes`, as settlement computes them. */
export async function ticketOutcome(
  program: Address,
  round: Address,
  ticket: Address,
  randomness: Uint8Array,
  outcomes: readonly Outcome[],
  price: bigint,
): Promise<{ index: number; payout: bigint }> {
  const r = await drawValue(program, round, ticket, randomness);
  if (r === null) throw new Error("every drawn word rejected");
  let cum = 0n;
  for (const [index, o] of outcomes.entries()) {
    cum += o.p;
    if (r < cum) return { index, payout: payout(price, o.m) };
  }
  throw new Error("the payout table does not sum to P_SCALE");
}

/** ORAO's network state: its treasury and its fee per request. */
export function oraoNetworkState(data: Uint8Array): { treasury: Address; fee: bigint } {
  if (data.length < ORAO_REQUEST_FEE_OFFSET + 8) throw new Error("ORAO network state: truncated");
  return {
    treasury: getAddressDecoder().decode(
      data.subarray(ORAO_TREASURY_OFFSET, ORAO_TREASURY_OFFSET + 32),
    ),
    fee: view(data).getBigUint64(ORAO_REQUEST_FEE_OFFSET, true),
  };
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The client of a pending `RandomnessV2` request (`orao_layout::pending_v2_client`): whoever
 * paid its rent, which ORAO refunds to that address when it fulfils it. Null for any other
 * account, a legacy one included: a legacy account never shrinks, so nothing is refunded there.
 */
export function oraoPendingV2Client(data: Uint8Array): Address | null {
  if (!same(data.subarray(0, 8), ORAO_RANDOMNESS_V2_DISCRIMINATOR) || data[8] !== 0) return null;
  if (data.length < 41) return null;
  return getAddressDecoder().decode(data.subarray(9, 41));
}

/**
 * An ORAO request account of either kind (`orao_layout::randomness`):
 * pending, fulfilled with its seed and randomness, or null if it does not
 * parse.
 */
export function oraoRandomness(
  data: Uint8Array,
): { fulfilled: false } | { fulfilled: true; seed: Uint8Array; randomness: Uint8Array } | null {
  const disc = data.subarray(0, 8);
  if (same(disc, ORAO_RANDOMNESS_V2_DISCRIMINATOR)) {
    if (data[8] === 0) return { fulfilled: false };
    if (data[8] !== 1 || data.length < 137) return null;
    return { fulfilled: true, seed: data.slice(41, 73), randomness: data.slice(73, 137) };
  }
  if (same(disc, ORAO_RANDOMNESS_V1_DISCRIMINATOR) && data.length >= 104) {
    const randomness = data.slice(40, 104);
    if (randomness.every((b) => b === 0)) return { fulfilled: false };
    return { fulfilled: true, seed: data.slice(8, 40), randomness };
  }
  return null;
}
