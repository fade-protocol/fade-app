// A liquidity provider's results by the average-cost method: deposits at different prices, a
// partial withdrawal, a full exit, a re-entry, the series behind the dashboard chart, the
// money-weighted APR, and the moves read back from the wallet's history.
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { FadeEvent } from "../../../apps/web/src/lib/events.ts";
import {
  APR_MIN_SPAN_S,
  applyFlow,
  bookOf,
  EMPTY_BOOK,
  entryPrice,
  flowsOf,
  movesOf,
  pnlAt,
  pnlOf,
  positionApr,
  positionSeries,
  priceAt,
  type Flow,
} from "../../../apps/web/src/lib/positionPnl.ts";

const USDC = 1_000_000n;
const SHARE = 1_000_000_000n;
const DAY = 86400;
const T0 = 1_800_000_000;

/** A deposit of `usdc` USDC at `price` USDC per share (4 decimals). */
const dep = (t: number, usdc: number, price: number): Flow => ({
  kind: "deposit",
  t,
  assets: BigInt(usdc) * USDC,
  shares: (BigInt(usdc) * SHARE * 10_000n) / BigInt(Math.round(price * 10_000)),
});
const wd = (t: number, shares: bigint, price: number): Flow => ({
  kind: "withdraw",
  t,
  shares,
  assets: (shares * BigInt(Math.round(price * 10_000)) * USDC) / (SHARE * 10_000n),
});

describe("average cost", () => {
  it("averages deposits made at different prices", () => {
    const b = bookOf([dep(T0, 1000, 1.0), dep(T0 + DAY, 1000, 1.25)]);
    // 1000 + 800 shares for 2000 USDC: 1.1111 per share
    expect(b.shares).toBe(1800n * SHARE);
    expect(b.cost).toBe(2000n * USDC);
    expect(entryPrice(b)).toBe(1_111_111n);
    expect(b.realized).toBe(0n);
    // at 1.30: 2340 USDC, 340 unrealized, 17%
    const p = pnlOf(b, 2340n * USDC);
    expect(p.unrealized).toBe(340n * USDC);
    expect(p.unrealizedBps).toBe(1700n);
    expect(p.total).toBe(340n * USDC);
  });

  it("realises a partial withdrawal at the average cost, the rest keeps it", () => {
    const b0 = bookOf([dep(T0, 1000, 1.0), dep(T0 + DAY, 1000, 1.25)]);
    // half the shares out at 1.30: 1170 USDC for 1000 USDC of cost
    const b = applyFlow(b0, wd(T0 + 2 * DAY, 900n * SHARE, 1.3));
    expect(b.shares).toBe(900n * SHARE);
    expect(b.cost).toBe(1000n * USDC);
    expect(b.realized).toBe(170n * USDC);
    expect(entryPrice(b)).toBe(entryPrice(b0));
    expect(b.withdrawn).toBe(1170n * USDC);
    // total = value + withdrawn - deposited, whatever the method
    const value = 1170n * USDC;
    expect(pnlOf(b, value).total).toBe(value + b.withdrawn - b.deposited);
  });

  it("a full exit leaves no cost, and a re-entry starts afresh", () => {
    const out = bookOf([dep(T0, 1000, 1.0), wd(T0 + DAY, 1000n * SHARE, 0.95)]);
    expect(out.shares).toBe(0n);
    expect(out.cost).toBe(0n);
    expect(out.realized).toBe(-50n * USDC);
    expect(entryPrice(out)).toBeNull();
    expect(pnlOf(out, 0n).unrealizedBps).toBeNull();

    const back = applyFlow(out, dep(T0 + 2 * DAY, 500, 0.9));
    expect(entryPrice(back)).toBe(900_000n);
    expect(back.cost).toBe(500n * USDC);
    expect(back.realized).toBe(-50n * USDC);
    // value at 1.00: 555.55 USDC, +55.55 unrealized, total +5.55
    const p = pnlOf(back, 555_555_555n);
    expect(p.unrealized).toBe(55_555_555n);
    expect(p.total).toBe(5_555_555n);
  });

  it("a withdrawal of more shares than held takes the whole cost", () => {
    const b = applyFlow(applyFlow(EMPTY_BOOK, dep(T0, 100, 1)), wd(T0, 200n * SHARE, 1));
    expect(b.shares).toBe(0n);
    expect(b.cost).toBe(0n);
  });

  it("orders flows by time whatever the input order", () => {
    const flows = [wd(T0 + DAY, 500n * SHARE, 1.1), dep(T0, 1000, 1.0)];
    expect(bookOf(flows).realized).toBe(50n * USDC);
  });
});

describe("the series", () => {
  const prices = [
    { t: T0 - DAY, price: 1_000_000n },
    { t: T0 + DAY, price: 1_100_000n },
    { t: T0 + 3 * DAY, price: 1_200_000n },
  ];

  it("reads the price in force at a time", () => {
    expect(priceAt(prices, T0)).toBe(1_000_000n);
    expect(priceAt(prices, T0 + 2 * DAY)).toBe(1_100_000n);
    expect(priceAt(prices, T0 - 9 * DAY)).toBe(1_000_000n);
    expect(priceAt([], T0)).toBeNull();
  });

  it("values the shares then held at the price then in force, P&L across a withdrawal", () => {
    const flows = [dep(T0, 1000, 1.0), wd(T0 + 2 * DAY, 500n * SHARE, 1.1)];
    const s = positionSeries(flows, prices, T0 + 4 * DAY);
    expect(s.map((p) => p.t)).toEqual([T0, T0 + DAY, T0 + 2 * DAY, T0 + 3 * DAY, T0 + 4 * DAY]);
    expect(s.map((p) => p.value)).toEqual([
      1000n * USDC,
      1100n * USDC,
      550n * USDC,
      600n * USDC,
      600n * USDC,
    ]);
    // the gain realised by the withdrawal stays in the P&L: no drop
    expect(s.map((p) => p.pnl)).toEqual([0n, 100n * USDC, 100n * USDC, 150n * USDC, 150n * USDC]);
    expect(pnlAt(s, T0 + 2.5 * DAY)).toBe(100n * USDC);
    expect(pnlAt(s, T0 - 1)).toBe(0n);
  });

  it("is empty without flows", () => {
    expect(positionSeries([], prices, T0)).toEqual([]);
  });
});

