// The checks the migration rehearsal makes on every transaction
// (scripts/devnet/beacon-checks.ts), run here against the program itself
// in litesvm: what each join, sponsorship, request, settlement batch,
// parked claim, reclaim, refund, return and expiry is predicted to move
// must be exactly what moved, and a prediction off by one unit (a wrong
// price, prepay, share split, reservation, payout, charge, draw cost,
// counter or event field) must be reported. The world is seeded: the same
// wallets, tickets and outcomes on every run, so that each mutation branch
// is taken on purpose, never by luck.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenPda } from "@solana-program/token";
import {
  compileTransactionMessage,
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Decoder,
  getProgramDerivedAddress,
  getU64Encoder,
  lamports,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { ticketRequestAddress } from "../../../clients/js/src/direct/index.ts";
import {
  FADE_PROGRAM_ADDRESS,
  RoundStatus,
  RoundTicketStatus,
  ROUND_EXPIRED_EVENT_DISCRIMINATOR,
  findConfigPda,
  findDepositQueueUsdcPda,
  findIntegratorPda,
  findPayableUsdcPda,
  findPayoutEscrowPda,
  findRoundTicketPda,
  findQueuePda,
  findRoundVrfPda,
  findShareClaimsPda,
  findShareEscrowPda,
  findShareMintPda,
  findSponsorshipPda,
  findTicketPda,
  findVaultPda,
  findVaultUsdcPda,
  findVrfPayerPda,
  getClaimDepositInstructionAsync,
  getExpireTicketInstructionAsync,
  getRecordTicketEntropyInstruction,
  getOpenTicketInstructionAsync,
  getQueueDecoder,
  getRequestDepositInstructionAsync,
  getRequestWithdrawInstructionAsync,
  getStrikeEpochInstructionAsync,
  getTicketDecoder,
  getTicketSize,
  getConfigDecoder,
  getIntegratorDecoder,
  getIntegratorSize,
  getPayoutTableDecoder,
  getRefundRoundInstructionAsync,
  getRegisterPayoutTableInstruction,
  getRoundDecoder,
  getRoundExpiredEventEncoder,
  getRoundTicketDecoder,
  getSponsorshipDecoder,
  getVaultDecoder,
  type OutcomeArgs,
  type Round,
  type RoundTicket,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  ORAO_PENDING_LEN,
  SLOT_HASHES_SYSVAR,
  beaconTransactionMessage,
  findRoundPda,
  firstSlotAfterRetained,
  getBeaconClaimPayoutInstructionAsync,
  getBeaconExpireInstructionAsync,
  getBeaconJoinInstructionAsync,
  getBeaconReclaimInstructionAsync,
  getBeaconRequestDrawInstructionAsync,
  getBeaconReturnInstructionAsync,
  getCompleteDrawInstructionAsync,
  oraoNetworkState,
  findOraoNetworkStatePda,
  findPayoutTablePda,
  planSettlement,
  predictSettlement,
  resolveJoinRound,
  roundRequestAddress,
  type BeaconTransactionMessage,
  type Held,
  type SettlementItem,
} from "../../../clients/js/src/beacon/index.ts";
import {
  EVENT_IX_TAG,
  emittedEvents,
  eventMismatches,
  expectClaimPayout,
  expectExpireTicket,
  expectJoin,
  expectOpenTicket,
  expectReclaim,
  expectRefund,
  expectRequest,
  expectReturn,
  expectSettlement,
  expectSponsor,
  expectStrike,
  expectUnrequestedExpiry,
  invariantMismatches,
  mayCloseShareAccount,
  mismatches,
  openReferences,
  roundExpiredEvent,
  seenBetween,
  shareBookMismatches,
  sweepHolds,
  type AccountState,
  type Expected,
  type IntegratorShares,
  type InstanceState,
  type JsonTransaction,
  type Rents,
  type Snapshot,
} from "../../../scripts/devnet/beacon-checks.ts";
import { BeaconEnv, COIN_FLIP, ORAO_FEE, USDC, USDC_MINT } from "./beaconEnv.ts";
import { getAddressEncoder } from "@solana/kit";

const getAddressBytes = (a: Address) => getAddressEncoder().encode(a);

/** litesvm's fee: 5 000 lamports a signature, no priority fee requested. */
const FEE_PER_SIGNATURE = 5_000n;
/** The fee of a transaction its fee payer alone signs. */
const FEE = FEE_PER_SIGNATURE;
const P = FADE_PROGRAM_ADDRESS;

function snapshot(env: BeaconEnv, addresses: Iterable<Address>): Snapshot {
  const s = new Map<Address, AccountState>();
  for (const a of addresses) {
    const acc = env.svm.client.getAccount(a);
    s.set(
      a,
      acc.exists && acc.lamports > 0n
        ? { lamports: acc.lamports, owner: acc.programAddress, data: new Uint8Array(acc.data) }
        : null,
    );
  }
  return s;
}

type Landed = JsonTransaction & { slot: bigint; blockTime: bigint };

/** Signs and sends `message` with the latest blockhash; its RPC-like JSON (slot and time included). */
async function send(env: BeaconEnv, message: BeaconTransactionMessage): Promise<Landed> {
  const m = setTransactionMessageLifetimeUsingBlockhash(env.lifetime(), message);
  const keys = compileTransactionMessage(m).staticAccounts;
  const tx = await signTransactionMessageWithSigners(m);
  const clock = env.svm.client.getClock();
  const result = env.svm.client.sendTransaction(tx);
  if (result instanceof FailedTransactionMetadata) throw new Error(result.meta().logs().join("\n"));
  env.svm.client.expireBlockhash();
  const b58 = getBase58Decoder();
  return {
    slot: clock.slot,
    blockTime: clock.unixTimestamp,
    transaction: { message: { accountKeys: keys } },
    meta: {
      fee: FEE_PER_SIGNATURE * BigInt(Object.keys(tx.signatures).length),
      innerInstructions: result.innerInstructions().map((group) => ({
        instructions: group.map((i) => {
          const c = i.instruction();
          return {
            programIdIndex: c.programIdIndex(),
            accounts: Array.from(c.accounts()),
            data: b58.decode(c.data()),
          };
        }),
      })),
    },
  };
}

const sendIxs = (env: BeaconEnv, payer: KeyPairSigner, ixs: Instruction[]) =>
  send(env, beaconTransactionMessage(1, payer, env.lifetime(), ixs, { computeUnitLimit: 600_000 }));

async function heldRound(env: BeaconEnv, id: bigint): Promise<Held<Round>> {
  const [address] = await findRoundPda(id);
  return { address, data: env.read(address, getRoundDecoder()) };
}

const heldTicket = (env: BeaconEnv, address: Address): Held<RoundTicket> => ({
  address,
  data: env.read(address, getRoundTicketDecoder()),
});

/** What moved, in the shape `mismatches` compares. */
const seen = (before: Snapshot, after: Snapshot, vault: Address, integrators: Address[]) =>
  seenBetween(before, after, vault, integrators, USDC_MINT);

/** A copy of `e` with `d` added to `address`'s expected `kind` delta. */
function off(e: Expected, kind: "lamports" | "usdc", address: Address, d: bigint): Expected {
  const m = new Map(e[kind]);
  m.set(address, (m.get(address) ?? 0n) + d);
  return { ...e, [kind]: m };
}

/** A wallet from a fixed seed, funded: the same address on every run. */
async function seeded(env: BeaconEnv, label: string, sol: bigint): Promise<KeyPairSigner> {
  const seed = createHash("sha256").update(`beaconChecks:${label}`).digest();
  const signer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(seed));
  env.svm.client.airdrop(signer.address, lamports(sol * 1_000_000_000n));
  return signer;
}

