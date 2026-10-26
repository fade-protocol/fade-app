//! Parameter changes (Spec 05 §3, Spec 08 §7) and pause flags (Spec 05 §4).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::FadeError;
use crate::events::{
    ParamsApplied, ParamsCancelled, ParamsChanged, PauseFlagsChanged, ShareMetadataSet,
};
use crate::state::{Config, Integrator, PendingChange, RiskParams};

#[event_cpi]
#[derive(Accounts)]
pub struct SetParams<'info> {
    #[account(address = config.council @ FadeError::NotCouncil)]
    pub council: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// The treasury the change sets; the current one to leave it alone.
    #[account(token::mint = config.usdc_mint)]
    pub protocol_treasury: Box<Account<'info, TokenAccount>>,
}

/// Applies at once when every field that changes tightens; otherwise queues the
/// change behind the longest delay among the fields it loosens, 72 hours for
/// the treasury. A new call replaces a pending change and restarts its clock.
/// The development build (feature "no-timelock") applies every change at once.
/// A change that applies at once (every tightening, or every change in the
/// no-timelock build) writes the parameters and the treasury, as
/// `apply_params` would, and replaces any pending change.
pub fn set_params(ctx: Context<SetParams>, params: RiskParams) -> Result<()> {
    require!(params.is_valid(), FadeError::InvalidParams);
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    let treasury = ctx.accounts.protocol_treasury.key();
    let mut delay = config.params.change_delay(&params);
    if treasury != config.protocol_treasury {
        delay = delay.max(DELAY_72H);
    }
    if cfg!(feature = "no-timelock") {
        delay = 0;
    }
    let effective_at = now.checked_add(delay).ok_or(FadeError::MathOverflow)?;
    let applied = delay == 0;
    if applied {
        apply_change(config, params, treasury);
    } else {
        config.pending = PendingChange {
            active: true,
            effective_at,
            params,
            protocol_treasury: treasury,
        };
    }
    emit_cpi!(ParamsChanged {
        version: EVENT_VERSION,
        applied,
        effective_at,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct ApplyParams<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

/// One change, one effect: the parameters and the treasury together, and no
/// change left pending. Both `set_params`, for a change that applies at once,
/// and `apply_params` write a change through it.
fn apply_change(config: &mut Config, params: RiskParams, treasury: Pubkey) {
    config.params = params;
    config.protocol_treasury = treasury;
    config.pending.active = false;
}

/// Permissionless once the pending change is due. The pending parameters are
/// checked again: a change queued before a range was narrowed cannot land
/// outside it (the council cancels it instead).
pub fn apply_params(ctx: Context<ApplyParams>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    require!(config.pending.active, FadeError::NoPendingChange);
    require!(now >= config.pending.effective_at, FadeError::ChangeNotDue);
    require!(config.pending.params.is_valid(), FadeError::InvalidParams);
    let (params, treasury) = (config.pending.params, config.pending.protocol_treasury);
    apply_change(config, params, treasury);
    emit_cpi!(ParamsApplied {
        version: EVENT_VERSION,
        effective_at: config.pending.effective_at,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct CancelParams<'info> {
    #[account(address = config.council @ FadeError::NotCouncil)]
    pub council: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

pub fn cancel_params(ctx: Context<CancelParams>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.pending.active, FadeError::NoPendingChange);
    config.pending.active = false;
    emit_cpi!(ParamsCancelled {
        version: EVENT_VERSION,
        effective_at: config.pending.effective_at,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetPauseFlags<'info> {
    /// The guardian or the council.
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// The integrator whose own pause changes, if any.
    #[account(mut, seeds = [INTEGRATOR_SEED, integrator.authority.as_ref()], bump = integrator.bump)]
    pub integrator: Option<Box<Account<'info, Integrator>>>,
}

/// The guardian may only tighten — set flags, pause an integrator — and does so
/// instantly; only the council lifts a pause (Spec 05 §4). No flag can ever
/// block settlement, expiry, the strike, a claim or a withdrawal request.
pub fn set_pause_flags(
    ctx: Context<SetPauseFlags>,
    pause_flags: u8,
    integrator_paused: Option<bool>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let signer = ctx.accounts.authority.key();
    let is_council = signer == config.council;
    require!(
        is_council || signer == config.guardian,
        FadeError::NotGuardian
    );
    require!(
        pause_flags & !Config::PAUSE_ALL == 0,
        FadeError::InvalidParams
    );
    if !is_council {
        require!(
            pause_flags & config.pause_flags == config.pause_flags,
            FadeError::GuardianCannotUnpause
        );
    }
    config.pause_flags = pause_flags;

    let (integrator_key, paused) = match (ctx.accounts.integrator.as_mut(), integrator_paused) {
        (Some(integrator), Some(paused)) => {
            require!(
                is_council || paused || !integrator.paused,
                FadeError::GuardianCannotUnpause
            );
            integrator.paused = paused;
            (integrator.key(), paused)
        }
        (None, None) => (Pubkey::default(), false),
        _ => return err!(FadeError::InvalidParams),
    };
    emit_cpi!(PauseFlagsChanged {
        version: EVENT_VERSION,
        by: signer,
        pause_flags,
        integrator: integrator_key,
        integrator_paused: paused,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetShareMetadata<'info> {
    #[account(address = config.council @ FadeError::NotCouncil)]
    pub council: Signer<'info>,
    /// Pays the metadata account's rent and Token Metadata's creation fee.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// The share mint's mint authority and the metadata's update authority.
    /// CHECK: PDA with no data.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(seeds = [SHARE_MINT_SEED], bump)]
    pub share_mint: Box<Account<'info, Mint>>,
    /// The share mint's metadata PDA under Token Metadata; created on the first call.
    /// CHECK: seeds checked here, contents by Token Metadata.
    #[account(
        mut,
        seeds = [METADATA_SEED, TOKEN_METADATA_ID.as_ref(), share_mint.key().as_ref()],
        bump,
        seeds::program = TOKEN_METADATA_ID,
    )]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: address pinned.
    #[account(address = TOKEN_METADATA_ID)]
    pub token_metadata_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Token Metadata instruction tags (Borsh enum index).
const CREATE_METADATA_ACCOUNT_V3: u8 = 33;
const UPDATE_METADATA_ACCOUNT_V2: u8 = 15;

/// Token Metadata's `DataV2` with no royalty, creators, collection or uses.
fn push_data_v2(data: &mut Vec<u8>, name: &str, symbol: &str, uri: &str) {
    for field in [name, symbol, uri] {
        data.extend_from_slice(&(field.len() as u32).to_le_bytes());
        data.extend_from_slice(field.as_bytes());
    }
    data.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
    data.extend_from_slice(&[0, 0, 0]); // creators, collection, uses: None
}

/// Council only, applied at once: the name, symbol and logo wallets show for
/// the share mint, nothing the program reads. Creates the Token Metadata
/// account on the first call and rewrites it afterwards; the vault authority
/// signs as mint authority and stays the update authority. Token Metadata
/// enforces its own length limits (name 32, symbol 10, uri 200 bytes).
pub fn set_share_metadata(
    ctx: Context<SetShareMetadata>,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    let a = &ctx.accounts;
    let created = a.metadata.data_is_empty();
    let mut data = Vec::with_capacity(32 + name.len() + symbol.len() + uri.len());
    let (accounts, infos) = if created {
        data.push(CREATE_METADATA_ACCOUNT_V3);
        push_data_v2(&mut data, &name, &symbol, &uri);
        data.push(1); // is_mutable: later calls rewrite it
        data.push(0); // collection_details: None
        (
            vec![
                AccountMeta::new(a.metadata.key(), false),
                AccountMeta::new_readonly(a.share_mint.key(), false),
                AccountMeta::new_readonly(a.vault_authority.key(), true),
                AccountMeta::new(a.payer.key(), true),
                AccountMeta::new_readonly(a.vault_authority.key(), true),
                AccountMeta::new_readonly(a.system_program.key(), false),
            ],
            vec![
                a.metadata.to_account_info(),
                a.share_mint.to_account_info(),
                a.vault_authority.to_account_info(),
                a.payer.to_account_info(),
                a.system_program.to_account_info(),
                a.token_metadata_program.to_account_info(),
            ],
        )
    } else {
        data.push(UPDATE_METADATA_ACCOUNT_V2);
        data.push(1); // data: Some
        push_data_v2(&mut data, &name, &symbol, &uri);
        data.extend_from_slice(&[0, 0, 0]); // update authority, primary sale, is_mutable: unchanged
        (
            vec![
                AccountMeta::new(a.metadata.key(), false),
                AccountMeta::new_readonly(a.vault_authority.key(), true),
            ],
            vec![
                a.metadata.to_account_info(),
                a.vault_authority.to_account_info(),
                a.token_metadata_program.to_account_info(),
            ],
        )
    };
    let ix = Instruction {
        program_id: TOKEN_METADATA_ID,
        accounts,
        data,
    };
    invoke_signed(
        &ix,
        &infos,
        &[&[
            VAULT_AUTHORITY_SEED,
            &[ctx.accounts.config.vault_authority_bump],
        ]],
    )?;
    emit_cpi!(ShareMetadataSet {
        version: EVENT_VERSION,
        created,
        name,
        symbol,
        uri,
    });
    Ok(())
}
