> [Fade](../README.md) · Technical. Domain document 03 of the [Technical Specification](README.md): owns the payout table representation, the rounding proof, modulo bias, margin snapshotting, the variance gap and the measured compute units. Parameter values are the Technical Specification's §2 table, which wins wherever the two differ.

# Fade Spec 03 — Payout Table Invariant and Arithmetic

Reference parameters used throughout (the same ones as an existing production program the team
measured against): `margin_bps = 150`, min/max ticket price **25** / 10,000 USDC, USDC decimals = 6. The
per-ticket liability cap is the Technical Specification's §3.5 formula, `min(0.5 · vault_margin/10_000 ·
free_balance, 150 bps · total_assets)` applied to `payout_max − vault_credit`, with the integrator's
aggregate ceiling `20 % · total_assets` as a separate limit; §6's worked examples below
instead calibrate to a flat `max_payout_bps = 1000` reference cap — each is labelled with that input
where it's used, since the variance and concurrency reasoning itself (§6) is unaffected in kind, but
the specific numbers would come out materially tighter under the current formula. All
arithmetic below is exact integer arithmetic verified in Python (`fractions.Fraction` where exactness
matters) or measured directly on Solana via Mollusk. Every number quoted was computed.

---

## 0. Final recommended representation (summary — derivation follows)

```
P_SCALE   : u128 constant = 1_000_000_000           // probability fixed point (1e-9 granularity)
BPS_SCALE : u128 constant = 10_000                  // multiplier fixed point (1 bp granularity)

struct Outcome { p: u64, m: u64 }                    // p in [0, P_SCALE], m in bps (see §1 for why u64, not u32)

// Shape invariant, checked at open_ticket on the payout table passed as an argument (§2):
sum(outcome.p for outcome in payout_table) == P_SCALE     // EXACT equality, not "<=" or "~="

// EV check, done at open_ticket on the same bytes, then frozen on the ticket (§3) — ZERO rounding error:
lhs: u128 = sum( outcome.p as u128 * outcome.m as u128 for outcome in payout_table )
rhs: u128 = (10_000 - margin_bps) as u128 * P_SCALE
require(lhs <= rhs)

// Per-outcome variance cap, new constraint this document adds (§6):
require(outcome.m <= M_MAX_BPS)   // M_MAX_BPS = 100_000_000 bps = 10,000x = M_CEILING (§6)

