// The state machine of the small-ticket demo, without React, so that the app,
// the tests (over litesvm) and the devnet check (apps/web/scripts) run the same
// code. The user signs once, the join; the round then closes at its tick, a
// keeper requests its one draw and pays its tickets out. The flow follows the
// round and the ticket on chain. If nothing moves for a while (no keeper runs
// the beacon on devnet yet), the user can finish with their own wallet:
// pay the draw of a round still unpaid, request the draw, then pay the ticket
// out; or close a draw that never came, or a round never paid once its refund
// window opens (its ticket price back); anyone may send those steps. Every
// transaction goes through `send`, which in the app simulates before the
// wallet is asked to sign (lib/tx.ts).
import type { Address, Instruction, Signature, TransactionSigner } from "@solana/kit";
import {
  RoundStatus,
  type Round,
  type RoundTicket,
} from "../../../../clients/js/src/generated/fade";
import { RoundDrawFulfilledError, type Held } from "../../../../clients/js/src/beacon/index.ts";
import {
  BEACON_TICKET_PRICE,
  JOIN_UNITS,
  REQUEST_UNITS,
  SPONSOR_UNITS,
  isFulfilled,
  planClaim,
  planClose,
  planJoin,
  planPayout,
  planReclaim,
  planRequest,
  planSponsor,
  predictOutcome,
  readBeacon,
  readWatch,
  stageOf,
  TicketInOtherRoundError,
  type AccountReader,
  type BeaconTarget,
  type JoinPlan,
  type Outcome,
  type Stage,
  type TicketWatch,
} from "./beacon";
import { sol, usdc } from "./format";
import type { ProgramFailure } from "./tx";

/** Fresh reads after a refused wallet step, to tell a step someone else already sent. */
const DONE_READS = 3;
/** A closed round nobody requests for this many slots (about 6 s) offers the wallet's own steps. */
export const STALL_SLOTS = 15n;
/**
 * A drawn ticket nobody pays out for this long offers the same, and so does
 * a round still waiting to be paid (the wallet can then pay its draw).
 */
export const STALL_MS = 10_000;
/**
 * A join refused in simulation, because rounds rotated between the read and
 * the simulation or its round stopped taking joins until its close, is
 * rebuilt this often.
 */
const JOIN_ATTEMPTS = 3;
/** Lamports kept aside for the fees of the join and of the wallet's own later steps. */
export const FEE_MARGIN = 50_000n;
/**
 * A join refused because its round stopped taking joins until its close
 * (`RoundEpochClosed`) waits this long, plus a second per slot left to that
 * close (a slot is about 400 ms), before it gives up.
 */
const CLOSE_WAIT_MS = 10_000;
/** A step of the wallet's own refused this often in a row (someone else moving the round) stops. */
const STEP_ATTEMPTS = 3;
/**
 * A ticket never read since its join, and read as gone, is read again for
 * this long before it is taken as gone: the read may come from a node that
 * has not seen the join yet.
 */
export const UNSEEN_MS = 10_000;

export type BeaconPhase =
  "idle" | "checking" | "signing" | "confirming" | "following" | "done" | "failed";

/** How the ticket ended. */
export type BeaconEnd =
  | { kind: "paid"; outcome: Outcome; parked: boolean }
  /** The round was forfeited (never drawn in time); the ticket was closed without a draw. */
  | { kind: "no-draw" }
  /**
   * The round was refunded: its ticket price came back, or, `parked`, waits
   * for this wallet's USDC account (which could not receive it) to claim it.
   */
  | { kind: "refunded"; parked: boolean }
  /**
   * The ticket is gone and how is not readable (its transactions could not be
   * read): `drawn` if its round was drawn, so it was paid out from the draw.
   */
  | { kind: "unknown"; drawn: boolean };

