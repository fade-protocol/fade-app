//! Integrator identity (Spec 07 §1–§2, Spec 04 §4.4): the record is created by
//! the first ticket and keyed on the address that signed it — a wallet, or a
//! program's `["fade-integrator"]` PDA over CPI — and nothing short of that
//! signature can act as the integrator.

mod common;
use anchor_lang::{InstructionData, ToAccountMetas};
use common::*;
use fade::errors::FadeError;
use fade::state::Integrator;
use solana_address::Address;
use solana_instruction::Instruction;

fn integrator_pda() -> Address {
    pda(
        &[fade::INTEGRATOR_AUTHORITY_SEED],
        &addr(test_integrator::ID),
    )
}

/// `test_integrator::forward` around a Fade instruction.
fn forward(inner: &Instruction, sign: bool, claim_signer: Option<Address>) -> Instruction {
    let mut accounts = metas(
        test_integrator::accounts::Forward {
            integrator_authority: pk(integrator_pda()),
            fade_program: fade::ID,
        }
        .to_account_metas(None),
    );
    // The PDA cannot sign the outer transaction: the program signs for it.
    accounts.extend(inner.accounts.iter().cloned().map(|mut m| {
        if m.pubkey == integrator_pda() {
            m.is_signer = false;
        }
        m
    }));
    Instruction {
        program_id: addr(test_integrator::ID),
        accounts,
        data: test_integrator::instruction::Forward {
            data: inner.data.clone(),
            sign,
            claim_signer: claim_signer.map(pk),
        }
        .data(),
    }
}

#[test]
fn a_wallet_integrator_gets_its_record_from_its_first_ticket() {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let studio = env.user(0);
    let share_account = env.usdc_account(&studio.key(), 0);
    let player = env.user(1_000 * USDC);
    let mut args = OpenArgs::direct(&env, &player, 25 * USDC, &slot_classic(), 50);
    args.authority = studio.key();
    args.share_account = share_account;
    args.nonce = 0;
    let ix = env.open_ticket_ix(&args);
    let (pkp, skp) = (player.kp.insecure_clone(), studio.kp.insecure_clone());
    env.send(&[ix], &[&pkp, &skp]).unwrap();
    let record: Integrator = env.read(&env.integrator_address(&studio.key()));
    assert_eq!(addr(record.authority), studio.key());
    assert_eq!(addr(record.share_account), share_account);
    assert_eq!(record.next_nonce, 1);
    assert_eq!(record.open_tickets, 1);
    assert_eq!(record.volume_total, 25 * USDC);
    assert_eq!(env.balance(&share_account), 125_000, "50 bps of 25 USDC");
    assert_eq!(env.vault().integrators, 1);

    // The share destination is the stored one: another is refused…
    let elsewhere = env.usdc_account(&studio.key(), 0);
    let mut args = OpenArgs::direct(&env, &player, 25 * USDC, &slot_classic(), 50);
    args.authority = studio.key();
    args.share_account = elsewhere;
    args.nonce = 1;
    let ix = env.open_ticket_ix(&args);
    assert_fails_with(
        env.send(&[ix], &[&pkp, &skp]),
        FadeError::ShareAccountMismatch,
    );
    // …until the integrator itself moves it.
    let ix = Instruction {
        program_id: fade_id(),
        accounts: metas(
            fade::accounts::SetShareAccount {
                integrator_authority: pk(studio.key()),
                config: pk(env.a.config),
                integrator: pk(env.integrator_address(&studio.key())),
                share_account: pk(elsewhere),
                event_authority: pk(env.a.event_authority),
                program: fade::ID,
            }
            .to_account_metas(None),
        ),
        data: fade::instruction::SetShareAccount {}.data(),
    };
    // A frozen account cannot be set: every later ticket would be refused.
    let frozen = env.usdc_account(&studio.key(), 0);
    env.set_token_state(&frozen, 2);
    let mut frozen_ix = ix.clone();
    frozen_ix.accounts[3].pubkey = frozen;
    assert_fails_with(env.send(&[frozen_ix], &[&skp]), FadeError::WrongMint);
    env.send(&[ix], &[&skp]).unwrap();
    let ix = env.open_ticket_ix(&args);
    env.send(&[ix], &[&pkp, &skp]).unwrap();
    assert_eq!(env.balance(&elsewhere), 125_000);
}

