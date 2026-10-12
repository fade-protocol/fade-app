//! `request_deposit` / `request_withdraw`: a liquidity provider's only move
//! (Spec 01 §3.3, Spec 08 §4 and §6). The request lands in the epoch the
//! program computes, prepays its own claim, and tops up the strike fund while
//! the fund is below its target.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::Discriminator;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};
use fade_math::epoch::{self, Join};

use crate::constants::*;
use crate::errors::{FadeError, OrFade};
use crate::events::{DepositRequested, WithdrawRequested};
use crate::instructions::common::{spare_lamports, user_transfer};
use crate::state::{Config, DepositRequest, LiveEpoch, Queue, RiskParams, Vault, WithdrawRequest};

/// Invariant 13: every top-level instruction of a transaction carrying a
/// request must be a compute-budget, system, token, associated-token or Fade
/// vault instruction. It forbids a `settle_ticket` from riding along with a
/// deposit and a withdrawal, and any program from wrapping the request.
pub fn check_composition(instructions: &AccountInfo) -> Result<()> {
    use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
    let allowed_fade: [&[u8]; 5] = [
        crate::instruction::RequestDeposit::DISCRIMINATOR,
        crate::instruction::RequestWithdraw::DISCRIMINATOR,
        crate::instruction::StrikeEpoch::DISCRIMINATOR,
        crate::instruction::ClaimDeposit::DISCRIMINATOR,
        crate::instruction::ClaimWithdraw::DISCRIMINATOR,
    ];
    let current = usize::from(load_current_index_checked(instructions)?);
    let mut index = 0usize;
    while let Ok(ix) = load_instruction_at_checked(index, instructions) {
        let program = ix.program_id;
        let ok = if program == crate::ID {
            allowed_fade
                .iter()
                .any(|d| ix.data.len() >= d.len() && ix.data[..d.len()] == **d)
        } else {
            program == COMPUTE_BUDGET_ID
                || program == anchor_lang::solana_program::system_program::ID
                || program == anchor_spl::token::ID
                || program == anchor_spl::associated_token::ID
        };
        require!(ok, FadeError::ForbiddenComposition);
        index = index.checked_add(1).ok_or(FadeError::MathOverflow)?;
    }
    // The request itself must be one of those top-level instructions, not a CPI.
    let me = load_instruction_at_checked(current, instructions)
        .map_err(|_| error!(FadeError::ForbiddenComposition))?;
    require_keys_eq!(me.program_id, crate::ID, FadeError::ForbiddenComposition);
    Ok(())
}

/// Rule 2, applied: puts the request in `current` (opening it if no epoch is
/// live, which rolls the vault's ticket counters) or in `next`. Returns the
/// epoch it landed in.
fn land<'a>(
    queue: &'a mut Queue,
    vault: Option<&mut Vault>,
    params: &RiskParams,
    now: i64,
) -> Result<&'a mut LiveEpoch> {
    match epoch::join(queue.current.live, queue.current.close_ts, now) {
        Join::Open => {
            let length = i64::try_from(params.epoch_length_seconds).ok().or_fade()?;
            let close = epoch::close_ts(now, length).or_fade()?;
            let vault = vault.ok_or(FadeError::VaultRequired)?;
            vault.roll_epoch(close).or_fade()?;
            queue.current = LiveEpoch {
                live: true,
                epoch_id: queue.next_epoch_id,
                close_ts: close,
                ..LiveEpoch::default()
            };
            queue.next_epoch_id = queue.next_epoch_id.checked_add(1).or_fade()?;
            Ok(&mut queue.current)
        }
        Join::Current => Ok(&mut queue.current),
        Join::Next => {
            if !queue.next.live {
                queue.next = LiveEpoch {
                    live: true,
                    epoch_id: queue.next_epoch_id,
                    ..LiveEpoch::default()
                };
                queue.next_epoch_id = queue.next_epoch_id.checked_add(1).or_fade()?;
            }
            Ok(&mut queue.next)
        }
    }
}

/// Moves `lamports` from a signer into a program account.
fn pay_in<'info>(
    system: &Program<'info, System>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    lamports: u64,
) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new(system.key(), system_program::Transfer { from, to }),
        lamports,
    )
}

/// The `STRIKE_FEE`, owed only while the fund is below its target.
fn strike_fee(queue: &AccountInfo, params: &RiskParams) -> Result<u64> {
    Ok(if spare_lamports(queue)? < params.fund_target_lamports {
        params.strike_fee_lamports
    } else {
        0
    })
}

