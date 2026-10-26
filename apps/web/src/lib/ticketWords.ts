// A ticket in one line, as a sentence: what it was, what it cost, its odds, and how it ended.
// Two points of view: the buyer's (the Dashboard: what they received) and the vault's (the
// vault's Activity: what the winner received, or what the vault kept).
import type { Address } from "@solana/kit";
import { usdc } from "./format";
import { PACK_TICKETS, PREMIUM_PACKS, type CheckoutBack } from "./payoutTables";
import { checkoutBackOf } from "./ticketKind";
import { kindOf, oddsOf, type TicketKind, type TicketRow } from "./ticketLog";

/** A draw that paid nothing, wherever a ticket is listed. */
export const NOT_THIS_TIME = "not this time";

/**
 * A ticket closed without a draw: "draw cancelled" when something came back (a beacon refund's
 * price, a direct ticket's returned credit), else "no draw". Never "refunded": next to a
 * checkout it reads as the order refunded, while the sale stands.
 */
export const noDrawWords = (end: { refunded?: boolean; creditReturned?: boolean }) =>
  end.creditReturned || end.refunded ? "draw cancelled" : "no draw";

/** How the amount on the right reads: a win, what the vault kept, nothing yet, or no win. */
export type LineTone = "won" | "kept" | "muted" | "plain" | "pending";

export type Line = { title: string; detail: string; amount: string; tone: LineTone };

/** A booster's extra by its payout: a premium pack, a second pack, or none. */
export function boosterExtra(r: Pick<TicketRow, "price">, payout: bigint): string | null {
  const pack = r.price * PACK_TICKETS;
  if (payout === pack * PREMIUM_PACKS) return "premium pack";
  if (payout === pack) return "second pack";
  return null;
}

/**
 * What the vault's line reads of a ticket: a `TicketRow` (lib/ticketLog) or a ticket of the
 * keeper's feed (lib/keeperViews).
 */
export type LineTicket = Pick<
  TicketRow,
  "price" | "payoutMax" | "vaultCredit" | "marginBps" | "end"
> & { beacon?: unknown };

const price = (r: Pick<TicketRow, "price">) => `${usdc(r.price)} USDC`;

/** A parked end, after its detail: the payout, or a refunded price, waits in escrow. */
const ESCROW = ", waits to be claimed";

/** A refunded beacon ticket's line: its price back to its funder, or waiting in escrow. */
const refundedLine = (r: Pick<LineTicket, "price" | "end">) => ({
  detail: `${price(r)}, draw cancelled${r.end?.pending ? ESCROW : ""}`,
  amount: r.end?.pending ? `${usdc(r.price)} to claim` : `${usdc(r.price)} back`,
  tone: "muted" as const,
});

/**
 * A direct ticket refunded its vault credit (`creditReturned`): no draw ran, and its credit went
 * back to its beneficiary, or waits in escrow. The shares its opening paid stay paid, so the
 * amount is the credit, not the price; the vault kept nothing.
 */
const creditBackLine = (r: Pick<LineTicket, "price" | "end">) => {
  const credit = r.end?.payout ?? 0n;
  return {
    detail: `${price(r)}, draw cancelled${r.end?.pending ? ESCROW : ""}`,
    amount: r.end?.pending ? `${usdc(credit)} to claim` : `${usdc(credit)} back`,
    tone: "muted" as const,
  };
};

/**
 * A refunded beacon ticket another app funded for the wallet: its price goes back to that app,
 * so nothing comes back to the wallet, nor waits for it.
 */
const refundedElsewhereLine = (r: TicketRow) => ({
  detail: `${price(r)}, draw cancelled`,
  amount: "back to its app",
  tone: "muted" as const,
});

/**
 * A checkout win, by what it sent back. A checkout win pays its worst case, so its payout tells
 * the whole order from half or a tenth of it; without the price to tell, it reads as the
 * checkout's default, the whole order.
 */
function checkoutBack(price: bigint | null, payout: bigint): CheckoutBack {
  return (price !== null && checkoutBackOf({ price, payoutMax: payout })) || "whole";
}

/** What a checkout win was, in a live list: "free order", "half the order back". */
const CHECKOUT_WIN: Record<CheckoutBack, string> = {
  whole: "free order",
  half: "half the order back",
  tenth: "10% of the order back",
};

/** The buyer's checkout win: "came back free", "half the order came back". */
const CHECKOUT_BUYER: Record<CheckoutBack, string> = {
  whole: "came back free",
  half: "half the order came back",
  tenth: "10% of the order came back",
};

