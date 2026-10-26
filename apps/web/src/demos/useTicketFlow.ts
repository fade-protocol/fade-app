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
import { usdc } from "../lib/format";
import { quote, type Outcome, type Quote } from "../lib/math";
import { rpc, sleep } from "../lib/rpc";
import { isHalved, vaultOf } from "../lib/vaultFigures";
import { reloadIfOlderBuild } from "../lib/staleDeploy";
import { send, simulate, TxError, type ProgramFailure } from "../lib/tx";
import {
  expiryEnd,
  fetchTicket,
  findTicketEnd,
  isParkedRefund,
  openTicketInstruction,
  readTicket,
  requestRandomnessInstruction,
  resolveOpener,
  settleInstruction,
  waitFulfilled,
  ticketAddress,
  type ChainView,
  type CreditRefund,
  type Ticket,
  type TicketEnd,
} from "../lib/ticket";

/** Without progress for this long, the user is offered to finish the payout. */
export const STALL_MS = 20_000;
/**
 * Past its window, an Open ticket's end (a forfeiture, a late settlement, a refund) is sent by
 * the keeper or anyone else: followed this long, or until the keeper stops answering, then the
 * flow stops following it and frees the demo for a new ticket.
 */
export const CLOSE_WAIT_MS = 60_000;
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
  /** An Open ticket past its window: nothing left for the wallet, its end is followed. */
  windowClosed: boolean;
  /** Slots left before an undrawn payout can be expired, while that matters. */
  slotsLeft: bigint | null;
  /** One line on what is happening now. */
  detail: string | null;
  /** Wall-clock marks, ms. */
  times: { start?: number; opened?: number; drawn?: number; done?: number };
  result: DrawResult | null;
  /**
   * With phase "expired": the ticket's vault credit was returned to the beneficiary (or waits
   * in escrow), no draw having run; null for a forfeiture.
   */
  refund: CreditRefund | null;
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
  windowClosed: false,
  slotsLeft: null,
  detail: null,
  times: {},
  result: null,
  refund: null,
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
      // Past the window a ticket never requested still has three ends: a request someone
      // created at its seed and ORAO fulfilled is bound late and settled, its credit is
      // refunded when its seed was never recorded, or it is forfeited. Followed until one lands.
      windowClosed = w.status === TicketStatus.Open && c.slot > w.expirySlot;
    }
  }
  return { progress, slotsLeft, windowClosed };
}

/**
 * The end of a ticket the keeper reports refunded, when its expiry's event could not be read: a
 * refund all the same, never a forfeiture. Parked when the ticket waits in escrow as a refund;
 * delivered once the ticket is gone, its amount the keeper's payout or the ticket's vault credit
 * (what refund_expired_ticket returns). Null while the chain does not tell it yet (a lagging
 * node still shows the ticket Open, or the ticket could not be read at all): the flow keeps
 * following the ticket. The keeper's answer alone never ends it, since the keeper records a
 * refund's payout only for one parked in escrow, which a delivered refund would misreport.
 */
