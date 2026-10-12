//! Caps, admission and the solvency identities.
//!
//! Units: amounts in the token's base unit, ratios in bps. The vault tracks
//! three numbers: `assets` (everything it owns), `reserved` (net liability of
//! open tickets, `Σ payout_max − vault_credit`) and `open_credits` (`Σ vault_credit`
//! of open tickets). Gross solvency is `reserved + open_credits ≤ assets`: the
//! vault can pay every open ticket's maximum at once.

use crate::{payout_table, Reject, BPS};

/// Vault-level counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Vault {
    /// Total assets owned by the vault, including open tickets' credited ticket prices.
    pub assets: u64,
    /// Net liability reserved by open tickets.
    pub reserved: u64,
    /// Ticket prices credited by open tickets, still at risk of being paid back out.
    pub open_credits: u64,
}

/// Integrator-level counters. Nothing is deposited to obtain capacity: the
/// ceiling is a share of the vault, and optionally a credit earned by volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Integrator {
    /// Net liability reserved by this integrator's open tickets.
    pub reserved: u64,
    /// Cumulative ticket price this integrator has opened, from its first ticket.
    pub volume_total: u64,
}

/// Governable risk parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Params {
    /// Fraction of the Kelly-optimal liability a ticket may take, in bps (5000 = half-Kelly).
    pub kelly_fraction_bps: u64,
    /// Flat ceiling on liability as a fraction of vault assets, in bps.
    pub censorship_bps: u64,
    /// Aggregate liability of one integrator as a fraction of vault assets, in bps.
    pub whale_bps: u64,
    /// Committed fraction of assets above which new tickets are refused, in bps.
    pub utilisation_breaker_bps: u64,
    /// Reserved liability as a fraction of assets that may never be exceeded, in bps.
    pub kappa_bps: u64,
    /// Smallest ticket price. Derived, not chosen: the fixed per-ticket overhead the
    /// payer pays in SOL (oracle fee + locked rent + crank fee) must not exceed
    /// the vault's expected take at the 150 bps reference margin. Once SIMD-0437
    /// is fully active, 934 440 lamports of overhead at 120 USD/SOL give about
    /// 7.5 USDC.
    pub min_price: u64,
    /// Largest ticket price.
    pub max_price: u64,
    /// Smallest share of the ticket price the vault must earn in expectation, in bps.
    pub min_vault_margin_bps: u64,
    /// Protocol share taken from the ticket price at open, in bps.
    pub protocol_share_bps: u64,
    /// Largest app share, in bps.
    pub max_app_share_bps: u64,
    /// Progressive credit (Spec 04 §4.3): specified, off in V1. When on, an
    /// integrator's ceiling is also bounded by `credit_base + credit_rate · volume`.
    pub credit_enabled: bool,
    /// Capacity of an integrator with no volume yet, in the token's base unit.
    pub credit_base: u64,
    /// Capacity earned per unit of ticket price opened, in bps.
    pub credit_rate_bps: u64,
}

impl Params {
    /// The specification's values (Technical Specification §2), USDC in micro-units.
    pub const SPEC: Params = Params {
        kelly_fraction_bps: 5_000,
        censorship_bps: 150,
        whale_bps: 2_000,
        utilisation_breaker_bps: 7_000,
        kappa_bps: 8_000,
        min_price: 7_500_000,
        max_price: 10_000_000_000,
        min_vault_margin_bps: crate::MIN_VAULT_MARGIN_BPS,
        protocol_share_bps: crate::PROTOCOL_SHARE_BPS,
        max_app_share_bps: crate::MAX_APP_SHARE_BPS,
        credit_enabled: false,
        credit_base: 0,
        credit_rate_bps: 0,
    };
}

/// A ticket as seen by admission: the gross ticket price, what the vault is credited
/// after shares, and the largest payout the payout table allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ticket {
    /// Gross ticket price.
    pub price: u64,
    /// Ticket price minus the shares paid out at open; what actually enters the vault.
    pub vault_credit: u64,
    /// `payout(price, max_m)`.
    pub payout_max: u64,
}

/// What admission decided, and the counters after opening.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Admission {
    /// Net liability reserved for this ticket.
    pub liability: u64,
    /// The per-ticket cap that applied.
    pub cap: u64,
    /// Vault counters after the ticket is opened.
    pub vault_after: Vault,
}