export type BeaconFlow = {
  phase: BeaconPhase;
  round: bigint | null;
  ticket: Address | null;
  stage: Stage | null;
  slot: bigint | null;
  /** Lamports the join carried to pay the draw, and fronted in all. */
  sponsorship: bigint | null;
  fronted: bigint | null;
  /** Of `fronted`, the lamports that do not come back: rents of one-time records the join creates. */
  kept: bigint | null;
  /** The wallet's sponsorship is still on the round after the ticket ended: it can be taken back. */
  sponsorshipLeft: boolean;
  sigs: {
    join?: Signature;
    sponsor?: Signature;
    request?: Signature;
    payout?: Signature;
    close?: Signature;
  };
  /** The join was confirmed: the ticket exists, and only then is it followed. */
  joined: boolean;
  /** Who moves the ticket after the join. */
  driver: "keeper" | "self";
  /** Nothing moved for a while: the wallet's own steps are offered. */
  stalled: boolean;
  /** What the wallet is being asked for, while it is. */
  asking: string | null;
  end: BeaconEnd | null;
  failure: ProgramFailure | null;
};

export const INITIAL_FLOW: BeaconFlow = {
  phase: "idle",
  round: null,
  ticket: null,
  stage: null,
  slot: null,
  sponsorship: null,
  fronted: null,
  kept: null,
  sponsorshipLeft: false,
  sigs: {},
  joined: false,
  driver: "keeper",
  stalled: false,
  asking: null,
  end: null,
  failure: null,
};

/** A refusal as the app shows it: the program's error name and message, when it is the program's. */
export type SendFailure = Error & { failure: ProgramFailure; pending: Signature | null };

export type FlowDeps = {
  reader: AccountReader;
  /**
   * Simulates, then signs and sends; throws a `SendFailure` with the
   * program's reason. Resolves once confirmed, with the slot it landed in.
   */
  send(
    signer: TransactionSigner,
    instructions: Instruction[],
    label: string,
    units: number,
    onSigned?: (signature: Signature) => void,
  ): Promise<{ signature: Signature; slot?: bigint }>;
  /** How a ticket that is gone was paid out, from its transactions; null if none. */
  findSettled(
    program: Address,
    ticket: Address,
  ): Promise<{ outcome: number; payout: bigint; parked: boolean; signature: Signature } | null>;
  /**
   * How the wallet's own landed close ended `ticket`, from its transaction:
   * its price refunded or not; null if not readable.
   */
  findReturned(
    program: Address,
    ticket: Address,
    signature: Signature,
  ): Promise<{ refunded: boolean; parked: boolean } | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /**
   * Told once a join confirms (the app wakes the keeper's beacon loop,
   * `wakeBeacon`). Fire-and-forget: never awaited, and whatever it throws or
   * rejects with is ignored, so it can never fail the join.
   */
  joined?(): unknown;
};

const isSendFailure = (e: unknown): e is SendFailure =>
  e instanceof Error && "failure" in e && typeof (e as SendFailure).failure === "object";

export const asFailure = (e: unknown): ProgramFailure =>
  isSendFailure(e)
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

/** A join the program refused because the round it named changed meanwhile: rebuilt, never resent. */
const rotated = (e: unknown) =>
  isSendFailure(e) &&
  (e.failure.name === "WrongRound" ||
    e.failure.name === "ConstraintSeeds" ||
    e.failure.name === "RoundNotAccepting");

/**
 * A join the program refused because its round, paid before the vault's
 * price close, takes no join from that close until its own close
 * (`RoundEpochClosed`, 6066): rebuilt once that round closed.
 */
const untilRoundCloses = (e: unknown) =>
  isSendFailure(e) && (e.failure.name === "RoundEpochClosed" || e.failure.code === 6066);

/** The SOL the wallet must hold for a join `plan`: what it fronts, plus the fees. */
export const joinNeed = (plan: Extract<JoinPlan, { ok: true }>) => plan.fronted + FEE_MARGIN;

