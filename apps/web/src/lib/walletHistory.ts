// One wallet's history, pure: its tickets (those its own app opened, and those paying out to it)
// and its deposits and withdrawals (requests, claims, deliveries), with the figures the
// dashboard tells over them. One arithmetic for the keeper, which indexes every program
// transaction and serves a wallet's history (GET /v1/wallet/:owner, apps/keeper/src/walletIndex.ts),
// and for the app, which merges the chain's newest transactions into it (lib/keeperWallet) or
// reads the whole history itself when the keeper cannot serve it (lib/ticketLog, lib/history).
//
// Also the wire format of the route's rows and items: written by the keeper, read by the app.
// Display only: a claim, a request or a ticket is checked against the chain before it is signed.
import type { Address, Signature } from "@solana/kit";
import { isRefunded } from "./apr";
import type { FadeEvent } from "./fadeEvents";
import {
  creditBack,
  winPayout,
  type LoneEnd,
  type TicketEnd,
  type TicketLog,
  type TicketRow,
} from "./ticketRows";
import { appShareOf } from "./vaultViews";

// --- the deposits and withdrawals --------------------------------------------------------------

/** A transaction of the vault's history with its deposit and withdrawal events. */
export type LpItem = {
  signature: Signature;
  blockTime: number | null;
  events: FadeEvent[];
};

/** The events of the vault's history. */
export const LP_KINDS = new Set<FadeEvent["kind"]>([
  "DepositRequested",
  "DepositClaimed",
  "WithdrawRequested",
  "WithdrawClaimed",
  "ClaimDelivered",
  "EpochStruck",
]);

/** The LP owner an event belongs to, if any. */
export function ownerOf(e: FadeEvent): Address | null {
  switch (e.kind) {
    case "DepositRequested":
    case "DepositClaimed":
    case "WithdrawRequested":
    case "WithdrawClaimed":
    case "ClaimDelivered":
      return e.data.owner;
    default:
      return null;
  }
}

/** `owner`'s items among these, each with its own events alone; the others left out. */
export const ownerItemsOf = (items: readonly LpItem[], owner: Address): LpItem[] =>
  items
    .map((i) => ({ ...i, events: i.events.filter((e) => ownerOf(e) === owner) }))
    .filter((i) => i.events.length > 0);

/** Newest first; an undated transaction last, as the app has always listed them. */
export const newestFirst = (items: LpItem[]): LpItem[] =>
  items.sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0));

/** Two reads of one owner's history as one: a transaction in both is listed once. */
export function mergeOwnerItems(a: readonly LpItem[], b: readonly LpItem[]): LpItem[] {
  const merged = new Map<string, LpItem>();
  for (const i of [...a, ...b]) merged.set(i.signature, i);
  return newestFirst([...merged.values()]);
}

// --- the tickets -------------------------------------------------------------------------------

/** The accounts a wallet's tickets name: its integrator record, and its USDC account. */
export type WalletKeys = { owner: Address; integrator: Address; usdcAccount: Address };

/** A ticket paying out to the wallet: its USDC account, or the wallet itself, the beneficiary. */
export const isBuyerRow = (r: Pick<TicketRow, "beneficiary">, w: WalletKeys) =>
  r.beneficiary === w.usdcAccount || r.beneficiary === w.owner;

/** A ticket the wallet's own app opened. */
export const isAppRow = (r: Pick<TicketRow, "integrator">, w: WalletKeys) =>
  r.integrator === w.integrator;

/** The wallet's tickets among these, as listed: its app's, and those paying out to it. */
export const walletRowsOf = (rows: readonly TicketRow[], w: WalletKeys): TicketRow[] =>
  rows.filter((r) => isAppRow(r, w) || isBuyerRow(r, w));

/** The Tickets tab's counts over the tickets paying out to the wallet (lib/dashboard `ticketStats`). */
export type BuyerTotals = {
  draws: number;
  /** Tickets whose draw paid something. */
  wins: number;
  /** Payouts, micro-USDC. */
  won: bigint;
  /** Ticket prices paid, micro-USDC: a refunded beacon ticket's came back. */
  spent: bigint;
};

