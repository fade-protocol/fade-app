//! `request_randomness`: the seed is derived from entropy that did not exist
//! when the ticket opened (Technical Specification §3.6, design B).
//!
//! The seed is public from the slot after the open, and anyone can create
//! ORAO's request for it and read its outcome before the ticket's expiry.
//! After the window, a request someone already created through ORAO and ORAO
//! fulfilled with a non-zero randomness is still bound, never a new one
//! funded, never a pending one: `expire_ticket` refuses to forfeit a ticket
//! whose request is fulfilled, and this is how that ticket is settled. The
//! request address comes from the ticket's recorded seed when there is one,
//! whatever SlotHashes holds; otherwise from SlotHashes while it proves the
//! entropy slot.
//!
//! `record_ticket_entropy` records that seed, and nothing else, while
//! SlotHashes proves `s*`: once recorded, neither the late binding nor
//! `expire_ticket`'s refusal of a fulfilled request depends on the sysvar any
//! more, so that nobody who reads a request's outcome can wait for SlotHashes
//! to forget the ticket and choose its end. The direct twin of the beacon's
//! `record_round_entropy` (Spec 08 invariant 10).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use fade_math::orao_layout::{self, Randomness};

use crate::constants::*;
use crate::errors::FadeError;
use crate::events::{RandomnessRequested, TicketEntropyRecorded};
use crate::instructions::common::move_lamports;
use crate::instructions::request_round_draw::{proven_entropy, Entropy, EntropyProof};
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

/// Ticket `ticket`'s entropy, the twin of `round_entropy`. Recorded (an
/// entropy slot is never 0, `s*` following the open): the stored seed, entropy
/// slot and hash, whatever SlotHashes holds. Not recorded: `s* =
/// first_after_retained(open_slot)` and its hash, while SlotHashes proves it.
pub fn ticket_entropy(
    program_id: &Pubkey,
    ticket_key: &Pubkey,
    ticket: &Ticket,
    slot_hashes: &AccountInfo,
) -> Result<EntropyProof> {
    if ticket.entropy_recorded() {
        return Ok(EntropyProof::Known(Entropy {
            slot: ticket.entropy_slot,
            hash: ticket.entropy_hash,
            seed: ticket.seed,
        }));
    }
    let data = slot_hashes.try_borrow_data()?;
    Ok(proven_entropy(&data, ticket.open_slot, |slot, hash| {
        orao_seed(program_id, ticket_key, ticket.open_slot, slot, hash)
    }))
}

/// ORAO's request address for `seed`.
pub fn orao_request_address(seed: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[orao_layout::REQUEST_SEED, seed.as_ref()], &ORAO_VRF_ID).0
}

// --- record_ticket_entropy -----------------------------------------------------------------

#[event_cpi]
#[derive(Accounts)]
pub struct RecordTicketEntropy<'info> {
    /// The ticket, at `["ticket", integrator, nonce]` with its stored bump.
    #[account(mut, seeds = [TICKET_SEED, ticket.integrator.as_ref(), &ticket.nonce.to_le_bytes()], bump = ticket.bump)]
    pub ticket: Box<Account<'info, Ticket>>,
    /// CHECK: pinned to the sysvar; parsed with a bounded reader.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

/// Anyone, never paused, unpaid: records an Open ticket's seed, entropy slot
/// and hash while SlotHashes proves `s*` (from `open_slot + 2`, for about 512
/// slots), and changes nothing else. A ticket already recorded is left as it
/// is and the call succeeds, so that it can be sent alongside, or raced by,
/// `request_randomness`, which records the same fields.
pub fn record_ticket_entropy(ctx: Context<RecordTicketEntropy>) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let ticket = &ctx.accounts.ticket;
    require!(
        ticket.status == TicketStatus::Open,
        FadeError::WrongTicketStatus
    );
    if ticket.entropy_recorded() {
        return Ok(());
    }
    let ticket_key = ticket.key();
    let entropy = ticket_entropy(
        ctx.program_id,
        &ticket_key,
        ticket,
        &ctx.accounts.slot_hashes,
    )?
    .known()?;

    let ticket = &mut ctx.accounts.ticket;
    ticket.entropy_slot = entropy.slot;
    ticket.entropy_hash = entropy.hash;
    ticket.seed = entropy.seed;

    emit_cpi!(TicketEntropyRecorded {
        version: EVENT_VERSION,
        ticket: ticket_key,
        seed: entropy.seed,
        entropy_slot: entropy.slot,
        entropy_hash: entropy.hash,
    });
    Ok(())
}

