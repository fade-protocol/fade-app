//! Every exit of a ticket releases it from its epoch counter and, in the same
//! transaction, credits an address stored when it opened: the ticket's payer,
//! a round's rent payer, an epoch record's. Anyone holding such an address's
//! key can turn it into an upgradeable program after the open (empty it,
//! `solana program deploy --program-id`). The runtime does not copy a CPI's
//! lamport change on an executable account back into the caller's view
//! (program-runtime `cpi.rs`: `if callee_account.is_executable() { // Use
//! the known account }`), so an exit that handed such a payer to a system
//! transfer and then credited it directly failed on `UnbalancedInstruction`
//! for good: the ticket stayed counted in `open_before_close`, and every
//! later strike was `StrikeNotClean` (re-audit of 24 October 2026). The exits
//! now drain `vrf_payer` onto the ticket and credit the payer directly, by
//! the close, which reaches an executable account. On the code before the
//! fix the settlements, the unrequested expiry and the refund fail here; a
//! Requested ticket's `vrf_payer` is empty until ORAO answers, so its expiry
//! made no CPI to the payer, and the record's close was always direct.

mod common;
use common::*;
use fade::state::TicketStatus;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

const WIN: usize = 0; // coin_flip: outcome 0 pays 1.96x
const LOSS: usize = 1;

/// A founded vault, a player, and a pending deposit that keeps the epoch live.
fn setup() -> (Env, User) {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let player = env.user(1_000 * USDC);
    let lp = env.user(100 * USDC);
    env.deposit(&lp, 100 * USDC).expect("deposit");
    (env, player)
}

/// Opens a coin flip whose payer is the separate key `k`, counted Before the
/// live epoch's close, then turns `k` into a program.
fn open_then_turn(env: &mut Env, player: &User, k: &Keypair) -> Address {
    env.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    let mut args = OpenArgs::direct(env, player, 25 * USDC, &coin_flip(), 0);
    args.payer = k.pubkey();
    let ix = env.open_ticket_ix(&args);
    let pkp = player.kp.insecure_clone();
    env.send(&[ix], &[&pkp, k]).expect("open");
    let ticket = env.ticket_address(&player.key(), args.nonce);
    assert_eq!(env.ticket(&ticket).payer, pk(k.pubkey()));
    assert_eq!(env.vault().open_before_close, 1);
    env.turn_into_program(&k.pubkey());
    ticket
}

/// What the payer gets back when `ticket` closes now: every lamport on it and
/// on its `vrf_payer`, less the settler's share.
fn owed_at_close(env: &Env, ticket: &Address) -> u64 {
    env.lamports(ticket) + env.lamports(&env.vrf_payer(ticket))
        - env.ticket(ticket).crank_settle_lamports
}

/// The ticket has left its counter and the strike goes through.
fn strike_proceeds(env: &mut Env) {
    assert_eq!(env.vault().open_before_close, 0);
    env.strike().expect("strike proceeds");
}

#[test]
fn a_losing_ticket_of_a_payer_turned_program_settles_and_the_strike_proceeds() {
    let (mut env, player) = setup();
    let k = Keypair::new();
    let ticket = open_then_turn(&mut env, &player, &k);
    env.pass_close();
    let request = env.request_randomness(&ticket).expect("request");
    let r = env.randomness_for(&ticket, LOSS);
    env.fulfill(&request, r);
    let k0 = env.lamports(&k.pubkey());
    let owed = owed_at_close(&env, &ticket);
    env.settle(&ticket).expect("settle_ticket");
    assert!(!env.exists(&ticket));
    assert_eq!(env.lamports(&env.vrf_payer(&ticket)), 0);
    assert_eq!(env.lamports(&k.pubkey()) - k0, owed);
    strike_proceeds(&mut env);
}

#[test]
fn a_parked_win_of_a_payer_turned_program_keeps_the_prefund_until_the_claim() {
    let (mut env, player) = setup();
    let k = Keypair::new();
    let ticket = open_then_turn(&mut env, &player, &k);
    env.pass_close();
    let request = env.request_randomness(&ticket).expect("request");
    let r = env.randomness_for(&ticket, WIN);
    env.fulfill(&request, r);
    env.set_token_state(&player.usdc, 2);
    let k0 = env.lamports(&k.pubkey());
    let owed = owed_at_close(&env, &ticket);
    env.settle(&ticket).expect("settle_ticket");
    // Parked: the payer is credited nothing yet, the prefund waits on the
    // ticket with its rent, and the ticket has left its counter.
    assert_eq!(env.ticket(&ticket).status, TicketStatus::PayoutPending);
    assert_eq!(env.lamports(&k.pubkey()), k0);
    assert_eq!(env.lamports(&env.vrf_payer(&ticket)), 0);
    assert_eq!(env.lamports(&ticket), owed);
    strike_proceeds(&mut env);
    env.set_token_state(&player.usdc, 1);
    env.claim_payout(&ticket).expect("claim_payout");
    assert!(!env.exists(&ticket));
    assert_eq!(env.lamports(&k.pubkey()) - k0, owed);
}

