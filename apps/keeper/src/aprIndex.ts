// The pure part of the vault's APR (GET /v1/apr, served by the Stats Durable Object, stats.ts):
// what one program transaction says for it, and the answer built from what the Durable Object
// stored. The arithmetic is the app's own (apps/web/src/lib/apr.ts), so the keeper's figure and
// the one the app falls back on agree on the same tickets.
//
// Per ticket, the opening: a direct ticket's `TicketOpened` (its price, margin and app share), a
// beacon ticket's `TicketJoined` (its price, payout table and the app and protocol shares its
// join took); a `RoundTicketReturned` of a refunded round, or a version-2 `TicketExpired` of a
// direct ticket refunded without a draw (its vault credit returned), leaves the ticket out. The vault's
// assets after each close come from `EpochStruck`, as the app's chart reads them; the last
// point, as the headline, reads the vault's total assets now.
import type { Address } from "@solana/kit";
import {
  EPOCH_STRUCK_EVENT_DISCRIMINATOR,
  ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR,
  TICKET_EXPIRED_EVENT_DISCRIMINATOR,
  TICKET_JOINED_EVENT_DISCRIMINATOR,
  TICKET_OPENED_EVENT_DISCRIMINATOR,
  getEpochStruckEventDecoder,
  getRoundTicketReturnedEventDecoder,
  getTicketJoinedEventDecoder,
  getTicketOpenedEventDecoder,
} from "../../../clients/js/src/generated/fade/index.ts";
import { decodeTicketExpired } from "../../../clients/js/src/direct/index.ts";
import {
  APR_WINDOW_S,
  aprSeries,
  estimateApr,
  type AprLog,
  type AprTicket,
  type AssetsPoint,
} from "../../web/src/lib/apr.ts";
import { BPS, marginBps as marginOfLhs } from "../../web/src/lib/math.ts";
import { startsWith } from "./chain.ts";
import { eventBodiesOf, type JsonTx } from "./statsIndex.ts";

const HOUR = 3_600;
const DAY = 86_400;
/** The days of hourly points the answer carries. */
export const APR_SERIES_DAYS = 30;
/**
 * How long the index keeps a ticket, a refund and a close: the first point's 7 days, and a day
 * to spare.
 */
export const APR_KEPT_S = APR_SERIES_DAYS * DAY + APR_WINDOW_S + DAY;
/**
 * The events a version of the index records for the APR. An index whose transactions were
 * counted before it (no `apr_version`) reads its last APR_KEPT_S again, once (stats.ts, step 4).
 * The direct refunds (`TicketExpired` version 2 with `refunded`) need no new version: no program
 * an index read before them had `refund_expired_ticket`, and the upgrade that adds it drains every
 * direct ticket under PAUSE_TICKETS before the keeper that reads them deploys, so no stored
 * history holds one.
 */
export const APR_EVENTS_VERSION = 1;

/** What a program transaction says for the APR. */
export type AprEvent =
  | { kind: "direct"; ticket: Address; price: bigint; marginBps: bigint; appShareBps: bigint }
  | {
      kind: "beacon";
      ticket: Address;
      price: bigint;
      payoutTable: Address;
      appShare: bigint;
      protocolShare: bigint;
    }
  | { kind: "refunded"; ticket: Address }
  /** The vault's assets after the close, deposits in and withdrawals paid out. */
  | { kind: "struck"; epochId: bigint; assets: bigint };

/** The APR's events of a successful transaction, in order. */
export function aprEventsOf(tx: JsonTx, program: Address): AprEvent[] {
  const out: AprEvent[] = [];
  for (const body of eventBodiesOf(tx, program)) {
    try {
      if (startsWith(body, TICKET_OPENED_EVENT_DISCRIMINATOR)) {
        const e = getTicketOpenedEventDecoder().decode(body);
        out.push({
          kind: "direct",
          ticket: e.ticket,
          price: e.price,
          marginBps: e.marginBps,
          appShareBps: e.appShareBps,
        });
      } else if (startsWith(body, TICKET_JOINED_EVENT_DISCRIMINATOR)) {
        const e = getTicketJoinedEventDecoder().decode(body);
        out.push({
          kind: "beacon",
          ticket: e.ticket,
          price: e.price,
          payoutTable: e.payoutTable,
          appShare: e.appShare,
          protocolShare: e.protocolShare,
        });
      } else if (startsWith(body, ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR)) {
        const e = getRoundTicketReturnedEventDecoder().decode(body);
        if (e.refunded) out.push({ kind: "refunded", ticket: e.ticket });
      } else if (startsWith(body, TICKET_EXPIRED_EVENT_DISCRIMINATOR)) {
        // a direct refund: its vault credit went back, so the vault kept no margin on it
        const e = decodeTicketExpired(body);
        if (e.version === 2 && e.refunded) out.push({ kind: "refunded", ticket: e.ticket });
      } else if (startsWith(body, EPOCH_STRUCK_EVENT_DISCRIMINATOR)) {
        const e = getEpochStruckEventDecoder().decode(body);
        out.push({
          kind: "struck",
          epochId: e.epochId,
          assets: e.totalAssets + e.deposits - e.assetsPaid,
        });
      }
    } catch {
      // not a decodable Fade event
    }
  }
  return out;
}

