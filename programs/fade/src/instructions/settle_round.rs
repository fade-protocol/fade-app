//! `settle_round_tickets` (Spec 08 §13.5.7): the grouped settlement of a drawn
//! round, and its first settlement's finalisation; and `claim_round_payout`
//! (§13.5.11), the delivery of what a settlement or a return parked.
//!
//! One round's randomness decides every one of its tickets, each on its own
//! address (`beacon::outcome_preimage`), so a ticket's outcome never depends
//! on the batch it is settled in or its place in it. A batch names its
//! tickets in remaining accounts, `count` groups of `ticket`, `integrator`,
//! `payer`, `payout_table`, then `beneficiary` if and only if bit `i` of
//! `wins` is set; every account of a group is checked against the ticket's
//! own stored keys, so one batch can mix integrators, payers and payout
//! tables, and no account a caller chooses is trusted for anything the
//! ticket stores.
//!
//! The instruction runs in three passes, so that every check precedes every
//! transfer and no lamport moved directly reaches a CPI unbalanced:
//!
//! 1. checks and books, in memory: the round, its randomness, the layout,
//!    then each group in order, its outcome, payout, charge and book
//!    effects;
//! 2. the CPIs: `round_vrf` drained to the round at the first settlement
//!    (the only CPI naming the round, made before any direct move of the
//!    round's lamports), then each payout from `vault_usdc`;
//! 3. the direct lamport moves, which no later CPI names, the tickets
//!    closed or parked, the round closed if it has ended; then the events.
//!
//! Pass 1 writes each integrator's books back to its account as it goes, a
//! data change of a Fade-owned account that no CPI of pass 2 names; any
//! later failure reverts it with the rest of the transaction.
//!
//! Settlement must always succeed for a fulfilled round: an unsettled ticket
//! holds its round's epoch counter, and so a strike. Nothing here reads a
//! live parameter; a beneficiary that cannot receive has its payout parked
//! in `payout_escrow`, and a parked ticket keeps every lamport owed to its
//! payer until `claim_round_payout` closes it, so that no settlement credits
//! a payer with less than a rent-exempt account's minimum.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_lang::{AccountDeserialize, AccountSerialize};
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use fade_math::orao_layout::{self, Randomness};
use fade_math::payout_table::{self, Summary};
use fade_math::{beacon, select, MAX_OUTCOMES};

use crate::constants::*;
use crate::errors::{FadeError, OrFade};
use crate::events::{RoundClosed, RoundDrawn, RoundPayoutClaimed, RoundTicketSettled};
use crate::instructions::common::{close_account, is_usdc_account, move_lamports, vault_transfer};
use crate::instructions::rounds::close_if_ended;
use crate::instructions::settle::{release_books, Released};
use crate::state::{
    Config, Integrator, PayoutTable, Round, RoundStatus, RoundTicket, RoundTicketStatus, Vault,
};

#[event_cpi]
#[derive(Accounts)]
pub struct SettleRoundTickets<'info> {
    /// Anyone, once the round's randomness is fulfilled; receives each
    /// settled ticket's settlement share.
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// The round, at `["round", id]` with its stored bump.
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// `["round-vrf", round]` with the round's stored bump: holds ORAO's rent
    /// refund after the fulfilment, drained by the first settlement.
    #[account(mut, seeds = [ROUND_VRF_SEED, round.key().as_ref()], bump = round.vrf_bump)]
    pub round_vrf: SystemAccount<'info>,
    /// CHECK: the request bound by `request_round_draw`, never another;
    /// owner, kind, seed and value checked in the handler at the first
    /// settlement, the only one that reads it.
    #[account(address = round.randomness @ FadeError::WrongRandomnessAccount)]
    pub randomness: UncheckedAccount<'info>,
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
    pub system_program: Program<'info, System>,
    /// CHECK: required when this batch leaves the round with no ticket and no
    /// sponsorship, and then must be `round.rent_payer`
    /// (`RentReceiverRequired`); not read otherwise.
    #[account(mut)]
    pub rent_payer: Option<UncheckedAccount<'info>>,
}

