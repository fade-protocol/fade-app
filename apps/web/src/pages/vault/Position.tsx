// One owner in the vault: their position (value, fvUSDC, result) and their open requests with a
// short status each (their history lives in the Dashboard). How a request moves is behind
// the (i) of each status, never in the first line.
import { useState } from "react";
import { ActionButton } from "../../components/Button";
import { InfoTip } from "../../components/disclosure";
import { Tween } from "../../components/motion";
import { Chip, ExplorerTx, FailureBox, Skeleton, type ChipTone } from "../../components/ui";
import { bps, clock, fv, signedAmount, usdc } from "../../lib/format";
import { useChainNow } from "../../lib/hooks";
import { claimDepositInstruction, claimWithdrawInstruction } from "../../lib/lp";
import { closeOnGrid, ownerShareBps, paidProgress, type PendingRequest } from "../../lib/position";
import { send, type ProgramFailure } from "../../lib/tx";
import { ConnectButton } from "../../wallet/ConnectButton";
import {
  about,
  asFailure,
  doneByKeeper,
  isCancelled,
  KEEPER_GRACE_SECONDS,
  type VaultData,
} from "./common";

/** "+1.50" / "−1.50" / "0.00": a result in USDC. */
export const signed = (v: bigint) => signedAmount(v);

