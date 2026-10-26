// The pure part of the vault page's public history (GET /v1/vault and GET /v1/feed, served by
// the Stats Durable Object, stats.ts): what one program transaction says for it, and the answers
// built from what the Durable Object stored. The arithmetic is the app's own
// (apps/web/src/lib/vaultViews.ts), so the keeper's figures and the ones the app falls back on
// agree on the same tickets and closes.
//
// Per ticket, its opening (`TicketOpened`, or a beacon ticket's `TicketJoined`), its end
// (`TicketSettled` or `RoundTicketSettled`: a draw; `TicketExpired` or `RoundTicketReturned`:
// none), and whether a `RoundPayoutClaimed` delivered what it parked; the Durable Object stores
// each part as it reads it, in any order. Per close, its `EpochStruck` counters; per deposit or
// withdrawal request, its amount.
import type { Address } from "@solana/kit";
import {
  DEPOSIT_REQUESTED_EVENT_DISCRIMINATOR,
  EPOCH_STRUCK_EVENT_DISCRIMINATOR,
  ROUND_PAYOUT_CLAIMED_EVENT_DISCRIMINATOR,
  ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR,
  ROUND_TICKET_SETTLED_EVENT_DISCRIMINATOR,
  TICKET_EXPIRED_EVENT_DISCRIMINATOR,
  TICKET_JOINED_EVENT_DISCRIMINATOR,
  TICKET_OPENED_EVENT_DISCRIMINATOR,
  TICKET_SETTLED_EVENT_DISCRIMINATOR,
  WITHDRAW_REQUESTED_EVENT_DISCRIMINATOR,
  getDepositRequestedEventDecoder,
  getEpochStruckEventDecoder,
  getRoundPayoutClaimedEventDecoder,
  getRoundTicketReturnedEventDecoder,
  getRoundTicketSettledEventDecoder,
  getTicketJoinedEventDecoder,
  getTicketOpenedEventDecoder,
  getTicketSettledEventDecoder,
  getWithdrawRequestedEventDecoder,
} from "../../../clients/js/src/generated/fade/index.ts";
import { decodeTicketExpired } from "../../../clients/js/src/direct/index.ts";
import { BPS, marginBps as marginOfLhs } from "../../web/src/lib/math.ts";
import {
  ACTIVITY_WINDOW_S,
  APPS_WINDOW_S,
  activityTickets,
  afterStrike,
  closeInForce,
  netDeposits,
  statsByApp,
  thinStrikes,
  volumeSums,
  type StrikeCounters,
  type ViewTicket,
} from "../../web/src/lib/vaultViews.ts";
import { startsWith } from "./chain.ts";
import { eventBodiesOf, type JsonTx } from "./statsIndex.ts";

const HOUR = 3_600;
const DAY = 86_400;
/** The days the served series reach back. */
export const SERIES_DAYS = 30;
/** How far before the series' start their closes are served (lib/vaultViews `thinStrikes`). */
const SERIES_LEAD_S = 2 * HOUR;
/** How long the index keeps a ticket, a close and a request: the series' 30 days, and a day. */
export const VIEWS_KEPT_S = SERIES_DAYS * DAY + DAY;
/**
 * The newest tickets, and the newest deposit and withdrawal requests, the feed serves: the
 * FEED_TICKETS opened last (the order the vault's Activity lists them in), and the FEED_TICKETS
 * whose last event is the newest (the order the live draws show them in), each once.
 */
export const FEED_TICKETS = 120;
export const FEED_REQUESTS = 60;
/**
 * How long after the loop last found the index current (every listed transaction read) the
 * views still say they are complete: past it, the loop stopped reading the program (an RPC
 * outage), and the app reads the history itself until it reads again.
 */
export const INDEX_FRESH_S = 180;
/**
 * The events a version of the index records beyond the all-time totals: 1 the APR's
 * (aprIndex.ts), 2 the vault views' too. An index that recorded its transactions with an earlier
 * version reads its last APR_KEPT_S again, once (stats.ts, step 4).
 */
export const RECORDED_EVENTS_VERSION = 2;

