// The app's side of the keeper's vault views (GET /v1/vault and GET /v1/feed): reading the
// answers, against a local stub of the routes serving what the keeper builds; choosing between
// them and the app's own reads, the latest read and the answer's age weighed; the Vault chart's
// ticket volume over the keeper's hourly sums, equal to the app's own over the same tickets and
// the same window; and the windows the labels name.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Address } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  feedView,
  vaultView,
  type FeedView,
  type StoredVaultTicket,
  type VaultView,
} from "../../../apps/keeper/src/vaultIndex.ts";
import type { TicketLog } from "../../../apps/web/src/lib/ticketLog.ts";
import { rebucket, volumeSums } from "../../../apps/web/src/lib/vaultViews.ts";
import { rng, USDC } from "./fixtures.ts";

const HOUR = 3_600;
const DAY = 86_400;
const NOW = 1_800_000_000;
const A = (s: string) => s.padEnd(32, "1") as Address;

/** A month of tickets, one in three still drawing, some won, a few refunded. */
function tickets(seed: number, n: number): StoredVaultTicket[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const at = NOW - r.int(30 * DAY);
    const price = r.big(10_000n, 5n * USDC);
    const k = r.int(6);
    return {
      ticket: A(`t${i}`),
      integrator: A(`app${r.int(3)}`),
      beacon: k === 5,
      opened: {
        at,
        signature: `open${i}`,
        price,
        payoutMax: price * 10n,
        vaultCredit: price,
        marginBps: 350n,
        appShareBps: 0n,
        payoutTable: null,
        appShare: 0n,
      },
      end:
        k < 2
          ? null
          : {
              kind: k === 5 ? "expired" : "settled",
              payout: k === 2 ? price * 10n : 0n,
              pending: false,
              refunded: k === 5,
              creditReturned: false,
              at: at + 30,
              signature: `end${i}`,
            },
      claimed: false,
    };
  });
}

const stored = tickets(11, 600);
const vaultAnswer = (syncing = false): VaultView => ({
  ...vaultView({
    tickets: stored,
    strikes: Array.from({ length: 60 }, (_, i) => ({
      t: NOW - 40 * DAY + i * 16 * HOUR,
      epochId: BigInt(i),
      totalAssets: 1_000n * USDC,
      totalShares: 1_000n * 1_000_000_000n,
      deposits: 5n * USDC,
      sharesMinted: 0n,
      assetsPaid: 0n,
      sharesBurnt: 0n,
    })),
    authorities: new Map([[A("app0"), A("key0")]]),
    now: NOW,
    coveredFrom: 0,
    caughtUp: true,
    currentAt: NOW,
    withdrawalsAt: [],
  }),
  syncing,
});
const feedAnswer = (): FeedView =>
  feedView({
    tickets: [...stored]
      .sort((a, b) => (b.end?.at ?? b.opened!.at!) - (a.end?.at ?? a.opened!.at!))
      .slice(0, 120),
    requests: [
      { kind: "deposit", amount: 5n * USDC, at: NOW - 60, signature: "dep", index: 0 },
      { kind: "withdrawal", shares: 2n * 1_000_000_000n, at: NOW - 120, signature: "wd", index: 1 },
    ],
    lhs: new Map(),
    now: NOW,
    coveredFrom: 0,
    caughtUp: true,
    currentAt: NOW,
  });

