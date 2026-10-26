//! `request_round_draw` (Spec 08 §13.5.6): one ORAO request for every ticket
//! of a paid round, once the round has closed. The seed binds the round's
//! address, its close slot and the first slot hash after that close, so it
//! did not exist when any of the round's tickets joined (Spec 08 §13.8,
//! invariant 9). The request is paid from the round's lamports through
//! `round_vrf`, the system-owned PDA ORAO debits, which is empty before and
//! after; the requester gets the round's request share.
//!
//! The request does not touch the epoch counters: the round's tickets entered
//! them when it became paid, before its seed could exist (§13.7). The seed is
//! public from the slot after the close, and anyone can create ORAO's request
//! for it and know the round's results before calling this; recording the
//! round here, on the side of a time the caller chooses, would let whoever
//! knows the results pick which epoch's price they land in.
//!
//! After the window, a request someone already created through ORAO and ORAO
//! fulfilled with a non-zero randomness is still bound, never a new one
//! funded, never a pending one: `expire_round` refuses to forfeit a round
//! whose request is fulfilled, and this is how that round is settled. The
//! request address comes from the round's recorded seed when there is one,
//! whatever SlotHashes holds; otherwise from SlotHashes while it proves the
//! entropy slot.
//!
//! `record_round_entropy` (Spec 08 §13.5.6a) records that seed, and nothing
//! else, while SlotHashes proves `s*`: once recorded, neither the late
//! binding nor `expire_round`'s refusal of a fulfilled request depends on
//! the sysvar any more, so that nobody who reads a request's outcome can
//! wait for SlotHashes to forget the round and choose its end.
//!
//! Anyone may call either; neither is ever paused. Every check precedes every
//! lamport movement and every write.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use fade_math::orao_layout::{self, Randomness};
use fade_math::{beacon, slot_hashes};

use crate::constants::*;
use crate::errors::FadeError;
use crate::events::{RoundDrawRequested, RoundEntropyRecorded};
use crate::instructions::admission;
use crate::instructions::common::move_lamports;
use crate::instructions::request_randomness::{orao_network, orao_request_v2_ix};
use crate::state::{Round, RoundStatus};

#[event_cpi]
#[derive(Accounts)]
pub struct RequestRoundDraw<'info> {
    /// Anyone; receives the round's request share.
    #[account(mut)]
    pub caller: Signer<'info>,
    /// The round, at `["round", id]` with its stored bump.
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// `["round-vrf", round]` with the round's stored bump: pays ORAO, signed
    /// by the program. System-owned, empty outside the request.
    #[account(mut, seeds = [ROUND_VRF_SEED, round.key().as_ref()], bump = round.vrf_bump)]
    pub round_vrf: SystemAccount<'info>,
    /// CHECK: pinned to the sysvar; parsed with a bounded reader.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    /// CHECK: ORAO's network state at its derived address, owner checked when read.
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

/// The round's ORAO seed: `SHA256` of `beacon::seed_preimage` (Spec 08 §13.4).
pub fn round_seed(
    program: &Pubkey,
    round: &Pubkey,
    close_slot: u64,
    entropy_slot: u64,
    entropy_hash: &[u8; 32],
) -> [u8; 32] {
    let preimage = beacon::seed_preimage(
        &program.to_bytes(),
        &round.to_bytes(),
        close_slot,
        entropy_slot,
        entropy_hash,
    );
    solana_sha256_hasher::hashv(&[&preimage]).to_bytes()
}

/// An ORAO seed's entropy, a round's (§13.4) or a direct ticket's
/// (Technical Specification §3.6): `s*`, `h*` and the seed.
#[derive(Clone, Copy)]
pub struct Entropy {
    pub slot: u64,
    /// `h*`; zero for a recorded round seed whose `s*` SlotHashes no longer holds.
    pub hash: [u8; 32],
    pub seed: [u8; 32],
}

/// Where an entropy stands.
pub enum EntropyProof {
    /// Recorded on the account, or proven by SlotHashes now.
    Known(Entropy),
    /// SlotHashes holds no slot after the reference slot yet.
    NotYet,
    /// Never recorded, and SlotHashes no longer proves `s*`: the request
    /// address can no longer be derived on-chain.
    Lost,
}

