//! `claim_shares` (Spec 08 §13.5.12): the protocol's and the integrators'
//! shares of beacon tickets, held in `vault_usdc` from the join and made
//! claimable at settlement or forfeiture, delivered to their pinned owner.
//!
//! Nothing is pushed at settlement, so a share account that cannot receive
//! (closed, frozen, of another mint) delays only its owner's claim: this
//! instruction fails for it and for nobody else, and the amount stays on its
//! ledger until the account can receive or the owner names another one
//! (`set_share_account`, or the council's treasury change). Anyone may send a
//! claim: the destination is the stored one, so pushing someone's shares to
//! them is harmless. Never paused (Technical Specification §5, Custody 2).

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::FadeError;
use crate::events::SharesClaimed;
use crate::instructions::common::{is_usdc_account, vault_transfer};
use crate::state::{Config, Integrator, Vault};

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimShares<'info> {
    /// Anyone; nobody is paid to claim.
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// The integrator whose app shares are claimed, at
    /// `["integrator", authority]` with its stored bump; absent for the
    /// protocol's shares.
    #[account(
        mut,
        seeds = [INTEGRATOR_SEED, integrator.authority.as_ref()],
        bump = integrator.bump,
    )]
    pub integrator: Option<Box<Account<'info, Integrator>>>,
    /// CHECK: `config.protocol_treasury` without `integrator`
    /// (`TreasuryMismatch`), `integrator.share_account` with it
    /// (`ShareAccountMismatch`); inspected before the transfer, which is
    /// made only if it can receive (`DestinationUnusable`).
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: data-less PDA that owns the vault's token accounts.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ FadeError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// Anyone, never paused: the whole claimable ledger, the protocol's or one
/// integrator's, from `vault_usdc` to its stored destination, and the ledger
/// zeroed. Every check precedes the books, and the books the transfer.
pub fn claim_shares(ctx: Context<ClaimShares>) -> Result<()> {
    // --- checks, in order ------------------------------------------------------------
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let destination = ctx.accounts.destination.key();
    let (owner, amount) = match ctx.accounts.integrator.as_ref() {
        Some(integrator) => {
            require_keys_eq!(
                destination,
                integrator.share_account,
                FadeError::ShareAccountMismatch
            );
            (integrator.key(), integrator.app_shares_accrued)
        }
        None => {
            require_keys_eq!(
                destination,
                ctx.accounts.config.protocol_treasury,
                FadeError::TreasuryMismatch
            );
            (
                Pubkey::default(),
                ctx.accounts.vault.protocol_shares_accrued,
            )
        }
    };
    require!(amount > 0, FadeError::NothingToClaim);
    // A transfer to `vault_usdc` itself would move no token yet take the
    // amount off the books, leaving it in the vault counted by nothing:
    // refused, like any destination that cannot receive.
    require!(
        destination != ctx.accounts.vault_usdc.key()
            && is_usdc_account(
                &ctx.accounts.destination.to_account_info(),
                &ctx.accounts.config.usdc_mint
            ),
        FadeError::DestinationUnusable
    );

    // --- the books ---------------------------------------------------------------------
    // The claimed amount leaves exactly the ledger it was on, so the vault
    // identity, `vault_usdc ≥ total_assets + beacon_shares_held +
    // protocol_shares_accrued + app_shares_owed + beacon_returns_owed`,
    // loses the same amount on both sides.
    let vault = &mut ctx.accounts.vault;
    match ctx.accounts.integrator.as_mut() {
        Some(integrator) => {
            vault.app_shares_owed = vault
                .app_shares_owed
                .checked_sub(amount)
                .ok_or(FadeError::MathOverflow)?;
            integrator.app_shares_accrued = 0;
        }
        None => {
            vault.protocol_shares_accrued = 0;
        }
    }

    // --- tokens --------------------------------------------------------------------------
    vault_transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.vault_usdc,
        ctx.accounts.destination.to_account_info(),
        &ctx.accounts.usdc_mint,
        ctx.accounts.vault_authority.to_account_info(),
        ctx.accounts.config.vault_authority_bump,
        amount,
    )?;

    emit_cpi!(SharesClaimed {
        version: EVENT_VERSION,
        integrator: owner,
        destination,
        amount,
    });
    Ok(())
}