/** "My app"'s counts over the tickets the wallet's app opened (lib/dashboard `appFigures`). */
export type AppTotals = { tickets: number; appShare: bigint; paid: bigint };

export type WalletTotals = {
  /** Every ticket of the wallet. */
  tickets: number;
  buyer: BuyerTotals;
  app: AppTotals;
  /** The buyer's ticket that paid the most, the newest on a tie; null without a win. */
  best: Address | null;
};

const emptyTotals = (): WalletTotals => ({
  tickets: 0,
  buyer: { draws: 0, wins: 0, won: 0n, spent: 0n },
  app: { tickets: 0, appShare: 0n, paid: 0n },
  best: null,
});

/** Adds (`sign` 1) or takes away (−1) one ticket's part of the counts; `best` left as it is. */
function count(t: WalletTotals, r: TicketRow, w: WalletKeys, sign: 1 | -1): void {
  const payout = winPayout(r.end);
  const n = BigInt(sign);
  if (isAppRow(r, w) || isBuyerRow(r, w)) t.tickets += sign;
  if (isBuyerRow(r, w)) {
    t.buyer.draws += sign;
    t.buyer.won += n * payout;
    if (!isRefunded(r)) t.buyer.spent += n * (r.price - creditBack(r.end));
    if (payout > 0n) t.buyer.wins += sign;
  }
  if (isAppRow(r, w)) {
    t.app.tickets += sign;
    t.app.appShare += n * appShareOf(r);
    t.app.paid += n * payout;
  }
}

/** The buyer's best win among these rows (newest first): the largest payout, the newest on a tie. */
const bestOf = (rows: readonly TicketRow[], w: WalletKeys): TicketRow | null => {
  let best: TicketRow | null = null;
  for (const r of rows) {
    const payout = winPayout(r.end);
    if (isBuyerRow(r, w) && payout > 0n && (!best || payout > winPayout(best.end))) best = r;
  }
  return best;
};

/** The counts over every one of a wallet's tickets (newest first). */
export function walletTotals(rows: readonly TicketRow[], w: WalletKeys): WalletTotals {
  const t = emptyTotals();
  for (const r of rows) count(t, r, w, 1);
  t.best = bestOf(rows, w)?.ticket ?? null;
  return t;
}

/** The wallet's tickets as the dashboard reads them, from the keeper or from the app's reads. */
export type WalletTicketList = {
  /**
   * Newest first: every ticket, or, per role, the newest of them (`complete` false), its best
   * win and its parked payouts kept.
   */
  rows: TicketRow[];
  /** The counts over every ticket of the wallet, those not listed included. */
  totals: WalletTotals;
  /**
   * Per role: `rows` holds every ticket paying out to the wallet (`buyer`), every ticket its app
   * opened (`app`).
   */
  complete: { buyer: boolean; app: boolean };
};

/** A buyer's ticket whose end parked what it pays the wallet: its claim is offered from the list. */
const isParked = (r: TicketRow, w: WalletKeys) =>
  !!r.end?.pending && (isBuyerRow(r, w) || r.beacon?.refundTo === w.usdcAccount);

/**
 * A wallet's tickets (newest first) bounded per role: the newest `max` paying out to it and,
 * apart, the newest `max` its app opened, so a busy app's tickets never push the wallet's own
 * draws out. Its best win is kept, and its parked payouts (up to `max` older ones), whatever
 * their age, so the claim of one never depends on how recent it is. The counts are over all of
 * them.
 */
export function boundedTickets(
  rows: readonly TicketRow[],
  w: WalletKeys,
  max: number,
): WalletTicketList {
  const totals = walletTotals(rows, w);
  let buyers = 0;
  let apps = 0;
  let parked = 0;
  const listed = rows.filter((r) => {
    const buyer = isBuyerRow(r, w);
    const app = isAppRow(r, w);
    let keep = (buyer && buyers < max) || (app && apps < max) || r.ticket === totals.best;
    if (!keep && isParked(r, w) && parked < max) {
      parked += 1;
      keep = true;
    }
    if (buyer) buyers += 1;
    if (app) apps += 1;
    return keep;
  });
  return { rows: listed, totals, complete: { buyer: buyers <= max, app: apps <= max } };
}

