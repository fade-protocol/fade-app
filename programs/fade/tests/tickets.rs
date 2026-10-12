//! The ticket lifecycle at transaction level (Spec 02 §2, Spec 07 §1 and §5,
//! Technical Specification §3.6): request after entropy, settlement with no
//! deadline, forfeiture, the frozen beneficiary, and the admission checks.

mod common;
use anchor_lang::InstructionData;
use common::*;
use fade::errors::FadeError;
use fade::state::{Outcome, TicketStatus};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_signer::Signer;

fn integrator_rent(env: &Env) -> u64 {
    env.svm.minimum_balance_for_rent_exemption(
        8 + <fade::state::Integrator as anchor_lang::Space>::INIT_SPACE,
    )
}

fn setup() -> (Env, User) {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let player = env.user(1_000 * USDC);
    (env, player)
}

#[test]
fn a_loss_keeps_the_credit_and_every_lamport_is_accounted_for() {
    let (mut env, player) = setup();
    let keeper_before = env.lamports(&env.keeper.pubkey());
    let player_before = env.lamports(&player.key());
    let ticket = env
        .open_direct(&player, 25 * USDC, &slot_classic(), 0)
        .unwrap();
    let vrf_payer = env.vrf_payer(&ticket);
    let request_rent = env.svm.minimum_balance_for_rent_exemption(749);
    // Twice ORAO's fee, against a rise before the request; the rest comes back.
    assert_eq!(env.lamports(&vrf_payer), 2 * ORAO_FEE + request_rent);
    let w = env.ticket(&ticket);
    assert_eq!(w.status, TicketStatus::Open);
    assert_eq!(w.crank_request_lamports + w.crank_settle_lamports, 250_000);

    env.play_out(&ticket, 4); // m = 0
    assert!(!env.exists(&ticket));
    assert_eq!(env.lamports(&vrf_payer), 0, "the prefund is drained back");
    // The vault keeps the ticket price net of the protocol share.
    let vault = env.vault();
    assert_eq!(vault.total_assets, 5_000 * USDC + 25 * USDC - 50_000);
    assert_eq!(env.balance(&env.a.vault_usdc), vault.total_assets);
    assert_eq!(
        (vault.total_reserved_liability, vault.open_vault_credits),
        (0, 0)
    );
    // The keeper sent the request, the fulfilment and the settlement: three fees
    // of 5 000 lamports, against the two crank shares.
    let keeper_after = env.lamports(&env.keeper.pubkey());
    assert_eq!(keeper_after + 3 * 5_000, keeper_before + 250_000);
    // The player paid the transaction fee, the ORAO fee, the rent ORAO keeps
    // for good and the crank fee; the ticket's rent came back.
    let locked = env.svm.minimum_balance_for_rent_exemption(137);
    assert_eq!(
        player_before - env.lamports(&player.key()),
        5_000 + ORAO_FEE + locked + 250_000 + integrator_rent(&env)
    );
}

#[test]
fn randomness_is_requested_only_inside_its_window_from_entropy_after_the_open() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let open_slot = env.ticket(&ticket).open_slot;
    let keeper = env.keeper.insecure_clone();

    // One slot after the open is too early: the first slot after it is not final.
    env.advance(1, 1);
    let early = Address::new_unique();
    let ix = env.request_randomness_ix(&keeper.pubkey(), &ticket, &early);
    assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::RequestWindow);

    // With the slot right after the open skipped, s* is the next one present.
    let now = env.now();
    env.set_time_skipping(open_slot + 3, now + 1, &[open_slot + 1]);
    let request = env.request_address(&ticket);
    let ix = env.request_randomness_ix(&keeper.pubkey(), &ticket, &request);
    env.send(&[ix], &[&keeper]).unwrap();
    let w = env.ticket(&ticket);
    assert_eq!(w.status, TicketStatus::Requested);
    assert_eq!(w.entropy_slot, open_slot + 2);
    assert_eq!(w.entropy_hash, slot_hash(open_slot + 2));
    assert_eq!(common::addr(w.randomness), request);

    // A second request is refused: the ticket is no longer Open.
    let ix = env.request_randomness_ix(&keeper.pubkey(), &ticket, &request);
    assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::WrongTicketStatus);

    // Too late: past T_SETTLE nobody can request any more.
    let late = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(151, 60);
    let request = env.request_address(&late);
    let ix = env.request_randomness_ix(&keeper.pubkey(), &late, &request);
    assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::RequestWindow);
}

