// One wallet's history as the keeper serves it (GET /v1/wallet/:owner): its tickets (those its
// own app opened and those paying out to it, with their ends and parked payouts) and its deposits
// and withdrawals. The keeper indexes every program transaction and works the history out with
// the app's own code (lib/ticketRows, lib/walletHistory), so a visitor's dashboard needs one
// request instead of every transaction of the wallet's accounts. The keeper reads at `finalized`:
// its answer says up to when every transaction is in it, and the app reads the wallet's newer
// ones itself (a few signatures of its integrator record, USDC account and share account) and
// merges them in, so a ticket just drawn or a request just sent shows at once.
//
// The app reads the whole history itself (lib/ticketLog `fetchWalletTickets`, lib/history
// `fetchOwnerLog`) while the keeper cannot be trusted with it: the route fails or is slow, the
// keeper is still reading the history or stopped following the program, its answer is too old,
// or the wallet has more new transactions than the merge reads. The deposits and withdrawals are
// also read by the app when the keeper lists only the owner's newest of them: the position and
// its figures are worked out over every one.
//
// Display only: a claim, a request or a ticket is checked against the chain right before it is
// signed (the escrows, the open requests and the vault's live state stay chain reads).
import type { Address, Signature } from "@solana/kit";
import { API_URL } from "./config";
import { txDecoder } from "./events";
import { ata, integratorPda, pdas } from "./fade";
import { fetchOwnerLog } from "./history";
import { rpc } from "./rpc";
import { fetchWalletTickets, readBeaconMargins, type WalletTickets } from "./ticketLog";
import { ticketLogOf, type Sig, type TicketEnd, type TicketRow } from "./ticketRows";
import { eventsFor } from "./txCache";
import {
  LP_KINDS,
  lpEventFrom,
  mergeOwnerItems,
  ownerItemsOf,
  withTail,
  type LpItem,
  type WalletKeys,
  type WalletTicketList,
  type WalletTotals,
} from "./walletHistory";

export type KeeperWallet = WalletKeys & {
  /** Unix seconds: when the keeper built this answer. */
  updatedAt: number;
  /** The keeper is still reading the history, or stopped following the program. */
  syncing: boolean;
  /** Unix seconds: every program transaction dated up to this time is in the answer. */
  through: number | null;
  tickets: WalletTicketList;
  /**
   * Newest first, the owner's own events alone; `complete` false past the keeper's bound, and the
   * app then reads the owner's history itself.
   */
  lp: { items: LpItem[]; complete: boolean };
};

/**
 * How far back the app reads the wallet's newer transactions itself: past it, the keeper's
 * answer is too old to merge into, and the app reads the whole history.
 */
export const WALLET_TAIL_MAX_S = 900;
/** Signatures per account the merge reads: a wallet with more new ones is read in full. */
export const WALLET_TAIL_PAGE = 100;

const amount = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);
const time = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === "number" && Number.isFinite(v) ? v : undefined;
const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const address = (v: unknown) =>
  typeof v === "string" && v.length >= 32 && v.length <= 44 ? (v as Address) : null;
const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
const record = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function endFrom(v: unknown): TicketEnd | null | undefined {
  if (v === null) return null;
  const e = record(v);
  const payout = amount(e?.payout);
  const at = time(e?.at);
  const signature = text(e?.signature);
  if (!e || (e.kind !== "settled" && e.kind !== "expired") || payout === null) return undefined;
  if (at === undefined || typeof e.pending !== "boolean" || !signature) return undefined;
  return {
    kind: e.kind,
    payout,
    pending: e.pending,
    ...(e.refunded === true ? { refunded: true } : {}),
    ...(e.creditReturned === true ? { creditReturned: true } : {}),
    at,
    signature: signature as Signature,
  };
}

