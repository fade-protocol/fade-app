// Round-level helpers: which round a join lands in and the pair of round
// accounts it passes (Spec 08 §13.5.2, round resolution), the sponsorship
// that pays a round at once (a lone ticket's own, or a sponsor's that
// completes a draw), and the instructions whose accounts come from state
// (the draw request's ORAO address, the expiry's randomness account, a
// return's or a reclaim's stored keys and rent payer, the sweep of a
// round's `round_vrf`). Every builder wraps the generated one and only
// fills accounts and amounts the program would otherwise refuse; it
// re-checks nothing the program does not.
import { type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import {
  FADE_PROGRAM_ADDRESS,
  RoundStatus,
  RoundTicketStatus,
  findIntegratorPda,
  findRoundVrfPda,
  findSponsorshipPda,
  getExpireRoundInstructionAsync,
  getJoinRoundInstructionAsync,
  getRecordRoundEntropyInstruction,
  getReclaimSponsorshipInstructionAsync,
  getRefundRoundInstructionAsync,
  getRequestRoundDrawInstructionAsync,
  getReturnRoundTicketInstructionAsync,
  getSponsorRoundInstructionAsync,
  getSweepRoundVrfInstructionAsync,
  getClaimRoundPayoutInstructionAsync,
  type Round,
  type RoundTicket,
  type RiskParams,
  type Sponsorship,
  type Vault,
} from "../generated/fade/index.ts";
import { ORAO_VRF_PROGRAM_ADDRESS, USAGE_SCALE } from "./constants.ts";
import { firstSlotAfter, firstSlotAfterRetained, oraoRandomness, roundSeed } from "./entropy.ts";
import {
  acceptsJoins,
  inRequestWindow,
  isExpired,
  prefund,
  refundFrom,
  refundOpen,
  requestFits,
  roundTerms,
  sponsorshipToPay,
  type Terms,
} from "./math.ts";
import { findEventAuthorityPda, findOraoRequestPda, findRoundPda } from "./pdas.ts";

type ProgramConfig = { programAddress?: Address };
const programOf = (c: ProgramConfig) => c.programAddress ?? FADE_PROGRAM_ADDRESS;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;

/** A decoded account and its address. */
export type Held<T> = { address: Address; data: T };

/** A round takes joins while `Accepting`, or `Paid` before its close slot. */
export function roundAcceptsJoins(round: Round, slot: bigint): boolean {
  if (round.status === RoundStatus.Accepting) return true;
  return round.status === RoundStatus.Paid && acceptsJoins(slot, round.closeSlot);
}

export type JoinTarget = {
  /** The `round` account to pass: the accepting round read, or the next id if none. */
  round: Address;
  /** The `next_round` account to pass: its successor. */
  nextRound: Address;
  /** The id of the round the join lands in if nothing changes before it lands. */
  landsIn: bigint;
  /** Whether that join creates the round (and advances its rent). */
  creates: boolean;
};

/**
 * Whether a join using `usage` (`USAGE_SCALE` fixed point) fits a `Paid`
 * round: `U + usage ≤ k × USAGE_SCALE`. The program sends a join a paid
 * round has no room for to the next round instead of refusing it. A join
 * must also be within its own share of the paid round (`withinJoinShare`);
 * one that is not would be refused by the next round too, so it does not
 * change where a join that lands lands.
 */
export function paidRoundHasRoom(round: Round, usage: bigint): boolean {
  return round.usage + usage <= BigInt(round.roundK) * USAGE_SCALE;
}

/**
 * The round pair a join passes, from the vault and the accepting round it
 * read at `slot` (null if `accepting_round` is 0 or its account is gone).
 * With `round` = the accepting round and `next_round` = its successor, the
 * join lands whether nothing changed, the accepting round closed or had no
 * room for it and this join opens the next, or another join opened the
 * next first. `usage` is the join's capacity usage if the client knows it
 * (`TicketJoined.usage` of a like ticket, or `usage(liability, cap)`); left
 * out, a paid round is predicted to take the join unless it is full to the
 * unit. It only decides `landsIn`, hence the sponsorship record a join
 * carrying sponsorship names: the program picks the round itself.
 */
export async function resolveJoinRound(
  vault: Pick<Vault, "acceptingRound" | "nextRoundId">,
  accepting: Round | null,
  slot: bigint,
  config: ProgramConfig = {},
  usage: bigint = 1n,
): Promise<JoinTarget> {
  const a = vault.acceptingRound;
  const m = vault.nextRoundId;
  const n = a !== 0n ? a : m;
  if (a !== 0n && accepting && accepting.id !== a) {
    throw new Error(`the accepting round read is ${accepting.id}, the vault says ${a}`);
  }
  const takes =
    accepting !== null &&
    roundAcceptsJoins(accepting, slot) &&
    (accepting.status !== RoundStatus.Paid || paidRoundHasRoom(accepting, usage));
  const landsIn = a !== 0n && takes ? a : m;
  if (landsIn !== n && landsIn !== n + 1n) {
    // A vault whose next id is not the accepting round's successor: the
    // program would refuse the pair with `WrongRound`.
    throw new Error(`round ${landsIn} is neither ${n} nor ${n + 1n}`);
  }
  const [round] = await findRoundPda(n, config);
  const [nextRound] = await findRoundPda(n + 1n, config);
  return { round, nextRound, landsIn, creates: landsIn === m };
}

/**
 * The terms a round created now snapshots: the live threshold and `k`, and
 * `D_r` from ORAO's fee, a pending request's rent (`ORAO_PENDING_LEN` bytes
 * at the cluster's rent) and the request share.
 */
export function newRoundTerms(
  params: Pick<RiskParams, "beaconThreshold" | "roundK" | "crankRequestLamports">,
  oraoFee: bigint,
  pendingRent: bigint,
): Terms {
  return {
    threshold: params.beaconThreshold,
    drawMax: prefund(oraoFee, pendingRent, params.crankRequestLamports),
    roundK: params.roundK,
  };
}

/**
 * The sponsorship a join of `price` carries to make its round paid at once
 * (a lone ticket, §13.5.2): `sponsorship_to_pay(R + price, S)` on the round
 * it lands in, or on a new round's terms if it creates one. If another join
 * lands first, the surplus comes back at settlement.
 */
export function lonePaySponsorship(
  target: JoinTarget,
  landing: Round | null,
  price: bigint,
  newTerms: Terms,
): bigint {
  if (target.creates || !landing) return sponsorshipToPay(newTerms, price, 0n);
  if (landing.status !== RoundStatus.Accepting) return 0n;
  return sponsorshipToPay(roundTerms(landing), landing.prices + price, landing.sponsorship);
}

type JoinInput = Parameters<typeof getJoinRoundInstructionAsync>[0];

/**
 * `join_round` with the round pair of `target`, and the sponsorship record
 * of the round it lands in when it carries a sponsorship. If the round
 * rotates between the read and the landing (it closed, or had no room for
 * the join), a join carrying a sponsorship fails on its record's seeds and
 * moves nothing: rebuild it and retry.
 */
export async function getBeaconJoinInstructionAsync(
  input: Omit<
    JoinInput,
    "round" | "nextRound" | "sponsorshipRecord" | "eventAuthority" | "program"
  >,
  target: JoinTarget,
  config: ProgramConfig = {},
): Promise<Instruction> {
  const programAddress = programOf(config);
  const sponsorship = BigInt(input.sponsorship);
  let sponsorshipRecord: Address | undefined;
  if (sponsorship > 0n) {
    const [landing] = await findRoundPda(target.landsIn, config);
    const payer = (input.payer as TransactionSigner).address;
    [sponsorshipRecord] = await findSponsorshipPda({ round: landing, sponsor: payer }, config);
  }
  const [eventAuthority] = await findEventAuthorityPda(config);
  return getJoinRoundInstructionAsync(
    {
      ...input,
      round: target.round,
      nextRound: target.nextRound,
      ...(sponsorshipRecord ? { sponsorshipRecord } : {}),
      eventAuthority,
      program: programAddress,
    },
    { programAddress },
  );
}

/**
 * The sponsorship that pays an `Accepting` round now (Spec 09 §5):
 * `ceil(D_r × (T_r − R) / T_r) − S`; 0 for any other round.
 */
export function sponsorshipToCompleteDraw(round: Round): bigint {
  if (round.status !== RoundStatus.Accepting) return 0n;
  return sponsorshipToPay(roundTerms(round), round.prices, round.sponsorship);
}

/**
 * `sponsor_round` with the lamports that pay `round` at once, or null when
 * nothing is missing or the amount is above `maxLamports` (an automatic
 * sponsor never pays more than it decided to, e.g. the round's fees).
 */
export async function getCompleteDrawInstructionAsync(
  sponsor: TransactionSigner,
  round: Held<Round>,
  options: { maxLamports?: bigint } & ProgramConfig = {},
): Promise<{ instruction: Instruction; lamports: bigint } | null> {
  const lamports = sponsorshipToCompleteDraw(round.data);
  if (lamports === 0n) return null;
  if (options.maxLamports !== undefined && lamports > options.maxLamports) return null;
  const config = { ...(options.programAddress ? { programAddress: options.programAddress } : {}) };
  const programAddress = programOf(config);
  const [sponsorship] = await findSponsorshipPda(
    { round: round.address, sponsor: sponsor.address },
    config,
  );
  const [eventAuthority] = await findEventAuthorityPda(config);
  const instruction = await getSponsorRoundInstructionAsync(
    {
      sponsor,
      round: round.address,
      sponsorship,
      eventAuthority,
      program: programAddress,
      lamports,
    },
    { programAddress },
  );
  return { instruction, lamports };
}

/** An account as a client read it: its address, its owner and its data. */
export type AccountRead = { address: Address; owner: Address; data: Uint8Array };

/**
 * A round whose ORAO request is fulfilled with a non-zero randomness: the
 * program refuses to forfeit it (`AlreadyFulfilled`). A paid round's request
 * is bound late with `getBeaconRequestDrawInstructionAsync`; a requested
 * round is settled.
 */
export class RoundDrawFulfilledError extends Error {
  readonly round: bigint;
  readonly request: Address;
  constructor(round: bigint, request: Address, requested: boolean) {
    super(
      requested
        ? `round ${round}'s draw is fulfilled: settle it, it does not expire`
        : `round ${round}'s request ${request} is fulfilled: late-bind it and settle, it does not expire`,
    );
    this.name = "RoundDrawFulfilledError";
    this.round = round;
    this.request = request;
  }
}

/**
 * Whether a round's seed and entropy slot are recorded on it
 * (`Round::entropy_recorded`): by `record_round_entropy`, by its request, or
 * by nothing yet. `s*` follows the close, so a recorded entropy slot is
 * never 0. Once recorded, its ORAO request address no longer depends on
 * SlotHashes.
 */
export function entropyRecorded(r: Round): boolean {
  return r.entropySlot !== 0n;
}

/**
 * The ORAO request a round's draw request or expiry names, for a client to
 * read before it builds either: the stored request once requested; for a
 * paid round, ORAO's address for its recorded seed, whatever SlotHashes
 * holds, or, never recorded, for the seed SlotHashes proves
 * (`first_after_retained(close_slot)`); null when neither (the program then
 * reads no request: the round can no longer be bound, and its expiry
 * refunds it).
 */
export async function roundRequestAddress(
  round: Held<Round>,
  slotHashes: Uint8Array,
  config: ProgramConfig = {},
): Promise<{ request: Address; seed: Uint8Array | null } | null> {
  const r = round.data;
  if (r.status === RoundStatus.Requested) return { request: r.randomness, seed: null };
  if (r.status !== RoundStatus.Paid)
    throw new Error("only a paid or requested round has a request");
  const seed = await paidRoundSeed(round, slotHashes, config);
  if (!seed) return null;
  const [request] = await findOraoRequestPda(seed);
  return { request, seed };
}

/** A paid round's seed as the program finds it: recorded, else proven by SlotHashes, else null. */
async function paidRoundSeed(
  round: Held<Round>,
  slotHashes: Uint8Array,
  config: ProgramConfig,
): Promise<Uint8Array | null> {
  const r = round.data;
  if (entropyRecorded(r)) return new Uint8Array(r.seed);
  const entropy = firstSlotAfterRetained(slotHashes, r.closeSlot);
  if (!entropy) return null;
  return roundSeed(programOf(config), round.address, r.closeSlot, entropy);
}

/**
 * `record_round_entropy` for a paid round whose seed is not recorded yet,
 * while SlotHashes proves its entropy slot (from `close_slot + 2`, for about
 * 512 slots): it writes the seed and nothing else, so that the round's ORAO
 * request is found from it whatever SlotHashes later holds (Spec 08
 * §13.5.6a). Null when there is nothing to record: the round not paid,
 * already recorded, or its entropy slot not proven (not yet, or no longer).
 * The program succeeds without writing on a round already recorded, so a
 * record raced by the request is harmless.
 */
export async function getBeaconRecordEntropyInstructionAsync(
  round: Held<Round>,
  slotHashes: Uint8Array,
  config: ProgramConfig = {},
): Promise<Instruction | null> {
  const r = round.data;
  if (r.status !== RoundStatus.Paid || entropyRecorded(r)) return null;
  if (!firstSlotAfterRetained(slotHashes, r.closeSlot)) return null;
  const programAddress = programOf(config);
  const [eventAuthority] = await findEventAuthorityPda(config);
  return getRecordRoundEntropyInstruction(
    { round: round.address, eventAuthority, program: programAddress },
    { programAddress },
  );
}

/** `read` is of `address`, or absent (null): a read of another account is stale. */
function readOf(read: AccountRead | null, address: Address | null): AccountRead | null {
  if (read !== null && read.address !== address) {
    throw new Error(`the account read is ${read.address}, the round's request is ${address}`);
  }
  return read;
}

/** Whether `read` is an ORAO request fulfilled with a non-zero randomness. */
function fulfilledNonZero(read: AccountRead | null): boolean {
  if (read === null || read.owner !== ORAO_VRF_PROGRAM_ADDRESS) return false;
  const parsed = oraoRandomness(read.data);
  return parsed !== null && parsed.fulfilled && parsed.randomness.some((b) => b !== 0);
}

/**
 * `request_round_draw` at the ORAO address of the round's seed: the recorded
 * one, or, never recorded, the one SlotHashes proves
 * (`first_after_retained(close_slot)`), as the program finds it. `request`
 * is the account at that address as read (see `roundRequestAddress`), null
 * if none: in the window, a request is funded there, or one someone created
 * through ORAO is bound; after the window (`slot > close_slot +
 * t_settle_slots`), only one ORAO already owns and fulfilled with a
 * non-zero randomness is bound, late, nothing funded (Spec 08 §13.5.6).
 * That late binding is the only way a paid round whose request someone
 * created and ORAO fulfilled is settled; with the seed recorded it has no
 * deadline. A round never recorded whose entropy slot SlotHashes no longer
 * proves (about 512 slots after the close) can no longer be bound, and its
 * expiry refunds it. A pending request, or one fulfilled with zero, is not
 * bound after the window: the round stays forfeitable either way, and
 * binding it would only pay the request share out of the tickets' prepays.
 * Throws where the program would refuse: outside the window without such a
 * request, or with no seed recorded nor proven.
 */
export async function getBeaconRequestDrawInstructionAsync(
  caller: TransactionSigner,
  round: Held<Round>,
  slot: bigint,
  slotHashes: Uint8Array,
  oraoTreasury: Address,
  request: AccountRead | null,
  config: ProgramConfig = {},
): Promise<{ instruction: Instruction; seed: Uint8Array; request: Address; late: boolean }> {
  const r = round.data;
  if (r.status !== RoundStatus.Paid) throw new Error("only a paid round's draw is requested");
  const preCreated = request !== null && request.owner === ORAO_VRF_PROGRAM_ADDRESS;
  const late = isExpired(slot, r.closeSlot, r.tSettleSlots);
  if (!inRequestWindow(slot, r.closeSlot, r.tSettleSlots) && !(late && preCreated)) {
    throw new Error(
      late
        ? `slot ${slot} is past round ${r.id}'s request window and no ORAO request exists to bind late`
        : `slot ${slot} is outside round ${r.id}'s request window`,
    );
  }
  const seed = await paidRoundSeed(round, slotHashes, config);
  if (!seed) {
    throw new Error(
      firstSlotAfter(slotHashes, r.closeSlot)
        ? `round ${r.id}'s entropy was never recorded and SlotHashes no longer proves it: it can no longer be bound, and its expiry refunds it`
        : `SlotHashes does not prove round ${r.id}'s entropy slot yet`,
    );
  }
  const programAddress = programOf(config);
  const [address] = await findOraoRequestPda(seed);
  readOf(request, address);
  if (preCreated && oraoRandomness(request.data) === null) {
    throw new Error(`the account at round ${r.id}'s request address is not an ORAO request`);
  }
  if (late && !fulfilledNonZero(request)) {
    throw new Error(
      `round ${r.id}'s ORAO request is not fulfilled with a randomness: past the window it is not bound; expire the round, or wait for its fulfilment and bind it then`,
    );
  }
  const [eventAuthority] = await findEventAuthorityPda(config);
  const instruction = await getRequestRoundDrawInstructionAsync(
    {
      caller,
      round: round.address,
      oraoTreasury,
      request: address,
      eventAuthority,
      program: programAddress,
    },
    { programAddress },
  );
  return { instruction, seed, request: address, late };
}

/**
 * `expire_round` with the randomness account the program checks: the
 * stored request if requested; if not, ORAO's address for the recorded
 * seed, or, never recorded, for the seed SlotHashes proves, so that a
 * request someone created and nobody bound is found; any account when
 * neither (none is read, and the program refunds the round rather than
 * forfeit it). `request` is the account `roundRequestAddress` names, as
 * read (null if absent or if it names none). A request fulfilled with a
 * non-zero randomness throws `RoundDrawFulfilledError`, as the program
 * refuses it (`AlreadyFulfilled`): a requested round is settled, a paid one
 * bound late then settled.
 */
export async function getBeaconExpireInstructionAsync(
  caller: TransactionSigner,
  round: Held<Round>,
  slot: bigint,
  slotHashes: Uint8Array,
  request: AccountRead | null,
  config: ProgramConfig = {},
): Promise<Instruction> {
  const r = round.data;
  if (r.status !== RoundStatus.Paid && r.status !== RoundStatus.Requested) {
    throw new Error("only a paid or requested round expires");
  }
  if (!isExpired(slot, r.closeSlot, r.tSettleSlots))
    throw new Error(`round ${r.id} has not expired`);
  const programAddress = programOf(config);
  const named = await roundRequestAddress(round, slotHashes, config);
  const randomness: Address = named?.request ?? SYSTEM_PROGRAM;
  const read = readOf(request, named?.request ?? null);
  if (fulfilledNonZero(read)) {
    throw new RoundDrawFulfilledError(r.id, randomness, r.status === RoundStatus.Requested);
  }
  const [eventAuthority] = await findEventAuthorityPda(config);
  return getExpireRoundInstructionAsync(
    { caller, round: round.address, randomness, eventAuthority, program: programAddress },
    { programAddress },
  );
}

/**
 * What makes `caller` a participant of a round, which `refund_round` asks
 * for: a ticket of the round it paid for, funded, or issued as integrator.
 * A sponsorship is not one (any amount makes a record, one lamport would
 * make anyone a participant); a sponsor gets its whole amount back from a
 * refund by anyone else.
 */
export type RefundProof = { ticket: Held<RoundTicket> };

/**
 * ORAO's live fee and a pending request's rent, read by the client: a round
 * whose draw no longer fits its prefund at them (`requestFits`) can never be
 * paid, and anyone may refund it once its window is open.
 */
export type LiveDrawCost = { oraoFee: bigint; pendingRent: bigint };

/**
 * Whether round `r`'s draw no longer fits its prefund at the live cost: ORAO's
 * fee has risen by more than the one fee of margin `draw_max` holds, so
 * `join_round`, `sponsor_round` and `request_round_draw` all refuse it
 * (`DrawUnderfunded`) and a refund is its only end.
 */
export function roundDrawDoomed(
  r: Pick<Round, "requestShare" | "drawMax">,
  live: LiveDrawCost,
): boolean {
  return !requestFits(live.oraoFee, live.pendingRent, r.requestShare, r.drawMax);
}

/**
 * `refund_round` of an `Accepting` round (never paid) once its refund window
 * is open at `slot`: `refund_slots` after its latest join (Spec 08 §13.5.5
 * as built), so a round still gathering tickets is never refundable. A
 * participant sends it, showing `proof`; with `proof` null, anyone may send
 * it for a round whose draw no longer fits its prefund at `live`, the cost
 * the program reads from ORAO's network state at the same instant (refused
 * `NotRoundParticipant` if the fee fell back first). Nobody is paid for it.
 * It moves nothing; each ticket's `return_round_ticket` then pays its price
 * back.
 */
export async function getBeaconRefundInstructionAsync(
  caller: TransactionSigner,
  round: Held<Round>,
  slot: bigint,
  proof: RefundProof | null,
  config: ProgramConfig = {},
  live?: LiveDrawCost,
): Promise<Instruction> {
  const r = round.data;
  if (r.status !== RoundStatus.Accepting) throw new Error("only an unpaid round is refunded");
  if (!refundOpen(slot, refundFrom(r), r.refundSlots))
    throw new Error(`round ${r.id}'s refund window is not open`);
  const programAddress = programOf(config);
  const [eventAuthority] = await findEventAuthorityPda(config);
  if (proof === null) {
    if (!live || !roundDrawDoomed(r, live))
      throw new Error(`round ${r.id}'s draw still fits: only a participant refunds it`);
    // The participant account is not read for a doomed round: the round itself.
    return getRefundRoundInstructionAsync(
      {
        caller,
        round: round.address,
        participant: round.address,
        eventAuthority,
        program: programAddress,
      },
      { programAddress },
    );
  }
  const t = proof.ticket.data;
  if (t.round !== r.id) throw new Error("the ticket is not of this round");
  const [integrator] = await findIntegratorPda({ integratorAuthority: caller.address }, config);
  if (t.payer !== caller.address && t.funder !== caller.address && t.integrator !== integrator)
    throw new Error("the caller is neither the ticket's payer, funder nor integrator");
  const participant = proof.ticket.address;
  return getRefundRoundInstructionAsync(
    { caller, round: round.address, participant, eventAuthority, program: programAddress },
    { programAddress },
  );
}

/**
 * `return_round_ticket` for a ticket of a refunded or forfeited round, its
 * accounts from the ticket's stored keys. The round's rent payer is always
 * passed: the program reads it only when this return closes the round, and
 * which return is the last is decided by the order they land in, not by the
 * state a client read.
 */
export async function getBeaconReturnInstructionAsync(
  caller: TransactionSigner,
  round: Held<Round>,
  ticket: Held<RoundTicket>,
  usdcMint: Address,
  config: ProgramConfig = {},
): Promise<Instruction> {
  const t = ticket.data;
  if (t.status !== RoundTicketStatus.Joined) throw new Error("only a joined ticket is returned");
  if (t.round !== round.data.id) throw new Error("the ticket is not of this round");
  const programAddress = programOf(config);
  const [eventAuthority] = await findEventAuthorityPda(config);
  return getReturnRoundTicketInstructionAsync(
    {
      caller,
      round: round.address,
      integrator: t.integrator,
      ticket: ticket.address,
      payer: t.payer,
      refundTo: t.refundTo,
      usdcMint,
      rentPayer: round.data.rentPayer,
      eventAuthority,
      program: programAddress,
    },
    { programAddress },
  );
}

/**
 * `reclaim_sponsorship` of a drawn, forfeited or refunded round, with the
 * round's rent payer, for the same reason as a return.
 */
export async function getBeaconReclaimInstructionAsync(
  caller: TransactionSigner,
  round: Held<Round>,
  sponsorship: Held<Sponsorship>,
  config: ProgramConfig = {},
): Promise<Instruction> {
  const programAddress = programOf(config);
  const [eventAuthority] = await findEventAuthorityPda(config);
  return getReclaimSponsorshipInstructionAsync(
    {
      caller,
      round: round.address,
      sponsorship: sponsorship.address,
      sponsor: sponsorship.data.sponsor,
      rentPayer: round.data.rentPayer,
      eventAuthority,
      program: programAddress,
    },
    { programAddress },
  );
}

/**
 * Whether `sweep_round_vrf` has something to move for a round whose
 * `round_vrf` holds `vrfLamports`: any lamport, unless the round is
 * `Requested` (refused: what `round_vrf` holds then is the refund its first
 * settlement or expiry deducts from the draw cost). `round` is the round as
 * read, null once it has closed.
 */
export function roundVrfSweepable(
  round: Pick<Round, "status"> | null,
  vrfLamports: bigint,
): boolean {
  return vrfLamports > 0n && (round === null || round.status !== RoundStatus.Requested);
}

/**
 * `sweep_round_vrf` of round `id` (Spec 08 §13.5.8a): whatever reached its
 * `round_vrf` after its last drain, ORAO's refund for a request it fulfilled
 * after the round forfeited above all. Into the round while it exists, whose
 * close pays it to its rent payer; to `caller` once the round has closed.
 * `round` is the round as read, null once closed; a `Requested` one throws,
 * as the program refuses it (`WrongRoundStatus`). Nothing to sweep succeeds
 * without moving anything, so the sweep can be packed ahead of a round's
 * last return or reclaim: there, it reaches the round before the close.
 */
export async function getBeaconSweepVrfInstructionAsync(
  caller: TransactionSigner,
  id: bigint,
  round: Pick<Round, "status"> | null,
  config: ProgramConfig = {},
): Promise<Instruction> {
  if (id <= 0n) throw new Error("round ids start at 1");
  if (round?.status === RoundStatus.Requested)
    throw new Error(`round ${id} is requested: its round_vrf is its draw's refund`);
  const programAddress = programOf(config);
  const [eventAuthority] = await findEventAuthorityPda(config);
  return getSweepRoundVrfInstructionAsync(
    { caller, roundId: id, eventAuthority, program: programAddress },
    { programAddress },
  );
}

/** `claim_round_payout` of a parked ticket, to the destination its status names. */
export async function getBeaconClaimPayoutInstructionAsync(
  caller: TransactionSigner,
  ticket: Held<RoundTicket>,
  usdcMint: Address,
  config: ProgramConfig = {},
): Promise<Instruction> {
  const t = ticket.data;
  let destination: Address;
  if (t.status === RoundTicketStatus.PayoutParked) destination = t.beneficiary;
  else if (t.status === RoundTicketStatus.ReturnParked) destination = t.refundTo;
  else throw new Error("only a parked ticket is claimed");
  const programAddress = programOf(config);
  const [eventAuthority] = await findEventAuthorityPda(config);
  return getClaimRoundPayoutInstructionAsync(
    {
      caller,
      ticket: ticket.address,
      destination,
      payer: t.payer,
      usdcMint,
      eventAuthority,
      program: programAddress,
    },
    { programAddress },
  );
}

/** Round `id`'s account and its `round_vrf`. */
export async function roundAccounts(id: bigint, config: ProgramConfig = {}) {
  const [round] = await findRoundPda(id, config);
  const [roundVrf] = await findRoundVrfPda({ round }, config);
  return { round, roundVrf };
}
