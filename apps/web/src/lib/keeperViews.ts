// The vault page's public history as the keeper serves it: GET /v1/vault (each app's tickets,
// volume and vault result over 7 days, the last 24 h's figures, the share price and assets after
// each close and the hourly ticket volume over 30 days) and GET /v1/feed (the newest tickets and
// deposit and withdrawal requests, with their signatures). The keeper indexes every program
// transaction and works them out with the app's own arithmetic (lib/vaultViews), so every
// visitor gets them in two requests; the app reads the program's recent tickets and the vault's
// history itself only while the keeper's latest answer cannot be trusted: its last read failed,
// the answer is old, or the keeper is still reading the history (or stopped reading the program).
//
// GET /v1/providers serves the liquidity providers the same way: the keeper reads every share
// account, open request and epoch record every few minutes and works the list out with the
// app's own arithmetic (lib/providers), so no visitor scans the share mint; the app scans it
// itself only while the keeper's latest answer cannot be trusted.
//
// Display only: what a deposit, a withdrawal or a ticket is checked against right before its
// signature (the vault's live state, admission, the transaction itself, the connected wallet's
// own position) stays read from the chain by the app.
import type { Address, Signature } from "@solana/kit";
import { API_URL } from "./config";
import {
  providerLines,
  withOwnLine,
  type ProviderLine,
  type ProviderRow,
  type VaultTotals,
} from "./providers";
import type { LpItem } from "./history";
import type { StrikePoint } from "./vaultFigures";

export type KeeperApp = {
  integrator: Address;
  /** The app's key; null until the keeper read its integrator record. */
  authority: Address | null;
  tickets: number;
  volume: bigint;
  result: bigint;
  settled: number;
};

/**
 * When an answer arrived (the visitor's clock, Unix seconds) and how old it was then by the
 * keeper's own clock (the response's `Date`, a pushed message's `at`): its age is weighed with
 * no bias from a visitor's clock that runs fast or slow (`ageOf`).
 */
export type Arrival = { arrivedAt: number; ageThen: number };

/** An answer of the keeper, and how it arrived; `arrival` absent: weighed by the visitor's clock. */
type Aged = { updatedAt: number; arrival?: Arrival };

export type KeeperVault = {
  /** Unix seconds: when the keeper built this answer. */
  updatedAt: number;
  arrival?: Arrival;
  /** Unix seconds from which the keeper recorded every transaction; null while not known yet. */
  coveredFrom: number | null;
  /**
   * The keeper is still reading the history, has not read the last 7 days in full, or stopped
   * reading the program; or this answer is old, or the latest read of it failed (`vaultAsRead`).
   */
  syncing: boolean;
  /** The same for the closes and the hourly volume, which reach back 30 days. */
  seriesSyncing: boolean;
  /** Each app's tickets opened over the last 7 days, largest volume first. */
  apps: KeeperApp[];
  /** The Activity tab's figures over the last 24 h. */
  activity: { n: number; paid: bigint; result: bigint; net: bigint };
  /** The vault after the closes, oldest first (the live point is the app's own). */
  strikes: StrikePoint[];
  /** Micro-USDC of tickets opened per hour from `from` (a whole hour), the last hour to now. */
  volume: { from: number; sums: bigint[] };
};

/** A ticket of the feed with its opening read, as the vault's lines and the live draws read it. */
export type FeedRow = {
  ticket: Address;
  price: bigint;
  payoutMax: bigint;
  vaultCredit: bigint;
  marginBps: bigint;
  openedAt: number | null;
  openSig: Signature;
  end: FeedEnd | null;
  /** A ticket of the shared beacon; absent for a direct one. */
  beacon?: true;
};

export type FeedEnd = {
  kind: "settled" | "expired";
  payout: bigint;
  pending: boolean;
  /** A beacon ticket's price back (`TicketEnd.refunded`). */
  refunded?: boolean;
  /** A direct ticket's vault credit back, its `payout` (`TicketEnd.creditReturned`). */
  creditReturned?: boolean;
  at: number | null;
  signature: Signature;
};