// Aggregate exposure cap across all currently-open tickets, new constraint this document adds (§6):
sum(open_ticket.max_possible_payout for open_ticket in vault) <= kappa * vault   // kappa <= 1, see §6
```

Outcome count cap: **32**, not 16 — driven by account size/audit surface, not compute units (§7 shows CU is
irrelevant at this scale).

---

## 1. Representation

### 1.1 Range and granularity

`p_i` is an integer in `[0, 1_000_000_000]` representing `p_i / 1e9`. Smallest nonzero probability:
`1 / 1e9 = 1e-9`. Largest: `1e9 / 1e9 = 1`. Granularity is **constant in absolute terms** (1e-9 per step) and
therefore **grows in relative terms as the true probability shrinks**: for a target odds of 1-in-N, the
relative quantization error of the nearest representable value is bounded by `0.5 / (1e9/N) = N / 2e9`.

Computed:

| target odds | exact units (1e9·p) | rounded units | represented p | relative error |
|---|---|---|---|---|
| 1-in-100,000 | 10,000.000000 | 10,000 | 1.000e-05 | 0 (exact — 1e9/1e5=1e4) |
| 1-in-10,000,000 | 100.000000 | 100 | 1.000e-07 | 0 (exact) |
| 1-in-1,000,000,000 | 1.000000 | 1 | 1.000e-09 | 0 (exact, at the floor) |
| 1-in-12,345,678 | 81.000007 | 81 | 8.100e-08 | **8.2e-08** |
| 1-in-3 | 333,333,333.33 | 333,333,333 | 0.333333333 | 1.0e-09 |

**Verdict:** any odds of the form `10^k` is exact. Any odds requiring finer resolution than 1e-9 (rarer than
1-in-1,000,000,000) is **not expressible** — it rounds to the p=1 floor or to p=0. A p=0 outcome with a
nonzero multiplier must be rejected at `open_ticket` (it would let outcome-selection code assign it a nonzero
probability by implementation accident with zero EV cost showing in the check). 1e9 fixed point comfortably
covers every top-payout design a real game would use (1-in-100,000 through 1-in-10,000,000 are exact or within
8.2e-8 relative error); it does **not** need to go finer for V1's design space.

### 1.2 Overflow: p_i · m_i and the sum, in u128

```
u128::MAX = 340,282,366,920,938,463,463,374,607,431,768,211,455
u64::MAX  =              18,446,744,073,709,551,615
u32::MAX  =                       4,294,967,295
```

Worst single term (p_i at its max, 1e9, times m_i at its representable max):

| m_i width | worst term p·m | headroom under u128::MAX |
|---|---|---|
| u32 | 4,294,967,295,000,000,000 | 7.92e19× |
| u64 | 18,446,744,073,709,551,615,000,000,000 | 1.85e10× |

RHS bound `(10000-150)*1e9 = 9,850,000,000,000`, headroom under u128::MAX = 3.46e25×.

**Overflow is not a real risk at any representable scale, even with m_i as u64 and 32 outcomes** (worst-case
sum ≈ 32 × u64::MAX × 1e9 ≈ 5.9×10^29, still 5.8×10^8× below u128::MAX). `checked_mul`/`checked_add` should
still be used defensively (cheap, and turns a hypothetical future bug into a revert instead of silent wraparound), but this is belt-and-suspenders, not a live constraint.

### 1.3 Multiplier width: bps unit is fine, u32 storage is NOT

A "basis points" multiplier invites one concrete bug: **bps is the right unit, but the
multiplier field must be `u64`, not `u32`.** Proof: take the rarest representable probability, `p_i = 1` unit
(1e-9), at `margin_bps = 150`. The multiplier that exactly exhausts the EV budget for that single outcome is:

```
m_max = (1 - margin) / p = 0.985 / 1e-9 = 985,000,000x  =  9,850,000,000,000 bps-units
```

`9.85e12 > u32::MAX (4.29e9)` — a **legitimate, EV-check-compliant** 1-in-a-billion top-payout table is
unrepresentable in a `u32` multiplier field; it silently truncates/panics depending on the language. `u64`
holds it with 1.87e6× headroom. **Recommendation: keep the multiplier unit at basis points (10^-4), but store
`m_i` as `u64`, bounded by `M_CEILING` (10,000×) at `open_ticket`.** Basis points give 0.01% relative precision on the payout side, which is far finer than
needed (real games round displayed multipliers to 2-4 significant digits); the problem was never unit
coarseness, it was integer width.

### 1.4 Should the multiplier move to a finer unit than bps?

No. The floor above (§1.3) shows the *width* is the gap, not the *unit*. A finer unit (e.g. 1e-6) would only
shrink the useful range further for the same integer width, making the u32 mistake worse, not better, while
buying no game-design benefit — no real payout table needs multiplier precision finer than 1 bp.

---

## 2. The sum of probabilities: must equal `P_SCALE` exactly

A sum that is not exactly `P_SCALE` is dangerous in both directions, for different reasons:

**`sum(p_i) < 1e9` (under-declared):** there is a residual probability mass, `1e9 - sum(p_i)`, not attached
to any declared outcome. If outcome-selection code treats "random value didn't match any outcome" as a loss (m=0),
the check still holds (adding p·0 to the true EV only lowers it) — but this makes safety depend on a **default
branch never explicitly checked against the invariant.** If that default branch instead falls through to outcome
0 (a common off-by-one in a "find first cumulative boundary >= r" loop with a buggy final comparison), outcome
0's *effective* probability silently exceeds its *declared* `p_0`, and the checked invariant no longer bounds
the *realized* EV. This is exactly the "one rounding bug drains the vault" scenario the team is worried about,
except the bug is in outcome dispatch, not arithmetic rounding.

**`sum(p_i) > 1e9` (over-declared):** cumulative boundaries `C_i = p_1 + ... + p_i` now exceed the domain size
(`P_SCALE`, or whatever RNG-reduction domain is used, see §4) used to pick an outcome. Either (a) the
implementation clips/truncates the tail outcome(s), silently *reducing* their realized probability below
declared — vault-safe but breaks auditability (declared ≠ realized), or (b) a naive cumulative-sum accumulator
that assumes `sum == P_SCALE` and sizes its arithmetic accordingly can overflow/wrap its own domain type,
corrupting boundary values arbitrarily — a direct, exploitable memory/logic-safety bug, not just an EV
statistics problem.

**Rule:** enforce `sum(p_i) == P_SCALE` **exactly**, checked at `open_ticket` on the payout table the instruction
carries, reject otherwise. This is a single O(N) integer equality check,
already computed for free while accumulating the EV sum. It eliminates both failure directions and makes the
auditability claim literal: the declared table *is* the complete, exhaustive outcome space — nothing implicit,
nothing to trust about a default branch.

---

## 3. Rounding: the EV check has **zero** rounding error

### 3.1 The exact expression

```
lhs: u128 = Σ_i ( p_i as u128 ) * ( m_i as u128 )      // exact — no division anywhere
rhs: u128 = (10_000 - margin_bps) as u128 * P_SCALE       // exact — margin_bps and P_SCALE are both integers
require(lhs <= rhs)
```

Derivation: the check is `Σ (p_i/1e9)·(m_i/1e4) <= (10000-margin_bps)/10000`. Multiply both sides by
`1e9 · 1e4 = 1e13` (a fixed, known-exact scale factor) and every term becomes an integer with no remainder,
because `p_i`, `m_i`, and `margin_bps` are already integers. **There is no rounding step to analyze, because
there is no division.** A lossy formulation — computing each term as a pre-divided fixed-point fraction, or
using floating point — would need a rounding rule chosen so that any error favours the vault. The exact
cross-multiplication needs no such rule: not rounding at all is strictly stronger than rounding carefully,
and strictly cheaper (no divisions in the hot path).

### 3.2 Proof by boundary-exact construction

Built a 2-outcome table that sits exactly on the margin boundary: `p_1 = 197,000,000`
(19.7%), `m_1 = 50,000` bps (5.0000×), `p_0 = 803,000,000`, `m_0 = 0`.

```
lhs = 197,000,000 * 50,000            = 9,850,000,000,000
rhs = (10,000 - 150) * 1,000,000,000  = 9,850,000,000,000
lhs == rhs  →  EXACT MATCH, passes.
```

### 3.3 Why floating point must never touch this check (adversarial demonstration)

Evaluating the *same* boundary-exact table in naive float64 (`total += (p/1e9)*(m/1e4)`, `bound = 1 -
margin_bps/10000`):

```
float64 total EV = 0.9850000000000001
float64 bound    = 0.985
float64 says: total <= bound → False   ← WRONGLY REJECTS a table that is exactly at the allowed margin
float64 - bound = 1.1102230246251565e-16   (one ULP of IEEE-754 double at magnitude ~1)
```

A legitimate payout table that extracts the full permitted margin — the payout table a rational integrator would
actually submit — is **falsely rejected** by float64 due to summation noise below the resolution of the
fixed-point domain. The reverse direction (falsely *accepting* an over-budget table) is not observed at this
specific scale only because the smallest possible overshoot in the integer domain (1 part in `1e13`, i.e.
relative `1e-13`) happens to sit ~1000× above float64's epsilon (`2.22e-16`) — a coincidence of this scale
choice, not a property that should be relied on. **Conclusion: exact `u128` cross-multiplication is not a
style preference, it is required for correctness — and it also happens to be free, since SBF/BPF has no FPU
and floats are emulated (expensive) if ever used on-chain.**

### 3.4 The one place rounding is unavoidable: settle-time payout

Computing the actual token payout requires a division that the EV check does not:

```
payout_units: u64 = floor( price_units * m_bps / BPS_SCALE )
```

**Direction:** floor always rounds *against the player, in favor of the vault* (`payout_units <= true value`).
**Bound:** `true_value - floor(true_value) = (price_units * m_bps mod BPS_SCALE) / BPS_SCALE`, a value in
`{0, 1/10000, ..., 9999/10000}` of **one smallest USDC unit** (1e-6 USDC). This is a closed-form proof, not a
search: floor-division error is by construction confined to `[0, 1)` smallest-units, so it is **always
strictly less than 1e-6 USDC**, for every price and every multiplier, with no adversarial payout table able to do
worse — the bound doesn't depend on the payout table at all, only on the fact that one division by `BPS_SCALE`
happens once per settlement.

Expressed in bps of price at the *minimum* allowed ticket price (7.5 USDC = 7,500,000 units, the worst case since
relative error shrinks as price grows):

```
max relative error = 1 unit / 7,500,000 units * 10,000 ≈ 0.0013 bps
```

Negligible, and it is the **only** rounding in the entire protocol.

---

## 4. Outcome selection and modulo bias

### 4.1 Construction

Given `sum(p_i) == P_SCALE` exactly (§2), build cumulative boundaries `C_0=0, C_1=p_1, ..., C_n=P_SCALE`. Draw
an integer `r` uniform on `[0, P_SCALE)`. Select outcome `i` such that `C_{i-1} <= r < C_i`. Then
`P(outcome i) = (C_i - C_{i-1})/P_SCALE = p_i/P_SCALE` **exactly** — this matches the declared table with zero
statistical error, *provided `r` is genuinely uniform on `[0, P_SCALE)`*. That proviso is where real bugs live:

### 4.2 Modulo bias, quantified

Reducing a random word of `B` bits into the `[0, 1e9)` domain via `word % 1e9` is biased whenever
`2^B mod 1e9 != 0` (always true here, since 1e9 = 2^9 · 5^9 doesn't divide any power of two). Measured bias:

| source width | `2^B mod 1e9` | biased-residue fraction | per-residue relative bias |
|---|---|---|---|
| u32 | 294,967,296 | 29.50% | **23.28%** |
| u64 | 709,551,616 | 70.96% | 5.42e-11 |
| u128 | 768,211,456 | 76.82% | ~0 |
| 256-bit hash | 129,639,936 | 12.96% | ~0 |

**A 32-bit RNG word reduced into the 1e9 domain is 23% biased on the over-represented residues — not a
theoretical nitpick, an outright broken PRNG use.** A 64-bit word's bias (5.4e-11 relative) is far below the
representation's own granularity (1e-9) and would never be observable, but it is not *zero*, and "the entire
security model of the protocol" should not lean on "negligible" when "exact" is one branch away.

### 4.3 Exact fix: rejection sampling

```
w: u64 = <uniform 64-bit word from a >=256-bit commit-reveal/VRF hash>
threshold: u64 = (2^64 / P_SCALE) * P_SCALE   // = 18,446,744,073,000,000,000
if w >= threshold { redraw w (fresh hash bytes); }   // rejection probability = 3.846487e-11 ≈ 1-in-26,000,000,000
r: u64 = w % P_SCALE                                  // now EXACTLY uniform on [0, P_SCALE)
```

If instead the reduction is performed directly on the full 256-bit hash output (no truncation to 64 bits
first), the rejection probability drops to `1.12e-69` — will not trigger once over the protocol's lifetime,
included only to state the exact bound. **Recommendation: derive from a >=256-bit source (the commit-reveal
hash, not a raw 64-bit counter), reduce with rejection sampling, never `% 1e9` a 32-bit or smaller value.**
This makes "the realized distribution matches the declared payout table" a proven equality, not an approximation.

---

## 5. Margin snapshotting

`margin_bps` must be **copied into the `Ticket` account at `open_ticket`** and settlement must read only that
snapshot — never the live vault/config account. Rationale, by construction: the EV check the player implicitly
relies on ("this payout table was verified against the margin shown to me") is a statement about the state of the
world *at the moment the ticket was opened*. If `settle_ticket` re-reads a global `margin_bps` that governance can
change in between:

- an admin (or a compromised admin key) can raise `margin_bps` after open, clawing back more than the
  payout table was checked against at open time — the settled outcome no longer corresponds to any payout table that
  ever actually passed the invariant;
- conversely, a colluding admin can lower it for one specific ticket, exempting a favored player from the
  margin without it showing anywhere in the payout table that was public at open time.

Either way, the auditability claim — "payout table + margin fully determine the fairness of this ticket" — becomes
false the instant the margin can move between the two instructions, because the two instructions may now be
verifying different inequalities.

The **entire payout table and `margin_bps` are snapshotted at open**: the payout table is an argument of `open_ticket`
stored on the ticket, not a registered account an integrator could edit afterwards, so settlement uses the
exact bytes the player could have audited at open time.

By contrast, the per-ticket liability cap (§6) is *not* part of the fairness contract shown to the player —
it's a vault-protection mechanism. It is evaluated **once, at `open_ticket`**, against the free balance at that
moment, and the resulting liability is reserved on the vault until the ticket closes (Technical Specification
§3.5, Spec 04 §2.4); settlement reads nothing live. Re-checking the cap at settle would let a vault that shrank
in between default on a ticket it had already accepted, which is exactly what the reservation exists to prevent
(§6.5 covers the aggregate side of the same problem).

---

## 6. What the invariant does not protect — variance, and the concurrency gap

**This is the load-bearing section.** The EV inequality bounds a mean. It says nothing about variance,
kurtosis, or what happens when many tickets are outstanding at once. All three gaps are exploitable by a fully
compliant integrator who never violates a single stated rule.

### 6.1 Same EV, unbounded variance (analytic)

Two payout tables, both exactly at `EV = 1 - margin = 0.985`:

| table | p | m | EV | Var(X) | std(X) |
|---|---|---|---|---|---|
| safe (coinflip) | 0.4925 | 2.0× | 0.985000 | 0.999775 | 0.9999 |
| representation-floor lottery | 1e-9 | 985,000,000× | 0.985000 | **9.702250e+08** | **31,148.4** |

Same expected vault take, **9.70×10^8 times the variance** — and this lottery table violates *nothing* stated
in §1–§4: it's within the representable range, `sum(p_i)=1e9`, the EV check passes exactly, no rounding
issue.

### 6.2 The realistic version of the attack: calibrate to the payout cap, not the representation floor

A rational integrator doesn't submit a multiplier that just gets clipped into oblivion by the per-ticket
liability cap — they calibrate `m` to *exactly* the cap-implied multiplier, and raise `p` accordingly (the
EV constraint `p·m <= 1-margin` trades the two off, but doesn't stop this). Modelled at the flat
`max_payout_bps = 1000` cap and the 1 USDC ticket price this document's own reference examples use (the
protocol's current minimum ticket price is 7.5 USDC); the qualitative shape of the attack does not depend on
either specific input, only the numbers below do:

```
vault0 = 200,000 USDC, price = 1 USDC
cap_multiplier = max_payout_bps/1e4 * vault0/price = 0.10 * 200,000/1 = 20,000×
p_smart = (1-margin) / cap_multiplier = 0.985/20,000 = 4.925e-5   (≈ 1-in-20,305)
```

This **looks like an ordinary "1-in-20,000 top payout" slot game** — nothing about it screams adversarial. Its
variance: `Var(X) = 19,699.03`, i.e. **19,700× the coinflip baseline**, and every single win pays out *exactly*
the maximum the cap allows. The protocol's actual per-ticket cap is the Technical Specification's
free-balance-scaled formula (§2), which would calibrate this attack to a different, generally smaller,
cap-implied multiplier — the point §6.4 below generalizes across cap values, and the conclusion holds
regardless of which specific cap the protocol enforces.

### 6.3 Monte Carlo: same expected profit, wildly different vault risk

Continuing the §6.2 calibration (flat 1000 bps cap, $1 ticket price): 4,000 independent trials × 20,000 tickets each,
the cap evaluated at each open against the *current* vault balance (as the protocol does, §5), same price and
same ticket count for both tables:

| | safe (coinflip) | smart-adversarial (1-in-20,305 top payout) |
|---|---|---|
| expected vault profit (both, by EV) | 300.0 USDC | 300.0 USDC |
| mean max-drawdown | 0.02% | **6.04%** |
| p95 max-drawdown | 0.05% | **20.34%** |
| p99 max-drawdown | 0.08% | **28.44%** |
| worst observed drawdown (4,000 trials) | 0.13% | **40.77%** |
| P(drawdown ≥ 10%) | 0.0000 | **0.2592** |

Identical nominal "margin paid to the vault." A **26% chance of losing at least 10% of the vault**, and a
worst observed case of losing 41%, for a payout table that is fully compliant with every rule in §1–§5. This is
the concrete falsification of "the EV check is the entire security model."

### 6.4 Formula: variance an integrator can inflict, per unit of margin paid

For the extremal two-outcome payout table held exactly at the EV boundary (`p·m = EV`, `p = EV/m`):

```
Var(X) = p·m² - (p·m)² = EV·m - EV² = EV·(m - EV) ≈ EV·m    for m >> EV
```

**Variance-per-unit-of-declared-margin grows linearly and unboundedly with the chosen multiplier `m`** — bounded
only by whatever `m` is allowed to be. Candidate hard caps on the maximum single-outcome multiplier, and the
resulting worst-case variance (computed):

| `M_max` | implied min win-prob at boundary | worst-case Var(X) | ratio vs coinflip baseline |
|---|---|---|---|
| 100× | 9.850e-03 (1-in-102) | 97.53 | 97.6× |
| 1,000× | 9.850e-04 (1-in-1,015) | 984.03 | 984.3× |
| 10,000× | 9.850e-05 (1-in-10,152) | 9,849.03 | 9,851.2× |
| 20,000× | 4.925e-05 (1-in-20,305) | 19,699.03 | 19,703.5× |
| 50,000× | 1.970e-05 (1-in-50,761) | 49,249.03 | 49,260.1× |

Equivalently, a **minimum win-probability floor** `p_floor` gives the same bound via `M_max = EV/p_floor`.

**Recommendation: add a hard per-outcome multiplier cap `M_max`** (protocol constant, or a per-game-category
config value), e.g. **`M_max = 10,000×`** as a default — this permits real long-odds design (industry
slot machines rarely exceed 10,000–50,000× anyway) while bounding worst-case single-ticket variance to `~9,850 ×
price²` (stdev ≈ 99× price) instead of the unconstrained `~9.7×10^8 × price²` (stdev ≈ 31,148× price). The
check is `require(m_i <= M_MAX_BPS)`, O(1) per outcome, computed in the same pass as the EV sum — free.

### 6.5 The concurrency/aggregation gap in `max_payout_bps`

`max_payout_bps` bounds a *single* ticket's payout to a fraction of the vault **at the moment it's checked**.
It does not bound the **sum** of obligations from many tickets open *simultaneously* (opened before any of them
settle, so each of them saw the same vault balance). Quantified for the §6.2 "smart" table
(`p = 4.925e-5`), via Poisson approximation on the number of concurrent hits:

| concurrent open tickets N | λ = N·p | P(≥1 hit) | P(≥5 hits) | **P(≥10 hits)** |
|---|---|---|---|---|
| 1,000 | 0.049 | 4.81% | 0.00% | 0.00% |
| 5,000 | 0.246 | 21.83% | 0.00% | 0.00% |
| 10,000 | 0.492 | 38.89% | 0.02% | 0.00% |
| 20,305 | 1.000 | 63.21% | 0.37% | 0.00% |
| 50,000 | 2.462 | 91.48% | 10.39% | 0.02% |
| 100,000 | 4.925 | 99.27% | 54.62% | 2.92% |
| 200,000 | 9.850 | 99.99% | 96.78% | **52.32%** |

At 200,000 concurrently-open $1 tickets on this one game, there's a **52% chance that 10 or more of them win
simultaneously** — and 10 simultaneous wins at 10% of the vault each is **100% of the original vault**,
while **every one of those 200,000 tickets individually satisfied the per-ticket `max_payout_bps ≤ 10%` check.**
The per-ticket cap does not compose across concurrency; nothing in the current spec bounds the *sum* of
outstanding promises.

**This is the gap that most needs closing, and it is independent of everything else in this document** — it
survives even a perfect EV check, perfect rounding, perfect RNG, and a perfect per-outcome variance cap.

**Fix: a global reserved-exposure invariant**, tracked as a running counter on the vault (the exact terms — liability net
of the vault credit, gross solvency, κ — are the Technical Specification's §3.5; this sketch keeps the §6.2 units):

```
reserved_exposure += price * min(declared_m, live_cap_at_open)     // on open_ticket
reserved_exposure -= <same amount>                                 // on settle_ticket / expire_ticket
require(reserved_exposure <= kappa * current_vault)              // checked at every open_ticket
```

`kappa <= 1` is the minimum solvency bar (never promise more than the vault has); recommend `kappa` in
`[0.8, 1.0]` to leave operational margin (withdrawals, other games). This closes the gap regardless of how
many tickets are concurrently open, independent of the per-ticket cap, and independent of whether settlement is
synchronous (same slot) or asynchronous (VRF callback minutes later — the more dangerous case, since the
vulnerable window is however long open-to-settle latency is).

### 6.6 Overflow check on the §6.4 cap, and the natural generalization

With `M_max = 10,000× = 1e8` bps-units and `N=32` outcomes: worst term `p_i·m_i² <= 1e9·(1e8)² = 1e25`, summed
over 32 outcomes `<= 3.2e26` — 1.06×10^12× below `u128::MAX`. Even at the *uncapped* representation-floor
extreme (`m_i` up to `9.85e12` bps-units), `Σ p_i·m_i² <= 3.1×10^36`, still under `u128::MAX` with 110×
headroom — safe, but tight enough to note: **apply the `M_max` cap first**, and a variance-budget
generalization (`Σ p_i·m_i² <= C`, strictly more expressive than a flat per-outcome cap, allowing
multi-outcome risk-spreading designs) becomes trivially overflow-safe on top of it. Recommend `M_max` as the
v1 mechanism (simplest to audit, cheapest to check) and documenting the variance-budget form as a considered
future extension, not blocking V1.

---

## 7. Compute units — measured, not estimated

Measured with `mollusk-svm 0.13.1` (a standalone probe program and runner). The Technical Specification §2 pins 0.15.1 for the test harnesses; the probe is re-run on it before release and the table below updated if a figure moves.

Built a minimal SBF program implementing exactly the §3.1 check (parse `N` outcomes from raw instruction bytes,
accumulate the `u128` cross-multiplication, compare, return the result via `set_return_data`) and measured it
with **Mollusk** — the same harness as the reference baselines below, same Solana runtime version,
zero accounts touched (isolates the check itself). Results:

| N | measured CU |
|---|---|
| 0 | 232 |
| 1 | 315 |
| 2 | 393 |
| 4 | 547 |
| 8 | 855 |
| 16 | **1,471** |
| 24 | 2,087 |
| 32 | **2,703** |

Linear fit: `CU(N) = 237 + 77·N` (residuals < 2 CU across all 8 points — the relationship is exactly linear, as
expected for a fixed-cost loop body). **Marginal cost is 77 CU per outcome**, including the two 64-bit loads,
the widening `u64×u64→u128` multiply, the `u128` accumulate, and loop overhead. u128 arithmetic on SBF is not
the expensive operation some might assume.

Context, from measured baselines of an existing production Solana program: an instruction verifying a
SHA-256 reveal over 2 accounts = 5,361 CU measured; one deserializing its configuration to snapshot a
parameter = 11,688 CU; a warm user instruction = 19,421 CU; a payout instruction's budget = 38,000 CU.
**The entire payout table check at 32 outcomes (2,703 CU) costs about half of the reveal verification
alone, and about a seventh of the user instruction.**

Caveat: this measures a zero-copy-style raw byte read. A Borsh-`Vec<Outcome>` deserialization (heap allocation
+ per-field copy) would add overhead on top — using that program's own calibration ("`User` grew
from 289 to 481 bytes... costs ~600-900 CU of extra borsh work", i.e. ~3.1–4.7 CU/byte for that struct's Borsh
layout), a 32-outcome table at 16 bytes/outcome (512 bytes) could add roughly 1,600–2,400 CU of deserialization
on top of the 2,703 CU arithmetic cost — still under 5,200 CU total, trivial next to a ~20,000+ CU full
instruction budget. **Recommendation: implement the payout table account as a fixed-size zero-copy layout
(`bytemuck`/`#[account(zero_copy)]`), matching the measured-cheap profile, rather than a heap-allocated `Vec`.**

