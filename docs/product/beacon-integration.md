> [Fade](../README.md) · Product. The integration guide's section on the shared beacon: how an integrator sends small tickets through it. The mechanism is [Spec 09](../spec/09-shared-beacon.md), its accounts and instructions [Spec 08 §13](../spec/08-program-architecture.md#13-shared-beacon-accounts-and-instructions), its parameter values the [Technical Specification §2](../spec/README.md#shared-beacon), which win wherever this page differs. Written 15 October 2026.

# Fade — Integrating the Shared Beacon

The shared beacon serves small tickets: one ORAO draw is shared by a round of tickets, so the draw costs each ticket a fraction of a cent instead of the 0.11 USD a direct ticket pays for its own. Everything else a direct ticket gets, a beacon ticket gets too: the same payout table check, the same caps and breakers, the same independent outcome per ticket, decided by the program and readable on-chain before the draw. What changes is the wait, the order of the steps, and what an integrator has to handle when a round is not yet paid.

**Status.** Implemented in the program and tested (14 and 15 October 2026), run against the real ORAO on devnet, then reviewed (17 October 2026, and again after implementation). The live devnet deployment, behind the app and the keeper, carries it since 18 October 2026 (upgraded in place, `Config` migrated to version 2) with `PAUSE_ROUNDS` set, so `join_round` is refused until the council clears the flag; the beacon has not been audited, and on mainnet the flag stays set until it is. The client helpers below are in `clients/js/src/beacon`, next to the generated client.

## 1. Which path

| | Direct path (`open_ticket`) | Beacon (`join_round`) |
| --- | --- | --- |
| Ticket price | from the direct minimum, 7.5 USDC at SIMD-0437's last step | from `beacon_min_price`: 0.50 USDC in `RiskParams::SPEC`, 0.10 USD targeted and measured as viable; 0.50 USDC on the devnet deployment until the team decides its minimum ticket |
| Draw | the ticket's own | one per round |
| Result | about 2 s after the open | the round closes at the tick after it is paid, 37 slots (about 13 s), at low volume once it is paid; then drawn from about 3 to 4 s after the close (request from `close_slot + 2`, ORAO 6 to 8 slots on devnet) and settled 5 to 13 s after it with the reference keeper on a public devnet endpoint (§6) |
| Protocol and app shares | paid out at open | held in the vault until the ticket settles, then claimed with `claim_shares` |
| Way out if no draw comes | forfeiture after `T_SETTLE`, unless a request at its seed exists fulfilled (then settled); refund of the credit if the seed was never recorded and is gone (§6) | before the round is paid: a refund of everything from about 600 s; once paid: forfeiture after `T_SETTLE` from the close, or a refund of everything for a round never requested whose seed was never recorded, expired once SlotHashes no longer proves it (§6) |
| Cancellation | none | **none** |

The program never switches paths: the integrator chooses for each ticket. A large ticket gains little from the beacon, since it pays most of a draw on its own and waits for the tick. Both paths share the integrator's record, its nonce sequence and its 20 % ceiling.

## 2. Before the first ticket

- **Register the payout table once.** `register_payout_table(outcomes)` validates the table exactly as `open_ticket` does and stores it at `["payout-table", hash]` (`findPayoutTablePda(outcomes)` gives the address). It is idempotent: a second call with the same outcomes succeeds and writes nothing. The payer pays its rent for good, 492 072 lamports for a 32-outcome table at the last SIMD-0437 step. A 32-outcome registration does not fit in the same transaction as a join; register it beforehand.
- **Name a share account on the first ticket.** The integrator's record is created by its first ticket on either path. If that ticket is a `join_round`, it must pass `shareAccount`, a usable USDC account, or the join fails with `ShareAccountRequired` (6064). App shares are paid there by `claim_shares`, never at settlement.
- **Know who pays the SOL.** The join's `payer` fronts, per ticket: the ticket account's rent (291 624 lamports at the last step, 2 128 520 at today's rent), the draw prepay, `ceil(D_r × price / T_r)` (19 218 lamports for 0.10 USDC and 192 175 for 1 USDC at the last step and an 8.64 USDC threshold, 63 718 and 637 172 at today's rent), and the settlement share (20 000 lamports at `SPEC`, 5 000 targeted). A join that creates its round also advances the round's rent, 375 144 lamports (2 738 120 today). All of it comes back to `payer` except the ticket's share of the draw and the settlement share, which pays whoever settles it. The program bounds the draw's share by the prepay above, about 231 bps of the price at the last step and an 8.64 USDC threshold, 765 bps at today's rent; in a paid round it is also at most `ceil(C × price / T_r)`, with `C` the draw's real cost. 150 bps of overhead (draw share plus settlement share) at the beacon minimum price is the design point of the threshold, at SIMD-0437's last-step rent and ORAO's current fee; it is not a guarantee. At today's rent with an 8.64 USDC threshold, a 0.50 USDC ticket's draw share is 109 734 lamports, 263 bps, about 311 bps with the 20 000-lamport settlement share; a round created before ORAO's fee doubles is still drawn and charges about 333 bps before the settlement share (`C` = 2 396 200 lamports), and about 171 bps at the last SIMD-0437 step (`C` = 1 234 440). Price a product on the prepay, or on `ceil(C × price / T_r)` with the deployment's `T_r` and the live rent and fee (Spec 09 §3).

