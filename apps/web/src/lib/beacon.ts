// The small-ticket demo on the shared beacon (Spec 09): one 0.10 USDC ticket
// joins the round accepting tickets with the sponsorship that pays its draw
// (a lone ticket, Spec 08 §13.5.2), waits for the round's close tick, and is
// paid out from the round's one ORAO draw. A keeper normally requests the draw
// and pays the tickets out; the wallet can send those steps itself, and every
// transaction is simulated before the wallet is asked to sign (lib/tx.ts).
//
// Everything here reads through an `AccountReader`, so the same code runs in
// the app (over the RPC) and in the tests (over litesvm). Every account a
// builder names comes from the program's own state or from a PDA it derives;
// the program checks each one again, so a stale read can only make a
// transaction fail in simulation, never move anything else.
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  RoundStatus,
  RoundTicketStatus,
  findConfigPda,
  findIntegratorPda,
  findRoundTicketPda,
  findSponsorshipPda,
  findVaultPda,
  getConfigDecoder,
  getIntegratorDecoder,
  getIntegratorSize,
  getPayoutTableDecoder,
  getPayoutTableSize,
  getRegisterPayoutTableInstruction,
  getRoundDecoder,
  getRoundSize,
  getRoundTicketDecoder,
  getRoundTicketReturnedEventDecoder,
  getRoundTicketSettledEventDecoder,
  getRoundTicketSize,
  getSponsorshipDecoder,
  getSponsorshipSize,
  getVaultDecoder,
  ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR,
  ROUND_TICKET_SETTLED_EVENT_DISCRIMINATOR,
  type Config,
  type Integrator,
  type OutcomeArgs,
  type PayoutTable,
  type Round,
  type RoundTicket,
  type Sponsorship,
  type Vault,
} from "../../../../clients/js/src/generated/fade";
import {
  ORAO_PENDING_LEN,
  ORAO_VRF_PROGRAM_ADDRESS,
  SLOT_HASHES_SYSVAR,
  findEventAuthorityPda,
  findOraoNetworkStatePda,
  findPayoutTablePda,
  findRoundPda,
  getBeaconClaimPayoutInstructionAsync,
  getBeaconExpireInstructionAsync,
  getBeaconRefundInstructionAsync,
  getCompleteDrawInstructionAsync,
  getBeaconJoinInstructionAsync,
  getBeaconReclaimInstructionAsync,
  getBeaconRequestDrawInstructionAsync,
  getBeaconReturnInstructionAsync,
  inRequestWindow,
  isExpired,
  lonePaySponsorship,
  newRoundTerms,
  oraoNetworkState,
  oraoRandomness,
  predictSettlement,
  prepay,
  refundFrom,
  refundOpen,
  resolveJoinRound,
  roundAcceptsJoins,
  roundRandomness,
  roundRequestAddress,
  roundTerms,
  settleBase,
  settleInstruction,
  settlementUnits,
  type AccountRead,
  type Held,
  type JoinTarget,
} from "../../../../clients/js/src/beacon/index.ts";

/** The demo's ticket price: 0.10 USDC, the beacon's target minimum (Spec 09 §8). */
export const BEACON_TICKET_PRICE = 100_000n;

/**
 * The demo's payout table: one chance in two at 1.956 times the ticket, a
 * 2.2 % margin. The same table the devnet runs register: a join reuses its
 * account when the program holds it, and registers it otherwise.
 */
export const BEACON_PAYOUT_TABLE: readonly OutcomeArgs[] = [
  { p: 500_000_000n, m: 19_560n },
  { p: 500_000_000n, m: 0n },
];

/** The demo app keeps no share, as the other demos (`DEMO_APP_SHARE_BPS`). */
export const BEACON_APP_SHARE_BPS = 0n;

/** Compute units: measured joins and draw requests stay under 120 000 (Spec 08 §13.5). */
export const JOIN_UNITS = 200_000;
export const REQUEST_UNITS = 200_000;
/** `sponsor_round` creating its record and paying the round measures about 31 000 units. */
export const SPONSOR_UNITS = 60_000;
/** A reclaim, an expiry or a return each stays under 40 000. */
const SMALL_STEP_UNITS = 40_000;

