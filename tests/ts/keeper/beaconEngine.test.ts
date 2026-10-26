// The keeper's beacon loop (apps/keeper/src/beaconEngine.ts) end to end in
// litesvm, through `SvmChain`: it watches rounds from the program's events,
// requests at close_slot + 2, settles in batches built by the client's
// `planSettlement` as v1 transactions without any lookup table (plain v0 when
// the cluster refuses v1), expires and returns forfeited rounds, binds late a
// request someone created and ORAO fulfilled, sponsors to complete a draw
// within the round's fees only, sweeps the shares and the `round_vrf` of a
// round forfeited after its request, and its alarm tells a round nobody
// requested from a withheld draw.
import { DatabaseSync } from "node:sqlite";
import {
  generateKeyPairSigner,
  getU64Encoder,
  lamports,
  SolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  type Address,
  type KeyPairSigner,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FADE_PROGRAM_ADDRESS,
  RECORD_ROUND_ENTROPY_DISCRIMINATOR,
  RETURN_ROUND_TICKET_DISCRIMINATOR,
  RoundStatus,
  SWEEP_ROUND_VRF_DISCRIMINATOR,
  findConfigPda,
  findIntegratorPda,
  findRoundTicketPda,
  findRoundVrfPda,
  findSponsorshipPda,
  getConfigDecoder,
  getIntegratorDecoder,
  getRefundRoundInstructionAsync,
  getRegisterPayoutTableInstruction,
  getRoundDecoder,
  getRoundTicketDecoder,
  getSponsorshipDecoder,
  RoundTicketStatus,
  type OutcomeArgs,
  type Round,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  ORAO_VRF_PROGRAM_ADDRESS,
  REQUEST_DELAY_SLOTS,
  SLOT_HASHES_SYSVAR,
  closeSlot,
  findOraoNetworkStatePda,
  findPayoutTablePda,
  getCompleteDrawInstructionAsync,
  getBeaconExpireInstructionAsync,
  findRoundPda,
  getBeaconJoinInstructionAsync,
  getBeaconRecordEntropyInstructionAsync,
  getBeaconRefundInstructionAsync,
  getBeaconReturnInstructionAsync,
  refundFrom,
  resolveJoinRound,
  roundRequestAddress,
  sponsorshipToCompleteDraw,
  ticketOutcome,
} from "../../../clients/js/src/beacon/index.ts";
import {
  BeaconEngine,
  requestStateOf,
  type EngineOptions,
  type Sql,
} from "../../../apps/keeper/src/beaconEngine.ts";
import {
  BEACON_ACTIVE_MS,
  BEACON_IDLE_MS,
  BEACON_QUIET_MS,
  BEACON_WAKE_HOLD_MS,
  DEFAULT_MIN_BALANCE_LAMPORTS,
  SLOT_MS,
  parseAlarmAcknowledgements,
  type AlarmAcknowledgement,
  type BeaconConfig,
  type SponsorPolicy,
} from "../../../apps/keeper/src/beaconPolicy.ts";
import { BeaconEnv, COIN_FLIP, USDC, USDC_MINT } from "../fade/beaconEnv.ts";
import { SendRefusedError } from "../../../apps/keeper/src/beaconChain.ts";
import { REFUSAL_SPAN_MS, REFUSALS_TO_CONFIRM } from "../../../apps/keeper/src/rpcHistory.ts";
import { SvmChain } from "./svmChain.ts";

function memorySql(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    exec: <T>(q: string, ...b: (string | number | null)[]) =>
      db.prepare(q).all(...b) as unknown as T[],
  };
}

type World = {
  env: BeaconEnv;
  chain: SvmChain;
  table: Address;
  ints: KeyPairSigner[];
  shares: Address[];
  pays: KeyPairSigner[];
  funder: KeyPairSigner;
  funderUsdc: Address;
  clock: { now: number };
  logs: string[];
};

async function world(): Promise<World> {
  const env = await BeaconEnv.create();
  const chain = new SvmChain(env);
  const table = await register(env, COIN_FLIP);
  const ints = await Promise.all([0, 1].map(() => env.svm.fundedWallet(10)));
  const shares = await Promise.all(ints.map((k) => env.usdcAccount(k.address, 0n)));
  const pays = await Promise.all([0, 1, 2].map(() => env.svm.fundedWallet(100)));
  const funder = await env.svm.fundedWallet(1);
  const funderUsdc = await env.usdcAccount(funder.address, 1_000_000n * USDC);
  return {
    env,
    chain,
    table,
    ints,
    shares,
    pays,
    funder,
    funderUsdc,
    clock: { now: 1_000_000 },
    logs: [],
  };
}

async function register(env: BeaconEnv, outcomes: OutcomeArgs[]): Promise<Address> {
  const [table] = await findPayoutTablePda(outcomes);
  await env.send(env.keeper, [
    getRegisterPayoutTableInstruction({
      payer: env.keeper,
      payoutTable: table,
      eventAuthority: env.eventAuthority,
      program: FADE_PROGRAM_ADDRESS,
      outcomes,
    }),
  ]);
  return table;
}

function config(fields: Partial<BeaconConfig> = {}): BeaconConfig {
  return {
    program: FADE_PROGRAM_ADDRESS,
    usdcMint: USDC_MINT,
    sponsor: null,
    pushRefunds: false,
    sweepMinUnits: 1n,
    format: null,
    minBalanceLamports: DEFAULT_MIN_BALANCE_LAMPORTS,
    acknowledged: [],
    acknowledgementError: null,
    ...fields,
  };
}

function engine(
  w: World,
  sql: Sql,
  fields: Partial<BeaconConfig> = {},
  hold?: (r: Round, slot: bigint) => boolean,
  options: EngineOptions = {},
) {
  return new BeaconEngine(w.chain, w.env.keeper, sql, config(fields), {
    now: () => w.clock.now,
    log: (level, m) => {
      w.logs.push(`${level} ${m}`);
    },
    ...(hold ? { hold } : {}),
    ...options,
  });
}

/** A third party's `sponsor_round` that pays the accepting round `id` at once. */
async function strangerSponsors(w: World, id: bigint) {
  const { address, data } = await roundOf(w, id);
  const sponsor = await w.env.svm.fundedWallet(1);
  const built = await getCompleteDrawInstructionAsync(sponsor, { address, data: data! });
  await w.chain.sendInstructions(sponsor, [built!.instruction]);
  expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Paid);
}

/** A join through the chain (so its events are seen), as the beacon client builds it. */
async function join(w: World, i: number, price: bigint, format: 0 | 1 = 1) {
  const { env } = w;
  const vault = await env.vault();
  let accepting: Round | null = null;
  if (vault.acceptingRound !== 0n) {
    const [a] = await findRoundPda(vault.acceptingRound);
    if (env.exists(a)) accepting = env.read(a, getRoundDecoder());
  }
  const target = await resolveJoinRound(vault, accepting, env.slot());
  const k = i % w.ints.length;
  const integratorAuthority = w.ints[k]!;
  const [integrator] = await findIntegratorPda({
    integratorAuthority: integratorAuthority.address,
  });
  const created = !env.exists(integrator);
  const nonce = created ? 0n : env.read(integrator, getIntegratorDecoder()).nextNonce;
  const payer = w.pays[i % w.pays.length]!;
  const ix = await getBeaconJoinInstructionAsync(
    {
      integratorAuthority,
      payer,
      funder: w.funder,
      funderUsdc: w.funderUsdc,
      ...(created ? { shareAccount: w.shares[k]! } : {}),
      beneficiary: await env.usdcAccount(payer.address, 0n),
      payoutTable: w.table,
      usdcMint: USDC_MINT,
      price,
      appShareBps: 100,
      nonce,
      sponsorship: 0n,
    },
    target,
  );
  await w.chain.sendInstructions(env.keeper, [ix], format);
  const [ticket] = await findRoundTicketPda({ integrator, nonce });
  return { ticket, id: target.landsIn };
}

async function roundOf(w: World, id: bigint) {
  const [address] = await findRoundPda(id);
  return { address, data: w.env.exists(address) ? w.env.read(address, getRoundDecoder()) : null };
}

/** Ticks the engine `n` times, the clock moving by each requested delay. */
async function ticks(w: World, e: BeaconEngine, n = 1) {
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = await e.tick();
    w.clock.now += last;
  }
  return last;
}

const fill = (b: number) => new Uint8Array(64).fill(b);

const COIN_FLIP_OUTCOMES = COIN_FLIP.map((o) => ({ p: BigInt(o.p), m: BigInt(o.m) }));

/** A randomness under which at least `n` of `tickets` win the coin flip. */
async function randomnessWithWinners(round: Address, tickets: readonly Address[], n: number) {
  for (let b = 1; b < 256; b++) {
    const r = fill(b);
    let wins = 0;
    for (const t of tickets) {
      const o = await ticketOutcome(
        FADE_PROGRAM_ADDRESS,
        round,
        t,
        r,
        COIN_FLIP_OUTCOMES,
        864_000n,
      );
      if (o.payout > 0n) wins++;
    }
    if (wins >= n) return r;
  }
  throw new Error(`no randomness gives ${n} winners`);
}

/** Ten tickets that pay a round, then the engine's request at close_slot + 2: the round, requested. */
async function requestedRound(w: World, e: BeaconEngine) {
  await ticks(w, e);
  let id = 0n;
  const tickets: Address[] = [];
  for (let i = 0; i < 10; i++) {
    const j = await join(w, i, 864_000n);
    id = j.id;
    tickets.push(j.ticket);
  }
  const paid = (await roundOf(w, id)).data!;
  w.env.setSlot(paid.closeSlot + 2n);
  await ticks(w, e);
  const { address, data } = await roundOf(w, id);
  expect(data!.status).toBe(RoundStatus.Requested);
  const [roundVrf] = await findRoundVrfPda({ round: address });
  return { id, address, round: data!, tickets, roundVrf };
}

/** Someone other than the keeper expires `id` at the current slot, in a transaction of its own. */
async function strangerExpires(w: World, id: bigint) {
  const { address, data } = await roundOf(w, id);
  const stranger = await w.env.svm.fundedWallet(1);
  const slotHashes = w.env.data(SLOT_HASHES_SYSVAR);
  // A requested round's stored request; for one never requested, the request its seed names.
  const request =
    data!.status === RoundStatus.Paid
      ? ((await roundRequestAddress({ address, data: data! }, slotHashes))?.request ?? null)
      : data!.randomness;
  const ix = await getBeaconExpireInstructionAsync(
    stranger,
    { address, data: data! },
    w.env.slot(),
    slotHashes,
    request ? w.env.account(request) : null,
  );
  const signature = await w.chain.sendInstructions(stranger, [ix]);
  expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Forfeited);
  return signature;
}

/** How many transactions of `kind` the engine sent (first sends, not resends). */
const sent = (w: World, kind: string) => w.logs.filter((l) => l.includes(`${kind} sent`)).length;

/** Whether an instruction's data is `record_round_entropy`'s. */
const isRecord = (data: ReadonlyUint8Array) =>
  RECORD_ROUND_ENTROPY_DISCRIMINATOR.every((b, i) => data[i] === b);

/** Whether an instruction's data is `sweep_round_vrf`'s, or `return_round_ticket`'s. */
const isSweep = (data: ReadonlyUint8Array) =>
  SWEEP_ROUND_VRF_DISCRIMINATOR.every((b, i) => data[i] === b);
const isReturn = (data: ReadonlyUint8Array) =>
  RETURN_ROUND_TICKET_DISCRIMINATOR.every((b, i) => data[i] === b);

/** Every transaction about to land, as the data of its instructions, from now on. */
function landing(w: World): ReadonlyUint8Array[][] {
  const txs: ReadonlyUint8Array[][] = [];
  w.chain.beforeLand = (data) => {
    txs.push(data);
  };
  return txs;
}

/**
 * A requested round a stranger expires, ORAO's refund landing on its
 * `round_vrf` after, then four ticks of a keeper: with a program that knows
 * `sweep_round_vrf`, or (`refuseSweep`) one that refuses it at preflight as
 * Anchor does an unknown instruction. `gain` is the rent payer's.
 */
