//! Payout table validation and the expected-value check.

use crate::{Reject, BPS, MAX_OUTCOMES, M_CEILING_BPS, P_SCALE};

/// One outcome: its probability in `P_SCALE` units and its multiplier in bps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Outcome {
    /// Probability, `1..=P_SCALE`.
    pub p: u64,
    /// Multiplier in basis points (`10_000` pays the ticket price back).
    pub m: u64,
}

/// What `validate` derives from a well-formed payout table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    /// `Σ p_i · m_i`, exact, in `P_SCALE × BPS` units.
    pub lhs: u128,
    /// Largest multiplier, in bps.
    pub max_m: u64,
    /// Cumulative probability bounds; `cum[i] = Σ_{j ≤ i} p_j`, the last equals `P_SCALE`.
    pub cum: [u64; MAX_OUTCOMES],
    /// Number of outcomes.
    pub len: usize,
}

/// Checks shape and sums. Does **not** check the margin: that is `ev_ok`, because
/// the required margin is a parameter of the caller, not of the payout table.
pub fn validate(outcomes: &[Outcome]) -> Result<Summary, Reject> {
    if outcomes.is_empty() || outcomes.len() > MAX_OUTCOMES {
        return Err(Reject::OutcomeCount);
    }
    let mut lhs: u128 = 0;
    let mut sum: u64 = 0;
    let mut max_m: u64 = 0;
    let mut cum = [0u64; MAX_OUTCOMES];
    for (i, b) in outcomes.iter().enumerate() {
        if b.p == 0 || b.p > P_SCALE {
            return Err(Reject::ProbabilityRange);
        }
        if b.m > M_CEILING_BPS {
            return Err(Reject::MultiplierCeiling);
        }
        sum = sum.checked_add(b.p).ok_or(Reject::ProbabilitySum)?;
        if sum > P_SCALE {
            return Err(Reject::ProbabilitySum);
        }
        cum[i] = sum;
        // p ≤ 1e9 and m ≤ 1e8: the product is < 1e17 and 32 of them < 4e18, far inside u128.
        lhs = lhs
            .checked_add(
                u128::from(b.p)
                    .checked_mul(u128::from(b.m))
                    .ok_or(Reject::Overflow)?,
            )
            .ok_or(Reject::Overflow)?;
        max_m = max_m.max(b.m);
    }
    if sum != P_SCALE {
        return Err(Reject::ProbabilitySum);
    }
    Ok(Summary {
        lhs,
        max_m,
        cum,
        len: outcomes.len(),
    })
}

/// The invariant: `Σ p_i · m_i ≤ (BPS − margin_bps) · P_SCALE`, compared exactly.
/// No division, so no rounding on either side.
pub fn ev_ok(lhs: u128, margin_bps: u64) -> bool {
    match BPS.checked_sub(margin_bps) {
        Some(rtp_bps) => lhs <= u128::from(rtp_bps).saturating_mul(u128::from(P_SCALE)),
        None => false,
    }
}

/// The margin a payout table actually carries, in bps, rounded **down** (the
/// expected return is rounded up). Returns `None` when the payout table pays out
/// more than it takes in.
pub fn margin_bps(lhs: u128) -> Option<u64> {
    let scale = u128::from(P_SCALE);
    // ceil(lhs / P_SCALE) is the RTP in bps, rounded against the integrator.
    let rtp = lhs.div_ceil(scale);
    let rtp = u64::try_from(rtp).ok()?;
    BPS.checked_sub(rtp)
}

/// Validate and check the margin in one call.
pub fn validate_with_margin(
    outcomes: &[Outcome],
    required_margin_bps: u64,
) -> Result<Summary, Reject> {
    let s = validate(outcomes)?;
    if !ev_ok(s.lhs, required_margin_bps) {
        return Err(Reject::PayoutTableOverpays);
    }
    Ok(s)
}