/**
 * Reads accounts and the slot, from an RPC in the app and from litesvm in the
 * tests. `minContextSlot` asks for a node that has processed at least that
 * slot (the RPC refuses the read otherwise), so that a read made after a
 * confirmed transaction cannot come from a node that has not seen it.
 */
export type AccountReader = {
  /** Each account as read at one slot, null if it does not exist. */
  accounts(addresses: readonly Address[], minContextSlot?: bigint): Promise<(AccountRead | null)[]>;
  slot(minContextSlot?: bigint): Promise<bigint>;
  /** Lamports that keep an account of `space` bytes rent-exempt. */
  rent(space: number): Promise<bigint>;
  /** An account's lamports, 0 if it does not exist. */
  lamports(address: Address): Promise<bigint>;
};

/** The program the demo joins the beacon on, and its USDC mint. */
export type BeaconTarget = { program: Address; usdcMint: Address };

const cfgOf = (t: BeaconTarget) => ({ programAddress: t.program });

/**
 * `read` decoded if `owner` owns it; null if absent, or if it only holds
 * lamports someone sent to the address before it was created (anyone may
 * pre-fund a PDA, and the program creates its accounts over such lamports).
 * Data under another owner throws.
 */
function decodeOwned<T>(
  read: AccountRead | null,
  owner: Address,
  decode: (data: Uint8Array) => T,
  what: string,
): T | null {
  if (read === null) return null;
  if (read.owner !== owner) {
    if (read.data.length === 0) return null;
    throw new Error(`${what} ${read.address} is not owned by ${owner}`);
  }
  return decode(read.data);
}

const roundDecoder = getRoundDecoder();
const ticketDecoder = getRoundTicketDecoder();
const sponsorshipDecoder = getSponsorshipDecoder();
const decodeRound = (d: Uint8Array) => roundDecoder.decode(d);
const decodeTicket = (d: Uint8Array) => ticketDecoder.decode(d);
const decodeSponsorship = (d: Uint8Array) => sponsorshipDecoder.decode(d);

/** What a join is built from, read at one slot. */
export type BeaconSnapshot = {
  slot: bigint;
  config: Config;
  vault: Vault;
  /** The round `vault.accepting_round` names, if it still exists. */
  accepting: Held<Round> | null;
  oraoFee: bigint;
  pendingRent: bigint;
  payoutTable: Address;
  payoutTableExists: boolean;
  integrator: Held<Integrator> | null;
  /** The rents a join may front: ticket, round, sponsorship record, integrator, payout table. */
  rents: { ticket: bigint; round: bigint; sponsorship: bigint; integrator: bigint; table: bigint };
};

/** Reads everything a join of `owner` needs from the beacon's program. */
export async function readBeacon(
  reader: AccountReader,
  target: BeaconTarget,
  owner: Address,
  outcomes: readonly OutcomeArgs[] = BEACON_PAYOUT_TABLE,
): Promise<BeaconSnapshot> {
  const cfg = cfgOf(target);
  const [[config], [vault], [networkState], [payoutTable], [integrator]] = await Promise.all([
    findConfigPda(cfg),
    findVaultPda(cfg),
    findOraoNetworkStatePda(),
    findPayoutTablePda(outcomes, cfg),
    findIntegratorPda({ integratorAuthority: owner }, cfg),
  ]);
  const [
    slot,
    reads,
    pendingRent,
    ticketRent,
    roundRent,
    sponsorshipRent,
    integratorRent,
    tableRent,
  ] = await Promise.all([
    reader.slot(),
    reader.accounts([config, vault, networkState, payoutTable, integrator]),
    reader.rent(ORAO_PENDING_LEN),
    reader.rent(getRoundTicketSize()),
    reader.rent(getRoundSize()),
    reader.rent(getSponsorshipSize()),
    reader.rent(getIntegratorSize()),
    reader.rent(getPayoutTableSize()),
  ]);
  const [configRead, vaultRead, stateRead, tableRead, integratorRead] = reads;
  const configData = decodeOwned(
    configRead ?? null,
    target.program,
    (d) => getConfigDecoder().decode(d),
    "config",
  );
  const vaultData = decodeOwned(
    vaultRead ?? null,
    target.program,
    (d) => getVaultDecoder().decode(d),
    "vault",
  );
  if (!configData || !vaultData) throw new Error("the beacon's program is not initialised");
  const orao = decodeOwned(stateRead ?? null, ORAO_VRF_PROGRAM_ADDRESS, oraoNetworkState, "ORAO");
  if (!orao) throw new Error("ORAO's network state is not readable on this cluster");
  const table = decodeOwned(tableRead ?? null, target.program, (d) => d, "payout table");
  const integratorData = decodeOwned(
    integratorRead ?? null,
    target.program,
    (d) => getIntegratorDecoder().decode(d),
    "integrator",
  );
  let accepting: Held<Round> | null = null;
  if (vaultData.acceptingRound !== 0n) {
    const [address] = await findRoundPda(vaultData.acceptingRound, cfg);
    const [read] = await reader.accounts([address]);
    const data = decodeOwned(read ?? null, target.program, decodeRound, "round");
    if (data) accepting = { address, data };
  }
  return {
    slot,
    config: configData,
    vault: vaultData,
    accepting,
    oraoFee: orao.fee,
    pendingRent,
    payoutTable,
    payoutTableExists: table !== null,
    integrator: integratorData ? { address: integrator, data: integratorData } : null,
    rents: {
      ticket: ticketRent,
      round: roundRent,
      sponsorship: sponsorshipRent,
      integrator: integratorRent,
      table: tableRent,
    },
  };
}