async function lateRefundAfterForfeiture(w: World, refuseSweep: boolean) {
  const e = engine(w, memorySql());
  const { id, round, roundVrf, tickets } = await requestedRound(w, e);
  w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
  await strangerExpires(w, id);
  // ORAO answers after the expiry: the pending rent above the fulfilled account's.
  await w.env.fulfill(round.randomness, roundVrf, fill(6));
  const refund = w.env.lamports(roundVrf);
  expect(refund).toBeGreaterThan(0n);
  const txs: ReadonlyUint8Array[][] = [];
  let refusals = 0;
  w.chain.beforeLand = (data) => {
    if (refuseSweep && data.some(isSweep)) {
      refusals++;
      throw new SendRefusedError("preflight: custom program error: 0x65", [
        `Program ${FADE_PROGRAM_ADDRESS} invoke [1]`,
        "Program log: AnchorError occurred. Error Code: InstructionFallbackNotFound. Error Number: 101. Error Message: Fallback functions are not supported.",
        `Program ${FADE_PROGRAM_ADDRESS} failed: custom program error: 0x65`,
      ]);
    }
    txs.push(data);
  };
  const before = w.env.lamports(round.rentPayer);
  await ticks(w, e, 4);
  const gain = w.env.lamports(round.rentPayer) - before;
  return { e, id, roundVrf, tickets, refund, txs, gain, refusals: () => refusals };
}

const expiries = (e: BeaconEngine) =>
  e.alarms().filter((a) => a.kind === "withheld-draw" || a.kind === "unrequested-expiry");

