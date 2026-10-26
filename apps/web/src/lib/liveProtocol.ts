// The keeper's live push (GET /v1/live, a WebSocket): the messages the app and the keeper
// exchange, shared by both (apps/keeper/src/liveHub.ts and lib/live). Pure: no DOM, no Workers
// API.
//
// The app sends `{ "op": "subscribe" | "unsubscribe", "topics": [...], "wallets": [...] }`, and
// the text "ping" (answered "pong" by the runtime itself, without waking the keeper). The keeper
// sends:
//
//   { "type": "view", "topic": <topic>, "at": <Unix seconds>, "data": <the route's answer> }
//       the answer of GET /v1/<topic> (feed, stats, apr, vault, providers), exactly as that route
//       serves it, each time it changes and at least every LIVE_REFRESH_MS while subscribed;
//       `at` is the keeper's clock when the message was made, so the app weighs an answer's age
//       by the keeper's clock, not the visitor's (lib/keeperViews)
//   { "type": "wallet", "wallet": <owner>, "signatures": [...], "at": <Unix seconds> | null }
//       new program transactions of a subscribed wallet were indexed: GET /v1/wallet/:owner
//       holds them; a notification, coalesced (the newest one stands for those before it)
//   { "type": "subscribed", "topics": [...], "wallets": [...] }
//       what the connection is subscribed to, after each op
//   { "type": "error", "error": <why> }
//       sent before the keeper closes a connection that broke a limit

export const LIVE_PATH = "/v1/live";
export const LIVE_TOPICS = ["feed", "stats", "apr", "vault", "providers"] as const;
export type LiveTopic = (typeof LIVE_TOPICS)[number];

export const LIVE_PING = "ping";
export const LIVE_PONG = "pong";

/** The largest op the keeper reads; a larger one closes the connection. */
export const LIVE_MAX_OP_BYTES = 1_024;
/** Wallets one connection may subscribe to at a time. */
export const LIVE_MAX_WALLETS = 4;
/** The keeper sends a subscribed topic's answer at least this often, changed or not. */
export const LIVE_REFRESH_MS = 60_000;

export type LiveOp = { op: "subscribe" | "unsubscribe"; topics: LiveTopic[]; wallets: string[] };

export type LiveWalletMessage = {
  type: "wallet";
  wallet: string;
  signatures: string[];
  at: number | null;
};

export type LiveMessage =
  | { type: "view"; topic: LiveTopic; at: number | null; data: unknown }
  | LiveWalletMessage
  | { type: "subscribed"; topics: LiveTopic[]; wallets: string[] }
  | { type: "error"; error: string };

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isTopic = (v: unknown): v is LiveTopic => LIVE_TOPICS.includes(v as LiveTopic);
const record = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The topics of `v`, each once; null when it is not a list of topics. */
function topicsOf(v: unknown): LiveTopic[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every(isTopic)) return null;
  return [...new Set(v)];
}

/** The base58 addresses of `v`, each once; null when it is not a list of them. */
function walletsOf(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((w) => typeof w === "string" && BASE58.test(w))) return null;
  return [...new Set(v as string[])];
}

/** An op the app sent; null when it does not read as one (or is larger than LIVE_MAX_OP_BYTES). */
export function parseLiveOp(text: string): LiveOp | null {
  if (text.length > LIVE_MAX_OP_BYTES) return null;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const o = record(j);
  if (!o || (o.op !== "subscribe" && o.op !== "unsubscribe")) return null;
  const topics = topicsOf(o.topics);
  const wallets = walletsOf(o.wallets);
  if (!topics || !wallets || wallets.length > LIVE_MAX_WALLETS) return null;
  return { op: o.op, topics, wallets };
}

export const encodeLiveOp = (op: LiveOp): string => JSON.stringify(op);

/** A message of the keeper; null when it does not read as one. */
export function parseLiveMessage(text: string): LiveMessage | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const o = record(j);
  if (!o) return null;
  if (o.type === "view")
    return isTopic(o.topic)
      ? {
          type: "view",
          topic: o.topic,
          // a keeper that does not say: the app's own clock weighs the answer
          at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : null,
          data: o.data,
        }
      : null;
  if (o.type === "wallet") {
    const at =
      o.at === null ? null : typeof o.at === "number" && Number.isFinite(o.at) ? o.at : undefined;
    const signatures = Array.isArray(o.signatures) ? o.signatures : null;
    if (typeof o.wallet !== "string" || !BASE58.test(o.wallet) || at === undefined || !signatures)
      return null;
    if (!signatures.every((s) => typeof s === "string")) return null;
    return { type: "wallet", wallet: o.wallet, signatures: signatures as string[], at };
  }
  if (o.type === "subscribed") {
    const topics = topicsOf(o.topics);
    const wallets = walletsOf(o.wallets);
    return topics && wallets ? { type: "subscribed", topics, wallets } : null;
  }
  if (o.type === "error")
    return { type: "error", error: typeof o.error === "string" ? o.error : "" };
  return null;
}

/** A view message around `json`, the route's answer as it serializes it, made at `at` (Unix seconds). */
export const viewMessage = (topic: LiveTopic, json: string, at: number): string =>
  `{"type":"view","topic":${JSON.stringify(topic)},"at":${Math.floor(at)},"data":${json}}`;
