//! A 24-hour loosening leaves LPs a strike before it applies (the re-audit
//! of 24 October 2026): lengthening `epoch_length_seconds` applies at once,
//! and at 86 400 s an epoch an LP entered when a loosening was queued at a
//! UTC midnight closed exactly at its `effective_at`, so `apply_params` could
//! land first and the loosened parameters admit tickets against the LP's
//! capital before its strike. The epoch is now bounded by
//! `MAX_EPOCH_LENGTH_SECONDS`, a quarter of the shortest loosening delay. An
//! epoch closes at most one epoch length after the request it opens on, so
//! a withdrawal requested within 18 hours of the queueing lands in an epoch
//! that closes before `effective_at`: 6 hours before for a queueing on the
//! epoch grid, one second for the worst one off it. The strike follows the
//! close once every ticket opened before it is settled or expired, so the
//! notice an LP can count on is that distance less those tickets' lifetime,
//! and the last tests show both edges (Spec 05 §3).
//!
//! On the code before the fix `set_params(epoch_length_seconds = 86 400)`
//! applied at once and the first test fails there.

mod common;
use common::*;
use fade::errors::FadeError;
use fade::state::RiskParams;
use fade::{DELAY_24H, MAX_EPOCH_LENGTH_SECONDS};

const DAY: i64 = 86_400;

/// Opens 50 USDC coin flips from fresh players until admission refuses three
/// fresh players in a row. Returns how many were admitted.
fn fill(env: &mut Env) -> u32 {
    let mut admitted = 0u32;
    let mut refused_in_a_row = 0;
    while refused_in_a_row < 3 && admitted < 2_000 {
        let p = env.user(100_000 * USDC);
        let mut opened_here = 0;
        while admitted < 2_000 && env.open_direct(&p, 50 * USDC, &coin_flip(), 0).is_ok() {
            admitted += 1;
            opened_here += 1;
        }
        if opened_here == 0 {
            refused_in_a_row += 1;
        } else {
            refused_in_a_row = 0;
        }
    }
    admitted
}

fn loosened(mut p: RiskParams) -> RiskParams {
    p.kelly_fraction_bps = 10_000;
    p.utilisation_breaker_bps = 10_000;
    p.whale_bps = 10_000;
    p.censorship_bps = 1_000;
    p
}

#[test]
fn an_epoch_as_long_as_the_notice_is_refused() {
    let mut env = Env::new();
    env.found(10_000 * USDC);
    for len in [DAY as u64, MAX_EPOCH_LENGTH_SECONDS + 1] {
        let mut p = env.config().params;
        p.epoch_length_seconds = len;
        assert_fails_with(env.set_params(p), FadeError::InvalidParams);
    }
    assert_eq!(env.config().params.epoch_length_seconds, 600);
    assert!(!env.config().pending.active);
}

/// With `epoch_len` in force, the council queues a 24-hour loosening at
/// `t`, `offset` seconds after a UTC midnight (a multiple of every epoch
/// length), and the LP asks for all its shares `react` seconds later.
/// Returns the env, the LP's epoch, its close and the change's
/// `effective_at`.
fn queue_and_request(epoch_len: u64, offset: i64, react: i64) -> (Env, u64, i64, i64) {
    let mut env = Env::new();
    let lp = env.found(10_000 * USDC);
    if epoch_len != 600 {
        let mut p = env.config().params;
        p.epoch_length_seconds = epoch_len;
        env.set_params(p).unwrap();
        let c = env.config();
        assert!(!c.pending.active, "lengthening is applied at once");
        assert_eq!(c.params.epoch_length_seconds, epoch_len);
    }
    let t = (env.now() / DAY + 2) * DAY + offset;
    let slot = env.slot();
    env.set_time(slot + 10, t);
    let new = loosened(env.config().params);
    assert_eq!(env.config().params.change_delay(&new), DELAY_24H);
    env.set_params(new).unwrap();
    let effective_at = env.config().pending.effective_at;
    assert_eq!(effective_at, t + DELAY_24H);

    let slot = env.slot();
    env.set_time(slot + 10, t + react);
    let shares = env.balance(&lp.shares());
    let epoch = env.withdraw(&lp, shares).unwrap();
    let close = env.queue().current.close_ts;
    (env, epoch, close, effective_at)
}

