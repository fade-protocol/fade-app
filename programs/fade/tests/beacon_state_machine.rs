//! The shared beacon's state-machine test (Spec 08 §13.8): random sequences of every beacon instruction, the direct path and
//! the liquidity providers' side in the same run, against a reference model
//! that predicts each instruction's outcome before it is sent.
//!
//! Each case starts from one of four worlds (`World`: the specification's
//! parameters on a large vault, or a small vault with tight limits, fresh,
//! in a drawdown's aftermath or just tripped), each a founded vault, three
//! integrators, four funders, three payers, a sponsor and three registered
//! payout tables, and runs up to
//! `MAX_OPS` operations drawn at random: joins with random payout tables,
//! integrators, payers, prices, app shares and sponsorships; sponsorships;
//! slot and clock advances and leaps to a round's boundaries or the epoch's
//! close; draw requests, pre-created ORAO requests, fulfilments (with zero:
//! a withheld draw) and nothing (ORAO late or silent); settlement batches of
//! random order and composition, now and then malformed; refunds, expiries,
//! returns, reclaims, parked payouts and share claims; ORAO's late
//! fulfilment of a request whose round forfeited or closed, and sweeps of
//! `round_vrf`, open or closed; frozen beneficiaries,
//! refund and share accounts; lamports sent to rounds, `round_vrf` and
//! tickets; ORAO fee changes; pauses; direct tickets opened, requested,
//! fulfilled, settled and expired; deposits, withdrawals, strikes and claims.
//! Then it drains: every round and ticket is driven to its end and every
//! share claimed, every request a forfeited round left pending fulfilled and
//! every `round_vrf` swept, so that each case ends with nothing open and no
//! lamport stranded on a `round_vrf`.
//!
//! The model predicts, for every operation, either success with every effect
//! (each token unit and lamport of every tracked account, every stored field
//! of every round, ticket, record and integrator, the vault's beacon books,
//! its counters' generation and its after-close results, and each strike's
//! price and flows from them) or the exact error, in the check order of
//! Spec 08 §13.5. A refused instruction must leave every known account byte
//! for byte as it was. After
//! every step the program's state is compared with the model's and the
//! invariants 1 to 12 of Spec 08 §13.8 are checked on the program's state
//! (`Sim::check`); every settled ticket's outcome is computed independently
//! from Spec 08 §13.4, and one ticket of each batch is also settled alone on
//! a fork of the state before the batch, its outcome, payout and charge
//! compared with the batch's.
//!
//! Cases: `FADE_SM_CASES` (default 10 000), cut into `FADE_SM_SHARDS` shards
//! (default 32), each generated from `(FADE_SM_SEED, shard)` alone and taken
//! from a queue by however many threads the machine has (`FADE_SM_THREADS`
//! overrides it): the seed, the case count and the shard count fix every
//! case, whatever the machine. The seed defaults to a fixed one
//! (`DEFAULT_SEED`); `FADE_SM_SEED=random` takes one from the clock. A
//! failure prints its shard, its case index and the command that reruns the
//! shard alone (`FADE_SM_SHARD`).

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};

use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas};
use common::*;
use fade::errors::FadeError;
use fade::events::{EpochStruck, RoundTicketSettled};
use fade::state::{
    Config, Integrator, Outcome, RiskParams, Round, RoundStatus, RoundTicket, RoundTicketStatus,
    Sponsorship, Ticket, TicketStatus, Vault,
};
use fade_math::beacon::{self, Book, Terms};
use fade_math::drawdown::{self, Ring};
use fade_math::epoch::{Counters, Side};
use fade_math::{orao_layout, payout_table, risk, select, shares, slot_hashes, Reject};
use litesvm::types::TransactionMetadata;
use proptest::prelude::*;
use proptest::test_runner::{Config as RunnerConfig, RngAlgorithm, TestRng, TestRunner};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;

const N_INTEGRATORS: usize = 3;
const N_FUNDERS: usize = 4;
const N_PAYERS: usize = 3;
/// Operations per case before the drain.
const MAX_OPS: usize = 48;
/// The largest batch a case settles at once: `MAX_ROUND_BATCH`, a lookup
/// table holding the accounts.
const MAX_BATCH: usize = fade::MAX_ROUND_BATCH as usize;
/// The drain pass from which no account is frozen: enough passes before it
/// for a round to be refunded, requested, fulfilled and settled.
const DRAIN_THAW_PASS: usize = 8;
/// The two worlds a case starts from (Spec 08 §13.8's state-machine test).
/// `Wide`: the specification's parameters on a 3 000 USDC vault, where joins
/// are refused by the round's capacity and rarely by the vault. `Tight`: a
/// 500 USDC vault whose drawdown threshold, integrator ceiling, utilisation
/// breaker and κ are set low enough that a few small tickets meet each (κ
/// written into `Config` below the program's floor, see `World::kappa_bps`),
/// so that the breaker trips at a join, the aftermath halves the cap, and
/// every admission refusal decides joins and opens
/// (`Insolvent` cannot be: `committed ≤ utilisation · assets ≤ assets` once
/// the breaker passes, every ratio being at most 100 %).
/// `Tripped`: the tight world just after a trip, its price 5 bps under the
/// threshold: with nothing open nothing can lift it back, so every join and
/// open meets the breaker, the rest of the case runs as usual.
/// `Aftermath`: the tight world a minute after a trip, its price back 5 bps
/// over the breaker's threshold: joins and opens are admitted with the cap
/// halved, and the first result the vault loses trips the breaker again, so
/// that later joins and opens meet it (a trip is otherwise rare before the
/// drain, most results being settled there).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum World {
    Wide,
    Tight,
    Aftermath,
    Tripped,
}

impl World {
    const ALL: [World; 4] = [World::Wide, World::Tight, World::Aftermath, World::Tripped];

    fn founding(self) -> u64 {
        match self {
            World::Wide => 3_000 * USDC,
            World::Tight | World::Aftermath | World::Tripped => 500 * USDC,
        }
    }

    fn params(self) -> RiskParams {
        let mut p = RiskParams::SPEC;
        if self != World::Wide {
            // A whole Kelly fraction and a 20 USDC censorship cap: on a
            // fresh 500 USDC vault a coin flip's cap is about 9 USDC, the
            // slot table's 17.5, the long shot's 19 (a 0.5 USDC ticket of
            // it fits); halved, a 5 USDC coin flip no longer fits.
            p.kelly_fraction_bps = 10_000;
            p.censorship_bps = 400;
            // Direct tickets of 1.5, 2 and 4 USDC, so that the slot table's
            // fit too and the direct path meets the vault's limits as well.
            p.min_price = 1_500_000;
            // A fall of 0.5 %, 2.5 USDC: one coin flip the vault loses trips
            // it, one it wins can lift the price back over the threshold
            // while the aftermath lasts.
            p.drawdown_bps = 50;
            // 10 USDC per integrator: a 5 USDC slot ticket alone exceeds it,
            // two coin flips of 5 USDC nearly.
            p.whale_bps = 200;
            p.utilisation_breaker_bps = 400;
            // Initialised at the program's floor; `kappa_bps` gives the κ
            // the case runs on.
            p.kappa_bps = fade::MIN_KAPPA_BPS;
        }
        assert!(p.is_valid(), "{self:?}: invalid parameters");
        p
    }

    /// The κ written into the tight worlds' `Config` after `initialize`:
    /// 12 USDC reserved, below the utilisation breaker (20 USDC committed)
    /// and above half of it, so that coin flips, whose credit about equals
    /// their liability, meet the breaker first, and the long shot and the
    /// slot table, whose liability outweighs their credit, meet κ first.
    /// Governance can no longer set a κ below `MIN_KAPPA_BPS` (0.8), and at
    /// 0.8 a 500 USDC vault would need some 400 USDC reserved, out of reach
    /// of a case's few small tickets; admission and the strike read whatever
    /// κ the `Config` holds, so it is written there directly, as beacon.rs's
    /// `set_config` writes parameters no change could set. The floor itself
    /// is tested in kappa_floor.rs and `state::tests`.
    fn kappa_bps(self) -> Option<u64> {
        (self != World::Wide).then_some(240)
    }
}

const PAUSE_TICKETS: u8 = Config::PAUSE_TICKETS;
const PAUSE_ROUNDS: u8 = Config::PAUSE_ROUNDS;
/// SPL Token's `AccountFrozen`.
const TOKEN_FROZEN: u32 = 17;

const ROUND_LEN: usize = 8 + Round::INIT_SPACE;
const ROUND_TICKET_LEN: usize = 8 + RoundTicket::INIT_SPACE;
const SPONSORSHIP_LEN: usize = 8 + Sponsorship::INIT_SPACE;
const INTEGRATOR_LEN: usize = 8 + Integrator::INIT_SPACE;

/// Beacon ticket prices: the minimum, a few above, one below it.
const PRICES: [u64; 6] = [500_000, 1_000_000, 2_000_000, 3_500_000, 5_000_000, 400_000];
/// App shares: within every table's margin, within some, above the maximum.
const APP_SHARES: [u64; 5] = [0, 0, 60, 200, 600];
/// Direct ticket prices, in thirds of the direct path's minimum: 7.5, 10
/// and 20 USDC in the wide world.
const DIRECT_PRICE_THIRDS: [u64; 3] = [3, 4, 8];
/// ORAO fees: the starting one, a rise absorbed by the prefund's margin,
/// one beyond it, a cut.
const FEES: [u64; 4] = [ORAO_FEE, 900_000, 1_200_000, 300_000];

// --- the cast ---------------------------------------------------------------------------

/// Everyone a case acts as, built once per thread and shared by its cases.
struct Actors {
    integrators: Vec<Keypair>,
    shares: Vec<Address>,
    funders: Vec<Keypair>,
    funder_usdc: Vec<Address>,
    beneficiaries: Vec<Address>,
    payers: Vec<Keypair>,
    sponsor: Keypair,
    /// The caller of every permissionless beacon instruction: paid the
    /// request and settlement shares, so its lamports are tracked.
    crank: Keypair,
    /// Untracked: the direct path's payer and caller, the ORAO pre-creator,
    /// whoever sends lamports to a round.
    outsider: Keypair,
    lps: Vec<User>,
    tables: Vec<Vec<Outcome>>,
    table_addrs: Vec<Address>,
    summaries: Vec<payout_table::Summary>,
}

impl Actors {
    /// Every potential sponsor: the payers (who sponsor in their joins) and
    /// the sponsor.
    fn sponsors(&self) -> Vec<Address> {
        let mut v: Vec<Address> = self.payers.iter().map(|k| k.pubkey()).collect();
        v.push(self.sponsor.pubkey());
        v
    }
    fn sponsor_kp(&self, key: &Address) -> &Keypair {
        self.payers
            .iter()
            .chain(std::iter::once(&self.sponsor))
            .find(|k| k.pubkey() == *key)
            .unwrap()
    }
}

/// A 20× long shot at 4 % margin: a ticket of it uses a large part of a
/// round's capacity, so joins are refused for capacity until the round is
/// mostly paid.
fn long_shot() -> Vec<Outcome> {
    vec![
        Outcome {
            p: 48_000_000,
            m: 200_000,
        },
        Outcome {
            p: 952_000_000,
            m: 0,
        },
    ]
}

/// A fixed keypair per role and index: every ticket's address, hence its
/// outcome, is the same in every run of a seed.
fn actor(role: u8, index: usize) -> Keypair {
    let mut secret = [0u8; 32];
    secret[0] = 0xFA;
    secret[1] = role;
    secret[2] = u8::try_from(index).unwrap();
    Keypair::new_from_array(secret)
}

fn base(world: World) -> (Env, Actors) {
    let mut env = Env::with_params(world.params());
    if let Some(kappa) = world.kappa_bps() {
        let mut acc = env.svm.get_account(&env.a.config).unwrap();
        let mut c = Config::try_deserialize(&mut acc.data.as_slice()).unwrap();
        c.params.kappa_bps = kappa;
        let mut data = Vec::new();
        c.try_serialize(&mut data).unwrap();
        acc.data = data;
        env.svm.set_account(env.a.config, acc).unwrap();
    }
    let lp0 = env.found(world.founding());
    let lp1 = env.user(10_000 * USDC);
    let outsider = actor(0, 0);
    env.svm
        .airdrop(&outsider.pubkey(), 1_000_000_000_000)
        .unwrap();
    let integrators: Vec<Keypair> = (0..N_INTEGRATORS).map(|k| actor(1, k)).collect();
    let shares = integrators
        .iter()
        .map(|k| env.usdc_account(&k.pubkey(), 0))
        .collect();
    let funders: Vec<Keypair> = (0..N_FUNDERS).map(|k| actor(2, k)).collect();
    let funder_usdc = funders
        .iter()
        .map(|k| {
            let a = ata(&k.pubkey(), &env.a.usdc_mint);
            fade_testkit::token::write_token_account(
                &mut env.svm,
                a,
                &env.a.usdc_mint,
                &k.pubkey(),
                100_000 * USDC,
            );
            a
        })
        .collect();
    let beneficiaries = funders
        .iter()
        .map(|k| env.usdc_account(&k.pubkey(), 0))
        .collect();
    let payers: Vec<Keypair> = (0..N_PAYERS).map(|k| actor(3, k)).collect();
    for k in &payers {
        env.svm.airdrop(&k.pubkey(), 1_000_000_000_000).unwrap();
    }
    let sponsor = actor(4, 0);
    env.svm
        .airdrop(&sponsor.pubkey(), 1_000_000_000_000)
        .unwrap();
    let crank = actor(5, 0);
    env.svm.airdrop(&crank.pubkey(), 1_000_000_000).unwrap();
    let tables = vec![coin_flip(), slot_classic(), long_shot()];
    let mut table_addrs = Vec::new();
    let mut summaries = Vec::new();
    for t in &tables {
        env.register_payout_table(&outsider, t).unwrap();
        table_addrs.push(env.payout_table_address(t));
        let o: Vec<payout_table::Outcome> = t
            .iter()
            .map(|o| payout_table::Outcome { p: o.p, m: o.m })
            .collect();
        summaries.push(payout_table::validate(&o).unwrap());
    }
    if matches!(world, World::Aftermath | World::Tripped) {
        // What a trip a minute ago leaves, and for `Aftermath` a recovery
        // (`check_6_the_drawdown_breaker` and
        // `the_drawdown_aftermath_halves_the_cap` in beacon.rs write the
        // same fields): the ring's maximum 5 bps from the threshold, the
        // trip recorded. Sim::new reads both, as it reads every other field.
        let dd = world.params().drawdown_bps;
        let price = env.vault().settled_price().unwrap();
        let keep = if world == World::Aftermath {
            fade_math::BPS - dd + 5
        } else {
            fade_math::BPS - dd - 5
        };
        let max = price * u128::from(fade_math::BPS) / u128::from(keep);
        let now = env.now();
        env.set_vault(|v| {
            v.price_maxima = [max; drawdown::HOURS];
            v.price_head_hour = now.div_euclid(3_600);
            v.drawdown_trip_ts = now - 60;
        });
        let ring = env.vault().ring();
        if world == World::Aftermath {
            assert!(!ring.tripped(price, dd));
            assert!(ring.tripped(price * 9_994 / 10_000, dd));
        } else {
            assert!(ring.tripped(price, dd));
        }
    }
    env.svm.expire_blockhash();
    (
        env,
        Actors {
            integrators,
            shares,
            funders,
            funder_usdc,
            beneficiaries,
            payers,
            sponsor,
            crank,
            outsider,
            lps: vec![lp0, lp1],
            tables,
            table_addrs,
            summaries,
        },
    )
}

// --- operations ------------------------------------------------------------------------

/// One step of a case. Every selector is a raw number, read against the
/// model's state when the step runs, so that every sequence is meaningful
/// and shrinks well.
#[derive(Debug, Clone)]
enum Op {
    Join {
        integrator: u8,
        funder: u8,
        payer: u8,
        table: u8,
        price: u8,
        app: u8,
        sponsorship: u8,
    },
    Sponsor {
        who: u8,
        round: u8,
        amount: u8,
    },
    Advance {
        slots: u8,
    },
    Leap {
        kind: u8,
        round: u8,
    },
    Request {
        round: u8,
    },
    Record {
        round: u8,
    },
    PreCreate {
        round: u8,
    },
    Fulfill {
        round: u8,
        value: u64,
        zero: bool,
    },
    Settle {
        round: u8,
        order: u64,
        size: u8,
        malformed: bool,
    },
    Refund {
        round: u8,
    },
    Expire {
        round: u8,
    },
    /// `sweep_round_vrf` of a round the vault created, open or closed, now
    /// and then of the next id, which names no round yet.
    Sweep {
        round: u8,
    },
    /// ORAO fulfils, late, a request `round_vrf` paid for whose round has
    /// forfeited or closed since: its refund lands on `round_vrf`.
    LateFulfill {
        pick: u16,
        value: u64,
    },
    Return {
        ticket: u16,
    },
    Reclaim {
        round: u8,
        who: u8,
    },
    ClaimRoundPayout {
        ticket: u16,
    },
    ClaimShares {
        who: u8,
    },
    Freeze {
        account: u8,
        frozen: bool,
    },
    Dust {
        target: u8,
        pick: u16,
        lamports: u8,
    },
    Fee {
        level: u8,
    },
    Pause {
        flags: u8,
    },
    PauseIntegrator {
        integrator: u8,
        paused: bool,
    },
    OpenDirect {
        integrator: u8,
        funder: u8,
        table: u8,
        price: u8,
    },
    DirectRequest {
        ticket: u16,
    },
    DirectFulfill {
        ticket: u16,
        value: u64,
        zero: bool,
    },
    DirectSettle {
        ticket: u16,
    },
    DirectExpire {
        ticket: u16,
    },
    DirectClaim {
        ticket: u16,
    },
    Deposit {
        lp: u8,
        amount: u8,
    },
    Withdraw {
        lp: u8,
        part: u8,
    },
    Strike,
    /// A leap to the live epoch's close if it is ahead, then a strike:
    /// strikes are otherwise rare, and the after-close books are what they
    /// read.
    CloseAndStrike,
    ClaimLp {
        pick: u8,
    },
}

fn op() -> impl Strategy<Value = Op> {
    let join = (
        any::<u8>(),
        any::<u8>(),
        any::<u8>(),
        any::<u8>(),
        any::<u8>(),
        any::<u8>(),
        any::<u8>(),
    )
        .prop_map(
            |(integrator, funder, payer, table, price, app, sponsorship)| Op::Join {
                integrator,
                funder,
                payer,
                table,
                price,
                app,
                sponsorship,
            },
        );
    prop_oneof![
        30 => join,
        5 => (any::<u8>(), any::<u8>(), any::<u8>())
            .prop_map(|(who, round, amount)| Op::Sponsor { who, round, amount }),
        14 => (1u8..=60).prop_map(|slots| Op::Advance { slots }),
        14 => (any::<u8>(), any::<u8>()).prop_map(|(kind, round)| Op::Leap { kind, round }),
        7 => any::<u8>().prop_map(|round| Op::Request { round }),
        2 => any::<u8>().prop_map(|round| Op::Record { round }),
        1 => any::<u8>().prop_map(|round| Op::PreCreate { round }),
        7 => (any::<u8>(), any::<u64>(), prop::bool::weighted(0.1))
            .prop_map(|(round, value, zero)| Op::Fulfill { round, value, zero }),
        9 => (any::<u8>(), any::<u64>(), 1u8..=40, prop::bool::weighted(0.08)).prop_map(
            |(round, order, size, malformed)| Op::Settle {
                round,
                order,
                size,
                malformed
            }
        ),
        3 => any::<u8>().prop_map(|round| Op::Refund { round }),
        3 => any::<u8>().prop_map(|round| Op::Expire { round }),
        2 => any::<u8>().prop_map(|round| Op::Sweep { round }),
        1 => (any::<u16>(), any::<u64>()).prop_map(|(pick, value)| Op::LateFulfill { pick, value }),
        6 => any::<u16>().prop_map(|ticket| Op::Return { ticket }),
        3 => (any::<u8>(), any::<u8>()).prop_map(|(round, who)| Op::Reclaim { round, who }),
        2 => any::<u16>().prop_map(|ticket| Op::ClaimRoundPayout { ticket }),
        2 => any::<u8>().prop_map(|who| Op::ClaimShares { who }),
        4 => (any::<u8>(), prop::bool::weighted(0.7))
            .prop_map(|(account, frozen)| Op::Freeze { account, frozen }),
        1 => (any::<u8>(), any::<u16>(), any::<u8>())
            .prop_map(|(target, pick, lamports)| Op::Dust { target, pick, lamports }),
        1 => any::<u8>().prop_map(|level| Op::Fee { level }),
        1 => any::<u8>().prop_map(|flags| Op::Pause { flags }),
        1 => (any::<u8>(), any::<bool>())
            .prop_map(|(integrator, paused)| Op::PauseIntegrator { integrator, paused }),
        4 => (any::<u8>(), any::<u8>(), any::<u8>(), any::<u8>()).prop_map(
            |(integrator, funder, table, price)| Op::OpenDirect {
                integrator,
                funder,
                table,
                price
            }
        ),
        2 => any::<u16>().prop_map(|ticket| Op::DirectRequest { ticket }),
        2 => (any::<u16>(), any::<u64>(), prop::bool::weighted(0.1))
            .prop_map(|(ticket, value, zero)| Op::DirectFulfill { ticket, value, zero }),
        2 => any::<u16>().prop_map(|ticket| Op::DirectSettle { ticket }),
        1 => any::<u16>().prop_map(|ticket| Op::DirectExpire { ticket }),
        1 => any::<u16>().prop_map(|ticket| Op::DirectClaim { ticket }),
        2 => (any::<u8>(), any::<u8>()).prop_map(|(lp, amount)| Op::Deposit { lp, amount }),
        1 => (any::<u8>(), any::<u8>()).prop_map(|(lp, part)| Op::Withdraw { lp, part }),
        5 => Just(Op::Strike),
        3 => Just(Op::CloseAndStrike),
        2 => any::<u8>().prop_map(|pick| Op::ClaimLp { pick }),
    ]
}

