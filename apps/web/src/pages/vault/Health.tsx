// The vault's health at a glance, and the governance changes on their way: what a liquidity
// provider checks before depositing. Everything is read from the chain (Config and Vault).
import type { ReactNode } from "react";
import { InfoTip } from "../../components/disclosure";
import { Chip, type ChipTone } from "../../components/ui";
import { bps, usdc } from "../../lib/format";
import { useChainNow } from "../../lib/hooks";
import { PARAM_WORDS, formatParam as fmt } from "../../lib/paramWords";
import { availableNow, drawdownOf, isHalved } from "../../lib/vaultFigures";
import { about, type Live } from "./common";

const PAUSE_TICKETS = 1;
const PAUSE_DEPOSITS = 1 << 1;

function Item({
  label,
  chip,
  tone,
  sub,
  info,
}: {
  label: string;
  chip: string;
  tone: ChipTone;
  sub?: string | undefined;
  info?: ReactNode;
}) {
  return (
    <div className="health-item">
      <span className="stat-label label-tip">
        {label}
        {info && (
          <InfoTip label={`About ${label.toLowerCase()}`} docs>
            {info}
          </InfoTip>
        )}
      </span>
      <Chip tone={tone}>{chip}</Chip>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}

export function HealthStrip({ state }: { state: Live }) {
  const now = useChainNow(state);
  const { vault, config } = state;
  const flags = config.pauseFlags;
  const dd = drawdownOf(state, now);
  const halved = isHalved(state);
  // what a strike could pay out now: the vault, with the live epoch's deposits
  const out = availableNow(state);
  const until = Number(vault.drawdownTripTs) + 48 * 3600;
  return (
    <div className="card health" aria-label="Vault health">
      <Item
        label="Deposits"
        chip={flags & PAUSE_DEPOSITS ? "Paused" : "Open"}
        tone={flags & PAUSE_DEPOSITS ? "warn" : "won"}
        sub="Withdrawals are never paused."
      />
      <Item
        label="New payouts"
        chip={flags & PAUSE_TICKETS ? "Paused" : dd.tripped ? "Breaker tripped" : "Open"}
        tone={flags & PAUSE_TICKETS || dd.tripped ? "warn" : "won"}
        sub={halved ? `Caps halved, ${about(until - now)} left` : undefined}
      />
      <Item
        label="Drawdown, 24 h"
        chip={bps(dd.fallBps)}
        tone={dd.tripped ? "warn" : dd.fallBps * 2n >= dd.limit ? "info" : "neutral"}
        sub={`The breaker trips at ${bps(dd.limit, 0)}.`}
      />
      <Item
        label="Withdrawable now"
        chip={`${usdc(out)} USDC`}
        tone="neutral"
        info="What the next close can pay out while open payouts keep their reserve."
      />
    </div>
  );
}

const WORDS: Record<string, string> = PARAM_WORDS;

/** Changes the council has proposed, applied by anyone once their timelock ends. */
export function Governance({ state }: { state: Live }) {
  const now = useChainNow(state);
  const { config } = state;
  const p = config.pending;
  if (!p.active) return null;
  const cur = config.params as unknown as Record<string, unknown>;
  const next = p.params as unknown as Record<string, unknown>;
  const changes = Object.keys(WORDS).filter((k) => next[k] !== cur[k]);
  const treasury = p.protocolTreasury !== config.protocolTreasury;
  const left = Number(p.effectiveAt) - now;
  return (
    <div className="card governance">
      <div className="viz-head">
        <h3>Pending changes</h3>
        <span className="small muted">
          {left > 0 ? `apply in ${about(left)}` : "due: anyone can apply them"}
        </span>
      </div>
      <dl className="kv small">
        {changes.map((k) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{WORDS[k]}</dt>
            <dd className="mono">
              {fmt(k, cur[k])} to {fmt(k, next[k])}
            </dd>
          </div>
        ))}
        {treasury && (
          <>
            <dt>Protocol treasury</dt>
            <dd className="mono">changes</dd>
          </>
        )}
        {changes.length === 0 && !treasury && (
          <>
            <dt>Parameters</dt>
            <dd>no visible change</dd>
          </>
        )}
      </dl>
      <p className="small muted">
        Loosening a limit waits 24 h, lowering the vault margin floor or raising the protocol share
        7 days: providers can leave before it applies.
      </p>
    </div>
  );
}