**Recommendation: cap outcome count at 32, not 16.** Compute units do not justify capping lower — even N=64
would extrapolate to ~5,165 CU, still negligible. Choose the cap for account-size/rent economics and, per §6,
**audit-surface**: every additional outcome is another place a hostile payout table can concentrate tail risk
without tripping the EV check (§6.1–§6.4), which is an argument for keeping the cap modest independent of CU
headroom. 32 balances real game-design expressiveness against a still hand-auditable table size.

---

## 8. Property tests and fuzz targets

Each of these is a concrete assertion a Rust implementer should turn into a `proptest` property, a
`proptest-state-machine` model or a `cargo-fuzz` target — the toolchain of Spec 07 §9. Grouped by the section
that motivates it.

**Representation & overflow (§1)**
1. For all `p_i in [1, 1e9]`, `m_i in [1, u64::MAX]`, `checked_mul(p_i, m_i)` never overflows `u128`. (Should
   be provably true from the type bound — assert it anyway as a regression guard.)
2. For all valid payout tables (≤32 outcomes, `m_i <= M_MAX_BPS`), `Σ p_i·m_i` never overflows `u128` even summed
   at `N=32` with every outcome at the representable maximum.
3. For every `10^k`-odds probability (`k` in 0..9), the round-trip `p_units = round(1e9/10^k)` reproduces the
   exact target with zero relative error.

