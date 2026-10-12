import { createNoopSigner, type Address, type TransactionSigner } from "@solana/kit";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { LogoMark } from "../components/Logo";
import type { Draw, Signal } from "../components/Receipt";
import { ActionButton } from "../components/Button";
import { Disclosure, InfoTip } from "../components/disclosure";
import { FAUCET_SOL_BELOW, FAUCET_USDC, FaucetButton } from "../components/FaucetButton";
import { Chip, FailureBox } from "../components/ui";
import { ShareWinButton } from "../components/ShareSheet";
import { FAUCET_URL } from "../lib/config";
import { ata, solBalance, tokenBalance, type ProtocolState } from "../lib/fade";
import { bps, fixed, sol, usdc } from "../lib/format";
import { usePolling } from "../lib/hooks";
import { assetsNeededFor, type Outcome, type Quote } from "../lib/math";
import type { Simulation } from "../lib/tx";
import type { ShareWin } from "../lib/shareWin";
import { findUnfinished, type Ticket } from "../lib/ticket";
import { Link } from "../router";
import { ConnectButton } from "../wallet/ConnectButton";
import { SIM_TICKET } from "./devSimulation";
import { isBusy, isHalved, simulateOpen, type FlowState } from "./useTicketFlow";

export type Live = Extract<ProtocolState, { initialized: true }>;

/**
 * What the receipt shows. It only prints once the open transaction is
 * confirmed (`times.opened`, also the receipt's print key): before that nothing
 * has been paid, so a wallet that declines or a send that fails leaves it at rest.
 */
export function drawOf(s: FlowState, isWin: (outcome: number) => boolean): Draw {
  const opened = s.times.opened !== undefined;
  if (s.phase === "expired") return "expired";
  if (s.result && s.result.outcome >= 0) return isWin(s.result.outcome) ? "won" : "lost";
  if (s.phase === "done") return "settled";
  if (!opened) return "idle";
  if (s.phase === "failed") return "halted";
  return "drawing";
}

/**
 * The printer's light before anything is printed: blinking while the wallet is
 * asked (checking and signing), pulsing while the network confirms the open.
 * Off once the open is confirmed (the receipt prints) or when it fails.
 */
export function signalOf(s: FlowState): Signal {
  if (s.times.opened !== undefined) return null;
  if (s.phase === "checking" || s.phase === "signing") return "sign";
  if (s.phase === "confirming") return "confirm";
  return null;
}

/**
 * Who a simulation runs as: the connected wallet if it has a test USDC
 * account, otherwise the devnet council, which does. A simulation needs no
 * signature, so nothing is asked of anyone.
 */
export async function simulationIdentity(state: Live, signer: TransactionSigner | undefined) {
  if (signer && (await tokenBalance(await ata(signer.address))) !== null)
    return { signer, reference: false };
  return { signer: createNoopSigner(state.config.council), reference: true };
}

/** Not connected yet: what the demo needs, and the button. */
export function ConnectPrompt({ what }: { what: string }) {
  return (
    <div className="empty">
      <div className="empty-art" aria-hidden="true">
        <LogoMark size={40} />
      </div>
      <div className="stack-s">
        <p className="empty-title">Connect a wallet to {what}</p>
        <p className="small muted">Then get free USDC and SOL in one click.</p>
        <ConnectButton />
      </div>
    </div>
  );
}

export type WalletFunds = { usdc: bigint | null; sol: bigint };

/** The connected wallet's test USDC and devnet SOL, re-read after a faucet claim. */
export function useWalletFunds(owner: string | undefined): WalletFunds | null {
  const funds = usePolling(
    async () => {
      if (!owner) return null;
      const a = owner as Address;
      const [usdcBal, lamports] = await Promise.all([tokenBalance(await ata(a)), solBalance(a)]);
      return { usdc: usdcBal, sol: lamports };
    },
    15_000,
    [owner],
  );
  return owner ? funds.data : null;
}

/** What the wallet lacks to open a payout with this ticket, if anything. */
export function missingFunds(funds: WalletFunds | null, ticket: bigint): "usdc" | "sol" | null {
  if (!funds) return null;
  if (funds.usdc === null || funds.usdc < ticket) return "usdc";
  if (funds.sol < FAUCET_SOL_BELOW) return "sol";
  return null;
}

