// The beacon client end to end in litesvm (npm, mainnet feature set): every
// beacon instruction built by the generated client and the helpers of
// clients/js/src/beacon, simulated, then sent. A drawn round settled in v1
// batches and in v0 batches without a lookup table, a refunded round, a
// round sponsored to its draw then forfeited, and the largest batch of each
// format run for three mixes of integrators and payers. The Rust suites
// prove the protocol; this one proves the client builds what the program
// accepts.
import { describe, expect, it } from "vitest";
import {
  createNoopSigner,
  generateKeyPairSigner,
  lamports,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  FADE_PROGRAM_ADDRESS,
  MAX_ROUND_BATCH,
  RoundStatus,
  RoundTicketStatus,
  findConfigPda,
  findIntegratorPda,
  findRoundTicketPda,
  findRoundVrfPda,
  findSponsorshipPda,
  findVaultPda,
  findVaultUsdcPda,
  ROUND_EXPIRED_EVENT_DISCRIMINATOR,
  ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR,
  ROUND_VRF_SWEPT_EVENT_DISCRIMINATOR,
  getClaimSharesInstructionAsync,
  getConfigDecoder,
  getExpireRoundInstructionAsync,
  getIntegratorDecoder,
  getPayoutTableDecoder,
  getRefundRoundInstructionAsync,
  getRegisterPayoutTableInstruction,
  getRequestRoundDrawInstructionAsync,
  getRoundDecoder,
  getRoundExpiredEventDecoder,
  getRoundTicketReturnedEventDecoder,
  getRoundTicketDecoder,
  getRoundVrfSweptEventDecoder,
  getSponsorshipDecoder,
  type OutcomeArgs,
  type PayoutTable,
  type Round,
  type RoundTicket,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  MAX_ACCOUNT_LOCKS,
  MAX_INSTRUCTION_TRACE,
  ORAO_VRF_PROGRAM_ADDRESS,
  RoundDrawFulfilledError,
  SLOT_HASHES_SYSVAR,
  batchFits,
  beaconTransactionMessage,
  findOraoNetworkStatePda,
  findPayoutTablePda,
  findRoundPda,
  getBeaconClaimPayoutInstructionAsync,
  getBeaconExpireInstructionAsync,
  getBeaconJoinInstructionAsync,
  getBeaconReclaimInstructionAsync,
  getBeaconRecordEntropyInstructionAsync,
  getBeaconRequestDrawInstructionAsync,
  getBeaconReturnInstructionAsync,
  getBeaconSweepVrfInstructionAsync,
  getCompleteDrawInstructionAsync,
  entropyRecorded,
  inRequestWindow,
  measure,
  isExpired,
  isPaid,
  lonePaySponsorship,
  newRoundTerms,
  oraoNetworkState,
  planSettlement,
  predictSettlement,
  getBeaconRefundInstructionAsync,
  refundFrom,
  refundOpen,
  resolveJoinRound,
  roundRandomness,
  roundRequestAddress,
  roundTerms,
  roundVrfSweepable,
  settleBase,
  settleInstruction,
  settlementOrder,
  settlementTrace,
  settlementUnits,
  sponsorshipToCompleteDraw,
  sponsorshipToPay,
  type Held,
  type SettlementItem,
  type TransactionFormat,
} from "../../../clients/js/src/beacon/index.ts";
import {
  BeaconEnv,
  COIN_FLIP,
  ORAO_FEE,
  THREE_WAY,
  USDC,
  USDC_MINT,
  type Sent,
} from "./beaconEnv.ts";

type Player = {
  integrator: KeyPairSigner;
  shareAccount: Address;
  payer: KeyPairSigner;
  beneficiary: Address;
};

async function round(env: BeaconEnv, id: bigint): Promise<Held<Round>> {
  const [address] = await findRoundPda(id);
  return { address, data: env.read(address, getRoundDecoder()) };
}

