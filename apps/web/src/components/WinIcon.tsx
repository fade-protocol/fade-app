// The small mark a won row carries in a history: what kind of thing came back. Drawn in the
// row's text colour by the caller (mint), 14 px, decorative.
import type { TicketKind } from "../lib/ticketKind";

const paths: Record<TicketKind, string> = {
  // a receipt with a torn foot
  Checkout: "M4 1.5h8v12l-1.33-1-1.34 1-1.33-1-1.33 1-1.34-1L4 13.5zM6 5h4M6 7.5h4M6 10h2.5",
  // two arrows passing each other
  Swap: "M2.5 5h9m0 0-2.5-2.5M11.5 5 9 7.5M13.5 11h-9m0 0L7 8.5M4.5 11 7 13.5",
  // a pack with a star
  Booster: "M3.5 1.5h9v13h-9zM8 5.2l.9 1.8 2 .3-1.45 1.4.35 2L8 9.75l-1.8.95.35-2L5.1 7.3l2-.3z",
  // a spark
  Ticket:
    "M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2.1 2.1M10.5 10.5l2.1 2.1M3.4 12.6l2.1-2.1M10.5 5.5l2.1-2.1",
};

export function WinIcon({ kind }: { kind: TicketKind }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d={paths[kind]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