/** Asks for notifications: the page tells you when a request is ready while it is in the background. */
export function NotifyButton() {
  const [perm, setPerm] = useState(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  if (perm !== "default") return null;
  return (
    <button
      type="button"
      className="link-btn small"
      onClick={() => void Notification.requestPermission().then(setPerm)}
    >
      Notify me when it is ready
    </button>
  );
}

export type RequestStatus = {
  label: string;
  tone: ChipTone;
  /** Seconds left, while a countdown applies. */
  left: number | null;
  /** 0 to 1 through the wait, when known. */
  progress: number | null;
  /** Whether a claim pays something now. */
  ready: boolean;
  /** The mechanism, for the (i). */
  explain: string;
};

/** A request's status in a word or two, its countdown, and what lies behind it. */
export function requestStatus(r: PendingRequest, data: VaultData, chainNow: number): RequestStatus {
  const length = Number(data.state.config.params.epochLengthSeconds);
  const what = r.kind === "deposit" ? "fvUSDC" : "USDC";
  const waited = r.struckTs === null ? 0 : chainNow - r.struckTs;
  const late = r.phase === "claimable" && waited > KEEPER_GRACE_SECONDS;
  const partReady = r.phase === "rationed" && (r.claimableNow ?? 0n) > 0n;
  const pending = (left: number | null, explain: string): RequestStatus => ({
    label: "Pending",
    tone: "warn",
    left,
    progress: left === null ? null : Math.min(1, Math.max(0, 1 - left / Math.max(1, length))),
    ready: false,
    explain,
  });
  switch (r.phase) {
    case "queued":
      return pending(
        Math.max(0, Number(data.state.queue.current.closeTs) - chainNow),
        `Deposits and withdrawals are priced together at the next close, the same price for every request in it. Your ${what} then arrive in your wallet automatically.`,
      );
    case "awaiting-strike":
      return pending(
        null,
        "The close has passed: its price is set once the draws opened before it are in, usually within a minute.",
      );
    case "next-epoch":
      return pending(
        closeOnGrid(Math.max(chainNow, Number(data.state.queue.current.closeTs)), length) -
          chainNow,
        "This request joins the close after the one in progress, which is priced first.",
      );
    case "claimable":
      return {
        label: "Ready to claim",
        tone: "won",
        left: null,
        progress: 1,
        ready: true,
        explain: late
          ? `Priced ${about(waited)} ago and not delivered yet: claim it yourself, anyone can.`
          : `Priced. Your ${what} are delivered automatically, usually within a minute; claiming it yourself is optional and returns the delivery fee.`,
      };
    case "rationed":
      return {
        label: partReady ? "Part ready to claim" : "Partly paid",
        tone: partReady ? "won" : "warn",
        left: null,
        progress: null,
        ready: partReady,
        explain:
          "Open payouts needed part of the vault's reserve: the close paid part of this withdrawal and the rest waits for the next ones. What is paid can be claimed now.",
      };
    case "parked":
      return {
        label: "Ready to claim",
        tone: "won",
        left: null,
        progress: 1,
        ready: true,
        explain: `Your ${what} account could not receive the delivery. Claiming creates the account if it is missing.`,
      };
  }
}

/** The claim of one request, by the owner: a keeper may get there first, which is fine. */
export function useClaim(r: PendingRequest, data: VaultData) {
  const { signer, requests } = data;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ProgramFailure | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const [raced, setRaced] = useState(false);
  const claim = async () => {
    if (!signer || !requests) return;
    setBusy(true);
    setFailure(null);
    try {
      const ixs =
        r.kind === "deposit" && r.deposit
          ? await claimDepositInstruction(signer, r.deposit)
          : await claimWithdrawInstruction(signer, r.withdraw!, requests.records);
      const s = await send(
        signer,
        ixs,
        r.kind === "deposit" ? "claim_deposit" : "claim_withdraw",
        250_000,
      );
      setSig(s.signature);
      data.refresh();
    } catch (e) {
      const f = asFailure(e);
      if (doneByKeeper(f, "claim")) {
        // the keeper claimed it first: nothing is lost, the request is simply through
        setRaced(true);
        data.refresh();
      } else if (!isCancelled(f)) setFailure(f);
    } finally {
      setBusy(false);
    }
  };
  return { claim, busy, failure, sig, raced, canSign: Boolean(signer) };
}

/** "Deposit of 50.00 USDC" / "Withdrawal of 200.00 fvUSDC". */
export const requestTitle = (r: PendingRequest) =>
  r.kind === "deposit" ? `Deposit of ${usdc(r.amount)} USDC` : `Withdrawal of ${fv(r.amount)}`;

/** A withdrawal paid over several closes: what it received, what a claim pays now, what is queued. */
function PaidBar({ paid, now, total }: { paid: bigint; now: bigint; total: bigint }) {
  const bar = paidProgress(paid, now, total);
  if (!bar) return null;
  return (
    <div className="paid-bar" aria-label="Payment progress">
      <div className="paid-track">
        <span className="paid-done" style={{ width: `${bar.paidPct}%` }} />
        <span className="paid-now" style={{ width: `${bar.nowPct}%` }} />
      </div>
      <p className="small muted mono">
        {usdc(bar.paid)} paid{bar.now > 0n ? `, ${usdc(bar.now)} to claim` : ""}, about{" "}
        {usdc(bar.toCome)} to come
      </p>
    </div>
  );
}

export function RequestRow({ r, data }: { r: PendingRequest; data: VaultData }) {
  const chainNow = useChainNow(data.state);
  const st = requestStatus(r, data, chainNow);
  const c = useClaim(r, data);
  const partReady = r.phase === "rationed" && (r.claimableNow ?? 0n) > 0n;
  const late =
    r.phase === "claimable" && r.struckTs !== null && chainNow - r.struckTs > KEEPER_GRACE_SECONDS;

  return (
    <li className={`req${st.ready ? " req-ready" : ""}`}>
      <div className="req-main">
        <span className={`req-kind req-${r.kind}`} aria-hidden="true">
          {r.kind === "deposit" ? "+" : "−"}
        </span>
        <div className="req-text">
          <p className="req-title">{requestTitle(r)}</p>
          <p className="small muted mono">
            ≈ {usdc(r.value)} USDC
            {r.kind === "deposit" && r.sharesDue !== undefined ? `, ${fv(r.sharesDue)}` : ""}
          </p>
        </div>
        <div className="req-side">
          <span className="req-status label-tip">
            <span className="chip-pop" key={st.label}>
              <Chip tone={st.tone}>{st.label}</Chip>
            </span>
            <InfoTip label="About this status" docs>
              {st.explain}
            </InfoTip>
          </span>
          {st.left !== null && (
            <span className="small mono amber" role="timer" aria-live="off">
              {st.left > 0 ? clock(st.left) : "any moment"}
            </span>
          )}
        </div>
      </div>
      {st.progress !== null && !st.ready && (
        <span className="mini-progress" aria-hidden="true">
          <i style={{ width: `${(st.progress * 100).toFixed(1)}%` }} />
        </span>
      )}
      {r.kind === "withdraw" && r.paid !== undefined && (r.phase === "rationed" || r.paid > 0n) && (
        <PaidBar paid={r.paid} now={r.claimableNow ?? 0n} total={r.value + r.paid} />
      )}
      {st.ready && c.canSign && !c.sig && !c.raced && (
        <div className="req-actions">
          <ActionButton
            type="button"
            className={`btn-small ${late || r.phase === "parked" || partReady ? "btn-primary" : "btn-ghost"}`}
            busy={c.busy}
            busyLabel="Claiming…"
            succeeded={c.sig}
            successLabel="Claimed"
            failed={c.failure}
            onClick={() => void c.claim()}
          >
            {partReady ? `Claim ${usdc(r.claimableNow!)} USDC` : "Claim"}
          </ActionButton>
        </div>
      )}
      {c.sig && (
        <p className="small">
          Claimed <ExplorerTx sig={c.sig} />
        </p>
      )}
      {c.raced && <p className="small muted">Already in your wallet.</p>}
      {c.failure && <FailureBox failure={c.failure} />}
    </li>
  );
}

/** The owner's open requests, newest first. */
export function OpenRequests({ data }: { data: VaultData }) {
  const { pending } = data;
  if (!pending || pending.length === 0) return null;
  return (
    <div className="side-block">
      <div className="side-head">
        <p className="eyebrow-s">In progress</p>
        <NotifyButton />
      </div>
      <ul className="reqs">
        {pending.map((r) => (
          <RequestRow key={r.address} r={r} data={data} />
        ))}
      </ul>
    </div>
  );
}

/** The owner's share of the vault, open withdrawals' escrowed shares included. */
export function vaultShareBps(data: VaultData): bigint | null {
  return ownerShareBps(data.wallet?.shares ?? null, data.pending, data.state.vault.totalShares);
}

/** The position under the deposit card: its value, its result and its fvUSDC. */
export function PositionCard({ data }: { data: VaultData }) {
  const { owner, wallet, summary } = data;
  if (!owner)
    return (
      <div className="side-block position-card">
        <p className="eyebrow-s">Your position</p>
        <p className="small muted">Connect a wallet to see your fvUSDC and what they are worth.</p>
        <ConnectButton />
      </div>
    );
  const h = summary?.history ?? null;
  const reconciled = h !== null && h.unexplainedShares === 0n;
  const share = vaultShareBps(data);
  return (
    <div className="side-block position-card">
      <p className="eyebrow-s">Your position</p>
      <div className="pos-row">
        <span className="pos-value">
          {summary ? <Tween>{usdc(summary.value)}</Tween> : <Skeleton w={110} h={26} inline />}
          <span className="unit"> USDC</span>
        </span>
        {h && reconciled && (
          <span
            className={`mono small ${h.pnl > 0n ? "up" : h.pnl < 0n ? "down" : "muted"} label-tip`}
          >
            <Tween>{signed(h.pnl)}</Tween>
            <InfoTip label="About this result">
              Value, plus open requests and USDC withdrawn, less USDC deposited: from this wallet's
              on-chain history in the vault.
            </InfoTip>
          </span>
        )}
      </div>
      <span className="small muted">
        {wallet ? <Tween>{fv(wallet.shares)}</Tween> : <Skeleton w={80} h={12} inline />}
        {share !== null && wallet && wallet.shares > 0n && (
          <>
            {", "}
            <Tween>{bps(share)}</Tween> of the vault
          </>
        )}
      </span>
      {summary && (summary.pendingIn > 0n || summary.pendingOut > 0n) && (
        <span className="small amber">
          ≈ {usdc(summary.pendingIn + summary.pendingOut)} USDC in progress
        </span>
      )}
    </div>
  );
}
