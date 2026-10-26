//! `migrate_config` (Spec 08 §13.5.13) against the devnet binary, the only
//! build that carries it: a version-1 `Config` as the live devnet deployment
//! holds it, migrated in place. Needs `target/devnet/fade.so`, which
//! `pnpm build:sbf` builds alongside the mainnet binary. The gate
//! (`scripts/verify.sh`) checks that binary is present and current and sets
//! `FADE_REQUIRE_DEVNET_BINARY`, so there a missing binary fails these tests;
//! elsewhere (a bare `cargo test` before any SBF build) they say they skip.
//!
//! The byte transformation itself is unit-tested in every build
//! (`instructions::migrate::tests`).

use anchor_lang::{AccountDeserialize, AccountSerialize, Discriminator};
use fade::state::{Config, RiskParams, Vault};
use fade_testkit::upgradeable;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;

const DEVNET_PROGRAM: &str = "GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt";

fn program() -> Address {
    Address::from_str(DEVNET_PROGRAM).unwrap()
}

fn pda(seeds: &[&[u8]]) -> Address {
    Address::find_program_address(seeds, &program()).0
}

fn binary(build: &str, name: &str) -> String {
    let dir = std::env::var("FADE_ROOT").unwrap_or_else(|_| {
        format!("{}/../..", env!("CARGO_MANIFEST_DIR")) // programs/fade → repository root
    });
    format!("{dir}/target/{build}/{name}.so")
}

/// A LiteSVM with the devnet binary loaded and its upgrade authority set, or
/// `None` when the binary is absent and the gate does not require it.
fn devnet_svm(authority: &Keypair) -> Option<LiteSVM> {
    let so = binary("devnet", "fade");
    if !std::path::Path::new(&so).exists() {
        assert!(
            std::env::var_os("FADE_REQUIRE_DEVNET_BINARY").is_none(),
            "{so} is missing: run pnpm build:sbf"
        );
        eprintln!("skipped: {so} is missing (pnpm build:sbf builds it)");
        return None;
    }
    // The mainnet feature set, as every other test: under the devnet fixture
    // LiteSVM 0.16 cannot create the VM for any instruction ("Invalid memory
    // region"), a harness limit that says nothing about the program.
    let mut svm = LiteSVM::new().with_feature_set(fade_testkit::mainnet_feature_set());
    svm.add_program_from_file(program(), so).unwrap();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    upgradeable::set_upgrade_authority(&mut svm, &program(), &authority.pubkey());
    Some(svm)
}

fn live_params() -> RiskParams {
    let mut live = RiskParams::SPEC;
    live.min_price = 100_000;
    live.epoch_length_seconds = 120;
    live
}

/// The version-1 `RiskParams`: today's, without the six beacon fields.
fn v1_params(p: &RiskParams) -> Vec<u8> {
    let mut v = Vec::new();
    anchor_lang::AnchorSerialize::serialize(p, &mut v).unwrap();
    v.truncate(v.len() - 48);
    v
}

fn v1_config(council: &Address, params: &RiskParams) -> Vec<u8> {
    let mut d = Config::DISCRIMINATOR.to_vec();
    let bump = Address::find_program_address(&[fade::CONFIG_SEED], &program()).1;
    d.extend_from_slice(&[1, bump, 255]);
    for k in [
        council,
        council,
        &Address::new_unique(),
        &Address::new_unique(),
    ] {
        d.extend_from_slice(k.as_ref());
    }
    d.push(0);
    d.extend_from_slice(&v1_params(params));
    d.push(0);
    d.extend_from_slice(&0i64.to_le_bytes());
    d.extend_from_slice(&v1_params(params));
    d.extend_from_slice(Address::new_unique().as_ref());
    d.extend_from_slice(&[0; 128]);
    assert_eq!(d.len(), 695);
    d
}

fn vault_account(next_round_id: u64) -> Vec<u8> {
    let bump = Address::find_program_address(&[fade::VAULT_SEED], &program()).1;
    let vault = Vault {
        version: 1,
        bump,
        total_assets: 1_000_000_000,
        total_shares: 1_000_000_000_000,
        total_reserved_liability: 0,
        open_vault_credits: 0,
        open_before_close: 0,
        open_after_close: 0,
        generation: 3,
        close_ts: 0,
        price_maxima: [0; 24],
        price_head_hour: 0,
        drawdown_trip_ts: 0,
        volume_total: 42,
        integrators: 2,
        after_close_gain: 0,
        after_close_loss: 0,
        accepting_round: 0,
        next_round_id,
        beacon_shares_held: 0,
        protocol_shares_accrued: 0,
        app_shares_owed: 0,
        beacon_returns_owed: 0,
        rounds_forfeited: 0,
        forfeits_withheld: 0,
        ticket_forfeits_withheld: 0,
        _reserved: [0; 40],
    };
    let mut data = Vec::new();
    vault.try_serialize(&mut data).unwrap();
    data
}

fn put(svm: &mut LiteSVM, address: Address, data: Vec<u8>) {
    put_owned(svm, address, data, program());
}

