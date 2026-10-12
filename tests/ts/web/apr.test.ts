// Every APR on screen: the vault's estimated APR (Home's vault card, the Vault header, the
// Dashboard), a position's own APR (money-weighted), and the deposit card's "projected per year".
// Known inputs give known outputs; empty days, capped reads, tiny and huge values, and losses
// never put NaN or Infinity on screen.
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { projectedPerYear } from "../../../apps/web/src/lib/actionQuote.ts";
import { BPS } from "../../../apps/web/src/lib/math.ts";
import { APR_MIN_SPAN_S, positionApr, type Flow } from "../../../apps/web/src/lib/positionPnl.ts";
import { APR_MIN_TICKETS, estimateApr, fmtApr } from "../../../apps/web/src/lib/ticketLog.ts";
import { DAY, T0, USDC, rng, ticketLog, ticketRow } from "./fixtures.ts";

const tickets = (n: number, over: Parameters<typeof ticketRow>[0] = {}) =>
  Array.from({ length: n }, (_, i) =>
    ticketRow({ ticket: `t${i}`.padEnd(32, "1") as Address, ...over }),
  );

describe("the vault's estimated APR", () => {
  it("annualises the vault margin of the last 24 h over the vault's assets", () => {
    // 100 tickets of 2 USDC at 3.5 %, 0.2 % protocol share: 3.30 % of 200 USDC = 6.60 USDC a day
    const apr = estimateApr(ticketLog(tickets(100, { price: 2n * USDC })), 10_000n * USDC, 20n, T0);
    expect(apr.tickets).toBe(100);
    expect(apr.volume).toBe(200n * USDC);
    expect(apr.margin).toBe(6_600_000n);
    // 6.60 × 365 / 10 000 = 24.09 %
    expect(apr.pct).toBeCloseTo(24.09, 10);
    expect(fmtApr(apr.pct!)).toBe("≈ 24%");
  });

  it("takes each ticket's vault margin: its margin less its app share and the protocol share", () => {
    const rows = [
      ...tickets(3, { marginBps: 350n, appShareBps: 0n }),
      ...tickets(2, { marginBps: 500n, appShareBps: 300n, price: 10n * USDC }),
    ];
    const apr = estimateApr(ticketLog(rows), 1_000n * USDC, 20n, T0);
    // 3 × 1 × 3.30 % + 2 × 10 × 1.80 %
    expect(apr.margin).toBe(99_000n + 360_000n);
    // a ticket whose shares exceed its margin adds nothing, never a negative
    const odd = estimateApr(ticketLog(tickets(5, { marginBps: 10n })), 1_000n * USDC, 20n, T0);
    expect(odd.margin).toBe(0n);
    expect(odd.pct).toBe(0);
  });

  it("rounds each ticket's margin down, as the program's shares are floored", () => {
    // 0.01 USDC at 3.30 %: 330 micro-USDC each
    const apr = estimateApr(ticketLog(tickets(7, { price: 10_000n })), USDC, 20n, T0);
    expect(apr.margin).toBe(7n * ((10_000n * 330n) / BPS));
  });

  it("counts only the last 24 h, and says nothing under five tickets or with no assets", () => {
    const rows = [
      ...tickets(4),
      ticketRow({ ticket: "old".padEnd(32, "1") as Address, openedAt: T0 - DAY - 1 }),
      ticketRow({ ticket: "unknown".padEnd(32, "1") as Address, openedAt: null }),
    ];
    const four = estimateApr(ticketLog(rows), 1_000n * USDC, 20n, T0);
    expect(four.tickets).toBe(4);
    expect(four.pct).toBeNull();
    expect(APR_MIN_TICKETS).toBe(5);
    expect(estimateApr(ticketLog(tickets(5)), 0n, 20n, T0).pct).toBeNull();
    const empty = estimateApr(ticketLog([]), 1_000n * USDC, 20n, T0);
    expect(empty).toEqual({ pct: null, tickets: 0, volume: 0n, margin: 0n });
    // exactly 24 h old still counts
    expect(estimateApr(ticketLog(tickets(5, { openedAt: T0 - DAY })), USDC, 20n, T0).tickets).toBe(
      5,
    );
  });

  it("scales a read capped inside the day up to a day, and never a read that reached it", () => {
    const rows = tickets(6);
    const six = estimateApr(
      ticketLog(rows, { truncated: true, from: T0 - 6 * 3600 }),
      1_000n * USDC,
      20n,
      T0,
    );
    expect(six.volume).toBe(24n * USDC);
    expect(six.margin).toBe(4n * 6n * 33_000n);
    // a capped read whose oldest transaction is older than a day covered the day: no scaling
    const full = estimateApr(
      ticketLog(rows, { truncated: true, from: T0 - 2 * DAY }),
      1_000n * USDC,
      20n,
      T0,
    );
    expect(full.volume).toBe(6n * USDC);
    // a read capped a few seconds ago is scaled over a minute at least, not to infinity
    const fresh = estimateApr(
      ticketLog(rows, { truncated: true, from: T0 - 1 }),
      1_000n * USDC,
      20n,
      T0,
    );
    expect(fresh.volume).toBe((6n * USDC * BigInt(DAY)) / 60n);
    expect(Number.isFinite(fresh.pct!)).toBe(true);
  });

  it("is a finite, non-negative percentage over random logs, and the same as its definition", () => {
    const r = rng(40);
    for (let i = 0; i < 1000; i++) {
      const rows = tickets(r.int(40), {});
      for (const row of rows) {
        row.price = r.big(1n, 10_000n * USDC);
        row.marginBps = r.big(0n, 1_000n);
        row.appShareBps = r.big(0n, 500n);
        row.openedAt = T0 - r.int(2 * DAY);
      }
      const assets = r.big(0n, 10n ** 13n);
      const apr = estimateApr(ticketLog(rows), assets, 20n, T0);
      const inDay = rows.filter((x) => x.openedAt! >= T0 - DAY);
      expect(apr.tickets).toBe(inDay.length);
      expect(apr.volume).toBe(inDay.reduce((s, x) => s + x.price, 0n));
      const margin = inDay.reduce((s, x) => {
        const vm = x.marginBps - x.appShareBps - 20n;
        return vm > 0n ? s + (x.price * vm) / BPS : s;
      }, 0n);
      expect(apr.margin).toBe(margin);
      expect(apr.margin).toBeLessThanOrEqual(apr.volume);
      if (apr.pct === null) {
        expect(apr.tickets < APR_MIN_TICKETS || assets === 0n).toBe(true);
        continue;
      }
      expect(Number.isFinite(apr.pct) && apr.pct >= 0).toBe(true);
      expect(apr.pct).toBeCloseTo((Number(margin) * 365 * 100) / Number(assets), 6);
      expect(fmtApr(apr.pct)).toMatch(/^≈ \d[\d.]*%$/);
    }
  });
});

