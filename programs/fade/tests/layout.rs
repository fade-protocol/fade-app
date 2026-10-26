//! Account sizes and error codes are part of the program's interface: a client,
//! an indexer or a later version of the program depends on them. Changing one is
//! deliberate, and this test makes it visible.

use anchor_lang::{AccountSerialize, Space};
use fade::errors::FadeError;
use fade::state::*;

#[test]
fn account_sizes_are_pinned() {
    let sizes = [
        ("Config", 8 + Config::INIT_SPACE),
        ("Vault", 8 + Vault::INIT_SPACE),
        ("Queue", 8 + Queue::INIT_SPACE),
        ("EpochRecord", 8 + EpochRecord::INIT_SPACE),
        ("DepositRequest", 8 + DepositRequest::INIT_SPACE),
        ("WithdrawRequest", 8 + WithdrawRequest::INIT_SPACE),
        ("Integrator", 8 + Integrator::INIT_SPACE),
        ("Ticket", 8 + Ticket::INIT_SPACE),
    ];
    for (name, size) in sizes {
        eprintln!("{name}: {size} bytes");
    }
    assert_eq!(
        sizes.map(|(_, s)| s),
        PINNED,
        "an account layout changed: update PINNED and Spec 08 §2"
    );
}

// Config grew from 695 to 791 bytes with the beacon's six parameters, appended
// to RiskParams twice (Spec 08 §13.2.6): its layout version is 2.
const PINNED: [usize; 8] = [791, 606, 272, 210, 67, 115, 179, 859];

#[test]
fn error_codes_are_pinned() {
    let code = |e: FadeError| 6000 + e as u32;
    assert_eq!(code(FadeError::NotUpgradeAuthority), 6000);
    assert_eq!(code(FadeError::PerTicketCap), 6020);
    assert_eq!(code(FadeError::DrawdownBreaker), 6025);
    assert_eq!(code(FadeError::WrongRandomnessAccount), 6034);
    assert_eq!(code(FadeError::StrikeNotClean), 6042);
    assert_eq!(code(FadeError::ForbiddenComposition), 6045);
    assert_eq!(code(FadeError::VaultRequired), 6052);
    assert_eq!(code(FadeError::DestinationUnusable), 6053);
}

/// The beacon's accounts (Spec 08 §13.2), and the rent each costs at
/// SIMD-0437's last step: 696 lamports per byte with 128 bytes of overhead.
#[test]
fn beacon_account_sizes_are_pinned() {
    let sizes = [
        ("PayoutTable", 8 + PayoutTable::INIT_SPACE, 579, 492_072),
        ("Round", 8 + Round::INIT_SPACE, 411, 375_144),
        ("RoundTicket", 8 + RoundTicket::INIT_SPACE, 291, 291_624),
        ("Sponsorship", 8 + Sponsorship::INIT_SPACE, 58, 129_456),
    ];
    for (name, size, pinned, rent) in sizes {
        eprintln!("{name}: {size} bytes");
        assert_eq!(size, pinned, "{name}: update Spec 08 §13.2");
        assert_eq!((size + 128) * 696, rent, "{name}: rent of Spec 08 §13.2");
    }
    assert_eq!(RiskParams::INIT_SPACE, 193 + 6 * 8);
}

fn word(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}

/// The nine `Vault` fields and `Integrator.app_shares_accrued` come out of the
/// reserved tails: the sizes and every existing offset are unchanged, so a
/// deployed account reads its old fields where they were and zero in the new ones.
#[test]
fn the_beacon_fields_take_the_reserved_tails() {
    let mut vault = Vault {
        version: 1,
        bump: 2,
        total_assets: 3,
        total_shares: 4,
        total_reserved_liability: 5,
        open_vault_credits: 6,
        open_before_close: 7,
        open_after_close: 8,
        generation: 9,
        close_ts: 10,
        price_maxima: [11; 24],
        price_head_hour: 12,
        drawdown_trip_ts: 13,
        volume_total: 14,
        integrators: 15,
        after_close_gain: 16,
        after_close_loss: 17,
        accepting_round: 18,
        next_round_id: 19,
        beacon_shares_held: 20,
        protocol_shares_accrued: 21,
        app_shares_owed: 22,
        beacon_returns_owed: 23,
        rounds_forfeited: 24,
        forfeits_withheld: 25,
        ticket_forfeits_withheld: 26,
        _reserved: [0; 40],
    };
    let mut bytes = Vec::new();
    vault.try_serialize(&mut bytes).unwrap();
    assert_eq!(bytes.len(), 606);
    assert_eq!(word(&bytes, 478), 16, "after_close_gain where it was");
    assert_eq!(word(&bytes, 486), 17, "after_close_loss where it was");
    let tail: Vec<u64> = (0..9).map(|i| word(&bytes, 494 + 8 * i)).collect();
    assert_eq!(tail, [18, 19, 20, 21, 22, 23, 24, 25, 26]);
    assert!(bytes[566..].iter().all(|b| *b == 0));
    // A deployed vault's zero tail reads as no round, no beacon books.
    vault.accepting_round = 0;
    vault.next_round_id = 0;
    vault.beacon_shares_held = 0;
    vault.protocol_shares_accrued = 0;
    vault.app_shares_owed = 0;
    vault.beacon_returns_owed = 0;
    vault.rounds_forfeited = 0;
    vault.forfeits_withheld = 0;
    vault.ticket_forfeits_withheld = 0;
    let mut zero_tail = Vec::new();
    vault.try_serialize(&mut zero_tail).unwrap();
    assert!(zero_tail[494..].iter().all(|b| *b == 0));

    let integrator = Integrator {
        version: 1,
        bump: 2,
        authority: Default::default(),
        share_account: Default::default(),
        reserved_liability: 3,
        open_tickets: 4,
        next_nonce: 5,
        volume_total: 6,
        paused: true,
        created_at: 7,
        app_shares_accrued: 8,
        _reserved: [0; 56],
    };
    let mut bytes = Vec::new();
    integrator.try_serialize(&mut bytes).unwrap();
    assert_eq!(bytes.len(), 179);
    assert_eq!(word(&bytes, 107), 7, "created_at where it was");
    assert_eq!(word(&bytes, 115), 8);
    assert!(bytes[123..].iter().all(|b| *b == 0));
}

