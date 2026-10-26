//! `sponsor_round` and `reclaim_sponsorship` (Spec 08 §13.5.3, §13.5.10):
//! lamports anyone adds to a round's draw until its request, and their return
//! once the round has ended. Sponsorship only ever adds payment, so it never
//! breaks the capacity rule; it cannot be withdrawn before the round's end,
//! comes back pro rata after a draw or a forfeiture, and in full after a refund.
//!
//! `reclaim_sponsorship` is never paused; `sponsor_round` refuses an
//! `Accepting` round while `PAUSE_TICKETS` or `PAUSE_ROUNDS` is set (§13.7),
//! so that a pause leaves an unpaid round to its full refund. Neither pays
//! anyone. Sponsorship is lamports held on the round, outside every USDC book;
//! the one write `sponsor_round` makes to `Vault` is the epoch counters, when
//! its sponsorship pays the round (§13.7).

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::AccountSerialize;
use fade_math::{beacon, orao_layout};

use crate::constants::*;
use crate::errors::{FadeError, OrFade};
use crate::events::{RoundClosed, RoundPaid, RoundSponsored, SponsorshipReclaimed};
use crate::instructions::admission;
use crate::instructions::common::{create_pda_account, move_lamports};
use crate::instructions::join_round::sponsorship_record;
use crate::instructions::rounds::close_if_ended;
use crate::state::{Config, Round, RoundStatus, Sponsorship, Vault};

#[event_cpi]
#[derive(Accounts)]
pub struct SponsorRound<'info> {
    /// Pays the sponsorship and, for a new record, its rent; gets back what
    /// the draw does not use, and the rent, through `reclaim_sponsorship`.
    #[account(mut)]
    pub sponsor: Signer<'info>,
    /// Its epoch counters record the round's tickets if this sponsorship pays it.
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// The round, at `["round", id]` with its stored bump.
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: `["sponsorship", round, sponsor]`, matched against the derived
    /// address, created or topped up in the handler by the same function as
    /// `join_round`'s record (`ConstraintSeeds`, `AccountOwnedByWrongProgram`).
    #[account(mut)]
    pub sponsorship: UncheckedAccount<'info>,
    /// CHECK: ORAO's network state at the address derived from the pinned ORAO
    /// id, owner checked when read: the round's draw must still fit its
    /// prefund, as for a join (`DrawUnderfunded`).
    #[account(seeds = [orao_layout::NETWORK_STATE_SEED], bump, seeds::program = ORAO_VRF_ID)]
    pub orao_network_state: UncheckedAccount<'info>,
    /// The config, at `["config"]` with its stored bump: its pause flags.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub system_program: Program<'info, System>,
}

