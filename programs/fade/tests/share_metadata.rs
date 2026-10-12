//! `set_share_metadata`: the council names the share mint for wallets through
//! Metaplex Token Metadata. The Token Metadata binary under
//! tests/fixtures/metaplex is loaded at its mainnet address, so the CPI runs
//! against the real program, fee and length checks included.

mod common;
use anchor_lang::{InstructionData, ToAccountMetas};
use common::*;
use fade::errors::FadeError;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;

const NAME: &str = "Fade Vault USDC";
const SYMBOL: &str = "fvUSDC";
const URI: &str = "https://fade.finance/tokens/fvusdc.json";

fn metadata_program() -> Address {
    addr(fade::TOKEN_METADATA_ID)
}

fn metadata_address(env: &Env) -> Address {
    pda(
        &[
            fade::METADATA_SEED,
            metadata_program().as_ref(),
            env.a.share_mint.as_ref(),
        ],
        &metadata_program(),
    )
}

fn env() -> Env {
    let mut env = Env::new();
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/metaplex/token_metadata.so"
    );
    env.svm
        .add_program_from_file(metadata_program(), path)
        .expect("Token Metadata loads under the mainnet feature set");
    env
}

fn ix(
    env: &Env,
    council: &Address,
    payer: &Address,
    metadata: &Address,
    name: &str,
    symbol: &str,
    uri: &str,
) -> Instruction {
    Instruction {
        program_id: fade_id(),
        accounts: metas(
            fade::accounts::SetShareMetadata {
                council: pk(*council),
                payer: pk(*payer),
                config: pk(env.a.config),
                vault_authority: pk(env.a.vault_authority),
                share_mint: pk(env.a.share_mint),
                metadata: pk(*metadata),
                token_metadata_program: fade::TOKEN_METADATA_ID,
                system_program: pk(system_id()),
                event_authority: pk(env.a.event_authority),
                program: fade::ID,
            }
            .to_account_metas(None),
        ),
        data: fade::instruction::SetShareMetadata {
            name: name.into(),
            symbol: symbol.into(),
            uri: uri.into(),
        }
        .data(),
    }
}

/// The council sends `set_share_metadata`; the logs on success.
fn set(env: &mut Env, name: &str, symbol: &str, uri: &str) -> Result<Vec<String>, Failure> {
    let council = env.council.insecure_clone();
    let metadata = metadata_address(env);
    let i = ix(
        env,
        &council.pubkey(),
        &council.pubkey(),
        &metadata,
        name,
        symbol,
        uri,
    );
    env.send(&[i], &[&council]).map(|m| m.logs)
}

fn logged(logs: &[String], line: &str) -> bool {
    logs.iter().any(|l| l.contains(line))
}

/// Token Metadata's `Metadata` head: key, update authority, mint, then the
/// three Borsh strings, NUL-padded to their maximum lengths.
struct Head {
    update_authority: Address,
    mint: Address,
    name: String,
    symbol: String,
    uri: String,
}

fn read_metadata(env: &Env) -> Head {
    let account = env.svm.get_account(&metadata_address(env)).unwrap();
    assert_eq!(account.owner, metadata_program());
    let d = account.data.as_slice();
    assert_eq!(d[0], 4, "Key::MetadataV1");
    let mut at = 65;
    let mut string = || {
        let len = u32::from_le_bytes(d[at..at + 4].try_into().unwrap()) as usize;
        let s = String::from_utf8(d[at + 4..at + 4 + len].to_vec()).unwrap();
        at += 4 + len;
        s.trim_end_matches('\0').to_string()
    };
    let (name, symbol, uri) = (string(), string(), string());
    Head {
        update_authority: Address::try_from(&d[1..33]).unwrap(),
        mint: Address::try_from(&d[33..65]).unwrap(),
        name,
        symbol,
        uri,
    }
}

