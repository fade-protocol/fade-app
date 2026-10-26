//! The ends of a round that never drew (Spec 08 §13.5.5, §13.5.8, §13.5.9):
//! `refund_round`, the way out of a round whose draw is never paid;
//! `expire_round`, the forfeiture of a closed round whose draw was not
//! requested or not fulfilled within `T_SETTLE` (or its refund, when its draw
//! can no longer be looked for); `return_round_ticket`, which then gives
//! each ticket back what it is owed, one at a time; and `sweep_round_vrf`
//! (§13.5.8a), which empties a round's `round_vrf` of what reached it after
//! its last drain.
//!
//! Both round-level instructions are O(1) in the round's tickets: they move
//! the round's aggregates out of the vault's books at once and leave each
//! ticket's own effects (its integrator's reservation, its tokens, its
//! lamports) to its return. A refund returns exactly what came in, the ticket
//! price to `refund_to` and every lamport to the payer, so no share is ever
//! paid back that the vault did not receive (Spec 09 §3). A forfeiture is
//! never a refund: the round's credits stay with the vault, its shares become
//! claimable, and each ticket's payer gets back its prepay less its charge of
//! the draw, as after a loss (Spec 02 §2.2, Spec 08 §13.10 point 10).
//!
//! The epoch counters: an unpaid round was never recorded, so a refund
//! touches them not; a forfeited round, or a paid one `expire_round`
//! refunds, leaves them in one step, with the side and generation recorded
//! when it became paid, so that it stops holding the strike; a return touches
//! them not; nor does a sweep. None of them is ever paused. Every check
//! precedes every transfer and every write.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{Mint, Token, TokenAccount};
use fade_math::beacon;
use fade_math::epoch::Side;
use fade_math::orao_layout::{self, Randomness};

use crate::constants::*;
use crate::errors::{FadeError, OrFade};
use crate::events::{RoundClosed, RoundExpired, RoundRefunded, RoundTicketReturned, RoundVrfSwept};
use crate::instructions::admission;
use crate::instructions::common::{
    is_usdc_account, move_lamports, vault_transfer, withheld_forfeit,
};
use crate::instructions::request_round_draw::{round_entropy, EntropyProof};
use crate::instructions::rounds::close_if_ended;
use crate::state::{
    Config, Integrator, Round, RoundStatus, RoundTicket, RoundTicketStatus, Ticket, Vault,
};

// --- refund_round (§13.5.5) ------------------------------------------------------------

#[event_cpi]
#[derive(Accounts)]
pub struct RefundRound<'info> {
    /// One of the round's participants (`participant`), or anyone when the
    /// round's draw no longer fits its prefund; nobody is paid to refund
    /// (Spec 09 §6).
    pub caller: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// The round, at `["round", id]` with its stored bump.
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: what makes `caller` a participant of the round: a `RoundTicket`
    /// of the round whose payer or funder is `caller`, or whose integrator is
    /// `caller`'s (`["integrator", caller]`). A sponsorship is not one: any
    /// amount, one lamport, makes a record, so it would let an outsider
    /// refund for one fee. Owner, discriminator and fields checked in the
    /// handler (`is_participant`); only read. Ignored for a round whose draw
    /// no longer fits its prefund, which anyone may refund.
    pub participant: UncheckedAccount<'info>,
    /// CHECK: ORAO's network state at the address derived from the pinned ORAO
    /// id, owner checked in the handler, as `join_round` reads it: its live fee
    /// tells whether the round's draw still fits its prefund (`request_fits`).
    #[account(seeds = [orao_layout::NETWORK_STATE_SEED], bump, seeds::program = ORAO_VRF_ID)]
    pub orao_network_state: UncheckedAccount<'info>,
}

/// Whether `caller` took part in round `id`, as `participant` shows: a
/// ticket of the round it paid for, funded or issued as integrator. The
/// record is the program's own (owner and discriminator) and stores the id
/// of its round. A `Sponsorship` never counts: `sponsor_round` takes any
/// non-zero amount and gives it all back at a refund, so a one-lamport
/// record would make anyone a participant for one fee, created and shown
/// in the same transaction. A sponsor gets its whole amount back from a
/// refund by anyone else, and has no need to end a round it can pay.
fn is_participant(participant: &AccountInfo, caller: &Pubkey, id: u64) -> Result<bool> {
    if *participant.owner != crate::ID {
        return Ok(false);
    }
    let data = participant.try_borrow_data()?;
    let Ok(t) = RoundTicket::try_deserialize(&mut &data[..]) else {
        return Ok(false);
    };
    if t.round != id {
        return Ok(false);
    }
    if t.payer == *caller || t.funder == *caller {
        return Ok(true);
    }
    let (integrator, _) =
        Pubkey::find_program_address(&[INTEGRATOR_SEED, caller.as_ref()], &crate::ID);
    Ok(t.integrator == integrator)
}

