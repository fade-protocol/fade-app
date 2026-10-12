//! Differential test against the Python integer reference
//! (scripts/oracle/fade_ref.py, vectors from scripts/oracle/gen_vectors.py).
//! Regenerate with `python3 scripts/oracle/gen_vectors.py --seed 1 --count 2000`.

use fade_math::payout_table::{self, Outcome};
use fade_math::risk::{self, Integrator, Params, Ticket, Vault};
use fade_math::shares::Chain;
use fade_math::{drawdown, select, shares, Reject};
use serde::Deserialize;

fn load<T: for<'a> Deserialize<'a>>(name: &str) -> Vec<T> {
    #[derive(Deserialize)]
    struct File<T> {
        cases: Vec<T>,
    }
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/");
    let text = std::fs::read_to_string(format!("{path}{name}.json")).unwrap();
    serde_json::from_str::<File<T>>(&text).unwrap().cases
}

fn reason(r: Reject) -> &'static str {
    match r {
        Reject::OutcomeCount => "OutcomeCount",
        Reject::ProbabilityRange => "ProbabilityRange",
        Reject::ProbabilitySum => "ProbabilitySum",
        Reject::MultiplierCeiling => "MultiplierCeiling",
        Reject::PayoutTableOverpays => "PayoutTableOverpays",
        Reject::MarginFloor => "MarginFloor",
        Reject::AppShare => "AppShare",
        Reject::PriceBounds => "PriceBounds",
        Reject::PerTicketCap => "PerTicketCap",
        Reject::IntegratorCap => "IntegratorCap",
        Reject::UtilisationBreaker => "UtilisationBreaker",
        Reject::GlobalExposure => "GlobalExposure",
        Reject::Insolvent => "Insolvent",
        Reject::Overflow => "Overflow",
    }
}

#[derive(Deserialize)]
struct PayoutTableCase {
    outcomes: Vec<Outcome2>,
    margin_bps: u64,
    result: String,
    reason: Option<String>,
    lhs: Option<String>,
    max_m: Option<u64>,
    cum: Option<Vec<u64>>,
    ev_ok: Option<bool>,
    carried_margin_bps: Option<u64>,
    draw: Option<u64>,
    outcome: Option<usize>,
}
#[derive(Deserialize)]
struct Outcome2 {
    p: u64,
    m: u64,
}

#[test]
fn payout_tables_match_the_reference() {
    let cases: Vec<PayoutTableCase> = load("payout_tables");
    assert_eq!(cases.len(), 2000);
    for (i, c) in cases.iter().enumerate() {
        let outcomes: Vec<Outcome> = c
            .outcomes
            .iter()
            .map(|b| Outcome { p: b.p, m: b.m })
            .collect();
        match payout_table::validate(&outcomes) {
            Ok(s) => {
                assert_eq!(
                    c.result, "ok",
                    "case {i}: reference rejected with {:?}",
                    c.reason
                );
                assert_eq!(s.lhs.to_string(), *c.lhs.as_ref().unwrap(), "case {i} lhs");
                assert_eq!(s.max_m, c.max_m.unwrap(), "case {i} max_m");
                assert_eq!(
                    &s.cum[..s.len],
                    c.cum.as_ref().unwrap().as_slice(),
                    "case {i} cum"
                );
                assert_eq!(
                    payout_table::ev_ok(s.lhs, c.margin_bps),
                    c.ev_ok.unwrap(),
                    "case {i} ev_ok at {} bps",
                    c.margin_bps
                );
                assert_eq!(
                    payout_table::margin_bps(s.lhs),
                    c.carried_margin_bps,
                    "case {i} margin"
                );
                assert_eq!(
                    select::outcome(c.draw.unwrap(), &s.cum, s.len),
                    c.outcome,
                    "case {i} outcome"
                );
            }
            Err(e) => {
                assert_eq!(
                    c.result, "err",
                    "case {i}: reference accepted, we rejected with {e:?}"
                );
                assert_eq!(reason(e), c.reason.as_deref().unwrap(), "case {i} reason");
            }
        }
    }
}

