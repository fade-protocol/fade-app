// "Where the vault earns": every app that opens tickets against the vault, what it brought in
// over the tickets read, and what it holds at risk now against the cap per app.
import type { Address } from "@solana/kit";
import { useMemo, useState } from "react";
import { InfoTip } from "../../components/disclosure";
import { ExplorerAddress, Skeleton } from "../../components/ui";
import { fetchIntegrators } from "../../lib/fade";
import { bps, short, signedAmount, usdc } from "../../lib/format";
import { usePolling } from "../../lib/hooks";
import { PROGRAM_WINDOW_S, statsByApp, type TicketLog } from "../../lib/ticketLog";
import { appRisk } from "../../lib/vaultFigures";
import type { Live } from "./common";

const SHOWN = 6;

export function AppName({ authority, owner }: { authority: Address; owner?: Address | undefined }) {
  return (
    <span className="app-name">
      <ExplorerAddress address={authority}>
        <span>App {short(authority)}</span>
      </ExplorerAddress>
      {authority === owner && <span className="you-tag">You</span>}
    </span>
  );
}

export function WhereVaultEarns({
  state,
  tickets,
  owner,
}: {
  state: Live;
  tickets: TicketLog | null;
  owner: Address | undefined;
}) {
  const list = usePolling(fetchIntegrators, 60_000);
  const [all, setAll] = useState(false);
  const stats = useMemo(() => (tickets ? statsByApp(tickets) : null), [tickets]);
  const assets = state.vault.totalAssets;
  const whale = state.config.params.whaleBps;
  const days = Math.round(PROGRAM_WINDOW_S / 86400);
  const period = tickets?.truncated ? "recent" : `${days}D`;

  const rows = useMemo(() => {
    if (!list.data) return null;
    return list.data
      .map((i) => ({ i, s: stats?.get(i.address) }))
      .filter(({ i, s }) => (s?.tickets ?? 0) > 0 || i.data.reservedLiability > 0n)
      .sort((a, b) => {
        const va = a.s?.volume ?? 0n;
        const vb = b.s?.volume ?? 0n;
        return va === vb
          ? Number(b.i.data.reservedLiability - a.i.data.reservedLiability)
          : vb > va
            ? 1
            : -1;
      });
  }, [list.data, stats]);

  return (
    <section className="flat-section">
      <h2 className="section-title-l">Where the vault earns</h2>
      <p className="small muted section-lede">
        Every app that opens tickets against the vault, and what it brought in.
      </p>
      {!rows && <Skeleton h={120} />}
      {rows && rows.length === 0 && (
        <p className="small muted">No tickets over the last {days} days.</p>
      )}
      {rows && rows.length > 0 && (
        <div className="table-box">
          <table className="flat-table">
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col" className="num">
                  Tickets, {period}
                </th>
                <th scope="col" className="num">
                  Volume, {period}
                </th>
                <th scope="col" className="num">
                  <span className="label-tip">
                    Vault result
                    <InfoTip label="About the vault result" docs>
                      What the vault kept on this app's tickets drawn over the period: their ticket
                      prices, less the payouts it paid.
                    </InfoTip>
                  </span>
                </th>
                <th scope="col">
                  <span className="label-tip">
                    At risk now
                    <InfoTip label="About the risk" docs>
                      The app's open payouts at their worst case, as a share of the vault. One app
                      may hold at most {bps(whale, 0)}.
                    </InfoTip>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(all ? rows : rows.slice(0, SHOWN)).map(({ i, s }) => {
                const { risk, fill } = appRisk(i.data.reservedLiability, assets, whale);
                return (
                  <tr key={i.address}>
                    <th scope="row">
                      <AppName authority={i.data.authority} owner={owner} />
                    </th>
                    <td className="num mono">{s?.tickets ?? 0}</td>
                    <td className="num mono">{usdc(s?.volume ?? 0n)} USDC</td>
                    <td
                      className={`num mono ${!s || s.settled === 0 ? "" : s.result >= 0n ? "up" : "down"}`}
                    >
                      {s && s.settled > 0 ? signedAmount(s.result) : "–"}
                    </td>
                    <td>
                      <span className="risk">
                        <span className="bar" aria-hidden="true">
                          <i style={{ width: `${fill}%` }} />
                        </span>
                        <span className="mono">{bps(risk, risk < 100n ? 2 : 1)}</span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length > SHOWN && (
        <button type="button" className="link-btn small" onClick={() => setAll((a) => !a)}>
          {all ? "Fewer apps" : `All ${rows.length} apps`}
        </button>
      )}
      <p className="small dim">
        One app can never hold more than {bps(whale, 0)} of the vault at risk.
      </p>
    </section>
  );
}
