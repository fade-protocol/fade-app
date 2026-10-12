//! Account layouts (Spec 08 §2). Every struct starts with `version` and is
//! append-only; the `_reserved` tail of the long-lived accounts is spare room
//! so that a later field needs no realloc. Sizes are pinned by tests.

use anchor_lang::prelude::*;
use fade_math::drawdown::{Ring, HOURS};
use fade_math::epoch::{Counters, Side};
use fade_math::shares::INDEX_SCALE;
use fade_math::BPS;

use crate::constants::{DELAY_24H, DELAY_7D, MIN_T_SETTLE_SLOTS};

/// Governable parameters: the Technical Specification's §2 table. Settlement
/// never reads them; everything a ticket needs is snapshotted at open.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct RiskParams {
    // --- exposure -------------------------------------------------------------
    /// Fraction of the Kelly-optimal liability a ticket may take, in bps.
    pub kelly_fraction_bps: u64,
    /// Flat ceiling on a ticket's liability as a fraction of assets, in bps.
    pub censorship_bps: u64,
    /// One integrator's open liability as a fraction of assets, in bps.
    pub whale_bps: u64,
    /// Committed fraction of assets above which new tickets are refused, in bps.
    pub utilisation_breaker_bps: u64,
    /// Reserved liability as a fraction of assets never exceeded, in bps.
    pub kappa_bps: u64,
    /// Fall of the share price within 24 hours that stops new tickets, in bps.
    pub drawdown_bps: u64,
    pub min_price: u64,
    pub max_price: u64,
    // --- margin split --------------------------------------------------------------
    /// Smallest share of the ticket price the vault must earn in expectation, in bps.
    pub min_vault_margin_bps: u64,
    /// Taken from the ticket price at open, to the treasury, in bps.
    pub protocol_share_bps: u64,
    pub max_app_share_bps: u64,
    // --- settlement -----------------------------------------------------------
    /// Slots from open after which an unfulfilled ticket can be expired.
    pub t_settle_slots: u64,
    /// Part of the crank fee paid to whoever requests the randomness, lamports.
    pub crank_request_lamports: u64,
    /// Part of the crank fee paid to whoever settles or expires, lamports.
    pub crank_settle_lamports: u64,
    // --- vault -------------------------------------------------------------------
    pub epoch_length_seconds: u64,
    /// Held in each request, paid to whoever claims it, lamports.
    pub claim_fee_lamports: u64,
    /// Paid into the strike fund by a request while the fund is below target, lamports.
    pub strike_fee_lamports: u64,
    /// Paid from the strike fund to whoever strikes an epoch, lamports.
    pub strike_reward_lamports: u64,
    pub fund_target_lamports: u64,
    /// Smallest deposit request, USDC base units.
    pub min_deposit: u64,
    /// Smallest withdrawal request, in share base units, unless it is the owner's whole balance.
    pub min_withdraw_shares: u64,
    /// Smallest deposit while no share exists.
    pub min_first_deposit: u64,
    // --- progressive credit (Spec 04 §4.3), specified and off in V1 ----------
    pub credit_enabled: bool,
    pub credit_base: u64,
    pub credit_rate_bps: u64,
}

impl RiskParams {
    /// Technical Specification §2.
    pub const SPEC: RiskParams = RiskParams {
        kelly_fraction_bps: 5_000,
        censorship_bps: 150,
        whale_bps: 2_000,
        utilisation_breaker_bps: 7_000,
        kappa_bps: 8_000,
        drawdown_bps: 1_500,
        min_price: 7_500_000,
        max_price: 10_000_000_000,
        min_vault_margin_bps: 100,
        protocol_share_bps: 20,
        max_app_share_bps: 500,
        t_settle_slots: 150,
        crank_request_lamports: 50_000,
        crank_settle_lamports: 200_000,
        epoch_length_seconds: 600,
        claim_fee_lamports: 200_000,
        strike_fee_lamports: 200_000,
        strike_reward_lamports: 200_000,
        fund_target_lamports: 50_000_000,
        min_deposit: 1_000_000,
        min_withdraw_shares: 1_000_000_000,
        min_first_deposit: 100_000_000,
        credit_enabled: false,
        credit_base: 0,
        credit_rate_bps: 0,
    };