fn mul_bps(amount: u64, bps: u64) -> Result<u64, Reject> {
    let v = u128::from(amount)
        .checked_mul(u128::from(bps))
        .ok_or(Reject::Overflow)?;
    u64::try_from(v.checked_div(u128::from(BPS)).ok_or(Reject::Overflow)?)
        .map_err(|_| Reject::Overflow)
}

/// The margin the vault actually earns on a ticket: the payout table's margin net of the
/// shares paid out at open. `None` if the shares exceed the margin.
pub fn vault_margin_bps(
    margin_bps: u64,
    app_share_bps: u64,
    protocol_share_bps: u64,
) -> Option<u64> {
    margin_bps
        .checked_sub(app_share_bps)?
        .checked_sub(protocol_share_bps)
}

/// Checks the margin split: the app share is within bounds and the vault margin
/// covers the vault margin floor. Returns the vault margin, which is what the cap is
/// computed on.
pub fn check_split(margin_bps: u64, app_share_bps: u64, params: &Params) -> Result<u64, Reject> {
    if app_share_bps > params.max_app_share_bps {
        return Err(Reject::AppShare);
    }
    let vault_margin = vault_margin_bps(margin_bps, app_share_bps, params.protocol_share_bps)
        .ok_or(Reject::MarginFloor)?;
    if vault_margin < params.min_vault_margin_bps {
        return Err(Reject::MarginFloor);
    }
    Ok(vault_margin)
}

/// Assets not committed to any open ticket.
pub fn free_balance(vault: &Vault) -> u64 {
    vault
        .assets
        .saturating_sub(vault.reserved)
        .saturating_sub(vault.open_credits)
}

/// Net liability of a ticket: what the vault may still have to pay beyond what
/// it was credited. Zero when every multiplier is below 1×.
pub fn liability(payout_max: u64, vault_credit: u64) -> u64 {
    payout_max.saturating_sub(vault_credit)
}

/// `min(kelly_fraction · margin · free_balance, censorship_bps · assets)`, halved
/// while the drawdown breaker's aftermath lasts (Spec 04 §7.3). `margin_bps` is
/// the margin the vault actually earns on this ticket — the payout table's margin net of
/// shares, from `check_split` — never the margin the integrator declares.
pub fn per_ticket_cap(
    vault: &Vault,
    margin_bps: u64,
    params: &Params,
    halved: bool,
) -> Result<u64, Reject> {
    let free = free_balance(vault);
    let kelly = mul_bps(mul_bps(free, margin_bps)?, params.kelly_fraction_bps)?;
    let censor = mul_bps(vault.assets, params.censorship_bps)?;
    let cap = kelly.min(censor);
    Ok(if halved { cap / 2 } else { cap })
}

/// The most net liability one integrator may hold: `whale_bps · assets`, and,
/// once progressive credit is on, no more than `credit_base + credit_rate ·
/// volume_total` either.
pub fn integrator_ceiling(
    integrator: &Integrator,
    vault: &Vault,
    params: &Params,
) -> Result<u64, Reject> {
    let by_whale = mul_bps(vault.assets, params.whale_bps)?;
    if !params.credit_enabled {
        return Ok(by_whale);
    }
    let earned = mul_bps(integrator.volume_total, params.credit_rate_bps)?;
    let by_credit = params.credit_base.saturating_add(earned);
    Ok(by_whale.min(by_credit))
}

