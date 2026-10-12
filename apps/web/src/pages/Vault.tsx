// The vault: its name and token, five figures, then Overview / Performance / Risk / Activity on
// the left, and Deposit / Withdraw with the owner's position on the right.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { InfoTip } from "../components/disclosure";
import { AnimatedHeight, Tween, enterStyle, useDirection } from "../components/motion";
import { Popover } from "../components/scroll";
import { ExplorerAddress, NotInitialized, Skeleton } from "../components/ui";
import { PROGRAM } from "../lib/config";
import { bps, usdc } from "../lib/format";
import { livePrice } from "../lib/history";
import { useProgramTickets, useProtocol } from "../lib/hooks";
import { AprFigure, useApr } from "./vault/Apr";
import { providerOwners } from "../lib/position";
import type { AprEstimate } from "../lib/ticketLog";
import { availableNow, utilisationBps } from "../lib/vaultFigures";
import { replaceHash, useHash } from "../router";
import { ActionCard } from "./vault/ActionCard";
import { ActivityPanel } from "./vault/Activity";
import { WhereVaultEarns } from "./vault/Apps";
import type { Live, VaultData } from "./vault/common";
import { Governance, HealthStrip } from "./vault/Health";
import { CapCard, EpochRing, HowItWorks, PerClose, UtilisationGauge } from "./vault/Overview";
import { OpenRequests, PositionCard } from "./vault/Position";
import { ProvidersPanel } from "./vault/Providers";
import { useVaultData } from "./vault/useVaultData";
import { VaultChart } from "./vault/VaultChart";

type Tab = "overview" | "performance" | "risk" | "activity";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "performance", label: "Performance" },
  { id: "risk", label: "Risk" },
  { id: "activity", label: "Activity" },
];

/** Older links: the position moved to the side panel, the providers to Risk. */
const LEGACY: Record<string, Tab> = { position: "overview", providers: "risk" };
const tabOf = (hash: string): Tab =>
  TABS.some((t) => t.id === hash) ? (hash as Tab) : (LEGACY[hash] ?? "overview");

function Metrics({ data, apr }: { data: VaultData; apr: AprEstimate | null }) {
  const { vault } = data.state;
  const price = livePrice(vault);
  const available = availableNow(data.state);
  const util = utilisationBps(vault);
  const providers =
    data.holders && data.requests
      ? providerOwners(data.holders, data.requests.deposits, data.requests.withdraws).size
      : null;
  return (
    <dl className="metrics">
      <div className="metric">
        <dt>Total deposits</dt>
        <dd>
          <Tween>{usdc(vault.totalAssets, 0)}</Tween>
          <span className="unit"> USDC</span>
        </dd>
      </div>
      <div className="metric">
        <dt className="label-tip">
          Available now
          <InfoTip label="About available now" docs>
            What withdrawals can take at the next close while open payouts keep their reserve.{" "}
            {bps(util)} of the vault is committed to open payouts.
          </InfoTip>
        </dt>
        <dd>
          <Tween>{usdc(available, 0)}</Tween>
        </dd>
      </div>
      <div className="metric">
        <dt>Est. APR</dt>
        <dd>
          <AprFigure apr={apr} />
        </dd>
      </div>
      <div className="metric">
        <dt className="label-tip">
          Share price
          <InfoTip label="About the share price" docs>
            USDC per fvUSDC on the last settled figures. Deposits and withdrawals are priced at the
            next close.
          </InfoTip>
        </dt>
        <dd>{price === null ? "–" : <Tween>{usdc(price, 4)}</Tween>}</dd>
      </div>
      <div className="metric">
        <dt>Liquidity providers</dt>
        <dd>{providers === null ? <Skeleton w={30} h={24} inline /> : providers.toString()}</dd>
      </div>
    </dl>
  );
}

function VaultHeader({ state }: { state: Live | null }) {
  return (
    <header className="vhead">
      <span className="token-chip" aria-hidden="true">
        fv
      </span>
      <div>
        <h1>Fade USDC Vault</h1>
        <p className="muted label-tip">
          Backs every payout on Fade. No lockup, shares in fvUSDC.
          {state && (
            <InfoTip label="How the vault works" docs>
              Deposit USDC to receive fvUSDC, redeem fvUSDC for USDC. Requests are priced together
              every {Math.round(Number(state.config.params.epochLengthSeconds) / 60)} minutes, the
              same price for everyone. The vault takes the other side of every payout: it earns its
              margin on average, and any single period can end up or down.
            </InfoTip>
          )}
        </p>
      </div>
    </header>
  );
}

