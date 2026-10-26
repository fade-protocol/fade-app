//! Fade — a permissionless payout protocol for Solana.
//!
//! Any program, server or wallet can open a ticket with a verifiable payout table
//! against a shared USDC vault; anyone can fund the vault by depositing. The
//! arithmetic lives in `fade-math`; this crate owns the accounts, the
//! authorisation and the token movements. The account map and what each
//! instruction writes are Spec 08's.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use constants::*;
use instructions::*;
pub use state::*;

// Mainnet address. The devnet build runs at its own address, whose keypair
// is keys/devnet-fade-program.json.
#[cfg(not(feature = "devnet"))]
declare_id!("HeuXg1Fn2R7TzzATextZjwySFq1m4YBgUdvXqbQuojsL");
#[cfg(feature = "devnet")]
declare_id!("GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt");

#[program]
pub mod fade {
    use super::*;

    // --- governance --------------------------------------------------------------

    /// One-time setup by the program's upgrade authority; seeds the strike fund.
    /// The beacon starts paused (`PAUSE_ROUNDS`): the council turns it on.
    pub fn initialize(
        ctx: Context<Initialize>,
        council: Pubkey,
        guardian: Pubkey,
        params: RiskParams,
    ) -> Result<()> {
        instructions::initialize::initialize_handler(ctx, council, guardian, params)
    }

    /// Council only. Applies at once if every change tightens, otherwise queues
    /// it behind the longest delay of the fields it loosens.
    pub fn set_params(ctx: Context<SetParams>, params: RiskParams) -> Result<()> {
        instructions::governance::set_params(ctx, params)
    }

    /// Anyone, once the pending change is due.
    pub fn apply_params(ctx: Context<ApplyParams>) -> Result<()> {
        instructions::governance::apply_params(ctx)
    }

    /// Council only.
    pub fn cancel_params(ctx: Context<CancelParams>) -> Result<()> {
        instructions::governance::cancel_params(ctx)
    }

    /// The guardian may only set flags; the council may also clear them.
    pub fn set_pause_flags(
        ctx: Context<SetPauseFlags>,
        pause_flags: u8,
        integrator_paused: Option<bool>,
    ) -> Result<()> {
        instructions::governance::set_pause_flags(ctx, pause_flags, integrator_paused)
    }

    /// Council only: the share mint's name, symbol and logo in wallets
    /// (Token Metadata). Creates the metadata on the first call, rewrites it after.
    pub fn set_share_metadata(
        ctx: Context<SetShareMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        instructions::governance::set_share_metadata(ctx, name, symbol, uri)
    }

    /// Devnet only, signed by the program's upgrade authority: reallocates a
    /// version-1 `Config` to version 2 with the beacon parameters, so the devnet
    /// deployment keeps its vault, integrators and liquidity providers
    /// (Spec 08 §13.5.13). A mainnet build cannot carry it. Adds
    /// `PAUSE_ROUNDS` to the pause flags, as `initialize` starts with it.
    /// The six arguments are the beacon parameters in `RiskParams` order:
    /// plain integers, so the IDL of a build without the instruction names no
    /// type of its own.
    #[cfg(feature = "devnet")]
    pub fn migrate_config(
        ctx: Context<MigrateConfig>,
        beacon_min_price: u64,
        beacon_threshold: u64,
        round_k: u64,
        tick_slots: u64,
        refund_slots: u64,
        crank_round_settle_lamports: u64,
    ) -> Result<()> {
        instructions::migrate::migrate_config(
            ctx,
            instructions::migrate::BeaconParams {
                beacon_min_price,
                beacon_threshold,
                round_k,
                tick_slots,
                refund_slots,
                crank_round_settle_lamports,
            },
        )
    }

    // --- integrators ---------------------------------------------------------------

    /// Signed by the integrator's authority: the only way to move its share account.
    pub fn set_share_account(ctx: Context<SetShareAccount>) -> Result<()> {
        instructions::integrator::set_share_account(ctx)
    }

    // --- tickets ----------------------------------------------------------------------

    /// Signed by the integrator — a program over CPI with its `["fade-integrator"]`
    /// PDA, or a server or wallet — and by the funder.
    pub fn open_ticket(
        ctx: Context<OpenTicket>,
        price: u64,
        payout_table: Vec<Outcome>,
        app_share_bps: u64,
        nonce: u64,
    ) -> Result<()> {
        instructions::open_ticket::open_ticket_handler(
            ctx,
            price,
            payout_table,
            app_share_bps,
            nonce,
        )
    }

