//! Hand-packed SPL Token accounts, so tests can create mints and token accounts
//! without a dependency on the token crate. Layouts are the legacy SPL Token
//! program's (`Mint` 82 bytes, `Account` 165 bytes).

use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use std::str::FromStr;

/// The legacy SPL Token program.
pub fn token_program_id() -> Address {
    Address::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
}

/// Mainnet USDC mint, the address the program pins.
pub fn usdc_mint() -> Address {
    Address::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap()
}

fn coption(value: Option<&Address>) -> [u8; 36] {
    let mut out = [0u8; 36];
    if let Some(v) = value {
        out[0] = 1;
        out[4..36].copy_from_slice(v.as_ref());
    }
    out
}

/// Raw bytes of an initialised mint.
pub fn mint_data(
    mint_authority: Option<&Address>,
    supply: u64,
    decimals: u8,
    freeze_authority: Option<&Address>,
) -> Vec<u8> {
    let mut d = Vec::with_capacity(82);
    d.extend_from_slice(&coption(mint_authority));
    d.extend_from_slice(&supply.to_le_bytes());
    d.push(decimals);
    d.push(1); // is_initialized
    d.extend_from_slice(&coption(freeze_authority));
    debug_assert_eq!(d.len(), 82);
    d
}

/// Raw bytes of an initialised, unfrozen token account.
pub fn token_account_data(mint: &Address, owner: &Address, amount: u64) -> Vec<u8> {
    let mut d = Vec::with_capacity(165);
    d.extend_from_slice(mint.as_ref());
    d.extend_from_slice(owner.as_ref());
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&coption(None)); // delegate
    d.push(1); // state: Initialized
    d.extend_from_slice(&[0u8; 12]); // is_native: COption<u64> = None
    d.extend_from_slice(&0u64.to_le_bytes()); // delegated_amount
    d.extend_from_slice(&coption(None)); // close_authority
    debug_assert_eq!(d.len(), 165);
    d
}

fn rent_exempt(svm: &LiteSVM, len: usize) -> u64 {
    svm.minimum_balance_for_rent_exemption(len)
}

/// Writes a mint account.
pub fn write_mint(svm: &mut LiteSVM, mint: Address, authority: &Address, decimals: u8) {
    let data = mint_data(Some(authority), 0, decimals, None);
    let lamports = rent_exempt(svm, data.len());
    svm.set_account(
        mint,
        Account {
            lamports,
            data,
            owner: token_program_id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

/// Writes a token account at `address` (any address; tests do not need ATAs).
pub fn write_token_account(
    svm: &mut LiteSVM,
    address: Address,
    mint: &Address,
    owner: &Address,
    amount: u64,
) {
    let data = token_account_data(mint, owner, amount);
    let lamports = rent_exempt(svm, data.len());
    svm.set_account(
        address,
        Account {
            lamports,
            data,
            owner: token_program_id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

/// Reads a token account's balance.
pub fn balance(svm: &LiteSVM, address: &Address) -> u64 {
    let acc = svm.get_account(address).expect("token account exists");
    assert_eq!(acc.owner, token_program_id(), "not a token account");
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}