/** What a program transaction says for the vault views. */
export type VaultEvent =
  | {
      kind: "opened";
      ticket: Address;
      integrator: Address;
      price: bigint;
      payoutMax: bigint;
      vaultCredit: bigint;
      marginBps: bigint;
      appShareBps: bigint;
    }
  | {
      kind: "joined";
      ticket: Address;
      integrator: Address;
      price: bigint;
      payoutMax: bigint;
      vaultCredit: bigint;
      payoutTable: Address;
      appShare: bigint;
    }
  | {
      kind: "settled";
      ticket: Address;
      integrator: Address;
      payout: bigint;
      pending: boolean;
      beacon: boolean;
    }
  /**
   * A direct ticket closed without a draw: forfeited (`refund` 0), or, `refunded`, its vault
   * credit paid back to its beneficiary (`refund_expired_ticket`), booked as a payout of that
   * credit: no result, its price and shares counted as at any end. `parked`: that credit waits
   * in escrow for `claim_payout`.
   */
  | {
      kind: "expired";
      ticket: Address;
      integrator: Address;
      refund: bigint;
      refunded: boolean;
      parked: boolean;
    }
  /** A beacon ticket of a round that never drew: forfeited, or refunded (its price back). */
  | { kind: "returned"; ticket: Address; refunded: boolean; parked: boolean }
  /** What a ticket's end parked, delivered. */
  | { kind: "claimed"; ticket: Address }
  | ({ kind: "struck"; epochId: bigint } & StrikeCounters)
  | { kind: "deposit"; amount: bigint }
  | { kind: "withdrawal"; shares: bigint };

/** The vault views' events of a successful transaction, in order. */
export function vaultEventsOf(tx: JsonTx, program: Address): VaultEvent[] {
  const out: VaultEvent[] = [];
  for (const body of eventBodiesOf(tx, program)) {
    try {
      if (startsWith(body, TICKET_OPENED_EVENT_DISCRIMINATOR)) {
        const e = getTicketOpenedEventDecoder().decode(body);
        out.push({
          kind: "opened",
          ticket: e.ticket,
          integrator: e.integrator,
          price: e.price,
          payoutMax: e.payoutMax,
          vaultCredit: e.vaultCredit,
          marginBps: e.marginBps,
          appShareBps: e.appShareBps,
        });
      } else if (startsWith(body, TICKET_JOINED_EVENT_DISCRIMINATOR)) {
        const e = getTicketJoinedEventDecoder().decode(body);
        out.push({
          kind: "joined",
          ticket: e.ticket,
          integrator: e.integrator,
          price: e.price,
          payoutMax: e.payoutMax,
          vaultCredit: e.vaultCredit,
          payoutTable: e.payoutTable,
          appShare: e.appShare,
        });
      } else if (startsWith(body, TICKET_SETTLED_EVENT_DISCRIMINATOR)) {
        const e = getTicketSettledEventDecoder().decode(body);
        out.push({
          kind: "settled",
          ticket: e.ticket,
          integrator: e.integrator,
          payout: e.payout,
          pending: e.pending,
          beacon: false,
        });
      } else if (startsWith(body, ROUND_TICKET_SETTLED_EVENT_DISCRIMINATOR)) {
        const e = getRoundTicketSettledEventDecoder().decode(body);
        out.push({
          kind: "settled",
          ticket: e.ticket,
          integrator: e.integrator,
          payout: e.payout,
          pending: e.pending,
          beacon: true,
        });
      } else if (startsWith(body, TICKET_EXPIRED_EVENT_DISCRIMINATOR)) {
        const e = decodeTicketExpired(body);
        out.push({
          kind: "expired",
          ticket: e.ticket,
          integrator: e.integrator,
          refund: e.version === 2 ? e.refund : 0n,
          refunded: e.version === 2 && e.refunded,
          parked: e.version === 2 && e.parked,
        });
      } else if (startsWith(body, ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR)) {
        const e = getRoundTicketReturnedEventDecoder().decode(body);
        out.push({ kind: "returned", ticket: e.ticket, refunded: e.refunded, parked: e.parked });
      } else if (startsWith(body, ROUND_PAYOUT_CLAIMED_EVENT_DISCRIMINATOR)) {
        const e = getRoundPayoutClaimedEventDecoder().decode(body);
        out.push({ kind: "claimed", ticket: e.ticket });
      } else if (startsWith(body, EPOCH_STRUCK_EVENT_DISCRIMINATOR)) {
        const e = getEpochStruckEventDecoder().decode(body);
        out.push({
          kind: "struck",
          epochId: e.epochId,
          totalAssets: e.totalAssets,
          totalShares: e.totalShares,
          deposits: e.deposits,
          sharesMinted: e.sharesMinted,
          assetsPaid: e.assetsPaid,
          sharesBurnt: e.sharesBurnt,
        });
      } else if (startsWith(body, DEPOSIT_REQUESTED_EVENT_DISCRIMINATOR)) {
        const e = getDepositRequestedEventDecoder().decode(body);
        out.push({ kind: "deposit", amount: e.amount });
      } else if (startsWith(body, WITHDRAW_REQUESTED_EVENT_DISCRIMINATOR)) {
        const e = getWithdrawRequestedEventDecoder().decode(body);
        out.push({ kind: "withdrawal", shares: e.shares });
      }
    } catch {
      // not a decodable Fade event
    }
  }
  return out;
}

