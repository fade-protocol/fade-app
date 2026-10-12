import { Tween } from "../components/motion";

/** The terms of a payout at a glance: what it costs, how likely, what it pays. */
export function Odds({
  items,
}: {
  items: { label: string; value: string; unit?: string; sub?: string; accent?: boolean }[];
}) {
  return (
    <dl className="odds">
      {items.map((i) => (
        <div key={i.label} className={`odds-item${i.accent ? " odds-accent" : ""}`}>
          <dt>{i.label}</dt>
          <dd>
            <span className="mono odds-value">
              <Tween>{i.value}</Tween>
            </span>
            {i.unit && <span className="odds-unit">{i.unit}</span>}
            {i.sub && (
              <span className="odds-sub mono">
                <Tween>{i.sub}</Tween>
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
