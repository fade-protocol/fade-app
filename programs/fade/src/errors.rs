//! Error codes. Append-only once deployed: a retired variant keeps its slot.

use anchor_lang::prelude::*;
use fade_math::Reject;

#[error_code]
pub enum FadeError {
    // --- governance ---------------------------------------------------------
    #[msg("signer is not the program's upgrade authority")]
    NotUpgradeAuthority, // 6000
    #[msg("parameters are out of range")]
    InvalidParams, // 6001
    #[msg("this operation is paused")]
    Paused, // 6002
    #[msg("signer is not the council")]
    NotCouncil, // 6003
    #[msg("signer is neither the council nor the guardian")]
    NotGuardian, // 6004
    #[msg("the guardian may only set pause flags, never clear them")]
    GuardianCannotUnpause, // 6005
    #[msg("no parameter change is pending")]
    NoPendingChange, // 6006
    #[msg("the pending parameter change is not due yet")]
    ChangeNotDue, // 6007

    // --- tokens and arithmetic ----------------------------------------------
    #[msg("wrong mint")]
    WrongMint, // 6008
    #[msg("arithmetic overflow")]
    MathOverflow, // 6009
    #[msg("amount must be non-zero")]
    ZeroAmount, // 6010
    #[msg("unexpected remaining accounts")]
    RemainingAccounts, // 6011

    // --- admission (mirrors fade_math::Reject) ---------------------------------
    #[msg("payout table: zero outcomes or more than 32")]
    OutcomeCount, // 6012
    #[msg("payout table: a probability of zero or above 1")]
    ProbabilityRange, // 6013
    #[msg("payout table: probabilities do not sum to exactly 1")]
    ProbabilitySum, // 6014
    #[msg("payout table: a multiplier above 10 000x")]
    MultiplierCeiling, // 6015
    #[msg("payout table: pays out more than it takes in on average")]
    PayoutTableOverpays, // 6016
    #[msg("payout table margin does not cover the vault margin floor plus the protocol and app shares")]
    MarginFloor, // 6017
    #[msg("app share above the maximum")]
    AppShareTooHigh, // 6018
    #[msg("ticket price below the minimum or above the maximum")]
    PriceBounds, // 6019
    #[msg("worst-case payout above the per-ticket cap")]
    PerTicketCap, // 6020
    #[msg("integrator exposure above its ceiling")]
    IntegratorCap, // 6021
    #[msg("utilisation breaker: the vault is too committed")]
    UtilisationBreaker, // 6022
    #[msg("reserved liability would exceed kappa of assets")]
    GlobalExposure, // 6023
    #[msg("the vault could not pay every open ticket at once")]
    Insolvent, // 6024
    #[msg("drawdown breaker: the share price fell too far in 24 hours")]
    DrawdownBreaker, // 6025

    // --- tickets ---------------------------------------------------------------
    #[msg("ticket nonce must equal the integrator's next nonce")]
    WrongNonce, // 6026
    #[msg("this integrator is paused")]
    IntegratorPaused, // 6027
    #[msg("share account differs from the integrator record")]
    ShareAccountMismatch, // 6028
    #[msg("the ticket is not in the state this instruction needs")]
    WrongTicketStatus, // 6029
    #[msg("randomness may only be requested from two slots after the open until T_SETTLE")]
    RequestWindow, // 6030
    #[msg("SlotHashes holds no slot after the open")]
    EntropyUnavailable, // 6031
    #[msg("ORAO network state could not be read")]
    NetworkStateUnreadable, // 6032
    #[msg("treasury does not match ORAO network state")]
    TreasuryMismatch, // 6033
    #[msg("randomness account is not the one bound to this ticket")]
    WrongRandomnessAccount, // 6034
    #[msg("randomness is not fulfilled")]
    NotFulfilled, // 6035
    #[msg("randomness is fulfilled: settle, do not expire")]
    AlreadyFulfilled, // 6036
    #[msg("T_SETTLE has not elapsed")]
    NotExpired, // 6037
    #[msg("no outcome could be drawn")]
    DrawFailed, // 6038
    #[msg("beneficiary differs from the one stored at open")]
    BeneficiaryMismatch, // 6039