/// `SHA256(beacon::outcome_preimage(program, round, ticket, R, i))`: the
/// `i`-th draw of a beacon ticket's outcome (Spec 08 §13.4).
pub fn round_outcome_hash(
    program: &Pubkey,
    round: &Pubkey,
    ticket: &Pubkey,
    randomness: &[u8; 64],
    i: u8,
) -> [u8; 32] {
    let preimage = beacon::outcome_preimage(
        &program.to_bytes(),
        &round.to_bytes(),
        &ticket.to_bytes(),
        randomness,
        i,
    );
    solana_sha256_hasher::hashv(&[&preimage]).to_bytes()
}

/// The fulfilled randomness of the round's request: owned by ORAO, a request
/// of either kind, for the round's seed, non-zero.
fn fulfilled(info: &AccountInfo, seed: &[u8; 32]) -> Result<[u8; 64]> {
    require_keys_eq!(*info.owner, ORAO_VRF_ID, FadeError::WrongRandomnessAccount);
    let data = info.try_borrow_data()?;
    match orao_layout::randomness(&data) {
        Some(Randomness::Fulfilled {
            seed: stored,
            randomness,
        }) => {
            require!(stored == *seed, FadeError::WrongRandomnessAccount);
            require!(randomness != [0u8; 64], FadeError::NotFulfilled);
            Ok(randomness)
        }
        Some(Randomness::Pending) => err!(FadeError::NotFulfilled),
        None => err!(FadeError::WrongRandomnessAccount),
    }
}

/// Bit `i` of `wins`.
fn won(wins: u32, i: u8) -> bool {
    wins.checked_shr(u32::from(i)).unwrap_or(0) & 1 == 1
}

/// A Fade account of type `T` read from a remaining account: owner and
/// discriminator, `MalformedBatch` for anything else.
fn read<T: AccountDeserialize>(info: &AccountInfo) -> Result<T> {
    require_keys_eq!(*info.owner, crate::ID, FadeError::MalformedBatch);
    let data = info.try_borrow_data()?;
    T::try_deserialize(&mut &data[..]).map_err(|_| error!(FadeError::MalformedBatch))
}

/// What settlement needs of a payout table: its address, its cumulative
/// bounds and its multipliers. One is allocated per batch, before the loop,
/// and reloaded in place whenever a group names another table, so that a
/// batch's heap does not grow with the number of distinct tables it names
/// (the bump allocator never frees). Groups on the same table one after the
/// other read it once.
struct Table {
    /// The table loaded, `None` before the first.
    key: Option<Pubkey>,
    summary: Summary,
    m: [u64; MAX_OUTCOMES],
}

impl Table {
    fn empty() -> Self {
        Table {
            key: None,
            summary: Summary {
                lhs: 0,
                max_m: 0,
                cum: [0; MAX_OUTCOMES],
                len: 0,
            },
            m: [0; MAX_OUTCOMES],
        }
    }

    /// Reloads `self` from the stored payout table `info`, validated as at
    /// registration. On the heap's single `Table`, never on a new one; its
    /// own stack frame holds the account's copy.
    #[inline(never)]
    fn load(&mut self, info: &AccountInfo) -> Result<()> {
        let stored: PayoutTable = read(info)?;
        let len = usize::from(stored.len);
        let mut outcomes = [payout_table::Outcome { p: 0, m: 0 }; MAX_OUTCOMES];
        for (o, b) in outcomes.iter_mut().zip(stored.outcomes.iter()) {
            *o = payout_table::Outcome { p: b.p, m: b.m };
        }
        let outcomes = outcomes.get(..len).ok_or(FadeError::MalformedBatch)?;
        self.summary = payout_table::validate(outcomes).or_fade()?;
        for (m, o) in self.m.iter_mut().zip(outcomes.iter()) {
            *m = o.m;
        }
        self.key = Some(info.key());
        Ok(())
    }
}

