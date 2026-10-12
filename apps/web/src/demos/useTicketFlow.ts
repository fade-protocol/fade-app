// The state machine of one demo payout. The user signs once, `open_ticket`;
// the keeper then requests the randomness and settles. The app follows the
// keeper's API and, as a cross-check, the ticket account itself. If the keeper
// cannot be reached or nothing moves for a while, the user can finish the
// payout with their own wallet: anyone may send those two steps.
import type { Address, Signature, TransactionSigner } from "@solana/kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { TicketStatus } from "../../../../clients/js/src/generated/fade";
import { eventsOfSignature } from "../lib/events";
import type { ProtocolState } from "../lib/fade";
import { submitTicket, ticketStatus, type KeeperTicket } from "../lib/keeper";
import { quote, type Outcome, type Quote } from "../lib/math";
import { rpc, sleep } from "../lib/rpc";
import { isHalved, vaultOf } from "../lib/vaultFigures";
import { send, simulate, TxError, type ProgramFailure } from "../lib/tx";
import {
  fetchTicket,
  findTicketEnd,
  openTicketInstruction,
  readTicket,
  requestRandomnessInstruction,
  resolveOpener,
  settleInstruction,
  waitFulfilled,
  ticketAddress,
  type ChainView,
  type Ticket,
  type TicketEnd,
} from "../lib/ticket";

/** Without progress for this long, the user is offered to finish the payout. */
export const STALL_MS = 20_000;
/** Roughly how long a slot lasts on devnet, to turn slots into seconds. */
export const SLOT_MS = 400;

export type Phase =
  "idle" | "checking" | "signing" | "confirming" | "drawing" | "done" | "expired" | "failed";

/** Where the draw is, merged from the keeper's API and the chain. */
export type Progress = "queued" | "requested" | "fulfilled";

export type DrawResult = {
  outcome: number;
  payout: bigint;
  pending: boolean;
  sig: Signature | null;
};

export type FlowState = {
  phase: Phase;
  progress: Progress | null;
  ticket: Address | null;
  onchain: Ticket | null;
  sigs: { open?: Signature; request?: Signature; settle?: Signature; expire?: Signature };
  randomness: Address | null;
  /** The handoff: was the keeper reached? */
  keeper: "idle" | "submitting" | "queued" | "unreachable";
  /** Who moves the payout after the open. */
  driver: "keeper" | "self";
  /** No progress for STALL_MS, or the keeper is unreachable: offer to finish it. */
  stalled: boolean;
  /** Slots left before an undrawn payout can be expired, while that matters. */
  slotsLeft: bigint | null;
  /** One line on what is happening now. */
  detail: string | null;
  /** Wall-clock marks, ms. */
  times: { start?: number; opened?: number; drawn?: number; done?: number };
  result: DrawResult | null;
  failure: ProgramFailure | null;
  failedAt: Phase | null;
};

const initial: FlowState = {
  phase: "idle",
  progress: null,
  ticket: null,
  onchain: null,
  sigs: {},
  randomness: null,
  keeper: "idle",
  driver: "keeper",
  stalled: false,
  slotsLeft: null,
  detail: null,
  times: {},
  result: null,
  failure: null,
  failedAt: null,
};

const asFailure = (e: unknown): ProgramFailure =>
  e instanceof TxError
    ? e.failure
    : {
        code: null,
        name: null,
        message:
          e instanceof Error
            ? /reject|denied|cancel/i.test(e.message)
              ? "The wallet declined to sign."
              : e.message
            : String(e),
        logs: [],
      };

export type StartArgs = {
  signer: TransactionSigner;
  state: Extract<ProtocolState, { initialized: true }>;
  outcomes: readonly Outcome[];
  price: bigint;
  appShareBps: bigint;
};

/** How the payout ended; a parked payout may come without its settle signature. */
type End =
  | Extract<TicketEnd, { kind: "expired" }>
  | (Omit<Extract<TicketEnd, { kind: "settled" }>, "signature"> & { signature: Signature | null });

const RANK: Record<Progress, number> = { queued: 0, requested: 1, fulfilled: 2 };
const later = (a: Progress | null, b: Progress | null): Progress | null =>
  a === null ? b : b === null ? a : RANK[b] > RANK[a] ? b : a;