#[derive(Deserialize)]
struct AdmissionCase {
    vault: VaultJ,
    integrator: IntegJ,
    ticket: TicketJ,
    margin_bps: u64,
    halved: bool,
    credit: Option<CreditJ>,
    result: String,
    reason: Option<String>,
    liability: Option<u64>,
    cap: Option<u64>,
    vault_after: Option<VaultJ>,
}
#[derive(Deserialize, PartialEq, Debug)]
struct VaultJ {
    assets: u64,
    reserved: u64,
    open_credits: u64,
}
#[derive(Deserialize)]
struct IntegJ {
    reserved: u64,
    volume_total: u64,
}
#[derive(Deserialize)]
struct CreditJ {
    base: u64,
    rate_bps: u64,
}
#[derive(Deserialize)]
struct TicketJ {
    price: u64,
    vault_credit: u64,
    payout_max: u64,
}

#[test]
fn admissions_match_the_reference() {
    let cases: Vec<AdmissionCase> = load("admissions");
    assert_eq!(cases.len(), 2000);
    let mut accepted = 0;
    for (i, c) in cases.iter().enumerate() {
        let vault = Vault {
            assets: c.vault.assets,
            reserved: c.vault.reserved,
            open_credits: c.vault.open_credits,
        };
        let integ = Integrator {
            reserved: c.integrator.reserved,
            volume_total: c.integrator.volume_total,
        };
        let w = Ticket {
            price: c.ticket.price,
            vault_credit: c.ticket.vault_credit,
            payout_max: c.ticket.payout_max,
        };
        let params = match &c.credit {
            None => Params::SPEC,
            Some(k) => Params {
                credit_enabled: true,
                credit_base: k.base,
                credit_rate_bps: k.rate_bps,
                ..Params::SPEC
            },
        };
        match risk::admit(&vault, &integ, &params, &w, c.margin_bps, c.halved) {
            Ok(a) => {
                accepted += 1;
                assert_eq!(
                    c.result, "ok",
                    "case {i}: reference rejected with {:?}",
                    c.reason
                );
                assert_eq!(a.liability, c.liability.unwrap(), "case {i} liability");
                assert_eq!(a.cap, c.cap.unwrap(), "case {i} cap");
                let pa = c.vault_after.as_ref().unwrap();
                assert_eq!(
                    a.vault_after,
                    Vault {
                        assets: pa.assets,
                        reserved: pa.reserved,
                        open_credits: pa.open_credits
                    },
                    "case {i} vault_after"
                );
            }
            Err(e) => {
                assert_eq!(
                    c.result, "err",
                    "case {i}: reference accepted, we rejected with {e:?}"
                );
                assert_eq!(reason(e), c.reason.as_deref().unwrap(), "case {i} reason");
            }
        }
    }
    assert!(
        accepted > 100,
        "only {accepted} accepted cases: vectors are not exercising the happy path"
    );
}

#[derive(Deserialize)]
struct SharesCase {
    total_shares: u64,
    total_assets: u64,
    amount: u64,
    shares_for_assets: Option<u64>,
    assets_for_shares: Option<u64>,
    price: String,
}

#[test]
fn shares_match_the_reference() {
    let cases: Vec<SharesCase> = load("shares");
    assert_eq!(cases.len(), 2000);
    for (i, c) in cases.iter().enumerate() {
        // `None` in the vectors means the reference result exceeds u64: we must reject with Overflow.
        assert_eq!(
            shares::shares_for_assets(c.amount, c.total_shares, c.total_assets).ok(),
            c.shares_for_assets,
            "case {i} shares_for_assets"
        );
        assert_eq!(
            shares::assets_for_shares(c.amount, c.total_shares, c.total_assets).ok(),
            c.assets_for_shares,
            "case {i} assets_for_shares"
        );
        assert_eq!(
            drawdown::share_price(c.total_assets, c.total_shares)
                .unwrap()
                .to_string(),
            c.price,
            "case {i} price"
        );
    }
}

#[derive(Deserialize)]
struct ChainStep {
    total_shares: u64,
    total_assets: u64,
    withdrawable: u64,
    w: u64,
    b: u64,
    p: u64,
    r_before: String,
    v_before: String,
    r_after: String,
    v_after: String,
    split: bool,
}
#[derive(Deserialize)]
struct ChainEntry {
    shares: u64,
    at: usize,
    due: u64,
}
#[derive(Deserialize)]
struct ChainCase {
    steps: Vec<ChainStep>,
    entries: Vec<ChainEntry>,
    paid_total: u64,
}