type World = Awaited<ReturnType<typeof world>>;

/** A founded vault, the coin flip, two integrators with share accounts, three payers, a funder. */
async function world() {
  const env = await BeaconEnv.create();
  const [coin] = await findPayoutTablePda(COIN_FLIP);
  await env.send(env.keeper, [
    getRegisterPayoutTableInstruction({
      payer: env.keeper,
      payoutTable: coin,
      eventAuthority: env.eventAuthority,
      program: P,
      outcomes: COIN_FLIP as OutcomeArgs[],
    }),
  ]);
  const ints = [await seeded(env, "int-0", 10n), await seeded(env, "int-1", 10n)];
  const shares = await Promise.all(ints.map((k) => env.usdcAccount(k.address, 0n)));
  const pays = [
    await seeded(env, "pay-0", 100n),
    await seeded(env, "pay-1", 100n),
    await seeded(env, "pay-2", 100n),
  ];
  const funder = await seeded(env, "funder", 1n);
  const funderUsdc = await env.usdcAccount(funder.address, 1_000n * USDC);
  const [vault] = await findVaultPda();
  const [vaultUsdc] = await findVaultUsdcPda();
  const [escrow] = await findPayoutEscrowPda();
  const [config] = await findConfigPda();
  const [networkState] = await findOraoNetworkStatePda();
  const integrators = await Promise.all(
    ints.map(async (k) => (await findIntegratorPda({ integratorAuthority: k.address }))[0]),
  );
  const rentOf = (n: number) => env.svm.client.minimumBalanceForRentExemption(BigInt(n));
  const rents: Rents = {
    round: rentOf(411),
    ticket: rentOf(291),
    sponsorship: rentOf(58),
    integrator: rentOf(getIntegratorSize()),
  };
  return {
    env,
    coin,
    ints,
    shares,
    pays,
    funder,
    funderUsdc,
    vault,
    vaultUsdc,
    escrow,
    config,
    networkState,
    integrators,
    rents,
    pendingRent: rentOf(ORAO_PENDING_LEN),
  };
}

const params = (w: World) => w.env.read(w.config, getConfigDecoder()).params;

/**
 * `n` joins of `price` by player `i` = integrator `i % 2`, payer `i % 3`,
 * each with a beneficiary of its own; each checked to the unit with
 * `expectJoin`, and the first one's prediction off by a unit reported.
 */
async function joins(
  w: World,
  n: number,
  price: bigint,
): Promise<{ id: bigint; tickets: Address[]; mutated: number }> {
  const { env } = w;
  const tickets: Address[] = [];
  let id = 0n;
  let mutated = 0;
  const table = { address: w.coin, data: env.read(w.coin, getPayoutTableDecoder()) };
  for (let i = 0; i < n; i++) {
    const vault = await env.vault();
    let accepting: Round | null = null;
    if (vault.acceptingRound !== 0n) {
      const [a] = await findRoundPda(vault.acceptingRound);
      if (env.exists(a)) accepting = env.read(a, getRoundDecoder());
    }
    const target = await resolveJoinRound(vault, accepting, env.slot());
    const rounds = {
      accepting: vault.acceptingRound !== 0n ? (await findRoundPda(vault.acceptingRound))[0] : null,
      next: (await findRoundPda(vault.nextRoundId))[0],
    };
    const k = i % 2;
    const integrator = w.integrators[k]!;
    const created = !env.exists(integrator);
    const nonce = created ? 0n : env.read(integrator, getIntegratorDecoder()).nextNonce;
    const payer = w.pays[i % 3]!;
    const beneficiary = await env.usdcAccount(payer.address, 0n);
    const [ticket] = await findRoundTicketPda({ integrator, nonce });
    const ix = await getBeaconJoinInstructionAsync(
      {
        integratorAuthority: w.ints[k]!,
        payer,
        funder: w.funder,
        funderUsdc: w.funderUsdc,
        ...(created ? { shareAccount: w.shares[k]! } : {}),
        beneficiary,
        payoutTable: w.coin,
        usdcMint: USDC_MINT,
        price,
        appShareBps: 100,
        nonce,
        sponsorship: 0n,
      },
      target,
    );
    const [landing] = await findRoundPda(target.landsIn);
    const accounts = new Set<Address>([
      env.keeper.address,
      payer.address,
      w.funderUsdc,
      w.vault,
      w.vaultUsdc,
      target.round,
      target.nextRound,
      integrator,
      ticket,
      beneficiary,
      w.networkState,
    ]);
    const before = snapshot(env, accounts);
    const input = {
      program: P,
      params: params(w),
      oraoFee: ORAO_FEE,
      pendingRent: w.pendingRent,
      rents: w.rents,
      vault: w.vault,
      vaultUsdc: w.vaultUsdc,
      rounds,
      integrator,
      integratorAuthority: w.ints[k]!.address,
      shareAccount: w.shares[k]!,
      ticket,
      sponsorshipRecord: null,
      table,
      payer: payer.address,
      funder: w.funder.address,
      funderUsdc: w.funderUsdc,
      beneficiary,
      mint: USDC_MINT,
      feePayer: env.keeper.address,
      price,
      appShareBps: 100n,
      nonce,
      sponsorship: 0n,
      before,
    };
    const tx = await sendIxs(env, env.keeper, [ix]);
    const at = { slot: tx.slot, now: tx.blockTime };
    // Four signatures: the fee payer, the integrator, the payer and the funder.
    const fee = tx.meta!.fee;
    expect(fee).toBe(4n * FEE_PER_SIGNATURE);
    const expected = expectJoin(input, fee, at);
    const moved = seen(before, snapshot(env, accounts), w.vault, [integrator]);
    expect(mismatches(expected, moved)).toEqual([]);
    if (i === 0) {
      // The funder debited one unit more than the price: reported on its account.
      expect(mismatches(off(expected, "usdc", w.funderUsdc, -1n), moved)).toHaveLength(1);
      // The shares split from the wrong rate: the credit, held shares and ticket fields differ.
      const split = mismatches(expectJoin({ ...input, appShareBps: 120n }, fee, at), moved);
      expect(split.some((m) => m.startsWith("vault.totalAssets"))).toBe(true);
      expect(split.some((m) => m.startsWith("vault.beaconSharesHeld"))).toBe(true);
      expect(split.some((m) => m.startsWith("ticket.appShare"))).toBe(true);
      // Less liability reserved than risk::liability(payout_max, credit): reported on the
      // vault, the integrator and the ticket.
      const lower = { ...table, data: { ...table.data, maxM: table.data.maxM - 1n } };
      const reserved = mismatches(expectJoin({ ...input, table: lower }, fee, at), moved);
      expect(reserved.some((m) => m.startsWith("vault.totalReservedLiability"))).toBe(true);
      expect(reserved.some((m) => m.includes(`${integrator}.reservedLiability`))).toBe(true);
      expect(reserved.some((m) => m.startsWith("ticket.liability"))).toBe(true);
      // A prepay from other terms (the round created on another threshold): the payer,
      // the round and the stored prepay differ.
      const terms = { ...input.params, beaconThreshold: input.params.beaconThreshold / 2n };
      const prepaid = mismatches(expectJoin({ ...input, params: terms }, fee, at), moved);
      expect(prepaid.some((m) => m.includes(`lamports of ${payer.address}`))).toBe(true);
      expect(prepaid.some((m) => m.startsWith("ticket.prepay"))).toBe(true);
      // The integrator's open tickets not counted.
      const count = new Map(expected.integrators);
      count.set(integrator, { ...count.get(integrator)!, openTickets: 0n });
      expect(mismatches({ ...expected, integrators: count }, moved)).toHaveLength(1);
      mutated++;
    }
    if (i === 0) id = target.landsIn;
    expect(target.landsIn).toBe(id);
    tickets.push(ticket);
  }
  return { id, tickets, mutated };
}

