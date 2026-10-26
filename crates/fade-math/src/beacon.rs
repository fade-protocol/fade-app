//! The shared beacon's arithmetic (Spec 08 §13.4): what a round prefunds and
//! charges for its draw, when it is paid and closes, how much liability it may
//! carry, and what every payer and sponsor gets back.
//!
//! Units: ticket prices in the token's base unit (micro-USDC), draw amounts in
//! lamports, capacity usage in `USAGE_SCALE` fixed point. Rounding goes against
//! whoever could exploit it: a ticket's capacity usage is rounded up (the vault's
//! side), a prepay and a charge up (the round's side: the draw is always
//! covered), a sponsor's return down. No comparison here divides: every
//! fraction is cross-multiplied, in `u128`, or in 192 bits where a `u64` meets
//! a `u128` (`wide`), so no input can overflow a capacity or payment test.
//!
//! The round's state is `Book`. A ticket that has joined stays until the
//! round's end (Spec 08 §13.10 point 4: no cancellation), so every aggregate
//! only grows until the draw, and so do the paid fraction and the capacity it
//! buys: the capacity rule checked at each join holds for good.

use crate::risk::{self, Admission, Ticket};
use crate::{payout_table, Reject};

/// Fixed point of a ticket's capacity usage: `USAGE_SCALE` is a whole per-ticket
/// cap. A ticket admitted by `risk::admit` uses at most this much.
pub const USAGE_SCALE: u64 = 1_000_000_000;

/// `h`: the share of its paid capacity an unpaid round keeps free, in bps.
/// While a round is unpaid, everything that bought its room (ticket prices,
/// sponsorship) can still be refunded in full; without headroom a round left
/// just short of payment and filled to its paid share would refuse every
/// join, the one that completes the payment included, at no cost to whoever
/// filled it. With it, an unpaid round holds at most `(1 − h) · k` caps, so
/// the join that makes it paid always finds at least `h · k` caps of room,
/// and once it lands nothing in the round can be refunded (Spec 09 §7).
pub const UNPAID_HEADROOM_BPS: u64 = 1_000;

/// `k × USAGE_SCALE × (1 − h)`: the usage an unpaid round may reach per unit of
/// paid fraction. Exact: `USAGE_SCALE` is a multiple of `BPS`.
fn unpaid_scale(round_k: u8) -> u64 {
    u64::from(round_k)
        .saturating_mul(USAGE_SCALE / crate::BPS)
        .saturating_mul(crate::BPS.saturating_sub(UNPAID_HEADROOM_BPS))
}

/// Domain tag of a round's ORAO seed.
pub const SEED_TAG: &[u8; 19] = b"FADE/BEACON-SEED/v1";
/// Domain tag of a beacon ticket's outcome.
pub const OUTCOME_TAG: &[u8; 22] = b"FADE/BEACON-OUTCOME/v1";
/// Bytes hashed into a round's seed: tag, program, round, close slot, `s*`, `h*`.
pub const SEED_PREIMAGE_LEN: usize = 19 + 32 + 32 + 8 + 8 + 32;
/// Bytes hashed into a ticket's outcome: tag, program, round, ticket, the
/// 64-byte randomness, the draw index.
pub const OUTCOME_PREIMAGE_LEN: usize = 22 + 32 + 32 + 32 + 64 + 1;
/// Domain tag of a payout table's hash, the seed of its `PayoutTable` account.
pub const PAYOUT_TABLE_TAG: &[u8; 20] = b"FADE/PAYOUT-TABLE/v1";
/// Bytes hashed for a payout table of `MAX_OUTCOMES` outcomes: tag, count,
/// then `p` and `m` of each outcome.
pub const PAYOUT_TABLE_PREIMAGE_MAX_LEN: usize = 20 + 1 + 16 * crate::MAX_OUTCOMES;
/// Slots between a round's close and the earliest request of its draw: the
/// seed needs the first slot after the close in `SlotHashes`.
pub const REQUEST_DELAY_SLOTS: u64 = 2;

/// What a round snapshots at its creation and runs on (Spec 08 §13.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Terms {
    /// `T_r`: the ticket prices that pay the whole draw, in the token's base unit.
    pub threshold: u64,
    /// `D_r`: the draw prefund, in lamports (`prefund`).
    pub draw_max: u64,
    /// `k`: the round may carry `k` per-ticket caps once paid.
    pub round_k: u8,
}

impl Terms {
    /// Every function below needs a non-zero threshold, prefund and `k`.
    pub fn is_valid(&self) -> bool {
        self.threshold > 0 && self.draw_max > 0 && self.round_k > 0
    }

    fn checked(&self) -> Result<&Self, Reject> {
        if self.is_valid() {
            Ok(self)
        } else {
            Err(Reject::Overflow)
        }
    }

    /// `T_r · D_r`: the paid fraction's denominator. Below `u128::MAX`.
    fn whole(&self) -> u128 {
        u128::from(self.threshold).saturating_mul(u128::from(self.draw_max))
    }
}

/// `D_r = 2 × fee + pending_rent + request_share`: one ORAO fee of margin, the
/// rent a pending request account advances (ORAO refunds the part above the
/// fulfilled account's rent only at fulfilment), and the requester's share.
pub fn prefund(orao_fee: u64, pending_rent: u64, request_share: u64) -> Result<u64, Reject> {
    orao_fee
        .checked_mul(2)
        .and_then(|v| v.checked_add(pending_rent))
        .and_then(|v| v.checked_add(request_share))
        .ok_or(Reject::Overflow)
}

/// Whether the live draw still fits the prefund at the request:
/// `fee + pending_rent + request_share ≤ D_r` (`DrawUnderfunded` otherwise).
pub fn request_fits(orao_fee: u64, pending_rent: u64, request_share: u64, draw_max: u64) -> bool {
    match orao_fee
        .checked_add(pending_rent)
        .and_then(|v| v.checked_add(request_share))
    {
        Some(needed) => needed <= draw_max,
        None => false,
    }
}

/// The most a ticket price can be charged for the draw, moved to the round at the
/// join: `ceil(D_r × price / T_r)`.
pub fn prepay(terms: &Terms, price: u64) -> Result<u64, Reject> {
    let t = terms.checked()?;
    let num = u128::from(t.draw_max)
        .checked_mul(u128::from(price))
        .ok_or(Reject::Overflow)?;
    u64::try_from(num.div_ceil(u128::from(t.threshold))).map_err(|_| Reject::Overflow)
}

/// `min(T_r · D_r, R · D_r + S · T_r)`: the paid fraction `min(1, R/T_r +
/// S/D_r)` scaled by `T_r · D_r`, exact. The sum saturates only above
/// `u128::MAX`, beyond `T_r · D_r`, where the minimum ignores it.
pub fn paid_units(terms: &Terms, prices: u64, sponsorship: u64) -> u128 {
    let by_prices = u128::from(prices).saturating_mul(u128::from(terms.draw_max));
    let by_sponsors = u128::from(sponsorship).saturating_mul(u128::from(terms.threshold));
    by_prices.saturating_add(by_sponsors).min(terms.whole())
}

/// The round is paid: `R × D_r + S × T_r ≥ T_r × D_r`.
pub fn is_paid(terms: &Terms, prices: u64, sponsorship: u64) -> bool {
    terms.is_valid() && paid_units(terms, prices, sponsorship) >= terms.whole()
}