#[test]
fn the_request_account_must_be_the_one_derived_from_the_seed() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(2, 1);
    let keeper = env.keeper.insecure_clone();
    let wrong = common::pda(
        &[fade_math::orao_layout::REQUEST_SEED, &[7u8; 32]],
        &orao_id(),
    );
    let ix = env.request_randomness_ix(&keeper.pubkey(), &ticket, &wrong);
    assert_fails_with(
        env.send(&[ix], &[&keeper]),
        FadeError::WrongRandomnessAccount,
    );
}

/// A stranger computes the ticket's public seed and creates its ORAO request
/// first, with `request_v2` or with the deprecated `request` (`legacy`).
fn pre_create(env: &mut Env, ticket: &Address, legacy: bool) -> Address {
    let w = env.ticket(ticket);
    let data = env
        .svm
        .get_account(&common::addr(fade::SLOT_HASHES_ID))
        .unwrap()
        .data;
    let e = fade_math::slot_hashes::first_after(&data, w.open_slot).unwrap();
    let seed = fade::instructions::request_randomness::orao_seed(
        &fade::ID,
        &pk(*ticket),
        w.open_slot,
        e.slot,
        &e.hash,
    );
    let request = env.request_address(ticket);
    let stranger = env.user(0);
    let data = if legacy {
        orao_mock::instruction::Request { seed }.data()
    } else {
        orao_mock::instruction::RequestV2 { seed }.data()
    };
    let ix = Instruction {
        program_id: orao_id(),
        accounts: vec![
            AccountMeta::new(stranger.key(), true),
            AccountMeta::new(env.a.network_state, false),
            AccountMeta::new(env.orao_treasury, false),
            AccountMeta::new(request, false),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data,
    };
    let kp = stranger.kp.insecure_clone();
    env.send(&[ix], &[&kp]).unwrap();
    request
}

#[test]
fn a_request_pre_created_by_someone_else_is_accepted_and_the_prefund_refunded() {
    let (mut env, player) = setup();
    let player_before = env.lamports(&player.key());
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(2, 1);
    // A stranger computes the public seed and creates the request first.
    let request = pre_create(&mut env, &ticket, false);

    let keeper = env.keeper.insecure_clone();
    let ix = env.request_randomness_ix(&keeper.pubkey(), &ticket, &request);
    env.send(&[ix], &[&keeper]).unwrap();
    let vrf_payer = env.vrf_payer(&ticket);
    let request_rent = env.svm.minimum_balance_for_rent_exemption(749);
    assert_eq!(
        env.lamports(&vrf_payer),
        2 * ORAO_FEE + request_rent,
        "Fade did not pay ORAO"
    );
    let r = env.randomness_for(&ticket, 1);
    env.fulfill(&request, r);
    env.settle(&ticket).unwrap();
    // The whole prefund came back: the player lost only the fee and the crank fee
    // (and its integrator record's rent, created by this first ticket).
    assert_eq!(
        player_before - env.lamports(&player.key()),
        5_000 + 250_000 + integrator_rent(&env)
    );
}

/// ORAO's deprecated `request` still creates a legacy account at the request
/// address (checked against the mainnet binary on 22 September 2026). Squatting
/// the address with it must neither block the ticket nor force its forfeiture.
#[test]
fn a_legacy_request_at_the_address_is_accepted_and_settles() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(2, 1);
    let request = pre_create(&mut env, &ticket, true);
    let keeper = env.keeper.insecure_clone();
    let ix = env.request_randomness_ix(&keeper.pubkey(), &ticket, &request);
    env.send(&[ix], &[&keeper]).unwrap();
    assert_fails_with(env.settle(&ticket), FadeError::NotFulfilled);
    let r = env.randomness_for(&ticket, 0);
    env.fulfill(&request, r);
    let before = env.balance(&player.usdc);
    env.settle(&ticket).unwrap();
    assert_eq!(
        env.balance(&player.usdc) - before,
        49 * USDC,
        "the win is paid"
    );
}

