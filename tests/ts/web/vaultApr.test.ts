// The app's side of the keeper's APR (GET /v1/apr): reading the answer, against a local stub of
// the route serving what the keeper builds; choosing between it and the app's own figure; and
// the Vault chart's ranges over its hourly series.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aprTicketOf, aprView, type AprView } from "../../../apps/keeper/src/aprIndex.ts";
import type { AprEstimate } from "../../../apps/web/src/lib/apr.ts";
import type { VaultApr } from "../../../apps/web/src/lib/vaultApr.ts";
import { USDC } from "./fixtures.ts";

const HOUR = 3_600;
const DAY = 86_400;
const NOW = 1_800_000_000;

/** What the keeper answers over a month of steady tickets. */
const keeperAnswer = (syncing = false): AprView =>
  aprView({
    tickets: Array.from({ length: 3_000 }, (_, i) =>
      aprTicketOf(
        {
          openedAt: NOW - i * 1_200,
          price: USDC,
          direct: { marginBps: 300n + BigInt(i % 50), appShareBps: 0n },
          beacon: null,
          refunded: false,
        },
        new Map(),
      ),
    ),
    strikes: [
      { t: NOW - 50 * DAY, assets: 1_000n * USDC },
      { t: NOW - 10 * DAY, assets: 1_500n * USDC },
    ],
    totalAssets: 2_000n * USDC,
    protocolShareBps: 20n,
    now: NOW,
    coveredFrom: 0,
    syncing,
  });

