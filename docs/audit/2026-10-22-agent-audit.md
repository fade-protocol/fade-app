# Agent audit of the Fade program (22 October 2026)

An AI security audit of the on-chain program (`programs/fade`, `crates/fade-math`), the fixes of its five confirmed findings, the review of those fixes, and a fresh re-audit of the fixed program. **It is not a substitute for an independent human audit before mainnet** (see [Limits](#limits)).

| Part | What it holds |
| --- | --- |
| [Original report](#original-report) | The audit as delivered on 22 October 2026: scope, method, five confirmed findings (F-1 to F-5) with their proofs, two rejected candidates, its limits |
| [Fixes](#fixes) | Per finding: the change and its regression tests |
| [Review record](#review-record) | The review of the fixes, in rounds |
| [Re-audit record](#re-audit-record) | The fresh audit of the fixed program and what it confirmed |
| [Limits](#limits) | What this record does not establish |

## Original report

The report is kept as delivered. Its proof paths name the auditors' local worktrees and scratch copies, which are not part of the repository: each proof now lives in `programs/fade/tests/`, inverted, as the regression test of its fix (see [Fixes](#fixes)).

### 1. Scope and method

**Target.** The Fade on-chain program (Solana, Anchor). Fade is a payout protocol: apps open fixed-odds tickets against a shared USDC vault, LPs hold vault shares priced by epoch strikes, randomness comes from ORAO VRF, and a "shared beacon" lets small tickets share one draw per round.

- Code: `programs/fade/src` (all instructions, state, errors, events) and `crates/fade-math` (the pure math the program uses).
- Intended behaviour: `docs/spec/0*.md`, `08-program-architecture.md`, `09-shared-beacon.md`, `README.md`, `docs/product/beacon-integration.md`.
- Out of scope: client apps, keeper, UI.

**Threat model.** Any signer can call any instruction with any accounts and arguments, in any order and any slot, and can bundle several instructions in one transaction. The attacker can be an app (integrator), a ticket buyer, an LP, a keeper or cranker, a sponsor, or a third party. ORAO fulfils honestly but at an unknown time. Validators can reorder transactions within a slot. The council and guardian are trusted to follow governance, but their powers must match the spec.

**Method.**

- **Fresh context.** The auditors did not read the git history or earlier reviews. The code was judged as it stands.
- **8 lenses.** Each lens hunted one class of issue: access control and account validation, arithmetic and rounding, vault and share accounting, randomness and draw integrity, lifecycle and state machine, governance and timelocks, lamport and rent lifecycle, liveness and denial of service.
- **4 hunt rounds.** Each round re-hunted with the previous candidates in view, looking for issues that combine with them.
- **Proof by failing test.** A candidate counts as confirmed only when a LiteSVM test, using the real program binary and real instructions, reproduces the defect. Each proof test asserts the faulty behaviour, so it passes on the current code and will fail once the defect is fixed.
- **Skeptic review.** A separate reviewer tried to refute every proven finding against the code, the spec and the threat model. Only findings that survived are listed as confirmed.

No transaction was sent to any cluster. No program source was modified; proof tests live in separate worktrees or scratch copies (paths below).

### 2. Summary of confirmed findings

| # | Severity | Title | Location |
|---|---|---|---|
| F-1 | Medium | An instant kappa cut lets the council freeze LP exits with no timelock | `state.rs:201`, `state.rs:150`, `strike.rs:89-97`, `fade-math/src/risk.rs:266-276` |
| F-2 | Medium | `expire_ticket` forfeits a never-requested direct ticket even when its ORAO request already exists, fulfilled (draw withheld, undetected) | `settle.rs:335-366`, `request_randomness.rs:120-127` |
| F-3 | Low | On a late ORAO fulfilment, the slot leader can order an expiry ahead of the fulfil and void only winning tickets | `settle.rs` `expire_ticket` (about 335-371), `round_end.rs:313-358` |
| F-4 | Low | ORAO's rent refund for a direct ticket that expired with a pending request is stranded on `vrf_payer` for good | `settle.rs:143-166`, `settle.rs:335-410`, `request_randomness.rs:173-205` |
| F-5 | Low | In the `no-timelock` build, `set_params` silently drops a treasury change and clears any pending change | `governance.rs:31-52` |

### 3. Confirmed findings

#### F-1 (Medium): An instant kappa cut lets the council freeze LP exits with no timelock

**Location.** `programs/fade/src/state.rs:201` (`change_delay`: only `n.kappa_bps > o.kappa_bps` is delayed); `programs/fade/src/state.rs:150` (`is_valid`: `kappa_bps` only needs to be in `1..=BPS`); `programs/fade/src/instructions/strike.rs:89-97` together with `crates/fade-math/src/risk.rs:266-276` (`withdrawable`).

**Description.** `change_delay` treats a lower `kappa_bps` as a tightening, so `set_params` applies it at once. Kappa is not only an admission bound, though. `strike_epoch` passes the live `config.params` into `risk::withdrawable`, which keeps `max(committed, ceil(reserved * BPS / kappa))` in the vault. At a small kappa that term is many times the reserved liability; at kappa = 1 bps it is 10,000 x reserved.

This contradicts the spec:

- Spec 05 §2.2: "LP withdrawals are blocked only up to currently reserved liability, never beyond."
- Spec 05 §4: no governance path may "trap capital".
- Spec 05 §3: the delay table has no row for kappa. Spec 04 calls kappa = 0.8 a hard invariant.

`is_valid` puts a floor of only 1 bps on kappa, and does not even require `kappa_bps >= utilisation_breaker_bps`. Lowering `utilisation_breaker_bps` is also instant, so both can be cut together. The change is a tightening for admission but a loosening against LPs. It also defeats the exit window that every delayed change relies on: the council can cut kappa at once and queue, at the same moment, a 7-day `protocol_share_bps` raise or a `min_vault_margin_bps` cut. LPs then cannot leave during the window that exists so they can leave.

**Attack.**

1. The vault holds 10,000,000 USDC with kappa = 8000.
2. The council calls `set_params` with `kappa_bps = 1` (and optionally `utilisation_breaker_bps = 1`). Both count as tightenings, so the delay is 0 and they apply in that transaction.
3. In the same transaction or right after, the council calls `set_params` again with `protocol_share_bps` raised. That change is queued for 7 days.
4. After each epoch close, any ticket buyer, colluder or app opens tickets with about 1,000 USDC of liability. Admission allows it, because reserved liability may reach kappa x assets = 1,000 USDC.
5. At every strike, reserved = 1,000 USDC, so `for_kappa` = 1,000 x 10,000 = 10,000,000 and `withdrawable` = 0. Every queued withdrawal gets 0 and rolls to the next epoch.
6. Repeating step 4 each epoch keeps all LP capital locked for the whole 7-day window and beyond, although only 1,000 USDC is actually reserved. No timelock, guardian action or upgrade is needed.

**Proof.** Test `an_instant_kappa_cut_freezes_lp_exits_during_a_queued_7d_change` in `programs/fade/tests/kappa_withdraw_freeze.rs` (in a scratch copy of the repository).

- Setup: `RiskParams::SPEC`, one LP founds the vault with 10,000 USDC.
- The council cuts kappa from 8000 to 77 bps. It applies at once (`pending.active == false`).
- The council queues `protocol_share_bps` 20 -> 400 (7 days).
- The LP requests withdrawal of all its shares. After the close, a buyer opens 8 USDC coin flips until admission refuses with `GlobalExposure`. Reserved is 76.96 USDC (about 0.77% of assets).
- First strike: 10,000 USDC owed, 85.03 USDC paid. About 9,923 USDC that is not reserved stays locked.
- Next epoch (old tickets played out, cap refilled after the close): 79.84 USDC paid, about 98% of the shares still queued, and the 7-day change still pending.
- Control: `risk::withdrawable` with SPEC kappa on the same reserved amount returns more than 9,900 USDC.

```
running 1 test
assets=10000000000 reserved=76960000 owed=10000000000 paid=85034805
epoch2 paid=79840000 rolled 9914965195000 -> 9835762968864
test an_instant_kappa_cut_freezes_lp_exits_during_a_queued_7d_change ... ok
test result: ok. 1 passed; 0 failed
```

Command: `SBF_OUT_DIR=<worktree>/target/deploy cargo test -p fade --test kappa_withdraw_freeze` (pre-built `fade.so`, newer than every source file).

Limits: a full lock needs reserved liability refilled near kappa x assets after each close. The attacker pays ticket prices and the expected loss on about 0.77% of assets per epoch, which is cheap. With kappa = 1 bps a single minimum ticket overshoots the cap on a 10k vault, so the lock is looser there; on a larger vault it gets tighter.

**Skeptic review.** Not refuted. The council stays within its instruction set, but the effect (exits frozen beyond reserved liability, with no notice, during a promised exit window) contradicts Spec 05 §2.2 and §4. The rest of the attack is open to anyone, and even ordinary traffic can fill the tiny cap.

**Recommended fix.** Keep kappa out of the instant path in both directions. Options:

- Delay any change to `kappa_bps` by 24h, as `strike_reward_lamports` already is ("either way touches liveness").
- Floor kappa in `is_valid`, for example `kappa_bps >= utilisation_breaker_bps` plus a program-constant minimum, so the strike can never hold back more than a bounded multiple of reserved liability.
- Or make the strike use `max(live kappa, kappa used at the last strike)`, or simply `assets - committed` as Spec 05 §2.2 states, and keep kappa as an admission bound only.

---

#### F-2 (Medium): `expire_ticket` forfeits a never-requested direct ticket even when its ORAO request already exists, fulfilled

**Location.** `programs/fade/src/instructions/settle.rs:335-366` (`expire_ticket`: the ORAO check only runs for status `Requested`; `randomness` is unchecked for `Open`); `programs/fade/src/instructions/request_randomness.rs:120-127` (no late binding after `expiry_slot`, even for a request ORAO already created). Compare `round_end.rs:556-590` (`unrequested_request`) and `request_round_draw.rs:242-246`.

**Description.** A direct ticket's ORAO seed is `SHA256(tag, program, ticket, open_slot, s*, h*)`, where `s*` is the first slot after `open_slot`. That seed is public from `open_slot + 2`. ORAO's `request_v2` is permissionless, so anyone can create the request at the derived PDA and read the fulfilled randomness about 6 to 8 slots later. With `outcome_hash` and `select::draw`, the outcome then follows off-chain.

When the ticket is still `Open`, `expire_ticket` checks only `slot > expiry_slot`. It accepts any `randomness` account and never looks for a request at the derived address. Spec 02 §2 allows `Open|Requested -> Expired` only when "no fulfilled request exists at call time". The beacon path enforces exactly that for an unrequested round: `unrequested_request` derives the request address and returns `AlreadyFulfilled`, and `request_round_draw` binds a fulfilled pre-created request after the window. The direct path has neither. After `expiry_slot`, `request_randomness` refuses even a request ORAO has already fulfilled (`RequestWindow`). So a withheld draw on the direct path goes undetected, is not counted in `forfeits_withheld`, and pauses nothing.

**Attack.** The attacker is a party that gains from forfeitures and normally does the cranking, for example an LP running the keeper.

1. A player opens ticket T at slot o.
2. At o+2 the attacker computes T's seed from SlotHashes and calls ORAO `request_v2` for it, paying ORAO's fee. Within about 8 slots ORAO fulfils, and the attacker computes T's outcome.
3. If T loses, the attacker calls `request_randomness` (the pre-created path binds the request) and `settle_ticket`, collecting both crank shares.
4. If T wins, the attacker waits until `slot > o + t_settle_slots` and calls `expire_ticket(T)` with any `randomness` account. The ticket is forfeited, the payout stays in the vault, and `forfeits_withheld` is not incremented.

On the flow the attacker cranks alone, every winning direct ticket is voided while losers settle normally. Each case costs one ORAO fee. A player can still save the ticket by calling `request_randomness` inside the window, but most players rely on the keeper.

**Proof.** Test `a_winning_ticket_whose_fulfilled_request_was_never_bound_is_forfeited` in `programs/fade/tests/expire_unbound_fulfilled.rs` (in a scratch copy of the repository).

1. A player opens a 25 USDC coin-flip direct ticket (a win pays 49 USDC).
2. Two slots later the attacker derives the seed from SlotHashes and calls the ORAO mock's `request_v2` at the derived address.
3. ORAO fulfils with a non-zero value; the attacker computes off-chain that the ticket wins.
4. The request is not bound. After 151 slots, even the player's own `request_randomness` fails with `RequestWindow`.
5. `expire_ticket` on the still-`Open` ticket succeeds, even when it is handed the fulfilled request at the derived address.
6. The ticket is closed. The player gets nothing (balance = start - 25 USDC). The vault keeps the credit: `total_assets = 5000 + 25 - 0.05 USDC`, reserved and open credits back to 0, `forfeits_withheld = 0`.

```
running 1 test
test a_winning_ticket_whose_fulfilled_request_was_never_bound_is_forfeited ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
```

The test ran on an rsync copy of the fade sources (without `target`, `node_modules`, `keys`, `.env`, `.git`), built with `anchor build --no-idl` and `cargo build-sbf`.

**Skeptic review.** Not refuted. The seed is public at open+2, `request_v2` is permissionless, and the program itself expects pre-created requests (comment in `request_randomness`, Spec 08 §12 item 11). Spec 09 and Spec 08 §13.5.8 name this exact attack for rounds and close it, and say round expiry works "like a direct ticket", but the direct path has none of those protections. Mitigating factors: the off-chain isolated-expiry alarm (Spec 02 §7) may catch some cases, and the attacker must be the only cranker inside the 150-slot window and pay one ORAO fee per ticket.

**Recommended fix.** Treat a never-requested direct ticket the way `expire_round` treats an unrequested round:

- In `expire_ticket` with status `Open`, derive the seed from SlotHashes (`first_after(open_slot)`; at expiry, at most about 401 slots after open, SlotHashes still holds `s*`). Require `randomness` to be ORAO's request PDA for that seed. If ORAO owns it and it parses as Fulfilled with non-zero randomness, return `AlreadyFulfilled`.
- In `request_randomness`, after `expiry_slot`, allow binding only a request ORAO already owns and has fulfilled non-zero, mirroring `request_round_draw`'s late path, so such a ticket can settle.
- Optionally record the seed on the ticket at open+2 (as `record_round_entropy` does) so the check never depends on the sysvar, and count expiries of unrequested tickets whose request exists as withheld forfeitures.

---

#### F-3 (Low): On a late ORAO fulfilment, the slot leader can order an expiry ahead of the fulfil and void only winning tickets

**Location.** `programs/fade/src/instructions/settle.rs`, `expire_ticket` (the task cited lines 577-613; the skeptic found the function at about lines 335-371 in the current 469-line file); `programs/fade/src/instructions/round_end.rs:313-358` (`expire_round`).

**Description.** Once `slot > expiry_slot` (direct path) or `slot > close_slot + t_settle_slots` (beacon), expiry depends only on whether the bound ORAO request is still unfulfilled at the moment the expire instruction runs. Nothing records when expiry became possible, and nothing makes the choice blind to the draw.

ORAO's final fulfil transaction carries the response that completes R, and the earlier responses are already on-chain. Whoever holds that transaction before it executes (the slot leader, or a bundle relayer) can compute R, and therefore the outcome of the ticket or of every round ticket (`outcome_hash` and `round_outcome_hash` are public functions of R). Since validators can reorder within a slot, the leader can put `expire_ticket` or `expire_round` ahead of the fulfil when the outcome favours the player, and let the fulfil land first otherwise.

Spec 02 §2.1 says the settle/expire race puts "no funds at risk". §2.2 admits suppression of wins by bribed ORAO key holders, but never names the slot leader. Here a party outside the oracle can void only winning tickets, so §2.1's claim does not hold for this case. It only applies when ORAO fulfils after T_SETTLE (150 slots by default): uncommon, but exactly the case the expiry path exists for.

**Attack.**

1. A player opens a direct ticket (or joins a round), and it is requested inside the window.
2. ORAO is slow; its final fulfil for the request reaches leader L at a slot past expiry.
3. L (or an LP working with L) reads the earlier responses plus the incoming one, derives R, and computes `select::draw` / `select::outcome`.
4. If the ticket wins, L puts `expire_ticket` / `expire_round` earlier in the same slot. The request still reads Pending, so the expiry succeeds and the vault keeps the credit. If the ticket loses, L lets the fulfil land first and the ticket settles as a loss.
5. For late fulfilments, LPs keep every loss and void every win. The player's expected value falls below the table's stated RTP.

**Proof.** Test `a_late_fulfil_lets_the_slot_orderer_void_only_winning_tickets` in `programs/fade/tests/late_fulfil_expiry_ordering.rs` (in a scratch copy of the repository).

- Opens a 25 USDC coin-flip ticket, requests randomness, and moves past `expiry_slot` with the request still pending. The leader computes the outcome from public data only.
- Neutral order (fulfil first): `expire_ticket` fails with `AlreadyFulfilled`; settle pays 49 USDC.
- Leader's order: on a winning R, `expire_ticket` runs first and succeeds; the fulfil lands right after in the same slot; the ticket is forfeited and `total_assets` keeps the credit. On a losing R, the fulfil runs first and the ticket settles as a loss. Under both draws the player gets 0.

```
running 1 test
test a_late_fulfil_lets_the_slot_orderer_void_only_winning_tickets ... ok
test result: ok. 1 passed; 0 failed
```

Run with `SBF_OUT_DIR=<worktree>/target/deploy` after `pnpm build:sbf`.

Limits: the ORAO mock writes R directly. Learning R before the final fulfil executes depends on ORAO's off-chain behaviour, which LiteSVM cannot model; the test takes it as given. What the test proves on-chain is that, past expiry, transaction order inside the slot alone decides settle versus forfeit. The beacon path (`expire_round`) was not tested; reading the code, it relies on the same "request still pending" check and is very likely affected the same way.

**Skeptic review.** Not refuted. Severity stays low: it needs ORAO to be late (past 150 slots), the gain is spread pro rata across LPs (so the leader profits only as or with an LP), and it is bounded per ticket by the liability cap and per round by the round cap.

**Recommended fix.** Make the expiry decision blind to the draw:

- Expire only on evidence fixed before R could exist: for example, record an "expiry armed" slot, require the expire call to land at least a few slots after it, and accept a settle whose fulfilment predates that slot.
- Or adopt the outcome-blind derivation planned for after V1 (`SHA256(R || h')`, with `h'` the hash of a slot after fulfilment), so no one can tell a win from a loss when ordering the race.
- At minimum, correct Spec 02 §2.1 so it no longer claims the race is economically neutral, and count every expiry of a requested ticket in the withheld-draw alarm.

---

#### F-4 (Low): ORAO's rent refund for a direct ticket that expired with a pending request is stranded on `vrf_payer`

**Location.** `programs/fade/src/instructions/settle.rs:335-410` (`expire_ticket` drains `vrf_payer`, then closes the ticket); `settle.rs:143-166` (`drain_vrf_payer`); `request_randomness.rs:173-205` (`vrf_payer` is the ORAO request payer). Compare `round_end.rs:592-697` (`sweep_round_vrf`).

**Description.** On the direct path, `vrf_payer` (seeds `[vrf-payer, ticket]`, system-owned PDA) pays ORAO's `request_v2`. When ORAO fulfils, it refunds the pending rent down to the fulfilled size to that payer (Spec 07 §8: "ORAO's rent refund at fulfilment lands here first"). `expire_ticket` accepts a ticket whose request is still Pending, drains `vrf_payer` as it stands, and closes the ticket. If ORAO fulfils afterwards, the refund lands on `vrf_payer` after the ticket is gone. Only `settle_ticket` and `expire_ticket` sign with `vrf_payer`'s seeds, and both need the live Ticket account. The ticket address is never re-created, because the integrator nonce only moves forward. Those lamports can never move again, which breaks Spec 07 §8 ("whatever vrf_payer holds goes back to payer"). The beacon path covers the same case with `sweep_round_vrf`; the direct path has no equivalent.

**Attack.**

1. The payer opens a direct ticket; a keeper calls `request_randomness`, and `vrf_payer` pays ORAO the fee plus the pending rent.
2. ORAO has not fulfilled by `expiry_slot`. Anyone calls `expire_ticket`: the request reads Pending, so it passes; `vrf_payer` is drained to 0 and the ticket closed.
3. ORAO fulfils later and refunds the rent difference to `vrf_payer` (about 426,000 lamports at the SIMD-0437 last-step rent, more at today's rent).
4. No Fade instruction can sign for `vrf_payer` any more. Anyone who delays a fulfilment past expiry causes this for every such ticket, and the payer loses the refund each time.

**Proof.** Test `orao_refund_after_expiry_is_stranded_on_vrf_payer` in `programs/fade/tests/vrf_payer_stranded_refund.rs` (in a scratch copy of the repository).

1. Opens a direct ticket and calls `request_randomness` (pending ORAO request, `vrf_payer` as client).
2. Builds `settle_ticket` and `expire_ticket` instructions while the ticket still exists.
3. Advances past `expiry_slot`; `expire_ticket` succeeds on the Pending request; ticket closed, `vrf_payer` at 0.
4. ORAO fulfils late through the mock (which shrinks the account and refunds excess rent, as the real quorum does): 4,259,520 lamports land on `vrf_payer`; the payer's balance is unchanged.
5. Both pre-built instructions now fail with `AccountNotInitialized` (3012).
6. After 10,000 more slots the lamports are still on `vrf_payer`.

```
running 1 test
stranded refund on vrf_payer: 4259520 lamports (pending 6103920, fulfilled 1844400)
test orao_refund_after_expiry_is_stranded_on_vrf_payer ... ok
test result: ok. 1 passed; 0 failed
```

Run on a scratch copy of the repository built with `scripts/build-sbf.sh --no-idl`.

**Skeptic review.** Not refuted. The mock's refund matches what the spec itself says ORAO does (Spec 02, Spec 07 §8, Spec 09, Spec 08 §13.5.8a). Spec 08 decision 14 added `sweep_round_vrf` precisely because these lamports "would otherwise be stranded". Impact: lamports only, no USDC, no gain for an attacker, and only when ORAO is late past T_SETTLE.

**Recommended fix.** Add a permissionless direct-ticket sweep mirroring `sweep_round_vrf`: take `(integrator, nonce)`, derive the ticket and `vrf_payer`, require the ticket to be closed and `nonce < integrator.next_nonce`, and transfer `vrf_payer`'s lamports to the payer, signed with `[VRF_PAYER_SEED, ticket, bump]`. The payer must be pinned, either with a small per-ticket tombstone or a PDA derived from the ticket address that stores it. Simpler alternative: refuse to close a ticket with a still-Pending request until a grace period has passed, and document the residual loss. The sweep is preferred because it matches the beacon path.

---

#### F-5 (Low): In the `no-timelock` build, `set_params` silently drops a treasury change and clears any pending change

**Location.** `programs/fade/src/instructions/governance.rs:31-52` (`if cfg!(feature = "no-timelock") { delay = 0; }` followed by the `applied` branch, which writes only `config.params`).

**Description.** `set_params` reads `treasury = ctx.accounts.protocol_treasury.key()` and raises the delay to 72h when it differs from `config.protocol_treasury`. The pending path stores the treasury, and `apply_params` copies it into `config.protocol_treasury`. The `no-timelock` feature (which requires `devnet`) forces `delay = 0`, so every call takes the `applied` branch. That branch sets `config.params = params` and `config.pending.active = false` but never writes `config.protocol_treasury`, while `ParamsChanged` still reports `applied: true`. On a no-timelock devnet build the treasury therefore cannot be changed by any route, and the call discards any change already queued. Spec 08 §7 and the feature's own comment say this build "applies every change at once", and the treasury is part of the change. The only other writers of `protocol_treasury` are `initialize.rs:75` and `apply_params` (`governance.rs:78`). The mainnet build is not affected: there a treasury change always goes through the 72h pending path.

**Attack (operational).** On a `devnet,no-timelock` build, the council calls `set_params(params)` with a new treasury B while the config holds A. The call succeeds with `applied: true`, but the treasury stays A, and `apply_params` fails with `NoPendingChange`. `open_ticket` keeps sending the protocol share to A and `claim_shares` keeps paying `protocol_shares_accrued` to A. An operator who moved away from A (for example after a key leak) keeps sending protocol revenue there without any on-chain error.

**Proof.** Test `no_timelock_set_params_drops_treasury_change_and_clears_pending` in `programs/fade/tests/no_timelock_treasury.rs` (in a scratch copy of the repository), run against the current devnet binary `target/devnet/fade.so` (features `devnet,no-timelock`; no source file is newer than it).

1. Writes a version-2 `Config` with `protocol_treasury` A and an active pending change moving the treasury to C.
2. The council calls `set_params(SPEC)` passing token account B.
3. `set_params` succeeds and emits `ParamsChanged`; `protocol_treasury` is still A; `pending.active` is false (the move to C is lost); `apply_params` then fails with `Custom(6006)` (`NoPendingChange`).

```
running 1 test
set_params logs:
Program GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt invoke [1]
Program log: Instruction: SetParams
Program GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt invoke [2]
Program GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt success
Program GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt consumed 11678 of 200000 compute units
Program GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt success
after set_params: protocol_treasury=1119DWteoLSdjvrT6g6L8C2PfDD2faiTQUpsjY2RiF (A=1119DWteoLSdjvrT6g6L8C2PfDD2faiTQUpsjY2RiF, B=111BuZ6b86gm7XhxjvTakhRvxSMjXp2GqgifkNUmDK), pending.active=false
apply_params error: InstructionError(0, Custom(6006))
test no_timelock_set_params_drops_treasury_change_and_clears_pending ... ok
test result: ok. 1 passed; 0 failed
```

**Skeptic review.** Not refuted for the main defect (the treasury can never change on a no-timelock build). Caveat: the "clears an already-queued change" part needs a Config that already holds an active pending change, which a no-timelock binary cannot create itself; it only arises after an upgrade from a timelocked build with a change in flight. Devnet-only, no attacker gain: low.

**Recommended fix.** In the `applied` branch, also write `config.protocol_treasury = treasury;`. Better, use a single code path that applies both `params` and `protocol_treasury` whenever `delay == 0`, so the no-timelock build matches what `apply_params` produces.

### 4. Rejected findings

| Title | Location | Claimed severity | Verdict | Reason |
|---|---|---|---|---|
| A ticket payer can make its ticket impossible to settle, which pins the epoch counter and blocks every strike | `settle_round.rs:660-678`, `round_end.rs:923-925`, `join_round.rs:771` | Medium | Not proven (disproved) | The attack needs crediting an executable payer to fail (`ExecutableLamportChange`). SIMD-0162 (`remove_accounts_executable_flag_checks`) is active on mainnet and devnet per the repo's own feature fixtures, and the Agave 4.2 runtime the program targets has no such check left. Rent-state, write-lock demotion and ownership were also ruled out. A test that turns the payer into an executable upgradeable-loader program and runs `settle_round_tickets` on 3 tickets succeeds: every ticket closes and `round.tickets` reaches 0. |
| Direct path: the payer can make a winning ticket fail `settle_ticket` by emptying its account and dusting `vrf_payer`, so the ticket can neither settle nor expire | `settle.rs:143-166`, `295-305`, `312-319`, `377-381`; `open_ticket.rs:242` | Medium | Not proven (disproved) | The dust step cannot happen: the runtime refuses to turn an empty 0-data system account into a rent-paying one (1 lamport and `rent_min - 1` both fail with `InsufficientFundsForRent`). `vrf_payer` is therefore always 0 or at least the rent-exempt minimum, so the drain leaves the payer rent-exempt. Two tests (with and without ORAO's fulfilment refund) show `settle_ticket` succeeds and strikes are not blocked. Untested side note: a payer whose lamports cannot change at all (for example an executable program later deployed at the emptied keypair's address) is worth a separate check. |

### 5. Limits of this audit

- **This is an AI audit. It is not a substitute for an independent human audit before mainnet.** The program holds LP capital and player funds; a professional audit firm should review it before any mainnet deployment.
- The audit covered only `programs/fade/src` and `crates/fade-math`. Client apps, keeper, UI, deployment scripts, upgrade authority set-up and key management were out of scope.
- ORAO VRF was modelled with a mock. Properties that depend on ORAO's off-chain behaviour (when responses become visible, fulfil latency, quorum behaviour) were taken from the spec, not tested against the real oracle.
- LiteSVM does not model leader scheduling, mempool visibility, Jito bundles or cross-slot timing. Ordering attacks (F-3) are proven at the program level only.
- The beacon path of F-3 (`expire_round`) was inferred from code reading, not tested.
- Some proofs ran against pre-built binaries or scratch copies of the repo (not git worktrees). The binaries were checked to be newer than every source file, but a fresh build from a clean checkout should re-run all five tests before fixes are merged.
- The absence of other findings does not mean the absence of other defects. Coverage is bounded by the 8 lenses and 4 rounds, and rejected candidates were rejected only for the specific attack described.
- Proof tests sit outside the fade repo's `programs/fade/tests/`; they should be copied there so each fix can be shown to flip its test.

## Fixes

The fix design sets, per finding, the program change, the spec text, the client, keeper and app changes and the tests. Every proof test of the report is brought into `programs/fade/tests/` inverted: it asserts the fixed behaviour and fails on the audited binary.

| # | Change | Regression tests |
| --- | --- | --- |
| F-1 | `kappa_bps` is floored at `MIN_KAPPA_BPS` (8 000) in `RiskParams::is_valid`, every change to it waits 24 hours in either direction, and `apply_params` checks the pending parameters again, so no parameter change can make the strike hold back more than 1.25 times the reserved liability without notice | `programs/fade/tests/kappa_floor.rs`: `kappa_below_the_floor_is_refused`, `a_kappa_cut_gives_a_day_of_notice`, `apply_params_checks_the_pending_parameters_again`; `crates/fade-math/tests/properties.rs` |
| F-2 | The direct path follows `expire_round`'s rules. `record_ticket_entropy` records an Open ticket's seed; `request_randomness` binds, after the window, a request created through ORAO at that seed and fulfilled non-zero; `expire_ticket` needs an Open ticket's seed recorded and the derived request address, and refuses a fulfilled one; `refund_expired_ticket` returns the vault credit of a ticket whose seed was never recorded once SlotHashes no longer proves it. `TicketExpired` moves to version 2 | `programs/fade/tests/direct_expiry.rs`: `a_fulfilled_request_nobody_bound_is_never_forfeited_and_is_bound_late`, `a_recorded_seed_outlives_slot_hashes`, `record_ticket_entropy_is_idempotent_and_open_tickets_only`, `an_open_ticket_needs_its_recorded_seed_and_the_derived_address`, `nothing_is_requested_after_the_window`, `a_ticket_whose_entropy_is_lost_is_refunded_its_credit`, `a_refund_to_a_frozen_beneficiary_waits_in_escrow`; the state machine in `beacon_state_machine.rs` models the new direct expiry |
| F-3 | Counted and documented, not removed: `Vault.ticket_forfeits_withheld` counts every expiry a withheld draw may explain, `TicketExpired` v2 carries the findings and the ordinal, and the keeper raises the direct withheld alarm on `/v1/health`. Spec 02 names the slot orderer of a late fulfil among those who can withhold a draw. Whether the outcome-blind `SHA256(R ‖ h')` derivation is required before mainnet is an open question | `direct_expiry.rs`: `an_expiry_ordered_ahead_of_a_late_fulfil_counts_as_withheld`, `a_pending_request_nobody_bound_is_reported_and_counted`, `a_zero_fulfilment_forfeits_and_counts`, `a_bound_request_someone_else_paid_for_is_not_pending_a_refund` |
| F-4 | `sweep_ticket_vrf(nonce)` moves what reaches a closed ticket's `vrf_payer` (ORAO's rent refund after an expiry with a pending request) to its caller; the keeper sweeps after every expiry whose `TicketExpired.pending` is set, its own or someone else's; `pnpm devnet:sweep-ticket-vrfs` sweeps what the live deployment already stranded | `programs/fade/tests/sweep_ticket_vrf.rs`: `orao_refund_after_an_expiry_is_swept_to_the_caller`, `a_live_ticket_or_a_future_nonce_is_refused` |
| F-5 | `set_params` and `apply_params` apply a change through one helper, so the `no-timelock` build writes the treasury with the parameters | `programs/fade/tests/no_timelock_treasury.rs`: `a_treasury_change_applies_with_the_parameters` |

## Review record

The fixes were reviewed in rounds; each round's confirmed findings were fixed before the next. Twelve rounds confirmed 49 findings, all fixed. Most were off-chain: the keeper's sweep of `vrf_payer` and its alarms, the app's reading of a refunded direct ticket and its wording, the cache invalidation for the version-2 `TicketExpired`, the devnet upgrade and pause scripts, and the documentation. No round came back clean, and the twelfth round's five fixes, all off-chain or documentation, were not reviewed again.

## Re-audit record

A fresh audit of the fixed program, run in rounds; it stopped after two rounds reporting nothing.

| Round | Reported | Fresh | Confirmed |
| --- | --- | --- | --- |
| 1 | 2 | 2 | 0 |
| 2 | 3 | 3 | 2 |
| 3 | 2 | 2 | 1 |
| 4 | 2 | 2 | 1 |
| 5 | 0 | 0 | 0 |
| 6 | 0 | 0 | 0 |

Dry rounds reached: 2. Confirmed: 4. Rejected: 5.

| Confirmed finding | Round | Fix and regression tests |
| --- | --- | --- |
| Ten minimum-price joins can fill a paid round for free under the h·k floor, so every later join in the tick goes to a new unpaid round | 2 | The h·k floor is the paying join's alone (`within_join_share` takes `pays_round`); `programs/fade/tests/beacon.rs` `floor_sized_joins_cannot_fill_a_paid_round`, the fade-math properties and vectors |
| Lengthening `epoch_length_seconds` applies instantly up to 86 400 s, so LPs can no longer exit inside a 24-hour loosening's notice window | 2 | `epoch_length_seconds` is bounded by `MAX_EPOCH_LENGTH_SECONDS` (21 600 s); `programs/fade/tests/epoch_notice.rs` |
| A ticket payer turned into a program after the open makes every exit of that ticket fail, so the epoch counter it holds never drops and `strike_epoch` is blocked for good | 3 | Ticket exits never hand the stored payer to a CPI, `vrf_payer` drains onto the ticket and the payer is credited by the close; `programs/fade/tests/executable_payer.rs`, `beacon.rs` `a_payer_turned_program_never_fails_a_batch` |
| Pausing one integrator does not stop it: the same party opens tickets again under a new authority, so the guardian's only working response is a global pause | 4 | Spec 05 states that the targeted pause binds a key, not a party, that the playbook sets `PAUSE_NEW_INTEGRATORS` with it, and that `PAUSE_TICKETS` alone is the control against a hostile integrator on both paths, beacon joins and sponsorship included; `programs/fade/tests/integrator_pause_rotation.rs` |

The re-audit's third finding is the case the original report's second rejected candidate left as "worth a separate check": a payer whose lamports cannot change, such as a program later deployed at its address.

## Limits

- **This is an AI audit. It is not a substitute for an independent human audit before mainnet.** The program holds LP capital and player funds; a professional audit firm reviews both paths, the beacon included, before any mainnet deployment.
- The review of the fixes stopped with no clean round: its twelfth round's five fixes were not reviewed again. They are off-chain and documentation fixes; the program did not change in those rounds.
- F-3 is bounded and counted, not removed: a fulfil ORAO delivers after `T_SETTLE` still leaves the end of that ticket to whoever orders its slot.
- The limits of the original report (§5 above) still apply to the fixes: ORAO is modelled with a mock, LiteSVM does not model leader scheduling or bundles, and the absence of other findings does not mean the absence of other defects.
