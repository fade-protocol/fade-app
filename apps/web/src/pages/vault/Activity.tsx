// Activity: what the vault did lately. Four figures over the last 24 h, then one line per ticket
// (its opening, draw and settlement told as one sentence) and one per deposit or withdrawal.
import { useMemo, useState } from "react";
import { EventRows, stateKeys, type EventRow } from "../../components/EventRows";
import { Tween, useFreshKeys } from "../../components/motion";
import { Skeleton } from "../../components/ui";
import { shares as fmtShares, signedAmount, usdc, usdcTidy as amount } from "../../lib/format";
import { strikeSeries } from "../../lib/history";
import { priceAt, valueAt } from "../../lib/positionPnl";
import type { TicketLog } from "../../lib/ticketLog";
import { vaultLine } from "../../lib/ticketWords";
import { activityFigures } from "../../lib/vaultFigures";
import type { VaultData } from "./common";

type Filter = "all" | "wins" | "lp";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "wins", label: "Wins" },
  { id: "lp", label: "Deposits and withdrawals" },
];
const PAGE = 40;

type Row = EventRow & { kind: "ticket" | "lp" };

export function ActivityPanel({ data, tickets }: { data: VaultData; tickets: TicketLog | null }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [count, setCount] = useState(PAGE);
  const now = Math.floor(Date.now() / 60_000) * 60;
  const items = data.log?.items ?? null;

  const rows = useMemo(() => {
    if (!tickets || !items) return null;
    const prices = strikeSeries(items, data.state.vault, now).map((p) => ({
      t: p.t,
      price: p.price,
    }));
    const out: Row[] = tickets.rows.map((r) => {
      const l = vaultLine(r, false);
      return {
        kind: "ticket",
        key: r.ticket,
        stateKey: `${r.ticket}:${r.end?.kind ?? "open"}`,
        t: r.openedAt,
        title: l.title,
        detail: l.detail,
        amount: l.amount,
        tone: l.tone,
        win: l.tone === "won",
        drawing: !r.end,
        signature: r.end?.signature ?? r.openSig,
      };
    });
    for (const item of items)
      item.events.forEach((e, i) => {
        const base = {
          kind: "lp" as const,
          key: `${item.signature}-${i}`,
          t: item.blockTime,
          signature: item.signature,
          tone: "plain" as const,
        };
        if (e.kind === "DepositRequested")
          out.push({
            ...base,
            title: "Deposit",
            detail: `a liquidity provider added ${amount(e.data.amount)} USDC`,
            amount: `+${amount(e.data.amount)}`,
          });
        else if (e.kind === "WithdrawRequested") {
          const p = priceAt(prices, item.blockTime ?? now);
          out.push({
            ...base,
            title: "Withdrawal",
            detail: `a liquidity provider took out ${fmtShares(e.data.shares)} fvUSDC`,
            amount: p === null ? "" : `−${usdc(valueAt(e.data.shares, p))}`,
          });
        }
      });
    return out.sort((a, b) => (b.t ?? now) - (a.t ?? now));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, items, data.state.vault]);

  const fresh = useFreshKeys(rows ? stateKeys(rows) : null);

  const figures = useMemo(
    () => (tickets && items ? activityFigures(tickets, items, now) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tickets, items],
  );

  const matching = (rows ?? []).filter((r) =>
    filter === "all" ? true : filter === "wins" ? r.win : r.kind === "lp",
  );

  return (
    <section className="activity" aria-label="Recent activity">
      <dl className="metrics metrics-4 activity-figures">
        <div className="metric">
          <dt>Tickets, {figures?.span ?? "24 h"}</dt>
          <dd>
            {figures ? (
              <Tween>{figures.n.toLocaleString("en-US")}</Tween>
            ) : (
              <Skeleton w={60} h={24} inline />
            )}
          </dd>
        </div>
        <div className="metric">
          <dt>Paid to winners</dt>
          <dd>
            {figures ? <Tween>{usdc(figures.paid)}</Tween> : <Skeleton w={80} h={24} inline />}
          </dd>
        </div>
        <div className="metric">
          <dt>Vault result</dt>
          <dd
            className={
              figures ? (figures.result > 0n ? "up" : figures.result < 0n ? "down" : "") : ""
            }
          >
            {figures ? (
              <Tween>{signedAmount(figures.result, amount)}</Tween>
            ) : (
              <Skeleton w={80} h={24} inline />
            )}
          </dd>
        </div>
        <div className="metric">
          <dt>Net deposits</dt>
          <dd>
            {figures ? (
              <Tween>{signedAmount(figures.net, amount)}</Tween>
            ) : (
              <Skeleton w={80} h={24} inline />
            )}
          </dd>
        </div>
      </dl>
      <div className="activity-list">
        <div className="pills" role="group" aria-label="Filter activity">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`pill${filter === f.id ? " on" : ""}`}
              aria-pressed={filter === f.id}
              onClick={() => {
                setFilter(f.id);
                setCount(PAGE);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        {!rows && !data.logError && (
          <div className="stack-s">
            <Skeleton h={22} />
            <Skeleton h={22} />
            <Skeleton h={22} />
          </div>
        )}
        {data.logError && !rows && (
          <p className="error small">
            The network did not answer ({data.logError}). This list tries again every 30 seconds.
          </p>
        )}
        {rows && matching.length === 0 && <p className="small muted">Nothing yet.</p>}
        {matching.length > 0 && (
          <EventRows
            rows={matching.slice(0, count)}
            relative
            label="Recent activity"
            fresh={fresh}
          />
        )}
        {matching.length > count && (
          <button
            type="button"
            className="link-btn small"
            onClick={() => setCount((c) => c + PAGE)}
          >
            Show more
          </button>
        )}
        <p className="small activity-note">
          Amounts on the right are what the winner received, or what the vault kept when nobody won.
        </p>
      </div>
    </section>
  );
}