/// One ticket the batch settles: what pass 1 decided, for passes 2 and 3.
/// Kept lean, the ticket's own fields re-read where needed: the program's
/// heap is 32 KiB, never freed, and a batch of `MAX_ROUND_BATCH` tickets
/// must fit in it with its accounts and CPIs. Every heap buffer of the
/// instruction is allocated once at its final size, before the loop: none
/// grows by doubling, which would leave its old buffers allocated.
struct Settled {
    /// Indices into the remaining accounts.
    ticket: usize,
    payer: usize,
    beneficiary: Option<usize>,
    key: Pubkey,
    integrator: Pubkey,
    settle_share: u64,
    outcome: u8,
    payout: u64,
    /// The payout goes to `payout_escrow`: the beneficiary cannot receive it.
    pending: bool,
    charge: u64,
    /// `prepay − charge`, from the round to the payer.
    back: u64,
}

/// Emits events as `emit_cpi!` does, the same instruction to the same
/// program signed by the same event authority, but through one buffer
/// reused for every event of a batch: `emit_cpi!` allocates about 700 bytes
/// of heap per event, which the bump allocator never frees, and a batch
/// emits one event per ticket.
struct Emitter<'info> {
    authority: AccountInfo<'info>,
    ix: Instruction,
}

impl<'info> Emitter<'info> {
    fn new(authority: AccountInfo<'info>) -> Self {
        let key = *authority.key;
        Emitter {
            authority,
            ix: Instruction {
                program_id: crate::ID,
                accounts: vec![AccountMeta::new_readonly(key, true)],
                data: Vec::with_capacity(EVENT_BUFFER),
            },
        }
    }

    fn emit<E: anchor_lang::Event>(&mut self, event: &E) -> Result<()> {
        self.ix.data.clear();
        self.ix
            .data
            .extend_from_slice(anchor_lang::event::EVENT_IX_TAG_LE);
        self.ix.data.extend_from_slice(E::DISCRIMINATOR);
        event.serialize(&mut self.ix.data)?;
        invoke_signed(
            &self.ix,
            std::slice::from_ref(&self.authority),
            &[&[EVENT_AUTHORITY_SEED, &[crate::EVENT_AUTHORITY_AND_BUMP.1]]],
        )
        .map_err(Into::into)
    }
}

/// Pays the batch's payouts out of `vault_usdc` as `vault_transfer` does, a
/// `transfer_checked` signed by the vault authority, but through one
/// instruction reused for every payout: `vault_transfer` allocates its
/// instruction's accounts and data on the heap for each transfer (about
/// 220 bytes), which the bump allocator never frees, and a batch makes one
/// per winner. Only the destination and the amount change between payouts.
struct Payouts<'info> {
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    seed: [u8; 1],
    ix: Instruction,
}

impl<'info> Payouts<'info> {
    /// `TransferChecked`'s tag and the byte range of its amount.
    const TAG: u8 = 12;
    const AMOUNT: std::ops::Range<usize> = 1..9;

    fn new(
        from: AccountInfo<'info>,
        mint: &Account<'info, Mint>,
        authority: AccountInfo<'info>,
        authority_bump: u8,
    ) -> Result<Self> {
        // The token library's own encoding, checked to be the layout the
        // payouts rewrite: four accounts, the destination third; the tag,
        // the amount, the decimals.
        let ix = token::spl_token::instruction::transfer_checked(
            &token::ID,
            from.key,
            &mint.key(),
            from.key,
            authority.key,
            &[],
            0,
            mint.decimals,
        )?;
        require!(
            ix.accounts.len() == 4
                && ix.data.len() == 10
                && ix.data.first() == Some(&Self::TAG)
                && ix.data.get(9) == Some(&mint.decimals),
            FadeError::MathOverflow
        );
        Ok(Payouts {
            from,
            mint: mint.to_account_info(),
            authority,
            seed: [authority_bump],
            ix,
        })
    }

    /// `amount` to `to`; nothing for a zero amount, as `vault_transfer`.
    fn pay(&mut self, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        self.ix
            .accounts
            .get_mut(2)
            .ok_or(FadeError::MathOverflow)?
            .pubkey = *to.key;
        self.ix
            .data
            .get_mut(Self::AMOUNT)
            .ok_or(FadeError::MathOverflow)?
            .copy_from_slice(&amount.to_le_bytes());
        invoke_signed(
            &self.ix,
            &[
                self.from.clone(),
                self.mint.clone(),
                to.clone(),
                self.authority.clone(),
            ],
            &[&[VAULT_AUTHORITY_SEED, &self.seed]],
        )
        .map_err(Into::into)
    }
}

