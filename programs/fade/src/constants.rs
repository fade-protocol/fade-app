//! PDA seeds and pinned addresses (Spec 08 §2). Seeds are `#[constant]` so they
//! land in the IDL and the generated clients derive the same addresses.

use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
/// The ticket side's state.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
/// The liquidity-provider side's state; its lamports above rent are the strike fund.
#[constant]
pub const QUEUE_SEED: &[u8] = b"queue";
/// Signs for every token account the vault owns. No data.
#[constant]
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault-authority";
/// The vault's USDC: backs every open ticket.
#[constant]
pub const USDC_VAULT_SEED: &[u8] = b"usdc-vault";
/// Payouts to a beneficiary that could not receive them at settlement.
#[constant]
pub const PAYOUT_ESCROW_SEED: &[u8] = b"payout-escrow";
/// Deposits queued for a strike; not part of the vault's assets yet.
#[constant]
pub const DEPOSIT_QUEUE_SEED: &[u8] = b"deposit-queue";
/// Assets struck withdrawals are owed, not yet claimed.
#[constant]
pub const PAYABLE_SEED: &[u8] = b"payable";
#[constant]
pub const SHARE_MINT_SEED: &[u8] = b"shares";
#[constant]
pub const SHARE_ESCROW_SEED: &[u8] = b"share-escrow";
#[constant]
pub const SHARE_CLAIMS_SEED: &[u8] = b"share-claims";
/// `["epoch", epoch_id]`.
#[constant]
pub const EPOCH_SEED: &[u8] = b"epoch";
/// `["deposit", epoch_id, owner]`.
#[constant]
pub const DEPOSIT_SEED: &[u8] = b"deposit";
/// `["withdraw", epoch_id, owner]`.
#[constant]
pub const WITHDRAW_SEED: &[u8] = b"withdraw";
/// `["integrator", authority]`: keyed on the address that signs `open_ticket`.
#[constant]
pub const INTEGRATOR_SEED: &[u8] = b"integrator";
/// The seed a program integrator derives its signing PDA with, under its own
/// program id: `["fade-integrator"]`. Only that program can sign for it.
#[constant]
pub const INTEGRATOR_AUTHORITY_SEED: &[u8] = b"fade-integrator";
/// `["ticket", integrator, nonce]`.
#[constant]
pub const TICKET_SEED: &[u8] = b"ticket";
/// `["vrf-payer", ticket]`: the system-owned PDA that pays ORAO.
#[constant]
pub const VRF_PAYER_SEED: &[u8] = b"vrf-payer";

// --- shared beacon (Spec 08 §13.2) ---------------------------------------------
/// `["payout-table", hash]`: a payout table stored once, referenced by beacon tickets.
#[constant]
pub const PAYOUT_TABLE_SEED: &[u8] = b"payout-table";
/// `["round", round_id]`, `round_id` little-endian `u64`.
#[constant]
pub const ROUND_SEED: &[u8] = b"round";
/// `["round-vrf", round]`: the system-owned PDA that pays ORAO for a round's draw.
#[constant]
pub const ROUND_VRF_SEED: &[u8] = b"round-vrf";
/// `["round-ticket", integrator, nonce]`: the nonce is the integrator's
/// `next_nonce`, shared with the direct path.
#[constant]
pub const ROUND_TICKET_SEED: &[u8] = b"round-ticket";
/// `["sponsorship", round, sponsor]`.
#[constant]
pub const SPONSORSHIP_SEED: &[u8] = b"sponsorship";
/// Domain tag of a payout table's hash (Spec 08 §13.2.1); equal to
/// `fade_math::beacon::PAYOUT_TABLE_TAG`.
#[constant]
pub const PAYOUT_TABLE_TAG: &[u8] = b"FADE/PAYOUT-TABLE/v1";
/// Domain tag of a round's ORAO seed; equal to `fade_math::beacon::SEED_TAG`.
#[constant]
pub const BEACON_SEED_TAG: &[u8] = b"FADE/BEACON-SEED/v1";
/// Domain tag of a beacon ticket's outcome; equal to `fade_math::beacon::OUTCOME_TAG`.
#[constant]
pub const BEACON_OUTCOME_TAG: &[u8] = b"FADE/BEACON-OUTCOME/v1";
/// The most per-ticket caps a round may carry (Spec 08 §13.3). A program
/// constant, so that raising `k` takes an upgrade behind the 72-hour
/// timelock rather than a parameter change: Spec 09 §7 ties it to stronger
/// randomness, itself an upgrade.
#[constant]
pub const MAX_ROUND_K: u8 = 1;
/// Most tickets one `settle_round_tickets` may name: one bit of its `wins`
/// mask each (Spec 08 §13.5.7). Transaction size binds well below it.
#[constant]
pub const MAX_ROUND_BATCH: u8 = 32;
/// Accounts of a settlement group before its optional beneficiary: the
/// ticket, its integrator, its payer, its payout table.
pub const ROUND_GROUP_ACCOUNTS: usize = 4;
/// Upper bound of `tick_slots`, about 52 s.
pub const MAX_TICK_SLOTS: u64 = 150;
/// Upper bound of `refund_slots`, about 2 h.
pub const MAX_REFUND_SLOTS: u64 = 20_000;

