//! Initialisation, the parameter queue (Spec 05 §3, Spec 08 §7) and the pause
//! flags (Spec 05 §4): the guardian may only tighten, and no flag can block a
//! settlement, an expiry, a strike, a claim or a withdrawal request.

mod common;
use common::*;
use fade::errors::FadeError;
use fade::state::{Config, RiskParams};
use fade::{DELAY_24H, DELAY_72H, DELAY_7D};
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn initialize_needs_the_upgrade_authority_and_happens_once() {
    let mut env = Env::bare();
    let stranger = Keypair::new();
    env.svm
        .airdrop(&stranger.pubkey(), 1_000_000_000_000)
        .unwrap();
    let ix = env.initialize_ix(&stranger.pubkey(), RiskParams::SPEC);
    assert_fails_with(
        env.send(&[ix], &[&stranger]),
        FadeError::NotUpgradeAuthority,
    );
    let mut bad = RiskParams::SPEC;
    bad.kappa_bps = 0;
    assert_fails_with(env.initialize(bad), FadeError::InvalidParams);
    env.initialize(RiskParams::SPEC).unwrap();
    assert!(
        env.initialize(RiskParams::SPEC).is_err(),
        "a second initialize fails"
    );

    let c = env.config();
    assert_eq!(addr(c.council), env.council.pubkey());
    assert_eq!(addr(c.guardian), env.guardian.pubkey());
    assert_eq!(c.params, RiskParams::SPEC);
    assert!(!c.pending.active);
    assert_eq!(env.fund(), RiskParams::SPEC.fund_target_lamports);
    let q = env.queue();
    assert_eq!(q.next_epoch_id, 1);
    assert!(!q.current.live && !q.next.live);
    let vault = env.vault();
    assert_eq!(vault.total_assets, 0);
    assert_eq!(vault.price_maxima[0], 1_000_000_000_000_000);
}

#[test]
fn a_tightening_change_applies_at_once() {
    let mut env = Env::new();
    let mut p = RiskParams::SPEC;
    p.censorship_bps = 100;
    p.min_price = 30 * USDC;
    let treasury = env.config().protocol_treasury;
    env.set_params(p).unwrap();
    let c = env.config();
    assert_eq!(c.params, p);
    assert!(!c.pending.active);
    // Applied through the same path as `apply_params`: the treasury it names,
    // the current one, stays.
    assert_eq!(c.protocol_treasury, treasury);
}

#[test]
fn a_loosening_change_waits_its_class_and_anyone_applies_it() {
    let mut env = Env::new();
    for (change, delay) in [
        (
            Box::new(|p: &mut RiskParams| p.censorship_bps = 200) as Box<dyn Fn(&mut RiskParams)>,
            DELAY_24H,
        ),
        (
            Box::new(|p: &mut RiskParams| p.min_vault_margin_bps = 90),
            DELAY_7D,
        ),
        (
            Box::new(|p: &mut RiskParams| p.strike_reward_lamports = 150_000),
            DELAY_24H,
        ),
    ] {
        let mut p = env.config().params;
        change(&mut p);
        let now = env.now();
        env.set_params(p).unwrap();
        let c = env.config();
        assert!(c.pending.active);
        assert_eq!(c.pending.effective_at, now + delay);
        assert_ne!(c.params, p, "nothing applies before the delay");
        env.advance(10, delay - 1);
        assert_fails_with(env.apply_params(), FadeError::ChangeNotDue);
        env.advance(1, 1);
        env.apply_params().unwrap();
        let c = env.config();
        assert_eq!(c.params, p);
        assert!(!c.pending.active);
        assert_fails_with(env.apply_params(), FadeError::NoPendingChange);
    }
}

#[test]
fn a_new_treasury_waits_72_hours() {
    let mut env = Env::new();
    let council = env.council.insecure_clone();
    let treasury = env.usdc_account(&council.pubkey(), 0);
    let now = env.now();
    let ix = env.set_params_ix(&council.pubkey(), RiskParams::SPEC, &treasury);
    env.send(&[ix], &[&council]).unwrap();
    assert_eq!(env.config().pending.effective_at, now + DELAY_72H);
    env.advance(10, DELAY_72H);
    env.apply_params().unwrap();
    assert_eq!(addr(env.config().protocol_treasury), treasury);
}

#[test]
fn only_the_council_changes_or_cancels_and_a_new_change_replaces_the_pending_one() {
    let mut env = Env::new();
    let guardian = env.guardian.insecure_clone();
    let mut p = RiskParams::SPEC;
    p.censorship_bps = 200;
    let ix = env.set_params_ix(&guardian.pubkey(), p, &env.treasury.clone());
    assert_fails_with(env.send(&[ix], &[&guardian]), FadeError::NotCouncil);
    env.set_params(p).unwrap();
    let first = env.config().pending.effective_at;
    env.advance(10, 3_600);
    p.censorship_bps = 180;
    env.set_params(p).unwrap();
    let c = env.config();
    assert_eq!(c.pending.params.censorship_bps, 180);
    assert_eq!(c.pending.effective_at, first + 3_600, "the clock restarts");
    assert_fails_with(env.cancel_params(&guardian), FadeError::NotCouncil);
    let council = env.council.insecure_clone();
    env.cancel_params(&council).unwrap();
    assert!(!env.config().pending.active);
    assert_eq!(env.config().params, RiskParams::SPEC);
    // A tightening while a loosening is pending applies and clears it.
    p.censorship_bps = 200;
    env.set_params(p).unwrap();
    let mut t = RiskParams::SPEC;
    t.censorship_bps = 100;
    env.set_params(t).unwrap();
    assert!(!env.config().pending.active);
    assert_eq!(env.config().params.censorship_bps, 100);
}