/** The round sponsored to its draw by a fresh sponsor, checked to the unit. */
async function sponsor(w: World, id: bigint) {
  const { env } = w;
  const s = await seeded(env, `sponsor-${id}`, 10n);
  const r = await heldRound(env, id);
  const complete = await getCompleteDrawInstructionAsync(s, r);
  const [record] = await findSponsorshipPda({ round: r.address, sponsor: s.address });
  const accounts = new Set<Address>([s.address, r.address, record, w.vault, w.networkState]);
  const before = snapshot(env, accounts);
  const input = {
    program: P,
    vault: w.vault,
    round: r.address,
    sponsor: s.address,
    record,
    lamports: complete!.lamports,
    recordRent: w.rents.sponsorship,
    mint: USDC_MINT,
    feePayer: s.address,
    before,
  };
  const tx = await sendIxs(env, s, [complete!.instruction]);
  const at = { slot: tx.slot, now: tx.blockTime };
  const expected = expectSponsor(input, FEE, at);
  const moved = seen(before, snapshot(env, accounts), w.vault, []);
  expect(mismatches(expected, moved)).toEqual([]);
  expect(expected.becamePaid).toBe(true);
  // One lamport more taken from the sponsor than it passed: reported.
  expect(mismatches(off(expected, "lamports", s.address, -1n), moved)).toHaveLength(1);
  // A sponsorship of another amount: the lamports and the stored amounts differ.
  const other = mismatches(
    expectSponsor({ ...input, lamports: input.lamports + 1n }, FEE, at),
    moved,
  );
  expect(other.some((m) => m.startsWith("sponsorship.amount"))).toBe(true);
  expect(other.some((m) => m.startsWith("round.sponsorship"))).toBe(true);
  // The round's tickets not entered in the counters: reported.
  const uncounted = {
    ...expected,
    vault: { ...expected.vault, openAfterClose: expected.vault.openAfterClose + 1n },
  };
  expect(mismatches(uncounted, moved)).toHaveLength(1);
  expect((await heldRound(env, id)).data.status).toBe(RoundStatus.Paid);
  return s;
}

/** Every account a settlement batch of `items` may move. */
async function settleAccounts(w: World, r: Held<Round>, items: readonly SettlementItem[]) {
  const [roundVrf] = await findRoundVrfPda({ round: r.address });
  const set = new Set<Address>([
    w.env.keeper.address,
    r.address,
    roundVrf,
    w.vault,
    w.vaultUsdc,
    w.escrow,
    r.data.rentPayer,
  ]);
  for (const it of items) {
    const t = it.ticket.data;
    set.add(it.ticket.address).add(t.payer).add(t.beneficiary).add(t.integrator);
  }
  return { set, roundVrf };
}

/** The instance as litesvm holds it: the vault, its token accounts, `rounds` and `tickets`. */
function instance(
  w: World,
  rounds: readonly Held<Round>[],
  tickets: readonly Held<RoundTicket>[],
): InstanceState {
  const { env } = w;
  return {
    vault: env.read(w.vault, getVaultDecoder()),
    vaultUsdc: env.balance(w.vaultUsdc),
    payoutEscrow: env.exists(w.escrow) ? env.balance(w.escrow) : 0n,
    rounds: rounds.map((r) => r.data),
    tickets: tickets.map((t) => t.data),
    roundStatus: new Map(rounds.map((r) => [r.data.id, r.data.status])),
    direct: [],
    integrators: w.integrators
      .filter((i) => env.exists(i))
      .map((i) => {
        const d = env.read(i, getIntegratorDecoder());
        return {
          address: i,
          reservedLiability: d.reservedLiability,
          openTickets: d.openTickets,
          appSharesAccrued: d.appSharesAccrued,
        };
      }),
  };
}