## 3. A join

```ts
import { resolveJoinRound, getBeaconJoinInstructionAsync } from "./clients/js/src/beacon/index.ts"; // from the repository root

// Read the vault, the accepting round it names (if any) and the slot.
const target = await resolveJoinRound(vault, acceptingRound, slot);
const ix = await getBeaconJoinInstructionAsync(
  {
    integratorAuthority, // signer: the integrator's identity
    funder, // signer: owns funderUsdc, where the ticket price comes from
    funderUsdc,
    payer, // signer: pays the SOL, gets back what is not spent
    beneficiary, // where a payout goes
    payoutTable, // the registered table's address
    usdcMint,
    price, // micro-USDC, at least the round's min_price
    appShareBps,
    nonce: integrator.nextNonce,
    sponsorship: 0n, // or the lamports that pay the round (§4)
  },
  target,
);
```

`resolveJoinRound` returns the pair of rounds the join must name, `round` (the accepting round read) and `next_round` (its successor). The program lands the ticket in whichever of the two accepts it: the accepting round if it is still `Accepting`, or `Paid` before its close slot; otherwise it creates the next round. So a join built against a round that closed in the meantime still lands, without a retry. Only two rotations between the read and the landing, a full tick, make it fail with `WrongRound` (6054): read again and rebuild.

The join runs every check `open_ticket` runs, then the capacity rule (§5), before anything moves. A refused join moves no token and no lamport and writes nothing: it is always safe to retry.

**Transactions.** Send beacon transactions as **version 1 transactions without any address lookup table** (`beaconTransactionMessage(1, …)`), or as plain v0 without one where a wallet signs only legacy and v0 (`beaconTransactionMessage(0, …)`): a join is 902 bytes with three signers, 934 with a sponsorship record, inside v0's 1 232 bytes. `transactionFormatFor(rpc)` picks v1 where SIMD-0385 is active, on mainnet and devnet since October 2026. Simulate before signing; the app demo does (`apps/web/src/lib/tx.ts`).

## 4. No cancellation, and a lone ticket sponsored in its join

**There is no cancellation.** A ticket that has joined stays until its round is drawn, refunded or forfeited: no instruction lets the integrator, the player or anyone else take it out. Build the interface accordingly: the join is the commitment, as `open_ticket` is. This is what makes a round's capacity only grow, and what closes every bait-and-cancel (Spec 09 §6, §10).

**A round is drawn only once it is paid**, by its tickets' prices reaching the threshold `T_r` (8.64 USDC at `SPEC`) or by sponsorship covering the rest of the draw. No vault money ever completes a draw. An integrator that wants **one ticket drawn at once** sends, in the same `join_round`, the sponsorship that pays the round:

```ts
import { lonePaySponsorship, newRoundTerms } from "./clients/js/src/beacon/index.ts"; // from the repository root

const terms = newRoundTerms(config.params, oraoFee, pendingRequestRent); // for a round this join creates
const sponsorship = lonePaySponsorship(target, landingRound, price, terms);
// then getBeaconJoinInstructionAsync({ ..., sponsorship }, target)
```

