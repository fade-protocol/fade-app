//! The epoch machinery of Spec 08 §4: the close grid, the two ticket counters
//! that gate a strike, and where a request lands.
//!
//! An epoch is a batch of requests priced together. The first request opens
//! one, which closes at the next multiple of the epoch length; a request made
//! after that close joins the next epoch. The strike of an epoch runs only once
//! its close has passed and every ticket opened before the close has settled or
//! expired, which is what the counters below make O(1) to check.

use crate::Reject;

/// The close of an epoch opened at `now`: the next multiple of `length` strictly
/// after `now`, so that a request at exactly a multiple belongs to the epoch
/// that closes one length later. `None` for a non-positive length or overflow.
pub fn close_ts(now: i64, length: i64) -> Option<i64> {
    if length <= 0 {
        return None;
    }
    now.div_euclid(length).checked_add(1)?.checked_mul(length)
}

/// Which of the two counters an open ticket joined.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// Opened while a close was set and before it.
    BeforeClose,
    /// Opened at or after the live close, or while no close was set.
    AfterClose,
}

/// The ticket counters `Vault` keeps (Spec 08 §4 rules 1, 3, 4 and 6).
///
/// Every generation change moves `after` into `before` and needs `before == 0`
/// first — a strike requires it, and an epoch is only opened when none is live,
/// which is after a strike — so a ticket outlives at most one change and its
/// counter can always be found from the side and generation it recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counters {
    /// Open tickets opened before the live close.
    pub before: u32,
    /// Open tickets opened at or after it, or while no close was set.
    pub after: u32,
    /// Incremented at every change of epoch.
    pub generation: u32,
    /// The live epoch's close, or 0 when no epoch is live.
    pub close_ts: i64,
}

impl Counters {
    /// Rule 3: a ticket opened at `now` joins `before` if a close is set and
    /// `now` precedes it, `after` otherwise. Returns what the ticket records.
    pub fn open(&mut self, now: i64) -> Result<(Side, u32), Reject> {
        let side = if self.close_ts != 0 && now < self.close_ts {
            self.before = self.before.checked_add(1).ok_or(Reject::Overflow)?;
            Side::BeforeClose
        } else {
            self.after = self.after.checked_add(1).ok_or(Reject::Overflow)?;
            Side::AfterClose
        };
        Ok((side, self.generation))
    }

    /// Rule 4: a settled or expired ticket leaves the counter it is in now —
    /// `before` if it joined `before` in this generation or `after` in the
    /// previous one, `after` if it joined `after` in this generation.
    pub fn close(&mut self, side: Side, generation: u32) -> Result<(), Reject> {
        let previous = self.generation.checked_sub(1);
        let in_before = match side {
            Side::BeforeClose => generation == self.generation,
            Side::AfterClose => Some(generation) == previous,
        };
        if in_before {
            self.before = self.before.checked_sub(1).ok_or(Reject::Overflow)?;
            return Ok(());
        }
        if side == Side::AfterClose && generation == self.generation {
            self.after = self.after.checked_sub(1).ok_or(Reject::Overflow)?;
            return Ok(());
        }
        // Unreachable while the invariant holds: no ticket outlives two changes.
        Err(Reject::Overflow)
    }

    /// Rule 3 for `n` tickets opened at the same `now`, as a shared-beacon
    /// round records all its tickets at its draw request: the same side and
    /// generation as `n` calls to `open`, in O(1).
    pub fn open_n(&mut self, now: i64, n: u32) -> Result<(Side, u32), Reject> {
        let side = if self.close_ts != 0 && now < self.close_ts {
            self.before = self.before.checked_add(n).ok_or(Reject::Overflow)?;
            Side::BeforeClose
        } else {
            self.after = self.after.checked_add(n).ok_or(Reject::Overflow)?;
            Side::AfterClose
        };
        Ok((side, self.generation))
    }