async function ticket(env: BeaconEnv, address: Address): Promise<Held<RoundTicket>> {
  return { address, data: env.read(address, getRoundTicketDecoder()) };
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

/** `n` integrators with share accounts, `m` payers, and a beneficiary per ticket. */
async function cast(env: BeaconEnv, integrators: number, payers: number) {
  const ints = await Promise.all([...Array(integrators)].map(() => env.svm.fundedWallet(10)));
  const shares = await Promise.all(ints.map((k) => env.usdcAccount(k.address, 0n)));
  const pays = await Promise.all([...Array(payers)].map(() => env.svm.fundedWallet(100)));
  const funder = await env.svm.fundedWallet(1);
  const funderUsdc = await env.usdcAccount(funder.address, 1_000_000n * USDC);
  return { ints, shares, pays, funder, funderUsdc };
}

type Cast = Awaited<ReturnType<typeof cast>>;

/** The `i`-th player of a cast: integrators and payers taken round-robin. */
async function player(env: BeaconEnv, c: Cast, i: number): Promise<Player> {
  const k = i % c.ints.length;
  return {
    integrator: c.ints[k]!,
    shareAccount: c.shares[k]!,
    payer: c.pays[i % c.pays.length]!,
    beneficiary: await env.usdcAccount(c.ints[k]!.address, 0n),
  };
}

/**
 * A join built as a client builds it: the vault and the accepting round
 * read, the pair resolved, the integrator's next nonce, and, for a lone
 * ticket, the sponsorship that pays its round at once (or an explicit one).
 */
async function buildJoin(
  env: BeaconEnv,
  c: Cast,
  p: Player,
  table: Address,
  price: bigint,
  options: { lone?: boolean; sponsorship?: bigint } = {},
) {
  const vault = await env.vault();
  let accepting: Round | null = null;
  if (vault.acceptingRound !== 0n) {
    const [a] = await findRoundPda(vault.acceptingRound);
    if (env.exists(a)) accepting = env.read(a, getRoundDecoder());
  }
  const target = await resolveJoinRound(vault, accepting, env.slot());
  const [integrator] = await findIntegratorPda({ integratorAuthority: p.integrator.address });
  const created = !env.exists(integrator);
  const nonce = created ? 0n : env.read(integrator, getIntegratorDecoder()).nextNonce;
  let sponsorship = options.sponsorship ?? 0n;
  if (options.lone) {
    const [config] = await findConfigPda();
    const params = env.read(config, getConfigDecoder()).params;
    const pendingRent = env.svm.client.minimumBalanceForRentExemption(749n);
    const landing = target.creates ? null : accepting;
    sponsorship = lonePaySponsorship(
      target,
      landing,
      price,
      newRoundTerms(params, ORAO_FEE, pendingRent),
    );
  }
  const ix = await getBeaconJoinInstructionAsync(
    {
      integratorAuthority: p.integrator,
      payer: p.payer,
      funder: c.funder,
      funderUsdc: c.funderUsdc,
      ...(created ? { shareAccount: p.shareAccount } : {}),
      beneficiary: p.beneficiary,
      payoutTable: table,
      usdcMint: USDC_MINT,
      price,
      appShareBps: 100,
      nonce,
      sponsorship,
    },
    target,
  );
  const [address] = await findRoundTicketPda({ integrator, nonce });
  return { ix, ticket: address, target, sponsorship };
}

/** A join built by `buildJoin`, then sent. */
async function join(
  env: BeaconEnv,
  c: Cast,
  p: Player,
  table: Address,
  price: bigint,
  options: { lone?: boolean; sponsorship?: bigint; format?: TransactionFormat } = {},
) {
  const { ix, ...built } = await buildJoin(env, c, p, table, price, options);
  const sent = await env.send(env.keeper, [ix], { format: options.format ?? 1 });
  return { ...built, sent };
}

/** Moves to `close_slot + 2`, requests the round's draw and has ORAO fulfil it. */
async function drawRound(env: BeaconEnv, id: bigint, randomness: Uint8Array) {
  const r = await round(env, id);
  env.setSlot(r.data.closeSlot + 2n);
  // The treasury as a keeper reads it, from ORAO's network state: the
  // program matches it against its own parse of the same account.
  const [networkState] = await findOraoNetworkStatePda();
  const state = oraoNetworkState(env.data(networkState));
  expect(state).toEqual({ treasury: env.oraoTreasury, fee: ORAO_FEE });
  const { instruction, request } = await getBeaconRequestDrawInstructionAsync(
    env.keeper,
    r,
    env.slot(),
    env.data(SLOT_HASHES_SYSVAR),
    state.treasury,
    await requestRead(env, r),
  );
  await env.send(env.keeper, [instruction]);
  expect((await round(env, id)).data.status).toBe(RoundStatus.Requested);
  expect((await round(env, id)).data.randomness).toBe(request);
  const [roundVrf] = await findRoundVrfPda({ round: r.address });
  await env.fulfill(request, roundVrf, randomness);
  return request;
}

/** The account `roundRequestAddress` names for `r` now, as read; null if none. */
async function requestRead(env: BeaconEnv, r: Held<Round>) {
  const named = await roundRequestAddress(r, env.data(SLOT_HASHES_SYSVAR));
  return named ? env.account(named.request) : null;
}

/** The events of `discriminator` a sent transaction emitted through `emit_cpi!`. */
const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
function emitted(sent: Sent, discriminator: ArrayLike<number>): Uint8Array[] {
  return sent.meta
    .innerInstructions()
    .flat()
    .map((i) => i.instruction().data())
    .filter(
      (d) =>
        EVENT_IX_TAG.every((b, k) => d[k] === b) &&
        Array.from(discriminator).every((b, k) => d[8 + k] === b),
    )
    .map((d) => d.slice(8));
}

/** The `RoundExpired` event a sent transaction emitted. */
function roundExpired(sent: Sent) {
  const [found] = emitted(sent, ROUND_EXPIRED_EVENT_DISCRIMINATOR);
  expect(found, "RoundExpired emitted").toBeDefined();
  return getRoundExpiredEventDecoder().decode(found!);
}

/** The `RoundTicketReturned` event a sent transaction emitted. */
function ticketReturned(sent: Sent) {
  const [found] = emitted(sent, ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR);
  expect(found, "RoundTicketReturned emitted").toBeDefined();
  return getRoundTicketReturnedEventDecoder().decode(found!);
}

/** The `RoundVrfSwept` events a sent transaction emitted. */
function vrfSwept(sent: Sent) {
  return emitted(sent, ROUND_VRF_SWEPT_EVENT_DISCRIMINATOR).map((d) =>
    getRoundVrfSweptEventDecoder().decode(d),
  );
}

/** Two joins in a fresh round, sponsored to its draw: a paid round, never requested. */
async function sponsoredRound(env: BeaconEnv) {
  const coin = await register(env, COIN_FLIP);
  const c = await cast(env, 2, 2);
  const a = await join(env, c, await player(env, c, 0), coin, 1n * USDC);
  const b = await join(env, c, await player(env, c, 1), coin, 2n * USDC);
  const sponsor = await env.svm.fundedWallet(10);
  let r = await round(env, a.target.landsIn);
  const complete = await getCompleteDrawInstructionAsync(sponsor, r);
  await env.send(sponsor, [complete!.instruction]);
  r = await round(env, a.target.landsIn);
  expect(r.data.status).toBe(RoundStatus.Paid);
  return { coin, c, tickets: [a.ticket, b.ticket], sponsor, id: a.target.landsIn };
}

const fill = (b: number) => new Uint8Array(64).fill(b);

async function tablesOf(env: BeaconEnv, addresses: Address[]): Promise<Map<Address, PayoutTable>> {
  return new Map(addresses.map((a) => [a, env.read(a, getPayoutTableDecoder())]));
}

describe("beacon client (litesvm npm, mainnet features)", () => {
  it("a lone sponsored ticket, joins, the draw, v1 and v0 batches, a parked payout, the reclaim and the shares", async () => {
    const env = await BeaconEnv.create();
    const coin = await register(env, COIN_FLIP);
    const three = await register(env, THREE_WAY);
    // Registering again succeeds without writing (a client may prepend it).
    await register(env, COIN_FLIP);
    const c = await cast(env, 3, 4);

    // A lone ticket creates round 1 and pays it with its own sponsorship.
    const first = await join(env, c, await player(env, c, 0), coin, 1n * USDC, { lone: true });
    expect(first.target.creates).toBe(true);
    expect(first.target.landsIn).toBe(1n);
    let r1 = await round(env, 1n);
    expect(r1.data.status).toBe(RoundStatus.Paid);
    expect(r1.data.sponsorship).toBe(first.sponsorship);
    expect(isPaid(roundTerms(r1.data), r1.data.prices, r1.data.sponsorship - 1n)).toBe(false);
    expect(r1.data.sponsors).toBe(1);

    // More joins land in the paid round before its close, v1 and v0 alike.
    const tickets = [first.ticket];
    const players = [await player(env, c, 0)];
    for (let i = 1; i < 24; i++) {
      const p = await player(env, c, i);
      const j = await join(env, c, p, i % 3 === 0 ? three : coin, (1n + BigInt(i % 4)) * USDC, {
        format: i % 2 === 0 ? 1 : 0,
      });
      expect(j.target.landsIn).toBe(1n);
      expect(j.target.creates).toBe(false);
      tickets.push(j.ticket);
      players.push(p);
    }
    r1 = await round(env, 1n);
    expect(r1.data.tickets).toBe(24);

    // A randomness with winners and losers, the first winner's beneficiary
    // frozen so that its payout is parked.
    const tables = await tablesOf(env, [coin, three]);
    let randomness = fill(1);
    let items: SettlementItem[] = [];
    for (let b = 1; b < 255; b++) {
      randomness = fill(b);
      const held = await Promise.all(tickets.map((t) => ticket(env, t)));
      items = await predictSettlement(r1, randomness, held, tables);
      const winners = items.filter((i) => i.payout > 0n).length;
      if (winners >= 4 && winners <= 20) break;
    }
    expect(items.length).toBe(24);
    const parked = items.find((i) => i.payout > 0n)!;
    env.setTokenState(parked.ticket.data.beneficiary, 2);

    const request = await drawRound(env, 1n, randomness);
    r1 = await round(env, 1n);
    expect(roundRandomness(r1.data, env.data(request))).toEqual(randomness);
    const before = new Map(
      items.map((i) => [i.ticket.address, env.balance(i.ticket.data.beneficiary)]),
    );

    // The first half in v1 batches, the rest in v0 batches without a lookup table.
    const half = items.slice(0, 12);
    const rest = items.slice(12);
    const v1 = await planSettlement(env.keeper, r1, half, USDC_MINT, {
      format: 1,
      lifetime: env.lifetime(),
    });
    expect(v1.length).toBe(1);
    for (const b of v1) {
      const sent = await env.sendMessage(b.message);
      expect(sent.units).toBeLessThanOrEqual(BigInt(b.units));
    }
    expect((await round(env, 1n)).data.status).toBe(RoundStatus.Drawn);
    r1 = await round(env, 1n);
    // Drawn: the randomness is read from the round from now on.
    expect(roundRandomness(r1.data)).toEqual(randomness);
    const v0 = await planSettlement(env.keeper, r1, rest, USDC_MINT, {
      format: 0,
      lifetime: env.lifetime(),
    });
    expect(v0.length).toBeGreaterThan(1);
    for (const b of v0) {
      expect(b.bytes).toBeLessThanOrEqual(1_232);
      const sent = await env.sendMessage(b.message);
      expect(sent.units).toBeLessThanOrEqual(BigInt(b.units));
    }

    // Every ticket settled: payouts delivered, one parked.
    for (const it of items) {
      if (it === parked) {
        const t = await ticket(env, it.ticket.address);
        expect(t.data.status).toBe(RoundTicketStatus.PayoutParked);
        expect(t.data.payout).toBe(it.payout);
        continue;
      }
      expect(env.exists(it.ticket.address)).toBe(false);
      expect(env.balance(it.ticket.data.beneficiary) - before.get(it.ticket.address)!).toBe(
        it.payout,
      );
    }
    r1 = await round(env, 1n);
    expect(r1.data.tickets).toBe(0);
    expect(r1.data.sponsors).toBe(1);

    // A batch naming an already settled ticket skips it.
    const again = settleInstruction(await settleBase(env.keeper, r1, USDC_MINT), [items[1]!]);
    await env.send(env.keeper, [again]);

    // The parked payout, once its beneficiary can receive.
    env.setTokenState(parked.ticket.data.beneficiary, 1);
    const parkedTicket = await ticket(env, parked.ticket.address);
    await env.send(env.keeper, [
      await getBeaconClaimPayoutInstructionAsync(env.keeper, parkedTicket, USDC_MINT),
    ]);
    expect(env.exists(parked.ticket.address)).toBe(false);
    expect(env.balance(parked.ticket.data.beneficiary) - before.get(parked.ticket.address)!).toBe(
      parked.payout,
    );

    // The lone ticket's sponsorship comes back; the round closes with it.
    const [record] = await findSponsorshipPda({
      round: r1.address,
      sponsor: players[0]!.payer.address,
    });
    const sponsorship = { address: record, data: env.read(record, getSponsorshipDecoder()) };
    await env.send(env.keeper, [
      await getBeaconReclaimInstructionAsync(env.keeper, r1, sponsorship),
    ]);
    expect(env.exists(record)).toBe(false);
    expect(env.exists(r1.address)).toBe(false);

    // Shares: the protocol's and each integrator's.
    const [config] = await findConfigPda();
    const treasury = env.read(config, getConfigDecoder()).protocolTreasury;
    const vaultBefore = await env.vault();
    expect(vaultBefore.protocolSharesAccrued).toBeGreaterThan(0n);
    await env.send(env.keeper, [
      await getClaimSharesInstructionAsync({
        caller: env.keeper,
        destination: treasury,
        usdcMint: USDC_MINT,
        eventAuthority: env.eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
      }),
    ]);
    expect(env.balance(treasury)).toBe(vaultBefore.protocolSharesAccrued);
    for (const [k, auth] of c.ints.entries()) {
      const [integrator] = await findIntegratorPda({ integratorAuthority: auth.address });
      const owed = env.read(integrator, getIntegratorDecoder()).appSharesAccrued;
      expect(owed).toBeGreaterThan(0n);
      await env.send(env.keeper, [
        await getClaimSharesInstructionAsync({
          caller: env.keeper,
          integrator,
          destination: c.shares[k]!,
          usdcMint: USDC_MINT,
          eventAuthority: env.eventAuthority,
          program: FADE_PROGRAM_ADDRESS,
        }),
      ]);
      expect(env.balance(c.shares[k]!)).toBe(owed);
    }
    const v = await env.vault();
    expect([v.beaconSharesHeld, v.protocolSharesAccrued, v.appSharesOwed]).toEqual([0n, 0n, 0n]);
  });

  it("a lone ticket landing in an accepting round pays exactly what is missing", async () => {
    const env = await BeaconEnv.create();
    const coin = await register(env, COIN_FLIP);
    const c = await cast(env, 3, 3);
    const price = 1n * USDC;

    // Two plain joins leave round 1 accepting, the second with a partial
    // sponsorship, so the lone ticket's amount depends on both R and S.
    await join(env, c, await player(env, c, 0), coin, price);
    let r1 = await round(env, 1n);
    const partial = sponsorshipToPay(roundTerms(r1.data), r1.data.prices + price, 0n) / 2n;
    expect(partial).toBeGreaterThan(0n);
    await join(env, c, await player(env, c, 1), coin, price, { sponsorship: partial });
    r1 = await round(env, 1n);
    expect(r1.data.status).toBe(RoundStatus.Accepting);
    expect(r1.data.sponsorship).toBe(partial);

    const p = await player(env, c, 2);
    const lone = await join(env, c, p, coin, price, { lone: true });
    expect(lone.target.landsIn).toBe(1n);
    expect(lone.target.creates).toBe(false);
    r1 = await round(env, 1n);
    expect(r1.data.status).toBe(RoundStatus.Paid);
    expect(r1.data.sponsorship).toBe(partial + lone.sponsorship);
    // Not a lamport more than the round needed.
    expect(isPaid(roundTerms(r1.data), r1.data.prices, r1.data.sponsorship - 1n)).toBe(false);
    const [record] = await findSponsorshipPda({ round: r1.address, sponsor: p.payer.address });
    const held = env.read(record, getSponsorshipDecoder());
    expect([held.round, held.sponsor, held.amount]).toEqual([
      1n,
      p.payer.address,
      lone.sponsorship,
    ]);
  });

  it("a lone ticket after a paid round's close opens the next round, its record on that round", async () => {
    const env = await BeaconEnv.create();
    const coin = await register(env, COIN_FLIP);
    const c = await cast(env, 2, 2);
    await join(env, c, await player(env, c, 0), coin, 1n * USDC, { lone: true });
    const r1 = await round(env, 1n);
    expect(r1.data.status).toBe(RoundStatus.Paid);
    env.setSlot(r1.data.closeSlot);

    const p = await player(env, c, 1);
    const lone = await join(env, c, p, coin, 1n * USDC, { lone: true });
    expect(lone.target.creates).toBe(true);
    expect(lone.target.landsIn).toBe(2n);
    // The pair is (round 1, round 2): the record is on the round it lands in.
    expect(lone.target.round).toBe(r1.address);
    const r2 = await round(env, 2n);
    expect(lone.target.nextRound).toBe(r2.address);
    expect(r2.data.status).toBe(RoundStatus.Paid);
    expect(r2.data.sponsorship).toBe(lone.sponsorship);
    expect(isPaid(roundTerms(r2.data), r2.data.prices, r2.data.sponsorship - 1n)).toBe(false);
    const [record] = await findSponsorshipPda({ round: r2.address, sponsor: p.payer.address });
    expect(env.read(record, getSponsorshipDecoder()).round).toBe(2n);
    const [onFirst] = await findSponsorshipPda({ round: r1.address, sponsor: p.payer.address });
    expect(env.exists(onFirst)).toBe(false);
  });

  it("a sponsored join built before its round closed fails on its record and moves nothing; rebuilt, it lands", async () => {
    const env = await BeaconEnv.create();
    const coin = await register(env, COIN_FLIP);
    const c = await cast(env, 3, 3);
    await join(env, c, await player(env, c, 2), coin, 1n * USDC);
    expect((await round(env, 1n)).data.status).toBe(RoundStatus.Accepting);

    // Built against accepting round 1...
    const p = await player(env, c, 0);
    const stale = await buildJoin(env, c, p, coin, 1n * USDC, { lone: true });
    expect(stale.target.landsIn).toBe(1n);
    expect(stale.sponsorship).toBeGreaterThan(0n);
    // ...then another join pays round 1 and its close slot passes.
    await join(env, c, await player(env, c, 1), coin, 1n * USDC, { lone: true });
    const r1 = await round(env, 1n);
    expect(r1.data.status).toBe(RoundStatus.Paid);
    env.setSlot(r1.data.closeSlot);

    const [vault] = await findVaultPda();
    const [vaultUsdc] = await findVaultUsdcPda();
    const [integrator] = await findIntegratorPda({ integratorAuthority: p.integrator.address });
    const [r2] = await findRoundPda(2n);
    const [record1] = await findSponsorshipPda({ round: r1.address, sponsor: p.payer.address });
    const [record2] = await findSponsorshipPda({ round: r2, sponsor: p.payer.address });
    const watched = [
      p.payer.address,
      vault,
      vaultUsdc,
      integrator,
      stale.ticket,
      r1.address,
      r2,
      record1,
      record2,
      c.funderUsdc,
      c.funder.address,
    ];
    const snapshot = () =>
      watched.map((a) => ({ account: env.account(a), lamports: env.lamports(a) }));
    const before = snapshot();
    await expect(env.send(env.keeper, [stale.ix])).rejects.toThrow(/ConstraintSeeds|0x7d6/);
    expect(snapshot()).toEqual(before);
    expect(env.exists(r2)).toBe(false);

    const rebuilt = await join(env, c, p, coin, 1n * USDC, { lone: true });
    expect(rebuilt.target.creates).toBe(true);
    expect(rebuilt.target.landsIn).toBe(2n);
    expect((await round(env, 2n)).data.status).toBe(RoundStatus.Paid);
    expect(env.exists(rebuilt.ticket)).toBe(true);
  });

  it("an unpaid round refunded, its ticket returned", async () => {
    const env = await BeaconEnv.create();
    const coin = await register(env, COIN_FLIP);
    const c = await cast(env, 1, 1);
    const p = await player(env, c, 0);
    const usdcBefore = env.balance(c.funderUsdc);
    const j = await join(env, c, p, coin, 1n * USDC);
    let r = await round(env, j.target.landsIn);
    expect(r.data.status).toBe(RoundStatus.Accepting);
    expect(sponsorshipToCompleteDraw(r.data)).toBeGreaterThan(0n);

    // The window counts from the round's latest join, here its only one.
    expect(refundFrom(r.data)).toBe(r.data.firstSlot);
    const opens = refundFrom(r.data) + r.data.refundSlots;
    expect(refundOpen(opens - 1n, refundFrom(r.data), r.data.refundSlots)).toBe(false);
    env.setSlot(opens);
    // Only a participant refunds: a stranger is refused, by the builder and
    // by the program (NotRoundParticipant), and the ticket's payer is not.
    const joined = await ticket(env, j.ticket);
    await expect(
      getBeaconRefundInstructionAsync(env.keeper, r, env.slot(), { ticket: joined }),
    ).rejects.toThrow(/neither/);
    await expect(
      env.send(env.keeper, [
        await getRefundRoundInstructionAsync({
          caller: env.keeper,
          round: r.address,
          participant: j.ticket,
          eventAuthority: env.eventAuthority,
          program: FADE_PROGRAM_ADDRESS,
        }),
      ]),
    ).rejects.toThrow(/0x17b3|NotRoundParticipant/);
    await env.send(env.keeper, [
      await getBeaconRefundInstructionAsync(p.payer, r, env.slot(), { ticket: joined }),
    ]);
    r = await round(env, j.target.landsIn);
    expect(r.data.status).toBe(RoundStatus.Refunded);
    expect((await env.vault()).acceptingRound).toBe(0n);

    await env.send(env.keeper, [
      await getBeaconReturnInstructionAsync(env.keeper, r, await ticket(env, j.ticket), USDC_MINT),
    ]);
    expect(env.exists(j.ticket)).toBe(false);
    expect(env.exists(r.address)).toBe(false);
    expect(env.balance(c.funderUsdc)).toBe(usdcBefore);

    // With no accepting round, the next join creates the next id.
    const next = await join(env, c, p, coin, 1n * USDC);
    expect(next.target.creates).toBe(true);
    expect(next.target.landsIn).toBe(j.target.landsIn + 1n);
  });

  it("a round sponsored to its draw, never requested, forfeited and returned", async () => {
    const env = await BeaconEnv.create();
    const coin = await register(env, COIN_FLIP);
    const c = await cast(env, 2, 2);
    const a = await join(env, c, await player(env, c, 0), coin, 1n * USDC);
    const b = await join(env, c, await player(env, c, 1), coin, 2n * USDC);
    let r = await round(env, a.target.landsIn);
    expect(r.data.status).toBe(RoundStatus.Accepting);

    // An automatic sponsor capped below what is missing sends nothing.
    const sponsor = await env.svm.fundedWallet(10);
    const missing = sponsorshipToCompleteDraw(r.data);
    expect(
      await getCompleteDrawInstructionAsync(sponsor, r, { maxLamports: missing - 1n }),
    ).toBeNull();
    const complete = await getCompleteDrawInstructionAsync(sponsor, r);
    expect(complete!.lamports).toBe(missing);
    await env.send(sponsor, [complete!.instruction]);
    r = await round(env, a.target.landsIn);
    expect(r.data.status).toBe(RoundStatus.Paid);
    expect(r.data.sponsorship).toBe(missing);
    expect(isPaid(roundTerms(r.data), r.data.prices, r.data.sponsorship)).toBe(true);
    expect(await getCompleteDrawInstructionAsync(sponsor, r)).toBeNull();

    // Nobody requests the draw; past T_SETTLE it is forfeited.
    env.setSlot(r.data.closeSlot + r.data.tSettleSlots + 1n);
    // No request exists at the round's address: none is bound late either.
    expect(await requestRead(env, r)).toBeNull();
    await expect(
      getBeaconRequestDrawInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        new Uint8Array(8),
        env.oraoTreasury,
        null,
      ),
    ).rejects.toThrow(/request window/);
    await env.send(env.keeper, [
      await getBeaconExpireInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        await requestRead(env, r),
      ),
    ]);
    r = await round(env, a.target.landsIn);
    expect(r.data.status).toBe(RoundStatus.Forfeited);

    for (const t of [a.ticket, b.ticket]) {
      await env.send(env.keeper, [
        await getBeaconReturnInstructionAsync(env.keeper, r, await ticket(env, t), USDC_MINT),
      ]);
      expect(env.exists(t)).toBe(false);
      r = await round(env, a.target.landsIn);
    }
    const [record] = await findSponsorshipPda({ round: r.address, sponsor: sponsor.address });
    const before = env.lamports(sponsor.address);
    await env.send(env.keeper, [
      await getBeaconReclaimInstructionAsync(env.keeper, r, {
        address: record,
        data: env.read(record, getSponsorshipDecoder()),
      }),
    ]);
    // Never requested: the whole sponsorship back, with the record's rent.
    expect(env.lamports(sponsor.address) - before).toBeGreaterThanOrEqual(missing);
    expect(env.exists(r.address)).toBe(false);
  });

  for (const legacy of [false, true])
    it(`a request someone created${legacy ? " through ORAO's deprecated request (legacy layout)" : ""} and ORAO fulfilled is bound late, not forfeited, and settled`, async () => {
      const env = await BeaconEnv.create();
      const { coin, tickets, id } = await sponsoredRound(env);
      let r = await round(env, id);

      // The seed is public from the slot after the close: a stranger creates
      // the round's ORAO request and has it fulfilled; nobody binds it.
      env.setSlot(r.data.closeSlot + 2n);
      const named = await roundRequestAddress(r, env.data(SLOT_HASHES_SYSVAR));
      const stranger = await env.svm.fundedWallet(10);
      await env.preCreate(stranger, named!.request, named!.seed!, legacy);
      // The mock wrote the layout asked for: the legacy one is 780 bytes and
      // keeps its size once fulfilled.
      expect(env.data(named!.request).length).toBe(legacy ? 780 : 749);
      const randomness = fill(7);
      await env.fulfill(named!.request, stranger.address, randomness);
      expect(env.data(named!.request).length).toBe(legacy ? 780 : 137);

      // The keeper missed the window.
      env.setSlot(r.data.closeSlot + r.data.tSettleSlots + 5n);
      const read = await requestRead(env, r);
      expect(read?.owner).toBe(ORAO_VRF_PROGRAM_ADDRESS);
      await expect(
        getBeaconExpireInstructionAsync(
          env.keeper,
          r,
          env.slot(),
          env.data(SLOT_HASHES_SYSVAR),
          read,
        ),
      ).rejects.toThrow(RoundDrawFulfilledError);
      // The program agrees: an expiry built as if no request existed is refused.
      const blind = await getBeaconExpireInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        null,
      );
      await expect(env.send(env.keeper, [blind])).rejects.toThrow(/AlreadyFulfilled/);
      // A stale read of another account is refused by the builders.
      await expect(
        getBeaconRequestDrawInstructionAsync(
          env.keeper,
          r,
          env.slot(),
          env.data(SLOT_HASHES_SYSVAR),
          env.oraoTreasury,
          { ...read!, address: stranger.address },
        ),
      ).rejects.toThrow(/account read/);

      // Bound late: nothing funded, the request share to the caller.
      const held = env.lamports(r.address);
      const late = await getBeaconRequestDrawInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        env.oraoTreasury,
        read,
      );
      expect(late.late).toBe(true);
      expect(late.request).toBe(named!.request);
      await env.send(env.keeper, [late.instruction]);
      r = await round(env, id);
      expect(r.data.status).toBe(RoundStatus.Requested);
      expect(r.data.randomness).toBe(named!.request);
      expect(r.data.funded).toBe(0n);
      expect(held - env.lamports(r.address)).toBe(r.data.requestShare);

      // Settled from the fulfilled request.
      expect(roundRandomness(r.data, env.data(named!.request))).toEqual(randomness);
      const items = await predictSettlement(
        r,
        randomness,
        await Promise.all(tickets.map((t) => ticket(env, t))),
        await tablesOf(env, [coin]),
      );
      expect(items).toHaveLength(2);
      const plan = await planSettlement(env.keeper, r, items, USDC_MINT, {
        format: 1,
        lifetime: env.lifetime(),
      });
      for (const b of plan) await env.sendMessage(b.message);
      r = await round(env, id);
      expect(r.data.status).toBe(RoundStatus.Drawn);
      expect(r.data.tickets).toBe(0);
      for (const t of tickets) expect(env.exists(t)).toBe(false);
    });

  for (const zero of [false, true])
    it(`a request someone created, ${zero ? "fulfilled with zero" : "still pending"} after the window, is not bound late: the round expires at no draw cost`, async () => {
      const env = await BeaconEnv.create();
      const { tickets, id } = await sponsoredRound(env);
      let r = await round(env, id);
      env.setSlot(r.data.closeSlot + 2n);
      const named = await roundRequestAddress(r, env.data(SLOT_HASHES_SYSVAR));
      const stranger = await env.svm.fundedWallet(10);
      await env.preCreate(stranger, named!.request, named!.seed!);
      if (zero) await env.fulfill(named!.request, stranger.address, fill(0));

      // The keepers missed the window; the request exists, ORAO's.
      env.setSlot(r.data.closeSlot + r.data.tSettleSlots + 1n);
      const read = await requestRead(env, r);
      expect(read?.owner).toBe(ORAO_VRF_PROGRAM_ADDRESS);
      await expect(
        getBeaconRequestDrawInstructionAsync(
          env.keeper,
          r,
          env.slot(),
          env.data(SLOT_HASHES_SYSVAR),
          env.oraoTreasury,
          read,
        ),
      ).rejects.toThrow(/not fulfilled with a randomness/);
      // The program refuses it too, moving nothing.
      const raw = await getRequestRoundDrawInstructionAsync({
        caller: env.keeper,
        round: r.address,
        oraoTreasury: env.oraoTreasury,
        request: named!.request,
        eventAuthority: env.eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
      });
      const held = env.lamports(r.address);
      await expect(env.send(env.keeper, [raw])).rejects.toThrow(/RoundRequestWindow/);
      expect(env.lamports(r.address)).toBe(held);
      expect((await round(env, id)).data.status).toBe(RoundStatus.Paid);

      // Expired unbound: the request is reported, nothing was spent, and
      // every ticket's prepay comes back whole.
      const sent = await env.send(env.keeper, [
        await getBeaconExpireInstructionAsync(
          env.keeper,
          r,
          env.slot(),
          env.data(SLOT_HASHES_SYSVAR),
          read,
        ),
      ]);
      const e = roundExpired(sent);
      expect([e.requested, e.requestFound, e.checked]).toEqual([false, true, true]);
      expect([e.drawCost, e.refund]).toEqual([0n, 0n]);
      r = await round(env, id);
      expect(r.data.status).toBe(RoundStatus.Forfeited);
      for (const t of tickets) {
        const returned = await env.send(env.keeper, [
          await getBeaconReturnInstructionAsync(env.keeper, r, await ticket(env, t), USDC_MINT),
        ]);
        expect(ticketReturned(returned).charge).toBe(0n);
        r = await round(env, id);
      }
    });

  it("an unrecorded round SlotHashes no longer proves is refunded at its expiry, not bound", async () => {
    const env = await BeaconEnv.create();
    const { id } = await sponsoredRound(env);
    let r = await round(env, id);
    env.setSlot(r.data.closeSlot + 2n);
    const named = await roundRequestAddress(r, env.data(SLOT_HASHES_SYSVAR));
    const stranger = await env.svm.fundedWallet(10);
    await env.preCreate(stranger, named!.request, named!.seed!);
    await env.fulfill(named!.request, stranger.address, fill(9));
    const read = env.account(named!.request);

    env.setSlot(r.data.closeSlot + 600n);
    expect(entropyRecorded(r.data)).toBe(false);
    expect(await roundRequestAddress(r, env.data(SLOT_HASHES_SYSVAR))).toBeNull();
    expect(
      await getBeaconRecordEntropyInstructionAsync(r, env.data(SLOT_HASHES_SYSVAR)),
    ).toBeNull();
    await expect(
      getBeaconRequestDrawInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        env.oraoTreasury,
        read,
      ),
    ).rejects.toThrow(/never recorded.*can no longer be bound/);
    // The program reads no request any more: the expiry names none and refunds the round.
    const sent = await env.send(env.keeper, [
      await getBeaconExpireInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        null,
      ),
    ]);
    const e = roundExpired(sent);
    expect([e.requested, e.requestFound, e.checked, e.refunded]).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect([e.forfeited, e.drawCost]).toEqual([0n, 0n]);
    r = await round(env, id);
    expect(r.data.status).toBe(RoundStatus.Refunded);
  });

  it("a round recorded at close + 2 is bound late and never forfeited, whatever SlotHashes holds", async () => {
    const env = await BeaconEnv.create();
    const { id } = await sponsoredRound(env);
    let r = await round(env, id);
    env.setSlot(r.data.closeSlot + 1n);
    // Not proven yet: nothing to record.
    expect(
      await getBeaconRecordEntropyInstructionAsync(r, env.data(SLOT_HASHES_SYSVAR)),
    ).toBeNull();
    env.setSlot(r.data.closeSlot + 2n);
    const named = await roundRequestAddress(r, env.data(SLOT_HASHES_SYSVAR));
    const record = await getBeaconRecordEntropyInstructionAsync(r, env.data(SLOT_HASHES_SYSVAR));
    expect(record).not.toBeNull();
    await env.send(env.keeper, [record!]);
    r = await round(env, id);
    expect(entropyRecorded(r.data)).toBe(true);
    expect(r.data.entropySlot).toBe(r.data.closeSlot + 1n);
    expect(Array.from(r.data.seed)).toEqual(Array.from(named!.seed!));
    expect(r.data.status).toBe(RoundStatus.Paid);
    // Recorded: nothing more to record.
    expect(
      await getBeaconRecordEntropyInstructionAsync(r, env.data(SLOT_HASHES_SYSVAR)),
    ).toBeNull();

    // Created and fulfilled through ORAO just before SlotHashes forgets `s*`.
    env.setSlot(r.data.closeSlot + 500n);
    const stranger = await env.svm.fundedWallet(10);
    await env.preCreate(stranger, named!.request, named!.seed!);
    await env.fulfill(named!.request, stranger.address, fill(9));

    env.setSlot(r.data.closeSlot + 2_000n);
    const again = await roundRequestAddress(r, env.data(SLOT_HASHES_SYSVAR));
    expect(again?.request).toBe(named!.request);
    const read = env.account(named!.request);
    await expect(
      getBeaconExpireInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        read,
      ),
    ).rejects.toThrow(RoundDrawFulfilledError);
    const built = await getBeaconRequestDrawInstructionAsync(
      env.keeper,
      r,
      env.slot(),
      env.data(SLOT_HASHES_SYSVAR),
      env.oraoTreasury,
      read,
    );
    expect([built.late, built.request]).toEqual([true, named!.request]);
    await env.send(env.keeper, [built.instruction]);
    r = await round(env, id);
    expect([r.data.status, r.data.randomness]).toEqual([RoundStatus.Requested, named!.request]);
  });

  it("requests at the window's bounds, and a requested draw never fulfilled forfeited", async () => {
    const env = await BeaconEnv.create();
    const { id } = await sponsoredRound(env);
    let r = await round(env, id);
    const close = r.data.closeSlot;
    const tSettle = r.data.tSettleSlots;
    const eventAuthority = env.eventAuthority;

    // close + 1: before the window; the builder and the program refuse.
    env.setSlot(close + 1n);
    expect(inRequestWindow(env.slot(), close, tSettle)).toBe(false);
    await expect(
      getBeaconRequestDrawInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        env.oraoTreasury,
        null,
      ),
    ).rejects.toThrow(/request window/);
    // SlotHashes does not hold the slot after the close yet: no seed exists.
    expect(await roundRequestAddress(r, env.data(SLOT_HASHES_SYSVAR))).toBeNull();
    const raw = await getRequestRoundDrawInstructionAsync({
      caller: env.keeper,
      round: r.address,
      oraoTreasury: env.oraoTreasury,
      request: (await generateKeyPairSigner()).address,
      eventAuthority,
      program: FADE_PROGRAM_ADDRESS,
    });
    await expect(env.send(env.keeper, [raw])).rejects.toThrow(/RoundRequestWindow/);

    // close + t_settle: the window's last slot. Not expired yet.
    env.setSlot(close + tSettle);
    expect(inRequestWindow(env.slot(), close, tSettle)).toBe(true);
    expect(isExpired(env.slot(), close, tSettle)).toBe(false);
    await expect(
      getBeaconExpireInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        null,
      ),
    ).rejects.toThrow(/has not expired/);
    const named = await roundRequestAddress(r, env.data(SLOT_HASHES_SYSVAR));
    const early = await getExpireRoundInstructionAsync({
      caller: env.keeper,
      round: r.address,
      randomness: named!.request,
      eventAuthority,
      program: FADE_PROGRAM_ADDRESS,
    });
    await expect(env.send(env.keeper, [early])).rejects.toThrow(/NotExpired/);
    const req = await getBeaconRequestDrawInstructionAsync(
      env.keeper,
      r,
      env.slot(),
      env.data(SLOT_HASHES_SYSVAR),
      env.oraoTreasury,
      await requestRead(env, r),
    );
    expect(req.late).toBe(false);
    await env.send(env.keeper, [req.instruction]);
    r = await round(env, id);
    expect(r.data.status).toBe(RoundStatus.Requested);

    // close + t_settle + 1: never fulfilled, forfeited with the stored request.
    env.setSlot(close + tSettle + 1n);
    expect(isExpired(env.slot(), close, tSettle)).toBe(true);
    const sent = await env.send(env.keeper, [
      await getBeaconExpireInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        await requestRead(env, r),
      ),
    ]);
    const e = roundExpired(sent);
    expect([e.requested, e.requestFound, e.checked]).toEqual([true, true, true]);
    expect(e.refund).toBe(0n);
    expect(e.drawCost).toBe(r.data.funded + r.data.requestShare);
    expect((await round(env, id)).data.status).toBe(RoundStatus.Forfeited);
  });

  it("ORAO's refund for a round forfeited pending is swept into the round, then a closed round's to the caller", async () => {
    const env = await BeaconEnv.create();
    const { id, tickets, sponsor } = await sponsoredRound(env);
    let r = await round(env, id);
    const [roundVrf] = await findRoundVrfPda({ round: r.address });
    env.setSlot(r.data.closeSlot + 2n);
    const req = await getBeaconRequestDrawInstructionAsync(
      env.keeper,
      r,
      env.slot(),
      env.data(SLOT_HASHES_SYSVAR),
      env.oraoTreasury,
      await requestRead(env, r),
    );
    await env.send(env.keeper, [req.instruction]);
    r = await round(env, id);
    // Requested: what round_vrf holds is the draw's refund; the builder refuses, as the program.
    expect(roundVrfSweepable(r.data, 1n)).toBe(false);
    await expect(getBeaconSweepVrfInstructionAsync(env.keeper, id, r.data)).rejects.toThrow(
      /requested/,
    );
    const raw = await getBeaconSweepVrfInstructionAsync(env.keeper, id, null);
    await expect(env.send(env.keeper, [raw])).rejects.toThrow(/WrongRoundStatus/);

    env.setSlot(r.data.closeSlot + r.data.tSettleSlots + 1n);
    await env.send(env.keeper, [
      await getBeaconExpireInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        await requestRead(env, r),
      ),
    ]);
    r = await round(env, id);
    expect(r.data.status).toBe(RoundStatus.Forfeited);
    expect(env.lamports(roundVrf)).toBe(0n);
    // ORAO answers after the expiry: its refund lands on round_vrf.
    await env.fulfill(req.request, roundVrf, fill(4));
    const refund = env.lamports(roundVrf);
    expect(refund).toBeGreaterThan(0n);
    expect(roundVrfSweepable(r.data, refund)).toBe(true);

    // Packed ahead of a return, the sweep reaches the round.
    const sent = await env.send(env.keeper, [
      await getBeaconSweepVrfInstructionAsync(env.keeper, id, r.data),
      await getBeaconReturnInstructionAsync(
        env.keeper,
        r,
        await ticket(env, tickets[0]!),
        USDC_MINT,
      ),
    ]);
    const [e] = vrfSwept(sent);
    expect(e).toMatchObject({ round: r.address, roundId: id, to: r.address, lamports: refund });
    expect(e!.closed).toBe(false);
    expect(env.lamports(roundVrf)).toBe(0n);
    r = await round(env, id);
    await env.send(env.keeper, [
      await getBeaconReturnInstructionAsync(
        env.keeper,
        r,
        await ticket(env, tickets[1]!),
        USDC_MINT,
      ),
    ]);
    r = await round(env, id);
    const [record] = await findSponsorshipPda({ round: r.address, sponsor: sponsor.address });
    await env.send(env.keeper, [
      await getBeaconReclaimInstructionAsync(env.keeper, r, {
        address: record,
        data: env.read(record, getSponsorshipDecoder()),
      }),
    ]);
    expect(env.exists(r.address)).toBe(false);

    // Lamports reaching round_vrf once the round has closed go to whoever sweeps them.
    env.svm.client.airdrop(roundVrf, lamports(2_000_000n));
    const stranger = await env.svm.fundedWallet(1);
    const before = env.lamports(stranger.address);
    const closed = await env.send(env.keeper, [
      await getBeaconSweepVrfInstructionAsync(stranger, id, null),
    ]);
    const [c] = vrfSwept(closed);
    expect(c).toMatchObject({ to: stranger.address, lamports: 2_000_000n, closed: true });
    expect(env.lamports(stranger.address) - before).toBe(2_000_000n);
    // Nothing left: succeeds without moving anything or emitting.
    const empty = await env.send(env.keeper, [
      await getBeaconSweepVrfInstructionAsync(stranger, id, null),
    ]);
    expect(vrfSwept(empty)).toEqual([]);
    // An id the vault has not created is refused.
    const next = (await env.vault()).nextRoundId;
    await expect(
      env.send(env.keeper, [await getBeaconSweepVrfInstructionAsync(env.keeper, next, null)]),
    ).rejects.toThrow(/WrongRound/);
  });

  it("a requested draw fulfilled with zero is forfeited, ORAO's refund drained", async () => {
    const env = await BeaconEnv.create();
    const { id } = await sponsoredRound(env);
    const request = await drawRound(env, id, fill(0));
    let r = await round(env, id);
    env.setSlot(r.data.closeSlot + r.data.tSettleSlots + 1n);
    const sent = await env.send(env.keeper, [
      await getBeaconExpireInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        env.account(request),
      ),
    ]);
    const e = roundExpired(sent);
    expect([e.requested, e.requestFound, e.checked]).toEqual([true, true, true]);
    expect(e.refund).toBeGreaterThan(0n);
    expect(e.drawCost).toBe(r.data.funded + r.data.requestShare - e.refund);
    r = await round(env, id);
    expect(r.data.status).toBe(RoundStatus.Forfeited);
  });

  it("a requested draw fulfilled with randomness does not expire: it is settled", async () => {
    const env = await BeaconEnv.create();
    const { id } = await sponsoredRound(env);
    const request = await drawRound(env, id, fill(3));
    const r = await round(env, id);
    env.setSlot(r.data.closeSlot + r.data.tSettleSlots + 1n);
    await expect(
      getBeaconExpireInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        env.account(request),
      ),
    ).rejects.toThrow(RoundDrawFulfilledError);
  });

  it("an unrequested round expired while SlotHashes proves its entropy slot is checked", async () => {
    const env = await BeaconEnv.create();
    const { id } = await sponsoredRound(env);
    const r = await round(env, id);
    env.setSlot(r.data.closeSlot + r.data.tSettleSlots + 1n);
    const sent = await env.send(env.keeper, [
      await getBeaconExpireInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        await requestRead(env, r),
      ),
    ]);
    const e = roundExpired(sent);
    expect([e.requested, e.requestFound, e.checked]).toEqual([false, false, true]);
  });

  it("splits a batch of mostly winners to one beneficiary at the instruction trace", async () => {
    const env = await BeaconEnv.create();
    const three = await register(env, THREE_WAY);
    const c = await cast(env, 1, 1);
    // One integrator, one payer, one beneficiary for every ticket (a
    // custodial integrator): few locks, so the trace binds first.
    const shared: Player = { ...(await player(env, c, 0)) };
    const n = 32;
    const tickets: Address[] = [];
    for (let i = 0; i < n; i++) tickets.push((await join(env, c, shared, three, 1n * USDC)).ticket);
    let r = await round(env, 1n);
    expect(r.data.tickets).toBe(n);

    // A randomness making at least 30 of the 32 winners (THREE_WAY pays 90 %).
    const tables = await tablesOf(env, [three]);
    let randomness: Uint8Array | null = null;
    let items: SettlementItem[] = [];
    for (let b = 1; b < 255 && !randomness; b++) {
      const held = await Promise.all(tickets.map((t) => ticket(env, t)));
      items = await predictSettlement(r, fill(b), held, tables);
      if (items.filter((i) => i.payout > 0n).length >= 30) randomness = fill(b);
    }
    expect(randomness, "a randomness with at least 30 winners").not.toBeNull();
    await drawRound(env, 1n, randomness!);
    r = await round(env, 1n);
    const ordered = settlementOrder(items);
    const winners = ordered.filter((i) => i.payout > 0n);

    // All 32 in one v1 transaction: within the locks and the size, above the trace.
    const base = await settleBase(env.keeper, r, USDC_MINT);
    const message = (batch: SettlementItem[]) =>
      beaconTransactionMessage(1, env.keeper, env.lifetime(), [settleInstruction(base, batch)], {
        computeUnitLimit: settlementUnits(batch),
      });
    expect(settlementTrace(1, ordered)).toBeGreaterThan(MAX_INSTRUCTION_TRACE);
    const whole = measure(message(ordered));
    expect(whole.locks).toBeLessThanOrEqual(MAX_ACCOUNT_LOCKS);
    expect(whole.fits).toBe(true);
    console.log(
      `${n} tickets, ${winners.length} winners, one beneficiary: ${whole.bytes} bytes, ${whole.locks} locks, trace ${settlementTrace(1, ordered)}`,
    );
    await expect(env.sendMessage(message(ordered))).rejects.toThrow(
      /MaxInstructionTraceLengthExceeded/,
    );

    // The planner splits it, each batch within the trace and below the locks.
    const plan = await planSettlement(env.keeper, r, items, USDC_MINT, {
      format: 1,
      lifetime: env.lifetime(),
    });
    expect(plan.length).toBe(2);
    console.log(
      `  planned: ${plan.map((b) => `${b.items.length} tickets, ${b.locks} locks, trace ${b.trace}`).join("; ")}`,
    );
    expect(plan[0]!.trace).toBeGreaterThanOrEqual(MAX_INSTRUCTION_TRACE - 1);
    for (const b of plan) {
      expect(b.trace).toBeLessThanOrEqual(MAX_INSTRUCTION_TRACE);
      expect(b.locks).toBeLessThan(MAX_ACCOUNT_LOCKS);
      expect(b.trace).toBe(settlementTrace(1, b.items));
    }

    // A batch exactly at the bound runs: 30 winners, the round's first settlement.
    const exact = winners.slice(0, 30);
    expect(settlementTrace(1, exact)).toBe(MAX_INSTRUCTION_TRACE);
    await env.sendMessage(message(exact));
    const rest = ordered.filter((i) => !exact.includes(i));
    r = await round(env, 1n);
    for (const b of await planSettlement(env.keeper, r, rest, USDC_MINT, {
      format: 1,
      lifetime: env.lifetime(),
    }))
      await env.sendMessage(b.message);
    expect(env.exists(r.address)).toBe(false);
    for (const t of tickets) expect(env.exists(t)).toBe(false);
  });
});