#[test]
fn a_legacy_request_left_unanswered_expires_like_any_other() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(2, 1);
    let request = pre_create(&mut env, &ticket, true);
    let keeper = env.keeper.insecure_clone();
    let ix = env.request_randomness_ix(&keeper.pubkey(), &ticket, &request);
    env.send(&[ix], &[&keeper]).unwrap();
    env.advance(151, 60);
    env.expire(&ticket).unwrap();
    assert!(!env.exists(&ticket));
}

#[test]
fn lamports_sent_to_the_request_address_cannot_block_the_request() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(2, 1);
    let request = env.request_address(&ticket);
    // A griefer funds the address before anyone requests: a rent-exempt
    // system account, about a thousandth of a SOL.
    let griefer = env.user(0);
    let mut data = 2u32.to_le_bytes().to_vec(); // SystemInstruction::Transfer
    data.extend_from_slice(&1_000_000u64.to_le_bytes());
    let ix = Instruction {
        program_id: system_id(),
        accounts: vec![
            AccountMeta::new(griefer.key(), true),
            AccountMeta::new(request, false),
        ],
        data,
    };
    let kp = griefer.kp.insecure_clone();
    env.send(&[ix], &[&kp]).unwrap();
    let keeper = env.keeper.insecure_clone();
    let ix = env.request_randomness_ix(&keeper.pubkey(), &ticket, &request);
    env.send(&[ix], &[&keeper]).unwrap();
    let r = env.randomness_for(&ticket, 1);
    env.fulfill(&request, r);
    env.settle(&ticket).unwrap();
    assert!(!env.exists(&ticket));
}

#[test]
fn a_rise_of_orao_fee_before_the_request_is_absorbed_by_the_prefund() {
    let (mut env, player) = setup();
    let player_before = env.lamports(&player.key());
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    // ORAO doubles its fee after the ticket opened.
    let mut state = env.svm.get_account(&env.a.network_state).unwrap();
    state.data[72..80].copy_from_slice(&(2 * ORAO_FEE).to_le_bytes());
    env.svm.set_account(env.a.network_state, state).unwrap();
    env.play_out(&ticket, 1);
    assert!(!env.exists(&ticket));
    // The player paid the new fee; the unspent prefund came back.
    let locked = env.svm.minimum_balance_for_rent_exemption(137);
    assert_eq!(
        player_before - env.lamports(&player.key()),
        5_000 + 2 * ORAO_FEE + locked + 250_000 + integrator_rent(&env)
    );
}

#[test]
fn settlement_checks_the_binding_and_has_no_deadline() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let request = env.request_randomness(&ticket).unwrap();
    // Pending: nothing to settle, and the ticket is left byte-identical.
    let before = env.svm.get_account(&ticket).unwrap().data;
    assert_fails_with(env.settle(&ticket), FadeError::NotFulfilled);
    assert_eq!(env.svm.get_account(&ticket).unwrap().data, before);
    // Expiry is refused before T_SETTLE…
    assert_fails_with(env.expire(&ticket), FadeError::NotExpired);
    let r = env.randomness_for(&ticket, 0);
    env.fulfill(&request, r);
    // …and after it, once fulfilled: settlement is the only way out, however late.
    env.advance(1_000, 400);
    assert_fails_with(env.expire(&ticket), FadeError::AlreadyFulfilled);
    let paid_before = env.balance(&player.usdc);
    env.settle(&ticket).unwrap();
    assert_eq!(env.balance(&player.usdc), paid_before + 49 * USDC);
}

#[test]
fn a_ticket_that_never_gets_randomness_is_forfeited_not_refunded() {
    let (mut env, player) = setup();
    let player_usdc = env.balance(&player.usdc);
    let player_sol = env.lamports(&player.key());
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(151, 60);
    let keeper_before = env.lamports(&env.keeper.pubkey());
    env.expire(&ticket).unwrap();
    assert!(!env.exists(&ticket));
    // The ticket price stays in the vault; no USDC comes back.
    assert_eq!(env.balance(&player.usdc), player_usdc - 25 * USDC);
    let vault = env.vault();
    assert_eq!(vault.total_assets, 5_000 * USDC + 25 * USDC - 50_000);
    assert_eq!(
        (vault.total_reserved_liability, vault.open_vault_credits),
        (0, 0)
    );
    // The expirer gets the settler's share; the unspent prefund and the
    // requester's share go back to the payer.
    assert_eq!(
        env.lamports(&env.keeper.pubkey()),
        keeper_before - 5_000 + 200_000
    );
    assert_eq!(
        player_sol - env.lamports(&player.key()),
        5_000 + 200_000 + integrator_rent(&env)
    );

    // With a request that stays pending, expiry works the same way.
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.request_randomness(&ticket).unwrap();
    env.advance(151, 60);
    env.expire(&ticket).unwrap();
    assert!(!env.exists(&ticket));
}

