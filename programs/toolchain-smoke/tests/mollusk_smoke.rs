//! Phase 0 proof, instruction level: the v2 binary loads and runs under the
//! mainnet feature set in Mollusk, `emit_cpi!` produces an inner instruction,
//! and a system-owned PDA can pay through `invoke_signed`.
//!
//! Run with `SBF_OUT_DIR` pointing at target/deploy (scripts/toolchain/env.sh).

use anchor_lang::{Discriminator, InstructionData, ToAccountMetas};
use mollusk_svm::result::Check;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_sdk_ids::system_program;
use toolchain_smoke::{accounts, instruction, Pinged, VRF_PAYER_SEED};

fn program_id() -> Address {
    Address::new_from_array(toolchain_smoke::ID.to_bytes())
}

fn addr(seed: u8) -> Address {
    Address::new_from_array([seed; 32])
}

fn wallet(lamports: u64) -> Account {
    Account::new(lamports, 0, &system_program::ID)
}

fn slot_hashes_account(entries: &[(u64, [u8; 32])]) -> Account {
    let mut data = Vec::with_capacity(8 + entries.len() * 40);
    data.extend_from_slice(&(entries.len() as u64).to_le_bytes());
    for (slot, hash) in entries {
        data.extend_from_slice(&slot.to_le_bytes());
        data.extend_from_slice(hash);
    }
    Account {
        lamports: 1,
        data,
        owner: solana_sdk_ids::sysvar::ID,
        executable: false,
        rent_epoch: 0,
    }
}

#[test]
fn ping_reads_slot_hashes_and_emits_via_cpi() {
    let program = program_id();
    let mollusk = fade_testkit::mollusk(&program, "toolchain_smoke");

    let slot_hashes_id = Address::new_from_array(toolchain_smoke::SLOT_HASHES_SYSVAR_ID.to_bytes());
    let (event_authority, _) = Address::find_program_address(&[b"__event_authority"], &program);
    let latest = (4_242u64, [7u8; 32]);

    let accounts = accounts::Ping {
        slot_hashes: toolchain_smoke::SLOT_HASHES_SYSVAR_ID,
        event_authority: anchor_lang::prelude::Pubkey::new_from_array(event_authority.to_bytes()),
        program: toolchain_smoke::ID,
    }
    .to_account_metas(None);
    let ix = Instruction {
        program_id: program,
        accounts: accounts
            .into_iter()
            .map(|m| solana_instruction::AccountMeta {
                pubkey: Address::new_from_array(m.pubkey.to_bytes()),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data: instruction::Ping {}.data(),
    };

    let program_account = mollusk_svm::program::create_program_account_loader_v3(&program);
    let result = mollusk.process_and_validate_instruction(
        &ix,
        &[
            (
                slot_hashes_id,
                slot_hashes_account(&[latest, (4_241, [6u8; 32])]),
            ),
            (event_authority, Account::default()),
            (program, program_account),
        ],
        &[Check::success()],
    );

    // emit_cpi! = a self-CPI whose data is the 8-byte emit prefix + event discriminator + event.
    let inner = result
        .inner_instructions
        .iter()
        .map(|ix| &ix.instruction.data)
        .find(|data| data.starts_with(&[228, 69, 165, 46, 81, 203, 154, 29]))
        .expect("emit_cpi inner instruction");
    assert_eq!(&inner[8..16], Pinged::DISCRIMINATOR);
    let event: Pinged = anchor_lang::AnchorDeserialize::deserialize(&mut &inner[16..]).unwrap();
    assert_eq!(event.version, 1);
    assert_eq!(event.latest_slot, latest.0);
    assert_eq!(event.latest_hash, latest.1);
    assert!(
        result.compute_units_consumed < 20_000,
        "ping cost {} CU",
        result.compute_units_consumed
    );
}

#[test]
fn pda_can_pay_via_invoke_signed() {
    let program = program_id();
    let mollusk = fade_testkit::mollusk(&program, "toolchain_smoke");

    let payer = addr(1);
    let recipient = addr(2);
    let (vrf_payer, _) = Address::find_program_address(&[VRF_PAYER_SEED, payer.as_ref()], &program);
    let to_pk = |a: Address| anchor_lang::prelude::Pubkey::new_from_array(a.to_bytes());
    let convert = |metas: Vec<anchor_lang::prelude::AccountMeta>| {
        metas
            .into_iter()
            .map(|m| solana_instruction::AccountMeta {
                pubkey: Address::new_from_array(m.pubkey.to_bytes()),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect::<Vec<_>>()
    };

    let fund = Instruction {
        program_id: program,
        accounts: convert(
            accounts::FundPda {
                payer: to_pk(payer),
                vrf_payer: to_pk(vrf_payer),
                system_program: to_pk(Address::new_from_array(system_program::ID.to_bytes())),
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
        accounts: convert(
            accounts::PdaTransfer {
                payer: to_pk(payer),
                vrf_payer: to_pk(vrf_payer),
                recipient: to_pk(recipient),
                system_program: to_pk(Address::new_from_array(system_program::ID.to_bytes())),
            }
            .to_account_metas(None),
        ),
        data: instruction::PdaTransfer {
            lamports: 3_000_000,
        }
        .data(),
    };

    let result = mollusk.process_and_validate_instruction_chain(
        &[
            (&fund, &[Check::success()]),
            (
                &transfer,
                &[
                    Check::success(),
                    Check::account(&vrf_payer).lamports(2_000_000).build(),
                    Check::account(&recipient)
                        .lamports(1_000_000 + 3_000_000)
                        .build(),
                ],
            ),
        ],
        &[
            (payer, wallet(10_000_000)),
            (vrf_payer, Account::default()),
            (recipient, wallet(1_000_000)),
            mollusk_svm::program::keyed_account_for_system_program(),
        ],
    );
    assert!(result.program_result.is_ok());
}
