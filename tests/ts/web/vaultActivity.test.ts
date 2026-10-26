// The Activity tab's lines (lib/vaultActivity): the keeper's newest tickets and requests first,
// then those the app read itself the feed does not hold, so a filter or "Show more" reaches as
// far back as the app's own reads; the requests keyed alike from either source; each
// withdrawal valued at the close in force at its time, the app's own older closes leading the
// keeper's 30 days; the list stopped at the feed's horizon while the program's tickets are not
// read, so its first page has no gap (a round's batch settlement filling the newest events), and
// the program's tickets read only when the lines need them.
import type { Address, Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  feedView,
  type StoredRequest,
  type StoredVaultTicket,
} from "../../../apps/keeper/src/vaultIndex.ts";
import type { LpItem } from "../../../apps/web/src/lib/history.ts";
import { feedHorizon, parseKeeperFeed } from "../../../apps/web/src/lib/keeperViews.ts";
import { priceAt } from "../../../apps/web/src/lib/positionPnl.ts";
import {
  activityRows,
  feedRequestsOf,
  needsOlderTickets,
  requestsOf,
  withOlderCloses,
  withinHorizon,
} from "../../../apps/web/src/lib/vaultActivity.ts";
import { A, DAY, T0, USDC, rng, ticketRow } from "./fixtures.ts";

const NOW = T0;
const FEED_TICKETS = 120;
const FEED_REQUESTS = 60;

/** A ticket the vault kept, as the keeper stores it: opened `ago` seconds before now. */
const stored = (i: number, ago: number): StoredVaultTicket => ({
  ticket: A(`t${i}z`),
  integrator: A("app"),
  beacon: false,
  opened: {
    at: NOW - ago,
    signature: `open${i}`,
    price: USDC,
    payoutMax: 2n * USDC,
    vaultCredit: USDC,
    marginBps: 350n,
    appShareBps: 0n,
    payoutTable: null,
    appShare: 0n,
  },
  end: {
    kind: "settled",
    payout: 0n,
    pending: false,
    refunded: false,
    creditReturned: false,
    at: NOW - ago + 5,
    signature: `end${i}`,
  },
  claimed: false,
});

const feedOf = (
  tickets: StoredVaultTicket[],
  requests: StoredRequest[],
  recent: StoredVaultTicket[] = [],
) =>
  parseKeeperFeed(
    JSON.parse(
      JSON.stringify(
        feedView({
          tickets,
          recent,
          requests,
          lhs: new Map(),
          now: NOW,
          coveredFrom: 0,
          caughtUp: true,
          currentAt: NOW,
        }),
      ),
    ),
  )!;

