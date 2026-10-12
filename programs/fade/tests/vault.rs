//! The liquidity-provider side at transaction level (Spec 01 §3–§4, Spec 08 §4–§6):
//! epochs as batches, the clean strike, one price per epoch, rationed
//! withdrawals claimed once, the records and the strike fund, and the
//! composition allowlist of invariant 13.

mod common;
use common::*;
use fade::errors::FadeError;
use fade::state::RiskParams;
use fade_testkit::token;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_signer::Signer;

/// Players commit the vault up to its limits with coin flips, one integrator
/// after another, until something other than a ceiling refuses. Returns the tickets.
fn fill(env: &mut Env) -> Vec<Address> {
    let mut tickets = Vec::new();
    for _ in 0..40 {
        let p = env.user(1_000_000 * USDC);
        loop {
            match env.open_direct(&p, 25 * USDC, &coin_flip(), 0) {
                Ok(w) => tickets.push(w),
                Err(e) if e.has_code(fade_error(FadeError::IntegratorCap)) => break,
                Err(_) => return tickets,
            }
        }
    }
    tickets
}

fn request_rent(env: &Env, space: usize) -> u64 {
    env.svm.minimum_balance_for_rent_exemption(8 + space)
}
fn deposit_rent(env: &Env) -> u64 {
    request_rent(
        env,
        <fade::state::DepositRequest as anchor_lang::Space>::INIT_SPACE,
    )
}
fn record_rent(env: &Env) -> u64 {
    request_rent(
        env,
        <fade::state::EpochRecord as anchor_lang::Space>::INIT_SPACE,
    )
}

#[test]
fn the_first_request_opens_an_epoch_that_closes_on_the_grid() {
    let mut env = Env::new();
    let lp = env.user(1_000 * USDC);
    assert_eq!(env.vault().generation, 0);
    // Below the minimum, and below the first-deposit floor while no share exists.
    assert_fails_with(env.deposit(&lp, USDC - 1), FadeError::BelowMinimum);
    assert_fails_with(env.deposit(&lp, 99 * USDC), FadeError::FirstDepositTooSmall);
    // Opening without the vault is refused: the counters must roll.
    let mut ix = env.request_deposit_ix(&lp, 100 * USDC);
    let vault_meta = ix
        .accounts
        .iter()
        .position(|m| m.pubkey == env.a.vault)
        .unwrap();
    ix.accounts[vault_meta] = AccountMeta::new_readonly(fade_id(), false);
    let kp = lp.kp.insecure_clone();
    assert_fails_with(env.send(&[ix], &[&kp]), FadeError::VaultRequired);

    let epoch = env.deposit(&lp, 100 * USDC).unwrap();
    assert_eq!(epoch, 1);
    let q = env.queue();
    assert!(q.current.live);
    assert_eq!(q.current.epoch_id, 1);
    assert_eq!(q.current.close_ts, T0 - T0 % 600 + 600);
    assert_eq!(q.current.deposits, 100 * USDC);
    assert_eq!(q.next_epoch_id, 2);
    let vault = env.vault();
    assert_eq!((vault.generation, vault.close_ts), (1, q.current.close_ts));
    // The deposit sits apart from the vault until the strike.
    assert_eq!(vault.total_assets, 0);
    assert_eq!(env.balance(&env.a.deposit_queue), 100 * USDC);
    // The owner's share account exists already, for the keeper that will claim.
    assert!(env.exists(&lp.shares()));
}

#[test]
fn a_second_request_in_the_same_epoch_tops_up_the_first() {
    let mut env = Env::new();
    let lp = env.user(1_000 * USDC);
    let fund = env.fund();
    let e1 = env.deposit(&lp, 100 * USDC).unwrap();
    let e2 = env.deposit(&lp, 100 * USDC).unwrap();
    assert_eq!(e1, e2);
    let request: fade::state::DepositRequest =
        env.read(&env.deposit_request_address(e1, &lp.key()));
    assert_eq!(request.amount, 200 * USDC);
    let q = env.queue();
    assert_eq!(
        (q.current.deposits, q.current.deposit_requests),
        (200 * USDC, 1)
    );
    // One CLAIM_FEE, held in the request on top of its rent.
    let address = env.deposit_request_address(e1, &lp.key());
    assert_eq!(env.lamports(&address), deposit_rent(&env) + 200_000);
    // The fund was full: no STRIKE_FEE.
    assert_eq!(env.fund(), fund);
}

#[test]
fn a_request_after_the_close_joins_the_next_epoch_which_the_strike_promotes() {
    let mut env = Env::new();
    let a = env.user(1_000 * USDC);
    let b = env.user(1_000 * USDC);
    env.deposit(&a, 100 * USDC).unwrap();
    let close = env.queue().current.close_ts;
    env.pass_close();
    assert_eq!(
        env.now(),
        close,
        "a request at exactly the close belongs to the next"
    );
    let e = env.deposit(&b, 200 * USDC).unwrap();
    assert_eq!(e, 2);
    let q = env.queue();
    assert!(q.next.live && q.next.close_ts == 0 && q.next.deposits == 200 * USDC);
    // The strike of epoch 1 promotes epoch 2, whose close is set at the strike.
    env.advance(1, 30);
    assert_eq!(env.strike().unwrap(), 1);
    let q = env.queue();
    assert_eq!(q.current.epoch_id, 2);
    assert_eq!(q.current.close_ts, close + 600);
    assert!(!q.next.live);
    assert_eq!(env.vault().close_ts, close + 600);
    assert_eq!(env.vault().total_assets, 100 * USDC);
}

