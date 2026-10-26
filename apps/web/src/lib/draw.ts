// One draw, as the page a share card's QR code opens: app.fade.finance/w/<ticket>. The ticket
// account is closed once it has paid, but its address still finds its transactions: the one that
// opened it (the price, the odds) and the one that drew it (the payout). A beacon ticket's are
// its join and its round's settlement or its return, its odds read from its payout table. This
// file reads them and words them; components/DrawSheet shows them over Home, lib/drawLink builds the link.
import type { Address, Signature } from "@solana/kit";
import { txDecoder, type FadeEvent } from "./events";
import { usdc } from "./format";
import { PREMIUM_PACKS, PACK_TICKETS, type CheckoutBack } from "./payoutTables";
import { rpc } from "./rpc";
import { shareWinOfRow } from "./shareWin";
import { checkoutBackOf } from "./ticketKind";
import {
  delivered,
  directExpiryEnd,
  joinedRow,
  kindOf,
  oddsOf,
  readBeaconMargins,
  roundTicketEnd,
  type TicketEnd,
  type TicketRow,
} from "./ticketLog";
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
  /**
   * The ORAO randomness account the draw read; null when its request was not found (a beacon
   * ticket's round requests it, in a transaction that does not name the ticket).
   */
  randomness: Address | null;
  /**
   * What the ticket ended with waits in escrow: a win's payout (its beneficiary could not receive
   * it directly), a cancelled beacon draw's ticket price (its funder's account could not), or a
   * cancelled direct draw's vault credit (`creditReturned`).
   */
  pending: boolean;
  /**
   * A direct ticket whose draw was cancelled (`refund_expired_ticket`): what came back, or
   * waits, is its vault credit, not its price (the shares its opening paid stay paid).
   */
  creditReturned: boolean;
};

const CHECKOUT_TITLE: Record<CheckoutBack, string> = {
  whole: "Order came back free",
  half: "Half the order came back",
  tenth: "10% of the order came back",
};

/**
 * What a won ticket brought back, in words. Every ticket on this deployment is a demo's, as on
 * Home's live draws: a beacon ticket is the beacon demo's small ticket, and a win-back that is
 * neither a checkout's nor a booster's is a swap's.
 */
export function wonTitle(
  r: Pick<TicketRow, "price" | "payoutMax" | "beacon">,
  payout: bigint,
): string {
  const kind = kindOf(r, true);
  if (kind === "Small ticket") return "Small ticket won";
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
    creditReturned: end?.kind === "expired" && end.creditReturned === true,
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
      // a cancelled beacon draw gave the ticket's price back, a cancelled direct draw its credit
      // (or parked it): "cancelled", never "refunded", which reads as a cancelled sale
      title: end.creditReturned || end.refunded ? "Draw cancelled" : "No draw in time",
      amount: end.creditReturned
        ? `${usdc(end.payout)} USDC ${end.pending ? "to claim" : "back"}`
        : null,
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
 * transaction opened or joined it (an address that is not a ticket). A beacon row's margin is 0
 * here: `fetchDraw` reads it from its payout table.
 */
export function drawOfTxs(
  ticket: Address,
  txs: readonly TicketTx[],
): { row: TicketRow; randomness: Address | null } | null {
  let row: TicketRow | null = null;
  let end: TicketEnd | null = null;
  let randomness: Address | null = null;
  let claimed = false;
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
      } else if (e.kind === "TicketJoined" && e.data.ticket === ticket) {
        row = joinedRow(e, tx, null);
      } else if (
        (e.kind === "RoundTicketSettled" || e.kind === "RoundTicketReturned") &&
        e.data.ticket === ticket
      ) {
        end = roundTicketEnd(e, tx);
      } else if (e.kind === "RoundPayoutClaimed" && e.data.ticket === ticket) {
        claimed = true;
      } else if (e.kind === "RandomnessRequested" && e.data.ticket === ticket) {
        randomness = e.data.request;
      } else if (e.kind === "TicketSettled" && e.data.ticket === ticket) {
        end = {
          kind: "settled",
          payout: e.data.payout,
          pending: e.data.pending,
          at: tx.blockTime,
          signature: tx.signature,
        };
      } else if (e.kind === "TicketExpired" && e.data.ticket === ticket) {
        // forfeited, or its vault credit refunded
        end = directExpiryEnd(e.data, tx);
      }
    }
  if (!row) return null;
  // what the end parked was delivered since, whatever order the transactions came in
  row.end = end && claimed ? delivered(end) : end;
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
 * has a handful: opened, randomness requested, drawn; a beacon ticket joined and drawn or
 * returned), their events, the view. Null when the
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
  if (!d) return null;
  if (d.row.beacon) await readBeaconMargins({ rows: [d.row] });
  return drawViewOf(d.row, d.randomness);
}
