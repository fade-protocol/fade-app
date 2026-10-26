// The pure part of the all-time figures (stats.ts): the ticket events of one program
// transaction, and the running totals they add up to. No storage, no RPC: the Stats Durable
// Object feeds it one transaction at a time, oldest first, and stores what it returns.
//
// Both paths count: a direct ticket opens with `TicketOpened` and closes with `TicketSettled`
// (drawn) or `TicketExpired`; a beacon ticket opens with `TicketJoined` and closes with
// `RoundTicketSettled` (drawn) or `RoundTicketReturned` (its round never drew: forfeited or
// refunded). A return is never a win, whatever it gives back.
//
// Every event carries its ticket's integrator but `RoundTicketReturned`, which takes it from
// the ticket's join.
import { getBase58Encoder, type Address } from "@solana/kit";
import {
  ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR,
  ROUND_TICKET_SETTLED_EVENT_DISCRIMINATOR,
  TICKET_EXPIRED_EVENT_DISCRIMINATOR,
  TICKET_JOINED_EVENT_DISCRIMINATOR,
  TICKET_OPENED_EVENT_DISCRIMINATOR,
  TICKET_SETTLED_EVENT_DISCRIMINATOR,
  getRoundTicketReturnedEventDecoder,
  getRoundTicketSettledEventDecoder,
  getTicketJoinedEventDecoder,
  getTicketOpenedEventDecoder,
  getTicketSettledEventDecoder,
} from "../../../clients/js/src/generated/fade/index.ts";
import { decodeTicketExpired } from "../../../clients/js/src/direct/index.ts";
import { kindOf, type TicketKind } from "../../web/src/lib/ticketKind.ts";
import { EVENT_IX_TAG, startsWith } from "./chain.ts";

/** A transaction as `getTransaction` returns it with `encoding: "json"`. */
export type JsonTx = {
  meta: {
    err: unknown;
    innerInstructions?:
      readonly { instructions: readonly { programIdIndex: number; data: string }[] }[] | null;
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null;
  } | null;
  transaction: { message: { accountKeys: readonly string[] } };
  blockTime?: number | bigint | null;
};

/**
 * One ticket event, of either path (`beacon`: the shared beacon's). An opening is a
 * `TicketOpened` or a `TicketJoined`; a settlement a `TicketSettled` or a `RoundTicketSettled`
 * (its payout counted at once, a parked one included); an expiry a `TicketExpired`; a return a
 * `RoundTicketReturned`, which names no integrator.
 */
export type TicketEvent =
  | {
      kind: "opened";
      ticket: Address;
      integrator: Address;
      price: bigint;
      payoutMax: bigint;
      beacon: boolean;
    }
  | { kind: "settled"; ticket: Address; integrator: Address; payout: bigint; beacon: boolean }
  | { kind: "expired"; ticket: Address; integrator: Address }
  | { kind: "returned"; ticket: Address };

/**
 * The event kinds a version of the index counts: 1 the direct path's, 2 the beacon's too. The
 * Durable Object records the version its counted transactions were read with, and replays the
 * beacon's events of the transactions an earlier version counted (stats.ts).
 */
export const EVENTS_VERSION = 2;

/**
 * The event bodies (discriminator first) a successful transaction emitted, in order, from its
 * `emit_cpi!` inner instructions to `program`.
 */
export function eventBodiesOf(tx: JsonTx, program: Address): Uint8Array[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const out: Uint8Array[] = [];
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== program) continue;
      let data: Uint8Array;
      try {
        data = new Uint8Array(getBase58Encoder().encode(ix.data));
      } catch {
        continue;
      }
      if (startsWith(data, EVENT_IX_TAG)) out.push(data.subarray(8));
    }
  }
  return out;
}

