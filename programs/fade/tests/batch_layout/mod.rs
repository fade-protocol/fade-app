//! The settlement batch layout under substitution (Spec 08
//! §13.8): one harness, driven by the cargo-fuzz target
//! `fuzz/fuzz_targets/settle_round_layout.rs` and by the bounded random run
//! of `tests/settle_layout.rs`.
//!
//! A world holds round 1, paid and fulfilled, in two states: `Requested`
//! (its first batch reads the ORAO request) and `Drawn` (one ticket settled
//! and closed, one winner's payout parked). Round 1 has twelve mixed tickets
//! and a long run of `LONG_RUN` sharing one integrator, payer, payout table
//! and beneficiary, so that a batch of `MAX_ROUND_BATCH` tickets and one of
//! a ticket more fit a transaction's account locks. Round 2 is open with
//! tickets of its own, and one beneficiary of round 1 stays frozen. An input
//! chooses a world, a batch of round 1's tickets laid out from their stored
//! keys (up to `MAX_GROUPS` picked one by one, or a run of 29 to 33 tickets
//! of the long run), then up to `MAX_EDITS` edits: an account replaced by
//! any account of the pool (tickets of both rounds, integrators and their
//! authorities, payers and other wallets, payout tables registered or not,
//! token accounts, the round and the program's own accounts), a writable
//! flag flipped, an account removed or inserted, a bit of `wins` flipped or
//! bit 31 set, `count` moved by one or set to any value from 0 to 33.
//!
//! An oracle written from Spec 08 §13.5.7, not from the program, says
//! whether the list is a valid batch, and which tickets it settles. The
//! property: the program accepts exactly the valid lists; a refused list
//! fails with `MalformedBatch` and moves nothing; an accepted one settles
//! exactly the tickets whose groups name every stored key, each with the
//! payout the round's randomness gives it, and touches nothing else. No
//! list in which an account of a settled ticket's group differs from its
//! stored one settles anything: a group whose ticket address is an empty
//! system account, or a ticket an earlier batch closed or parked, is
//! skipped whatever it names (§13.5.7), and every other difference refuses
//! the whole batch.

use std::collections::{BTreeMap, BTreeSet};

use crate::common::*;
use anchor_lang::AccountDeserialize;
use fade::errors::FadeError;
use fade::events::RoundTicketSettled;
use fade::state::{Outcome, RoundStatus, RoundTicket, RoundTicketStatus};
use fade_math::beacon;
use solana_address::Address;
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
use solana_message::AddressLookupTableAccount;
use solana_signer::Signer;

/// Round 1's mixed tickets (two integrators, three payers, two payout
/// tables, a beneficiary each), the first it holds.
pub const ROUND_ONE: usize = 12;
/// Round 1's tickets after the mixed ones, sharing one integrator, payer,
/// payout table and beneficiary: `MAX_ROUND_BATCH` and one more.
pub const LONG_RUN: usize = 34;
/// The shortest and longest runs of the long run a batch takes.
pub const RUN_MIN: usize = 29;
pub const RUN_MAX: usize = 33;
/// Tickets of round 2, a decoy: valid tickets of another round.
const ROUND_TWO: usize = 3;
/// Groups a batch starts with, before its edits.
pub const MAX_GROUPS: usize = 10;
/// Edits applied to a batch.
pub const MAX_EDITS: usize = 8;
/// The input byte selecting each edit, by kind (`op % 16`; 0xFF is none).
pub const EDIT_REPLACE: u8 = 0;
pub const EDIT_FLAG: u8 = 2;
pub const EDIT_REMOVE: u8 = 3;
pub const EDIT_FLIP_BIT: u8 = 5;
pub const EDIT_COUNT_STEP: u8 = 6;
pub const EDIT_SET_BIT_31: u8 = 7;
pub const EDIT_COUNT_SET: u8 = 14;
pub const EDIT_NONE: u8 = 0xFF;
/// The first input byte's bits choosing a run of the long run (both set:
/// one input in four).
pub const LONG_BATCH: u8 = 0b110;
/// What a transaction may lock (mainnet feature set), less a margin: an
/// input naming more distinct accounts is not run, being refused by the
/// runtime before the program.
const MAX_LOCKS: usize = 62;
/// SPL Token's state byte of a frozen account.
const FROZEN: u8 = 2;