/** A ticket as the index stores it: its opening and its end, each null until read. */
export type StoredVaultTicket = {
  ticket: Address;
  /** Null for a beacon ticket whose return was read without its join (a return names none). */
  integrator: Address | null;
  beacon: boolean;
  opened: {
    at: number | null;
    signature: string;
    price: bigint;
    payoutMax: bigint;
    vaultCredit: bigint;
    /** A direct ticket's; a beacon ticket's is its payout table's. */
    marginBps: bigint;
    /** A direct ticket's; a beacon ticket's is its app share over its price, rounded down. */
    appShareBps: bigint;
    /** A beacon ticket's payout table and app share in micro-USDC. */
    payoutTable: Address | null;
    appShare: bigint;
  } | null;
  end: {
    kind: "settled" | "expired";
    payout: bigint;
    /** What the end paid, a refunded price, or a returned credit, waits in escrow. */
    pending: boolean;
    /** A beacon ticket's price back. */
    refunded: boolean;
    /** A direct ticket's vault credit back: its `payout`, no draw. */
    creditReturned: boolean;
    at: number | null;
    signature: string;
  } | null;
  /** A `RoundPayoutClaimed` delivered what the end parked. */
  claimed: boolean;
};

/** A beacon ticket's app share in basis points of its price, as the app reads its join. */
export const appShareBpsOf = (appShare: bigint, price: bigint) =>
  price > 0n ? (appShare * BPS) / price : 0n;

/** A stored ticket with its opening as the per-app figures read it (lib/vaultViews). */
export function viewTicketOf(t: StoredVaultTicket): ViewTicket | null {
  const o = t.opened;
  if (!o || t.integrator === null) return null;
  return {
    integrator: t.integrator,
    price: o.price,
    vaultCredit: o.vaultCredit,
    appShareBps: o.appShareBps,
    openedAt: o.at,
    ...(t.beacon ? { beacon: { appShare: o.appShare } } : {}),
    end: t.end && {
      payout: t.end.payout,
      refunded: t.end.refunded,
      creditReturned: t.end.creditReturned,
      at: t.end.at,
    },
  };
}

// --- GET /v1/vault ---------------------------------------------------------------------------

