//! Fade's arithmetic, in one place and with nothing else in it.
//!
//! Every quantity is an integer in a fixed unit: probabilities in 1e-9
//! (`P_SCALE`), multipliers and shares in basis points (`BPS`), amounts in the
//! token's base unit (micro-USDC). All intermediate products are `u128`, every
//! operation is checked, and rounding always goes against the party that could
//! exploit it: the vault never pays a lamport more than the payout table promised,
//! and a share is never minted for value that was not deposited.
#![no_std]
#![forbid(unsafe_code)]
#![deny(
    clippy::float_arithmetic,
    clippy::arithmetic_side_effects,
    missing_docs
)]

pub mod beacon;
pub mod drawdown;
pub mod epoch;
pub mod orao_layout;
pub mod payout_table;
pub mod risk;
pub mod select;
pub mod shares;
pub mod slot_hashes;

/// Probabilities are fixed point with this denominator: `p = 1e9` is certainty.
pub const P_SCALE: u64 = 1_000_000_000;
/// Basis points: `10_000` is 1× (multipliers) or 100 % (shares, caps).
pub const BPS: u64 = 10_000;
/// Largest multiplier an outcome may declare, in basis points (10 000×).
pub const M_CEILING_BPS: u64 = 10_000 * BPS;
/// Largest number of outcomes in a payout table.
pub const MAX_OUTCOMES: usize = 32;
/// Smallest share of the ticket price the vault must earn in expectation, in bps.
/// A payout table's margin must cover this plus the protocol and app shares.
pub const MIN_VAULT_MARGIN_BPS: u64 = 100;
/// Protocol share, taken from the ticket price at open, in bps.
pub const PROTOCOL_SHARE_BPS: u64 = 20;
/// Largest app share an integrator may set on a ticket, in bps.
pub const MAX_APP_SHARE_BPS: u64 = 500;

/// Why a value was rejected. Stable numbering: the program maps these to error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    /// Zero outcomes or more than `MAX_OUTCOMES`.
    OutcomeCount,
    /// A probability of zero or above `P_SCALE`.
    ProbabilityRange,
    /// Probabilities do not sum to exactly `P_SCALE`.
    ProbabilitySum,
    /// A multiplier above `M_CEILING_BPS`.
    MultiplierCeiling,
    /// Expected return above `1 − margin`: the payout table pays out more than it takes in.
    PayoutTableOverpays,
    /// The payout table's margin does not cover the vault margin floor plus the protocol and app shares.
    MarginFloor,
    /// App share above the maximum.
    AppShare,
    /// Ticket price below the minimum or above the maximum.
    PriceBounds,
    /// Worst-case payout above the per-ticket cap.
    PerTicketCap,
    /// Integrator's aggregate exposure would exceed its ceiling.
    IntegratorCap,
    /// Utilisation after this ticket would exceed the admission breaker.
    UtilisationBreaker,
    /// Reserved liability after this ticket would exceed κ · assets.
    GlobalExposure,
    /// The vault could not pay every open ticket's maximum at once.
    Insolvent,
    /// Arithmetic overflow (never expected with in-range inputs; a bug if hit).
    Overflow,
    /// A join into a group counted before the live epoch's close, at or
    /// after that close (`epoch::Counters::join_n`).
    EpochClosed,
}
