// The vault's main chart: the APR (shown first), the share price, the deposits (the vault's
// assets) or the ticket volume, over a day, a week, a month or everything served. The APR is the
// keeper's hourly series (lib/vaultApr); the closes and the hourly ticket volume are its too
// (GET /v1/vault, lib/keeperViews), today's point the app's own read of the vault, and the
// closes of the vault's history older than the keeper keeps (its 30 days) the app's own. Each
// is the app's own, from the history and the tickets it read, while the keeper cannot serve it
// over the whole 30 days.
// Switching morphs the line.
import { useMemo, useState } from "react";
import { InfoTip } from "../../components/disclosure";
import { FluidChart } from "../../components/FluidChart";
import { Tween } from "../../components/motion";
import { Skeleton } from "../../components/ui";
import { signedPct, usdc } from "../../lib/format";
import { livePoint, strikeSeries } from "../../lib/history";
import { chooseView, type KeeperVault } from "../../lib/keeperViews";
import { APR_MIN_TICKETS, coveredFrom, fmtApr, type TicketLog } from "../../lib/ticketLog";
import { useVaultApr } from "../../lib/hooks";
import { withOlderCloses } from "../../lib/vaultActivity";
import { needsOwnApr } from "../../lib/vaultApr";
import {
  CHART_SERIES as SERIES,
  aprChartView,
  bucketFor,
  chartView,
  type ChartRange,
  type ChartSeries,
  volumeChartView,
  windowWords,
  withAprHeadline,
} from "../../lib/vaultFigures";
import type { AprEstimate } from "../../lib/apr";
import type { VaultData } from "./common";

const RANGES: ChartRange[] = ["1D", "7D", "1M", "ALL"];

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const two = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const HOUR = 3600;
const bucketWord = (b: number) =>
  b === 900 ? "15 minutes" : b === HOUR ? "hour" : b === 6 * HOUR ? "6 hours" : "day";

/** The period a volume view's points total: the gap between two of them, or its whole span. */
const volumeBucket = (view: { points: readonly { t: number }[]; from: number; to: number }) => {
  const [a, b] = view.points;
  return a && b ? b.t - a.t : bucketFor(view.to - view.from);
};

/** An APR axis label: the decimals follow the size, as `fmtApr` writes the figure. */
const aprAxis = (v: number) => {
  const size = Math.abs(v);
  return `${size >= 10 || size === 0 ? whole.format(v) : v.toFixed(size >= 1 ? 1 : 2)}%`;
};

