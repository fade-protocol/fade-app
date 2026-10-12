//! Golden test: the five demo payout tables reproduce the
//! published accept/reject matrix (tests/fixtures/payout_tables/demo.json) for a
//! 5 000 USDC founding vault with 25 USDC tickets, and the demo's climax: the 10×
//! ticket refused at 5 000 USDC is accepted once the vault reaches 25 000 USDC.

use fade_math::payout_table::{self, Outcome};
use fade_math::risk::{self, Integrator, Params, Ticket, Vault};
use fade_math::Reject;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct File {
    app_share_bps: u64,
    tables: BTreeMap<String, Table>,
}
#[derive(Deserialize)]
struct Table {
    outcomes: Vec<B>,
    lhs: Option<String>,
    margin_bps: Option<u64>,
    split: Option<String>,
    vault_margin_bps: Option<u64>,
    split_reason: Option<String>,
    #[serde(default)]
    matrix: Vec<Cell>,
}
#[derive(Deserialize)]
struct B {
    p: u64,
    m: u64,
}
#[derive(Deserialize)]
struct Cell {
    vault_usdc: u64,
    price_usdc: u64,
    result: String,
    reason: Option<String>,
    liability: Option<u64>,
}

#[test]
fn demo_matrix() {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/payout_tables/demo.json"
    ))
    .unwrap();
    let file: File = serde_json::from_str(&text).unwrap();
    assert_eq!(file.tables.len(), 5);
    let params = Params::SPEC;
    for (name, t) in &file.tables {
        let outcomes: Vec<Outcome> = t
            .outcomes
            .iter()
            .map(|b| Outcome { p: b.p, m: b.m })
            .collect();
        let s = payout_table::validate(&outcomes).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(s.lhs.to_string(), *t.lhs.as_ref().unwrap(), "{name} lhs");
        let margin = payout_table::margin_bps(s.lhs);
        assert_eq!(margin, t.margin_bps, "{name} margin");
        let split = risk::check_split(margin.unwrap_or(0), file.app_share_bps, &params);
        match (&split, t.split.as_deref()) {
            (Ok(pe), Some("ok")) => {
                assert_eq!(Some(*pe), t.vault_margin_bps, "{name} vault margin")
            }
            (Err(e), Some("err")) => assert_eq!(
                format!("{e:?}"),
                *t.split_reason.as_ref().unwrap(),
                "{name} split"
            ),
            _ => panic!("{name}: split {split:?} vs {:?}", t.split),
        }
        for c in &t.matrix {
            let price = c.price_usdc * 1_000_000;
            let credit = price
                - payout_table::share_of(price, file.app_share_bps).unwrap()
                - payout_table::share_of(price, params.protocol_share_bps).unwrap();
            let w = Ticket {
                price,
                vault_credit: credit,
                payout_max: payout_table::payout(price, s.max_m).unwrap(),
            };
            let vault = Vault {
                assets: c.vault_usdc * 1_000_000,
                reserved: 0,
                open_credits: 0,
            };
            let got = match split {
                Err(e) => Err(e),
                Ok(vault_margin) => risk::admit(
                    &vault,
                    &Integrator {
                        reserved: 0,
                        volume_total: 0,
                    },
                    &params,
                    &w,
                    vault_margin,
                    false,
                )
                .map(|a| a.liability),
            };
            let label = format!("{name} {}k/{}", c.vault_usdc / 1000, c.price_usdc);
            match (&got, c.result.as_str()) {
                (Ok(l), "ok") => assert_eq!(*l, c.liability.unwrap(), "{label}"),
                (Err(e), "err") => {
                    assert_eq!(format!("{e:?}"), *c.reason.as_ref().unwrap(), "{label}")
                }
                _ => panic!("{label}: got {got:?}, expected {} {:?}", c.result, c.reason),
            }
        }
    }
    let cell = |t: &str, vault: u64, price: u64| {
        file.tables[t]
            .matrix
            .iter()
            .find(|c| c.vault_usdc == vault && c.price_usdc == price)
            .unwrap()
    };
    // The demo at 5 000 USDC: the three games run on 25 USDC tickets, none on 50.
    for t in ["slot_classic", "loot_box", "rewards_ticket"] {
        assert_eq!(cell(t, 5_000, 25).result, "ok", "{t}");
        assert_eq!(
            cell(t, 5_000, 50).reason.as_deref(),
            Some("PerTicketCap"),
            "{t}"
        );
    }
    // The climax: 10× refused at 5 000, accepted at 25 000.
    assert_eq!(
        cell("moonshot_10x", 5_000, 25).reason.as_deref(),
        Some("PerTicketCap")
    );
    assert_eq!(cell("moonshot_10x", 25_000, 25).result, "ok");
    // A player-favourable table fails the split, not the cap.
    assert_eq!(
        file.tables["loot_box_mythic_5x"].split_reason.as_deref(),
        Some("MarginFloor")
    );
    assert_eq!(format!("{:?}", Reject::MarginFloor), "MarginFloor");
}