    pub fn to_math(&self) -> fade_math::risk::Params {
        fade_math::risk::Params {
            kelly_fraction_bps: self.kelly_fraction_bps,
            censorship_bps: self.censorship_bps,
            whale_bps: self.whale_bps,
            utilisation_breaker_bps: self.utilisation_breaker_bps,
            kappa_bps: self.kappa_bps,
            min_price: self.min_price,
            max_price: self.max_price,
            min_vault_margin_bps: self.min_vault_margin_bps,
            protocol_share_bps: self.protocol_share_bps,
            max_app_share_bps: self.max_app_share_bps,
            credit_enabled: self.credit_enabled,
            credit_base: self.credit_base,
            credit_rate_bps: self.credit_rate_bps,
        }
    }

    pub fn crank_fee_lamports(&self) -> Option<u64> {
        self.crank_request_lamports
            .checked_add(self.crank_settle_lamports)
    }

    /// Range checks: every ratio within 100 %, bounds ordered, nothing zero that
    /// would disable a protection. `T_SETTLE` stays well inside the 512 slots
    /// SlotHashes keeps, so the entropy slot is always still readable.
    pub fn is_valid(&self) -> bool {
        let ratio = |v: u64| (1..=BPS).contains(&v);
        ratio(self.kelly_fraction_bps)
            && ratio(self.censorship_bps)
            && ratio(self.whale_bps)
            && ratio(self.utilisation_breaker_bps)
            && ratio(self.kappa_bps)
            && self.drawdown_bps >= 1
            && self.drawdown_bps < BPS
            && self.min_price >= 1
            && self.min_price <= self.max_price
            && self.min_vault_margin_bps >= 1
            && self
                .min_vault_margin_bps
                .saturating_add(self.protocol_share_bps)
                .saturating_add(self.max_app_share_bps)
                <= BPS
            && (MIN_T_SETTLE_SLOTS..=400).contains(&self.t_settle_slots)
            && (60..=86_400).contains(&self.epoch_length_seconds)
            && self.fund_target_lamports >= self.strike_reward_lamports
            && self.min_deposit >= 1
            && self.min_withdraw_shares >= 1
            && self.min_first_deposit >= self.min_deposit
    }

    /// Seconds a change from `self` to `new` must wait (Spec 05 §3): zero when
    /// every field that changes tightens, otherwise the longest delay among the
    /// fields it loosens. A field whose every change is delayed counts as
    /// loosening either way.
    pub fn change_delay(&self, new: &RiskParams) -> i64 {
        let mut delay = 0i64;
        let mut loosens = |yes: bool, d: i64| {
            if yes {
                delay = delay.max(d);
            }
        };
        let (o, n) = (self, new);
        // Caps, ceilings and breakers: raising loosens.
        loosens(n.kelly_fraction_bps > o.kelly_fraction_bps, DELAY_24H);
        loosens(n.censorship_bps > o.censorship_bps, DELAY_24H);
        loosens(n.whale_bps > o.whale_bps, DELAY_24H);
        loosens(
            n.utilisation_breaker_bps > o.utilisation_breaker_bps,
            DELAY_24H,
        );
        loosens(n.kappa_bps > o.kappa_bps, DELAY_24H);
        loosens(n.drawdown_bps > o.drawdown_bps, DELAY_24H);
        loosens(n.max_price > o.max_price, DELAY_24H);
        loosens(n.max_app_share_bps > o.max_app_share_bps, DELAY_24H);
        // Floors and minimums: lowering loosens.
        loosens(n.min_price < o.min_price, DELAY_24H);
        loosens(n.min_first_deposit < o.min_first_deposit, DELAY_24H);
        // Windows: shortening loosens.
        loosens(n.t_settle_slots < o.t_settle_slots, DELAY_24H);
        loosens(n.epoch_length_seconds < o.epoch_length_seconds, DELAY_24H);
        // A cut of the LP's share waits the longest.
        loosens(n.min_vault_margin_bps < o.min_vault_margin_bps, DELAY_7D);
        loosens(n.protocol_share_bps > o.protocol_share_bps, DELAY_7D);
        // Fees charged to users, and the request minimums: raising waits.
        loosens(
            n.crank_request_lamports > o.crank_request_lamports,
            DELAY_24H,
        );
        loosens(n.crank_settle_lamports > o.crank_settle_lamports, DELAY_24H);
        loosens(n.claim_fee_lamports > o.claim_fee_lamports, DELAY_24H);
        loosens(n.strike_fee_lamports > o.strike_fee_lamports, DELAY_24H);
        loosens(n.min_deposit > o.min_deposit, DELAY_24H);
        loosens(n.min_withdraw_shares > o.min_withdraw_shares, DELAY_24H);
        // Either way touches liveness.
        loosens(
            n.strike_reward_lamports != o.strike_reward_lamports,
            DELAY_24H,
        );
        loosens(n.fund_target_lamports != o.fund_target_lamports, DELAY_24H);
        // Progressive credit: switching it on, or lowering its constants, only refuses.
        loosens(o.credit_enabled && !n.credit_enabled, DELAY_24H);
        loosens(n.credit_base > o.credit_base, DELAY_24H);
        loosens(n.credit_rate_bps > o.credit_rate_bps, DELAY_24H);
        delay
    }
}

