// The keeper's HTTP API. After the user's `open_ticket` confirms, the app hands
// the ticket to the keeper, which requests the randomness, waits for ORAO and
// settles: the user signs once. The keeper holds no authority over the ticket:
// anyone may send those two steps, so the app can always finish it itself.
import type { Address, Signature } from "@solana/kit";
import { API_URL } from "./config";

export type KeeperState = "queued" | "requested" | "fulfilled" | "settled" | "expired" | "unknown";

export type KeeperTicket = {
  state: KeeperState;
  openSlot?: number;
  requestSignature?: Signature;
  settleSignature?: Signature;
  expireSignature?: Signature;
  outcome?: number;
  /** USDC base units. */
  payout?: bigint;
  updatedAt?: string;
};

const STATES: readonly KeeperState[] = [
  "queued",
  "requested",
  "fulfilled",
  "settled",
  "expired",
  "unknown",
];

async function call(path: string, init: RequestInit = {}, timeoutMs = 6_000): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Hands a confirmed ticket to the keeper. False when the keeper cannot be reached or declines. */
export async function submitTicket(ticket: Address): Promise<boolean> {
  try {
    const r = await call("/v1/tickets", { method: "POST", body: JSON.stringify({ ticket }) });
    return r.ok;
  } catch {
    return false;
  }
}

/** The keeper's view of a ticket; throws when the keeper cannot be reached. */
export async function ticketStatus(ticket: Address): Promise<KeeperTicket> {
  const r = await call(`/v1/tickets/${ticket}`);
  if (!r.ok) throw new Error(`the delivery service answered HTTP ${r.status}`);
  const j = (await r.json()) as Record<string, unknown>;
  const state = STATES.includes(j.state as KeeperState) ? (j.state as KeeperState) : "unknown";
  const out: KeeperTicket = { state };
  if (typeof j.openSlot === "number") out.openSlot = j.openSlot;
  if (typeof j.requestSignature === "string")
    out.requestSignature = j.requestSignature as Signature;
  if (typeof j.settleSignature === "string") out.settleSignature = j.settleSignature as Signature;
  if (typeof j.expireSignature === "string") out.expireSignature = j.expireSignature as Signature;
  if (typeof j.outcome === "number") out.outcome = j.outcome;
  if (typeof j.payout === "string" && /^\d+$/.test(j.payout)) out.payout = BigInt(j.payout);
  if (typeof j.updatedAt === "string") out.updatedAt = j.updatedAt;
  return out;
}

export type FaucetClaim =
  | { ok: true; signature: Signature; usdc: bigint; sol: bigint }
  | { ok: false; error: string; retryAt?: number };

/**
 * Asks the keeper's faucet for test USDC (and a little SOL when the wallet has
 * almost none). The faucet allows one claim every 5 minutes and refuses
 * before spending anything: the app only calls it on a click.
 */
export async function claimFaucet(owner: Address): Promise<FaucetClaim> {
  let r: Response;
  try {
    r = await call("/v1/faucet", { method: "POST", body: JSON.stringify({ owner }) }, 20_000);
  } catch {
    return {
      ok: false,
      error: "The free USDC service could not be reached. Try again in a moment.",
    };
  }
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    const out: FaucetClaim = {
      ok: false,
      error:
        typeof j.error === "string" ? j.error : `the free USDC service answered HTTP ${r.status}`,
    };
    if (typeof j.retryAt === "number") out.retryAt = j.retryAt;
    return out;
  }
  return {
    ok: true,
    signature: j.signature as Signature,
    usdc: BigInt(typeof j.usdc === "string" ? j.usdc : "0"),
    sol: BigInt(typeof j.sol === "string" ? j.sol : "0"),
  };
}
