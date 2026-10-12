//! The one instruction an integrator has besides its tickets. Its record is
//! created by its first `open_ticket` (Spec 08 §2.5); there is no registration.

use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::constants::*;
use crate::errors::FadeError;
use crate::events::ShareAccountChanged;
use crate::instructions::common::is_usdc_account;
use crate::state::{Config, Integrator};

#[event_cpi]
#[derive(Accounts)]
pub struct SetShareAccount<'info> {
    pub integrator_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [INTEGRATOR_SEED, integrator_authority.key().as_ref()], bump = integrator.bump)]
    pub integrator: Box<Account<'info, Integrator>>,
    /// Any USDC account: an integrator may route its share anywhere.
    #[account(token::mint = config.usdc_mint)]
    pub share_account: Box<Account<'info, TokenAccount>>,
}

pub fn set_share_account(ctx: Context<SetShareAccount>) -> Result<()> {
    // The same test open_ticket applies: a frozen account would refuse every ticket.
    require!(
        is_usdc_account(
            &ctx.accounts.share_account.to_account_info(),
            &ctx.accounts.config.usdc_mint
        ),
        FadeError::WrongMint
    );
    let integrator = &mut ctx.accounts.integrator;
    integrator.share_account = ctx.accounts.share_account.key();
    emit_cpi!(ShareAccountChanged {
        version: EVENT_VERSION,
        integrator: integrator.key(),
        share_account: integrator.share_account,
    });
    Ok(())
}