describe("the keeper's beacon loop", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it("watches a round from its events, requests at close_slot + 2 and settles it in one v1 batch", async () => {
    const sql = memorySql();
    const e = engine(w, sql);
    await ticks(w, e); // starts from now
    const price = 864_000n; // T / 10
    const tickets: Address[] = [];
    let id = 0n;
    for (let i = 0; i < 10; i++) {
      const j = await join(w, i, price);
      tickets.push(j.ticket);
      id = j.id;
    }
    let r = (await roundOf(w, id)).data!;
    expect(r.status).toBe(RoundStatus.Paid);
    // Before close_slot + 2 it waits, and asks to be woken about then.
    w.env.setSlot(r.closeSlot);
    const delay = await ticks(w, e);
    expect(delay).toBeLessThanOrEqual(2 * 400);
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Paid);
    // The round's events were read: its tickets are known without a scan.
    expect(
      sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM beacon_tickets WHERE open = 1")[0]!.n,
    ).toBe(10);

    w.env.setSlot(r.closeSlot + 2n);
    await ticks(w, e);
    r = (await roundOf(w, id)).data!;
    expect(r.status).toBe(RoundStatus.Requested);
    // ORAO not yet fulfilled: it waits, fast.
    expect(await ticks(w, e)).toBe(500);

    const [roundVrf] = await findRoundVrfPda({ round: (await roundOf(w, id)).address });
    await w.env.fulfill(r.randomness, roundVrf, fill(7));
    await ticks(w, e);
    // Every ticket settled and the round closed, in one v1 transaction without a lookup table.
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    expect((await roundOf(w, id)).data).toBeNull();
    const settlements = w.logs.filter((l) => l.includes("settlement batch of"));
    expect(settlements).toEqual([expect.stringContaining("settlement batch of 10 sent, v1")]);
    for (const v of w.chain.versions.values()) expect(v).toBe(1);
    await ticks(w, e, 2);
    expect(e.health().openRounds).toBe(0);
    expect(e.health().inFlight).toBe(0);
    expect(e.alarms()).toEqual([]);

    // The shares are swept on the next sweep: the protocol's and each integrator's.
    const vaultBefore = await w.env.vault();
    expect(vaultBefore.protocolSharesAccrued).toBeGreaterThan(0n);
    w.clock.now += 11 * 60_000;
    await ticks(w, e, 2);
    const vaultAfter = await w.env.vault();
    expect(vaultAfter.protocolSharesAccrued).toBe(0n);
    expect(vaultAfter.appSharesOwed).toBe(0n);
    for (const s of w.shares) expect(w.env.balance(s)).toBeGreaterThan(0n);
  });

  it("splits a round its locks cannot hold in one batch, and finds tickets it missed by listing them", async () => {
    // Started after the joins: no event of them is read, the round scan and the
    // ticket listing find everything.
    w.pays.push(...(await Promise.all([...Array(21)].map(() => w.env.svm.fundedWallet(10)))));
    let id = 0n;
    for (let i = 0; i < 24; i++) id = (await join(w, i, 500_000n)).id;
    const r0 = (await roundOf(w, id)).data!;
    expect(r0.tickets).toBe(24);
    const [config] = await findConfigPda();
    expect(w.env.read(config, getConfigDecoder()).params.beaconThreshold).toBeLessThanOrEqual(
      24n * 500_000n,
    );
    const e = engine(w, memorySql());
    w.env.setSlot(r0.closeSlot + 2n);
    await ticks(w, e, 2);
    const r = (await roundOf(w, id)).data!;
    expect(r.status).toBe(RoundStatus.Requested);
    const [roundVrf] = await findRoundVrfPda({ round: (await roundOf(w, id)).address });
    await w.env.fulfill(r.randomness, roundVrf, fill(3));
    await ticks(w, e, 3);
    expect((await roundOf(w, id)).data).toBeNull();
    const batches = w.logs.filter((l) => l.includes("settlement batch of"));
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(b).toContain(", v1,");
  });

  for (const format of [1, 0] as const) {
    it(`batch sizes the loop sends in v${format}, without a lookup table`, async () => {
      // One integrator and one payer, each ticket its own beneficiary: the cheapest mix.
      w.ints = [w.ints[0]!];
      w.shares = [w.shares[0]!];
      w.pays = [w.pays[0]!];
      let id = 0n;
      for (let i = 0; i < 32; i++) id = (await join(w, i, 500_000n)).id;
      const e = engine(w, memorySql(), { format });
      const r = (await roundOf(w, id)).data!;
      w.env.setSlot(r.closeSlot + 2n);
      await ticks(w, e, 2);
      const req = (await roundOf(w, id)).data!;
      const [roundVrf] = await findRoundVrfPda({ round: (await roundOf(w, id)).address });
      await w.env.fulfill(req.randomness, roundVrf, fill(1));
      await ticks(w, e, 3);
      expect((await roundOf(w, id)).data).toBeNull();
      const sizes = w.logs
        .filter((l) => l.includes("settlement batch of"))
        .map((l) => /batch of (\d+) sent, v(\d), (\d+) bytes, (\d+) locks/.exec(l)!)
        .map((m) => ({
          tickets: Number(m[1]),
          v: Number(m[2]),
          bytes: Number(m[3]),
          locks: Number(m[4]),
        }));
      console.log(`v${format} batches: ${JSON.stringify(sizes)}`);
      for (const b of sizes) {
        expect(b.v).toBe(format);
        expect(b.bytes).toBeLessThanOrEqual(format === 1 ? 4_096 : 1_232);
        expect(b.locks).toBeLessThanOrEqual(64);
      }
      expect(sizes.reduce((n, b) => n + b.tickets, 0)).toBe(32);
      if (format === 0) expect(sizes.length).toBeGreaterThan(2);
    });
  }

  it("falls back to plain v0 without a lookup table when the cluster refuses v1 at send", async () => {
    w.chain.refuseV1 = true;
    const e = engine(w, memorySql());
    await ticks(w, e);
    let id = 0n;
    for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n, 0)).id;
    const r = (await roundOf(w, id)).data!;
    w.env.setSlot(r.closeSlot + 2n);
    await ticks(w, e, 2); // refused as v1, rebuilt as v0
    expect(
      w.logs.some((l) => l.includes("plain v0 without a lookup table for the next hour")),
    ).toBe(true);
    const req = (await roundOf(w, id)).data!;
    expect(req.status).toBe(RoundStatus.Requested);
    const [roundVrf] = await findRoundVrfPda({ round: (await roundOf(w, id)).address });
    await w.env.fulfill(req.randomness, roundVrf, fill(11));
    await ticks(w, e, 3);
    expect((await roundOf(w, id)).data).toBeNull();
    const batches = w.logs.filter((l) => l.includes("settlement batch of"));
    expect(batches.length).toBeGreaterThan(1); // v0's 1 232 bytes hold fewer tickets
    for (const b of batches) expect(b).toContain(", v0,");
    for (const v of w.chain.versions.values()) expect(v).toBe(0);
  });

  it("sponsors to complete a draw only within the round's fees, exactly what pays it, once", async () => {
    const sql = memorySql();
    for (let i = 0; i < 3; i++) await join(w, i, 500_000n);
    const vault = await w.env.vault();
    const id = vault.acceptingRound;
    const { address, data } = await roundOf(w, id);
    const missing = sponsorshipToCompleteDraw(data!);
    expect(missing).toBeGreaterThan(0n);
    // The protocol's shares of three 0.50 USDC tickets valued so that they fall one lamport short.
    const rate = ((missing - 1n) * 1_000_000n) / data!.protocolShares;
    const policy = (p: Partial<SponsorPolicy>): SponsorPolicy => ({
      lamportsPerUsdc: rate,
      ownIntegrators: new Set(),
      maxLamports: null,
      ...p,
    });
    const short = engine(w, sql, { sponsor: policy({}) });
    await ticks(w, short, 2);
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Accepting);
    // The app shares of an integrator the operator owns raise the ceiling above the gap.
    const [own] = await findIntegratorPda({ integratorAuthority: w.ints[0]!.address });
    const enough = engine(w, sql, { sponsor: policy({ ownIntegrators: new Set([own]) }) });
    const before = w.env.lamports(w.env.keeper.address);
    await ticks(w, enough, 2);
    const after = (await roundOf(w, id)).data!;
    expect(after.status).toBe(RoundStatus.Paid);
    expect(after.sponsorship).toBe(missing);
    const [record] = await findSponsorshipPda({ round: address, sponsor: w.env.keeper.address });
    expect(w.env.read(record, getSponsorshipDecoder()).amount).toBe(missing);
    expect(before - w.env.lamports(w.env.keeper.address)).toBeGreaterThanOrEqual(missing);
    // Never twice.
    await ticks(w, enough, 2);
    expect((await roundOf(w, id)).data!.sponsorship).toBe(missing);
    // Drawn, settled, then its sponsorship reclaimed: the record and the round closed.
    w.env.setSlot(after.closeSlot + 2n);
    await ticks(w, enough, 2);
    const requested = (await roundOf(w, id)).data!;
    const [roundVrf] = await findRoundVrfPda({ round: address });
    await w.env.fulfill(requested.randomness, roundVrf, fill(5));
    await ticks(w, enough, 4);
    expect(w.env.exists(record)).toBe(false);
    expect((await roundOf(w, id)).data).toBeNull();
  });

  it("leaves a refunded round to its players unless configured to push its returns", async () => {
    const tickets: Address[] = [];
    for (let i = 0; i < 3; i++) tickets.push((await join(w, i, 500_000n)).ticket);
    const id = (await w.env.vault()).acceptingRound;
    const r = await roundOf(w, id);
    w.env.setSlot(r.data!.lastJoinSlot + r.data!.refundSlots);
    // A participant refunds (the keeper never does): the funder, showing a ticket.
    await w.chain.sendInstructions(w.env.keeper, [
      await getRefundRoundInstructionAsync({
        caller: w.funder,
        round: r.address,
        participant: tickets[0]!,
        eventAuthority: w.env.eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
      }),
    ]);
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Refunded);
    const sql = memorySql();
    // Never refunds on its own (nobody is paid to), and by default pushes nothing.
    await ticks(w, engine(w, sql), 3);
    for (const t of tickets) expect(w.env.exists(t)).toBe(true);
    // Configured to push: every ticket returned, the round closed.
    await ticks(w, engine(w, memorySql(), { pushRefunds: true }), 3);
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    expect((await roundOf(w, id)).data).toBeNull();
  });

  it("never refunds an unpaid round itself", async () => {
    for (let i = 0; i < 3; i++) await join(w, i, 500_000n);
    const id = (await w.env.vault()).acceptingRound;
    const r = (await roundOf(w, id)).data!;
    w.env.setSlot(r.firstSlot + r.refundSlots + 10n);
    await ticks(w, engine(w, memorySql(), { pushRefunds: true }), 3);
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Accepting);
  });

  it("never sends a second copy of a step while the first could still land", async () => {
    for (let i = 0; i < 3; i++) await join(w, i, 500_000n);
    const id = (await w.env.vault()).acceptingRound;
    const policy: SponsorPolicy = {
      lamportsPerUsdc: 10n ** 15n,
      ownIntegrators: new Set(),
      maxLamports: null,
    };
    const e = engine(w, memorySql(), { sponsor: policy });
    w.chain.blackhole = true;
    for (let i = 0; i < 6; i++) {
      await ticks(w, e);
      w.clock.now += 11_000; // past the engine's blockhash reuse: a second copy would differ
    }
    // One sponsorship sent, then only resent (same signature) while its blockhash is valid.
    expect(w.logs.filter((l) => l.includes("sponsor sent"))).toHaveLength(1);
    expect(w.chain.swallowed).toBeGreaterThan(1);
    expect(e.health().inFlight).toBe(1);
    // Its blockhash expires: dropped, and the step is built again, now landing.
    w.chain.blackhole = false;
    w.chain.height = 1_000_001n;
    await ticks(w, e, 2);
    expect(w.logs.some((l) => l.includes("expired unconfirmed"))).toBe(true);
    expect(w.logs.filter((l) => l.includes("sponsor sent"))).toHaveLength(2);
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Paid);
    expect((await roundOf(w, id)).data!.sponsors).toBe(1);
  });

  it("expires a round nobody requested, returns its tickets, and reports a keepers' failure, not a withheld draw", async () => {
    const sql = memorySql();
    const hold = (r: Round, slot: bigint) => slot <= r.closeSlot + r.tSettleSlots;
    const e = engine(w, sql, {}, hold);
    await ticks(w, e);
    let id = 0n;
    const tickets: Address[] = [];
    for (let i = 0; i < 10; i++) {
      const j = await join(w, i, 864_000n);
      id = j.id;
      tickets.push(j.ticket);
    }
    const r = (await roundOf(w, id)).data!;
    w.env.setSlot(r.closeSlot + r.tSettleSlots + 1n);
    await ticks(w, e, 4); // expire, read its event, return the tickets
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    expect((await roundOf(w, id)).data).toBeNull();
    // The expiry, and the warning that the round was late to be requested before it.
    const alarms = e.alarms().filter((a) => a.kind !== "request-late");
    expect(
      e
        .alarms()
        .map((a) => a.kind)
        .sort(),
    ).toEqual(["request-late", "unrequested-expiry"]);
    expect(alarms[0]!.severity).toBe("warning");
    expect(alarms[0]!.detail).toContain("requested false, request_found false, checked true");
    expect(e.health().pauseRecommended).toBe(false);
    expect(w.logs.some((l) => l.startsWith("warn ALARM unrequested-expiry"))).toBe(true);
  });

  it("reports a withheld draw when a request someone created was left pending", async () => {
    const sql = memorySql();
    const hold = (r: Round, slot: bigint) => slot <= r.closeSlot + r.tSettleSlots;
    const e = engine(w, sql, {}, hold);
    await ticks(w, e);
    let id = 0n;
    for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n)).id;
    const held = await roundOf(w, id);
    w.env.setSlot(held.data!.closeSlot + 2n);
    const named = await roundRequestAddress(
      { address: held.address, data: held.data! },
      w.env.data(SLOT_HASHES_SYSVAR),
    );
    const stranger = await w.env.svm.fundedWallet(5);
    await w.env.preCreate(stranger, named!.request, named!.seed!);
    w.env.setSlot(held.data!.closeSlot + held.data!.tSettleSlots + 1n);
    await ticks(w, e, 4);
    const alarms = e.alarms().filter((a) => a.kind !== "request-late");
    expect(
      e
        .alarms()
        .map((a) => a.kind)
        .sort(),
    ).toEqual(["request-late", "withheld-draw"]);
    expect(alarms[0]!.severity).toBe("critical");
    expect(alarms[0]!.detail).toContain("requested false, request_found true, checked true");
    expect(e.health().pauseRecommended).toBe(true);
    expect(w.logs.some((l) => l.startsWith("error ALARM withheld-draw"))).toBe(true);
    expect((await roundOf(w, id)).data).toBeNull();
  });

  it("reports a withheld draw for an expiry too late for the program to look for a request", async () => {
    const hold = (r: Round, slot: bigint) => slot <= r.closeSlot + 600n;
    const e = engine(w, memorySql(), {}, hold);
    await ticks(w, e);
    let id = 0n;
    for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n)).id;
    const r = (await roundOf(w, id)).data!;
    // SlotHashes holds 512 slots: past them the entropy slot is no longer proved.
    w.env.setSlot(r.closeSlot + 601n);
    await ticks(w, e, 4);
    const expiry = e.alarms().filter((a) => a.kind !== "request-late");
    expect(expiry.map((a) => a.kind)).toEqual(["withheld-draw"]);
    expect(expiry[0]!.detail).toContain("checked false");
    // Its entropy never recorded, the program refunds it rather than forfeit it.
    expect(expiry[0]!.detail).toContain("refunded");
  });

  it("records a closed round's entropy ahead of its request, which lands after it", async () => {
    const e = engine(w, memorySql());
    await ticks(w, e);
    let id = 0n;
    for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n)).id;
    const { address, data: r } = await roundOf(w, id);
    expect(r!.entropySlot).toBe(0n);
    // Before SlotHashes proves the entropy slot, nothing to record.
    w.env.setSlot(r!.closeSlot + 1n);
    await ticks(w, e);
    expect(sent(w, "record")).toBe(0);
    w.env.setSlot(r!.closeSlot + 2n);
    const named = await roundRequestAddress({ address, data: r! }, w.env.data(SLOT_HASHES_SYSVAR));
    await ticks(w, e, 2);
    const after = (await roundOf(w, id)).data!;
    expect(after.status).toBe(RoundStatus.Requested);
    expect(after.entropySlot).toBe(r!.closeSlot + 1n);
    // The request the recorded seed names, sent after the record, both landed.
    expect(after.randomness).toBe(named!.request);
    const record = w.logs.findIndex((l) => l.includes("record sent"));
    expect(record).toBeGreaterThanOrEqual(0);
    expect(record).toBeLessThan(w.logs.findIndex((l) => l.includes("request sent")));
    expect(w.logs.some((l) => l.includes("ahead of its request, its entropy recorded"))).toBe(true);
    expect(w.logs.some((l) => l.includes("record confirmed"))).toBe(true);
    expect(w.chain.landed.filter((l) => l.error !== null)).toEqual([]);
    expect(sent(w, "record")).toBe(1);
  });

  it("sends no record for a round already recorded, and still requests it", async () => {
    const e = engine(w, memorySql());
    await ticks(w, e);
    let id = 0n;
    for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n)).id;
    const { address, data: r } = await roundOf(w, id);
    w.env.setSlot(r!.closeSlot + 2n);
    const stranger = await w.env.svm.fundedWallet(1);
    const ix = await getBeaconRecordEntropyInstructionAsync(
      { address, data: r! },
      w.env.data(SLOT_HASHES_SYSVAR),
    );
    await w.chain.sendInstructions(stranger, [ix!]);
    expect((await roundOf(w, id)).data!.entropySlot).toBe(r!.closeSlot + 1n);
    await ticks(w, e, 2);
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Requested);
    expect(sent(w, "record")).toBe(0);
  });

  it("takes a record raced by someone else's as harmless: it lands without writing", async () => {
    const sql = memorySql();
    const e = engine(w, sql);
    await ticks(w, e);
    let id = 0n;
    for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n)).id;
    const { address, data: r } = await roundOf(w, id);
    w.env.setSlot(r!.closeSlot + 2n);
    // The keeper read the round unrecorded; a stranger's record lands just before its own.
    const stranger = await w.env.svm.fundedWallet(1);
    const slotHashes = w.env.data(SLOT_HASHES_SYSVAR);
    const theirs = await getBeaconRecordEntropyInstructionAsync({ address, data: r! }, slotHashes);
    w.chain.beforeLand = async (data) => {
      if (!data.some(isRecord)) return;
      w.chain.beforeLand = null;
      await w.chain.sendInstructions(stranger, [theirs!]);
    };
    await ticks(w, e, 2);
    expect(w.chain.beforeLand).toBeNull();
    const after = (await roundOf(w, id)).data!;
    expect(after.status).toBe(RoundStatus.Requested);
    expect(after.entropySlot).toBe(r!.closeSlot + 1n);
    expect(sent(w, "record")).toBe(1);
    expect(w.logs.some((l) => l.includes("record confirmed"))).toBe(true);
    expect(w.chain.landed.filter((l) => l.error !== null)).toEqual([]);
    expect(
      sql.exec<{ last_error: string | null }>(
        "SELECT last_error FROM beacon_rounds WHERE address = ?",
        address,
      )[0]!.last_error,
    ).toBeNull();
    // A record that lands after the request (built from the round as read before it) also
    // succeeds without writing.
    const late = await w.chain.sendInstructions(stranger, [theirs!]);
    expect(w.chain.landed.find((l) => l.signature === late)!.error).toBeNull();
    expect((await roundOf(w, id)).data).toEqual(after);
  });

  it("records a round's entropy ahead of its refused request, so that its expiry still finds the request", async () => {
    const e = engine(w, memorySql());
    await ticks(w, e);
    let id = 0n;
    for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n)).id;
    const r = (await roundOf(w, id)).data!;
    expect(r.entropySlot).toBe(0n);
    // ORAO's fee rises past the round's prefund: its request is refused (`DrawUnderfunded`).
    const [networkState] = await findOraoNetworkStatePda();
    const state = w.env.data(networkState).slice();
    state.set(getU64Encoder().encode(r.drawMax), 72);
    w.env.put(networkState, state, ORAO_VRF_PROGRAM_ADDRESS);
    w.env.setSlot(r.closeSlot + 2n);
    await ticks(w, e, 3);
    const after = (await roundOf(w, id)).data!;
    expect(after.status).toBe(RoundStatus.Paid);
    expect(after.entropySlot).toBe(r.closeSlot + 1n);
    expect(w.logs.some((l) => l.includes("ahead of its request, its entropy recorded"))).toBe(true);
    // Recorded once: the request's retries find the seed recorded.
    expect(sent(w, "record")).toBe(1);
  });

  it("records a round's entropy when its request is refused and the record ahead of it was refused at send", async () => {
    const e = engine(w, memorySql());
    await ticks(w, e);
    let id = 0n;
    for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n)).id;
    const r = (await roundOf(w, id)).data!;
    const [networkState] = await findOraoNetworkStatePda();
    const state = w.env.data(networkState).slice();
    state.set(getU64Encoder().encode(r.drawMax), 72);
    w.env.put(networkState, state, ORAO_VRF_PROGRAM_ADDRESS);
    w.chain.beforeLand = (data) => {
      if (!data.some(isRecord)) return;
      w.chain.beforeLand = null;
      throw new SendRefusedError("preflight: the node is behind", []);
    };
    w.env.setSlot(r.closeSlot + 2n);
    await ticks(w, e);
    const after = (await roundOf(w, id)).data!;
    expect(after.status).toBe(RoundStatus.Paid);
    expect(after.entropySlot).toBe(r.closeSlot + 1n);
    expect(w.logs.some((l) => l.includes("recording its entropy: preflight"))).toBe(true);
    expect(w.logs.some((l) => l.includes("its request refused, its entropy recorded"))).toBe(true);
  });

  for (const how of ["owned by another program", "truncated"] as const)
    it(`records a round's entropy when ORAO's network state is ${how}`, async () => {
      const e = engine(w, memorySql());
      await ticks(w, e);
      let id = 0n;
      for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n)).id;
      const r = (await roundOf(w, id)).data!;
      expect(r.entropySlot).toBe(0n);
      // The request cannot be built: no treasury to pay ORAO's fee to.
      const [networkState] = await findOraoNetworkStatePda();
      const state = w.env.data(networkState).slice();
      if (how === "truncated")
        w.env.put(networkState, state.slice(0, 40), ORAO_VRF_PROGRAM_ADDRESS);
      else w.env.put(networkState, state, FADE_PROGRAM_ADDRESS);
      w.env.setSlot(r.closeSlot + 2n);
      await ticks(w, e);
      const after = (await roundOf(w, id)).data!;
      expect(after.status).toBe(RoundStatus.Paid);
      expect(after.entropySlot).toBe(r.closeSlot + 1n);
      expect(w.logs.some((l) => l.includes("its entropy recorded"))).toBe(true);
      // The request step itself still failed, and is retried on its backoff.
      expect(w.logs.some((l) => l.includes("network state"))).toBe(true);
    });

  it("binds late a request someone created and ORAO fulfilled, and settles it", async () => {
    const hold = (r: Round, slot: bigint) => slot <= r.closeSlot + r.tSettleSlots;
    const e = engine(w, memorySql(), {}, hold);
    await ticks(w, e);
    let id = 0n;
    const tickets: Address[] = [];
    for (let i = 0; i < 10; i++) {
      const j = await join(w, i, 864_000n);
      id = j.id;
      tickets.push(j.ticket);
    }
    const held = await roundOf(w, id);
    w.env.setSlot(held.data!.closeSlot + 2n);
    const named = await roundRequestAddress(
      { address: held.address, data: held.data! },
      w.env.data(SLOT_HASHES_SYSVAR),
    );
    const stranger = await w.env.svm.fundedWallet(5);
    await w.env.preCreate(stranger, named!.request, named!.seed!);
    await w.env.fulfill(named!.request, stranger.address, fill(9));
    w.env.setSlot(held.data!.closeSlot + held.data!.tSettleSlots + 1n);
    await ticks(w, e, 4);
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    expect((await roundOf(w, id)).data).toBeNull();
    expect(w.logs.some((l) => l.includes("late-bind sent"))).toBe(true);
    // Not an expiry: only the warning that it was late.
    expect(e.alarms().map((a) => a.kind)).toEqual(["request-late"]);
  });
  it("reads a request's state: absent, another owner, unparseable, pending, fulfilled with zero, fulfilled", async () => {
    expect(requestStateOf(null)).toBe("absent");
    const e = engine(w, memorySql());
    const { round } = await requestedRound(w, e);
    const pending = w.env.account(round.randomness)!;
    expect(pending.owner).toBe(ORAO_VRF_PROGRAM_ADDRESS);
    expect(requestStateOf(pending)).toBe("pending");
    // ORAO's layout, but under another owner: not a request.
    expect(requestStateOf({ ...pending, owner: FADE_PROGRAM_ADDRESS })).toBe("absent");
    // ORAO's owner, data that is not one of its layouts.
    expect(requestStateOf({ ...pending, data: new Uint8Array(200).fill(9) })).toBe("absent");
    const [roundVrf] = await findRoundVrfPda({ round: (await roundOf(w, round.id)).address });
    await w.env.fulfill(round.randomness, roundVrf, new Uint8Array(64));
    expect(requestStateOf(w.env.account(round.randomness))).toBe("zero");
    const other = await requestedRound(w, engine(w, memorySql()));
    await w.env.fulfill(other.round.randomness, other.roundVrf, fill(4));
    expect(requestStateOf(w.env.account(other.round.randomness))).toBe("fulfilled");
  });

  it("reports a withheld draw when its own request is never fulfilled, and pauses before the expiry", async () => {
    const e = engine(w, memorySql());
    const { id, round, tickets } = await requestedRound(w, e);
    // Spec 02 §3: unfulfilled 60 slots after its request (sent at close_slot + 2), a pause
    // before any forfeiture.
    w.env.setSlot(round.closeSlot + 2n + 61n);
    await ticks(w, e);
    expect(e.alarms().map((a) => [a.kind, a.severity])).toEqual([["fulfilment-late", "critical"]]);
    expect(e.health().pauseRecommended).toBe(true);
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Requested);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    await ticks(w, e, 4);
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    expect((await roundOf(w, id)).data).toBeNull();
    const expiry = expiries(e);
    expect(expiry.map((a) => a.kind)).toEqual(["withheld-draw"]);
    expect(expiry[0]!.detail).toContain("requested true, request_found true, checked true");
    expect(e.health().pauseRecommended).toBe(true);
  });

  it("leads a forfeited round's returns with the sweep of ORAO's late refund, into the round", async () => {
    const run = await lateRefundAfterForfeiture(w, false);
    for (const t of run.tickets) expect(w.env.exists(t)).toBe(false);
    expect((await roundOf(w, run.id)).data).toBeNull();
    expect(w.env.lamports(run.roundVrf)).toBe(0n);
    // The sweep, in the transaction of the first returns, ahead of them; none in the others.
    expect(w.logs.filter((l) => /return \d+ sent/.test(l))).toHaveLength(2);
    const swept = run.txs.filter((d) => d.some(isSweep));
    expect(swept.length).toBeGreaterThan(0);
    for (const d of swept) {
      const ixs = d.filter((x) => isSweep(x) || isReturn(x));
      expect(ixs.filter(isSweep)).toHaveLength(1);
      expect(isSweep(ixs[0]!)).toBe(true);
      expect(ixs.length).toBe(8);
    }
    // The same round in a world whose program refuses the sweep: the rent payer gets
    // exactly the refund more with it.
    const without = await lateRefundAfterForfeiture(await world(), true);
    expect(without.refund).toBe(run.refund);
    expect(run.gain - without.gain).toBe(run.refund);
  });

  it("returns a forfeited round's tickets without the sweep when the program does not know it", async () => {
    const run = await lateRefundAfterForfeiture(w, true);
    // Every ticket returned and the round closed, in the same ticks: the sweep refused once.
    for (const t of run.tickets) expect(w.env.exists(t)).toBe(false);
    expect((await roundOf(w, run.id)).data).toBeNull();
    expect(run.refusals()).toBe(1);
    expect(w.logs.some((l) => l.includes("does not know sweep_round_vrf"))).toBe(true);
    expect(w.env.lamports(run.roundVrf)).toBe(run.refund);
    // Not sent again within the hour, by the watch either.
    w.clock.now += 10 * 60_000;
    await ticks(w, run.e);
    expect(run.refusals()).toBe(1);
    // An hour on, the program upgraded: the watch sweeps it, to the keeper (the round closed).
    w.chain.beforeLand = null;
    w.clock.now += 60 * 60_000;
    await ticks(w, run.e);
    expect(w.env.lamports(run.roundVrf)).toBe(0n);
  });

  it("watches the round_vrf of a requested round expired and closed by others between two reads", async () => {
    const e = engine(w, memorySql(), { sweepMinUnits: null });
    const { id, round, roundVrf, tickets } = await requestedRound(w, e);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    // A stranger's expiry, then another keeper's returns: gone before this one reads it again.
    await strangerExpires(w, id);
    await ticks(w, engine(w, memorySql(), { sweepMinUnits: null }), 4);
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    expect((await roundOf(w, id)).data).toBeNull();
    await ticks(w, e, 4);
    // ORAO answers after the close: the watch, from the expiry's event, sweeps its refund.
    await w.env.fulfill(round.randomness, roundVrf, fill(9));
    const refund = w.env.lamports(roundVrf);
    expect(refund).toBeGreaterThan(0n);
    const keeper = w.env.lamports(w.env.keeper.address);
    w.clock.now += 10 * 60_000;
    await ticks(w, e);
    expect(w.env.lamports(roundVrf)).toBe(0n);
    expect(w.env.lamports(w.env.keeper.address)).toBeGreaterThan(keeper + refund - 10_000n);
  });

  it("sweeps a closed round's round_vrf once ORAO answers after the close, the lamports to the keeper", async () => {
    const e = engine(w, memorySql(), { sweepMinUnits: null });
    const { id, round, roundVrf, tickets } = await requestedRound(w, e);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    await ticks(w, e, 4);
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    expect((await roundOf(w, id)).data).toBeNull();
    expect(w.env.lamports(roundVrf)).toBe(0n);
    await w.env.fulfill(round.randomness, roundVrf, fill(8));
    const refund = w.env.lamports(roundVrf);
    expect(refund).toBeGreaterThan(0n);
    const txs = landing(w);
    const keeper = w.env.lamports(w.env.keeper.address);
    w.clock.now += 10 * 60_000;
    await ticks(w, e);
    expect(w.env.lamports(roundVrf)).toBe(0n);
    expect(txs.filter((d) => d.some(isSweep))).toHaveLength(1);
    const fees = 10_000n; // the sweep's fee and priority fee, at most
    expect(w.env.lamports(w.env.keeper.address)).toBeGreaterThan(keeper + refund - fees);
    // Nothing more to sweep: nothing more sent.
    w.clock.now += 10 * 60_000;
    await ticks(w, e);
    expect(txs.filter((d) => d.some(isSweep))).toHaveLength(1);
    // Past the watch, the round_vrf is no longer read.
    w.env.svm.client.airdrop(roundVrf, lamports(1_000_000n));
    w.clock.now += 8 * 24 * 3_600_000;
    await ticks(w, e);
    expect(w.env.lamports(roundVrf)).toBe(1_000_000n);
  });

  it("a keeper whose storage predates the watches watches the rounds it recorded forfeited after their request, once", async () => {
    const sql = memorySql();
    const old = engine(w, sql, { sweepMinUnits: null });
    const { id, address, round, roundVrf, tickets } = await requestedRound(w, old);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    await ticks(w, old, 4);
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    expect((await roundOf(w, id)).data).toBeNull();
    // The storage an earlier keeper left: its rounds, expiries and alarms, no watch.
    sql.exec("DROP TABLE beacon_vrfs");
    sql.exec("DELETE FROM beacon_state WHERE key = 'vrf_watches_seeded'");
    // An unrequested expiry on record is no request: not watched.
    sql.exec(
      "INSERT INTO beacon_rounds (address, id, open, status, updated_at) VALUES (?, '999', 0, 'closed', ?)",
      (await generateKeyPairSigner()).address,
      w.clock.now,
    );
    sql.exec(
      "INSERT INTO beacon_forfeits (round, ordinal, inferred, at) SELECT address, NULL, 0, ? FROM beacon_rounds WHERE id = '999'",
      w.clock.now,
    );
    // The keeper deployed on it: the forfeited round, closed and never read again, is watched.
    const e = engine(w, sql, { sweepMinUnits: null });
    const watched = () =>
      sql.exec<{ round: string; id: string }>("SELECT round, id FROM beacon_vrfs");
    expect(watched()).toEqual([{ round: address, id: id.toString() }]);
    expect(w.logs.some((l) => l.includes("round_vrf of 1 forfeited round(s) from storage"))).toBe(
      true,
    );
    // ORAO answers after the close: the seeded watch sweeps the refund to the keeper.
    await w.env.fulfill(round.randomness, roundVrf, fill(6));
    const refund = w.env.lamports(roundVrf);
    expect(refund).toBeGreaterThan(0n);
    const keeper = w.env.lamports(w.env.keeper.address);
    w.clock.now += 10 * 60_000;
    await ticks(w, e);
    expect(w.env.lamports(roundVrf)).toBe(0n);
    expect(w.env.lamports(w.env.keeper.address)).toBeGreaterThan(keeper + refund - 10_000n);
    // Seeded once: a later start on the same storage, its watch ended, seeds nothing again.
    sql.exec("DELETE FROM beacon_vrfs");
    engine(w, sql, { sweepMinUnits: null });
    expect(watched()).toEqual([]);
  });

  it("reads every watched round_vrf in turn past a pass's worth, and ends a watch once nothing more can come", async () => {
    const sql = memorySql();
    const e = engine(w, sql, { sweepMinUnits: null });
    // More watches than a pass reads, all due to end before the round's: closed rounds
    // whose request is unknown, so each lasts its full term.
    const stale = 60;
    for (let i = 0; i < stale; i++)
      sql.exec(
        "INSERT INTO beacon_vrfs (round, id, until) VALUES (?, ?, ?)",
        (await generateKeyPairSigner()).address,
        String(1_000 + i),
        w.clock.now + 7 * 24 * 3_600_000 - 1,
      );
    const { id, address, round, roundVrf, tickets } = await requestedRound(w, e);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    await ticks(w, e, 4);
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    expect((await roundOf(w, id)).data).toBeNull();
    await w.env.fulfill(round.randomness, roundVrf, fill(7));
    expect(w.env.lamports(roundVrf)).toBeGreaterThan(0n);
    const watched = (address: Address) =>
      sql.exec("SELECT round FROM beacon_vrfs WHERE round = ?", address).length > 0;
    expect(watched(address)).toBe(true);
    // Within the passes it takes to read every watch once, the round's is swept.
    for (let pass = 0; pass < 3 && w.env.lamports(roundVrf) > 0n; pass++) {
      w.clock.now += 10 * 60_000;
      await ticks(w, e);
    }
    expect(w.env.lamports(roundVrf)).toBe(0n);
    // Closed, its request fulfilled and its round_vrf empty: the watch ends on a later pass.
    for (let pass = 0; pass < 3 && watched(address); pass++) {
      w.clock.now += 10 * 60_000;
      await ticks(w, e);
    }
    expect(watched(address)).toBe(false);
    expect(sql.exec("SELECT round FROM beacon_vrfs")).toHaveLength(stale);
  });

  it("keeps a watch whose round_vrf balance comes from a node behind the fulfilment it read", async () => {
    const sql = memorySql();
    const e = engine(w, sql, { sweepMinUnits: null });
    const { id, address, round, roundVrf, tickets } = await requestedRound(w, e);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    await ticks(w, e, 4);
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    expect((await roundOf(w, id)).data).toBeNull();
    // ORAO answers after the close; a node one slot behind still reads round_vrf empty.
    await w.env.fulfill(round.randomness, roundVrf, fill(5));
    const refund = w.env.lamports(roundVrf);
    expect(refund).toBeGreaterThan(0n);
    w.chain.laggingBalances.set(roundVrf, 0n);
    const watched = () =>
      sql.exec("SELECT round FROM beacon_vrfs WHERE round = ?", address).length > 0;
    for (let pass = 0; pass < 3; pass++) {
      w.clock.now += 10 * 60_000;
      await ticks(w, e);
    }
    // The closed round and its fulfilled request do not end the watch on that empty read.
    expect(watched()).toBe(true);
    expect(w.env.lamports(roundVrf)).toBe(refund);
    // Once a node at the accounts' slot answers, the refund is swept to the keeper.
    w.chain.laggingBalances.clear();
    w.clock.now += 10 * 60_000;
    await ticks(w, e);
    expect(w.env.lamports(roundVrf)).toBe(0n);
  });

  it("never settles a request fulfilled with zero: it expires as a withheld draw", async () => {
    const e = engine(w, memorySql());
    const { id, round, roundVrf, tickets } = await requestedRound(w, e);
    await w.env.fulfill(round.randomness, roundVrf, new Uint8Array(64));
    w.env.setSlot(round.closeSlot + 3n);
    await ticks(w, e, 2);
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Requested);
    expect(w.logs.some((l) => l.includes("settlement batch of"))).toBe(false);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    await ticks(w, e, 4);
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    const expiry = expiries(e);
    expect(expiry.map((a) => a.kind)).toEqual(["withheld-draw"]);
    expect(expiry[0]!.detail).toContain("requested true, request_found true, checked true");
    expect(e.health().pauseRecommended).toBe(true);
  });

  it("still raises a withheld draw when a burst of transactions pushes its expiry past the event cursor", async () => {
    const e = engine(w, memorySql());
    const { id, round, tickets } = await requestedRound(w, e);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    await strangerExpires(w, id);
    // A thousand and one cheap transactions naming the program, none running it.
    w.chain.spam(1_001, [FADE_PROGRAM_ADDRESS]);
    await ticks(w, e, 4);
    expect(w.logs.some((l) => l.includes("skipped, rounds rescanned"))).toBe(true);
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    const expiry = expiries(e);
    expect(expiry.map((a) => a.kind)).toEqual(["withheld-draw"]);
    expect(expiry[0]!.detail).toContain("requested true, request_found true, checked true");
    expect(e.health().pauseRecommended).toBe(true);
  });

  it("raises a withheld draw for a round it finds forfeited on its first start", async () => {
    const first = engine(w, memorySql());
    const { id, round } = await requestedRound(w, first);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    await strangerExpires(w, id);
    // Its storage lost: a new engine starts from now, after the expiry.
    const e = engine(w, memorySql());
    await ticks(w, e, 4);
    expect(expiries(e).map((a) => a.kind)).toEqual(["withheld-draw"]);
    expect(expiries(e)[0]!.detail).toContain("requested true");
    expect(e.health().pauseRecommended).toBe(true);
    expect((await roundOf(w, id)).data).toBeNull();
  });

  it("takes a forfeiture whose expiry it cannot find as a withheld draw (fail closed)", async () => {
    const first = engine(w, memorySql());
    const { id, address, round } = await requestedRound(w, first);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    await strangerExpires(w, id);
    // The expiry buried under more transactions naming the round than a lookup pass reads
    // (400): an honest round has far fewer, so only an attacker gets there.
    w.chain.spam(450, [FADE_PROGRAM_ADDRESS, address]);
    const e = engine(w, memorySql());
    await ticks(w, e, 400);
    const expiry = expiries(e);
    expect(expiry.map((a) => a.kind)).toEqual(["withheld-draw"]);
    expect(expiry[0]!.detail).toContain("expiry event not read");
    expect(e.health().pauseRecommended).toBe(true);
  });

  it("raises no withheld draw for a refunded round whose end is buried under transactions naming it", async () => {
    // The final audit's false alarm: a round the keeper saw accepting is refunded by its own
    // payer and closed by its last return in one transaction, then buried under 1 001 cheap
    // transactions naming the program and the round (past the event cursor, and past what a
    // lookup pass reads). The vault counts no withheld forfeiture: no alarm, no pause.
    const e = engine(w, memorySql());
    await ticks(w, e);
    const j = await join(w, 0, 864_000n);
    await ticks(w, e);
    const held = await roundOf(w, j.id);
    expect(held.data!.status).toBe(RoundStatus.Accepting);
    const slot = refundFrom(held.data!) + held.data!.refundSlots;
    w.env.setSlot(slot);
    const payer = w.pays[0]!;
    const round = { address: held.address, data: held.data! };
    const ticket = { address: j.ticket, data: w.env.read(j.ticket, getRoundTicketDecoder()) };
    await w.chain.sendInstructions(payer, [
      await getBeaconRefundInstructionAsync(payer, round, slot, { ticket }),
      await getBeaconReturnInstructionAsync(payer, round, ticket, USDC_MINT),
    ]);
    expect((await roundOf(w, j.id)).data).toBeNull();
    expect((await w.env.vault()).forfeitsWithheld).toBe(0n);
    w.chain.spam(1_001, [FADE_PROGRAM_ADDRESS, held.address]);
    await ticks(w, e, 400);
    expect(w.logs.some((l) => l.includes("skipped, rounds rescanned"))).toBe(true);
    expect(w.logs.some((l) => l.includes("not a withheld draw"))).toBe(true);
    expect(e.alarms()).toEqual([]);
    expect(e.health().pauseRecommended).toBe(false);
    expect(e.health().openRounds).toBe(0);
  });

  it("accounts a genuine withheld forfeiture once, and then raises nothing for a buried refund", async () => {
    // One real withheld forfeiture, read: the vault's count (1) is accounted for by its
    // expiry, so a later refunded round buried as above raises nothing more.
    const sql = memorySql();
    const e = engine(w, sql);
    const x = await requestedRound(w, e);
    w.env.setSlot(x.round.closeSlot + x.round.tSettleSlots + 1n);
    await strangerExpires(w, x.id);
    await ticks(w, e, 6);
    expect(expiries(e).map((a) => [a.round, a.kind])).toEqual([[x.address, "withheld-draw"]]);
    expect((await w.env.vault()).forfeitsWithheld).toBe(1n);

    const j = await join(w, 0, 864_000n);
    await ticks(w, e);
    const held = await roundOf(w, j.id);
    expect(held.data!.status).toBe(RoundStatus.Accepting);
    const slot = refundFrom(held.data!) + held.data!.refundSlots;
    w.env.setSlot(slot);
    const payer = w.pays[0]!;
    const round = { address: held.address, data: held.data! };
    const ticket = { address: j.ticket, data: w.env.read(j.ticket, getRoundTicketDecoder()) };
    await w.chain.sendInstructions(payer, [
      await getBeaconRefundInstructionAsync(payer, round, slot, { ticket }),
      await getBeaconReturnInstructionAsync(payer, round, ticket, USDC_MINT),
    ]);
    w.chain.spam(1_001, [FADE_PROGRAM_ADDRESS, held.address]);
    await ticks(w, e, 400);
    expect(expiries(e).map((a) => [a.round, a.kind])).toEqual([[x.address, "withheld-draw"]]);
    expect(
      sql.exec<{ round: string; ordinal: number | null }>(
        "SELECT round, ordinal FROM beacon_forfeits",
      ),
    ).toEqual([{ round: x.address, ordinal: 1 }]);
  });

  it("takes a buried expiry of a round nobody requested as the keepers' failure, not a withheld draw", async () => {
    // The round's forfeiture is counted by the vault, but not as withheld: a fresh keeper that
    // cannot read its expiry raises the warning, not the pause.
    const hold = (r: Round, slot: bigint) => slot <= r.closeSlot + r.tSettleSlots;
    const first = engine(w, memorySql(), {}, hold);
    await ticks(w, first);
    let id = 0n;
    for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n)).id;
    const { address, data } = await roundOf(w, id);
    w.env.setSlot(data!.closeSlot + data!.tSettleSlots + 1n);
    await strangerExpires(w, id);
    const v = await w.env.vault();
    expect([v.roundsForfeited, v.forfeitsWithheld]).toEqual([1n, 0n]);
    w.chain.spam(450, [FADE_PROGRAM_ADDRESS, address]);
    const e = engine(w, memorySql());
    await ticks(w, e, 400);
    expect(e.alarms().filter((a) => a.kind === "withheld-draw")).toEqual([]);
    expect(e.health().pauseRecommended).toBe(false);
  });

  it("raises nothing for a round drawn and closed by someone else between two reads", async () => {
    const e = engine(w, memorySql());
    const { id, round, roundVrf } = await requestedRound(w, e);
    await w.env.fulfill(round.randomness, roundVrf, fill(7));
    // Settled by another keeper before this one reads it again: gone, its events not yet read.
    const other = engine(w, memorySql());
    await ticks(w, other, 4);
    expect((await roundOf(w, id)).data).toBeNull();
    w.chain.spam(1_001, [FADE_PROGRAM_ADDRESS]);
    await ticks(w, e, 4);
    expect(e.alarms()).toEqual([]);
    expect(e.health().openRounds).toBe(0);
  });

  it("keeps a round whose closing it read, but not its expiry, until it accounts for the forfeiture", async () => {
    const e = engine(w, memorySql());
    const { id, round } = await requestedRound(w, e);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    // Expired by someone else, in a transaction no RPC serves, then returned and closed.
    w.chain.unreadable.add(await strangerExpires(w, id));
    await ticks(w, engine(w, memorySql()), 4);
    expect((await roundOf(w, id)).data).toBeNull();
    // Its round reads failing, the engine reads only events: the expiry skipped, the closing read.
    w.chain.failAccounts = true;
    await ticks(w, e, 6);
    expect(w.logs.some((l) => l.includes("unreadable: skipped"))).toBe(true);
    expect(expiries(e)).toEqual([]);
    w.chain.failAccounts = false;
    // An unreadable transaction is the RPC lagging, not an answer: the lookups go on for
    // two minutes before the forfeiture is taken as withheld.
    await ticks(w, e, 40);
    const expiry = expiries(e);
    expect(expiry.map((a) => a.kind)).toEqual(["withheld-draw"]);
    expect(expiry[0]!.detail).toContain("expiry event not read (round gone");
  });

  it("keeps recommending the pause after more than twenty newer warnings, and past the retention", async () => {
    const sql = memorySql();
    const e = engine(w, sql);
    const { round } = await requestedRound(w, e);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    await ticks(w, e, 4);
    expect(e.health().pauseRecommended).toBe(true);
    // Twenty-five later rounds, each late to be requested, as during an RPC or ORAO slowdown.
    for (let i = 0; i < 25; i++)
      sql.exec(
        "INSERT INTO beacon_alarms (round, kind, severity, detail, slot, at) VALUES (?, 'request-late', 'warning', '', '0', ?)",
        `round-${i}`,
        w.clock.now + 1_000 + i,
      );
    const h = e.health();
    expect(h.pauseRecommended).toBe(true);
    expect(h.alarms[0]!.kind).toBe("withheld-draw");
    expect(h.alarms.filter((a) => a.kind === "request-late")).toHaveLength(20);
    w.clock.now += 31 * 24 * 3_600_000;
    await ticks(w, e);
    expect(e.health().pauseRecommended).toBe(true);
    expect(e.alarms().filter((a) => a.kind === "request-late")).toEqual([]);
  });

  it("raises an expiry overdue when a requested round past its expiry cannot be expired", async () => {
    const e = engine(w, memorySql());
    const { id, round } = await requestedRound(w, e);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    // ORAO rewrote its request: the program refuses to expire the round on it (§13.5.8).
    w.env.put(round.randomness, new Uint8Array(200).fill(9), ORAO_VRF_PROGRAM_ADDRESS);
    await ticks(w, e, 10);
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Requested);
    const overdue = e.alarms().filter((a) => a.kind === "expiry-overdue");
    expect(overdue.map((a) => a.severity)).toEqual(["critical"]);
    expect(overdue[0]!.detail).toContain("refused expiries");
    expect(e.health().pauseRecommended).toBe(true);
  });

  it("below its balance floor stops sponsoring but still requests", async () => {
    const sql = memorySql();
    for (let i = 0; i < 3; i++) await join(w, i, 500_000n);
    const id = (await w.env.vault()).acceptingRound;
    const policy: SponsorPolicy = {
      lamportsPerUsdc: 10n ** 15n,
      ownIntegrators: new Set(),
      maxLamports: null,
    };
    const floor = w.env.lamports(w.env.keeper.address) + 1n;
    const low = engine(w, sql, { sponsor: policy, minBalanceLamports: floor });
    await ticks(w, low, 3);
    expect(w.logs.some((l) => l.includes("sponsor sent"))).toBe(false);
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Accepting);
    expect(low.health().lowBalance).toBe(true);
    expect(low.alarms().map((a) => [a.kind, a.severity])).toEqual([["low-balance", "warning"]]);
    expect(low.health().pauseRecommended).toBe(false);
    // Funded again (a lower floor here): it sponsors, and the alarm is cleared.
    const funded = engine(w, sql, { sponsor: policy });
    await ticks(w, funded, 2);
    const paid = (await roundOf(w, id)).data!;
    expect(paid.status).toBe(RoundStatus.Paid);
    expect(funded.alarms()).toEqual([]);
    // Below the floor again: the request, a deadline-bound step, still goes.
    const again = engine(w, sql, { sponsor: policy, minBalanceLamports: floor * 2n });
    w.env.setSlot(paid.closeSlot + 2n);
    await ticks(w, again, 2);
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Requested);
  });

  it("reads its balance every few seconds and raises the low-balance alarm with no discretionary step enabled", async () => {
    // No sponsor, no share sweep, no pushed refunds: nothing would ever ask for the balance.
    const floor = w.env.lamports(w.env.keeper.address) + 1n;
    const sql = memorySql();
    const e = engine(w, sql, { sweepMinUnits: null, minBalanceLamports: floor });
    const read = vi.spyOn(w.chain, "balance");
    // The clock held: the quiet pace (20 s) is longer than BALANCE_MS.
    await e.tick();
    expect(read).toHaveBeenCalledTimes(1);
    expect(e.health().lowBalance).toBe(true);
    expect(e.alarms().map((a) => [a.kind, a.severity])).toEqual([["low-balance", "warning"]]);
    // Not read again before BALANCE_MS (10 s), read again after it.
    await e.tick();
    expect(read).toHaveBeenCalledTimes(1);
    w.clock.now += 10_000;
    await e.tick();
    expect(read).toHaveBeenCalledTimes(2);
    // Back above the floor (a lower floor here): cleared on its first read.
    const funded = engine(w, sql, { sweepMinUnits: null });
    await ticks(w, funded);
    expect(funded.health().lowBalance).toBe(false);
    expect(funded.alarms()).toEqual([]);
  });

  it("below its floor, keeps requesting new rounds while rounds left to someone else's reclaim pile up past its window", async () => {
    // A window of three rounds a tick (thirty in production), and a floor it never reaches.
    const floor = w.env.lamports(w.env.keeper.address) + 10n ** 12n;
    const e = engine(w, memorySql(), { minBalanceLamports: floor }, undefined, {
      roundsPerTick: 3,
    });
    await ticks(w, e);
    for (let i = 0; i < 5; i++) {
      // A lone ticket, its round paid by a third party: drawn, the keeper settles it, and its
      // sponsorship is left for the sponsor to reclaim (the keeper's floor stops it pushing).
      const { id } = await join(w, i, 500_000n);
      await strangerSponsors(w, id);
      const paid = (await roundOf(w, id)).data!;
      w.env.setSlot(paid.closeSlot + REQUEST_DELAY_SLOTS);
      await ticks(w, e, 2);
      const requested = (await roundOf(w, id)).data!;
      expect(requested.status, `round ${i} requested`).toBe(RoundStatus.Requested);
      const [roundVrf] = await findRoundVrfPda({ round: (await roundOf(w, id)).address });
      await w.env.fulfill(requested.randomness, roundVrf, fill(20 + i));
      await ticks(w, e, 3);
      const drawn = (await roundOf(w, id)).data!;
      expect(drawn.status).toBe(RoundStatus.Drawn);
      expect([drawn.tickets, drawn.sponsors]).toEqual([0, 1]);
    }
    expect(e.health().lowBalance).toBe(true);
    expect(e.health().openRounds).toBe(5);
  });

  for (const by of ["a stranger", "the keeper"] as const)
    it(`takes no expiry the RPC is slow to serve as a withheld draw (expired by ${by})`, async () => {
      const hold = (r: Round, slot: bigint) => slot <= r.closeSlot + r.tSettleSlots;
      const e = engine(w, memorySql(), {}, hold);
      await ticks(w, e);
      let id = 0n;
      for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n)).id;
      await ticks(w, e);
      const r = (await roundOf(w, id)).data!;
      w.env.setSlot(r.closeSlot + r.tSettleSlots + 1n);
      // Confirmed, but `getTransaction` answers null for its first eight reads.
      w.chain.lagReads = 8;
      if (by === "a stranger") await strangerExpires(w, id);
      await ticks(w, e, 60);
      expect((await roundOf(w, id)).data).toBeNull();
      expect(expiries(e).map((a) => a.kind)).toEqual(["unrequested-expiry"]);
      expect(e.health().pauseRecommended).toBe(false);
    });

  it("counts a late fulfilment from the request: a request late in its window is no pause", async () => {
    // The keeper down until close + 100 (a keepers' failure), then ORAO fulfils 5 slots later.
    const hold = (r: Round, slot: bigint) =>
      r.status === RoundStatus.Paid && slot < r.closeSlot + 100n;
    const e = engine(w, memorySql(), {}, hold);
    await ticks(w, e);
    let id = 0n;
    const tickets: Address[] = [];
    for (let i = 0; i < 10; i++) {
      const j = await join(w, i, 864_000n);
      id = j.id;
      tickets.push(j.ticket);
    }
    const r = (await roundOf(w, id)).data!;
    w.env.setSlot(r.closeSlot + 100n);
    await ticks(w, e);
    const requested = (await roundOf(w, id)).data!;
    expect(requested.status).toBe(RoundStatus.Requested);
    w.env.setSlot(r.closeSlot + 105n);
    await ticks(w, e);
    const [roundVrf] = await findRoundVrfPda({ round: (await roundOf(w, id)).address });
    await w.env.fulfill(requested.randomness, roundVrf, fill(13));
    await ticks(w, e, 3);
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    expect(e.alarms().map((a) => a.kind)).toEqual(["request-late"]);
    expect(e.health().pauseRecommended).toBe(false);
  });

  it("wakes, while a round accepts tickets, when its request could first open", async () => {
    const e = engine(w, memorySql());
    await ticks(w, e);
    const { id } = await join(w, 0, 500_000n);
    const accepting = (await roundOf(w, id)).data!;
    const boundary = closeSlot(w.env.slot(), accepting.tickSlots);
    await ticks(w, e, 2); // the round found, then known
    w.env.setSlot(boundary - 5n);
    const delay = await e.tick();
    // At most the slots until the next boundary's close + 2, not the idle pace.
    expect(delay).toBeLessThanOrEqual(
      Number(boundary + REQUEST_DELAY_SLOTS - (boundary - 5n)) * SLOT_MS,
    );
    w.clock.now += delay;
    // Paid in the boundary's last slot: requested at close + 2.
    w.env.setSlot(boundary - 1n);
    await strangerSponsors(w, id);
    expect((await roundOf(w, id)).data!.closeSlot).toBe(boundary);
    w.env.setSlot(boundary + REQUEST_DELAY_SLOTS);
    await e.tick();
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Requested);
  });

  it("works a round it has just found on the next tick, not after an idle wait", async () => {
    const e = engine(w, memorySql());
    await ticks(w, e, 2);
    expect(await e.tick()).toBe(BEACON_QUIET_MS);
    // A lone ticket paid at once by a sponsorship: found from its events on the next tick.
    const { id } = await join(w, 0, 500_000n);
    await strangerSponsors(w, id);
    const found = await e.tick();
    expect(found).toBeLessThanOrEqual(BEACON_ACTIVE_MS);
    w.clock.now += found;
    const paid = (await roundOf(w, id)).data!;
    w.env.setSlot(paid.closeSlot + REQUEST_DELAY_SLOTS);
    await e.tick();
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Requested);
  });

  it("idles at 5 s for a minute after a wake, and lists the rounds on the tick after it", async () => {
    const e = engine(w, memorySql());
    await ticks(w, e, 2);
    expect(await e.tick()).toBe(BEACON_QUIET_MS);
    let listings = 0;
    const programAccounts = w.chain.programAccounts.bind(w.chain);
    w.chain.programAccounts = async (...args) => {
      listings++;
      return programAccounts(...args);
    };
    e.wake();
    expect(await e.tick()).toBe(BEACON_IDLE_MS);
    expect(listings).toBe(1);
    // A second wake within WAKE_SCAN_MIN_MS keeps the pace but lists nothing more.
    w.clock.now += 1_000;
    e.wake();
    expect(await e.tick()).toBe(BEACON_IDLE_MS);
    expect(listings).toBe(1);
    // Past the hold, the quiet pace again.
    w.clock.now += BEACON_WAKE_HOLD_MS;
    expect(await e.tick()).toBe(BEACON_QUIET_MS);
  });

  it("works a join it was woken for on the next tick", async () => {
    const e = engine(w, memorySql());
    await ticks(w, e, 2);
    const { id } = await join(w, 0, 500_000n);
    await strangerSponsors(w, id);
    e.wake();
    const found = await e.tick();
    expect(found).toBeLessThanOrEqual(BEACON_ACTIVE_MS);
    w.clock.now += found;
    const paid = (await roundOf(w, id)).data!;
    w.env.setSlot(paid.closeSlot + REQUEST_DELAY_SLOTS);
    await e.tick();
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Requested);
  });

  it("keeps its passes' cadence across a restart (a hibernation between quiet ticks)", async () => {
    const sql = memorySql();
    await ticks(w, engine(w, sql), 2);
    let listings = 0;
    const programAccounts = w.chain.programAccounts.bind(w.chain);
    w.chain.programAccounts = async (...args) => {
      listings++;
      return programAccounts(...args);
    };
    // A new engine on the same storage, a quiet period later: no listing of every round, no
    // ten-minute sweep, before their own periods are due.
    w.clock.now += BEACON_QUIET_MS;
    await engine(w, sql).tick();
    expect(listings).toBe(0);
    // A minute after the last listing, the next one.
    w.clock.now += 60_000;
    await engine(w, sql).tick();
    expect(listings).toBeGreaterThan(0);
  });

  it("keeps a send whose answer was lost in flight: one sponsorship, exactly what paid the round", async () => {
    for (let i = 0; i < 3; i++) await join(w, i, 500_000n);
    const id = (await w.env.vault()).acceptingRound;
    const { address, data } = await roundOf(w, id);
    const missing = sponsorshipToCompleteDraw(data!);
    const policy: SponsorPolicy = {
      lamportsPerUsdc: 10n ** 15n,
      ownIntegrators: new Set(),
      maxLamports: null,
    };
    const e = engine(w, memorySql(), { sponsor: policy });
    // The RPC passes the sponsorship on, then its answer is lost (a timeout).
    w.chain.forwardThenThrow = true;
    await ticks(w, e);
    expect(w.chain.forwarded).toHaveLength(1);
    expect(e.health().inFlight).toBe(1);
    // Meanwhile a join lands: the amount that pays the round changes, so a second copy would
    // be a new transaction, and both could land.
    await join(w, 3, 500_000n);
    for (let i = 0; i < 4; i++) {
      w.clock.now += 11_000;
      await ticks(w, e);
    }
    w.chain.forwardThenThrow = false;
    await w.chain.landForwarded();
    await ticks(w, e, 2);
    const paid = (await roundOf(w, id)).data!;
    expect(paid.status).toBe(RoundStatus.Paid);
    const [record] = await findSponsorshipPda({ round: address, sponsor: w.env.keeper.address });
    expect(w.env.read(record, getSponsorshipDecoder()).amount).toBe(missing);
    expect(paid.sponsorship).toBe(missing);
    expect(e.health().inFlight).toBe(0);
  });

  it("starts a lookup's clock afresh once the round reads back normally after an empty read", async () => {
    // Nobody requests the round: its expiry is a keepers' failure, never a withheld draw.
    const hold = (r: Round, slot: bigint) => slot <= r.closeSlot + r.tSettleSlots;
    const e = engine(w, memorySql(), {}, hold);
    await ticks(w, e);
    let id = 0n;
    for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n)).id;
    await ticks(w, e);
    const { address } = await roundOf(w, id);
    // One read of the round comes back empty (a lagging RPC node): a lookup starts.
    w.chain.nullReads.set(address, 1);
    await ticks(w, e);
    await ticks(w, e, 3);
    // Five minutes later a stranger forfeits it, and the RPC serves that expiry 20 s late.
    w.clock.now += 5 * 60_000;
    const r = (await roundOf(w, id)).data!;
    w.env.setSlot(r.closeSlot + r.tSettleSlots + 1n);
    const expiry = await strangerExpires(w, id);
    w.chain.unreadable.add(expiry);
    const forfeitedAt = w.clock.now;
    for (let i = 0; i < 80; i++) {
      if (w.clock.now - forfeitedAt >= 20_000) w.chain.unreadable.delete(expiry);
      await ticks(w, e);
      expect(
        e.alarms().filter((a) => a.kind === "withheld-draw"),
        `no withheld draw ${w.clock.now - forfeitedAt} ms after the forfeiture`,
      ).toEqual([]);
    }
    expect(expiries(e).map((a) => a.kind)).toEqual(["unrequested-expiry"]);
    expect(e.health().pauseRecommended).toBe(false);
  });

  it("finds an expiry behind more than twenty newer transactions, its returns one a transaction, on a first start", async () => {
    const hold = (r: Round, slot: bigint) => slot <= r.closeSlot + r.tSettleSlots;
    const first = engine(w, memorySql(), {}, hold);
    await ticks(w, first);
    let id = 0n;
    const tickets: Address[] = [];
    // Eighteen tickets at the minimum price, 0.50 USDC, pay the round.
    for (let i = 0; i < 18; i++) {
      const j = await join(w, i, 500_000n);
      id = j.id;
      tickets.push(j.ticket);
    }
    const r = (await roundOf(w, id)).data!;
    expect(r.status).toBe(RoundStatus.Paid);
    expect(r.tickets).toBe(18);
    w.env.setSlot(r.closeSlot + r.tSettleSlots + 1n);
    await strangerExpires(w, id);
    // Another caller returns 17 tickets one a transaction (each pays it a settlement share),
    // among other transactions naming the round: 23 newer than its expiry.
    const caller = await w.env.svm.fundedWallet(1);
    for (const t of tickets.slice(0, 17)) {
      const { address, data } = await roundOf(w, id);
      const ticket = { address: t, data: w.env.read(t, getRoundTicketDecoder()) };
      const ix = await getBeaconReturnInstructionAsync(
        caller,
        { address, data: data! },
        ticket,
        USDC_MINT,
      );
      await w.chain.sendInstructions(caller, [ix]);
    }
    w.chain.spam(6, [FADE_PROGRAM_ADDRESS, (await roundOf(w, id)).address]);
    expect((await roundOf(w, id)).data!.tickets).toBe(1);
    // The keeper restarts without its storage: the cursor starts from now, after the expiry.
    const e = engine(w, memorySql());
    // Three minutes: past every bound after which a lookup concludes (30 s, 120 s).
    const start = w.clock.now;
    while (w.clock.now - start < 180_000) await ticks(w, e);
    expect((await roundOf(w, id)).data).toBeNull();
    expect(expiries(e).map((a) => a.kind)).toEqual(["unrequested-expiry"]);
    expect(e.health().pauseRecommended).toBe(false);
  });

  it("replaces an inferred withheld draw with the expiry, once the expiry is read", async () => {
    const sql = memorySql();
    const e = engine(w, sql);
    const { id, round } = await requestedRound(w, e);
    w.env.setSlot(round.closeSlot + round.tSettleSlots + 1n);
    // A stranger's expiry of the unfulfilled request, which the RPC never serves: the vault
    // counts it as withheld, so two minutes of lookups, then fail closed.
    const expiry = await strangerExpires(w, id);
    w.chain.unreadable.add(expiry);
    await ticks(w, e, 120);
    expect(expiries(e).map((a) => a.kind)).toEqual(["withheld-draw"]);
    expect(expiries(e)[0]!.detail).toContain("expiry event not read");
    expect(expiries(e)[0]!.detail).toContain("1 withheld forfeiture(s) the vault counts");
    expect(e.health().pauseRecommended).toBe(true);
    // Served at last, and read by the event cursor (behind, as with a backlog).
    w.chain.unreadable.delete(expiry);
    const at = w.chain.landed.findIndex((l) => l.signature === expiry);
    const previous = w.chain.landed
      .slice(0, at)
      .reverse()
      .find((l) => l.keys.includes(FADE_PROGRAM_ADDRESS))!;
    sql.exec("UPDATE beacon_state SET value = ? WHERE key = 'cursor'", previous.signature);
    await ticks(w, e, 2);
    expect(expiries(e).map((a) => [a.kind, a.severity])).toEqual([["withheld-draw", "critical"]]);
    expect(expiries(e)[0]!.detail).toContain("requested true, request_found true, checked true");
    expect(e.health().pauseRecommended).toBe(true);
    // Accounted for by the expiry itself, as the vault's first withheld forfeiture.
    expect(
      sql.exec<{ ordinal: number; inferred: number }>(
        "SELECT ordinal, inferred FROM beacon_forfeits",
      ),
    ).toEqual([{ ordinal: 1, inferred: 0 }]);
  });

  it("never infers a withheld draw from an unreadable expiry the vault does not count as one", async () => {
    const sql = memorySql();
    const hold = (r: Round, slot: bigint) => slot <= r.closeSlot + r.tSettleSlots;
    const e = engine(w, sql, {}, hold);
    await ticks(w, e);
    let id = 0n;
    for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n)).id;
    await ticks(w, e);
    const r = (await roundOf(w, id)).data!;
    w.env.setSlot(r.closeSlot + r.tSettleSlots + 1n);
    // A stranger's expiry of a round nobody requested, which the RPC never serves: the vault
    // counts the forfeiture, not as withheld, so the lookups conclude without a pause.
    const expiry = await strangerExpires(w, id);
    w.chain.unreadable.add(expiry);
    await ticks(w, e, 120);
    expect(e.alarms().filter((a) => a.kind === "withheld-draw")).toEqual([]);
    expect(e.health().pauseRecommended).toBe(false);
    // Served at last, and read by the event cursor: the keepers' failure, a warning.
    w.chain.unreadable.delete(expiry);
    const at = w.chain.landed.findIndex((l) => l.signature === expiry);
    const previous = w.chain.landed
      .slice(0, at)
      .reverse()
      .find((l) => l.keys.includes(FADE_PROGRAM_ADDRESS))!;
    sql.exec("UPDATE beacon_state SET value = ? WHERE key = 'cursor'", previous.signature);
    await ticks(w, e, 2);
    expect(expiries(e).map((a) => [a.kind, a.severity])).toEqual([
      ["unrequested-expiry", "warning"],
    ]);
    expect(expiries(e)[0]!.detail).toContain("requested false, request_found false, checked true");
    expect(e.health().pauseRecommended).toBe(false);
  });

  it("acts on its rounds before any expiry lookup, and bounds a tick's lookups", async () => {
    const sql = memorySql();
    const e = engine(w, sql);
    await ticks(w, e);
    let id = 0n;
    for (let i = 0; i < 10; i++) id = (await join(w, i, 864_000n)).id;
    await ticks(w, e, 2);
    const paid = (await roundOf(w, id)).data!;
    expect(paid.status).toBe(RoundStatus.Paid);
    // Three rounds gone before their end was read, each buried under 30 transactions.
    const gone: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (await generateKeyPairSigner()).address;
      gone.push(a);
      sql.exec("INSERT INTO beacon_rounds (address, open, updated_at) VALUES (?, 1, 0)", a);
      w.chain.spam(30, [a]);
    }
    const calls: string[] = [];
    const chain = w.chain;
    const signatures = chain.signatures.bind(chain);
    const transaction = chain.transaction.bind(chain);
    const send = chain.send.bind(chain);
    chain.signatures = async (address, options) => {
      calls.push(gone.includes(address) ? "lookup" : "signatures");
      return signatures(address, options);
    };
    const spam = new Set(
      chain.landed
        .filter((l) => gone.some((g) => l.keys.includes(g as Address)))
        .map((l) => l.signature),
    );
    chain.transaction = async (signature) => {
      if (spam.has(signature)) calls.push("lookup-read");
      return transaction(signature);
    };
    chain.send = async (wire, skip) => {
      calls.push("send");
      return send(wire, skip);
    };
    w.env.setSlot(paid.closeSlot + 2n);
    await e.tick();
    expect((await roundOf(w, id)).data!.status).toBe(RoundStatus.Requested);
    const firstLookup = calls.indexOf("lookup");
    expect(firstLookup).toBeGreaterThan(calls.indexOf("send"));
    expect(calls.indexOf("send")).toBeGreaterThanOrEqual(0);
    expect(calls.filter((c) => c === "lookup-read").length).toBeLessThanOrEqual(20);
  });

  /**
   * An engine past one ticket joined and read from its events, with its RPC refusing calls bounded
   * by its event cursor as `refusal` says (-32020 for a lost signature, as Agave refuses it).
   */
  async function refusingCursor(w: World, refusal: (cursor: string) => Error | null) {
    const sql = memorySql();
    const e = engine(w, sql);
    await ticks(w, e);
    const first = await join(w, 0, 864_000n);
    await ticks(w, e);
    const open = () =>
      sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM beacon_tickets WHERE open = 1")[0]!.n;
    expect(open()).toBe(1);
    const state = (key: string) =>
      sql.exec<{ value: string }>("SELECT value FROM beacon_state WHERE key = ?", key)[0]?.value;
    const cursor = state("cursor")!;
    const chain = w.chain;
    const signatures = chain.signatures.bind(chain);
    const refused: string[] = [];
    chain.signatures = async (address, options) => {
      if (options.until === cursor || options.before === cursor) {
        const err = refusal(cursor);
        if (err) {
          refused.push(cursor);
          throw err;
        }
      }
      return signatures(address, options);
    };
    return { e, first, open, state, cursor, refused };
  }

  const lost = (cursor: string) =>
    new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND, {
      __serverMessage: `Transaction ${cursor} not found`,
    });
  const gone = (w: World) => w.logs.filter((l) => l.includes("no longer holds"));

  it("starts again from now once the RPC lastingly refuses its event cursor, instead of failing every tick", async () => {
    // The cursor ages out of the RPC's history (a local validator keeps a few minutes of it):
    // Agave refuses every call bounded by it with -32020.
    const { e, first, open, state, cursor, refused } = await refusingCursor(w, lost);
    const second = await join(w, 1, 864_000n);
    expect(second.id).toBe(first.id);
    // A refusal that has not lasted yet fails the read, asked again next tick: the cursor kept.
    await ticks(w, e);
    expect(refused).toEqual([cursor]);
    expect(state("cursor")).toBe(cursor);
    expect(w.logs.filter((l) => l.includes("reading events"))).toHaveLength(1);
    expect(gone(w)).toEqual([]);
    for (let i = 0; i < 10 && state("cursor") === cursor; i++) {
      w.clock.now += 30_000;
      await ticks(w, e);
    }
    // Refused REFUSALS_TO_CONFIRM times over REFUSAL_SPAN_MS: the cursor moved to now, and the
    // rounds are rescanned (a round's tickets whose events were skipped are listed when it is
    // settled or returned).
    expect(refused).toEqual(Array(REFUSALS_TO_CONFIRM).fill(cursor));
    expect(w.logs).toContainEqual(
      expect.stringContaining(`the RPC no longer holds the event cursor ${cursor}`),
    );
    expect(state("cursor")).not.toBe(cursor);
    expect(state("history_refusal")).toBeUndefined();
    expect(open()).toBe(1);
    // The events that follow are read again from the new cursor.
    await join(w, 2, 864_000n);
    await ticks(w, e);
    expect(open()).toBe(2);
    expect(refused).toHaveLength(REFUSALS_TO_CONFIRM);
  });

  it("takes one refusal of its event cursor, from a node behind, as nothing: no event skipped, read next tick", async () => {
    // a load-balanced provider's node a slot or two behind refuses the fresh cursor, once
    let lagging = true;
    const { e, open, state, cursor, refused } = await refusingCursor(w, (c) => {
      if (!lagging) return null;
      lagging = false;
      return lost(c);
    });
    await join(w, 1, 864_000n);
    await ticks(w, e);
    expect(refused).toEqual([cursor]);
    expect(state("cursor")).toBe(cursor);
    expect(JSON.parse(state("history_refusal")!)).toMatchObject({ bound: cursor, count: 1 });
    // the next tick reads the events from the cursor: the ticket found by its own event
    w.clock.now += 30_000;
    await ticks(w, e);
    expect(open()).toBe(2);
    expect(state("cursor")).not.toBe(cursor);
    expect(state("history_refusal")).toBeUndefined();
    expect(gone(w)).toEqual([]);
    expect(refused).toEqual([cursor]);
  });

  it("throws any other error of a call bounded by its event cursor as it is, never reading it as pruning", async () => {
    let unhealthy = true;
    const { e, open, state, cursor, refused } = await refusingCursor(w, () =>
      unhealthy
        ? new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY, {
            numSlotsBehind: 3,
          })
        : null,
    );
    await join(w, 1, 864_000n);
    for (let i = 0; i < 2 * REFUSALS_TO_CONFIRM; i++) {
      w.clock.now += REFUSAL_SPAN_MS;
      await ticks(w, e);
    }
    expect(refused.length).toBeGreaterThanOrEqual(2 * REFUSALS_TO_CONFIRM);
    expect(state("cursor")).toBe(cursor);
    expect(state("history_refusal")).toBeUndefined();
    expect(gone(w)).toEqual([]);
    unhealthy = false;
    await ticks(w, e);
    expect(open()).toBe(2);
  });

  it("resolves a late fulfilment once its round is drawn: no pause left, the alarm kept", async () => {
    const e = engine(w, memorySql());
    const { id, round, roundVrf, tickets } = await requestedRound(w, e);
    // ORAO slow, not withholding: 61 slots after the request (89 once on devnet).
    w.env.setSlot(round.closeSlot + 2n + 61n);
    await ticks(w, e);
    expect(e.alarms().map((a) => [a.kind, a.severity])).toEqual([["fulfilment-late", "critical"]]);
    expect(e.health().pauseRecommended).toBe(true);
    await w.env.fulfill(round.randomness, roundVrf, fill(11));
    await ticks(w, e, 4);
    for (const t of tickets) expect(w.env.exists(t)).toBe(false);
    expect((await roundOf(w, id)).data).toBeNull();
    const [late] = e.alarms();
    expect(late!.kind).toBe("fulfilment-late");
    expect(late!.resolvedAt).not.toBeNull();
    expect(late!.resolution).toBe("drawn: ORAO fulfilled the request");
    expect(e.health().pauseRecommended).toBe(false);
  });

  it("retries each parked payout on its own backoff: payouts that stay refused never block another", async () => {
    const e0 = engine(w, memorySql());
    await ticks(w, e0);
    const tickets: Address[] = [];
    let id = 0n;
    for (let i = 0; i < 10; i++) {
      const j = await join(w, i, 864_000n);
      id = j.id;
      tickets.push(j.ticket);
    }
    // Every beneficiary frozen before the draw: every winner's payout is parked.
    const beneficiaries = tickets.map((t) => w.env.read(t, getRoundTicketDecoder()).beneficiary);
    for (const b of beneficiaries) w.env.setTokenState(b, 2);
    const sql = memorySql();
    const probe = engine(w, sql);
    await ticks(w, probe);
    const paid = (await roundOf(w, id)).data!;
    w.env.setSlot(paid.closeSlot + 2n);
    await ticks(w, probe);
    const requested = (await roundOf(w, id)).data!;
    const { address: roundAddress } = await roundOf(w, id);
    const [roundVrf] = await findRoundVrfPda({ round: roundAddress });
    // The tickets' addresses come from fresh wallets, so a fixed randomness
    // would leave fewer than two winners about once in a hundred runs: pick
    // one that makes at least two of them win.
    await w.env.fulfill(
      requested.randomness,
      roundVrf,
      await randomnessWithWinners(roundAddress, tickets, 2),
    );
    await ticks(w, probe, 4);
    const parked = tickets.filter(
      (t) =>
        w.env.exists(t) &&
        w.env.read(t, getRoundTicketDecoder()).status === RoundTicketStatus.PayoutParked,
    );
    expect(parked.length).toBeGreaterThanOrEqual(2);
    // A pass tries one ticket fewer than are parked; only the last parked can receive again.
    const e = engine(w, sql, {}, undefined, { parkedPerPass: parked.length - 1 });
    const last = parked[parked.length - 1]!;
    const lastBeneficiary = beneficiaries[tickets.indexOf(last)]!;
    w.env.setTokenState(lastBeneficiary, 1);
    for (let pass = 0; pass < 3; pass++) {
      w.clock.now += 11 * 60_000;
      await ticks(w, e, 2);
    }
    expect(w.env.exists(last)).toBe(false);
    expect(w.env.balance(lastBeneficiary)).toBeGreaterThan(0n);
    for (const t of parked.slice(0, -1)) expect(w.env.exists(t)).toBe(true);
    // Their beneficiaries thawed: delivered within their backoff.
    for (const b of beneficiaries) w.env.setTokenState(b, 1);
    for (let pass = 0; pass < 30; pass++) {
      w.clock.now += 11 * 60_000;
      await ticks(w, e, 2);
    }
    for (const t of parked) expect(w.env.exists(t)).toBe(false);
    expect(sql.exec("SELECT address FROM beacon_tickets WHERE parked = 1")).toEqual([]);
  });
});