impl EntropyProof {
    /// The entropy, or the refusal that fits: `EntropyUnavailable` before
    /// `s*` exists, `EntropyUnrecorded` once it can no longer be proven.
    pub fn known(self) -> Result<Entropy> {
        match self {
            EntropyProof::Known(e) => Ok(e),
            EntropyProof::NotYet => err!(FadeError::EntropyUnavailable),
            EntropyProof::Lost => err!(FadeError::EntropyUnrecorded),
        }
    }
}

/// The proof both paths share: `s* = first_after_retained(after)` and its
/// hash while SlotHashes proves it, the seed `seed_of(s*, h*)`; `NotYet`
/// before any slot after `after` exists, `Lost` once the sysvar can no
/// longer prove which slot came first. A recorded entropy is the caller's.
pub fn proven_entropy(
    slot_hashes: &[u8],
    after: u64,
    seed_of: impl FnOnce(u64, &[u8; 32]) -> [u8; 32],
) -> EntropyProof {
    match slot_hashes::first_after_retained(slot_hashes, after) {
        Some(e) => EntropyProof::Known(Entropy {
            slot: e.slot,
            hash: e.hash,
            seed: seed_of(e.slot, &e.hash),
        }),
        None if slot_hashes::first_after(slot_hashes, after).is_none() => EntropyProof::NotYet,
        None => EntropyProof::Lost,
    }
}

/// Round `round`'s entropy. Recorded: the stored seed and entropy slot, read
/// whatever SlotHashes holds (`h*` too while the sysvar still proves the same
/// `s*`, zero otherwise). Not recorded: `s* = first_after_retained(close_slot)`
/// and its hash, while SlotHashes proves it.
pub fn round_entropy(
    program_id: &Pubkey,
    round_key: &Pubkey,
    round: &Round,
    slot_hashes: &AccountInfo,
) -> Result<EntropyProof> {
    let data = slot_hashes.try_borrow_data()?;
    if round.entropy_recorded() {
        let hash = match slot_hashes::first_after_retained(&data, round.close_slot) {
            Some(e) if e.slot == round.entropy_slot => e.hash,
            _ => [0u8; 32],
        };
        return Ok(EntropyProof::Known(Entropy {
            slot: round.entropy_slot,
            hash,
            seed: round.seed,
        }));
    }
    Ok(proven_entropy(&data, round.close_slot, |slot, hash| {
        round_seed(program_id, round_key, round.close_slot, slot, hash)
    }))
}

// --- record_round_entropy (§13.5.6a) -----------------------------------------------------

#[event_cpi]
#[derive(Accounts)]
pub struct RecordRoundEntropy<'info> {
    /// The round, at `["round", id]` with its stored bump.
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: pinned to the sysvar; parsed with a bounded reader.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

/// Anyone, never paused, unpaid: records a paid round's seed and entropy
/// slot while SlotHashes proves `s*` (from `close_slot + 2`, for about 512
/// slots), and changes nothing else. A round already recorded is left as it
/// is and the call succeeds, so that it can be sent alongside, or raced by,
/// `request_round_draw`, which records the same fields.
pub fn record_round_entropy(ctx: Context<RecordRoundEntropy>) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let round = &ctx.accounts.round;
    if round.entropy_recorded() {
        return Ok(());
    }
    // Only a paid round has a seed to come: an unpaid one has no close, and
    // a forfeited or refunded one no draw left to find.
    require!(
        round.status == RoundStatus::Paid,
        FadeError::WrongRoundStatus
    );
    let round_key = round.key();
    let entropy =
        round_entropy(ctx.program_id, &round_key, round, &ctx.accounts.slot_hashes)?.known()?;

    let round = &mut ctx.accounts.round;
    round.seed = entropy.seed;
    round.entropy_slot = entropy.slot;

    emit_cpi!(RoundEntropyRecorded {
        version: EVENT_VERSION,
        round: round_key,
        seed: entropy.seed,
        entropy_slot: entropy.slot,
        entropy_hash: entropy.hash,
    });
    Ok(())
}

// --- request_round_draw (§13.5.6) --------------------------------------------------------

