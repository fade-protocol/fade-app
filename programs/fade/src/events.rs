//! Events. `version` is always the first field: Anchor's discriminator hashes
//! the event name only, so the version byte is the only in-band way to tell
//! schema versions apart. Every emit site sets it from `EVENT_VERSION`, or
//! from the event's own constant once its schema has moved
//! (`TICKET_EXPIRED_VERSION`); a schema only ever grows at its end.
//! Schemas are locked in events.lock.json (scripts/check-event-schemas.mjs).

use anchor_lang::prelude::*;

use crate::state::Outcome;

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

/// A direct ticket's expiry: forfeited by `expire_ticket`, or refunded by
/// `refund_expired_ticket`. Version 2 (`TICKET_EXPIRED_VERSION`); a version-1
/// body ends after `forfeited`.
#[event]
pub struct TicketExpired {
    pub version: u8,
    pub ticket: Pubkey,
    pub integrator: Pubkey,
    /// The vault credit forfeited to the vault; 0 for a refund.
    pub forfeited: u64,
    /// The ticket's randomness was requested: its bound request was pending or
    /// fulfilled with zero.
    pub requested: bool,
    /// An ORAO request exists at the ticket's seed: bound when `requested`,
    /// created through ORAO by someone and never bound otherwise (pending or
    /// fulfilled with zero).
    pub request_found: bool,
    /// The program could look for that request: always for a forfeiture,
    /// never for a refund. The alarm reads a keeper's failure only from
    /// `checked && !request_found`.
    pub checked: bool,
    /// The bound request was still pending and `vrf_payer` paid its rent, so
    /// ORAO's rent refund reaches `vrf_payer` when it fulfils it, after the
    /// ticket's close, and `sweep_ticket_vrf` moves it then. False for a
    /// request someone else created and the ticket bound: ORAO refunds its
    /// creator.
    pub pending: bool,
    /// The ticket was refunded, not forfeited: never requested, its seed never
    /// recorded, and SlotHashes no longer proving it.
    pub refunded: bool,
    /// The vault credit returned to the beneficiary (or parked in
    /// `payout_escrow`); 0 unless `refunded`.
    pub refund: u64,
    /// The refund waits in `payout_escrow` for `claim_payout`: the beneficiary
    /// could not receive it. The ticket stays, `PayoutPending` with `outcome`
    /// `REFUND_OUTCOME`.
    pub parked: bool,
    /// `Vault.ticket_forfeits_withheld` after this expiry: when it counts as
    /// one a withheld draw may explain (all but `!requested && checked &&
    /// !request_found`), its ordinal in that count.
    pub ticket_forfeits_withheld: u64,
}

/// An Open direct ticket's seed and entropy slot, recorded while SlotHashes
/// proved `s*`: its ORAO request address no longer depends on the sysvar.
#[event]
pub struct TicketEntropyRecorded {
    pub version: u8,
    pub ticket: Pubkey,
    pub seed: [u8; 32],
    pub entropy_slot: u64,
    pub entropy_hash: [u8; 32],
}

