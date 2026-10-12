//! LP share accounting with virtual shares, rounding down on both sides.
//!
//! Price is `(assets + VIRTUAL_ASSETS) / (shares + VIRTUAL_SHARES)`. The
//! virtual offset makes the first-depositor inflation attack a loss for the
//! attacker; rounding down on deposit and withdrawal means every rounding
//! error stays in the vault.

use crate::Reject;

/// Virtual shares added to the supply when pricing (decimals offset 3).
pub const VIRTUAL_SHARES: u128 = 1_000;
/// Virtual assets added to the vault when pricing.
pub const VIRTUAL_ASSETS: u128 = 1;
/// Smallest first deposit, in micro-USDC (100 USDC).
pub const MIN_FIRST_DEPOSIT: u64 = 100_000_000;

fn to_u64(v: u128) -> Result<u64, Reject> {
    u64::try_from(v).map_err(|_| Reject::Overflow)
}

/// Shares minted for `assets_in`, rounded down.
pub fn shares_for_assets(
    assets_in: u64,
    total_shares: u64,
    total_assets: u64,
) -> Result<u64, Reject> {
    let num = u128::from(assets_in)
        .checked_mul(
            u128::from(total_shares)
                .checked_add(VIRTUAL_SHARES)
                .ok_or(Reject::Overflow)?,
        )
        .ok_or(Reject::Overflow)?;
    let den = u128::from(total_assets)
        .checked_add(VIRTUAL_ASSETS)
        .ok_or(Reject::Overflow)?;
    to_u64(num.checked_div(den).ok_or(Reject::Overflow)?)
}

/// Assets paid for `shares_in`, rounded down.
pub fn assets_for_shares(
    shares_in: u64,
    total_shares: u64,
    total_assets: u64,
) -> Result<u64, Reject> {
    let num = u128::from(shares_in)
        .checked_mul(
            u128::from(total_assets)
                .checked_add(VIRTUAL_ASSETS)
                .ok_or(Reject::Overflow)?,
        )
        .ok_or(Reject::Overflow)?;
    let den = u128::from(total_shares)
        .checked_add(VIRTUAL_SHARES)
        .ok_or(Reject::Overflow)?;
    to_u64(num.checked_div(den).ok_or(Reject::Overflow)?)
}

/// Pro-rata fill: the part of `request` served when only `available` of
/// `total_requested` can be paid, rounded down. A batch owed nothing is served
/// in full: shares worth nothing are burnt for nothing, so they cannot keep a
/// chain alive.
pub fn pro_rata(request: u64, total_requested: u64, available: u64) -> Result<u64, Reject> {
    if available >= total_requested {
        return Ok(request);
    }
    let num = u128::from(request)
        .checked_mul(u128::from(available))
        .ok_or(Reject::Overflow)?;
    to_u64(
        num.checked_div(u128::from(total_requested))
            .ok_or(Reject::Overflow)?,
    )
}

/// One epoch strike: every queued deposit and withdrawal clears at the single
/// price implied by the vault **before** either is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Strike {
    /// Shares to mint for the whole deposit queue.
    pub shares_minted: u64,
    /// Assets owed to the whole withdrawal queue at the strike price.
    pub assets_owed: u64,
    /// Assets actually paid this epoch (capped by what may leave the vault).
    pub assets_paid: u64,
    /// Shares burnt for the assets paid (the rest stay queued).
    pub shares_burnt: u64,
}

/// A strike that cannot pay the withdrawal queue in full holds back at least
/// `ceil(owed / RATION_HOLDBACK)`: at least a millionth of the queue then rolls,
/// so the chain's `r` falls by at most that factor in one strike and a chain
/// ends exactly when a strike pays in full.
pub const RATION_HOLDBACK: u64 = 1_000_000;