describe("the operator's acknowledgement of alarms (BEACON_ACKNOWLEDGED_ALARMS)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  const REASON = "the keeper itself was down: not a withheld draw";
  const ack = (round: Address, kind: AlarmAcknowledgement["kind"] = "withheld-draw") => ({
    round,
    kind,
    reason: REASON,
  });
  const acknowledgements = (w: World) =>
    w.logs.filter((l) => l.includes("acknowledged by the operator"));

  /** A requested round a stranger expires, its withheld draw raised by a keeper on `sql`. */
  async function withheldDraw(w: World, sql: Sql) {
    const e = engine(w, sql);
    const r = await requestedRound(w, e);
    w.env.setSlot(r.round.closeSlot + r.round.tSettleSlots + 1n);
    await strangerExpires(w, r.id);
    await ticks(w, e, 4);
    expect(expiries(e).map((a) => [a.kind, a.resolvedAt])).toEqual([["withheld-draw", null]]);
    expect(e.health().pauseRecommended).toBe(true);
    return r;
  }

  it("resolves the acknowledged alarm with its reason: no pause left, the alarm kept, logged once", async () => {
    const sql = memorySql();
    const { address } = await withheldDraw(w, sql);
    // The next deploy carries the acknowledgement: applied as the engine starts.
    const e = engine(w, sql, { acknowledged: [ack(address)] });
    expect(e.health().pauseRecommended).toBe(false);
    const [alarm] = expiries(e);
    expect(alarm!.round).toBe(address);
    expect(alarm!.resolvedAt).not.toBeNull();
    expect(alarm!.resolution).toBe(`acknowledged: ${REASON}`);
    expect(e.health().acknowledgementError).toBeNull();
    expect(acknowledgements(w)).toEqual([
      `warn round ${address}: withheld-draw acknowledged by the operator: ${REASON}`,
    ]);
    // Ticks after it: still resolved, never logged again, the round never raised again.
    await ticks(w, e, 4);
    expect(e.health().pauseRecommended).toBe(false);
    expect(expiries(e)).toHaveLength(1);
    expect(acknowledgements(w)).toHaveLength(1);
  });

  it("resolves nothing for another round, or another kind on the same round", async () => {
    const sql = memorySql();
    const { address } = await withheldDraw(w, sql);
    const e = engine(w, sql, {
      acknowledged: [
        ack(w.funder.address),
        ack(address, "expiry-overdue"),
        ack(address, "unrequested-expiry"),
      ],
    });
    await ticks(w, e, 2);
    expect(e.health().pauseRecommended).toBe(true);
    expect(expiries(e).map((a) => [a.kind, a.resolvedAt, a.resolution])).toEqual([
      ["withheld-draw", null, null],
    ]);
    expect(acknowledgements(w)).toEqual([]);
  });

  it("keeps an alarm raised after its acknowledgement resolved, and never touches another round's", async () => {
    const sql = memorySql();
    const first = await requestedRound(w, engine(w, sql));
    // Acknowledged before its alarm exists: raised, then resolved at once.
    const e = engine(w, sql, { acknowledged: [ack(first.address)] });
    w.env.setSlot(first.round.closeSlot + first.round.tSettleSlots + 1n);
    await strangerExpires(w, first.id);
    // Never recommended, not even between the tick that raises it and the next.
    for (let i = 0; i < 4; i++) {
      await ticks(w, e);
      expect(e.health().pauseRecommended, `tick ${i}`).toBe(false);
    }
    expect(expiries(e).map((a) => [a.round, a.resolution])).toEqual([
      [first.address, `acknowledged: ${REASON}`],
    ]);
    expect(e.health().pauseRecommended).toBe(false);
    expect(w.logs.some((l) => l.startsWith("error ALARM withheld-draw"))).toBe(true);
    // A later round's withheld draw: raised and left unresolved, the pause recommended.
    const second = await requestedRound(w, e);
    w.env.setSlot(second.round.closeSlot + second.round.tSettleSlots + 1n);
    await strangerExpires(w, second.id);
    await ticks(w, e, 4);
    const open = expiries(e).filter((a) => a.resolvedAt === null);
    expect(open.map((a) => [a.round, a.kind])).toEqual([[second.address, "withheld-draw"]]);
    expect(e.health().pauseRecommended).toBe(true);
    expect(acknowledgements(w)).toHaveLength(1);
  });

  it("applies none of a malformed list: the alarm stays, the error is on the health", async () => {
    const sql = memorySql();
    const { address } = await withheldDraw(w, sql);
    // A typo: one entry well formed, the next not; the whole list is ignored.
    const parsed = parseAlarmAcknowledgements(
      JSON.stringify([ack(address), { round: address, kind: "withheld_draw", reason: REASON }]),
    );
    expect(parsed.error).toContain("entry 1: kind is not an alarm kind");
    const e = engine(w, sql, {
      acknowledged: parsed.acknowledged,
      acknowledgementError: parsed.error,
    });
    await ticks(w, e, 2);
    const h = e.health();
    expect(h.pauseRecommended).toBe(true);
    expect(h.acknowledgementError).toBe(parsed.error);
    expect(expiries(e).map((a) => a.resolvedAt)).toEqual([null]);
    expect(w.logs).toContain(`error ${parsed.error}`);
    expect(acknowledgements(w)).toEqual([]);
  });

  it("adds the resolution column to an existing alarm table, keeping its rows", async () => {
    const db = memorySql();
    // beacon_alarms as an earlier version created it, with a critical alarm on record.
    db.exec(`CREATE TABLE beacon_alarms (
      round TEXT NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      detail TEXT NOT NULL,
      slot TEXT NOT NULL,
      at INTEGER NOT NULL,
      inferred INTEGER NOT NULL DEFAULT 0,
      resolved_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (round, kind)
    )`);
    const round = w.funder.address;
    const other = w.pays[0]!.address;
    for (const r of [round, other])
      db.exec(
        "INSERT INTO beacon_alarms (round, kind, severity, detail, slot, at) VALUES (?, 'withheld-draw', 'critical', 'old', '7', ?)",
        r,
        w.clock.now,
      );
    const e = engine(w, db, { acknowledged: [ack(round)] });
    const columns = db
      .exec<{ name: string }>("PRAGMA table_info(beacon_alarms)")
      .map((c) => c.name);
    expect(columns).toContain("resolution");
    const byRound = new Map(e.alarms().map((a) => [a.round, a]));
    expect(byRound.get(round)!.resolution).toBe(`acknowledged: ${REASON}`);
    expect(byRound.get(other)!.resolution).toBeNull();
    expect(byRound.get(other)!.detail).toBe("old");
    expect(e.health().pauseRecommended).toBe(true);
  });
});