/** The vault's checkout win: "Order came back free", "Half an order came back". */
const CHECKOUT_VAULT: Record<CheckoutBack, string> = {
  whole: "Order came back free",
  half: "Half an order came back",
  tenth: "10% of an order came back",
};

/**
 * What a win was, after its kind, in a live list: "free order" (or "half the order back", "10%
 * of the order back"), "trade won back", "premium pack", else "won" (a small ticket's included).
 * `price` is null when the ticket's opening was not read.
 */
export function winWords(kind: TicketKind, price: bigint | null, payout: bigint): string {
  if (kind === "Checkout") return CHECKOUT_WIN[checkoutBack(price, payout)];
  if (kind === "Swap") return "trade won back";
  if (kind === "Booster" && price !== null) return boosterExtra({ price }, payout) ?? "won";
  return "won";
}

/**
 * The buyer's line: "Checkout came back free +188.40", "Swap 0.25 USDC, 1 in 308 not this time".
 * `wallet` is the wallet's USDC account: a refunded beacon ticket's price reads as the wallet's
 * only when the ticket returns it there (it funded the ticket).
 */
export function buyerLine(
  r: TicketRow,
  demoApp: boolean,
  wallet?: Address | null,
): Line & { kind: TicketKind } {
  const kind = kindOf(r, demoApp);
  const payout = r.end?.payout ?? 0n;
  const odds = `${price(r)}, ${oddsOf(r)}`;
  const escrow = r.end?.pending ? ESCROW : "";
  if (!r.end) return { kind, title: kind, detail: odds, amount: "drawing", tone: "pending" };
  if (r.end.kind === "expired") {
    if (r.end.creditReturned) return { kind, title: kind, ...creditBackLine(r) };
    return r.end.refunded
      ? {
          kind,
          title: kind,
          ...(r.beacon?.refundTo === wallet ? refundedLine(r) : refundedElsewhereLine(r)),
        }
      : { kind, title: kind, detail: odds, amount: "no draw", tone: "muted" };
  }
  if (payout > 0n) {
    const detail =
      kind === "Checkout"
        ? CHECKOUT_BUYER[checkoutBack(r.price, payout)]
        : kind === "Booster"
          ? `${price(r)}, ${boosterExtra(r, payout) ?? "won"}`
          : kind === "Small ticket"
            ? `${price(r)}, won`
            : `${price(r)}, won back`;
    return { kind, title: kind, detail: detail + escrow, amount: `+${usdc(payout)}`, tone: "won" };
  }
  return { kind, title: kind, detail: odds, amount: NOT_THIS_TIME, tone: "muted" };
}

/**
 * The vault's line: "Order came back free, checkout, 2.50 USDC ticket +188.40" (what the winner
 * received), "Swap ticket, 0.25 USDC, 1 in 308, not this time +0.24" (what the vault kept).
 */
export function vaultLine(r: LineTicket, demoApp: boolean): Line {
  const kind = kindOf(r, demoApp);
  const payout = r.end?.payout ?? 0n;
  const kept = `+${usdc(r.vaultCredit)}`;
  const ticket = kind === "Ticket" || kind === "Small ticket" ? kind : `${kind} ticket`;
  if (!r.end)
    return {
      title: ticket,
      detail: `${price(r)}, ${oddsOf(r)}`,
      amount: "drawing",
      tone: "pending",
    };
  if (r.end.kind === "expired") {
    // A refunded beacon round gives the price back, a refunded direct ticket its credit: the
    // vault kept nothing either way.
    if (r.end.creditReturned) return { title: ticket, ...creditBackLine(r) };
    return r.end.refunded
      ? { title: ticket, ...refundedLine(r) }
      : { title: ticket, detail: `${price(r)}, no draw in time`, amount: kept, tone: "kept" };
  }
  if (payout > 0n) {
    const won = `+${usdc(payout)}`;
    if (kind === "Checkout")
      return {
        title: CHECKOUT_VAULT[checkoutBack(r.price, payout)],
        detail: `checkout, ${price(r)} ticket`,
        amount: won,
        tone: "won",
      };
    if (kind === "Booster")
      return {
        title: `Booster won a ${boosterExtra(r, payout) ?? "pack"}`,
        detail: `${price(r)} ticket`,
        amount: won,
        tone: "won",
      };
    return {
      title: kind === "Small ticket" ? "Small ticket won" : `${kind} won back`,
      detail: `${price(r)} ticket, ${oddsOf(r)}`,
      amount: won,
      tone: "won",
    };
  }
  return {
    title: ticket,
    detail: `${price(r)}, ${oddsOf(r)}, ${NOT_THIS_TIME}`,
    amount: kept,
    tone: "kept",
  };
}
