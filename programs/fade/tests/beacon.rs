//! The shared beacon (Spec 08 §13), transaction by transaction. So far its
//! state and governance: the beacon parameters set and
//! checked through the parameter queue, `PAUSE_ROUNDS`, and what
//! `initialize` writes for the beacon; and `register_payout_table`
//! (step 3, Spec 08 §13.5.1).

mod common;
use common::*;
use fade::errors::FadeError;
use fade::state::{Config, RiskParams};
use fade::{CONFIG_VERSION, DELAY_24H, MAX_ROUND_K};

type Change = fn(&mut RiskParams);

#[test]
fn initialize_writes_the_beacon_state() {
    let env = Env::new();
    let c = env.config();
    assert_eq!(c.version, CONFIG_VERSION);
    assert_eq!(c.params, RiskParams::SPEC);
    assert_eq!(c.params.beacon_min_price, 500_000);
    assert_eq!(c.params.beacon_threshold, 8_640_000);
    assert_eq!(c.params.round_k, 1);
    assert_eq!(c.params.tick_slots, 37);
    assert_eq!(c.params.refund_slots, 1_715);
    assert_eq!(c.params.crank_round_settle_lamports, 20_000);
    assert_eq!(c.pending.params, RiskParams::SPEC);
    let v = env.vault();
    assert_eq!(v.accepting_round, 0, "no round accepts tickets");
    assert_eq!(v.next_round_id, 1, "round ids start at 1");
    assert_eq!(
        (
            v.beacon_shares_held,
            v.protocol_shares_accrued,
            v.app_shares_owed,
            v.beacon_returns_owed
        ),
        (0, 0, 0, 0)
    );
}

#[test]
fn initialize_refuses_beacon_parameters_out_of_range() {
    let mut env = Env::bare();
    let mut p = RiskParams::SPEC;
    p.round_k = u64::from(MAX_ROUND_K) + 1;
    assert_fails_with(env.initialize(p), FadeError::InvalidParams);
    env.initialize(RiskParams::SPEC).unwrap();
}

#[test]
fn set_params_refuses_beacon_parameters_out_of_range() {
    let mut env = Env::new();
    let spec = RiskParams::SPEC;
    let bad: [(&str, Change); 9] = [
        ("k above MAX_ROUND_K", |p| p.round_k = 2),
        ("k of zero", |p| p.round_k = 0),
        ("no minimum", |p| p.beacon_min_price = 0),
        ("threshold below the minimum", |p| {
            p.beacon_threshold = p.beacon_min_price - 1
        }),
        ("threshold above the maximum price", |p| {
            p.beacon_threshold = p.max_price + 1
        }),
        ("no tick", |p| p.tick_slots = 0),
        ("tick above 150 slots", |p| p.tick_slots = 151),
        ("refund window shorter than a tick", |p| {
            p.refund_slots = p.tick_slots - 1
        }),
        ("settlement share above the direct path's", |p| {
            p.crank_round_settle_lamports = p.crank_settle_lamports + 1
        }),
    ];
    for (why, change) in bad {
        let mut p = spec;
        change(&mut p);
        assert_fails_with(env.set_params(p), FadeError::InvalidParams);
        assert_eq!(env.config().params, spec, "{why}: nothing changed");
        assert!(!env.config().pending.active, "{why}: nothing queued");
    }
}

#[test]
fn a_beacon_tightening_applies_at_once() {
    let mut env = Env::new();
    let mut p = RiskParams::SPEC;
    p.beacon_min_price = 1_000_000;
    p.beacon_threshold = 10_000_000;
    p.tick_slots = 74;
    p.refund_slots = 3_000;
    env.set_params(p).unwrap();
    let c = env.config();
    assert_eq!(c.params, p);
    assert!(!c.pending.active);
}

#[test]
fn a_beacon_loosening_waits_24_hours() {
    let mut env = Env::new();
    let changes: [Change; 6] = [
        |p| p.beacon_min_price -= 1,
        |p| p.beacon_threshold -= 1,
        |p| p.tick_slots -= 1,
        |p| p.refund_slots -= 1,
        |p| p.crank_round_settle_lamports += 1,
        |p| p.crank_round_settle_lamports -= 2,
    ];
    for change in changes {
        let mut p = env.config().params;
        change(&mut p);
        let now = env.now();
        env.set_params(p).unwrap();
        let c = env.config();
        assert!(c.pending.active);
        assert_eq!(c.pending.effective_at, now + DELAY_24H);
        assert_ne!(c.params, p);
        env.advance(10, DELAY_24H - 1);
        assert_fails_with(env.apply_params(), FadeError::ChangeNotDue);
        env.advance(1, 1);
        env.apply_params().unwrap();
        assert_eq!(env.config().params, p);
    }
}

#[test]
fn the_guardian_pauses_rounds_and_only_the_council_resumes_them() {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let guardian = env.guardian.insecure_clone();
    let council = env.council.insecure_clone();
    env.set_pause_flags(&guardian, Config::PAUSE_ROUNDS, None)
        .unwrap();
    assert!(env.config().is_paused(Config::PAUSE_ROUNDS));
    // The beacon's own pause leaves the direct path open.
    let player = env.user(1_000 * USDC);
    env.open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    assert_fails_with(
        env.set_pause_flags(&guardian, 0, None),
        FadeError::GuardianCannotUnpause,
    );
    assert_fails_with(
        env.set_pause_flags(&guardian, Config::PAUSE_TICKETS, None),
        FadeError::GuardianCannotUnpause,
    );
    env.set_pause_flags(&guardian, Config::PAUSE_ALL, None)
        .unwrap();
    assert_eq!(env.config().pause_flags, Config::PAUSE_ALL);
    env.set_pause_flags(&council, Config::PAUSE_ROUNDS, None)
        .unwrap();
    env.set_pause_flags(&council, 0, None).unwrap();
    assert_eq!(env.config().pause_flags, 0);
    // No flag beyond the four exists.
    assert_fails_with(
        env.set_pause_flags(&guardian, 1 << 4, None),
        FadeError::InvalidParams,
    );
}

/// Spec 08 §13.6: an indexer rebuilds every round from the events alone. A
/// requested round that forfeits never emits `RoundDrawn`, so `RoundExpired`
/// carries the draw cost every forfeited return is charged against, the refund
/// that fixed it, and the counter the expiry recorded an unrequested round on.
#[test]
fn a_forfeited_round_is_rebuilt_from_its_events() {
    use anchor_lang::prelude::borsh;
    use anchor_lang::AnchorDeserialize;
    use fade::events::{PayoutTableRegistered, RoundExpired};
    use fade::state::Outcome;

    // From `RoundOpened.request_share` and `RoundDrawRequested.funded`.
    let (request_share, funded) = (20_000u64, 1_680_392u64);
    let refund = 900_000u64;
    let draw_cost = fade_math::beacon::draw_cost(funded, request_share, refund).unwrap();
    let expired = RoundExpired {
        version: 1,
        round: Pk::new_unique(),
        requested: true,
        request_found: true,
        checked: true,
        tickets: 3,
        forfeited: 2_910_000,
        draw_cost,
        refund,
        side: 1,
        generation: 7,
        forfeits_withheld: 4,
        refunded: false,
    };
    let bytes = borsh::to_vec(&expired).unwrap();
    let read = RoundExpired::try_from_slice(&bytes).unwrap();
    assert_eq!(
        fade_math::beacon::draw_cost(funded, request_share, read.refund).unwrap(),
        read.draw_cost,
        "the draw cost follows from the events alone"
    );
    assert_eq!((read.side, read.generation), (1, 7));
    assert_eq!(
        read.forfeits_withheld, 4,
        "its ordinal among withheld forfeitures"
    );
    // The tickets' charges depend on it (Spec 08 §13.4).
    let charge = fade_math::beacon::charge(read.draw_cost, 0, 3_000_000, 1_000_000).unwrap();
    assert_eq!(charge, draw_cost.div_ceil(3));

    // A payout table's outcomes are in its registration, not only their hash.
    let outcomes = vec![
        Outcome {
            p: 500_000_000,
            m: 19_600,
        },
        Outcome {
            p: 500_000_000,
            m: 0,
        },
    ];
    let registered = PayoutTableRegistered {
        version: 1,
        payout_table: Pk::new_unique(),
        hash: [7; 32],
        len: 2,
        lhs: 9_800_000_000_000,
        max_m: 19_600,
        outcomes: outcomes.clone(),
    };
    let read = PayoutTableRegistered::try_from_slice(&borsh::to_vec(&registered).unwrap()).unwrap();
    assert_eq!(read.outcomes, outcomes);
    assert_eq!(usize::from(read.len), read.outcomes.len());
}

// --- register_payout_table (Spec 08 §13.5.1) ---------------------------------------

mod register_payout_table {
    use super::*;
    use anchor_lang::{AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator};
    use fade::events::PayoutTableRegistered;
    use fade::state::{Outcome, PayoutTable};
    use litesvm::types::TransactionMetadata;
    use solana_account::Account;
    use solana_address::Address;
    use solana_keypair::Keypair;
    use solana_signer::Signer;

    const LEN: usize = 579;

    fn o(p: u64, m: u64) -> Outcome {
        Outcome { p, m }
    }

    /// 32 outcomes, a 10 % margin, top multiplier 10 000×.
    fn thirty_two() -> Vec<Outcome> {
        let mut t = vec![o(1, 100_000_000)];
        for _ in 0..30 {
            t.push(o(30_000_000, 10_000));
        }
        t.push(o(1_000_000_000 - 1 - 30 * 30_000_000, 0));
        t
    }

    /// Every `PayoutTableRegistered` emitted through `emit_cpi!` in a transaction.
    fn registered(meta: &TransactionMetadata) -> Vec<PayoutTableRegistered> {
        let mut prefix = anchor_lang::event::EVENT_IX_TAG_LE.to_vec();
        prefix.extend_from_slice(PayoutTableRegistered::DISCRIMINATOR);
        meta.inner_instructions
            .iter()
            .flatten()
            .filter_map(|ix| ix.instruction.data.strip_prefix(prefix.as_slice()))
            .map(|mut data| PayoutTableRegistered::deserialize(&mut data).unwrap())
            .collect()
    }

    fn funded(env: &mut Env) -> Keypair {
        let kp = Keypair::new();
        env.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        kp
    }

    fn rent(env: &Env) -> u64 {
        env.svm.minimum_balance_for_rent_exemption(LEN)
    }

    /// Nothing at `address`, and nothing taken from `payer`, which did not pay the fee.
    #[track_caller]
    fn nothing_moved(env: &Env, address: &Address, payer: &Address, before: u64) {
        assert!(!env.exists(address), "no account created");
        assert_eq!(env.lamports(payer), before, "the payer paid nothing");
    }

    #[test]
    fn a_valid_table_is_stored_at_its_hash() {
        let mut env = Env::new();
        let payer = funded(&mut env);
        let table = coin_flip();
        let address = env.payout_table_address(&table);
        let before = env.lamports(&payer.pubkey());
        let meta = env.register_payout_table(&payer, &table).unwrap();

        let acc = env.svm.get_account(&address).unwrap();
        assert_eq!(acc.owner, fade_id());
        assert_eq!(acc.data.len(), LEN);
        assert_eq!(acc.lamports, rent(&env), "rent-exempt, no more");
        assert_eq!(
            env.lamports(&payer.pubkey()),
            before - rent(&env) - meta.fee,
            "the payer pays the rent, for good"
        );
        let t: PayoutTable = env.read(&address);
        let hash = payout_table_hash(&table);
        let (_, bump) =
            Address::find_program_address(&[fade::PAYOUT_TABLE_SEED, &hash], &fade_id());
        assert_eq!((t.version, t.bump, t.len), (1, bump, 2));
        assert_eq!(t.hash, hash);
        assert_eq!(t.lhs, 500_000_000u128 * 19_600);
        assert_eq!(t.max_m, 19_600);
        assert_eq!(&t.outcomes[..2], table.as_slice());
        assert!(t.outcomes[2..].iter().all(|x| *x == Outcome::default()));
        assert_eq!(
            t.outcomes().iter().map(|x| (x.p, x.m)).collect::<Vec<_>>(),
            vec![(500_000_000, 19_600), (500_000_000, 0)]
        );

        let events = registered(&meta);
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.version, 1);
        assert_eq!(addr(e.payout_table), address);
        assert_eq!((e.hash, e.len, e.lhs, e.max_m), (hash, 2, t.lhs, 19_600));
        assert_eq!(e.outcomes, table, "the outcomes the hash commits to");
        assert_eq!(e.hash, payout_table_hash(&e.outcomes));
    }

    /// A client may prepend the registration to every join: a second one
    /// succeeds, writes nothing, moves nothing and emits nothing, whoever pays.
    #[test]
    fn re_registration_is_idempotent() {
        let mut env = Env::new();
        let first = funded(&mut env);
        let table = slot_classic();
        let address = env.payout_table_address(&table);
        env.register_payout_table(&first, &table).unwrap();
        let stored = env.svm.get_account(&address).unwrap();

        let second = funded(&mut env);
        let before = env.lamports(&second.pubkey());
        let meta = env.register_payout_table(&second, &table).unwrap();
        assert_eq!(env.svm.get_account(&address).unwrap(), stored);
        assert_eq!(env.lamports(&second.pubkey()), before - meta.fee);
        assert!(registered(&meta).is_empty(), "no event on re-registration");

        // Twice in one transaction, and then again with a third payer.
        let ix = env.register_payout_table_ix(&first.pubkey(), &address, &table);
        let meta = env.send(&[ix.clone(), ix], &[&first]).unwrap();
        assert!(registered(&meta).is_empty());
        assert_eq!(env.svm.get_account(&address).unwrap(), stored);

        // A new table registered in the same transaction as its repeat: one
        // creation, one event.
        let other = thirty_two();
        let other_address = env.payout_table_address(&other);
        let ix = env.register_payout_table_ix(&second.pubkey(), &other_address, &other);
        let meta = env.send(&[ix.clone(), ix], &[&second]).unwrap();
        assert_eq!(registered(&meta).len(), 1);
        assert_eq!(env.read::<PayoutTable>(&other_address).len, 32);
    }

    /// The largest table: 32 outcomes, a multiplier at the 10 000× ceiling, in
    /// one transaction without a lookup table. Its compute units are measured.
    #[test]
    fn a_thirty_two_outcome_table_registers_in_one_transaction() {
        let mut env = Env::new();
        let payer = funded(&mut env);
        let table = thirty_two();
        let address = env.payout_table_address(&table);
        let ix = env.register_payout_table_ix(&payer.pubkey(), &address, &table);
        assert_eq!(
            ix.data.len(),
            8 + 4 + 32 * 16,
            "524 bytes of instruction data"
        );
        let tx = solana_transaction::Transaction::new_signed_with_payer(
            std::slice::from_ref(&ix),
            Some(&payer.pubkey()),
            &[&payer],
            env.svm.latest_blockhash(),
        );
        let size = bincode_len(&tx);
        assert!(size <= 1_232, "{size} bytes");
        let meta = env.send(std::slice::from_ref(&ix), &[&payer]).unwrap();
        let t: PayoutTable = env.read(&address);
        assert_eq!((t.len, t.max_m), (32, 100_000_000));
        assert_eq!(&t.outcomes[..], table.as_slice());
        let again = env.send(&[ix], &[&payer]).unwrap();
        eprintln!(
            "CU register_payout_table (32 outcomes): {} creating, {} registered already; {size}-byte transaction",
            meta.compute_units_consumed, again.compute_units_consumed
        );
        eprintln!(
            "rent of a PayoutTable in the test runtime: {} lamports",
            rent(&env)
        );
        let two = funded(&mut env);
        let small = env.register_payout_table(&two, &coin_flip()).unwrap();
        eprintln!(
            "CU register_payout_table (2 outcomes): {} creating",
            small.compute_units_consumed
        );
        assert!(meta.compute_units_consumed < 200_000);
    }

    fn bincode_len(tx: &solana_transaction::Transaction) -> usize {
        // signatures (compact length + 64 each) and the serialised message
        1 + 64 * tx.signatures.len() + tx.message_data().len()
    }

    /// Spec 08 §13.9: an address holding lamports is created over, as
    /// Anchor's `init` does; the payer tops it up to the rent, never more.
    #[test]
    fn a_pre_funded_address_is_created_over() {
        let mut env = Env::new();
        let payer = funded(&mut env);
        let rent = rent(&env);
        for (table, gift) in [
            (coin_flip(), 1u64),
            (slot_classic(), rent - 1),
            (thirty_two(), rent + 5_000_000),
        ] {
            let address = env.payout_table_address(&table);
            // Set directly: the runtime refuses a transfer leaving a new
            // system account below its rent-exempt minimum.
            env.svm
                .set_account(
                    address,
                    Account {
                        lamports: gift,
                        data: vec![],
                        owner: system_id(),
                        executable: false,
                        rent_epoch: 0,
                    },
                )
                .unwrap();
            let before = env.lamports(&payer.pubkey());
            let meta = env.register_payout_table(&payer, &table).unwrap();
            let acc = env.svm.get_account(&address).unwrap();
            assert_eq!(acc.owner, fade_id());
            assert_eq!(acc.lamports, rent.max(gift));
            assert_eq!(
                env.lamports(&payer.pubkey()),
                before - meta.fee - rent.saturating_sub(gift)
            );
            assert_eq!(
                env.read::<PayoutTable>(&address).hash,
                payout_table_hash(&table)
            );
            assert_eq!(registered(&meta).len(), 1);
        }
    }

    /// Registration moves no funds but the payer's rent: no pause stops it.
    #[test]
    fn no_pause_stops_a_registration() {
        let mut env = Env::new();
        let guardian = env.guardian.insecure_clone();
        env.set_pause_flags(&guardian, Config::PAUSE_ALL, None)
            .unwrap();
        let payer = funded(&mut env);
        env.register_payout_table(&payer, &coin_flip()).unwrap();
        env.register_payout_table(&payer, &coin_flip()).unwrap();
    }

    /// Every check of `payout_table::validate` and the overpaying check, in
    /// order, each refusing before anything is created or paid.
    #[test]
    fn every_invalid_table_is_refused() {
        let mut env = Env::new();
        let payer = funded(&mut env);
        let fees = funded(&mut env);
        let p = 1_000_000_000u64;
        let cases: Vec<(&str, Vec<Outcome>, FadeError)> = vec![
            ("no outcome", vec![], FadeError::OutcomeCount),
            (
                "33 outcomes",
                {
                    let mut t = vec![o(p - 32, 0)];
                    t.extend(std::iter::repeat_n(o(1, 0), 32));
                    t
                },
                FadeError::OutcomeCount,
            ),
            (
                "a zero probability",
                vec![o(0, 0), o(p, 9_000)],
                FadeError::ProbabilityRange,
            ),
            (
                "a probability above 1",
                vec![o(p + 1, 0)],
                FadeError::ProbabilityRange,
            ),
            (
                "probabilities summing below 1",
                vec![o(p / 2, 0), o(p / 2 - 1, 19_000)],
                FadeError::ProbabilitySum,
            ),
            (
                "probabilities summing above 1",
                vec![o(p / 2, 0), o(p / 2 + 1, 19_000)],
                FadeError::ProbabilitySum,
            ),
            (
                "probabilities overflowing u64",
                vec![o(p, 0), o(u64::MAX, 0)],
                FadeError::ProbabilityRange,
            ),
            (
                "a multiplier above 10 000x",
                vec![o(1, 100_000_001), o(p - 1, 0)],
                FadeError::MultiplierCeiling,
            ),
            (
                "an expected return above 1",
                vec![o(p / 2, 20_002), o(p / 2, 0)],
                FadeError::PayoutTableOverpays,
            ),
            (
                "an expected return of 1 plus one unit",
                vec![o(p - 1, 10_000), o(1, 10_001)],
                FadeError::PayoutTableOverpays,
            ),
            // Range is checked before the ceiling, the ceiling before the sum.
            (
                "range before ceiling",
                vec![o(0, 100_000_001), o(p, 0)],
                FadeError::ProbabilityRange,
            ),
            (
                "ceiling before sum",
                vec![o(1, 100_000_001)],
                FadeError::MultiplierCeiling,
            ),
        ];
        for (why, table, error) in cases {
            // The address of the table's own hash where one exists, so that
            // only the table's content can be what is refused.
            let address = if (1..=255).contains(&table.len()) {
                env.payout_table_address(&table)
            } else {
                Address::new_unique()
            };
            let before = env.lamports(&payer.pubkey());
            let ix = env.register_payout_table_ix(&payer.pubkey(), &address, &table);
            let result = env.send(&[ix], &[&fees, &payer]);
            assert!(result.is_err(), "{why}: refused");
            assert_fails_with(result, error);
            nothing_moved(&env, &address, &payer.pubkey(), before);
        }
    }

    /// An expected return of exactly 1 does not overpay: it is stored, and
    /// every join refuses it for its margin (Spec 08 §13.5.2 step 4).
    #[test]
    fn a_table_returning_exactly_its_price_is_stored() {
        let mut env = Env::new();
        let payer = funded(&mut env);
        let table = vec![o(500_000_000, 20_000), o(500_000_000, 0)];
        env.register_payout_table(&payer, &table).unwrap();
        let t: PayoutTable = env.read(&env.payout_table_address(&table));
        assert_eq!(t.lhs, 10_000u128 * 1_000_000_000);
    }

    /// The address is derived from the hash of the argument, never from
    /// anything the caller says: any other account is refused, the address of
    /// another table and of the same outcomes in another order included.
    #[test]
    fn the_address_is_the_hash_of_the_argument() {
        let mut env = Env::new();
        let payer = funded(&mut env);
        let fees = funded(&mut env);
        let table = coin_flip();
        let mut reversed = table.clone();
        reversed.reverse();
        env.register_payout_table(&payer, &slot_classic()).unwrap();
        let registered_other = env.payout_table_address(&slot_classic());
        let wrong_bump = {
            // The table's seeds with a bump other than the canonical one.
            let hash = payout_table_hash(&table);
            (0..=255u8)
                .rev()
                .filter_map(|b| {
                    Address::create_program_address(
                        &[fade::PAYOUT_TABLE_SEED, &hash, &[b]],
                        &fade_id(),
                    )
                    .ok()
                })
                .nth(1)
                .unwrap()
        };
        for (why, address) in [
            ("an unrelated address", Address::new_unique()),
            ("the payer", payer.pubkey()),
            (
                "another table, not stored",
                env.payout_table_address(&thirty_two()),
            ),
            ("another table, stored", registered_other),
            (
                "the same outcomes in another order",
                env.payout_table_address(&reversed),
            ),
            ("the table's seeds with another bump", wrong_bump),
            ("the config", env.a.config),
        ] {
            let other_before = env.svm.get_account(&address);
            let before = env.lamports(&payer.pubkey());
            let ix = env.register_payout_table_ix(&payer.pubkey(), &address, &table);
            assert_fails_with(
                env.send(&[ix], &[&fees, &payer]),
                FadeError::WrongPayoutTable,
            );
            assert_eq!(
                env.svm.get_account(&address),
                other_before,
                "{why}: untouched"
            );
            assert!(!env.exists(&env.payout_table_address(&table)), "{why}");
            assert_eq!(env.lamports(&payer.pubkey()), before, "{why}");
        }
        assert_ne!(
            env.payout_table_address(&table),
            env.payout_table_address(&reversed),
            "order is part of the table"
        );
    }

    /// Defence in depth: an account at the table's address that the program
    /// did not write is refused, never read as a registration nor overwritten.
    /// Only the program can create one there, so these states are forged.
    #[test]
    fn a_forged_account_at_the_address_is_refused() {
        let mut env = Env::new();
        let payer = funded(&mut env);
        let table = coin_flip();
        let address = env.payout_table_address(&table);
        let rent = rent(&env);
        let valid = {
            let mut probe = Env::new();
            let p = funded(&mut probe);
            probe.register_payout_table(&p, &table).unwrap();
            probe.svm.get_account(&address).unwrap()
        };
        let other_hash = {
            let mut t: PayoutTable =
                PayoutTable::try_deserialize(&mut valid.data.as_slice()).unwrap();
            t.hash = [9; 32];
            let mut data = Vec::new();
            t.try_serialize(&mut data).unwrap();
            data
        };
        let mut wrong_discriminator = valid.data.clone();
        wrong_discriminator[0] ^= 1;
        let forged: [(&str, Account, u32); 4] = [
            (
                "a Fade account holding another hash",
                Account {
                    data: other_hash,
                    ..valid.clone()
                },
                fade_error(FadeError::WrongPayoutTable),
            ),
            (
                "a Fade account of another type",
                Account {
                    data: wrong_discriminator,
                    ..valid.clone()
                },
                3002, // AccountDiscriminatorMismatch
            ),
            (
                "a Fade account too short to read",
                Account {
                    data: vec![0; 8],
                    ..valid.clone()
                },
                3002,
            ),
            (
                "an account another program owns",
                Account {
                    lamports: rent,
                    data: vec![0; LEN],
                    owner: addr(anchor_spl::token::ID),
                    executable: false,
                    rent_epoch: 0,
                },
                fade_error(FadeError::WrongPayoutTable),
            ),
        ];
        for (why, account, code) in forged {
            env.svm.set_account(address, account.clone()).unwrap();
            let ix = env.register_payout_table_ix(&payer.pubkey(), &address, &table);
            match env.send(&[ix], &[&payer]) {
                Ok(_) => panic!("{why}: accepted"),
                Err(f) => assert!(f.has_code(code), "{why}: {}\n{}", f.err, f.logs.join("\n")),
            }
            assert_eq!(
                env.svm.get_account(&address).unwrap(),
                account,
                "{why}: untouched"
            );
        }
    }

    #[test]
    fn remaining_accounts_are_refused() {
        let mut env = Env::new();
        let payer = funded(&mut env);
        let table = coin_flip();
        let address = env.payout_table_address(&table);
        let mut ix = env.register_payout_table_ix(&payer.pubkey(), &address, &table);
        ix.accounts
            .push(solana_instruction::AccountMeta::new_readonly(
                Address::new_unique(),
                false,
            ));
        let fees = funded(&mut env);
        let before = env.lamports(&payer.pubkey());
        assert_fails_with(
            env.send(&[ix], &[&fees, &payer]),
            FadeError::RemainingAccounts,
        );
        nothing_moved(&env, &address, &payer.pubkey(), before);
    }

    /// The accounts Anchor checks: the payer signs and is writable, the table
    /// is writable, the System program is the System program.
    #[test]
    fn the_accounts_are_checked() {
        let mut env = Env::new();
        let payer = funded(&mut env);
        let fee_payer = funded(&mut env);
        let table = coin_flip();
        let address = env.payout_table_address(&table);
        let base = env.register_payout_table_ix(&payer.pubkey(), &address, &table);

        // the payer does not sign: the fee payer cannot stand in for it
        let mut ix = base.clone();
        ix.accounts[0].is_signer = false;
        let r = env.send(&[ix], &[&fee_payer]);
        assert!(
            r.unwrap_err().err.contains("Custom(3010)"),
            "AccountNotSigner"
        );

        // a System program impostor
        let mut ix = base.clone();
        ix.accounts[2].pubkey = addr(anchor_spl::token::ID);
        let r = env.send(&[ix], &[&payer]);
        assert!(
            r.unwrap_err().err.contains("Custom(3008)"),
            "InvalidProgramId"
        );

        // the table read-only: the runtime refuses the creation
        let mut ix = base.clone();
        ix.accounts[1].is_writable = false;
        assert!(env.send(&[ix], &[&payer]).is_err());

        assert!(!env.exists(&address));
        env.send(&[base], &[&payer]).unwrap();
    }

    /// A payer short of the rent fails the transaction: nothing is created.
    #[test]
    fn a_payer_short_of_the_rent_creates_nothing() {
        let mut env = Env::new();
        let fee_payer = funded(&mut env);
        let poor = Keypair::new();
        env.svm.airdrop(&poor.pubkey(), rent(&env) - 1).unwrap();
        let table = coin_flip();
        let address = env.payout_table_address(&table);
        let ix = env.register_payout_table_ix(&poor.pubkey(), &address, &table);
        assert!(env.send(&[ix], &[&fee_payer, &poor]).is_err());
        assert!(!env.exists(&address));
        assert_eq!(env.lamports(&poor.pubkey()), rent(&env) - 1);
    }
}

// --- join_round (Spec 08 §13.5.2) ------------------------------------------------------

mod join_round {
    use super::*;
    use anchor_lang::{AccountDeserialize, AccountSerialize};
    use fade::events::{IntegratorCreated, RoundOpened, RoundPaid, RoundSponsored, TicketJoined};
    use fade::state::{
        Integrator, Outcome, PayoutTable, RoundStatus, RoundTicketStatus, Sponsorship,
    };
    use fade_math::beacon;
    use litesvm::types::TransactionMetadata;
    use solana_account::Account;
    use solana_address::Address;
    use solana_instruction::Instruction;
    use solana_keypair::Keypair;
    use solana_signer::Signer;

    const VAULT: u64 = 100_000 * USDC;
    const ROUND_LEN: usize = 411;
    const TICKET_LEN: usize = 291;
    const SPONSORSHIP_LEN: usize = 58;
    const INTEGRATOR_LEN: usize = 179;
    const SCALE: u128 = beacon::USAGE_SCALE as u128;

    /// 1 000× with probability 0.097 %: a 300 bps margin.
    fn long_shot() -> Vec<Outcome> {
        vec![
            Outcome {
                p: 970_000,
                m: 10_000_000,
            },
            Outcome {
                p: 1_000_000_000 - 970_000,
                m: 0,
            },
        ]
    }

    /// A coin flip at 1.978×: margin 110 bps, 90 to the vault after the
    /// protocol share, below the 100 bps floor.
    fn thin() -> Vec<Outcome> {
        vec![
            Outcome {
                p: 500_000_000,
                m: 19_780,
            },
            Outcome {
                p: 500_000_000,
                m: 0,
            },
        ]
    }

    /// A founded vault of 100 000 USDC with the test tables registered.
    fn setup() -> Env {
        let mut env = Env::new();
        env.found(VAULT);
        let k = env.keeper.insecure_clone();
        for t in [coin_flip(), slot_classic(), long_shot(), thin()] {
            env.register_payout_table(&k, &t).unwrap();
        }
        env
    }

    fn rent(env: &Env, len: usize) -> u64 {
        env.svm.minimum_balance_for_rent_exemption(len)
    }

    fn spec_terms(env: &Env) -> beacon::Terms {
        let p = env.config().params;
        beacon::Terms {
            threshold: p.beacon_threshold,
            draw_max: env.draw_max(),
            round_k: p.round_k as u8,
        }
    }

    /// Sends `ix` with the keeper paying the fee, so a refused join can be
    /// checked to have taken nothing from the player.
    fn send(env: &mut Env, ix: Instruction, player: &User) -> Result<TransactionMetadata, Failure> {
        let keeper = env.keeper.insecure_clone();
        let kp = player.kp.insecure_clone();
        env.send(&[ix], &[&keeper, &kp])
    }

    fn join_with(
        env: &mut Env,
        j: &JoinArgs,
        player: &User,
    ) -> Result<TransactionMetadata, Failure> {
        let ix = env.join_round_ix(j);
        send(env, ix, player)
    }

    /// Pays round `joining_round()` with one 9 USDC coin flip from a fresh
    /// player; returns the round's id.
    fn pay_round(env: &mut Env) -> u64 {
        let id = env.joining_round();
        let p = env.user(20 * USDC);
        env.join(&p, &coin_flip(), 9 * USDC, 0, 0).unwrap();
        assert_eq!(env.round(id).status, RoundStatus::Paid);
        id
    }

    /// Moves the clock to `slot`, keeping the time.
    fn at_slot(env: &mut Env, slot: u64) {
        let now = env.now();
        env.set_time(slot, now);
    }

    /// Moves the clock to round `id`'s close slot.
    fn to_close(env: &mut Env, id: u64) {
        let close = env.round(id).close_slot;
        at_slot(env, close);
    }

    /// Every account a join could touch, byte for byte.
    fn snapshot(env: &Env, addresses: &[Address]) -> Vec<Option<Account>> {
        addresses.iter().map(|a| env.svm.get_account(a)).collect()
    }

    fn touched(env: &Env, player: &User, j: &JoinArgs) -> Vec<Address> {
        let mut v = vec![
            player.key(),
            player.usdc,
            env.a.vault,
            env.a.vault_usdc,
            env.a.config,
            env.treasury,
            env.integrator_address(&j.authority),
            env.round_ticket_address(&j.authority, j.nonce),
            j.round,
            j.next_round,
            j.payout_table,
        ];
        if let Some(s) = j.sponsorship_record {
            v.push(s);
        }
        v
    }

    /// `f` refuses `j` with `code`, and nothing moved: every account the
    /// join names is byte-identical, the player paid not even the fee.
    #[track_caller]
    fn refused(env: &mut Env, player: &User, j: &JoinArgs, check: impl Fn(&Failure) -> bool) {
        let watched = touched(env, player, j);
        let before = snapshot(env, &watched);
        let err = join_with(env, j, player).expect_err("refused");
        assert!(check(&err), "{}\n{}", err.err, err.logs.join("\n"));
        assert_eq!(
            snapshot(env, &watched),
            before,
            "a refused join moves nothing"
        );
    }

    #[track_caller]
    fn refused_with(env: &mut Env, player: &User, j: &JoinArgs, e: FadeError) {
        let code = fade_error(e);
        refused(env, player, j, |f| f.has_code(code));
    }

    #[track_caller]
    fn refused_anchor(env: &mut Env, player: &User, j: &JoinArgs, code: u32) {
        refused(env, player, j, |f| f.has_code(code));
    }

    // --- the happy path -----------------------------------------------------------------

    /// The first join creates round 1 with its snapshot, books the ticket into
    /// the vault and the integrator exactly as `open_ticket` would, holds the
    /// shares, and moves the price, the prepay and the settlement share.
    #[test]
    fn a_first_join_creates_round_one() {
        let mut env = setup();
        let player = env.user(10 * USDC);
        let v0 = env.vault();
        assert_eq!((v0.accepting_round, v0.next_round_id), (0, 1));
        let params = env.config().params;
        let d = env.draw_max();
        let p0 = env.lamports(&player.key());
        let u0 = env.balance(&env.a.vault_usdc);
        let t0 = env.balance(&env.treasury);
        let slot = env.slot();
        let price = USDC;
        let (ticket, meta) = env.join(&player, &coin_flip(), price, 50, 0).unwrap();

        // What the specification says, computed here.
        let protocol_share = price * 20 / 10_000;
        let app_share = price * 50 / 10_000;
        let credit = price - protocol_share - app_share;
        let payout_max = price * 19_600 / 10_000;
        let liability = payout_max - credit;
        let prepay = (u128::from(d) * u128::from(price)).div_ceil(8_640_000) as u64;
        // vault margin 200 − 20 − 50 = 130 bps; the cap on the vault before the join
        let free = v0.total_assets - v0.total_reserved_liability - v0.open_vault_credits;
        let cap = (free * 130 / 10_000 * 5_000 / 10_000).min(v0.total_assets * 150 / 10_000);
        let usage = (u128::from(liability) * SCALE).div_ceil(u128::from(cap)) as u64;

        // Round 1 and its snapshot.
        let round1 = round_address(1);
        let r = env.round(1);
        let (_, bump) =
            Address::find_program_address(&[fade::ROUND_SEED, &1u64.to_le_bytes()], &fade_id());
        let (_, vrf_bump) =
            Address::find_program_address(&[fade::ROUND_VRF_SEED, round1.as_ref()], &fade_id());
        assert_eq!(
            (r.version, r.bump, r.vrf_bump, r.id),
            (1, bump, vrf_bump, 1)
        );
        assert_eq!(r.status, RoundStatus::Accepting);
        assert_eq!(addr(r.rent_payer), player.key());
        assert_eq!((r.first_slot, r.paid_slot, r.close_slot), (slot, 0, 0));
        assert_eq!(r.threshold, params.beacon_threshold);
        assert_eq!(r.draw_max, d);
        assert_eq!(d, 2 * ORAO_FEE + rent(&env, 749) + 50_000);
        assert_eq!(r.round_k, 1);
        assert_eq!(r.min_price, params.beacon_min_price);
        assert_eq!(r.settle_share, params.crank_round_settle_lamports);
        assert_eq!(r.request_share, params.crank_request_lamports);
        assert_eq!(
            (
                r.tick_slots,
                r.refund_slots,
                r.t_settle_slots,
                r.drawdown_bps
            ),
            (37, 1_715, 150, 1_500)
        );
        assert_eq!(
            (r.prices, r.sponsorship, r.liability, r.credits),
            (price, 0, liability, credit)
        );
        assert_eq!(
            (r.protocol_shares, r.app_shares, r.prepaid),
            (protocol_share, app_share, prepay)
        );
        assert_eq!((r.usage, r.tickets, r.sponsors), (usage, 1, 0));
        assert!(!r.counted);
        assert_eq!((r.funded, r.draw_cost, r.entropy_slot), (0, 0, 0));
        let acc = env.svm.get_account(&round1).unwrap();
        assert_eq!((acc.owner, acc.data.len()), (fade_id(), ROUND_LEN));
        assert_eq!(
            acc.lamports,
            rent(&env, ROUND_LEN) + prepay,
            "rent and the prepay"
        );

        // The ticket.
        let t = env.round_ticket(&ticket);
        let integrator = env.integrator_address(&player.key());
        let (_, tbump) = Address::find_program_address(
            &[
                fade::ROUND_TICKET_SEED,
                integrator.as_ref(),
                &0u64.to_le_bytes(),
            ],
            &fade_id(),
        );
        assert_eq!(
            (t.version, t.bump, t.status),
            (1, tbump, RoundTicketStatus::Joined)
        );
        assert_eq!((t.round, t.nonce), (1, 0));
        assert_eq!(addr(t.integrator), integrator);
        assert_eq!(addr(t.payer), player.key());
        assert_eq!(addr(t.funder), player.key());
        assert_eq!(addr(t.refund_to), player.usdc);
        assert_eq!(addr(t.beneficiary), player.usdc);
        assert_eq!(addr(t.payout_table), env.payout_table_address(&coin_flip()));
        assert_eq!(
            (t.price, t.vault_credit, t.payout_max, t.liability),
            (price, credit, payout_max, liability)
        );
        assert_eq!(
            (t.protocol_share, t.app_share, t.prepay),
            (protocol_share, app_share, prepay)
        );
        assert_eq!((t.settle_share, t.payout), (20_000, 0));
        let tacc = env.svm.get_account(&ticket).unwrap();
        assert_eq!(tacc.data.len(), TICKET_LEN);
        assert_eq!(
            tacc.lamports,
            rent(&env, TICKET_LEN) + 20_000,
            "rent and the settlement share"
        );

        // The vault: the credit and the liability at once, the shares held,
        // no volume and no epoch counter (Spec 08 §13.7).
        let v = env.vault();
        assert_eq!(v.total_assets, v0.total_assets + credit);
        assert_eq!(
            v.total_reserved_liability,
            v0.total_reserved_liability + liability
        );
        assert_eq!(v.open_vault_credits, v0.open_vault_credits + credit);
        assert_eq!(v.beacon_shares_held, protocol_share + app_share);
        assert_eq!((v.accepting_round, v.next_round_id), (1, 2));
        assert_eq!(v.volume_total, v0.volume_total);
        assert_eq!(
            (v.open_before_close, v.open_after_close, v.generation),
            (v0.open_before_close, v0.open_after_close, v0.generation)
        );
        assert_eq!(v.integrators, v0.integrators + 1);
        assert_eq!(
            (
                v.protocol_shares_accrued,
                v.app_shares_owed,
                v.beacon_returns_owed
            ),
            (0, 0, 0)
        );
        let i = env.integrator(&player.key());
        assert_eq!(
            (
                i.reserved_liability,
                i.open_tickets,
                i.next_nonce,
                i.volume_total
            ),
            (liability, 1, 1, 0)
        );
        assert_eq!(addr(i.share_account), player.usdc);
        assert_eq!(addr(i.authority), player.key());

        // Tokens: the whole price into the vault in one transfer; no share leaves it.
        assert_eq!(env.balance(&player.usdc), 10 * USDC - price);
        assert_eq!(env.balance(&env.a.vault_usdc), u0 + price);
        assert_eq!(env.balance(&env.treasury), t0);
        // The vault identity of Spec 08 §13.7.
        assert!(
            env.balance(&env.a.vault_usdc)
                >= v.total_assets
                    + v.beacon_shares_held
                    + v.protocol_shares_accrued
                    + v.app_shares_owed
                    + v.beacon_returns_owed
        );
        // Lamports, to the lamport.
        assert_eq!(
            env.lamports(&player.key()),
            p0 - meta.fee
                - rent(&env, INTEGRATOR_LEN)
                - rent(&env, TICKET_LEN)
                - rent(&env, ROUND_LEN)
                - prepay
                - 20_000
        );

        // Events.
        let created = events::<IntegratorCreated>(&meta);
        assert_eq!(created.len(), 1);
        assert_eq!(addr(created[0].share_account), player.usdc);
        let opened = events::<RoundOpened>(&meta);
        assert_eq!(opened.len(), 1);
        let o = &opened[0];
        assert_eq!((o.version, addr(o.round), o.id), (1, round1, 1));
        assert_eq!(addr(o.rent_payer), player.key());
        assert_eq!(
            (
                o.threshold,
                o.draw_max,
                o.round_k,
                o.min_price,
                o.settle_share
            ),
            (r.threshold, d, 1, r.min_price, 20_000)
        );
        assert_eq!(
            (
                o.tick_slots,
                o.refund_slots,
                o.first_slot,
                o.request_share,
                o.t_settle_slots,
                o.drawdown_bps
            ),
            (37, 1_715, slot, 50_000, 150, 1_500)
        );
        let joined = events::<TicketJoined>(&meta);
        assert_eq!(joined.len(), 1);
        let e = &joined[0];
        assert_eq!(
            (addr(e.ticket), addr(e.round), addr(e.integrator), e.nonce),
            (ticket, round1, integrator, 0)
        );
        assert_eq!(
            (addr(e.beneficiary), addr(e.refund_to)),
            (player.usdc, player.usdc)
        );
        assert_eq!(addr(e.payout_table), env.payout_table_address(&coin_flip()));
        assert_eq!(
            (
                e.price,
                e.vault_credit,
                e.payout_max,
                e.reserved_liability,
                e.cap,
                e.usage
            ),
            (price, credit, payout_max, liability, cap, usage)
        );
        assert_eq!(
            (
                e.protocol_share,
                e.app_share,
                e.prepay,
                e.slot,
                e.settle_share
            ),
            (protocol_share, app_share, prepay, slot, 20_000)
        );
        assert_eq!(
            (addr(e.payer), addr(e.funder)),
            (player.key(), player.key())
        );
        assert!(events::<RoundSponsored>(&meta).is_empty());
        assert!(events::<RoundPaid>(&meta).is_empty());
    }

    /// An integrator paying for its players: separate integrator, payer,
    /// funder and beneficiary, each stored where it belongs; an existing
    /// integrator needs no share account.
    #[test]
    fn the_roles_are_stored_apart() {
        let mut env = setup();
        let app = env.user(0);
        let payer = env.user(0);
        let funder = env.user(5 * USDC);
        let winner = env.user(0);
        let mut j = JoinArgs::direct(&env, &funder, &coin_flip(), USDC, 50, 0);
        j.authority = app.key();
        j.payer = payer.key();
        j.share_account = Some(app.usdc);
        j.beneficiary = winner.usdc;
        j.nonce = 0;
        let ix = env.join_round_ix(&j);
        let keeper = env.keeper.insecure_clone();
        let kps = [
            keeper,
            app.kp.insecure_clone(),
            payer.kp.insecure_clone(),
            funder.kp.insecure_clone(),
        ];
        env.send(&[ix], &[&kps[0], &kps[1], &kps[2], &kps[3]])
            .unwrap();
        let t = env.round_ticket(&env.round_ticket_address(&app.key(), 0));
        assert_eq!(addr(t.integrator), env.integrator_address(&app.key()));
        assert_eq!(addr(t.payer), payer.key());
        assert_eq!(addr(t.funder), funder.key());
        assert_eq!(addr(t.refund_to), funder.usdc);
        assert_eq!(addr(t.beneficiary), winner.usdc);
        assert_eq!(addr(env.round(1).rent_payer), payer.key());
        assert_eq!(
            env.balance(&app.usdc),
            0,
            "no app share is paid at the join"
        );

        // The next join of that integrator passes no share account.
        let mut j2 = JoinArgs::direct(&env, &funder, &coin_flip(), USDC, 50, 0);
        j2.authority = app.key();
        j2.payer = payer.key();
        j2.share_account = None;
        j2.nonce = 1;
        let ix = env.join_round_ix(&j2);
        env.send(&[ix], &[&kps[0], &kps[1], &kps[2], &kps[3]])
            .unwrap();
        assert_eq!(env.round(1).tickets, 2);
        assert_eq!(env.integrator(&app.key()).next_nonce, 2);
    }

    // --- round resolution ----------------------------------------------------------------

    /// Case 1, nothing changed: the join lands in the accepting round.
    #[test]
    fn resolution_joins_the_accepting_round() {
        let mut env = setup();
        let a = env.user(10 * USDC);
        let b = env.user(10 * USDC);
        env.join(&a, &coin_flip(), USDC, 0, 0).unwrap();
        let (_, meta) = env.join(&b, &slot_classic(), 2 * USDC, 0, 0).unwrap();
        assert!(events::<RoundOpened>(&meta).is_empty(), "no new round");
        let r = env.round(1);
        assert_eq!((r.tickets, r.prices), (2, 3 * USDC));
        assert_eq!(
            (env.vault().accepting_round, env.vault().next_round_id),
            (1, 2)
        );
        assert!(!env.exists(&round_address(2)));
        assert_eq!(
            env.round_ticket(&env.round_ticket_address(&b.key(), 0))
                .round,
            1
        );
    }

    /// Case 2, the accepting round closed: the join creates the next one.
    #[test]
    fn resolution_opens_the_next_round_once_the_accepting_one_closed() {
        let mut env = setup();
        pay_round(&mut env);
        let close = env.round(1).close_slot;
        at_slot(&mut env, close);
        let before = env.round(1);
        let a = env.user(10 * USDC);
        let j = JoinArgs::direct(&env, &a, &coin_flip(), USDC, 0, 0);
        assert_eq!(
            (j.round, j.next_round),
            (round_address(1), round_address(2))
        );
        let meta = join_with(&mut env, &j, &a).unwrap();
        assert_eq!(events::<RoundOpened>(&meta)[0].id, 2);
        assert_eq!(
            (env.vault().accepting_round, env.vault().next_round_id),
            (2, 3)
        );
        let r2 = env.round(2);
        assert_eq!(
            (r2.tickets, r2.first_slot, r2.status),
            (1, close, RoundStatus::Accepting)
        );
        assert_eq!(addr(r2.rent_payer), a.key());
        let after = env.round(1);
        assert_eq!(
            (after.tickets, after.prices, after.usage),
            (before.tickets, before.prices, before.usage),
            "the closed round is left as it was"
        );
    }

    /// Case 3, another join opened the next round first: a transaction built
    /// against the closed round lands in the new one, without a retry.
    #[test]
    fn resolution_lands_in_a_round_another_join_opened() {
        let mut env = setup();
        pay_round(&mut env);
        let close = env.round(1).close_slot;
        at_slot(&mut env, close);
        let late = env.user(10 * USDC);
        let stale = JoinArgs::direct(&env, &late, &coin_flip(), USDC, 0, 0);
        assert_eq!(env.joining_round(), 2, "the client expects to open round 2");
        let first = env.user(10 * USDC);
        env.join(&first, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!(env.vault().accepting_round, 2);
        let meta = join_with(&mut env, &stale, &late).unwrap();
        assert!(events::<RoundOpened>(&meta).is_empty());
        assert_eq!(env.round(2).tickets, 2);
        assert_eq!(
            (env.vault().accepting_round, env.vault().next_round_id),
            (2, 3)
        );
        assert!(!env.exists(&round_address(3)));
    }

    /// Two rotations between the read and the landing: the client retries.
    #[test]
    fn two_rotations_make_the_client_retry() {
        let mut env = setup();
        pay_round(&mut env);
        to_close(&mut env, 1);
        let late = env.user(10 * USDC);
        let stale = JoinArgs::direct(&env, &late, &coin_flip(), USDC, 0, 0);
        pay_round(&mut env); // opens and pays round 2
        to_close(&mut env, 2);
        let third = env.user(10 * USDC);
        env.join(&third, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!(env.vault().accepting_round, 3);
        refused_with(&mut env, &late, &stale, FadeError::WrongRound);
        // Rebuilt against what it reads now, it lands.
        let fresh = JoinArgs::direct(&env, &late, &coin_flip(), USDC, 0, 0);
        join_with(&mut env, &fresh, &late).unwrap();
        assert_eq!(env.round(3).tickets, 2);
    }

    /// The accepting round and the round to create must each be one of the
    /// two accounts passed, in either order; nothing else is accepted.
    #[test]
    fn the_round_accounts_are_the_derived_ones() {
        let mut env = setup();
        let p = env.user(20 * USDC);
        // No accepting round: round 1 is created, so it must be passed.
        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        j.round = round_address(2);
        j.next_round = round_address(3);
        refused_with(&mut env, &p, &j, FadeError::WrongRound);
        j.round = Address::new_unique();
        j.next_round = env.a.vault;
        refused_with(&mut env, &p, &j, FadeError::WrongRound);
        // Either position, or both the same account, will do.
        j.round = round_address(7);
        j.next_round = round_address(1);
        join_with(&mut env, &j, &p).unwrap();
        // Round 1 accepts tickets: it must be passed, even if the next one is.
        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        j.round = round_address(2);
        j.next_round = round_address(3);
        refused_with(&mut env, &p, &j, FadeError::WrongRound);
        j.round = round_address(1);
        j.next_round = round_address(1);
        join_with(&mut env, &j, &p).unwrap();
        assert_eq!(env.round(1).tickets, 2);
        // A closed round: the accepting one must still be passed, since its
        // state decides; the next alone is refused.
        pay_round(&mut env);
        to_close(&mut env, 1);
        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        j.round = round_address(2);
        j.next_round = round_address(2);
        refused_with(&mut env, &p, &j, FadeError::WrongRound);
        // And the round to create must be passed too.
        j.round = round_address(1);
        j.next_round = round_address(3);
        refused_with(&mut env, &p, &j, FadeError::WrongRound);
        j.next_round = round_address(2);
        join_with(&mut env, &j, &p).unwrap();
        assert_eq!(env.vault().accepting_round, 2);
    }

    /// Spec 08 §13.9: at `close_slot − 1` a join enters the round; at
    /// `close_slot` the round is closed and the join opens the next one. A
    /// round paid in the last slot of a tick closes at the next slot; one
    /// paid on a boundary closes a whole tick later.
    #[test]
    fn the_boundary_slot() {
        // Paid in the last slot of a tick.
        let mut env = setup();
        at_slot(&mut env, 37 * 30 - 1);
        let (_, meta) = {
            let p = env.user(20 * USDC);
            env.join(&p, &coin_flip(), 9 * USDC, 0, 0).unwrap()
        };
        let r = env.round(1);
        assert_eq!(
            (r.status, r.paid_slot, r.close_slot),
            (RoundStatus::Paid, 1_109, 1_110)
        );
        let paid = events::<RoundPaid>(&meta);
        assert_eq!(paid.len(), 1);
        assert_eq!(
            (
                addr(paid[0].round),
                paid[0].paid_slot,
                paid[0].close_slot,
                paid[0].prices,
                paid[0].sponsorship
            ),
            (round_address(1), 1_109, 1_110, 9 * USDC, 0)
        );
        at_slot(&mut env, 1_110);
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!(
            (env.round(1).tickets, env.round(1).prices),
            (1, 9 * USDC),
            "nothing joins at the close slot: its prices are final"
        );
        assert_eq!(env.round(2).tickets, 1);

        // Paid on a boundary: closes a tick later; joins until the slot before.
        let mut env = setup();
        at_slot(&mut env, 37 * 30);
        let p = env.user(20 * USDC);
        env.join(&p, &coin_flip(), 9 * USDC, 0, 0).unwrap();
        assert_eq!(
            (env.round(1).paid_slot, env.round(1).close_slot),
            (1_110, 1_147)
        );
        at_slot(&mut env, 1_146);
        let q = env.user(10 * USDC);
        let (_, meta) = env.join(&q, &coin_flip(), USDC, 0, 0).unwrap();
        assert!(events::<RoundPaid>(&meta).is_empty(), "paid once");
        let r = env.round(1);
        assert_eq!(
            (r.tickets, r.status, r.close_slot),
            (2, RoundStatus::Paid, 1_147)
        );
        assert!(!env.exists(&round_address(2)));
        at_slot(&mut env, 1_147);
        env.join(&q, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!((env.round(1).tickets, env.round(2).tickets), (2, 1));
        assert_eq!(
            env.round(1).prices,
            10 * USDC,
            "prices final at the close slot"
        );
    }

    /// An unpaid round has no close: it keeps taking joins at any slot.
    #[test]
    fn an_unpaid_round_never_closes() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let later = env.slot() + 50_000;
        at_slot(&mut env, later);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!(env.round(1).tickets, 2);
        assert_eq!(env.round(1).status, RoundStatus::Accepting);
    }

    // --- sponsorship ------------------------------------------------------------------------

    /// Spec 08 §13.5.2, a lone ticket: the join carries the sponsorship that
    /// pays the round, computed from the round it read. The round is paid in
    /// the join and closes at the next tick boundary.
    #[test]
    fn a_lone_ticket_paid_by_its_own_sponsorship() {
        let mut env = setup();
        let terms = spec_terms(&env);
        let price = USDC;
        let s = beacon::sponsorship_to_pay(&terms, price, 0).unwrap();
        // ceil(D_r × (T_r − R) / T_r)
        let d = u128::from(terms.draw_max);
        assert_eq!(
            u128::from(s),
            (d * u128::from(8_640_000 - price)).div_ceil(8_640_000)
        );
        let prepay = beacon::prepay(&terms, price).unwrap();

        // One lamport short: the round stays unpaid.
        {
            let mut env = setup();
            let p = env.user(10 * USDC);
            env.join(&p, &coin_flip(), price, 0, s - 1).unwrap();
            assert_eq!(env.round(1).status, RoundStatus::Accepting);
            assert_eq!(env.round(1).sponsorship, s - 1);
        }

        let player = env.user(10 * USDC);
        at_slot(&mut env, 2_000);
        let p0 = env.lamports(&player.key());
        let (ticket, meta) = env.join(&player, &coin_flip(), price, 0, s).unwrap();
        let r = env.round(1);
        assert_eq!(r.status, RoundStatus::Paid);
        assert_eq!((r.paid_slot, r.close_slot), (2_000, 2_035));
        assert_eq!((r.sponsorship, r.sponsors, r.prepaid), (s, 1, prepay));
        assert!(beacon::is_paid(&r.terms(), r.prices, r.sponsorship));
        let record_address = sponsorship_address(&round_address(1), &player.key());
        let rec: Sponsorship = env.read(&record_address);
        let (_, bump) = Address::find_program_address(
            &[
                fade::SPONSORSHIP_SEED,
                round_address(1).as_ref(),
                player.key().as_ref(),
            ],
            &fade_id(),
        );
        assert_eq!(
            (rec.version, rec.bump, rec.round, rec.amount),
            (1, bump, 1, s)
        );
        assert_eq!(addr(rec.sponsor), player.key());
        let racc = env.svm.get_account(&record_address).unwrap();
        assert_eq!((racc.owner, racc.data.len()), (fade_id(), SPONSORSHIP_LEN));
        assert_eq!(racc.lamports, rent(&env, SPONSORSHIP_LEN));
        assert_eq!(
            env.lamports(&round_address(1)),
            rent(&env, ROUND_LEN) + prepay + s,
            "the prepay and the sponsorship are held on the round"
        );
        assert_eq!(
            env.lamports(&player.key()),
            p0 - meta.fee
                - rent(&env, INTEGRATOR_LEN)
                - rent(&env, TICKET_LEN)
                - rent(&env, ROUND_LEN)
                - rent(&env, SPONSORSHIP_LEN)
                - prepay
                - s
                - 20_000
        );
        assert!(env.exists(&ticket));
        let sp = events::<RoundSponsored>(&meta);
        assert_eq!(sp.len(), 1);
        assert_eq!(
            (
                addr(sp[0].round),
                addr(sp[0].sponsor),
                sp[0].lamports,
                sp[0].total
            ),
            (round_address(1), player.key(), s, s)
        );
        let paid = events::<RoundPaid>(&meta);
        assert_eq!(paid.len(), 1);
        assert_eq!(
            (paid[0].prices, paid[0].sponsorship, paid[0].close_slot),
            (price, s, 2_035)
        );
        // The next join after the close opens round 2.
        at_slot(&mut env, 2_035);
        env.join(&player, &coin_flip(), price, 0, 0).unwrap();
        assert_eq!(env.vault().accepting_round, 2);
    }

    /// A second sponsorship by the same payer tops up its record; another
    /// payer gets its own. A paid round still takes sponsorship until its
    /// request, without being paid again.
    #[test]
    fn sponsorship_records_are_per_sponsor_and_topped_up() {
        let mut env = setup();
        let a = env.user(10 * USDC);
        let b = env.user(10 * USDC);
        env.join(&a, &coin_flip(), USDC, 0, 1_000).unwrap();
        env.join(&a, &coin_flip(), USDC, 0, 2_000).unwrap();
        let (_, meta) = env.join(&b, &coin_flip(), USDC, 0, 500).unwrap();
        let ra: Sponsorship = env.read(&sponsorship_address(&round_address(1), &a.key()));
        let rb: Sponsorship = env.read(&sponsorship_address(&round_address(1), &b.key()));
        assert_eq!((ra.amount, rb.amount), (3_000, 500));
        let r = env.round(1);
        assert_eq!((r.sponsorship, r.sponsors, r.tickets), (3_500, 2, 3));
        assert_eq!(events::<RoundSponsored>(&meta)[0].total, 3_500);

        pay_round(&mut env);
        let (_, meta) = env.join(&b, &coin_flip(), USDC, 0, 700).unwrap();
        let r = env.round(1);
        assert_eq!(
            (r.status, r.sponsorship, r.sponsors),
            (RoundStatus::Paid, 4_200, 2)
        );
        assert!(events::<RoundPaid>(&meta).is_empty());
        assert_eq!(events::<RoundSponsored>(&meta)[0].total, 4_200);
    }

    /// The record must be the one of the round the join lands in, for its payer.
    #[test]
    fn the_sponsorship_record_is_checked() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        let other = env.user(0);
        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 1_000);
        let good = j.sponsorship_record;
        j.sponsorship_record = None;
        refused_anchor(&mut env, &p, &j, 3005); // AccountNotEnoughKeys
        j.sponsorship_record = Some(sponsorship_address(&round_address(1), &other.key()));
        refused_anchor(&mut env, &p, &j, 2006); // ConstraintSeeds
        j.sponsorship_record = Some(sponsorship_address(&round_address(2), &p.key()));
        refused_anchor(&mut env, &p, &j, 2006);
        // An address owned by another program.
        let foreign = good.unwrap();
        env.svm
            .set_account(
                foreign,
                Account {
                    lamports: 1_000_000,
                    data: vec![],
                    owner: addr(anchor_spl::token::ID),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        j.sponsorship_record = good;
        refused_anchor(&mut env, &p, &j, 3007); // AccountOwnedByWrongProgram
                                                // A sponsorship of 0 needs no record, and ignores one passed.
        let mut j0 = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        j0.sponsorship_record = Some(Address::new_unique());
        join_with(&mut env, &j0, &p).unwrap();
        assert_eq!((env.round(1).sponsorship, env.round(1).sponsors), (0, 0));
    }

    /// A sponsorship record built against a round that closed before the join
    /// landed names the wrong round: refused, nothing moves, the client retries.
    #[test]
    fn a_sponsored_join_across_a_rotation_is_retried() {
        let mut env = setup();
        pay_round(&mut env);
        let p = env.user(10 * USDC);
        let stale = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 1_000);
        assert_eq!(
            stale.sponsorship_record,
            Some(sponsorship_address(&round_address(1), &p.key()))
        );
        to_close(&mut env, 1);
        refused_anchor(&mut env, &p, &stale, 2006);
        let fresh = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 1_000);
        join_with(&mut env, &fresh, &p).unwrap();
        assert_eq!(env.round(2).sponsorship, 1_000);
    }

    // --- capacity --------------------------------------------------------------------------

    /// What a long shot of `price` uses of its own cap on `env`'s vault now.
    pub(super) fn long_shot_usage(env: &Env, price: u64) -> u64 {
        // vault margin: 300 − 20 = 280 bps
        usage_of(env, price, 10_000_000, 280)
    }

    /// What a coin flip of `price` uses of its own cap on `env`'s vault now.
    fn coin_flip_usage(env: &Env, price: u64) -> u64 {
        // vault margin: 200 − 20 = 180 bps
        usage_of(env, price, 19_600, 180)
    }

    fn usage_of(env: &Env, price: u64, max_m: u64, vault_margin_bps: u64) -> u64 {
        try_usage_of(env, price, max_m, vault_margin_bps).unwrap()
    }

    /// `None` when admission refuses the ticket outright (`PerTicketCap`).
    fn try_usage_of(env: &Env, price: u64, max_m: u64, vault_margin_bps: u64) -> Option<u64> {
        let v = env.vault();
        let params = env.config().params.to_math();
        let cap =
            fade_math::risk::per_ticket_cap(&v.math(), vault_margin_bps, &params, false).unwrap();
        let w = fade_math::risk::ticket_for(price, max_m, 0, &params).ok()?;
        beacon::usage(
            fade_math::risk::liability(w.payout_max, w.vault_credit),
            cap,
        )
        .ok()
    }

    /// `R × D_r + S × T_r` against `T_r × D_r`, unclamped: how many times over
    /// the round's draw is paid, in whole draws.
    fn times_paid(env: &Env, id: u64) -> u128 {
        let r = env.round(id);
        let whole = u128::from(r.threshold) * u128::from(r.draw_max);
        (u128::from(r.prices) * u128::from(r.draw_max)
            + u128::from(r.sponsorship) * u128::from(r.threshold))
            / whole
    }

    /// Capacity follows payment: a 1 000× ticket of 1 USDC uses 71 % of its
    /// cap, so it needs that share of the draw paid. One lamport of
    /// sponsorship less than the least that fits is refused, moving nothing.
    #[test]
    fn capacity_follows_payment_to_the_lamport() {
        let env0 = setup();
        let terms = spec_terms(&env0);
        let usage = long_shot_usage(&env0, USDC);
        assert!(usage > 700_000_000 && usage < 720_000_000, "{usage}");
        let (mut lo, mut hi) = (0u64, terms.draw_max);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if beacon::fits(&terms, usage, USDC, mid) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        let least = lo;
        // The exact rule, unpaid: U × T × D ≤ k × SCALE × (1 − h) × (R × D + S × T)
        let h = u128::from(beacon::UNPAID_HEADROOM_BPS);
        let lhs =
            u128::from(usage) * u128::from(terms.threshold) * u128::from(terms.draw_max) * 10_000;
        let rhs = |s: u64| {
            SCALE
                * (10_000 - h)
                * (u128::from(USDC) * u128::from(terms.draw_max)
                    + u128::from(s) * u128::from(terms.threshold))
        };
        assert!(lhs <= rhs(least) && lhs > rhs(least - 1));

        let mut env = setup();
        let p = env.user(10 * USDC);
        let j = JoinArgs::direct(&env, &p, &long_shot(), USDC, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::RoundCapacity);
        let j = JoinArgs::direct(&env, &p, &long_shot(), USDC, 0, least - 1);
        refused_with(&mut env, &p, &j, FadeError::RoundCapacity);
        assert!(!env.exists(&round_address(1)), "no round without a ticket");
        let j = JoinArgs::direct(&env, &p, &long_shot(), USDC, 0, least);
        let meta = join_with(&mut env, &j, &p).unwrap();
        let r = env.round(1);
        assert_eq!((r.usage, r.sponsorship), (usage, least));
        assert_eq!(events::<TicketJoined>(&meta)[0].usage, usage);
        assert!(beacon::fits(&r.terms(), r.usage, r.prices, r.sponsorship));
    }

    /// The round's own earlier payment counts: a ticket refused alone fits
    /// once other tickets have paid enough of the draw, and a paid round
    /// carries one whole cap. The room earlier tickets bought goes only to a
    /// later join within its own share (`k · price / T_r`), or within the
    /// `h · k` floor for the join that pays the round: a 0.50 USDC ticket at
    /// 97 % of its share (`near_share`), refused alone, fits after them; a
    /// 0.50 USDC ticket at 7 % of its cap (`mid_shot`, above its 5.8 % share)
    /// is refused even then, unless it is the join that pays the round, and
    /// so is a 1 USDC long shot at 71 % of its cap.
    #[test]
    fn earlier_tickets_buy_room_for_later_ones() {
        let mut env = setup();
        let k = env.keeper.insecure_clone();
        env.register_payout_table(&k, &mid_shot()).unwrap();
        env.register_payout_table(&k, &near_share()).unwrap();
        let terms = spec_terms(&env);
        let price = 500_000;
        let u = usage_of(&env, price, 1_600_000, 280);
        assert!(!beacon::fits(&terms, u, price, 0), "refused alone");
        assert!(beacon::within_join_share(&terms, u, price, 0, false));
        let mid = usage_of(&env, price, 2_000_000, 280);
        assert!(!beacon::within_join_share(&terms, mid, price, 0, false));
        assert!(beacon::within_join_share(&terms, mid, price, 0, true));
        let p = env.user(30 * USDC);
        let j = JoinArgs::direct(&env, &p, &near_share(), price, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::RoundCapacity);
        // 7 USDC of coin flips pay 81 % of the draw.
        env.join(&p, &coin_flip(), 7 * USDC, 0, 0).unwrap();
        let j = JoinArgs::direct(&env, &p, &long_shot(), USDC, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::RoundCapacity);
        let j = JoinArgs::direct(&env, &p, &mid_shot(), price, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::RoundCapacity);
        let j = JoinArgs::direct(&env, &p, &near_share(), price, 0, 0);
        join_with(&mut env, &j, &p).unwrap();
        let r = env.round(1);
        assert_eq!(
            r.status,
            RoundStatus::Accepting,
            "7.5 USDC of 8.64: not paid yet"
        );
        assert_eq!(r.tickets, 2);
        assert!(beacon::fits(&r.terms(), r.usage, r.prices, r.sponsorship));
        // 0.64 USDC more coin flips leave 0.50 USDC to pay: the `mid_shot`
        // that pays the round keeps the `h · k` floor and fits.
        env.join(&p, &coin_flip(), 640_000, 0, 0).unwrap();
        assert_eq!(env.round(1).status, RoundStatus::Accepting);
        let j = JoinArgs::direct(&env, &p, &mid_shot(), price, 0, 0);
        join_with(&mut env, &j, &p).unwrap();
        let r = env.round(1);
        assert_eq!((r.status, r.tickets), (RoundStatus::Paid, 4));
        // The round paid, the next `mid_shot` is beyond its share again.
        let j = JoinArgs::direct(&env, &p, &mid_shot(), price, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::RoundCapacity);
    }

    /// Spec 08 §13.4 fact 4: a paid round is full at `k` caps however much
    /// more than its draw it is paid, by sponsorship or by ticket prices. The
    /// paid fraction is clamped at 1, so a corrupted draw costs the vault at
    /// most one per-ticket cap (`round_k` = 1). And a join sponsoring its own
    /// draw in full always fits up to `k` caps.
    #[test]
    fn a_paid_round_is_full_at_one_cap() {
        let k = u64::from(spec_terms(&setup()).round_k);
        assert_eq!(k, 1, "MAX_ROUND_K");
        let full = k * beacon::USAGE_SCALE;

        // Paid by the join's own sponsorship, exactly what pays the draw.
        let mut env = setup();
        let terms = spec_terms(&env);
        let s = beacon::sponsorship_to_pay(&terms, USDC, 0).unwrap();
        let a = env.user(10 * USDC);
        let u = long_shot_usage(&env, USDC);
        env.join(&a, &long_shot(), USDC, 0, s).unwrap();
        let r = env.round(1);
        assert_eq!(
            (r.status, r.usage, r.sponsorship),
            (RoundStatus::Paid, u, s)
        );
        let b = env.user(10 * USDC);
        assert!(r.usage + long_shot_usage(&env, USDC) > full);
        let j = JoinArgs::direct(&env, &b, &long_shot(), USDC, 0, 0);
        refused_with(&mut env, &b, &j, FadeError::RoundCapacity);

        // Paid ten times over by sponsorship.
        let mut env = setup();
        let d = spec_terms(&env).draw_max;
        let a = env.user(10 * USDC);
        env.join(&a, &long_shot(), USDC, 0, 10 * d).unwrap();
        assert_eq!(env.round(1).status, RoundStatus::Paid);
        assert!(times_paid(&env, 1) >= 10);
        let b = env.user(10 * USDC);
        // Unclamped, the payment would carry the second ticket ten times over.
        let j = JoinArgs::direct(&env, &b, &long_shot(), USDC, 0, 0);
        refused_with(&mut env, &b, &j, FadeError::RoundCapacity);
        // More sponsorship buys nothing past `k` caps: the join that carries
        // it is moved to the next round, which it pays, and the full round
        // keeps what it had.
        let r1 = env.round(1);
        let mut j = JoinArgs::direct(&env, &b, &long_shot(), USDC, 0, 10 * d);
        j.sponsorship_record = Some(sponsorship_address(&round_address(2), &b.key()));
        join_with(&mut env, &j, &b).unwrap();
        assert_eq!(env.round(2).status, RoundStatus::Paid);
        let r = env.round(1);
        assert!(r.usage <= full);
        assert_eq!((r.tickets, r.sponsors, r.usage), (1, 1, r1.usage));

        // Paid ten times over by ticket prices. A long shot takes no more of
        // a paid round than its own payment buys (`within_join_share`), so it
        // brings a draw's sponsorship; the clamp at `k` caps then refuses the
        // next one, payment or not.
        let mut env = setup();
        let a = env.user(100 * USDC);
        env.join(&a, &coin_flip(), 90 * USDC, 0, 0).unwrap();
        assert_eq!(env.round(1).status, RoundStatus::Paid);
        assert!(times_paid(&env, 1) >= 10);
        env.join(&a, &long_shot(), USDC, 0, d).unwrap();
        assert!(env.round(1).usage + long_shot_usage(&env, USDC) > full);
        let j = JoinArgs::direct(&env, &a, &long_shot(), USDC, 0, 0);
        refused_with(&mut env, &a, &j, FadeError::RoundCapacity);
        let r = env.round(1);
        assert!(r.usage <= full);
        assert_eq!(r.tickets, 2);
    }

    /// A paid round a join does not fit is full for it, and the join lands
    /// in the next round at once, which it creates, without waiting for the
    /// full round's close (the audit of 15 October 2026: refusing it let
    /// whoever filled a paid round first refuse every other join for the
    /// rest of the tick, for the edge on one ticket). The full round keeps
    /// what it had, its close slot included, and stops being the accepting
    /// round; the client's transaction, the round it read and its successor,
    /// is unchanged. A join that fits the full round still lands in it.
    #[test]
    fn a_join_a_full_paid_round_cannot_take_lands_in_the_next() {
        let mut env = setup();
        let d = spec_terms(&env).draw_max;
        // The largest long shot that fits a round alone: its usage is within
        // a 30 USDC coin flip's of the whole cap.
        let (mut lo, mut hi) = (USDC, 2 * USDC);
        while lo < hi {
            let mid = lo + (hi - lo).div_ceil(2);
            if try_usage_of(&env, mid, 10_000_000, 280).is_some_and(|u| u <= beacon::USAGE_SCALE) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        let a = env.user(10 * USDC);
        env.join(&a, &long_shot(), lo, 0, 10 * d).unwrap();
        let before = env.round(1);
        assert_eq!(before.status, RoundStatus::Paid);
        assert!(before.usage <= beacon::USAGE_SCALE);
        let flip = 30 * USDC;
        assert!(before.usage + coin_flip_usage(&env, flip) > beacon::USAGE_SCALE);
        assert!(env.slot() < before.close_slot, "still in its tick");

        let b = env.user(40 * USDC);
        let j = JoinArgs::direct(&env, &b, &coin_flip(), flip, 0, 0);
        assert_eq!(
            (j.round, j.next_round),
            (round_address(1), round_address(2))
        );
        let meta = join_with(&mut env, &j, &b).unwrap();
        eprintln!(
            "CU join_round (past a full paid round, creating the next): {}",
            meta.compute_units_consumed
        );
        assert!(meta.compute_units_consumed < 200_000);
        assert_eq!(
            addr(events::<TicketJoined>(&meta)[0].round),
            round_address(2)
        );
        let r2 = env.round(2);
        assert_eq!(
            (r2.status, r2.prices, r2.tickets),
            (RoundStatus::Paid, flip, 1)
        );
        assert_eq!(
            (env.vault().accepting_round, env.vault().next_round_id),
            (2, 3)
        );
        let after = env.round(1);
        assert_eq!(
            (
                after.status,
                after.close_slot,
                after.prices,
                after.sponsorship,
                after.usage,
                after.tickets
            ),
            (
                RoundStatus::Paid,
                before.close_slot,
                before.prices,
                before.sponsorship,
                before.usage,
                before.tickets
            ),
            "the full round keeps what it had"
        );
        // The full round is no longer named: a join that would have fitted
        // it lands in round 2, and round 1 is requested at its own close.
        let c = env.user(10 * USDC);
        let (t, _) = env.join(&c, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!(env.round_ticket(&t).round, 2);
        assert_eq!(env.round(1).tickets, before.tickets);
    }

    /// One cheap ticket can no longer fill a paid round (the second final
    /// audit, item 2): honest prices pay round 1, then a long shot at 1 USDC,
    /// 71 % of its cap for 11.6 % of the draw's payment, would take the room
    /// left and send every later join of the tick to a new unpaid round, a
    /// second draw for the honest joins. A join that leaves a round paid
    /// takes at most `max(h · k, k · its paid share)`: the long shot is
    /// refused, moving nothing and opening nothing, and honest joins keep
    /// landing in round 1. Bringing the payment its room costs, a draw's
    /// sponsorship, it fits; a round filled that way still sends the next
    /// join to round 2 at once, in the same tick (the audit of 15 October).
    #[test]
    fn filling_a_paid_round_costs_its_payment() {
        let mut env = setup();
        let terms = spec_terms(&env);
        let h = env.user(100 * USDC);
        env.join(&h, &coin_flip(), 9 * USDC, 0, 0).unwrap();
        assert_eq!(env.round(1).status, RoundStatus::Paid);
        let r1 = env.round(1);
        let u = long_shot_usage(&env, USDC);
        assert!(r1.usage + u <= beacon::USAGE_SCALE, "the room is there");
        assert!(!beacon::within_join_share(&terms, u, USDC, 0, false));

        // The cheap fill is refused, and opens no round.
        let x = env.user(10 * USDC);
        let j = JoinArgs::direct(&env, &x, &long_shot(), USDC, 0, 0);
        refused_with(&mut env, &x, &j, FadeError::RoundCapacity);
        assert!(!env.exists(&round_address(2)));
        assert_eq!(env.vault().accepting_round, 1);
        // Honest joins still land in round 1.
        let (t, _) = env.join(&h, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!(env.round_ticket(&t).round, 1);

        // With the payment its room costs, the long shot fits round 1.
        let s = beacon::sponsorship_to_pay(&terms, USDC, 0).unwrap();
        assert!(beacon::within_join_share(&terms, u, USDC, s, false));
        let (t, _) = env.join(&x, &long_shot(), USDC, 0, s).unwrap();
        assert_eq!(env.round_ticket(&t).round, 1);
        let r1 = env.round(1);
        assert!(
            r1.usage + u > beacon::USAGE_SCALE,
            "now full for a long shot"
        );

        // A full paid round still sends the next join on, in its tick.
        let p = env.user(10 * USDC);
        let mut j = JoinArgs::direct(&env, &p, &long_shot(), USDC, 0, s);
        j.sponsorship_record = Some(sponsorship_address(&round_address(2), &p.key()));
        assert!(env.slot() < r1.close_slot);
        join_with(&mut env, &j, &p).unwrap();
        assert_eq!(env.round(2).status, RoundStatus::Paid);
        assert_eq!(env.round(1).tickets, r1.tickets);
    }

    /// Floor-sized joins cannot fill a paid round (the re-audit of 24 October
    /// 2026): with the `h · k` floor every join's, `1/h` minimum-price long
    /// shots at up to `h · k` caps each filled a round honest prices had
    /// paid, for a fraction of a draw, and sent every later join of the tick
    /// to a new unpaid round. The floor is the paying join's alone: in a
    /// paid round a 0.50 USDC ticket at 7 % of its cap (`mid_shot`, above
    /// its 5.8 % share) is refused `RoundCapacity`, opens no round, and moves
    /// nothing, however many are sent, and honest joins keep landing in
    /// round 1.
    #[test]
    fn floor_sized_joins_cannot_fill_a_paid_round() {
        let mut env = setup();
        let k = env.keeper.insecure_clone();
        env.register_payout_table(&k, &mid_shot()).unwrap();
        let terms = spec_terms(&env);
        let h = env.user(100 * USDC);
        env.join(&h, &coin_flip(), 9 * USDC, 0, 0).unwrap();
        let r1 = env.round(1);
        assert_eq!(r1.status, RoundStatus::Paid);
        let u = usage_of(&env, 500_000, 2_000_000, 280);
        assert!(u <= beacon::USAGE_SCALE / 10, "within the h · k floor");
        assert!(!beacon::within_join_share(&terms, u, 500_000, 0, false));

        let x = env.user(100 * USDC);
        for _ in 0..10 {
            let j = JoinArgs::direct(&env, &x, &mid_shot(), 500_000, 0, 0);
            refused_with(&mut env, &x, &j, FadeError::RoundCapacity);
        }
        let r = env.round(1);
        assert_eq!((r.usage, r.tickets), (r1.usage, r1.tickets));
        assert!(!env.exists(&round_address(2)));
        assert_eq!(env.vault().accepting_round, 1);
        let (t, _) = env.join(&h, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!(env.round_ticket(&t).round, 1);
    }

    /// The per-join share holds before the payment too (the final audit,
    /// fourth pass): honest prices take round 1 near its payment, then a
    /// long shot at 1 USDC, 71 % of its cap, fits the unpaid bound
    /// `0.9 · k · (R + p) / T_r` with room bought by the honest joins, so it
    /// would take that room one join before the payment and leave the join
    /// that pays the round little. A join takes at most `max(h · k, k · its
    /// own share)` whether the round is paid or not: the long shot is refused
    /// `RoundCapacity`, nothing moves, and an honest join then pays round 1.
    /// The same long shot carrying the draw's sponsorship still fits.
    #[test]
    fn a_join_before_the_payment_takes_only_its_own_share() {
        let mut env = setup();
        let terms = spec_terms(&env);
        let h = env.user(100 * USDC);
        let honest = terms.threshold / 10 * 8;
        env.join(&h, &coin_flip(), honest, 0, 0).unwrap();
        let r1 = env.round(1);
        assert_eq!(r1.status, RoundStatus::Accepting);
        let u = long_shot_usage(&env, USDC);
        assert!(
            beacon::fits(&terms, r1.usage + u, r1.prices + USDC, r1.sponsorship),
            "the unpaid bound alone admits it"
        );
        assert!(!beacon::is_paid(&terms, r1.prices + USDC, r1.sponsorship));
        assert!(!beacon::within_join_share(&terms, u, USDC, 0, false));

        let x = env.user(10 * USDC);
        let before = env.vault();
        let j = JoinArgs::direct(&env, &x, &long_shot(), USDC, 0, 0);
        refused_with(&mut env, &x, &j, FadeError::RoundCapacity);
        let r = env.round(1);
        assert_eq!(
            (r.prices, r.usage, r.tickets, r.sponsorship),
            (r1.prices, r1.usage, r1.tickets, r1.sponsorship)
        );
        assert_eq!(
            env.vault().total_reserved_liability,
            before.total_reserved_liability
        );
        assert!(!env.exists(&round_address(2)));

        // The honest join that pays the round lands in round 1.
        let (t, _) = env
            .join(&h, &coin_flip(), terms.threshold - honest, 0, 0)
            .unwrap();
        assert_eq!(env.round_ticket(&t).round, 1);
        assert_eq!(env.round(1).status, RoundStatus::Paid);

        // Before the payment, the long shot bringing the draw fits.
        let mut env = setup();
        let h = env.user(100 * USDC);
        env.join(&h, &coin_flip(), honest, 0, 0).unwrap();
        let x = env.user(10 * USDC);
        let s = beacon::sponsorship_to_pay(&terms, USDC, 0).unwrap();
        assert!(beacon::within_join_share(&terms, u, USDC, s, true));
        let (t, _) = env.join(&x, &long_shot(), USDC, 0, s).unwrap();
        assert_eq!(env.round_ticket(&t).round, 1);
    }

    /// Spec 08 §13.10 point 3: each ticket counts its liability against its
    /// own cap, the one admission applied at its join; a low-margin ticket
    /// uses more room and leaves the others' usage unchanged.
    #[test]
    fn each_ticket_is_measured_against_its_own_cap() {
        let mut env = setup();
        let p = env.user(30 * USDC);
        let mut total = 0u64;
        for (table, price, app) in [
            (coin_flip(), 2 * USDC, 0u64),
            (slot_classic(), 3 * USDC, 100),
            (coin_flip(), USDC, 80),
        ] {
            let v = env.vault();
            let margin = fade_math::payout_table::margin_bps(
                fade_math::payout_table::validate(
                    &table
                        .iter()
                        .map(|o| fade_math::payout_table::Outcome { p: o.p, m: o.m })
                        .collect::<Vec<_>>(),
                )
                .unwrap()
                .lhs,
            )
            .unwrap();
            let cap = fade_math::risk::per_ticket_cap(
                &v.math(),
                margin - 20 - app,
                &env.config().params.to_math(),
                false,
            )
            .unwrap();
            let (_, meta) = env.join(&p, &table, price, app, 0).unwrap();
            let e = &events::<TicketJoined>(&meta)[0];
            assert_eq!(
                e.cap, cap,
                "its own vault margin, the free balance before it"
            );
            assert_eq!(
                u128::from(e.usage),
                (u128::from(e.reserved_liability) * SCALE).div_ceil(u128::from(cap))
            );
            total += e.usage;
            assert_eq!(env.round(1).usage, total, "earlier usages unchanged");
        }
    }

    /// A drawdown aftermath halves every joining ticket's cap, so it uses
    /// twice the room (Spec 08 §13.7, the breakers).
    #[test]
    fn the_drawdown_aftermath_halves_the_cap() {
        let mut env = setup();
        let now = env.now();
        env.set_vault(|v| v.drawdown_trip_ts = now - 3_600);
        let v = env.vault();
        let full =
            fade_math::risk::per_ticket_cap(&v.math(), 180, &env.config().params.to_math(), false)
                .unwrap();
        let p = env.user(10 * USDC);
        let (_, meta) = env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!(events::<TicketJoined>(&meta)[0].cap, full / 2);
    }

    // --- every check, in order ------------------------------------------------------------------

    fn with_remaining(env: &Env, j: &JoinArgs) -> Instruction {
        let mut ix = env.join_round_ix(j);
        ix.accounts
            .push(solana_instruction::AccountMeta::new_readonly(
                Address::new_unique(),
                false,
            ));
        ix
    }

    /// Check 1: Remaining accounts, before anything else.
    #[test]
    fn check_1_remaining_accounts() {
        let mut env = setup();
        env.set_pause_flags(&env.guardian.insecure_clone(), Config::PAUSE_ALL, None)
            .unwrap();
        let p = env.user(10 * USDC);
        let j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        let ix = with_remaining(&env, &j);
        assert_fails_with(send(&mut env, ix, &p), FadeError::RemainingAccounts);
    }

    /// Check 2: `PAUSE_TICKETS` stops both paths, `PAUSE_ROUNDS` the beacon alone;
    /// either is checked before the integrator.
    #[test]
    fn check_2_pauses() {
        let mut env = setup();
        let guardian = env.guardian.insecure_clone();
        let council = env.council.insecure_clone();
        let p = env.user(30 * USDC);
        for flag in [Config::PAUSE_TICKETS, Config::PAUSE_ROUNDS] {
            env.set_pause_flags(&guardian, flag, None).unwrap();
            let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
            j.nonce = 9; // a later check would fail too
            refused_with(&mut env, &p, &j, FadeError::Paused);
            env.set_pause_flags(&council, 0, None).unwrap();
        }
        // PAUSE_ROUNDS leaves the direct path open.
        env.set_pause_flags(&guardian, Config::PAUSE_ROUNDS, None)
            .unwrap();
        env.open_direct(&p, 8 * USDC, &coin_flip(), 0).unwrap();
        // Deposits are not tickets.
        env.set_pause_flags(&council, Config::PAUSE_DEPOSITS, None)
            .unwrap();
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
    }

    /// Check 3: The integrator: a new record under `PAUSE_NEW_INTEGRATORS`, then its
    /// share account, then the integrator's own pause, then the nonce.
    #[test]
    fn check_3_the_integrator() {
        let mut env = setup();
        let guardian = env.guardian.insecure_clone();
        let council = env.council.insecure_clone();
        let p = env.user(30 * USDC);
        let integrator = env.integrator_address(&p.key());

        env.set_pause_flags(&guardian, Config::PAUSE_NEW_INTEGRATORS, None)
            .unwrap();
        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        j.share_account = None;
        refused_with(&mut env, &p, &j, FadeError::Paused);
        env.set_pause_flags(&council, 0, None).unwrap();
        refused_with(&mut env, &p, &j, FadeError::ShareAccountRequired);
        assert!(!env.exists(&integrator));

        // Not a usable USDC account: another mint, a system account, frozen.
        let other_mint = Address::new_unique();
        fade_testkit::token::write_mint(&mut env.svm, other_mint, &Address::new_unique(), 6);
        let foreign = Address::new_unique();
        fade_testkit::token::write_token_account(&mut env.svm, foreign, &other_mint, &p.key(), 0);
        let frozen = env.usdc_account(&p.key(), 0);
        env.set_token_state(&frozen, 2);
        let mut bad_order = j.clone();
        bad_order.nonce = 5;
        for bad in [foreign, p.key(), frozen] {
            j.share_account = Some(bad);
            refused_with(&mut env, &p, &j, FadeError::WrongMint);
            bad_order.share_account = Some(bad);
            refused_with(&mut env, &p, &bad_order, FadeError::WrongMint);
        }
        assert!(!env.exists(&integrator));

        // An existing integrator, paused: before the nonce.
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        env.set_pause_flags(&guardian, 0, Some((integrator, true)))
            .unwrap();
        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        j.nonce = 7;
        refused_with(&mut env, &p, &j, FadeError::IntegratorPaused);
        env.set_pause_flags(&council, 0, Some((integrator, false)))
            .unwrap();
        // The nonce, before the payout table.
        j.app_share_bps = 10_000;
        refused_with(&mut env, &p, &j, FadeError::WrongNonce);
        // A nonce used already: its ticket address exists, Anchor's `init`
        // refuses it (the System program's AccountAlreadyInUse).
        j.nonce = 0;
        j.app_share_bps = 0;
        refused(&mut env, &p, &j, |f| f.has_code(0));
    }

    /// Check 4: The payout table: its address against its stored hash, then the
    /// split, then the floor; all before the round is resolved.
    #[test]
    fn check_4_the_payout_table() {
        let mut env = setup();
        let p = env.user(30 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();

        // A Fade-owned PayoutTable at an address that is not its hash's.
        let real: PayoutTable = env.read(&env.payout_table_address(&coin_flip()));
        let forged = Address::new_unique();
        let mut data = Vec::new();
        real.try_serialize(&mut data).unwrap();
        let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
        env.svm
            .set_account(
                forged,
                Account {
                    lamports,
                    data,
                    owner: fade_id(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        j.payout_table = forged;
        j.round = Address::new_unique(); // resolution would fail too
        refused_with(&mut env, &p, &j, FadeError::WrongPayoutTable);
        // A table owned by another program, or not a table: Anchor's checks.
        j.payout_table = env.a.config;
        refused_anchor(&mut env, &p, &j, 3002); // AccountDiscriminatorMismatch
        j.payout_table = env.treasury;
        refused_anchor(&mut env, &p, &j, 3007); // AccountOwnedByWrongProgram

        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 501, 0);
        j.round = Address::new_unique();
        refused_with(&mut env, &p, &j, FadeError::AppShareTooHigh);
        // 200 bps − 20 − 81 = 99 < 100
        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 81, 0);
        j.round = Address::new_unique();
        refused_with(&mut env, &p, &j, FadeError::MarginFloor);
        let mut j = JoinArgs::direct(&env, &p, &thin(), USDC, 0, 0);
        j.round = Address::new_unique();
        refused_with(&mut env, &p, &j, FadeError::MarginFloor);
        // 200 − 20 − 80 = 100: at the floor, accepted.
        env.join(&p, &coin_flip(), USDC, 80, 0).unwrap();
    }

    /// Check 5: Round resolution, before the drawdown ring; creating a round reads
    /// ORAO's network state, which joining one does not.
    #[test]
    fn check_5_round_resolution() {
        let mut env = setup();
        let p = env.user(30 * USDC);
        trip(&mut env);
        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        j.round = Address::new_unique();
        j.next_round = Address::new_unique();
        refused_with(&mut env, &p, &j, FadeError::WrongRound);

        // ORAO's network state, owned by someone else, only when creating.
        let mut env = setup();
        let p = env.user(30 * USDC);
        let mut ns = env.svm.get_account(&env.a.network_state).unwrap();
        let good = ns.clone();
        ns.owner = addr(anchor_spl::token::ID);
        env.svm.set_account(env.a.network_state, ns).unwrap();
        trip(&mut env);
        let j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::NetworkStateUnreadable);
        untrip(&mut env);
        refused_with(&mut env, &p, &j, FadeError::NetworkStateUnreadable);
        env.svm
            .set_account(env.a.network_state, good.clone())
            .unwrap();
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        // Joining an existing round reads it too (its draw must still fit).
        let mut ns = good;
        ns.owner = addr(anchor_spl::token::ID);
        env.svm.set_account(env.a.network_state, ns).unwrap();
        let j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::NetworkStateUnreadable);
        assert_eq!(env.round(1).tickets, 1);
    }

    /// Sets the fee in the stand-in for ORAO's network state (after the
    /// discriminator, the authority and the treasury).
    fn set_orao_fee(env: &mut Env, fee: u64) {
        env.set_orao_fee(fee);
    }

    /// Check 5: a round whose draw no longer fits its prefund (ORAO's fee rose
    /// by more than one fee since its creation) takes no join, accepting or
    /// paid: `request_round_draw` would refuse it with `DrawUnderfunded`
    /// against the same `draw_max`, so the tickets could only forfeit. The
    /// refusal comes before the drawdown ring; the round stays as it was, and
    /// takes joins again once the fee falls back within the margin.
    #[test]
    fn a_round_whose_draw_no_longer_fits_takes_no_join() {
        let mut env = setup();
        let p = env.user(60 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let draw_max = env.round(1).draw_max;
        assert_eq!(draw_max, env.draw_max());

        // One lamport beyond the margin: refused, before the drawdown ring.
        set_orao_fee(&mut env, 2 * ORAO_FEE + 1);
        trip(&mut env);
        let j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::DrawUnderfunded);
        untrip(&mut env);
        refused_with(&mut env, &p, &j, FadeError::DrawUnderfunded);
        // A sponsored join cannot rescue it either: the request compares the
        // live cost with `draw_max`, not with the lamports the round holds.
        let j = JoinArgs::direct(&env, &p, &coin_flip(), 9 * USDC, 0, 10 * ORAO_FEE);
        refused_with(&mut env, &p, &j, FadeError::DrawUnderfunded);
        assert_eq!(env.round(1).tickets, 1, "the round is unchanged");

        // At exactly the margin the draw still fits: the join lands, and pays.
        set_orao_fee(&mut env, 2 * ORAO_FEE);
        env.join(&p, &coin_flip(), 9 * USDC, 0, 0).unwrap();
        let paid = env.round(1);
        assert_eq!((paid.tickets, paid.status), (2, RoundStatus::Paid));

        // A paid round still accepting joins is refused the same way.
        set_orao_fee(&mut env, 2 * ORAO_FEE + 1);
        let j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::DrawUnderfunded);
        assert_eq!(env.round(1).prices, paid.prices);

        // The next round snapshots the new fee: it takes joins at it.
        to_close(&mut env, 1);
        let (_, meta) = env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let opened = &events::<RoundOpened>(&meta)[0];
        assert_eq!(opened.id, 2);
        assert_eq!(
            opened.draw_max,
            draw_max + 2 * (ORAO_FEE + 1),
            "the snapshot takes the live fee"
        );
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!(env.round(2).tickets, 2);
    }

    /// Trips the drawdown breaker: the 24-hour high far above the price.
    fn trip(env: &mut Env) {
        let price = env.vault().settled_price().unwrap();
        let hour = env.now().div_euclid(3_600);
        env.set_vault(|v| {
            v.price_maxima = [price * 2; 24];
            v.price_head_hour = hour;
        });
    }
    fn untrip(env: &mut Env) {
        env.set_vault(|v| v.price_maxima = [0; 24]);
    }

    /// Check 6: The drawdown ring, before admission.
    #[test]
    fn check_6_the_drawdown_breaker() {
        let mut env = setup();
        let p = env.user(30 * USDC);
        trip(&mut env);
        let j = JoinArgs::direct(&env, &p, &coin_flip(), 1, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::DrawdownBreaker);
        untrip(&mut env);
        refused_with(&mut env, &p, &j, FadeError::PriceBounds);
    }

    /// Check 7: Admission against the round's minimum ticket price, not the direct
    /// path's; the per-ticket cap before the capacity rule.
    #[test]
    fn check_7_admission() {
        let mut env = setup();
        let p = env.user(30 * USDC);
        let min = env.config().params.beacon_min_price;
        let j = JoinArgs::direct(&env, &p, &coin_flip(), min - 1, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::PriceBounds);
        let max = env.config().params.max_price;
        let j = JoinArgs::direct(&env, &p, &coin_flip(), max + 1, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::PriceBounds);
        // 2 USDC at 1 000×: 1 998 USDC of liability over a 1 400 USDC cap,
        // and over capacity too: the cap is reported.
        let j = JoinArgs::direct(&env, &p, &long_shot(), 2 * USDC, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::PerTicketCap);
        // At the round's minimum, far below the direct path's 7.5 USDC.
        env.join(&p, &coin_flip(), min, 0, 0).unwrap();
        assert!(min < env.config().params.min_price);
    }

    /// Check 7: The integrator ceiling counts both paths.
    #[test]
    fn check_7_the_integrator_ceiling_counts_both_paths() {
        let mut env = setup();
        let p = env.user(30 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let ceiling = env.vault().total_assets * 2_000 / 10_000;
        let integrator = env.integrator_address(&p.key());
        let mut acc = env.svm.get_account(&integrator).unwrap();
        let mut i = Integrator::try_deserialize(&mut acc.data.as_slice()).unwrap();
        i.reserved_liability = ceiling - 100_000; // as if direct tickets held it
        let mut data = Vec::new();
        i.try_serialize(&mut data).unwrap();
        acc.data[..data.len()].copy_from_slice(&data);
        env.svm.set_account(integrator, acc).unwrap();
        let j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::IntegratorCap);
    }

    /// Check 8: The capacity rule, last.
    #[test]
    fn check_8_capacity_is_last() {
        let mut env = setup();
        let p = env.user(30 * USDC);
        let j = JoinArgs::direct(&env, &p, &long_shot(), USDC, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::RoundCapacity);
    }

    /// A join that creates the integrator and the round and is refused leaves
    /// neither behind; the payer is charged nothing.
    #[test]
    fn a_refused_join_moves_nothing() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        for (table, price, s, e) in [
            (long_shot(), USDC, 0, FadeError::RoundCapacity),
            (long_shot(), 3 * USDC, 1_000_000, FadeError::PerTicketCap),
            (coin_flip(), 1, 0, FadeError::PriceBounds),
        ] {
            let j = JoinArgs::direct(&env, &p, &table, price, 0, s);
            refused_with(&mut env, &p, &j, e);
            assert!(!env.exists(&env.integrator_address(&p.key())));
            assert!(!env.exists(&round_address(1)));
            assert!(!env.exists(&sponsorship_address(&round_address(1), &p.key())));
        }
        // And in an existing round.
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let j = JoinArgs::direct(&env, &p, &long_shot(), USDC, 0, 1_000);
        refused_with(&mut env, &p, &j, FadeError::RoundCapacity);
        // A funder short of the ticket price: the token program refuses.
        let j = JoinArgs::direct(&env, &p, &coin_flip(), 100 * USDC, 0, 0);
        refused(&mut env, &p, &j, |f| f.err.contains("Custom(1)"));
    }

    // --- state guards -------------------------------------------------------------------------

    /// Spec 08 §13.9: a pre-funded round or sponsorship address is created over.
    #[test]
    fn pre_funded_addresses_are_created_over() {
        for pre in [1u64, 1_000_000, 50_000_000] {
            let mut env = setup();
            let p = env.user(10 * USDC);
            let round1 = round_address(1);
            let record = sponsorship_address(&round1, &p.key());
            for a in [round1, record] {
                env.svm
                    .set_account(
                        a,
                        Account {
                            lamports: pre,
                            data: vec![],
                            owner: system_id(),
                            executable: false,
                            rent_epoch: 0,
                        },
                    )
                    .unwrap();
            }
            let p0 = env.lamports(&p.key());
            let prepay = beacon::prepay(&spec_terms(&env), USDC).unwrap();
            let (_, meta) = env.join(&p, &coin_flip(), USDC, 0, 1_000).unwrap();
            let rr = rent(&env, ROUND_LEN);
            let sr = rent(&env, SPONSORSHIP_LEN);
            assert_eq!(env.lamports(&round1), rr.max(pre) + prepay + 1_000);
            assert_eq!(env.lamports(&record), sr.max(pre));
            assert_eq!(env.round(1).tickets, 1);
            assert_eq!(env.read::<Sponsorship>(&record).amount, 1_000);
            assert_eq!(
                env.lamports(&p.key()),
                p0 - meta.fee
                    - rent(&env, INTEGRATOR_LEN)
                    - rent(&env, TICKET_LEN)
                    - rr.saturating_sub(pre)
                    - sr.saturating_sub(pre)
                    - prepay
                    - 1_000
                    - 20_000,
                "the payer tops up to the rent, never more"
            );
        }
    }

    /// The round to create must be a system account: one another program
    /// owns is refused.
    #[test]
    fn a_round_address_owned_elsewhere_is_refused() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.svm
            .set_account(
                round_address(1),
                Account {
                    lamports: 1_000_000,
                    data: vec![0; 8],
                    owner: addr(anchor_spl::token::ID),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::WrongRound);
    }

    /// A vault whose
    /// `next_round_id` was never initialised creates no round; inconsistent
    /// ids are refused.
    #[test]
    fn inconsistent_round_ids_fail_closed() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.set_vault(|v| v.next_round_id = 0);
        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        j.round = round_address(0);
        j.next_round = round_address(1);
        refused_with(&mut env, &p, &j, FadeError::WrongRound);
        env.set_vault(|v| {
            v.accepting_round = 4;
            v.next_round_id = 4;
        });
        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        j.round = round_address(4);
        j.next_round = round_address(5);
        refused_with(&mut env, &p, &j, FadeError::WrongRound);
    }

    /// An accepting round the program no longer owns has closed: the join
    /// opens the next round, whatever lamports were sent to the old address.
    #[test]
    fn a_closed_accepting_round_opens_the_next() {
        for lamports in [0u64, 1_000_000] {
            let mut env = setup();
            pay_round(&mut env);
            // As a closed round leaves it: empty, system-owned.
            env.svm
                .set_account(
                    round_address(1),
                    Account {
                        lamports,
                        data: vec![],
                        owner: system_id(),
                        executable: false,
                        rent_epoch: 0,
                    },
                )
                .unwrap();
            let p = env.user(10 * USDC);
            let j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
            assert_eq!(
                (j.round, j.next_round),
                (round_address(1), round_address(2))
            );
            join_with(&mut env, &j, &p).unwrap();
            assert_eq!(env.vault().accepting_round, 2);
        }
    }

    /// A Round at the accepting address with another id cannot exist; if it
    /// did, it would be refused, never joined.
    #[test]
    fn the_accepting_round_must_hold_its_id() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let mut acc = env.svm.get_account(&round_address(1)).unwrap();
        acc.data[12] = 9; // id: after the discriminator, version, bump, vrf_bump, status
        env.svm.set_account(round_address(1), acc).unwrap();
        let j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::WrongRound);
    }

    /// A governance change after a round's creation reaches only the rounds
    /// created after it (Spec 09 §3): a tightening applied at once, and a
    /// change of the settlement share, which waits 24 hours.
    #[test]
    fn a_round_keeps_its_snapshot() {
        let mut env = setup();
        let p = env.user(30 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let old = env.round(1);
        let mut params = env.config().params;
        params.beacon_min_price = 700_000;
        params.beacon_threshold = 10_000_000;
        params.tick_slots = 40;
        params.refund_slots = 2_000;
        params.crank_round_settle_lamports = 15_000;
        env.set_params(params).unwrap();
        env.advance(1, fade::DELAY_24H + 1);
        env.apply_params().unwrap();
        assert_eq!(env.config().params, params);
        // The open round still takes 0.50 USDC, prepays at 8.64 USDC and
        // keeps its settlement share.
        let (t, _) = env.join(&p, &coin_flip(), 500_000, 0, 0).unwrap();
        let t = env.round_ticket(&t);
        assert_eq!(t.prepay, beacon::prepay(&old.terms(), 500_000).unwrap());
        assert_eq!(t.settle_share, 20_000);
        let r = env.round(1);
        assert_eq!(
            (
                r.threshold,
                r.min_price,
                r.tick_slots,
                r.refund_slots,
                r.settle_share
            ),
            (8_640_000, 500_000, 37, 1_715, 20_000)
        );
        assert_eq!(r.draw_max, old.draw_max);
        pay_round(&mut env);
        assert_eq!(env.round(1).close_slot % 37, 0, "the round's own tick");
        to_close(&mut env, 1);
        let j = JoinArgs::direct(&env, &p, &coin_flip(), 600_000, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::PriceBounds);
        let (t2, _) = env.join(&p, &coin_flip(), 700_000, 0, 0).unwrap();
        let r2 = env.round(2);
        assert_eq!(
            (
                r2.threshold,
                r2.min_price,
                r2.tick_slots,
                r2.refund_slots,
                r2.settle_share
            ),
            (10_000_000, 700_000, 40, 2_000, 15_000)
        );
        let t2 = env.round_ticket(&t2);
        assert_eq!(t2.settle_share, 15_000);
        assert_eq!(t2.prepay, beacon::prepay(&r2.terms(), 700_000).unwrap());
        assert_eq!(
            env.lamports(&env.round_ticket_address(&p.key(), t2.nonce)),
            rent(&env, TICKET_LEN) + 15_000
        );
    }

    /// Check 5 compares the live draw with the round's snapshot
    /// `request_share`, the one `request_round_draw` charges, not the live
    /// parameter: after governance lowers `crank_request_lamports`, a fee
    /// the live share would still fit is refused, since the request would
    /// refuse the round. `t_settle_slots` and `drawdown_bps` keep their
    /// creation values too; the next round takes the new ones.
    #[test]
    fn the_draw_check_uses_the_rounds_request_share() {
        let mut env = setup();
        let p = env.user(60 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let old = env.round(1);
        assert_eq!(
            (old.request_share, old.t_settle_slots, old.drawdown_bps),
            (50_000, 150, 1_500)
        );
        // Three tightenings, applied at once.
        let mut params = env.config().params;
        params.crank_request_lamports = 10_000;
        params.t_settle_slots = 200;
        params.drawdown_bps = 1_000;
        env.set_params(params).unwrap();
        assert!(!env.config().pending.active);
        assert_eq!(env.config().params, params);
        let r = env.round(1);
        assert_eq!(
            (
                r.request_share,
                r.t_settle_slots,
                r.drawdown_bps,
                r.draw_max
            ),
            (50_000, 150, 1_500, old.draw_max)
        );

        // One lamport beyond the margin at the snapshot share, 39 999 within
        // it at the live one: the snapshot decides.
        let pending_rent = rent(&env, fade_math::orao_layout::PENDING_LEN);
        let fee = 2 * ORAO_FEE + 1;
        assert!(!beacon::request_fits(
            fee,
            pending_rent,
            r.request_share,
            r.draw_max
        ));
        assert!(beacon::request_fits(
            fee,
            pending_rent,
            params.crank_request_lamports,
            r.draw_max
        ));
        set_orao_fee(&mut env, fee);
        let j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::DrawUnderfunded);
        set_orao_fee(&mut env, 2 * ORAO_FEE);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!(env.round(1).tickets, 2);

        // The next round snapshots the new parameters.
        set_orao_fee(&mut env, ORAO_FEE);
        pay_round(&mut env);
        to_close(&mut env, 1);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let r2 = env.round(2);
        assert_eq!(
            (r2.request_share, r2.t_settle_slots, r2.drawdown_bps),
            (10_000, 200, 1_000)
        );
        assert_eq!(r2.draw_max, env.draw_max());
        assert_eq!(r2.draw_max + 40_000, old.draw_max);
    }

    /// `initialize` leaves the beacon paused (`PAUSE_ROUNDS`): no join lands
    /// until the council turns it on, so a binary deployed before the
    /// instructions that end a round cannot lock a player's funds or the
    /// vault's reservation. The guardian cannot turn it on; the direct path
    /// stays open meanwhile.
    #[test]
    fn a_fresh_config_takes_no_join_until_the_council_enables_the_beacon() {
        let mut env = Env::bare();
        env.initialize(RiskParams::SPEC).unwrap();
        assert_eq!(env.config().pause_flags, Config::PAUSE_ROUNDS);
        env.found(VAULT);
        let k = env.keeper.insecure_clone();
        env.register_payout_table(&k, &coin_flip()).unwrap();
        let p = env.user(60 * USDC);
        let j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        refused_with(&mut env, &p, &j, FadeError::Paused);
        env.open_direct(&p, 25 * USDC, &coin_flip(), 0).unwrap();

        let guardian = env.guardian.insecure_clone();
        assert_fails_with(
            env.set_pause_flags(&guardian, 0, None),
            FadeError::GuardianCannotUnpause,
        );
        let council = env.council.insecure_clone();
        env.set_pause_flags(&council, 0, None).unwrap();
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!(env.round(1).tickets, 1);
    }

    /// One nonce sequence per integrator across both paths.
    #[test]
    fn the_nonce_is_shared_with_the_direct_path() {
        let mut env = setup();
        let p = env.user(30 * USDC);
        let direct = env.open_direct(&p, 8 * USDC, &coin_flip(), 0).unwrap();
        let (beacon_ticket, _) = env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!(env.ticket(&direct).nonce, 0);
        assert_eq!(env.round_ticket(&beacon_ticket).nonce, 1);
        let i = env.integrator(&p.key());
        assert_eq!((i.next_nonce, i.open_tickets), (2, 2));
        assert_eq!(
            i.volume_total,
            8 * USDC,
            "only the direct ticket's volume, at open"
        );
    }

    /// A ticket that cannot be refunded fully would break Spec 08 §13.8
    /// invariant 5: the shares a join holds are exactly its price's.
    #[test]
    fn the_vault_identity_holds_over_many_joins() {
        let mut env = setup();
        let p = env.user(1_000 * USDC);
        let v0 = env.vault();
        let u0 = env.balance(&env.a.vault_usdc);
        let mut prices = 0;
        for (i, price) in [500_000u64, 777_777, 1_000_001, 3_333_333, 9_999_999]
            .iter()
            .enumerate()
        {
            env.join(&p, &slot_classic(), *price, (i as u64) * 37, 0)
                .unwrap();
            prices += price;
            let v = env.vault();
            let r = env.round(env.vault().accepting_round);
            let _ = r;
            assert_eq!(
                env.balance(&env.a.vault_usdc) - u0,
                (v.total_assets - v0.total_assets) + v.beacon_shares_held,
                "every micro-USDC of every price is the vault's credit or a held share"
            );
        }
        assert_eq!(env.balance(&env.a.vault_usdc) - u0, prices);
    }

    // --- Anchor's account checks ----------------------------------------------------------------

    #[test]
    fn the_accounts_are_checked() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        let other = env.user(10 * USDC);
        // The funder's USDC account must be the funder's.
        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        j.funder_usdc = other.usdc;
        refused_anchor(&mut env, &p, &j, 2015); // ConstraintTokenOwner
                                                // The ticket at another nonce's address.
        let j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        let mut ix = env.join_round_ix(&j);
        ix.accounts[11].pubkey = env.round_ticket_address(&p.key(), 1);
        let watched = touched(&env, &p, &j);
        let before = snapshot(&env, &watched);
        let r = send(&mut env, ix, &p);
        assert!(
            r.unwrap_err().err.contains("Custom(2006)"),
            "ConstraintSeeds"
        );
        assert_eq!(snapshot(&env, &watched), before);
        // The beneficiary must be a USDC account.
        let mut j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        let other_mint = Address::new_unique();
        fade_testkit::token::write_mint(&mut env.svm, other_mint, &Address::new_unique(), 6);
        let foreign = Address::new_unique();
        fade_testkit::token::write_token_account(&mut env.svm, foreign, &other_mint, &p.key(), 0);
        j.beneficiary = foreign;
        refused_anchor(&mut env, &p, &j, 2014); // ConstraintTokenMint
                                                // The funder must sign.
        let j = JoinArgs::direct(&env, &p, &coin_flip(), USDC, 0, 0);
        let mut ix = env.join_round_ix(&j);
        ix.accounts[2].pubkey = other.key();
        ix.accounts[3].pubkey = other.usdc;
        ix.accounts[2].is_signer = false;
        let keeper = env.keeper.insecure_clone();
        let kp = p.kp.insecure_clone();
        let r = env.send(&[ix], &[&keeper, &kp]);
        assert!(
            r.unwrap_err().err.contains("Custom(3010)"),
            "AccountNotSigner"
        );
        assert_eq!(env.balance(&other.usdc), 10 * USDC);
    }

    // --- measurements --------------------------------------------------------------------------

    fn tx_len(env: &Env, ix: &Instruction, signers: &[&Keypair]) -> usize {
        let tx = solana_transaction::Transaction::new_signed_with_payer(
            std::slice::from_ref(ix),
            Some(&signers[0].pubkey()),
            signers,
            env.svm.latest_blockhash(),
        );
        1 + 64 * tx.signatures.len() + tx.message_data().len()
    }

    /// Compute units and transaction sizes of `join_round` (Spec 08 §13.5.2
    /// estimates 50 000 units, 60 000 creating a round, 900 to 1 000 bytes).
    #[test]
    fn compute_units_and_sizes() {
        let mut env = setup();
        let app = env.user(0);
        let payer = env.user(0);
        let funder = env.user(100 * USDC);
        let kps = [
            app.kp.insecure_clone(),
            payer.kp.insecure_clone(),
            funder.kp.insecure_clone(),
        ];
        let run = |env: &mut Env, sponsorship: u64, label: &str| {
            let mut j = JoinArgs::direct(env, &funder, &coin_flip(), USDC, 50, sponsorship);
            j.authority = app.key();
            j.payer = payer.key();
            j.share_account = Some(app.usdc);
            j.nonce = env.next_nonce(&app.key());
            j.sponsorship_record = (sponsorship > 0)
                .then(|| sponsorship_address(&round_address(env.joining_round()), &payer.key()));
            let ix = env.join_round_ix(&j);
            let size = tx_len(env, &ix, &[&kps[1], &kps[0], &kps[2]]);
            let meta = env.send(&[ix], &[&kps[1], &kps[0], &kps[2]]).unwrap();
            eprintln!(
                "CU join_round ({label}): {}; {size}-byte transaction, three signers",
                meta.compute_units_consumed
            );
            assert!(size <= 1_232);
            assert!(meta.compute_units_consumed < 200_000);
            meta.compute_units_consumed
        };
        run(&mut env, 0, "creating the integrator and the round");
        run(&mut env, 0, "into an existing round");
        run(
            &mut env,
            1_000,
            "into an existing round, creating a sponsorship",
        );
        run(
            &mut env,
            1_000,
            "into an existing round, topping a sponsorship up",
        );
        pay_round(&mut env);
        to_close(&mut env, 1);
        let s = beacon::sponsorship_to_pay(&spec_terms(&env), USDC, 0).unwrap();
        run(
            &mut env,
            s,
            "a lone ticket: creating the round and its sponsorship, paid",
        );
        eprintln!(
            "rents in the test runtime: Round {}, RoundTicket {}, Sponsorship {}; D_r {}",
            rent(&env, ROUND_LEN),
            rent(&env, TICKET_LEN),
            rent(&env, SPONSORSHIP_LEN),
            env.draw_max()
        );
    }
}

/// `sponsor_round` and `reclaim_sponsorship` (Spec 08 §13.5.3, §13.5.10).
/// The instructions that move a round to `Requested`,
/// `Drawn`, `Refunded` or `Forfeited`, and that settle or return its tickets,
/// are steps 7 to 9: until then the tests write those states with
/// `Env::set_round`, moving the round's lamports exactly as §13.5.5 to
/// §13.5.9 say those instructions will (`draw`, `forfeit`, `refund`,
/// `release`).
mod sponsorship {
    use super::*;
    use anchor_lang::AccountSerialize;
    use fade::events::{RoundClosed, RoundPaid, RoundSponsored, SponsorshipReclaimed};
    use fade::state::{Outcome, RoundStatus, Sponsorship};
    use fade_math::{beacon, orao_layout};
    use litesvm::types::TransactionMetadata;
    use solana_account::Account;
    use solana_address::Address;
    use solana_instruction::Instruction;
    use solana_keypair::Keypair;
    use solana_signer::Signer;

    const VAULT: u64 = 100_000 * USDC;
    const ROUND_LEN: usize = 411;
    const SPONSORSHIP_LEN: usize = 58;

    /// 1 000× with probability 0.097 %: a 300 bps margin.
    fn long_shot() -> Vec<Outcome> {
        vec![
            Outcome {
                p: 970_000,
                m: 10_000_000,
            },
            Outcome {
                p: 1_000_000_000 - 970_000,
                m: 0,
            },
        ]
    }

    fn setup() -> Env {
        let mut env = Env::new();
        env.found(VAULT);
        let k = env.keeper.insecure_clone();
        for t in [coin_flip(), long_shot()] {
            env.register_payout_table(&k, &t).unwrap();
        }
        env
    }

    fn rent(env: &Env, len: usize) -> u64 {
        env.svm.minimum_balance_for_rent_exemption(len)
    }

    fn pending_rent(env: &Env) -> u64 {
        rent(env, orao_layout::PENDING_LEN)
    }

    /// What ORAO gives back at fulfilment: the pending request's rent above
    /// the fulfilled account's.
    fn orao_refund(env: &Env) -> u64 {
        pending_rent(env) - rent(env, orao_layout::FULFILLED_LEN)
    }

    fn funded_sponsor(env: &mut Env) -> Keypair {
        let kp = Keypair::new();
        env.svm.airdrop(&kp.pubkey(), 100_000_000_000).unwrap();
        kp
    }

    fn record_of(id: u64, sponsor: &Address) -> Address {
        sponsorship_address(&round_address(id), sponsor)
    }

    fn set_lamports(env: &mut Env, address: &Address, lamports: u64) {
        let mut acc = env.svm.get_account(address).unwrap();
        acc.lamports = lamports;
        env.svm.set_account(*address, acc).unwrap();
    }

    fn set_orao_fee(env: &mut Env, fee: u64) {
        env.set_orao_fee(fee);
    }

    fn set_status(env: &mut Env, id: u64, status: RoundStatus) {
        env.set_round(id, None, |r| r.status = status);
    }

    // --- the ends of a round, as steps 7 to 9 will write them -------------------------

    /// `request_round_draw` then the first `settle_round_tickets`: ORAO's fee
    /// and the pending rent to `round_vrf`, the request share to the
    /// requester, `refund` drained back; `C` fixed (§13.4). Returns `C`.
    fn draw(env: &mut Env, id: u64, refund: u64) -> u64 {
        let r = env.round(id);
        let funded = ORAO_FEE + pending_rent(env);
        let c = beacon::draw_cost(funded, r.request_share, refund).unwrap();
        let lamports = env.lamports(&round_address(id)) - funded - r.request_share + refund;
        env.set_round(id, Some(lamports), |r| {
            r.status = RoundStatus::Drawn;
            r.funded = funded;
            r.draw_cost = c;
        });
        c
    }

    /// `draw` with ORAO's refund of a fulfilled request.
    fn fulfilled(env: &mut Env, id: u64) -> u64 {
        let refund = orao_refund(env);
        draw(env, id, refund)
    }

    /// `expire_round`: requested and unfulfilled, the request's whole cost is
    /// the draw cost (nothing came back); never requested, nothing was spent.
    fn forfeit(env: &mut Env, id: u64, requested: bool) -> u64 {
        if !requested {
            set_status(env, id, RoundStatus::Forfeited);
            return 0;
        }
        let c = draw(env, id, 0);
        set_status(env, id, RoundStatus::Forfeited);
        c
    }

    /// `refund_round`: no lamport moves.
    fn refund(env: &mut Env, id: u64) {
        set_status(env, id, RoundStatus::Refunded);
    }

    /// Settles or returns `tickets` as steps 8 and 9 will: `prepay − charge`
    /// from the round to each payer (no charge after a refund), `prepaid` and
    /// `tickets` down. Returns the lamports the payers got back.
    fn release(env: &mut Env, id: u64, tickets: &[Address]) -> u64 {
        let mut total = 0;
        for t in tickets {
            let tk = env.round_ticket(t);
            let r = env.round(id);
            let charge = if r.status == RoundStatus::Refunded {
                0
            } else {
                beacon::charge(r.draw_cost, r.sponsorship, r.prices, tk.price).unwrap()
            };
            assert!(
                charge <= tk.prepay,
                "fact 1: no ticket charged above its prepay"
            );
            let back = tk.prepay - charge;
            let lamports = env.lamports(&round_address(id)) - back;
            env.set_round(id, Some(lamports), |r| {
                r.prepaid -= tk.prepay;
                r.tickets -= 1;
            });
            let payer = addr(tk.payer);
            let l = env.lamports(&payer);
            set_lamports(env, &payer, l + back);
            total += back;
        }
        total
    }

    /// Reclaims `sponsor`'s record of round `id` and checks, to the lamport,
    /// that the sponsor got `expected` and the record's lamports, the record
    /// is gone, the round lost exactly `expected` and one sponsor, and the
    /// event says so. Returns the transaction.
    #[track_caller]
    fn reclaimed(env: &mut Env, id: u64, sponsor: &Address, expected: u64) -> TransactionMetadata {
        let record = record_of(id, sponsor);
        let record_lamports = env.lamports(&record);
        let s0 = env.lamports(sponsor);
        let r0 = env.lamports(&round_address(id));
        let before = env.round(id);
        let meta = env.reclaim(id, sponsor).unwrap();
        assert!(!env.exists(&record), "the record is closed");
        let closed = events::<RoundClosed>(&meta);
        if closed.is_empty() {
            assert_eq!(env.lamports(sponsor), s0 + expected + record_lamports);
            assert_eq!(env.lamports(&round_address(id)), r0 - expected);
            let after = env.round(id);
            assert_eq!(after.sponsors, before.sponsors - 1);
            assert_eq!(
                (after.sponsorship, after.draw_cost, after.prepaid),
                (before.sponsorship, before.draw_cost, before.prepaid),
                "S stays the total every sponsor's share is computed on"
            );
        }
        let ev = events::<SponsorshipReclaimed>(&meta);
        assert_eq!(ev.len(), 1);
        assert_eq!(
            (addr(ev[0].round), addr(ev[0].sponsor), ev[0].lamports),
            (round_address(id), *sponsor, expected)
        );
        meta
    }

    /// The sponsor's return of §13.4, computed here from the definition.
    fn share_back(s: u64, c: u64, amount: u64) -> u64 {
        let left = u128::from(s - s.min(c));
        u64::try_from(left * u128::from(amount) / u128::from(s)).unwrap()
    }

    // --- sponsor_round ------------------------------------------------------------------

    /// Partial sponsorship by several sponsors, each with its own record and
    /// a top-up of the first; the last sponsorship pays the round, which
    /// closes at the next tick. Every lamport accounted for.
    #[test]
    fn several_sponsors_pay_a_round() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let a = funded_sponsor(&mut env);
        let b = funded_sponsor(&mut env);
        let c = funded_sponsor(&mut env);
        let round = round_address(1);

        let a0 = env.lamports(&a.pubkey());
        let r0 = env.lamports(&round);
        let meta = env.sponsor(&a, 1, 1_000_000).unwrap();
        assert_eq!(
            env.lamports(&a.pubkey()),
            a0 - meta.fee - rent(&env, SPONSORSHIP_LEN) - 1_000_000
        );
        assert_eq!(env.lamports(&round), r0 + 1_000_000);
        let rec: Sponsorship = env.read(&record_of(1, &a.pubkey()));
        let (_, bump) = Address::find_program_address(
            &[fade::SPONSORSHIP_SEED, round.as_ref(), a.pubkey().as_ref()],
            &fade_id(),
        );
        assert_eq!(
            (
                rec.version,
                rec.bump,
                rec.round,
                addr(rec.sponsor),
                rec.amount
            ),
            (1, bump, 1, a.pubkey(), 1_000_000)
        );
        let acc = env.svm.get_account(&record_of(1, &a.pubkey())).unwrap();
        assert_eq!((acc.owner, acc.data.len()), (fade_id(), SPONSORSHIP_LEN));
        let ev = events::<RoundSponsored>(&meta);
        assert_eq!(ev.len(), 1);
        assert_eq!(
            (
                addr(ev[0].round),
                addr(ev[0].sponsor),
                ev[0].lamports,
                ev[0].total
            ),
            (round, a.pubkey(), 1_000_000, 1_000_000)
        );
        assert!(events::<RoundPaid>(&meta).is_empty());

        // A top-up: the same record, no new sponsor, no new rent.
        let a1 = env.lamports(&a.pubkey());
        let meta = env.sponsor(&a, 1, 7).unwrap();
        assert_eq!(env.lamports(&a.pubkey()), a1 - meta.fee - 7);
        let rec: Sponsorship = env.read(&record_of(1, &a.pubkey()));
        assert_eq!(rec.amount, 1_000_007);
        assert_eq!(events::<RoundSponsored>(&meta)[0].total, 1_000_007);

        env.sponsor(&b, 1, 333_333).unwrap();
        let r = env.round(1);
        assert_eq!(
            (r.status, r.sponsorship, r.sponsors, r.tickets),
            (RoundStatus::Accepting, 1_333_340, 2, 1)
        );

        // The sponsorship that pays the round, one lamport short, then exact.
        let need = beacon::sponsorship_to_pay(&r.terms(), r.prices, r.sponsorship).unwrap();
        env.sponsor(&c, 1, need - 1).unwrap();
        assert_eq!(env.round(1).status, RoundStatus::Accepting);
        let now = env.now();
        env.set_time(5_000, now);
        let meta = env.sponsor(&c, 1, 1).unwrap();
        let r = env.round(1);
        assert_eq!(
            (r.status, r.paid_slot, r.close_slot),
            (RoundStatus::Paid, 5_000, 5_032)
        );
        assert_eq!((r.sponsorship, r.sponsors), (1_333_340 + need, 3));
        assert!(beacon::is_paid(&r.terms(), r.prices, r.sponsorship));
        let paid = events::<RoundPaid>(&meta);
        assert_eq!(paid.len(), 1);
        assert_eq!(
            (
                addr(paid[0].round),
                paid[0].paid_slot,
                paid[0].close_slot,
                paid[0].prices,
                paid[0].sponsorship
            ),
            (round, 5_000, 5_032, USDC, r.sponsorship)
        );
        // Prepay and sponsorship held on the round, nothing else moved.
        let tk = env.round_ticket(&env.round_ticket_address(&p.key(), 0));
        assert_eq!(
            env.lamports(&round),
            rent(&env, ROUND_LEN) + tk.prepay + r.sponsorship
        );
        // The vault is not written by a sponsorship.
        assert_eq!(env.vault().accepting_round, 1);
    }

    /// A join's own sponsorship and `sponsor_round` share one record per
    /// sponsor and round.
    #[test]
    fn a_join_and_sponsor_round_share_the_record() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 1_000).unwrap();
        let meta = env.sponsor(&p.kp.insecure_clone(), 1, 500).unwrap();
        let rec: Sponsorship = env.read(&record_of(1, &p.key()));
        assert_eq!(rec.amount, 1_500);
        let r = env.round(1);
        assert_eq!((r.sponsorship, r.sponsors), (1_500, 1));
        assert_eq!(events::<RoundSponsored>(&meta)[0].total, 1_500);
    }

    /// Partial sponsorship buys capacity: a ticket refused for capacity fits
    /// once a third party has sponsored part of the draw, the round still
    /// unpaid. A join takes at most its own share (`k · own share`) of the
    /// room others bought, so the ticket is a 0.50 USDC one at 97 % of that
    /// share (`near_share`), in a round whose room a self-sponsored long shot
    /// has used; a 1 USDC long shot at 71 % of its cap does not fit on a
    /// third party's sponsorship.
    #[test]
    fn partial_sponsorship_buys_capacity() {
        let mut env = setup();
        let k = env.keeper.insecure_clone();
        env.register_payout_table(&k, &near_share()).unwrap();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), 500_000, 0, 0).unwrap();
        // The long shot sponsors what its own room needs, about all of it.
        let r = env.round(1);
        let terms = r.terms();
        let u = super::join_round::long_shot_usage(&env, USDC);
        let takes = |s: u64| {
            let pays = beacon::is_paid(&terms, r.prices + USDC, r.sponsorship + s);
            beacon::fits(&terms, r.usage + u, r.prices + USDC, r.sponsorship + s)
                && beacon::within_join_share(&terms, u, USDC, s, pays)
        };
        let (mut lo, mut hi) = (0u64, terms.draw_max);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if takes(mid) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        env.join(&p, &long_shot(), USDC, 0, lo).unwrap();
        assert_eq!(env.round(1).status, RoundStatus::Accepting);
        let j = JoinArgs::direct(&env, &p, &near_share(), 500_000, 0, 0);
        let ix = env.join_round_ix(&j);
        let kp = p.kp.insecure_clone();
        assert_fails_with(env.send(&[ix], &[&kp]), FadeError::RoundCapacity);
        let merchant = funded_sponsor(&mut env);
        let d = env.round(1).draw_max;
        env.sponsor(&merchant, 1, d / 10).unwrap();
        assert_eq!(env.round(1).status, RoundStatus::Accepting);
        env.join(&p, &near_share(), 500_000, 0, 0).unwrap();
        let r = env.round(1);
        assert_eq!((r.tickets, r.status), (3, RoundStatus::Accepting));
        assert!(beacon::fits(&r.terms(), r.usage, r.prices, r.sponsorship));
    }

    /// A paid round takes sponsorship until its request, closed or not, and
    /// is not paid again; a requested or ended round takes none.
    #[test]
    fn sponsorship_runs_until_the_request() {
        let mut env = setup();
        let p = env.user(20 * USDC);
        env.join(&p, &coin_flip(), 9 * USDC, 0, 0).unwrap();
        let r = env.round(1);
        assert_eq!(r.status, RoundStatus::Paid);
        let s = funded_sponsor(&mut env);
        let meta = env.sponsor(&s, 1, 10).unwrap();
        assert!(events::<RoundPaid>(&meta).is_empty());
        let now = env.now();
        env.set_time(r.close_slot + 500, now);
        env.sponsor(&s, 1, 10).unwrap();
        let after = env.round(1);
        assert_eq!(
            (
                after.status,
                after.paid_slot,
                after.close_slot,
                after.sponsorship
            ),
            (RoundStatus::Paid, r.paid_slot, r.close_slot, 20)
        );
        for status in [
            RoundStatus::Requested,
            RoundStatus::Drawn,
            RoundStatus::Refunded,
            RoundStatus::Forfeited,
        ] {
            set_status(&mut env, 1, status);
            refused(&mut env, &s, 1, 10, FadeError::RoundNotAccepting);
        }
    }

    /// The accounts a sponsorship could touch, byte for byte.
    fn watched(env: &Env, sponsor: &Address, id: u64) -> Vec<Option<Account>> {
        [
            *sponsor,
            round_address(id),
            record_of(id, sponsor),
            env.a.vault,
        ]
        .iter()
        .map(|a| env.svm.get_account(a))
        .collect()
    }

    /// `ix` signed by the keeper (fee) and `sponsor` is refused with `check`,
    /// and nothing moved.
    #[track_caller]
    fn refused_ix(
        env: &mut Env,
        sponsor: &Keypair,
        id: u64,
        ix: Instruction,
        check: impl Fn(&Failure) -> bool,
    ) {
        let before = watched(env, &sponsor.pubkey(), id);
        let keeper = env.keeper.insecure_clone();
        let err = env.send(&[ix], &[&keeper, sponsor]).expect_err("refused");
        assert!(check(&err), "{}\n{}", err.err, err.logs.join("\n"));
        assert_eq!(
            watched(env, &sponsor.pubkey(), id),
            before,
            "a refused sponsorship moves nothing"
        );
    }

    #[track_caller]
    fn refused(env: &mut Env, sponsor: &Keypair, id: u64, lamports: u64, e: FadeError) {
        let round = round_address(id);
        let ix = env.sponsor_round_ix(
            &sponsor.pubkey(),
            &record_of(id, &sponsor.pubkey()),
            &round,
            lamports,
        );
        let code = fade_error(e);
        refused_ix(env, sponsor, id, ix, |f| f.has_code(code));
    }

    /// The checks of §13.5.3 in order, each paired with a later one that
    /// would also fail.
    #[test]
    fn checks_in_order() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let s = funded_sponsor(&mut env);
        let round = round_address(1);
        let record = record_of(1, &s.pubkey());

        // 1. remaining accounts, before a zero amount.
        let mut ix = env.sponsor_round_ix(&s.pubkey(), &record, &round, 0);
        ix.accounts
            .push(solana_instruction::AccountMeta::new_readonly(
                Address::new_unique(),
                false,
            ));
        refused_ix(&mut env, &s, 1, ix, |f| {
            f.has_code(fade_error(FadeError::RemainingAccounts))
        });

        // 2. a zero amount, before the round's status.
        set_status(&mut env, 1, RoundStatus::Requested);
        refused(&mut env, &s, 1, 0, FadeError::ZeroAmount);
        // 3. the status, before the pause and the draw's fit.
        set_orao_fee(&mut env, 2 * ORAO_FEE + 1);
        let g = env.guardian.insecure_clone();
        env.set_pause_flags(&g, fade::state::Config::PAUSE_TICKETS, None)
            .unwrap();
        refused(&mut env, &s, 1, 1, FadeError::RoundNotAccepting);
        set_status(&mut env, 1, RoundStatus::Accepting);

        // 3b. the pause, for an accepting round, before the draw's fit.
        refused(&mut env, &s, 1, 1, FadeError::Paused);
        let c = env.council.insecure_clone();
        env.set_pause_flags(&c, 0, None).unwrap();

        // 4. the draw no longer fits its prefund, before the record: the round
        // could only forfeit once paid, so it takes no sponsorship, accepting
        // or paid. At exactly the margin it does.
        let other = record_of(1, &p.key());
        let ix = env.sponsor_round_ix(&s.pubkey(), &other, &round, 1);
        refused_ix(&mut env, &s, 1, ix, |f| {
            f.has_code(fade_error(FadeError::DrawUnderfunded))
        });
        let d = env.round(1).draw_max;
        refused(&mut env, &s, 1, d, FadeError::DrawUnderfunded);
        set_status(&mut env, 1, RoundStatus::Paid);
        refused(&mut env, &s, 1, 1, FadeError::DrawUnderfunded);
        set_status(&mut env, 1, RoundStatus::Accepting);
        set_orao_fee(&mut env, 2 * ORAO_FEE);
        env.sponsor(&s, 1, 1).unwrap();

        // 5. the record: another sponsor's, another round's, foreign-owned.
        let ix = env.sponsor_round_ix(&s.pubkey(), &other, &round, 1);
        refused_ix(&mut env, &s, 1, ix, |f| f.has_code(2006));
        let ix = env.sponsor_round_ix(&s.pubkey(), &record_of(2, &s.pubkey()), &round, 1);
        refused_ix(&mut env, &s, 1, ix, |f| f.has_code(2006));
        let t = funded_sponsor(&mut env);
        let foreign = record_of(1, &t.pubkey());
        env.svm
            .set_account(
                foreign,
                Account {
                    lamports: 1_000_000,
                    data: vec![],
                    owner: addr(anchor_spl::token::ID),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let ix = env.sponsor_round_ix(&t.pubkey(), &foreign, &round, 1);
        refused_ix(&mut env, &t, 1, ix, |f| f.has_code(3007));
        assert_eq!(env.round(1).sponsorship, 1);
    }

    /// Anchor's checks on the round, the network state and the signer.
    #[test]
    fn the_accounts_are_checked() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let s = funded_sponsor(&mut env);
        // A copy of round 1 at an address that is not its PDA.
        let forged = Address::new_unique();
        let acc = env.svm.get_account(&round_address(1)).unwrap();
        env.svm.set_account(forged, acc).unwrap();
        let ix = env.sponsor_round_ix(
            &s.pubkey(),
            &sponsorship_address(&forged, &s.pubkey()),
            &forged,
            1,
        );
        refused_ix(&mut env, &s, 1, ix, |f| f.has_code(2006));
        // A round that does not exist.
        let ix = env.sponsor_round_ix(
            &s.pubkey(),
            &record_of(2, &s.pubkey()),
            &round_address(2),
            1,
        );
        refused_ix(&mut env, &s, 1, ix, |f| f.has_code(3012));
        // Another account than ORAO's network state.
        let mut ix = env.sponsor_round_ix(
            &s.pubkey(),
            &record_of(1, &s.pubkey()),
            &round_address(1),
            1,
        );
        ix.accounts[4].pubkey = env.a.config;
        refused_ix(&mut env, &s, 1, ix, |f| f.has_code(2006));
        // A copy of the vault at an address that is not its PDA.
        let fake_vault = Address::new_unique();
        let acc = env.svm.get_account(&env.a.vault).unwrap();
        env.svm.set_account(fake_vault, acc).unwrap();
        let mut ix = env.sponsor_round_ix(
            &s.pubkey(),
            &record_of(1, &s.pubkey()),
            &round_address(1),
            1,
        );
        assert_eq!(ix.accounts[1].pubkey, env.a.vault);
        ix.accounts[1].pubkey = fake_vault;
        refused_ix(&mut env, &s, 1, ix, |f| f.has_code(2006));
        // A copy of the config, unpaused, at an address that is not its PDA,
        // while the real one pauses tickets.
        let g = env.guardian.insecure_clone();
        let unpaused = env.svm.get_account(&env.a.config).unwrap();
        env.set_pause_flags(&g, fade::state::Config::PAUSE_TICKETS, None)
            .unwrap();
        let forged_config = Address::new_unique();
        env.svm.set_account(forged_config, unpaused).unwrap();
        let mut ix = env.sponsor_round_ix(
            &s.pubkey(),
            &record_of(1, &s.pubkey()),
            &round_address(1),
            1,
        );
        assert_eq!(ix.accounts[5].pubkey, env.a.config);
        ix.accounts[5].pubkey = forged_config;
        refused_ix(&mut env, &s, 1, ix, |f| f.has_code(2006));
        let c = env.council.insecure_clone();
        env.set_pause_flags(&c, 0, None).unwrap();
        // The sponsor must sign.
        let mut ix = env.sponsor_round_ix(
            &s.pubkey(),
            &record_of(1, &s.pubkey()),
            &round_address(1),
            1,
        );
        ix.accounts[0].is_signer = false;
        let keeper = env.keeper.insecure_clone();
        let err = env.send(&[ix], &[&keeper]).expect_err("unsigned");
        assert!(err.has_code(3010), "{}", err.err);
        assert_eq!(env.round(1).sponsorship, 0);
    }

    /// A pre-funded record address is created over: the sponsor tops it up to
    /// the rent, never more.
    #[test]
    fn a_pre_funded_record_is_created_over() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let s = funded_sponsor(&mut env);
        let record = record_of(1, &s.pubkey());
        env.svm
            .set_account(
                record,
                Account {
                    lamports: 1,
                    data: vec![],
                    owner: system_id(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let s0 = env.lamports(&s.pubkey());
        let meta = env.sponsor(&s, 1, 100).unwrap();
        assert_eq!(
            env.lamports(&s.pubkey()),
            s0 - meta.fee - (rent(&env, SPONSORSHIP_LEN) - 1) - 100
        );
        assert_eq!(env.lamports(&record), rent(&env, SPONSORSHIP_LEN));
        let rec: Sponsorship = env.read(&record);
        assert_eq!(rec.amount, 100);
        assert_eq!(env.round(1).sponsors, 1);
    }

    /// While joins are paused (`PAUSE_TICKETS`, `PAUSE_ROUNDS`, or both), an
    /// `Accepting` round takes no sponsorship, paying or not, and nothing
    /// moves: its tickets keep their full refund (§13.7)
    ///. A top-up of a `Paid` round and every reclaim still
    /// pass under `PAUSE_ALL`; the other pause bits do not stop a sponsorship.
    #[test]
    fn a_pause_leaves_an_unpaid_round_to_its_refund() {
        use fade::state::Config;
        for flags in [
            Config::PAUSE_TICKETS,
            Config::PAUSE_ROUNDS,
            Config::PAUSE_ALL,
        ] {
            let mut env = setup();
            let p = env.user(10 * USDC);
            env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
            let g = env.guardian.insecure_clone();
            env.set_pause_flags(&g, flags, None).unwrap();
            let s = funded_sponsor(&mut env);
            let r = env.round(1);
            let need = beacon::sponsorship_to_pay(&r.terms(), r.prices, r.sponsorship).unwrap();
            assert!(need > 1);
            // The sponsorship that would pay the round, and a partial one.
            refused(&mut env, &s, 1, need, FadeError::Paused);
            refused(&mut env, &s, 1, 1, FadeError::Paused);
            let r = env.round(1);
            assert_eq!(r.status, RoundStatus::Accepting);
            assert_eq!((r.sponsorship, r.sponsors), (0, 0));
        }

        // Pauses that do not concern rounds leave sponsorship open.
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let g = env.guardian.insecure_clone();
        env.set_pause_flags(
            &g,
            Config::PAUSE_DEPOSITS | Config::PAUSE_NEW_INTEGRATORS,
            None,
        )
        .unwrap();
        let s = funded_sponsor(&mut env);
        env.sponsor(&s, 1, 100).unwrap();

        // A paid round, then every pause: a top-up still lands (it only lowers
        // the tickets' charges), and so do the reclaims.
        let r = env.round(1);
        let need = beacon::sponsorship_to_pay(&r.terms(), r.prices, r.sponsorship).unwrap();
        env.sponsor(&s, 1, need).unwrap();
        assert_eq!(env.round(1).status, RoundStatus::Paid);
        env.set_pause_flags(&g, Config::PAUSE_ALL, None).unwrap();
        let t = funded_sponsor(&mut env);
        env.sponsor(&t, 1, 7).unwrap();
        env.sponsor(&s, 1, 3).unwrap();
        let r = env.round(1);
        assert_eq!(r.sponsorship, 100 + need + 10);
        assert_eq!(r.sponsors, 2);
        set_status(&mut env, 1, RoundStatus::Refunded);
        reclaimed(&mut env, 1, &s.pubkey(), 100 + need + 3);
        reclaimed(&mut env, 1, &t.pubkey(), 7);
    }

    /// The draw-fit check compares the live fee with the round's snapshot
    /// `request_share`, the one `request_round_draw` charges, not the live
    /// parameter: after governance lowers `crank_request_lamports`, a fee the
    /// live share would still fit is refused, accepting or paid, since the
    /// request would refuse the round and a paid round could only forfeit.
    #[test]
    fn the_draw_check_uses_the_rounds_request_share() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let s = funded_sponsor(&mut env);
        let old = env.round(1);
        assert_eq!(old.request_share, 50_000);
        let mut params = env.config().params;
        params.crank_request_lamports = 10_000;
        env.set_params(params).unwrap();
        assert!(!env.config().pending.active);
        assert_eq!(env.config().params.crank_request_lamports, 10_000);
        let r = env.round(1);
        assert_eq!((r.request_share, r.draw_max), (50_000, old.draw_max));

        // One lamport beyond the margin at the snapshot share, within it at
        // the live one: the snapshot decides.
        let fee = 2 * ORAO_FEE + 1;
        assert!(!beacon::request_fits(
            fee,
            pending_rent(&env),
            r.request_share,
            r.draw_max
        ));
        assert!(beacon::request_fits(
            fee,
            pending_rent(&env),
            params.crank_request_lamports,
            r.draw_max
        ));
        set_orao_fee(&mut env, fee);
        let need = beacon::sponsorship_to_pay(&r.terms(), r.prices, r.sponsorship).unwrap();
        // The sponsorship that would pay the round, and a partial one.
        refused(&mut env, &s, 1, need, FadeError::DrawUnderfunded);
        refused(&mut env, &s, 1, 1, FadeError::DrawUnderfunded);
        let r = env.round(1);
        assert_eq!(r.status, RoundStatus::Accepting);
        assert_eq!((r.sponsorship, r.sponsors), (0, 0));

        // Back within the margin, it pays the round.
        set_orao_fee(&mut env, 2 * ORAO_FEE);
        env.sponsor(&s, 1, need).unwrap();
        assert_eq!(env.round(1).status, RoundStatus::Paid);

        // A paid round: the same fee refuses a top-up, nothing moves.
        set_orao_fee(&mut env, fee);
        refused(&mut env, &s, 1, 1, FadeError::DrawUnderfunded);
        set_orao_fee(&mut env, 2 * ORAO_FEE);
        env.sponsor(&s, 1, 1).unwrap();
        let r = env.round(1);
        assert_eq!((r.sponsorship, r.sponsors), (need + 1, 1));
        assert_eq!(r.request_share, 50_000);
    }

    // --- reclaim_sponsorship -----------------------------------------------------------

    /// A round of two tickets and three sponsors, drawn: each sponsor is
    /// charged pro rata, floored, and the round, once its tickets settle and
    /// its last sponsor reclaims, closes to its rent payer with the dust. The
    /// returns do not depend on the order of the reclaims.
    #[test]
    fn returns_after_a_draw() {
        for order in [[0usize, 1, 2], [2, 1, 0], [1, 2, 0]] {
            let mut env = setup();
            let p = env.user(10 * USDC);
            let q = env.user(10 * USDC);
            let (t1, _) = env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
            let (t2, _) = env.join(&q, &coin_flip(), 2 * USDC, 0, 0).unwrap();
            let sponsors = [
                funded_sponsor(&mut env),
                funded_sponsor(&mut env),
                funded_sponsor(&mut env),
            ];
            let amounts = [1_000_003u64, 777_777, 0];
            env.sponsor(&sponsors[0], 1, amounts[0]).unwrap();
            env.sponsor(&sponsors[1], 1, amounts[1]).unwrap();
            let r = env.round(1);
            let need = beacon::sponsorship_to_pay(&r.terms(), r.prices, r.sponsorship).unwrap();
            env.sponsor(&sponsors[2], 1, need).unwrap();
            let amounts = [amounts[0], amounts[1], need];
            let start = env.lamports(&round_address(1));
            let r = env.round(1);
            assert_eq!(r.status, RoundStatus::Paid);
            let s = r.sponsorship;

            // Reclaims are refused until the round has ended.
            for status in [
                RoundStatus::Accepting,
                RoundStatus::Paid,
                RoundStatus::Requested,
            ] {
                set_status(&mut env, 1, status);
                let rec_before = env.svm.get_account(&record_of(1, &sponsors[0].pubkey()));
                let r_before = env.svm.get_account(&round_address(1));
                assert_fails_with(
                    env.reclaim(1, &sponsors[0].pubkey()),
                    FadeError::WrongRoundStatus,
                );
                assert_eq!(
                    env.svm.get_account(&record_of(1, &sponsors[0].pubkey())),
                    rec_before
                );
                assert_eq!(env.svm.get_account(&round_address(1)), r_before);
            }
            set_status(&mut env, 1, RoundStatus::Paid);

            let c = fulfilled(&mut env, 1);
            assert!(s > c, "the sponsors pay the whole draw");
            let mut back = 0;
            for &i in &order[..2] {
                let expected = share_back(s, c, amounts[i]);
                reclaimed(&mut env, 1, &sponsors[i].pubkey(), expected);
                back += expected;
            }
            // Tickets settle: nothing charged, the sponsors paid it all.
            let payers = release(&mut env, 1, &[t1, t2]);
            assert_eq!(payers, r.prepaid);
            let last = order[2];
            let expected = share_back(s, c, amounts[last]);
            let rent_payer = p.key();
            let rp0 = env.lamports(&rent_payer);
            let left = env.lamports(&round_address(1));
            let record_lamports = env.lamports(&record_of(1, &sponsors[last].pubkey()));
            let s0 = env.lamports(&sponsors[last].pubkey());
            let meta = reclaimed(&mut env, 1, &sponsors[last].pubkey(), expected);
            back += expected;
            assert_eq!(
                env.lamports(&sponsors[last].pubkey()),
                s0 + expected + record_lamports
            );
            // Closed: every lamport left to the rent payer, the account gone.
            let closed = events::<RoundClosed>(&meta);
            assert_eq!(closed.len(), 1);
            assert_eq!(
                (
                    addr(closed[0].round),
                    addr(closed[0].rent_payer),
                    closed[0].lamports
                ),
                (round_address(1), rent_payer, left - expected)
            );
            assert_eq!(env.lamports(&rent_payer), rp0 + left - expected);
            assert!(!env.exists(&round_address(1)));
            let acc = env.svm.get_account(&round_address(1)).unwrap_or_default();
            assert_eq!((acc.owner, acc.data.len()), (system_id(), 0));
            // Fact 2: the round paid out what it held, the dust below one
            // lamport per sponsor.
            let dust = left - expected - rent(&env, ROUND_LEN);
            assert_eq!(start, rent(&env, ROUND_LEN) + r.prepaid + s);
            assert_eq!(back + dust, s - c);
            assert!(dust < 3, "dust {dust}");
        }
    }

    /// A draw costing more than the sponsorship: the sponsors are charged all
    /// of it, get only their records' rent back, and the tickets pay the rest.
    #[test]
    fn a_draw_above_the_sponsorship_takes_all_of_it() {
        let mut env = setup();
        let p = env.user(20 * USDC);
        let (t, _) = env.join(&p, &coin_flip(), 9 * USDC, 0, 0).unwrap();
        let a = funded_sponsor(&mut env);
        let b = funded_sponsor(&mut env);
        env.sponsor(&a, 1, 600_000).unwrap();
        env.sponsor(&b, 1, 400_000).unwrap();
        let c = fulfilled(&mut env, 1);
        assert!(c > 1_000_000);
        reclaimed(&mut env, 1, &a.pubkey(), 0);
        let tk = env.round_ticket(&t);
        let charge = beacon::charge(c, 1_000_000, 9 * USDC, 9 * USDC).unwrap();
        assert_eq!(charge, c - 1_000_000);
        assert_eq!(release(&mut env, 1, &[t]), tk.prepay - charge);
        let left = env.lamports(&round_address(1));
        let meta = reclaimed(&mut env, 1, &b.pubkey(), 0);
        assert_eq!(events::<RoundClosed>(&meta)[0].lamports, left);
        assert_eq!(left, rent(&env, ROUND_LEN), "no dust: the charge is exact");
    }

    /// Forfeited: never requested, nothing was spent and every sponsor gets
    /// its whole amount; requested and withheld, the request's whole cost is
    /// charged to the sponsors first, pro rata.
    #[test]
    fn returns_after_a_forfeiture() {
        // Never requested.
        let mut env = setup();
        let p = env.user(10 * USDC);
        let (t, _) = env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let a = funded_sponsor(&mut env);
        let b = funded_sponsor(&mut env);
        env.sponsor(&a, 1, 1_234_567).unwrap();
        let r = env.round(1);
        let need = beacon::sponsorship_to_pay(&r.terms(), r.prices, r.sponsorship).unwrap();
        env.sponsor(&b, 1, need).unwrap();
        assert_eq!(forfeit(&mut env, 1, false), 0);
        reclaimed(&mut env, 1, &a.pubkey(), 1_234_567);
        reclaimed(&mut env, 1, &b.pubkey(), need);
        assert_eq!(release(&mut env, 1, &[t]), env.round_ticket(&t).prepay);
        assert_eq!(env.lamports(&round_address(1)), rent(&env, ROUND_LEN));

        // Requested, never fulfilled: C is the request's full cost.
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let a = funded_sponsor(&mut env);
        let b = funded_sponsor(&mut env);
        env.sponsor(&a, 1, 3_000_001).unwrap();
        let r = env.round(1);
        // More than pays the round, so that the sponsors cover the whole
        // request and get something back.
        let need =
            beacon::sponsorship_to_pay(&r.terms(), r.prices, r.sponsorship).unwrap() + 1_000_000;
        env.sponsor(&b, 1, need).unwrap();
        assert_eq!(env.round(1).status, RoundStatus::Paid);
        let s = env.round(1).sponsorship;
        let c = forfeit(&mut env, 1, true);
        assert_eq!(c, ORAO_FEE + pending_rent(&env) + r.request_share);
        assert!(s > c);
        reclaimed(&mut env, 1, &a.pubkey(), share_back(s, c, 3_000_001));
        reclaimed(&mut env, 1, &b.pubkey(), share_back(s, c, need));
    }

    /// Refunded: every sponsor gets its whole amount whatever `draw_cost`
    /// says; the tickets their whole prepays; the round closes to its rent
    /// payer with exactly its rent.
    #[test]
    fn returns_after_a_refund() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        let q = env.user(10 * USDC);
        let (t1, _) = env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let (t2, _) = env.join(&q, &coin_flip(), USDC, 0, 555).unwrap();
        let a = funded_sponsor(&mut env);
        env.sponsor(&a, 1, 2_000_000).unwrap();
        assert_eq!(env.round(1).status, RoundStatus::Accepting);
        refund(&mut env, 1);
        // A stale draw cost on a refunded round is never read.
        env.set_round(1, None, |r| r.draw_cost = 1_999_999);
        reclaimed(&mut env, 1, &a.pubkey(), 2_000_000);
        let r = env.round(1);
        assert_eq!(release(&mut env, 1, &[t1, t2]), r.prepaid);
        // `q`'s sponsorship, carried in its join, is the last: the round
        // closes to `p`, whose join created it.
        let p0 = env.lamports(&p.key());
        let meta = reclaimed(&mut env, 1, &q.key(), 555);
        let closed = events::<RoundClosed>(&meta);
        assert_eq!(closed[0].lamports, rent(&env, ROUND_LEN));
        assert_eq!(env.lamports(&p.key()), p0 + rent(&env, ROUND_LEN));
        assert!(!env.exists(&round_address(1)));
    }

    /// A lone ticket sponsored in its own join: once drawn and settled, its
    /// payer is the sponsor and the rent payer, passed twice, and gets the
    /// unused sponsorship, the record's rent and the round's rent back.
    #[test]
    fn a_lone_ticket_gets_its_surplus_back() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        let terms = beacon::Terms {
            threshold: env.config().params.beacon_threshold,
            draw_max: env.draw_max(),
            round_k: 1,
        };
        let s = beacon::sponsorship_to_pay(&terms, USDC, 0).unwrap();
        let (t, _) = env.join(&p, &coin_flip(), USDC, 0, s).unwrap();
        let c = fulfilled(&mut env, 1);
        let tk = env.round_ticket(&t);
        assert_eq!(
            release(&mut env, 1, &[t]),
            tk.prepay,
            "the sponsorship paid the draw"
        );
        let p0 = env.lamports(&p.key());
        let record_lamports = env.lamports(&record_of(1, &p.key()));
        let left = env.lamports(&round_address(1));
        let meta = env.reclaim(1, &p.key()).unwrap();
        let back = s - c;
        assert_eq!(events::<SponsorshipReclaimed>(&meta)[0].lamports, back);
        assert_eq!(env.lamports(&p.key()), p0 + left + record_lamports);
        assert_eq!(left - back, rent(&env, ROUND_LEN));
        assert!(!env.exists(&round_address(1)));
    }

    /// The rent payer is needed, and checked, only when the reclaim leaves the
    /// round empty.
    #[test]
    fn the_rent_payer_is_required_to_close() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        let (t, _) = env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let a = funded_sponsor(&mut env);
        let b = funded_sponsor(&mut env);
        env.sponsor(&a, 1, 100).unwrap();
        env.sponsor(&b, 1, 200).unwrap();
        refund(&mut env, 1);
        let keeper = env.keeper.insecure_clone();
        let round = round_address(1);
        // The ticket is returned first: no ticket left, but a sponsorship.
        release(&mut env, 1, &[t]);
        // Not the last record: the round stays open and no rent payer is needed.
        let ix = env.reclaim_ix(
            &keeper.pubkey(),
            &round,
            &record_of(1, &a.pubkey()),
            &a.pubkey(),
            None,
        );
        env.send(&[ix], &[&keeper]).unwrap();
        assert!(env.exists(&round));
        assert_eq!((env.round(1).tickets, env.round(1).sponsors), (0, 1));
        // The last: missing or wrong, refused; right, closed.
        let record = record_of(1, &b.pubkey());
        for rent_payer in [None, Some(b.pubkey()), Some(Address::new_unique())] {
            let ix = env.reclaim_ix(&keeper.pubkey(), &round, &record, &b.pubkey(), rent_payer);
            let before = (env.svm.get_account(&round), env.svm.get_account(&record));
            assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::RentReceiverRequired);
            assert_eq!(
                (env.svm.get_account(&round), env.svm.get_account(&record)),
                before
            );
        }
        let ix = env.reclaim_ix(
            &keeper.pubkey(),
            &round,
            &record,
            &b.pubkey(),
            Some(p.key()),
        );
        env.send(&[ix], &[&keeper]).unwrap();
        assert!(!env.exists(&round));
    }

    /// The record, its sponsor and its round are the stored ones; a record
    /// is reclaimed once.
    #[test]
    fn reclaim_accounts_are_checked() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let a = funded_sponsor(&mut env);
        let b = funded_sponsor(&mut env);
        env.sponsor(&a, 1, 100).unwrap();
        env.sponsor(&b, 1, 200).unwrap();
        refund(&mut env, 1);
        let keeper = env.keeper.insecure_clone();
        let round = round_address(1);
        let rec_a = record_of(1, &a.pubkey());
        let rp = Some(p.key());
        // A's record paid to B.
        let ix = env.reclaim_ix(&keeper.pubkey(), &round, &rec_a, &b.pubkey(), rp);
        let err = env.send(&[ix], &[&keeper]).expect_err("wrong sponsor");
        assert!(err.has_code(2006) || err.has_code(2001), "{}", err.err);
        // A forged copy of the round at an address that is not its PDA.
        let forged = Address::new_unique();
        let acc = env.svm.get_account(&round).unwrap();
        env.svm.set_account(forged, acc).unwrap();
        let ix = env.reclaim_ix(&keeper.pubkey(), &forged, &rec_a, &a.pubkey(), rp);
        let err = env.send(&[ix], &[&keeper]).expect_err("forged round");
        assert!(err.has_code(2006), "{}", err.err);
        // Round 2's address, which holds nothing.
        let ix = env.reclaim_ix(&keeper.pubkey(), &round_address(2), &rec_a, &a.pubkey(), rp);
        let err = env.send(&[ix], &[&keeper]).expect_err("no round");
        assert!(err.has_code(3012), "{}", err.err);
        // A record whose stored round is another id, at this round's seeds.
        {
            let mut acc = env.svm.get_account(&rec_a).unwrap();
            let mut rec: Sponsorship = env.read(&rec_a);
            rec.round = 2;
            let mut data = Vec::new();
            rec.try_serialize(&mut data).unwrap();
            let saved = acc.clone();
            acc.data[..data.len()].copy_from_slice(&data);
            env.svm.set_account(rec_a, acc).unwrap();
            assert_fails_with(env.reclaim(1, &a.pubkey()), FadeError::WrongRound);
            env.svm.set_account(rec_a, saved).unwrap();
        }
        // The forged round with a record at its own seeds: the round's
        // address is checked, not only the record's.
        {
            let forged_rec = sponsorship_address(&forged, &a.pubkey());
            let acc = env.svm.get_account(&rec_a).unwrap();
            env.svm.set_account(forged_rec, acc).unwrap();
            let ix = env.reclaim_ix(&keeper.pubkey(), &forged, &forged_rec, &a.pubkey(), rp);
            let err = env
                .send(&[ix], &[&keeper])
                .expect_err("forged round and record");
            assert!(err.has_code(2006), "{}", err.err);
        }
        // A record at A's seeds storing another sponsor: the stored sponsor
        // is checked too (`has_one`).
        {
            let saved = env.svm.get_account(&rec_a).unwrap();
            let mut acc = saved.clone();
            let mut rec: Sponsorship = env.read(&rec_a);
            rec.sponsor = pk(b.pubkey());
            let mut data = Vec::new();
            rec.try_serialize(&mut data).unwrap();
            acc.data[..data.len()].copy_from_slice(&data);
            env.svm.set_account(rec_a, acc).unwrap();
            let ix = env.reclaim_ix(&keeper.pubkey(), &round, &rec_a, &a.pubkey(), rp);
            let err = env.send(&[ix], &[&keeper]).expect_err("stored sponsor");
            assert!(err.has_code(2001), "{}", err.err);
            env.svm.set_account(rec_a, saved).unwrap();
        }
        // Remaining accounts.
        let mut ix = env.reclaim_ix(&keeper.pubkey(), &round, &rec_a, &a.pubkey(), rp);
        ix.accounts
            .push(solana_instruction::AccountMeta::new_readonly(
                Address::new_unique(),
                false,
            ));
        assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::RemainingAccounts);
        // Twice in one transaction: the second finds no record; nothing moves.
        let ix = env.reclaim_ix(&keeper.pubkey(), &round, &rec_a, &a.pubkey(), rp);
        let a0 = env.lamports(&a.pubkey());
        let err = env
            .send(&[ix.clone(), ix.clone()], &[&keeper])
            .expect_err("twice");
        assert!(err.has_code(3012), "{}", err.err);
        assert_eq!(env.lamports(&a.pubkey()), a0);
        env.send(std::slice::from_ref(&ix), &[&keeper]).unwrap();
        let err = env.send(&[ix], &[&keeper]).expect_err("again");
        assert!(err.has_code(3012), "{}", err.err);
        assert_eq!(env.round(1).sponsors, 1);
    }

    /// A round holding less than its rent, the prepays it still owes and the
    /// return refuses the reclaim rather than pay a sponsor with a ticket's
    /// lamports. Only an inconsistent state can get there.
    #[test]
    fn a_reclaim_never_takes_what_the_tickets_are_owed() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let a = funded_sponsor(&mut env);
        env.sponsor(&a, 1, 1_000).unwrap();
        refund(&mut env, 1);
        let r = env.round(1);
        let exact = rent(&env, ROUND_LEN) + r.prepaid + 1_000;
        set_lamports(&mut env, &round_address(1), exact - 1);
        let before = (
            env.svm.get_account(&round_address(1)),
            env.lamports(&a.pubkey()),
        );
        assert_fails_with(env.reclaim(1, &a.pubkey()), FadeError::MathOverflow);
        assert_eq!(
            (
                env.svm.get_account(&round_address(1)),
                env.lamports(&a.pubkey())
            ),
            before
        );
        set_lamports(&mut env, &round_address(1), exact);
        reclaimed(&mut env, 1, &a.pubkey(), 1_000);
        assert_eq!(
            env.lamports(&round_address(1)),
            rent(&env, ROUND_LEN) + r.prepaid
        );
    }

    /// Compute units and sizes of both instructions.
    #[test]
    fn compute_units() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        let (t, _) = env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let a = funded_sponsor(&mut env);
        let b = funded_sponsor(&mut env);
        let m = env.sponsor(&a, 1, 1_000).unwrap();
        eprintln!(
            "CU sponsor_round (creating its record): {}",
            m.compute_units_consumed
        );
        let m = env.sponsor(&a, 1, 1_000).unwrap();
        eprintln!(
            "CU sponsor_round (topping up): {}",
            m.compute_units_consumed
        );
        let r = env.round(1);
        let need = beacon::sponsorship_to_pay(&r.terms(), r.prices, r.sponsorship).unwrap();
        let m = env.sponsor(&b, 1, need).unwrap();
        eprintln!(
            "CU sponsor_round (creating its record, paying the round): {}",
            m.compute_units_consumed
        );
        fulfilled(&mut env, 1);
        let m = env.reclaim(1, &a.pubkey()).unwrap();
        eprintln!("CU reclaim_sponsorship: {}", m.compute_units_consumed);
        release(&mut env, 1, &[t]);
        let m = env.reclaim(1, &b.pubkey()).unwrap();
        eprintln!(
            "CU reclaim_sponsorship (closing the round): {}",
            m.compute_units_consumed
        );
        assert!(m.compute_units_consumed < 50_000);
    }
}

// --- request_round_draw (Spec 08 §13.5.6) ------------------------------------------

mod request_round_draw {
    use super::*;
    use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
    use fade::events::RoundDrawRequested;
    use fade::state::{RoundStatus, Ticket};
    use fade_math::{beacon, orao_layout};
    use litesvm::types::TransactionMetadata;
    use solana_account::Account;
    use solana_address::Address;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_keypair::Keypair;
    use solana_signer::Signer;

    const VAULT: u64 = 100_000 * USDC;
    const ROUND_LEN: usize = 411;

    fn setup() -> Env {
        let mut env = Env::new();
        env.found(VAULT);
        let k = env.keeper.insecure_clone();
        env.register_payout_table(&k, &coin_flip()).unwrap();
        env
    }

    fn rent(env: &Env, len: usize) -> u64 {
        env.svm.minimum_balance_for_rent_exemption(len)
    }

    fn pending_rent(env: &Env) -> u64 {
        rent(env, orao_layout::PENDING_LEN)
    }

    /// What a request ORAO creates takes: its fee and a pending account's rent.
    fn needed(env: &Env) -> u64 {
        ORAO_FEE + pending_rent(env)
    }

    /// Pays round `joining_round()` with two coin flips, 5 and 4 USDC, from
    /// two players: the first leaves it `Accepting`, the second pays it.
    fn paid_round(env: &mut Env) -> u64 {
        let id = env.joining_round();
        for price in [5 * USDC, 4 * USDC] {
            let p = env.user(10 * USDC);
            env.join(&p, &coin_flip(), price, 0, 0).unwrap();
        }
        assert_eq!(env.round(id).status, RoundStatus::Paid);
        id
    }

    fn at_slot(env: &mut Env, slot: u64) {
        let now = env.now();
        env.set_time(slot, now);
    }

    /// Round `id` at `close_slot + 2`, the first slot of its window.
    fn to_window(env: &mut Env, id: u64) {
        let close = env.round(id).close_slot;
        at_slot(env, close + 2);
    }

    fn funded_caller(env: &mut Env) -> Keypair {
        let kp = Keypair::new();
        env.svm.airdrop(&kp.pubkey(), 1_000_000_000).unwrap();
        kp
    }

    /// Sends `ix` with the keeper paying the fee, so that the caller's
    /// lamports move only by what the request pays it.
    fn send(
        env: &mut Env,
        caller: &Keypair,
        ix: Instruction,
    ) -> Result<TransactionMetadata, Failure> {
        let keeper = env.keeper.insecure_clone();
        env.send(&[ix], &[&keeper, caller])
    }

    fn set_orao_fee(env: &mut Env, fee: u64) {
        env.set_orao_fee(fee);
    }

    fn snapshot(env: &Env, addresses: &[Address]) -> Vec<Option<Account>> {
        addresses.iter().map(|a| env.svm.get_account(a)).collect()
    }

    /// Every account a request could move, byte for byte and lamport for lamport.
    fn watched(env: &Env, caller: &Address, id: u64, request: &Address) -> Vec<Address> {
        vec![
            *caller,
            env.a.vault,
            round_address(id),
            round_vrf_address(id),
            *request,
            env.orao_treasury,
            env.a.network_state,
        ]
    }

    /// `ix` is refused as `check` says, and nothing moved.
    #[track_caller]
    fn refused_ix(
        env: &mut Env,
        caller: &Keypair,
        ix: Instruction,
        id: u64,
        request: &Address,
        check: impl Fn(&Failure) -> bool,
    ) {
        let addresses = watched(env, &caller.pubkey(), id, request);
        let before = snapshot(env, &addresses);
        let err = send(env, caller, ix).expect_err("refused");
        assert!(check(&err), "{}\n{}", err.err, err.logs.join("\n"));
        assert_eq!(
            snapshot(env, &addresses),
            before,
            "a refused request moves nothing"
        );
    }

    #[track_caller]
    fn refused(env: &mut Env, caller: &Keypair, id: u64, request: &Address, e: FadeError) {
        let ix = env.request_round_draw_ix(&caller.pubkey(), id, request);
        let code = fade_error(e);
        refused_ix(env, caller, ix, id, request, |f| f.has_code(code));
    }

    fn serialized<T: AccountSerialize>(v: &T) -> Vec<u8> {
        let mut data = Vec::new();
        v.try_serialize(&mut data).unwrap();
        data
    }

    fn data_of(env: &Env, address: &Address) -> Vec<u8> {
        env.svm.get_account(address).unwrap().data
    }

    // --- the happy path -----------------------------------------------------------------

    /// A paid round requested in the first slot of its window: the seed of
    /// §13.4 at ORAO's request address, ORAO paid its fee and the pending
    /// rent through `round_vrf`, which ends empty, the request share to the
    /// caller. The round's tickets were recorded in the counters when it
    /// became paid, and the request leaves them: every other byte of the
    /// round and every byte of the vault unchanged; every lamport accounted
    /// for.
    #[test]
    fn a_paid_round_is_requested() {
        let mut env = setup();
        let id = paid_round(&mut env);
        let r0 = env.round(id);
        assert_eq!(r0.tickets, 2);
        assert_eq!(
            (r0.counted, r0.side, r0.generation),
            (true, Ticket::SIDE_AFTER, env.vault().generation),
            "recorded at payment"
        );
        to_window(&mut env, id);
        let caller = funded_caller(&mut env);
        let request = env.round_request_address(id);
        let seed = env.round_seed(id);
        let v0 = env.vault();
        assert_eq!(v0.close_ts, 0, "no epoch is live: the round goes after");
        let round_l0 = env.lamports(&round_address(id));
        assert_eq!(
            round_l0,
            rent(&env, ROUND_LEN) + r0.prepaid + r0.sponsorship,
            "the round holds its rent and its prepays"
        );
        let treasury0 = env.lamports(&env.orao_treasury);
        let caller0 = env.lamports(&caller.pubkey());
        let vault_data0 = data_of(&env, &env.a.vault);

        let ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
        let meta = send(&mut env, &caller, ix).unwrap();

        let funded = needed(&env);
        let r = env.round(id);
        let mut expected = r0.clone();
        expected.status = RoundStatus::Requested;
        expected.randomness = pk(request);
        expected.seed = seed;
        expected.entropy_slot = r0.close_slot + 1;
        expected.funded = funded;
        assert_eq!(
            serialized(&r),
            serialized(&expected),
            "the request writes the draw, nothing else"
        );
        assert_eq!(r.side().unwrap(), fade_math::epoch::Side::AfterClose);
        assert_eq!(v0.open_after_close, 2, "both tickets, since the payment");
        assert_eq!(
            data_of(&env, &env.a.vault),
            vault_data0,
            "the request writes nothing to the vault"
        );

        // Lamports: the round paid ORAO and the caller, nothing else moved.
        let share = r0.request_share;
        assert_eq!(share, 50_000);
        assert_eq!(env.lamports(&round_address(id)), round_l0 - funded - share);
        assert_eq!(env.lamports(&caller.pubkey()), caller0 + share);
        assert_eq!(env.lamports(&env.orao_treasury), treasury0 + ORAO_FEE);
        assert_eq!(env.lamports(&round_vrf_address(id)), 0, "round_vrf empty");
        assert!(funded + share <= r.draw_max, "C ≤ D_r (fact 1)");
        assert!(
            env.lamports(&round_address(id)) >= rent(&env, ROUND_LEN),
            "the round keeps its rent (invariant 7)"
        );

        // ORAO's pending request, its client `round_vrf`, for the round's seed.
        let acc = env.svm.get_account(&request).unwrap();
        assert_eq!(acc.owner, orao_id());
        assert_eq!(acc.data.len(), orao_layout::PENDING_LEN);
        assert_eq!(acc.lamports, pending_rent(&env));
        assert_eq!(
            orao_layout::randomness(&acc.data),
            Some(orao_layout::Randomness::Pending)
        );
        assert_eq!(&acc.data[9..41], round_vrf_address(id).as_ref());
        assert_eq!(&acc.data[41..73], &seed);

        let ev = events::<RoundDrawRequested>(&meta);
        assert_eq!(ev.len(), 1);
        let e = &ev[0];
        assert_eq!(e.version, 1);
        assert_eq!(addr(e.round), round_address(id));
        assert_eq!(addr(e.request), request);
        assert_eq!(e.seed, seed);
        assert_eq!(e.entropy_slot, r0.close_slot + 1);
        assert_eq!(e.entropy_hash, slot_hash(r0.close_slot + 1));
        assert_eq!(e.funded, funded);
        assert_eq!((e.side, e.generation), (Ticket::SIDE_AFTER, v0.generation));

        // The stand-in fulfils it: the refund of the pending rent lands on
        // `round_vrf`, where the first settlement drains it (step 8).
        let randomness = [7u8; 64];
        env.fulfill_round(id, randomness);
        let refund = pending_rent(&env) - rent(&env, orao_layout::FULFILLED_LEN);
        assert_eq!(env.lamports(&round_vrf_address(id)), refund);
        let acc = env.svm.get_account(&request).unwrap();
        assert_eq!(
            orao_layout::randomness(&acc.data),
            Some(orao_layout::Randomness::Fulfilled { seed, randomness })
        );
        let c = beacon::draw_cost(funded, share, refund).unwrap();
        assert_eq!(c, ORAO_FEE + rent(&env, orao_layout::FULFILLED_LEN) + share);
        assert!(c <= r.draw_max);
    }

    /// The seed is the round's, not the ticket's: the same entropy, another
    /// round, another seed and another request; and the seed is fixed by the
    /// close slot, so requesting at any slot of the window gives the same.
    #[test]
    fn two_rounds_never_share_a_seed() {
        let mut env = setup();
        let one = paid_round(&mut env);
        let close = env.round(one).close_slot;
        at_slot(&mut env, close);
        let two = paid_round(&mut env);
        assert_eq!(two, one + 1);
        assert_eq!(env.vault().accepting_round, two);
        // Round 1 is no longer the accepting round; it is requested all the same.
        to_window(&mut env, one);
        let early = env.round_request_address(one);
        at_slot(&mut env, close + 100);
        assert_eq!(
            env.round_request_address(one),
            early,
            "s* is the first slot after the close whenever the request lands"
        );
        let (r1, _) = env.request_round_draw(one).unwrap();
        assert_eq!(env.vault().accepting_round, two, "the request leaves it");
        to_window(&mut env, two);
        let (r2, _) = env.request_round_draw(two).unwrap();
        assert_ne!(r1, r2);
        assert_ne!(env.round(one).seed, env.round(two).seed);
        assert_eq!(env.round(one).entropy_slot, close + 1);
    }

    /// "Anyone, paid the request share; never paused" (§13.5.6). With every
    /// pause bit set (`PAUSE_ALL`: tickets, deposits, new integrators, rounds)
    /// and both tickets' integrators paused, a paid round in its window is
    /// requested as usual, through ORAO or over a request created before. A
    /// pause held past `close_slot + t_settle_slots` would otherwise forfeit
    /// every paid round, the vault keeping the prices.
    #[test]
    fn a_request_is_never_paused() {
        for pre_created in [false, true] {
            let mut env = setup();
            let id = env.joining_round();
            let mut players = Vec::new();
            for price in [5 * USDC, 4 * USDC] {
                let p = env.user(10 * USDC);
                env.join(&p, &coin_flip(), price, 0, 0).unwrap();
                players.push(p);
            }
            assert_eq!(env.round(id).status, RoundStatus::Paid);
            let guardian = env.guardian.insecure_clone();
            env.set_pause_flags(&guardian, Config::PAUSE_ALL, None)
                .unwrap();
            for p in &players {
                let integrator = env.integrator_address(&p.key());
                env.set_pause_flags(&guardian, Config::PAUSE_ALL, Some((integrator, true)))
                    .unwrap();
                assert!(env.integrator(&p.key()).paused);
            }
            assert_eq!(env.config().pause_flags, Config::PAUSE_ALL);

            to_window(&mut env, id);
            let request = env.round_request_address(id);
            let seed = env.round_seed(id);
            if pre_created {
                let someone = funded_caller(&mut env);
                let ix = orao_request_ix(&env, &someone.pubkey(), &request, seed, false);
                env.send(&[ix], &[&someone]).unwrap();
                env.fulfill(&request, [4u8; 64]);
            }
            let funded = if pre_created { 0 } else { needed(&env) };
            let r0 = env.round(id);
            let caller = funded_caller(&mut env);
            let round_l0 = env.lamports(&round_address(id));
            let caller0 = env.lamports(&caller.pubkey());
            let treasury0 = env.lamports(&env.orao_treasury);
            let ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
            send(&mut env, &caller, ix).unwrap();
            let r = env.round(id);
            assert_eq!(
                (r.status, r.funded, r.seed),
                (RoundStatus::Requested, funded, seed)
            );
            assert_eq!(
                env.lamports(&round_address(id)),
                round_l0 - funded - r0.request_share
            );
            assert_eq!(env.lamports(&caller.pubkey()), caller0 + r0.request_share);
            let fee = if pre_created { 0 } else { ORAO_FEE };
            assert_eq!(env.lamports(&env.orao_treasury), treasury0 + fee);
            assert_eq!(env.lamports(&round_vrf_address(id)), 0);
            assert_eq!(env.config().pause_flags, Config::PAUSE_ALL);
        }
    }

    // --- the window ---------------------------------------------------------------------

    /// `close_slot + 2 ≤ slot ≤ close_slot + t_settle_slots`; before the
    /// close, at it, one slot after it and once `T_SETTLE` has passed the
    /// request is refused and nothing moves. The last slot is accepted.
    #[test]
    fn the_request_window() {
        let mut env = setup();
        let id = paid_round(&mut env);
        let r = env.round(id);
        assert_eq!(r.t_settle_slots, 150);
        let caller = funded_caller(&mut env);
        let dummy = Address::new_unique();
        for slot in [
            r.paid_slot,
            r.close_slot - 1,
            r.close_slot,
            r.close_slot + 1,
            r.close_slot + r.t_settle_slots + 1,
            r.close_slot + 10_000,
        ] {
            at_slot(&mut env, slot);
            refused(&mut env, &caller, id, &dummy, FadeError::RoundRequestWindow);
        }
        at_slot(&mut env, r.close_slot + r.t_settle_slots);
        let request = env.round_request_address(id);
        let ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
        send(&mut env, &caller, ix).unwrap();
        assert_eq!(env.round(id).status, RoundStatus::Requested);
        assert_eq!(env.round(id).entropy_slot, r.close_slot + 1);
    }

    /// Only a `Paid` round, recorded in the counters when it was paid, is
    /// requested: an unpaid round, a round requested already, drawn, refunded
    /// or forfeited, and a `Paid` round that claims not to be recorded or
    /// records no side are refused. The request never records the round
    /// again.
    #[test]
    fn only_a_paid_round_is_requested() {
        let mut env = setup();
        let caller = funded_caller(&mut env);
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        assert_eq!(env.round(1).status, RoundStatus::Accepting);
        let dummy = Address::new_unique();
        at_slot(&mut env, 5_000);
        refused(&mut env, &caller, 1, &dummy, FadeError::WrongRoundStatus);

        let mut env = setup();
        let caller = funded_caller(&mut env);
        let id = paid_round(&mut env);
        to_window(&mut env, id);
        let request = env.round_request_address(id);
        for status in [
            RoundStatus::Requested,
            RoundStatus::Drawn,
            RoundStatus::Refunded,
            RoundStatus::Forfeited,
        ] {
            env.set_round(id, None, |r| r.status = status);
            refused(&mut env, &caller, id, &request, FadeError::WrongRoundStatus);
        }
        env.set_round(id, None, |r| {
            r.status = RoundStatus::Paid;
            r.counted = false;
        });
        refused(&mut env, &caller, id, &request, FadeError::WrongRoundStatus);
        env.set_round(id, None, |r| {
            r.counted = true;
            r.side = 2;
        });
        refused(&mut env, &caller, id, &request, FadeError::WrongRoundStatus);
        env.set_round(id, None, |r| r.side = Ticket::SIDE_AFTER);

        // Requested once, it is never requested again, even in the window.
        let v0 = env.vault();
        assert_eq!(v0.open_after_close, 2, "recorded at payment");
        env.request_round_draw(id).unwrap();
        refused(&mut env, &caller, id, &request, FadeError::WrongRoundStatus);
        assert_eq!(serialized(&env.vault()), serialized(&v0), "recorded once");
    }

    // --- entropy and the request address -----------------------------------------------

    /// A skipped slot after the close: `s*` is the next produced one. Before
    /// any slot after the close is in SlotHashes, `EntropyUnavailable`.
    #[test]
    fn the_entropy_slot_is_the_first_produced_after_the_close() {
        let mut env = setup();
        let id = paid_round(&mut env);
        let close = env.round(id).close_slot;
        let caller = funded_caller(&mut env);
        let now = env.now();
        env.set_time_skipping(close + 2, now, &[close + 1]);
        let dummy = Address::new_unique();
        refused(&mut env, &caller, id, &dummy, FadeError::EntropyUnavailable);

        env.set_time_skipping(close + 3, now, &[close + 1]);
        let request = env.round_request_address(id);
        let seed = env.round_seed(id);
        let ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
        let meta = send(&mut env, &caller, ix).unwrap();
        let r = env.round(id);
        assert_eq!(r.entropy_slot, close + 2);
        assert_eq!(r.seed, seed);
        let e = &events::<RoundDrawRequested>(&meta)[0];
        assert_eq!(e.entropy_hash, slot_hash(close + 2));
    }

    /// The request must be ORAO's PDA for the round's own seed: an unrelated
    /// address, the request of another entropy slot, of another round, or the
    /// direct path's derivation for the same round are refused.
    #[test]
    fn the_request_is_the_rounds() {
        let mut env = setup();
        let one = paid_round(&mut env);
        let close = env.round(one).close_slot;
        at_slot(&mut env, close);
        let two = paid_round(&mut env);
        let close_two = env.round(two).close_slot;
        at_slot(&mut env, close_two + 2);
        let caller = funded_caller(&mut env);
        let wrong_entropy = {
            let r = env.round(one);
            let mut pre = b"FADE/BEACON-SEED/v1".to_vec();
            pre.extend_from_slice(fade_id().as_ref());
            pre.extend_from_slice(round_address(one).as_ref());
            pre.extend_from_slice(&r.close_slot.to_le_bytes());
            pre.extend_from_slice(&(r.close_slot + 2).to_le_bytes());
            pre.extend_from_slice(&slot_hash(r.close_slot + 2));
            let seed = solana_sha256_hasher::hashv(&[&pre]).to_bytes();
            pda(&[fade_math::orao_layout::REQUEST_SEED, &seed], &orao_id())
        };
        let direct_tag = {
            let r = env.round(one);
            let e = env.round_entropy(one).unwrap();
            let seed = fade::instructions::request_randomness::orao_seed(
                &fade::ID,
                &pk(round_address(one)),
                r.close_slot,
                e.slot,
                &e.hash,
            );
            pda(&[fade_math::orao_layout::REQUEST_SEED, &seed], &orao_id())
        };
        for wrong in [
            Address::new_unique(),
            env.round_request_address(two),
            wrong_entropy,
            direct_tag,
            round_vrf_address(one),
        ] {
            refused(
                &mut env,
                &caller,
                one,
                &wrong,
                FadeError::WrongRandomnessAccount,
            );
        }
        // Another round's request, which ORAO owns and which parses as a
        // request: it would pass as pre-created if the address were not
        // derived from this round's seed.
        let (other, _) = env.request_round_draw(two).unwrap();
        assert_eq!(env.svm.get_account(&other).unwrap().owner, orao_id());
        refused(
            &mut env,
            &caller,
            one,
            &other,
            FadeError::WrongRandomnessAccount,
        );
        let request = env.round_request_address(one);
        let ix = env.request_round_draw_ix(&caller.pubkey(), one, &request);
        send(&mut env, &caller, ix).unwrap();
        assert_eq!(env.round(one).funded, needed(&env));
    }

    // --- a request created before ------------------------------------------------------

    pub(super) fn orao_request_ix(
        env: &Env,
        payer: &Address,
        request: &Address,
        seed: [u8; 32],
        legacy: bool,
    ) -> Instruction {
        let data = if legacy {
            orao_mock::instruction::Request { seed }.data()
        } else {
            orao_mock::instruction::RequestV2 { seed }.data()
        };
        Instruction {
            program_id: orao_id(),
            accounts: metas(
                orao_mock::accounts::RequestV2 {
                    payer: pk(*payer),
                    network_state: pk(env.a.network_state),
                    treasury: pk(env.orao_treasury),
                    request: pk(*request),
                    system_program: pk(system_id()),
                }
                .to_account_metas(None),
            ),
            data,
        }
    }

    /// Anyone may create the round's request through ORAO once the seed is
    /// public, with `request_v2` or the deprecated `request`, and ORAO may
    /// have fulfilled it before the round's own request lands, which is the
    /// usual case: pending or fulfilled, the request is accepted, nothing is
    /// funded (whoever created it paid), the caller is paid its share, and
    /// the request is left as it was. Refusing a fulfilled one would let
    /// anyone force the round's forfeiture by creating its request first.
    #[test]
    fn a_pre_created_request_is_accepted() {
        for (legacy, fulfilled, stray) in [
            (false, false, 0),
            (true, false, 0),
            (false, true, 0),
            (true, true, 0),
            (false, false, 2_000_000),
            (false, true, 2_000_000),
            (true, true, 2_000_000),
        ] {
            let mut env = setup();
            let id = paid_round(&mut env);
            to_window(&mut env, id);
            let request = env.round_request_address(id);
            let seed = env.round_seed(id);
            let someone = funded_caller(&mut env);
            let ix = orao_request_ix(&env, &someone.pubkey(), &request, seed, legacy);
            env.send(&[ix], &[&someone]).unwrap();
            let randomness = [9u8; 64];
            if fulfilled {
                env.fulfill(&request, randomness);
                let data = env.svm.get_account(&request).unwrap().data;
                assert_eq!(
                    orao_layout::randomness(&data),
                    Some(orao_layout::Randomness::Fulfilled { seed, randomness }),
                    "ORAO answered before the round's request"
                );
            }
            let request_before = env.svm.get_account(&request).unwrap();
            let v0 = env.vault();
            // Lamports someone sent to `round_vrf` go to the round on this
            // path too (§13.5.6), not to the caller nor left behind.
            if stray > 0 {
                env.svm.airdrop(&round_vrf_address(id), stray).unwrap();
            }

            let caller = funded_caller(&mut env);
            let round_l0 = env.lamports(&round_address(id));
            let treasury0 = env.lamports(&env.orao_treasury);
            let caller0 = env.lamports(&caller.pubkey());
            let ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
            let meta = send(&mut env, &caller, ix).unwrap();
            let r = env.round(id);
            assert_eq!(r.status, RoundStatus::Requested);
            assert_eq!((r.funded, r.seed, addr(r.randomness)), (0, seed, request));
            assert_eq!(
                env.lamports(&round_address(id)),
                round_l0 + stray - r.request_share,
                "stray {stray}"
            );
            assert_eq!(env.lamports(&caller.pubkey()), caller0 + r.request_share);
            assert_eq!(env.lamports(&env.orao_treasury), treasury0);
            assert_eq!(env.svm.get_account(&request).unwrap(), request_before);
            assert_eq!(env.lamports(&round_vrf_address(id)), 0);
            assert_eq!(
                serialized(&env.vault()),
                serialized(&v0),
                "the counters are the payment's"
            );
            assert_eq!(v0.open_after_close, 2);
            assert_eq!(events::<RoundDrawRequested>(&meta)[0].funded, 0);
            // `C` is then the request share alone, whatever ORAO refunds to
            // the one who created it.
            assert_eq!(
                beacon::draw_cost(r.funded, r.request_share, 0).unwrap(),
                r.request_share
            );
        }
    }

    /// An account at the request address that ORAO owns but that is not a
    /// request is refused, before ORAO's state is read.
    #[test]
    fn a_forged_request_is_refused() {
        let mut env = setup();
        let id = paid_round(&mut env);
        to_window(&mut env, id);
        let request = env.round_request_address(id);
        let caller = funded_caller(&mut env);
        let lamports = pending_rent(&env);
        env.svm
            .set_account(
                request,
                Account {
                    lamports,
                    data: vec![0u8; orao_layout::PENDING_LEN],
                    owner: orao_id(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        set_orao_fee(&mut env, 10 * ORAO_FEE);
        refused(
            &mut env,
            &caller,
            id,
            &request,
            FadeError::WrongRandomnessAccount,
        );
    }

    /// A request ORAO already owns only has to parse (§13.5.6): nothing is
    /// funded, so ORAO's network state, its treasury and the
    /// `DrawUnderfunded` bound are read only on the path that creates the
    /// request. Pending or fulfilled, v2 or legacy, it is accepted with a fee
    /// risen past the round's margin, with no readable network state at its
    /// address and an unrelated treasury, and with both: `funded = 0`, the
    /// caller paid exactly the request share, the round losing only that
    /// share. This is how a round whose fee rose past its margin is still
    /// drawn rather than forfeited, a third party paying ORAO; `C` is then the
    /// request share alone, `≤ D_r` (fact 1). Checking ORAO's state or the
    /// bound on this path too would forfeit such a round, the vault keeping
    /// every ticket's price although a fulfilled request exists for it.
    #[test]
    fn a_pre_created_request_needs_no_orao_state() {
        let risen = 2 * ORAO_FEE + 1;
        for legacy in [false, true] {
            for fulfilled in [false, true] {
                for (fee_risen, state_gone) in [(true, false), (false, true), (true, true)] {
                    let mut env = setup();
                    let id = paid_round(&mut env);
                    to_window(&mut env, id);
                    let request = env.round_request_address(id);
                    let seed = env.round_seed(id);
                    let someone = funded_caller(&mut env);
                    let ix = orao_request_ix(&env, &someone.pubkey(), &request, seed, legacy);
                    env.send(&[ix], &[&someone]).unwrap();
                    if fulfilled {
                        env.fulfill(&request, [5u8; 64]);
                    }
                    let request_before = env.svm.get_account(&request).unwrap();
                    let r0 = env.round(id);
                    if fee_risen {
                        set_orao_fee(&mut env, risen);
                        assert!(
                            !beacon::request_fits(
                                risen,
                                pending_rent(&env),
                                r0.request_share,
                                r0.draw_max
                            ),
                            "the fee is past the round's margin"
                        );
                    }
                    let caller = funded_caller(&mut env);
                    let mut ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
                    let mut treasury = env.orao_treasury;
                    if state_gone {
                        let mut gone = env.svm.get_account(&env.a.network_state).unwrap();
                        gone.owner = system_id();
                        gone.data = vec![];
                        env.svm.set_account(env.a.network_state, gone).unwrap();
                        treasury = Address::new_unique();
                        env.svm.airdrop(&treasury, 1_000_000_000).unwrap();
                        assert_eq!(ix.accounts[5].pubkey, env.orao_treasury);
                        ix.accounts[5].pubkey = treasury;
                    }
                    let round_l0 = env.lamports(&round_address(id));
                    let caller0 = env.lamports(&caller.pubkey());
                    let treasury0 = env.lamports(&treasury);
                    let meta = send(&mut env, &caller, ix).unwrap_or_else(|f| {
                        panic!(
                            "legacy {legacy} fulfilled {fulfilled} fee {fee_risen} \
                             state {state_gone}: {}\n{}",
                            f.err,
                            f.logs.join("\n")
                        )
                    });
                    let r = env.round(id);
                    assert_eq!(r.status, RoundStatus::Requested);
                    assert_eq!((r.funded, r.seed, addr(r.randomness)), (0, seed, request));
                    assert_eq!(events::<RoundDrawRequested>(&meta)[0].funded, 0);
                    assert_eq!(
                        env.lamports(&round_address(id)),
                        round_l0 - r0.request_share,
                        "the round loses only the request share"
                    );
                    assert_eq!(env.lamports(&caller.pubkey()), caller0 + r0.request_share);
                    assert_eq!(env.lamports(&treasury), treasury0);
                    assert_eq!(env.lamports(&round_vrf_address(id)), 0);
                    assert_eq!(env.svm.get_account(&request).unwrap(), request_before);
                    let c = beacon::draw_cost(r.funded, r.request_share, 0).unwrap();
                    assert_eq!(c, r.request_share);
                    assert!(c <= r.draw_max, "C ≤ D_r (fact 1)");
                }
            }
        }
    }

    // --- stray lamports -----------------------------------------------------------------

    /// Lamports anyone sent to `round_vrf` are swept into the round, which
    /// still pays ORAO exactly the request's cost: `round_vrf` ends empty.
    #[test]
    fn stray_lamports_on_round_vrf_go_to_the_round() {
        let mut env = setup();
        let id = paid_round(&mut env);
        let stray = 2_000_000;
        env.svm.airdrop(&round_vrf_address(id), stray).unwrap();
        to_window(&mut env, id);
        let round_l0 = env.lamports(&round_address(id));
        let (_, meta) = env.request_round_draw(id).unwrap();
        let r = env.round(id);
        assert_eq!(r.funded, needed(&env));
        assert_eq!(
            env.lamports(&round_address(id)),
            round_l0 + stray - needed(&env) - r.request_share
        );
        assert_eq!(env.lamports(&round_vrf_address(id)), 0);
        assert_eq!(events::<RoundDrawRequested>(&meta)[0].funded, needed(&env));
    }

    /// Lamports sent to the request address before ORAO creates it: ORAO's
    /// initialisation tops it up to the rent and takes the rest of what it
    /// was given back to the round, so `funded` is what ORAO actually took
    /// and `round_vrf` ends empty. Below and above the pending rent, and
    /// together with lamports on `round_vrf`.
    #[test]
    fn stray_lamports_on_the_request_address_lower_the_cost() {
        for (stray, vrf_stray) in [
            (1_000_000u64, 0u64),
            (0, 0),
            (10_000_000, 0),
            (1_000_000, 3_000_000),
        ] {
            let mut env = setup();
            let id = paid_round(&mut env);
            to_window(&mut env, id);
            let request = env.round_request_address(id);
            if stray > 0 {
                env.svm.airdrop(&request, stray).unwrap();
            }
            if vrf_stray > 0 {
                env.svm.airdrop(&round_vrf_address(id), vrf_stray).unwrap();
            }
            let round_l0 = env.lamports(&round_address(id));
            let treasury0 = env.lamports(&env.orao_treasury);
            env.request_round_draw(id).unwrap();
            let r = env.round(id);
            let taken = ORAO_FEE + pending_rent(&env).saturating_sub(stray);
            assert_eq!(r.funded, taken, "stray {stray}");
            assert_eq!(
                env.lamports(&round_address(id)),
                round_l0 + vrf_stray - taken - r.request_share
            );
            assert_eq!(env.lamports(&round_vrf_address(id)), 0);
            assert_eq!(env.lamports(&env.orao_treasury), treasury0 + ORAO_FEE);
            assert_eq!(
                env.lamports(&request),
                pending_rent(&env).max(stray),
                "the request keeps what it was sent"
            );
            assert_eq!(
                orao_layout::randomness(&data_of(&env, &request)),
                Some(orao_layout::Randomness::Pending)
            );
        }
    }

    // --- DrawUnderfunded ------------------------------------------------------------------

    /// `fee + rent(PENDING_LEN) + request_share ≤ D_r`: one lamport of fee
    /// beyond the margin is refused, nothing moved, however much the round
    /// holds; at exactly the margin the request goes through and the draw
    /// costs exactly `D_r`.
    #[test]
    fn a_draw_above_the_prefund_is_refused() {
        let mut env = setup();
        let id = paid_round(&mut env);
        to_window(&mut env, id);
        let r = env.round(id);
        assert_eq!(r.draw_max, env.draw_max());
        let caller = funded_caller(&mut env);
        let request = env.round_request_address(id);
        let margin = 2 * ORAO_FEE;
        assert_eq!(margin + pending_rent(&env) + r.request_share, r.draw_max);
        set_orao_fee(&mut env, margin + 1);
        refused(&mut env, &caller, id, &request, FadeError::DrawUnderfunded);

        // Sponsorship cannot rescue it: the bound is the snapshot `D_r`, not
        // what the round holds (§13.10 point 7, as decided in step 7).
        let extra = 10_000_000_000;
        let l = env.lamports(&round_address(id));
        env.set_round(id, Some(l + extra), |r| r.sponsorship += extra);
        refused(&mut env, &caller, id, &request, FadeError::DrawUnderfunded);
        env.set_round(id, Some(l), |r| r.sponsorship -= extra);

        set_orao_fee(&mut env, margin);
        let treasury0 = env.lamports(&env.orao_treasury);
        let round_l0 = env.lamports(&round_address(id));
        let ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
        send(&mut env, &caller, ix).unwrap();
        let r = env.round(id);
        assert_eq!(r.funded + r.request_share, r.draw_max, "the whole prefund");
        assert_eq!(env.lamports(&env.orao_treasury), treasury0 + margin);
        assert_eq!(env.lamports(&round_address(id)), round_l0 - r.draw_max);
        assert!(env.lamports(&round_address(id)) >= rent(&env, ROUND_LEN));
    }

    /// The bound and the share paid are the round's snapshot: after the
    /// request share is lowered, a fee within the live margin but beyond the
    /// snapshot one is refused, and the caller is paid the snapshot share.
    #[test]
    fn the_request_uses_the_rounds_request_share() {
        let mut env = setup();
        let id = paid_round(&mut env);
        let mut params = env.config().params;
        params.crank_request_lamports = 10_000;
        env.set_params(params).unwrap();
        assert_eq!(env.config().params.crank_request_lamports, 10_000);
        let r = env.round(id);
        assert_eq!(r.request_share, 50_000);
        to_window(&mut env, id);
        let caller = funded_caller(&mut env);
        let request = env.round_request_address(id);
        let fee = 2 * ORAO_FEE + 1;
        assert!(beacon::request_fits(
            fee,
            pending_rent(&env),
            10_000,
            r.draw_max
        ));
        set_orao_fee(&mut env, fee);
        refused(&mut env, &caller, id, &request, FadeError::DrawUnderfunded);
        set_orao_fee(&mut env, ORAO_FEE);
        let caller0 = env.lamports(&caller.pubkey());
        let ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
        send(&mut env, &caller, ix).unwrap();
        assert_eq!(env.lamports(&caller.pubkey()), caller0 + 50_000);
    }

    /// The round's books are checked before any lamport moves: a round
    /// holding less than its prepays and sponsorship, or whose prepays and
    /// sponsorship do not cover the request, is refused rather than paying
    /// the draw out of its rent. Consistent books always pass.
    #[test]
    fn inconsistent_books_fail_closed() {
        let mut env = setup();
        let id = paid_round(&mut env);
        to_window(&mut env, id);
        let caller = funded_caller(&mut env);
        let request = env.round_request_address(id);
        let r = env.round(id);
        let l = env.lamports(&round_address(id));
        env.set_round(id, Some(l - 1), |_| {});
        refused(&mut env, &caller, id, &request, FadeError::MathOverflow);
        env.set_round(id, Some(l), |_| {});
        let spend = needed(&env) + r.request_share;
        env.set_round(id, None, |r| {
            r.prepaid = spend - 1;
            r.sponsorship = 0;
        });
        refused(&mut env, &caller, id, &request, FadeError::DrawUnderfunded);
        env.set_round(id, None, |x| {
            x.prepaid = r.prepaid;
            x.sponsorship = r.sponsorship;
        });
        let ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
        send(&mut env, &caller, ix).unwrap();
    }

    /// A round its sponsorship pays (review of step 7): its prepay alone does
    /// not cover the request, prepay and sponsorship do (§13.5.6,
    /// `Σ prepay + S ≥ D_r`). A lone ticket carrying the sponsorship that pays
    /// its round (§13.9, §13.10 point 6), and a lone ticket whose round
    /// `sponsor_round` pays: one ticket recorded at the payment, the request
    /// accepted, the round paying ORAO and the caller out of what it holds,
    /// keeping its rent and the rest of its prepay and sponsorship.
    #[test]
    fn a_round_paid_by_sponsorship_is_requested() {
        for in_the_join in [true, false] {
            let mut env = setup();
            let id = env.joining_round();
            let params = env.config().params;
            let terms = beacon::Terms {
                threshold: params.beacon_threshold,
                draw_max: env.draw_max(),
                round_k: params.round_k as u8,
            };
            let price = USDC;
            let s = beacon::sponsorship_to_pay(&terms, price, 0).unwrap();
            let player = env.user(10 * USDC);
            if in_the_join {
                env.join(&player, &coin_flip(), price, 0, s).unwrap();
            } else {
                env.join(&player, &coin_flip(), price, 0, 0).unwrap();
                assert_eq!(env.round(id).status, RoundStatus::Accepting);
                let sponsor = funded_caller(&mut env);
                env.sponsor(&sponsor, id, s).unwrap();
            }
            let r0 = env.round(id);
            assert_eq!(r0.status, RoundStatus::Paid);
            assert_eq!(
                (r0.tickets, r0.counted, r0.side),
                (1, true, Ticket::SIDE_AFTER)
            );
            assert_eq!(env.vault().open_after_close, 1, "one ticket, one count");
            let spend = needed(&env) + r0.request_share;
            assert!(
                r0.prepaid < spend,
                "the prepay alone does not cover the request"
            );
            assert!(r0.prepaid + r0.sponsorship >= spend);
            to_window(&mut env, id);
            let caller = funded_caller(&mut env);
            let request = env.round_request_address(id);
            let l0 = env.lamports(&round_address(id));
            assert_eq!(l0, rent(&env, ROUND_LEN) + r0.prepaid + r0.sponsorship);
            let c0 = env.lamports(&caller.pubkey());
            let ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
            send(&mut env, &caller, ix).unwrap();
            let r = env.round(id);
            assert_eq!((r.status, r.funded), (RoundStatus::Requested, needed(&env)));
            assert_eq!(
                env.lamports(&round_address(id)),
                rent(&env, ROUND_LEN) + r0.prepaid + r0.sponsorship - spend,
                "the round paid the request out of its prepay and sponsorship"
            );
            assert_eq!(env.lamports(&caller.pubkey()), c0 + r0.request_share);
            assert_eq!(env.lamports(&round_vrf_address(id)), 0);
            assert_eq!(env.vault().open_after_close, 1);
        }
    }

    /// The books at their boundary: prepays and sponsorship exactly
    /// `needed + request_share`, the round holding exactly its rent and
    /// those, are requested, and the round is left at its rent; a lamport
    /// less of what it holds is refused and moves nothing. Prepays and
    /// sponsorship count together: all prepay, all sponsorship, or both.
    #[test]
    fn the_books_at_their_boundary() {
        for split in 0..3 {
            let mut env = setup();
            let id = paid_round(&mut env);
            to_window(&mut env, id);
            let caller = funded_caller(&mut env);
            let request = env.round_request_address(id);
            let spend = needed(&env) + env.round(id).request_share;
            let (prepaid, sponsorship) = match split {
                0 => (spend, 0),
                1 => (0, spend),
                _ => (spend / 2, spend - spend / 2),
            };
            let floor = rent(&env, ROUND_LEN);
            // One lamport short, the round's lamports consistent with its books.
            env.set_round(id, Some(floor + spend - 1), |r| {
                r.prepaid = prepaid;
                r.sponsorship = sponsorship;
                if sponsorship > 0 {
                    r.sponsorship -= 1;
                } else {
                    r.prepaid -= 1;
                }
            });
            refused(&mut env, &caller, id, &request, FadeError::DrawUnderfunded);
            env.set_round(id, Some(floor + spend), |r| {
                r.prepaid = prepaid;
                r.sponsorship = sponsorship;
            });
            let ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
            send(&mut env, &caller, ix).unwrap();
            assert_eq!(env.round(id).status, RoundStatus::Requested);
            assert_eq!(
                env.lamports(&round_address(id)),
                floor,
                "the round keeps exactly its rent"
            );
        }
    }

    /// ORAO's network state and treasury: an account at the network state's
    /// address ORAO does not own is unreadable, another treasury is refused.
    #[test]
    fn orao_state_is_checked() {
        let mut env = setup();
        let id = paid_round(&mut env);
        to_window(&mut env, id);
        let caller = funded_caller(&mut env);
        let request = env.round_request_address(id);

        let mut ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
        let other = Address::new_unique();
        env.svm.airdrop(&other, 1_000_000_000).unwrap();
        ix.accounts[5].pubkey = other;
        let code = fade_error(FadeError::TreasuryMismatch);
        refused_ix(&mut env, &caller, ix, id, &request, |f| f.has_code(code));

        let ns = env.svm.get_account(&env.a.network_state).unwrap();
        let mut forged = ns.clone();
        forged.owner = system_id();
        forged.data = vec![];
        env.svm.set_account(env.a.network_state, forged).unwrap();
        refused(
            &mut env,
            &caller,
            id,
            &request,
            FadeError::NetworkStateUnreadable,
        );
        env.svm.set_account(env.a.network_state, ns).unwrap();
        let ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
        send(&mut env, &caller, ix).unwrap();
    }

    // --- the epoch counters -----------------------------------------------------------

    /// The side is the payment's (§13.7): a round paid while an epoch is live
    /// and before its close goes `before` it at once, and the strike waits for
    /// every one of its tickets; a round paid at the close exactly goes `after`
    /// it. A request, before or after the close, records nothing.
    #[test]
    fn both_sides_of_an_epoch_close() {
        let mut env = setup();
        let lp = env.user(1_000 * USDC);
        env.deposit(&lp, 100 * USDC).unwrap();
        let close_ts = env.vault().close_ts;
        assert!(close_ts > env.now());
        let g = env.vault().generation;

        // Paid before the close.
        let one = paid_round(&mut env);
        let r1 = env.round(one);
        assert_eq!((r1.side, r1.generation), (Ticket::SIDE_BEFORE, g));
        let v = env.vault();
        assert_eq!((v.open_before_close, v.open_after_close), (2, 0));
        assert_fails_with(env.strike(), FadeError::EpochNotClosed);

        // Paid at the close exactly: after it.
        let close = r1.close_slot;
        env.set_time(close, close_ts);
        let two = paid_round(&mut env);
        let r2 = env.round(two);
        assert_eq!((r2.side, r2.generation), (Ticket::SIDE_AFTER, g));
        let v = env.vault();
        assert_eq!((v.open_before_close, v.open_after_close), (2, 2));

        // Round 1 requested after the close is still before it; round 2
        // requested is still after it. Neither request moves a counter.
        to_window(&mut env, one);
        assert!(env.now() >= close_ts);
        let (_, meta) = env.request_round_draw(one).unwrap();
        let e = &events::<RoundDrawRequested>(&meta)[0];
        assert_eq!((e.side, e.generation), (Ticket::SIDE_BEFORE, g));
        to_window(&mut env, two);
        let (_, meta) = env.request_round_draw(two).unwrap();
        let e = &events::<RoundDrawRequested>(&meta)[0];
        assert_eq!((e.side, e.generation), (Ticket::SIDE_AFTER, g));
        assert_eq!(serialized(&env.vault()), serialized(&v));
        let (r1, r2) = (env.round(one), env.round(two));
        assert_eq!(
            (r1.side, r2.side),
            (Ticket::SIDE_BEFORE, Ticket::SIDE_AFTER)
        );

        // The round recorded before holds the strike; the one recorded after does not.
        assert_fails_with(env.strike(), FadeError::StrikeNotClean);
        let mut c = v.counters();
        c.close_n(r1.side().unwrap(), r1.generation, r1.tickets)
            .unwrap();
        assert!(
            fade_math::epoch::can_strike(true, close_ts, close_ts, &c),
            "once round 1's tickets leave, as settlement will release them, the strike runs"
        );
        c.close_n(r2.side().unwrap(), r2.generation, r2.tickets)
            .unwrap();
        assert_eq!(
            (c.before, c.after),
            (0, 0),
            "each round leaves its own counter"
        );
    }

    /// A round paid after the close, its tickets still open, leaves the
    /// strike free; its tickets stay countable across the strike.
    #[test]
    fn a_round_paid_after_the_close_does_not_hold_the_strike() {
        let mut env = setup();
        let lp = env.user(1_000 * USDC);
        let epoch = env.deposit(&lp, 100 * USDC).unwrap();
        env.pass_close();
        let g = env.vault().generation;
        let id = paid_round(&mut env);
        let r = env.round(id);
        assert_eq!((r.side, r.generation), (Ticket::SIDE_AFTER, g));
        to_window(&mut env, id);
        env.request_round_draw(id).unwrap();
        let v = env.vault();
        let settled = v.total_assets - v.open_vault_credits;
        assert_eq!(env.strike().unwrap(), epoch);
        assert_eq!(
            env.record(epoch).total_assets,
            settled,
            "the round's credits stay out of the price"
        );
        let mut c = env.vault().counters();
        c.close_n(r.side().unwrap(), r.generation, r.tickets)
            .unwrap();
        assert_eq!((c.before, c.after), (0, 0));
    }

    /// The attack of a request created in advance (review of step 7). The
    /// round's seed is public from the slot after its close, so anyone can
    /// create its ORAO request directly, have it fulfilled within seconds and
    /// know every ticket's result before the round's own request. Had the
    /// request recorded the round on the side of its own time, whoever knew
    /// the results would choose the side: a known loss requested at or after
    /// the close stays out of the strike a queued withdrawal leaves at, and a
    /// known gain the same way goes to the next epoch, after a deposit bought
    /// in at a price without it; nor would the strike wait for a round not
    /// yet requested. Recorded at its payment, the round is `before` the
    /// close: the strike waits for it while it is unrequested past the close,
    /// and a request before or after the close, of a pending or fulfilled
    /// request created by anyone, v2 or legacy, changes neither its side nor
    /// a counter.
    #[test]
    fn a_known_result_does_not_choose_its_side() {
        for after_close in [false, true] {
            for legacy in [false, true] {
                let mut env = setup();
                let lp = env.user(1_000 * USDC);
                env.deposit(&lp, 100 * USDC).unwrap();
                let close_ts = env.vault().close_ts;
                let g = env.vault().generation;
                let id = paid_round(&mut env);
                to_window(&mut env, id);
                assert!(env.now() < close_ts);
                let request = env.round_request_address(id);
                let seed = env.round_seed(id);
                let someone = funded_caller(&mut env);
                let ix = orao_request_ix(&env, &someone.pubkey(), &request, seed, legacy);
                env.send(&[ix], &[&someone]).unwrap();
                env.fulfill(&request, [3u8; 64]);
                let v0 = env.vault();
                assert_eq!((v0.open_before_close, v0.open_after_close), (2, 0));
                let slot = env.slot();
                if after_close {
                    env.set_time(slot, close_ts);
                    assert_fails_with(env.strike(), FadeError::StrikeNotClean);
                }
                let (_, meta) = env.request_round_draw(id).unwrap();
                let r = env.round(id);
                assert_eq!((r.status, r.funded), (RoundStatus::Requested, 0));
                assert_eq!((r.side, r.generation), (Ticket::SIDE_BEFORE, g));
                let e = &events::<RoundDrawRequested>(&meta)[0];
                assert_eq!((e.side, e.generation), (Ticket::SIDE_BEFORE, g));
                assert_eq!(serialized(&env.vault()), serialized(&v0));
                env.set_time(slot + 1, close_ts);
                assert_fails_with(env.strike(), FadeError::StrikeNotClean);
            }
        }
    }

    /// A round paid while no epoch is live goes `after`; an epoch opened
    /// before its draw moves its tickets `before` that epoch's close, as for
    /// a direct ticket, and its joins until the close follow it there. A
    /// round paid `before` a close keeps its later joins `before` it, even a
    /// join at the close. Each round's tickets leave with one `close_n`.
    #[test]
    fn joins_after_the_payment_follow_the_round() {
        let mut env = setup();
        let g = env.vault().generation;
        assert_eq!(env.vault().close_ts, 0);
        let id = paid_round(&mut env);
        let r = env.round(id);
        assert_eq!((r.side, r.generation), (Ticket::SIDE_AFTER, g));
        assert!(env.slot() < r.close_slot, "a paid round takes joins");
        let lp = env.user(1_000 * USDC);
        env.deposit(&lp, 100 * USDC).unwrap();
        let close_ts = env.vault().close_ts;
        let v = env.vault();
        assert_eq!(
            (v.open_before_close, v.open_after_close, v.generation),
            (2, 0, g + 1),
            "the epoch's opening moved the round before its close"
        );
        let p = env.user(10 * USDC);
        assert_eq!(env.joining_round(), id);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let r = env.round(id);
        assert_eq!(
            (r.tickets, r.side, r.generation),
            (3, Ticket::SIDE_AFTER, g)
        );
        let v = env.vault();
        assert_eq!((v.open_before_close, v.open_after_close), (3, 0));
        let slot = env.slot();
        env.set_time(slot, close_ts);
        // Moved before the close by the epoch's opening, the round takes no
        // join from that close on, and nothing moves.
        let p = env.user(10 * USDC);
        let (v0, r0) = (env.vault(), env.round(id));
        assert_fails_with(
            env.join(&p, &coin_flip(), USDC, 0, 0).map(|_| ()),
            FadeError::RoundEpochClosed,
        );
        assert_eq!(serialized(&env.vault()), serialized(&v0));
        assert_eq!(serialized(&env.round(id)), serialized(&r0));
        assert_fails_with(env.strike(), FadeError::StrikeNotClean);
        let mut c = v.counters();
        c.close_n(r.side().unwrap(), r.generation, r.tickets)
            .unwrap();
        assert!(c.clean());

        // Paid before the close: joined just before it, still before it; at
        // the close and after it, refused (Spec 01 §3.5: the price contains
        // only tickets opened before the close), and nothing moves.
        let mut env = setup();
        let lp = env.user(1_000 * USDC);
        env.deposit(&lp, 100 * USDC).unwrap();
        let close_ts = env.vault().close_ts;
        let g = env.vault().generation;
        let id = paid_round(&mut env);
        assert_eq!(env.round(id).side, Ticket::SIDE_BEFORE);
        let slot = env.slot();
        assert!(slot < env.round(id).close_slot);
        env.set_time(slot, close_ts - 1);
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let r = env.round(id);
        assert_eq!(
            (r.tickets, r.side, r.generation),
            (3, Ticket::SIDE_BEFORE, g)
        );
        let v = env.vault();
        assert_eq!((v.open_before_close, v.open_after_close), (3, 0));
        for t in [close_ts, close_ts + 1] {
            env.set_time(slot, t);
            let p = env.user(10 * USDC);
            assert_eq!(env.joining_round(), id, "the round still accepts by slot");
            assert_fails_with(
                env.join(&p, &coin_flip(), USDC, 0, 0).map(|_| ()),
                FadeError::RoundEpochClosed,
            );
            assert_eq!(serialized(&env.vault()), serialized(&v));
            assert_eq!(serialized(&env.round(id)), serialized(&r));
        }
        assert_fails_with(env.strike(), FadeError::StrikeNotClean);

        // A paid round whose record is inconsistent takes no join, and
        // nothing moves.
        env.set_round(id, None, |r| r.counted = false);
        let p = env.user(10 * USDC);
        let v0 = env.vault();
        assert_fails_with(
            env.join(&p, &coin_flip(), USDC, 0, 0).map(|_| ()),
            FadeError::WrongRoundStatus,
        );
        assert_eq!(serialized(&env.vault()), serialized(&v0));
    }

    /// `sponsor_round` that pays a round records it as a join that pays it
    /// does; a top-up of a paid round records nothing more.
    #[test]
    fn a_sponsorship_that_pays_the_round_records_it() {
        let mut env = setup();
        let lp = env.user(1_000 * USDC);
        env.deposit(&lp, 100 * USDC).unwrap();
        let g = env.vault().generation;
        let p = env.user(10 * USDC);
        let id = env.joining_round();
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let r0 = env.round(id);
        assert_eq!((r0.status, r0.counted), (RoundStatus::Accepting, false));
        let v0 = env.vault();
        let s = beacon::sponsorship_to_pay(&r0.terms(), r0.prices, r0.sponsorship).unwrap();
        let sponsor = funded_caller(&mut env);
        env.sponsor(&sponsor, id, s).unwrap();
        let r = env.round(id);
        assert_eq!(r.status, RoundStatus::Paid);
        assert_eq!(
            (r.counted, r.side, r.generation),
            (true, Ticket::SIDE_BEFORE, g)
        );
        let v = env.vault();
        assert_eq!(v.open_before_close, v0.open_before_close + 1);
        assert_eq!(v.open_after_close, v0.open_after_close);
        env.sponsor(&sponsor, id, 1_000).unwrap();
        assert_eq!(serialized(&env.vault()), serialized(&v));
    }

    // --- what a requested round no longer takes ------------------------------------------

    /// Once requested, a round takes no sponsorship and no join: a join lands
    /// in the next round, the requested one keeps its prices.
    #[test]
    fn a_requested_round_takes_nothing_more() {
        let mut env = setup();
        let id = paid_round(&mut env);
        to_window(&mut env, id);
        env.request_round_draw(id).unwrap();
        let r = env.round(id);
        let s = funded_caller(&mut env);
        assert_fails_with(env.sponsor(&s, id, 1_000), FadeError::RoundNotAccepting);
        let p = env.user(10 * USDC);
        assert_eq!(env.joining_round(), id + 1);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let after = env.round(id);
        assert_eq!(serialized(&after), serialized(&r));
        assert_eq!(env.round(id + 1).tickets, 1);
    }

    // --- the accounts -----------------------------------------------------------------

    /// Every account is pinned: the vault and the round by their seeds,
    /// `round_vrf` by the round's, the sysvar, ORAO and its network state by
    /// address; remaining accounts are refused, first.
    #[test]
    fn the_accounts_are_checked() {
        let mut env = setup();
        let id = paid_round(&mut env);
        to_window(&mut env, id);
        let caller = funded_caller(&mut env);
        let request = env.round_request_address(id);
        let base = env.request_round_draw_ix(&caller.pubkey(), id, &request);
        let field = |name: &str| -> usize {
            [
                "caller",
                "round",
                "round_vrf",
                "slot_hashes",
                "orao_network_state",
                "orao_treasury",
                "request",
                "orao_program",
            ]
            .iter()
            .position(|n| *n == name)
            .unwrap()
        };

        // A copy of the round at another address the program owns.
        let forged_round = Address::new_unique();
        let acc = env.svm.get_account(&round_address(id)).unwrap();
        env.svm.set_account(forged_round, acc).unwrap();
        let other_vrf = round_vrf_address(id + 1);
        let fake_ns = Address::new_unique();
        let acc = env.svm.get_account(&env.a.network_state).unwrap();
        env.svm.set_account(fake_ns, acc).unwrap();
        let cases: Vec<(&str, Address, u32)> = vec![
            ("round", forged_round, 2006),
            ("round_vrf", other_vrf, 2006),
            ("slot_hashes", Address::new_unique(), 2012),
            ("orao_network_state", fake_ns, 2006),
            ("orao_program", system_id(), 2012),
        ];
        for (name, wrong, code) in cases {
            let mut ix = base.clone();
            ix.accounts[field(name)].pubkey = wrong;
            refused_ix(&mut env, &caller, ix, id, &request, |f| f.has_code(code));
        }
        let mut ix = base.clone();
        ix.accounts
            .push(AccountMeta::new_readonly(Address::new_unique(), false));
        let code = fade_error(FadeError::RemainingAccounts);
        refused_ix(&mut env, &caller, ix, id, &request, |f| f.has_code(code));
        send(&mut env, &caller, base).unwrap();
    }

    /// Remaining accounts are checked before the round's status.
    #[test]
    fn remaining_accounts_come_first() {
        let mut env = setup();
        let p = env.user(10 * USDC);
        env.join(&p, &coin_flip(), USDC, 0, 0).unwrap();
        let caller = funded_caller(&mut env);
        let dummy = Address::new_unique();
        let mut ix = env.request_round_draw_ix(&caller.pubkey(), 1, &dummy);
        ix.accounts
            .push(AccountMeta::new_readonly(Address::new_unique(), false));
        let code = fade_error(FadeError::RemainingAccounts);
        refused_ix(&mut env, &caller, ix, 1, &dummy, |f| f.has_code(code));
    }

    fn tx_len(env: &Env, ix: &Instruction, signers: &[&Keypair]) -> usize {
        let tx = solana_transaction::Transaction::new_signed_with_payer(
            std::slice::from_ref(ix),
            Some(&signers[0].pubkey()),
            signers,
            env.svm.latest_blockhash(),
        );
        1 + 64 * tx.signatures.len() + tx.message_data().len()
    }

    /// Compute units and transaction size of `request_round_draw`.
    #[test]
    fn compute_units() {
        let mut env = setup();
        let id = paid_round(&mut env);
        env.svm.airdrop(&round_vrf_address(id), 1_000_000).unwrap();
        to_window(&mut env, id);
        let keeper = env.keeper.insecure_clone();
        let request = env.round_request_address(id);
        let ix = env.request_round_draw_ix(&keeper.pubkey(), id, &request);
        let size = tx_len(&env, &ix, &[&keeper]);
        let m = env.send(&[ix], &[&keeper]).unwrap();
        eprintln!(
            "CU request_round_draw (sweeping round_vrf, creating the request): {}; {size}-byte transaction, one signer",
            m.compute_units_consumed
        );
        assert!(size <= 1_232);
        assert!(m.compute_units_consumed < 100_000);

        let close = env.round(id).close_slot;
        at_slot(&mut env, close);
        let two = paid_round(&mut env);
        to_window(&mut env, two);
        let m = env.request_round_draw(two).unwrap().1;
        eprintln!(
            "CU request_round_draw (creating the request): {}",
            m.compute_units_consumed
        );
        let close = env.round(two).close_slot;
        at_slot(&mut env, close);
        let three = paid_round(&mut env);
        to_window(&mut env, three);
        let request = env.round_request_address(three);
        let seed = env.round_seed(three);
        let someone = funded_caller(&mut env);
        let ix = orao_request_ix(&env, &someone.pubkey(), &request, seed, false);
        env.send(&[ix], &[&someone]).unwrap();
        let m = env.request_round_draw(three).unwrap().1;
        eprintln!(
            "CU request_round_draw (request pre-created): {}",
            m.compute_units_consumed
        );
    }
}

/// `settle_round_tickets` and `claim_round_payout` (Spec 08 §13.5.7,
/// §13.5.11), after the real `join_round`,
/// `sponsor_round`, `request_round_draw` and the ORAO stand-in's fulfilment.
mod settle_round_tickets {
    use super::*;
    use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
    use fade::events::{RoundClosed, RoundDrawn, RoundPayoutClaimed, RoundTicketSettled};
    use fade::state::{Integrator, Outcome, RoundStatus, RoundTicket, RoundTicketStatus};
    use fade_math::epoch::Side;
    use fade_math::{beacon, orao_layout};
    use litesvm::types::TransactionMetadata;
    use solana_account::Account;
    use solana_address::Address;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_keypair::Keypair;
    use solana_message::AddressLookupTableAccount;
    use solana_signer::Signer;
    use std::collections::BTreeMap;

    const VAULT: u64 = 100_000 * USDC;
    const ROUND_LEN: usize = 411;
    const TICKET_LEN: usize = 291;
    const LIMIT: usize = 1_232;
    /// Accounts a transaction may lock on the mainnet feature set the tests
    /// run on (`increase_tx_account_lock_limit`, which raises it to 128, is
    /// not active there).
    const LOCKS: usize = 64;

    pub(super) fn setup() -> Env {
        let mut env = Env::new();
        env.found(VAULT);
        let k = env.keeper.insecure_clone();
        for t in [coin_flip(), slot_classic()] {
            env.register_payout_table(&k, &t).unwrap();
        }
        env
    }

    pub(super) fn rent(env: &Env, len: usize) -> u64 {
        env.svm.minimum_balance_for_rent_exemption(len)
    }

    pub(super) fn funded(env: &mut Env) -> Keypair {
        let kp = Keypair::new();
        env.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        kp
    }

    pub(super) fn at_slot(env: &mut Env, slot: u64) {
        let now = env.now();
        env.set_time(slot, now);
    }

    /// Who joins: integrators (each with its share account), payers, and
    /// one funder; every ticket gets a beneficiary of its own.
    pub(super) struct Cast {
        pub(super) integrators: Vec<Keypair>,
        pub(super) shares: Vec<Address>,
        pub(super) payers: Vec<Keypair>,
        pub(super) funder: User,
    }

    pub(super) fn cast(env: &mut Env, integrators: usize, payers: usize) -> Cast {
        let integrators: Vec<Keypair> = (0..integrators).map(|_| funded(env)).collect();
        let shares = integrators
            .iter()
            .map(|k| env.usdc_account(&k.pubkey(), 0))
            .collect();
        let payers = (0..payers).map(|_| funded(env)).collect();
        let funder = env.user(1_000 * USDC);
        Cast {
            integrators,
            shares,
            payers,
            funder,
        }
    }

    /// One join, signed by the integrator, the payer and the funder, the
    /// keeper paying the fee; returns the ticket.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn join_as(
        env: &mut Env,
        authority: &Keypair,
        share: Address,
        payer: &Keypair,
        funder: &User,
        beneficiary: Address,
        table: &[Outcome],
        price: u64,
        sponsorship: u64,
    ) -> Address {
        let (round, next_round) = env.round_pair();
        let target = round_address(env.joining_round());
        let j = JoinArgs {
            authority: authority.pubkey(),
            payer: payer.pubkey(),
            funder: funder.key(),
            funder_usdc: funder.usdc,
            share_account: Some(share),
            beneficiary,
            payout_table: env.payout_table_address(table),
            price,
            app_share_bps: 50,
            nonce: env.next_nonce(&authority.pubkey()),
            sponsorship,
            round,
            next_round,
            sponsorship_record: (sponsorship > 0)
                .then(|| sponsorship_address(&target, &payer.pubkey())),
        };
        let ix = env.join_round_ix(&j);
        let keeper = env.keeper.insecure_clone();
        let fk = funder.kp.insecure_clone();
        let mut signers: Vec<&Keypair> = vec![&keeper];
        for k in [authority, payer, &fk] {
            if !signers.iter().any(|s| s.pubkey() == k.pubkey()) {
                signers.push(k);
            }
        }
        env.send(&[ix], &signers).unwrap();
        env.round_ticket_address(&authority.pubkey(), j.nonce)
    }

    /// `n` tickets in the round a join lands in now: ticket `i` by
    /// integrator `i mod k` and payer `i mod p`, every third on the slot
    /// table, prices from 0.50 to 0.90 USDC; the last join carries what
    /// pays the round if it is not paid yet. Returns the round and tickets.
    pub(super) fn fill(env: &mut Env, cast: &Cast, n: usize) -> (u64, Vec<Address>) {
        fill_with(env, cast, n, &[coin_flip(), coin_flip(), slot_classic()])
    }

    /// `fill` with ticket `i` on `tables[i mod len]`.
    fn fill_with(
        env: &mut Env,
        cast: &Cast,
        n: usize,
        tables: &[Vec<Outcome>],
    ) -> (u64, Vec<Address>) {
        let id = env.joining_round();
        let mut tickets = Vec::new();
        for i in 0..n {
            let table = tables[i % tables.len()].clone();
            let price = 500_000 + (i as u64 % 5) * 100_000;
            let a = i % cast.integrators.len();
            let p = i % cast.payers.len();
            let beneficiary = env.usdc_account(&Address::new_unique(), 0);
            let sponsorship = if i + 1 == n {
                let (terms, prices, s) = if env.exists(&round_address(id)) {
                    let r = env.round(id);
                    (r.terms(), r.prices, r.sponsorship)
                } else {
                    let p = env.config().params;
                    (
                        beacon::Terms {
                            threshold: p.beacon_threshold,
                            draw_max: env.draw_max(),
                            round_k: p.round_k as u8,
                        },
                        0,
                        0,
                    )
                };
                beacon::sponsorship_to_pay(&terms, prices + price, s).unwrap()
            } else {
                0
            };
            let t = join_as(
                env,
                &cast.integrators[a],
                cast.shares[a],
                &cast.payers[p],
                &cast.funder,
                beneficiary,
                &table,
                price,
                sponsorship,
            );
            tickets.push(t);
        }
        assert_eq!(env.round(id).status, RoundStatus::Paid);
        assert_eq!(env.round(id).tickets as usize, n);
        (id, tickets)
    }

    /// Requests round `id` in the first slot of its window and fulfils it with
    /// the first randomness for which `pred` holds of its tickets' wins.
    pub(super) fn draw(
        env: &mut Env,
        id: u64,
        tickets: &[Address],
        pred: impl Fn(&[bool]) -> bool,
    ) {
        let close = env.round(id).close_slot;
        at_slot(env, close + 2);
        env.request_round_draw(id).unwrap();
        let r = env.round_randomness_with(id, tickets, pred);
        env.fulfill_round(id, r);
    }

    pub(super) fn mixed(w: &[bool]) -> bool {
        w.len() < 2 || (w.iter().any(|x| *x) && w.iter().any(|x| !*x))
    }

    /// The accounts of round `id` a keeper's lookup table holds: the fixed
    /// accounts of the instruction, the round's own, and `shared`.
    fn round_table(env: &mut Env, id: u64, shared: &[Address]) -> AddressLookupTableAccount {
        let round = env.round(id);
        let mut v = vec![
            env.a.config,
            env.a.vault,
            round_address(id),
            round_vrf_address(id),
            addr(round.randomness),
            env.a.payout_escrow,
            env.a.vault_usdc,
            env.a.vault_authority,
            env.a.usdc_mint,
            fade_testkit::token::token_program_id(),
            system_id(),
            addr(round.rent_payer),
            env.a.event_authority,
        ];
        for a in shared {
            if !v.contains(a) {
                v.push(*a);
            }
        }
        env.lookup_table(&v)
    }

    fn tx_size(tx: &solana_transaction::versioned::VersionedTransaction) -> usize {
        1 + 64 * tx.signatures.len() + tx.message.serialize().len()
    }

    pub(super) fn vault_slack(env: &Env) -> u64 {
        let v = env.vault();
        env.balance(&env.a.vault_usdc)
            - (v.total_assets
                + v.beacon_shares_held
                + v.protocol_shares_accrued
                + v.app_shares_owed
                + v.beacon_returns_owed)
    }

    /// Settles `tickets` of round `id` in one batch, sent by `caller` with
    /// the keeper paying the fee through `tables`, and checks every effect
    /// against values computed here from Spec 08 §13.4 and §13.5.7: each
    /// ticket's outcome and payout, its charge, every token and lamport
    /// moved, the vault's, the integrators' and the round's books, the
    /// events, the vault identity and the conservation of lamports.
    /// Every ticket's beneficiary can receive. Returns the transaction.
    fn settle_checked(
        env: &mut Env,
        id: u64,
        tickets: &[Address],
        tables: &[AddressLookupTableAccount],
    ) -> TransactionMetadata {
        let r = env.round_randomness(id);
        settle_checked_with(env, id, &r, tickets, tables)
    }

    /// `settle_checked` with the round's randomness `r` given rather than
    /// read from the ORAO account, for a request account that is gone.
    fn settle_checked_with(
        env: &mut Env,
        id: u64,
        r: &[u8; 64],
        tickets: &[Address],
        tables: &[AddressLookupTableAccount],
    ) -> TransactionMetadata {
        let r = *r;
        let round0 = env.round(id);
        let v0 = env.vault();
        let first = round0.status == RoundStatus::Requested;
        let refund = if first {
            env.lamports(&round_vrf_address(id))
        } else {
            0
        };
        let c = if first {
            round0.funded + round0.request_share - refund.min(round0.funded)
        } else {
            round0.draw_cost
        };
        assert!(c <= round0.draw_max, "C ≤ D_r");
        let caller = funded(env);
        let rent_payer = addr(round0.rent_payer);
        let ts: Vec<RoundTicket> = tickets.iter().map(|t| env.round_ticket(t)).collect();
        let groups: Vec<Group> = tickets
            .iter()
            .map(|t| env.round_group_with(id, t, &r))
            .collect();

        // What the specification says each ticket gets.
        let to_prices = u128::from(c.saturating_sub(round0.sponsorship));
        let mut payouts = Vec::new();
        let mut charges = Vec::new();
        let mut outcomes = Vec::new();
        for (t, w) in tickets.iter().zip(&ts) {
            outcomes.push(env.beacon_outcome_with(id, t, &r));
            payouts.push(env.beacon_payout_with(id, t, &r));
            let charge = u64::try_from(
                (to_prices * u128::from(w.price)).div_ceil(u128::from(round0.prices)),
            )
            .unwrap();
            assert!(
                charge <= w.prepay,
                "no ticket charged above its prepay (fact 1)"
            );
            charges.push(charge);
        }

        // Every account whose lamports may move, and every token account.
        let mut watched = vec![
            round_address(id),
            round_vrf_address(id),
            caller.pubkey(),
            rent_payer,
        ];
        for (t, w) in tickets.iter().zip(&ts) {
            for a in [*t, addr(w.payer)] {
                if !watched.contains(&a) {
                    watched.push(a);
                }
            }
        }
        let lamports0: BTreeMap<Address, u64> =
            watched.iter().map(|a| (*a, env.lamports(a))).collect();
        let mut beneficiaries0: BTreeMap<Address, u64> = BTreeMap::new();
        for w in &ts {
            beneficiaries0.insert(addr(w.beneficiary), env.balance(&addr(w.beneficiary)));
        }
        let escrow0 = env.balance(&env.a.payout_escrow);
        let vault_usdc0 = env.balance(&env.a.vault_usdc);
        let slack0 = vault_slack(env);
        let mut integrators0: BTreeMap<Address, Integrator> = BTreeMap::new();
        for w in &ts {
            let a = addr(w.integrator);
            integrators0.insert(a, env.read(&a));
        }

        let keeper = env.keeper.insecure_clone();
        let ix = env.settle_round_ix(&caller.pubkey(), id, &groups, Some(rent_payer));
        let tx = env.v0_transaction(
            &[compute_limit_ix(1_400_000), ix],
            &[&keeper, &caller],
            tables,
        );
        let size = tx_size(&tx);
        assert!(
            size <= LIMIT,
            "{size}-byte transaction for {} tickets",
            tickets.len()
        );
        let meta = env
            .send_versioned(tx)
            .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));

        // Tokens: each payout to its beneficiary, nothing parked.
        let mut expected_b = beneficiaries0.clone();
        for (w, p) in ts.iter().zip(&payouts) {
            *expected_b.get_mut(&addr(w.beneficiary)).unwrap() += p;
        }
        for (b, bal) in &expected_b {
            assert_eq!(env.balance(b), *bal, "each payout to its beneficiary");
        }
        let total_payout: u64 = payouts.iter().sum();
        assert_eq!(env.balance(&env.a.payout_escrow), escrow0, "nothing parked");
        assert_eq!(env.balance(&env.a.vault_usdc), vault_usdc0 - total_payout);
        assert_eq!(vault_slack(env), slack0, "the vault identity, to the unit");

        // Lamports: each payer its prepay less its charge and the ticket's
        // rent; the caller every settlement share; the round the rest.
        let mut expected_l = lamports0.clone();
        let mut back_total = 0;
        let mut share_total = 0;
        for (i, w) in ts.iter().enumerate() {
            let back = w.prepay - charges[i];
            back_total += back;
            share_total += w.settle_share;
            let ticket_l = lamports0[&tickets[i]];
            *expected_l.get_mut(&addr(w.payer)).unwrap() += back + ticket_l - w.settle_share;
            *expected_l.get_mut(&tickets[i]).unwrap() = 0;
        }
        *expected_l.get_mut(&caller.pubkey()).unwrap() += share_total;
        *expected_l.get_mut(&round_vrf_address(id)).unwrap() -= refund;
        let round_after = lamports0[&round_address(id)] + refund - back_total;
        let closed = !env.exists(&round_address(id));
        if closed {
            *expected_l.get_mut(&round_address(id)).unwrap() = 0;
            *expected_l.get_mut(&rent_payer).unwrap() += round_after;
        } else {
            *expected_l.get_mut(&round_address(id)).unwrap() = round_after;
            assert!(
                round_after >= rent(env, ROUND_LEN),
                "the round keeps its rent"
            );
        }
        for (a, l) in &expected_l {
            assert_eq!(env.lamports(a), *l, "lamports of {a}");
        }
        let sum0: u64 = lamports0.values().sum();
        let sum1: u64 = watched.iter().map(|a| env.lamports(a)).sum();
        assert_eq!(sum0, sum1, "no lamport created or lost");
        for t in tickets {
            assert!(!env.exists(t), "every settled ticket closed");
        }

        // The vault's books.
        let v = env.vault();
        let sum = |f: &dyn Fn(&RoundTicket) -> u64| -> u64 { ts.iter().map(f).sum() };
        let n = u32::try_from(tickets.len()).unwrap();
        let mut ev = v0.clone();
        ev.total_assets -= total_payout;
        ev.total_reserved_liability -= sum(&|w| w.liability);
        ev.open_vault_credits -= sum(&|w| w.vault_credit);
        ev.beacon_shares_held -= sum(&|w| w.protocol_share + w.app_share);
        ev.protocol_shares_accrued += sum(&|w| w.protocol_share);
        ev.app_shares_owed += sum(&|w| w.app_share);
        ev.volume_total += sum(&|w| w.price);
        match round0.side().unwrap() {
            Side::AfterClose if round0.generation == v0.generation => {
                ev.open_after_close -= n;
                for (w, p) in ts.iter().zip(&payouts) {
                    if w.vault_credit >= *p {
                        ev.after_close_gain += w.vault_credit - p;
                    } else {
                        ev.after_close_loss += p - w.vault_credit;
                    }
                }
            }
            _ => ev.open_before_close -= n,
        }
        ev.price_maxima = v.price_maxima;
        ev.price_head_hour = v.price_head_hour;
        assert_eq!(v.drawdown_trip_ts, v0.drawdown_trip_ts, "no trip");
        let ser = |x: &fade::state::Vault| {
            let mut d = Vec::new();
            x.try_serialize(&mut d).unwrap();
            d
        };
        assert_eq!(ser(&v), ser(&ev), "the vault's books, field by field");

        // The integrators' books.
        for (a, i0) in &integrators0 {
            let mine: Vec<&RoundTicket> = ts.iter().filter(|w| addr(w.integrator) == *a).collect();
            let i1: Integrator = env.read(a);
            let mut e = i0.clone();
            e.reserved_liability -= mine.iter().map(|w| w.liability).sum::<u64>();
            e.open_tickets -= mine.len() as u64;
            e.volume_total += mine.iter().map(|w| w.price).sum::<u64>();
            e.app_shares_accrued += mine.iter().map(|w| w.app_share).sum::<u64>();
            let mut d1 = Vec::new();
            i1.try_serialize(&mut d1).unwrap();
            let mut de = Vec::new();
            e.try_serialize(&mut de).unwrap();
            assert_eq!(d1, de, "integrator {a}'s books");
        }

        // The round's books.
        if !closed {
            let mut er = round0.clone();
            er.status = RoundStatus::Drawn;
            er.draw_cost = c;
            // Kept by the first settlement, unchanged by every later one.
            er.drawn_randomness = r;
            er.tickets -= n;
            er.prepaid -= sum(&|w| w.prepay);
            er.liability -= sum(&|w| w.liability);
            er.credits -= sum(&|w| w.vault_credit);
            er.protocol_shares -= sum(&|w| w.protocol_share);
            er.app_shares -= sum(&|w| w.app_share);
            let mut d1 = Vec::new();
            env.round(id).try_serialize(&mut d1).unwrap();
            let mut de = Vec::new();
            er.try_serialize(&mut de).unwrap();
            assert_eq!(d1, de, "the round's books, field by field");
        } else {
            assert_eq!(round0.tickets, n);
            assert_eq!(round0.sponsors, 0);
        }

        // The events.
        let drawn = events::<RoundDrawn>(&meta);
        if first {
            assert_eq!(drawn.len(), 1);
            assert_eq!(drawn[0].version, 1);
            assert_eq!(addr(drawn[0].round), round_address(id));
            assert_eq!((drawn[0].draw_cost, drawn[0].refund), (c, refund));
        } else {
            assert!(drawn.is_empty(), "the draw cost is fixed once");
        }
        let settled = events::<RoundTicketSettled>(&meta);
        assert_eq!(settled.len(), tickets.len());
        for (i, e) in settled.iter().enumerate() {
            assert_eq!(e.version, 1);
            assert_eq!(addr(e.ticket), tickets[i]);
            assert_eq!(addr(e.round), round_address(id));
            assert_eq!(e.integrator, ts[i].integrator);
            assert_eq!(usize::from(e.outcome), outcomes[i]);
            assert_eq!(e.payout, payouts[i]);
            assert_eq!(e.charge, charges[i]);
            assert!(!e.pending);
        }
        let closes = events::<RoundClosed>(&meta);
        if closed {
            assert_eq!(closes.len(), 1);
            assert_eq!(addr(closes[0].rent_payer), rent_payer);
            assert_eq!(closes[0].lamports, round_after);
        } else {
            assert!(closes.is_empty());
        }
        meta
    }

    /// Every sponsor of round `id` reclaims; the round closes on the last,
    /// and what it holds then is exactly §13.4's dust.
    fn reclaim_all(env: &mut Env, id: u64, sponsors: &[Address]) {
        for s in sponsors {
            env.reclaim(id, s).unwrap();
        }
        assert!(
            !env.exists(&round_address(id)),
            "closed on the last reclaim"
        );
    }

    // --- the plan's "done when" ----------------------------------------------------------

    /// Batches of 1 to 21 tickets, each from three
    /// integrators and four payers mixed, two payout tables, winners and
    /// losers, settled in one transaction of at most 1 232 bytes through a
    /// lookup table; every effect checked by `settle_checked`; then the
    /// sponsor reclaims and the round closes with exactly §13.4's dust.
    #[test]
    fn batches_of_1_to_21_mixing_integrators_payers_and_winners() {
        for n in 1..=21usize {
            let mut env = setup();
            let cast = cast(&mut env, 3, 4);
            let (id, tickets) = fill(&mut env, &cast, n);
            draw(&mut env, id, &tickets, mixed);
            let round0 = env.round(id);
            let mut shared: Vec<Address> = tickets.clone();
            for w in tickets.iter().map(|t| env.round_ticket(t)) {
                shared.extend([addr(w.integrator), addr(w.payer), addr(w.payout_table)]);
            }
            let table = round_table(&mut env, id, &shared);
            let refund = env.lamports(&round_vrf_address(id));
            settle_checked(&mut env, id, &tickets, &[table]);
            // The last join's payer sponsored the round, if it had to.
            let sponsors: Vec<Address> = if round0.sponsors > 0 {
                vec![cast.payers[(n - 1) % cast.payers.len()].pubkey()]
            } else {
                vec![]
            };
            assert_eq!(sponsors.len() as u32, round0.sponsors);
            if sponsors.is_empty() {
                assert!(!env.exists(&round_address(id)), "closed by its last ticket");
                continue;
            }
            let r = env.round(id);
            assert_eq!(r.tickets, 0);
            assert_eq!(r.prepaid, 0);
            assert_eq!(
                (r.liability, r.credits, r.protocol_shares, r.app_shares),
                (0, 0, 0, 0)
            );
            let held = env.lamports(&round_address(id));
            let rent_payer = addr(round0.rent_payer);
            let rp0 = env.lamports(&rent_payer);
            let s = round0.sponsorship;
            let c = r.draw_cost;
            let back = s.saturating_sub(c);
            let sponsor0 = env.lamports(&sponsors[0]);
            reclaim_all(&mut env, id, &sponsors);
            let record_l = rent(&env, 58);
            let got = env.lamports(&sponsors[0]) - sponsor0;
            if sponsors[0] == rent_payer {
                assert_eq!(
                    got,
                    back + record_l + (held - back),
                    "the sponsor is also the rent payer"
                );
            } else {
                assert_eq!(got, back + record_l);
                assert_eq!(env.lamports(&rent_payer) - rp0, held - back);
            }
            // The dust: under one lamport per ticket, plus whatever ORAO
            // refunded above `funded` (§13.4 fact 2).
            let extra = refund - refund.min(round0.funded);
            let dust = held - back - rent(&env, ROUND_LEN);
            assert!(
                dust <= extra + tickets.len() as u64,
                "dust {dust} over {n} tickets"
            );
        }
    }

    // --- helpers for refusals --------------------------------------------------------------

    /// A drawn round of `n` tickets from `k` integrators and `p` payers,
    /// winners and losers mixed.
    fn drawn_round(env: &mut Env, n: usize, k: usize, p: usize) -> (Cast, u64, Vec<Address>) {
        let cast = cast(env, k, p);
        let (id, tickets) = fill(env, &cast, n);
        draw(env, id, &tickets, mixed);
        (cast, id, tickets)
    }

    /// Ticket `t`'s group as its stored keys give it, a beneficiary or not.
    fn stored_group(env: &Env, t: &Address, beneficiary: bool) -> Group {
        let w = env.round_ticket(t);
        Group {
            ticket: *t,
            integrator: addr(w.integrator),
            payer: addr(w.payer),
            payout_table: addr(w.payout_table),
            beneficiary: beneficiary.then(|| addr(w.beneficiary)),
        }
    }

    /// Every account a batch over `tickets` of round `id` could touch.
    fn watched(env: &Env, id: u64, caller: &Address, tickets: &[Address]) -> Vec<Address> {
        let mut v = vec![
            *caller,
            env.a.vault,
            round_address(id),
            round_vrf_address(id),
            env.a.payout_escrow,
            env.a.vault_usdc,
        ];
        if env.exists(&round_address(id)) {
            let r = env.round(id);
            v.extend([addr(r.randomness), addr(r.rent_payer)]);
        }
        for t in tickets {
            v.push(*t);
            if env.exists(t) {
                let w = env.round_ticket(t);
                v.extend([
                    addr(w.integrator),
                    addr(w.payer),
                    addr(w.beneficiary),
                    addr(w.payout_table),
                ]);
            }
        }
        v
    }

    fn snapshot(env: &Env, addresses: &[Address]) -> Vec<Option<Account>> {
        addresses.iter().map(|a| env.svm.get_account(a)).collect()
    }

    fn send(
        env: &mut Env,
        caller: &Keypair,
        ix: Instruction,
    ) -> Result<TransactionMetadata, Failure> {
        let keeper = env.keeper.insecure_clone();
        env.send_v0(&[compute_limit_ix(1_400_000), ix], &[&keeper, caller], &[])
    }

    /// `ix` is refused as `check` says, and nothing moved, byte for byte and
    /// lamport for lamport: the fee is the keeper's.
    #[track_caller]
    fn refused_ix(
        env: &mut Env,
        caller: &Keypair,
        ix: Instruction,
        id: u64,
        tickets: &[Address],
        check: impl Fn(&Failure) -> bool,
    ) {
        let addresses = watched(env, id, &caller.pubkey(), tickets);
        let before = snapshot(env, &addresses);
        let err = send(env, caller, ix).expect_err("refused");
        assert!(check(&err), "{}\n{}", err.err, err.logs.join("\n"));
        assert_eq!(
            snapshot(env, &addresses),
            before,
            "a refused batch moves nothing"
        );
    }

    #[track_caller]
    fn refused_groups(
        env: &mut Env,
        caller: &Keypair,
        id: u64,
        groups: &[Group],
        tickets: &[Address],
        e: FadeError,
    ) {
        let rp = addr(env.round(id).rent_payer);
        let ix = env.settle_round_ix(&caller.pubkey(), id, groups, Some(rp));
        let code = fade_error(e);
        refused_ix(env, caller, ix, id, tickets, |f| f.has_code(code));
    }

    #[track_caller]
    #[allow(clippy::too_many_arguments)]
    fn refused_raw(
        env: &mut Env,
        caller: &Keypair,
        id: u64,
        count: u8,
        wins: u32,
        remaining: Vec<AccountMeta>,
        tickets: &[Address],
        e: FadeError,
    ) {
        let rp = addr(env.round(id).rent_payer);
        let ix = env.settle_round_raw_ix(&caller.pubkey(), id, count, wins, remaining, Some(rp));
        let code = fade_error(e);
        refused_ix(env, caller, ix, id, tickets, |f| f.has_code(code));
    }

    fn set_account(env: &mut Env, address: &Address, f: impl FnOnce(&mut Account)) {
        let mut a = env.svm.get_account(address).unwrap();
        f(&mut a);
        env.svm.set_account(*address, a).unwrap();
    }

    // --- the happy paths ---------------------------------------------------------------------

    /// Settlement is deterministic: a round of 13 settled in batches of 5, 1
    /// and 7, in shuffled order, gives every ticket the outcome the
    /// specification computes from the round's randomness and the ticket's
    /// address alone (checked by `settle_checked`), the first batch fixing
    /// the draw cost once; the last closes the round.
    #[test]
    fn any_batching_gives_the_same_outcomes() {
        let mut env = setup();
        let (_cast, id, tickets) = drawn_round(&mut env, 13, 3, 4);
        let order = [7usize, 2, 11, 0, 5, 12, 9, 1, 4, 10, 3, 8, 6];
        let batches: Vec<Vec<Address>> = [&order[..5], &order[5..6], &order[6..]]
            .iter()
            .map(|b| b.iter().map(|i| tickets[*i]).collect())
            .collect();
        let sponsors = env.round(id).sponsors;
        let mut shared = Vec::new();
        for w in tickets.iter().map(|t| env.round_ticket(t)) {
            shared.extend([addr(w.integrator), addr(w.payer), addr(w.payout_table)]);
        }
        let table = round_table(&mut env, id, &shared);
        for b in &batches {
            settle_checked(&mut env, id, b, std::slice::from_ref(&table));
        }
        assert_eq!(env.exists(&round_address(id)), sponsors > 0);
    }

    /// One ticket at a time, `count = 1`, as a keeper with no lookup table
    /// may: the same books as one batch.
    #[test]
    fn one_ticket_at_a_time() {
        let mut env = setup();
        let (_cast, id, tickets) = drawn_round(&mut env, 6, 2, 3);
        for t in &tickets {
            settle_checked(&mut env, id, std::slice::from_ref(t), &[]);
        }
    }

    /// The first settlement drains `round_vrf`: ORAO's refund and lamports
    /// anyone sent there since the request, the formula capping what comes
    /// back at `funded` and the rest left as dust; lamports sent after the
    /// first settlement stay on `round_vrf`, the draw cost being fixed.
    #[test]
    fn the_first_settlement_fixes_the_draw_cost() {
        let mut env = setup();
        let (_cast, id, tickets) = drawn_round(&mut env, 6, 2, 2);
        let orao_refund = env.lamports(&round_vrf_address(id));
        assert_eq!(
            orao_refund,
            rent(&env, orao_layout::PENDING_LEN) - rent(&env, orao_layout::FULFILLED_LEN)
        );
        // Someone sends more than `funded` to `round_vrf`.
        let funded_l = env.round(id).funded;
        env.svm.airdrop(&round_vrf_address(id), funded_l).unwrap();
        settle_checked(&mut env, id, &tickets[..2], &[]);
        let r = env.round(id);
        assert_eq!(
            r.draw_cost, r.request_share,
            "refund ≥ funded: only the share is charged"
        );
        assert_eq!(env.lamports(&round_vrf_address(id)), 0, "drained");
        env.svm.airdrop(&round_vrf_address(id), 1_000_000).unwrap();
        settle_checked(&mut env, id, &tickets[2..], &[]);
        assert_eq!(
            env.lamports(&round_vrf_address(id)),
            1_000_000,
            "a later stray is not drained: the draw cost is fixed"
        );
    }

    /// A request created first by someone else through ORAO, v2 or legacy:
    /// nothing was funded, so the draw costs the request share alone, and
    /// ORAO's refund went to whoever created the request.
    #[test]
    fn a_pre_created_request_costs_the_share_alone() {
        for legacy in [false, true] {
            let mut env = setup();
            let cast = cast(&mut env, 2, 2);
            let (id, tickets) = fill(&mut env, &cast, 5);
            let close = env.round(id).close_slot;
            at_slot(&mut env, close + 2);
            let request = env.round_request_address(id);
            let seed = env.round_seed(id);
            let someone = funded(&mut env);
            let data = if legacy {
                orao_mock::instruction::Request { seed }.data()
            } else {
                orao_mock::instruction::RequestV2 { seed }.data()
            };
            let ix = Instruction {
                program_id: orao_id(),
                accounts: metas(
                    orao_mock::accounts::RequestV2 {
                        payer: pk(someone.pubkey()),
                        network_state: pk(env.a.network_state),
                        treasury: pk(env.orao_treasury),
                        request: pk(request),
                        system_program: pk(system_id()),
                    }
                    .to_account_metas(None),
                ),
                data,
            };
            env.send(&[ix], &[&someone]).unwrap();
            env.request_round_draw(id).unwrap();
            assert_eq!(env.round(id).funded, 0);
            let r = env.round_randomness_with(id, &tickets, mixed);
            env.fulfill_round(id, r);
            assert_eq!(env.lamports(&round_vrf_address(id)), 0);
            settle_checked(&mut env, id, &tickets, &[]);
            if env.exists(&round_address(id)) {
                assert_eq!(env.round(id).draw_cost, env.round(id).request_share);
            }
        }
    }

    /// The rescue of a paid round whose draw no longer fits its prefund
    /// (Spec 08 §13.5.6, §13.9; Beacon Integration §5, `DrawUnderfunded`):
    /// ORAO's fee rises past `D_r` after the round is paid, so the request
    /// that would fund the draw is refused, nothing moved. Anyone may still
    /// create the round's request through ORAO at the derived seed inside
    /// the window, paying the fee and the pending rent itself; the round's
    /// request then binds it (`funded = 0`), and settlement charges the
    /// tickets the request share alone, pro rata, net of sponsorship. The
    /// round is drawn and settled, not forfeited.
    #[test]
    fn a_round_whose_fee_rose_past_its_prefund_is_drawn_through_a_pre_created_request() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 2);
        let (id, tickets) = fill(&mut env, &cast, 5);
        let round0 = env.round(id);
        let close = round0.close_slot;
        at_slot(&mut env, close + 2);
        let pending_rent = rent(&env, orao_layout::PENDING_LEN);
        let risen = 2 * ORAO_FEE + 1;
        assert!(
            !beacon::request_fits(risen, pending_rent, round0.request_share, round0.draw_max),
            "the fee is past the round's prefund"
        );
        let mut ns = env.svm.get_account(&env.a.network_state).unwrap();
        ns.data[72..80].copy_from_slice(&risen.to_le_bytes());
        env.svm.set_account(env.a.network_state, ns).unwrap();
        let held0 = env.lamports(&round_address(id));
        let f = env.request_round_draw(id).unwrap_err();
        assert!(f.has_code(fade_error(FadeError::DrawUnderfunded)));
        assert_eq!(env.round(id).status, RoundStatus::Paid);
        assert_eq!(env.lamports(&round_address(id)), held0, "nothing moved");

        // The rescue: ORAO's own `request_v2` at the round's seed.
        let request = env.round_request_address(id);
        let seed = env.round_seed(id);
        let rescuer = funded(&mut env);
        let ix = super::request_round_draw::orao_request_ix(
            &env,
            &rescuer.pubkey(),
            &request,
            seed,
            false,
        );
        let treasury0 = env.lamports(&env.orao_treasury);
        env.send(&[ix], &[&rescuer]).unwrap();
        assert_eq!(
            env.lamports(&env.orao_treasury),
            treasury0 + risen,
            "the rescuer paid the risen fee"
        );
        env.request_round_draw(id).unwrap();
        let r = env.round(id);
        assert_eq!((r.status, r.funded), (RoundStatus::Requested, 0));
        assert_eq!(
            env.lamports(&round_address(id)),
            held0 - r.request_share,
            "the round pays the request share alone"
        );
        let randomness = env.round_randomness_with(id, &tickets, mixed);
        env.fulfill_round(id, randomness);
        assert_eq!(
            env.lamports(&round_vrf_address(id)),
            0,
            "ORAO's refund goes to whoever created the request"
        );
        let meta = settle_checked(&mut env, id, &tickets, &[]);
        let drawn = events::<RoundDrawn>(&meta);
        assert_eq!(drawn[0].draw_cost, r.request_share, "C = the request share");
        let to_prices = r.request_share.saturating_sub(r.sponsorship);
        let charged: u64 = events::<RoundTicketSettled>(&meta)
            .iter()
            .map(|e| e.charge)
            .sum();
        assert!(charged >= to_prices && charged <= to_prices + tickets.len() as u64);
    }

    /// A round whose sponsorship covers its draw charges its tickets
    /// nothing; a sponsor may reclaim before every ticket is settled, and
    /// each later ticket still gets its whole prepay back.
    #[test]
    fn a_sponsor_reclaims_before_the_tickets_settle() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 2);
        let (id, tickets) = fill(&mut env, &cast, 3);
        let sponsor = funded(&mut env);
        env.sponsor(&sponsor, id, 3 * env.round(id).draw_max)
            .unwrap();
        draw(&mut env, id, &tickets, mixed);
        settle_checked(&mut env, id, &tickets[..1], &[]);
        let r = env.round(id);
        assert!(r.sponsorship > r.draw_cost);
        env.reclaim(id, &sponsor.pubkey()).unwrap();
        let payer = cast.payers[(3 - 1) % 2].pubkey();
        env.reclaim(id, &payer).unwrap();
        settle_checked(&mut env, id, &tickets[1..], &[]);
        assert!(!env.exists(&round_address(id)), "closed by its last ticket");
    }

    /// Settlement observes the price per ticket and records a trip against
    /// the drawdown threshold the round snapshotted, never the live one.
    #[test]
    fn a_trip_is_recorded_against_the_rounds_threshold() {
        let mut env = setup();
        let (_cast, id, tickets) = drawn_round(&mut env, 2, 1, 1);
        assert_eq!(env.config().params.drawdown_bps, env.round(id).drawdown_bps);
        assert_eq!(env.vault().drawdown_trip_ts, 0);
        env.set_round(id, None, |r| r.drawdown_bps = 0);
        env.settle_round(id, &tickets).unwrap();
        assert_eq!(
            env.vault().drawdown_trip_ts,
            env.now(),
            "tripped at the round's 0 bps"
        );
    }

    /// No pause stops a settlement (Spec 08 §13.7): every pause flag of the
    /// configuration, and the integrator's own pause, set for one of the two
    /// integrators of a mixed batch and then for a batch of its tickets alone.
    /// Nor a claim (Spec 08 §13.5.11, Spec 09): a winner of the paused
    /// integrator, parked behind a frozen beneficiary, is delivered with
    /// every pause still set.
    #[test]
    fn settlement_is_never_paused() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 2);
        let (id, tickets) = fill(&mut env, &cast, 5);
        draw(&mut env, id, &tickets, |w| w[0] && mixed(w));
        let beneficiary = addr(env.round_ticket(&tickets[0]).beneficiary);
        env.set_token_state(&beneficiary, 2);
        let guardian = env.guardian.insecure_clone();
        let paused = env.integrator_address(&cast.integrators[0].pubkey());
        env.set_pause_flags(
            &guardian,
            fade::state::Config::PAUSE_ALL,
            Some((paused, true)),
        )
        .unwrap();
        assert!(env.read::<Integrator>(&paused).paused);
        assert_eq!(env.config().pause_flags, fade::state::Config::PAUSE_ALL);
        // Tickets 0, 2 and 4 are the paused integrator's.
        settle_checked(&mut env, id, &tickets[1..3], &[]);
        env.settle_round(id, &tickets[..1]).unwrap();
        let parked = env.round_ticket(&tickets[0]);
        assert_eq!(parked.status, RoundTicketStatus::PayoutParked);
        assert!(parked.payout > 0);
        settle_checked(&mut env, id, &tickets[3..], &[]);
        assert_eq!(env.round(id).tickets, 0);
        // The claim, every pause still set.
        env.set_token_state(&beneficiary, 1);
        let payer = addr(parked.payer);
        let (p0, tl) = (env.lamports(&payer), env.lamports(&tickets[0]));
        env.claim_round_payout(&tickets[0]).unwrap();
        assert_eq!(env.config().pause_flags, fade::state::Config::PAUSE_ALL);
        assert!(env.read::<Integrator>(&paused).paused);
        assert_eq!(env.balance(&beneficiary), parked.payout);
        assert!(!env.exists(&tickets[0]));
        assert_eq!(env.lamports(&payer), p0 + tl, "every lamport to the payer");
    }

    /// Test-only: rewrites the configuration in place, past any governance
    /// delay.
    fn set_config(env: &mut Env, f: impl FnOnce(&mut fade::state::Config)) {
        let address = env.a.config;
        let mut account = env.svm.get_account(&address).unwrap();
        let mut config = <fade::state::Config as anchor_lang::AccountDeserialize>::try_deserialize(
            &mut account.data.as_slice(),
        )
        .unwrap();
        f(&mut config);
        let mut data = Vec::new();
        config.try_serialize(&mut data).unwrap();
        account.data[..data.len()].copy_from_slice(&data);
        env.svm.set_account(address, account).unwrap();
    }

    /// Settlement reads no live parameter (Spec 08 §13.1): after the draw,
    /// every parameter settlement could plausibly read is moved, the
    /// settlement share and the beacon's own above all, and each batch
    /// still pays the caller each ticket's stored `settle_share`, and every
    /// other amount from what the ticket and the round stored.
    #[test]
    fn settlement_reads_no_live_parameter() {
        let mut env = setup();
        let (_cast, id, tickets) = drawn_round(&mut env, 4, 2, 2);
        let stored = env.round_ticket(&tickets[0]).settle_share;
        let live = env.config().params.crank_round_settle_lamports;
        assert_eq!(stored, live);
        set_config(&mut env, |c| {
            let p = &mut c.params;
            p.crank_round_settle_lamports = live * 7 + 13;
            p.crank_settle_lamports = p.crank_settle_lamports * 3 + 1;
            p.crank_request_lamports = p.crank_request_lamports * 3 + 1;
            p.beacon_min_price *= 10;
            p.beacon_threshold = p.beacon_threshold * 3 + 1;
            p.round_k += 3;
            p.tick_slots += 7;
            p.refund_slots += 11;
            p.t_settle_slots = 2;
            p.min_price *= 10;
            p.max_price = p.min_price;
            p.min_vault_margin_bps += 500;
            p.protocol_share_bps += 100;
            p.max_app_share_bps = 0;
            p.kelly_fraction_bps = 1;
            p.whale_bps = 1;
            p.censorship_bps = 1;
            p.utilisation_breaker_bps = 1;
            p.kappa_bps = 1;
            p.drawdown_bps = 10_000;
            p.credit_enabled = !p.credit_enabled;
            p.credit_base = p.credit_base * 2 + 1;
            p.credit_rate_bps += 1;
        });
        assert_ne!(env.config().params.crank_round_settle_lamports, stored);
        settle_checked(&mut env, id, &tickets[..2], &[]);
        // Lowered below what the tickets hold: the next batch still pays
        // what each stored.
        set_config(&mut env, |c| c.params.crank_round_settle_lamports = 1);
        settle_checked(&mut env, id, &tickets[2..], &[]);
    }

    /// Settlement has no deadline (invariant 10, §13.9 "ORAO late"): a
    /// request fulfilled after `close_slot + t_settle_slots` settles, and so
    /// does a later batch of the drawn round, far later still. `expire_round`
    /// refuses the fulfilled round (`AlreadyFulfilled`), then the drawn one
    /// (`WrongRoundStatus`), moving nothing.
    #[test]
    fn a_late_fulfilment_settles() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 2);
        let (id, tickets) = fill(&mut env, &cast, 4);
        let round = env.round(id);
        at_slot(&mut env, round.close_slot + 2);
        env.request_round_draw(id).unwrap();
        let deadline = round.close_slot + round.t_settle_slots;
        let now = env.now();
        env.set_time(deadline + 1, now + 3_600);
        let r = env.round_randomness_with(id, &tickets, mixed);
        env.fulfill_round(id, r);
        assert_eq!(env.round(id).status, RoundStatus::Requested);
        let expirer = funded(&mut env);
        let request = addr(env.round(id).randomness);
        let watched = [env.a.vault, round_address(id), round_vrf_address(id)];
        let before = snapshot(&env, &watched);
        let ix = env.expire_round_ix(&expirer.pubkey(), id, &request);
        assert_fails_with(env.send(&[ix], &[&expirer]), FadeError::AlreadyFulfilled);
        assert_eq!(snapshot(&env, &watched), before, "a refusal moves nothing");
        settle_checked(&mut env, id, &tickets[..2], &[]);
        assert_eq!(env.round(id).status, RoundStatus::Drawn);
        let before = snapshot(&env, &watched);
        let ix = env.expire_round_ix(&expirer.pubkey(), id, &request);
        assert_fails_with(env.send(&[ix], &[&expirer]), FadeError::WrongRoundStatus);
        assert_eq!(snapshot(&env, &watched), before, "a refusal moves nothing");
        let now = env.now();
        env.set_time(deadline + 10_000_000, now + 400 * 86_400);
        settle_checked(&mut env, id, &tickets[2..], &[]);
    }

    /// A drawn round does not depend on ORAO's account (invariant 10): the
    /// first settlement keeps the randomness on the round, and every later
    /// batch reads it there, so a request account that ORAO later rewrites
    /// in a layout this program does not parse, hands to another owner or
    /// closes leaves every remaining ticket settleable, with the outcomes of
    /// the original randomness. Only its address is still checked.
    #[test]
    fn a_drawn_round_outlives_its_request_account() {
        let mut env = setup();
        let (_cast, id, tickets) = drawn_round(&mut env, 8, 2, 3);
        let r = env.round_randomness(id);
        let request = addr(env.round(id).randomness);
        settle_checked(&mut env, id, &tickets[..2], &[]);
        assert_eq!(env.round(id).status, RoundStatus::Drawn);
        let kept = env.round(id).drawn_randomness;

        // A layout this program does not parse, still ORAO's.
        let mut a = env.svm.get_account(&request).unwrap();
        a.data = vec![0xAB; a.data.len() + 17];
        env.svm.set_account(request, a.clone()).unwrap();
        settle_checked_with(&mut env, id, &r, &tickets[2..4], &[]);

        // Another owner, the data zeroed.
        a.owner = Address::new_unique();
        a.data = vec![0; 8];
        env.svm.set_account(request, a).unwrap();
        settle_checked_with(&mut env, id, &r, &tickets[4..6], &[]);

        // Closed.
        env.svm.set_account(request, Account::default()).unwrap();
        assert!(!env.exists(&request));
        // Its address is still the only one accepted.
        let caller = funded(&mut env);
        let g: Vec<Group> = tickets[6..]
            .iter()
            .map(|t| env.round_group_with(id, t, &r))
            .collect();
        let mut ix = env.settle_round_ix(&caller.pubkey(), id, &g, None);
        ix.accounts[5].pubkey = Address::new_unique();
        let code = fade_error(FadeError::WrongRandomnessAccount);
        refused_ix(&mut env, &caller, ix, id, &tickets[6..], |f| {
            f.has_code(code)
        });
        settle_checked_with(&mut env, id, &r, &tickets[6..], &[]);
        assert_eq!(kept, r, "R kept on the round by the first settlement");
    }

    /// The strike waits for a round's tickets: a round paid with no epoch
    /// live is `After`; a deposit then opens an epoch, which moves its
    /// tickets to `before`; past the close the strike is refused until they
    /// settle, and their results are not booked as after-close ones, being
    /// in the epoch's price. A round paid during the epoch is `Before`.
    #[test]
    fn settlement_releases_the_strike() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 2);
        let (a, ta) = fill(&mut env, &cast, 4);
        assert_eq!(env.round(a).side().unwrap(), Side::AfterClose);
        let lp = env.user(1_000 * USDC);
        env.deposit(&lp, 1_000 * USDC).unwrap();
        let v = env.vault();
        assert!(v.close_ts > env.now());
        assert_eq!(
            v.open_before_close, 4,
            "the deposit moved round 1 into before"
        );
        draw(&mut env, a, &ta, mixed);
        let close = env.round(a).close_slot;
        at_slot(&mut env, close);
        let (b, tb) = fill(&mut env, &cast, 3);
        assert_eq!(env.round(b).side().unwrap(), Side::BeforeClose);
        draw(&mut env, b, &tb, mixed);
        env.pass_close();
        assert_fails_with(env.strike(), FadeError::StrikeNotClean);
        let gain0 = (env.vault().after_close_gain, env.vault().after_close_loss);
        settle_checked(&mut env, a, &ta, &[]);
        assert_eq!(
            (env.vault().after_close_gain, env.vault().after_close_loss),
            gain0,
            "no after-close result booked for tickets in the epoch's price"
        );
        assert_fails_with(env.strike(), FadeError::StrikeNotClean);
        settle_checked(&mut env, b, &tb, &[]);
        assert_eq!(env.vault().open_before_close, 0);
        env.strike()
            .expect("the strike runs once every ticket is settled");
    }

    // --- refusals ----------------------------------------------------------------------------

    /// Only a requested or drawn round settles, with a fulfilled, non-zero
    /// randomness of its own seed from ORAO; each refusal moves nothing.
    #[test]
    fn only_a_fulfilled_round_settles() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let caller = funded(&mut env);
        // Accepting, then paid.
        let id = env.joining_round();
        let t0 = join_as(
            &mut env,
            &cast.integrators[0],
            cast.shares[0],
            &cast.payers[0],
            &cast.funder,
            cast.funder.usdc,
            &coin_flip(),
            USDC,
            0,
        );
        let g = vec![stored_group(&env, &t0, false)];
        refused_groups(
            &mut env,
            &caller,
            id,
            &g,
            &[t0],
            FadeError::WrongRoundStatus,
        );
        let t1 = join_as(
            &mut env,
            &cast.integrators[0],
            cast.shares[0],
            &cast.payers[1],
            &cast.funder,
            cast.funder.usdc,
            &coin_flip(),
            8 * USDC,
            0,
        );
        let tickets = vec![t0, t1];
        assert_eq!(env.round(id).status, RoundStatus::Paid);
        let g: Vec<Group> = tickets
            .iter()
            .map(|t| stored_group(&env, t, false))
            .collect();
        refused_groups(
            &mut env,
            &caller,
            id,
            &g,
            &tickets,
            FadeError::WrongRoundStatus,
        );
        // Requested, pending.
        let close = env.round(id).close_slot;
        at_slot(&mut env, close + 2);
        env.request_round_draw(id).unwrap();
        refused_groups(&mut env, &caller, id, &g, &tickets, FadeError::NotFulfilled);
        // The round checks come before the layout's.
        refused_raw(
            &mut env,
            &caller,
            id,
            0,
            0,
            vec![],
            &tickets,
            FadeError::NotFulfilled,
        );
        let r = env.round_randomness_with(id, &tickets, mixed);
        env.fulfill_round(id, r);
        let g: Vec<Group> = tickets.iter().map(|t| env.round_group(id, t)).collect();
        let request = addr(env.round(id).randomness);
        let original = env.svm.get_account(&request).unwrap();
        // Fulfilled with zero randomness.
        set_account(&mut env, &request, |a| a.data[73..137].fill(0));
        refused_groups(&mut env, &caller, id, &g, &tickets, FadeError::NotFulfilled);
        // Another seed.
        env.svm.set_account(request, original.clone()).unwrap();
        set_account(&mut env, &request, |a| a.data[41] ^= 1);
        refused_groups(
            &mut env,
            &caller,
            id,
            &g,
            &tickets,
            FadeError::WrongRandomnessAccount,
        );
        // Not ORAO's.
        env.svm.set_account(request, original.clone()).unwrap();
        set_account(&mut env, &request, |a| a.owner = fade_id());
        refused_groups(
            &mut env,
            &caller,
            id,
            &g,
            &tickets,
            FadeError::WrongRandomnessAccount,
        );
        // Not a request at all.
        env.svm.set_account(request, original.clone()).unwrap();
        set_account(&mut env, &request, |a| a.data[0] ^= 1);
        refused_groups(
            &mut env,
            &caller,
            id,
            &g,
            &tickets,
            FadeError::WrongRandomnessAccount,
        );
        env.svm.set_account(request, original.clone()).unwrap();
        // Another account in place of the round's request.
        let other = env.round_request_address(id);
        let mut ix = env.settle_round_ix(&caller.pubkey(), id, &g, None);
        ix.accounts[5].pubkey = Address::new_unique();
        let code = fade_error(FadeError::WrongRandomnessAccount);
        refused_ix(&mut env, &caller, ix, id, &tickets, |f| f.has_code(code));
        let _ = other;
        // A round claiming not to be recorded in the counters.
        let saved = env.round(id);
        env.set_round(id, None, |r| r.counted = false);
        refused_groups(
            &mut env,
            &caller,
            id,
            &g,
            &tickets,
            FadeError::WrongRoundStatus,
        );
        // Refunded or forfeited: the returns are not settlements.
        for status in [
            RoundStatus::Refunded,
            RoundStatus::Forfeited,
            RoundStatus::Paid,
        ] {
            env.set_round(id, None, |r| {
                *r = saved.clone();
                r.status = status;
            });
            refused_groups(
                &mut env,
                &caller,
                id,
                &g,
                &tickets,
                FadeError::WrongRoundStatus,
            );
        }
        env.set_round(id, None, |r| *r = saved.clone());
        settle_checked(&mut env, id, &tickets, &[]);
    }

    /// The layout: `1 ≤ count ≤ 32`, no bit of `wins` at or above `count`,
    /// exactly the accounts the bits call for, a beneficiary exactly for a
    /// winner, and every account of a group the ticket's stored one; each
    /// refusal moves nothing, and the batch then settles.
    #[test]
    fn the_layout_is_checked() {
        let mut env = setup();
        let (cast, id, tickets) = drawn_round(&mut env, 4, 2, 2);
        let caller = funded(&mut env);
        let g: Vec<Group> = tickets.iter().map(|t| env.round_group(id, t)).collect();
        let w = g.iter().position(|x| x.beneficiary.is_some()).unwrap();
        let l = g.iter().position(|x| x.beneficiary.is_none()).unwrap();
        let all: Vec<AccountMeta> = g.iter().flat_map(|x| x.metas()).collect();
        let wins: u32 = g
            .iter()
            .enumerate()
            .filter(|(_, x)| x.beneficiary.is_some())
            .map(|(i, _)| 1 << i)
            .sum();
        let bad = FadeError::MalformedBatch;
        // count and wins.
        refused_raw(&mut env, &caller, id, 0, 0, vec![], &tickets, bad);
        refused_raw(&mut env, &caller, id, 33, wins, all.clone(), &tickets, bad);
        let mut extra = all.clone();
        extra.push(AccountMeta::new(cast.funder.usdc, false));
        refused_raw(
            &mut env,
            &caller,
            id,
            4,
            wins | 1 << 4,
            extra.clone(),
            &tickets,
            bad,
        );
        refused_raw(
            &mut env,
            &caller,
            id,
            4,
            wins | 1 << 31,
            extra.clone(),
            &tickets,
            bad,
        );
        // One account short, one too many.
        refused_raw(
            &mut env,
            &caller,
            id,
            4,
            wins,
            all[..all.len() - 1].to_vec(),
            &tickets,
            bad,
        );
        refused_raw(&mut env, &caller, id, 4, wins, extra, &tickets, bad);
        // A loser claiming a win, a winner claiming none.
        let mut h = g.clone();
        h[l].beneficiary = Some(addr(env.round_ticket(&tickets[l]).beneficiary));
        refused_groups(&mut env, &caller, id, &h, &tickets, bad);
        let mut h = g.clone();
        h[w].beneficiary = None;
        refused_groups(&mut env, &caller, id, &h, &tickets, bad);
        // Every account of a group replaced.
        let tw = env.round_ticket(&tickets[w]);
        let other_integrator = g
            .iter()
            .map(|x| x.integrator)
            .find(|i| *i != g[w].integrator)
            .unwrap();
        let other_payer = g
            .iter()
            .map(|x| x.payer)
            .find(|p| *p != g[w].payer)
            .unwrap();
        let other = if g[w].payout_table == env.payout_table_address(&coin_flip()) {
            slot_classic()
        } else {
            coin_flip()
        };
        let other_table = env.payout_table_address(&other);
        let thief = env.usdc_account(&Address::new_unique(), 0);
        // A Fade-owned copy of the winner at another address, with another
        // beneficiary: refused by the address its stored keys derive.
        let forged = Address::new_unique();
        let mut copy = env.svm.get_account(&tickets[w]).unwrap();
        env.svm.set_account(forged, copy.clone()).unwrap();
        env.set_round_ticket(&forged, |t| t.beneficiary = pk(thief));
        // The same bytes under another program.
        let foreign = Address::new_unique();
        copy.owner = orao_id();
        env.svm.set_account(foreign, copy).unwrap();
        // A direct ticket.
        let player = env.user(10 * USDC);
        let direct = env.open_direct(&player, 8 * USDC, &coin_flip(), 0).unwrap();
        // A ticket of another round.
        let close = env.round(id).close_slot;
        let _ = close;
        let mut replaced: Vec<(&str, Group)> = Vec::new();
        for (label, ticket) in [
            ("forged copy", forged),
            ("foreign copy", foreign),
            ("direct ticket", direct),
            ("the round itself", round_address(id)),
            ("the vault", env.a.vault),
        ] {
            let mut x = g[w].clone();
            x.ticket = ticket;
            replaced.push((label, x));
        }
        let mut x = g[w].clone();
        x.integrator = other_integrator;
        replaced.push(("integrator", x));
        let mut x = g[w].clone();
        x.payer = other_payer;
        replaced.push(("payer", x));
        let mut x = g[w].clone();
        x.payer = caller.pubkey();
        replaced.push(("payer the caller", x));
        let mut x = g[w].clone();
        x.payout_table = other_table;
        replaced.push(("payout table", x));
        let mut x = g[w].clone();
        x.beneficiary = Some(thief);
        replaced.push(("beneficiary", x));
        let mut x = g[w].clone();
        x.beneficiary = Some(env.a.payout_escrow);
        replaced.push(("beneficiary the escrow", x));
        for (label, x) in replaced {
            let mut h = g.clone();
            h[w] = x;
            let _ = label;
            refused_groups(&mut env, &caller, id, &h, &tickets, bad);
        }
        // Read-only accounts where the group writes: every mention of the
        // account read-only, so that the message does not make it writable
        // through another group (the round keeps a sponsorship, so no rent
        // payer is named).
        assert!(env.round(id).sponsors > 0);
        for target in [
            g[w].ticket,
            g[w].integrator,
            g[w].payer,
            g[w].beneficiary.unwrap(),
        ] {
            let metas: Vec<AccountMeta> = all
                .iter()
                .map(|m| {
                    let mut m = m.clone();
                    if m.pubkey == target {
                        m.is_writable = false;
                    }
                    m
                })
                .collect();
            let ix = env.settle_round_raw_ix(&caller.pubkey(), id, 4, wins, metas, None);
            let code = fade_error(bad);
            refused_ix(&mut env, &caller, ix, id, &tickets, |f| f.has_code(code));
        }
        // The same ticket twice.
        let mut h = g.clone();
        h.push(g[w].clone());
        refused_groups(&mut env, &caller, id, &h, &tickets, bad);
        // A parked return is not a settlement's.
        let saved = env.round_ticket(&tickets[l]);
        env.set_round_ticket(&tickets[l], |t| t.status = RoundTicketStatus::ReturnParked);
        refused_groups(&mut env, &caller, id, &g, &tickets, bad);
        // A bump that is not the stored one.
        env.set_round_ticket(&tickets[l], |t| {
            *t = saved.clone();
            t.bump = t.bump.wrapping_sub(1);
        });
        refused_groups(&mut env, &caller, id, &g, &tickets, bad);
        // A ticket naming another round.
        env.set_round_ticket(&tickets[l], |t| {
            *t = saved.clone();
            t.round += 1;
        });
        refused_groups(&mut env, &caller, id, &g, &tickets, bad);
        env.set_round_ticket(&tickets[l], |t| *t = saved.clone());
        assert_eq!(tw.round, id);
        settle_checked(&mut env, id, &tickets, &[]);
    }

    /// At most 32 tickets a batch, one bit of `wins` each: a well-formed
    /// batch of 33 losing tickets is refused, the same 32 settle.
    #[test]
    fn at_most_thirty_two_tickets_a_batch() {
        let mut env = setup();
        // A rare 0.97× return: losers almost always, and no liability, so
        // that 33 tickets fit one round.
        let rare = vec![
            Outcome {
                p: 10_000_000,
                m: 9_700,
            },
            Outcome {
                p: 990_000_000,
                m: 0,
            },
        ];
        let k = env.keeper.insecure_clone();
        env.register_payout_table(&k, &rare).unwrap();
        let cast = cast(&mut env, 1, 1);
        let (id, tickets) = fill_with(&mut env, &cast, 33, std::slice::from_ref(&rare));
        draw(&mut env, id, &tickets, |w| w.iter().all(|x| !*x));
        let g: Vec<Group> = tickets.iter().map(|t| env.round_group(id, t)).collect();
        let shared = [g[0].integrator, g[0].payer, g[0].payout_table];
        let mut entries = tickets.clone();
        entries.extend(shared);
        let table = round_table(&mut env, id, &entries);
        let caller = funded(&mut env);
        let keeper = env.keeper.insecure_clone();
        let addresses = watched(&env, id, &caller.pubkey(), &tickets);
        let before = snapshot(&env, &addresses);
        let ix = env.settle_round_ix(&caller.pubkey(), id, &g, None);
        let err = env
            .send_v0(
                &[compute_limit_ix(1_400_000), ix],
                &[&keeper, &caller],
                std::slice::from_ref(&table),
            )
            .unwrap_err();
        assert!(
            err.has_code(fade_error(FadeError::MalformedBatch)),
            "{}",
            err.err
        );
        assert_eq!(snapshot(&env, &addresses), before);
        settle_checked(&mut env, id, &tickets[..32], std::slice::from_ref(&table));
        settle_checked(&mut env, id, &tickets[32..], &[]);
    }

    /// Books an instruction could only reach by a defect fail the batch,
    /// before anything moves, rather than paying from the round's rent or
    /// the vault's reservation: a payout above the reservation, a round
    /// short of its rent after the returns, a round counting fewer tickets
    /// or prepays than the batch settles.
    #[test]
    fn inconsistent_books_fail_closed() {
        let mut env = setup();
        let (_cast, id, tickets) = drawn_round(&mut env, 3, 1, 2);
        let caller = funded(&mut env);
        let g: Vec<Group> = tickets.iter().map(|t| env.round_group(id, t)).collect();
        let w = g.iter().position(|x| x.beneficiary.is_some()).unwrap();
        let saved = env.round_ticket(&tickets[w]);
        env.set_round_ticket(&tickets[w], |t| t.payout_max = 0);
        refused_groups(&mut env, &caller, id, &g, &tickets, FadeError::MathOverflow);
        env.set_round_ticket(&tickets[w], |t| *t = saved.clone());

        let round = env.round(id);
        let refund = env.lamports(&round_vrf_address(id));
        let c = round.funded + round.request_share - refund.min(round.funded);
        let back: u64 = tickets
            .iter()
            .map(|t| {
                let x = env.round_ticket(t);
                let charge = u64::try_from(
                    (u128::from(c.saturating_sub(round.sponsorship)) * u128::from(x.price))
                        .div_ceil(u128::from(round.prices)),
                )
                .unwrap();
                x.prepay - charge
            })
            .sum();
        let l0 = env.lamports(&round_address(id));
        let short = rent(&env, ROUND_LEN) + back - refund - 1;
        env.set_round(id, Some(short), |_| {});
        refused_groups(&mut env, &caller, id, &g, &tickets, FadeError::MathOverflow);
        env.set_round(id, Some(l0), |_| {});

        for f in [
            (|r: &mut fade::state::Round| r.tickets = 2) as fn(&mut fade::state::Round),
            |r| r.prepaid -= 1,
            |r| r.liability -= 1,
            |r| r.credits -= 1,
            |r| r.protocol_shares = 0,
        ] {
            env.set_round(id, None, f);
            refused_groups(&mut env, &caller, id, &g, &tickets, FadeError::MathOverflow);
            env.set_round(id, None, |r| *r = round.clone());
        }
        settle_checked(&mut env, id, &tickets, &[]);
    }

    /// Two keepers racing on one round: a ticket another batch closed, or
    /// settled into a parked payout, is skipped, not refused; nothing is
    /// paid or booked twice.
    #[test]
    fn racing_keepers_lose_a_ticket_not_a_transaction() {
        let mut env = setup();
        let (_cast, id, tickets) = drawn_round(&mut env, 6, 2, 2);
        let g: Vec<Group> = tickets.iter().map(|t| env.round_group(id, t)).collect();
        let w = g.iter().position(|x| x.beneficiary.is_some()).unwrap();
        // The winner's beneficiary frozen: its payout is parked.
        let b = g[w].beneficiary.unwrap();
        env.set_token_state(&b, 2);
        let first: Vec<usize> = (0..6).filter(|i| *i == w || *i % 2 == 0).collect();
        let keeper = env.keeper.insecure_clone();
        let rp = addr(env.round(id).rent_payer);
        let gs: Vec<Group> = first.iter().map(|i| g[*i].clone()).collect();
        let ix = env.settle_round_ix(&keeper.pubkey(), id, &gs, Some(rp));
        env.send_v0(&[compute_limit_ix(1_400_000), ix], &[&keeper], &[])
            .unwrap();
        assert_eq!(
            env.round_ticket(&tickets[w]).status,
            RoundTicketStatus::PayoutParked
        );
        // The second keeper's batch names every ticket.
        let v0 = env.vault();
        let round0 = env.round(id);
        let caller = funded(&mut env);
        let c0 = env.lamports(&caller.pubkey());
        let ix = env.settle_round_ix(&caller.pubkey(), id, &g, Some(rp));
        let meta = send(&mut env, &caller, ix).unwrap();
        let rest: Vec<usize> = (0..6).filter(|i| !first.contains(i)).collect();
        let settled = events::<RoundTicketSettled>(&meta);
        assert_eq!(
            settled.iter().map(|e| addr(e.ticket)).collect::<Vec<_>>(),
            rest.iter().map(|i| tickets[*i]).collect::<Vec<_>>(),
            "only the tickets still joined"
        );
        let share = round0.settle_share;
        assert_eq!(
            env.lamports(&caller.pubkey()) - c0,
            share * rest.len() as u64
        );
        assert_eq!(
            env.vault().open_after_close,
            v0.open_after_close - rest.len() as u32
        );
        assert!(events::<RoundDrawn>(&meta).is_empty());
        // A batch of only settled tickets settles nothing and fails nothing.
        let r1 = env.svm.get_account(&round_address(id));
        let v1 = env.svm.get_account(&env.a.vault);
        let ix = env.settle_round_ix(&caller.pubkey(), id, &g, Some(rp));
        let meta = send(&mut env, &caller, ix).unwrap();
        assert!(events::<RoundTicketSettled>(&meta).is_empty());
        assert_eq!(env.svm.get_account(&round_address(id)), r1);
        assert_eq!(env.svm.get_account(&env.a.vault), v1);
    }

    /// A beneficiary that cannot receive, frozen, closed or of another mint,
    /// has its payout parked in `payout_escrow`: the books move as for any
    /// winner, the ticket stays with its rent and its prepay's return, and
    /// `claim_round_payout` delivers once the beneficiary can receive,
    /// closing the ticket to its payer.
    #[test]
    fn a_payout_is_parked_when_the_beneficiary_cannot_receive() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 3);
        // Three winners on a table that almost always pays.
        let sure = vec![
            Outcome {
                p: 990_000_000,
                m: 9_900,
            },
            Outcome {
                p: 10_000_000,
                m: 0,
            },
        ];
        let k = env.keeper.insecure_clone();
        env.register_payout_table(&k, &sure).unwrap();
        let (id, tickets) = fill_with(&mut env, &cast, 4, std::slice::from_ref(&sure));
        draw(&mut env, id, &tickets, |w| w.iter().all(|x| *x));
        let ts: Vec<RoundTicket> = tickets.iter().map(|t| env.round_ticket(t)).collect();
        let frozen = addr(ts[0].beneficiary);
        env.set_token_state(&frozen, 2);
        let closed = addr(ts[1].beneficiary);
        env.svm
            .set_account(
                closed,
                Account {
                    lamports: 0,
                    data: vec![],
                    owner: system_id(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let other_mint = addr(ts[2].beneficiary);
        set_account(&mut env, &other_mint, |a| a.data[0] ^= 1);
        let r = env.round_randomness(id);
        let payouts: Vec<u64> = tickets
            .iter()
            .map(|t| env.beacon_payout_with(id, t, &r))
            .collect();
        let escrow0 = env.balance(&env.a.payout_escrow);
        let payers0: Vec<u64> = ts.iter().map(|w| env.lamports(&addr(w.payer))).collect();
        let tl0: Vec<u64> = tickets.iter().map(|t| env.lamports(t)).collect();
        let v0 = env.vault();
        let meta = env.settle_round(id, &tickets).unwrap();
        let round = env.round(id);
        let c = round.draw_cost;
        let charge = |w: &RoundTicket| -> u64 {
            u64::try_from(
                (u128::from(c.saturating_sub(round.sponsorship)) * u128::from(w.price))
                    .div_ceil(u128::from(round.prices)),
            )
            .unwrap()
        };
        assert_eq!(
            env.balance(&env.a.payout_escrow),
            escrow0 + payouts[..3].iter().sum::<u64>(),
            "three payouts parked"
        );
        assert_eq!(env.balance(&addr(ts[3].beneficiary)), payouts[3]);
        let v = env.vault();
        assert_eq!(
            v.total_assets,
            v0.total_assets - payouts.iter().sum::<u64>()
        );
        let ev = events::<RoundTicketSettled>(&meta);
        assert_eq!(
            ev.iter().map(|e| e.pending).collect::<Vec<_>>(),
            [true, true, true, false]
        );
        for i in 0..3 {
            let t = env.round_ticket(&tickets[i]);
            assert_eq!(t.status, RoundTicketStatus::PayoutParked);
            assert_eq!(t.payout, payouts[i]);
            assert_eq!(t.settle_share, 0);
            let back = ts[i].prepay - charge(&ts[i]);
            assert_eq!(
                env.lamports(&tickets[i]),
                tl0[i] - ts[i].settle_share + back,
                "the parked ticket keeps its rent and its prepay's return"
            );
        }
        // Payers 0..3 are payers[0..3]; the fourth ticket's payer is payers[0].
        assert_eq!(
            env.lamports(&addr(ts[1].payer)),
            payers0[1],
            "a parked ticket's payer is paid at the claim"
        );

        // The claims.
        let keeper = env.keeper.insecure_clone();
        // Still frozen: the claim fails and moves nothing.
        let before = snapshot(&env, &[tickets[0], frozen, env.a.payout_escrow]);
        assert!(env.claim_round_payout(&tickets[0]).is_err());
        assert_eq!(
            snapshot(&env, &[tickets[0], frozen, env.a.payout_escrow]),
            before
        );
        // Another destination.
        let thief = env.usdc_account(&Address::new_unique(), 0);
        let ix = env.claim_round_payout_ix(&keeper.pubkey(), &tickets[0], &thief);
        assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::BeneficiaryMismatch);
        // Remaining accounts.
        env.set_token_state(&frozen, 1);
        let mut ix = env.claim_round_payout_ix(&keeper.pubkey(), &tickets[0], &frozen);
        ix.accounts
            .push(AccountMeta::new_readonly(Address::new_unique(), false));
        assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::RemainingAccounts);
        // Another payer.
        let mut ix = env.claim_round_payout_ix(&keeper.pubkey(), &tickets[0], &frozen);
        ix.accounts[6].pubkey = keeper.pubkey();
        assert!(env.send(&[ix], &[&keeper]).unwrap_err().has_code(2012));
        // Delivered once it can receive.
        let p0 = env.lamports(&addr(ts[0].payer));
        let tl = env.lamports(&tickets[0]);
        let again = env.claim_round_payout_ix(&keeper.pubkey(), &tickets[0], &frozen);
        let meta = env.claim_round_payout(&tickets[0]).unwrap();
        assert_eq!(env.balance(&frozen), payouts[0]);
        assert!(!env.exists(&tickets[0]));
        assert_eq!(
            env.lamports(&addr(ts[0].payer)),
            p0 + tl,
            "every lamport to the payer"
        );
        let e = events::<RoundPayoutClaimed>(&meta);
        assert_eq!(e.len(), 1);
        assert_eq!(
            (addr(e[0].ticket), addr(e[0].destination), e[0].amount),
            (tickets[0], frozen, payouts[0])
        );
        assert_eq!(e[0].version, 1);
        // Claimed once: the ticket is gone.
        let escrow1 = env.balance(&env.a.payout_escrow);
        assert!(env.send(&[again], &[&keeper]).is_err());
        assert_eq!(env.balance(&env.a.payout_escrow), escrow1);
        // The closed beneficiary re-created: delivered.
        fade_testkit::token::write_token_account(
            &mut env.svm,
            closed,
            &env.a.usdc_mint,
            &Address::new_unique(),
            0,
        );
        env.claim_round_payout(&tickets[1]).unwrap();
        assert_eq!(env.balance(&closed), payouts[1]);
        // A parked return goes to `refund_to`, never the beneficiary.
        env.set_round_ticket(&tickets[2], |t| t.status = RoundTicketStatus::ReturnParked);
        let ix = env.claim_round_payout_ix(&keeper.pubkey(), &tickets[2], &other_mint);
        assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::BeneficiaryMismatch);
        let refund_to = addr(ts[2].refund_to);
        let f0 = env.balance(&refund_to);
        env.claim_round_payout(&tickets[2]).unwrap();
        assert_eq!(env.balance(&refund_to), f0 + payouts[2]);
        assert_eq!(
            env.balance(&env.a.payout_escrow),
            escrow0,
            "escrow back to where it was"
        );
    }

    /// A ticket still joined has nothing to claim.
    #[test]
    fn a_joined_ticket_has_nothing_to_claim() {
        let mut env = setup();
        let (_cast, id, tickets) = drawn_round(&mut env, 2, 1, 1);
        let keeper = env.keeper.insecure_clone();
        let b = addr(env.round_ticket(&tickets[0]).beneficiary);
        let ix = env.claim_round_payout_ix(&keeper.pubkey(), &tickets[0], &b);
        assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::WrongTicketStatus);
        // The claim's checks in their order (Spec 08 §13.8): remaining
        // accounts, then the status, then the destination.
        let mut ix = env.claim_round_payout_ix(&keeper.pubkey(), &tickets[0], &b);
        ix.accounts
            .push(AccountMeta::new_readonly(Address::new_unique(), false));
        assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::RemainingAccounts);
        let thief = env.usdc_account(&Address::new_unique(), 0);
        let ix = env.claim_round_payout_ix(&keeper.pubkey(), &tickets[0], &thief);
        assert_fails_with(env.send(&[ix], &[&keeper]), FadeError::WrongTicketStatus);
        env.settle_round(id, &tickets).unwrap();
        // Closed: nothing left to claim.
        assert!(!env.exists(&tickets[0]));
    }

    /// Anchor's `ConstraintSeeds`.
    const CONSTRAINT_SEEDS: u32 = 2006;
    /// Anchor's `ConstraintDuplicateMutableAccount`: one account named for
    /// two mutable ones, checked before any constraint.
    const DUPLICATE_MUTABLE: u32 = 2040;

    /// A copy of `from` at a new address, owner, lamports and data kept: a
    /// forgery every check but its address accepts.
    fn forged_copy(env: &mut Env, from: &Address) -> Address {
        let account = env.svm.get_account(from).unwrap();
        let to = Address::new_unique();
        env.svm.set_account(to, account).unwrap();
        to
    }

    /// `refused_ix`, `extra` also unmoved.
    #[track_caller]
    #[allow(clippy::too_many_arguments)]
    fn refused_pinned(
        env: &mut Env,
        caller: &Keypair,
        ix: Instruction,
        id: u64,
        tickets: &[Address],
        extra: &[Address],
        code: u32,
    ) {
        let before = snapshot(env, extra);
        refused_ix(env, caller, ix, id, tickets, |f| f.has_code(code));
        assert_eq!(snapshot(env, extra), before, "a refusal moves nothing");
    }

    /// Every fixed account of `settle_round_tickets` and `claim_round_payout`
    /// is pinned (Spec 08 §13.10), each substitution refused before
    /// anything moves: a forged copy of the configuration, the vault, the
    /// round or a parked ticket; an attacker's token account, or the
    /// vault's other one, as `payout_escrow` or `vault_usdc` (the escrow
    /// swapped for `vault_usdc` would pay a parked payout twice out of LP
    /// funds; an attacker's escrow would take a frozen winner's payout);
    /// the caller's own account, or another round's, as `round_vrf`, at the
    /// first settlement (which would set `C` from its lamports) and at a
    /// later one; a random `vault_authority`; another mint. The batch and
    /// the claim then succeed with the real accounts.
    #[test]
    fn every_fixed_account_is_pinned() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 2);
        let (id, tickets) = fill(&mut env, &cast, 4);
        draw(&mut env, id, &tickets, |w| w[0] && w[3] && mixed(w));
        // Ticket 0 wins with its beneficiary frozen: its payout goes to the
        // escrow.
        let frozen = addr(env.round_ticket(&tickets[0]).beneficiary);
        env.set_token_state(&frozen, 2);
        let caller = funded(&mut env);
        let attacker = env.usdc_account(&caller.pubkey(), 7 * USDC);
        let other_mint = Address::new_unique();
        fade_testkit::token::write_mint(&mut env.svm, other_mint, &caller.pubkey(), 6);
        let (config, vault) = (env.a.config, env.a.vault);
        let config = forged_copy(&mut env, &config);
        let vault = forged_copy(&mut env, &vault);
        let round = forged_copy(&mut env, &round_address(id));
        let other_vrf = round_vrf_address(id + 1);
        env.svm.airdrop(&other_vrf, 5_000_000).unwrap();
        assert!(
            env.lamports(&round_vrf_address(id)) > 0,
            "a refund to drain"
        );
        let extra = [attacker, config, vault, round, other_vrf, other_mint];
        let rp = addr(env.round(id).rent_payer);
        let (escrow, vault_usdc) = (env.a.payout_escrow, env.a.vault_usdc);
        let caller_key = caller.pubkey();

        // SettleRoundTickets: 1 config, 2 vault, 3 round, 4 round_vrf,
        // 6 payout_escrow, 7 vault_usdc, 8 vault_authority, 9 usdc_mint.
        let wrong_mint = fade_error(FadeError::WrongMint);
        let first: Vec<(usize, Address, u32)> = vec![
            (1, config, CONSTRAINT_SEEDS),
            (2, vault, CONSTRAINT_SEEDS),
            (3, round, CONSTRAINT_SEEDS),
            (4, caller_key, CONSTRAINT_SEEDS),
            (4, other_vrf, CONSTRAINT_SEEDS),
            (6, attacker, CONSTRAINT_SEEDS),
            (6, vault_usdc, DUPLICATE_MUTABLE),
            (7, attacker, CONSTRAINT_SEEDS),
            (7, escrow, DUPLICATE_MUTABLE),
            (8, Address::new_unique(), CONSTRAINT_SEEDS),
            (8, caller_key, CONSTRAINT_SEEDS),
            (9, other_mint, wrong_mint),
        ];
        let g: Vec<Group> = tickets[..2]
            .iter()
            .map(|t| env.round_group(id, t))
            .collect();
        for (at, with, code) in &first {
            let mut ix = env.settle_round_ix(&caller_key, id, &g, Some(rp));
            ix.accounts[*at].pubkey = *with;
            refused_pinned(&mut env, &caller, ix, id, &tickets, &extra, *code);
        }
        assert_eq!(env.round(id).status, RoundStatus::Requested);
        let ix = env.settle_round_ix(&caller_key, id, &g, Some(rp));
        send(&mut env, &caller, ix).unwrap();
        assert_eq!(env.round(id).status, RoundStatus::Drawn);
        assert_eq!(
            env.round_ticket(&tickets[0]).status,
            RoundTicketStatus::PayoutParked
        );

        // A later settlement: `round_vrf` is no longer read, still pinned.
        let g: Vec<Group> = tickets[2..]
            .iter()
            .map(|t| env.round_group(id, t))
            .collect();
        for (at, with, code) in first.iter().filter(|(at, ..)| *at != 3) {
            let mut ix = env.settle_round_ix(&caller_key, id, &g, Some(rp));
            ix.accounts[*at].pubkey = *with;
            refused_pinned(&mut env, &caller, ix, id, &tickets, &extra, *code);
        }
        let ix = env.settle_round_ix(&caller_key, id, &g, Some(rp));
        send(&mut env, &caller, ix).unwrap();
        assert_eq!(env.round(id).tickets, 0);

        // ClaimRoundPayout: 1 config, 2 ticket, 4 payout_escrow,
        // 5 vault_authority, 7 usdc_mint. The beneficiary can receive
        // again: only the substitution stands in the way.
        env.set_token_state(&frozen, 1);
        let parked = tickets[0];
        let forged = forged_copy(&mut env, &parked);
        let w = env.round_ticket(&parked);
        let payer = addr(w.payer);
        let watched_claim = [
            caller_key,
            parked,
            forged,
            frozen,
            payer,
            escrow,
            vault_usdc,
            env.a.vault,
            attacker,
            config,
            other_mint,
        ];
        let claim: Vec<(usize, Address, u32)> = vec![
            (1, config, CONSTRAINT_SEEDS),
            (2, forged, CONSTRAINT_SEEDS),
            (4, vault_usdc, CONSTRAINT_SEEDS),
            (4, attacker, CONSTRAINT_SEEDS),
            (5, Address::new_unique(), CONSTRAINT_SEEDS),
            (5, caller_key, CONSTRAINT_SEEDS),
            (7, other_mint, wrong_mint),
        ];
        for (at, with, code) in &claim {
            let mut ix = env.claim_round_payout_ix(&caller_key, &parked, &frozen);
            ix.accounts[*at].pubkey = *with;
            let before = snapshot(&env, &watched_claim);
            let err = send(&mut env, &caller, ix).expect_err("refused");
            assert!(
                err.has_code(*code),
                "{at}: {}\n{}",
                err.err,
                err.logs.join("\n")
            );
            assert_eq!(
                snapshot(&env, &watched_claim),
                before,
                "a refused claim moves nothing"
            );
        }
        let escrow0 = env.balance(&escrow);
        let ix = env.claim_round_payout_ix(&caller_key, &parked, &frozen);
        send(&mut env, &caller, ix).unwrap();
        assert_eq!(env.balance(&frozen), w.payout);
        assert_eq!(env.balance(&escrow), escrow0 - w.payout);
        assert!(!env.exists(&parked));
    }

    /// A payer left with no lamports: a settlement credits it only with at
    /// least a ticket's rent, never a smaller amount the runtime would
    /// refuse for a new account, so the batch succeeds; a parked ticket
    /// keeps its payer's lamports until the claim.
    #[test]
    fn a_payer_with_no_lamports_never_fails_a_batch() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        let (id, tickets) = fill(&mut env, &cast, 4);
        draw(&mut env, id, &tickets, mixed);
        let payer = cast.payers[0].pubkey();
        let g: Vec<Group> = tickets.iter().map(|t| env.round_group(id, t)).collect();
        let w = g.iter().position(|x| x.beneficiary.is_some()).unwrap();
        let b = g[w].beneficiary.unwrap();
        env.set_token_state(&b, 2);
        env.svm
            .set_account(
                payer,
                Account {
                    lamports: 0,
                    data: vec![],
                    owner: system_id(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        // The parked winner alone: its payer is credited nothing.
        let keeper = env.keeper.insecure_clone();
        let ix = env.settle_round_ix(&keeper.pubkey(), id, &g[w..w + 1], None);
        env.send_v0(&[compute_limit_ix(1_400_000), ix], &[&keeper], &[])
            .unwrap();
        assert_eq!(env.lamports(&payer), 0);
        // Then the rest: rent and returns, at least a ticket's rent each.
        let rest: Vec<Address> = (0..4).filter(|i| *i != w).map(|i| tickets[i]).collect();
        env.settle_round(id, &rest).unwrap();
        assert!(env.lamports(&payer) >= rent(&env, TICKET_LEN));
        env.set_token_state(&b, 1);
        env.claim_round_payout(&tickets[w]).unwrap();
    }

    /// A payer that is every ticket's payer, the round's rent payer and its
    /// sponsor, turned into an upgradeable program after the joins: no exit
    /// hands it to a CPI, so the batches, the parked winner's claim and the
    /// reclaim that closes the round all credit it directly and land.
    #[test]
    fn a_payer_turned_program_never_fails_a_batch() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        let (id, tickets) = fill(&mut env, &cast, 4);
        draw(&mut env, id, &tickets, mixed);
        let payer = cast.payers[0].pubkey();
        assert_eq!(addr(env.round(id).rent_payer), payer);
        let g: Vec<Group> = tickets.iter().map(|t| env.round_group(id, t)).collect();
        let w = g.iter().position(|x| x.beneficiary.is_some()).unwrap();
        let b = g[w].beneficiary.unwrap();
        env.set_token_state(&b, 2);
        env.turn_into_program(&payer);
        let p0 = env.lamports(&payer);
        // The parked winner alone: its payer is credited nothing.
        let keeper = env.keeper.insecure_clone();
        let ix = env.settle_round_ix(&keeper.pubkey(), id, &g[w..w + 1], None);
        env.send_v0(&[compute_limit_ix(1_400_000), ix], &[&keeper], &[])
            .unwrap();
        assert_eq!(env.lamports(&payer), p0);
        let rest: Vec<Address> = (0..4).filter(|i| *i != w).map(|i| tickets[i]).collect();
        env.settle_round(id, &rest).unwrap();
        assert!(env.lamports(&payer) >= p0 + rent(&env, TICKET_LEN));
        env.set_token_state(&b, 1);
        env.claim_round_payout(&tickets[w]).unwrap();
        let before_reclaim = env.lamports(&payer);
        env.reclaim(id, &payer).unwrap();
        assert!(!env.exists(&round_address(id)));
        assert!(env.lamports(&payer) >= before_reclaim + rent(&env, ROUND_LEN));
        let v = env.vault();
        assert_eq!((v.open_before_close, v.open_after_close), (0, 0));
    }

    /// The round closes in the batch that settles its last ticket when no
    /// sponsorship is left, every lamport to its stored rent payer, which
    /// that batch must name (`RentReceiverRequired`); a batch that leaves a
    /// ticket in the round needs none.
    #[test]
    fn the_rent_payer_is_required_to_close() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        // Paid by its ticket prices alone: no sponsorship to reclaim.
        let id = env.joining_round();
        let mut tickets = Vec::new();
        for (i, price) in [5 * USDC, 4 * USDC].into_iter().enumerate() {
            let beneficiary = env_usdc(&mut env);
            tickets.push(join_as(
                &mut env,
                &cast.integrators[0],
                cast.shares[0],
                &cast.payers[i],
                &cast.funder,
                beneficiary,
                &coin_flip(),
                price,
                0,
            ));
        }
        assert_eq!(env.round(id).sponsors, 0);
        draw(&mut env, id, &tickets, mixed);
        let caller = funded(&mut env);
        let g: Vec<Group> = tickets.iter().map(|t| env.round_group(id, t)).collect();
        for rp in [None, Some(caller.pubkey()), Some(cast.payers[1].pubkey())] {
            let ix = env.settle_round_ix(&caller.pubkey(), id, &g, rp);
            let code = fade_error(FadeError::RentReceiverRequired);
            refused_ix(&mut env, &caller, ix, id, &tickets, |f| f.has_code(code));
        }
        let ix = env.settle_round_ix(&caller.pubkey(), id, &g[..1], None);
        send(&mut env, &caller, ix).unwrap();
        let rp = addr(env.round(id).rent_payer);
        assert_eq!(rp, cast.payers[0].pubkey());
        let rp0 = env.lamports(&rp);
        let round_l = env.lamports(&round_address(id));
        let ix = env.settle_round_ix(&caller.pubkey(), id, &g[1..], Some(rp));
        let meta = send(&mut env, &caller, ix).unwrap();
        assert!(!env.exists(&round_address(id)));
        let closed = events::<RoundClosed>(&meta);
        assert_eq!(closed.len(), 1);
        let back = env.lamports(&rp) - rp0;
        assert_eq!(closed[0].lamports, back);
        assert!(closed[0].lamports <= round_l);
        assert!(closed[0].lamports >= rent(&env, ROUND_LEN));
    }

    fn env_usdc(env: &mut Env) -> Address {
        env.usdc_account(&Address::new_unique(), 0)
    }

    /// A payer whose address has since become a program (executable, not
    /// writable by Fade's data rules) still receives its lamports: on the
    /// mainnet feature set an executable account may be credited, so no
    /// payer can make its ticket unsettleable and hold the strike. The
    /// test rewrites the stored payer to a deployed program's address.
    #[test]
    fn a_payer_that_became_a_program_still_settles() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        let (id, tickets) = fill(&mut env, &cast, 3);
        draw(&mut env, id, &tickets, mixed);
        let program = addr(test_integrator::ID);
        assert!(env.svm.get_account(&program).unwrap().executable);
        for t in &tickets {
            env.set_round_ticket(t, |w| w.payer = pk(program));
        }
        let l0 = env.lamports(&program);
        env.settle_round(id, &tickets).unwrap();
        assert!(env.lamports(&program) > l0);
        assert!(tickets.iter().all(|t| !env.exists(t)));
    }

    // --- measurements (Spec 08 §13.5.7 and §9) -------------------------------------------

    /// A payout table that almost always pays 0.99×: every ticket a winner.
    fn sure() -> Vec<Outcome> {
        vec![
            Outcome {
                p: 990_000_000,
                m: 9_900,
            },
            Outcome {
                p: 10_000_000,
                m: 0,
            },
        ]
    }

    #[derive(Clone, Copy, Debug, PartialEq)]
    enum Mix {
        /// One integrator paying its players' SOL: one payer, one table.
        Shared,
        /// Every ticket its own payer, one integrator.
        OwnPayer,
        /// Every ticket its own payer and integrator.
        OwnPayerAndIntegrator,
    }

    impl Mix {
        fn cast(self, env: &mut Env, n: usize) -> Cast {
            match self {
                Mix::Shared => cast(env, 1, 1),
                Mix::OwnPayer => cast(env, 1, n),
                Mix::OwnPayerAndIntegrator => cast(env, n, n),
            }
        }
    }

    /// The accounts a Fade-owned lookup table would hold for every round:
    /// the fixed accounts that do not change from round to round, and the
    /// shared accounts of the integrators that use it.
    fn global_table(env: &mut Env, shared: &[Address]) -> AddressLookupTableAccount {
        let mut v = vec![
            env.a.config,
            env.a.vault,
            env.a.payout_escrow,
            env.a.vault_usdc,
            env.a.vault_authority,
            env.a.usdc_mint,
            fade_testkit::token::token_program_id(),
            system_id(),
            env.a.event_authority,
        ];
        for a in shared {
            if !v.contains(a) {
                v.push(*a);
            }
        }
        env.lookup_table(&v)
    }

    /// The batch transaction a settler signs and pays alone: the compute
    /// limit and price, then the settlement.
    fn batch_ixs(env: &Env, caller: &Address, id: u64, groups: &[Group]) -> Vec<Instruction> {
        let rp = addr(env.round(id).rent_payer);
        vec![
            compute_limit_ix(1_400_000),
            compute_price_ix(100_000),
            env.settle_round_ix(caller, id, groups, Some(rp)),
        ]
    }

    fn legacy_size(env: &Env, ixs: &[Instruction], signer: &Keypair) -> usize {
        let tx = solana_transaction::Transaction::new_signed_with_payer(
            ixs,
            Some(&signer.pubkey()),
            &[signer],
            env.svm.latest_blockhash(),
        );
        1 + 64 * tx.signatures.len() + tx.message_data().len()
    }

    fn accounts_locked(ixs: &[Instruction], signer: &Address) -> usize {
        let mut keys = vec![*signer];
        for ix in ixs {
            for a in std::iter::once(&ix.program_id).chain(ix.accounts.iter().map(|m| &m.pubkey)) {
                if !keys.contains(a) {
                    keys.push(*a);
                }
            }
        }
        keys.len()
    }

    /// Spec 08 §13.5.7 and §9: compute units and
    /// transaction sizes of grouped settlement at 1, 8, 16 and 21 tickets,
    /// 30 % winners, in the three compositions of §13.5.7's table, without
    /// a lookup table, with a Fade-owned one (fixed accounts and the
    /// integrators' shared accounts) and with a per-round one (the round's
    /// accounts and its tickets too); then the largest batch each fits in
    /// 1 232 bytes and 64 account locks, and two worst cases for the 32 KiB
    /// heap, run for real. Printed with `--nocapture`; the figures are in
    /// Spec 08 §13.5.7.
    #[test]
    fn compute_units_and_sizes() {
        for mix in [Mix::Shared, Mix::OwnPayer, Mix::OwnPayerAndIntegrator] {
            for n in [1usize, 8, 16, 21] {
                let mut env = setup();
                let cast = mix.cast(&mut env, n);
                let (id, tickets) = fill_with(&mut env, &cast, n, &[coin_flip()]);
                let want = (3 * n + 5) / 10;
                draw(&mut env, id, &tickets, |w| {
                    w.iter().filter(|x| **x).count() == want
                });
                let groups: Vec<Group> = tickets.iter().map(|t| env.round_group(id, t)).collect();
                let settler = funded(&mut env);
                let ixs = batch_ixs(&env, &settler.pubkey(), id, &groups);
                let mut shared = Vec::new();
                for g in &groups {
                    for a in [g.integrator, g.payer, g.payout_table] {
                        if !shared.contains(&a) {
                            shared.push(a);
                        }
                    }
                }
                let global = global_table(&mut env, &shared);
                let mut per_round = shared.clone();
                per_round.extend(tickets.iter().copied());
                let round_t = round_table(&mut env, id, &per_round);
                let plain = legacy_size(&env, &ixs, &settler);
                let with_global =
                    tx_size(&env.v0_transaction(&ixs, &[&settler], std::slice::from_ref(&global)));
                let tx = env.v0_transaction(&ixs, &[&settler], std::slice::from_ref(&round_t));
                let with_round = tx_size(&tx);
                assert!(with_round <= LIMIT);
                let locks = accounts_locked(&ixs, &settler.pubkey());
                let fits = |b: usize| if b > LIMIT { " (too large)" } else { "" };
                if locks > LOCKS {
                    eprintln!(
                        "SETTLE {mix:?} n={n} winners={want}: {locks} accounts, above the {LOCKS}-account lock limit; \
                         {plain} bytes without a lookup table{}, {with_global} with a Fade table{}, {with_round} with a per-round table",
                        fits(plain),
                        fits(with_global),
                    );
                    continue;
                }
                let meta = env
                    .send_versioned(tx)
                    .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
                let cu = meta.compute_units_consumed;
                let per = |micro: u64| (5_000 + cu * micro / 1_000_000) / n as u64;
                eprintln!(
                    "SETTLE {mix:?} n={n} winners={want}: {cu} CU ({} per ticket); \
                     {plain} bytes without a lookup table{}, {with_global} with a Fade table{}, \
                     {with_round} with a per-round table; {locks} accounts; \
                     fee per ticket {} lamports at 100 000 µL/CU, {} at 1 000 000",
                    cu / n as u64,
                    fits(plain),
                    fits(with_global),
                    per(100_000),
                    per(1_000_000),
                );
                assert!(cu < 1_400_000);
            }
        }

        // The largest batch each composition fits, 30 % winners: sizes
        // depend only on how many distinct accounts a batch names.
        let mut env = setup();
        let (_c, id, _t) = drawn_round(&mut env, 2, 1, 1);
        let settler = funded(&mut env);
        let integrator = Address::new_unique();
        let payer = Address::new_unique();
        let table = env.payout_table_address(&coin_flip());
        for mix in [Mix::Shared, Mix::OwnPayer, Mix::OwnPayerAndIntegrator] {
            let mut best = [0usize; 3];
            for n in 1..=32usize {
                let groups: Vec<Group> = (0..n)
                    .map(|i| Group {
                        ticket: Address::new_unique(),
                        integrator: if mix == Mix::OwnPayerAndIntegrator {
                            Address::new_unique()
                        } else {
                            integrator
                        },
                        payer: if mix == Mix::Shared {
                            payer
                        } else {
                            Address::new_unique()
                        },
                        payout_table: table,
                        beneficiary: [0, 3, 6].contains(&(i % 10)).then(Address::new_unique),
                    })
                    .collect();
                let ixs = batch_ixs(&env, &settler.pubkey(), id, &groups);
                let shared: Vec<Address> = groups
                    .iter()
                    .flat_map(|g| [g.integrator, g.payer, g.payout_table])
                    .collect();
                let global = global_table(&mut env, &shared);
                let mut per_round = shared.clone();
                per_round.extend(groups.iter().map(|g| g.ticket));
                let round_t = round_table(&mut env, id, &per_round);
                let locks = accounts_locked(&ixs, &settler.pubkey());
                let sizes = [
                    legacy_size(&env, &ixs, &settler),
                    tx_size(&env.v0_transaction(&ixs, &[&settler], std::slice::from_ref(&global))),
                    tx_size(&env.v0_transaction(&ixs, &[&settler], std::slice::from_ref(&round_t))),
                ];
                for k in 0..3 {
                    if sizes[k] <= LIMIT && locks <= LOCKS {
                        best[k] = n;
                    }
                }
            }
            eprintln!(
                "FITS {mix:?}, 30 % winners: {} tickets without a lookup table, {} with a Fade table, {} with a per-round table",
                best[0], best[1], best[2]
            );
        }

        // The heap's worst cases, run: every ticket a winner, its payout a
        // token transfer, as many tickets as the account locks allow (22
        // sharing an integrator and a payer, 11 each with its own).
        // And the longest batch, 32 tickets sharing an integrator and a
        // payer, 30 % winners.
        for (mix, n, all) in [
            (Mix::Shared, 22usize, true),
            (Mix::OwnPayerAndIntegrator, 11, true),
            (Mix::Shared, 32, false),
        ] {
            let mut env = setup();
            let k = env.keeper.insecure_clone();
            env.register_payout_table(&k, &sure()).unwrap();
            let cast = mix.cast(&mut env, n);
            let table = if all { sure() } else { coin_flip() };
            let (id, tickets) = fill_with(&mut env, &cast, n, &[table]);
            let want = if all { n } else { (3 * n + 5) / 10 };
            draw(&mut env, id, &tickets, |w| {
                w.iter().filter(|x| **x).count() == want
            });
            let groups: Vec<Group> = tickets.iter().map(|t| env.round_group(id, t)).collect();
            let settler = funded(&mut env);
            let ixs = batch_ixs(&env, &settler.pubkey(), id, &groups);
            let mut per_round: Vec<Address> = Vec::new();
            for g in &groups {
                per_round.extend([g.ticket, g.integrator, g.payer, g.payout_table]);
            }
            let round_t = round_table(&mut env, id, &per_round);
            let tx = env.v0_transaction(&ixs, &[&settler], std::slice::from_ref(&round_t));
            let size = tx_size(&tx);
            assert!(accounts_locked(&ixs, &settler.pubkey()) <= LOCKS);
            let meta = env
                .send_versioned(tx)
                .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
            eprintln!(
                "HEAP {mix:?} n={n}, {want} winners: {} CU, {size} bytes with a per-round table, {} accounts",
                meta.compute_units_consumed,
                accounts_locked(&ixs, &settler.pubkey())
            );
        }

        // The first settlement's own cost (draining `round_vrf`, fixing the
        // draw cost, `RoundDrawn`), and `claim_round_payout`.
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        let (id, tickets) = fill_with(&mut env, &cast, 3, &[coin_flip()]);
        draw(&mut env, id, &tickets, |w| w == [false, false, true]);
        let mut cus = Vec::new();
        for t in &tickets[..2] {
            cus.push(
                env.settle_round(id, std::slice::from_ref(t))
                    .unwrap()
                    .compute_units_consumed,
            );
        }
        let b = addr(env.round_ticket(&tickets[2]).beneficiary);
        env.set_token_state(&b, 2);
        let parked = env
            .settle_round(id, &tickets[2..])
            .unwrap()
            .compute_units_consumed;
        env.set_token_state(&b, 1);
        let claim = env
            .claim_round_payout(&tickets[2])
            .unwrap()
            .compute_units_consumed;
        eprintln!(
            "ONE losing ticket: {} CU as the round's first settlement, {} as a later one; \
             a winner parked: {parked}; claim_round_payout: {claim}",
            cus[0], cus[1]
        );
    }

    /// The largest batch that fits `locks` account locks, 1 232 bytes and
    /// the instruction trace as
    /// `settle_checked` sends it (the keeper paying the fee, through a
    /// per-round lookup table holding the beneficiaries too): every ticket its own integrator and payer
    /// if `own`, its own payout table if `distinct`, a winner if `winner`.
    fn largest_batch(locks: usize, own: bool, distinct: bool, winner: bool) -> usize {
        let mut env = setup();
        let (_c, id, _t) = drawn_round(&mut env, 2, 1, 1);
        let settler = funded(&mut env);
        let keeper = env.keeper.insecure_clone();
        let rp = addr(env.round(id).rent_payer);
        let (integrator, payer, table) = (
            Address::new_unique(),
            Address::new_unique(),
            Address::new_unique(),
        );
        let fresh = |yes: bool, shared: Address| {
            if yes {
                Address::new_unique()
            } else {
                shared
            }
        };
        let mut n = 0;
        for k in 1..=32usize {
            let groups: Vec<Group> = (0..k)
                .map(|_| Group {
                    ticket: Address::new_unique(),
                    integrator: fresh(own, integrator),
                    payer: fresh(own, payer),
                    payout_table: fresh(distinct, table),
                    beneficiary: winner.then(Address::new_unique),
                })
                .collect();
            let ixs = [
                compute_limit_ix(1_400_000),
                env.settle_round_ix(&settler.pubkey(), id, &groups, Some(rp)),
            ];
            let mut per_round: Vec<Address> = Vec::new();
            for g in &groups {
                per_round.extend([g.ticket, g.integrator, g.payer, g.payout_table]);
                per_round.extend(g.beneficiary);
            }
            let t = round_table(&mut env, id, &per_round);
            let size =
                tx_size(&env.v0_transaction(&ixs, &[&keeper, &settler], std::slice::from_ref(&t)));
            let winners = if winner { k } else { 0 };
            if size <= LIMIT
                && accounts_locked(&ixs, &keeper.pubkey()) <= locks
                && trace_length(ixs.len(), k, winners) <= TRACE
            {
                n = k;
            }
        }
        n
    }

    /// The instructions a transaction may run, its own and every CPI
    /// (`MAX_INSTRUCTION_TRACE_LENGTH`).
    const TRACE: usize = 64;

    /// A settlement transaction's instruction trace, at most: its `top`
    /// instructions, one event per ticket, one token transfer per winner,
    /// and at most three more (the drain of `round_vrf` and `RoundDrawn` at
    /// the first settlement, `RoundClosed` at the last).
    fn trace_length(top: usize, tickets: usize, winners: usize) -> usize {
        top + tickets + winners + 3
    }

    /// 32 outcomes, distinct for each `i`: 31 that pay, then a loss. A
    /// `winner` table loses with probability 1.11 %, any other wins with
    /// probability 3.1 %.
    fn distinct_table(i: u64, winner: bool) -> Vec<Outcome> {
        let (p, m) = if winner {
            (31_900_000, 9_500)
        } else {
            (1_000_000, 20_000)
        };
        let mut t: Vec<Outcome> = (0..31u64).map(|_| Outcome { p, m }).collect();
        t[0].m = m + i;
        t.push(Outcome {
            p: 1_000_000_000 - 31 * p,
            m: 0,
        });
        t
    }

    /// Settles in one batch, every effect checked by `settle_checked`, the
    /// largest batch `largest_batch` allows on `env` (whose lock limit is
    /// `locks`), every ticket on a 32-outcome table, its own if `distinct`,
    /// and every ticket winning or every ticket losing. Returns the batch's
    /// size and compute units.
    fn heap_case(
        mut env: Env,
        locks: usize,
        own: bool,
        distinct: bool,
        winner: bool,
    ) -> (usize, u64) {
        let n = largest_batch(locks, own, distinct, winner);
        let k = env.keeper.insecure_clone();
        let tables: Vec<Vec<Outcome>> = if distinct {
            (0..n as u64).map(|i| distinct_table(i, winner)).collect()
        } else {
            vec![distinct_table(0, winner)]
        };
        for t in &tables {
            env.register_payout_table(&k, t).unwrap();
        }
        let cast = if own {
            cast(&mut env, n, n)
        } else {
            cast(&mut env, 1, 1)
        };
        let (id, tickets) = fill_with(&mut env, &cast, n, &tables);
        draw(&mut env, id, &tickets, |w| w.iter().all(|x| *x == winner));
        let mut per_round: Vec<Address> = Vec::new();
        let mut table_keys = std::collections::BTreeSet::new();
        for t in &tickets {
            let g = env.round_group(id, t);
            table_keys.insert(g.payout_table);
            per_round.extend([g.ticket, g.integrator, g.payer, g.payout_table]);
            per_round.extend(g.beneficiary);
        }
        assert_eq!(table_keys.len(), tables.len());
        let round_t = round_table(&mut env, id, &per_round);
        let meta = settle_checked(&mut env, id, &tickets, std::slice::from_ref(&round_t));
        (n, meta.compute_units_consumed)
    }

    /// The heap holds every batch the account locks allow, whatever its
    /// payout tables, integrators and payers: the largest batch of each
    /// composition, every ticket on a 32-outcome table, all winners and all
    /// losers, on today's 64 locks and on the 128 of
    /// `increase_tx_account_lock_limit`, where the instruction trace bounds
    /// a batch of winners before the locks do.
    /// Measured figures printed with `--nocapture`.
    #[test]
    fn the_heap_holds_every_batch_the_locks_allow() {
        for (locks, own, distinct, winner) in [
            (64, false, true, false),
            (64, false, true, true),
            (64, true, true, true),
            (128, false, false, true),
            (128, false, true, false),
            (128, false, true, true),
            (128, true, true, false),
            (128, true, true, true),
        ] {
            let env = if locks == 64 {
                setup()
            } else {
                let mut env = Env::with_128_locks();
                env.found(VAULT);
                env
            };
            let (n, cu) = heap_case(env, locks, own, distinct, winner);
            eprintln!(
                "HEAP {locks} locks, {} integrators and payers, {} tables, n={n} all {}: {cu} CU",
                if own { "own" } else { "shared" },
                if distinct { "distinct" } else { "one" },
                if winner { "winners" } else { "losers" },
            );
            if locks == 64 && distinct && !own && !winner {
                assert!(n >= 20, "{n} tickets: the case that ran out of heap");
            }
            if locks == 128 && !own && !distinct {
                assert_eq!(n, 29, "the trace, not the heap, bounds 128 locks");
            }
        }
    }

    /// The heap's worst case on 128 locks, built rather than found: as many
    /// tickets as a batch takes (32), as many winners as the trace then
    /// allows (27, each a token transfer), and every lock left spent on
    /// distinct accounts (a payout table per ticket, then as many payers as
    /// fit), since what the instruction allocates grows with its accounts,
    /// its tickets and its transfers and with nothing else. It settles,
    /// every effect checked.
    #[test]
    fn the_heaps_worst_case_on_128_locks_settles() {
        const N: usize = 32;
        const W: usize = 27;
        assert!(trace_length(2, N, W) <= TRACE);
        assert!(trace_length(2, N, W + 1) > TRACE);
        // Wins with probability 84.94 %: 27 winners of 32 are common.
        let table = |i: u64| -> Vec<Outcome> {
            let mut t: Vec<Outcome> = (0..31u64)
                .map(|_| Outcome {
                    p: 27_400_000,
                    m: 11_000,
                })
                .collect();
            t[0].m += i;
            t.push(Outcome {
                p: 1_000_000_000 - 31 * 27_400_000,
                m: 0,
            });
            t
        };
        // The most payers whose batch still locks at most 128 accounts.
        let locks_with = |env: &mut Env, payers: usize| -> usize {
            let (_c, id, _t) = drawn_round(env, 2, 1, 1);
            let settler = funded(env);
            let keeper = env.keeper.insecure_clone();
            let ps: Vec<Address> = (0..payers).map(|_| Address::new_unique()).collect();
            let integrator = Address::new_unique();
            let groups: Vec<Group> = (0..N)
                .map(|i| Group {
                    ticket: Address::new_unique(),
                    integrator,
                    payer: ps[i % payers],
                    payout_table: Address::new_unique(),
                    beneficiary: (i < W).then(Address::new_unique),
                })
                .collect();
            let rp = addr(env.round(id).rent_payer);
            let ixs = [
                compute_limit_ix(1_400_000),
                env.settle_round_ix(&settler.pubkey(), id, &groups, Some(rp)),
            ];
            accounts_locked(&ixs, &keeper.pubkey())
        };
        let mut probe = setup();
        let payers = (1..=N)
            .rev()
            .find(|p| locks_with(&mut probe, *p) <= 128)
            .unwrap();
        assert!(locks_with(&mut probe, payers) >= 127, "every lock spent");

        let mut env = Env::with_128_locks();
        env.found(VAULT);
        let k = env.keeper.insecure_clone();
        let tables: Vec<Vec<Outcome>> = (0..N as u64).map(table).collect();
        for t in &tables {
            env.register_payout_table(&k, t).unwrap();
        }
        let cast = cast(&mut env, 1, payers);
        let (id, tickets) = fill_with(&mut env, &cast, N, &tables);
        draw(&mut env, id, &tickets, |w| {
            w.iter().filter(|x| **x).count() == W
        });
        let mut per_round: Vec<Address> = Vec::new();
        let groups: Vec<Group> = tickets.iter().map(|t| env.round_group(id, t)).collect();
        for g in &groups {
            per_round.extend([g.ticket, g.integrator, g.payer, g.payout_table]);
            per_round.extend(g.beneficiary);
        }
        let round_t = round_table(&mut env, id, &per_round);
        let rp = addr(env.round(id).rent_payer);
        let caller = Address::new_unique();
        let ixs = [
            compute_limit_ix(1_400_000),
            env.settle_round_ix(&caller, id, &groups, Some(rp)),
        ];
        let locks = accounts_locked(&ixs, &env.keeper.pubkey());
        assert!((127..=128).contains(&locks), "{locks} locks");
        let meta = settle_checked(&mut env, id, &tickets, std::slice::from_ref(&round_t));
        eprintln!(
            "HEAP worst case, 128 locks: {N} tickets, {W} winners, {N} tables, {payers} payers, {locks} locks: {} CU",
            meta.compute_units_consumed
        );
    }

    /// On 128 locks a batch of 32 winners fits the bytes and the locks but
    /// not the 64-instruction trace (32 events and 32 transfers): the
    /// runtime refuses it whole, nothing moved, and the same tickets settle
    /// in two batches the trace allows.
    #[test]
    fn the_instruction_trace_bounds_a_batch_of_winners() {
        let mut env = Env::with_128_locks();
        env.found(VAULT);
        let k = env.keeper.insecure_clone();
        let table = distinct_table(0, true);
        env.register_payout_table(&k, &table).unwrap();
        let cast = cast(&mut env, 1, 1);
        let (id, tickets) = fill_with(&mut env, &cast, 32, std::slice::from_ref(&table));
        draw(&mut env, id, &tickets, |w| w.iter().all(|x| *x));
        let mut per_round: Vec<Address> = Vec::new();
        let groups: Vec<Group> = tickets.iter().map(|t| env.round_group(id, t)).collect();
        for g in &groups {
            per_round.extend([g.ticket, g.integrator, g.payer, g.payout_table]);
            per_round.extend(g.beneficiary);
        }
        let round_t = round_table(&mut env, id, &per_round);
        let caller = funded(&mut env);
        let watched = watched(&env, id, &caller.pubkey(), &tickets);
        let before = snapshot(&env, &watched);
        let rp = addr(env.round(id).rent_payer);
        let ixs = [
            compute_limit_ix(1_400_000),
            env.settle_round_ix(&caller.pubkey(), id, &groups, Some(rp)),
        ];
        assert!(trace_length(ixs.len(), 32, 32) > TRACE);
        let keeper = env.keeper.insecure_clone();
        let tx = env.v0_transaction(&ixs, &[&keeper, &caller], std::slice::from_ref(&round_t));
        assert!(tx_size(&tx) <= LIMIT);
        assert!(accounts_locked(&ixs, &keeper.pubkey()) <= 128);
        let f = env.send_versioned(tx).unwrap_err();
        assert!(
            f.err.contains("MaxInstructionTraceLengthExceeded"),
            "{}",
            f.err
        );
        assert_eq!(snapshot(&env, &watched), before, "nothing moved");
        settle_checked(&mut env, id, &tickets[..29], std::slice::from_ref(&round_t));
        settle_checked(&mut env, id, &tickets[29..], std::slice::from_ref(&round_t));
    }

    /// One account in several roles of a batch: a payer that has since
    /// become another winner's beneficiary token account, a rent payer that
    /// is a beneficiary too, and the caller a payer. Every CPI precedes every
    /// direct lamport move, so none of them meets a CPI with an unbalanced
    /// change, and the batch settles with every effect as specified.
    #[test]
    fn a_role_shared_across_accounts_settles() {
        let mut env = setup();
        let k = env.keeper.insecure_clone();
        env.register_payout_table(&k, &sure()).unwrap();
        let cast = cast(&mut env, 2, 3);
        let (id, tickets) = fill_with(&mut env, &cast, 5, &[sure(), coin_flip()]);
        draw(&mut env, id, &tickets, |w| w[0] && w[2] && w[4]);
        let ts: Vec<RoundTicket> = tickets.iter().map(|t| env.round_ticket(t)).collect();
        // Ticket 1's payer becomes ticket 0's beneficiary; the round's rent
        // payer becomes ticket 2's beneficiary.
        let b0 = addr(ts[0].beneficiary);
        let b2 = addr(ts[2].beneficiary);
        env.set_round_ticket(&tickets[1], |t| t.payer = pk(b0));
        env.set_round(id, None, |r| r.rent_payer = pk(b2));
        let caller = funded(&mut env);
        env.set_round_ticket(&tickets[3], |t| t.payer = pk(caller.pubkey()));
        let groups: Vec<Group> = tickets.iter().map(|t| env.round_group(id, t)).collect();
        let keeper = env.keeper.insecure_clone();
        let r = env.round_randomness(id);
        let p0 = env.beacon_payout_with(id, &tickets[0], &r);
        let p2 = env.beacon_payout_with(id, &tickets[2], &r);
        // Batch A: ticket 1 credits b0 with lamports, ticket 0 pays b0 tokens.
        let b0_l = env.lamports(&b0);
        let batch = [groups[1].clone(), groups[0].clone(), groups[3].clone()];
        let ix = env.settle_round_ix(&caller.pubkey(), id, &batch, None);
        env.send_v0(&[compute_limit_ix(1_400_000), ix], &[&keeper, &caller], &[])
            .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        assert_eq!(env.balance(&b0), p0);
        assert!(
            env.lamports(&b0) > b0_l,
            "the payer's lamports reached the token account"
        );
        // The sponsor reclaims, then batch B pays b2 tokens and closes the
        // round to b2 in the same transaction.
        let sponsor = cast.payers[4 % 3].pubkey();
        env.reclaim(id, &sponsor).unwrap();
        let b2_l = env.lamports(&b2);
        let batch = [groups[2].clone(), groups[4].clone()];
        let ix = env.settle_round_ix(&caller.pubkey(), id, &batch, Some(b2));
        let meta = env
            .send_v0(&[compute_limit_ix(1_400_000), ix], &[&keeper, &caller], &[])
            .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        assert!(!env.exists(&round_address(id)));
        assert!(tickets.iter().all(|t| !env.exists(t)));
        assert_eq!(env.balance(&b2), p2);
        let closed = events::<RoundClosed>(&meta);
        assert_eq!(env.lamports(&b2), b2_l + closed[0].lamports);
    }
}

// --- refund_round, expire_round, return_round_ticket (Spec 08 §13.5.5, §13.5.8, §13.5.9)

mod round_ends {
    use super::settle_round_tickets::{
        at_slot, cast, fill, funded, join_as, rent, setup, vault_slack, Cast,
    };
    use super::*;
    use anchor_lang::{AccountSerialize, Space};
    use fade::events::{
        RoundClosed, RoundExpired, RoundOpened, RoundRefunded, RoundTicketReturned,
        SponsorshipReclaimed,
    };
    use fade::state::{Integrator, Round, RoundStatus, RoundTicketStatus};
    use fade_math::epoch::Side;
    use litesvm::types::TransactionMetadata;
    use solana_account::Account;
    use solana_address::Address;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_keypair::Keypair;
    use solana_signer::Signer;
    use std::collections::BTreeMap;

    const ROUND_LEN: usize = 411;

    fn ser<T: AccountSerialize>(x: &T) -> Vec<u8> {
        let mut d = Vec::new();
        x.try_serialize(&mut d).unwrap();
        d
    }

    fn set_account(env: &mut Env, address: &Address, f: impl FnOnce(&mut Account)) {
        let mut a = env.svm.get_account(address).unwrap();
        f(&mut a);
        env.svm.set_account(*address, a).unwrap();
    }

    /// `n` tickets in the round a join lands in now, none carrying a
    /// sponsorship: at 0.50 to 0.90 USDC each, far below the threshold, the
    /// round stays unpaid. Ticket `i` by integrator `i mod k`, payer
    /// `i mod p`, every third on the slot table. Returns the round and tickets.
    fn unpaid(env: &mut Env, cast: &Cast, n: usize) -> (u64, Vec<Address>) {
        let id = env.joining_round();
        let mut tickets = Vec::new();
        for i in 0..n {
            let table = if i % 3 == 2 {
                slot_classic()
            } else {
                coin_flip()
            };
            let price = 500_000 + (i as u64 % 5) * 100_000;
            let a = i % cast.integrators.len();
            let p = i % cast.payers.len();
            let beneficiary = env.usdc_account(&Address::new_unique(), 0);
            tickets.push(join_as(
                env,
                &cast.integrators[a],
                cast.shares[a],
                &cast.payers[p],
                &cast.funder,
                beneficiary,
                &table,
                price,
                0,
            ));
        }
        assert_eq!(env.round(id).status, RoundStatus::Accepting);
        (id, tickets)
    }

    /// A participant of round `id` able to refund it, as `refund_round` asks:
    /// the cast's funder of one of its tickets, or else that ticket's payer,
    /// with that ticket.
    fn participant(env: &Env, cast: &Cast, id: u64) -> (Keypair, Address) {
        for k in &cast.integrators {
            if !env.exists(&env.integrator_address(&k.pubkey())) {
                continue;
            }
            for n in 0..env.integrator(&k.pubkey()).next_nonce {
                let t = env.round_ticket_address(&k.pubkey(), n);
                if !env.exists(&t) || env.round_ticket(&t).round != id {
                    continue;
                }
                let rt = env.round_ticket(&t);
                if addr(rt.funder) == cast.funder.key() {
                    return (cast.funder.kp.insecure_clone(), t);
                }
                if let Some(p) = cast.payers.iter().find(|p| p.pubkey() == addr(rt.payer)) {
                    return (p.insecure_clone(), t);
                }
            }
        }
        panic!("no ticket of round {id} funded or paid for by the cast");
    }

    /// Moves the clock to the first slot of round `id`'s refund window.
    fn to_refund_window(env: &mut Env, id: u64) {
        let r = env.round(id);
        at_slot(env, r.refund_from() + r.refund_slots);
    }

    /// Moves the clock to the first slot at which round `id` expires.
    fn to_expiry(env: &mut Env, id: u64) {
        let r = env.round(id);
        let now = env.now();
        env.set_time(r.close_slot + r.t_settle_slots + 1, now + 600);
    }

    /// Every account one of these instructions on round `id` and `tickets`
    /// could touch.
    fn watched(env: &Env, id: u64, caller: &Address, tickets: &[Address]) -> Vec<Address> {
        let mut v = vec![
            *caller,
            env.a.vault,
            round_address(id),
            round_vrf_address(id),
            env.a.payout_escrow,
            env.a.vault_usdc,
            env.a.config,
        ];
        if env.exists(&round_address(id)) {
            let r = env.round(id);
            v.extend([addr(r.randomness), addr(r.rent_payer)]);
        }
        for t in tickets {
            v.push(*t);
            if env.exists(t) {
                let w = env.round_ticket(t);
                v.extend([addr(w.integrator), addr(w.payer), addr(w.refund_to)]);
            }
        }
        v
    }

    fn snapshot(env: &Env, addresses: &[Address]) -> Vec<Option<Account>> {
        addresses.iter().map(|a| env.svm.get_account(a)).collect()
    }

    /// Sends `ix` signed by `caller`, the keeper paying the fee.
    fn send(
        env: &mut Env,
        caller: &Keypair,
        ix: Instruction,
    ) -> Result<TransactionMetadata, Failure> {
        let keeper = env.keeper.insecure_clone();
        env.send(&[ix], &[&keeper, caller])
    }

    /// `ix` is refused as `check` says, and nothing moved, byte for byte and
    /// lamport for lamport: the fee is the keeper's.
    #[track_caller]
    fn refused_ix(
        env: &mut Env,
        caller: &Keypair,
        ix: Instruction,
        id: u64,
        tickets: &[Address],
        check: impl Fn(&Failure) -> bool,
    ) {
        let mut addresses = watched(env, id, &caller.pubkey(), tickets);
        for m in &ix.accounts {
            if !addresses.contains(&m.pubkey) {
                addresses.push(m.pubkey);
            }
        }
        let before = snapshot(env, &addresses);
        let err = send(env, caller, ix).expect_err("refused");
        assert!(check(&err), "{}\n{}", err.err, err.logs.join("\n"));
        assert_eq!(snapshot(env, &addresses), before, "a refusal moves nothing");
    }

    #[track_caller]
    fn refused(
        env: &mut Env,
        caller: &Keypair,
        ix: Instruction,
        id: u64,
        tickets: &[Address],
        e: FadeError,
    ) {
        let code = fade_error(e);
        refused_ix(env, caller, ix, id, tickets, |f| f.has_code(code));
    }

    #[track_caller]
    fn refused_anchor(
        env: &mut Env,
        caller: &Keypair,
        ix: Instruction,
        id: u64,
        tickets: &[Address],
        code: u32,
    ) {
        refused_ix(env, caller, ix, id, tickets, |f| f.has_code(code));
    }

    // --- the effects, checked against the specification ------------------------------

    /// Refunds round `id` and checks every effect of §13.5.5: the vault's
    /// books field by field (credits, reservation and held shares out, ticket
    /// prices owed back, `accepting_round` cleared, the settled price and the
    /// counters untouched), the round `Refunded` and nothing else of it
    /// changed, no token and no lamport moved but the fee, the event.
    fn refund_checked(env: &mut Env, id: u64, cast: &Cast) -> TransactionMetadata {
        let (caller, proof) = participant(env, cast, id);
        let r0 = env.round(id);
        let v0 = env.vault();
        let slack0 = vault_slack(env);
        let price0 = v0.settled_price();
        let mut addresses = watched(env, id, &caller.pubkey(), &[]);
        addresses.push(env.keeper.pubkey());
        let lamports0: Vec<u64> = addresses.iter().map(|a| env.lamports(a)).collect();
        let usdc0 = env.balance(&env.a.vault_usdc);

        let ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
        let meta =
            send(env, &caller, ix).unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));

        let mut ev = v0.clone();
        let shares = r0.protocol_shares + r0.app_shares;
        assert_eq!(r0.credits + shares, r0.prices, "§13.4 fact 3, summed");
        ev.total_assets -= r0.credits;
        ev.open_vault_credits -= r0.credits;
        ev.total_reserved_liability -= r0.liability;
        ev.beacon_shares_held -= shares;
        ev.beacon_returns_owed += r0.prices;
        if v0.accepting_round == id {
            ev.accepting_round = 0;
        }
        let v = env.vault();
        assert_eq!(ser(&v), ser(&ev), "the vault's books, field by field");
        assert_eq!(v.settled_price(), price0, "a refund is no result");
        assert_eq!(vault_slack(env), slack0, "the vault identity, to the unit");
        assert_eq!(env.balance(&env.a.vault_usdc), usdc0, "no token moves");

        let mut er = r0.clone();
        er.status = RoundStatus::Refunded;
        assert_eq!(ser(&env.round(id)), ser(&er), "the round: its status alone");
        for (i, a) in addresses.iter().enumerate() {
            if *a != env.keeper.pubkey() {
                assert_eq!(env.lamports(a), lamports0[i], "no lamport moves: {a}");
            }
        }

        let e = events::<RoundRefunded>(&meta);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].version, 1);
        assert_eq!(addr(e[0].round), round_address(id));
        assert_eq!(addr(e[0].by), caller.pubkey());
        assert_eq!(
            (e[0].tickets, e[0].prices, e[0].sponsorship),
            (r0.tickets, r0.prices, r0.sponsorship)
        );
        meta
    }

    /// What `expire_round` is expected to have done: `C` and the refund.
    struct Expiry {
        draw_cost: u64,
        refund: u64,
    }

    /// Expires round `id` and checks every effect of §13.5.8: the counters
    /// left by every ticket at once with the recorded side and generation,
    /// the reservation and the credits released, the credits kept in the
    /// assets and booked as an after-close gain when the counter calls for
    /// it, the protocol's shares claimable, `round_vrf` drained when
    /// requested and `C` fixed, every lamport, the round field by field, the
    /// event.
    fn expire_checked(env: &mut Env, id: u64) -> (Expiry, TransactionMetadata) {
        let caller = funded(env);
        let r0 = env.round(id);
        let v0 = env.vault();
        let slack0 = vault_slack(env);
        let usdc0 = env.balance(&env.a.vault_usdc);
        let requested = r0.status == RoundStatus::Requested;
        let vrf0 = env.lamports(&round_vrf_address(id));
        let round_l0 = env.lamports(&round_address(id));
        let refund = if requested { vrf0 } else { 0 };
        let c = if requested {
            r0.funded + r0.request_share - refund.min(r0.funded)
        } else {
            0
        };
        assert!(c <= r0.draw_max, "C ≤ D_r");
        let caller_l0 = env.lamports(&caller.pubkey());

        let randomness = env.expiry_request(id);
        // Looked for: requested, its seed recorded, or SlotHashes proving it;
        // otherwise the expiry is a refund (`expire_refund_checked`).
        let retained = requested || r0.entropy_slot != 0 || entropy_retained(env, r0.close_slot);
        assert!(retained, "round {id} would be refunded, not forfeited");
        let found = retained
            && env.exists(&randomness)
            && env.svm.get_account(&randomness).unwrap().owner == orao_id();
        let ix = env.expire_round_ix(&caller.pubkey(), id, &randomness);
        let now = env.now();
        let meta =
            send(env, &caller, ix).unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));

        // The vault's books.
        let v = env.vault();
        let mut ev = v0.clone();
        ev.total_reserved_liability -= r0.liability;
        ev.open_vault_credits -= r0.credits;
        ev.beacon_shares_held -= r0.protocol_shares;
        ev.protocol_shares_accrued += r0.protocol_shares;
        // Counted, and as one a withheld draw may explain unless never
        // requested, looked for and not found (the keepers' failure): the
        // durable count the keeper's alarm compares.
        let checked = requested || retained;
        ev.rounds_forfeited += 1;
        ev.forfeits_withheld += u64::from(requested || found || !checked);
        match r0.side().unwrap() {
            Side::AfterClose if r0.generation == v0.generation => {
                ev.open_after_close -= r0.tickets;
                ev.after_close_gain += r0.credits;
            }
            Side::AfterClose => {
                assert_eq!(r0.generation + 1, v0.generation);
                ev.open_before_close -= r0.tickets;
            }
            Side::BeforeClose => {
                assert_eq!(r0.generation, v0.generation);
                ev.open_before_close -= r0.tickets;
            }
        }
        // The price observed once, from the books before to the books after
        // (§13.5.8, §13.7): computed here, never copied from the post-state.
        let (price0, price1) = (v0.settled_price().unwrap(), ev.settled_price().unwrap());
        assert!(price1 >= price0, "a forfeiture is a gain");
        let mut ring = v0.ring();
        ring.observe(now, price0, price1);
        ev.set_ring(&ring);
        assert_eq!(
            v.drawdown_trip_ts, v0.drawdown_trip_ts,
            "a gain trips nothing"
        );
        assert_eq!(
            (v.price_maxima, v.price_head_hour),
            (ring.maxima, ring.head_hour),
            "the drawdown ring observed the forfeiture once"
        );
        assert_eq!(ser(&v), ser(&ev), "the vault's books, field by field");
        assert_eq!(v.total_assets, v0.total_assets, "forfeiture, never refund");
        assert_eq!(vault_slack(env), slack0, "the vault identity, to the unit");
        assert_eq!(env.balance(&env.a.vault_usdc), usdc0, "no token moves");

        // Lamports: `round_vrf` drained to the round when requested.
        assert_eq!(
            env.lamports(&round_vrf_address(id)),
            vrf0 - refund,
            "round_vrf drained only when requested"
        );
        assert_eq!(env.lamports(&round_address(id)), round_l0 + refund);
        assert_eq!(env.lamports(&caller.pubkey()), caller_l0, "nobody is paid");

        // The round.
        let mut er = r0.clone();
        er.status = RoundStatus::Forfeited;
        er.draw_cost = c;
        assert_eq!(ser(&env.round(id)), ser(&er), "the round, field by field");

        // The event.
        let e = events::<RoundExpired>(&meta);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].version, 1);
        assert_eq!(addr(e[0].round), round_address(id));
        assert_eq!(e[0].requested, requested);
        // Always looked for: requested, recorded or proven (a round that can
        // no longer be looked for is refunded).
        assert!(e[0].checked);
        assert!(!e[0].refunded);
        assert_eq!(e[0].request_found, requested || found);
        assert_eq!(
            (e[0].tickets, e[0].forfeited, e[0].draw_cost, e[0].refund),
            (r0.tickets, r0.credits, c, refund)
        );
        assert_eq!((e[0].side, e[0].generation), (r0.side, r0.generation));
        assert_eq!(
            e[0].forfeits_withheld, ev.forfeits_withheld,
            "the count after it"
        );
        (
            Expiry {
                draw_cost: c,
                refund,
            },
            meta,
        )
    }

    /// Whether SlotHashes still proves the first slot after `close_slot`.
    fn entropy_retained(env: &Env, close_slot: u64) -> bool {
        let data = env
            .svm
            .get_account(&addr(fade::SLOT_HASHES_ID))
            .unwrap()
            .data;
        fade_math::slot_hashes::first_after_retained(&data, close_slot).is_some()
    }

    /// Expires round `id`, paid, never requested, its entropy never recorded
    /// and no longer proven by SlotHashes, naming any account as its request,
    /// and checks every effect of the refund §13.5.8 then makes: the vault's
    /// books as `refund_round` moves them (credits and shares out, ticket
    /// prices owed back, the settled price unchanged, the ring not observed),
    /// the round's tickets out of their counter with the recorded side and
    /// generation and no after-close result booked, `forfeits_withheld`
    /// counted and `rounds_forfeited` not, no token and no lamport moved,
    /// the round `Refunded` with `C = 0` and nothing else of it changed, the
    /// event.
    fn expire_refund_checked(env: &mut Env, id: u64, randomness: &Address) -> TransactionMetadata {
        let caller = funded(env);
        let r0 = env.round(id);
        assert_eq!(r0.status, RoundStatus::Paid);
        assert_eq!(r0.entropy_slot, 0, "never recorded");
        assert!(
            !entropy_retained(env, r0.close_slot),
            "SlotHashes no longer proves s*"
        );
        let v0 = env.vault();
        let slack0 = vault_slack(env);
        let usdc0 = env.balance(&env.a.vault_usdc);
        let mut addresses = watched(env, id, &caller.pubkey(), &[]);
        addresses.push(*randomness);
        let lamports0: Vec<u64> = addresses.iter().map(|a| env.lamports(a)).collect();
        let ix = env.expire_round_ix(&caller.pubkey(), id, randomness);
        let meta =
            send(env, &caller, ix).unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));

        let mut ev = v0.clone();
        let shares = r0.protocol_shares + r0.app_shares;
        assert_eq!(r0.credits + shares, r0.prices, "§13.4 fact 3, summed");
        ev.total_assets -= r0.credits;
        ev.open_vault_credits -= r0.credits;
        ev.total_reserved_liability -= r0.liability;
        ev.beacon_shares_held -= shares;
        ev.beacon_returns_owed += r0.prices;
        ev.forfeits_withheld += 1;
        match r0.side().unwrap() {
            Side::AfterClose if r0.generation == v0.generation => {
                ev.open_after_close -= r0.tickets;
            }
            Side::AfterClose => {
                assert_eq!(r0.generation + 1, v0.generation);
                ev.open_before_close -= r0.tickets;
            }
            Side::BeforeClose => {
                assert_eq!(r0.generation, v0.generation);
                ev.open_before_close -= r0.tickets;
            }
        }
        let v = env.vault();
        assert_eq!(ser(&v), ser(&ev), "the vault's books, field by field");
        assert_eq!(v.rounds_forfeited, v0.rounds_forfeited, "not a forfeiture");
        assert_eq!(
            v.settled_price(),
            v0.settled_price(),
            "a refund is no result"
        );
        assert_eq!(vault_slack(env), slack0, "the vault identity, to the unit");
        assert_eq!(env.balance(&env.a.vault_usdc), usdc0, "no token moves");
        for (i, a) in addresses.iter().enumerate() {
            assert_eq!(env.lamports(a), lamports0[i], "no lamport moves: {a}");
        }

        let mut er = r0.clone();
        er.status = RoundStatus::Refunded;
        er.draw_cost = 0;
        assert_eq!(ser(&env.round(id)), ser(&er), "the round, field by field");

        let e = events::<RoundExpired>(&meta);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].version, 1);
        assert_eq!(addr(e[0].round), round_address(id));
        assert_eq!(
            (
                e[0].requested,
                e[0].request_found,
                e[0].checked,
                e[0].refunded
            ),
            (false, false, false, true)
        );
        assert_eq!(
            (e[0].tickets, e[0].forfeited, e[0].draw_cost, e[0].refund),
            (r0.tickets, 0, 0, 0)
        );
        assert_eq!((e[0].side, e[0].generation), (r0.side, r0.generation));
        assert_eq!(e[0].forfeits_withheld, ev.forfeits_withheld);
        assert!(events::<RoundRefunded>(&meta).is_empty());
        meta
    }

    /// Returns `ticket`, sent by a fresh caller, and checks every effect of
    /// §13.5.9 against values computed here: the ticket price to `refund_to`
    /// (or parked when `parked`), each lamport (the prepay less the charge of
    /// §13.4 and the ticket's lamports to the payer, the settlement share to
    /// the caller after a forfeiture only, the round's close to its rent
    /// payer), the vault's, the integrator's and the round's books field by
    /// field, the ticket parked or closed, the events, the vault identity
    /// and the conservation of lamports. Returns the transaction.
    fn return_checked(env: &mut Env, ticket: &Address, parked: bool) -> TransactionMetadata {
        let caller = funded(env);
        return_checked_by(env, &caller, ticket, parked)
    }

    fn return_checked_by(
        env: &mut Env,
        caller: &Keypair,
        ticket: &Address,
        parked: bool,
    ) -> TransactionMetadata {
        let t0 = env.round_ticket(ticket);
        let id = t0.round;
        let r0 = env.round(id);
        let v0 = env.vault();
        let integrator = addr(t0.integrator);
        let i0: Integrator = env.read(&integrator);
        let refunded = match r0.status {
            RoundStatus::Refunded => true,
            RoundStatus::Forfeited => false,
            s => panic!("not an end: {s:?}"),
        };
        assert!(!parked || refunded, "only a refund parks");
        let charge = if refunded {
            0
        } else {
            let to_prices = u128::from(r0.draw_cost.saturating_sub(r0.sponsorship));
            u64::try_from((to_prices * u128::from(t0.price)).div_ceil(u128::from(r0.prices)))
                .unwrap()
        };
        assert!(
            charge <= t0.prepay,
            "no ticket charged above its prepay (fact 1)"
        );
        let back = t0.prepay - charge;
        let rent_payer = addr(r0.rent_payer);
        let payer = addr(t0.payer);
        let refund_to = addr(t0.refund_to);
        let mut lamports_watch = vec![
            round_address(id),
            round_vrf_address(id),
            caller.pubkey(),
            rent_payer,
            *ticket,
            payer,
        ];
        lamports_watch.dedup();
        let mut uniq = Vec::new();
        for a in lamports_watch {
            if !uniq.contains(&a) {
                uniq.push(a);
            }
        }
        let lamports0: BTreeMap<Address, u64> =
            uniq.iter().map(|a| (*a, env.lamports(a))).collect();
        let refund_to0 = if env.exists(&refund_to) && !parked {
            env.balance(&refund_to)
        } else {
            0
        };
        let escrow0 = env.balance(&env.a.payout_escrow);
        let usdc0 = env.balance(&env.a.vault_usdc);
        let slack0 = vault_slack(env);
        let price0 = v0.settled_price();

        let ix = env.return_round_ticket_ix(&caller.pubkey(), ticket, Some(rent_payer));
        let meta =
            send(env, caller, ix).unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));

        // Tokens.
        if refunded {
            assert_eq!(env.balance(&env.a.vault_usdc), usdc0 - t0.price);
            if parked {
                assert_eq!(env.balance(&env.a.payout_escrow), escrow0 + t0.price);
            } else {
                assert_eq!(
                    env.balance(&refund_to),
                    refund_to0 + t0.price,
                    "the price back"
                );
                assert_eq!(env.balance(&env.a.payout_escrow), escrow0);
            }
        } else {
            assert_eq!(env.balance(&env.a.vault_usdc), usdc0, "no token moves");
            assert_eq!(env.balance(&env.a.payout_escrow), escrow0);
        }
        assert_eq!(vault_slack(env), slack0, "the vault identity, to the unit");

        // Lamports.
        let ticket_l = lamports0[ticket];
        let mut expected = lamports0.clone();
        let to_payer = if parked {
            *expected.get_mut(ticket).unwrap() += back;
            0
        } else if refunded {
            *expected.get_mut(ticket).unwrap() = 0;
            back + ticket_l
        } else {
            *expected.get_mut(ticket).unwrap() = 0;
            *expected.get_mut(&caller.pubkey()).unwrap() += t0.settle_share;
            back + ticket_l - t0.settle_share
        };
        *expected.get_mut(&payer).unwrap() += to_payer;
        let round_after = lamports0[&round_address(id)] - back;
        let closed = !env.exists(&round_address(id));
        if closed {
            *expected.get_mut(&round_address(id)).unwrap() = 0;
            *expected.get_mut(&rent_payer).unwrap() += round_after;
        } else {
            *expected.get_mut(&round_address(id)).unwrap() = round_after;
            assert!(
                round_after >= rent(env, ROUND_LEN),
                "the round keeps its rent"
            );
        }
        for (a, l) in &expected {
            assert_eq!(env.lamports(a), *l, "lamports of {a}");
        }
        let sum0: u64 = lamports0.values().sum();
        let sum1: u64 = lamports0.keys().map(|a| env.lamports(a)).sum();
        assert_eq!(sum0, sum1, "no lamport created or lost");

        // The ticket.
        if parked {
            let mut et = t0.clone();
            et.status = RoundTicketStatus::ReturnParked;
            et.payout = t0.price;
            assert_eq!(ser(&env.round_ticket(ticket)), ser(&et), "parked");
        } else {
            assert!(!env.exists(ticket), "the ticket is closed");
        }

        // The vault's books.
        let mut ev = v0.clone();
        if refunded {
            ev.beacon_returns_owed -= t0.price;
        } else {
            ev.beacon_shares_held -= t0.app_share;
            ev.app_shares_owed += t0.app_share;
            ev.volume_total += t0.price;
        }
        let v = env.vault();
        assert_eq!(ser(&v), ser(&ev), "the vault's books, field by field");
        assert_eq!(v.settled_price(), price0, "a return is no result");

        // The integrator's books.
        let mut ei = i0.clone();
        ei.reserved_liability -= t0.liability;
        ei.open_tickets -= 1;
        if !refunded {
            ei.volume_total += t0.price;
            ei.app_shares_accrued += t0.app_share;
        }
        assert_eq!(
            ser(&env.read::<Integrator>(&integrator)),
            ser(&ei),
            "the integrator's books"
        );

        // The round's books: those of its tickets still in it.
        if !closed {
            let mut er = r0.clone();
            er.tickets -= 1;
            er.prepaid -= t0.prepay;
            er.liability -= t0.liability;
            er.credits -= t0.vault_credit;
            er.protocol_shares -= t0.protocol_share;
            er.app_shares -= t0.app_share;
            assert_eq!(
                ser(&env.round(id)),
                ser(&er),
                "the round's books, field by field"
            );
        } else {
            assert_eq!((r0.tickets, r0.sponsors), (1, 0));
        }

        // The events.
        let e = events::<RoundTicketReturned>(&meta);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].version, 1);
        assert_eq!(addr(e[0].ticket), *ticket);
        assert_eq!(addr(e[0].round), round_address(id));
        assert_eq!(
            (
                e[0].refunded,
                e[0].price,
                e[0].lamports,
                e[0].parked,
                e[0].charge
            ),
            (refunded, t0.price, to_payer, parked, charge)
        );
        let closes = events::<RoundClosed>(&meta);
        if closed {
            assert_eq!(closes.len(), 1);
            assert_eq!(addr(closes[0].rent_payer), rent_payer);
            assert_eq!(closes[0].lamports, round_after);
        } else {
            assert!(closes.is_empty());
        }
        meta
    }

    /// Every sponsor of round `id` reclaims, each getting exactly §13.4's
    /// return; the round's close, if one of them closes it, to its rent payer.
    fn reclaim_checked(env: &mut Env, id: u64, sponsors: &[Address]) -> u64 {
        let mut total = 0;
        for s in sponsors {
            let r = env.round(id);
            let record = sponsorship_address(&round_address(id), s);
            let amount: fade::state::Sponsorship = env.read(&record);
            let drawn = r.status != RoundStatus::Refunded;
            let expected = if drawn {
                let left = u128::from(r.sponsorship - r.sponsorship.min(r.draw_cost));
                u64::try_from(left * u128::from(amount.amount) / u128::from(r.sponsorship)).unwrap()
            } else {
                amount.amount
            };
            let meta = env.reclaim(id, s).unwrap();
            let e = events::<SponsorshipReclaimed>(&meta);
            assert_eq!(e[0].lamports, expected, "the sponsor's return of §13.4");
            total += expected;
        }
        total
    }

    // --- refund_round ---------------------------------------------------------------------

    /// The refund: an unpaid round of three tickets from
    /// two integrators and two payers, partly sponsored by a third party, is
    /// refused one slot before its window and refunded at its first slot,
    /// O(1) (`refund_checked`); then every ticket is returned one by one
    /// (`return_checked`): each funder gets its ticket price back, each payer
    /// its prepay, settlement share and rent; the sponsor its whole amount;
    /// and the round closes to its rent payer with exactly its rent. Every
    /// payer and the funder end where they began, to the lamport and to the
    /// unit (invariant 5), the fees being the keeper's.
    #[test]
    fn a_refunded_round_is_returned_ticket_by_ticket() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 2);
        let funder0 = env.balance(&cast.funder.usdc);
        let payers0: Vec<u64> = cast
            .payers
            .iter()
            .map(|p| env.lamports(&p.pubkey()))
            .collect();
        let (id, tickets) = unpaid(&mut env, &cast, 3);
        let sponsor = funded(&mut env);
        let sponsor0 = env.lamports(&sponsor.pubkey());
        let fee = env.sponsor(&sponsor, id, 400_000).unwrap().fee;
        assert_eq!(env.round(id).status, RoundStatus::Accepting, "still unpaid");
        let rent_payer = addr(env.round(id).rent_payer);
        assert_eq!(
            rent_payer,
            cast.payers[0].pubkey(),
            "the first join's payer"
        );

        // One slot early: refused, nothing moved.
        let r = env.round(id);
        at_slot(&mut env, r.first_slot + r.refund_slots - 1);
        let (caller, proof) = participant(&env, &cast, id);
        let ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
        refused(&mut env, &caller, ix, id, &tickets, FadeError::RefundWindow);

        to_refund_window(&mut env, id);
        refund_checked(&mut env, id, &cast);
        assert_eq!(
            env.vault().accepting_round,
            0,
            "the round takes no more joins"
        );

        // The returns, a reclaim between two of them.
        return_checked(&mut env, &tickets[1], false);
        assert_eq!(reclaim_checked(&mut env, id, &[sponsor.pubkey()]), 400_000);
        return_checked(&mut env, &tickets[0], false);
        let r = env.round(id);
        assert_eq!(r.prepaid, env.round_ticket(&tickets[2]).prepay);
        return_checked(&mut env, &tickets[2], false);
        assert!(
            !env.exists(&round_address(id)),
            "closed with its last ticket"
        );

        // Exact returns. Each payer also created one integrator's record
        // (tickets 0 and 1), which is never closed: that rent is not the
        // ticket's.
        assert_eq!(
            env.balance(&cast.funder.usdc),
            funder0,
            "every ticket price back"
        );
        let record_rent = rent(&env, 8 + Integrator::INIT_SPACE);
        for (p, l0) in cast.payers.iter().zip(&payers0) {
            assert_eq!(
                env.lamports(&p.pubkey()),
                *l0 - record_rent,
                "every lamport back to its payer"
            );
        }
        assert_eq!(
            env.lamports(&sponsor.pubkey()),
            sponsor0 - fee,
            "the whole sponsorship back, and the record's rent"
        );
        let v = env.vault();
        assert_eq!(
            (
                v.beacon_returns_owed,
                v.beacon_shares_held,
                v.total_reserved_liability,
                v.open_vault_credits
            ),
            (0, 0, 0, 0)
        );
        for (k, _) in cast.integrators.iter().enumerate() {
            let i = env.integrator(&cast.integrators[k].pubkey());
            assert_eq!(
                (
                    i.reserved_liability,
                    i.open_tickets,
                    i.volume_total,
                    i.app_shares_accrued
                ),
                (0, 0, 0, 0)
            );
        }
    }

    /// The window is the round's snapshot, counted from its latest join
    /// (Spec 09 §6 as built): a round still
    /// gathering tickets is never refundable, however old its first ticket,
    /// so nobody can empty a slow round at `first_slot + refund_slots` while
    /// tickets keep coming. A refund at exactly `last_join_slot +
    /// refund_slots`, after the parameter was shortened for later rounds,
    /// uses the round's own `refund_slots`.
    #[test]
    fn the_refund_window_counts_from_the_latest_join() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        let (id, mut tickets) = unpaid(&mut env, &cast, 1);
        let mut p = env.config().params;
        p.refund_slots = p.tick_slots;
        env.set_params(p).unwrap();
        env.apply_params().ok();
        let r = env.round(id);
        assert_eq!(r.last_join_slot, r.first_slot, "the first join's slot");
        let (caller, proof) = participant(&env, &cast, id);
        // A join one slot before the first ticket's window opens moves it.
        at_slot(&mut env, r.first_slot + r.refund_slots - 1);
        let (same, more) = unpaid(&mut env, &cast, 1);
        assert_eq!(same, id);
        tickets.extend(more);
        let joined = env.round(id).last_join_slot;
        assert_eq!(joined, r.first_slot + r.refund_slots - 1);
        assert_eq!(env.round(id).first_slot, r.first_slot);
        // From where the window used to open, and up to one slot before the
        // latest join's: refused, nothing moved.
        for at in [r.first_slot + r.refund_slots, joined + r.refund_slots - 1] {
            at_slot(&mut env, at);
            let ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
            refused(&mut env, &caller, ix, id, &tickets, FadeError::RefundWindow);
        }
        at_slot(&mut env, joined + r.refund_slots);
        refund_checked(&mut env, id, &cast);
    }

    /// A round written before `last_join_slot` existed reads it as 0: its
    /// window counts from `first_slot`, never from slot 0.
    #[test]
    fn a_round_without_a_latest_join_counts_from_its_first() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        let (id, tickets) = unpaid(&mut env, &cast, 2);
        env.set_round(id, None, |r| r.last_join_slot = 0);
        let r = env.round(id);
        assert_eq!(r.refund_from(), r.first_slot);
        let (caller, proof) = participant(&env, &cast, id);
        at_slot(&mut env, r.first_slot + r.refund_slots - 1);
        let ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
        refused(&mut env, &caller, ix, id, &tickets, FadeError::RefundWindow);
        at_slot(&mut env, r.first_slot + r.refund_slots);
        refund_checked(&mut env, id, &cast);
    }

    /// Only a participant refunds (against Spec 09
    /// §6's \"anyone\"): a stranger is refused with
    /// `NotRoundParticipant` whatever it shows, a ticket or a sponsorship of
    /// the round included; so is a participant showing a record that is not
    /// its own, or a ticket of another round. A sponsor is no participant,
    /// even showing its own record (a one-lamport record would make anyone
    /// one). A ticket's payer, funder or integrator pass the check (each then
    /// stopped by the books check that follows it, here made to fail); the
    /// payer refunds.
    #[test]
    fn only_a_participant_refunds() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        let (b, tb) = fill(&mut env, &cast, 2);
        let close = env.round(b).close_slot;
        at_slot(&mut env, close + 1);
        let (id, tickets) = unpaid(&mut env, &cast, 2);
        assert_ne!(b, id);
        let sponsor = funded(&mut env);
        env.sponsor(&sponsor, id, 1_000).unwrap();
        let record = sponsorship_address(&round_address(id), &sponsor.pubkey());
        to_refund_window(&mut env, id);

        let stranger = funded(&mut env);
        let nothing = Address::new_unique();
        for shown in [
            tickets[0],
            tickets[1],
            record,
            nothing,
            env.a.vault,
            round_address(id),
        ] {
            let ix = env.refund_round_ix(&stranger.pubkey(), id, &shown);
            refused(
                &mut env,
                &stranger,
                ix,
                id,
                &tickets,
                FadeError::NotRoundParticipant,
            );
        }
        let funder = cast.funder.kp.insecure_clone();
        for (who, shown) in [
            (&sponsor, tickets[0]), // a ticket it has no part in
            (&sponsor, record),     // its own sponsorship of the round
            (&funder, record),      // someone else's sponsorship
            (&funder, tb[0]),       // its own ticket, of another round
        ] {
            let ix = env.refund_round_ix(&who.pubkey(), id, &shown);
            refused(
                &mut env,
                who,
                ix,
                id,
                &tickets,
                FadeError::NotRoundParticipant,
            );
        }

        env.set_round(id, None, |r| r.credits -= 1);
        let payer = cast.payers[0].insecure_clone();
        let integrator = cast.integrators[0].insecure_clone();
        for (who, shown) in [
            (&payer, tickets[0]),
            (&funder, tickets[1]),
            (&integrator, tickets[0]),
        ] {
            let ix = env.refund_round_ix(&who.pubkey(), id, &shown);
            refused(&mut env, who, ix, id, &tickets, FadeError::MathOverflow);
        }
        env.set_round(id, None, |r| r.credits += 1);
        let ix = env.refund_round_ix(&payer.pubkey(), id, &tickets[0]);
        send(&mut env, &payer, ix).unwrap();
        assert_eq!(env.round(id).status, RoundStatus::Refunded);
    }

    /// The second final audit, item 1: a
    /// round whose draw no longer fits its prefund, ORAO's fee having more
    /// than doubled since its creation, refuses every join and every
    /// sponsorship (`DrawUnderfunded`), so nobody can become a participant
    /// any more; its own participants never refunding it would refuse the
    /// beacon's every join for good. Anyone may refund it once its window is
    /// open, and not before; a round whose draw fits again is a participant's
    /// to refund, as before. The next join then opens a round at the live
    /// fee. A network state at any other address is refused.
    #[test]
    fn anyone_refunds_a_round_whose_draw_no_longer_fits() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        let (id, tickets) = unpaid(&mut env, &cast, 1);
        let stranger = funded(&mut env);
        let player = env.user(60 * USDC);

        // ORAO's fee rises by more than the round's one fee of margin.
        env.set_orao_fee(2 * ORAO_FEE + 1);
        let err = env
            .join(&player, &coin_flip(), USDC, 0, 0)
            .expect_err("the round can no longer be drawn");
        assert!(err.has_code(fade_error(FadeError::DrawUnderfunded)));

        // Before the window, the stranger is refused as anyone would be.
        let ix = env.refund_round_ix(&stranger.pubkey(), id, &round_address(id));
        refused(
            &mut env,
            &stranger,
            ix,
            id,
            &tickets,
            FadeError::RefundWindow,
        );
        to_refund_window(&mut env, id);
        // The network state must be ORAO's, at its derived address.
        let mut ix = env.refund_round_ix(&stranger.pubkey(), id, &round_address(id));
        for m in ix.accounts.iter_mut() {
            if m.pubkey == env.a.network_state {
                m.pubkey = Address::new_unique();
            }
        }
        refused_anchor(&mut env, &stranger, ix, id, &tickets, 2006);
        // A draw that fits again is the participants' to end, as before.
        env.set_orao_fee(2 * ORAO_FEE);
        let ix = env.refund_round_ix(&stranger.pubkey(), id, &round_address(id));
        refused(
            &mut env,
            &stranger,
            ix,
            id,
            &tickets,
            FadeError::NotRoundParticipant,
        );

        // Doomed again: the stranger, showing nothing, refunds it.
        env.set_orao_fee(2 * ORAO_FEE + 1);
        let ix = env.refund_round_ix(&stranger.pubkey(), id, &round_address(id));
        let meta = send(&mut env, &stranger, ix).unwrap();
        eprintln!(
            "CU refund_round (a doomed round, by anyone): {}",
            meta.compute_units_consumed
        );
        assert_eq!(env.round(id).status, RoundStatus::Refunded);
        assert_eq!(env.vault().accepting_round, 0);
        let ev = &events::<RoundRefunded>(&meta)[0];
        assert_eq!(addr(ev.by), stranger.pubkey());

        // The beacon takes joins again, in a round snapshotting the live fee,
        // and the refunded ticket gets its price back.
        let (_, meta) = env.join(&player, &coin_flip(), USDC, 0, 0).unwrap();
        let opened = &events::<RoundOpened>(&meta)[0];
        assert_eq!(opened.id, id + 1);
        assert!(fade_math::beacon::request_fits(
            2 * ORAO_FEE + 1,
            env.svm
                .minimum_balance_for_rent_exemption(fade_math::orao_layout::PENDING_LEN),
            opened.request_share,
            opened.draw_max,
        ));
        env.return_round_ticket(&tickets[0]).unwrap();
        assert!(!env.exists(&tickets[0]), "returned and closed");
    }

    /// The final audit's griefing: an
    /// outsider with no ticket sponsors an idle unpaid round with one
    /// lamport and, in the same transaction, refunds it showing the record
    /// it just made, to reclaim the lamport and the rent afterwards. Refused
    /// `NotRoundParticipant` as a whole: the sponsorship is rolled back with
    /// it, and the round stays `Accepting`. A sponsorship does not move the
    /// window either (`last_join_slot`), and the sponsor alone, sending
    /// only its sponsorship, is still taken.
    #[test]
    fn a_sponsorship_does_not_make_a_participant() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        let (id, tickets) = unpaid(&mut env, &cast, 2);
        to_refund_window(&mut env, id);
        let last_join = env.round(id).last_join_slot;

        let outsider = funded(&mut env);
        let round = round_address(id);
        let record = sponsorship_address(&round, &outsider.pubkey());
        let sponsor = env.sponsor_round_ix(&outsider.pubkey(), &record, &round, 1);
        let refund = env.refund_round_ix(&outsider.pubkey(), id, &record);
        let mut addresses = watched(&env, id, &outsider.pubkey(), &tickets);
        addresses.push(record);
        let before = snapshot(&env, &addresses);
        let keeper = env.keeper.insecure_clone();
        let err = env
            .send(&[sponsor, refund], &[&keeper, &outsider])
            .expect_err("a sponsorship is no participation");
        assert!(
            err.has_code(fade_error(FadeError::NotRoundParticipant)),
            "{}\n{}",
            err.err,
            err.logs.join("\n")
        );
        assert_eq!(
            snapshot(&env, &addresses),
            before,
            "a refusal moves nothing"
        );
        assert!(!env.exists(&record));
        assert_eq!(env.round(id).status, RoundStatus::Accepting);

        // Sponsoring alone is taken, and leaves the refund window where it was.
        env.sponsor(&outsider, id, 1).unwrap();
        let r = env.round(id);
        assert_eq!(r.sponsorship, 1);
        assert_eq!(r.last_join_slot, last_join, "a sponsorship is no join");
        let ix = env.refund_round_ix(&outsider.pubkey(), id, &record);
        refused(
            &mut env,
            &outsider,
            ix,
            id,
            &tickets,
            FadeError::NotRoundParticipant,
        );
        // A participant still refunds, and the sponsor gets its lamport back.
        let (caller, proof) = participant(&env, &cast, id);
        let ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
        send(&mut env, &caller, ix).unwrap();
        assert_eq!(env.round(id).status, RoundStatus::Refunded);
    }

    /// Only an unpaid round is refunded: a paid one, closed or not,
    /// requested or drawn, is `RoundPaid`; one refunded or forfeited already
    /// `WrongRoundStatus`; so is an `Accepting` round claiming to be counted
    /// in the epoch counters, and books whose credits and shares do not sum
    /// to the prices fail closed. Each check paired with a later one that
    /// would also fail; every refusal moves nothing.
    #[test]
    fn refund_checks_in_order() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        let (id, tickets) = unpaid(&mut env, &cast, 2);
        let (caller, proof) = participant(&env, &cast, id);

        // Remaining accounts first (the window is not open either).
        let mut ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
        ix.accounts
            .push(AccountMeta::new_readonly(Address::new_unique(), false));
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::RemainingAccounts,
        );

        // The status before the window.
        for (status, e) in [
            (RoundStatus::Paid, FadeError::RoundPaid),
            (RoundStatus::Requested, FadeError::RoundPaid),
            (RoundStatus::Drawn, FadeError::RoundPaid),
            (RoundStatus::Refunded, FadeError::WrongRoundStatus),
            (RoundStatus::Forfeited, FadeError::WrongRoundStatus),
        ] {
            env.set_round(id, None, |r| r.status = status);
            let ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
            refused(&mut env, &caller, ix, id, &tickets, e);
        }
        env.set_round(id, None, |r| r.status = RoundStatus::Accepting);

        // Counted, before the window.
        env.set_round(id, None, |r| r.counted = true);
        let ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::WrongRoundStatus,
        );
        env.set_round(id, None, |r| r.counted = false);

        // The window before the books.
        env.set_round(id, None, |r| r.credits -= 1);
        let ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
        refused(&mut env, &caller, ix, id, &tickets, FadeError::RefundWindow);
        env.set_round(id, None, |r| r.credits += 1);
        to_refund_window(&mut env, id);

        // The participant before the books.
        let stranger = funded(&mut env);
        env.set_round(id, None, |r| r.credits -= 1);
        let ix = env.refund_round_ix(&stranger.pubkey(), id, &proof);
        refused(
            &mut env,
            &stranger,
            ix,
            id,
            &tickets,
            FadeError::NotRoundParticipant,
        );
        env.set_round(id, None, |r| r.credits += 1);
        for f in [
            (|r: &mut Round| r.credits -= 1) as fn(&mut Round),
            |r: &mut Round| r.app_shares += 1,
            |r: &mut Round| r.protocol_shares -= 1,
            |r: &mut Round| r.prices += 1,
        ] {
            let r0 = env.round(id);
            env.set_round(id, None, f);
            let ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
            refused(&mut env, &caller, ix, id, &tickets, FadeError::MathOverflow);
            env.set_round(id, None, |r| *r = r0);
        }
        refund_checked(&mut env, id, &cast);
        // And a second time.
        let ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::WrongRoundStatus,
        );
    }

    /// A paid round is never refunded, whatever its age; it forfeits if
    /// nobody draws it. A round becomes unrefundable the instant it is paid.
    #[test]
    fn a_paid_round_is_never_refunded() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, tickets) = fill(&mut env, &cast, 2);
        let (caller, proof) = participant(&env, &cast, id);
        let r = env.round(id);
        at_slot(&mut env, r.first_slot + r.refund_slots + 10_000);
        let ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
        refused(&mut env, &caller, ix, id, &tickets, FadeError::RoundPaid);
    }

    /// Never paused (Spec 08 §13.7): under `PAUSE_ALL` and the integrator's
    /// own pause, an unpaid round is refunded, its tickets returned, its
    /// sponsor reclaims.
    #[test]
    fn the_ends_of_a_round_are_never_paused() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        // Every join before the pause: a paid round `b`, closed, then an
        // unpaid, sponsored round `id`.
        let (b, tb) = fill(&mut env, &cast, 2);
        let close = env.round(b).close_slot;
        at_slot(&mut env, close + 1);
        let (id, tickets) = unpaid(&mut env, &cast, 2);
        assert_ne!(b, id);
        let sponsor = funded(&mut env);
        env.sponsor(&sponsor, id, 300_000).unwrap();
        assert_eq!(env.round(id).status, RoundStatus::Accepting);
        let guardian = env.guardian.insecure_clone();
        let paused = env.integrator_address(&cast.integrators[0].pubkey());
        env.set_pause_flags(&guardian, Config::PAUSE_ALL, Some((paused, true)))
            .unwrap();
        assert!(env.read::<Integrator>(&paused).paused);
        assert_eq!(env.config().pause_flags, Config::PAUSE_ALL);
        // Everything below runs paused, the record of `b`'s entropy first, so
        // that its expiry, long after SlotHashes forgets `s*`, still looks for
        // its request and forfeits it.
        at_slot(&mut env, close + 2);
        env.record_round_entropy(b)
            .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        to_refund_window(&mut env, id);
        assert_eq!(env.config().pause_flags, Config::PAUSE_ALL);
        refund_checked(&mut env, id, &cast);
        for t in &tickets {
            return_checked(&mut env, t, false);
        }
        reclaim_checked(&mut env, id, &[sponsor.pubkey()]);
        assert!(!env.exists(&round_address(id)));
        let rb = env.round(b);
        if !fade_math::beacon::is_expired(env.slot(), rb.close_slot, rb.t_settle_slots) {
            to_expiry(&mut env, b);
        }
        expire_checked(&mut env, b);
        for t in &tb {
            return_checked(&mut env, t, false);
        }
        assert_eq!(env.config().pause_flags, Config::PAUSE_ALL);
        assert!(env.read::<Integrator>(&paused).paused);
    }

    /// A refunded round takes nothing more: a join lands in a new round, with
    /// the next id; its sponsorship is refused.
    #[test]
    fn a_refunded_round_takes_nothing_more() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        let (id, _tickets) = unpaid(&mut env, &cast, 2);
        to_refund_window(&mut env, id);
        refund_checked(&mut env, id, &cast);
        let r0 = ser(&env.round(id));
        let sponsor = funded(&mut env);
        assert_fails_with(env.sponsor(&sponsor, id, 1), FadeError::RoundNotAccepting);
        let next = env.vault().next_round_id;
        let (b, _) = unpaid(&mut env, &cast, 1);
        assert_eq!(b, next);
        assert_eq!(env.vault().accepting_round, b);
        assert_eq!(ser(&env.round(id)), r0, "the refunded round untouched");
    }

    /// The refund's own accounts: a forged copy of the round or the vault at
    /// another address is refused by its seeds (2006).
    #[test]
    fn refund_accounts_are_checked() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        let (id, tickets) = unpaid(&mut env, &cast, 2);
        to_refund_window(&mut env, id);
        let (caller, proof) = participant(&env, &cast, id);
        for (i, from) in [(2usize, round_address(id)), (1, env.a.vault)] {
            let forged = Address::new_unique();
            let a = env.svm.get_account(&from).unwrap();
            env.svm.set_account(forged, a).unwrap();
            let mut ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
            assert_eq!(ix.accounts[i].pubkey, from);
            ix.accounts[i].pubkey = forged;
            refused_anchor(&mut env, &caller, ix, id, &tickets, 2006);
        }
        // Not signed by the caller.
        let mut ix = env.refund_round_ix(&caller.pubkey(), id, &proof);
        ix.accounts[0].is_signer = false;
        let keeper = env.keeper.insecure_clone();
        assert!(env.send(&[ix], &[&keeper]).unwrap_err().has_code(3010));
        refund_checked(&mut env, id, &cast);
    }

    // --- return_round_ticket after a refund --------------------------------------------

    /// A `refund_to` that cannot receive (frozen, closed, of another mint)
    /// has its ticket price parked in `payout_escrow`: the ticket keeps every
    /// lamport its payer is owed until `claim_round_payout` delivers the
    /// price to `refund_to` once it can receive and closes the ticket to the
    /// payer. The claim goes nowhere else.
    #[test]
    fn a_return_is_parked_when_refund_to_cannot_receive() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let k = &cast.integrators[0];
        let mut tickets = Vec::new();
        let mut funders = Vec::new();
        for i in 0..3 {
            let f = env.user(10 * USDC);
            let b = env.usdc_account(&Address::new_unique(), 0);
            tickets.push(join_as(
                &mut env,
                k,
                cast.shares[0],
                &cast.payers[i % 2],
                &f,
                b,
                &coin_flip(),
                700_000,
                0,
            ));
            funders.push(f);
        }
        let id = env.round_ticket(&tickets[0]).round;
        to_refund_window(&mut env, id);
        refund_checked(&mut env, id, &cast);

        // Frozen.
        env.set_token_state(&funders[0].usdc, 2);
        let payer = addr(env.round_ticket(&tickets[0]).payer);
        let payer_l0 = env.lamports(&payer);
        return_checked(&mut env, &tickets[0], true);
        assert_eq!(
            env.lamports(&payer),
            payer_l0,
            "the payer waits with the ticket"
        );
        assert_fails_with(
            env.return_round_ticket(&tickets[0]),
            FadeError::WrongTicketStatus,
        );
        assert!(env.claim_round_payout(&tickets[0]).is_err(), "still frozen");
        // To another destination.
        let caller = funded(&mut env);
        let other = env.usdc_account(&Address::new_unique(), 0);
        let ix = env.claim_round_payout_ix(&caller.pubkey(), &tickets[0], &other);
        let keeper = env.keeper.insecure_clone();
        assert_fails_with(
            env.send(&[ix], &[&keeper, &caller]),
            FadeError::BeneficiaryMismatch,
        );
        env.set_token_state(&funders[0].usdc, 1);
        let ticket_l = env.lamports(&tickets[0]);
        let f0 = env.balance(&funders[0].usdc);
        env.claim_round_payout(&tickets[0]).unwrap();
        assert_eq!(
            env.balance(&funders[0].usdc),
            f0 + 700_000,
            "delivered to refund_to"
        );
        assert_eq!(
            env.lamports(&payer),
            payer_l0 + ticket_l,
            "every lamport to the payer"
        );
        assert!(!env.exists(&tickets[0]));
        assert_eq!(
            env.balance(&funders[0].usdc),
            10 * USDC,
            "the funder made whole"
        );

        // Closed.
        env.svm
            .set_account(funders[1].usdc, Account::default())
            .unwrap();
        return_checked(&mut env, &tickets[1], true);
        // Another mint.
        set_account(&mut env, &funders[2].usdc, |a| {
            a.data[..32].copy_from_slice(Address::new_unique().as_ref())
        });
        return_checked(&mut env, &tickets[2], true);
        // The round closed with its last return though two tickets are parked.
        assert!(!env.exists(&round_address(id)));
        let escrow = env.balance(&env.a.payout_escrow);
        assert_eq!(escrow, 2 * 700_000);
        assert_eq!(vault_slack(&env), 0);
    }

    /// The return's checks, in order, each paired with a later one that would
    /// also fail: remaining accounts, the ticket's status, the round's
    /// status; and every account pinned: the round by the ticket's id and its
    /// seeds, the integrator, the payer and `refund_to` by the stored keys,
    /// the ticket, the config, the vault, the escrow, `vault_usdc` and the
    /// vault authority by their seeds, the mint by the config. Each refusal
    /// moves nothing.
    #[test]
    fn return_checks_in_order() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 2);
        let (id, tickets) = unpaid(&mut env, &cast, 3);
        let caller = funded(&mut env);
        let t = tickets[0];
        let rp = Some(addr(env.round(id).rent_payer));

        // Remaining accounts before the round's status (Accepting).
        let mut ix = env.return_round_ticket_ix(&caller.pubkey(), &t, rp);
        ix.accounts
            .push(AccountMeta::new_readonly(Address::new_unique(), false));
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::RemainingAccounts,
        );
        // Every status a ticket can be returned from is refused.
        for status in [
            RoundStatus::Accepting,
            RoundStatus::Paid,
            RoundStatus::Requested,
            RoundStatus::Drawn,
        ] {
            env.set_round(id, None, |r| r.status = status);
            let ix = env.return_round_ticket_ix(&caller.pubkey(), &t, rp);
            refused(
                &mut env,
                &caller,
                ix,
                id,
                &tickets,
                FadeError::WrongRoundStatus,
            );
        }
        env.set_round(id, None, |r| r.status = RoundStatus::Accepting);
        // The ticket's status before the round's.
        for status in [
            RoundTicketStatus::PayoutParked,
            RoundTicketStatus::ReturnParked,
        ] {
            env.set_round_ticket(&t, |w| w.status = status);
            let ix = env.return_round_ticket_ix(&caller.pubkey(), &t, rp);
            refused(
                &mut env,
                &caller,
                ix,
                id,
                &tickets,
                FadeError::WrongTicketStatus,
            );
        }
        env.set_round_ticket(&t, |w| w.status = RoundTicketStatus::Joined);

        to_refund_window(&mut env, id);
        refund_checked(&mut env, id, &cast);

        // No rent payer: this return does not close the round, and the
        // round's rent payer is this ticket's payer, which would otherwise
        // be named writable twice.
        let base = env.return_round_ticket_ix(&caller.pubkey(), &t, None);
        // Field positions in `ReturnRoundTicket`.
        const CONFIG: usize = 1;
        const VAULT: usize = 2;
        const ROUND: usize = 3;
        const INTEGRATOR: usize = 4;
        const TICKET: usize = 5;
        const PAYER: usize = 6;
        const REFUND_TO: usize = 7;
        const ESCROW: usize = 8;
        const VAULT_USDC: usize = 9;
        const AUTHORITY: usize = 10;
        const MINT: usize = 11;
        let other_ticket = env.round_ticket(&tickets[1]);
        let attacker = env.usdc_account(&caller.pubkey(), 0);
        let forged = |env: &mut Env, from: &Address| {
            let f = Address::new_unique();
            let a = env.svm.get_account(from).unwrap();
            env.svm.set_account(f, a).unwrap();
            f
        };
        let forged_round = forged(&mut env, &round_address(id));
        let forged_ticket = forged(&mut env, &t);
        let (config, vault) = (env.a.config, env.a.vault);
        let forged_config = forged(&mut env, &config);
        let forged_vault = forged(&mut env, &vault);
        let other_mint = Address::new_unique();
        fade_testkit::token::write_mint(&mut env.svm, other_mint, &Address::new_unique(), 6);
        let cases: Vec<(usize, Address, u32)> = vec![
            (CONFIG, forged_config, 2006),
            (VAULT, forged_vault, 2006),
            (ROUND, forged_round, 2006),
            (ROUND, round_address(id + 1), 3012),
            (INTEGRATOR, addr(other_ticket.integrator), 2012),
            (TICKET, forged_ticket, 2006),
            (PAYER, caller.pubkey(), 2012),
            (
                REFUND_TO,
                attacker,
                fade_error(FadeError::BeneficiaryMismatch),
            ),
            (ESCROW, attacker, 2006),
            (ESCROW, env.a.vault_usdc, 2040),
            (VAULT_USDC, attacker, 2006),
            (AUTHORITY, caller.pubkey(), 2006),
            (MINT, other_mint, fade_error(FadeError::WrongMint)),
        ];
        for (i, a, code) in cases {
            let mut ix = base.clone();
            ix.accounts[i].pubkey = a;
            refused_anchor(&mut env, &caller, ix, id, &tickets, code);
        }
        // Another ticket of the round named with this ticket's integrator:
        // the integrator must be the one that ticket stores.
        let mut ix = base.clone();
        ix.accounts[TICKET].pubkey = tickets[1];
        ix.accounts[INTEGRATOR].pubkey = addr(env.round_ticket(&t).integrator);
        refused_anchor(&mut env, &caller, ix, id, &tickets, 2012);
        // Each writable account read-only.
        for i in [
            VAULT, ROUND, INTEGRATOR, TICKET, PAYER, REFUND_TO, ESCROW, VAULT_USDC,
        ] {
            let mut ix = base.clone();
            ix.accounts[i].is_writable = false;
            refused_anchor(&mut env, &caller, ix, id, &tickets, 2000);
        }
        return_checked(&mut env, &t, false);
        // Returned once.
        let ix = env.return_round_ticket_ix(&caller.pubkey(), &tickets[1], rp);
        let mut twice = ix.clone();
        twice.accounts[TICKET].pubkey = t;
        refused_ix(&mut env, &caller, twice, id, &tickets[1..], |f| {
            f.has_code(3012)
        });
    }

    /// The last return closes the round only with its rent payer, the stored
    /// one (`RentReceiverRequired`), and a return that does not close it does
    /// not read one.
    #[test]
    fn the_rent_payer_is_required_to_close() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, tickets) = unpaid(&mut env, &cast, 2);
        to_refund_window(&mut env, id);
        refund_checked(&mut env, id, &cast);
        let caller = funded(&mut env);
        let ix = env.return_round_ticket_ix(&caller.pubkey(), &tickets[0], None);
        send(&mut env, &caller, ix).unwrap();
        let ix = env.return_round_ticket_ix(&caller.pubkey(), &tickets[1], None);
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets[1..],
            FadeError::RentReceiverRequired,
        );
        let ix = env.return_round_ticket_ix(&caller.pubkey(), &tickets[1], Some(caller.pubkey()));
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets[1..],
            FadeError::RentReceiverRequired,
        );
        return_checked(&mut env, &tickets[1], false);
        assert!(!env.exists(&round_address(id)));
    }

    /// Books that do not hold what the round owes fail closed: a refunded
    /// round one lamport short of its rent plus the other tickets' prepays
    /// after this return, a forfeited one one lamport short of its rent, a
    /// round counting a ticket, a prepay, a liability or a share fewer, an
    /// integrator reserving less, the vault owing less back.
    #[test]
    fn inconsistent_books_fail_closed() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, tickets) = unpaid(&mut env, &cast, 2);
        to_refund_window(&mut env, id);
        refund_checked(&mut env, id, &cast);
        let caller = funded(&mut env);
        let t = tickets[0];
        let rp = Some(addr(env.round(id).rent_payer));
        let w = env.round_ticket(&t);
        let r0 = env.round(id);
        let l0 = env.lamports(&round_address(id));
        let floor = rent(&env, ROUND_LEN);
        let exact = floor + r0.prepaid + r0.sponsorship;
        assert_eq!(l0, exact, "the round holds its rent, every prepay and S");
        // One lamport short of rent + the other prepays after the return.
        let short = floor + (r0.prepaid - w.prepay) + w.prepay - 1;
        env.set_round(id, Some(short), |_| {});
        let ix = env.return_round_ticket_ix(&caller.pubkey(), &t, rp);
        refused(&mut env, &caller, ix, id, &tickets, FadeError::MathOverflow);
        env.set_round(id, Some(l0), |_| {});
        let fields: Vec<fn(&mut Round)> = vec![
            |r| r.tickets = 0,
            |r| r.prepaid = 0,
            |r| r.liability = 0,
            |r| r.credits = 0,
            |r| r.protocol_shares = 0,
            |r| r.app_shares = 0,
        ];
        for f in fields {
            env.set_round(id, None, f);
            let ix = env.return_round_ticket_ix(&caller.pubkey(), &t, rp);
            refused(&mut env, &caller, ix, id, &tickets, FadeError::MathOverflow);
            env.set_round(id, None, |r| *r = r0.clone());
        }
        let owed = env.vault().beacon_returns_owed;
        env.set_vault(|v| v.beacon_returns_owed = w.price - 1);
        let ix = env.return_round_ticket_ix(&caller.pubkey(), &t, rp);
        refused(&mut env, &caller, ix, id, &tickets, FadeError::MathOverflow);
        env.set_vault(|v| v.beacon_returns_owed = owed);
        let integrator = addr(w.integrator);
        let i0 = env.svm.get_account(&integrator).unwrap();
        let mut i: Integrator = env.read(&integrator);
        i.reserved_liability = w.liability - 1;
        let mut d = i0.clone();
        d.data[..ser(&i).len()].copy_from_slice(&ser(&i));
        env.svm.set_account(integrator, d).unwrap();
        let ix = env.return_round_ticket_ix(&caller.pubkey(), &t, rp);
        refused(&mut env, &caller, ix, id, &tickets, FadeError::MathOverflow);
        env.svm.set_account(integrator, i0).unwrap();
        return_checked(&mut env, &t, false);

        // A forfeited round one lamport short of its rent after paying this
        // ticket's payer its prepay less its charge: refused, nothing moved;
        // at exactly its rent after the return, accepted.
        let mut env = setup();
        let cast = super::settle_round_tickets::cast(&mut env, 1, 2);
        let (id, tickets) = fill(&mut env, &cast, 3);
        let close = env.round(id).close_slot;
        at_slot(&mut env, close + 2);
        env.request_round_draw(id).unwrap();
        to_expiry(&mut env, id);
        expire_checked(&mut env, id);
        let caller = funded(&mut env);
        let t = tickets[0];
        let rp = Some(addr(env.round(id).rent_payer));
        let w = env.round_ticket(&t);
        let r = env.round(id);
        assert_eq!(r.status, RoundStatus::Forfeited);
        let charge =
            fade_math::beacon::charge(r.draw_cost, r.sponsorship, r.prices, w.price).unwrap();
        let back = w.prepay - charge;
        assert!(back > 0, "the payer is owed something back");
        let floor = rent(&env, ROUND_LEN);
        env.set_round(id, Some(floor + back - 1), |_| {});
        let ix = env.return_round_ticket_ix(&caller.pubkey(), &t, rp);
        refused(&mut env, &caller, ix, id, &tickets, FadeError::MathOverflow);
        env.set_round(id, Some(floor + back), |_| {});
        let meta = return_checked(&mut env, &t, false);
        assert_eq!(events::<RoundTicketReturned>(&meta)[0].charge, charge);
        assert_eq!(
            env.lamports(&round_address(id)),
            floor,
            "the boundary: exactly its rent left"
        );
    }

    /// Review of step 9: the expiry observes the price once (§13.5.8, §13.7)
    /// in the drawdown ring. Expired three hours past the ring's head: the
    /// hours between hold the price before the forfeiture, the new head the
    /// higher price after it. `expire_checked` computes the ring itself, so
    /// dropping the observation or swapping its prices is caught here.
    #[test]
    fn an_expiry_observes_the_price_in_the_ring() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, _) = fill(&mut env, &cast, 3);
        to_expiry(&mut env, id);
        let v0 = env.vault();
        let head = v0.price_head_hour;
        let unix = (head + 3) * fade_math::drawdown::SECONDS_PER_HOUR + 7;
        assert!(unix > env.now());
        let slot = env.slot();
        env.set_time(slot, unix);
        let before = v0.settled_price().unwrap();
        expire_checked(&mut env, id);
        let v = env.vault();
        let after = v.settled_price().unwrap();
        assert!(after > before, "the forfeiture moves the price up");
        let hours = fade_math::drawdown::HOURS as i64;
        assert_eq!(v.price_head_hour, head + 3);
        for h in [head + 1, head + 2] {
            assert_eq!(v.price_maxima[h.rem_euclid(hours) as usize], before);
        }
        assert_eq!(v.price_maxima[(head + 3).rem_euclid(hours) as usize], after);
    }

    // --- expire_round ---------------------------------------------------------------------

    /// A forfeiture without a request: a paid round of
    /// four tickets from two integrators and two payers, sponsored by its
    /// last join, never requested. `NotExpired` at `close_slot + T_SETTLE`;
    /// forfeited at the next slot (`expire_checked`): nothing spent, `C = 0`.
    /// Every ticket returned (`return_checked`): charged nothing, its prepay
    /// and rent to its payer, its settlement share to the caller, its app
    /// share to its integrator; the sponsor reclaims everything, and the
    /// round closes with exactly its rent.
    #[test]
    fn an_unrequested_round_forfeits() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 2);
        let (id, tickets) = fill(&mut env, &cast, 4);
        let r = env.round(id);
        let caller = funded(&mut env);
        let now = env.now();
        env.set_time(r.close_slot + r.t_settle_slots, now + 300);
        let ix = env.expire_round_ix(&caller.pubkey(), id, &Address::new_unique());
        refused(&mut env, &caller, ix, id, &tickets, FadeError::NotExpired);
        to_expiry(&mut env, id);
        // The round's request address, where nothing exists.
        let (x, _) = expire_checked(&mut env, id);
        assert_eq!((x.draw_cost, x.refund), (0, 0));
        let v = env.vault();
        assert_eq!(v.protocol_shares_accrued, r.protocol_shares);
        for t in &tickets {
            return_checked(&mut env, t, false);
        }
        let sponsor = addr(r.rent_payer);
        let _ = sponsor;
        let sponsors: Vec<Address> = cast
            .payers
            .iter()
            .map(|p| p.pubkey())
            .filter(|p| env.exists(&sponsorship_address(&round_address(id), p)))
            .collect();
        assert_eq!(sponsors.len(), 1);
        let s = env.round(id).sponsorship;
        let l = env.lamports(&round_address(id));
        assert_eq!(
            l,
            rent(&env, ROUND_LEN) + s,
            "the round holds its rent and S"
        );
        assert_eq!(
            reclaim_checked(&mut env, id, &sponsors),
            s,
            "all of it back"
        );
        assert!(!env.exists(&round_address(id)));
        let v = env.vault();
        assert_eq!(
            (
                v.beacon_shares_held,
                v.total_reserved_liability,
                v.open_vault_credits
            ),
            (0, 0, 0)
        );
        assert_eq!(v.app_shares_owed, r.app_shares);
    }

    /// A withheld draw: requested, never fulfilled. Expired after
    /// `T_SETTLE`, the request's whole cost is the draw cost; sponsors are
    /// charged first and each ticket `ceil((C − min(S, C)) × price / R)`, at
    /// most its prepay. Without third-party sponsorship, with sponsorship
    /// covering `C`, and with lamports sent to `round_vrf` before the expiry,
    /// which lower `C`. The charges cover the draw, every sponsor gets §13.4's
    /// return, and the round closes with its dust, under a lamport a ticket
    /// and a sponsor.
    #[test]
    fn a_withheld_round_forfeits() {
        for (sponsored, stray) in [(false, 0u64), (true, 0), (false, 1_000_000)] {
            let mut env = setup();
            let cast = cast(&mut env, 2, 3);
            let (id, tickets) = fill(&mut env, &cast, 5);
            let mut sponsors: Vec<Address> = cast
                .payers
                .iter()
                .map(|p| p.pubkey())
                .filter(|p| env.exists(&sponsorship_address(&round_address(id), p)))
                .collect();
            if sponsored {
                let s = funded(&mut env);
                env.sponsor(&s, id, 20_000_000).unwrap();
                sponsors.push(s.pubkey());
            }
            let close = env.round(id).close_slot;
            at_slot(&mut env, close + 2);
            env.request_round_draw(id).unwrap();
            if stray > 0 {
                env.svm.airdrop(&round_vrf_address(id), stray).unwrap();
            }
            to_expiry(&mut env, id);
            let rent_payer = addr(env.round(id).rent_payer);
            let (x, _) = expire_checked(&mut env, id);
            let r = env.round(id);
            assert_eq!(x.refund, stray);
            assert_eq!(
                x.draw_cost,
                r.funded + r.request_share - stray.min(r.funded)
            );
            let mut charged = 0;
            for t in &tickets {
                let meta = return_checked(&mut env, t, false);
                charged += events::<RoundTicketReturned>(&meta)[0].charge;
            }
            let to_prices = x.draw_cost.saturating_sub(r.sponsorship);
            assert!(charged >= to_prices, "the charges cover the draw (fact 2)");
            assert!(charged <= to_prices + tickets.len() as u64);
            if sponsored {
                assert_eq!(charged, 0, "a sponsorship covering C spares the tickets");
            }
            let held = env.lamports(&round_address(id));
            let rp0 = env.lamports(&rent_payer);
            let returned = reclaim_checked(&mut env, id, &sponsors);
            assert!(
                !env.exists(&round_address(id)),
                "closed on the last reclaim"
            );
            let dust = held - returned - rent(&env, ROUND_LEN);
            assert!(
                dust <= (tickets.len() + sponsors.len()) as u64,
                "the dust: {dust}"
            );
            if !sponsors.contains(&rent_payer) {
                assert_eq!(env.lamports(&rent_payer), rp0 + held - returned);
            }
        }
    }

    /// A sponsor that covers the draw of a forfeited round may reclaim before
    /// its tickets are returned: it gets §13.4's return, the round keeps every
    /// ticket's whole prepay, and each ticket is then charged nothing.
    #[test]
    fn a_sponsor_reclaims_before_the_forfeited_tickets() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, tickets) = fill(&mut env, &cast, 3);
        let s = funded(&mut env);
        env.sponsor(&s, id, 20_000_000).unwrap();
        let close = env.round(id).close_slot;
        at_slot(&mut env, close + 2);
        env.request_round_draw(id).unwrap();
        to_expiry(&mut env, id);
        let (x, _) = expire_checked(&mut env, id);
        let r = env.round(id);
        assert!(r.sponsorship > x.draw_cost, "the sponsors cover the draw");
        let mut sponsors: Vec<Address> = cast
            .payers
            .iter()
            .map(|p| p.pubkey())
            .filter(|p| env.exists(&sponsorship_address(&round_address(id), p)))
            .collect();
        sponsors.push(s.pubkey());
        let returned = reclaim_checked(&mut env, id, &sponsors);
        let dust = r.sponsorship - x.draw_cost - returned;
        assert!(dust <= sponsors.len() as u64);
        assert_eq!(
            env.lamports(&round_address(id)),
            rent(&env, ROUND_LEN) + r.prepaid + dust,
            "the round keeps every prepay"
        );
        for t in &tickets {
            let meta = return_checked(&mut env, t, false);
            assert_eq!(events::<RoundTicketReturned>(&meta)[0].charge, 0);
        }
        assert!(
            !env.exists(&round_address(id)),
            "closed with its last ticket"
        );
    }

    /// A forfeited ticket's return moves no token, so it never reads
    /// `refund_to`: a frozen or closed one parks nothing.
    #[test]
    fn a_forfeited_return_moves_no_token() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        let (id, tickets) = fill(&mut env, &cast, 2);
        to_expiry(&mut env, id);
        expire_checked(&mut env, id);
        let refund_to = addr(env.round_ticket(&tickets[0]).refund_to);
        env.set_token_state(&refund_to, 2);
        return_checked(&mut env, &tickets[0], false);
        env.svm.set_account(refund_to, Account::default()).unwrap();
        return_checked(&mut env, &tickets[1], false);
        assert_eq!(env.balance(&env.a.payout_escrow), 0);
    }

    /// Creates round `id`'s request through ORAO now, as anyone may once its
    /// seed is public, and fulfils it with `randomness` unless `None`.
    fn pre_create(env: &mut Env, id: u64, randomness: Option<[u8; 64]>) -> Address {
        let request = env.round_request_address(id);
        let seed = env.round_seed(id);
        let someone = funded(env);
        let ix = super::request_round_draw::orao_request_ix(
            env,
            &someone.pubkey(),
            &request,
            seed,
            false,
        );
        env.send(&[ix], &[&someone]).unwrap();
        if let Some(r) = randomness {
            env.fulfill(&request, r);
        }
        request
    }

    /// Review of step 9: a round never requested is not forfeited while its
    /// request exists, fulfilled, at its ORAO address. Its seed is public from
    /// the slot after the close, so whoever created the request knew every
    /// ticket's outcome before the expiry; forfeiting it then, as a keeper's
    /// failure, would let them withhold every draw the players win. Expired
    /// with its request address: `AlreadyFulfilled`, and another account in
    /// its place is refused. Bound after the window by anyone, who is paid
    /// the request share, nothing funded; still not forfeitable; settled.
    #[test]
    fn a_fulfilled_request_nobody_bound_is_settled_not_forfeited() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, tickets) = fill(&mut env, &cast, 3);
        let r0 = env.round(id);
        at_slot(&mut env, r0.close_slot + 2);
        let seed = env.round_seed(id);
        let mut randomness = [9u8; 64];
        randomness[63] = 1;
        let request = pre_create(&mut env, id, Some(randomness));
        to_expiry(&mut env, id);
        assert_eq!(env.expiry_request(id), request);
        let caller = funded(&mut env);
        let ix = env.expire_round_ix(&caller.pubkey(), id, &request);
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::AlreadyFulfilled,
        );
        for other in [Address::new_unique(), addr(r0.randomness)] {
            let ix = env.expire_round_ix(&caller.pubkey(), id, &other);
            refused(
                &mut env,
                &caller,
                ix,
                id,
                &tickets,
                FadeError::WrongRandomnessAccount,
            );
        }

        let binder = funded(&mut env);
        let binder0 = env.lamports(&binder.pubkey());
        let ix = env.request_round_draw_ix(&binder.pubkey(), id, &request);
        send(&mut env, &binder, ix).unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        let r = env.round(id);
        assert_eq!(
            (r.status, addr(r.randomness), r.seed, r.funded),
            (RoundStatus::Requested, request, seed, 0)
        );
        assert_eq!(env.lamports(&binder.pubkey()), binder0 + r.request_share);
        let ix = env.expire_round_ix(&caller.pubkey(), id, &request);
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::AlreadyFulfilled,
        );
        env.settle_round(id, &tickets)
            .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        for t in &tickets {
            assert!(
                !env.exists(t) || env.round_ticket(t).status != RoundTicketStatus::Joined,
                "every ticket settled"
            );
        }
    }

    /// The vault counts every forfeiture, and as one a withheld draw may
    /// explain unless it is the keepers' failure (never requested, its
    /// request looked for and not found): the durable record the keeper's
    /// `withheld-draw` alarm compares instead of inferring a withheld draw
    /// from transaction history (final audit). Four
    /// rounds, one of each kind, counted with literal totals.
    #[test]
    fn the_vault_counts_forfeitures() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let counts = |env: &Env| {
            let v = env.vault();
            (v.rounds_forfeited, v.forfeits_withheld)
        };
        assert_eq!(counts(&env), (0, 0));

        // Never requested, looked for, nothing found: the keepers' failure.
        let (a, _) = fill(&mut env, &cast, 2);
        to_expiry(&mut env, a);
        expire_checked(&mut env, a);
        assert_eq!(counts(&env), (1, 0));

        // Never requested, a request someone created through ORAO found.
        let (b, _) = fill(&mut env, &cast, 2);
        let rb = env.round(b);
        at_slot(&mut env, rb.close_slot + 2);
        pre_create(&mut env, b, None);
        to_expiry(&mut env, b);
        let (_, meta) = expire_checked(&mut env, b);
        let e = &events::<RoundExpired>(&meta)[0];
        assert_eq!(
            (e.requested, e.request_found, e.checked),
            (false, true, true)
        );
        assert_eq!(counts(&env), (2, 1));

        // Requested and never fulfilled.
        let (c, _) = fill(&mut env, &cast, 2);
        let rc = env.round(c);
        at_slot(&mut env, rc.close_slot + 2);
        env.request_round_draw(c)
            .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        to_expiry(&mut env, c);
        let (_, meta) = expire_checked(&mut env, c);
        assert!(events::<RoundExpired>(&meta)[0].requested);
        assert_eq!(counts(&env), (3, 2));

        // Never requested nor recorded, expired once SlotHashes no longer
        // proves its entropy slot: nothing could be looked for
        // (`checked = false`), so it is refunded, not forfeited, and counted
        // as one a withheld draw may explain.
        let (d, _) = fill(&mut env, &cast, 2);
        let rd = env.round(d);
        at_slot(&mut env, rd.close_slot + 514);
        let meta = expire_refund_checked(&mut env, d, &Address::new_unique());
        assert!(!events::<RoundExpired>(&meta)[0].checked);
        assert_eq!(counts(&env), (3, 3));
    }

    /// The documented residual of the 22 October 2026 audit (F-3), on
    /// rounds: when ORAO fulfils a requested round after its window, whoever
    /// orders that slot chooses the end, the expiry first or the fulfil
    /// first. No expiry rule removes the choice while the outcome depends on
    /// R alone; what holds is that the expiry ahead of the fulfil counts as
    /// one a withheld draw may explain, with its ordinal in the event.
    #[test]
    fn an_expiry_ordered_ahead_of_a_late_fulfil_counts_as_withheld() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, _) = fill(&mut env, &cast, 2);
        let r = env.round(id);
        at_slot(&mut env, r.close_slot + 2);
        env.request_round_draw(id)
            .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        to_expiry(&mut env, id);
        let before = env.vault().forfeits_withheld;
        // The expiry lands first, the fulfil right after, in the same slot.
        let slot = env.slot();
        let (_, meta) = expire_checked(&mut env, id);
        env.fulfill_round(id, [9u8; 64]);
        assert_eq!(env.slot(), slot);
        let e = &events::<RoundExpired>(&meta)[0];
        assert!(e.requested);
        assert_eq!(e.forfeits_withheld, before + 1);
        assert_eq!(env.vault().forfeits_withheld, before + 1);
    }

    /// A request created through ORAO and never bound, pending or fulfilled
    /// with zero, does not stop the forfeiture, which reports it
    /// (`request_found`): the alarm reads it as a withheld draw. Review of
    /// step 12: after the window it is not bound late either
    /// (`RoundRequestWindow`, nothing moved). Bound, it would only pay the
    /// request share from the round to the binder and charge it to every
    /// forfeited ticket as a draw cost; unbound, the expiry charges nothing.
    #[test]
    fn a_request_nobody_bound_is_reported() {
        for fulfilled_zero in [false, true] {
            let mut env = setup();
            let cast = cast(&mut env, 1, 2);
            let (id, tickets) = fill(&mut env, &cast, 2);
            let r0 = env.round(id);
            at_slot(&mut env, r0.close_slot + 2);
            let request = pre_create(&mut env, id, fulfilled_zero.then_some([0u8; 64]));
            to_expiry(&mut env, id);
            let binder = funded(&mut env);
            let ix = env.request_round_draw_ix(&binder.pubkey(), id, &request);
            refused(
                &mut env,
                &binder,
                ix,
                id,
                &tickets,
                FadeError::RoundRequestWindow,
            );
            assert_eq!(env.round(id).status, RoundStatus::Paid);
            let (x, meta) = expire_checked(&mut env, id);
            let e = &events::<RoundExpired>(&meta)[0];
            assert_eq!(
                (e.requested, e.request_found, e.checked),
                (false, true, true)
            );
            assert_eq!((x.draw_cost, x.refund, e.draw_cost), (0, 0, 0));
            for t in &tickets {
                let meta = return_checked(&mut env, t, false);
                assert_eq!(events::<RoundTicketReturned>(&meta)[0].charge, 0);
            }
        }
    }

    /// Review of step 12: a pending request bound late in its own window, then
    /// fulfilled after it, is the requested path's business: the expiry
    /// refuses it fulfilled, and it settles. A pending request found only
    /// after the window is bound once ORAO fulfils it, not before.
    #[test]
    fn a_pending_request_is_bound_late_once_fulfilled() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, tickets) = fill(&mut env, &cast, 2);
        let r0 = env.round(id);
        at_slot(&mut env, r0.close_slot + 2);
        let request = pre_create(&mut env, id, None);
        to_expiry(&mut env, id);
        let binder = funded(&mut env);
        let ix = env.request_round_draw_ix(&binder.pubkey(), id, &request);
        refused(
            &mut env,
            &binder,
            ix,
            id,
            &tickets,
            FadeError::RoundRequestWindow,
        );
        let mut randomness = [5u8; 64];
        randomness[63] = 1;
        env.fulfill(&request, randomness);
        let binder0 = env.lamports(&binder.pubkey());
        let ix = env.request_round_draw_ix(&binder.pubkey(), id, &request);
        send(&mut env, &binder, ix).unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        let r = env.round(id);
        assert_eq!((r.status, r.funded), (RoundStatus::Requested, 0));
        assert_eq!(env.lamports(&binder.pubkey()), binder0 + r.request_share);
        env.settle_round(id, &tickets)
            .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
    }

    /// Review of step 9: a round never requested whose request address holds
    /// an ORAO account that does not parse is refused as on the requested
    /// path (`WrongRandomnessAccount`), nothing moved, rather than forfeited:
    /// whoever reads that request off-chain may know its outcome, so an
    /// unreadable layout is no licence to withhold it. Garbage of the same
    /// length, the discriminator alone, no data, an unknown tag, a fulfilled
    /// request cut short. Restored, the expiry goes ahead and reports it.
    #[test]
    fn an_unparseable_request_nobody_bound_is_refused_not_forfeited() {
        use fade_math::orao_layout::{FULFILLED_LEN, RANDOMNESS_V2_DISCRIMINATOR};
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, tickets) = fill(&mut env, &cast, 2);
        let r0 = env.round(id);
        at_slot(&mut env, r0.close_slot + 2);
        let request = pre_create(&mut env, id, None);
        to_expiry(&mut env, id);
        assert_eq!(env.expiry_request(id), request);
        let pending = env.svm.get_account(&request).unwrap();
        assert_eq!(pending.data[..8], RANDOMNESS_V2_DISCRIMINATOR);
        let p = pending.data.clone();
        let truncated_fulfilled = {
            let mut d = p[..FULFILLED_LEN - 1].to_vec();
            d[8] = 1;
            d
        };
        let unknown_tag = {
            let mut d = p.clone();
            d[8] = 2;
            d
        };
        let caller = funded(&mut env);
        for data in [
            vec![0xAB; p.len()],
            p[..8].to_vec(),
            Vec::new(),
            unknown_tag,
            truncated_fulfilled,
        ] {
            set_account(&mut env, &request, |a| a.data = data);
            assert_eq!(env.svm.get_account(&request).unwrap().owner, pending.owner);
            let ix = env.expire_round_ix(&caller.pubkey(), id, &request);
            refused(
                &mut env,
                &caller,
                ix,
                id,
                &tickets,
                FadeError::WrongRandomnessAccount,
            );
            assert_eq!(env.round(id).status, RoundStatus::Paid);
        }
        env.svm.set_account(request, pending).unwrap();
        let (_, meta) = expire_checked(&mut env, id);
        let e = &events::<RoundExpired>(&meta)[0];
        assert_eq!(
            (e.requested, e.request_found, e.checked),
            (false, true, true)
        );
        for t in &tickets {
            return_checked(&mut env, t, false);
        }
    }

    /// `ix`, signed by the keeper alone (it names no signer), is refused as
    /// `code` says, and nothing moved.
    #[track_caller]
    fn refused_unsigned(env: &mut Env, ix: Instruction, id: u64, tickets: &[Address], code: u32) {
        let keeper = env.keeper.insecure_clone();
        let mut addresses = watched(env, id, &keeper.pubkey(), tickets);
        for m in &ix.accounts {
            if !addresses.contains(&m.pubkey) {
                addresses.push(m.pubkey);
            }
        }
        let before = snapshot(env, &addresses);
        let err = env.send(&[ix], &[&keeper]).expect_err("refused");
        assert!(err.has_code(code), "{}\n{}", err.err, err.logs.join("\n"));
        let keeper_at = addresses
            .iter()
            .position(|a| *a == keeper.pubkey())
            .unwrap();
        let mut after = snapshot(env, &addresses);
        // The fee is the keeper's.
        after[keeper_at] = before[keeper_at].clone();
        assert_eq!(after, before, "a refusal moves nothing");
    }

    /// `record_round_entropy` (§13.5.6a): refused for a paid round before
    /// SlotHashes holds `s*` (`EntropyUnavailable`, at `close_slot + 1`), with
    /// remaining accounts, with another account as the sysvar (2012), and for
    /// an unpaid round (`WrongRoundStatus`). At `close_slot + 2` it writes the
    /// seed of §13.4 (computed here byte by byte) and `s* = close_slot + 1`,
    /// nothing else of the round, nothing of the vault and no lamport but the
    /// fee, with its event. Sent again, it succeeds and writes nothing. The
    /// request then derives its address from the recorded seed and reports
    /// `h*` while SlotHashes still holds it; recording a requested round is
    /// the same no-op.
    #[test]
    fn record_round_entropy_records_the_seed_alone() {
        use fade::events::{RoundDrawRequested, RoundEntropyRecorded};
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, tickets) = fill(&mut env, &cast, 2);
        let r0 = env.round(id);
        let close = r0.close_slot;

        at_slot(&mut env, close + 1);
        let ix = env.record_round_entropy_ix(id);
        refused_unsigned(
            &mut env,
            ix,
            id,
            &tickets,
            fade_error(FadeError::EntropyUnavailable),
        );
        at_slot(&mut env, close + 2);
        let mut ix = env.record_round_entropy_ix(id);
        ix.accounts
            .push(AccountMeta::new_readonly(Address::new_unique(), false));
        refused_unsigned(
            &mut env,
            ix,
            id,
            &tickets,
            fade_error(FadeError::RemainingAccounts),
        );
        let mut ix = env.record_round_entropy_ix(id);
        ix.accounts[1].pubkey = Address::new_unique();
        refused_unsigned(&mut env, ix, id, &tickets, 2012);

        let seed = env.spec_seed(id);
        let v0 = env.vault();
        let round_l0 = env.lamports(&round_address(id));
        let meta = env
            .record_round_entropy(id)
            .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        let mut er = r0.clone();
        er.seed = seed;
        er.entropy_slot = close + 1;
        assert_eq!(
            ser(&env.round(id)),
            ser(&er),
            "the seed and s*, nothing else"
        );
        assert_eq!(ser(&env.vault()), ser(&v0), "nothing of the vault");
        assert_eq!(env.lamports(&round_address(id)), round_l0);
        let e = events::<RoundEntropyRecorded>(&meta);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].version, 1);
        assert_eq!(addr(e[0].round), round_address(id));
        assert_eq!(
            (e[0].seed, e[0].entropy_slot, e[0].entropy_hash),
            (seed, close + 1, slot_hash(close + 1))
        );

        at_slot(&mut env, close + 3);
        let meta = env.record_round_entropy(id).unwrap();
        assert!(events::<RoundEntropyRecorded>(&meta).is_empty());
        assert_eq!(
            ser(&env.round(id)),
            ser(&er),
            "a second record writes nothing"
        );

        let (request, meta) = env
            .request_round_draw(id)
            .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        assert_eq!(
            request,
            pda(&[fade_math::orao_layout::REQUEST_SEED, &seed], &orao_id())
        );
        let e = &events::<RoundDrawRequested>(&meta)[0];
        assert_eq!(
            (e.seed, e.entropy_slot, e.entropy_hash),
            (seed, close + 1, slot_hash(close + 1))
        );
        let r = env.round(id);
        assert_eq!(
            (r.status, r.seed, r.entropy_slot),
            (RoundStatus::Requested, seed, close + 1)
        );
        let meta = env.record_round_entropy(id).unwrap();
        assert!(events::<RoundEntropyRecorded>(&meta).is_empty());
        assert_eq!(ser(&env.round(id)), ser(&r));

        // An unpaid round has nothing to record.
        let (u, ut) = unpaid(&mut env, &cast, 1);
        let ix = env.record_round_entropy_ix(u);
        refused_unsigned(
            &mut env,
            ix,
            u,
            &ut,
            fade_error(FadeError::WrongRoundStatus),
        );
    }

    /// Fifth audit pass, finding 1: the round's seed recorded at
    /// `close_slot + 2`, a fulfilled request created through ORAO just
    /// before SlotHashes forgets `s*` and never bound is still found from the
    /// recorded seed after the eviction: the expiry is refused
    /// (`AlreadyFulfilled`) at `close_slot + 514`, 2 000 and 100 000, and
    /// with another account in its place (`WrongRandomnessAccount`); the
    /// late binding succeeds long after the eviction (the binder paid the
    /// request share, nothing funded, `h*` reported as zero since the sysvar
    /// no longer holds it), and the round settles. Before the fix, the
    /// expiry at `close_slot + 514` forfeited every ticket.
    #[test]
    fn a_recorded_round_is_never_forfeited_past_slot_hashes() {
        use fade::events::RoundDrawRequested;
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, tickets) = fill(&mut env, &cast, 3);
        let r0 = env.round(id);
        let close = r0.close_slot;
        at_slot(&mut env, close + 2);
        let seed = env.spec_seed(id);
        env.record_round_entropy(id)
            .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        // The withholder creates the request as late as SlotHashes still
        // proves `s*`, and reads its outcome.
        at_slot(&mut env, close + 500);
        let mut randomness = [7u8; 64];
        randomness[63] = 1;
        let request = pre_create(&mut env, id, Some(randomness));
        assert_eq!(
            request,
            pda(&[fade_math::orao_layout::REQUEST_SEED, &seed], &orao_id())
        );
        let caller = funded(&mut env);
        for slot in [close + 514, close + 2_000, close + 100_000] {
            at_slot(&mut env, slot);
            assert!(
                !entropy_retained(&env, close),
                "SlotHashes no longer proves s*"
            );
            assert_eq!(env.expiry_request(id), request);
            let ix = env.expire_round_ix(&caller.pubkey(), id, &request);
            refused(
                &mut env,
                &caller,
                ix,
                id,
                &tickets,
                FadeError::AlreadyFulfilled,
            );
            let ix = env.expire_round_ix(&caller.pubkey(), id, &Address::new_unique());
            refused(
                &mut env,
                &caller,
                ix,
                id,
                &tickets,
                FadeError::WrongRandomnessAccount,
            );
        }

        let binder = funded(&mut env);
        let binder0 = env.lamports(&binder.pubkey());
        let ix = env.request_round_draw_ix(&binder.pubkey(), id, &request);
        let meta = send(&mut env, &binder, ix)
            .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        let r = env.round(id);
        assert_eq!(
            (
                r.status,
                addr(r.randomness),
                r.seed,
                r.entropy_slot,
                r.funded
            ),
            (RoundStatus::Requested, request, seed, close + 1, 0)
        );
        assert_eq!(env.lamports(&binder.pubkey()), binder0 + r.request_share);
        let e = &events::<RoundDrawRequested>(&meta)[0];
        assert_eq!(
            (
                addr(e.request),
                e.seed,
                e.entropy_slot,
                e.entropy_hash,
                e.funded
            ),
            (request, seed, close + 1, [0u8; 32], 0)
        );
        let ix = env.expire_round_ix(&caller.pubkey(), id, &request);
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::AlreadyFulfilled,
        );
        env.settle_round(id, &tickets)
            .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        for t in &tickets {
            assert!(
                !env.exists(t) || env.round_ticket(t).status != RoundTicketStatus::Joined,
                "every ticket settled"
            );
        }
    }

    /// A recorded round nobody requested, and whose request nobody created,
    /// still forfeits after SlotHashes forgets `s*`: the program looks for
    /// the request at the recorded seed's address, finds none, and reports
    /// the keepers' failure (`checked`, not `request_found`), not counted as
    /// withheld. Nobody can know the outcome of a draw that does not exist.
    #[test]
    fn a_recorded_round_without_a_request_forfeits_as_the_keepers_failure() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, tickets) = fill(&mut env, &cast, 2);
        let close = env.round(id).close_slot;
        at_slot(&mut env, close + 2);
        env.record_round_entropy(id).unwrap();
        at_slot(&mut env, close + 600);
        assert!(!entropy_retained(&env, close));
        let (x, meta) = expire_checked(&mut env, id);
        let e = &events::<RoundExpired>(&meta)[0];
        assert_eq!(
            (e.requested, e.request_found, e.checked, e.refunded),
            (false, false, true, false)
        );
        assert_eq!((x.draw_cost, x.refund), (0, 0));
        let v = env.vault();
        assert_eq!((v.rounds_forfeited, v.forfeits_withheld), (1, 0));
        for t in &tickets {
            return_checked(&mut env, t, false);
        }
    }

    /// A round never recorded, whose `s*` SlotHashes no longer proves, can
    /// no longer be looked for: someone may hold its fulfilled request (here
    /// created at `close_slot + 2` and refusing the expiry at `close + 513`).
    /// From `close_slot + 514` its entropy can neither be recorded nor its
    /// request bound (`EntropyUnrecorded`, nothing moved), and the expiry
    /// refunds it rather than forfeit it, with the request's address or any
    /// account named (`expire_refund_checked`): its event reports
    /// `checked = false` and `refunded`, counted as a withheld draw. A second
    /// expiry is refused; every ticket gets its price and its prepay back,
    /// every sponsor its whole amount, and the round closes.
    #[test]
    fn an_unrecorded_round_past_slot_hashes_is_refunded_not_forfeited() {
        for named_request in [true, false] {
            let mut env = setup();
            let cast = cast(&mut env, 2, 2);
            let (id, tickets) = fill(&mut env, &cast, 4);
            let r0 = env.round(id);
            at_slot(&mut env, r0.close_slot + 2);
            let mut randomness = [7u8; 64];
            randomness[63] = 1;
            let request = pre_create(&mut env, id, Some(randomness));
            at_slot(&mut env, r0.close_slot + 513);
            let caller = funded(&mut env);
            let ix = env.expire_round_ix(&caller.pubkey(), id, &request);
            refused(
                &mut env,
                &caller,
                ix,
                id,
                &tickets,
                FadeError::AlreadyFulfilled,
            );

            at_slot(&mut env, r0.close_slot + 514);
            let ix = env.record_round_entropy_ix(id);
            refused_unsigned(
                &mut env,
                ix,
                id,
                &tickets,
                fade_error(FadeError::EntropyUnrecorded),
            );
            let ix = env.request_round_draw_ix(&caller.pubkey(), id, &request);
            refused(
                &mut env,
                &caller,
                ix,
                id,
                &tickets,
                FadeError::EntropyUnrecorded,
            );
            let named = if named_request {
                request
            } else {
                Address::new_unique()
            };
            expire_refund_checked(&mut env, id, &named);
            let ix = env.expire_round_ix(&caller.pubkey(), id, &named);
            refused(
                &mut env,
                &caller,
                ix,
                id,
                &tickets,
                FadeError::WrongRoundStatus,
            );

            for t in &tickets {
                let meta = return_checked(&mut env, t, false);
                assert_eq!(events::<RoundTicketReturned>(&meta)[0].charge, 0);
            }
            let sponsors: Vec<Address> = cast
                .payers
                .iter()
                .map(|p| p.pubkey())
                .filter(|p| env.exists(&sponsorship_address(&round_address(id), p)))
                .collect();
            let s = env.round(id).sponsorship;
            assert_eq!(
                reclaim_checked(&mut env, id, &sponsors),
                s,
                "all of it back"
            );
            assert!(!env.exists(&round_address(id)), "closed");
            let v = env.vault();
            assert_eq!(
                (
                    v.beacon_shares_held,
                    v.total_reserved_liability,
                    v.open_vault_credits,
                    v.beacon_returns_owed,
                    v.app_shares_owed,
                    v.protocol_shares_accrued,
                    v.open_before_close + v.open_after_close
                ),
                (0, 0, 0, 0, 0, 0, 0)
            );
            assert_eq!((v.rounds_forfeited, v.forfeits_withheld), (0, 1));
        }
    }

    /// `expire_round`'s checks, in order, each paired with a later one that
    /// would also fail: remaining accounts; the round `Paid` or `Requested`;
    /// recorded in the counters; `T_SETTLE` passed; then, requested, the
    /// request at its stored address, ORAO's, parsed, and not fulfilled with
    /// a non-zero value (`AlreadyFulfilled`: settle instead). A request
    /// fulfilled with zero randomness is expired. The round, the vault and
    /// `round_vrf` are pinned by their seeds. Every refusal moves nothing.
    #[test]
    fn expire_checks_in_order() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 2);
        let (id, tickets) = fill(&mut env, &cast, 3);
        let caller = funded(&mut env);
        let any = Address::new_unique();

        // Remaining accounts first (not expired either).
        let mut ix = env.expire_round_ix(&caller.pubkey(), id, &any);
        ix.accounts
            .push(AccountMeta::new_readonly(Address::new_unique(), false));
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::RemainingAccounts,
        );
        // The status before the clock.
        for status in [
            RoundStatus::Accepting,
            RoundStatus::Drawn,
            RoundStatus::Refunded,
            RoundStatus::Forfeited,
        ] {
            env.set_round(id, None, |r| r.status = status);
            let ix = env.expire_round_ix(&caller.pubkey(), id, &any);
            refused(
                &mut env,
                &caller,
                ix,
                id,
                &tickets,
                FadeError::WrongRoundStatus,
            );
        }
        env.set_round(id, None, |r| r.status = RoundStatus::Paid);
        // A paid round claiming not to be recorded, or recording neither side.
        let r0 = env.round(id);
        for f in [
            (|r: &mut Round| r.counted = false) as fn(&mut Round),
            |r: &mut Round| r.side = 7,
        ] {
            env.set_round(id, None, f);
            let ix = env.expire_round_ix(&caller.pubkey(), id, &any);
            refused(
                &mut env,
                &caller,
                ix,
                id,
                &tickets,
                FadeError::WrongRoundStatus,
            );
            env.set_round(id, None, |r| *r = r0.clone());
        }
        // Not expired: at the last slot of `T_SETTLE`, and long before.
        let deadline = r0.close_slot + r0.t_settle_slots;
        for slot in [r0.close_slot, deadline] {
            at_slot(&mut env, slot);
            let ix = env.expire_round_ix(&caller.pubkey(), id, &any);
            refused(&mut env, &caller, ix, id, &tickets, FadeError::NotExpired);
        }

        // Requested, pending.
        at_slot(&mut env, r0.close_slot + 2);
        let (request, _) = env.request_round_draw(id).unwrap();
        to_expiry(&mut env, id);
        let ix = env.expire_round_ix(&caller.pubkey(), id, &any);
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::WrongRandomnessAccount,
        );
        // Another ORAO request: another round's address, not this one's.
        let other = {
            let a = env.svm.get_account(&request).unwrap();
            let o = Address::new_unique();
            env.svm.set_account(o, a).unwrap();
            o
        };
        let ix = env.expire_round_ix(&caller.pubkey(), id, &other);
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::WrongRandomnessAccount,
        );
        // The request rewritten: not ORAO's, or not a request.
        let pending = env.svm.get_account(&request).unwrap();
        set_account(&mut env, &request, |a| a.owner = Address::new_unique());
        let ix = env.expire_round_ix(&caller.pubkey(), id, &request);
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::WrongRandomnessAccount,
        );
        set_account(&mut env, &request, |a| {
            a.owner = pending.owner;
            a.data = vec![0xAB; pending.data.len()];
        });
        let ix = env.expire_round_ix(&caller.pubkey(), id, &request);
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::WrongRandomnessAccount,
        );
        env.svm.set_account(request, pending.clone()).unwrap();

        // Fulfilled: settle instead, however late.
        let vrf0 = env.lamports(&round_vrf_address(id));
        env.fulfill_round(id, [9u8; 64]);
        let ix = env.expire_round_ix(&caller.pubkey(), id, &request);
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::AlreadyFulfilled,
        );

        // The fixed accounts: forged copies of the round and the vault, and
        // another account as `round_vrf`, refused by their seeds.
        env.svm.set_account(request, pending).unwrap();
        let refund = env.lamports(&round_vrf_address(id)) - vrf0;
        set_account(&mut env, &round_vrf_address(id), |a| a.lamports = vrf0);
        let forged = |env: &mut Env, from: &Address| {
            let f = Address::new_unique();
            let a = env.svm.get_account(from).unwrap();
            env.svm.set_account(f, a).unwrap();
            f
        };
        let vault = env.a.vault;
        let forged_round = forged(&mut env, &round_address(id));
        let forged_vault = forged(&mut env, &vault);
        env.svm.airdrop(&round_vrf_address(id + 1), refund).unwrap();
        for (i, a) in [
            (1usize, forged_vault),
            (2, forged_round),
            (3, round_vrf_address(id + 1)),
            (3, caller.pubkey()),
        ] {
            let mut ix = env.expire_round_ix(&caller.pubkey(), id, &request);
            ix.accounts[i].pubkey = a;
            refused_anchor(&mut env, &caller, ix, id, &tickets, 2006);
        }

        // Fulfilled with zero randomness: a withheld draw, expired; ORAO's
        // refund of the pending rent lowers the draw cost.
        env.fulfill_round(id, [0u8; 64]);
        let (x, _) = expire_checked(&mut env, id);
        assert_eq!(x.refund, refund);
        // And only once.
        let ix = env.expire_round_ix(&caller.pubkey(), id, &request);
        refused(
            &mut env,
            &caller,
            ix,
            id,
            &tickets,
            FadeError::WrongRoundStatus,
        );
        for t in &tickets {
            return_checked(&mut env, t, false);
        }
    }

    /// "The strike unaffected". A round that is never
    /// paid is never in the counters: neither its refund nor its returns move
    /// them, and the strike runs over it at the price it would have without
    /// it. A round paid before the close holds the strike until its expiry
    /// releases every ticket at once, its forfeited credits then in the
    /// epoch's price; its returns afterwards, across the strike, move neither
    /// a counter nor the price. A round paid after the close never holds the
    /// strike, and its forfeiture is an after-close gain the strike leaves
    /// out of its price.
    #[test]
    fn the_strike_is_unaffected() {
        // Never paid.
        {
            let mut env = setup();
            let cast = cast(&mut env, 1, 2);
            let lp = env.user(1_000 * USDC);
            let epoch = env.deposit(&lp, 100 * USDC).unwrap();
            let (id, tickets) = unpaid(&mut env, &cast, 3);
            let v0 = env.vault();
            assert!(!env.round(id).counted);
            assert_eq!((v0.open_before_close, v0.open_after_close), (0, 0));
            let settled = v0.total_assets - v0.open_vault_credits;
            to_refund_window(&mut env, id);
            refund_checked(&mut env, id, &cast);
            return_checked(&mut env, &tickets[0], false);
            let v = env.vault();
            assert_eq!(v.counters(), v0.counters(), "the counters never move");
            assert_eq!(v.total_assets - v.open_vault_credits, settled);
            env.pass_close();
            assert_eq!(env.strike().unwrap(), epoch, "nothing holds the strike");
            assert_eq!(env.record(epoch).total_assets, settled, "nor its price");
            // Returned across the strike.
            for t in &tickets[1..] {
                return_checked(&mut env, t, false);
            }
            assert!(!env.exists(&round_address(id)));
        }
        // Paid before the close.
        {
            let mut env = setup();
            let cast = cast(&mut env, 2, 2);
            let lp = env.user(1_000 * USDC);
            let epoch = env.deposit(&lp, 100 * USDC).unwrap();
            let (id, tickets) = fill(&mut env, &cast, 4);
            let r = env.round(id);
            assert_eq!(r.side().unwrap(), Side::BeforeClose);
            assert_eq!(env.vault().open_before_close, 4);
            env.pass_close();
            to_expiry(&mut env, id);
            assert_fails_with(env.strike(), FadeError::StrikeNotClean);
            let settled0 = {
                let v = env.vault();
                v.total_assets - v.open_vault_credits
            };
            expire_checked(&mut env, id);
            let v = env.vault();
            assert_eq!((v.open_before_close, v.open_after_close), (0, 0));
            assert_eq!(
                v.total_assets - v.open_vault_credits,
                settled0 + r.credits,
                "the forfeited credits are a result of the epoch"
            );
            assert_eq!((v.after_close_gain, v.after_close_loss), (0, 0));
            return_checked(&mut env, &tickets[0], false);
            let settled = {
                let v = env.vault();
                v.total_assets - v.open_vault_credits
            };
            assert_eq!(env.strike().unwrap(), epoch);
            assert_eq!(env.record(epoch).total_assets, settled);
            let c = env.vault().counters();
            for t in &tickets[1..] {
                return_checked(&mut env, t, false);
            }
            assert_eq!(env.vault().counters(), c, "returns move no counter");
        }
        // Paid after the close.
        {
            let mut env = setup();
            let cast = cast(&mut env, 1, 2);
            let lp = env.user(1_000 * USDC);
            let epoch = env.deposit(&lp, 100 * USDC).unwrap();
            env.pass_close();
            let (id, tickets) = fill(&mut env, &cast, 3);
            let r = env.round(id);
            assert_eq!(r.side().unwrap(), Side::AfterClose);
            to_expiry(&mut env, id);
            let settled0 = {
                let v = env.vault();
                v.total_assets - v.open_vault_credits
            };
            expire_checked(&mut env, id);
            let v = env.vault();
            assert_eq!(v.after_close_gain, r.credits, "booked after the close");
            assert_eq!(v.strike_assets(), Some(settled0));
            assert_eq!(env.strike().unwrap(), epoch);
            assert_eq!(
                env.record(epoch).total_assets,
                settled0,
                "the forfeiture is left out of the closed epoch's price"
            );
            for t in &tickets {
                return_checked(&mut env, t, false);
            }
        }
        // Paid after the close, then struck and the next epoch live before it
        // expires: its tickets are in that epoch's `before`, so they hold that
        // epoch's strike, and the forfeiture is a result of that epoch, never
        // an after-close gain (its recorded generation is no longer the
        // counters').
        {
            let mut env = setup();
            let cast = cast(&mut env, 1, 2);
            let lp = env.user(1_000 * USDC);
            let epoch = env.deposit(&lp, 100 * USDC).unwrap();
            env.pass_close();
            let (id, tickets) = fill(&mut env, &cast, 3);
            let r = env.round(id);
            assert_eq!(r.side().unwrap(), Side::AfterClose);
            let g = env.vault().generation;
            assert_eq!(r.generation, g);
            assert_eq!(env.strike().unwrap(), epoch);
            // The next deposit makes an epoch live: its roll moves `after`
            // into `before` and starts a generation.
            let next = env.deposit(&lp, 100 * USDC).unwrap();
            assert_ne!(next, epoch);
            let v = env.vault();
            assert_eq!(v.generation, g + 1);
            assert_eq!(
                (v.open_before_close, v.open_after_close),
                (3, 0),
                "the roll moved the round's tickets into before"
            );
            env.pass_close();
            assert_fails_with(env.strike(), FadeError::StrikeNotClean);
            to_expiry(&mut env, id);
            let v0 = env.vault();
            let settled0 = v0.total_assets - v0.open_vault_credits;
            expire_checked(&mut env, id);
            let v = env.vault();
            assert_eq!((v.open_before_close, v.open_after_close), (0, 0));
            assert_eq!(
                (v.after_close_gain, v.after_close_loss),
                (v0.after_close_gain, v0.after_close_loss),
                "no after-close gain for tickets in the epoch's price"
            );
            assert_eq!(
                v.total_assets - v.open_vault_credits,
                settled0 + r.credits,
                "the forfeited credits are a result of the epoch"
            );
            assert_eq!(env.strike().unwrap(), next);
            assert_eq!(
                env.record(next).total_assets,
                settled0 + r.credits,
                "and in its price"
            );
            for t in &tickets {
                return_checked(&mut env, t, false);
            }
        }
    }

    /// Compute units and transaction sizes (Spec 08 §13.1: the round-level
    /// instructions are O(1) in the round's tickets).
    #[test]
    fn compute_units() {
        fn tx_len(env: &Env, ix: &Instruction, signers: &[&Keypair]) -> usize {
            let tx = solana_transaction::Transaction::new_signed_with_payer(
                std::slice::from_ref(ix),
                Some(&signers[0].pubkey()),
                signers,
                env.svm.latest_blockhash(),
            );
            1 + 64 * tx.signatures.len() + tx.message_data().len()
        }
        let mut env = setup();
        let keeper = env.keeper.insecure_clone();
        let cast = cast(&mut env, 1, 2);
        for n in [1usize, 12] {
            let (id, tickets) = unpaid(&mut env, &cast, n);
            to_refund_window(&mut env, id);
            let payer = cast.payers[0].insecure_clone();
            let ix = env.refund_round_ix(&payer.pubkey(), id, &tickets[0]);
            let size = tx_len(&env, &ix, &[&keeper, &payer]);
            let m = env.send(&[ix], &[&keeper, &payer]).unwrap();
            eprintln!(
                "CU refund_round ({n} tickets): {}; {size}-byte transaction",
                m.compute_units_consumed
            );
            assert!(m.compute_units_consumed < 30_000);
            if n > 1 {
                let refund_to = addr(env.round_ticket(&tickets[1]).refund_to);
                env.set_token_state(&refund_to, 2);
                let m = env.return_round_ticket(&tickets[1]).unwrap();
                eprintln!(
                    "CU return_round_ticket (refunded, parked): {}",
                    m.compute_units_consumed
                );
                env.set_token_state(&refund_to, 1);
            }
            let rp = addr(env.round(id).rent_payer);
            let ix = env.return_round_ticket_ix(&keeper.pubkey(), &tickets[0], Some(rp));
            let size = tx_len(&env, &ix, &[&keeper]);
            let m = env.send(&[ix], &[&keeper]).unwrap();
            eprintln!(
                "CU return_round_ticket (refunded{}): {}; {size}-byte transaction",
                if n == 1 { ", closing the round" } else { "" },
                m.compute_units_consumed
            );
            assert!(m.compute_units_consumed < 60_000);
            for t in tickets.iter().skip(2) {
                env.return_round_ticket(t).unwrap();
            }
        }
        for requested in [false, true] {
            let (id, tickets) = fill(&mut env, &cast, 12);
            if requested {
                let close = env.round(id).close_slot;
                at_slot(&mut env, close + 2);
                env.request_round_draw(id).unwrap();
                env.svm.airdrop(&round_vrf_address(id), 1_000_000).unwrap();
            }
            to_expiry(&mut env, id);
            let randomness = env.expiry_request(id);
            let ix = env.expire_round_ix(&keeper.pubkey(), id, &randomness);
            let size = tx_len(&env, &ix, &[&keeper]);
            let m = env.send(&[ix], &[&keeper]).unwrap();
            eprintln!(
                "CU expire_round (12 tickets, {}): {}; {size}-byte transaction",
                if requested {
                    "requested, draining round_vrf"
                } else {
                    "unrequested"
                },
                m.compute_units_consumed
            );
            assert!(m.compute_units_consumed < 30_000);
            let m = env.return_round_ticket(&tickets[0]).unwrap();
            eprintln!(
                "CU return_round_ticket (forfeited): {}",
                m.compute_units_consumed
            );
            assert!(m.compute_units_consumed < 60_000);
            for t in &tickets[1..] {
                env.return_round_ticket(t).unwrap();
            }
        }
    }
}

/// `sweep_round_vrf` (Spec 08 §13.5.8a): the lamports that reach a round's
/// `round_vrf` after its last drain, ORAO's rent refund for a request it
/// fulfils after the round forfeited above all, into the round while it
/// exists, to the caller once it has closed; never while it is `Requested`.
mod sweep_round_vrf {
    use super::settle_round_tickets::{
        at_slot, cast, draw, fill, funded, join_as, mixed, setup, Cast,
    };
    use super::*;
    use fade::events::{RoundClosed, RoundTicketReturned, RoundVrfSwept};
    use fade::state::{Config, RoundStatus};
    use fade_math::orao_layout;
    use litesvm::types::TransactionMetadata;
    use solana_account::Account;
    use solana_address::Address;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_keypair::Keypair;
    use solana_signer::Signer;

    fn rent(env: &Env, len: usize) -> u64 {
        env.svm.minimum_balance_for_rent_exemption(len)
    }

    /// ORAO's refund at fulfilment: the pending request's rent above the
    /// fulfilled account's.
    fn orao_refund(env: &Env) -> u64 {
        rent(env, orao_layout::PENDING_LEN) - rent(env, orao_layout::FULFILLED_LEN)
    }

    fn to_expiry(env: &mut Env, id: u64) {
        let r = env.round(id);
        let now = env.now();
        env.set_time(r.close_slot + r.t_settle_slots + 1, now + 600);
    }

    fn owned_by_fade(env: &Env, address: &Address) -> bool {
        env.svm
            .get_account(address)
            .is_some_and(|a| a.owner == fade_id())
    }

    /// The sponsors of round `id` among the cast's payers and `extra`.
    fn sponsors(env: &Env, cast: &Cast, id: u64, extra: &[Address]) -> Vec<Address> {
        cast.payers
            .iter()
            .map(|p| p.pubkey())
            .chain(extra.iter().copied())
            .filter(|p| env.exists(&sponsorship_address(&round_address(id), p)))
            .collect()
    }

    /// Sends `ix` signed by `caller`, the keeper paying the fee.
    fn send(
        env: &mut Env,
        caller: &Keypair,
        ixs: &[Instruction],
    ) -> Result<TransactionMetadata, Failure> {
        let keeper = env.keeper.insecure_clone();
        env.send(ixs, &[&keeper, caller])
    }

    /// Every account a sweep of round `id` could touch, and what `ix` names.
    fn watched(env: &Env, id: u64, caller: &Address, ix: &Instruction) -> Vec<Address> {
        let mut v = vec![
            *caller,
            env.a.vault,
            env.a.config,
            round_address(id),
            round_vrf_address(id),
        ];
        if owned_by_fade(env, &round_address(id)) {
            v.push(addr(env.round(id).rent_payer));
        }
        for m in &ix.accounts {
            if !v.contains(&m.pubkey) {
                v.push(m.pubkey);
            }
        }
        v
    }

    fn snapshot(env: &Env, addresses: &[Address]) -> Vec<Option<Account>> {
        addresses.iter().map(|a| env.svm.get_account(a)).collect()
    }

    /// `ix` is refused as `check` says, and nothing moved, byte for byte and
    /// lamport for lamport: the fee is the keeper's.
    #[track_caller]
    fn refused_ix(
        env: &mut Env,
        caller: &Keypair,
        ix: Instruction,
        id: u64,
        check: impl Fn(&Failure) -> bool,
    ) {
        let addresses = watched(env, id, &caller.pubkey(), &ix);
        let before = snapshot(env, &addresses);
        let err = send(env, caller, &[ix]).expect_err("refused");
        assert!(check(&err), "{}\n{}", err.err, err.logs.join("\n"));
        assert_eq!(snapshot(env, &addresses), before, "a refusal moves nothing");
    }

    #[track_caller]
    fn refused(env: &mut Env, caller: &Keypair, id: u64, e: FadeError) {
        let ix = env.sweep_round_vrf_ix(&caller.pubkey(), id);
        let code = fade_error(e);
        refused_ix(env, caller, ix, id, |f| f.has_code(code));
    }

    /// Sweeps round `id` as `caller` and checks every effect of §13.5.8a:
    /// `round_vrf` emptied; every lamport it held to the round while the
    /// program owns it (its data untouched), to the caller otherwise (the
    /// address of the closed round untouched); nothing else moved but the
    /// keeper's fee; the event, or none when there was nothing to sweep.
    /// Returns the lamports swept.
    #[track_caller]
    fn sweep_checked(env: &mut Env, caller: &Keypair, id: u64) -> u64 {
        let vrf = round_vrf_address(id);
        let round = round_address(id);
        let held = env.lamports(&vrf);
        let open = owned_by_fade(env, &round);
        let ix = env.sweep_round_vrf_ix(&caller.pubkey(), id);
        let others: Vec<Address> = watched(env, id, &caller.pubkey(), &ix)
            .into_iter()
            .filter(|a| ![vrf, round, caller.pubkey()].contains(a))
            .collect();
        let others0 = snapshot(env, &others);
        let round0 = env.svm.get_account(&round);
        let caller0 = env.lamports(&caller.pubkey());
        let meta =
            send(env, caller, &[ix]).unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
        assert_eq!(env.lamports(&vrf), 0, "round_vrf emptied");
        assert_eq!(snapshot(env, &others), others0, "nothing else moved");
        let round1 = env.svm.get_account(&round);
        if open {
            let (a0, a1) = (round0.unwrap(), round1.unwrap());
            assert_eq!(a1.lamports, a0.lamports + held, "into the round");
            assert_eq!(
                (a1.data, a1.owner),
                (a0.data, a0.owner),
                "the round's state untouched"
            );
            assert_eq!(
                env.lamports(&caller.pubkey()),
                caller0,
                "the caller is not paid"
            );
        } else {
            assert_eq!(round1, round0, "a closed round's address untouched");
            assert_eq!(
                env.lamports(&caller.pubkey()),
                caller0 + held,
                "to the caller"
            );
        }
        let swept = events::<RoundVrfSwept>(&meta);
        if held == 0 {
            assert!(swept.is_empty(), "nothing to sweep emits nothing");
        } else {
            assert_eq!(swept.len(), 1);
            let e = &swept[0];
            assert_eq!(e.version, 1);
            assert_eq!(addr(e.round), round);
            assert_eq!(e.round_id, id);
            assert_eq!(addr(e.to), if open { round } else { caller.pubkey() });
            assert_eq!(e.lamports, held);
            assert_eq!(e.closed, !open);
        }
        held
    }

    /// Returns `tickets` and reclaims `sponsors` of a forfeited or refunded
    /// round in that order, one transaction each, the keeper the caller; the
    /// charges of the returns and the round's close.
    fn finish(
        env: &mut Env,
        tickets: &[Address],
        id: u64,
        sponsors: &[Address],
    ) -> (Vec<u64>, Option<RoundClosed>) {
        let mut charges = Vec::new();
        let mut closed = None;
        for t in tickets {
            let meta = env.return_round_ticket(t).unwrap();
            charges.push(events::<RoundTicketReturned>(&meta)[0].charge);
            closed = closed.or(events::<RoundClosed>(&meta).pop());
        }
        for s in sponsors {
            let meta = env.reclaim(id, s).unwrap();
            closed = closed.or(events::<RoundClosed>(&meta).pop());
        }
        (charges, closed)
    }

    /// A paid round requested and never fulfilled by its expiry: forfeited
    /// with the request's whole pending rent in its draw cost. Returns the
    /// round, its tickets and the pending request.
    fn withheld(env: &mut Env, cast: &Cast, n: usize) -> (u64, Vec<Address>, Address) {
        let (id, tickets) = fill(env, cast, n);
        let close = env.round(id).close_slot;
        at_slot(env, close + 2);
        let (request, _) = env.request_round_draw(id).unwrap();
        to_expiry(env, id);
        env.expire_round(id).unwrap();
        let r = env.round(id);
        assert_eq!(r.status, RoundStatus::Forfeited);
        assert_eq!(
            r.draw_cost,
            r.funded + r.request_share,
            "the pending rent is charged"
        );
        assert_eq!(env.lamports(&round_vrf_address(id)), 0);
        (id, tickets, request)
    }

    /// The case of an earlier review: ORAO fulfils a forfeited round's request
    /// after its expiry, and its refund lands on `round_vrf`. Swept before the
    /// round closes, it joins what the close pays the rent payer; no ticket's
    /// charge changes, and nothing else does: the same round finished on a
    /// fork without the sweep closes with exactly the refund less.
    #[test]
    fn a_late_fulfilment_after_a_forfeiture_is_swept_into_the_round() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 2);
        let (id, tickets, request) = withheld(&mut env, &cast, 4);
        let caller = funded(&mut env);
        // Still pending: nothing to sweep, and ORAO's fulfilment lands after
        // the sweep left `round_vrf` empty.
        assert_eq!(sweep_checked(&mut env, &caller, id), 0);
        env.fulfill(&request, [7u8; 64]);
        assert_eq!(env.lamports(&round_vrf_address(id)), orao_refund(&env));
        let n = tickets.len();
        let (_, closed) = finish(&mut env, &tickets[..n - 1], id, &[]);
        assert!(closed.is_none());
        let sponsors = sponsors(&env, &cast, id, &[]);
        let mut fork = env.fork();
        assert_eq!(sweep_checked(&mut env, &caller, id), orao_refund(&env));
        let (last, closed) = finish(&mut env, &tickets[n - 1..], id, &sponsors);
        let (fork_last, fork_closed) = finish(&mut fork, &tickets[n - 1..], id, &sponsors);
        assert_eq!(last, fork_last, "the sweep changes no charge");
        let r = fork_closed.expect("closed on the fork");
        let closed = closed.expect("closed");
        assert_eq!(closed.rent_payer, r.rent_payer);
        assert_eq!(
            closed.lamports,
            r.lamports + orao_refund(&env),
            "the refund to the rent payer"
        );
        assert!(!env.exists(&round_address(id)));
        assert_eq!(env.lamports(&round_vrf_address(id)), 0, "nothing stranded");
        for s in sponsors.iter().filter(|s| addr(closed.rent_payer) != **s) {
            assert_eq!(env.lamports(s), fork.lamports(s), "the reclaims unchanged");
        }
    }

    /// The same refund landing after the round has closed goes to whoever
    /// sweeps it: nothing on-chain names the tickets or the rent payer any
    /// more. A second sweep finds nothing; lamports sent to the closed
    /// round's own address do not make it open again.
    #[test]
    fn a_late_fulfilment_after_the_close_goes_to_the_caller() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 2);
        let (id, tickets, request) = withheld(&mut env, &cast, 3);
        let sponsors = sponsors(&env, &cast, id, &[]);
        let (_, closed) = finish(&mut env, &tickets, id, &sponsors);
        assert!(closed.is_some());
        assert!(!env.exists(&round_address(id)));
        env.fulfill(&request, [9u8; 64]);
        let stranger = funded(&mut env);
        assert_eq!(sweep_checked(&mut env, &stranger, id), orao_refund(&env));
        assert_eq!(sweep_checked(&mut env, &stranger, id), 0);
        env.svm.airdrop(&round_address(id), 1_000_000).unwrap();
        env.svm.airdrop(&round_vrf_address(id), 2_000_000).unwrap();
        assert_eq!(sweep_checked(&mut env, &stranger, id), 2_000_000);
        assert_eq!(
            env.lamports(&round_address(id)),
            1_000_000,
            "not the sweep's"
        );
    }

    /// While a round is `Requested`, `round_vrf` holds what its first
    /// settlement or its expiry deducts from the draw cost: no sweep, before
    /// or after ORAO's fulfilment, whoever sends it. The first settlement
    /// then drains all of it as before; once `Drawn`, a later transfer is
    /// swept into the round and the round still settles and closes.
    #[test]
    fn a_requested_round_is_never_swept() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 2);
        let (id, tickets) = fill(&mut env, &cast, 4);
        let close = env.round(id).close_slot;
        at_slot(&mut env, close + 2);
        env.request_round_draw(id).unwrap();
        let caller = funded(&mut env);
        refused(&mut env, &caller, id, FadeError::WrongRoundStatus);
        env.svm.airdrop(&round_vrf_address(id), 1_000_000).unwrap();
        refused(&mut env, &caller, id, FadeError::WrongRoundStatus);
        let r = env.round_randomness_with(id, &tickets, mixed);
        env.fulfill_round(id, r);
        refused(&mut env, &caller, id, FadeError::WrongRoundStatus);
        let other = funded(&mut env);
        refused(&mut env, &other, id, FadeError::WrongRoundStatus);
        let refund = env.lamports(&round_vrf_address(id));
        assert_eq!(refund, orao_refund(&env) + 1_000_000);
        env.settle_round(id, &tickets[..1]).unwrap();
        let r = env.round(id);
        assert_eq!(r.status, RoundStatus::Drawn);
        assert_eq!(
            r.draw_cost,
            r.funded + r.request_share - refund.min(r.funded)
        );
        assert_eq!(env.lamports(&round_vrf_address(id)), 0);
        env.svm.airdrop(&round_vrf_address(id), 2_000_000).unwrap();
        assert_eq!(sweep_checked(&mut env, &caller, id), 2_000_000);
        assert_eq!(
            env.round(id).draw_cost,
            r.draw_cost,
            "the draw cost is fixed"
        );
        env.settle_round(id, &tickets[1..]).unwrap();
        let sponsors = sponsors(&env, &cast, id, &[]);
        for s in &sponsors {
            env.reclaim(id, s).unwrap();
        }
        assert!(!env.exists(&round_address(id)), "settled and closed");
    }

    /// A request fulfilled with zero leaves the round `Requested` until its
    /// expiry, which counts ORAO's refund and any transfer as `refund`: the
    /// sweep is refused until then, and finds nothing after.
    #[test]
    fn a_zero_fulfilment_is_left_to_the_expiry() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, tickets) = fill(&mut env, &cast, 2);
        let close = env.round(id).close_slot;
        at_slot(&mut env, close + 2);
        env.request_round_draw(id).unwrap();
        env.fulfill_round(id, [0u8; 64]);
        env.svm.airdrop(&round_vrf_address(id), 100_000).unwrap();
        let caller = funded(&mut env);
        refused(&mut env, &caller, id, FadeError::WrongRoundStatus);
        to_expiry(&mut env, id);
        refused(&mut env, &caller, id, FadeError::WrongRoundStatus);
        env.expire_round(id).unwrap();
        let r = env.round(id);
        let refund = orao_refund(&env) + 100_000;
        assert_eq!(
            r.draw_cost,
            r.funded + r.request_share - refund.min(r.funded)
        );
        assert_eq!(sweep_checked(&mut env, &caller, id), 0);
        let sponsors = sponsors(&env, &cast, id, &[]);
        let (_, closed) = finish(&mut env, &tickets, id, &sponsors);
        assert!(closed.is_some());
    }

    /// Every status but `Requested`: `Accepting`, `Paid`, `Drawn`,
    /// `Refunded` and `Forfeited`. Swept into the round, the lamports join
    /// what its close pays the rent payer; a refund still returns every
    /// ticket exactly what it put in, a request still funds exactly what
    /// ORAO takes, and a forfeiture never requested still charges nothing.
    #[test]
    fn every_other_status_sweeps_into_the_round() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let caller = funded(&mut env);
        let stray = 1_000_000u64;

        // Accepting, then Refunded: one unpaid ticket.
        let id = env.joining_round();
        let beneficiary = env.usdc_account(&Address::new_unique(), 0);
        let t = join_as(
            &mut env,
            &cast.integrators[0],
            cast.shares[0],
            &cast.payers[0],
            &cast.funder,
            beneficiary,
            &coin_flip(),
            500_000,
            0,
        );
        assert_eq!(env.round(id).status, RoundStatus::Accepting);
        env.svm.airdrop(&round_vrf_address(id), stray).unwrap();
        assert_eq!(sweep_checked(&mut env, &caller, id), stray);
        let r = env.round(id);
        at_slot(&mut env, r.refund_from() + r.refund_slots);
        let payer = cast.payers[0].insecure_clone();
        env.refund_round(&payer, id, &t).unwrap();
        assert_eq!(env.round(id).status, RoundStatus::Refunded);
        env.svm.airdrop(&round_vrf_address(id), stray).unwrap();
        assert_eq!(sweep_checked(&mut env, &caller, id), stray);
        let w = env.round_ticket(&t);
        let back = w.prepay + w.settle_share + rent(&env, 291);
        let meta = env.return_round_ticket(&t).unwrap();
        assert_eq!(
            events::<RoundTicketReturned>(&meta)[0].lamports,
            back,
            "the exact return"
        );
        let closed = events::<RoundClosed>(&meta).pop().expect("closed");
        assert_eq!(
            closed.lamports,
            rent(&env, 411) + 2 * stray,
            "the strays to the rent payer"
        );

        // Paid: the request funds what ORAO takes, `round_vrf` empty after it.
        let (id, tickets) = fill(&mut env, &cast, 3);
        assert_eq!(env.round(id).status, RoundStatus::Paid);
        env.svm.airdrop(&round_vrf_address(id), stray).unwrap();
        assert_eq!(sweep_checked(&mut env, &caller, id), stray);
        let close = env.round(id).close_slot;
        at_slot(&mut env, close + 2);
        env.request_round_draw(id).unwrap();
        assert_eq!(
            env.round(id).funded,
            ORAO_FEE + rent(&env, orao_layout::PENDING_LEN)
        );
        assert_eq!(env.lamports(&round_vrf_address(id)), 0);
        let r = env.round_randomness_with(id, &tickets, mixed);
        env.fulfill_round(id, r);
        env.settle_round(id, &tickets).unwrap();
        for s in sponsors(&env, &cast, id, &[]) {
            env.reclaim(id, &s).unwrap();
        }
        assert!(!env.exists(&round_address(id)));

        // Forfeited, never requested: nothing charged.
        let (id, tickets) = fill(&mut env, &cast, 3);
        to_expiry(&mut env, id);
        env.expire_round(id).unwrap();
        assert_eq!(env.round(id).status, RoundStatus::Forfeited);
        env.svm.airdrop(&round_vrf_address(id), stray).unwrap();
        assert_eq!(sweep_checked(&mut env, &caller, id), stray);
        assert_eq!(env.round(id).draw_cost, 0);
        let sponsors = sponsors(&env, &cast, id, &[]);
        let (charges, closed) = finish(&mut env, &tickets, id, &sponsors);
        assert!(charges.iter().all(|c| *c == 0));
        assert!(closed.is_some());

        // Drawn, through `draw`.
        let (id, tickets) = fill(&mut env, &cast, 2);
        draw(&mut env, id, &tickets, mixed);
        env.settle_round(id, &tickets[..1]).unwrap();
        env.svm.airdrop(&round_vrf_address(id), stray).unwrap();
        assert_eq!(sweep_checked(&mut env, &caller, id), stray);
    }

    /// Only a round the vault created: id 0, `next_round_id` and beyond are
    /// refused (`WrongRound`), whatever their `round_vrf` holds. Once a join
    /// creates the next round, its `round_vrf` sweeps into it.
    #[test]
    fn a_round_the_vault_never_created_is_refused() {
        let mut env = setup();
        let caller = funded(&mut env);
        let next = env.vault().next_round_id;
        for id in [0, next, next + 1, u64::MAX] {
            env.svm.airdrop(&round_vrf_address(id), 1_000_000).unwrap();
            refused(&mut env, &caller, id, FadeError::WrongRound);
        }
        let cast = cast(&mut env, 1, 1);
        let beneficiary = env.usdc_account(&Address::new_unique(), 0);
        join_as(
            &mut env,
            &cast.integrators[0],
            cast.shares[0],
            &cast.payers[0],
            &cast.funder,
            beneficiary,
            &coin_flip(),
            500_000,
            0,
        );
        assert_eq!(env.vault().next_round_id, next + 1);
        assert_eq!(sweep_checked(&mut env, &caller, next), 1_000_000);
        refused(&mut env, &caller, next + 1, FadeError::WrongRound);
    }

    /// Every account is the derived one: another round's address or
    /// `round_vrf`, or a vault elsewhere, is refused by its seeds; a remaining
    /// account by `RemainingAccounts`; a round account at the address whose
    /// stored id is another round's by `WrongRound`. Nothing moves.
    #[test]
    fn the_accounts_are_checked() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (a, _) = fill(&mut env, &cast, 2);
        let close = env.round(a).close_slot;
        at_slot(&mut env, close);
        let (b, _) = fill(&mut env, &cast, 2);
        assert_ne!(a, b);
        for id in [a, b] {
            env.svm.airdrop(&round_vrf_address(id), 1_000_000).unwrap();
        }
        let caller = funded(&mut env);
        let with = |env: &Env, i: usize, to: Address| {
            let mut ix = env.sweep_round_vrf_ix(&caller.pubkey(), a);
            ix.accounts[i].pubkey = to;
            ix
        };
        // caller, vault, round, round_vrf, system_program, event_authority, program.
        let ix = with(&env, 2, round_address(b));
        refused_ix(&mut env, &caller, ix, a, |f| f.has_code(2006));
        let ix = with(&env, 3, round_vrf_address(b));
        refused_ix(&mut env, &caller, ix, a, |f| f.has_code(2006));
        let copy = Address::new_unique();
        let vault = env.svm.get_account(&env.a.vault).unwrap();
        env.svm.set_account(copy, vault).unwrap();
        let ix = with(&env, 1, copy);
        refused_ix(&mut env, &caller, ix, a, |f| f.has_code(2006));
        let mut ix = env.sweep_round_vrf_ix(&caller.pubkey(), a);
        ix.accounts
            .push(AccountMeta::new(round_vrf_address(b), false));
        refused_ix(&mut env, &caller, ix, a, |f| {
            f.has_code(fade_error(FadeError::RemainingAccounts))
        });
        env.set_round(a, None, |r| r.id = b);
        refused(&mut env, &caller, a, FadeError::WrongRound);
    }

    /// No pause stops a sweep: it ends nothing and opens nothing.
    #[test]
    fn a_sweep_is_never_paused() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, tickets, request) = withheld(&mut env, &cast, 2);
        let guardian = env.guardian.insecure_clone();
        env.set_pause_flags(&guardian, Config::PAUSE_ALL, None)
            .unwrap();
        assert_eq!(env.config().pause_flags, Config::PAUSE_ALL);
        env.fulfill(&request, [3u8; 64]);
        let caller = funded(&mut env);
        assert_eq!(sweep_checked(&mut env, &caller, id), orao_refund(&env));
        let sponsors = sponsors(&env, &cast, id, &[]);
        finish(&mut env, &tickets, id, &sponsors);
        env.svm.airdrop(&round_vrf_address(id), 1_500_000).unwrap();
        assert_eq!(sweep_checked(&mut env, &caller, id), 1_500_000);
    }

    /// The keeper's packing: the sweep ahead of the last return and reclaim,
    /// in one transaction, reaches the round and so the rent payer; after
    /// them in the same transaction, the round has closed and the sweep pays
    /// its caller. Neither order fails the closing work.
    #[test]
    fn the_order_in_one_transaction_decides_the_destination() {
        for sweep_first in [true, false] {
            let mut env = setup();
            let cast = cast(&mut env, 1, 2);
            let (id, tickets, request) = withheld(&mut env, &cast, 2);
            env.fulfill(&request, [5u8; 64]);
            let refund = orao_refund(&env);
            let sponsors = sponsors(&env, &cast, id, &[]);
            let keeper = env.keeper.insecure_clone();
            let rent_payer = addr(env.round(id).rent_payer);
            let mut work: Vec<Instruction> = tickets
                .iter()
                .map(|t| env.return_round_ticket_ix(&keeper.pubkey(), t, Some(rent_payer)))
                .collect();
            for s in &sponsors {
                let round = round_address(id);
                let record = sponsorship_address(&round, s);
                work.push(env.reclaim_ix(&keeper.pubkey(), &round, &record, s, Some(rent_payer)));
            }
            let caller = funded(&mut env);
            let sweep = env.sweep_round_vrf_ix(&caller.pubkey(), id);
            let ixs: Vec<Instruction> = if sweep_first {
                std::iter::once(sweep).chain(work).collect()
            } else {
                work.into_iter().chain(std::iter::once(sweep)).collect()
            };
            let caller0 = env.lamports(&caller.pubkey());
            let mut fork = env.fork();
            let meta = send(&mut env, &caller, &ixs)
                .unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));
            let closed = events::<RoundClosed>(&meta).pop().expect("closed");
            let swept = events::<RoundVrfSwept>(&meta).pop().expect("swept");
            assert_eq!(swept.lamports, refund);
            assert_eq!(swept.closed, !sweep_first);
            // The same closing work alone, on a fork.
            let n = ixs.len();
            let alone: Vec<Instruction> = if sweep_first {
                ixs[1..].to_vec()
            } else {
                ixs[..n - 1].to_vec()
            };
            let fork_meta = fork.send(&alone, &[&keeper]).unwrap();
            let fork_closed = events::<RoundClosed>(&fork_meta).pop().unwrap();
            if sweep_first {
                assert_eq!(closed.lamports, fork_closed.lamports + refund);
                assert_eq!(env.lamports(&caller.pubkey()), caller0);
            } else {
                assert_eq!(closed.lamports, fork_closed.lamports);
                assert_eq!(env.lamports(&caller.pubkey()), caller0 + refund);
            }
            assert_eq!(env.lamports(&round_vrf_address(id)), 0);
        }
    }

    /// Compute units: nothing to sweep, into an open round, to the caller of
    /// a closed one (Spec 08 §13.5.8a).
    #[test]
    fn compute_units() {
        fn tx_len(env: &Env, ix: &Instruction, signers: &[&Keypair]) -> usize {
            let tx = solana_transaction::Transaction::new_signed_with_payer(
                std::slice::from_ref(ix),
                Some(&signers[0].pubkey()),
                signers,
                env.svm.latest_blockhash(),
            );
            1 + 64 * tx.signatures.len() + tx.message_data().len()
        }
        let mut env = setup();
        let cast = cast(&mut env, 1, 2);
        let (id, tickets, request) = withheld(&mut env, &cast, 2);
        let keeper = env.keeper.insecure_clone();
        let measure = |env: &mut Env, what: &str| {
            let ix = env.sweep_round_vrf_ix(&keeper.pubkey(), id);
            let size = tx_len(env, &ix, &[&keeper]);
            let m = env.send(&[ix], &[&keeper]).unwrap();
            eprintln!(
                "CU sweep_round_vrf ({what}): {}; {size}-byte transaction",
                m.compute_units_consumed
            );
            assert!(m.compute_units_consumed < 25_000);
        };
        measure(&mut env, "nothing to sweep");
        env.fulfill(&request, [1u8; 64]);
        measure(&mut env, "into the round");
        let sponsors = sponsors(&env, &cast, id, &[]);
        finish(&mut env, &tickets, id, &sponsors);
        env.svm.airdrop(&round_vrf_address(id), 1_000_000).unwrap();
        measure(&mut env, "a closed round, to the caller");
    }
}

/// `claim_shares` (Spec 08 §13.5.12): the protocol's
/// and the integrators' shares of beacon tickets, held from the join and
/// claimable from settlement or forfeiture, delivered to their pinned owner.
mod claim_shares {
    use super::settle_round_tickets::{
        at_slot, cast, draw, fill, funded, join_as, mixed, setup, vault_slack, Cast,
    };
    use super::*;
    use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
    use fade::events::SharesClaimed;
    use fade::state::{Integrator, RoundStatus};
    use litesvm::types::TransactionMetadata;
    use solana_account::Account;
    use solana_address::Address;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_keypair::Keypair;
    use solana_signer::Signer;
    use std::collections::BTreeMap;

    fn ser<T: AccountSerialize>(x: &T) -> Vec<u8> {
        let mut d = Vec::new();
        x.try_serialize(&mut d).unwrap();
        d
    }

    fn authorities(cast: &Cast) -> Vec<Address> {
        cast.integrators.iter().map(|k| k.pubkey()).collect()
    }

    /// The accounts a claim for `who` names: the protocol's (`None`), to the
    /// treasury, or the integrator's with that authority, to its share account.
    fn accounts_of(env: &Env, who: Option<&Address>) -> (Option<Address>, Address) {
        match who {
            Some(a) => (
                Some(env.integrator_address(a)),
                addr(env.integrator(a).share_account),
            ),
            None => (None, addr(env.config().protocol_treasury)),
        }
    }

    /// The protocol's shares of `tickets` and each integrator's (by record),
    /// read from the tickets before they settle or return.
    fn shares_of(env: &Env, tickets: &[Address]) -> (u64, BTreeMap<Address, u64>) {
        let mut protocol = 0;
        let mut apps = BTreeMap::new();
        for t in tickets {
            let w = env.round_ticket(t);
            protocol += w.protocol_share;
            *apps.entry(addr(w.integrator)).or_insert(0) += w.app_share;
        }
        (protocol, apps)
    }

    fn send(
        env: &mut Env,
        caller: &Keypair,
        ix: Instruction,
    ) -> Result<TransactionMetadata, Failure> {
        let keeper = env.keeper.insecure_clone();
        env.send(&[ix], &[&keeper, caller])
    }

    /// `ix` is refused with `code` and nothing it names moved, byte for byte
    /// and lamport for lamport: the fee is the keeper's.
    #[track_caller]
    fn refused_ix(env: &mut Env, caller: &Keypair, ix: Instruction, code: u32) {
        let mut addresses = vec![
            env.a.vault,
            env.a.vault_usdc,
            env.a.payout_escrow,
            env.a.config,
        ];
        for m in &ix.accounts {
            if !addresses.contains(&m.pubkey) {
                addresses.push(m.pubkey);
            }
        }
        let before: Vec<Option<Account>> =
            addresses.iter().map(|a| env.svm.get_account(a)).collect();
        let err = send(env, caller, ix).expect_err("refused");
        assert!(err.has_code(code), "{}\n{}", err.err, err.logs.join("\n"));
        let after: Vec<Option<Account>> =
            addresses.iter().map(|a| env.svm.get_account(a)).collect();
        assert_eq!(after, before, "a refusal moves nothing");
    }

    /// The claim for `who`, to its stored destination, is refused with `e`.
    #[track_caller]
    fn refused(env: &mut Env, who: Option<&Address>, e: FadeError) {
        let caller = funded(env);
        let (integrator, destination) = accounts_of(env, who);
        let ix = env.claim_shares_ix(&caller.pubkey(), integrator, &destination);
        refused_ix(env, &caller, ix, fade_error(e));
    }

    /// The claim for `who` to `destination` is refused with `e`.
    #[track_caller]
    fn refused_to(env: &mut Env, who: Option<&Address>, destination: Address, e: FadeError) {
        let caller = funded(env);
        let (integrator, _) = accounts_of(env, who);
        let ix = env.claim_shares_ix(&caller.pubkey(), integrator, &destination);
        refused_ix(env, &caller, ix, fade_error(e));
    }

    #[track_caller]
    fn nothing_to_claim(env: &mut Env, authorities: &[Address]) {
        refused(env, None, FadeError::NothingToClaim);
        for a in authorities {
            refused(env, Some(a), FadeError::NothingToClaim);
        }
    }

    /// Claims for `who`, sent by a stranger (the destination is pinned, so
    /// anyone may push a claim), and checks every effect of §13.5.12: the
    /// whole ledger from `vault_usdc` to the stored destination, the ledger
    /// zeroed, `app_shares_owed` reduced for an integrator, nothing else of
    /// the vault or the record changed, the vault identity and the settled
    /// price where they were, no lamport moved, the event. Returns the amount.
    #[track_caller]
    fn claim_checked(env: &mut Env, who: Option<&Address>) -> u64 {
        let caller = funded(env);
        let (integrator, destination) = accounts_of(env, who);
        let v0 = env.vault();
        let i0: Option<Integrator> = who.map(|a| env.integrator(a));
        let amount = match &i0 {
            Some(i) => i.app_shares_accrued,
            None => v0.protocol_shares_accrued,
        };
        assert!(amount > 0, "a claim with something to claim");
        let slack0 = vault_slack(env);
        let price0 = v0.settled_price();
        let usdc0 = env.balance(&env.a.vault_usdc);
        let escrow0 = env.balance(&env.a.payout_escrow);
        let dest0 = env.balance(&destination);
        let mut watched = vec![
            caller.pubkey(),
            env.a.vault,
            env.a.vault_usdc,
            env.a.config,
            destination,
        ];
        watched.extend(integrator);
        let lamports0: Vec<u64> = watched.iter().map(|a| env.lamports(a)).collect();

        let ix = env.claim_shares_ix(&caller.pubkey(), integrator, &destination);
        let meta =
            send(env, &caller, ix).unwrap_or_else(|f| panic!("{}\n{}", f.err, f.logs.join("\n")));

        let mut ev = v0.clone();
        match &i0 {
            Some(_) => ev.app_shares_owed -= amount,
            None => ev.protocol_shares_accrued = 0,
        }
        let v = env.vault();
        assert_eq!(ser(&v), ser(&ev), "the vault's books, field by field");
        assert_eq!(v.settled_price(), price0, "a claim is no result");
        assert_eq!(vault_slack(env), slack0, "the vault identity, to the unit");
        assert_eq!(env.balance(&env.a.vault_usdc), usdc0 - amount);
        assert_eq!(env.balance(&destination), dest0 + amount);
        assert_eq!(env.balance(&env.a.payout_escrow), escrow0);
        if let (Some(a), Some(mut ei)) = (who, i0) {
            ei.app_shares_accrued = 0;
            assert_eq!(
                ser(&env.integrator(a)),
                ser(&ei),
                "the record: its ledger alone"
            );
        }
        for (i, a) in watched.iter().enumerate() {
            assert_eq!(env.lamports(a), lamports0[i], "no lamport moves: {a}");
        }

        let e = events::<SharesClaimed>(&meta);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].version, 1);
        assert_eq!(
            addr(e[0].integrator),
            integrator.unwrap_or_default(),
            "the integrator's record, the default key for the protocol"
        );
        assert_eq!(addr(e[0].destination), destination);
        assert_eq!(e[0].amount, amount);
        amount
    }

    /// The integrator signs `set_share_account` to `share`.
    fn move_share_account(env: &mut Env, authority: &Keypair, share: Address) {
        let ix = Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::SetShareAccount {
                    integrator_authority: pk(authority.pubkey()),
                    config: pk(env.a.config),
                    integrator: pk(env.integrator_address(&authority.pubkey())),
                    share_account: pk(share),
                    event_authority: pk(env.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::SetShareAccount {}.data(),
        };
        send(env, authority, ix).unwrap();
    }

    /// A round of `n` tickets, paid, drawn with winners and losers, and
    /// settled in one batch.
    fn settled(env: &mut Env, cast: &Cast, n: usize) -> Vec<Address> {
        let (id, tickets) = fill(env, cast, n);
        draw(env, id, &tickets, mixed);
        env.settle_round(id, &tickets).unwrap();
        tickets
    }

    /// Nothing is claimable at the join or at the draw; each settlement makes
    /// exactly its tickets' shares claimable, the protocol's on the vault and
    /// each app share on its integrator; claims pay all of it and nothing
    /// more (invariant 11), across two batches of one round mixing three
    /// integrators, two payers and two payout tables.
    #[test]
    fn settlement_makes_shares_claimable() {
        let mut env = setup();
        let cast = cast(&mut env, 3, 2);
        let au = authorities(&cast);
        let treasury = addr(env.config().protocol_treasury);
        let treasury0 = env.balance(&treasury);
        let (id, tickets) = fill(&mut env, &cast, 7);
        let (all_protocol, all_apps) = shares_of(&env, &tickets);
        assert!(all_protocol > 0 && all_apps.values().all(|s| *s > 0));
        assert_eq!(
            env.vault().beacon_shares_held,
            all_protocol + all_apps.values().sum::<u64>(),
            "held, not owed"
        );
        nothing_to_claim(&mut env, &au);
        draw(&mut env, id, &tickets, mixed);
        nothing_to_claim(&mut env, &au);

        for batch in [&tickets[..3], &tickets[3..]] {
            let (protocol, apps) = shares_of(&env, batch);
            env.settle_round(id, batch).unwrap();
            assert_eq!(env.vault().protocol_shares_accrued, protocol);
            assert_eq!(claim_checked(&mut env, None), protocol);
            for a in &au {
                let want = apps.get(&env.integrator_address(a)).copied().unwrap_or(0);
                assert_eq!(env.integrator(a).app_shares_accrued, want);
                if want == 0 {
                    refused(&mut env, Some(a), FadeError::NothingToClaim);
                } else {
                    assert_eq!(claim_checked(&mut env, Some(a)), want);
                }
            }
            nothing_to_claim(&mut env, &au);
        }
        let v = env.vault();
        assert_eq!(
            (
                v.beacon_shares_held,
                v.protocol_shares_accrued,
                v.app_shares_owed
            ),
            (0, 0, 0)
        );
        assert_eq!(env.balance(&treasury) - treasury0, all_protocol);
        for (k, a) in au.iter().enumerate() {
            assert_eq!(
                env.balance(&cast.shares[k]),
                all_apps[&env.integrator_address(a)],
                "an integrator receives exactly its tickets' app shares"
            );
        }
    }

    /// A refund makes nothing claimable: each ticket gets its whole price
    /// back, shares included. A forfeiture makes the protocol's shares
    /// claimable at the expiry and each app share at its ticket's return.
    #[test]
    fn a_forfeiture_makes_shares_claimable_and_a_refund_does_not() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 1);
        let au = authorities(&cast);

        let id = env.joining_round();
        let mut tickets = Vec::new();
        for k in 0..2 {
            let beneficiary = env.usdc_account(&Address::new_unique(), 0);
            tickets.push(join_as(
                &mut env,
                &cast.integrators[k],
                cast.shares[k],
                &cast.payers[0],
                &cast.funder,
                beneficiary,
                &coin_flip(),
                500_000,
                0,
            ));
        }
        let r = env.round(id);
        assert_eq!(r.status, RoundStatus::Accepting);
        at_slot(&mut env, r.first_slot + r.refund_slots);
        env.refund_round(&cast.payers[0], id, &tickets[0]).unwrap();
        nothing_to_claim(&mut env, &au);
        for t in &tickets {
            env.return_round_ticket(t).unwrap();
            nothing_to_claim(&mut env, &au);
        }
        let v = env.vault();
        assert_eq!(
            (
                v.beacon_shares_held,
                v.protocol_shares_accrued,
                v.app_shares_owed
            ),
            (0, 0, 0)
        );

        let (id, tickets) = fill(&mut env, &cast, 4);
        let (protocol, apps) = shares_of(&env, &tickets);
        let r = env.round(id);
        assert_eq!(r.protocol_shares, protocol);
        let now = env.now();
        env.set_time(r.close_slot + r.t_settle_slots + 1, now + 600);
        env.expire_round(id).unwrap();
        assert_eq!(env.round(id).status, RoundStatus::Forfeited);
        for a in &au {
            refused(&mut env, Some(a), FadeError::NothingToClaim);
        }
        assert_eq!(claim_checked(&mut env, None), protocol);
        // Ticket 0 is integrator 0's: its return makes its app share, and
        // nobody else's, claimable.
        let first = env.round_ticket(&tickets[0]).app_share;
        env.return_round_ticket(&tickets[0]).unwrap();
        refused(&mut env, Some(&au[1]), FadeError::NothingToClaim);
        assert_eq!(claim_checked(&mut env, Some(&au[0])), first);
        for t in &tickets[1..] {
            env.return_round_ticket(t).unwrap();
        }
        let i0 = env.integrator_address(&au[0]);
        assert_eq!(claim_checked(&mut env, Some(&au[0])), apps[&i0] - first);
        let i1 = env.integrator_address(&au[1]);
        assert_eq!(claim_checked(&mut env, Some(&au[1])), apps[&i1]);
        nothing_to_claim(&mut env, &au);
    }

    /// Nothing is pushed at settlement, so a share account that cannot
    /// receive (frozen, closed) delays its owner's claim and nothing else:
    /// the other integrators and the protocol claim, later rounds join and
    /// settle, and the owner's ledger keeps growing until its account can
    /// receive or it names another one. The same for the treasury.
    #[test]
    fn an_unusable_share_account_delays_only_its_owner() {
        let mut env = setup();
        let cast = cast(&mut env, 3, 1);
        let au = authorities(&cast);
        let treasury = addr(env.config().protocol_treasury);
        let mint = env.a.usdc_mint;
        let first = settled_with_shares(&mut env, &cast, 6);

        env.set_token_state(&cast.shares[0], 2);
        let closed = Account {
            lamports: 1_000_000,
            data: vec![],
            owner: system_id(),
            executable: false,
            rent_epoch: 0,
        };
        env.svm.set_account(cast.shares[1], closed).unwrap();
        env.set_token_state(&treasury, 2);
        refused(&mut env, Some(&au[0]), FadeError::DestinationUnusable);
        refused(&mut env, Some(&au[1]), FadeError::DestinationUnusable);
        refused(&mut env, None, FadeError::DestinationUnusable);
        let i2 = env.integrator_address(&au[2]);
        assert_eq!(claim_checked(&mut env, Some(&au[2])), first.1[&i2]);

        // A later round joins and settles as if nothing were wrong.
        let second = settled_with_shares(&mut env, &cast, 6);
        let i0 = env.integrator_address(&au[0]);
        let i1 = env.integrator_address(&au[1]);
        assert_eq!(
            env.integrator(&au[0]).app_shares_accrued,
            first.1[&i0] + second.1[&i0]
        );
        assert_eq!(claim_checked(&mut env, Some(&au[2])), second.1[&i2]);

        // The treasury can receive again: everything both rounds owed it.
        env.set_token_state(&treasury, 1);
        assert_eq!(claim_checked(&mut env, None), first.0 + second.0);
        // Integrator 0 names another account: the frozen one is no longer
        // its destination, the new one receives both rounds' shares.
        let fresh = env.usdc_account(&au[0], 0);
        move_share_account(&mut env, &cast.integrators[0], fresh);
        refused_to(
            &mut env,
            Some(&au[0]),
            cast.shares[0],
            FadeError::ShareAccountMismatch,
        );
        assert_eq!(
            claim_checked(&mut env, Some(&au[0])),
            first.1[&i0] + second.1[&i0]
        );
        // Integrator 1's account exists again.
        fade_testkit::token::write_token_account(&mut env.svm, cast.shares[1], &mint, &au[1], 0);
        assert_eq!(
            claim_checked(&mut env, Some(&au[1])),
            first.1[&i1] + second.1[&i1]
        );
        nothing_to_claim(&mut env, &au);
    }

    /// `settled`, returning the shares its tickets held.
    fn settled_with_shares(env: &mut Env, cast: &Cast, n: usize) -> (u64, BTreeMap<Address, u64>) {
        let (id, tickets) = fill(env, cast, n);
        let shares = shares_of(env, &tickets);
        draw(env, id, &tickets, mixed);
        env.settle_round(id, &tickets).unwrap();
        shares
    }

    /// Every check in order, each refusal moving nothing: Anchor's account
    /// constraints (the record at its seeds and owned by Fade, `vault_usdc`
    /// at its seeds, the mint), then no remaining accounts, the pinned
    /// destination, something to claim, and a destination that can receive.
    #[test]
    fn claim_checks_in_order() {
        let mut env = setup();
        let cast = cast(&mut env, 2, 1);
        let au = authorities(&cast);
        let treasury = addr(env.config().protocol_treasury);
        settled(&mut env, &cast, 4);
        let i0 = env.integrator_address(&au[0]);
        let caller = funded(&mut env);

        // The integrator's record: a copy elsewhere, even owned by Fade, is
        // not at its seeds; one not owned by Fade is not a record.
        let record = env.svm.get_account(&i0).unwrap();
        let copy = Address::new_unique();
        env.svm.set_account(copy, record.clone()).unwrap();
        let ix = env.claim_shares_ix(&caller.pubkey(), Some(copy), &cast.shares[0]);
        refused_ix(&mut env, &caller, ix, 2006); // ConstraintSeeds
        let foreign = Address::new_unique();
        let mut not_fade = record;
        not_fade.owner = system_id();
        env.svm.set_account(foreign, not_fade).unwrap();
        let ix = env.claim_shares_ix(&caller.pubkey(), Some(foreign), &cast.shares[0]);
        refused_ix(&mut env, &caller, ix, 3007); // AccountOwnedByWrongProgram
                                                 // `vault_usdc` at its seeds; the configured mint.
        let mut ix = env.claim_shares_ix(&caller.pubkey(), None, &treasury);
        ix.accounts[5].pubkey = env.a.payout_escrow;
        refused_ix(&mut env, &caller, ix, 2006);
        let mut ix = env.claim_shares_ix(&caller.pubkey(), None, &treasury);
        ix.accounts[7].pubkey = env.a.share_mint;
        refused_ix(&mut env, &caller, ix, fade_error(FadeError::WrongMint));

        // No remaining accounts.
        let mut ix = env.claim_shares_ix(&caller.pubkey(), None, &treasury);
        ix.accounts
            .push(AccountMeta::new_readonly(Address::new_unique(), false));
        refused_ix(
            &mut env,
            &caller,
            ix,
            fade_error(FadeError::RemainingAccounts),
        );

        // The destination is pinned: the treasury for the protocol, the
        // stored share account for an integrator, never one for the other.
        refused_to(&mut env, None, cast.shares[0], FadeError::TreasuryMismatch);
        refused_to(
            &mut env,
            Some(&au[0]),
            treasury,
            FadeError::ShareAccountMismatch,
        );
        refused_to(
            &mut env,
            Some(&au[0]),
            cast.shares[1],
            FadeError::ShareAccountMismatch,
        );

        // Something to claim comes before the destination's state, and after
        // the pinning.
        claim_checked(&mut env, Some(&au[0]));
        env.set_token_state(&cast.shares[0], 2);
        refused(&mut env, Some(&au[0]), FadeError::NothingToClaim);
        refused_to(
            &mut env,
            Some(&au[0]),
            treasury,
            FadeError::ShareAccountMismatch,
        );
        env.set_token_state(&cast.shares[0], 1);

        // A destination that cannot receive: uninitialised, of another mint,
        // or `vault_usdc` itself, which would take the amount off the books
        // and leave it in the vault counted by nothing.
        let mint = env.a.usdc_mint;
        let share_mint = env.a.share_mint;
        env.set_token_state(&cast.shares[1], 0);
        refused(&mut env, Some(&au[1]), FadeError::DestinationUnusable);
        fade_testkit::token::write_token_account(
            &mut env.svm,
            cast.shares[1],
            &share_mint,
            &au[1],
            0,
        );
        refused(&mut env, Some(&au[1]), FadeError::DestinationUnusable);
        fade_testkit::token::write_token_account(&mut env.svm, cast.shares[1], &mint, &au[1], 0);
        let vault_usdc = env.a.vault_usdc;
        move_share_account(&mut env, &cast.integrators[1], vault_usdc);
        refused(&mut env, Some(&au[1]), FadeError::DestinationUnusable);
        move_share_account(&mut env, &cast.integrators[1], cast.shares[1]);
        claim_checked(&mut env, Some(&au[1]));
        claim_checked(&mut env, None);
        nothing_to_claim(&mut env, &au);
    }

    /// Never paused: every pause flag and the integrator's own pause leave
    /// both claims open (Technical Specification §5, Custody 2).
    #[test]
    fn claims_are_never_paused() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        settled(&mut env, &cast, 3);
        let guardian = env.guardian.insecure_clone();
        let paused = env.integrator_address(&cast.integrators[0].pubkey());
        env.set_pause_flags(&guardian, Config::PAUSE_ALL, Some((paused, true)))
            .unwrap();
        assert!(env.read::<Integrator>(&paused).paused);
        claim_checked(&mut env, None);
        claim_checked(&mut env, Some(&cast.integrators[0].pubkey()));
        assert_eq!(env.config().pause_flags, Config::PAUSE_ALL);
    }

    #[test]
    fn compute_units() {
        let mut env = setup();
        let cast = cast(&mut env, 1, 1);
        settled(&mut env, &cast, 3);
        let keeper = env.keeper.insecure_clone();
        let au = authorities(&cast);
        for who in [None, Some(&au[0])] {
            let (integrator, destination) = accounts_of(&env, who);
            let ix = env.claim_shares_ix(&keeper.pubkey(), integrator, &destination);
            let tx = solana_transaction::Transaction::new_signed_with_payer(
                std::slice::from_ref(&ix),
                Some(&keeper.pubkey()),
                &[&keeper],
                env.svm.latest_blockhash(),
            );
            let size = 1 + 64 * tx.signatures.len() + tx.message_data().len();
            let m = env.send(&[ix], &[&keeper]).unwrap();
            eprintln!(
                "CU claim_shares ({}): {}; {size}-byte transaction",
                if who.is_some() {
                    "integrator"
                } else {
                    "protocol"
                },
                m.compute_units_consumed
            );
            assert!(m.compute_units_consumed < 30_000);
        }
    }
}
