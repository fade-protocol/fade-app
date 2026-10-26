//! What reaches a closed direct ticket's `vrf_payer` is not stranded (audit
//! of 22 October 2026, F-4): ORAO refunds a pending request's rent to
//! `vrf_payer` when it fulfils it, which for a ticket expired with its
//! request pending comes after the ticket's close. `sweep_ticket_vrf(nonce)`
//! moves it to its caller.
//!
//! The instruction does not exist on the code before the fix: every test
//! here fails there.

mod common;
use common::*;
use fade::errors::FadeError;
use fade::events::{TicketExpired, TicketVrfSwept};
use fade_math::orao_layout;
use solana_instruction::{AccountMeta, Instruction};
use solana_signer::Signer;

fn setup() -> (Env, User) {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let player = env.user(1_000 * USDC);
    (env, player)
}

#[test]
fn orao_refund_after_an_expiry_is_swept_to_the_caller() {
    let (mut env, player) = setup();
    let nonce = env.next_nonce(&player.key());
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let vrf_payer = env.vrf_payer(&ticket);
    let request = env.request_randomness(&ticket).unwrap();
    let pending_rent = env.lamports(&request);
    env.advance(151, 60);
    let meta = env.expire(&ticket).unwrap();
    assert!(
        events::<TicketExpired>(&meta)[0].pending,
        "the refund is still to come"
    );
    assert_eq!(env.lamports(&vrf_payer), 0);

    env.fulfill(&request, [7u8; 64]);
    let refund = pending_rent
        - env
            .svm
            .minimum_balance_for_rent_exemption(orao_layout::FULFILLED_LEN);
    assert!(refund > 0);
    assert_eq!(env.lamports(&vrf_payer), refund);

    // Many slots later, by anyone.
    env.advance(10_000, 4_000);
    let sweeper = env.user(0);
    let before = env.lamports(&sweeper.key());
    let ix = env.sweep_ticket_vrf_ix(&sweeper.key(), &player.key(), nonce);
    let kp = sweeper.kp.insecure_clone();
    let meta = env.send(&[ix], &[&kp]).unwrap();
    assert_eq!(env.lamports(&vrf_payer), 0);
    assert_eq!(env.lamports(&sweeper.key()), before + refund - 5_000);
    let e = &events::<TicketVrfSwept>(&meta)[0];
    assert_eq!(
        (addr(e.ticket), e.nonce, addr(e.to), e.lamports),
        (ticket, nonce, sweeper.key(), refund)
    );

    // Nothing left: succeeds without moving or emitting anything.
    let ix = env.sweep_ticket_vrf_ix(&sweeper.key(), &player.key(), nonce);
    let meta = env.send(&[ix], &[&kp]).unwrap();
    assert!(events::<TicketVrfSwept>(&meta).is_empty());

    // A stray transfer to the closed ticket's vrf_payer is swept as well.
    let mut data = 2u32.to_le_bytes().to_vec(); // SystemInstruction::Transfer
    data.extend_from_slice(&1_000_000u64.to_le_bytes());
    let ix = Instruction {
        program_id: system_id(),
        accounts: vec![
            AccountMeta::new(player.key(), true),
            AccountMeta::new(vrf_payer, false),
        ],
        data,
    };
    let pkp = player.kp.insecure_clone();
    env.send(&[ix], &[&pkp]).unwrap();
    let ix = env.sweep_ticket_vrf_ix(&sweeper.key(), &player.key(), nonce);
    let meta = env.send(&[ix], &[&kp]).unwrap();
    assert_eq!(events::<TicketVrfSwept>(&meta)[0].lamports, 1_000_000);
    assert_eq!(env.lamports(&vrf_payer), 0);
}

#[test]
fn a_live_ticket_or_a_future_nonce_is_refused() {
    let (mut env, player) = setup();
    let nonce = env.next_nonce(&player.key());
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let keeper = env.keeper.insecure_clone();
    let sweep = |env: &Env, n: u64| env.sweep_ticket_vrf_ix(&keeper.pubkey(), &player.key(), n);

    // Open, Requested, then PayoutPending: the ticket's own close drains it.
    let ix = sweep(&env, nonce);
    assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::WrongTicketStatus);
    let request = env.request_randomness(&ticket).unwrap();
    let ix = sweep(&env, nonce);
    assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::WrongTicketStatus);
    let r = env.randomness_for(&ticket, 0);
    env.fulfill(&request, r);
    env.set_token_state(&player.usdc, 2);
    env.settle(&ticket).unwrap();
    assert_eq!(
        env.ticket(&ticket).status,
        fade::state::TicketStatus::PayoutPending
    );
    let ix = sweep(&env, nonce);
    assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::WrongTicketStatus);

    // A nonce the integrator has not reached names no ticket yet.
    let ix = sweep(&env, nonce + 1);
    assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::WrongNonce);
}
