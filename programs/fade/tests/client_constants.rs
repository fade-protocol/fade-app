//! The constants and byte layouts the beacon client copies by hand
//! (`clients/js/src/beacon/constants.ts`, `entropy.ts`), pinned to the Rust
//! values through one fixture both sides read:
//! `tests/fixtures/beacon/client_constants.json`. This test fails if the
//! fixture differs from what the program and `fade_math` define, and
//! `tests/ts/fade/beaconMath.test.ts` fails if the client differs from the
//! fixture. ORAO's request and network-state layouts are pinned by sample
//! accounts that `fade_math::orao_layout` parses here and the client parses
//! there, so that a wrong offset or discriminator on either side is caught.
//!
//! `FADE_WRITE_FIXTURES=1 cargo test -p fade --test client_constants`
//! rewrites the fixture after a deliberate change.

use fade::constants::{ORAO_VRF_ID, OUTCOME_ROUNDS, ROUND_GROUP_ACCOUNTS, SLOT_HASHES_ID};
use fade_math::beacon::{REQUEST_DELAY_SLOTS, UNPAID_HEADROOM_BPS, USAGE_SCALE};
use fade_math::orao_layout::{self, Randomness};
use fade_math::{BPS, P_SCALE};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/beacon/client_constants.json"
);

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn bytes(b: &[u8]) -> String {
    let items: Vec<String> = b.iter().map(u8::to_string).collect();
    format!("[{}]", items.join(", "))
}

/// A request sample: its data, and what `orao_layout::randomness` reads.
fn sample(name: &str, data: &[u8]) -> String {
    let parsed = orao_layout::randomness(data).expect("the sample parses");
    let (fulfilled, seed, randomness) = match parsed {
        Randomness::Pending => (false, String::new(), String::new()),
        Randomness::Fulfilled { seed, randomness } => (true, hex(&seed), hex(&randomness)),
    };
    format!(
        "    {{ \"name\": \"{name}\", \"data\": \"{}\", \"fulfilled\": {fulfilled}, \"seed\": \"{seed}\", \"randomness\": \"{randomness}\" }}",
        hex(data)
    )
}

fn seed() -> [u8; 32] {
    core::array::from_fn(|i| u8::try_from(i).unwrap().wrapping_mul(7).wrapping_add(1))
}

fn randomness() -> [u8; 64] {
    core::array::from_fn(|i| u8::try_from(i).unwrap().wrapping_mul(13).wrapping_add(5))
}

/// Pending and fulfilled, in both of ORAO's layouts, built at the offsets
/// ORAO writes (the mock's `request`, `request_v2` and `fulfill`).
fn samples() -> Vec<String> {
    let (s, r) = (seed(), randomness());
    let client = [0x42u8; 32];

    let mut v2_pending = vec![0u8; orao_layout::PENDING_LEN];
    v2_pending[..8].copy_from_slice(&orao_layout::RANDOMNESS_V2_DISCRIMINATOR);
    v2_pending[8] = 0;
    v2_pending[9..41].copy_from_slice(&client);
    v2_pending[41..73].copy_from_slice(&s);
    let mut v2_fulfilled = vec![0u8; orao_layout::FULFILLED_LEN];
    v2_fulfilled[..8].copy_from_slice(&orao_layout::RANDOMNESS_V2_DISCRIMINATOR);
    v2_fulfilled[8] = 1;
    v2_fulfilled[9..41].copy_from_slice(&client);
    v2_fulfilled[41..73].copy_from_slice(&s);
    v2_fulfilled[73..137].copy_from_slice(&r);

    let mut v1_pending = vec![0u8; orao_layout::V1_LEN];
    v1_pending[..8].copy_from_slice(&orao_layout::RANDOMNESS_V1_DISCRIMINATOR);
    v1_pending[8..40].copy_from_slice(&s);
    let mut v1_fulfilled = v1_pending.clone();
    v1_fulfilled[40..104].copy_from_slice(&r);

    assert_eq!(
        orao_layout::randomness(&v2_fulfilled),
        Some(Randomness::Fulfilled {
            seed: s,
            randomness: r
        })
    );
    assert_eq!(
        orao_layout::randomness(&v1_fulfilled),
        Some(Randomness::Fulfilled {
            seed: s,
            randomness: r
        })
    );
    assert_eq!(
        orao_layout::randomness(&v2_pending),
        Some(Randomness::Pending)
    );
    assert_eq!(
        orao_layout::randomness(&v1_pending),
        Some(Randomness::Pending)
    );
    vec![
        sample("v2 pending", &v2_pending),
        sample("v2 fulfilled", &v2_fulfilled),
        sample("v1 pending", &v1_pending),
        sample("v1 fulfilled", &v1_fulfilled),
    ]
}

