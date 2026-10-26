// The pure part of one wallet's history (GET /v1/wallet/:owner, served by the Stats Durable
// Object, stats.ts): what one program transaction says for the wallets it touches, and the answer
// built from the transactions the Durable Object stored for a wallet. The events are decoded and
// the rows worked out with the app's own code (apps/web/src/lib/fadeEvents.ts, ticketRows.ts and
// walletHistory.ts), so the keeper's history and the one the app falls back on agree on the same
// transactions.
//
// Per transaction, its ticket events (both paths' openings, ends and claims of what an end
// parked) and its deposit and withdrawal events, as decoded, with the accounts the wallet's
// history is found by: a ticket's opening by its integrator record and its beneficiary, every
// event of a ticket by the ticket, a deposit or withdrawal event by its owner.
import type { Address, Signature } from "@solana/kit";
import { programEventsOf, type FadeEvent, type JsonTx } from "../../web/src/lib/fadeEvents.ts";
import { ticketLogOf, withBeaconMargins, type TxEvents } from "../../web/src/lib/ticketRows.ts";
import {
  LP_KINDS,
  boundedTickets,
  lpItemJson,
  newestFirst,
  ownerItemsOf,
  ticketRowJson,
  walletRowsOf,
  walletTotalsJson,
  type LpItem,
  type LpItemJson,
  type TicketRowJson,
  type WalletKeys,
  type WalletTotalsJson,
} from "../../web/src/lib/walletHistory.ts";

/**
 * The newest tickets an answer lists per role (paying out to the wallet, opened by its app), and
 * the newest deposit and withdrawal transactions.
 */
export const WALLET_TICKETS_MAX = 500;
export const WALLET_LP_MAX = 1_000;
/**
 * Stored transactions one wallet's build reads at most (stats.ts: those its keys find, and those
 * of the tickets they opened, counted in SQL before any is parsed). A wallet with more is
 * answered `oversized`, and syncing: the app reads its newest history itself (lib/ticketLog). It
 * keeps a build of the largest integrator well under the Durable Object's CPU and memory limits.
 */
export const WALLET_READ_MAX = 12_000;
/**
 * The events a version of the index records for the wallets. An index that counted transactions
 * before it recorded them reads its whole history again, once (stats.ts, step 5).
 */
export const WALLET_EVENTS_VERSION = 1;
/**
 * How long a transaction may stay unlisted once confirmed: the index lists at `finalized`, so a
 * transaction confirmed before the loop last found every listed one read may come only after.
 */
export const WALLET_FINALITY_S = 60;

/** What the wallet history keeps of a transaction: the ticket events and the LP owners' ones. */
const WALLET_KINDS = new Set<FadeEvent["kind"]>([
  "TicketOpened",
  "TicketSettled",
  "TicketExpired",
  "TicketJoined",
  "RoundTicketSettled",
  "RoundTicketReturned",
  "RoundPayoutClaimed",
  ...[...LP_KINDS].filter((k) => k !== "EpochStruck"),
]);

/** A transaction as the index stores it for the wallets. */
export type WalletTx = {
  signature: string;
  /** Unix seconds; null when the cluster did not date it. */
  at: number | null;
  slot: number;
  events: FadeEvent[];
};

/** The accounts a wallet's history finds these events by. */
export function walletKeysOf(events: readonly FadeEvent[]): Set<string> {
  const keys = new Set<string>();
  for (const e of events) {
    if (e.kind === "TicketOpened" || e.kind === "TicketJoined") {
      keys.add(e.data.ticket);
      keys.add(e.data.integrator);
      keys.add(e.data.beneficiary);
    } else if ("ticket" in e.data) keys.add(e.data.ticket);
    else if ("owner" in e.data) keys.add(e.data.owner);
  }
  return keys;
}

/**
 * The tickets these events name past their opening (ends, returns, claims): a wallet finds those
 * events by the ticket alone, its own accounts being in the opening's.
 */
export function laterTicketsOf(events: readonly FadeEvent[]): Set<string> {
  const tickets = new Set<string>();
  for (const e of events)
    if (e.kind !== "TicketOpened" && e.kind !== "TicketJoined" && "ticket" in e.data)
      tickets.add(e.data.ticket);
  return tickets;
}

/**
 * The accounts the openings among `events` name for `tickets`: each one's integrator record and
 * beneficiary, the accounts a wallet finds its tickets' later events by (`laterTicketsOf`).
 */
export function openingAccountsOf(
  events: readonly FadeEvent[],
  tickets: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const e of events)
    if ((e.kind === "TicketOpened" || e.kind === "TicketJoined") && tickets.has(e.data.ticket)) {
      keys.add(e.data.integrator);
      keys.add(e.data.beneficiary);
    }
  return keys;
}

/**
 * The wallet history's events of a successful transaction of `program`, and the accounts they
 * are found by; null when it has none.
 */
export function walletEventsOf(
  tx: JsonTx,
  program: Address,
): { events: FadeEvent[]; keys: Set<string> } | null {
  const events = programEventsOf(tx, program).filter((e) => WALLET_KINDS.has(e.kind));
  if (!events.length) return null;
  return { events, keys: walletKeysOf(events) };
}