/// A fixed keypair per role and index, so that every ticket's address, and
/// hence its outcome, is the same in every process (a fuzz artifact
/// replays).
fn actor(role: u8, index: usize) -> Keypair {
    let mut secret = [0u8; 32];
    secret[0] = 0xFB;
    secret[1] = role;
    secret[2] = u8::try_from(index).unwrap();
    Keypair::new_from_array(secret)
}

/// One state of round 1 an input settles from.
pub struct State {
    env: Env,
    table: AddressLookupTableAccount,
    /// Round 1's status before the batch.
    status: RoundStatus,
    /// Each pool account as the oracle sees it.
    seen: BTreeMap<Address, Seen>,
}

/// What an account is, for the oracle.
#[derive(Clone)]
enum Seen {
    /// An empty system account, or no account: a closed ticket.
    Empty,
    /// A `RoundTicket` and its payout from round 1's randomness (0 when it is
    /// not round 1's or not `Joined`).
    Ticket(Box<RoundTicket>, u64),
    /// Anything else: owned by Fade or another program, or holding data.
    Other,
}

pub struct World {
    states: [State; 2],
    /// Round 1's tickets, in join order, closed ones included: the
    /// `ROUND_ONE` mixed ones, then the `LONG_RUN`.
    tickets: Vec<Address>,
    /// Each round 1 ticket's stored group, from before any settlement.
    groups: BTreeMap<Address, Group>,
    /// Every account an edit may put in a batch.
    pool: Vec<Address>,
    caller: Keypair,
    rent_payer: Address,
}

/// Counts of what the run did, for the report.
#[derive(Default, Debug, Clone, Copy)]
pub struct Tally {
    pub runs: u64,
    pub skipped: u64,
    pub accepted: u64,
    pub refused: u64,
    pub settled: u64,
}

#[allow(clippy::too_many_arguments)]
fn join(
    env: &mut Env,
    authority: &Keypair,
    share: Address,
    payer: &Keypair,
    funder: &User,
    beneficiary: Address,
    table: &[Outcome],
    price: u64,
    sponsorship: u64,
) -> Address {
    let (round, next_round) = env.round_pair();
    let target = round_address(env.joining_round());
    let j = JoinArgs {
        authority: authority.pubkey(),
        payer: payer.pubkey(),
        funder: funder.key(),
        funder_usdc: funder.usdc,
        share_account: Some(share),
        beneficiary,
        payout_table: env.payout_table_address(table),
        price,
        app_share_bps: 50,
        nonce: env.next_nonce(&authority.pubkey()),
        sponsorship,
        round,
        next_round,
        sponsorship_record: (sponsorship > 0)
            .then(|| sponsorship_address(&target, &payer.pubkey())),
    };
    let ix = env.join_round_ix(&j);
    let keeper = env.keeper.insecure_clone();
    let fk = funder.kp.insecure_clone();
    let mut signers: Vec<&Keypair> = vec![&keeper];
    for k in [authority, payer, &fk] {
        if !signers.iter().any(|s| s.pubkey() == k.pubkey()) {
            signers.push(k);
        }
    }
    env.send(&[ix], &signers).expect("join");
    env.round_ticket_address(&authority.pubkey(), j.nonce)
}

fn group_of(env: &Env, t: &Address, won: bool) -> Group {
    let w = env.round_ticket(t);
    Group {
        ticket: *t,
        integrator: addr(w.integrator),
        payer: addr(w.payer),
        payout_table: addr(w.payout_table),
        beneficiary: won.then(|| addr(w.beneficiary)),
    }
}

fn settle(env: &mut Env, caller: &Keypair, id: u64, groups: &[Group], rent_payer: Address) {
    let ix = env.settle_round_ix(&caller.pubkey(), id, groups, Some(rent_payer));
    let keeper = env.keeper.insecure_clone();
    env.send_v0(&[compute_limit_ix(1_400_000), ix], &[&keeper, caller], &[])
        .expect("a setup batch settles");
}

