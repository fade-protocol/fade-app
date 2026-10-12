// The vault's main chart: the share price, the deposits (the vault's assets) or the ticket
// volume, over a day, a week, a month or everything read. Switching morphs the line.
import { useMemo, useState } from "react";
import { InfoTip } from "../../components/disclosure";
import { FluidChart } from "../../components/FluidChart";
import { Tween } from "../../components/motion";
import { Skeleton } from "../../components/ui";
import { signedPct, usdc } from "../../lib/format";
import { strikeSeries } from "../../lib/history";
import { PROGRAM_WINDOW_S, type TicketLog } from "../../lib/ticketLog";
import { bucketFor, chartView, type ChartRange, type ChartSeries } from "../../lib/vaultFigures";
import type { VaultData } from "./common";

const SERIES: { id: ChartSeries; label: string }[] = [
  { id: "price", label: "Share price" },
  { id: "deposits", label: "Deposits" },
  { id: "volume", label: "Ticket volume" },
];
const RANGES: ChartRange[] = ["1D", "7D", "1M", "ALL"];

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const two = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const HOUR = 3600;
const bucketWord = (b: number) =>
  b === 900 ? "15 minutes" : b === HOUR ? "hour" : b === 6 * HOUR ? "6 hours" : "day";

export function VaultChart({ data, tickets }: { data: VaultData; tickets: TicketLog | null }) {
  const [series, setSeries] = useState<ChartSeries>("price");
  const [range, setRange] = useState<ChartRange>("7D");
  // the window ends now; re-read once a minute is plenty for a chart
  const now = Math.floor(Date.now() / 60_000) * 60;

  const strikes = useMemo(
    () => (data.log ? strikeSeries(data.log.items, data.state.vault, now) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.log, data.state.vault],
  );

  const view = useMemo(
    () => chartView(series, range, strikes, tickets, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, range, strikes, tickets],
  );

  const fmt = (v: number) =>
    series === "price" ? `${v.toFixed(6)} USDC` : `${two.format(v)} USDC`;
  // a price label rolling toward deposits passes through thousands: whole numbers there
  const axis = (v: number) =>
    series === "price" && Math.abs(v) < 100 ? v.toFixed(4) : whole.format(v);
  const loading = series === "volume" ? !tickets : !strikes && !data.logError;

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
              <Tween key={series}>
                {series === "price"
                  ? view.headline.toFixed(6)
                  : series === "volume"
                    ? two.format(view.headline)
                    : usdc(BigInt(Math.round(view.headline * 1e6)))}
              </Tween>
            </span>
            <span className="unit">{view.unit}</span>
            {view.change !== null && (
              <span className={`mono small ${view.change >= 0 ? "up" : "down"}`}>
                <Tween>{signedPct(view.change, series === "price" ? 3 : 1, "%")}</Tween>
              </span>
            )}
            <InfoTip label="About this chart" docs>
              {series === "price"
                ? "USDC per fvUSDC after each close, read from its on-chain record, then today's price. It moves with every payout the vault takes or pays; any period can end up or down."
                : series === "deposits"
                  ? "The vault's assets after each close, deposits and results included, then today's."
                  : `Ticket prices opened against the vault, per ${bucketWord(bucketFor(view.to - view.from))}. Read from the program's last ${PROGRAM_WINDOW_S / 86400} days of transactions.`}
            </InfoTip>
          </>
        ) : (
          <Skeleton w={180} h={30} />
        )}
      </div>
      {loading && <Skeleton h={240} />}
      {data.logError && series !== "volume" && !strikes && (
        <p className="error small">The vault's history did not load: {data.logError}</p>
      )}
      {view && (
        <FluidChart
          points={view.points}
          from={view.from}
          to={view.to}
          format={fmt}
          axisFormat={axis}
          zeroBased={series === "volume"}
          step={series === "volume"}
          label={SERIES.find((s) => s.id === series)!.label}
        />
      )}
    </section>
  );
}
