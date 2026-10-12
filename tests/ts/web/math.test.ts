// The app's mirror of the program's admission arithmetic (apps/web/src/lib/math.ts) against the
// program's own vectors: fade-math payout_table.rs and risk.rs tests, and open_ticket.rs's order.
// The app uses it to explain a payout table and to predict a refusal before asking for a
// signature; a divergence would put a wrong figure or a wrong promise on screen.
import { describe, expect, it } from "vitest";
import {
  BPS,
  MAX_OUTCOMES,
  M_CEILING_BPS,
  P_SCALE,
  allOrNothing,
  assetsNeededFor,
  freeBalance,
  marginBps,
  payout,
  perTicketCap,
  quote,
  rtpBps,
  summarize,
  withdrawable,
  type Outcome,
  type Vault,
} from "../../../apps/web/src/lib/math.ts";
import { DEVNET, SPEC, USDC, rng } from "./fixtures.ts";

const vault = (assets: bigint, reserved = 0n, openCredits = 0n): Vault => ({
  assets,
  reserved,
  openCredits,
});
const two = (p: bigint, m: bigint): Outcome[] => [
  { p, m },
  { p: P_SCALE - p, m: 0n },
];

/** The program's `ev_ok`: Σ p·m ≤ (BPS − margin) · P_SCALE, exactly. */
const evOk = (lhs: bigint, margin: bigint) => margin <= BPS && lhs <= (BPS - margin) * P_SCALE;

describe("payout table validation (payout_table.rs)", () => {
  it("accepts the boundary table and refuses one bp more", () => {
    // p = 0.197, m = 5×: Σ = 0.985 exactly at the 150 bps floor
    const s = summarize(two(197_000_000n, 50_000n));
    if ("problem" in s) throw new Error(s.problem);
    expect(evOk(s.lhs, 150n)).toBe(true);
    expect(marginBps(s.lhs)).toBe(150n);
    const t = summarize(two(197_000_000n, 50_001n));
    if ("problem" in t) throw new Error(t.problem);
    expect(evOk(t.lhs, 150n)).toBe(false);
    expect(marginBps(t.lhs)).toBe(149n);
  });

  it("wants probabilities summing to exactly 10⁹, none of them zero", () => {
    expect(
      summarize([...two(500_000_000n, 20_000n).slice(0, 1), { p: 499_999_999n, m: 0n }]),
    ).toEqual({
      problem: "ProbabilitySum",
    });
    expect(
      summarize([
        { p: 500_000_000n, m: 20_000n },
        { p: 500_000_001n, m: 0n },
      ]),
    ).toEqual({
      problem: "ProbabilitySum",
    });
    expect(
      summarize([
        { p: P_SCALE, m: 5_000n },
        { p: 0n, m: 0n },
      ]),
    ).toEqual({
      problem: "ProbabilityRange",
    });
    expect(summarize([{ p: P_SCALE + 1n, m: 0n }])).toEqual({ problem: "ProbabilityRange" });
  });

  it("caps the multiplier and the number of outcomes", () => {
    expect(summarize([])).toEqual({ problem: "OutcomeCount" });
    expect(summarize(two(1n, M_CEILING_BPS + 1n))).toEqual({ problem: "MultiplierCeiling" });
    expect("problem" in summarize(two(1n, M_CEILING_BPS))).toBe(false);
    expect(MAX_OUTCOMES).toBe(32);
    const even = (n: number): Outcome[] =>
      Array.from({ length: n }, (_, i) => ({
        p: i === 0 ? P_SCALE - BigInt(n - 1) : 1n,
        m: 0n,
      }));
    expect("problem" in summarize(even(32))).toBe(false);
    expect(summarize(even(33))).toEqual({ problem: "OutcomeCount" });
  });

  it("rounds the margin against the integrator", () => {
    // RTP 0.9850000001 → 9 850.000001 bps → ceil 9 851 → margin 149
    expect(marginBps(9_850n * P_SCALE + 1n)).toBe(149n);
    expect(rtpBps(9_850n * P_SCALE + 1n)).toBe(9_851n);
    expect(marginBps(0n)).toBe(BPS);
    expect(marginBps(BPS * P_SCALE + 1n)).toBeNull();
    expect(marginBps(BPS * P_SCALE)).toBe(0n);
  });

  it("rounds payouts and shares down", () => {
    expect(payout(1_000_000n, 15_000n)).toBe(1_500_000n);
    expect(payout(1n, 15_000n)).toBe(1n);
    expect(payout(1n, 9_999n)).toBe(0n);
  });

  it("keeps expected return and margin summing to 100 %, over random tables", () => {
    const r = rng(10);
    for (let i = 0; i < 3000; i++) {
      const n = 1 + r.int(MAX_OUTCOMES);
      let left = P_SCALE;
      const outcomes: Outcome[] = [];
      for (let k = 0; k < n; k++) {
        const p = k === n - 1 ? left : r.big(1n, left - BigInt(n - 1 - k));
        left -= p;
        outcomes.push({ p, m: r.big(0n, 30_000n) });
      }
      const s = summarize(outcomes);
      if ("problem" in s) throw new Error(`${i}: ${s.problem}`);
      const margin = marginBps(s.lhs);
      if (margin === null) {
        expect(rtpBps(s.lhs)).toBeGreaterThan(BPS);
        continue;
      }
      expect(margin + rtpBps(s.lhs)).toBe(BPS);
      // the margin shown is the largest the program's ev_ok accepts
      expect(evOk(s.lhs, margin)).toBe(true);
      expect(evOk(s.lhs, margin + 1n)).toBe(false);
    }
  });
});