/** The keeper's state and the chain's, merged: whichever is further along wins. */
function merge(k: KeeperTicket | null, c: ChainView | null) {
  let progress: Progress | null = null;
  if (k && (k.state === "queued" || k.state === "requested" || k.state === "fulfilled"))
    progress = k.state;
  let slotsLeft: bigint | null = null;
  let windowClosed = false;
  if (c && !c.gone) {
    const w = c.ticket;
    const chain: Progress =
      w.status === TicketStatus.Open ? "queued" : c.fulfilled ? "fulfilled" : "requested";
    progress = later(progress, chain);
    if (!c.fulfilled && w.status !== TicketStatus.PayoutPending) {
      slotsLeft = w.expirySlot > c.slot ? w.expirySlot - c.slot : 0n;
      // A draw can no longer be requested after the window: the payout will expire.
      windowClosed = w.status === TicketStatus.Open && c.slot > w.expirySlot;
    }
  }
  return { progress, slotsLeft, windowClosed };
}

export function useTicketFlow() {
  const [s, setS] = useState<FlowState>(initial);
  const busy = useRef(false);
  const watchId = useRef(0);
  const signerRef = useRef<TransactionSigner | null>(null);
  const ticketRef = useRef<Address | null>(null);
  const patch = useCallback(
    (p: Partial<FlowState> | ((prev: FlowState) => Partial<FlowState>)) =>
      setS((prev) => ({ ...prev, ...(typeof p === "function" ? p(prev) : p) })),
    [],
  );

  // Stop following a payout when the demo goes away.
  useEffect(
    () => () => {
      watchId.current++;
    },
    [],
  );

  const finishWith = useCallback(
    (end: End) => {
      const now = Date.now();
      if (end.kind === "expired")
        patch((prev) => ({
          phase: "expired",
          sigs: { ...prev.sigs, expire: end.signature },
          stalled: false,
          detail: null,
          times: { ...prev.times, done: now },
        }));
      else
        patch((prev) => ({
          phase: "done",
          stalled: false,
          detail: null,
          sigs: end.signature ? { ...prev.sigs, settle: end.signature } : prev.sigs,
          result: {
            outcome: end.outcome,
            payout: end.payout,
            pending: end.pending,
            sig: end.signature,
          },
          times: { ...prev.times, drawn: prev.times.drawn ?? now, done: now },
        }));
    },
    [patch],
  );

  /** The settle transaction's own event is the source of truth for the outcome. */
  const resultFromSettle = useCallback(
    async (sig: Signature, k?: KeeperTicket): Promise<TicketEnd> => {
      const events = await eventsOfSignature(sig);
      const e = events.find((x) => x.kind === "TicketSettled");
      if (e && e.kind === "TicketSettled")
        return {
          kind: "settled",
          outcome: e.data.outcome,
          payout: e.data.payout,
          pending: e.data.pending,
          signature: sig,
        };
      return {
        kind: "settled",
        outcome: k?.outcome ?? -1,
        payout: k?.payout ?? -1n,
        pending: false,
        signature: sig,
      };
    },
    [],
  );

  /** Hands the ticket to the keeper, then follows it until it ends or the user takes over. */
  const watch = useCallback(
    async (ticket: Address) => {
      const id = ++watchId.current;
      const alive = () => watchId.current === id;
      patch({
        phase: "drawing",
        driver: "keeper",
        keeper: "submitting",
        stalled: false,
        detail: "Starting the draw",
      });
      // The keeper checks the ticket on-chain: its node may lag a moment behind ours.
      let accepted = false;
      for (let attempt = 0; attempt < 3 && !accepted && alive(); attempt++) {
        if (attempt > 0) await sleep(1_500);
        accepted = await submitTicket(ticket);
      }
      if (!alive()) return;
      let keeperUp = accepted;
      patch({
        keeper: accepted ? "queued" : "unreachable",
        stalled: !accepted,
        detail: accepted
          ? "Queued, the draw starts automatically"
          : "Automatic delivery did not answer. The chain is still being watched.",
      });
      let last: Progress | null = null;
      let lastChange = Date.now();
      let fails = 0;
      let submitted = accepted;
      for (let tick = 0; alive(); tick++) {
        let k: KeeperTicket | null = null;
        // Not handed over yet (the keeper was down, or lost it): try again every few seconds.
        if (!submitted && tick % 5 === 4) {
          submitted = await submitTicket(ticket);
          if (submitted && alive()) {
            keeperUp = true;
            fails = 0;
            patch({ keeper: "queued" });
          }
        }
        if (submitted && (keeperUp || tick % 5 === 0)) {
          try {
            k = await ticketStatus(ticket);
            fails = 0;
            if (k.state === "unknown") submitted = false;
            else if (!keeperUp) {
              keeperUp = true;
              patch({ keeper: "queued" });
            }
          } catch {
            if (++fails >= 3 && keeperUp) {
              keeperUp = false;
              patch({ keeper: "unreachable" });
            }
          }
        }
        if (!alive()) return;
        if (k?.state === "settled" && k.settleSignature) {
          const end = await resultFromSettle(k.settleSignature, k);
          if (alive()) finishWith(end);
          return;
        }
        if (k?.state === "expired" && k.expireSignature) {
          finishWith({ kind: "expired", signature: k.expireSignature });
          return;
        }
        // The chain, every other second, and always when the keeper is quiet.
        let c: ChainView | null = null;
        if (tick % 2 === 0 || !keeperUp || k?.state === "settled" || k?.state === "expired")
          c = await readTicket(ticket).catch(() => null);
        if (!alive()) return;
        if (c?.gone) {
          if (c.end) {
            finishWith(c.end);
            return;
          }
        } else if (c && c.ticket.status === TicketStatus.PayoutPending) {
          finishWith({
            kind: "settled",
            outcome: c.ticket.outcome,
            payout: c.ticket.payout,
            pending: true,
            signature: k?.settleSignature ?? null,
          });
          return;
        }
        const m = merge(k, c);
        const now = Date.now();
        if (m.progress !== null && m.progress !== last) {
          last = later(last, m.progress);
          lastChange = now;
        }
        const stalled = !keeperUp || now - lastChange > STALL_MS;
        patch((prev) => ({
          progress: later(prev.progress, m.progress),
          ...(c && !c.gone ? { onchain: c.ticket, randomness: c.ticket.randomness } : {}),
          ...(k?.requestSignature ? { sigs: { ...prev.sigs, request: k.requestSignature } } : {}),
          slotsLeft: c ? m.slotsLeft : prev.slotsLeft,
          stalled,
          detail:
            last === "fulfilled"
              ? "Drawn, paying out"
              : last === "requested"
                ? "Drawing"
                : keeperUp
                  ? "Queued, the draw starts automatically"
                  : "Automatic delivery did not answer. The chain is still being watched.",
          times:
            last === "fulfilled" && !prev.times.drawn ? { ...prev.times, drawn: now } : prev.times,
          ...(m.windowClosed ? { phase: "expired" as const, stalled: false, detail: null } : {}),
        }));
        if (m.windowClosed) return;
        await sleep(1_000);
      }
    },
    [patch, finishWith, resultFromSettle],
  );

  /** The fallback: the user's wallet requests the draw and settles, each step simulated first. */
  const finishSelf = useCallback(
    async (signer: TransactionSigner, ticket: Address) => {
      for (let round = 0; round < 6; round++) {
        const w = await fetchTicket(ticket);
        if (!w) {
          for (let i = 0; i < 15; i++) {
            const end = await findTicketEnd(ticket).catch(() => null);
            if (end) return finishWith(end);
            await sleep(1_000);
          }
          throw new Error("the payout was closed, but its last transaction is not readable yet");
        }
        patch({ onchain: w, randomness: w.randomness });
        /** A refusal is a race when someone else moved the payout meanwhile. */
        const raced = async (e: unknown) => {
          if (!(e instanceof TxError)) return false;
          const again = await fetchTicket(ticket);
          return !again || again.status !== w.status;
        };
        if (w.status === TicketStatus.Open) {
          const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
          if (slot > w.expirySlot) {
            patch({ phase: "expired", detail: null });
            return;
          }
          patch({ progress: "queued", detail: "Waiting for the open to be final" });
          const { instruction, request } = await requestRandomnessInstruction(
            signer,
            ticket,
            w.openSlot,
          );
          patch({ randomness: request, detail: "Approve the draw request in your wallet" });
          try {
            const sent = await send(signer, [instruction], "request_randomness", 120_000, {
              onSigned: () => patch({ detail: "Requesting the draw" }),
            });
            patch((prev) => ({
              progress: "requested",
              sigs: { ...prev.sigs, request: sent.signature },
            }));
          } catch (e) {
            if (await raced(e)) continue;
            throw e;
          }
          continue;
        }
        if (w.status === TicketStatus.Requested) {
          patch({ progress: "requested", detail: "Drawing" });
          await waitFulfilled(w.randomness);
          patch((prev) => ({
            progress: "fulfilled",
            detail: "Approve the payout in your wallet",
            times: { ...prev.times, drawn: prev.times.drawn ?? Date.now() },
          }));
          try {
            const sent = await send(
              signer,
              [await settleInstruction(signer, ticket, w)],
              "settle_ticket",
              120_000,
              { onSigned: () => patch({ detail: "Paying out" }) },
            );
            return finishWith(await resultFromSettle(sent.signature));
          } catch (e) {
            if (await raced(e)) continue;
            throw e;
          }
        }
        if (w.status === TicketStatus.PayoutPending)
          return finishWith({
            kind: "settled",
            outcome: w.outcome,
            payout: w.payout,
            pending: true,
            signature: null,
          });
      }
      throw new Error("the payout kept changing under this wallet; reload to see where it is");
    },
    [patch, finishWith, resultFromSettle],
  );

  const start = useCallback(
    async (a: StartArgs): Promise<void> => {
      if (busy.current) return;
      busy.current = true;
      watchId.current++;
      signerRef.current = a.signer;
      setS({ ...initial, phase: "checking", times: { start: Date.now() } });
      let ticket: Address | null = null;
      try {
        const opener = await resolveOpener(a.signer.address);
        if (opener.usdcBalance === null || opener.usdcBalance < a.price)
          throw new Error(
            opener.usdcBalance === null
              ? "This wallet has no USDC yet: use “Get free USDC”."
              : "This wallet holds less USDC than the ticket: use “Get free USDC”.",
          );
        ticket = await ticketAddress(opener.integrator, opener.nonce);
        ticketRef.current = ticket;
        patch({ phase: "signing", ticket, detail: "Approve in your wallet" });
        const ix = await openTicketInstruction({
          signer: a.signer,
          opener,
          treasury: a.state.config.protocolTreasury,
          outcomes: a.outcomes,
          price: a.price,
          appShareBps: a.appShareBps,
        });
        const sent = await send(a.signer, [ix], "open_ticket", 250_000, {
          onSigned: (sig) =>
            patch((prev) => ({
              phase: "confirming",
              sigs: { ...prev.sigs, open: sig },
              detail: "Confirming",
            })),
        });
        patch((prev) => ({
          sigs: { ...prev.sigs, open: sent.signature },
          times: { ...prev.times, opened: Date.now() },
        }));
      } catch (e) {
        setS((prev) => ({
          ...prev,
          phase: "failed",
          failure: asFailure(e),
          failedAt: prev.phase,
          detail: null,
        }));
        ticket = null;
      } finally {
        busy.current = false;
      }
      if (ticket) void watch(ticket);
    },
    [patch, watch],
  );

  /** Picks up a payout this wallet left mid-way: hand it to the keeper again and follow it. */
  const resume = useCallback(
    async (signer: TransactionSigner, ticket: Address) => {
      if (busy.current) return;
      signerRef.current = signer;
      ticketRef.current = ticket;
      const now = Date.now();
      setS({ ...initial, phase: "drawing", ticket, times: { start: now, opened: now } });
      void watch(ticket);
    },
    [watch],
  );

  /** "Finish it myself": stop waiting for the keeper and sign the two remaining steps. */
  const takeOver = useCallback(async () => {
    const signer = signerRef.current;
    const ticket = ticketRef.current;
    if (busy.current || !signer || !ticket) return;
    busy.current = true;
    watchId.current++;
    patch({ phase: "drawing", driver: "self", stalled: false, failure: null, failedAt: null });
    try {
      await finishSelf(signer, ticket);
    } catch (e) {
      setS((prev) => ({
        ...prev,
        phase: "failed",
        failure: asFailure(e),
        failedAt: "drawing",
        detail: null,
      }));
    } finally {
      busy.current = false;
    }
  }, [patch, finishSelf]);

  /** After a failed self-finish: go back to following the keeper. */
  const watchAgain = useCallback(() => {
    const ticket = ticketRef.current;
    if (busy.current || !ticket) return;
    patch({ failure: null, failedAt: null });
    void watch(ticket);
  }, [patch, watch]);

  const reset = useCallback(() => {
    if (busy.current) return;
    watchId.current++;
    ticketRef.current = null;
    setS(initial);
  }, []);

  return { state: s, start, resume, takeOver, watchAgain, reset };
}

