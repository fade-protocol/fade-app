// The checkout's chance picker: three presets by odds ("1 in 100"), each with the ticket price
// it takes and its share of the order, and a custom picker with two settings: what a win sends
// back (the whole order, half of it, a tenth of it), then the chance, on a log-scale slider
// priced for that win. The odds shown are the ones the snapped ticket really gets, never better.
import { useId, type CSSProperties, type ReactNode } from "react";
import { InfoTip } from "../components/disclosure";
import { usdc } from "../lib/format";
import type { ChanceTerms } from "../lib/chances";
import type { CheckoutBack } from "../lib/payoutTables";

export type ChancePreset = {
  /** N in the "1 in N" the preset aims at. */
  n: number;
  terms: ChanceTerms;
  /** The program would refuse this ticket right now. */
  refused: boolean;
  popular?: boolean;
};

/** One choice of what a win sends back. */
export type BackChoice = {
  back: CheckoutBack;
  label: string;
  /** What that part of the order comes to, in micro-USDC. */
  amount: bigint;
  /** No chance for it is open right now: the program would refuse every ticket. */
  refused: boolean;
};

/** The marks under the custom slider, as N in "1 in N". */
const TICKS = [20, 50, 100, 300, 1000];

export function ChancePicker({
  presets,
  selected,
  onPreset,
  custom,
  customOpen,
  customValue,
  onCustom,
  onOpenCustom,
  onCloseCustom,
  backs,
  back,
  onBack,
  disabled,
  info,
}: {
  presets: ChancePreset[];
  /** The preset in use, or null while the custom picker is. */
  selected: number | null;
  onPreset: (n: number) => void;
  /** The custom picker's stops, from the best odds (the dearest ticket) to the rarest. */
  custom: ChanceTerms[];
  customOpen: boolean;
  customValue: bigint;
  onCustom: (ticket: bigint) => void;
  onOpenCustom: () => void;
  onCloseCustom: () => void;
  /** The custom picker's first setting: what a win sends back. */
  backs: BackChoice[];
  back: CheckoutBack;
  onBack: (back: CheckoutBack) => void;
  disabled?: boolean;
  info?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={`chance${disabled ? " is-locked" : ""}`}>
      <div className="chance-head">
        <span className="label-tip">
          <span className="swap-label" id={`${id}-label`}>
            Pick your chance
          </span>
          {info && <InfoTip label="How it works">{info}</InfoTip>}
        </span>
        {!customOpen && custom.length > 1 && (
          <button type="button" className="link-btn small" onClick={onOpenCustom}>
            Custom
          </button>
        )}
      </div>
      <div className="chance-presets" role="group" aria-labelledby={`${id}-label`}>
        {presets.map((p) => {
          const on = !customOpen && selected === p.n;
          return (
            <button
              key={p.n}
              type="button"
              className={`chance-preset${on ? " on" : ""}`}
              disabled={disabled || p.refused}
              aria-pressed={on}
              title={p.refused ? "The vault cannot carry this payout yet" : undefined}
              onClick={() => onPreset(p.n)}
            >
              {p.popular && <span className="chance-tag">POPULAR</span>}
              <span className="chance-odds">{p.terms.oneIn}</span>
              <span className="chance-price mono">+{usdc(p.terms.price)} USDC</span>
              <span className="chance-share">{p.terms.share} of the order</span>
            </button>
          );
        })}
      </div>
      {customOpen && (
        <CustomChance
          stops={custom}
          value={customValue}
          onChange={onCustom}
          onClose={onCloseCustom}
          backs={backs}
          back={back}
          onBack={onBack}
          disabled={disabled ?? false}
        />
      )}
    </div>
  );
}

function CustomChance({
  stops,
  value,
  onChange,
  onClose,
  backs,
  back,
  onBack,
  disabled,
}: {
  stops: ChanceTerms[];
  value: bigint;
  onChange: (ticket: bigint) => void;
  onClose: () => void;
  backs: BackChoice[];
  back: CheckoutBack;
  onBack: (back: CheckoutBack) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const index = Math.max(
    0,
    stops.findIndex((s) => s.price === value),
  );
  const current = stops[index];
  const first = stops[0];
  const lastStop = stops[stops.length - 1];
  const last = stops.length - 1;
  if (!current || !first || !lastStop) return null;
  const fill = last > 0 ? (index / last) * 100 : 0;
  // each mark sits on the stop whose odds are closest to it on the log scale
  // (a mark within 5% past the range's ends reads as its end: cents rarely land on 1 in 1,000)
  const ticks = TICKS.filter((n) => n * 1.05 >= first.oneInN && n <= lastStop.oneInN * 1.05).map(
    (n) => {
      let best = 0;
      stops.forEach((s, i) => {
        const d = Math.abs(Math.log(s.oneInN / n));
        if (d < Math.abs(Math.log((stops[best]?.oneInN ?? n) / n))) best = i;
      });
      return { n, at: last > 0 ? best / last : 0 };
    },
  );
  return (
    <div className="chance-custom rise">
      <div className="chance-custom-head">
        <span className="chance-custom-title">Custom</span>
        <button type="button" className="link-btn small" onClick={onClose}>
          Back to presets
        </button>
      </div>
      <div className="chance-step">
        <span className="chance-step-label" id={`${id}-back`}>
          1. What comes back
        </span>
        <div className="chance-backs" role="group" aria-labelledby={`${id}-back`}>
          {backs.map((b) => {
            const on = b.back === back;
            return (
              <button
                key={b.back}
                type="button"
                className={`chance-back${on ? " on" : ""}`}
                aria-pressed={on}
                disabled={disabled || (b.refused && !on)}
                title={b.refused ? "The vault cannot carry this payout yet" : undefined}
                onClick={() => onBack(b.back)}
              >
                <span className="chance-back-label">{b.label}</span>
                <span className="chance-back-amount mono">{usdc(b.amount)} USDC</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="chance-step">
        <label htmlFor={id} className="chance-step-label">
          2. Your chance
        </label>
        <p className="chance-readout" aria-hidden="true">
          <span className="chance-readout-odds">{current.oneIn}</span>
          <span className="chance-readout-price mono">+{usdc(current.price)} USDC</span>
          <span className="chance-readout-share">{current.share} of the order</span>
        </p>
        <input
          id={id}
          type="range"
          className="ticket-range chance-range"
          min={0}
          max={Math.max(0, last)}
          step={1}
          value={index}
          disabled={disabled || stops.length < 2}
          aria-valuetext={`${current.oneIn}, ${usdc(current.price)} USDC ticket, ${current.share} of the order`}
          style={{ "--fill": `${fill}%` } as CSSProperties}
          onChange={(e) => {
            const s = stops[Number(e.target.value)];
            if (s) onChange(s.price);
          }}
        />
        <div className="chance-ticks mono" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t.n} data-n={t.n} style={{ "--at": t.at } as CSSProperties}>
              1 in {t.n.toLocaleString("en-US")}
            </span>
          ))}
        </div>
      </div>
      <p className="small muted chance-custom-note">
        A smaller win comes more often for the same price. Better odds cost more. Arrow keys move
        one step.
      </p>
    </div>
  );
}
