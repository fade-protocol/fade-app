//! `register_payout_table` (Spec 08 §13.5.1): a payout table stored once, at
//! the address of its hash, for beacon tickets to reference. Anyone may call
//! it, never paused: it moves no funds but the payer's rent, and a stored
//! table admits nothing by itself, since every join re-checks its margin
//! against the ticket's shares and the live parameters.

use anchor_lang::prelude::*;
use anchor_lang::{AccountDeserialize, AccountSerialize};
use fade_math::{beacon, payout_table};

use crate::constants::*;
use crate::errors::{FadeError, OrFade};
use crate::events::PayoutTableRegistered;
use crate::instructions::common::create_pda_account;
use crate::state::{Outcome, PayoutTable};

#[event_cpi]
#[derive(Accounts)]
pub struct RegisterPayoutTable<'info> {
    /// Pays the account's rent, for good: a payout table is never closed.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: `["payout-table", hash(outcomes)]`, the hash computed in the
    /// handler from the argument after the table is validated, never taken
    /// from the caller; created there, or read if the program owns it already.
    #[account(mut)]
    pub payout_table: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// The table's hash: `SHA256` of `beacon::payout_table_preimage`.
/// `OutcomeCount` for no outcome or more than 32.
pub fn payout_table_hash(outcomes: &[payout_table::Outcome]) -> Result<[u8; 32]> {
    let (buf, len) = beacon::payout_table_preimage(outcomes).or_fade()?;
    let bytes = buf.get(..len).ok_or(FadeError::MathOverflow)?;
    Ok(solana_sha256_hasher::hashv(&[bytes]).to_bytes())
}

pub fn register_payout_table(
    ctx: Context<RegisterPayoutTable>,
    outcomes: Vec<Outcome>,
) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );

    // --- the table: shape, sums, ceiling, and no overpaying --------------------
    let table: Vec<payout_table::Outcome> = outcomes
        .iter()
        .map(|b| payout_table::Outcome { p: b.p, m: b.m })
        .collect();
    let summary = payout_table::validate(&table).or_fade()?;
    // `margin_bps` is `None` exactly when `Σ p·m > P_SCALE × BPS`, as in `open_ticket`.
    require!(
        payout_table::margin_bps(summary.lhs).is_some(),
        FadeError::PayoutTableOverpays
    );
    let len = u8::try_from(summary.len).map_err(|_| error!(FadeError::OutcomeCount))?;

    // --- its address, from the hash of the argument ----------------------------
    let hash = payout_table_hash(&table)?;
    let (address, bump) =
        Pubkey::find_program_address(&[PAYOUT_TABLE_SEED, hash.as_ref()], &crate::ID);
    let info = ctx.accounts.payout_table.to_account_info();
    require_keys_eq!(info.key(), address, FadeError::WrongPayoutTable);

    // --- registered already: nothing to write ------------------------------------
    if *info.owner == crate::ID {
        // The owner and the discriminator, checked by the deserialisation; the
        // hash, though the address already binds it.
        let data = info.try_borrow_data()?;
        let stored = PayoutTable::try_deserialize(&mut &data[..])?;
        require!(stored.hash == hash, FadeError::WrongPayoutTable);
        return Ok(());
    }
    // Anything else at the address must be a system account, possibly pre-funded.
    require_keys_eq!(
        *info.owner,
        anchor_lang::system_program::ID,
        FadeError::WrongPayoutTable
    );

    // --- create it ----------------------------------------------------------------
    let mut stored = [Outcome::default(); 32];
    for (slot, o) in stored.iter_mut().zip(outcomes.iter()) {
        *slot = *o;
    }
    create_pda_account(
        &ctx.accounts.payer.to_account_info(),
        &info,
        &ctx.accounts.system_program,
        8 + PayoutTable::INIT_SPACE,
        &[PAYOUT_TABLE_SEED, hash.as_ref(), &[bump]],
    )?;
    let account = PayoutTable {
        version: ACCOUNT_VERSION,
        bump,
        len,
        lhs: summary.lhs,
        max_m: summary.max_m,
        hash,
        outcomes: stored,
    };
    {
        let mut data = info.try_borrow_mut_data()?;
        account.try_serialize(&mut &mut data[..])?;
    }

    emit_cpi!(PayoutTableRegistered {
        version: EVENT_VERSION,
        payout_table: address,
        hash,
        len,
        lhs: summary.lhs,
        max_m: summary.max_m,
        outcomes,
    });
    Ok(())
}