// --- batch sizes per format ---------------------------------------------------------------

type Mix = { name: string; integrators: (n: number) => number; payers: (n: number) => number };
const MIXES: Mix[] = [
  { name: "one integrator, one payer", integrators: () => 1, payers: () => 1 },
  { name: "each ticket its own payer", integrators: () => 1, payers: (n) => n },
  { name: "each ticket its own payer and integrator", integrators: (n) => n, payers: (n) => n },
];

/**
 * `n` synthetic tickets of one round in `mix`, `round(0.3 n)` of them
 * winners spread through the batch, for sizing only.
 */
async function synthetic(n: number, mix: Mix): Promise<SettlementItem[]> {
  const ints = await Promise.all([...Array(mix.integrators(n))].map(() => generateKeyPairSigner()));
  const pays = await Promise.all([...Array(mix.payers(n))].map(() => generateKeyPairSigner()));
  const [table] = await findPayoutTablePda(COIN_FLIP);
  const winners = Math.round(0.3 * n);
  const out: SettlementItem[] = [];
  for (let i = 0; i < n; i++) {
    const t = await generateKeyPairSigner();
    const b = await generateKeyPairSigner();
    const win = Math.floor(((i + 1) * winners) / n) > Math.floor((i * winners) / n);
    out.push({
      ticket: {
        address: t.address,
        data: {
          integrator: ints[i % ints.length]!.address,
          payer: pays[i % pays.length]!.address,
          payoutTable: table,
          beneficiary: b.address,
        } as RoundTicket,
      },
      outcome: win ? 0 : 1,
      payout: win ? 1_900_000n : 0n,
    });
  }
  return out;
}

