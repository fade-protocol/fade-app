//! Account layouts (Spec 08 §2). Every struct starts with `version` and is
//! append-only; the `_reserved` tail of the long-lived accounts is spare room
//! so that a later field needs no realloc. Sizes are pinned by tests.

use anchor_lang::prelude::*;
use fade_math::drawdown::{Ring, HOURS};
use fade_math::epoch::{Counters, Side};
use fade_math::shares::INDEX_SCALE;
use fade_math::BPS;

use crate::constants::{
    DELAY_24H, DELAY_7D, MAX_EPOCH_LENGTH_SECONDS, MAX_REFUND_SLOTS, MAX_ROUND_K, MAX_TICK_SLOTS,
    MIN_KAPPA_BPS, MIN_T_SETTLE_SLOTS,
};
use crate::errors::FadeError;

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
    // --- shared beacon (Spec 08 §13.3); every one snapshotted by a round at its creation
    /// Smallest beacon ticket price, USDC base units.
    pub beacon_min_price: u64,
    /// `T_r`: the ticket prices that pay a round's whole draw, USDC base units.
    pub beacon_threshold: u64,
    /// `k`: per-ticket caps a paid round may carry; at most `MAX_ROUND_K`.
    pub round_k: u64,
    /// A paid round closes at the next multiple of `tick_slots`.
    pub tick_slots: u64,
    /// Slots after a round's latest join from which an unpaid round may be refunded.
    pub refund_slots: u64,
    /// Settlement share of a beacon ticket, paid to whoever settles or returns it, lamports.
    pub crank_round_settle_lamports: u64,
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
        beacon_min_price: 500_000,
        beacon_threshold: 8_640_000,
        round_k: 1,
        tick_slots: 37,
        refund_slots: 1_715,
        crank_round_settle_lamports: 20_000,
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
    /// SlotHashes keeps, so the entropy slot is always still readable. κ is
    /// never below `MIN_KAPPA_BPS`: the strike's κ term then holds back at
    /// most 1.25 times the reserved liability.
    pub fn is_valid(&self) -> bool {
        let ratio = |v: u64| (1..=BPS).contains(&v);
        ratio(self.kelly_fraction_bps)
            && ratio(self.censorship_bps)
            && ratio(self.whale_bps)
            && ratio(self.utilisation_breaker_bps)
            && (MIN_KAPPA_BPS..=BPS).contains(&self.kappa_bps)
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
            && (60..=MAX_EPOCH_LENGTH_SECONDS).contains(&self.epoch_length_seconds)
            && self.fund_target_lamports >= self.strike_reward_lamports
            && self.min_deposit >= 1
            && self.min_withdraw_shares >= 1
            && self.min_first_deposit >= self.min_deposit
            && self.beacon_is_valid()
    }

    /// The beacon's ranges (Spec 08 §13.3). `round_k` is bounded by a program
    /// constant, so no parameter change can raise it above `MAX_ROUND_K`.
    fn beacon_is_valid(&self) -> bool {
        (1..=self.max_price).contains(&self.beacon_min_price)
            && (self.beacon_min_price..=self.max_price).contains(&self.beacon_threshold)
            && (1..=u64::from(MAX_ROUND_K)).contains(&self.round_k)
            && (1..=MAX_TICK_SLOTS).contains(&self.tick_slots)
            && (self.tick_slots..=MAX_REFUND_SLOTS).contains(&self.refund_slots)
            && (1..=self.crank_settle_lamports).contains(&self.crank_round_settle_lamports)
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
        loosens(n.drawdown_bps > o.drawdown_bps, DELAY_24H);
        loosens(n.max_price > o.max_price, DELAY_24H);
        loosens(n.max_app_share_bps > o.max_app_share_bps, DELAY_24H);
        // Floors and minimums: lowering loosens.
        loosens(n.min_price < o.min_price, DELAY_24H);
        loosens(n.min_first_deposit < o.min_first_deposit, DELAY_24H);
        // Windows: shortening loosens. Lengthening the epoch applies at once
        // because `is_valid` bounds it (`MAX_EPOCH_LENGTH_SECONDS`) well below
        // this delay, so a loosening's notice still leaves LPs a strike.
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
        // Either way: a higher κ loosens admission, a lower κ holds back more
        // LP capital at the strike.
        loosens(n.kappa_bps != o.kappa_bps, DELAY_24H);
        // Progressive credit: switching it on, or lowering its constants, only refuses.
        loosens(o.credit_enabled && !n.credit_enabled, DELAY_24H);
        loosens(n.credit_base > o.credit_base, DELAY_24H);
        loosens(n.credit_rate_bps > o.credit_rate_bps, DELAY_24H);
        // The beacon (Spec 09 §11): a lower threshold or minimum, a larger
        // `k`, a shorter tick or refund window loosen; the settlers' pay moves
        // liveness either way, like `strike_reward_lamports`.
        loosens(n.beacon_min_price < o.beacon_min_price, DELAY_24H);
        loosens(n.beacon_threshold < o.beacon_threshold, DELAY_24H);
        loosens(n.round_k > o.round_k, DELAY_24H);
        loosens(n.tick_slots < o.tick_slots, DELAY_24H);
        loosens(n.refund_slots < o.refund_slots, DELAY_24H);
        loosens(
            n.crank_round_settle_lamports != o.crank_round_settle_lamports,
            DELAY_24H,
        );
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
    /// Refuses `join_round`: stops the beacon alone, for a defect in it
    /// (Spec 08 §13.7). `PAUSE_TICKETS` stops both paths.
    pub const PAUSE_ROUNDS: u8 = 1 << 3;
    pub const PAUSE_ALL: u8 = Self::PAUSE_TICKETS
        | Self::PAUSE_DEPOSITS
        | Self::PAUSE_NEW_INTEGRATORS
        | Self::PAUSE_ROUNDS;

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
    // --- shared beacon (Spec 08 §13.2.6), taken from the reserved tail ---------
    /// Id of the round accepting tickets, or 0.
    pub accepting_round: u64,
    /// Id the next round created receives; starts at 1.
    pub next_round_id: u64,
    /// Protocol and app shares of beacon tickets joined and not yet settled,
    /// returned or forfeited: in `vault_usdc`, outside `total_assets`.
    pub beacon_shares_held: u64,
    /// Protocol shares of settled and forfeited beacon tickets, not yet claimed.
    pub protocol_shares_accrued: u64,
    /// `Σ Integrator.app_shares_accrued`.
    pub app_shares_owed: u64,
    /// Ticket prices of refunded rounds' tickets not yet returned.
    pub beacon_returns_owed: u64,
    /// Rounds `expire_round` has forfeited, ever.
    pub rounds_forfeited: u64,
    /// The expiries a withheld draw may explain: every forfeiture but one of
    /// a round never requested whose request the program looked for and did
    /// not find (`RoundExpired`'s `!requested && checked && !request_found`,
    /// the keepers' failure), and every round `expire_round` refunded because
    /// its entropy was never recorded and SlotHashes no longer proves it
    /// (`RoundExpired.refunded`). A durable count, so that an alarm never has
    /// to infer a withheld draw from transaction history it could not read.
    pub forfeits_withheld: u64,
    /// The direct expiries a withheld draw may explain, by the same rule as
    /// `forfeits_withheld` (`TicketExpired`'s `requested || request_found ||
    /// !checked`, every refund included), kept apart so that each path's
    /// alarm accounts for its own ordinals. Taken from the reserved tail.
    pub ticket_forfeits_withheld: u64,
    pub _reserved: [u8; 40],
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
    /// App shares of its settled and forfeited beacon tickets, not yet claimed
    /// (Spec 08 §13.2.6); taken from the reserved tail.
    pub app_shares_accrued: u64,
    pub _reserved: [u8; 56],
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
    /// `s*`, `h*` and the ORAO seed, recorded by `record_ticket_entropy` or
    /// `request_randomness`; all zero until then.
    pub entropy_slot: u64,
    pub entropy_hash: [u8; 32],
    pub seed: [u8; 32],
    /// The outcome drawn, or `REFUND_OUTCOME` for a refund parked in
    /// `payout_escrow`; 0 until either.
    pub outcome: u8,
    /// Set when the payout (or the refunded credit) waits in `payout_escrow`.
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

    /// Whether the ticket's seed is recorded, by `record_ticket_entropy` or
    /// `request_randomness`: `s*` follows the open, so a recorded entropy slot
    /// is never 0, and `open_ticket` leaves it 0.
    pub fn entropy_recorded(&self) -> bool {
        self.entropy_slot != 0
    }

    pub fn outcomes(&self) -> Vec<fade_math::payout_table::Outcome> {
        self.payout_table
            .iter()
            .take(usize::from(self.payout_table_len))
            .map(|b| fade_math::payout_table::Outcome { p: b.p, m: b.m })
            .collect()
    }
}