/// Lamports that reached a closed direct ticket's `vrf_payer` (ORAO's rent
/// refund for a request fulfilled after the ticket expired, or a transfer),
/// swept to the caller.
#[event]
pub struct TicketVrfSwept {
    pub version: u8,
    /// The ticket's address; the ticket no longer exists.
    pub ticket: Pubkey,
    pub integrator: Pubkey,
    pub nonce: u64,
    pub to: Pubkey,
    pub lamports: u64,
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

// --- shared beacon (Spec 08 §13.6) ---------------------------------------------------
// `round` is always the `Round` account's address; `RoundOpened` carries its id.

/// `register_payout_table` created a payout table; a re-registration emits nothing.
#[event]
pub struct PayoutTableRegistered {
    pub version: u8,
    pub payout_table: Pubkey,
    pub hash: [u8; 32],
    pub len: u8,
    pub lhs: u128,
    pub max_m: u64,
    /// The `len` outcomes `hash` commits to, so the table is known from the events alone.
    pub outcomes: Vec<Outcome>,
}

/// A join created a round; the round's snapshot (Spec 09 §3).
#[event]
pub struct RoundOpened {
    pub version: u8,
    pub round: Pubkey,
    pub id: u64,
    pub rent_payer: Pubkey,
    pub threshold: u64,
    pub draw_max: u64,
    pub round_k: u8,
    pub min_price: u64,
    pub settle_share: u64,
    pub tick_slots: u64,
    pub refund_slots: u64,
    pub first_slot: u64,
    pub request_share: u64,
    pub t_settle_slots: u64,
    pub drawdown_bps: u64,
}

#[event]
pub struct TicketJoined {
    pub version: u8,
    pub ticket: Pubkey,
    pub round: Pubkey,
    pub integrator: Pubkey,
    pub nonce: u64,
    pub beneficiary: Pubkey,
    pub refund_to: Pubkey,
    pub payout_table: Pubkey,
    pub price: u64,
    pub vault_credit: u64,
    pub payout_max: u64,
    pub reserved_liability: u64,
    /// The per-ticket cap admission applied, and the capacity usage against it.
    pub cap: u64,
    pub usage: u64,
    pub protocol_share: u64,
    pub app_share: u64,
    pub prepay: u64,
    pub slot: u64,
    pub payer: Pubkey,
    pub funder: Pubkey,
    pub settle_share: u64,
}

#[event]
pub struct RoundSponsored {
    pub version: u8,
    pub round: Pubkey,
    pub sponsor: Pubkey,
    pub lamports: u64,
    /// The round's sponsorship after this one.
    pub total: u64,
}

#[event]
pub struct RoundPaid {
    pub version: u8,
    pub round: Pubkey,
    pub paid_slot: u64,
    pub close_slot: u64,
    pub prices: u64,
    pub sponsorship: u64,
}

#[event]
pub struct RoundRefunded {
    pub version: u8,
    pub round: Pubkey,
    pub by: Pubkey,
    pub tickets: u32,
    pub prices: u64,
    pub sponsorship: u64,
}

#[event]
pub struct RoundDrawRequested {
    pub version: u8,
    pub round: Pubkey,
    pub request: Pubkey,
    pub seed: [u8; 32],
    pub entropy_slot: u64,
    /// `h*`; zero when the round's entropy was recorded before the request and
    /// SlotHashes no longer holds `s*` (a late binding): `RoundEntropyRecorded`
    /// carries it then.
    pub entropy_hash: [u8; 32],
    pub funded: u64,
    /// The epoch counter the round's tickets joined when it became paid, and
    /// its generation; the request does not change them.
    pub side: u8,
    pub generation: u32,
}

/// A paid round's seed and entropy slot, recorded while SlotHashes proved `s*`:
/// its ORAO request address no longer depends on the sysvar.
#[event]
pub struct RoundEntropyRecorded {
    pub version: u8,
    pub round: Pubkey,
    pub seed: [u8; 32],
    pub entropy_slot: u64,
    pub entropy_hash: [u8; 32],
}

/// The first settlement of a round read its randomness and fixed its draw cost.
#[event]
pub struct RoundDrawn {
    pub version: u8,
    pub round: Pubkey,
    pub draw_cost: u64,
    /// Lamports drained back from `round_vrf`.
    pub refund: u64,
}

#[event]
pub struct RoundTicketSettled {
    pub version: u8,
    pub ticket: Pubkey,
    pub round: Pubkey,
    pub integrator: Pubkey,
    pub outcome: u8,
    pub payout: u64,
    /// The ticket's share of the draw, lamports.
    pub charge: u64,
    /// The payout went to `payout_escrow`: the beneficiary could not receive it.
    pub pending: bool,
}

/// `requested` tells a keeper's failure (false) from a withheld draw (true).
#[event]
pub struct RoundExpired {
    pub version: u8,
    pub round: Pubkey,
    pub requested: bool,
    /// An ORAO request exists for the round's seed: bound when `requested`, created
    /// through ORAO by someone and never bound otherwise (pending or fulfilled with zero).
    pub request_found: bool,
    /// The program could look for that request: always when `requested`; for a round
    /// never requested, while SlotHashes still proved its entropy slot. The alarm reads a
    /// keeper's failure only from `checked && !request_found`.
    pub checked: bool,
    pub tickets: u32,
    /// Vault credits forfeited to the vault.
    pub forfeited: u64,
    /// `C` (Spec 08 §13.4), which every forfeited return's charge depends on, and the
    /// lamports drained back from `round_vrf` that fixed it; both 0 when unrequested.
    pub draw_cost: u64,
    pub refund: u64,
    /// The epoch counter the round's tickets left and its generation, recorded when the
    /// round became paid: no other event gives them for a round never requested.
    pub side: u8,
    pub generation: u32,
    /// `Vault.forfeits_withheld` after this expiry: when it counts as one a withheld
    /// draw may explain (all but `!requested && checked && !request_found`), its
    /// ordinal in that count, which the keeper's alarm accounts for one by one.
    pub forfeits_withheld: u64,
    /// The round was refunded, not forfeited: never requested, its entropy never
    /// recorded, and SlotHashes no longer proving it, so that whether its request
    /// exists, fulfilled, can no longer be checked (`checked` false). Every ticket's
    /// price and prepay go back at its return; `forfeited`, `draw_cost` and `refund`
    /// are 0.
    pub refunded: bool,
}

/// Lamports that reached a round's `round_vrf` after its last drain (ORAO's rent
/// refund for a request fulfilled after the round forfeited, or a transfer), swept.
#[event]
pub struct RoundVrfSwept {
    pub version: u8,
    /// The round's address, whether it still exists or not.
    pub round: Pubkey,
    pub round_id: u64,
    /// The round while it exists (its close pays them to `rent_payer`), the caller
    /// once it has closed.
    pub to: Pubkey,
    pub lamports: u64,
    /// The round had closed: `to` is the caller.
    pub closed: bool,
}

#[event]
pub struct RoundTicketReturned {
    pub version: u8,
    pub ticket: Pubkey,
    pub round: Pubkey,
    /// A refunded round (the ticket price returned), or a forfeited one.
    pub refunded: bool,
    pub price: u64,
    /// Lamports returned to the payer.
    pub lamports: u64,
    /// The ticket price went to `payout_escrow`: `refund_to` could not receive it.
    pub parked: bool,
    /// The ticket's share of the draw, lamports: 0 after a refund.
    pub charge: u64,
}

#[event]
pub struct SponsorshipReclaimed {
    pub version: u8,
    pub round: Pubkey,
    pub sponsor: Pubkey,
    pub lamports: u64,
}

#[event]
pub struct RoundClosed {
    pub version: u8,
    pub round: Pubkey,
    pub rent_payer: Pubkey,
    pub lamports: u64,
}

#[event]
pub struct RoundPayoutClaimed {
    pub version: u8,
    pub ticket: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
}

/// `integrator` is the default key for the protocol's shares.
#[event]
pub struct SharesClaimed {
    pub version: u8,
    pub integrator: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
}
