//! Account sizes and error codes are part of the program's interface: a client,
//! an indexer or a later version of the program depends on them. Changing one is
//! deliberate, and this test makes it visible.

use anchor_lang::Space;
use fade::errors::FadeError;
use fade::state::*;

#[test]
fn account_sizes_are_pinned() {
    let sizes = [
        ("Config", 8 + Config::INIT_SPACE),
        ("Vault", 8 + Vault::INIT_SPACE),
        ("Queue", 8 + Queue::INIT_SPACE),
        ("EpochRecord", 8 + EpochRecord::INIT_SPACE),
        ("DepositRequest", 8 + DepositRequest::INIT_SPACE),
        ("WithdrawRequest", 8 + WithdrawRequest::INIT_SPACE),
        ("Integrator", 8 + Integrator::INIT_SPACE),
        ("Ticket", 8 + Ticket::INIT_SPACE),
    ];
    for (name, size) in sizes {
        eprintln!("{name}: {size} bytes");
    }
    assert_eq!(
        sizes.map(|(_, s)| s),
        PINNED,
        "an account layout changed: update PINNED and Spec 08 §2"
    );
}

const PINNED: [usize; 8] = [695, 606, 272, 210, 67, 115, 179, 859];

#[test]
fn error_codes_are_pinned() {
    let code = |e: FadeError| 6000 + e as u32;
    assert_eq!(code(FadeError::NotUpgradeAuthority), 6000);
    assert_eq!(code(FadeError::PerTicketCap), 6020);
    assert_eq!(code(FadeError::DrawdownBreaker), 6025);
    assert_eq!(code(FadeError::WrongRandomnessAccount), 6034);
    assert_eq!(code(FadeError::StrikeNotClean), 6042);
    assert_eq!(code(FadeError::ForbiddenComposition), 6045);
    assert_eq!(code(FadeError::VaultRequired), 6052);
    assert_eq!(code(FadeError::DestinationUnusable), 6053);
}