/// A participant, never paused, once the round has taken no join for
/// `refund_slots` (`refund_from() + refund_slots`), while its draw is unpaid
/// (anyone, once that window is open, when the draw no longer fits the
/// round's prefund: see below):
/// the round's reservation, credits and held shares leave the vault's books,
/// its ticket prices become owed back, and it takes no more joins. No token
/// or lamport moves: each ticket's return does that.
///
/// Both limits are this program's, against Spec 09 §6's "anyone, from the
/// first ticket": a refund costs one fee,
/// so an outsider could otherwise empty every slow round at 600 s and keep
/// the beacon from ever drawing at low volume; counted from the latest
/// join, a round still gathering tickets is never refundable, and a round
/// left idle can still be refunded by any of its participants. A round that
/// can never be drawn is refundable by anyone once the same window is open:
/// joins refuse it, so its participants are the only ones who could ever end
/// it, and their silence would refuse every beacon join until ORAO's fee fell
/// back.
pub fn refund_round(ctx: Context<RefundRound>) -> Result<()> {
    // --- checks, in order ------------------------------------------------------------
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let round = &ctx.accounts.round;
    match round.status {
        RoundStatus::Accepting => {}
        RoundStatus::Paid | RoundStatus::Requested | RoundStatus::Drawn => {
            return err!(FadeError::RoundPaid)
        }
        RoundStatus::Refunded | RoundStatus::Forfeited => return err!(FadeError::WrongRoundStatus),
    }
    // An unpaid round was never recorded in the epoch counters (§13.7): one
    // claiming otherwise is inconsistent, and refunding it would leave its
    // tickets in a counter nothing releases.
    require!(!round.counted, FadeError::WrongRoundStatus);
    let slot = Clock::get()?.slot;
    require!(
        beacon::refund_open(slot, round.refund_from(), round.refund_slots),
        FadeError::RefundWindow
    );
    // A round whose draw no longer fits its prefund, ORAO's live fee having
    // risen by more than the one fee of margin `draw_max` holds, is doomed:
    // `join_round` and `sponsor_round` refuse it (`DrawUnderfunded`) and
    // `request_round_draw` would, so it can never be paid, and a refund is
    // its only end. Joins being refused, nobody can become a participant any
    // more, so a round whose participants never act would refuse every
    // beacon join for good: anyone may refund it. Opening its exit takes
    // nothing from anyone, since a refund gives every ticket price and
    // every lamport back. The fee is read as `join_round` reads it, at the
    // address derived from the pinned ORAO id, owner checked.
    let participant = is_participant(
        &ctx.accounts.participant,
        &ctx.accounts.caller.key(),
        round.id,
    )?;
    if !participant {
        let fee = admission::orao_fee(&ctx.accounts.orao_network_state)?;
        let pending_rent = admission::pending_request_rent()?;
        require!(
            !beacon::request_fits(fee, pending_rent, round.request_share, round.draw_max),
            FadeError::NotRoundParticipant
        );
    }
    // Every ticket's price is its credit plus its two shares (§13.4 fact 3),
    // so the sums are too; the books below move `credits + shares` out and
    // `prices` in, and must leave the vault identity where it was.
    let shares = round
        .protocol_shares
        .checked_add(round.app_shares)
        .ok_or(FadeError::MathOverflow)?;
    require!(
        round.credits.checked_add(shares) == Some(round.prices),
        FadeError::MathOverflow
    );

    // --- the vault's books -----------------------------------------------------------
    // The settled assets, `total_assets − open_vault_credits`, do not move:
    // a refund is no result, and the settled price is unchanged.
    let id = round.id;
    let (credits, liability, prices) = (round.credits, round.liability, round.prices);
    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(credits)
        .ok_or(FadeError::MathOverflow)?;
    vault.open_vault_credits = vault
        .open_vault_credits
        .checked_sub(credits)
        .ok_or(FadeError::MathOverflow)?;
    vault.total_reserved_liability = vault
        .total_reserved_liability
        .checked_sub(liability)
        .ok_or(FadeError::MathOverflow)?;
    vault.beacon_shares_held = vault
        .beacon_shares_held
        .checked_sub(shares)
        .ok_or(FadeError::MathOverflow)?;
    vault.beacon_returns_owed = vault
        .beacon_returns_owed
        .checked_add(prices)
        .ok_or(FadeError::MathOverflow)?;
    // The unpaid round is the accepting one (at most one unpaid round, which
    // `accepting_round` names, invariant 4); the next join opens a new one.
    if vault.accepting_round == id {
        vault.accepting_round = 0;
    }

    let round = &mut ctx.accounts.round;
    round.status = RoundStatus::Refunded;

    emit_cpi!(RoundRefunded {
        version: EVENT_VERSION,
        round: round.key(),
        by: ctx.accounts.caller.key(),
        tickets: round.tickets,
        prices: round.prices,
        sponsorship: round.sponsorship,
    });
    Ok(())
}