/// The sponsorship that makes the round paid, given what it holds:
/// `ceil(D_r × (T_r − R) / T_r) − S`, or 0 if it is paid already. This is what
/// an automatic sponsor sends to complete a draw in one transaction.
pub fn sponsorship_to_pay(terms: &Terms, prices: u64, sponsorship: u64) -> Result<u64, Reject> {
    let t = terms.checked()?;
    let missing = t.threshold.saturating_sub(prices);
    let num = u128::from(t.draw_max)
        .checked_mul(u128::from(missing))
        .ok_or(Reject::Overflow)?;
    let total =
        u64::try_from(num.div_ceil(u128::from(t.threshold))).map_err(|_| Reject::Overflow)?;
    Ok(total.saturating_sub(sponsorship))
}

/// A ticket's capacity usage, `ceil(L × USAGE_SCALE / cap)`, from the liability
/// and the per-ticket cap `risk::admit` gave it at its join: its own vault margin,
/// the free balance before it, halved during a drawdown aftermath. Zero for a
/// ticket with no liability; `PerTicketCap` if the liability exceeds the cap,
/// which admission refuses first.
pub fn usage(liability: u64, cap: u64) -> Result<u64, Reject> {
    if liability == 0 {
        return Ok(0);
    }
    if liability > cap {
        return Err(Reject::PerTicketCap);
    }
    let num = u128::from(liability)
        .checked_mul(u128::from(USAGE_SCALE))
        .ok_or(Reject::Overflow)?;
    u64::try_from(num.div_ceil(u128::from(cap))).map_err(|_| Reject::Overflow)
}

/// `a × b` as `(high, low)`, the value being `high · 2⁶⁴ + low`. Exact for
/// every input: `high ≤ (2⁶⁴ − 1)² + 2⁶⁴ − 1 < 2¹²⁸`.
fn wide(a: u128, b: u64) -> (u128, u64) {
    let b = u128::from(b);
    let a_lo = u128::from(a as u64);
    let a_hi = a.checked_shr(64).unwrap_or(0);
    // Each product is of two values below 2⁶⁴, so below 2¹²⁸: no wrap occurs.
    let lo = a_lo.wrapping_mul(b);
    let hi = a_hi.wrapping_mul(b);
    let carry = lo.checked_shr(64).unwrap_or(0);
    (hi.wrapping_add(carry), lo as u64)
}

/// The capacity rule, `U` being the round's total usage: a paid round holds at
/// most `k` caps, `U ≤ k × USAGE_SCALE`; an unpaid one at most `(1 − h) · k`
/// caps times its paid fraction, `U × T_r × D_r ≤ k × USAGE_SCALE × (1 − h) ×
/// (R × D_r + S × T_r)`. That is `Σ L_i / cap_i ≤ k · min(1, R/T_r + S/D_r)`
/// once paid and `≤ (1 − h) · k · (R/T_r + S/D_r)` before, without a division.
/// The bound only grows with `R` and `S`, and jumps from below `(1 − h) · k`
/// to `k` at the payment. Exact for every `u64` input.
pub fn fits(terms: &Terms, usage_total: u64, prices: u64, sponsorship: u64) -> bool {
    if !terms.is_valid() {
        return false;
    }
    if is_paid(terms, prices, sponsorship) {
        return usage_total <= u64::from(terms.round_k).saturating_mul(USAGE_SCALE);
    }
    let lhs = wide(terms.whole(), usage_total);
    let rhs = wide(
        paid_units(terms, prices, sponsorship),
        unpaid_scale(terms.round_k),
    );
    lhs <= rhs
}

/// The share of a round, paid or not, one join may take: at most `k ·
/// min(1, price/T_r + sponsorship/D_r)` caps, `price` and `sponsorship` what
/// this join brings, or `h · k` caps if more for the join that makes the
/// round paid (`pays_round`). That is `usage × T_r × D_r ≤ k × USAGE_SCALE ×
/// min(T_r × D_r, price × D_r + sponsorship × T_r)`, or `usage ≤ h · k ×
/// USAGE_SCALE` for the paying join, without a division. A round's room
/// beyond what bought it is then sold at the rate an unpaid round's is:
/// taking `k` caps costs about `T_r` of ticket prices or `D_r` of
/// sponsorship, about one draw, however many joins take it, rather than the
/// edge on long-shot tickets at the minimum price, and whoever fills paid
/// rounds pays for the draws it sends the next joins to. The `h · k` floor is
/// the room the paying join is promised (`UNPAID_HEADROOM_BPS`); it is that
/// join's alone, since a floor every join kept would let `1/h` minimum-price
/// joins fill a paid round. A join that pays a whole draw itself keeps all
/// `k`. It holds in an unpaid round too: there the room is everyone's prices
/// and sponsorship, and a join just before the payment could otherwise take
/// what earlier joins bought, as one just after it could. Exact for every
/// `u64` input.
pub fn within_join_share(
    terms: &Terms,
    usage: u64,
    price: u64,
    sponsorship: u64,
    pays_round: bool,
) -> bool {
    if !terms.is_valid() {
        return false;
    }
    let floor = u64::from(terms.round_k)
        .saturating_mul(USAGE_SCALE / crate::BPS)
        .saturating_mul(UNPAID_HEADROOM_BPS);
    if pays_round && usage <= floor {
        return true;
    }
    let lhs = wide(terms.whole(), usage);
    let rhs = wide(
        paid_units(terms, price, sponsorship),
        u64::from(terms.round_k).saturating_mul(USAGE_SCALE),
    );
    lhs <= rhs
}

/// The close slot of a round paid at `paid_slot`: the first multiple of
/// `tick_slots` strictly after it. A round paid on a boundary closes one tick
/// later, one paid in the last slot of a tick at the next slot.
pub fn close_slot(paid_slot: u64, tick_slots: u64) -> Result<u64, Reject> {
    paid_slot
        .checked_div(tick_slots)
        .and_then(|q| q.checked_add(1))
        .and_then(|q| q.checked_mul(tick_slots))
        .ok_or(Reject::Overflow)
}

/// A paid round accepts joins while `slot < close_slot`.
pub fn accepts_joins(slot: u64, close_slot: u64) -> bool {
    slot < close_slot
}

/// The request window: `close_slot + 2 ≤ slot ≤ close_slot + t_settle_slots`.
pub fn in_request_window(slot: u64, close_slot: u64, t_settle_slots: u64) -> bool {
    let open = close_slot.saturating_add(REQUEST_DELAY_SLOTS);
    let shut = close_slot.saturating_add(t_settle_slots);
    open <= slot && slot <= shut
}

/// A paid round expires once `slot > close_slot + t_settle_slots`.
pub fn is_expired(slot: u64, close_slot: u64, t_settle_slots: u64) -> bool {
    slot > close_slot.saturating_add(t_settle_slots)
}

/// An unpaid round may be refunded from `first_slot + refund_slots`.
pub fn refund_open(slot: u64, first_slot: u64, refund_slots: u64) -> bool {
    slot >= first_slot.saturating_add(refund_slots)
}

/// The draw's cost `C = funded + request_share − min(refund, funded)`: what
/// left the round for ORAO and the requester, less what came back from
/// `round_vrf` after the request. Never above `funded + request_share`.
pub fn draw_cost(funded: u64, request_share: u64, refund: u64) -> Result<u64, Reject> {
    funded
        .checked_add(request_share)
        .and_then(|v| v.checked_sub(refund.min(funded)))
        .ok_or(Reject::Overflow)
}

/// What the tickets' prices pay: `C − min(S, C)`. Sponsorship pays first.
pub fn charged_to_prices(draw_cost: u64, sponsorship: u64) -> u64 {
    draw_cost.saturating_sub(sponsorship)
}

