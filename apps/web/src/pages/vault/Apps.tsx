// "Where the vault earns": every app that opens tickets against the vault, what it brought in
// over the last 7 days, and what it holds at risk now against the cap per app. The 7 days are
// the keeper's (GET /v1/vault, lib/keeperViews), the app's own over the tickets it read when the
// keeper cannot serve them, else the keeper's while it still reads the 7 days, labelled with
// the period it covers; what each app holds at risk is always read from the chain.
import type { Address } from "@solana/kit";
import { useMemo, useState } from "react";
import { InfoTip } from "../../components/disclosure";
import { ExplorerAddress, Skeleton } from "../../components/ui";
import { fetchIntegrators } from "../../lib/fade";
import { bps, short, signedAmount, usdc } from "../../lib/format";
import { usePolling } from "../../lib/hooks";
import { chooseView, type KeeperVault } from "../../lib/keeperViews";
import { coveredFrom, statsByApp, type TicketLog } from "../../lib/ticketLog";
import { appRisk, windowLabel, windowWords } from "../../lib/vaultFigures";
import { APPS_WINDOW_S } from "../../lib/vaultViews";
import type { Live } from "./common";

type AppFigures = { tickets: number; volume: bigint; result: bigint; settled: number };

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
  keeper,
  tickets,
  owner,
}: {
  state: Live;
  /** The keeper's vault history, null until it answers or when it cannot be reached. */
  keeper: KeeperVault | null;
  /** The program's tickets the app read itself, only when the keeper cannot serve them. */
  tickets: TicketLog | null;
  owner: Address | undefined;
}) {
  // the live read: each app's open liability now, and its key
  const list = usePolling(fetchIntegrators, 60_000);
  const [all, setAll] = useState(false);
  const now = Math.floor(Date.now() / 60_000) * 60;
  const source = chooseView(keeper, tickets, undefined, (k) => k.coveredFrom !== null);
  const fromKeeper = source && "keeper" in source ? source.keeper : null;
  const ownLog = source && "own" in source ? source.own : null;
  const assets = state.vault.totalAssets;
  const whale = state.config.params.whaleBps;
  // the true window: the keeper's 7 days, as far back as the app's own read reaches, or as far
  // back as the keeper read while it still reads the 7 days
  const covered = ownLog
    ? coveredFrom(ownLog)
    : fromKeeper?.syncing && fromKeeper.coveredFrom !== null
      ? fromKeeper.coveredFrom
      : -Infinity;
  const span = Math.min(APPS_WINDOW_S, now - covered);
  const period = span >= APPS_WINDOW_S ? `${APPS_WINDOW_S / 86400}D` : windowLabel(span);

  const stats = useMemo((): Map<Address, AppFigures & { authority: Address | null }> | null => {
    if (fromKeeper) return new Map(fromKeeper.apps.map((a) => [a.integrator, a] as const));
    if (!ownLog) return null;
    return new Map(
      [...statsByApp(ownLog)].map(([k, v]) => [k, { ...v, authority: null }] as const),
    );
  }, [fromKeeper, ownLog]);

  const rows = useMemo(() => {
    const live = list.data ? new Map(list.data.map((i) => [i.address, i.data] as const)) : null;
    // the keeper's apps show at once; the live read adds what each holds at risk, and the apps
    // with something at risk and no ticket in the window; the app's own figures name no app
    if (!stats || (!live && !fromKeeper)) return null;
    const keys = new Set<Address>([...stats.keys(), ...(live?.keys() ?? [])]);
    return [...keys]
      .map((address) => {
        const s = stats.get(address);
        const i = live?.get(address);
        return {
          address,
          authority: i?.authority ?? s?.authority ?? null,
          reserved: i ? i.reservedLiability : null,
          s,
        };
      })
      .filter(
        ({ s, reserved, authority }) =>
          authority !== null && ((s?.tickets ?? 0) > 0 || (reserved ?? 0n) > 0n),
      )
      .sort((a, b) => {
        const va = a.s?.volume ?? 0n;
        const vb = b.s?.volume ?? 0n;
        return va === vb ? Number((b.reserved ?? 0n) - (a.reserved ?? 0n)) : vb > va ? 1 : -1;
      });
  }, [list.data, stats, fromKeeper]);

  return (
    <section className="flat-section">
      <h2 className="section-title-l">Where the vault earns</h2>
      <p className="small muted section-lede">
        Every app that opens tickets against the vault, and what it brought in.
      </p>
      {!rows && <Skeleton h={120} />}
      {rows && rows.length === 0 && (
        <p className="small muted">No tickets over the last {windowWords(span)}.</p>
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
              {(all ? rows : rows.slice(0, SHOWN)).map(({ address, authority, reserved, s }) => {
                const { risk, fill } = appRisk(reserved ?? 0n, assets, whale);
                return (
                  <tr key={address}>
                    <th scope="row">
                      <AppName authority={authority!} owner={owner} />
                    </th>
                    <td className="num mono">{s?.tickets ?? 0}</td>
                    <td className="num mono">{usdc(s?.volume ?? 0n)} USDC</td>
                    <td
                      className={`num mono ${!s || s.settled === 0 ? "" : s.result >= 0n ? "up" : "down"}`}
                    >
                      {s && s.settled > 0 ? signedAmount(s.result) : "–"}
                    </td>
                    <td>
                      {reserved === null ? (
                        <Skeleton w={90} h={14} inline />
                      ) : (
                        <span className="risk">
                          <span className="bar" aria-hidden="true">
                            <i style={{ width: `${fill}%` }} />
                          </span>
                          <span className="mono">{bps(risk, risk < 100n ? 2 : 1)}</span>
                        </span>
                      )}
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
