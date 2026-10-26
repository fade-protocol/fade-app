// The vault page's public history, pure: what each app brought in, the Activity tab's figures
// over the last day, the share price and the vault's assets after each close, and the ticket
// volume per period. One arithmetic for the keeper, which indexes every program transaction and
// serves it (GET /v1/vault, apps/keeper/src/vaultIndex.ts), and for the app, which shows it and
// works it out over the tickets and the closes it read itself when the keeper cannot serve it.
import type { Address } from "@solana/kit";
import { isRefunded } from "./apr";
import { BPS } from "./math";
import { winPayout } from "./ticketRows";

const HOUR = 3600;
const DAY = 86400;

/** How far back "Where the vault earns" counts each app's tickets. */
export const APPS_WINDOW_S = 7 * DAY;
/** How far back the Activity tab's figures count. */
export const ACTIVITY_WINDOW_S = DAY;

/** What these figures read of a ticket: a `TicketRow` (lib/ticketLog) or the keeper's record. */
export type ViewTicket = {
  integrator: Address;
  /** Micro-USDC. */
  price: bigint;
  vaultCredit: bigint;
  appShareBps: bigint;
  /** Unix seconds; null when the cluster did not date the opening. */
  openedAt: number | null;
  /** A beacon ticket: the app share its join took, in micro-USDC. */
  beacon?: { appShare: bigint };
  /**
   * `creditReturned`: a direct ticket refunded without a draw, its `payout` the vault credit
   * back (`TicketEnd.creditReturned`), which no figure here counts as paid to a winner.
   */
  end?: { payout: bigint; refunded?: boolean; creditReturned?: boolean; at: number | null } | null;
};

/**
 * Micro-USDC of a ticket's price its app kept: a beacon ticket's join says it exactly, and a
 * refunded one kept nothing.
 */
export const appShareOf = (
  r: Pick<ViewTicket, "price" | "appShareBps" | "beacon" | "end">,
): bigint => (isRefunded(r) ? 0n : r.beacon ? r.beacon.appShare : (r.price * r.appShareBps) / BPS);

export type AppStats = {
  tickets: number;
  /** Ticket prices, a refunded beacon ticket's left out (the program's `volume_total`). */
  volume: bigint;
  /**
   * The vault's result on the tickets read both ends of: its credit, less what it paid; nothing
   * for a refunded beacon ticket, whose credit went back with its price.
   */
  result: bigint;
  settled: number;
  appShare: bigint;
  /** Payouts of the draws to the app's customers; a direct ticket's credit back is none. */
  paidOut: bigint;
};

/** Per integrator record, over the tickets given (their openings read). */
export function statsByApp(log: { rows: readonly ViewTicket[] }): Map<Address, AppStats> {
  const m = new Map<Address, AppStats>();
  for (const r of log.rows) {
    let s = m.get(r.integrator);
    if (!s) {
      s = { tickets: 0, volume: 0n, result: 0n, settled: 0, appShare: 0n, paidOut: 0n };
      m.set(r.integrator, s);
    }
    s.tickets += 1;
    s.appShare += appShareOf(r);
    if (!isRefunded(r)) s.volume += r.price;
    if (r.end) {
      s.settled += 1;
      if (!isRefunded(r)) s.result += r.vaultCredit - r.end.payout;
      s.paidOut += winPayout(r.end);
    }
  }
  return m;
}

/**
 * Micro-USDC of ticket prices per bucket of `bucketS` seconds over [from, to], the first bucket
 * starting at `from`: a ticket opened at `to` falls in the last. A refunded beacon ticket is left
 * out, as the APR and the program's `volume_total` count it.
 */
export function volumeSums(
  log: { rows: readonly Pick<ViewTicket, "price" | "openedAt" | "end">[] },
  from: number,
  to: number,
  bucketS: number,
): bigint[] {
  const n = Math.max(1, Math.ceil((to - from) / bucketS));
  const sums = new Array<bigint>(n).fill(0n);
  for (const r of log.rows) {
    if (r.openedAt === null || r.openedAt < from || r.openedAt > to || isRefunded(r)) continue;
    const i = Math.min(n - 1, Math.floor((r.openedAt - from) / bucketS));
    sums[i]! += r.price;
  }
  return sums;
}

/**
 * Hourly sums starting at the whole hour `hourFrom` (`volumeSums` with an hour's bucket) gathered
 * into buckets of `bucketS` (a whole number of hours, a divisor of a day), each starting on a
 * multiple of it: from the one holding `from` to the one holding the last hour. Only the hours
 * from the one holding `from` on count, so the total covers the window the app's own
 * `volumeSeries` sums from `from` (the hour `from` falls in counts in full); the first bucket
 * starts at that hour.
 */
export function rebucket(
  hourFrom: number,
  hourly: readonly bigint[],
  bucketS: number,
  from: number,
): { t: number; v: bigint }[] {
  const startHour = Math.floor(from / HOUR) * HOUR;
  const first = Math.floor(from / bucketS) * bucketS;
  const lastHour = hourFrom + (hourly.length - 1) * HOUR;
  const n = Math.max(1, Math.floor((lastHour - first) / bucketS) + 1);
  const out = Array.from({ length: n }, (_, i) => ({ t: first + i * bucketS, v: 0n }));
  out[0]!.t = Math.max(first, Math.min(startHour, lastHour));
  hourly.forEach((v, i) => {
    const t = hourFrom + i * HOUR;
    if (t < startHour) return;
    out[Math.min(n - 1, Math.floor((t - first) / bucketS))]!.v += v;
  });
  return out;
}