describe("caps and withdrawals (risk.rs)", () => {
  it("is half-Kelly on the free balance, under the 1.5 % ceiling", () => {
    const p = vault(175_000_000_000n);
    expect(perTicketCap(p, 150n, SPEC)).toBe(1_312_500_000n);
    expect(perTicketCap(p, 300n, SPEC)).toBe(2_625_000_000n);
    expect(perTicketCap(p, 400n, SPEC)).toBe(2_625_000_000n);
    expect(perTicketCap(vault(175_000_000_000n, 87_500_000_000n), 150n, SPEC)).toBe(656_250_000n);
    expect(perTicketCap(p, 400n, SPEC, true)).toBe(1_312_500_000n);
    // the demo matrix's founding vault, 5 000 USDC at a 2.80 % vault margin: 70 USDC
    expect(perTicketCap(vault(5_000_000_000n), 280n, SPEC)).toBe(70_000_000n);
    expect(perTicketCap(vault(71_400_000_000n), 280n, SPEC)).toBe(999_600_000n);
  });

  it("keeps both identities when paying out", () => {
    expect(withdrawable(vault(1_000n, 200n, 100n), SPEC.kappaBps)).toBe(700n);
    expect(withdrawable(vault(1_000n, 700n), SPEC.kappaBps)).toBe(125n);
    expect(withdrawable(vault(100n, 90n, 20n), SPEC.kappaBps)).toBe(0n);
    expect(freeBalance(vault(100n, 90n, 20n))).toBe(0n);
  });

  it("never lets a payout break solvency or κ, over random vaults", () => {
    const r = rng(11);
    for (let i = 0; i < 3000; i++) {
      const v = vault(r.big(0n, 10n ** 13n), r.big(0n, 10n ** 12n), r.big(0n, 10n ** 11n));
      const kappa = r.big(1n, BPS);
      const w = withdrawable(v, kappa);
      expect(w >= 0n && w <= v.assets).toBe(true);
      if (w === 0n) continue;
      const after = v.assets - w;
      expect(v.reserved + v.openCredits <= after).toBe(true);
      expect(v.reserved * BPS <= after * kappa).toBe(true);
    }
  });

  it("names the vault that carries a liability, exactly, halved or not", () => {
    // 70 USDC of liability at 2.80 %: 5 000 USDC, the founding vault of the demo matrix
    expect(assetsNeededFor(70_000_000n, 280n, SPEC, vault(0n))).toBe(5_000_000_000n);
    // while the cap is halved, twice that
    expect(assetsNeededFor(70_000_000n, 280n, SPEC, vault(0n), true)).toBe(10_000_000_000n);
    const r = rng(12);
    for (let i = 0; i < 3000; i++) {
      const params = {
        ...SPEC,
        kellyFractionBps: r.big(1n, BPS),
        censorshipBps: r.big(1n, 1000n),
      };
      const v = vault(0n, r.big(0n, 10n ** 11n), r.big(0n, 10n ** 10n));
      const L = r.big(1n, 10n ** 10n);
      const vm = r.big(100n, 1000n);
      const halved = r.int(2) === 1;
      const need = assetsNeededFor(L, vm, params, v, halved);
      // enough, and not a micro-USDC more than needed
      expect(perTicketCap({ ...v, assets: need }, vm, params, halved)).toBeGreaterThanOrEqual(L);
      expect(perTicketCap({ ...v, assets: need - 1n }, vm, params, halved)).toBeLessThan(L);
    }
  });
});

