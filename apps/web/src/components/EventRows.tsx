// A history as thin rows: the time, a short label, a muted detail and the amount on the right,
// one line each, no icon except a small mark on a won row. Grouped under small day headers (TODAY, YESTERDAY, 2 OCT), or, for a
// live feed, with the time as "2 min" and no headers. The time links to the transaction. A row
// whose state key just appeared (`useFreshKeys` over the whole list, before any filter) drops in
// and glows, green for a win; a ticket still drawing blinks.
import { Fragment, type ReactNode } from "react";
import { explorerTx } from "../lib/config";
import type { LineTone } from "../lib/ticketWords";

export type EventRow = {
  key: string;
  /** Unix seconds. */
  t: number | null;
  title: ReactNode;
  detail?: ReactNode;
  amount: ReactNode;
  tone?: LineTone;
  signature?: string;
  /** Changes when the row's state changes (a draw that ends): it lights up again then. */
  stateKey?: string;
  win?: boolean;
  /** A ticket still drawing: the amount blinks. */
  drawing?: boolean;
  /** A small mark before the title, for a won row only (components/WinIcon). */
  icon?: ReactNode;
  /** A small button between the text and the amount (a payout to claim). */
  action?: ReactNode;
};

/** The state keys of rows, for `useFreshKeys`. */
export const stateKeys = (rows: readonly EventRow[]) => rows.map((r) => r.stateKey ?? r.key);

const hm = (t: number) =>
  new Date(t * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** "TODAY", "YESTERDAY", "2 OCT" (with the year when it is not this one). */
export function dayLabel(t: number, now = Date.now() / 1000): string {
  const d = new Date(t * 1000);
  const today = new Date(now * 1000);
  const yesterday = new Date(now * 1000 - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "TODAY";
  if (d.toDateString() === yesterday.toDateString()) return "YESTERDAY";
  return d
    .toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
    })
    .toUpperCase();
}

/** "now", "2 min", "3 h", "2 d". */
export function since(t: number, now = Date.now() / 1000): string {
  const d = Math.max(0, Math.floor(now - t));
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)} min`;
  if (d < 86400) return `${Math.floor(d / 3600)} h`;
  return `${Math.floor(d / 86400)} d`;
}

function Row({ r, relative, fresh }: { r: EventRow; relative: boolean; fresh: boolean }) {
  const time = r.t === null ? "" : relative ? since(r.t) : hm(r.t);
  return (
    <li className={`erow${fresh ? " row-new" : ""}${r.win ? " is-win" : ""}`}>
      {r.signature ? (
        <a className="erow-time" href={explorerTx(r.signature)} target="_blank" rel="noreferrer">
          {time}
          <span className="sr-only"> (opens the transaction in the Solana explorer)</span>
        </a>
      ) : (
        <span className="erow-time">{time}</span>
      )}
      <span className="erow-text">
        {r.icon ? (
          <span className="erow-icon" aria-hidden="true">
            {r.icon}
          </span>
        ) : null}
        <span className="erow-title">{r.title}</span>
        {r.detail ? <span className="erow-detail"> {r.detail}</span> : null}
      </span>
      {r.action ? <span className="erow-action">{r.action}</span> : null}
      <span className={`erow-amount ${r.tone ?? "plain"}`}>
        <span className={r.drawing ? "draw-pending" : "row-amount"}>{r.amount}</span>
      </span>
    </li>
  );
}

export function EventRows({
  rows,
  relative = false,
  label,
  fresh,
}: {
  /** Newest first. */
  rows: readonly EventRow[];
  /** A live feed: "2 min" and no day headers. */
  relative?: boolean;
  label: string;
  /** State keys that just appeared. */
  fresh?: ReadonlySet<string>;
}) {
  const isFresh = (r: EventRow) => !!fresh?.has(r.stateKey ?? r.key);
  if (relative)
    return (
      <ul className="erows erows-rel" aria-label={label}>
        {rows.map((r) => (
          <Row key={r.key} r={r} relative fresh={isFresh(r)} />
        ))}
      </ul>
    );
  const groups: { day: string; rows: EventRow[] }[] = [];
  for (const r of rows) {
    const day = r.t === null ? "EARLIER" : dayLabel(r.t);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else groups.push({ day, rows: [r] });
  }
  return (
    <div className="erows-days" aria-label={label} role="group">
      {groups.map((g, i) => (
        <Fragment key={`${g.day}-${i}`}>
          <p className="erow-day">{g.day}</p>
          <ul className="erows">
            {g.rows.map((r) => (
              <Row key={r.key} r={r} relative={false} fresh={isFresh(r)} />
            ))}
          </ul>
        </Fragment>
      ))}
    </div>
  );
}
