//! `join_round` (Spec 08 §13.5.2): a beacon ticket, admitted on entry exactly
//! as `open_ticket` admits a direct one (the shared `admission` module), into
//! the round accepting tickets, or into the next round, which this join then
//! creates. Its shares stay in the vault, held on the round; its draw prepay
//! and any sponsorship it carries move into the round's lamports; the capacity
//! rule bounds the round's liability by the share of its draw that is paid,
//! each ticket's liability counted against its own per-ticket cap, and what
//! one join takes of a paid round by what that join pays.
//!
//! Every check precedes every transfer and every write (Spec 08 §13.5): a
//! refused join moves nothing. The round, the next round and the sponsorship
//! record are passed unchecked because their addresses are only known once
//! the round is resolved; each is matched here against the address the
//! program derives, never against one the caller states.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::{AccountDeserialize, AccountSerialize};
use anchor_spl::token::{Mint, Token, TokenAccount};
use fade_math::{beacon, orao_layout};

use crate::constants::*;
use crate::errors::{FadeError, OrFade};
use crate::events::{IntegratorCreated, RoundOpened, RoundPaid, RoundSponsored, TicketJoined};
use crate::instructions::admission;
use crate::instructions::common::{create_pda_account, is_usdc_account, user_transfer};
use crate::state::{
    Config, Integrator, PayoutTable, Round, RoundStatus, RoundTicket, RoundTicketStatus,
    Sponsorship, Vault,
};

#[event_cpi]
#[derive(Accounts)]
#[instruction(price: u64, app_share_bps: u64, nonce: u64, sponsorship: u64)]
pub struct JoinRound<'info> {
    /// The integrator's identity, as in `open_ticket` (Spec 07 §2).
    pub integrator_authority: Signer<'info>,
    /// Pays the ticket's rent, the draw prepay, the settlement share, the
    /// sponsorship and, if this join creates them, the round's and the
    /// sponsorship record's rent. Gets back what is not spent.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Owns `funder_usdc` and signs for the ticket price.
    pub funder: Signer<'info>,
    /// Where the ticket price comes from; stored as `refund_to`.
    #[account(mut, token::mint = usdc_mint, token::authority = funder)]
    pub funder_usdc: Box<Account<'info, TokenAccount>>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// Created by the integrator's first ticket on either path; never closed.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Integrator::INIT_SPACE,
        seeds = [INTEGRATOR_SEED, integrator_authority.key().as_ref()],
        bump,
    )]
    pub integrator: Box<Account<'info, Integrator>>,
    /// CHECK: required only when this join creates the integrator's record,
    /// then checked in the handler as a usable USDC account and stored. No
    /// share is paid at the join, so it is not read otherwise.
    pub share_account: Option<UncheckedAccount<'info>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    /// Any legacy-SPL USDC account; stored, and the only place a payout can go.
    #[account(token::mint = usdc_mint)]
    pub beneficiary: Box<Account<'info, TokenAccount>>,
    /// Owner and discriminator checked by Anchor; its address against its
    /// stored hash in the handler (`WrongPayoutTable`), in the check order.
    pub payout_table: Box<Account<'info, PayoutTable>>,
    /// Never `init_if_needed`: the address is nonce-scoped and one-shot.
    #[account(
        init,
        payer = payer,
        space = 8 + RoundTicket::INIT_SPACE,
        seeds = [ROUND_TICKET_SEED, integrator.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub ticket: Box<Account<'info, RoundTicket>>,
    /// CHECK: `["round", n]`; with `next_round`, must include the accepting
    /// round and the round this join creates, if any (round resolution).
    #[account(mut)]
    pub round: UncheckedAccount<'info>,
    /// CHECK: `["round", n + 1]`; see `round`.
    #[account(mut)]
    pub next_round: UncheckedAccount<'info>,
    /// CHECK: `["sponsorship", target round, payer]`, required when
    /// `sponsorship > 0`; matched against the derived address in the handler,
    /// created or topped up there.
    #[account(mut)]
    pub sponsorship_record: Option<UncheckedAccount<'info>>,
    /// CHECK: ORAO's network state at the address derived from the pinned ORAO
    /// id; read, owner checked, on every join: its fee sets a created round's
    /// prefund and must still fit the target round's.
    #[account(seeds = [orao_layout::NETWORK_STATE_SEED], bump, seeds::program = ORAO_VRF_ID)]
    pub orao_network_state: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ FadeError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// `["round", id]`.
pub fn round_address(id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ROUND_SEED, &id.to_le_bytes()], &crate::ID)
}

