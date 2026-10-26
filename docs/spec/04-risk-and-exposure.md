> [Fade](../README.md) · Technical. Domain document 04 of the [Technical Specification](README.md): owns exposure accounting, the per-ticket cap and the integrator ceiling, capacity against assets, progressive credit, rate limiting under permissionless registration, the Monte Carlo solvency model and the circuit breakers. Parameter values are the Technical Specification's §2 table, which wins wherever the two differ. `vault_balance` in this document is the Technical Specification's `total_assets`.

# Fade Spec 04 — Risk and Exposure

This document is the risk-domain half of the Fade spec: exposure accounting, per-ticket and per-integrator caps,
the time-priced reservation, the per-integrator ceiling, rate limiting under permissionless registration,
and a Monte Carlo solvency model that replaces a single-operator `max_payout_bps = 1000` reference cap
with a number actually sized for a multi-integrator shared vault.

All numeric claims below were computed, and their output is quoted verbatim, not hand-typed. The Monte Carlo in §6/§7 is the **full grid, completed**: 30 distinct parameter
configurations × 150 trial-paths each = **4,500 simulated 30-day vault paths** (reproduced in the Appendix), not a reduced sample.

This document is the risk-domain half of the Fade spec; [Spec 02](02-randomness-and-settlement.md) owns the settlement/VRF
layer, including `T_SETTLE = 150 slots` and `CRANK_FEE = 250,000 lamports`. §3 explains why V1 has
no continuous rent on reserved liability — the settlement layer's flat, mandatory `CRANK_FEE`
already prices sustained reservation-griefing more effectively — and states the forfeiture-on-timeout
rule. §2.4/§6.4 give the per-ticket cap formula, which agrees with Spec 02's independently-derived
"1–2% of TVL" censorship-bounding recommendation. §7.1 cross-references Spec 02's shared-outcome
/round-batch analysis of the same aggregation problem.

Borrowed prior art, stated up front so it's clear what's original vs. adapted:

- **Utilization-based interest curve** (Aave/Compound jump-rate model, and GMX's per-market borrow
  fee that "increases when vault utilization is high") → adapted in §7 as the *hard admission gate*
  (a threshold, not a fee): §3.2 shows a continuous rent on reserved liability is weaker for
  anti-griefing than the settlement layer's flat `CRANK_FEE`, so the utilization curve's role here
  is the admission gate. GMX's per-side `MAX_OPEN_INTEREST` caps and price-impact fees on
  imbalance-increasing trades remain the analogue for the per-integrator and global exposure caps
  in §1/§7.
