//! The targeted integrator pause against a hostile integrator (Spec 05 §4, §5c).
//!
//! An integrator is the key that signs as `integrator_authority`, and its pause
//! is the flag on the record at `["integrator", authority]`. Nothing ties a
//! record to the party behind it, so one party can enrol several keys before
//! it is noticed, each with its own unpaused record. These tests pin what the
//! §5(c) playbook relies on: `PAUSE_NEW_INTEGRATORS` set with the targeted
//! pause refuses every key not yet enrolled; a key already enrolled stays open
//! until its own record is paused, which the guardian can do for many records
//! in one transaction; `PAUSE_TICKETS` stops every record at once; an honest
//! integrator is untouched by all but the last.

mod common;
use common::*;
use fade::errors::FadeError;
use fade::state::{Config, RoundStatus};
use litesvm::types::TransactionMetadata;
use solana_address::Address;
use solana_signer::Signer;

/// One party (funder, payer and share account) and the authority keys it
/// signs with.
struct Party {
    funder: User,
    keys: Vec<User>,
}

fn party(env: &mut Env, keys: usize) -> Party {
    Party {
        funder: env.user(1_000 * USDC),
        keys: (0..keys).map(|_| env.user(0)).collect(),
    }
}

/// A 25 USDC direct coin flip from `key`, paid by the party.
fn open(env: &mut Env, p: &Party, key: &User) -> Result<TransactionMetadata, Failure> {
    let mut args = OpenArgs::direct(env, &p.funder, 25 * USDC, &coin_flip(), 50);
    args.authority = key.key();
    args.share_account = p.funder.usdc;
    args.nonce = env.next_nonce(&key.key());
    let ix = env.open_ticket_ix(&args);
    let funder = p.funder.kp.insecure_clone();
    let signer = key.kp.insecure_clone();
    env.send(&[ix], &[&funder, &signer])
}

/// A 1 USDC beacon coin flip from `key`, paid by the party.
fn join(env: &mut Env, p: &Party, key: &User) -> Result<TransactionMetadata, Failure> {
    let mut j = JoinArgs::direct(env, &p.funder, &coin_flip(), USDC, 0, 0);
    j.authority = key.key();
    j.nonce = env.next_nonce(&key.key());
    let ix = env.join_round_ix(&j);
    let funder = p.funder.kp.insecure_clone();
    let signer = key.kp.insecure_clone();
    env.send(&[ix], &[&funder, &signer])
}

/// The guardian pauses `keys`' records in one transaction, with
/// `PAUSE_NEW_INTEGRATORS` written by each instruction.
fn pause_records(env: &mut Env, keys: &[&User]) {
    let guardian = env.guardian.insecure_clone();
    let ixs: Vec<_> = keys
        .iter()
        .map(|k| {
            let record: Address = env.integrator_address(&k.key());
            env.set_pause_flags_ix(
                &guardian.pubkey(),
                Config::PAUSE_NEW_INTEGRATORS,
                Some((record, true)),
            )
        })
        .collect();
    env.send(&ixs, &[&guardian]).unwrap();
}

#[test]
fn the_targeted_pause_holds_only_against_keys_already_enrolled_and_paused() {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let honest = env.user(1_000 * USDC);
    env.open_direct(&honest, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let p = party(&mut env, 4);
    let fresh = env.user(0);

    // Before anything is noticed, the party enrols three keys with one ticket
    // each; the fourth key stays unused.
    for k in &p.keys[..3] {
        open(&mut env, &p, k).unwrap();
    }
    assert_eq!(
        addr(env.integrator(&p.keys[2].key()).share_account),
        p.funder.usdc,
        "every record names the same share account"
    );

    // The guardian pauses the record it sees draining, together with
    // PAUSE_NEW_INTEGRATORS (Spec 05 §5c).
    pause_records(&mut env, &[&p.keys[0]]);
    assert_fails_with(open(&mut env, &p, &p.keys[0]), FadeError::IntegratorPaused);
    // No key without a record gets one: the party's unused key or anyone's.
    assert_fails_with(open(&mut env, &p, &p.keys[3]), FadeError::Paused);
    assert_fails_with(open(&mut env, &p, &fresh), FadeError::Paused);
    assert!(!env.exists(&env.integrator_address(&p.keys[3].key())));
    // A key enrolled before the pause is its own integrator, and stays open.
    open(&mut env, &p, &p.keys[1]).expect("an enrolled key keeps its own record");

    // Every record of the party pauses in one guardian transaction.
    pause_records(&mut env, &[&p.keys[1], &p.keys[2]]);
    for k in &p.keys[..3] {
        assert_fails_with(open(&mut env, &p, k), FadeError::IntegratorPaused);
    }
    // An honest integrator with a record is untouched by every targeted pause.
    env.open_direct(&honest, 25 * USDC, &coin_flip(), 0)
        .unwrap();

    // PAUSE_TICKETS is the control that needs no knowledge of the records.
    let guardian = env.guardian.insecure_clone();
    env.set_pause_flags(
        &guardian,
        Config::PAUSE_TICKETS | Config::PAUSE_NEW_INTEGRATORS,
        None,
    )
    .unwrap();
    assert_fails_with(
        env.open_direct(&honest, 25 * USDC, &coin_flip(), 0),
        FadeError::Paused,
    );
    assert_eq!(env.vault().integrators, 4);
}

#[test]
fn a_join_follows_the_same_rule() {
    let mut env = Env::new();
    env.found(100_000 * USDC);
    let k = env.keeper.insecure_clone();
    env.register_payout_table(&k, &coin_flip()).unwrap();
    let honest = env.user(100 * USDC);
    env.join(&honest, &coin_flip(), USDC, 0, 0).unwrap();
    let p = party(&mut env, 3);

    for k in &p.keys[..2] {
        join(&mut env, &p, k).unwrap();
    }
    pause_records(&mut env, &[&p.keys[0]]);
    assert_fails_with(join(&mut env, &p, &p.keys[0]), FadeError::IntegratorPaused);
    assert_fails_with(join(&mut env, &p, &p.keys[2]), FadeError::Paused);
    join(&mut env, &p, &p.keys[1]).expect("an enrolled key keeps its own record");

    pause_records(&mut env, &[&p.keys[1]]);
    assert_fails_with(join(&mut env, &p, &p.keys[1]), FadeError::IntegratorPaused);
    env.join(&honest, &coin_flip(), USDC, 0, 0).unwrap();

    // PAUSE_TICKETS alone stops the beacon too: every join, the honest one
    // included, and the sponsorship of an Accepting round (Spec 08 §13.7);
    // PAUSE_ROUNDS is not needed against a hostile integrator.
    let guardian = env.guardian.insecure_clone();
    env.set_pause_flags(
        &guardian,
        Config::PAUSE_TICKETS | Config::PAUSE_NEW_INTEGRATORS,
        None,
    )
    .unwrap();
    assert!(!env.config().is_paused(Config::PAUSE_ROUNDS));
    assert_fails_with(join(&mut env, &p, &p.keys[2]), FadeError::Paused);
    assert_fails_with(
        env.join(&honest, &coin_flip(), USDC, 0, 0),
        FadeError::Paused,
    );
    assert_eq!(env.round(1).status, RoundStatus::Accepting);
    let sponsor = env.user(0);
    let sponsor = sponsor.kp.insecure_clone();
    assert_fails_with(env.sponsor(&sponsor, 1, 1_000_000), FadeError::Paused);
}