// --- the reference model -----------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TStatus {
    Joined,
    PayoutParked,
    ReturnParked,
}

#[derive(Clone, Debug)]
struct MTicket {
    round: u64,
    integrator: usize,
    nonce: u64,
    payer: usize,
    funder: usize,
    table: usize,
    price: u64,
    credit: u64,
    payout_max: u64,
    liability: u64,
    protocol_share: u64,
    app_share: u64,
    prepay: u64,
    settle_share: u64,
    status: TStatus,
    payout: u64,
}

#[derive(Clone, Debug)]
struct MRound {
    id: u64,
    status: RoundStatus,
    rent_payer: Address,
    first_slot: u64,
    paid_slot: u64,
    close_slot: u64,
    terms: Terms,
    min_price: u64,
    settle_share: u64,
    request_share: u64,
    tick_slots: u64,
    refund_slots: u64,
    t_settle_slots: u64,
    drawdown_bps: u64,
    book: Book,
    /// Sponsor → amount, one per existing record.
    sponsors: BTreeMap<Address, u64>,
    counted: bool,
    side: Side,
    generation: u32,
    randomness: Address,
    seed: [u8; 32],
    entropy_slot: u64,
    funded: u64,
    draw_cost: u64,
    drawn: Option<[u8; 64]>,
    /// Every ticket that ever joined, in order.
    members: Vec<Address>,
    last_join_slot: u64,
    /// Σ of the charges of its settled and forfeited tickets.
    charges: u64,
    /// `prices` when the slot first reached `close_slot` (invariant 6).
    prices_at_close: Option<u64>,
}

impl MRound {
    /// The slot the refund window counts from (`Round::refund_from`).
    fn refund_from(&self) -> u64 {
        self.first_slot.max(self.last_join_slot)
    }
}

