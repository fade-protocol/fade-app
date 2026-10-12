//! Token and lamport movements shared by several instructions.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::constants::VAULT_AUTHORITY_SEED;
use crate::errors::FadeError;

/// `transfer_checked` out of an account the vault authority owns.
#[allow(clippy::too_many_arguments)]
pub fn vault_transfer<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: AccountInfo<'info>,
    mint: &Account<'info, Mint>,
    authority: AccountInfo<'info>,
    authority_bump: u8,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &[authority_bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to,
                authority,
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

/// `transfer_checked` signed by the owner of `from`.
pub fn user_transfer<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: AccountInfo<'info>,
    mint: &Account<'info, Mint>,
    authority: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to,
                authority,
            },
        ),
        amount,
        mint.decimals,
    )
}

/// Moves lamports out of an account this program owns. The runtime lets a
/// program debit only its own accounts, and credit any writable one.
pub fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    from.sub_lamports(amount)
        .map_err(|_| error!(FadeError::MathOverflow))?;
    to.add_lamports(amount)
        .map_err(|_| error!(FadeError::MathOverflow))?;
    Ok(())
}

/// Whether `info` is an initialised, unfrozen token account of `mint` — one a
/// transfer to it would not fail on.
pub fn is_usdc_account(info: &AccountInfo, mint: &Pubkey) -> bool {
    can_receive(info, mint, None)
}

/// Whether `info` is an initialised, unfrozen token account of `mint`, owned
/// by `owner` when one is given. Never fails: a claim decides from it whether
/// to deliver now or park what it owes.
pub fn can_receive(info: &AccountInfo, mint: &Pubkey, owner: Option<&Pubkey>) -> bool {
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token::spl_token::state::{Account as SplAccount, AccountState};
    if *info.owner != anchor_spl::token::ID || info.data_len() != SplAccount::LEN {
        return false;
    }
    let Ok(data) = info.try_borrow_data() else {
        return false;
    };
    match SplAccount::unpack(&data) {
        Ok(a) => {
            a.mint == *mint
                && a.state == AccountState::Initialized
                && owner.is_none_or(|o| a.owner == *o)
        }
        Err(_) => false,
    }
}

/// Lamports a program-owned account holds above its rent-exempt minimum.
pub fn spare_lamports(info: &AccountInfo) -> Result<u64> {
    let floor = Rent::get()?.minimum_balance(info.data_len());
    Ok(info.lamports().saturating_sub(floor))
}
