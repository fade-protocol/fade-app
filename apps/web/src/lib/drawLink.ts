// A draw's link: app.fade.finance/w/<ticket>, what a share card's QR code and its post open. The
// ticket address keeps it short (the QR code stays small) and finds the draw's transactions even
// after the ticket account is closed. lib/draw reads the draw; this file only builds and parses
// the link, so the card can carry it without the reading code.
import { isAddress, type Address } from "@solana/kit";

/** Where the app lives: the links a card or a post carries are absolute. */
export const APP_ORIGIN = "https://app.fade.finance";
/** A draw's path, before the ticket address. */
export const DRAW_PATH = "/w/";

/** "https://app.fade.finance/w/<ticket>". */
export const drawUrl = (ticket: string) => `${APP_ORIGIN}${DRAW_PATH}${ticket}`;

/**
 * The ticket a path names: null when the path is not a draw's, `{ ticket: null }` when it is one
 * with no valid address (cut short, mistyped), so the page can say it found nothing.
 */
export function drawRouteOf(pathname: string): { ticket: Address | null } | null {
  if (!pathname.startsWith(DRAW_PATH)) return null;
  const rest = pathname.slice(DRAW_PATH.length).replace(/\/+$/, "");
  return { ticket: isAddress(rest) ? rest : null };
}