**Sum-of-probabilities (§2)**
4. `open_ticket` rejects any payout table with `Σ p_i != P_SCALE` (`<` and `>` both, off-by-one in each
   direction).
5. `open_ticket` rejects a payout table with an outcome where `p_i == 0` and `m_i != 0`.
6. Fuzz: random `N in [2,32]`, random `p_i` summing to exactly `P_SCALE` (generate by drawing `N-1` cut points
   and reject/retry, or fix up the last outcome) — accepted iff the EV check also holds; never accepted with a
   wrong sum regardless of EV.

**Rounding / EV check exactness (§3)**
7. `ev_check(payout_table, margin_bps)` computed via the `u128` cross-multiplication and, in the test harness only,
   independently via `fractions.Fraction`-equivalent exact rational arithmetic (e.g. `rug`/`num-rational` in
   Rust) — the two must agree on every fuzzed input, always (zero-tolerance equality, not "close enough").
8. Property: a payout table constructed to hit `lhs == rhs` exactly (boundary-exact, as in §3.2) always passes;
   perturbing any single `m_i` up by 1 bp always flips it to fail.
9. Settle-time payout: for all `price_units in [25_000_000, 10_000_000_000]` (25 to 10,000 USDC) and all
   `m_bps in [0, M_MAX_BPS]`, `true_payout - floor_payout < 1` (smallest USDC unit), proven as an exact
   arithmetic identity, not sampled.