// --- shared beacon (Spec 08 §13.2) ---------------------------------------------

/// A payout table stored once, at `["payout-table", hash]` (Spec 08 §13.2.1).
/// Immutable and never closed: a beacon ticket stores its address instead of
/// its outcomes. It holds no share and no margin floor, which depend on the
/// ticket's app share and the live parameters and are checked at each join.
#[account]
#[derive(InitSpace)]
pub struct PayoutTable {
    pub version: u8,
    pub bump: u8,
    pub len: u8,
    /// `Σ p·m` of the outcomes, from `payout_table::validate`.
    pub lhs: u128,
    /// The largest multiplier, in bps.
    pub max_m: u64,
    /// `SHA256("FADE/PAYOUT-TABLE/v1" ‖ len ‖ p₀ ‖ m₀ ‖ …)`, little-endian `u64`s.
    pub hash: [u8; 32],
    pub outcomes: [Outcome; 32],
}

impl PayoutTable {
    pub fn outcomes(&self) -> Vec<fade_math::payout_table::Outcome> {
        self.outcomes
            .iter()
            .take(usize::from(self.len))
            .map(|b| fade_math::payout_table::Outcome { p: b.p, m: b.m })
            .collect()
    }
}

/// Where a round stands (Spec 08 §13.2.2). "Closed" is not a state: a `Paid`
/// round is closed from `close_slot` on, computed from the slot.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum RoundStatus {
    /// Unpaid; accepts joins and sponsorship.
    Accepting,
    /// Draw covered; accepts joins while `slot < close_slot`, and sponsorship
    /// until the request; never refunded by `refund_round` (only by
    /// `expire_round`, when its entropy was never recorded and SlotHashes no
    /// longer proves it). Recorded in the epoch counters from
    /// the instruction that paid it, each later join added to the same counter.
    Paid,
    /// ORAO request sent.
    Requested,
    /// Randomness read and draw cost fixed; tickets settling.
    Drawn,
    /// Unpaid round refunded, or a paid one `expire_round` refunded because
    /// its draw can no longer be found; tickets being returned.
    Refunded,
    /// Closed round unrequested or unfulfilled at `T_SETTLE`.
    Forfeited,
}