/** A ticket of the feed whose opening the keeper no longer keeps: its end alone. */
export type FeedLoneEnd = FeedEnd & { ticket: Address; beacon: boolean };

export type FeedRequest = (
  { kind: "deposit"; amount: bigint } | { kind: "withdrawal"; shares: bigint }
) & { at: number | null; signature: Signature; index: number };

export type KeeperFeed = {
  /** Unix seconds: when the keeper built this answer. */
  updatedAt: number;
  arrival?: Arrival;
  /**
   * Unix seconds from which every ticket opened is in `rows` (and `loneEnds`): older ones are
   * there only for a recent event, with others of their time missing (`feedHorizon`).
   */
  ticketsFrom: number | null;
  /**
   * The keeper has not read every ticket the feed reaches back to yet, or stopped reading the
   * program; or this answer is old, or the latest read of it failed (`feedAsRead`).
   */
  syncing: boolean;
  /** The same for the requests, which reach back further than the tickets. */
  requestsSyncing: boolean;
  /** Newest first, by their last event. */
  rows: FeedRow[];
  loneEnds: FeedLoneEnd[];
  /** Newest first. */
  requests: FeedRequest[];
};

export type KeeperProviders = {
  /** Unix seconds: when the keeper read the accounts behind this answer. */
  updatedAt: number;
  arrival?: Arrival;
  /** This answer is old, or the latest read of it failed (`providersAsRead`). */
  syncing: boolean;
  /** The keeper has not read back to the first deposits yet: none is known. */
  firstDepositsSyncing: boolean;
  /** Largest holding first, valued at the vault the keeper read with them. */
  lines: ProviderLine[];
};

const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const amount = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);
const signed = (v: unknown) => (typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : null);
const time = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === "number" && Number.isFinite(v) ? v : undefined;
const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
const record = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
/** An ISO 8601 time in Unix seconds; null when it does not read as one. */
const isoSeconds = (v: unknown) => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1_000) : null;
};

/** The answer of GET /v1/vault; null when it does not read as one. */
export function parseKeeperVault(j: unknown): KeeperVault | null {
  const o = record(j);
  const apps = record(o?.apps);
  const activity = record(o?.activity);
  const series = record(o?.series);
  const volume = record(series?.volume);
  const updatedAt = isoSeconds(o?.updatedAt);
  if (!o || !apps || !activity || !series || !volume || updatedAt === null) return null;
  if (!Array.isArray(apps.rows) || !Array.isArray(series.strikes) || !Array.isArray(volume.sums))
    return null;
  const rows: KeeperApp[] = [];
  for (const v of apps.rows as unknown[]) {
    const r = record(v);
    const integrator = text(r?.integrator);
    const tickets = count(r?.tickets);
    const vol = amount(r?.volume);
    const result = signed(r?.result);
    const settled = count(r?.settled);
    if (
      !r ||
      !integrator ||
      tickets === null ||
      vol === null ||
      result === null ||
      settled === null
    )
      return null;
    rows.push({
      integrator: integrator as Address,
      authority: (text(r.authority) as Address | null) ?? null,
      tickets,
      volume: vol,
      result,
      settled,
    });
  }
  const n = count(activity.tickets);
  const paid = amount(activity.paid);
  const result = signed(activity.result);
  const net = signed(activity.net);
  if (n === null || paid === null || result === null || net === null) return null;
  const strikes: StrikePoint[] = [];
  for (const v of series.strikes as unknown[]) {
    const p = record(v);
    const t = time(p?.t);
    const epochId = amount(p?.epochId);
    const price = amount(p?.price);
    const assets = amount(p?.assets);
    if (typeof t !== "number" || epochId === null || price === null || assets === null) return null;
    strikes.push({ t, epochId, price, assets });
  }
  const sums: bigint[] = [];
  for (const v of volume.sums as unknown[]) {
    const s = amount(v);
    if (s === null) return null;
    sums.push(s);
  }
  if (typeof volume.from !== "number" || !Number.isFinite(volume.from) || !sums.length) return null;
  return {
    updatedAt,
    coveredFrom:
      typeof o.coveredFrom === "number" && Number.isFinite(o.coveredFrom) ? o.coveredFrom : null,
    syncing: o.syncing === true,
    // an answer that does not say: its series are taken as partial
    seriesSyncing: o.seriesSyncing !== false,
    apps: rows,
    activity: { n, paid, result, net },
    strikes,
    volume: { from: volume.from, sums },
  };
}

