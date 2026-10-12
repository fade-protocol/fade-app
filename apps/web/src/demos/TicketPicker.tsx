// The ticket slider shared by the demos: the user picks how much to put on the
// draw, from the live minimum price up to what the vault and a sensible chance
// allow. Steps are tidy amounts on a log-ish scale, so cents and tens of USDC
// are both one drag away, and the keyboard moves one step at a time.
import { useId, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { InfoTip } from "../components/disclosure";
import { Indicator, Tween, useSlidingIndicator } from "../components/motion";
import { usdc } from "../lib/format";
import { DEMO_APP_SHARE_BPS, DEMO_MARGIN_BPS, winBackPayoutTable } from "../lib/payoutTables";
import { MAX_WIN_BACK_P, snapTicket, ticketForChance, ticketSteps } from "../lib/tickets";
import type { Live } from "./common";
import { predict } from "./useTicketFlow";

/**
 * Tickets for an all-or-nothing win-back of `prize`: from the live minimum price
 * up to the ticket that makes the win-back a 1 in 2 chance (or the live maximum
 * price), keeping only those the program would accept against the vault as read.
 */
export function useWinBackTickets(state: Live, prize: bigint) {
  return useMemo(() => {
    const { minPrice, maxPrice } = state.config.params;
    if (prize <= 0n) return { steps: [] as bigint[], limitedBy: null, accepts: () => false };
    const atChance = ticketForChance(prize, DEMO_MARGIN_BPS, MAX_WIN_BACK_P, (t) =>
      winBackPayoutTable(t, prize),
    );
    const max = atChance < maxPrice ? atChance : maxPrice;
    const ok = (t: bigint) => {
      const b = winBackPayoutTable(t, prize);
      return (
        (b[0]?.p ?? 0n) <= MAX_WIN_BACK_P &&
        predict(state, b, t, DEMO_APP_SHARE_BPS).refusal === null
      );
    };
    return {
      steps: ticketSteps(minPrice, max, ok),
      /** Whether the program would take a ticket of this price for the win-back, as read. */
      accepts: (t: bigint) => t >= minPrice && t <= max && ok(t),
      limitedBy: atChance < maxPrice ? ("chance" as const) : ("maxPrice" as const),
    };
  }, [state, prize]);
}

export type Preset = { label: string; value: bigint; showAmount?: boolean };

export function TicketPicker({
  steps,
  value,
  onChange,
  disabled,
  describe,
  presets,
  label = "Ticket price",
  info,
}: {
  steps: readonly bigint[];
  value: bigint;
  onChange: (ticket: bigint) => void;
  disabled?: boolean;
  /** What a ticket buys, for screen readers: read out as the slider moves. */
  describe: (ticket: bigint) => string;
  presets: Preset[];
  label?: string;
  /** What the ticket returns on average, its bounds: behind an (i) by the label. */
  info?: ReactNode;
}) {
  const id = useId();
  const current = snapTicket(steps, value);
  const index = Math.max(0, steps.indexOf(current));
  const last = steps.length - 1;
  const fill = last > 0 ? (index / last) * 100 : 100;
  const first = steps[0];
  const top = steps[last];
  const presetRow = useRef<HTMLDivElement>(null);
  useSlidingIndicator(presetRow, current);
  return (
    <div className={`ticket${disabled ? " is-locked" : ""}`}>
      <div className="ticket-head">
        <span className="label-tip">
          <label htmlFor={id} className="swap-label">
            {label}
          </label>
          {info && <InfoTip label="About the ticket">{info}</InfoTip>}
        </span>
        <span className="ticket-amount">
          <span className="mono">
            <Tween ms={200}>{usdc(current)}</Tween>
          </span>
          <span className="odds-unit">USDC</span>
        </span>
      </div>
      <input
        id={id}
        type="range"
        className="ticket-range"
        min={0}
        max={Math.max(0, last)}
        step={1}
        value={index}
        disabled={disabled || steps.length < 2}
        aria-valuetext={describe(current)}
        style={{ "--fill": `${fill}%` } as CSSProperties}
        onChange={(e) => {
          const t = steps[Number(e.target.value)];
          if (t !== undefined) onChange(t);
        }}
      />
      {first !== undefined && top !== undefined && (
        <div className="ticket-scale mono" aria-hidden="true">
          <span>{usdc(first)}</span>
          <span>{usdc(top)}</span>
        </div>
      )}
      {presets.length > 0 && (
        <div
          className="presets ticket-presets has-ind"
          role="group"
          aria-label="Quick picks"
          ref={presetRow}
        >
          <Indicator />
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              className={`preset${current === p.value ? " on" : ""}`}
              disabled={disabled}
              aria-pressed={current === p.value}
              onClick={() => onChange(p.value)}
            >
              {p.label}
              {p.showAmount && <span className="preset-amount"> {usdc(p.value)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export { odds } from "../lib/format";