/// `["sponsorship", round, sponsor]`, `round` the `Round` account's address.
pub fn sponsorship_address(round: &Pubkey, sponsor: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SPONSORSHIP_SEED, round.as_ref(), sponsor.as_ref()],
        &crate::ID,
    )
}

/// Which of the two passed accounts is `address`; `WrongRound` if neither.
fn pick<'a, 'info>(
    address: &Pubkey,
    round: &'a AccountInfo<'info>,
    next_round: &'a AccountInfo<'info>,
) -> Result<&'a AccountInfo<'info>> {
    if round.key == address {
        Ok(round)
    } else if next_round.key == address {
        Ok(next_round)
    } else {
        err!(FadeError::WrongRound)
    }
}

/// The round a join lands in.
struct Target<'a, 'info> {
    info: &'a AccountInfo<'info>,
    /// Boxed: the handler may hold two rounds, and the frame is 4 KiB.
    round: Box<Round>,
    /// `Some(bump)` when this join creates the round.
    create: Option<u8>,
}

/// Round resolution (Spec 08 §13.5.2). Let `a = vault.accepting_round` and
/// `m = vault.next_round_id`: the target is round `a` if `a ≠ 0` and it
/// accepts joins (`Accepting`, or `Paid` with `slot < close_slot`); otherwise
/// round `m`, created by this join. The accepting round, whose state decides,
/// and the round to create must each be one of the two accounts passed. A
/// `Paid` accepting round this join does not fit is left for round `m` by
/// the handler (`next_round`), never refused for its fullness.
#[inline(never)]
fn resolve<'a, 'info>(
    vault: &Vault,
    round: &'a AccountInfo<'info>,
    next_round: &'a AccountInfo<'info>,
    slot: u64,
) -> Result<Target<'a, 'info>> {
    let a = vault.accepting_round;
    // A vault whose `next_round_id` was never initialised (a missed
    // migration) creates no round 0, which would read as "no accepting round".
    require!(vault.next_round_id != 0, FadeError::WrongRound);
    if a != 0 {
        require!(a < vault.next_round_id, FadeError::WrongRound);
        let (address, _) = round_address(a);
        let info = pick(&address, round, next_round)?;
        // A round the program no longer owns has closed: it took no ticket
        // after its draw, and nothing at its address can be a round again.
        if *info.owner == crate::ID {
            let accepting = {
                let data = info.try_borrow_data()?;
                Round::try_deserialize(&mut &data[..])?
            };
            require!(accepting.id == a, FadeError::WrongRound);
            if accepting.accepts_joins(slot) {
                return Ok(Target {
                    info,
                    round: Box::new(accepting),
                    create: None,
                });
            }
        }
    }
    next_round_target(vault, round, next_round, slot)
}

