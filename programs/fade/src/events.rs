//! Events. `version` is always the first field: Anchor's discriminator hashes
//! the event name only, so the version byte is the only in-band way to tell
//! schema versions apart. Every emit site sets it from `EVENT_VERSION`.
//! Schemas are locked in events.lock.json (scripts/check-event-schemas.mjs).

use anchor_lang::prelude::*;

#[event]
pub struct Initialized {
    pub version: u8,
    pub council: Pubkey,
    pub guardian: Pubkey,
    pub protocol_treasury: Pubkey,
}

/// `set_params` applied a change at once (`effective_at` = now) or queued it.
#[event]
pub struct ParamsChanged {
    pub version: u8,
    pub applied: bool,
    pub effective_at: i64,
}

#[event]
pub struct ParamsApplied {
    pub version: u8,
    pub effective_at: i64,
}

#[event]
pub struct ParamsCancelled {
    pub version: u8,
    pub effective_at: i64,
}

#[event]
pub struct PauseFlagsChanged {
    pub version: u8,
    pub by: Pubkey,
    pub pause_flags: u8,
    /// The integrator whose pause changed, or the default key.
    pub integrator: Pubkey,
    pub integrator_paused: bool,
}

/// `set_share_metadata` created the share mint's Token Metadata account, or
/// rewrote it (`created` false).
#[event]
pub struct ShareMetadataSet {
    pub version: u8,
    pub created: bool,
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

#[event]
pub struct IntegratorCreated {
    pub version: u8,
    pub integrator: Pubkey,
    pub authority: Pubkey,
    pub share_account: Pubkey,
}

#[event]
pub struct ShareAccountChanged {
    pub version: u8,
    pub integrator: Pubkey,
    pub share_account: Pubkey,
}

#[event]
pub struct TicketOpened {
    pub version: u8,
    pub ticket: Pubkey,
    pub integrator: Pubkey,
    pub nonce: u64,
    pub beneficiary: Pubkey,
    pub price: u64,
    pub vault_credit: u64,
    pub payout_max: u64,
    pub reserved_liability: u64,
    pub cap: u64,
    pub margin_bps: u64,
    pub app_share_bps: u64,
    pub open_slot: u64,
}

#[event]
pub struct RandomnessRequested {
    pub version: u8,
    pub ticket: Pubkey,
    pub request: Pubkey,
    pub seed: [u8; 32],
    pub entropy_slot: u64,
}

#[event]
pub struct TicketSettled {
    pub version: u8,
    pub ticket: Pubkey,
    pub integrator: Pubkey,
    pub outcome: u8,
    pub payout: u64,
    /// The payout went to `payout_escrow`: the beneficiary could not receive it.
    pub pending: bool,
}

#[event]
pub struct TicketExpired {
    pub version: u8,
    pub ticket: Pubkey,
    pub integrator: Pubkey,
    pub forfeited: u64,
}

#[event]
pub struct PayoutClaimed {
    pub version: u8,
    pub ticket: Pubkey,
    pub beneficiary: Pubkey,
    pub payout: u64,
}

#[event]
pub struct DepositRequested {
    pub version: u8,
    pub owner: Pubkey,
    pub epoch_id: u64,
    pub amount: u64,
}

#[event]
pub struct WithdrawRequested {
    pub version: u8,
    pub owner: Pubkey,
    pub epoch_id: u64,
    pub shares: u64,
}

#[event]
pub struct EpochStruck {
    pub version: u8,
    pub epoch_id: u64,
    pub total_assets: u64,
    pub total_shares: u64,
    pub deposits: u64,
    pub shares_minted: u64,
    pub withdraw_shares: u64,
    pub assets_owed: u64,
    pub assets_paid: u64,
    pub shares_burnt: u64,
    pub reward: u64,
}

#[event]
pub struct DepositClaimed {
    pub version: u8,
    pub owner: Pubkey,
    pub epoch_id: u64,
    pub shares: u64,
    /// The shares reached the owner; otherwise they are parked on the request.
    pub delivered: bool,
}

#[event]
pub struct WithdrawClaimed {
    pub version: u8,
    pub owner: Pubkey,
    pub epoch_id: u64,
    /// The record the claim read the chain at.
    pub at_epoch_id: u64,
    pub assets: u64,
    /// The request is fully served and closed.
    pub closed: bool,
    /// What was owed reached the owner; otherwise it is parked on the request.
    pub delivered: bool,
}

/// A parked claim handed over once the owner's account could receive.
#[event]
pub struct ClaimDelivered {
    pub version: u8,
    pub owner: Pubkey,
    pub epoch_id: u64,
    /// A deposit request (shares) or a withdrawal request (USDC).
    pub deposit: bool,
    pub amount: u64,
}