#[test]
fn the_strike_waits_for_the_close_and_for_every_ticket_opened_before_it() {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let lp = env.user(1_000 * USDC);
    let player = env.user(1_000 * USDC);
    env.deposit(&lp, 100 * USDC).unwrap();
    // A ticket opened before the close blocks the strike until it settles.
    let before = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    assert_fails_with(env.strike(), FadeError::EpochNotClosed);
    env.pass_close();
    // A ticket opened after the close does not.
    let after = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    assert_fails_with(env.strike(), FadeError::StrikeNotClean);
    env.play_out(&before, 1);
    let vault = env.vault();
    assert_eq!((vault.open_before_close, vault.open_after_close), (0, 1));
    // Its credit is left out of the price: opening it moved nothing a request clears at.
    let settled = vault.total_assets - vault.open_vault_credits;
    let epoch = env.strike().unwrap();
    let record = env.record(epoch);
    assert_eq!(record.total_assets, settled);
    env.play_out(&after, 1);
    // No epoch is live any more, and nothing is left to strike.
    assert!(!env.queue().current.live);
    assert_fails_with(env.strike(), FadeError::NoLiveEpoch);
}

#[test]
fn every_request_of_an_epoch_clears_at_one_price() {
    let mut env = Env::new();
    let founder = env.found(5_000 * USDC);
    let player = env.user(1_000 * USDC);
    // The vault earns: a lost ticket leaves its credit.
    let w = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    env.play_out(&w, 1);
    let a = env.user(10_000 * USDC);
    let b = env.user(10_000 * USDC);
    let epoch = env.deposit(&a, 1_000 * USDC).unwrap();
    env.advance(5, 200);
    env.deposit(&b, 3_000 * USDC).unwrap();
    env.pass_close();
    env.strike().unwrap();
    let r = env.record(epoch);
    env.claim_deposit(&a.key(), epoch).unwrap();
    env.claim_deposit(&b.key(), epoch).unwrap();
    let (sa, sb) = (env.balance(&a.shares()), env.balance(&b.shares()));
    // Same price for both, to the rounding of one share unit per claim.
    assert!((sa * 3).abs_diff(sb) <= 3, "{sa} vs {sb}");
    let expected =
        fade_math::shares::shares_for_assets(4_000 * USDC, r.total_shares, r.total_assets).unwrap();
    assert_eq!(r.shares_minted, expected);
    assert!(sa + sb <= r.shares_minted && r.shares_minted - (sa + sb) < 2);
    // The founder's shares are worth what they were plus the lost ticket's credit.
    let vault = env.vault();
    let founder_value = fade_math::shares::assets_for_shares(
        env.balance(&founder.shares()),
        vault.total_shares,
        vault.total_assets,
    )
    .unwrap();
    assert!(founder_value.abs_diff(5_000 * USDC + 25 * USDC - 50_000) <= 1);
}

#[test]
fn a_claim_pays_its_keeper_and_returns_the_rent_to_the_owner() {
    let mut env = Env::new();
    let lp = env.user(1_000 * USDC);
    let epoch = env.deposit(&lp, 100 * USDC).unwrap();
    env.pass_close();
    let keeper_before = env.lamports(&env.keeper.pubkey());
    env.strike().unwrap();
    // The strike paid its reward and was reimbursed the record's rent it advanced.
    assert_eq!(
        env.lamports(&env.keeper.pubkey()),
        keeper_before - 5_000 + 200_000
    );
    let lp_before = env.lamports(&lp.key());
    let keeper_before = env.lamports(&env.keeper.pubkey());
    let fund_before = env.fund();
    env.claim_deposit(&lp.key(), epoch).unwrap();
    assert_eq!(
        env.lamports(&env.keeper.pubkey()),
        keeper_before - 5_000 + 200_000
    );
    assert_eq!(env.lamports(&lp.key()), lp_before + deposit_rent(&env));
    // The last claim closes the record and returns its rent to the fund.
    assert!(!env.exists(&env.record_address(epoch)));
    assert_eq!(env.fund(), fund_before + record_rent(&env));
    assert!(!env.exists(&env.deposit_request_address(epoch, &lp.key())));
    assert!(env.balance(&lp.shares()) > 0);
}

#[test]
fn the_strike_fund_refills_only_while_below_its_target() {
    let mut env = Env::new();
    let target = RiskParams::SPEC.fund_target_lamports;
    assert_eq!(env.fund(), target, "initialize seeds the fund");
    let a = env.user(1_000 * USDC);
    let e = env.deposit(&a, 100 * USDC).unwrap();
    assert_eq!(env.fund(), target, "a full fund charges no STRIKE_FEE");
    env.pass_close();
    env.strike().unwrap();
    // The reward and the record's rent came out of the fund.
    assert_eq!(env.fund(), target - 200_000 - record_rent(&env));
    // Below target, the next request pays STRIKE_FEE into it.
    let b = env.user(1_000 * USDC);
    env.deposit(&b, 100 * USDC).unwrap();
    assert_eq!(env.fund(), target - 200_000 - record_rent(&env) + 200_000);
    // The claim of epoch 1 closes its record: the rent comes back.
    env.claim_deposit(&a.key(), e).unwrap();
    assert_eq!(env.fund(), target + record_rent(&env) - record_rent(&env));
}