10. No floating-point type appears anywhere in the compiled program (a `grep`/clippy lint in CI, not just a
    unit test — `f32`/`f64` should be a compile error in the on-chain crate).

**Outcome selection & RNG (§4)**
11. Given a fixed payout table and a *simulated exactly-uniform* `r` source over many draws (e.g. 10 million),
    the empirical outcome-frequency distribution matches `p_i/1e9` within a chi-squared test at a fixed
    significance level (this tests the boundary/dispatch code, not the RNG).
12. Property: for every `r in [0, P_SCALE)`, exactly one outcome is selected (no gap, no double-match) —
    i.e. the cumulative boundaries partition `[0, P_SCALE)` with no overlap and no hole, for every valid
    (sum-exact) payout table the fuzzer generates.
13. Rejection-sampling correctness: for the chosen reduction width (64-bit word into `[0, 1e9)`), assert the
    rejection threshold constant equals `(2^64 / P_SCALE) * P_SCALE` exactly, and that any `w >=` that
    threshold is never used to derive `r` (fuzz raw `w` values at and around the threshold, including
    `threshold - 1`, `threshold`, `threshold + 1`, `u64::MAX`).
14. Regression guard: assert the reduction is **not** performed on any source narrower than 64 bits anywhere
    in the codebase (a fuzz/lint that fails if a `u32` or `u16` random value is ever passed into the outcome
    reducer).