function Vault({ state, refreshKey, bump }: { state: Live; refreshKey: number; bump: () => void }) {
  const data = useVaultData(state, refreshKey, bump);
  const tickets = useProgramTickets();
  const apr = useApr(state);
  const tab = tabOf(useHash());
  const setTab = (t: Tab) => replaceHash(t === "overview" ? "" : t);
  const [side, setSide] = useState<"deposit" | "withdraw">(() =>
    new URLSearchParams(window.location.search).get("action") === "withdraw"
      ? "withdraw"
      : "deposit",
  );
  // the dashboard's Deposit / Withdraw links: focus the amount, then drop the parameter
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.has("action")) return;
    q.delete("action");
    const rest = q.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`,
    );
    requestAnimationFrame(() => document.getElementById("action-amount")?.focus());
  }, []);
  const tabRow = useRef<HTMLDivElement>(null);
  const dir = useDirection(TABS.findIndex((t) => t.id === tab));
  const onTabKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + TABS.length) % TABS.length;
    setTab(TABS[j]!.id);
    tabRow.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[j]?.focus();
  };

  return (
    <div className="vgrid">
      <section className="vmain">
        <VaultHeader state={state} />
        <Metrics data={data} apr={apr} />
        <div className="utabs-row">
          <div className="utabs" role="tablist" aria-label="Vault sections" ref={tabRow}>
            {TABS.map((t, i) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                className="utab"
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => onTabKey(e, i)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <Popover label="How it works" title="How the vault works">
            <HowItWorks state={state} />
          </Popover>
        </div>
        <AnimatedHeight className="vstage">
          <section
            id={`panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
            className="panel enter vpanel"
            style={enterStyle(dir)}
            key={tab}
          >
            {tab === "overview" && (
              <>
                <VaultChart data={data} tickets={tickets.data} />
                <WhereVaultEarns state={state} tickets={tickets.data} owner={data.owner} />
              </>
            )}
            {tab === "performance" && <PerClose data={data} />}
            {tab === "risk" && (
              <>
                <HealthStrip state={state} />
                <div className="viz-strip">
                  <UtilisationGauge state={state} />
                  <EpochRing data={data} />
                  <CapCard state={state} />
                </div>
                <Governance state={state} />
                <ProvidersPanel data={data} />
                <p className="small muted">
                  Program <ExplorerAddress address={PROGRAM} />
                </p>
              </>
            )}
            {tab === "activity" && <ActivityPanel data={data} tickets={tickets.data} />}
          </section>
        </AnimatedHeight>
      </section>
      <aside className="vside" aria-label="Deposit or withdraw">
        <ActionCard data={data} side={side} onSide={setSide} aprPct={apr?.pct ?? null} />
        <PositionCard data={data} />
        <OpenRequests data={data} />
      </aside>
    </div>
  );
}

export function VaultPage() {
  const protocol = useProtocol();
  const [refreshKey, setRefreshKey] = useState(0);
  const state = protocol.data;
  const bump = () => {
    setRefreshKey((k) => k + 1);
    protocol.refresh();
  };

  return (
    <div className="container page vpage">
      {state && state.initialized ? (
        <Vault state={state} refreshKey={refreshKey} bump={bump} />
      ) : (
        <>
          <VaultHeader state={null} />
          {protocol.loading && !state && (
            <div className="metrics" aria-busy="true">
              {Array.from({ length: 5 }, (_, i) => (
                <div className="metric" key={i}>
                  <Skeleton h={12} w={80} />
                  <Skeleton h={26} w={110} />
                </div>
              ))}
            </div>
          )}
          {protocol.error && !state && (
            <p className="error">
              The network did not answer ({protocol.error}). This page tries again every 10 seconds.
            </p>
          )}
          {state && !state.initialized && <NotInitialized />}
        </>
      )}
    </div>
  );
}