/** The ticket events of a successful transaction, in order, from its `emit_cpi!` inner instructions. */
export function ticketEventsOf(tx: JsonTx, program: Address): TicketEvent[] {
  const out: TicketEvent[] = [];
  for (const body of eventBodiesOf(tx, program)) {
    try {
      if (startsWith(body, TICKET_OPENED_EVENT_DISCRIMINATOR)) {
        const e = getTicketOpenedEventDecoder().decode(body);
        out.push({
          kind: "opened",
          ticket: e.ticket,
          integrator: e.integrator,
          price: e.price,
          payoutMax: e.payoutMax,
          beacon: false,
        });
      } else if (startsWith(body, TICKET_SETTLED_EVENT_DISCRIMINATOR)) {
        const e = getTicketSettledEventDecoder().decode(body);
        out.push({
          kind: "settled",
          ticket: e.ticket,
          integrator: e.integrator,
          payout: e.payout,
          beacon: false,
        });
      } else if (startsWith(body, TICKET_EXPIRED_EVENT_DISCRIMINATOR)) {
        const e = decodeTicketExpired(body);
        out.push({ kind: "expired", ticket: e.ticket, integrator: e.integrator });
      } else if (startsWith(body, TICKET_JOINED_EVENT_DISCRIMINATOR)) {
        const e = getTicketJoinedEventDecoder().decode(body);
        out.push({
          kind: "opened",
          ticket: e.ticket,
          integrator: e.integrator,
          price: e.price,
          payoutMax: e.payoutMax,
          beacon: true,
        });
      } else if (startsWith(body, ROUND_TICKET_SETTLED_EVENT_DISCRIMINATOR)) {
        const e = getRoundTicketSettledEventDecoder().decode(body);
        out.push({
          kind: "settled",
          ticket: e.ticket,
          integrator: e.integrator,
          payout: e.payout,
          beacon: true,
        });
      } else if (startsWith(body, ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR)) {
        const e = getRoundTicketReturnedEventDecoder().decode(body);
        out.push({ kind: "returned", ticket: e.ticket });
      }
    } catch {
      // not a decodable Fade event
    }
  }
  return out;
}

export type Win = {
  /** Micro-USDC. */
  payout: bigint;
  /** Null when the opening of a direct ticket was not read (a beacon ticket's is always known). */
  kind: TicketKind | null;
  ticket: Address;
  /** Unix seconds of the settlement; null when the cluster did not date it. */
  at: number | null;
  signature: string;
};

export type Split = {
  ticketsOpened: number;
  /** Tickets whose draw ran (settled), win or not. */
  ticketsDrawn: number;
  /**
   * Tickets closed without a draw: a direct ticket expired, a beacon ticket returned from a
   * round that never drew (forfeited or refunded).
   */
  ticketsExpired: number;
  /** Draws that paid something. */
  wins: number;
  /** Micro-USDC paid to winners (escrowed payouts included: they are owed to the winner). */
  paid: bigint;
  biggestWin: Win | null;
  lastWin: Win | null;
};

export type Totals = { all: Split };

export const emptySplit = (): Split => ({
  ticketsOpened: 0,
  ticketsDrawn: 0,
  ticketsExpired: 0,
  wins: 0,
  paid: 0n,
  biggestWin: null,
  lastWin: null,
});

export const emptyTotals = (): Totals => ({ all: emptySplit() });

/**
 * What the indexer remembers of a ticket between its opening and its close. `integrator` is
 * null for a ticket remembered before the index kept it (a direct ticket's close names it).
 */
export type OpenTicket = {
  price: bigint;
  payoutMax: bigint;
  beacon: boolean;
  integrator: Address | null;
};

export type TxContext = {
  signature: string;
  /** Unix seconds; null when the cluster did not date the transaction. */
  at: number | null;
  /** The opening of a ticket read earlier (or earlier in this transaction), if any. */
  openOf: (ticket: Address) => OpenTicket | null;
};

/**
 * A demo ticket under any integrator, as in the app: a beacon ticket is a small ticket, and a
 * direct all-or-nothing one reads as a swap.
 */
const winKind = (open: { price: bigint; payoutMax: bigint; beacon: boolean }): TicketKind =>
  kindOf(open, true);

