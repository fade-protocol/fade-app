import { Disclosure } from "../components/disclosure";
import { ScrollArea } from "../components/scroll";
import { ExplorerAddress, ExplorerTx, FailureBox, Spinner, useElapsed } from "../components/ui";
import {
  SLOT_MS,
  drawDetailShown,
  drawState,
  takeOverOffered,
  type FlowState,
  type Progress as DrawProgress,
} from "./useTicketFlow";

// While the wallet is open, the time is the user's own: nothing is timed until the ticket is
// open on chain. From then on, one row of steps and one clock for the draw.
const SIGN_PHASES = ["checking", "signing", "confirming"];

const fmt = (sec: number | null) => (sec === null ? "" : `${sec.toFixed(1)} s`);

const DRAW_STEPS: { id: DrawProgress | "settled"; label: string }[] = [
  { id: "queued", label: "Queued" },
  { id: "requested", label: "Requested" },
  { id: "fulfilled", label: "Drawn" },
  { id: "settled", label: "Paid" },
];

function drawIndex(s: FlowState): number {
  if (s.phase === "done") return 4;
  if (s.progress === "fulfilled") return 2;
  if (s.progress === "requested") return 1;
  if (s.progress === "queued") return 0;
  return -1;
}

export function Progress({
  state: s,
  onTakeOver,
  onWatchAgain,
}: {
  state: FlowState;
  onTakeOver: () => void;
  onWatchAgain: () => void;
}) {
  const stopped = s.phase === "failed" || s.phase === "idle";
  const drawTime = useElapsed(
    s.times.opened,
    s.times.done ?? (stopped ? s.times.opened : undefined),
  );
  if (s.phase === "idle") return null;
  const di = drawIndex(s);
  const secondsLeft = s.slotsLeft !== null ? Number(s.slotsLeft) * (SLOT_MS / 1000) : null;
  const showFallback =
    s.phase === "drawing" && s.driver === "keeper" && s.stalled && s.ticket !== null;
  const failedDrawing = s.phase === "failed" && s.failedAt === "drawing";
  const opened =
    s.phase === "drawing" || s.phase === "done" || s.phase === "expired" || failedDrawing;
  const showDetail = drawDetailShown(s);

  return (
    <div className="progress">
      {SIGN_PHASES.includes(s.phase) && (
        <p className="draw-detail small" aria-live="polite">
          <Spinner />
          <span>{s.detail ?? "Checking your balance"}</span>
        </p>
      )}

      {opened && (
        <div className="draw-line" aria-live="polite">
          <p className="draw-head">
            <span className={`draw-state is-${s.phase}`}>{drawState(s)}</span>
            <span className="draw-time mono">{fmt(drawTime)}</span>
          </p>
          <ol className="mini" aria-label="Draw progress">
            {DRAW_STEPS.map((d, i) => (
              <li key={d.id} className={i < di || di === 4 ? "on" : i === di ? "now" : ""}>
                {d.label}
              </li>
            ))}
          </ol>
          {showDetail && (
            <p className="draw-detail small">
              <Spinner />
              <span>{s.detail}</span>
            </p>
          )}
        </div>
      )}

      {showFallback && (
        <div className="fallback" role="status">
          <div>
            <p className="fallback-title">
              {s.keeper === "unreachable"
                ? "Automatic delivery is not answering"
                : "No progress for 20 seconds"}
            </p>
            <p className="small">
              You can finish it yourself with two more signatures.
              {secondsLeft !== null && s.progress === "queued" && (
                <>
                  {" "}
                  <strong className="mono">
                    {secondsLeft > 0
                      ? `About ${Math.round(secondsLeft)} s left.`
                      : "The window has closed."}
                  </strong>
                </>
              )}
            </p>
            <Disclosure summary="What happens if nobody does">
              <p>
                Anyone can move a ticket forward: request the draw, then pay it out. A ticket whose
                draw is not requested within about a minute of the open ends with no draw, and its
                price stays with the vault.
              </p>
            </Disclosure>
          </div>
          <button type="button" className="btn btn-outline" onClick={onTakeOver}>
            Finish it myself
          </button>
        </div>
      )}

      {s.failure && (
        <FailureBox
          failure={s.failure}
          title={s.failure.code !== null ? "Refused by the program" : "Stopped"}
        />
      )}
      {failedDrawing && (
        <div className="actions-row">
          {takeOverOffered(s) ? (
            <>
              <button type="button" className="btn btn-outline btn-small" onClick={onTakeOver}>
                Try again with my wallet
              </button>
              <button type="button" className="btn btn-ghost btn-small" onClick={onWatchAgain}>
                Wait for automatic delivery
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-outline btn-small" onClick={onWatchAgain}>
              Keep watching
            </button>
          )}
        </div>
      )}

      {(s.sigs.open || s.ticket) && <TxDetails s={s} />}
    </div>
  );
}

function TxDetails({ s }: { s: FlowState }) {
  return (
    <Disclosure summary="Transactions and accounts" className="txdetails">
      <ScrollArea label="Transactions and accounts" className="txdetails-scroll">
        <dl className="kv small">
          {s.sigs.open && (
            <>
              <dt>Open, signed by you</dt>
              <dd>
                <ExplorerTx sig={s.sigs.open} />
              </dd>
            </>
          )}
          {s.ticket && (
            <>
              <dt>Payout account</dt>
              <dd>
                <ExplorerAddress address={s.ticket} />
              </dd>
            </>
          )}
          {s.sigs.request && (
            <>
              <dt>Draw request</dt>
              <dd>
                <ExplorerTx sig={s.sigs.request} />
              </dd>
            </>
          )}
          {s.randomness && s.progress !== "queued" && (
            <>
              <dt>ORAO randomness</dt>
              <dd>
                <ExplorerAddress address={s.randomness} />
              </dd>
            </>
          )}
          {s.sigs.settle && (
            <>
              <dt>Payout</dt>
              <dd>
                <ExplorerTx sig={s.sigs.settle} />
              </dd>
            </>
          )}
          {s.sigs.expire && (
            <>
              <dt>{s.refund ? "Draw cancelled" : "No draw in time"}</dt>
              <dd>
                <ExplorerTx sig={s.sigs.expire} />
              </dd>
            </>
          )}
          <dt>Moved by</dt>
          <dd>{s.driver === "self" ? "your wallet" : "Fade, automatically"}</dd>
        </dl>
      </ScrollArea>
    </Disclosure>
  );
}
