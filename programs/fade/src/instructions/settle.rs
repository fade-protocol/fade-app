//! Closing a ticket: `settle_ticket` once ORAO has fulfilled, at any later time;
//! `expire_ticket` after `T_SETTLE` if it never did; `refund_expired_ticket`
//! for an expired ticket whose request can no longer be looked for;
//! `claim_payout` for a payout that could not reach its beneficiary at
//! settlement (Spec 02 §2, Spec 07 §5–§6); `sweep_ticket_vrf` for what reaches
//! a closed ticket's `vrf_payer`.
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
use crate::events::{PayoutClaimed, TicketExpired, TicketSettled, TicketVrfSwept};
use crate::instructions::common::{
    is_usdc_account, move_lamports, vault_transfer, withheld_forfeit,
};
use crate::instructions::request_randomness::{orao_request_address, ticket_entropy};
use crate::instructions::request_round_draw::EntropyProof;
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
    release_books(
        vault,
        integrator,
        Released {
            liability: ticket.reserved_liability,
            vault_credit: ticket.vault_credit,
            payout,
            side: ticket.side(),
            generation: ticket.generation,
            drawdown_bps: ticket.drawdown_bps,
        },
        now,
    )
}

/// What a closing ticket, direct or beacon, gives back to the books.
pub(crate) struct Released {
    /// The net liability it reserved.
    pub liability: u64,
    /// Its vault credit.
    pub vault_credit: u64,
    /// What it pays out (0 for an expiry or a forfeiture).
    pub payout: u64,
    /// The epoch counter it entered, and in which generation.
    pub side: Side,
    pub generation: u32,
    /// The drawdown threshold snapshotted at its open or its round's creation.
    pub drawdown_bps: u64,
}

/// The books of Spec 08 §4 rule 4, shared by `settle_ticket`, `expire_ticket`
/// and `settle_round_tickets`: the payout leaves the assets, the reservation
/// and the credit are released, the ticket leaves its epoch counter (its
/// result booked as an after-close one when the counter calls for it), the
/// price is observed and a trip recorded; the integrator's reservation and
/// open tickets are released.
pub(crate) fn release_books(
    vault: &mut Vault,
    integrator: &mut Integrator,
    r: Released,
    now: i64,
) -> Result<()> {
    let price_before = vault.settled_price().or_fade()?;
    vault.total_assets = vault
        .total_assets
        .checked_sub(r.payout)
        .ok_or(FadeError::MathOverflow)?;
    vault.total_reserved_liability = vault
        .total_reserved_liability
        .checked_sub(r.liability)
        .ok_or(FadeError::MathOverflow)?;
    vault.open_vault_credits = vault
        .open_vault_credits
        .checked_sub(r.vault_credit)
        .ok_or(FadeError::MathOverflow)?;
    let mut counters = vault.counters();
    if r.side == Side::AfterClose && r.generation == counters.generation {
        vault
            .record_after_close_result(r.vault_credit, r.payout)
            .or_fade()?;
    }
    counters.close(r.side, r.generation).or_fade()?;
    vault.set_counters(&counters);
    let price_after = vault.settled_price().or_fade()?;
    let mut ring = vault.ring();
    ring.observe(now, price_before, price_after);
    if ring.tripped(price_after, r.drawdown_bps) {
        vault.drawdown_trip_ts = now;
    }
    vault.set_ring(&ring);

    integrator.reserved_liability = integrator
        .reserved_liability
        .checked_sub(r.liability)
        .ok_or(FadeError::MathOverflow)?;
    integrator.open_tickets = integrator
        .open_tickets
        .checked_sub(1)
        .ok_or(FadeError::MathOverflow)?;
    Ok(())
}

