// "Get free USDC": one click sends 1,000 test USDC from the keeper's faucet to
// the connected wallet (and a little devnet SOL if it has almost none). Without
// a wallet, the click opens the wallet picker and the claim follows as soon as
// a wallet connects. The faucet allows one claim every 5 minutes; the app
// remembers the next allowed time so it does not even ask before then.
import { useCallback, useEffect, useRef, useState } from "react";
import { claimFaucet } from "../lib/keeper";
import { usdc } from "../lib/format";
import { refreshAll } from "../lib/hooks";
import { useWallet } from "../wallet/WalletProvider";
import { ActionButton } from "./Button";

/** What one claim sends, in micro-USDC. */
export const FAUCET_USDC = 1_000_000_000n;
/** One claim per wallet (and per connection) this often, as the faucet enforces. */
const CLAIM_EVERY_MS = 5 * 60_000;
/** The faucet adds devnet SOL only to wallets holding less than this (lamports). */
export const FAUCET_SOL_BELOW = 5_000_000n;

const storageKey = (owner: string) => `fade:faucet-next:${owner}`;
/** How long after the click a newly connected wallet still gets the claim it asked for. */
const CLAIM_ON_CONNECT_MS = 2 * 60_000;
/** The longest wait the app remembers; the faucet still refuses, with its reason, if needed. */
const MAX_REMEMBERED_WAIT_MS = 60 * 60_000;

/** When this wallet may claim free USDC again (ms since the epoch), as this browser remembers it. */
export function readNext(owner: string | undefined): number {
  if (!owner) return 0;
  try {
    const at = Number(localStorage.getItem(storageKey(owner)) ?? 0) || 0;
    // A wait longer than any per-wallet refusal is stale (an older rule): ask again.
    return at > Date.now() + MAX_REMEMBERED_WAIT_MS ? 0 : at;
  } catch {
    return 0;
  }
}

function writeNext(owner: string, at: number): void {
  try {
    localStorage.setItem(storageKey(owner), String(at));
  } catch {
    // private mode: the faucet still refuses a second claim on its side
  }
}

/** The faucet's refusal as a sentence: "this wallet already claimed today" → "This wallet already claimed today." */
const sentence = (s: string) => {
  const t = s.trim();
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}`;
};

function timeUntil(at: number): string {
  const s = Math.max(1, Math.ceil((at - Date.now()) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.ceil(m / 60)} h`;
}

export function FaucetButton({ className = "btn-ghost btn-small" }: { className?: string }) {
  const wallet = useWallet();
  const owner = wallet.account?.address;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState(() => readNext(owner));
  /** When a click had to connect a wallet first: claim if one connects soon after. */
  const claimOnConnect = useRef(0);

  const claim = useCallback(async (to: NonNullable<typeof owner>) => {
    if (readNext(to) > Date.now()) return;
    setBusy(true);
    setError(null);
    const res = await claimFaucet(to);
    setBusy(false);
    if (res.ok) {
      const at = Date.now() + CLAIM_EVERY_MS;
      writeNext(to, at);
      setNext(at);
      setDone(res.signature);
      // The transfer lands within seconds: read balances again, then once more.
      setTimeout(refreshAll, 2_500);
      setTimeout(refreshAll, 8_000);
    } else {
      if (res.retryAt) {
        writeNext(to, res.retryAt);
        setNext(res.retryAt);
      }
      setError(res.error);
    }
  }, []);

  useEffect(() => {
    setNext(readNext(owner));
    setError(null);
    if (owner && Date.now() - claimOnConnect.current < CLAIM_ON_CONNECT_MS) {
      claimOnConnect.current = 0;
      void claim(owner);
    }
  }, [owner, claim]);

  // While waiting, re-render so the countdown moves and the button comes back on time.
  const [, setTick] = useState(0);
  const waitingUntil = owner && next > Date.now() ? next : 0;
  useEffect(() => {
    if (!waitingUntil) return;
    const t = setInterval(() => {
      setTick((n) => n + 1);
      if (Date.now() >= waitingUntil) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [waitingUntil]);

  if (!owner)
    return (
      <button
        type="button"
        className={`btn ${className}`}
        onClick={() => {
          claimOnConnect.current = Date.now();
          wallet.connect();
        }}
      >
        Get free USDC
      </button>
    );

  const waiting = next > Date.now();

  return (
    <span className="faucet">
      <ActionButton
        type="button"
        className={className}
        busy={busy}
        busyLabel="Sending…"
        succeeded={done}
        successLabel={`${usdc(FAUCET_USDC, 0)} USDC sent`}
        failed={error}
        disabled={waiting && !done}
        title={waiting ? `One claim every 5 minutes. Next in ${timeUntil(next)}.` : undefined}
        onClick={() => void claim(owner)}
      >
        {waiting ? `Next claim in ${timeUntil(next)}` : "Get free USDC"}
      </ActionButton>
      {error && (
        <span className="faucet-error small" role="alert">
          {sentence(error)}
        </span>
      )}
    </span>
  );
}