describe("the beacon's checks against the program (litesvm)", () => {
  it("each join, sponsorship, request, settlement batch, parked claim and reclaim moves exactly what was predicted; a unit off is reported", async () => {
    const w = await world();
    const { env } = w;
    const { id, tickets, mutated } = await joins(w, 6, 1n * USDC);
    expect(mutated).toBe(1);
    // Invariants 1 and 2 on the instance with the round open; a unit short reported.
    {
      const r = await heldRound(env, id);
      const s = instance(
        w,
        [r],
        tickets.map((t) => heldTicket(env, t)),
      );
      expect(invariantMismatches(s)).toEqual([]);
      const books =
        s.vault.totalAssets +
        s.vault.beaconSharesHeld +
        s.vault.protocolSharesAccrued +
        s.vault.appSharesOwed +
        s.vault.beaconReturnsOwed;
      expect(invariantMismatches({ ...s, vaultUsdc: books - 1n })).toHaveLength(1);
      const [first] = s.integrators;
      expect(
        invariantMismatches({
          ...s,
          integrators: [
            { ...first!, reservedLiability: first!.reservedLiability - 1n },
            ...s.integrators.slice(1),
          ],
        }),
      ).toHaveLength(1);
    }
    const sponsorWallet = (await sponsor(w, id)).address;
    let r = await heldRound(env, id);

    // A randomness with three or four winners and two losers or more (seeded world: the
    // same byte every run).
    const tables = new Map([[w.coin, env.read(w.coin, getPayoutTableDecoder())]]);
    let randomness = new Uint8Array(64);
    let items: SettlementItem[] = [];
    for (let b = 1; b < 255; b++) {
      randomness = new Uint8Array(64).fill(b);
      items = await predictSettlement(
        r,
        randomness,
        tickets.map((t) => heldTicket(env, t)),
        tables,
      );
      const winners = items.filter((i) => i.payout > 0n).length;
      if (winners >= 3 && winners <= 4) break;
    }

    const winnersList = items.filter((i) => i.payout > 0n);
    const losers = items.filter((i) => i.payout === 0n);
    expect(winnersList.length).toBeGreaterThanOrEqual(3);
    expect(losers.length).toBeGreaterThanOrEqual(2);

    // The draw, as the run requests it, checked to the unit.
    env.setSlot(r.data.closeSlot + 2n);
    const named = await roundRequestAddress(r, env.data(SLOT_HASHES_SYSVAR));
    const network = oraoNetworkState(env.data(w.networkState));
    const { instruction, request } = await getBeaconRequestDrawInstructionAsync(
      env.keeper,
      r,
      env.slot(),
      env.data(SLOT_HASHES_SYSVAR),
      network.treasury,
      named ? env.account(named.request) : null,
    );
    const [roundVrf] = await findRoundVrfPda({ round: r.address });
    const reqAccounts = new Set<Address>([
      env.keeper.address,
      r.address,
      roundVrf,
      request,
      network.treasury,
      w.vault,
    ]);
    const reqBefore = snapshot(env, reqAccounts);
    const reqInput = {
      program: P,
      vault: w.vault,
      round: r.address,
      roundVrf,
      request,
      oraoTreasury: network.treasury,
      oraoFee: network.fee,
      pendingRent: w.pendingRent,
      entropySlot: firstSlotAfterRetained(env.data(SLOT_HASHES_SYSVAR), r.data.closeSlot)!.slot,
      mint: USDC_MINT,
      caller: env.keeper.address,
      fee: FEE,
      before: reqBefore,
    };
    await sendIxs(env, env.keeper, [instruction]);
    const reqExpected = expectRequest(reqInput);
    const reqMoved = seen(reqBefore, snapshot(env, reqAccounts), w.vault, []);
    expect(mismatches(reqExpected, reqMoved)).toEqual([]);
    // ORAO paid one lamport more out of the round, with a matching `funded`: reported.
    const dearer = mismatches(
      expectRequest({ ...reqInput, oraoFee: reqInput.oraoFee + 1n }),
      reqMoved,
    );
    expect(dearer.some((m) => m.startsWith("round.funded"))).toBe(true);
    expect(dearer.some((m) => m.includes(`lamports of ${r.address}`))).toBe(true);
    expect(mismatches(off(reqExpected, "lamports", env.keeper.address, 1n), reqMoved)).toHaveLength(
      1,
    );

    await env.fulfill(request, roundVrf, randomness);
    r = await heldRound(env, id);

    // Two batches: the first fixes the draw's cost, the second reads it.
    // A winner's beneficiary frozen in the first: its payout parked in escrow.
    // Every ticket has its own beneficiary, so no other payout is parked, and
    // each batch holds a winner paid out.
    const winner = winnersList[0]!;
    const firstHalf = [winner, winnersList[1]!, losers[0]!];
    const secondHalf = items.filter((i) => !firstHalf.includes(i));
    expect(new Set(items.map((i) => i.ticket.data.beneficiary)).size).toBe(items.length);
    env.setTokenState(winner.ticket.data.beneficiary, 2);
    let wrongPayouts = 0;
    for (const [n, part] of [firstHalf, secondHalf].entries()) {
      r = await heldRound(env, id);
      const [batch] = await planSettlement(env.keeper, r, part, USDC_MINT, {
        format: 1,
        lifetime: env.lifetime(),
      });
      const { set } = await settleAccounts(w, r, batch!.items);
      const before = snapshot(env, set);
      const settleInput = {
        round: r,
        roundVrf,
        vault: w.vault,
        vaultUsdc: w.vaultUsdc,
        payoutEscrow: w.escrow,
        mint: USDC_MINT,
        caller: env.keeper.address,
        fee: FEE,
        before,
      };
      const expected = expectSettlement({
        ...settleInput,
        tickets: batch!.items.map((i) => ({ ...i.ticket, payout: i.payout })),
      });
      await send(env, batch!.message);
      const after = snapshot(env, set);
      const moved = seen(before, after, w.vault, w.integrators);
      expect(mismatches(expected, moved)).toEqual([]);
      if (n === 0) {
        expect(expected.drawCost).toBe((await heldRound(env, id)).data.drawCost);
        expect(heldTicket(env, winner.ticket.address).data.status).toBe(
          RoundTicketStatus.PayoutParked,
        );
      }

      // A payout one unit off (a lower multiplier), to a winner paid out, is reported on its
      // beneficiary and the books.
      const paid = batch!.items.find(
        (i) =>
          i.payout > 0n &&
          i.ticket.address !== winner.ticket.address &&
          before.get(i.ticket.data.beneficiary) !== null,
      );
      if (paid) {
        const wrong = expectSettlement({
          ...settleInput,
          tickets: batch!.items.map((i) => ({
            ...i.ticket,
            payout: i === paid ? i.payout - 1n : i.payout,
          })),
        });
        const found = mismatches(wrong, moved);
        expect(found.some((m) => m.includes(`USDC of ${paid.ticket.data.beneficiary}`))).toBe(true);
        expect(found.some((m) => m.startsWith("vault.totalAssets"))).toBe(true);
        wrongPayouts++;
      }
      // A charge off (another sponsorship, so another draw share) is reported on the payers.
      const charged = expectSettlement({
        ...settleInput,
        round: { ...r, data: { ...r.data, sponsorship: r.data.sponsorship / 2n } },
        tickets: batch!.items.map((i) => ({ ...i.ticket, payout: i.payout })),
      });
      expect(mismatches(charged, moved).some((m) => m.startsWith("lamports of"))).toBe(true);
      // A settlement share or a ticket rent off by one lamport is reported.
      expect(mismatches(off(expected, "lamports", env.keeper.address, 1n), moved)).toHaveLength(1);
      // A ticket left in its counter, or an integrator's reservation not released: reported.
      const counted = {
        ...expected,
        vault: { ...expected.vault, openAfterClose: expected.vault.openAfterClose + 1n },
      };
      expect(mismatches(counted, moved)).toHaveLength(1);
      const t0 = batch!.items[0]!.ticket.data.integrator;
      const kept = new Map(expected.integrators);
      kept.set(t0, { ...kept.get(t0)!, reservedLiability: 0n });
      expect(mismatches({ ...expected, integrators: kept }, moved)).toHaveLength(1);
    }
    // Both batches have a winner other than the frozen one: the branch above ran in each.
    expect(wrongPayouts).toBe(2);
    r = await heldRound(env, id);
    expect(r.data.tickets).toBe(0);
    // The parked payout in escrow: invariant 1's second half; an escrow a unit short reported.
    const parkedState = instance(w, [r], [heldTicket(env, winner.ticket.address)]);
    expect(invariantMismatches(parkedState)).toEqual([]);
    expect(
      invariantMismatches({ ...parkedState, payoutEscrow: parkedState.payoutEscrow - 1n }),
    ).toHaveLength(1);

    // The parked payout claimed once its beneficiary can receive again, checked to the unit.
    env.setTokenState(winner.ticket.data.beneficiary, 1);
    const parked = heldTicket(env, winner.ticket.address);
    const claimAccounts = new Set<Address>([
      env.keeper.address,
      parked.address,
      parked.data.payer,
      parked.data.beneficiary,
      w.escrow,
      w.vault,
    ]);
    const claimBefore = snapshot(env, claimAccounts);
    const claimInput = {
      ticket: parked,
      predicted: winner.payout,
      payoutEscrow: w.escrow,
      mint: USDC_MINT,
      caller: env.keeper.address,
      fee: FEE,
      before: claimBefore,
    };
    await sendIxs(env, env.keeper, [
      await getBeaconClaimPayoutInstructionAsync(env.keeper, parked, USDC_MINT),
    ]);
    const claimExpected = expectClaimPayout(claimInput);
    const claimMoved = seen(claimBefore, snapshot(env, claimAccounts), w.vault, []);
    expect(mismatches(claimExpected, claimMoved)).toEqual([]);
    expect(
      mismatches(off(claimExpected, "usdc", parked.data.beneficiary, 1n), claimMoved),
    ).toHaveLength(1);
    // A ticket that parked another amount than its predicted payout is refused by the check.
    expect(() => expectClaimPayout({ ...claimInput, predicted: winner.payout - 1n })).toThrow(
      /parked/,
    );

    // The sponsorship reclaimed: its return and its rent, the round's rent to its rent payer.
    expect(r.data.sponsors).toBe(1);
    const [record] = await findSponsorshipPda({ round: r.address, sponsor: sponsorWallet });
    const data = env.read(record, getSponsorshipDecoder());
    const set = new Set<Address>([
      env.keeper.address,
      r.address,
      record,
      sponsorWallet,
      r.data.rentPayer,
      w.vault,
    ]);
    const before = snapshot(env, set);
    const expected = expectReclaim({
      round: r,
      sponsorship: { address: record, sponsor: sponsorWallet, amount: data.amount },
      mint: USDC_MINT,
      caller: env.keeper.address,
      fee: FEE,
      before,
    });
    await sendIxs(env, env.keeper, [
      await getBeaconReclaimInstructionAsync(env.keeper, r, { address: record, data }),
    ]);
    const after = snapshot(env, set);
    expect(env.exists(r.address)).toBe(false);
    expect(mismatches(expected, seen(before, after, w.vault, []))).toEqual([]);
    // A sponsor return one lamport off is reported.
    expect(
      mismatches(off(expected, "lamports", sponsorWallet, -1n), seen(before, after, w.vault, [])),
    ).toHaveLength(1);
    // Nothing open: both invariants on the instance.
    expect(invariantMismatches(instance(w, [], []))).toEqual([]);
  });

  it("an unrequested expiry: the books, the counters, the lamports and the RoundExpired event as emitted", async () => {
    const w = await world();
    const { env } = w;
    const { id, tickets } = await joins(w, 2, 1n * USDC);
    const sponsorWallet = await sponsor(w, id);
    let r = await heldRound(env, id);
    env.setSlot(r.data.closeSlot + r.data.tSettleSlots + 1n);
    const named = await roundRequestAddress(r, env.data(SLOT_HASHES_SYSVAR));
    expect(named).not.toBeNull();
    const set = new Set<Address>([env.keeper.address, r.address, w.vault, w.vaultUsdc]);
    const before = snapshot(env, set);
    const expected = expectUnrequestedExpiry({
      program: P,
      round: r,
      vault: w.vault,
      mint: USDC_MINT,
      caller: env.keeper.address,
      fee: FEE,
      before,
    });
    const tx = await sendIxs(env, env.keeper, [
      await getBeaconExpireInstructionAsync(
        env.keeper,
        r,
        env.slot(),
        env.data(SLOT_HASHES_SYSVAR),
        env.account(named!.request),
      ),
    ]);
    const after = snapshot(env, set);
    expect(mismatches(expected, seen(before, after, w.vault, []))).toEqual([]);
    const event = roundExpiredEvent(tx, P, env.eventAuthority);
    expect(eventMismatches(expected.event, event)).toEqual([]);
    // A `checked` or `request_found` the program got wrong is reported.
    expect(eventMismatches(expected.event, { ...event, checked: false })).toHaveLength(1);
    expect(eventMismatches(expected.event, { ...event, requestFound: true })).toHaveLength(1);
    expect(
      eventMismatches(expected.event, { ...event, forfeited: event.forfeited - 1n }),
    ).toHaveLength(1);
    // Forfeited credits not released from the books, or tickets left in their counter: reported.
    const unbooked = { ...expected, vault: { ...expected.vault, openVaultCredits: 0n } };
    expect(mismatches(unbooked, seen(before, after, w.vault, []))).toHaveLength(1);
    const counted = {
      ...expected,
      vault: { ...expected.vault, openAfterClose: expected.vault.openAfterClose + 1n },
    };
    expect(mismatches(counted, seen(before, after, w.vault, []))).toHaveLength(1);
    // The forfeiture's gain booked after the close (the round counted after it).
    expect(expected.vault.afterCloseGain).toBe(r.data.credits);

    // Each forfeited return: the charge kept, the rest of the prepay and the rent to the
    // payer, the integrator's reservation released.
    for (const t of tickets) {
      r = await heldRound(env, id);
      const ticket = heldTicket(env, t);
      const accounts = new Set<Address>([
        env.keeper.address,
        r.address,
        t,
        ticket.data.payer,
        ticket.data.refundTo,
        ticket.data.integrator,
        r.data.rentPayer,
        w.vault,
        w.vaultUsdc,
      ]);
      const b = snapshot(env, accounts);
      const e = expectReturn({
        round: r,
        ticket,
        vaultUsdc: w.vaultUsdc,
        mint: USDC_MINT,
        caller: env.keeper.address,
        fee: FEE,
        before: b,
      });
      await sendIxs(env, env.keeper, [
        await getBeaconReturnInstructionAsync(env.keeper, r, ticket, USDC_MINT),
      ]);
      const moved = seen(b, snapshot(env, accounts), w.vault, [ticket.data.integrator]);
      expect(mismatches(e, moved)).toEqual([]);
      const kept = new Map(e.integrators);
      const k = ticket.data.integrator;
      kept.set(k, { ...kept.get(k)!, openTickets: 0n });
      expect(mismatches({ ...e, integrators: kept }, moved)).toHaveLength(1);
    }
    // Never requested: the whole sponsorship back with the record's rent.
    r = await heldRound(env, id);
    const [record] = await findSponsorshipPda({ round: r.address, sponsor: sponsorWallet.address });
    const data = env.read(record, getSponsorshipDecoder());
    const accounts = new Set<Address>([
      env.keeper.address,
      r.address,
      record,
      sponsorWallet.address,
      r.data.rentPayer,
      w.vault,
    ]);
    const b = snapshot(env, accounts);
    const e = expectReclaim({
      round: r,
      sponsorship: { address: record, sponsor: sponsorWallet.address, amount: data.amount },
      mint: USDC_MINT,
      caller: env.keeper.address,
      fee: FEE,
      before: b,
    });
    expect(e.returned).toBe(data.amount);
    await sendIxs(env, env.keeper, [
      await getBeaconReclaimInstructionAsync(env.keeper, r, { address: record, data }),
    ]);
    expect(mismatches(e, seen(b, snapshot(env, accounts), w.vault, []))).toEqual([]);
    expect(env.exists(r.address)).toBe(false);
    expect(invariantMismatches(instance(w, [], []))).toEqual([]);
  });

  it("a refund: the books to the unit, the price back to the funder, the whole prepay to the payer", async () => {
    const w = await world();
    const { env } = w;
    const { id, tickets } = await joins(w, 1, 1n * USDC);
    let r = await heldRound(env, id);
    env.setSlot(r.data.lastJoinSlot + r.data.refundSlots);
    const refundAccounts = new Set<Address>([env.keeper.address, r.address, w.vault, w.vaultUsdc]);
    const rb = snapshot(env, refundAccounts);
    // The funder refunds as the round's participant, showing its ticket; the
    // keeper pays the fee (`caller` below is the fee payer).
    await sendIxs(env, env.keeper, [
      await getRefundRoundInstructionAsync({
        caller: w.funder,
        round: r.address,
        participant: tickets[0]!,
        eventAuthority: env.eventAuthority,
        program: P,
      }),
    ]);
    const refund = expectRefund({
      program: P,
      vault: w.vault,
      round: r.address,
      mint: USDC_MINT,
      caller: env.keeper.address,
      // Two signatures: the fee payer's and the funder's.
      fee: 2n * FEE,
      before: rb,
    });
    const refundMoved = seen(rb, snapshot(env, refundAccounts), w.vault, []);
    expect(mismatches(refund, refundMoved)).toEqual([]);
    // Wrong credits released at the refund, or the prices not owed back: reported.
    const credits = {
      ...refund,
      vault: { ...refund.vault, openVaultCredits: refund.vault.openVaultCredits + 1n },
    };
    expect(mismatches(credits, refundMoved)).toHaveLength(1);
    const owed = { ...refund, vault: { ...refund.vault, beaconReturnsOwed: 0n } };
    expect(mismatches(owed, refundMoved)).toHaveLength(1);
    r = await heldRound(env, id);
    // The refunded round's ticket still open: invariant 2 counts its price as owed back.
    expect(invariantMismatches(instance(w, [r], [heldTicket(env, tickets[0]!)]))).toEqual([]);

    const ticket = heldTicket(env, tickets[0]!);
    const accounts = new Set<Address>([
      env.keeper.address,
      r.address,
      ticket.address,
      ticket.data.payer,
      ticket.data.refundTo,
      ticket.data.integrator,
      r.data.rentPayer,
      w.vault,
      w.vaultUsdc,
    ]);
    const b = snapshot(env, accounts);
    const e = expectReturn({
      round: r,
      ticket,
      vaultUsdc: w.vaultUsdc,
      mint: USDC_MINT,
      caller: env.keeper.address,
      fee: FEE,
      before: b,
    });
    await sendIxs(env, env.keeper, [
      await getBeaconReturnInstructionAsync(env.keeper, r, ticket, USDC_MINT),
    ]);
    const moved = seen(b, snapshot(env, accounts), w.vault, [ticket.data.integrator]);
    expect(mismatches(e, moved)).toEqual([]);
    expect(env.exists(r.address)).toBe(false);
    expect(mismatches(off(e, "usdc", ticket.data.refundTo, -1n), moved)).toHaveLength(1);
    expect(invariantMismatches(instance(w, [], []))).toEqual([]);
  });
});

