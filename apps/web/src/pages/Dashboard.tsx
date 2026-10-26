// The dashboard: one wallet in Fade, one role at a time. Two cards at the top switch between
// the vault, as a liquidity provider, and the tickets, as a buyer; the two never add up. The
// choice is kept in the URL (?view=vault|tickets).
import type { Address, TransactionSigner } from "@solana/kit";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { ActionButton } from "../components/Button";
import { InfoTip } from "../components/disclosure";
import { ShareWinButton } from "../components/ShareSheet";
import { WinIcon } from "../components/WinIcon";
import { EventRows, stateKeys, type EventRow } from "../components/EventRows";
import { FluidChart, type FluidPoint } from "../components/FluidChart";
import { LogoMark } from "../components/Logo";
import { Tween, useFreshKeys } from "../components/motion";
import { ExplorerTx, FailureBox, NotInitialized, Skeleton } from "../components/ui";
import { ata, fetchIntegrator } from "../lib/fade";
import {
  bps,
  clock,
  shares as fmtShares,
  signedPct as signedPctOf,
  usdc,
  usdcTidy as amount,
} from "../lib/format";
import { livePrice, strikeSeries } from "../lib/history";
import { useChainNow, usePolling, useProtocol, useWalletTickets } from "../lib/hooks";
import {
  appFigures,
  sharePct,
  ticketStats,
  vaultModel,
  withdrawableFor,
  type VaultModel,
} from "../lib/dashboard";
import {
  claimPayoutInstructions,
  parkedPayouts,
  readEscrows,
  type Escrow,
} from "../lib/payoutEscrow";
import type { PendingRequest } from "../lib/position";
import {
  entryPrice,
  heldSeries,
  pnlAt,
  pnlOf,
  positionApr,
  positionSeries,
} from "../lib/positionPnl";
import { APR_LABEL, fmtApr, winPayout, type TicketRow } from "../lib/ticketLog";
import type { AppTotals, BuyerTotals } from "../lib/walletHistory";
import { shareWinOfRow } from "../lib/shareWin";
import { send, type ProgramFailure } from "../lib/tx";
import { boosterExtra, buyerLine } from "../lib/ticketWords";
import { availableNow, utilisationBps } from "../lib/vaultFigures";
import { Link } from "../router";
import { ConnectButton } from "../wallet/ConnectButton";
import { useWallet } from "../wallet/WalletProvider";
import { AprFigure, useApr } from "./vault/Apr";
import {
  asFailure,
  doneByKeeper,
  isCancelled,
  KEEPER_GRACE_SECONDS,
  type Live,
  type VaultData,
} from "./vault/common";
import { requestStatus, signed, useClaim, vaultShareBps } from "./vault/Position";
import { useOwner, useVaultData } from "./vault/useVaultData";

type View = "vault" | "tickets";

/** Draws listed before "Show all". */
const DRAWS_SHOWN = 30;
const DAY = 86400;
const HOUR = 3600;

const readView = (): View | null => {
  const v = new URLSearchParams(window.location.search).get("view");
  return v === "vault" || v === "tickets" ? v : null;
};

