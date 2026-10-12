//! Phase 0 smoke program. Every instruction exists to prove one toolchain fact:
//!
//! * `ping` — `emit_cpi!` works and the SlotHashes sysvar is readable (the real
//!   program mixes a slot hash into the oracle seed);
//! * `fund_pda` — a system-owned PDA can hold lamports;
//! * `pda_transfer` — that PDA can pay via `invoke_signed` (ORAO's `payer` must
//!   be a signer that funds rent and fees);
//! * `orao_request` — a hand-built CPI into ORAO `request_v2`, with the PDA as
//!   payer, matches ORAO's account layout and fee handling.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("3FLR2XiNRr4WYT8qeac3zu2Xeo6qGvAirtdH9ZNhKC7T");

pub const SLOT_HASHES_SYSVAR_ID: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");

/// ORAO VRF program, identical on mainnet and devnet.
pub const ORAO_VRF_ID: Pubkey = pubkey!("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
pub const ORAO_NETWORK_STATE_SEED: &[u8] = b"orao-vrf-network-configuration";
pub const ORAO_REQUEST_SEED: &[u8] = b"orao-vrf-randomness-request";
/// `sha256("global:request_v2")[..8]`, checked against the vendored IDL in tests.
pub const ORAO_REQUEST_V2_DISCRIMINATOR: [u8; 8] = [38, 151, 209, 6, 195, 102, 28, 217];
/// Byte range of `NetworkState.config.treasury` (8-byte discriminator, 32-byte authority, then treasury).
pub const ORAO_TREASURY_OFFSET: usize = 40;
/// Byte range of `NetworkState.config.request_fee` (u64 little-endian, right after the treasury).
pub const ORAO_REQUEST_FEE_OFFSET: usize = 72;

#[constant]
pub const VRF_PAYER_SEED: &[u8] = b"vrf-payer";

#[program]
pub mod toolchain_smoke {
    use super::*;

    pub fn ping(ctx: Context<Ping>) -> Result<()> {
        let data = ctx.accounts.slot_hashes.try_borrow_data()?;
        let (latest_slot, latest_hash) =
            parse_latest_slothash(&data).ok_or(SmokeError::SlotHashesUnreadable)?;
        emit_cpi!(Pinged {
            version: 1,
            current_slot: Clock::get()?.slot,
            latest_slot,
            latest_hash,
        });
        Ok(())
    }

    pub fn fund_pda(ctx: Context<FundPda>, lamports: u64) -> Result<()> {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.vrf_payer.to_account_info(),
                },
            ),
            lamports,
        )
    }

    pub fn pda_transfer(ctx: Context<PdaTransfer>, lamports: u64) -> Result<()> {
        let payer_key = ctx.accounts.payer.key();
        let seeds: &[&[u8]] = &[VRF_PAYER_SEED, payer_key.as_ref(), &[ctx.bumps.vrf_payer]];
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.vrf_payer.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
                &[seeds],
            ),
            lamports,
        )
    }

    pub fn orao_request(ctx: Context<OraoRequest>, seed: [u8; 32]) -> Result<()> {
        // ORAO checks `treasury == network_state.config.treasury` itself; checking
        // here turns an opaque CPI error into a named one.
        let state = ctx.accounts.network_state.try_borrow_data()?;
        require!(
            state.len() >= ORAO_REQUEST_FEE_OFFSET + 8,
            SmokeError::NetworkStateUnreadable
        );
        let treasury = Pubkey::try_from(&state[ORAO_TREASURY_OFFSET..ORAO_TREASURY_OFFSET + 32])
            .map_err(|_| SmokeError::NetworkStateUnreadable)?;
        require_keys_eq!(
            treasury,
            ctx.accounts.treasury.key(),
            SmokeError::TreasuryMismatch
        );
        drop(state);

        let mut data = Vec::with_capacity(40);
        data.extend_from_slice(&ORAO_REQUEST_V2_DISCRIMINATOR);
        data.extend_from_slice(&seed);
        let ix = Instruction {
            program_id: ORAO_VRF_ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.vrf_payer.key(), true),
                AccountMeta::new(ctx.accounts.network_state.key(), false),
                AccountMeta::new(ctx.accounts.treasury.key(), false),
                AccountMeta::new(ctx.accounts.request.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data,
        };
        let payer_key = ctx.accounts.payer.key();
        let seeds: &[&[u8]] = &[VRF_PAYER_SEED, payer_key.as_ref(), &[ctx.bumps.vrf_payer]];
        invoke_signed(
            &ix,
            &[
                ctx.accounts.vrf_payer.to_account_info(),
                ctx.accounts.network_state.to_account_info(),
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.request.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.orao_program.to_account_info(),
            ],
            &[seeds],
        )?;
        Ok(())
    }
}

/// SlotHashes layout: `u64` count, then `(u64 slot, [u8; 32] hash)` entries,
/// newest first. Only the first entry is read; the sysvar is far too large for
/// `Sysvar::get`.
pub fn parse_latest_slothash(data: &[u8]) -> Option<(u64, [u8; 32])> {
    if data.len() < 8 + 40 {
        return None;
    }
    let count = u64::from_le_bytes(data[0..8].try_into().ok()?);
    if count == 0 {
        return None;
    }
    let slot = u64::from_le_bytes(data[8..16].try_into().ok()?);
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&data[16..48]);
    Some((slot, hash))
}

#[event_cpi]
#[derive(Accounts)]
pub struct Ping<'info> {
    /// CHECK: address pinned to the SlotHashes sysvar; parsed by hand above.
    #[account(address = SLOT_HASHES_SYSVAR_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FundPda<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [VRF_PAYER_SEED, payer.key().as_ref()], bump)]
    pub vrf_payer: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PdaTransfer<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [VRF_PAYER_SEED, payer.key().as_ref()], bump)]
    pub vrf_payer: SystemAccount<'info>,
    #[account(mut)]
    pub recipient: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(seed: [u8; 32])]
pub struct OraoRequest<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [VRF_PAYER_SEED, payer.key().as_ref()], bump)]
    pub vrf_payer: SystemAccount<'info>,
    /// CHECK: ORAO's network state, address derived from ORAO's own seed.
    #[account(mut, seeds = [ORAO_NETWORK_STATE_SEED], bump, seeds::program = orao_program.key())]
    pub network_state: UncheckedAccount<'info>,
    /// CHECK: compared against `network_state.config.treasury` in the handler.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: the request PDA for this seed; ORAO creates it.
    #[account(mut, seeds = [ORAO_REQUEST_SEED, seed.as_ref()], bump, seeds::program = orao_program.key())]
    pub request: UncheckedAccount<'info>,
    /// CHECK: address pinned to the ORAO program.
    #[account(address = ORAO_VRF_ID)]
    pub orao_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct Pinged {
    pub version: u8,
    pub current_slot: u64,
    pub latest_slot: u64,
    pub latest_hash: [u8; 32],
}

#[error_code]
pub enum SmokeError {
    #[msg("SlotHashes sysvar could not be parsed")]
    SlotHashesUnreadable,
    #[msg("ORAO network state could not be parsed")]
    NetworkStateUnreadable,
    #[msg("treasury does not match ORAO network state")]
    TreasuryMismatch,
}
