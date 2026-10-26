// The app's small-ticket demo on the shared beacon (apps/web/src/lib/beacon.ts),
// end to end in litesvm with the program and the ORAO stand-in: a 0.10 USDC
// ticket joins with the sponsorship that pays its draw, its round closes on
// the tick, the draw is requested and fulfilled, and the ticket is paid out
// by the wallet itself (its sponsorship reclaimed in the same transaction)
// or by someone else; a draw never requested ends with the ticket closed.
// Every transaction the demo builds is simulated, then sent, as plain v0
// (the wallets the app supports sign v0, not v1), and every step is checked
// to the unit and the lamport. Also: the configuration that hides the demo,
// and the tabs Home shows with and without it.
import { describe, expect, it } from "vitest";
import { address, generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
import {
  FADE_PROGRAM_ADDRESS,
  RoundStatus,
  findRoundVrfPda,
  findSponsorshipPda,
  getSetPauseFlagsInstructionAsync,
  getSponsorshipSize,
} from "../../../clients/js/src/generated/fade/index.ts";
import { sponsorReturn, ticketOutcome } from "../../../clients/js/src/beacon/index.ts";
import {
  BEACON_PAYOUT_TABLE,
  BEACON_TICKET_PRICE,
  JOIN_UNITS,
  PAUSE_ROUNDS,
  PAUSE_TICKETS,
  REQUEST_UNITS,
  ROUND_PIN_SPONSORSHIP,
  planClose,
  planJoin,
  planPayout,
  planReclaim,
  planRequest,
  predictOutcome,
  readBeacon,
  readWatch,
  settledEventOf,
  stageOf,
  type AccountReader,
  type BeaconTarget,
} from "../../../apps/web/src/lib/beacon.ts";
import { parseBeaconEnabled } from "../../../apps/web/src/lib/beaconConfig.ts";
import { demoTabs, tabOf } from "../../../apps/web/src/lib/demoTabs.ts";
import { PARAM_WORDS, formatParam } from "../../../apps/web/src/lib/paramWords.ts";
import { BeaconEnv, ORAO_FEE, SPEC_PARAMS, USDC, USDC_MINT, type Sent } from "../fade/beaconEnv.ts";

/** Spec 09 §8's terms for a 0.10 USD minimum: a 5 000-lamport settlement share, 9.79 USDC threshold. */
const DEMO_PARAMS = {
  ...SPEC_PARAMS,
  beaconMinPrice: 100_000n,
  beaconThreshold: 9_790_000n,
  crankRoundSettleLamports: 5_000n,
};
const TARGET: BeaconTarget = { program: FADE_PROGRAM_ADDRESS, usdcMint: USDC_MINT };
/** One signature at the base fee: the demo's v0 transactions carry no priority fee in litesvm. */
const FEE = 5_000n;
const WIN_PAYOUT = 195_600n;

function readerOf(env: BeaconEnv): AccountReader {
  return {
    accounts: async (addresses) => addresses.map((a) => env.account(a)),
    slot: async () => env.slot(),
    rent: async (space) => env.svm.client.minimumBalanceForRentExemption(BigInt(space)),
    lamports: async (a) => env.lamports(a),
  };
}

type User = { signer: KeyPairSigner; usdc: Address };

async function user(env: BeaconEnv): Promise<User> {
  const signer = await env.svm.fundedWallet(1);
  return { signer, usdc: await env.usdcAccount(signer.address, 10n * USDC) };
}

/** Sends as the app does: one v0 transaction, simulated first (`env.send`). */
const send = (env: BeaconEnv, u: User, ixs: Parameters<BeaconEnv["send"]>[1], units: number) =>
  env.send(u.signer, ixs, { format: 0, units });

/** The `RoundTicketSettled` events a sent transaction emitted for `ticket`. */
function settledEvents(sent: Sent, ticket: Address) {
  return sent.meta
    .innerInstructions()
    .flat()
    .map((i) => settledEventOf(new Uint8Array(i.instruction().data()), ticket))
    .filter((e) => e !== null);
}

/** A randomness that gives `ticket` of `round` the outcome `want` (0 wins, 1 does not). */
async function randomnessFor(round: Address, ticket: Address, want: 0 | 1) {
  for (let i = 1; i < 256; i++) {
    const r = new Uint8Array(64).fill(i);
    const o = await ticketOutcome(
      FADE_PROGRAM_ADDRESS,
      round,
      ticket,
      r,
      BEACON_PAYOUT_TABLE.map((x) => ({ p: BigInt(x.p), m: BigInt(x.m) })),
      BEACON_TICKET_PRICE,
    );
    if (o.index === want) return r;
  }
  throw new Error("no randomness found");
}

/** Joins one demo ticket for `u`; returns the plan and the lamports it took. */
async function join(env: BeaconEnv, u: User) {
  const reader = readerOf(env);
  const snapshot = await readBeacon(reader, TARGET, u.signer.address);
  const plan = await planJoin(snapshot, TARGET, u.signer, u.usdc);
  if (!plan.ok) throw new Error(`join refused: ${plan.reason}`);
  const before = env.lamports(u.signer.address);
  const usdcBefore = env.balance(u.usdc);
  await send(env, u, plan.instructions, JOIN_UNITS);
  return {
    plan,
    took: before - env.lamports(u.signer.address),
    usdcTook: usdcBefore - env.balance(u.usdc),
  };
}

describe("the small-ticket demo on the shared beacon", () => {
  it("joins a 0.10 USDC ticket, shows its close tick, and pays it out from the wallet", async () => {
    const env = await BeaconEnv.create(DEMO_PARAMS);
    const reader = readerOf(env);
    const u = await user(env);
    const start = env.lamports(u.signer.address);

    // The first join registers the payout table, creates the integrator record and the round.
    const snapshot = await readBeacon(reader, TARGET, u.signer.address);
    expect(snapshot.payoutTableExists).toBe(false);
    expect(snapshot.integrator).toBeNull();
    const { plan, took, usdcTook } = await join(env, u);
    expect(plan.instructions).toHaveLength(2);
    expect(plan.target.creates).toBe(true);
    expect(plan.sponsorship).toBeGreaterThan(0n);
    // The estimate shown is what the join took, to the lamport, fee aside.
    expect(took - FEE).toBe(plan.fronted);
    expect(plan.kept).toBe(snapshot.rents.table + snapshot.rents.integrator);
    expect(usdcTook).toBe(BEACON_TICKET_PRICE);

    // Paid at once by its own sponsorship: the round closes at the next tick.
    let w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    expect(w.round?.data.status).toBe(RoundStatus.Paid);
    expect(w.sponsorship?.data.amount).toBe(plan.sponsorship);
    const close = w.round!.data.closeSlot;
    expect(close % DEMO_PARAMS.tickSlots).toBe(0n);
    let stage = stageOf(w);
    expect(stage).toEqual({
      kind: "closing",
      closeSlot: close,
      slotsLeft: close - env.slot(),
      tickSlots: DEMO_PARAMS.tickSlots,
    });

    env.setSlot(close - 1n);
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    expect(stageOf(w)).toMatchObject({ kind: "closing", slotsLeft: 1n });
    env.setSlot(close);
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    stage = stageOf(w);
    expect(stage).toEqual({
      kind: "closed",
      from: close + 2n,
      until: close + DEMO_PARAMS.tSettleSlots,
      canRequest: false,
    });
    // Too early to request: the program refuses, the client builder too.
    await expect(planRequest(reader, TARGET, u.signer, w)).rejects.toThrow(/request window/);

    env.setSlot(close + 2n);
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    expect(stageOf(w)).toMatchObject({ kind: "closed", canRequest: true });
    await send(env, u, [await planRequest(reader, TARGET, u.signer, w)], REQUEST_UNITS);
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    expect(stageOf(w)).toEqual({ kind: "drawing" });

    const round = w.round!;
    const [roundVrf] = await findRoundVrfPda({ round: round.address });
    await env.fulfill(
      round.data.randomness,
      roundVrf,
      await randomnessFor(round.address, plan.ticket, 0),
    );
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    expect(stageOf(w)).toEqual({ kind: "drawn" });
    const predicted = await predictOutcome(reader, TARGET, w.round!, w.request, w.ticket!);
    expect(predicted).toEqual({ index: 0, payout: WIN_PAYOUT });

    // The wallet pays its own ticket out and reclaims its sponsorship, in one transaction.
    const payout = await planPayout(reader, TARGET, u.signer, w);
    expect(payout.instructions).toHaveLength(2);
    const usdcBefore = env.balance(u.usdc);
    const sent = await send(env, u, payout.instructions, payout.units);
    expect(sent.units).toBeLessThanOrEqual(BigInt(payout.units));
    expect(settledEvents(sent, plan.ticket)).toEqual([
      { outcome: 0, payout: WIN_PAYOUT, parked: false },
    ]);
    expect(env.balance(u.usdc) - usdcBefore).toBe(WIN_PAYOUT);

    // Its last ticket paid and its one sponsorship reclaimed, the round is closed.
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    expect(w.ticket).toBeNull();
    expect(w.round).toBeNull();
    expect(w.sponsorship).toBeNull();
    expect(stageOf(w)).toEqual({ kind: "gone" });
    // Every lamport fronted came back but the draw (ORAO's fee and the rent its fulfilled
    // request keeps), the two new records' rents and the three fees: the sponsorship paid the
    // draw, the request share and the settlement share went to the wallet that sent the steps.
    const spent = start - env.lamports(u.signer.address);
    expect(spent).toBe(plan.kept + ORAO_FEE + env.lamports(round.data.randomness) + 3n * FEE);
  });

  it("follows a ticket paid out by someone else, in a round another join paid", async () => {
    const env = await BeaconEnv.create(DEMO_PARAMS);
    const reader = readerOf(env);
    const first = await user(env);
    await join(env, first); // registers the table
    const u = await user(env);
    // The first round is still taking joins: this one lands in it, already
    // paid, with the one-lamport sponsorship that names its round's record.
    const { plan } = await join(env, u);
    expect(plan.target.creates).toBe(false);
    expect(plan.sponsorship).toBe(ROUND_PIN_SPONSORSHIP);
    expect(plan.instructions).toHaveLength(1);

    // A third ticket arrives after the close: it creates the next round.
    let w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    const close = w.round!.data.closeSlot;
    env.setSlot(close);
    const late = await user(env);
    const next = await join(env, late);
    expect(next.plan.round).toBe(plan.round + 1n);
    expect(next.plan.target.creates).toBe(true);

    // A keeper (here the first user) requests and pays out every ticket of the round.
    env.setSlot(close + 2n);
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, first.signer.address);
    await send(env, first, [await planRequest(reader, TARGET, first.signer, w)], REQUEST_UNITS);
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    const [roundVrf] = await findRoundVrfPda({ round: w.round!.address });
    await env.fulfill(
      w.round!.data.randomness,
      roundVrf,
      await randomnessFor(w.round!.address, plan.ticket, 1),
    );
    // Read as the first wallet: its own sponsorship record is reclaimed with the payout.
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, first.signer.address);
    const predicted = await predictOutcome(reader, TARGET, w.round!, w.request, w.ticket!);
    expect(predicted).toEqual({ index: 1, payout: 0n });
    const keeperPayout = await planPayout(reader, TARGET, first.signer, w);
    const sent = await send(env, first, keeperPayout.instructions, keeperPayout.units);
    expect(settledEvents(sent, plan.ticket)).toEqual([{ outcome: 1, payout: 0n, parked: false }]);

    // The second wallet's ticket is gone, and the first wallet's record was
    // reclaimed with it; the second wallet's own record is left for it.
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    expect(stageOf(w)).toEqual({ kind: "gone" });
    expect(w.sponsorship?.data.amount).toBe(ROUND_PIN_SPONSORSHIP);
    const firstRound = w.round!;
    expect(firstRound.data.status).toBe(RoundStatus.Drawn);
    const [firstSponsorship] = await findSponsorshipPda({
      round: firstRound.address,
      sponsor: first.signer.address,
    });
    expect(env.account(firstSponsorship)).toBeNull();
    expect(keeperPayout.instructions).toHaveLength(2);
    // Its reclaim gives back the record's rent; the lamport paid toward the draw.
    const before = env.lamports(u.signer.address);
    const rent = env.lamports(w.sponsorship!.address);
    await send(env, u, [await planReclaim(TARGET, u.signer, w)], 60_000);
    expect(env.lamports(u.signer.address)).toBe(before + rent - FEE);
    expect(env.account(w.sponsorship!.address)).toBeNull();
  });

  it("closes a ticket whose draw was never requested: no payout, its sponsorship back", async () => {
    const env = await BeaconEnv.create(DEMO_PARAMS);
    const reader = readerOf(env);
    const u = await user(env);
    const { plan } = await join(env, u);
    let w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    const r = w.round!.data;
    env.setSlot(r.closeSlot + r.tSettleSlots);
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    expect(stageOf(w)).toMatchObject({ kind: "closed", canRequest: true });
    // A payout before any draw is refused by the client: there is no randomness to predict with.
    await expect(planPayout(reader, TARGET, u.signer, w)).rejects.toThrow();
    env.setSlot(r.closeSlot + r.tSettleSlots + 1n);
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    expect(stageOf(w)).toEqual({ kind: "no-draw", forfeited: false });

    const usdcBefore = env.balance(u.usdc);
    const sponsorBefore = env.lamports(u.signer.address);
    const closeIt = await planClose(reader, TARGET, u.signer, w);
    expect(closeIt.instructions).toHaveLength(3);
    await send(env, u, closeIt.instructions, closeIt.units);
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    expect(w.ticket).toBeNull();
    expect(w.round).toBeNull();
    // A forfeiture is never a refund: the ticket price stays with the vault.
    expect(env.balance(u.usdc)).toBe(usdcBefore);
    // The never-drawn round's sponsorship, the ticket's prepay, its settlement share (to the
    // caller, here the same wallet) and the rents came back.
    expect(env.lamports(u.signer.address)).toBeGreaterThan(sponsorBefore + plan.sponsorship);
  });

  it("reclaims a sponsorship left on a drawn round", async () => {
    const env = await BeaconEnv.create(DEMO_PARAMS);
    const reader = readerOf(env);
    const u = await user(env);
    const other = await user(env);
    const { plan } = await join(env, u);
    const second = await join(env, other);
    let w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    env.setSlot(w.round!.data.closeSlot + 2n);
    await send(env, other, [await planRequest(reader, TARGET, other.signer, w)], REQUEST_UNITS);
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    const [roundVrf] = await findRoundVrfPda({ round: w.round!.address });
    await env.fulfill(w.round!.data.randomness, roundVrf, new Uint8Array(64).fill(7));
    // The other wallet pays out its own ticket only, and reclaims its own
    // one-lamport record; ours stays, and so does our sponsorship.
    const ow = await readWatch(
      reader,
      TARGET,
      plan.round,
      second.plan.ticket,
      other.signer.address,
    );
    const theirs = await planPayout(reader, TARGET, other.signer, ow);
    expect(second.plan.sponsorship).toBe(ROUND_PIN_SPONSORSHIP);
    expect(theirs.instructions).toHaveLength(2);
    await send(env, other, theirs.instructions, theirs.units);
    w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    expect(w.round!.data.status).toBe(RoundStatus.Drawn);
    expect(stageOf(w)).toEqual({ kind: "drawn" });
    const before = env.lamports(u.signer.address);
    await send(env, u, [await planReclaim(TARGET, u.signer, w)], 60_000);
    const back = env.lamports(u.signer.address) - before + FEE;
    // The sponsor's return: its share of what the draw did not use (Spec 08
    // §13.4), pro rata with the other wallet's lamport, and the record's rent.
    const drawCost = w.round!.data.drawCost;
    expect(w.round!.data.sponsorship).toBe(plan.sponsorship + ROUND_PIN_SPONSORSHIP);
    expect(back).toBe(
      sponsorReturn(drawCost, w.round!.data.sponsorship, plan.sponsorship, true) +
        (await readerOf(env).rent(getSponsorshipSize())),
    );
  });

  it("refuses a join below the round's minimum price and while rounds are paused", async () => {
    const env = await BeaconEnv.create(); // SPEC terms: 0.50 USDC minimum
    const reader = readerOf(env);
    const u = await user(env);
    let snapshot = await readBeacon(reader, TARGET, u.signer.address);
    expect(await planJoin(snapshot, TARGET, u.signer, u.usdc)).toEqual({
      ok: false,
      reason: "min-price",
      minPrice: 500_000n,
    });
    await env.send(env.deployer, [
      await getSetPauseFlagsInstructionAsync({
        authority: env.deployer,
        eventAuthority: env.eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
        pauseFlags: PAUSE_ROUNDS,
        integratorPaused: null,
      }),
    ]);
    snapshot = await readBeacon(reader, TARGET, u.signer.address);
    expect(await planJoin(snapshot, TARGET, u.signer, u.usdc)).toMatchObject({
      ok: false,
      reason: "paused",
    });
    // A pause of every ticket stops the beacon's joins too (`join_round`).
    await env.send(env.deployer, [
      await getSetPauseFlagsInstructionAsync({
        authority: env.deployer,
        eventAuthority: env.eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
        pauseFlags: PAUSE_TICKETS,
        integratorPaused: null,
      }),
    ]);
    snapshot = await readBeacon(reader, TARGET, u.signer.address);
    expect(snapshot.config.pauseFlags).toBe(PAUSE_TICKETS);
    expect(await planJoin(snapshot, TARGET, u.signer, u.usdc)).toMatchObject({
      ok: false,
      reason: "paused",
    });
  });

  it("treats lamports sent to an address before its account exists as no account", async () => {
    const env = await BeaconEnv.create(DEMO_PARAMS);
    const reader = readerOf(env);
    const u = await user(env);
    const { plan } = await join(env, u);
    const w = await readWatch(reader, TARGET, plan.round, plan.ticket, u.signer.address);
    // Someone pre-funds the next round's address and this wallet's record on it.
    const [nextSponsorship] = await findSponsorshipPda({
      round: plan.target.nextRound,
      sponsor: u.signer.address,
    });
    env.put(plan.target.nextRound, new Uint8Array(0), address("11111111111111111111111111111111"));
    env.put(nextSponsorship, new Uint8Array(0), address("11111111111111111111111111111111"));
    const nobody = (await generateKeyPairSigner()).address;
    const nw = await readWatch(reader, TARGET, plan.round + 1n, nobody, u.signer.address);
    expect(nw.round).toBeNull();
    expect(nw.sponsorship).toBeNull();
    expect(w.round).not.toBeNull();
  });
});

