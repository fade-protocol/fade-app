//! The drawdown breaker's state (Spec 08 §8, Spec 04 §7.3).
//!
//! The breaker measures the price of a share, not the vault's assets: a strike's
//! deposits and withdrawals leave the price unchanged up to rounding, which
//! always favours the vault, so only the vault's results move it and a large
//! withdrawal never looks like a loss. The vault keeps the highest price of each
//! of the last 24 hours in a ring and compares the current price with it.

use crate::shares::{VIRTUAL_ASSETS, VIRTUAL_SHARES};
use crate::{Reject, BPS};

/// Fixed point of the share price.
pub const PRICE_SCALE: u128 = 1_000_000_000_000_000_000;
/// Hours the ring covers.
pub const HOURS: usize = 24;
/// Seconds per ring slot.
pub const SECONDS_PER_HOUR: i64 = 3_600;

/// `(assets + 1) / (shares + 10³)` in `PRICE_SCALE` fixed point: the price the
/// share math of `shares` uses, rounded down.
pub fn share_price(total_assets: u64, total_shares: u64) -> Result<u128, Reject> {
    let num = u128::from(total_assets)
        .checked_add(VIRTUAL_ASSETS)
        .and_then(|a| a.checked_mul(PRICE_SCALE))
        .ok_or(Reject::Overflow)?;
    let den = u128::from(total_shares)
        .checked_add(VIRTUAL_SHARES)
        .ok_or(Reject::Overflow)?;
    num.checked_div(den).ok_or(Reject::Overflow)
}

/// The highest share price of each of the last `HOURS` hours, `head_hour` being
/// the Unix hour of the newest slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ring {
    /// Slot `h mod HOURS` holds the maximum of hour `h`.
    pub maxima: [u128; HOURS],
    /// The Unix hour of the newest slot.
    pub head_hour: i64,
}

fn slot(hour: i64) -> usize {
    // rem_euclid by a positive constant is in 0..HOURS.
    usize::try_from(hour.rem_euclid(HOURS as i64)).unwrap_or(0)
}

impl Ring {
    /// A ring whose every hour saw `price`, ending at the hour of `now`.
    pub fn new(now: i64, price: u128) -> Ring {
        Ring {
            maxima: [price; HOURS],
            head_hour: now.div_euclid(SECONDS_PER_HOUR),
        }
    }

    /// Records a price change at `now`, from `before` to `after`. Hours with no
    /// observation since the head held `before` throughout, so they are filled
    /// with it; the current hour's maximum covers both prices.
    pub fn observe(&mut self, now: i64, before: u128, after: u128) {
        let hour = now.div_euclid(SECONDS_PER_HOUR);
        if hour > self.head_hour {
            let gap = hour.saturating_sub(self.head_hour).min(HOURS as i64);
            let mut k = 0i64;
            while k < gap {
                k = k.saturating_add(1);
                self.maxima[slot(hour.saturating_sub(gap).saturating_add(k))] = before;
            }
            self.head_hour = hour;
        }
        // The clock never goes back; an earlier hour is folded into the head.
        let head = slot(self.head_hour);
        self.maxima[head] = self.maxima[head].max(before).max(after);
    }

    /// Scales every maximum by `num / den`, rounding down. A strike whose flows
    /// clear at a price other than the settled one moves the settled price
    /// without any result behind it; scaling the ring by the same factor keeps
    /// every drawdown ratio where it was. `den == 0` or `num == den` leaves the
    /// ring alone.
    pub fn rescale(&mut self, num: u128, den: u128) {
        if den == 0 || num == den {
            return;
        }
        // Bring the ratio under 64 bits (a relative error below 2⁻⁶³), so that
        // `m · n / d = (m / d) · n + (m mod d) · n / d` never overflows but
        // for a result that would not fit in a price at all.
        let shift = 128u32
            .saturating_sub(num.max(den).leading_zeros())
            .saturating_sub(64);
        let (n, d) = (num >> shift, den >> shift);
        if d == 0 {
            return;
        }
        for m in self.maxima.iter_mut() {
            let scaled = m.checked_div(d).zip(m.checked_rem(d)).and_then(|(q, r)| {
                let hi = q.checked_mul(n)?;
                let lo = r.checked_mul(n)?.checked_div(d)?;
                hi.checked_add(lo)
            });
            *m = scaled.unwrap_or_else(|| (*m).max(num));
        }
    }

