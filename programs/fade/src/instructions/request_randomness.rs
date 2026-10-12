//! `request_randomness`: the seed is derived from entropy that did not exist
//! when the ticket opened (Technical Specification §3.6, design B).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use fade_math::{orao_layout, slot_hashes};

use crate::constants::*;
use crate::errors::FadeError;
use crate::events::RandomnessRequested;
use crate::instructions::common::move_lamports;
use crate::state::{Ticket, TicketStatus};

#[event_cpi]
#[derive(Accounts)]
pub struct RequestRandomness<'info> {
    /// Anyone; receives the requester's share of the crank fee.
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [TICKET_SEED, ticket.integrator.as_ref(), &ticket.nonce.to_le_bytes()], bump = ticket.bump)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(mut, seeds = [VRF_PAYER_SEED, ticket.key().as_ref()], bump = ticket.vrf_payer_bump)]
    pub vrf_payer: SystemAccount<'info>,
    /// CHECK: pinned to the sysvar; parsed with a bounded reader.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    /// CHECK: ORAO's network state at its derived address, owner checked in the handler.
    #[account(mut, seeds = [orao_layout::NETWORK_STATE_SEED], bump, seeds::program = ORAO_VRF_ID)]
    pub orao_network_state: UncheckedAccount<'info>,
    /// CHECK: compared with the treasury recorded in the network state.
    #[account(mut)]
    pub orao_treasury: UncheckedAccount<'info>,
    /// CHECK: must be ORAO's request PDA for the seed derived in the handler.
    #[account(mut)]
    pub request: UncheckedAccount<'info>,
    /// CHECK: pinned to the ORAO program.
    #[account(address = ORAO_VRF_ID)]
    pub orao_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// `SHA256("FADE/ORAO-SEED/v1" ‖ program ‖ ticket ‖ open_slot ‖ s* ‖ h*)`.
pub fn orao_seed(
    program: &Pubkey,
    ticket: &Pubkey,
    open_slot: u64,
    entropy_slot: u64,
    entropy_hash: &[u8; 32],
) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[
        ORAO_SEED_TAG,
        program.as_ref(),
        ticket.as_ref(),
        &open_slot.to_le_bytes(),
        &entropy_slot.to_le_bytes(),
        entropy_hash,
    ])
    .to_bytes()
}

pub fn request_randomness_handler(ctx: Context<RequestRandomness>) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let ticket = &ctx.accounts.ticket;
    require!(
        ticket.status == TicketStatus::Open,
        FadeError::WrongTicketStatus
    );
    let slot = Clock::get()?.slot;
    let earliest = ticket
        .open_slot
        .checked_add(REQUEST_MIN_DELAY_SLOTS)
        .ok_or(FadeError::MathOverflow)?;
    require!(
        slot >= earliest && slot <= ticket.expiry_slot,
        FadeError::RequestWindow
    );

    // s*: the first slot after the open, h*: its hash. Skipped slots are absent.
    let entropy = {
        let data = ctx.accounts.slot_hashes.try_borrow_data()?;
        slot_hashes::first_after(&data, ticket.open_slot).ok_or(FadeError::EntropyUnavailable)?
    };
    let seed = orao_seed(
        ctx.program_id,
        &ticket.key(),
        ticket.open_slot,
        entropy.slot,
        &entropy.hash,
    );
    let (expected, _) =
        Pubkey::find_program_address(&[orao_layout::REQUEST_SEED, seed.as_ref()], &ORAO_VRF_ID);
    require_keys_eq!(
        ctx.accounts.request.key(),
        expected,
        FadeError::WrongRandomnessAccount
    );

    let request = &ctx.accounts.request;
    if *request.owner == ORAO_VRF_ID {
        // Anyone may pre-create the request through ORAO once the seed is
        // public, with `request_v2` or with the deprecated `request`, which
        // still creates a legacy account at the same address. Accept either:
        // ORAO fulfils both for this seed, which settlement checks. The prefund
        // stays on vrf_payer and goes back to the payer at close. Lamports sent
        // to the address without ORAO leave it system-owned: ORAO's own
        // initialisation takes it over below, so a stray transfer cannot block
        // the request.
        let data = request.try_borrow_data()?;
        require!(
            orao_layout::randomness(&data).is_some(),
            FadeError::WrongRandomnessAccount
        );
    } else {
        let network = &ctx.accounts.orao_network_state;
        require_keys_eq!(
            *network.owner,
            ORAO_VRF_ID,
            FadeError::NetworkStateUnreadable
        );
        let state = orao_layout::network_state(&network.try_borrow_data()?)
            .ok_or(FadeError::NetworkStateUnreadable)?;
        require_keys_eq!(
            Pubkey::new_from_array(state.treasury),
            ctx.accounts.orao_treasury.key(),
            FadeError::TreasuryMismatch
        );
        // The prefund carries a margin against a rise of ORAO's fee. Keep only
        // today's fee and rent on vrf_payer and park the rest on the ticket,
        // which returns it to the payer at close: a system account left below
        // its rent-exempt minimum would fail the transaction.
        let ticket_key = ticket.key();
        let seeds: &[&[u8]] = &[
            VRF_PAYER_SEED,
            ticket_key.as_ref(),
            &[ticket.vrf_payer_bump],
        ];
        let needed = state
            .request_fee
            .checked_add(Rent::get()?.minimum_balance(orao_layout::PENDING_LEN))
            .ok_or(FadeError::MathOverflow)?;
        let excess = ctx.accounts.vrf_payer.lamports().saturating_sub(needed);
        if excess > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.vrf_payer.to_account_info(),
                        to: ctx.accounts.ticket.to_account_info(),
                    },
                    &[seeds],
                ),
                excess,
            )?;
        }
        let mut data = Vec::with_capacity(40);
        data.extend_from_slice(&orao_layout::REQUEST_V2_DISCRIMINATOR);
        data.extend_from_slice(&seed);
        let ix = Instruction {
            program_id: ORAO_VRF_ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.vrf_payer.key(), true),
                AccountMeta::new(ctx.accounts.orao_network_state.key(), false),
                AccountMeta::new(ctx.accounts.orao_treasury.key(), false),
                AccountMeta::new(ctx.accounts.request.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                ctx.accounts.vrf_payer.to_account_info(),
                ctx.accounts.orao_network_state.to_account_info(),
                ctx.accounts.orao_treasury.to_account_info(),
                ctx.accounts.request.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.orao_program.to_account_info(),
            ],
            &[seeds],
        )?;
    }

    let share = ctx.accounts.ticket.crank_request_lamports;
    move_lamports(
        &ctx.accounts.ticket.to_account_info(),
        &ctx.accounts.caller.to_account_info(),
        share,
    )?;
    let request_key = ctx.accounts.request.key();
    let ticket = &mut ctx.accounts.ticket;
    ticket.crank_request_lamports = 0;
    ticket.status = TicketStatus::Requested;
    ticket.randomness = request_key;
    ticket.entropy_slot = entropy.slot;
    ticket.entropy_hash = entropy.hash;
    ticket.seed = seed;
    emit_cpi!(RandomnessRequested {
        version: EVENT_VERSION,
        ticket: ctx.accounts.ticket.key(),
        request: request_key,
        seed,
        entropy_slot: entropy.slot,
    });
    Ok(())
}