/// One draw shared by the tickets that joined it, at `["round", id]`
/// (Spec 08 §13.2.2). Prepays and sponsorship are held in its lamports.
#[account]
#[derive(InitSpace)]
pub struct Round {
    pub version: u8,
    pub bump: u8,
    /// Bump of `["round-vrf", round]`.
    pub vrf_bump: u8,
    pub status: RoundStatus,
    pub id: u64,
    /// Advanced the round's rent; receives it, with the dust, at close.
    pub rent_payer: Pubkey,
    // --- clock ---------------------------------------------------------------------
    /// Slot of the first join.
    pub first_slot: u64,
    /// Slot in which the round became paid; 0 until then.
    pub paid_slot: u64,
    /// First tick boundary after `paid_slot`; 0 until paid.
    pub close_slot: u64,
    // --- snapshot at creation (Spec 09 §3) -------------------------------------------
    /// `T_r`, USDC base units.
    pub threshold: u64,
    /// `D_r`, lamports: two ORAO fees, a pending request's rent and the request share.
    pub draw_max: u64,
    pub round_k: u8,
    pub min_price: u64,
    pub settle_share: u64,
    pub request_share: u64,
    pub tick_slots: u64,
    pub refund_slots: u64,
    pub t_settle_slots: u64,
    pub drawdown_bps: u64,
    // --- aggregates ------------------------------------------------------------------
    /// `R`: ticket prices of every ticket that joined.
    pub prices: u64,
    /// `S`: sponsorship received, lamports.
    pub sponsorship: u64,
    pub liability: u64,
    pub credits: u64,
    pub protocol_shares: u64,
    pub app_shares: u64,
    /// Prepays held on the round and not yet returned, lamports.
    pub prepaid: u64,
    /// `U`: Σ of the tickets' capacity usage, `USAGE_SCALE` fixed point.
    pub usage: u64,
    /// Tickets joined and not yet settled or returned.
    pub tickets: u32,
    /// Sponsorships not yet reclaimed.
    pub sponsors: u32,
    // --- epoch (Spec 08 §13.7) -------------------------------------------------------------
    /// Recorded in the epoch counters.
    pub counted: bool,
    pub side: u8,
    pub generation: u32,
    // --- draw ---------------------------------------------------------------------------
    /// The ORAO request account.
    pub randomness: Pubkey,
    /// The round's seed and its entropy slot `s*`, recorded while SlotHashes
    /// proves `s*` by `record_round_entropy`, `request_round_draw` or the
    /// expiry that looked for its request; zero until then. Once recorded,
    /// the round's ORAO request address no longer depends on SlotHashes.
    pub seed: [u8; 32],
    pub entropy_slot: u64,
    /// Lamports moved to `round_vrf` for the request.
    pub funded: u64,
    /// `C`, fixed by the first settlement or the expiry.
    pub draw_cost: u64,
    /// `R`, the request's randomness, kept by the first settlement; zero
    /// until then. Every later batch reads it here, so that a drawn round
    /// never depends on ORAO's account staying readable (invariant 10).
    pub drawn_randomness: [u8; 64],
    /// Slot of the latest join; the refund window counts from it (Spec 09 §6
    /// as built). Taken from the spare tail: a round written before it reads
    /// 0, and `refund_from` then counts from `first_slot`.
    pub last_join_slot: u64,
    pub _reserved: [u8; 24],
}