/** A ticket as the index stores it: a direct one's margin, or a beacon one's payout table. */
export type StoredTicket = {
  openedAt: number | null;
  price: bigint;
  direct: { marginBps: bigint; appShareBps: bigint } | null;
  beacon: { payoutTable: Address; appShare: bigint; protocolShare: bigint } | null;
  refunded: boolean;
};

/**
 * A stored ticket as the APR reads it, as the app reads a `TicketRow`: a beacon ticket's margin is
 * its payout table's (`Σ p·m` in `lhs`), 0 while the table is not read; its app share in basis
 * points is its app share over its price, rounded down.
 */
export function aprTicketOf(t: StoredTicket, lhs: ReadonlyMap<Address, bigint>): AprTicket {
  const end = t.refunded ? { refunded: true } : null;
  if (t.beacon) {
    const l = lhs.get(t.beacon.payoutTable);
    return {
      openedAt: t.openedAt,
      price: t.price,
      marginBps: l === undefined ? 0n : (marginOfLhs(l) ?? 0n),
      appShareBps: t.price > 0n ? (t.beacon.appShare * BPS) / t.price : 0n,
      beacon: { appShare: t.beacon.appShare, protocolShare: t.beacon.protocolShare },
      end,
    };
  }
  return {
    openedAt: t.openedAt,
    price: t.price,
    marginBps: t.direct?.marginBps ?? 0n,
    appShareBps: t.direct?.appShareBps ?? 0n,
    end,
  };
}

/** GET /v1/apr. */
export type AprView = {
  /** ISO 8601: when this answer was built. */
  updatedAt: string;
  windowDays: 7;
  /** The index is still reading the history: the figures may be short of their value. */
  syncing: boolean;
  /** The APR now, as the app's headline reads it; micro-USDC as decimal strings. */
  now: { pct: number | null; tickets: number; volume: string; margin: string };
  /**
   * Oldest first: a point each whole hour over the last APR_SERIES_DAYS days (from the first
   * ticket, the first close and the first complete 7 days, the latest of them), then now. A null
   * `pct` is a week with fewer than `APR_MIN_TICKETS` tickets.
   */
  series: { t: number; pct: number | null }[];
};

export type AprInputs = {
  /** Every ticket kept, in any order. */
  tickets: readonly AprTicket[];
  /** The vault's assets after each close, oldest first. */
  strikes: readonly AssetsPoint[];
  /** The vault's total assets now: the headline's and the last point's. */
  totalAssets: bigint;
  protocolShareBps: bigint;
  /** Unix seconds. */
  now: number;
  /** Unix seconds from which every ticket is recorded (0: the whole history). */
  coveredFrom: number;
  syncing: boolean;
};

/** The answer of GET /v1/apr from what the index recorded. */
export function aprView(i: AprInputs): AprView {
  const { now, coveredFrom } = i;
  // the tickets are listed in full from `coveredFrom`; short of 7 days, the headline scales them
  const log: AprLog = {
    rows: i.tickets,
    from: Number.isFinite(coveredFrom) ? coveredFrom : null,
    truncated: coveredFrom > now - APR_WINDOW_S,
    since: coveredFrom,
  };
  const head = estimateApr(log, i.totalAssets, i.protocolShareBps, now);
  let firstTicket = Infinity;
  for (const r of i.tickets)
    if (r.openedAt !== null && r.openedAt < firstTicket) firstTicket = r.openedAt;
  const start = Math.max(
    now - APR_SERIES_DAYS * DAY,
    coveredFrom + APR_WINDOW_S,
    firstTicket,
    i.strikes[0]?.t ?? Infinity,
  );
  const times: number[] = [];
  if (Number.isFinite(start))
    for (let t = Math.ceil(start / HOUR) * HOUR; t < now; t += HOUR) times.push(t);
  times.push(now);
  const assets = [...i.strikes, { t: now, assets: i.totalAssets }];
  const series = aprSeries(log, assets, i.protocolShareBps, times).map((p) => ({
    t: p.t,
    pct: p.v,
  }));
  return {
    updatedAt: new Date(now * 1_000).toISOString(),
    windowDays: 7,
    syncing: i.syncing,
    now: {
      pct: head.pct,
      tickets: head.tickets,
      volume: head.volume.toString(),
      margin: head.margin.toString(),
    },
    series,
  };
}