/// The admission decision, in the order the specification fixes: ticket price
/// bounds, per-ticket cap, integrator ceiling, utilisation breaker, κ, then
/// gross solvency. The payout table itself is validated before this (`payout_table`).
/// `halved` halves the per-ticket cap (the drawdown breaker's aftermath).
pub fn admit(
    vault: &Vault,
    integrator: &Integrator,
    params: &Params,
    w: &Ticket,
    margin_bps: u64,
    halved: bool,
) -> Result<Admission, Reject> {
    if w.price < params.min_price || w.price > params.max_price {
        return Err(Reject::PriceBounds);
    }
    if w.vault_credit > w.price {
        return Err(Reject::Overflow);
    }
    let liability = liability(w.payout_max, w.vault_credit);
    let cap = per_ticket_cap(vault, margin_bps, params, halved)?;
    if liability > cap {
        return Err(Reject::PerTicketCap);
    }
    let integrator_after = integrator
        .reserved
        .checked_add(liability)
        .ok_or(Reject::Overflow)?;
    if integrator_after > integrator_ceiling(integrator, vault, params)? {
        return Err(Reject::IntegratorCap);
    }
    let vault_after = Vault {
        assets: vault
            .assets
            .checked_add(w.vault_credit)
            .ok_or(Reject::Overflow)?,
        reserved: vault
            .reserved
            .checked_add(liability)
            .ok_or(Reject::Overflow)?,
        open_credits: vault
            .open_credits
            .checked_add(w.vault_credit)
            .ok_or(Reject::Overflow)?,
    };
    let committed = vault_after
        .reserved
        .checked_add(vault_after.open_credits)
        .ok_or(Reject::Overflow)?;
    // utilisation: committed / assets ≤ breaker
    if u128::from(committed).saturating_mul(u128::from(BPS))
        > u128::from(vault_after.assets).saturating_mul(u128::from(params.utilisation_breaker_bps))
    {
        return Err(Reject::UtilisationBreaker);
    }
    // κ: reserved / assets ≤ κ
    if u128::from(vault_after.reserved).saturating_mul(u128::from(BPS))
        > u128::from(vault_after.assets).saturating_mul(u128::from(params.kappa_bps))
    {
        return Err(Reject::GlobalExposure);
    }
    // gross solvency: every open ticket could be paid in full at once
    if committed > vault_after.assets {
        return Err(Reject::Insolvent);
    }
    Ok(Admission {
        liability,
        cap,
        vault_after,
    })
}

/// The most that may leave the vault (withdrawal or epoch strike) while keeping
/// gross solvency and `reserved ≤ κ · assets`.
pub fn withdrawable(vault: &Vault, params: &Params) -> u64 {
    let committed = vault.reserved.saturating_add(vault.open_credits);
    // assets needed so that reserved ≤ κ · assets: ceil(reserved · BPS / κ)
    let for_kappa = if params.kappa_bps == 0 {
        u64::MAX
    } else {
        let num = u128::from(vault.reserved).saturating_mul(u128::from(BPS));
        u64::try_from(num.div_ceil(u128::from(params.kappa_bps))).unwrap_or(u64::MAX)
    };
    vault.assets.saturating_sub(committed.max(for_kappa))
}

/// The ticket `open_ticket` builds from a ticket price: both shares come off the ticket price at
/// open, and the worst case the vault must cover is the payout table's largest
/// multiplier. Rounding is the protocol's: each share is floored, so the dust
/// stays with the vault, and the payout is floored, so the vault never owes more
/// than the payout table promised.
pub fn ticket_for(
    price: u64,
    max_m_bps: u64,
    app_share_bps: u64,
    params: &Params,
) -> Result<Ticket, Reject> {
    let app_share = payout_table::share_of(price, app_share_bps)?;
    let protocol_share = payout_table::share_of(price, params.protocol_share_bps)?;
    let vault_credit = price
        .checked_sub(app_share)
        .and_then(|v| v.checked_sub(protocol_share))
        .ok_or(Reject::Overflow)?;
    Ok(Ticket {
        price,
        vault_credit,
        payout_max: payout_table::payout(price, max_m_bps)?,
    })
}