impl MRound {
    fn accepts(&self, slot: u64) -> bool {
        match self.status {
            RoundStatus::Accepting => true,
            RoundStatus::Paid => slot < self.close_slot,
            _ => false,
        }
    }
    /// Its liability and credits are in the vault's open books.
    fn open_books(&self) -> bool {
        matches!(
            self.status,
            RoundStatus::Accepting
                | RoundStatus::Paid
                | RoundStatus::Requested
                | RoundStatus::Drawn
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DStatus {
    Open,
    Requested,
    PayoutPending,
}

#[derive(Clone, Debug)]
struct MDirect {
    integrator: usize,
    funder: usize,
    price: u64,
    credit: u64,
    liability: u64,
    status: DStatus,
    side: Side,
    generation: u32,
    open_slot: u64,
    expiry_slot: u64,
    request: Option<Address>,
    payout: u64,
    /// The drawdown threshold snapshotted at its open.
    drawdown_bps: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Client {
    RoundVrf(u64),
    Outsider,
    Direct,
}

#[derive(Clone, Debug)]
struct MRequest {
    client: Client,
    fulfilled: Option<[u8; 64]>,
}

#[derive(Clone, Debug, Default)]
struct MIntegrator {
    created: bool,
    reserved: u64,
    open: u64,
    next_nonce: u64,
    app_accrued: u64,
    paused: bool,
    /// `volume_total`: every direct ticket's price at its open, every beacon
    /// ticket's at its settlement or its forfeited return.
    volume: u64,
}

#[derive(Clone, Debug)]
struct Model {
    rounds: BTreeMap<u64, MRound>,
    tickets: BTreeMap<Address, MTicket>,
    directs: BTreeMap<Address, MDirect>,
    requests: BTreeMap<Address, MRequest>,
    integ: Vec<MIntegrator>,
    accepting_round: u64,
    next_round_id: u64,
    total_assets: u64,
    held: u64,
    protocol_accrued: u64,
    app_owed: u64,
    returns_owed: u64,
    /// `Vault.rounds_forfeited` and `Vault.forfeits_withheld`.
    forfeited: u64,
    forfeits_withheld: u64,
    /// `Vault.ticket_forfeits_withheld`: the direct path's own count.
    ticket_forfeits_withheld: u64,
    lamports: BTreeMap<Address, u64>,
    tokens: BTreeMap<Address, u64>,
    pause: u8,
    fee: u64,
    frozen: BTreeSet<Address>,
    seeds: BTreeSet<[u8; 32]>,
    /// `round_vrf` of every round ever created: tracked after the round closes.
    vrfs: BTreeSet<Address>,
    lp_requests: Vec<(bool, u64, usize)>,
    /// Invariant 11: shares made claimable (settled and forfeited) and claimed.
    shares_released: u64,
    shares_claimed: u64,
    /// Invariant 3: `(R, S, U)` of each round before its draw, last step.
    before_draw: BTreeMap<u64, (u64, u64, u64)>,
    /// The vault's `volume_total` and `integrators`.
    volume_total: u64,
    integrators: u64,
    /// The share supply: only a strike moves it, and the model takes it from
    /// the program after one.
    total_shares: u64,
    /// The drawdown ring and the last trip, replayed at every observation
    /// (admission, each settlement, a forfeiture, a direct expiry).
    ring: Ring,
    trip_ts: i64,
    /// The epoch counters' generation (Spec 08 §4): rolled when a liquidity
    /// provider's request opens an epoch and when a strike promotes the next.
    generation: u32,
    /// `Vault.after_close_gain` and `after_close_loss`: the results of the
    /// tickets `after` counts in the current generation that have closed
    /// (each settlement, direct expiry and forfeiture, Spec 08 §4 rule 5,
    /// §13.5.7, §13.5.8), cleared by a strike and by a roll. A strike
    /// prices on the settled assets less them.
    after_close_gain: u64,
    after_close_loss: u64,
}

/// What the model expects of an instruction.
#[derive(Clone, Copy, Debug)]
enum Want {
    Ok,
    /// This custom error code (Fade's are 6000 and up).
    Code(u32),
    /// Either; a failure must move nothing (a path the model does not predict).
    Any,
    /// Any error, which must move nothing: the instruction names a closed
    /// account, refused by Anchor's constraints before the program's checks.
    Refused,
}

fn code(e: FadeError) -> u32 {
    fade_error(e)
}
fn rej(r: Reject) -> u32 {
    code(FadeError::from(r))
}

/// Counts what the run did, for the report.
#[derive(Default)]
struct Stats {
    cases: AtomicU64,
    steps: AtomicU64,
    sent: AtomicU64,
    refused: AtomicU64,
    joins: AtomicU64,
    capacity: AtomicU64,
    paid: AtomicU64,
    drawn: AtomicU64,
    refunded: AtomicU64,
    forfeited: AtomicU64,
    settled: AtomicU64,
    parked: AtomicU64,
    directs: AtomicU64,
    strikes: AtomicU64,
    /// Strikes refused for a ticket of the epoch's price still open.
    unclean: AtomicU64,
    solo: AtomicU64,
    /// Drawdown trips recorded by settlements and forfeitures.
    trips: AtomicU64,
    /// The most tickets one accepted batch settled.
    largest: AtomicU64,
    /// Results booked as after-close ones (settlements, direct expiries,
    /// forfeitures of items `after` counts).
    booked: AtomicU64,
    /// Strikes with an after-close round or direct ticket still open, and
    /// strikes that left out booked after-close results.
    strikes_after_open: AtomicU64,
    strikes_with_results: AtomicU64,
    // The boundaries, each counted when an instruction is sent at it.
    /// Joins refused `RoundEpochClosed`: a paid round of the `before` side
    /// at or after the live close (invariant 8).
    join_epoch_closed: AtomicU64,
    /// Joins at a paid round's `close_slot` (they go to the next round).
    join_at_close: AtomicU64,
    /// Joins a paid, open round had no room for, sent to the next round.
    rotated: AtomicU64,
    /// Requests at `close_slot + 1` (one before the window) and at
    /// `close_slot + t_settle_slots` (its last slot).
    request_before_window: AtomicU64,
    request_last_slot: AtomicU64,
    /// `expire_round` at `close_slot + t_settle_slots` (the last slot not
    /// expired) and refunds at `refund_from + refund_slots − 1`.
    expire_last_slot: AtomicU64,
    refund_last_slot: AtomicU64,
    /// Refunds sent by a stranger to the round once its window is open.
    refund_stranger: AtomicU64,
    /// Rounds whose entropy `record_round_entropy` recorded.
    recorded: AtomicU64,
    /// Sweeps of `round_vrf` that moved lamports into an open round, and to
    /// the caller of a closed one; requests ORAO fulfilled after their round
    /// forfeited or closed.
    swept_into_round: AtomicU64,
    swept_to_caller: AtomicU64,
    late_fulfilled: AtomicU64,
    /// Paid rounds `expire_round` refunded, their entropy never recorded and
    /// no longer proven by SlotHashes.
    expire_refunded: AtomicU64,
    /// Direct tickets `refund_expired_ticket` refunded, their entropy never
    /// recorded and no longer proven by SlotHashes.
    direct_refunded: AtomicU64,
    /// Expiries refused `AlreadyFulfilled` for a request found only through
    /// the round's recorded seed, SlotHashes no longer proving `s*`.
    fulfilled_found_recorded: AtomicU64,
    /// Late bindings from a recorded seed SlotHashes no longer proves.
    late_bind_recorded: AtomicU64,
    /// Of those, refunds of a round whose draw no longer fits, taken.
    refund_doomed: AtomicU64,
    /// Cases started from a world other than `World::Wide`.
    tight: AtomicU64,
    /// `join_round` and `open_ticket` predicted refused by the drawdown
    /// breaker and by each admission check, and admitted with the cap halved
    /// by the breaker's aftermath (`halved`, whatever admission then decides).
    join_admissions: Admissions,
    open_admissions: Admissions,
}

#[derive(Default)]
struct Admissions {
    drawdown: AtomicU64,
    per_ticket_cap: AtomicU64,
    integrator_cap: AtomicU64,
    utilisation: AtomicU64,
    global_exposure: AtomicU64,
    insolvent: AtomicU64,
    halved: AtomicU64,
}

impl Admissions {
    /// Counts a predicted refusal by the breaker or by admission.
    fn refused(&self, c: u32) {
        let counter = [
            (FadeError::DrawdownBreaker, &self.drawdown),
            (FadeError::PerTicketCap, &self.per_ticket_cap),
            (FadeError::IntegratorCap, &self.integrator_cap),
            (FadeError::UtilisationBreaker, &self.utilisation),
            (FadeError::GlobalExposure, &self.global_exposure),
            (FadeError::Insolvent, &self.insolvent),
        ]
        .into_iter()
        .find(|(e, _)| code(*e) == c);
        if let Some((_, n)) = counter {
            bump(n);
        }
    }
}

fn bump(c: &AtomicU64) {
    c.fetch_add(1, Ordering::Relaxed);
}

// --- the simulation ------------------------------------------------------------------------

struct Sim<'a> {
    env: Env,
    a: &'a Actors,
    m: Model,
    stats: &'a Stats,
}

/// A refused instruction's view of the world: every account the model knows.
type Snapshot = Vec<(Address, Option<Account>)>;

fn round_ticket_addr(env: &Env, a: &Actors, integrator: usize, nonce: u64) -> Address {
    env.round_ticket_address(&a.integrators[integrator].pubkey(), nonce)
}

fn counters_of(v: &Vault) -> Counters {
    Counters {
        before: v.open_before_close,
        after: v.open_after_close,
        generation: v.generation,
        close_ts: v.close_ts,
    }
}

/// Where an item recorded with `(side, generation)` sits now: `Some(true)`
/// in `before`, `Some(false)` in `after`, `None` if in neither (Spec 08 §4
/// rule 4).
fn counter_of(side: Side, generation: u32, current: u32) -> Option<bool> {
    let in_before = match side {
        Side::BeforeClose => generation == current,
        Side::AfterClose => current.checked_sub(1) == Some(generation),
    };
    if in_before {
        Some(true)
    } else if side == Side::AfterClose && generation == current {
        Some(false)
    } else {
        None
    }
}

fn side_of(byte: u8) -> Side {
    if byte == Ticket::SIDE_BEFORE {
        Side::BeforeClose
    } else {
        Side::AfterClose
    }
}

impl<'a> Sim<'a> {
    fn new(base: &Env, a: &'a Actors, stats: &'a Stats) -> Self {
        let env = base.fork();
        let v = env.vault();
        let mut lamports = BTreeMap::new();
        for k in a.payers.iter().chain([&a.sponsor, &a.crank]) {
            lamports.insert(k.pubkey(), env.lamports(&k.pubkey()));
        }
        let mut tokens = BTreeMap::new();
        for t in a
            .funder_usdc
            .iter()
            .chain(&a.beneficiaries)
            .chain(&a.shares)
            .chain([&env.treasury, &env.a.payout_escrow, &env.a.vault_usdc])
        {
            tokens.insert(*t, env.balance(t));
        }
        let m = Model {
            rounds: BTreeMap::new(),
            tickets: BTreeMap::new(),
            directs: BTreeMap::new(),
            requests: BTreeMap::new(),
            integ: vec![MIntegrator::default(); N_INTEGRATORS],
            accepting_round: v.accepting_round,
            next_round_id: v.next_round_id,
            total_assets: v.total_assets,
            held: 0,
            protocol_accrued: 0,
            app_owed: 0,
            returns_owed: 0,
            forfeited: v.rounds_forfeited,
            forfeits_withheld: v.forfeits_withheld,
            ticket_forfeits_withheld: v.ticket_forfeits_withheld,
            lamports,
            tokens,
            pause: 0,
            fee: ORAO_FEE,
            frozen: BTreeSet::new(),
            seeds: BTreeSet::new(),
            vrfs: BTreeSet::new(),
            lp_requests: Vec::new(),
            shares_released: 0,
            shares_claimed: 0,
            before_draw: BTreeMap::new(),
            volume_total: v.volume_total,
            integrators: v.integrators,
            total_shares: v.total_shares,
            ring: v.ring(),
            trip_ts: v.drawdown_trip_ts,
            generation: v.generation,
            after_close_gain: v.after_close_gain,
            after_close_loss: v.after_close_loss,
        };
        assert_eq!((v.accepting_round, v.next_round_id), (0, 1));
        Sim { env, a, m, stats }
    }

    // --- plumbing ----------------------------------------------------------------------

    fn slot(&self) -> u64 {
        self.env.slot()
    }
    fn now(&self) -> i64 {
        self.env.now()
    }
    fn rent(&self, len: usize) -> u64 {
        self.env.svm.minimum_balance_for_rent_exemption(len)
    }
    fn pending_rent(&self) -> u64 {
        self.rent(orao_layout::PENDING_LEN)
    }
    fn lam(&mut self, a: &Address) -> &mut u64 {
        self.m.lamports.entry(*a).or_insert(0)
    }
    fn tok(&mut self, a: &Address) -> &mut u64 {
        self.m.tokens.entry(*a).or_insert(0)
    }
    fn account(&self, a: &Address) -> Option<Account> {
        self.env.svm.get_account(a).filter(|x| x.lamports > 0)
    }
    fn frozen(&self, a: &Address) -> bool {
        self.m.frozen.contains(a)
    }

    /// Sends `ixs` with the keeper paying the fee, so that no tracked
    /// account's lamports move by a fee.
    fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, Failure> {
        let keeper = self.env.keeper.insecure_clone();
        let mut all: Vec<&Keypair> = vec![&keeper];
        for s in signers {
            if !all.iter().any(|k| k.pubkey() == s.pubkey()) {
                all.push(s);
            }
        }
        bump(&self.stats.sent);
        self.env.send(ixs, &all)
    }

    /// Every account the model knows of, for the byte-for-byte comparison
    /// of a refused instruction.
    fn known(&self) -> Vec<Address> {
        let e = &self.env;
        let mut v = vec![
            e.a.config,
            e.a.vault,
            e.a.queue,
            e.a.vault_usdc,
            e.a.payout_escrow,
            e.a.deposit_queue,
            e.a.payable,
            e.a.share_mint,
            e.a.share_escrow,
            e.a.share_claims,
            e.a.network_state,
            round_address(self.m.next_round_id),
            round_address(self.m.next_round_id + 1),
        ];
        v.extend(self.m.lamports.keys());
        v.extend(self.m.tokens.keys());
        v.extend(self.m.vrfs.iter());
        v.extend(self.m.requests.keys());
        for (i, k) in self.a.integrators.iter().enumerate() {
            v.push(e.integrator_address(&k.pubkey()));
            let n = self.m.integ[i].next_nonce;
            v.push(round_ticket_addr(e, self.a, i, n));
            v.push(e.ticket_address(&k.pubkey(), n));
        }
        for id in self.m.rounds.keys() {
            let r = round_address(*id);
            v.push(r);
            for s in self.a.sponsors() {
                v.push(sponsorship_address(&r, &s));
            }
        }
        for d in self.m.directs.keys() {
            v.push(*d);
            v.push(e.vrf_payer(d));
        }
        v.sort();
        v.dedup();
        v
    }

    fn snapshot(&self) -> Snapshot {
        self.known()
            .into_iter()
            .map(|a| (a, self.account(&a)))
            .collect()
    }

    /// Runs `send`, then checks its result against `want`. A refusal must be
    /// the expected error and move nothing.
    fn attempt(
        &mut self,
        what: &str,
        want: Want,
        send: impl FnOnce(&mut Self) -> Result<TransactionMetadata, Failure>,
    ) -> Option<TransactionMetadata> {
        let before = self.snapshot();
        let result = send(self);
        match (want, result) {
            (Want::Ok | Want::Any, Ok(meta)) => Some(meta),
            (Want::Refused, Ok(meta)) => panic!(
                "{what}: the model expected a refusal, the program succeeded\n{}",
                meta.logs.join("\n")
            ),
            (Want::Ok, Err(f)) => panic!(
                "{what}: the model expected success, the program refused: {}\n{}",
                f.err,
                f.logs.join("\n")
            ),
            (Want::Code(c), Ok(meta)) => panic!(
                "{what}: the model expected error {c}, the program succeeded\n{}",
                meta.logs.join("\n")
            ),
            (Want::Code(c), Err(f)) => {
                assert!(
                    f.has_code(c),
                    "{what}: expected error {c}, got {}\n{}",
                    f.err,
                    f.logs.join("\n")
                );
                self.unchanged(what, &before);
                bump(&self.stats.refused);
                None
            }
            (Want::Any | Want::Refused, Err(_)) => {
                self.unchanged(what, &before);
                bump(&self.stats.refused);
                None
            }
        }
    }

    fn unchanged(&self, what: &str, before: &Snapshot) {
        let after = self.snapshot();
        assert_eq!(
            before.len(),
            after.len(),
            "{what}: the known accounts changed"
        );
        for ((a, x), (_, y)) in before.iter().zip(after.iter()) {
            assert!(x == y, "{what}: a refused instruction changed {a}");
        }
    }

    /// Moves the clock to `slot`, 0.4 s a slot, plus `extra` seconds.
    fn set_slot(&mut self, slot: u64, extra: i64) {
        let now_slot = self.slot();
        if slot <= now_slot && extra == 0 {
            return;
        }
        let slot = slot.max(now_slot);
        let secs = i64::try_from((slot - now_slot) * 2 / 5).unwrap() + extra;
        let unix = self.now() + secs;
        self.env.set_time(slot, unix);
    }

    fn pick_round(&self, sel: u8) -> Option<u64> {
        let ids: Vec<u64> = self.m.rounds.keys().copied().collect();
        (!ids.is_empty()).then(|| ids[usize::from(sel) % ids.len()])
    }
    fn pick_ticket(&self, sel: u16) -> Option<Address> {
        let ts: Vec<Address> = self.m.tickets.keys().copied().collect();
        (!ts.is_empty()).then(|| ts[usize::from(sel) % ts.len()])
    }
    fn pick_direct(&self, sel: u16) -> Option<Address> {
        let ts: Vec<Address> = self.m.directs.keys().copied().collect();
        (!ts.is_empty()).then(|| ts[usize::from(sel) % ts.len()])
    }

    // --- the program's views the model predicts from --------------------------------------

    /// The vault's open credits, from the model's open tickets and rounds.
    fn open_credits(&self) -> u64 {
        let directs: u64 = self
            .m
            .directs
            .values()
            .filter(|d| d.status != DStatus::PayoutPending)
            .map(|d| d.credit)
            .sum();
        let rounds: u64 = self
            .m
            .rounds
            .values()
            .filter(|r| r.open_books())
            .map(|r| r.book.credits)
            .sum();
        directs + rounds
    }

    /// The vault's reserved liability, from the model's open tickets and
    /// rounds (an integrator's reservation outlives a refund or a
    /// forfeiture until each return; the vault's does not).
    fn open_reserved(&self) -> u64 {
        let directs: u64 = self
            .m
            .directs
            .values()
            .filter(|d| d.status != DStatus::PayoutPending)
            .map(|d| d.liability)
            .sum();
        let rounds: u64 = self
            .m
            .rounds
            .values()
            .filter(|r| r.open_books())
            .map(|r| r.book.liability)
            .sum();
        directs + rounds
    }

    /// The settled share price (Spec 08 §8) from the model's own books.
    fn price(&self) -> Result<u128, u32> {
        let settled = self
            .m
            .total_assets
            .checked_sub(self.open_credits())
            .ok_or(code(FadeError::MathOverflow))?;
        drawdown::share_price(settled, self.m.total_shares).map_err(rej)
    }

    /// A closing ticket's or a forfeiture's observation, `before` being the
    /// price before its books moved: the ring observed, a trip recorded
    /// against the snapshotted threshold.
    fn observe(&mut self, before: u128, drawdown_bps: u64) {
        let now = self.now();
        let after = self.price().unwrap();
        self.m.ring.observe(now, before, after);
        if self.m.ring.tripped(after, drawdown_bps) {
            self.m.trip_ts = now;
            bump(&self.stats.trips);
        }
    }

    /// A closing ticket's or a forfeiture's result, booked as an after-close
    /// one when the counter it leaves is `after` in the current generation
    /// (Spec 08 §4 rule 5): `credit − payout` a gain, `payout − credit` a
    /// loss. Called before the item leaves its counter.
    fn book_after_close(&mut self, side: Side, generation: u32, credit: u64, payout: u64) {
        if counter_of(side, generation, self.m.generation) != Some(false) {
            return;
        }
        if credit >= payout {
            self.m.after_close_gain += credit - payout;
        } else {
            self.m.after_close_loss += payout - credit;
        }
        bump(&self.stats.booked);
    }

    /// A roll of the counters' generation (Spec 08 §4 rule 6): the tickets
    /// `after` counted become the next epoch's, and so do their results.
    fn roll_generation(&mut self) {
        self.m.generation += 1;
        self.m.after_close_gain = 0;
        self.m.after_close_loss = 0;
    }

    /// The drawdown gate as `join_round` and `open_ticket` apply it, from
    /// the model's ring: whether caps are halved, and the ring as observed.
    fn drawdown(&self, drawdown_bps: u64, now: i64) -> Result<(bool, Ring), u32> {
        let price = self.price()?;
        let mut ring = self.m.ring;
        ring.observe(now, price, price);
        if ring.tripped(price, drawdown_bps) {
            return Err(code(FadeError::DrawdownBreaker));
        }
        let t = self.m.trip_ts;
        Ok((t != 0 && now < t + fade::DRAWDOWN_AFTERMATH_SECONDS, ring))
    }

    /// `check_margin`: the split, then the invariant with every share.
    fn margin(&self, table: usize, app: u64) -> Result<u64, u32> {
        let p = self.env.config().params;
        let lhs = self.a.summaries[table].lhs;
        let margin = payout_table::margin_bps(lhs).ok_or(code(FadeError::PayoutTableOverpays))?;
        let vault_margin = risk::check_split(margin, app, &p.to_math()).map_err(rej)?;
        let floor = p.min_vault_margin_bps + p.protocol_share_bps + app;
        if floor > fade_math::BPS || !payout_table::ev_ok(lhs, floor) {
            return Err(code(FadeError::MarginFloor));
        }
        Ok(vault_margin)
    }

    /// The integrator as admission reads it, from the model (0 and 0 before
    /// its record exists).
    fn integrator_math(&self, i: usize) -> risk::Integrator {
        let mi = &self.m.integ[i];
        risk::Integrator {
            reserved: mi.reserved,
            volume_total: mi.volume,
        }
    }

    fn entropy(&self, close_slot: u64) -> Option<slot_hashes::Entry> {
        let data = self
            .env
            .svm
            .get_account(&addr(fade::SLOT_HASHES_ID))
            .unwrap()
            .data;
        slot_hashes::first_after_retained(&data, close_slot)
    }

    /// Round `id`'s seed and ORAO request address for an entropy entry,
    /// byte by byte from Spec 08 §13.4.
    fn seed_of(&self, id: u64, close_slot: u64, e: &slot_hashes::Entry) -> ([u8; 32], Address) {
        let mut pre = b"FADE/BEACON-SEED/v1".to_vec();
        pre.extend_from_slice(fade_id().as_ref());
        pre.extend_from_slice(round_address(id).as_ref());
        pre.extend_from_slice(&close_slot.to_le_bytes());
        pre.extend_from_slice(&e.slot.to_le_bytes());
        pre.extend_from_slice(&e.hash);
        let seed = solana_sha256_hasher::hashv(&[&pre]).to_bytes();
        let request = pda(&[orao_layout::REQUEST_SEED, &seed], &orao_id());
        (seed, request)
    }

    /// Round `id`'s entropy as the program finds it (`round_entropy`):
    /// `(s*, seed, request)` from the recorded seed whatever SlotHashes holds,
    /// else from SlotHashes while it proves `s*`; `Err(true)` once it can
    /// no longer be proven (lost), `Err(false)` before `s*` exists.
    fn known_entropy(&self, id: u64) -> Result<(u64, [u8; 32], Address), bool> {
        let r = &self.m.rounds[&id];
        if r.entropy_slot != 0 {
            let request = pda(&[orao_layout::REQUEST_SEED, &r.seed], &orao_id());
            return Ok((r.entropy_slot, r.seed, request));
        }
        match self.entropy(r.close_slot) {
            Some(e) => {
                let (seed, request) = self.seed_of(id, r.close_slot, &e);
                Ok((e.slot, seed, request))
            }
            None => {
                let data = self
                    .env
                    .svm
                    .get_account(&addr(fade::SLOT_HASHES_ID))
                    .unwrap()
                    .data;
                Err(slot_hashes::first_after(&data, r.close_slot).is_some())
            }
        }
    }

    /// Whether SlotHashes still proves round `id`'s `s*`.
    fn proven(&self, id: u64) -> bool {
        let close = self.m.rounds[&id].close_slot;
        close > 0 && self.entropy(close).is_some()
    }

    // --- join_round (§13.5.2) ----------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn join(&mut self, i: usize, f: usize, p: usize, t: usize, price: u64, app: u64, sp: u8) {
        let slot = self.slot();
        let now = self.now();
        let params = self.env.config().params;
        let v = self.env.vault();
        let pending_rent = self.pending_rent();

        // Round resolution, the model's own.
        let accepting = self
            .m
            .rounds
            .get(&self.m.accepting_round)
            .filter(|r| self.m.accepting_round != 0 && r.accepts(slot))
            .map(|r| r.id);
        let fresh = (
            Terms {
                threshold: params.beacon_threshold,
                draw_max: beacon::prefund(self.m.fee, pending_rent, params.crank_request_lamports)
                    .unwrap(),
                round_k: u8::try_from(params.round_k).unwrap(),
            },
            Book::default(),
            params.crank_request_lamports,
            params.beacon_min_price,
            params.crank_round_settle_lamports,
            RoundStatus::Accepting,
        );
        let target = |id: Option<u64>| match id {
            Some(id) => {
                let r = &self.m.rounds[&id];
                (
                    r.terms,
                    r.book,
                    r.request_share,
                    r.min_price,
                    r.settle_share,
                    r.status,
                )
            }
            None => fresh,
        };
        let mut create = accepting.is_none();
        let mut id = accepting.unwrap_or(self.m.next_round_id);
        let (mut terms, book0, _, _, _, _) = target(accepting);
        let to_pay =
            beacon::sponsorship_to_pay(&terms, book0.prices + price, book0.sponsorship).unwrap();
        let sponsorship = match sp % 10 {
            0..=4 => 0,
            5 => 100_000,
            6 | 7 => to_pay,
            8 => to_pay + 50_000,
            _ => 2_000_000,
        };
        let payer = self.a.payers[p].pubkey();

        // The prediction, in the check order of §13.5.2, against one round.
        let predict = |id: u64,
                       (terms, book0, request_share, min_price, _, status): (
            Terms,
            Book,
            u64,
            u64,
            u64,
            RoundStatus,
        )|
         -> Result<_, u32> {
            if self.m.pause & (PAUSE_TICKETS | PAUSE_ROUNDS) != 0 {
                return Err(code(FadeError::Paused));
            }
            let mi = &self.m.integ[i];
            if !mi.created && self.frozen(&self.a.shares[i]) {
                return Err(code(FadeError::WrongMint));
            }
            if mi.paused {
                return Err(code(FadeError::IntegratorPaused));
            }
            let vault_margin = self.margin(t, app)?;
            if !beacon::request_fits(self.m.fee, pending_rent, request_share, terms.draw_max) {
                return Err(code(FadeError::DrawUnderfunded));
            }
            let (halved, ring) = self.drawdown(params.drawdown_bps, now)?;
            if halved {
                bump(&self.stats.join_admissions.halved);
            }
            let mut math = params.to_math();
            math.min_price = min_price;
            let w = risk::ticket_for(price, self.a.summaries[t].max_m, app, &math).map_err(rej)?;
            let adm = risk::admit(
                &risk::Vault {
                    assets: v.total_assets,
                    reserved: v.total_reserved_liability,
                    open_credits: v.open_vault_credits,
                },
                &self.integrator_math(i),
                &math,
                &w,
                vault_margin,
                halved,
            )
            .map_err(rej)?;
            let entry =
                beacon::entry(&terms, &w, &adm, app, params.protocol_share_bps).map_err(rej)?;
            let book = book0
                .join(&terms, &entry, sponsorship)
                .map_err(rej)?
                .ok_or(code(FadeError::RoundCapacity))?;
            let became_paid = status == RoundStatus::Accepting && book.is_paid(&terms);
            let mut c = counters_of(&v);
            let recorded = if became_paid {
                Some(c.open_n(now, book.tickets).map_err(rej)?)
            } else {
                if status == RoundStatus::Paid {
                    let r = &self.m.rounds[&id];
                    c.join_n(now, r.side, r.generation, 1).map_err(rej)?;
                }
                None
            };
            if self.frozen(&self.a.funder_usdc[f]) {
                return Err(TOKEN_FROZEN);
            }
            Ok((w, entry, book, recorded, ring))
        };
        let first = target(accepting);
        let mut chosen = first;
        let mut predicted = predict(id, first);
        // A paid accepting round this join does not fit sends it to the
        // next round, which it creates (Spec 09 §7 as built).
        if matches!(predicted, Err(c) if c == code(FadeError::RoundCapacity))
            && !create
            && first.5 == RoundStatus::Paid
        {
            bump(&self.stats.rotated);
            create = true;
            id = self.m.next_round_id;
            chosen = fresh;
            terms = fresh.0;
            predicted = predict(id, fresh);
        }
        let (_, _, request_share, min_price, settle_share, _) = chosen;
        let round_key = round_address(id);
        let record = sponsorship_address(&round_key, &payer);
        let new_record = sponsorship > 0
            && !self
                .m
                .rounds
                .get(&id)
                .is_some_and(|r| r.sponsors.contains_key(&payer));
        let want = match &predicted {
            Ok(_) => Want::Ok,
            Err(c) => Want::Code(*c),
        };
        if let Err(c) = &predicted {
            self.stats.join_admissions.refused(*c);
        }
        if matches!(predicted, Err(c) if c == code(FadeError::RoundCapacity)) {
            bump(&self.stats.capacity);
        }
        if matches!(predicted, Err(c) if c == code(FadeError::RoundEpochClosed)) {
            bump(&self.stats.join_epoch_closed);
        }
        if self
            .m
            .rounds
            .get(&self.m.accepting_round)
            .is_some_and(|r| r.status == RoundStatus::Paid && r.close_slot == slot)
        {
            bump(&self.stats.join_at_close);
        }

        let nonce = self.m.integ[i].next_nonce;
        let j = JoinArgs {
            authority: self.a.integrators[i].pubkey(),
            payer,
            funder: self.a.funders[f].pubkey(),
            funder_usdc: self.a.funder_usdc[f],
            share_account: Some(self.a.shares[i]),
            beneficiary: self.a.beneficiaries[f],
            payout_table: self.a.table_addrs[t],
            price,
            app_share_bps: app,
            nonce,
            sponsorship,
            round: round_address(if self.m.accepting_round != 0 {
                self.m.accepting_round
            } else {
                self.m.next_round_id
            }),
            next_round: round_address(
                if self.m.accepting_round != 0 {
                    self.m.accepting_round
                } else {
                    self.m.next_round_id
                } + 1,
            ),
            sponsorship_record: (sponsorship > 0).then_some(record),
        };
        let ix = self.env.join_round_ix(&j);
        let (ik, pk_, fk) = (
            self.a.integrators[i].insecure_clone(),
            self.a.payers[p].insecure_clone(),
            self.a.funders[f].insecure_clone(),
        );
        let Some(_meta) = self.attempt("join_round", want, |s| s.send(&[ix], &[&ik, &pk_, &fk]))
        else {
            return;
        };
        bump(&self.stats.joins);
        let (w, entry, book, recorded, ring) = predicted.unwrap();
        self.m.ring = ring;

        // --- the effects ---------------------------------------------------------------------
        let ticket = round_ticket_addr(&self.env, self.a, i, nonce);
        let t_rent = self.rent(ROUND_TICKET_LEN);
        let created_integrator = !self.m.integ[i].created;
        let mut cost = t_rent + settle_share + entry.prepay + sponsorship;
        if create {
            cost += self.rent(ROUND_LEN);
        }
        if new_record {
            cost += self.rent(SPONSORSHIP_LEN);
            let r = self.rent(SPONSORSHIP_LEN);
            *self.lam(&record) += r;
        }
        if created_integrator {
            cost += self.rent(INTEGRATOR_LEN);
            self.m.integrators += 1;
        }
        *self.lam(&payer) -= cost;
        let round_rent = if create { self.rent(ROUND_LEN) } else { 0 };
        *self.lam(&round_key) += entry.prepay + sponsorship + round_rent;
        *self.lam(&ticket) = t_rent + settle_share;
        *self.tok(&self.a.funder_usdc[f].clone()) -= price;
        let vu = self.env.a.vault_usdc;
        *self.tok(&vu) += price;
        self.m.total_assets += entry.vault_credit;
        self.m.held += entry.protocol_share + entry.app_share;
        if create {
            self.m.rounds.insert(
                id,
                MRound {
                    id,
                    status: RoundStatus::Accepting,
                    rent_payer: payer,
                    first_slot: slot,
                    paid_slot: 0,
                    close_slot: 0,
                    terms,
                    min_price,
                    settle_share,
                    request_share,
                    tick_slots: params.tick_slots,
                    refund_slots: params.refund_slots,
                    t_settle_slots: params.t_settle_slots,
                    drawdown_bps: params.drawdown_bps,
                    book: Book::default(),
                    sponsors: BTreeMap::new(),
                    counted: false,
                    side: Side::BeforeClose,
                    generation: 0,
                    randomness: Address::default(),
                    seed: [0; 32],
                    entropy_slot: 0,
                    funded: 0,
                    draw_cost: 0,
                    drawn: None,
                    members: Vec::new(),
                    last_join_slot: slot,
                    charges: 0,
                    prices_at_close: None,
                },
            );
            self.m.vrfs.insert(round_vrf_address(id));
            self.m.accepting_round = id;
            self.m.next_round_id = id + 1;
        }
        let r = self.m.rounds.get_mut(&id).unwrap();
        r.book = book;
        if sponsorship > 0 {
            *r.sponsors.entry(payer).or_insert(0) += sponsorship;
        }
        r.members.push(ticket);
        r.last_join_slot = slot;
        if let Some((side, generation)) = recorded {
            r.status = RoundStatus::Paid;
            r.paid_slot = slot;
            r.close_slot = beacon::close_slot(slot, r.tick_slots).unwrap();
            r.counted = true;
            r.side = side;
            r.generation = generation;
            bump(&self.stats.paid);
        }
        let mi = &mut self.m.integ[i];
        mi.created = true;
        mi.reserved += entry.liability;
        mi.open += 1;
        mi.next_nonce += 1;
        self.m.tickets.insert(
            ticket,
            MTicket {
                round: id,
                integrator: i,
                nonce,
                payer: p,
                funder: f,
                table: t,
                price,
                credit: entry.vault_credit,
                payout_max: w.payout_max,
                liability: entry.liability,
                protocol_share: entry.protocol_share,
                app_share: entry.app_share,
                prepay: entry.prepay,
                settle_share,
                status: TStatus::Joined,
                payout: 0,
            },
        );
    }

    // --- sponsor_round (§13.5.3) ---------------------------------------------------------------

    fn sponsor(&mut self, who: u8, round: u8, amount: u8) {
        let Some(id) = self.pick_round(round) else {
            return;
        };
        let sponsors = self.a.sponsors();
        let sponsor = sponsors[usize::from(who) % sponsors.len()];
        let r = &self.m.rounds[&id];
        let to_pay =
            beacon::sponsorship_to_pay(&r.terms, r.book.prices, r.book.sponsorship).unwrap_or(0);
        let lamports = match amount % 6 {
            0 => 0,
            1 => 50_000,
            2 | 3 => to_pay.max(1),
            4 => to_pay + 1,
            _ => 1_000_000,
        };
        let now = self.now();
        let slot = self.slot();
        let v = self.env.vault();
        let predicted = (|| -> Result<_, u32> {
            if lamports == 0 {
                return Err(code(FadeError::ZeroAmount));
            }
            if !matches!(r.status, RoundStatus::Accepting | RoundStatus::Paid) {
                return Err(code(FadeError::RoundNotAccepting));
            }
            if r.status == RoundStatus::Accepting
                && self.m.pause & (PAUSE_TICKETS | PAUSE_ROUNDS) != 0
            {
                return Err(code(FadeError::Paused));
            }
            if !beacon::request_fits(
                self.m.fee,
                self.pending_rent(),
                r.request_share,
                r.terms.draw_max,
            ) {
                return Err(code(FadeError::DrawUnderfunded));
            }
            let book = r.book.sponsor(lamports).map_err(rej)?;
            let became_paid = r.status == RoundStatus::Accepting && book.is_paid(&r.terms);
            let recorded = if became_paid {
                let mut c = counters_of(&v);
                Some(c.open_n(now, book.tickets).map_err(rej)?)
            } else {
                None
            };
            Ok((book, recorded))
        })();
        let want = match &predicted {
            Ok(_) => Want::Ok,
            Err(c) => Want::Code(*c),
        };
        let round_key = round_address(id);
        let record = sponsorship_address(&round_key, &sponsor);
        let ix = self
            .env
            .sponsor_round_ix(&sponsor, &record, &round_key, lamports);
        let kp = self.a.sponsor_kp(&sponsor).insecure_clone();
        if self
            .attempt("sponsor_round", want, |s| s.send(&[ix], &[&kp]))
            .is_none()
        {
            return;
        }
        let (book, recorded) = predicted.unwrap();
        let new_record = !self.m.rounds[&id].sponsors.contains_key(&sponsor);
        let rec_rent = if new_record {
            self.rent(SPONSORSHIP_LEN)
        } else {
            0
        };
        *self.lam(&sponsor) -= lamports + rec_rent;
        *self.lam(&record) += rec_rent;
        *self.lam(&round_key) += lamports;
        let r = self.m.rounds.get_mut(&id).unwrap();
        r.book = book;
        *r.sponsors.entry(sponsor).or_insert(0) += lamports;
        if let Some((side, generation)) = recorded {
            r.status = RoundStatus::Paid;
            r.paid_slot = slot;
            r.close_slot = beacon::close_slot(slot, r.tick_slots).unwrap();
            r.counted = true;
            r.side = side;
            r.generation = generation;
            bump(&self.stats.paid);
        }
    }

    // --- request_round_draw (§13.5.6), and ORAO -----------------------------------------------

    fn request(&mut self, round: u8) {
        let Some(id) = self.pick_round(round) else {
            return;
        };
        self.request_id(id);
    }

    fn request_id(&mut self, id: u64) {
        let slot = self.slot();
        let r = self.m.rounds[&id].clone();
        if r.status == RoundStatus::Paid {
            if slot == r.close_slot + 1 {
                bump(&self.stats.request_before_window);
            }
            if slot == r.close_slot + r.t_settle_slots {
                bump(&self.stats.request_last_slot);
            }
        }
        let recorded = r.entropy_slot != 0;
        let known = if r.close_slot > 0 {
            self.known_entropy(id)
        } else {
            Err(false)
        };
        let request = match &known {
            Ok((_, _, q)) => *q,
            Err(_) => Address::new_unique(),
        };
        let pre_created = self.m.requests.contains_key(&request);
        let late = beacon::is_expired(slot, r.close_slot, r.t_settle_slots);
        let predicted = (|| -> Result<(), u32> {
            if r.status != RoundStatus::Paid {
                return Err(code(FadeError::WrongRoundStatus));
            }
            if !(beacon::in_request_window(slot, r.close_slot, r.t_settle_slots)
                || (late && pre_created))
            {
                return Err(code(FadeError::RoundRequestWindow));
            }
            if let Err(lost) = known {
                return Err(code(if lost {
                    FadeError::EntropyUnrecorded
                } else {
                    FadeError::EntropyUnavailable
                }));
            }
            // After the window, only a request fulfilled with a non-zero
            // randomness is bound late (review of step 12).
            if late
                && !matches!(
                    self.m.requests[&request].fulfilled,
                    Some(v) if v != [0u8; 64]
                )
            {
                return Err(code(FadeError::RoundRequestWindow));
            }
            if !pre_created
                && !beacon::request_fits(
                    self.m.fee,
                    self.pending_rent(),
                    r.request_share,
                    r.terms.draw_max,
                )
            {
                return Err(code(FadeError::DrawUnderfunded));
            }
            Ok(())
        })();
        let want = match predicted {
            Ok(()) => Want::Ok,
            Err(c) => Want::Code(c),
        };
        let crank = self.a.crank.insecure_clone();
        let ix = self
            .env
            .request_round_draw_ix(&crank.pubkey(), id, &request);
        if self
            .attempt("request_round_draw", want, |s| s.send(&[ix], &[&crank]))
            .is_none()
        {
            return;
        }
        let (entropy_slot, seed, _) = known.unwrap();
        // Invariant 9: a fresh seed and request, bound to a slot after every
        // join (a recorded seed was checked fresh when recorded).
        if !recorded {
            assert!(self.m.seeds.insert(seed), "two rounds share a seed");
        } else if late && !self.proven(id) {
            bump(&self.stats.late_bind_recorded);
        }
        assert!(entropy_slot > r.close_slot && r.close_slot > r.last_join_slot);
        let round_key = round_address(id);
        let vrf = round_vrf_address(id);
        let stray = self.m.lamports.get(&vrf).copied().unwrap_or(0);
        let funded = if pre_created {
            0
        } else {
            self.m.fee + self.pending_rent()
        };
        *self.lam(&round_key) -= funded + r.request_share;
        *self.lam(&round_key) += stray;
        *self.lam(&vrf) = 0;
        *self.lam(&crank.pubkey()) += r.request_share;
        if !pre_created {
            self.m.requests.insert(
                request,
                MRequest {
                    client: Client::RoundVrf(id),
                    fulfilled: None,
                },
            );
        }
        let r = self.m.rounds.get_mut(&id).unwrap();
        r.status = RoundStatus::Requested;
        r.randomness = request;
        r.seed = seed;
        r.entropy_slot = entropy_slot;
        r.funded = funded;
    }

    /// `record_round_entropy` (§13.5.6a): anyone records a paid round's seed
    /// while SlotHashes proves `s*`; a round already recorded is left as it
    /// is, and the call succeeds.
    fn record(&mut self, round: u8) {
        let Some(id) = self.pick_round(round) else {
            return;
        };
        let r = self.m.rounds[&id].clone();
        let recorded = r.entropy_slot != 0;
        let known = if r.close_slot > 0 {
            self.known_entropy(id)
        } else {
            Err(false)
        };
        let want = if recorded {
            Want::Ok
        } else if r.status != RoundStatus::Paid {
            Want::Code(code(FadeError::WrongRoundStatus))
        } else {
            match known {
                Ok(_) => Want::Ok,
                Err(true) => Want::Code(code(FadeError::EntropyUnrecorded)),
                Err(false) => Want::Code(code(FadeError::EntropyUnavailable)),
            }
        };
        // No signer of its own: the keeper pays the fee.
        let ix = self.env.record_round_entropy_ix(id);
        if self
            .attempt("record_round_entropy", want, |s| s.send(&[ix], &[]))
            .is_none()
            || recorded
        {
            return;
        }
        let (entropy_slot, seed, _) = known.unwrap();
        // Invariant 9, as at the request: a fresh seed, after every join.
        assert!(self.m.seeds.insert(seed), "two rounds share a seed");
        assert!(entropy_slot > r.close_slot && r.close_slot > r.last_join_slot);
        let rr = self.m.rounds.get_mut(&id).unwrap();
        rr.seed = seed;
        rr.entropy_slot = entropy_slot;
        bump(&self.stats.recorded);
    }

    /// Anyone creates round `id`'s ORAO request directly, once its seed is
    /// public, without Fade.
    fn pre_create(&mut self, round: u8) {
        let Some(id) = self.pick_round(round) else {
            return;
        };
        let r = &self.m.rounds[&id];
        if r.status != RoundStatus::Paid || self.slot() <= r.close_slot {
            return;
        }
        let Ok((_, seed, request)) = self.known_entropy(id) else {
            return;
        };
        if self.m.requests.contains_key(&request) {
            return;
        }
        let outsider = self.a.outsider.insecure_clone();
        let ix = Instruction {
            program_id: orao_id(),
            accounts: metas(
                orao_mock::accounts::RequestV2 {
                    payer: pk(outsider.pubkey()),
                    network_state: pk(self.env.a.network_state),
                    treasury: pk(self.env.orao_treasury),
                    request: pk(request),
                    system_program: pk(system_id()),
                }
                .to_account_metas(None),
            ),
            data: orao_mock::instruction::RequestV2 { seed }.data(),
        };
        self.attempt("ORAO request", Want::Ok, |s| s.send(&[ix], &[&outsider]));
        self.m.requests.insert(
            request,
            MRequest {
                client: Client::Outsider,
                fulfilled: None,
            },
        );
    }

    fn fulfill(&mut self, round: u8, value: u64, zero: bool) {
        let Some(id) = self.pick_round(round) else {
            return;
        };
        let r = &self.m.rounds[&id];
        let request = match r.status {
            RoundStatus::Requested => r.randomness,
            RoundStatus::Paid if r.close_slot < self.slot() => match self.known_entropy(id) {
                Ok((_, _, request)) => request,
                Err(_) => return,
            },
            _ => return,
        };
        self.fulfill_request(&request, value, zero);
    }

    fn fulfill_request(&mut self, request: &Address, value: u64, zero: bool) {
        let Some(q) = self.m.requests.get(request).cloned() else {
            return;
        };
        if q.fulfilled.is_some() {
            return;
        }
        let mut randomness = [0u8; 64];
        if !zero {
            randomness[..8].copy_from_slice(&value.to_le_bytes());
            randomness[63] = 1;
        }
        self.env.fulfill(request, randomness);
        if let Client::RoundVrf(id) = q.client {
            let refund = self.pending_rent() - self.rent(orao_layout::FULFILLED_LEN);
            *self.lam(&round_vrf_address(id)) += refund;
        }
        self.m.requests.get_mut(request).unwrap().fulfilled = Some(randomness);
    }

    // --- settle_round_tickets (§13.5.7) ------------------------------------------------------

    fn settle(&mut self, round: u8, order: u64, size: u8, malformed: bool) {
        let Some(id) = self.pick_round(round) else {
            return;
        };
        let mut members = self.m.rounds[&id].members.clone();
        // A deterministic shuffle of the round's tickets, closed ones included.
        let mut x = order | 1;
        for k in (1..members.len()).rev() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            members.swap(k, usize::try_from(x % (k as u64 + 1)).unwrap());
        }
        members.truncate(usize::from(size).clamp(1, MAX_BATCH));
        self.settle_batch(id, &members, malformed);
    }

    fn settle_batch(&mut self, id: u64, batch: &[Address], malformed: bool) {
        let r = self.m.rounds[&id].clone();
        // The randomness the program reads, and the first settlement's error.
        let randomness: Result<([u8; 64], bool), u32> = match r.status {
            RoundStatus::Requested => match self.m.requests[&r.randomness].fulfilled {
                Some(x) if x != [0; 64] => Ok((x, true)),
                _ => Err(code(FadeError::NotFulfilled)),
            },
            RoundStatus::Drawn => Ok((r.drawn.unwrap(), false)),
            _ => Err(code(FadeError::WrongRoundStatus)),
        };
        // The groups: each ticket with its stored keys, a beneficiary for a winner.
        let mut groups = Vec::new();
        let mut live = Vec::new();
        for t in batch {
            match self.m.tickets.get(t) {
                Some(mt) => {
                    let payout = match (&randomness, mt.status) {
                        (Ok((x, _)), TStatus::Joined) => self.env.beacon_payout_with(id, t, x),
                        _ => 0,
                    };
                    let won = payout > 0;
                    if mt.status == TStatus::Joined {
                        live.push((*t, payout));
                    }
                    groups.push(Group {
                        ticket: *t,
                        integrator: self
                            .env
                            .integrator_address(&self.a.integrators[mt.integrator].pubkey()),
                        payer: self.a.payers[mt.payer].pubkey(),
                        payout_table: self.a.table_addrs[mt.table],
                        beneficiary: won.then(|| self.a.beneficiaries[mt.funder]),
                    });
                }
                None => {
                    // Closed by an earlier batch: skipped, whatever it names.
                    groups.push(Group {
                        ticket: *t,
                        integrator: self.env.integrator_address(&self.a.integrators[0].pubkey()),
                        payer: self.a.payers[0].pubkey(),
                        payout_table: self.a.table_addrs[0],
                        beneficiary: None,
                    });
                }
            }
        }
        let flip = if malformed && !live.is_empty() {
            Some(groups.iter().position(|g| g.ticket == live[0].0).unwrap())
        } else {
            None
        };
        let want = match (&randomness, flip) {
            (Err(c), _) => Want::Code(*c),
            (Ok(_), Some(_)) => Want::Code(code(FadeError::MalformedBatch)),
            (Ok(_), None) => Want::Ok,
        };
        let crank = self.a.crank.insecure_clone();
        let rent_payer = r.rent_payer;
        let ix = match flip {
            None => self
                .env
                .settle_round_ix(&crank.pubkey(), id, &groups, Some(rent_payer)),
            Some(k) => {
                // The beneficiary of group `k` dropped, its bit kept: the
                // layout no longer matches what the round's randomness says.
                let mut wins = 0u32;
                let mut remaining = Vec::new();
                for (i, g) in groups.iter().enumerate() {
                    if g.beneficiary.is_some() || i == k {
                        wins |= 1 << i;
                    }
                    let mut gm = g.metas();
                    if i == k && g.beneficiary.is_some() {
                        gm.pop();
                        wins &= !(1 << i);
                    }
                    remaining.extend(gm);
                }
                if groups[k].beneficiary.is_none() {
                    // A loser claimed as a winner, with its beneficiary.
                    let b = self.a.beneficiaries[self.m.tickets[&groups[k].ticket].funder];
                    let mut rebuilt = Vec::new();
                    for (i, g) in groups.iter().enumerate() {
                        rebuilt.extend(g.metas());
                        if i == k {
                            rebuilt.push(solana_instruction::AccountMeta::new(b, false));
                        }
                    }
                    remaining = rebuilt;
                }
                let count = u8::try_from(groups.len()).unwrap();
                self.env.settle_round_raw_ix(
                    &crank.pubkey(),
                    id,
                    count,
                    wins,
                    remaining,
                    Some(rent_payer),
                )
            }
        };
        let mut lut: Vec<Address> = ix
            .accounts
            .iter()
            .map(|m| m.pubkey)
            .filter(|k| *k != crank.pubkey() && *k != self.env.keeper.pubkey())
            .collect();
        lut.sort();
        lut.dedup();
        let table = self.env.lookup_table(&lut);

        // One ticket settled alone, on a fork of the state before the batch.
        let solo = match (&want, live.first()) {
            (Want::Ok, Some((t, _))) => {
                let mut fork = self.env.fork();
                let g = groups.iter().find(|g| g.ticket == *t).unwrap().clone();
                let ix = fork.settle_round_ix(&crank.pubkey(), id, &[g], Some(rent_payer));
                let keeper = fork.keeper.insecure_clone();
                let meta = fork
                    .send_v0(&[compute_limit_ix(1_400_000), ix], &[&keeper, &crank], &[])
                    .expect("a ticket settles alone");
                bump(&self.stats.solo);
                Some(events::<RoundTicketSettled>(&meta).remove(0))
            }
            _ => None,
        };

        let keeper = self.env.keeper.insecure_clone();
        let Some(meta) = self.attempt("settle_round_tickets", want, |s| {
            bump(&s.stats.sent);
            s.env.send_v0(
                &[compute_limit_ix(1_400_000), ix],
                &[&keeper, &crank],
                &[table],
            )
        }) else {
            return;
        };
        let (x, first) = randomness.unwrap();
        let settled = events::<RoundTicketSettled>(&meta);
        if let Some(s) = solo {
            let b = settled
                .iter()
                .find(|e| e.ticket == s.ticket)
                .expect("the solo ticket settles in the batch");
            assert_eq!(
                (b.outcome, b.payout, b.charge, b.pending),
                (s.outcome, s.payout, s.charge, s.pending),
                "a ticket settles in a batch as it settles alone"
            );
        }

        // --- the effects ----------------------------------------------------------------------
        let round_key = round_address(id);
        let vrf = round_vrf_address(id);
        if first {
            let refund = self.m.lamports.get(&vrf).copied().unwrap_or(0);
            *self.lam(&round_key) += refund;
            *self.lam(&vrf) = 0;
            let rr = self.m.rounds.get_mut(&id).unwrap();
            rr.draw_cost = beacon::draw_cost(rr.funded, rr.request_share, refund).unwrap();
            rr.status = RoundStatus::Drawn;
            rr.drawn = Some(x);
            self.m.before_draw.remove(&id);
            bump(&self.stats.drawn);
        }
        let (c, s_total, prices) = {
            let rr = &self.m.rounds[&id];
            (rr.draw_cost, rr.book.sponsorship, rr.book.prices)
        };
        assert_eq!(
            settled.len(),
            live.len(),
            "every live ticket of the batch settles"
        );
        self.stats
            .largest
            .fetch_max(settled.len() as u64, Ordering::Relaxed);
        for (t, payout) in live {
            let price_before = self.price().unwrap();
            let mt = self.m.tickets[&t].clone();
            assert!(payout <= mt.payout_max);
            let ev = settled.iter().find(|e| addr(e.ticket) == t).unwrap();
            assert_eq!(ev.payout, payout, "the outcome of Spec 08 §13.4");
            let charge = beacon::charge(c, s_total, prices, mt.price).unwrap();
            assert!(
                charge <= mt.prepay,
                "invariant 7: a charge above the prepay"
            );
            assert_eq!(ev.charge, charge);
            let back = mt.prepay - charge;
            let beneficiary = self.a.beneficiaries[mt.funder];
            let parked = payout > 0 && self.frozen(&beneficiary);
            assert_eq!(ev.pending, parked);
            let vu = self.env.a.vault_usdc;
            *self.tok(&vu) -= payout;
            if parked {
                let esc = self.env.a.payout_escrow;
                *self.tok(&esc) += payout;
            } else {
                *self.tok(&beneficiary) += payout;
            }
            *self.lam(&self.a.crank.pubkey()) += mt.settle_share;
            *self.lam(&round_key) -= back;
            let payer = self.a.payers[mt.payer].pubkey();
            if parked {
                *self.lam(&t) += back;
                *self.lam(&t) -= mt.settle_share;
                let tm = self.m.tickets.get_mut(&t).unwrap();
                tm.status = TStatus::PayoutParked;
                tm.payout = payout;
                tm.settle_share = 0;
                bump(&self.stats.parked);
            } else {
                let held = self.m.lamports.remove(&t).unwrap() - mt.settle_share;
                *self.lam(&payer) += back + held;
                self.m.tickets.remove(&t);
            }
            self.book_after_close(r.side, r.generation, mt.vault_credit_of(), payout);
            self.m.total_assets -= payout;
            self.m.held -= mt.protocol_share + mt.app_share;
            self.m.protocol_accrued += mt.protocol_share;
            self.m.app_owed += mt.app_share;
            self.m.shares_released += mt.protocol_share + mt.app_share;
            self.m.volume_total += mt.price;
            let mi = &mut self.m.integ[mt.integrator];
            mi.reserved -= mt.liability;
            mi.open -= 1;
            mi.app_accrued += mt.app_share;
            mi.volume += mt.price;
            let rr = self.m.rounds.get_mut(&id).unwrap();
            rr.book.tickets -= 1;
            rr.book.prepaid -= mt.prepay;
            rr.book.liability -= mt.liability;
            rr.book.credits -= mt.vault_credit_of();
            rr.book.protocol_shares -= mt.protocol_share;
            rr.book.app_shares -= mt.app_share;
            rr.charges += charge;
            self.observe(price_before, r.drawdown_bps);
            bump(&self.stats.settled);
        }
        self.close_if_ended(id);
    }

    /// The round closes when it has ended with no ticket and no sponsorship:
    /// every lamport to its rent payer.
    fn close_if_ended(&mut self, id: u64) {
        let r = &self.m.rounds[&id];
        let ended = matches!(
            r.status,
            RoundStatus::Drawn | RoundStatus::Refunded | RoundStatus::Forfeited
        );
        if !ended || r.book.tickets != 0 || !r.sponsors.is_empty() {
            return;
        }
        // Invariant 7: the tickets' charges and the sponsors' cover the draw.
        let c = r.draw_cost;
        assert!(
            r.charges + r.book.sponsorship.min(c) >= c,
            "invariant 7: the draw is not covered"
        );
        let rent_payer = r.rent_payer;
        let round_key = round_address(id);
        let all = self.m.lamports.remove(&round_key).unwrap();
        *self.lam(&rent_payer) += all;
        self.m.rounds.remove(&id);
    }

    // --- refund, expiry, returns (§13.5.5, §13.5.8, §13.5.9) ---------------------------------

    fn refund(&mut self, round: u8) {
        let Some(id) = self.pick_round(round) else {
            return;
        };
        self.refund_id(id, true);
    }

    fn refund_id(&mut self, id: u64, may_be_stranger: bool) {
        let r = &self.m.rounds[&id];
        let from = r.refund_from();
        if r.status == RoundStatus::Accepting && self.slot() + 1 == from + r.refund_slots {
            bump(&self.stats.refund_last_slot);
        }
        // A round whose draw no longer fits its prefund at the live fee is
        // anyone's to refund (it can never be paid).
        let doomed = !beacon::request_fits(
            self.m.fee,
            self.pending_rent(),
            r.request_share,
            r.terms.draw_max,
        );
        // Who refunds: one time in four a stranger to the round, showing one
        // of its tickets; otherwise the payer of its first ticket.
        let first = r.members.first().copied();
        let stranger = first.is_none() || (may_be_stranger && (id + self.slot()).is_multiple_of(4));
        let caller = match first.and_then(|t| self.m.tickets.get(&t)) {
            Some(t) if !stranger => self.a.payers[t.payer].insecure_clone(),
            _ => self.a.crank.insecure_clone(),
        };
        let proof = first.unwrap_or(round_address(id));
        let want = match r.status {
            RoundStatus::Accepting => {
                if !beacon::refund_open(self.slot(), from, r.refund_slots) {
                    Want::Code(code(FadeError::RefundWindow))
                } else if stranger && doomed {
                    bump(&self.stats.refund_doomed);
                    Want::Ok
                } else if stranger {
                    bump(&self.stats.refund_stranger);
                    Want::Code(code(FadeError::NotRoundParticipant))
                } else {
                    Want::Ok
                }
            }
            RoundStatus::Paid | RoundStatus::Requested | RoundStatus::Drawn => {
                Want::Code(code(FadeError::RoundPaid))
            }
            _ => Want::Code(code(FadeError::WrongRoundStatus)),
        };
        let ix = self.env.refund_round_ix(&caller.pubkey(), id, &proof);
        if self
            .attempt("refund_round", want, |s| s.send(&[ix], &[&caller]))
            .is_none()
        {
            return;
        }
        let r = self.m.rounds.get_mut(&id).unwrap();
        r.status = RoundStatus::Refunded;
        let book = r.book;
        self.m.total_assets -= book.credits;
        self.m.held -= book.protocol_shares + book.app_shares;
        self.m.returns_owed += book.prices;
        if self.m.accepting_round == id {
            self.m.accepting_round = 0;
        }
        self.m.before_draw.remove(&id);
        bump(&self.stats.refunded);
    }

    fn expire(&mut self, round: u8) {
        let Some(id) = self.pick_round(round) else {
            return;
        };
        self.expire_id(id);
    }

    fn expire_id(&mut self, id: u64) {
        let r = self.m.rounds[&id].clone();
        if matches!(r.status, RoundStatus::Paid | RoundStatus::Requested)
            && self.slot() == r.close_slot + r.t_settle_slots
        {
            bump(&self.stats.expire_last_slot);
        }
        let requested = r.status == RoundStatus::Requested;
        // Never requested: the request is looked for at the recorded seed's
        // address, or SlotHashes' while it proves `s*`; neither (`lost`), the
        // round is refunded.
        let known = if requested || r.close_slot == 0 {
            Err(false)
        } else {
            self.known_entropy(id)
        };
        let lost = !requested && known == Err(true);
        let randomness = match (&known, requested) {
            (_, true) => r.randomness,
            (Ok((_, _, q)), false) => *q,
            (Err(_), false) => r.randomness,
        };
        let predicted = (|| -> Result<(), u32> {
            if !matches!(r.status, RoundStatus::Paid | RoundStatus::Requested) {
                return Err(code(FadeError::WrongRoundStatus));
            }
            if !beacon::is_expired(self.slot(), r.close_slot, r.t_settle_slots) {
                return Err(code(FadeError::NotExpired));
            }
            if !requested && known == Err(false) {
                return Err(code(FadeError::EntropyUnavailable));
            }
            if !lost {
                if let Some(q) = self.m.requests.get(&randomness) {
                    if matches!(q.fulfilled, Some(x) if x != [0; 64]) {
                        if !requested && !self.proven(id) {
                            bump(&self.stats.fulfilled_found_recorded);
                        }
                        return Err(code(FadeError::AlreadyFulfilled));
                    }
                }
            }
            Ok(())
        })();
        let want = match predicted {
            Ok(()) => Want::Ok,
            Err(c) => Want::Code(c),
        };
        // What `RoundExpired` reports, and so whether the forfeiture counts
        // as one a withheld draw may explain (`Vault.forfeits_withheld`).
        let checked = !lost;
        let found = requested || (checked && self.m.requests.contains_key(&randomness));
        let withheld = requested || found || !checked;
        let crank = self.a.crank.insecure_clone();
        let ix = self.env.expire_round_ix(&crank.pubkey(), id, &randomness);
        if self
            .attempt("expire_round", want, |s| s.send(&[ix], &[&crank]))
            .is_none()
        {
            return;
        }
        if lost {
            // Refunded, as `refund_round` refunds an unpaid round; its tickets
            // leave their counter with its status; nothing spent, no result.
            let book = r.book;
            self.m.total_assets -= book.credits;
            self.m.held -= book.protocol_shares + book.app_shares;
            self.m.returns_owed += book.prices;
            let rr = self.m.rounds.get_mut(&id).unwrap();
            rr.status = RoundStatus::Refunded;
            rr.draw_cost = 0;
            self.m.before_draw.remove(&id);
            self.m.forfeits_withheld += 1;
            bump(&self.stats.expire_refunded);
            return;
        }
        let round_key = round_address(id);
        let vrf = round_vrf_address(id);
        let draw_cost = if requested {
            let refund = self.m.lamports.get(&vrf).copied().unwrap_or(0);
            *self.lam(&round_key) += refund;
            *self.lam(&vrf) = 0;
            beacon::draw_cost(r.funded, r.request_share, refund).unwrap()
        } else {
            0
        };
        let price_before = self.price().unwrap();
        // Every ticket of the round leaves at once, its credit kept: one
        // after-close gain of the round's credits when it is `after`'s.
        self.book_after_close(r.side, r.generation, r.book.credits, 0);
        self.m.held -= r.book.protocol_shares;
        self.m.protocol_accrued += r.book.protocol_shares;
        self.m.shares_released += r.book.protocol_shares;
        let rr = self.m.rounds.get_mut(&id).unwrap();
        rr.status = RoundStatus::Forfeited;
        rr.draw_cost = draw_cost;
        self.observe(price_before, r.drawdown_bps);
        self.m.before_draw.remove(&id);
        self.m.forfeited += 1;
        if withheld {
            self.m.forfeits_withheld += 1;
        }
        bump(&self.stats.forfeited);
    }

    // --- sweep_round_vrf (§13.5.8a) ---------------------------------------------------------

    fn sweep(&mut self, round: u8) {
        let n = self.m.next_round_id;
        let id = if n <= 1 || round.is_multiple_of(16) {
            n
        } else {
            1 + u64::from(round) % (n - 1)
        };
        self.sweep_id(id);
    }

    /// Every lamport on `round_vrf` into the round while it exists, to the
    /// caller once it has closed; refused for an id the vault has not
    /// created (`WrongRound`) and for a `Requested` round
    /// (`WrongRoundStatus`), whose `round_vrf` holds what its first
    /// settlement or expiry deducts from the draw cost.
    fn sweep_id(&mut self, id: u64) {
        let vrf = round_vrf_address(id);
        let held = self.m.lamports.get(&vrf).copied().unwrap_or(0);
        let status = self.m.rounds.get(&id).map(|r| r.status);
        let want = if id == 0 || id >= self.m.next_round_id {
            Want::Code(code(FadeError::WrongRound))
        } else if status == Some(RoundStatus::Requested) {
            Want::Code(code(FadeError::WrongRoundStatus))
        } else {
            Want::Ok
        };
        let crank = self.a.crank.insecure_clone();
        let ix = self.env.sweep_round_vrf_ix(&crank.pubkey(), id);
        if self
            .attempt("sweep_round_vrf", want, |s| s.send(&[ix], &[&crank]))
            .is_none()
            || held == 0
        {
            return;
        }
        *self.lam(&vrf) = 0;
        if status.is_some() {
            *self.lam(&round_address(id)) += held;
            bump(&self.stats.swept_into_round);
        } else {
            *self.lam(&crank.pubkey()) += held;
            bump(&self.stats.swept_to_caller);
        }
    }

    /// The requests `round_vrf` paid for that are still pending while their
    /// round has forfeited or closed.
    fn late_requests(&self) -> Vec<Address> {
        self.m
            .requests
            .iter()
            .filter(|(_, q)| {
                q.fulfilled.is_none()
                    && matches!(q.client, Client::RoundVrf(id)
                        if self.m.rounds.get(&id).is_none_or(|r| r.status == RoundStatus::Forfeited))
            })
            .map(|(a, _)| *a)
            .collect()
    }

    fn late_fulfill(&mut self, pick: u16, value: u64) {
        let late = self.late_requests();
        if late.is_empty() {
            return;
        }
        let request = late[usize::from(pick) % late.len()];
        self.fulfill_request(&request, value, false);
        bump(&self.stats.late_fulfilled);
    }

    fn return_ticket(&mut self, sel: u16) {
        let Some(t) = self.pick_ticket(sel) else {
            return;
        };
        self.return_addr(t);
    }

    fn return_addr(&mut self, t: Address) {
        let mt = self.m.tickets[&t].clone();
        let Some(r) = self.m.rounds.get(&mt.round).cloned() else {
            // A parked return outlives its round, which closed with its last
            // ticket: nothing is left to return.
            assert_ne!(mt.status, TStatus::Joined);
            let crank = self.a.crank.insecure_clone();
            let ix = self.env.return_round_ticket_ix(
                &crank.pubkey(),
                &t,
                Some(self.a.payers[mt.payer].pubkey()),
            );
            self.attempt("return_round_ticket", Want::Refused, |s| {
                s.send(&[ix], &[&crank])
            });
            return;
        };
        let refunded = r.status == RoundStatus::Refunded;
        let want = if mt.status != TStatus::Joined {
            Want::Code(code(FadeError::WrongTicketStatus))
        } else if !matches!(r.status, RoundStatus::Refunded | RoundStatus::Forfeited) {
            Want::Code(code(FadeError::WrongRoundStatus))
        } else {
            Want::Ok
        };
        let crank = self.a.crank.insecure_clone();
        let ix = self
            .env
            .return_round_ticket_ix(&crank.pubkey(), &t, Some(r.rent_payer));
        if self
            .attempt("return_round_ticket", want, |s| s.send(&[ix], &[&crank]))
            .is_none()
        {
            return;
        }
        let charge = if refunded {
            0
        } else {
            beacon::charge(r.draw_cost, r.book.sponsorship, r.book.prices, mt.price).unwrap()
        };
        assert!(
            charge <= mt.prepay,
            "invariant 7: a charge above the prepay"
        );
        let back = mt.prepay - charge;
        let refund_to = self.a.funder_usdc[mt.funder];
        let parked = refunded && self.frozen(&refund_to);
        let payer = self.a.payers[mt.payer].pubkey();
        let round_key = round_address(mt.round);
        let mi = &mut self.m.integ[mt.integrator];
        mi.reserved -= mt.liability;
        mi.open -= 1;
        if refunded {
            self.m.returns_owed -= mt.price;
            let vu = self.env.a.vault_usdc;
            *self.tok(&vu) -= mt.price;
            if parked {
                let esc = self.env.a.payout_escrow;
                *self.tok(&esc) += mt.price;
            } else {
                *self.tok(&refund_to) += mt.price;
            }
        } else {
            self.m.integ[mt.integrator].app_accrued += mt.app_share;
            self.m.integ[mt.integrator].volume += mt.price;
            self.m.volume_total += mt.price;
            self.m.held -= mt.app_share;
            self.m.app_owed += mt.app_share;
            self.m.shares_released += mt.app_share;
        }
        *self.lam(&round_key) -= back;
        if parked {
            *self.lam(&t) += back;
            let tm = self.m.tickets.get_mut(&t).unwrap();
            tm.status = TStatus::ReturnParked;
            tm.payout = mt.price;
            bump(&self.stats.parked);
        } else {
            let mut rest = self.m.lamports.remove(&t).unwrap();
            if !refunded {
                *self.lam(&self.a.crank.pubkey()) += mt.settle_share;
                rest -= mt.settle_share;
            }
            // Invariant 5: a refund returns every lamport the join took for
            // the ticket, to the lamport (the dust anyone sent it included).
            if refunded {
                assert!(rest >= self.rent(ROUND_TICKET_LEN) + mt.settle_share);
            }
            *self.lam(&payer) += back + rest;
            self.m.tickets.remove(&t);
        }
        let rr = self.m.rounds.get_mut(&mt.round).unwrap();
        rr.book.tickets -= 1;
        rr.book.prepaid -= mt.prepay;
        rr.book.liability -= mt.liability;
        rr.book.credits -= mt.credit;
        rr.book.protocol_shares -= mt.protocol_share;
        rr.book.app_shares -= mt.app_share;
        rr.charges += charge;
        self.close_if_ended(mt.round);
    }

    fn reclaim(&mut self, round: u8, who: u8) {
        let Some(id) = self.pick_round(round) else {
            return;
        };
        let sponsors: Vec<Address> = self.m.rounds[&id].sponsors.keys().copied().collect();
        if sponsors.is_empty() {
            return;
        }
        self.reclaim_one(id, sponsors[usize::from(who) % sponsors.len()]);
    }

    fn reclaim_one(&mut self, id: u64, sponsor: Address) {
        let r = self.m.rounds[&id].clone();
        let amount = r.sponsors[&sponsor];
        let drawn = match r.status {
            RoundStatus::Drawn | RoundStatus::Forfeited => Some(true),
            RoundStatus::Refunded => Some(false),
            _ => None,
        };
        let want = match drawn {
            Some(_) => Want::Ok,
            None => Want::Code(code(FadeError::WrongRoundStatus)),
        };
        let crank = self.a.crank.insecure_clone();
        let round_key = round_address(id);
        let record = sponsorship_address(&round_key, &sponsor);
        let ix = self.env.reclaim_ix(
            &crank.pubkey(),
            &round_key,
            &record,
            &sponsor,
            Some(r.rent_payer),
        );
        if self
            .attempt("reclaim_sponsorship", want, |s| s.send(&[ix], &[&crank]))
            .is_none()
        {
            return;
        }
        let back = beacon::sponsor_return(r.draw_cost, r.book.sponsorship, amount, drawn.unwrap())
            .unwrap();
        *self.lam(&round_key) -= back;
        let rec = self.m.lamports.remove(&record).unwrap();
        *self.lam(&sponsor) += back + rec;
        self.m
            .rounds
            .get_mut(&id)
            .unwrap()
            .sponsors
            .remove(&sponsor);
        self.close_if_ended(id);
    }

    fn claim_round_payout(&mut self, sel: u16) {
        let Some(t) = self.pick_ticket(sel) else {
            return;
        };
        self.claim_round_payout_addr(t);
    }

    fn claim_round_payout_addr(&mut self, t: Address) {
        let mt = self.m.tickets[&t].clone();
        let destination = match mt.status {
            TStatus::ReturnParked => self.a.funder_usdc[mt.funder],
            _ => self.a.beneficiaries[mt.funder],
        };
        let want = match mt.status {
            TStatus::Joined => Want::Code(code(FadeError::WrongTicketStatus)),
            _ if self.frozen(&destination) => Want::Code(TOKEN_FROZEN),
            _ => Want::Ok,
        };
        let crank = self.a.crank.insecure_clone();
        let ix = self
            .env
            .claim_round_payout_ix(&crank.pubkey(), &t, &destination);
        if self
            .attempt("claim_round_payout", want, |s| s.send(&[ix], &[&crank]))
            .is_none()
        {
            return;
        }
        let esc = self.env.a.payout_escrow;
        *self.tok(&esc) -= mt.payout;
        *self.tok(&destination) += mt.payout;
        let all = self.m.lamports.remove(&t).unwrap();
        *self.lam(&self.a.payers[mt.payer].pubkey()) += all;
        self.m.tickets.remove(&t);
    }

    fn claim_shares(&mut self, who: u8) {
        let k = usize::from(who) % (N_INTEGRATORS + 1);
        if k > 0 && !self.m.integ[k - 1].created {
            return;
        }
        let (integrator, destination, amount) = if k == 0 {
            (None, self.env.treasury, self.m.protocol_accrued)
        } else {
            let i = k - 1;
            (
                Some(self.env.integrator_address(&self.a.integrators[i].pubkey())),
                self.a.shares[i],
                self.m.integ[i].app_accrued,
            )
        };
        let want = if amount == 0 {
            Want::Code(code(FadeError::NothingToClaim))
        } else if self.frozen(&destination) {
            Want::Code(code(FadeError::DestinationUnusable))
        } else {
            Want::Ok
        };
        let crank = self.a.crank.insecure_clone();
        let ix = self
            .env
            .claim_shares_ix(&crank.pubkey(), integrator, &destination);
        if self
            .attempt("claim_shares", want, |s| s.send(&[ix], &[&crank]))
            .is_none()
        {
            return;
        }
        let vu = self.env.a.vault_usdc;
        *self.tok(&vu) -= amount;
        *self.tok(&destination) += amount;
        self.m.shares_claimed += amount;
        if k == 0 {
            self.m.protocol_accrued = 0;
        } else {
            self.m.integ[k - 1].app_accrued = 0;
            self.m.app_owed -= amount;
        }
    }

    // --- the world around the program ---------------------------------------------------

    fn freezable(&self) -> Vec<Address> {
        let mut v: Vec<Address> = self.a.funder_usdc.clone();
        v.extend(&self.a.beneficiaries);
        v.extend(&self.a.shares);
        v.push(self.env.treasury);
        v
    }

    fn freeze(&mut self, account: u8, frozen: bool) {
        let all = self.freezable();
        let a = all[usize::from(account) % all.len()];
        self.env.set_token_state(&a, if frozen { 2 } else { 1 });
        if frozen {
            self.m.frozen.insert(a);
        } else {
            self.m.frozen.remove(&a);
        }
    }

    fn dust(&mut self, target: u8, pick: u16, lamports: u8) {
        let amount = 1_000_000 + u64::from(lamports) * 1_000;
        let to = match target % 3 {
            0 => self
                .pick_round(u8::try_from(pick % 256).unwrap())
                .map(round_address),
            1 => self
                .pick_round(u8::try_from(pick % 256).unwrap())
                .map(round_vrf_address),
            _ => self.pick_ticket(pick),
        };
        let Some(to) = to else {
            return;
        };
        let outsider = self.a.outsider.insecure_clone();
        let ix = transfer_ix(&outsider.pubkey(), &to, amount);
        self.attempt("a transfer", Want::Ok, |s| s.send(&[ix], &[&outsider]));
        *self.lam(&to) += amount;
    }

    fn set_fee(&mut self, fee: u64) {
        let network = self.env.a.network_state;
        let mut acc = self.env.svm.get_account(&network).unwrap();
        acc.data[orao_layout::REQUEST_FEE_OFFSET..orao_layout::REQUEST_FEE_OFFSET + 8]
            .copy_from_slice(&fee.to_le_bytes());
        self.env.svm.set_account(network, acc).unwrap();
        self.m.fee = fee;
    }

    fn pause(&mut self, flags: u8) {
        let (signer, value) = match flags % 4 {
            0 => (
                self.env.guardian.insecure_clone(),
                self.m.pause | PAUSE_TICKETS,
            ),
            1 => (
                self.env.guardian.insecure_clone(),
                self.m.pause | PAUSE_ROUNDS,
            ),
            _ => (self.env.council.insecure_clone(), 0),
        };
        self.env
            .set_pause_flags(&signer, value, None)
            .expect("pause flags");
        self.m.pause = value;
    }

    fn pause_integrator(&mut self, i: u8, paused: bool) {
        let i = usize::from(i) % N_INTEGRATORS;
        if !self.m.integ[i].created {
            return;
        }
        let council = self.env.council.insecure_clone();
        let address = self.env.integrator_address(&self.a.integrators[i].pubkey());
        self.env
            .set_pause_flags(&council, self.m.pause, Some((address, paused)))
            .expect("integrator pause");
        self.m.integ[i].paused = paused;
    }

    // --- the direct path -----------------------------------------------------------------------

    fn open_direct(&mut self, i: usize, f: usize, t: usize, price: u64) {
        let now = self.now();
        let slot = self.slot();
        let params = self.env.config().params;
        let v = self.env.vault();
        let predicted = (|| -> Result<_, u32> {
            if self.m.pause & PAUSE_TICKETS != 0 {
                return Err(code(FadeError::Paused));
            }
            if self.m.integ[i].paused {
                return Err(code(FadeError::IntegratorPaused));
            }
            if self.frozen(&self.a.shares[i]) {
                return Err(code(FadeError::WrongMint));
            }
            let vault_margin = self.margin(t, 0)?;
            let (halved, ring) = self.drawdown(params.drawdown_bps, now)?;
            if halved {
                bump(&self.stats.open_admissions.halved);
            }
            let math = params.to_math();
            let w = risk::ticket_for(price, self.a.summaries[t].max_m, 0, &math).map_err(rej)?;
            let adm = risk::admit(
                &risk::Vault {
                    assets: v.total_assets,
                    reserved: v.total_reserved_liability,
                    open_credits: v.open_vault_credits,
                },
                &self.integrator_math(i),
                &math,
                &w,
                vault_margin,
                halved,
            )
            .map_err(rej)?;
            let ps = payout_table::share_of(price, params.protocol_share_bps).unwrap();
            if self.frozen(&self.a.funder_usdc[f]) || (ps > 0 && self.frozen(&self.env.treasury)) {
                return Err(TOKEN_FROZEN);
            }
            let mut c = counters_of(&v);
            let (side, generation) = c.open(now).map_err(rej)?;
            Ok((w, adm, ps, side, generation, ring))
        })();
        if let Err(c) = &predicted {
            self.stats.open_admissions.refused(*c);
        }
        let want = match &predicted {
            Ok(_) => Want::Ok,
            Err(c) => Want::Code(*c),
        };
        let nonce = self.m.integ[i].next_nonce;
        let args = OpenArgs {
            authority: self.a.integrators[i].pubkey(),
            payer: self.a.outsider.pubkey(),
            funder: self.a.funders[f].pubkey(),
            funder_usdc: self.a.funder_usdc[f],
            share_account: self.a.shares[i],
            beneficiary: self.a.beneficiaries[f],
            price,
            payout_table: self.a.tables[t].clone(),
            app_share_bps: 0,
            nonce,
        };
        let ix = self.env.open_ticket_ix(&args);
        let (ik, ok, fk) = (
            self.a.integrators[i].insecure_clone(),
            self.a.outsider.insecure_clone(),
            self.a.funders[f].insecure_clone(),
        );
        if self
            .attempt("open_ticket", want, |s| s.send(&[ix], &[&ik, &ok, &fk]))
            .is_none()
        {
            return;
        }
        bump(&self.stats.directs);
        let (w, adm, ps, side, generation, ring) = predicted.unwrap();
        self.m.ring = ring;
        if !self.m.integ[i].created {
            self.m.integrators += 1;
        }
        self.m.volume_total += price;
        let ticket = self
            .env
            .ticket_address(&self.a.integrators[i].pubkey(), nonce);
        *self.tok(&self.a.funder_usdc[f].clone()) -= price;
        let tr = self.env.treasury;
        *self.tok(&tr) += ps;
        let vu = self.env.a.vault_usdc;
        *self.tok(&vu) += w.vault_credit;
        self.m.total_assets += w.vault_credit;
        let mi = &mut self.m.integ[i];
        mi.created = true;
        mi.reserved += adm.liability;
        mi.open += 1;
        mi.next_nonce += 1;
        mi.volume += price;
        self.m.directs.insert(
            ticket,
            MDirect {
                integrator: i,
                funder: f,
                price,
                credit: w.vault_credit,
                liability: adm.liability,
                status: DStatus::Open,
                side,
                generation,
                open_slot: slot,
                expiry_slot: slot + params.t_settle_slots,
                request: None,
                payout: 0,
                drawdown_bps: params.drawdown_bps,
            },
        );
    }

    fn direct_request(&mut self, sel: u16) {
        let Some(t) = self.pick_direct(sel) else {
            return;
        };
        let d = self.m.directs[&t].clone();
        let slot = self.slot();
        let in_window = slot >= d.open_slot + 2 && slot <= d.expiry_slot;
        let want = if d.status != DStatus::Open {
            Want::Code(code(FadeError::WrongTicketStatus))
        } else if !in_window {
            Want::Code(code(FadeError::RequestWindow))
        } else {
            Want::Any
        };
        let request = if d.status == DStatus::Open && in_window {
            self.env.request_address(&t)
        } else {
            Address::new_unique()
        };
        let outsider = self.a.outsider.insecure_clone();
        let ix = self
            .env
            .request_randomness_ix(&outsider.pubkey(), &t, &request);
        if self
            .attempt("request_randomness", want, |s| s.send(&[ix], &[&outsider]))
            .is_none()
        {
            return;
        }
        let dm = self.m.directs.get_mut(&t).unwrap();
        dm.status = DStatus::Requested;
        dm.request = Some(request);
        self.m.requests.insert(
            request,
            MRequest {
                client: Client::Direct,
                fulfilled: None,
            },
        );
    }

    fn direct_fulfill(&mut self, sel: u16, value: u64, zero: bool) {
        let Some(t) = self.pick_direct(sel) else {
            return;
        };
        if let Some(request) = self.m.directs[&t].request {
            self.fulfill_request(&request, value, zero);
        }
    }

    fn direct_payout(&self, ticket: &Address, r: &[u8; 64]) -> u64 {
        let w = self.env.ticket(ticket);
        let outcomes = w.outcomes();
        let summary = payout_table::validate(&outcomes).unwrap();
        let draw = select::draw(
            |k| fade::instructions::settle::outcome_hash(&fade::ID, &pk(*ticket), &w.seed, r, k),
            fade::OUTCOME_ROUNDS,
        )
        .unwrap();
        let i = select::outcome(draw, &summary.cum, summary.len).unwrap();
        payout_table::payout(w.price, outcomes[i].m).unwrap()
    }

    fn direct_settle(&mut self, sel: u16) {
        let Some(t) = self.pick_direct(sel) else {
            return;
        };
        let d = self.m.directs[&t].clone();
        let fulfilled = d.request.and_then(|q| self.m.requests[&q].fulfilled);
        let want = match (d.status, fulfilled) {
            (DStatus::Requested, Some(x)) if x != [0; 64] => Want::Ok,
            (DStatus::Requested, _) => Want::Code(code(FadeError::NotFulfilled)),
            _ => Want::Code(code(FadeError::WrongTicketStatus)),
        };
        let payout = match want {
            Want::Ok => self.direct_payout(&t, &fulfilled.unwrap()),
            _ => 0,
        };
        let outsider = self.a.outsider.insecure_clone();
        let ix = self.env.settle_ix(&outsider.pubkey(), &t);
        if self
            .attempt("settle_ticket", want, |s| s.send(&[ix], &[&outsider]))
            .is_none()
        {
            return;
        }
        let price_before = self.price().unwrap();
        let beneficiary = self.a.beneficiaries[d.funder];
        let pending = payout > 0 && self.frozen(&beneficiary);
        let vu = self.env.a.vault_usdc;
        *self.tok(&vu) -= payout;
        if pending {
            let esc = self.env.a.payout_escrow;
            *self.tok(&esc) += payout;
        } else {
            *self.tok(&beneficiary) += payout;
        }
        self.book_after_close(d.side, d.generation, d.credit, payout);
        self.m.total_assets -= payout;
        let mi = &mut self.m.integ[d.integrator];
        mi.reserved -= d.liability;
        mi.open -= 1;
        if pending {
            let dm = self.m.directs.get_mut(&t).unwrap();
            dm.status = DStatus::PayoutPending;
            dm.payout = payout;
        } else {
            self.m.directs.remove(&t);
        }
        self.observe(price_before, d.drawdown_bps);
    }

    /// The direct path's end after `T_SETTLE`, as the keeper sends it. A
    /// requested ticket expires naming its bound request. An Open one, its
    /// request address still derivable (recorded, or proven by SlotHashes),
    /// expires naming that address, its seed recorded in the same
    /// transaction; nobody creates a direct request through ORAO here, so
    /// nothing is found there. One whose seed can no longer be derived is
    /// refunded its credit (`refund_expired_ticket`). Every expiry a withheld
    /// draw may explain counts in `Vault.ticket_forfeits_withheld`.
    fn direct_expire(&mut self, sel: u16) {
        let Some(t) = self.pick_direct(sel) else {
            return;
        };
        let d = self.m.directs[&t].clone();
        let fulfilled = d.request.and_then(|q| self.m.requests[&q].fulfilled);
        let derived = if d.status == DStatus::Open {
            self.env.ticket_request_address(&t)
        } else {
            None
        };
        let lost = d.status == DStatus::Open && derived.is_none();
        let want = match d.status {
            DStatus::PayoutPending => Want::Code(code(FadeError::WrongTicketStatus)),
            _ if self.slot() <= d.expiry_slot => Want::Code(code(FadeError::NotExpired)),
            DStatus::Requested if matches!(fulfilled, Some(x) if x != [0; 64]) => {
                Want::Code(code(FadeError::AlreadyFulfilled))
            }
            _ => Want::Ok,
        };
        let outsider = self.a.outsider.insecure_clone();
        let ixs = if lost {
            vec![self.env.refund_expired_ix(&outsider.pubkey(), &t)]
        } else {
            let randomness = d.request.or(derived).unwrap_or_else(system_id);
            let mut ixs = Vec::new();
            if d.status == DStatus::Open
                && self.slot() > d.expiry_slot
                && !self.env.ticket(&t).entropy_recorded()
            {
                ixs.push(self.env.record_ticket_entropy_ix(&t));
            }
            ixs.push(self.env.expire_ix(&outsider.pubkey(), &t, &randomness));
            ixs
        };
        let what = if lost {
            "refund_expired_ticket"
        } else {
            "expire_ticket"
        };
        if self
            .attempt(what, want, |s| s.send(&ixs, &[&outsider]))
            .is_none()
        {
            return;
        }
        let mi = &mut self.m.integ[d.integrator];
        mi.reserved -= d.liability;
        mi.open -= 1;
        // Requested: a withheld draw may explain it. Open with nothing at the
        // derived address: the keepers' failure. Refunded: never checked.
        if d.status == DStatus::Requested || lost {
            self.m.ticket_forfeits_withheld += 1;
        }
        if lost {
            // The credit back, parked when the beneficiary cannot receive it;
            // no result, so neither the after-close books nor the ring move.
            let beneficiary = self.a.beneficiaries[d.funder];
            let parked = d.credit > 0 && self.frozen(&beneficiary);
            let vu = self.env.a.vault_usdc;
            *self.tok(&vu) -= d.credit;
            if parked {
                let esc = self.env.a.payout_escrow;
                *self.tok(&esc) += d.credit;
            } else {
                *self.tok(&beneficiary) += d.credit;
            }
            self.m.total_assets -= d.credit;
            bump(&self.stats.direct_refunded);
            if parked {
                let dm = self.m.directs.get_mut(&t).unwrap();
                dm.status = DStatus::PayoutPending;
                dm.payout = d.credit;
            } else {
                self.m.directs.remove(&t);
            }
            return;
        }
        let price_before = self.price().unwrap();
        self.book_after_close(d.side, d.generation, d.credit, 0);
        self.m.directs.remove(&t);
        self.observe(price_before, d.drawdown_bps);
    }

    fn direct_claim(&mut self, sel: u16) {
        let Some(t) = self.pick_direct(sel) else {
            return;
        };
        let d = self.m.directs[&t].clone();
        let beneficiary = self.a.beneficiaries[d.funder];
        let want = match d.status {
            DStatus::PayoutPending if self.frozen(&beneficiary) => Want::Code(TOKEN_FROZEN),
            DStatus::PayoutPending => Want::Ok,
            _ => Want::Code(code(FadeError::WrongTicketStatus)),
        };
        if self
            .attempt("claim_payout", want, |s| s.env.claim_payout(&t))
            .is_none()
        {
            return;
        }
        let esc = self.env.a.payout_escrow;
        *self.tok(&esc) -= d.payout;
        *self.tok(&beneficiary) += d.payout;
        self.m.directs.remove(&t);
    }

    // --- the liquidity providers --------------------------------------------------------------

    fn deposit(&mut self, lp: u8, amount: u8) {
        let lp = usize::from(lp) % self.a.lps.len();
        let amount = [USDC, 5 * USDC, 50 * USDC][usize::from(amount) % 3];
        let epoch = self.env.joining_epoch();
        let opens = self.env.opens_epoch();
        let user = &self.a.lps[lp];
        if self
            .attempt("request_deposit", Want::Any, |s| {
                let ix = s.env.request_deposit_ix(user, amount);
                let kp = user.kp.insecure_clone();
                s.env.send(&[ix], &[&kp])
            })
            .is_some()
        {
            self.m.lp_requests.push((true, epoch, lp));
            if opens {
                self.roll_generation();
            }
        }
    }

    fn withdraw(&mut self, lp: u8, part: u8) {
        let lp = usize::from(lp) % self.a.lps.len();
        let user = &self.a.lps[lp];
        if !self.env.exists(&user.shares()) {
            return;
        }
        let shares = self.env.balance(&user.shares()) * (u64::from(part % 4) + 1) / 4;
        if shares == 0 {
            return;
        }
        let epoch = self.env.joining_epoch();
        let opens = self.env.opens_epoch();
        if self
            .attempt("request_withdraw", Want::Any, |s| {
                let ix = s.env.request_withdraw_ix(user, shares);
                let kp = user.kp.insecure_clone();
                s.env.send(&[ix], &[&kp])
            })
            .is_some()
        {
            self.m.lp_requests.push((false, epoch, lp));
            if opens {
                self.roll_generation();
            }
        }
    }

    /// The tickets in the `before` counter, from the model's own records.
    fn derived_counters(&self, generation: u32) -> (u32, u32) {
        let mut before = 0u32;
        let mut after = 0u32;
        let mut add = |side, g, n: u32| match counter_of(side, g, generation) {
            Some(true) => before += n,
            Some(false) => after += n,
            None => panic!(
                "invariant 8: an open ticket in no counter ({side:?}, {g}, now {generation})"
            ),
        };
        for d in self.m.directs.values() {
            if d.status != DStatus::PayoutPending {
                add(d.side, d.generation, 1);
            }
        }
        for r in self.m.rounds.values() {
            if r.counted
                && matches!(
                    r.status,
                    RoundStatus::Paid | RoundStatus::Requested | RoundStatus::Drawn
                )
            {
                let live = r
                    .members
                    .iter()
                    .filter(|t| {
                        self.m
                            .tickets
                            .get(*t)
                            .is_some_and(|m| m.status == TStatus::Joined)
                    })
                    .count();
                // A drawn round whose tickets have all left, kept for its
                // sponsors, is in no counter.
                if live > 0 {
                    add(r.side, r.generation, u32::try_from(live).unwrap());
                }
            }
        }
        (before, after)
    }

    fn strike(&mut self) {
        let q = self.env.queue();
        let (before, after) = self.derived_counters(self.m.generation);
        let want = if !q.current.live {
            Want::Code(code(FadeError::NoLiveEpoch))
        } else if self.now() < q.current.close_ts {
            Want::Code(code(FadeError::EpochNotClosed))
        } else if before > 0 {
            // Invariant 8: no strike with a ticket of the epoch's price open.
            bump(&self.stats.unclean);
            Want::Code(code(FadeError::StrikeNotClean))
        } else {
            Want::Ok
        };
        // The strike's price, from the model's own books (Spec 08 §4 rule 5):
        // the settled assets less the after-close results, so that the
        // tickets opened after the close move it neither open (their
        // credits) nor closed (their results).
        let settled = self.m.total_assets - self.open_credits();
        let strike_assets = (settled + self.m.after_close_loss)
            .checked_sub(self.m.after_close_gain)
            .expect("after-close gains are in the settled assets");
        let ring_before = self.price();
        let Some(meta) = self.attempt("strike_epoch", want, |s| {
            let keeper = s.env.keeper.pubkey();
            let ix = s.env.strike_ix(&keeper);
            let k = s.env.keeper.insecure_clone();
            s.env.send(&[ix], &[&k])
        }) else {
            return;
        };
        bump(&self.stats.strikes);
        if after > 0 {
            bump(&self.stats.strikes_after_open);
        }
        if self.m.after_close_gain + self.m.after_close_loss > 0 {
            bump(&self.stats.strikes_with_results);
        }
        // The liquidity providers' flows (Spec 01) at that price: what the
        // queue held, cleared by `shares::strike`, withdrawals rationed
        // against what may leave once the deposits have joined.
        let params = self.env.config().params;
        let with_deposits = risk::Vault {
            assets: self.m.total_assets + q.current.deposits,
            reserved: self.open_reserved(),
            open_credits: self.open_credits(),
        };
        let withdrawable = risk::withdrawable(&with_deposits, &params.to_math());
        let k = shares::strike(
            q.current.deposits,
            q.current.withdraw_shares,
            self.m.total_shares,
            strike_assets,
            withdrawable,
        )
        .unwrap();
        let ev = events::<EpochStruck>(&meta).remove(0);
        assert_eq!(
            (ev.total_assets, ev.total_shares),
            (strike_assets, self.m.total_shares),
            "the strike's price: settled assets less after-close results"
        );
        assert_eq!(
            (
                ev.shares_minted,
                ev.assets_owed,
                ev.assets_paid,
                ev.shares_burnt
            ),
            (
                k.shares_minted,
                k.assets_owed,
                k.assets_paid,
                k.shares_burnt
            ),
            "the strike's flows"
        );
        self.m.total_assets = self.m.total_assets + q.current.deposits - k.assets_paid;
        self.m.total_shares = self.m.total_shares + k.shares_minted - k.shares_burnt;
        let vu = self.env.a.vault_usdc;
        *self.tok(&vu) = *self.tok(&vu) + q.current.deposits - k.assets_paid;
        // The ring follows the settled price through flows that cleared at
        // another one (Spec 08 §8); no result, so no trip.
        let ring_before = ring_before.unwrap();
        let ring_after = self.price().unwrap();
        let now = self.now();
        self.m.ring.observe(now, ring_before, ring_before);
        self.m.ring.rescale(ring_after, ring_before);
        self.m.ring.observe(now, ring_after, ring_after);
        // The results left out of this price are the next epoch's; the
        // generation rolls when an epoch is promoted (rule 6), which it is
        // when one was queued or when unpaid withdrawals roll into one.
        self.m.after_close_gain = 0;
        self.m.after_close_loss = 0;
        if q.next.live || k.shares_burnt < q.current.withdraw_shares {
            self.roll_generation();
        }
    }

    fn claim_lp(&mut self, pick: u8) {
        if self.m.lp_requests.is_empty() {
            return;
        }
        let k = usize::from(pick) % self.m.lp_requests.len();
        let (deposit, epoch, lp) = self.m.lp_requests[k];
        if !self.env.exists(&self.env.record_address(epoch)) {
            return;
        }
        let owner = self.a.lps[lp].key();
        let done = self
            .attempt("claim", Want::Any, |s| {
                if deposit {
                    s.env.claim_deposit(&owner, epoch)
                } else {
                    let keeper = s.env.keeper.pubkey();
                    // The chain read at the latest struck epoch's record.
                    let mut at = s.env.queue().current.epoch_id.max(epoch);
                    while at > epoch && !s.env.exists(&s.env.record_address(at)) {
                        at -= 1;
                    }
                    let ix = s.env.claim_withdraw_ix(&keeper, &owner, epoch, at);
                    let kp = s.env.keeper.insecure_clone();
                    s.env.send(&[ix], &[&kp])
                }
            })
            .is_some();
        if done {
            self.m.lp_requests.remove(k);
        }
    }

    // --- a step ------------------------------------------------------------------------------------

    fn step(&mut self, op: &Op) {
        bump(&self.stats.steps);
        let a = self.a;
        match *op {
            Op::Join {
                integrator,
                funder,
                payer,
                table,
                price,
                app,
                sponsorship,
            } => self.join(
                usize::from(integrator) % N_INTEGRATORS,
                usize::from(funder) % N_FUNDERS,
                usize::from(payer) % N_PAYERS,
                usize::from(table) % a.tables.len(),
                PRICES[usize::from(price) % PRICES.len()],
                APP_SHARES[usize::from(app) % APP_SHARES.len()],
                sponsorship,
            ),
            Op::Sponsor { who, round, amount } => self.sponsor(who, round, amount),
            Op::Advance { slots } => {
                let s = self.slot() + u64::from(slots);
                self.set_slot(s, 0);
            }
            Op::Leap { kind, round } => self.leap(kind, round),
            Op::Request { round } => self.request(round),
            Op::Record { round } => self.record(round),
            Op::PreCreate { round } => self.pre_create(round),
            Op::Fulfill { round, value, zero } => self.fulfill(round, value, zero),
            Op::Settle {
                round,
                order,
                size,
                malformed,
            } => self.settle(round, order, size, malformed),
            Op::Refund { round } => self.refund(round),
            Op::Expire { round } => self.expire(round),
            Op::Sweep { round } => self.sweep(round),
            Op::LateFulfill { pick, value } => self.late_fulfill(pick, value),
            Op::Return { ticket } => self.return_ticket(ticket),
            Op::Reclaim { round, who } => self.reclaim(round, who),
            Op::ClaimRoundPayout { ticket } => self.claim_round_payout(ticket),
            Op::ClaimShares { who } => self.claim_shares(who),
            Op::Freeze { account, frozen } => self.freeze(account, frozen),
            Op::Dust {
                target,
                pick,
                lamports,
            } => self.dust(target, pick, lamports),
            Op::Fee { level } => self.set_fee(FEES[usize::from(level) % FEES.len()]),
            Op::Pause { flags } => self.pause(flags),
            Op::PauseIntegrator { integrator, paused } => self.pause_integrator(integrator, paused),
            Op::OpenDirect {
                integrator,
                funder,
                table,
                price,
            } => self.open_direct(
                usize::from(integrator) % N_INTEGRATORS,
                usize::from(funder) % N_FUNDERS,
                usize::from(table) % a.tables.len(),
                self.env.config().params.min_price
                    * DIRECT_PRICE_THIRDS[usize::from(price) % DIRECT_PRICE_THIRDS.len()]
                    / 3,
            ),
            Op::DirectRequest { ticket } => self.direct_request(ticket),
            Op::DirectFulfill {
                ticket,
                value,
                zero,
            } => self.direct_fulfill(ticket, value, zero),
            Op::DirectSettle { ticket } => self.direct_settle(ticket),
            Op::DirectExpire { ticket } => self.direct_expire(ticket),
            Op::DirectClaim { ticket } => self.direct_claim(ticket),
            Op::Deposit { lp, amount } => self.deposit(lp, amount),
            Op::Withdraw { lp, part } => self.withdraw(lp, part),
            Op::Strike => self.strike(),
            Op::CloseAndStrike => {
                let q = self.env.queue();
                if q.current.live && q.current.close_ts > self.now() {
                    self.leap_to_epoch_close();
                    self.check();
                }
                self.strike();
            }
            Op::ClaimLp { pick } => self.claim_lp(pick),
        }
        self.check();
    }

    /// A jump to a boundary: of a round picked by `round` (its close, the
    /// slots on both sides of its request window and of its expiry, the
    /// last slot before its refund window and the first in it), of the
    /// live epoch (its close by slots, or by the clock alone, at it or a
    /// second before it, so that the rounds still paid by slot meet the
    /// close), or a long wait.
    fn leap(&mut self, kind: u8, round: u8) {
        let slot = self.slot();
        let r = self.pick_round(round).map(|id| self.m.rounds[&id].clone());
        let closed = r.clone().filter(|r| r.close_slot > 0);
        match kind % 14 {
            0 => {
                if let Some(r) = closed {
                    self.set_slot(r.close_slot + 2, 0);
                }
            }
            1 => {
                if let Some(r) = closed {
                    self.set_slot(r.close_slot + r.t_settle_slots + 1, 0);
                }
            }
            2 => {
                if let Some(r) = r {
                    self.set_slot(r.refund_from() + r.refund_slots, 0);
                }
            }
            3 => self.leap_to_epoch_close(),
            4 => self.set_slot(slot + 600, 0),
            5 => {
                if let Some(r) = closed {
                    self.set_slot(r.close_slot - 1, 0);
                }
            }
            6 => {
                if let Some(r) = closed {
                    self.set_slot(r.close_slot, 0);
                }
            }
            7 => {
                if let Some(r) = closed {
                    self.set_slot(r.close_slot + 1, 0);
                }
            }
            8 => {
                if let Some(r) = closed {
                    self.set_slot(r.close_slot + r.t_settle_slots, 0);
                }
            }
            9 => {
                if let Some(r) = r {
                    self.set_slot(r.refund_from() + r.refund_slots - 1, 0);
                }
            }
            // The last slot at which SlotHashes proves `s* = close_slot + 1`,
            // and the first at which it no longer does.
            12 => {
                if let Some(r) = closed {
                    self.set_slot(r.close_slot + 513, 0);
                }
            }
            13 => {
                if let Some(r) = closed {
                    self.set_slot(r.close_slot + 514, 0);
                }
            }
            _ => {
                let q = self.env.queue();
                let now = self.now();
                let early = i64::from(round % 2);
                if q.current.live && q.current.close_ts - early > now {
                    self.set_slot(slot + 1, q.current.close_ts - early - now);
                }
            }
        }
    }

    /// To the live epoch's close, by slots, or 1 500 slots on when it has
    /// passed or none is live.
    fn leap_to_epoch_close(&mut self) {
        let slot = self.slot();
        let q = self.env.queue();
        let now = self.now();
        if q.current.live && q.current.close_ts > now {
            let secs = q.current.close_ts - now;
            let slots = u64::try_from(secs).unwrap() * 5 / 2;
            self.set_slot(slot + slots, secs - i64::try_from(slots * 2 / 5).unwrap());
        } else {
            self.set_slot(slot + 1_500, 0);
        }
    }

    // --- the comparison and the invariants ----------------------------------------------------

    fn check(&mut self) {
        let e = &self.env;
        let slot = e.slot();
        let v = e.vault();
        let c = e.config();
        assert_eq!(c.pause_flags, self.m.pause, "pause flags");

        // Every tracked lamport and token unit.
        for (a, l) in &self.m.lamports {
            assert_eq!(e.lamports(a), *l, "lamports of {a}");
        }
        for (a, b) in &self.m.tokens {
            assert_eq!(e.balance(a), *b, "token balance of {a}");
        }

        // The vault's beacon books and assets.
        assert_eq!(v.accepting_round, self.m.accepting_round, "accepting_round");
        assert_eq!(v.next_round_id, self.m.next_round_id, "next_round_id");
        assert_eq!(v.total_assets, self.m.total_assets, "total_assets");
        assert_eq!(v.beacon_shares_held, self.m.held, "beacon_shares_held");
        assert_eq!(
            v.protocol_shares_accrued, self.m.protocol_accrued,
            "protocol_shares_accrued"
        );
        assert_eq!(v.app_shares_owed, self.m.app_owed, "app_shares_owed");
        assert_eq!(
            v.beacon_returns_owed, self.m.returns_owed,
            "beacon_returns_owed"
        );
        assert_eq!(v.rounds_forfeited, self.m.forfeited, "rounds_forfeited");
        assert_eq!(
            v.forfeits_withheld, self.m.forfeits_withheld,
            "forfeits_withheld"
        );
        assert_eq!(
            v.ticket_forfeits_withheld, self.m.ticket_forfeits_withheld,
            "ticket_forfeits_withheld"
        );
        assert_eq!(v.volume_total, self.m.volume_total, "volume_total");
        assert_eq!(v.integrators, self.m.integrators, "integrators");
        assert_eq!(v.total_shares, self.m.total_shares, "total_shares");
        assert_eq!(
            (v.price_maxima, v.price_head_hour),
            (self.m.ring.maxima, self.m.ring.head_hour),
            "the drawdown ring"
        );
        assert_eq!(v.drawdown_trip_ts, self.m.trip_ts, "drawdown_trip_ts");
        assert_eq!(v.generation, self.m.generation, "the counters' generation");
        assert_eq!(
            (v.after_close_gain, v.after_close_loss),
            (self.m.after_close_gain, self.m.after_close_loss),
            "the after-close results"
        );

        // Invariant 1: the vault identity, and the escrow covers every parked amount.
        let vault_usdc = e.balance(&e.a.vault_usdc);
        assert!(
            u128::from(vault_usdc)
                >= u128::from(v.total_assets)
                    + u128::from(v.beacon_shares_held)
                    + u128::from(v.protocol_shares_accrued)
                    + u128::from(v.app_shares_owed)
                    + u128::from(v.beacon_returns_owed),
            "invariant 1: the vault identity"
        );
        let parked: u64 = self
            .m
            .tickets
            .values()
            .filter(|t| t.status != TStatus::Joined)
            .map(|t| t.payout)
            .sum::<u64>()
            + self
                .m
                .directs
                .values()
                .filter(|d| d.status == DStatus::PayoutPending)
                .map(|d| d.payout)
                .sum::<u64>();
        assert_eq!(
            e.balance(&e.a.payout_escrow),
            parked,
            "invariant 1: the escrow holds what is parked"
        );

        // Invariant 2: the vault's aggregates are their sums.
        let mut reserved = 0u64;
        let mut credits = 0u64;
        for d in self.m.directs.values() {
            if d.status != DStatus::PayoutPending {
                reserved += d.liability;
                credits += d.credit;
            }
        }
        let mut held = 0u64;
        let mut returns = 0u64;
        for r in self.m.rounds.values() {
            let live: Vec<&MTicket> = r
                .members
                .iter()
                .filter_map(|t| self.m.tickets.get(t))
                .filter(|t| t.status == TStatus::Joined)
                .collect();
            let sum = |f: fn(&MTicket) -> u64| live.iter().map(|t| f(t)).sum::<u64>();
            if r.open_books() {
                reserved += r.book.liability;
                credits += r.book.credits;
                held += r.book.protocol_shares + r.book.app_shares;
            }
            if r.status == RoundStatus::Forfeited {
                held += r.book.app_shares;
            }
            if r.status == RoundStatus::Refunded {
                returns += sum(|t| t.price);
            }
            // The round's own aggregates are those of its tickets still in it.
            assert_eq!(
                r.book.tickets as usize,
                live.len(),
                "round {}: tickets",
                r.id
            );
            assert_eq!(r.book.prepaid, sum(|t| t.prepay), "round {}: prepaid", r.id);
            assert_eq!(
                r.book.liability,
                sum(|t| t.liability),
                "round {}: liability",
                r.id
            );
            assert_eq!(r.book.credits, sum(|t| t.credit), "round {}: credits", r.id);
            assert_eq!(
                r.book.protocol_shares,
                sum(|t| t.protocol_share),
                "round {}: protocol shares",
                r.id
            );
            assert_eq!(
                r.book.app_shares,
                sum(|t| t.app_share),
                "round {}: app shares",
                r.id
            );
        }
        assert_eq!(
            v.total_reserved_liability, reserved,
            "invariant 2: reserved liability"
        );
        assert_eq!(
            v.open_vault_credits, credits,
            "invariant 2: open vault credits"
        );
        assert_eq!(
            v.beacon_shares_held, held,
            "invariant 2: beacon shares held"
        );
        assert_eq!(v.beacon_returns_owed, returns, "invariant 2: returns owed");
        let app: u64 = self.m.integ.iter().map(|i| i.app_accrued).sum();
        assert_eq!(v.app_shares_owed, app, "invariant 2: app shares owed");
        for (i, mi) in self.m.integ.iter().enumerate() {
            let address = e.integrator_address(&self.a.integrators[i].pubkey());
            if !mi.created {
                assert!(!e.exists(&address));
                continue;
            }
            let r: Integrator = e.read(&address);
            let mut sum = 0;
            let mut open = 0;
            for t in self
                .m
                .tickets
                .values()
                .filter(|t| t.integrator == i && t.status == TStatus::Joined)
            {
                sum += t.liability;
                open += 1;
            }
            for d in self
                .m
                .directs
                .values()
                .filter(|d| d.integrator == i && d.status != DStatus::PayoutPending)
            {
                sum += d.liability;
                open += 1;
            }
            assert_eq!(
                (mi.reserved, mi.open),
                (sum, open),
                "integrator {i}: the model's sums"
            );
            assert_eq!(
                r.reserved_liability, mi.reserved,
                "invariant 2: integrator {i} reservation"
            );
            assert_eq!(r.open_tickets, mi.open, "integrator {i}: open tickets");
            assert_eq!(r.next_nonce, mi.next_nonce, "integrator {i}: nonce");
            assert_eq!(
                r.app_shares_accrued, mi.app_accrued,
                "integrator {i}: app shares"
            );
            assert_eq!(r.paused, mi.paused, "integrator {i}: paused");
            assert_eq!(r.volume_total, mi.volume, "integrator {i}: volume");
            assert_eq!(addr(r.share_account), self.a.shares[i]);
            // Every nonce issued is a ticket of one path or the other, or closed.
            for n in 0..mi.next_nonce {
                let rt = round_ticket_addr(e, self.a, i, n);
                let dt = e.ticket_address(&self.a.integrators[i].pubkey(), n);
                assert_eq!(
                    e.exists(&rt),
                    self.m.tickets.contains_key(&rt),
                    "beacon ticket {i}/{n}"
                );
                assert_eq!(
                    e.exists(&dt),
                    self.m.directs.contains_key(&dt),
                    "direct ticket {i}/{n}"
                );
            }
            let n = mi.next_nonce;
            assert!(!e.exists(&round_ticket_addr(e, self.a, i, n)));
        }

        // Invariant 8: the counters hold exactly the open tickets.
        let (before, after) = self.derived_counters(self.m.generation);
        assert_eq!(
            (v.open_before_close, v.open_after_close),
            (before, after),
            "invariant 8: the epoch counters"
        );

        // Rounds, field by field, and their invariants.
        let mut accepting = 0;
        let mut unpaid = 0;
        for id in 1..self.m.next_round_id + 2 {
            let address = round_address(id);
            let Some(r) = self.m.rounds.get(&id) else {
                assert!(
                    !e.exists(&address),
                    "round {id} exists, the model closed it"
                );
                continue;
            };
            let s: Round = e.read(&address);
            assert_eq!(s.status, r.status, "round {id}: status");
            assert_eq!(s.id, id);
            assert_eq!(addr(s.rent_payer), r.rent_payer, "round {id}: rent payer");
            assert_eq!(
                (s.first_slot, s.paid_slot, s.close_slot, s.last_join_slot),
                (r.first_slot, r.paid_slot, r.close_slot, r.last_join_slot),
                "round {id}: slots"
            );
            assert_eq!(s.terms(), r.terms, "round {id}: terms");
            assert_eq!(
                (
                    s.min_price,
                    s.settle_share,
                    s.request_share,
                    s.tick_slots,
                    s.refund_slots,
                    s.t_settle_slots,
                    s.drawdown_bps
                ),
                (
                    r.min_price,
                    r.settle_share,
                    r.request_share,
                    r.tick_slots,
                    r.refund_slots,
                    r.t_settle_slots,
                    r.drawdown_bps
                ),
                "round {id}: snapshot"
            );
            assert_eq!(s.book(), r.book, "round {id}: aggregates");
            assert_eq!(
                s.sponsors as usize,
                r.sponsors.len(),
                "round {id}: sponsors"
            );
            assert_eq!(s.counted, r.counted, "round {id}: counted");
            if r.counted {
                assert_eq!(
                    (side_of(s.side), s.generation),
                    (r.side, r.generation),
                    "round {id}: side"
                );
            }
            assert_eq!(addr(s.randomness), r.randomness, "round {id}: request");
            assert_eq!(
                (s.seed, s.entropy_slot, s.funded),
                (r.seed, r.entropy_slot, r.funded),
                "round {id}: draw"
            );
            assert_eq!(s.draw_cost, r.draw_cost, "round {id}: draw cost");
            assert_eq!(
                s.drawn_randomness,
                r.drawn.unwrap_or([0; 64]),
                "round {id}: randomness kept"
            );
            // Invariant 7: a round never falls below its rent-exempt minimum.
            assert!(
                e.lamports(&address) >= self.rent(ROUND_LEN),
                "invariant 7: round {id} below rent"
            );
            // Invariant 12: no round without a ticket before its end.
            if matches!(
                r.status,
                RoundStatus::Accepting | RoundStatus::Paid | RoundStatus::Requested
            ) {
                assert!(s.tickets >= 1, "invariant 12: round {id} without a ticket");
                assert_eq!(
                    s.tickets as usize,
                    r.members.len(),
                    "invariant 12: a ticket left round {id}"
                );
            }
            // Invariant 3: capacity follows payment, and never decreases.
            if matches!(r.status, RoundStatus::Accepting | RoundStatus::Paid) {
                assert!(
                    s.book().fits(&s.terms()),
                    "invariant 3: round {id} over capacity"
                );
                let now = (s.prices, s.sponsorship, s.usage);
                if let Some(prev) = self.m.before_draw.get(&id) {
                    assert!(
                        now.0 >= prev.0 && now.1 >= prev.1 && now.2 >= prev.2,
                        "invariant 3: round {id} shrank"
                    );
                }
            }
            // Invariant 4.
            if r.status == RoundStatus::Accepting {
                unpaid += 1;
                assert_eq!(
                    v.accepting_round, id,
                    "invariant 4: the unpaid round is the accepting one"
                );
            }
            if s.accepts_joins(slot) && v.accepting_round != id {
                // A paid round a join had no room for, left before its close
                // for the round that join created: no join can name it.
                assert!(
                    s.status == RoundStatus::Paid
                        && (v.accepting_round == 0 || v.accepting_round > id),
                    "invariant 4: round {id} takes joins but is not the accepting one"
                );
            } else if s.accepts_joins(slot) {
                accepting += 1;
            }
            // Sponsorship records.
            for sp in self.a.sponsors() {
                let rec = sponsorship_address(&address, &sp);
                match r.sponsors.get(&sp) {
                    Some(amount) => {
                        let x: Sponsorship = e.read(&rec);
                        assert_eq!((x.amount, x.round, addr(x.sponsor)), (*amount, id, sp));
                    }
                    None => assert!(!e.exists(&rec), "a sponsorship record the model closed"),
                }
            }
            for t in &r.members {
                if self.m.tickets.contains_key(t) {
                    assert_eq!(self.m.tickets[t].round, id);
                }
            }
        }
        assert!(
            accepting <= 1 && unpaid <= 1,
            "invariant 4: one accepting round at most"
        );

        // Tickets, field by field.
        for (a, t) in &self.m.tickets {
            let s: RoundTicket = e.read(a);
            let want = match t.status {
                TStatus::Joined => RoundTicketStatus::Joined,
                TStatus::PayoutParked => RoundTicketStatus::PayoutParked,
                TStatus::ReturnParked => RoundTicketStatus::ReturnParked,
            };
            assert_eq!(s.status, want, "ticket {a}: status");
            assert_eq!((s.round, s.nonce), (t.round, t.nonce));
            assert_eq!(
                addr(s.integrator),
                e.integrator_address(&self.a.integrators[t.integrator].pubkey())
            );
            assert_eq!(addr(s.payer), self.a.payers[t.payer].pubkey());
            assert_eq!(addr(s.funder), self.a.funders[t.funder].pubkey());
            assert_eq!(addr(s.refund_to), self.a.funder_usdc[t.funder]);
            assert_eq!(addr(s.beneficiary), self.a.beneficiaries[t.funder]);
            assert_eq!(addr(s.payout_table), self.a.table_addrs[t.table]);
            assert_eq!(
                (
                    s.price,
                    s.vault_credit,
                    s.payout_max,
                    s.liability,
                    s.protocol_share,
                    s.app_share,
                    s.prepay,
                    s.settle_share,
                    s.payout
                ),
                (
                    t.price,
                    t.credit,
                    t.payout_max,
                    t.liability,
                    t.protocol_share,
                    t.app_share,
                    t.prepay,
                    t.settle_share,
                    t.payout
                ),
                "ticket {a}: books"
            );
            // Invariant 3 of §13.4: the shares are the direct path's, per ticket.
            assert_eq!(t.credit + t.protocol_share + t.app_share, t.price);
        }
        for (a, d) in &self.m.directs {
            let s: Ticket = e.read(a);
            let want = match d.status {
                DStatus::Open => TicketStatus::Open,
                DStatus::Requested => TicketStatus::Requested,
                DStatus::PayoutPending => TicketStatus::PayoutPending,
            };
            assert_eq!(s.status, want, "direct {a}: status");
            assert_eq!(
                (s.price, s.vault_credit, s.reserved_liability, s.payout),
                (d.price, d.credit, d.liability, d.payout)
            );
            assert_eq!(
                (s.side(), s.generation),
                (d.side, d.generation),
                "direct {a}: counter"
            );
        }

        // Invariant 6: a round's prices never change from its close slot on.
        let ids: Vec<u64> = self.m.rounds.keys().copied().collect();
        for id in ids {
            let r = self.m.rounds.get_mut(&id).unwrap();
            if r.close_slot > 0 && slot >= r.close_slot {
                match r.prices_at_close {
                    Some(p) => assert_eq!(
                        p, r.book.prices,
                        "invariant 6: round {id} took a join after its close"
                    ),
                    None => r.prices_at_close = Some(r.book.prices),
                }
            }
            if matches!(r.status, RoundStatus::Accepting | RoundStatus::Paid) {
                let now = (r.book.prices, r.book.sponsorship, r.book.usage);
                self.m.before_draw.insert(id, now);
            }
        }

        // Invariant 11: what has been claimed never exceeds what was released.
        assert!(
            self.m.shares_claimed <= self.m.shares_released,
            "invariant 11"
        );
        assert_eq!(
            self.m.shares_released - self.m.shares_claimed,
            self.m.protocol_accrued + self.m.app_owed,
            "invariant 11: claimable shares are the released ones not yet claimed"
        );
    }

    // --- the drain ---------------------------------------------------------------------------------

    /// Drives every round, ticket and share to its end through the same
    /// predicted steps, then checks that nothing is left open.
    fn drain(&mut self) {
        // Whatever blocked a path is lifted: the pauses and the ORAO fee at
        // once; the frozen accounts only after the first passes, so that
        // settlements and returns to a frozen account park (invariant 10:
        // settlement succeeds whatever the beneficiary's state).
        if self.m.pause != 0 {
            self.pause(2);
            self.check();
        }
        if self.m.fee != ORAO_FEE {
            self.set_fee(ORAO_FEE);
        }
        for pass in 0..64 {
            if pass == DRAIN_THAW_PASS {
                self.thaw();
            }
            if self.m.rounds.is_empty() && self.m.tickets.is_empty() && self.m.directs.is_empty() {
                break;
            }
            let slot = self.slot();
            let ids: Vec<u64> = self.m.rounds.keys().copied().collect();
            for id in ids {
                let Some(r) = self.m.rounds.get(&id).cloned() else {
                    continue;
                };
                match r.status {
                    RoundStatus::Accepting => {
                        self.set_slot(r.refund_from() + r.refund_slots, 0);
                        self.refund_id(id, false);
                    }
                    RoundStatus::Paid => {
                        if slot < r.close_slot + 2 {
                            self.set_slot(r.close_slot + 2, 0);
                        }
                        if beacon::is_expired(self.slot(), r.close_slot, r.t_settle_slots) {
                            // A fulfilled request found from the recorded seed
                            // or SlotHashes is bound late; otherwise the round
                            // expires (refunded once its entropy is lost).
                            let pre = self
                                .known_entropy(id)
                                .ok()
                                .map(|(_, _, q)| q)
                                .filter(|q| self.m.requests.contains_key(q));
                            match pre {
                                Some(q)
                                    if self.m.requests[&q]
                                        .fulfilled
                                        .is_some_and(|x| x != [0; 64]) =>
                                {
                                    self.request_id(id)
                                }
                                _ => self.expire_id(id),
                            }
                        } else {
                            self.request_id(id);
                        }
                    }
                    RoundStatus::Requested => {
                        let q = self.m.requests[&r.randomness].clone();
                        match q.fulfilled {
                            None => self.fulfill_request(&r.randomness, id, false),
                            Some(x) if x == [0; 64] => {
                                self.set_slot(r.close_slot + r.t_settle_slots + 1, 0);
                                self.expire_id(id);
                            }
                            Some(_) => {
                                let live = self.live_members(id);
                                let first: Vec<Address> =
                                    live.into_iter().take(MAX_BATCH).collect();
                                let batch = if first.is_empty() {
                                    r.members[..1].to_vec()
                                } else {
                                    first
                                };
                                self.settle_batch(id, &batch, false);
                            }
                        }
                    }
                    RoundStatus::Drawn => {
                        let live = self.live_members(id);
                        if live.is_empty() {
                            for s in r.sponsors.keys() {
                                self.reclaim_one(id, *s);
                                self.check();
                            }
                        } else {
                            let batch: Vec<Address> = live.into_iter().take(MAX_BATCH).collect();
                            self.settle_batch(id, &batch, false);
                        }
                    }
                    RoundStatus::Refunded | RoundStatus::Forfeited => {
                        // What reached `round_vrf` since its last drain goes
                        // to the round before its last return closes it, as
                        // the keeper sends it.
                        if self
                            .m
                            .lamports
                            .get(&round_vrf_address(id))
                            .is_some_and(|l| *l > 0)
                        {
                            self.sweep_id(id);
                            self.check();
                        }
                        for t in self.live_members(id) {
                            self.return_addr(t);
                            self.check();
                        }
                        if let Some(r) = self.m.rounds.get(&id).cloned() {
                            for s in r.sponsors.keys() {
                                self.reclaim_one(id, *s);
                                self.check();
                            }
                        }
                    }
                }
                self.check();
            }
            let parked: Vec<Address> = self
                .m
                .tickets
                .iter()
                .filter(|(_, t)| t.status != TStatus::Joined)
                .map(|(a, _)| *a)
                .collect();
            for t in parked {
                self.claim_round_payout_addr(t);
                self.check();
            }
            let directs: Vec<Address> = self.m.directs.keys().copied().collect();
            for t in directs {
                let d = self.m.directs[&t].clone();
                let k =
                    u16::try_from(self.m.directs.keys().position(|x| *x == t).unwrap()).unwrap();
                match d.status {
                    DStatus::Open if self.slot() <= d.expiry_slot => {
                        if self.slot() < d.open_slot + 2 {
                            let s = d.open_slot + 2;
                            self.set_slot(s, 0);
                        }
                        self.direct_request(k);
                        if self.m.directs[&t].status == DStatus::Open {
                            self.set_slot(d.expiry_slot + 1, 0);
                            self.direct_expire(k);
                        }
                    }
                    DStatus::Open => self.direct_expire(k),
                    DStatus::Requested => {
                        let q = d.request.unwrap();
                        match self.m.requests[&q].fulfilled {
                            None => self.fulfill_request(&q, k.into(), false),
                            Some(x) if x == [0; 64] => {
                                self.set_slot(d.expiry_slot + 1, 0);
                                self.direct_expire(k);
                            }
                            Some(_) => self.direct_settle(k),
                        }
                    }
                    DStatus::PayoutPending => self.direct_claim(k),
                }
                self.check();
            }
        }
        self.thaw();
        assert!(
            self.m.rounds.is_empty(),
            "the drain left a round: {:?}",
            self.m.rounds.keys()
        );
        // ORAO answers every request its round forfeited before, and every
        // `round_vrf` holding lamports is swept, its round closed: none is
        // left with any.
        for (i, request) in self.late_requests().into_iter().enumerate() {
            self.fulfill_request(&request, i as u64, false);
            bump(&self.stats.late_fulfilled);
            self.check();
        }
        for id in 1..self.m.next_round_id {
            if self
                .m
                .lamports
                .get(&round_vrf_address(id))
                .is_some_and(|l| *l > 0)
            {
                self.sweep_id(id);
                self.check();
            }
        }
        for vrf in &self.m.vrfs {
            assert_eq!(self.env.lamports(vrf), 0, "a round_vrf left with lamports");
        }
        assert!(
            self.m.tickets.is_empty() && self.m.directs.is_empty(),
            "the drain left a ticket"
        );
        for who in 0..=N_INTEGRATORS {
            let k = u8::try_from(who).unwrap();
            let amount = if who == 0 {
                self.m.protocol_accrued
            } else {
                self.m.integ[who - 1].app_accrued
            };
            if amount > 0 {
                self.claim_shares(k);
                self.check();
            }
        }
        // The live epoch struck with nothing open: its price leaves out the
        // results the drain booked after its close.
        let q = self.env.queue();
        if q.current.live {
            if self.now() < q.current.close_ts {
                self.leap_to_epoch_close();
                self.check();
            }
            self.strike();
            self.check();
        }
        // Nothing is left open, owed or held.
        let v = self.env.vault();
        assert_eq!(
            (
                v.total_reserved_liability,
                v.open_vault_credits,
                v.beacon_shares_held,
                v.protocol_shares_accrued,
                v.app_shares_owed,
                v.beacon_returns_owed,
                v.open_before_close,
                v.open_after_close
            ),
            (0, 0, 0, 0, 0, 0, 0, 0),
            "the drained vault"
        );
        assert_eq!(self.env.balance(&self.env.a.payout_escrow), 0);
        bump(&self.stats.cases);
    }

    fn thaw(&mut self) {
        for a in std::mem::take(&mut self.m.frozen) {
            self.env.set_token_state(&a, 1);
        }
    }

    fn live_members(&self, id: u64) -> Vec<Address> {
        self.m.rounds[&id]
            .members
            .iter()
            .filter(|t| {
                self.m
                    .tickets
                    .get(*t)
                    .is_some_and(|m| m.status == TStatus::Joined)
            })
            .copied()
            .collect()
    }
}

impl MTicket {
    fn vault_credit_of(&self) -> u64 {
        self.credit
    }
}

fn transfer_ix(from: &Address, to: &Address, lamports: u64) -> Instruction {
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: system_id(),
        accounts: vec![
            solana_instruction::AccountMeta::new(*from, true),
            solana_instruction::AccountMeta::new(*to, false),
        ],
        data,
    }
}