/** Keeps the tab in the URL without a history entry (`?as=` and the rest stay). */
function writeView(v: View) {
  const q = new URLSearchParams(window.location.search);
  q.set("view", v);
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}?${q.toString()}${window.location.hash}`,
  );
}

const two = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const tone = (v: bigint) => (v > 0n ? " pos" : v < 0n ? " neg" : "");
/** Basis points as "+3.96%" / "−1.20%". */
const signedPct = (b: bigint) => signedPctOf(Number(b) / 100, 2, "%");
/** A share price, micro-USDC per whole share, as "1.0037". */
const price4 = (p: bigint) => usdc(p, 4);

// --- what a request is doing -----------------------------------------------------------------

/** A request a claim of the owner's would move now: the delivery is late, parked or part-paid. */
function claimableNow(r: PendingRequest, chainNow: number): boolean {
  if (r.phase === "parked") return true;
  if (r.phase === "rationed") return (r.claimableNow ?? 0n) > 0n;
  return (
    r.phase === "claimable" && r.struckTs !== null && chainNow - r.struckTs > KEEPER_GRACE_SECONDS
  );
}

/** "ready in 1:24", "ready any moment", "arriving", "partly paid". */
function statusWords(r: PendingRequest, left: number | null): string {
  if (left !== null) return left > 0 ? `ready in ${clock(left)}` : "ready any moment";
  if (r.phase === "awaiting-strike") return "ready any moment";
  if (r.phase === "claimable") return "arriving";
  if (r.phase === "rationed") return "partly paid";
  return "ready";
}

function RequestWords({ r, data }: { r: PendingRequest; data: VaultData }) {
  const chainNow = useChainNow(data.state);
  return <>{statusWords(r, requestStatus(r, data, chainNow).left)}</>;
}

/** The in-progress strip: one line per open request, a Claim only when one would pay now. */
function InProgress({ r, data }: { r: PendingRequest; data: VaultData }) {
  const chainNow = useChainNow(data.state);
  const st = requestStatus(r, data, chainNow);
  const c = useClaim(r, data);
  const canClaim = claimableNow(r, chainNow) && c.canSign && !c.sig && !c.raced;
  return (
    <div className="dprogress" role="status">
      <span className="dprogress-tag">
        {r.kind === "deposit" ? "Deposit in progress" : "Withdrawal in progress"}
      </span>
      <span className="dprogress-what label-tip">
        {r.kind === "deposit"
          ? `${usdc(r.amount)} USDC`
          : `${fmtShares(r.amount)} fvUSDC, about ${usdc(r.value)} USDC`}
        <InfoTip label="About this request" docs>
          {st.explain}
        </InfoTip>
      </span>
      <span className="dprogress-when mono" role="timer" aria-live="off">
        {statusWords(r, st.left)}
      </span>
      {canClaim && (
        <ActionButton
          type="button"
          className="btn-primary btn-small"
          busy={c.busy}
          busyLabel="Claiming…"
          succeeded={c.sig}
          successLabel="Claimed"
          failed={c.failure}
          onClick={() => void c.claim()}
        >
          {r.phase === "rationed" ? `Claim ${usdc(r.claimableNow ?? 0n)} USDC` : "Claim"}
        </ActionButton>
      )}
      {c.sig && (
        <span className="small">
          Claimed <ExplorerTx sig={c.sig} />
        </span>
      )}
      {c.failure && <FailureBox failure={c.failure} />}
    </div>
  );
}

// --- figures -----------------------------------------------------------------------------------

function Fig({
  label,
  tip,
  value,
  sub,
  valueClass = "",
  action,
}: {
  label: string;
  tip?: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  valueClass?: string;
  /** A small button under the figure. */
  action?: ReactNode;
}) {
  return (
    <div className="dfig">
      <p className="dfig-label label-tip">
        {label}
        {tip && <InfoTip label={`About ${label.toLowerCase()}`}>{tip}</InfoTip>}
      </p>
      <p className={`dfig-value${valueClass}`}>{value}</p>
      {sub !== undefined && <p className="dfig-sub">{sub}</p>}
      {action && <div className="fig-share">{action}</div>}
    </div>
  );
}

const sk = (w = 90) => <Skeleton w={w} h={24} inline />;

// --- the vault, as a liquidity provider ------------------------------------------------------

function useVaultModel(data: VaultData): VaultModel | null {
  const { ownerLog, pending, wallet } = data;
  return useMemo(
    () => (ownerLog && pending && wallet ? vaultModel(ownerLog, pending, wallet.shares) : null),
    [ownerLog, pending, wallet],
  );
}

type Series = "value" | "pnl";
type Range = "7D" | "1M" | "3M" | "ALL";
const RANGES: Range[] = ["7D", "1M", "3M", "ALL"];
const RANGE_S: Record<Exclude<Range, "ALL">, number> = {
  "7D": 7 * DAY,
  "1M": 30 * DAY,
  "3M": 90 * DAY,
};

function PositionChart({
  points,
  canPnl,
}: {
  points: { t: number; value: bigint; pnl: bigint }[];
  canPnl: boolean;
}) {
  const [series, setSeries] = useState<Series>("value");
  const [range, setRange] = useState<Range>("1M");
  const shown: Series = canPnl ? series : "value";
  const now = points.at(-1)?.t ?? Math.floor(Date.now() / 1000);
  const first = points[0]?.t ?? now;
  const earliest = Math.min(first, now - HOUR);
  const from = range === "ALL" ? earliest : Math.max(earliest, now - RANGE_S[range]);
  const fluid: FluidPoint[] = useMemo(
    () => points.map((p) => ({ t: p.t, v: Number(shown === "value" ? p.value : p.pnl) / 1e6 })),
    [points, shown],
  );
  const fmt = (v: number) => `${shown === "pnl" && v > 0 ? "+" : ""}${two.format(v)} USDC`;
  const axis = (v: number) => (Math.abs(v) >= 100 ? whole.format(v) : two.format(v));
  return (
    <section className="dchart" aria-label="Your position over time">
      <div className="dchart-head">
        <div className="pills" role="group" aria-label="Series">
          {(["value", "pnl"] as const).map((s) =>
            s === "pnl" && !canPnl ? null : (
              <button
                key={s}
                type="button"
                className={`pill pill-s${shown === s ? " on" : ""}`}
                aria-pressed={shown === s}
                onClick={() => setSeries(s)}
              >
                {s === "value" ? "Value" : "P&L"}
              </button>
            ),
          )}
          <InfoTip label="About this chart" docs>
            {shown === "value"
              ? "The fvUSDC this wallet held at each moment, at the share price of the time."
              : "Value less what the shares held cost, plus what withdrawals already realised."}
          </InfoTip>
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
      <FluidChart
        points={fluid}
        from={from}
        to={now}
        format={fmt}
        axisFormat={axis}
        step
        label={shown === "value" ? "Your position's value" : "Your position's P&L"}
      />
    </section>
  );
}

function VaultInvite({ state }: { state: Live }) {
  const apr = useApr(state);
  return (
    <section className="dinvite">
      <p className="dinvite-text">
        Every ticket on Fade leaves a margin to the vault. Deposit USDC and earn it.
      </p>
      <p className="dinvite-apr">
        <span className="dfig-label">Vault {APR_LABEL}</span>
        <span className="dinvite-apr-value">
          <AprFigure apr={apr} />
        </span>
      </p>
      <Link to="/vault" className="btn btn-primary dbtn-vault">
        Open the vault
      </Link>
    </section>
  );
}

function VaultTab({ data, model }: { data: VaultData; model: VaultModel | null }) {
  const { state, summary, wallet, pending } = data;
  const apr = useApr(state);
  const now = Math.floor(Date.now() / 60_000) * 60;
  const prices = useMemo(
    () =>
      data.log
        ? strikeSeries(data.log.items, state.vault, now).map((p) => ({ t: p.t, price: p.price }))
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.log, state.vault],
  );
  const value = summary?.value ?? null;
  const ok = model?.reconciled ?? false;
  const pnl = model && value !== null && ok ? pnlOf(model.book, value) : null;
  const series = useMemo(() => {
    if (!prices || !model || !wallet || value === null) return null;
    // the last point is the value shown above the chart
    if (ok) return positionSeries(model.flows, prices, now, value);
    // the history does not explain the fvUSDC held: their value only, at each price
    return heldSeries(wallet.shares, prices, now, value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prices, model, wallet, ok, value]);
  const week = series && pnl ? pnl.total - pnlAt(series, now - 7 * DAY) : null;
  const myApr = model && value !== null && ok ? positionApr(model.flows, value, now) : null;
  const entry = model && ok ? entryPrice(model.book) : null;
  const live = livePrice(state.vault);
  const share = vaultShareBps(data);
  const { vault } = state;
  const available = availableNow(state);
  const utilPct = Number(utilisationBps(vault)) / 100;
  const unexplained =
    "Not shown: some of this wallet's fvUSDC arrived or left by transfer, or predate the history this page reads, so their cost is unknown.";

  const historyRows: EventRow[] = (model?.moves ?? []).map((m) => {
    const r = pending?.find((p) => p.kind === m.kind && p.epochId === m.epochId);
    const at = m.shares > 0n && !m.open ? price4((m.assets * 1_000_000_000n) / m.shares) : null;
    if (m.kind === "deposit")
      return {
        key: `d${m.epochId}`,
        t: m.t,
        title: "Deposit",
        // in progress: the amount is already on the right, the detail says when it lands
        detail: m.open ? (
          r ? (
            <RequestWords r={r} data={data} />
          ) : (
            "in progress"
          )
        ) : (
          `${amount(m.assets)} USDC${at ? ` at ${at}` : ""}`
        ),
        amount: m.open ? `${usdc(m.assets)} USDC` : `+${fmtShares(m.shares)} fvUSDC`,
        tone: m.open ? "pending" : "plain",
        signature: m.signature,
        stateKey: `d${m.epochId}:${m.open ? "open" : "done"}`,
      };
    return {
      key: `w${m.epochId}`,
      t: m.t,
      title: "Withdrawal",
      detail: m.open ? (
        <>
          {fmtShares(m.shares)} fvUSDC, {r ? <RequestWords r={r} data={data} /> : "in progress"}
        </>
      ) : (
        `${fmtShares(m.shares)} fvUSDC${at ? ` at ${at}` : ""}`
      ),
      amount: `+${usdc(m.assets)} USDC`,
      tone: m.open ? "pending" : "plain",
      signature: m.signature,
      stateKey: `w${m.epochId}:${m.open ? "open" : "done"}`,
    };
  });
  const fresh = useFreshKeys(model ? stateKeys(historyRows) : null);

  return (
    <div className="dview">
      <div className="dhero">
        <div className="dhero-main">
          <p className="dhero-value">
            {value !== null ? <Tween>{usdc(value)}</Tween> : <Skeleton w={220} h={48} inline />}
            <span className="dhero-unit"> USDC in the vault</span>
          </p>
          <p className="dhero-line">
            {pnl ? (
              <>
                <span className={`dhero-strong${tone(pnl.unrealized)}`}>
                  {signed(pnl.unrealized)}
                  {pnl.unrealizedBps !== null ? ` (${signedPct(pnl.unrealizedBps)})` : ""}
                </span>{" "}
                <span className="muted">unrealized</span>
                {week !== null && (
                  <span className="dhero-gap">
                    <span className="dhero-strong">{signed(week)}</span>{" "}
                    <span className="muted">last 7 days</span>
                  </span>
                )}
              </>
            ) : model && !ok ? (
              <span className="muted label-tip">
                Result not shown
                <InfoTip label="Why the result is not shown">{unexplained}</InfoTip>
              </span>
            ) : (
              <Skeleton w={260} h={18} inline />
            )}
          </p>
        </div>
        <div className="dhero-actions">
          <Link to="/vault?action=deposit" className="btn btn-primary">
            Deposit
          </Link>
          <Link to="/vault?action=withdraw" className="btn btn-ghost">
            Withdraw
          </Link>
        </div>
      </div>

      {pending?.map((r) => (
        <InProgress key={r.address} r={r} data={data} />
      ))}

      {series && series.length > 0 ? (
        <PositionChart points={series} canPnl={ok} />
      ) : (
        !data.logError && <Skeleton h={200} />
      )}

      <div className="dfigs dfigs-top">
        <Fig
          label="Your shares"
          value={wallet ? <Tween>{fmtShares(wallet.shares)}</Tween> : sk()}
          sub="fvUSDC"
        />
        <Fig
          label="Share of the vault"
          value={share !== null ? sharePct(share) : sk(60)}
          sub={`of ${usdc(vault.totalAssets, 0)} USDC`}
        />
        <Fig
          label="Entry share price"
          tip="What your fvUSDC cost on average: the USDC you deposited per fvUSDC, less the cost of the fvUSDC already withdrawn."
          value={entry !== null ? price4(entry) : model && !ok ? "–" : model ? "–" : sk(70)}
          sub={live !== null ? `now ${price4(live)}` : undefined}
        />
        <Fig
          label="Withdrawable now"
          tip={`What the vault could pay this position at the next close while open payouts keep their reserve: ${usdc(available, 0)} USDC for every provider together.`}
          value={value !== null ? usdc(withdrawableFor(value, available)) : sk()}
          sub={`the vault is ${utilPct > 0 && utilPct < 1 ? "under 1" : utilPct.toFixed(0)}% committed`}
        />
      </div>
      <div className="dfigs dfigs-bottom">
        <Fig
          label="Unrealized P&L"
          tip={ok ? "Value of the fvUSDC you hold, less what they cost." : unexplained}
          value={pnl ? signed(pnl.unrealized) : model && !ok ? "–" : sk()}
          valueClass={pnl ? tone(pnl.unrealized) : ""}
          sub={
            pnl && model
              ? pnl.unrealizedBps !== null
                ? `${signedPct(pnl.unrealizedBps)} on ${usdc(model.book.cost)} cost`
                : "nothing held"
              : undefined
          }
        />
        <Fig
          label="Realized P&L"
          tip={
            ok
              ? "What your withdrawals paid, less what the fvUSDC they took cost on average. A withdrawal still in progress counts at its estimate."
              : unexplained
          }
          value={pnl ? signed(pnl.realized) : model && !ok ? "–" : sk()}
          valueClass={pnl ? tone(pnl.realized) : ""}
          sub="from withdrawals"
        />
        <Fig
          label="Your APR"
          tip={
            myApr && myApr.pct === null && myApr.span < DAY
              ? "Shown once your first deposit is a day old: a few hours say nothing about a year."
              : "Your result since your first deposit, over the USDC you had in the vault on average (each deposit counted for the time it was in, each withdrawal taken out from its date), scaled to a year. Past results, not a forecast."
          }
          value={
            myApr ? (myApr.pct === null ? "–" : fmtApr(myApr.pct)) : model && !ok ? "–" : sk(60)
          }
          valueClass={myApr?.pct != null && myApr.pct < 0 ? " neg" : ""}
          sub="since your first deposit"
        />
        <Fig
          label={`Vault ${APR_LABEL}`}
          value={<AprFigure apr={apr} />}
          sub="last 7 days, annualised"
        />
      </div>

      <section className="dlist">
        <h2 className="dlist-title">Deposits and withdrawals</h2>
        {!model && <Skeleton h={90} />}
        {model && historyRows.length === 0 && <p className="small muted">Nothing yet.</p>}
        {historyRows.length > 0 && (
          <EventRows rows={historyRows} label="Deposits and withdrawals" fresh={fresh} />
        )}
      </section>
    </div>
  );
}

// --- tickets, as a buyer -------------------------------------------------------------------

/** "a free checkout", "a second pack", "a swap won back". */
function bestWords(r: TicketRow, demoApp: boolean): string {
  const l = buyerLine(r, demoApp);
  if (l.kind === "Checkout") return "a free checkout";
  if (l.kind === "Booster") return `a ${boosterExtra(r, r.end?.payout ?? 0n) ?? "booster win"}`;
  if (l.kind === "Small ticket") return "a small ticket win";
  return `a ${l.kind.toLowerCase()} won back`;
}

/**
 * The parked payouts among `rows` (a wallet's tickets), by ticket; empty while unread or when
 * none is parked. Read again every 20 s and on `refresh`.
 */
function usePayoutEscrows(rows: readonly TicketRow[] | null, usdcAccount: Address | null) {
  const parked = useMemo(
    () => (rows && usdcAccount ? parkedPayouts(rows, usdcAccount) : []),
    [rows, usdcAccount],
  );
  const key = parked.map((r) => r.ticket).join(",");
  const read = usePolling(
    async () => (usdcAccount ? readEscrows(parked, usdcAccount) : new Map<Address, Escrow>()),
    20_000,
    [key, usdcAccount],
  );
  return { escrows: read.data ?? new Map<Address, Escrow>(), refresh: read.refresh };
}

type Claimable = Extract<Escrow, { state: "claimable" }>;

/** How long the button shows "Claimed" before the row reads the chain again and drops it. */
const CLAIMED_FLASH_MS = 1_600;

/**
 * Claims a parked payout from the Draws list, one at a time. On success the button flashes, then
 * the escrows and the wallet's tickets are read again (`fade:draws`).
 */
function usePayoutClaim(signer: TransactionSigner | undefined, reread: () => void) {
  const [busy, setBusy] = useState<Address | null>(null);
  const [sent, setSent] = useState<{ ticket: Address; sig: string } | null>(null);
  const [failure, setFailure] = useState<{ ticket: Address; failure: ProgramFailure } | null>(null);
  const rereadRef = useRef(reread);
  rereadRef.current = reread;
  const done = () => {
    rereadRef.current();
    window.dispatchEvent(new Event("fade:draws"));
  };
  const claim = async (ticket: Address, escrow: Claimable) => {
    if (!signer || busy) return;
    setBusy(ticket);
    setFailure(null);
    try {
      const ixs = await claimPayoutInstructions(signer, ticket, escrow);
      const label = "roundTicket" in escrow ? "claim_round_payout" : "claim_payout";
      const s = await send(signer, ixs, label, 200_000);
      setSent({ ticket, sig: s.signature });
      setTimeout(done, CLAIMED_FLASH_MS);
    } catch (e) {
      const f = asFailure(e);
      // the ticket closed in the meantime: someone else delivered the payout
      if (doneByKeeper(f, "claim")) done();
      else if (!isCancelled(f)) setFailure({ ticket, failure: f });
    } finally {
      setBusy(null);
    }
  };
  return { claim, busy, sent, failure };
}

/** A row's buttons side by side, or none: the claim of a parked payout, the share of a win. */
function actions(...buttons: ReactNode[]): ReactNode {
  const shown = buttons.filter((b) => b !== null && b !== undefined && b !== false);
  return shown.length > 0 ? shown.map((b, i) => <Fragment key={i}>{b}</Fragment>) : undefined;
}

function TicketsTab({
  rows,
  totals,
  myIntegrator,
  usdcAccount,
  signer,
  app,
}: {
  rows: TicketRow[] | null;
  /** The counts over every draw, when `rows` lists only the newest of them; else null. */
  totals: BuyerTotals | null;
  myIntegrator: Address | null;
  /** The wallet's USDC account, the beneficiary of its tickets. */
  usdcAccount: Address | null;
  /** The connected wallet's signer, only when this page shows that wallet. */
  signer: TransactionSigner | undefined;
  app: ReactNode;
}) {
  const [filter, setFilter] = useState<"all" | "won">("all");
  const [all, setAll] = useState(false);
  const { escrows, refresh } = usePayoutEscrows(rows, usdcAccount);
  const payout = usePayoutClaim(signer, refresh);
  const demo = (r: TicketRow) => r.integrator === myIntegrator;
  const drawRows: EventRow[] = (rows ?? []).map((r) => {
    const escrow = escrows.get(r.ticket);
    // the log only knows the payout was parked; the chain says it has since been delivered
    const shown =
      escrow?.state === "claimed" && r.end ? { ...r, end: { ...r.end, pending: false } } : r;
    const l = buyerLine(shown, demo(r), usdcAccount);
    const claimable = escrow?.state === "claimable" ? escrow : null;
    const flashing = payout.sent?.ticket === r.ticket && escrow?.state !== "claimed";
    return {
      key: r.ticket,
      t: r.openedAt,
      title: l.title,
      detail: l.detail,
      amount: l.amount,
      tone: l.tone,
      signature: r.end?.signature ?? r.openSig,
      stateKey: `${r.ticket}:${r.end?.kind ?? "open"}`,
      win: winPayout(r.end) > 0n,
      icon: winPayout(r.end) > 0n ? <WinIcon kind={l.kind} /> : undefined,
      drawing: !r.end,
      action: actions(
        signer && (claimable || flashing) ? (
          <ActionButton
            type="button"
            className="btn-primary btn-small"
            busy={payout.busy === r.ticket}
            busyLabel="Claiming"
            disabled={payout.busy !== null || !claimable}
            succeeded={flashing ? payout.sent?.sig : undefined}
            successLabel="Claimed"
            failed={payout.failure?.ticket === r.ticket ? payout.failure.failure : undefined}
            onClick={() => claimable && void payout.claim(r.ticket, claimable)}
          >
            Claim
          </ActionButton>
        ) : null,
        // a win of this wallet's own, never a loss and never someone else's view
        signer ? (
          <ShareWinButton
            win={shareWinOfRow(r, demo(r))}
            label="Share"
            ariaLabel={`Share this win: ${l.amount} USDC`}
            className="btn btn-ghost share-row-btn"
          />
        ) : null,
      ),
    };
  });
  const fresh = useFreshKeys(rows ? stateKeys(drawRows) : null);
  if (!rows)
    return (
      <div className="dview">
        <Skeleton w={320} h={52} />
        <Skeleton h={70} />
        <Skeleton h={160} />
      </div>
    );
  const listed = ticketStats(rows, demo);
  const { best, favourite } = listed;
  const n = totals?.draws ?? rows.length;
  const wins = totals?.wins ?? listed.wins;
  const won = totals?.won ?? listed.won;
  const spent = totals?.spent ?? listed.spent;
  const winRate = totals ? (n ? Math.round((wins * 100) / n) : 0) : listed.winRate;

  const matching = drawRows.filter((r) => filter === "all" || r.win);
  const draws = all ? matching : matching.slice(0, DRAWS_SHOWN);

  return (
    <div className="dview">
      <div className="dhero">
        <div className="dhero-main">
          <p className="dhero-value">
            <Tween>{n.toString()}</Tween>
            <span className="dhero-word">
              {" "}
              {n === 1 ? "draw" : "draws"}
              {wins === 0 && n > 0 ? ", no win yet" : ""}
            </span>
            {wins > 0 && (
              <>
                {" "}
                <span className="pos">
                  <Tween>{wins.toString()}</Tween>
                </span>
                <span className="dhero-word"> won</span>
              </>
            )}
          </p>
          <p className="dhero-line muted">
            {n === 0
              ? "No draw yet."
              : wins > 0
                ? `${usdc(won)} USDC won, ${usdc(spent)} USDC in tickets`
                : `${usdc(spent)} USDC in tickets`}
          </p>
        </div>
        <div className="dhero-actions">
          <Link to="/" className="btn btn-ghost">
            Try a demo
          </Link>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="dfigs dfigs-one">
          <Fig
            label="Won"
            value={usdc(won)}
            valueClass={won > 0n ? " pos" : ""}
            sub="paid to your wallet"
          />
          <Fig
            label="Best win"
            value={best ? usdc(best.end!.payout) : "–"}
            valueClass={best ? " pos" : ""}
            sub={best ? bestWords(best, demo(best)) : "no win yet"}
            action={
              best && signer ? (
                <ShareWinButton
                  win={shareWinOfRow(best, demo(best))}
                  label="Share"
                  ariaLabel="Share your best win"
                  className="btn btn-ghost share-row-btn"
                />
              ) : undefined
            }
          />
          <Fig label="Win rate" value={`${wins} of ${n}`} sub={`${winRate} %`} />
          {favourite && (
            <Fig
              label="Favourite"
              value={favourite[0]}
              sub={`${favourite[1]} of ${rows.length} ${totals ? "recent " : ""}tickets`}
            />
          )}
        </div>
      )}

      {rows.length > 0 && (
        <section className="dlist">
          <div className="dlist-head">
            <h2 className="dlist-title">Draws</h2>
            <div className="pills" role="group" aria-label="Filter draws">
              {(["all", "won"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`pill pill-s${filter === f ? " on" : ""}`}
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {f === "all" ? "All" : "Won"}
                </button>
              ))}
            </div>
          </div>
          {matching.length === 0 && <p className="small muted">No win yet.</p>}
          {draws.length > 0 && <EventRows rows={draws} label="Draws" fresh={fresh} />}
          {payout.failure && (
            <FailureBox failure={payout.failure.failure} title="The payout was not claimed" />
          )}
          {matching.length > DRAWS_SHOWN && (
            <button type="button" className="link-btn small" onClick={() => setAll((a) => !a)}>
              {all
                ? "Fewer draws"
                : totals
                  ? `Show ${matching.length} of ${filter === "all" ? n : wins} draws`
                  : `Show all ${matching.length} draws`}
            </button>
          )}
        </section>
      )}
      {app}
    </div>
  );
}

/** For a wallet whose app opens tickets for others: what its app did, compact. */
function MyApp({
  state,
  owner,
  rows,
  totals,
}: {
  state: Live;
  owner: Address;
  rows: TicketRow[] | null;
  /** The counts over every ticket of the app, when `rows` lists only the newest; else null. */
  totals: AppTotals | null;
}) {
  const record = usePolling(
    async () => ({ owner, data: await fetchIntegrator(owner), ownUsdc: await ata(owner) }),
    30_000,
    [owner],
  );
  const integrator = record.data && record.data.owner === owner ? record.data.data : null;
  const mine = rows ?? [];
  // a real app opens tickets that pay someone else; a buyer of the demos has a record too
  const servesOthers = !!record.data && mine.some((r) => r.beneficiary !== record.data!.ownUsdc);
  if (!integrator || !servesOthers) return null;
  const figures = appFigures(
    mine,
    integrator.reservedLiability,
    state.vault.totalAssets,
    state.config.params.whaleBps,
  );
  const { cap, used } = figures;
  const appShare = totals?.appShare ?? figures.appShare;
  const paid = totals?.paid ?? figures.paid;
  return (
    <section className="dlist">
      <h2 className="dlist-title label-tip">
        My app
        <InfoTip label="About my app" docs>
          Tickets your app opened for its users. Figures cover the tickets in your app's history;
          the ticket count is the record's own.
        </InfoTip>
      </h2>
      <div className="dfigs dfigs-one">
        <Fig label="Tickets" value={integrator.nextNonce.toString()} />
        <Fig label="App share earned" value={usdc(appShare)} sub="USDC" />
        <Fig label="Customers' winnings" value={usdc(paid)} sub="USDC" />
        <Fig
          label="Open exposure"
          tip={`Open payouts at their worst case, against the most one app may hold: ${bps(state.config.params.whaleBps, 0)} of the vault, ${usdc(cap)} USDC now.`}
          value={usdc(integrator.reservedLiability)}
          sub={`${used.toFixed(1)}% of the limit`}
        />
      </div>
    </section>
  );
}

// --- the page ------------------------------------------------------------------------------

function RoleCard({
  role,
  on,
  figure,
  onPick,
}: {
  role: View;
  on: boolean;
  figure: ReactNode;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`dtab-${role}`}
      aria-selected={on}
      aria-controls="dpanel"
      className={`dtab dtab-${role}${on ? " on" : ""}`}
      onClick={onPick}
    >
      <span className="dtab-text">
        <span className="dtab-name">{role === "vault" ? "VAULT" : "TICKETS"}</span>
        <span className="dtab-sub">
          {role === "vault" ? "as a liquidity provider" : "as a buyer"}
        </span>
      </span>
      <span className="dtab-figure">{figure}</span>
    </button>
  );
}

function Dashboard({ state }: { state: Live }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const protocol = useProtocol();
  // the dashboard shows no Providers table: none of its reads
  const data = useVaultData(
    state,
    refreshKey,
    () => {
      setRefreshKey((k) => k + 1);
      protocol.refresh();
    },
    { providers: false },
  );
  const owner = useOwner();
  const { account, signer } = useWallet();
  // a claim is signed by the wallet this page shows, never for a `?as=` view
  const ownSigner = account && account.address === owner ? signer : undefined;
  const tickets = useWalletTickets(owner);
  const model = useVaultModel(data);
  const [picked, setPicked] = useState<View | null>(readView);

  const t = tickets.data;
  const buyerRows = useMemo(
    () =>
      t ? t.rows.filter((r) => r.beneficiary === t.usdcAccount || r.beneficiary === owner) : null,
    [t, owner],
  );
  const appRows = useMemo(
    () => (t ? t.rows.filter((r) => r.integrator === t.integrator) : null),
    [t],
  );
  // a role whose newest tickets alone are listed: its counts are over all of them
  const buyerTotals = t && !t.complete.buyer ? t.totals.buyer : null;
  const appTotals = t && !t.complete.app ? t.totals.app : null;

  if (!owner)
    return (
      <div className="empty dempty">
        <div className="empty-art" aria-hidden="true">
          <LogoMark size={40} />
        </div>
        <div className="stack-s">
          <p className="empty-title">Your positions and tickets, in one place</p>
          <p className="small muted">Connect a wallet to see them.</p>
          <ConnectButton />
        </div>
      </div>
    );

  const { wallet, pending, summary } = data;
  const hasPosition = !!wallet && wallet.shares > 0n;
  const hasPending = !!pending && pending.length > 0;
  const lpKnown = wallet !== null && pending !== null;
  const everLp = hasPosition || hasPending || (data.ownerLog?.length ?? 0) > 0;
  const loaded = lpKnown && buyerRows !== null && data.ownerLog !== null;
  const view: View | null =
    picked ??
    (lpKnown ? (hasPosition || hasPending ? "vault" : buyerRows ? "tickets" : null) : null);
  const pick = (v: View) => {
    setPicked(v);
    writeView(v);
  };

  if (loaded && !everLp && buyerRows.length === 0)
    return (
      <>
        <h1 className="sr-only">Dashboard</h1>
        <div className="empty dempty">
          <div className="empty-art" aria-hidden="true">
            <LogoMark size={40} />
          </div>
          <div className="stack-s">
            <p className="empty-title">Nothing here yet</p>
            <p className="small muted">Your tickets and your place in the vault will show here.</p>
            <div className="dempty-actions">
              <Link to="/" className="btn btn-primary">
                Try a demo
              </Link>
              <Link to="/vault" className="btn btn-ghost">
                Open the vault
              </Link>
            </div>
          </div>
        </div>
      </>
    );

  const buyerDraws = buyerTotals?.draws ?? buyerRows?.length ?? 0;
  const buyerWins =
    buyerTotals?.wins ?? buyerRows?.filter((r) => winPayout(r.end) > 0n).length ?? 0;

  return (
    <>
      <h1 className="sr-only">Dashboard</h1>
      <div className="dtabs" role="tablist" aria-label="Your role">
        <RoleCard
          role="vault"
          on={view === "vault"}
          onPick={() => pick("vault")}
          figure={
            !summary || !lpKnown ? (
              <Skeleton w={90} h={26} inline />
            ) : everLp ? (
              <Tween>{usdc(summary.value)}</Tween>
            ) : (
              <span className="muted">–</span>
            )
          }
        />
        <RoleCard
          role="tickets"
          on={view === "tickets"}
          onPick={() => pick("tickets")}
          figure={
            !buyerRows ? (
              <Skeleton w={90} h={26} inline />
            ) : buyerDraws ? (
              <span className="dtab-count">
                <Tween>{buyerDraws.toString()}</Tween>
                <span className="dtab-figsub">
                  {buyerDraws === 1 ? "draw" : "draws"},{" "}
                  {buyerWins > 0 ? `${buyerWins} won` : "no win yet"}
                </span>
              </span>
            ) : (
              <span className="muted">–</span>
            )
          }
        />
      </div>
      <section
        id="dpanel"
        role="tabpanel"
        aria-labelledby={view ? `dtab-${view}` : undefined}
        className="dpanel"
        key={view ?? "loading"}
      >
        {view === null && <Skeleton h={240} />}
        {view === "vault" &&
          (lpKnown && !everLp && data.ownerLog !== null ? (
            <VaultInvite state={state} />
          ) : (
            <VaultTab data={data} model={model} />
          ))}
        {view === "tickets" && (
          <TicketsTab
            rows={buyerRows}
            totals={buyerTotals}
            myIntegrator={t?.integrator ?? null}
            usdcAccount={t?.usdcAccount ?? null}
            signer={ownSigner}
            app={<MyApp state={state} owner={owner} rows={appRows} totals={appTotals} />}
          />
        )}
      </section>
    </>
  );
}

export function DashboardPage() {
  const protocol = useProtocol();
  const state = protocol.data;
  return (
    <div className="container page dpage">
      {state && state.initialized && <Dashboard state={state} />}
      {protocol.loading && !state && (
        <div className="dtabs" aria-busy="true">
          <Skeleton h={76} />
          <Skeleton h={76} />
        </div>
      )}
      {protocol.error && !state && (
        <p className="error">
          The network did not answer ({protocol.error}). This page tries again every 10 seconds.
        </p>
      )}
      {state && !state.initialized && <NotInitialized />}
    </div>
  );
}