#[test]
fn a_rationed_withdrawal_is_served_over_two_epochs_and_claimed_once() {
    let mut env = Env::new();
    // Two liquidity providers own the vault, 5 000 USDC each.
    let a = env.found(5_000 * USDC);
    let b = env.user(5_000 * USDC);
    let e = env.deposit(&b, 5_000 * USDC).unwrap();
    env.pass_close();
    env.strike().unwrap();
    env.claim_deposit(&b.key(), e).unwrap();
    let (sa, sb) = (env.balance(&a.shares()), env.balance(&b.shares()));

    // Both ask for everything; the epoch closes.
    let epoch = env.withdraw(&a, sa).unwrap();
    assert_eq!(env.withdraw(&b, sb).unwrap(), epoch);
    env.pass_close();
    // Players commit most of the vault after the close: the strike can only pay
    // what those tickets leave free.
    let tickets = fill(&mut env);
    let assets = env.vault().total_assets;
    env.strike().unwrap();
    let r1 = env.record(epoch);
    assert!(r1.assets_paid < r1.assets_owed, "the strike rations");
    assert!(r1.r_after > 0);
    let paid1 = r1.assets_paid;
    assert_eq!(env.balance(&env.a.payable), paid1);
    // The unpaid shares rolled into the next epoch, which is now live.
    let q = env.queue();
    assert_eq!(q.current.epoch_id, epoch + 1);
    assert_eq!(q.current.withdraw_shares, sa + sb - r1.shares_burnt);
    assert_eq!(
        q.current.withdraw_requests, 0,
        "rolled shares are the chain's, not new requests"
    );
    // A partial claim by A now; B waits.
    env.claim_withdraw(&a.key(), epoch, epoch).unwrap();
    let a_partial = env.balance(&a.usdc);
    assert!(a_partial > 0);
    // The tickets resolve — all lost to the vault — and the next epoch pays the rest.
    env.play_out_all(&tickets, 1);
    env.pass_close();
    env.strike().unwrap();
    let r2 = env.record(epoch + 1);
    assert_eq!(r2.r_after, 0, "the chain ends");
    assert_eq!(r2.assets_paid, r2.assets_owed);
    assert_eq!(r2.chain_id, r1.chain_id);
    // B claims once, reading the chain's end; A completes its partial claim.
    env.claim_withdraw(&b.key(), epoch, epoch + 1).unwrap();
    env.claim_withdraw(&a.key(), epoch, epoch + 1).unwrap();
    let (ua, ub) = (env.balance(&a.usdc), env.balance(&b.usdc));
    let paid = paid1 + r2.assets_paid;
    assert!(
        ua + ub <= paid && paid - (ua + ub) <= 4,
        "claims {ua} + {ub} vs paid {paid}"
    );
    // The two owned the vault equally and are paid equally, whenever they claimed.
    assert!(ua.abs_diff(ub) <= 2, "{ua} vs {ub}");
    // Everything they owned, including the credits the tickets left behind, to
    // the unit the virtual offset keeps.
    assert!(assets - (ua + ub) <= 10, "{assets} vs {}", ua + ub);
    // Both requests and both records are closed; the fund got the rent back.
    assert!(!env.exists(&env.withdraw_request_address(epoch, &a.key())));
    assert!(!env.exists(&env.withdraw_request_address(epoch, &b.key())));
    assert!(!env.exists(&env.record_address(epoch)));
    assert!(!env.exists(&env.record_address(epoch + 1)));
    assert_eq!(env.vault().total_shares, 0);
    let _ = a_partial;
}

#[test]
fn a_claim_cannot_read_another_chain() {
    let mut env = Env::new();
    let a = env.found(5_000 * USDC);
    let sa = env.balance(&a.shares());
    // A withdraws half in a chain that ends at once.
    let e1 = env.withdraw(&a, sa / 2).unwrap();
    env.pass_close();
    env.strike().unwrap();
    // A claim at a record that is not of its epoch's chain is refused.
    let b = env.user(1_000 * USDC);
    let e2 = env.deposit(&b, 100 * USDC).unwrap();
    env.pass_close();
    env.strike().unwrap();
    assert!(e2 > e1);
    assert_fails_with(env.claim_withdraw(&a.key(), e1, e2), FadeError::WrongRecord);
    env.claim_withdraw(&a.key(), e1, e1).unwrap();
}

#[test]
fn a_record_cannot_be_passed_twice_to_undo_its_release() {
    let mut env = Env::new();
    let a = env.found(5_000 * USDC);
    let sa = env.balance(&a.shares());
    let epoch = env.withdraw(&a, sa).unwrap();
    env.pass_close();
    let batch = fill(&mut env);
    env.strike().unwrap();
    assert!(
        env.record(epoch).r_after > 0,
        "rationed: a partial claim at the entry"
    );
    // The same record as the claim's record and as its entry record is refused
    // (Anchor's duplicate check), and nothing is released.
    let pending = env.record(epoch).pending;
    let mut ix = env.claim_withdraw_ix(&env.keeper.pubkey(), &a.key(), epoch, epoch);
    let record = env.record_address(epoch);
    let at = ix.accounts.iter().position(|m| m.pubkey == record).unwrap();
    ix.accounts[at + 1] = AccountMeta::new(record, false);
    let keeper = env.keeper.insecure_clone();
    let aliased = env.send(&[ix], &[&keeper]).unwrap_err();
    assert!(aliased.has_code(2040), "{aliased:?}");
    assert_eq!(env.record(epoch).pending, pending);
    // The honest partial claim releases the entry record once: its only
    // reader gone, it closes.
    assert_eq!(pending, 1);
    env.claim_withdraw(&a.key(), epoch, epoch).unwrap();
    assert!(!env.exists(&env.record_address(epoch)));
    env.play_out_all(&batch, 1);
}