// --- the run --------------------------------------------------------------------------------

/// One case: the world it starts from and its operations.
type Case = (World, Vec<Op>);

/// Half the cases start from the wide world, a fifth from `Tight` and from
/// `Aftermath`, a tenth from `Tripped`; a failing case shrinks towards the
/// wide one.
fn case() -> impl Strategy<Value = Case> {
    (
        prop_oneof![
            5 => Just(World::Wide),
            2 => Just(World::Tight),
            2 => Just(World::Aftermath),
            1 => Just(World::Tripped),
        ],
        prop::collection::vec(op(), 1..=MAX_OPS),
    )
}

/// Each thread's prepared worlds, one per `World`, in `World::ALL`'s order.
type Bases = Vec<(Env, Actors)>;

fn run_case(bases: &Bases, stats: &Stats, (world, ops): &Case) {
    let k = World::ALL.iter().position(|w| w == world).unwrap();
    let (base, actors) = &bases[k];
    if *world != World::Wide {
        bump(&stats.tight);
    }
    let mut sim = Sim::new(base, actors, stats);
    sim.check();
    for op in ops {
        sim.step(op);
    }
    sim.drain();
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.parse().ok())
}

/// The seed a run uses when `FADE_SM_SEED` is unset: the gate and CI check
/// the same cases every run, so that a failure there is a property of the
/// code, not of the clock. Exploring other sequences is a deliberate act:
/// `FADE_SM_SEED=<n>`, or `FADE_SM_SEED=random` for one from the clock.
const DEFAULT_SEED: u64 = 20_261_015;
/// Shards a run is cut into when `FADE_SM_SHARDS` is unset.
const DEFAULT_SHARDS: u64 = 32;

