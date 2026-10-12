// One liquidity provider's results, from their deposits and withdrawals in the vault.
//
// Cost basis by the average-cost method: a deposit adds its USDC to the cost and its fvUSDC to
// the shares held; a withdrawal takes out its fvUSDC at the average cost per share, and what it
// paid less that cost is realised. A full exit leaves no cost, so a later deposit starts afresh.
// The total result at any time is the value of the shares held, less their cost, plus what was
// realised: the same as the value plus everything withdrawn, less everything deposited.
//
// Pure: every input is passed in (flows read from the wallet's on-chain history, the vault's
// share-price series), so the arithmetic is tested on its own (tests/ts/web/positionPnl.test.ts).
import type { FadeEvent } from "./events";

/** Shares have 9 decimals: prices are micro-USDC per whole share. */
const SHARE_UNIT = 1_000_000_000n;
const YEAR_S = 365 * 86400;

/** One completed move of the owner, in micro-USDC and shares (9 decimals). */
export type Flow = {
  kind: "deposit" | "withdraw";
  /** Unix seconds. */
  t: number;
  /** Deposit: USDC paid in. Withdrawal: USDC received (or due, while it is still paying). */
  assets: bigint;
  shares: bigint;
};

export type Book = {
  /** fvUSDC held. */
  shares: bigint;
  /** Cost basis of the shares held, micro-USDC. */
  cost: bigint;
  /** Result of the withdrawals so far: what they paid less the cost of the shares they took. */
  realized: bigint;
  deposited: bigint;
  withdrawn: bigint;
};

export const EMPTY_BOOK: Book = {
  shares: 0n,
  cost: 0n,
  realized: 0n,
  deposited: 0n,
  withdrawn: 0n,
};

/** The book after one more flow. A withdrawal of more shares than held takes the whole cost. */
export function applyFlow(b: Book, f: Flow): Book {
  if (f.kind === "deposit")
    return {
      ...b,
      shares: b.shares + f.shares,
      cost: b.cost + f.assets,
      deposited: b.deposited + f.assets,
    };
  const out = f.shares >= b.shares ? b.cost : b.shares === 0n ? 0n : (b.cost * f.shares) / b.shares;
  const left = b.shares - f.shares;
  return {
    shares: left > 0n ? left : 0n,
    cost: b.cost - out,
    realized: b.realized + f.assets - out,
    deposited: b.deposited,
    withdrawn: b.withdrawn + f.assets,
  };
}

const byTime = (flows: readonly Flow[]) =>
  [...flows].sort((a, b) => a.t - b.t || (a.kind === b.kind ? 0 : a.kind === "deposit" ? -1 : 1));

/** The book after every flow, oldest first. */
export function bookOf(flows: readonly Flow[]): Book {
  return byTime(flows).reduce(applyFlow, EMPTY_BOOK);
}

/** Average cost per whole share, micro-USDC; null with nothing held. */
export const entryPrice = (b: Book): bigint | null =>
  b.shares === 0n ? null : (b.cost * SHARE_UNIT) / b.shares;

/** Micro-USDC value of `shares` at `price` (micro-USDC per whole share). */
export const valueAt = (shares: bigint, price: bigint) => (shares * price) / SHARE_UNIT;

export type Pnl = {
  /** Value of the shares held less their cost. */
  unrealized: bigint;
  /** Unrealized over cost, in basis points; null with no cost. */
  unrealizedBps: bigint | null;
  realized: bigint;
  /** Unrealized plus realized. */
  total: bigint;
};

export function pnlOf(b: Book, value: bigint): Pnl {
  const unrealized = value - b.cost;
  return {
    unrealized,
    unrealizedBps: b.cost > 0n ? (unrealized * 10_000n) / b.cost : null,
    realized: b.realized,
    total: unrealized + b.realized,
  };
}

/** A share price at a time: micro-USDC per whole share. */
export type PriceAt = { t: number; price: bigint };

