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

/// Parameter-change delays (Spec 05 §3).
pub const DELAY_24H: i64 = 24 * 3_600;
pub const DELAY_72H: i64 = 72 * 3_600;
pub const DELAY_7D: i64 = 7 * 24 * 3_600;
/// How long caps stay halved after the drawdown condition was last seen: the
/// peak leaves the 24-hour window within a day, new tickets resume then, and the
/// caps stay halved through the clean day that follows (Spec 04 §7.3).
pub const DRAWDOWN_AFTERMATH_SECONDS: i64 = 48 * 3_600;

/// Current layout version of every account, stored as its first field.
pub const ACCOUNT_VERSION: u8 = 1;
/// Current schema version of every event, stored as its first field.
pub const EVENT_VERSION: u8 = 1;