// Served on a local port; the app's config reads VITE_API_URL when its modules load.
let body: unknown = keeperAnswer();
let status = 200;
let requests = 0;
let server: Server;
let lib: typeof import("../../../apps/web/src/lib/vaultApr.ts");
let aprChartView: (typeof import("../../../apps/web/src/lib/vaultFigures.ts"))["aprChartView"];
beforeAll(async () => {
  server = createServer((req, res) => {
    requests += 1;
    if (req.url !== "/v1/apr") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.VITE_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // the app's config, read again with it (the keeper's modules loaded it already)
  vi.resetModules();
  lib = await import("../../../apps/web/src/lib/vaultApr.ts");
  ({ aprChartView } = await import("../../../apps/web/src/lib/vaultFigures.ts"));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("the keeper's APR, read by the app", () => {
  it("reads the answer at once, one request for every caller on the page", async () => {
    body = keeperAnswer();
    status = 200;
    const before = requests;
    const started = performance.now();
    const [a, b] = await Promise.all([lib.fetchVaultApr(), lib.fetchVaultApr()]);
    const ms = performance.now() - started;
    expect(requests - before).toBe(1);
    expect(a).toBe(b);
    // one local round trip: no transaction of the program is read
    expect(ms).toBeLessThan(1_000);
    const served = body as AprView;
    expect(a.syncing).toBe(false);
    expect(a.now).toEqual({
      pct: served.now.pct,
      tickets: served.now.tickets,
      volume: BigInt(served.now.volume),
      margin: BigInt(served.now.margin),
    });
    expect(a.series.length).toBe(served.series.length);
    expect(a.series.at(-1)).toEqual({ t: NOW, v: served.now.pct });
    expect(lib.lastVaultApr()).toBe(a);
    // shown as is: the headline is the keeper's
    expect(lib.chooseApr(a, null)).toEqual(a.now);
    expect(lib.needsOwnApr(a, false)).toBe(false);
  });

  it("throws on an error or an unreadable body, and the app works its own out", async () => {
    status = 503;
    await expect(lib.fetchVaultApr()).rejects.toThrow(/HTTP 503/);
    status = 200;
    body = { now: { pct: "7" }, series: [] };
    await expect(lib.fetchVaultApr()).rejects.toThrow(/unreadable/);
    expect(lib.needsOwnApr(null, true)).toBe(true);
    // waiting for the first answer: no figure of its own, a skeleton
    expect(lib.needsOwnApr(null, false)).toBe(false);
    expect(lib.chooseApr(null, null)).toBeNull();
  });

  it("parses only what reads as the keeper's answer", () => {
    const ok = JSON.parse(JSON.stringify(keeperAnswer())) as Record<string, unknown>;
    expect(lib.parseVaultApr(ok)).not.toBeNull();
    const bad = (over: Record<string, unknown>) => lib.parseVaultApr({ ...ok, ...over });
    expect(bad({ series: [] })).toBeNull();
    expect(bad({ series: [{ t: "x", pct: 1 }] })).toBeNull();
    expect(bad({ now: { pct: 1, tickets: -1, volume: "1", margin: "1" } })).toBeNull();
    expect(bad({ now: { pct: Infinity, tickets: 1, volume: "1", margin: "1" } })).toBeNull();
    expect(bad({ now: { pct: null, tickets: 1, volume: "1", margin: "1" } })?.now.pct).toBeNull();
    expect(lib.parseVaultApr(null)).toBeNull();
  });

  it("prefers the keeper's figure, the app's own only while the keeper syncs or is down", () => {
    const keeper = lib.parseVaultApr(JSON.parse(JSON.stringify(keeperAnswer())))!;
    const syncing: VaultApr = { ...keeper, syncing: true };
    const own: AprEstimate = { pct: 1.5, tickets: 9, volume: 9n * USDC, margin: 1n };
    expect(lib.chooseApr(keeper, own)).toEqual(keeper.now);
    expect(lib.needsOwnApr(syncing, false)).toBe(true);
    expect(lib.chooseApr(syncing, own)).toEqual(own);
    // the keeper's partial figure until the app has one: never a gap when one is computable
    expect(lib.chooseApr(syncing, null)).toEqual(syncing.now);
    expect(lib.chooseApr(null, own)).toEqual(own);
  });
});

describe("the Vault chart over the keeper's series", () => {
  const series = keeperAnswer().series.map((p) => ({ t: p.t, v: p.pct }));

  it("keeps the ranges, one point per period on the whole periods, then now", () => {
    const step = { "1D": HOUR, "7D": 6 * HOUR, "1M": DAY, ALL: DAY } as const;
    const span = { "1D": DAY, "7D": 7 * DAY, "1M": 30 * DAY, ALL: 30 * DAY } as const;
    for (const range of ["1D", "7D", "1M", "ALL"] as const) {
      const view = aprChartView(range, series)!;
      expect(view.to).toBe(NOW);
      expect(view.from).toBe(Math.max(series[0]!.t, NOW - span[range]));
      expect(view.unit).toBe("last 7 days, annualised");
      const pts = view.points;
      expect(pts.at(-1)).toEqual(series.at(-1));
      expect(view.headline).toBe(series.at(-1)!.v);
      expect(pts.slice(0, -1).every((p) => p.t >= view.from && p.t % step[range] === 0)).toBe(true);
      expect(pts.length).toBeLessThanOrEqual(50);
      expect(pts.every((p) => p.v !== null && p.v > 0)).toBe(true);
      expect(view.change).toBeCloseTo(pts.at(-1)!.v! - pts[0]!.v!, 9);
    }
    // ALL is what the keeper serves: its 30 days
    expect(aprChartView("ALL", series)!.from).toBe(series[0]!.t);
    expect(aprChartView("1M", [])).toBeNull();
  });
});

describe("the app's own APR chart", () => {
  it("ends on the headline where a read capped inside the 7 days leaves it blank", async () => {
    const { withAprHeadline } = await import("../../../apps/web/src/lib/vaultFigures.ts");
    const blank = {
      points: [
        { t: NOW - HOUR, v: null },
        { t: NOW, v: null },
      ],
      from: NOW - HOUR,
      to: NOW,
      headline: null,
      unit: "last 7 days, annualised",
      change: null,
    };
    const filled = withAprHeadline(blank, 4.9);
    expect(filled.points.at(-1)).toEqual({ t: NOW, v: 4.9 });
    expect(filled.headline).toBe(4.9);
    expect(filled.change).toBeNull();
    // nothing to fill in, or a last point already drawn: unchanged
    expect(withAprHeadline(blank, null)).toBe(blank);
    const drawn = { ...blank, headline: 3, points: [{ t: NOW, v: 3 }] };
    expect(withAprHeadline(drawn, 4.9)).toBe(drawn);
  });
});