function addTo(s: Split, e: TicketEvent, ctx: TxContext, open: OpenTicket | null): Split {
  if (e.kind === "opened") return { ...s, ticketsOpened: s.ticketsOpened + 1 };
  if (e.kind === "expired" || e.kind === "returned")
    return { ...s, ticketsExpired: s.ticketsExpired + 1 };
  const next = { ...s, ticketsDrawn: s.ticketsDrawn + 1 };
  if (e.payout <= 0n) return next;
  const win: Win = {
    payout: e.payout,
    // a beacon ticket is a small ticket whatever its opening (kindOf)
    kind: e.beacon ? "Small ticket" : open ? winKind(open) : null,
    ticket: e.ticket,
    at: ctx.at,
    signature: ctx.signature,
  };
  next.wins += 1;
  next.paid += e.payout;
  if (!s.biggestWin || e.payout > s.biggestWin.payout) next.biggestWin = win;
  if (!s.lastWin || (win.at ?? 0) >= (s.lastWin.at ?? 0)) next.lastWin = win;
  return next;
}

export type Applied = {
  totals: Totals;
  /** Tickets this transaction opened and did not close: remember them. */
  opened: Map<Address, OpenTicket>;
  /** Tickets this transaction closed: forget them. */
  closed: Set<Address>;
};

/** The totals after one transaction's ticket events. */
export function applyTx(totals: Totals, events: readonly TicketEvent[], ctx: TxContext): Applied {
  let { all } = totals;
  const opened = new Map<Address, OpenTicket>();
  const closed = new Set<Address>();
  for (const e of events) {
    const open = e.kind === "opened" ? null : (opened.get(e.ticket) ?? ctx.openOf(e.ticket));
    all = addTo(all, e, ctx, open);
    if (e.kind === "opened") {
      opened.set(e.ticket, {
        price: e.price,
        payoutMax: e.payoutMax,
        beacon: e.beacon,
        integrator: e.integrator,
      });
      closed.delete(e.ticket);
    } else {
      opened.delete(e.ticket);
      closed.add(e.ticket);
    }
  }
  return { totals: { all }, opened, closed };
}

/**
 * The totals with the kind of `ticket`'s win filled in from its opening, for a win counted
 * before its opening was read (a transaction set aside and counted later); unchanged otherwise.
 */
export function withWinKind(totals: Totals, ticket: Address, open: OpenTicket): Totals {
  const fill = (w: Win | null): Win | null =>
    w && w.ticket === ticket && w.kind === null ? { ...w, kind: winKind(open) } : w;
  const split = (s: Split): Split => ({
    ...s,
    biggestWin: fill(s.biggestWin),
    lastWin: fill(s.lastWin),
  });
  return { all: split(totals.all) };
}

// --- storage and the API -----------------------------------------------------------------

type WinJson = {
  payout: string;
  kind: TicketKind | null;
  ticket: string;
  at: number | null;
  signature: string;
};

export type SplitJson = {
  ticketsOpened: number;
  ticketsDrawn: number;
  ticketsExpired: number;
  wins: number;
  /** Micro-USDC, as a decimal string. */
  paid: string;
  biggestWin: WinJson | null;
  lastWin: WinJson | null;
};

const winJson = (w: Win | null): WinJson | null =>
  w && {
    payout: w.payout.toString(),
    kind: w.kind,
    ticket: w.ticket,
    at: w.at,
    signature: w.signature,
  };

export const splitJson = (s: Split): SplitJson => ({
  ticketsOpened: s.ticketsOpened,
  ticketsDrawn: s.ticketsDrawn,
  ticketsExpired: s.ticketsExpired,
  wins: s.wins,
  paid: s.paid.toString(),
  biggestWin: winJson(s.biggestWin),
  lastWin: winJson(s.lastWin),
});

const winFrom = (w: WinJson | null | undefined): Win | null =>
  w ? { ...w, payout: BigInt(w.payout), ticket: w.ticket as Address } : null;

/** Reads back a split stored as `splitJson` (an empty one when none is stored yet). */
export function splitFrom(text: string | null | undefined): Split {
  if (!text) return emptySplit();
  const j = JSON.parse(text) as SplitJson;
  return {
    ticketsOpened: j.ticketsOpened,
    ticketsDrawn: j.ticketsDrawn,
    ticketsExpired: j.ticketsExpired,
    wins: j.wins,
    paid: BigInt(j.paid),
    biggestWin: winFrom(j.biggestWin),
    lastWin: winFrom(j.lastWin),
  };
}