/// A network state with a treasury and a fee `orao_layout::network_state` reads.
fn network_state() -> String {
    let treasury: [u8; 32] = core::array::from_fn(|i| u8::try_from(i).unwrap() + 100);
    let fee: u64 = 1_234_567_891;
    let mut data = vec![0u8; 8 + 32 + 32 + 8 + 4 + 1 + 8];
    data[..8].copy_from_slice(&[212, 237, 148, 56, 97, 245, 51, 169]);
    data[8..40].fill(0x11);
    data[orao_layout::TREASURY_OFFSET..orao_layout::TREASURY_OFFSET + 32]
        .copy_from_slice(&treasury);
    data[orao_layout::REQUEST_FEE_OFFSET..orao_layout::REQUEST_FEE_OFFSET + 8]
        .copy_from_slice(&fee.to_le_bytes());
    let parsed = orao_layout::network_state(&data).expect("parses");
    assert_eq!((parsed.treasury, parsed.request_fee), (treasury, fee));
    format!(
        "{{ \"data\": \"{}\", \"treasury\": \"{}\", \"fee\": {} }}",
        hex(&data),
        hex(&parsed.treasury),
        parsed.request_fee
    )
}

fn render() -> String {
    let utf8 = |b: &[u8]| String::from_utf8(b.to_vec()).unwrap();
    let constants = [
        format!("\"ORAO_VRF_PROGRAM_ADDRESS\": \"{ORAO_VRF_ID}\""),
        format!("\"SLOT_HASHES_SYSVAR\": \"{SLOT_HASHES_ID}\""),
        format!(
            "\"ORAO_NETWORK_STATE_SEED\": \"{}\"",
            utf8(orao_layout::NETWORK_STATE_SEED)
        ),
        format!(
            "\"ORAO_REQUEST_SEED\": \"{}\"",
            utf8(orao_layout::REQUEST_SEED)
        ),
        format!("\"ORAO_TREASURY_OFFSET\": {}", orao_layout::TREASURY_OFFSET),
        format!(
            "\"ORAO_REQUEST_FEE_OFFSET\": {}",
            orao_layout::REQUEST_FEE_OFFSET
        ),
        format!("\"ORAO_PENDING_LEN\": {}", orao_layout::PENDING_LEN),
        format!(
            "\"ORAO_RANDOMNESS_V2_DISCRIMINATOR\": {}",
            bytes(&orao_layout::RANDOMNESS_V2_DISCRIMINATOR)
        ),
        format!(
            "\"ORAO_RANDOMNESS_V1_DISCRIMINATOR\": {}",
            bytes(&orao_layout::RANDOMNESS_V1_DISCRIMINATOR)
        ),
        format!("\"P_SCALE\": {P_SCALE}"),
        format!("\"BPS\": {BPS}"),
        format!("\"USAGE_SCALE\": {USAGE_SCALE}"),
        format!("\"UNPAID_HEADROOM_BPS\": {UNPAID_HEADROOM_BPS}"),
        format!("\"OUTCOME_ROUNDS\": {OUTCOME_ROUNDS}"),
        format!("\"REQUEST_DELAY_SLOTS\": {REQUEST_DELAY_SLOTS}"),
        format!("\"ROUND_GROUP_ACCOUNTS\": {ROUND_GROUP_ACCOUNTS}"),
    ];
    format!(
        "{{\n  \"comment\": \"Written by programs/fade/tests/client_constants.rs; checked by it and by tests/ts/fade/beaconMath.test.ts.\",\n  \"constants\": {{\n    {}\n  }},\n  \"network_state\": {},\n  \"requests\": [\n{}\n  ]\n}}\n",
        constants.join(",\n    "),
        network_state(),
        samples().join(",\n")
    )
}

#[test]
fn the_client_constants_fixture_is_current() {
    let want = render();
    if std::env::var_os("FADE_WRITE_FIXTURES").is_some() {
        std::fs::create_dir_all(std::path::Path::new(FIXTURE).parent().unwrap()).unwrap();
        std::fs::write(FIXTURE, &want).unwrap();
    }
    let have = std::fs::read_to_string(FIXTURE).unwrap_or_default();
    assert!(
        have == want,
        "{FIXTURE} differs from the Rust constants: rerun with FADE_WRITE_FIXTURES=1 and update clients/js/src/beacon/constants.ts"
    );
}
