//! Phase 0 proof, transaction level in the litesvm crate: the binary runs under
//! the mainnet feature set, and is rejected when no SBPF version feature is
//! active (the negative control that proves the feature set is really applied).

use agave_feature_set::FeatureSet;
use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use toolchain_smoke::{accounts, instruction, VRF_PAYER_SEED};

fn program_id() -> Address {
    Address::new_from_array(toolchain_smoke::ID.to_bytes())
}

fn metas(v: Vec<anchor_lang::prelude::AccountMeta>) -> Vec<AccountMeta> {
    v.into_iter()
        .map(|m| AccountMeta {
            pubkey: Address::new_from_array(m.pubkey.to_bytes()),
            is_signer: m.is_signer,
            is_writable: m.is_writable,
        })
        .collect()
}

fn pk(a: Address) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array(a.to_bytes())
}

#[test]
fn pda_pays_through_invoke_signed_in_a_real_transaction() {
    let program = program_id();
    let mut svm = fade_testkit::litesvm(program, &fade_testkit::program_path("toolchain_smoke"));

    let payer = Keypair::new();
    let recipient = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&recipient.pubkey(), 1_000_000_000).unwrap();
    let (vrf_payer, _) =
        Address::find_program_address(&[VRF_PAYER_SEED, payer.pubkey().as_ref()], &program);
    let system = Address::new_from_array(solana_sdk_ids::system_program::ID.to_bytes());

    let fund = Instruction {
        program_id: program,
        accounts: metas(
            accounts::FundPda {
                payer: pk(payer.pubkey()),
                vrf_payer: pk(vrf_payer),
                system_program: pk(system),
            }
            .to_account_metas(None),
        ),
        data: instruction::FundPda {
            lamports: 5_000_000,
        }
        .data(),
    };
    let transfer = Instruction {
        program_id: program,
        accounts: metas(
            accounts::PdaTransfer {
                payer: pk(payer.pubkey()),
                vrf_payer: pk(vrf_payer),
                recipient: pk(recipient.pubkey()),
                system_program: pk(system),
            }
            .to_account_metas(None),
        ),
        data: instruction::PdaTransfer {
            lamports: 3_000_000,
        }
        .data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[fund, transfer],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    let meta = svm
        .send_transaction(tx)
        .unwrap_or_else(|e| panic!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    assert!(
        meta.compute_units_consumed < 30_000,
        "two instructions cost {} CU",
        meta.compute_units_consumed
    );
    assert_eq!(svm.get_balance(&vrf_payer), Some(2_000_000));
    assert_eq!(
        svm.get_balance(&recipient.pubkey()),
        Some(1_000_000_000 + 3_000_000)
    );
}

#[test]
fn binary_cannot_run_without_the_sbpf_version_feature() {
    // An empty feature set has no SBPF v1/v2/v3 deployment feature. The harness
    // still lets the ELF be registered (it bypasses the loader), but executing
    // it must fail: the runtime environment built from the feature set does
    // not accept v3 bytecode. If this ever passes, the harness stopped applying
    // feature sets and every other test runs on an unknown runtime.
    let path = fade_testkit::program_path("toolchain_smoke");
    let elf = std::fs::read(&path).unwrap();
    let e_flags = u32::from_le_bytes(elf[0x30..0x34].try_into().unwrap());
    if e_flags == 0 {
        eprintln!("skipped: {path} is an SBPF v0 binary, which has no feature gate");
        return;
    }
    let program = program_id();
    let mut bare = LiteSVM::new().with_feature_set(FeatureSet::default());
    bare.add_program_from_file(program, fade_testkit::program_path("toolchain_smoke"))
        .unwrap();
    let payer = Keypair::new();
    bare.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    let (vrf_payer, _) =
        Address::find_program_address(&[VRF_PAYER_SEED, payer.pubkey().as_ref()], &program);
    let system = Address::new_from_array(solana_sdk_ids::system_program::ID.to_bytes());
    let fund = Instruction {
        program_id: program,
        accounts: metas(
            accounts::FundPda {
                payer: pk(payer.pubkey()),
                vrf_payer: pk(vrf_payer),
                system_program: pk(system),
            }
            .to_account_metas(None),
        ),
        data: instruction::FundPda { lamports: 1 }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[fund],
        Some(&payer.pubkey()),
        &[&payer],
        bare.latest_blockhash(),
    );
    let result = bare.send_transaction(tx);
    assert!(
        result.is_err(),
        "a v3 program executed without the v3 feature"
    );
}