/** A join, ready to simulate and sign; or the reason the program would refuse it. */
export type JoinPlan =
  | {
      ok: true;
      instructions: Instruction[];
      ticket: Address;
      round: bigint;
      target: JoinTarget;
      /**
       * Lamports the join carries to pay the round's draw at once
       * (`ROUND_PIN_SPONSORSHIP` if already paid).
       */
      sponsorship: bigint;
      /** Lamports the wallet fronts in all; most come back when the ticket is paid out. */
      fronted: bigint;
      /** Lamports that do not come back: the rents of a new integrator record or payout table. */
      kept: bigint;
    }
  | { ok: false; reason: "paused" | "min-price"; minPrice: bigint };

/**
 * The sponsorship a join carries when its round is already paid: one
 * lamport, so that the join always names the sponsorship record of the round
 * it expects. The program derives that record from the round it resolves
 * (`sponsorship_record`, `ConstraintSeeds` otherwise), so a join whose round
 * closed before it landed is refused in simulation and rebuilt, instead of
 * landing unpaid in the next round. The record's rent comes back with the
 * payout's reclaim; the lamport pays toward the draw.
 */
export const ROUND_PIN_SPONSORSHIP = 1n;

/** Pause flag of every ticket, direct and beacon (`PAUSE_TICKETS`, Spec 08 §13.3). */
export const PAUSE_TICKETS = 1 << 0;
/** Pause flag of the beacon's joins (`PAUSE_ROUNDS`, Spec 08 §13.3). */
export const PAUSE_ROUNDS = 1 << 3;

/**
 * The join of one ticket by `signer`, who is its own app (integrator), payer,
 * funder and beneficiary, as in the other demos. It carries the sponsorship
 * that makes its round paid at once, so the ticket never waits for others:
 * the round closes at its next tick and is drawn. If the payout table is not
 * registered yet, its registration goes first in the same transaction.
 */
