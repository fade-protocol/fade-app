//! The direct path's expiry follows `expire_round`'s rules (audit of
//! 22 October 2026, F-2 and F-3): a request at a ticket's seed that ORAO
//! fulfilled with a non-zero value is never forfeited, bound or not; an Open
//! ticket is expired only once its seed is recorded, naming the request
//! address derived from it; one whose seed was never recorded and whose `s*`
//! SlotHashes no longer proves is refunded; every expiry a withheld draw may
//! explain counts in `Vault.ticket_forfeits_withheld`.
//!
//! On the code before the fix an Open ticket forfeited whatever its request
//! held, a late `request_randomness` was refused, and neither
//! `record_ticket_entropy`, `refund_expired_ticket`, the counter nor
//! `TicketExpired` version 2 existed: every test here fails there.

mod common;
use anchor_lang::InstructionData;
use common::*;
use fade::errors::FadeError;
use fade::events::{TicketEntropyRecorded, TicketExpired};
use fade::state::TicketStatus;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_signer::Signer;

const WIN: usize = 0; // coin_flip: outcome 0 pays 1.96x
const LOSS: usize = 1;

fn setup() -> (Env, User) {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let player = env.user(1_000 * USDC);
    (env, player)
}

/// A stranger creates ORAO's request at the ticket's seed, as anyone can once
/// the seed is public (from `open_slot + 2`).
fn pre_create(env: &mut Env, ticket: &Address) -> Address {
    let w = env.ticket(ticket);
    let seed = if w.entropy_recorded() {
        w.seed
    } else {
        let data = env
            .svm
            .get_account(&addr(fade::SLOT_HASHES_ID))
            .unwrap()
            .data;
        let e = fade_math::slot_hashes::first_after(&data, w.open_slot).unwrap();
        fade::instructions::request_randomness::orao_seed(
            &fade::ID,
            &pk(*ticket),
            w.open_slot,
            e.slot,
            &e.hash,
        )
    };
    let request = env.ticket_request_address(ticket).unwrap();
    let stranger = env.user(0);
    let ix = Instruction {
        program_id: orao_id(),
        accounts: vec![
            AccountMeta::new(stranger.key(), true),
            AccountMeta::new(env.a.network_state, false),
            AccountMeta::new(env.orao_treasury, false),
            AccountMeta::new(request, false),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data: orao_mock::instruction::RequestV2 { seed }.data(),
    };
    let kp = stranger.kp.insecure_clone();
    env.send(&[ix], &[&kp]).unwrap();
    request
}

/// A randomness that gives `ticket`, whose seed is `seed`, outcome `want`.
fn randomness_with_seed(env: &Env, ticket: &Address, seed: &[u8; 32], want: usize) -> [u8; 64] {
    let w = env.ticket(ticket);
    let outcomes = w.outcomes();
    let summary = fade_math::payout_table::validate(&outcomes).unwrap();
    (0u64..)
        .map(|i| {
            let mut r = [0u8; 64];
            r[..8].copy_from_slice(&i.to_le_bytes());
            r[63] = 1;
            r
        })
        .find(|r| {
            let draw = fade_math::select::draw(
                |k| fade::instructions::settle::outcome_hash(&fade::ID, &pk(*ticket), seed, r, k),
                fade::OUTCOME_ROUNDS,
            )
            .unwrap();
            fade_math::select::outcome(draw, &summary.cum, summary.len) == Some(want)
        })
        .unwrap()
}

fn the_seed(env: &Env, ticket: &Address) -> [u8; 32] {
    let w = env.ticket(ticket);
    if w.entropy_recorded() {
        return w.seed;
    }
    let data = env
        .svm
        .get_account(&addr(fade::SLOT_HASHES_ID))
        .unwrap()
        .data;
    let e = fade_math::slot_hashes::first_after(&data, w.open_slot).unwrap();
    fade::instructions::request_randomness::orao_seed(
        &fade::ID,
        &pk(*ticket),
        w.open_slot,
        e.slot,
        &e.hash,
    )
}

fn expired(meta: &litesvm::types::TransactionMetadata) -> TicketExpired {
    let e = events::<TicketExpired>(meta);
    assert_eq!(e.len(), 1);
    let e = e.into_iter().next().unwrap();
    assert_eq!(e.version, fade::TICKET_EXPIRED_VERSION);
    e
}

/// The audit's proof of concept, inverted: a stranger creates the request at
/// the seed, ORAO fulfils it with a win, and the stranger withholds the bind.
/// The expiry is refused, the request is bound after the window, and the
/// winner is paid.
#[test]
fn a_fulfilled_request_nobody_bound_is_never_forfeited_and_is_bound_late() {
    let (mut env, player) = setup();
    let player_usdc = env.balance(&player.usdc);
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(2, 1);
    let seed = the_seed(&env, &ticket);
    let request = pre_create(&mut env, &ticket);
    let r = randomness_with_seed(&env, &ticket, &seed, WIN);
    env.fulfill(&request, r);

    env.advance(151, 60);
    let keeper = env.keeper.insecure_clone();
    // Recording and expiring in one transaction, as the keeper does: refused.
    let record = env.record_ticket_entropy_ix(&ticket);
    let expire = env.expire_ix(&keeper.pubkey(), &ticket, &request);
    assert_fails_with(
        env.send(&[record, expire], &[&keeper]),
        FadeError::AlreadyFulfilled,
    );
    // Bound after the window, by anyone, then settled.
    let pkp = player.kp.insecure_clone();
    let ix = env.request_randomness_ix(&player.key(), &ticket, &request);
    env.send(&[ix], &[&pkp]).expect("late bind");
    let w = env.ticket(&ticket);
    assert_eq!(w.status, TicketStatus::Requested);
    assert_eq!(addr(w.randomness), request);
    env.settle(&ticket).unwrap();
    assert_eq!(
        env.balance(&player.usdc),
        player_usdc - 25 * USDC + 49 * USDC
    );
    assert_eq!(env.vault().ticket_forfeits_withheld, 0);
}

/// A seed recorded at `open_slot + 2` keeps the request findable once
/// SlotHashes has forgotten `s*`: the expiry is still refused, and the late
/// bind and the settlement still work.
#[test]
fn a_recorded_seed_outlives_slot_hashes() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(2, 1);
    let meta = env.record_ticket_entropy(&ticket).unwrap();
    let seed = the_seed(&env, &ticket);
    let e = &events::<TicketEntropyRecorded>(&meta)[0];
    assert_eq!(e.seed, seed);
    let w = env.ticket(&ticket);
    assert_eq!(
        (w.status, w.seed, w.entropy_slot),
        (TicketStatus::Open, seed, e.entropy_slot)
    );
    let request = pre_create(&mut env, &ticket);
    let r = randomness_with_seed(&env, &ticket, &seed, WIN);
    env.fulfill(&request, r);

    env.forget_slot_hashes();
    assert_fails_with(env.expire(&ticket), FadeError::AlreadyFulfilled);
    assert_fails_with(env.refund_expired(&ticket), FadeError::EntropyStillProven);
    let keeper = env.keeper.insecure_clone();
    let bind = env.request_randomness_ix(&keeper.pubkey(), &ticket, &request);
    let settle = {
        // Built as the bound ticket will read: the late bind and its
        // settlement share one transaction.
        let mut ix = env.settle_ix(&keeper.pubkey(), &ticket);
        ix.accounts[6] = AccountMeta::new_readonly(request, false);
        ix
    };
    env.send(&[bind, settle], &[&keeper])
        .expect("bind and settle");
    assert!(!env.exists(&ticket));
}