/// At most one queued parameter change (Spec 08 §7).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct PendingChange {
    pub active: bool,
    pub effective_at: i64,
    pub params: RiskParams,
    pub protocol_treasury: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    /// Bump of `["vault-authority"]`, which owns every token account.
    pub vault_authority_bump: u8,
    /// Parameter authority, and the only party that lifts a pause.
    pub council: Pubkey,
    /// May only set pause flags.
    pub guardian: Pubkey,
    /// USDC token account receiving the protocol share.
    pub protocol_treasury: Pubkey,
    pub usdc_mint: Pubkey,
    /// Bit set: see `Config::PAUSE_*`.
    pub pause_flags: u8,
    pub params: RiskParams,
    pub pending: PendingChange,
    pub _reserved: [u8; 128],
}

impl Config {
    pub const PAUSE_TICKETS: u8 = 1 << 0;
    pub const PAUSE_DEPOSITS: u8 = 1 << 1;
    /// Refuses an `open_ticket` that would create an integrator record.
    pub const PAUSE_NEW_INTEGRATORS: u8 = 1 << 2;
    pub const PAUSE_ALL: u8 =
        Self::PAUSE_TICKETS | Self::PAUSE_DEPOSITS | Self::PAUSE_NEW_INTEGRATORS;

    pub fn is_paused(&self, flag: u8) -> bool {
        self.pause_flags & flag != 0
    }
}

/// The ticket side (Spec 08 §2.1). Never written by a liquidity-provider
/// instruction except the strike and the request that opens an epoch.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub version: u8,
    pub bump: u8,
    /// Everything the vault owns, tracked internally — never read from a token account.
    pub total_assets: u64,
    /// Equal to the share mint's supply; only the strike mints and burns.
    pub total_shares: u64,
    /// `Σ payout_max − vault_credit` of open tickets.
    pub total_reserved_liability: u64,
    /// `Σ vault_credit` of open tickets.
    pub open_vault_credits: u64,
    /// Open tickets opened before the live epoch's close (Spec 08 §4).
    pub open_before_close: u32,
    /// Open tickets opened at or after it, or while no epoch was live.
    pub open_after_close: u32,
    pub generation: u32,
    /// The live epoch's close, or 0.
    pub close_ts: i64,
    /// Highest share price of each of the last 24 hours (Spec 08 §8).
    pub price_maxima: [u128; HOURS],
    pub price_head_hour: i64,
    /// Last time the drawdown condition was seen holding.
    pub drawdown_trip_ts: i64,
    /// Cumulative ticket price ever opened.
    pub volume_total: u64,
    pub integrators: u64,
    /// Results of tickets opened after the live close that have already closed:
    /// what the vault gained (`vault_credit − payout`) and lost on them. A strike
    /// leaves them out of its price; they are the next epoch's (Spec 08 §4 rule 5).
    pub after_close_gain: u64,
    pub after_close_loss: u64,
    pub _reserved: [u8; 112],
}

impl Vault {
    /// The vault's settled assets: everything it owns less the credits of tickets
    /// still open. A strike prices on them, so that a ticket opened after the
    /// close — whose ticket price the vault may yet pay back — never moves the price a
    /// request clears at, and the drawdown breaker measures them, so that only
    /// results move it.
    pub fn settled_assets(&self) -> Option<u64> {
        self.total_assets.checked_sub(self.open_vault_credits)
    }

    /// The share price on settled assets (Spec 08 §8).
    pub fn settled_price(&self) -> Option<u128> {
        fade_math::drawdown::share_price(self.settled_assets()?, self.total_shares).ok()
    }

    /// What a strike prices on: the settled assets as they stood at the close,
    /// less the results of tickets opened after it. Whether such a ticket was
    /// settled before the strike or not then leaves its price unchanged.
    pub fn strike_assets(&self) -> Option<u64> {
        self.settled_assets()?
            .checked_add(self.after_close_loss)?
            .checked_sub(self.after_close_gain)
    }