async function syntheticRound(): Promise<Held<Round>> {
  const [address] = await findRoundPda(1n);
  const randomness = (await generateKeyPairSigner()).address;
  const rentPayer = (await generateKeyPairSigner()).address;
  return { address, data: { id: 1n, randomness, rentPayer } as Round };
}

/**
 * The largest batch per mix and format, measured on 15 October 2026.
 */
const MEASURED: Record<string, { v1: number; v0: number }> = {
  "one integrator, one payer": { v1: 32, v0: 10 },
  "each ticket its own payer": { v1: 20, v0: 6 },
  "each ticket its own payer and integrator": { v1: 14, v0: 4 },
};

/** What a keeper pays on top: a fee per unit in v0, a lump sum in v1. */
const PRIORITY = {
  1: { priorityFeeLamports: 10_000n },
  0: { microLamportsPerUnit: 100_000n },
} as const;

/**
 * The largest batch of `format` in `mix` at 30 % winners: the largest `n`
 * whose `n` tickets the planner keeps in one transaction. The round's rent
 * payer is an account of its own, the worst case.
 */
async function largest(mix: Mix, format: TransactionFormat) {
  const caller = createNoopSigner((await generateKeyPairSigner()).address);
  const r = await syntheticRound();
  let best = null;
  for (let n = 1; n <= MAX_ROUND_BATCH; n++) {
    const batches = await planSettlement(caller, r, await synthetic(n, mix), USDC_MINT, {
      format,
      lifetime: {
        blockhash: "11111111111111111111111111111111" as never,
        lastValidBlockHeight: 0n,
      },
      priority: PRIORITY[format],
    });
    if (batches.length !== 1) break;
    best = batches[0]!;
  }
  return best!;
}

