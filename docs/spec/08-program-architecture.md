> [Fade](../README.md) · Technical. Domain document 08 of the [Technical Specification](README.md): owns the account map, what each instruction writes, the epoch lifecycle as a state machine, the fee flows of the liquidity-provider side, the parameter queue, and the throughput bounds. The pricing arithmetic is [Spec 01](01-vault-and-lp-accounting.md)'s and the per-instruction validation [Spec 07](07-solana-implementation-security.md)'s. Parameter values are the Technical Specification's §2 table, which wins wherever the two differ.

# Fade Spec 08 — Program Architecture

Status: the account and instruction layout the program is built to.

## 1. Three rules

1. **Two sides that never share a write.** Tickets and liquidity-provider flows each have their own state account and their own token accounts. Only two instructions touch both, each once per epoch: the strike, and the request that opens an epoch. A rush of deposits or withdrawals never competes with players for the same accounts.
2. **Constant cost per instruction, whatever the load.** No instruction iterates over requests, tickets or integrators. The strike costs the same with one request or ten thousand.
3. **Every unit of work is prepaid to whoever does it.** Requesting randomness, settling, expiring, striking and claiming are all paid. None depends on goodwill, and none needs the party that created the work to come back.

## 2. Accounts

| Account | Seeds | Side | Written by | Lifetime |
| --- | --- | --- | --- | --- |
| `Config` | `["config"]` | governance | `initialize`, `set_params`, `apply_params`, `cancel_params`, `set_pause_flags` | never closed |
| `Vault` | `["vault"]` | tickets | `open_ticket`, `settle_ticket`, `expire_ticket`, `refund_expired_ticket`, `strike_epoch`, the request that opens an epoch; `ticket_forfeits_withheld` by `expire_ticket` and `refund_expired_ticket` | never closed |
| `vault_usdc` | `["usdc-vault"]` | tickets | `open_ticket`, `settle_ticket`, `refund_expired_ticket`, `claim_payout`, `strike_epoch` | never closed |
| `payout_escrow` | `["payout-escrow"]` | tickets | `settle_ticket` and `refund_expired_ticket` (frozen beneficiary only), `claim_payout` | never closed |
| `Integrator` | `["integrator", authority]` | tickets | `open_ticket` (creates it on the first call), `settle_ticket`, `expire_ticket`, `refund_expired_ticket`, `set_share_account`, `set_pause_flags` (its pause flag) | never closed |
| `Ticket` | `["ticket", integrator, nonce]` | tickets | `open_ticket`, `record_ticket_entropy` (seed, `s*`, `h*` of an Open ticket), `request_randomness`, `settle_ticket`, `expire_ticket`, `refund_expired_ticket`, `claim_payout` | closed at settlement, expiry or refund, or by `claim_payout` for a `PayoutPending` ticket; rent to its payer |
| `vrf_payer` | `["vrf-payer", ticket]` | tickets | `open_ticket`, `request_randomness`, `settle_ticket`, `expire_ticket`, `refund_expired_ticket`, `sweep_ticket_vrf` | drained onto the ticket at its exit, for its payer at the close; what reaches it after the close (ORAO's refund of a request fulfilled after the ticket expired, or a transfer) is moved by `sweep_ticket_vrf` to its caller |
| `Queue` | `["queue"]` | LP | `request_deposit`, `request_withdraw`, `strike_epoch` | never closed |
| `deposit_queue_usdc` | `["deposit-queue"]` | LP | `request_deposit`, `strike_epoch` | never closed |
| `payable_usdc` | `["payable"]` | LP | `strike_epoch`, `claim_withdraw` | never closed |
| `share_mint` | `["shares"]` | LP | `strike_epoch` (mint and burn) | never closed |
| `share_escrow` | `["share-escrow"]` | LP | `request_withdraw`, `strike_epoch` | never closed |
| `share_claims` | `["share-claims"]` | LP | `strike_epoch`, `claim_deposit` | never closed |
| `EpochRecord` | `["epoch", epoch_id]` | LP | `strike_epoch` (creates it), `claim_deposit`, `claim_withdraw` | closed by the claim that brings its count to zero; rent to the strike fund |
| `DepositRequest` | `["deposit", epoch_id, owner]` | LP | `request_deposit`, `claim_deposit` | closed at the claim; rent to the owner, `CLAIM_FEE` to the claimer. Parked instead if the owner's account cannot receive (§2.4), and closed by the claim that delivers |
| `WithdrawRequest` | `["withdraw", epoch_id, owner]` | LP | `request_withdraw`, `claim_withdraw` | closed at the final claim; the same split, and the same parking |

Every token account is owned by the data-less `["vault-authority"]` PDA. At most one deposit request and one withdrawal request exist per owner and per epoch: a second request in the same epoch tops up the first.

### 2.1 `Vault` — the ticket side

`total_assets`, `total_shares` (tracked, and equal to the share mint's supply), `total_reserved_liability`, `open_vault_credits`; the three epoch counters of §4 (`open_before_close`, `open_after_close`, `generation`) and a copy of the live epoch's `close_ts`; the drawdown ring of §8; `volume_total`, the cumulative ticket price ever opened; and what the vault gained and lost on tickets opened after the live close that have already closed (§4 rule 5). Identity: `vault_usdc ≥ total_assets`.

### 2.2 `Queue` — the liquidity-provider side

The two live epochs of §4 — `current`, with its `epoch_id` and `close_ts`, and `next` — each with its deposits, its queued withdrawal shares and its request counts; the running indices of §5; the next epoch id. The account's lamports above its own rent-exempt minimum are the **strike fund** of §6. Identities: `deposit_queue_usdc ≥` the queued deposits of both live epochs; `payable_usdc ≥` what struck withdrawals still owe.

### 2.3 `EpochRecord`

Written once by the strike, then read by claims: the epoch's close and strike times; the vault's settled assets (§4) and its shares at the strike, which fix the price; deposits and the shares minted for them; withdrawal shares queued, assets owed, assets paid and shares burnt; the chain the epoch belongs to and its indices of §5, before and after this epoch; the count of requests whose remaining claims still read it; and who advanced its rent. 210 bytes, a rent of 1 717 040 lamports on mainnet, advanced by the strike fund and returned to it when the record closes. A record no claim will ever read — an epoch that only carried rolled shares and did not end its chain — is closed by the strike that wrote it.

### 2.4 Requests

A `DepositRequest` holds its owner, epoch and amount, and the shares a parked claim owes: 67 bytes, 990 600 lamports of rent. A `WithdrawRequest` holds its owner, epoch and shares, plus, from its first claim, the chain it is in, the chain's indices at its entry and the assets claims have already paid (§5), and the assets owed but not yet delivered: 115 bytes, 1 234 440 lamports. Both also hold their `CLAIM_FEE`. The rent returns to the owner when the request closes: about 0.001 SOL, advanced, not spent. Rents here are mainnet's, 5 080 lamports per byte counted with its 128 bytes of overhead, as measured on 23 September 2026; LiteSVM, where the tests run, still charges the older 6 960.

The destination of a claim is the owner's canonical associated token account, created in the request's own transaction if it does not exist. A claimer therefore never has to advance rent for someone else. The owner stays free to close that account, to freeze it through the mint's authority or, since USDC and the shares are legacy SPL tokens that ignore immutable ownership, to hand it to another owner. None of that may keep a record open. A claim that finds the account unable to receive still does all its bookkeeping — it releases the records it reads and pays its claimer — and **parks** what it owes on the request: the shares due, or the assets not delivered. A later claim, reading no record, delivers them and closes the request: by anyone, to that account once it can receive; or, with the owner's signature, to any other account of the owner's that can — an account handed to someone else may never come back, and a destination its owner signs for is not one a claimer chose.

### 2.5 `Integrator`

The share account, fixed at creation and changed only through `set_share_account` with the authority's signature; open liability; open-ticket count; the next ticket nonce; `volume_total`; and a pause flag the guardian can set and only the council can clear ([Spec 05](05-governance.md) §4). Keyed on the signing address and never closed: its nonce can never restart ([Spec 04](04-risk-and-exposure.md) §4.4, [Spec 07](07-solana-implementation-security.md) §1).

### 2.6 `Config`

Authorities (council, guardian), the protocol treasury, the USDC mint, the pause flags, the parameters of the Technical Specification §2, and at most one pending parameter change (§7).

## 3. What each instruction writes

| Instruction | Ticket side | LP side |
| --- | --- | --- |
| `open_ticket` | `Vault`, `vault_usdc`, `Integrator`, `Ticket`, `vrf_payer`, treasury and integrator share accounts | — |
| `request_randomness` | `Ticket`, `vrf_payer`, ORAO request | — |
| `record_ticket_entropy` | `Ticket` | — |
| `settle_ticket`, `expire_ticket`, `refund_expired_ticket` | `Vault`, `vault_usdc`, `Integrator`, `Ticket`, `vrf_payer`, beneficiary or `payout_escrow` | — |
| `sweep_ticket_vrf` | `vrf_payer` of a closed ticket, the caller | — |
| `claim_payout` | `payout_escrow`, `Ticket` | — |
| `join_round` | `Vault`, `vault_usdc`, `Integrator`, `RoundTicket`, `Round` (created by the first join), `Sponsorship` if it sponsors | — |
| `return_round_ticket` | `Vault`, `vault_usdc` or `payout_escrow`, `Integrator`, `RoundTicket`, `Round` | — |
| `refund_round`, `expire_round` | `Vault`, `Round`; `round_vrf` at expiry | — |
| `request_round_draw` | `Round`, `round_vrf`, ORAO request | — |
| `record_round_entropy` | `Round` | — |
| `sweep_round_vrf` | `round_vrf`; `Round`'s lamports while it exists, the caller's once it has closed | — |
| `settle_round_tickets` | `Vault`, `vault_usdc`, `payout_escrow`, `Round`, `round_vrf`, and per ticket its `RoundTicket`, `Integrator`, beneficiary | — |
| `sponsor_round` | `Round`, `Sponsorship`; `Vault` (the epoch counters) when it pays the round | — |
| `reclaim_sponsorship` | `Round`, `Sponsorship` | — |
| `claim_round_payout`, `claim_shares` | `payout_escrow` or `vault_usdc`, `RoundTicket` or `Vault` and `Integrator` | — |
| `request_deposit` | `Vault` **only if it opens an epoch** | `Queue`, `deposit_queue_usdc`, `DepositRequest` |
| `request_withdraw` | `Vault` **only if it opens an epoch** | `Queue`, `share_escrow`, `WithdrawRequest` |
| `strike_epoch` | `Vault`, `vault_usdc` | `Queue`, `deposit_queue_usdc`, `payable_usdc`, `share_mint`, `share_escrow`, `share_claims`, `EpochRecord` |
| `claim_deposit` | — | `share_claims`, `EpochRecord` (none once parked), `DepositRequest` |
| `claim_withdraw` | — | `payable_usdc`, one or two `EpochRecord`s (none once parked), `WithdrawRequest` |

`claim_*` never reads `Vault`: the price is in the record. `request_*` reads the share mint, which only the strike writes, to apply the first-deposit minimum, and never reads `Vault` unless it is opening an epoch. Claims may be grouped several to a transaction; the top-level instruction allowlist of `request_deposit` and `request_withdraw` (Technical Specification invariant 13) is unchanged.

## 4. The epoch lifecycle

An epoch is **a batch of requests priced together**, in the sense of Centrifuge's epochs and of the ERC-7540 asynchronous vaults, and unrelated to Solana's ~2-day epoch. Its semantics — one price, struck after the close and after every ticket opened before the close has closed — are [Spec 01](01-vault-and-lp-accounting.md) §3.5's. This section is the machinery.

```
close_ts(t) = (floor(t / epoch_length_seconds) + 1) × epoch_length_seconds      // the next :00, :10, :20 … UTC
```

1. **Opening.** A request when no epoch is live opens `current` with the next id and `close_ts = close_ts(now)`. The same instruction writes `Vault`: `open_before_close += open_after_close`, `open_after_close = 0`, `generation += 1`, and the copy of `close_ts`. This is exact: every ticket still open was opened at or before now, so before the close.
2. **Joining.** A request at `t < current.close_ts` joins `current`. At `t ≥ current.close_ts` it joins `next`, created if need be; `next` has no close yet.
3. **Counting tickets.** `open_ticket` at `t` adds one to `open_before_close` if a close is set and `t < close_ts`, otherwise to `open_after_close`, and records in the ticket the `generation` and which counter it joined.
4. **Closing a ticket.** `settle_ticket` and `expire_ticket` take one from `open_before_close` if the ticket joined it in the current generation, or joined `open_after_close` in the previous generation; from `open_after_close` if it joined it in the current generation. No other case exists: every generation change moves `open_after_close` into `open_before_close`, and the next change needs `open_before_close == 0`, so no ticket outlives two generations. A ticket that leaves `open_after_close` also books its result, `vault_credit − payout`, in `Vault`'s after-close gain or loss.
5. **Striking.** `strike_epoch` requires a live `current`, `now ≥ current.close_ts` and `open_before_close == 0`. It prices the epoch on the vault as it stood at the close: the settled assets, `total_assets − open_vault_credits`, less the after-close gain and plus the after-close loss. Tickets opened after the close are not value a request can buy ([Spec 01](01-vault-and-lp-accounting.md) §3.5), whether still open — their credits — or already closed — their results. Otherwise whoever orders a settlement and the strike, both permissionless, would choose which post-close outcomes a price includes: settle a player's loss before the strike, let a win wait until after. The strike then clears the after-close gain and loss, whose tickets belong to the next epoch; so does every generation change. It moves the deposits from `deposit_queue_usdc` to `vault_usdc` and the assets paid from `vault_usdc` to `payable_usdc`, mints to `share_claims`, burns from `share_escrow`, writes the `EpochRecord`, and is paid from the strike fund. Unfilled withdrawal shares join `next`.
6. **Promoting.** If `next` holds anything — new requests, or shares rolled by a rationed strike — it becomes `current` with `close_ts = close_ts(now)`, and `Vault`'s counters roll as in rule 1, the after-close gain and loss cleared with them. Otherwise no epoch is live, and `Vault`'s copy of the close is cleared.

So at most **two epochs are ever live**: the one awaiting its price and the one filling behind it. A period with no request creates nothing and costs nothing. A change of `epoch_length_seconds` applies to the next `close_ts` computed, at an opening or a promotion, and never to an epoch that already has one.

Two timing facts make the comparisons exact. A request or a ticket at exactly `close_ts` belongs to what comes after. And Solana's `unix_timestamp` never decreases: it is a stake-weighted median of validators' vote timestamps, bounded against the slot clock ([Agave — bank timestamp correction](https://docs.anza.xyz/implemented-proposals/bank-timestamp-correction)).

## 5. Withdrawals across epochs, claimed once

A strike that cannot pay every queued withdrawal pays a fraction `f = assets_paid / assets_owed` of each and rolls the rest ([Spec 01](01-vault-and-lp-accounting.md) §4.3). Such a rationed strike pays at most `assets_owed − ceil(assets_owed / 10⁶)`: at least a millionth of the queue always rolls, which costs the queue nothing but a millionth of a strike's wait and keeps the indices below well conditioned. Shares worth nothing at the strike price — owed zero assets — are served in full, burnt for nothing: they could otherwise roll forever, keeping an epoch live that the strike fund would pay to strike. A withdrawal can therefore be served over several consecutive epochs: a **chain**, ending at the first epoch that pays in full. A keeper paid once must be able to settle it in one claim, and a claim must not iterate over the epochs in between.

`Queue` keeps two running indices for the current chain, in 10¹⁸ fixed point: `chain_r`, the fraction of a share that entered the chain still queued, and `chain_v`, the assets it has received so far. A chain starts at `(1, 0)`. The strike of an epoch that has `W` queued withdrawal shares, `B` of them burnt and `P` assets paid does:

```
record.r_before, record.v_before = chain_r, chain_v
chain_v += chain_r × P / W
chain_r  = chain_r × (W − B) / W
record.r_after, record.v_after   = chain_r, chain_v
```

The chain **ends** when the strike pays in full, `B = W`, which leaves `chain_r = 0`; the next chain starts at `(1, 0)`. A rationed strike leaves `chain_r` at least a millionth of what it was, never 0. Every rationed strike shrinks `chain_r`, and a request that enters late divides by a small `r_before`: each strike's rounding of `chain_v` then costs it up to `s / r_before` assets. So the chain **splits** as soon as a rationed strike would leave `chain_r` below 10⁻⁶, `CHAIN_R_MIN = 10¹²` in fixed point: that record keeps the old chain's indices, and a new chain starts at `(1, 0)` with the rolled shares and every request of the old one. Since a running chain never has `chain_r < 10¹²`, a request is never short by more than a unit plus `s / 10¹²` per strike it reads — 5 micro-USDC per strike on 5 000 USDC of shares at the founding price.

A withdrawal of `s` shares that entered at epoch `k` and is claimed at epoch `m`, in the same chain:

```
received      = s × (v_after[m] − v_before[k]) / r_before[k]
still queued  = s × r_after[m] / r_before[k]
```

Two records, whatever the length of the chain. The first claim copies the entry record's chain and indices into the request, and every claim records the assets paid so far, so an early partial claim followed by a final one pays exactly what a single final claim would. A claim may only read a record of the chain its request is in: the indices of another chain are unrelated to its shares. At a split record the claim is a **transition**: it pays what the old chain owes, then carries the request into the new chain — its shares become `still queued`, its indices `(1, 0)`, its chain the new one — and a later claim reads the new chain's records. A request that waited through a split needs one transition claim per split before its final claim; a keeper sends them together. Every division floors, so claims can never pay out more than the strikes moved to `payable_usdc`. Worked example, the strike of [Spec 01](01-vault-and-lp-accounting.md) §3.5 continued: 500 shares owed 510 USDC receive 400 at epoch `k`; at `k + 1` the vault has earned 30 USDC and the remaining 107.843136 shares are owed and paid 110.702126. One claim through the indices pays **510.702126 USDC**, the exact total.

Each record counts the requests whose claims will still read it: its own, and, for the record that ends or splits a chain, those that entered the chain at an earlier epoch. A request's first claim releases its entry record, which it never reads again, and its final or transition claim releases the record that ends or splits the chain; one claim that is both releases that record once. The claim that brings a record to zero closes it and returns its rent to whoever advanced it. Deposits never roll.

## 6. Fees on the liquidity-provider side

| Fee | Paid by | Paid to | Amount |
| --- | --- | --- | --- |
| `CLAIM_FEE` | every request, held in its own account | whoever executes its final claim, parked or not | 200 000 lamports |
| `STRIKE_FEE` | every request, **only while the strike fund is below `FUND_TARGET`** | the strike fund | 200 000 lamports |
| `STRIKE_REWARD` | the strike fund | whoever strikes, once per epoch | 200 000 lamports |
| `EpochRecord` rent | advanced by the strike fund | returned to it when the record closes | 1 717 040 lamports |
| Request rent | the owner | returned to the owner at the claim | 990 600 or 1 234 440 lamports |

`FUND_TARGET` is 50 000 000 lamports, 0.05 SOL: the round figure above 26 strikes and their records. The fund is seeded to it at `initialize`, and never falls below the `Queue`'s own rent-exempt minimum.

- **A liquidity provider makes one move.** A keeper strikes because it is paid to, then claims because each request pays its own claimer. The shares or the USDC arrive in the owner's wallet about ten minutes after the request, and the request's rent comes back in the same transaction. Beacon rounds delay it about as long as direct tickets do: a round enters the epoch accounting when it is paid, and only a round paid before the close holds the strike, at most `tick_slots + t_settle_slots` plus its settlement ([Spec 09](09-shared-beacon.md) §9, §13.7). An owner who claims for themselves collects their own `CLAIM_FEE`.
- **What it costs.** 200 000 lamports per request, 0.0002 SOL, with the fund full; 400 000, 0.0004 SOL, while it refills — 0.023 and 0.047 USD at 117 USD/SOL (23 September 2026).
- **At ten thousand requests** the strike is still paid its flat reward. Paying the strike per request instead would hand one O(1) transaction 2 SOL, while the ten thousand claims went unpaid.
- **At a single request** the strike is still paid. The record's rent, which a single request's strike fee would not cover — nine requests would be needed — is an advance from the fund, returned within minutes once the claims are made.
- **In a rush of withdrawals** the continuation epochs that serve rationed withdrawals are paid from the fund, though no new request prepaid them.
- **Spam.** Requests start paying into the fund again as soon as it dips below its target, so a spammer who opens epochs to collect their rewards can extract about one reward before paying for the next. A request is at least 1 USDC deposited or 1 share withdrawn, or the owner's whole share balance, so that no position is ever stranded below the minimum. While no share exists, a deposit is at least `min_first_deposit`.
- **The fund advances the record's rent, never more.** The record's address is known in advance; lamports someone sends to it before the strike stay on the record and go to its rent payer when it closes, so they can never pull more than the rent out of the fund.
- **Should the fund ever hold less than the record's rent**, the striker's advance stays an advance: the record names the striker as its rent payer and returns the rent to it when it closes. The reward is whatever the fund can still pay, up to `STRIKE_REWARD`, and requests refill the fund from the next one on.

## 7. Parameter changes

[Spec 05](05-governance.md) §3 gives every parameter a class: tightening is immediate, and loosening waits 24 hours, 7 days for a cut of the LP floor, or 72 hours for the treasury. The program enforces it with one pending change in `Config`, `{ params, protocol_treasury, effective_at }`:

- `set_params`, council only: if every field that changes tightens, the change applies at once. Otherwise it becomes the pending change, with `effective_at` set by the longest delay among the fields it loosens. A new `set_params` replaces a pending one and restarts its clock.
- `apply_params`: anyone, at or after `effective_at`; it checks the pending parameters against the program's ranges again (`InvalidParams`), so that a change queued before a range was narrowed cannot land outside it.
- `cancel_params`: council only.

Applying a change, at once or through `apply_params`, writes the parameters and the treasury together. The development build (`no-timelock`, which requires `devnet`) applies every change at once, the treasury included, and replaces any pending change by applying it. κ is checked against a program floor of 0.8 (`MIN_KAPPA_BPS`), and every change to it waits 24 hours ([Spec 05](05-governance.md) §3).

The ORAO program id is a constant of the program and changes only through an upgrade, behind the 72-hour timelock.

## 8. The drawdown breaker's state

The breaker of [Spec 04](04-risk-and-exposure.md) §7.3 measures **the price of a share on settled assets**, `(total_assets − open_vault_credits + 1) / (total_shares + 10³)`, not `total_assets`. A strike's deposits and withdrawals leave it unchanged up to rounding, and so does opening a ticket, whose credit the vault owns but may pay back: it moves only with the vault's results. A large withdrawal does not look like a loss, and a wave of open tickets does not raise a peak that their ordinary settlement would then seem to fall from.

`Vault` keeps a ring of 24 hourly maxima of that price, in fixed point, and the hour at its head. Every instruction that changes the vault's assets updates the current hour, rotating the ring and filling the hours with no observation with the price that held during them. `open_ticket` refuses while the price is at or below 85 % of the ring's maximum, which is 24 comparisons, a few hundred compute units. A strike clears at a price that leaves out the after-close results of §4 rule 5, so while such results are pending its deposits and withdrawals do move the settled price: the holders who stay absorb the part of a post-close loss the leavers did not. That is a transfer between liquidity providers, not a result, so the strike scales the whole ring by the same factor as the price: every ratio to the 24-hour maximum is what it was before the strike, and a loss already observed still counts. A settlement that leaves the price there records the time: the peak leaves the window within a day, new tickets then resume, and their caps stay halved until 48 hours after that time, one clean day after the resumption.

## 9. Throughput

A block can spend at most 12 million compute units on transactions that write any one account, even since the block limit rose to 100 million on 29 July 2026 ([Solana — 100M CU blocks](https://solana.com/upgrades/100m-cu-blocks)). The sides of §1 are therefore budgeted separately.

The compute costs below are measured on the program, built for SBPF v3 and run in LiteSVM on the mainnet feature set (`programs/fade/tests/vault.rs`, `compute_units_of_every_instruction`).

| Side | Measured cost | Per block | Per second, 400 ms slots | Per second, 350 ms slots |
| --- | --- | ---: | ---: | ---: |
| LP requests | 75 810 CU, the dearest (`request_deposit`, creating the owner's share account) | 158 | 395 | 451 |
| LP claims | 27 947 CU, the dearest (`claim_withdraw`) | 429 | 1 072 | 1 226 |
| Tickets, open plus settle | 99 531 CU per cycle (64 274 + 35 257, two outcomes) | 120 | 300 | 343 |
| Beacon tickets, join plus a share of a batch | about 66 700 CU per ticket (55 441 into an existing round + 11 289, a 21-ticket batch) | 179 | 449 | 513 |

The other instructions measure: `request_withdraw` 39 681, `strike_epoch` 77 453, `claim_deposit` 25 671, `request_randomness` 33 106 with the ORAO CPI. A 32-outcome payout table raises `open_ticket` to 74 125 and `settle_ticket` to 39 498, and its `open_ticket` transaction, signed by a player acting as its own integrator, is 1 153 bytes: inside the 1 232 bytes of a legacy or v0 transaction, so the direct path needs neither an address lookup table nor a version 1 transaction (4 096 bytes), which the beacon's settlement batches use (§13.5.7).

The beacon row is measured in `programs/fade/tests/beacon.rs` (`join_round::compute_units_and_sizes`, `settle_round_tickets::compute_units_and_sizes`; §13.5.7 has the batch sizes): `Vault` is written once at the join and once per batch, so a ticket weighs its join and a 21st of its batch. Settlement fixed costs fall with larger batches, to 10 855 units a ticket at 32; a batch of one costs 42 894. The direct path's own figures moved with the factoring of admission (`open_ticket` 59 044, a cycle of 94 808); the table keeps the figures this section was written with.

The ticket side, 26 to 30 million tickets a day, is the V1 ceiling and is documented as such. `request_randomness` writes only the ticket and ORAO's accounts, so it does not count against it. The first optimisation, if it is ever needed, is to accrue the protocol and app shares inside `vault_usdc` and sweep them in batches, removing two token transfers from every `open_ticket`. The strike is O(1) and does not appear in the table.

## 10. The V1 instruction set

- **Governance**: `initialize`, `set_params`, `apply_params`, `cancel_params`, `set_pause_flags`, `set_share_metadata` (council only: the share mint's name, symbol and logo in wallets, through Metaplex Token Metadata).
- **Integrators**: `set_share_account`. There is no registration instruction: an integrator's record is created by its first `open_ticket` or `join_round`.
- **Tickets**: `open_ticket`, `record_ticket_entropy`, `request_randomness`, `settle_ticket`, `expire_ticket`, `refund_expired_ticket`, `claim_payout`, `sweep_ticket_vrf`.
- **Liquidity providers**: `request_deposit`, `request_withdraw`, `strike_epoch`, `claim_deposit`, `claim_withdraw`.
- **Shared beacon** ([Spec 09](09-shared-beacon.md)), specified in §13: `register_payout_table`, `join_round`, `sponsor_round`, `refund_round`, `request_round_draw`, `record_round_entropy`, `settle_round_tickets`, `expire_round`, `return_round_ticket`, `reclaim_sponsorship`, `claim_round_payout`, `claim_shares`. One round account rather than shards, `Vault` being the account that binds throughput (Spec 09 §7).

No bond instruction exists ([Spec 04](04-risk-and-exposure.md) §4).

## 11. Designs considered and rejected

| Design | Why not |
| --- | --- |
| Epochs numbered by the clock, struck one by one, empty ones included | After a quiet night, dozens of unpaid strikes before the next price; during play each one also waits for the tickets open at its boundary |
| One queue for every epoch not yet struck | A request made after a close would be priced with the earlier epoch, whose price does not wait for tickets opened after that close: the leak the clean strike closes |
| A strike that fills every request | Linear in the requests: the vault could no longer close an epoch exactly when it is busiest |
| An instant price with fees and delays, as in GMX | A window remains in which a known outcome can be traded against |
| Solana epochs as windows | One to two days per price, and a length that shrinks as slots do, outside Fade's control |
| Windows counted in slots | Safe, but they drift against the clock people read, as slot times change |
| Epoch prices in a ring buffer instead of records | A claim made after the ring has turned would lose its price |
| Keeper rewards in USDC | Two currencies for one kind of work; every other crank fee is in SOL |
| Shares accrued inside the vault | A throughput optimisation not needed at V1 volumes (§9) |

## 12. Properties for an auditor

1. **Separation.** No ticket instruction writes `Queue` or a liquidity-provider token account; no liquidity-provider instruction writes `Vault` except `strike_epoch` and a request that opens an epoch.
2. **At most two live epochs**, and a request lands in `current` exactly when it is made before `current.close_ts`.
3. **No strike with a ticket opened before its close still open**, after any sequence of opens, settlements, expiries, requests and strikes; the counters and the generation are conserved.
4. **Constant cost**: the compute of `strike_epoch`, `claim_deposit` and `claim_withdraw` is independent of the number of requests, of tickets and of epochs in a chain.
5. **Claims pay the pro-rata share, never more**: over any sequence of strikes, splits and claims, what claims pay out is at most what strikes moved to `payable_usdc` and `share_claims`; each withdrawal receives its exact pro-rata share of every strike it waited through, less a unit per claim and `s / 10¹²` per strike; a partial claim followed by a final one pays what one final claim pays; and a chain ends exactly when a strike pays its whole queue.
6. **Records close exactly** when their count reaches zero, and the fund recovers their rent.
7. **The fund** never falls below the `Queue`'s rent-exempt minimum, and requests pay `STRIKE_FEE` exactly while it is below `FUND_TARGET`.
8. **Parameter queue**: a change that only tightens applies at once; any loosening waits its longest class delay; `apply_params` before `effective_at` fails; a change of `kappa_bps` waits 24h either way; κ below `MIN_KAPPA_BPS` is refused, by `set_params` and by `apply_params`.
9. **Drawdown**: a strike that pays out 20 % of assets in withdrawals leaves the breaker untouched, after-close results pending or not; a 15 % fall of the share price within 24 hours trips it; caps are halved for the clean day after the peak leaves the window.
10. **Settled pricing**: a ticket opened after an epoch's close leaves that epoch's strike price unchanged, whether it is still open at the strike or was settled or expired before it, won or lost.
11. **No stray transfer or pre-created request blocks a ticket**: lamports sent to a ticket's ORAO request address, or a request anyone created there first through ORAO — `request_v2`, or the deprecated `request`, which still creates a legacy account at the same address — leave `request_randomness` able to succeed and the ticket able to settle once ORAO answers; and a fulfilled request someone created there is never forfeited: `expire_ticket` refuses it and `request_randomness` binds it after the window.
12. **No owner account holds a record open or its funds**: a claim whose destination cannot receive — closed, frozen, or handed to another owner — still releases every record it reads, and delivers later, to that account or, with the owner's signature, to another of the owner's.
13. **No worthless queue lives on**: shares owed zero assets are burnt at their strike, so no epoch stays live, and no strike is paid, without a request behind it.
14. **The shared beacon** preserves the twelve invariants of §13.8, proved by the tests listed there.
15. **The direct twin of invariant 10**: `expire_ticket` refuses a ticket whose request at its seed is fulfilled with a non-zero value, requested or not; an Open ticket is expired only with its seed recorded and the derived request address named; one whose seed was never recorded and whose `s*` SlotHashes no longer proves is refunded its vault credit, never forfeited; every expiry a withheld draw may explain counts in `Vault.ticket_forfeits_withheld` (`programs/fade/tests/direct_expiry.rs`).
16. **Nothing is stranded on `vrf_payer`**: before the close it moves onto the ticket, whose close carries it to the payer, after it `sweep_ticket_vrf` moves it to its caller (`programs/fade/tests/sweep_ticket_vrf.rs`).
17. **No address stored at open can hold a ticket's exit**: a ticket's payer, a round's rent payer and an epoch record's are credited directly, never handed to a CPI, so one emptied and turned into an upgradeable program after the open still receives its lamports, and the ticket still leaves its counter (`programs/fade/tests/executable_payer.rs`, `beacon.rs` `a_payer_turned_program_never_fails_a_batch`). The runtime does not copy a CPI's lamport change on an executable account back into the caller's view, so a CPI credit followed by a direct one fails the instruction as unbalanced.

## 13. Shared beacon: accounts and instructions

Status: **implemented** (14 and 15 October 2026), documented on 15 October 2026 and reviewed adversarially on 17 October 2026. Written on 7 October 2026 from [Spec 09](09-shared-beacon.md). Where Spec 09 turned out ambiguous or contradictory once every account and check was written down, §13.10 says so; the team decided all thirteen points on 7 October 2026, two of them differently from the first recommendation (point 3, capacity measured per ticket against its own cap; point 4, no cancellation). This section specifies the decisions, and nothing else departs from Spec 09. Rents are at SIMD-0437's last step, 696 lamports per byte counted with 128 bytes of overhead, with today's 5 080 where the difference matters. Compute units and transaction sizes are measured (each instruction's module of `programs/fade/tests/beacon.rs`, the client's `tests/ts/fade/beacon.test.ts`, the devnet runs of 15 October 2026); a figure marked *estimated* is the estimate written before the build, kept beside its measurement. Clients and keepers send beacon transactions as version 1 transactions without any address lookup table, or plain v0 without one where v1 is not accepted (§13.5.7). The parameter values are the Technical Specification's §2 table, Shared beacon.

### 13.1 What carries over from the direct path

- **Admission is `open_ticket`'s, on entry.** `join_round` runs the same code: the payout table invariant, `check_split`, `risk::ticket_for`, `risk::admit` (per-ticket cap, integrator ceiling, utilisation breaker, κ, gross solvency) and the drawdown ring, against the live parameters. Settlement re-checks none of it and reads no live parameter: what it needs is on the ticket or snapshotted on the round.
- **Constant cost.** Every round-level instruction (`refund_round`, `request_round_draw`, `record_round_entropy`, `expire_round`) is O(1) in the number of the round's tickets. Per-ticket work (join, return, settlement) is done per ticket, and only settlement is grouped.
- **Paid work.** The request is paid by the request share, settlement and the return of a forfeited ticket by the ticket's settlement share. Refunding, returning a refunded ticket, sponsoring, reclaiming a sponsorship and claiming shares pay nobody: whoever has an interest pulls, and a keeper may push.
- **No way out but the round's end.** A ticket that has joined stays until its round is drawn, refunded or forfeited: there is no cancellation (§13.5.4). Every aggregate of a round therefore only grows until the draw, and so does the capacity it has paid for.
- **Two sides.** No beacon instruction writes `Queue` or a liquidity-provider token account. `strike_epoch` is unchanged (§13.7).
- **Pinned accounts.** Every account is pinned by seeds, `address` or a stored key. Only `settle_round_tickets` takes remaining accounts, in a fixed layout checked one by one; every other beacon instruction rejects them, as V1 does.
- **Never paused**: refund and returns, the draw request, settlement, expiry, reclaims, `claim_round_payout` and `claim_shares` (Technical Specification §5, Custody 2). Sponsorship of a `Paid` round is never paused either; sponsorship of an `Accepting` round stops with joins (§13.5.3), so that a pause leaves an unpaid round to its full refund.

### 13.2 Accounts

| Account | Seeds | Written by | Lifetime | Rent |
| --- | --- | --- | --- | --- |
| `PayoutTable` | `["payout-table", hash]` | `register_payout_table` | never closed; immutable | the registering payer, for good: 492 072 lamports for a 32-outcome table |
| `Round` | `["round", round_id]` | every beacon instruction but `register_payout_table`, `claim_round_payout` and `claim_shares` | closed by the instruction that leaves it terminal with no ticket and no sponsorship (§13.2.2) | advanced by the payer of the join that creates it, 375 144 lamports (2 738 120 at today's rent), returned at close with the round's rounding dust |
| `round_vrf` | `["round-vrf", round]` | `request_round_draw`, the first `settle_round_tickets`, `expire_round`, `sweep_round_vrf` | system-owned, holds lamports between the request and the drain, and whatever reaches it after the drain until a sweep | none: empty outside that window, but for what a sweep moves |
| `RoundTicket` | `["round-ticket", integrator, nonce]` | `join_round`, `settle_round_tickets`, `return_round_ticket`, `claim_round_payout` | closed at settlement or return; by `claim_round_payout` when a payout or a return was parked | its payer, 291 624 lamports (2 128 520 today), returned at close |
| `Sponsorship` | `["sponsorship", round, sponsor]` | `join_round` (when it carries a sponsorship), `sponsor_round`, `reclaim_sponsorship` | closed by `reclaim_sponsorship` | the sponsor, 129 456 lamports, returned at close |

The nonce of `RoundTicket` is the integrator's `next_nonce`, shared with the direct path: one sequence per integrator, so a ticket's identifier is unique across both paths. Sizes below include Anchor's 8-byte discriminator and are pinned by `programs/fade/tests/layout.rs`. A rent is an account's rent-exempt minimum, `(size + 128) × lamports per byte`, the 128 bytes being the runtime's per-account overhead. Figures are at 696 lamports per byte, SIMD-0437's last step; "today" means 5 080, the rate since its second step; before SIMD-0437 it was 6 960, 3 480 per byte-year over the two-year exemption. `layout.rs` pins each figure at 696.

#### 13.2.1 `PayoutTable` (579 bytes)

`version`, `bump`, `len: u8`, `lhs: u128` (`Σ p·m`, from `payout_table::validate`), `max_m: u64`, `hash: [u8; 32]`, `outcomes: [Outcome; 32]`. The hash is `SHA256("FADE/PAYOUT-TABLE/v1" ‖ len ‖ p₀ ‖ m₀ ‖ … ‖ p_{len−1} ‖ m_{len−1})`, little-endian `u64`s. The account is the lean ticket's payout table stored once (Spec 09 §8): a ticket stores its address, 32 bytes, against 512 bytes of outcomes on the direct path. It holds no share and no margin floor: those depend on the ticket's app share and the live parameters, and `join_round` checks them.

#### 13.2.2 `Round` (411 bytes)

| Group | Fields |
| --- | --- |
| Identity | `version`, `bump`, `vrf_bump`, `status: u8`, `id: u64`, `rent_payer: Pubkey` |
| Clock | `first_slot` (slot of the first join), `paid_slot`, `close_slot` (0 until paid); `last_join_slot` (slot of the latest join, which the refund window counts from; stored after `drawn_randomness`, in the spare tail, so a round written before it reads 0 and counts from `first_slot`) |
| Snapshot at creation (Spec 09 §3) | `threshold` (`T_r`, USDC), `draw_max` (`D_r`, lamports, §13.4), `round_k: u8`, `min_price`, `settle_share`, `request_share`, `tick_slots`, `refund_slots`, `t_settle_slots`, `drawdown_bps` |
| Aggregates | `prices` (`R`), `sponsorship` (`S`), `liability`, `credits`, `protocol_shares`, `app_shares`, `prepaid` (Σ prepays not yet returned), `usage` (`U`, Σ of the tickets' capacity usage, §13.4), `tickets: u32` (joined and not yet settled or returned), `sponsors: u32` (sponsorships not yet reclaimed) |
| Epoch | `counted: bool`, `side: u8`, `generation: u32` (§13.7) |
| Draw | `randomness: Pubkey` (the ORAO request), `seed: [u8; 32]` and `entropy_slot` (`s*`; both zero until recorded, by `record_round_entropy` or the request, §13.5.6a; a recorded entropy slot is never 0), `funded` (lamports moved to `round_vrf` for the request), `draw_cost` (`C`, §13.4), `drawn_randomness: [u8; 64]` (`R`, kept by the first settlement, zero until then) |
| Spare | `_reserved: [u8; 24]` |

The entropy hash is not stored: it is in the `RoundEntropyRecorded` or `RoundDrawRequested` event of the instruction that recorded the seed (the layout keeps its 411 bytes). The randomness is: the first settlement reads it from the ORAO account and keeps it, and every later batch reads it from the round. A `Drawn` round has no way out but settlement (`expire_round` refuses it), so its liveness must not depend on ORAO's account staying alive, ORAO's, and in the layout `orao_layout` parses for as long as a keeper takes to settle every ticket, possibly days (invariant 10). Every batch still names the request account, checked by address only after the first.

Lifecycle. "Closed" is not a stored state: a `Paid` round is closed from `close_slot` on, computed from state (Spec 09 §3).

| Status | Meaning | Entered by | Left by |
| --- | --- | --- | --- |
| `Accepting` | unpaid; accepts joins and sponsorship | the join that creates it | `Paid` (join or sponsorship), `Refunded` |
| `Paid` | draw covered; accepts joins and sponsorship while `slot < close_slot`; no refund by `refund_round` | `join_round`, `sponsor_round` | `Requested`, `Forfeited`, `Refunded` (`expire_round`, §13.5.8: seed never recorded, SlotHashes no longer proving `s*`) |
| `Requested` | ORAO request sent | `request_round_draw` | `Drawn`, `Forfeited` |
| `Drawn` | randomness read and kept on the round, draw cost fixed; tickets settling | the first `settle_round_tickets` | close |
| `Refunded` | unpaid round refunded, or a paid one whose draw can no longer be looked for; tickets being returned | `refund_round`, `expire_round` | close |
| `Forfeited` | closed round unrequested or unfulfilled at `T_SETTLE` | `expire_round` | close |

A round closes — its account closed, its lamports to `rent_payer` — in the instruction that leaves it `Drawn`, `Refunded` or `Forfeited` with `tickets == 0` and `sponsors == 0`. That instruction needs `rent_payer` among its accounts and fails with `RentReceiverRequired` (6048) otherwise; a keeper adds it to the transaction that settles or returns a round's last ticket.

#### 13.2.3 `round_vrf`

A system-owned PDA, `["round-vrf", round]`, the address ORAO debits. Prepays and sponsorship are held on `Round`, not here (§13.10 point 2): `request_round_draw` moves into it exactly what ORAO takes, so it is empty again after the request, ORAO's rent refund at fulfilment lands on it, and the first settlement or `expire_round` drains it back to `Round`. A system account below its rent-exempt minimum would fail the transaction that leaves it so; this way it is only ever empty or holding ORAO's refund. What reaches it after its drain, ORAO's refund for a request it fulfils after `expire_round` forfeited the round, or lamports anyone sends, is moved by `sweep_round_vrf` (§13.5.8a): into the round while it exists, to the caller once it has closed.

#### 13.2.4 `RoundTicket` (291 bytes)

`version`, `bump`, `status` (`Joined`, `PayoutParked`, `ReturnParked`), `round: u64` (the round's id), `integrator`, `nonce`, `payer`, `funder`, `refund_to` (the funder's token account, Spec 09 §3), `beneficiary`, `payout_table` (the `PayoutTable` address), `price`, `vault_credit`, `payout_max`, `liability`, `protocol_share`, `app_share`, `prepay` (lamports, held on `Round`), `settle_share` (lamports, held on this account above its rent), `payout` (set when parked).

Against the direct `Ticket`'s 859 bytes, 686 952 lamports of rent, this is 291 624: the float a payer fronts per ticket is cut by 58 %, and by more on repeat tickets, whose payout table is already registered. It carries no ORAO state, no seed, no epoch side and no snapshot of caps or margins: the round holds what is common, and settlement needs nothing else.

#### 13.2.5 `Sponsorship` (58 bytes)

`version`, `bump`, `round: u64`, `sponsor: Pubkey`, `amount: u64`. One per sponsor and round; a second sponsorship by the same sponsor tops it up. It exists because what returns to sponsors is pro rata, and a refund returns all of it (Spec 09 §5), while no instruction may iterate over sponsors.

#### 13.2.6 Additions to existing accounts

`Vault` takes eight fields from its `_reserved` tail, which falls from 112 to 48 bytes; its size and every existing offset are unchanged:

| Field | Meaning |
| --- | --- |
| `accepting_round: u64` | id of the round accepting tickets, or 0 |
| `next_round_id: u64` | id the next round created receives; starts at 1 |
| `beacon_shares_held: u64` | protocol and app shares of beacon tickets joined and not yet settled, returned or forfeited |
| `protocol_shares_accrued: u64` | protocol shares of settled and forfeited beacon tickets, not yet claimed |
| `app_shares_owed: u64` | Σ of every `Integrator.app_shares_accrued` |
| `beacon_returns_owed: u64` | ticket prices of refunded rounds' tickets not yet returned |
| `rounds_forfeited: u64` | rounds `expire_round` has forfeited, ever |
| `forfeits_withheld: u64` | the expiries a withheld draw may explain: every forfeiture but `!requested && checked && !request_found`, and every round `expire_round` refunded (`RoundExpired.refunded`, §13.5.8; *changed on 17 October 2026*, fifth audit pass). *Added on 16 October 2026* (final audit): the keeper's `withheld-draw` alarm compares this durable count, never transaction history anyone can bury |

Since the audit fixes of 22 October 2026 a ninth field comes from the tail, which falls to 40 bytes, size unchanged: `ticket_forfeits_withheld: u64`, the direct expiries a withheld draw may explain, by the same rule (`TicketExpired`'s `requested || request_found || !checked`, every `refund_expired_ticket` included), kept apart from `forfeits_withheld` so that each path's alarm accounts for its own ordinals ([agent audit of 22 October 2026](../audit/2026-10-22-agent-audit.md)).

`Integrator` takes `app_shares_accrued: u64` from its `_reserved` tail (64 to 56 bytes): app shares of its settled and forfeited beacon tickets, not yet claimed.

`Config` gains the pause bit `PAUSE_ROUNDS = 1 << 3`, included in `PAUSE_ALL`, and six parameters appended to `RiskParams` (§13.3). `RiskParams` sits twice in `Config`, in `params` and in `pending.params`, so `Config` grows by 96 bytes and its layout version becomes 2: a breaking change for the devnet deployment, harmless before mainnet (§13.10 point 12).

### 13.3 Parameters

Appended to `RiskParams`; every one is snapshotted by a round at its creation (Spec 05 §3).

| Field | `SPEC` value | Valid range | Loosening, delayed 24 h |
| --- | --- | --- | --- |
| `beacon_min_price` | 500 000 (0.50 USDC); grouped settlement, measured on 14 October 2026, supports 100 000 (0.10 USD) with a 5 000-lamport settlement share and a 9.79 USDC threshold, a lowering the team decides (Spec 09 §8) | `1 ≤ v ≤ max_price` | lowering |
| `beacon_threshold` | 8 640 000 (8.64 USDC, Spec 09 §3) | `beacon_min_price ≤ v ≤ max_price` | lowering |
| `round_k` | 1 | `1 ≤ v ≤ MAX_ROUND_K`, a program constant equal to 1 | raising |
| `tick_slots` | 37 | `1 ≤ v ≤ 150` | shortening |
| `refund_slots` | 1 715 | `tick_slots ≤ v ≤ 20 000` | shortening |
| `crank_round_settle_lamports` | 20 000 | `1 ≤ v ≤ crank_settle_lamports` | either way: it is the settlers' pay, which liveness depends on, like `strike_reward_lamports` |

`T_SETTLE` and the request share are the existing `t_settle_slots` and `crank_request_lamports`; a round snapshots both. `MAX_ROUND_K = 1` makes raising `k` an upgrade, behind the 72-hour timelock, rather than a parameter change: Spec 09 §7 ties it to stronger randomness, which is itself an upgrade. The round's `drawdown_bps` is also snapshotted, so that settlement records a trip without reading live parameters, as on the direct path.

### 13.4 Arithmetic

All of it lives in a new `fade_math::beacon` module, integer only, `u128` intermediates, mirrored in `scripts/oracle/fade_ref.py` with vectors.

| Quantity | Definition | Rounding |
| --- | --- | --- |
| Draw prefund `D_r` | at creation: `2 × fee + rent(PENDING_LEN) + request_share`, with `fee` read from ORAO's network state and the rent of a pending request (749 bytes) from the Rent sysvar: 1 660 392 lamports at the last SIMD-0437 step, 5 505 160 today | exact |
| Prepay of a ticket | `ceil(D_r × price / T_r)`: 192 175 lamports for 1 USDC at 8.64 USDC | up |
| Paid | `R × D_r + S × T_r ≥ T_r × D_r` | exact |
| Usage of a ticket `u` | `ceil(l × USAGE_SCALE / cap)`, `USAGE_SCALE = 10⁹`, with `l` its liability and `cap` the per-ticket cap `risk::admit` applied to it: its own vault margin, the free balance before its join, halved in a drawdown aftermath. 0 when `l = 0`; at most `USAGE_SCALE`, since admission refuses `l > cap` | up |
| Capacity | with `R`, `S` after the join (its `price` and `sponsorship` included) and `U` the round's usage before it: once paid, `U + u ≤ k × USAGE_SCALE`; unpaid, `(U + u) × T_r × D_r ≤ k × USAGE_SCALE × (1 − h) × (R × D_r + S × T_r)`, `h` = `UNPAID_HEADROOM_BPS` = 1 000 bps. That is `Σ l_i / cap_i ≤ k` paid and `≤ (1 − h) · k · (R/T_r + S/D_r)` unpaid, without a division: every ticket's liability counted as a fraction of its own cap. The bound only grows with `R` and `S` and jumps from below `(1 − h) · k` to `k` at the payment, so the join that pays a round always has `h · k` caps of room (Spec 09 §7, the headroom). Every join, paid round or not, must also be within its own share: `u × T_r × D_r ≤ k × USAGE_SCALE × min(T_r × D_r, price × D_r + sponsorship × T_r)` with this join's own `price` and `sponsorship`, or, for the join that makes the round paid (unpaid before it, paid after), `u ≤ h · k × USAGE_SCALE` (`within_join_share`; *added on 17 October 2026*, second final audit, for joins leaving the round paid; *extended the same day*, fourth pass, to every join; *the floor narrowed on 24 October 2026* to the paying join): a round's room, before the payment or after it, costs the payment that buys it, not tickets at the minimum price. The products are `u64 × u128` and compared in 192 bits, so no input overflows | exact |
| Close slot | `(paid_slot / tick_slots + 1) × tick_slots`: the first tick boundary strictly after the paid slot | floor |
| Sponsorship that pays the round | `ceil(D_r × (T_r − R) / T_r) − S`, 0 once paid: what a sponsor, or a join's own sponsorship, adds to make the round paid at once | up |
| Draw cost `C` | `funded + request_share − min(refund, funded)`, with `refund` the lamports drained from `round_vrf` after the request | exact |
| Charge of a ticket | `ceil((C − min(S, C)) × price / R)` | up: Σ charges ≥ `C − min(S, C)` |
| Return of a sponsor | `floor((S − min(S, C)) × amount / S)`; all of `amount` in a refunded round | down |
| Seed | `SHA256("FADE/BEACON-SEED/v1" ‖ program ‖ round ‖ close_slot ‖ s* ‖ h*)`: `round` the `Round` account's address, slots little-endian `u64`, `s*` the first slot after `close_slot` in SlotHashes and `h*` its hash; `beacon::seed_preimage` builds the 131 bytes | — |
| Outcome | `SHA256("FADE/BEACON-OUTCOME/v1" ‖ program ‖ round ‖ ticket ‖ R ‖ i)`, `R` the 64-byte randomness and `i` a `u8`, then `select::draw` and `select::outcome` as Spec 02 §6; `beacon::outcome_preimage` builds the 183 bytes | — |

Four facts the module proves and its property tests check:

1. **No ticket is charged more than it prepaid.** A paid round has `R × D_r ≥ T_r × (D_r − S)`, and `C ≤ D_r` because the request refuses a draw costing more (§13.5.6). Then `(C − min(S, C)) / R ≤ D_r / T_r`, and rounding both sides up preserves it. The same steps give the tighter bound `(C − min(S, C)) / R ≤ C / T_r`, since `(C − S) × D_r ≤ C × (D_r − S)` when `C ≤ D_r`: a ticket of a paid round is charged at most `ceil(C × price / T_r)`, its share of the real cost at the threshold, so the 150 bps design point of Spec 09 §3 holds exactly at the `C` the threshold was computed from and nowhere else. The program enforces only the prepay; a rent or fee above that `C` charges more, up to the prepay, without an error.
2. **The round never pays out more than it holds.** It holds `Σ prepay + S`, pays `C` to the draw, and returns `Σ (prepay − charge)` plus the sponsors' floors; `Σ charge + min(S, C) ≥ C`. What is left, under one lamport per ticket plus any lamports sent to the round from outside, is the dust `rent_payer` receives at close.
3. **The shares are the direct path's.** `protocol_share` and `app_share` are `payout_table::share_of(price, bps)`, floored per ticket, and `vault_credit = price − shares`; a round's share aggregates are sums of per-ticket floors, never a floor of a sum, so a ticket's return is exactly what it paid in.
4. **Capacity never decreases, and what a round holds never exceeds one cap of risk.** `R` and `S` only grow until the draw (no cancellation, sponsorship withdrawn only after it), so the right-hand side of the capacity rule only grows, and a rule checked at each join holds for good. Each `u_i ≥ l_i / cap_i`, so `Σ l_i ≤ Σ u_i · cap_i / USAGE_SCALE ≤ k · max_i cap_i`: a corrupted draw, which decides every ticket of the round at once, costs the vault at most `k` times the most generous per-ticket cap any of its tickets was admitted against, itself at most `censorship_bps · assets` at that join. A ticket joining with a small margin has a small cap and uses more of the round, never less, and leaves every other ticket's usage unchanged.

`fade_math::epoch::Counters` gains `open_n(now, n)` and `close_n(side, generation, n)`: the existing rules applied to `n` tickets at once, for the O(1) recording of a round and its forfeiture.

### 13.5 Instructions

Accounts are listed signers first; "w" is writable, "s" signer. Every instruction also takes the event authority and the program for `emit_cpi!`, and every event carries `version` first, set from `EVENT_VERSION` (1 for all the new events). Checks run in the order given; a failed check reverts the instruction before any token or lamport moves.

#### 13.5.1 `register_payout_table(outcomes: Vec<Outcome>)`

Anyone, once per payout table; never paused, since it moves no funds.

- **Accounts:** `payer` (w, s), `payout_table` (w, `["payout-table", hash(outcomes)]`), `system_program`.
- **Checks:** `payout_table::validate(outcomes)`: `OutcomeCount`, `ProbabilityRange`, `ProbabilitySum`, `MultiplierCeiling`, `PayoutTableOverpays`. The hash is computed from the argument, never taken from the caller.
- **Effects:** creates the account if absent and stores `len`, `lhs`, `max_m`, `hash`, `outcomes`. If it exists, the instruction succeeds without writing, so a client may prepend it to a join unconditionally. Pre-funded lamports at the address are tolerated, as Anchor's `init` does.
- **Event:** `PayoutTableRegistered { payout_table, hash, len, lhs, max_m, outcomes }`, on creation only.

A 32-outcome payout table is 524 bytes of instruction data: its registration does not fit in the join's transaction, and is done once beforehand.

#### 13.5.2 `join_round(price: u64, app_share_bps: u64, nonce: u64, sponsorship: u64)`

Signed by the integrator and by the funder, as `open_ticket`.

| Account | | Constraint |
| --- | --- | --- |
| `integrator_authority` | s | the integrator's identity (Spec 07 §2) |
| `payer` | w, s | pays the ticket's rent, the prepay, the settlement share, the sponsorship and, if the join creates a round, its rent |
| `funder` | s | owns `funder_usdc` |
| `funder_usdc` | w | USDC, `token::authority = funder`; stored as `refund_to` |
| `config` | | `["config"]` |
| `vault` | w | `["vault"]` |
| `integrator` | w | `init_if_needed` at `["integrator", integrator_authority]` |
| `share_account` | optional | required when the join creates the integrator's record; a USDC account; stored as its share account |
| `vault_usdc` | w | `["usdc-vault"]` |
| `beneficiary` | | USDC account; stored |
| `payout_table` | | owned by Fade, at `["payout-table", payout_table.hash]` |
| `ticket` | w | `init` at `["round-ticket", integrator, nonce]`; never `init_if_needed` |
| `round` | w | `["round", n]` for some `n`; see the resolution rule |
| `next_round` | w | `["round", n + 1]` |
| `sponsorship_record` | w, optional | `["sponsorship", target round, payer]`; required when `sponsorship > 0` |
| `orao_network_state` | | ORAO's network state at its derived address; read, owner checked, on every join (check 5) |
| `usdc_mint`, `token_program`, `system_program` | | pinned |

**Round resolution.** Let `a = vault.accepting_round` and `m = vault.next_round_id`. The target round is the accepting round if `a ≠ 0` and that round accepts tickets: `Accepting`, or `Paid` with `slot < close_slot`. Otherwise, or if the accepting round is `Paid` and has no room for this join (the capacity rule of step 8 fails on it), the join creates round `m`, sets `accepting_round = m`, `next_round_id = m + 1`; a full paid round left this way keeps its own close slot, request and settlement, and no join can name it again. The accepting round, whose state decides, and the round to create, if any, must each be one of the two accounts passed, or the join fails with `WrongRound`. A client builds its transaction with `round` = the accepting round it read and `next_round` = its successor: it lands in the right round whether nothing changed, the accepting round closed and this join opens the next, or another join opened the next first. Only two rotations between the read and the landing, a full tick, make it retry.

**Checks, in order:**

1. No remaining accounts (`RemainingAccounts`).
2. `PAUSE_TICKETS` or `PAUSE_ROUNDS` set: `Paused`.
3. The integrator: created by this join → `PAUSE_NEW_INTEGRATORS` (`Paused`) and `share_account` present and a usable USDC account (`ShareAccountRequired`, `WrongMint`); `paused` → `IntegratorPaused`; `nonce == next_nonce` (`WrongNonce`).
4. The payout table: its address matches its stored hash (`WrongPayoutTable`); `check_split(margin_bps(lhs), app_share_bps)` (`AppShareTooHigh`, `MarginFloor`); `ev_ok(lhs, min_vault_margin + protocol_share + app_share)` (`MarginFloor`).
5. Round resolution (`WrongRound`). Every join reads ORAO's network state (owner checked, `NetworkStateUnreadable`) and the Rent sysvar. Creating a round computes `D_r` from them and snapshots the parameters of §13.3. Then the target round's draw must still fit its prefund, `beacon::request_fits(fee, rent(PENDING_LEN), request_share, D_r)`, the check `request_round_draw` makes (`DrawUnderfunded`): a round whose draw can no longer be requested takes no ticket, so it stays unpaid and is refunded in full rather than forfeiting the tickets the program could see were lost.
6. The drawdown ring, observed at the settled price: tripped → `DrawdownBreaker`; within the 48-hour aftermath, `halved`.
7. `risk::ticket_for(price, max_m, app_share_bps)`, then `risk::admit` with `min_price` replaced by the round's `min_price`: `PriceBounds`, `PerTicketCap`, `IntegratorCap`, `UtilisationBreaker`, `GlobalExposure`, `Insolvent`. The per-ticket limits are the direct path's exactly: multipliers up to `M_CEILING_BPS` (10 000×), liability up to the per-ticket cap.
8. The capacity rule of §13.4, with this ticket's usage `u` from the cap of step 7 and `S` including this join's `sponsorship`. Refused on a `Paid` accepting round, the join goes to round `m` (round resolution) and steps 5, 7 and 8 run again on it; refused on an `Accepting` round, or on the round this join creates: `RoundCapacity`. The sponsorship record, when `sponsorship > 0`, is then matched against the round the join lands in.
9. The epoch counters (§13.7), computed before anything moves: a round this join pays is recorded with `counters.open_n(now, tickets)`; a join into a round already `Paid` adds its ticket to the round's counter with `counters.join_n(now, side, generation, 1)`, refused if that counter is `before` and `now` is at or after the live close (`RoundEpochClosed`), and a `Paid` round with no recorded side is refused (`WrongRoundStatus`).

Every check precedes every transfer: a refused join moves no token and no lamport and writes nothing.

**Effects:**

- Tokens: the whole ticket price from `funder_usdc` to `vault_usdc`, in one transfer. No share leaves the vault.
- Lamports, from `payer`: the prepay and the sponsorship to `Round`; the settlement share to `ticket`, above its rent; the rents of `ticket`, of a created `Round` and of a created `Sponsorship`.
- `Vault`: `total_assets += vault_credit`, `total_reserved_liability += liability`, `open_vault_credits += vault_credit`, `beacon_shares_held += protocol_share + app_share`, the ring; `integrators += 1` if created; the epoch counters as check 9 computed them (they do not move for a join into an unpaid round that leaves it unpaid). `volume_total` does not move.
- `Integrator`: `reserved_liability += liability`, `open_tickets += 1`, `next_nonce += 1`. `volume_total` does not move.
- `Round`: `prices`, `liability`, `credits`, `protocol_shares`, `app_shares`, `prepaid` grow by the ticket's; `tickets += 1`; `usage += u`; `sponsorship += sponsorship` and, for a new record, `sponsors += 1`. If the round is `Accepting` and now paid: `Paid`, `paid_slot = slot`, `close_slot` per §13.4, `side` and `generation` recorded, `counted = true`.
- `RoundTicket`: every field of §13.2.4, `status = Joined`.

**Events:** `IntegratorCreated` (if created), `RoundOpened { round, id, rent_payer, threshold, draw_max, round_k, min_price, settle_share, tick_slots, refund_slots, first_slot, request_share, t_settle_slots, drawdown_bps }` (if created), `TicketJoined { ticket, round, integrator, nonce, beneficiary, refund_to, payout_table, price, vault_credit, payout_max, reserved_liability, cap, usage, protocol_share, app_share, prepay, slot, payer, funder, settle_share }`, `RoundSponsored` (if `sponsorship > 0`), `RoundPaid { round, paid_slot, close_slot, prices, sponsorship }` (if it became paid).

**A lone ticket.** No vault money ever completes a draw. A join may carry its own sponsorship (§13.10 point 6): an integrator that wants one ticket drawn at once sends `sponsorship = beacon::sponsorship_to_pay(R + price, S)` in the same `join_round`, computed from the round it read. That join makes the round paid; it closes at the next tick boundary and its draw is requested two slots later, in one transaction from the integrator and about 13 to 15 s of waiting. If another join lands first, the surplus goes back to the join's `payer`, the sponsor, through `reclaim_sponsorship` once the round is drawn (§13.5.10), pro rata like any sponsorship. A ticket that carries no sponsorship waits for the round to be paid by others, or for the refund window.

**A join refused for capacity.** It moves nothing, so the client retries. Only one round accepts tickets at a time (Spec 09 §7): while the accepting round is unpaid the retry must bring payment (its own sponsorship) or use less capacity (a lower multiplier, or a smaller ticket at the same multiplier), never a higher ticket price, which at a fixed multiplier raises the ticket's usage at least as fast as the payment it brings (`a_capacity_refusal_is_never_cured_by_a_higher_price`); once it is paid, a join it has no room for is not refused but opens the next round, at once (built on 15 October 2026: first written, the join waited for the full round's `close_slot`, so a ticket filling a paid round right after its payment refused every other join for the rest of the tick, for the edge on one ticket). A `Paid` round that is `Requested` or `Drawn` never blocks the next. The client builds every join with `round` = the round it read and `next_round` = its successor, so the same transaction lands in either; `resolveJoinRound` takes the join's usage to predict which, for the sponsorship record.

*Measured* on 14 October 2026: about 61 000 compute units into an existing round, 67 400 creating the integrator and the round, 73 800 for a lone ticket creating its round and its sponsorship (*estimated* before the build: 50 000 and 60 000); 902 bytes with three signers, 934 with a sponsorship record, 21 accounts and no lookup table. The join is sent as a version 1 transaction, or as a v0 one where a wallet signs only legacy and v0 (the app demo): it fits the 1 232 bytes of v0 too.

#### 13.5.3 `sponsor_round(lamports: u64)`

Anyone. Paused for an `Accepting` round by `PAUSE_TICKETS` or `PAUSE_ROUNDS`, as joins are; never paused for a `Paid` round.

- **Accounts:** `sponsor` (w, s), `vault` (w, `["vault"]` with its stored bump, for its epoch counters), `round` (w, `["round", round.id]` with its stored bump), `sponsorship` (w, `["sponsorship", round, sponsor]`, created or topped up in the handler exactly as `join_round`'s record, a pre-funded address created over), `orao_network_state` (ORAO's network state at its derived address), `config` (`["config"]` with its stored bump, read for its pause flags), `system_program`.
- **Checks:** no remaining accounts (`RemainingAccounts`); `lamports > 0` (`ZeroAmount`); the round is `Accepting`, or `Paid` and not yet requested (`RoundNotAccepting`); for an `Accepting` round, neither `PAUSE_TICKETS` nor `PAUSE_ROUNDS` is set (`Paused`); the round's draw still fits its prefund, `beacon::request_fits(fee, rent(PENDING_LEN), request_share, D_r)` (`DrawUnderfunded`), the check of `join_round`'s step 5 and of the request; the record at its address (`ConstraintSeeds`, `AccountOwnedByWrongProgram`, as in a join). Sponsorship of a paid round only adds funds for the draw: it lowers every ticket's charge. It cannot rescue a round whose draw rose beyond the margin, since the request compares the live cost with `D_r`, not with what the round holds; such a round takes no sponsorship, as it takes no join, so that nobody can pay it and turn its tickets' full refund into a forfeiture. The pause check closes the same attack when the request itself is the danger: while joins are paused (a withheld ORAO draw, a beacon defect) an unpaid round can only end in its full refund, and a sponsorship that paid it would push it into the request and, withheld or unrequested, a forfeiture; a top-up of a round already `Paid`, which can no longer be refunded, only lowers its tickets' charges and stays open.
- **Effects:** `lamports` from `sponsor` to `Round`; `sponsorship.amount`, `round.sponsorship` grow; `sponsors += 1` for a new record. If `Accepting` and now paid: `Paid`, as in a join, and recorded in the epoch counters, `counters.open_n(now, tickets)` (§13.7); that is the only `Vault` write.
- **Events:** `RoundSponsored { round, sponsor, lamports, total }`, and `RoundPaid` if it became paid.

An automatic sponsor that completes a draw sends the sponsorship that pays the round (§13.4), `ceil(D_r × (T_r − R) / T_r) − S` computed from the round it reads, in one transaction (Spec 09 §5); if a join lands first, the surplus comes back to the sponsor through `reclaim_sponsorship` once the round is drawn (§13.5.10).

#### 13.5.4 No cancellation

There is no `cancel_ticket` (decided on 7 October 2026, §13.10 point 4). A ticket that has joined stays until its round is drawn, refunded or forfeited, and its way out is the round's: the refund, `refund_slots` after the round's latest join, if the draw is never paid (§13.5.5), forfeiture if a closed round is not requested or fulfilled within `T_SETTLE` (§13.5.8). The number is kept so that the sections after it keep theirs.

#### 13.5.5 `refund_round()`

A participant of the round, nobody paid; never paused. Built on 14 October 2026, with §13.5.8 and §13.5.9. *Changed on 15 October 2026* (the audit's findings): first open to anyone from `first_slot + refund_slots`, so that one fee per round let an outsider empty every slow round at 600 s; now only a participant, and only once the round has taken no join for `refund_slots`.

- **Accounts:** `caller` (s), `vault` (w, `["vault"]` with its stored bump), `round` (w, `["round", round.id]` with its stored bump), `participant` (read): a `RoundTicket` of the round whose `payer` or `funder` is `caller`, or whose `integrator` is `["integrator", caller]`. Owner and discriminator checked, then the round's id and the role; not read when the round is doomed (below). `orao_network_state` (read, `["orao-vrf-network-configuration"]` under the pinned ORAO id, owner checked), as `join_round` reads it. *Changed on 16 October 2026* (final audit): a `Sponsorship` of the round no longer counts. `sponsor_round` takes any non-zero amount and a refund gives it all back, so a one-lamport record, made and shown in the same transaction, let an outsider refund for one fee; a sponsor gets its whole amount back from anyone else's refund. A sponsorship does not move `last_join_slot` either.
- **Checks:** no remaining accounts (`RemainingAccounts`); the round is `Accepting` (`RoundPaid` if paid, `WrongRoundStatus` otherwise), and not recorded in the epoch counters, which an unpaid round never is (`WrongRoundStatus`); `slot ≥ max(first_slot, last_join_slot) + refund_slots` (`RefundWindow`), the round's snapshot; `participant` shows `caller` in the round, unless the round's draw no longer fits its prefund at ORAO's live fee, `!request_fits(fee, pending_rent, request_share, draw_max)`, in which case anyone may refund it (`NotRoundParticipant`; *changed on 17 October 2026*, second final audit: such a round refuses every join and sponsorship with `DrawUnderfunded`, so nobody can become a participant, and its own participants' silence would refuse every beacon join; it can only end refunded, so opening its exit takes nothing from anyone); `credits + protocol_shares + app_shares = prices` (`MathOverflow`), §13.4's fact 3 summed, so that the books below leave the vault identity where it was.
- **Effects, O(1):** `Vault`: `total_assets` and `open_vault_credits` −= `credits`, `total_reserved_liability` −= `liability`, `beacon_shares_held` −= `protocol_shares + app_shares`, `beacon_returns_owed` += `prices`, `accepting_round` cleared. The settled price does not move. `Round`: `Refunded`. No token or lamport moves; each ticket's integrator reservation, ticket price and lamports are released by its return (§13.5.9).
- **Event:** `RoundRefunded { round, by, tickets, prices, sponsorship }`.

#### 13.5.6 `request_round_draw()`

Anyone, paid the request share; never paused.

- **Accounts:** `caller` (w, s), `round` (w), `round_vrf` (w), `slot_hashes` (the sysvar), `orao_network_state` (w), `orao_treasury` (w), `request` (w), `orao_program` (pinned), `system_program`.
- **Checks:** no remaining accounts; the round is `Paid`, with the side it was recorded on when paid (`WrongRoundStatus`); `close_slot + 2 ≤ slot ≤ close_slot + t_settle_slots`, or, after that window, `request` already owned by ORAO (`RoundRequestWindow`): a request someone created through ORAO is bound late, never a new one funded, so that a round whose request ORAO fulfilled is settled rather than forfeited (§13.5.8), and only once ORAO fulfilled it with a non-zero randomness (`RoundRequestWindow` otherwise, checked after the parse below): a pending request, or one fulfilled with zero, leaves the round forfeitable whether bound or not, and binding it would only pay the request share out of the tickets' prepays and charge it to them as a draw cost; the seed and `s*`: the round's recorded ones if any (§13.5.6a), whatever SlotHashes holds, so that a recorded round is bound late at any time; otherwise `s*` from `slot_hashes::first_after(close_slot)` while SlotHashes still proves it (an entry at or before `close_slot` retained, or `s* = close_slot + 1`) and the seed of §13.4 (`EntropyUnavailable` before `s*` exists; `EntropyUnrecorded` once SlotHashes no longer proves it, about 512 slots after the close: the round can no longer be bound, and its expiry refunds it, *changed on 17 October 2026*, fifth audit pass, where it was `RoundRequestWindow`); `request` is ORAO's request PDA for it (`WrongRandomnessAccount`). If ORAO already owns `request` — anyone may pre-create it once the seed is public — it must parse as a request, pending or already fulfilled (`WrongRandomnessAccount`), and nothing is funded (`needed = 0`). Refusing a fulfilled one would let whoever created it force the round's forfeiture. Otherwise ORAO's network state is read (`NetworkStateUnreadable`), its treasury matched (`TreasuryMismatch`), `needed = fee + rent(PENDING_LEN)`, and `needed + request_share ≤ draw_max` (`DrawUnderfunded`): the snapshot bound, never what the round holds, so that §13.4's fact 1 holds whatever was sponsored. Then the round's books: `needed + request_share ≤ prepaid + sponsorship` (`DrawUnderfunded`) and the round holding at least its rent-exempt minimum plus `prepaid + sponsorship` (`MathOverflow`), both true of consistent books, so that an inconsistency fails before any lamport moves rather than paying the draw out of the round's rent.
- **Effects:**
  - Lamports already on `round_vrf` (sent by anyone) are swept to `Round`, so the PDA holds only what the request takes; `needed` moves from `Round` to `round_vrf` (in the code, before the sweep, whose System transfer names `Round` and so commits that direct lamport move before ORAO's CPI, which does not name it); `request_v2` is invoked, signed by `["round-vrf", round]`, which leaves it empty; whatever ORAO did not take (less of the rent, over a request address someone pre-funded) goes straight back to `Round`, and `funded` is what ORAO took, at most `needed`. The request share moves from `Round` to `caller`.
  - The epoch counters do not move: the round was recorded when it became paid (§13.7). By the request its results may already be known: the seed is public from `close_slot + 1`, and anyone can create the request through ORAO and have it fulfilled first.
  - `Round`: `Requested`, `randomness`, `seed`, `entropy_slot`.
- **Event:** `RoundDrawRequested { round, request, seed, entropy_slot, entropy_hash, funded, side, generation }`; `entropy_hash` is zero for a late binding whose recorded `s*` SlotHashes no longer holds (`RoundEntropyRecorded` carries it).

`Round` can always fund the request: a paid round holds at least `Σ prepay + S ≥ D_r × R / T_r + S ≥ D_r`. `DrawUnderfunded` happens only if ORAO's fee or rent rose by more than one fee since the round's creation; the round can then no longer fund its own request. It is still drawn if anyone creates its ORAO request at the round's seed within the window (`close_slot + 2 ≤ slot ≤ close_slot + t_settle_slots`), paying ORAO's fee and the pending rent itself, and then sends `request_round_draw`: the pre-created path above binds it without reading ORAO's fee or checking `DrawUnderfunded`, funds nothing (`funded = 0`), and the tickets are charged the request share alone (`C = request_share ≤ D_r`, fact 1 unchanged; `tests/beacon.rs`, `a_round_whose_fee_rose_past_its_prefund_is_drawn_through_a_pre_created_request`). Otherwise the round forfeits at `T_SETTLE` unless the fee falls back (Spec 09 §5). It can happen here only to a round that was paid, or took its last join, before the rise: from the rise on, `join_round` refuses every join into it with the same check (§13.5.2, check 5).

#### 13.5.6a `record_round_entropy()`

Anyone, unpaid; never paused. *Added on 17 October 2026* (fifth audit pass).

- **Accounts:** `round` (w, by its seeds), `slot_hashes` (the sysvar). No signer: the fee payer is anyone.
- **Checks:** no remaining accounts (`RemainingAccounts`). A round whose seed is already recorded (`entropy_slot ≠ 0`) is left as it is and the call succeeds, whatever its status, so that it can be sent alongside or raced by the request, which records the same fields. Otherwise the round is `Paid` (`WrongRoundStatus`), and SlotHashes proves `s*` as the request reads it (`EntropyUnavailable` before `close_slot + 2`, `EntropyUnrecorded` once it no longer does).
- **Effects:** `Round.seed` (§13.4) and `Round.entropy_slot = s*`; nothing else, no lamport.
- **Event:** `RoundEntropyRecorded { round, seed, entropy_slot, entropy_hash }`.

Why. The seed is public from `close_slot + 1`: anyone may create the round's request through ORAO and read its outcome. Without the seed on the round, the program can derive that request's address only while SlotHashes holds `s*`, about 512 slots; past it, whoever held a fulfilled request could choose the round's end by waiting. Recorded, both the late binding (§13.5.6) and the expiry's refusal of a fulfilled request (§13.5.8) read the request at the recorded seed's address for good. A keeper records every round at `close_slot + 2`: its request does, and when the request is refused (ORAO's fee above the prefund, say) the keeper sends this alone. Any participant, integrator or wallet may send it too.

#### 13.5.7 `settle_round_tickets(count: u8, wins: u32)`

Anyone, paid each ticket's settlement share; never paused; no deadline. One ticket is `count = 1`. Built on 14 October 2026.

- **Fixed accounts:** `caller` (w, s), `config`, `vault` (w), `round` (w, `["round", id]` with its stored bump), `round_vrf` (w, with the round's `vrf_bump`), `randomness` (`round.randomness`), `payout_escrow` (w), `vault_usdc` (w), `vault_authority`, `usdc_mint`, `token_program`, `system_program`, `rent_payer` (w, optional), and the event authority and program.
- **Remaining accounts:** `count` groups of `ticket` (w), `integrator` (w), `payer` (w), `payout_table`, then `beneficiary` (w) if and only if bit `i` of `wins` is set. `1 ≤ count ≤ 32` (`MAX_ROUND_BATCH`, one bit of `wins` each).
- **Round checks:** the round is `Requested` or `Drawn`, with the side it was recorded on when paid (`WrongRoundStatus`); `randomness` is the round's request (`WrongRandomnessAccount`); at the first settlement only, it is owned by ORAO, a request of either kind, fulfilled, for `round.seed`, non-zero (`WrongRandomnessAccount`, `NotFulfilled`), and its value is kept in `round.drawn_randomness`, which every later batch reads instead (§13.2.2).
- **Layout checks:** `1 ≤ count ≤ 32`, no bit of `wins` at or above `count`, and exactly `4 × count + popcount(wins)` remaining accounts (`MalformedBatch`).
- **First settlement of a round** (`Requested`): drains `round_vrf` to `Round` (`refund`), sets `draw_cost` per §13.4 and `Drawn`. Event `RoundDrawn { round, draw_cost, refund }`.
- **Per group:** a ticket address named twice in one batch is `MalformedBatch`. If `ticket` is already closed (owned by the system program with no data) the group is skipped, and so is a ticket of this round whose payout an earlier batch parked (`PayoutParked`): two keepers racing on one round lose a ticket, not a transaction. Otherwise `ticket` is Fade's `RoundTicket` at `["round-ticket", integrator, nonce]` with its stored bump, of this round, `Joined`; `integrator`, `payer`, `payout_table` equal its stored keys, the integrator a Fade `Integrator`, the table a Fade `PayoutTable`; the outcome and payout are computed, the payout at most the ticket's `payout_max`; `payout > 0` must equal bit `i` of `wins`, and a `beneficiary` must equal `ticket.beneficiary`; the ticket, integrator, payer and beneficiary must be passed writable (`MalformedBatch` for any mismatch). Then, as `settle_ticket`'s `release` (§4 rule 4, one function for both paths): `total_assets −= payout`, reservation and credit released, the counter left with the round's `side` and `generation`, the after-close result booked, the ring observed and a trip recorded against the round's `drawdown_bps`; `beacon_shares_held −= shares`, `protocol_shares_accrued += protocol_share`, `integrator.app_shares_accrued` and `app_shares_owed += app_share`; `Integrator`: reservation, `open_tickets −= 1`, `volume_total += price`; `vault.volume_total += price`. `Round`: `tickets −= 1`, and `prepaid`, `liability`, `credits`, `protocol_shares`, `app_shares` less the ticket's, so that a drawn round's aggregates are those of its tickets still in it (invariant 2); `prices`, `sponsorship` and `usage` keep what the draw was charged on. The payout goes to the beneficiary if it can receive, otherwise to `payout_escrow` with `status = PayoutParked`. Lamports: the settlement share to `caller`; `prepay − charge` from `Round` and the ticket's rent to `payer`, or, when the payout is parked, `prepay − charge` from `Round` to the ticket, which keeps it with its rent until `claim_round_payout` closes it to `payer`, so that no settlement credits a payer, possibly emptied, with less than a rent-exempt account's minimum.
- **Before anything moves:** the round must keep its rent-exempt minimum after every return of the batch (`MathOverflow`), always true of consistent books (§13.4 fact 2).
- **After the groups:** the round closes if `tickets == 0` and `sponsors == 0`.
- **Events:** `RoundTicketSettled { ticket, round, integrator, outcome, payout, charge, pending }` per ticket; `RoundClosed { round, rent_payer, lamports }` on close.

Every check is on the ticket's own stored keys, so a batch can mix integrators, payout tables and payers. Settlement is deterministic: a ticket's outcome depends on the round's randomness and its own address, never on the batch it is settled in or its position. The instruction runs every check and book first (each integrator read and written back group by group), then the CPIs (the drain, the payouts), then the direct lamport moves, which no later CPI names. The program's heap is 32 KiB and never freed, so nothing it allocates may grow with the batch beyond its accounts and `count`: the events go through one reused buffer (`emit_cpi!` allocates about 700 bytes an event), the payouts through one reused `transfer_checked` instruction, one payout table is held at a time and reloaded when a group names another, and every other buffer is allocated once at its final size.

**How many per transaction, measured.** Clients and keepers use **no address lookup table** (team decision, 14 October 2026): a batch is a version 1 transaction (SIMD-0385: 4 096 bytes, its compute limit and priority fee in its header; active on mainnet since slot 447 120 000 and on devnet since slot 492 480 000), or a plain version 0 one without a table on a cluster where v1 is not accepted (`transactionFormatFor` in `clients/js/src/beacon/transaction.ts`). Every account of a batch is then a static key the program checks against the ticket, and nothing must be created, extended or warmed up before a round can be settled. Four limits bind, whichever comes first: the transaction's size (4 096 bytes in v1, 1 232 in v0); the 64 accounts a transaction may lock (`increase_tx_account_lock_limit`, which raises it to 128, is active on neither cluster); `MAX_ROUND_BATCH`; and the 64 instructions a transaction may run, its own and every CPI: `top-level instructions + count + winners + 3 ≤ 64` (an event per ticket, a transfer per winner, the drain and `RoundDrawn` at the first settlement, `RoundClosed` at the last). In v1 the account locks bind, well below the 4 096 bytes; in v0 the bytes do. The trace never binds on 64 locks (every ticket and every winner's beneficiary is a lock, so `count + winners ≤ 46`); on 128 it would cap a batch of winners at 29 where the locks would allow 32, and the runtime refuses a batch above it whole.

Largest batch, 30 % winners, the round's rent payer counted as an account of its own, the compute limit and a priority fee set; measured in litesvm on 15 October 2026 (`settlement batch sizes without a lookup table` in `tests/ts/fade/beacon.test.ts`) and landed on devnet the same day:

| Batch | Version 1: tickets, bytes / locks / trace | Version 0: tickets, bytes / locks / trace |
| --- | --- | --- |
| One integrator paying its players' SOL, one payout table | **32**, 2 212 / 60 / 46 | **10**, 1 222 / 32 / 19 |
| Every ticket with its own payer | **20**, 2 256 / 63 / 30 | **6**, 1 205 / 32 / 14 |
| Every ticket with its own payer and integrator | **14**, 2 198 / 62 / 22 | **4**, 1 132 / 30 / 11 |

The largest v1 batch of each mix, run in litesvm: 32 tickets with 11 winners, 331 728 units consumed, 2 205 bytes; 20 tickets with 7 winners, a payer each, 224 279 units, 2 249 bytes; 14 tickets with 5 winners, a payer and an integrator each, 169 469 units, 2 191 bytes. On devnet, against the real ORAO, v1 batches landed up to 2 265 bytes and 64 locks, 32, 20 and 14 tickets.

Compute units per batch, measured on 14 October 2026 (`settle_round_tickets::compute_units_and_sizes` in `programs/fade/tests/beacon.rs`, LiteSVM on the mainnet feature set, one signature, 30 % winners):

| Tickets | Compute units | Accounts |
| ---: | ---: | ---: |
| 1 (a loser) | 42 894 | 19 |
| 8 (2 winners), one integrator and payer | 110 630 | 28 |
| 16 (5 winners), one integrator and payer | 189 512 | 39 |
| 21 (6 winners), one integrator and payer | 237 061 | 45 |
| 8, each its own payer | 111 331 | 35 |
| 16, each its own payer | 192 637 | 54 |
| 8, each its own payer and integrator | 113 058 | 42 |
| 32 (10 winners), one integrator and payer | 347 357 | 60 |

The fixed cost is about 39 600 units (a later batch of one losing ticket), 42 700 for the round's first settlement, which drains `round_vrf`; each further ticket adds about 9 150, and 2 100 more if it wins (its token transfer), about 9 800 at 30 % winners; a ticket on a 32-outcome table other than the previous group's adds about 3 450 (the table's reload), so a keeper may order a batch by table. The 32 KiB heap holds every batch the account locks and the trace allow, whatever its payout tables, integrators and payers, on 64 locks and on 128: 22 winners sharing an integrator and a payer (280 793 units), 11 winners each with its own (160 905), 22 losers each on its own 32-outcome table and 20 such winners run, sent as version 1 transactions without a lookup table (295 688 and 306 213 units on 15 October 2026; the first measurement, on 14 October 2026, had run 22 losers and 15 winners in legacy-size transactions, 307 674 and 247 201); on 128 locks, 29 winners each on its own table (449 064), and the worst case built for the heap, 32 tickets, 27 winners, 32 tables and 19 payers in 127 locks (488 113 units, 26 250 bytes of heap, measured by a temporary probe). `claim_round_payout` measures 19 104 units.

**Cost per ticket and the settlement share.** At 5 000 lamports per signature and a priority fee on the units consumed, a settler spends per ticket, one integrator and payer: 2 007 lamports in a batch of 8 at 100 000 micro-lamports per unit and 14 453 at 1 000 000; 1 366 and 11 526 in a batch of 21; 1 241 and 11 011 in a batch of 32. A 5 000-lamport settlement share therefore pays a batching settler up to about 315 000 micro-lamports per unit in batches of 8 and 420 000 in batches of 21, through the 90th percentile of congestion and not at its peak, the regime of the direct path's request share (Spec 02 §4); 20 000 lamports pays up to about 1.4 to 1.75 million. Under the 150 bps rule at 120 USD per SOL (Spec 09 §8), a settlement share of `s` lamports alone allows a minimum ticket price of `s × 8 × 10⁻⁶` USD: 0.04 USD at 5 000, 0.16 USD at 20 000, 0.011 USD at the 1 366 lamports a 21-ticket batch costs at 100 000 micro-lamports. With the draw's share at the threshold (Spec 09 §3), the measurement supports Spec 09 §8's target: a 5 000-lamport settlement share and a 0.10 USD minimum ticket price at a 9.79 USD threshold. Lowering `crank_round_settle_lamports` and `beacon_min_price` from the `SPEC` values of §13.3 is a 24-hour loosening the team decides; the program does not change with it.

#### 13.5.8 `expire_round()`

Anyone, unpaid itself (each forfeited ticket's return pays its settlement share); never paused.

- **Accounts:** `caller` (s), `vault` (w, by its seeds), `round` (w, by its seeds), `round_vrf` (w, `["round-vrf", round]` with the round's `vrf_bump`), `randomness` (`round.randomness` if requested; if unrequested, ORAO's request address for the round's recorded seed, or, never recorded, for its seed while SlotHashes still proves `s*`; any account when neither), `slot_hashes` (the sysvar), `system_program`.
- **Checks:** no remaining accounts (`RemainingAccounts`); the round is `Paid` or `Requested`, with the side it was recorded on when paid (`WrongRoundStatus`); `slot > close_slot + t_settle_slots` (`NotExpired`); if requested, `randomness` is the stored request, owned by ORAO, parsed as a request of either kind, and pending or fulfilled with zero randomness (`AlreadyFulfilled` if fulfilled: settle instead; `WrongRandomnessAccount` otherwise). A request account ORAO has rewritten in a layout this program does not parse, handed to another owner or closed is refused, as `expire_ticket` refuses it: a forfeiture is never decided on a request whose value someone may read off-chain. If unrequested, the same holds of a request nobody bound: its seed is public from `close_slot + 1`, so anyone may have created it through ORAO and read its outcome. With the round's seed recorded (§13.5.6a), whatever SlotHashes holds, or, never recorded, while SlotHashes still proves `s*` (the expiry opens at most 401 slots after the close, the sysvar retains 512), `randomness` must be the request address `request_round_draw` would derive (`WrongRandomnessAccount`); owned by ORAO, it must parse and be pending or fulfilled with zero (`AlreadyFulfilled` if fulfilled: bind it with `request_round_draw` and settle; `WrongRandomnessAccount` if it does not parse); owned by anyone else, no request exists. Never recorded and no longer proven, nothing is read and the round is refunded, never forfeited (below).
- **Effects, O(1):** `counters.close_n(side, generation, tickets)`, with the side and generation recorded when the round became paid, requested or not; `total_reserved_liability −= liability`, `open_vault_credits −= credits` — the credits stay in `total_assets`: forfeiture, never refund (Spec 02 §2.2); their result, `credits`, booked as an after-close gain when the round's side and generation call for it; the ring observed. `beacon_shares_held −= protocol_shares`, `protocol_shares_accrued += protocol_shares`; app shares stay held until each return; `rounds_forfeited += 1`, and `forfeits_withheld += 1` unless `!requested && checked && !request_found`. If requested: `round_vrf` drained, `draw_cost` per §13.4 (the request's fee and full rent are spent). Otherwise `draw_cost = 0`. `Forfeited`.
- **Effects of the refund, O(1)**, for a round never requested whose seed was never recorded, once SlotHashes no longer proves `s*` (*changed on 17 October 2026*, fifth audit pass: such a round was forfeited with `checked = false`, which let whoever held its fulfilled request, created through ORAO and never bound, void every round whose players won by waiting for the eviction): `credits + protocol_shares + app_shares = prices` checked (`MathOverflow`); `total_assets` and `open_vault_credits` −= `credits`, `total_reserved_liability −= liability`, `beacon_shares_held −= protocol_shares + app_shares`, `beacon_returns_owed += prices`, as `refund_round`; `counters.close_n(side, generation, tickets)`; no after-close result and no ring observation (the settled assets do not move); `forfeits_withheld += 1`, `rounds_forfeited` unchanged; `Refunded`, `draw_cost = 0`. Each return then gives back the ticket price and the whole prepay (§13.5.9), each reclaim the whole sponsorship. The refund is the same whatever the draw; it still leaves whoever held a fulfilled request a choice between binding it while `s*` is proven and this refund, which is why every round's seed is recorded at `close_slot + 2` (§13.5.6a) and why this expiry is counted as a withheld draw.
- **Event:** `RoundExpired { round, requested, request_found, checked, tickets, forfeited, draw_cost, refund, side, generation, forfeits_withheld, refunded }`, `forfeits_withheld` the vault's count after this expiry, so the ordinal of a withheld one; `refunded` for the refund above (`checked` false, `forfeited`, `draw_cost` and `refund` 0). `request_found`: a request exists for the round's seed (always when requested; created through ORAO and never bound otherwise). `checked`: the program could look for one (always when requested; with the seed recorded, or while SlotHashes proved `s*`, otherwise; never for a refund). These are what the alarm reads: only `checked && !request_found`, a round nobody requested, is a keeper's failure; every other expiry, a request pending or fulfilled with zero, or a refund too late to look, is treated as a withheld draw and pages the guardian to pause new tickets (Spec 09 §10).
- **The ordering residual.** A requested round whose request ORAO fulfils after `close_slot + t_settle_slots` ends as whoever orders the slot carrying that fulfil chooses: the expiry first, forfeited, or the fulfil first, settled. ORAO's account records no fulfil slot, so no expiry rule removes the choice while the outcome is a function of R alone; such an expiry is requested, so it counts in `forfeits_withheld`, with its ordinal in the event (`tests/beacon.rs`, `an_expiry_ordered_ahead_of_a_late_fulfil_counts_as_withheld`). The cure is the post-V1 `SHA256(R ‖ h')` derivation of Spec 02 §7.

#### 13.5.8a `sweep_round_vrf(round_id: u64)`

Anyone, unpaid, never paused. Added on 19 October 2026 (post-implementation review, finding 11): a request still pending when `expire_round` forfeits its round is charged to the tickets with its whole pending rent (`draw_cost = funded + request_share`, `round_vrf` empty at the expiry); if ORAO fulfils it afterwards, its refund of the pending rent above the fulfilled account's (425 952 lamports at the last SIMD-0437 step, 3 108 960 today) lands on `round_vrf`, which no other instruction drains again, nor what anyone sends there after a drain.

- **Accounts:** `caller` (w, s), `vault` (by its seeds; read for `next_round_id`), `round` (w, `["round", round_id]`, unchecked: read as a `Round` while Fade owns it, not read otherwise), `round_vrf` (w, `["round-vrf", round]`, system-owned), `system_program`.
- **Checks:** no remaining accounts (`RemainingAccounts`); `1 ≤ round_id < vault.next_round_id`, a round the vault created (`WrongRound`); if Fade owns `round`, its stored id is `round_id` (`WrongRound`) and it is not `Requested` (`WrongRoundStatus`). Fade owning the address is what tells an open round from a closed one: a round's address is never used again once closed (§13.5.2, round resolution), and lamports sent to it after the close leave it system-owned.
- **Effects:** every lamport on `round_vrf`, signed by the program: into `Round` while Fade owns it, where the close pays it to `rent_payer` with the dust (§13.2.2); to `caller` once the round has closed. Nothing else is written. Nothing to sweep succeeds without moving anything and emits nothing, so that a keeper can put the sweep ahead of a round's last return or reclaim, and two sweeps can race.
- **Why the destinations.** The tickets were charged the pending rent at their returns, pro rata, and the program cannot reach them again in O(1): while the round exists, the lamports join what its close pays the rent payer, the payer of its first join (§13.10 point 9), exactly as lamports sent to the round itself do; once it has closed, nothing on-chain names its tickets or its rent payer, and the sweep pays whoever sends it, which pays for the transaction. A sweep ahead of the closing instruction, which the keeper sends, keeps the refund with the round's participants; one after it rewards the sweeper. Without the sweep the lamports are stranded for good either way.
- **Why `Requested` is refused.** Between the request and the drain, `round_vrf` holds ORAO's refund at fulfilment and any transfer since, which the first settlement or the expiry deducts from the draw cost (`refund`, §13.4): moving it into the round would raise `C` and every ticket's charge, the difference going to the rent payer at close. In every other state nothing reads `round_vrf` again: an `Accepting` or `Paid` round's request sweeps what it holds into the round anyway (§13.5.6), and a `Drawn`, `Forfeited` or `Refunded` round's draw cost is fixed. No outcome, charge, settlement, return, reclaim or close depends on what a sweep moves, and a sweep that leaves `round_vrf` empty cannot fail ORAO's later fulfilment, which only credits it (the refund exceeds a system account's rent-exempt minimum at every SIMD-0437 step).
- **Event:** `RoundVrfSwept { round, round_id, to, lamports, closed }`, `to` the round or the caller, `closed` when the round had closed.
- **Measured** on 19 October 2026 in LiteSVM on the mainnet feature set, the SBF binary of this tree (`tests/beacon.rs`, `sweep_round_vrf::compute_units`): 9 941 compute units with nothing to sweep, 14 091 into a round, 13 548 to the caller of a closed round; a 352-byte transaction with one signer.

#### 13.5.9 `return_round_ticket()`

The per-ticket return of a refunded or forfeited round: anyone, never paused.

- **Accounts:** `caller` (w, s), `config` (by its seeds, for the vault authority's bump and the mint), `vault` (w), `round` (w, `["round", ticket.round]` with its stored bump), `integrator` (w, `ticket.integrator`), `ticket` (w, `["round-ticket", integrator, nonce]` with its stored bump), `payer` (w, `ticket.payer`), `refund_to` (w, `ticket.refund_to`, `BeneficiaryMismatch`), `payout_escrow` (w), `vault_usdc` (w), `vault_authority`, `usdc_mint` (`config.usdc_mint`), `token_program`, `rent_payer` (w, optional; required, and equal to `round.rent_payer`, only when this return closes the round: `RentReceiverRequired`).
- **Checks:** no remaining accounts (`RemainingAccounts`); `ticket.status == Joined` (`WrongTicketStatus`); the round is `Refunded` or `Forfeited` (`WrongRoundStatus`); the round keeps at least its rent-exempt minimum after paying this return, and after a refund also every other ticket's prepay (`MathOverflow`), always true of consistent books (§13.4 fact 2), so that an inconsistency fails rather than paying this payer with what the round owes the others.
- **Refunded:** the ticket price from `vault_usdc` to `refund_to`, or to `payout_escrow` with `ReturnParked` and `payout = price` when `refund_to` cannot receive; `beacon_returns_owed −= price`; `Integrator`: reservation released, `open_tickets −= 1`. Lamports: the prepay from `Round`, the settlement share and the rent from `ticket`, all to `payer`; `caller` is not paid. When parked, the prepay moves to the ticket instead, which keeps it with its rent and settlement share until `claim_round_payout` delivers the price and closes it to `payer`, as for a parked payout (§13.5.7).
- **Forfeited:** no token moves. `Integrator`: reservation released, `open_tickets −= 1`, `volume_total += price`, `app_shares_accrued += app_share`; `Vault`: `beacon_shares_held −= app_share`, `app_shares_owed += app_share`, `volume_total += price`. Lamports: `prepay − charge` from `Round` to `payer`, the settlement share to `caller` (it is `expire_ticket`'s pay, per ticket), the rent to `payer`.
- **Both:** `round.tickets −= 1`, and `prepaid`, `liability`, `credits`, `protocol_shares`, `app_shares` less the ticket's, as at settlement; `prices`, `sponsorship` and `usage` keep what the charges are computed on. No counter moves: a refunded round was never recorded, a forfeited one left the counters at its expiry. The round closes if it was the last and no sponsorship remains.
- **Event:** `RoundTicketReturned { ticket, round, refunded, price, lamports, parked, charge }`, `lamports` what went to `payer` (0 when parked), `charge` the ticket's share of the draw (0 after a refund).

#### 13.5.10 `reclaim_sponsorship()`

Anyone, nobody paid; never paused.

- **Accounts:** `caller` (s), `round` (w, `["round", round.id]` with its stored bump), `sponsorship` (w, `["sponsorship", round, sponsor]` with its stored bump, of this round), `sponsor` (w, `sponsorship.sponsor`), `rent_payer` (w, optional; required, and equal to `round.rent_payer`, only when this reclaim closes the round: `RentReceiverRequired`).
- **Checks:** no remaining accounts (`RemainingAccounts`); the round is `Drawn`, `Forfeited` or `Refunded` (`WrongRoundStatus`); whenever the return is non-zero, the round keeps at least its rent-exempt minimum plus `prepaid` after paying it (`MathOverflow`): no ticket is charged then, so each remaining ticket is owed its whole prepay, and consistent books always pass (§13.4 fact 2).
- **Effects:** the sponsor's return of §13.4 from `Round` to `sponsor` (`C = draw_cost`, 0 for a round forfeited unrequested; the whole `amount` after a refund); the record closed, all its lamports to `sponsor`; `sponsors −= 1`, `round.sponsorship` unchanged, so every sponsor's share is computed on the same `S` whatever the order of the reclaims; the round closes if it was the last and no ticket remains.
- **Events:** `SponsorshipReclaimed { round, sponsor, lamports }`, `lamports` the return without the record's rent; `RoundClosed` if the round closed.

#### 13.5.11 `claim_round_payout()`

Anyone; never paused. The beacon's `claim_payout`, separate because the account type differs.

- **Accounts:** `caller` (s), `config`, `ticket` (w), `destination` (w: `ticket.beneficiary` if `PayoutParked`, `ticket.refund_to` if `ReturnParked`), `payout_escrow` (w), `vault_authority`, `payer` (w, `ticket.payer`), `usdc_mint`, `token_program`.
- **Checks:** no remaining accounts (`RemainingAccounts`); the ticket `PayoutParked` or `ReturnParked` (`WrongTicketStatus`); `destination` the stored one for that status (`BeneficiaryMismatch`).
- **Effects:** `payout` from `payout_escrow` to `destination` (a destination still unable to receive fails the transaction: retry later); `ticket` closed, every lamport it holds to `payer`: its rent and, for a parked payout, the prepay's return the settlement left on it (§13.5.7).
- **Event:** `RoundPayoutClaimed { ticket, destination, amount }`.

#### 13.5.12 `claim_shares()`

Anyone; the destination is pinned, so pushing someone's shares to them is harmless; never paused. Built on 14 October 2026.

- **Accounts:** `caller` (s), `config`, `vault` (w), `integrator` (w, optional), `destination` (w: `config.protocol_treasury` without `integrator`, `integrator.share_account` with it), `vault_usdc` (w), `vault_authority`, `usdc_mint`, `token_program`.
- **Checks:** no remaining accounts (`RemainingAccounts`); `destination` the stored one (`TreasuryMismatch` for the protocol, `ShareAccountMismatch` for an integrator); the amount, `protocol_shares_accrued` or `integrator.app_shares_accrued`, is non-zero (`NothingToClaim`); `destination` can receive, and is not `vault_usdc` itself, to which a transfer would move no token yet take the amount off the books (`DestinationUnusable`): nothing is pushed at settlement, so an unusable share account delays its owner's claim and nothing else.
- **Effects:** the amount from `vault_usdc` to `destination`; the ledger zeroed; `app_shares_owed` reduced for an integrator.
- **Event:** `SharesClaimed { integrator, destination, amount }`, with the default key for the protocol.

#### 13.5.13 Devnet only: `migrate_config(beacon_min_price: u64, beacon_threshold: u64, round_k: u64, tick_slots: u64, refund_slots: u64, crank_round_settle_lamports: u64)`

Compiled only with the `devnet` feature, signed by the program's upgrade authority: reallocates `Config` to version 2 and fills the beacon parameters, so the devnet deployment keeps its vault, its integrators and its liquidity providers (§13.10 point 12). A mainnet build cannot carry it, as `no-timelock`. It adds `PAUSE_ROUNDS` to the pause flags and keeps the others (§13.7).

- **Arguments:** the six beacon parameters of §13.3, in `RiskParams` order, written into both `params` and `pending.params`.
- **Accounts:** `authority` (w, s; the upgrade authority, pays the rent the larger account needs), `fade_program` (whose `ProgramData` is `program_data`), `program_data` (its upgrade authority `authority`: `NotUpgradeAuthority`), `config` (w, `["config"]`, owned by Fade, read as raw bytes since a version-1 `Config` does not deserialise as the current one), `vault` (w, `["vault"]` with its stored bump), `system_program`.
- **Checks:** `config` is exactly a version-1 `Config`, 695 bytes with its discriminator and version 1 (`AccountDidNotDeserialize`, `AccountDiscriminatorMismatch`), so a second call fails; the migrated parameters, and a pending change's, pass `RiskParams::is_valid` (`InvalidParams`).
- **Effects:** `Config` grows to 791 bytes, its rent topped up from `authority`: each `RiskParams` extended by the arguments, `version = 2`, `PAUSE_ROUNDS` added, every other byte kept. `Vault`: `next_round_id = 1` when it reads 0, as a deployed `Vault` does from its former reserved tail; the other beacon fields read 0. No event.

### 13.6 Errors and events

New error codes, appended after `DestinationUnusable` (6053); none is renumbered:

| Code | Name | Message |
| --- | --- | --- |
| 6054 | `WrongRound` | the round is neither the accepting round nor the next one |
| 6055 | `RoundNotAccepting` | the round accepts no more sponsorship |
| 6056 | `RoundCapacity` | the round's liability would exceed what its paid share of the draw allows |
| 6057 | `RoundPaid` | the round's draw is paid: no refund |
| 6058 | `WrongRoundStatus` | the round is not in the state this instruction needs |
| 6059 | `RefundWindow` | the round's refund window has not opened |
| 6060 | `RoundRequestWindow` | a round's draw may only be requested from two slots after its close until `T_SETTLE` |
| 6061 | `DrawUnderfunded` | the live draw cost exceeds the round's prefund |
| 6062 | `WrongPayoutTable` | the payout table account does not match its hash or the ticket |
| 6063 | `NotCanceller` | unused: kept so that the codes after it do not move (no cancellation, §13.10 point 4) |
| 6064 | `ShareAccountRequired` | an integrator's first ticket must name its share account |
| 6065 | `MalformedBatch` | the settlement accounts do not follow the ticket layout |
| 6066 | `RoundEpochClosed` | a round counted before the epoch's close takes no join at or after that close |
| 6067 | `NotRoundParticipant` | only a participant of the round, shown by its ticket, may refund it (`refund_round`; a sponsorship is no participation, and a round whose draw no longer fits its prefund needs none) |
| 6068 | `EntropyUnrecorded` | the round's entropy was never recorded and SlotHashes no longer proves it (`record_round_entropy`, the late `request_round_draw`); also `expire_ticket`'s refusal of an Open ticket whose seed was never recorded, whether or not SlotHashes still proves it: `record_ticket_entropy` first, then the expiry (`refund_expired_ticket` only once SlotHashes no longer proves the seed, 6069 before). The program's message names only the lost case; it is to be reworded with the next program change, since changing it now changes the rehearsed binary (sha256 `e9674d60…`) |
| 6069 | `EntropyStillProven` | `refund_expired_ticket` on a ticket whose seed SlotHashes still proves: record it (`record_ticket_entropy`) and expire it instead (added by the audit fixes of 22 October 2026) |

Existing codes are reused where the meaning is the same: `Paused`, `IntegratorPaused`, `WrongNonce`, `WrongMint`, the admission codes, `ZeroAmount`, `RemainingAccounts`, `WrongTicketStatus`, `EntropyUnavailable`, `NetworkStateUnreadable`, `TreasuryMismatch`, `WrongRandomnessAccount`, `NotFulfilled`, `AlreadyFulfilled`, `NotExpired`, `DrawFailed`, `RentReceiverRequired`, `NothingToClaim`, `DestinationUnusable`.

New events, all at version 1, each added to `events.lock.json` and `docs/event-versions.md`: `PayoutTableRegistered`, `RoundOpened`, `TicketJoined`, `RoundSponsored`, `RoundPaid`, `RoundRefunded`, `RoundDrawRequested`, `RoundEntropyRecorded` (added on 17 October 2026), `RoundDrawn`, `RoundTicketSettled`, `RoundExpired`, `RoundTicketReturned`, `SponsorshipReclaimed`, `RoundClosed`, `RoundPayoutClaimed`, `SharesClaimed`, `RoundVrfSwept` (added on 19 October 2026). Their fields are listed with each instruction; an indexer can rebuild every round and ticket from them alone.

The audit fixes of 22 October 2026 move the direct path's `TicketExpired` to version 2 (`TICKET_EXPIRED_VERSION`: the request findings `requested`, `request_found`, `checked`, then `pending`, `refunded`, `refund`, `parked` and `ticket_forfeits_withheld`, appended; a decoder dispatches on the version byte, a version-1 body ending after `forfeited`) and add `TicketEntropyRecorded` and `TicketVrfSwept` at version 1, and one error, `EntropyStillProven` (6069): `refund_expired_ticket` on a ticket whose seed SlotHashes still proves (record it and expire it instead).

### 13.7 Interactions

**With the direct path.** Both paths share `Vault`, the integrator's record and nonce sequence, admission, the breakers and the epoch counters; `open_ticket`, `settle_ticket` and `claim_payout` are unchanged, and the direct expiry follows `expire_round`'s rules (audit fixes of 22 October 2026): `record_ticket_entropy`, the late binding of `request_randomness`, the derived request address `expire_ticket` reads for a ticket never requested, and `refund_expired_ticket` once its seed is lost. An integrator chooses per ticket (Spec 09 §4), and its ceiling counts both. Shares differ: paid out at open on the direct path, held on the beacon path.

**With the vault's books.** A beacon ticket's credit joins `total_assets` and `open_vault_credits`, and its liability `total_reserved_liability`, at the join, exactly as a direct ticket's at open: the free balance, every cap and both breakers see it at once. Its shares stay in `vault_usdc` outside `total_assets`, in `beacon_shares_held`, and become claimable at settlement or forfeiture, never at the join. The vault identity becomes

```
vault_usdc ≥ total_assets + beacon_shares_held + protocol_shares_accrued + app_shares_owed + beacon_returns_owed
```

and `payout_escrow ≥` the payouts and returns parked on both paths.

**With the epoch counters and the strike.** A round enters the counters once, in O(1), when it becomes paid, in the `join_round` or `sponsor_round` that pays it: `counters.open_n(now, tickets)` puts all its tickets on the side that instant falls on, `Before` if an epoch close is set and not yet passed, `After` otherwise, and the round records the side and the generation. Each join into it until its close adds its ticket to the counter the round's tickets are in by then (`counters.join_n(now, side, generation, 1)`, the counter `close_n` would release: an epoch opened or struck in between has moved them from `after` to `before`, as it moves direct tickets). A round whose tickets are in `before` takes no join at or after the live epoch's close (`RoundEpochClosed`), as a direct ticket opened then goes to `after`: the tickets an epoch's price contains are fixed at its close, those opened before it (Spec 01 §3.5), and `before` only shrinks after the close. The round still accepts by slot until its `close_slot`; the join is refused, not redirected, since a round keeps one side. Each settlement then leaves the counter as a direct ticket does (§4 rule 4), and a forfeiture leaves it for every remaining ticket at once. A round that is never paid, or is refunded, never enters the counters; nor can its results exist, since its seed needs a slot after a close it never reaches.

The payment is the last instant at which the round's side cannot depend on its results, which is why it is recorded there, as a direct ticket is at its open. Every join precedes `close_slot`, and the seed needs the hash of the slot after it, so nothing about the results exists at the payment or at any later join. From `close_slot + 1` on, the seed is public: anyone can create the round's ORAO request directly, have it fulfilled within seconds and know every ticket's result, long before the round's own request and possibly before the epoch's close. A side fixed by the request's time would then be chosen by someone who knows the results: a known loss requested at or after the close kept out of the price a queued withdrawal leaves at, a known gain the same way kept out of the price a queued deposit buys in at; and a round not yet recorded would not hold the strike at all. Recorded at its payment, a round paid before the close holds the strike for every ticket whenever its randomness arrives, so a result known before the close is in that price; a round paid at or after the close has results that cannot be known before it, kept out of the price and booked to the next epoch (§4 rule 5). `strike_epoch` therefore needs no beacon account and no change (§13.10 point 5). Until a round is recorded its credits are outside the settled assets, and its reservation reduces what the strike may pay out, as every open reservation does: at most one round cap for the one unpaid round (Spec 09 §7).

**With pause flags and the guardian.**

| Instruction | Gated by |
| --- | --- |
| `join_round` | `PAUSE_TICKETS`, `PAUSE_ROUNDS`, the integrator's own pause; `PAUSE_NEW_INTEGRATORS` when it creates the record |
| `sponsor_round` | `PAUSE_TICKETS`, `PAUSE_ROUNDS`, for an `Accepting` round only; a `Paid` round's top-up is never paused |
| `register_payout_table`, `refund_round`, `request_round_draw`, `record_round_entropy`, `settle_round_tickets`, `expire_round`, `sweep_round_vrf`, `return_round_ticket`, `reclaim_sponsorship`, `claim_round_payout`, `claim_shares` | nothing |

`PAUSE_TICKETS` stops both paths: it is the guardian's lever on the first withheld draw, which concerns every ORAO request. `PAUSE_ROUNDS` stops the beacon alone, for a defect in it. The guardian sets both, only the council clears them (Spec 05 §4).

`initialize` and `migrate_config` set `PAUSE_ROUNDS`: the beacon starts off, and the council turns it on only on a binary that carries every instruction that ends a round (refund, request, settlement, expiry, returns, reclaims, `claim_round_payout`, `claim_shares`). A join into a binary without them would lock its price, prepay and rents, and the vault's reservation, with no way out.

**With the breakers.** The utilisation breaker, κ and gross solvency are `risk::admit`'s, at every join, on the vault as it stands with every round's reservations in it. The drawdown breaker refuses joins while tripped, and its aftermath halves the per-ticket cap, so every ticket joining meanwhile uses twice the room of its round. Settlement observes the price per ticket, as `settle_ticket` does; forfeiture, a gain, observes it once; a refund moves no settled asset.

**Throughput.** `Vault` is written by joins, sponsorships that pay a round, refunds, settlement batches, expiries, returns and share claims; the request no longer writes it (§13.5.6). *Measured* per beacon ticket (§9): about 55 400 units at its join into an existing round and 11 300 for its share of a 21-ticket batch, 66 700 against the direct path's 94 808 per cycle: about 179 tickets per block against 126.

### 13.8 Invariants and the tests that prove them

The implementation preserves, after every instruction:

1. **Vault identity** of §13.7, and `payout_escrow` covering every parked amount.
2. **Vault aggregates equal their sums**: `open_vault_credits` and `total_reserved_liability` are the sums over open direct tickets and over the `credits` and `liability` of every `Accepting`, `Paid`, `Requested` or `Drawn` round; `beacon_shares_held`, `beacon_returns_owed` and `app_shares_owed` the sums they name; `rounds_forfeited` the number of `expire_round`s that forfeited, `forfeits_withheld` those not `!requested && checked && !request_found` plus every `expire_round` that refunded; each `Integrator.reserved_liability` the sum over its open direct tickets and its beacon tickets not yet settled or returned.
3. **Capacity follows payment, and never decreases**: every `Accepting` or `Paid` round satisfies the rule of §13.4 after every join, an unpaid one with its headroom; `R`, `S` and `U` never decrease before the draw, nor the paid fraction (Technical Specification §5, Shared beacon 2).
4. **At most one round accepts tickets, and at most one unpaid round exists**; `vault.accepting_round` names it or is 0. A `Paid` round before its close that a join had no room for is no longer named, and no join can reach it.
5. **Exact returns**: a refund returns the ticket price, to the token, and the prepay, the settlement share and the rent, to the lamport (Shared beacon 1).
6. **Nothing leaves before the end, nothing joins after the close**: no ticket leaves a round before it is drawn, refunded or forfeited; no join at or after `close_slot`; no refund or sponsorship withdrawal once paid, but the refund `expire_round` makes of a round never requested whose seed was never recorded, once SlotHashes no longer proves `s*` (§13.5.8); the round's `prices` never change from its `close_slot` on (a `Paid` round still takes joins until then, §13.2.2, §13.5.2) (Shared beacon 3).
7. **Charges**: each ticket's charge is at most its prepay; charges and sponsors' charges cover the draw; a round's lamports never fall below its rent-exempt minimum before it closes (Shared beacon 4, §13.4).
8. **Counters**: a round is recorded once, when it becomes paid, before its seed can exist, and every later join enters the round's counter, never `before` at or after the live close; a round is never recorded at its request; the counters and the generation are conserved; no strike runs with a `Before` round's ticket open (Shared beacon 5).
9. **Seeds**: two rounds never share a seed or an ORAO request; the seed's slot is after every join of its round.
10. **Settlement always succeeds** for a fulfilled round, at any later time, whatever the beneficiary's state; `expire_round` refuses a fulfilled round, requested or not, whatever SlotHashes holds: a round never requested is looked for at its recorded seed's address for good, or at the address SlotHashes proves while it does, and one that can be looked for in neither way is never forfeited but refunded in full (§13.5.6a, §13.5.8; *changed on 17 October 2026*, fifth audit pass: past SlotHashes such a round was forfeited without looking). The refund still leaves whoever held a fulfilled request of a never-recorded round the choice between binding it while `s*` is proven and that refund; the keeper's record at `close_slot + 2` keeps the case out of reach, and the alarm counts it as a withheld draw.
11. **Shares** become claimable only at settlement or forfeiture; what `claim_shares` pays never exceeds what settled and forfeited tickets held.
12. **No round without a ticket**: a round is created by its first join and keeps every ticket until its end.

Tests:

- **`fade-math` unit and property tests** (`crates/fade-math/src/beacon.rs`, `crates/fade-math/tests/properties.rs`): §13.4's four facts over random terms and random sequences of joins and sponsorships ending in a draw, a forfeiture or a refund, against exact rationals; `fits` and `is_paid` equal to the exact rule for every `u64` input; close-slot boundaries; `open_n`/`close_n` against `n` single steps. Vectors (`tests/vectors/beacon.json`: 2 000 scalar cases, 500 whole rounds, 200 seeds and outcomes) are generated by `scripts/oracle/gen_vectors.py` from `fade_ref.py` and checked by `tests/vectors.rs`.
- **LiteSVM transaction tests**, one file `programs/fade/tests/beacon.rs` with the ORAO stand-in: every instruction's happy path and every error in its check order; each edge case of §13.9; the compute units of every new instruction, measured in each instruction's module of that file so that no V1 test changes, and grouped settlement measured at 1, 8, 16 and 21 tickets (§13.5.7).
- **A state-machine test** (`programs/fade/tests/beacon_state_machine.rs`, proptest's runner over sequences of operations) against a reference model that predicts every instruction's success, with each effect, or its exact error: random joins with random payout tables, integrators, payers and sponsorships, sponsorships, refunds, slot and clock advances, requests, pre-created ORAO requests, ORAO fulfilments, withholdings, ORAO fulfilments after a round forfeited or closed, sweeps of `round_vrf` (open, closed, requested, or an id no round has), batches in random order and composition, expiries, returns, reclaims, parked payouts and returns, share claims, frozen accounts, stray lamports, ORAO fee changes, pauses, direct tickets, deposits, withdrawals and strikes; each case drained to nothing open and no lamport left on any `round_vrf`; invariants 1 to 12 checked after every step, with the volumes, the integrator count, the drawdown ring and its last trip that settlement, forfeiture and admission write, a refused instruction moving nothing, and one ticket of every batch settled alone on a fork with the same outcome, payout and charge. Each case starts from one of four worlds: the specification's parameters on a large vault, and a small vault with tight limits, fresh, in a drawdown's aftermath or just tripped, so that the breaker, the halved cap and every admission refusal reachable with valid parameters decide joins and opens; a full run fails if any of them, or any boundary it targets, is never reached. 10 000 cases in every `cargo test` run, from a fixed seed by default; the seed, the case count and the shard count fix every case whatever the machine, and a failure prints the command that reruns its shard.
- **A fuzz target** (cargo-fuzz, `fuzz/fuzz_targets/settle_round_layout.rs`, harness `programs/fade/tests/batch_layout/mod.rs`, also run on a bounded budget by `tests/settle_layout.rs`) on `settle_round_tickets`'s account layout: batches of one to ten tickets and of 29 to 33 (the bound and one past it), substitutions from a pool of every kind of account, writable flags, removals, insertions, `wins` (bit 31 included) and `count` (every value from 0 to 33), judged by an oracle written from §13.5.7. No list in which an account of a ticket's group differs from that ticket's stored one settles it or anything else; a group whose ticket address names no live ticket of the round (an empty system account, a ticket closed or parked by an earlier batch) is skipped, as §13.5.7 says.
- **Named regression tests** for each attack of Spec 09 §10 and for the points of §13.10.

### 13.9 Edge cases

| Case | Behaviour |
| --- | --- |
| An empty round | Cannot exist: created by its first join, and no ticket leaves before the round's end |
| A lone player | No vault subsidy. Its ticket is drawn once the round is paid: by later joins, by a sponsor, or at once by sponsorship carried in its own join (§13.5.2, a lone ticket). Otherwise the refund window returns everything from 1 715 slots |
| A round never paid | Keeps accepting joins and sponsorship, holding at most `(1 − h)` times its paid share of one round cap; a participant may refund it once it has taken no join for `refund_slots`, anyone once its draw no longer fits its prefund; nobody has to |
| A paid round never requested | Forfeits through `expire_round` after `close_slot + T_SETTLE`, every ticket's credit to the vault and its prepay back to its payer, nothing charged; `RoundExpired.requested = false`, a keeper alarm, not a pause. If its seed was never recorded and the expiry lands once SlotHashes no longer proves `s*`, it is refunded in full instead (`RoundExpired.refunded`), counted as a withheld draw: the program can no longer tell whether its request exists, fulfilled (§13.5.8) |
| ORAO late | A request fulfilled after `T_SETTLE` but before anyone expires the round settles normally; the first to land wins, as on the direct path |
| ORAO withheld | `expire_round` forfeits the round; its tickets are charged the request's fee and rent; the guardian pauses new tickets on the first one, which also stops sponsorship of the unpaid round, left to its full refund (§13.5.3) |
| ORAO's fee rises after creation | Absorbed up to one fee; beyond it `DrawUnderfunded`: an unpaid round takes no more joins or sponsorship and is refunded in full; a paid one cannot fund its own request, and sponsorship does not raise `D_r` (§13.5.3, §13.10 point 7); it is still drawn if anyone pre-creates its ORAO request at the round's seed within `close_slot + 2 .. close_slot + T_SETTLE`, paying the fee and the rent, and sends `request_round_draw` (§13.5.6): its tickets are then charged the request share alone. Otherwise it forfeits unless a fee cut comes first |
| A join at the boundary | At `close_slot − 1` it joins; at `close_slot` the round is closed and the join opens the next round. A round paid in the last slot of a tick closes at the next slot |
| A join that does not fit | Into an unpaid round: `RoundCapacity`, before any transfer, nothing moves; it fits with sponsorship carried in the same join, or once it pays the round within `h · k` caps. Into a paid round: it opens the next round and lands there (§13.5.2), refused only if that new round has no room for it either. Later joins may fit less than earlier ones, since each consumes the free balance its cap is computed on; a ticket's usage never changes after its join |
| A high multiplier on a small ticket | The direct path's limits: up to 10 000× and the per-ticket cap. A fully paid round carries one cap (`k = 1`), so one ticket may use all of it; in a partly paid round it needs `l / cap` of the draw paid, which a join brings with its own sponsorship (Spec 09 §7) |
| Mixed margins in one round | Each ticket is measured against its own cap: a small-margin ticket uses more room, never shrinks another's |
| Two opposite tickets by one party | Independent outcomes; each loses the margin on its own (Spec 09 §10). Neither can be withdrawn; a refund returns exactly what came in, so no share can be farmed |
| Rounding | Shares floored per ticket, the vault's; charges rounded up, the round's; sponsors' returns floored; the round's dust to `rent_payer` |
| Partial sponsorship | Several sponsors, each with its record; returned pro rata after the draw, in full after a refund |
| Returns after the refund | No deadline: the ticket price waits in `beacon_returns_owed`, the integrator's reservation until its return, which the integrator has every reason to push |
| A `refund_to` or beneficiary closed or frozen | The return or payout is parked in `payout_escrow`, delivered by `claim_round_payout` |
| Lamports sent to a round, its `round_vrf` or a ticket | A round's and a ticket's go to their rent payer at close; `round_vrf`'s are swept into the round at the request, and those sent before the first settlement reduce the draw cost they are deducted from, down to the request share, the rest dust; those sent after it, and any on an unrequested round's, wait for `sweep_round_vrf` (§13.5.8a). The same holds on the forfeit path: a round whose request is still pending at its expiry is forfeited with the request's whole pending rent in its draw cost (`round_vrf` empty, so `draw_cost = funded + request_share`), and if ORAO fulfils the request afterwards, its rent refund, the pending rent above the fulfilled account's (425 952 lamports at the last step, 3 108 960 today), lands on `round_vrf`, while the returns charge it to the tickets all the same. The sweep moves it into the round while the round exists, to join the dust paid to `rent_payer` (the keeper sends it ahead of the round's last return or reclaim), or to whoever sends it once the round has closed; never while the round is `Requested` (§13.10 point 14) |
| An address pre-created | A pre-funded `Round`, `RoundTicket`, `Sponsorship` or `PayoutTable` address is created over, as Anchor's `init` does; a pre-created ORAO request is accepted as on the direct path (§12 item 11) |
| Two keepers settling one round | Each ticket settles once; a batch skips the tickets already closed or whose payout an earlier batch parked |
| Rent recovery | Ticket rent to its payer at close; round rent to its creator's payer at close; sponsorship rent to the sponsor; `round_vrf` empty; ORAO's fulfilled request keeps its 184 440 lamports, part of the draw cost; `PayoutTable` kept for good |
| A round's ids | A new id only when the accepting round closes, is refunded, or is paid and has no room for a join; ids are `u64` |

### 13.10 Decided points

Each was a place where Spec 09, written down to the account, was ambiguous or contradicted itself. The first thirteen were **decided on 7 October 2026**: eleven as first recommended, point 3 differently, and point 4 by removing cancellation altogether; point 14 on 19 October 2026, from the post-implementation review.

1. **The prefund counts the request's locked rent, not the rent it advances.** Spec 09 §5 and `beacon_rounds.py` set `D_r = 2 × fee + 184 440 + 50 000`, the rent ORAO keeps after fulfilment; the request advances the rent of a pending account, 610 392 lamports at the last step and 4 455 160 today, refunded down to 184 440 only at fulfilment, so a round prefunded at that figure could not pay for its own request. *Decided:* `D_r = 2 × fee + rent(PENDING_LEN) + request_share`, 1 660 392 lamports (5 505 160 today), as the direct path prefunds. The charge, the threshold and every overhead figure are unchanged: the refund comes back before anyone is charged. Spec 09 §5's example and the script are regenerated: 192 175 lamports of draw prepay per 1 USDC ticket, 118 731 returned.
2. **Where prepays sit.** *Decided:* on `Round`, a program account, never on a system account that a small first prepay would leave below its rent-exempt minimum; `round_vrf` is funded with exactly the request's cost at the request.
3. **The margin the round's capacity uses.** *Decided (changed):* none in common. Each ticket keeps its own payout table and margin, and its liability counts as a fraction of its **own** per-ticket cap, computed at its join with its vault margin and the free balance then: `Σ l_i / cap_i ≤ k · min(1, R/T_r + S/D_r)`, accumulated as `U = Σ ceil(l_i × 10⁹ / cap_i)` on `Round` (§13.4). No ticket's margin penalises another, joining with a minimal margin cannot grief a round, and the round's total liability never exceeds `k` times the most generous cap among its tickets, the risk of one direct ticket at that cap if the draw is corrupted (§13.4 fact 4); honest draws are independent per ticket, each within its own Kelly cap as concurrent direct tickets are, and κ, utilisation, gross solvency and the integrator ceiling stay per join on the whole vault. The first recommendation, the smallest vault margin among the round's tickets, was stricter than the risk model needs and let one low-margin join shrink every later ticket's room.
4. **Cancellation.** *Decided (changed): no cancellation.* A ticket that has joined cannot be withdrawn; `cancel_ticket` is removed (§13.5.4). Simpler; capacity becomes monotonic, since only joins and sponsorship move a round before its draw; and no bait-and-cancel is possible, whether to free-ride on another ticket's payment or to leave a round over capacity. The way out is unchanged: the refund from 1 715 slots for a round whose draw is never paid, and forfeiture for a closed round not requested or fulfilled within `T_SETTLE`.
5. **Recording a round in the epoch counters.** *Decided:* at the request, by the request's time, with no change to the strike. *Revised on 14 October 2026* after review of the request's implementation: at the payment, by the payment's time, later joins following the round's counter (§13.7), still with no change to the strike. The decision rested on "late recording only ever keeps results out of a price", which holds only if the results are unknown when the side is chosen; the seed is public from the slot after the close and anyone can have ORAO answer it before the round's own request, so a side chosen at the request is chosen by someone who may know the results, and a round not yet recorded does not hold the strike.
6. **The first ticket of a sponsored round.** *Decided:* `join_round` carries an optional sponsorship from its payer, which is also how an integrator has a single ticket drawn at once (§13.5.2).
7. **Sponsorship after payment.** *Decided:* until the request: it changes no seed. As first written it also "lets anyone rescue a round whose draw rose above the margin", which the request's check against `D_r` (§13.5.6) does not allow; as built, such a round takes no sponsorship at all (§13.5.3). *Settled with the request (14 October 2026):* the request keeps comparing the live cost with `D_r`, and the rescue claim is dropped. Comparing with what the round holds would let a draw above `D_r` be charged to tickets whenever sponsors' lamports do not cover the excess pro rata, break §13.4's fact 1 (`C ≤ D_r`), and let a sponsor revive a round its tickets would otherwise see refunded or forfeited without charge; a fee rise of more than one fee is a rare event the round survives by forfeiting at no charge to its tickets.
8. **Who may cancel.** Moot: there is no cancellation (point 4).
9. **Who advances a round's rent.** *Decided:* the payer of the join that creates it, returned at close with the round's dust: 375 144 lamports at the last step, 2 738 120 today.
10. **Shares of a forfeited ticket.** *Decided:* claimable, as for a loss: forfeiture costs the player exactly a loss (Spec 02 §2.2).
11. **Raising `k`.** *Decided:* `MAX_ROUND_K = 1` in the program, so that it takes an upgrade.
12. **`Config` layout.** *Decided:* the new layout before mainnet, devnet migrated with the devnet-only `migrate_config`.
13. **Names.** *Decided:* `return_round_ticket`, `settle_round_tickets`, `claim_round_payout`, `register_payout_table`, `expire_round` and `reclaim_sponsorship`.
14. **Lamports on `round_vrf` after its last drain.** ORAO's refund for a request it fulfils after the round forfeited, or a transfer, would otherwise be stranded: nothing but the program signs for the PDA. *Decided (19 October 2026):* a permissionless, unpaid `sweep_round_vrf(round_id)` (§13.5.8a), into the round while it exists, so that they join what its close pays the rent payer, to the caller once it has closed, refused while the round is `Requested`, whose `round_vrf` holds the draw cost's `refund`. The participants charged the pending rent are not paid it back: their charges were fixed at the expiry and paid at their returns, and refunding them would mean one write per ticket, after the close nothing names them; the rent payer, a participant, gets it when the sweep comes first, which the keeper sends ahead of the last return or reclaim. The alternatives were an optional `round_vrf` account on `return_round_ticket`, `reclaim_sponsorship` and `settle_round_tickets`, which cannot reach a refund that lands after the close, the common case (ORAO answers late, after the returns), and holding the round open until ORAO answers, which would let a silent oracle keep its rent and dust for ever.