/// The largest ticket price this payout table can carry against the vault as it stands —
/// the inverse of `admit`.
///
/// Admission caps the vault's **liability**, never the multiplier, so on a fixed
/// payout table the multiplier and the ticket price trade against each other: the same cap
/// that refuses 25 USDC at 1 000× accepts 1 USDC at the same 1 000×. An
/// interface that can ask this question offers "maximum ticket price for this payout table"
/// — the form every operator already uses — instead of letting a user submit a
/// ticket that is refused at open.
///
/// **Why a search and not a formula.** Six constraints bind, three of them with
/// the ticket price on both sides of the comparison, and every one of them carries a
/// floored division. A closed form would have to reproduce each rounding
/// exactly or it would disagree with `admit` by a micro-unit, in whichever
/// direction the reader least expects. Searching on `admit` itself cannot
/// disagree with it.
///
/// **Why a search terminates on the right answer.** Admission is monotone in
/// the ticket price. Every quantity it compares grows with the ticket price at a rate of
/// either `max_m` or `1 − shares` per unit, while every bound it compares them
/// against grows at `(1 − shares)` scaled by a factor strictly below one — the
/// utilisation breaker, κ, or one for gross solvency — and the per-ticket cap
/// and the integrator ceiling are read from the vault before the ticket and do
/// not move at all. So the admissible ticket prices are exactly an interval starting
/// at `min_price`, and its upper end is what this returns.
///
/// Returns the reason `admit` gives at `min_price` when no ticket price is admissible
/// at all, which is the reason worth showing: `PerTicketCap` means the vault is
/// too small for this payout table, `PriceBounds` means the multiplier is only
/// reachable below the minimum ticket price.
pub fn max_admissible_price(
    vault: &Vault,
    integrator: &Integrator,
    params: &Params,
    max_m_bps: u64,
    app_share_bps: u64,
    margin_bps: u64,
    halved: bool,
) -> Result<u64, Reject> {
    let admits = |price: u64| -> Result<(), Reject> {
        let w = ticket_for(price, max_m_bps, app_share_bps, params)?;
        admit(vault, integrator, params, &w, margin_bps, halved).map(|_| ())
    };
    admits(params.min_price)?;
    if admits(params.max_price).is_ok() {
        return Ok(params.max_price);
    }
    // Invariant: `lo` is admissible and `hi + 1` is not. The upper midpoint
    // keeps `mid > lo` whenever `hi > lo`, so the range always shrinks.
    let mut lo = params.min_price;
    let mut hi = params.max_price.saturating_sub(1);
    while lo < hi {
        let mid = lo.saturating_add(hi.saturating_sub(lo).saturating_add(1) / 2);
        if admits(mid).is_ok() {
            lo = mid;
        } else {
            hi = mid.saturating_sub(1);
        }
    }
    Ok(lo)
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    const P: Params = Params::SPEC;
    fn vault(assets: u64) -> Vault {
        Vault {
            assets,
            reserved: 0,
            open_credits: 0,
        }
    }
    fn integ(reserved: u64) -> Integrator {
        Integrator {
            reserved,
            volume_total: 0,
        }
    }

    #[test]
    fn cap_is_half_kelly_on_free_balance_at_the_floor_margin() {
        // 175k vault, margin 150 bps: half-Kelly = 0.5 · 1.5 % · 175k = 1 312.5 → 1 312.500000 USDC
        let p = vault(175_000_000_000);
        assert_eq!(per_ticket_cap(&p, 150, &P, false).unwrap(), 1_312_500_000);
        // a 3 % payout table hits the 150 bps censorship ceiling: 0.5 · 3 % = 1.5 % of free = same as ceiling
        assert_eq!(per_ticket_cap(&p, 300, &P, false).unwrap(), 2_625_000_000);
        // 4 % payout table: kelly term 3 500 > ceiling 2 625 → ceiling binds
        assert_eq!(per_ticket_cap(&p, 400, &P, false).unwrap(), 2_625_000_000);
        // utilisation shrinks the kelly term, not the ceiling
        let busy = Vault {
            assets: 175_000_000_000,
            reserved: 87_500_000_000,
            open_credits: 0,
        };
        assert_eq!(per_ticket_cap(&busy, 150, &P, false).unwrap(), 656_250_000);
        // the drawdown breaker's aftermath halves whichever term binds
        assert_eq!(per_ticket_cap(&p, 400, &P, true).unwrap(), 1_312_500_000);
    }

    #[test]
    fn admission_order_and_reasons() {
        let p = vault(100_000_000_000);
        let ok = Ticket {
            price: 50_000_000,
            vault_credit: 49_650_000,
            payout_max: 540_000_000,
        };
        let a = admit(&p, &integ(0), &P, &ok, 150, false).unwrap();
        assert_eq!(a.liability, 540_000_000 - 49_650_000);
        assert_eq!(
            a.vault_after,
            Vault {
                assets: 100_049_650_000,
                reserved: 490_350_000,
                open_credits: 49_650_000
            }
        );

        assert_eq!(
            admit(
                &p,
                &integ(0),
                &P,
                &Ticket {
                    price: 7_499_999,
                    ..ok
                },
                150,
                false
            ),
            Err(Reject::PriceBounds)
        );
        assert_eq!(
            admit(
                &p,
                &integ(0),
                &P,
                &Ticket {
                    payout_max: 990_000_000,
                    ..ok
                },
                150,
                false
            ),
            Err(Reject::PerTicketCap)
        );
        // the ceiling is 20 % of assets, 20 000 USDC here, the new ticket included
        assert!(admit(&p, &integ(19_509_650_000), &P, &ok, 150, false).is_ok());
        assert_eq!(
            admit(&p, &integ(19_509_650_001), &P, &ok, 150, false),
            Err(Reject::IntegratorCap)
        );
        // a vault almost fully committed trips the breaker before κ
        let busy = Vault {
            assets: 100_000_000_000,
            reserved: 60_000_000_000,
            open_credits: 10_000_000_000,
        };
        let small = Ticket {
            price: 25_000_000,
            vault_credit: 25_000_000,
            payout_max: 50_000_000,
        };
        assert_eq!(
            admit(&busy, &integ(0), &P, &small, 150, false).unwrap_err(),
            Reject::UtilisationBreaker
        );
    }

    #[test]
    fn progressive_credit_bounds_the_ceiling_only_once_enabled() {
        let p = vault(100_000_000_000);
        let i = Integrator {
            reserved: 0,
            volume_total: 4_000_000_000,
        };
        assert_eq!(integrator_ceiling(&i, &p, &P).unwrap(), 20_000_000_000);
        let on = Params {
            credit_enabled: true,
            credit_base: 100_000_000,
            credit_rate_bps: 1_000,
            ..P
        };
        // 100 USDC of base plus 10 % of 4 000 USDC opened
        assert_eq!(integrator_ceiling(&i, &p, &on).unwrap(), 500_000_000);
        // …and never above the 20 % term
        let whale = Integrator {
            reserved: 0,
            volume_total: u64::MAX,
        };
        assert_eq!(integrator_ceiling(&whale, &p, &on).unwrap(), 20_000_000_000);
        let w = Ticket {
            price: 50_000_000,
            vault_credit: 49_650_000,
            payout_max: 540_000_000,
        };
        assert!(admit(&p, &i, &on, &w, 150, false).is_ok());
        let fresh = Integrator {
            reserved: 0,
            volume_total: 0,
        };
        assert_eq!(
            admit(&p, &fresh, &on, &w, 150, false),
            Err(Reject::IntegratorCap)
        );
    }

    #[test]
    fn split_and_vault_margin() {
        assert_eq!(check_split(350, 50, &P), Ok(280));
        assert_eq!(check_split(170, 50, &P), Ok(100));
        assert_eq!(check_split(169, 50, &P), Err(Reject::MarginFloor));
        assert_eq!(check_split(60, 50, &P), Err(Reject::MarginFloor));
        assert_eq!(check_split(1_000, 501, &P), Err(Reject::AppShare));
        assert_eq!(vault_margin_bps(10, 20, 0), None);
    }

    #[test]
    fn ticket_for_takes_both_fees_off_the_price() {
        // 25 USDC at 3.79×, 50 bps to the integrator and 20 bps to the protocol:
        // 0.125 + 0.05 leave in the same transaction, so the vault is credited 24.825.
        let w = ticket_for(25_000_000, 37_900, 50, &P).unwrap();
        assert_eq!(w.vault_credit, 24_825_000);
        assert_eq!(w.payout_max, 94_750_000);
        assert_eq!(liability(w.payout_max, w.vault_credit), 69_925_000);
    }

    #[test]
    fn max_admissible_price_reproduces_the_demo_matrix() {
        // The demo slot: 3.50 % declared, 50 bps to the integrator, 280 bps to the vault.
        const APP_SHARE: u64 = 50;
        const VAULT_MARGIN: u64 = 280;
        let i = integ(0);

        // The founding vault, 5 000 USDC: a 70 USDC cap, and the slot's 3.79× top
        // is reachable up to just over 25 USDC.
        let founding = vault(5_000_000_000);
        assert_eq!(
            per_ticket_cap(&founding, VAULT_MARGIN, &P, false).unwrap(),
            70_000_000
        );
        assert_eq!(
            max_admissible_price(&founding, &i, &P, 37_900, APP_SHARE, VAULT_MARGIN, false),
            Ok(25_026_815)
        );
        // While the drawdown breaker's aftermath halves the cap, the same top
        // still fits on half the ticket price.
        assert_eq!(
            max_admissible_price(&founding, &i, &P, 37_900, APP_SHARE, VAULT_MARGIN, true),
            Ok(12_513_407)
        );

        // The same vault carries a 10× ticket only just above the 7.5 USDC
        // minimum: a 25 USDC 10× ticket, 225.18 of liability against a cap of
        // 70, is refused…
        assert_eq!(
            max_admissible_price(&founding, &i, &P, 100_000, APP_SHARE, VAULT_MARGIN, false),
            Ok(7_771_733)
        );
        // …and while the cap is halved, not even the minimum fits.
        assert_eq!(
            max_admissible_price(&founding, &i, &P, 100_000, APP_SHARE, VAULT_MARGIN, true),
            Err(Reject::PerTicketCap)
        );

        // A live deposit taking the vault to 25 000 USDC admits the 25 USDC 10×
        // ticket. That is the demo's closing scene, in one call.
        let after_deposit = vault(25_000_000_000);
        assert_eq!(
            max_admissible_price(
                &after_deposit,
                &i,
                &P,
                100_000,
                APP_SHARE,
                VAULT_MARGIN,
                false
            ),
            Ok(38_858_665)
        );
    }

    #[test]
    fn max_admissible_price_names_the_constraint_that_binds() {
        const APP_SHARE: u64 = 50;
        const VAULT_MARGIN: u64 = 280;

        // 1 000× on a 25 USDC ticket needs 1.78 M of assets (Technical
        // Specification §4): the cap, not any deposit, is what binds.
        let big = vault(1_784_000_000_000);
        assert_eq!(
            max_admissible_price(
                &big,
                &integ(0),
                &P,
                10_000_000,
                APP_SHARE,
                VAULT_MARGIN,
                false
            ),
            Ok(25_000_825)
        );
        // An integrator already holding most of its 20 % is stopped by its ceiling.
        assert_eq!(
            max_admissible_price(
                &big,
                &integ(356_000_000_000),
                &P,
                10_000_000,
                APP_SHARE,
                VAULT_MARGIN,
                false
            ),
            Err(Reject::IntegratorCap)
        );

        // A 71 400 USDC vault carries 999.60 of liability — enough for 1 000× on a
        // 1 USDC ticket. The 7.5 USDC minimum ticket price is what forbids it, not the
        // vault: on a fixed cap the multiplier is the cap divided by the ticket price.
        let small = vault(71_400_000_000);
        assert_eq!(
            per_ticket_cap(&small, VAULT_MARGIN, &P, false).unwrap(),
            999_600_000
        );
        assert_eq!(
            max_admissible_price(
                &small,
                &integ(0),
                &P,
                10_000_000,
                APP_SHARE,
                VAULT_MARGIN,
                false
            ),
            Err(Reject::PerTicketCap)
        );
    }

    #[test]
    fn max_admissible_price_is_the_last_price_admission_accepts() {
        let p = vault(5_000_000_000);
        let i = integ(0);
        let s = max_admissible_price(&p, &i, &P, 37_900, 50, 280, false).unwrap();
        let w = |price| ticket_for(price, 37_900, 50, &P).unwrap();
        assert!(admit(&p, &i, &P, &w(s), 280, false).is_ok());
        assert_eq!(
            admit(&p, &i, &P, &w(s + 1), 280, false),
            Err(Reject::PerTicketCap)
        );
    }

    #[test]
    fn withdrawable_respects_both_identities() {
        let p = Vault {
            assets: 1_000,
            reserved: 200,
            open_credits: 100,
        };
        // committed 300; κ needs assets ≥ 250 → withdrawable = 1000 − max(300, 250) = 700
        assert_eq!(withdrawable(&p, &P), 700);
        let p = Vault {
            assets: 1_000,
            reserved: 700,
            open_credits: 0,
        };
        // κ: assets ≥ 875 → 125; committed 700 → 300 → min is 125
        assert_eq!(withdrawable(&p, &P), 125);
        let p = Vault {
            assets: 100,
            reserved: 90,
            open_credits: 20,
        };
        assert_eq!(withdrawable(&p, &P), 0);
    }
}
