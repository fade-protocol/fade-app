//! What every instruction that can leave a round empty shares: the round's
//! close (Spec 08 §13.2.2), used by `settle_round_tickets`,
//! `return_round_ticket` and `reclaim_sponsorship`. `refund_round` and
//! `expire_round` never close one: a round they end still holds its tickets.

use anchor_lang::prelude::*;

use crate::errors::FadeError;
use crate::state::{Round, RoundStatus};

/// Closes `round` if it has ended — `Drawn`, `Refunded` or `Forfeited` — with
/// no ticket and no sponsorship left: every lamport it holds, its rent and the
/// dust of §13.4's rounding, goes to `rent_payer`, which must be passed and be
/// the round's stored `rent_payer` (`RentReceiverRequired`). Returns the
/// lamports moved when it closed, for `RoundClosed`; `None` otherwise, in
/// which case `rent_payer` is not read.
pub fn close_if_ended<'info>(
    round: &Account<'info, Round>,
    rent_payer: Option<&UncheckedAccount<'info>>,
) -> Result<Option<u64>> {
    let ended = matches!(
        round.status,
        RoundStatus::Drawn | RoundStatus::Refunded | RoundStatus::Forfeited
    );
    if !ended || round.tickets != 0 || round.sponsors != 0 {
        return Ok(None);
    }
    let receiver = rent_payer.ok_or(FadeError::RentReceiverRequired)?;
    require_keys_eq!(
        receiver.key(),
        round.rent_payer,
        FadeError::RentReceiverRequired
    );
    let lamports = round.to_account_info().lamports();
    round.close(receiver.to_account_info())?;
    Ok(Some(lamports))
}
