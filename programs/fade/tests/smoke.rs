//! The whole path once, end to end: found the vault, open a ticket as a player,
//! request, fulfil, settle a win, and check every balance and counter.

mod common;
use common::*;

#[test]
fn found_the_vault_then_settle_a_winning_ticket() {
    let mut env = Env::new();
    let lp = env.found(5_000 * USDC);
    let vault = env.vault();
    assert_eq!(vault.total_assets, 5_000 * USDC);
    assert_eq!(env.balance(&env.a.vault_usdc), 5_000 * USDC);
    assert_eq!(env.balance(&lp.shares()), vault.total_shares);
    assert!(!env.queue().current.live);

    let player = env.user(100 * USDC);
    let ticket = env
        .open_direct(&player, 25 * USDC, &slot_classic(), 50)
        .expect("open");
    let w = env.ticket(&ticket);
    assert_eq!(w.price, 25 * USDC);
    // 20 bps to the treasury, 50 bps to the integrator — the player itself here
    assert_eq!(env.balance(&env.treasury), 50_000);
    assert_eq!(env.balance(&player.usdc), 100 * USDC - 25 * USDC + 125_000);
    env.play_out(&ticket, 0); // 3.5×
    assert!(!env.exists(&ticket), "a settled ticket is closed");
    assert_eq!(
        env.balance(&player.usdc),
        100 * USDC - 25 * USDC + 125_000 + 87_500_000
    );
    let vault = env.vault();
    assert_eq!(vault.total_reserved_liability, 0);
    assert_eq!(vault.open_vault_credits, 0);
    assert_eq!(vault.total_assets, 5_000 * USDC + 24_825_000 - 87_500_000);
    assert_eq!(env.balance(&env.a.vault_usdc), vault.total_assets);
    assert_eq!(vault.open_before_close + vault.open_after_close, 0);
}