export async function planJoin(
  s: BeaconSnapshot,
  target: BeaconTarget,
  signer: TransactionSigner,
  usdcAccount: Address,
  price: bigint = BEACON_TICKET_PRICE,
  outcomes: readonly OutcomeArgs[] = BEACON_PAYOUT_TABLE,
): Promise<JoinPlan> {
  const cfg = cfgOf(target);
  const params = s.config.params;
  // `join_round` refuses a join under either flag.
  if ((s.config.pauseFlags & (PAUSE_TICKETS | PAUSE_ROUNDS)) !== 0)
    return { ok: false, reason: "paused", minPrice: params.beaconMinPrice };
  const join = await resolveJoinRound(s.vault, s.accepting?.data ?? null, s.slot, cfg);
  const landing =
    !join.creates && s.accepting && roundAcceptsJoins(s.accepting.data, s.slot)
      ? s.accepting.data
      : null;
  // A round snapshots the minimum price at its creation (Spec 09 §3).
  const minPrice = landing ? landing.minPrice : params.beaconMinPrice;
  if (price < minPrice) return { ok: false, reason: "min-price", minPrice };
  const newTerms = newRoundTerms(params, s.oraoFee, s.pendingRent);
  const lone = lonePaySponsorship(join, landing, price, newTerms);
  const sponsorship = lone > 0n ? lone : ROUND_PIN_SPONSORSHIP;
  const terms = landing ? roundTerms(landing) : newTerms;
  const settleShare = landing ? landing.settleShare : params.crankRoundSettleLamports;
  const nonce = s.integrator?.data.nextNonce ?? 0n;
  const [integrator] = await findIntegratorPda({ integratorAuthority: signer.address }, cfg);
  const [ticket] = await findRoundTicketPda({ integrator, nonce }, cfg);
  const instructions: Instruction[] = [];
  let kept = 0n;
  if (!s.payoutTableExists) {
    const [eventAuthority] = await findEventAuthorityPda(cfg);
    instructions.push(
      getRegisterPayoutTableInstruction(
        {
          payer: signer,
          payoutTable: s.payoutTable,
          eventAuthority,
          program: target.program,
          outcomes: [...outcomes],
        },
        cfg,
      ),
    );
    kept += s.rents.table;
  }
  instructions.push(
    await getBeaconJoinInstructionAsync(
      {
        integratorAuthority: signer,
        payer: signer,
        funder: signer,
        funderUsdc: usdcAccount,
        ...(s.integrator ? {} : { shareAccount: usdcAccount }),
        beneficiary: usdcAccount,
        payoutTable: s.payoutTable,
        usdcMint: target.usdcMint,
        price,
        appShareBps: BEACON_APP_SHARE_BPS,
        nonce,
        sponsorship,
      },
      join,
      cfg,
    ),
  );
  if (!s.integrator) kept += s.rents.integrator;
  const fronted =
    s.rents.ticket +
    (join.creates ? s.rents.round : 0n) +
    (sponsorship > 0n ? s.rents.sponsorship + sponsorship : 0n) +
    prepay(terms, price) +
    settleShare +
    kept;
  return {
    ok: true,
    instructions,
    ticket,
    round: join.landsIn,
    target: join,
    sponsorship,
    fronted,
    kept,
  };
}

/** One ticket's round, as read at one slot. */
export type TicketWatch = {
  slot: bigint;
  round: Held<Round> | null;
  /** The ticket while it exists (joined or parked); null once paid out or returned. */
  ticket: Held<RoundTicket> | null;
  /** The wallet's sponsorship record on the round, until it is reclaimed. */
  sponsorship: Held<Sponsorship> | null;
  /**
   * The round's ORAO request, as read: the stored one once requested; for a
   * paid round past its window, the one at its seed's address, if any.
   */
  request: AccountRead | null;
};

/**
 * The ticket read is of another round than the one followed: a join whose
 * accepting round closed between the read and the landing lands in the next
 * round (Spec 08 §13.5.2), so the ticket's own round, stored by the program,
 * is the one to follow.
 */
export class TicketInOtherRoundError extends Error {
  readonly round: bigint;
  constructor(ticket: Address, expected: bigint, round: bigint) {
    super(`ticket ${ticket} is of round ${round}, not ${expected}`);
    this.name = "TicketInOtherRoundError";
    this.round = round;
  }
}

/**
 * Reads round `id`, `ticket` and `sponsor`'s record on that round at one
 * slot, from a node at `minContextSlot` or later when given. The round's ORAO
 * request is read too: the stored one once requested; for a paid round past
 * its window, the one at its seed's address while SlotHashes proves the
 * entropy slot, since one someone created and ORAO fulfilled is bound late,
 * not forfeited (Spec 08 §13.5.6).
 */
