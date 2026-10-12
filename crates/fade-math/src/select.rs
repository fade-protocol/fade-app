//! Outcome selection: an unbiased draw in `[0, P_SCALE)` from hash output,
//! then the outcome whose cumulative bound the draw falls under.

use crate::{MAX_OUTCOMES, P_SCALE};

/// `2^128 − (2^128 mod P_SCALE)`: words at or above this are rejected so that
/// `word mod P_SCALE` is exactly uniform. Rejection probability ≈ 2.3e-30.
pub const LIMIT: u128 = u128::MAX - (u128::MAX % (P_SCALE as u128));

/// Reduces a 16-byte little-endian word to `[0, P_SCALE)`, or `None` if the
/// word must be rejected.
pub fn reduce_word(bytes: [u8; 16]) -> Option<u64> {
    let word = u128::from_le_bytes(bytes);
    if word >= LIMIT {
        return None;
    }
    // < P_SCALE, so it fits u64.
    u64::try_from(word.checked_rem(P_SCALE as u128)?).ok()
}

/// Draws an outcome from successive 32-byte hashes: each hash yields two
/// candidate words; `hash(i)` is called for `i = 0..rounds` until one is
/// accepted. Returns `None` only if every word was rejected — practically
/// unreachable, but exact rather than biased.
pub fn draw<H: FnMut(u8) -> [u8; 32]>(mut hash: H, rounds: u8) -> Option<u64> {
    for i in 0..rounds {
        let h = hash(i);
        let mut lo = [0u8; 16];
        let mut hi = [0u8; 16];
        lo.copy_from_slice(&h[..16]);
        hi.copy_from_slice(&h[16..]);
        if let Some(r) = reduce_word(lo) {
            return Some(r);
        }
        if let Some(r) = reduce_word(hi) {
            return Some(r);
        }
    }
    None
}

/// The outcome index for a draw `r ∈ [0, P_SCALE)`: the first `i` with `r < cum[i]`.
/// `cum` is the cumulative bound array from `payout_table::validate`, whose last
/// used entry equals `P_SCALE`, so an outcome always exists for valid input.
pub fn outcome(r: u64, cum: &[u64; MAX_OUTCOMES], len: usize) -> Option<usize> {
    cum.iter().take(len).position(|&c| r < c)
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    #[test]
    fn limit_is_the_largest_multiple_of_p_scale_below_2_128() {
        let scale = P_SCALE as u128;
        assert_eq!(LIMIT % scale, 0);
        assert!(u128::MAX - LIMIT < scale);
        assert_eq!(LIMIT, 340_282_366_920_938_463_463_374_607_431_000_000_000);
    }

    #[test]
    fn words_at_and_above_limit_are_rejected() {
        assert_eq!(
            reduce_word((LIMIT - 1).to_le_bytes()),
            Some(((LIMIT - 1) % P_SCALE as u128) as u64)
        );
        assert_eq!(reduce_word(LIMIT.to_le_bytes()), None);
        assert_eq!(reduce_word((LIMIT + 1).to_le_bytes()), None);
        assert_eq!(reduce_word(u128::MAX.to_le_bytes()), None);
        assert_eq!(reduce_word(0u128.to_le_bytes()), Some(0));
        assert_eq!(
            reduce_word((P_SCALE as u128 - 1).to_le_bytes()),
            Some(P_SCALE - 1)
        );
        assert_eq!(reduce_word((P_SCALE as u128).to_le_bytes()), Some(0));
    }

    #[test]
    fn draw_skips_rejected_words_then_gives_up() {
        let rejected = u128::MAX.to_le_bytes();
        let accepted = 5u128.to_le_bytes();
        let mut calls = 0u8;
        let r = draw(
            |i| {
                calls += 1;
                let mut h = [0u8; 32];
                h[..16].copy_from_slice(&rejected);
                h[16..].copy_from_slice(if i == 3 { &accepted } else { &rejected });
                h
            },
            4,
        );
        assert_eq!(r, Some(5));
        assert_eq!(calls, 4);
        let none = draw(
            |_| {
                let mut h = [0u8; 32];
                h[..16].copy_from_slice(&rejected);
                h[16..].copy_from_slice(&rejected);
                h
            },
            4,
        );
        assert_eq!(none, None);
    }

    #[test]
    fn outcome_boundaries() {
        let mut cum = [0u64; MAX_OUTCOMES];
        cum[0] = 10;
        cum[1] = 10 + 90;
        cum[2] = P_SCALE;
        assert_eq!(outcome(0, &cum, 3), Some(0));
        assert_eq!(outcome(9, &cum, 3), Some(0));
        assert_eq!(outcome(10, &cum, 3), Some(1));
        assert_eq!(outcome(99, &cum, 3), Some(1));
        assert_eq!(outcome(100, &cum, 3), Some(2));
        assert_eq!(outcome(P_SCALE - 1, &cum, 3), Some(2));
        assert_eq!(outcome(P_SCALE, &cum, 3), None);
    }
}