/** GET /v1/vault: what the vault page shows of the program's history. */
export type VaultView = {
  /** ISO 8601: when this answer was built. */
  updatedAt: string;
  /**
   * The index is still reading the history, has not read the last 7 days in full, or has not
   * read the program for INDEX_FRESH_S: the app's own figures are the better ones meanwhile.
   */
  syncing: boolean;
  /** The same for the series: they reach back SERIES_DAYS, and are partial until read that far. */
  seriesSyncing: boolean;
  /** Unix seconds from which every transaction is recorded; null while that is not known yet. */
  coveredFrom: number | null;
  /** "Where the vault earns": each app's tickets opened over the last 7 days. */
  apps: {
    windowDays: 7;
    /** Largest volume first; micro-USDC as decimal strings, a negative result signed. */
    rows: {
      integrator: string;
      /** The app's key, from its integrator record; null until the record is read. */
      authority: string | null;
      tickets: number;
      volume: string;
      result: string;
      settled: number;
    }[];
  };
  /** The Activity tab's figures over the last 24 h. */
  activity: { windowHours: 24; tickets: number; paid: string; result: string; net: string };
  series: {
    /**
     * Oldest first: the vault after the closes back to 30 days and two hours (and, before
     * them, the close in force at their start and the one in force at each withdrawal kept),
     * thinned as lib/vaultViews `thinStrikes` says: every close the app looks up (a range's
     * start, a withdrawal's time) is kept.
     */
    strikes: { t: number; epochId: string; price: string; assets: string }[];
    /** Micro-USDC of tickets opened per hour from `from` (a whole hour), the last hour to now. */
    volume: { from: number; bucket: 3600; sums: string[] };
  };
};

export type VaultInputs = {
  /** Tickets opened over the last SERIES_DAYS or ended over the last day, in any order. */
  tickets: readonly StoredVaultTicket[];
  /** Every close kept, oldest first. */
  strikes: readonly ({ t: number; epochId: bigint } & StrikeCounters)[];
  /** The app key of each integrator record read. */
  authorities: ReadonlyMap<Address, Address>;
  /** Unix seconds. */
  now: number;
  /** Unix seconds from which every transaction is recorded (0: the whole history). */
  coveredFrom: number;
  /** The first read of the history is done. */
  caughtUp: boolean;
  /** Unix seconds: when the loop last found the index current; null before it ever did. */
  currentAt: number | null;
  /** Unix seconds of the withdrawal requests kept: the app values each at the close in force. */
  withdrawalsAt: readonly number[];
};

/** Whether the index reads the program still: caught up, and current within INDEX_FRESH_S. */
const fresh = (i: { caughtUp: boolean; currentAt: number | null; now: number }) =>
  i.caughtUp && i.currentAt !== null && i.now - i.currentAt <= INDEX_FRESH_S;