describe("the direct path's checks, as the migration rehearsal drives them (litesvm)", () => {
  it("open_ticket, expire_ticket and a strike with a deposit and a withdrawal move exactly what was predicted; a unit off is reported", async () => {
    const w = await world();
    const { env } = w;
    const p = params(w);
    const [integrator] = await findIntegratorPda({ integratorAuthority: w.ints[0]!.address });
    const table = COIN_FLIP.map((o) => ({ p: BigInt(o.p), m: BigInt(o.m) }));
    const opened: { ticket: Address; vrfPayer: Address }[] = [];
    // Two opens: the first creates the integrator's record, the second finds it, as the
    // rehearsal finds the deployer's V1 integrator.
    for (const nonce of [0n, 1n]) {
      const [ticket] = await findTicketPda({ integrator, nonce });
      const [vrfPayer] = await findVrfPayerPda({ ticket });
      const beneficiary = await env.usdcAccount(w.pays[0]!.address, 0n);
      const accounts = new Set<Address>([
        env.keeper.address,
        w.pays[0]!.address,
        w.funderUsdc,
        env.treasury,
        w.shares[0]!,
        w.vault,
        w.vaultUsdc,
        integrator,
        ticket,
        vrfPayer,
        beneficiary,
        w.networkState,
      ]);
      const before = snapshot(env, accounts);
      const input = {
        program: P,
        params: p,
        outcomes: table,
        price: p.minPrice,
        appShareBps: 30n,
        nonce,
        oraoFee: ORAO_FEE,
        pendingRent: w.pendingRent,
        ticketRent: env.svm.client.minimumBalanceForRentExemption(BigInt(getTicketSize())),
        integratorRent: w.rents.integrator,
        vault: w.vault,
        vaultUsdc: w.vaultUsdc,
        integrator,
        shareAccount: w.shares[0]!,
        protocolTreasury: env.treasury,
        funderUsdc: w.funderUsdc,
        payer: w.pays[0]!.address,
        ticket,
        vrfPayer,
        beneficiary,
        mint: USDC_MINT,
        feePayer: env.keeper.address,
        before,
      };
      const tx = await sendIxs(env, env.keeper, [
        await getOpenTicketInstructionAsync({
          integratorAuthority: w.ints[0]!,
          payer: w.pays[0]!,
          funder: w.funder,
          funderUsdc: w.funderUsdc,
          shareAccount: w.shares[0]!,
          protocolTreasury: env.treasury,
          beneficiary,
          usdcMint: USDC_MINT,
          eventAuthority: env.eventAuthority,
          program: P,
          price: p.minPrice,
          payoutTable: COIN_FLIP,
          appShareBps: 30n,
          nonce,
        }),
      ]);
      const at = { slot: tx.slot, now: tx.blockTime };
      const expected = expectOpenTicket(input, tx.meta!.fee, at);
      const moved = seen(before, snapshot(env, accounts), w.vault, [integrator]);
      expect(mismatches(expected, moved)).toEqual([]);
      // The protocol's share one unit off, another app share, or a reservation from
      // another payout table: reported.
      expect(mismatches(off(expected, "usdc", env.treasury, 1n), moved)).toHaveLength(1);
      const app = mismatches(
        expectOpenTicket({ ...input, appShareBps: 40n }, tx.meta!.fee, at),
        moved,
      );
      expect(app.some((m) => m.includes(`USDC of ${w.shares[0]}`))).toBe(true);
      const wider = table.map((o) => (o.m > 0n ? { ...o, m: o.m + 1n } : o));
      const reserved = mismatches(
        expectOpenTicket({ ...input, outcomes: wider }, tx.meta!.fee, at),
        moved,
      );
      expect(reserved.some((m) => m.startsWith("vault.totalReservedLiability"))).toBe(true);
      expect(reserved.some((m) => m.startsWith("ticket.reservedLiability"))).toBe(true);
      opened.push({ ticket, vrfPayer });
    }

    // Each expired past T_SETTLE, never requested.
    for (const o of [...opened].reverse()) {
      const t = env.read(o.ticket, getTicketDecoder());
      env.setSlot(t.expirySlot + 1n);
      const accounts = new Set<Address>([
        env.keeper.address,
        w.vault,
        o.ticket,
        o.vrfPayer,
        t.payer,
        t.integrator,
      ]);
      const before = snapshot(env, accounts);
      // Never requested: its seed recorded in the same transaction, and the request address
      // derived from it named (nothing exists there).
      const found = await ticketRequestAddress(
        { address: o.ticket, data: t },
        env.data(SLOT_HASHES_SYSVAR),
      );
      await sendIxs(env, env.keeper, [
        getRecordTicketEntropyInstruction({
          ticket: o.ticket,
          eventAuthority: env.eventAuthority,
          program: P,
        }),
        await getExpireTicketInstructionAsync({
          caller: env.keeper,
          integrator: t.integrator,
          ticket: o.ticket,
          randomness: found!.request,
          payer: t.payer,
          eventAuthority: env.eventAuthority,
          program: P,
        }),
      ]);
      const expected = expectExpireTicket({
        program: P,
        vault: w.vault,
        ticket: o.ticket,
        vrfPayer: o.vrfPayer,
        mint: USDC_MINT,
        caller: env.keeper.address,
        fee: FEE,
        before,
      });
      const moved = seen(before, snapshot(env, accounts), w.vault, [t.integrator]);
      expect(mismatches(expected, moved)).toEqual([]);
      const kept = new Map(expected.integrators);
      kept.set(t.integrator, { ...kept.get(t.integrator)!, openTickets: 0n });
      expect(mismatches({ ...expected, integrators: kept }, moved)).toHaveLength(1);
      const credit = {
        ...expected,
        vault: { ...expected.vault, openVaultCredits: expected.vault.openVaultCredits + 1n },
      };
      expect(mismatches(credit, moved)).toHaveLength(1);
    }
    expect(invariantMismatches(instance(w, [], []))).toEqual([]);

    // An LP's deposit struck and claimed, then a deposit and a withdrawal in one epoch.
    const lp = await seeded(env, "lp", 10n);
    const lpUsdc = await env.usdcAccount(lp.address, 500n * USDC);
    const [shareMint] = await findShareMintPda();
    const [lpShares] = await findAssociatedTokenPda({
      owner: lp.address,
      mint: shareMint,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address,
    });
    const [queue] = await findQueuePda();
    const [depositQueue] = await findDepositQueueUsdcPda();
    const [payable] = await findPayableUsdcPda();
    const [shareClaims] = await findShareClaimsPda();
    const [shareEscrow] = await findShareEscrowPda();
    const u64 = (v: bigint) => getU64Encoder().encode(v);
    const pda = async (seed: string, epoch: bigint, owner?: Address) =>
      (
        await getProgramDerivedAddress({
          programAddress: P,
          seeds: owner
            ? [seed, u64(epoch), new Uint8Array(getAddressBytes(owner))]
            : [seed, u64(epoch)],
        })
      )[0];
    const epochOf = () => {
      const q = env.read(queue, getQueueDecoder());
      return q.current.live ? q.current.epochId : q.nextEpochId;
    };
    const deposit = async (amount: bigint) => {
      const epoch = epochOf();
      await sendIxs(env, lp, [
        await getRequestDepositInstructionAsync({
          owner: lp,
          ownerUsdc: lpUsdc,
          usdcMint: USDC_MINT,
          request: await pda("deposit", epoch, lp.address),
          eventAuthority: env.eventAuthority,
          program: P,
          amount,
        }),
      ]);
      return epoch;
    };
    const strike = async (epoch: bigint, mutate: boolean) => {
      const q = env.read(queue, getQueueDecoder());
      const clock = env.svm.client.getClock();
      clock.unixTimestamp = q.current.closeTs;
      env.svm.client.setClock(clock);
      const accounts = new Set<Address>([
        w.vault,
        w.vaultUsdc,
        depositQueue,
        payable,
        shareMint,
        shareClaims,
        shareEscrow,
      ]);
      const before = snapshot(env, accounts);
      const record = await pda("epoch", epoch);
      await sendIxs(env, env.keeper, [
        await getStrikeEpochInstructionAsync({
          caller: env.keeper,
          record,
          usdcMint: USDC_MINT,
          eventAuthority: env.eventAuthority,
          program: P,
        }),
      ]);
      const expected = expectStrike({
        params: p,
        current: { deposits: q.current.deposits, withdrawShares: q.current.withdrawShares },
        nextLive: q.next.live,
        vault: w.vault,
        vaultUsdc: w.vaultUsdc,
        depositQueue,
        payable,
        shareMint,
        shareClaims,
        shareEscrow,
        mint: USDC_MINT,
        before,
      });
      const moved = seen(before, snapshot(env, accounts), w.vault, []);
      expect(mismatches(expected, moved)).toEqual([]);
      if (mutate) {
        expect(mismatches(off(expected, "usdc", payable, 1n), moved)).toHaveLength(1);
        const shares = {
          ...expected,
          vault: { ...expected.vault, totalShares: expected.vault.totalShares + 1n },
        };
        expect(mismatches(shares, moved)).toHaveLength(1);
      }
      return { record, expected };
    };
    const first = await deposit(200n * USDC);
    const s1 = await strike(first, false);
    await sendIxs(env, env.keeper, [
      await getClaimDepositInstructionAsync({
        caller: env.keeper,
        request: await pda("deposit", first, lp.address),
        owner: lp.address,
        record: s1.record,
        ownerShares: lpShares,
        rentReceiver: queue,
        eventAuthority: env.eventAuthority,
        program: P,
      }),
    ]);
    expect(env.balance(lpShares)).toBe(s1.expected.minted);
    const second = await deposit(50n * USDC);
    await sendIxs(env, lp, [
      await getRequestWithdrawInstructionAsync({
        owner: lp,
        ownerShares: lpShares,
        usdcMint: USDC_MINT,
        request: await pda("withdraw", second, lp.address),
        eventAuthority: env.eventAuthority,
        program: P,
        shares: p.minWithdrawShares,
      }),
    ]);
    const s2 = await strike(second, true);
    expect(s2.expected.paid).toBeGreaterThan(0n);
    expect(s2.expected.burnt).toBe(p.minWithdrawShares);
  });
});