export async function readWatch(
  reader: AccountReader,
  target: BeaconTarget,
  id: bigint,
  ticket: Address,
  sponsor: Address,
  minContextSlot?: bigint,
): Promise<TicketWatch> {
  const cfg = cfgOf(target);
  const [roundAddress] = await findRoundPda(id, cfg);
  const [sponsorshipAddress] = await findSponsorshipPda({ round: roundAddress, sponsor }, cfg);
  const [slot, [r, t, sp]] = await Promise.all([
    reader.slot(minContextSlot),
    reader.accounts([roundAddress, ticket, sponsorshipAddress], minContextSlot),
  ]);
  const round = decodeOwned(r ?? null, target.program, decodeRound, "round");
  const tk = decodeOwned(t ?? null, target.program, decodeTicket, "ticket");
  const spn = decodeOwned(sp ?? null, target.program, decodeSponsorship, "sponsorship");
  if (tk && tk.round !== id) throw new TicketInOtherRoundError(ticket, id, tk.round);
  // A joined ticket keeps its round open (it closes with no ticket left, §13.2.2):
  // a read with the ticket and without its round is of two states, read again.
  if (tk && tk.status === RoundTicketStatus.Joined && !round)
    throw new Error(`round ${id} is missing from a read that holds its joined ticket`);
  let request: AccountRead | null = null;
  if (round && round.status === RoundStatus.Requested) {
    const [read] = await reader.accounts([round.randomness], minContextSlot);
    request = read ?? null;
  } else if (
    round &&
    round.status === RoundStatus.Paid &&
    isExpired(slot, round.closeSlot, round.tSettleSlots)
  ) {
    const [slotHashes] = await reader.accounts([SLOT_HASHES_SYSVAR], minContextSlot);
    const named = slotHashes
      ? await roundRequestAddress({ address: roundAddress, data: round }, slotHashes.data, cfg)
      : null;
    if (named) {
      const [read] = await reader.accounts([named.request], minContextSlot);
      request = read ?? null;
    }
  }
  return {
    slot,
    round: round ? { address: roundAddress, data: round } : null,
    ticket: tk ? { address: ticket, data: tk } : null,
    sponsorship: spn ? { address: sponsorshipAddress, data: spn } : null,
    request,
  };
}

/** Whether `request` is ORAO's and fulfilled with a non-zero randomness. */
export function isFulfilled(request: AccountRead | null): boolean {
  if (!request || request.owner !== ORAO_VRF_PROGRAM_ADDRESS) return false;
  const parsed = oraoRandomness(request.data);
  return parsed !== null && parsed.fulfilled && parsed.randomness.some((b) => b !== 0);
}

/** Where the ticket stands, from one `TicketWatch`. */
export type Stage =
  /** The round waits to be paid by more tickets or a sponsor. */
  | { kind: "waiting" }
  /**
   * The round was never paid and its refund window is open (`refund_slots`
   * after its latest join): it can be refunded, the ticket price back to the
   * wallet.
   */
  | { kind: "refundable" }
  /** Paid: the round closes at `closeSlot`, the next multiple of `tickSlots`. */
  | { kind: "closing"; closeSlot: bigint; slotsLeft: bigint; tickSlots: bigint }
  /**
   * Closed; the draw may be requested from `from` to `until`, or after
   * `until` by binding a request someone created and ORAO fulfilled.
   */
  | { kind: "closed"; from: bigint; until: bigint; canRequest: boolean }
  /** Requested within `T_SETTLE`; ORAO has not answered yet. */
  | { kind: "drawing" }
  /** Drawn (fulfilled, or the round's first ticket paid out): the ticket can be paid out. */
  | { kind: "drawn" }
  /** The ticket was paid out, or its payout is held for its beneficiary. */
  | { kind: "paid"; parked: boolean }
  /**
   * No draw in time: the round is forfeited (final), or can be (not final:
   * a request ORAO fulfils late is still bound or settled, and paid).
   */
  | { kind: "no-draw"; forfeited: boolean }
  /** The round was refunded (it was never paid): the ticket price comes back. */
  | { kind: "refunded" }
  /**
   * The ticket was returned, its ticket price held for its refund account
   * (which could not receive it then): it can be claimed.
   */
  | { kind: "refund-held" }
  /** The ticket is gone: paid out or returned, read from its transactions. */
  | { kind: "gone" };

