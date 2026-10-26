// The small-ticket demo: one 0.10 USDC ticket on the shared beacon. It joins
// the shared draw that is open, pays for that draw at once so it never waits
// for other tickets, shows the tick the draw closes on, and is paid out from
// the draw. Shown only when the app is built with VITE_BEACON_ENABLED
// (lib/config.ts), on the app's own program.
import type { Address } from "@solana/kit";
import { useMemo } from "react";
import { ActionButton } from "../components/Button";
import { Disclosure } from "../components/disclosure";
import { FAUCET_SOL_BELOW, FaucetButton } from "../components/FaucetButton";
import { ExplorerAddress, ExplorerTx, FailureBox, Spinner } from "../components/ui";
import { ScrollArea } from "../components/scroll";
import { BEACON_PAYOUT_TABLE, BEACON_TICKET_PRICE, type Stage } from "../lib/beacon";
import { FAUCET_URL, USDC_MINT } from "../lib/config";
import { ata } from "../lib/fade";
import { odds, sol, usdc } from "../lib/format";
import { NOT_THIS_TIME } from "../lib/ticketWords";
import { ConnectButton } from "../wallet/ConnectButton";
import { useWallet } from "../wallet/WalletProvider";
import { missingFunds, type WalletFunds } from "./common";
import { Odds } from "./Odds";
import { isBeaconBusy, type BeaconFlow } from "../lib/beaconFlow";
import { useBeaconFlow, useJoinQuote } from "./useBeaconFlow";
import { SLOT_MS } from "./useTicketFlow";

const WIN = BEACON_PAYOUT_TABLE[0]!;
const WIN_PAYOUT = (BEACON_TICKET_PRICE * BigInt(WIN.m)) / 10_000n;

/** The four marks of a ticket's way, after its join. */
const STEPS = ["Joined", "Closed", "Drawn", "Paid"] as const;

function stepIndex(s: BeaconFlow): number {
  if (s.phase === "done") return 4;
  switch (s.stage?.kind) {
    case "waiting":
    case "refundable":
    case "closing":
      return 0;
    case "closed":
    case "drawing":
      return 1;
    case "drawn":
      return 2;
    default:
      return s.sigs.join ? 0 : -1;
  }
}

function headline(s: BeaconFlow): string {
  if (s.phase === "failed") return "Stopped";
  if (s.phase === "done") return "Done";
  switch (s.stage?.kind) {
    case "waiting":
      return "Waiting for the draw to be paid";
    case "refundable":
      return "Draw never paid for";
    case "closing":
      return "In the draw";
    case "closed":
      return "Draw closed";
    case "drawing":
      return "Drawing";
    case "drawn":
      return "Drawn, paying out";
    case "no-draw":
      return "No draw in time";
    case "refunded":
      return "Draw cancelled";
    default:
      return "Joining";
  }
}

/** The tick the draw closes on: the slots left, as a bar and in seconds. */
function CloseTick({ stage }: { stage: Extract<Stage, { kind: "closing" }> }) {
  const tick = Number(stage.tickSlots);
  const left = Math.min(Number(stage.slotsLeft), tick);
  const done = tick > 0 ? (tick - left) / tick : 1;
  const seconds = (left * SLOT_MS) / 1000;
  return (
    <div className="beacon-tick" role="timer" aria-live="off">
      <p className="beacon-tick-head">
        <span className="beacon-tick-big mono">{seconds.toFixed(1)} s</span>
        <span className="small muted">until the draw closes</span>
      </p>
      <div className="beacon-tick-bar" aria-hidden="true">
        <span style={{ width: `${(done * 100).toFixed(1)}%` }} />
      </div>
      <p className="small muted mono">
        closes at slot {stage.closeSlot.toLocaleString("en-US")}, {left} slots left
      </p>
    </div>
  );
}