/** A ticket row of the route; null when it does not read as one. */
function rowFrom(v: unknown): TicketRow | null {
  const r = record(v);
  const ticket = address(r?.ticket);
  const integrator = address(r?.integrator);
  const beneficiary = address(r?.beneficiary);
  const price = amount(r?.price);
  const payoutMax = amount(r?.payoutMax);
  const vaultCredit = amount(r?.vaultCredit);
  const marginBps = amount(r?.marginBps);
  const appShareBps = amount(r?.appShareBps);
  const openedAt = time(r?.openedAt);
  const end = endFrom(r?.end);
  const openSig = text(r?.openSig);
  if (!r || !ticket || !integrator || !beneficiary || !openSig) return null;
  if (price === null || payoutMax === null || vaultCredit === null || marginBps === null)
    return null;
  if (appShareBps === null || openedAt === undefined || end === undefined) return null;
  const row: TicketRow = {
    ticket,
    integrator,
    beneficiary,
    price,
    payoutMax,
    vaultCredit,
    marginBps,
    appShareBps,
    openedAt,
    openSig: openSig as Signature,
    end,
  };
  if (r.beacon === undefined) return row;
  const b = record(r.beacon);
  const round = address(b?.round);
  const payoutTable = address(b?.payoutTable);
  const refundTo = address(b?.refundTo);
  const appShare = amount(b?.appShare);
  const protocolShare = amount(b?.protocolShare);
  if (!round || !payoutTable || !refundTo || appShare === null || protocolShare === null)
    return null;
  return { ...row, beacon: { round, payoutTable, refundTo, appShare, protocolShare } };
}

function totalsFrom(v: unknown): WalletTotals | null {
  const t = record(v);
  const buyer = record(t?.buyer);
  const app = record(t?.app);
  const tickets = count(t?.tickets);
  const draws = count(buyer?.draws);
  const wins = count(buyer?.wins);
  const won = amount(buyer?.won);
  const spent = amount(buyer?.spent);
  const appTickets = count(app?.tickets);
  const appShare = amount(app?.appShare);
  const paid = amount(app?.paid);
  if (tickets === null || draws === null || wins === null || won === null || spent === null)
    return null;
  if (appTickets === null || appShare === null || paid === null) return null;
  const best = t?.best === null ? null : address(t?.best);
  if (best === null && t?.best !== null) return null;
  return {
    tickets,
    buyer: { draws, wins, won, spent },
    app: { tickets: appTickets, appShare, paid },
    best,
  };
}

/** The answer of GET /v1/wallet/:owner; null when it does not read as one. */
export function parseKeeperWallet(j: unknown): KeeperWallet | null {
  const o = record(j);
  const tickets = record(o?.tickets);
  const lp = record(o?.lp);
  const updatedAt = typeof o?.updatedAt === "string" ? Date.parse(o.updatedAt) : NaN;
  const owner = address(o?.owner);
  const integrator = address(o?.integrator);
  const usdcAccount = address(o?.usdcAccount);
  const through = time(o?.through ?? null);
  const totals = totalsFrom(tickets?.totals);
  if (!o || !tickets || !lp || !Number.isFinite(updatedAt) || !owner || !integrator) return null;
  if (!usdcAccount || through === undefined || !totals) return null;
  if (!Array.isArray(tickets.rows) || !Array.isArray(lp.items)) return null;
  const rows: TicketRow[] = [];
  for (const v of tickets.rows as unknown[]) {
    const r = rowFrom(v);
    if (!r) return null;
    rows.push(r);
  }
  const items: LpItem[] = [];
  for (const v of lp.items as unknown[]) {
    const i = record(v);
    const blockTime = time(i?.blockTime);
    const signature = text(i?.signature);
    if (!i || !signature || blockTime === undefined || !Array.isArray(i.events)) return null;
    const events = [];
    for (const e of i.events as unknown[]) {
      const ev = lpEventFrom(e);
      if (!ev) return null;
      events.push(ev);
    }
    items.push({ signature: signature as Signature, blockTime, events });
  }
  return {
    updatedAt: Math.floor(updatedAt / 1_000),
    owner,
    integrator,
    usdcAccount,
    // an answer that does not say: taken as partial
    syncing: o.syncing !== false,
    through,
    tickets: {
      rows,
      totals,
      // a role the answer does not say is complete: taken as bounded, its counts served
      complete: {
        buyer: record(tickets.truncated)?.buyer === false,
        app: record(tickets.truncated)?.app === false,
      },
    },
    lp: { items, complete: lp.truncated === false },
  };
}

