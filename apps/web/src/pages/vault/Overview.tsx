import { useMemo, useRef, useState } from "react";
import { ActionButton } from "../../components/Button";
import { Disclosure, InfoTip } from "../../components/disclosure";
import { Indicator, Tween, useSlidingIndicator } from "../../components/motion";
import { ExplorerTx, FailureBox, Skeleton } from "../../components/ui";
import { bps, fv, mult, signedPct as pct, sol, usdc } from "../../lib/format";
import { strikeSeries, type LpItem } from "../../lib/history";
import { useChainNow } from "../../lib/hooks";
import { strikeInstruction } from "../../lib/lp";
import {
  capTable,
  changePct,
  closeMoves,
  committedOf,
  fromCut,
  moveStats,
  utilisationBps,
  type StrikePoint,
} from "../../lib/vaultFigures";
import { send, type ProgramFailure } from "../../lib/tx";
import { useWallet } from "../../wallet/WalletProvider";
import { asFailure, doneByKeeper, isCancelled, type Live, type VaultData } from "./common";

type Range = "7D" | "30D" | "All";
const RANGE_SECONDS: Record<Range, number> = { "7D": 7 * 86400, "30D": 30 * 86400, All: Infinity };

/**
 * The vault's results close by close: how much each one moved the share price, with the change
 * over the range and its spread. The Performance tab.
 */