function endOf(v: unknown): FeedEnd | null | undefined {
  if (v === null) return null;
  const e = record(v);
  const payout = amount(e?.payout);
  const at = time(e?.at);
  const signature = text(e?.signature);
  if (!e || (e.kind !== "settled" && e.kind !== "expired") || payout === null) return undefined;
  if (at === undefined || !signature) return undefined;
  return {
    kind: e.kind,
    payout,
    pending: e.pending === true,
    ...(e.refunded === true ? { refunded: true } : {}),
    ...(e.creditReturned === true ? { creditReturned: true } : {}),
    at,
    signature: signature as Signature,
  };
}

/** The answer of GET /v1/feed; null when it does not read as one. */
export function parseKeeperFeed(j: unknown): KeeperFeed | null {
  const o = record(j);
  const updatedAt = isoSeconds(o?.updatedAt);
  if (!o || !Array.isArray(o.tickets) || !Array.isArray(o.requests) || updatedAt === null)
    return null;
  const rows: FeedRow[] = [];
  const loneEnds: FeedLoneEnd[] = [];
  for (const v of o.tickets as unknown[]) {
    const t = record(v);
    const ticket = text(t?.ticket);
    const end = endOf(t?.end);
    if (!t || !ticket || end === undefined) return null;
    const beacon = t.beacon === true;
    if (t.opened === null) {
      if (end) loneEnds.push({ ...end, ticket: ticket as Address, beacon });
      continue;
    }
    const op = record(t.opened);
    const at = time(op?.at);
    const signature = text(op?.signature);
    const price = amount(op?.price);
    const payoutMax = amount(op?.payoutMax);
    const vaultCredit = amount(op?.vaultCredit);
    const marginBps = amount(op?.marginBps);
    if (at === undefined || !signature || price === null || payoutMax === null) return null;
    if (vaultCredit === null || marginBps === null) return null;
    rows.push({
      ticket: ticket as Address,
      price,
      payoutMax,
      vaultCredit,
      marginBps,
      openedAt: at,
      openSig: signature as Signature,
      end,
      ...(beacon ? { beacon: true as const } : {}),
    });
  }
  const requests: FeedRequest[] = [];
  for (const v of o.requests as unknown[]) {
    const r = record(v);
    const at = time(r?.at);
    const signature = text(r?.signature);
    const index = count(r?.index);
    if (!r || at === undefined || !signature || index === null) return null;
    const base = { at, signature: signature as Signature, index };
    const value = amount(r.kind === "deposit" ? r.amount : r.shares);
    if (value === null || (r.kind !== "deposit" && r.kind !== "withdrawal")) return null;
    requests.push(
      r.kind === "deposit"
        ? { kind: "deposit", amount: value, ...base }
        : { kind: "withdrawal", shares: value, ...base },
    );
  }
  return {
    updatedAt,
    ticketsFrom:
      typeof o.ticketsFrom === "number" && Number.isFinite(o.ticketsFrom) ? o.ticketsFrom : null,
    syncing: o.syncing === true,
    // an answer that does not say: its requests are taken as partial
    requestsSyncing: o.requestsSyncing !== false,
    rows,
    loneEnds,
    requests,
  };
}