export type ActivityTickets = {
  /** Tickets opened since. */
  n: number;
  /** Payouts of the draws of the tickets that ended since; a direct ticket's credit back is none. */
  paid: bigint;
  /**
   * What the vault kept on them: their vault credits less their payouts; nothing for a refunded
   * beacon ticket, whose credit went back with its price.
   */
  result: bigint;
};

/** The Activity tab's ticket figures since `since` (Unix seconds). */
export function activityTickets(
  rows: readonly Pick<ViewTicket, "openedAt" | "vaultCredit" | "end">[],
  since: number,
): ActivityTickets {
  let n = 0;
  let paid = 0n;
  let result = 0n;
  for (const r of rows) {
    if ((r.openedAt ?? 0) >= since) n += 1;
    const at = r.end?.at ?? null;
    if (r.end && at !== null && at >= since) {
      paid += winPayout(r.end);
      if (!isRefunded(r)) result += r.vaultCredit - r.end.payout;
    }
  }
  return { n, paid, result };
}

/** What a close (`EpochStruck`) says of the vault: its counters before, and what it moved. */
export type StrikeCounters = {
  totalAssets: bigint;
  totalShares: bigint;
  deposits: bigint;
  sharesMinted: bigint;
  assetsPaid: bigint;
  sharesBurnt: bigint;
};

/** Deposits less withdrawals paid by the closes since `since` (Unix seconds). */
export function netDeposits(
  strikes: readonly ({ t: number | null } & Pick<StrikeCounters, "deposits" | "assetsPaid">)[],
  since: number,
): bigint {
  let net = 0n;
  for (const s of strikes) if ((s.t ?? 0) >= since) net += s.deposits - s.assetsPaid;
  return net;
}

const SHARE_UNIT = 1_000_000_000n;
/** The program's virtual offsets (fade-math shares.rs): `A + 1` assets for `S + 1000` shares. */
const VIRTUAL_ASSETS = 1n;
const VIRTUAL_SHARES = 1_000n;

/**
 * Micro-USDC per whole share for `assets` against `shares`, as the program prices a share
 * (fade-math `assets_for_shares` of one whole share, `drawdown::share_price` scaled down):
 * `(A + 1) / (S + 1000)`, rounded down. Null with no shares.
 */
export const sharePrice = (assets: bigint, shares: bigint) =>
  shares === 0n ? null : ((assets + VIRTUAL_ASSETS) * SHARE_UNIT) / (shares + VIRTUAL_SHARES);

/** The vault's assets after a close (deposits in, withdrawals paid out), and its share price. */
export function afterStrike(d: StrikeCounters): { assets: bigint; price: bigint | null } {
  const assets = d.totalAssets + d.deposits - d.assetsPaid;
  return { assets, price: sharePrice(assets, d.totalShares + d.sharesMinted - d.sharesBurnt) };
}

/** The chart's ranges back from now (lib/vaultFigures `windowStart`); ALL starts at the first point. */
export const RANGE_S = { "1D": DAY, "7D": 7 * DAY, "1M": 30 * DAY } as const;

/** How long every close is kept in a served series; before it, the last close of each hour. */
export const ALL_CLOSES_S = DAY;
/**
 * How long after a range's start, as of the build, every close stays kept: the app reads an
 * answer for minutes after it is built, its window start moving on with its clock.
 */
export const RANGE_START_BAND_S = 2 * HOUR;

/**
 * The index of the close in force at `t` among `points` (oldest first): the last one at or
 * before it, else the first, as lib/positionPnl `priceAt` reads it.
 */
export function closeInForce(points: readonly { t: number }[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let at = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t <= t) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return at;
}

/**
 * The closes a served series keeps (oldest first in and out): the first one, every one since the
 * hour before the one `now - ALL_CLOSES_S` falls in, the last one of each whole hour, every one
 * from the hour before each range's start to RANGE_START_BAND_S after it, and the one in force
 * at each time of `keepAt`. The chart draws one point per close, and a month of closes every few
 * minutes would only weigh down the answer, but every close the app looks up stays: the last one
 * at or before a range's start (the start of the change it shows), whatever the app's clock
 * within an hour of the build, and the one in force at each withdrawal it values. A close
 * before a kept span starting on a whole hour is the last of its hour, so it is kept too.
 */
export function thinStrikes<P extends { t: number }>(
  points: readonly P[],
  now: number,
  keepAt: readonly number[] = [],
): P[] {
  const fromHourBefore = (t: number) => Math.floor(t / HOUR) * HOUR - HOUR;
  const spans: [number, number][] = [
    [fromHourBefore(now - ALL_CLOSES_S), Infinity],
    ...[RANGE_S["7D"], RANGE_S["1M"]].map((r): [number, number] => [
      fromHourBefore(now - r),
      now - r + RANGE_START_BAND_S,
    ]),
  ];
  const kept = new Set<number>(points.length ? [0] : []);
  for (const t of keepAt) kept.add(closeInForce(points, t));
  return points.filter((p, i) => {
    const next = points[i + 1];
    return (
      kept.has(i) ||
      !next ||
      Math.floor(next.t / HOUR) !== Math.floor(p.t / HOUR) ||
      spans.some(([a, b]) => p.t >= a && p.t < b)
    );
  });
}