#[test]
fn record_ticket_entropy_is_idempotent_and_open_tickets_only() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    // s* does not exist yet.
    assert_fails_with(
        env.record_ticket_entropy(&ticket),
        FadeError::EntropyUnavailable,
    );
    env.advance(2, 1);
    env.record_ticket_entropy(&ticket).unwrap();
    let before = env.svm.get_account(&ticket).unwrap().data;
    let meta = env.record_ticket_entropy(&ticket).unwrap();
    assert!(events::<TicketEntropyRecorded>(&meta).is_empty());
    assert_eq!(env.svm.get_account(&ticket).unwrap().data, before);
    // The request binds the recorded seed.
    let request = env.request_randomness(&ticket).unwrap();
    assert_eq!(Some(request), {
        let w = env.ticket(&ticket);
        Some(pda(
            &[fade_math::orao_layout::REQUEST_SEED, &w.seed],
            &orao_id(),
        ))
    });
    assert_fails_with(
        env.record_ticket_entropy(&ticket),
        FadeError::WrongTicketStatus,
    );
}

#[test]
fn an_open_ticket_needs_its_recorded_seed_and_the_derived_address() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(151, 60);
    let keeper = env.keeper.insecure_clone();
    let derived = env.ticket_request_address(&ticket).unwrap();
    // Unrecorded: refused, even naming the right address.
    let ix = env.expire_ix(&keeper.pubkey(), &ticket, &derived);
    assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::EntropyUnrecorded);
    // Recorded, but another account named: refused.
    env.record_ticket_entropy(&ticket).unwrap();
    for wrong in [system_id(), Address::new_unique()] {
        let ix = env.expire_ix(&keeper.pubkey(), &ticket, &wrong);
        assert_fails_with(
            env.send(&[ix], &[&keeper]),
            FadeError::WrongRandomnessAccount,
        );
    }
    // No request there: the keepers' failure, forfeited and not counted.
    let meta = env.expire(&ticket).unwrap();
    let e = expired(&meta);
    assert_eq!(
        (
            e.requested,
            e.request_found,
            e.checked,
            e.pending,
            e.refunded
        ),
        (false, false, true, false, false)
    );
    assert_eq!((e.forfeited, e.refund), (25 * USDC - 50_000, 0));
    assert_eq!(e.ticket_forfeits_withheld, 0);
    assert_eq!(env.vault().ticket_forfeits_withheld, 0);
}

