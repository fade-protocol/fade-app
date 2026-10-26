// Every liquidity provider: each holder of the share mint, and anyone with a request still open,
// as the keeper lists them from the chain (the app's own scan while it cannot), the connected
// wallet's line read by the app itself. On the Risk tab: how concentrated the vault is. The
// largest few first, the rest on demand.
import { useState } from "react";
import { InfoTip } from "../../components/disclosure";
import { Chip, ExplorerAddress, Skeleton } from "../../components/ui";
import { bps, fv, shares as fmtShares, usdc } from "../../lib/format";
import type { VaultData } from "./common";

/** Providers listed before "Show all". */
const SHOWN = 6;

const day = (unixSeconds: number) =>
  new Date(unixSeconds * 1_000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export function ProvidersPanel({ data }: { data: VaultData }) {
  const { providers, owner } = data;
  const [all, setAll] = useState(false);
  if (!providers)
    return (
      <div className="flat-section stack-s">
        <Skeleton h={34} />
        <Skeleton h={34} />
        <Skeleton h={34} />
      </div>
    );

  const list = providers.lines;
  const firstDeposits = providers.firstDeposits;

  return (
    <section className="flat-section">
      <div className="section-head">
        <h3 className="section-title label-tip">
          Liquidity providers
          <InfoTip label="About this list" docs>
            Every holder of fvUSDC, valued at today's share price. fvUSDC queued for withdrawal stay
            in the vault's escrow until the next close and count in the holder's vault share;
            deposits count once priced.
          </InfoTip>
        </h3>
        <span className="small muted">
          {list.length} provider{list.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="table-wrap">
        <table className="providers">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Provider</th>
              <th scope="col" className="num">
                fvUSDC
              </th>
              <th scope="col" className="num">
                Value, USDC
              </th>
              <th scope="col" className="num">
                Vault share
              </th>
              <th scope="col" className="num hide-s">
                Pending
              </th>
              {firstDeposits && (
                <th scope="col" className="num hide-s">
                  First deposit
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {(all ? list : list.slice(0, SHOWN)).map((r, i) => {
              const pctBps = r.shareBps;
              const you = r.owner === owner;
              return (
                <tr key={r.owner} className={you ? "you" : undefined}>
                  <td className="muted mono">{i + 1}</td>
                  <th scope="row">
                    <ExplorerAddress address={r.owner} />
                    {you && (
                      <>
                        {" "}
                        <Chip tone="won">You</Chip>
                      </>
                    )}
                  </th>
                  <td className="num mono">{fmtShares(r.shares)}</td>
                  <td className="num mono">{usdc(r.value)}</td>
                  <td className="num">
                    <span className="mono">{bps(pctBps)}</span>
                    <span className="bar" aria-hidden="true">
                      <i style={{ width: `${Math.min(100, Number(pctBps) / 100)}%` }} />
                    </span>
                  </td>
                  <td className="num small hide-s">
                    {r.depositIn === 0n && r.sharesOut === 0n ? (
                      <span className="muted">–</span>
                    ) : (
                      <span className="pending-cell">
                        {r.depositIn > 0n && (
                          <span className="mono up">+{usdc(r.depositIn)} USDC</span>
                        )}
                        {r.sharesOut > 0n && <span className="mono down">−{fv(r.sharesOut)}</span>}
                      </span>
                    )}
                  </td>
                  {firstDeposits && (
                    <td className="num small hide-s">
                      {r.firstDepositAt === null ? (
                        <span className="muted">–</span>
                      ) : (
                        day(r.firstDepositAt)
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {list.length > SHOWN && (
        <button type="button" className="link-btn small" onClick={() => setAll((a) => !a)}>
          {all ? "Fewer providers" : `Show all ${list.length} providers`}
        </button>
      )}
    </section>
  );
}
