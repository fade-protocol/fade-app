//! `claim_deposit` / `claim_withdraw`: permissionless, paid by the request's
//! own `CLAIM_FEE`, at the price the strike recorded (Spec 01 §3.3, Spec 08 §5).
//! Claims never read `Vault`, and write `Queue` only when they close a record
//! whose rent the strike fund advanced.
//!
//! What a claim owes goes to the owner's canonical token account. Releasing the
//! records never waits on that account: if it cannot receive — closed, frozen,
//! handed to another owner — the claim still does its bookkeeping and parks
//! what it owes on the request, and a later claim delivers it without reading
//! any record: to that account once it can receive, or, with the owner's
//! signature, to any account of the owner's that can.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{Mint, Token, TokenAccount};
use fade_math::shares::{self, Chain};

use crate::constants::*;
use crate::errors::{FadeError, OrFade};
use crate::events::{ClaimDelivered, DepositClaimed, WithdrawClaimed};
use crate::instructions::common::{can_receive, move_lamports, spare_lamports, vault_transfer};
use crate::state::{Config, DepositRequest, EpochRecord, WithdrawRequest};

/// One fewer reader for `record`; at zero it closes and its rent goes back to
/// whoever advanced it, which must be `receiver`.
fn release_reader<'info>(
    record: &mut Account<'info, EpochRecord>,
    receiver: Option<&UncheckedAccount<'info>>,
) -> Result<()> {
    record.pending = record.pending.checked_sub(1).or_fade()?;
    if record.pending == 0 {
        let receiver = receiver.ok_or(FadeError::RentReceiverRequired)?;
        require_keys_eq!(
            receiver.key(),
            record.rent_payer,
            FadeError::RentReceiverRequired
        );
        record.close(receiver.to_account_info())?;
    }
    Ok(())
}

/// The request's `CLAIM_FEE` — whatever it holds above its rent — to the
/// caller; the rent itself to the owner when the request closes.
fn pay_claim_fee(request: &AccountInfo, caller: &AccountInfo) -> Result<()> {
    let fee = spare_lamports(request)?;
    move_lamports(request, caller, fee)
}

/// Where a parked claim delivers: the owner's canonical account once it can
/// receive, or, when the owner signs, another account of theirs that can — the
/// canonical one may have been handed to someone else for good.
fn parked_destination<'info>(
    owner: &UncheckedAccount<'info>,
    canonical: AccountInfo<'info>,
    canonical_usable: bool,
    other: Option<&UncheckedAccount<'info>>,
    mint: &Pubkey,
) -> Result<AccountInfo<'info>> {
    match other {
        Some(other) => {
            require!(owner.is_signer, FadeError::WrongOwner);
            require!(
                can_receive(&other.to_account_info(), mint, Some(&owner.key())),
                FadeError::DestinationUnusable
            );
            Ok(other.to_account_info())
        }
        None => {
            require!(canonical_usable, FadeError::DestinationUnusable);
            Ok(canonical)
        }
    }
}

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimDeposit<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, &request.epoch_id.to_le_bytes(), request.owner.as_ref()],
        bump = request.bump,
        has_one = owner @ FadeError::WrongOwner,
    )]
    pub request: Box<Account<'info, DepositRequest>>,
    /// CHECK: `request.owner`: receives the request's rent.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// Exists only once the request's epoch has been struck; absent once the
    /// request is parked.
    #[account(mut, seeds = [EPOCH_SEED, &request.epoch_id.to_le_bytes()], bump = record.bump)]
    pub record: Option<Box<Account<'info, EpochRecord>>>,
    /// CHECK: the owner's canonical share account, whatever its state; the
    /// handler delivers to it only if it can receive.
    #[account(
        mut,
        address = get_associated_token_address(&request.owner, &share_mint.key()) @ FadeError::WrongOwner,
    )]
    pub owner_shares: UncheckedAccount<'info>,
    #[account(mut, seeds = [SHARE_CLAIMS_SEED], bump)]
    pub share_claims: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [SHARE_MINT_SEED], bump)]
    pub share_mint: Box<Account<'info, Mint>>,
    /// CHECK: data-less PDA that owns the vault's token accounts.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: `record.rent_payer`, needed only by the claim that closes the record.
    #[account(mut)]
    pub rent_receiver: Option<UncheckedAccount<'info>>,
    /// CHECK: for a parked request only, and only with the owner's signature:
    /// another share account of the owner's, checked to be able to receive.
    #[account(mut)]
    pub owner_destination: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
}

pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let (owner, epoch_id) = (ctx.accounts.request.owner, ctx.accounts.request.epoch_id);
    let usable = can_receive(
        &ctx.accounts.owner_shares.to_account_info(),
        &ctx.accounts.share_mint.key(),
        Some(&owner),
    );

    if ctx.accounts.request.parked {
        // Only the delivery is left; the record was released when it parked.
        require!(ctx.accounts.record.is_none(), FadeError::WrongRecord);
        let to = parked_destination(
            &ctx.accounts.owner,
            ctx.accounts.owner_shares.to_account_info(),
            usable,
            ctx.accounts.owner_destination.as_ref(),
            &ctx.accounts.share_mint.key(),
        )?;
        let amount = ctx.accounts.request.shares_due;
        vault_transfer(
            &ctx.accounts.token_program,
            &ctx.accounts.share_claims,
            to,
            &ctx.accounts.share_mint,
            ctx.accounts.vault_authority.to_account_info(),
            ctx.accounts.config.vault_authority_bump,
            amount,
        )?;
        ctx.accounts
            .request
            .close(ctx.accounts.owner.to_account_info())?;
        emit_cpi!(ClaimDelivered {
            version: EVENT_VERSION,
            owner,
            epoch_id,
            deposit: true,
            amount,
        });
        return Ok(());
    }

    require!(
        ctx.accounts.owner_destination.is_none(),
        FadeError::DestinationUnusable
    );
    let record = ctx.accounts.record.as_mut().ok_or(FadeError::NotStruck)?;
    let due = shares::deposit_due(
        ctx.accounts.request.amount,
        record.deposits,
        record.shares_minted,
    )
    .or_fade()?;
    release_reader(record, ctx.accounts.rent_receiver.as_ref())?;
    pay_claim_fee(
        &ctx.accounts.request.to_account_info(),
        &ctx.accounts.caller.to_account_info(),
    )?;
    let delivered = usable || due == 0;
    if delivered {
        let amount = due;
        vault_transfer(
            &ctx.accounts.token_program,
            &ctx.accounts.share_claims,
            ctx.accounts.owner_shares.to_account_info(),
            &ctx.accounts.share_mint,
            ctx.accounts.vault_authority.to_account_info(),
            ctx.accounts.config.vault_authority_bump,
            amount,
        )?;
        ctx.accounts
            .request
            .close(ctx.accounts.owner.to_account_info())?;
    } else {
        let request = &mut ctx.accounts.request;
        request.parked = true;
        request.shares_due = due;
    }
    emit_cpi!(DepositClaimed {
        version: EVENT_VERSION,
        owner,
        epoch_id,
        shares: due,
        delivered,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimWithdraw<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [WITHDRAW_SEED, &request.epoch_id.to_le_bytes(), request.owner.as_ref()],
        bump = request.bump,
        has_one = owner @ FadeError::WrongOwner,
    )]
    pub request: Box<Account<'info, WithdrawRequest>>,
    /// CHECK: `request.owner`: receives the request's rent.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// The record the chain is read at: the request's own epoch or a later one
    /// of the same chain. The final claim reads the one that ends the chain; a
    /// record where the chain splits carries the request into the next chain.
    /// Absent once the request is parked.
    #[account(mut, seeds = [EPOCH_SEED, &at_record.epoch_id.to_le_bytes()], bump = at_record.bump)]
    pub at_record: Option<Box<Account<'info, EpochRecord>>>,
    /// The request's own record, when it is not `at_record` and this is the
    /// request's first claim: it holds the chain indices at entry.
    #[account(mut, seeds = [EPOCH_SEED, &request.epoch_id.to_le_bytes()], bump = entry_record.bump)]
    pub entry_record: Option<Box<Account<'info, EpochRecord>>>,
    /// CHECK: the owner's canonical USDC account, whatever its state; the
    /// handler delivers to it only if it can receive.
    #[account(
        mut,
        address = get_associated_token_address(&request.owner, &usdc_mint.key()) @ FadeError::WrongOwner,
    )]
    pub owner_usdc: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYABLE_SEED], bump)]
    pub payable_usdc: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint @ FadeError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: data-less PDA that owns the vault's token accounts.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: `at_record.rent_payer`, needed only if this claim closes it.
    #[account(mut)]
    pub rent_receiver: Option<UncheckedAccount<'info>>,
    /// CHECK: `entry_record.rent_payer`, needed only if this claim closes it.
    #[account(mut)]
    pub entry_rent_receiver: Option<UncheckedAccount<'info>>,
    /// CHECK: for a parked request only, and only with the owner's signature:
    /// another USDC account of the owner's, checked to be able to receive.
    #[account(mut)]
    pub owner_destination: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
}