/// Decimals of the LP share mint.
pub const SHARE_DECIMALS: u8 = 9;
/// Decimals of USDC.
pub const USDC_DECIMALS: u8 = 6;

/// The only mint V1 accepts. Legacy SPL Token; Token-2022 is rejected outright.
#[cfg(not(feature = "devnet"))]
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
/// A Fade-controlled test mint on devnet (keys/devnet-usdc-mint.json).
#[cfg(feature = "devnet")]
pub const USDC_MINT: Pubkey = pubkey!("E4XYMYALrvMX19P6TxqKXe8ZYGxfj2CjMub6c2ZficTv");

/// ORAO VRF, identical on mainnet and devnet. Changed only by an upgrade.
pub const ORAO_VRF_ID: Pubkey = pubkey!("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
pub const SLOT_HASHES_ID: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");
pub const COMPUTE_BUDGET_ID: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
/// Metaplex Token Metadata, identical on mainnet and devnet: where wallets read
/// the share mint's name, symbol and logo.
pub const TOKEN_METADATA_ID: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
/// `["metadata", TOKEN_METADATA_ID, mint]` under Token Metadata.
pub const METADATA_SEED: &[u8] = b"metadata";

/// Domain tags of the two hashes of Technical Specification §3.6.
pub const ORAO_SEED_TAG: &[u8] = b"FADE/ORAO-SEED/v1";
pub const OUTCOME_TAG: &[u8] = b"FADE/OUTCOME/v1";
/// Attempts of the outcome hash before giving up: each carries two words, and a
/// word is rejected with probability ~3e-30.
pub const OUTCOME_ROUNDS: u8 = 8;
/// The earliest slot after the open at which randomness may be requested: the
/// first slot after the open must be final in SlotHashes.
pub const REQUEST_MIN_DELAY_SLOTS: u64 = 2;
/// The shortest `T_SETTLE` governance may set: a window of several slots
/// after the earliest request, so that randomness can always be requested.
pub const MIN_T_SETTLE_SLOTS: u64 = REQUEST_MIN_DELAY_SLOTS + 8;
/// The lowest κ governance may set, in bps (Spec 01 §4.3, Spec 04 invariant 7).
/// The strike keeps `max(committed, ceil(reserved / κ))` in the vault, so with
/// κ at or above 0.8 its κ term holds back at most 1.25 times the reserved
/// liability, whatever the council sets.
pub const MIN_KAPPA_BPS: u64 = 8_000;

/// Parameter-change delays (Spec 05 §3).
pub const DELAY_24H: i64 = 24 * 3_600;
pub const DELAY_72H: i64 = 72 * 3_600;
pub const DELAY_7D: i64 = 7 * 24 * 3_600;
/// The longest `epoch_length_seconds` governance may set: a quarter of the
/// shortest loosening delay. Lengthening the epoch applies at once (Spec 05
/// §3), so this bound, not a delay, is what keeps every loosening's notice
/// usable: an epoch closes at most one epoch length after the request it
/// opens on, so a withdrawal requested within 18 hours of a 24-hour
/// loosening being queued lands in an epoch that closes before the change
/// can apply, at whatever time of day the council queues it. The strike
/// follows once the tickets opened before that close are settled or
/// expired, so the margin left for them is the close's distance to
/// `effective_at`: 6 hours for a request at the queueing, as little as a
/// second at the 18th hour (Spec 05 §3).
pub const MAX_EPOCH_LENGTH_SECONDS: u64 = (DELAY_24H / 4) as u64;
/// How long caps stay halved after the drawdown condition was last seen: the
/// peak leaves the 24-hour window within a day, new tickets resume then, and the
/// caps stay halved through the clean day that follows (Spec 04 §7.3).
pub const DRAWDOWN_AFTERMATH_SECONDS: i64 = 48 * 3_600;

/// Current layout version of every account but `Config`, stored as its first field.
pub const ACCOUNT_VERSION: u8 = 1;
/// Current layout version of `Config`: 2 since the beacon parameters were
/// appended to `RiskParams` (Spec 08 §13.2.6).
pub const CONFIG_VERSION: u8 = 2;
/// Current schema version of every event, stored as its first field, but
/// those whose schema has moved and carry their own constant below.
pub const EVENT_VERSION: u8 = 1;
/// Schema version of `TicketExpired`: 2 since the expiry's request findings,
/// the refund and `Vault.ticket_forfeits_withheld` were appended.
pub const TICKET_EXPIRED_VERSION: u8 = 2;
/// `Ticket.outcome` of a refund parked in `payout_escrow`: no payout table
/// holds this index (32 outcomes at most), so a `PayoutPending` ticket
/// carrying it is a refunded credit waiting for `claim_payout`, never a
/// settlement. `u8::MAX`, written out so that the IDL and the generated
/// clients carry the value.
#[constant]
pub const REFUND_OUTCOME: u8 = 255;
