// Settlement batches for `settle_round_tickets` (Spec 08 §13.5.7), without
// any address lookup table: each ticket's outcome predicted from the round's
// randomness, its group of accounts taken from its own stored keys, and the
// groups packed greedily into transactions that fit every limit of the
// chosen format: its size (4 096 bytes in v1, 1 232 in v0), the 64 account
// locks, `MAX_ROUND_BATCH`, the 64-instruction trace and the compute
// budget. The program checks every account against the ticket; nothing here
// is trusted by it.
import {
  AccountRole,
  type AccountMeta,
  type Address,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  FADE_PROGRAM_ADDRESS,
  MAX_ROUND_BATCH,
  RoundStatus,
  RoundTicketStatus,
  getSettleRoundTicketsInstructionAsync,
  getSettleRoundTicketsInstructionDataEncoder,
  type PayoutTable,
  type Round,
  type RoundTicket,
} from "../generated/fade/index.ts";
import { oraoRandomness, ticketOutcome } from "./entropy.ts";
import { findEventAuthorityPda } from "./pdas.ts";
import type { Held } from "./rounds.ts";
import {
  MAX_ACCOUNT_LOCKS,
  MAX_COMPUTE_UNITS,
  MAX_INSTRUCTION_TRACE,
  beaconTransactionMessage,
  measure,
  transactionSizeLimit,
  type Budget,
  type TransactionFormat,
} from "./transaction.ts";

type ProgramConfig = { programAddress?: Address };

/** A ticket to settle, with the outcome the round's randomness gives it. */
export type SettlementItem = {
  ticket: Held<RoundTicket>;
  outcome: number;
  payout: bigint;
};

/**
 * The round's 64-byte randomness: kept on the round once drawn, read from
 * the fulfilled ORAO request before the first settlement. Throws while the
 * request is pending, or if it is not the round's.
 */
export function roundRandomness(round: Round, request?: Uint8Array): Uint8Array {
  if (round.status === RoundStatus.Drawn) return new Uint8Array(round.drawnRandomness);
  if (round.status !== RoundStatus.Requested)
    throw new Error("the round is neither requested nor drawn");
  if (!request) throw new Error("the round's ORAO request is needed before its first settlement");
  const parsed = oraoRandomness(request);
  if (!parsed) throw new Error("the round's request does not parse");
  if (!parsed.fulfilled) throw new Error("the round's draw is not fulfilled yet");
  const seed = new Uint8Array(round.seed);
  if (!parsed.seed.every((b, i) => b === seed[i]))
    throw new Error("the request is not for the round's seed");
  if (parsed.randomness.every((b) => b === 0))
    throw new Error("the request was fulfilled with zero");
  return parsed.randomness;
}

/**
 * The outcome of every `Joined` ticket of `round` among `tickets`, as the
 * program will compute it. Tickets of other rounds and tickets already
 * settled are left out; a payout table missing from `tables` throws.
 */
export async function predictSettlement(
  round: Held<Round>,
  randomness: Uint8Array,
  tickets: readonly Held<RoundTicket>[],
  tables: ReadonlyMap<Address, PayoutTable>,
  config: ProgramConfig = {},
): Promise<SettlementItem[]> {
  const program = config.programAddress ?? FADE_PROGRAM_ADDRESS;
  const out: SettlementItem[] = [];
  for (const ticket of tickets) {
    const t = ticket.data;
    if (t.round !== round.data.id || t.status !== RoundTicketStatus.Joined) continue;
    const table = tables.get(t.payoutTable);
    if (!table) throw new Error(`payout table ${t.payoutTable} not loaded`);
    const { index, payout } = await ticketOutcome(
      program,
      round.address,
      ticket.address,
      randomness,
      table.outcomes.slice(0, table.len),
      t.price,
    );
    if (payout > t.payoutMax) throw new Error("a payout above the ticket's maximum");
    out.push({ ticket, outcome: index, payout });
  }
  return out;
}

