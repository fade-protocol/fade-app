> Appendix to [Fade Spec 02 — Randomness and Settlement](02-randomness-and-settlement.md), part of [Fade](../README.md) → Technical. It holds the evidence behind the parent document, the checklist for a provider V1 does not integrate, and the script behind its numbers. Section numbers are the parent's.

# Fade Spec 02 — Randomness and Settlement — Appendix

## §1 — Research ledger: verified vs. assumed

Verified against primary or near-primary sources:

- **SlotHashes sysvar retains 512 entries** (`solana_program::slot_hashes::MAX_ENTRIES = 512`,
  source comment: "about 2.5 minutes to get your vote in"), *not* 150 as one secondary blog
  claimed — 150 is the unrelated transaction `recent_blockhash` expiry window. This is the hard
  ceiling past which a Switchboard-style commit against `seed_slot` can never be verified again
  because the slot's hash has rotated out of the sysvar. Source: docs.rs `solana-program`
  `slot_hashes.rs`.
- **Solana mainnet slot time is ~350ms as of Aug 2026** (SIMD-0525, first cut from the 400ms
  target), with further reductions toward 200ms planned in phases. This means slot-denominated
  timeouts get *tighter in wall-clock terms* over the program's lifetime — a reason to specify
  every timing parameter in slots, never in seconds, in the actual program.
- **Switchboard On-Demand randomness is commit-reveal**: `commit` locks `seed_slot`; `reveal`
  is a second, separate transaction that reads the oracle's signed value (fetched off-chain from
  Crossbar) and the `SlotHashes` sysvar entry for `seed_slot`. The tutorial's own strictness check
  (`seed_slot == clock.slot - 1`) is explicitly called out in Switchboard's docs as *"a policy
  decision, not a hard-coded universal duration"* — i.e., an integrator choice, not a protocol
  ceiling. The protocol ceiling is the 512-slot SlotHashes window above.
- **Switchboard's `reveal` instruction has no signer restriction tied to the original
  requester** in the published tutorial flow — the settle instruction "accepts any caller with
  valid randomness state." This is the basis for "permissionless reveal" being *possible*; whether
  it *happens* promptly is a separate, unresolved liveness question, which is exactly hole (a).
- **The predecessor Switchboard Randomness Service (SRS) publicly claimed an average fulfillment
  latency of 5 slots**, one request + one response transaction. Treated as an order-of-magnitude
  reference for On-Demand randomness's happy-path latency, not a guarantee — Switchboard's current
  docs publish no SLA number for On-Demand specifically.
- **ORAO VRF fulfillment is performed by ORAO's own fulfillment-authority quorum**, described as
  Byzantine-fault-tolerant ("checks signatures and XORs the randomness given by authoritative
  nodes"). ORAO's own marketing page states speed as "sub-second possible, 4–20s" and cost as
  "0.001 SOL, kept the same since mainnet deployment." ORAO's callback README states the design
  intent that fulfillment happens unconditionally, independent of any callback's success.
- **ORAO's `FulfillV2`/callback design has a configurable per-request deadline expressed in
  slots**; after the deadline, "the randomness request will be fulfilled, but the callback will
  be ignored" — i.e., the *randomness write* is not gated on the deadline, only the optional CPI
  callback is.
- **ORAO's Byzantine quorum is 3 of 3 fulfillment authorities on mainnet (3 of 4 on devnet), with
  no commit phase.** Each authority contributes an Ed25519 signature over the seed, and
  contributions are stored publicly before the quorum completes. The combination protocol is
  therefore not collusion-resistant against a last-revealer attack, since there is no commit phase,
  which is exactly why the seed is pinned to entropy that does not exist until after the ticket
  opens (§3.6 of the Technical Specification) rather than trusted to be honest only at fulfilment
  time. ORAO's exact combination rule (presumably XOR of the per-authority contributions) remains
  unconfirmed, and is needed before an Ed25519-precompile verification of the quorum's own
  signatures can be implemented — the V1.1 hardening path.
- **Per-request cost, exact.** ORAO's fee is 500,000 lamports on mainnet (300,000 on devnet), and
  a request advances 4,455,160 lamports of rent, of which 3,108,960 is refunded at fulfilment and
  1,346,200 is locked permanently (no close instruction), on top of the fee. Total per-ticket
  overhead, including the crank fee, is 2,096,200 lamports, about 0.0021 SOL (≈$0.377 at $180/SOL,
  ≈$0.245 at $117/SOL on 23 September 2026). Measured again on mainnet on 23 September 2026:
  fee 500,000 lamports, fulfilled request 137 bytes holding 1,346,200 lamports. Once SIMD-0437 is
  fully active (696 lamports per byte), the locked part falls to 184,440 lamports and the total to
  934,440, about 0.0009 SOL (≈$0.112 at $120/SOL).

Assumed, not independently verified, and needing confirmation before mainnet:

- **ORAO's exact per-authority combination rule** (presumably XOR of the contributions, per the
  quorum facts above). Needed before an Ed25519-precompile verification of the quorum's own
  signatures can be implemented.