impl World {
    pub fn new() -> Self {
        let mut env = Env::new();
        env.found(100_000 * USDC);
        let k = env.keeper.insecure_clone();
        let tables = [coin_flip(), coin_flip(), slot_classic()];
        env.register_payout_table(&k, &coin_flip()).unwrap();
        env.register_payout_table(&k, &slot_classic()).unwrap();
        let integrators: Vec<Keypair> = (0..2).map(|i| actor(1, i)).collect();
        let payers: Vec<Keypair> = (0..3).map(|i| actor(2, i)).collect();
        let caller = actor(3, 0);
        for kp in integrators.iter().chain(&payers).chain([&caller]) {
            env.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        }
        let shares: Vec<Address> = integrators
            .iter()
            .map(|i| env.usdc_account(&i.pubkey(), 0))
            .collect();
        let funder = env.user(1_000 * USDC);

        // Round 1: twelve tickets of two integrators and three payers, then
        // the long run, all of integrator 0, payer 0, the coin flip and one
        // beneficiary; the last join pays the round.
        let id = env.joining_round();
        assert_eq!(id, 1);
        let mut tickets = Vec::new();
        let shared = env.usdc_account(&Address::new_unique(), 0);
        for i in 0..ROUND_ONE + LONG_RUN {
            let price = 500_000 + (i as u64 % 5) * 100_000;
            let sponsorship = if i + 1 == ROUND_ONE + LONG_RUN {
                let r = env.round(id);
                beacon::sponsorship_to_pay(&r.terms(), r.prices + price, r.sponsorship).unwrap()
            } else {
                0
            };
            let (who, payer, beneficiary, table) = if i < ROUND_ONE {
                let b = env.usdc_account(&Address::new_unique(), 0);
                (i % 2, i % 3, b, &tables[i % 3])
            } else {
                (0, 0, shared, &tables[0])
            };
            let t = join(
                &mut env,
                &integrators[who],
                shares[who],
                &payers[payer],
                &funder,
                beneficiary,
                table,
                price,
                sponsorship,
            );
            tickets.push(t);
        }
        let round = env.round(id);
        assert_eq!(round.status, RoundStatus::Paid);
        let rent_payer = addr(round.rent_payer);

        // Round 2, opened by joins at round 1's close, never paid.
        let now = env.now();
        env.set_time(round.close_slot + 2, now);
        let mut decoys = Vec::new();
        for i in 0..ROUND_TWO {
            let beneficiary = env.usdc_account(&Address::new_unique(), 0);
            decoys.push(join(
                &mut env,
                &integrators[i % 2],
                shares[i % 2],
                &payers[(i + 1) % 3],
                &funder,
                beneficiary,
                &tables[i % 3],
                500_000,
                0,
            ));
        }
        assert_eq!(env.round_ticket(&decoys[0]).round, 2);

        // Round 1 requested and fulfilled with winners and losers among the
        // mixed tickets and among the long run.
        env.request_round_draw(id).unwrap();
        let randomness = env.round_randomness_with(id, &tickets, |w| {
            let (mixed, long) = w.split_at(ROUND_ONE);
            [mixed, long].iter().all(|part| {
                part.iter().filter(|x| **x).count() >= 4
                    && part.iter().filter(|x| !**x).count() >= 4
            })
        });
        env.fulfill_round(id, randomness);
        let won: Vec<bool> = tickets
            .iter()
            .map(|t| env.beacon_payout_with(id, t, &randomness) > 0)
            .collect();
        let groups: BTreeMap<Address, Group> = tickets
            .iter()
            .zip(&won)
            .map(|(t, w)| (*t, group_of(&env, t, *w)))
            .collect();
        let winners: Vec<usize> = (0..ROUND_ONE).filter(|i| won[*i]).collect();
        // One winner's beneficiary stays frozen: its payout parks.
        let frozen = groups[&tickets[winners[2]]].beneficiary.unwrap();
        env.set_token_state(&frozen, FROZEN);

        // The pool.
        let mut pool: Vec<Address> = tickets.clone();
        pool.extend(&decoys);
        for (i, kp) in integrators.iter().enumerate() {
            pool.push(env.integrator_address(&kp.pubkey()));
            pool.push(kp.pubkey());
            pool.push(shares[i]);
        }
        pool.extend(payers.iter().map(|k| k.pubkey()));
        pool.push(funder.key());
        pool.push(funder.usdc);
        pool.push(caller.pubkey());
        pool.push(env.payout_table_address(&coin_flip()));
        pool.push(env.payout_table_address(&slot_classic()));
        pool.push(env.payout_table_address(&super_long_shot()));
        for t in tickets.iter().chain(&decoys) {
            pool.push(addr(env.round_ticket(t).beneficiary));
        }
        pool.extend([
            round_address(1),
            round_address(2),
            round_vrf_address(1),
            env.a.config,
            env.a.vault,
            env.a.vault_usdc,
            env.a.payout_escrow,
            env.treasury,
            Address::new_from_array([0xFB; 32]),
        ]);
        // In the order built, not by address: some addresses come from a
        // process-wide counter, and an input must pick the same account in
        // every process.
        let mut once = BTreeSet::new();
        pool.retain(|a| once.insert(*a));

        let requested = Self::state(env.fork(), &pool, &caller, rent_payer, &randomness);

        // Drawn: the first batch settles ticket 0 (closed) and winner 0,
        // whose beneficiary is frozen then: its payout parks.
        let parked = groups[&tickets[winners[0]]].beneficiary.unwrap();
        env.set_token_state(&parked, FROZEN);
        let mut first = vec![groups[&tickets[winners[0]]].clone()];
        if winners[0] != 0 {
            first.push(groups[&tickets[0]].clone());
        }
        settle(&mut env, &caller, id, &first, rent_payer);
        env.set_token_state(&parked, 1);
        assert_eq!(
            env.round_ticket(&tickets[winners[0]]).status,
            RoundTicketStatus::PayoutParked
        );
        assert!(!env.exists(&tickets[if winners[0] == 0 { 1 } else { 0 }]) || winners[0] == 0);
        assert_eq!(env.round(id).status, RoundStatus::Drawn);
        let drawn = Self::state(env, &pool, &caller, rent_payer, &randomness);

        World {
            states: [requested, drawn],
            tickets,
            groups,
            pool,
            caller,
            rent_payer,
        }
    }