    /// Books the result of a closing ticket that `after` counts: one opened at
    /// or after the live close, or while none was set.
    pub fn record_after_close_result(&mut self, vault_credit: u64, payout: u64) -> Option<()> {
        if vault_credit >= payout {
            self.after_close_gain = self.after_close_gain.checked_add(vault_credit - payout)?;
        } else {
            self.after_close_loss = self.after_close_loss.checked_add(payout - vault_credit)?;
        }
        Some(())
    }

    /// A new generation of the counters: the tickets `after` counted become the
    /// next epoch's, and so do their results.
    pub fn roll_epoch(&mut self, close_ts: i64) -> Option<()> {
        let mut counters = self.counters();
        counters.roll(close_ts).ok()?;
        self.set_counters(&counters);
        self.clear_after_close_results();
        Some(())
    }

    pub fn clear_after_close_results(&mut self) {
        self.after_close_gain = 0;
        self.after_close_loss = 0;
    }

    pub fn math(&self) -> fade_math::risk::Vault {
        fade_math::risk::Vault {
            assets: self.total_assets,
            reserved: self.total_reserved_liability,
            open_credits: self.open_vault_credits,
        }
    }

    pub fn counters(&self) -> Counters {
        Counters {
            before: self.open_before_close,
            after: self.open_after_close,
            generation: self.generation,
            close_ts: self.close_ts,
        }
    }

    pub fn set_counters(&mut self, c: &Counters) {
        self.open_before_close = c.before;
        self.open_after_close = c.after;
        self.generation = c.generation;
        self.close_ts = c.close_ts;
    }

    pub fn ring(&self) -> Ring {
        Ring {
            maxima: self.price_maxima,
            head_hour: self.price_head_hour,
        }
    }

    pub fn set_ring(&mut self, r: &Ring) {
        self.price_maxima = r.maxima;
        self.price_head_hour = r.head_hour;
    }
}

/// One live epoch in `Queue` (Spec 08 §2.2).
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct LiveEpoch {
    pub live: bool,
    pub epoch_id: u64,
    /// 0 for `next` until it is promoted.
    pub close_ts: i64,
    pub deposits: u64,
    /// Queued withdrawal shares, including those rolled from a rationed strike.
    pub withdraw_shares: u64,
    pub deposit_requests: u32,
    /// New withdrawal requests of this epoch; rolled ones are counted by the chain.
    pub withdraw_requests: u32,
}

/// The liquidity-provider side (Spec 08 §2.2). Its lamports above its own
/// rent-exempt minimum are the strike fund.
#[account]
#[derive(InitSpace)]
pub struct Queue {
    pub version: u8,
    pub bump: u8,
    pub current: LiveEpoch,
    pub next: LiveEpoch,
    /// The id the next epoch to be created receives. Starts at 1.
    pub next_epoch_id: u64,
    /// The epoch id the running withdrawal chain started at, or 0.
    pub chain_id: u64,
    /// Chain indices of Spec 08 §5, `INDEX_SCALE` fixed point.
    pub chain_r: u128,
    pub chain_v: u128,
    /// Withdrawal requests of struck epochs still waiting for the chain to end.
    pub chain_requests: u32,
    pub _reserved: [u8; 128],
}

impl Queue {
    pub fn chain(&self) -> fade_math::shares::Chain {
        fade_math::shares::Chain {
            r: self.chain_r,
            v: self.chain_v,
        }
    }

    pub fn reset_chain(&mut self) {
        self.chain_id = 0;
        self.chain_r = INDEX_SCALE;
        self.chain_v = 0;
        self.chain_requests = 0;
    }

    /// The id of the epoch a request made at `now` joins (Spec 08 §4 rule 2).
    pub fn joining_epoch_id(&self, now: i64) -> u64 {
        use fade_math::epoch::{join, Join};
        match join(self.current.live, self.current.close_ts, now) {
            Join::Open => self.next_epoch_id,
            Join::Current => self.current.epoch_id,
            Join::Next => {
                if self.next.live {
                    self.next.epoch_id
                } else {
                    self.next_epoch_id
                }
            }
        }
    }
}