describe("the event reader", () => {
  const program = FADE_PROGRAM_ADDRESS;
  const authority = "Ev1ntAuthor1ty111111111111111111111111111111" as Address;
  const other = "11111111111111111111111111111111" as Address;
  const body = new Uint8Array(
    getRoundExpiredEventEncoder().encode({
      version: 1,
      round: other,
      requested: false,
      requestFound: false,
      checked: true,
      tickets: 1,
      forfeited: 7n,
      drawCost: 0n,
      refund: 0n,
      side: 0,
      generation: 0,
      forfeitsWithheld: 0n,
      refunded: false,
    }),
  );
  const data = (tag: Uint8Array) => getBase58Decoder().decode(new Uint8Array([...tag, ...body]));
  const tx = (programIdIndex: number, account: number, tag = EVENT_IX_TAG): JsonTransaction => ({
    transaction: { message: { accountKeys: [other, program, authority] } },
    meta: {
      fee: 0n,
      innerInstructions: [
        { instructions: [{ programIdIndex, accounts: [account], data: data(tag) }] },
      ],
    },
  });
  it("reads an event the program emitted through its event authority", () => {
    expect(
      emittedEvents(tx(1, 2), program, authority, ROUND_EXPIRED_EVENT_DISCRIMINATOR),
    ).toHaveLength(1);
    expect(roundExpiredEvent(tx(1, 2), program, authority).forfeited).toBe(7n);
  });
  it("ignores the same bytes sent to another program, signed by another account, or untagged", () => {
    const d = ROUND_EXPIRED_EVENT_DISCRIMINATOR;
    expect(emittedEvents(tx(0, 2), program, authority, d)).toHaveLength(0);
    expect(emittedEvents(tx(1, 0), program, authority, d)).toHaveLength(0);
    expect(emittedEvents(tx(1, 2, new Uint8Array(8)), program, authority, d)).toHaveLength(0);
    expect(() => roundExpiredEvent(tx(0, 2), program, authority)).toThrow(/0 RoundExpired/);
  });
});