/** True while a payout is in flight. */
export const isBusy = (s: FlowState) =>
  s.phase === "checking" ||
  s.phase === "signing" ||
  s.phase === "confirming" ||
  s.phase === "drawing";

/** Admission predicted from the vault as last read. */
export function predict(
  state: Extract<ProtocolState, { initialized: true }>,
  outcomes: readonly Outcome[],
  price: bigint,
  appShareBps: bigint,
): Quote {
  return quote({
    outcomes,
    price,
    appShareBps,
    params: state.config.params,
    vault: vaultOf(state),
    halved: isHalved(state),
  });
}

export { isHalved, vaultOf };

/** Simulates the open of a payout table as `who`, without a signature. */
export async function simulateOpen(args: {
  who: TransactionSigner;
  state: Extract<ProtocolState, { initialized: true }>;
  outcomes: readonly Outcome[];
  price: bigint;
  appShareBps: bigint;
}) {
  const opener = await resolveOpener(args.who.address);
  if (opener.usdcBalance === null) return { opener, sim: null };
  const ix = await openTicketInstruction({
    signer: args.who,
    opener,
    treasury: args.state.config.protocolTreasury,
    outcomes: args.outcomes,
    price: args.price,
    appShareBps: args.appShareBps,
  });
  return { opener, sim: await simulate(args.who.address, [ix]) };
}
