import { usdc, mult, bps } from "../lib/format";
import type { Outcome } from "../lib/math";
import { payoutRow, payoutTableFooter } from "../lib/payoutTables";
import { useId, useState } from "react";
import { AnimatedHeight } from "./motion";
import { ExplorerAddress } from "./ui";

export type LabelledOutcome = Outcome & { label?: string };

export function PayoutTableView({
  outcomes,
  price,
  source,
  highlight,
  caption,
  collapsed = false,
}: {
  outcomes: readonly LabelledOutcome[];
  price: bigint;
  /** The ticket account the payout table was read from, once it is on-chain. */
  source?: string | undefined;
  highlight?: number | undefined;
  caption?: string;
  /** No row at all until "See all odds" (or the hit, once drawn); otherwise the top outcome first. */
  collapsed?: boolean;
}) {
  const id = useId();
  const [all, setAll] = useState(false);
  const foot = payoutTableFooter(outcomes);
  const shown = outcomes
    .map((b, i) => ({ b, i }))
    .filter(({ i }) => all || (i === 0 && !collapsed) || i === highlight);
  const hidden = outcomes.length - shown.length;
  const toggle = (hidden > 0 || all) && (
    <button
      type="button"
      className="disclosure-btn"
      aria-expanded={all}
      aria-controls={id}
      onClick={() => setAll((a) => !a)}
    >
      <span className="chev" aria-hidden="true" />
      {all ? "Fewer odds" : `See all odds (${outcomes.length})`}
    </button>
  );
  return (
    <div className={`payout-table${collapsed ? " payout-table-collapsed" : ""}`}>
      <div className="payout-table-head">
        <span className="eyebrow-s">{caption ?? "Odds"}</span>
        {source ? (
          <span className="small onchain">
            <span className="dot" aria-hidden="true" /> on-chain{" "}
            <ExplorerAddress address={source} />
          </span>
        ) : (
          <span className="small muted">stored on-chain at open</span>
        )}
        {collapsed && toggle}
      </div>
      <AnimatedHeight>
        <div className="table-wrap" id={id} hidden={shown.length === 0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th scope="col" className="num">
                  Odds
                </th>
                <th scope="col" className="num">
                  Pays
                </th>
                <th scope="col" className="num">
                  On {usdc(price)}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ b, i }) => {
                const row = payoutRow(b, price);
                return (
                  <tr
                    key={i}
                    className={`${highlight === i ? "hit" : ""}${all && i !== 0 ? " rise" : ""}`}
                  >
                    <th scope="row">
                      {b.label ?? (b.m === 0n ? "Nothing" : `Outcome ${i + 1}`)}
                      {all && (
                        <span className="muted small block mono p-raw">
                          p = {b.p.toLocaleString("en-US")}
                        </span>
                      )}
                    </th>
                    <td className="num mono">
                      {row.oneIn}
                      <span className="muted small block one-in">{row.pct}</span>
                    </td>
                    <td className="num mono">{mult(b.m)}</td>
                    <td className="num mono">{usdc(row.pays)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {all && foot !== null && foot.marginBps !== null && (
          <p className="small muted payout-table-foot">
            Expected return <span className="mono">{bps(foot.rtpBps)}</span>, margin{" "}
            <span className="mono">{bps(foot.marginBps)}</span>, Σ p × m ={" "}
            <span className="mono">{foot.lhs.toLocaleString("en-US")}</span>
          </p>
        )}
      </AnimatedHeight>
      {!collapsed && toggle}
    </div>
  );
}