#[test]
fn withdrawal_chains_match_the_reference_and_never_over_pay() {
    let cases: Vec<ChainCase> = load("chains");
    assert_eq!(cases.len(), 500);
    let big = |s: &String| s.parse::<u128>().unwrap();
    let mut splits = 0;
    for (i, c) in cases.iter().enumerate() {
        let mut chain = Chain::START;
        for (k, s) in c.steps.iter().enumerate() {
            assert_eq!(chain.r, big(&s.r_before), "case {i} step {k} r_before");
            assert_eq!(chain.v, big(&s.v_before), "case {i} step {k} v_before");
            let st =
                shares::strike(0, s.w, s.total_shares, s.total_assets, s.withdrawable).unwrap();
            assert_eq!(
                (st.shares_burnt, st.assets_paid),
                (s.b, s.p),
                "case {i} step {k} strike"
            );
            let after = chain.advance(s.w, s.b, s.p).unwrap();
            assert_eq!(after.r, big(&s.r_after), "case {i} step {k} r_after");
            assert_eq!(after.v, big(&s.v_after), "case {i} step {k} v_after");
            assert_eq!(after.splits(), s.split, "case {i} step {k} split");
            if after.splits() {
                splits += 1;
                chain = Chain::START;
            } else {
                chain = after;
            }
        }
        let mut paid = 0u64;
        for e in &c.entries {
            // What claim_withdraw pays: a transition at every split, then the
            // final claim.
            let first = &c.steps[e.at];
            let (mut s, mut r, mut v) = (e.shares, big(&first.r_before), big(&first.v_before));
            let mut due = 0u64;
            for st in &c.steps[e.at..] {
                if st.split {
                    due += shares::withdraw_due(s, r, v, big(&st.v_after)).unwrap();
                    s = shares::still_queued(s, r, big(&st.r_after)).unwrap();
                    (r, v) = (Chain::START.r, Chain::START.v);
                }
            }
            let last = c.steps.last().unwrap();
            if !last.split {
                due += shares::withdraw_due(s, r, v, big(&last.v_after)).unwrap();
            }
            assert_eq!(due, e.due, "case {i} due");
            paid += due;
        }
        assert!(
            paid <= c.paid_total,
            "case {i}: claims pay {paid} > {}",
            c.paid_total
        );
    }
    assert!(splits > 0, "the vectors exercise splits");
}

// ---------------------------------------------------------------------------
// Shared beacon: every function of `fade_math::beacon` against the reference,
// whole rounds step by step, and the seed and outcome preimages and hashes.

mod beacon_vectors {
    use fade_math::beacon::{self, Book, Entry, Terms};
    use serde::Deserialize;
    use sha2::{Digest, Sha256};

    #[derive(Deserialize)]
    struct File {
        scalars: Vec<Scalar>,
        rounds: Vec<Round>,
        seeds: Vec<Seed>,
    }

