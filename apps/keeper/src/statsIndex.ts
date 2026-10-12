// The pure part of the all-time figures (stats.ts): the ticket events of one program
// transaction, and the running totals they add up to. No storage, no RPC: the Stats Durable
// Object feeds it one transaction at a time, oldest first, and stores what it returns.
import { getBase58Encoder, type Address } from "@solana/kit";
import {
  TICKET_EXPIRED_EVENT_DISCRIMINATOR,
  TICKET_OPENED_EVENT_DISCRIMINATOR,
  TICKET_SETTLED_EVENT_DISCRIMINATOR,
  getTicketExpiredEventDecoder,
  getTicketOpenedEventDecoder,
  getTicketSettledEventDecoder,
} from "../../../clients/js/src/generated/fade/index.ts";
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

export type TicketEvent =
  | { kind: "opened"; ticket: Address; integrator: Address; price: bigint; payoutMax: bigint }
  | { kind: "settled"; ticket: Address; integrator: Address; payout: bigint }
  | { kind: "expired"; ticket: Address; integrator: Address };

/** The ticket events of a successful transaction, in order, from its `emit_cpi!` inner instructions. */
export function ticketEventsOf(tx: JsonTx, program: Address): TicketEvent[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const out: TicketEvent[] = [];
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== program) continue;
      let data: Uint8Array;
      try {
        data = new Uint8Array(getBase58Encoder().encode(ix.data));
      } catch {
        continue;
      }
      if (!startsWith(data, EVENT_IX_TAG)) continue;
      const body = data.subarray(8);
      try {
        if (startsWith(body, TICKET_OPENED_EVENT_DISCRIMINATOR)) {
          const e = getTicketOpenedEventDecoder().decode(body);
          out.push({
            kind: "opened",
            ticket: e.ticket,
            integrator: e.integrator,
            price: e.price,
            payoutMax: e.payoutMax,
          });
        } else if (startsWith(body, TICKET_SETTLED_EVENT_DISCRIMINATOR)) {
          const e = getTicketSettledEventDecoder().decode(body);
          out.push({
            kind: "settled",
            ticket: e.ticket,
            integrator: e.integrator,
            payout: e.payout,
          });
        } else if (startsWith(body, TICKET_EXPIRED_EVENT_DISCRIMINATOR)) {
          const e = getTicketExpiredEventDecoder().decode(body);
          out.push({ kind: "expired", ticket: e.ticket, integrator: e.integrator });
        }
      } catch {
        // not a decodable Fade event
      }
    }
  }
  return out;
}

export type Win = {
  /** Micro-USDC. */
  payout: bigint;
  /** Null when the ticket's opening was not read. */
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
  /** Tickets closed without a draw. */
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

/** What the indexer remembers of a ticket between its opening and its close. */
export type OpenTicket = { price: bigint; payoutMax: bigint };

export type TxContext = {
  signature: string;
  /** Unix seconds; null when the cluster did not date the transaction. */
  at: number | null;
  /** The opening of a ticket read earlier (or earlier in this transaction), if any. */
  openOf: (ticket: Address) => OpenTicket | null;
};

function addTo(s: Split, e: TicketEvent, ctx: TxContext, open: OpenTicket | null): Split {
  if (e.kind === "opened") return { ...s, ticketsOpened: s.ticketsOpened + 1 };
  if (e.kind === "expired") return { ...s, ticketsExpired: s.ticketsExpired + 1 };
  const next = { ...s, ticketsDrawn: s.ticketsDrawn + 1 };
  if (e.payout <= 0n) return next;
  const win: Win = {
    payout: e.payout,
    // a demo ticket under any integrator: all-or-nothing tickets read as a swap, as in the app
    kind: open ? kindOf(open, true) : null,
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
      opened.set(e.ticket, { price: e.price, payoutMax: e.payoutMax });
      closed.delete(e.ticket);
    } else {
      opened.delete(e.ticket);
      closed.add(e.ticket);
    }
  }
  return { totals: { all }, opened, closed };
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
