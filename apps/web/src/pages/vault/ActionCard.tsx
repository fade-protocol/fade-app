// The vault's action card: Deposit / Withdraw, one signature each. The keeper
// strikes the epoch and claims the request; the card shows a short status and
// keeps the mechanism behind its (i).
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ActionButton } from "../../components/Button";
import { Collapse, InfoTip } from "../../components/disclosure";
import {
  AnimatedHeight,
  Indicator,
  Tween,
  enterStyle,
  useDirection,
  useSlidingIndicator,
} from "../../components/motion";
import { ExplorerTx, FailureBox, Skeleton } from "../../components/ui";
import { FAUCET_SOL_BELOW, FaucetButton } from "../../components/FaucetButton";
import { FAUCET_URL } from "../../lib/config";
import { joiningEpochId, type Queue } from "../../lib/fade";
import { useChainNow } from "../../lib/hooks";
import {
  TX_FEE,
  projectedPerYear,
  requestAmount,
  requestFees,
  type Side,
} from "../../lib/actionQuote";
import { clock, fv, sol, usdc } from "../../lib/format";
import { requestDepositInstruction, requestWithdrawInstruction } from "../../lib/lp";
import { settleEta, type PendingRequest } from "../../lib/position";
import { valueOf } from "../../lib/providers";
import { availableNow } from "../../lib/vaultFigures";
import type { Signature } from "@solana/kit";
import { send, signatureStatus, TxError, type ProgramFailure } from "../../lib/tx";
import { ConnectButton } from "../../wallet/ConnectButton";
import { asFailure, epochMoved, isCancelled, type VaultData } from "./common";

const QUICK = [25, 50, 75, 100] as const;
/** The config's pause bit for deposits (programs/fade/src/state.rs `PAUSE_DEPOSITS`). */
const PAUSE_DEPOSITS = 1 << 1;
/** How long "delivered" stays on the card once the request is through. */
const SETTLED_MS = 8000;
/** How long a request sent but not confirmed in time is followed before the card gives up. */
const CONFIRM_WAIT_MS = 2 * 60_000;
/** Under this many seconds to the close, a request may land in the next epoch. */
const NEAR_CLOSE_S = 20;
const SIDES = ["deposit", "withdraw"] as const;

/** Where the card's own request is: a short status, a countdown while one applies, and the why. */
function requestNote(
  done: { side: Side; epoch: bigint; settled?: boolean },
  phase: PendingRequest["phase"] | undefined,
  queue: Queue,
  chainNow: number,
): { status: string; left: number | null; explain: string } {
  const what = done.side === "deposit" ? "fvUSDC" : "USDC";
  if (done.settled)
    return { status: `In your wallet`, left: null, explain: `Your ${what} reached your wallet.` };
  switch (phase) {
    case "claimable":
      return {
        status: "On its way",
        left: null,
        explain: `Priced: your ${what} are delivered automatically, usually within a minute.`,
      };
    case "rationed":
      return {
        status: "Partly paid",
        left: null,
        explain:
          "Open payouts needed part of the reserve: part of it is paid, the rest waits for the next close.",
      };
    case "parked":
      return {
        status: "Ready to claim",
        left: null,
        explain: `Your ${what} could not be delivered to your wallet: claim them to receive them.`,
      };
    default:
      break;
  }
  const cur = queue.current;
  const explain =
    "Deposits and withdrawals are priced together at the next close, the same price for every request in it, once the draws opened before it are in. The result then arrives in your wallet automatically.";
  if (cur.live && cur.epochId === done.epoch) {
    const left = Number(cur.closeTs) - chainNow;
    return { status: "Pending", left: left > 0 ? left : null, explain };
  }
  return { status: "Pending", left: null, explain };
}

