//! Fade never links ORAO's crate: the few facts it relies on are constants in
//! `orao_layout`. This checks them against ORAO's published IDL, vendored at
//! tests/fixtures/orao/orao_vrf.json (Apache-2.0, see NOTICE).

use fade_math::orao_layout::*;
use serde_json::Value;

fn idl() -> Value {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/orao/orao_vrf.json"
    ))
    .unwrap();
    serde_json::from_str(&text).unwrap()
}

fn bytes(v: &Value) -> Vec<u8> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}

#[test]
fn discriminators_and_seeds_match_the_published_idl() {
    let idl = idl();
    assert_eq!(
        idl["address"],
        "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y"
    );
    let request = idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == "request_v2")
        .unwrap();
    assert_eq!(bytes(&request["discriminator"]), REQUEST_V2_DISCRIMINATOR);
    // The account order Fade's hand-written CPI uses.
    let names: Vec<&str> = request["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "payer",
            "network_state",
            "treasury",
            "request",
            "system_program"
        ]
    );
    let seeds = &request["accounts"][1]["pda"]["seeds"][0]["value"];
    assert_eq!(bytes(seeds), NETWORK_STATE_SEED);
    let seeds = &request["accounts"][3]["pda"]["seeds"][0]["value"];
    assert_eq!(bytes(seeds), REQUEST_SEED);
    let account = idl["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == "RandomnessV2")
        .unwrap();
    assert_eq!(
        bytes(&account["discriminator"]),
        RANDOMNESS_V2_DISCRIMINATOR
    );
    let legacy = idl["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == "Randomness")
        .unwrap();
    assert_eq!(bytes(&legacy["discriminator"]), RANDOMNESS_V1_DISCRIMINATOR);
}

#[test]
fn the_network_state_offsets_follow_its_layout() {
    // NetworkState { config: NetworkConfiguration { authority, treasury, request_fee, … } }
    // after the 8-byte discriminator: authority at 8, treasury at 40, fee at 72.
    let idl = idl();
    let config = idl["types"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "NetworkConfiguration")
        .unwrap();
    let fields: Vec<(&str, &str)> = config["type"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .take(3)
        .map(|f| (f["name"].as_str().unwrap(), f["type"].as_str().unwrap()))
        .collect();
    assert_eq!(
        fields,
        [
            ("authority", "pubkey"),
            ("treasury", "pubkey"),
            ("request_fee", "u64")
        ]
    );
    assert_eq!(TREASURY_OFFSET, 8 + 32);
    assert_eq!(REQUEST_FEE_OFFSET, 8 + 32 + 32);
}

#[test]
fn the_legacy_randomness_is_seed_then_randomness() {
    // Randomness { seed: [u8; 32], randomness: [u8; 64], responses: Vec<_> }:
    // seed at 8, randomness at 40, as `randomness_v1` reads them.
    let idl = idl();
    let legacy = idl["types"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "Randomness")
        .unwrap();
    let fields: Vec<(&str, u64)> = legacy["type"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .take(2)
        .map(|f| {
            (
                f["name"].as_str().unwrap(),
                f["type"]["array"][1].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(fields, [("seed", 32), ("randomness", 64)]);
}
