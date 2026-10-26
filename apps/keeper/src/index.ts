// The Fade keeper's Worker, at api.fade.finance:
//
//   POST /v1/tickets          { "ticket": "<base58>" } → 202 { "status": "queued" }
//   GET  /v1/tickets/:address the keeper's record of a ticket
//   GET  /v1/health           the keeper's address, balance, last tick and queue, the direct
//                             withheld alarm, and `pauseRecommended`: the direct path's alarm or
//                             the beacon's, the same flag /v1/beacon shows
//   POST /v1/rpc              JSON-RPC proxy to the devnet RPC, read methods and sends only
//   GET  /v1/faucet           the faucet's amount and what is left today
//   POST /v1/faucet           { "owner": "<base58>" } → test USDC (and a little SOL) to that wallet
//   GET  /v1/stats            all-time ticket figures (wins, paid to winners, biggest and last win),
//                             open to any origin, cached 30 s
//   GET  /v1/apr              the vault's APR over a trailing 7 days, now and hourly over the
//                             last 30 days (src/aprIndex.ts), open to any origin, cached 30 s
//   GET  /v1/vault            the vault page's public history (src/vaultIndex.ts): each app's
//                             tickets, volume and vault result over 7 days, the last 24 h's
//                             figures, the share price and assets after each close and the
//                             hourly ticket volume over 30 days; built at most once a minute,
//                             open to any origin, cached 30 s
//   GET  /v1/feed             the newest tickets (opened, drawn, won, expired, refunded; direct
//                             and beacon) and deposit and withdrawal requests, newest first, with
//                             their signatures; built at most every 5 s, open to any origin,
//                             cached 5 s
//   GET  /v1/providers        every liquidity provider (src/providersIndex.ts): fvUSDC, deposits
//                             waiting for a price, fvUSDC queued out, value, vault share and
//                             first deposit, largest holding first; read from the chain at most
//                             every 2 minutes, open to any origin, cached 60 s
//   GET  /v1/wallet/:address  one wallet's history (src/walletIndex.ts): its tickets (those its
//                             own app opened and those paying out to it, both paths, with
//                             their ends and parked payouts), the newest 500 and the counts
//                             over all of them, and its deposits and withdrawals (requests,
//                             claims, deliveries); up to when every transaction is in it;
//                             built at most every 10 s per wallet (one build at a time, from
//                             at most 12 000 stored transactions: a larger wallet is answered
//                             `oversized`), rate-limited per IP, open to any origin, cached 15 s
//   GET  /v1/live             a WebSocket pushing what the routes above serve as it changes
//                             (src/liveHub.ts, apps/web/src/lib/liveProtocol.ts): the answers
//                             of /v1/feed, /v1/stats, /v1/apr, /v1/vault and /v1/providers to
//                             the connections subscribed to them, and a notification to those
//                             subscribed to a wallet when its new transactions are indexed;
//                             held by the Stats Durable Object with the Hibernation API,
//                             connection attempts rate-limited per IP, open to any origin
//   GET  /v1/beacon           the shared beacon's loop: { "enabled": false } until
//                             BEACON_ENABLED is set; then its rounds, transactions in
//                             flight and alarms (src/beacon.ts); either way
//                             `pauseRecommended`, the beacon's alarms or the direct path's
//                             (a beacon set to run but unreadable or misconfigured counts
//                             as recommending a pause)
//   POST /v1/beacon/wake      a join just confirmed → 202 { "status": "scheduled" }, or
//                             { "status": "disabled" } while the beacon is off: the loop
//                             ticks now and keeps its 5 s pace for a minute; no body is
//                             read, nothing is changed but the alarm (src/beacon.ts `wake`)
//
// The ticket routes and the health route are served by the Keeper Durable
// Object, which also runs the crank loop on its alarm.
import { BeaconKeeper, type BeaconStatus } from "./beacon.ts";
import type { BeaconEnvVars } from "./beaconPolicy.ts";
import { Faucet, type ClaimResult } from "./faucet.ts";
import { Keeper, type EnqueueResult } from "./keeper.ts";
import { Stats } from "./stats.ts";
import { clientKey } from "./liveHub.ts";
import { isAddress } from "@solana/kit";
import { DEFAULT_RPC_URL, describeError } from "./chain.ts";
import { beaconPauseOf, combinedPause } from "./directPolicy.ts";

export { BeaconKeeper, Faucet, Keeper, Stats };