export function stageOf(w: TicketWatch): Stage {
  const r = w.round?.data ?? null;
  const t = w.ticket?.data ?? null;
  if (t && t.status === RoundTicketStatus.PayoutParked) return { kind: "paid", parked: true };
  if (t && t.status === RoundTicketStatus.ReturnParked) return { kind: "refund-held" };
  if (!t) return { kind: "gone" };
  if (!r) return { kind: "gone" };
  switch (r.status) {
    case RoundStatus.Accepting:
      return refundOpen(w.slot, refundFrom(r), r.refundSlots)
        ? { kind: "refundable" }
        : { kind: "waiting" };
    case RoundStatus.Paid: {
      if (w.slot < r.closeSlot)
        return {
          kind: "closing",
          closeSlot: r.closeSlot,
          slotsLeft: r.closeSlot - w.slot,
          tickSlots: r.tickSlots,
        };
      if (isExpired(w.slot, r.closeSlot, r.tSettleSlots)) {
        // A request someone created at the round's seed and ORAO fulfilled is
        // bound late (`request_round_draw`), and the round paid out; the
        // expiry refuses it (`AlreadyFulfilled`).
        if (isFulfilled(w.request))
          return {
            kind: "closed",
            from: r.closeSlot + 2n,
            until: r.closeSlot + r.tSettleSlots,
            canRequest: true,
          };
        return { kind: "no-draw", forfeited: false };
      }
      return {
        kind: "closed",
        from: r.closeSlot + 2n,
        until: r.closeSlot + r.tSettleSlots,
        canRequest: inRequestWindow(w.slot, r.closeSlot, r.tSettleSlots),
      };
    }
    case RoundStatus.Requested:
      if (isFulfilled(w.request)) return { kind: "drawn" };
      // A request ORAO left pending (or fulfilled with zero) past T_SETTLE is
      // expirable as an unrequested one is (Spec 08 §13.5.8); the expiry
      // checks the request again, so a late fulfilment is paid, never lost.
      if (isExpired(w.slot, r.closeSlot, r.tSettleSlots))
        return { kind: "no-draw", forfeited: false };
      return { kind: "drawing" };
    case RoundStatus.Drawn:
      return { kind: "drawn" };
    case RoundStatus.Refunded:
      return { kind: "refunded" };
    case RoundStatus.Forfeited:
      return { kind: "no-draw", forfeited: true };
    default:
      return { kind: "gone" };
  }
}

/**
 * `request_round_draw` for the round of `w`, read from SlotHashes and ORAO's
 * network state as the program reads them.
 */
export async function planRequest(
  reader: AccountReader,
  target: BeaconTarget,
  signer: TransactionSigner,
  w: TicketWatch,
): Promise<Instruction> {
  if (!w.round) throw new Error("the round is gone");
  const cfg = cfgOf(target);
  const [networkState] = await findOraoNetworkStatePda();
  const [slotHashes, state] = await reader.accounts([SLOT_HASHES_SYSVAR, networkState]);
  if (!slotHashes) throw new Error("SlotHashes is not readable");
  const orao = decodeOwned(state ?? null, ORAO_VRF_PROGRAM_ADDRESS, oraoNetworkState, "ORAO");
  if (!orao) throw new Error("ORAO's network state is not readable on this cluster");
  const named = await roundRequestAddress(w.round, slotHashes.data, cfg);
  const [request] = named ? await reader.accounts([named.request]) : [null];
  const slot = await reader.slot();
  const built = await getBeaconRequestDrawInstructionAsync(
    signer,
    w.round,
    slot,
    slotHashes.data,
    orao.treasury,
    request ?? null,
    cfg,
  );
  return built.instruction;
}

/** The ticket's outcome, as the program computes it from the round's draw. */
export type Outcome = { index: number; payout: bigint };

/**
 * The ticket's outcome from the round's randomness: kept on a drawn round,
 * read from the fulfilled request before. `ticket` is the ticket as joined.
 */
export async function predictOutcome(
  reader: AccountReader,
  target: BeaconTarget,
  round: Held<Round>,
  request: AccountRead | null,
  ticket: Held<RoundTicket>,
): Promise<Outcome> {
  const randomness = roundRandomness(
    round.data,
    round.data.status === RoundStatus.Requested ? (request?.data ?? undefined) : undefined,
  );
  const [tableRead] = await reader.accounts([ticket.data.payoutTable]);
  const table = decodeOwned(
    tableRead ?? null,
    target.program,
    (d) => getPayoutTableDecoder().decode(d),
    "payout table",
  );
  if (!table) throw new Error("the ticket's payout table is gone");
  const tables = new Map<Address, PayoutTable>([[ticket.data.payoutTable, table]]);
  const joined = { ...ticket, data: { ...ticket.data, status: RoundTicketStatus.Joined } };
  const [item] = await predictSettlement(round, randomness, [joined], tables, cfgOf(target));
  if (!item) throw new Error("the ticket is not of this round");
  return { index: item.outcome, payout: item.payout };
}