/** Events as stored: their u64 fields as `{ "$n": "<decimal>" }`. */
export const eventsJson = (events: readonly FadeEvent[]): string =>
  JSON.stringify(events, (_k, v: unknown) => (typeof v === "bigint" ? { $n: v.toString() } : v));

export const eventsFrom = (text: string): FadeEvent[] =>
  JSON.parse(text, (_k, v: unknown) =>
    v && typeof v === "object" && "$n" in v ? BigInt((v as { $n: string }).$n) : v,
  ) as FadeEvent[];

/** GET /v1/wallet/:owner: one wallet's tickets and its deposits and withdrawals. */
export type WalletView = {
  /** ISO 8601: when this answer was built. */
  updatedAt: string;
  owner: string;
  /** The wallet's integrator record: its own app's tickets name it. */
  integrator: string;
  /** The wallet's USDC account: the beneficiary of its own tickets. */
  usdcAccount: string;
  /**
   * The index has not read the whole history yet, or stopped following the program, or the
   * wallet is `oversized`: this answer may miss transactions (the app reads the wallet's history
   * itself meanwhile).
   */
  syncing: boolean;
  /**
   * The wallet has more stored transactions than one build reads (WALLET_READ_MAX):
   * the answer lists nothing and says syncing, and the app reads the wallet's newest history
   * itself.
   */
  oversized: boolean;
  /**
   * Unix seconds: every program transaction dated up to this time is in the answer (the app
   * reads the wallet's newer ones itself); null before any is read.
   */
  through: number | null;
  tickets: {
    /**
     * Per role, more tickets than `rows` lists: the newest WALLET_TICKETS_MAX paying out to the
     * wallet (`buyer`) and those its app opened (`app`), with its best win and its parked payouts.
     */
    truncated: { buyer: boolean; app: boolean };
    /** Newest first. */
    rows: TicketRowJson[];
    /** Over every ticket of the wallet. */
    totals: WalletTotalsJson;
  };
  lp: {
    /**
     * More transactions than `items` lists: the app then reads the owner's history itself, as the
     * position and its figures need every one of them (lib/keeperWallet `walletLog`).
     */
    truncated: boolean;
    /** Every transaction of the owner's deposits and withdrawals. */
    count: number;
    /** The newest WALLET_LP_MAX of them, newest first, with the owner's own events alone. */
    items: LpItemJson[];
  };
};

export type WalletInputs = {
  keys: WalletKeys;
  /** Every stored transaction the wallet's keys and its tickets name, in any order. */
  txs: readonly WalletTx[];
  /** `Σ p·m` of the payout tables read, by address (a beacon ticket's margin). */
  lhs: ReadonlyMap<Address, bigint>;
  through: number | null;
  syncing: boolean;
  /** Unix seconds. */
  now: number;
};

/** Newest first: by time, then by slot (a transaction the cluster did not date last). */
const newestTxFirst = (a: WalletTx, b: WalletTx) =>
  (b.at ?? 0) - (a.at ?? 0) || b.slot - a.slot || (a.signature < b.signature ? 1 : -1);

/** The answer of GET /v1/wallet/:owner from the wallet's stored transactions. */
export function walletView(i: WalletInputs): WalletView {
  const txs = [...i.txs].sort(newestTxFirst);
  const sigs = txs.map((t) => ({ signature: t.signature as Signature, blockTime: t.at }));
  const known = new Map<Signature, TxEvents<FadeEvent>>(
    txs.map((t) => [t.signature as Signature, { events: t.events }]),
  );
  const log = withBeaconMargins(ticketLogOf(sigs, known, Infinity, 0), i.lhs);
  const tickets = boundedTickets(walletRowsOf(log.rows, i.keys), i.keys, WALLET_TICKETS_MAX);
  const items = newestFirst(
    ownerItemsOf(
      txs.map((t): LpItem => ({
        signature: t.signature as Signature,
        blockTime: t.at,
        events: t.events,
      })),
      i.keys.owner,
    ),
  );
  return {
    updatedAt: new Date(i.now * 1_000).toISOString(),
    owner: i.keys.owner,
    integrator: i.keys.integrator,
    usdcAccount: i.keys.usdcAccount,
    syncing: i.syncing,
    oversized: false,
    through: i.through,
    tickets: {
      truncated: { buyer: !tickets.complete.buyer, app: !tickets.complete.app },
      rows: tickets.rows.map(ticketRowJson),
      totals: walletTotalsJson(tickets.totals),
    },
    lp: {
      truncated: items.length > WALLET_LP_MAX,
      count: items.length,
      items: items.slice(0, WALLET_LP_MAX).map(lpItemJson),
    },
  };
}

/** The answer for a wallet past what one build reads: nothing listed, syncing, `oversized`. */
export function oversizedWalletView(
  keys: WalletKeys,
  through: number | null,
  now: number,
): WalletView {
  return {
    ...walletView({ keys, txs: [], lhs: new Map(), through, syncing: true, now }),
    oversized: true,
  };
}