#[test]
fn withdrawals_have_a_minimum_unless_they_take_the_whole_balance() {
    let mut env = Env::new();
    let a = env.found(100 * USDC);
    let shares = env.balance(&a.shares());
    assert_fails_with(env.withdraw(&a, SHARE - 1), FadeError::BelowMinimum);
    assert_fails_with(env.withdraw(&a, 0), FadeError::ZeroAmount);
    env.withdraw(&a, shares).unwrap();
}

#[test]
fn a_continuation_epoch_nobody_asked_for_leaves_no_record_behind() {
    let mut env = Env::new();
    let a = env.found(5_000 * USDC);
    let sa = env.balance(&a.shares());
    let epoch = env.withdraw(&a, sa).unwrap();
    env.pass_close();
    // Epoch 1 is rationed by tickets opened after its close.
    let batch = fill(&mut env);
    env.strike().unwrap();
    assert!(env.record(epoch).r_after > 0);
    // Those tickets were opened before epoch 2's close: they settle first. Then a
    // new batch, opened after epoch 2's close, rations epoch 2 as well.
    env.play_out_all(&batch, 1);
    env.pass_close();
    let batch = fill(&mut env);
    let fund = env.fund();
    env.strike().unwrap();
    // Epoch 2 carried only rolled shares and did not end the chain: nobody's
    // claim will ever read its record, so the strike closed it at once and the
    // fund paid only the reward.
    assert!(!env.exists(&env.record_address(epoch + 1)));
    assert_eq!(env.fund(), fund - 200_000);
    env.play_out_all(&batch, 1);
    env.pass_close();
    env.strike().unwrap();
    let end = env.record(epoch + 2);
    assert_eq!(end.r_after, 0);
    assert_eq!(end.pending, 1, "the request that entered at epoch 1");
    // One claim reads the entry and the end of the chain, and closes both.
    env.claim_withdraw(&a.key(), epoch, epoch + 2).unwrap();
    assert!(!env.exists(&env.record_address(epoch)));
    assert!(!env.exists(&env.record_address(epoch + 2)));
    assert!(!env.exists(&env.withdraw_request_address(epoch, &a.key())));
    assert_eq!(env.vault().total_shares, 0);
}

#[test]
fn a_quiet_period_creates_nothing_and_the_next_request_opens_epoch_two() {
    let mut env = Env::new();
    let a = env.user(1_000 * USDC);
    env.deposit(&a, 100 * USDC).unwrap();
    env.pass_close();
    env.strike().unwrap();
    assert!(!env.queue().current.live);
    // A quiet night.
    env.advance(100_000, 10 * 3_600 + 123);
    let b = env.user(1_000 * USDC);
    let e = env.deposit(&b, 100 * USDC).unwrap();
    assert_eq!(e, 2);
    let now = env.now();
    assert_eq!(env.queue().current.close_ts, now - now % 600 + 600);
}

#[test]
fn a_new_epoch_length_applies_to_the_next_close_only() {
    let mut env = Env::new();
    let a = env.user(1_000 * USDC);
    env.deposit(&a, 100 * USDC).unwrap();
    let close = env.queue().current.close_ts;
    let mut params = RiskParams::SPEC;
    params.epoch_length_seconds = 900; // lengthening is a tightening: at once
    env.set_params(params).unwrap();
    assert_eq!(env.config().params.epoch_length_seconds, 900);
    assert_eq!(
        env.queue().current.close_ts,
        close,
        "the live epoch keeps its close"
    );
    env.pass_close();
    let b = env.user(1_000 * USDC);
    env.deposit(&b, 100 * USDC).unwrap();
    env.strike().unwrap();
    let now = env.now();
    assert_eq!(env.queue().current.close_ts, now - now % 900 + 900);
}