/// A ticket's share of the draw, `ceil((C − min(S, C)) × price / R)`. At most its prepay whenever the
/// round was paid and `C ≤ D_r` (Spec 08 §13.4, fact 1).
pub fn charge(draw_cost: u64, sponsorship: u64, prices: u64, price: u64) -> Result<u64, Reject> {
    if price > prices {
        return Err(Reject::Overflow);
    }
    if price == 0 {
        return Ok(0);
    }
    let num = u128::from(charged_to_prices(draw_cost, sponsorship))
        .checked_mul(u128::from(price))
        .ok_or(Reject::Overflow)?;
    u64::try_from(num.div_ceil(u128::from(prices))).map_err(|_| Reject::Overflow)
}

/// What a ticket's payer gets back of its prepay: `prepay − charge`.
pub fn prepay_return(prepay: u64, charge: u64) -> Result<u64, Reject> {
    prepay.checked_sub(charge).ok_or(Reject::Overflow)
}

/// What a sponsor gets back of `amount`: `floor((S − min(S, C)) × amount / S)`
/// after a draw or a forfeiture (`C = 0` for a round never requested), and the
/// whole `amount` from a round refunded or abandoned (`drawn = false`).
pub fn sponsor_return(
    draw_cost: u64,
    sponsorship: u64,
    amount: u64,
    drawn: bool,
) -> Result<u64, Reject> {
    if amount > sponsorship {
        return Err(Reject::Overflow);
    }
    if !drawn || amount == 0 {
        return Ok(amount);
    }
    let left = sponsorship.saturating_sub(draw_cost);
    let num = u128::from(left)
        .checked_mul(u128::from(amount))
        .ok_or(Reject::Overflow)?;
    let back = num
        .checked_div(u128::from(sponsorship))
        .ok_or(Reject::Overflow)?;
    u64::try_from(back).map_err(|_| Reject::Overflow)
}

/// A ticket's part of its round's books, fixed at its join and stored on its
/// `RoundTicket`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    /// Gross ticket price.
    pub price: u64,
    /// `price − protocol_share − app_share`, credited to the vault.
    pub vault_credit: u64,
    /// Net liability reserved.
    pub liability: u64,
    /// Protocol share, held until settlement.
    pub protocol_share: u64,
    /// App share, held until settlement.
    pub app_share: u64,
    /// Lamports moved to the round for the draw (`prepay`).
    pub prepay: u64,
    /// Capacity usage (`usage`).
    pub usage: u64,
}

/// A ticket's entry from what admission built and decided: the shares as
/// `risk::ticket_for` takes them, the prepay at the round's terms, and the
/// usage against the cap admission applied.
pub fn entry(
    terms: &Terms,
    ticket: &Ticket,
    admission: &Admission,
    app_share_bps: u64,
    protocol_share_bps: u64,
) -> Result<Entry, Reject> {
    let app_share = payout_table::share_of(ticket.price, app_share_bps)?;
    let protocol_share = payout_table::share_of(ticket.price, protocol_share_bps)?;
    let credit = ticket
        .price
        .checked_sub(app_share)
        .and_then(|v| v.checked_sub(protocol_share))
        .ok_or(Reject::Overflow)?;
    if credit != ticket.vault_credit
        || admission.liability != risk::liability(ticket.payout_max, credit)
    {
        return Err(Reject::Overflow);
    }
    Ok(Entry {
        price: ticket.price,
        vault_credit: credit,
        liability: admission.liability,
        protocol_share,
        app_share,
        prepay: prepay(terms, ticket.price)?,
        usage: usage(admission.liability, admission.cap)?,
    })
}

/// A round's aggregates (Spec 08 §13.2.2), as joins and sponsorship move
/// them before the draw. Nothing ever leaves a round before its end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Book {
    /// `R`: ticket prices of every ticket that joined; what the draw is charged on.
    pub prices: u64,
    /// `S`: sponsorship received.
    pub sponsorship: u64,
    /// `U`: capacity usage, `Σ usage_i`.
    pub usage: u64,
    /// Net liability reserved by the round's tickets.
    pub liability: u64,
    /// Vault credits of the round's tickets.
    pub credits: u64,
    /// Protocol shares held for the round's tickets.
    pub protocol_shares: u64,
    /// App shares held for the round's tickets.
    pub app_shares: u64,
    /// Prepays held on the round.
    pub prepaid: u64,
    /// Tickets joined.
    pub tickets: u32,
}

impl Book {
    /// The round is paid (`is_paid` on its ticket prices and sponsorship).
    pub fn is_paid(&self, terms: &Terms) -> bool {
        is_paid(terms, self.prices, self.sponsorship)
    }

    /// The capacity rule holds for the round as it stands.
    pub fn fits(&self, terms: &Terms) -> bool {
        fits(terms, self.usage, self.prices, self.sponsorship)
    }

    /// The round after a join carrying `sponsorship`, or `None` if it would
    /// break the capacity rule (`RoundCapacity`), in which case nothing moves.
    /// The join's own ticket price and sponsorship count toward the payment it is
    /// checked against, so a join sponsoring its own draw in full always fits
    /// up to `k` caps, and one that makes the round paid with a usage of at
    /// most `h · k` caps always fits (`UNPAID_HEADROOM_BPS`). Every join,
    /// paid round or not, also takes at most its own share of the round
    /// (`within_join_share`), the `h · k` floor being the paying join's
    /// only: the room other joins' prices and sponsorship bought, before the
    /// payment or after it, is no prize for cheap tickets.
    pub fn join(&self, terms: &Terms, e: &Entry, sponsorship: u64) -> Result<Option<Book>, Reject> {
        terms.checked()?;
        let after = Book {
            prices: add(self.prices, e.price)?,
            sponsorship: add(self.sponsorship, sponsorship)?,
            usage: add(self.usage, e.usage)?,
            liability: add(self.liability, e.liability)?,
            credits: add(self.credits, e.vault_credit)?,
            protocol_shares: add(self.protocol_shares, e.protocol_share)?,
            app_shares: add(self.app_shares, e.app_share)?,
            prepaid: add(self.prepaid, e.prepay)?,
            tickets: self.tickets.checked_add(1).ok_or(Reject::Overflow)?,
        };
        let pays_round = !self.is_paid(terms) && after.is_paid(terms);
        let fits = after.fits(terms)
            && within_join_share(terms, e.usage, e.price, sponsorship, pays_round);
        Ok(fits.then_some(after))
    }

    /// The round after a sponsorship of `lamports`. It only adds payment, so
    /// it never breaks the capacity rule.
    pub fn sponsor(&self, lamports: u64) -> Result<Book, Reject> {
        Ok(Book {
            sponsorship: add(self.sponsorship, lamports)?,
            ..*self
        })
    }
}

fn add(a: u64, b: u64) -> Result<u64, Reject> {
    a.checked_add(b).ok_or(Reject::Overflow)
}

fn put<const N: usize>(buf: &mut [u8; N], at: usize, bytes: &[u8]) -> usize {
    let end = at.saturating_add(bytes.len());
    if let Some(dst) = buf.get_mut(at..end) {
        dst.copy_from_slice(bytes);
    }
    end
}