/** Connected but short of test funds: the faucet, right where the button would be. */
export function FundsPrompt({
  missing,
  funds,
  ticket,
}: {
  missing: "usdc" | "sol";
  funds: WalletFunds;
  ticket: bigint;
}) {
  return (
    <div className="empty">
      <div className="empty-art" aria-hidden="true">
        <LogoMark size={40} />
      </div>
      <div className="stack-s">
        <p className="empty-title">
          {missing === "sol"
            ? "This wallet needs a little SOL"
            : funds.usdc === null || funds.usdc === 0n
              ? "This wallet has no USDC yet"
              : `This wallet holds ${usdc(funds.usdc)} USDC, less than the ${usdc(ticket)} ticket`}
        </p>
        <p className="small muted">
          One click sends {usdc(FAUCET_USDC, 0)} USDC, plus a little SOL when the wallet has almost
          none.
        </p>
        <FaucetButton className="btn-primary" />
      </div>
    </div>
  );
}

/** Shown when a transaction failed for lack of SOL: the in-app faucet only tops up nearly empty wallets. */
export function SolFallback({ s }: { s: FlowState }) {
  if (s.phase !== "failed" || !s.failure || !/SOL/.test(s.failure.message)) return null;
  return (
    <p className="small notice-inline">
      The free USDC button adds SOL only to wallets under {sol(FAUCET_SOL_BELOW, 3)} SOL. For more,
      use{" "}
      <a href={FAUCET_URL} target="_blank" rel="noreferrer">
        Solana's free SOL page
      </a>
      .
    </p>
  );
}

/** "One signature.", with what follows and what the wallet pays behind its (i). */
export function OneSignatureNote({ children }: { children?: ReactNode }) {
  return (
    <p className="small muted label-tip">
      {children ?? "One signature."}
      <InfoTip label="What happens after the signature">
        The draw and the payout follow automatically. Your wallet pays the ticket price, in USDC,
        and advances a little SOL for rent and the oracle fee, most of it returned once the draw is
        in.
      </InfoTip>
    </p>
  );
}

/**
 * A demo's win as a share card, once its draw is in; null for anything else (a loss, no draw, a
 * draw still running). The QR code opens the ticket's draw.
 */
export function shareWinOf(
  s: FlowState,
  won: boolean,
  win: Omit<ShareWin, "payout" | "at" | "ticket">,
): ShareWin | null {
  const r = s.result;
  if (!won || s.phase !== "done" || !r || r.outcome < 0 || r.payout <= 0n) return null;
  const ticket = s.ticket ?? (import.meta.env.DEV ? SIM_TICKET : null);
  if (!ticket) return null;
  return { ...win, payout: r.payout, at: new Date(s.times.done ?? Date.now()), ticket };
}

/** The result, in words, once the payout has ended; a win carries "Share my win". */
export function ResultBanner({
  s,
  won,
  wonText,
  lostText,
  share = null,
}: {
  s: FlowState;
  won: boolean;
  wonText: ReactNode;
  lostText: ReactNode;
  share?: ShareWin | null;
}) {
  if (s.phase === "expired")
    return (
      <div className="result result-expired rise" role="status">
        <p className="result-title">Expired</p>
        <p className="small">
          No draw in time: the ticket stays with the vault. Nothing else moved.
        </p>
      </div>
    );
  if (s.phase !== "done" || !s.result) return null;
  if (s.result.outcome < 0)
    return (
      <div className="result rise" role="status">
        <p className="result-title">Drawn</p>
        <p className="small">The result is in the draw transaction below.</p>
      </div>
    );
  return (
    <div className={`result rise ${won ? "result-won" : "result-lost"}`} role="status">
      <div className="result-share">
        <p className="result-title">{won ? wonText : lostText}</p>
        {won && <ShareWinButton win={share} />}
      </div>
      {s.result.pending && (
        <p className="small">
          The payout waits in escrow: this wallet could not receive it directly. It can be claimed.
        </p>
      )}
    </div>
  );
}

export type HistoryItem = { demo: string; won: boolean; payout: string; at: number };

const HISTORY_KEY = "fade.draws";

function readHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? (JSON.parse(raw) as HistoryItem[]) : [];
    return Array.isArray(list) ? list.slice(0, 8) : [];
  } catch {
    return [];
  }
}

/** This browser's recent results, for a light sense of progress. Never needed for anything. */
export function useDrawHistory() {
  const [list, setList] = useState<HistoryItem[]>(readHistory);
  useEffect(() => {
    const on = () => setList(readHistory());
    window.addEventListener("fade:draws", on);
    return () => window.removeEventListener("fade:draws", on);
  }, []);
  const add = useCallback((item: HistoryItem) => {
    const next = [item, ...readHistory()].slice(0, 8);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // private mode: the history simply is not kept
    }
    setList(next);
    window.dispatchEvent(new Event("fade:draws"));
  }, []);
  return { list, add };
}