#[test]
fn the_council_creates_the_share_metadata_and_the_vault_authority_keeps_it() {
    let mut env = env();
    let logs = set(&mut env, NAME, SYMBOL, URI).unwrap();
    assert!(
        logged(&logs, "IX: Create Metadata Accounts v3"),
        "{logs:#?}"
    );
    let m = read_metadata(&env);
    assert_eq!(m.update_authority, env.a.vault_authority);
    assert_eq!(m.mint, env.a.share_mint);
    assert_eq!(
        (m.name.as_str(), m.symbol.as_str(), m.uri.as_str()),
        (NAME, SYMBOL, URI)
    );
}

#[test]
fn a_second_call_rewrites_the_metadata() {
    let mut env = env();
    set(&mut env, NAME, SYMBOL, URI).unwrap();
    let uri = "https://fade.finance/tokens/fvusdc-v2.json";
    let logs = set(&mut env, "Fade Vault Shares", "fvUSD", uri).unwrap();
    assert!(
        logged(&logs, "IX: Update Metadata Accounts v2"),
        "{logs:#?}"
    );
    let m = read_metadata(&env);
    assert_eq!(
        (m.name.as_str(), m.symbol.as_str(), m.uri.as_str()),
        ("Fade Vault Shares", "fvUSD", uri)
    );
    assert_eq!(m.update_authority, env.a.vault_authority);
}

#[test]
fn a_separate_payer_may_fund_the_creation() {
    let mut env = env();
    let payer = Keypair::new();
    env.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let council = env.council.insecure_clone();
    let metadata = metadata_address(&env);
    let before = env.lamports(&council.pubkey());
    let i = ix(
        &env,
        &council.pubkey(),
        &payer.pubkey(),
        &metadata,
        NAME,
        SYMBOL,
        URI,
    );
    env.send(&[i], &[&payer, &council]).unwrap();
    assert_eq!(env.lamports(&council.pubkey()), before);
    assert_eq!(read_metadata(&env).name, NAME);
}

#[test]
fn only_the_council_sets_the_metadata() {
    let mut env = env();
    for signer in [env.guardian.insecure_clone(), Keypair::new()] {
        env.svm.airdrop(&signer.pubkey(), 1_000_000_000).unwrap();
        let metadata = metadata_address(&env);
        let i = ix(
            &env,
            &signer.pubkey(),
            &signer.pubkey(),
            &metadata,
            NAME,
            SYMBOL,
            URI,
        );
        assert_fails_with(env.send(&[i], &[&signer]), FadeError::NotCouncil);
    }
    assert!(!env.exists(&metadata_address(&env)));
    // Nor can anyone hijack the update authority afterwards.
    set(&mut env, NAME, SYMBOL, URI).unwrap();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let metadata = metadata_address(&env);
    let i = ix(
        &env,
        &stranger.pubkey(),
        &stranger.pubkey(),
        &metadata,
        "Scam",
        "SCAM",
        URI,
    );
    assert_fails_with(env.send(&[i], &[&stranger]), FadeError::NotCouncil);
    assert_eq!(read_metadata(&env).name, NAME);
}

#[test]
fn the_metadata_account_is_the_share_mints_pda() {
    let mut env = env();
    let council = env.council.insecure_clone();
    let wrong = pda(
        &[
            fade::METADATA_SEED,
            metadata_program().as_ref(),
            env.a.usdc_mint.as_ref(),
        ],
        &metadata_program(),
    );
    let i = ix(
        &env,
        &council.pubkey(),
        &council.pubkey(),
        &wrong,
        NAME,
        SYMBOL,
        URI,
    );
    let err = env.send(&[i], &[&council]).unwrap_err();
    // anchor's ConstraintSeeds
    assert!(err.has_code(2006), "{err:?}");
}

#[test]
fn token_metadata_rejects_oversized_fields_and_nothing_is_written() {
    let mut env = env();
    let long_name = "N".repeat(33);
    assert!(set(&mut env, &long_name, SYMBOL, URI).is_err());
    assert!(set(&mut env, NAME, "SYMBOL12345", URI).is_err());
    assert!(!env.exists(&metadata_address(&env)));
    set(&mut env, NAME, SYMBOL, URI).unwrap();
    assert!(set(&mut env, NAME, SYMBOL, &"u".repeat(201)).is_err());
    assert_eq!(read_metadata(&env).uri, URI);
}