/// Round `m = vault.next_round_id`, which this join creates: one of the two
/// accounts passed, never used before.
#[inline(never)]
fn next_round_target<'a, 'info>(
    vault: &Vault,
    round: &'a AccountInfo<'info>,
    next_round: &'a AccountInfo<'info>,
    slot: u64,
) -> Result<Target<'a, 'info>> {
    let m = vault.next_round_id;
    require!(m != 0, FadeError::WrongRound);
    let (address, bump) = round_address(m);
    let info = pick(&address, round, next_round)?;
    // Never used before: at most a system account someone pre-funded.
    require_keys_eq!(
        *info.owner,
        anchor_lang::system_program::ID,
        FadeError::WrongRound
    );
    Ok(Target {
        info,
        round: Box::new(Round {
            version: ACCOUNT_VERSION,
            bump,
            vrf_bump: 0,
            status: RoundStatus::Accepting,
            id: m,
            rent_payer: Pubkey::default(),
            first_slot: slot,
            paid_slot: 0,
            close_slot: 0,
            threshold: 0,
            draw_max: 0,
            round_k: 0,
            min_price: 0,
            settle_share: 0,
            request_share: 0,
            tick_slots: 0,
            refund_slots: 0,
            t_settle_slots: 0,
            drawdown_bps: 0,
            prices: 0,
            sponsorship: 0,
            liability: 0,
            credits: 0,
            protocol_shares: 0,
            app_shares: 0,
            prepaid: 0,
            usage: 0,
            tickets: 0,
            sponsors: 0,
            counted: false,
            side: 0,
            generation: 0,
            randomness: Pubkey::default(),
            seed: [0; 32],
            entropy_slot: 0,
            funded: 0,
            draw_cost: 0,
            drawn_randomness: [0; 64],
            last_join_slot: slot,
            _reserved: [0; 24],
        }),
        create: Some(bump),
    })
}

/// The sponsorship record a join or `sponsor_round` writes: `Some(bump)` in
/// `create` when the record does not exist yet.
pub(crate) struct Record<'info> {
    pub(crate) info: AccountInfo<'info>,
    pub(crate) record: Sponsorship,
    pub(crate) create: Option<u8>,
}

/// The sponsorship record at `["sponsorship", round, sponsor]`: the account
/// passed must be that address (`ConstraintSeeds`, as Anchor's `seeds` would
/// say); the program's record of this round and sponsor if it exists, else a
/// system account, possibly pre-funded, to create.
pub(crate) fn sponsorship_record<'info>(
    info: AccountInfo<'info>,
    round: &Pubkey,
    round_id: u64,
    sponsor: &Pubkey,
) -> Result<Record<'info>> {
    let (address, bump) = sponsorship_address(round, sponsor);
    require_keys_eq!(
        info.key(),
        address,
        anchor_lang::error::ErrorCode::ConstraintSeeds
    );
    if *info.owner == crate::ID {
        let existing = {
            let data = info.try_borrow_data()?;
            Sponsorship::try_deserialize(&mut &data[..])?
        };
        require!(
            existing.round == round_id && existing.sponsor == *sponsor,
            anchor_lang::error::ErrorCode::ConstraintSeeds
        );
        return Ok(Record {
            info,
            record: existing,
            create: None,
        });
    }
    require_keys_eq!(
        *info.owner,
        anchor_lang::system_program::ID,
        anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram
    );
    Ok(Record {
        info,
        record: Sponsorship {
            version: ACCOUNT_VERSION,
            bump,
            round: round_id,
            sponsor: *sponsor,
            amount: 0,
        },
        create: Some(bump),
    })
}