export function PerClose({ data }: { data: VaultData }) {
  const [range, setRange] = useState<Range>("All");
  const rangeRow = useRef<HTMLDivElement>(null);
  useSlidingIndicator(rangeRow, range);
  const nowS = Math.floor(Date.now() / 1000);
  const series = useMemo(
    () => (data.log ? strikeSeries(data.log.items, data.state.vault, nowS) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.log, data.state.vault],
  );
  const windowed = useMemo(
    () => (series ? fromCut(series, nowS - RANGE_SECONDS[range]) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, range],
  );
  const strikes = (windowed ?? []).filter((p) => p.epochId !== null && !p.carried).length;
  const change = windowed ? changePct(windowed) : null;

  return (
    <section className="flat-section perclose">
      <div className="section-head">
        <div>
          <h3 className="section-title label-tip">
            Result per close
            <InfoTip label="About this chart" docs>
              Each bar is how much one close moved the share price, read from its on-chain record.
              The price moves with every payout the vault takes or pays; any period can end up or
              down.
              {data.log?.truncated ? " Older closes are beyond the history this page reads." : ""}
            </InfoTip>
          </h3>
          {change !== null && strikes > 0 && (
            <p className="small">
              <span className={`mono ${change >= 0 ? "up" : "down"}`}>
                <Tween>{pct(change, 3)}</Tween>
              </span>{" "}
              <span className="muted">
                share price over {strikes} close{strikes === 1 ? "" : "s"}. Not a forecast.
              </span>
            </p>
          )}
        </div>
        <div className="seg has-ind" role="group" aria-label="Range" ref={rangeRow}>
          <Indicator />
          {(Object.keys(RANGE_SECONDS) as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              className={`seg-btn${range === r ? " on" : ""}`}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      {!series && !data.logError && <Skeleton h={160} />}
      {data.logError && !series && (
        <p className="error small">The vault's history did not load: {data.logError}</p>
      )}
      {series && <StrikeBars points={windowed ?? []} log={data.log?.items ?? []} />}
    </section>
  );
}

/**
 * Each strike's change in the share price, as bars: how much the vault's results moved it, epoch by
 * epoch, with the average and the spread. Shows the variance honestly; not a forecast. Hovering (or
 * focusing) a strike shows its figures, read from its `EpochStruck` event.
 */
function StrikeBars({ points, log }: { points: StrikePoint[]; log: LpItem[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const struck = useMemo(() => {
    const m = new Map<bigint, { deposits: bigint; assetsPaid: bigint }>();
    for (const item of log)
      for (const e of item.events) if (e.kind === "EpochStruck") m.set(e.data.epochId, e.data);
    return m;
  }, [log]);
  const moves = closeMoves(points);
  if (moves.length === 0)
    return (
      <p className="muted small chart-empty">Not enough closes in this range: pick a longer one.</p>
    );
  const { mean, sd } = moveStats(moves);
  const top = Math.max(...moves.map((m) => Math.abs(m.pct)), 1e-9);
  const h = hover === null ? null : moves[hover];
  const flows = h ? struck.get(h.epoch) : undefined;
  const at = hover === null ? 0 : ((hover + 0.5) / moves.length) * 100;
  const when = h ? new Date(h.t * 1000) : null;
  return (
    <div className="strike-bars">
      <div
        className="sb-plot"
        role="group"
        aria-label="Share price change per close"
        onPointerLeave={() => setHover(null)}
      >
        <span className="sb-zero" aria-hidden="true" />
        {moves.map((m, i) => (
          <button
            key={m.epoch.toString()}
            type="button"
            className={`sb-col${hover === i ? " is-hover" : ""}`}
            style={{ width: `${100 / moves.length}%` }}
            aria-label={`Close ${m.epoch.toString()}: ${pct(m.pct, 3)}`}
            onPointerEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          >
            <span
              className={`sb-bar ${m.pct >= 0 ? "up" : "down"}`}
              style={{ height: `${Math.max(0.6, (Math.abs(m.pct) / top) * 46)}%` }}
            />
          </button>
        ))}
        {h && when && (
          <div
            className={`chart-tip sb-tip ${h.pct >= 0 ? "below" : "above"}`}
            style={{ left: `${Math.min(Math.max(at, 14), 86)}%` }}
            aria-hidden="true"
          >
            <span className="small muted">
              {when.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}{" "}
              {when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className={`mono ${h.pct >= 0 ? "up" : "down"}`}>{pct(h.pct, 3)}</span>
            <span className="small mono">
              {usdc(h.before, 6)} to {usdc(h.after, 6)}
            </span>
            {flows && (
              <span className="small muted">
                {usdc(flows.deposits)} USDC in, {usdc(flows.assetsPaid)} USDC out
              </span>
            )}
            <span className="small muted">Vault after: {usdc(h.assets)} USDC</span>
          </div>
        )}
      </div>
      <p className="small muted">
        {moves.length} close{moves.length === 1 ? "" : "s"}, average{" "}
        <span className={`mono ${mean >= 0 ? "up" : "down"}`}>{pct(mean, 3)}</span>, spread{" "}
        <span className="mono">±{sd.toFixed(3)} %</span>. Not a forecast.
      </p>
    </div>
  );
}

/** A half-circle gauge of committed / assets, with the breaker as a tick. */
export function UtilisationGauge({ state }: { state: Live }) {
  const { vault, config } = state;
  const committed = committedOf(vault);
  const u = Number(utilisationBps(vault)) / 10_000;
  const breaker = Number(config.params.utilisationBreakerBps) / 10_000;
  const r = 70;
  const len = Math.PI * r;
  const at = (f: number) => {
    const a = Math.PI * (1 - Math.min(1, Math.max(0, f)));
    return { x: 90 + r * Math.cos(a), y: 90 - r * Math.sin(a) };
  };
  const tickIn = at(breaker);
  const tickOut = { x: 90 + (tickIn.x - 90) * 1.22, y: 90 + (tickIn.y - 90) * 1.22 };
  return (
    <div className="card viz-card">
      <div className="viz-head">
        <h3 className="label-tip">
          Utilisation
          <InfoTip label="About utilisation">
            Committed (open liability and open tickets) divided by the vault's assets. New payouts
            pause at the tick.
          </InfoTip>
        </h3>
      </div>
      <svg
        className="gauge"
        viewBox="0 0 180 104"
        role="img"
        aria-label={`Utilisation ${(u * 100).toFixed(2)} percent; new payouts stop at ${(breaker * 100).toFixed(0)} percent`}
      >
        <path d="M20 90 A70 70 0 0 1 160 90" className="gauge-track" pathLength={len} />
        <path
          d="M20 90 A70 70 0 0 1 160 90"
          className="gauge-value"
          strokeDasharray={`${Math.max(0.001, u) * len} ${len}`}
        />
        <line x1={tickIn.x} y1={tickIn.y} x2={tickOut.x} y2={tickOut.y} className="gauge-tick" />
        <text x="90" y="80" textAnchor="middle" className="gauge-text">
          <Tween>{`${(u * 100).toFixed(u < 0.1 ? 2 : 1)} %`}</Tween>
        </text>
      </svg>
      <p className="small muted center">
        Pauses at <span className="mono">{bps(config.params.utilisationBreakerBps, 0)}</span>,{" "}
        <span className="mono">
          <Tween>{usdc(committed)}</Tween>
        </span>{" "}
        USDC committed
      </p>
    </div>
  );
}

/** Countdown ring to the live epoch's close (the next price), and the strike once it is due. */
export function EpochRing({ data }: { data: VaultData }) {
  const { state, fund } = data;
  const chainNow = useChainNow(state);
  const { signer } = useWallet();
  const { queue, vault, config } = state;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ProgramFailure | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const [raced, setRaced] = useState(false);
  const cur = queue.current;
  const length = Number(config.params.epochLengthSeconds);
  const left = cur.live ? Math.max(0, Number(cur.closeTs) - chainNow) : 0;
  const closed = cur.live && left <= 0;
  const clean = vault.openBeforeClose === 0;
  const frac = cur.live ? 1 - Math.min(1, left / Math.max(1, length)) : 0;
  const r = 44;
  const c = 2 * Math.PI * r;
  const mm = Math.floor(left / 60);
  const ss = Math.floor(left % 60);

  return (
    <div className="card viz-card">
      <div className="viz-head">
        <h3 className="label-tip">
          Next close
          <InfoTip label="About the close" docs>
            Deposits and withdrawals wait for the next close, where one price is set for all of them
            once the draws opened before it are in. The next deposit or withdrawal starts the clock.
            Anyone can set the price once it is due, for a reward from the pricing fund.
          </InfoTip>
        </h3>
      </div>
      <div className="ring-wrap">
        <svg
          className={`ring${closed ? " ring-due" : ""}`}
          viewBox="0 0 110 110"
          aria-hidden="true"
        >
          <circle cx="55" cy="55" r={r} className="ring-track" />
          <circle
            cx="55"
            cy="55"
            r={r}
            className="ring-value"
            strokeDasharray={`${frac * c} ${c}`}
            transform="rotate(-90 55 55)"
          />
        </svg>
        <div className="ring-center" role="timer" aria-live="off">
          <span className="mono ring-time">
            {!cur.live ? "–" : closed ? "due" : `${mm}:${ss.toString().padStart(2, "0")}`}
          </span>
          <span className="small muted">
            {!cur.live ? "idle" : closed ? (clean ? "ready" : "finishing") : "to close"}
          </span>
        </div>
      </div>
      <p className="small muted center">
        {!cur.live
          ? "Nothing waiting"
          : closed
            ? clean
              ? `Due: up to ${sol(
                  fund !== null && fund < config.params.strikeRewardLamports
                    ? fund
                    : config.params.strikeRewardLamports,
                )} SOL to set it`
              : `${vault.openBeforeClose} draw${vault.openBeforeClose === 1 ? "" : "s"} to finish`
            : `${usdc(cur.deposits)} USDC in, ${fv(cur.withdrawShares)} out`}
      </p>
      {closed && clean && signer && (
        <ActionButton
          type="button"
          className="btn-outline btn-small btn-block"
          busy={busy}
          busyLabel="Setting the price…"
          succeeded={sig}
          successLabel="Priced"
          failed={failure}
          onClick={async () => {
            setBusy(true);
            setFailure(null);
            try {
              const s = await send(
                signer,
                [await strikeInstruction(signer, cur.epochId)],
                "strike_epoch",
                200_000,
              );
              setSig(s.signature);
              data.refresh();
            } catch (e) {
              const f = asFailure(e);
              if (doneByKeeper(f, "strike")) {
                setRaced(true);
                data.refresh();
              } else if (!isCancelled(f)) setFailure(f);
            } finally {
              setBusy(false);
            }
          }}
        >
          Set the price yourself
        </ActionButton>
      )}
      {sig && (
        <p className="small center">
          Priced <ExplorerTx sig={sig} />
        </p>
      )}
      {raced && <p className="small muted center">Already set.</p>}
      {failure && <FailureBox failure={failure} />}
      <p className="small muted center">
        Pricing fund{" "}
        <span className="mono">
          {fund === null ? <Skeleton w={70} h={12} inline /> : <Tween>{`${sol(fund)} SOL`}</Tween>}
        </span>
      </p>
    </div>
  );
}

export function CapCard({ state }: { state: Live }) {
  const p = state.config.params;
  // for 48 h after a drawdown trip the program halves every cap
  const { price, demoMargin, demoCap, halved, rows, appCeiling } = capTable(state);
  return (
    <div className="card viz-card">
      <div className="viz-head">
        <h3 className="label-tip">
          Max per payout
          <InfoTip label="About the per-payout cap">
            At the demos' vault margin: the smaller of {bps(p.censorshipBps)} of assets and{" "}
            {bps(p.kellyFractionBps, 0)} of the Kelly bound. It caps what the vault can owe on one
            payout, whatever the odds.
          </InfoTip>
        </h3>
      </div>
      <p className="big-figure">
        <span className="mono">
          <Tween>{usdc(demoCap)}</Tween>
        </span>
        <span className="stat-unit">USDC</span>
      </p>
      {halved && (
        <p className="small warn-text">
          Halved after a drawdown, until{" "}
          {new Date(Number(state.vault.drawdownTripTs + 48n * 3600n) * 1000).toLocaleString()}.
        </p>
      )}
      <Disclosure summary="By vault margin" className="cap-details">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Vault margin</th>
                <th scope="col" className="num">
                  Cap
                </th>
                <th scope="col" className="num">
                  Max × on {usdc(price)}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ margin, cap, maxM }) => (
                <tr key={margin.toString()}>
                  <th scope="row" className="mono">
                    {bps(margin)}
                    {margin === p.minVaultMarginBps && (
                      <span className="muted small block">the floor</span>
                    )}
                    {margin === demoMargin && <span className="muted small block">the demos</span>}
                  </th>
                  <td className="num mono">{usdc(cap)}</td>
                  <td className="num mono">{mult(maxM)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          One app may hold at most {bps(p.whaleBps, 0)} of assets in open liability:{" "}
          <span className="mono">{usdc(appCeiling)}</span> USDC.
        </p>
      </Disclosure>
    </div>
  );
}

export function HowItWorks({ state }: { state: Live }) {
  const length = Number(state.config.params.epochLengthSeconds);
  const period = length >= 120 ? `${Math.round(length / 60)} min` : `${length} s`;
  const steps = [
    {
      t: "Request",
      s: "Sign once to deposit or withdraw.",
      d: "Deposit USDC or redeem fvUSDC. The request waits for the next close.",
    },
    {
      t: "Price",
      s: `Every ${period}, one price for everyone.`,
      d: "Once the draws opened before the close are in, every request clears at the same price.",
    },
    {
      t: "Claim",
      s: "fvUSDC or USDC arrive by themselves.",
      d: "Delivered automatically to your wallet. Anyone may claim instead.",
    },
  ];
  return (
    <div className="how-pop">
      <div className="viz-head">
        <h3>How the vault works</h3>
        <span className="small muted">no fixed lockup</span>
      </div>
      <ol className="lp-steps" aria-label="How a deposit or a withdrawal works">
        {steps.map((s, i) => (
          <li key={s.t}>
            <span className="track-dot" aria-hidden="true">
              {i + 1}
            </span>
            <div>
              <p className="lp-step-title">{s.t}</p>
              <p className="small muted">
                {s.s} {s.d}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <p className="small muted">
        Providers carry the variance of every payout the vault accepts. It earns its margin on
        average; any single period can end up or down. There is no headline yield to quote. A large
        withdrawal may be paid over several closes while open payouts need the reserve.
      </p>
    </div>
  );
}