    // --- liquidity providers ------------------------------------------------------
    #[msg("no epoch is live")]
    NoLiveEpoch, // 6040
    #[msg("the epoch has not closed yet")]
    EpochNotClosed, // 6041
    #[msg("a ticket opened before the close is still open")]
    StrikeNotClean, // 6042
    #[msg("request below the minimum")]
    BelowMinimum, // 6043
    #[msg("a first deposit must be at least min_first_deposit")]
    FirstDepositTooSmall, // 6044
    #[msg("a top-level instruction of this transaction is not allowed with a request")]
    ForbiddenComposition, // 6045
    #[msg("the record does not belong to this request's epoch or chain")]
    WrongRecord, // 6046
    #[msg("the epoch record of the request's entry is required")]
    EntryRecordRequired, // 6047
    #[msg("the account that advanced the record's rent is required")]
    RentReceiverRequired, // 6048
    #[msg("nothing to claim yet")]
    NothingToClaim, // 6049
    #[msg("wrong owner")]
    WrongOwner, // 6050
    #[msg("the request's epoch has not been struck")]
    NotStruck, // 6051
    #[msg("this request opens an epoch: the vault account is required")]
    VaultRequired, // 6052
    #[msg("the owner's token account cannot receive yet")]
    DestinationUnusable, // 6053

    // --- shared beacon (Spec 08 §13.6) -------------------------------------------
    #[msg("the round is neither the accepting round nor the next one")]
    WrongRound, // 6054
    #[msg("the round accepts no more sponsorship")]
    RoundNotAccepting, // 6055
    #[msg("the round's liability would exceed what its paid share of the draw allows")]
    RoundCapacity, // 6056
    #[msg("the round's draw is paid: no refund")]
    RoundPaid, // 6057
    #[msg("the round is not in the state this instruction needs")]
    WrongRoundStatus, // 6058
    #[msg("the round's refund window has not opened")]
    RefundWindow, // 6059
    #[msg("a round's draw may only be requested from two slots after its close until T_SETTLE")]
    RoundRequestWindow, // 6060
    #[msg("the live draw cost exceeds the round's prefund")]
    DrawUnderfunded, // 6061
    #[msg("the payout table account does not match its hash or the ticket")]
    WrongPayoutTable, // 6062
    /// Never returned: there is no cancellation (Spec 08 §13.10 point 4). The
    /// slot is kept so that the codes after it do not move.
    #[msg("unused: kept so that the codes after it do not move")]
    NotCanceller, // 6063
    #[msg("an integrator's first ticket must name its share account")]
    ShareAccountRequired, // 6064
    #[msg("the settlement accounts do not follow the ticket layout")]
    MalformedBatch, // 6065
    #[msg("a round counted before the epoch's close takes no join at or after that close")]
    RoundEpochClosed, // 6066
    #[msg("only a participant of the round, shown by its ticket, may refund it")]
    NotRoundParticipant, // 6067
    #[msg("the entropy was never recorded and SlotHashes no longer proves it")]
    EntropyUnrecorded, // 6068
    #[msg("SlotHashes still proves the ticket's entropy: record it and expire the ticket")]
    EntropyStillProven, // 6069
}

impl From<Reject> for FadeError {
    fn from(r: Reject) -> Self {
        match r {
            Reject::OutcomeCount => FadeError::OutcomeCount,
            Reject::ProbabilityRange => FadeError::ProbabilityRange,
            Reject::ProbabilitySum => FadeError::ProbabilitySum,
            Reject::MultiplierCeiling => FadeError::MultiplierCeiling,
            Reject::PayoutTableOverpays => FadeError::PayoutTableOverpays,
            Reject::MarginFloor => FadeError::MarginFloor,
            Reject::AppShare => FadeError::AppShareTooHigh,
            Reject::PriceBounds => FadeError::PriceBounds,
            Reject::PerTicketCap => FadeError::PerTicketCap,
            Reject::IntegratorCap => FadeError::IntegratorCap,
            Reject::UtilisationBreaker => FadeError::UtilisationBreaker,
            Reject::GlobalExposure => FadeError::GlobalExposure,
            Reject::Insolvent => FadeError::Insolvent,
            Reject::Overflow => FadeError::MathOverflow,
            Reject::EpochClosed => FadeError::RoundEpochClosed,
        }
    }
}

/// `?`-friendly conversion of a `fade_math` result.
pub trait OrFade<T> {
    fn or_fade(self) -> Result<T>;
}

impl<T> OrFade<T> for core::result::Result<T, Reject> {
    fn or_fade(self) -> Result<T> {
        self.map_err(|r| error!(FadeError::from(r)))
    }
}

impl<T> OrFade<T> for Option<T> {
    fn or_fade(self) -> Result<T> {
        self.ok_or_else(|| error!(FadeError::MathOverflow))
    }
}