/// Everything the ORAO prefund still holds moves onto the ticket, whose close
/// carries it to the payer with the rent (`claim_payout`'s close for a parked
/// ticket). The payer is an address stored at open, never handed to a CPI:
/// the runtime does not copy a CPI's lamport change on an executable account
/// back into the caller's view, so a payer turned into a program after the
/// open would fail every exit of its ticket on an unbalanced instruction, and
/// the ticket would hold its epoch's strike for good. A direct credit, the
/// close's, reaches any writable account, executable or not.
fn drain_vrf_payer<'info>(
    vrf_payer: &SystemAccount<'info>,
    ticket: AccountInfo<'info>,
    bump: u8,
    system: &Program<'info, System>,
) -> Result<()> {
    let lamports = vrf_payer.lamports();
    if lamports == 0 {
        return Ok(());
    }
    let ticket_key = ticket.key();
    let seeds: &[&[u8]] = &[VRF_PAYER_SEED, ticket_key.as_ref(), &[bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            system.key(),
            system_program::Transfer {
                from: vrf_payer.to_account_info(),
                to: ticket,
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

    // The prefund onto the ticket, then the crank fee to the settler. The CPI
    // comes first: lamports moved directly before a CPI are only reconciled
    // for the accounts that CPI receives, and the ticket is one. The payer is
    // credited directly, by the close, never through a CPI.
    let vrf_bump = ctx.accounts.ticket.vrf_payer_bump;
    drain_vrf_payer(
        &ctx.accounts.vrf_payer,
        ctx.accounts.ticket.to_account_info(),
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
        // Parked: the ticket keeps the prefund with its rent until
        // `claim_payout` closes it to the payer.
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
    /// CHECK: the bound request, or, for a ticket never requested, the
    /// request address derived from its recorded seed; checked in the handler.
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: the payer recorded at open.
    #[account(mut, address = ticket.payer)]
    pub payer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Forfeiture, never a refund: the credit stays with the vault (Spec 02 §2.2).
///
/// A fulfilled request must be settled, not expired (`AlreadyFulfilled`),
/// bound or not. A ticket never requested is expired only once its seed is
/// recorded (`record_ticket_entropy`, `EntropyUnrecorded` otherwise), with
/// `randomness` the request address derived from it: its seed is public from
/// the slot after the open, so anyone may have created its request through
/// ORAO and read the outcome, and a forfeiture would then be a draw withheld
/// by whoever chose not to bind it. A fulfilled request there is bound late
/// by `request_randomness` and settled; a pending one, or one fulfilled with
/// zero, is reported (`request_found`). A ticket whose seed was never
/// recorded and whose `s*` SlotHashes no longer proves is refunded instead,
/// by `refund_expired_ticket`. Every expiry a withheld draw may explain counts
/// in `Vault.ticket_forfeits_withheld`.
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
    let randomness = &ctx.accounts.randomness;
    // `request_found`: an ORAO request exists at the ticket's seed; `checked`:
    // the program looked for one; `pending`: the bound request is still
    // pending and `vrf_payer` paid its rent, so ORAO's refund of that rent
    // will reach `vrf_payer` (a request someone else created refunds them).
    let (requested, request_found, pending) = if ticket.status == TicketStatus::Requested {
        // A fulfilled request must be settled, not expired: the race between a
        // settler and an expirer is decided by whichever lands first.
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
        let pending = match orao_layout::randomness(&data) {
            Some(Randomness::Pending) => {
                orao_layout::pending_v2_client(&data)
                    == Some(ctx.accounts.vrf_payer.key().to_bytes())
            }
            Some(Randomness::Fulfilled { randomness, .. }) if randomness == [0u8; 64] => false,
            Some(Randomness::Fulfilled { .. }) => return err!(FadeError::AlreadyFulfilled),
            None => return err!(FadeError::WrongRandomnessAccount),
        };
        (true, true, pending)
    } else {
        require!(ticket.entropy_recorded(), FadeError::EntropyUnrecorded);
        require_keys_eq!(
            randomness.key(),
            orao_request_address(&ticket.seed),
            FadeError::WrongRandomnessAccount
        );
        let found = if *randomness.owner == ORAO_VRF_ID {
            let data = randomness.try_borrow_data()?;
            match orao_layout::randomness(&data) {
                Some(Randomness::Pending) => {}
                Some(Randomness::Fulfilled { randomness, .. }) if randomness == [0u8; 64] => {}
                Some(Randomness::Fulfilled { .. }) => return err!(FadeError::AlreadyFulfilled),
                None => return err!(FadeError::WrongRandomnessAccount),
            }
            true
        } else {
            // No request: lamports sent to the address leave it system-owned.
            false
        };
        (false, found, false)
    };
    let checked = true;

    let now = Clock::get()?.unix_timestamp;
    release(
        &mut ctx.accounts.vault,
        &mut ctx.accounts.integrator,
        &ctx.accounts.ticket,
        0,
        now,
    )?;
    let vault = &mut ctx.accounts.vault;
    if withheld_forfeit(requested, request_found, checked) {
        vault.ticket_forfeits_withheld = vault
            .ticket_forfeits_withheld
            .checked_add(1)
            .ok_or(FadeError::MathOverflow)?;
    }
    let ticket_forfeits_withheld = vault.ticket_forfeits_withheld;

    // The CPI before the direct move, as in settle_ticket.
    let vrf_bump = ctx.accounts.ticket.vrf_payer_bump;
    drain_vrf_payer(
        &ctx.accounts.vrf_payer,
        ctx.accounts.ticket.to_account_info(),
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
        version: TICKET_EXPIRED_VERSION,
        ticket: ticket_key,
        integrator: integrator_key,
        forfeited,
        requested,
        request_found,
        checked,
        pending,
        refunded: false,
        refund: 0,
        parked: false,
        ticket_forfeits_withheld,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct RefundExpiredTicket<'info> {
    /// Anyone; receives the settler's share of the crank fee.
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
    /// CHECK: pinned to the sysvar; parsed with a bounded reader.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
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

/// The books of a refunded ticket: its credit leaves the assets with the open
/// credits, its reservation is released, it leaves its epoch counter, and the
/// integrator's reservation and open tickets are released. A refund is no
/// result: the settled assets do not move, so no after-close result is booked
/// and the drawdown ring is not observed.
fn release_refund(vault: &mut Vault, integrator: &mut Integrator, ticket: &Ticket) -> Result<()> {
    vault.total_assets = vault
        .total_assets
        .checked_sub(ticket.vault_credit)
        .ok_or(FadeError::MathOverflow)?;
    vault.open_vault_credits = vault
        .open_vault_credits
        .checked_sub(ticket.vault_credit)
        .ok_or(FadeError::MathOverflow)?;
    vault.total_reserved_liability = vault
        .total_reserved_liability
        .checked_sub(ticket.reserved_liability)
        .ok_or(FadeError::MathOverflow)?;
    let mut counters = vault.counters();
    counters.close(ticket.side(), ticket.generation).or_fade()?;
    vault.set_counters(&counters);
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

/// Anyone, never paused, paid the settler's share: the end of an expired
/// ticket never requested whose request can no longer be looked for, its
/// seed never recorded and SlotHashes no longer proving `s*`
/// (`EntropyStillProven` while it does: record it and expire the ticket).
/// The vault credit goes back to the beneficiary, or waits in
/// `payout_escrow` for `claim_payout` when the beneficiary cannot receive it
/// (`PayoutPending`, `payout` the credit); the protocol and app shares paid
/// at open are not returned.
///
/// Why a refund. Anyone may have created the ticket's request through ORAO
/// once its seed was public and read its outcome; with the seed never
/// recorded and `s*` gone from SlotHashes, the program cannot tell whether
/// that request exists, so any end that depends on it is the choice of
/// whoever holds it. A forfeiture would let them void every ticket that
/// wins; settling is impossible without the request. The refund is the end
/// that does not depend on the draw, as `expire_round` refunds a round
/// (Spec 08 invariant 10). It still leaves whoever held a fulfilled request
/// a choice between settling and this refund. The program cannot record the
/// seed at the open (`s*` does not exist yet) and does not require anyone to
/// record it; the keeper sends `record_ticket_entropy` on its own transaction
/// from `open_slot + 2`, ahead of its request, so that the choice exists
/// only for a ticket opened while nobody records seeds for about the
/// SlotHashes retention (512 slots). That residual is accepted, as it is for
/// `expire_round`, and bounded by the alarm: this path counts as a withheld
/// draw (`Vault.ticket_forfeits_withheld`), whose unacknowledged count
/// recommends the guardian's pause.
pub fn refund_expired_ticket(ctx: Context<RefundExpiredTicket>) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let ticket_key = ctx.accounts.ticket.key();
    let ticket = &ctx.accounts.ticket;
    require!(
        ticket.status == TicketStatus::Open,
        FadeError::WrongTicketStatus
    );
    require!(
        Clock::get()?.slot > ticket.expiry_slot,
        FadeError::NotExpired
    );
    match ticket_entropy(
        ctx.program_id,
        &ticket_key,
        ticket,
        &ctx.accounts.slot_hashes,
    )? {
        EntropyProof::Lost => {}
        EntropyProof::Known(_) => return err!(FadeError::EntropyStillProven),
        EntropyProof::NotYet => return err!(FadeError::EntropyUnavailable),
    }

    release_refund(
        &mut ctx.accounts.vault,
        &mut ctx.accounts.integrator,
        &ctx.accounts.ticket,
    )?;
    let vault = &mut ctx.accounts.vault;
    vault.ticket_forfeits_withheld = vault
        .ticket_forfeits_withheld
        .checked_add(1)
        .ok_or(FadeError::MathOverflow)?;
    let ticket_forfeits_withheld = vault.ticket_forfeits_withheld;

    let refund = ctx.accounts.ticket.vault_credit;
    let mint_key = ctx.accounts.usdc_mint.key();
    // Read before any CPI: a failed transfer would abort the refund.
    let parked = refund > 0 && !is_usdc_account(&ctx.accounts.beneficiary, &mint_key);
    let destination = if parked {
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
        refund,
    )?;

    // The CPI before the direct move, as in settle_ticket.
    let vrf_bump = ctx.accounts.ticket.vrf_payer_bump;
    drain_vrf_payer(
        &ctx.accounts.vrf_payer,
        ctx.accounts.ticket.to_account_info(),
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
    let ticket = &mut ctx.accounts.ticket;
    ticket.crank_settle_lamports = 0;
    if parked {
        // The requester's share, never paid, and the prefund go back with the
        // rent at the claim.
        // `REFUND_OUTCOME` tells this parked refund from a parked settlement.
        ticket.status = TicketStatus::PayoutPending;
        ticket.outcome = REFUND_OUTCOME;
        ticket.payout = refund;
    } else {
        ctx.accounts
            .ticket
            .close(ctx.accounts.payer.to_account_info())?;
    }
    emit_cpi!(TicketExpired {
        version: TICKET_EXPIRED_VERSION,
        ticket: ticket_key,
        integrator: integrator_key,
        forfeited: 0,
        requested: false,
        request_found: false,
        checked: false,
        pending: false,
        refunded: true,
        refund,
        parked,
        ticket_forfeits_withheld,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct SweepTicketVrf<'info> {
    /// Anyone; receives what a closed ticket's `vrf_payer` holds.
    #[account(mut)]
    pub caller: Signer<'info>,
    /// Read for `next_nonce`: only a ticket the integrator opened is swept.
    #[account(seeds = [INTEGRATOR_SEED, integrator.authority.as_ref()], bump = integrator.bump)]
    pub integrator: Box<Account<'info, Integrator>>,
    /// CHECK: ticket `nonce`'s address, `["ticket", integrator, nonce]`. Only
    /// its owner is read: a ticket's address is never used again, so any
    /// owner but this program means the ticket has closed.
    #[account(seeds = [TICKET_SEED, integrator.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub ticket: UncheckedAccount<'info>,
    /// `["vrf-payer", ticket]`, signed by the program.
    #[account(mut, seeds = [VRF_PAYER_SEED, ticket.key().as_ref()], bump)]
    pub vrf_payer: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Anyone, never paused, unpaid: every lamport on a closed direct ticket's
/// `vrf_payer` leaves it, to the caller. ORAO refunds a request's pending
/// rent to `vrf_payer` when it fulfils it, which for a ticket expired with
/// its request still pending comes after `expire_ticket` drained it, and
/// anyone may send lamports to it at any time; while the ticket exists its
/// own exit drains `vrf_payer` onto it, for its payer, so the sweep refuses it
/// (`WrongTicketStatus`). Once the ticket has closed, nothing on-chain names
/// its payer any more, so the sweep pays whoever sends it. Nothing reads
/// `vrf_payer` after the close: no outcome, settlement or book depends on
/// what this moves. Nothing to sweep succeeds without moving or emitting
/// anything, so that the sweep can be sent early, or raced.
pub fn sweep_ticket_vrf(ctx: Context<SweepTicketVrf>, nonce: u64) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    // A ticket the integrator opened: a later nonce names no ticket yet, and
    // lamports sent to its `vrf_payer` are its open's to take over.
    require!(
        nonce < ctx.accounts.integrator.next_nonce,
        FadeError::WrongNonce
    );
    require!(
        *ctx.accounts.ticket.owner != crate::ID,
        FadeError::WrongTicketStatus
    );
    let lamports = ctx.accounts.vrf_payer.lamports();
    if lamports == 0 {
        return Ok(());
    }
    let ticket_key = ctx.accounts.ticket.key();
    let seeds: &[&[u8]] = &[VRF_PAYER_SEED, ticket_key.as_ref(), &[ctx.bumps.vrf_payer]];
    let to = ctx.accounts.caller.key();
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.vrf_payer.to_account_info(),
                to: ctx.accounts.caller.to_account_info(),
            },
            &[seeds],
        ),
        lamports,
    )?;
    emit_cpi!(TicketVrfSwept {
        version: EVENT_VERSION,
        ticket: ticket_key,
        integrator: ctx.accounts.integrator.key(),
        nonce,
        to,
        lamports,
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