export function refundEndOf(
  sig: Signature,
  k: Pick<KeeperTicket, "payout">,
  c: ChainView | null,
  known: Pick<Ticket, "vaultCredit"> | null,
): Extract<TicketEnd, { kind: "expired" }> | null {
  if (!c) return null;
  if (!c.gone)
    return isParkedRefund(c.ticket)
      ? { kind: "expired", signature: sig, refund: { amount: c.ticket.payout, pending: true } }
      : null;
  if (c.end?.kind === "expired" && c.end.refund)
    return { ...c.end, signature: c.end.signature ?? sig };
  const amount = k.payout ?? known?.vaultCredit;
  return amount === undefined
    ? null
    : { kind: "expired", signature: sig, refund: { amount, pending: false } };
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
          sigs: end.signature ? { ...prev.sigs, expire: end.signature } : prev.sigs,
          refund: end.refund ?? null,
          stalled: false,
          windowClosed: false,
          detail: null,
          times: { ...prev.times, done: now },
        }));
      else
        patch((prev) => ({
          phase: "done",
          stalled: false,
          windowClosed: false,
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

  /**
   * The expiry transaction's own event says whether the credit was refunded. Unreadable, the
   * keeper's answer does: a ticket it reports refunded is read as a refund (`refundEndOf`), or
   * followed further (null) while that is not known yet; never as a forfeiture.
   */
  const resultFromExpire = useCallback(
    async (
      sig: Signature,
      ticket: Address,
      k: KeeperTicket,
      known: Ticket | null,
    ): Promise<TicketEnd | null> => {
      const events = await eventsOfSignature(sig).catch(() => []);
      const e = events.find((x) => x.kind === "TicketExpired");
      if (e && e.kind === "TicketExpired") return expiryEnd(e.data, sig);
      if (k.state !== "refunded") return { kind: "expired", signature: sig };
      const c = await readTicket(ticket).catch(() => null);
      return refundEndOf(sig, k, c, known);
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
      let closedAt: number | null = null;
      // Whether the window closed with no draw, as of the last chain read: the chain is not read
      // on every tick, and the keeper's answer alone does not say it.
      let windowClosed = false;
      let fails = 0;
      let submitted = accepted;
      // the ticket as last read while it was open: a refund's amount is its vault credit
      let known: Ticket | null = null;
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
        if ((k?.state === "expired" || k?.state === "refunded") && k.expireSignature) {
          const end = await resultFromExpire(k.expireSignature, ticket, k, known);
          if (!alive()) return;
          if (end) {
            finishWith(end);
            return;
          }
        }
        // The chain, every other second, and always when the keeper is quiet.
        let c: ChainView | null = null;
        if (
          tick % 2 === 0 ||
          !keeperUp ||
          k?.state === "settled" ||
          k?.state === "expired" ||
          k?.state === "refunded"
        )
          c = await readTicket(ticket).catch(() => null);
        if (!alive()) return;
        if (c && !c.gone) known = c.ticket;
        if (c?.gone) {
          if (c.end) {
            finishWith(c.end);
            return;
          }
        } else if (c && isParkedRefund(c.ticket)) {
          // the credit refunded, waiting in escrow: no draw ran
          finishWith({
            kind: "expired",
            signature: k?.expireSignature ?? null,
            refund: { amount: c.ticket.payout, pending: true },
          });
          return;
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
        if (c && !c.gone) windowClosed = m.windowClosed;
        // past the window there is nothing left for the user's wallet to do
        const stalled = !windowClosed && (!keeperUp || now - lastChange > STALL_MS);
        if (windowClosed) closedAt ??= now;
        if (closedAt !== null && windowClosed && (!keeperUp || now - closedAt > CLOSE_WAIT_MS)) {
          patch({
            phase: "failed",
            failedAt: "drawing",
            stalled: false,
            windowClosed: true,
            detail: null,
            failure: {
              code: null,
              name: null,
              message: keeperUp
                ? "The draw window closed with no draw, and the ticket has not closed yet. It still closes on its own: the ticket stays with the vault, a draw that was already answered pays out, or the draw is cancelled and its credit comes back. It will show in your history."
                : "The draw window closed with no draw, and automatic delivery is not answering. The ticket still closes on its own: the ticket stays with the vault, a draw that was already answered pays out, or the draw is cancelled and its credit comes back. It will show in your history.",
              logs: [],
            },
          });
          return;
        }
        patch((prev) => ({
          progress: later(prev.progress, m.progress),
          ...(c && !c.gone ? { onchain: c.ticket, randomness: c.ticket.randomness } : {}),
          ...(k?.requestSignature ? { sigs: { ...prev.sigs, request: k.requestSignature } } : {}),
          slotsLeft: c ? m.slotsLeft : prev.slotsLeft,
          stalled,
          windowClosed,
          detail: windowClosed
            ? "No draw in its window: waiting for the ticket to close"
            : last === "fulfilled"
              ? "Drawn, paying out"
              : last === "requested"
                ? "Drawing"
                : keeperUp
                  ? "Queued, the draw starts automatically"
                  : "Automatic delivery did not answer. The chain is still being watched.",
          times:
            last === "fulfilled" && !prev.times.drawn ? { ...prev.times, drawn: now } : prev.times,
        }));
        await sleep(1_000);
      }
    },
    [patch, finishWith, resultFromSettle, resultFromExpire],
  );

  /**
   * The fallback: the user's wallet requests the draw and settles, each step simulated first.
   * "watch" when the ticket's window has closed unrequested: its end (a late binding, a refund
   * or a forfeiture) is not the user's to choose, so the flow goes back to following it.
   */
  const finishSelf = useCallback(
    async (signer: TransactionSigner, ticket: Address): Promise<"watch" | void> => {
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
          if (slot > w.expirySlot) return "watch";
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
        if (isParkedRefund(w))
          return finishWith({
            kind: "expired",
            signature: null,
            refund: { amount: w.payout, pending: true },
          });
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
        // a tab from an older deploy would read this ticket's end with its own layouts
        if (await reloadIfOlderBuild()) return;
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
    patch({
      phase: "drawing",
      driver: "self",
      stalled: false,
      windowClosed: false,
      failure: null,
      failedAt: null,
    });
    let follow = false;
    try {
      follow = (await finishSelf(signer, ticket)) === "watch";
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
    if (follow) {
      patch({ driver: "keeper" });
      void watch(ticket);
    }
  }, [patch, finishSelf, watch]);

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

/**
 * What an ended payout with no draw says: a forfeiture (the ticket stays with the vault), or its
 * vault credit refunded (the ticket price less the shares its opening paid), back to the wallet
 * or waiting in escrow.
 */
export function expiredWords(s: Pick<FlowState, "refund">): string {
  if (!s.refund) return "No draw in time: the ticket stays with the vault. Nothing else moved.";
  const amount = `${usdc(s.refund.amount)} USDC`;
  return s.refund.pending
    ? `No draw in time: ${amount} of the ticket waits in escrow, to be claimed.`
    : `No draw in time: ${amount} of the ticket came back to your wallet.`;
}

/**
 * Whether the line under the steps shows: only while the wallet has something to do, delivery
 * is late, or the window closed with no draw (the ticket's end is followed, nothing to sign).
 */
export const drawDetailShown = (s: FlowState): boolean =>
  s.phase === "drawing" && !!s.detail && (s.driver === "self" || s.stalled || s.windowClosed);

/**
 * Whether a stopped draw offers the wallet to finish it. Not once the window closed with no
 * draw: that end (a forfeiture, a late settlement, a refund) is not the wallet's to send, and
 * finishSelf would only go back to following it; following it again is all that is offered.
 */
export const takeOverOffered = (s: Pick<FlowState, "phase" | "failedAt" | "windowClosed">) =>
  s.phase === "failed" && s.failedAt === "drawing" && !s.windowClosed;

export function drawState(s: FlowState): string {
  if (s.phase === "done") return "Done";
  if (s.phase === "expired") return s.refund ? "Draw cancelled" : "No draw in time";
  if (s.phase === "failed") return "Stopped";
  return s.windowClosed ? "Closing" : "Drawing";
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