const inFlight = new Map<Address, Promise<KeeperWallet>>();
/** When the keeper last said it indexed new transactions of a wallet (lib/live), milliseconds. */
const changedAt = new Map<Address, number>();

/**
 * The keeper indexed new transactions of `owner` (its live push): the next read asks for its
 * answer past the browser's cache of the route, which keeps one for 15 s.
 */
export function markWalletChanged(owner: Address): void {
  changedAt.set(owner, Date.now());
}

/**
 * The keeper's history of `owner`; throws when the keeper cannot be reached in 6 s or answers
 * something else. Callers at the same time share one request.
 */
export function fetchKeeperWallet(owner: Address): Promise<KeeperWallet> {
  let p = inFlight.get(owner);
  if (!p) {
    p = (async () => {
      const changed = changedAt.get(owner);
      const r = await fetch(`${API_URL}/v1/wallet/${owner}${changed ? `?at=${changed}` : ""}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(6_000),
      });
      if (!r.ok) throw new Error(`the wallet history service answered HTTP ${r.status}`);
      const v = parseKeeperWallet(await r.json());
      if (v === null || v.owner !== owner)
        throw new Error("the wallet history service answered an unreadable body");
      return v;
    })().finally(() => inFlight.delete(owner));
    inFlight.set(owner, p);
  }
  return p;
}

/**
 * Whether the app merges into the keeper's answer at `now` (Unix seconds), rather than reading
 * the wallet's whole history itself: the answer is complete up to a time no older than
 * WALLET_TAIL_MAX_S, and names the wallet's own accounts.
 */
export const mergeable = (k: KeeperWallet, keys: WalletKeys, now: number): boolean =>
  !k.syncing &&
  k.through !== null &&
  now - k.through <= WALLET_TAIL_MAX_S &&
  k.owner === keys.owner &&
  k.integrator === keys.integrator &&
  k.usdcAccount === keys.usdcAccount;

/**
 * The successful signatures of these accounts dated from `since` (or not dated yet), newest
 * first, each once. Throws when an account has more than WALLET_TAIL_PAGE of them.
 */
async function signaturesFrom(accounts: readonly Address[], since: number): Promise<Sig[]> {
  const merged = new Map<Signature, Sig>();
  await Promise.all(
    accounts.map(async (account) => {
      const page = await rpc
        .getSignaturesForAddress(account, { limit: WALLET_TAIL_PAGE, commitment: "confirmed" })
        .send();
      let reached = false;
      for (const s of page) {
        const t = s.blockTime === null ? null : Number(s.blockTime);
        if (t !== null && t < since) {
          reached = true;
          break;
        }
        if (s.err === null) merged.set(s.signature, { signature: s.signature, blockTime: t });
      }
      if (!reached && page.length >= WALLET_TAIL_PAGE)
        throw new Error("more new transactions than the merge reads");
    }),
  );
  return [...merged.values()].sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0));
}

/**
 * `log` null when the keeper listed only the owner's newest deposits and withdrawals: the
 * position, its figures and the first deposit are worked out over every one, so the app reads
 * them itself (`walletLog`).
 */
export type WalletHistory = {
  tickets: WalletTickets;
  log: LpItem[] | null;
  /** The keeper's answer's `through` (Unix seconds): its index of the wallet is complete to it. */
  through: number | null;
};

/**
 * The keeper's answer with the wallet's newer transactions merged in (`tail`: their signatures,
 * newest first, and their decoded events): its tickets and its deposits and withdrawals.
 */
export function mergedHistory(
  k: KeeperWallet,
  tail: ReturnType<typeof ticketLogOf>,
  tailItems: readonly LpItem[],
): WalletHistory {
  const keys = { owner: k.owner, integrator: k.integrator, usdcAccount: k.usdcAccount };
  return {
    tickets: { ...keys, ...withTail(k.tickets, tail, keys) },
    log: k.lp.complete ? mergeOwnerItems(k.lp.items, ownerItemsOf(tailItems, k.owner)) : null,
    through: k.through,
  };
}

async function fromKeeper(owner: Address): Promise<WalletHistory | null> {
  const [integrator, usdcAccount, { shareMint }] = await Promise.all([
    integratorPda(owner),
    ata(owner),
    pdas(),
  ]);
  const keys = { owner, integrator, usdcAccount };
  let k: KeeperWallet;
  try {
    k = await fetchKeeperWallet(owner);
  } catch {
    return null;
  }
  if (!mergeable(k, keys, Date.now() / 1_000)) return null;
  let sigs: Sig[];
  try {
    sigs = await signaturesFrom([integrator, usdcAccount, await ata(owner, shareMint)], k.through!);
  } catch {
    return null;
  }
  const known = await eventsFor(
    sigs.map((s) => s.signature),
    await txDecoder(),
  );
  const tail = await readBeaconMargins(ticketLogOf(sigs, known, Infinity, 0));
  const items = sigs.flatMap((s): LpItem[] => {
    const events = known.get(s.signature)?.events.filter((e) => LP_KINDS.has(e.kind)) ?? [];
    return events.length ? [{ signature: s.signature, blockTime: s.blockTime, events }] : [];
  });
  return mergedHistory(k, tail, items);
}

const historyInFlight = new Map<Address, Promise<WalletHistory | null>>();

/**
 * The wallet's history from the keeper, its newer transactions merged in; null when the app
 * reads it itself (see the top of this file). Callers at the same time share one read.
 */
export function keeperWalletHistory(owner: Address): Promise<WalletHistory | null> {
  let p = historyInFlight.get(owner);
  if (!p) {
    p = fromKeeper(owner).finally(() => historyInFlight.delete(owner));
    historyInFlight.set(owner, p);
  }
  return p;
}

/** One wallet's tickets: the keeper's history, else the app's own reads. */
export async function walletTickets(owner: Address): Promise<WalletTickets> {
  return (await walletTicketsRead(owner)).tickets;
}

/**
 * `walletTickets`, with the `through` of the keeper's answer they come from (null when the app
 * read them itself): how fresh the keeper's index of the wallet is (lib/live `walletPollMs`).
 */
export async function walletTicketsRead(
  owner: Address,
): Promise<{ tickets: WalletTickets; through: number | null }> {
  const h = await keeperWalletHistory(owner);
  return h
    ? { tickets: h.tickets, through: h.through }
    : { tickets: await fetchWalletTickets(owner), through: null };
}

/**
 * One owner's deposits and withdrawals, newest first: the keeper's history when it lists every
 * one, else the app's own reads over the vault's (`vaultLog`, lib/history `fetchLpLog`); null
 * while those wait for it.
 */
export async function walletLog(
  owner: Address,
  vaultLog: LpItem[] | null,
): Promise<LpItem[] | null> {
  const log = (await keeperWalletHistory(owner))?.log;
  if (log) return log;
  return vaultLog ? fetchOwnerLog(owner, vaultLog) : null;
}

export type OwnerLog = { owner: Address; items: LpItem[] };

/**
 * One poll of the owner's deposits and withdrawals (lib/hooks `usePolling`): `walletLog`, else,
 * while the vault's history is not read yet and the keeper's path failed, the last answer read
 * for the same owner (`last`), so a failed poll keeps the history on screen instead of wiping
 * it; null before any is read.
 */
export async function ownerLogPoll(
  owner: Address,
  vaultLog: LpItem[] | null,
  last: OwnerLog | null,
): Promise<OwnerLog | null> {
  const items = await walletLog(owner, vaultLog);
  if (items) return { owner, items };
  return last?.owner === owner ? last : null;
}