/**
 * Pays out the wallet's own ticket (`settle_round_tickets` with one ticket,
 * its outcome predicted: a wrong prediction is refused, never paid), then
 * reclaims the wallet's sponsorship, whose unused part comes back. The
 * round's first payout finalises its draw, so the reclaim that follows in the
 * same transaction finds it drawn.
 */
export async function planPayout(
  reader: AccountReader,
  target: BeaconTarget,
  signer: TransactionSigner,
  w: TicketWatch,
): Promise<{ instructions: Instruction[]; units: number; outcome: Outcome }> {
  if (!w.round || !w.ticket) throw new Error("the round or the ticket is gone");
  if (w.ticket.data.status !== RoundTicketStatus.Joined)
    throw new Error("the ticket was already paid out");
  const cfg = cfgOf(target);
  const outcome = await predictOutcome(reader, target, w.round, w.request, w.ticket);
  const base = await settleBase(signer, w.round, target.usdcMint, cfg);
  const items = [{ ticket: w.ticket, outcome: outcome.index, payout: outcome.payout }];
  const instructions = [settleInstruction(base, items)];
  let units = settlementUnits(items);
  if (w.sponsorship) {
    instructions.push(await getBeaconReclaimInstructionAsync(signer, w.round, w.sponsorship, cfg));
    units += SMALL_STEP_UNITS;
  }
  return { instructions, units, outcome };
}

/**
 * A round without a draw in time: expired if not yet (the expiry checks that
 * no request was fulfilled for it), then the wallet's ticket returned (its
 * settlement share to the caller, its draw prepay to its payer) and its
 * sponsorship reclaimed. A refunded round's ticket is returned the same way,
 * its ticket price included; a round never paid whose refund window is open
 * is refunded first (`refund_round`), in the same transaction. `refund`
 * tells which end the close gives the ticket: its price back (a refund, an
 * already refunded round, or the expiry of a paid round whose request can no
 * longer be found, which refunds it), or none (a forfeiture).
 */
export async function planClose(
  reader: AccountReader,
  target: BeaconTarget,
  signer: TransactionSigner,
  w: TicketWatch,
): Promise<{ instructions: Instruction[]; units: number; refund: boolean }> {
  if (!w.round) throw new Error("the round is gone");
  const cfg = cfgOf(target);
  const instructions: Instruction[] = [];
  const r = w.round.data;
  let refund = r.status === RoundStatus.Accepting || r.status === RoundStatus.Refunded;
  if (r.status === RoundStatus.Paid || r.status === RoundStatus.Requested) {
    const [slotHashes] = await reader.accounts([SLOT_HASHES_SYSVAR]);
    if (!slotHashes) throw new Error("SlotHashes is not readable");
    const named = await roundRequestAddress(w.round, slotHashes.data, cfg);
    // A paid round whose seed was never recorded and is no longer proven:
    // the expiry refunds it (`refund_expired`) instead of forfeiting it.
    if (!named) refund = true;
    const [request] = named ? await reader.accounts([named.request]) : [null];
    instructions.push(
      await getBeaconExpireInstructionAsync(
        signer,
        w.round,
        await reader.slot(),
        slotHashes.data,
        request ?? null,
        cfg,
      ),
    );
  } else if (r.status === RoundStatus.Accepting) {
    // Refused by the builder before the window opens, `refund_slots` after
    // the round's latest join (the program checks it again); the wallet
    // shows its ticket as its part in the round. A sponsorship is no part:
    // a sponsor waits for a participant's refund, or for the draw.
    if (!w.ticket)
      throw new Error(
        "only a ticket's payer, funder or integrator can refund this round; a sponsorship is returned once it ends",
      );
    instructions.push(
      await getBeaconRefundInstructionAsync(
        signer,
        w.round,
        await reader.slot(),
        { ticket: w.ticket },
        cfg,
      ),
    );
  } else if (r.status !== RoundStatus.Forfeited && r.status !== RoundStatus.Refunded) {
    throw new Error("the round was drawn: its tickets are paid out, not returned");
  }
  if (w.ticket && w.ticket.data.status === RoundTicketStatus.Joined)
    instructions.push(
      await getBeaconReturnInstructionAsync(signer, w.round, w.ticket, target.usdcMint, cfg),
    );
  if (w.sponsorship)
    instructions.push(await getBeaconReclaimInstructionAsync(signer, w.round, w.sponsorship, cfg));
  if (instructions.length === 0) throw new Error("nothing left to close");
  return { instructions, units: SMALL_STEP_UNITS * instructions.length, refund };
}