- **Real measured (not marketing) mainnet p50/p99 fulfillment latency for either provider.**
  Neither vendor publishes a reachable latency dashboard. `T_SETTLE` (parent §3) is sized off the
  512-slot hard ceiling and the 5-slot/4-20s reference points with a wide safety margin for
  exactly this reason — treat it as conservative-by-construction, not measured-and-tuned. Samples
  since gathered: 5 slots observed on mainnet, ~10 slots on devnet — still short of a full
  p50/p99 sample.

---

## §5.1 — Switchboard On-Demand checklist (not integrated in V1)

1. **Queue check**: the `Randomness` account's `queue` field must equal the program's
   configured, admin-set queue pubkey — never accept a queue passed by the caller. An integrator
   or player pointing the ticket at a queue they control (or a queue with a single, briberable
   oracle) defeats every other check.
2. **Freshness of commit, not just existence**: `randomness_account.seed_slot` must be strictly
   *after* the `open_ticket` instruction's own execution slot — i.e., record `open_slot` in the
   ticket account at creation, and require `seed_slot > open_slot` at bind time (bind can happen in
   the same instruction as `open_ticket` or in a required follow-up before any settlement is legal).
   This is the check that defeats hole (c): an integrator cannot attach a `Randomness` account
   whose `seed_slot` (and therefore whose eventual revealed value) was already committed *before*
   the ticket — and therefore already knowable — existed.
3. **Not-yet-revealed at bind time**: `randomness_account` must report unrevealed
   (`RandomnessAccountData::get_value` errors / the account's revealed-value slot is unset) at the
   moment it is bound to the ticket. Binding to an already-revealed account is binding to a known
   outcome — an automatic win-for-the-attacker unless this is checked.
4. **Single-use enforcement**: store the bound `randomness_account` pubkey in the ticket account
   and require every subsequent instruction (`settle_ticket`) to re-validate that the account
   passed in still matches the stored pubkey — prevents a swap attack where a different,
   already-favorable randomness account is substituted in the settle instruction.
5. **At settle time**: re-derive the expected value using the *same* `seed_slot` recorded at bind
   time (never trust a `seed_slot` read fresh off the account at settle time without cross-checking
   it against what was stored at bind time) — an oracle account is mutable state; only the binding
   snapshot is trustworthy as "what we committed to."
6. **Oracle authenticity**: the on-chain program must verify the `Randomness` account's data was
   written by the Switchboard On-Demand program (owner check on the account, standard Anchor
   `Account<'_, RandomnessAccountData>` deserialization against the known program ID) — not merely
   that *some* account with the right shape was passed in.
7. **Slot-hash liveness at settle time**: `clock.slot - seed_slot <= 512` (the SlotHashes
   ceiling) — if violated, the ticket should already have hit `T_SETTLE` (150 ≪ 512) and gone to
   `expire_ticket`, so this should be unreachable in practice; assert it anyway as a defensive
   invariant, since it catches a misconfigured `T_SETTLE` immediately in testing rather than in
   an unrecoverable mainnet state. This item is specific to Switchboard, which reads `SlotHashes`
   at settlement; the ORAO path of V1 never does.

---

## Reproducing these numbers

Every figure in the parent document — modulo bias, rejection probabilities, the slot-derived timeouts,
the cranker fee margins, the grinding-attack cost and the statistical detection thresholds — was
computed, not estimated; recompute rather than hand-edit anything derived from them.