/** The answer of GET /v1/vault from what the index recorded. */
export function vaultView(i: VaultInputs): VaultView {
  const { now, coveredFrom } = i;
  const opened = i.tickets.flatMap((t) => viewTicketOf(t) ?? []);
  const appsSince = now - APPS_WINDOW_S;
  const apps = [
    ...statsByApp({ rows: opened.filter((r) => r.openedAt !== null && r.openedAt >= appsSince) }),
  ]
    .sort(([, a], [, b]) =>
      a.volume === b.volume ? b.tickets - a.tickets : a.volume > b.volume ? -1 : 1,
    )
    .map(([integrator, s]) => ({
      integrator,
      authority: i.authorities.get(integrator) ?? null,
      tickets: s.tickets,
      volume: s.volume.toString(),
      result: s.result.toString(),
      settled: s.settled,
    }));
  // a replay still under way covers less than the day: its figures count from where it reached
  const activitySince = Math.max(now - ACTIVITY_WINDOW_S, coveredFrom);
  const activity = activityTickets(opened, activitySince);
  const net = netDeposits(i.strikes, now - ACTIVITY_WINDOW_S);

  const start = Math.max(now - SERIES_DAYS * DAY, coveredFrom);
  const priced = i.strikes.flatMap((s) => {
    const { assets, price } = afterStrike(s);
    return price === null ? [] : [{ t: s.t, epochId: s.epochId, price, assets }];
  });
  // from a little before the start: the app's clock may run behind the build's
  const seriesFrom = start - SERIES_LEAD_S;
  const earlier = priced.filter((p) => p.t < seriesFrom);
  // before it, the close in force at its start (the value at the start) and the one in force at
  // each withdrawal served earlier still (the feed's requests reach back VIEWS_KEPT_S)
  const lead = new Set<number>(earlier.length ? [earlier.length - 1] : []);
  for (const t of i.withdrawalsAt) if (t < seriesFrom) lead.add(closeInForce(earlier, t));
  const strikes = thinStrikes(
    [...earlier.filter((_, k) => lead.has(k)), ...priced.filter((p) => p.t >= seriesFrom)],
    now,
    // the close in force just before the start, the last of those before it, stays too
    [seriesFrom - 1, ...i.withdrawalsAt],
  ).map((p) => ({
    t: p.t,
    epochId: p.epochId.toString(),
    price: p.price.toString(),
    assets: p.assets.toString(),
  }));
  let firstOpened = Infinity;
  for (const r of opened)
    if (r.openedAt !== null && r.openedAt < firstOpened) firstOpened = r.openedAt;
  const nowHour = Math.floor(now / HOUR) * HOUR;
  // the hour the 30 days start in counts in full, as the chart counts the hour its range starts
  // in (lib/vaultViews `rebucket`); the hour a replay under way reached into, partly read, not
  const startHour =
    coveredFrom > now - SERIES_DAYS * DAY
      ? Math.ceil(start / HOUR) * HOUR
      : Math.floor(start / HOUR) * HOUR;
  const hourFrom = Math.min(
    nowHour,
    Math.max(
      Number.isFinite(start) ? startHour : nowHour,
      Number.isFinite(firstOpened) ? Math.floor(firstOpened / HOUR) * HOUR : nowHour,
    ),
  );
  const sums = volumeSums({ rows: opened }, hourFrom, now, HOUR).map(String);
  return {
    updatedAt: new Date(now * 1_000).toISOString(),
    syncing: !fresh(i) || coveredFrom > appsSince,
    seriesSyncing: !fresh(i) || coveredFrom > now - SERIES_DAYS * DAY,
    coveredFrom: Number.isFinite(coveredFrom) ? coveredFrom : null,
    apps: { windowDays: 7, rows: apps },
    activity: {
      windowHours: 24,
      tickets: activity.n,
      paid: activity.paid.toString(),
      result: activity.result.toString(),
      net: net.toString(),
    },
    series: { strikes, volume: { from: hourFrom, bucket: HOUR, sums } },
  };
}

// --- GET /v1/feed ----------------------------------------------------------------------------

/** One ticket of the feed: its opening and its end as the app's ticket rows read them. */
export type FeedTicket = {
  ticket: string;
  integrator: string | null;
  /** A ticket of the shared beacon. */
  beacon: boolean;
  /** Null when its opening is older than the index keeps, or not read yet. */
  opened: {
    at: number | null;
    signature: string;
    price: string;
    payoutMax: string;
    vaultCredit: string;
    /** A beacon ticket's is its payout table's, "0" while the table is not read. */
    marginBps: string;
  } | null;
  /** Null while the ticket is drawing. */
  end: {
    kind: "settled" | "expired";
    payout: string;
    pending: boolean;
    refunded: boolean;
    creditReturned: boolean;
    at: number | null;
    signature: string;
  } | null;
};

/** One deposit or withdrawal request of the feed. */
export type FeedRequest = (
  { kind: "deposit"; amount: string } | { kind: "withdrawal"; shares: string }
) & { at: number | null; signature: string; index: number };

/** GET /v1/feed: the newest tickets and requests, newest first, with their signatures. */
export type FeedView = {
  /** ISO 8601: when this answer was built. */
  updatedAt: string;
  /**
   * The index has not read every ticket the feed reaches back to yet, or has not read the
   * program for INDEX_FRESH_S.
   */
  syncing: boolean;
  /** The same for the requests, which reach back further than the tickets (they are rarer). */
  requestsSyncing: boolean;
  /**
   * The FEED_TICKETS tickets opened last and the FEED_TICKETS whose last event is the newest, each
   * once, newest event first.
   */
  tickets: FeedTicket[];
  /**
   * Unix seconds from which every ticket opened (a ticket whose opening is not kept: ended) is in
   * `tickets`: the oldest of those opened last when there are FEED_TICKETS of them, else 0 (every
   * ticket the index keeps). Older ones are there only for a recent event.
   */
  ticketsFrom: number;
  /** The newest FEED_REQUESTS deposit and withdrawal requests. */
  requests: FeedRequest[];
};