impl Round {
    /// The slot the refund window counts from: the latest join's, so that a
    /// round still gathering tickets is never refundable.
    pub fn refund_from(&self) -> u64 {
        self.first_slot.max(self.last_join_slot)
    }

    /// Whether the round's seed is recorded: `s*` follows the close, so a
    /// recorded entropy slot is never 0.
    pub fn entropy_recorded(&self) -> bool {
        self.entropy_slot != 0
    }

    /// The terms the round runs on, from its snapshot.
    pub fn terms(&self) -> fade_math::beacon::Terms {
        fade_math::beacon::Terms {
            threshold: self.threshold,
            draw_max: self.draw_max,
            round_k: self.round_k,
        }
    }

    /// The aggregates the capacity and payment rules read.
    pub fn book(&self) -> fade_math::beacon::Book {
        fade_math::beacon::Book {
            prices: self.prices,
            sponsorship: self.sponsorship,
            usage: self.usage,
            liability: self.liability,
            credits: self.credits,
            protocol_shares: self.protocol_shares,
            app_shares: self.app_shares,
            prepaid: self.prepaid,
            tickets: self.tickets,
        }
    }

    pub fn set_book(&mut self, b: &fade_math::beacon::Book) {
        self.prices = b.prices;
        self.sponsorship = b.sponsorship;
        self.usage = b.usage;
        self.liability = b.liability;
        self.credits = b.credits;
        self.protocol_shares = b.protocol_shares;
        self.app_shares = b.app_shares;
        self.prepaid = b.prepaid;
        self.tickets = b.tickets;
    }

    /// The round takes a join at `slot`: unpaid, or paid and not yet closed.
    pub fn accepts_joins(&self, slot: u64) -> bool {
        match self.status {
            RoundStatus::Accepting => true,
            RoundStatus::Paid => fade_math::beacon::accepts_joins(slot, self.close_slot),
            _ => false,
        }
    }

    /// Records the round in the epoch counters' `side` and `generation`, as
    /// `counters.open_n` returned them when the round became paid (Spec 08
    /// §13.7).
    pub fn record(&mut self, side: Side, generation: u32) {
        self.counted = true;
        self.side = match side {
            Side::BeforeClose => Ticket::SIDE_BEFORE,
            Side::AfterClose => Ticket::SIDE_AFTER,
        };
        self.generation = generation;
    }