/** One group's remaining accounts, in the program's order. */
function groupAccounts(item: SettlementItem): AccountMeta[] {
  const t = item.ticket.data;
  const metas: AccountMeta[] = [
    { address: item.ticket.address, role: AccountRole.WRITABLE },
    { address: t.integrator, role: AccountRole.WRITABLE },
    { address: t.payer, role: AccountRole.WRITABLE },
    { address: t.payoutTable, role: AccountRole.READONLY },
  ];
  if (item.payout > 0n) metas.push({ address: t.beneficiary, role: AccountRole.WRITABLE });
  return metas;
}

/** `wins`: bit `i` set when the `i`-th ticket's payout is non-zero. */
export function winsMask(items: readonly SettlementItem[]): number {
  if (items.length > MAX_ROUND_BATCH) throw new Error(`at most ${MAX_ROUND_BATCH} tickets a batch`);
  let wins = 0;
  items.forEach((it, i) => {
    if (it.payout > 0n) wins |= 1 << i;
  });
  return wins >>> 0;
}

/**
 * Compute units to request for a batch, from the units measured on
 * 14 October 2026 (Spec 08 §13.5.7) with margin: about 42 700 fixed at a
 * round's first settlement, 9 150 a ticket, 2 100 more a winner, 3 450 a
 * payout table reloaded; tests/ts/fade/beacon.test.ts checks it covers
 * what the program consumes.
 */
export function settlementUnits(items: readonly SettlementItem[]): number {
  let loads = 0;
  let last: Address | null = null;
  let winners = 0;
  for (const it of items) {
    if (it.ticket.data.payoutTable !== last) loads++;
    last = it.ticket.data.payoutTable;
    if (it.payout > 0n) winners++;
  }
  return Math.min(
    MAX_COMPUTE_UNITS,
    50_000 + 10_000 * items.length + 2_500 * winners + 4_000 * loads,
  );
}

/** The order settlement is cheapest in: by payout table (one load each), then integrator and payer. */
export function settlementOrder(items: readonly SettlementItem[]): SettlementItem[] {
  return [...items].sort((a, b) => {
    const x = a.ticket.data;
    const y = b.ticket.data;
    return (
      cmp(x.payoutTable, y.payoutTable) ||
      cmp(x.integrator, y.integrator) ||
      cmp(x.payer, y.payer) ||
      cmp(a.ticket.address, b.ticket.address)
    );
  });
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The fixed part of a batch: `settle_round_tickets` for one round, before its groups. */
export async function settleBase(
  caller: TransactionSigner,
  round: Held<Round>,
  usdcMint: Address,
  config: ProgramConfig = {},
): Promise<Instruction> {
  const programAddress = config.programAddress ?? FADE_PROGRAM_ADDRESS;
  const [eventAuthority] = await findEventAuthorityPda(config);
  return getSettleRoundTicketsInstructionAsync(
    {
      caller,
      round: round.address,
      randomness: round.data.randomness,
      usdcMint,
      // Always passed: the program reads it only in the batch that closes
      // the round, and which batch that is depends on the order batches
      // land in, which two keepers racing do not control.
      rentPayer: round.data.rentPayer,
      eventAuthority,
      program: programAddress,
      count: 1,
      wins: 0,
    },
    { programAddress },
  );
}

/** `base` with `items` as its groups, `count` and `wins` set from them. */
export function settleInstruction(
  base: Instruction,
  items: readonly SettlementItem[],
): Instruction {
  if (items.length === 0 || items.length > MAX_ROUND_BATCH) {
    throw new Error(`1 to ${MAX_ROUND_BATCH} tickets a batch`);
  }
  const seen = new Set<Address>();
  for (const it of items) {
    if (seen.has(it.ticket.address)) throw new Error("a ticket named twice in one batch");
    seen.add(it.ticket.address);
  }
  return {
    programAddress: base.programAddress,
    accounts: [...(base.accounts ?? []), ...items.flatMap(groupAccounts)],
    data: new Uint8Array(
      getSettleRoundTicketsInstructionDataEncoder().encode({
        count: items.length,
        wins: winsMask(items),
      }),
    ),
  };
}

export type SettlementBatch = {
  items: SettlementItem[];
  instruction: Instruction;
  /** The batch's transaction message, ready to sign once its lifetime is replaced. */
  message: ReturnType<typeof beaconTransactionMessage>;
  bytes: number;
  locks: number;
  units: number;
  /** Instructions the batch may run, its own and every CPI, at worst. */
  trace: number;
};

export type PlanOptions = {
  format: TransactionFormat;
  /** Lifetime the messages are built with; a keeper replaces it before signing. */
  lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint };
  /** v0: micro-lamports per unit; v1: the whole priority fee of each batch. */
  priority?: { microLamportsPerUnit?: bigint; priorityFeeLamports?: bigint };
  /** At most this many tickets a batch (default `MAX_ROUND_BATCH`). */
  maxTickets?: number;
};

