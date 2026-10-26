// Constants of the shared beacon a client needs and the IDL does not carry
// (programs/fade/src/constants.rs, crates/fade-math). Those the IDL does
// carry (seeds, tags, MAX_ROUND_BATCH, MAX_ROUND_K) come from the generated
// client and are not repeated here.
import { address } from "@solana/kit";

/** ORAO VRF, which draws a round's randomness (`ORAO_VRF_ID`). */
export const ORAO_VRF_PROGRAM_ADDRESS = address("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
/** The SlotHashes sysvar a round's seed is read from (`SLOT_HASHES_ID`). */
export const SLOT_HASHES_SYSVAR = address("SysvarS1otHashes111111111111111111111111111");

/** ORAO's network state seed (`orao_layout::NETWORK_STATE_SEED`). */
export const ORAO_NETWORK_STATE_SEED = new TextEncoder().encode("orao-vrf-network-configuration");
/** ORAO's request seed (`orao_layout::REQUEST_SEED`). */
export const ORAO_REQUEST_SEED = new TextEncoder().encode("orao-vrf-randomness-request");
/** Offsets in ORAO's network state (`orao_layout`). */
export const ORAO_TREASURY_OFFSET = 40;
export const ORAO_REQUEST_FEE_OFFSET = 72;
/** A pending ORAO request's size, whose rent a round's prefund covers (`PENDING_LEN`). */
export const ORAO_PENDING_LEN = 749;
/** Discriminators of ORAO's two request layouts (`orao_layout`). */
export const ORAO_RANDOMNESS_V2_DISCRIMINATOR = new Uint8Array([
  139, 239, 184, 215, 227, 86, 191, 226,
]);
export const ORAO_RANDOMNESS_V1_DISCRIMINATOR = new Uint8Array([
  188, 96, 216, 248, 93, 94, 49, 112,
]);

/** Probabilities are out of `P_SCALE`, multipliers in basis points of `BPS`. */
export const P_SCALE = 1_000_000_000n;
export const BPS = 10_000n;
/** `USAGE_SCALE`: a ticket's capacity usage at its whole cap. */
export const USAGE_SCALE = 1_000_000_000n;
/** `h`, in bps: the share of its paid capacity an unpaid round keeps free (`UNPAID_HEADROOM_BPS`). */
export const UNPAID_HEADROOM_BPS = 1_000n;
/** Hashes drawn at most per outcome (`OUTCOME_ROUNDS`). */
export const OUTCOME_ROUNDS = 8;
/** A round's draw may be requested from `close_slot + REQUEST_DELAY_SLOTS`. */
export const REQUEST_DELAY_SLOTS = 2n;
/** Accounts of one settlement group before its optional beneficiary (`ROUND_GROUP_ACCOUNTS`). */
export const ROUND_GROUP_ACCOUNTS = 4;