/// A request someone created and nobody bound, still pending: it does not
/// stop the forfeiture, which reports it and counts it; after the window it
/// is not bound late either.
#[test]
fn a_pending_request_nobody_bound_is_reported_and_counted() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(2, 1);
    let request = pre_create(&mut env, &ticket);
    env.advance(151, 60);
    let keeper = env.keeper.insecure_clone();
    let ix = env.request_randomness_ix(&keeper.pubkey(), &ticket, &request);
    assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::RequestWindow);
    let meta = env.expire(&ticket).unwrap();
    let e = expired(&meta);
    assert_eq!(
        (e.requested, e.request_found, e.checked, e.pending),
        (false, true, true, false)
    );
    assert_eq!(e.ticket_forfeits_withheld, 1);
    assert_eq!(env.vault().ticket_forfeits_withheld, 1);
}

/// A late bind needs a request someone created: nothing new is funded after
/// the window.
#[test]
fn nothing_is_requested_after_the_window() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(2, 1);
    env.record_ticket_entropy(&ticket).unwrap();
    env.advance(151, 60);
    let request = env.ticket_request_address(&ticket).unwrap();
    let keeper = env.keeper.insecure_clone();
    let ix = env.request_randomness_ix(&keeper.pubkey(), &ticket, &request);
    assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::RequestWindow);
}