// --- expire_round (§13.5.8) ------------------------------------------------------------

#[event_cpi]
#[derive(Accounts)]
pub struct ExpireRound<'info> {
    /// Anyone; unpaid itself, each forfeited ticket's return pays its
    /// settlement share.
    pub caller: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// The round, at `["round", id]` with its stored bump.
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// `["round-vrf", round]` with the round's stored bump: holds what ORAO
    /// gave back and anything sent to it since the request; drained to the
    /// round when the round was requested.
    #[account(mut, seeds = [ROUND_VRF_SEED, round.key().as_ref()], bump = round.vrf_bump)]
    pub round_vrf: SystemAccount<'info>,
    /// CHECK: the request bound by `request_round_draw` when the round was
    /// requested; when it was not, ORAO's request address for the round's
    /// seed, recorded or proven by SlotHashes; any account when neither (the
    /// round is then refunded, nothing read). Address, owner and state
    /// checked in the handler.
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: pinned to the sysvar; parsed with a bounded reader, only for a
    /// round never requested whose seed is not recorded.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// The vault's books of a forfeited round's tickets, in one step: what
/// `release_books` does to the vault for each of `n` tickets with no payout,
/// the integrators' part left to each return. The reservation and the
/// credits are released, the credits staying in the assets (forfeiture,
/// never refund); the tickets leave their epoch counter, their result booked
/// as an after-close gain when the counter calls for it; the price is
/// observed and a trip recorded against the round's snapshot.
fn forfeit_books(vault: &mut Vault, round: &Round, side: Side, now: i64) -> Result<()> {
    let price_before = vault.settled_price().or_fade()?;
    vault.total_reserved_liability = vault
        .total_reserved_liability
        .checked_sub(round.liability)
        .ok_or(FadeError::MathOverflow)?;
    vault.open_vault_credits = vault
        .open_vault_credits
        .checked_sub(round.credits)
        .ok_or(FadeError::MathOverflow)?;
    let mut counters = vault.counters();
    if side == Side::AfterClose && round.generation == counters.generation {
        vault
            .record_after_close_result(round.credits, 0)
            .or_fade()?;
    }
    counters
        .close_n(side, round.generation, round.tickets)
        .or_fade()?;
    vault.set_counters(&counters);
    let price_after = vault.settled_price().or_fade()?;
    let mut ring = vault.ring();
    ring.observe(now, price_before, price_after);
    if ring.tripped(price_after, round.drawdown_bps) {
        vault.drawdown_trip_ts = now;
    }
    vault.set_ring(&ring);

    // The protocol's shares become claimable now; the app shares at each
    // ticket's return, with the integrator's record it is the one to write.
    vault.beacon_shares_held = vault
        .beacon_shares_held
        .checked_sub(round.protocol_shares)
        .ok_or(FadeError::MathOverflow)?;
    vault.protocol_shares_accrued = vault
        .protocol_shares_accrued
        .checked_add(round.protocol_shares)
        .ok_or(FadeError::MathOverflow)?;
    Ok(())
}

