// POST /v1/beacon/wake (apps/keeper/src/index.ts): the app's notice after a beacon join. It
// only asks the beacon loop for a tick, behind the per-IP limit and the app's CORS.
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

type Env = Record<string, unknown>;
// Imported by a computed path: the Workers types it needs are the keeper's own typecheck's.
const WORKER_MODULE = "../../../apps/keeper/src/index.ts";
const { default: worker } = (await import(WORKER_MODULE)) as {
  default: { fetch(request: Request, env: Env): Promise<Response> };
};

function env(options: { beacon?: boolean | "off"; limited?: boolean } = {}) {
  const wakes: number[] = [];
  const limits: string[] = [];
  const stub = { wake: async () => (wakes.push(1), options.beacon !== "off") };
  const e = {
    KEEPER_SECRET_KEY: "unused",
    RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        limits.push(key);
        return { success: !options.limited };
      },
    },
    ...(options.beacon === false
      ? {}
      : { BEACON: { idFromName: (n: string) => n, get: () => stub } }),
  } as Env;
  return { e, wakes, limits };
}

const wake = (headers: Record<string, string> = {}, body?: string) =>
  new Request("https://api.fade.finance/v1/beacon/wake", {
    method: "POST",
    headers: { Origin: "https://app.fade.finance", "CF-Connecting-IP": "203.0.113.7", ...headers },
    ...(body === undefined ? {} : { body }),
  });

describe("POST /v1/beacon/wake", () => {
  it("asks the beacon loop for a tick, with the app's CORS headers", async () => {
    const { e, wakes, limits } = env();
    const r = await worker.fetch(wake(), e);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ status: "scheduled" });
    expect(wakes).toHaveLength(1);
    expect(limits).toEqual(["beacon-wake:203.0.113.7"]);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://app.fade.finance");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reads no body: whatever is sent, the loop only ticks", async () => {
    const { e, wakes } = env();
    const r = await worker.fetch(wake({}, "{not json"), e);
    expect(r.status).toBe(202);
    expect(wakes).toHaveLength(1);
  });

  it("is rate limited per IP, without waking anything", async () => {
    const { e, wakes } = env({ limited: true });
    const r = await worker.fetch(wake(), e);
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "rate limited" });
    expect(wakes).toHaveLength(0);
  });

  it("is a no-op while the beacon is off or not deployed", async () => {
    const off = env({ beacon: "off" });
    const r = await worker.fetch(wake(), off.e);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "disabled" });
    const none = env({ beacon: false });
    const r2 = await worker.fetch(wake(), none.e);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ status: "disabled" });
  });

  it("answers the preflight for the app, and gives another origin no CORS grant", async () => {
    const { e, wakes } = env();
    const pre = await worker.fetch(
      new Request("https://api.fade.finance/v1/beacon/wake", {
        method: "OPTIONS",
        headers: { Origin: "https://app.fade.finance" },
      }),
      e,
    );
    expect(pre.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("https://app.fade.finance");
    const other = await worker.fetch(wake({ Origin: "https://evil.example" }), e);
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(wakes).toHaveLength(1);
  });

  it("refuses another method", async () => {
    const { e, wakes } = env();
    const r = await worker.fetch(
      new Request("https://api.fade.finance/v1/beacon/wake", { method: "GET" }),
      e,
    );
    expect(r.status).toBe(404);
    expect(wakes).toHaveLength(0);
  });
});

describe("the pause recommendation both health routes show", () => {
  function pauseEnv(direct: boolean, beacon: boolean | "off") {
    const keeperStub = {
      health: async () => ({ keeper: "k", pauseRecommended: direct }),
      directPause: async () => direct,
    };
    const beaconStub = {
      status: async () =>
        beacon === "off" ? { enabled: false } : { enabled: true, pauseRecommended: beacon },
    };
    return {
      KEEPER_SECRET_KEY: "unused",
      KEEPER: { idFromName: (n: string) => n, get: () => keeperStub },
      BEACON: { idFromName: (n: string) => n, get: () => beaconStub },
    } as Env;
  }
  const get = async (path: string, e: Env) =>
    (await (await worker.fetch(new Request(`https://api.fade.finance${path}`), e)).json()) as {
      pauseRecommended: boolean;
      directPauseRecommended: boolean;
      beaconPauseRecommended: boolean | null;
    };

  it("is the direct path's alarm or the beacon's, on /v1/health and /v1/beacon alike", async () => {
    for (const [direct, beacon, want] of [
      [false, false, false],
      [true, false, true],
      [false, true, true],
      [true, "off", true],
      [false, "off", false],
    ] as const) {
      const e = pauseEnv(direct, beacon);
      for (const path of ["/v1/health", "/v1/beacon"]) {
        const body = await get(path, e);
        expect(body.pauseRecommended, `${path} ${direct} ${beacon}`).toBe(want);
        expect(body.directPauseRecommended).toBe(direct);
        expect(body.beaconPauseRecommended).toBe(beacon === "off" ? null : beacon);
      }
    }
  });
});
