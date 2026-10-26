//! κ cannot freeze LP exits (audit of 22 October 2026, F-1): the strike keeps
//! `max(committed, ceil(reserved / κ))` in the vault, so a low κ would hold
//! back many times the reserved liability. κ has a program floor of 0.8
//! (`MIN_KAPPA_BPS`), every change to it waits 24 hours, and `apply_params`
//! checks the pending parameters again.
//!
//! On the code before the fix `set_params(kappa_bps = 77)` applied at once
//! and a cut to 8 000 was not queued: both tests here fail there.

mod common;
use anchor_lang::{AccountDeserialize, AccountSerialize};
use common::*;
use fade::errors::FadeError;
use fade::events::ParamsChanged;
use fade::state::{Config, RiskParams};
use fade::{DELAY_24H, MIN_KAPPA_BPS};

#[test]
fn kappa_below_the_floor_is_refused() {
    let mut env = Env::new();
    env.found(10_000 * USDC);
    for kappa in [77, 5_000, MIN_KAPPA_BPS - 1] {
        let mut p = RiskParams::SPEC;
        p.kappa_bps = kappa;
        assert_fails_with(env.set_params(p), FadeError::InvalidParams);
    }
    assert_eq!(env.config().params.kappa_bps, RiskParams::SPEC.kappa_bps);
    assert!(!env.config().pending.active);
}

#[test]
fn a_kappa_cut_gives_a_day_of_notice() {
    let mut env = Env::new();
    // From 1.0, as a council that raised κ earlier would have left it.
    let mut high = RiskParams::SPEC;
    high.kappa_bps = 10_000;
    let mut c = env.config();
    c.params = high;
    write_config(&mut env, &c);

    let mut cut = high;
    cut.kappa_bps = MIN_KAPPA_BPS;
    let now = env.now();
    let meta = env.set_params(cut).unwrap();
    let e = &events::<ParamsChanged>(&meta)[0];
    assert!(!e.applied, "a cut of κ is not a tightening");
    assert_eq!(e.effective_at, now + DELAY_24H);
    let c = env.config();
    assert_eq!(
        c.params.kappa_bps, 10_000,
        "nothing changes before the delay"
    );
    assert!(c.pending.active);
    assert_eq!(c.pending.params.kappa_bps, MIN_KAPPA_BPS);
    assert_fails_with(env.apply_params(), FadeError::ChangeNotDue);
    env.advance(10, DELAY_24H);
    env.apply_params().unwrap();
    assert_eq!(env.config().params.kappa_bps, MIN_KAPPA_BPS);

    // And a raise back waits as long.
    let meta = env.set_params(high).unwrap();
    assert!(!events::<ParamsChanged>(&meta)[0].applied);
}

/// A change queued under looser ranges cannot land outside the current ones:
/// `apply_params` refuses it and the council cancels it.
#[test]
fn apply_params_checks_the_pending_parameters_again() {
    let mut env = Env::new();
    let mut c = env.config();
    let mut bad = RiskParams::SPEC;
    bad.kappa_bps = 77;
    c.pending.active = true;
    c.pending.effective_at = 0;
    c.pending.params = bad;
    c.pending.protocol_treasury = c.protocol_treasury;
    write_config(&mut env, &c);
    assert_fails_with(env.apply_params(), FadeError::InvalidParams);
    assert_eq!(env.config().params, RiskParams::SPEC);
    let council = env.council.insecure_clone();
    env.cancel_params(&council).unwrap();
    assert!(!env.config().pending.active);
}

fn write_config(env: &mut Env, c: &Config) {
    let mut acc = env.svm.get_account(&env.a.config).unwrap();
    let mut data = Vec::new();
    c.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), acc.data.len());
    acc.data = data;
    env.svm.set_account(env.a.config, acc).unwrap();
    let back =
        Config::try_deserialize(&mut env.svm.get_account(&env.a.config).unwrap().data.as_slice())
            .unwrap();
    assert_eq!(back.params, c.params);
}