/// Pays what the chain owes the request up to `at_record`. A claim at the
/// record that ends the chain is final: it closes the request. A claim at a
/// record where the chain splits carries the request's remaining shares into
/// the next chain. Any other is partial and leaves the request open; partial
/// claims followed by the final one pay exactly what the final one alone would.
pub fn claim_withdraw(ctx: Context<ClaimWithdraw>) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let (owner, request_epoch) = (ctx.accounts.request.owner, ctx.accounts.request.epoch_id);
    let usable = can_receive(
        &ctx.accounts.owner_usdc.to_account_info(),
        &ctx.accounts.usdc_mint.key(),
        Some(&owner),
    );

    if ctx.accounts.request.parked {
        // Only the delivery is left; every record was released when it parked.
        require!(
            ctx.accounts.at_record.is_none() && ctx.accounts.entry_record.is_none(),
            FadeError::WrongRecord
        );
        let to = parked_destination(
            &ctx.accounts.owner,
            ctx.accounts.owner_usdc.to_account_info(),
            usable,
            ctx.accounts.owner_destination.as_ref(),
            &ctx.accounts.usdc_mint.key(),
        )?;
        let amount = ctx.accounts.request.undelivered;
        vault_transfer(
            &ctx.accounts.token_program,
            &ctx.accounts.payable_usdc,
            to,
            &ctx.accounts.usdc_mint,
            ctx.accounts.vault_authority.to_account_info(),
            ctx.accounts.config.vault_authority_bump,
            amount,
        )?;
        ctx.accounts
            .request
            .close(ctx.accounts.owner.to_account_info())?;
        emit_cpi!(ClaimDelivered {
            version: EVENT_VERSION,
            owner,
            epoch_id: request_epoch,
            deposit: false,
            amount,
        });
        return Ok(());
    }

    require!(
        ctx.accounts.owner_destination.is_none(),
        FadeError::DestinationUnusable
    );
    let at = ctx
        .accounts
        .at_record
        .as_ref()
        .ok_or(FadeError::WrongRecord)?;
    let (at_epoch, at_chain) = (at.epoch_id, at.chain_id);
    let at_chain_state = Chain {
        r: at.r_after,
        v: at.v_after,
    };
    require!(at_epoch >= request_epoch, FadeError::WrongRecord);
    let final_claim = at_chain_state.ended();
    let split = at_chain_state.splits();
    // Every request of the chain reads an ending or splitting record once.
    let chain_read = final_claim || split;
    // The entry record is passed exactly when it is needed: on the first claim,
    // when it is not the record read. (The same record twice is already refused
    // by Anchor's duplicate-mutable check, optional accounts included; two
    // copies written back on exit would undo a release.)
    let needs_entry = ctx.accounts.request.r_entry == 0 && at_epoch != request_epoch;
    require!(
        ctx.accounts.entry_record.is_some() == needs_entry,
        FadeError::WrongRecord
    );

    if ctx.accounts.request.r_entry == 0 {
        // First claim: the entry indices come from the request's own record.
        let (r, v, chain) = if at_epoch == request_epoch {
            (at.r_before, at.v_before, at.chain_id)
        } else {
            let entry = ctx
                .accounts
                .entry_record
                .as_ref()
                .ok_or(FadeError::EntryRecordRequired)?;
            (entry.r_before, entry.v_before, entry.chain_id)
        };
        require!(chain == at_chain, FadeError::WrongRecord);
        let request = &mut ctx.accounts.request;
        request.r_entry = r;
        request.v_entry = v;
        request.chain_id = chain;
        // No later claim reads the entry record again: release it now, unless
        // this claim reads it as the chain's end or split, released below.
        if at_epoch != request_epoch {
            let entry = ctx
                .accounts
                .entry_record
                .as_mut()
                .ok_or(FadeError::EntryRecordRequired)?;
            release_reader(entry, ctx.accounts.entry_rent_receiver.as_ref())?;
        } else if !chain_read {
            let at = ctx
                .accounts
                .at_record
                .as_mut()
                .ok_or(FadeError::WrongRecord)?;
            release_reader(at, ctx.accounts.rent_receiver.as_ref())?;
        }
    } else {
        // A record of another chain has unrelated indices: reading one would pay
        // from other people's withdrawals.
        require!(
            ctx.accounts.request.chain_id == at_chain,
            FadeError::WrongRecord
        );
    }

    let request = &ctx.accounts.request;
    let due_total = shares::withdraw_due(
        request.shares,
        request.r_entry,
        request.v_entry,
        at_chain_state.v,
    )
    .or_fade()?;
    let due_now = due_total.checked_sub(request.paid).or_fade()?;
    require!(due_now > 0 || chain_read, FadeError::NothingToClaim);

    let owed = due_now.checked_add(request.undelivered).or_fade()?;
    if usable {
        let amount = owed;
        vault_transfer(
            &ctx.accounts.token_program,
            &ctx.accounts.payable_usdc,
            ctx.accounts.owner_usdc.to_account_info(),
            &ctx.accounts.usdc_mint,
            ctx.accounts.vault_authority.to_account_info(),
            ctx.accounts.config.vault_authority_bump,
            amount,
        )?;
    }
    let request = &mut ctx.accounts.request;
    request.undelivered = if usable { 0 } else { owed };
    request.paid = due_total;

    if split {
        // The shares the chain still holds for this request start over in the
        // next chain, which began at this record, at its start indices.
        request.shares =
            shares::still_queued(request.shares, request.r_entry, at_chain_state.r).or_fade()?;
        request.r_entry = Chain::START.r;
        request.v_entry = Chain::START.v;
        request.paid = 0;
        request.chain_id = at_epoch;
    }
    let mut closed = false;
    if chain_read {
        // The ending or splitting record counts this request among its
        // readers, whether it entered there (its own) or earlier (the chain's).
        let at = ctx
            .accounts
            .at_record
            .as_mut()
            .ok_or(FadeError::WrongRecord)?;
        release_reader(at, ctx.accounts.rent_receiver.as_ref())?;
    }
    if final_claim {
        pay_claim_fee(
            &ctx.accounts.request.to_account_info(),
            &ctx.accounts.caller.to_account_info(),
        )?;
        if ctx.accounts.request.undelivered == 0 {
            ctx.accounts
                .request
                .close(ctx.accounts.owner.to_account_info())?;
            closed = true;
        } else {
            ctx.accounts.request.parked = true;
        }
    }
    emit_cpi!(WithdrawClaimed {
        version: EVENT_VERSION,
        owner,
        epoch_id: request_epoch,
        at_epoch_id: at_epoch,
        assets: due_now,
        closed,
        delivered: usable,
    });
    Ok(())
}