    /// Anyone, from two slots after the open until `T_SETTLE`; after it, only
    /// a request someone created through ORAO at the ticket's seed and ORAO
    /// fulfilled with a non-zero value, bound without funding anything.
    pub fn request_randomness(ctx: Context<RequestRandomness>) -> Result<()> {
        instructions::request_randomness::request_randomness_handler(ctx)
    }

    /// Anyone, once ORAO has fulfilled; no deadline.
    pub fn settle_ticket(ctx: Context<SettleTicket>) -> Result<()> {
        instructions::settle::settle_ticket(ctx)
    }

    /// Anyone, after `T_SETTLE`, if the randomness never arrived: forfeiture.
    /// Refused while a request at the ticket's seed is fulfilled, bound or
    /// not; a ticket never requested needs its seed recorded first.
    pub fn expire_ticket(ctx: Context<ExpireTicket>) -> Result<()> {
        instructions::settle::expire_ticket(ctx)
    }

    /// Anyone: delivers a payout parked at settlement or at a refund.
    pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
        instructions::settle::claim_payout(ctx)
    }

    /// Anyone, never paused, unpaid: records an Open ticket's seed and
    /// entropy slot while SlotHashes proves them (from two slots after its
    /// open, for about 512 slots), so that finding its ORAO request never
    /// depends on the sysvar again. Succeeds without writing on a ticket
    /// already recorded.
    pub fn record_ticket_entropy(ctx: Context<RecordTicketEntropy>) -> Result<()> {
        instructions::request_randomness::record_ticket_entropy(ctx)
    }

    /// Anyone, never paused, paid the settler's share, after `T_SETTLE`: an
    /// Open ticket whose seed was never recorded and whose entropy slot
    /// SlotHashes no longer proves gets its vault credit back, since whether
    /// its request exists, fulfilled, can no longer be checked.
    pub fn refund_expired_ticket(ctx: Context<RefundExpiredTicket>) -> Result<()> {
        instructions::settle::refund_expired_ticket(ctx)
    }

    /// Anyone, never paused, unpaid: the lamports on a closed direct ticket's
    /// `vrf_payer` (ORAO's refund for a request fulfilled after the ticket
    /// expired, or a transfer), to the caller. Nothing to sweep succeeds
    /// without moving anything.
    pub fn sweep_ticket_vrf(ctx: Context<SweepTicketVrf>, nonce: u64) -> Result<()> {
        instructions::settle::sweep_ticket_vrf(ctx, nonce)
    }

    // --- shared beacon ---------------------------------------------------------------

    /// Anyone, never paused: stores a valid payout table at the address of its
    /// hash. Succeeds without writing if it is stored already.
    pub fn register_payout_table(
        ctx: Context<RegisterPayoutTable>,
        outcomes: Vec<Outcome>,
    ) -> Result<()> {
        instructions::payout_table::register_payout_table(ctx, outcomes)
    }

    /// Signed by the integrator and the funder, as `open_ticket`: a beacon
    /// ticket admitted on entry into the round accepting tickets, or into the
    /// next round, which the join then creates. `sponsorship` lamports from
    /// the payer go to the round's draw with it; 0 for none.
    pub fn join_round(
        ctx: Context<JoinRound>,
        price: u64,
        app_share_bps: u64,
        nonce: u64,
        sponsorship: u64,
    ) -> Result<()> {
        instructions::join_round::join_round_handler(ctx, price, app_share_bps, nonce, sponsorship)
    }

    /// Anyone, never paused: `lamports` to a round's draw, until its request.
    /// Returned pro rata after a draw or a forfeiture, in full after a refund.
    pub fn sponsor_round(ctx: Context<SponsorRound>, lamports: u64) -> Result<()> {
        instructions::sponsorship::sponsor_round(ctx, lamports)
    }

    /// Anyone, never paused, paid the round's request share: one ORAO request
    /// for every ticket of a paid round, from two slots after its close until
    /// `T_SETTLE`. The round's tickets are already in the epoch counters,
    /// recorded when it became paid.
    pub fn request_round_draw(ctx: Context<RequestRoundDraw>) -> Result<()> {
        instructions::request_round_draw::request_round_draw_handler(ctx)
    }

    /// Anyone, never paused, unpaid: records a paid round's seed and entropy
    /// slot while SlotHashes proves them (from two slots after its close, for
    /// about 512 slots), so that finding its ORAO request never depends on
    /// the sysvar again. Succeeds without writing on a round already recorded.
    pub fn record_round_entropy(ctx: Context<RecordRoundEntropy>) -> Result<()> {
        instructions::request_round_draw::record_round_entropy(ctx)
    }

    /// Anyone, never paused, once the round's randomness is fulfilled; no
    /// deadline. Settles `count` of its tickets, named in remaining accounts
    /// by groups of `ticket`, `integrator`, `payer`, `payout_table`, then
    /// `beneficiary` exactly when bit `i` of `wins` is set; each checked
    /// against the ticket's stored keys. The first settlement of a round
    /// fixes its draw cost. Pays the caller each ticket's settlement share.
    pub fn settle_round_tickets<'info>(
        ctx: Context<'info, SettleRoundTickets<'info>>,
        count: u8,
        wins: u32,
    ) -> Result<()> {
        instructions::settle_round::settle_round_tickets_handler(ctx, count, wins)
    }

    /// Anyone, never paused: delivers a beacon ticket's payout or return
    /// parked in `payout_escrow`, and closes the ticket to its payer.
    pub fn claim_round_payout(ctx: Context<ClaimRoundPayout>) -> Result<()> {
        instructions::settle_round::claim_round_payout_handler(ctx)
    }

    /// A participant of the round (its ticket's payer, funder or integrator),
    /// or anyone when the round's draw no longer fits its prefund at ORAO's
    /// live fee, never paused, once the round has taken no join for
    /// `refund_slots`, while its draw is unpaid: the round leaves the vault's
    /// books in one step and takes no more joins; each ticket then gets back
    /// exactly what it put in through `return_round_ticket`.
    pub fn refund_round(ctx: Context<RefundRound>) -> Result<()> {
        instructions::round_end::refund_round(ctx)
    }

    /// Anyone, never paused, once `T_SETTLE` has passed since the close of a
    /// paid round whose draw was never requested, or never fulfilled: the
    /// round forfeits as a whole and leaves the epoch counters. Its tickets'
    /// credits stay with the vault; each ticket's payer gets back its prepay
    /// less its charge through `return_round_ticket`. A round never requested
    /// whose entropy was never recorded and is no longer proven by SlotHashes
    /// is refunded instead: whether its request exists, fulfilled, can no
    /// longer be checked.
    pub fn expire_round(ctx: Context<ExpireRound>) -> Result<()> {
        instructions::round_end::expire_round(ctx)
    }

    /// Anyone, never paused, unpaid: the lamports on round `round_id`'s
    /// `round_vrf` after its last drain (ORAO's refund for a request fulfilled
    /// after the round forfeited, or a transfer), into the round while it
    /// exists and is not `Requested`, to the caller once it has closed.
    /// Nothing to sweep succeeds without moving anything.
    pub fn sweep_round_vrf(ctx: Context<SweepRoundVrf>, round_id: u64) -> Result<()> {
        instructions::round_end::sweep_round_vrf(ctx, round_id)
    }

    /// Anyone, never paused: one ticket of a refunded or forfeited round
    /// leaves it, with what it is owed. Pays the caller the ticket's
    /// settlement share for a forfeited ticket, nothing for a refunded one.
    pub fn return_round_ticket(ctx: Context<ReturnRoundTicket>) -> Result<()> {
        instructions::round_end::return_round_ticket(ctx)
    }

    /// Anyone, never paused, once the round is drawn, forfeited or refunded:
    /// the sponsor's return and the record's rent to the sponsor.
    pub fn reclaim_sponsorship(ctx: Context<ReclaimSponsorship>) -> Result<()> {
        instructions::sponsorship::reclaim_sponsorship(ctx)
    }

    /// Anyone, never paused: the protocol's beacon shares to the treasury, or,
    /// with `integrator`, its app shares to its share account; the whole
    /// claimable ledger, which a destination unable to receive keeps.
    pub fn claim_shares(ctx: Context<ClaimShares>) -> Result<()> {
        instructions::claim_shares::claim_shares(ctx)
    }

    // --- liquidity providers -----------------------------------------------------

    pub fn request_deposit(ctx: Context<RequestDeposit>, amount: u64) -> Result<()> {
        instructions::requests::request_deposit(ctx, amount)
    }

    pub fn request_withdraw(ctx: Context<RequestWithdraw>, shares: u64) -> Result<()> {
        instructions::requests::request_withdraw(ctx, shares)
    }

    /// Anyone, once the live epoch has closed and no ticket opened before the
    /// close is still open.
    pub fn strike_epoch(ctx: Context<StrikeEpoch>) -> Result<()> {
        instructions::strike::strike_epoch_handler(ctx)
    }

    /// Anyone: the request's own `CLAIM_FEE` pays whoever claims it.
    pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
        instructions::claims::claim_deposit(ctx)
    }

    pub fn claim_withdraw(ctx: Context<ClaimWithdraw>) -> Result<()> {
        instructions::claims::claim_withdraw(ctx)
    }
}
