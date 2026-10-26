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

    /// `n` more tickets, joining at `now`, for a group recorded earlier with
    /// `side` and `generation`, as a shared-beacon round recorded when it
    /// became paid takes joins until its close: they enter the counter the
    /// group's tickets are in now, found as `close_n` finds it, so that the
    /// group keeps one side and one generation and `close_n` later releases
    /// every one of them. Leaves the counters untouched if it fails.
    ///
    /// A group in `before` takes no ticket at or after the live close
    /// (`Reject::EpochClosed`): `before` holds only tickets opened before the
    /// close, as rule 3 puts a single ticket opened at `now` (`open`), so
    /// that the set of tickets an epoch's price contains is fixed at its
    /// close, and nothing joined after it is priced into it.
    pub fn join_n(&mut self, now: i64, side: Side, generation: u32, n: u32) -> Result<(), Reject> {
        let previous = self.generation.checked_sub(1);
        let in_before = match side {
            Side::BeforeClose => generation == self.generation,
            Side::AfterClose => Some(generation) == previous,
        };
        if in_before {
            if self.close_ts == 0 || now >= self.close_ts {
                return Err(Reject::EpochClosed);
            }
            self.before = self.before.checked_add(n).ok_or(Reject::Overflow)?;
            return Ok(());
        }
        if side == Side::AfterClose && generation == self.generation {
            self.after = self.after.checked_add(n).ok_or(Reject::Overflow)?;
            return Ok(());
        }
        // A group whose counter is gone (two generation changes since it was
        // recorded, which no open group can outlive) takes nothing.
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
    fn a_group_takes_joins_in_the_counter_it_is_in_now() {
        // recorded after the close of generation 0
        let mut c = Counters {
            close_ts: 600,
            ..Counters::default()
        };
        let (side, g) = c.open_n(700, 2).unwrap();
        assert_eq!((side, g), (Side::AfterClose, 0));
        c.join_n(800, side, g, 1).unwrap();
        assert_eq!((c.before, c.after), (0, 3));
        // a strike rolls it into `before`; later joins follow it there
        c.roll(1_200).unwrap();
        c.join_n(900, side, g, 2).unwrap();
        assert_eq!((c.before, c.after, c.generation), (5, 0, 1));
        // ... until that epoch's close: from it on, the group takes nothing
        let snapshot = c;
        assert_eq!(c.join_n(1_200, side, g, 1), Err(Reject::EpochClosed));
        assert_eq!(c, snapshot);
        c.close_n(side, g, 5).unwrap();
        assert!(c.clean());
        // recorded before the close: joins stay before it, up to the close
        let (side, g) = c.open_n(1_000, 1).unwrap();
        assert_eq!(side, Side::BeforeClose);
        c.join_n(1_199, side, g, 4).unwrap();
        assert_eq!((c.before, c.after), (5, 0));
        let snapshot = c;
        assert_eq!(c.join_n(1_200, side, g, 1), Err(Reject::EpochClosed));
        assert_eq!(c.join_n(5_000, side, g, 1), Err(Reject::EpochClosed));
        assert_eq!(c, snapshot);
        // a group in `before` with no close set takes nothing either
        let mut cleared = Counters {
            before: 1,
            generation: 1,
            ..Counters::default()
        };
        let snapshot = cleared;
        assert_eq!(
            cleared.join_n(0, Side::BeforeClose, 1, 1),
            Err(Reject::EpochClosed)
        );
        assert_eq!(cleared, snapshot);
        // a group in `after` takes joins whatever the time
        let (side, g) = c.open_n(1_300, 1).unwrap();
        assert_eq!(side, Side::AfterClose);
        c.join_n(9_000, side, g, 2).unwrap();
        assert_eq!((c.before, c.after), (5, 3));
        // a group two generations old, or from the future, takes nothing
        let snapshot = c;
        assert_eq!(c.join_n(0, Side::AfterClose, 7, 1), Err(Reject::Overflow));
        assert_eq!(c.join_n(0, Side::BeforeClose, 0, 1), Err(Reject::Overflow));
        assert_eq!(c, snapshot);
        // overflow leaves the counters alone
        let mut full = Counters {
            before: u32::MAX,
            generation: 1,
            close_ts: 600,
            ..Counters::default()
        };
        let snapshot = full;
        assert_eq!(
            full.join_n(0, Side::BeforeClose, 1, 1),
            Err(Reject::Overflow)
        );
        assert_eq!(full, snapshot);
    }

    #[test]
    fn join_rule() {
        assert_eq!(join(false, 0, 10), Join::Open);
        assert_eq!(join(true, 600, 599), Join::Current);
        assert_eq!(join(true, 600, 600), Join::Next);
    }
}