/// Bytes reserved for one event's instruction data: the tag, the
/// discriminator and the largest event emitted here.
const EVENT_BUFFER: usize = 8 + 8 + 128;
/// The event authority's seed, as `#[event_cpi]` derives it.
const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";

pub fn settle_round_tickets_handler<'info>(
    ctx: Context<'info, SettleRoundTickets<'info>>,
    count: u8,
    wins: u32,
) -> Result<()> {
    let rem = ctx.remaining_accounts;
    let program = *ctx.program_id;
    let a = &mut *ctx.accounts;

    // --- the round ------------------------------------------------------------------
    let first = match a.round.status {
        RoundStatus::Requested => true,
        RoundStatus::Drawn => false,
        _ => return err!(FadeError::WrongRoundStatus),
    };
    // A requested round was recorded in the epoch counters when it became
    // paid; one claiming otherwise is inconsistent, its tickets could never
    // leave the counters, and it is refused (invariant 8).
    let side = a.round.side()?;
    let generation = a.round.generation;
    // The request is read once, at the first settlement, which keeps `R` on
    // the round; every later batch reads it there. A drawn round has no other
    // way out (`expire_round` refuses it), so its liveness must not depend on
    // ORAO's account staying alive, ORAO's and in a layout parsed here
    // (invariant 10). Only the account's address is still checked, by
    // `SettleRoundTickets::randomness`.
    let r = if first {
        let r = fulfilled(&a.randomness, &a.round.seed)?;
        a.round.drawn_randomness = r;
        r
    } else {
        a.round.drawn_randomness
    };

    // --- the layout -------------------------------------------------------------------
    require!(
        (1..=MAX_ROUND_BATCH).contains(&count),
        FadeError::MalformedBatch
    );
    require!(
        wins.checked_shr(u32::from(count)).unwrap_or(0) == 0,
        FadeError::MalformedBatch
    );
    let expected = usize::from(count)
        .checked_mul(ROUND_GROUP_ACCOUNTS)
        .and_then(|n| n.checked_add(usize::try_from(wins.count_ones()).ok()?))
        .ok_or(FadeError::MathOverflow)?;
    require!(rem.len() == expected, FadeError::MalformedBatch);

    // --- the first settlement fixes the draw's cost (§13.4) ----------------------------
    // `round_vrf` holds ORAO's refund of the pending rent, and anything sent
    // to it since the request; the formula caps what comes back at `funded`.
    let refund = if first {
        let refund = a.round_vrf.lamports();
        a.round.draw_cost =
            beacon::draw_cost(a.round.funded, a.round.request_share, refund).or_fade()?;
        a.round.status = RoundStatus::Drawn;
        refund
    } else {
        0
    };
    let draw_cost = a.round.draw_cost;

    // --- pass 1: every group, checks and books ----------------------------------------
    let round_key = a.round.key();
    let mint = a.usdc_mint.key();
    let now = Clock::get()?.unix_timestamp;
    let mut seen: Vec<Pubkey> = Vec::with_capacity(usize::from(count));
    let mut table = Box::new(Table::empty());
    let mut settled: Vec<Settled> = Vec::with_capacity(usize::from(count));
    let mut paid_back: u64 = 0;
    let mut at = 0usize;
    for i in 0..count {
        let won_bit = won(wins, i);
        let start = at;
        let len = ROUND_GROUP_ACCOUNTS
            .checked_add(usize::from(won_bit))
            .ok_or(FadeError::MathOverflow)?;
        at = at.checked_add(len).ok_or(FadeError::MathOverflow)?;
        let group = rem.get(start..at).ok_or(FadeError::MalformedBatch)?;
        let [ticket_info, integrator_info, payer_info, table_info, ..] = group else {
            return err!(FadeError::MalformedBatch);
        };

        // The ticket. One already closed, by an earlier batch, is skipped:
        // two keepers racing on a round lose a ticket, not a transaction.
        let key = ticket_info.key();
        require!(!seen.contains(&key), FadeError::MalformedBatch);
        seen.push(key);
        if *ticket_info.owner == system_program::ID && ticket_info.data_is_empty() {
            continue;
        }
        require!(ticket_info.is_writable, FadeError::MalformedBatch);
        let ticket: RoundTicket = read(ticket_info)?;
        let address = Pubkey::create_program_address(
            &[
                ROUND_TICKET_SEED,
                ticket.integrator.as_ref(),
                &ticket.nonce.to_le_bytes(),
                &[ticket.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(FadeError::MalformedBatch))?;
        require_keys_eq!(address, key, FadeError::MalformedBatch);
        require!(ticket.round == a.round.id, FadeError::MalformedBatch);
        match ticket.status {
            RoundTicketStatus::Joined => {}
            // Settled by an earlier batch, its payout parked: nothing to do.
            RoundTicketStatus::PayoutParked => continue,
            RoundTicketStatus::ReturnParked => return err!(FadeError::MalformedBatch),
        }

        // Its integrator, payer and payout table: the stored ones.
        require_keys_eq!(
            integrator_info.key(),
            ticket.integrator,
            FadeError::MalformedBatch
        );
        require!(integrator_info.is_writable, FadeError::MalformedBatch);
        require_keys_eq!(payer_info.key(), ticket.payer, FadeError::MalformedBatch);
        require!(payer_info.is_writable, FadeError::MalformedBatch);
        require_keys_eq!(
            table_info.key(),
            ticket.payout_table,
            FadeError::MalformedBatch
        );
        if table.key != Some(ticket.payout_table) {
            table.load(table_info)?;
        }

        // The outcome: the round's randomness on the ticket's own address,
        // rejection-sampled as on the direct path (Spec 02 §6).
        let draw = select::draw(
            |k| round_outcome_hash(&program, &round_key, &key, &r, k),
            OUTCOME_ROUNDS,
        )
        .ok_or(FadeError::DrawFailed)?;
        let index = select::outcome(draw, &table.summary.cum, table.summary.len)
            .ok_or(FadeError::DrawFailed)?;
        let m = *table.m.get(index).ok_or(FadeError::DrawFailed)?;
        let payout = payout_table::payout(ticket.price, m).or_fade()?;
        // The reservation covered the worst case at the join; a payout above
        // it would leave the books short.
        require!(payout <= ticket.payout_max, FadeError::MathOverflow);
        require!((payout > 0) == won_bit, FadeError::MalformedBatch);
        let beneficiary = if won_bit {
            let b = group
                .get(ROUND_GROUP_ACCOUNTS)
                .ok_or(FadeError::MalformedBatch)?;
            require_keys_eq!(b.key(), ticket.beneficiary, FadeError::MalformedBatch);
            require!(b.is_writable, FadeError::MalformedBatch);
            Some(
                start
                    .checked_add(ROUND_GROUP_ACCOUNTS)
                    .ok_or(FadeError::MathOverflow)?,
            )
        } else {
            None
        };
        // Read before any CPI: a transfer that could fail is never attempted.
        let pending = match beneficiary.and_then(|b| rem.get(b)) {
            Some(b) => !is_usdc_account(b, &mint),
            None => false,
        };

        // The draw's charge, at most the prepay (§13.4 fact 1).
        let charge = beacon::charge(draw_cost, a.round.sponsorship, a.round.prices, ticket.price)
            .or_fade()?;
        let back = beacon::prepay_return(ticket.prepay, charge).or_fade()?;
        paid_back = paid_back.checked_add(back).ok_or(FadeError::MathOverflow)?;

        // The books: the direct path's release, then the beacon's own. The
        // integrator is read and written back here, group by group, so that
        // a batch naming many integrators holds none of them on the heap;
        // a later group of the same integrator reads what this one wrote.
        let mut integrator: Integrator = read(integrator_info)?;
        release_books(
            &mut a.vault,
            &mut integrator,
            Released {
                liability: ticket.liability,
                vault_credit: ticket.vault_credit,
                payout,
                side,
                generation,
                drawdown_bps: a.round.drawdown_bps,
            },
            now,
        )?;
        let shares = ticket
            .protocol_share
            .checked_add(ticket.app_share)
            .ok_or(FadeError::MathOverflow)?;
        let vault = &mut a.vault;
        vault.beacon_shares_held = vault
            .beacon_shares_held
            .checked_sub(shares)
            .ok_or(FadeError::MathOverflow)?;
        vault.protocol_shares_accrued = vault
            .protocol_shares_accrued
            .checked_add(ticket.protocol_share)
            .ok_or(FadeError::MathOverflow)?;
        vault.app_shares_owed = vault
            .app_shares_owed
            .checked_add(ticket.app_share)
            .ok_or(FadeError::MathOverflow)?;
        vault.volume_total = vault
            .volume_total
            .checked_add(ticket.price)
            .ok_or(FadeError::MathOverflow)?;
        integrator.app_shares_accrued = integrator
            .app_shares_accrued
            .checked_add(ticket.app_share)
            .ok_or(FadeError::MathOverflow)?;
        integrator.volume_total = integrator
            .volume_total
            .checked_add(ticket.price)
            .ok_or(FadeError::MathOverflow)?;
        {
            let mut data = integrator_info.try_borrow_mut_data()?;
            integrator.try_serialize(&mut &mut data[..])?;
        }
        // The round's aggregates of the tickets still in it (invariant 2);
        // `prices`, `sponsorship` and `usage` stay what the draw was charged
        // on.
        let round = &mut a.round;
        round.tickets = round
            .tickets
            .checked_sub(1)
            .ok_or(FadeError::MathOverflow)?;
        round.prepaid = round
            .prepaid
            .checked_sub(ticket.prepay)
            .ok_or(FadeError::MathOverflow)?;
        round.liability = round
            .liability
            .checked_sub(ticket.liability)
            .ok_or(FadeError::MathOverflow)?;
        round.credits = round
            .credits
            .checked_sub(ticket.vault_credit)
            .ok_or(FadeError::MathOverflow)?;
        round.protocol_shares = round
            .protocol_shares
            .checked_sub(ticket.protocol_share)
            .ok_or(FadeError::MathOverflow)?;
        round.app_shares = round
            .app_shares
            .checked_sub(ticket.app_share)
            .ok_or(FadeError::MathOverflow)?;

        settled.push(Settled {
            ticket: start,
            payer: start.checked_add(2).ok_or(FadeError::MathOverflow)?,
            beneficiary,
            key,
            integrator: ticket.integrator,
            settle_share: ticket.settle_share,
            outcome: u8::try_from(index).map_err(|_| FadeError::DrawFailed)?,
            payout,
            pending,
            charge,
            back,
        });
    }

    // The round keeps at least its rent-exempt minimum after paying every
    // return (§13.4 fact 2: always true of consistent books), so that an
    // inconsistency fails here rather than paying payers out of its rent.
    let round_info = a.round.to_account_info();
    let floor = Rent::get()?.minimum_balance(round_info.data_len());
    let left = round_info
        .lamports()
        .checked_add(refund)
        .and_then(|l| l.checked_sub(paid_back))
        .ok_or(FadeError::MathOverflow)?;
    require!(left >= floor, FadeError::MathOverflow);

    // --- pass 2: the CPIs ----------------------------------------------------------------
    if refund > 0 {
        let vrf_seeds: &[&[u8]] = &[ROUND_VRF_SEED, round_key.as_ref(), &[a.round.vrf_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                a.system_program.key(),
                system_program::Transfer {
                    from: a.round_vrf.to_account_info(),
                    to: round_info.clone(),
                },
                &[vrf_seeds],
            ),
            refund,
        )?;
    }
    let escrow = a.payout_escrow.to_account_info();
    let mut payouts = Payouts::new(
        a.vault_usdc.to_account_info(),
        &a.usdc_mint,
        a.vault_authority.to_account_info(),
        a.config.vault_authority_bump,
    )?;
    for s in &settled {
        let destination = match (s.pending, s.beneficiary) {
            (false, Some(b)) => rem.get(b).ok_or(FadeError::MalformedBatch)?,
            _ => &escrow,
        };
        payouts.pay(destination, s.payout)?;
    }

    // --- pass 3: lamports, tickets, integrators, the round ---------------------------
    let caller = a.caller.to_account_info();
    for s in &settled {
        let ticket_info = rem.get(s.ticket).ok_or(FadeError::MalformedBatch)?;
        move_lamports(ticket_info, &caller, s.settle_share)?;
        if s.pending {
            // Parked: the ticket keeps every lamport owed to its payer, its
            // rent and its prepay's return, until `claim_round_payout`.
            move_lamports(&round_info, ticket_info, s.back)?;
            let mut parked: RoundTicket = read(ticket_info)?;
            parked.status = RoundTicketStatus::PayoutParked;
            parked.payout = s.payout;
            parked.settle_share = 0;
            let mut data = ticket_info.try_borrow_mut_data()?;
            parked.try_serialize(&mut &mut data[..])?;
        } else {
            let payer = rem.get(s.payer).ok_or(FadeError::MalformedBatch)?;
            move_lamports(&round_info, payer, s.back)?;
            close_account(ticket_info, payer)?;
        }
    }
    let closed = close_if_ended(&a.round, a.rent_payer.as_ref())?;
    let rent_payer = a.round.rent_payer;

    // --- events ---------------------------------------------------------------------------
    let mut emitter = Emitter::new(ctx.accounts.event_authority.to_account_info());
    if first {
        emitter.emit(&RoundDrawn {
            version: EVENT_VERSION,
            round: round_key,
            draw_cost,
            refund,
        })?;
    }
    for s in &settled {
        emitter.emit(&RoundTicketSettled {
            version: EVENT_VERSION,
            ticket: s.key,
            round: round_key,
            integrator: s.integrator,
            outcome: s.outcome,
            payout: s.payout,
            charge: s.charge,
            pending: s.pending,
        })?;
    }
    if let Some(lamports) = closed {
        emitter.emit(&RoundClosed {
            version: EVENT_VERSION,
            round: round_key,
            rent_payer,
            lamports,
        })?;
    }
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimRoundPayout<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// A parked beacon ticket, at `["round-ticket", integrator, nonce]` with
    /// its stored bump.
    #[account(
        mut,
        seeds = [ROUND_TICKET_SEED, ticket.integrator.as_ref(), &ticket.nonce.to_le_bytes()],
        bump = ticket.bump,
    )]
    pub ticket: Box<Account<'info, RoundTicket>>,
    /// The only destination: `ticket.beneficiary` for a parked payout,
    /// `ticket.refund_to` for a parked return (`BeneficiaryMismatch`).
    #[account(mut)]
    pub destination: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [PAYOUT_ESCROW_SEED], bump)]
    pub payout_escrow: Box<Account<'info, TokenAccount>>,
    /// CHECK: data-less PDA that owns the vault's token accounts.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: the payer stored at the join: receives every lamport the
    /// ticket holds, its rent and what it kept for it at settlement.
    #[account(mut, address = ticket.payer)]
    pub payer: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ FadeError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// Anyone, never paused: delivers what a settlement or a return parked, once
