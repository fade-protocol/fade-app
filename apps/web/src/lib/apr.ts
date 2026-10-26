// The vault's APR, pure: the vault margin of the tickets opened in a trailing 7 days, refunded
// ones left out, × 365 / 7 over the vault's assets. One arithmetic for the keeper, which serves
// it (GET /v1/apr, apps/keeper/src/apr.ts), and for the app, which shows it and falls back on it
// over the tickets it read itself when the keeper cannot be reached.
import { BPS } from "./math";

const DAY = 86400;
/** The trailing window of the vault's APR. */
export const APR_WINDOW_S = 7 * DAY;

/** Fewer tickets than this in 7 days and the APR is not shown. */
export const APR_MIN_TICKETS = 5;

/** What the APR reads of a ticket: a `TicketRow` (lib/ticketLog) or the keeper's record of one. */
export type AprTicket = {
  /** Unix seconds; null when the cluster did not date the opening. */
  openedAt: number | null;
  /** Micro-USDC. */
  price: bigint;
  /** A beacon ticket's is its payout table's, 0 while the table is not read. */
  marginBps: bigint;
  appShareBps: bigint;
  /** A beacon ticket: the shares its join took out of the price, in micro-USDC. */
  beacon?: { appShare: bigint; protocolShare: bigint };
  end?: { refunded?: boolean; creditReturned?: boolean } | null;
};

/** The tickets the APR reads, newest first, and from when they are listed in full. */
export type AprLog = {
  rows: readonly AprTicket[];
  /** Unix seconds of the oldest transaction read; null when none was. */
  from: number | null;
  /** The read stopped before reaching `since`: it lists every ticket from `from` only. */
  truncated: boolean;
  /** Unix seconds the read reached back to; absent when it had no start. */
  since?: number;
};

export type AprEstimate = {
  /** Percent a year, or null when the last 7 days hold too few tickets to say. */
  pct: number | null;
  tickets: number;
  /** Micro-USDC of ticket prices over the last 7 days (extrapolated when the read was capped). */
  volume: bigint;
  /** Micro-USDC the vault's margin kept on that volume. */
  margin: bigint;
};

/** A margin over the APR's 7 days, annualised over `assets`, in percent (`assets` above 0). */
const annualised = (margin: bigint, assets: bigint): number =>
  (Number(margin) * 365 * DAY * 100) / (APR_WINDOW_S * Number(assets));

/**
 * A beacon ticket of a refunded round: its whole price went back to its funder, so the vault
 * kept no credit and its app no share, and the program counts no volume for it.
 */
export const isRefunded = (r: { end?: { refunded?: boolean } | null }): boolean =>
  r.end?.refunded === true;

/**
 * A ticket the APR leaves out: a refunded beacon ticket (`isRefunded`), or a direct ticket
 * refunded without a draw (`refund_expired_ticket`, `creditReturned`), whose vault credit went
 * back. Either way the vault kept no margin on it.
 */
const keptNoMargin = (r: { end?: { refunded?: boolean; creditReturned?: boolean } | null }) =>
  isRefunded(r) || r.end?.creditReturned === true;

/**
 * Micro-USDC the vault's margin keeps of a ticket's price, at least 0: its margin less its app
 * share and the protocol share, the current protocol share for a direct ticket and the one its
 * join took for a beacon ticket. A refunded beacon ticket kept nothing.
 */
export function vaultMarginOf(
  r: Pick<AprTicket, "price" | "marginBps" | "appShareBps" | "beacon" | "end">,
  protocolShareBps: bigint,
): bigint {
  if (keptNoMargin(r)) return 0n;
  if (r.beacon) {
    const m = (r.price * r.marginBps) / BPS - r.beacon.appShare - r.beacon.protocolShare;
    return m > 0n ? m : 0n;
  }
  const vm = r.marginBps - r.appShareBps - protocolShareBps;
  return vm > 0n ? (r.price * vm) / BPS : 0n;
}