fn put_owned(svm: &mut LiteSVM, address: Address, data: Vec<u8>, owner: Address) {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        address,
        Account {
            lamports,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn migrate_ix(authority: &Address, beacon: &RiskParams) -> Instruction {
    migrate_ix_with(
        authority,
        &upgradeable::program_data_address(&program()),
        beacon,
    )
}

fn migrate_ix_with(
    authority: &Address,
    program_data: &Address,
    beacon: &RiskParams,
) -> Instruction {
    let discriminator = solana_sha256_hasher::hash(b"global:migrate_config");
    let mut data = discriminator.to_bytes()[..8].to_vec();
    for v in [
        beacon.beacon_min_price,
        beacon.beacon_threshold,
        beacon.round_k,
        beacon.tick_slots,
        beacon.refund_slots,
        beacon.crank_round_settle_lamports,
    ] {
        data.extend_from_slice(&v.to_le_bytes());
    }
    Instruction {
        program_id: program(),
        accounts: vec![
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(program(), false),
            AccountMeta::new_readonly(*program_data, false),
            AccountMeta::new(pda(&[fade::CONFIG_SEED]), false),
            AccountMeta::new(pda(&[fade::VAULT_SEED]), false),
            AccountMeta::new_readonly(Address::default(), false),
        ],
        data,
    }
}

fn send(svm: &mut LiteSVM, ix: Instruction, signer: &Keypair) -> Result<(), String> {
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&signer.pubkey()),
        &[signer],
        svm.latest_blockhash(),
    );
    let result = svm
        .send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    svm.expire_blockhash();
    result
}

#[test]
fn the_devnet_config_migrates_in_place_once() {
    let authority = Keypair::new();
    let Some(mut svm) = devnet_svm(&authority) else {
        return;
    };
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();

    let config = pda(&[fade::CONFIG_SEED]);
    let vault = pda(&[fade::VAULT_SEED]);
    put(
        &mut svm,
        config,
        v1_config(&authority.pubkey(), &live_params()),
    );
    put(&mut svm, vault, vault_account(0));

    // Only the upgrade authority may migrate.
    let err = send(
        &mut svm,
        migrate_ix(&stranger.pubkey(), &RiskParams::SPEC),
        &stranger,
    )
    .unwrap_err();
    assert!(err.contains("Custom(6000)"), "{err}");
    // Nor the upgrade authority of another program, presenting that program's
    // ProgramData: it must be Fade's own.
    let other = Address::new_unique();
    svm.add_program_from_file(other, binary("deploy", "toolchain_smoke"))
        .expect("target/deploy/toolchain_smoke.so: run pnpm build:sbf");
    upgradeable::set_upgrade_authority(&mut svm, &other, &stranger.pubkey());
    let err = send(
        &mut svm,
        migrate_ix_with(
            &stranger.pubkey(),
            &upgradeable::program_data_address(&other),
            &RiskParams::SPEC,
        ),
        &stranger,
    )
    .unwrap_err();
    assert!(err.contains("Custom(6000)"), "{err}");
    // Beacon parameters out of range are refused.
    let mut bad = RiskParams::SPEC;
    bad.round_k = 2;
    let err = send(&mut svm, migrate_ix(&authority.pubkey(), &bad), &authority).unwrap_err();
    assert!(err.contains("Custom(6001)"), "{err}");

    // The account holds the version-1 rent only: the authority tops it up.
    let before = svm.get_account(&config).unwrap().lamports;
    assert!(before < svm.minimum_balance_for_rent_exemption(791));
    send(
        &mut svm,
        migrate_ix(&authority.pubkey(), &RiskParams::SPEC),
        &authority,
    )
    .unwrap();
    let account = svm.get_account(&config).unwrap();
    assert_eq!(account.data.len(), 791);
    assert_eq!(
        account.lamports,
        svm.minimum_balance_for_rent_exemption(791)
    );
    let c = Config::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(c.version, fade::CONFIG_VERSION);
    assert_eq!(c.params, live_params());
    assert_eq!(c.pending.params, live_params());
    assert_eq!(c.council.to_bytes(), authority.pubkey().to_bytes());
    // The live deployment ran unpaused: the beacon arrives paused, for the
    // council alone to turn on.
    assert_eq!(c.pause_flags, Config::PAUSE_ROUNDS);
    let v = Vault::try_deserialize(&mut svm.get_account(&vault).unwrap().data.as_slice()).unwrap();
    assert_eq!(v.next_round_id, 1);
    assert_eq!(
        (v.total_assets, v.volume_total, v.integrators),
        (1_000_000_000, 42, 2)
    );

    // Once only.
    let err = send(
        &mut svm,
        migrate_ix(&authority.pubkey(), &RiskParams::SPEC),
        &authority,
    )
    .unwrap_err();
    assert!(err.contains("Custom(3003)"), "{err}"); // AccountDidNotDeserialize
}

#[test]
fn a_vault_already_numbering_rounds_keeps_its_next_id() {
    let authority = Keypair::new();
    let Some(mut svm) = devnet_svm(&authority) else {
        return;
    };
    let vault = pda(&[fade::VAULT_SEED]);
    put(
        &mut svm,
        pda(&[fade::CONFIG_SEED]),
        v1_config(&authority.pubkey(), &live_params()),
    );
    put(&mut svm, vault, vault_account(9));
    send(
        &mut svm,
        migrate_ix(&authority.pubkey(), &RiskParams::SPEC),
        &authority,
    )
    .unwrap();
    let v = Vault::try_deserialize(&mut svm.get_account(&vault).unwrap().data.as_slice()).unwrap();
    assert_eq!(v.next_round_id, 9);
}

#[test]
fn a_config_the_program_does_not_own_is_refused() {
    let authority = Keypair::new();
    let Some(mut svm) = devnet_svm(&authority) else {
        return;
    };
    let config = pda(&[fade::CONFIG_SEED]);
    put_owned(
        &mut svm,
        config,
        v1_config(&authority.pubkey(), &live_params()),
        Address::new_unique(),
    );
    put(&mut svm, pda(&[fade::VAULT_SEED]), vault_account(0));
    let err = send(
        &mut svm,
        migrate_ix(&authority.pubkey(), &RiskParams::SPEC),
        &authority,
    )
    .unwrap_err();
    assert!(err.contains("Custom(2004)"), "{err}"); // ConstraintOwner
    assert_eq!(svm.get_account(&config).unwrap().data.len(), 695);
}