/** The price in force at `t`: the last point at or before it, else the first one. */
export function priceAt(points: readonly PriceAt[], t: number): bigint | null {
  let p: bigint | null = points[0]?.price ?? null;
  for (const x of points) {
    if (x.t > t) break;
    p = x.price;
  }
  return p;
}

export type PositionPoint = { t: number; value: bigint; pnl: bigint };

/**
 * The position over time, from its first flow to `to`: at each price point and each flow, the
 * shares then held at the price then in force (value), and value less cost plus realised (P&L).
 * `prices` is sorted by time; its last point should be today's price. `valueNow`, the value the
 * page shows (the program's arithmetic on the shares, not a price rounded first), is the last
 * point's, so the chart ends on the figure above it.
 */
export function positionSeries(
  flows: readonly Flow[],
  prices: readonly PriceAt[],
  to: number,
  valueNow?: bigint,
): PositionPoint[] {
  const sorted = byTime(flows);
  const first = sorted[0];
  if (!first) return [];
  const times = new Set<number>([to]);
  for (const f of sorted) times.add(f.t);
  for (const p of prices) if (p.t >= first.t && p.t <= to) times.add(p.t);
  const out: PositionPoint[] = [];
  let b = EMPTY_BOOK;
  let i = 0;
  for (const t of [...times].sort((x, y) => x - y)) {
    while (i < sorted.length && sorted[i]!.t <= t) b = applyFlow(b, sorted[i++]!);
    const price = priceAt(prices, t);
    const value =
      t === to && valueNow !== undefined
        ? valueNow
        : price === null
          ? b.cost
          : valueAt(b.shares, price);
    out.push({ t, value, pnl: value - b.cost + b.realized });
  }
  return out;
}

/**
 * The value of `shares` at each price point of the last `days` days, for a wallet whose history
 * does not explain its fvUSDC (no P&L can be told): the last point is `valueNow`, the figure the
 * page shows.
 */
export function heldSeries(
  shares: bigint,
  prices: readonly PriceAt[],
  now: number,
  valueNow: bigint,
  days = 90,
): PositionPoint[] {
  return prices
    .filter((p) => p.t >= now - days * 86400)
    .map((p) => ({ t: p.t, value: p.t >= now ? valueNow : valueAt(shares, p.price), pnl: 0n }));
}

/** The P&L at `t` read from a series: the last point at or before it, 0 before the first. */
export function pnlAt(series: readonly PositionPoint[], t: number): bigint {
  let v = 0n;
  for (const p of series) {
    if (p.t > t) break;
    v = p.pnl;
  }
  return v;
}

/** A return is not annualised over less than this: a few hours say nothing about a year. */
export const APR_MIN_SPAN_S = 86400;

export type PositionApr = {
  /** Percent a year, or null when the position is too young or has no capital at work. */
  pct: number | null;
  /** Seconds since the first deposit. */
  span: number;
};

/**
 * The position's annualised return since its first deposit, money-weighted (modified Dietz):
 * the total result over the average capital at work, where each deposit counts for the share of
 * the period it was in and each withdrawal takes its USDC out for the rest of it; then scaled to
 * a year, without compounding.
 */
export function positionApr(flows: readonly Flow[], valueNow: bigint, now: number): PositionApr {
  const sorted = byTime(flows);
  const first = sorted[0];
  if (!first) return { pct: null, span: 0 };
  const span = now - first.t;
  if (span < APR_MIN_SPAN_S) return { pct: null, span };
  let weighted = 0;
  let net = 0n;
  for (const f of sorted) {
    const w = (now - f.t) / span;
    const v = Number(f.kind === "deposit" ? f.assets : -f.assets);
    weighted += v * w;
    net += f.kind === "deposit" ? f.assets : -f.assets;
  }
  if (weighted <= 0) return { pct: null, span };
  const result = Number(valueNow - net);
  return { pct: (result / weighted) * (YEAR_S / span) * 100, span };
}

// --- from the wallet's history -----------------------------------------------------------