export type StoredRequest = (
  { kind: "deposit"; amount: bigint } | { kind: "withdrawal"; shares: bigint }
) & { at: number | null; signature: string; index: number };

export type FeedInputs = {
  /** The tickets opened last (ended, when their opening is not kept), at most FEED_TICKETS. */
  tickets: readonly StoredVaultTicket[];
  /** The tickets whose last event is the newest, at most FEED_TICKETS (some among `tickets`). */
  recent?: readonly StoredVaultTicket[];
  /** The newest requests first, at most FEED_REQUESTS. */
  requests: readonly StoredRequest[];
  /** `Σ p·m` of each payout table read. */
  lhs: ReadonlyMap<Address, bigint>;
  now: number;
  coveredFrom: number;
  caughtUp: boolean;
  currentAt: number | null;
};

/** A stored ticket as the feed serves it: a beacon ticket's margin read from its payout table. */
export function feedTicketOf(t: StoredVaultTicket, lhs: ReadonlyMap<Address, bigint>): FeedTicket {
  const o = t.opened;
  let marginBps = o?.marginBps ?? 0n;
  if (o && t.beacon) {
    const l = o.payoutTable === null ? undefined : lhs.get(o.payoutTable);
    marginBps = l === undefined ? 0n : (marginOfLhs(l) ?? 0n);
  }
  return {
    ticket: t.ticket,
    integrator: t.integrator,
    beacon: t.beacon,
    opened: o && {
      at: o.at,
      signature: o.signature,
      price: o.price.toString(),
      payoutMax: o.payoutMax.toString(),
      vaultCredit: o.vaultCredit.toString(),
      marginBps: marginBps.toString(),
    },
    end: t.end && {
      kind: t.end.kind,
      payout: t.end.payout.toString(),
      // delivered since: nothing waits any more
      pending: t.end.pending && !t.claimed,
      refunded: t.end.refunded,
      creditReturned: t.end.creditReturned,
      at: t.end.at,
      signature: t.end.signature,
    },
  };
}

/** The answer of GET /v1/feed from what the index recorded. */
export function feedView(i: FeedInputs): FeedView {
  // each list is complete once the history is covered from the oldest of it served, or, short
  // of a full list, over the whole window the index keeps
  const floorOf = (ats: readonly (number | null)[], full: boolean) => {
    if (!full) return i.now - VIEWS_KEPT_S;
    let floor = i.now;
    for (const at of ats) if (at !== null && at < floor) floor = at;
    return floor;
  };
  const ticketsFloor = floorOf(
    i.tickets.map((t) => t.opened?.at ?? t.end?.at ?? null),
    i.tickets.length >= FEED_TICKETS,
  );
  const held = new Set(i.tickets.map((t) => t.ticket));
  const lastOf = (t: StoredVaultTicket) => Math.max(t.opened?.at ?? 0, t.end?.at ?? 0);
  const tickets = [...i.tickets, ...(i.recent ?? []).filter((t) => !held.has(t.ticket))].sort(
    (a, b) => lastOf(b) - lastOf(a),
  );
  const requestsFloor = floorOf(
    i.requests.map((r) => r.at),
    i.requests.length >= FEED_REQUESTS,
  );
  return {
    updatedAt: new Date(i.now * 1_000).toISOString(),
    syncing: !fresh(i) || i.coveredFrom > ticketsFloor,
    requestsSyncing: !fresh(i) || i.coveredFrom > requestsFloor,
    tickets: tickets.map((t) => feedTicketOf(t, i.lhs)),
    // short of a full list, every ticket the index keeps is served
    ticketsFrom: i.tickets.length >= FEED_TICKETS ? ticketsFloor : 0,
    requests: i.requests.map((r) => ({
      ...(r.kind === "deposit"
        ? { kind: "deposit" as const, amount: r.amount.toString() }
        : { kind: "withdrawal" as const, shares: r.shares.toString() }),
      at: r.at,
      signature: r.signature,
      index: r.index,
    })),
  };
}