That is `ceil(D_r × (T_r − R − price) / T_r) − S` on the round the join lands in: 1 641 175 lamports (0.197 USD) for a 0.10 USDC ticket alone in a new round at the last SIMD-0437 step, 5 441 443 at today's rent. The join makes the round paid; it closes at the next tick boundary, within about 13 s, and is settled 5 to 13 s after its close with the reference keeper (§6). The draw's real cost (734 440 lamports at the last step, 1 896 200 today) is charged to the sponsorship first, so the ticket itself is charged nothing; the rest of the sponsorship returns to the sponsor, the join's `payer`, through `reclaim_sponsorship` once the round is drawn, which anyone may send and a keeper does. If another join lands first, the round is paid sooner and the surplus comes back the same way, pro rata.

The join then creates a `Sponsorship` record at `["sponsorship", round, payer]` (rent 129 456 lamports at the last step, returned at the reclaim). `getBeaconJoinInstructionAsync` derives it for the round the join is predicted to land in; if the rounds rotate before it lands, the join fails on the record's seeds and moves nothing: rebuild and retry.

Without sponsorship a ticket waits for the round to be paid by other joins or by any sponsor (`sponsor_round`, `getCompleteDrawInstructionAsync`). If nobody pays it, the round may be refunded once it has taken no ticket for `refund_slots` (1 715 slots, about 600 s), by any of its participants: the payer, funder or integrator of one of its tickets, showing that ticket (`getBeaconRefundInstructionAsync`). A sponsor is not a participant; it gets its whole sponsorship back after anyone else's refund. A round whose draw no longer fits its prefund (ORAO's fee more than doubled since the round opened) refuses every join with `DrawUnderfunded`; anyone may refund it once the same window is open (`getBeaconRefundInstructionAsync` with no proof and the live fee), and the next join opens a round at the new fee. Every ticket price, prepay, settlement share, rent and sponsorship then comes back in full (§6).

## 5. A join refused for capacity, retried in the next round

One draw decides a whole round, so a round may hold at most `k` per-ticket caps of liability (`k = 1`), each ticket counted against its own cap, and while unpaid only 90 % of its paid share of them, so that the join that pays it always has room:

```
paid:   Σ liability_i / cap_i ≤ k
unpaid: Σ liability_i / cap_i ≤ 0.9 × k × (R / T_r + S / D_r)
```

and every join, the round paid or not, takes at most its own share of it: `liability / cap ≤ k × min(1, price / T_r + sponsorship / D_r)`, its own price and sponsorship, or up to `0.1 × k` if more when the join is the one that makes the round paid (`withinJoinShare`; `joinFits` gives the whole decision). The room a round has, before its payment or after, goes to the joins that pay for it, not to cheap long shots: room other tickets' prices or a third party's sponsorship bought is open to a join only within its own share, the 10 % floor being the paying join's alone.

A join that does not fit fails with `RoundCapacity` (6056) and moves nothing. The retry depends on the round's state:

- **The round is unpaid** (`Accepting`): the retry must bring payment or use less capacity; this holds too when the round has room but the join takes more than its own share (beyond what its price and sponsorship pay, and above 10 % of its cap if the join pays the round). Either carry sponsorship in the join (a sponsored join pays the round, and a paid round carries a whole cap; `lonePaySponsorship` or `sponsorshipToCompleteDraw` gives the amount that pays it at once), or lower the ticket's multiplier, or make the ticket smaller at the same multiplier. A higher ticket price helps only if it pays the round: at a fixed multiplier the ticket's liability and the share of the draw its price pays both grow with the price, so a join refused at one price is refused at every higher one that leaves the round unpaid (§7: the multiplier an unsponsored ticket can carry does not depend on its price).
- **The round is paid and the join takes more than its own share** (beyond what its price and sponsorship pay): bring sponsorship, as for an unpaid round; the same join would be refused by a new round too.
- **The round is paid and has no room for the join**: nothing to do. The join is not refused: it opens the next round and lands there, the full round keeping its own close and draw. `resolveJoinRound` on the round read and its successor gives the pair either way; pass it the join's usage (`usage` of a like ticket's `TicketJoined`) so that a join carrying sponsorship names the right round's record. A `RoundCapacity` here means the new round, unpaid, has no room for it either: bring payment, as above.
- **`RoundEpochClosed`** (6066): the round was counted before an epoch close that has now passed, and takes no join until its own close; the retry, one tick later at most, lands in the next round.
- **`DrawUnderfunded`** (6061): ORAO's fee rose by more than one fee since the round was created, so the round can no longer pay its draw and takes no ticket. A paid round's close opens the next one on the new fee; an unpaid one waits for its refund window, when anyone may refund it (it can never be paid, and its participants may never act), and its tickets are refunded in full. A paid round whose draw no longer fits cannot pay for it, and sponsorship cannot help, since `request_round_draw` and `sponsor_round` compare the live cost with the round's prefund `D_r`, not with what it holds. It can still be drawn: anyone may create its ORAO request directly (ORAO's `request_v2` with the seed and request address `roundRequestAddress` returns for the paid round, Spec 08 §13.4) from `close_slot + 2` to `close_slot + T_SETTLE`, paying ORAO's fee and the pending rent itself, and then send `request_round_draw`, which binds the existing request, funds nothing and pays the caller the request share. The rescuer pays the fee and the rent (ORAO refunds most of the rent to whoever created the request, at fulfilment), and the tickets are charged only the request share, pro rata, net of sponsorship. An integrator with tickets in such a round should do this, or have its keeper do it, for about one ORAO fee: if nobody does and the fee does not fall back within `D_r` before `T_SETTLE`, the round is forfeited as a whole and each of its tickets counts as a loss (Spec 08 §13.5.6, §13.9).