/** One deposit or withdrawal request of the owner, as its history tells it. */
export type Move = {
  kind: "deposit" | "withdraw";
  epochId: bigint;
  /** When it was requested, Unix seconds. */
  t: number;
  /** Deposit: USDC paid in. Withdrawal: USDC received so far (plus `due` while open). */
  assets: bigint;
  /** Deposit: fvUSDC received (0 until they arrive). Withdrawal: fvUSDC sent. */
  shares: bigint;
  /** Still open on the chain: not priced, or not fully paid. */
  open: boolean;
  signature: string;
};

export type LogItem = { signature: string; blockTime: number | null; events: FadeEvent[] };

/** An open withdrawal as the chain shows it: USDC already delivered and what is still due. */
export type OpenWithdrawal = { epochId: bigint; delivered: bigint; due: bigint };

/**
 * The owner's moves from their history (newest first, as read), with the open withdrawals the
 * chain still shows. A deposit counts once its fvUSDC reached the wallet; a withdrawal counts
 * from its request, at what it paid plus what is still due, so the P&L does not jump while it
 * pays out.
 */
export function movesOf(
  log: readonly LogItem[],
  openDeposits: readonly bigint[],
  openWithdrawals: readonly OpenWithdrawal[],
): Move[] {
  const deposits = new Map<bigint, Move>();
  const withdraws = new Map<bigint, Move>();
  const parked = new Map<bigint, bigint>();
  const get = (m: Map<bigint, Move>, kind: Move["kind"], epochId: bigint, item: LogItem) => {
    let x = m.get(epochId);
    if (!x) {
      x = {
        kind,
        epochId,
        t: item.blockTime ?? 0,
        assets: 0n,
        shares: 0n,
        open: false,
        signature: item.signature,
      };
      m.set(epochId, x);
    }
    return x;
  };
  // oldest first: a claim that delivers also delivers what earlier claims parked
  for (const item of [...log].reverse())
    for (const e of item.events)
      switch (e.kind) {
        case "DepositRequested": {
          const d = get(deposits, "deposit", e.data.epochId, item);
          d.assets += e.data.amount;
          break;
        }
        case "DepositClaimed":
          if (e.data.delivered)
            get(deposits, "deposit", e.data.epochId, item).shares += e.data.shares;
          break;
        case "WithdrawRequested":
          get(withdraws, "withdraw", e.data.epochId, item).shares += e.data.shares;
          break;
        case "WithdrawClaimed": {
          const p = parked.get(e.data.epochId) ?? 0n;
          if (e.data.delivered) {
            get(withdraws, "withdraw", e.data.epochId, item).assets += e.data.assets + p;
            parked.delete(e.data.epochId);
          } else parked.set(e.data.epochId, p + e.data.assets);
          break;
        }
        case "ClaimDelivered":
          if (e.data.deposit)
            get(deposits, "deposit", e.data.epochId, item).shares += e.data.amount;
          else {
            get(withdraws, "withdraw", e.data.epochId, item).assets += e.data.amount;
            parked.delete(e.data.epochId);
          }
          break;
        default:
          break;
      }
  for (const id of openDeposits) {
    const d = deposits.get(id);
    if (d) d.open = true;
  }
  for (const o of openWithdrawals) {
    const w = withdraws.get(o.epochId);
    if (!w) continue;
    w.open = true;
    // the chain is ahead of the history right after a claim
    if (o.delivered > w.assets) w.assets = o.delivered;
    w.assets += o.due;
  }
  const all = [...deposits.values(), ...withdraws.values()];
  for (const d of deposits.values()) if (d.shares === 0n) d.open = true;
  return all.filter((m) => m.shares > 0n || m.assets > 0n).sort((a, b) => b.t - a.t);
}

/**
 * The flows the book is built from: deposits whose fvUSDC arrived, and every withdrawal with
 * the shares it sent, once its USDC is known (paid, or due while it is open). A withdrawal the
 * chain closed before its claim reached the history waits for it rather than count as nothing.
 */
export const flowsOf = (moves: readonly Move[]): Flow[] =>
  moves
    .filter((m) => m.shares > 0n && (m.kind === "deposit" || m.assets > 0n))
    .map((m) => ({ kind: m.kind, t: m.t, assets: m.assets, shares: m.shares }));