/// Which cases a run generates, and nothing else: the seed, the number of
/// cases and the shards they are cut into. Shard `s` runs its own cases
/// (`cases / shards`, one more for the first `cases % shards`) from its own
/// RNG, seeded from `(seed, s)`; the threads only take shards from a queue,
/// so the machine's core count changes how fast a run goes, never what it
/// runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Schedule {
    seed: u64,
    cases: u64,
    shards: u64,
}

impl Schedule {
    fn from_env() -> Self {
        let seed = match std::env::var("FADE_SM_SEED") {
            Err(_) => DEFAULT_SEED,
            Ok(v) if v == "random" => std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64,
            Ok(v) => v
                .parse()
                .unwrap_or_else(|_| panic!("FADE_SM_SEED={v}: a number or `random`")),
        };
        let cases = env_u64("FADE_SM_CASES").unwrap_or(10_000);
        let shards = env_u64("FADE_SM_SHARDS").unwrap_or(DEFAULT_SHARDS).max(1);
        Schedule {
            seed,
            cases,
            shards,
        }
    }

    fn cases_of(&self, shard: u64) -> u64 {
        self.cases / self.shards + u64::from(shard < self.cases % self.shards)
    }

    fn rng(&self, shard: u64) -> TestRng {
        let mut bytes = [0u8; 32];
        bytes[..8].copy_from_slice(&self.seed.to_le_bytes());
        bytes[8..16].copy_from_slice(&shard.to_le_bytes());
        bytes[16..].copy_from_slice(b"FADE/BEACON-SM/1");
        TestRng::from_seed(RngAlgorithm::ChaCha, &bytes)
    }

