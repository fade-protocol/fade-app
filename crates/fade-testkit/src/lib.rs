//! Test harness shared by every Fade program.
//!
//! Both Mollusk and LiteSVM default to feature sets that differ from mainnet:
//! Mollusk enables every feature the runtime knows, LiteSVM enables a list
//! frozen at its release. A program that passes there can still be undeployable
//! or behave differently on the real cluster. Every harness here is pinned to
//! the feature set captured in `tests/fixtures/features/`, refreshed by
//! `scripts/sync-features.py` from the runtime crate's id list and the cluster's
//! feature accounts (the CLI's `feature status` table is not trusted: in Agave
//! 4.2.2 it labelled SBPF v3 with a retired id).

pub mod token;
pub mod upgradeable;

use agave_feature_set::FeatureSet;
use litesvm::LiteSVM;
use mollusk_svm::Mollusk;
use solana_address::Address;
use std::str::FromStr;

pub const MAINNET_FIXTURE: &str = include_str!("../../../tests/fixtures/features/mainnet.json");
pub const DEVNET_FIXTURE: &str = include_str!("../../../tests/fixtures/features/devnet.json");

#[derive(serde::Deserialize)]
struct FeatureFixture {
    active: Vec<ActiveFeature>,
}

#[derive(serde::Deserialize)]
struct ActiveFeature {
    id: String,
    activated_at: u64,
}

/// Parses a fixture written by `scripts/sync-features.py` into a feature set
/// with exactly the active features, at their activation slots.
pub fn feature_set_from_fixture(json: &str) -> FeatureSet {
    let file: FeatureFixture = serde_json::from_str(json).expect("feature fixture");
    let mut set = FeatureSet::default();
    for feature in file.active {
        let id = Address::from_str(&feature.id).expect("feature id");
        set.activate(&id, feature.activated_at);
    }
    set
}

pub fn mainnet_feature_set() -> FeatureSet {
    feature_set_from_fixture(MAINNET_FIXTURE)
}

pub fn devnet_feature_set() -> FeatureSet {
    feature_set_from_fixture(DEVNET_FIXTURE)
}

/// A Mollusk instance on the mainnet feature set. The program is loaded from
/// `SBF_OUT_DIR` (set by `scripts/toolchain/env.sh`) by name, after the feature
/// set is installed, so ELF loading is checked against mainnet rules too.
pub fn mollusk(program_id: &Address, program_name: &str) -> Mollusk {
    let mut mollusk = Mollusk {
        feature_set: mainnet_feature_set().runtime_features(),
        ..Default::default()
    };
    mollusk.add_program(program_id, program_name);
    mollusk
}

/// A LiteSVM instance on the mainnet feature set, with the program loaded from
/// the given path.
pub fn litesvm(program_id: Address, program_path: &str) -> LiteSVM {
    let mut svm = LiteSVM::new().with_feature_set(mainnet_feature_set());
    svm.add_program_from_file(program_id, program_path)
        .expect("program loads under the mainnet feature set");
    svm
}

/// Path of a built program in `SBF_OUT_DIR`.
pub fn program_path(program_name: &str) -> String {
    let dir = std::env::var("SBF_OUT_DIR").expect("SBF_OUT_DIR (source scripts/toolchain/env.sh)");
    format!("{dir}/{program_name}.so")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mainnet_fixture_parses_and_has_expected_shape() {
        let set = mainnet_feature_set();
        // SBPF v1, v2 and v3 are active on mainnet (see toolchain.env).
        use agave_feature_set::{
            enable_sbpf_v2_deployment_and_execution as v2,
            enable_sbpf_v3_deployment_and_execution as v3,
        };
        assert!(
            set.is_active(&v2::id()),
            "SBPF v2 must be active on mainnet"
        );
        assert!(
            set.is_active(&v3::id()),
            "SBPF v3 must be active on mainnet"
        );
        assert!(set.active().len() > 150, "fixture looks truncated");
    }

    #[test]
    fn litesvm_bundled_mainnet_list_matches_fixture() {
        // LiteSVM ships its own frozen mainnet list. If it drifts from the
        // fixture, tests must keep using the fixture, and this test says so.
        let ours: std::collections::BTreeSet<_> =
            mainnet_feature_set().active().keys().copied().collect();
        let theirs: std::collections::BTreeSet<_> = LiteSVM::mainnet_feature_set()
            .active()
            .keys()
            .copied()
            .collect();
        let only_ours: Vec<_> = ours.difference(&theirs).collect();
        let only_theirs: Vec<_> = theirs.difference(&ours).collect();
        eprintln!("active in fixture but not in litesvm's list: {only_ours:?}");
        eprintln!("active in litesvm's list but not in fixture: {only_theirs:?}");
        // Informational: drift is expected over time. Loud, not fatal.
    }
}
