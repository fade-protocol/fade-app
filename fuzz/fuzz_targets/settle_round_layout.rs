//! cargo-fuzz target on `settle_round_tickets`'s account layout (Spec 08
//! §13.8): no list in which an account of a settled ticket's group differs
//! from its stored one may settle anything. The harness and its oracle are
//! `programs/fade/tests/batch_layout/mod.rs`; the input is a world, a batch
//! of round 1's tickets laid out from their stored keys, and the edits
//! applied to it (substitutions from a pool of every kind of account,
//! writable flags, removals, insertions, `wins` and `count`).
//!
//! `SBF_OUT_DIR` must name the built programs (source
//! `scripts/toolchain/env.sh` after `pnpm build:sbf`).
#![no_main]

#[path = "../../programs/fade/tests/batch_layout/mod.rs"]
mod batch_layout;
#[allow(dead_code, unused_imports)]
#[path = "../../programs/fade/tests/common/mod.rs"]
mod common;

use std::cell::OnceCell;

use libfuzzer_sys::fuzz_target;

thread_local! {
    /// Built once per process: every input forks one of its two states.
    static WORLD: OnceCell<batch_layout::World> = const { OnceCell::new() };
}

fuzz_target!(|data: &[u8]| {
    WORLD.with(|cell| {
        let world = cell.get_or_init(|| {
            let w = batch_layout::World::new();
            w.self_check();
            w
        });
        let mut tally = batch_layout::Tally::default();
        world.run(data, &mut tally);
    });
});