const endOf = (e: LoneEnd): TicketEnd => ({
  kind: e.kind,
  payout: e.payout,
  pending: e.pending,
  ...(e.refunded ? { refunded: true } : {}),
  ...(e.creditReturned ? { creditReturned: true } : {}),
  at: e.at,
  signature: e.signature,
});

const sameEnd = (a: TicketEnd | null, b: TicketEnd | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.signature === b.signature &&
    a.kind === b.kind &&
    a.payout === b.payout &&
    a.pending === b.pending);

/**
 * The wallet's tickets with the newest transactions read since the keeper's answer (`tail`:
 * lib/ticketRows `ticketLogOf` over them, newest first) merged in: a ticket opened since comes
 * first, a ticket that ended since takes its end, and the counts follow. A row the keeper read
 * keeps its margin and its end where the tail does not know them.
 */
export function withTail(list: WalletTicketList, tail: TicketLog, w: WalletKeys): WalletTicketList {
  const rows = new Map(list.rows.map((r) => [r.ticket, r] as const));
  const before: TicketRow[] = [];
  const after: TicketRow[] = [];
  const replace = (old: TicketRow, next: TicketRow) => {
    rows.set(old.ticket, next);
    before.push(old);
    after.push(next);
  };
  for (const e of tail.loneEnds) {
    const old = rows.get(e.ticket);
    if (old && !sameEnd(old.end, endOf(e))) replace(old, { ...old, end: endOf(e) });
  }
  const fresh: TicketRow[] = [];
  for (const r of walletRowsOf(tail.rows, w)) {
    const old = rows.get(r.ticket);
    if (!old) {
      fresh.push(r);
      continue;
    }
    const next: TicketRow = {
      ...r,
      end: r.end ?? old.end,
      marginBps: r.beacon && r.marginBps === 0n ? old.marginBps : r.marginBps,
    };
    if (!sameEnd(old.end, next.end) || old.marginBps !== next.marginBps) replace(old, next);
  }
  if (!before.length && !fresh.length) return list;
  const totals: WalletTotals = {
    ...list.totals,
    buyer: { ...list.totals.buyer },
    app: { ...list.totals.app },
  };
  for (const r of before) count(totals, r, w, -1);
  for (const r of [...after, ...fresh]) count(totals, r, w, 1);
  const merged = [...fresh, ...list.rows.map((r) => rows.get(r.ticket)!)];
  const kept = list.totals.best === null ? null : (rows.get(list.totals.best) ?? null);
  totals.best = bestOf([...fresh, ...after, ...(kept ? [kept] : [])], w)?.ticket ?? null;
  return { rows: merged, totals, complete: list.complete };
}

// --- the wire format (GET /v1/wallet/:owner) -------------------------------------------------

export type TicketEndJson = {
  kind: "settled" | "expired";
  payout: string;
  pending: boolean;
  refunded?: true;
  /** A direct ticket's vault credit back (`TicketEnd.creditReturned`), its `payout`. */
  creditReturned?: true;
  at: number | null;
  signature: string;
};

/** A ticket row: micro-USDC and basis points as decimal strings. */
export type TicketRowJson = {
  ticket: string;
  integrator: string;
  beneficiary: string;
  price: string;
  payoutMax: string;
  vaultCredit: string;
  marginBps: string;
  appShareBps: string;
  openedAt: number | null;
  openSig: string;
  end: TicketEndJson | null;
  beacon?: {
    round: string;
    payoutTable: string;
    refundTo: string;
    appShare: string;
    protocolShare: string;
  };
};

