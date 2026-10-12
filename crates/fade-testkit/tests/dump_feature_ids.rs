//! Writes the feature ids known to the pinned runtime crate, so that
//! scripts/sync-features.py can ask the cluster which of them are active.
//! The runtime crate is the only trustworthy list: the CLI's `feature status`
//! table can lag it (it labelled SBPF v3 with a retired id in Agave 4.2.2).
//!
//!   cargo test -p fade-testkit --test dump_feature_ids -- --ignored
use agave_feature_set::FEATURE_NAMES;

#[test]
#[ignore]
fn dump_feature_ids() {
    let out = std::env::var("FEATURE_IDS_OUT")
        .unwrap_or_else(|_| "tests/fixtures/features/ids.json".into());
    let mut entries: Vec<(String, String)> = FEATURE_NAMES
        .iter()
        .map(|(id, name)| (id.to_string(), name.to_string()))
        .collect();
    entries.sort();
    let json = serde_json::json!({
        "agave_feature_set": env!("CARGO_PKG_VERSION"),
        "features": entries.iter().map(|(id, name)| serde_json::json!({"id": id, "name": name})).collect::<Vec<_>>(),
    });
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(&out);
    std::fs::write(&path, serde_json::to_string_pretty(&json).unwrap()).unwrap();
    eprintln!("wrote {} feature ids to {}", entries.len(), path.display());
}