/// Anyone, never paused, once `slot > close_slot + t_settle_slots`: a paid
/// round whose draw was never requested, or requested and never fulfilled,
/// forfeits as a whole. A fulfilled round must be settled (`AlreadyFulfilled`),
/// and so must a round never requested whose request someone created through
/// ORAO and ORAO fulfilled: `request_round_draw` binds it late.
///
/// A round never requested whose request can no longer be looked for, its
/// seed never recorded and SlotHashes no longer proving `s*`, is refunded,
/// never forfeited: someone may hold its fulfilled request and have waited
/// for the sysvar to forget it, and a forfeiture then would be theirs to
/// choose (Spec 08 invariant 10). The refund is the same whatever the draw
/// would have been; see `refund_expired`.
pub fn expire_round(ctx: Context<ExpireRound>) -> Result<()> {
    // --- checks, in order ------------------------------------------------------------
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let round = &ctx.accounts.round;
    let requested = match round.status {
        RoundStatus::Paid => false,
        RoundStatus::Requested => true,
        _ => return err!(FadeError::WrongRoundStatus),
    };
    // Recorded when it became paid: one claiming otherwise is inconsistent,
    // and its tickets would leave a counter that never held them (§13.7).
    let side = round.side()?;
    let slot = Clock::get()?.slot;
    require!(
        beacon::is_expired(slot, round.close_slot, round.t_settle_slots),
        FadeError::NotExpired
    );
    // `request_found`: an ORAO request exists for the round's seed; `checked`:
    // the program could look for one. Both are what the alarm reads.
    let (request_found, checked) = if requested {
        // The race between a settler and an expirer is decided by whichever
        // lands first, as on the direct path: a fulfilled request is settled.
        let randomness = &ctx.accounts.randomness;
        require_keys_eq!(
            randomness.key(),
            round.randomness,
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
        (true, true)
    } else {
        match unrequested_request(ctx.program_id, ctx.accounts)? {
            Some(looked) => looked,
            None => return refund_expired(ctx, side),
        }
    };

    // --- the draw's cost (§13.4) -----------------------------------------------------
    // Requested: what reached ORAO and the requester, less what `round_vrf`
    // holds (ORAO's refund of a request fulfilled with zero, or lamports sent
    // to it since the request), capped at `funded`. Never requested: nothing
    // was spent, and whatever sits on `round_vrf` stays there.
    let refund = if requested {
        ctx.accounts.round_vrf.lamports()
    } else {
        0
    };
    let draw_cost = if requested {
        beacon::draw_cost(round.funded, round.request_share, refund).or_fade()?
    } else {
        0
    };

    // --- the vault's books -----------------------------------------------------------
    let now = Clock::get()?.unix_timestamp;
    forfeit_books(&mut ctx.accounts.vault, round, side, now)?;
    // The forfeiture counted, and counted as withheld unless it is the
    // keepers' failure the alarm tells apart (`withheld_forfeit`).
    let vault = &mut ctx.accounts.vault;
    vault.rounds_forfeited = vault
        .rounds_forfeited
        .checked_add(1)
        .ok_or(FadeError::MathOverflow)?;
    if withheld_forfeit(requested, request_found, checked) {
        vault.forfeits_withheld = vault
            .forfeits_withheld
            .checked_add(1)
            .ok_or(FadeError::MathOverflow)?;
    }

    let forfeits_withheld = vault.forfeits_withheld;

    // --- lamports ----------------------------------------------------------------------
    if refund > 0 {
        let round_key = ctx.accounts.round.key();
        let vrf_seeds: &[&[u8]] = &[
            ROUND_VRF_SEED,
            round_key.as_ref(),
            &[ctx.accounts.round.vrf_bump],
        ];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.round_vrf.to_account_info(),
                    to: ctx.accounts.round.to_account_info(),
                },
                &[vrf_seeds],
            ),
            refund,
        )?;
    }

    // --- the round ---------------------------------------------------------------------
    let round = &mut ctx.accounts.round;
    round.status = RoundStatus::Forfeited;
    round.draw_cost = draw_cost;

    emit_cpi!(RoundExpired {
        version: EVENT_VERSION,
        round: round.key(),
        requested,
        request_found,
        checked,
        tickets: round.tickets,
        forfeited: round.credits,
        draw_cost,
        refund,
        side: Ticket::encode_side(side),
        generation: round.generation,
        forfeits_withheld,
        refunded: false,
    });
    Ok(())
}

