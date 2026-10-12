> Appendix to [Fade Spec 01 — Vault and LP Accounting](01-vault-and-lp-accounting.md), part of [Fade](../README.md) → Technical. The output behind every numeric claim of the domain document, and the flat-cap sensitivity study its §5.2, §5.3 and §6 summarise.

# Fade Spec 01 — Vault and LP Accounting — Appendix

## Sensitivity study at a flat 10 % cap

> These sections model the per-ticket rule as the flat `max_payout_bps = 1000` reference cap, not the protocol's free-balance cap of Technical Specification §2, and were not re-run under it. They are a sensitivity study.

### 4.2 (as studied) Fix: global utilization cap, alongside the per-ticket cap

This is a sensitivity study, computed at a flat `max_payout_bps = 1000`
per-ticket reference cap; the protocol's actual
per-ticket cap is the Technical Specification's §2
free-balance-scaled formula (§4.1), and its equivalent aggregate
mechanism — the utilisation admission breaker — is fixed at **70%**, not
the 80% this section arrives at below.

```
open_ticket is REFUSED unless BOTH hold:
  price * (max_m - 1)              <= total_assets * max_payout_bps    / 10_000
  total_reserved_liability_after   <= total_assets * max_utilization_bps / 10_000
```

Both checks use the same `total_assets` base (not a shrinking "available"
balance) — deliberately: an "available balance" formulation converges
geometrically toward 100% utilization over many small tickets without ever
technically breaching a per-step check, which is a subtler version of the
same freeze. A flat, absolute ceiling on the *aggregate* has no such
loophole. (The Technical Specification resolves this same tension the
other way for the *per-ticket* cap specifically — computing it on the free
balance rather than gross `total_assets` — because there the free-balance
basis turns the freeze from linear into geometric instead of
reintroducing it; see §4.1.)

Computed trade-off at the flat 1000 bps per-ticket cap:

| `max_utilization_bps` | Always-free | Max simultaneous max-sized tickets before refusal |
|---|---|---|
| 10000 (no fix) | 0 | 10 |
| 9000 | 17,500 (10%) | 9 |
| **8000 (this section's recommendation)** | **35,000 (20%)** | **8** |
| 7000 (the protocol's actual ceiling) | 52,500 (30%) | 7 |
| 5000 | 87,500 (50%) | 5 |

At 8000 bps, 8 simultaneous tickets each sized at the full 10%-of-vault tail
is structurally rare for honest traffic (it requires either 8 independent
ticket buyers landing on the same liability-maximizing corner simultaneously,
or one actor doing it deliberately — see cost below); 20% of TVL is
*always* withdrawable regardless of how aggressively that happens. The
protocol sets the actual ceiling tighter, at 7000 bps (70%), leaving 30%
always free rather than 20%.

**Cost of attempting to grief at the cap, at this section's 1000 bps /
8000 bps reference point:** sustaining 80% utilization requires 8
max-sized tickets continuously open, total ticket price in flight `≈ 140.14
USDC`. Each open→settle→reopen cycle costs the attacker an expected
`140.14 * 150bps ≈ 2.10 USDC` in margin. Bounding cycle frequency by
the same p99 settle latency (35s) → ≈103 cycles/hour → **≈216 USDC/hour,
≈5,189 USDC/day** to sustain the freeze at that reference cap — a real,
continuous, on-chain-visible cost, not a one-time $175 free lunch. Under
the protocol's actual, materially tighter per-ticket cap (§4.1) and 70%
ceiling, both the ticket price needed and the ongoing cost move tighter still,
but were not re-run against the new formula.

### 5.2 (as studied) Real numbers (Monte Carlo)

This run, and the time-to-dominance run in §5.3, model the per-ticket
liability rule as the flat `max_payout_bps = 1000` reference cap
throughout, not the Technical Specification's free-balance-scaled formula
(§2), against which this analysis was not re-run. The archetype mix and
volume assumptions below are unaffected in kind; only the ticket-price
clipping and the drawdown/PnL tail are sensitive to which cap is used.

**Assumptions, stated explicitly** (none of this is measured data — the
product doesn't exist yet):
- Payout table mix, volume-weighted: `coinflip (p=0.49, m≈2.01x): 55%`,
  `medium (p=0.10, m≈9.85x): 30%`, `longshot (p=0.01, m≈98.5x): 12%`,
  `top-payout (p=0.001, m≈985x): 3%`. All four calibrated to the exact margin
  floor (`sum(p·m) = 0.985`) — competitive-pressure assumption that
  integrators target the minimum margin the protocol allows.
- Ticket price: lognormal, median $25 (shape `σ=1.1`), clipped to
  `[1, 10,000]` and further capped by the flat `max_payout_bps = 1000`
  per-ticket liability rule modelled here, which for the top-payout archetype
  at a 175k vault binds at **≈17.78 USDC** — far below the stated $10,000
  maximum ticket price; the liability rule, not the ticket-price limit, is what actually
  caps high-multiplier ticket prices. The protocol's actual cap (§2) would
  bind at a different, generally smaller, ticket price.
- Volume scenarios: conservative 500 tickets/day, base 2,000/day,
  optimistic 8,000/day.

30-day Monte Carlo at the flat 1000 bps cap, 3,000 trials/scenario, `TVL = 175,000`:

| Scenario | Monthly volume | Mean monthly PnL | Simple annualized | P(month < 0) | DD 1% | DD 5% | DD 50% |
|---|---|---|---|---|---|---|---|
| Conservative | 664k | +6,431 (3.68%) | 44.1% | 41.9% | 5.07% | 7.36% | 17.10% |
| Base | 2,659k | +28,140 (16.08%) | 193.0% | 35.7% | 11.08% | 14.37% | 30.03% |
| Optimistic | 10,623k | +108,224 (61.84%) | 742.1% | 23.5% | 17.91% | 22.80% | 45.63% |

These headline APYs are **not** the honest disclosure number — they show
that at `TVL = 175,000`, expected return scales with volume/TVL, but so
does risk, and every scenario carries a 24–42% chance of a net *losing*
month. Re-running the conservative-volume case at larger TVL (same 15,000
tickets/month, i.e. holding assumed day-one volume fixed and asking "how
much capital does it take to make this comfortable") gives:

| TVL | Mean monthly PnL % | Simple annualized | P(month < 0) | DD 5% | DD 50% |
|---|---|---|---|---|---|
| 175,000 | 3.72% | 44.6% | 41.5% | 7.30% | 17.24% |
| 262,500 | 2.53% | 30.3% | 40.8% | 4.89% | 12.64% |
| 350,000 | 1.38% | 16.6% | 42.3% | 3.76% | 10.55% |
| 525,000 | 1.26% | 15.2% | 40.0% | 2.54% | 6.90% |

**P(month < 0) barely moves with TVL** (stays ≈40–42%) — because absolute
ticket prices are fixed in dollar terms and the liability cap rarely binds at
this scale, so absolute monthly PnL/variance is roughly TVL-independent;
only its *percentage* impact shrinks as TVL grows. TVL is a **dilution
buffer**, not a risk-reduction lever on its own — the actual driver of
`P(month<0)` is ticket count and payout table mix (§6).

### 5.3 (as studied) Time for the margin to dominate variance

Direct Monte Carlo (not a Gaussian approximation — the payout table mix is
heavy-tailed enough that CLT convergence is itself slow and worth
measuring rather than assuming), checkpointed
over 400,000 tickets / 4,000 trials:

| Tickets | P(cumulative PnL < 0) | ...at conservative/base/optimistic volume, in days |
|---|---|---|
| 1,000 | 38.9% | 2 / 0.5 / 0.1 |
| 20,000 | 40.8% | 40 / 10 / 2.5 |
| 100,000 | 32.6% | 200 / 50 / 12.5 |
| 300,000 | 22.2% | 600 / 150 / 38 |
| 400,000 | 17.9% | 800 / 200 / 50 |

`P(pnl<0)` crosses 25% at 300,000 tickets; it does **not** cross 10%, 5%, or
1% within the 400,000 tickets simulated. **This is a real, honestly-computed
finding, not a modelling artifact**: an ablation (variants of the same run) isolates the cause — it is the **longshot** archetype (12% of
volume, ~98.5x multiplier), not the rarer top-payout archetype (3%, ~985x), that
dominates slow convergence. Removing top-payout alone barely moves the number
(26.30% → 25.52% at 200,000 tickets); removing *both* longshot and top-payout
drops it to 10.42% at the same ticket count. The liability cap self-limits
the top-payout archetype's ticket price — capped near $17.78 at this TVL under the
flat `max_payout_bps = 1000` reference cap modelled here, though the
protocol's actual free-balance-scaled cap (§2) would bind at a different,
generally smaller, ticket price — enough to blunt its variance contribution; it
does **not** similarly constrain the longshot archetype, whose ~$45
average ticket price is rarely capped, so its `price² · Var(X)` contribution
dominates the mix despite lower per-ticket variance than top-payout.
**Implication for the top-level design**: a flat per-ticket cap treats all
multiplier tiers alike for solvency purposes (correctly — it's a
worst-case guarantee) but leaves medium-high-multiplier games as the
dominant source of slow LP-return convergence; a multiplier-tiered cap or
an explicit ceiling on high-variance archetypes' volume share is a
reasonable V2 lever, flagged here, not built into V1.

### 6 (as studied). Risk-of-ruin / drawdown analysis

Monte Carlo methodology, assumptions, and full results are in §5.2/§5.3
above (30-day horizon, 3,000–4,000 trials per configuration, vectorized across
trials in numpy, looped over ticket arrivals). Repeating the headline
drawdown table for the reference `TVL = 175,000`:

| Scenario | DD 1% | DD 5% | DD 50% |
|---|---|---|---|
| Conservative (500/day) | 5.07% | 7.36% | 17.10% |
| Base (2,000/day) | 11.08% | 14.37% | 30.03% |
| Optimistic (8,000/day) | 17.91% | 22.80% | 45.63% |

**Assumptions restated** (per the instruction to report the code's
assumptions, not just its outputs): four 2-outcome payout table archetypes
calibrated to the exact 150bps margin floor; volume-weighted mix 55/30/12/3%;
lognormal ticket prices (median $25, `σ=1.1`) clipped to `[1, 10000]` and to
the flat `max_payout_bps = 1000` per-ticket liability cap modelled there — the protocol's actual
cap is the Technical Specification's free-balance-scaled formula (§2);
independent, iid ticket arrivals (no correlation/clustering modeled — a
real deployment could see correlated demand spikes, e.g. one integrator
going viral, which this model does not capture and which would fatten
the left tail further); fixed TVL over the month (no compounding of
intra-month deposits/withdrawals into the drawdown calc — a
simplification that is conservative for the *shape* of the risk but not
exact).

**Read-through for LPs:** even at the most conservative modeled volume,
there is a 1-in-20 chance of a within-month drawdown exceeding 7.4% of
peak TVL, and a coin-flip chance of exceeding 17.1%. At optimistic volume
these figures roughly triple. This is the direct, quantified cost of the
"small vault intermediates large volume" property that also drives the
attractive mean returns in §5.2 — the two are the same lever, not
independent knobs.