/// Never recorded, and SlotHashes no longer proves `s*`: the ticket can be
/// neither bound nor expired, and is refunded its vault credit. The books
/// close as for a settlement paying the credit, with no result: the settled
/// assets and the drawdown ring do not move.
#[test]
fn a_ticket_whose_entropy_is_lost_is_refunded_its_credit() {
    let (mut env, player) = setup();
    let player_usdc = env.balance(&player.usdc);
    let player_sol = env.lamports(&player.key());
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let credit = env.ticket(&ticket).vault_credit;
    let open = env.vault();
    env.advance(151, 60);
    // While SlotHashes proves s*, the refund is refused: record and expire.
    assert_fails_with(env.refund_expired(&ticket), FadeError::EntropyStillProven);
    env.forget_slot_hashes();
    assert_eq!(env.ticket_request_address(&ticket), None);
    assert_fails_with(env.expire(&ticket), FadeError::EntropyUnrecorded);
    assert_fails_with(
        env.record_ticket_entropy(&ticket),
        FadeError::EntropyUnrecorded,
    );
    let keeper = env.keeper.insecure_clone();
    let keeper_before = env.lamports(&keeper.pubkey());
    let meta = env.refund_expired(&ticket).unwrap();
    assert!(!env.exists(&ticket));
    let e = expired(&meta);
    assert_eq!(
        (
            e.requested,
            e.request_found,
            e.checked,
            e.pending,
            e.refunded,
            e.parked
        ),
        (false, false, false, false, true, false)
    );
    assert_eq!(
        (e.forfeited, e.refund, e.ticket_forfeits_withheld),
        (0, credit, 1)
    );

    // Only the credit comes back: the protocol share left at open.
    assert_eq!(env.balance(&player.usdc), player_usdc - 25 * USDC + credit);
    let v = env.vault();
    assert_eq!(v.total_assets, open.total_assets - credit);
    assert_eq!(v.settled_assets(), open.settled_assets());
    assert_eq!((v.total_reserved_liability, v.open_vault_credits), (0, 0));
    assert_eq!(
        (v.open_before_close, v.open_after_close),
        (0, 0),
        "the ticket left its epoch counter"
    );
    assert_eq!((v.after_close_gain, v.after_close_loss), (0, 0));
    assert_eq!(
        v.price_maxima, open.price_maxima,
        "the ring is not observed"
    );
    assert_eq!(v.price_head_hour, open.price_head_hour);
    assert_eq!(v.ticket_forfeits_withheld, 1);
    assert_eq!(env.balance(&env.a.vault_usdc), v.total_assets);
    let i = env.integrator(&player.key());
    assert_eq!((i.reserved_liability, i.open_tickets), (0, 0));
    // The settler's share to the caller; the prefund, the requester's share
    // and the rent back to the payer.
    assert_eq!(
        env.lamports(&keeper.pubkey()),
        keeper_before - 5_000 + 200_000
    );
    let integrator_rent = env.svm.minimum_balance_for_rent_exemption(
        8 + <fade::state::Integrator as anchor_lang::Space>::INIT_SPACE,
    );
    assert_eq!(
        player_sol - env.lamports(&player.key()),
        5_000 + 200_000 + integrator_rent
    );
}

#[test]
fn a_refund_to_a_frozen_beneficiary_waits_in_escrow() {
    let (mut env, player) = setup();
    let player_usdc = env.balance(&player.usdc);
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let credit = env.ticket(&ticket).vault_credit;
    assert_fails_with(env.refund_expired(&ticket), FadeError::NotExpired);
    env.advance(151, 60);
    env.forget_slot_hashes();
    env.set_token_state(&player.usdc, 2);
    let meta = env.refund_expired(&ticket).unwrap();
    let e = expired(&meta);
    assert_eq!((e.refunded, e.parked, e.refund), (true, true, credit));
    // The parked refund is told from a parked settlement by its outcome, an
    // index no payout table holds.
    let w = env.ticket(&ticket);
    assert_eq!(
        (w.status, w.payout, w.outcome),
        (TicketStatus::PayoutPending, credit, fade::REFUND_OUTCOME)
    );
    assert!(usize::from(fade::REFUND_OUTCOME) >= fade_math::MAX_OUTCOMES);
    assert_eq!(env.balance(&env.a.payout_escrow), credit);
    assert_fails_with(env.refund_expired(&ticket), FadeError::WrongTicketStatus);
    env.set_token_state(&player.usdc, 1);
    env.claim_payout(&ticket).unwrap();
    assert!(!env.exists(&ticket));
    assert_eq!(env.balance(&player.usdc), player_usdc - 25 * USDC + credit);
}