/**
 * `sponsor_round` with what pays the wallet's unpaid round at once (Spec 09
 * §5), computed from the round as read; null if nothing is missing (the
 * round is no longer `Accepting`). If the round is paid meanwhile, the
 * sponsorship only lowers what its tickets are charged; whatever the draw
 * does not use comes back with the reclaim, which the payout carries.
 */
export async function planSponsor(
  target: BeaconTarget,
  signer: TransactionSigner,
  w: TicketWatch,
): Promise<{ instruction: Instruction; lamports: bigint } | null> {
  if (!w.round) throw new Error("the round is gone");
  return getCompleteDrawInstructionAsync(signer, w.round, { programAddress: target.program });
}

/** `reclaim_sponsorship` of the wallet's own record, once its round is drawn, forfeited or refunded. */
export async function planReclaim(
  target: BeaconTarget,
  signer: TransactionSigner,
  w: TicketWatch,
): Promise<Instruction> {
  if (!w.round || !w.sponsorship) throw new Error("no sponsorship left on the round");
  return getBeaconReclaimInstructionAsync(signer, w.round, w.sponsorship, cfgOf(target));
}

/**
 * `claim_round_payout` of the wallet's parked ticket: its payout, or its
 * returned ticket price, held while the destination could not receive.
 */
export async function planClaim(
  target: BeaconTarget,
  signer: TransactionSigner,
  w: TicketWatch,
): Promise<Instruction> {
  if (!w.ticket) throw new Error("the ticket is gone");
  return getBeaconClaimPayoutInstructionAsync(signer, w.ticket, target.usdcMint, cfgOf(target));
}

/** `sha256("anchor:event")[..8]`: the tag of every `emit_cpi!` payload. */
const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];

const startsWith = (data: Uint8Array, prefix: ArrayLike<number>, at = 0) => {
  if (data.length < at + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[at + i] !== prefix[i]) return false;
  return true;
};

/**
 * The `RoundTicketSettled` event of `ticket` in one inner instruction's
 * data, or null. The caller passes only inner instructions to the beacon
 * program, whose event authority alone can emit them.
 */
export function settledEventOf(
  data: Uint8Array,
  ticket: Address,
): { outcome: number; payout: bigint; parked: boolean } | null {
  if (
    !startsWith(data, EVENT_IX_TAG) ||
    !startsWith(data, ROUND_TICKET_SETTLED_EVENT_DISCRIMINATOR, 8)
  )
    return null;
  try {
    const e = getRoundTicketSettledEventDecoder().decode(data.subarray(8));
    if (e.ticket !== ticket) return null;
    return { outcome: e.outcome, payout: e.payout, parked: e.pending };
  } catch {
    return null;
  }
}

/**
 * The `RoundTicketReturned` event of `ticket` in one inner instruction's
 * data, or null: whether its close refunded the ticket price, and whether
 * that price waits in escrow. Read as `settledEventOf` is.
 */
export function returnedEventOf(
  data: Uint8Array,
  ticket: Address,
): { refunded: boolean; parked: boolean } | null {
  if (
    !startsWith(data, EVENT_IX_TAG) ||
    !startsWith(data, ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR, 8)
  )
    return null;
  try {
    const e = getRoundTicketReturnedEventDecoder().decode(data.subarray(8));
    if (e.ticket !== ticket) return null;
    return { refunded: e.refunded, parked: e.parked };
  } catch {
    return null;
  }
}