describe("a position's own APR", () => {
  const dep = (t: number, usdc: bigint): Flow => ({
    kind: "deposit",
    t,
    assets: usdc * USDC,
    shares: usdc * 1_000_000_000n,
  });
  const wd = (t: number, usdc: bigint): Flow => ({
    kind: "withdraw",
    t,
    assets: usdc * USDC,
    shares: 1n,
  });

  it("annualises without compounding, money-weighted", () => {
    expect(positionApr([dep(T0, 1000n)], 1_100n * USDC, T0 + 365 * DAY).pct).toBeCloseTo(10, 9);
    // 1 % in 36.5 days is 10 % a year
    expect(positionApr([dep(T0, 1000n)], 1_010n * USDC, T0 + 36.5 * DAY).pct).toBeCloseTo(10, 9);
  });

  it("is negative for a loss, and shows as one", () => {
    const r = positionApr([dep(T0, 1000n)], 900n * USDC, T0 + 365 * DAY);
    expect(r.pct).toBeCloseTo(-10, 9);
    expect(fmtApr(r.pct!)).toBe("≈ −10%");
    // everything lost in a year: −100 %
    expect(positionApr([dep(T0, 1000n)], 0n, T0 + 365 * DAY).pct).toBeCloseTo(-100, 9);
  });

  it("says nothing for a position younger than a day or with no capital at work", () => {
    expect(positionApr([], 0n, T0).pct).toBeNull();
    expect(positionApr([dep(T0, 1000n)], 1_000n * USDC, T0 + APR_MIN_SPAN_S - 1).pct).toBeNull();
    expect(positionApr([dep(T0, 1000n)], 1_000n * USDC, T0 + APR_MIN_SPAN_S).pct).toBe(0);
    // everything taken out at once: no capital was ever at work over the period
    expect(positionApr([dep(T0, 100n), wd(T0, 100n)], 0n, T0 + 10 * DAY).pct).toBeNull();
  });

  it("stays finite over random histories, and equals modified Dietz", () => {
    const r = rng(41);
    for (let i = 0; i < 2000; i++) {
      const flows: Flow[] = [dep(T0, r.big(1n, 1_000_000n))];
      for (let k = r.int(6); k > 0; k--) {
        const t = T0 + r.int(400 * DAY);
        flows.push(r.int(2) ? dep(t, r.big(1n, 1_000_000n)) : wd(t, r.big(1n, 1_000_000n)));
      }
      const now = T0 + Math.max(...flows.map((f) => f.t)) - T0 + r.int(30 * DAY);
      const value = r.big(0n, 10n ** 13n);
      const apr = positionApr(flows, value, now);
      const span = now - T0;
      if (span < APR_MIN_SPAN_S) {
        expect(apr.pct).toBeNull();
        continue;
      }
      let weighted = 0;
      let net = 0;
      for (const f of flows) {
        const v = Number(f.assets) * (f.kind === "deposit" ? 1 : -1);
        weighted += (v * (now - f.t)) / span;
        net += v;
      }
      if (weighted <= 0) {
        expect(apr.pct).toBeNull();
        continue;
      }
      expect(Number.isFinite(apr.pct!)).toBe(true);
      const expected = ((Number(value) - net) / weighted) * ((365 * DAY) / span) * 100;
      expect(apr.pct!).toBeCloseTo(expected, 6);
      expect(fmtApr(apr.pct!)).not.toContain("NaN");
    }
  });
});

