use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{Mint, Token, TokenAccount};
use fade_math::drawdown::{share_price, Ring};
use fade_math::shares::INDEX_SCALE;

use crate::constants::*;
use crate::errors::{FadeError, OrFade};
use crate::events::Initialized;
use crate::state::{Config, LiveEpoch, PendingChange, Queue, RiskParams, Vault};

#[event_cpi]
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Must be the program's upgrade authority: the one party that could
    /// already do anything, so no new trust is created. Pays every rent and
    /// seeds the strike fund.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = fade_program.programdata_address()? == Some(program_data.key()) @ FadeError::NotUpgradeAuthority)]
    pub fade_program: Program<'info, crate::program::Fade>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ FadeError::NotUpgradeAuthority)]
    pub program_data: Box<Account<'info, ProgramData>>,

    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = payer, space = 8 + Vault::INIT_SPACE, seeds = [VAULT_SEED], bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(init, payer = payer, space = 8 + Queue::INIT_SPACE, seeds = [QUEUE_SEED], bump)]
    pub queue: Box<Account<'info, Queue>>,
    /// CHECK: PDA with no data; owner of every token account below.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// `Account<Mint>` of the legacy token module: a Token-2022 mint fails the owner check.
    #[account(address = USDC_MINT @ FadeError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = payer, seeds = [USDC_VAULT_SEED], bump, token::mint = usdc_mint, token::authority = vault_authority)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = payer, seeds = [PAYOUT_ESCROW_SEED], bump, token::mint = usdc_mint, token::authority = vault_authority)]
    pub payout_escrow: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = payer, seeds = [DEPOSIT_QUEUE_SEED], bump, token::mint = usdc_mint, token::authority = vault_authority)]
    pub deposit_queue_usdc: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = payer, seeds = [PAYABLE_SEED], bump, token::mint = usdc_mint, token::authority = vault_authority)]
    pub payable_usdc: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = payer, seeds = [SHARE_MINT_SEED], bump, mint::decimals = SHARE_DECIMALS, mint::authority = vault_authority)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = payer, seeds = [SHARE_ESCROW_SEED], bump, token::mint = share_mint, token::authority = vault_authority)]
    pub share_escrow: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = payer, seeds = [SHARE_CLAIMS_SEED], bump, token::mint = share_mint, token::authority = vault_authority)]
    pub share_claims: Box<Account<'info, TokenAccount>>,
    /// Where the protocol share goes. Any USDC token account; its owner is the council's business.
    #[account(token::mint = usdc_mint)]
    pub protocol_treasury: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_handler(
    ctx: Context<Initialize>,
    council: Pubkey,
    guardian: Pubkey,
    params: RiskParams,
) -> Result<()> {
    require!(params.is_valid(), FadeError::InvalidParams);
    let now = Clock::get()?.unix_timestamp;

    let config = &mut ctx.accounts.config;
    config.version = CONFIG_VERSION;
    config.bump = ctx.bumps.config;
    config.vault_authority_bump = ctx.bumps.vault_authority;
    config.council = council;
    config.guardian = guardian;
    config.protocol_treasury = ctx.accounts.protocol_treasury.key();
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    // The beacon starts paused: only the council turns it on (Spec 08 §13.7),
    // once the deployed binary carries every instruction that ends a round
    // (refund, request, settlement, expiry, returns, reclaims and claims).
    // Before that, a join would lock its funds and the vault's reservation.
    config.pause_flags = Config::PAUSE_ROUNDS;
    config.params = params;
    config.pending = PendingChange {
        active: false,
        effective_at: 0,
        params,
        protocol_treasury: config.protocol_treasury,
    };

    let vault = &mut ctx.accounts.vault;
    vault.version = ACCOUNT_VERSION;
    vault.bump = ctx.bumps.vault;
    // Round ids start at 1: `accepting_round == 0` means no round accepts tickets.
    vault.next_round_id = 1;
    vault.set_ring(&Ring::new(now, share_price(0, 0).or_fade()?));

    let queue = &mut ctx.accounts.queue;
    queue.version = ACCOUNT_VERSION;
    queue.bump = ctx.bumps.queue;
    queue.current = LiveEpoch::default();
    queue.next = LiveEpoch::default();
    queue.next_epoch_id = 1;
    queue.chain_r = INDEX_SCALE;

    // The strike fund starts full (Spec 08 §6).
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.queue.to_account_info(),
            },
        ),
        params.fund_target_lamports,
    )?;

    emit_cpi!(Initialized {
        version: EVENT_VERSION,
        council,
        guardian,
        protocol_treasury: ctx.accounts.protocol_treasury.key(),
    });
    Ok(())
}