**Margin snapshotting (§5)**
15. `open_ticket` copies `margin_bps` and the full payout table — an argument of the instruction, not a registered
    account — into the `Ticket` account; a subsequent `set_params` changing the global margin floor between
    `open_ticket` and `settle_ticket` produces a settlement identical to one where the config was never touched
    (state-machine fuzz: interleave `open_ticket → set_params(margin_floor') → settle_ticket` against
    `open_ticket → settle_ticket`, assert equal payouts for equal RNG outcomes).
16. `settle_ticket` never reads the live config at all (a state-machine harness that mutates the global config
    account between open and settle and asserts settlement still succeeds identically, proving no live read
    occurred).

**Variance / exposure caps (§6) — the highest-value fuzz targets**
17. `open_ticket` rejects any outcome with `m_i > M_MAX_BPS`, at the boundary (`M_MAX_BPS` exactly
    passes, `M_MAX_BPS + 1` fails) and fuzzed.
18. Monte-Carlo-in-CI: for a corpus of fuzzer-generated valid payout tables (random, sum-exact, EV-exact-or-under,
    `m_i <= M_MAX_BPS`), assert `Var(X) <= EV·(M_MAX_BPS/BPS_SCALE - EV)` for every one — i.e. the analytic
    §6.4 bound actually holds for every table the fuzzer can produce, not just the hand-built example.
19. Reserved-exposure invariant: state-machine fuzz opening and settling/expiring tickets in random
    interleaved order (including many-open-before-any-settle, the §6.5 attack shape) — assert
    `reserved_exposure <= kappa * vault` holds after *every* instruction, and that `reserved_exposure`
    exactly returns to its pre-open value after settle/expire (no leak, no double-release).
20. The §6.5 concurrency scenario itself as a scripted fuzz corpus seed: open `N` tickets on an
    EV-boundary/`M_max`-boundary payout table before settling any, for `N` sweeping past the point where
    `reserved_exposure` would exceed `kappa * vault` absent the fix — assert `open_ticket` starts rejecting
    once the aggregate cap is reached, never silently overcommitting.
21. Differential test: run the same fuzzed payout table + RNG trace through (a) the on-chain check and (b) a
    Python re-implementation of §3.1/§4.3 — assert bit-exact
    agreement on accept/reject and on the selected outcome, for every trace, as a standing CI gate rather than
    a one-off validation.