#[test]
fn a_frozen_beneficiary_parks_the_payout_until_it_can_receive_it() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let request = env.request_randomness(&ticket).unwrap();
    let r = env.randomness_for(&ticket, 0);
    env.fulfill(&request, r);
    env.set_token_state(&player.usdc, 2); // frozen by the mint's authority
    let before = env.balance(&player.usdc);
    env.settle(&ticket).unwrap();
    let w = env.ticket(&ticket);
    assert_eq!(w.status, TicketStatus::PayoutPending);
    assert_eq!(w.payout, 49 * USDC);
    assert_eq!(env.balance(&env.a.payout_escrow), 49 * USDC);
    // Settlement booked the outcome and released everything: a strike is not blocked.
    let vault = env.vault();
    assert_eq!(vault.total_reserved_liability, 0);
    assert_eq!(vault.open_before_close + vault.open_after_close, 0);
    // A second settlement is impossible.
    assert!(env.settle(&ticket).is_err());
    // While frozen the claim fails and can be retried.
    assert!(env.claim_payout(&ticket).is_err());
    env.set_token_state(&player.usdc, 1);
    env.claim_payout(&ticket).unwrap();
    assert_eq!(env.balance(&player.usdc), before + 49 * USDC);
    assert_eq!(env.balance(&env.a.payout_escrow), 0);
    assert!(!env.exists(&ticket));
}

#[test]
fn admission_refuses_before_any_token_moves() {
    let (mut env, player) = setup();
    let before = env.balance(&player.usdc);
    let moonshot = vec![
        Outcome {
            p: 98_000_000,
            m: 100_000,
        },
        Outcome {
            p: 902_000_000,
            m: 0,
        },
    ];
    // 10× at 25 USDC on a 5 000 vault: liability 225 against a 70 USDC cap.
    assert_fails_with(
        env.open_direct(&player, 25 * USDC, &moonshot, 0),
        FadeError::PerTicketCap,
    );
    assert_fails_with(
        env.open_direct(&player, 7 * USDC, &coin_flip(), 0),
        FadeError::PriceBounds,
    );
    // 200 bps of margin cannot carry a 100 bps app share on top of the floors.
    assert_fails_with(
        env.open_direct(&player, 25 * USDC, &coin_flip(), 100),
        FadeError::MarginFloor,
    );
    assert_fails_with(
        env.open_direct(&player, 25 * USDC, &coin_flip(), 501),
        FadeError::AppShareTooHigh,
    );
    let generous = vec![
        Outcome {
            p: 500_000_000,
            m: 20_100,
        },
        Outcome {
            p: 500_000_000,
            m: 0,
        },
    ];
    assert_fails_with(
        env.open_direct(&player, 25 * USDC, &generous, 0),
        FadeError::PayoutTableOverpays,
    );
    let broken = vec![
        Outcome {
            p: 500_000_000,
            m: 19_000,
        },
        Outcome {
            p: 499_999_999,
            m: 0,
        },
    ];
    assert_fails_with(
        env.open_direct(&player, 25 * USDC, &broken, 0),
        FadeError::ProbabilitySum,
    );
    let zero = vec![
        Outcome {
            p: 1_000_000_000,
            m: 9_000,
        },
        Outcome { p: 0, m: 0 },
    ];
    assert_fails_with(
        env.open_direct(&player, 25 * USDC, &zero, 0),
        FadeError::ProbabilityRange,
    );
    assert_fails_with(
        env.open_direct(&player, 25 * USDC, &[], 0),
        FadeError::OutcomeCount,
    );
    assert_eq!(env.balance(&player.usdc), before, "nothing moved");
    assert_eq!(env.next_nonce(&player.key()), 0);
}