/// The end of an expired round never requested whose request can no longer
/// be looked for: refunded, as `refund_round` refunds an unpaid round, and
/// out of the epoch counters, as a forfeiture leaves them. Nothing was spent
/// (`draw_cost = 0`), so each ticket's return gives back its price and its
/// whole prepay, and each sponsor its whole amount.
///
/// Why a refund. Anyone may have created the round's request through ORAO
/// once its seed was public and read its outcome; with the seed never
/// recorded and `s*` gone from SlotHashes, the program cannot tell whether
/// that request exists, so any end that depends on it is the choice of
/// whoever holds it. A forfeiture would let them void every round whose
/// players win; settling is impossible without the request. The refund is
/// the end that does not depend on the draw. It still leaves whoever held a
/// fulfilled request a choice between settling (bind it while `s*` is
/// proven) and this refund, which is why every round's seed is recorded at
/// `close_slot + 2` (`record_round_entropy`, `request_round_draw`) and this
/// path counts as a withheld draw for the alarm.
///
/// The books: credits and shares out of the vault and the ticket prices owed
/// back, as `refund_round`; the settled assets do not move (a refund is no
/// result), so no after-close result is booked and the ring is not observed;
/// the round's tickets leave their counter.
fn refund_expired(ctx: Context<ExpireRound>, side: Side) -> Result<()> {
    let round = &ctx.accounts.round;
    // Every ticket's price is its credit plus its two shares (§13.4 fact 3);
    // checked as `refund_round` checks it, before the books move.
    let shares = round
        .protocol_shares
        .checked_add(round.app_shares)
        .ok_or(FadeError::MathOverflow)?;
    require!(
        round.credits.checked_add(shares) == Some(round.prices),
        FadeError::MathOverflow
    );
    let (credits, liability, prices) = (round.credits, round.liability, round.prices);
    let (generation, tickets) = (round.generation, round.tickets);

    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(credits)
        .ok_or(FadeError::MathOverflow)?;
    vault.open_vault_credits = vault
        .open_vault_credits
        .checked_sub(credits)
        .ok_or(FadeError::MathOverflow)?;
    vault.total_reserved_liability = vault
        .total_reserved_liability
        .checked_sub(liability)
        .ok_or(FadeError::MathOverflow)?;
    vault.beacon_shares_held = vault
        .beacon_shares_held
        .checked_sub(shares)
        .ok_or(FadeError::MathOverflow)?;
    vault.beacon_returns_owed = vault
        .beacon_returns_owed
        .checked_add(prices)
        .ok_or(FadeError::MathOverflow)?;
    let mut counters = vault.counters();
    counters.close_n(side, generation, tickets).or_fade()?;
    vault.set_counters(&counters);
    // Not a forfeiture, but an expiry nobody could check: counted with the
    // ones a withheld draw may explain, which the alarm accounts for.
    vault.forfeits_withheld = vault
        .forfeits_withheld
        .checked_add(1)
        .ok_or(FadeError::MathOverflow)?;
    let forfeits_withheld = vault.forfeits_withheld;

    let round = &mut ctx.accounts.round;
    round.status = RoundStatus::Refunded;
    round.draw_cost = 0;

    emit_cpi!(RoundExpired {
        version: EVENT_VERSION,
        round: round.key(),
        requested: false,
        request_found: false,
        checked: false,
        tickets,
        forfeited: 0,
        draw_cost: 0,
        refund: 0,
        side: Ticket::encode_side(side),
        generation,
        forfeits_withheld,
        refunded: true,
    });
    Ok(())
}

/// The request of a round never requested, `Some((request_found, checked))`,
/// or `None` when it can no longer be looked for. Its seed is public from the
/// slot after the close, so anyone may have created its request through ORAO
/// and read its outcome before the expiry; a round forfeited then would be a
/// draw withheld by whoever chose not to bind it. The request address is
/// derived from the round's recorded seed, whatever SlotHashes holds, or,
/// not recorded, from SlotHashes while it proves `s*` (the expiry opens at
/// most 401 slots after the close, the sysvar retains 512): `randomness`
/// must be that address. A fulfilled request refuses the forfeiture
/// (`AlreadyFulfilled`: bind it late and settle), a pending one or one
/// fulfilled with zero is reported (`request_found`), an ORAO account that
/// does not parse is refused as on the requested path. Neither recorded nor
/// proven: `None`, nothing read, and the caller refunds the round.
fn unrequested_request(
    program_id: &Pubkey,
    accounts: &ExpireRound,
) -> Result<Option<(bool, bool)>> {
    let round = &accounts.round;
    let entropy = match round_entropy(program_id, &round.key(), round, &accounts.slot_hashes)? {
        EntropyProof::Known(e) => e,
        EntropyProof::Lost => return Ok(None),
        // The expiry opens at `close_slot + t_settle_slots + 1 ≥ close_slot + 2`,
        // when SlotHashes holds `s*`: inconsistent otherwise, and refused.
        EntropyProof::NotYet => return err!(FadeError::EntropyUnavailable),
    };
    let (expected, _) = Pubkey::find_program_address(
        &[orao_layout::REQUEST_SEED, entropy.seed.as_ref()],
        &ORAO_VRF_ID,
    );
    let randomness = &accounts.randomness;
    require_keys_eq!(
        randomness.key(),
        expected,
        FadeError::WrongRandomnessAccount
    );
    if *randomness.owner != ORAO_VRF_ID {
        // No request: lamports sent to the address leave it system-owned.
        return Ok(Some((false, true)));
    }
    let data = randomness.try_borrow_data()?;
    match orao_layout::randomness(&data) {
        Some(Randomness::Pending) => {}
        Some(Randomness::Fulfilled { randomness, .. }) if randomness == [0u8; 64] => {}
        Some(Randomness::Fulfilled { .. }) => return err!(FadeError::AlreadyFulfilled),
        None => return err!(FadeError::WrongRandomnessAccount),
    }
    Ok(Some((true, true)))
}