#[event_cpi]
#[derive(Accounts)]
pub struct RequestDeposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    /// Where the claim will pay the shares: the owner's canonical account,
    /// created now so that no keeper ever advances someone else's rent.
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = share_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub owner_shares: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [QUEUE_SEED], bump = queue.bump)]
    pub queue: Box<Account<'info, Queue>>,
    /// Only needed when this request opens an epoch (Spec 08 §4 rule 1).
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Option<Box<Account<'info, Vault>>>,
    #[account(mut, seeds = [DEPOSIT_QUEUE_SEED], bump)]
    pub deposit_queue_usdc: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [SHARE_MINT_SEED], bump)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(address = config.usdc_mint @ FadeError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub clock: Sysvar<'info, Clock>,
    /// The epoch is the one the program computes from the queue and the clock,
    /// never an argument: a caller-chosen epoch would choose its price.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + DepositRequest::INIT_SPACE,
        seeds = [DEPOSIT_SEED, &queue.joining_epoch_id(clock.unix_timestamp).to_le_bytes(), owner.key().as_ref()],
        bump,
    )]
    pub request: Box<Account<'info, DepositRequest>>,
    /// CHECK: pinned to the instructions sysvar; read by `check_composition`.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn request_deposit(ctx: Context<RequestDeposit>, amount: u64) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    check_composition(&ctx.accounts.instructions)?;
    let params = ctx.accounts.config.params;
    require!(
        !ctx.accounts.config.is_paused(Config::PAUSE_DEPOSITS),
        FadeError::Paused
    );
    require!(amount >= params.min_deposit, FadeError::BelowMinimum);
    if ctx.accounts.share_mint.supply == 0 {
        require!(
            amount >= params.min_first_deposit,
            FadeError::FirstDepositTooSmall
        );
    }
    let now = ctx.accounts.clock.unix_timestamp;
    let fee = strike_fee(&ctx.accounts.queue.to_account_info(), &params)?;
    let created = ctx.accounts.request.version == 0;

    user_transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.owner_usdc,
        ctx.accounts.deposit_queue_usdc.to_account_info(),
        &ctx.accounts.usdc_mint,
        ctx.accounts.owner.to_account_info(),
        amount,
    )?;
    let system = &ctx.accounts.system_program;
    let owner = ctx.accounts.owner.to_account_info();
    if created {
        pay_in(
            system,
            owner.clone(),
            ctx.accounts.request.to_account_info(),
            params.claim_fee_lamports,
        )?;
    }
    pay_in(system, owner, ctx.accounts.queue.to_account_info(), fee)?;

    let vault = ctx.accounts.vault.as_deref_mut().map(|p| &mut **p);
    let epoch = land(&mut ctx.accounts.queue, vault, &params, now)?;
    epoch.deposits = epoch.deposits.checked_add(amount).or_fade()?;
    if created {
        epoch.deposit_requests = epoch.deposit_requests.checked_add(1).or_fade()?;
    }
    let epoch_id = epoch.epoch_id;

    let request = &mut ctx.accounts.request;
    if created {
        request.version = ACCOUNT_VERSION;
        request.bump = ctx.bumps.request;
        request.owner = ctx.accounts.owner.key();
        request.epoch_id = epoch_id;
    }
    require!(request.epoch_id == epoch_id, FadeError::WrongRecord);
    request.amount = request.amount.checked_add(amount).or_fade()?;

    emit_cpi!(DepositRequested {
        version: EVENT_VERSION,
        owner: ctx.accounts.owner.key(),
        epoch_id,
        amount,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, token::mint = share_mint, token::authority = owner)]
    pub owner_shares: Box<Account<'info, TokenAccount>>,
    /// Where the claim will pay the USDC: the owner's canonical account.
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = usdc_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [QUEUE_SEED], bump = queue.bump)]
    pub queue: Box<Account<'info, Queue>>,
    /// Only needed when this request opens an epoch.
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Option<Box<Account<'info, Vault>>>,
    #[account(mut, seeds = [SHARE_ESCROW_SEED], bump)]
    pub share_escrow: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [SHARE_MINT_SEED], bump)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(address = config.usdc_mint @ FadeError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub clock: Sysvar<'info, Clock>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + WithdrawRequest::INIT_SPACE,
        seeds = [WITHDRAW_SEED, &queue.joining_epoch_id(clock.unix_timestamp).to_le_bytes(), owner.key().as_ref()],
        bump,
    )]
    pub request: Box<Account<'info, WithdrawRequest>>,
    /// CHECK: pinned to the instructions sysvar; read by `check_composition`.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Never gated by a pause (Spec 05 §4): a pause must not trap LP capital.
pub fn request_withdraw(ctx: Context<RequestWithdraw>, shares: u64) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    check_composition(&ctx.accounts.instructions)?;
    let params = ctx.accounts.config.params;
    require!(shares > 0, FadeError::ZeroAmount);
    require!(
        shares >= params.min_withdraw_shares || shares == ctx.accounts.owner_shares.amount,
        FadeError::BelowMinimum
    );
    let now = ctx.accounts.clock.unix_timestamp;
    let fee = strike_fee(&ctx.accounts.queue.to_account_info(), &params)?;
    let created = ctx.accounts.request.version == 0;

    user_transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.owner_shares,
        ctx.accounts.share_escrow.to_account_info(),
        &ctx.accounts.share_mint,
        ctx.accounts.owner.to_account_info(),
        shares,
    )?;
    let system = &ctx.accounts.system_program;
    let owner = ctx.accounts.owner.to_account_info();
    if created {
        pay_in(
            system,
            owner.clone(),
            ctx.accounts.request.to_account_info(),
            params.claim_fee_lamports,
        )?;
    }
    pay_in(system, owner, ctx.accounts.queue.to_account_info(), fee)?;

    let vault = ctx.accounts.vault.as_deref_mut().map(|p| &mut **p);
    let epoch = land(&mut ctx.accounts.queue, vault, &params, now)?;
    epoch.withdraw_shares = epoch.withdraw_shares.checked_add(shares).or_fade()?;
    if created {
        epoch.withdraw_requests = epoch.withdraw_requests.checked_add(1).or_fade()?;
    }
    let epoch_id = epoch.epoch_id;

    let request = &mut ctx.accounts.request;
    if created {
        request.version = ACCOUNT_VERSION;
        request.bump = ctx.bumps.request;
        request.owner = ctx.accounts.owner.key();
        request.epoch_id = epoch_id;
    }
    require!(request.epoch_id == epoch_id, FadeError::WrongRecord);
    request.shares = request.shares.checked_add(shares).or_fade()?;

    emit_cpi!(WithdrawRequested {
        version: EVENT_VERSION,
        owner: ctx.accounts.owner.key(),
        epoch_id,
        shares,
    });
    Ok(())
}
