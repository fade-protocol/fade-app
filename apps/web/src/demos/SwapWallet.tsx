// The swap demo's wallet: a mock swap screen that holds every control of the
// demo (amount, ticket, swap) and shows the payout the way a wallet would, with
// a Lucky draw row, a toast once the swap lands and a full-screen result. The
// signature itself goes to the user's real wallet.
import { useEffect, useState, type ReactNode } from "react";
import { ShareWinButton } from "../components/ShareSheet";
import { short, usdc } from "../lib/format";
import type { ShareWin } from "../lib/shareWin";
import { isBusy, type FlowState } from "./useTicketFlow";

export type TicketOption = { value: bigint; oneIn: string; pct: string; best: boolean };

const ICONS = {
  home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  swap: "M7 4v14M3 14l4 4 4-4M17 20V6M13 10l4-4 4 4",
  activity: "M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17zM12 7v5l3 2",
  search: "M11 4.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13zM16 16l4 4",
};

export function SwapWallet({
  s,
  solPrice,
  address,
  input,
  onInput,
  locked,
  presets,
  out,
  help,
  options,
  price,
  onTicket,
  cta,
  canSwap,
  onSwap,
  resume,
  onDone,
  share,
}: {
  s: FlowState;
  /** Micro-USDC per SOL, the indicative price of the swap. */
  solPrice: bigint;
  address: string | undefined;
  input: string;
  onInput: (value: string) => void;
  locked: boolean;
  presets: { label: string; on: boolean; disabled: boolean }[];
  /** The trade's value in USDC: what the swap receives, and what a win pays back. */
  out: bigint | null;
  help: ReactNode;
  options: TicketOption[];
  price: bigint;
  onTicket: (ticket: bigint) => void;
  /** Replaces the swap button: connect a wallet, or get test funds. */
  cta: ReactNode;
  canSwap: boolean;
  onSwap: () => void;
  resume: ReactNode;
  onDone: () => void;
  /** A win as a share card; null for anything else. */
  share: ShareWin | null;
}) {
  const [sheet, setSheet] = useState<"tickets" | "odds" | null>(null);
  const [toast, setToast] = useState(false);
  // "Done": the result slides away, then the flow resets and the swap screen fades back in.
  const [leaving, setLeaving] = useState(false);
  const [round, setRound] = useState(0);
  const close = () => {
    if (leaving) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setRound((r) => r + 1);
      onDone();
    } else setLeaving(true);
  };
  const closed = () => {
    if (!leaving) return;
    setLeaving(false);
    setRound((r) => r + 1);
    onDone();
  };
  const busy = isBusy(s);
  const opened = s.times.opened;
  const current = options.find((o) => o.value === price);

  // One toast per swap, when the open lands.
  useEffect(() => {
    if (!opened) return;
    setToast(true);
    const t = setTimeout(() => setToast(false), 2500);
    return () => clearTimeout(t);
  }, [opened]);
  useEffect(() => {
    if (busy) setSheet(null);
  }, [busy]);

  const drawing = s.phase === "drawing";
  const ended = s.phase === "done" || s.phase === "expired";
  const showForm = !drawing && !ended;
  const won = s.result !== null && s.result.outcome === 0;

  return (
    <div className="mock-wallet" aria-label="Wallet">
      <div className="mw-head">
        <span className="mw-ava" aria-hidden="true" />
        <span className="mw-id">
          <b>Your wallet</b>
          <span className="mono">{address ? short(address) : "Not connected"}</span>
        </span>
      </div>

      <div className={`mw-body${round > 0 ? " is-back" : ""}`} key={round}>
        {resume}
        {drawing && (
          <div className="mw-drawing" role="status">
            <span className="mw-px" aria-hidden="true">
              {Array.from({ length: 9 }, (_, i) => (
                <i key={i} />
              ))}
            </span>
            <span>Lucky draw running</span>
          </div>
        )}
        <div className="mw-card">
          <label htmlFor="mw-pay" className="mw-lbl">
            You pay
          </label>
          <div className="mw-row">
            {showForm ? (
              <input
                id="mw-pay"
                className="mw-amt"
                inputMode="decimal"
                autoComplete="off"
                value={input}
                disabled={busy || locked}
                onChange={(e) => onInput(e.target.value)}
              />
            ) : (
              <span className="mw-amt is-empty">0</span>
            )}
            <span className="mw-tok">
              <span className="mw-ic mw-sol" aria-hidden="true" />
              SOL
            </span>
          </div>
          {showForm && (
            <div className="mw-small">
              <span>{out !== null ? `$${usdc(out)}` : ""}</span>
              <span className="mw-pills" role="group" aria-label="Amount">
                {presets.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`mw-pill${p.on ? " on" : ""}`}
                    disabled={p.disabled || busy || locked}
                    onClick={() => onInput(p.label)}
                  >
                    {p.label}
                  </button>
                ))}
              </span>
            </div>
          )}
        </div>
        <div className="mw-flip" aria-hidden="true">
          ⇅
        </div>
        <div className="mw-card">
          <span className="mw-lbl">You receive</span>
          <div className="mw-row">
            <span className={`mw-amt${showForm && out !== null ? "" : " is-empty"}`}>
              {showForm && out !== null ? usdc(out) : "0"}
            </span>
            <span className="mw-tok">
              <span className="mw-ic mw-usdc" aria-hidden="true" />
              USDC
            </span>
          </div>
        </div>

        {showForm && help && <p className="mw-help">{help}</p>}

        {showForm && out !== null && (
          <div className="mw-details">
            <div className="mw-det">
              <span>Pricing</span>
              <span>1 SOL ≈ {usdc(solPrice)} USDC</span>
            </div>
            {current ? (
              <div className="mw-det mw-draw">
                <span className="mw-draw-lbl">✦ Lucky draw</span>
                <span>
                  Ticket{" "}
                  <button
                    type="button"
                    className="mw-tpill"
                    disabled={busy || locked}
                    aria-haspopup="dialog"
                    onClick={() => setSheet("tickets")}
                  >
                    {usdc(price)} USDC ⌄
                  </button>
                </span>
                <span className="mw-meta">
                  <span className="mw-fade">
                    <i aria-hidden="true" />
                    Odds on-chain by Fade
                  </span>
                  <button
                    type="button"
                    className="mw-link"
                    aria-haspopup="dialog"
                    onClick={() => setSheet("odds")}
                  >
                    Check the odds
                  </button>
                </span>
              </div>
            ) : null}
          </div>
        )}

        {s.phase === "failed" && (
          <p className="mw-help mw-warn">Stopped. The details are in the panel.</p>
        )}
      </div>

      <div className="mw-cta">
        {(!busy && cta) ||
          (busy ? (
            <button type="button" className="mw-btn" disabled>
              {drawing ? "Drawing…" : "Confirm in your wallet…"}
            </button>
          ) : (
            <button type="button" className="mw-btn" disabled={!canSwap} onClick={onSwap}>
              Swap now
            </button>
          ))}
      </div>

      <nav className="mw-nav" aria-hidden="true">
        {(Object.keys(ICONS) as (keyof typeof ICONS)[]).map((k) => (
          <span key={k} className={k === "swap" ? "on" : ""}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d={ICONS[k]} />
            </svg>
          </span>
        ))}
      </nav>

      {toast && drawing && (
        <div className="mw-toast" role="status">
          <span className="mw-ok" aria-hidden="true">
            ✓
          </span>
          <span>
            Swapped SOL to USDC
            <small>Lucky draw running…</small>
          </span>
        </div>
      )}

      {sheet === "tickets" && out !== null && (
        <div className="mw-scrim" onClick={() => setSheet(null)}>
          <div
            className="mw-sheet"
            role="dialog"
            aria-label="Choose your ticket"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Choose your ticket</h3>
            <div className="mw-opts">
              {options.map((o) => (
                <button
                  key={o.value.toString()}
                  type="button"
                  className={`mw-opt${o.value === price ? " on" : ""}`}
                  aria-pressed={o.value === price}
                  onClick={() => {
                    onTicket(o.value);
                    setSheet(null);
                  }}
                >
                  <span>
                    {usdc(o.value)} USDC{o.best && <small> best odds</small>}
                  </span>
                  <small>{o.oneIn}</small>
                </button>
              ))}
            </div>
            <p className="mw-fine">
              Win {usdc(out)} USDC, the value of your swap. A larger ticket gives better odds.
            </p>
            <button type="button" className="mw-btn mw-ghost" onClick={() => setSheet(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      {sheet === "odds" && current && out !== null && (
        <div className="mw-scrim" onClick={() => setSheet(null)}>
          <div
            className="mw-sheet"
            role="dialog"
            aria-label="The odds"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>The odds</h3>
            <div className="mw-details">
              <div className="mw-det">
                <span className="mw-draw-lbl">Whole trade won back</span>
                <span>
                  {current.oneIn} ({current.pct}), {usdc(out)} USDC
                </span>
              </div>
              <div className="mw-det">
                <span>Nothing</span>
                <span>the ticket price goes to the vault</span>
              </div>
            </div>
            <p className="mw-fine">
              Paid in USDC: the trade value at the swap price, fixed when you swap. Published
              on-chain before the draw.
            </p>
            <button type="button" className="mw-btn mw-ghost" onClick={() => setSheet(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      {ended && (
        <div
          className={`mw-full${leaving ? " is-leaving" : ""}`}
          role="dialog"
          aria-label="Lucky draw result"
          onAnimationEnd={(e) => e.animationName === "mw-out" && closed()}
        >
          {s.phase === "expired" ? (
            <>
              <div className="mw-big is-lost">✦</div>
              <h3>No draw in time</h3>
              <p>The ticket price stays with the vault. Your swap went through as usual.</p>
            </>
          ) : s.result && s.result.outcome < 0 ? (
            <>
              <div className="mw-big is-lost">✦</div>
              <h3>Drawn</h3>
              <p>The result is in the draw transaction, listed in the panel.</p>
            </>
          ) : won ? (
            <>
              <div className="mw-big">✦</div>
              <h3>You won your swap back</h3>
              <div className="mw-won mono">+{usdc(s.result?.payout ?? 0n)} USDC</div>
              <p>
                {s.result?.pending
                  ? "The value of your swap waits in escrow: this wallet could not receive it directly. It can be claimed."
                  : "The value of your swap, paid to your wallet. The odds were on-chain before the draw."}
              </p>
              <ShareWinButton win={share} className="btn share-btn" />
            </>
          ) : (
            <>
              <div className="mw-big is-lost">✦</div>
              <h3>Not this time</h3>
              <p>Your swap went through as usual. The ticket price stays with the vault.</p>
            </>
          )}
          <button type="button" className="mw-btn" onClick={close} disabled={leaving}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