/** The answer of GET /v1/providers; null when it does not read as one. */
export function parseKeeperProviders(j: unknown): KeeperProviders | null {
  const o = record(j);
  const updatedAt = isoSeconds(o?.updatedAt);
  if (!o || !Array.isArray(o.rows) || updatedAt === null) return null;
  const lines: ProviderLine[] = [];
  for (const v of o.rows as unknown[]) {
    const r = record(v);
    const owner = text(r?.owner);
    const shares = amount(r?.shares);
    const depositIn = amount(r?.depositIn);
    const sharesOut = amount(r?.sharesOut);
    const value = amount(r?.value);
    const shareBps = amount(r?.shareBps);
    const firstDepositAt = time(r?.firstDepositAt ?? null);
    if (!r || !owner || shares === null || depositIn === null || sharesOut === null) return null;
    if (value === null || shareBps === null || firstDepositAt === undefined) return null;
    lines.push({
      owner: owner as Address,
      shares,
      depositIn,
      sharesOut,
      value,
      shareBps,
      firstDepositAt,
    });
  }
  return {
    updatedAt,
    syncing: false,
    // an answer that does not say: no first deposit is taken as known
    firstDepositsSyncing: o.firstDepositsSyncing !== false,
    lines,
  };
}

/**
 * `k` as it arrived now, `servedAt` (Unix seconds by the keeper's clock: the response's `Date`,
 * a pushed message's `at`) telling how old it was then; null: weighed by the visitor's clock.
 */
export function arrived<K extends Aged>(
  k: K,
  servedAt: number | null,
  arrivedAt = Date.now() / 1_000,
): K {
  return servedAt === null
    ? k
    : { ...k, arrival: { arrivedAt, ageThen: Math.max(0, servedAt - k.updatedAt) } };
}

/**
 * An answer's age at `now` (the visitor's clock, Unix seconds): its age when it arrived by the
 * keeper's clock plus the time since, both differences of one clock; by the visitor's clock
 * alone when the keeper did not say when it served it.
 */
export const ageOf = (k: Aged, now: number): number =>
  k.arrival ? k.arrival.ageThen + (now - k.arrival.arrivedAt) : now - k.updatedAt;

/** A `Date` header in Unix seconds; null when there is none (or it does not read as one). */
function headerSeconds(v: string | null): number | null {
  const ms = v === null ? NaN : Date.parse(v);
  return Number.isFinite(ms) ? ms / 1_000 : null;
}

/**
 * One keeper route read at a time per page: callers share the request in flight, and a page
 * opened later starts from the last answer.
 */