describe("the position's APR", () => {
  it("annualises a steady position simply", () => {
    // 1000 in for 73 days, worth 1020: 2% over a fifth of a year, 10% a year
    const r = positionApr([dep(T0, 1000, 1)], 1020n * USDC, T0 + 73 * DAY);
    expect(r.pct).toBeCloseTo(10, 6);
  });

  it("weights each deposit by the time it was in", () => {
    // 1000 for the whole year, 1000 for the last half: 1500 at work on average; +150 is 10%
    const r = positionApr(
      [dep(T0, 1000, 1), dep(T0 + 182.5 * DAY, 1000, 1)],
      2150n * USDC,
      T0 + 365 * DAY,
    );
    expect(r.pct).toBeCloseTo(10, 6);
  });

  it("takes a withdrawal's USDC out for the rest of the period", () => {
    // 1000 in, 500 out at mid-year, 550 left at the end: +50 on 750 at work on average
    const r = positionApr(
      [
        dep(T0, 1000, 1),
        { kind: "withdraw", t: T0 + 182.5 * DAY, assets: 500n * USDC, shares: 1n },
      ],
      550n * USDC,
      T0 + 365 * DAY,
    );
    expect(r.pct).toBeCloseTo((50 / 750) * 100, 6);
  });

  it("says nothing for a position younger than a day", () => {
    expect(positionApr([dep(T0, 1000, 1)], 1001n * USDC, T0 + APR_MIN_SPAN_S - 1).pct).toBeNull();
    expect(positionApr([], 0n, T0).pct).toBeNull();
  });
});

describe("moves from the wallet's history", () => {
  const owner = "o".padEnd(32, "1") as Address;
  const item = (t: number, sig: string, events: FadeEvent[]) => ({
    signature: sig,
    blockTime: t,
    events,
  });
  const ev = <K extends FadeEvent["kind"]>(kind: K, data: object) =>
    ({ kind, data: { version: 1, owner, ...data } }) as unknown as FadeEvent;

  // newest first, as read
  const log = [
    item(T0 + 5 * DAY, "e", [ev("DepositRequested", { epochId: 9n, amount: 50n * USDC })]),
    item(T0 + 3 * DAY, "d", [ev("WithdrawRequested", { epochId: 7n, shares: 400n * SHARE })]),
    item(T0 + 2 * DAY, "c", [
      ev("WithdrawClaimed", {
        epochId: 5n,
        atEpochId: 5n,
        assets: 210n * USDC,
        closed: true,
        delivered: true,
      }),
    ]),
    item(T0 + DAY, "b", [ev("WithdrawRequested", { epochId: 5n, shares: 200n * SHARE })]),
    item(T0 + 60, "a2", [
      ev("DepositClaimed", { epochId: 3n, shares: 1000n * SHARE, delivered: true }),
    ]),
    item(T0, "a", [ev("DepositRequested", { epochId: 3n, amount: 1000n * USDC })]),
  ];

  it("pairs requests and claims, open ones included", () => {
    const moves = movesOf(log, [9n], [{ epochId: 7n, delivered: 0n, due: 420n * USDC }]);
    expect(
      moves.map((m) => [m.kind, m.epochId, m.t, m.assets, m.shares, m.open, m.signature]),
    ).toEqual([
      ["deposit", 9n, T0 + 5 * DAY, 50n * USDC, 0n, true, "e"],
      ["withdraw", 7n, T0 + 3 * DAY, 420n * USDC, 400n * SHARE, true, "d"],
      ["withdraw", 5n, T0 + DAY, 210n * USDC, 200n * SHARE, false, "b"],
      ["deposit", 3n, T0, 1000n * USDC, 1000n * SHARE, false, "a"],
    ]);
    // the deposit still being priced is not in the book
    const b = bookOf(flowsOf(moves));
    expect(b.shares).toBe(400n * SHARE);
    expect(b.cost).toBe(400n * USDC);
    expect(b.realized).toBe(30n * USDC);
  });

  it("counts parked USDC once delivered", () => {
    const parked = [
      item(T0 + 3 * DAY, "y", [
        ev("ClaimDelivered", { epochId: 5n, deposit: false, amount: 100n * USDC }),
      ]),
      item(T0 + 2 * DAY, "x", [
        ev("WithdrawClaimed", {
          epochId: 5n,
          atEpochId: 5n,
          assets: 100n * USDC,
          closed: true,
          delivered: false,
        }),
      ]),
      item(T0 + DAY, "w", [ev("WithdrawRequested", { epochId: 5n, shares: 100n * SHARE })]),
    ];
    const [m] = movesOf(parked, [], []);
    expect(m?.assets).toBe(100n * USDC);
    expect(m?.open).toBe(false);
  });
});