function Visual({ s }: { s: BeaconFlow }) {
  const di = stepIndex(s);
  return (
    <div className="demo-visual-inner beacon-visual">
      <div className="beacon-ticket" data-state={s.phase}>
        <span className="eyebrow-s">Ticket</span>
        <span className="beacon-ticket-price mono">{usdc(BEACON_TICKET_PRICE)}</span>
        <span className="small muted">USDC, one shared draw</span>
      </div>
      {s.stage?.kind === "closing" ? (
        <CloseTick stage={s.stage} />
      ) : (
        <p className="visual-note">
          {s.phase === "idle"
            ? "Many small tickets share one draw. Yours closes at the next tick."
            : headline(s)}
        </p>
      )}
      {s.phase !== "idle" && (
        <ol className="mini" aria-label="Ticket progress">
          {STEPS.map((label, i) => (
            <li key={label} className={i < di || di === 4 ? "on" : i === di ? "now" : ""}>
              {label}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Result({ s }: { s: BeaconFlow }) {
  const end = s.end;
  if (s.phase !== "done" || !end) return null;
  if (end.kind === "no-draw")
    return (
      <div className="result result-expired rise" role="status">
        <p className="result-title">No draw in time</p>
        <p className="small">The ticket price stays with the vault. Nothing else moved.</p>
      </div>
    );
  if (end.kind === "unknown")
    return (
      <div className="result rise" role="status">
        <p className="result-title">{end.drawn ? "Paid out from the draw" : "Ticket closed"}</p>
        <p className="small">
          Its result could not be read just now. The ticket's transactions show it in the explorer.
        </p>
      </div>
    );
  if (end.kind === "refunded")
    return (
      <div className="result rise" role="status">
        <p className="result-title">Draw cancelled</p>
        <p className="small">
          {end.parked
            ? "The ticket price waits in escrow: this wallet's USDC account could not receive it directly. It can be claimed."
            : "It was never drawn: the ticket price came back to your wallet."}
        </p>
      </div>
    );
  const won = end.outcome.payout > 0n;
  return (
    <div className={`result rise ${won ? "result-won" : "result-lost"}`} role="status">
      <p className="result-title">{won ? `+${usdc(end.outcome.payout, 4)} USDC` : NOT_THIS_TIME}</p>
      {end.parked && (
        <p className="small">
          The payout waits in escrow: this wallet's USDC account could not receive it directly. It
          can be claimed.
        </p>
      )}
    </div>
  );
}

function Details({ s }: { s: BeaconFlow }) {
  return (
    <Disclosure summary="Transactions and accounts" className="txdetails">
      <ScrollArea label="Transactions and accounts" className="txdetails-scroll">
        <dl className="kv small">
          {s.round !== null && (
            <>
              <dt>Shared draw</dt>
              <dd className="mono">#{s.round.toString()}</dd>
            </>
          )}
          {s.sigs.join && (
            <>
              <dt>Join, signed by you</dt>
              <dd>
                <ExplorerTx sig={s.sigs.join} />
              </dd>
            </>
          )}
          {s.ticket && (
            <>
              <dt>Ticket account</dt>
              <dd>
                <ExplorerAddress address={s.ticket} />
              </dd>
            </>
          )}
          {s.sigs.sponsor && (
            <>
              <dt>Draw paid by you</dt>
              <dd>
                <ExplorerTx sig={s.sigs.sponsor} />
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
          {s.sigs.payout && (
            <>
              <dt>Payout</dt>
              <dd>
                <ExplorerTx sig={s.sigs.payout} />
              </dd>
            </>
          )}
          {s.sigs.close && (
            <>
              <dt>Last step</dt>
              <dd>
                <ExplorerTx sig={s.sigs.close} />
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

export function BeaconDemo({ program, funds }: { program: Address; funds: WalletFunds | null }) {
  const { signer } = useWallet();
  const target = useMemo(() => ({ program, usdcMint: USDC_MINT }), [program]);
  const flow = useBeaconFlow(target);
  const s = flow.state;
  const busy = isBeaconBusy(s);
  const quote = useJoinQuote(target, signer, s.phase === "idle");
  // Under the free USDC button's threshold, the button tops the wallet up;
  // above it but under what this join fronts, only Solana's own page does.
  const missing =
    missingFunds(funds, BEACON_TICKET_PRICE) ??
    (funds && quote?.ok && funds.sol < quote.need ? "more-sol" : null);
  const buy = async () => {
    if (!signer) return;
    void flow.start(signer, await ata(signer.address));
  };
  const oddsOf = odds(BigInt(WIN.p));

  const cta = !signer ? (
    <div className="stack-s">
      <p className="small muted">Connect a wallet to buy a 0.10 USDC ticket.</p>
      <ConnectButton />
    </div>
  ) : quote && !quote.ok && s.phase === "idle" ? (
    <p className="small muted">{quote.reason}</p>
  ) : missing === "more-sol" && quote?.ok && funds && s.phase === "idle" ? (
    <p className="small muted">
      This ticket needs about {sol(quote.need)} SOL in the wallet while it runs, and it holds{" "}
      {sol(funds.sol)} SOL. Most of it comes back once the ticket is paid out. Add SOL from{" "}
      <a href={FAUCET_URL} target="_blank" rel="noreferrer">
        Solana's free SOL page
      </a>
      .
    </p>
  ) : missing && s.phase === "idle" ? (
    <div className="stack-s">
      <p className="small muted">
        {missing === "sol"
          ? "This wallet needs a little SOL."
          : `This wallet needs USDC for the ${usdc(BEACON_TICKET_PRICE)} ticket.`}
      </p>
      <FaucetButton className="btn-primary" />
    </div>
  ) : s.phase === "done" || s.phase === "failed" ? (
    <div className="actions-row">
      <button type="button" className="btn btn-primary" onClick={flow.reset}>
        Buy another ticket
      </button>
    </div>
  ) : (
    <ActionButton
      busy={busy}
      busyLabel={s.asking ?? "In the draw"}
      onClick={() => void buy()}
      disabled={!signer}
    >
      Buy a {usdc(BEACON_TICKET_PRICE)} USDC ticket
    </ActionButton>
  );

  return (
    <div className="demo">
      <div className="demo-visual">
        <Visual s={s} />
      </div>

      <ScrollArea className="demo-panel" label="Small ticket: the shared draw">
        <div className="demo-head">
          <h2>A 0.10 USDC ticket</h2>
          <p className="muted">
            Small tickets share one draw. Yours pays for the draw at once, so it never waits for
            others: the draw closes at the next tick, about every 15 seconds, and pays out every
            ticket in it.
          </p>
        </div>

        <Odds
          items={[
            { label: "Ticket price", value: usdc(BEACON_TICKET_PRICE), unit: "USDC" },
            { label: "Odds", value: oddsOf.oneIn, sub: oddsOf.pct },
            { label: "Payout", value: usdc(WIN_PAYOUT, 4), unit: "USDC", accent: true },
          ]}
        />

        <section className="stack-s" aria-label="The ticket">
          {cta}
          {s.fronted !== null && s.phase !== "idle" && (
            <p className="small muted">
              Your wallet advances about {sol(s.fronted)} SOL for rent and the draw while it runs
              {s.kept
                ? `, of which ${sol(s.kept)} SOL stays (one-time app record). Of the rest, what the draw does not use comes back.`
                : "; what the draw does not use comes back."}
            </p>
          )}
        </section>

        <section className="stack-s" aria-label="The draw" aria-live="polite">
          <span className="eyebrow-s">The draw</span>
          {s.phase === "idle" && <p className="small muted">Waiting for a ticket.</p>}
          {s.phase !== "idle" && (
            <p className="draw-head">
              <span className={`draw-state is-${s.phase}`}>{headline(s)}</span>
            </p>
          )}
          {s.asking && (
            <p className="draw-detail small">
              <Spinner />
              <span>{s.asking}</span>
            </p>
          )}
          {s.stalled && s.driver === "keeper" && s.phase === "following" && (
            <div className="fallback" role="status">
              <div>
                <p className="fallback-title">
                  {s.stage?.kind === "no-draw"
                    ? "The draw was not delivered in time"
                    : s.stage?.kind === "refundable"
                      ? "The draw was never paid for"
                      : s.stage?.kind === "waiting"
                        ? "The draw is not paid for yet"
                        : "Automatic delivery has not moved it yet"}
                </p>
                <p className="small">
                  {s.stage?.kind === "no-draw" || s.stage?.kind === "refunded"
                    ? "You can close the ticket with one signature."
                    : s.stage?.kind === "refundable"
                      ? "You can close the ticket with one signature: its price comes back to your wallet."
                      : s.stage?.kind === "waiting"
                        ? "You can pay its draw with your wallet, then finish it: most of the SOL comes back with the payout."
                        : "You can finish it with your wallet: request the draw, then the payout."}
                </p>
              </div>
              <button type="button" className="btn btn-outline" onClick={flow.takeOver}>
                Finish with my wallet
              </button>
            </div>
          )}
          <Result s={s} />
          {s.phase === "done" &&
            (s.end?.kind === "paid" || s.end?.kind === "refunded") &&
            s.end.parked && (
              <button
                type="button"
                className="btn btn-outline btn-small"
                onClick={() => void flow.claim()}
              >
                {s.end.kind === "paid" ? "Claim the payout" : "Claim the ticket price"}
              </button>
            )}
          {s.phase === "done" && s.sponsorshipLeft && (
            <div className="actions-row">
              <p className="small muted">The unused SOL of the draw is still on it.</p>
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => void flow.reclaim()}
              >
                Take it back
              </button>
            </div>
          )}
          {s.failure && (
            <FailureBox
              failure={s.failure}
              title={s.failure.code !== null ? "Refused by the program" : "Stopped"}
            />
          )}
          {s.failure && /SOL/.test(s.failure.message) && (
            <p className="small notice-inline">
              The free USDC button adds SOL only to wallets under {sol(FAUCET_SOL_BELOW, 3)} SOL.
              For more, use{" "}
              <a href={FAUCET_URL} target="_blank" rel="noreferrer">
                Solana's free SOL page
              </a>
              .
            </p>
          )}
          {s.phase === "failed" && s.joined && (
            <div className="actions-row">
              <button type="button" className="btn btn-outline btn-small" onClick={flow.takeOver}>
                Try again with my wallet
              </button>
              <button type="button" className="btn btn-ghost btn-small" onClick={flow.watchAgain}>
                Wait for automatic delivery
              </button>
            </div>
          )}
          {(s.sigs.join || s.ticket) && <Details s={s} />}
        </section>
      </ScrollArea>
    </div>
  );
}
