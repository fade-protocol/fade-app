// The Fade keeper's Worker, at api.fade.finance:
//
//   POST /v1/tickets          { "ticket": "<base58>" } → 202 { "status": "queued" }
//   GET  /v1/tickets/:address the keeper's record of a ticket
//   GET  /v1/health           the keeper's address, balance, last tick and queue
//   POST /v1/rpc              JSON-RPC proxy to the devnet RPC, read methods and sends only
//   GET  /v1/faucet           the faucet's amount and what is left today
//   POST /v1/faucet           { "owner": "<base58>" } → test USDC (and a little SOL) to that wallet
//   GET  /v1/stats            all-time ticket figures (wins, paid to winners, biggest and last win),
//                             open to any origin, cached 30 s
//
// The ticket routes and the health route are served by the Keeper Durable
// Object, which also runs the crank loop on its alarm.
import { Faucet, type ClaimResult } from "./faucet.ts";
import { Keeper, type EnqueueResult } from "./keeper.ts";
import { Stats } from "./stats.ts";
import { DEFAULT_RPC_URL } from "./chain.ts";

export { Faucet, Keeper, Stats };

export interface Env {
  KEEPER: DurableObjectNamespace<Keeper>;
  FAUCET: DurableObjectNamespace<Faucet>;
  STATS: DurableObjectNamespace<Stats>;
  KEEPER_SECRET_KEY: string;
  FAUCET_SECRET_KEY?: string;
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

/** Public figures any page may read (the landing too): any origin, cached for 30 s. */
function publicJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=30",
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
  const { success } = await env.RATE_LIMITER.limit({ key: `${scope}:${ip}` });
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
        return json(request, await keeper(env).health());
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
    ]);
    for (const r of results)
      if (r.status === "rejected") console.error(`cron: ${String(r.reason)}`);
  },
} satisfies ExportedHandler<Env>;