    fn state(
        mut env: Env,
        pool: &[Address],
        caller: &Keypair,
        rent_payer: Address,
        randomness: &[u8; 64],
    ) -> State {
        let status = env.round(1).status;
        let mut seen = BTreeMap::new();
        for a in pool {
            let s = match env.svm.get_account(a) {
                None => Seen::Empty,
                Some(x) if x.owner == system_id() && x.data.is_empty() => Seen::Empty,
                Some(x) if x.owner == fade_id() => {
                    match RoundTicket::try_deserialize(&mut x.data.as_slice()) {
                        Ok(t) => {
                            let payout = if t.round == 1 && t.status == RoundTicketStatus::Joined {
                                env.beacon_payout_with(1, a, randomness)
                            } else {
                                0
                            };
                            Seen::Ticket(Box::new(t), payout)
                        }
                        Err(_) => Seen::Other,
                    }
                }
                Some(_) => Seen::Other,
            };
            seen.insert(*a, s);
        }
        // One lookup table holds the pool and the batch's fixed accounts, so
        // that any list fits the transaction's bytes.
        let mut lut: Vec<Address> = pool.to_vec();
        let fixed =
            env.settle_round_raw_ix(&caller.pubkey(), 1, 1, 0, Vec::new(), Some(rent_payer));
        lut.extend(fixed.accounts.iter().map(|m| m.pubkey));
        lut.retain(|k| *k != caller.pubkey() && *k != env.keeper.pubkey() && *k != fade_id());
        lut.sort();
        lut.dedup();
        let table = env.lookup_table(&lut);
        State {
            env,
            table,
            status,
            seen,
        }
    }