describe("the demo's configuration", () => {
  it('is hidden unless VITE_BEACON_ENABLED is "true" or "1"', () => {
    for (const off of [undefined, "", "   ", "false", "0", "yes", "on"])
      expect(parseBeaconEnabled(off), String(off)).toBe(false);
    for (const on of ["true", "1", " TRUE ", "True"]) expect(parseBeaconEnabled(on), on).toBe(true);
  });

  it("adds the small-ticket tab only with a beacon program", () => {
    const off = demoTabs(false);
    expect(off.map((t) => t.id)).toEqual(["checkout", "swap", "booster"]);
    expect(tabOf("beacon", off)).toBe("checkout");
    const on = demoTabs(true);
    expect(on.map((t) => t.id)).toEqual(["checkout", "swap", "booster", "beacon"]);
    expect(tabOf("beacon", on)).toBe("beacon");
    expect(tabOf("nothing", on)).toBe("checkout");
  });

  it("names every risk parameter, the shared draw's included, for a pending change", () => {
    expect(Object.keys(PARAM_WORDS).sort()).toEqual(Object.keys(SPEC_PARAMS).sort());
  });

  it("writes every pending change visibly, the shared draw's settlement share included", () => {
    // Each label names its parameter, and no two parameters share one.
    const labels = Object.values(PARAM_WORDS);
    for (const l of labels) expect(l.trim().length).toBeGreaterThan(3);
    expect(new Set(labels).size).toBe(labels.length);
    // Spec 09 §8's loosening of the settlement share, 20 000 to 5 000 lamports.
    expect(formatParam("crankRoundSettleLamports", SPEC_PARAMS.crankRoundSettleLamports)).toBe(
      "20,000 lamports",
    );
    expect(formatParam("crankRoundSettleLamports", DEMO_PARAMS.crankRoundSettleLamports)).toBe(
      "5,000 lamports",
    );
    const spec = SPEC_PARAMS as unknown as Record<string, unknown>;
    const demo = DEMO_PARAMS as unknown as Record<string, unknown>;
    for (const k of Object.keys(PARAM_WORDS)) {
      // SPEC against Spec 09 §8's terms, and every value against its neighbours and zero.
      if (spec[k] !== demo[k]) expect(formatParam(k, spec[k]), k).not.toBe(formatParam(k, demo[k]));
      const v = spec[k];
      if (typeof v !== "bigint") continue;
      for (const other of [v + 1n, v > 0n ? v - 1n : v + 2n, 0n, v * 4n])
        if (other !== v) expect(formatParam(k, v), k).not.toBe(formatParam(k, other));
    }
  });

  it("keeps the app's copy rules in the demo's words", async () => {
    const { readFileSync } = await import("node:fs");
    const files = [
      "apps/web/src/demos/BeaconDemo.tsx",
      "apps/web/src/demos/useBeaconFlow.ts",
      "apps/web/src/lib/beaconFlow.ts",
      "apps/web/src/lib/demoTabs.ts",
    ];
    for (const f of files) {
      const text = readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
      expect(text, f).not.toMatch(/—/); // no em dash
      expect(text, f).not.toMatch(/test USDC/i);
      expect(text, f).not.toMatch(/\brefund(ed)?\b.*\bwin|\bwin\b.*\brefund/i);
    }
  });
});