function shared<T extends Aged>(path: string, parse: (j: unknown) => T | null, what: string) {
  let inFlight: Promise<T> | null = null;
  let last: T | null = null;
  const fetchIt = (): Promise<T> => {
    inFlight ??= (async () => {
      const r = await fetch(`${API_URL}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(6_000),
      });
      if (!r.ok) throw new Error(`the ${what} service answered HTTP ${r.status}`);
      const v = parse(await r.json());
      if (v === null) throw new Error(`the ${what} service answered an unreadable body`);
      last = arrived(v, headerSeconds(r.headers.get("Date")));
      return last;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  /**
   * An answer pushed by the keeper (lib/live) at `at` (its clock, Unix seconds; null: it did not
   * say): read as the route's, and kept as the last one.
   */
  const accept = (j: unknown, at: number | null = null): T | null => {
    const v = parse(j);
    if (v === null) return null;
    last = arrived(v, at);
    return last;
  };
  return { fetch: fetchIt, last: () => last, accept };
}

const vault = shared("/v1/vault", parseKeeperVault, "vault history");
const feed = shared("/v1/feed", parseKeeperFeed, "live feed");

const providers = shared("/v1/providers", parseKeeperProviders, "providers");

/** The keeper's vault history; throws when it cannot be reached or answers something else. */
export const fetchKeeperVault = vault.fetch;
export const lastKeeperVault = vault.last;
export const acceptKeeperVault = vault.accept;
/** The keeper's feed; throws when it cannot be reached or answers something else. */
export const fetchKeeperFeed = feed.fetch;
export const lastKeeperFeed = feed.last;
export const acceptKeeperFeed = feed.accept;
/** The keeper's liquidity providers; throws when it cannot be reached or answers something else. */
export const fetchKeeperProviders = providers.fetch;
export const lastKeeperProviders = providers.last;
export const acceptKeeperProviders = providers.accept;

/**
 * How old a feed answer may be before the app reads the tickets itself: the keeper builds it
 * every 5 s while asked, serves one at most a minute old, and the edge keeps it 5 s.
 */
export const FEED_MAX_AGE_S = 180;
/**
 * How old a vault history answer may be: the keeper builds it at most once a minute, serves one
 * at most 5 minutes old, and the edge keeps it 30 s.
 */
export const VAULT_MAX_AGE_S = 420;

/**
 * How old a providers answer may be before the app scans the share mint itself: the keeper reads
 * the accounts every 2 minutes while asked, serves an answer at most 10 minutes old, and the edge
 * keeps it 60 s.
 */
export const PROVIDERS_MAX_AGE_S = 720;

/**
 * The latest read of the route failed, or the answer it keeps is older than `maxAgeS` (by the
 * keeper's clock, `ageOf`).
 */
const outdated = (k: Aged, failed: boolean, maxAgeS: number, now: number) =>
  failed || ageOf(k, now) > maxAgeS;

/**
 * The keeper's vault history as the page weighs it at `now` (Unix seconds): syncing in every
 * part once the latest read failed or the answer is older than VAULT_MAX_AGE_S, so the app
 * reads the history itself, the answer still shown until its own read arrives.
 */
export const vaultAsRead = (
  k: KeeperVault | null,
  failed: boolean,
  now: number,
): KeeperVault | null =>
  k && outdated(k, failed, VAULT_MAX_AGE_S, now) ? { ...k, syncing: true, seriesSyncing: true } : k;

/** The keeper's feed as the page weighs it at `now`: as `vaultAsRead`, past FEED_MAX_AGE_S. */
export const feedAsRead = (
  k: KeeperFeed | null,
  failed: boolean,
  now: number,
): KeeperFeed | null =>
  k && outdated(k, failed, FEED_MAX_AGE_S, now)
    ? { ...k, syncing: true, requestsSyncing: true }
    : k;

/** The keeper's providers as the page weighs it at `now`: as `vaultAsRead`, past PROVIDERS_MAX_AGE_S. */
export const providersAsRead = (
  k: KeeperProviders | null,
  failed: boolean,
  now: number,
): KeeperProviders | null =>
  k && outdated(k, failed, PROVIDERS_MAX_AGE_S, now) ? { ...k, syncing: true } : k;

/**
 * The answer a page weighs (with `asRead`: `vaultAsRead`, `feedAsRead` or `providersAsRead`): its
 * own latest read, or the one remembered from an earlier page. While this page's first read is
 * pending, the remembered answer is shown as it was served, its age not weighed: the page has
 * not asked for a new one yet, and the app's own reads start only once that read fails or brings
 * an outdated answer.
 */
export function keeperAsRead<K>(
  read: { data: K | null; error: string | null; loading: boolean },
  remembered: K | null,
  asRead: (k: K | null, failed: boolean, now: number) => K | null,
  now: number,
): K | null {
  if (read.data === null && read.error === null && read.loading) return remembered;
  return asRead(read.data ?? remembered, read.error !== null, now);
}

/**
 * Whether the app reads the history itself: the latest read of the keeper failed, or its answer
 * (as `vaultAsRead` and `feedAsRead` weigh it) is syncing. Waiting for its first answer is
 * neither: a skeleton meanwhile.
 */
export const needsOwn = (keeper: { syncing: boolean } | null, failed: boolean): boolean =>
  failed || (keeper?.syncing ?? false);

/**
 * What to show: the keeper's once it answers in full (`syncing` says which part: the whole
 * answer by default); else the app's own; else the keeper's partial one where `partial` says it
 * can be shown as such (lines that are each true, a figure labelled with the period the keeper
 * covers); null (a skeleton) while waiting: a partial figure is never shown as a final one.
 */
export function chooseView<K extends { syncing: boolean }, O>(
  keeper: K | null,
  own: O | null,
  syncing: (k: K) => boolean = (k) => k.syncing,
  partial: (k: K) => boolean = () => false,
): { keeper: K } | { own: O } | null {
  if (keeper && !syncing(keeper)) return { keeper };
  if (own !== null) return { own };
  return keeper && partial(keeper) ? { keeper } : null;
}

/** The keeper's partial answer, labelled: shown while the app has none of its own. */
export const asPartial = (): boolean => true;

/**
 * Unix seconds from which the feed holds every ticket opened: what it says, or, from a keeper
 * that does not say (it served the tickets by their last event), the oldest last event served
 * (a ticket opened since has an event since, so it is served).
 */
export function feedHorizon(feed: KeeperFeed): number {
  if (feed.ticketsFrom !== null) return feed.ticketsFrom;
  let from = Infinity;
  for (const r of feed.rows) {
    const last = Math.max(r.openedAt ?? -Infinity, r.end?.at ?? -Infinity);
    if (Number.isFinite(last) && last < from) from = last;
  }
  for (const e of feed.loneEnds) if (e.at !== null && e.at < from) from = e.at;
  return Number.isFinite(from) ? from : -Infinity;
}

/**
 * Unix seconds of `owner`'s earliest deposit request in its own history (lib/history
 * `fetchOwnerLog`), null when it has none there: a wallet holding only fvUSDC it was sent.
 */
export function firstDepositIn(log: readonly LpItem[], owner: Address): number | null {
  let first: number | null = null;
  for (const i of log)
    if (
      i.blockTime !== null &&
      (first === null || i.blockTime < first) &&
      i.events.some((e) => e.kind === "DepositRequested" && e.data.owner === owner)
    )
      first = i.blockTime;
  return first;
}

/**
 * The liquidity providers to show: the keeper's while it answers in full, else the app's own scan
 * (`scanned`: lib/providers `providerRows` over its reads), else the keeper's answer while that
 * scan has not arrived; null (a skeleton) while waiting. The connected wallet's own line is the
 * one the app reads from the chain (`mine.row`: lib/providers `providerRows` over every share
 * account it owns and its requests, null when it holds and asks for nothing) once that read is in
 * (`mine` null until then), its first deposit the earliest of the keeper's and `mine.firstDepositAt`
 * (`firstDepositIn` its own history, which has a request the keeper has not read yet).
 * `firstDeposits`: the keeper read back to every first deposit; they are kept on the app's own
 * scan too, as a first deposit never changes.
 */
export function chooseProviders(
  keeper: KeeperProviders | null,
  scanned: readonly ProviderRow[] | null,
  vault: VaultTotals,
  mine: { owner: Address; row: ProviderRow | null; firstDepositAt?: number | null } | null,
): { lines: ProviderLine[]; firstDeposits: boolean } | null {
  const known = keeper !== null && !keeper.firstDepositsSyncing;
  let lines: ProviderLine[] | null = null;
  if (keeper && !keeper.syncing) lines = keeper.lines;
  else if (scanned) {
    const first = new Map<Address, number>();
    if (known)
      for (const l of keeper.lines)
        if (l.firstDepositAt !== null) first.set(l.owner, l.firstDepositAt);
    lines = providerLines(scanned, vault, first);
  } else if (keeper) lines = keeper.lines;
  if (lines === null) return null;
  return {
    lines: mine
      ? withOwnLine(lines, mine.owner, mine.row, vault, mine.firstDepositAt ?? null)
      : lines,
    firstDeposits: known,
  };
}