// --- sweep_round_vrf (§13.5.8a) --------------------------------------------------------

#[event_cpi]
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct SweepRoundVrf<'info> {
    /// Anyone; receives what a closed round's `round_vrf` holds, nothing
    /// otherwise.
    #[account(mut)]
    pub caller: Signer<'info>,
    /// Read for `next_round_id`: only a round the vault created is swept.
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: round `round_id`'s address, `["round", round_id]`. Read as a
    /// `Round` while the program owns it; any other owner means the round has
    /// closed (a round's address is never used again), and it is not read.
    #[account(mut, seeds = [ROUND_SEED, &round_id.to_le_bytes()], bump)]
    pub round: UncheckedAccount<'info>,
    /// `["round-vrf", round]`, signed by the program.
    #[account(mut, seeds = [ROUND_VRF_SEED, round.key().as_ref()], bump)]
    pub round_vrf: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Anyone, never paused, unpaid: every lamport on round `round_id`'s
/// `round_vrf` after its last drain leaves it. ORAO refunds a request's
/// pending rent to `round_vrf` when it fulfils it, which for a round forfeited
/// with its request still pending comes after `expire_round` drained it, and
/// anyone may send lamports to it at any time; no other instruction drains it
/// again.
///
/// Where they go. While the round exists, into the round, whose close pays
/// them to `rent_payer` with the round's dust; a `Paid` round's request would
/// sweep them there anyway. Once the round has closed, to the caller: the
/// tickets that paid the pending rent were charged it at their returns, and
/// with the round gone nothing on-chain names them or the rent payer, so the
/// sweep pays whoever sends it. A `Requested` round is refused
/// (`WrongRoundStatus`): what `round_vrf` holds then is the `refund` its first
/// settlement or its expiry deducts from the draw cost (§13.4), and moving it
/// would raise every ticket's charge. Nothing else reads `round_vrf`: no
/// outcome, charge, settlement or close depends on what this moves. Nothing
/// to sweep succeeds without moving or emitting anything, so that the sweep
/// can be sent ahead of a round's last return or reclaim, or raced.
pub fn sweep_round_vrf(ctx: Context<SweepRoundVrf>, round_id: u64) -> Result<()> {
    // --- checks, in order ------------------------------------------------------------
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    // A round the vault created, `1 ≤ id < next_round_id`: a later id names
    // no round yet, and lamports sent to its `round_vrf` are its request's to
    // sweep into it.
    require!(
        round_id != 0 && round_id < ctx.accounts.vault.next_round_id,
        FadeError::WrongRound
    );
    let round_info = ctx.accounts.round.to_account_info();
    let open = *round_info.owner == crate::ID;
    if open {
        let round = {
            let data = round_info.try_borrow_data()?;
            Round::try_deserialize(&mut &data[..])?
        };
        require!(round.id == round_id, FadeError::WrongRound);
        require!(
            round.status != RoundStatus::Requested,
            FadeError::WrongRoundStatus
        );
    }
    let lamports = ctx.accounts.round_vrf.lamports();
    if lamports == 0 {
        return Ok(());
    }

    // --- lamports ----------------------------------------------------------------------
    let round_key = round_info.key();
    let vrf_bump = ctx.bumps.round_vrf;
    let vrf_seeds: &[&[u8]] = &[ROUND_VRF_SEED, round_key.as_ref(), &[vrf_bump]];
    let to = if open {
        round_info
    } else {
        ctx.accounts.caller.to_account_info()
    };
    let to_key = to.key();
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.round_vrf.to_account_info(),
                to,
            },
            &[vrf_seeds],
        ),
        lamports,
    )?;

    emit_cpi!(RoundVrfSwept {
        version: EVENT_VERSION,
        round: round_key,
        round_id,
        to: to_key,
        lamports,
        closed: !open,
    });
    Ok(())
}

// --- return_round_ticket (§13.5.9) -----------------------------------------------------