/**
 * 32 outcomes, distinct for each `i`: 31 that pay, then a loss, as
 * `distinct_table` in programs/fade/tests/beacon.rs. A `winner` table loses
 * with probability 1.11 %, any other wins with probability 3.1 %.
 */
function distinctTable(i: number, winner: boolean): OutcomeArgs[] {
  const [p, m] = winner ? [31_900_000n, 9_500n] : [1_000_000n, 20_000n];
  const t: OutcomeArgs[] = [...Array(31)].map(() => ({ p, m }));
  t[0] = { p, m: m + BigInt(i) };
  t.push({ p: 1_000_000_000n - 31n * p, m: 0n });
  return t;
}

describe("the compute request on distinct 32-outcome tables", () => {
  // Spec 08 §13.5.7 measures 22 losers each on its own 32-outcome table and
  // 15 such winners (20 here, where v1 has the locks for them): there, each table's load is a large share of a batch,
  // and a request without its load term asks for less than the program
  // consumes (ComputationalBudgetExceeded, the same batch rebuilt forever).
  for (const [n, winner] of [
    [22, false],
    [20, true],
  ] as const)
    it(`${n} ${winner ? "winners" : "losers"}, each on its own 32-outcome table: every batch runs within the units it requests`, async () => {
      const env = await BeaconEnv.create();
      const tables: Address[] = [];
      for (let i = 0; i < n; i++) tables.push(await register(env, distinctTable(i, winner)));
      const c = await cast(env, 1, 1);
      const p = await player(env, c, 0);
      const tickets: Address[] = [];
      for (const t of tables) tickets.push((await join(env, c, p, t, 1n * USDC)).ticket);
      let r = await round(env, 1n);
      expect(r.data.tickets).toBe(n);

      const held = await tablesOf(env, tables);
      let randomness: Uint8Array | null = null;
      let items: SettlementItem[] = [];
      for (let b = 1; b < 255 && !randomness; b++) {
        items = await predictSettlement(
          r,
          fill(b),
          await Promise.all(tickets.map((t) => ticket(env, t))),
          held,
        );
        if (items.every((i) => i.payout > 0n === winner)) randomness = fill(b);
      }
      expect(
        randomness,
        `a randomness making every ticket a ${winner ? "winner" : "loser"}`,
      ).not.toBeNull();
      await drawRound(env, 1n, randomness!);
      r = await round(env, 1n);
      const plan = await planSettlement(env.keeper, r, items, USDC_MINT, {
        format: 1,
        lifetime: env.lifetime(),
      });
      let loadTermNeeded = false;
      for (const b of plan) {
        const loads = new Set(b.items.map((i) => i.ticket.data.payoutTable)).size;
        expect(loads).toBe(b.items.length);
        expect(b.units).toBe(settlementUnits(b.items));
        const sent = await env.sendMessage(b.message);
        console.log(
          `${b.items.length} ${winner ? "winners" : "losers"} on as many 32-outcome tables: ${sent.units} units (requested ${b.units}), ${b.locks} locks`,
        );
        expect(sent.units).toBeLessThanOrEqual(BigInt(b.units));
        // The request less its load term would not cover this batch.
        if (sent.units > BigInt(b.units - 4_000 * loads)) loadTermNeeded = true;
      }
      expect(loadTermNeeded, "a batch the load term is needed for").toBe(true);
      expect(env.exists(r.address)).toBe(false);
      for (const t of tickets) expect(env.exists(t)).toBe(false);
    });
});