#[test]
fn the_guardian_pauses_and_only_the_council_unpauses() {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let guardian = env.guardian.insecure_clone();
    let council = env.council.insecure_clone();
    let stranger = env.user(0);
    let kp = stranger.kp.insecure_clone();
    assert_fails_with(
        env.set_pause_flags(&kp, Config::PAUSE_TICKETS, None),
        FadeError::NotGuardian,
    );
    assert_fails_with(
        env.set_pause_flags(&guardian, 1 << 5, None),
        FadeError::InvalidParams,
    );

    env.set_pause_flags(&guardian, Config::PAUSE_TICKETS, None)
        .unwrap();
    let player = env.user(1_000 * USDC);
    assert_fails_with(
        env.open_direct(&player, 25 * USDC, &coin_flip(), 0),
        FadeError::Paused,
    );
    assert_fails_with(
        env.set_pause_flags(&guardian, 0, None),
        FadeError::GuardianCannotUnpause,
    );
    // The guardian may add flags, never remove any.
    env.set_pause_flags(
        &guardian,
        Config::PAUSE_TICKETS | Config::PAUSE_DEPOSITS,
        None,
    )
    .unwrap();
    assert_fails_with(
        env.set_pause_flags(&guardian, Config::PAUSE_DEPOSITS, None),
        FadeError::GuardianCannotUnpause,
    );
    env.set_pause_flags(&council, 0, None).unwrap();
    env.open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
}

#[test]
fn no_pause_blocks_an_exit_a_settlement_a_strike_or_a_claim() {
    let mut env = Env::new();
    let lp = env.found(5_000 * USDC);
    let player = env.user(1_000 * USDC);
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let expiring = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let request = env.request_randomness(&ticket).unwrap();
    let depositor = env.user(1_000 * USDC);
    let deposit_epoch = env.deposit(&depositor, 100 * USDC).unwrap();

    let guardian = env.guardian.insecure_clone();
    env.set_pause_flags(&guardian, Config::PAUSE_ALL, None)
        .unwrap();
    // New tickets and new deposits stop…
    assert_fails_with(
        env.open_direct(&player, 25 * USDC, &coin_flip(), 0),
        FadeError::Paused,
    );
    let other = env.user(1_000 * USDC);
    assert_fails_with(env.deposit(&other, 100 * USDC), FadeError::Paused);
    // …everything that lets money out still works.
    let r = env.randomness_for(&ticket, 0);
    env.fulfill(&request, r);
    env.settle(&ticket).unwrap();
    env.advance(151, 60);
    env.expire(&expiring).unwrap();
    let shares = env.balance(&lp.shares());
    let withdraw_epoch = env.withdraw(&lp, shares / 2).unwrap();
    env.pass_close();
    env.strike().unwrap();
    env.claim_deposit(&depositor.key(), deposit_epoch).unwrap();
    env.claim_withdraw(&lp.key(), withdraw_epoch, withdraw_epoch)
        .unwrap();
    assert!(env.balance(&lp.usdc) > 0);
}

#[test]
fn new_integrator_records_and_single_integrators_can_be_paused() {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let known = env.user(1_000 * USDC);
    env.open_direct(&known, 25 * USDC, &coin_flip(), 0).unwrap();
    let guardian = env.guardian.insecure_clone();
    let council = env.council.insecure_clone();
    env.set_pause_flags(&guardian, Config::PAUSE_NEW_INTEGRATORS, None)
        .unwrap();
    // A signer with no record yet is refused; one that has a record is not.
    let newcomer = env.user(1_000 * USDC);
    assert_fails_with(
        env.open_direct(&newcomer, 25 * USDC, &coin_flip(), 0),
        FadeError::Paused,
    );
    env.open_direct(&known, 25 * USDC, &coin_flip(), 0).unwrap();
    // One integrator alone.
    let record = env.integrator_address(&known.key());
    env.set_pause_flags(
        &guardian,
        Config::PAUSE_NEW_INTEGRATORS,
        Some((record, true)),
    )
    .unwrap();
    assert_fails_with(
        env.open_direct(&known, 25 * USDC, &coin_flip(), 0),
        FadeError::IntegratorPaused,
    );
    assert_fails_with(
        env.set_pause_flags(
            &guardian,
            Config::PAUSE_NEW_INTEGRATORS,
            Some((record, false)),
        ),
        FadeError::GuardianCannotUnpause,
    );
    env.set_pause_flags(&council, 0, Some((record, false)))
        .unwrap();
    env.open_direct(&known, 25 * USDC, &coin_flip(), 0).unwrap();
    env.open_direct(&newcomer, 25 * USDC, &coin_flip(), 0)
        .unwrap();
}