#[event_cpi]
#[derive(Accounts)]
pub struct ReturnRoundTicket<'info> {
    /// Anyone; paid the ticket's settlement share for a forfeited ticket,
    /// nothing for a refunded one.
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// The ticket's round, at `["round", ticket.round]` with its stored bump.
    #[account(
        mut,
        seeds = [ROUND_SEED, &ticket.round.to_le_bytes()],
        bump = round.bump,
        constraint = round.id == ticket.round @ FadeError::WrongRound,
    )]
    pub round: Box<Account<'info, Round>>,
    /// The ticket's stored integrator.
    #[account(mut, address = ticket.integrator)]
    pub integrator: Box<Account<'info, Integrator>>,
    /// The ticket, at `["round-ticket", integrator, nonce]` with its stored bump.
    #[account(
        mut,
        seeds = [ROUND_TICKET_SEED, ticket.integrator.as_ref(), &ticket.nonce.to_le_bytes()],
        bump = ticket.bump,
    )]
    pub ticket: Box<Account<'info, RoundTicket>>,
    /// CHECK: the payer stored at the join: receives the prepay (less its
    /// charge after a forfeiture) and the ticket's rent.
    #[account(mut, address = ticket.payer)]
    pub payer: UncheckedAccount<'info>,
    /// CHECK: the funder's token account stored at the join, the only place
    /// a refunded ticket price goes; inspected before any transfer, and not
    /// read for a forfeited ticket.
    #[account(mut, address = ticket.refund_to @ FadeError::BeneficiaryMismatch)]
    pub refund_to: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYOUT_ESCROW_SEED], bump)]
    pub payout_escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: data-less PDA that owns the vault's token accounts.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ FadeError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: required when this return leaves the round with no ticket and
    /// no sponsorship, and then must be `round.rent_payer`
    /// (`RentReceiverRequired`); not read otherwise.
    #[account(mut)]
    pub rent_payer: Option<UncheckedAccount<'info>>,
}