    /// The accounts a refused batch must leave as they were, and an accepted
    /// one may change only as the oracle says.
    fn watched(&self, s: &State) -> Vec<Address> {
        let mut v = self.pool.clone();
        v.extend([
            round_address(1),
            round_vrf_address(1),
            s.env.a.vault,
            s.env.a.vault_usdc,
            s.env.a.payout_escrow,
            self.rent_payer,
        ]);
        v.retain(|a| *a != self.caller.pubkey());
        v.sort();
        v.dedup();
        v
    }

    /// Runs one input; panics if the program and the oracle disagree.
    pub fn run(&self, data: &[u8], tally: &mut Tally) {
        tally.runs += 1;
        let mut bytes = data.iter().copied();
        let mut next = || bytes.next().unwrap_or(0);
        let first = next();
        let s = &self.states[usize::from(first & 1)];
        // The batch's tickets: picked one by one, or a run of the long run
        // from any of its tickets, wrapping (all distinct).
        let picked: Vec<Address> = if first & LONG_BATCH != LONG_BATCH {
            let n = 1 + usize::from(next()) % MAX_GROUPS;
            (0..n)
                .map(|_| self.tickets[usize::from(next()) % self.tickets.len()])
                .collect()
        } else {
            let n = RUN_MIN + usize::from(next()) % (RUN_MAX - RUN_MIN + 1);
            let start = usize::from(next());
            (0..n)
                .map(|k| self.tickets[ROUND_ONE + (start + k) % LONG_RUN])
                .collect()
        };

        // The batch as its tickets' stored keys lay it out. A winner past
        // the 32 bits of `wins` (a 33rd group) keeps its beneficiary and
        // has no bit to say so.
        let mut metas: Vec<AccountMeta> = Vec::new();
        let mut wins = 0u32;
        for (i, t) in picked.iter().enumerate() {
            let g = &self.groups[t];
            if g.beneficiary.is_some() {
                wins |= 1u32.checked_shl(u32::try_from(i).unwrap()).unwrap_or(0);
            }
            metas.extend(g.metas());
        }
        let mut count = u8::try_from(picked.len()).unwrap();

        // The edits.
        for _ in 0..MAX_EDITS {
            let (op, at, value) = (next(), next(), next());
            let at = usize::from(at);
            let pick = self.pool[usize::from(value) % self.pool.len()];
            // `op % 16`: the kinds of `op % 8` before, twice, but for 7 (set
            // bit 31), 14 (set `count`) and 15 (none, 0xFF among them).
            match op % 16 {
                0 | 1 | 8 | 9 if !metas.is_empty() => {
                    let k = at % metas.len();
                    metas[k].pubkey = pick;
                }
                2 | 10 if !metas.is_empty() => {
                    let k = at % metas.len();
                    metas[k].is_writable = !metas[k].is_writable;
                }
                3 | 11 if !metas.is_empty() => {
                    metas.remove(at % metas.len());
                }
                4 | 12 => {
                    let k = at % (metas.len() + 1);
                    metas.insert(
                        k,
                        AccountMeta {
                            pubkey: pick,
                            is_signer: false,
                            is_writable: value & 0x80 != 0,
                        },
                    );
                }
                5 | 13 => wins ^= 1 << (at % 32),
                6 => {
                    count = if at & 1 == 0 {
                        count.wrapping_add(1)
                    } else {
                        count.wrapping_sub(1)
                    }
                }
                7 => wins |= 1 << 31,
                14 => count = value % (fade::MAX_ROUND_BATCH + 2),
                _ => {}
            }
        }

        let ix = s.env.settle_round_raw_ix(
            &self.caller.pubkey(),
            1,
            count,
            wins,
            metas.clone(),
            Some(self.rent_payer),
        );
        let distinct: BTreeSet<Address> = ix.accounts.iter().map(|m| m.pubkey).collect();
        if distinct.len() + 2 > MAX_LOCKS {
            tally.skipped += 1;
            return;
        }
        let predicted = self.oracle(s, count, wins, &metas, &ix.accounts);

        let mut env = s.env.fork();
        let watched = self.watched(s);
        let before: Vec<Option<Bytes>> = watched.iter().map(|a| bytes_of(&env, a)).collect();
        let keeper = env.keeper.insecure_clone();
        let result = env.send_v0(
            &[compute_limit_ix(1_400_000), ix],
            &[&keeper, &self.caller],
            std::slice::from_ref(&s.table),
        );
        match (predicted, result) {
            (Err(why), Err(f)) => {
                assert!(
                    f.has_code(fade_error(FadeError::MalformedBatch)),
                    "refused for {why}, but not as MalformedBatch: {}\n{}",
                    f.err,
                    f.logs.join("\n")
                );
                for (a, x) in watched.iter().zip(&before) {
                    assert!(bytes_of(&env, a) == *x, "a refused batch changed {a}");
                }
                tally.refused += 1;
            }
            (Err(why), Ok(_)) => panic!(
                "the program settled a batch the specification refuses ({why}): count {count}, wins {wins:#b}, {} accounts",
                metas.len()
            ),
            (Ok(_), Err(f)) => panic!(
                "the program refused a valid batch: {}\n{}",
                f.err,
                f.logs.join("\n")
            ),
            (Ok(settles), Ok(meta)) => {
                let events = events::<RoundTicketSettled>(&meta);
                let got: BTreeMap<Address, u64> =
                    events.iter().map(|e| (addr(e.ticket), e.payout)).collect();
                assert_eq!(got, settles, "the batch settled other tickets than its valid groups");
                // What may change: the settled tickets and their accounts,
                // the round and the vault's.
                let mut touched: BTreeSet<Address> = BTreeSet::from([
                    round_address(1),
                    round_vrf_address(1),
                    env.a.vault,
                    env.a.vault_usdc,
                    env.a.payout_escrow,
                    self.rent_payer,
                ]);
                for t in settles.keys() {
                    let Seen::Ticket(w, payout) = &s.seen[t] else {
                        unreachable!()
                    };
                    touched.extend([*t, addr(w.integrator), addr(w.payer), addr(w.beneficiary)]);
                    let frozen = token_frozen(&s.env, &addr(w.beneficiary));
                    match env.svm.get_account(t).filter(|x| x.lamports > 0) {
                        None => assert!(!frozen, "ticket {t} closed with its payout undelivered"),
                        Some(_) => {
                            let after = env.round_ticket(t);
                            assert!(frozen && *payout > 0, "ticket {t} left open");
                            assert_eq!(after.status, RoundTicketStatus::PayoutParked);
                        }
                    }
                }
                for (a, x) in watched.iter().zip(&before) {
                    if !touched.contains(a) {
                        assert!(
                            bytes_of(&env, a) == *x,
                            "an accepted batch changed {a}, outside its tickets"
                        );
                    }
                }
                tally.accepted += 1;
                tally.settled += settles.len() as u64;
            }
        }
    }