export interface Env extends BeaconEnvVars {
  KEEPER: DurableObjectNamespace<Keeper>;
  FAUCET: DurableObjectNamespace<Faucet>;
  STATS: DurableObjectNamespace<Stats>;
  /** Optional until the beacon loop is deployed: a Worker without it serves no /v1/beacon. */
  BEACON?: DurableObjectNamespace<BeaconKeeper>;
  KEEPER_SECRET_KEY: string;
  FAUCET_SECRET_KEY?: string;
  /**
   * The operator's acknowledgements of direct withheld expiries reviewed and found to be false
   * positives: a JSON array of `{ ordinal, reason }` (apps/keeper/src/directPolicy.ts
   * `parseWithheldAcknowledgements`).
   */
  DIRECT_ACKNOWLEDGED_WITHHELD?: string;
  RPC_URL?: string;
  RATE_LIMITER?: RateLimit;
}

const ALLOWED_ORIGINS = new Set(["https://app.fade.finance"]);
/** Any local dev server, whatever its port. */
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/;

const allowedOrigin = (origin: string) => ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin);

/** Methods the proxy forwards: reads, plus sending and simulating a signed transaction. */
const RPC_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getBlockTime",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getHealth",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getTransaction",
  "getVersion",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);
const MAX_BATCH = 20;
const MAX_BODY_BYTES = 64 * 1024;

const keeper = (env: Env) => env.KEEPER.get(env.KEEPER.idFromName("keeper"));
const faucet = (env: Env) => env.FAUCET.get(env.FAUCET.idFromName("faucet"));
const stats = (env: Env) => env.STATS.get(env.STATS.idFromName("stats"));
const beacon = (env: Env) => env.BEACON?.get(env.BEACON.idFromName("beacon")) ?? null;

/** The beacon's own pause recommendation; null while it is off, true when it cannot be read. */
async function beaconPause(env: Env): Promise<boolean | null> {
  const b = beacon(env);
  if (!b) return null;
  return beaconPauseOf(await b.status().catch(() => undefined));
}

function corsHeaders(request: Request): Headers {
  const h = new Headers();
  const origin = request.headers.get("Origin");
  if (origin && allowedOrigin(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    h.set(
      "Access-Control-Allow-Headers",
      request.headers.get("Access-Control-Request-Headers") ?? "content-type",
    );
    h.set("Access-Control-Max-Age", "86400");
  }
  h.set("Vary", "Origin");
  return h;
}

function json(request: Request, body: unknown, status = 200): Response {
  const h = corsHeaders(request);
  h.set("Content-Type", "application/json");
  h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

/**
 * Public figures any page may read (the landing too): any origin, cached for `maxAge` seconds.
 * The app reads the `Date` header: the keeper's clock, against which it weighs an answer's age.
 */
function publicJson(body: unknown, maxAge = 30): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Date",
      "Cache-Control": `public, max-age=${maxAge}`,
    },
  });
}

const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

/** Per-IP limit through the Rate Limiting binding; open if the binding is missing. */
async function limited(request: Request, env: Env, scope: string): Promise<boolean> {
  if (!env.RATE_LIMITER) return false;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  // the live push and the wallets' history count an IPv6 address by its /64, as the hub does
  const key = scope === "live" || scope === "wallet" ? clientKey(ip) : ip;
  const { success } = await env.RATE_LIMITER.limit({ key: `${scope}:${key}` });
  return !success;
}

