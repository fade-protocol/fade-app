//! A stand-in for ORAO VRF in LiteSVM (tests only).
//!
//! `request_v2` reproduces what Fade relies on: the instruction discriminator,
//! the account order, the fee paid to the treasury named in the network state,
//! and a pending `RandomnessV2` account at the seed's PDA, owned by ORAO and
//! paid for by the requester. `fulfill` writes the fulfilled layout, shrinks the
//! account and refunds the excess rent to the client, as ORAO's quorum does.
//! `request` is the deprecated instruction, which on mainnet still creates a
//! legacy `Randomness` at the same address; `fulfill` answers it in place.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use fade_math::orao_layout::{
    FULFILLED_LEN, NETWORK_STATE_SEED, PENDING_LEN, RANDOMNESS_V1_DISCRIMINATOR,
    RANDOMNESS_V2_DISCRIMINATOR, REQUEST_FEE_OFFSET, REQUEST_SEED, TREASURY_OFFSET, V1_LEN,
};

declare_id!("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

#[program]
pub mod orao_mock {
    use super::*;

    pub fn request_v2(ctx: Context<RequestV2>, seed: [u8; 32]) -> Result<()> {
        let (fee, treasury) = {
            let data = ctx.accounts.network_state.try_borrow_data()?;
            let fee = u64::from_le_bytes(
                data[REQUEST_FEE_OFFSET..REQUEST_FEE_OFFSET + 8]
                    .try_into()
                    .unwrap(),
            );
            let treasury = Pubkey::try_from(&data[TREASURY_OFFSET..TREASURY_OFFSET + 32]).unwrap();
            (fee, treasury)
        };
        require_keys_eq!(treasury, ctx.accounts.treasury.key());
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            fee,
        )?;
        let rent = Rent::get()?.minimum_balance(PENDING_LEN);
        let signer: &[&[u8]] = &[REQUEST_SEED, &seed, &[ctx.bumps.request]];
        let request = ctx.accounts.request.to_account_info();
        let system = ctx.accounts.system_program.key();
        if request.lamports() == 0 {
            system_program::create_account(
                CpiContext::new_with_signer(
                    system,
                    system_program::CreateAccount {
                        from: ctx.accounts.payer.to_account_info(),
                        to: request.clone(),
                    },
                    &[signer],
                ),
                rent,
                PENDING_LEN as u64,
                &crate::ID,
            )?;
        } else {
            // What Anchor's `init` does on an address someone already funded.
            let top_up = rent.saturating_sub(request.lamports());
            if top_up > 0 {
                system_program::transfer(
                    CpiContext::new(
                        system,
                        system_program::Transfer {
                            from: ctx.accounts.payer.to_account_info(),
                            to: request.clone(),
                        },
                    ),
                    top_up,
                )?;
            }
            system_program::allocate(
                CpiContext::new_with_signer(
                    system,
                    system_program::Allocate {
                        account_to_allocate: request.clone(),
                    },
                    &[signer],
                ),
                PENDING_LEN as u64,
            )?;
            system_program::assign(
                CpiContext::new_with_signer(
                    system,
                    system_program::Assign {
                        account_to_assign: request.clone(),
                    },
                    &[signer],
                ),
                &crate::ID,
            )?;
        }
        let mut data = ctx.accounts.request.try_borrow_mut_data()?;
        data[..8].copy_from_slice(&RANDOMNESS_V2_DISCRIMINATOR);
        data[8] = 0; // Pending
        data[9..41].copy_from_slice(ctx.accounts.payer.key.as_ref());
        data[41..73].copy_from_slice(&seed);
        Ok(())
    }

    /// The deprecated request: a legacy `Randomness` at the same address.
    pub fn request(ctx: Context<RequestV2>, seed: [u8; 32]) -> Result<()> {
        let rent = Rent::get()?.minimum_balance(V1_LEN);
        let signer: &[&[u8]] = &[REQUEST_SEED, &seed, &[ctx.bumps.request]];
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.request.to_account_info(),
                },
                &[signer],
            ),
            rent,
            V1_LEN as u64,
            &crate::ID,
        )?;
        let mut data = ctx.accounts.request.try_borrow_mut_data()?;
        data[..8].copy_from_slice(&RANDOMNESS_V1_DISCRIMINATOR);
        data[8..40].copy_from_slice(&seed);
        Ok(())
    }

    /// Test-only: the quorum's fulfilment, with the randomness the test picks.
    pub fn fulfill(ctx: Context<Fulfill>, randomness: [u8; 64]) -> Result<()> {
        let request = &ctx.accounts.request;
        if request.try_borrow_data()?[..8] == RANDOMNESS_V1_DISCRIMINATOR {
            // A legacy request is answered in place and keeps its size.
            request.try_borrow_mut_data()?[40..104].copy_from_slice(&randomness);
            return Ok(());
        }
        let (client, seed) = {
            let data = request.try_borrow_data()?;
            require!(data[8] == 0, ErrorCode::ConstraintRaw);
            let client = Pubkey::try_from(&data[9..41]).unwrap();
            let seed: [u8; 32] = data[41..73].try_into().unwrap();
            (client, seed)
        };
        require_keys_eq!(client, ctx.accounts.client.key());
        request.resize(FULFILLED_LEN)?;
        {
            let mut data = request.try_borrow_mut_data()?;
            data[8] = 1; // Fulfilled
            data[41..73].copy_from_slice(&seed);
            data[73..137].copy_from_slice(&randomness);
        }
        let keep = Rent::get()?.minimum_balance(FULFILLED_LEN);
        let excess = request.lamports().saturating_sub(keep);
        request.sub_lamports(excess)?;
        ctx.accounts.client.add_lamports(excess)?;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(seed: [u8; 32])]
pub struct RequestV2<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the network state PDA.
    #[account(mut, seeds = [NETWORK_STATE_SEED], bump)]
    pub network_state: UncheckedAccount<'info>,
    /// CHECK: compared with the network state.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: created here.
    #[account(mut, seeds = [REQUEST_SEED, seed.as_ref()], bump)]
    pub request: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Fulfill<'info> {
    /// CHECK: a request this program owns.
    #[account(mut, owner = crate::ID)]
    pub request: UncheckedAccount<'info>,
    /// CHECK: the request's client, which receives the rent refund.
    #[account(mut)]
    pub client: UncheckedAccount<'info>,
}