/// Computes a strike. `withdrawable` is `risk::withdrawable` of the vault at
/// strike time; escrowed withdrawal shares are part of `total_shares`.
pub fn strike(
    deposits_queued: u64,
    shares_queued: u64,
    total_shares: u64,
    total_assets: u64,
    withdrawable: u64,
) -> Result<Strike, Reject> {
    let shares_minted = shares_for_assets(deposits_queued, total_shares, total_assets)?;
    let assets_owed = assets_for_shares(shares_queued, total_shares, total_assets)?;
    let mut assets_paid = assets_owed.min(withdrawable);
    if assets_paid < assets_owed {
        let holdback = assets_owed.div_ceil(RATION_HOLDBACK);
        assets_paid = assets_paid.min(assets_owed.saturating_sub(holdback));
    }
    let shares_burnt = pro_rata(shares_queued, assets_owed, assets_paid)?;
    Ok(Strike {
        shares_minted,
        assets_owed,
        assets_paid,
        shares_burnt,
    })
}

/// Fixed point of the chain indices.
pub const INDEX_SCALE: u128 = 1_000_000_000_000_000_000;

/// Smallest `r` a running chain keeps. A rationed strike that would take `r`
/// below it splits the chain instead (Spec 08 §5): the indices would otherwise
/// lose the precision late entrants are paid with.
pub const CHAIN_R_MIN: u128 = 1_000_000_000_000;

/// The running indices of a withdrawal chain (Spec 08 §5): of one share that
/// entered at the chain's start, the fraction `r` still queued and the assets
/// `v` received so far, both in `INDEX_SCALE` fixed point.
///
/// A chain ends at the first strike that pays in full, which leaves `r = 0`. A
/// rationed strike always leaves `r >= r_before / RATION_HOLDBACK`, which is
/// at least `CHAIN_R_MIN / RATION_HOLDBACK > 0` since a running chain keeps
/// `r >= CHAIN_R_MIN`; if it leaves `r` below `CHAIN_R_MIN`, the chain splits:
/// its requests carry their remaining shares into a new chain that starts at
/// `START`. Every claim then divides by an `r_entry` of at least `CHAIN_R_MIN`,
/// so each strike's rounding costs a request at most `shares / CHAIN_R_MIN`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chain {
    /// Fraction still queued.
    pub r: u128,
    /// Assets received per entering share.
    pub v: u128,
}

impl Chain {
    /// A chain that has not started.
    pub const START: Chain = Chain {
        r: INDEX_SCALE,
        v: 0,
    };

    /// One strike: `w` withdrawal shares queued, `b` of them burnt, `p` assets
    /// paid. Both divisions floor, so the indices never promise more than the
    /// strikes paid out. A strike with no withdrawal queued leaves the chain alone.
    pub fn advance(self, w: u64, b: u64, p: u64) -> Result<Chain, Reject> {
        if w == 0 {
            return Ok(self);
        }
        if b > w {
            return Err(Reject::Overflow);
        }
        let w = u128::from(w);
        let paid = self
            .r
            .checked_mul(u128::from(p))
            .and_then(|x| x.checked_div(w))
            .ok_or(Reject::Overflow)?;
        let left = self
            .r
            .checked_mul(w.checked_sub(u128::from(b)).ok_or(Reject::Overflow)?)
            .and_then(|x| x.checked_div(w))
            .ok_or(Reject::Overflow)?;
        Ok(Chain {
            r: left,
            v: self.v.checked_add(paid).ok_or(Reject::Overflow)?,
        })
    }

    /// Whether the chain has ended: nothing of it is still queued.
    pub fn ended(&self) -> bool {
        self.r == 0
    }

    /// Whether the chain splits here: shares are still queued but `r` is too
    /// small to go on with.
    pub fn splits(&self) -> bool {
        self.r != 0 && self.r < CHAIN_R_MIN
    }
}