/// its destination can receive it; a destination still unable to fails the
/// transaction, to be retried later. The ticket closes, every lamport to its
/// payer.
pub fn claim_round_payout_handler(ctx: Context<ClaimRoundPayout>) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let ticket = &ctx.accounts.ticket;
    let expected = match ticket.status {
        RoundTicketStatus::PayoutParked => ticket.beneficiary,
        RoundTicketStatus::ReturnParked => ticket.refund_to,
        RoundTicketStatus::Joined => return err!(FadeError::WrongTicketStatus),
    };
    require_keys_eq!(
        ctx.accounts.destination.key(),
        expected,
        FadeError::BeneficiaryMismatch
    );
    let amount = ticket.payout;
    vault_transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.payout_escrow,
        ctx.accounts.destination.to_account_info(),
        &ctx.accounts.usdc_mint,
        ctx.accounts.vault_authority.to_account_info(),
        ctx.accounts.config.vault_authority_bump,
        amount,
    )?;
    let ticket_key = ctx.accounts.ticket.key();
    ctx.accounts
        .ticket
        .close(ctx.accounts.payer.to_account_info())?;
    emit_cpi!(RoundPayoutClaimed {
        version: EVENT_VERSION,
        ticket: ticket_key,
        destination: expected,
        amount,
    });
    Ok(())
}