/// A round as a join reads it: snapshotted if this join creates it (Spec 09
/// §3: every parameter it runs on, at the live ORAO fee and rent; later
/// governance changes reach only rounds created after them), with its terms.
/// Its draw must still fit its prefund: a round whose draw no longer does,
/// ORAO's fee having risen by more than one fee since its creation, cannot
/// be requested (`request_round_draw` checks the same against `draw_max`),
/// so it could only forfeit once paid. Refusing the join leaves it unpaid,
/// refunded in full, rather than admitting tickets the program can see are
/// lost.
#[inline(never)]
fn prepare<'a, 'info>(
    mut target: Target<'a, 'info>,
    payer: &Pubkey,
    params: &crate::state::RiskParams,
    fee: u64,
    pending_rent: u64,
) -> Result<(Target<'a, 'info>, beacon::Terms)> {
    if target.create.is_some() {
        require!(
            (1..=u64::from(MAX_ROUND_K)).contains(&params.round_k),
            FadeError::InvalidParams
        );
        let round = &mut target.round;
        round.vrf_bump =
            Pubkey::find_program_address(&[ROUND_VRF_SEED, target.info.key.as_ref()], &crate::ID).1;
        round.rent_payer = *payer;
        round.threshold = params.beacon_threshold;
        round.draw_max =
            beacon::prefund(fee, pending_rent, params.crank_request_lamports).or_fade()?;
        round.round_k = u8::try_from(params.round_k).map_err(|_| FadeError::InvalidParams)?;
        round.min_price = params.beacon_min_price;
        round.settle_share = params.crank_round_settle_lamports;
        round.request_share = params.crank_request_lamports;
        round.tick_slots = params.tick_slots;
        round.refund_slots = params.refund_slots;
        round.t_settle_slots = params.t_settle_slots;
        round.drawdown_bps = params.drawdown_bps;
    }
    require!(
        beacon::request_fits(
            fee,
            pending_rent,
            target.round.request_share,
            target.round.draw_max
        ),
        FadeError::DrawUnderfunded
    );
    let terms = target.round.terms();
    require!(terms.is_valid(), FadeError::InvalidParams);
    Ok((target, terms))
}

/// What admission and the capacity rule make of a join into one round:
/// `book` is `None` when the round has no room for it (`RoundCapacity`).
struct Joined {
    w: fade_math::risk::Ticket,
    admitted: fade_math::risk::Admission,
    entry: beacon::Entry,
    book: Option<beacon::Book>,
}

/// Steps 7 and 8 against `round`: admission exactly as `open_ticket` admits
/// (the shared `admission` module), with the round's minimum ticket price,
/// then the ticket's entry at the round's terms and the capacity rule, the
/// join's own price and sponsorship counted toward the payment. Reads only.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn admit_into(
    accounts: &JoinRound,
    round: &Round,
    terms: &beacon::Terms,
    params: &crate::state::RiskParams,
    gate: &admission::Gate,
    price: u64,
    max_m: u64,
    app_share_bps: u64,
    vault_margin_bps: u64,
    sponsorship: u64,
) -> Result<Joined> {
    let mut math = params.to_math();
    math.min_price = round.min_price;
    let (w, admitted) = admission::admit(
        &accounts.vault,
        &accounts.integrator,
        &math,
        price,
        max_m,
        app_share_bps,
        vault_margin_bps,
        gate.halved,
    )?;
    let entry = beacon::entry(
        terms,
        &w,
        &admitted,
        app_share_bps,
        params.protocol_share_bps,
    )
    .or_fade()?;
    let book = round.book().join(terms, &entry, sponsorship).or_fade()?;
    Ok(Joined {
        w,
        admitted,
        entry,
        book,
    })
}

