//! The settlement batch layout under account substitution (Spec 08
//! §13.8's fuzz target), run here on a bounded budget so that CI
//! checks the harness and the property on every change: every single
//! substitution and flag flip of a batch, the longest batches and one past
//! them with and without bit 31 of `wins` and every `count` from 0 to 33,
//! then `FADE_LAYOUT_CASES` random inputs (2 000 by default) of the shape
//! the cargo-fuzz target `fuzz/fuzz_targets/settle_round_layout.rs` explores
//! for hours.

mod batch_layout;
mod common;

use batch_layout::{
    Tally, World, EDIT_COUNT_SET, EDIT_COUNT_STEP, EDIT_FLAG, EDIT_FLIP_BIT, EDIT_NONE,
    EDIT_REMOVE, EDIT_REPLACE, EDIT_SET_BIT_31, LONG_BATCH, LONG_RUN, MAX_EDITS, MAX_GROUPS,
    ROUND_ONE, RUN_MAX, RUN_MIN,
};

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.parse().ok())
}

/// An input padded with edits that do nothing.
fn pad(mut v: Vec<u8>) -> Vec<u8> {
    v.resize(2 + MAX_GROUPS + 3 * MAX_EDITS, EDIT_NONE);
    v
}

/// Every live ticket of round 1 settles in valid batches, in both states:
/// the success path the substitutions are measured against.
#[test]
fn the_stored_layout_settles() {
    World::new().self_check();
}

/// A batch of six tickets, every account of it replaced by every account of
/// the pool in turn, then each writable flag flipped, then each bit of
/// `wins` and `count` moved: each list is accepted exactly when the oracle
/// says so, and a refused one moves nothing.
#[test]
fn every_single_substitution() {
    let world = World::new();
    let mut tally = Tally::default();
    for state in 0..2u8 {
        // Six groups: tickets 2 to 7 (in the drawn state, one of them may
        // be the parked winner, a skipped group).
        let mut base = vec![state, 5];
        base.extend((2..8u8).map(|t| t % ROUND_ONE as u8));
        world.run(&pad(base.clone()), &mut tally);
        for at in 0..30u8 {
            for value in 0..=255u8 {
                let mut v = base.clone();
                v.extend([EDIT_REPLACE, at, value]);
                world.run(&pad(v), &mut tally);
            }
            for op in [EDIT_FLAG, EDIT_REMOVE] {
                let mut v = base.clone();
                v.extend([op, at, 0]);
                world.run(&pad(v), &mut tally);
            }
        }
        for at in 0..32u8 {
            let mut v = base.clone();
            v.extend([EDIT_FLIP_BIT, at, 0]);
            world.run(&pad(v), &mut tally);
        }
        for at in 0..2u8 {
            let mut v = base.clone();
            v.extend([EDIT_COUNT_STEP, at, 0]);
            world.run(&pad(v), &mut tally);
        }
    }
    println!(
        "single substitutions over a pool of {}: {tally:?}",
        world.pool_len()
    );
    assert!(tally.accepted > 0 && tally.refused > tally.accepted);
}

/// The batch's upper bound: runs of 29 to 33 tickets of the long run from
/// each of its tickets, in both states, as laid out, with bit 31 of `wins`
/// set, and (a run of 32) with `count` set to every value from 0 to 33.
/// Every run of at most 32 settles; 33 is refused; bit 31 is refused below
/// 32 groups and settles at 32 exactly when the 32nd ticket wins; a count
/// other than the groups laid out is refused.
#[test]
fn the_longest_batches() {
    let world = World::new();
    let mut tally = Tally::default();
    let mut run = |input: Vec<u8>| -> bool {
        let before = tally;
        world.run(&pad(input), &mut tally);
        assert_eq!(tally.skipped, before.skipped, "a long batch fits the locks");
        tally.accepted > before.accepted
    };
    let mut bit_31_at_32 = (0, 0);
    for state in 0..2u8 {
        for groups in RUN_MIN..=RUN_MAX {
            let n = u8::try_from(groups - RUN_MIN).unwrap();
            for start in 0..u8::try_from(LONG_RUN).unwrap() {
                let base = vec![state | LONG_BATCH, n, start];
                assert_eq!(
                    run(base.clone()),
                    groups <= 32,
                    "{groups} groups as laid out"
                );
                let mut v = base.clone();
                v.extend([EDIT_SET_BIT_31, 0, 0]);
                let accepted = run(v);
                match groups {
                    32 if accepted => bit_31_at_32.0 += 1,
                    32 => bit_31_at_32.1 += 1,
                    _ => assert!(!accepted, "bit 31 of {groups} groups"),
                }
                if groups == 32 {
                    for count in 0..=33u8 {
                        let mut v = base.clone();
                        v.extend([EDIT_COUNT_SET, 0, count]);
                        assert_eq!(run(v), count == 32, "count {count} for 32 groups");
                    }
                }
            }
        }
    }
    println!("long batches: {tally:?}, bit 31 of 32 groups (won, lost): {bit_31_at_32:?}");
    assert!(
        bit_31_at_32.0 > 0 && bit_31_at_32.1 > 0,
        "the 32nd group both won and lost"
    );
}

/// Random inputs, reproducible from `FADE_LAYOUT_SEED`.
#[test]
fn random_layouts() {
    let world = World::new();
    let cases = env_u64("FADE_LAYOUT_CASES").unwrap_or(2_000);
    let mut x = env_u64("FADE_LAYOUT_SEED").unwrap_or(0x5EED_F00D) | 1;
    let mut tally = Tally::default();
    let len = 2 + MAX_GROUPS + 3 * MAX_EDITS;
    for _ in 0..cases {
        let mut data = Vec::with_capacity(len);
        for _ in 0..len {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            data.push((x >> 24) as u8);
        }
        // Fewer edits now and then, so that valid batches come up. The edits
        // follow the state byte and the batch's: its length and tickets, or
        // a run's length and start.
        let edits_at = if data[0] & LONG_BATCH == LONG_BATCH {
            3
        } else {
            2 + 1 + usize::from(data[1]) % MAX_GROUPS
        };
        let edits = usize::from(data[0] >> 3) % (MAX_EDITS + 1);
        for b in data[edits_at + 3 * edits..].iter_mut().step_by(3) {
            *b = EDIT_NONE;
        }
        world.run(&data, &mut tally);
    }
    println!("random layouts: {tally:?}");
    assert_eq!(tally.runs, cases);
}
