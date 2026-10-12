//! Helpers around the upgradeable loader's `ProgramData` account, which Fade's
//! `initialize` inspects to find the upgrade authority.

use litesvm::LiteSVM;
use solana_address::Address;
use std::str::FromStr;

/// `BPFLoaderUpgradeab1e11111111111111111111111`.
pub fn loader_id() -> Address {
    Address::from_str("BPFLoaderUpgradeab1e11111111111111111111111").unwrap()
}

/// The `ProgramData` address of a program: `[program_id]` under the loader.
pub fn program_data_address(program_id: &Address) -> Address {
    Address::find_program_address(&[program_id.as_ref()], &loader_id()).0
}

/// Sets the upgrade authority in an existing `ProgramData` account. The
/// harness creates it with no authority; `initialize` requires one. Layout:
/// `u32` enum tag (3 = ProgramData), `u64` slot, `Option<Pubkey>` (u8 tag +
/// 32 bytes), then the ELF.
pub fn set_upgrade_authority(svm: &mut LiteSVM, program_id: &Address, authority: &Address) {
    let address = program_data_address(program_id);
    let mut account = svm
        .get_account(&address)
        .expect("programdata account exists");
    assert_eq!(
        u32::from_le_bytes(account.data[0..4].try_into().unwrap()),
        3,
        "not a ProgramData account"
    );
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(address, account).unwrap();
}