describe("the share books at the end of a run", () => {
  const a = (n: number) => `${"1".repeat(31)}${n}` as Address;
  const integrator = (n: number, owed: bigint, receives: boolean): IntegratorShares => ({
    address: a(n),
    authority: a(n + 5),
    appSharesAccrued: owed,
    shareAccountReceives: receives,
  });
  const vault = (owed: bigint) => ({
    beaconSharesHeld: 0n,
    protocolSharesAccrued: 0n,
    appSharesOwed: owed,
  });

  it("reports this run's integrator left owed after its share account was closed (the first run)", () => {
    // Run 1: claim_shares skipped, the sweep closed the share accounts: 25 920 owed for good.
    const run = new Set([a(6), a(7), a(8)]);
    const left = [
      integrator(1, 7_776n, false),
      integrator(2, 7_776n, false),
      integrator(3, 10_368n, false),
    ];
    expect(shareBookMismatches(vault(25_920n), left, run, 0n)).toHaveLength(4);
  });
  it("accepts shares stranded before the run, and nothing more", () => {
    const stranded = [integrator(1, 25_920n, false)];
    expect(shareBookMismatches(vault(25_920n), stranded, new Set(), 25_920n)).toEqual([]);
    // Claimable shares left unclaimed, or the books not adding up, are reported.
    expect(
      shareBookMismatches(vault(25_920n), [integrator(1, 25_920n, true)], new Set(), 25_920n),
    ).toHaveLength(1);
    expect(shareBookMismatches(vault(25_921n), stranded, new Set(), 25_920n)).toHaveLength(2);
    expect(
      shareBookMismatches(
        { ...vault(25_920n), protocolSharesAccrued: 1n },
        stranded,
        new Set(),
        25_920n,
      ),
    ).toHaveLength(1);
    expect(
      shareBookMismatches(
        { ...vault(25_920n), beaconSharesHeld: 1n },
        stranded,
        new Set(),
        25_920n,
      ),
    ).toHaveLength(1);
  });
  it("keeps an integrator's share account open while it is owed", () => {
    const owed = [integrator(1, 1n, true), integrator(2, 0n, true)];
    expect(mayCloseShareAccount(a(6), owed)).toBe(false);
    expect(mayCloseShareAccount(a(7), owed)).toBe(true);
    expect(mayCloseShareAccount(a(9), owed)).toBe(true);
  });
});

