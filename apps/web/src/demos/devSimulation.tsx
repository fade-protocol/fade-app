// Development only: a "Simulate" panel that plays a whole payout on the active
// demo without a wallet or a transaction: checking, signing, confirming, the
// keeper's draw (queued, requested, fulfilled) and an ending (any outcome of the
// payout table, or no draw), with realistic delays; or a wallet that declines the signature (nothing is opened). The
// demo reads the simulated state exactly as it reads a real one, so the
// progress steps, the receipt and the result all play. The panel's Reset,
// or the demo's own reset button, hands back to the real flow. The production build compiles all
// of this away: useDevSimulation returns the real flow, DevSimPanel nothing.
import { useEffect, useRef, useState } from "react";
import { setReceipt3dWanted, useReceipt3dWanted } from "../receipt3d/devToggle";
import { PACK_FAILED_KEY } from "../components/Pack3D";
import { forgetFailure } from "../receipt3d/support";
import type { Address } from "@solana/kit";
import type { FlowState, DrawResult } from "./useTicketFlow";

/**
 * What a simulated win's share card points at, as it has no ticket: shaped like an address, it
 * opened none, so its draw page finds nothing. Development only, like the rest of this file.
 */
export const SIM_TICKET = "5SZrnfRjSYSvC9Am2uyDMNoZWDjiyDDjESnQwurVBE31" as Address;

export type SimEnding = "drawn" | "expired" | "declined";
type SimRequest = {
  demo: string;
  ending: SimEnding | "reset";
  /** For a draw: the payout table's outcome it lands on. */
  outcome: number;
  waitMs: number;
};

const EVENT = "fade:dev-simulate";

type Flow = { state: FlowState; reset: () => void };

/**
 * Wraps a demo's flow: while a simulation runs on `demo`, its state replaces
 * the real one. `resultFor` gives the result the demo would read for a draw that
 * lands on `outcome` (an index in its payout table): its payout; it is read when the draw ends.
 */
export function useDevSimulation<F extends Flow>(
  demo: string,
  flow: F,
  resultFor: (outcome: number) => DrawResult,
): F {
  if (!import.meta.env.DEV) return flow;
  // A build-time constant: the hook below runs on every render, or never.
  return useSimulation(demo, flow, resultFor);
}

function useSimulation<F extends Flow>(
  demo: string,
  flow: F,
  resultFor: (outcome: number) => DrawResult,
): F {
  const [sim, setSim] = useState<FlowState | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const resultRef = useRef(resultFor);
  resultRef.current = resultFor;
  const base = useRef(flow.state);
  base.current = flow.state;

  const stop = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  useEffect(() => {
    const run = (e: Event) => {
      const req = (e as CustomEvent<SimRequest>).detail;
      if (req.demo !== demo) return;
      stop();
      if (req.ending === "reset") {
        setSim(null);
        return;
      }
      const start = Date.now();
      const idle: FlowState = { ...base.current, phase: "idle", result: null, sigs: {} };
      const at = (ms: number, patch: (prev: FlowState) => Partial<FlowState>) =>
        timers.current.push(
          setTimeout(() => setSim((prev) => ({ ...(prev ?? idle), ...patch(prev ?? idle) })), ms),
        );
      const opened = 2_800;
      const drawn = opened + req.waitMs;
      setSim({ ...idle, phase: "checking", times: { start }, detail: "Checking the ticket" });
      at(500, () => ({ phase: "signing", detail: "Approve in your wallet" }));
      if (req.ending === "declined") {
        // the wallet says no: nothing was sent, nothing printed
        at(2_300, () => ({
          phase: "failed",
          detail: null,
          failedAt: "signing",
          failure: { code: null, name: null, message: "User rejected the request.", logs: [] },
        }));
        return;
      }
      at(1_800, () => ({ phase: "confirming", detail: "Confirming the payout" }));
      at(opened, (p) => ({
        phase: "drawing",
        progress: "queued",
        keeper: "queued",
        detail: "Queued: the draw is requested automatically",
        times: { ...p.times, opened: start + opened },
      }));
      at(opened + Math.round(req.waitMs * 0.4), () => ({
        progress: "requested",
        detail: "Waiting for the oracle",
      }));
      if (req.ending === "expired") {
        at(drawn, (p) => ({
          phase: "expired",
          detail: null,
          times: { ...p.times, done: start + drawn },
        }));
      } else {
        at(drawn, (p) => ({
          progress: "fulfilled",
          detail: "Drawn: paying out…",
          times: { ...p.times, drawn: start + drawn },
        }));
        at(drawn + 700, (p) => ({
          phase: "done",
          detail: null,
          result: resultRef.current(req.outcome),
          times: { ...p.times, done: start + drawn + 700 },
        }));
      }
    };
    window.addEventListener(EVENT, run);
    return () => {
      window.removeEventListener(EVENT, run);
      stop();
    };
  }, [demo]);

  if (!sim) return flow;
  return {
    ...flow,
    state: sim,
    reset: () => {
      stop();
      setSim(null);
      flow.reset();
    },
  };
}