export function ActionCard({
  data,
  side,
  onSide,
  aprPct,
}: {
  data: VaultData;
  side: Side;
  onSide: (s: Side) => void;
  /** The vault's APR in percent, when there is enough data for one. */
  aprPct: number | null;
}) {
  const { state, wallet, signer, pending, fund } = data;
  const { vault, queue, config } = state;
  const p = config.params;
  const [text, setText] = useState("");
  const [pctPick, setPctPick] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ProgramFailure | null>(null);
  const [cancelled, setCancelled] = useState(false);
  /** A first request asks for a second click: requests cannot be cancelled. */
  const [armed, setArmed] = useState(false);
  const [confirming, setConfirming] = useState<{
    sig: string;
    epoch: bigint;
    since: number;
  } | null>(null);
  const [done, setDone] = useState<{
    side: Side;
    sig: string;
    epoch: bigint;
    settled?: boolean;
  } | null>(null);
  const chainNow = useChainNow(state);

  const [feesOpen, setFeesOpen] = useState(false);
  const feesId = useId();
  const tabRow = useRef<HTMLDivElement>(null);
  const quickRow = useRef<HTMLDivElement>(null);
  useSlidingIndicator(tabRow, side);
  useSlidingIndicator(quickRow, `${side}${pctPick}`);
  const dir = useDirection(SIDES.indexOf(side));

  const switchSide = (s: Side) => {
    onSide(s);
    setText("");
    setPctPick(null);
    setFailure(null);
    setArmed(false);
  };

  const usdcBal = wallet?.usdc ?? 0n;
  const shareBal = wallet?.shares ?? 0n;
  const joining = joiningEpochId(queue, BigInt(chainNow));
  const eta = settleEta(queue, p, chainNow);

  // The request this card made, followed until it is through: queued, struck, then delivered.
  const mine = done
    ? (pending ?? []).find((r) => r.kind === done.side && r.epochId === done.epoch)
    : undefined;
  const seen = useRef(false);
  if (mine) seen.current = true;
  const epochOpen =
    done !== null &&
    ((queue.current.live && queue.current.epochId === done.epoch) ||
      (queue.next.live && queue.next.epochId === done.epoch));
  const through =
    done !== null && !done.settled && pending !== null && !mine && (seen.current || !epochOpen);
  useEffect(() => {
    if (through) setDone((d) => (d ? { ...d, settled: true } : d));
  }, [through]);
  useEffect(() => {
    if (!done?.settled) return;
    const t = setTimeout(() => setDone(null), SETTLED_MS);
    return () => clearTimeout(t);
  }, [done?.settled]);

  // --- the amount ----------------------------------------------------------------
  // deposit: micro-USDC in, shares out; withdraw: shares in, micro-USDC out
  const { amount, estimate } = requestAmount({
    side,
    pct: pctPick,
    text,
    usdcBalance: usdcBal,
    shareBalance: shareBal,
    vault,
  });

  // a confirmation stands for the amount it was given for
  const amountKey = `${side}:${amount ?? ""}`;
  useEffect(() => setArmed(false), [amountKey]);

  const minDeposit = vault.totalShares === 0n ? p.minFirstDeposit : p.minDeposit;
  let problem: string | null = null;
  const depositsPaused = (config.pauseFlags & PAUSE_DEPOSITS) !== 0;
  if (side === "deposit" && depositsPaused) problem = "Deposits are paused";
  else if (amount === null || amount === 0n) problem = "Enter an amount";
  else if (side === "deposit") {
    if (amount < minDeposit) problem = `Minimum ${usdc(minDeposit)} USDC`;
    else if (wallet && amount > usdcBal) problem = "Not enough USDC";
  } else if (amount > shareBal) problem = "More than your position";
  else if (amount < p.minWithdrawShares && amount !== shareBal)
    problem = `Minimum ${fv(p.minWithdrawShares)}, or everything`;

  // --- the fees -------------------------------------------------------------------
  const hasRequest = (pending ?? []).some(
    (r) => r.kind === side && r.epochId === joining && r.phase !== "parked",
  );
  // the request creates the owner's share account (deposit) or USDC account (withdrawal) if missing
  const { claimFee, strikeFee, rent, tokenRent, fees, needed } = requestFees({
    side,
    params: p,
    hasRequest,
    fund,
    createsTokenAccount:
      wallet !== null &&
      ((side === "deposit" && !wallet.hasShareAccount) ||
        (side === "withdraw" && !wallet.hasUsdcAccount)),
  });
  const closesIn = queue.current.live ? Number(queue.current.closeTs) - chainNow : null;
  const nearClose = closesIn !== null && closesIn > 0 && closesIn < NEAR_CLOSE_S ? closesIn : null;
  const solNeeded = needed;
  const lowSol = wallet !== null && wallet.sol < solNeeded;
  // The faucet covers both: 1,000 test USDC, and SOL for a nearly empty wallet.
  const needUsdc = side === "deposit" && wallet !== null && (wallet.usdc ?? 0n) < minDeposit;
  const nothingToWithdraw = side === "withdraw" && wallet !== null && shareBal === 0n;
  const faucetSol =
    lowSol && !nothingToWithdraw && wallet !== null && wallet.sol < FAUCET_SOL_BELOW;

  const accepted = (sig: string, epoch: bigint) => {
    seen.current = false;
    setDone({ side, sig, epoch });
    setText("");
    setPctPick(null);
    data.refresh();
  };

  // this wallet has never made a request: the first one asks for a confirmation
  const firstRequest =
    data.ownerLog !== null &&
    (pending ?? []).length === 0 &&
    !data.ownerLog.some((i) =>
      i.events.some((e) => e.kind === "DepositRequested" || e.kind === "WithdrawRequested"),
    );

  // what a strike can pay out now, with the live epoch's deposits (fade-math `risk::withdrawable`)
  const outNow = availableNow(state);
  const yearly = projectedPerYear(amount, aprPct);

  const submit = async () => {
    if (!signer || amount === null || problem || confirming) return;
    if (firstRequest && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setBusy(true);
    setFailure(null);
    setCancelled(false);
    const label = side === "deposit" ? "request_deposit" : "request_withdraw";
    const build = () =>
      side === "deposit"
        ? requestDepositInstruction(signer, queue, amount)
        : requestWithdrawInstruction(signer, queue, amount);
    let built = await build().catch((e: unknown) => {
      setFailure(asFailure(e));
      return null;
    });
    try {
      if (!built) return;
      let s;
      try {
        s = await send(signer, [built.ix], label, 250_000);
      } catch (e) {
        // the epoch closed (or was struck) while the wallet was open: the request now joins
        // another epoch, whose account the instruction did not name. Build it again, once.
        if (!(e instanceof TxError) || !epochMoved(e.failure)) throw e;
        built = await build();
        s = await send(signer, [built.ix], label, 250_000);
      }
      accepted(s.signature, built.epochId);
    } catch (e) {
      if (e instanceof TxError && e.pending && built) {
        // sent, not confirmed in time: it may still land. Never let it be sent twice.
        setConfirming({ sig: e.pending, epoch: built.epochId, since: Date.now() });
        data.refresh();
        return;
      }
      const f = asFailure(e);
      if (isCancelled(f)) setCancelled(true);
      else setFailure(f);
    } finally {
      setBusy(false);
    }
  };

  // A request sent but not confirmed in time: follow its signature until it lands or fails.
  useEffect(() => {
    if (!confirming) return;
    let alive = true;
    const t = setInterval(() => {
      void signatureStatus(confirming.sig as Signature).then((st) => {
        if (!alive) return;
        if (st.state === "landed") {
          setConfirming(null);
          accepted(confirming.sig, confirming.epoch);
        } else if (st.state === "failed") {
          setConfirming(null);
          setFailure(st.failure);
        } else if (Date.now() - confirming.since > CONFIRM_WAIT_MS) {
          setConfirming(null);
          setFailure({
            code: null,
            name: null,
            message:
              "still not confirmed after a few minutes. Check it on the explorer before sending another request.",
            logs: [],
          });
        }
      });
    }, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming]);

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + SIDES.length) % SIDES.length;
    switchSide(SIDES[j]!);
    tabRow.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[j]?.focus();
  };
  const loadingWallet = data.owner !== undefined && wallet === null;
  const note = done ? requestNote(done, mine?.phase, queue, chainNow) : null;

  return (
    <div className="card action-card">
      <div
        className="action-tabs has-ind"
        role="tablist"
        aria-label="Deposit or withdraw"
        ref={tabRow}
      >
        <Indicator />
        {SIDES.map((s, i) => (
          <button
            key={s}
            type="button"
            role="tab"
            id={`action-tab-${s}`}
            aria-selected={side === s}
            aria-controls="action-panel"
            tabIndex={side === s ? 0 : -1}
            className="action-tab"
            onClick={() => switchSide(s)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {s === "deposit" ? "Deposit" : "Withdraw"}
          </button>
        ))}
      </div>

      <form
        id="action-panel"
        role="tabpanel"
        aria-labelledby={`action-tab-${side}`}
        className="action-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <AnimatedHeight>
          <div className="action-body enter" key={side} style={enterStyle(dir)}>
            <div className="amount-box">
              <div className="amount-top">
                <label htmlFor="action-amount" className="amount-label">
                  {side === "deposit" ? "You deposit" : "You withdraw"}
                </label>
                <span className="small muted">
                  {side === "deposit" ? "Wallet " : "Position "}
                  <span className="mono">
                    {loadingWallet ? (
                      <Skeleton w={64} h={12} inline />
                    ) : !wallet ? (
                      "–"
                    ) : (
                      <Tween>
                        {side === "deposit"
                          ? wallet.usdc === null
                            ? "0.00"
                            : usdc(wallet.usdc)
                          : usdc(valueOf(shareBal, vault))}
                      </Tween>
                    )}
                  </span>{" "}
                  USDC
                </span>
              </div>
              <div className="amount-row">
                <input
                  id="action-amount"
                  className="amount-input mono"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={
                    pctPick !== null && amount !== null
                      ? side === "deposit"
                        ? usdc(amount, 6)
                            .replace(/,/g, "")
                            .replace(/\.?0+$/, "")
                        : usdc(valueOf(amount, vault)).replace(/,/g, "")
                      : text
                  }
                  onChange={(e) => {
                    setPctPick(null);
                    setText(e.target.value.replace(/,/g, "."));
                  }}
                  aria-describedby="action-preview"
                />
                <span className="token-tag">
                  <span className="token-dot" aria-hidden="true" />
                  USDC
                </span>
              </div>
              <div
                className="quick has-ind"
                role="group"
                aria-label="Share of your balance"
                ref={quickRow}
              >
                <Indicator />
                {QUICK.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className={`preset${pctPick === q ? " on" : ""}`}
                    aria-pressed={pctPick === q}
                    disabled={!wallet || (side === "deposit" ? usdcBal === 0n : shareBal === 0n)}
                    onClick={() => setPctPick(q)}
                  >
                    {q === 100 ? "Max" : `${q} %`}
                  </button>
                ))}
              </div>
            </div>

            <dl className="kv action-kv" id="action-preview">
              <dt className="label-tip">
                {side === "deposit" ? "You receive" : "You redeem"}
                <InfoTip label="How the price is set" docs>
                  {side === "deposit" ? "fvUSDC are priced" : "USDC is priced"} at the next close,
                  the same price for every request in it. These figures use today's share price.
                </InfoTip>
              </dt>
              <dd className="mono">
                <Tween>
                  {side === "deposit"
                    ? estimate !== null && amount
                      ? `≈ ${fv(estimate)}`
                      : "–"
                    : amount
                      ? fv(amount)
                      : "–"}
                </Tween>
              </dd>
              {side === "withdraw" && (
                <>
                  <dt>You receive</dt>
                  <dd className="mono">
                    <Tween>{estimate !== null && amount ? `≈ ${usdc(estimate)} USDC` : "–"}</Tween>
                  </dd>
                </>
              )}
              <dt className="label-tip">
                Ready in
                <InfoTip label="When it arrives" docs>
                  Deposits and withdrawals are priced together at the next close, then the{" "}
                  {side === "deposit" ? "fvUSDC" : "USDC"} arrive in your wallet automatically.
                  {side === "withdraw"
                    ? ` The next close can pay out ${usdc(outNow)} USDC now, while open payouts keep their reserve; a larger withdrawal is paid in parts.`
                    : ""}
                </InfoTip>
              </dt>
              <dd className="mono">{clock(eta)}</dd>
              {side === "deposit" && (
                <>
                  <dt className="label-tip">
                    Projected per year
                    <InfoTip label="About this projection" docs>
                      Your deposit at the vault's APR: the vault margin earned on the tickets of the
                      last 7 days, annualised. Past activity, not a forecast: results move with
                      volume and the luck of the draws.
                    </InfoTip>
                  </dt>
                  <dd className="mono up">
                    {yearly === null ? "–" : <Tween>{`≈ +${usdc(yearly)} USDC`}</Tween>}
                  </dd>
                </>
              )}
            </dl>
            {side === "withdraw" &&
              estimate !== null &&
              amount !== null &&
              amount > 0n &&
              estimate > outNow && (
                <p className="small notice-inline">
                  Paid in parts: more than {usdc(outNow)} USDC is available after the next ones.
                </p>
              )}
            <div className={`fees${feesOpen ? " is-open" : ""}`}>
              <button
                type="button"
                className="fees-row"
                aria-expanded={feesOpen}
                aria-controls={feesId}
                onClick={() => setFeesOpen((o) => !o)}
              >
                <span className="fees-label">
                  Fees <span className="chev" aria-hidden="true" />
                </span>
                <span className="mono">
                  ≈ <Tween>{sol(fees)}</Tween> SOL
                </span>
              </button>
              <Collapse open={feesOpen} id={feesId}>
                <dl className="kv action-kv fees-kv">
                  <dt>Delivery fee</dt>
                  <dd className="mono">
                    {claimFee === 0n ? "already paid" : `${sol(claimFee)} SOL`}
                  </dd>
                  <dt>Pricing fee</dt>
                  <dd className="mono">
                    {strikeFee === 0n ? "none, fund full" : `${sol(strikeFee)} SOL`}
                  </dd>
                  <dt>Network fee</dt>
                  <dd className="mono">{sol(TX_FEE, 5)} SOL</dd>
                  {rent > 0n && (
                    <>
                      <dt>Request account</dt>
                      <dd className="mono">{sol(rent)} SOL, returned at delivery</dd>
                    </>
                  )}
                  {tokenRent > 0n && (
                    <>
                      <dt>{side === "deposit" ? "Share account" : "USDC account"}</dt>
                      <dd className="mono">{sol(tokenRent)} SOL, once</dd>
                    </>
                  )}
                </dl>
              </Collapse>
            </div>
          </div>
        </AnimatedHeight>

        {signer && wallet && needUsdc ? (
          <div className="action-connect">
            <p className="small muted">
              {(wallet.usdc ?? 0n) === 0n
                ? "This wallet holds no USDC yet."
                : `This wallet holds less than the ${usdc(minDeposit)} USDC minimum deposit.`}
            </p>
            <FaucetButton className="btn-primary btn-large btn-block" />
          </div>
        ) : signer ? (
          <ActionButton
            type="submit"
            className="btn-primary btn-large btn-block"
            busy={busy || confirming !== null}
            busyLabel={confirming ? "Confirming" : "Approve in your wallet"}
            succeeded={done?.sig}
            successLabel={done?.side === "withdraw" ? "Withdrawal requested" : "Deposit requested"}
            failed={failure}
            disabled={problem !== null || confirming !== null}
          >
            {problem ??
              (armed
                ? "Confirm: a request cannot be cancelled"
                : side === "deposit"
                  ? `Deposit ${usdc(amount ?? 0n)} USDC`
                  : `Withdraw ${fv(amount ?? 0n)}`)}
          </ActionButton>
        ) : (
          <div className="action-connect">
            <p className="small muted">Connect a wallet to {side}.</p>
            <ConnectButton size="large" />
          </div>
        )}

        <p className="action-note small">
          {side === "deposit"
            ? "You take the other side of every payout: the value can go down."
            : "A request cannot be cancelled."}
        </p>
        {side === "deposit" && depositsPaused && (
          <p className="small notice-inline">
            Deposits are paused by governance. Withdrawals are never paused.
          </p>
        )}
        {signer && !needUsdc && faucetSol && (
          <p className="small notice-inline">
            This needs about {sol(solNeeded)} SOL. <FaucetButton />
          </p>
        )}
        {signer && lowSol && !faucetSol && !nothingToWithdraw && (
          <p className="small notice-inline">
            This needs about {sol(solNeeded)} SOL. The free USDC button adds SOL only to wallets
            under {sol(FAUCET_SOL_BELOW, 3)} SOL: get more from{" "}
            <a href={FAUCET_URL} target="_blank" rel="noreferrer">
              Solana's free SOL page
            </a>
            .
          </p>
        )}
        {nothingToWithdraw && (
          <p className="small muted">
            No fvUSDC yet.{" "}
            <button type="button" className="link-btn" onClick={() => switchSide("deposit")}>
              Deposit first
            </button>
          </p>
        )}
        {failure && <FailureBox failure={failure} />}
        {cancelled && <p className="small muted">Signature cancelled: nothing was sent.</p>}
        {confirming && (
          <p className="small notice-inline" role="status">
            Sent, not confirmed yet <ExplorerTx sig={confirming.sig} />. The card waits for it
            before you can send another request.
          </p>
        )}
        {nearClose !== null && !done && !confirming && (
          <p className="small muted label-tip">
            Next close in {nearClose} s
            <InfoTip label="About the close" docs>
              If the close passes before you sign, the request is priced at the one after it.
            </InfoTip>
          </p>
        )}
        {done && note && (
          <div className="accepted rise" role="status">
            <p className="notice-title label-tip">
              {done.side === "deposit" ? "Deposit" : "Withdrawal"} {note.status.toLowerCase()}
              {note.left !== null && <span className="mono amber">{clock(note.left)}</span>}
              <InfoTip label="About this status" docs>
                {note.explain}
              </InfoTip>
            </p>
            <p className="small muted">
              <ExplorerTx sig={done.sig}>Transaction</ExplorerTx>
            </p>
          </div>
        )}
      </form>
    </div>
  );
}