    /// Spec 08 §13.5.7's checks on a batch of round 1: `Ok` with the tickets
    /// it settles and their payouts, or `Err` with the first broken rule.
    fn oracle(
        &self,
        s: &State,
        count: u8,
        wins: u32,
        rem: &[AccountMeta],
        all: &[AccountMeta],
    ) -> Result<BTreeMap<Address, u64>, String> {
        assert!(matches!(
            s.status,
            RoundStatus::Requested | RoundStatus::Drawn
        ));
        if !(1..=32).contains(&count) {
            return Err(format!("count {count}"));
        }
        if u64::from(wins) >> count != 0 {
            return Err("a bit of wins at or above count".into());
        }
        let count = usize::from(count);
        if rem.len() != 4 * count + wins.count_ones() as usize {
            return Err("the number of accounts".into());
        }
        // An account is writable in the instruction if any of its metas is.
        let writable = |a: &Address| all.iter().any(|m| m.pubkey == *a && m.is_writable);
        let mut settles = BTreeMap::new();
        let mut seen = BTreeSet::new();
        let mut at = 0;
        for i in 0..count {
            let won = wins & (1 << i) != 0;
            let g = &rem[at..at + 4 + usize::from(won)];
            at += g.len();
            let key = g[0].pubkey;
            if !seen.insert(key) {
                return Err(format!("ticket {key} named twice"));
            }
            let kind = s.seen.get(&key).cloned().unwrap_or(Seen::Other);
            let (t, payout) = match kind {
                Seen::Empty => continue,
                Seen::Other => return Err(format!("group {i}: not a ticket")),
                Seen::Ticket(t, payout) => (t, payout),
            };
            if !writable(&key) {
                return Err(format!("group {i}: ticket read-only"));
            }
            if t.round != 1 {
                return Err(format!("group {i}: a ticket of round {}", t.round));
            }
            match t.status {
                RoundTicketStatus::Joined => {}
                RoundTicketStatus::PayoutParked => continue,
                RoundTicketStatus::ReturnParked => return Err("a returned ticket".into()),
            }
            if g[1].pubkey != addr(t.integrator) || !writable(&g[1].pubkey) {
                return Err(format!("group {i}: integrator"));
            }
            if g[2].pubkey != addr(t.payer) || !writable(&g[2].pubkey) {
                return Err(format!("group {i}: payer"));
            }
            if g[3].pubkey != addr(t.payout_table) {
                return Err(format!("group {i}: payout table"));
            }
            if (payout > 0) != won {
                return Err(format!("group {i}: the bit of wins"));
            }
            if won && (g[4].pubkey != addr(t.beneficiary) || !writable(&g[4].pubkey)) {
                return Err(format!("group {i}: beneficiary"));
            }
            settles.insert(key, payout);
        }
        Ok(settles)
    }

