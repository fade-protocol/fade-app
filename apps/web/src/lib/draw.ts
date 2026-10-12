// One draw, as the page a share card's QR code opens: app.fade.finance/w/<ticket>. The ticket
// account is closed once it has paid, but its address still finds its transactions: the one that
// opened it (the price, the odds) and the one that drew it (the payout). This file reads them
// and words them; components/DrawSheet shows them over Home, lib/drawLink builds the link.
import type { Address, Signature } from "@solana/kit";
import { txDecoder, type FadeEvent } from "./events";
import { usdc } from "./format";
import { PREMIUM_PACKS, PACK_TICKETS, type CheckoutBack } from "./payoutTables";
import { rpc } from "./rpc";
import { shareWinOfRow } from "./shareWin";
import { checkoutBackOf } from "./ticketKind";
import { kindOf, oddsOf, type TicketEnd, type TicketRow } from "./ticketLog";
import { eventsFor } from "./txCache";

/** How the draw ended: won, paid nothing, never drawn in time, or still drawing. */
export type DrawState = "won" | "lost" | "expired" | "drawing";

export type DrawView = {
  ticket: Address;
  state: DrawState;
  /** What came back, in words: "Order came back free". */
  title: string;
  /** "+282.23 USDC" for a win; null otherwise. */
  amount: string | null;
  /** "2.85 USDC". */
  price: string;
  /** "1 in 100", rounded so it never reads better than the table; null when unknown. */
  oneIn: string | null;
  /** When the draw landed (or the ticket opened, while it is still drawing). */
  at: Date | null;
  /** The transaction that drew it; null while it is still drawing. */
  drawSig: Signature | null;
  /** The ORAO randomness account the draw read; null when its request was not found. */
  randomness: Address | null;
  /** The payout waits in escrow: the beneficiary could not receive it directly. */
  pending: boolean;
};

const CHECKOUT_TITLE: Record<CheckoutBack, string> = {
  whole: "Order came back free",
  half: "Half the order came back",
  tenth: "10% of the order came back",
};

/**
 * What a won ticket brought back, in words. Every ticket on this deployment is a demo's, as on
 * Home's live draws: a win-back that is neither a checkout's nor a booster's is a swap's.
 */
export function wonTitle(r: Pick<TicketRow, "price" | "payoutMax">, payout: bigint): string {
  const kind = kindOf(r, true);
  if (kind === "Checkout") return CHECKOUT_TITLE[checkoutBackOf(r) ?? "whole"];
  if (kind === "Booster")
    return payout === r.price * PACK_TICKETS * PREMIUM_PACKS ? "Premium pack" : "Second pack";
  return "This trade was free";
}

/** The page's view of a ticket read back from its events. */
export function drawViewOf(r: TicketRow, randomness: Address | null): DrawView {
  const end = r.end;
  const base = {
    ticket: r.ticket,
    price: `${usdc(r.price)} USDC`,
    randomness,
    pending: end?.pending ?? false,
  };
  const at = (t: number | null | undefined) => (t == null ? null : new Date(t * 1000));
  const plainOdds = oddsOf(r) === "–" ? null : oddsOf(r);
  if (!end)
    return {
      ...base,
      state: "drawing",
      title: "Still drawing",
      amount: null,
      oneIn: plainOdds,
      at: at(r.openedAt),
      drawSig: null,
    };
  if (end.kind === "expired")
    return {
      ...base,
      state: "expired",
      title: "No draw in time",
      amount: null,
      oneIn: plainOdds,
      at: at(end.at),
      drawSig: end.signature,
    };
  const win = shareWinOfRow(r, true);
  if (!win)
    return {
      ...base,
      state: "lost",
      title: "Not this time",
      amount: null,
      oneIn: plainOdds,
      at: at(end.at),
      drawSig: end.signature,
    };
  return {
    ...base,
    state: "won",
    title: wonTitle(r, end.payout),
    amount: `+${usdc(end.payout)} USDC`,
    oneIn: win.oneIn,
    at: at(end.at),
    drawSig: end.signature,
  };
}

/** One transaction of the ticket, its events decoded. */
export type TicketTx = { signature: Signature; blockTime: number | null; events: FadeEvent[] };

/**
 * The ticket's row and its randomness request, from its transactions in any order: null when no
 * transaction opened it (an address that is not a ticket).
 */
export function drawOfTxs(
  ticket: Address,
  txs: readonly TicketTx[],
): { row: TicketRow; randomness: Address | null } | null {
  let row: TicketRow | null = null;
  let end: TicketEnd | null = null;
  let randomness: Address | null = null;
  for (const tx of txs)
    for (const e of tx.events) {
      if (e.kind === "TicketOpened" && e.data.ticket === ticket) {
        const d = e.data;
        row = {
          ticket,
          integrator: d.integrator,
          beneficiary: d.beneficiary,
          price: d.price,
          payoutMax: d.payoutMax,
          vaultCredit: d.vaultCredit,
          marginBps: d.marginBps,
          appShareBps: d.appShareBps,
          openedAt: tx.blockTime,
          openSig: tx.signature,
          end: null,
        };
      } else if (e.kind === "RandomnessRequested" && e.data.ticket === ticket) {
        randomness = e.data.request;
      } else if (
        (e.kind === "TicketSettled" || e.kind === "TicketExpired") &&
        e.data.ticket === ticket
      ) {
        end = {
          kind: e.kind === "TicketSettled" ? "settled" : "expired",
          payout: e.kind === "TicketSettled" ? e.data.payout : 0n,
          pending: e.kind === "TicketSettled" ? e.data.pending : false,
          at: tx.blockTime,
          signature: tx.signature,
        };
      }
    }
  if (!row) return null;
  row.end = end;
  return { row, randomness };
}

/** "9 Oct 2026, 13:30", in the reader's time zone. */
export function drawnAt(d: Date): string {
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}

/**
 * The draw of `ticket`, read from the chain through the app's RPC: its transactions (a ticket
 * has a handful: opened, randomness requested, drawn), their events, the view. Null when the
 * address opened no ticket; throws when the RPC fails.
 */
export async function fetchDraw(ticket: Address): Promise<DrawView | null> {
  const sigs = (
    await rpc.getSignaturesForAddress(ticket, { limit: 25, commitment: "confirmed" }).send()
  ).filter((s) => s.err === null);
  if (sigs.length === 0) return null;
  const known = await eventsFor(
    sigs.map((s) => s.signature),
    await txDecoder(),
  );
  const txs: TicketTx[] = sigs.map((s) => ({
    signature: s.signature,
    blockTime: s.blockTime === null ? null : Number(s.blockTime),
    events: known.get(s.signature)?.events ?? [],
  }));
  const d = drawOfTxs(ticket, txs);
  return d && drawViewOf(d.row, d.randomness);
}
