//! The shared beacon's arithmetic (a design the program does not carry yet): what a round prefunds and
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
//! round's end (there is no cancellation), so every aggregate
//! only grows until the draw, and so do the paid fraction and the capacity it
//! buys: the capacity rule checked at each join holds for good.

use crate::risk::{self, Admission, Ticket};
use crate::{payout_table, Reject};

/// Fixed point of a ticket's capacity usage: `USAGE_SCALE` is a whole per-ticket
/// cap. A ticket admitted by `risk::admit` uses at most this much.
pub const USAGE_SCALE: u64 = 1_000_000_000;

/// Domain tag of a round's ORAO seed.
pub const SEED_TAG: &[u8; 19] = b"FADE/BEACON-SEED/v1";
/// Domain tag of a beacon ticket's outcome.
pub const OUTCOME_TAG: &[u8; 22] = b"FADE/BEACON-OUTCOME/v1";
/// Bytes hashed into a round's seed: tag, program, round, close slot, `s*`, `h*`.
pub const SEED_PREIMAGE_LEN: usize = 19 + 32 + 32 + 8 + 8 + 32;
/// Bytes hashed into a ticket's outcome: tag, program, round, ticket, the
/// 64-byte randomness, the draw index.
pub const OUTCOME_PREIMAGE_LEN: usize = 22 + 32 + 32 + 32 + 64 + 1;
/// Slots between a round's close and the earliest request of its draw: the
/// seed needs the first slot after the close in `SlotHashes`.
pub const REQUEST_DELAY_SLOTS: u64 = 2;

/// What a round snapshots at its creation and runs on.
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

/// The capacity rule: `U × T_r × D_r ≤ k × USAGE_SCALE × min(T_r × D_r, R ×
/// D_r + S × T_r)`, i.e. `Σ L_i / cap_i ≤ k · min(1, R/T_r + S/D_r)` without a
/// division, `U` being the round's total usage. Exact for every `u64` input.
pub fn fits(terms: &Terms, usage_total: u64, prices: u64, sponsorship: u64) -> bool {
    if !terms.is_valid() {
        return false;
    }
    let k_scale = u64::from(terms.round_k).saturating_mul(USAGE_SCALE);
    let lhs = wide(terms.whole(), usage_total);
    let rhs = wide(paid_units(terms, prices, sponsorship), k_scale);
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
/// round was paid and `C ≤ D_r`.
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

/// A round's aggregates, as joins and sponsorship move
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
    /// up to `k` caps.
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
        Ok(after.fits(terms).then_some(after))
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
        // A quarter of the draw paid by ticket prices buys a quarter of the cap.
        let quarter = TERMS.threshold / 4;
        assert!(fits(&TERMS, USAGE_SCALE / 4, quarter, 0));
        assert!(!fits(&TERMS, USAGE_SCALE / 4 + 1, quarter, 0));
        // sponsorship buys the same per lamport of draw
        assert!(fits(&TERMS, USAGE_SCALE / 2, quarter, D / 4));
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
        // Ten tickets of 1 USDC, a draw of 734 440
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
        let ok = b
            .join(&TERMS, &e(1_000_000, small - 10_000_000), 0)
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
        // The worked example at the corrected prefund
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
}