    /// The command that runs `shard` alone, as this run ran it.
    fn reproduce(&self, shard: u64) -> String {
        format!(
            "FADE_SM_SEED={} FADE_SM_CASES={} FADE_SM_SHARDS={} FADE_SM_SHARD={shard} \
             cargo test -p fade --test beacon_state_machine beacon_state_machine -- --nocapture",
            self.seed, self.cases, self.shards
        )
    }
}

/// Runs `shards` of `schedule` on `threads` threads, each built its own
/// state with `init` and taking shards from a queue; `run` gets the shard
/// and the case. Returns a report per failing shard: its reproduction, the
/// index of its first failing case and proptest's shrunk case.
fn run_schedule<W, I, F>(
    schedule: Schedule,
    shards: &[u64],
    threads: u64,
    init: I,
    run: F,
) -> Vec<String>
where
    I: Fn() -> W + Sync,
    F: Fn(&W, u64, &Case) + Sync,
{
    let next = AtomicU64::new(0);
    let failures = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            std::thread::Builder::new()
                .stack_size(64 << 20)
                .spawn_scoped(scope, || {
                    let w = init();
                    loop {
                        let k = next.fetch_add(1, Ordering::Relaxed);
                        let Some(&shard) = shards.get(usize::try_from(k).unwrap()) else {
                            break;
                        };
                        let config = RunnerConfig {
                            cases: u32::try_from(schedule.cases_of(shard)).unwrap(),
                            failure_persistence: None,
                            max_shrink_iters: 4_096,
                            ..RunnerConfig::default()
                        };
                        let mut runner = TestRunner::new_with_rng(config, schedule.rng(shard));
                        // Calls before the first failure: the failing case's
                        // index in its shard (shrinking only follows it).
                        let calls = std::cell::Cell::new(0u64);
                        let first = std::cell::Cell::new(None);
                        let result = runner.run(&case(), |c| {
                            let index = calls.get();
                            calls.set(index + 1);
                            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                run(&w, shard, &c)
                            }));
                            if let Err(panic) = r {
                                if first.get().is_none() {
                                    first.set(Some(index));
                                }
                                std::panic::resume_unwind(panic);
                            }
                            Ok(())
                        });
                        if let Err(e) = result {
                            let index = first
                                .get()
                                .map_or_else(|| "?".to_string(), |i| i.to_string());
                            failures.lock().unwrap().push(format!(
                                "shard {shard} of {}, case {index} of {}: {e}\nreproduce: {}",
                                schedule.shards,
                                schedule.cases_of(shard),
                                schedule.reproduce(shard)
                            ));
                        }
                    }
                })
                .unwrap();
        }
    });
    failures.into_inner().unwrap()
}