// --- request_randomness ----------------------------------------------------------------------

/// ORAO's network state at the pinned address (the caller's seeds
/// constraint), owner checked, with `treasury` the one it records: the fee and
/// the treasury of a request are never set by Fade.
pub fn orao_network(
    network: &AccountInfo,
    treasury: &AccountInfo,
) -> Result<orao_layout::NetworkState> {
    require_keys_eq!(
        *network.owner,
        ORAO_VRF_ID,
        FadeError::NetworkStateUnreadable
    );
    let state = orao_layout::network_state(&network.try_borrow_data()?)
        .ok_or(FadeError::NetworkStateUnreadable)?;
    require_keys_eq!(
        Pubkey::new_from_array(state.treasury),
        treasury.key(),
        FadeError::TreasuryMismatch
    );
    Ok(state)
}

/// ORAO's `request_v2(seed)`, `payer` signing: the payer, the network state,
/// the treasury and the request writable, the System program last.
pub fn orao_request_v2_ix(
    payer: Pubkey,
    network_state: Pubkey,
    treasury: Pubkey,
    request: Pubkey,
    system_program: Pubkey,
    seed: [u8; 32],
) -> Instruction {
    let mut data = Vec::with_capacity(40);
    data.extend_from_slice(&orao_layout::REQUEST_V2_DISCRIMINATOR);
    data.extend_from_slice(&seed);
    Instruction {
        program_id: ORAO_VRF_ID,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(network_state, false),
            AccountMeta::new(treasury, false),
            AccountMeta::new(request, false),
            AccountMeta::new_readonly(system_program, false),
        ],
        data,
    }
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
    let pre_created = *ctx.accounts.request.owner == ORAO_VRF_ID;
    // The window, `open_slot + 2 ≤ slot ≤ expiry_slot`. After it, only a
    // request someone already created through ORAO is bound, once ORAO
    // fulfilled it with a non-zero randomness (checked with its data below):
    // `expire_ticket` refuses to forfeit a ticket whose request is fulfilled,
    // and binding it late is what lets that ticket still be settled. Nothing
    // new is ever funded after the window.
    let late = slot > ticket.expiry_slot;
    require!(
        (slot >= earliest && !late) || (late && pre_created),
        FadeError::RequestWindow
    );

    // s*: the first slot after the open, h*: its hash, and the seed: the
    // ticket's recorded ones if any, whatever SlotHashes holds, so that a
    // recorded ticket is bound late at any time. Otherwise from SlotHashes:
    // the window ends at `expiry_slot ≤ open_slot + 400`, well inside the 512
    // slots it retains, so `s*` is the same whenever in the window the
    // request lands; after the window, a ticket never recorded whose `s*`
    // SlotHashes no longer proves is refused (`EntropyUnrecorded`): its
    // request address can no longer be derived, and `refund_expired_ticket`
    // refunds it.
    let ticket_key = ticket.key();
    let entropy = ticket_entropy(
        ctx.program_id,
        &ticket_key,
        ticket,
        &ctx.accounts.slot_hashes,
    )?
    .known()?;
    let seed = entropy.seed;
    require_keys_eq!(
        ctx.accounts.request.key(),
        orao_request_address(&seed),
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
        let parsed = orao_layout::randomness(&data).ok_or(FadeError::WrongRandomnessAccount)?;
        // After the window, only a request fulfilled with a non-zero
        // randomness is bound: that is the ticket `expire_ticket` refuses to
        // forfeit. A pending one, or one fulfilled with zero, leaves the
        // ticket forfeitable either way, and binding it would change nothing.
        if late {
            require!(
                matches!(
                    parsed,
                    Randomness::Fulfilled { randomness, .. } if randomness != [0u8; 64]
                ),
                FadeError::RequestWindow
            );
        }
    } else {
        let state = orao_network(
            &ctx.accounts.orao_network_state,
            &ctx.accounts.orao_treasury,
        )?;
        // The prefund carries a margin against a rise of ORAO's fee. Keep only
        // today's fee and rent on vrf_payer and park the rest on the ticket,
        // which returns it to the payer at close: a system account left below
        // its rent-exempt minimum would fail the transaction.
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
        let ix = orao_request_v2_ix(
            ctx.accounts.vrf_payer.key(),
            ctx.accounts.orao_network_state.key(),
            ctx.accounts.orao_treasury.key(),
            ctx.accounts.request.key(),
            ctx.accounts.system_program.key(),
            seed,
        );
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