/// The ordering residual (F-3), documented rather than removed: once ORAO's
/// fulfil arrives after the deadline, whoever orders that slot chooses the
/// end. What the fix guarantees is that the expiry ahead of the fulfil
/// counts as one a withheld draw may explain, with its ordinal, and says
/// that ORAO's rent refund is still to come.
#[test]
fn an_expiry_ordered_ahead_of_a_late_fulfil_counts_as_withheld() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let request = env.request_randomness(&ticket).unwrap();
    env.advance(200, 80);
    let r_win = env.randomness_for(&ticket, WIN);
    let r_loss = env.randomness_for(&ticket, LOSS);

    // The fulfil first: the winner is paid.
    let mut honest = env.fork();
    let before = honest.balance(&player.usdc);
    honest.fulfill(&request, r_win);
    assert_fails_with(honest.expire(&ticket), FadeError::AlreadyFulfilled);
    honest.settle(&ticket).unwrap();
    assert_eq!(honest.balance(&player.usdc) - before, 49 * USDC);

    // The expiry first, the fulfil right after in the same slot: forfeited,
    // and counted.
    for r in [r_win, r_loss] {
        let mut ordered = env.fork();
        assert_eq!(ordered.vault().ticket_forfeits_withheld, 0);
        let slot = ordered.slot();
        let meta = ordered.expire(&ticket).unwrap();
        ordered.fulfill(&request, r);
        assert_eq!(ordered.slot(), slot);
        let e = expired(&meta);
        assert_eq!(
            (e.requested, e.request_found, e.checked, e.pending),
            (true, true, true, true)
        );
        assert_eq!(e.ticket_forfeits_withheld, 1);
        assert_eq!(ordered.vault().ticket_forfeits_withheld, 1);
    }
}

/// A request fulfilled with zero leaves a requested ticket forfeitable, and
/// the forfeiture counts; nothing is pending any more.
#[test]
fn a_zero_fulfilment_forfeits_and_counts() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let request = env.request_randomness(&ticket).unwrap();
    env.fulfill(&request, [0u8; 64]);
    env.advance(151, 60);
    let e = expired(&env.expire(&ticket).unwrap());
    assert_eq!(
        (e.requested, e.pending, e.ticket_forfeits_withheld),
        (true, false, 1)
    );
}

/// A request someone created at the seed and the ticket bound in its window,
/// still pending at the expiry: ORAO will refund its rent to that creator,
/// not to `vrf_payer`, so the expiry does not report a refund to come.
#[test]
fn a_bound_request_someone_else_paid_for_is_not_pending_a_refund() {
    let (mut env, player) = setup();
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.advance(3, 2);
    let created = pre_create(&mut env, &ticket);
    let request = env.request_randomness(&ticket).unwrap();
    assert_eq!(request, created);
    env.advance(151, 60);
    let vrf_payer = env.vrf_payer(&ticket);
    let r = env.randomness_for(&ticket, LOSS);
    let e = expired(&env.expire(&ticket).unwrap());
    assert_eq!(
        (
            e.requested,
            e.request_found,
            e.pending,
            e.ticket_forfeits_withheld
        ),
        (true, true, false, 1)
    );
    env.fulfill(&request, r);
    assert_eq!(
        env.lamports(&vrf_payer),
        0,
        "the refund went to its creator"
    );
}