#[test]
fn the_ticket_nonce_is_the_integrators_next_one() {
    let (mut env, player) = setup();
    let mut args = OpenArgs::direct(&env, &player, 25 * USDC, &coin_flip(), 0);
    args.nonce = 1;
    let ix = env.open_ticket_ix(&args);
    let kp = player.kp.insecure_clone();
    assert_fails_with(env.send(&[ix], &[&kp]), FadeError::WrongNonce);
    env.open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    assert_eq!(env.next_nonce(&player.key()), 2);
}

#[test]
fn extra_accounts_are_refused() {
    let (mut env, player) = setup();
    let args = OpenArgs::direct(&env, &player, 25 * USDC, &coin_flip(), 0);
    let mut ix = env.open_ticket_ix(&args);
    ix.accounts
        .push(AccountMeta::new_readonly(Address::new_unique(), false));
    let kp = player.kp.insecure_clone();
    assert_fails_with(env.send(&[ix], &[&kp]), FadeError::RemainingAccounts);
}

#[test]
fn the_utilisation_breaker_and_the_integrator_ceiling_bound_the_vault() {
    let mut env = Env::new();
    env.found(100_000 * USDC);
    // One integrator: its open liability stops at 20 % of the assets. A 250 USDC
    // coin flip reserves 240.50 against a Kelly cap that stays above it until
    // the vault is 70 % committed, so the ceiling and the breaker bind first.
    let player = env.user(1_000_000 * USDC);
    let mut opened = 0;
    let err = loop {
        match env.open_direct(&player, 250 * USDC, &coin_flip(), 0) {
            Ok(_) => opened += 1,
            Err(e) => break e,
        }
        assert!(opened < 300);
    };
    assert!(
        err.has_code(fade_error(FadeError::IntegratorCap)),
        "{err:?}"
    );
    let integrator: fade::state::Integrator = env.read(&env.integrator_address(&player.key()));
    let assets = env.vault().total_assets;
    assert!(integrator.reserved_liability <= assets / 5);
    assert!(integrator.reserved_liability + 240_500_000 > assets / 5);
    // More integrators fill the vault up to the 70 % utilisation breaker.
    let mut err = None;
    for _ in 0..10 {
        let other = env.user(1_000_000 * USDC);
        loop {
            match env.open_direct(&other, 250 * USDC, &coin_flip(), 0) {
                Ok(_) => {}
                Err(e) => {
                    if !e.has_code(fade_error(FadeError::IntegratorCap)) {
                        err = Some(e);
                    }
                    break;
                }
            }
        }
        if err.is_some() {
            break;
        }
    }
    let err = err.expect("the vault filled up");
    let vault = env.vault();
    let committed = vault.total_reserved_liability + vault.open_vault_credits;
    assert!(
        err.has_code(fade_error(FadeError::UtilisationBreaker)),
        "{err:?}"
    );
    assert!(
        committed * 10 <= vault.total_assets * 7,
        "utilisation stays under 70 %"
    );
    // One more coin flip's commitment would have crossed it.
    assert!((committed + 490_000_000) * 10 > (vault.total_assets + 249_500_000) * 7);
}

#[test]
fn a_32_outcome_payout_table_fits_a_transaction_and_the_compute_budget() {
    let (mut env, player) = setup();
    // 31 small wins and one loss outcome, at the vault margin floor plus the protocol share.
    let mut table: Vec<Outcome> = (0..31)
        .map(|_| Outcome {
            p: 1_000_000,
            m: 10_000,
        })
        .collect();
    table.push(Outcome {
        p: 969_000_000,
        m: 10_000,
    });
    // RTP = 1 × everything: shave the margin off the large outcome.
    table[31].m = 9_870;
    let args = OpenArgs::direct(&env, &player, 25 * USDC, &table, 0);
    let ix = env.open_ticket_ix(&args);
    let kp = player.kp.insecure_clone();
    let tx = solana_transaction::Transaction::new_signed_with_payer(
        std::slice::from_ref(&ix),
        Some(&kp.pubkey()),
        &[&kp],
        env.svm.latest_blockhash(),
    );
    let size = 1 + 64 * tx.signatures.len() + tx.message.serialize().len();
    eprintln!("open_ticket, 32 outcomes, one signer, legacy message: {size} bytes");
    let meta = env.send(&[ix], &[&kp]).expect("open");
    eprintln!("open_ticket: {} compute units", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed < 200_000);
    let ticket = env.ticket_address(&player.key(), 0);
    let request = env.request_randomness(&ticket).unwrap();
    let r = env.randomness_for(&ticket, 31);
    env.fulfill(&request, r);
    let meta = env.settle(&ticket).unwrap();
    eprintln!(
        "settle_ticket, 32 outcomes: {} compute units",
        meta.compute_units_consumed
    );
    assert!(meta.compute_units_consumed < 200_000);
    assert!(
        size <= 1_232,
        "a 32-outcome open_ticket must fit a legacy transaction: {size} bytes"
    );
}

