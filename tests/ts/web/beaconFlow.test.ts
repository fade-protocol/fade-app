// The small-ticket demo's flow (apps/web/src/lib/beaconFlow.ts), the code the
// app runs behind its button, end to end in litesvm: every transaction it
// sends is simulated, then sent (`BeaconEnv.send`), as plain v0. Time moves
// only when the flow sleeps (each sleep advances the slot as devnet would) or
// when a test sets the slot (holding the flow's clock to read at that slot);
// ORAO fulfils a request on the next sleep after it is made. Three endings:
// the wallet finishing on its own (no keeper runs the beacon on devnet yet),
// a keeper finishing it while the flow only watches, and a draw never
// requested, closed by the wallet with no payout.
import { describe, expect, it } from "vitest";
import {
  generateKeyPairSigner,
  getBase58Decoder,
  lamports,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import {
  FADE_PROGRAM_ADDRESS,
  RoundStatus,
  ROUND_EXPIRED_EVENT_DISCRIMINATOR,
  findIntegratorPda,
  findRoundVrfPda,
  getIntegratorSize,
  getRoundDecoder,
  getRoundExpiredEventDecoder,
  type RoundExpiredEvent,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  ORAO_REQUEST_FEE_OFFSET,
  SLOT_HASHES_SYSVAR,
  findOraoNetworkStatePda,
  findPayoutTablePda,
  findRoundPda,
  roundRequestAddress,
} from "../../../clients/js/src/beacon/index.ts";
import {
  BEACON_PAYOUT_TABLE,
  BEACON_TICKET_PRICE,
  ROUND_PIN_SPONSORSHIP,
  planPayout,
  planReclaim,
  planRequest,
  readWatch,
  returnedEventOf,
  settledEventOf,
  stageOf,
  type AccountReader,
  type BeaconTarget,
} from "../../../apps/web/src/lib/beacon.ts";
import {
  BeaconTicketFlow,
  FEE_MARGIN,
  STALL_SLOTS,
  quoteJoin,
  sponsorshipLeftOf,
  type BeaconFlow,
  type FlowDeps,
} from "../../../apps/web/src/lib/beaconFlow.ts";
import { BeaconEnv, ORAO_FEE, SPEC_PARAMS, USDC, USDC_MINT, type Sent } from "../fade/beaconEnv.ts";

const DEMO_PARAMS = {
  ...SPEC_PARAMS,
  beaconMinPrice: 100_000n,
  beaconThreshold: 9_790_000n,
  crankRoundSettleLamports: 5_000n,
};
const TARGET: BeaconTarget = { program: FADE_PROGRAM_ADDRESS, usdcMint: USDC_MINT };
const SLOT_MS = 400;
/** One signature at the base fee: the flow's v0 transactions carry no priority fee in litesvm. */
const FEE = 5_000n;

/** Sets ORAO's request fee in its network state (`ORAO_REQUEST_FEE_OFFSET`). */
async function setOraoFee(env: BeaconEnv, fee: bigint) {
  const [state] = await findOraoNetworkStatePda();
  const data = new Uint8Array(env.data(state));
  new DataView(data.buffer).setBigUint64(ORAO_REQUEST_FEE_OFFSET, fee, true);
  env.put(state, data, env.account(state)!.owner);
}

type Harness = {
  env: BeaconEnv;
  deps: FlowDeps;
  /** Every transaction sent, with the label the flow gave it. */
  sent: { label: string; signature: Signature; result: Sent }[];
  /** Called on every sleep, after the slot moved: a keeper's turn, if any. */
  onSleep: (() => Promise<void>) | null;
  sleeps: number;
  /** ORAO answers requests (false: it withholds every draw). */
  oraoAnswers: boolean;
  /** The join is signed, then lands with this error instead of being sent. */
  joinLandsWith: string | null;
  /** Reading a ticket's transactions fails, as on a rate-limited RPC. */
  findSettledFails: boolean;
  /** The ticket's transactions are not indexed yet: `findSettled` finds none, without an error. */
  findSettledLags: boolean;
  /** `join_round` calls, refused ones included. */
  joinCalls: number;
  /** Runs at each `join_round` call, before anything is simulated. */
  beforeJoin: ((call: number) => Promise<void> | void) | null;
  /** Reads served by a node that has not seen the join yet, counted from its confirmation. */
  staleReadsAfterJoin: number;
  /** The `minContextSlot` of every account read, as the flow asked for it. */
  minContextSlots: (bigint | undefined)[];
  /** Requests already fulfilled by the stand-in (or by a test, directly). */
  fulfilled: Set<Address>;
  /** The slot the join was confirmed at. */
  joinSlot: bigint | null;
  /** Runs before each account read is served. */
  onAccounts: ((addresses: readonly Address[]) => Promise<void>) | null;
  /** Runs once a transaction is built and approved, before it is sent. */
  beforeSend: ((label: string) => Promise<void> | void) | null;
  /** Reading the wallet's landed close fails: the flow falls back on its plan. */
  findReturnedFails: boolean;
  /** While set, each sleep waits for it before moving the slot (`holdClock`). */
  clockHeld: Promise<void> | null;
};

async function harness(): Promise<Harness> {
  const env = await BeaconEnv.create(DEMO_PARAMS);
  let staleLeft = 0;
  const reader: AccountReader = {
    // A lagging node answers as if the join had not landed: none of what it created exists.
    accounts: async (addresses, minContextSlot) => {
      h.minContextSlots.push(minContextSlot);
      if (h.onAccounts) await h.onAccounts(addresses);
      if (staleLeft > 0) {
        staleLeft--;
        return addresses.map(() => null);
      }
      return addresses.map((a) => env.account(a));
    },
    slot: async () => env.slot(),
    rent: async (space) => env.svm.client.minimumBalanceForRentExemption(BigInt(space)),
    lamports: async (a) => env.lamports(a),
  };
  const h: Harness = {
    env,
    deps: null as unknown as FlowDeps,
    sent: [],
    onSleep: null,
    sleeps: 0,
    oraoAnswers: true,
    joinLandsWith: null,
    findSettledFails: false,
    findSettledLags: false,
    joinCalls: 0,
    beforeJoin: null,
    staleReadsAfterJoin: 0,
    minContextSlots: [],
    fulfilled: new Set<Address>(),
    joinSlot: null,
    onAccounts: null,
    beforeSend: null,
    findReturnedFails: false,
    clockHeld: null,
  };
  const fulfilled = h.fulfilled;
  h.deps = {
    reader,
    async send(signer, instructions: Instruction[], label, units, onSigned) {
      if (label === "join_round") {
        h.joinCalls++;
        if (h.beforeJoin) await h.beforeJoin(h.joinCalls);
      }
      if (label === "join_round" && h.joinLandsWith) {
        onSigned?.(getBase58Decoder().decode(new Uint8Array(64).fill(7)) as Signature);
        throw Object.assign(new Error(h.joinLandsWith), {
          failure: { code: 6000, name: h.joinLandsWith, message: h.joinLandsWith, logs: [] },
          pending: null,
        });
      }
      if (h.beforeSend) await h.beforeSend(label);
      let result: Sent;
      try {
        result = await env.send(signer as KeyPairSigner, instructions, { format: 0, units });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw Object.assign(new Error(message), {
          failure: {
            code: null,
            name: /Error Code: (\w+)/.exec(message)?.[1] ?? null,
            message,
            logs: [],
          },
          pending: null,
        });
      }
      const signature = getBase58Decoder().decode(result.meta.signature()) as Signature;
      onSigned?.(signature);
      h.sent.push({ label, signature, result });
      if (label === "join_round") {
        staleLeft = h.staleReadsAfterJoin;
        h.joinSlot = env.slot();
      }
      return { signature, slot: env.slot() };
    },
    async findSettled(_program, ticket) {
      if (h.findSettledFails) throw new Error("429 Too Many Requests");
      if (h.findSettledLags) return null;
      for (const s of [...h.sent].reverse()) {
        for (const ix of s.result.meta.innerInstructions().flat()) {
          const e = settledEventOf(new Uint8Array(ix.instruction().data()), ticket);
          if (e) return { ...e, signature: s.signature };
        }
      }
      return null;
    },
    async findReturned(_program, ticket, signature) {
      if (h.findReturnedFails) throw new Error("429 Too Many Requests");
      const s = h.sent.find((x) => x.signature === signature);
      for (const ix of s?.result.meta.innerInstructions().flat() ?? []) {
        const e = returnedEventOf(new Uint8Array(ix.instruction().data()), ticket);
        if (e) return e;
      }
      return null;
    },
    async sleep(ms) {
      if (++h.sleeps > 2_000) throw new Error("the flow never ended");
      while (h.clockHeld) await h.clockHeld;
      env.setSlot(env.slot() + BigInt(Math.max(1, Math.round(ms / SLOT_MS))));
      // ORAO answers every pending request of a requested round on the next sleep.
      const vault = await env.vault();
      for (let id = 1n; id < vault.nextRoundId; id++) {
        const [round] = await findRoundPda(id);
        const r = env.account(round);
        if (!r || r.data.length === 0) continue;
        const data = getRoundDecoder().decode(r.data);
        if (!h.oraoAnswers) continue;
        if (data.status !== RoundStatus.Requested || fulfilled.has(data.randomness)) continue;
        const [roundVrf] = await findRoundVrfPda({ round });
        await env.fulfill(
          data.randomness,
          roundVrf,
          new Uint8Array(64).fill(Number(id % 200n) + 3),
        );
        fulfilled.add(data.randomness);
      }
      if (h.onSleep) await h.onSleep();
    },
    now: () => h.sleeps * 1_000,
  };
  return h;
}

async function wallet(env: BeaconEnv) {
  const signer = await env.svm.fundedWallet(1);
  return { signer, usdc: await env.usdcAccount(signer.address, 10n * USDC) };
}

/** The `RoundExpired` event a sent transaction emitted, if any. */
function expiredEventOf(result: Sent): RoundExpiredEvent | null {
  for (const ix of result.meta.innerInstructions().flat()) {
    const data = new Uint8Array(ix.instruction().data());
    if (data.length < 16) continue;
    if (!ROUND_EXPIRED_EVENT_DISCRIMINATOR.every((b, i) => data[8 + i] === b)) continue;
    return getRoundExpiredEventDecoder().decode(data.subarray(8));
  }
  return null;
}

/**
 * Stops the flow's sleeps from moving the slot until the returned release is
 * called: the flow keeps running in the background, so a test that sets the
 * slot and reads at it holds the clock, or a sleep of the flow can move the
 * slot between the two.
 */
function holdClock(h: Harness): () => void {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  h.clockHeld = held;
  return () => {
    if (h.clockHeld === held) h.clockHeld = null;
    release();
  };
}

/** Lets the flow's loop run until it ends. */
async function ended(flow: BeaconTicketFlow): Promise<BeaconFlow> {
  for (let i = 0; i < 10_000; i++) {
    if (flow.state.phase === "done" || flow.state.phase === "failed") return flow.state;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`still ${flow.state.phase}`);
}

describe("the small-ticket demo's flow", () => {
  it("joins, shows the close tick, then the wallet finishes alone and is paid out", async () => {
    const h = await harness();
    const u = await wallet(h.env);
    const seen: BeaconFlow[] = [];
    const flow = new BeaconTicketFlow(h.deps, TARGET, (s) => seen.push(s));
    const usdcBefore = h.env.balance(u.usdc);
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    expect(flow.state.sigs.join).toBeDefined();
    // No keeper: the wallet takes over at once and sends every step itself.
    flow.takeOver();
    const end = await ended(flow);
    expect(end.phase).toBe("done");
    expect(end.failure).toBeNull();
    expect(h.sent.map((s) => s.label)).toEqual([
      "join_round",
      "request_round_draw",
      "settle_round_tickets",
    ]);
    // The close tick was shown, counting down to the round's close slot.
    const ticks = seen.flatMap((s) => (s.stage?.kind === "closing" ? [s.stage] : []));
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.at(-1)!.slotsLeft).toBeLessThan(ticks[0]!.slotsLeft + 1n);
    expect(ticks[0]!.closeSlot % DEMO_PARAMS.tickSlots).toBe(0n);
    // Then closed, drawing, drawn, in that order.
    const kinds = [...new Set(seen.map((s) => s.stage?.kind).filter(Boolean))];
    expect(kinds).toEqual(["closing", "closed", "drawing", "drawn", "gone"]);
    // The result shown is the program's: the event of the payout, and the USDC moved.
    expect(end.end?.kind).toBe("paid");
    const result = end.end!.kind === "paid" ? end.end!.outcome : null;
    const event = await h.deps.findSettled(FADE_PROGRAM_ADDRESS, end.ticket!);
    expect(result).toEqual({ index: event!.outcome, payout: event!.payout });
    expect(h.env.balance(u.usdc)).toBe(usdcBefore - BEACON_TICKET_PRICE + event!.payout);
    // The sponsorship was reclaimed with the payout, and the round closed.
    expect(end.sponsorshipLeft).toBe(false);
    const w = await readWatch(h.deps.reader, TARGET, end.round!, end.ticket!, u.signer.address);
    expect(w.round).toBeNull();
  });

  it("watches a keeper finish it, then takes back the sponsorship the keeper left", async () => {
    const h = await harness();
    const u = await wallet(h.env);
    const keeper = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    let stalledSeen = false;
    // The keeper is late: it requests only once the flow offers the wallet's own steps.
    h.onSleep = async () => {
      const s = flow.state;
      if (s.round === null || !s.ticket) return;
      if (s.stalled) stalledSeen = true;
      const w = await readWatch(h.deps.reader, TARGET, s.round, s.ticket, keeper.signer.address);
      const stage = stageOf(w);
      if (stage.kind === "closed" && w.slot >= stage.from + STALL_SLOTS + 2n)
        await h.deps.send(
          keeper.signer,
          [await planRequest(h.deps.reader, TARGET, keeper.signer, w)],
          "keeper request",
          200_000,
        );
      if (stage.kind === "drawn") {
        const p = await planPayout(h.deps.reader, TARGET, keeper.signer, w);
        await h.deps.send(keeper.signer, p.instructions, "keeper payout", p.units);
      }
    };
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    const end = await ended(flow);
    expect(stalledSeen).toBe(true);
    expect(end.driver).toBe("keeper");
    expect(end.end?.kind).toBe("paid");
    expect(h.sent.map((s) => s.label)).toEqual(["join_round", "keeper request", "keeper payout"]);
    // The payout's signature is the keeper's, read from the ticket's transactions.
    expect(end.sigs.payout).toBe(h.sent[2]!.signature);
    // The keeper did not reclaim this wallet's sponsorship: the demo offers it, and it comes back.
    expect(end.sponsorshipLeft).toBe(true);
    h.onSleep = null;
    const before = h.env.lamports(u.signer.address);
    await flow.reclaim();
    expect(flow.state.sponsorshipLeft).toBe(false);
    expect(flow.state.failure).toBeNull();
    expect(h.env.lamports(u.signer.address)).toBeGreaterThan(before);
  });

  it("ends the take-back without a failure when the keeper reclaimed the sponsorship first", async () => {
    const h = await harness();
    const u = await wallet(h.env);
    const keeper = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    h.onSleep = async () => {
      const s = flow.state;
      if (s.round === null || !s.ticket) return;
      const w = await readWatch(h.deps.reader, TARGET, s.round, s.ticket, keeper.signer.address);
      const stage = stageOf(w);
      if (stage.kind === "closed" && w.slot >= stage.from + STALL_SLOTS + 2n)
        await h.deps.send(
          keeper.signer,
          [await planRequest(h.deps.reader, TARGET, keeper.signer, w)],
          "keeper request",
          200_000,
        );
      if (stage.kind === "drawn") {
        const p = await planPayout(h.deps.reader, TARGET, keeper.signer, w);
        await h.deps.send(keeper.signer, p.instructions, "keeper payout", p.units);
      }
    };
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    const end = await ended(flow);
    expect(end.sponsorshipLeft).toBe(true);
    h.onSleep = null;
    // The keeper's reclaim lands between the offer and the click; the round closes.
    // Read as the wallet's: its sponsorship, which anyone may reclaim to it.
    const w = await readWatch(h.deps.reader, TARGET, end.round!, end.ticket!, u.signer.address);
    await h.deps.send(
      keeper.signer,
      [await planReclaim(TARGET, keeper.signer, w)],
      "keeper reclaim",
      60_000,
    );
    const sent = h.sent.length;
    await flow.reclaim();
    expect(flow.state.sponsorshipLeft).toBe(false);
    expect(flow.state.failure).toBeNull();
    expect(h.sent.length).toBe(sent);
  });

  it("closes a ticket whose draw never came, with no payout", async () => {
    const h = await harness();
    const u = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    // Nobody requests; time runs past the request window.
    h.onSleep = async () => {
      if (flow.state.stage?.kind === "closed") h.env.setSlot(h.env.slot() + 200n);
    };
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    for (let i = 0; i < 10_000 && flow.state.stage?.kind !== "no-draw"; i++)
      await new Promise((r) => setTimeout(r, 0));
    expect(flow.state.stage).toEqual({ kind: "no-draw", forfeited: false });
    expect(flow.state.stalled).toBe(true);
    const usdcBefore = h.env.balance(u.usdc);
    flow.takeOver();
    const end = await ended(flow);
    expect(end.end).toEqual({ kind: "no-draw" });
    expect(h.sent.map((s) => s.label)).toEqual(["join_round", "return_round_ticket"]);
    expect(h.env.balance(u.usdc)).toBe(usdcBefore);
    expect(end.sponsorshipLeft).toBe(false);
  });

  it("offers the way out of a requested draw ORAO never answered, and closes it", async () => {
    const h = await harness();
    h.oraoAnswers = false;
    const u = await wallet(h.env);
    const keeper = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    const kinds: string[] = [];
    // A keeper requests the draw on time; ORAO withholds it past T_SETTLE.
    h.onSleep = async () => {
      const s = flow.state;
      if (s.round === null || !s.ticket) return;
      if (s.stage && kinds.at(-1) !== s.stage.kind) kinds.push(s.stage.kind);
      const w = await readWatch(h.deps.reader, TARGET, s.round, s.ticket, keeper.signer.address);
      const stage = stageOf(w);
      if (stage.kind === "closed" && stage.canRequest)
        await h.deps.send(
          keeper.signer,
          [await planRequest(h.deps.reader, TARGET, keeper.signer, w)],
          "keeper request",
          200_000,
        );
    };
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    for (let i = 0; i < 10_000 && flow.state.stage?.kind !== "no-draw"; i++)
      await new Promise((r) => setTimeout(r, 0));
    expect(kinds).toContain("drawing");
    expect(flow.state.stage).toEqual({ kind: "no-draw", forfeited: false });
    expect(flow.state.stalled).toBe(true);
    const usdcBefore = h.env.balance(u.usdc);
    const solBefore = h.env.lamports(u.signer.address);
    h.onSleep = null;
    flow.takeOver();
    const end = await ended(flow);
    expect(end.phase).toBe("done");
    expect(end.end).toEqual({ kind: "no-draw" });
    expect(h.sent.map((s) => s.label)).toEqual([
      "join_round",
      "keeper request",
      "return_round_ticket",
    ]);
    // One transaction: the expiry of the requested round, the return, the reclaim.
    const close = h.sent[2]!.result;
    expect(expiredEventOf(close)?.requested).toBe(true);
    // The ticket price stays with the vault; the prepay and the sponsorship come back.
    expect(h.env.balance(u.usdc)).toBe(usdcBefore);
    expect(h.env.lamports(u.signer.address)).toBeGreaterThan(solBefore);
    expect(end.sponsorshipLeft).toBe(false);
  });

  it("closes its own requested draw that ORAO never answered", async () => {
    const h = await harness();
    h.oraoAnswers = false;
    const u = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    flow.takeOver();
    const end = await ended(flow);
    expect(end.phase).toBe("done");
    expect(end.end).toEqual({ kind: "no-draw" });
    expect(h.sent.map((s) => s.label)).toEqual([
      "join_round",
      "request_round_draw",
      "return_round_ticket",
    ]);
    expect(expiredEventOf(h.sent[2]!.result)?.requested).toBe(true);
    expect(end.sponsorshipLeft).toBe(false);
  });

  it("wakes the keeper once its join confirms, and a failed wake never fails the join", async () => {
    for (const fails of ["rejects", "throws", "hangs"] as const) {
      const h = await harness();
      const u = await wallet(h.env);
      let wakes = 0;
      const flow = new BeaconTicketFlow(
        {
          ...h.deps,
          joined: () => {
            wakes++;
            // the join's signature is known before the keeper is told
            expect(flow.state.sigs.join).toBeDefined();
            if (fails === "throws") throw new Error("offline");
            return fails === "rejects"
              ? Promise.reject(new Error("HTTP 500"))
              : new Promise(() => {});
          },
        },
        TARGET,
      );
      expect(await flow.start(u.signer, u.usdc)).toBe(true);
      expect(wakes).toBe(1);
      expect(flow.state.joined).toBe(true);
      expect(flow.state.failure).toBeNull();
      flow.stop();
    }
  });

  it("tells the keeper nothing about a join refused on chain", async () => {
    const h = await harness();
    h.joinLandsWith = "WrongRound";
    const u = await wallet(h.env);
    let wakes = 0;
    const flow = new BeaconTicketFlow({ ...h.deps, joined: () => wakes++ }, TARGET);
    expect(await flow.start(u.signer, u.usdc)).toBe(false);
    expect(wakes).toBe(0);
  });

  it("follows nothing after a join that was signed but refused on chain", async () => {
    const h = await harness();
    h.joinLandsWith = "WrongRound";
    const u = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    expect(await flow.start(u.signer, u.usdc)).toBe(false);
    expect(flow.state.phase).toBe("failed");
    expect(flow.state.joined).toBe(false);
    expect(flow.state.failure?.name).toBe("WrongRound");
    // Refused after the wallet signed: never rebuilt, never sent again.
    expect(h.joinCalls).toBe(1);
    // Neither follow-up is offered for a ticket that never existed.
    flow.watchAgain();
    flow.takeOver();
    for (let i = 0; i < 200; i++) await new Promise((r) => setTimeout(r, 0));
    expect(flow.state.phase).toBe("failed");
    expect(flow.state.end).toBeNull();
    expect(h.sent).toHaveLength(0);
  });

  it("rebuilds a join the program refused in simulation because the rounds rotated, and lands it", async () => {
    const h = await harness();
    const first = await wallet(h.env);
    const third = await wallet(h.env);
    const u = await wallet(h.env);
    // Someone else's ticket pays round 1, which takes joins until its close.
    const other = new BeaconTicketFlow(h.deps, TARGET);
    expect(await other.start(first.signer, first.usdc)).toBe(true);
    other.stop();
    expect(other.state.round).toBe(1n);
    const closeOf = async (id: bigint) =>
      getRoundDecoder().decode(h.env.data((await findRoundPda(id))[0])).closeSlot;
    // Between the flow's read and its simulation the rounds rotate twice:
    // round 1 closes, a third ticket opens and pays round 2, round 2 closes.
    // The join names rounds 1 and 2 and must now create round 3: refused.
    h.beforeJoin = async (call) => {
      if (call !== 2) return;
      h.env.setSlot(await closeOf(1n));
      const rotating = new BeaconTicketFlow(h.deps, TARGET);
      expect(await rotating.start(third.signer, third.usdc)).toBe(true);
      rotating.stop();
      expect(rotating.state.round).toBe(2n);
      h.env.setSlot(await closeOf(2n));
    };
    const planned: (bigint | null)[] = [];
    const flow = new BeaconTicketFlow(h.deps, TARGET, (s) => {
      if (s.phase === "signing") planned.push(s.round);
    });
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    flow.stop();
    // Refused once before any signature, rebuilt against fresh state, landed:
    // one join_round of the wallet's own refused, one sent.
    expect(h.joinCalls).toBe(4);
    expect(planned).toEqual([1n, 3n]);
    expect(flow.state.joined).toBe(true);
    expect(flow.state.failure).toBeNull();
    expect(h.sent.map((s) => s.label)).toEqual(["join_round", "join_round", "join_round"]);
    // The ticket is in the round that accepted it then.
    expect(flow.state.round).toBe(3n);
    const w = await readWatch(h.deps.reader, TARGET, 3n, flow.state.ticket!, u.signer.address);
    expect(w.ticket?.data.round).toBe(3n);
  });

  it("rebuilds a join whose round closed before it landed, so the ticket never lands unpaid", async () => {
    const h = await harness();
    const first = await wallet(h.env);
    const u = await wallet(h.env);
    const other = new BeaconTicketFlow(h.deps, TARGET);
    expect(await other.start(first.signer, first.usdc)).toBe(true);
    other.stop();
    const [round1] = await findRoundPda(1n);
    const close = getRoundDecoder().decode(h.env.data(round1)).closeSlot;
    // Round 1, already paid, closes between the read and the landing. Without
    // a sponsorship the program would land the join in round 2, created
    // unpaid (Spec 08 §13.5.2). The join names round 1's sponsorship record
    // (`ROUND_PIN_SPONSORSHIP`), so it is refused in simulation instead and
    // rebuilt with the sponsorship that pays round 2 at once.
    const planned: { round: bigint | null; sponsorship: bigint | null }[] = [];
    h.beforeJoin = (call) => {
      if (call === 2) h.env.setSlot(close);
    };
    const flow = new BeaconTicketFlow(h.deps, TARGET, (s) => {
      if (s.phase === "signing") planned.push({ round: s.round, sponsorship: s.sponsorship });
    });
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    expect(h.joinCalls).toBe(3);
    expect(planned[0]).toEqual({ round: 1n, sponsorship: ROUND_PIN_SPONSORSHIP });
    expect(planned[1]!.round).toBe(2n);
    expect(planned[1]!.sponsorship).toBeGreaterThan(ROUND_PIN_SPONSORSHIP);
    for (let i = 0; i < 10_000 && !flow.state.stage; i++)
      await new Promise((r) => setTimeout(r, 0));
    flow.stop();
    expect(flow.state.round).toBe(2n);
    expect(flow.state.stage?.kind).toBe("closing");
    const r2 = getRoundDecoder().decode(h.env.data((await findRoundPda(2n))[0]));
    expect(r2.status).toBe(RoundStatus.Paid);
  });

  it("follows the ticket into the round it landed in, read from the ticket", async () => {
    const h = await harness();
    const u = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    flow.stop();
    expect(flow.state.round).toBe(1n);
    // A flow that believes the ticket is in another round (as after a join
    // that landed elsewhere) follows the round the ticket stores.
    flow.state = { ...flow.state, round: 7n };
    void flow.follow();
    for (let i = 0; i < 10_000 && !flow.state.stage; i++)
      await new Promise((r) => setTimeout(r, 0));
    flow.stop();
    expect(flow.state.round).toBe(1n);
    expect(flow.state.stage?.kind).toBe("closing");
  });

  it("refunds a ticket whose round was never paid, once its refund window opens", async () => {
    const h = await harness();
    const u = await wallet(h.env);
    // ORAO's fee rises between the read and the landing: the round the join
    // creates snapshots the new fee, so the sponsorship computed from the old
    // one no longer pays it, and the round stays `Accepting`.
    h.beforeJoin = async (call) => {
      if (call === 1) await setOraoFee(h.env, ORAO_FEE * 2n);
    };
    const usdcBefore = h.env.balance(u.usdc);
    const solBefore = h.env.lamports(u.signer.address);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    const r1 = async () => getRoundDecoder().decode(h.env.data((await findRoundPda(1n))[0]));
    expect((await r1()).status).toBe(RoundStatus.Accepting);
    // Nobody pays it; time runs to the refund window.
    const opens = (await r1()).firstSlot + (await r1()).refundSlots;
    for (let i = 0; i < 10_000 && flow.state.stage?.kind !== "waiting"; i++)
      await new Promise((r) => setTimeout(r, 0));
    // The slot just before the window opens, read while the flow's clock is
    // held: still waiting. Then the slot it opens at.
    const release = holdClock(h);
    h.env.setSlot(opens - 1n);
    expect(
      stageOf(await readWatch(h.deps.reader, TARGET, 1n, flow.state.ticket!, u.signer.address)),
    ).toEqual({ kind: "waiting" });
    h.env.setSlot(opens);
    release();
    for (let i = 0; i < 10_000 && flow.state.stage?.kind !== "refundable"; i++)
      await new Promise((r) => setTimeout(r, 0));
    expect(flow.state.stalled).toBe(true);
    flow.takeOver();
    const end = await ended(flow);
    expect(end.phase).toBe("done");
    expect(end.end).toEqual({ kind: "refunded", parked: false });
    expect(end.failure).toBeNull();
    // One transaction: the refund, the return of the ticket and the reclaim.
    expect(h.sent.map((s) => s.label)).toEqual(["join_round", "refund_round"]);
    expect(end.sponsorshipLeft).toBe(false);
    // The 0.10 USDC came back to the unit, and every lamport but the two
    // fees and the rents of the records the join created for good (the
    // integrator and the payout table): the round and the ticket are closed.
    expect(h.env.balance(u.usdc)).toBe(usdcBefore);
    const [integrator] = await findIntegratorPda({ integratorAuthority: u.signer.address });
    const [table] = await findPayoutTablePda(BEACON_PAYOUT_TABLE);
    const kept = h.env.lamports(integrator) + h.env.lamports(table);
    expect(h.env.lamports(u.signer.address)).toBe(solBefore - kept - 2n * FEE);
    // What the demo says stays with those records is what stayed.
    expect(end.kept).toBe(kept);
    expect(h.env.exists((await findRoundPda(1n))[0])).toBe(false);
    expect(h.env.exists(end.ticket!)).toBe(false);
    expect((await h.env.vault()).acceptingRound).toBe(0n);
  });

  it("pays an unpaid round's draw from the wallet when asked, then finishes", async () => {
    const h = await harness();
    const u = await wallet(h.env);
    h.beforeJoin = async (call) => {
      if (call === 1) await setOraoFee(h.env, ORAO_FEE * 2n);
    };
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    for (let i = 0; i < 10_000 && !flow.state.stalled; i++)
      await new Promise((r) => setTimeout(r, 0));
    expect(flow.state.stage).toEqual({ kind: "waiting" });
    flow.takeOver();
    const end = await ended(flow);
    expect(end.phase).toBe("done");
    expect(end.failure).toBeNull();
    expect(end.end?.kind).toBe("paid");
    expect(end.sigs.sponsor).toBe(h.sent[1]!.signature);
    expect(h.sent.map((s) => s.label)).toEqual([
      "join_round",
      "sponsor_round",
      "request_round_draw",
      "settle_round_tickets",
    ]);
    expect(end.sponsorshipLeft).toBe(false);
  });

  it("keeps following a ticket a lagging node does not show yet after the join", async () => {
    const h = await harness();
    // The first two reads after the join come from a node that has not seen it.
    h.staleReadsAfterJoin = 2;
    const u = await wallet(h.env);
    const keeper = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    h.onSleep = async () => {
      const s = flow.state;
      if (s.round === null || !s.ticket) return;
      const w = await readWatch(h.deps.reader, TARGET, s.round, s.ticket, keeper.signer.address);
      const stage = stageOf(w);
      if (stage.kind === "closed" && stage.canRequest)
        await h.deps.send(
          keeper.signer,
          [await planRequest(h.deps.reader, TARGET, keeper.signer, w)],
          "keeper request",
          200_000,
        );
      if (stage.kind === "drawn") {
        const p = await planPayout(h.deps.reader, TARGET, keeper.signer, w);
        await h.deps.send(keeper.signer, p.instructions, "keeper payout", p.units);
      }
    };
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    const end = await ended(flow);
    expect(end.phase).toBe("done");
    expect(h.sent.map((s) => s.label)).toEqual(["join_round", "keeper request", "keeper payout"]);
    const event = await h.deps.findSettled(FADE_PROGRAM_ADDRESS, end.ticket!);
    expect(end.end).toEqual({
      kind: "paid",
      parked: false,
      outcome: { index: event!.outcome, payout: event!.payout },
    });
    // The flow asks the RPC for reads no older than the join.
    expect(h.minContextSlots).toContain(h.joinSlot);
  });

  it("does not end 'no draw' a ticket ORAO answered late, once a keeper paid it and closed the round", async () => {
    const h = await harness();
    h.oraoAnswers = false;
    // The payout is not indexed yet: its transactions show nothing, without an error.
    h.findSettledLags = true;
    const u = await wallet(h.env);
    const keeper = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    let answered = false;
    h.onSleep = async () => {
      const s = flow.state;
      if (answered || s.round === null || !s.ticket) return;
      const w = await readWatch(h.deps.reader, TARGET, s.round, s.ticket, u.signer.address);
      const stage = stageOf(w);
      if (stage.kind === "closed" && stage.canRequest)
        await h.deps.send(
          keeper.signer,
          [await planRequest(h.deps.reader, TARGET, keeper.signer, w)],
          "keeper request",
          200_000,
        );
      // Past T_SETTLE the flow shows the requested round as expirable; ORAO
      // answers then, and in the same turn the keeper pays the ticket out and
      // reclaims the wallet's sponsorship, which closes the round.
      if (s.stage?.kind === "no-draw" && w.round?.data.status === RoundStatus.Requested) {
        answered = true;
        const [roundVrf] = await findRoundVrfPda({ round: w.round.address });
        await h.env.fulfill(w.round.data.randomness, roundVrf, new Uint8Array(64).fill(9));
        h.fulfilled.add(w.round.data.randomness);
        const drawn = await readWatch(h.deps.reader, TARGET, s.round, s.ticket, u.signer.address);
        expect(stageOf(drawn)).toEqual({ kind: "drawn" });
        const p = await planPayout(h.deps.reader, TARGET, keeper.signer, drawn);
        await h.deps.send(keeper.signer, p.instructions, "keeper payout", p.units);
      }
    };
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    const end = await ended(flow);
    expect(answered).toBe(true);
    expect(h.sent.map((s) => s.label)).toEqual(["join_round", "keeper request", "keeper payout"]);
    const w = await readWatch(h.deps.reader, TARGET, end.round!, end.ticket!, u.signer.address);
    expect(w.round).toBeNull();
    expect(w.ticket).toBeNull();
    // The ticket was drawn and paid: never shown as a draw that did not come.
    expect(end.phase).toBe("done");
    expect(end.end).toEqual({ kind: "unknown", drawn: false });
  });

  it("binds late a draw someone requested and ORAO fulfilled, then pays the ticket out", async () => {
    const h = await harness();
    const u = await wallet(h.env);
    const stranger = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    let created = false;
    // A stranger creates the round's ORAO request (its seed is public) and has
    // it fulfilled; nobody binds it before close_slot + T_SETTLE.
    h.onSleep = async () => {
      const s = flow.state;
      if (created || s.round === null || !s.ticket) return;
      const w = await readWatch(h.deps.reader, TARGET, s.round, s.ticket, u.signer.address);
      const stage = stageOf(w);
      if (stage.kind !== "closed" || !stage.canRequest || !w.round) return;
      created = true;
      const named = await roundRequestAddress(w.round, h.env.data(SLOT_HASHES_SYSVAR));
      await h.env.preCreate(stranger.signer, named!.request, named!.seed!);
      await h.env.fulfill(named!.request, stranger.signer.address, new Uint8Array(64).fill(5));
      h.fulfilled.add(named!.request);
      h.env.setSlot(w.round.data.closeSlot + w.round.data.tSettleSlots + 5n);
    };
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    for (let i = 0; i < 10_000 && !(created && flow.state.stalled); i++)
      await new Promise((r) => setTimeout(r, 0));
    // Not a draw that never came: the round can still be drawn, by binding the request.
    expect(flow.state.stage).toMatchObject({ kind: "closed", canRequest: true });
    h.onSleep = null;
    flow.takeOver();
    const end = await ended(flow);
    expect(end.phase).toBe("done");
    expect(end.failure).toBeNull();
    expect(h.sent.map((s) => s.label)).toEqual([
      "join_round",
      "request_round_draw",
      "settle_round_tickets",
    ]);
    const event = await h.deps.findSettled(FADE_PROGRAM_ADDRESS, end.ticket!);
    expect(end.end).toEqual({
      kind: "paid",
      parked: false,
      outcome: { index: event!.outcome, payout: event!.payout },
    });
  });

  it("binds a request ORAO fulfilled between the read and the wallet's close, instead of failing", async () => {
    const h = await harness();
    const u = await wallet(h.env);
    const stranger = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    // Nobody requests; time runs past the request window.
    h.onSleep = async () => {
      if (flow.state.stage?.kind === "closed") h.env.setSlot(h.env.slot() + 200n);
    };
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    for (let i = 0; i < 10_000 && flow.state.stage?.kind !== "no-draw"; i++)
      await new Promise((r) => setTimeout(r, 0));
    expect(flow.state.stage).toEqual({ kind: "no-draw", forfeited: false });
    h.onSleep = null;
    const w = await readWatch(
      h.deps.reader,
      TARGET,
      flow.state.round!,
      flow.state.ticket!,
      u.signer.address,
    );
    const named = await roundRequestAddress(w.round!, h.env.data(SLOT_HASHES_SYSVAR));
    // A stranger's request at the round's seed is created and fulfilled while
    // the wallet builds its close, after the flow read the round as expirable.
    let raced = false;
    h.onAccounts = async (addresses) => {
      if (raced || !flow.isBusy || !addresses.includes(named!.request)) return;
      raced = true;
      await h.env.preCreate(stranger.signer, named!.request, named!.seed!);
      await h.env.fulfill(named!.request, stranger.signer.address, new Uint8Array(64).fill(6));
      h.fulfilled.add(named!.request);
    };
    flow.takeOver();
    const end = await ended(flow);
    expect(raced).toBe(true);
    expect(end.phase).toBe("done");
    expect(end.failure).toBeNull();
    expect(h.sent.map((s) => s.label)).toEqual([
      "join_round",
      "request_round_draw",
      "settle_round_tickets",
    ]);
    expect(end.end?.kind).toBe("paid");
  });

  it("shows a ticket a keeper paid out between two reads as paid, its transactions unreadable", async () => {
    const h = await harness();
    h.findSettledFails = true;
    const u = await wallet(h.env);
    const keeper = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    const kinds: string[] = [];
    // The keeper requests at once and pays out in the same turn ORAO answers:
    // the flow never reads the round drawn, only requested, then the ticket gone.
    h.onSleep = async () => {
      const s = flow.state;
      if (s.round === null || !s.ticket) return;
      if (s.stage && kinds.at(-1) !== s.stage.kind) kinds.push(s.stage.kind);
      const w = await readWatch(h.deps.reader, TARGET, s.round, s.ticket, keeper.signer.address);
      const stage = stageOf(w);
      if (stage.kind === "closed" && stage.canRequest)
        await h.deps.send(
          keeper.signer,
          [await planRequest(h.deps.reader, TARGET, keeper.signer, w)],
          "keeper request",
          200_000,
        );
      if (stage.kind === "drawn") {
        const p = await planPayout(h.deps.reader, TARGET, keeper.signer, w);
        await h.deps.send(keeper.signer, p.instructions, "keeper payout", p.units);
      }
    };
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    const end = await ended(flow);
    expect(kinds).not.toContain("drawn");
    expect(h.sent.map((s) => s.label)).toEqual(["join_round", "keeper request", "keeper payout"]);
    h.findSettledFails = false;
    const event = await h.deps.findSettled(FADE_PROGRAM_ADDRESS, end.ticket!);
    expect(end.phase).toBe("done");
    expect(end.end).toEqual({
      kind: "paid",
      parked: false,
      outcome: { index: event!.outcome, payout: event!.payout },
    });
  });

  it("ends refunded, not 'no draw', a paid round its expiry refunds once SlotHashes lost its seed", async () => {
    const h = await harness();
    const u = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    // Nobody requests and nobody records the round's seed; time runs past
    // the request window and past what SlotHashes keeps (512 slots).
    h.onSleep = async () => {
      if (flow.state.stage?.kind === "closed") h.env.setSlot(h.env.slot() + 700n);
    };
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    for (let i = 0; i < 10_000 && flow.state.stage?.kind !== "no-draw"; i++)
      await new Promise((r) => setTimeout(r, 0));
    expect(flow.state.stage).toEqual({ kind: "no-draw", forfeited: false });
    const w = await readWatch(
      h.deps.reader,
      TARGET,
      flow.state.round!,
      flow.state.ticket!,
      u.signer.address,
    );
    expect(w.round!.data.entropySlot).toBe(0n);
    expect(await roundRequestAddress(w.round!, h.env.data(SLOT_HASHES_SYSVAR))).toBeNull();
    h.onSleep = null;
    // The landed close is not readable: the plan's prediction stands.
    h.findReturnedFails = true;
    const usdcBefore = h.env.balance(u.usdc);
    flow.takeOver();
    const end = await ended(flow);
    expect(h.sent.map((s) => s.label)).toEqual(["join_round", "return_round_ticket"]);
    // The program refunded it: the ticket price came back, and the demo says so.
    expect(expiredEventOf(h.sent[1]!.result)?.refunded).toBe(true);
    expect(h.env.balance(u.usdc)).toBe(usdcBefore + BEACON_TICKET_PRICE);
    expect(end.phase).toBe("done");
    expect(end.end).toEqual({ kind: "refunded", parked: false });
  });

  it("ends refunded, from the landed close, when SlotHashes loses the seed after the close was planned", async () => {
    const h = await harness();
    const u = await wallet(h.env);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    // Nobody requests; time runs past the request window, SlotHashes still
    // proving the round's seed when the close is planned.
    h.onSleep = async () => {
      if (flow.state.stage?.kind === "closed") h.env.setSlot(h.env.slot() + 200n);
    };
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    for (let i = 0; i < 10_000 && flow.state.stage?.kind !== "no-draw"; i++)
      await new Promise((r) => setTimeout(r, 0));
    expect(flow.state.stage).toEqual({ kind: "no-draw", forfeited: false });
    h.onSleep = null;
    const watched = await readWatch(
      h.deps.reader,
      TARGET,
      flow.state.round!,
      flow.state.ticket!,
      u.signer.address,
    );
    expect(
      await roundRequestAddress(watched.round!, h.env.data(SLOT_HASHES_SYSVAR)),
    ).not.toBeNull();
    // Planned as a forfeiture; SlotHashes drops the seed before it lands.
    h.beforeSend = (label) => {
      if (label === "return_round_ticket") h.env.setSlot(h.env.slot() + 600n);
    };
    const usdcBefore = h.env.balance(u.usdc);
    flow.takeOver();
    const end = await ended(flow);
    expect(h.sent.map((s) => s.label)).toEqual(["join_round", "return_round_ticket"]);
    expect(expiredEventOf(h.sent[1]!.result)?.refunded).toBe(true);
    expect(h.env.balance(u.usdc)).toBe(usdcBefore + BEACON_TICKET_PRICE);
    expect(end.end).toEqual({ kind: "refunded", parked: false });
  });

  it("ends a refund held for a USDC account that cannot receive, and claims it", async () => {
    const h = await harness();
    const u = await wallet(h.env);
    h.beforeJoin = async (call) => {
      if (call === 1) await setOraoFee(h.env, ORAO_FEE * 2n);
    };
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    const r1 = getRoundDecoder().decode(h.env.data((await findRoundPda(1n))[0]));
    expect(r1.status).toBe(RoundStatus.Accepting);
    for (let i = 0; i < 10_000 && flow.state.stage?.kind !== "waiting"; i++)
      await new Promise((r) => setTimeout(r, 0));
    h.env.setSlot(r1.firstSlot + r1.refundSlots);
    for (let i = 0; i < 10_000 && flow.state.stage?.kind !== "refundable"; i++)
      await new Promise((r) => setTimeout(r, 0));
    // The wallet's USDC account is frozen: the returned ticket price is held.
    h.env.setTokenState(u.usdc, 2);
    const usdcBefore = h.env.balance(u.usdc);
    flow.takeOver();
    const end = await ended(flow);
    expect(end.phase).toBe("done");
    expect(end.failure).toBeNull();
    expect(h.sent.map((s) => s.label)).toEqual(["join_round", "refund_round"]);
    expect(end.end).toEqual({ kind: "refunded", parked: true });
    expect(
      stageOf(await readWatch(h.deps.reader, TARGET, 1n, end.ticket!, u.signer.address)),
    ).toEqual({ kind: "refund-held" });
    // Thawed, the held ticket price is claimed and the ticket closes.
    h.env.setTokenState(u.usdc, 1);
    await flow.claim();
    expect(flow.state.failure).toBeNull();
    expect(flow.state.end).toEqual({ kind: "refunded", parked: false });
    expect(h.env.balance(u.usdc)).toBe(usdcBefore + BEACON_TICKET_PRICE);
    expect(h.env.exists(end.ticket!)).toBe(false);
  });

  it("waits for a round that stopped taking joins until its close, then joins the next one", async () => {
    const h = await harness();
    const first = await wallet(h.env);
    const u = await wallet(h.env);
    // Someone else's ticket pays round 1, which accepts joins by slot until its close.
    const other = new BeaconTicketFlow(h.deps, TARGET);
    expect(await other.start(first.signer, first.usdc)).toBe(true);
    other.stop();
    const close = getRoundDecoder().decode(h.env.data((await findRoundPda(1n))[0])).closeSlot;
    expect(h.env.slot()).toBeLessThan(close);
    // The program refuses the wallet's first join into it in simulation, as
    // it does from the vault's price close on for a round paid before it.
    const joinSlots: bigint[] = [];
    h.beforeJoin = (call) => {
      joinSlots.push(h.env.slot());
      if (call === 2)
        throw Object.assign(new Error("RoundEpochClosed"), {
          failure: { code: 6066, name: "RoundEpochClosed", message: "RoundEpochClosed", logs: [] },
          pending: null,
        });
    };
    const planned: (bigint | null)[] = [];
    const asked: (string | null)[] = [];
    const flow = new BeaconTicketFlow(h.deps, TARGET, (s) => {
      if (s.phase === "signing" && planned.at(-1) !== s.round) planned.push(s.round);
      if (asked.at(-1) !== s.asking) asked.push(s.asking);
    });
    expect(await flow.start(u.signer, u.usdc)).toBe(true);
    flow.stop();
    expect(flow.state.failure).toBeNull();
    expect(planned).toEqual([1n, 2n]);
    expect(asked).toContain("This draw is closing. Joining the next one");
    // Rebuilt only once round 1 had closed, never resent into it.
    expect(h.joinCalls).toBe(3);
    expect(joinSlots).toHaveLength(2);
    expect(joinSlots[1]).toBeGreaterThanOrEqual(close);
    expect(flow.state.round).toBe(2n);
  });

  it("quotes before the button the SOL the join then asks for", async () => {
    const h = await harness();
    const first = await wallet(h.env);
    const u = await wallet(h.env);
    const quote = await quoteJoin(h.deps.reader, TARGET, first.signer, first.usdc);
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    const other = new BeaconTicketFlow(h.deps, TARGET);
    expect(await other.start(first.signer, first.usdc)).toBe(true);
    other.stop();
    expect(quote.need).toBe(other.state.fronted! + FEE_MARGIN);
    expect(quote.kept).toBe(other.state.kept);
    // With the payout table registered, as on the beacon's devnet instance,
    // a fresh wallet's first ticket that creates its round and its app record
    // needs less than the 0.02 SOL the free USDC button gives a wallet with
    // almost none (apps/keeper/src/faucet.ts, SOL_TOP_UP).
    const close = getRoundDecoder().decode(h.env.data((await findRoundPda(1n))[0])).closeSlot;
    h.env.setSlot(close);
    const fresh = await quoteJoin(h.deps.reader, TARGET, u.signer, u.usdc);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.kept).toBe(await h.deps.reader.rent(getIntegratorSize()));
    expect(fresh.need).toBeLessThan(20_000_000n);
  });

  it("stops on a refusal before anything is signed, and starts again", async () => {
    const h = await harness();
    const poor = await h.env.svm.fundedWallet(1);
    const empty = await h.env.usdcAccount(poor.address, 0n);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    expect(await flow.start(poor, empty)).toBe(false);
    expect(flow.state.phase).toBe("failed");
    expect(flow.state.sigs.join).toBeUndefined();
    expect(h.sent).toHaveLength(0);
    expect(flow.reset()).toBe(true);
    expect(flow.state.phase).toBe("idle");
  });

  it("refuses before the wallet is asked when it lacks the SOL the ticket fronts", async () => {
    const h = await harness();
    const signer = await generateKeyPairSigner();
    h.env.svm.client.airdrop(signer.address, lamports(5_000_000n));
    const usdc = await h.env.usdcAccount(signer.address, 10n * USDC);
    const flow = new BeaconTicketFlow(h.deps, TARGET);
    expect(await flow.start(signer, usdc)).toBe(false);
    expect(flow.state.failure?.message).toMatch(/needs about 0\.\d+ SOL .* holds 0\.0050 SOL/);
    expect(h.sent).toHaveLength(0);
  });
});

describe("the sponsorship offered back", () => {
  const held = { address: "11111111111111111111111111111111", data: {} } as never;
  it("is offered while the round and the sponsorship are both read", () => {
    expect(sponsorshipLeftOf({ round: held, sponsorship: held })).toBe(true);
  });
  it("is not offered once the round is closed, whatever a lagging read says", () => {
    // A round closes only with no sponsorship left: the keeper reclaimed it.
    expect(sponsorshipLeftOf({ round: null, sponsorship: held })).toBe(false);
  });
  it("is not offered once reclaimed", () => {
    expect(sponsorshipLeftOf({ round: held, sponsorship: null })).toBe(false);
  });
});