/// `queue_and_request`, then the close is passed and `apply_params` tried
/// there, before the strike; the strike runs after an app fills the vault
/// with after-close tickets. Returns the LP epoch's close, the change's
/// `effective_at`, and whether `apply_params` landed first.
fn scenario(epoch_len: u64, offset: i64, react: i64) -> (i64, i64, bool) {
    let (mut env, epoch, close, effective_at) = queue_and_request(epoch_len, offset, react);
    env.pass_close();
    let applied = env.apply_params().is_ok();
    if !applied {
        assert_fails_with(env.apply_params(), FadeError::ChangeNotDue);
    }
    fill(&mut env);
    env.strike().unwrap();
    let r = env.record(epoch);
    assert!(r.assets_paid > 0);
    if !applied {
        assert_eq!(
            env.config().params.kelly_fraction_bps,
            RiskParams::SPEC.kelly_fraction_bps,
            "struck under the parameters in force"
        );
    }
    (close, effective_at, applied)
}

/// The last second of the 18 hours the bound leaves.
const LAST: i64 = DELAY_24H - MAX_EPOCH_LENGTH_SECONDS as i64 - 1;

#[test]
fn the_longest_epoch_still_strikes_before_a_24h_loosening_applies() {
    assert_eq!(LAST, 18 * 3_600 - 1);
    // Queued on the grid: at once, and at the last second, with 6 hours left.
    for react in [0, LAST] {
        let (close, eff, applied) = scenario(MAX_EPOCH_LENGTH_SECONDS, 0, react);
        assert!(close < eff, "react {react}: close {close}, effective {eff}");
        assert!(
            !applied,
            "react {react}: the loosening is not due at the close"
        );
    }
    let (close, eff, _) = scenario(MAX_EPOCH_LENGTH_SECONDS, 0, LAST);
    assert_eq!(eff - close, MAX_EPOCH_LENGTH_SECONDS as i64);
    // The default epoch, for comparison: a day of notice, less ten minutes.
    let (close, eff, applied) = scenario(600, 0, 0);
    assert!(close <= eff - DELAY_24H + 600);
    assert!(!applied);
}

/// The worst case of the bound: queued a second after a grid point, a request
/// at the last second of the 18 hours lands in an epoch that closes one
/// second before `effective_at`. The close comes first, and the strike with
/// it while no ticket opened before the close is open.
#[test]
fn off_the_grid_the_last_second_leaves_one_second() {
    let (close, eff, applied) = scenario(MAX_EPOCH_LENGTH_SECONDS, 1, LAST);
    assert_eq!(eff - close, 1);
    assert!(!applied, "the loosening is not due at the close");
}

/// What the bound does not cover: the strike waits for every ticket opened
/// before the close, so a ticket open across a close one second before
/// `effective_at` lets `apply_params` land first. An LP has the close's
/// distance to `effective_at`, less that ticket's lifetime, not 18 hours
/// flat.
#[test]
fn a_ticket_open_across_a_late_close_lets_the_change_land_first() {
    let (mut env, epoch, close, eff) = queue_and_request(MAX_EPOCH_LENGTH_SECONDS, 1, LAST);
    assert_eq!(eff - close, 1);
    let player = env.user(100 * USDC);
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.pass_close();
    assert_fails_with(env.strike(), FadeError::StrikeNotClean);
    env.advance(1, 1);
    assert!(env.now() >= eff);
    env.apply_params().unwrap();
    assert_eq!(env.config().params.kelly_fraction_bps, 10_000);
    // The ticket's window ends, it is forfeited, and the strike runs, under
    // the loosened parameters.
    let t_settle = env.config().params.t_settle_slots;
    env.advance(t_settle + 1, 60);
    env.expire(&ticket).unwrap();
    env.strike().unwrap();
    assert!(env.record(epoch).assets_paid > 0);
}