/** Why a join is refused before anything is signed, as the app says it. */
export const joinRefusal = (plan: Extract<JoinPlan, { ok: false }>) =>
  plan.reason === "paused"
    ? "Shared draws are paused right now."
    : `This shared draw takes tickets from ${usdc(plan.minPrice)} USDC. Try again after it closes.`;

/** What a join by `signer` needs now, read before the button is pressed: its SOL, or why it is refused. */
export type JoinQuote = { ok: true; need: bigint; kept: bigint } | { ok: false; reason: string };

export async function quoteJoin(
  reader: AccountReader,
  target: BeaconTarget,
  signer: TransactionSigner,
  usdcAccount: Address,
): Promise<JoinQuote> {
  const snapshot = await readBeacon(reader, target, signer.address);
  const plan = await planJoin(snapshot, target, signer, usdcAccount, BEACON_TICKET_PRICE);
  return plan.ok
    ? { ok: true, need: joinNeed(plan), kept: plan.kept }
    : { ok: false, reason: joinRefusal(plan) };
}

export class BeaconTicketFlow {
  state: BeaconFlow = INITIAL_FLOW;
  private readonly deps: FlowDeps;
  private readonly target: BeaconTarget;
  private readonly onChange: (s: BeaconFlow) => void;
  private signer: TransactionSigner | null = null;
  private busy = false;
  private watchId = 0;
  /** The slot the join landed in: every later read comes from a node at that slot or later. */
  private joinSlot: bigint | undefined = undefined;
  /** The ticket was read at least once since its join. */
  private ticketSeen = false;

  constructor(deps: FlowDeps, target: BeaconTarget, onChange: (s: BeaconFlow) => void = () => {}) {
    this.deps = deps;
    this.target = target;
    this.onChange = onChange;
  }

  private patch(p: Partial<BeaconFlow>) {
    this.state = { ...this.state, ...p };
    this.onChange(this.state);
  }

  private sig(key: keyof BeaconFlow["sigs"], signature: Signature) {
    this.patch({ sigs: { ...this.state.sigs, [key]: signature } });
  }

  get isBusy() {
    return this.busy;
  }

  /** `deps.joined`, fire-and-forget: a notification that fails never fails the join. */
  private notifyJoined() {
    try {
      void Promise.resolve(this.deps.joined?.()).catch(() => {});
    } catch {
      // a notification that throws at once is ignored too
    }
  }

  /** Stops following (the demo went away, or a new ticket starts). */
  stop() {
    this.watchId++;
  }