function batchOf(
  caller: TransactionSigner,
  base: Instruction,
  items: SettlementItem[],
  options: PlanOptions,
): SettlementBatch {
  const instruction = settleInstruction(base, items);
  const units = settlementUnits(items);
  const budget: Budget = { computeUnitLimit: units };
  if (options.priority?.microLamportsPerUnit !== undefined) {
    budget.microLamportsPerUnit = options.priority.microLamportsPerUnit;
  }
  if (options.priority?.priorityFeeLamports !== undefined) {
    budget.priorityFeeLamports = options.priority.priorityFeeLamports;
  }
  const message = beaconTransactionMessage(
    options.format,
    caller,
    options.lifetime,
    [instruction],
    budget,
  );
  const { bytes, locks } = measure(message);
  const trace = settlementTrace(message.instructions.length, items);
  return { items, instruction, message, bytes, locks, units, trace };
}

/**
 * The instruction trace a batch of `items` may run at worst, with
 * `topLevel` instructions in its transaction (1 in v1, the settlement and
 * the compute budget's in v0): `settle_round_tickets` emits one event a
 * ticket and makes one transfer a winner, each its own CPI, and at most
 * three more, `round_vrf`'s drain and `RoundDrawn` at the round's first
 * settlement, `RoundClosed` at its last. Counted for every batch, as which
 * batch lands first or last is not the planner's to know.
 */
export function settlementTrace(topLevel: number, items: readonly SettlementItem[]): number {
  const winners = items.filter((i) => i.payout > 0n).length;
  return topLevel + items.length + winners + 3;
}

/** Whether `batch` is within every limit of its format. */
export function batchFits(batch: SettlementBatch, format: TransactionFormat): boolean {
  return (
    batch.items.length <= MAX_ROUND_BATCH &&
    batch.bytes <= transactionSizeLimit(format) &&
    batch.locks <= MAX_ACCOUNT_LOCKS &&
    batch.trace <= MAX_INSTRUCTION_TRACE &&
    batch.units <= MAX_COMPUTE_UNITS
  );
}

/**
 * `items` in settlement order, packed greedily into batches that each fit
 * the format's limits, without a lookup table. Throws if one ticket alone
 * does not fit, which no valid round produces.
 */
export async function planSettlement(
  caller: TransactionSigner,
  round: Held<Round>,
  items: readonly SettlementItem[],
  usdcMint: Address,
  options: PlanOptions,
  config: ProgramConfig = {},
): Promise<SettlementBatch[]> {
  const max = Math.min(options.maxTickets ?? MAX_ROUND_BATCH, MAX_ROUND_BATCH);
  if (max < 1) throw new Error("a batch holds at least one ticket");
  const base = await settleBase(caller, round, usdcMint, config);
  const batches: SettlementBatch[] = [];
  let current: SettlementItem[] = [];
  let fitted: SettlementBatch | null = null;
  for (const item of settlementOrder(items)) {
    const candidate = [...current, item];
    const batch = candidate.length <= max ? batchOf(caller, base, candidate, options) : null;
    if (batch && batchFits(batch, options.format)) {
      current = candidate;
      fitted = batch;
      continue;
    }
    if (fitted) batches.push(fitted);
    const alone = batchOf(caller, base, [item], options);
    if (!batchFits(alone, options.format)) throw new Error("one ticket does not fit a transaction");
    current = [item];
    fitted = alone;
  }
  if (fitted) batches.push(fitted);
  return batches;
}
