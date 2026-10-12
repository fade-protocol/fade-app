// A ticket in one line, as a sentence: what it was, what it cost, its odds, and how it ended.
// Two points of view: the buyer's (the Dashboard: what they received) and the vault's (the
// vault's Activity: what the winner received, or what the vault kept).
import { usdc } from "./format";
import { PACK_TICKETS, PREMIUM_PACKS, type CheckoutBack } from "./payoutTables";
import { checkoutBackOf } from "./ticketKind";
import { kindOf, oddsOf, type TicketKind, type TicketRow } from "./ticketLog";

/** A draw that paid nothing, wherever a ticket is listed. */
export const NOT_THIS_TIME = "not this time";

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

const price = (r: TicketRow) => `${usdc(r.price)} USDC`;

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
 * of the order back"), "trade won back", "premium pack", else "won". `price` is null when the
 * ticket's opening was not read.
 */
export function winWords(kind: TicketKind, price: bigint | null, payout: bigint): string {
  if (kind === "Checkout") return CHECKOUT_WIN[checkoutBack(price, payout)];
  if (kind === "Swap") return "trade won back";
  if (kind === "Booster" && price !== null) return boosterExtra({ price }, payout) ?? "won";
  return "won";
}

/** The buyer's line: "Checkout came back free +188.40", "Swap 0.25 USDC, 1 in 308 not this time". */
export function buyerLine(r: TicketRow, demoApp: boolean): Line & { kind: TicketKind } {
  const kind = kindOf(r, demoApp);
  const payout = r.end?.payout ?? 0n;
  const odds = `${price(r)}, ${oddsOf(r)}`;
  const escrow = r.end?.pending ? ", waits to be claimed" : "";
  if (!r.end) return { kind, title: kind, detail: odds, amount: "drawing", tone: "pending" };
  if (r.end.kind === "expired")
    return { kind, title: kind, detail: odds, amount: "no draw", tone: "muted" };
  if (payout > 0n) {
    const detail =
      kind === "Checkout"
        ? CHECKOUT_BUYER[checkoutBack(r.price, payout)]
        : kind === "Booster"
          ? `${price(r)}, ${boosterExtra(r, payout) ?? "won"}`
          : `${price(r)}, won back`;
    return { kind, title: kind, detail: detail + escrow, amount: `+${usdc(payout)}`, tone: "won" };
  }
  return { kind, title: kind, detail: odds, amount: NOT_THIS_TIME, tone: "muted" };
}

/**
 * The vault's line: "Order came back free, checkout, 2.50 USDC ticket +188.40" (what the winner
 * received), "Swap ticket, 0.25 USDC, 1 in 308, not this time +0.24" (what the vault kept).
 */
export function vaultLine(r: TicketRow, demoApp: boolean): Line {
  const kind = kindOf(r, demoApp);
  const payout = r.end?.payout ?? 0n;
  const kept = `+${usdc(r.vaultCredit)}`;
  const ticket = kind === "Ticket" ? kind : `${kind} ticket`;
  if (!r.end)
    return {
      title: ticket,
      detail: `${price(r)}, ${oddsOf(r)}`,
      amount: "drawing",
      tone: "pending",
    };
  if (r.end.kind === "expired")
    return { title: ticket, detail: `${price(r)}, no draw in time`, amount: kept, tone: "kept" };
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
      title: `${kind} won back`,
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
