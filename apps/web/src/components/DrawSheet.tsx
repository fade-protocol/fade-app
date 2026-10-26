// "Draw details": what a share card's QR code opens (app.fade.finance/w/<ticket>), over Home. It
// reads the draw back from the chain and says what came back, what the ticket cost, its odds and
// when it was drawn, with the proof: the draw's transaction and the oracle's randomness account.
// A modal <dialog>, as the share sheet: Escape, the close button, the backdrop and "Try it
// yourself" all close it onto Home, the address bar back to "/" without a reload.
import type { Address } from "@solana/kit";
import { useEffect, useId, useRef, useState } from "react";
import { drawnAt, fetchDraw, type DrawView } from "../lib/draw";
import { replacePath } from "../router";
import { ExplorerAddress, ExplorerTx, Skeleton } from "./ui";

type Read = { status: "loading" } | { status: "found"; draw: DrawView } | { status: "missing" };

function useDraw(ticket: Address | null): Read {
  const [read, setRead] = useState<Read>(ticket ? { status: "loading" } : { status: "missing" });
  useEffect(() => {
    if (!ticket) return;
    let alive = true;
    fetchDraw(ticket)
      .then((draw) => alive && setRead(draw ? { status: "found", draw } : { status: "missing" }))
      .catch(() => alive && setRead({ status: "missing" }));
    return () => {
      alive = false;
    };
  }, [ticket]);
  return read;
}

/** The plain explanation under the proof links. */
const HOW =
  "The odds were locked when the ticket opened; the draw came from ORAO's verifiable randomness, after the ticket was paid.";

function Found({ d }: { d: DrawView }) {
  return (
    <>
      <div className={`draw-hero is-${d.state}`}>
        <p className="draw-hero-title">{d.title}</p>
        {d.amount && <p className="draw-hero-amount">{d.amount}</p>}
        {d.pending && (
          <p className="small muted">
            {d.state !== "expired"
              ? "The payout waits in escrow, to be claimed by the buyer."
              : d.creditReturned
                ? "The ticket's credit waits in escrow, to be claimed."
                : "The ticket price waits in escrow, to be claimed back."}
          </p>
        )}
      </div>
      <dl className="draw-facts">
        <div>
          <dt>Ticket price</dt>
          <dd>{d.price}</dd>
        </div>
        <div>
          <dt>Odds</dt>
          <dd>{d.oneIn ?? "Not known"}</dd>
        </div>
        <div>
          <dt>{d.state === "drawing" ? "Opened" : "Drawn"}</dt>
          <dd>{d.at ? drawnAt(d.at) : "Not known"}</dd>
        </div>
      </dl>
      <div className="draw-proof">
        <p className="small muted">{HOW}</p>
        <p className="draw-links">
          {d.drawSig && <ExplorerTx sig={d.drawSig}>Open transaction</ExplorerTx>}
          {d.randomness && (
            <ExplorerAddress address={d.randomness}>Randomness account (ORAO)</ExplorerAddress>
          )}
        </p>
      </div>
    </>
  );
}

export function DrawSheet({ ticket }: { ticket: Address | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const read = useDraw(ticket);

  // no close on cleanup: the dialog leaves with the element
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const close = () => ref.current?.close();

  return (
    <dialog
      ref={ref}
      className="share-sheet draw-sheet"
      aria-labelledby={titleId}
      aria-busy={read.status === "loading"}
      onClose={() => replacePath("/")}
      onClick={(e) => e.target === ref.current && close()}
    >
      <div className="share-body">
        <div className="share-head">
          <h2 id={titleId} className="share-title">
            {read.status === "missing" ? "We couldn't find this draw" : "Draw details"}
          </h2>
          <button type="button" className="share-close" aria-label="Close" onClick={close}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                d="M3.5 3.5l9 9M12.5 3.5l-9 9"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {read.status === "loading" && (
          <div className="draw-loading" role="status">
            <Skeleton h={30} w="70%" />
            <Skeleton h={22} w="40%" />
            <Skeleton h={64} />
            <p className="small muted">Reading the draw from Solana…</p>
          </div>
        )}
        {read.status === "missing" && (
          <p className="muted draw-missing">
            This link may be incomplete, or the network did not answer. Every draw stays on Solana:
            try the link again in a moment.
          </p>
        )}
        {read.status === "found" && <Found d={read.draw} />}

        <button type="button" className="btn btn-primary draw-cta" onClick={close}>
          Try it yourself
        </button>
      </div>
    </dialog>
  );
}