    /// How many accounts an edit picks from.
    pub fn pool_len(&self) -> usize {
        self.pool.len()
    }

    /// Settles every live ticket in both states in valid batches (the mixed
    /// tickets, then the long run `MAX_ROUND_BATCH` at a time), so that a run
    /// that never reaches an accepted list still checks the success path.
    pub fn self_check(&self) {
        let max = usize::from(fade::MAX_ROUND_BATCH);
        for s in &self.states {
            let mut env = s.env.fork();
            let live = |range: &[Address]| -> Vec<Group> {
                range
                    .iter()
                    .filter_map(|t| match s.seen.get(t) {
                        Some(Seen::Ticket(w, payout)) if w.status == RoundTicketStatus::Joined => {
                            assert_eq!(*payout > 0, self.groups[t].beneficiary.is_some());
                            Some(self.groups[t].clone())
                        }
                        _ => None,
                    })
                    .collect()
            };
            let (mixed, long) = self.tickets.split_at(ROUND_ONE);
            let long = live(long);
            let mut batches = vec![live(mixed)];
            batches.extend(long.chunks(max).map(<[Group]>::to_vec));
            assert_eq!(batches[1].len(), max, "a full batch is checked");
            for groups in &batches {
                let ix =
                    env.settle_round_ix(&self.caller.pubkey(), 1, groups, Some(self.rent_payer));
                let keeper = env.keeper.insecure_clone();
                let meta = env
                    .send_v0(
                        &[compute_limit_ix(1_400_000), ix],
                        &[&keeper, &self.caller],
                        std::slice::from_ref(&s.table),
                    )
                    .expect("every live ticket settles");
                assert_eq!(events::<RoundTicketSettled>(&meta).len(), groups.len());
            }
        }
    }
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

/// An account's lamports, owner and data: what an instruction can change
/// (the runtime rewrites `rent_epoch` of every writable account it loads).
type Bytes = (u64, Address, Vec<u8>);

fn bytes_of(env: &Env, a: &Address) -> Option<Bytes> {
    env.svm
        .get_account(a)
        .filter(|x| x.lamports > 0)
        .map(|x| (x.lamports, x.owner, x.data))
}

fn token_frozen(env: &Env, a: &Address) -> bool {
    env.svm.get_account(a).is_some_and(|x| {
        x.owner == fade_testkit::token::token_program_id() && x.data.get(108) == Some(&FROZEN)
    })
}

/// A payout table never registered: its address is a system account.
fn super_long_shot() -> Vec<Outcome> {
    vec![
        Outcome {
            p: 1_000_000,
            m: 900_000_000,
        },
        Outcome {
            p: 999_000_000,
            m: 0,
        },
    ]
}
