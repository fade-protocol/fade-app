//! An integrator as Fade expects one: a program that signs `open_ticket` with
//! its `["fade-integrator"]` PDA through `invoke_signed`.
//!
//! `forward` relays any Fade instruction built by the test, with the accounts
//! passed as remaining accounts in Fade's order. It is how the tests exercise
//! both the honest path — the PDA signs — and the attacks: an instruction whose
//! identity is left unsigned, an account marked as a signer that this program
//! cannot sign for, and a liquidity-provider request wrapped in a CPI, which the
//! request's composition check must refuse.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use fade::program::Fade;
use fade::INTEGRATOR_AUTHORITY_SEED;

declare_id!("Ez5aCv6q5XgKuvx2Vot2RdQwz7DHUDULCbE9bEXVktc3");

#[program]
pub mod test_integrator {
    use super::*;

    /// Relays `data` to Fade with the remaining accounts. With `sign`, this
    /// program's PDA signs; `claim_signer`, if set, is marked as a signer
    /// without any seeds, which the runtime must refuse.
    pub fn forward<'info>(
        ctx: Context<'info, Forward<'info>>,
        data: Vec<u8>,
        sign: bool,
        claim_signer: Option<Pubkey>,
    ) -> Result<()> {
        let pda = ctx.accounts.integrator_authority.key();
        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: *a.key,
                is_signer: a.is_signer || (sign && *a.key == pda) || claim_signer == Some(*a.key),
                is_writable: a.is_writable,
            })
            .collect();
        let ix = Instruction {
            program_id: fade::ID,
            accounts: metas,
            data,
        };
        let mut infos = ctx.remaining_accounts.to_vec();
        infos.push(ctx.accounts.fade_program.to_account_info());
        if sign {
            let seeds: &[&[u8]] = &[INTEGRATOR_AUTHORITY_SEED, &[ctx.bumps.integrator_authority]];
            invoke_signed(&ix, &infos, &[seeds])?;
        } else {
            invoke(&ix, &infos)?;
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Forward<'info> {
    /// CHECK: this program's signing PDA.
    #[account(seeds = [INTEGRATOR_AUTHORITY_SEED], bump)]
    pub integrator_authority: UncheckedAccount<'info>,
    pub fade_program: Program<'info, Fade>,
}
