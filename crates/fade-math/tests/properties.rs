//! Property tests: the invariants every implementation of these functions must keep.

use fade_math::payout_table::{self, Outcome};
use fade_math::risk::{self, Integrator, Params, Ticket, Vault};
use fade_math::{select, shares, slot_hashes, BPS, MAX_OUTCOMES, M_CEILING_BPS, P_SCALE};
use num_bigint::BigUint;
use num_rational::Ratio;
use proptest::prelude::*;

/// A well-formed payout table: probabilities that sum to exactly P_SCALE.
fn payout_table() -> impl Strategy<Value = Vec<Outcome>> {
    (1usize..=MAX_OUTCOMES).prop_flat_map(|n| {
        (
            proptest::collection::vec(1u64..=P_SCALE, n),
            proptest::collection::vec(0u64..=M_CEILING_BPS, n),
        )
            .prop_map(|(weights, ms)| {
                // normalise weights to sum exactly to P_SCALE, keeping every p ≥ 1
                let total: u128 = weights.iter().map(|&w| u128::from(w)).sum();
                let n = weights.len() as u64;
                let mut ps: Vec<u64> = weights
                    .iter()
                    .map(|&w| (u128::from(w) * u128::from(P_SCALE - n) / total) as u64 + 1)
                    .collect();
                let sum: u64 = ps.iter().sum();
                let last = ps.len() - 1;
                ps[last] = ps[last] + P_SCALE - sum;
                ps.into_iter()
                    .zip(ms)
                    .map(|(p, m)| Outcome { p, m })
                    .collect()
            })
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn validate_never_panics_on_arbitrary_input(outcomes in proptest::collection::vec((any::<u64>(), any::<u64>()), 0..40)) {
        let b: Vec<Outcome> = outcomes.into_iter().map(|(p, m)| Outcome { p, m }).collect();
        let _ = payout_table::validate(&b);
    }

    #[test]
    fn well_formed_payout_tables_validate_and_the_ev_check_is_exact(outcomes in payout_table(), margin in 0u64..=BPS) {
        let s = payout_table::validate(&outcomes).unwrap();
        prop_assert_eq!(s.cum[s.len - 1], P_SCALE);
        // exact rational comparison: Σ p/P_SCALE · m/BPS ≤ 1 − margin/BPS
        let lhs: Ratio<BigUint> = outcomes.iter().map(|b| Ratio::new(BigUint::from(b.p) * BigUint::from(b.m), BigUint::from(P_SCALE) * BigUint::from(BPS))).sum();
        let rhs = Ratio::new(BigUint::from(BPS - margin), BigUint::from(BPS));
        prop_assert_eq!(payout_table::ev_ok(s.lhs, margin), lhs <= rhs);
        // the declared margin is the largest margin the payout table passes
        if let Some(e) = payout_table::margin_bps(s.lhs) {
            prop_assert!(payout_table::ev_ok(s.lhs, e));
            prop_assert!(e == BPS || !payout_table::ev_ok(s.lhs, e + 1));
        }
    }

    #[test]
    fn every_draw_lands_in_a_outcome_with_the_right_measure(outcomes in payout_table(), r in 0u64..P_SCALE) {
        let s = payout_table::validate(&outcomes).unwrap();
        let k = select::outcome(r, &s.cum, s.len).unwrap();
        let lower = if k == 0 { 0 } else { s.cum[k - 1] };
        prop_assert!(lower <= r && r < s.cum[k]);
        prop_assert_eq!(s.cum[k] - lower, outcomes[k].p);
    }

    #[test]
    fn reduce_word_is_uniform_on_accepted_words(word in any::<u128>()) {
        match select::reduce_word(word.to_le_bytes()) {
            Some(r) => { prop_assert!(r < P_SCALE); prop_assert_eq!(u128::from(r), word % u128::from(P_SCALE)); }
            None => prop_assert!(word >= select::LIMIT),
        }
    }

    #[test]
    fn payout_never_exceeds_price_times_multiplier(price in 0u64..=10_000_000_000, m in 0u64..=M_CEILING_BPS) {
        let p = payout_table::payout(price, m).unwrap();
        let exact = u128::from(price) * u128::from(m);
        prop_assert!(u128::from(p) * u128::from(BPS) <= exact);
        prop_assert!(exact - u128::from(p) * u128::from(BPS) < u128::from(BPS));
    }

    #[test]
    fn shares_round_down_and_never_create_value(
        s in 0u64..=1_000_000_000_000_000, a in 0u64..=1_000_000_000_000_000, x in 0u64..=1_000_000_000_000
    ) {
        let minted = shares::shares_for_assets(x, s, a).unwrap();
        // the assets those shares can claim back never exceed what was deposited
        let back = shares::assets_for_shares(minted, s + minted, a + x).unwrap();
        prop_assert!(back <= x, "deposited {x}, minted {minted}, can withdraw {back}");
        // withdrawing then depositing the proceeds never ends with more shares
        let paid = shares::assets_for_shares(x.min(s), s, a).unwrap();
        let re = shares::shares_for_assets(paid, s - x.min(s), a - paid.min(a)).unwrap_or(0);
        prop_assert!(re <= x.min(s));
    }

    #[test]
    fn admission_keeps_the_solvency_identities(
        assets in 0u64..=10_000_000_000_000, reserved_bps in 0u64..=BPS, open_bps in 0u64..=BPS,
        held in 0u64..=10_000_000_000_000, price in 0u64..=20_000_000_000, m in 0u64..=M_CEILING_BPS, margin in 0u64..=BPS,
        halved in any::<bool>()
    ) {
        let reserved = (u128::from(assets) * u128::from(reserved_bps) / u128::from(BPS)) as u64;
        let open = (u128::from(assets) * u128::from(open_bps) / u128::from(BPS) / 4) as u64;
        let vault = Vault { assets, reserved, open_credits: open };
        let w = Ticket { price, vault_credit: price - price / 200, payout_max: payout_table::payout(price, m).unwrap_or(u64::MAX) };
        let integrator = Integrator { reserved: held, volume_total: 0 };
        if let Ok(a) = risk::admit(&vault, &integrator, &Params::SPEC, &w, margin, halved) {
            let after = a.vault_after;
            prop_assert!(after.reserved as u128 + after.open_credits as u128 <= after.assets as u128, "gross solvency");
            prop_assert!(after.reserved as u128 * BPS as u128 <= after.assets as u128 * Params::SPEC.kappa_bps as u128, "kappa");
            prop_assert!(a.liability <= a.cap);
            // the integrator ceiling: 20 % of the assets before the ticket, the new ticket included
            prop_assert!(u128::from(held) + u128::from(a.liability)
                <= u128::from(assets) * u128::from(Params::SPEC.whale_bps) / u128::from(BPS));
            if halved { prop_assert!(a.cap <= risk::per_ticket_cap(&vault, margin, &Params::SPEC, false).unwrap() / 2); }
            prop_assert_eq!(after.assets, assets + w.vault_credit);
        }
    }

    #[test]
    fn max_admissible_price_is_exactly_the_last_price_admitted(
        assets in 0u64..=10_000_000_000_000, reserved_bps in 0u64..=BPS, open_bps in 0u64..=BPS,
        held in 0u64..=10_000_000_000_000, m in 0u64..=M_CEILING_BPS, app_share in 0u64..=500, margin in 0u64..=BPS,
        halved in any::<bool>()
    ) {
        let reserved = (u128::from(assets) * u128::from(reserved_bps) / u128::from(BPS)) as u64;
        let open = (u128::from(assets) * u128::from(open_bps) / u128::from(BPS) / 4) as u64;
        let vault = Vault { assets, reserved, open_credits: open };
        let integrator = Integrator { reserved: held, volume_total: 0 };
        let p = Params::SPEC;
        let admits = |s: u64| risk::ticket_for(s, m, app_share, &p)
            .and_then(|w| risk::admit(&vault, &integrator, &p, &w, margin, halved)).is_ok();
        match risk::max_admissible_price(&vault, &integrator, &p, m, app_share, margin, halved) {
            Ok(s) => {
                prop_assert!(admits(s), "returned a ticket price that admission refuses");
                if s < p.max_price {
                    prop_assert!(!admits(s + 1), "a larger ticket price is still admitted");
                }
            }
            Err(e) => {
                let at_floor = risk::ticket_for(p.min_price, m, app_share, &p)
                    .and_then(|w| risk::admit(&vault, &integrator, &p, &w, margin, halved));
                prop_assert_eq!(at_floor.map(|_| ()).err(), Some(e), "not the reason the floor gets");
            }
        }
    }

    #[test]
    fn admission_is_monotone_in_the_price(
        assets in 0u64..=10_000_000_000_000, reserved_bps in 0u64..=BPS,
        held in 0u64..=10_000_000_000_000, m in 0u64..=M_CEILING_BPS, app_share in 0u64..=500,
        margin in 0u64..=BPS, big in 25_000_000u64..=10_000_000_000, frac in 0u64..=BPS
    ) {
        // The property the search in `max_admissible_price` rests on: the ticket prices
        // admission accepts are an interval starting at the minimum, never a
        // scattered set. Refuting this refutes the function above with it.
        let reserved = (u128::from(assets) * u128::from(reserved_bps) / u128::from(BPS)) as u64;
        let vault = Vault { assets, reserved, open_credits: 0 };
        let integrator = Integrator { reserved: held, volume_total: 0 };
        let p = Params::SPEC;
        let admits = |s: u64| risk::ticket_for(s, m, app_share, &p)
            .and_then(|w| risk::admit(&vault, &integrator, &p, &w, margin, false)).is_ok();
        let smaller = p.min_price
            + (u128::from(big - p.min_price) * u128::from(frac) / u128::from(BPS)) as u64;
        if admits(big) {
            prop_assert!(admits(smaller), "a smaller ticket price was refused where a larger one passed");
        }
    }

    #[test]
    fn first_after_finds_the_oldest_retained_slot_after_t(
        newest in 0u64..=1_000_000, gaps in proptest::collection::vec(1u64..=4, 0..=511), t in 0u64..=1_000_100
    ) {
        // descending slots with random gaps
        let mut slots = vec![newest];
        for g in gaps { let next = slots.last().unwrap().saturating_sub(g); if next == *slots.last().unwrap() { break; } slots.push(next); }
        let mut data = Vec::new();
        data.extend_from_slice(&(slots.len() as u64).to_le_bytes());
        for s in &slots { data.extend_from_slice(&s.to_le_bytes()); data.extend_from_slice(&[0u8; 32]); }
        let expected = slots.iter().copied().filter(|&s| s > t).min();
        prop_assert_eq!(slot_hashes::first_after(&data, t).map(|e| e.slot), expected);
    }

    /// With κ at or above the program's floor (`MIN_KAPPA_BPS`, 0.8), the
    /// strike never holds back more than `max(committed, ceil(1.25 · reserved))`,
    /// the bound Spec 01 §4.3 states for κ = 0.8.
    #[test]
    fn withdrawals_are_held_back_at_most_a_quarter_above_the_reservation(
        assets in 0u64..=u64::MAX / 2,
        reserved in 0u64..=u64::MAX / 4,
        open_credits in 0u64..=u64::MAX / 4,
        kappa_bps in KAPPA_FLOOR_BPS..=BPS,
    ) {
        let params = Params { kappa_bps, ..Params::SPEC };
        let vault = Vault { assets, reserved, open_credits };
        let committed = reserved + open_credits;
        let quarter_above = u64::try_from((u128::from(reserved) * 5).div_ceil(4)).unwrap();
        let bound = assets.saturating_sub(committed.max(quarter_above));
        prop_assert!(risk::withdrawable(&vault, &params) >= bound);
    }
}

/// The program's `MIN_KAPPA_BPS` (programs/fade/src/constants.rs).
const KAPPA_FLOOR_BPS: u64 = 8_000;

#[test]
fn boundary_exact_payout_table_is_rejected_by_floating_point_but_not_by_us() {
    // The exact table sits on the boundary: Σ p·m = 0.985 · P_SCALE · BPS exactly.
    let table = [
        Outcome {
            p: 197_000_000,
            m: 50_000,
        },
        Outcome {
            p: 803_000_000,
            m: 0,
        },
    ];
    let s = payout_table::validate(&table).unwrap();
    assert!(payout_table::ev_ok(s.lhs, 150));
    // A float formulation gets this wrong, which is why the check is integer-only.
    #[allow(clippy::float_arithmetic)]
    let float_ev: f64 = table
        .iter()
        .map(|b| (b.p as f64 / P_SCALE as f64) * (b.m as f64 / BPS as f64))
        .sum();
    #[allow(clippy::float_arithmetic)]
    let float_ok = float_ev <= 1.0 - 150.0 / BPS as f64;
    assert!(!float_ok, "float64 accepted the boundary table this time; the integer path is still the only one allowed");
}

/// One step of the epoch model: time advances, then something happens.
#[derive(Debug, Clone)]
enum Op {
    OpenTicket,
    CloseTicket(usize),
    Request,
    Strike,
}

fn op() -> impl Strategy<Value = (i64, Op)> {
    (
        0i64..=400,
        prop_oneof![
            3 => Just(Op::OpenTicket),
            3 => any::<usize>().prop_map(Op::CloseTicket),
            2 => Just(Op::Request),
            2 => Just(Op::Strike),
        ],
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn the_counters_know_exactly_when_a_strike_is_clean(steps in proptest::collection::vec(op(), 1..200)) {
        use fade_math::epoch::{self, Counters, Join};
        const L: i64 = 600;
        let mut c = Counters::default();
        let mut now = 1_700_000_000i64;
        let mut current: Option<i64> = None; // the live epoch's close
        let mut next = false;
        // ground truth: open tickets as (opened at, side, generation)
        let mut open: Vec<(i64, epoch::Side, u32)> = Vec::new();
        let mut strikes = 0;
        for (dt, o) in steps {
            now += dt;
            match o {
                Op::OpenTicket => {
                    let (side, g) = c.open(now).unwrap();
                    open.push((now, side, g));
                }
                Op::CloseTicket(i) if !open.is_empty() => {
                    let (_, side, g) = open.remove(i % open.len());
                    c.close(side, g).unwrap();
                }
                Op::CloseTicket(_) => {}
                Op::Request => match epoch::join(current.is_some(), current.unwrap_or(0), now) {
                    Join::Open => {
                        let close = epoch::close_ts(now, L).unwrap();
                        c.roll(close).unwrap();
                        current = Some(close);
                    }
                    Join::Current => {}
                    Join::Next => next = true,
                },
                Op::Strike => {
                    let close = current.unwrap_or(0);
                    let truth = current.is_some()
                        && now >= close
                        && open.iter().all(|&(t, _, _)| t >= close);
                    prop_assert_eq!(epoch::can_strike(current.is_some(), close, now, &c), truth);
                    if truth {
                        strikes += 1;
                        if next {
                            let close = epoch::close_ts(now, L).unwrap();
                            c.roll(close).unwrap();
                            current = Some(close);
                            next = false;
                        } else {
                            c.clear_close();
                            current = None;
                        }
                    }
                }
            }
            // conservation: the two counters hold every open ticket, nothing else
            prop_assert_eq!(u64::from(c.before) + u64::from(c.after), open.len() as u64);
            if let Some(close) = current {
                let before = open.iter().filter(|&&(t, _, _)| t < close).count() as u32;
                prop_assert_eq!(c.before, before);
            }
        }
        let _ = strikes;
    }

    #[test]
    fn chain_claims_never_pay_more_than_the_strikes(
        start_shares in 1_000_000_000_000u64..=10_000_000_000_000_000,
        price_mil in 500u64..=3_000,
        rounds in proptest::collection::vec((proptest::collection::vec(1_000_000_000u64..=1_000_000_000_000_000, 0..4), 0u64..=10_000), 1..10)
    ) {
        use fade_math::shares::{self as sh, Chain};
        let mut s_total = start_shares;
        let mut assets = (u128::from(start_shares) * u128::from(price_mil) / 1_000_000) as u64;
        let mut chain = Chain::START;
        let mut rolled = 0u64;
        let mut entries: Vec<(u64, Chain)> = Vec::new();
        let mut paid_total = 0u64;
        for (k, (new, fill_bps)) in rounds.iter().enumerate() {
            let before = chain;
            let mut w = rolled;
            for &s in new {
                let s = s.min(s_total.saturating_sub(w));
                if s == 0 { continue; }
                entries.push((s, before));
                w += s;
            }
            let last = k + 1 == rounds.len();
            let owed = sh::assets_for_shares(w, s_total, assets).unwrap();
            let avail = if last { owed } else { (u128::from(owed) * u128::from(*fill_bps) / 10_000) as u64 };
            let st = sh::strike(0, w, s_total, assets, avail).unwrap();
            chain = chain.advance(w, st.shares_burnt, st.assets_paid).unwrap();
            paid_total += st.assets_paid;
            s_total -= st.shares_burnt;
            assets -= st.assets_paid;
            rolled = w - st.shares_burnt;
            if chain.ended() { break; }
        }
        let mut due_total = 0u64;
        for (s, at) in &entries {
            let due = sh::withdraw_due(*s, at.r, at.v, chain.v).unwrap();
            // monotone in the index: a partial claim never pays more than the final one
            let half = sh::withdraw_due(*s, at.r, at.v, at.v + (chain.v - at.v) / 2).unwrap();
            prop_assert!(half <= due);
            due_total += due;
        }
        prop_assert!(due_total <= paid_total, "claims {} > paid {}", due_total, paid_total);
        if chain.ended() {
            prop_assert_eq!(rolled, 0);
        }
    }

    /// Spec 08 §5 end to end: requests enter a chain at random strikes, strikes
    /// ration anywhere from nothing to one micro-USDC short of full, and every
    /// request claims the way `claim_withdraw` does — transitions at splits, one
    /// final claim at the end. Each request is paid its exact pro-rata share of
    /// what the strikes moved, less rounding bounded per strike, and never more.
    #[test]
    fn chain_claims_pay_the_exact_pro_rata_through_splits(
        start_shares in 10_000_000_000_000u64..=10_000_000_000_000_000_000,
        rounds in proptest::collection::vec((
            proptest::collection::vec(1_000_000_000u64..=1_000_000_000_000_000_000, 0..4),
            prop_oneof![0u64..=10_000, Just(10_001u64), Just(10_002u64)],
        ), 1..24)
    ) {
        use fade_math::shares::{self as sh, Chain};
        struct Req { shares: u64, entry: Chain, paid: u64, received: u64, truth: f64, left: f64 }
        let mut s_total = start_shares;
        let mut assets = start_shares / 1_000;
        let mut chain = Chain::START;
        let mut rolled = 0u64;
        let mut live: Vec<Req> = Vec::new();
        let mut done: Vec<Req> = Vec::new();
        let mut paid_total = 0u64;
        let mut strikes = 0u64;
        let mut splits = 0u64;
        for (k, (new, fill)) in rounds.iter().enumerate() {
            let before = chain;
            let mut w = rolled;
            for &s in new {
                let s = s.min(s_total.saturating_sub(w));
                if s == 0 { continue; }
                live.push(Req { shares: s, entry: before, paid: 0, received: 0, truth: 0.0, left: s as f64 });
                w += s;
            }
            if w == 0 { continue; }
            let last = k + 1 == rounds.len();
            let owed = sh::assets_for_shares(w, s_total, assets).unwrap();
            // 10_001: one micro short of full; 10_002: nothing withdrawable.
            let avail = match (last, *fill) {
                (true, _) => owed,
                (_, 10_001) => owed.saturating_sub(1),
                (_, 10_002) => 0,
                (_, f) => (u128::from(owed) * u128::from(f) / 10_000) as u64,
            };
            let st = sh::strike(0, w, s_total, assets, avail).unwrap();
            strikes += 1;
            let after = chain.advance(w, st.shares_burnt, st.assets_paid).unwrap();
            // The chain ends exactly when the strike paid the whole queue.
            prop_assert_eq!(after.ended(), st.shares_burnt == w);
            for q in live.iter_mut() {
                q.truth += q.left * st.assets_paid as f64 / w as f64;
                q.left *= (w - st.shares_burnt) as f64 / w as f64;
            }
            paid_total += st.assets_paid;
            s_total -= st.shares_burnt;
            assets -= st.assets_paid;
            rolled = w - st.shares_burnt;
            if after.ended() || after.splits() {
                // Every request of the chain claims at this record: finally at
                // an end, as a transition into the next chain at a split.
                for q in live.iter_mut() {
                    let due = sh::withdraw_due(q.shares, q.entry.r, q.entry.v, after.v).unwrap();
                    q.received += due - q.paid;
                    q.shares = sh::still_queued(q.shares, q.entry.r, after.r).unwrap();
                    q.entry = Chain::START;
                    q.paid = 0;
                }
                chain = Chain::START;
                if after.ended() {
                    done.append(&mut live);
                    break;
                }
                splits += 1;
            } else {
                chain = after;
                prop_assert!(chain.r >= sh::CHAIN_R_MIN);
            }
        }
        let all: Vec<&Req> = done.iter().chain(live.iter()).collect();
        let received: u64 = all.iter().map(|q| q.received).sum();
        prop_assert!(received <= paid_total, "claims {} > paid {}", received, paid_total);
        for q in &all {
            // Rounding: a micro-USDC per strike plus shares / CHAIN_R_MIN per
            // strike and per split (a share is worth ~1e-3 micro-USDC here),
            // and the float model's own error.
            let per_step = 1.0 + q.truth * 1e3 / 1e12;
            let slack = (strikes + splits + 2) as f64 * per_step + q.truth * 1e-12;
            prop_assert!(q.received as f64 <= q.truth + 1.0 + q.truth * 1e-12,
                "overpaid {} > {}", q.received, q.truth);
            prop_assert!(q.received as f64 >= q.truth - slack,
                "underpaid {} < {} (slack {})", q.received, q.truth, slack);
        }
    }

    #[test]
    fn the_drawdown_ring_holds_the_24_hour_maximum(
        prices in proptest::collection::vec((0i64..=5_000, 1u128..=1_000_000_000_000_000_000u128), 1..100)
    ) {
        use fade_math::drawdown::{Ring, SECONDS_PER_HOUR};
        let mut now = 1_700_000_000i64;
        let mut price = 1_000_000_000_000_000u128;
        let mut ring = Ring::new(now, price);
        // (hour, price) history, the price holding until the next change
        let mut history: Vec<(i64, u128)> = vec![(now / SECONDS_PER_HOUR, price)];
        for (dt, p) in prices {
            now += dt;
            ring.observe(now, price, p);
            price = p;
            history.push((now / SECONDS_PER_HOUR, p));
            let h = now / SECONDS_PER_HOUR;
            // every price in force at some point of the last 24 hours
            let mut expected = 0u128;
            for (i, &(ht, pt)) in history.iter().enumerate() {
                let until = history.get(i + 1).map(|&(n, _)| n).unwrap_or(h);
                if until >= h - 23 && ht <= h { expected = expected.max(pt); }
            }
            prop_assert_eq!(ring.max(), expected);
        }
    }
}

/// The attack of the third review: rations one micro-USDC short, strike after
/// strike, then a large late entrant. Before the holdback and the split, `r`
/// fell to a few units and the late entrant was paid nothing.
#[test]
fn a_late_entrant_to_a_long_rationed_chain_is_paid_in_full() {
    use fade_math::shares::{self as sh, Chain};
    let mut s_total = 10_000_000_000_000_000_000u64;
    let mut assets = s_total / 1_000;
    let mut chain = Chain::START;
    let mut rolled = 0u64;
    let mut splits = 0;
    let attacker = 1_000_000_000_000_000u64;
    for _ in 0..6 {
        let w = rolled + attacker;
        let owed = sh::assets_for_shares(w, s_total, assets).unwrap();
        let st = sh::strike(0, w, s_total, assets, owed - 1).unwrap();
        let after = chain.advance(w, st.shares_burnt, st.assets_paid).unwrap();
        assert!(!after.ended(), "a rationed strike never ends the chain");
        s_total -= st.shares_burnt;
        assets -= st.assets_paid;
        rolled = w - st.shares_burnt;
        if after.splits() {
            splits += 1;
            chain = Chain::START;
        } else {
            chain = after;
        }
    }
    assert!(splits >= 2, "near-full rations split the chain");
    // The victim: 1e17 shares (~100 000 USDC) enter now and are paid in full.
    let victim = 100_000_000_000_000_000u64;
    let entry = chain;
    let w = rolled + victim;
    let st = sh::strike(0, w, s_total, assets, u64::MAX).unwrap();
    let end = chain.advance(w, st.shares_burnt, st.assets_paid).unwrap();
    assert!(end.ended());
    let due = sh::withdraw_due(victim, entry.r, entry.v, end.v).unwrap();
    let fair = u128::from(st.assets_paid) * u128::from(victim) / u128::from(w);
    assert!(
        u128::from(due) <= fair && fair - u128::from(due) <= 2,
        "{due} vs {fair}"
    );
}

// ---------------------------------------------------------------------------
// Shared beacon (Spec 08 §13.4 and §13.8): the arithmetic invariants of a
// round, over random terms and random sequences of joins and sponsorships,
// then a draw, a forfeiture or a refund.

mod beacon_props {
    use fade_math::beacon::{self, Book, Entry, Terms, USAGE_SCALE};
    use fade_math::epoch::{Counters, Side};
    use fade_math::Reject;
    use num_bigint::BigUint;
    use num_rational::Ratio;
    use proptest::prelude::*;

    fn big(v: u64) -> BigUint {
        BigUint::from(v)
    }

    /// Round terms the program could snapshot: a prefund from a fee, a pending
    /// rent and a request share, a threshold from one micro-USDC up.
    fn terms() -> impl Strategy<Value = (Terms, u64, u64, u64)> {
        (
            1u64..=20_000_000_000,
            1u64..=50_000_000,
            0u64..=50_000_000,
            0u64..=1_000_000,
            1u8..=3,
        )
            .prop_map(|(threshold, fee, rent, share, round_k)| {
                let draw_max = beacon::prefund(fee, rent, share).unwrap();
                (
                    Terms {
                        threshold,
                        draw_max,
                        round_k,
                    },
                    fee,
                    rent,
                    share,
                )
            })
    }

    #[derive(Debug, Clone)]
    enum Op {
        /// ticket price, liability as a share of the cap in 1e-6, cap, app share
        /// bps, sponsorship carried by the join
        Join(u64, u64, u64, u64, u64),
        Sponsor(u64),
    }

    fn op() -> impl Strategy<Value = Op> {
        prop_oneof![
            6 => (
                1u64..=5_000_000_000,
                0u64..=1_000_000,
                1u64..=2_000_000_000_000,
                0u64..=500,
                prop_oneof![3 => Just(0u64), 1 => 1u64..=20_000_000],
            )
                .prop_map(|(s, l, c, f, sp)| Op::Join(s, l, c, f, sp)),
            1 => (1u64..=20_000_000).prop_map(Op::Sponsor),
        ]
    }

    #[derive(Debug, Clone, Copy, PartialEq)]
    enum End {
        Draw,
        Forfeit,
        Refund,
    }

    fn entry_of(terms: &Terms, price: u64, l_ppm: u64, cap: u64, app_share_bps: u64) -> Entry {
        let liability = (u128::from(cap) * u128::from(l_ppm) / 1_000_000) as u64;
        let protocol_share = fade_math::payout_table::share_of(price, 20).unwrap();
        let app_share = fade_math::payout_table::share_of(price, app_share_bps).unwrap();
        Entry {
            price,
            vault_credit: price - protocol_share - app_share,
            liability,
            protocol_share,
            app_share,
            prepay: beacon::prepay(terms, price).unwrap(),
            usage: beacon::usage(liability, cap).unwrap(),
        }
    }

    /// `1 − h`, the share of its paid capacity an unpaid round may use.
    fn unpaid_share() -> Ratio<BigUint> {
        Ratio::new(
            big(fade_math::BPS - beacon::UNPAID_HEADROOM_BPS),
            big(fade_math::BPS),
        )
    }

    /// The exact room of a round: `k` caps once paid, `(1 − h) · k · (R / T +
    /// S / D)` before.
    fn exact_room(terms: &Terms, prices: u64, sponsorship: u64) -> Ratio<BigUint> {
        let paid = Ratio::new(big(prices), big(terms.threshold))
            + Ratio::new(big(sponsorship), big(terms.draw_max));
        let one = Ratio::from_integer(BigUint::from(1u8));
        let k = Ratio::from_integer(BigUint::from(terms.round_k));
        if paid >= one {
            k
        } else {
            k * unpaid_share() * paid
        }
    }

    /// Exact share of a round one join may take: `usage / USAGE_SCALE ≤
    /// k · min(1, price / T + sponsorship / D)`, or `h · k` if more when
    /// `pays_round` (the join that makes the round paid).
    fn exact_join_share(
        terms: &Terms,
        usage: u64,
        price: u64,
        sponsorship: u64,
        pays_round: bool,
    ) -> bool {
        let one = Ratio::from_integer(BigUint::from(1u8));
        let k = Ratio::from_integer(BigUint::from(terms.round_k));
        let share = Ratio::new(big(price), big(terms.threshold))
            + Ratio::new(big(sponsorship), big(terms.draw_max));
        let share = if share > one { one.clone() } else { share };
        let floor = k.clone() * (one - unpaid_share());
        let bound = if pays_round && floor > k.clone() * share.clone() {
            floor
        } else {
            k * share
        };
        Ratio::new(big(usage), big(USAGE_SCALE)) <= bound
    }

    /// Exact `Σ L_i / cap_i` within `exact_room`.
    fn exact_fits(terms: &Terms, tickets: &[(Entry, u64)], prices: u64, sponsorship: u64) -> bool {
        let used: Ratio<BigUint> = tickets
            .iter()
            .filter(|(e, _)| e.liability > 0)
            .map(|(e, cap)| Ratio::new(big(e.liability), big(*cap)))
            .sum();
        used <= exact_room(terms, prices, sponsorship)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1024))]

        #[test]
        fn a_round_keeps_capacity_charges_and_lamports_exact(
            (terms, fee, rent, share) in terms(),
            ops in proptest::collection::vec(op(), 1..40),
            end in prop_oneof![Just(End::Draw), Just(End::Forfeit), Just(End::Refund)],
            refund_frac in 0u64..=1_000,
        ) {
            let mut book = Book::default();
            let mut tickets: Vec<(Entry, u64)> = Vec::new();
            let mut sponsors: Vec<u64> = Vec::new();
            for o in ops {
                let before = book;
                match o {
                    Op::Join(price, l, cap, app_share_bps, sp) => {
                        let e = entry_of(&terms, price, l, cap, app_share_bps);
                        // usage rounds up, by less than one unit: the vault's side
                        prop_assert!(big(e.usage) * big(cap) >= big(e.liability) * big(USAGE_SCALE));
                        if e.usage > 0 {
                            prop_assert!(big(e.usage - 1) * big(cap) < big(e.liability) * big(USAGE_SCALE));
                        }
                        prop_assert!(e.usage <= USAGE_SCALE);
                        let mut with = tickets.clone();
                        with.push((e, cap));
                        let pays_round = !book.is_paid(&terms)
                            && beacon::is_paid(&terms, book.prices + price, book.sponsorship + sp);
                        match book.join(&terms, &e, sp).unwrap() {
                            Some(after) => {
                                // the rounded rule never admits what the exact rule refuses
                                prop_assert!(exact_fits(&terms, &with, after.prices, after.sponsorship));
                                // every join, paid round or not, takes at most its own
                                // share, the `h · k` floor only the paying join's
                                prop_assert!(exact_join_share(&terms, e.usage, price, sp, pays_round));
                                book = after;
                                tickets.push((e, cap));
                                if sp > 0 { sponsors.push(sp); }
                            }
                            None => {
                                prop_assert!(
                                    !beacon::fits(&terms, book.usage + e.usage, book.prices + price, book.sponsorship + sp)
                                        || !beacon::within_join_share(&terms, e.usage, price, sp, pays_round)
                                );
                            }
                        }
                    }
                    Op::Sponsor(l) => {
                        book = book.sponsor(l).unwrap();
                        sponsors.push(l);
                    }
                }
                // capacity never decreases, and the rule holds after every step
                prop_assert!(beacon::paid_units(&terms, book.prices, book.sponsorship)
                    >= beacon::paid_units(&terms, before.prices, before.sponsorship));
                prop_assert!(!before.is_paid(&terms) || book.is_paid(&terms));
                prop_assert!(book.fits(&terms));
                prop_assert!(exact_fits(&terms, &tickets, book.prices, book.sponsorship));
                // the aggregates equal their sums
                prop_assert_eq!(book.prepaid, tickets.iter().map(|w| w.0.prepay).sum::<u64>());
                prop_assert_eq!(book.prices, tickets.iter().map(|w| w.0.price).sum::<u64>());
                prop_assert_eq!(book.credits + book.protocol_shares + book.app_shares, book.prices);
                prop_assert_eq!(book.usage, tickets.iter().map(|w| w.0.usage).sum::<u64>());
                prop_assert_eq!(u64::from(book.tickets), tickets.len() as u64);
                prop_assert_eq!(book.sponsorship, sponsors.iter().sum::<u64>());
            }
            if tickets.is_empty() { return Ok(()); }

            // The round's end: a drawn or forfeited round was paid; an unpaid
            // one is refunded.
            let held = u128::from(book.prepaid) + u128::from(book.sponsorship);
            let end = if book.is_paid(&terms) { end } else { End::Refund };
            let cost = match end {
                End::Refund => 0,
                End::Draw | End::Forfeit => {
                    // the request is refused above the prefund: C ≤ D_r
                    prop_assume!(beacon::request_fits(fee, rent, share, terms.draw_max));
                    let refund = if end == End::Forfeit { 0 } else { rent * refund_frac / 1_000 };
                    beacon::draw_cost(fee + rent, share, refund).unwrap()
                }
            };
            prop_assert!(cost <= terms.draw_max);
            let drawn = end != End::Refund;
            let mut out = u128::from(cost);
            let mut charges = 0u128;
            for (e, _) in &tickets {
                let ch = if drawn { beacon::charge(cost, book.sponsorship, book.prices, e.price).unwrap() } else { 0 };
                // no ticket is charged more than it prepaid
                prop_assert!(ch <= e.prepay, "charge {} > prepay {}", ch, e.prepay);
                charges += u128::from(ch);
                out += u128::from(beacon::prepay_return(e.prepay, ch).unwrap());
            }
            let mut back = 0u128;
            for &a in &sponsors {
                back += u128::from(beacon::sponsor_return(cost, book.sponsorship, a, drawn).unwrap());
            }
            out += back;
            if drawn {
                // charges and the sponsors' part cover the draw
                prop_assert!(charges + u128::from(book.sponsorship) - back >= u128::from(cost));
            }
            // the round never pays out more than it holds; the dust it keeps for
            // its rent payer is under one lamport per ticket and per sponsor
            prop_assert!(out <= held, "out {} > held {}", out, held);
            prop_assert!(held - out <= (tickets.len() + sponsors.len()) as u128);
            if !drawn {
                prop_assert_eq!(out, held);
            }
        }

        #[test]
        fn fits_is_the_exact_rule_for_every_input(
            threshold in 1u64.., draw_max in 1u64.., round_k in 1u8..,
            usage in any::<u64>(), prices in any::<u64>(), sponsorship in any::<u64>(),
        ) {
            let t = Terms { threshold, draw_max, round_k };
            let exact = Ratio::from_integer(big(usage))
                <= exact_room(&t, prices, sponsorship) * Ratio::from_integer(big(USAGE_SCALE));
            prop_assert_eq!(beacon::fits(&t, usage, prices, sponsorship), exact);
            let paid_exact = big(prices) * big(draw_max) + big(sponsorship) * big(threshold) >= big(threshold) * big(draw_max);
            prop_assert_eq!(beacon::is_paid(&t, prices, sponsorship), paid_exact);
        }

        #[test]
        fn no_charge_exceeds_its_prepay_in_any_paid_round(
            (terms, _, _, _) in terms(),
            prices in 1u64..=100_000_000_000,
            price_frac in 0u64..=1_000_000,
            sponsorship in 0u64..=200_000_000,
            cost_frac in 0u64..=1_000_000,
        ) {
            prop_assume!(beacon::is_paid(&terms, prices, sponsorship));
            let price = (u128::from(prices) * u128::from(price_frac) / 1_000_000) as u64;
            let cost = (u128::from(terms.draw_max) * u128::from(cost_frac) / 1_000_000) as u64;
            let ch = beacon::charge(cost, sponsorship, prices, price).unwrap();
            prop_assert!(ch <= beacon::prepay(&terms, price).unwrap());
        }

        /// The bound the guide states: in a paid round a ticket's charge is
        /// at most `ceil(C × price / T_r)`, its share of the draw's real cost
        /// at the threshold, whatever the sponsorship and the round's prices,
        /// whenever `C ≤ D_r` (the request refuses more). It is what makes the
        /// 150 bps design point of `T` hold only at the `C` it was derived from.
        #[test]
        fn a_paid_round_charges_at_most_the_real_cost_at_the_threshold(
            (terms, _, _, _) in terms(),
            prices in 1u64..=100_000_000_000,
            price_frac in 0u64..=1_000_000,
            sponsorship in 0u64..=200_000_000,
            cost_frac in 0u64..=1_000_000,
        ) {
            prop_assume!(beacon::is_paid(&terms, prices, sponsorship));
            let price = (u128::from(prices) * u128::from(price_frac) / 1_000_000) as u64;
            let cost = (u128::from(terms.draw_max) * u128::from(cost_frac) / 1_000_000) as u64;
            let ch = beacon::charge(cost, sponsorship, prices, price).unwrap();
            let at_threshold = (u128::from(cost) * u128::from(price))
                .div_ceil(u128::from(terms.threshold));
            prop_assert!(u128::from(ch) <= at_threshold);
        }

        #[test]
        fn n_opens_and_closes_equal_one_open_n_and_close_n(
            close in prop_oneof![Just(0i64), 1i64..=1_000],
            now in 0i64..=1_000,
            n in 0u32..=50,
            roll in any::<bool>(),
        ) {
            let mut one = Counters { close_ts: close, ..Counters::default() };
            let mut many = one;
            let (side, g) = one.open_n(now, n).unwrap();
            for _ in 0..n {
                prop_assert_eq!(many.open(now).unwrap(), (side, g));
            }
            prop_assert_eq!(one, many);
            // a generation change moves `after` into `before` (it needs `before`
            // empty, so only an `After` round can live through one)
            if roll && side == Side::AfterClose {
                one.roll(2_000).unwrap();
                many.roll(2_000).unwrap();
            }
            one.close_n(side, g, n).unwrap();
            for _ in 0..n {
                many.close(side, g).unwrap();
            }
            prop_assert_eq!(one, many);
            prop_assert_eq!((one.before, one.after), (0, 0));
            // closing more than is open fails and leaves the counters alone
            let before = one;
            prop_assert!(one.close_n(side, g, 1).is_err());
            prop_assert_eq!(one, before);
        }

        /// What the integration guide (§5) tells an integrator to do with a
        /// `RoundCapacity` refusal. At a fixed multiplier a ticket's liability and
        /// the paid fraction it brings both scale with its price, so a join the
        /// exact rule refuses is refused at every higher price that leaves the
        /// round unpaid; a smaller ticket at the same multiplier, a lower
        /// multiplier at the same price, or the payment of the round (its
        /// sponsorship, or a price that completes it) are what can make room.
        #[test]
        fn a_capacity_refusal_is_never_cured_by_a_higher_price(
            (terms, _, _, _) in terms(),
            prices in 0u64..=20_000_000_000,
            sponsorship in 0u64..=20_000_000,
            usage_ppm in 0u64..=1_000_000,
            // liability per unit of price: `m − credit/price`, in whole units
            q in 1u64..=10_000,
            cap in 1u64..=2_000_000_000_000,
            price in 1u64..=5_000_000_000,
            raise in 1u64..=5_000_000_000,
        ) {
            // the round as it stands fits (the rule held at every earlier join)
            let room = exact_room(&terms, prices, sponsorship)
                * Ratio::from_integer(big(USAGE_SCALE))
                * Ratio::new(big(usage_ppm), big(1_000_000));
            let held = u64::try_from(room.to_integer()).unwrap();
            prop_assert!(beacon::fits(&terms, held, prices, sponsorship));
            let exact = |p: u64| {
                let used = Ratio::new(big(held), big(USAGE_SCALE)) + Ratio::new(big(p) * big(q), big(cap));
                used <= exact_room(&terms, prices + p, sponsorship)
            };
            let program = |p: u64, sp: u64| match beacon::usage(p * q, cap) {
                Ok(u) => beacon::fits(&terms, held + u, prices + p, sponsorship + sp),
                Err(_) => false,
            };
            if !exact(price) {
                prop_assert!(!program(price, 0));
                let higher = price + raise;
                prop_assert!(
                    !program(higher, 0) || beacon::is_paid(&terms, prices + higher, sponsorship),
                    "a higher price that leaves the round unpaid was admitted"
                );
                // the sponsorship that pays the round makes room for a whole
                // `k` caps, so the same join fits once it carries it, whenever
                // the round's usage with it stays within them
                let pay = beacon::sponsorship_to_pay(&terms, prices + price, sponsorship).unwrap();
                if let Ok(u) = beacon::usage(price * q, cap) {
                    let within = u128::from(held) + u128::from(u)
                        <= u128::from(terms.round_k) * u128::from(USAGE_SCALE);
                    prop_assert_eq!(program(price, pay), within);
                }
            }
        }

        /// `within_join_share` is the exact per-join share of a round for
        /// every input, including at the floor and at a whole draw.
        #[test]
        fn the_join_share_is_exact(
            (terms, _, _, _) in terms(),
            usage in prop_oneof![0u64..=u64::MAX, 0u64..=2 * USAGE_SCALE],
            price in prop_oneof![0u64..=u64::MAX, 0u64..=20_000_000_000],
            sponsorship in prop_oneof![0u64..=u64::MAX, 0u64..=20_000_000],
            pays_round in any::<bool>(),
        ) {
            prop_assert_eq!(
                beacon::within_join_share(&terms, usage, price, sponsorship, pays_round),
                exact_join_share(&terms, usage, price, sponsorship, pays_round)
            );
        }

        /// The headroom (Spec 09 §7): whatever a round holds while unpaid, a
        /// join that makes it paid and uses at most `h · k` caps fits. So no
        /// stake that can still be refunded can refuse the join that would
        /// make it final.
        #[test]
        fn a_join_that_pays_an_unpaid_round_within_the_headroom_fits(
            (terms, _, _, _) in terms(),
            prices_ppm in 0u64..=500_000,
            sponsorship_ppm in 0u64..=500_000,
            usage_ppm in 0u64..=1_000_000,
            u_ppm in 0u64..=1_000_000,
            extra in 0u64..=5_000_000_000,
            by_sponsor in any::<bool>(),
        ) {
            let prices = (u128::from(terms.threshold) * u128::from(prices_ppm) / 1_000_000) as u64;
            let sponsorship = (u128::from(terms.draw_max) * u128::from(sponsorship_ppm) / 1_000_000) as u64;
            prop_assume!(!beacon::is_paid(&terms, prices, sponsorship));
            // any reachable unpaid round: its usage within its unpaid room
            let room = exact_room(&terms, prices, sponsorship)
                * Ratio::from_integer(big(USAGE_SCALE))
                * Ratio::new(big(usage_ppm), big(1_000_000));
            let held = u64::try_from(room.to_integer()).unwrap();
            prop_assert!(beacon::fits(&terms, held, prices, sponsorship));
            // a join that pays it, by its price or by its sponsorship
            let (p, sp) = if by_sponsor {
                (0, beacon::sponsorship_to_pay(&terms, prices, sponsorship).unwrap() + extra)
            } else {
                (terms.threshold.saturating_sub(prices) + extra, 0)
            };
            prop_assert!(beacon::is_paid(&terms, prices + p, sponsorship + sp));
            let headroom = u64::from(terms.round_k) * USAGE_SCALE / fade_math::BPS * beacon::UNPAID_HEADROOM_BPS;
            let u = headroom * u_ppm / 1_000_000;
            prop_assert!(beacon::fits(&terms, held + u, prices + p, sponsorship + sp));
            prop_assert!(beacon::fits(&terms, held + headroom, prices + p, sponsorship + sp));
            // and within the share of the join that pays the round
            prop_assert!(beacon::within_join_share(&terms, u, p, sp, true));
            prop_assert!(beacon::within_join_share(&terms, headroom, p, sp, true));
        }

        #[test]
        fn a_group_joined_later_is_released_by_one_close_n(
            close in prop_oneof![Just(0i64), 1i64..=1_000],
            now in 0i64..=1_000,
            n in 1u32..=50,
            later in prop::collection::vec((0u32..=5, any::<bool>(), 0i64..=2_500), 0..8),
        ) {
            // A paid round recorded with `open_n`, then joins in batches of
            // `k` at times `t`, a generation change possibly between them
            // while the group sits in `after`: whatever the order, the group
            // stays in one counter, one `close_n` of everything it took
            // empties it, and `before` takes a join only before the live
            // close (`EpochClosed` otherwise, the counters untouched).
            let mut c = Counters { close_ts: close, ..Counters::default() };
            let (side, g) = c.open_n(now, n).unwrap();
            let mut total = n;
            let mut rolled = false;
            for (k, roll, t) in later {
                if roll && !rolled && side == Side::AfterClose {
                    c.roll(2_000).unwrap();
                    rolled = true;
                }
                let before = c;
                let in_before = match side {
                    Side::BeforeClose => g == c.generation,
                    Side::AfterClose => g.checked_add(1) == Some(c.generation),
                };
                let open = c.close_ts != 0 && t < c.close_ts;
                match c.join_n(t, side, g, k) {
                    Ok(()) => {
                        prop_assert!(!in_before || open);
                        prop_assert_eq!(c.before + c.after, before.before + before.after + k);
                        prop_assert_eq!(c.after, if in_before { before.after } else { before.after + k });
                        prop_assert_eq!(c.generation, before.generation);
                        total += k;
                    }
                    Err(e) => {
                        prop_assert_eq!(e, Reject::EpochClosed);
                        prop_assert!(in_before && !open);
                        prop_assert_eq!(c, before);
                    }
                }
            }
            prop_assert_eq!(c.before + c.after, total);
            c.close_n(side, g, total).unwrap();
            prop_assert_eq!((c.before, c.after), (0, 0));
            // a group whose counter is gone takes nothing and changes nothing
            if side == Side::AfterClose {
                c.roll(3_000).unwrap();
                c.roll(4_000).unwrap();
                let before = c;
                prop_assert!(c.join_n(0, side, g, 1).is_err());
                prop_assert_eq!(c, before);
            }
        }
    }
}