/// Assets due, in total, to `shares` that entered a chain at indices
/// `(r_entry, v_entry)`, read at a later record of the same chain whose `v` is
/// `v_now`. Floors. A claimer pays the difference with what it already paid, so
/// that partial claims followed by a final one pay exactly what a single final
/// claim would.
pub fn withdraw_due(shares: u64, r_entry: u128, v_entry: u128, v_now: u128) -> Result<u64, Reject> {
    if r_entry == 0 {
        return Err(Reject::Overflow);
    }
    let dv = v_now.checked_sub(v_entry).ok_or(Reject::Overflow)?;
    to_u64(
        u128::from(shares)
            .checked_mul(dv)
            .and_then(|x| x.checked_div(r_entry))
            .ok_or(Reject::Overflow)?,
    )
}

/// Shares of the same withdrawal still queued at a record whose `r` is `r_now`.
pub fn still_queued(shares: u64, r_entry: u128, r_now: u128) -> Result<u64, Reject> {
    if r_entry == 0 {
        return Err(Reject::Overflow);
    }
    to_u64(
        u128::from(shares)
            .checked_mul(r_now)
            .and_then(|x| x.checked_div(r_entry))
            .ok_or(Reject::Overflow)?,
    )
}

/// Shares due to a deposit of `amount` in an epoch whose deposits, `deposits`
/// in total, were minted `minted` shares. Floors: the dust stays unclaimed.
pub fn deposit_due(amount: u64, deposits: u64, minted: u64) -> Result<u64, Reject> {
    if deposits == 0 || amount > deposits {
        return Err(Reject::Overflow);
    }
    to_u64(
        u128::from(amount)
            .checked_mul(u128::from(minted))
            .and_then(|x| x.checked_div(u128::from(deposits)))
            .ok_or(Reject::Overflow)?,
    )
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    #[test]
    fn first_deposit_and_round_trip() {
        let s = shares_for_assets(MIN_FIRST_DEPOSIT, 0, 0).unwrap();
        assert_eq!(s, 100_000_000 * 1_000);
        let back = assets_for_shares(s, s, MIN_FIRST_DEPOSIT).unwrap();
        assert!(
            back <= MIN_FIRST_DEPOSIT && MIN_FIRST_DEPOSIT - back <= 1,
            "{back}"
        );
    }

    #[test]
    fn inflation_attack_loses_money() {
        // Attacker deposits 1 unit, donates 1_000 USDC directly, victim deposits 999 USDC.
        let attacker = shares_for_assets(1, 0, 0).unwrap();
        let (mut s, mut a) = (attacker, 1u64);
        a += 1_000_000_000; // donation: assets up, no shares
        let victim = shares_for_assets(999_000_000, s, a).unwrap();
        assert!(victim > 0, "victim must not round to zero shares");
        s += victim;
        a += 999_000_000;
        let attacker_out = assets_for_shares(attacker, s, a).unwrap();
        assert!(
            attacker_out < 1 + 1_000_000_000,
            "attacker recovered {attacker_out} for 1 000 000 001 in"
        );
    }

    #[test]
    fn strike_single_price_and_rationing() {
        // vault 1 000 USDC / 1e9 shares (offset makes price ≈ 1e-3 USDC per share)
        let (s, a) = (1_000_000_000u64, 1_000_000_000u64);
        let k = strike(500_000_000, 200_000_000, s, a, u64::MAX).unwrap();
        assert_eq!(
            k.shares_minted,
            shares_for_assets(500_000_000, s, a).unwrap()
        );
        assert_eq!(k.assets_owed, assets_for_shares(200_000_000, s, a).unwrap());
        assert_eq!(k.assets_paid, k.assets_owed);
        assert_eq!(k.shares_burnt, 200_000_000);
        let rationed = strike(0, 200_000_000, s, a, k.assets_owed / 4).unwrap();
        assert_eq!(rationed.assets_paid, k.assets_owed / 4);
        assert!(rationed.shares_burnt <= 50_000_000 && rationed.shares_burnt >= 49_999_999);
    }

    #[test]
    fn a_rationed_withdrawal_is_claimed_once_for_the_exact_total() {
        // Spec 08 §5: 500 shares owed 510 USDC receive 400 at epoch k; at k+1 the
        // vault has earned 30 USDC and the rest is paid in full.
        const W: u64 = 1_000_000_000; // one whole share
        let s0 = shares_for_assets(5_000_000_000, 0, 0).unwrap();
        let assets = 5_100_000_000u64;
        let queued = 500 * W;
        let k = strike(1_000_000_000, queued, s0, assets, 400_000_000).unwrap();
        assert_eq!(k.assets_owed, 510_000_000 - 1); // the virtual offset rounds a unit away
        let c0 = Chain::START;
        let c1 = c0.advance(queued, k.shares_burnt, k.assets_paid).unwrap();
        assert!(!c1.ended());
        let left = queued - k.shares_burnt;
        let (s1, a1) = (
            s0 + k.shares_minted - k.shares_burnt,
            assets + 1_000_000_000 - k.assets_paid + 30_000_000,
        );
        let k2 = strike(0, left, s1, a1, u64::MAX).unwrap();
        let c2 = c1.advance(left, k2.shares_burnt, k2.assets_paid).unwrap();
        assert!(c2.ended());
        let one = withdraw_due(queued, c0.r, c0.v, c2.v).unwrap();
        let total = k.assets_paid + k2.assets_paid;
        assert!(one <= total && total - one <= 2, "{one} vs {total}");
        // a partial claim at k, then the final one, pays the same total
        let partial = withdraw_due(queued, c0.r, c0.v, c1.v).unwrap();
        assert!(partial <= one);
        assert_eq!(still_queued(queued, c0.r, c1.r).unwrap(), left);
    }

    #[test]
    fn shares_worth_nothing_are_burnt_and_end_the_chain() {
        // 1 share at ~1e-3 micro-USDC each: owed rounds to 0.
        let k = strike(0, 1, 100_000_000_000, 100_000_000, 0).unwrap();
        assert_eq!((k.assets_owed, k.assets_paid, k.shares_burnt), (0, 0, 1));
        let c = Chain::START
            .advance(1, k.shares_burnt, k.assets_paid)
            .unwrap();
        assert!(c.ended());
    }

    #[test]
    fn a_rationed_strike_holds_back_a_millionth() {
        let (s, a) = (1_000_000_000_000_000u64, 1_000_000_000_000u64);
        let w = 1_000_000_000_000_000u64 / 2;
        let owed = assets_for_shares(w, s, a).unwrap();
        // One micro-USDC short: the holdback, not the shortfall, decides.
        let k = strike(0, w, s, a, owed - 1).unwrap();
        assert_eq!(k.assets_paid, owed - owed.div_ceil(RATION_HOLDBACK));
        assert!(w - k.shares_burnt >= w.div_ceil(RATION_HOLDBACK));
        let c = Chain::START
            .advance(w, k.shares_burnt, k.assets_paid)
            .unwrap();
        assert!(c.r >= CHAIN_R_MIN, "one strike never splits a fresh chain");
        // A second such strike splits it, with r still far from zero.
        let c2 = c.advance(w, k.shares_burnt, k.assets_paid).unwrap();
        assert!(c2.splits() && c2.r >= CHAIN_R_MIN / u128::from(RATION_HOLDBACK));
        // Paying in full ends it.
        let full = strike(0, w, s, a, u64::MAX).unwrap();
        assert!(c
            .advance(w, full.shares_burnt, full.assets_paid)
            .unwrap()
            .ended());
    }

    #[test]
    fn deposit_claims_never_exceed_what_was_minted() {
        let minted = 980_392_156_862u64;
        let parts = [1u64, 333_333_333, 666_666_666];
        let deposits: u64 = parts.iter().sum();
        let paid: u64 = parts
            .iter()
            .map(|&a| deposit_due(a, deposits, minted).unwrap())
            .sum();
        assert!(paid <= minted && minted - paid < parts.len() as u64);
        assert_eq!(deposit_due(1, 0, 5), Err(Reject::Overflow));
    }
}
