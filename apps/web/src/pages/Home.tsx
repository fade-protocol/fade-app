// Home: the three demos as thumbnail tabs, the live stage under them, the wallet's last tickets,
// and on the right the wallet, the live draws and a way into the vault. The hash names the tab
// (/#checkout, /#swap, /#booster) and never scrolls; any other hash lands on the first one.
import type { Address } from "@solana/kit";
import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { DevSimPanel } from "../demos/devSimulation";
import {
  AnimatedHeight,
  Tween,
  enterStyle,
  useDirection,
  useFreshKeys,
} from "../components/motion";
import { FaucetButton, readNext } from "../components/FaucetButton";
import { preloadPack3d } from "../components/Pack3D";
import { preloadReceipt3d } from "../components/Receipt3D";
import { NotInitialized, Skeleton } from "../components/ui";
import { CheckoutDemo } from "../demos/CheckoutDemo";
import { useWalletFunds, type Live, type WalletFunds } from "../demos/common";
import { BoosterDemo } from "../demos/BoosterDemo";
import { SwapDemo } from "../demos/SwapDemo";
import { ago, clock, sol, usdc } from "../lib/format";
import { useNow, useProgramTickets, useProtocol, useStats, useWalletTickets } from "../lib/hooks";
import type { Stats } from "../lib/stats";
import { fmtApr, kindOf, type TicketKind, type TicketLog } from "../lib/ticketLog";
import { NOT_THIS_TIME, winWords } from "../lib/ticketWords";
import { Link, replaceHash, useHash } from "../router";
import { ConnectButton } from "../wallet/ConnectButton";
import { useWallet } from "../wallet/WalletProvider";
import { useApr } from "./vault/Apr";
import { useOwner } from "./vault/useVaultData";

type Tab = "checkout" | "swap" | "booster";

const TABS: { id: Tab; title: string; sub: string }[] = [
  { id: "checkout", title: "Checkout", sub: "The receipt prints" },
  { id: "swap", title: "Swap", sub: "In the wallet" },
  { id: "booster", title: "Booster", sub: "Pack, maybe a premium" },
];

const tabOf = (hash: string): Tab => (TABS.some((t) => t.id === hash) ? (hash as Tab) : "checkout");

/** Small drawings of each demo's scene, for the tabs: the scenes themselves stay live below. */
const THUMBS: Record<Tab, ReactNode> = {
  checkout: (
    <svg viewBox="0 0 64 48" aria-hidden="true">
      <rect width="64" height="48" fill="#1d1733" />
      <rect x="10" y="30" width="44" height="14" rx="3" fill="#3a2d78" />
      <rect x="10" y="30" width="44" height="3" fill="#7c5cff" />
      <path d="M20 4h24v28H20z" fill="#f0eee8" />
      <path d="M23 9h12M23 13h16M23 17h10" stroke="#4d4859" strokeWidth="1.6" />
      <rect
        x="23"
        y="21"
        width="18"
        height="7"
        rx="1"
        fill="none"
        stroke="#6fe3b4"
        strokeWidth="1.6"
      />
      <path d="M26 24.5h12" stroke="#6fe3b4" strokeWidth="1.6" />
    </svg>
  ),
  swap: (
    <svg viewBox="0 0 64 48" aria-hidden="true">
      <rect width="64" height="48" fill="#161226" />
      <rect
        x="18"
        y="4"
        width="28"
        height="40"
        rx="5"
        fill="#252036"
        stroke="#7c5cff"
        strokeWidth="1.4"
      />
      <rect x="22" y="10" width="20" height="9" rx="2" fill="#1c1829" />
      <rect x="22" y="27" width="20" height="9" rx="2" fill="#1c1829" />
      <path d="M32 20v6m-2.5-2.5L32 26l2.5-2.5" stroke="#c4b6ff" strokeWidth="1.5" fill="none" />
      <circle cx="26" cy="14.5" r="2.2" fill="#9b84ff" />
      <circle cx="26" cy="31.5" r="2.2" fill="#6fe3b4" />
    </svg>
  ),
  booster: (
    <svg viewBox="0 0 64 48" aria-hidden="true">
      <rect width="64" height="48" fill="#1a1430" />
      <rect
        x="15"
        y="9"
        width="20"
        height="30"
        rx="2.5"
        fill="#3a2d78"
        transform="rotate(-10 25 24)"
      />
      <rect x="27" y="7" width="22" height="33" rx="2.5" fill="#7c5cff" />
      <path d="M27 13h22M27 34h22" stroke="#c4b6ff" strokeWidth="1.2" />
      <path
        d="M38 18l2.2 4.5 4.8.6-3.5 3.3.9 4.8-4.4-2.4-4.4 2.4.9-4.8-3.5-3.3 4.8-.6z"
        fill="#ffbf5e"
      />
    </svg>
  ),
};

function DemoTabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -i : 0;
    const j = e.key === "End" ? TABS.length - 1 : d ? (i + d + TABS.length) % TABS.length : null;
    if (j === null) return;
    e.preventDefault();
    setTab(TABS[j]!.id);
    refs.current[j]?.focus();
  };
  return (
    <div className="thumb-tabs" role="tablist" aria-label="Demos">
      {TABS.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-controls={`panel-${t.id}`}
          aria-selected={tab === t.id}
          tabIndex={tab === t.id ? 0 : -1}
          className="thumb-tab"
          onClick={() => setTab(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          <span className="thumb">{THUMBS[t.id]}</span>
          <span className="thumb-text">
            <span className="thumb-title">{t.title}</span>
            <span className="thumb-sub">{t.sub}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

const resultOf = (payout: bigint, expired: boolean) =>
  expired ? "no draw" : payout > 0n ? `+${usdc(payout)}` : NOT_THIS_TIME;

/** The wallet's last three tickets, under the stage. */
function LastTickets({ owner }: { owner: Address }) {
  const tickets = useWalletTickets(owner);
  const rows = tickets.data?.rows.slice(0, 3) ?? null;
  if (rows && rows.length === 0) return null;
  return (
    <div className="last-tickets">
      <span className="eyebrow-s">Your last tickets</span>
      {!rows && <Skeleton w={260} h={14} />}
      {rows?.map((r) => {
        const kind = kindOf(r, r.integrator === tickets.data?.integrator).toLowerCase();
        const payout = r.end?.payout ?? 0n;
        return (
          <span key={r.ticket} className="last-ticket">
            {r.end && payout > 0n ? (
              <>
                <span className="up strong mono">+{usdc(payout)}</span> {kind}
              </>
            ) : (
              <>
                {kind} <span>{r.end ? resultOf(0n, r.end.kind === "expired") : "drawing"}</span>
              </>
            )}
            <span className="muted">{ago(r.openedAt)}</span>
          </span>
        );
      })}
      <Link to="/dashboard" className="last-all">
        All tickets
      </Link>
    </div>
  );
}

function WalletBlock({ owner, funds }: { owner: Address | undefined; funds: WalletFunds | null }) {
  const now = useNow();
  const next = readNext(owner);
  const wait = Math.ceil((next - now * 1000) / 1000);
  return (
    <section className="side-sec" aria-labelledby="wallet-h">
      <h2 id="wallet-h" className="eyebrow-s">
        Wallet
      </h2>
      {!owner ? (
        <div className="stack-s">
          <p className="small muted">Connect a wallet, then get free USDC in one click.</p>
          <ConnectButton />
        </div>
      ) : (
        <>
          <p className="wallet-usdc">
            <span className="mono">
              {funds ? <Tween>{usdc(funds.usdc ?? 0n)}</Tween> : <Skeleton w={130} h={30} inline />}
            </span>
            <span className="unit">USDC</span>
          </p>
          <p className="wallet-meta small muted">
            <span className="mono">{funds ? `${sol(funds.sol)} SOL` : "–"}</span>
            <span>for fees</span>
            <span className="wallet-faucet">
              {wait > 0 ? (
                <>Next free USDC in {clock(wait)}</>
              ) : (
                <FaucetButton className="btn-inline" />
              )}
            </span>
          </p>
        </>
      )}
    </section>
  );
}

/** How long an open ticket shows as drawing before the list gives up on it. */
const DRAWING_FOR_S = 15 * 60;
const DRAWS_SHOWN = 7;

type Draw = {
  key: string;
  /** The ticket and where its draw stands: a new value lights the row up again. */
  state: string;
  at: number;
  kind: TicketKind;
  /** Null when the ticket's opening was not read. */
  price: bigint | null;
  /** null while the draw is pending. */
  payout: bigint | null;
  expired: boolean;
};

/** A compact age for a live list: "now", "42 s", "6 min", "3 h", "2 d". */
function since(seconds: number): string {
  const d = Math.max(0, Math.floor(seconds));
  if (d < 5) return "now";
  if (d < 60) return `${d} s`;
  if (d < 3600) return `${Math.floor(d / 60)} min`;
  if (d < 86400) return `${Math.floor(d / 3600)} h`;
  return `${Math.floor(d / 86400)} d`;
}

function LiveDraws({ log, stats }: { log: TicketLog | null; stats: Stats | null }) {
  const now = useNow();
  const draws = useMemo((): Draw[] | null => {
    if (!log) return null;
    const cutoff = Date.now() / 1000 - DRAWING_FOR_S;
    const all: Draw[] = [
      ...log.rows
        .filter((r) => r.end || (r.openedAt ?? 0) > cutoff)
        .map((r) => ({
          key: r.ticket,
          state: `${r.ticket}:${r.end ? r.end.kind : "open"}`,
          at: r.end?.at ?? r.openedAt ?? 0,
          kind: kindOf(r, true),
          price: r.price,
          payout: r.end ? r.end.payout : null,
          expired: r.end?.kind === "expired",
        })),
      ...log.loneEnds.map((e) => ({
        key: e.ticket,
        state: `${e.ticket}:${e.kind}`,
        at: e.at ?? 0,
        kind: "Ticket" as const,
        price: null,
        payout: e.payout,
        expired: e.kind === "expired",
      })),
    ];
    return all.sort((a, b) => b.at - a.at).slice(0, DRAWS_SHOWN);
  }, [log]);
  const fresh = useFreshKeys(draws?.map((d) => d.state) ?? null);
  return (
    <section className="side-sec live-draws" aria-labelledby="draws-h">
      <h2 id="draws-h" className="eyebrow-s live-head">
        <span className="dot dot-live" aria-hidden="true" />
        Live draws
      </h2>
      {!draws && (
        <div className="stack-s">
          <Skeleton h={18} />
          <Skeleton h={18} />
          <Skeleton h={18} />
        </div>
      )}
      {draws && draws.length === 0 && <p className="small muted">No draw in the last days.</p>}
      {stats && stats.all.ticketsDrawn > 0 && (
        <p className="draws-ratio small muted">
          <Tween>{stats.all.wins.toLocaleString("en-US")}</Tween>{" "}
          {stats.all.wins === 1 ? "win" : "wins"} from{" "}
          <Tween>{stats.all.ticketsDrawn.toLocaleString("en-US")}</Tween>{" "}
          {stats.all.ticketsDrawn === 1 ? "ticket" : "tickets"}
        </p>
      )}
      {draws && draws.length > 0 && (
        <ul className="draws" aria-live="polite">
          {draws.map((d) => {
            const won = d.payout !== null && d.payout > 0n;
            const quiet = d.payout !== null && !won;
            const cls = [
              "draw-row",
              fresh.has(d.state) && "row-new",
              won && "is-win",
              quiet && "is-quiet",
            ];
            return (
              <li key={d.key} className={cls.filter(Boolean).join(" ")}>
                <time
                  className="draw-at mono"
                  dateTime={new Date(d.at * 1000).toISOString()}
                  title={new Date(d.at * 1000).toLocaleString()}
                >
                  {since(now - d.at)}
                </time>
                <span className="draw-what">
                  <span className="draw-kind">{d.kind}</span>
                  {won && (
                    <span className="draw-words">{winWords(d.kind, d.price, d.payout!)}</span>
                  )}
                  {quiet && (
                    <span className="draw-outcome">{d.expired ? "no draw" : NOT_THIS_TIME}</span>
                  )}
                </span>
                {d.payout === null ? (
                  <span className="draw-pending">drawing</span>
                ) : won ? (
                  <span className="draw-won">+{usdc(d.payout)}</span>
                ) : (
                  <span aria-hidden="true" />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The all-time figures, above the live draws: shown once the keeper has them, never a guess. */
function WinsKpi({ stats }: { stats: Stats | null }) {
  useNow(); // the "last win" age moves on
  if (!stats || stats.all.wins === 0) return null;
  const { wins, paid, biggestWin, lastWin } = stats.all;
  return (
    <section className="side-sec wins-kpi" aria-label="Wins so far">
      <p className="kpi-wins">
        <span className="kpi-big mono">
          <Tween ms={700}>{wins.toLocaleString("en-US")}</Tween>
        </span>{" "}
        {wins === 1 ? "win so far" : "wins so far"}
      </p>
      <p className="kpi-paid">
        <span className="mono strong">
          <Tween ms={700}>{usdc(paid)}</Tween>
        </span>{" "}
        USDC paid to winners
      </p>
      <p className="kpi-small small muted">
        {biggestWin && (
          <span>
            Biggest win{" "}
            <span className="mono">
              <Tween>{usdc(biggestWin.payout)}</Tween>
            </span>{" "}
            USDC
          </span>
        )}
        {lastWin?.at != null && <span>Last win {ago(lastWin.at)}</span>}
      </p>
    </section>
  );
}

function VaultShortcut({ state }: { state: Live }) {
  const apr = useApr(state);
  return (
    <Link to="/vault" className="vault-card">
      <span className="vault-card-text">
        <span className="small muted">
          Fade vault <span className="mono">{usdc(state.vault.totalAssets, 0)}</span> USDC
        </span>
        <span className="vault-card-title">Earn from every ticket</span>
      </span>
      <span className="vault-card-apr">
        <span className={apr?.pct != null ? "up" : "muted"}>
          {apr?.pct != null ? fmtApr(apr.pct) : "–"}
        </span>
        <span className="small muted">est. APR</span>
      </span>
    </Link>
  );
}

export function DemosPage() {
  const protocol = useProtocol();
  const tab = tabOf(useHash());
  const setTab = (t: Tab) => replaceHash(t);
  const dir = useDirection(TABS.findIndex((t) => t.id === tab));
  const state = protocol.data;
  const owner = useOwner();
  const connected = useWallet().account?.address;
  const funds = useWalletFunds(owner);
  // the demos act for the connected wallet only, never for one viewed with `?as=`
  const demoFunds = connected ? funds : null;
  const programTickets = useProgramTickets();
  const stats = useStats().data;
  // figures still climbing while the keeper reads the history are not shown
  const allTime = stats && !stats.syncing ? stats : null;
  // Opening on the checkout or the booster: its 3D scene loads while the demos do.
  useEffect(() => {
    if (tab === "checkout") preloadReceipt3d();
    if (tab === "booster") preloadPack3d();
  }, [tab]);
  return (
    <div className="container page demos-page home">
      <h1 className="sr-only">Fade</h1>
      {protocol.loading && !state && (
        <div className="demo-skeleton" aria-busy="true" aria-label="Loading">
          <div className="thumb-tabs">
            <Skeleton h={64} />
            <Skeleton h={64} />
            <Skeleton h={64} />
          </div>
          <Skeleton h={420} />
        </div>
      )}
      {protocol.error && !state && (
        <p className="error">
          The network did not answer ({protocol.error}). This page tries again every 10 seconds.
        </p>
      )}
      {state && !state.initialized && <NotInitialized />}
      {state && state.initialized && (
        <div className="home-grid">
          <section className="home-main" aria-label="Demos">
            <DemoTabs tab={tab} setTab={setTab} />
            <AnimatedHeight className="demo-stage">
              {TABS.map((t) => (
                <div
                  key={t.id}
                  role="tabpanel"
                  id={`panel-${t.id}`}
                  aria-labelledby={`tab-${t.id}`}
                  hidden={tab !== t.id}
                  className="panel enter"
                  style={enterStyle(dir)}
                >
                  {t.id === "checkout" && <CheckoutDemo state={state} funds={demoFunds} />}
                  {t.id === "swap" && <SwapDemo state={state} funds={demoFunds} />}
                  {t.id === "booster" && <BoosterDemo state={state} funds={demoFunds} />}
                </div>
              ))}
            </AnimatedHeight>
            {owner && <LastTickets owner={owner} />}
          </section>
          <aside className="home-side" aria-label="Wallet, live draws and the vault">
            <WalletBlock owner={owner} funds={funds} />
            <WinsKpi stats={allTime} />
            <LiveDraws log={programTickets.data} stats={allTime} />
            <VaultShortcut state={state} />
          </aside>
          <DevSimPanel demo={tab} />
        </div>
      )}
    </div>
  );
}