export const ticketRowJson = (r: TicketRow): TicketRowJson => ({
  ticket: r.ticket,
  integrator: r.integrator,
  beneficiary: r.beneficiary,
  price: r.price.toString(),
  payoutMax: r.payoutMax.toString(),
  vaultCredit: r.vaultCredit.toString(),
  marginBps: r.marginBps.toString(),
  appShareBps: r.appShareBps.toString(),
  openedAt: r.openedAt,
  openSig: r.openSig,
  end: r.end && {
    kind: r.end.kind,
    payout: r.end.payout.toString(),
    pending: r.end.pending,
    ...(r.end.refunded ? { refunded: true as const } : {}),
    ...(r.end.creditReturned ? { creditReturned: true as const } : {}),
    at: r.end.at,
    signature: r.end.signature,
  },
  ...(r.beacon
    ? {
        beacon: {
          round: r.beacon.round,
          payoutTable: r.beacon.payoutTable,
          refundTo: r.beacon.refundTo,
          appShare: r.beacon.appShare.toString(),
          protocolShare: r.beacon.protocolShare.toString(),
        },
      }
    : {}),
});

export type WalletTotalsJson = {
  tickets: number;
  buyer: { draws: number; wins: number; won: string; spent: string };
  app: { tickets: number; appShare: string; paid: string };
  best: string | null;
};

export const walletTotalsJson = (t: WalletTotals): WalletTotalsJson => ({
  tickets: t.tickets,
  buyer: { ...t.buyer, won: t.buyer.won.toString(), spent: t.buyer.spent.toString() },
  app: { ...t.app, appShare: t.app.appShare.toString(), paid: t.app.paid.toString() },
  best: t.best,
});

/**
 * The fields of each deposit and withdrawal event, by kind: `a` an address, `u` a u64 (a decimal
 * string on the wire), `n` a small number, `b` a boolean.
 */
const LP_FIELDS = {
  DepositRequested: { version: "n", owner: "a", epochId: "u", amount: "u" },
  DepositClaimed: { version: "n", owner: "a", epochId: "u", shares: "u", delivered: "b" },
  WithdrawRequested: { version: "n", owner: "a", epochId: "u", shares: "u" },
  WithdrawClaimed: {
    version: "n",
    owner: "a",
    epochId: "u",
    atEpochId: "u",
    assets: "u",
    closed: "b",
    delivered: "b",
  },
  ClaimDelivered: { version: "n", owner: "a", epochId: "u", deposit: "b", amount: "u" },
} as const satisfies Partial<Record<FadeEvent["kind"], Record<string, "a" | "u" | "n" | "b">>>;

type LpKind = keyof typeof LP_FIELDS;

export type LpEventJson = { kind: LpKind; data: Record<string, string | number | boolean> };
export type LpItemJson = { signature: string; blockTime: number | null; events: LpEventJson[] };

const isLpKind = (k: string): k is LpKind => Object.hasOwn(LP_FIELDS, k);

/** An owner's item on the wire: its deposit and withdrawal events alone. */
export function lpItemJson(i: LpItem): LpItemJson {
  const events: LpEventJson[] = [];
  for (const e of i.events) {
    if (!isLpKind(e.kind)) continue;
    const data: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(e.data as Record<string, unknown>))
      if (Object.hasOwn(LP_FIELDS[e.kind], k))
        data[k] = typeof v === "bigint" ? v.toString() : (v as string | number | boolean);
    events.push({ kind: e.kind, data });
  }
  return { signature: i.signature, blockTime: i.blockTime, events };
}

/** One deposit or withdrawal event read back from the wire; null when it does not read as one. */
export function lpEventFrom(j: unknown): FadeEvent | null {
  const o = j && typeof j === "object" ? (j as { kind?: unknown; data?: unknown }) : null;
  if (!o || typeof o.kind !== "string" || !isLpKind(o.kind)) return null;
  const raw = o.data && typeof o.data === "object" ? (o.data as Record<string, unknown>) : null;
  if (!raw) return null;
  const data: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(LP_FIELDS[o.kind]) as [string, "a" | "u" | "n" | "b"][]) {
    const v = raw[k];
    if (t === "u") {
      if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
      data[k] = BigInt(v);
    } else if (t === "n") {
      if (typeof v !== "number" || !Number.isSafeInteger(v)) return null;
      data[k] = v;
    } else if (t === "b") {
      if (typeof v !== "boolean") return null;
      data[k] = v;
    } else {
      if (typeof v !== "string" || v.length < 32 || v.length > 44) return null;
      data[k] = v;
    }
  }
  return { kind: o.kind, data } as FadeEvent;
}