/// Payout for a ticket price and a multiplier, rounded down.
pub fn payout(price: u64, m_bps: u64) -> Result<u64, Reject> {
    let v = u128::from(price)
        .checked_mul(u128::from(m_bps))
        .ok_or(Reject::Overflow)?;
    u64::try_from(v.checked_div(u128::from(BPS)).ok_or(Reject::Overflow)?)
        .map_err(|_| Reject::Overflow)
}

/// A share of `bps` on `amount`, rounded down (the payer keeps the dust).
pub fn share_of(amount: u64, bps: u64) -> Result<u64, Reject> {
    let v = u128::from(amount)
        .checked_mul(u128::from(bps))
        .ok_or(Reject::Overflow)?;
    u64::try_from(v.checked_div(u128::from(BPS)).ok_or(Reject::Overflow)?)
        .map_err(|_| Reject::Overflow)
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    fn pt(rows: &[(u64, u64)]) -> [Outcome; 32] {
        let mut out = [Outcome { p: 0, m: 0 }; 32];
        for (i, (p, m)) in rows.iter().enumerate() {
            out[i] = Outcome { p: *p, m: *m };
        }
        out
    }

    #[test]
    fn boundary_exact_payout_table_passes_and_one_bp_more_fails() {
        // p = 0.197, m = 5× → Σ = 0.985 exactly at the 150 bps floor.
        let table = [
            Outcome {
                p: 197_000_000,
                m: 50_000,
            },
            Outcome {
                p: 803_000_000,
                m: 0,
            },
        ];
        let s = validate(&table).unwrap();
        assert!(ev_ok(s.lhs, 150));
        assert_eq!(margin_bps(s.lhs), Some(150));
        let table = [
            Outcome {
                p: 197_000_000,
                m: 50_001,
            },
            Outcome {
                p: 803_000_000,
                m: 0,
            },
        ];
        let s = validate(&table).unwrap();
        assert!(!ev_ok(s.lhs, 150));
        assert_eq!(margin_bps(s.lhs), Some(149));
    }

    #[test]
    fn sum_must_be_exactly_one() {
        let low = &pt(&[(500_000_000, 20_000), (499_999_999, 0)])[..2];
        assert_eq!(validate(low), Err(Reject::ProbabilitySum));
        let high = &pt(&[(500_000_000, 20_000), (500_000_001, 0)])[..2];
        assert_eq!(validate(high), Err(Reject::ProbabilitySum));
        let zero = &pt(&[(1_000_000_000, 5_000), (0, 0)])[..2];
        assert_eq!(validate(zero), Err(Reject::ProbabilityRange));
    }

    #[test]
    fn ceiling_and_count() {
        assert_eq!(validate(&[]), Err(Reject::OutcomeCount));
        let over = [
            Outcome {
                p: 1,
                m: M_CEILING_BPS + 1,
            },
            Outcome {
                p: P_SCALE - 1,
                m: 0,
            },
        ];
        assert_eq!(validate(&over), Err(Reject::MultiplierCeiling));
        let ok = [
            Outcome {
                p: 1,
                m: M_CEILING_BPS,
            },
            Outcome {
                p: P_SCALE - 1,
                m: 0,
            },
        ];
        assert!(validate(&ok).is_ok());
    }

    #[test]
    fn margin_rounds_against_the_integrator() {
        // RTP 0.9850000001 → 9850.000001 bps → ceil 9851 → margin 149
        let lhs = 9_850u128 * 1_000_000_000 + 1;
        assert_eq!(margin_bps(lhs), Some(149));
        assert_eq!(margin_bps(0), Some(BPS));
        assert_eq!(margin_bps(u128::from(BPS) * u128::from(P_SCALE) + 1), None);
    }

    #[test]
    fn payout_and_share_round_down() {
        assert_eq!(payout(1_000_000, 15_000).unwrap(), 1_500_000);
        assert_eq!(payout(1, 15_000).unwrap(), 1);
        assert_eq!(payout(1, 9_999).unwrap(), 0);
        assert_eq!(share_of(1_000_000, 150).unwrap(), 15_000);
        assert_eq!(share_of(7, 150).unwrap(), 0);
        assert_eq!(payout(u64::MAX, M_CEILING_BPS), Err(Reject::Overflow));
    }
}