/// A plain payer emptied after the open: the parked settlement credits it
/// nothing, so no credit below an empty account's rent-exempt minimum can
/// fail it; the claim's close credits it the rent with the prefund.
#[test]
fn a_parked_win_of_an_emptied_payer_settles() {
    let (mut env, player) = setup();
    let k = Keypair::new();
    env.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    let mut args = OpenArgs::direct(&env, &player, 25 * USDC, &coin_flip(), 0);
    args.payer = k.pubkey();
    let ix = env.open_ticket_ix(&args);
    let pkp = player.kp.insecure_clone();
    env.send(&[ix], &[&pkp, &k]).expect("open");
    let ticket = env.ticket_address(&player.key(), args.nonce);
    env.svm
        .set_account(k.pubkey(), solana_account::Account::default())
        .unwrap();
    let request = env.request_randomness(&ticket).expect("request");
    let r = env.randomness_for(&ticket, WIN);
    env.fulfill(&request, r);
    env.set_token_state(&player.usdc, 2);
    env.settle(&ticket).expect("settle_ticket");
    assert_eq!(env.lamports(&k.pubkey()), 0);
    env.set_token_state(&player.usdc, 1);
    env.claim_payout(&ticket).expect("claim_payout");
    assert!(env.lamports(&k.pubkey()) > 0);
}

#[test]
fn a_requested_ticket_of_a_payer_turned_program_expires() {
    let (mut env, player) = setup();
    let k = Keypair::new();
    let ticket = open_then_turn(&mut env, &player, &k);
    env.request_randomness(&ticket).expect("request");
    env.pass_close();
    env.advance(200, 80);
    let k0 = env.lamports(&k.pubkey());
    let owed = owed_at_close(&env, &ticket);
    env.expire(&ticket).expect("expire_ticket");
    assert!(!env.exists(&ticket));
    assert_eq!(env.lamports(&k.pubkey()) - k0, owed);
    strike_proceeds(&mut env);
}

#[test]
fn an_unrequested_ticket_of_a_payer_turned_program_expires() {
    let (mut env, player) = setup();
    let k = Keypair::new();
    let ticket = open_then_turn(&mut env, &player, &k);
    env.pass_close();
    env.advance(200, 80);
    let k0 = env.lamports(&k.pubkey());
    let owed = owed_at_close(&env, &ticket);
    // Never requested: the whole prefund is still on `vrf_payer`.
    assert!(env.lamports(&env.vrf_payer(&ticket)) > 0);
    env.expire(&ticket).expect("expire_ticket");
    assert!(!env.exists(&ticket));
    assert_eq!(env.lamports(&env.vrf_payer(&ticket)), 0);
    assert_eq!(env.lamports(&k.pubkey()) - k0, owed);
    strike_proceeds(&mut env);
}

#[test]
fn a_lost_seed_ticket_of_a_payer_turned_program_is_refunded() {
    let (mut env, player) = setup();
    let k = Keypair::new();
    let ticket = open_then_turn(&mut env, &player, &k);
    env.pass_close();
    env.advance(151, 60);
    env.forget_slot_hashes();
    let k0 = env.lamports(&k.pubkey());
    let owed = owed_at_close(&env, &ticket);
    env.refund_expired(&ticket).expect("refund_expired_ticket");
    assert!(!env.exists(&ticket));
    assert_eq!(env.lamports(&k.pubkey()) - k0, owed);
    strike_proceeds(&mut env);
}

/// An epoch record's rent payer, the striker when the fund is dry, turned
/// into a program: the last claim that closes the record still lands.
#[test]
fn a_record_whose_rent_payer_turned_program_closes_at_the_last_claim() {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let lp = env.user(100 * USDC);
    let epoch = env.deposit(&lp, 100 * USDC).expect("deposit");
    // The strike fund dry: the queue holds its rent-exempt minimum only.
    let mut queue = env.svm.get_account(&env.a.queue).unwrap();
    queue.lamports = env.svm.minimum_balance_for_rent_exemption(queue.data.len());
    env.svm.set_account(env.a.queue, queue).unwrap();
    env.pass_close();
    let striker = Keypair::new();
    env.svm.airdrop(&striker.pubkey(), 10_000_000_000).unwrap();
    let ix = env.strike_ix(&striker.pubkey());
    env.send(&[ix], &[&striker]).expect("strike");
    assert_eq!(env.record(epoch).rent_payer, pk(striker.pubkey()));
    env.turn_into_program(&striker.pubkey());
    let s0 = env.lamports(&striker.pubkey());
    let record = env.record_address(epoch);
    let rent = env.lamports(&record);
    env.claim_deposit(&lp.key(), epoch).expect("claim_deposit");
    assert!(!env.exists(&record));
    assert_eq!(env.lamports(&striker.pubkey()) - s0, rent);
}