describe("projected per year, on the deposit card", () => {
  it("is the deposit at the estimated APR, rounded down", () => {
    expect(projectedPerYear(1_000n * USDC, 22)).toBe(220n * USDC);
    expect(projectedPerYear(1_000n * USDC, 3.456)).toBe(34_600_000n);
    expect(projectedPerYear(1n, 22)).toBe(0n);
    expect(projectedPerYear(10n ** 15n, 0.01)).toBe(10n ** 11n);
  });

  it("is not shown without an APR or an amount, and never from a number that is not one", () => {
    expect(projectedPerYear(null, 22)).toBeNull();
    expect(projectedPerYear(0n, 22)).toBeNull();
    expect(projectedPerYear(USDC, null)).toBeNull();
    expect(projectedPerYear(USDC, Number.NaN)).toBeNull();
    expect(projectedPerYear(USDC, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("agrees with the APR shown, over random deposits", () => {
    const r = rng(42);
    for (let i = 0; i < 2000; i++) {
      const amount = r.big(1n, 10n ** 13n);
      const apr = r.next() * 200;
      const y = projectedPerYear(amount, apr)!;
      // to the APR's hundredth of a percent, rounded down
      expect(y).toBe((amount * BigInt(Math.round(apr * 100))) / 10_000n);
      expect(Number(y)).toBeLessThanOrEqual((Number(amount) * (apr + 0.005)) / 100 + 1);
    }
  });
});