    /// The highest price of the last `HOURS` hours, as of the last observation.
    pub fn max(&self) -> u128 {
        self.maxima.iter().copied().max().unwrap_or(0)
    }

    /// The breaker's condition: `price` has fallen to `(BPS − drawdown_bps)`
    /// of the 24-hour maximum or below. Observe `now` first, so that hours older
    /// than the window have left the ring.
    pub fn tripped(&self, price: u128, drawdown_bps: u64) -> bool {
        let keep = u128::from(BPS.saturating_sub(drawdown_bps));
        price.saturating_mul(u128::from(BPS)) <= self.max().saturating_mul(keep)
    }
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {

    #[test]
    fn rescaling_keeps_every_drawdown_ratio() {
        let p = PRICE_SCALE;
        let mut ring = Ring::new(0, p);
        ring.observe(10, p, p * 88 / 100);
        assert!(!ring.tripped(p * 88 / 100, 1_500));
        // A strike moves the settled price from 0.88 to 0.85 by its flows alone.
        let (before, after) = (p * 88 / 100, p * 85 / 100);
        ring.rescale(after, before);
        ring.observe(20, after, after);
        assert!(!ring.tripped(after, 1_500), "flows are not a drawdown");
        assert!(
            ring.tripped(after * 85 / 88, 1_500),
            "a later loss of the same size still is"
        );
    }

    #[test]
    fn rescaling_is_exact_at_any_price_a_vault_can_reach() {
        // A vault left with assets and no shares prices a share at up to
        // (2⁶⁴ · 10¹⁸) / 10³; squaring such a price overflows u128.
        for p in [
            PRICE_SCALE,
            1_000 * PRICE_SCALE,
            share_price(u64::MAX, 0).unwrap(),
        ] {
            let mut ring = Ring::new(0, p);
            ring.rescale(p, p);
            assert_eq!(ring.max(), p, "an unchanged price leaves the ring alone");
            ring.rescale(p / 2, p);
            assert_eq!(ring.max(), p / 2);
            assert!(!ring.tripped(p / 2, 1_500));
            ring.rescale(p, p / 2);
            assert!(ring.max().abs_diff(p) <= p >> 60, "{} vs {p}", ring.max());
            assert!(!ring.tripped(p, 1_500));
        }
    }

    use super::*;

    const H: i64 = SECONDS_PER_HOUR;
    const P: u128 = 1_000_000_000_000_000; // 1e-3 USDC unit per share unit

    #[test]
    fn price_of_an_empty_vault_equals_the_founding_price() {
        let empty = share_price(0, 0).unwrap();
        let founded = share_price(5_000_000_000, 5_000_000_000_000).unwrap();
        assert_eq!(empty, P);
        assert!(founded.abs_diff(P) <= 1);
    }

    #[test]
    fn a_fall_of_15_percent_trips_and_ages_out_after_24_hours() {
        let mut r = Ring::new(100 * H, P);
        let low = P * 85 / 100;
        r.observe(100 * H + 10, P, low);
        assert!(r.tripped(low, 1_500));
        assert!(!r.tripped(low + 1, 1_500));
        // 23 hours later the peak is still in the window…
        r.observe(123 * H, low, low);
        assert!(r.tripped(low, 1_500));
        // …24 hours later it has left it
        r.observe(124 * H, low, low);
        assert!(!r.tripped(low, 1_500));
        assert_eq!(r.max(), low);
    }

    #[test]
    fn skipped_hours_hold_the_last_price() {
        let mut r = Ring::new(0, P);
        r.observe(H, P, 2 * P);
        // three quiet hours, then a fall
        r.observe(5 * H, 2 * P, P);
        assert_eq!(r.max(), 2 * P);
        assert_eq!(r.maxima[slot(4)], 2 * P);
        assert!(r.tripped(P, 1_500));
    }

    #[test]
    fn a_long_gap_resets_every_slot() {
        let mut r = Ring::new(0, 5 * P);
        r.observe(1_000 * H, P, P);
        assert_eq!(r.max(), P);
    }
}