/// The cases a run generates depend on its `Schedule` alone: the same in
/// every shard on one thread, on three, and for a shard run alone.
#[test]
fn the_schedule_does_not_depend_on_the_machine() {
    let schedule = Schedule {
        seed: 7,
        cases: 101,
        shards: 6,
    };
    let generated = |shards: &[u64], threads: u64| {
        let seen = std::sync::Mutex::new(BTreeMap::<u64, Vec<String>>::new());
        let failures = run_schedule(
            schedule,
            shards,
            threads,
            || (),
            |_, shard, c| {
                seen.lock()
                    .unwrap()
                    .entry(shard)
                    .or_default()
                    .push(format!("{c:?}"));
            },
        );
        assert!(failures.is_empty());
        seen.into_inner().unwrap()
    };
    let all: Vec<u64> = (0..schedule.shards).collect();
    let one = generated(&all, 1);
    assert_eq!(one.values().map(Vec::len).sum::<usize>(), 101);
    assert_eq!(one[&0].len(), 17);
    assert_eq!(one[&5].len(), 16);
    assert_eq!(generated(&all, 3), one);
    assert_eq!(generated(&all, 6), one);
    assert_eq!(generated(&[4], 2)[&4], one[&4]);
}

/// Spec 08 §13.8's state-machine test: `FADE_SM_CASES` cases (10 000 by
/// default), each a random sequence from one of the two worlds then a
/// drain, with invariants 1 to 12 checked after every step.
#[test]
fn beacon_state_machine() {
    let schedule = Schedule::from_env();
    let only = env_u64("FADE_SM_SHARD");
    let shards: Vec<u64> = match only {
        Some(s) => {
            assert!(
                s < schedule.shards,
                "FADE_SM_SHARD={s} of {}",
                schedule.shards
            );
            vec![s]
        }
        None => (0..schedule.shards).collect(),
    };
    let cases: u64 = shards.iter().map(|s| schedule.cases_of(*s)).sum();
    let threads = env_u64("FADE_SM_THREADS")
        .or_else(|| {
            std::thread::available_parallelism()
                .ok()
                .map(|n| n.get() as u64)
        })
        .unwrap_or(4)
        .clamp(1, shards.len() as u64);
    println!(
        "beacon state machine: FADE_SM_SEED={} FADE_SM_CASES={} FADE_SM_SHARDS={}{}: {cases} cases on {threads} threads",
        schedule.seed,
        schedule.cases,
        schedule.shards,
        only.map_or_else(String::new, |s| format!(" FADE_SM_SHARD={s}")),
    );
    let stats = Stats::default();
    let started = std::time::Instant::now();
    let failures = run_schedule(
        schedule,
        &shards,
        threads,
        || World::ALL.iter().map(|w| base(*w)).collect::<Bases>(),
        |bases, _, c| run_case(bases, &stats, c),
    );
    let s = &stats;
    let g = |c: &AtomicU64| c.load(Ordering::Relaxed);
    println!(
        "{} cases ({} from the tight worlds), {} steps, {} transactions ({} refused as predicted) in {:.1} s: {} joins ({} refused for capacity), {} rounds paid, {} drawn, {} refunded, {} forfeited; {} beacon tickets settled ({} alone on a fork too, at most {} in a batch), {} parked; {} drawdown trips; {} direct tickets; {} strikes ({} refused as unclean)",
        g(&s.cases),
        g(&s.tight),
        g(&s.steps),
        g(&s.sent),
        g(&s.refused),
        started.elapsed().as_secs_f64(),
        g(&s.joins),
        g(&s.capacity),
        g(&s.paid),
        g(&s.drawn),
        g(&s.refunded),
        g(&s.forfeited),
        g(&s.settled),
        g(&s.solo),
        g(&s.largest),
        g(&s.parked),
        g(&s.trips),
        g(&s.directs),
        g(&s.strikes),
        g(&s.unclean),
    );
    for (what, a) in [("joins", &s.join_admissions), ("opens", &s.open_admissions)] {
        println!(
            "{what} predicted refused: {} DrawdownBreaker, {} PerTicketCap, {} IntegratorCap, {} UtilisationBreaker, {} GlobalExposure, {} Insolvent; {} admitted with the cap halved",
            g(&a.drawdown),
            g(&a.per_ticket_cap),
            g(&a.integrator_cap),
            g(&a.utilisation),
            g(&a.global_exposure),
            g(&a.insolvent),
            g(&a.halved),
        );
    }
    let (j, o) = (&s.join_admissions, &s.open_admissions);
    let reached = [
        ("results booked after the close", g(&s.booked)),
        (
            "strikes with an after-close item open",
            g(&s.strikes_after_open),
        ),
        (
            "strikes leaving out after-close results",
            g(&s.strikes_with_results),
        ),
        ("joins refused RoundEpochClosed", g(&s.join_epoch_closed)),
        ("joins at a paid round's close_slot", g(&s.join_at_close)),
        ("joins a full paid round sent to the next", g(&s.rotated)),
        ("refunds refused NotRoundParticipant", g(&s.refund_stranger)),
        ("entropies recorded", g(&s.recorded)),
        ("sweeps of round_vrf into its round", g(&s.swept_into_round)),
        (
            "sweeps of a closed round's round_vrf",
            g(&s.swept_to_caller),
        ),
        (
            "requests fulfilled after their round forfeited",
            g(&s.late_fulfilled),
        ),
        (
            "expiries refunding a round whose entropy was lost",
            g(&s.expire_refunded),
        ),
        ("requests at close_slot + 1", g(&s.request_before_window)),
        (
            "requests at close_slot + t_settle_slots",
            g(&s.request_last_slot),
        ),
        (
            "expiries at close_slot + t_settle_slots",
            g(&s.expire_last_slot),
        ),
        (
            "refunds at refund_from + refund_slots - 1",
            g(&s.refund_last_slot),
        ),
        ("joins refused DrawdownBreaker", g(&j.drawdown)),
        ("joins refused PerTicketCap", g(&j.per_ticket_cap)),
        ("joins refused IntegratorCap", g(&j.integrator_cap)),
        ("joins refused UtilisationBreaker", g(&j.utilisation)),
        ("joins refused GlobalExposure", g(&j.global_exposure)),
        ("joins with the cap halved", g(&j.halved)),
        ("opens refused DrawdownBreaker", g(&o.drawdown)),
        ("opens refused PerTicketCap", g(&o.per_ticket_cap)),
        ("opens refused IntegratorCap", g(&o.integrator_cap)),
        ("opens refused UtilisationBreaker", g(&o.utilisation)),
        ("opens refused GlobalExposure", g(&o.global_exposure)),
        ("opens with the cap halved", g(&o.halved)),
    ];
    println!(
        "reached: {}",
        reached
            .iter()
            .map(|(what, n)| format!("{n} {what}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    // Rare on the default seed (a doomed round idle past its window, met by
    // a stranger): reported, not a required boundary; the unit test
    // `anyone_refunds_a_round_whose_draw_no_longer_fits` pins the path.
    println!(
        "also: {} doomed rounds refunded by a stranger, {} expiries refused for a fulfilled request found through a recorded seed SlotHashes no longer proves, {} late bindings from such a seed, {} direct tickets refunded their credit",
        g(&s.refund_doomed),
        g(&s.fulfilled_found_recorded),
        g(&s.late_bind_recorded),
        g(&s.direct_refunded),
    );
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
    assert_eq!(g(&s.cases), cases, "every case ran to its drain");
    // `Insolvent` is unreachable with valid parameters (see `World`): a
    // prediction of it is a defect of the model.
    assert_eq!((g(&j.insolvent), g(&o.insolvent)), (0, 0));
    // A full run must reach every boundary, the after-close books and every
    // reachable refusal of the breaker and of admission, so that a change to
    // the alphabet, its weights or the worlds cannot quietly stop testing
    // them.
    if only.is_none() && cases >= 10_000 {
        for (what, n) in reached {
            assert!(n > 0, "a {cases}-case run never reached: {what}");
        }
    }
}