/// The bytes of a round's seed, `SHA256` of which is the ORAO seed:
/// `"FADE/BEACON-SEED/v1" ‖ program ‖ round ‖ close_slot ‖ s* ‖ h*`, slots as
/// little-endian `u64`, `round` the `Round` account's address and `s*` the
/// first slot after `close_slot` in `SlotHashes`, `h*` its hash.
pub fn seed_preimage(
    program: &[u8; 32],
    round: &[u8; 32],
    close_slot: u64,
    entropy_slot: u64,
    entropy_hash: &[u8; 32],
) -> [u8; SEED_PREIMAGE_LEN] {
    let mut buf = [0u8; SEED_PREIMAGE_LEN];
    let mut at = put(&mut buf, 0, SEED_TAG);
    at = put(&mut buf, at, program);
    at = put(&mut buf, at, round);
    at = put(&mut buf, at, &close_slot.to_le_bytes());
    at = put(&mut buf, at, &entropy_slot.to_le_bytes());
    put(&mut buf, at, entropy_hash);
    buf
}

/// The bytes of a ticket's `i`-th outcome draw, hashed with `SHA256` and fed
/// to `select::reduce_word` as on the direct path (Spec 02 §6):
/// `"FADE/BEACON-OUTCOME/v1" ‖ program ‖ round ‖ ticket ‖ R ‖ i`, with `R` the
/// round's 64-byte randomness.
pub fn outcome_preimage(
    program: &[u8; 32],
    round: &[u8; 32],
    ticket: &[u8; 32],
    randomness: &[u8; 64],
    i: u8,
) -> [u8; OUTCOME_PREIMAGE_LEN] {
    let mut buf = [0u8; OUTCOME_PREIMAGE_LEN];
    let mut at = put(&mut buf, 0, OUTCOME_TAG);
    at = put(&mut buf, at, program);
    at = put(&mut buf, at, round);
    at = put(&mut buf, at, ticket);
    at = put(&mut buf, at, randomness);
    put(&mut buf, at, &[i]);
    buf
}