const WAITS = [
  { label: "2 s", ms: 2_000 },
  { label: "5 s", ms: 5_000 },
  { label: "15 s", ms: 15_000 },
];

/** The floating panel, on the demos page in development only. */
export function DevSimPanel({ demo }: { demo: string }) {
  if (!import.meta.env.DEV) return null;
  return <Panel demo={demo} />;
}

function Panel({ demo }: { demo: string }) {
  const [waitMs, setWaitMs] = useState(5_000);
  const [open, setOpen] = useState(true);
  const receipt3d = useReceipt3dWanted();
  const play = (ending: SimEnding | "reset", outcome = 0) =>
    window.dispatchEvent(
      new CustomEvent<SimRequest>(EVENT, { detail: { demo, ending, outcome, waitMs } }),
    );
  // the outcomes a draw may land on: the booster's pack opens in every case, a win adds a pack
  const outcomes = demo === "booster" ? ["Premium", "Second pack", "No extra"] : ["Win", "Lose"];
  return (
    <div className="dev-sim" role="region" aria-label="Development simulation">
      <button type="button" className="dev-sim-head" onClick={() => setOpen((o) => !o)}>
        Dev · simulate {demo}
      </button>
      {open && (
        <div className="dev-sim-body">
          <div className="dev-sim-row">
            {outcomes.map((label, i) => (
              <button
                key={label}
                type="button"
                className={`btn btn-small ${i === 0 ? "btn-primary" : "btn-ghost"}`}
                onClick={() => play("drawn", i)}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => play("expired")}
            >
              No draw
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => play("declined")}
            >
              Decline
            </button>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => play("reset")}>
              Reset
            </button>
          </div>
          <div className="dev-sim-row">
            <span className="small muted">Draw takes</span>
            {WAITS.map((w) => (
              <button
                key={w.ms}
                type="button"
                className={`dev-sim-wait${w.ms === waitMs ? " on" : ""}`}
                aria-pressed={w.ms === waitMs}
                onClick={() => setWaitMs(w.ms)}
              >
                {w.label}
              </button>
            ))}
          </div>
          {(demo === "checkout" || demo === "booster") && (
            <div className="dev-sim-row">
              <span className="small muted">{demo === "checkout" ? "Receipt" : "Pack"}</span>
              {[
                { label: "3D", on: true },
                { label: "2D", on: false },
              ].map((o) => (
                <button
                  key={o.label}
                  type="button"
                  className={`dev-sim-wait${receipt3d === o.on ? " on" : ""}`}
                  aria-pressed={receipt3d === o.on}
                  onClick={() => {
                    // "3D" tries again even after a failure earlier in this tab
                    if (o.on) forgetFailure(demo === "checkout" ? undefined : PACK_FAILED_KEY);
                    setReceipt3dWanted(o.on);
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          <p className="small muted">No wallet, nothing sent.</p>
        </div>
      )}
    </div>
  );
}