describe("what the sweep keeps", () => {
  const a = (n: number) => `${"1".repeat(30)}${String(n).padStart(2, "1")}` as Address;
  const [payer, funder, benefOwner, refundOwner, authority, sponsorKey, rentPayer, stranger] = [
    a(21),
    a(22),
    a(23),
    a(24),
    a(25),
    a(26),
    a(27),
    a(28),
  ] as Address[];
  const [ticket, benef, refundTo, integrator, record, roundA] = [
    a(31),
    a(32),
    a(33),
    a(34),
    a(35),
    a(36),
  ] as Address[];
  const open = {
    rounds: [{ address: roundA!, data: { rentPayer: rentPayer! } }],
    tickets: [
      {
        address: ticket!,
        data: {
          payer: payer!,
          funder: funder!,
          refundTo: refundTo!,
          beneficiary: benef!,
          integrator: integrator!,
        },
      },
    ],
    sponsorships: [{ address: record!, data: { sponsor: sponsorKey! } }],
    integratorAuthority: new Map([[integrator!, authority!]]),
    tokenOwner: new Map([
      [benef!, benefOwner!],
      [refundTo!, refundOwner!],
    ]),
  };
  const nothingOwed: IntegratorShares[] = [
    {
      address: integrator!,
      authority: authority!,
      appSharesAccrued: 0n,
      shareAccountReceives: true,
    },
  ];

  it("keeps every wallet an open ticket, round or sponsorship names, though no share is accrued", () => {
    const refs = openReferences(open);
    for (const wallet of [payer, funder, benefOwner, refundOwner, authority, sponsorKey, rentPayer])
      expect(sweepHolds(wallet!, nothingOwed, refs).length).toBeGreaterThan(0);
    // The integrator of an open ticket, with nothing accrued yet: kept (its app share will accrue).
    expect(mayCloseShareAccount(authority!, nothingOwed)).toBe(true);
    expect(sweepHolds(authority!, nothingOwed, refs)).toEqual([
      `integrator authority of ${ticket}`,
    ]);
    expect(sweepHolds(stranger!, nothingOwed, refs)).toEqual([]);
  });
  it("releases a wallet once nothing open names it", () => {
    const none = openReferences({
      rounds: [],
      tickets: [],
      sponsorships: [],
      integratorAuthority: new Map(),
      tokenOwner: new Map(),
    });
    expect(sweepHolds(payer!, nothingOwed, none)).toEqual([]);
    expect(sweepHolds(authority!, [{ ...nothingOwed[0]!, appSharesAccrued: 1n }], none)).toEqual([
      "integrator owed app shares",
    ]);
  });
});
