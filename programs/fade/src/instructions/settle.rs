//! Closing a ticket: `settle_ticket` once ORAO has fulfilled, at any later time;
//! `expire_ticket` after `T_SETTLE` if it never did; `claim_payout` for a payout
//! that could not reach its beneficiary at settlement (Spec 02 §2, Spec 07 §5–§6).
//!
//! `settle_ticket` must always succeed: a ticket that could not be settled would
//! block every later strike. Nothing here depends on live parameters.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{Mint, Token, TokenAccount};
use fade_math::epoch::Side;
use fade_math::orao_layout::{self, Randomness};
use fade_math::{payout_table, select};

use crate::constants::*;
use crate::errors::{FadeError, OrFade};
use crate::events::{PayoutClaimed, TicketExpired, TicketSettled};
use crate::instructions::common::{is_usdc_account, move_lamports, vault_transfer};
use crate::state::{Config, Integrator, Ticket, TicketStatus, Vault};

/// `SHA256("FADE/OUTCOME/v1" ‖ program ‖ ticket ‖ seed ‖ R ‖ i)`.
pub fn outcome_hash(
    program: &Pubkey,
    ticket: &Pubkey,
    seed: &[u8; 32],
    randomness: &[u8; 64],
    i: u8,
) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[
        OUTCOME_TAG,
        program.as_ref(),
        ticket.as_ref(),
        seed,
        randomness,
        &[i],
    ])
    .to_bytes()
}

/// What both closing paths do to the books: release the reservation, leave
/// the epoch counter, observe the price.
fn release(
    vault: &mut Vault,
    integrator: &mut Integrator,
    ticket: &Ticket,
    payout: u64,
    now: i64,
) -> Result<()> {
    let price_before = vault.settled_price().or_fade()?;
    vault.total_assets = vault
        .total_assets
        .checked_sub(payout)
        .ok_or(FadeError::MathOverflow)?;
    vault.total_reserved_liability = vault
        .total_reserved_liability
        .checked_sub(ticket.reserved_liability)
        .ok_or(FadeError::MathOverflow)?;
    vault.open_vault_credits = vault
        .open_vault_credits
        .checked_sub(ticket.vault_credit)
        .ok_or(FadeError::MathOverflow)?;
    let mut counters = vault.counters();
    if ticket.side() == Side::AfterClose && ticket.generation == counters.generation {
        vault
            .record_after_close_result(ticket.vault_credit, payout)
            .or_fade()?;
    }
    counters.close(ticket.side(), ticket.generation).or_fade()?;
    vault.set_counters(&counters);
    let price_after = vault.settled_price().or_fade()?;
    let mut ring = vault.ring();
    ring.observe(now, price_before, price_after);
    if ring.tripped(price_after, ticket.drawdown_bps) {
        vault.drawdown_trip_ts = now;
    }
    vault.set_ring(&ring);

    integrator.reserved_liability = integrator
        .reserved_liability
        .checked_sub(ticket.reserved_liability)
        .ok_or(FadeError::MathOverflow)?;
    integrator.open_tickets = integrator
        .open_tickets
        .checked_sub(1)
        .ok_or(FadeError::MathOverflow)?;
    Ok(())
}

/// Everything the ORAO prefund still holds goes back to the ticket's payer.
fn drain_vrf_payer<'info>(
    vrf_payer: &SystemAccount<'info>,
    payer: AccountInfo<'info>,
    ticket: &Pubkey,
    bump: u8,
    system: &Program<'info, System>,
) -> Result<()> {
    let lamports = vrf_payer.lamports();
    if lamports == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[VRF_PAYER_SEED, ticket.as_ref(), &[bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            system.key(),
            system_program::Transfer {
                from: vrf_payer.to_account_info(),
                to: payer,
            },
            &[seeds],
        ),
        lamports,
    )
}