// Served on a local port; the app's config reads VITE_API_URL when its modules load.
const bodies: Record<string, unknown> = { "/v1/vault": vaultAnswer(), "/v1/feed": feedAnswer() };
let status = 200;
const requests: string[] = [];
let server: Server;
let lib: typeof import("../../../apps/web/src/lib/keeperViews.ts");
let figures: typeof import("../../../apps/web/src/lib/vaultFigures.ts");
beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const body = bodies[req.url ?? ""];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.VITE_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // the app's config, read again with it (the keeper's modules loaded it already)
  vi.resetModules();
  lib = await import("../../../apps/web/src/lib/keeperViews.ts");
  figures = await import("../../../apps/web/src/lib/vaultFigures.ts");
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("the keeper's vault history, read by the app", () => {
  it("reads each answer at once, one request per route for every caller on the page", async () => {
    status = 200;
    requests.length = 0;
    const started = performance.now();
    const [a, b, f, g] = await Promise.all([
      lib.fetchKeeperVault(),
      lib.fetchKeeperVault(),
      lib.fetchKeeperFeed(),
      lib.fetchKeeperFeed(),
    ]);
    // one local round trip per route: no transaction of the program is read
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(requests.sort()).toEqual(["/v1/feed", "/v1/vault"]);
    expect(a).toBe(b);
    expect(f).toBe(g);
    expect(lib.lastKeeperVault()).toBe(a);
    expect(lib.lastKeeperFeed()).toBe(f);

    const served = bodies["/v1/vault"] as VaultView;
    expect(a.syncing).toBe(false);
    expect(a.apps.length).toBe(served.apps.rows.length);
    expect(a.apps[0]).toEqual({
      integrator: served.apps.rows[0]!.integrator,
      authority: served.apps.rows[0]!.authority,
      tickets: served.apps.rows[0]!.tickets,
      volume: BigInt(served.apps.rows[0]!.volume),
      result: BigInt(served.apps.rows[0]!.result),
      settled: served.apps.rows[0]!.settled,
    });
    // a negative vault result reads as one
    expect(a.apps.some((x) => x.result < 0n)).toBe(true);
    expect(a.activity.n).toBe(served.activity.tickets);
    expect(a.strikes.length).toBe(served.series.strikes.length);
    expect(a.volume.sums.map(String)).toEqual(served.series.volume.sums);

    const feed = bodies["/v1/feed"] as FeedView;
    expect(f.rows.length + f.loneEnds.length).toBe(feed.tickets.length);
    const drawing = f.rows.find((r) => !r.end)!;
    expect(drawing.openSig).toMatch(/^open/);
    const refunded = f.rows.find((r) => r.end?.refunded)!;
    expect(refunded).toMatchObject({ beacon: true, end: { kind: "expired", payout: 0n } });
    expect(f.requests).toEqual([
      { kind: "deposit", amount: 5n * USDC, at: NOW - 60, signature: "dep", index: 0 },
      { kind: "withdrawal", shares: 2n * 1_000_000_000n, at: NOW - 120, signature: "wd", index: 1 },
    ]);
  });

  it("weighs an answer's age by the keeper's clock, whatever the visitor's", async () => {
    const keeper = lib.parseKeeperVault(JSON.parse(JSON.stringify(vaultAnswer())))!;
    // the route's answer carries the keeper's clock (its `Date` header, exposed to the app)
    status = 200;
    const read = await lib.fetchKeeperVault();
    expect(read.arrival).toBeDefined();
    expect(read.arrival!.ageThen).toBeGreaterThanOrEqual(0);
    // a visitor's clock 8 minutes fast: an answer served 5 s after it was built is fresh
    const fast = lib.arrived(keeper, NOW + 5, NOW + 5 + 480);
    expect(lib.ageOf(fast, NOW + 500)).toBe(20);
    expect(lib.vaultAsRead(fast, false, NOW + 500)).toBe(fast);
    // the same visitor weighed by its own clock alone would turn the keeper off
    expect(lib.vaultAsRead(keeper, false, NOW + 500)!.syncing).toBe(true);
    // a visitor's clock 10 minutes slow: a keeper still serving an answer built 10 minutes before
    // is stalled, however recent the answer looks to that clock
    const slow = lib.arrived(keeper, NOW + 600, NOW);
    expect(lib.vaultAsRead(slow, false, NOW)!.syncing).toBe(true);
    expect(lib.vaultAsRead(keeper, false, NOW)!.syncing).toBe(false);
    // the age grows by the visitor's clock from there, a difference of its own readings
    const feed = lib.parseKeeperFeed(JSON.parse(JSON.stringify(feedAnswer())))!;
    const pushed = lib.arrived(feed, NOW + 10, NOW - 3_600);
    expect(lib.feedAsRead(pushed, false, NOW - 3_600 + lib.FEED_MAX_AGE_S - 10)).toBe(pushed);
    expect(lib.feedAsRead(pushed, false, NOW - 3_600 + lib.FEED_MAX_AGE_S - 9)!.syncing).toBe(true);
    // a pushed answer: dated by the message's `at`; one that does not say, by the visitor's clock
    const viaPush = lib.acceptKeeperFeed(JSON.parse(JSON.stringify(feedAnswer())), NOW + 30)!;
    expect(viaPush.arrival?.ageThen).toBe(30);
    expect(lib.acceptKeeperFeed(JSON.parse(JSON.stringify(feedAnswer())))!.arrival).toBeUndefined();
  });

  it("throws on an error or an unreadable body, and the app reads the history itself", async () => {
    status = 503;
    await expect(lib.fetchKeeperVault()).rejects.toThrow(/HTTP 503/);
    await expect(lib.fetchKeeperFeed()).rejects.toThrow(/HTTP 503/);
    status = 200;
    const kept = bodies["/v1/vault"];
    bodies["/v1/vault"] = { apps: { rows: [] } };
    await expect(lib.fetchKeeperVault()).rejects.toThrow(/unreadable/);
    bodies["/v1/vault"] = kept;
    expect(lib.needsOwn(null, true)).toBe(true);
    // waiting for the first answer: nothing of its own read yet, a skeleton
    expect(lib.needsOwn(null, false)).toBe(false);
    expect(lib.chooseView(null, null)).toBeNull();
  });

  it("parses only what reads as the keeper's answers", () => {
    const vault = JSON.parse(JSON.stringify(vaultAnswer())) as VaultView;
    expect(lib.parseKeeperVault(vault)).not.toBeNull();
    const badRow = {
      ...vault,
      apps: { ...vault.apps, rows: [{ ...vault.apps.rows[0], volume: "-1" }] },
    };
    expect(lib.parseKeeperVault(badRow)).toBeNull();
    const badStrike = { ...vault, series: { ...vault.series, strikes: [{ t: 1 }] } };
    expect(lib.parseKeeperVault(badStrike)).toBeNull();
    const noVolume = { ...vault, series: { ...vault.series, volume: { from: 0, sums: [] } } };
    expect(lib.parseKeeperVault(noVolume)).toBeNull();
    const feed = JSON.parse(JSON.stringify(feedAnswer())) as FeedView;
    expect(lib.parseKeeperFeed(feed)).not.toBeNull();
    const badEnd = { ...feed, tickets: [{ ...feed.tickets[0], end: { kind: "won" } }] };
    expect(lib.parseKeeperFeed(badEnd)).toBeNull();
    const badRequest = {
      ...feed,
      requests: [{ kind: "deposit", amount: "x", at: 1, signature: "s", index: 0 }],
    };
    expect(lib.parseKeeperFeed(badRequest)).toBeNull();
    expect(lib.parseKeeperFeed(null)).toBeNull();
    // a ticket whose opening the keeper no longer keeps: its end alone
    const lone = { ...feed, tickets: [{ ...feed.tickets.find((t) => t.end)!, opened: null }] };
    expect(lib.parseKeeperFeed(lone)!.loneEnds.length).toBe(1);
  });

  it("prefers the keeper's answer, the app's own only while the keeper syncs or is down", () => {
    const keeper = lib.parseKeeperVault(JSON.parse(JSON.stringify(vaultAnswer())))!;
    const syncing = { ...keeper, syncing: true };
    const own = { rows: [] };
    expect(lib.chooseView(keeper, own)).toEqual({ keeper });
    expect(lib.needsOwn(syncing, false)).toBe(true);
    expect(lib.chooseView(syncing, own)).toEqual({ own });
    // the keeper's partial answer is never shown as a final one: a skeleton until the app has
    // its own, unless the caller shows it as partial (lines true on their own, a labelled period)
    expect(lib.chooseView(syncing, null)).toBeNull();
    expect(lib.chooseView(syncing, null, undefined, lib.asPartial)).toEqual({ keeper: syncing });
    expect(lib.chooseView(syncing, null, undefined, (k) => k.coveredFrom !== null)).toEqual({
      keeper: syncing,
    });
    expect(
      lib.chooseView(
        { ...syncing, coveredFrom: null },
        null,
        undefined,
        (k) => k.coveredFrom !== null,
      ),
    ).toBeNull();
    expect(lib.chooseView(null, own)).toEqual({ own });
    // a part of the answer on its own: the series, while the 30 days are not read
    const partialSeries = { ...keeper, seriesSyncing: true };
    expect(lib.chooseView(partialSeries, own)).toEqual({ keeper: partialSeries });
    expect(lib.chooseView(partialSeries, own, (k) => k.seriesSyncing)).toEqual({ own });
  });

  it("falls back once the latest read fails or the answer is old, the kept one shown meanwhile", () => {
    const keeper = lib.parseKeeperVault(JSON.parse(JSON.stringify(vaultAnswer())))!;
    const feed = lib.parseKeeperFeed(JSON.parse(JSON.stringify(feedAnswer())))!;
    expect(keeper.updatedAt).toBe(NOW);
    expect(feed.updatedAt).toBe(NOW);
    expect([keeper.syncing, keeper.seriesSyncing, feed.syncing, feed.requestsSyncing]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    const own = { rows: [] };
    // fresh and read: the keeper's, nothing read of the app's own
    expect(lib.vaultAsRead(keeper, false, NOW + 60)).toBe(keeper);
    expect(lib.feedAsRead(feed, false, NOW + 60)).toBe(feed);
    expect(lib.needsOwn(lib.feedAsRead(feed, false, NOW + 60), false)).toBe(false);
    // Home open, the first feed answered, every read after it failing: the app reads its own
    const failing = lib.feedAsRead(feed, true, NOW + 20)!;
    expect(failing).toMatchObject({ syncing: true, requestsSyncing: true, rows: feed.rows });
    expect(lib.needsOwn(failing, true)).toBe(true);
    // the kept lines until the app's own arrive, then the app's own
    expect(lib.chooseView(failing, null, undefined, lib.asPartial)).toEqual({ keeper: failing });
    expect(lib.chooseView(failing, own)).toEqual({ own });
    // answering still, but an answer built long ago: the keeper serves one it cannot rebuild
    expect(lib.feedAsRead(feed, false, NOW + lib.FEED_MAX_AGE_S)).toBe(feed);
    const oldFeed = lib.feedAsRead(feed, false, NOW + lib.FEED_MAX_AGE_S + 1)!;
    expect(lib.needsOwn(oldFeed, false)).toBe(true);
    expect(lib.chooseView(oldFeed, own, (f) => f.requestsSyncing)).toEqual({ own });
    expect(lib.vaultAsRead(keeper, false, NOW + lib.VAULT_MAX_AGE_S)).toBe(keeper);
    const oldVault = lib.vaultAsRead(keeper, false, NOW + lib.VAULT_MAX_AGE_S + 1)!;
    expect(oldVault).toMatchObject({ syncing: true, seriesSyncing: true });
    expect(lib.needsOwn(oldVault, false)).toBe(true);
    // read again and fresh: the keeper's once more
    expect(lib.vaultAsRead(keeper, false, NOW)).toBe(keeper);
    expect(lib.vaultAsRead(null, true, NOW)).toBeNull();
    // an answer that does not date itself does not read as one
    const { updatedAt: _v, ...undatedVault } = JSON.parse(JSON.stringify(vaultAnswer()));
    expect(lib.parseKeeperVault(undatedVault)).toBeNull();
    const { updatedAt: _f, ...undatedFeed } = JSON.parse(JSON.stringify(feedAnswer()));
    expect(lib.parseKeeperFeed(undatedFeed)).toBeNull();
    // nor says its parts are complete when it does not say so
    const { requestsSyncing: _r, ...noRequestsFlag } = JSON.parse(JSON.stringify(feedAnswer()));
    expect(lib.parseKeeperFeed(noRequestsFlag)!.requestsSyncing).toBe(true);
    const { seriesSyncing: _s, ...noSeriesFlag } = JSON.parse(JSON.stringify(vaultAnswer()));
    expect(lib.parseKeeperVault(noSeriesFlag)!.seriesSyncing).toBe(true);
  });
});

describe("the Vault chart's ticket volume over the keeper's hourly sums", () => {
  const log = {
    rows: stored.map((t) => ({ price: t.opened!.price, openedAt: t.opened!.at, end: t.end })),
  };
  const view = vaultAnswer().series.volume;
  const volume = { from: view.from, sums: view.sums.map(BigInt) };

  /** The app's own ticket log over the same tickets, newest first. */
  const ownLog = (): TicketLog =>
    ({
      rows: [...log.rows].sort((a, b) => b.openedAt! - a.openedAt!),
      loneEnds: [],
      from: null,
      truncated: false,
    }) as unknown as TicketLog;

  it("totals what the app's own chart totals over the same window, a whole period a point", () => {
    const step = { "1D": HOUR, "7D": 6 * HOUR, "1M": DAY, ALL: DAY } as const;
    expect(NOW % HOUR).toBe(0);
    for (const range of ["1D", "7D", "1M", "ALL"] as const) {
      const v = figures.volumeChartView(range, volume, NOW);
      expect(v.to).toBe(NOW);
      expect(v.unit).toBe("USDC of tickets");
      // the first point at the hour the range starts in, the others on whole periods
      expect(v.from).toBe(v.points[0]!.t);
      expect(v.from).toBe(Math.floor(figures.windowStart(range, view.from, NOW) / HOUR) * HOUR);
      expect(v.points.slice(1).every((p) => p.t % step[range] === 0)).toBe(true);
      expect(v.points.length).toBeLessThanOrEqual(50);
      // each point is what the app sums over the tickets opened in its period
      const own = volumeSums(log, v.points[1]!.t, NOW, step[range]);
      expect(v.points.slice(1).map((p) => p.v)).toEqual(own.map((s) => Number(s) / 1e6));
      // the headline: the app's own chart's, over the same window
      const app = figures.chartView("volume", range, null, ownLog(), NOW)!;
      expect(v.headline).toBeCloseTo(app.headline!, 6);
    }
    // ALL is what the keeper serves: from the first ticket's hour
    expect(figures.volumeChartView("ALL", volume, NOW).from).toBe(view.from);
  });

  it("counts nothing from before the hour the range starts in", () => {
    // 14:30 on the 7D range (6 h periods): the hours from 12:00 to 14:00 seven days ago are out
    const now = NOW + 14 * HOUR + 1_800 - (NOW % DAY);
    const at = vaultView({
      tickets: stored,
      strikes: [],
      authorities: new Map(),
      now,
      coveredFrom: 0,
      caughtUp: true,
      currentAt: now,
      withdrawalsAt: [],
    }).series.volume;
    const hourly = { from: at.from, sums: at.sums.map(BigInt) };
    for (const range of ["1D", "7D", "1M"] as const) {
      const v = figures.volumeChartView(range, hourly, now);
      const start = figures.windowStart(range, at.from, now);
      const app = figures.chartView("volume", range, null, ownLog(), now)!;
      // the app's own from `start`; the keeper's from its hour: the part of that hour before it
      const startHour = Math.floor(start / HOUR) * HOUR;
      const before = log.rows
        .filter((r) => r.openedAt! >= startHour && r.openedAt! < start && !r.end?.refunded)
        .reduce((s, r) => s + Number(r.price) / 1e6, 0);
      expect(v.from).toBe(startHour);
      expect(v.headline! - app.headline!).toBeCloseTo(before, 6);
    }
  });

  it("gathers hourly sums into any whole period as the app's own sums would", () => {
    const r = rng(29);
    for (let k = 0; k < 200; k++) {
      const hourFrom = Math.floor((NOW - r.int(40 * DAY)) / HOUR) * HOUR;
      const now = hourFrom + 1 + r.int(30 * DAY);
      const rows = Array.from({ length: r.int(60) }, () => ({
        price: r.big(1n, 10n * USDC),
        openedAt: hourFrom + r.int(now - hourFrom + 1),
        end: null,
      }));
      const hourly = volumeSums({ rows }, hourFrom, now, HOUR);
      for (const bucket of [HOUR, 6 * HOUR, DAY]) {
        const from = hourFrom + r.int(now - hourFrom);
        const got = rebucket(hourFrom, hourly, bucket, from);
        const startHour = Math.max(hourFrom, Math.floor(from / HOUR) * HOUR);
        expect(got[0]!.t).toBe(Math.max(Math.floor(from / bucket) * bucket, startHour));
        // nothing from before the hour `from` falls in: the app's own total from that hour
        const total = got.reduce((s, p) => s + p.v, 0n);
        expect(total).toBe(volumeSums({ rows }, startHour, now, now - startHour + 1)[0]);
        // from the first whole period on, every sum is the app's over the same period
        if (got.length > 1) {
          const own = volumeSums({ rows }, got[1]!.t, now, bucket);
          expect(got.slice(1).map((p) => p.v)).toEqual(own);
        }
      }
    }
  });
});

describe("the windows the labels name", () => {
  it("names the 7 days, or how far back a capped read reaches", async () => {
    expect(figures.windowLabel(7 * DAY)).toBe("7D");
    expect(figures.windowLabel(9 * DAY)).toBe("7D");
    expect(figures.windowLabel(2 * DAY + 5)).toBe("2D");
    expect(figures.windowLabel(14 * HOUR)).toBe("14 h");
    expect(figures.windowLabel(60)).toBe("1 h");
    expect(figures.windowWords(7 * DAY)).toBe("7 days");
    expect(figures.windowWords(DAY)).toBe("1 day");
    expect(figures.windowWords(3 * HOUR)).toBe("3 hours");
    expect(figures.windowWords(HOUR)).toBe("1 hour");
  });
});