#[test]
fn a_fall_of_15_percent_stops_new_tickets_and_halves_caps_afterwards() {
    let (mut env, _) = setup();
    let player = env.user(100_000 * USDC);
    let start = env.vault().total_assets;
    // The vault loses coin flips until the share price is 15 % down.
    let mut rounds = 0;
    loop {
        let ticket = match env.open_direct(&player, 25 * USDC, &coin_flip(), 0) {
            Ok(w) => w,
            Err(e) => {
                assert!(e.has_code(fade_error(FadeError::DrawdownBreaker)), "{e:?}");
                break;
            }
        };
        env.play_out(&ticket, 0);
        rounds += 1;
        assert!(rounds < 200, "the breaker never tripped");
    }
    // Measured on settled assets: the fall of the price is the vault's net result.
    let vault = env.vault();
    assert!(vault.total_assets * 100 <= start * 85);
    assert!(
        (vault.total_assets + 25 * USDC) * 100 > start * 85,
        "tripped at the first ticket past 15 %"
    );
    assert!(vault.drawdown_trip_ts != 0);
    // A day later the peak has left the window: tickets resume, at half the cap…
    // (a coin flip's 24.05 of liability no longer fits it; a 1.225× game does).
    let low = vec![
        Outcome {
            p: 800_000_000,
            m: 12_250,
        },
        Outcome {
            p: 200_000_000,
            m: 0,
        },
    ];
    env.advance(250_000, 24 * 3_600 + 1);
    assert_fails_with(
        env.open_direct(&player, 25 * USDC, &coin_flip(), 0),
        FadeError::PerTicketCap,
    );
    let ticket = env.open_direct(&player, 25 * USDC, &low, 0).unwrap();
    let w = env.ticket(&ticket);
    let vault_before = fade_math::risk::Vault {
        assets: env.vault().total_assets - w.vault_credit,
        reserved: 0,
        open_credits: 0,
    };
    let full = fade_math::risk::per_ticket_cap(
        &vault_before,
        w.vault_margin_bps,
        &fade::RiskParams::SPEC.to_math(),
        false,
    )
    .unwrap();
    assert_eq!(w.cap, full / 2);
    env.play_out(&ticket, 1);
    // …for one more clean day, after which the cap is whole again.
    env.advance(250_000, 24 * 3_600);
    let ticket = env.open_direct(&player, 25 * USDC, &low, 0).unwrap();
    let w = env.ticket(&ticket);
    let vault_before = fade_math::risk::Vault {
        assets: env.vault().total_assets - w.vault_credit,
        reserved: 0,
        open_credits: 0,
    };
    let full = fade_math::risk::per_ticket_cap(
        &vault_before,
        w.vault_margin_bps,
        &fade::RiskParams::SPEC.to_math(),
        false,
    )
    .unwrap();
    assert_eq!(w.cap, full);
}

#[test]
fn a_payer_settles_its_own_ticket() {
    // An integrator cranking its own tickets is both the caller and the payer:
    // the settler's share and the prefund refund land on the same account.
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let request = env.request_randomness(&ticket).expect("request");
    let r = env.randomness_for(&ticket, 1);
    env.fulfill(&request, r);
    let ix = env.settle_ix(&player.key(), &ticket);
    let kp = player.kp.insecure_clone();
    env.send(&[ix], &[&kp]).expect("settled by its own payer");
    assert!(!env.exists(&ticket));
}

#[test]
fn a_payer_expires_its_own_ticket() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(151, 60);
    let ix = env.expire_ix(&player.key(), &ticket, &system_id());
    let kp = player.kp.insecure_clone();
    env.send(&[ix], &[&kp]).expect("expired by its own payer");
    assert!(!env.exists(&ticket));
}
