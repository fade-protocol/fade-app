//! `strike_epoch`: prices the live epoch once it is clean, in constant time
//! (Spec 01 §3.5, Spec 08 §4 rule 5 and §5–§6).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount};
use fade_math::epoch;
use fade_math::risk;
use fade_math::shares;

use crate::constants::*;
use crate::errors::{FadeError, OrFade};
use crate::events::EpochStruck;
use crate::instructions::common::{move_lamports, spare_lamports, vault_transfer};
use crate::state::{Config, EpochRecord, LiveEpoch, Queue, Vault};

#[event_cpi]
#[derive(Accounts)]
pub struct StrikeEpoch<'info> {
    /// Anyone; advances the record's rent, which the strike fund reimburses,
    /// and receives `STRIKE_REWARD` from the fund.
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [QUEUE_SEED], bump = queue.bump)]
    pub queue: Box<Account<'info, Queue>>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// Written once; afterwards only its count of pending readers changes.
    #[account(
        init,
        payer = caller,
        space = 8 + EpochRecord::INIT_SPACE,
        seeds = [EPOCH_SEED, &queue.current.epoch_id.to_le_bytes()],
        bump,
    )]
    pub record: Box<Account<'info, EpochRecord>>,
    #[account(mut, seeds = [DEPOSIT_QUEUE_SEED], bump)]
    pub deposit_queue_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [PAYABLE_SEED], bump)]
    pub payable_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [SHARE_MINT_SEED], bump)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [SHARE_ESCROW_SEED], bump)]
    pub share_escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [SHARE_CLAIMS_SEED], bump)]
    pub share_claims: Box<Account<'info, TokenAccount>>,
    /// CHECK: data-less PDA that owns the vault's token accounts and the share mint.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ FadeError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn strike_epoch_handler(ctx: Context<StrikeEpoch>) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let params = ctx.accounts.config.params;
    let now = Clock::get()?.unix_timestamp;
    let current = ctx.accounts.queue.current;
    require!(current.live, FadeError::NoLiveEpoch);
    require!(now >= current.close_ts, FadeError::EpochNotClosed);
    require!(
        ctx.accounts.vault.open_before_close == 0,
        FadeError::StrikeNotClean
    );

    // One price for the whole batch: the vault as it stood at the close, before
    // any of the strike's flows. No ticket opened before the close is still
    // open; those opened after it are left out whether still open (their
    // credits) or already closed (their results), so that neither opening nor
    // settling a ticket after the close can move the price a request clears at.
    let vault = &ctx.accounts.vault;
    let s = vault.total_shares;
    let a = vault.strike_assets().or_fade()?;
    let total_before = vault.total_assets;
    // The drawdown ring follows the settled price, whatever the strike leaves out.
    let ring_before = vault.settled_price().or_fade()?;
    // Withdrawals are rationed against what may leave the vault once the
    // epoch's deposits have joined it, on the tickets opened after the close —
    // the only ones open at a clean strike.
    let with_deposits = risk::Vault {
        assets: total_before.checked_add(current.deposits).or_fade()?,
        reserved: vault.total_reserved_liability,
        open_credits: vault.open_vault_credits,
    };
    let withdrawable = risk::withdrawable(&with_deposits, &params.to_math());
    let k = shares::strike(
        current.deposits,
        current.withdraw_shares,
        s,
        a,
        withdrawable,
    )
    .or_fade()?;

    // --- tokens: four bulk movements, whatever the number of requests -----------
    let bump = ctx.accounts.config.vault_authority_bump;
    let authority = ctx.accounts.vault_authority.to_account_info();
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &[bump]];
    vault_transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.deposit_queue_usdc,
        ctx.accounts.vault_usdc.to_account_info(),
        &ctx.accounts.usdc_mint,
        authority.clone(),
        bump,
        current.deposits,
    )?;
    if k.shares_minted > 0 {
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.share_claims.to_account_info(),
                    authority: authority.clone(),
                },
                &[seeds],
            ),
            k.shares_minted,
        )?;
    }
    if k.shares_burnt > 0 {
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.share_escrow.to_account_info(),
                    authority: authority.clone(),
                },
                &[seeds],
            ),
            k.shares_burnt,
        )?;
    }
    vault_transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.vault_usdc,
        ctx.accounts.payable_usdc.to_account_info(),
        &ctx.accounts.usdc_mint,
        authority,
        bump,
        k.assets_paid,
    )?;

    // --- the vault ---------------------------------------------------------------
    let vault = &mut ctx.accounts.vault;
    vault.total_assets = total_before
        .checked_add(current.deposits)
        .and_then(|v| v.checked_sub(k.assets_paid))
        .or_fade()?;
    vault.total_shares = s
        .checked_add(k.shares_minted)
        .and_then(|v| v.checked_sub(k.shares_burnt))
        .or_fade()?;
    // Flows cleared at a price that leaves out after-close results move the
    // settled price with no result behind them: the ring moves with it, so
    // that only results count as a drawdown (Spec 08 §8).
    let ring_after = vault.settled_price().or_fade()?;
    let mut ring = vault.ring();
    ring.observe(now, ring_before, ring_before);
    ring.rescale(ring_after, ring_before);
    ring.observe(now, ring_after, ring_after);
    vault.set_ring(&ring);
    // The results left out of this price belong to the next one.
    vault.clear_after_close_results();

    // --- the withdrawal chain (Spec 08 §5) -------------------------------------------
    let queue = &mut ctx.accounts.queue;
    let own_requests = current
        .deposit_requests
        .checked_add(current.withdraw_requests)
        .or_fade()?;
    let mut pending = own_requests;
    let chain_before = queue.chain();
    let chain_id;
    if current.withdraw_shares > 0 {
        if queue.chain_id == 0 {
            queue.chain_id = current.epoch_id;
        }
        chain_id = queue.chain_id;
        let after = chain_before
            .advance(current.withdraw_shares, k.shares_burnt, k.assets_paid)
            .or_fade()?;
        if after.ended() {
            pending = pending.checked_add(queue.chain_requests).or_fade()?;
            queue.reset_chain();
        } else if after.splits() {
            // Every request of the chain reads this record once more, to carry
            // its remaining shares into a new chain that starts here.
            pending = pending.checked_add(queue.chain_requests).or_fade()?;
            let carried = queue
                .chain_requests
                .checked_add(current.withdraw_requests)
                .or_fade()?;
            queue.reset_chain();
            queue.chain_id = current.epoch_id;
            queue.chain_requests = carried;
        } else {
            queue.chain_r = after.r;
            queue.chain_v = after.v;
            queue.chain_requests = queue
                .chain_requests
                .checked_add(current.withdraw_requests)
                .or_fade()?;
        }
        write_chain(&mut ctx.accounts.record, chain_before, after);
    } else {
        chain_id = current.epoch_id;
        write_chain(&mut ctx.accounts.record, chain_before, chain_before);
    }

    // Shares the strike could not pay for roll into the next epoch.
    let rolled = current
        .withdraw_shares
        .checked_sub(k.shares_burnt)
        .or_fade()?;
    if rolled > 0 {
        if !queue.next.live {
            queue.next = LiveEpoch {
                live: true,
                epoch_id: queue.next_epoch_id,
                ..LiveEpoch::default()
            };
            queue.next_epoch_id = queue.next_epoch_id.checked_add(1).or_fade()?;
        }
        queue.next.withdraw_shares = queue.next.withdraw_shares.checked_add(rolled).or_fade()?;
    }

    // --- promotion (rule 6) --------------------------------------------------------
    let vault = &mut ctx.accounts.vault;
    if queue.next.live {
        let length = i64::try_from(params.epoch_length_seconds).ok().or_fade()?;
        let close = epoch::close_ts(now, length).or_fade()?;
        vault.roll_epoch(close).or_fade()?;
        queue.current = LiveEpoch {
            close_ts: close,
            ..queue.next
        };
        queue.next = LiveEpoch::default();
    } else {
        let mut counters = vault.counters();
        counters.clear_close();
        vault.set_counters(&counters);
        queue.current = LiveEpoch::default();
    }

    // --- the record ------------------------------------------------------------------
    let record = &mut ctx.accounts.record;
    record.version = ACCOUNT_VERSION;
    record.bump = ctx.bumps.record;
    record.epoch_id = current.epoch_id;
    record.close_ts = current.close_ts;
    record.struck_ts = now;
    record.total_assets = a;
    record.total_shares = s;
    record.deposits = current.deposits;
    record.shares_minted = k.shares_minted;
    record.withdraw_shares = current.withdraw_shares;
    record.assets_owed = k.assets_owed;
    record.assets_paid = k.assets_paid;
    record.shares_burnt = k.shares_burnt;
    record.chain_id = chain_id;
    record.pending = pending;
    record.requests = own_requests;

    // --- who pays: the fund reimburses the record's rent, then the reward ------
    let queue_info = ctx.accounts.queue.to_account_info();
    let caller_info = ctx.accounts.caller.to_account_info();
    // Its rent, not its balance: lamports sent to the address beforehand stay
    // on the record and go to its rent payer when it closes.
    let record_info = ctx.accounts.record.to_account_info();
    let record_rent = Rent::get()?
        .minimum_balance(record_info.data_len())
        .min(record_info.lamports());
    let mut fund = spare_lamports(&queue_info)?;
    if pending == 0 {
        // Nobody will ever read this record: it closes now, its rent back to the caller.
        ctx.accounts.record.rent_payer = ctx.accounts.caller.key();
        ctx.accounts.record.close(caller_info.clone())?;
    } else if fund >= record_rent {
        move_lamports(&queue_info, &caller_info, record_rent)?;
        fund = fund.saturating_sub(record_rent);
        ctx.accounts.record.rent_payer = ctx.accounts.queue.key();
    } else {
        // The fund is dry: the caller's advance is returned to the caller.
        ctx.accounts.record.rent_payer = ctx.accounts.caller.key();
    }
    let reward = params.strike_reward_lamports.min(fund);
    move_lamports(&queue_info, &caller_info, reward)?;

    emit_cpi!(EpochStruck {
        version: EVENT_VERSION,
        epoch_id: current.epoch_id,
        total_assets: a,
        total_shares: s,
        deposits: current.deposits,
        shares_minted: k.shares_minted,
        withdraw_shares: current.withdraw_shares,
        assets_owed: k.assets_owed,
        assets_paid: k.assets_paid,
        shares_burnt: k.shares_burnt,
        reward,
    });
    Ok(())
}

fn write_chain(record: &mut EpochRecord, before: shares::Chain, after: shares::Chain) {
    record.r_before = before.r;
    record.v_before = before.v;
    record.r_after = after.r;
    record.v_after = after.v;
}