#[test]
fn a_request_travels_alone_or_with_vault_instructions_only() {
    let mut env = Env::new();
    env.found(5_000 * USDC);
    let a = env.user(1_000 * USDC);
    let kp = a.kp.insecure_clone();
    // Compute-budget instructions are fine.
    let budget = Instruction {
        program_id: Address::from_str_const("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data: {
            let mut d = vec![2u8];
            d.extend_from_slice(&400_000u32.to_le_bytes());
            d
        },
    };
    let ix = env.request_deposit_ix(&a, 10 * USDC);
    env.send(&[budget, ix], &[&kp]).unwrap();
    // A memo is not in the allowlist.
    let memo = Instruction {
        program_id: Address::from_str_const("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        accounts: vec![],
        data: b"hello".to_vec(),
    };
    let ix = env.request_deposit_ix(&a, 10 * USDC);
    assert_fails_with(
        env.send(&[ix, memo], &[&kp]),
        FadeError::ForbiddenComposition,
    );
    // Nor is a settlement: the deposit → settle → withdraw bundle is refused.
    let player = env.user(100 * USDC);
    let w = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let request = env.request_randomness(&w).unwrap();
    let r = env.randomness_for(&w, 0);
    env.fulfill(&request, r);
    let settle = env.settle_ix(&a.key(), &w);
    let ix = env.request_deposit_ix(&a, 10 * USDC);
    assert_fails_with(
        env.send(&[ix, settle], &[&kp]),
        FadeError::ForbiddenComposition,
    );
    // A program wrapping the request over CPI is refused too.
    let inner = env.request_deposit_ix(&a, 10 * USDC);
    let wrapped = Instruction {
        program_id: addr(test_integrator::ID),
        accounts: {
            let mut v = metas(
                test_integrator::accounts::Forward {
                    integrator_authority: pk(pda(
                        &[fade::INTEGRATOR_AUTHORITY_SEED],
                        &addr(test_integrator::ID),
                    )),
                    fade_program: fade::ID,
                }
                .to_account_metas(None),
            );
            v.extend(inner.accounts.clone());
            v
        },
        data: test_integrator::instruction::Forward {
            data: inner.data.clone(),
            sign: false,
            claim_signer: None,
        }
        .data(),
    };
    assert_fails_with(
        env.send(&[wrapped], &[&kp]),
        FadeError::ForbiddenComposition,
    );
}

use anchor_lang::{InstructionData, ToAccountMetas};

#[test]
fn compute_units_of_every_instruction() {
    // Measured, to replace the estimates of Spec 08 §9. Printed with --nocapture.
    let mut env = Env::new();
    let a = env.found(5_000 * USDC);
    let b = env.user(1_000 * USDC);
    let kp = b.kp.insecure_clone();
    let ix = env.request_deposit_ix(&b, 100 * USDC);
    let opening = env.send(&[ix], &[&kp]).unwrap().compute_units_consumed;
    let c = env.user(1_000 * USDC);
    let kc = c.kp.insecure_clone();
    let ix = env.request_deposit_ix(&c, 100 * USDC);
    let joining = env.send(&[ix], &[&kc]).unwrap().compute_units_consumed;
    let ka = a.kp.insecure_clone();
    let ix = env.request_withdraw_ix(&a, 10 * SHARE);
    let withdraw = env.send(&[ix], &[&ka]).unwrap().compute_units_consumed;
    env.pass_close();
    let epoch = env.queue().current.epoch_id;
    let ix = env.strike_ix(&env.keeper.pubkey());
    let keeper = env.keeper.insecure_clone();
    let strike = env.send(&[ix], &[&keeper]).unwrap().compute_units_consumed;
    let claim_d = env
        .claim_deposit(&b.key(), epoch)
        .unwrap()
        .compute_units_consumed;
    let claim_w = env
        .claim_withdraw(&a.key(), epoch, epoch)
        .unwrap()
        .compute_units_consumed;
    let player = env.user(1_000 * USDC);
    let ticket = env
        .open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
    let open = {
        let args = OpenArgs::direct(&env, &player, 25 * USDC, &coin_flip(), 0);
        let ix = env.open_ticket_ix(&args);
        let kp = player.kp.insecure_clone();
        env.send(&[ix], &[&kp]).unwrap().compute_units_consumed
    };
    env.advance(2, 1);
    let request = env.request_address(&ticket);
    let ix = env.request_randomness_ix(&keeper.pubkey(), &ticket, &request);
    let randomness = env.send(&[ix], &[&keeper]).unwrap().compute_units_consumed;
    let r = env.randomness_for(&ticket, 1);
    env.fulfill(&request, r);
    let settle = env.settle(&ticket).unwrap().compute_units_consumed;
    for (name, cu) in [
        ("request_deposit, opening an epoch", opening),
        ("request_deposit, joining it", joining),
        ("request_withdraw", withdraw),
        ("strike_epoch", strike),
        ("claim_deposit", claim_d),
        ("claim_withdraw", claim_w),
        ("open_ticket (2 outcomes, record exists)", open),
        ("request_randomness (with the ORAO CPI)", randomness),
        ("settle_ticket (2 outcomes)", settle),
    ] {
        eprintln!("CU {name}: {cu}");
        assert!(cu < 200_000, "{name}: {cu}");
    }
}

#[test]
fn shares_worth_nothing_are_burnt_and_leave_no_epoch_behind() {
    let mut env = Env::new();
    let a = env.found(5_000 * USDC);
    // A few share units, worth less than a micro-USDC, moved to a fresh wallet
    // that withdraws its whole balance.
    let dust = env.user(0);
    let mint = env.a.share_mint;
    let held = env.balance(&a.shares());
    token::write_token_account(&mut env.svm, a.shares(), &mint, &a.key(), held - 500);
    token::write_token_account(&mut env.svm, dust.shares(), &mint, &dust.key(), 500);
    let epoch = env.withdraw(&dust, 500).unwrap();
    env.pass_close();
    let fund = env.fund();
    env.strike().unwrap();
    let r = env.record(epoch);
    assert_eq!((r.assets_owed, r.assets_paid, r.shares_burnt), (0, 0, 500));
    assert_eq!(r.r_after, 0, "the chain ends at once");
    assert!(
        !env.queue().current.live,
        "nothing rolls, no epoch stays live"
    );
    assert_fails_with(env.strike(), FadeError::NoLiveEpoch);
    env.claim_withdraw(&dust.key(), epoch, epoch).unwrap();
    assert!(!env.exists(&env.withdraw_request_address(epoch, &dust.key())));
    assert!(!env.exists(&env.record_address(epoch)));
    assert!(
        env.fund() >= fund - 200_000,
        "one reward, the one the request paid for"
    );
}

/// Spec 08 §5: rations one micro-USDC short shrink `r` by a million each; the
/// second one splits the chain, and every request is still paid its share.
#[test]
fn a_chain_that_splits_pays_every_request_its_share() {
    let mut env = Env::new();
    let a = env.found(5_000 * USDC);
    let (b, c) = (env.user(5_000 * USDC), env.user(5_000 * USDC));
    let eb = env.deposit(&b, 5_000 * USDC).unwrap();
    assert_eq!(env.deposit(&c, 5_000 * USDC).unwrap(), eb);
    env.pass_close();
    env.strike().unwrap();
    env.claim_deposit(&b.key(), eb).unwrap();
    env.claim_deposit(&c.key(), eb).unwrap();
    let (sa, sb, sc) = (
        env.balance(&a.shares()),
        env.balance(&b.shares()),
        env.balance(&c.shares()),
    );
    let price = |env: &Env, s: u64| {
        let p = env.vault();
        fade_math::shares::assets_for_shares(s, p.total_shares, p.total_assets).unwrap()
    };
    let (va, vb, vc) = (price(&env, sa), price(&env, sb), price(&env, sc));

    // Epoch 1: A withdraws everything, one micro-USDC more than may leave.
    let e1 = env.withdraw(&a, sa).unwrap();
    env.pass_close();
    env.pin_withdrawable(va - 1);
    env.strike().unwrap();
    env.set_vault(|p| p.total_reserved_liability = 0);
    let r1 = env.record(e1);
    assert!(
        r1.r_after >= fade_math::shares::CHAIN_R_MIN,
        "one ration never splits"
    );
    // Epoch 2: B joins the rolled shares, and the same shortfall splits the chain.
    let e2 = env.withdraw(&b, sb).unwrap();
    assert_eq!(e2, e1 + 1);
    env.pass_close();
    let owed2 = price(&env, env.queue().current.withdraw_shares);
    env.pin_withdrawable(owed2 - 1);
    env.strike().unwrap();
    env.set_vault(|p| p.total_reserved_liability = 0);
    let r2 = env.record(e2);
    assert!(
        r2.r_after > 0 && r2.r_after < fade_math::shares::CHAIN_R_MIN,
        "split"
    );
    assert_eq!(r2.chain_id, r1.chain_id);
    assert_eq!(r2.pending, 2, "A and B each read the split once");
    let q = env.queue();
    assert_eq!(
        (q.chain_id, q.chain_r, q.chain_requests),
        (e2, fade_math::shares::INDEX_SCALE, 2)
    );
    // Epoch 3: C joins, and everything is paid.
    let e3 = env.withdraw(&c, sc).unwrap();
    env.pass_close();
    env.strike().unwrap();
    let r3 = env.record(e3);
    assert_eq!(r3.r_after, 0);
    assert_eq!(r3.chain_id, e2, "the new chain");
    assert_eq!(r3.pending, 3);

    // A claims at the split (reading its entry too), then at the end; B the
    // same from its own record; C once.
    env.claim_withdraw(&a.key(), e1, e2).unwrap();
    assert!(
        !env.exists(&env.record_address(e1)),
        "A was the entry's only reader"
    );
    let w = env.read::<fade::state::WithdrawRequest>(&env.withdraw_request_address(e1, &a.key()));
    assert_eq!(
        (w.chain_id, w.r_entry, w.paid),
        (e2, fade_math::shares::INDEX_SCALE, 0)
    );
    // The split record belongs to the old chain: reading it twice is refused.
    assert_fails_with(env.claim_withdraw(&a.key(), e1, e2), FadeError::WrongRecord);
    env.claim_withdraw(&b.key(), e2, e2).unwrap();
    assert!(
        !env.exists(&env.record_address(e2)),
        "the split is released by both"
    );
    env.claim_withdraw(&a.key(), e1, e3).unwrap();
    env.claim_withdraw(&b.key(), e2, e3).unwrap();
    env.claim_withdraw(&c.key(), e3, e3).unwrap();
    assert!(!env.exists(&env.record_address(e3)));
    for (u, e) in [(&a, e1), (&b, e2), (&c, e3)] {
        assert!(!env.exists(&env.withdraw_request_address(e, &u.key())));
    }
    // Each is paid what its shares were worth, less the rounding Spec 08 §5
    // bounds: a unit per claim plus shares / CHAIN_R_MIN per strike read (B
    // entered at r ≈ 1e12 with 5e12 shares: 5 micro-USDC on 5 000 USDC).
    for (u, v, s) in [(&a, va, sa), (&b, vb, sb), (&c, vc, sc)] {
        let got = env.balance(&u.usdc);
        let bound = 2 + 2 * u128::from(s) / fade_math::shares::CHAIN_R_MIN;
        assert!(got <= v && u128::from(v - got) <= bound, "{got} vs {v}");
    }
    assert!(
        env.balance(&env.a.payable) <= 6,
        "{}",
        env.balance(&env.a.payable)
    );
    assert_eq!(env.vault().total_shares, 0);
}

#[test]
fn a_claim_parks_when_the_owner_account_cannot_receive_and_delivers_later() {
    let mut env = Env::new();
    let a = env.found(5_000 * USDC);
    // A deposit whose share account the owner closed after the request.
    let b = env.user(1_000 * USDC);
    let e = env.deposit(&b, 1_000 * USDC).unwrap();
    // And a withdrawal whose USDC account is frozen when claimed.
    let sa = env.balance(&a.shares());
    assert_eq!(env.withdraw(&a, sa / 2).unwrap(), e);
    env.pass_close();
    env.strike().unwrap();
    let rent_payer = env.record(e).rent_payer;
    assert_eq!(rent_payer, pk(env.a.queue), "the fund advanced the rent");
    env.svm.set_account(b.shares(), Default::default()).unwrap();
    env.set_token_state(&a.usdc, 2);
    let a_before = env.balance(&a.usdc);

    let keeper_before = env.lamports(&env.keeper.pubkey());
    env.claim_deposit(&b.key(), e).unwrap();
    env.claim_withdraw(&a.key(), e, e).unwrap();
    // Both claims did their bookkeeping: the record is released and closed,
    // its rent back to the fund, and the keeper was paid both fees.
    assert!(!env.exists(&env.record_address(e)));
    assert!(env.lamports(&env.keeper.pubkey()) > keeper_before);
    let d = env.read::<fade::state::DepositRequest>(&env.deposit_request_address(e, &b.key()));
    let w = env.read::<fade::state::WithdrawRequest>(&env.withdraw_request_address(e, &a.key()));
    assert!(d.parked && d.shares_due > 0);
    assert!(w.parked && w.undelivered > 0);
    assert_eq!(env.balance(&a.usdc), a_before);
    // Nothing is delivered while the accounts still cannot receive.
    assert_fails_with(
        env.claim_withdraw(&a.key(), e, e),
        FadeError::DestinationUnusable,
    );
    assert_fails_with(
        env.claim_deposit(&b.key(), e),
        FadeError::DestinationUnusable,
    );
    // Once they can, anyone delivers, and the requests close to their owners.
    env.set_token_state(&a.usdc, 1);
    let mint = env.a.share_mint;
    token::write_token_account(&mut env.svm, b.shares(), &mint, &b.key(), 0);
    env.claim_deposit(&b.key(), e).unwrap();
    env.claim_withdraw(&a.key(), e, e).unwrap();
    assert_eq!(env.balance(&b.shares()), d.shares_due);
    assert_eq!(env.balance(&a.usdc), a_before + w.undelivered);
    assert!(!env.exists(&env.deposit_request_address(e, &b.key())));
    assert!(!env.exists(&env.withdraw_request_address(e, &a.key())));
}

#[test]
fn a_ticket_opened_after_the_close_leaves_the_price_alone_even_once_settled() {
    // The same epoch struck three ways: the post-close ticket still open, lost
    // by its player before the strike, won by its player before the strike.
    let mut prices = Vec::new();
    for outcome in [None, Some(0usize), Some(1usize)] {
        let mut env = Env::new();
        let a = env.found(5_000 * USDC);
        let b = env.user(1_000 * USDC);
        let e = env.deposit(&b, 1_000 * USDC).unwrap();
        let sa = env.balance(&a.shares());
        env.withdraw(&a, sa / 4).unwrap();
        env.pass_close();
        let player = env.user(1_000 * USDC);
        let ticket = env
            .open_direct(&player, 25 * USDC, &coin_flip(), 0)
            .unwrap();
        if let Some(outcome) = outcome {
            let request = env.request_randomness(&ticket).unwrap();
            let r = env.randomness_for(&ticket, outcome);
            env.fulfill(&request, r);
            env.settle(&ticket).unwrap();
        }
        env.strike().unwrap();
        let r = env.record(e);
        prices.push((
            r.total_assets,
            r.total_shares,
            r.shares_minted,
            r.assets_paid,
        ));
        assert_eq!(env.vault().after_close_gain, 0);
        assert_eq!(env.vault().after_close_loss, 0);
    }
    assert_eq!(prices[0], prices[1], "a loss settled before the strike");
    assert_eq!(prices[0], prices[2], "a win settled before the strike");
}

#[test]
fn a_prefunded_record_takes_only_its_rent_from_the_fund() {
    let mut env = Env::new();
    let a = env.found(5_000 * USDC);
    let sa = env.balance(&a.shares());
    let e = env.withdraw(&a, sa / 2).unwrap();
    env.pass_close();
    let donation = 40_000_000u64;
    env.svm.airdrop(&env.record_address(e), donation).unwrap();
    let fund = env.fund();
    env.strike().unwrap();
    assert_eq!(fund - env.fund(), record_rent(&env) + 200_000);
    assert_eq!(env.lamports(&env.record_address(e)), donation);
    // The donation goes to the rent payer — the fund — when the record closes.
    let fund = env.fund();
    env.claim_withdraw(&a.key(), e, e).unwrap();
    assert_eq!(env.fund(), fund + donation);
}

#[test]
fn an_owner_whose_account_was_handed_away_takes_a_parked_claim_elsewhere() {
    let mut env = Env::new();
    let a = env.found(5_000 * USDC);
    let b = env.user(1_000 * USDC);
    let e = env.deposit(&b, 1_000 * USDC).unwrap();
    let sa = env.balance(&a.shares());
    env.withdraw(&a, sa / 2).unwrap();
    env.pass_close();
    env.strike().unwrap();
    // Both canonical accounts now belong to someone else (legacy SPL tokens
    // allow SetAuthority(AccountOwner) on an associated token account).
    let thief = Address::new_unique();
    let mint = env.a.share_mint;
    token::write_token_account(&mut env.svm, b.shares(), &mint, &thief, 0);
    let usdc_mint = env.a.usdc_mint;
    let held = env.balance(&a.usdc);
    token::write_token_account(&mut env.svm, a.usdc, &usdc_mint, &thief, held);
    env.claim_deposit(&b.key(), e).unwrap();
    env.claim_withdraw(&a.key(), e, e).unwrap();
    assert!(
        !env.exists(&env.record_address(e)),
        "the records are released"
    );
    let owed = env
        .read::<fade::state::WithdrawRequest>(&env.withdraw_request_address(e, &a.key()))
        .undelivered;
    let due = env
        .read::<fade::state::DepositRequest>(&env.deposit_request_address(e, &b.key()))
        .shares_due;
    // Nobody can deliver to the canonical accounts any more.
    assert_fails_with(
        env.claim_withdraw(&a.key(), e, e),
        FadeError::DestinationUnusable,
    );
    // Another account of the owner's, without the owner's signature: refused.
    let a_new = Address::new_unique();
    token::write_token_account(&mut env.svm, a_new, &usdc_mint, &a.key(), 0);
    let keeper = env.keeper.insecure_clone();
    let request = env.withdraw_request_address(e, &a.key());
    let unsigned = env.claim_withdraw_ix_with(
        &keeper.pubkey(),
        &a.key(),
        &request,
        None,
        None,
        None,
        None,
        Some(pk(a_new)),
    );
    assert_fails_with(env.send(&[unsigned], &[&keeper]), FadeError::WrongOwner);
    // An account the owner does not own, even signed: refused.
    let elsewhere = Address::new_unique();
    token::write_token_account(&mut env.svm, elsewhere, &usdc_mint, &thief, 0);
    let mut ix = env.claim_withdraw_ix_with(
        &a.key(),
        &a.key(),
        &request,
        None,
        None,
        None,
        None,
        Some(pk(elsewhere)),
    );
    let ka = a.kp.insecure_clone();
    assert_fails_with(
        env.send(&[ix.clone()], &[&ka]),
        FadeError::DestinationUnusable,
    );
    // Signed, to its own account: delivered, and the request closes.
    ix = env.claim_withdraw_ix_with(
        &a.key(),
        &a.key(),
        &request,
        None,
        None,
        None,
        None,
        Some(pk(a_new)),
    );
    env.send(&[ix], &[&ka]).unwrap();
    assert_eq!(env.balance(&a_new), owed);
    assert!(!env.exists(&request));
    // The same for the deposit.
    let b_new = Address::new_unique();
    token::write_token_account(&mut env.svm, b_new, &mint, &b.key(), 0);
    let ix = env.claim_deposit_ix_to(&b.key(), &b.key(), e, Some(pk(b_new)));
    let kb = b.kp.insecure_clone();
    env.send(&[ix], &[&kb]).unwrap();
    assert_eq!(env.balance(&b_new), due);
    assert!(!env.exists(&env.deposit_request_address(e, &b.key())));
}

#[test]
fn another_destination_is_only_for_a_parked_request() {
    let mut env = Env::new();
    let a = env.found(5_000 * USDC);
    let sa = env.balance(&a.shares());
    let e = env.withdraw(&a, sa / 2).unwrap();
    env.pass_close();
    env.strike().unwrap();
    let other = Address::new_unique();
    let usdc_mint = env.a.usdc_mint;
    token::write_token_account(&mut env.svm, other, &usdc_mint, &a.key(), 0);
    let request = env.withdraw_request_address(e, &a.key());
    let receiver = Some(env.record(e).rent_payer);
    let ix = env.claim_withdraw_ix_with(
        &a.key(),
        &a.key(),
        &request,
        Some(pk(env.record_address(e))),
        None,
        receiver,
        None,
        Some(pk(other)),
    );
    let ka = a.kp.insecure_clone();
    assert_fails_with(env.send(&[ix], &[&ka]), FadeError::DestinationUnusable);
}

/// Spec 08 §8 and §12.9: a strike that clears at a price leaving out an
/// after-close loss moves the settled price by its flows alone; that is not a
/// drawdown.
#[test]
fn a_withdrawal_strike_after_an_after_close_loss_leaves_the_breaker_alone() {
    let mut env = Env::new();
    let a = env.found(5_000 * USDC);
    let b = env.user(5_000 * USDC);
    let e = env.deposit(&b, 5_000 * USDC).unwrap();
    env.pass_close();
    env.strike().unwrap();
    env.claim_deposit(&b.key(), e).unwrap();
    let sa = env.balance(&a.shares());
    // A withdraws half its shares (a quarter of the vault); after the close,
    // players win 12 % of the vault on tickets opened after it (injected here).
    env.withdraw(&a, sa / 2).unwrap();
    env.pass_close();
    let loss = env.vault().total_assets * 12 / 100;
    env.set_vault(|p| {
        p.total_assets -= loss;
        p.after_close_loss = loss;
    });
    env.strike().unwrap();
    let player = env.user(1_000 * USDC);
    env.open_direct(&player, 25 * USDC, &coin_flip(), 0)
        .unwrap();
}