#[test]
fn beacon_error_codes_are_pinned() {
    let code = |e: FadeError| 6000 + e as u32;
    let codes = [
        (FadeError::WrongRound, 6054),
        (FadeError::RoundNotAccepting, 6055),
        (FadeError::RoundCapacity, 6056),
        (FadeError::RoundPaid, 6057),
        (FadeError::WrongRoundStatus, 6058),
        (FadeError::RefundWindow, 6059),
        (FadeError::RoundRequestWindow, 6060),
        (FadeError::DrawUnderfunded, 6061),
        (FadeError::WrongPayoutTable, 6062),
        (FadeError::NotCanceller, 6063),
        (FadeError::ShareAccountRequired, 6064),
        (FadeError::MalformedBatch, 6065),
        (FadeError::RoundEpochClosed, 6066),
        (FadeError::NotRoundParticipant, 6067),
        (FadeError::EntropyUnrecorded, 6068),
    ];
    for (e, c) in codes {
        assert_eq!(code(e), c, "{e:?}");
    }
}

fn key(n: u8) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array([n; 32])
}

fn serialized<T: AccountSerialize>(account: &T, len: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    account.try_serialize(&mut bytes).unwrap();
    assert_eq!(bytes.len(), len);
    bytes
}

/// Spec 08 §13.2 fixes the field order of the beacon's accounts, not only their
/// sizes: an indexer or a generated client decodes by offset. Every field gets a
/// distinct value and is read back where the specification puts it, so swapping
/// two fields of the same type fails here.
#[test]
fn beacon_account_fields_are_at_their_offsets() {
    let byte = |b: &[u8], at: usize| b[at];
    let word32 = |b: &[u8], at: usize| u32::from_le_bytes(b[at..at + 4].try_into().unwrap());
    let pubkey = |b: &[u8], at: usize| b[at..at + 32].to_vec();

    let mut outcomes = [Outcome { p: 0, m: 0 }; 32];
    outcomes[0] = Outcome { p: 41, m: 42 };
    outcomes[31] = Outcome { p: 43, m: 44 };
    let table = PayoutTable {
        version: 1,
        bump: 2,
        len: 3,
        lhs: 0x0505_0505_0505_0505_0404_0404_0404_0404,
        max_m: 6,
        hash: [7; 32],
        outcomes,
    };
    let b = serialized(&table, 579);
    assert_eq!((byte(&b, 8), byte(&b, 9), byte(&b, 10)), (1, 2, 3));
    assert_eq!(
        u128::from_le_bytes(b[11..27].try_into().unwrap()),
        table.lhs,
        "lhs"
    );
    assert_eq!(word(&b, 27), 6, "max_m");
    assert_eq!(b[35..67], [7; 32], "hash");
    assert_eq!((word(&b, 67), word(&b, 75)), (41, 42), "outcomes[0]");
    assert_eq!((word(&b, 563), word(&b, 571)), (43, 44), "outcomes[31]");

    let round = Round {
        version: 1,
        bump: 2,
        vrf_bump: 3,
        status: RoundStatus::Forfeited,
        id: 4,
        rent_payer: key(5),
        first_slot: 6,
        paid_slot: 7,
        close_slot: 8,
        threshold: 9,
        draw_max: 10,
        round_k: 11,
        min_price: 12,
        settle_share: 13,
        request_share: 14,
        tick_slots: 15,
        refund_slots: 16,
        t_settle_slots: 17,
        drawdown_bps: 18,
        prices: 19,
        sponsorship: 20,
        liability: 21,
        credits: 22,
        protocol_shares: 23,
        app_shares: 24,
        prepaid: 25,
        usage: 26,
        tickets: 27,
        sponsors: 28,
        counted: true,
        side: 29,
        generation: 30,
        randomness: key(31),
        seed: [32; 32],
        entropy_slot: 33,
        funded: 34,
        draw_cost: 35,
        drawn_randomness: [36; 64],
        last_join_slot: 37,
        _reserved: [0; 24],
    };
    let b = serialized(&round, 411);
    assert_eq!(
        (byte(&b, 8), byte(&b, 9), byte(&b, 10), byte(&b, 11)),
        (1, 2, 3, 5),
        "version, bump, vrf_bump, status tag"
    );
    assert_eq!(word(&b, 12), 4, "id");
    assert_eq!(pubkey(&b, 20), key(5).to_bytes(), "rent_payer");
    let clock: Vec<u64> = [52, 60, 68, 76, 84].map(|at| word(&b, at)).to_vec();
    assert_eq!(
        clock,
        [6, 7, 8, 9, 10],
        "first_slot, paid_slot, close_slot, threshold, draw_max"
    );
    assert_eq!(byte(&b, 92), 11, "round_k");
    let words: Vec<u64> = (0..15).map(|i| word(&b, 93 + 8 * i)).collect();
    assert_eq!(
        words,
        (12..=26).collect::<Vec<u64>>(),
        "min_price .. usage, in the order of Spec 08 §13.2.2"
    );
    assert_eq!(
        (word32(&b, 213), word32(&b, 217)),
        (27, 28),
        "tickets, sponsors"
    );
    assert_eq!((byte(&b, 221), byte(&b, 222)), (1, 29), "counted, side");
    assert_eq!(word32(&b, 223), 30, "generation");
    assert_eq!(pubkey(&b, 227), key(31).to_bytes(), "randomness");
    assert_eq!(b[259..291], [32; 32], "seed");
    let draw: Vec<u64> = [291, 299, 307].map(|at| word(&b, at)).to_vec();
    assert_eq!(draw, [33, 34, 35], "entropy_slot, funded, draw_cost");
    assert_eq!(b[315..379], [36; 64], "drawn_randomness");
    assert_eq!(word(&b, 379), 37, "last_join_slot, from the spare tail");
    assert!(b[387..].iter().all(|x| *x == 0), "_reserved");

    let ticket = RoundTicket {
        version: 1,
        bump: 2,
        status: RoundTicketStatus::ReturnParked,
        round: 3,
        integrator: key(4),
        nonce: 5,
        payer: key(6),
        funder: key(7),
        refund_to: key(8),
        beneficiary: key(9),
        payout_table: key(10),
        price: 11,
        vault_credit: 12,
        payout_max: 13,
        liability: 14,
        protocol_share: 15,
        app_share: 16,
        prepay: 17,
        settle_share: 18,
        payout: 19,
    };
    let b = serialized(&ticket, 291);
    assert_eq!(
        (byte(&b, 8), byte(&b, 9), byte(&b, 10)),
        (1, 2, 2),
        "version, bump, status tag"
    );
    assert_eq!(word(&b, 11), 3, "round");
    assert_eq!(pubkey(&b, 19), key(4).to_bytes(), "integrator");
    assert_eq!(word(&b, 51), 5, "nonce");
    let keys: Vec<Vec<u8>> = (0..5).map(|i| pubkey(&b, 59 + 32 * i)).collect();
    assert_eq!(
        keys,
        [6, 7, 8, 9, 10].map(|n| key(n).to_bytes().to_vec()),
        "payer, funder, refund_to, beneficiary, payout_table"
    );
    let words: Vec<u64> = (0..9).map(|i| word(&b, 219 + 8 * i)).collect();
    assert_eq!(
        words,
        (11..=19).collect::<Vec<u64>>(),
        "price .. payout, in the order of Spec 08 §13.2.4"
    );

    let sponsorship = Sponsorship {
        version: 1,
        bump: 2,
        round: 3,
        sponsor: key(4),
        amount: 5,
    };
    let b = serialized(&sponsorship, 58);
    assert_eq!((byte(&b, 8), byte(&b, 9)), (1, 2));
    assert_eq!(word(&b, 10), 3, "round");
    assert_eq!(pubkey(&b, 18), key(4).to_bytes(), "sponsor");
    assert_eq!(word(&b, 50), 5, "amount");
}

/// The status tags are bytes on the wire: their order is the specification's.
#[test]
fn beacon_status_tags_are_pinned() {
    use anchor_lang::AnchorSerialize;
    let tag = |s: &dyn Fn(&mut Vec<u8>)| {
        let mut b = Vec::new();
        s(&mut b);
        assert_eq!(b.len(), 1);
        b[0]
    };
    let rounds = [
        RoundStatus::Accepting,
        RoundStatus::Paid,
        RoundStatus::Requested,
        RoundStatus::Drawn,
        RoundStatus::Refunded,
        RoundStatus::Forfeited,
    ];
    for (i, s) in rounds.iter().enumerate() {
        assert_eq!(usize::from(tag(&|b| s.serialize(b).unwrap())), i, "{s:?}");
    }
    let tickets = [
        RoundTicketStatus::Joined,
        RoundTicketStatus::PayoutParked,
        RoundTicketStatus::ReturnParked,
    ];
    for (i, s) in tickets.iter().enumerate() {
        assert_eq!(usize::from(tag(&|b| s.serialize(b).unwrap())), i, "{s:?}");
    }
}