#[event_cpi]
#[derive(Accounts)]
pub struct SettleTicket<'info> {
    /// Anyone, once ORAO has fulfilled; receives the settler's share of the crank fee.
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = ticket.integrator)]
    pub integrator: Box<Account<'info, Integrator>>,
    #[account(mut, seeds = [TICKET_SEED, ticket.integrator.as_ref(), &ticket.nonce.to_le_bytes()], bump = ticket.bump)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(mut, seeds = [VRF_PAYER_SEED, ticket.key().as_ref()], bump = ticket.vrf_payer_bump)]
    pub vrf_payer: SystemAccount<'info>,
    /// CHECK: the request bound at `request_randomness`, never a fresh one.
    #[account(address = ticket.randomness @ FadeError::WrongRandomnessAccount)]
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: the beneficiary stored at open; inspected before any transfer.
    #[account(mut, address = ticket.beneficiary @ FadeError::BeneficiaryMismatch)]
    pub beneficiary: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYOUT_ESCROW_SEED], bump)]
    pub payout_escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: data-less PDA that owns the vault's token accounts.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: the payer recorded at open: receives the rent and every refund.
    #[account(mut, address = ticket.payer)]
    pub payer: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ FadeError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn settle_ticket(ctx: Context<SettleTicket>) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let ticket_key = ctx.accounts.ticket.key();
    let ticket = &ctx.accounts.ticket;
    require!(
        ticket.status == TicketStatus::Requested,
        FadeError::WrongTicketStatus
    );

    // The request must be ORAO's, of the right type, fulfilled, for this seed,
    // with a non-zero value. A pending request leaves the ticket untouched.
    let randomness = &ctx.accounts.randomness;
    require_keys_eq!(
        *randomness.owner,
        ORAO_VRF_ID,
        FadeError::WrongRandomnessAccount
    );
    let r = {
        let data = randomness.try_borrow_data()?;
        match orao_layout::randomness(&data) {
            Some(Randomness::Fulfilled {
                seed, randomness, ..
            }) => {
                require!(seed == ticket.seed, FadeError::WrongRandomnessAccount);
                require!(randomness != [0u8; 64], FadeError::NotFulfilled);
                randomness
            }
            Some(Randomness::Pending) => return err!(FadeError::NotFulfilled),
            None => return err!(FadeError::WrongRandomnessAccount),
        }
    };

    // The outcome: rejection-sampled 128-bit words, then the cumulative bounds.
    let outcomes = ticket.outcomes();
    let summary = payout_table::validate(&outcomes).or_fade()?;
    let program_id = *ctx.program_id;
    let draw = select::draw(
        |i| outcome_hash(&program_id, &ticket_key, &ticket.seed, &r, i),
        OUTCOME_ROUNDS,
    )
    .ok_or(FadeError::DrawFailed)?;
    let index = select::outcome(draw, &summary.cum, summary.len).ok_or(FadeError::DrawFailed)?;
    let payout = payout_table::payout(ticket.price, outcomes[index].m).or_fade()?;

    let now = Clock::get()?.unix_timestamp;
    release(
        &mut ctx.accounts.vault,
        &mut ctx.accounts.integrator,
        &ctx.accounts.ticket,
        payout,
        now,
    )?;

    let mint_key = ctx.accounts.usdc_mint.key();
    // Read before any CPI: a failed transfer would abort the settlement.
    let pending = payout > 0 && !is_usdc_account(&ctx.accounts.beneficiary, &mint_key);
    let destination = if pending {
        ctx.accounts.payout_escrow.to_account_info()
    } else {
        ctx.accounts.beneficiary.to_account_info()
    };
    vault_transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.vault_usdc,
        destination,
        &ctx.accounts.usdc_mint,
        ctx.accounts.vault_authority.to_account_info(),
        ctx.accounts.config.vault_authority_bump,
        payout,
    )?;

    // Prefund back to the payer, then the crank fee to the settler. The CPI
    // comes first: lamports moved directly before a CPI are only reconciled
    // for the accounts that CPI receives, so a settler who is also the payer
    // would otherwise fail the runtime's balance check.
    let vrf_bump = ctx.accounts.ticket.vrf_payer_bump;
    drain_vrf_payer(
        &ctx.accounts.vrf_payer,
        ctx.accounts.payer.to_account_info(),
        &ticket_key,
        vrf_bump,
        &ctx.accounts.system_program,
    )?;
    let share = ctx.accounts.ticket.crank_settle_lamports;
    move_lamports(
        &ctx.accounts.ticket.to_account_info(),
        &ctx.accounts.caller.to_account_info(),
        share,
    )?;

    let integrator_key = ctx.accounts.integrator.key();
    let outcome = u8::try_from(index).map_err(|_| FadeError::DrawFailed)?;
    let ticket = &mut ctx.accounts.ticket;
    ticket.crank_settle_lamports = 0;
    ticket.outcome = outcome;
    if pending {
        ticket.status = TicketStatus::PayoutPending;
        ticket.payout = payout;
    } else {
        ctx.accounts
            .ticket
            .close(ctx.accounts.payer.to_account_info())?;
    }
    emit_cpi!(TicketSettled {
        version: EVENT_VERSION,
        ticket: ticket_key,
        integrator: integrator_key,
        outcome,
        payout,
        pending,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct ExpireTicket<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, address = ticket.integrator)]
    pub integrator: Box<Account<'info, Integrator>>,
    #[account(mut, seeds = [TICKET_SEED, ticket.integrator.as_ref(), &ticket.nonce.to_le_bytes()], bump = ticket.bump)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(mut, seeds = [VRF_PAYER_SEED, ticket.key().as_ref()], bump = ticket.vrf_payer_bump)]
    pub vrf_payer: SystemAccount<'info>,
    /// CHECK: the bound request when there is one, checked to be unfulfilled;
    /// any account when the ticket was never requested.
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: the payer recorded at open.
    #[account(mut, address = ticket.payer)]
    pub payer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Forfeiture, never a refund: the credit stays with the vault (Spec 02 §2.2).
