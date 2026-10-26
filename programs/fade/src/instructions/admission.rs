//! Admission, shared by both paths (Spec 08 §13.1): `open_ticket` and
//! `join_round` run the same payout-table margin checks, the same drawdown
//! gate, the same `risk::ticket_for` and `risk::admit`, and book an admitted
//! ticket into `Vault` and `Integrator` the same way. What differs stays in
//! each instruction: the direct path pays its shares out and enters the epoch
//! counters at open; the beacon holds its shares and enters them at its
//! round's request, and replaces `min_price` with its round's snapshot.

use anchor_lang::prelude::*;
use fade_math::drawdown::Ring;
use fade_math::orao_layout;
use fade_math::risk::{self, Admission};
use fade_math::{payout_table, BPS};

use crate::constants::{ACCOUNT_VERSION, DRAWDOWN_AFTERMATH_SECONDS, ORAO_VRF_ID};
use crate::errors::{FadeError, OrFade};
use crate::state::{Integrator, RiskParams, Vault};

/// What a payout table earns, from its `Σ p·m`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Margin {
    /// The table's margin, in bps.
    pub margin_bps: u64,
    /// What the vault earns after the protocol and app shares: what the
    /// per-ticket cap is computed on.
    pub vault_margin_bps: u64,
}

/// The payout table keeps its margin for this app share under the live
/// parameters: not overpaying (`PayoutTableOverpays`), the split
/// (`AppShareTooHigh`, `MarginFloor`), then the invariant itself, exactly:
/// `Σ p·m ≤ (1 − floor − shares)` in `u128` (`MarginFloor`).
pub fn check_margin(lhs: u128, app_share_bps: u64, params: &RiskParams) -> Result<Margin> {
    let margin = payout_table::margin_bps(lhs).ok_or(FadeError::PayoutTableOverpays)?;
    let vault_margin = risk::check_split(margin, app_share_bps, &params.to_math()).or_fade()?;
    let floor = params
        .min_vault_margin_bps
        .checked_add(params.protocol_share_bps)
        .and_then(|v| v.checked_add(app_share_bps))
        .ok_or(FadeError::MathOverflow)?;
    require!(floor <= BPS, FadeError::MarginFloor);
    require!(payout_table::ev_ok(lhs, floor), FadeError::MarginFloor);
    Ok(Margin {
        margin_bps: margin,
        vault_margin_bps: vault_margin,
    })
}

/// The drawdown ring as observed now, and whether caps are halved.
pub struct Gate {
    pub ring: Ring,
    pub halved: bool,
}

/// The drawdown breaker at the settled price: tripped → `DrawdownBreaker`;
/// within the 48-hour aftermath of the last trip, caps are halved. Opening
/// moves no settled asset: the credit is both owned and at risk.
pub fn drawdown_gate(vault: &Vault, drawdown_bps: u64, now: i64) -> Result<Gate> {
    let share_price = vault.settled_price().or_fade()?;
    let mut ring = vault.ring();
    ring.observe(now, share_price, share_price);
    require!(
        !ring.tripped(share_price, drawdown_bps),
        FadeError::DrawdownBreaker
    );
    let halved = vault.drawdown_trip_ts != 0
        && now
            < vault
                .drawdown_trip_ts
                .checked_add(DRAWDOWN_AFTERMATH_SECONDS)
                .ok_or(FadeError::MathOverflow)?;
    Ok(Gate { ring, halved })
}

/// `risk::ticket_for`, then `risk::admit` against the vault and the integrator
/// as they stand: `PriceBounds`, `PerTicketCap`, `IntegratorCap`,
/// `UtilisationBreaker`, `GlobalExposure`, `Insolvent`, in that order.
#[allow(clippy::too_many_arguments)]
pub fn admit(
    vault: &Vault,
    integrator: &Integrator,
    math: &risk::Params,
    price: u64,
    max_m: u64,
    app_share_bps: u64,
    vault_margin_bps: u64,
    halved: bool,
) -> Result<(risk::Ticket, Admission)> {
    let w = risk::ticket_for(price, max_m, app_share_bps, math).or_fade()?;
    let integrator_math = risk::Integrator {
        reserved: integrator.reserved_liability,
        volume_total: integrator.volume_total,
    };
    let admission = risk::admit(
        &vault.math(),
        &integrator_math,
        math,
        &w,
        vault_margin_bps,
        halved,
    )
    .or_fade()?;
    Ok((w, admission))
}

/// Books an admitted ticket: the vault's assets, reservation and open credits
/// as admission computed them, the observed ring, the integrator count if this
/// ticket created its record; the integrator's reservation, open tickets and
/// nonce. Volume and the epoch counters are each path's own.
pub fn book(
    vault: &mut Vault,
    integrator: &mut Integrator,
    admission: &Admission,
    ring: &Ring,
    created: bool,
) -> Result<()> {
    let after = admission.vault_after;
    vault.total_assets = after.assets;
    vault.total_reserved_liability = after.reserved;
    vault.open_vault_credits = after.open_credits;
    vault.set_ring(ring);
    if created {
        vault.integrators = vault.integrators.saturating_add(1);
    }
    integrator.reserved_liability = integrator
        .reserved_liability
        .checked_add(admission.liability)
        .ok_or(FadeError::MathOverflow)?;
    integrator.open_tickets = integrator
        .open_tickets
        .checked_add(1)
        .ok_or(FadeError::MathOverflow)?;
    integrator.next_nonce = integrator
        .next_nonce
        .checked_add(1)
        .ok_or(FadeError::MathOverflow)?;
    Ok(())
}

/// Fills a record `init_if_needed` has just created, never one that exists:
/// the caller checks `version == 0` first.
pub fn enrol(
    integrator: &mut Integrator,
    authority: Pubkey,
    share_account: Pubkey,
    bump: u8,
    now: i64,
) {
    integrator.version = ACCOUNT_VERSION;
    integrator.bump = bump;
    integrator.authority = authority;
    integrator.share_account = share_account;
    integrator.created_at = now;
}

/// ORAO's request fee, read from its network state at the pinned address
/// (the caller's seeds constraint), owner checked: never set by Fade.
pub fn orao_fee(network: &AccountInfo) -> Result<u64> {
    require_keys_eq!(
        *network.owner,
        ORAO_VRF_ID,
        FadeError::NetworkStateUnreadable
    );
    let state = orao_layout::network_state(&network.try_borrow_data()?)
        .ok_or(FadeError::NetworkStateUnreadable)?;
    Ok(state.request_fee)
}

/// The rent a pending ORAO request account advances, from the Rent sysvar.
pub fn pending_request_rent() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(orao_layout::PENDING_LEN))
}