pub fn sponsor_round(ctx: Context<SponsorRound>, lamports: u64) -> Result<()> {
    // --- checks, in order ------------------------------------------------------------
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    require!(lamports > 0, FadeError::ZeroAmount);
    let round = &ctx.accounts.round;
    // `Paid` is "not yet requested": the request moves the round to `Requested`.
    require!(
        matches!(round.status, RoundStatus::Accepting | RoundStatus::Paid),
        FadeError::RoundNotAccepting
    );
    // While joins are paused (`PAUSE_TICKETS`, `PAUSE_ROUNDS`), an unpaid
    // round can only end in its full refund; a sponsorship that paid it would
    // push it towards a request the pause is there to avoid (a withheld ORAO
    // draw, a beacon defect) and turn that refund into a forfeiture. So an
    // `Accepting` round takes no sponsorship while paused, paying or not. A
    // `Paid` round can no longer be refunded: a top-up only lowers what its
    // tickets are charged, and stays open.
    if round.status == RoundStatus::Accepting {
        require!(
            !ctx.accounts
                .config
                .is_paused(Config::PAUSE_TICKETS | Config::PAUSE_ROUNDS),
            FadeError::Paused
        );
    }
    // A round whose draw no longer fits its prefund (ORAO's fee rose by more
    // than one fee since its creation) cannot be requested: `request_round_draw`
    // compares the same live cost with `draw_max`, which sponsorship does not
    // raise. Paying such a round would turn the refund its tickets would get
    // into a forfeiture, so it takes no sponsorship, as it takes no join.
    let fee = admission::orao_fee(&ctx.accounts.orao_network_state)?;
    let pending_rent = admission::pending_request_rent()?;
    require!(
        beacon::request_fits(fee, pending_rent, round.request_share, round.draw_max),
        FadeError::DrawUnderfunded
    );
    let terms = round.terms();
    require!(terms.is_valid(), FadeError::InvalidParams);
    let round_key = round.key();
    let sponsor_key = ctx.accounts.sponsor.key();
    let record = sponsorship_record(
        ctx.accounts.sponsorship.to_account_info(),
        &round_key,
        round.id,
        &sponsor_key,
    )?;
    let book = round.book().sponsor(lamports).or_fade()?;
    let amount = record
        .record
        .amount
        .checked_add(lamports)
        .ok_or(FadeError::MathOverflow)?;
    let sponsors = if record.create.is_some() {
        round
            .sponsors
            .checked_add(1)
            .ok_or(FadeError::MathOverflow)?
    } else {
        round.sponsors
    };
    let clock = Clock::get()?;
    let slot = clock.slot;
    let became_paid = round.status == RoundStatus::Accepting && book.is_paid(&terms);
    let close_slot = if became_paid {
        beacon::close_slot(slot, round.tick_slots).or_fade()?
    } else {
        round.close_slot
    };
    // A round this sponsorship pays enters the epoch counters now, every
    // ticket on the side the time falls on, as in `join_round`: no result of
    // it can be known before its close, which is after this slot (§13.7).
    let mut counters = ctx.accounts.vault.counters();
    let recorded = if became_paid {
        Some(
            counters
                .open_n(clock.unix_timestamp, book.tickets)
                .or_fade()?,
        )
    } else {
        None
    };

    // --- lamports: the record's rent, then the sponsorship -----------------------
    let sponsor_info = ctx.accounts.sponsor.to_account_info();
    let system = &ctx.accounts.system_program;
    if let Some(bump) = record.create {
        create_pda_account(
            &sponsor_info,
            &record.info,
            system,
            8 + Sponsorship::INIT_SPACE,
            &[
                SPONSORSHIP_SEED,
                round_key.as_ref(),
                sponsor_key.as_ref(),
                &[bump],
            ],
        )?;
    }
    system_program::transfer(
        CpiContext::new(
            system.key(),
            system_program::Transfer {
                from: sponsor_info,
                to: ctx.accounts.round.to_account_info(),
            },
        ),
        lamports,
    )?;

    // --- the books ---------------------------------------------------------------------
    {
        let mut s = record.record;
        s.amount = amount;
        let mut data = record.info.try_borrow_mut_data()?;
        s.try_serialize(&mut &mut data[..])?;
    }
    let round = &mut ctx.accounts.round;
    round.set_book(&book);
    round.sponsors = sponsors;
    if let Some((side, generation)) = recorded {
        round.status = RoundStatus::Paid;
        round.paid_slot = slot;
        round.close_slot = close_slot;
        round.record(side, generation);
        ctx.accounts.vault.set_counters(&counters);
    }

    emit_cpi!(RoundSponsored {
        version: EVENT_VERSION,
        round: round_key,
        sponsor: sponsor_key,
        lamports,
        total: book.sponsorship,
    });
    if became_paid {
        emit_cpi!(RoundPaid {
            version: EVENT_VERSION,
            round: round_key,
            paid_slot: slot,
            close_slot,
            prices: book.prices,
            sponsorship: book.sponsorship,
        });
    }
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct ReclaimSponsorship<'info> {
    /// Anyone: the return goes to the sponsor whoever sends it.
    pub caller: Signer<'info>,
    /// The round, at `["round", id]` with its stored bump.
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// The record, at `["sponsorship", round, sponsor]` with its stored bump,
    /// of this round; closed here, its rent to the sponsor.
    #[account(
        mut,
        seeds = [SPONSORSHIP_SEED, round.key().as_ref(), sponsor.key().as_ref()],
        bump = sponsorship.bump,
        has_one = sponsor,
        constraint = sponsorship.round == round.id @ FadeError::WrongRound,
    )]
    pub sponsorship: Box<Account<'info, Sponsorship>>,
    /// CHECK: the record's stored sponsor (`has_one`); receives the return
    /// and the record's lamports.
    #[account(mut)]
    pub sponsor: UncheckedAccount<'info>,
    /// CHECK: required when this reclaim leaves the round with no ticket and
    /// no sponsorship, and then must be `round.rent_payer`
    /// (`RentReceiverRequired`); not read otherwise.
    #[account(mut)]
    pub rent_payer: Option<UncheckedAccount<'info>>,
}

pub fn reclaim_sponsorship(ctx: Context<ReclaimSponsorship>) -> Result<()> {
    // --- checks, in order ------------------------------------------------------------
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let round = &ctx.accounts.round;
    // After a draw or a forfeiture the sponsors are charged first, `min(S, C)`,
    // and get the rest back pro rata, floored; after a refund nothing was
    // drawn and every sponsor gets its whole amount (§13.4). `C` is 0 for a
    // round forfeited without a request.
    let drawn = match round.status {
        RoundStatus::Drawn | RoundStatus::Forfeited => true,
        RoundStatus::Refunded => false,
        _ => return err!(FadeError::WrongRoundStatus),
    };
    let amount = ctx.accounts.sponsorship.amount;
    let back =
        beacon::sponsor_return(round.draw_cost, round.sponsorship, amount, drawn).or_fade()?;
    // What the round still owes its tickets, at most `prepaid`, stays on it:
    // whenever a sponsor gets anything back (`S > C` or a refund) no ticket is
    // charged, so every remaining ticket is owed its whole prepay. With the
    // books consistent this always holds (§13.4 fact 2); it is checked so that
    // an inconsistency fails here rather than paying a sponsor with a
    // ticket's lamports.
    let round_info = round.to_account_info();
    if back > 0 {
        let floor = Rent::get()?.minimum_balance(round_info.data_len());
        let keep = floor
            .checked_add(round.prepaid)
            .ok_or(FadeError::MathOverflow)?;
        let left = round_info
            .lamports()
            .checked_sub(back)
            .ok_or(FadeError::MathOverflow)?;
        require!(left >= keep, FadeError::MathOverflow);
    }
    let sponsors = round
        .sponsors
        .checked_sub(1)
        .ok_or(FadeError::MathOverflow)?;

    // --- lamports: the return, then the record's rent ----------------------------
    let sponsor_info = ctx.accounts.sponsor.to_account_info();
    move_lamports(&round_info, &sponsor_info, back)?;
    ctx.accounts.sponsorship.close(sponsor_info)?;

    // --- the round ---------------------------------------------------------------------
    let round_key = ctx.accounts.round.key();
    let sponsor_key = ctx.accounts.sponsor.key();
    ctx.accounts.round.sponsors = sponsors;
    let closed = close_if_ended(&ctx.accounts.round, ctx.accounts.rent_payer.as_ref())?;

    emit_cpi!(SponsorshipReclaimed {
        version: EVENT_VERSION,
        round: round_key,
        sponsor: sponsor_key,
        lamports: back,
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
