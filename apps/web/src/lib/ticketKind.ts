// Which demo a ticket came from, read from its opening alone (its price and worst case). Kept
// apart from ticketLog so the keeper can name a ticket without the app's RPC client.
import { payout } from "./math";
import {
  CHECKOUT_BACKS,
  PACK_TICKETS,
  PREMIUM_PACKS,
  checkoutPayoutTableFor,
  type CheckoutBack,
} from "./payoutTables";

/** The booster's worst case is a premium pack: ten packs, five hundred add-ons (lib/payoutTables). */
export const BOOSTER_PAYOUT = PACK_TICKETS * PREMIUM_PACKS;

export type TicketKind = "Checkout" | "Swap" | "Booster" | "Small ticket" | "Ticket";

/**
 * What a checkout ticket's win sends back, read from its worst case: the whole cart, half of it,
 * or a tenth of it, each with the ticket. The program floors the payout of the table's
 * multiplier, so the worst case is exactly what that table pays. Null for any other ticket.
 */
export function checkoutBackOf(r: { price: bigint; payoutMax: bigint }): CheckoutBack | null {
  if (r.price <= 0n) return null;
  for (const back of CHECKOUT_BACKS) {
    const win = checkoutPayoutTableFor(back)(r.price)[0];
    if (win && r.payoutMax === payout(r.price, win.m)) return back;
  }
  return null;
}

/**
 * Which demo a ticket came from. A ticket of the shared beacon (`beacon` set: it joined a round)
 * is the beacon demo's small ticket. A direct ticket reads by the shape of its worst case: the
 * booster's is a premium pack, five hundred tickets; the checkout's the cart (or half or a tenth
 * of it) plus the ticket; any other win-back is a swap. Tickets of other apps read as "Ticket".
 */
export function kindOf(
  r: { price: bigint; payoutMax: bigint; beacon?: unknown },
  demoApp: boolean,
): TicketKind {
  if (r.beacon) return demoApp ? "Small ticket" : "Ticket";
  if (r.payoutMax === r.price * BOOSTER_PAYOUT) return "Booster";
  if (checkoutBackOf(r) !== null) return "Checkout";
  return demoApp ? "Swap" : "Ticket";
}