Admission refusals (`PriceBounds`, `PerTicketCap`, `IntegratorCap`, `UtilisationBreaker`, `DrawdownBreaker`) mean what they mean on the direct path: a price within the bounds, a smaller multiplier or ticket price, or later. Only these direct-path caps are eased by a smaller price; `RoundCapacity` is not (above).

## 6. After the join

| What happens | Who does it | What the integrator sees |
| --- | --- | --- |
| The round becomes paid (`RoundPaid`) and closes at the next multiple of 37 slots | nobody: the close is computed from state | `RoundPaid { close_slot }` |
| The draw is requested, from `close_slot + 2`; the request records the round's seed | anyone, paid the 50 000-lamport request share; the keeper does it | `RoundDrawRequested` |
| The round's seed is recorded on its own, while SlotHashes proves it (about 512 slots), so that it no longer depends on the request landing | anyone, unpaid (`record_round_entropy`, `getBeaconRecordEntropyInstructionAsync`); the keeper sends it just before its request, in a transaction of its own; a record on a round already recorded, by anyone or by the request, succeeds without writing | `RoundEntropyRecorded` |
| ORAO fulfils, about 6 to 8 slots on devnet (one draw in eighteen took 89 slots); the reference keeper settled rounds 5 to 13 s after their close on a public devnet endpoint | ORAO | — |
| Tickets are settled in batches of up to 32 | anyone, paid each ticket's settlement share; the keeper does it, or the integrator with `planSettlement` | `RoundTicketSettled { ticket, outcome, payout, charge }` per ticket |
| The payout reaches the beneficiary, or is parked if the beneficiary cannot receive | the settlement; a parked payout by `claim_round_payout`, anyone | `RoundPayoutClaimed` |
| The ticket's lamports return to `payer`: prepay minus its charge, and the rent | the settlement | — |
| App shares become claimable | the settlement | `claim_shares` pays them to the share account; anyone may push |

**The reference keeper's pace** (21 October 2026). While a round holds a ticket or is being worked, the keeper ticks as before: at the slot a round can next be requested, every 0.5 s while it is requested or settled. With nothing on record it looks for new rounds every 20 s, and every 5 s for a minute after a wake. An integrator whose join pays its round at once should wake it right after the join confirms: `POST https://api.fade.finance/v1/beacon/wake`, no body (the keeper reads the round from the chain), rate limited per IP; the app does so after every join. Unannounced, a round paid at once is still requested by about `close_slot + 68` in the worst case, inside the 150-slot window with ORAO's 60-slot margin, but it may raise the keeper's `request-late` warning (`close_slot + 30`). An integrator that wants no dependence on the keeper's pace sends `record_round_entropy` and `request_round_draw` itself from `close_slot + 2`.

**Settlement batches** are built by the client's `planSettlement`, as version 1 transactions without a lookup table, plain v0 where v1 is not accepted: up to 32 tickets of one integrator paying its players' SOL, 20 when every ticket has its own payer, 14 when each also has its own integrator, against 10, 6 and 4 in v0 (Spec 08 §13.5.7). Every account of a batch is checked against the ticket's stored keys, so a batch can mix integrators, payers and payout tables, and nobody can redirect a payout by building one. Settlement has no deadline and is never paused.

