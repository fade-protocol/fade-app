// How every figure is written: thousands separators, decimals truncated toward zero, the minus
// sign (U+2212, never a hyphen), no "−0.00", odds and percentages, and amounts typed in.
import { describe, expect, it } from "vitest";
import {
  MINUS,
  bps,
  chance,
  clock,
  duration,
  fixed,
  fv,
  mult,
  odds,
  oneIn,
  parseUsdc,
  shares,
  signedAmount,
  signedPct,
  sol,
  usdc,
  usdcTidy,
} from "../../../apps/web/src/lib/format.ts";
import { fmtApr } from "../../../apps/web/src/lib/ticketLog.ts";
import { rng, SHARE, USDC } from "./fixtures.ts";

describe("fixed and usdc", () => {
  it("writes thousands separators and two decimals", () => {
    expect(usdc(0n)).toBe("0.00");
    expect(usdc(1n)).toBe("0.00");
    expect(usdc(10_000n)).toBe("0.01");
    expect(usdc(1_234_567_890n)).toBe("1,234.56");
    expect(usdc(1_000_000_000_000n)).toBe("1,000,000.00");
    expect(usdc(123_456_789n, 0)).toBe("123");
    expect(usdc(123_456_789n, 6)).toBe("123.456789");
    expect(usdc(5n, 6)).toBe("0.000005");
  });

  it("truncates toward zero: never shows more than there is", () => {
    expect(usdc(1_999_999n)).toBe("1.99");
    expect(usdc(-1_999_999n)).toBe(`${MINUS}1.99`);
    expect(usdc(999_999n, 0)).toBe("0");
  });

  it("writes huge values whole, without a float on the way", () => {
    // u64::MAX micro-USDC
    expect(usdc(18_446_744_073_709_551_615n)).toBe("18,446,744,073,709.55");
    expect(shares(18_446_744_073_709_551_615n, 9)).toBe("18,446,744,073.709551615");
  });

  it("signs a loss with U+2212, and never writes −0.00", () => {
    expect(usdc(-2_500_000n)).toBe(`${MINUS}2.50`);
    expect(usdc(-2_500_000n)).not.toContain("-");
    expect(usdc(-1n)).toBe("0.00");
    expect(usdc(-9_999n)).toBe("0.00");
    expect(usdc(-10_000n)).toBe(`${MINUS}0.01`);
    expect(fixed(-5n, 0, 0)).toBe(`${MINUS}5`);
    expect(fixed(-1n, 2, 0)).toBe("0");
  });

  it("formats the other units with their own decimals", () => {
    expect(shares(1_234_567_890_123n)).toBe("1,234.56");
    expect(fv(5n * SHARE)).toBe("5.00 fvUSDC");
    expect(sol(1_234_567_890n)).toBe("1.2345");
    expect(sol(10_000n, 5)).toBe("0.00001");
    expect(bps(350n)).toBe("3.50 %");
    expect(bps(7000n, 0)).toBe("70 %");
    expect(bps(10_000n)).toBe("100.00 %");
    expect(usdcTidy(15_000n * USDC)).toBe("15,000");
    expect(usdcTidy(2_500_000n)).toBe("2.50");
  });

  it("never prints a minus sign as a hyphen or a stray sign on zero, over random values", () => {
    const r = rng(1);
    for (let i = 0; i < 2000; i++) {
      const v = r.big(0n, 10n ** 15n) * (r.int(2) ? -1n : 1n);
      const s = usdc(v, r.int(7));
      expect(s).not.toContain("-");
      if (!/[1-9]/.test(s)) expect(s.startsWith(MINUS)).toBe(false);
      // the digits read back to the value, truncated
      const digits = s.replace(MINUS, "").replace(/,/g, "");
      const [w, f = ""] = digits.split(".");
      const back = BigInt(w!) * USDC + BigInt(f.padEnd(6, "0") || "0");
      const abs = v < 0n ? -v : v;
      expect(back <= abs && abs - back < 10n ** BigInt(6 - f.length)).toBe(true);
    }
  });
});