    /// The side the round's tickets were counted on. Fails closed: a round not
    /// yet recorded in the epoch counters has no side (its zeroed `side` would
    /// otherwise read as before-close and release tickets the counters never
    /// held), and a value that is neither side is refused, not guessed.
    pub fn side(&self) -> Result<Side> {
        require!(self.counted, FadeError::WrongRoundStatus);
        match self.side {
            Ticket::SIDE_BEFORE => Ok(Side::BeforeClose),
            Ticket::SIDE_AFTER => Ok(Side::AfterClose),
            _ => err!(FadeError::WrongRoundStatus),
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum RoundTicketStatus {
    /// In its round, until the round is drawn, refunded or forfeited.
    Joined,
    /// Settled; the payout waits in `payout_escrow` for `claim_round_payout`.
    PayoutParked,
    /// Returned; the ticket price waits in `payout_escrow` for `claim_round_payout`.
    ReturnParked,
}

/// A beacon ticket, at `["round-ticket", integrator, nonce]` (Spec 08 §13.2.4).
/// Lean: the payout table is referenced by address, and everything common to
/// the round is on the round.
#[account]
#[derive(InitSpace)]
pub struct RoundTicket {
    pub version: u8,
    pub bump: u8,
    pub status: RoundTicketStatus,
    /// The round's id.
    pub round: u64,
    pub integrator: Pubkey,
    pub nonce: u64,
    /// Paid the rent, the prepay and the settlement share; gets back what is not spent.
    pub payer: Pubkey,
    /// Signed for the ticket price.
    pub funder: Pubkey,
    /// The funder's token account: where a refund returns the ticket price.
    pub refund_to: Pubkey,
    /// Stored at the join, immutable: the only account a payout can go to.
    pub beneficiary: Pubkey,
    /// The `PayoutTable` account.
    pub payout_table: Pubkey,
    pub price: u64,
    pub vault_credit: u64,
    pub payout_max: u64,
    pub liability: u64,
    pub protocol_share: u64,
    pub app_share: u64,
    /// Lamports held on the round for the draw.
    pub prepay: u64,
    /// Lamports held on this account above its rent, for whoever settles or returns it.
    pub settle_share: u64,
    /// Set when the payout or the return is parked.
    pub payout: u64,
}

/// One sponsor's lamports in one round, at `["sponsorship", round, sponsor]`
/// (Spec 08 §13.2.5). A second sponsorship by the same sponsor tops it up.
#[account]
#[derive(InitSpace)]
pub struct Sponsorship {
    pub version: u8,
    pub bump: u8,
    /// The round's id.
    pub round: u64,
    pub sponsor: Pubkey,
    pub amount: u64,
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
        // The epoch stays well below the shortest loosening delay, so the
        // instant lengthening cannot outrun a 24-hour notice.
        let mut p = RiskParams::SPEC;
        p.epoch_length_seconds = MAX_EPOCH_LENGTH_SECONDS;
        assert!(p.is_valid());
        assert_eq!(MAX_EPOCH_LENGTH_SECONDS, 21_600);
        p.epoch_length_seconds = MAX_EPOCH_LENGTH_SECONDS + 1;
        assert!(!p.is_valid(), "an epoch near the notice is refused");
        p.epoch_length_seconds = 86_400;
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
    fn kappa_has_a_floor_and_waits_either_way() {
        let mut p = RiskParams::SPEC;
        p.kappa_bps = MIN_KAPPA_BPS;
        assert!(p.is_valid());
        p.kappa_bps = MIN_KAPPA_BPS - 1;
        assert!(!p.is_valid(), "κ below the floor is refused");
        p.kappa_bps = 77;
        assert!(!p.is_valid());
        p.kappa_bps = BPS + 1;
        assert!(!p.is_valid());

        // 8 000 → 9 000 → 8 000: a day's notice in both directions.
        let low = RiskParams::SPEC;
        let mut high = low;
        high.kappa_bps = 9_000;
        assert_eq!(low.change_delay(&high), DELAY_24H);
        assert_eq!(high.change_delay(&low), DELAY_24H);
        // A cut bundled with a raise of the protocol share waits its 7 days.
        let mut bundled = high;
        bundled.kappa_bps = 8_000;
        bundled.protocol_share_bps += 10;
        assert_eq!(high.change_delay(&bundled), DELAY_7D);
    }

    #[test]
    fn beacon_params_are_range_checked() {
        let spec = RiskParams::SPEC;
        let with = |f: &dyn Fn(&mut RiskParams)| {
            let mut p = spec;
            f(&mut p);
            p.is_valid()
        };
        // The boundaries of Spec 08 §13.3 are inclusive.
        assert!(with(&|p| p.beacon_min_price = 1));
        assert!(with(&|p| {
            p.beacon_min_price = p.max_price;
            p.beacon_threshold = p.max_price;
        }));
        assert!(with(&|p| p.beacon_threshold = p.beacon_min_price));
        assert!(with(&|p| p.tick_slots = 1));
        assert!(with(&|p| {
            p.tick_slots = MAX_TICK_SLOTS;
            p.refund_slots = MAX_TICK_SLOTS;
        }));
        assert!(with(&|p| p.refund_slots = MAX_REFUND_SLOTS));
        assert!(with(&|p| p.crank_round_settle_lamports = 1));
        assert!(with(
            &|p| p.crank_round_settle_lamports = p.crank_settle_lamports
        ));
        // And everything outside them is refused.
        assert!(!with(&|p| p.beacon_min_price = 0));
        assert!(!with(&|p| p.beacon_min_price = p.beacon_threshold + 1));
        assert!(!with(&|p| p.beacon_threshold = p.max_price + 1));
        assert!(!with(&|p| p.round_k = 0));
        assert!(
            !with(&|p| p.round_k = u64::from(MAX_ROUND_K) + 1),
            "raising k takes an upgrade"
        );
        assert!(!with(&|p| p.tick_slots = 0));
        assert!(!with(&|p| {
            p.tick_slots = MAX_TICK_SLOTS + 1;
            p.refund_slots = MAX_REFUND_SLOTS;
        }));
        assert!(!with(&|p| p.refund_slots = p.tick_slots - 1));
        assert!(!with(&|p| p.refund_slots = MAX_REFUND_SLOTS + 1));
        assert!(!with(&|p| p.crank_round_settle_lamports = 0));
        assert!(!with(
            &|p| p.crank_round_settle_lamports = p.crank_settle_lamports + 1
        ));
        // A direct-path change that leaves the beacon's ranges is refused too.
        assert!(!with(&|p| p.max_price = p.beacon_threshold - 1));
        assert!(!with(
            &|p| p.crank_settle_lamports = p.crank_round_settle_lamports - 1
        ));
    }

    #[test]
    fn beacon_delays_follow_spec_09() {
        let o = RiskParams::SPEC;
        let with = |f: &dyn Fn(&mut RiskParams)| {
            let mut n = o;
            f(&mut n);
            o.change_delay(&n)
        };
        // Tightening applies at once.
        assert_eq!(with(&|n| n.beacon_min_price += 1), 0);
        assert_eq!(with(&|n| n.beacon_threshold += 1), 0);
        assert_eq!(with(&|n| n.tick_slots += 1), 0);
        assert_eq!(with(&|n| n.refund_slots += 1), 0);
        // Loosening waits 24 hours.
        assert_eq!(with(&|n| n.beacon_min_price -= 1), DELAY_24H);
        assert_eq!(with(&|n| n.beacon_threshold -= 1), DELAY_24H);
        assert_eq!(with(&|n| n.round_k += 1), DELAY_24H);
        assert_eq!(with(&|n| n.tick_slots -= 1), DELAY_24H);
        assert_eq!(with(&|n| n.refund_slots -= 1), DELAY_24H);
        // The settlers' pay waits either way.
        assert_eq!(with(&|n| n.crank_round_settle_lamports += 1), DELAY_24H);
        assert_eq!(with(&|n| n.crank_round_settle_lamports -= 1), DELAY_24H);
        // Lowering `k` tightens.
        let mut two = o;
        two.round_k = 2;
        assert_eq!(two.change_delay(&o), 0);
    }

    #[test]
    fn pause_rounds_is_its_own_bit_and_part_of_pause_all() {
        assert_eq!(Config::PAUSE_ROUNDS, 1 << 3);
        for f in [
            Config::PAUSE_TICKETS,
            Config::PAUSE_DEPOSITS,
            Config::PAUSE_NEW_INTEGRATORS,
        ] {
            assert_eq!(f & Config::PAUSE_ROUNDS, 0);
        }
        assert_eq!(Config::PAUSE_ALL, 0b1111);
    }

    #[test]
    fn a_round_accepts_joins_until_its_close_slot() {
        let mut r = Round {
            version: 1,
            bump: 0,
            vrf_bump: 0,
            status: RoundStatus::Accepting,
            id: 1,
            rent_payer: Pubkey::default(),
            first_slot: 10,
            paid_slot: 0,
            close_slot: 0,
            threshold: 8_640_000,
            draw_max: 1_660_392,
            round_k: 1,
            min_price: 500_000,
            settle_share: 20_000,
            request_share: 50_000,
            tick_slots: 37,
            refund_slots: 1_715,
            t_settle_slots: 150,
            drawdown_bps: 1_500,
            prices: 0,
            sponsorship: 0,
            liability: 0,
            credits: 0,
            protocol_shares: 0,
            app_shares: 0,
            prepaid: 0,
            usage: 0,
            tickets: 0,
            sponsors: 0,
            counted: false,
            side: 0,
            generation: 0,
            randomness: Pubkey::default(),
            seed: [0; 32],
            entropy_slot: 0,
            funded: 0,
            draw_cost: 0,
            drawn_randomness: [0; 64],
            last_join_slot: 0,
            _reserved: [0; 24],
        };
        assert!(r.accepts_joins(u64::MAX), "an unpaid round has no close");
        r.status = RoundStatus::Paid;
        r.paid_slot = 73;
        r.close_slot = fade_math::beacon::close_slot(73, 37).unwrap();
        assert_eq!(r.close_slot, 74);
        assert!(r.accepts_joins(73));
        assert!(!r.accepts_joins(74), "no join at the close slot");
        for s in [
            RoundStatus::Requested,
            RoundStatus::Drawn,
            RoundStatus::Refunded,
            RoundStatus::Forfeited,
        ] {
            r.status = s;
            assert!(!r.accepts_joins(0));
        }
        // The book round-trips through the account.
        let book = fade_math::beacon::Book {
            prices: 1,
            sponsorship: 2,
            usage: 3,
            liability: 4,
            credits: 5,
            protocol_shares: 6,
            app_shares: 7,
            prepaid: 8,
            tickets: 9,
        };
        r.set_book(&book);
        assert_eq!(r.book(), book);
        assert_eq!(
            r.terms(),
            fade_math::beacon::Terms {
                threshold: 8_640_000,
                draw_max: 1_660_392,
                round_k: 1
            }
        );
    }

    #[test]
    fn a_round_has_a_side_only_once_counted() {
        let mut r = Round {
            version: 1,
            bump: 0,
            vrf_bump: 0,
            status: RoundStatus::Paid,
            id: 1,
            rent_payer: Pubkey::default(),
            first_slot: 0,
            paid_slot: 0,
            close_slot: 0,
            threshold: 0,
            draw_max: 0,
            round_k: 1,
            min_price: 0,
            settle_share: 0,
            request_share: 0,
            tick_slots: 0,
            refund_slots: 0,
            t_settle_slots: 0,
            drawdown_bps: 0,
            prices: 0,
            sponsorship: 0,
            liability: 0,
            credits: 0,
            protocol_shares: 0,
            app_shares: 0,
            prepaid: 0,
            usage: 0,
            tickets: 3,
            sponsors: 0,
            counted: false,
            side: 0,
            generation: 0,
            randomness: Pubkey::default(),
            seed: [0; 32],
            entropy_slot: 0,
            funded: 0,
            draw_cost: 0,
            drawn_randomness: [0; 64],
            last_join_slot: 0,
            _reserved: [0; 24],
        };
        let wrong_status: Error = FadeError::WrongRoundStatus.into();
        // Never recorded: the zeroed side is not read as before-close.
        assert_eq!(r.side().unwrap_err(), wrong_status);
        r.side = Ticket::SIDE_AFTER;
        assert_eq!(r.side().unwrap_err(), wrong_status);
        // Recorded: each side maps to itself, with its generation.
        r.record(Side::BeforeClose, 4);
        assert_eq!((r.counted, r.side, r.generation), (true, 0, 4));
        assert_eq!(r.side().unwrap(), Side::BeforeClose);
        r.record(Side::AfterClose, 5);
        assert_eq!((r.counted, r.side, r.generation), (true, 1, 5));
        assert_eq!(r.side().unwrap(), Side::AfterClose);
        // A value that is neither side is refused, not guessed.
        r.side = 2;
        assert_eq!(r.side().unwrap_err(), wrong_status);
    }

    #[test]
    fn the_beacon_tags_are_fade_maths() {
        use crate::constants::{BEACON_OUTCOME_TAG, BEACON_SEED_TAG, PAYOUT_TABLE_TAG};
        assert_eq!(BEACON_SEED_TAG, fade_math::beacon::SEED_TAG);
        assert_eq!(PAYOUT_TABLE_TAG, fade_math::beacon::PAYOUT_TABLE_TAG);
        assert_eq!(BEACON_OUTCOME_TAG, fade_math::beacon::OUTCOME_TAG);
        assert_eq!(u64::from(MAX_ROUND_K), 1);
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