/// The bytes of a payout table's hash (Spec 08 §13.2.1), and how many of the
/// buffer's bytes they are: `"FADE/PAYOUT-TABLE/v1" ‖ len ‖ p₀ ‖ m₀ ‖ … ‖
/// p_{len−1} ‖ m_{len−1}`, `len` one byte, `p` and `m` little-endian `u64`.
/// `OutcomeCount` for no outcome or more than `MAX_OUTCOMES`, so that `len`
/// always fits its byte and two tables never share a preimage. Checks nothing
/// else: `payout_table::validate` does.
pub fn payout_table_preimage(
    outcomes: &[payout_table::Outcome],
) -> Result<([u8; PAYOUT_TABLE_PREIMAGE_MAX_LEN], usize), Reject> {
    if outcomes.is_empty() || outcomes.len() > crate::MAX_OUTCOMES {
        return Err(Reject::OutcomeCount);
    }
    let len = u8::try_from(outcomes.len()).map_err(|_| Reject::OutcomeCount)?;
    let mut buf = [0u8; PAYOUT_TABLE_PREIMAGE_MAX_LEN];
    let mut at = put(&mut buf, 0, PAYOUT_TABLE_TAG);
    at = put(&mut buf, at, &[len]);
    for o in outcomes {
        at = put(&mut buf, at, &o.p.to_le_bytes());
        at = put(&mut buf, at, &o.m.to_le_bytes());
    }
    Ok((buf, at))
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;
    use crate::risk::{Integrator, Params, Vault};

    /// SIMD-0437's last step: 696 lamports per byte, 128 bytes of overhead.
    const fn rent(len: u64) -> u64 {
        (len + 128) * 696
    }
    const FEE: u64 = 500_000;
    const SHARE: u64 = 50_000;
    const PENDING: u64 = rent(749);
    const FULFILLED: u64 = rent(137);
    const D: u64 = 2 * FEE + PENDING + SHARE;
    const TERMS: Terms = Terms {
        threshold: 8_640_000,
        draw_max: D,
        round_k: 1,
    };

    #[test]
    fn prefund_counts_the_pending_rent() {
        assert_eq!(PENDING, 610_392);
        assert_eq!(FULFILLED, 184_440);
        assert_eq!(prefund(FEE, PENDING, SHARE), Ok(1_660_392));
        // at today's 5 080 lamports per byte
        assert_eq!(prefund(FEE, 877 * 5_080, SHARE), Ok(5_505_160));
        assert_eq!(prefund(u64::MAX / 2 + 1, 0, 0), Err(Reject::Overflow));
        assert_eq!(prefund(u64::MAX / 2, 1, 1), Err(Reject::Overflow));
        // the request fits with one fee of margin, not with two
        assert!(request_fits(FEE, PENDING, SHARE, D));
        assert!(request_fits(2 * FEE, PENDING, SHARE, D));
        assert!(!request_fits(2 * FEE + 1, PENDING, SHARE, D));
        assert!(!request_fits(u64::MAX, 1, 0, u64::MAX));
    }

    #[test]
    fn prepay_rounds_up() {
        // 1 USDC at 8.64 USDC: 192 174.07 → 192 175
        assert_eq!(prepay(&TERMS, 1_000_000), Ok(192_175));
        assert_eq!(prepay(&TERMS, 8_640_000), Ok(D));
        assert_eq!(prepay(&TERMS, 0), Ok(0));
        let exact = Terms {
            threshold: 10,
            draw_max: 100,
            round_k: 1,
        };
        assert_eq!(prepay(&exact, 3), Ok(30));
        let bad = Terms {
            threshold: 0,
            ..TERMS
        };
        assert_eq!(prepay(&bad, 1), Err(Reject::Overflow));
        let huge = Terms {
            threshold: 1,
            draw_max: u64::MAX,
            round_k: 1,
        };
        assert_eq!(prepay(&huge, 2), Err(Reject::Overflow));
    }

    #[test]
    fn paid_by_prices_sponsorship_or_both() {
        assert!(!is_paid(&TERMS, 8_639_999, 0));
        assert!(is_paid(&TERMS, 8_640_000, 0));
        assert!(is_paid(&TERMS, 0, D));
        assert!(!is_paid(&TERMS, 0, D - 1));
        // half the draw sponsored: paid at half the threshold
        assert!(is_paid(&TERMS, 4_320_000, D / 2));
        assert!(!is_paid(&TERMS, 4_319_999, D / 2));
        // saturation never misleads the test
        assert!(is_paid(&TERMS, u64::MAX, u64::MAX));
        assert!(!is_paid(
            &Terms {
                round_k: 0,
                ..TERMS
            },
            u64::MAX,
            0
        ));
        assert_eq!(paid_units(&TERMS, u64::MAX, u64::MAX), TERMS.whole());
    }

    #[test]
    fn the_sponsorship_that_completes_a_draw_completes_it_exactly() {
        for (r, s) in [
            (0, 0),
            (1_000_000, 0),
            (6_950_000, 0),
            (4_000_000, 300_000),
            (8_640_000, 0),
            (9_000_000, 5),
        ] {
            let top = sponsorship_to_pay(&TERMS, r, s).unwrap();
            assert!(is_paid(&TERMS, r, s + top), "{r} {s}");
            if top > 0 {
                assert!(!is_paid(&TERMS, r, s + top - 1), "{r} {s}");
            }
        }
        assert_eq!(sponsorship_to_pay(&TERMS, 0, 0), Ok(D));
        assert_eq!(sponsorship_to_pay(&TERMS, 9_000_000, 0), Ok(0));
    }

    #[test]
    fn usage_rounds_up_and_is_at_most_one_cap() {
        assert_eq!(usage(0, 0), Ok(0));
        assert_eq!(usage(0, 1_000), Ok(0));
        assert_eq!(usage(1_000, 1_000), Ok(USAGE_SCALE));
        assert_eq!(usage(1, 3), Ok(333_333_334));
        assert_eq!(usage(1, u64::MAX), Ok(1));
        assert_eq!(usage(2, 1), Err(Reject::PerTicketCap));
        assert_eq!(usage(1, 0), Err(Reject::PerTicketCap));
        assert_eq!(usage(u64::MAX, u64::MAX), Ok(USAGE_SCALE));
    }

    #[test]
    fn wide_multiplication_is_exact() {
        assert_eq!(wide(0, u64::MAX), (0, 0));
        assert_eq!(wide(u128::MAX, 1), (u128::from(u64::MAX), u64::MAX));
        assert_eq!(wide(1 << 64, 3), (3, 0));
        let (h, l) = wide(u128::MAX, u64::MAX);
        // (2¹²⁸ − 1)(2⁶⁴ − 1) = 2¹⁹² − 2¹²⁸ − 2⁶⁴ + 1
        assert_eq!(h, u128::MAX - (1 << 64));
        assert_eq!(l, 1);
    }

    #[test]
    fn capacity_follows_payment() {
        // A quarter of the draw paid by ticket prices buys a quarter of the
        // cap, less the headroom an unpaid round keeps: 0.9 × 0.25.
        let quarter = TERMS.threshold / 4;
        assert!(fits(&TERMS, 225_000_000, quarter, 0));
        assert!(!fits(&TERMS, 225_000_001, quarter, 0));
        // sponsorship buys the same per lamport of draw
        assert!(fits(&TERMS, 450_000_000, quarter, D / 4));
        assert!(!fits(&TERMS, 450_000_001, quarter, D / 4));
        // a paid round has the whole cap: the headroom is gone with the refund
        assert!(fits(&TERMS, USAGE_SCALE, TERMS.threshold, 0));
        assert!(!fits(&TERMS, USAGE_SCALE + 1, TERMS.threshold, 0));
        assert!(fits(&TERMS, USAGE_SCALE, 0, D));
        // one unit short of payment holds at most 0.9 cap
        assert!(fits(&TERMS, 899_999_895, TERMS.threshold - 1, 0));
        assert!(!fits(&TERMS, 899_999_896, TERMS.threshold - 1, 0));
        // never more than k caps, however much is paid
        assert!(fits(&TERMS, USAGE_SCALE, u64::MAX, u64::MAX));
        assert!(!fits(&TERMS, USAGE_SCALE + 1, u64::MAX, u64::MAX));
        let k3 = Terms {
            round_k: 3,
            ..TERMS
        };
        assert!(fits(&k3, 3 * USAGE_SCALE, TERMS.threshold, 0));
        assert!(!fits(&k3, 3 * USAGE_SCALE + 1, TERMS.threshold, 0));
        // no usage always fits, even unpaid; extreme inputs never overflow
        assert!(fits(&TERMS, 0, 0, 0));
        assert!(!fits(&TERMS, u64::MAX, u64::MAX, u64::MAX));
        let max = Terms {
            threshold: u64::MAX,
            draw_max: u64::MAX,
            round_k: u8::MAX,
        };
        assert!(fits(&max, 255 * USAGE_SCALE, u64::MAX, 0));
        assert!(!fits(&max, 255 * USAGE_SCALE + 1, u64::MAX, u64::MAX));
        assert!(!fits(
            &Terms {
                draw_max: 0,
                ..TERMS
            },
            0,
            0,
            0
        ));
    }

    #[test]
    fn close_slot_is_the_next_tick_boundary() {
        assert_eq!(close_slot(0, 37), Ok(37));
        assert_eq!(
            close_slot(36, 37),
            Ok(37),
            "paid in a tick's last slot: closes at the next slot"
        );
        assert_eq!(
            close_slot(37, 37),
            Ok(74),
            "paid on a boundary: one tick later"
        );
        assert_eq!(close_slot(1_000, 1), Ok(1_001));
        assert_eq!(close_slot(5, 0), Err(Reject::Overflow));
        assert_eq!(close_slot(u64::MAX, 37), Err(Reject::Overflow));
        assert!(accepts_joins(73, 74));
        assert!(!accepts_joins(74, 74));
        assert!(!in_request_window(75, 74, 150));
        assert!(in_request_window(76, 74, 150));
        assert!(in_request_window(224, 74, 150));
        assert!(!in_request_window(225, 74, 150));
        assert!(!is_expired(224, 74, 150));
        assert!(is_expired(225, 74, 150));
        assert!(!refund_open(1_714, 0, 1_715));
        assert!(refund_open(1_715, 0, 1_715));
        assert!(!in_request_window(u64::MAX - 1, u64::MAX, 0));
        // Saturated bounds, the same cases as tests/ts/fade/beaconMath.test.ts
        // ("saturates its bounds at u64::MAX as fade_math does").
        const M: u64 = u64::MAX;
        assert!(in_request_window(M, M - 1, 150));
        assert!(in_request_window(M, M, 150));
        assert!(!in_request_window(M - 1, M - 1, 150));
        assert!(!in_request_window(M, M - 2, 1));
        assert!(!is_expired(M, M - 1, 150));
        assert!(!is_expired(M, M, 0));
        assert!(is_expired(M, M - 2, 1));
        assert!(refund_open(M, M - 1, 1_715));
        assert!(!refund_open(M - 1, M - 1, 1_715));
    }

    #[test]
    fn draw_cost_is_what_left_less_what_came_back() {
        let funded = FEE + PENDING;
        // fulfilled: ORAO refunds the pending rent above the fulfilled account's
        assert_eq!(draw_cost(funded, SHARE, PENDING - FULFILLED), Ok(734_440));
        // withheld: nothing comes back
        assert_eq!(draw_cost(funded, SHARE, 0), Ok(funded + SHARE));
        // stray lamports on round_vrf lower the cost, never below the share
        assert_eq!(draw_cost(funded, SHARE, u64::MAX), Ok(SHARE));
        assert_eq!(draw_cost(u64::MAX, 1, 0), Err(Reject::Overflow));
        // a pre-created request: nothing funded, the requester's share only
        assert_eq!(draw_cost(0, SHARE, 0), Ok(SHARE));
    }

    #[test]
    fn charges_round_up_and_never_exceed_the_prepay() {
        // Spec 09 §5: ten tickets of 1 USDC, a draw of 734 440
        let c = charge(734_440, 0, 10_000_000, 1_000_000).unwrap();
        assert_eq!(c, 73_444);
        assert_eq!(
            prepay_return(prepay(&TERMS, 1_000_000).unwrap(), c),
            Ok(118_731)
        );
        // the remainder after sponsorship, rounded up
        assert_eq!(charge(10, 3, 3, 1), Ok(3));
        assert_eq!(charge(10, 10, 3, 1), Ok(0));
        assert_eq!(charge(10, 20, 3, 1), Ok(0));
        assert_eq!(charge(10, 0, 3, 0), Ok(0));
        assert_eq!(charge(10, 0, 3, 4), Err(Reject::Overflow));
        assert_eq!(charge(u64::MAX, 0, u64::MAX, u64::MAX), Ok(u64::MAX));
        // a round paid at exactly the threshold, at the full prefund: charge = prepay
        let p = prepay(&TERMS, 1_000_000).unwrap();
        assert_eq!(charge(D, 0, 8_640_000, 1_000_000), Ok(p));
        assert_eq!(prepay_return(1, 2), Err(Reject::Overflow));
    }

    /// The figures of the guide's §2 and the Technical Specification's §2
    /// *Charge* row: the program bounds a ticket's draw charge by its prepay,
    /// `ceil(D_r × price / T_r)`, not by 150 bps; 150 bps is the design point
    /// of `T` at the draw cost `C` it was derived from (Spec 09 §3).
    #[test]
    fn the_charge_bound_is_the_prepay_and_150_bps_only_at_the_derivation_cost() {
        // basis points of a 0.50 USDC price at 120 USD per SOL, in hundredths
        let centi_bps = |lamports: u64| lamports * 120 * 10_000 * 100 / 500_000_000;
        let half = 500_000;
        // the threshold formula with C, not D_r: 8.64 USDC from 734 440, and
        // D_r = 1 660 392 would give 19.53
        assert_eq!(734_440 * half / 42_500, 8_640_470);
        assert_eq!(1_660_392 * half / 42_500, 19_534_023);
        // at the derivation point: the draw's share plus a 20 000 settlement
        // share is 150 bps of the minimum price
        let c = charge(734_440, 0, TERMS.threshold, half).unwrap();
        assert_eq!(c, 42_503);
        assert_eq!(centi_bps(c + 20_000), 15_000);
        // the enforced bound, the prepay: about 231 bps at the last step
        let p = prepay(&TERMS, half).unwrap();
        assert_eq!(p, 96_088);
        assert_eq!(centi_bps(p), 23_061);
        assert_eq!(charge(D, 0, TERMS.threshold, half), Ok(p));
        // a fee doubled after creation still fits the prefund, and is charged
        let doubled = 2 * FEE + FULFILLED + SHARE;
        assert!(request_fits(2 * FEE, PENDING, SHARE, D));
        assert_eq!(
            centi_bps(charge(doubled, 0, TERMS.threshold, half).unwrap()),
            17_145
        );
        // today's rent: a draw of 1 896 200 at an 8.64 threshold is 263 bps,
        // under a prepay of 765 bps; today's threshold is 22.31 USDC
        let today = Terms {
            draw_max: 5_505_160,
            ..TERMS
        };
        assert_eq!(
            centi_bps(charge(1_896_200, 0, TERMS.threshold, half).unwrap()),
            26_336
        );
        assert_eq!(centi_bps(prepay(&today, half).unwrap()), 76_460);
        assert_eq!(1_896_200 * half / 42_500, 22_308_235);
        // a fee doubled after creation at today's rent: it still fits today's
        // prefund exactly (1 000 000 + 4 455 160 + 50 000 = D_r), and its real
        // cost, 1 000 000 + 1 346 200 of locked rent + 50 000, is charged
        // about 333 bps at an 8.64 threshold, not the last step's 171
        let (today_pending, today_locked) = (4_455_160, 1_346_200);
        assert_eq!(2 * FEE + today_pending + SHARE, today.draw_max);
        assert!(request_fits(2 * FEE, today_pending, SHARE, today.draw_max));
        assert!(!request_fits(
            2 * FEE + 1,
            today_pending,
            SHARE,
            today.draw_max
        ));
        let today_doubled = 2 * FEE + today_locked + SHARE;
        assert_eq!(today_doubled, 2_396_200);
        let c = charge(today_doubled, 0, TERMS.threshold, half).unwrap();
        assert_eq!(c, 138_669);
        assert_eq!(centi_bps(c), 33_280);
        assert!(c <= prepay(&today, half).unwrap(), "within the prepay");
    }

    #[test]
    fn sponsors_are_returned_pro_rata_rounded_down() {
        // two sponsors of 600 000 and 400 000, a draw of 734 440
        assert_eq!(
            sponsor_return(734_440, 1_000_000, 600_000, true),
            Ok(159_336)
        );
        assert_eq!(
            sponsor_return(734_440, 1_000_000, 400_000, true),
            Ok(106_224)
        );
        // a draw costing more than the sponsorship takes all of it
        assert_eq!(sponsor_return(734_440, 500_000, 500_000, true), Ok(0));
        // refunded or abandoned: all of it
        assert_eq!(
            sponsor_return(734_440, 500_000, 500_000, false),
            Ok(500_000)
        );
        // forfeited before any request: C = 0
        assert_eq!(sponsor_return(0, 500_000, 200_000, true), Ok(200_000));
        assert_eq!(sponsor_return(0, 1, 2, true), Err(Reject::Overflow));
        assert_eq!(sponsor_return(1, 3, 1, true), Ok(0));
    }

    fn admitted(
        vault: &Vault,
        price: u64,
        max_m: u64,
        app_share_bps: u64,
        margin: u64,
    ) -> (Ticket, Admission) {
        let p = Params {
            min_price: 100_000,
            ..Params::SPEC
        };
        let w = risk::ticket_for(price, max_m, app_share_bps, &p).unwrap();
        let a = risk::admit(
            vault,
            &Integrator {
                reserved: 0,
                volume_total: 0,
            },
            &p,
            &w,
            margin,
            false,
        )
        .unwrap();
        (w, a)
    }

    #[test]
    fn entry_takes_admissions_figures() {
        let vault = Vault {
            assets: 100_000_000_000,
            reserved: 0,
            open_credits: 0,
        };
        let (w, a) = admitted(&vault, 1_000_000, 100_000, 50, 280);
        let e = entry(&TERMS, &w, &a, 50, 20).unwrap();
        assert_eq!(e.protocol_share, 2_000);
        assert_eq!(e.app_share, 5_000);
        assert_eq!(e.vault_credit, 993_000);
        assert_eq!(e.liability, 9_007_000);
        assert_eq!(a.cap, 1_400_000_000);
        assert_eq!(e.usage, 6_433_572); // ceil(9 007 000 × 10⁹ / 1.4 × 10⁹)
        assert_eq!(e.prepay, 192_175);
        // figures that do not agree with each other are refused
        assert_eq!(entry(&TERMS, &w, &a, 60, 20), Err(Reject::Overflow));
    }

    fn e(price: u64, usage: u64) -> Entry {
        Entry {
            price,
            vault_credit: price - price / 100,
            liability: usage,
            protocol_share: price / 500,
            app_share: price / 100 - price / 500,
            prepay: prepay(&TERMS, price).unwrap(),
            usage,
        }
    }

    #[test]
    fn a_join_that_does_not_fit_is_refused_and_one_carrying_sponsorship_fits() {
        let b = Book::default();
        // 1 USDC buys 1/8.64 of the cap
        let small = USAGE_SCALE / 8;
        assert_eq!(b.join(&TERMS, &e(1_000_000, small), 0), Ok(None));
        // 1 USDC buys 0.9 / 8.64 of the cap unpaid: 104 166 666
        assert_eq!(b.join(&TERMS, &e(1_000_000, 104_166_667), 0), Ok(None));
        let ok = b
            .join(&TERMS, &e(1_000_000, 104_166_666), 0)
            .unwrap()
            .unwrap();
        assert_eq!(ok.tickets, 1);
        assert!(!ok.is_paid(&TERMS));
        // the same ticket, its draw fully sponsored in the join
        let sponsored = b
            .join(&TERMS, &e(1_000_000, USAGE_SCALE), D)
            .unwrap()
            .unwrap();
        assert!(sponsored.is_paid(&TERMS));
        assert_eq!(b.sponsor(D).unwrap().sponsorship, D);
    }

    #[test]
    fn ten_tickets_of_one_usdc_pay_their_draw_and_get_the_rest_back() {
        // Spec 09 §5's example at the corrected prefund
        let mut b = Book::default();
        for i in 1..=10 {
            b = b.join(&TERMS, &e(1_000_000, 0), 0).unwrap().unwrap();
            // paid by the ninth (9 ≥ 8.64); the tenth joins before the tick
            assert_eq!(b.is_paid(&TERMS), i >= 9);
        }
        assert_eq!(b.prepaid, 1_921_750);
        let cost = draw_cost(FEE + PENDING, SHARE, PENDING - FULFILLED).unwrap();
        let ch = charge(cost, 0, b.prices, 1_000_000).unwrap();
        assert_eq!((ch, prepay_return(192_175, ch).unwrap()), (73_444, 118_731));
        // ten charges of 73 444 are the draw to the lamport: no dust
        assert_eq!(b.prepaid - cost - 10 * 118_731, 0);
    }

    #[test]
    fn a_lone_ticket_sponsored_in_its_join_is_paid_and_carries_a_full_cap() {
        // 0.10 USDC at a whole per-ticket cap, its draw sponsored by the integrator
        let ticket = e(100_000, USAGE_SCALE);
        let top = sponsorship_to_pay(&TERMS, 100_000, 0).unwrap();
        let b = Book::default().join(&TERMS, &ticket, top).unwrap().unwrap();
        assert!(b.is_paid(&TERMS));
        assert_eq!(
            Book::default().join(&TERMS, &ticket, top - 1).unwrap(),
            None
        );
        // its charge is the draw less the sponsorship, which covers almost all of it
        let ch = charge(734_440, top, b.prices, 100_000).unwrap();
        assert!(ch <= ticket.prepay);
    }

    /// The audit's saturation attack (15 October 2026): one ticket of 1.40
    /// USDC and one lamport less than the sponsorship that pays the round,
    /// using as much of the cap as the round admits unpaid. Before the
    /// headroom, that was 999 999 397 of `USAGE_SCALE`, and every honest join
    /// was then refused, the one paying the round included, until the
    /// attacker refunded everything. Now the round holds at most 0.9 cap, and
    /// any join that pays it with up to 0.1 cap fits.
    #[test]
    fn an_unpaid_round_keeps_room_for_the_join_that_pays_it() {
        let price = 1_400_000;
        let sp = sponsorship_to_pay(&TERMS, price, 0).unwrap() - 1;
        assert!(!is_paid(&TERMS, price, sp));
        assert!(is_paid(&TERMS, price, sp + 1));
        // the largest usage the attacker's ticket can take
        let (mut lo, mut hi) = (0u64, USAGE_SCALE);
        while lo < hi {
            let mid = lo + (hi - lo).div_ceil(2);
            if fits(&TERMS, mid, price, sp) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        assert!(lo < 900_000_000, "unpaid usage {lo}");
        assert!(!fits(&TERMS, 999_999_397, price, sp));
        let attacker = Entry {
            usage: lo,
            ..e(price, lo)
        };
        let round = Book::default()
            .join(&TERMS, &attacker, sp)
            .unwrap()
            .unwrap();
        assert!(!round.is_paid(&TERMS));
        // an honest 0.50 USDC ticket that pays the round, at 1 % and at 10 %
        // of its cap, bare: the round becomes paid and nothing is refundable
        for usage in [USAGE_SCALE / 100, USAGE_SCALE / 10] {
            let honest = round.join(&TERMS, &e(500_000, usage), 0).unwrap().unwrap();
            assert!(honest.is_paid(&TERMS));
        }
        // a join that does not pay it is held to the unpaid bound
        let small = round.join(&TERMS, &e(1, 1_000), 0).unwrap();
        assert_eq!(small, None);
    }

    /// The second final audit, item 2 (17 October 2026): honest prices pay a
    /// round, then one ticket at the minimum price, sized to the room left,
    /// takes all of it, sending every later join of the tick to a new unpaid
    /// round. Before the per-join share, a paid round checked only `U ≤ k`,
    /// so that ticket fitted for the edge on 0.50 USDC. Now every join takes
    /// at most `k · its paid share`, the join paying the round at least
    /// `h · k`: the room left goes to joins that pay for it, before the
    /// payment as after it.
    #[test]
    fn filling_a_paid_round_costs_its_payment_not_one_ticket() {
        let mut paid = Book::default();
        for _ in 0..9 {
            paid = paid.join(&TERMS, &e(1_000_000, 0), 0).unwrap().unwrap();
        }
        assert!(paid.is_paid(&TERMS));
        let rest = u64::from(TERMS.round_k) * USAGE_SCALE - paid.usage;
        // the whole room left, on 0.50 USDC: refused
        assert_eq!(paid.join(&TERMS, &e(500_000, rest), 0), Ok(None));
        // the floor, h · k caps, is not a paid round's: 0.50 USDC is 5.8 %
        // of T_r, and that is its share
        let floor = USAGE_SCALE / 10;
        assert_eq!(paid.join(&TERMS, &e(500_000, floor), 0), Ok(None));
        let own = USAGE_SCALE * 500_000 / TERMS.threshold;
        assert!(paid.join(&TERMS, &e(500_000, own), 0).unwrap().is_some());
        assert_eq!(paid.join(&TERMS, &e(500_000, own + 1), 0), Ok(None));
        // its own share: 4.32 USDC is half of T_r, so half of the k caps
        let half = USAGE_SCALE / 2;
        assert!(paid.join(&TERMS, &e(4_320_000, half), 0).unwrap().is_some());
        assert_eq!(paid.join(&TERMS, &e(4_320_000, half + 1), 0), Ok(None));
        // or the draw it pays itself: a whole D_r of sponsorship buys k caps
        assert!(paid.join(&TERMS, &e(500_000, rest), D).unwrap().is_some());
        assert!(within_join_share(&TERMS, half, 0, D / 2, false));
        assert!(!within_join_share(&TERMS, half + 1, 0, D / 2, false));
        assert!(within_join_share(&TERMS, half, 4_320_000, 0, false));
        // the floor is the paying join's
        assert!(!within_join_share(&TERMS, floor, 500_000, 0, false));
        assert!(within_join_share(&TERMS, floor, 500_000, 0, true));
        assert!(!within_join_share(&TERMS, floor + 1, 500_000, 0, true));

        // The join that makes a round paid is held to the same share: eight
        // honest tickets, then one completing the payment with 0.64 USDC.
        let mut nearly = Book::default();
        for _ in 0..8 {
            nearly = nearly.join(&TERMS, &e(1_000_000, 0), 0).unwrap().unwrap();
        }
        assert!(!nearly.is_paid(&TERMS));
        let completing = TERMS.threshold - nearly.prices;
        assert_eq!(nearly.join(&TERMS, &e(completing, rest), 0), Ok(None));
        let landed = nearly
            .join(&TERMS, &e(completing, floor), 0)
            .unwrap()
            .unwrap();
        assert!(landed.is_paid(&TERMS));
    }

    /// The final audit, fourth pass (17 October 2026): the per-join share held
    /// only for joins leaving a round paid, so a join made one slot before
    /// the payment took the room other joins' prices bought. Seven honest
    /// 1 USDC tickets at 0.01 cap each; a 0.50 USDC long shot at 0.711 caps
    /// fitted the unpaid bound `0.9 · k · (R + p)/T_r`, and the next honest
    /// join paid the round with 0.83 caps used. Now every join is held to
    /// `k · its own share`, paid round or not, the join paying the round to
    /// at least `h · k`.
    #[test]
    fn a_join_before_the_payment_takes_only_its_own_share() {
        let honest_usage = USAGE_SCALE / 100;
        let mut round = Book::default();
        for _ in 0..7 {
            round = round
                .join(&TERMS, &e(1_000_000, honest_usage), 0)
                .unwrap()
                .unwrap();
        }
        assert!(!round.is_paid(&TERMS));
        let attack = 711_000_000;
        let p = 500_000;
        // the unpaid bound alone admits it: this is the audit's ticket
        assert!(fits(&TERMS, round.usage + attack, round.prices + p, 0));
        assert!(!is_paid(&TERMS, round.prices + p, 0));
        assert_eq!(round.join(&TERMS, &e(p, attack), 0), Ok(None));
        // 0.50 USDC is 5.8 % of T_r, and the round stays unpaid: that is
        // its share, the floor h · k being the paying join's
        let floor = USAGE_SCALE / 10;
        assert_eq!(round.join(&TERMS, &e(p, floor), 0), Ok(None));
        let own = USAGE_SCALE * p / TERMS.threshold;
        assert!(round.join(&TERMS, &e(p, own), 0).unwrap().is_some());
        assert_eq!(round.join(&TERMS, &e(p, own + 1), 0), Ok(None));
        // the room bought by sponsorship is no prize either: 80 % of D_r
        // sponsored by a third party, then the same long shot bare
        let sponsored = Book::default().sponsor(D / 10 * 8).unwrap();
        assert!(!sponsored.is_paid(&TERMS));
        assert!(fits(&TERMS, attack, p, D / 10 * 8));
        assert_eq!(sponsored.join(&TERMS, &e(p, attack), 0), Ok(None));
        // a join paying for its own room still takes it in an unpaid round
        let own = Book::default()
            .join(&TERMS, &e(4_320_000, 450_000_000), 0)
            .unwrap()
            .unwrap();
        assert!(!own.is_paid(&TERMS));
        // and the honest join that pays the round finds the room the
        // attacker did not take
        let paid = round
            .join(&TERMS, &e(1_640_000, honest_usage), 0)
            .unwrap()
            .unwrap();
        assert!(paid.is_paid(&TERMS));
        assert!(paid
            .join(&TERMS, &e(4_320_000, USAGE_SCALE / 2), 0)
            .unwrap()
            .is_some());
    }

    /// The re-audit of 24 October 2026: with the `h · k` floor every join's,
    /// `1/h` = 10 minimum-price long shots, each at exactly `h · k` caps,
    /// filled a paid round for 1 USDC of ticket prices, about an eighth of
    /// the 8.24 USDC its room costs at the round's rate, and sent every
    /// later join of the tick to a new unpaid round. The floor is now the
    /// paying join's only: in a paid round each long shot is held to its own
    /// share, and filling the round's room costs about its payment. Figures
    /// of a 70 000 USDC vault at 2.8 %, a per-ticket cap of 980 USDC.
    #[test]
    fn minimum_price_joins_at_the_floor_cannot_fill_a_paid_round() {
        let cap: u64 = 980_000_000;
        let honest = |price: u64, liability: u64| Entry {
            usage: usage(liability, cap).unwrap(),
            liability,
            ..e(price, 0)
        };
        let mut a = Book::default();
        for _ in 0..9 {
            a = a
                .join(&TERMS, &honest(1_000_000, 5_000_000), 0)
                .unwrap()
                .unwrap();
        }
        assert!(a.is_paid(&TERMS));
        let min_price = 100_000;
        let attacker = honest(min_price, cap / 10);
        assert_eq!(attacker.usage, USAGE_SCALE / 10, "exactly h · k caps");
        // refused: its own share is 0.10 / 8.64 of the cap, 1.16 %
        assert_eq!(a.join(&TERMS, &attacker, 0), Ok(None));
        let own = USAGE_SCALE * min_price / TERMS.threshold;
        let within = Entry {
            usage: own,
            ..attacker
        };
        assert!(a.join(&TERMS, &within, 0).unwrap().is_some());
        let over = Entry {
            usage: own + 1,
            ..attacker
        };
        assert_eq!(a.join(&TERMS, &over, 0), Ok(None));
        // minimum-price joins at their own share: filling the room left
        // costs about its payment, not one draw divided by 1/h
        let start = a.usage;
        let mut n = 0u64;
        while let Some(next) = a.join(&TERMS, &within, 0).unwrap() {
            a = next;
            n += 1;
        }
        let spent = n * min_price;
        let fair =
            u128::from(a.usage - start) * u128::from(TERMS.threshold) / u128::from(USAGE_SCALE);
        assert!(u128::from(spent) >= fair, "{spent} paid for {fair}");
        // the same long shot still fits as the join that pays a round
        let mut nearly = Book::default();
        for _ in 0..8 {
            nearly = nearly
                .join(&TERMS, &honest(1_000_000, 5_000_000), 0)
                .unwrap()
                .unwrap();
        }
        let pays = honest(TERMS.threshold - nearly.prices, cap / 10);
        let landed = nearly.join(&TERMS, &pays, 0).unwrap().unwrap();
        assert!(landed.is_paid(&TERMS));
        // and no later floor-sized join takes the room it left
        assert_eq!(landed.join(&TERMS, &attacker, 0), Ok(None));
    }

    #[test]
    fn seed_and_outcome_preimages() {
        let s = seed_preimage(&[1; 32], &[2; 32], 74, 75, &[3; 32]);
        assert_eq!(&s[..19], SEED_TAG);
        assert_eq!(&s[19..51], &[1; 32]);
        assert_eq!(&s[51..83], &[2; 32]);
        assert_eq!(&s[83..91], &74u64.to_le_bytes());
        assert_eq!(&s[91..99], &75u64.to_le_bytes());
        assert_eq!(&s[99..], &[3; 32]);
        let o = outcome_preimage(&[1; 32], &[2; 32], &[4; 32], &[5; 64], 7);
        assert_eq!(&o[..22], OUTCOME_TAG);
        assert_eq!(&o[22..54], &[1; 32]);
        assert_eq!(&o[54..86], &[2; 32]);
        assert_eq!(&o[86..118], &[4; 32]);
        assert_eq!(&o[118..182], &[5; 64]);
        assert_eq!(o[182], 7);
        // two rounds closing on one slot never share a seed
        assert_ne!(
            seed_preimage(&[1; 32], &[2; 32], 74, 75, &[3; 32]),
            seed_preimage(&[1; 32], &[9; 32], 74, 75, &[3; 32])
        );
    }

    #[test]
    fn payout_table_preimage_layout_and_bounds() {
        use payout_table::Outcome;
        let t = [Outcome { p: 3, m: 4 }, Outcome { p: u64::MAX, m: 9 }];
        let (b, n) = payout_table_preimage(&t).unwrap();
        assert_eq!(n, 20 + 1 + 32);
        assert_eq!(&b[..20], PAYOUT_TABLE_TAG);
        assert_eq!(b[20], 2);
        assert_eq!(&b[21..29], &3u64.to_le_bytes());
        assert_eq!(&b[29..37], &4u64.to_le_bytes());
        assert_eq!(&b[37..45], &u64::MAX.to_le_bytes());
        assert_eq!(&b[45..53], &9u64.to_le_bytes());
        assert!(b[53..].iter().all(|&x| x == 0));
        let full = [Outcome { p: 1, m: 1 }; crate::MAX_OUTCOMES];
        assert_eq!(
            payout_table_preimage(&full).unwrap().1,
            PAYOUT_TABLE_PREIMAGE_MAX_LEN
        );
        assert_eq!(payout_table_preimage(&[]), Err(Reject::OutcomeCount));
        let over = [Outcome { p: 1, m: 1 }; crate::MAX_OUTCOMES + 1];
        assert_eq!(payout_table_preimage(&over), Err(Reject::OutcomeCount));
        // the order of the outcomes is part of the table
        let (r, _) = payout_table_preimage(&[t[1], t[0]]).unwrap();
        assert_ne!(b, r);
    }
}