describe("admission (open_ticket.rs order, risk.rs admit)", () => {
  const app = 50n;
  /** A 3.50 % payout table whose top multiplier is `m`. */
  const at350 = (m: bigint) => two(((BPS - 350n) * P_SCALE) / m, m);

  it("splits the ticket price as ticket_for does: both shares floored, off the price", () => {
    const q = quote({
      outcomes: at350(37_900n),
      price: 25_000_000n,
      appShareBps: app,
      params: SPEC,
      vault: vault(100_000_000_000n),
    });
    expect(q.vaultCredit).toBe(24_825_000n);
    expect(q.payoutMax).toBe(94_750_000n);
    expect(q.liability).toBe(69_925_000n);
    expect(q.marginBps).toBe(350n);
    expect(q.vaultMarginBps).toBe(280n);
    expect(q.refusal).toBeNull();
  });

  it("checks the split: app share bound, then the vault margin floor", () => {
    const base = { price: 25_000_000n, params: SPEC, vault: vault(100_000_000_000n) };
    const t = (margin: bigint) => two(((BPS - margin) * P_SCALE) / 20_000n, 20_000n);
    // check_split(350, 50) = 280, (170, 50) = 100, (169, 50) refused, (1000, 501) AppShare
    expect(quote({ ...base, outcomes: t(170n), appShareBps: 50n }).vaultMarginBps).toBe(100n);
    expect(quote({ ...base, outcomes: t(169n), appShareBps: 50n }).refusal).toBe("MarginFloor");
    expect(quote({ ...base, outcomes: t(60n), appShareBps: 50n }).refusal).toBe("MarginFloor");
    expect(quote({ ...base, outcomes: t(1000n), appShareBps: 501n }).refusal).toBe(
      "AppShareTooHigh",
    );
  });

  it("refuses in the program's order with the program's reasons", () => {
    const v = vault(100_000_000_000n);
    const q = (
      outcomes: Outcome[],
      price: bigint,
      over: Partial<Parameters<typeof quote>[0]> = {},
    ) => quote({ outcomes, price, appShareBps: 0n, params: SPEC, vault: v, ...over }).refusal;
    expect(q(at350(20_000n), 7_499_999n)).toBe("PriceBounds");
    expect(q(at350(20_000n), 10_000_000_001n)).toBe("PriceBounds");
    // 50 USDC at 19.8×: 990 USDC of payout, a cap of 1 500 USDC at 3.30 %: admitted
    expect(q(at350(198_000n), 50_000_000n)).toBeNull();
    // the same at 40×: 1 950 USDC of liability, above the cap
    expect(q(at350(400_000n), 50_000_000n)).toBe("PerTicketCap");
    // the ceiling per app is 20 % of the vault, this ticket included
    expect(q(at350(20_000n), 50_000_000n, { integratorReserved: 19_949_900_000n })).toBeNull();
    expect(q(at350(20_000n), 50_000_000n, { integratorReserved: 19_949_900_001n })).toBe(
      "IntegratorCap",
    );
    // a vault almost fully committed trips the breaker before κ
    const busy = vault(100_000_000_000n, 60_000_000_000n, 10_000_000_000n);
    expect(q(at350(20_000n), 25_000_000n, { vault: busy })).toBe("UtilisationBreaker");
    expect(q(two(P_SCALE / 2n, 30_000n), 25_000_000n)).toBe("PayoutTableOverpays");
  });

  it("admits exactly the prices max_admissible_price finds for the demo matrix", () => {
    // fade-math's matrix: 3.79× at a 2.80 % vault margin, 50 bps to the app, SPEC params
    const table = (m: bigint) => two(((BPS - 350n) * P_SCALE) / m, m);
    const admits = (price: bigint, assets: bigint, m: bigint, halved = false) =>
      quote({
        outcomes: table(m),
        price,
        appShareBps: app,
        params: SPEC,
        vault: vault(assets),
        halved,
      }).refusal;
    expect(admits(25_026_815n, 5_000_000_000n, 37_900n)).toBeNull();
    expect(admits(25_026_816n, 5_000_000_000n, 37_900n)).toBe("PerTicketCap");
    expect(admits(12_513_407n, 5_000_000_000n, 37_900n, true)).toBeNull();
    expect(admits(12_513_408n, 5_000_000_000n, 37_900n, true)).toBe("PerTicketCap");
    expect(admits(7_771_733n, 5_000_000_000n, 100_000n)).toBeNull();
    expect(admits(7_771_734n, 5_000_000_000n, 100_000n)).toBe("PerTicketCap");
    expect(admits(SPEC.minPrice, 5_000_000_000n, 100_000n, true)).toBe("PerTicketCap");
    expect(admits(38_858_665n, 25_000_000_000n, 100_000n)).toBeNull();
    expect(admits(38_858_666n, 25_000_000_000n, 100_000n)).toBe("PerTicketCap");
  });

  it("never admits a ticket that breaks an identity, over random vaults and tables", () => {
    const r = rng(13);
    for (let i = 0; i < 3000; i++) {
      const m = r.big(10_001n, 2_000_000n);
      const margin = r.big(130n, 900n);
      const price = r.big(DEVNET.minPrice, 100n * USDC);
      const v = vault(r.big(0n, 10n ** 12n), 0n, 0n);
      v.reserved = r.big(0n, v.assets);
      v.openCredits = r.big(0n, v.assets - v.reserved);
      const q = quote({
        outcomes: two(((BPS - margin) * P_SCALE) / m, m),
        price,
        appShareBps: r.big(0n, 30n),
        params: DEVNET,
        vault: v,
      });
      if (q.refusal !== null) continue;
      const after = {
        assets: v.assets + q.vaultCredit,
        reserved: v.reserved + q.liability,
        openCredits: v.openCredits + q.vaultCredit,
      };
      expect(q.liability).toBeLessThanOrEqual(q.cap!);
      expect(q.liability).toBe(q.payoutMax > q.vaultCredit ? q.payoutMax - q.vaultCredit : 0n);
      expect(q.payoutMax).toBe(payout(price, m));
      expect((after.reserved + after.openCredits) * BPS).toBeLessThanOrEqual(
        after.assets * DEVNET.utilisationBreakerBps,
      );
      expect(after.reserved * BPS).toBeLessThanOrEqual(after.assets * DEVNET.kappaBps);
      expect(q.vaultMarginBps! >= DEVNET.minVaultMarginBps).toBe(true);
    }
  });
});

describe("all or nothing", () => {
  it("pays at least the target and keeps the margin, to the unit", () => {
    const r = rng(14);
    for (let i = 0; i < 3000; i++) {
      const price = r.big(10_000n, 1_000n * USDC);
      const target = r.big(price * 2n, price * 5000n);
      const margin = r.big(100n, 1000n);
      const t = allOrNothing(price, target, margin);
      const s = summarize(t);
      if ("problem" in s) throw new Error(s.problem);
      expect(payout(price, t[0]!.m)).toBeGreaterThanOrEqual(target);
      // the smallest multiplier that reaches the target
      expect(payout(price, t[0]!.m - 1n)).toBeLessThan(target);
      expect(evOk(s.lhs, margin)).toBe(true);
      // and the largest probability that keeps it
      expect(evOk(s.lhs + t[0]!.m, margin)).toBe(false);
    }
  });
});
