# Event schema versions

Every event carries `version: u8` as its first field (see `programs/fade/src/events.rs`).
`events.lock.json` pins each event's field list (with the layout of every type a field names, at any depth, docs excluded) and version; `pnpm events:check` fails
when one changes without the other. A row is added here whenever a version moves. Every event is emitted at `EVENT_VERSION` but one whose schema has moved, which carries its own constant in `constants.rs` (`TICKET_EXPIRED_VERSION`).

| Event | Version | Since | What changed |
|---|---|---|---|
| `Initialized` | 1 | V1 program | First version |
| `ParamsChanged` | 1 | V1 program | First version |
| `ParamsApplied` | 1 | V1 program | First version |
| `ParamsCancelled` | 1 | V1 program | First version |
| `PauseFlagsChanged` | 1 | V1 program | First version |
| `ShareMetadataSet` | 1 | V1 program | First version: `set_share_metadata` named the share mint for wallets |
| `IntegratorCreated` | 1 | V1 program | First version |
| `ShareAccountChanged` | 1 | V1 program | First version |
| `TicketOpened` | 1 | V1 program | First version |
| `RandomnessRequested` | 1 | V1 program | First version |
| `TicketSettled` | 1 | V1 program | First version |
| `TicketExpired` | 1 | V1 program | First version |
| `TicketExpired` | 2 | Audit fixes (22 October 2026) | `TICKET_EXPIRED_VERSION`. Appended after `forfeited`: `requested`, `request_found`, `checked` (the keepers' failure is `checked && !request_found`, as on `RoundExpired`), `pending` (the bound request was still pending and `vrf_payer` paid its rent: ORAO's rent refund reaches `vrf_payer` after the close, for `sweep_ticket_vrf`; false for a request someone else created, which refunds its creator), `refunded` and `refund` (`refund_expired_ticket` returned the vault credit; `forfeited` is 0 then), `parked` (that refund waits in `payout_escrow`: the ticket stays `PayoutPending` with `outcome` `REFUND_OUTCOME`, 255, until `claim_payout`), `ticket_forfeits_withheld` (the counter after this expiry). A version-1 body ends after `forfeited`: decoders dispatch on the version byte |
| `TicketEntropyRecorded` | 1 | Audit fixes (22 October 2026) | First version: `record_ticket_entropy` recorded an Open ticket's seed, `s*` and `h*` |
| `TicketVrfSwept` | 1 | Audit fixes (22 October 2026) | First version: `sweep_ticket_vrf` moved what reached a closed direct ticket's `vrf_payer` to the caller |
| `PayoutClaimed` | 1 | V1 program | First version |
| `DepositRequested` | 1 | V1 program | First version |
| `WithdrawRequested` | 1 | V1 program | First version |
| `EpochStruck` | 1 | V1 program | First version |
| `DepositClaimed` | 1 | V1 program | First version |
| `WithdrawClaimed` | 1 | V1 program | First version |
| `ClaimDelivered` | 1 | V1 program | First version |
| `PayoutTableRegistered` | 1 | Beacon | First version: a payout table stored once (Spec 08 §13.5.1), its `outcomes` included |
| `RoundOpened` | 1 | Beacon | First version: the round and its whole snapshot, `request_share`, `t_settle_slots` and `drawdown_bps` included |
| `TicketJoined` | 1 | Beacon | First version: every field of the `RoundTicket`, `payer`, `funder` and `settle_share` included |
| `RoundSponsored` | 1 | Beacon | First version |
| `RoundPaid` | 1 | Beacon | First version |
| `RoundRefunded` | 1 | Beacon | First version |
| `RoundDrawRequested` | 1 | Beacon | First version; `entropy_hash` is zero for a late binding whose recorded `s*` SlotHashes no longer holds (`RoundEntropyRecorded` carries it) |
| `RoundEntropyRecorded` | 1 | Beacon | First version (17 October 2026, fifth audit pass): `record_round_entropy` recorded a paid round's seed, `s*` and `h*` |
| `RoundDrawn` | 1 | Beacon | First version |
| `RoundTicketSettled` | 1 | Beacon | First version |
| `RoundExpired` | 1 | Beacon | First version: `requested`, `request_found` and `checked` tell a keeper's failure (`checked && !request_found`) from a withheld draw; `draw_cost`, `refund`, `side` and `generation` included, since a forfeited round emits no `RoundDrawn`; `refunded` (appended on 17 October 2026, before any release, fifth audit pass) marks a paid round refunded because its entropy was never recorded and SlotHashes no longer proves it |
| `RoundTicketReturned` | 1 | Beacon | First version |
| `RoundVrfSwept` | 1 | Beacon | First version (19 October 2026, post-implementation review finding 11): `sweep_round_vrf` moved what reached a round's `round_vrf` after its last drain into the round (`closed` false) or, the round closed, to the caller (`closed` true) |
| `SponsorshipReclaimed` | 1 | Beacon | First version |
| `RoundClosed` | 1 | Beacon | First version |
| `RoundPayoutClaimed` | 1 | Beacon | First version |
| `SharesClaimed` | 1 | Beacon | First version: the default key as `integrator` for the protocol's shares |

The fifteen beacon events (Spec 08 §13.6; sixteen since `RoundEntropyRecorded`, seventeen since `RoundVrfSwept`) are declared and locked before the instructions that emit them. Until an instruction emits one, it is listed in `events.pending.json` and locked at `EVENT_VERSION`; `pnpm events:check` fails when a listed event gains an emit site (take it off the list) and when an unlisted event has none. Test code never counts as an emit site. Since `claim_shares` every one of the fifteen has its emit site and the list is empty.

**Retired before any deployment**, kept in the lock so their names are never reused with another layout: `IntegratorRegistered`, `BondChanged`: the integrator registration and bond of Phase 2, removed with the bond.