export function VaultChart({
  data,
  keeper,
  tickets,
  apr,
}: {
  data: VaultData;
  /** The keeper's vault history, null until it answers or when it cannot be reached. */
  keeper: KeeperVault | null;
  /** The program's tickets the app read itself, only when the keeper cannot serve them. */
  tickets: TicketLog | null;
  /** The headline APR (pages/vault/Apr.tsx): the app's own chart ends on it. */
  apr: AprEstimate | null;
}) {
  const [series, setSeries] = useState<ChartSeries>(SERIES[0]!.id);
  const [range, setRange] = useState<ChartRange>("7D");
  // the window ends now; re-read once a minute is plenty for a chart
  const now = Math.floor(Date.now() / 60_000) * 60;

  // the closes: the keeper's, the app's own from the vault's history when it cannot serve them
  const ownStrikes = useMemo(
    () => (data.log ? strikeSeries(data.log.items, data.state.vault, now) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.log, data.state.vault],
  );
  const strikeSource = chooseView(keeper, ownStrikes, (k) => k.seriesSyncing);
  const keeperStrikes = strikeSource && "keeper" in strikeSource ? strikeSource.keeper : null;
  const strikes = useMemo(() => {
    if (!keeperStrikes) return ownStrikes;
    // ALL reaches back past the keeper's 30 days: the history's own older closes first
    return withOlderCloses(keeperStrikes.strikes, ownStrikes, livePoint(data.state.vault, now));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keeperStrikes, ownStrikes, data.state.vault]);
  // the ticket volume: the keeper's hourly sums, the app's own tickets when it cannot serve them
  const volumeSource = chooseView(keeper, tickets, (k) => k.seriesSyncing);
  const keeperVolume = volumeSource && "keeper" in volumeSource ? volumeSource.keeper : null;

  // the headline APR's inputs: today's total assets and protocol share
  const totalAssets = data.state.vault.totalAssets;
  const protocolShareBps = data.state.config.params.protocolShareBps;
  const keeperApr = useVaultApr();
  const own = needsOwnApr(keeperApr.data, keeperApr.error !== null);
  const view = useMemo(() => {
    const fromKeeper = () => (keeperApr.data ? aprChartView(range, keeperApr.data.series) : null);
    if (series === "apr" && !own) return fromKeeper();
    if (series === "volume" && keeperVolume)
      return volumeChartView(range, keeperVolume.volume, now);
    const v = chartView(series, range, strikes, tickets, now, { totalAssets, protocolShareBps });
    if (series !== "apr") return v;
    // the keeper's partial series while the app has nothing of its own to chart; the app's own
    // ends on the headline, which scales a read capped inside the 7 days the chart leaves blank
    return v ? withAprHeadline(v, apr?.pct ?? null) : fromKeeper();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    series,
    range,
    strikes,
    tickets,
    totalAssets,
    protocolShareBps,
    keeperApr.data,
    own,
    apr,
    keeperVolume,
  ]);

  const fmt = (v: number) =>
    series === "price"
      ? `${v.toFixed(6)} USDC`
      : series === "apr"
        ? fmtApr(v)
        : `${two.format(v)} USDC`;
  // a price label rolling toward deposits passes through thousands: whole numbers there
  const axis = (v: number) =>
    series === "apr"
      ? aprAxis(v)
      : series === "price" && Math.abs(v) < 100
        ? v.toFixed(4)
        : whole.format(v);
  const headline = (v: number | null) =>
    v === null
      ? "–"
      : series === "price"
        ? v.toFixed(6)
        : series === "volume"
          ? two.format(v)
          : series === "apr"
            ? fmtApr(v)
            : usdc(BigInt(Math.round(v * 1e6)));
  const change = (v: number) => signedPct(v, series === "price" ? 3 : 1, "%");
  // The APR is a rate already: its move over the range says nothing a visitor reads at a
  // glance, so its header shows the figure alone.
  const showsChange = series !== "apr";
  const fromTickets = series === "volume" || series === "apr";
  const loading = fromTickets ? !view : !strikes && !data.logError;
  // the history did not load and the keeper could not serve the closes either
  const historyFailed = data.logError && !strikes;

  return (
    <section className="vchart" aria-label="Vault chart">
      <div className="vchart-head">
        <div className="pills" role="group" aria-label="Series">
          {SERIES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`pill${series === s.id ? " on" : ""}`}
              aria-pressed={series === s.id}
              onClick={() => setSeries(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="ranges" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className={`range${range === r ? " on" : ""}`}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="vchart-figure">
        {view ? (
          <>
            <span className="vchart-value mono">
              <Tween key={series}>{headline(view.headline)}</Tween>
            </span>
            <span className="unit">{view.unit}</span>
            {showsChange && view.change !== null && (
              <span className={`mono small ${view.change >= 0 ? "up" : "down"}`}>
                <Tween>{change(view.change)}</Tween>
              </span>
            )}
            <InfoTip label="About this chart" docs>
              {series === "price"
                ? "USDC per fvUSDC after each close, read from its on-chain record, then today's price. It moves with every payout the vault takes or pays; any period can end up or down."
                : series === "deposits"
                  ? "The vault's assets after each close, deposits and results included, then today's."
                  : series === "apr"
                    ? `At each point, the vault margin earned on the tickets opened in the 7 days before it, annualised over the vault's assets at that time: past activity, not a forecast. Left blank only where a whole week held fewer than ${APR_MIN_TICKETS} tickets.`
                    : `Ticket prices opened against the vault, per ${bucketWord(volumeBucket(view))}${
                        tickets && !keeperVolume
                          ? `, over the last ${windowWords(now - coveredFrom(tickets))} of the program's transactions.`
                          : "."
                      }`}
            </InfoTip>
          </>
        ) : (
          <Skeleton w={180} h={30} />
        )}
      </div>
      {loading && <Skeleton h={240} />}
      {historyFailed && !fromTickets && (
        <p className="error small">The vault's history did not load: {data.logError}</p>
      )}
      {view && (
        <FluidChart
          points={view.points}
          from={view.from}
          to={view.to}
          format={fmt}
          axisFormat={axis}
          zeroBased={fromTickets}
          step={series === "volume"}
          label={SERIES.find((s) => s.id === series)!.label}
        />
      )}
    </section>
  );
}