/** Records a finished payout once. */
export function useRecordResult(s: FlowState, demo: string, won: (outcome: number) => boolean) {
  const { add } = useDrawHistory();
  const sig = s.phase === "done" ? (s.result?.sig ?? s.ticket) : null;
  useEffect(() => {
    if (!sig || !s.result || s.result.outcome < 0) return;
    add({
      demo,
      won: won(s.result.outcome),
      payout: usdc(s.result.payout),
      at: Date.now(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}

export function SimulateButton({
  state,
  signer,
  outcomes,
  price,
  appShareBps,
  label,
}: {
  state: Live;
  signer: TransactionSigner | undefined;
  outcomes: readonly Outcome[];
  price: bigint;
  appShareBps: bigint;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    sim: Simulation;
    who: Address;
    reference: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stack-s">
      <ActionButton
        type="button"
        className="btn-outline"
        busy={busy}
        busyLabel="Asking the program…"
        failed={error}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setResult(null);
          try {
            const id = await simulationIdentity(state, signer);
            const { sim } = await simulateOpen({
              who: id.signer,
              state,
              outcomes,
              price,
              appShareBps,
            });
            if (!sim) throw new Error("no USDC account to simulate from");
            setResult({ sim, who: id.signer.address, reference: id.reference });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {label}
      </ActionButton>
      {error && <p className="error small">{error}</p>}
      {result &&
        (result.sim.ok ? (
          <div className="accepted rise" role="status">
            <p className="stamp stamp-ok">Accepted</p>
            <p className="small">The vault can carry this payout right now.</p>
          </div>
        ) : (
          <div className="refused rise">
            <p className="stamp stamp-refused" aria-hidden="true">
              Refused
            </p>
            <FailureBox failure={result.sim.failure} />
          </div>
        ))}
      {result && (
        <p className="small muted">
          Simulated as {result.reference ? "the Fade team's account" : "your wallet"}. Nothing was
          sent.
        </p>
      )}
    </div>
  );
}

/** Shown when the vault's per-payout cap is below this payout's worst case. */
export function CapNotice({ state, q }: { state: Live; q: Quote }) {
  if (q.cap === null || q.vaultMarginBps === null) return null;
  const vault = {
    assets: state.vault.totalAssets,
    reserved: state.vault.totalReservedLiability,
    openCredits: state.vault.openVaultCredits,
  };
  const need = assetsNeededFor(
    q.liability,
    q.vaultMarginBps,
    state.config.params,
    vault,
    isHalved(state),
  );
  return (
    <div className="notice notice-cap rise">
      <p className="notice-title">The vault cannot carry this payout yet</p>
      <p className="small">
        It may risk <span className="mono">{usdc(q.cap)}</span> on one payout; this one needs{" "}
        <span className="mono">{usdc(q.liability)}</span> USDC.
      </p>
      <Disclosure summary="Why">
        <p>
          If the draw is won, the vault owes <span className="mono">{usdc(q.liability)}</span> USDC
          beyond the ticket price it received. Today it may risk at most{" "}
          <span className="mono">{usdc(q.cap)}</span> on one payout: the smaller of{" "}
          <span className="mono">{bps(state.config.params.censorshipBps)}</span> of its assets and
          half the Kelly bound at a <span className="mono">{bps(q.vaultMarginBps)}</span> vault
          margin.
        </p>
        <p>
          A vault of about{" "}
          <span className="mono">
            {fixed(((need + 99_999_999n) / 100_000_000n) * 100_000_000n, 6, 0)}
          </span>{" "}
          USDC carries it. The program refuses rather than accept a payout it might have to cut.
          Anyone can add to the vault: <Link to="/vault">see the vault</Link>.
        </p>
      </Disclosure>
    </div>
  );
}

/** Tickets this wallet left mid-way (a closed tab, a declined signature): offer to finish them. */
export function useUnfinished(owner: string | undefined, refreshKey: unknown) {
  const [list, setList] = useState<{ ticket: Address; data: Ticket }[]>([]);
  useEffect(() => {
    let alive = true;
    if (!owner) {
      setList([]);
      return;
    }
    findUnfinished(owner as Address)
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [owner, refreshKey]);
  return list;
}

/** Offers to pick up a payout this wallet opened and left mid-way. */
export function ResumeNotice({
  owner,
  s,
  onResume,
}: {
  owner: string | undefined;
  s: FlowState;
  onResume: (ticket: Address) => void;
}) {
  const list = useUnfinished(owner, s.phase);
  const first = list[0];
  if (!first || s.phase !== "idle" || isBusy(s)) return null;
  return (
    <div className="notice rise">
      <p className="notice-title">A payout of yours is waiting</p>
      <p className="small">
        {first.data.status === 0
          ? "Opened but not drawn: pick it up within about a minute of the open."
          : "Its draw is requested: pick it up to see its result."}
      </p>
      <button
        type="button"
        className="btn btn-outline btn-small"
        onClick={() => onResume(first.ticket)}
      >
        Pick it up
      </button>
    </div>
  );
}