/// Written once by the strike; only `pending` changes afterwards (Spec 08 §2.3).
#[account]
#[derive(InitSpace)]
pub struct EpochRecord {
    pub version: u8,
    pub bump: u8,
    pub epoch_id: u64,
    pub close_ts: i64,
    pub struck_ts: i64,
    /// The vault's settled assets and its shares at the strike, before its
    /// flows: these fix the price.
    pub total_assets: u64,
    pub total_shares: u64,
    pub deposits: u64,
    pub shares_minted: u64,
    pub withdraw_shares: u64,
    pub assets_owed: u64,
    pub assets_paid: u64,
    pub shares_burnt: u64,
    /// The epoch id the withdrawal chain this strike belongs to started at.
    pub chain_id: u64,
    pub r_before: u128,
    pub v_before: u128,
    pub r_after: u128,
    pub v_after: u128,
    /// Requests whose remaining claims still read this record.
    pub pending: u32,
    /// Requests made in this epoch.
    pub requests: u32,
    /// Where the rent goes when the record closes: the queue (the strike fund
    /// advanced it) or the striker (the fund could not).
    pub rent_payer: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct DepositRequest {
    pub version: u8,
    pub bump: u8,
    pub owner: Pubkey,
    pub epoch_id: u64,
    pub amount: u64,
    /// Set by a claim that could not deliver: the owner's share account could
    /// not receive. The epoch's record is released; `shares_due` waits here.
    pub parked: bool,
    pub shares_due: u64,
}

#[account]
#[derive(InitSpace)]
pub struct WithdrawRequest {
    pub version: u8,
    pub bump: u8,
    pub owner: Pubkey,
    pub epoch_id: u64,
    pub shares: u64,
    /// Chain indices at entry, copied from the entry record by the first claim; 0 before.
    pub r_entry: u128,
    pub v_entry: u128,
    /// Assets already paid by earlier partial claims.
    pub paid: u64,
    /// The chain the request entered, copied with the indices; every later
    /// claim must read a record of this chain. A split carries the request into
    /// the next chain: its remaining `shares` at indices `START`.
    pub chain_id: u64,
    /// Assets owed but not delivered: the owner's USDC account could not
    /// receive when a claim ran. Delivered by the next claim that can.
    pub undelivered: u64,
    /// Set by the final claim when it could not deliver: every record is
    /// released and only `undelivered` remains to hand over.
    pub parked: bool,
}

/// An integrator's record, keyed on the address that signs its tickets (Spec 08 §2.5).
/// Never closed, so its nonce can never restart.
#[account]
#[derive(InitSpace)]
pub struct Integrator {
    pub version: u8,
    pub bump: u8,
    pub authority: Pubkey,
    /// USDC account receiving the app share; changed only by `set_share_account`.
    pub share_account: Pubkey,
    pub reserved_liability: u64,
    pub open_tickets: u64,
    pub next_nonce: u64,
    pub volume_total: u64,
    /// Set by the guardian or the council: this integrator's new tickets are refused.
    pub paused: bool,
    pub created_at: i64,
    pub _reserved: [u8; 64],
}

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct Outcome {
    /// Probability in 1e-9.
    pub p: u64,
    /// Multiplier in bps.
    pub m: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum TicketStatus {
    /// Opened, randomness not requested yet.
    Open,
    /// Randomness requested; waiting for ORAO.
    Requested,
    /// Settled, but the beneficiary could not receive the payout: it waits in
    /// `payout_escrow` for `claim_payout`.
    PayoutPending,
}

#[account]
#[derive(InitSpace)]
pub struct Ticket {
    pub version: u8,
    pub bump: u8,
    pub vrf_payer_bump: u8,
    pub status: TicketStatus,
    pub integrator: Pubkey,
    pub nonce: u64,
    /// Paid the rent and the SOL; receives every refund and the rent at close.
    pub payer: Pubkey,
    /// Stored at open, immutable: the only account a payout can go to.
    pub beneficiary: Pubkey,
    pub price: u64,
    pub vault_credit: u64,
    pub payout_max: u64,
    pub reserved_liability: u64,
    /// The per-ticket cap that applied at open.
    pub cap: u64,
    pub margin_bps: u64,
    pub app_share_bps: u64,
    pub vault_margin_bps: u64,
    /// The drawdown threshold at open: settlement records a trip against it
    /// without reading live parameters.
    pub drawdown_bps: u64,
    pub open_slot: u64,
    pub open_ts: i64,
    /// `open_slot + T_SETTLE`, fixed at open: after it an unfulfilled ticket can be expired.
    pub expiry_slot: u64,
    /// Which epoch counter the ticket joined, and in which generation.
    pub side: u8,
    pub generation: u32,
    /// Lamports of crank fee still held for the requester and the settler.
    pub crank_request_lamports: u64,
    pub crank_settle_lamports: u64,
    /// The ORAO request account, bound by `request_randomness`.
    pub randomness: Pubkey,
    pub entropy_slot: u64,
    pub entropy_hash: [u8; 32],
    pub seed: [u8; 32],
    pub outcome: u8,
    /// Set when the payout waits in `payout_escrow`.
    pub payout: u64,
    pub payout_table_len: u8,
    pub payout_table: [Outcome; 32],
}

impl Ticket {
    pub const SIDE_BEFORE: u8 = 0;
    pub const SIDE_AFTER: u8 = 1;

    pub fn side(&self) -> Side {
        if self.side == Self::SIDE_BEFORE {
            Side::BeforeClose
        } else {
            Side::AfterClose
        }
    }

    pub fn encode_side(side: Side) -> u8 {
        match side {
            Side::BeforeClose => Self::SIDE_BEFORE,
            Side::AfterClose => Self::SIDE_AFTER,
        }
    }

    pub fn outcomes(&self) -> Vec<fade_math::payout_table::Outcome> {
        self.payout_table
            .iter()
            .take(usize::from(self.payout_table_len))
            .map(|b| fade_math::payout_table::Outcome { p: b.p, m: b.m })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_params_are_valid() {
        assert!(RiskParams::SPEC.is_valid());
        assert_eq!(RiskParams::SPEC.crank_fee_lamports(), Some(250_000));
        let mut p = RiskParams::SPEC;
        p.t_settle_slots = 511;
        assert!(
            !p.is_valid(),
            "T_SETTLE must keep the entropy slot inside SlotHashes"
        );
        p.t_settle_slots = 2;
        assert!(
            !p.is_valid(),
            "T_SETTLE must leave a window after the entropy slot"
        );
        let mut p = RiskParams::SPEC;
        p.fund_target_lamports = p.strike_reward_lamports - 1;
        assert!(!p.is_valid());
    }

    #[test]
    fn delays_follow_the_classes_of_spec_05() {
        let o = RiskParams::SPEC;
        let with = |f: &dyn Fn(&mut RiskParams)| {
            let mut n = o;
            f(&mut n);
            o.change_delay(&n)
        };
        assert_eq!(o.change_delay(&o), 0);
        // tightening applies at once
        assert_eq!(with(&|n| n.censorship_bps = 100), 0);
        assert_eq!(with(&|n| n.min_price = 30_000_000), 0);
        assert_eq!(with(&|n| n.epoch_length_seconds = 900), 0);
        assert_eq!(with(&|n| n.credit_enabled = true), 0);
        assert_eq!(with(&|n| n.claim_fee_lamports = 100_000), 0);
        // loosening waits its class
        assert_eq!(with(&|n| n.censorship_bps = 200), DELAY_24H);
        assert_eq!(with(&|n| n.epoch_length_seconds = 300), DELAY_24H);
        assert_eq!(with(&|n| n.min_vault_margin_bps = 90), DELAY_7D);
        assert_eq!(with(&|n| n.protocol_share_bps = 30), DELAY_7D);
        assert_eq!(with(&|n| n.strike_reward_lamports = 150_000), DELAY_24H);
        // the longest class wins, and a tightening in the same change waits with it
        assert_eq!(
            with(&|n| {
                n.censorship_bps = 100;
                n.min_vault_margin_bps = 90;
                n.min_price = 5_000_000;
            }),
            DELAY_7D
        );
    }

    #[test]
    fn a_request_joins_the_right_epoch() {
        let mut q = Queue {
            version: 1,
            bump: 0,
            current: LiveEpoch::default(),
            next: LiveEpoch::default(),
            next_epoch_id: 7,
            chain_id: 0,
            chain_r: INDEX_SCALE,
            chain_v: 0,
            chain_requests: 0,
            _reserved: [0; 128],
        };
        assert_eq!(q.joining_epoch_id(100), 7);
        q.current = LiveEpoch {
            live: true,
            epoch_id: 7,
            close_ts: 600,
            ..LiveEpoch::default()
        };
        q.next_epoch_id = 8;
        assert_eq!(q.joining_epoch_id(599), 7);
        assert_eq!(q.joining_epoch_id(600), 8);
        q.next = LiveEpoch {
            live: true,
            epoch_id: 8,
            ..LiveEpoch::default()
        };
        q.next_epoch_id = 9;
        assert_eq!(q.joining_epoch_id(601), 8);
    }
}