describe("signed figures", () => {
  it("signs gains and losses, and leaves a figure that shows as zero unsigned", () => {
    expect(signedAmount(1_500_000n)).toBe("+1.50");
    expect(signedAmount(-1_500_000n)).toBe(`${MINUS}1.50`);
    expect(signedAmount(0n)).toBe("0.00");
    expect(signedAmount(-1n)).toBe("0.00");
    expect(signedAmount(9_999n)).toBe("0.00");
    expect(signedAmount(-15_000n * USDC, usdcTidy)).toBe(`${MINUS}15,000`);
    expect(signedAmount(2_500_000n, usdcTidy)).toBe("+2.50");
  });

  it("signs percentages, and refuses to show a number that is not one", () => {
    expect(signedPct(1.25, 3)).toBe("+1.250 %");
    expect(signedPct(-0.4, 2, "%")).toBe(`${MINUS}0.40%`);
    expect(signedPct(-0.0001, 3)).toBe("0.000 %");
    expect(signedPct(0, 1, "%")).toBe("0.0%");
    expect(signedPct(Number.NaN)).toBe("–");
    expect(signedPct(Number.POSITIVE_INFINITY)).toBe("–");
  });

  it("writes an APR with decimals that follow its size, losses included", () => {
    expect(fmtApr(22.4)).toBe("≈ 22%");
    expect(fmtApr(3.44)).toBe("≈ 3.4%");
    expect(fmtApr(0.083)).toBe("≈ 0.08%");
    expect(fmtApr(-15.2)).toBe(`≈ ${MINUS}15%`);
    expect(fmtApr(-2.25)).toBe(`≈ ${MINUS}2.3%`);
    expect(fmtApr(-0.001)).toBe("≈ 0.00%");
    expect(fmtApr(0)).toBe("≈ 0.00%");
    expect(fmtApr(Number.NaN)).toBe("–");
    expect(fmtApr(Number.NEGATIVE_INFINITY)).toBe("–");
  });
});

describe("odds", () => {
  it("writes a probability out of 10⁹ as a percentage, truncated", () => {
    expect(chance(38_900_000n)).toBe("3.89 %");
    expect(chance(965_000n, 3)).toBe("0.096 %");
    expect(chance(1_000_000_000n)).toBe("100.00 %");
  });

  it("writes it as 1 in N, rounded up: to a tenth under ten, whole above", () => {
    expect(oneIn(0n)).toBe("never");
    expect(oneIn(1_000_000_000n)).toBe("almost always");
    expect(oneIn(500_000_000n)).toBe("about 1 in 2.0");
    expect(oneIn(10_000_000n)).toBe("about 1 in 100");
    expect(oneIn(965_000n)).toBe("about 1 in 1,037");
    expect(odds(965_000n)).toEqual({ oneIn: "1 in 1,037", pct: "0.096 %" });
    expect(odds(38_900_000n)).toEqual({ oneIn: "1 in 26", pct: "3.89 %" });
    // rounded up, never better than the truth: 1 in 6.667 reads 6.7, 1 in 1,036.27 reads 1,037
    expect(odds(150_000_000n)).toEqual({ oneIn: "1 in 6.7", pct: "15.00 %" });
    expect(oneIn(960_000_000n)).toBe("almost always");
    expect(oneIn(950_000_000n)).toBe("about 1 in 1.1");
  });

  it("keeps 1 in N and the percentage telling the same odds", () => {
    const r = rng(2);
    for (let i = 0; i < 2000; i++) {
      const p = r.big(1n, 1_000_000_000n);
      const o = odds(p);
      const n = /1 in ([\d,.]+)/.exec(o.oneIn);
      const pct = Number(o.pct.replace(" %", ""));
      if (!n) continue; // "almost always"
      const one = Number(n[1]!.replace(/,/g, ""));
      // 1 in N never reads better than p (N at or above the truth) and is less than one step
      // above it; the percentage is p truncated to its digits
      const exact = 1e9 / Number(p);
      const step = exact >= 10 ? 1 : 0.1;
      expect(one).toBeGreaterThanOrEqual(exact - 1e-6);
      expect(one - exact).toBeLessThan(step + 1e-6);
      expect(pct).toBeLessThanOrEqual((Number(p) / 1e9) * 100 + 1e-12);
    }
  });

  it("writes a multiplier in basis points without trailing zeros", () => {
    expect(mult(24_790n)).toBe("2.479×");
    expect(mult(10_000n)).toBe("1×");
    expect(mult(5_000_000n)).toBe("500×");
    expect(mult(0n)).toBe("0×");
  });
});

describe("amounts typed in, and times", () => {
  it("reads a plain decimal exactly, up to six places", () => {
    expect(parseUsdc("12.5")).toBe(12_500_000n);
    expect(parseUsdc(" 0.000001 ")).toBe(1n);
    expect(parseUsdc("1000")).toBe(1000n * USDC);
    expect(parseUsdc("1.")).toBe(USDC);
    expect(parseUsdc("1.2345678")).toBeNull();
    expect(parseUsdc("-1")).toBeNull();
    expect(parseUsdc("1,000")).toBeNull();
    expect(parseUsdc("")).toBeNull();
  });

  it("round-trips every amount it writes with six decimals", () => {
    const r = rng(3);
    for (let i = 0; i < 1000; i++) {
      const v = r.big(0n, 10n ** 16n);
      expect(parseUsdc(usdc(v, 6).replace(/,/g, ""))).toBe(v);
    }
  });

  it("writes countdowns and durations", () => {
    expect(clock(84)).toBe("1:24");
    expect(clock(3725)).toBe("1:02:05");
    expect(clock(-5)).toBe("0:00");
    expect(duration(0)).toBe("0 s");
    expect(duration(125)).toBe("2 min 05 s");
  });
});