/**
 * The vault's APR: the vault margin earned on the tickets opened in the last 7 days, both paths',
 * × 365 / 7 over the vault's assets now (`vaultMarginOf` each ticket). A refunded beacon ticket
 * is left out, as the program's `volume_total` leaves it out: it brought nothing in. A read
 * capped inside the 7 days scales its volume up to them.
 */
export function estimateApr(
  log: AprLog,
  totalAssets: bigint,
  protocolShareBps: bigint,
  now: number,
): AprEstimate {
  const since = now - APR_WINDOW_S;
  let volume = 0n;
  let margin = 0n;
  let tickets = 0;
  for (const r of log.rows) {
    if (r.openedAt === null || r.openedAt < since || keptNoMargin(r)) continue;
    tickets += 1;
    volume += r.price;
    margin += vaultMarginOf(r, protocolShareBps);
  }
  if (log.truncated && log.from !== null && log.from > since) {
    const span = BigInt(Math.max(60, now - log.from));
    volume = (volume * BigInt(APR_WINDOW_S)) / span;
    margin = (margin * BigInt(APR_WINDOW_S)) / span;
  }
  const pct =
    tickets < APR_MIN_TICKETS || totalAssets === 0n ? null : annualised(margin, totalAssets);
  return { pct, tickets, volume, margin };
}

/**
 * Where a log lists every ticket from: the oldest transaction read when the read was capped,
 * else the start of the read. Infinity for a capped read without a known time.
 */
export const coveredFrom = (log: Pick<AprLog, "from" | "truncated" | "since">): number =>
  log.truncated ? (log.from ?? Infinity) : (log.since ?? -Infinity);

/** The vault's assets known at a time: after a close, or the live figure. */
export type AssetsPoint = { t: number; assets: bigint };

/** The index of the first of `xs` (ascending) above `v`. */
function upperBound(xs: readonly number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The index of the first of `xs` (ascending) at or above `v`. */
function lowerBound(xs: readonly number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The vault's APR at each of `times` (oldest first), read as `estimateApr` reads it now: the
 * vault margin of the tickets opened in the 7 days up to t, refunded ones left out, annualised
 * over the assets known at t (the last of `assets`, oldest first, at or before t). The last time
 * counts every ticket read since its 7 days began, as the headline does. Null where fewer than
 * `APR_MIN_TICKETS` tickets fall in a whole week, where no assets are known or they are zero,
 * and where the window starts before the log lists every ticket (`coveredFrom`): a capped read
 * is not extrapolated to 7 days here, a partial window would only understate the figure.
 *
 * The tickets are summed by prefix over their opening times, so a month of hourly points over
 * thousands of tickets costs a sort, not a pass over every ticket per point.
 */
export function aprSeries(
  log: AprLog,
  assets: readonly AssetsPoint[],
  protocolShareBps: bigint,
  times: readonly number[],
): { t: number; v: number | null }[] {
  const covered = coveredFrom(log);
  const counted = log.rows
    .filter((r) => r.openedAt !== null && !keptNoMargin(r))
    .map((r) => ({ at: r.openedAt as number, margin: vaultMarginOf(r, protocolShareBps) }))
    .sort((a, b) => a.at - b.at);
  const opened = counted.map((r) => r.at);
  // prefix[i]: the margin of the first i tickets
  const prefix: bigint[] = [0n];
  for (const r of counted) prefix.push(prefix[prefix.length - 1]! + r.margin);
  const assetTimes = assets.map((a) => a.t);
  return times.map((t, i) => {
    const since = t - APR_WINDOW_S;
    const last = i === times.length - 1;
    const known = upperBound(assetTimes, t);
    const at = known > 0 ? assets[known - 1]!.assets : 0n;
    if (since < covered || at === 0n) return { t, v: null };
    const lo = lowerBound(opened, since);
    const hi = last ? opened.length : upperBound(opened, t);
    const tickets = Math.max(0, hi - lo);
    const margin = tickets > 0 ? prefix[hi]! - prefix[lo]! : 0n;
    return {
      t,
      v: tickets < APR_MIN_TICKETS ? null : annualised(margin, at),
    };
  });
}

/** What the vault's APR is called wherever the app shows it. */
export const APR_LABEL = "APR";