async function proxyRpc(request: Request, env: Env): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json(request, rpcError(null, -32600, "too large"), 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(request, rpcError(null, -32700, "parse error"), 400);
  }
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > MAX_BATCH)
    return json(request, rpcError(null, -32600, `batch of 1 to ${MAX_BATCH} calls`), 400);
  for (const c of calls) {
    const method = (c as { method?: unknown } | null)?.method;
    if (typeof method !== "string" || !RPC_METHODS.has(method)) {
      const id = (c as { id?: unknown } | null)?.id;
      return json(request, rpcError(id, -32601, `method not allowed: ${String(method)}`), 403);
    }
  }
  const upstream = await fetch(env.RPC_URL || DEFAULT_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "fade-keeper/0.1" },
    body: text,
  });
  const h = corsHeaders(request);
  h.set("Content-Type", "application/json");
  h.set("Cache-Control", "no-store");
  const retryAfter = upstream.headers.get("Retry-After");
  if (retryAfter) h.set("Retry-After", retryAfter);
  return new Response(upstream.body, { status: upstream.status, headers: h });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request) });
    try {
      if (path === "/v1/health" && request.method === "GET") {
        const [h, b] = await Promise.all([keeper(env).health(), beaconPause(env)]);
        return json(request, {
          ...h,
          pauseRecommended: combinedPause(h.pauseRecommended ?? true, b),
          directPauseRecommended: h.pauseRecommended ?? true,
          beaconPauseRecommended: b,
        });
      }
      if (path === "/v1/tickets" && request.method === "POST") {
        if (await limited(request, env, "tickets"))
          return json(request, { error: "rate limited" }, 429);
        let ticket: unknown;
        try {
          ticket = ((await request.json()) as { ticket?: unknown } | null)?.ticket;
        } catch {
          return json(request, { error: "body must be JSON" }, 400);
        }
        if (typeof ticket !== "string") return json(request, { error: "missing ticket" }, 400);
        const res: EnqueueResult = await keeper(env).enqueue(ticket);
        if (!res.ok) return json(request, { error: res.error }, res.status);
        return json(request, { status: "queued" }, 202);
      }
      const m = /^\/v1\/tickets\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
      if (m?.[1] && request.method === "GET") {
        return json(request, await keeper(env).status(m[1]));
      }
      if (path === "/v1/faucet" && request.method === "GET") {
        return json(request, await faucet(env).info());
      }
      if (path === "/v1/faucet" && request.method === "POST") {
        if (await limited(request, env, "faucet"))
          return json(request, { error: "rate limited" }, 429);
        let owner: unknown;
        try {
          owner = ((await request.json()) as { owner?: unknown } | null)?.owner;
        } catch {
          return json(request, { error: "body must be JSON" }, 400);
        }
        if (typeof owner !== "string") return json(request, { error: "missing owner" }, 400);
        const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
        const res: ClaimResult = await faucet(env).claim(owner, ip);
        if (!res.ok)
          return json(request, { error: res.error, retryAt: res.retryAt ?? null }, res.status);
        return json(request, { signature: res.signature, usdc: res.usdc, sol: res.sol });
      }
      if (path === "/v1/stats" && request.method === "GET") {
        return publicJson(await stats(env).stats());
      }
      if (path === "/v1/apr" && request.method === "GET") {
        return publicJson(await stats(env).apr());
      }
      if (path === "/v1/vault" && request.method === "GET") {
        return publicJson(await stats(env).vault());
      }
      if (path === "/v1/feed" && request.method === "GET") {
        return publicJson(await stats(env).feed(), 5);
      }
      if (path === "/v1/providers" && request.method === "GET") {
        return publicJson(await stats(env).providers(), 60);
      }
      if (path === "/v1/live" && request.method === "GET") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
          return json(request, { error: "expected a WebSocket upgrade" }, 426);
        if (await limited(request, env, "live"))
          return json(request, { error: "rate limited" }, 429);
        return await stats(env).fetch(request);
      }
      const w = /^\/v1\/wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
      if (w?.[1] && request.method === "GET") {
        if (await limited(request, env, "wallet"))
          return json(request, { error: "rate limited" }, 429);
        if (!isAddress(w[1])) return json(request, { error: "not an address" }, 400);
        return publicJson(await stats(env).wallet(w[1]), 15);
      }
      if (path === "/v1/beacon" && request.method === "GET") {
        const b = beacon(env);
        const [status, direct] = await Promise.all([
          b
            ? b.status().catch((e: unknown): BeaconStatus => ({
                enabled: false,
                error: describeError(e),
              }))
            : Promise.resolve<BeaconStatus>({ enabled: false }),
          // an unreadable keeper fails closed, as the direct alarm does
          keeper(env)
            .directPause()
            .catch(() => true),
        ]);
        // a beacon meant to run but unreadable fails closed (`beaconPauseOf`)
        const own = beaconPauseOf(status);
        return json(request, {
          ...status,
          pauseRecommended: combinedPause(direct, own),
          directPauseRecommended: direct,
          beaconPauseRecommended: own,
        });
      }
      if (path === "/v1/beacon/wake" && request.method === "POST") {
        if (await limited(request, env, "beacon-wake"))
          return json(request, { error: "rate limited" }, 429);
        const b = beacon(env);
        const woken = b ? await b.wake() : false;
        return json(request, { status: woken ? "scheduled" : "disabled" }, woken ? 202 : 200);
      }
      if (path === "/v1/rpc" && request.method === "POST") {
        if (await limited(request, env, "rpc"))
          return json(request, rpcError(null, -32005, "rate limited"), 429);
        return await proxyRpc(request, env);
      }
      return json(request, { error: "not found" }, 404);
    } catch (e) {
      console.error(`${request.method} ${path}: ${e instanceof Error ? e.message : String(e)}`);
      return json(request, { error: "internal error" }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // each loop on its own: one that throws must not keep the others down
    const results = await Promise.allSettled([
      keeper(env).ensureAlarm(false),
      stats(env).ensureAlarm(),
      // a no-op until BEACON_ENABLED turns it on
      beacon(env)?.ensureAlarm() ?? Promise.resolve(),
    ]);
    for (const r of results)
      if (r.status === "rejected") console.error(`cron: ${String(r.reason)}`);
  },
} satisfies ExportedHandler<Env>;
