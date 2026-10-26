//! Token and lamport movements, and account creation, shared by several
//! instructions.

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

/// Closes an account this program owns, read from remaining accounts rather
/// than typed: every lamport to `to`, the owner back to the System program,
/// no data. What Anchor's `close` does for a typed account.
pub fn close_account<'info>(info: &AccountInfo<'info>, to: &AccountInfo<'info>) -> Result<()> {
    move_lamports(info, to, info.lamports())?;
    info.assign(&anchor_lang::system_program::ID);
    info.resize(0)?;
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

/// Whether an expiry may be a withheld draw, what `Vault.forfeits_withheld`
/// (rounds) and `Vault.ticket_forfeits_withheld` (direct tickets) count: all
/// but one never requested whose request the program looked for and did not
/// find, which only the keepers' failure explains (Spec 08 §13.10, the
/// alarm's table). The keeper's `classifyExpiry` is the same rule.
pub(crate) fn withheld_forfeit(requested: bool, request_found: bool, checked: bool) -> bool {
    requested || request_found || !checked
}

/// Lamports a program-owned account holds above its rent-exempt minimum.
pub fn spare_lamports(info: &AccountInfo) -> Result<u64> {
    let floor = Rent::get()?.minimum_balance(info.data_len());
    Ok(info.lamports().saturating_sub(floor))
}

/// Creates the program-owned account `target` at the PDA `signer_seeds` (the
/// bump included), `space` bytes, rent-exempt, paid by `payer`: what Anchor's
/// `init` generates, for an address known only in the handler. An address
/// already holding lamports is created over, as `init` does: topped up to the
/// rent-exempt minimum, then allocated and assigned, which the System program
/// refuses for an account that is not a system account without data. The
/// caller has derived `target` from `signer_seeds` and checked that the
/// program does not own it yet.
pub fn create_pda_account<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    space: usize,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    use anchor_lang::system_program::{
        allocate, assign, create_account, transfer, Allocate, Assign, CreateAccount, Transfer,
    };
    let rent = Rent::get()?.minimum_balance(space);
    let space_u64 = u64::try_from(space).map_err(|_| error!(FadeError::MathOverflow))?;
    let current = target.lamports();
    if current == 0 {
        return create_account(
            CpiContext::new_with_signer(
                system_program.key(),
                CreateAccount {
                    from: payer.clone(),
                    to: target.clone(),
                },
                &[signer_seeds],
            ),
            rent,
            space_u64,
            &crate::ID,
        );
    }
    require_keys_neq!(
        payer.key(),
        target.key(),
        anchor_lang::error::ErrorCode::TryingToInitPayerAsProgramAccount
    );
    let top_up = rent.max(1).saturating_sub(current);
    if top_up > 0 {
        transfer(
            CpiContext::new(
                system_program.key(),
                Transfer {
                    from: payer.clone(),
                    to: target.clone(),
                },
            ),
            top_up,
        )?;
    }
    allocate(
        CpiContext::new_with_signer(
            system_program.key(),
            Allocate {
                account_to_allocate: target.clone(),
            },
            &[signer_seeds],
        ),
        space_u64,
    )?;
    assign(
        CpiContext::new_with_signer(
            system_program.key(),
            Assign {
                account_to_assign: target.clone(),
            },
            &[signer_seeds],
        ),
        &crate::ID,
    )
}
