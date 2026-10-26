// The vault's APR as the keeper serves it (GET /v1/apr): the vault margin of the tickets opened
// in the last 7 days, annualised, now and hourly over the last 30 days. The keeper indexes every
// program transaction and works it out with the same arithmetic (lib/apr), so every visitor gets
// it in one request; the app works it out itself from the tickets it reads only when the keeper
// cannot be reached (pages/vault/Apr.tsx).
import type { AprEstimate } from "./apr";
import { API_URL } from "./config";

export type VaultApr = {
  /** The keeper is still reading the history: the figures may be short of their value. */
  syncing: boolean;
  /** The APR now, as the headline reads it. */
  now: AprEstimate;
  /** Oldest first, a point each whole hour, then now; a null value is a week of fewer than 5 tickets. */
  series: { t: number; v: number | null }[];
};

const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const amount = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);
const pctOf = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** The answer of GET /v1/apr; null when it does not read as one. */
export function parseVaultApr(j: unknown): VaultApr | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const n = o.now as Record<string, unknown> | null | undefined;
  if (!n || typeof n !== "object" || !Array.isArray(o.series)) return null;
  const pct = pctOf(n.pct);
  const tickets = count(n.tickets);
  const volume = amount(n.volume);
  const margin = amount(n.margin);
  if (pct === undefined || tickets === null || volume === null || margin === null) return null;
  const series: VaultApr["series"] = [];
  for (const p of o.series as unknown[]) {
    const q = p as Record<string, unknown> | null;
    const v = pctOf(q?.pct);
    if (!q || typeof q.t !== "number" || !Number.isFinite(q.t) || v === undefined) return null;
    series.push({ t: q.t, v });
  }
  if (!series.length) return null;
  return { syncing: o.syncing === true, now: { pct, tickets, volume, margin }, series };
}

let inFlight: Promise<VaultApr> | null = null;
let last: VaultApr | null = null;

/** The last answer read on this page: what a page opened later shows while it reads again. */
export const lastVaultApr = (): VaultApr | null => last;

/** An answer pushed by the keeper (lib/live): read as the route's, and kept as the last one. */
export function acceptVaultApr(j: unknown): VaultApr | null {
  const apr = parseVaultApr(j);
  if (apr) last = apr;
  return apr;
}

/**
 * The keeper's APR; throws when it cannot be reached or answers something else. Callers on the
 * same page share one request.
 */
export function fetchVaultApr(): Promise<VaultApr> {
  inFlight ??= (async () => {
    const r = await fetch(`${API_URL}/v1/apr`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!r.ok) throw new Error(`the APR service answered HTTP ${r.status}`);
    const apr = parseVaultApr(await r.json());
    if (!apr) throw new Error("the APR service answered an unreadable body");
    last = apr;
    return apr;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Whether the app works the APR out itself: the keeper did not answer, or answers while still
 * reading the history.
 */
export const needsOwnApr = (keeper: VaultApr | null, failed: boolean): boolean =>
  keeper ? keeper.syncing : failed;

/**
 * The APR to show: the keeper's once it answers in full; else the app's own from the tickets it
 * read, or the keeper's partial one while the app has none; null (a skeleton) while waiting.
 */
export function chooseApr(keeper: VaultApr | null, own: AprEstimate | null): AprEstimate | null {
  if (keeper && !keeper.syncing) return keeper.now;
  return own ?? keeper?.now ?? null;
}