pub fn join_round_handler(
    ctx: Context<JoinRound>,
    price: u64,
    app_share_bps: u64,
    nonce: u64,
    sponsorship: u64,
) -> Result<()> {
    // --- 1. remaining accounts -------------------------------------------------
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let config = &ctx.accounts.config;
    let params = config.params;

    // --- 2. pauses: both paths, then the beacon alone --------------------------
    require!(
        !config.is_paused(Config::PAUSE_TICKETS | Config::PAUSE_ROUNDS),
        FadeError::Paused
    );
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let slot = clock.slot;

    // --- 3. the integrator -------------------------------------------------------
    let integrator_key = ctx.accounts.integrator.key();
    let created = ctx.accounts.integrator.version == 0;
    {
        let integrator = &mut ctx.accounts.integrator;
        if created {
            require!(
                !config.is_paused(Config::PAUSE_NEW_INTEGRATORS),
                FadeError::Paused
            );
            let share = ctx
                .accounts
                .share_account
                .as_ref()
                .ok_or(FadeError::ShareAccountRequired)?;
            require!(
                is_usdc_account(share, &ctx.accounts.usdc_mint.key()),
                FadeError::WrongMint
            );
            admission::enrol(
                integrator,
                ctx.accounts.integrator_authority.key(),
                share.key(),
                ctx.bumps.integrator,
                now,
            );
        }
        require!(!integrator.paused, FadeError::IntegratorPaused);
        require!(nonce == integrator.next_nonce, FadeError::WrongNonce);
    }

    // --- 4. the payout table -----------------------------------------------------
    let table = &ctx.accounts.payout_table;
    let table_key = table.key();
    let expected = Pubkey::create_program_address(
        &[PAYOUT_TABLE_SEED, table.hash.as_ref(), &[table.bump]],
        &crate::ID,
    )
    .map_err(|_| error!(FadeError::WrongPayoutTable))?;
    require_keys_eq!(table_key, expected, FadeError::WrongPayoutTable);
    let margin = admission::check_margin(table.lhs, app_share_bps, &params)?;
    let max_m = table.max_m;

    // --- 5. round resolution -----------------------------------------------------
    let round_info = ctx.accounts.round.to_account_info();
    let next_round_info = ctx.accounts.next_round.to_account_info();
    // ORAO's live fee and the pending request's rent, read on every join: a
    // round snapshots them at creation, and every join checks the draw still
    // fits that snapshot (`prepare`).
    let fee = admission::orao_fee(&ctx.accounts.orao_network_state)?;
    let pending_rent = admission::pending_request_rent()?;
    let resolved = resolve(&ctx.accounts.vault, &round_info, &next_round_info, slot)?;
    let (mut target, mut terms) = prepare(
        resolved,
        &ctx.accounts.payer.key(),
        &params,
        fee,
        pending_rent,
    )?;

    // --- 6. the drawdown ring ----------------------------------------------------
    let gate = admission::drawdown_gate(&ctx.accounts.vault, params.drawdown_bps, now)?;

    // --- 7. admission, with the round's minimum ticket price, and 8. the
    // capacity rule ------------------------------------------------------------------
    let mut joined = admit_into(
        ctx.accounts,
        &target.round,
        &terms,
        &params,
        &gate,
        price,
        max_m,
        app_share_bps,
        margin.vault_margin_bps,
        sponsorship,
    )?;
    if joined.book.is_none() && target.create.is_none() && target.round.status == RoundStatus::Paid
    {
        // A paid round this join does not fit is full for it: the join goes
        // to round `m`, which it creates, and the full round keeps its own
        // close slot, request and settlement. Refusing it instead would let
        // whoever fills a paid round first refuse every other join until its
        // close. Filling it costs its payment, not one ticket: every join,
        // the round paid or not, takes at most its own share of it
        // (`beacon::within_join_share`, whose `h · k` floor is the paying
        // join's alone), and a join refused for that would
        // be refused by an empty round `m` at the same terms, so only a round
        // filled by joins that paid for its room sends the next ones on.
        // The paid round leaves `accepting_round`, so at most one unpaid
        // round still exists: the one this join creates.
        let next = next_round_target(&ctx.accounts.vault, &round_info, &next_round_info, slot)?;
        (target, terms) = prepare(next, &ctx.accounts.payer.key(), &params, fee, pending_rent)?;
        joined = admit_into(
            ctx.accounts,
            &target.round,
            &terms,
            &params,
            &gate,
            price,
            max_m,
            app_share_bps,
            margin.vault_margin_bps,
            sponsorship,
        )?;
    }
    let Target {
        info: target_info,
        mut round,
        create: create_round,
    } = target;
    let Joined {
        w,
        admitted,
        entry,
        book,
    } = joined;
    let book = book.ok_or(FadeError::RoundCapacity)?;
    let round_key = target_info.key();

    // The sponsorship this join carries: its record, at the address derived
    // from the round the join lands in and the payer, created or topped up
    // below. Looked up once that round is known, so that a join moved to the
    // next round names that round's record.
    let record = if sponsorship > 0 {
        let info = ctx
            .accounts
            .sponsorship_record
            .as_ref()
            .ok_or(anchor_lang::error::ErrorCode::AccountNotEnoughKeys)?
            .to_account_info();
        Some(sponsorship_record(
            info,
            &round_key,
            round.id,
            &ctx.accounts.payer.key(),
        )?)
    } else {
        None
    };
    let settle_share = round.settle_share;
    let to_round = entry
        .prepay
        .checked_add(sponsorship)
        .ok_or(FadeError::MathOverflow)?;
    let shares = entry
        .protocol_share
        .checked_add(entry.app_share)
        .ok_or(FadeError::MathOverflow)?;

    // --- 9. the epoch counters (§13.7) --------------------------------------------
    // A round enters the counters when it becomes paid, every ticket it holds
    // on the side `now` falls on, as a direct ticket at its open: the seed
    // needs the hash of a slot after the close, which is after this one, so
    // no result of the round can be known yet, and a round recorded `Before`
    // holds the strike for every one of its tickets. A join into a round
    // already paid adds its ticket to the counter the round's tickets are in
    // now, and a round whose tickets are counted before the live close takes
    // no join at or after that close (`RoundEpochClosed`): the tickets an
    // epoch's price contains are those opened before its close, on the beacon
    // path as on the direct one (Spec 01 §3.5). Computed here so that a round
    // whose counter cannot be found (an inconsistent `Paid` round) is refused
    // before anything moves.
    let became_paid = round.status == RoundStatus::Accepting && book.is_paid(&terms);
    let mut counters = ctx.accounts.vault.counters();
    let recorded = if became_paid {
        Some(counters.open_n(now, book.tickets).or_fade()?)
    } else {
        if round.status == RoundStatus::Paid {
            counters
                .join_n(now, round.side()?, round.generation, 1)
                .or_fade()?;
        }
        None
    };

    // --- every check has passed: accounts, tokens, lamports ------------------------
    let payer_info = ctx.accounts.payer.to_account_info();
    let system = &ctx.accounts.system_program;
    let id_bytes = round.id.to_le_bytes();
    if let Some(bump) = create_round {
        create_pda_account(
            &payer_info,
            target_info,
            system,
            8 + Round::INIT_SPACE,
            &[ROUND_SEED, &id_bytes, &[bump]],
        )?;
    }
    if let Some(r) = record.as_ref() {
        if let Some(bump) = r.create {
            let payer_key = ctx.accounts.payer.key();
            create_pda_account(
                &payer_info,
                &r.info,
                system,
                8 + Sponsorship::INIT_SPACE,
                &[
                    SPONSORSHIP_SEED,
                    round_key.as_ref(),
                    payer_key.as_ref(),
                    &[bump],
                ],
            )?;
        }
    }
    user_transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.funder_usdc,
        ctx.accounts.vault_usdc.to_account_info(),
        &ctx.accounts.usdc_mint,
        ctx.accounts.funder.to_account_info(),
        price,
    )?;
    for (to, lamports) in [
        (target_info.clone(), to_round),
        (ctx.accounts.ticket.to_account_info(), settle_share),
    ] {
        if lamports == 0 {
            continue;
        }
        system_program::transfer(
            CpiContext::new(
                system.key(),
                system_program::Transfer {
                    from: payer_info.clone(),
                    to,
                },
            ),
            lamports,
        )?;
    }

    // --- the books ---------------------------------------------------------------------
    let vault = &mut ctx.accounts.vault;
    let integrator = &mut ctx.accounts.integrator;
    admission::book(vault, integrator, &admitted, &gate.ring, created)?;
    vault.set_counters(&counters);
    vault.beacon_shares_held = vault
        .beacon_shares_held
        .checked_add(shares)
        .ok_or(FadeError::MathOverflow)?;
    if create_round.is_some() {
        vault.accepting_round = round.id;
        vault.next_round_id = round.id.checked_add(1).ok_or(FadeError::MathOverflow)?;
    }

    round.set_book(&book);
    // The refund window counts from the latest join (`Round::refund_from`).
    round.last_join_slot = slot;
    let new_record = record.as_ref().is_some_and(|r| r.create.is_some());
    if new_record {
        round.sponsors = round
            .sponsors
            .checked_add(1)
            .ok_or(FadeError::MathOverflow)?;
    }
    if let Some((side, generation)) = recorded {
        round.status = RoundStatus::Paid;
        round.paid_slot = slot;
        round.close_slot = beacon::close_slot(slot, round.tick_slots).or_fade()?;
        round.record(side, generation);
    }
    {
        let mut data = target_info.try_borrow_mut_data()?;
        round.try_serialize(&mut &mut data[..])?;
    }
    if let Some(r) = record {
        let mut s = r.record;
        s.amount = s
            .amount
            .checked_add(sponsorship)
            .ok_or(FadeError::MathOverflow)?;
        let mut data = r.info.try_borrow_mut_data()?;
        s.try_serialize(&mut &mut data[..])?;
    }

    let ticket = &mut ctx.accounts.ticket;
    ticket.version = ACCOUNT_VERSION;
    ticket.bump = ctx.bumps.ticket;
    ticket.status = RoundTicketStatus::Joined;
    ticket.round = round.id;
    ticket.integrator = integrator_key;
    ticket.nonce = nonce;
    ticket.payer = ctx.accounts.payer.key();
    ticket.funder = ctx.accounts.funder.key();
    ticket.refund_to = ctx.accounts.funder_usdc.key();
    ticket.beneficiary = ctx.accounts.beneficiary.key();
    ticket.payout_table = table_key;
    ticket.price = price;
    ticket.vault_credit = entry.vault_credit;
    ticket.payout_max = w.payout_max;
    ticket.liability = entry.liability;
    ticket.protocol_share = entry.protocol_share;
    ticket.app_share = entry.app_share;
    ticket.prepay = entry.prepay;
    ticket.settle_share = settle_share;
    ticket.payout = 0;

    // --- events --------------------------------------------------------------------------
    if created {
        emit_cpi!(IntegratorCreated {
            version: EVENT_VERSION,
            integrator: integrator_key,
            authority: ctx.accounts.integrator_authority.key(),
            share_account: ctx.accounts.integrator.share_account,
        });
    }
    if create_round.is_some() {
        emit_cpi!(RoundOpened {
            version: EVENT_VERSION,
            round: round_key,
            id: round.id,
            rent_payer: round.rent_payer,
            threshold: round.threshold,
            draw_max: round.draw_max,
            round_k: round.round_k,
            min_price: round.min_price,
            settle_share: round.settle_share,
            tick_slots: round.tick_slots,
            refund_slots: round.refund_slots,
            first_slot: round.first_slot,
            request_share: round.request_share,
            t_settle_slots: round.t_settle_slots,
            drawdown_bps: round.drawdown_bps,
        });
    }
    emit_cpi!(TicketJoined {
        version: EVENT_VERSION,
        ticket: ctx.accounts.ticket.key(),
        round: round_key,
        integrator: integrator_key,
        nonce,
        beneficiary: ctx.accounts.beneficiary.key(),
        refund_to: ctx.accounts.funder_usdc.key(),
        payout_table: table_key,
        price,
        vault_credit: entry.vault_credit,
        payout_max: w.payout_max,
        reserved_liability: entry.liability,
        cap: admitted.cap,
        usage: entry.usage,
        protocol_share: entry.protocol_share,
        app_share: entry.app_share,
        prepay: entry.prepay,
        slot,
        payer: ctx.accounts.payer.key(),
        funder: ctx.accounts.funder.key(),
        settle_share,
    });
    if sponsorship > 0 {
        emit_cpi!(RoundSponsored {
            version: EVENT_VERSION,
            round: round_key,
            sponsor: ctx.accounts.payer.key(),
            lamports: sponsorship,
            total: round.sponsorship,
        });
    }
    if became_paid {
        emit_cpi!(RoundPaid {
            version: EVENT_VERSION,
            round: round_key,
            paid_slot: round.paid_slot,
            close_slot: round.close_slot,
            prices: round.prices,
            sponsorship: round.sponsorship,
        });
    }
    Ok(())
}