**If the round is never paid**, any of its participants may `refund_round` it once it has taken no ticket for `refund_slots`; nobody is paid to, nobody outside the round can, and a round still gathering tickets never becomes refundable, so a slow round keeps accepting tickets and may still be paid later. Each ticket is then returned by `return_round_ticket` (anyone): the ticket price to `refund_to`, the funder's own token account, and the prepay, the settlement share and the rent to `payer`. Sponsors get their whole sponsorship back with `reclaim_sponsorship`.

**If a closed round is not requested or not fulfilled within `T_SETTLE`** (150 slots from its close), anyone may `expire_round` it: the round forfeits as a whole, exactly a loss for each ticket, as a direct ticket forfeits. `return_round_ticket` then returns each ticket's `prepay − charge` and rent to `payer`. A round whose request exists fulfilled is never forfeited: it is settled. A round never requested whose seed was never recorded, expired once SlotHashes no longer proves its entropy slot (about 512 slots after the close), is refunded in full instead, as an unpaid round is (*changed on 17 October 2026*): the program can no longer tell whether its request exists. An integrator that wants its players' rounds never to depend on the keeper for this may send `record_round_entropy` itself from `close_slot + 2`.

**The direct path's expiry follows the same rules** (audit fixes of 22 October 2026). A direct ticket's seed is public from `open_slot + 1`, so the keeper records it from `open_slot + 2` with `record_ticket_entropy` on its own transaction, ahead of its request, so that a refused or failing request still leaves it recorded; an integrator that wants no dependence on the keeper sends `record_ticket_entropy` itself once the open is confirmed (permissionless, unpaid, idempotent). A ticket nobody records within about 512 slots of its open is refunded its vault credit past `T_SETTLE`, and whoever created and read its request could choose between that refund and settling. Past `T_SETTLE`, an Open ticket is expired with `record_ticket_entropy` (unless recorded) and `expire_ticket` in one transaction, naming the request address derived from the seed (`openTicketExpiry` and `ticketRequestAddress` in `clients/js/src/direct`), not the System program. On `AlreadyFulfilled`, someone created the request there and ORAO answered: send `request_randomness` (bound late, nothing funded) and `settle_ticket` together. On `EntropyUnrecorded` once `s*` is gone, `refund_expired_ticket` returns the vault credit to the beneficiary (or `payout_escrow`); the shares paid at open are not returned. Do not show an expiry as an ordinary loss: `TicketExpired` (version 2, decode it with `decodeTicketExpired`, which reads both versions) says whether the ticket was refunded (`refunded`, `refund`, and `parked` when the credit waits in `payout_escrow`: the ticket is then `PayoutPending` with `outcome` `REFUND_OUTCOME`, 255, not a settlement parked on outcome 0) and whether a withheld draw may explain it, and every such expiry counts in `Vault.ticket_forfeits_withheld`. A direct ticket expired with its request pending (`TicketExpired.pending`, set only when `vrf_payer` paid that request's rent) has ORAO's rent refund land on its `vrf_payer` after the close: `sweep_ticket_vrf(nonce)` moves it to whoever sends it, and the keeper does.

**If ORAO answers after a forfeiture**, its refund of the request's pending rent (about 3.1 million lamports today) lands on the round's `round_vrf` after the expiry charged it to the tickets. Anyone may move it with `sweep_round_vrf(round_id)` (`getBeaconSweepVrfInstructionAsync`; `roundVrfSweepable` tells whether there is anything to move): into the round while it exists, where the close pays it to the round's rent payer with the dust, or to whoever sends the sweep once the round has closed. The same holds of lamports anyone sends to `round_vrf` after its drain. The sweep is unpaid, never paused, succeeds with nothing to move, and is refused while the round is `Requested`, when what `round_vrf` holds lowers the draw cost. The keeper sends it ahead of a round's returns or reclaims, so that the refund reaches the rent payer, and watches each round forfeited after its request for up to a week (seen forfeited, or its `RoundExpired` read with `requested` true when the round closed between two of its reads), sweeping its `round_vrf` once ORAO answers after the close (Spec 08 §13.5.8a). Each pass reads a bounded number of watched `round_vrf`s, the longest unread first, so every one is read in turn however many rounds forfeit; a watch ends early once the round has closed, its ORAO request reads fulfilled and its `round_vrf` reads empty, since nothing more can come from ORAO. Against a program that does not know the instruction (refused at preflight with Anchor's `InstructionFallbackNotFound`), it sends the returns and reclaims again at once without the sweep and sends none for an hour.

## 7. The largest multiplier, per vault size

A beacon ticket has the direct path's per-ticket limits: multipliers up to 10 000× and the per-ticket cap, `min(0.5 × vault margin × free balance, 150 bps × total assets)`. At `k = 1` a paid round carries one cap, so one ticket may use all of it. An unsponsored ticket alone in a new round only brings `price / T_r` of the draw, and the round, unpaid, may use 90 % of that share (§5), so it fits only if its liability is at most `0.9 × cap × price / T_r`: the multiplier it can carry alone does not depend on its price.

Largest multiplier, on the demo payout table's margins (3.5 % declared, 2.8 % to the vault after a 50 bps app share and the 20 bps protocol share), an otherwise idle vault, `T_r` = 8.64 USDC. "Paid round": a lone ticket sponsored in its join (§4), or any join bringing a whole draw's payment; joining a round others have paid, unsponsored, a ticket takes at most its own paid share (§5), so these figures need that payment. "Alone, unsponsored": the first ticket of a new round with no sponsorship.

| Vault (USDC) | Per-ticket cap | 0.10 USDC, paid round | 0.50 USDC, paid round | 1 USDC, paid round | Alone, unsponsored, any price |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 000 | 70 | ×700 | ×140 | ×70 | ×8 |
| 13 400 | 187.6 | ×1 876 | ×376 | ×188 | ×20 |
| 25 000 | 350 | ×3 500 | ×700 | ×350 | ×37 |
| 70 000 | 980 | ×9 800 | ×1 960 | ×980 | ×103 |
| 100 000 | 1 400 | ×10 000 | ×2 800 | ×1 400 | ×146 |
| 250 000 | 3 500 | ×10 000 | ×7 000 | ×3 500 | ×365 |
| 1 000 000 | 14 000 | ×10 000 | ×10 000 | ×10 000 | ×1 459 |

Computed as in Spec 09; Spec 09 §7 gives the sponsorship each multiplier needs in a partly paid round (on a 13 400 USDC vault, a ×1 000 ticket of 0.10 USDC needs its own join to pay 53 % of the draw in a paid round, 864 975 lamports of sponsorship, and 59 %, 963 219 lamports, in a round its join leaves unpaid, the headroom of §5). The figures fall as the vault fills: the cap is computed on the free balance at the join, and it is halved for 48 hours after the drawdown breaker trips. A ticket below the round's `min_price` is refused (`PriceBounds`), so 0.10 USDC tickets need `beacon_min_price` lowered from its `SPEC` value of 0.50 USDC; the devnet beacon instance runs at 0.10.

## 8. What to index

Every round and ticket can be rebuilt from the program's events alone (Spec 08 §13.6): `RoundOpened`, `TicketJoined`, `RoundSponsored`, `RoundPaid`, `RoundDrawRequested`, `RoundEntropyRecorded` (a round's seed, `s*` and `h*` when recorded before its request: the only event that carries `h*` for a round bound late, whose `RoundDrawRequested` has a zero `entropy_hash` once SlotHashes no longer holds `s*`), `RoundDrawn`, `RoundTicketSettled`, `RoundRefunded`, `RoundExpired`, `RoundTicketReturned`, `SponsorshipReclaimed`, `RoundClosed`, `RoundPayoutClaimed`, `SharesClaimed`, `RoundVrfSwept` (the lamports a sweep moved from `round_vrf`, to the round or, once closed, to the caller), and `PayoutTableRegistered`. A player's proof is the same as on the direct path: the ticket's payout table is the registered account its `TicketJoined` names, its outcome is `SHA256("FADE/BEACON-OUTCOME/v1" ‖ program ‖ round ‖ ticket ‖ R ‖ i)` on the round's ORAO randomness, and both are public.

## 9. Pauses

The guardian's `PAUSE_ROUNDS` stops joins, and the sponsorship of unpaid rounds, on the beacon alone; `PAUSE_TICKETS` stops both paths. A paused join fails with `Paused` (6002) and moves nothing. Nothing that ends a round is ever paused: refunds, requests, settlement, expiry, returns, reclaims, `claim_round_payout` and `claim_shares` (Spec 08 §13.7).