- **First-loss capital ahead of the vault** (Hyperliquid's insurance fund absorbing shortfalls before
  HLP itself, ADL as the last resort; Aave's Safety Module) → surveyed and **not adopted**: first-loss
  capital needs a predicate for when to take it, and V1 has none (§4.2).
- **Withdrawal friction during stress** (Hyperliquid HLP's 4-day deposit-to-withdrawal lock) →
  surveyed and **rejected**: no breaker or pause ever touches a withdrawal request (Spec 05 §4);
  the drawdown breaker of §7 stops new tickets and halves caps, nothing else. Epoch pricing
  (Spec 01 §3) already removes the exit-at-a-known-NAV problem the lock was meant for.
- **Kelly criterion for capital sizing** → derived from first principles in §2 for the vault side of
  a single ticket, not borrowed as a rule of thumb. The result (per-ticket liability fraction = the
  payout table's own margin, at the EV boundary) is the load-bearing number behind the recommended cap in
  §6, replacing the flat `max_payout_bps = 1000`.

---

## 1. Exposure accounting: counters, granularity, invariant

### 1.1 Accounts and counters

| Account | Counter | Granularity | Written by |
|---|---|---|---|
| `Vault` (singleton) | `vault_balance` (= `total_assets`) | global | `strike_epoch` (+ the epoch's deposits, − the epoch's withdrawals, Spec 01 §3), `open_ticket` (+`vault_credit`: the price net of the shares paid out at open), `settle_ticket` (− payout), `expire_ticket` (nothing: the forfeited credit stays) |
| `Vault` | `open_vault_credits` | global | `open_ticket` (+), `settle_ticket` (−), `expire_ticket` (−) |
| `Vault` | `total_reserved_liability` | global | `open_ticket` (+), `settle_ticket` (−), `expire_ticket` (−) |
| `Vault` | `total_shares` (tracked, equal to the share mint's supply) | global | `strike_epoch` (+ shares minted, − shares burnt, Spec 01 §3) |
| `Vault` | ring of 24 hourly maxima of the share price on settled assets, `(total_assets − open_vault_credits + 1) / (total_shares + 10³)` | global | every instruction that changes the vault's assets updates the current hour; read by the drawdown breaker (§7.3, Spec 08 §8) |
| `Vault` | `drawdown_trip_ts` | global | set by a settlement that leaves the price at or below the breaker's threshold; caps stay halved until 48 h after it (§7.3) |
| `Vault` | `open_before_close`, `open_after_close`, `generation`, and a copy of the live epoch's `close_ts` | global | `open_ticket` (+ to one counter), `settle_ticket` and `expire_ticket` (− from the counter the ticket joined), the request that opens an epoch and `strike_epoch` (roll the counters); read by the strike (Spec 08 §4) |
| `Integrator` (PDA `["integrator", authority]`, created by the integrator's first `open_ticket`, §4.4) | `reserved_liability` | per integrator | `open_ticket` (+), `settle_ticket` (−), `expire_ticket` (−) |
| `Integrator` | `volume_total` (cumulative ticket price opened, monotone) | per integrator | `open_ticket` (+price); read by progressive credit once enabled (§4.3) |
| `Integrator` | `rent_accrued_unpaid` | per integrator | not used in V1 (§3.2) — retained as a field for a possible V2 capacity-pricing signal, always zero today |
| `Ticket` (PDA per ticket) | `price`, `vault_credit`, the full payout table, `margin_bps`, `app_share_bps`, `max_multiplier`, `reserved_liability`, the cap at open, `open_slot`, the `generation` and the counter it joined (Spec 08 §4), `beneficiary`, `crank_fee_lamports`, `status` | per ticket | created by `open_ticket`, closed by `settle_ticket` or `expire_ticket` |
| `CorrelationGroup` (§7.1) | `group_reserved_liability` | per shared-outcome round | **roadmap**, with shared-outcome games (Technical Specification §1); no such account exists in V1 |

### 1.2 The core invariant

```
total_reserved_liability + open_vault_credits ≤ vault_balance     (gross solvency, always — TS invariant 1)
total_reserved_liability = Σ_open_tickets reserved_liability
                          = Σ_integrators integrator.reserved_liability
reserved_liability       = payout_max − vault_credit              (TS §3.5: what the vault can still lose)
free_balance = vault_balance − total_reserved_liability − open_vault_credits   (exact, no approximation)
```

Every admission check (`open_ticket`) and every withdrawal fill (at the epoch strike, Spec 01
§4.3) reads `free_balance`, **never** `vault_balance` directly. This is the fix for hole (c):

- `open_ticket`: `payout_max − vault_credit ≤ cap(free_balance)` and the integrator's open
  liability, the new ticket included, `≤ 20 % · vault_balance` (§2.4, §4.1).
  `free_balance` here is the value *after* subtracting every ticket still open, not just the
  requesting integrator's own — a second integrator's cap is checked against what the *first*
  integrator has already reserved. This is what stops "ten concurrent tickets each at 10% commit
  100% of the vault": the second ticket's 10% is computed against the 90% still free, the third
  against the free remainder, etc. — a geometric decay, not ten independent 10% bites of the
  original balance. (Whether that decay itself lets 10 tickets still exhaust ~65% of the vault is
  exactly why §6 replaces the flat 10% figure.)
- Withdrawals are requests priced and filled at the next clean epoch strike, pro rata against
  `free_balance` at that moment (Spec 01 §3.5, §4.3). An LP can always take out the unreserved
  share of the vault — LP shares are fungible claims on the whole vault, not on specific dollars —
  so this is a vault-level check, not a per-LP one, and no pause or breaker ever blocks the request.
- Solana account-locking serializes writes to the same `Vault` account within a slot, so there is no
  TOCTOU window between reading `free_balance` and writing the updated `total_reserved_liability` —
  two `open_ticket` instructions touching the same `Vault` account cannot execute concurrently against
  a stale read; the runtime orders them. The invariant is therefore exact, not eventually-consistent.

### 1.3 Instruction → counter effects

| Instruction | Permission | Effects |
|---|---|---|
| first `open_ticket` of an integrator | the integrator's signature | creates `Integrator` at `["integrator", authority]` with the share destination passed in that call (§4.4); there is no registration instruction and nothing to deposit |
| `request_deposit` / `request_withdraw` | permissionless / LP | queue a request in the epoch that is filling and prepay `CLAIM_FEE`, plus `STRIKE_FEE` while the strike fund is below target; nothing touches `vault_balance` yet (Spec 01 §3.3, Spec 08 §6) |
| `strike_epoch` | **permissionless**, paid a flat `STRIKE_REWARD` from the strike fund, only once the epoch's close has passed and every ticket opened before it is closed (Spec 01 §3.5, Spec 08 §4) | prices the epoch; `vault_balance += deposits − withdrawals filled`, withdrawals filled pro rata against `free_balance` |
| `claim_deposit` / `claim_withdraw` | permissionless, paid the request's `CLAIM_FEE` | moves one struck request's shares or USDC to its owner at the recorded price; no effect on `vault_balance` |
| `open_ticket` | the integrator's signature (a program over CPI, or a server or wallet directly) | validates payout table EV, computes `liability = payout_max − vault_credit`, checks the per-ticket cap (§2.4/§6.4) against `free_balance`, the integrator ceiling (§4) and the breakers (§7), pays the shares out of the price, escrows the rest (`vault_balance += vault_credit`, `open_vault_credits += vault_credit`), reserves (`total_reserved_liability +=`, `integrator.reserved_liability +=`), takes `CRANK_FEE` in prepaid SOL (§3), adds the price to `integrator.volume_total` |
| `settle_ticket` | **permissionless** (anyone, once the oracle result is fulfilled; **no deadline**, Spec 02 §2.1) | pays out (`vault_balance −= payout`), releases (`total_reserved_liability −=`, `integrator.reserved_liability −=`, `open_vault_credits −= vault_credit`), pays the settler's 200,000-lamport share of `CRANK_FEE` to caller; always succeeds — a payout that cannot land is parked for `claim_payout` (Spec 07 §6) |
| `expire_ticket` | **permissionless**, only past `T_SETTLE` and only if the randomness never arrived (§3, Spec 02 §2) | **forfeits** the escrowed credit to the vault (identical cost to an honest loss — the price is not returned), releases the reservation and the open credit, pays the settler's 200,000-lamport share of `CRANK_FEE` to caller |

---

## 2. A per-ticket cap that leverage cannot defeat

### 2.1 Why a flat-bps notional cap cannot be leverage-proof, however it is derived

Reproducing a measured example (vault = 175,000,
`max_payout_bps` = 1000, payout table `max(m)` = 1000×):

```
single-ticket liability cap   = 17,500.00
price needed to hit cap @m=1000x = 17.52
margin cost of that one ticket  = 0.2628
tickets to freeze whole vault  = 10.0
total price to freeze vault   = 175.18
total margin cost to freeze vault = 2.63
leverage (frozen/price)      = 999x
```

Now shrink the cap — flat, Kelly-derived, whatever — and recompute the ratio of frozen dollars to
attacker cost:

```
cap_bps=1000.00  cap/cost=66600.0
cap_bps= 500.00  cap/cost=66600.0
cap_bps= 100.00  cap/cost=66600.0
cap_bps=  37.50  cap/cost=66600.0
```

The ratio is exactly `(m−1)/margin`, independent of the cap level. **Any pure notional cap on
liability — however it's computed — shrinks the frozen amount and the attacker's cost by the same
factor.** It moves the dollar scale of the exploit, not its existence. This rules out "a cap on
liability as a fraction of the free vault" as a *complete* answer to hole (a), no matter how that
fraction is chosen (§6 still needs a fraction — for solvency sizing, not for anti-griefing).

### 2.2 What does change the ratio: bound the multiplier

`(m−1)/margin` is linear in `m`. A hard ceiling on `max(m_i)` is the only per-ticket-cap-shaped lever
that changes the *exploitability* ratio, because it acts on the denominator's structural driver
directly rather than rescaling both sides:

```
m_ceiling=1000  cost_to_freeze_vault=$2.63
m_ceiling= 200  cost_to_freeze_vault=$13.19
m_ceiling= 100  cost_to_freeze_vault=$26.52
m_ceiling=  50  cost_to_freeze_vault=$53.57
m_ceiling=  20  cost_to_freeze_vault=$138.16
m_ceiling=  10  cost_to_freeze_vault=$291.67
```

Even at `m_ceiling = 10` the cost to freeze a $175k vault is $292 — trivial next to the value frozen.
**A multiplier ceiling alone is not sufficient either.** It raises the cost linearly; griefing needs
the cost to scale with the *value frozen × how long it stays frozen*, which no per-ticket notional
constant can do (see §3).

### 2.3 Evaluating the four alternatives named in the brief

| Alternative | Verdict |
|---|---|
| Liability as fraction of free vault | Necessary for solvency sizing (§6), but proven above to leave the cost/frozen ratio unchanged — not a griefing defense by itself. |
| Additional cap on `max(m_i)` | Raises the *dollar* cost of griefing linearly, and independently bounds tail variance per ticket (fat-tail control, hole d). Keep it, but don't rely on it alone. |
| Cap on liability-per-unit-of-margin-paid | This is the *right shape* — see the Kelly result below, which gives it a principled constant instead of an arbitrary one. It still doesn't touch the cost/frozen ratio (§2.1 already shows scaling by margin doesn't help there) — its job is solvency sizing, not anti-griefing. |
| Cap scaled by an integrator deposit | Aims at a *different* hole (permissionless-registration multiplication, hole b), which §4–§5 show the vault-wide limits already close; it doesn't touch the leverage-cheapness ratio for a single well-funded integrator either. |

**Conclusion:** no per-ticket notional cap — flat, margin-priced, or deposit-scaled — defeats leverage
griefing, because the attacker's cost under a notional cap alone is a one-shot payment (`price ×
margin`) while the damage (frozen LP capital) is a *duration*. The two are dimensionally different
(dollars vs. dollar-time). Closing that gap requires pricing *something other than the notional
size* — §3 shows this is done in Fade's design not by a time-proportional rent but by the
settlement layer's mandatory per-transaction `CRANK_FEE`, which taxes the number
of chain-touches a sustained freeze requires rather than the dollar size of any one reservation.
The per-ticket cap's real job, established with numbers in §6, is bounding solvency variance, not
stopping griefing — griefing is §3's problem, and it turns out to already be solved one layer down,
in the settlement design.

### 2.4 Recommended per-ticket formula

Combining the pieces (constants justified in §4, §6):

```
reserved_liability = payout_max − vault_credit ≤ min(
    KELLY_FRACTION × vault_margin_bps/10_000 × free_balance,         [solvency, §6.3: KELLY_FRACTION = 0.5; vault_margin = declared margin net of shares, TS §3.7]
    CENSORSHIP_BOUND_BPS/10_000 × vault_balance                    [censorship bound, §6.4: 150bps, reconciled with Spec 02's "1-2% of TVL"]
)
AND integrator.reserved_liability + reserved_liability ≤
    WHALE_BPS/10_000 × vault_balance                               [concentration ceiling, §4.1: 20 %]
AND max(m_i) ≤ M_CEILING                                          [fixed at 10,000× for V1, §3.3]
```

The integrator ceiling is not a third term of the per-ticket cap but an aggregate limit on everything
one integrator has open, which also bounds any single ticket when nothing else is open.

`M_CEILING` is fixed at **10,000×**, not the tighter value §2.2's griefing-cost metric alone would
suggest: the per-ticket liability cap already does the solvency work a second ceiling would
duplicate, `M_CEILING`'s anti-griefing role is now carried by `CRANK_FEE` (§3), and the
correlated-adversarial grid (§7.2) is non-monotonic in `M_CEILING` — tightening it from 1000 to 100
*worsens* drawdown in 5 of 8 cells. A fixed 100× would also hardcode today's vault size into the
protocol permanently; this value should be revisited if the correlated-adversarial scenario is
re-run with the final cap formula.

The first two terms bound two *independent* failure modes with the same shape (a fraction of vault
value) but different denominators: the Kelly term is checked against `free_balance` (shrinks as
utilization rises, closing the aggregation hole in §1.2) and answers "how much LP variance is this
worth"; the censorship term is checked against `vault_balance`/TVL (constant regardless of
utilization) and answers "how much can a single bribed oracle extract, independent of how likely
the outcome was" (§6.4) — a question Kelly/solvency reasoning doesn't address at all. At the
150bps margin floor, half-Kelly (75bps of free_balance) is already tighter than the 150bps censorship
ceiling whenever `free_balance ≤ 2×vault_balance` (always true), so the Kelly term binds by default;
the censorship ceiling only becomes the binding constraint for integrators declaring a materially
higher margin, which is exactly when it should — Kelly would otherwise let their cap scale up
without limit, but a bribed oracle's extractable value per event doesn't shrink just because the
payout table claims a bigger margin.

---

### 2.5 Capacity against assets: what the formula does as the vault grows

Everything in §2.4 is a ratio of live state, so growth changes dollar values and nothing else (Technical Specification §3.8). Regenerated by `fade_ref.py` for a 25 USDC ticket on the demo slot (declared margin 3.50 %, app share 50 bps, vault margin 280 bps) and an idle vault:

| Assets | Per-ticket cap | Integrator ceiling | Largest multiplier | Max-sized tickets open at once | Headroom before the 70 % breaker | Headroom before the 15 % breaker |
|---:|---:|---:|---:|---:|---:|---:|
| 5 000 | 70 | 1 000 | 3.79× | 14 | 3 500 | 750 |
| 50 000 | 700 | 10 000 | 28.99× | 14 | 35 000 | 7 500 |
| 250 000 | 3 500 | 50 000 | 140.99× | 14 | 175 000 | 37 500 |
| 1 000 000 | 14 000 | 200 000 | 560.99× | 14 | 700 000 | 150 000 |

Three things the table settles:

- **The integrator ceiling is a constant share of the vault**: 20 % of assets, 1 000 USDC on the founding vault and 200 000 on a 1 M vault, with nothing deposited to obtain it (§4).
- **Vault growth buys a bigger single ticket at the same concurrency.** The per-ticket cap and the ceiling are both shares of assets, so an integrator holds 14 max-sized tickets at once at every size. More concurrency for one integrator would mean a larger share of the vault, which is what the ceiling exists to refuse; progressive credit (§4.3) is how capacity will be rationed among integrators once 20 % of the vault is worth protecting.
- **The breakers scale by construction**: their headroom in dollars is 70 % and 15 % of assets, whatever the assets. No threshold needs re-tuning as the vault grows.

The mirror image, the vault a given multiplier requires: 1 000× on 25 USDC needs about 1.78 M USDC of assets; on a 7.5 USDC ticket, about 535 k.

---

## 3. Pricing the reservation over time

A continuous, utilization-priced rent (Aave/Compound-style) on reserved liability is not part of
V1. [Spec 02](02-randomness-and-settlement.md) specifies the settlement layer for the ticket lifecycle — `T_SETTLE = 150 slots`
(~52.5s @ 350ms/slot), timing out to **forfeiture, not refund**, plus a prepaid `CRANK_FEE =
250,000 lamports` (~$0.045 @ $180/SOL) paid at `open_ticket` to whoever settles or expires the
ticket. §3.1 shows this mechanism defeats sustained reservation-griefing (hole (a)) more
effectively than a continuous rent would, and at lower design cost ;
§3.2 is the verdict that no additional rent is needed on top of it; §3.3 states the
forfeiture-on-timeout rule and its reasoning.

### 3.1 Recomputed economics of the reservation-freeze attack

Two things change the original §2.1 arithmetic (`10 tickets × 10% = 100%`, cost ≈ $2.63), both
already present in this document but not yet combined with a *settlement* cost:

1. **The free-balance cap (§1.2) makes "freeze the vault" geometric, not linear.** `10 tickets × 10%
   = 100%` is only valid against a cap computed on a *fixed* base. Checked against `free_balance`,
   which shrinks after every admitted ticket, reaching a given utilization takes more steps, and
   100% is asymptotically unreachable in finitely many max-sized tickets. Reaching 95% utilization
   of a $250,000 vault takes **29** sequential max-sized tickets at the team's original 1000bps cap,
   and **398** at the recommended half-Kelly 75bps cap — the tighter
   cap raises the *step count*, not just shrinks the dollar scale as §2.1 showed for a flat cap.
2. **Every one of those tickets now carries a `CRANK_FEE`, and *sustaining* a freeze (not just
   ramping to it once) means repeatedly reopening every slot as it expires or settles.** The
   realistic reopen cadence is the design's own "happy path" oracle latency (~5 slots, 1.75s) —
   not the 52.5s worst case — because a rational attacker prefers fast, cheap honest settlement
   (`price × margin` in expectation) to slow forfeiture (`price`, the *full* amount: [Spec 02](02-randomness-and-settlement.md)
   §2.2's own proof that forfeiture costs exactly what an honest loss costs, i.e., strictly more
   than the expected cost of just letting it settle quickly).

```
CRANK_FEE = 250,000 lamports = $0.0450 @ $180/SOL
T_SETTLE = 150 slots = 52.5s ;  fast happy-path cycle ≈ 1.75s (5 slots)
```

**Phase 1 — one-time ramp to 95% utilization, $250,000 vault:**

```
cap=1000.0bps (team baseline 10%)             m_ceil=1000  steps= 29  ramp_time≈ 50.8s   ramp_cost=$4.93
cap=  75.0bps (recommended half-Kelly 0.75%)  m_ceil=1000  steps=398  ramp_time≈696.5s   ramp_cost=$22.19
```

Still cheap — which is exactly why the *maximum single-shot* freeze duration needs to be bounded
structurally (§3.3's `T_SETTLE`), not left to cost alone.

**Phase 2 — sustaining that utilization for 30 days, each slot refreshed on a `T_cycle` cadence:**

```
cap=1000.0bps  cycle=fast honest settlement (1.75s)   30 days  n_slots= 29  TOTAL_COST=$7,292,060
cap=1000.0bps  cycle=worst-case timeout/forfeit (52.5s) 30 days n_slots= 29  TOTAL_COST=$  243,069
cap=  75.0bps  cycle=fast honest settlement (1.75s)   30 days  n_slots=398  TOTAL_COST=$32,870,213
cap=  75.0bps  cycle=worst-case timeout/forfeit (52.5s) 30 days n_slots=398 TOTAL_COST=$1,095,674
```

Every combination costs **more than the entire vault** over 30 days, including the slowest,
cheapest-looking cycle time at the *original* 10% cap. For comparison, the rent-only estimate for
holding the same vault frozen the same 30 days was **$86,137**. **The settlement layer's mandatory per-transaction fee, multiplied by the slot
count the cap already forces, is 3×–380× more punishing than a continuous rent on top of it would
be.**

Why does a *flat* fee beat a *scaled* rent here? Because the attack's real cost driver is not the
dollar size of any one reservation — it's the number of times the attacker must touch the chain to
keep the freeze alive. A flat per-touch fee taxes that directly. A %-of-liability rent doesn't, and
is in fact weakest exactly where this attack is strongest: recall from §2.1 that leverage lets a
tiny price hold a large liability, so a liability-proportional rent is cheap precisely on the
highly-leveraged, tiny-price tickets a griefer uses; a per-transaction fee doesn't care how the
liability was leveraged at all.

### 3.2 Verdict: is a continuous rent still needed on top? No.

Given the free-balance cap (§1) and `T_SETTLE`/`CRANK_FEE` (adopted from [Spec 02](02-randomness-and-settlement.md)),
sustained reservation-freeze griefing is uneconomic by one to two orders of magnitude at every
parameter combination tested, and the *maximum single-shot* freeze duration is bounded to
`T_SETTLE` (52.5s) **structurally**, independent of economics — closing "the freeze can be
permanent" without rent's help. Adding a continuously-accruing utilization rent on top would
reintroduce a real cost for no remaining anti-griefing benefit: at realistic settlement latencies
it would charge 200–480% of an *honestly*-delayed ticket's margin revenue (honest-ticket-fee
sensitivity). **Not part of V1.**

What the rent would have done is covered elsewhere instead:

- The **utilization-based hard admission gate** (§7.3: `U ≥ 70%` pauses new `open_ticket`
  vault-wide) defends a *different* case, many honest actors simultaneously spiking utilization
  faster than a per-transaction fee discourages any one of them (§7), not repeated single-actor
  griefing.
- Hole (b), permissionless registration, is closed by the limits every identity shares (§4.2, §5), which `CRANK_FEE`/`T_SETTLE` say nothing about.
- Keeper settlement is funded by `CRANK_FEE`, prepaid in SOL at `open_ticket` rather than funded
  from margin revenue at settlement: the reward is then sized in the currency the cranker actually
  spends, with no conversion and no dependence on the vault's own result.

### 3.3 Forfeiture, not refund

Timeouts forfeit the ticket price to the vault; they never return it (`expire_ticket`, §1.3). Returning it
would make withholding the randomness a free option: a player who can induce non-settlement
(colluding with the oracle, or simply hoping nobody cranks a losing draw) could decline every draw
that isn't a win and get the price back on timeout, trying again for free. Under forfeiture — the price
moves to the vault exactly as an honest loss would — that option is worth exactly zero: every path
through the state machine costs the player `price` with the same probabilities an honest draw
would produce, so a colluding player-and-oracle pair nets zero.

This does not bound a bribe to suppress a genuine *win*; that is bounded structurally by the
per-ticket cap, not by incentives. The residual worry — does forfeiture unfairly confiscate an
honestly-delayed player during a genuine oracle outage? — is real in the abstract, and is
addressed at the *provider-selection* layer, not the fee-parameter layer: a push-style oracle, a
`T_SETTLE` margin sized ~30× the happy-path reference latency, and a separate 60-slot
*operational* alarm that pauses new admissions well before any in-flight ticket reaches forfeiture.
Honest players are protected by that alarm firing early, not by a grace window on the timeout rule
itself.

---

## 4. The integrator ceiling, and why there is no bond

### 4.1 The ceiling

An integrator's open liability, the new ticket included, never exceeds `WHALE_BPS = 20 %` of
`vault_balance`. It is the only per-integrator limit, and nothing is deposited to obtain it. Its job
is concentration: one integrator — honest and popular, or broken — never has more than a fifth of
the vault at risk at once, however many tickets it opens. With the demo slot's per-ticket cap at 1.4 %
of an idle vault, that is 14 max-sized tickets at any vault size (§2.5).

### 4.2 Why there is no bond

Registration is permissionless, so a per-identity limit that costs nothing to acquire can be
multiplied by creating identities (hole b). The textbook answer is a bond: capacity priced in locked
capital. Fade does not ask for one, for three reasons.

1. **It would absorb nothing.** No on-chain predicate can attribute a fault to an integrator, and
   every violation the program can detect — a bad payout table, an oversized ticket, a breached ceiling —
   is refused at open, so there is nothing to punish afterwards. A refundable deposit that can never
   be slashed only rations capacity. First-loss capital in the Hyperliquid-insurance-fund or
   Aave-Safety-Module pattern needs exactly the predicate V1 lacks.
2. **It would change nothing where Fade operates.** Beside the 20 % term, a bond term `bond × 5`
   binds only above `25 × bond` of assets — 50 000 USDC for a 2 000 USDC bond. Below that it is
   friction with no effect on any limit, and the founding vault is 5 000.
3. **The limits that protect the vault are shared.** The per-ticket cap on the free balance, the 70 %
   utilisation gate, κ and the drawdown breaker apply to the aggregate: every identity draws on the
   same free balance and trips the same breakers, so creating identities multiplies none of them
   (§5). What remains is occupying capacity, and capacity is held only by opening real tickets, each
   of which pays the margin and `CRANK_FEE`. Holding 1 000 USDC of the 5 000 founding vault
   reserved around the clock with the demo slot's payout table on the cheapest tickets, at the
   7.5 USDC minimum, with the per-ticket SOL overhead once SIMD-0437 is fully active
   (computed):

| Ticket life | Tickets a day | Attacker's cost a day (USD) | Kept by the vault (USDC) |
| ---: | ---: | ---: | ---: |
| 10 s | 459 513 | 172 149 | 96 498 |
| 30 s | 153 171 | 57 383 | 32 166 |
| 52 s (`T_SETTLE`) | 88 368 | 33 106 | 18 557 |

Stalling instead — opening tickets and never requesting randomness — forfeits every ticket price at
`T_SETTLE`: 662 760 USDC a day to the vault. An attacker who wants the vault frozen pays its LPs for
the privilege.

What a bond would have bought, and V1 does without: a newcomer on a large vault can hold 20 % of it
from its first ticket — 1 000 USDC on the founding vault, 200 000 on a 1 M vault. §4.3 closes that
before it matters.

### 4.3 Progressive credit — specified, not enabled

Every integrator record carries `volume_total`, the cumulative ticket price it has opened, from its first
ticket. The rule it exists for:

```
integrator ceiling = min( WHALE_BPS × vault_balance,  CREDIT_BASE + CREDIT_RATE × volume_total )
```

A new integrator starts with a small capacity and earns the rest by bringing real volume, which
pays the margin: capacity is priced in revenue the LPs receive, rather than in capital that sits
idle. `CREDIT_BASE` and `CREDIT_RATE` are set from observed volume when the rule is switched on,
before the vault passes about 50 000 USDC — where 20 % of it becomes a sum worth keeping from an
unproven integrator. Switching it on is a tightening change (Spec 05 §3). V1 ships the counter only,
so enabling the rule needs no account migration.

### 4.4 The integrator record

Created by the integrator's first `open_ticket`, at `["integrator", authority]`, where `authority`
is the signer: a program's `["fade-integrator"]` PDA or a server's or wallet's key (Spec 07 §1–§2).
It holds the share destination, fixed at creation and changed only with the authority's signature;
the integrator's open liability and open-ticket count; the next ticket nonce; and `volume_total`.
There is no registration step, nothing to deposit and nothing to withdraw. The record is never
closed: its rent is a few thousandths of a SOL, and a closable record could be re-created with its
nonce and counters reset — the revival class Spec 07 §4 forbids.

---

## 5. Rate limiting under permissionless registration

### 5.1 Why per-identity quotas don't work here, and shared-state pricing does

A quota like "N tickets/minute per integrator" is exactly proportional to how many integrators an
attacker registers — trivially multiplied by hole (b). Two mechanisms in this design price
congestion against **shared, non-partitionable state** instead: the utilization admission gate
(§7, `U ≥ 70%`, checked against the same global `total_reserved_liability` every integrator draws
from) and the settlement layer's `CRANK_FEE` (§3, charged per transaction regardless of which
identity submitted it). Neither can be diluted by registering more identities: splitting one
attacker into ten registered integrators does not create ten separate utilization budgets or ten
separate discounts on the per-transaction fee — they all draw from and pay into the same ones.

### 5.2 Layered limits

| Layer | Mechanism | Defeats |
|---|---|---|
| Global | hard admission pause at U ≥ 70% (§7) + per-transaction `CRANK_FEE` (§3) | Sybil multiplication of throughput — gated/priced on shared state, not per-identity state |
| Per-ticket | Kelly/censorship-bound liability cap × multiplier ceiling (§2.4, §6.4) | single-ticket leverage abuse |
| Per-integrator | 20 % of `vault_balance` on the integrator's open liability (§4.1); progressive credit once enabled (§4.3) | one *honest* integrator concentrating the vault's capacity — not multiplied identities, which the global layer handles (§5.3) |

### 5.3 What a Sybil attacker still achieves

Splitting into N identities gives N integrator ceilings of 20 % each, and nothing else: all N draw
on the same free balance, face the same 70 % utilisation gate, the same κ and the same drawdown
breaker, and every ticket any of them opens pays the margin and `CRANK_FEE`. The per-integrator
ceiling is therefore a concentration rule for honest integrators, not a Sybil defence; the Sybil
defence is that capacity is held only by opening real tickets, at the cost in §4.2. Once progressive
credit is enabled (§4.3), a fresh identity starts at `CREDIT_BASE`, so splitting multiplies only that
small base. The same holds for the guardian's targeted pause: it binds one record, so a party that
enrolled several keys keeps admitting tickets through the ones not yet paused, and the control that
needs no knowledge of its records is the global pause ([Spec 05](05-governance.md) §5c).

The honest limit: a well-capitalised actor, openly one integrator or disguised as many, can reserve
up to the 70 % gate for as long as it keeps paying for it. The utilisation gate, κ and the drawdown
breaker (§7) bound what that does to LPs, and most of what it pays goes to them.

---

## 6. Solvency model — Monte Carlo, and the cap actually recommended

### 6.1 Model

Event-driven simulation: tickets arrive as a Poisson process; each is priced
exactly at the payout table's EV boundary `p·m = 1 − margin` (the worst case the on-chain check allows for
a given `m` — conservative, since honest payout tables typically leave the boundary the on-chain check
merely permits); ticket price is drawn from a lognormal (median $20 in this run, below the protocol's 7.5 USDC minimum ticket price; fat tail up to the $10,000 table max —
most game-of-chance volume is small, large tickets are rare); each ticket is admitted only if it fits under
`cap_frac × free_balance` and `max(m) ≤ mult_ceiling`; settlement happens after a random delay
(2–15s for on-chain-RNG archetypes, 20–120s plus a 0.5%-probability multi-hour oracle-outage tail for
oracle-price archetypes). Archetype mix for the "realistic" runs: 70% low-variance (`m∈{1.5,2,3,5}`),
25% medium-variance (crash-like, Pareto-tailed `m` up to 50×), 5% adversarial (always requests
`mult_ceiling`). We track the vault balance path over a 30-day horizon and report drawdown from the
starting balance.

### 6.2 Results — replacing `max_payout_bps = 1000`

(Grid run: 150 Monte Carlo trials per configuration, seeds fixed for reproducibility; λ=150
tickets/hour aggregate unless noted, ≈150k–170k monthly tickets, monthly ticket volume/vault ratio
≈7×–70× depending on vault size — a deliberately busy, early-platform assumption.)

| Vault | Cap (bps of free) | `M_CEILING` | P(dd≥10%) | P(dd≥20%) | P(dd≥50%) | mean dd | p95 dd | max dd | E[monthly ret] |
|---|---|---|---|---|---|---|---|---|---|
| $100k | 1000 (baseline) | 1000 | 68.0% | 48.7% | 13.3% | 24.4% | 67.6% | 100.0% | 106.2% |
| $100k | 1000 (baseline) | 100 | 68.0% | 50.0% | 16.7% | 25.4% | 66.7% | 100.0% | 109.6% |
| $100k | 150 (full Kelly) | 1000 | 44.7% | 18.0% | 0.0% | 11.9% | 33.1% | 49.1% | 92.8% |
| $100k | 150 (full Kelly) | 100 | 46.7% | 18.0% | 1.3% | 12.3% | 34.5% | 51.9% | 94.6% |
| $250k | 1000 (baseline) | 1000 | 51.3% | 21.3% | 3.3% | 13.8% | 43.9% | 71.5% | 43.5% |
| $250k | 1000 (baseline) | 100 | 53.3% | 24.7% | 3.3% | 14.1% | 39.8% | 72.5% | 46.0% |
| $250k | 150 (full Kelly) | 1000 | 24.7% | 8.7% | 0.0% | 7.0% | 21.8% | 34.0% | 39.3% |
| $250k | 150 (full Kelly) | 100 | 26.0% | 5.3% | 0.0% | 7.2% | 20.9% | 32.3% | 40.6% |
| $250k | **75 (half-Kelly, recommended)** | 1000 | **14.7%** | **2.0%** | **0.0%** | **5.3%** | **16.1%** | **23.5%** | 37.4% |
| $250k | **75 (half-Kelly, recommended)** | 100 | **16.7%** | **1.3%** | **0.0%** | **5.4%** | **16.5%** | **24.9%** | 38.2% |
| $1M | 1000 (baseline) | 1000 | 20.7% | 9.3% | 0.0% | 6.4% | 23.7% | 33.2% | 11.7% |
| $1M | 1000 (baseline) | 100 | 14.7% | 2.0% | 0.0% | 4.6% | 14.8% | 22.4% | 12.6% |
| $1M | 150 (full Kelly) | 1000 | 3.3% | 0.0% | 0.0% | 2.9% | 8.9% | 17.0% | 10.6% |
| $1M | 150 (full Kelly) | 100 | 4.7% | 0.0% | 0.0% | 3.0% | 8.7% | 16.6% | 11.2% |

(150 trial-paths per row above, λ=150 tickets/hr; a λ=500/hr stress pass at vault=$250k shows the
same ordering, worse in absolute terms — e.g. at the baseline 1000bps/m=1000, P(dd≥20%) rises from
21.3% to 33.3% and P(dd≥50%) from 3.3% to 4.7%, while at 150bps it rises only from 8.7% to 8.7%
(unchanged) — i.e. the tighter cap is also more robust to a concurrency spike, not just to the
baseline load; full grid in the Appendix.)

### 6.3 Is 10% too high for a shared, permissionless vault? Yes.

The Kelly derivation makes this precise, not just empirical. Model the
vault's single-ticket capital dynamics as a two-outcome draw: capital × `(1 + x/(m−1))` on a vault
win (probability `1−p`), capital × `(1−x)` on a vault loss (probability `p`), where `x = liability /
free_balance` is exactly the cap fraction this spec is choosing. Maximizing expected log-growth gives
a closed form, verified numerically for `m` from 2× to 1000×:

```
x* = 1 − p·m
```

At the payout table's own EV boundary (`p·m = 1 − margin`), this collapses to **`x* = margin`**, independent
of `m`:

```
m=   2.0  x*=0.015000
m=  10.0  x*=0.015000
m= 100.0  x*=0.015000
m=1000.0  x*=0.015000
```

**Modelling basis.** `margin` above, and everywhere below in this section, §6.4 and §7, is the
payout table's own declared `margin_bps` — the boundary the on-chain EV check enforces. The protocol's
actual cap formula (§2.4) is computed on `vault_margin`, the margin net of the integrator and
protocol shares, which is strictly smaller than the declared margin whenever either share is non-zero.
So every Kelly fraction, drawdown probability and cap figure derived below is the *optimistic* end
of the range — the protocol's own caps, evaluated on `vault_margin`, bind tighter than what's shown
here.

Full Kelly on a 150bps-margin payout table is **150bps (1.5%)** of free vault — the team's `max_payout_bps
= 1000` (10%) is **6.67× full Kelly**. Full Kelly itself is known to be too aggressive for any
real risk manager (it assumes the margin estimate is exact and stationary, which a permissionless,
adversarially-submitted payout table is neither); the universal practitioner adjustment is fractional
Kelly, 1/4 to 1/2. The Monte Carlo grid in §6.2 is the empirical confirmation: `cap_frac = 1000bps`
carries materially higher `P(drawdown ≥ 20%)` and worse worst-case drawdowns than `cap_frac =
150bps` at every vault size tested, for comparable expected return — i.e., it is not compensated risk,
it is uncompensated variance, exactly what an over-levered Kelly fraction predicts.

**Recommendation: `KELLY_FRACTION = 0.5` (half-Kelly), giving a per-ticket cap of `0.5 × margin_bps(payout table)
/ 10_000 × free_balance`** — 75bps (0.75%) of free vault for a payout table priced at the 150bps floor,
scaling up for integrators who set (and therefore pay) a higher declared margin. This is 13.3× smaller
than the inherited 1000bps figure.

### 6.4 Reconciling with the independent "1–2% of TVL" recommendation

[Spec 02](02-randomness-and-settlement.md) independently arrives at `max_liability ≤ 1–2% of current vault TVL` per ticket,
from a completely different threat model: a bribed or censoring oracle can suppress a ticket that
would have been a big win, converting it into a forfeiture the player never earned, and — critically
— **statistical monitoring cannot catch this for the rare, high-payout outcomes where it is most
attractive** (their §7: at `p_i = 1e-6`, ~2,000,000 draws are needed before even 20 occurrences are
*expected*, let alone enough to distinguish "suppressed" from "unlucky" with any power). Their cap
is the only real defense for that specific failure mode, since it bounds worst-case extraction
regardless of detectability.

**Do the two analyses agree? Yes, and the agreement is closer than either of us stated
independently.** Full Kelly on the 150bps margin floor works out to exactly **150bps** — inside their
1–2% band, at its low end. My own solvency-driven recommendation (half-Kelly, 75bps) sits *below*
their floor, i.e., it already satisfies their censorship-bounding requirement with room to spare for
a standard-margin payout table. The Monte Carlo in §6.2 also independently confirms their band is a large
improvement over the inherited 10%: at vault=$100k, `P(dd≥20%)` drops from 48.7–50.0% at 1000bps to
18.0% at 150bps (the low end of their band) to 1.3–2.0% at my tighter 75bps.

**Where they diverge, and which should dominate:** my Kelly term is expressed as a fraction of
`free_balance` and scales *up* with a payout table's own declared `margin_bps` — deliberately, since a
higher-margin game is safer for LPs per dollar reserved. Their term is a flat fraction of `vault_balance`
(TVL) and does **not** scale with declared margin — also deliberately, since a bribed oracle's
extractable value from suppressing one rare outcome doesn't shrink just because the payout table claims a
bigger margin; the censorship exposure is about the *absolute* payout size, not the EV that justified
admitting it. These are genuinely different risks on the same dial, so neither should categorically
override the other — the correct combination is the `min()` already given in §2.4:
`min(0.5 × vault_margin/10_000 × free_balance, 150bps × vault_balance)`, with the integrator ceiling alongside. For a standard
150bps-margin payout table my term is already tighter and binds first (§2.4's arithmetic: half-Kelly < the
flat 150bps ceiling whenever `free_balance ≤ 2×vault_balance`, always true) — solvency dominates in
the common case. For a payout table declaring a materially higher margin, my term would otherwise scale up
without limit; the flat ceiling takes over and dominates instead — censorship-bounding wins there,
correctly, since that risk doesn't care what margin was declared. **Recommend `CENSORSHIP_BOUND_BPS =
150`** (their band's low end, chosen because it happens to equal my own independently-derived full-Kelly
number — a genuine convergence, not a coincidence of rounding) rather than their upper bound of 200,
since §6.2's grid shows even 150bps still carries a non-trivial `P(dd≥20%)` (5.3–24.7% depending on
vault size) at `margin_bps=150` — no reason to spend headroom the solvency model says isn't free, when
the two recommendations already agree at the tighter end of their range. Their secondary control —
cross-attestation from a second, independently-operated oracle above 20bps of TVL — is not in V1:
Switchboard is not integrated, and enforcing that threshold as a hard cap would refuse every demo
game on a 25k vault. The residual it would have addressed (a bribed or censoring oracle suppressing
a rare, high-payout win — a failure statistical monitoring cannot catch, since the rare outcomes
where it is most attractive don't generate enough draws to distinguish "suppressed" from "unlucky")
is a documented V1 limitation, to revisit alongside the Ed25519-precompile hardening.

---

## 7. Correlated exposure and the aggregate circuit breaker

### 7.1 Two distinct correlation mechanisms

- **Simultaneous independent tickets on similar high-variance games.** Many integrators each running
  their own instance of a fat-tailed game, uncorrelated in outcome but correlated in *timing* — if
  they all size up during the same demand spike, `total_reserved_liability` can spike faster than
  any single integrator's cap would suggest, purely from concurrency. This is what the "adversarial
  archetype" runs in the grid below stress-test (all integrators behaving like the worst-case
  payout table simultaneously).
- **Shared-outcome games — genuinely correlated, not just concurrent.** A crash-style game where many
  players' tickets resolve off *one shared round* is a single random draw, not N independent ones. If
  each participating ticket is capped independently, the cap is meaningless: 1,000 participants each
  admitted at "10% of free vault" for the *same* round aggregate to far more than 10% *of that one
  outcome*. **Requirement for the day such games exist** (V1 has no shared seed and no callback, so no
  shared-outcome game can be built on it; this binds shared-outcome games, still roadmap, Technical
  Specification §1): any set of tickets that share a random seed, price tick, or settlement event
  must register a `CorrelationGroup` account, and the cap in §2.4/§6.4 is checked against the
  group's *total* potential liability across all participants, not per participating ticket. Any design that batches many tickets into one draw meets the same
  trade-off: the amortization that makes batching cheap is the exact same `N` that multiplies the blast
  radius of a single failure or censorship event — **a round cannot be both "cheap because
  batched" and "safe because capped like a single ticket" at the same time**; capping the round's
  aggregate liability at the same bound a single ticket gets necessarily caps how many tickets (or how
  much liability) a round can batch, eroding the cost-amortization the batching was for. This is a
  precise, load-bearing requirement for any integrator building a pooled/shared-round game on top of
  Fade — get it wrong and the per-ticket cap silently stops meaning anything for that game.

### 7.2 Correlated-exposure stress results

(All integrators run the adversarial archetype — every ticket requests `mult_ceiling`, sized to the
cap. This models N independently-registered integrators simultaneously running the same
high-variance game design, i.e., hole (a)'s scenario generalized across many concurrent
integrators rather than one attacker.)

The full 12-row grid (vaults of 100 k, 250 k and 1 M; caps of 1000 and 150 bps of the free balance; `M_CEILING` 1000 and 100; `P(dd ≥ 10 %)`, `P(dd ≥ 20 %)`, `P(dd ≥ 50 %)`, mean and max drawdown, expected monthly return) is in [the appendix](04-risk-and-exposure-appendix.md). Two rows carry the argument: at 250 k and the 150 bps cap, `P(dd ≥ 10 %)` is 38.0 % with `M_CEILING = 1000` and 64.7 % with `M_CEILING = 100`; at 1 M and the same cap, 35.3 % against 48.0 %.

Even at the recommended 150bps cap, correlated all-adversarial pressure pushes `P(dd≥10%)` to
35–40% — an order of magnitude worse than the same cap under a realistic archetype mix (§6.2's
3.3–26.0%). This is the quantified case for the hard admission gate below: per-ticket and
per-integrator caps are sized against *independent* variance (§6); they are not, and cannot be,
sized against every integrator behaving like the worst allowed payout table simultaneously — that
needs a global backstop that looks at aggregate state, not per-ticket or per-integrator state.

**A counter-intuitive result worth flagging honestly, not smoothing over:** `M_CEILING=100` is
*worse* than `M_CEILING=1000` in 5 of these 8 comparisons (e.g. $100k/150bps: `P(dd≥20%)` 10.7% at
`m=1000` vs. 47.3% at `m=100`), the opposite of what §2.2 alone would suggest. The mechanism: in
this fully-adversarial archetype every ticket requests exactly `mult_ceiling` and is priced at the
EV boundary `p = (1−margin)/m`, so a *lower* ceiling means a *higher* hit probability for the same
liability-cap-sized payout (`p` scales as `1/m` while the loss-per-hit stays pinned at the cap) —
more frequent, same-size hits cluster into worse drawdowns within a fixed 30-day window more often
than rarer, equally-sized ones do. **`M_CEILING`'s value is in §2.2's dollar-cost-of-griefing
metric, not in solvency variance — don't conflate the two when tuning it.** The vault-size-1M row
partially reverses this (1000 slightly better than 100 at the 1000bps cap only), consistent with
this being a real but second-order effect next to `cap_frac`, and with 150 trials/cell carrying
real Monte Carlo noise on tail probabilities — treat the direction, not the exact percentages, as
the finding.

### 7.3 Recommended circuit breakers

| Breaker | Trigger | Action |
|---|---|---|
| Utilization admission gate | `(total_reserved_liability + open_vault_credits) / vault_balance ≥ 70%` after the ticket | Hard-refuse all new `open_ticket` vault-wide (not just for the integrator that tipped it) until utilization drops — needed because many *honest* actors sizing up simultaneously (§7.2) isn't priced away by `CRANK_FEE` the way single-actor griefing is (§3.2): each of them is paying the fee for a legitimate ticket, not cycling for free. |
| Drawdown breaker | the share price on settled assets, `(total_assets − open_vault_credits + 1) / (total_shares + 10³)`, falls to 85 % or less of its highest hourly value over the last 24 h (Spec 08 §8). The price, not `vault_balance`: deposits and withdrawals leave it unchanged, so an LP exit never looks like a loss; and settled assets, not assets, so that opening tickets does not raise a peak their ordinary settlement then falls from — only results move it | Refuse new admissions vault-wide while the condition holds; it clears when the peak leaves the 24 h window, and the per-ticket cap stays halved for one clean day after that — 48 h after the last settlement that saw the condition. **It never touches withdrawals**: a withdrawal request is queued, priced and filled exactly as in normal operation (Spec 05 §4; Spec 01 §4.3 bounds the wait). |
| Correlation-group cap (roadmap, §7.1) | any `CorrelationGroup`'s aggregate potential liability | Same formula as §2.4/§6.4, applied to the group, not the individual ticket — with shared-outcome games, not at launch. |

---

## 8. Parameter table

| Parameter | Recommended value | Reasoning |
|---|---|---|
| Margin floor | `declared margin ≥ 100 (LP floor) + 20 (protocol) + app share`, i.e. 120 bps at a zero app share (`MarginFloor`) | Technical Specification §3.7. 150 bps stays this document's *reference* margin for the risk model (LP floor + protocol share + a 30 bps app share); an integrator declaring a higher margin raises its own Kelly cap proportionally (§6.3), on the vault's net margin. |
| Per-ticket liability cap | `payout_max − vault_credit ≤ min(0.5 × vault_margin/10_000 × free_balance, 150bps × vault_balance)`, plus the integrator ceiling `20 % × vault_balance` on the integrator's open liability | §2.4, §6.3/§6.4: half-Kelly on the vault's net margin, reconciled with Spec 02's independent "1–2% of TVL" censorship bound — the two converge at 300 bps of vault margin and the half-Kelly term binds below it. Replaces flat `max_payout_bps`; 65 bps of the free balance for a 1.5 % game with no app share, 15× smaller than the inherited 1000bps. |
| Secondary dual-oracle threshold | Not in V1 | §6.4: [Spec 02](02-randomness-and-settlement.md)'s cross-attestation control (a second, independently-operated oracle above 20bps of TVL) is not implemented — Switchboard is not integrated, and the threshold would refuse every demo game on a 25k vault. The residual risk (a bribed/censoring oracle suppressing a rare, high-payout win, undetectable statistically) is a documented V1 limitation. |
| `M_CEILING` (max multiplier, any payout table) | 10,000× | Fixed for V1 (§3.3): the per-ticket liability cap already does the solvency work a tighter ceiling would duplicate, and the correlated-adversarial grid (§7.2) is non-monotonic in `M_CEILING` — tightening from 1000 to 100 worsens drawdown in 5 of 8 cells, so a low fixed ceiling buys no reliable safety margin. `M_CEILING`'s remaining role, raising the dollar cost of griefing (§2.2), is carried by `CRANK_FEE` instead. Note per §7.2: `M_CEILING` moves the griefing-cost metric, not solvency variance, which can move either direction under correlated adversarial pressure — don't conflate the two. |
| Integrator ceiling | 20 % of `vault_balance` on the integrator's open liability | §4.1/§7.3: bounds concentration from any one integrator; the only per-integrator limit, with no deposit behind it (§4.2). |
| Progressive credit | specified, not enabled in V1; `volume_total` recorded from each integrator's first ticket | §4.3: to be switched on, as a tightening, before the vault passes about 50 000 USDC. |
| `T_SETTLE` | 150 slots (~52.5s) | Adopted from [Spec 02](02-randomness-and-settlement.md) §3: ~30× the happy-path oracle latency reference, with margin below the 512-slot SlotHashes ceiling. Bounds the *maximum single-shot* reservation-freeze duration structurally (§3.2), so no separate rent-based ceiling is needed. |
| Timeout resolution | **forfeiture**, not refund (`expire_ticket`) | §2.2's proof (Spec 02): refund-on-timeout gives a colluding player+oracle pair a free option; forfeiture costs exactly what an honest loss costs, so collusion gains nothing (§3.3). |
| `CRANK_FEE` | 250,000 lamports (~$0.045 @ $180/SOL), prepaid in SOL at `open_ticket`; 50,000 to the randomness requester, 200,000 to the settler or expirer | Spec 02 §4: prepaid SOL pays the cranker in the currency it spends. Recomputed in §3.1: this fee, multiplied by the slot count the liability cap already forces, makes sustained reservation-freeze griefing cost 3×–380× more than a continuous utilization-priced rent would — **no separate anti-griefing rent is needed in V1 (§3.2)**. |
| Oracle-outage operational alarm | 60 slots | Adopted from [Spec 02](02-randomness-and-settlement.md) §3: pauses new `open_ticket` vault-wide well before any in-flight ticket reaches the 150-slot forfeiture point, bounding honest-player exposure to a genuine outage without needing a rent-side remedy. |
| Global utilization admission breaker | 70% | §7.3: hard backstop against many *honest* actors spiking utilization simultaneously (§7.2) — a case `CRANK_FEE` doesn't price away, since each such ticket pays the fee for a legitimate reservation, not for free cycling. |
| Drawdown circuit breaker | ≥15% vault drop in rolling 24h | §7.3: vault-wide pause of new tickets + halved caps until a clean window passes; withdrawals untouched. |
| LP withdrawal timing | No per-withdrawal cooldown; the vault is priced by epoch-batched forward pricing, 600 s epochs, at a strike that runs only once every ticket opened before the epoch's close has resolved (Spec 01 §3.5) | Every deposit and withdrawal executes at the next epoch's NAV rather than immediately, and that NAV contains no known-but-unapplied outcome, which closes the NAV-timing window between a ticket's outcome becoming knowable on-chain and `settle_ticket` running — structurally, not through a settlement-derived timer. Withdrawal requests are never paused or throttled. |
| Min / max ticket price | 7.5 USDC / 10,000 USDC | Technical Specification §3.7: the minimum is where the fixed SOL overhead of a ticket equals the 150 bps reference margin. Note per §2.1: this floor does not, by itself, change the leverage-griefing cost ratio — it interacts with `M_CEILING`, not as a substitute for it. |
| `CorrelationGroup` requirement | roadmap — mandatory for any shared-seed/shared-round game design, none of which V1 can host | §7.1: without it, the per-ticket cap is silently meaningless for pooled-outcome games; independently required by Spec 02 §8 for VRF-batched rounds. |

---

## 9. Property tests and invariants for an auditor

Companion to Spec 01 §7; the numbering is this document's own.

1. **Cap formula, exact:** for random `(vault_balance, reserved, open_vault_credits, vault_margin)`, the computed cap equals `min(⌊0.5 · vault_margin · free / 10_000⌋, ⌊150 · vault_balance / 10_000⌋)` in `u128` with no intermediate overflow, and a ticket with `payout_max − vault_credit` one base unit above it is refused while one at it is admitted.
2. **Net margin, never declared margin:** raising the app share at a fixed declared margin never raises the cap; inflating the declared margin with the same share raises it exactly by the Kelly term.
3. **Integrator ceiling:** the sum of an integrator's open liabilities never exceeds 20 % of `vault_balance` after any sequence of opens, settlements and expiries; a ticket that would breach it is refused with the ceiling error, not the cap error.
4. **Integrator record:** the first `open_ticket` signed by a new authority creates its record at `["integrator", authority]` with the share destination it passes; no later call can re-create the record, change its share destination without the authority's signature, reset its nonce, or lower `volume_total`, which grows by exactly each opened ticket's price.
5. **Identity:** a ticket is attributed to the record of the authority that signed it and to no other; no call can open a ticket under, or draw on the ceiling of, a record whose authority did not sign it.
6. **Breakers stop admissions only:** with the utilisation gate or the drawdown breaker tripped, `open_ticket` is refused, while `settle_ticket`, `expire_ticket`, `request_withdraw`, `strike_epoch` and every `claim_*` succeed unchanged; on resumption after a drawdown, caps are halved until a clean 24 h window has passed. A strike that pays out 20 % of `vault_balance` in withdrawals, or mints shares for a deposit of any size, leaves the drawdown breaker untouched.
7. **Gross solvency and κ:** `total_reserved_liability + open_vault_credits ≤ vault_balance` and `total_reserved_liability ≤ 0.8 × vault_balance` after every admission and every strike, never checked at settlement.
8. **Shared limits:** N integrator records opening tickets at once never exceed, together, the 70 % utilisation gate, κ or gross solvency that a single record would face, and each sees a per-ticket cap computed on the same free balance.

Reproduction scripts and data are on [Fade Spec 04 — Risk and Exposure — Appendix](04-risk-and-exposure-appendix.md).
