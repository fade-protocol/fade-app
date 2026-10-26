// The vault page's figures: the header (total deposits, available now, utilisation), the Risk tab
// (the drawdown breaker, the cap per payout and its table, each app's share of the cap), the
// Performance tab (each close's move, its average and spread), the Overview chart, and the
// Activity tab's four figures, which must add up from the rows listed under them.
import type { Address, Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { LpItem } from "../../../apps/web/src/lib/history.ts";
import { sharePrice } from "../../../apps/web/src/lib/history.ts";
import {
  BPS,
  M_CEILING_BPS,
  P_SCALE,
  payout,
  perTicketCap,
  quote,
  withdrawable,
} from "../../../apps/web/src/lib/math.ts";
import { DEMO_MARGIN_BPS } from "../../../apps/web/src/lib/payoutTables.ts";
import type { TicketEnd, TicketRow } from "../../../apps/web/src/lib/ticketLog.ts";
import { APR_LABEL, estimateApr, fmtApr, statsByApp } from "../../../apps/web/src/lib/ticketLog.ts";
import { vaultLine } from "../../../apps/web/src/lib/ticketWords.ts";
import {
  activityFigures,
  appRisk,
  availableNow,
  bucketFor,
  CHART_SERIES,
  capTable,
  changePct,
  chartView,
  closeMoves,
  committedOf,
  drawdownOf,
  fromCut,
  isHalved,
  liabilityOf,
  moveStats,
  utilisationBps,
  windowStart,
  type StrikePoint,
} from "../../../apps/web/src/lib/vaultFigures.ts";
import {
  A,
  DAY,
  DEVNET,
  SHARE,
  SPEC,
  T0,
  USDC,
  live,
  rng,
  ticketLog,
  ticketRow,
} from "./fixtures.ts";

describe("the header", () => {
  it("lets the next close pay out what the strike would, the live deposits joined", () => {
    const s = live({
      assets: 1_000n * USDC,
      reserved: 700n * USDC,
      current: { live: true, deposits: 100n * USDC },
    });
    // strike.rs: withdrawable on assets + the epoch's deposits; κ needs ceil(700 / 0.8) = 875
    expect(availableNow(s)).toBe(225n * USDC);
    expect(availableNow(live({ assets: 1_000n * USDC, reserved: 700n * USDC }))).toBe(125n * USDC);
    // a closed epoch's deposits do not count
    const idle = live({ assets: 1_000n * USDC, current: { live: false, deposits: 100n * USDC } });
    expect(availableNow(idle)).toBe(1_000n * USDC);
  });

  it("reads utilisation as committed over assets, rounded down", () => {
    const s = live({ assets: 3_000n * USDC, reserved: 500n * USDC, openCredits: 500n * USDC });
    expect(committedOf(s.vault)).toBe(1_000n * USDC);
    expect(utilisationBps(s.vault)).toBe(3_333n);
    expect(utilisationBps(live().vault)).toBe(0n);
  });

  it("never shows more available than the vault holds, nor a utilisation off its definition", () => {
    const r = rng(50);
    for (let i = 0; i < 3000; i++) {
      const assets = r.big(0n, 10n ** 13n);
      const reserved = r.big(0n, assets);
      const openCredits = r.big(0n, assets - reserved);
      const deposits = r.big(0n, 10n ** 11n);
      const s = live({ assets, reserved, openCredits, current: { live: true, deposits } });
      const out = availableNow(s);
      expect(out).toBeLessThanOrEqual(assets + deposits);
      expect(out).toBe(
        withdrawable({ assets: assets + deposits, reserved, openCredits }, SPEC.kappaBps),
      );
      const u = utilisationBps(s.vault);
      expect(u).toBeLessThanOrEqual(BPS);
      if (assets > 0n) expect(u).toBe(((reserved + openCredits) * BPS) / assets);
    }
  });
});

describe("the drawdown breaker", () => {
  const PRICE = 10n ** 18n;
  const price = (a: bigint, s: bigint) => ((a + 1n) * PRICE) / (s + 1_000n);

  it("compares today's settled price with the last 24 hours' highest, as the program does", () => {
    const hour = BigInt(Math.floor(T0 / 3600));
    const maxima = new Array<bigint>(24).fill(0n);
    // an hour ago the price was 1.00; today the vault is down 10 %
    maxima[Number((hour - 1n) % 24n)] = price(1_000n * USDC, 1_000n * SHARE);
    const s = live({
      assets: 900n * USDC,
      shares: 1_000n * SHARE,
      priceMaxima: maxima,
      priceHeadHour: hour,
    });
    const dd = drawdownOf(s, T0);
    expect(dd.fallBps).toBe(999n); // 10 %, rounded down
    expect(dd.tripped).toBe(false);
    // down 15 % of assets is a hair less than 15 % of the price with the virtual offsets
    // ((850 + 10⁻⁶) / (1 000 + 10⁻⁶)): the program does not trip yet; one USDC more down, it does
    const at15 = live({
      assets: 850n * USDC,
      shares: 1_000n * SHARE,
      priceMaxima: maxima,
      priceHeadHour: hour,
    });
    expect(drawdownOf(at15, T0).tripped).toBe(false);
    const past = live({
      assets: 849n * USDC,
      shares: 1_000n * SHARE,
      priceMaxima: maxima,
      priceHeadHour: hour,
    });
    expect(drawdownOf(past, T0).tripped).toBe(true);
    expect(drawdownOf(past, T0).fallBps).toBe(1509n);
    // a day later that maximum has left the ring
    expect(drawdownOf(past, T0 + DAY).fallBps).toBe(0n);
    expect(drawdownOf(past, T0 + DAY).tripped).toBe(false);
  });

  it("measures the settled assets: open tickets' credits do not count as a gain", () => {
    const hour = BigInt(Math.floor(T0 / 3600));
    const maxima = new Array<bigint>(24).fill(0n);
    maxima[Number(hour % 24n)] = price(1_000n * USDC, 1_000n * SHARE);
    const s = live({
      assets: 1_100n * USDC,
      openCredits: 100n * USDC,
      shares: 1_000n * SHARE,
      priceMaxima: maxima,
      priceHeadHour: hour,
    });
    expect(drawdownOf(s, T0)).toEqual({ fallBps: 0n, limit: 1500n, tripped: false });
  });

  it("halves the caps for 48 h after a trip", () => {
    expect(isHalved(live({ drawdownTripTs: 0n }))).toBe(false);
    expect(isHalved(live({ drawdownTripTs: BigInt(T0) - 48n * 3600n + 1n }))).toBe(true);
    expect(isHalved(live({ drawdownTripTs: BigInt(T0) - 48n * 3600n }))).toBe(false);
  });
});

describe("the cap per payout", () => {
  it("is the program's cap at the demos' vault margin, with a table the program agrees with", () => {
    const s = live({ assets: 20_000n * USDC });
    const t = capTable(s);
    // 3.50 % less the 0.20 % protocol share: 3.30 %
    expect(t.demoMargin).toBe(330n);
    // min(0.5 × 3.30 % × 20 000, 1.5 % × 20 000) = min(330, 300)
    expect(t.demoCap).toBe(300n * USDC);
    expect(t.rows.map((r) => r.margin)).toEqual([100n, 150n, 330n]);
    expect(t.rows.map((r) => r.cap)).toEqual([100n * USDC, 150n * USDC, 300n * USDC]);
    expect(t.appCeiling).toBe(4_000n * USDC);
    // at the 0.10 USDC minimum price: (cap + 0.0998 credit) / 0.10, to 0.01×
    expect(t.rows[0]!.maxM).toBe(10_009_900n);
    for (const row of t.rows) {
      // a ticket at the minimum price and that multiplier fits the cap; 0.01× more does not
      expect(liabilityOf(t.price, row.maxM, t.credit)).toBeLessThanOrEqual(row.cap);
      if (row.maxM < M_CEILING_BPS)
        expect(liabilityOf(t.price, row.maxM + 100n, t.credit)).toBeGreaterThan(row.cap);
    }
  });

  it("never offers a multiplier above the program's ceiling", () => {
    // a 10 M USDC vault caps a payout at 150 000 USDC: 1.5 M× on 0.10 USDC, but 10 000× is the most
    const t = capTable(live({ assets: 10_000_000n * USDC }));
    for (const row of t.rows) expect(row.maxM).toBeLessThanOrEqual(M_CEILING_BPS);
    expect(t.rows.at(-1)!.maxM).toBe(M_CEILING_BPS);
  });

  it("halves with the program after a drawdown", () => {
    const s = live({ assets: 20_000n * USDC, drawdownTripTs: BigInt(T0) - 3600n });
    const t = capTable(s);
    expect(t.halved).toBe(true);
    expect(t.demoCap).toBe(150n * USDC);
  });

  it("admits a demo ticket at the cap and refuses one past it, over random vaults", () => {
    const r = rng(51);
    for (let i = 0; i < 500; i++) {
      const s = live({ assets: r.big(1_000n * USDC, 10n ** 12n) });
      const t = capTable(s);
      const vault = { assets: s.vault.totalAssets, reserved: 0n, openCredits: 0n };
      expect(t.demoCap).toBe(perTicketCap(vault, t.demoMargin, DEVNET));
      // a win-back table at the demos' margin whose liability is the cap is admitted by the cap
      const price = 100_000n;
      const m = ((t.demoCap + t.credit) * BPS) / price;
      if (m > M_CEILING_BPS) continue;
      const q = quote({
        outcomes: [
          { p: ((BPS - DEMO_MARGIN_BPS) * P_SCALE) / m, m },
          { p: P_SCALE - ((BPS - DEMO_MARGIN_BPS) * P_SCALE) / m, m: 0n },
        ],
        price,
        appShareBps: 0n,
        params: DEVNET,
        vault,
      });
      expect(q.cap).toBe(t.demoCap);
      expect(q.refusal === "PerTicketCap").toBe(false);
      expect(payout(price, m) - q.vaultCredit).toBeLessThanOrEqual(t.demoCap);
    }
  });
});

describe("each app's share of the cap per app", () => {
  it("is its open liability over the vault, and over the 20 % per app, capped at 100", () => {
    expect(appRisk(1_000n * USDC, 100_000n * USDC, 2000n)).toEqual({ risk: 100n, fill: 5 });
    expect(appRisk(20_000n * USDC, 100_000n * USDC, 2000n)).toEqual({ risk: 2000n, fill: 100 });
    expect(appRisk(30_000n * USDC, 100_000n * USDC, 2000n).fill).toBe(100);
    expect(appRisk(USDC, 0n, 2000n)).toEqual({ risk: 0n, fill: 0 });
    expect(appRisk(USDC, USDC, 0n).fill).toBe(0);
  });
});

describe("the Performance tab", () => {
  const pt = (t: number, price: bigint, epochId: bigint | null): StrikePoint => ({
    t,
    price,
    assets: 0n,
    epochId,
  });
  const series = [
    pt(T0, 1_000_000n, 1n),
    pt(T0 + DAY, 1_010_000n, 2n),
    pt(T0 + 2 * DAY, 999_900n, 3n),
    pt(T0 + 3 * DAY, 1_020_000n, null),
  ];

  it("moves close by close, with the average and the spread of those moves", () => {
    const moves = closeMoves(series);
    expect(moves.map((m) => m.epoch)).toEqual([2n, 3n]);
    expect(moves[0]!.pct).toBeCloseTo(1, 12);
    expect(moves[1]!.pct).toBeCloseTo(-1, 12);
    const { mean, sd } = moveStats(moves);
    expect(mean).toBeCloseTo(0, 12);
    expect(sd).toBeCloseTo(1, 12);
    expect(moveStats([])).toEqual({ mean: 0, sd: 0 });
  });

  it("changes over the range from the price in force at its start to today's", () => {
    const cut = fromCut(series, T0 + DAY / 2);
    expect(cut[0]).toEqual({ ...series[0], t: T0 + DAY / 2, carried: true });
    // the first close inside the range moved the price from the one in force at its start
    expect(closeMoves(cut).map((m) => m.epoch)).toEqual([2n, 3n]);
    // a carried point never counts as a move of its own
    expect(
      closeMoves([
        { ...series[0]!, carried: true },
        { ...series[1]!, carried: true },
      ]),
    ).toEqual([]);
    expect(changePct(cut)).toBeCloseTo(2, 12);
    expect(changePct([])).toBeNull();
    expect(changePct([pt(T0, 0n, 1n), pt(T0 + 1, 5n, 2n)])).toBeNull();
  });

  it("compounds its moves into the change over the range, over random series", () => {
    const r = rng(52);
    for (let i = 0; i < 500; i++) {
      const n = 2 + r.int(30);
      let p = r.big(500_000n, 2_000_000n);
      const s: StrikePoint[] = [];
      for (let k = 0; k < n; k++) {
        s.push(pt(T0 + k * 120, p, BigInt(k + 1)));
        p = p + r.big(0n, 20_000n) - 10_000n;
      }
      const moves = closeMoves(s);
      const compounded = moves.reduce((g, m) => g * (1 + m.pct / 100), 1);
      expect((compounded - 1) * 100).toBeCloseTo(changePct(s)!, 6);
      const { mean, sd } = moveStats(moves);
      expect(Number.isFinite(mean) && Number.isFinite(sd) && sd >= 0).toBe(true);
      expect(mean).toBeLessThanOrEqual(Math.max(...moves.map((m) => m.pct)) + 1e-12);
      expect(mean).toBeGreaterThanOrEqual(Math.min(...moves.map((m) => m.pct)) - 1e-12);
    }
  });
});

describe("the Overview chart", () => {
  const strikes = [
    { t: T0 - 10 * DAY, price: 1_000_000n, assets: 1_000n * USDC, epochId: 1n },
    { t: T0 - 2 * DAY, price: 1_010_000n, assets: 1_500n * USDC, epochId: 2n },
    {
      t: T0,
      price: sharePrice(2_040n * USDC, 2_000n * SHARE)!,
      assets: 2_040n * USDC,
      epochId: null,
    },
  ];

  it("ends on today's figures: the share price and the assets the header shows", () => {
    const price = chartView("price", "7D", strikes, null, T0)!;
    expect(price.headline).toBe(Number(strikes[2]!.price) / 1e6);
    expect(price.points.at(-1)).toEqual({ t: T0, v: Number(strikes[2]!.price) / 1e6 });
    // over the week, from the price in force a week ago
    expect(price.from).toBe(T0 - 7 * DAY);
    expect(price.change).toBeCloseTo(
      ((Number(strikes[2]!.price) - 1_000_000) / 1_000_000) * 100,
      9,
    );
    const deposits = chartView("deposits", "1D", strikes, null, T0)!;
    expect(deposits.headline).toBe(2_040);
    expect(deposits.change).toBeCloseTo(((2_040 - 1_500) / 1_500) * 100, 9);
    expect(chartView("price", "ALL", [], null, T0)).toBeNull();
  });

  it("totals the ticket volume of the window, bucket by bucket", () => {
    const log = ticketLog([
      ticketRow({ openedAt: T0 - 60, price: 2n * USDC }),
      ticketRow({ openedAt: T0 - 3 * 3600, price: 3n * USDC }),
      ticketRow({ openedAt: T0 - 2 * DAY, price: 50n * USDC }),
    ]);
    const day = chartView("volume", "1D", null, log, T0)!;
    expect(day.headline).toBe(5);
    expect(day.points.reduce((s, p) => s + (p.v ?? 0), 0)).toBe(5);
    expect(chartView("volume", "7D", null, log, T0)!.headline).toBe(55);
    expect(bucketFor(DAY)).toBe(3600);
    expect(bucketFor(7 * DAY)).toBe(6 * 3600);
    expect(bucketFor(40 * DAY)).toBe(DAY);
    expect(windowStart("ALL", T0 - 60, T0)).toBe(T0 - 3600);
    expect(windowStart("7D", T0 - 3 * DAY, T0)).toBe(T0 - 3 * DAY);
  });

  it("shows the APR first, and on arrival", () => {
    expect(CHART_SERIES.map((x) => x.id)).toEqual(["apr", "price", "deposits", "volume"]);
    expect(CHART_SERIES.map((x) => x.label)).toEqual([
      "APR",
      "Share price",
      "Deposits",
      "Ticket volume",
    ]);
    expect(APR_LABEL).toBe("APR");
  });

  it("charts the APR over 7 days trailing, ending on the headline's figure", () => {
    // 6 tickets an hour over the last 10 days, the read complete back to 14 days
    const rows = Array.from({ length: 6 * 240 }, (_, i) =>
      ticketRow({
        ticket: A(`t${i}`),
        openedAt: T0 - 600 * i - 30,
        marginBps: 300n + BigInt(i % 7),
      }),
    );
    const log = ticketLog(rows, { since: T0 - 14 * DAY, from: T0 - 14 * DAY });
    const inputs = { totalAssets: 2_100n * USDC, protocolShareBps: 20n };
    const view = chartView("apr", "7D", strikes, log, T0, inputs)!;
    expect(view.unit).toBe("last 7 days, annualised");
    const headline = estimateApr(log, inputs.totalAssets, inputs.protocolShareBps, T0).pct!;
    expect(view.points.at(-1)).toEqual({ t: T0, v: headline });
    expect(view.headline).toBe(headline);
    expect(fmtApr(view.headline!)).toMatch(/^≈ \d/);
    // the whole week, one point per bucket, then now: no gap anywhere
    expect(view.from).toBe(T0 - 7 * DAY);
    const bucket = bucketFor(T0 - view.from);
    expect(view.points[1]!.t - view.points[0]!.t).toBe(bucket);
    expect(view.points.every((p) => p.v !== null && p.v > 0)).toBe(true);
    // each point reads its own 7 days, over the assets of the close before it
    const first = view.points[0]!;
    const upTo = ticketLog(rows.filter((r) => r.openedAt! <= first.t));
    expect(first.v).toBe(estimateApr(upTo, 1_000n * USDC, 20n, first.t).pct);
    const late = view.points.at(-2)!;
    const lateLog = ticketLog(rows.filter((r) => r.openedAt! <= late.t));
    expect(late.v).toBe(estimateApr(lateLog, 1_500n * USDC, 20n, late.t).pct);
    // the change is in percentage points, from the first point
    expect(view.change).toBeCloseTo(headline - first.v!, 9);
    // the longer ranges start at the first point whose 7 days the read lists in full
    for (const range of ["1M", "ALL"] as const) {
      const long = chartView("apr", range, strikes, log, T0, inputs)!;
      expect(long.from).toBe(T0 - 7 * DAY);
      expect(long.points[0]!.v).not.toBeNull();
    }
    // without the tickets or the live figures there is nothing to chart
    expect(chartView("apr", "7D", strikes, null, T0, inputs)).toBeNull();
    expect(chartView("apr", "7D", strikes, log, T0)).toBeNull();
    // a read capped inside the last 7 days: every point is a gap, no change to show
    const capped = ticketLog(rows.slice(0, 60), { truncated: true, from: T0 - 6 * 3600 });
    const gaps = chartView("apr", "1D", strikes, capped, T0, inputs)!;
    expect(gaps.points.every((p) => p.v === null)).toBe(true);
    expect(gaps.headline).toBeNull();
    expect(gaps.change).toBeNull();
  });

  it("starts a young vault's APR at its first ticket, a gap only until five are in the week", () => {
    // 6 tickets an hour over the last 3 days of a program that has no older ones
    const rows = Array.from({ length: 6 * 72 }, (_, i) =>
      ticketRow({ ticket: A(`t${i}`), openedAt: T0 - 600 * i - 30 }),
    );
    const log = ticketLog(rows, { since: T0 - 14 * DAY });
    const inputs = { totalAssets: 2_100n * USDC, protocolShareBps: 20n };
    const view = chartView("apr", "7D", strikes, log, T0, inputs)!;
    expect(view.from).toBe(rows.at(-1)!.openedAt!);
    // one ticket in the first window: a gap; every later point has its five
    expect(view.points[0]!.v).toBeNull();
    expect(view.points.slice(1).every((p) => p.v !== null)).toBe(true);
  });
});

describe("the Activity tab", () => {
  const A = (s: string) => s.padEnd(32, "1") as Address;
  const end = (
    payout: bigint,
    at: number | null,
    kind: TicketEnd["kind"] = "settled",
  ): TicketEnd => ({
    kind,
    payout,
    pending: false,
    at,
    signature: "e" as Signature,
  });
  const strike = (t: number, deposits: bigint, assetsPaid: bigint): LpItem => ({
    signature: `s${t}` as Signature,
    blockTime: t,
    events: [{ kind: "EpochStruck", data: { deposits, assetsPaid } } as never],
  });

  it("counts the last 24 h: tickets opened, paid to winners, the vault's result, net deposits", () => {
    const rows: TicketRow[] = [
      ticketRow({ ticket: A("a"), vaultCredit: 998_000n, end: end(0n, T0 - 30) }),
      ticketRow({ ticket: A("b"), vaultCredit: 998_000n, end: end(5n * USDC, T0 - 20) }),
      ticketRow({ ticket: A("c"), vaultCredit: 998_000n, end: end(0n, T0 - 10, "expired") }),
      ticketRow({ ticket: A("d"), vaultCredit: 998_000n }),
      // opened two days ago, settled yesterday: an old ticket, today's result
      ticketRow({
        ticket: A("e"),
        openedAt: T0 - 2 * DAY,
        vaultCredit: 998_000n,
        end: end(2n * USDC, T0 - DAY + 1),
      }),
      ticketRow({
        ticket: A("f"),
        openedAt: T0 - 3 * DAY,
        vaultCredit: 998_000n,
        end: end(0n, T0 - 2 * DAY),
      }),
    ];
    const f = activityFigures(
      ticketLog(rows),
      [strike(T0 - 100, 50n * USDC, 20n * USDC), strike(T0 - 2 * DAY, 999n * USDC, 0n)],
      T0,
    );
    expect(f.n).toBe(4);
    expect(f.paid).toBe(7n * USDC);
    expect(f.result).toBe(4n * 998_000n - 7n * USDC);
    expect(f.net).toBe(30n * USDC);
    expect(f.span).toBe("24 h");
  });

  it("pays no winner for a direct ticket refunded without a draw: its credit back is not paid out", () => {
    const refunded = ticketRow({
      ticket: A("r"),
      price: USDC,
      vaultCredit: 950_000n,
      end: { ...end(950_000n, T0 - 30, "expired"), creditReturned: true },
    });
    const won = ticketRow({ ticket: A("w"), vaultCredit: 998_000n, end: end(3n * USDC, T0 - 20) });
    const only = activityFigures(ticketLog([refunded]), [], T0);
    expect(only.paid).toBe(0n);
    expect(only.result).toBe(0n);
    const both = activityFigures(ticketLog([refunded, won]), [], T0);
    expect(both.paid).toBe(3n * USDC);
    expect(both.result).toBe(998_000n - 3n * USDC);
    // the app's own per-app figures: settled, no payout to its customers, nothing kept
    const s = statsByApp(ticketLog([refunded, won])).get(refunded.integrator)!;
    expect(s.settled).toBe(2);
    expect(s.paidOut).toBe(3n * USDC);
    expect(s.result).toBe(998_000n - 3n * USDC);
  });

  it("says over how long when the read was capped inside the day", () => {
    const log = ticketLog([ticketRow({})], { truncated: true, from: T0 - 6 * 3600 });
    expect(activityFigures(log, [], T0).span).toBe("6 h");
    expect(activityFigures(ticketLog([], { truncated: true, from: T0 - 60 }), [], T0).span).toBe(
      "1 h",
    );
  });

  it("adds up from the rows listed: winners' payouts and what the vault kept, over random days", () => {
    const r = rng(53);
    for (let i = 0; i < 300; i++) {
      const rows: TicketRow[] = Array.from({ length: r.int(30) }, (_, k) => {
        const price = r.big(10_000n, 50n * USDC);
        const credit = price - (price * 20n) / BPS;
        const opened = T0 - r.int(2 * DAY);
        const settled = r.int(4);
        return ticketRow({
          ticket: A(`r${k}`),
          price,
          vaultCredit: credit,
          payoutMax: price * 10n,
          openedAt: opened,
          end:
            settled === 0
              ? null
              : end(
                  settled === 1 ? price * 10n : 0n,
                  Math.min(T0, opened + r.int(600)),
                  settled === 3 ? "expired" : "settled",
                ),
        });
      });
      for (const row of rows) if (row.end?.kind === "expired") row.end.payout = 0n;
      const f = activityFigures(ticketLog(rows), [], T0);
      const inSpan = rows.filter((x) => x.end && x.end.at !== null && x.end.at >= T0 - DAY);
      // each row's amount, as the list writes it: a win's payout, else what the vault kept
      let won = 0n;
      let kept = 0n;
      for (const x of inSpan) {
        const line = vaultLine(x, true);
        const amount = BigInt(line.amount.replace(/[+,.]/g, "")) * 10_000n;
        if (line.tone === "won") {
          expect(amount).toBe((x.end!.payout / 10_000n) * 10_000n);
          won += x.end!.payout;
          kept -= x.end!.payout - x.vaultCredit;
        } else {
          expect(line.tone).toBe("kept");
          expect(amount).toBe((x.vaultCredit / 10_000n) * 10_000n);
          kept += x.vaultCredit;
        }
      }
      expect(f.paid).toBe(won);
      expect(f.result).toBe(kept);
      expect(f.n).toBe(rows.filter((x) => x.openedAt! >= T0 - DAY).length);
    }
  });
});