#[test]
fn nobody_else_can_move_an_integrators_share_account() {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let player = env.user(1_000 * USDC);
    env.open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let thief = env.user(0);
    let loot = env.usdc_account(&thief.key(), 0);
    // The record is found from the signer, so a thief signing reaches its own
    // (absent) record, never the player's.
    let ix = Instruction {
        program_id: fade_id(),
        accounts: metas(
            fade::accounts::SetShareAccount {
                integrator_authority: pk(thief.key()),
                config: pk(env.a.config),
                integrator: pk(env.integrator_address(&player.key())),
                share_account: pk(loot),
                event_authority: pk(env.a.event_authority),
                program: fade::ID,
            }
            .to_account_metas(None),
        ),
        data: fade::instruction::SetShareAccount {}.data(),
    };
    let kp = thief.kp.insecure_clone();
    assert!(env.send(&[ix], &[&kp]).is_err());
    let record: Integrator = env.read(&env.integrator_address(&player.key()));
    assert_eq!(addr(record.share_account), player.usdc);
}

#[test]
fn a_program_integrator_signs_with_its_pda_over_cpi() {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let player = env.user(1_000 * USDC);
    let studio_share = env.usdc_account(&Address::new_unique(), 0);
    let mut args = OpenArgs::direct(&env, &player, 25 * USDC, &slot_classic(), 50);
    args.authority = integrator_pda();
    args.share_account = studio_share;
    args.nonce = 0;
    let inner = env.open_ticket_ix(&args);
    let kp = player.kp.insecure_clone();
    env.send(&[forward(&inner, true, None)], &[&kp]).unwrap();
    let record: Integrator = env.read(&env.integrator_address(&integrator_pda()));
    assert_eq!(addr(record.authority), integrator_pda());
    assert_eq!(env.balance(&studio_share), 125_000);
    // The ticket plays out like any other.
    let ticket = env.ticket_address(&integrator_pda(), 0);
    env.play_out(&ticket, 4);
    let record: Integrator = env.read(&env.integrator_address(&integrator_pda()));
    assert_eq!((record.open_tickets, record.reserved_liability), (0, 0));
}

#[test]
fn nothing_short_of_the_signature_acts_as_the_integrator() {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let player = env.user(1_000 * USDC);
    let kp = player.kp.insecure_clone();

    // The program passes its PDA without signing for it.
    let mut args = OpenArgs::direct(&env, &player, 25 * USDC, &coin_flip(), 0);
    args.authority = integrator_pda();
    args.nonce = 0;
    let inner = env.open_ticket_ix(&args);
    let unsigned = env.send(&[forward(&inner, false, None)], &[&kp]);
    assert!(unsigned.is_err(), "an unsigned identity is refused");

    // A program tries to sign as a victim wallet integrator it cannot sign for.
    let victim = env.user(1_000 * USDC);
    env.open_direct(&victim, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let mut args = OpenArgs::direct(&env, &player, 25 * USDC, &coin_flip(), 0);
    args.authority = victim.key();
    args.share_account = victim.usdc;
    args.nonce = 1;
    let mut inner = env.open_ticket_ix(&args);
    for m in inner.accounts.iter_mut() {
        if m.pubkey == victim.key() {
            m.is_signer = false;
        }
    }
    let spoof = env.send(&[forward(&inner, false, Some(victim.key()))], &[&kp]);
    assert!(
        spoof.is_err(),
        "the runtime refuses a signature the caller cannot produce"
    );
    let record: Integrator = env.read(&env.integrator_address(&victim.key()));
    assert_eq!(record.next_nonce, 1, "the victim's record is untouched");

    // Signing the outer transaction directly with someone else's key is impossible;
    // leaving the authority unsigned is refused before anything happens.
    let mut ix = env.open_ticket_ix(&args);
    for m in ix.accounts.iter_mut() {
        if m.pubkey == victim.key() {
            m.is_signer = false;
        }
    }
    assert!(env.send(&[ix], &[&kp]).is_err());
}
