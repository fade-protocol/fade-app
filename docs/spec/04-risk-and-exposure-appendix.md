> Appendix to [Fade Spec 04 — Risk and Exposure](04-risk-and-exposure.md), part of [Fade](../README.md) → Technical. The Monte Carlo output behind the domain document's numeric claims; the grid was run on vaults of 100 k, 250 k and 1 M USDC only.

# Fade Spec 04 — Risk and Exposure — Appendix

## Correlated-exposure stress grid (Spec 04 §7.2)

All integrators run the adversarial archetype — every ticket requests `mult_ceiling`, sized to the cap — across N independent integrators at once. 150 trial paths per cell.

| Vault | Cap (bps of free) | `M_CEILING` | P(dd≥10%) | P(dd≥20%) | P(dd≥50%) | mean dd | max dd | E[monthly ret] |
|---|---|---|---|---|---|---|---|---|
| $100k | 1000 | 1000 | 90.0% | 84.7% | 46.0% | 48.8% | 90.6% | 17.5% |
| $100k | 1000 | 100 | 94.7% | 87.3% | 68.0% | 66.6% | 99.1% | 65.6% |
| $100k | 150 | 1000 | 40.0% | 10.7% | 0.0% | 9.8% | 33.4% | 3.3% |
| $100k | 150 | 100 | 72.0% | 47.3% | 3.3% | 20.8% | 72.2% | 26.0% |
| $250k | 1000 | 1000 | 88.0% | 76.7% | 43.3% | 44.2% | 93.4% | 12.7% |
| $250k | 1000 | 100 | 88.7% | 78.0% | 51.3% | 52.0% | 99.6% | 37.1% |
| $250k | 150 | 1000 | 38.0% | 10.0% | 0.0% | 9.5% | 32.9% | 3.1% |
| $250k | 150 | 100 | 64.7% | 35.3% | 2.0% | 17.4% | 59.5% | 18.7% |
| $1M | 1000 | 1000 | 72.7% | 58.0% | 22.7% | 30.7% | 86.3% | 9.4% |
| $1M | 1000 | 100 | 70.0% | 53.3% | 16.7% | 26.7% | 94.0% | 11.8% |
| $1M | 150 | 1000 | 35.3% | 8.0% | 0.0% | 8.5% | 28.6% | 2.4% |
| $1M | 150 | 100 | 48.0% | 16.0% | 0.0% | 11.3% | 44.9% | 7.8% |