pub fn expire_ticket(ctx: Context<ExpireTicket>) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let ticket_key = ctx.accounts.ticket.key();
    let ticket = &ctx.accounts.ticket;
    require!(
        ticket.status == TicketStatus::Open || ticket.status == TicketStatus::Requested,
        FadeError::WrongTicketStatus
    );
    require!(
        Clock::get()?.slot > ticket.expiry_slot,
        FadeError::NotExpired
    );
    if ticket.status == TicketStatus::Requested {
        // A fulfilled request must be settled, not expired: the race between a
        // settler and an expirer is decided by whichever lands first.
        let randomness = &ctx.accounts.randomness;
        require_keys_eq!(
            randomness.key(),
            ticket.randomness,
            FadeError::WrongRandomnessAccount
        );
        require_keys_eq!(
            *randomness.owner,
            ORAO_VRF_ID,
            FadeError::WrongRandomnessAccount
        );
        let data = randomness.try_borrow_data()?;
        match orao_layout::randomness(&data) {
            Some(Randomness::Pending) => {}
            Some(Randomness::Fulfilled { randomness, .. }) if randomness == [0u8; 64] => {}
            Some(Randomness::Fulfilled { .. }) => return err!(FadeError::AlreadyFulfilled),
            None => return err!(FadeError::WrongRandomnessAccount),
        }
    }

    let now = Clock::get()?.unix_timestamp;
    release(
        &mut ctx.accounts.vault,
        &mut ctx.accounts.integrator,
        &ctx.accounts.ticket,
        0,
        now,
    )?;

    // The CPI before the direct move, as in settle_ticket.
    let vrf_bump = ctx.accounts.ticket.vrf_payer_bump;
    drain_vrf_payer(
        &ctx.accounts.vrf_payer,
        ctx.accounts.payer.to_account_info(),
        &ticket_key,
        vrf_bump,
        &ctx.accounts.system_program,
    )?;
    let share = ctx.accounts.ticket.crank_settle_lamports;
    move_lamports(
        &ctx.accounts.ticket.to_account_info(),
        &ctx.accounts.caller.to_account_info(),
        share,
    )?;
    let forfeited = ctx.accounts.ticket.vault_credit;
    let integrator_key = ctx.accounts.integrator.key();
    // The requester's share, if randomness was never requested, goes back too.
    ctx.accounts
        .ticket
        .close(ctx.accounts.payer.to_account_info())?;
    emit_cpi!(TicketExpired {
        version: EVENT_VERSION,
        ticket: ticket_key,
        integrator: integrator_key,
        forfeited,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [TICKET_SEED, ticket.integrator.as_ref(), &ticket.nonce.to_le_bytes()], bump = ticket.bump)]
    pub ticket: Box<Account<'info, Ticket>>,
    /// The beneficiary stored at open — the only destination.
    #[account(mut, address = ticket.beneficiary @ FadeError::BeneficiaryMismatch)]
    pub beneficiary: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [PAYOUT_ESCROW_SEED], bump)]
    pub payout_escrow: Box<Account<'info, TokenAccount>>,
    /// CHECK: data-less PDA that owns the vault's token accounts.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: the payer recorded at open: receives the ticket's rent.
    #[account(mut, address = ticket.payer)]
    pub payer: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ FadeError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// Permissionless: delivers a parked payout once the beneficiary can receive
/// it. A still-frozen account simply makes this fail; retry later.
pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    require!(
        ctx.accounts.ticket.status == TicketStatus::PayoutPending,
        FadeError::WrongTicketStatus
    );
    let payout = ctx.accounts.ticket.payout;
    vault_transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.payout_escrow,
        ctx.accounts.beneficiary.to_account_info(),
        &ctx.accounts.usdc_mint,
        ctx.accounts.vault_authority.to_account_info(),
        ctx.accounts.config.vault_authority_bump,
        payout,
    )?;
    let ticket_key = ctx.accounts.ticket.key();
    let beneficiary = ctx.accounts.beneficiary.key();
    ctx.accounts
        .ticket
        .close(ctx.accounts.payer.to_account_info())?;
    emit_cpi!(PayoutClaimed {
        version: EVENT_VERSION,
        ticket: ticket_key,
        beneficiary,
        payout,
    });
    Ok(())
}