/// Anyone, never paused: one ticket of a refunded or forfeited round leaves
/// it. Refunded: its ticket price back to `refund_to` (parked in
/// `payout_escrow` if it cannot receive), every lamport to its payer.
/// Forfeited: no token moves; its app share becomes its integrator's, its
/// volume counts, its payer gets its prepay less its charge and the rent, and
/// the caller its settlement share.
pub fn return_round_ticket(ctx: Context<ReturnRoundTicket>) -> Result<()> {
    // --- checks, in order ------------------------------------------------------------
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let ticket = &ctx.accounts.ticket;
    require!(
        ticket.status == RoundTicketStatus::Joined,
        FadeError::WrongTicketStatus
    );
    let round = &ctx.accounts.round;
    let refunded = match round.status {
        RoundStatus::Refunded => true,
        RoundStatus::Forfeited => false,
        _ => return err!(FadeError::WrongRoundStatus),
    };
    let price = ticket.price;
    // A refunded ticket is charged nothing; a forfeited one its share of the
    // draw that was spent, at most its prepay (§13.4 fact 1).
    let charge = if refunded {
        0
    } else {
        beacon::charge(round.draw_cost, round.sponsorship, round.prices, price).or_fade()?
    };
    let back = beacon::prepay_return(ticket.prepay, charge).or_fade()?;
    // The round keeps at least its rent-exempt minimum after this return,
    // and after a refund every other ticket's whole prepay as well: no
    // ticket of a refunded round is charged. Always true of consistent books
    // (§13.4 fact 2); checked so that an inconsistency fails here rather
    // than paying this payer out of what the round owes the others.
    let prepaid = round
        .prepaid
        .checked_sub(ticket.prepay)
        .ok_or(FadeError::MathOverflow)?;
    let round_info = round.to_account_info();
    let floor = Rent::get()?.minimum_balance(round_info.data_len());
    let keep = if refunded {
        floor.checked_add(prepaid).ok_or(FadeError::MathOverflow)?
    } else {
        floor
    };
    let left = round_info
        .lamports()
        .checked_sub(back)
        .ok_or(FadeError::MathOverflow)?;
    require!(left >= keep, FadeError::MathOverflow);
    // Read before any CPI: a transfer that could fail is never attempted.
    let parked =
        refunded && !is_usdc_account(&ctx.accounts.refund_to, &ctx.accounts.usdc_mint.key());

    // --- the books ---------------------------------------------------------------------
    let (liability, credit) = (ticket.liability, ticket.vault_credit);
    let (protocol_share, app_share) = (ticket.protocol_share, ticket.app_share);
    let integrator = &mut ctx.accounts.integrator;
    integrator.reserved_liability = integrator
        .reserved_liability
        .checked_sub(liability)
        .ok_or(FadeError::MathOverflow)?;
    integrator.open_tickets = integrator
        .open_tickets
        .checked_sub(1)
        .ok_or(FadeError::MathOverflow)?;
    let vault = &mut ctx.accounts.vault;
    if refunded {
        vault.beacon_returns_owed = vault
            .beacon_returns_owed
            .checked_sub(price)
            .ok_or(FadeError::MathOverflow)?;
    } else {
        // Forfeiture costs the player exactly a loss (§13.10 point 10): the
        // app share is claimable and the volume counts.
        integrator.app_shares_accrued = integrator
            .app_shares_accrued
            .checked_add(app_share)
            .ok_or(FadeError::MathOverflow)?;
        integrator.volume_total = integrator
            .volume_total
            .checked_add(price)
            .ok_or(FadeError::MathOverflow)?;
        vault.beacon_shares_held = vault
            .beacon_shares_held
            .checked_sub(app_share)
            .ok_or(FadeError::MathOverflow)?;
        vault.app_shares_owed = vault
            .app_shares_owed
            .checked_add(app_share)
            .ok_or(FadeError::MathOverflow)?;
        vault.volume_total = vault
            .volume_total
            .checked_add(price)
            .ok_or(FadeError::MathOverflow)?;
    }
    // The round's aggregates are those of its tickets still in it, as after
    // a settlement; `prices`, `sponsorship` and `usage` keep what the round
    // was paid and charged on.
    let round = &mut ctx.accounts.round;
    round.tickets = round
        .tickets
        .checked_sub(1)
        .ok_or(FadeError::MathOverflow)?;
    round.prepaid = prepaid;
    round.liability = round
        .liability
        .checked_sub(liability)
        .ok_or(FadeError::MathOverflow)?;
    round.credits = round
        .credits
        .checked_sub(credit)
        .ok_or(FadeError::MathOverflow)?;
    round.protocol_shares = round
        .protocol_shares
        .checked_sub(protocol_share)
        .ok_or(FadeError::MathOverflow)?;
    round.app_shares = round
        .app_shares
        .checked_sub(app_share)
        .ok_or(FadeError::MathOverflow)?;

    // --- tokens: the CPI before every direct lamport move ---------------------------
    if refunded {
        let destination = if parked {
            ctx.accounts.payout_escrow.to_account_info()
        } else {
            ctx.accounts.refund_to.to_account_info()
        };
        vault_transfer(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_usdc,
            destination,
            &ctx.accounts.usdc_mint,
            ctx.accounts.vault_authority.to_account_info(),
            ctx.accounts.config.vault_authority_bump,
            price,
        )?;
    }

    // --- lamports ----------------------------------------------------------------------
    let ticket_info = ctx.accounts.ticket.to_account_info();
    let payer_info = ctx.accounts.payer.to_account_info();
    let round_info = ctx.accounts.round.to_account_info();
    let settle_share = ctx.accounts.ticket.settle_share;
    let lamports = if parked {
        // The ticket keeps every lamport owed to its payer, its rent, its
        // settlement share and its prepay, until `claim_round_payout` closes
        // it: crediting a payer with less than an empty account's minimum
        // could fail the return (as for a parked payout, §13.5.7). Its
        // `settle_share` stays as stored: still held on it, never paid out.
        move_lamports(&round_info, &ticket_info, back)?;
        let ticket = &mut ctx.accounts.ticket;
        ticket.status = RoundTicketStatus::ReturnParked;
        ticket.payout = price;
        0
    } else {
        if !refunded {
            move_lamports(
                &ticket_info,
                &ctx.accounts.caller.to_account_info(),
                settle_share,
            )?;
        }
        move_lamports(&round_info, &payer_info, back)?;
        let rest = ticket_info.lamports();
        ctx.accounts.ticket.close(payer_info)?;
        back.checked_add(rest).ok_or(FadeError::MathOverflow)?
    };
    let closed = close_if_ended(&ctx.accounts.round, ctx.accounts.rent_payer.as_ref())?;

    let ticket_key = ctx.accounts.ticket.key();
    let round_key = ctx.accounts.round.key();
    emit_cpi!(RoundTicketReturned {
        version: EVENT_VERSION,
        ticket: ticket_key,
        round: round_key,
        refunded,
        price,
        lamports,
        parked,
        charge,
    });
    if let Some(lamports) = closed {
        emit_cpi!(RoundClosed {
            version: EVENT_VERSION,
            round: round_key,
            rent_payer: ctx.accounts.round.rent_payer,
            lamports,
        });
    }
    Ok(())
}