  /**
   * Joins one ticket for `signer`, paying with `usdcAccount`; resolves once
   * the join is confirmed (true) or refused (false, the reason in `failure`).
   * Follows the ticket afterwards until it ends, without being awaited.
   */
  async start(signer: TransactionSigner, usdcAccount: Address): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    this.stop();
    this.signer = signer;
    this.joinSlot = undefined;
    this.ticketSeen = false;
    this.state = { ...INITIAL_FLOW, phase: "checking" };
    this.onChange(this.state);
    let joined = false;
    try {
      for (let attempt = 1; !joined; attempt++) {
        const snapshot = await readBeacon(this.deps.reader, this.target, signer.address);
        const plan = await planJoin(
          snapshot,
          this.target,
          signer,
          usdcAccount,
          BEACON_TICKET_PRICE,
        );
        if (!plan.ok) throw new Error(joinRefusal(plan));
        // The wallet fronts the rents and the draw while the ticket runs, plus the fees.
        const need = joinNeed(plan);
        const balance = await this.deps.reader.lamports(signer.address);
        if (balance < need)
          throw new Error(
            `This ticket needs about ${sol(need)} SOL in the wallet while it runs, and it holds ` +
              `${sol(balance)} SOL. Most of it comes back once the ticket is paid out.`,
          );
        this.patch({
          phase: "signing",
          round: plan.round,
          ticket: plan.ticket,
          sponsorship: plan.sponsorship,
          fronted: plan.fronted,
          kept: plan.kept,
          asking: "Approve in your wallet",
        });
        let signed = false;
        try {
          const sent = await this.deps.send(
            signer,
            plan.instructions,
            "join_round",
            JOIN_UNITS,
            (sig) => {
              signed = true;
              this.patch({ phase: "confirming", asking: "Confirming" });
              this.sig("join", sig);
            },
          );
          this.sig("join", sent.signature);
          this.joinSlot = sent.slot;
          joined = true;
          this.patch({ joined: true });
          this.notifyJoined();
        } catch (e) {
          // Only a refusal in simulation, before any signature, is rebuilt against fresh state.
          if (signed || attempt >= JOIN_ATTEMPTS) throw e;
          if (untilRoundCloses(e)) await this.untilClosed(snapshot.accepting?.data ?? null);
          else if (!rotated(e)) throw e;
        }
      }
      this.patch({ phase: "following", asking: null });
    } catch (e) {
      this.patch({ phase: "failed", asking: null, failure: asFailure(e) });
    } finally {
      this.busy = false;
    }
    if (joined) void this.follow();
    return joined;
  }

  /**
   * Waits until `round`, the paid round a join was refused into, reaches its
   * close slot: the next join then opens the next round.
   */
  private async untilClosed(round: Round | null) {
    if (!round || round.status !== RoundStatus.Paid) return;
    this.patch({ phase: "checking", asking: "This draw is closing. Joining the next one" });
    const { reader, sleep, now } = this.deps;
    let slot = await reader.slot();
    const until = now() + CLOSE_WAIT_MS + Number(round.closeSlot - slot) * 1_000;
    while (slot < round.closeSlot) {
      if (now() > until)
        throw new Error("This draw is taking longer than usual to close. Try again in a moment.");
      await sleep(500);
      slot = await reader.slot();
    }
  }

  /** "Finish with my wallet": the remaining steps, each simulated, then signed. */
  takeOver() {
    if (!this.state.joined || this.state.round === null || !this.state.ticket || !this.signer)
      return;
    this.patch({ driver: "self", phase: "following", failure: null });
    void this.follow();
  }

  /** Back to waiting for automatic delivery after a failed step. */
  watchAgain() {
    if (!this.state.joined || this.state.round === null || !this.state.ticket || !this.signer)
      return;
    this.patch({ driver: "keeper", phase: "following", failure: null });
    void this.follow();
  }

  private async watch(): Promise<TicketWatch> {
    const s = this.state;
    if (s.round === null || !s.ticket || !this.signer) throw new Error("no ticket");
    const read = (round: bigint) =>
      readWatch(
        this.deps.reader,
        this.target,
        round,
        s.ticket!,
        this.signer!.address,
        this.joinSlot,
      );
    try {
      return await read(s.round);
    } catch (e) {
      // The join landed in the next round (its accepting round closed
      // meanwhile): the ticket, at the address the flow derived, names its round.
      if (!(e instanceof TicketInOtherRoundError)) throw e;
      this.patch({ round: e.round });
      return read(e.round);
    }
  }

  /** Follows the round and the ticket until the ticket ends; drives it when the wallet took over. */
  async follow(): Promise<void> {
    const id = ++this.watchId;
    const alive = () => this.watchId === id;
    const ticket = this.state.ticket;
    if (!ticket || !this.signer) return;
    const signer = this.signer;
    let outcome: Outcome | null = null;
    let lastKind: Stage["kind"] | null = null;
    let since = this.deps.now();
    let attemptsLeft = STEP_ATTEMPTS;
    let refunded = false;
    // The ticket as last read, and whether its round was seen forfeited (or
    // forfeited by the wallet's own close): only that is a final no-draw. A
    // round merely expirable can still be drawn by a late fulfilment.
    let lastTicket: Held<RoundTicket> | null = null;
    let forfeitSeen = false;
    let unseenSince: number | null = null;
    while (alive()) {
      let w: TicketWatch;
      try {
        w = await this.watch();
      } catch {
        await this.deps.sleep(1_500);
        continue;
      }
      if (!alive()) return;
      const stage = stageOf(w);
      if (stage.kind === "refunded") refunded = true;
      if (stage.kind === "no-draw" && stage.forfeited) forfeitSeen = true;
      if (w.ticket) {
        lastTicket = w.ticket;
        this.ticketSeen = true;
      }
      const sponsorshipLeft = sponsorshipLeftOf(w);
      if (stage.kind !== lastKind) {
        lastKind = stage.kind;
        since = this.deps.now();
      }
      // The outcome is fixed once the round is drawn: predicted as the program computes it.
      if (!outcome && stage.kind === "drawn" && w.round && w.ticket)
        outcome = await predictOutcome(
          this.deps.reader,
          this.target,
          w.round,
          w.request,
          w.ticket,
        ).catch(() => null);
      const ended = (end: BeaconEnd) =>
        this.patch({
          phase: "done",
          stage,
          slot: w.slot,
          stalled: false,
          asking: null,
          sponsorshipLeft,
          end,
        });
      if (stage.kind === "paid" && w.ticket) {
        ended({
          kind: "paid",
          parked: true,
          outcome: outcome ?? { index: -1, payout: w.ticket.data.payout },
        });
        return;
      }
      // Returned, its ticket price held until it is claimed: nothing else moves it.
      if (stage.kind === "refund-held") {
        ended({ kind: "refunded", parked: true });
        return;
      }
      if (stage.kind === "gone") {
        const settled = await this.deps.findSettled(this.target.program, ticket).catch(() => null);
        if (!alive()) return;
        // Never read since the join: the read may be older than the join. Read
        // again for a while, unless its payout is already readable.
        if (!this.ticketSeen && !settled) {
          unseenSince ??= this.deps.now();
          if (this.deps.now() - unseenSince < UNSEEN_MS) {
            this.patch({ slot: w.slot });
            await this.deps.sleep(1_000);
            continue;
          }
        }
        if (refunded) ended({ kind: "refunded", parked: false });
        else if (settled) {
          if (!this.state.sigs.payout) this.sig("payout", settled.signature);
          ended({
            kind: "paid",
            parked: settled.parked,
            outcome: { index: settled.outcome, payout: settled.payout },
          });
        } else if (outcome) ended({ kind: "paid", parked: false, outcome });
        else {
          const end = await this.goneEnd(w, lastTicket, forfeitSeen);
          if (!alive()) return;
          ended(end);
        }
        return;
      }
      const stalled =
        (stage.kind === "closed" && w.slot >= stage.from + STALL_SLOTS) ||
        ((stage.kind === "drawn" || stage.kind === "waiting") &&
          this.deps.now() - since > STALL_MS) ||
        stage.kind === "no-draw" ||
        stage.kind === "refundable" ||
        stage.kind === "refunded";
      this.patch({ stage, slot: w.slot, stalled });

      // The wallet's own steps, once it took over.
      const step =
        this.state.driver !== "self" || this.busy
          ? null
          : stage.kind === "closed" && stage.canRequest
            ? "request"
            : stage.kind === "drawn"
              ? "payout"
              : stage.kind === "waiting"
                ? "sponsor"
                : stage.kind === "no-draw" ||
                    stage.kind === "refundable" ||
                    stage.kind === "refunded"
                  ? "close"
                  : null;
      if (step) {
        this.busy = true;
        try {
          const closed = await this.runStep(step, signer, w, (o) => {
            outcome = o;
          });
          // The wallet's own close landed, final whatever is read next: a
          // refund (the round was never paid, or its expiry refunded it) or
          // an expiry that forfeited it.
          if (closed === "refund") refunded = true;
          else if (closed === "forfeit") forfeitSeen = true;
          attemptsLeft = STEP_ATTEMPTS;
        } catch (e) {
          // Someone else may have moved the round meanwhile: read again before giving up.
          if (--attemptsLeft <= 0 || !isSendFailure(e) || e.pending) {
            this.patch({ phase: "failed", driver: "keeper", asking: null, failure: asFailure(e) });
            return;
          }
          this.patch({ asking: null });
        } finally {
          this.busy = false;
        }
        continue;
      }
      await this.deps.sleep(stage.kind === "closing" ? 500 : 1_000);
    }
  }

  /**
   * How a ticket that is gone ended when its payout event is not readable: from
   * its round, never by default a forfeiture. A drawn round paid it out (its
   * outcome recomputed from the draw and the ticket as last read, as the
   * program computes it); a forfeited one returned it; a refunded one refunded
   * it. A round that is gone too ended without a draw only if it was seen
   * forfeited (a forfeited round is never drawn, so no payout can follow);
   * a round only seen expirable may have been drawn late and paid out, and
   * an index that does not list the payout yet proves nothing.
   */
  private async goneEnd(
    w: TicketWatch,
    lastTicket: Held<RoundTicket> | null,
    forfeitSeen: boolean,
  ): Promise<BeaconEnd> {
    const round = w.round;
    if (!round) return forfeitSeen ? { kind: "no-draw" } : { kind: "unknown", drawn: false };
    const status = round.data.status;
    if (
      status === RoundStatus.Drawn ||
      (status === RoundStatus.Requested && isFulfilled(w.request))
    ) {
      const outcome = lastTicket
        ? await predictOutcome(this.deps.reader, this.target, round, w.request, lastTicket).catch(
            () => null,
          )
        : null;
      // A ticket paid out is gone; a payout held for its beneficiary keeps it (parked).
      return outcome ? { kind: "paid", parked: false, outcome } : { kind: "unknown", drawn: true };
    }
    if (status === RoundStatus.Forfeited) return { kind: "no-draw" };
    if (status === RoundStatus.Refunded) return { kind: "refunded", parked: false };
    return { kind: "unknown", drawn: false };
  }

  /**
   * One of the wallet's own steps; how it closed the ticket without a draw,
   * if it did: refunded (the round was never paid, or its expiry could no
   * longer find its request) or forfeited.
   */
  private async runStep(
    step: "sponsor" | "request" | "payout" | "close",
    signer: TransactionSigner,
    w: TicketWatch,
    onOutcome: (o: Outcome) => void,
  ): Promise<"refund" | "forfeit" | null> {
    const { reader, send } = this.deps;
    let close: Awaited<ReturnType<typeof planClose>> | null = null;
    if (step === "close") {
      try {
        close = await planClose(reader, this.target, signer, w);
      } catch (e) {
        // ORAO fulfilled the round's request since it was read: it is not
        // expired but drawn. A paid round binds that request late, then is
        // paid out; a requested one is paid out on the next read.
        if (!(e instanceof RoundDrawFulfilledError)) throw e;
        if (w.round?.data.status !== RoundStatus.Paid) return null;
        step = "request";
      }
    }
    if (step === "sponsor") {
      // The round as read is still unpaid: pay its draw now, as a sponsor
      // would (Spec 09 §5). Nothing to pay means it was paid meanwhile.
      const plan = await planSponsor(this.target, signer, w);
      if (!plan) return null;
      this.patch({ asking: "Approve paying the draw in your wallet" });
      const sent = await send(signer, [plan.instruction], "sponsor_round", SPONSOR_UNITS, () =>
        this.patch({ asking: "Paying the draw" }),
      );
      this.sig("sponsor", sent.signature);
    } else if (step === "request") {
      const ix = await planRequest(reader, this.target, signer, w);
      this.patch({ asking: "Approve the draw request in your wallet" });
      const sent = await send(signer, [ix], "request_round_draw", REQUEST_UNITS, () =>
        this.patch({ asking: "Requesting the draw" }),
      );
      this.sig("request", sent.signature);
    } else if (step === "payout") {
      const plan = await planPayout(reader, this.target, signer, w);
      onOutcome(plan.outcome);
      this.patch({ asking: "Approve the payout in your wallet" });
      const sent = await send(signer, plan.instructions, "settle_round_tickets", plan.units, () =>
        this.patch({ asking: "Paying out" }),
      );
      this.sig("payout", sent.signature);
    } else if (close) {
      const status = w.round?.data.status;
      this.patch({ asking: "Approve closing the ticket in your wallet" });
      const label = status === RoundStatus.Accepting ? "refund_round" : "return_round_ticket";
      const sent = await send(signer, close.instructions, label, close.units, () =>
        this.patch({ asking: "Closing" }),
      );
      this.sig("close", sent.signature);
      this.patch({ asking: null });
      // The landed transaction tells: the plan's prediction can be overtaken
      // (SlotHashes stops proving the round's seed between the plan and the
      // landing, and the expiry then refunds), so it is only the fallback.
      const ticket = this.state.ticket;
      const landed = ticket
        ? await this.deps
            .findReturned(this.target.program, ticket, sent.signature)
            .catch(() => null)
        : null;
      return (landed?.refunded ?? close.refund) ? "refund" : "forfeit";
    }
    this.patch({ asking: null });
    return null;
  }

  /**
   * A payout, or a returned ticket price, held for the wallet's USDC
   * account, claimed once it can receive.
   */
  async claim(): Promise<void> {
    await this.single(
      "claim_round_payout",
      async (signer, w) => planClaim(this.target, signer, w),
      () => {
        const end = this.state.end;
        if (end?.kind === "paid" || end?.kind === "refunded")
          this.patch({ end: { ...end, parked: false } });
      },
    );
  }

  /** The unused part of the wallet's sponsorship, once the round is drawn or closed without a draw. */
  async reclaim(): Promise<void> {
    await this.single(
      "reclaim_sponsorship",
      async (signer, w) => planReclaim(this.target, signer, w),
      () => this.patch({ sponsorshipLeft: false }),
      // The keeper reclaims every sponsorship of an ended round: one it took back
      // first is back with the wallet, not a failure.
      (w) => !sponsorshipLeftOf(w),
    );
  }

  /**
   * Sends one wallet step. `done` tells, from a fresh read, that the step's
   * effect is already there (someone else sent it): then nothing is sent, or a
   * refusal is read again and ends the step without a failure.
   */
  private async single(
    label: string,
    build: (signer: TransactionSigner, w: TicketWatch) => Promise<Instruction>,
    after: () => void,
    done?: (w: TicketWatch) => boolean,
  ) {
    const signer = this.signer;
    if (!signer || this.busy) return;
    this.busy = true;
    const finish = () => {
      this.patch({ failure: null });
      after();
    };
    try {
      const w = await this.watch();
      if (done?.(w)) return finish();
      const sent = await this.deps.send(signer, [await build(signer, w)], label, 60_000);
      this.sig("close", sent.signature);
      finish();
    } catch (e) {
      for (let i = 0; done && i < DONE_READS; i++) {
        const w = await this.watch().catch(() => null);
        if (w && done(w)) return finish();
        await this.deps.sleep(1_000);
      }
      this.patch({ failure: asFailure(e) });
    } finally {
      this.busy = false;
    }
  }

  /** Back to a fresh demo, unless a step is being signed. */
  reset(): boolean {
    if (this.busy) return false;
    this.stop();
    this.state = INITIAL_FLOW;
    this.onChange(this.state);
    return true;
  }
}

/**
 * Whether the wallet's sponsorship is still there to take back. A round closes
 * only once every sponsorship is reclaimed, so a sponsorship read next to a
 * closed round is a lagging read: the keeper reclaimed it, and its lamports
 * are back with the wallet.
 */
export const sponsorshipLeftOf = (w: Pick<TicketWatch, "round" | "sponsorship">) =>
  w.sponsorship !== null && w.round !== null;

export const isBeaconBusy = (s: BeaconFlow) =>
  s.phase === "checking" ||
  s.phase === "signing" ||
  s.phase === "confirming" ||
  s.phase === "following";