    fn load() -> File {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/beacon.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[derive(Deserialize)]
    struct Scalar {
        fee: u64,
        pending_rent: u64,
        request_share: u64,
        threshold: u64,
        draw_max: u64,
        round_k: u8,
        price: u64,
        prices: u64,
        sponsorship: u64,
        cap: u64,
        liability: u64,
        usage_total: u64,
        paid_slot: u64,
        tick: u64,
        funded: u64,
        refund: u64,
        cost: u64,
        amount: u64,
        drawn: bool,
        request_fits: bool,
        prepay: Option<u64>,
        is_paid: bool,
        paid_units: String,
        sponsorship_to_pay: u64,
        usage: Option<u64>,
        fits: bool,
        close_slot: Option<u64>,
        draw_cost: Option<u64>,
        charge: u64,
        sponsor_return: u64,
    }

    #[test]
    fn every_function_matches_the_reference() {
        let f = load();
        assert_eq!(f.scalars.len(), 2000);
        let (mut fits, mut paid) = (0, 0);
        for (i, c) in f.scalars.iter().enumerate() {
            let t = Terms {
                threshold: c.threshold,
                draw_max: c.draw_max,
                round_k: c.round_k,
            };
            assert_eq!(
                beacon::prefund(c.fee, c.pending_rent, c.request_share),
                Ok(c.draw_max),
                "case {i} prefund"
            );
            assert_eq!(
                beacon::request_fits(c.fee, c.pending_rent, c.request_share, c.draw_max),
                c.request_fits,
                "case {i} request_fits"
            );
            assert_eq!(
                beacon::prepay(&t, c.price).ok(),
                c.prepay,
                "case {i} prepay"
            );
            assert_eq!(
                beacon::is_paid(&t, c.prices, c.sponsorship),
                c.is_paid,
                "case {i} paid"
            );
            assert_eq!(
                beacon::paid_units(&t, c.prices, c.sponsorship).to_string(),
                c.paid_units,
                "case {i} paid_units"
            );
            assert_eq!(
                beacon::sponsorship_to_pay(&t, c.prices, c.sponsorship),
                Ok(c.sponsorship_to_pay),
                "case {i} sponsorship_to_pay"
            );
            assert_eq!(
                beacon::usage(c.liability, c.cap).ok(),
                c.usage,
                "case {i} usage"
            );
            assert_eq!(
                beacon::fits(&t, c.usage_total, c.prices, c.sponsorship),
                c.fits,
                "case {i} fits"
            );
            assert_eq!(
                beacon::close_slot(c.paid_slot, c.tick).ok(),
                c.close_slot,
                "case {i} close"
            );
            assert_eq!(
                beacon::draw_cost(c.funded, c.request_share, c.refund).ok(),
                c.draw_cost,
                "case {i} draw_cost"
            );
            assert_eq!(
                beacon::charge(c.cost, c.sponsorship, c.prices, c.price),
                Ok(c.charge),
                "case {i} charge"
            );
            assert_eq!(
                beacon::sponsor_return(c.cost, c.sponsorship, c.amount, c.drawn),
                Ok(c.sponsor_return),
                "case {i} sponsor_return"
            );
            fits += usize::from(c.fits);
            paid += usize::from(c.is_paid);
        }
        assert!(fits > 200 && fits < 1_800, "{fits} fitting cases");
        assert!(paid > 200 && paid < 1_800, "{paid} paid cases");
    }

    #[derive(Deserialize, Clone, Copy)]
    struct EntryJ {
        price: u64,
        vault_credit: u64,
        liability: u64,
        protocol_share: u64,
        app_share: u64,
        prepay: u64,
        usage: u64,
    }
    #[derive(Deserialize, PartialEq, Debug)]
    struct BookJ {
        prices: u64,
        sponsorship: u64,
        usage: u64,
        liability: u64,
        credits: u64,
        protocol_shares: u64,
        app_shares: u64,
        prepaid: u64,
        tickets: u32,
    }
    #[derive(Deserialize)]
    struct Step {
        kind: String,
        lamports: Option<u64>,
        price: Option<u64>,
        liability: Option<u64>,
        cap: Option<u64>,
        app_share_bps: Option<u64>,
        sponsorship: Option<u64>,
        entry: Option<EntryJ>,
        fits: Option<bool>,
        book: BookJ,
    }
    #[derive(Deserialize)]
    struct Round {
        fee: u64,
        pending_rent: u64,
        request_share: u64,
        threshold: u64,
        draw_max: u64,
        round_k: u8,
        steps: Vec<Step>,
        sponsors: Vec<u64>,
        paid: bool,
        drawn: bool,
        cost: u64,
        charges: Vec<u64>,
        sponsor_returns: Vec<u64>,
        dust: u64,
    }

    fn book_j(b: &Book) -> BookJ {
        BookJ {
            prices: b.prices,
            sponsorship: b.sponsorship,
            usage: b.usage,
            liability: b.liability,
            credits: b.credits,
            protocol_shares: b.protocol_shares,
            app_shares: b.app_shares,
            prepaid: b.prepaid,
            tickets: b.tickets,
        }
    }

    #[test]
    fn whole_rounds_match_the_reference() {
        let f = load();
        assert_eq!(f.rounds.len(), 500);
        let (mut refused, mut drawn) = (0, 0);
        for (i, r) in f.rounds.iter().enumerate() {
            let t = Terms {
                threshold: r.threshold,
                draw_max: r.draw_max,
                round_k: r.round_k,
            };
            let mut book = Book::default();
            let mut joined: Vec<Entry> = Vec::new();
            for (k, s) in r.steps.iter().enumerate() {
                if s.kind == "sponsor" {
                    book = book.sponsor(s.lamports.unwrap()).unwrap();
                } else {
                    let ej = s.entry.unwrap();
                    let price = s.price.unwrap();
                    let app_share_bps = s.app_share_bps.unwrap();
                    let e = Entry {
                        price,
                        vault_credit: price
                            - fade_math::payout_table::share_of(price, 20).unwrap()
                            - fade_math::payout_table::share_of(price, app_share_bps).unwrap(),
                        liability: s.liability.unwrap(),
                        protocol_share: fade_math::payout_table::share_of(price, 20).unwrap(),
                        app_share: fade_math::payout_table::share_of(price, app_share_bps).unwrap(),
                        prepay: beacon::prepay(&t, price).unwrap(),
                        usage: beacon::usage(s.liability.unwrap(), s.cap.unwrap()).unwrap(),
                    };
                    assert_eq!(
                        (
                            e.vault_credit,
                            e.protocol_share,
                            e.app_share,
                            e.prepay,
                            e.usage
                        ),
                        (
                            ej.vault_credit,
                            ej.protocol_share,
                            ej.app_share,
                            ej.prepay,
                            ej.usage
                        ),
                        "round {i} step {k} entry"
                    );
                    assert_eq!((ej.price, ej.liability), (e.price, e.liability));
                    match book.join(&t, &e, s.sponsorship.unwrap()).unwrap() {
                        Some(after) => {
                            assert!(s.fits.unwrap(), "round {i} step {k}: reference refused");
                            book = after;
                            joined.push(e);
                        }
                        None => {
                            assert!(!s.fits.unwrap(), "round {i} step {k}: reference admitted");
                            refused += 1;
                        }
                    }
                }
                assert_eq!(book_j(&book), s.book, "round {i} step {k} book");
            }
            assert_eq!(book.is_paid(&t), r.paid, "round {i} paid");
            let fits = beacon::request_fits(r.fee, r.pending_rent, r.request_share, r.draw_max);
            assert_eq!(r.paid && fits, r.drawn, "round {i} drawn");
            let charges: Vec<u64> = joined
                .iter()
                .map(|e| {
                    if r.drawn {
                        beacon::charge(r.cost, book.sponsorship, book.prices, e.price).unwrap()
                    } else {
                        0
                    }
                })
                .collect();
            assert_eq!(charges, r.charges, "round {i} charges");
            let back: Vec<u64> = r
                .sponsors
                .iter()
                .map(|&a| beacon::sponsor_return(r.cost, book.sponsorship, a, r.drawn).unwrap())
                .collect();
            assert_eq!(back, r.sponsor_returns, "round {i} sponsor returns");
            let out: u64 = r.cost
                + joined
                    .iter()
                    .zip(&charges)
                    .map(|(e, &c)| beacon::prepay_return(e.prepay, c).unwrap())
                    .sum::<u64>()
                + back.iter().sum::<u64>();
            assert_eq!(
                book.prepaid + book.sponsorship - out,
                r.dust,
                "round {i} dust"
            );
            drawn += usize::from(r.drawn);
        }
        assert!(
            refused > 50,
            "{refused} refusals: the vectors exercise RoundCapacity"
        );
        assert!(drawn > 100, "{drawn} drawn rounds");
    }

    #[derive(Deserialize)]
    struct Seed {
        program: String,
        round: String,
        ticket: String,
        close_slot: u64,
        entropy_slot: u64,
        entropy_hash: String,
        randomness: String,
        i: u8,
        seed_preimage: String,
        seed: String,
        outcome_preimage: String,
        outcome: String,
    }

    fn hex<const N: usize>(s: &str) -> [u8; N] {
        let v: Vec<u8> = (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect();
        v.try_into().unwrap()
    }

    fn to_hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn seeds_and_outcomes_match_the_reference() {
        let f = load();
        assert_eq!(f.seeds.len(), 200);
        for (i, s) in f.seeds.iter().enumerate() {
            let pre = beacon::seed_preimage(
                &hex(&s.program),
                &hex(&s.round),
                s.close_slot,
                s.entropy_slot,
                &hex(&s.entropy_hash),
            );
            assert_eq!(to_hex(&pre), s.seed_preimage, "case {i} seed preimage");
            assert_eq!(to_hex(&Sha256::digest(pre)), s.seed, "case {i} seed");
            let out = beacon::outcome_preimage(
                &hex(&s.program),
                &hex(&s.round),
                &hex(&s.ticket),
                &hex(&s.randomness),
                s.i,
            );
            assert_eq!(
                to_hex(&out),
                s.outcome_preimage,
                "case {i} outcome preimage"
            );
            assert_eq!(to_hex(&Sha256::digest(out)), s.outcome, "case {i} outcome");
        }
    }
}
