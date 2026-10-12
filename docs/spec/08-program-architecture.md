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
| `Vault` | `["vault"]` | tickets | `open_ticket`, `settle_ticket`, `expire_ticket`, `strike_epoch`, the request that opens an epoch | never closed |
| `vault_usdc` | `["usdc-vault"]` | tickets | `open_ticket`, `settle_ticket`, `claim_payout`, `strike_epoch` | never closed |
| `payout_escrow` | `["payout-escrow"]` | tickets | `settle_ticket` (frozen beneficiary only), `claim_payout` | never closed |
| `Integrator` | `["integrator", authority]` | tickets | `open_ticket` (creates it on the first call), `settle_ticket`, `expire_ticket`, `set_share_account`, `set_pause_flags` (its pause flag) | never closed |
| `Ticket` | `["ticket", integrator, nonce]` | tickets | `open_ticket`, `request_randomness`, `settle_ticket`, `expire_ticket`, `claim_payout` | closed at settlement or expiry, or by `claim_payout` for a `PayoutPending` ticket; rent to its payer |
| `vrf_payer` | `["vrf-payer", ticket]` | tickets | `open_ticket`, `request_randomness`, `settle_ticket`, `expire_ticket` | drained to the ticket's payer at close |
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
| `settle_ticket`, `expire_ticket` | `Vault`, `vault_usdc`, `Integrator`, `Ticket`, `vrf_payer`, beneficiary or `payout_escrow` | — |
| `claim_payout` | `payout_escrow`, `Ticket` | — |
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

- **A liquidity provider makes one move.** A keeper strikes because it is paid to, then claims because each request pays its own claimer. The shares or the USDC arrive in the owner's wallet about ten minutes after the request, and the request's rent comes back in the same transaction. An owner who claims for themselves collects their own `CLAIM_FEE`.
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
- `apply_params`: anyone, at or after `effective_at`.
- `cancel_params`: council only.

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

The other instructions measure: `request_withdraw` 39 681, `strike_epoch` 77 453, `claim_deposit` 25 671, `request_randomness` 33 106 with the ORAO CPI. A 32-outcome payout table raises `open_ticket` to 74 125 and `settle_ticket` to 39 498, and its `open_ticket` transaction, signed by a player acting as its own integrator, is 1 153 bytes: inside the 1 232-byte limit without an address lookup table.

The ticket side, 26 to 30 million tickets a day, is the V1 ceiling and is documented as such. `request_randomness` writes only the ticket and ORAO's accounts, so it does not count against it. The first optimisation, if it is ever needed, is to accrue the protocol and app shares inside `vault_usdc` and sweep them in batches, removing two token transfers from every `open_ticket`. The strike is O(1) and does not appear in the table.

## 10. The V1 instruction set

- **Governance**: `initialize`, `set_params`, `apply_params`, `cancel_params`, `set_pause_flags`, `set_share_metadata` (council only: the share mint's name, symbol and logo in wallets, through Metaplex Token Metadata).
- **Integrators**: `set_share_account`. There is no registration instruction: an integrator's record is created by its first `open_ticket`.
- **Tickets**: `open_ticket`, `request_randomness`, `settle_ticket`, `expire_ticket`, `claim_payout`.
- **Liquidity providers**: `request_deposit`, `request_withdraw`, `strike_epoch`, `claim_deposit`, `claim_withdraw`.

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
8. **Parameter queue**: a change that only tightens applies at once; any loosening waits its longest class delay; `apply_params` before `effective_at` fails.
9. **Drawdown**: a strike that pays out 20 % of assets in withdrawals leaves the breaker untouched, after-close results pending or not; a 15 % fall of the share price within 24 hours trips it; caps are halved for the clean day after the peak leaves the window.
10. **Settled pricing**: a ticket opened after an epoch's close leaves that epoch's strike price unchanged, whether it is still open at the strike or was settled or expired before it, won or lost.
11. **No stray transfer or pre-created request blocks a ticket**: lamports sent to a ticket's ORAO request address, or a request anyone created there first through ORAO — `request_v2`, or the deprecated `request`, which still creates a legacy account at the same address — leave `request_randomness` able to succeed and the ticket able to settle once ORAO answers.
12. **No owner account holds a record open or its funds**: a claim whose destination cannot receive — closed, frozen, or handed to another owner — still releases every record it reads, and delivers later, to that account or, with the owner's signature, to another of the owner's.
13. **No worthless queue lives on**: shares owed zero assets are burnt at their strike, so no epoch stays live, and no strike is paid, without a request behind it.
