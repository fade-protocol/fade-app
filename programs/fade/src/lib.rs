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

    /// Anyone, from two slots after the open until `T_SETTLE`.
    pub fn request_randomness(ctx: Context<RequestRandomness>) -> Result<()> {
        instructions::request_randomness::request_randomness_handler(ctx)
    }

    /// Anyone, once ORAO has fulfilled; no deadline.
    pub fn settle_ticket(ctx: Context<SettleTicket>) -> Result<()> {
        instructions::settle::settle_ticket(ctx)
    }

    /// Anyone, after `T_SETTLE`, if the randomness never arrived: forfeiture.
    pub fn expire_ticket(ctx: Context<ExpireTicket>) -> Result<()> {
        instructions::settle::expire_ticket(ctx)
    }

    /// Anyone: delivers a payout parked at settlement.
    pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
        instructions::settle::claim_payout(ctx)
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