pub fn request_round_draw_handler(ctx: Context<RequestRoundDraw>) -> Result<()> {
    // --- checks, in order ------------------------------------------------------------
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let round = &ctx.accounts.round;
    // `Paid` is the only state a request leaves: it moves the round to
    // `Requested`. A paid round was recorded in the counters by the
    // instruction that paid it; one that claims otherwise, or a side that is
    // neither, is inconsistent and refused (invariant 8): its tickets could
    // never leave the counters.
    require!(
        round.status == RoundStatus::Paid,
        FadeError::WrongRoundStatus
    );
    round.side()?;
    let clock = Clock::get()?;
    let pre_created = *ctx.accounts.request.owner == ORAO_VRF_ID;
    // The window, `close_slot + 2 ≤ slot ≤ close_slot + t_settle_slots`. After
    // it, only a request someone already created through ORAO is bound, once
    // ORAO fulfilled it with a non-zero randomness (checked with its data
    // below): once its seed is public, such a request may be fulfilled and
    // its outcome read before the expiry, and `expire_round` refuses to
    // forfeit a round whose request is fulfilled. Binding it late is what
    // lets that round still be settled. Nothing new is ever funded after the
    // window.
    let late = beacon::is_expired(clock.slot, round.close_slot, round.t_settle_slots);
    require!(
        beacon::in_request_window(clock.slot, round.close_slot, round.t_settle_slots)
            || (late && pre_created),
        FadeError::RoundRequestWindow
    );
    // s*: the first slot after the close, h*: its hash, and the seed: the
    // round's recorded ones if any, whatever SlotHashes holds, so that a
    // recorded round is bound late at any time. Otherwise from SlotHashes:
    // the window ends at `close_slot + t_settle_slots ≤ close_slot + 400`,
    // well inside the 512 slots it retains, so `s*` is the same whenever in
    // the window the request lands; after the window, a round never recorded
    // whose `s*` SlotHashes no longer proves is refused (`EntropyUnrecorded`):
    // its request address can no longer be derived, and `expire_round`
    // refunds it.
    let round_key = round.key();
    let entropy =
        round_entropy(ctx.program_id, &round_key, round, &ctx.accounts.slot_hashes)?.known()?;
    let seed = entropy.seed;
    let (expected, _) =
        Pubkey::find_program_address(&[orao_layout::REQUEST_SEED, seed.as_ref()], &ORAO_VRF_ID);
    require_keys_eq!(
        ctx.accounts.request.key(),
        expected,
        FadeError::WrongRandomnessAccount
    );
    let needed = if pre_created {
        // Anyone may create the request through ORAO once the seed is public,
        // with `request_v2` or the deprecated `request`; ORAO fulfils either
        // for this seed, which settlement checks. Nothing is funded: what
        // created it paid for it. Lamports sent to the address without ORAO
        // leave it system-owned, and ORAO's own initialisation takes it over
        // below, so a stray transfer cannot block the request.
        let data = ctx.accounts.request.try_borrow_data()?;
        let parsed = orao_layout::randomness(&data).ok_or(FadeError::WrongRandomnessAccount)?;
        // After the window, only a request fulfilled with a non-zero
        // randomness is bound: that is the round `expire_round` refuses to
        // forfeit, and binding it is its only way to settle. A pending one,
        // or one fulfilled with zero, leaves the round forfeitable either
        // way; bound, it would only move the request share from the
        // players' prepays to the binder and make it a draw cost every
        // forfeited ticket is charged, where the unbound expiry charges
        // nothing. Once ORAO fulfils a pending one, it is bound then.
        if late {
            require!(
                matches!(
                    parsed,
                    Randomness::Fulfilled { randomness, .. } if randomness != [0u8; 64]
                ),
                FadeError::RoundRequestWindow
            );
        }
        0
    } else {
        let state = orao_network(
            &ctx.accounts.orao_network_state,
            &ctx.accounts.orao_treasury,
        )?;
        let pending_rent = admission::pending_request_rent()?;
        // `fee + rent(PENDING_LEN) + request_share ≤ D_r`, the bound §13.4's
        // fact 1 rests on: no ticket is charged more than it prepaid. Compared
        // with the snapshot `draw_max`, never with what the round holds, so
        // that sponsorship cannot make a draw above the prefund chargeable
        // to the tickets.
        require!(
            beacon::request_fits(
                state.request_fee,
                pending_rent,
                round.request_share,
                round.draw_max
            ),
            FadeError::DrawUnderfunded
        );
        state
            .request_fee
            .checked_add(pending_rent)
            .ok_or(FadeError::MathOverflow)?
    };
    // The round pays `needed` and the request share out of the prepays and the
    // sponsorship it holds, and keeps its rent-exempt minimum. A paid round
    // holds `Σ prepay + S ≥ D_r ≥ needed + request_share` (§13.5.6); both are
    // checked so that inconsistent books fail here, before any lamport moves,
    // rather than paying the draw out of the round's rent.
    let spend = needed
        .checked_add(round.request_share)
        .ok_or(FadeError::MathOverflow)?;
    let held = round
        .prepaid
        .checked_add(round.sponsorship)
        .ok_or(FadeError::MathOverflow)?;
    require!(spend <= held, FadeError::DrawUnderfunded);
    let round_info = round.to_account_info();
    let floor = Rent::get()?.minimum_balance(round_info.data_len());
    let books = floor.checked_add(held).ok_or(FadeError::MathOverflow)?;
    require!(round_info.lamports() >= books, FadeError::MathOverflow);
    let request_share = round.request_share;
    let vrf_bump = round.vrf_bump;

    // --- lamports ----------------------------------------------------------------------
    let vrf_seeds: &[&[u8]] = &[ROUND_VRF_SEED, round_key.as_ref(), &[vrf_bump]];
    // Lamports anyone sent to `round_vrf` (`stray`) go to the round, so that
    // `round_vrf` holds exactly what the request takes.
    let stray = ctx.accounts.round_vrf.lamports();
    let mut funded = 0;
    if pre_created {
        if stray > 0 {
            send_back(&ctx, vrf_seeds, stray)?;
        }
    } else {
        // `needed` from the round to `round_vrf`. The round is a program
        // account with data, so this is a direct lamport move, which the
        // runtime only commits through a CPI naming the round: the stray
        // sweep, always sent here, even for 0 lamports, names both, so that
        // ORAO's CPI, which does not name the round, sees balanced accounts.
        let vrf_info = ctx.accounts.round_vrf.to_account_info();
        move_lamports(&round_info, &vrf_info, needed)?;
        send_back(&ctx, vrf_seeds, stray)?;
        let ix = orao_request_v2_ix(
            ctx.accounts.round_vrf.key(),
            ctx.accounts.orao_network_state.key(),
            ctx.accounts.orao_treasury.key(),
            ctx.accounts.request.key(),
            ctx.accounts.system_program.key(),
            seed,
        );
        invoke_signed(
            &ix,
            &[
                vrf_info,
                ctx.accounts.orao_network_state.to_account_info(),
                ctx.accounts.orao_treasury.to_account_info(),
                ctx.accounts.request.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.orao_program.to_account_info(),
            ],
            &[vrf_seeds],
        )?;
        // ORAO takes the fee and the pending rent, which leaves `round_vrf`
        // empty; over a request address someone pre-funded it takes less of
        // the rent. What it left goes back to the round at once, and
        // `funded` is what ORAO actually took, so that the draw cost of §13.4
        // is what the draw spent.
        let left = ctx.accounts.round_vrf.lamports();
        if left > 0 {
            send_back(&ctx, vrf_seeds, left)?;
        }
        funded = needed.checked_sub(left).ok_or(FadeError::MathOverflow)?;
    }
    move_lamports(
        &round_info,
        &ctx.accounts.caller.to_account_info(),
        request_share,
    )?;

    // --- the books ---------------------------------------------------------------------
    let request_key = ctx.accounts.request.key();
    let round = &mut ctx.accounts.round;
    round.status = RoundStatus::Requested;
    round.randomness = request_key;
    round.seed = seed;
    round.entropy_slot = entropy.slot;
    round.funded = funded;

    emit_cpi!(RoundDrawRequested {
        version: EVENT_VERSION,
        round: round_key,
        request: request_key,
        seed,
        entropy_slot: entropy.slot,
        entropy_hash: entropy.hash,
        funded,
        side: round.side,
        generation: round.generation,
    });
    Ok(())
}

/// Moves `lamports` from `round_vrf` back to the round, signed by the PDA.
fn send_back(ctx: &Context<RequestRoundDraw>, vrf_seeds: &[&[u8]], lamports: u64) -> Result<()> {
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.round_vrf.to_account_info(),
                to: ctx.accounts.round.to_account_info(),
            },
            &[vrf_seeds],
        ),
        lamports,
    )
}
