//! One change, one effect on the development build (audit of 22 October
//! 2026, F-5): with feature `no-timelock` every `set_params` applies at once,
//! and it writes the treasury it names with the parameters, as `apply_params`
//! would, replacing any pending change. Runs against the devnet binary
//! (`target/devnet/fade.so`, built by `pnpm build:sbf`), the only build with
//! that feature; the gate sets `FADE_REQUIRE_DEVNET_BINARY`, so there a
//! missing binary fails, elsewhere the test says it skips.
//!
//! On the code before the fix the treasury stayed where it was: the test
//! fails there.

use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData};
use fade::state::{Config, PendingChange, RiskParams};
use fade_testkit::{token, upgradeable};
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
fn pda(seeds: &[&[u8]]) -> (Address, u8) {
    Address::find_program_address(seeds, &program())
}

fn send(svm: &mut LiteSVM, ix: Instruction, signer: &Keypair) -> Result<Vec<String>, String> {
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&signer.pubkey()),
        &[signer],
        svm.latest_blockhash(),
    );
    let r = svm
        .send_transaction(tx)
        .map(|m| m.logs)
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    svm.expire_blockhash();
    r
}

fn read_config(svm: &LiteSVM, address: &Address) -> Config {
    let acc = svm.get_account(address).unwrap();
    Config::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

#[test]
fn a_treasury_change_applies_with_the_parameters() {
    let root = std::env::var("FADE_ROOT")
        .unwrap_or_else(|_| format!("{}/../..", env!("CARGO_MANIFEST_DIR")));
    let so = format!("{root}/target/devnet/fade.so");
    if !std::path::Path::new(&so).exists() {
        assert!(
            std::env::var_os("FADE_REQUIRE_DEVNET_BINARY").is_none(),
            "{so} is missing: run pnpm build:sbf"
        );
        eprintln!("skipped: {so} is missing (pnpm build:sbf builds it)");
        return;
    }

    let deployer = Keypair::new();
    let council = Keypair::new();
    let mut svm = LiteSVM::new().with_feature_set(fade_testkit::mainnet_feature_set());
    svm.add_program_from_file(program(), so).unwrap();
    upgradeable::set_upgrade_authority(&mut svm, &program(), &deployer.pubkey());
    svm.airdrop(&council.pubkey(), 10_000_000_000).unwrap();

    let mint = Address::new_unique();
    token::write_mint(&mut svm, mint, &Address::new_unique(), 6);
    let treasury_a = Address::new_unique();
    let treasury_b = Address::new_unique();
    let treasury_c = Address::new_unique();
    for t in [treasury_a, treasury_b, treasury_c] {
        token::write_token_account(&mut svm, t, &mint, &council.pubkey(), 0);
    }

    let (config_addr, bump) = pda(&[fade::CONFIG_SEED]);
    let (_, va_bump) = pda(&[fade::VAULT_AUTHORITY_SEED]);
    let mut queued = RiskParams::SPEC;
    queued.censorship_bps = 200;
    let config = Config {
        version: fade::CONFIG_VERSION,
        bump,
        vault_authority_bump: va_bump,
        council: council.pubkey(),
        guardian: Address::new_unique(),
        protocol_treasury: treasury_a,
        usdc_mint: mint,
        pause_flags: 0,
        params: RiskParams::SPEC,
        // A change already queued that moves the treasury to C.
        pending: PendingChange {
            active: true,
            effective_at: 0,
            params: queued,
            protocol_treasury: treasury_c,
        },
        _reserved: [0; 128],
    };
    let mut data = Vec::new();
    config.try_serialize(&mut data).unwrap();
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        config_addr,
        Account {
            lamports,
            data,
            owner: program(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    // Council moves the treasury from A to B, params unchanged.
    let (event_authority, _) = pda(&[b"__event_authority"]);
    let ix = Instruction {
        program_id: program(),
        accounts: vec![
            AccountMeta::new_readonly(council.pubkey(), true),
            AccountMeta::new(config_addr, false),
            AccountMeta::new_readonly(treasury_b, false),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(program(), false),
        ],
        data: fade::instruction::SetParams {
            params: RiskParams::SPEC,
        }
        .data(),
    };
    send(&mut svm, ix, &council).expect("set_params succeeds");

    // The treasury moved to B with the parameters, and the change queued
    // before (to C) was replaced by this one, applied.
    let after = read_config(&svm, &config_addr);
    assert_eq!(after.protocol_treasury, treasury_b);
    assert_eq!(after.params, RiskParams::SPEC);
    assert!(!after.pending.active);

    // Nothing is left to apply.
    let keeper = Keypair::new();
    svm.airdrop(&keeper.pubkey(), 1_000_000_000).unwrap();
    let apply = Instruction {
        program_id: program(),
        accounts: vec![
            AccountMeta::new(config_addr, false),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(program(), false),
        ],
        data: fade::instruction::ApplyParams {}.data(),
    };
    let err = send(&mut svm, apply, &keeper).unwrap_err();
    assert!(
        err.contains("Custom(6006)"),
        "NoPendingChange expected: {err}"
    );
    assert_eq!(
        read_config(&svm, &config_addr).protocol_treasury,
        treasury_b
    );
}