    /// Rule 4 for `n` tickets recorded with the same side and generation, as a
    /// forfeited round's remaining tickets leave at once: the same as `n` calls
    /// to `close`, in O(1). Leaves the counters untouched if it fails.
    pub fn close_n(&mut self, side: Side, generation: u32, n: u32) -> Result<(), Reject> {
        let previous = self.generation.checked_sub(1);
        let in_before = match side {
            Side::BeforeClose => generation == self.generation,
            Side::AfterClose => Some(generation) == previous,
        };
        if in_before {
            self.before = self.before.checked_sub(n).ok_or(Reject::Overflow)?;
            return Ok(());
        }
        if side == Side::AfterClose && generation == self.generation {
            self.after = self.after.checked_sub(n).ok_or(Reject::Overflow)?;
            return Ok(());
        }
        if n == 0 {
            return Ok(());
        }
        Err(Reject::Overflow)
    }

    /// Rules 1 and 6: a new epoch becomes live with close `close_ts`. Every
    /// ticket still open was opened before that close, so `after` moves into
    /// `before`.
    pub fn roll(&mut self, close_ts: i64) -> Result<(), Reject> {
        self.before = self
            .before
            .checked_add(self.after)
            .ok_or(Reject::Overflow)?;
        self.after = 0;
        self.generation = self.generation.checked_add(1).ok_or(Reject::Overflow)?;
        self.close_ts = close_ts;
        Ok(())
    }

    /// Rule 6 with nothing to promote: no epoch is live any more.
    pub fn clear_close(&mut self) {
        self.close_ts = 0;
    }

    /// The half of the strike condition the vault holds: no ticket opened before
    /// the live close is still open.
    pub fn clean(&self) -> bool {
        self.before == 0
    }
}

/// Where a request made at `now` lands (Spec 08 §4 rule 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Join {
    /// No epoch is live: this request opens one.
    Open,
    /// The live epoch has not closed yet.
    Current,
    /// The live epoch has closed and awaits its strike: the request joins the next.
    Next,
}

/// Rule 2: before the live close a request joins it; at or after the close it
/// joins the next epoch.
pub fn join(current_live: bool, current_close: i64, now: i64) -> Join {
    if !current_live {
        Join::Open
    } else if now < current_close {
        Join::Current
    } else {
        Join::Next
    }
}

/// Rule 5: the strike of the live epoch may run.
pub fn can_strike(current_live: bool, current_close: i64, now: i64, counters: &Counters) -> bool {
    current_live && now >= current_close && counters.clean()
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    #[test]
    fn close_grid() {
        assert_eq!(close_ts(0, 600), Some(600));
        assert_eq!(close_ts(599, 600), Some(600));
        assert_eq!(
            close_ts(600, 600),
            Some(1_200),
            "a multiple belongs to the next"
        );
        // 09:09:30 UTC closes at 09:10
        assert_eq!(
            close_ts(9 * 3600 + 9 * 60 + 30, 600),
            Some(9 * 3600 + 10 * 60)
        );
        assert_eq!(close_ts(1_000, 0), None);
        assert_eq!(close_ts(i64::MAX, 600), None);
    }

    #[test]
    fn counters_follow_the_generations() {
        let mut c = Counters::default();
        // no epoch live: everything joins `after`
        let w1 = c.open(100).unwrap();
        assert_eq!(w1, (Side::AfterClose, 0));
        // a request opens an epoch closing at 600: w1 now counts as before
        c.roll(600).unwrap();
        assert_eq!((c.before, c.after, c.generation), (1, 0, 1));
        let w2 = c.open(599).unwrap();
        let w3 = c.open(600).unwrap();
        assert_eq!(w2, (Side::BeforeClose, 1));
        assert_eq!(w3, (Side::AfterClose, 1));
        assert!(!can_strike(true, 600, 700, &c));
        c.close(w1.0, w1.1).unwrap();
        c.close(w2.0, w2.1).unwrap();
        assert!(can_strike(true, 600, 700, &c));
        assert!(!can_strike(true, 600, 599, &c));
        // promotion: w3 rolls into before of the next epoch
        c.roll(1_200).unwrap();
        assert_eq!((c.before, c.after, c.generation), (1, 0, 2));
        c.close(w3.0, w3.1).unwrap();
        assert!(c.clean());
        // nothing more to promote
        c.clear_close();
        assert_eq!(c.open(5_000).unwrap(), (Side::AfterClose, 2));
    }

    #[test]
    fn join_rule() {
        assert_eq!(join(false, 0, 10), Join::Open);
        assert_eq!(join(true, 600, 599), Join::Current);
        assert_eq!(join(true, 600, 600), Join::Next);
    }
}