describe("the Activity tab's lines", () => {
  it("lists, behind the feed's newest tickets, the older ones the app read: a win the feed no longer holds", () => {
    // a ticket every 30 s: the feed's 120 cover the last hour, none of them won
    const feed = feedOf(
      Array.from({ length: FEED_TICKETS }, (_, i) => stored(i, 30 * (i + 1))),
      [],
    );
    expect(feed.rows.length).toBe(FEED_TICKETS);
    // the program's tickets over 7 days: the feed's newest (one still drawing when read), and
    // older ones, a win among them
    const own = [
      ticketRow({ ticket: A("t0z"), openedAt: NOW - 30, end: null }),
      ticketRow({ ticket: A("t1z"), openedAt: NOW - 60 }),
      ...Array.from({ length: 30 }, (_, i) =>
        ticketRow({
          ticket: A(`old${i}z`),
          openedAt: NOW - 2 * DAY - i * 600,
          openSig: `oldOpen${i}` as Signature,
          end: {
            kind: "settled",
            payout: i === 7 ? 3n * USDC : 0n,
            pending: false,
            at: NOW - 2 * DAY - i * 600 + 5,
            signature: `oldEnd${i}` as Signature,
          },
        }),
      ),
    ];
    const rows = activityRows({
      tickets: { head: feed.rows, tail: own },
      requests: { head: [], tail: null },
      prices: [],
      now: NOW,
    });
    // the feed's 120, then the 30 it does not hold: each ticket once, the feed's state kept
    expect(rows.length).toBe(FEED_TICKETS + 30);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(rows.find((r) => r.key === A("t0z"))).toMatchObject({ drawing: false });
    expect(rows.filter((r) => r.older).length).toBe(30);
    expect(rows.slice(0, FEED_TICKETS).every((r) => !r.older)).toBe(true);
    const wins = rows.filter((r) => r.win);
    expect(wins.map((r) => r.key)).toEqual([A("old7z")]);
    expect(wins[0]!.older).toBe(true);
    // newest first
    for (let k = 1; k < rows.length; k++) expect(rows[k - 1]!.t! >= rows[k]!.t!).toBe(true);
  });

  it("lists, behind the feed's newest requests, the older ones of the vault's history, keyed alike", () => {
    const r = rng(5);
    // 100 requests over a month, some transactions holding two, a close's events among them
    const items: LpItem[] = [];
    const requests: StoredRequest[] = [];
    for (let k = 0; k < 70; k++) {
      const signature = `req${k}` as Signature;
      const at = NOW - 3 * DAY - k * 9_000;
      const n = k % 3 === 0 ? 2 : 1;
      const events = [
        ...(k % 4 === 0 ? [{ kind: "EpochStruck", data: {} }] : []),
        ...Array.from({ length: n }, (_, j) =>
          (k + j) % 2
            ? { kind: "WithdrawRequested", data: { shares: r.big(1n, 100n) * 1_000_000_000n } }
            : { kind: "DepositRequested", data: { amount: r.big(1n, 100n) * USDC } },
        ),
      ];
      items.push({ signature, blockTime: at, events: events as never });
      events.forEach((e, j) => {
        if (e.kind === "EpochStruck") return;
        const idx = j - (k % 4 === 0 ? 1 : 0);
        requests.push(
          e.kind === "DepositRequested"
            ? {
                kind: "deposit",
                amount: (e.data as { amount: bigint }).amount,
                at,
                signature,
                index: idx,
              }
            : {
                kind: "withdrawal",
                shares: (e.data as { shares: bigint }).shares,
                at,
                signature,
                index: idx,
              },
        );
      });
    }
    const own = requestsOf(items);
    expect(own.length).toBe(requests.length);
    // the feed holds the newest 60, a transaction's two requests possibly split across its end
    const feed = feedOf([], requests.slice(0, FEED_REQUESTS));
    const head = feedRequestsOf(feed.requests);
    const ownKeys = new Set(own.map((q) => q.key));
    for (const q of head) expect(ownKeys.has(q.key)).toBe(true);
    const price = { t: 0, price: 1_000_000n };
    const rows = activityRows({
      tickets: { head: [], tail: null },
      requests: { head, tail: own },
      prices: [price],
      now: NOW,
    });
    expect(rows.length).toBe(requests.length);
    expect(new Set(rows.map((x) => x.key)).size).toBe(rows.length);
    expect(rows.filter((x) => !x.older).map((x) => x.key)).toEqual(head.map((q) => q.key));
    expect(rows.filter((x) => x.older).length).toBe(requests.length - FEED_REQUESTS);
    // the same lines whatever the source
    const alone = activityRows({
      tickets: { head: [], tail: null },
      requests: { head: own, tail: null },
      prices: [price],
      now: NOW,
    });
    expect(rows.map(({ older: _, ...x }) => x)).toEqual(alone);
  });

  it("values a withdrawal older than the keeper's closes at the app's own close in force", () => {
    // a close every 10 minutes over 40 days, the price rising at each
    const own = Array.from({ length: (40 * DAY) / 600 }, (_, k) => ({
      t: NOW - 40 * DAY + k * 600,
      epochId: BigInt(k),
      price: 1_000_000n + BigInt(k),
      assets: 1_000n * USDC,
    }));
    // the keeper's: from 30 days and two hours, led by the close before
    const from = own.findIndex((p) => p.t >= NOW - 30 * DAY - 7_200);
    const keeper = own.slice(from - 1);
    const live = { t: NOW, epochId: null, price: 2_000_000n, assets: 1_000n * USDC };
    const prices = withOlderCloses(keeper, [...own, live], live);
    expect(prices.length).toBe(own.length + 1);
    for (const t of [
      NOW - 39 * DAY,
      NOW - 31 * DAY,
      NOW - 30.5 * DAY,
      NOW - 30 * DAY - 7_201,
      NOW - 30 * DAY,
      NOW - DAY,
    ])
      expect(priceAt(prices, t)).toBe(priceAt([...own, live], t));
    // without the app's own history, the keeper's alone
    expect(withOlderCloses(keeper, null, live)).toEqual([...keeper, live]);
  });

  it("stops at the feed's horizon until the program's tickets are read: a round settled in one batch leaves no gap", () => {
    const at = (t: StoredVaultTicket) => t.opened!.at!;
    const last = (t: StoredVaultTicket) => Math.max(at(t), t.end?.at ?? 0);
    const ended = (t: StoredVaultTicket, endAt: number): StoredVaultTicket => ({
      ...t,
      end: { ...t.end!, at: endAt },
    });
    // over the last hour: 100 beacon joins, the round settled in one batch 10 s ago, and 60 direct
    // tickets settled within seconds between them; then 40 direct ones over the last 5 minutes
    const joins = Array.from({ length: 100 }, (_, i) => ({
      ...ended(stored(i, 3_600 - i * 34), NOW - 10),
      beacon: true,
    }));
    const direct = Array.from({ length: 60 }, (_, i) => stored(100 + i, 3_590 - i * 55));
    const recentDirect = Array.from({ length: 40 }, (_, i) => stored(200 + i, 300 - i * 7));
    const all = [...joins, ...direct, ...recentDirect];
    const byOpening = [...all].sort((a, b) => at(b) - at(a));
    const byLast = [...all].sort((a, b) => last(b) - last(a));
    // what the app's own reads list: every ticket, by its opening
    const own = activityRows({
      tickets: { head: feedOf(byOpening, []).rows, tail: null },
      requests: { head: [], tail: null },
      prices: [],
      now: NOW,
    });
    const listed = (feed: ReturnType<typeof feedOf>) => {
      const rows = activityRows({
        tickets: { head: feed.rows, tail: null },
        requests: { head: [], tail: null },
        prices: [],
        now: NOW,
      });
      return withinHorizon(rows, feedHorizon(feed), NOW);
    };
    // the keeper serves the 120 opened last and the 120 newest events, and says from when
    const feed = feedOf(byOpening.slice(0, FEED_TICKETS), [], byLast.slice(0, FEED_TICKETS));
    expect(feed.ticketsFrom).toBe(at(byOpening[FEED_TICKETS - 1]!));
    const { shown, held } = listed(feed);
    // every line it shows is the app's own, in its place: no ticket of its time missing
    expect(shown.map((r) => r.key)).toEqual(own.slice(0, shown.length).map((r) => r.key));
    expect(shown.length).toBe(FEED_TICKETS);
    // the joins opened before the horizon, there for their settlement, wait for the older read
    expect(held).toBeGreaterThan(0);
    expect(needsOlderTickets({ filter: "all", count: 40, page: 40, shown: 40, held })).toBe(false);
    expect(needsOlderTickets({ filter: "all", count: 80, page: 40, shown: 80, held })).toBe(true);
    // a keeper that serves the newest events alone, and does not say: the oldest event it serves
    const { ticketsFrom: _, ...old } = JSON.parse(
      JSON.stringify(
        feedView({
          tickets: byLast.slice(0, FEED_TICKETS),
          requests: [],
          lhs: new Map(),
          now: NOW,
          coveredFrom: 0,
          caughtUp: true,
          currentAt: NOW,
        }),
      ),
    );
    const oldFeed = parseKeeperFeed(old)!;
    expect(oldFeed.ticketsFrom).toBeNull();
    const before = listed(oldFeed);
    expect(before.shown.map((r) => r.key)).toEqual(
      own.slice(0, before.shown.length).map((r) => r.key),
    );
    // what the list showed before: the round's joins straight after the newest tickets, the
    // direct tickets of their hour missing
    const uncut = activityRows({
      tickets: { head: oldFeed.rows, tail: null },
      requests: { head: [], tail: null },
      prices: [],
      now: NOW,
    });
    expect(uncut.slice(0, 40).map((r) => r.key)).not.toEqual(own.slice(0, 40).map((r) => r.key));
  });

  it("reads the program's tickets for the lines that need them, never for the requests alone", () => {
    const page = 40;
    // the deposits and withdrawals: "Show more" reads nothing more (finding: lp + Show more)
    expect(needsOlderTickets({ filter: "lp", count: 80, page, shown: 40, held: 0 })).toBe(false);
    expect(needsOlderTickets({ filter: "lp", count: 40, page, shown: 3, held: 9 })).toBe(false);
    // the wins, and "Show more" on the full list
    expect(needsOlderTickets({ filter: "wins", count: 40, page, shown: 0, held: 0 })).toBe(true);
    expect(needsOlderTickets({ filter: "all", count: 80, page, shown: 80, held: 0 })).toBe(true);
    // a first page the horizon cuts short
    expect(needsOlderTickets({ filter: "all", count: 40, page, shown: 12, held: 30 })).toBe(true);
    expect(needsOlderTickets({ filter: "all", count: 40, page, shown: 12, held: 0 })).toBe(false);
    expect(withinHorizon([], null, NOW)).toEqual({ shown: [], held: 0 });
  });
});