describe("settlement batch sizes without a lookup table", () => {
  it("counts a batch's instruction trace: its instructions, a CPI a ticket and a winner, three more", async () => {
    const caller = createNoopSigner((await generateKeyPairSigner()).address);
    const r = await syntheticRound();
    const lifetime = {
      blockhash: "11111111111111111111111111111111" as never,
      lastValidBlockHeight: 0n,
    };
    const items = await synthetic(10, MIXES[0]!);
    const winners = items.filter((i) => i.payout > 0n).length;
    expect(winners).toBe(3);
    expect(settlementTrace(1, items)).toBe(1 + 10 + 3 + 3);
    expect(settlementTrace(1, items.slice(0, 1))).toBe(1 + 1 + (items[0]!.payout > 0n ? 1 : 0) + 3);
    for (const format of [1, 0] as const) {
      const [b] = await planSettlement(caller, r, items, USDC_MINT, {
        format,
        lifetime,
        priority: PRIORITY[format],
      });
      // v1 carries its budget in the header; v0 adds compute budget instructions.
      const top = b!.message.instructions.length;
      expect(top).toBe(format === 1 ? 1 : 3);
      expect(b!.trace).toBe(top + 10 + 3 + 3);
    }
  });

  it("measures the largest batch per format and mix", async () => {
    const rows: string[] = [];
    const result: Record<string, Record<string, number>> = {};
    for (const mix of MIXES) {
      result[mix.name] = {};
      for (const format of [1, 0] as const) {
        const b = await largest(mix, format);
        expect(batchFits(b, format)).toBe(true);
        result[mix.name]![`v${format}`] = b.items.length;
        rows.push(
          `${mix.name}, v${format}: ${b.items.length} tickets (${b.items.filter((i) => i.payout > 0n).length} winners), ${b.bytes} bytes, ${b.locks} locks, trace ${b.trace}, ${b.units} units requested`,
        );
      }
    }
    console.log(`settlement batch sizes (30 % winners):\n${rows.join("\n")}`);
    // v1 is bound by the account locks and MAX_ROUND_BATCH, v0 by its 1 232 bytes.
    expect(result).toEqual(MEASURED);
  });

  for (const mix of MIXES) {
    it(`runs the largest v1 batch, ${mix.name}`, async () => {
      const env = await BeaconEnv.create();
      const coin = await register(env, COIN_FLIP);
      const n = MEASURED[mix.name]!.v1;
      const c = await cast(env, mix.integrators(n), mix.payers(n));
      const tickets: Address[] = [];
      for (let i = 0; i < n; i++)
        tickets.push((await join(env, c, await player(env, c, i), coin, 1n * USDC)).ticket);
      let r = await round(env, 1n);
      expect(r.data.tickets).toBe(n);
      expect(r.data.status).toBe(RoundStatus.Paid);

      // A randomness giving about the measured share of winners.
      const tables = await tablesOf(env, [coin]);
      let randomness: Uint8Array | null = null;
      let items: SettlementItem[] = [];
      for (let b = 1; b < 255 && !randomness; b++) {
        items = await predictSettlement(
          r,
          fill(b),
          await Promise.all(tickets.map((t) => ticket(env, t))),
          tables,
        );
        const w = items.filter((i) => i.payout > 0n).length;
        if (w >= Math.floor(n * 0.25) && w <= Math.ceil(n * 0.35)) randomness = fill(b);
      }
      expect(randomness, "a randomness with 25 to 35 % winners").not.toBeNull();
      await drawRound(env, 1n, randomness!);
      r = await round(env, 1n);
      const plan = await planSettlement(env.keeper, r, items, USDC_MINT, {
        format: 1,
        lifetime: env.lifetime(),
      });
      const winners = items.filter((i) => i.payout > 0n).length;
      // The measurement claims one transaction for the whole batch: the real
      // accounts must not split it.
      expect(plan).toHaveLength(1);
      expect(plan[0]!.items.length).toBe(n);
      console.log(
        `${mix.name}: ${n} tickets, ${winners} winners, ${plan.length} v1 batch(es), ${plan.map((b) => `${b.items.length} tickets ${b.bytes} bytes ${b.locks} locks`).join("; ")}`,
      );
      for (const b of plan) {
        expect(b.locks).toBeLessThanOrEqual(MAX_ACCOUNT_LOCKS);
        const sent = await env.sendMessage(b.message);
        console.log(
          `  ran: ${sent.units} units (requested ${b.units}), ${sent.bytes} bytes on the wire`,
        );
        expect(sent.units).toBeLessThanOrEqual(BigInt(b.units));
        expect(sent.bytes).toBe(b.bytes);
      }
      expect(env.exists(r.address)).toBe(false);
      for (const t of tickets) expect(env.exists(t)).toBe(false);
    });
  }
});
