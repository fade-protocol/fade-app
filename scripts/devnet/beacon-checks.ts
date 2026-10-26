// What the migration rehearsal (migrate-rehearsal.ts) expects each of its
// transactions to move, computed independently of the program from the
// accounts read before it, the live parameters and the client's ports of `fade_math`
// (clients/js/src/beacon/math.ts, checked against the vectors by
// tests/ts/fade/beaconMath.test.ts, and the admission port below), and
// compared with what moved.
//
// The program itself enforces only `payout > 0 == bit i of wins` against
// the caller; a payout of the wrong amount, a wrong charge, a join that
// took the wrong price or prepay, booked the wrong credit or reservation,
// or a request that sent more to ORAO would keep every bit and land. These
// checks catch it on the cluster: every lamport and token delta of every
// account the transaction touches, to the unit, the vault's books and
// counters, each integrator's books, and the fields the instruction stores
// that later checks read.
//
// Pure: no RPC, no key. tests/ts/fade/beaconChecks.test.ts covers it.
import { getAddressDecoder, getBase58Encoder, type Address } from "@solana/kit";
import {
  BPS,
  P_SCALE,
  charge,
  closeSlot,
  drawCost,
  joinFits,
  isPaid,
  prefund,
  prepay,
  roundTerms,
  sponsorReturn,
  usage,
  type Terms,
} from "../../clients/js/src/beacon/index.ts";
import {
  ROUND_EXPIRED_EVENT_DISCRIMINATOR,
  RoundStatus,
  RoundTicketStatus,
  TicketStatus,
  getIntegratorDecoder,
  getRoundDecoder,
  getRoundExpiredEventDecoder,
  getRoundTicketDecoder,
  getSponsorshipDecoder,
  getTicketDecoder,
  getVaultDecoder,
  type Integrator,
  type PayoutTable,
  type RiskParams,
  type Round,
  type RoundExpiredEvent,
  type RoundTicket,
  type Vault,
} from "../../clients/js/src/generated/fade/index.ts";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
/** `sha256("anchor:event")[..8]`: the tag of every `emit_cpi!` inner instruction. */
export const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
/** `Ticket::SIDE_BEFORE` / `SIDE_AFTER`: a round's recorded side. */
export const SIDE_BEFORE = 0;
export const SIDE_AFTER = 1;
/** `DRAWDOWN_AFTERMATH_SECONDS`: caps are halved this long after a drawdown trip. */
export const DRAWDOWN_AFTERMATH_SECONDS = 48n * 3_600n;

// --- account states --------------------------------------------------------------------

/** One account as read: lamports, owner and data; `null` if it does not exist. */
export type AccountState = { lamports: bigint; owner: Address; data: Uint8Array } | null;
/** Accounts read at one slot. */
export type Snapshot = ReadonlyMap<Address, AccountState>;

export type TokenAccount = { mint: Address; owner: Address; amount: bigint; initialized: boolean };

/** An SPL token account's mint, owner, amount and state; null for anything else. */
export function tokenAccount(state: AccountState): TokenAccount | null {
  if (!state || state.owner !== TOKEN_PROGRAM || state.data.length !== 165) return null;
  const d = state.data;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const addr = getAddressDecoder();
  return {
    mint: addr.decode(d.subarray(0, 32)),
    owner: addr.decode(d.subarray(32, 64)),
    amount: view.getBigUint64(64, true),
    // `AccountState::Initialized` (1); 2 is frozen, 0 uninitialised.
    initialized: d[108] === 1,
  };
}

/** `common::is_usdc_account`: an initialised, unfrozen token account of `mint`. */
export function canReceive(state: AccountState, mint: Address): boolean {
  const t = tokenAccount(state);
  return t !== null && t.mint === mint && t.initialized;
}

const lamportsOf = (s: Snapshot, a: Address) => s.get(a)?.lamports ?? 0n;
const usdcOf = (s: Snapshot, a: Address, mint: Address) => {
  const t = tokenAccount(s.get(a) ?? null);
  return t && t.mint === mint ? t.amount : 0n;
};

/** `a`'s data decoded if it is an account of `program` with data; null otherwise. */
function decodeIn<T>(
  s: Snapshot,
  a: Address,
  program: Address,
  decode: (d: Uint8Array) => T,
): T | null {
  const st = s.get(a);
  if (!st || st.owner !== program || st.data.length === 0) return null;
  return decode(st.data);
}

function mustDecode<T>(s: Snapshot, a: Address, what: string, decode: (d: Uint8Array) => T): T {
  const st = s.get(a);
  if (!st) throw new Error(`${what} ${a} is not in the snapshot`);
  return decode(st.data);
}

const vaultIn = (s: Snapshot, a: Address) =>
  mustDecode(s, a, "the vault", (d) => getVaultDecoder().decode(d));

// --- deltas ------------------------------------------------------------------------------

export type Deltas = Map<Address, bigint>;

function add(m: Deltas, a: Address, v: bigint) {
  m.set(a, (m.get(a) ?? 0n) + v);
}

/**
 * The vault fields compared after every beacon instruction: the books
 * (invariant 1), the epoch counters and generation (invariant 8), the
 * volume and integrator count admission and settlement write, the round
 * ids. Only the drawdown ring and its last trip are left out: no run moves
 * the price enough to trip it, and settlement observes it per ticket.
 */
export const VAULT_FIELDS = [
  "totalAssets",
  "totalShares",
  "totalReservedLiability",
  "openVaultCredits",
  "openBeforeClose",
  "openAfterClose",
  "generation",
  "closeTs",
  "volumeTotal",
  "integrators",
  "afterCloseGain",
  "afterCloseLoss",
  "acceptingRound",
  "nextRoundId",
  "beaconSharesHeld",
  "protocolSharesAccrued",
  "appSharesOwed",
  "beaconReturnsOwed",
  "roundsForfeited",
  "forfeitsWithheld",
] as const;
export type VaultField = (typeof VAULT_FIELDS)[number];
export type VaultDeltas = Record<VaultField, bigint>;
type Books = Pick<Vault, VaultField>;

const noVaultDeltas = (): VaultDeltas =>
  Object.fromEntries(VAULT_FIELDS.map((k) => [k, 0n])) as VaultDeltas;

export function vaultDeltas(before: Books, after: Books): VaultDeltas {
  return Object.fromEntries(
    VAULT_FIELDS.map((k) => [k, BigInt(after[k]) - BigInt(before[k])]),
  ) as VaultDeltas;
}

/** The integrator fields a beacon instruction moves: its reservation, open tickets, nonce, volume and app shares. */
export const INTEGRATOR_FIELDS = [
  "reservedLiability",
  "openTickets",
  "nextNonce",
  "volumeTotal",
  "appSharesAccrued",
] as const;
export type IntegratorField = (typeof INTEGRATOR_FIELDS)[number];
export type IntegratorDeltas = Record<IntegratorField, bigint>;

const noIntegratorDeltas = (): IntegratorDeltas =>
  Object.fromEntries(INTEGRATOR_FIELDS.map((k) => [k, 0n])) as IntegratorDeltas;

function addIntegrator(
  m: Map<Address, IntegratorDeltas>,
  a: Address,
  d: Partial<IntegratorDeltas>,
) {
  const cur = m.get(a) ?? noIntegratorDeltas();
  for (const [k, v] of Object.entries(d)) cur[k as IntegratorField] += v;
  m.set(a, cur);
}

/** What one transaction is expected to move. */
export type Expected = {
  /** Every account read before it, with 0 for those that should not move. */
  lamports: Deltas;
  /** Token accounts of the USDC mint, the same way. */
  usdc: Deltas;
  vault: VaultDeltas;
  /** Each integrator account's books (missing: nothing moves). */
  integrators: Map<Address, IntegratorDeltas>;
  /** What the instruction must have stored, compared with the state after; empty when it agrees. */
  stored?: (after: Snapshot) => string[];
  /**
   * Accounts whose lamports are compared as one sum, not one by one: an
   * ORAO request and `round_vrf`, between which ORAO's fulfilment, which may
   * land before the state after is read, moves the request's spare rent.
   */
  pools?: readonly { accounts: readonly Address[]; lamports: bigint }[];
};

/** What moved between two snapshots: the shape `mismatches` compares. */
export type Seen = {
  lamports: Deltas;
  usdc: Deltas;
  vault: VaultDeltas;
  integrators: Map<Address, IntegratorDeltas>;
  after?: Snapshot;
};

/** What moved between two snapshots of the same accounts. */
export function observed(
  before: Snapshot,
  after: Snapshot,
  mint: Address,
): { lamports: Deltas; usdc: Deltas } {
  const lamports: Deltas = new Map();
  const usdc: Deltas = new Map();
  for (const a of new Set([...before.keys(), ...after.keys()])) {
    lamports.set(a, lamportsOf(after, a) - lamportsOf(before, a));
    usdc.set(a, usdcOf(after, a, mint) - usdcOf(before, a, mint));
  }
  return { lamports, usdc };
}

/**
 * Everything that moved between `before` and `after` (the same accounts,
 * `vault` among them), each listed integrator's books included: one created
 * by the transaction counts from zero.
 */
export function seenBetween(
  before: Snapshot,
  after: Snapshot,
  vault: Address,
  integrators: Iterable<Address>,
  mint: Address,
): Seen {
  const books = new Map<Address, IntegratorDeltas>();
  const fields = (s: AccountState): IntegratorDeltas => {
    if (!s || s.data.length === 0) return noIntegratorDeltas();
    const i = getIntegratorDecoder().decode(s.data);
    return Object.fromEntries(INTEGRATOR_FIELDS.map((k) => [k, i[k]])) as IntegratorDeltas;
  };
  for (const i of new Set(integrators)) {
    if (!before.has(i) || !after.has(i))
      throw new Error(`integrator ${i} is not in both snapshots`);
    const b = fields(before.get(i) ?? null);
    const a = fields(after.get(i) ?? null);
    const d = Object.fromEntries(
      INTEGRATOR_FIELDS.map((k) => [k, a[k] - b[k]]),
    ) as IntegratorDeltas;
    if (INTEGRATOR_FIELDS.some((k) => d[k] !== 0n)) books.set(i, d);
  }
  return {
    ...observed(before, after, mint),
    vault: vaultDeltas(vaultIn(before, vault), vaultIn(after, vault)),
    integrators: books,
    after,
  };
}

/** Every difference between what was expected and what moved, named; empty when they agree. */
export function mismatches(expected: Expected, seen: Seen): string[] {
  const out: string[] = [];
  const pooled = new Set((expected.pools ?? []).flatMap((p) => p.accounts));
  const compare = (what: string, e: Deltas, o: Deltas, skip: ReadonlySet<Address> = new Set()) => {
    for (const a of new Set([...e.keys(), ...o.keys()])) {
      if (skip.has(a)) continue;
      const want = e.get(a) ?? 0n;
      const got = o.get(a) ?? 0n;
      if (want !== got) out.push(`${what} of ${a}: expected ${want}, moved ${got}`);
    }
  };
  compare("lamports", expected.lamports, seen.lamports, pooled);
  for (const p of expected.pools ?? []) {
    const got = p.accounts.reduce((t, a) => t + (seen.lamports.get(a) ?? 0n), 0n);
    if (got !== p.lamports)
      out.push(`lamports of ${p.accounts.join(" + ")}: expected ${p.lamports}, moved ${got}`);
  }
  compare("USDC", expected.usdc, seen.usdc);
  for (const k of VAULT_FIELDS) {
    if (expected.vault[k] !== seen.vault[k])
      out.push(`vault.${k}: expected ${expected.vault[k]}, moved ${seen.vault[k]}`);
  }
  for (const a of new Set([...expected.integrators.keys(), ...seen.integrators.keys()])) {
    const want = expected.integrators.get(a) ?? noIntegratorDeltas();
    const got = seen.integrators.get(a) ?? noIntegratorDeltas();
    for (const k of INTEGRATOR_FIELDS)
      if (want[k] !== got[k])
        out.push(`integrator ${a}.${k}: expected ${want[k]}, moved ${got[k]}`);
  }
  if (expected.stored) {
    if (!seen.after) out.push("the state after was not read");
    else out.push(...expected.stored(seen.after));
  }
  return out;
}

/** An `Expected` with every account of `before` at 0. */
function blank(before: Snapshot, mint: Address): Expected {
  const lamports: Deltas = new Map();
  const usdc: Deltas = new Map();
  for (const [a, s] of before) {
    lamports.set(a, 0n);
    if (tokenAccount(s)?.mint === mint) usdc.set(a, 0n);
  }
  return { lamports, usdc, vault: noVaultDeltas(), integrators: new Map() };
}

/** Every field of `want` that `got` does not hold, named after `what`. */
export function fieldMismatches(
  what: string,
  want: Record<string, unknown>,
  got: Record<string, unknown> | null,
): string[] {
  if (!got) return [`${what}: missing after the transaction`];
  return Object.entries(want)
    .filter(([k, v]) => got[k] !== v)
    .map(([k, v]) => `${what}.${k}: expected ${String(v)}, stored ${String(got[k])}`);
}

function back(prepay: bigint, c: bigint): bigint {
  if (c > prepay) throw new RangeError("a charge above the ticket's prepay");
  return prepay - c;
}

/** `create_pda_account` / Anchor `init`: the lamports the payer adds to an account holding `current`. */
function topUp(rent: bigint, current: bigint): bigint {
  if (current === 0n) return rent;
  const need = rent > 1n ? rent : 1n;
  return need > current ? need - current : 0n;
}

/** Where a round's lamports go if this transaction leaves it with no ticket and no sponsor. */
function closeRound(
  e: Expected,
  round: { address: Address; data: Round },
  status: RoundStatus,
  tickets: number,
  sponsors: number,
  roundLamportsAfter: bigint,
): boolean {
  const ended =
    status === RoundStatus.Drawn ||
    status === RoundStatus.Refunded ||
    status === RoundStatus.Forfeited;
  if (!ended || tickets !== 0 || sponsors !== 0) return false;
  add(e.lamports, round.address, -roundLamportsAfter);
  add(e.lamports, round.data.rentPayer, roundLamportsAfter);
  return true;
}

// --- the epoch counters (fade_math::epoch, Spec 08 §4, §13.7) --------------------------

type Counters = Pick<Books, "openBeforeClose" | "openAfterClose" | "generation" | "closeTs">;

/** `Counters::open_n` at `now`: `n` tickets on the side `now` falls on; the side recorded. */
export function openCounters(
  v: Counters,
  now: bigint | null,
  n: number,
): { side: number; generation: number; before: bigint; after: bigint } {
  if (v.closeTs !== 0n && now === null) throw new Error("the side needs the block's time");
  const before = v.closeTs !== 0n && now! < v.closeTs;
  return {
    side: before ? SIDE_BEFORE : SIDE_AFTER,
    generation: v.generation,
    before: before ? BigInt(n) : 0n,
    after: before ? 0n : BigInt(n),
  };
}

/** Which counter a group recorded at `side`, `generation` is in now (`close_n`'s rule); null if none. */
function counterOf(v: Counters, side: number, generation: number): "before" | "after" | null {
  const inBefore =
    side === SIDE_BEFORE ? generation === v.generation : generation === v.generation - 1;
  if (inBefore) return "before";
  if (side === SIDE_AFTER && generation === v.generation) return "after";
  return null;
}

/** `Counters::close_n`: the counter deltas of `n` tickets of a group leaving. */
export function releaseCounters(
  v: Counters,
  side: number,
  generation: number,
  n: number,
): { before: bigint; after: bigint } {
  const c = counterOf(v, side, generation);
  if (c === null) {
    if (n === 0) return { before: 0n, after: 0n };
    throw new Error("a group whose counter is gone: the program refuses it");
  }
  return c === "before" ? { before: -BigInt(n), after: 0n } : { before: 0n, after: -BigInt(n) };
}

/** `Counters::join_n` at `now`: one more ticket for a group already recorded. */
export function joinCounters(
  v: Counters,
  now: bigint | null,
  side: number,
  generation: number,
): { before: bigint; after: bigint } {
  const c = counterOf(v, side, generation);
  if (c === "before") {
    if (v.closeTs === 0n) throw new Error("a before-close group with no close: RoundEpochClosed");
    if (now === null) throw new Error("the join needs the block's time");
    if (now >= v.closeTs) throw new Error("a join at or after the close: RoundEpochClosed");
    return { before: 1n, after: 0n };
  }
  if (c === "after") return { before: 0n, after: 1n };
  throw new Error("a group whose counter is gone: the program refuses it");
}

/** `record_after_close_result` for a ticket the after-close counter of this generation held. */
function afterCloseResult(e: Expected, credit: bigint, payout: bigint) {
  if (credit >= payout) e.vault.afterCloseGain += credit - payout;
  else e.vault.afterCloseLoss += payout - credit;
}

// --- admission (fade_math::risk, payout_table; programs/fade admission.rs) -------------------

const mulBps = (amount: bigint, bps: bigint) => (amount * bps) / BPS;
/** `payout_table::share_of`, floored. */
export const shareOf = (amount: bigint, bps: bigint) => (amount * bps) / BPS;
const sat = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

export type Admitted = {
  price: bigint;
  appShare: bigint;
  protocolShare: bigint;
  vaultCredit: bigint;
  payoutMax: bigint;
  liability: bigint;
  cap: bigint;
  vaultMarginBps: bigint;
};

/**
 * `check_margin`, `ticket_for` and `admit` on the vault and integrator as
 * they stand, with `minPrice` the path's minimum (the round's snapshot on
 * the beacon, the parameter on the direct path): the ticket the program
 * must book, or a thrown error naming the refusal it must have made.
 */
export function admission(i: {
  params: RiskParams;
  minPrice: bigint;
  table: Pick<PayoutTable, "lhs" | "maxM">;
  price: bigint;
  appShareBps: bigint;
  vault: Pick<
    Vault,
    "totalAssets" | "totalReservedLiability" | "openVaultCredits" | "drawdownTripTs"
  >;
  integrator: Pick<Integrator, "reservedLiability" | "volumeTotal"> | null;
  now: bigint | null;
}): Admitted {
  const p = i.params;
  // check_margin
  const rtp = (i.table.lhs + P_SCALE - 1n) / P_SCALE;
  if (rtp > BPS) throw new Error("PayoutTableOverpays");
  const margin = BPS - rtp;
  if (i.appShareBps > p.maxAppShareBps) throw new Error("AppShareTooHigh");
  const vaultMarginBps = margin - i.appShareBps - p.protocolShareBps;
  if (vaultMarginBps < 0n || vaultMarginBps < p.minVaultMarginBps) throw new Error("MarginFloor");
  const floor = p.minVaultMarginBps + p.protocolShareBps + i.appShareBps;
  if (floor > BPS || i.table.lhs > (BPS - floor) * P_SCALE) throw new Error("MarginFloor");
  // ticket_for
  const appShare = shareOf(i.price, i.appShareBps);
  const protocolShare = shareOf(i.price, p.protocolShareBps);
  const vaultCredit = i.price - appShare - protocolShare;
  if (vaultCredit < 0n) throw new Error("Overflow");
  const payoutMax = (i.price * i.table.maxM) / BPS;
  // admit
  if (i.price < i.minPrice || i.price > p.maxPrice) throw new Error("PriceBounds");
  const liability = sat(payoutMax, vaultCredit);
  const v = i.vault;
  let halved = false;
  if (v.drawdownTripTs !== 0n) {
    if (i.now === null) throw new Error("the halved cap needs the block's time");
    halved = i.now < v.drawdownTripTs + DRAWDOWN_AFTERMATH_SECONDS;
  }
  const free = sat(sat(v.totalAssets, v.totalReservedLiability), v.openVaultCredits);
  const kelly = mulBps(mulBps(free, vaultMarginBps), p.kellyFractionBps);
  const censor = mulBps(v.totalAssets, p.censorshipBps);
  let cap = kelly < censor ? kelly : censor;
  if (halved) cap /= 2n;
  if (liability > cap) throw new Error("PerTicketCap");
  const reserved = i.integrator?.reservedLiability ?? 0n;
  const byWhale = mulBps(v.totalAssets, p.whaleBps);
  let ceiling = byWhale;
  if (p.creditEnabled) {
    const byCredit = p.creditBase + mulBps(i.integrator?.volumeTotal ?? 0n, p.creditRateBps);
    ceiling = byWhale < byCredit ? byWhale : byCredit;
  }
  if (reserved + liability > ceiling) throw new Error("IntegratorCap");
  const assets = v.totalAssets + vaultCredit;
  const reservedAfter = v.totalReservedLiability + liability;
  const committed = reservedAfter + v.openVaultCredits + vaultCredit;
  if (committed * BPS > assets * p.utilisationBreakerBps) throw new Error("UtilisationBreaker");
  if (reservedAfter * BPS > assets * p.kappaBps) throw new Error("GlobalExposure");
  if (committed > assets) throw new Error("Insolvent");
  return {
    price: i.price,
    appShare,
    protocolShare,
    vaultCredit,
    payoutMax,
    liability,
    cap,
    vaultMarginBps,
  };
}

/** Rents of the accounts the beacon creates, at the cluster's rate. */
export type Rents = { round: bigint; ticket: bigint; sponsorship: bigint; integrator: bigint };

// --- join_round -----------------------------------------------------------------------------

export type JoinInput = {
  program: Address;
  params: RiskParams;
  /** ORAO's fee and a pending request's rent, as the join reads them. */
  oraoFee: bigint;
  pendingRent: bigint;
  rents: Rents;
  vault: Address;
  vaultUsdc: Address;
  /**
   * The two rounds a join may land in: `["round", vault.accepting_round]`
   * (null when it is 0) and `["round", vault.next_round_id]`. Which one is
   * decided here, from the vault and the accepting round before and the
   * slot the join landed at, as the program resolves it (§13.5.2), not
   * taken from the client's resolution.
   */
  rounds: { accepting: Address | null; next: Address };
  integrator: Address;
  integratorAuthority: Address;
  shareAccount: Address;
  ticket: Address;
  /** `["sponsorship", target round, payer]`, with a sponsorship. */
  sponsorshipRecord: Address | null;
  table: { address: Address; data: Pick<PayoutTable, "lhs" | "maxM"> };
  payer: Address;
  funder: Address;
  funderUsdc: Address;
  beneficiary: Address;
  mint: Address;
  feePayer: Address;
  price: bigint;
  appShareBps: bigint;
  nonce: bigint;
  sponsorship: bigint;
  before: Snapshot;
};

/**
 * What one `join_round` moves (Spec 08 §13.5.2), from the vault, round,
 * integrator and sponsorship record read before it: the price from the
 * funder's token account into `vault_usdc`; the prepay
 * (`ceil(D_r · price / T_r)` on the round's terms, a new round's from the
 * live parameters and ORAO's fee) and the sponsorship into the round, the
 * settlement share and the ticket's rent into the ticket, the rents of
 * what the join creates, all from the payer; the vault's assets, open
 * credits, reservation and held shares, and its counters when the join
 * pays the round; the integrator's reservation, open tickets and nonce.
 * And what it stores: every field of the ticket, the round's aggregates
 * and, for a new round, its snapshot, the sponsorship record's amount.
 */
export function expectJoin(i: JoinInput, fee: bigint, at: { slot: bigint; now: bigint | null }) {
  const b = i.before;
  const v = vaultIn(b, i.vault);
  const p = i.params;
  // Round resolution: the accepting round if it still accepts at the join's
  // slot (`Accepting`, or `Paid` before its close), else the next, created.
  if ((v.acceptingRound === 0n) !== (i.rounds.accepting === null))
    throw new Error("the accepting round's address does not match the vault");
  if (v.nextRoundId === 0n) throw new Error("WrongRound");
  const accepting = i.rounds.accepting
    ? decodeIn(b, i.rounds.accepting, i.program, (d) => getRoundDecoder().decode(d))
    : null;
  if (accepting && accepting.id !== v.acceptingRound) throw new Error("WrongRound");
  const takes =
    accepting !== null &&
    (accepting.status === RoundStatus.Accepting ||
      (accepting.status === RoundStatus.Paid && at.slot < accepting.closeSlot));
  const target = takes
    ? { round: i.rounds.accepting!, id: v.acceptingRound, creates: false }
    : { round: i.rounds.next, id: v.nextRoundId, creates: true };
  if (target.creates && decodeIn(b, target.round, i.program, (d) => d) !== null)
    throw new Error("the round to create exists");
  const roundBefore: Round | null = takes ? accepting : null;
  const terms: Terms = roundBefore
    ? roundTerms(roundBefore)
    : {
        threshold: p.beaconThreshold,
        drawMax: prefund(i.oraoFee, i.pendingRent, p.crankRequestLamports),
        roundK: p.roundK,
      };
  const minPrice = roundBefore ? roundBefore.minPrice : p.beaconMinPrice;
  const settleShare = roundBefore ? roundBefore.settleShare : p.crankRoundSettleLamports;
  const integratorBefore = decodeIn(b, i.integrator, i.program, (d) =>
    getIntegratorDecoder().decode(d),
  );
  const created = integratorBefore === null;
  if (!created && integratorBefore.nextNonce !== i.nonce) throw new Error("WrongNonce");
  const w = admission({
    params: p,
    minPrice,
    table: i.table.data,
    price: i.price,
    appShareBps: i.appShareBps,
    vault: v,
    integrator: integratorBefore,
    now: at.now,
  });
  const pre = prepay(terms, i.price);
  const u = usage(w.liability, w.cap);
  const book0 = roundBefore ?? {
    prices: 0n,
    sponsorship: 0n,
    usage: 0n,
    liability: 0n,
    credits: 0n,
    protocolShares: 0n,
    appShares: 0n,
    prepaid: 0n,
    tickets: 0,
    sponsors: 0,
  };
  const prices = book0.prices + i.price;
  const sponsorship = book0.sponsorship + i.sponsorship;
  const usageAfter = book0.usage + u;
  // The capacity rule, and the join within its own share.
  if (!joinFits(terms, book0, u, i.price, i.sponsorship)) throw new Error("RoundCapacity");
  const status = roundBefore?.status ?? RoundStatus.Accepting;
  const becamePaid = status === RoundStatus.Accepting && isPaid(terms, prices, sponsorship);

  // The sponsorship record.
  let record: { amount: bigint } | null = null;
  let newRecord = false;
  if (i.sponsorship > 0n) {
    if (!i.sponsorshipRecord) throw new Error("a sponsorship needs its record");
    record = decodeIn(b, i.sponsorshipRecord, i.program, (d) => getSponsorshipDecoder().decode(d));
    newRecord = record === null;
  }

  const e = blank(b, i.mint);
  add(e.lamports, i.feePayer, -fee);
  // Lamports: the payer funds the rents of what the join creates, the ticket's
  // settlement share and, into the round, the prepay and the sponsorship.
  const rent = (a: Address, r: bigint) => {
    const t = topUp(r, lamportsOf(b, a));
    add(e.lamports, a, t);
    add(e.lamports, i.payer, -t);
  };
  if (target.creates) rent(target.round, i.rents.round);
  if (newRecord) rent(i.sponsorshipRecord!, i.rents.sponsorship);
  if (created) rent(i.integrator, i.rents.integrator);
  rent(i.ticket, i.rents.ticket);
  add(e.lamports, i.ticket, settleShare);
  add(e.lamports, target.round, pre + i.sponsorship);
  add(e.lamports, i.payer, -(settleShare + pre + i.sponsorship));
  // USDC: the price, funder to vault.
  add(e.usdc, i.funderUsdc, -i.price);
  add(e.usdc, i.vaultUsdc, i.price);
  // The vault's books.
  e.vault.totalAssets += w.vaultCredit;
  e.vault.openVaultCredits += w.vaultCredit;
  e.vault.totalReservedLiability += w.liability;
  e.vault.beaconSharesHeld += w.protocolShare + w.appShare;
  if (created) e.vault.integrators += 1n;
  if (target.creates) {
    e.vault.acceptingRound += target.id - v.acceptingRound;
    e.vault.nextRoundId += 1n;
  }
  let recorded: { side: number; generation: number } | null = null;
  if (becamePaid) {
    const c = openCounters(v, at.now, book0.tickets + 1);
    e.vault.openBeforeClose += c.before;
    e.vault.openAfterClose += c.after;
    recorded = { side: c.side, generation: c.generation };
  } else if (status === RoundStatus.Paid) {
    const c = joinCounters(v, at.now, roundBefore!.side, roundBefore!.generation);
    e.vault.openBeforeClose += c.before;
    e.vault.openAfterClose += c.after;
  }
  addIntegrator(e.integrators, i.integrator, {
    reservedLiability: w.liability,
    openTickets: 1n,
    nextNonce: 1n,
  });

  const wantRound: Record<string, unknown> = {
    id: target.id,
    status: becamePaid ? RoundStatus.Paid : status,
    prices,
    sponsorship,
    usage: usageAfter,
    liability: book0.liability + w.liability,
    credits: book0.credits + w.vaultCredit,
    protocolShares: book0.protocolShares + w.protocolShare,
    appShares: book0.appShares + w.appShare,
    prepaid: book0.prepaid + pre,
    tickets: book0.tickets + 1,
    sponsors: book0.sponsors + (newRecord ? 1 : 0),
    threshold: terms.threshold,
    drawMax: terms.drawMax,
    roundK: Number(terms.roundK),
    minPrice,
    settleShare,
  };
  if (target.creates) {
    Object.assign(wantRound, {
      rentPayer: i.payer,
      firstSlot: at.slot,
      requestShare: p.crankRequestLamports,
      tickSlots: p.tickSlots,
      refundSlots: p.refundSlots,
      tSettleSlots: p.tSettleSlots,
      drawdownBps: p.drawdownBps,
    });
  }
  if (becamePaid) {
    const tick = roundBefore?.tickSlots ?? p.tickSlots;
    Object.assign(wantRound, {
      paidSlot: at.slot,
      closeSlot: closeSlot(at.slot, tick),
      counted: true,
      side: recorded!.side,
      generation: recorded!.generation,
    });
  }
  const wantTicket: Record<string, unknown> = {
    status: RoundTicketStatus.Joined,
    round: target.id,
    integrator: i.integrator,
    nonce: i.nonce,
    payer: i.payer,
    funder: i.funder,
    refundTo: i.funderUsdc,
    beneficiary: i.beneficiary,
    payoutTable: i.table.address,
    price: i.price,
    vaultCredit: w.vaultCredit,
    payoutMax: w.payoutMax,
    liability: w.liability,
    protocolShare: w.protocolShare,
    appShare: w.appShare,
    prepay: pre,
    settleShare,
    payout: 0n,
  };
  e.stored = (after) => {
    const out = [
      ...fieldMismatches(
        "round",
        wantRound,
        decodeIn(after, target.round, i.program, (d) => getRoundDecoder().decode(d)),
      ),
      ...fieldMismatches(
        "ticket",
        wantTicket,
        decodeIn(after, i.ticket, i.program, (d) => getRoundTicketDecoder().decode(d)),
      ),
    ];
    if (created)
      out.push(
        ...fieldMismatches(
          "integrator",
          { authority: i.integratorAuthority, shareAccount: i.shareAccount },
          decodeIn(after, i.integrator, i.program, (d) => getIntegratorDecoder().decode(d)),
        ),
      );
    if (i.sponsorshipRecord && i.sponsorship > 0n)
      out.push(
        ...fieldMismatches(
          "sponsorship",
          {
            round: target.id,
            sponsor: i.payer,
            amount: (record?.amount ?? 0n) + i.sponsorship,
          },
          decodeIn(after, i.sponsorshipRecord, i.program, (d) => getSponsorshipDecoder().decode(d)),
        ),
      );
    return out;
  };
  return {
    ...e,
    admitted: w,
    prepay: pre,
    becamePaid,
    target,
  };
}

// --- sponsor_round ----------------------------------------------------------------------------

export type SponsorInput = {
  program: Address;
  vault: Address;
  round: Address;
  sponsor: Address;
  record: Address;
  lamports: bigint;
  recordRent: bigint;
  mint: Address;
  feePayer: Address;
  before: Snapshot;
};

/**
 * What one `sponsor_round` moves (Spec 08 §13.5.3): exactly `lamports` from
 * the sponsor into the round, the record's rent if it creates it; the vault
 * only through its counters, when the sponsorship pays the round. Stored:
 * the round's sponsorship and sponsors, its payment if it pays it, the
 * record's amount.
 */
export function expectSponsor(
  i: SponsorInput,
  fee: bigint,
  at: { slot: bigint; now: bigint | null },
) {
  const b = i.before;
  const r = decodeIn(b, i.round, i.program, (d) => getRoundDecoder().decode(d));
  if (!r) throw new Error("no round to sponsor");
  if (r.status !== RoundStatus.Accepting && r.status !== RoundStatus.Paid)
    throw new Error("RoundNotAccepting");
  if (i.lamports <= 0n) throw new Error("ZeroAmount");
  const record = decodeIn(b, i.record, i.program, (d) => getSponsorshipDecoder().decode(d));
  const v = vaultIn(b, i.vault);
  const e = blank(b, i.mint);
  add(e.lamports, i.feePayer, -fee);
  const t = record ? 0n : topUp(i.recordRent, lamportsOf(b, i.record));
  add(e.lamports, i.record, t);
  add(e.lamports, i.sponsor, -(t + i.lamports));
  add(e.lamports, i.round, i.lamports);
  const terms = roundTerms(r);
  const sponsorship = r.sponsorship + i.lamports;
  const becamePaid = r.status === RoundStatus.Accepting && isPaid(terms, r.prices, sponsorship);
  const want: Record<string, unknown> = {
    sponsorship,
    sponsors: r.sponsors + (record ? 0 : 1),
    prices: r.prices,
    tickets: r.tickets,
    status: becamePaid ? RoundStatus.Paid : r.status,
  };
  if (becamePaid) {
    const c = openCounters(v, at.now, r.tickets);
    e.vault.openBeforeClose += c.before;
    e.vault.openAfterClose += c.after;
    Object.assign(want, {
      paidSlot: at.slot,
      closeSlot: closeSlot(at.slot, r.tickSlots),
      counted: true,
      side: c.side,
      generation: c.generation,
    });
  }
  e.stored = (after) => [
    ...fieldMismatches(
      "round",
      want,
      decodeIn(after, i.round, i.program, (d) => getRoundDecoder().decode(d)),
    ),
    ...fieldMismatches(
      "sponsorship",
      { round: r.id, sponsor: i.sponsor, amount: (record?.amount ?? 0n) + i.lamports },
      decodeIn(after, i.record, i.program, (d) => getSponsorshipDecoder().decode(d)),
    ),
  ];
  return { ...e, becamePaid };
}

// --- request_round_draw -----------------------------------------------------------------------

export type RequestInput = {
  program: Address;
  vault: Address;
  round: Address;
  /** `["round-vrf", round]`. */
  roundVrf: Address;
  /** ORAO's request for the round's seed, as the client derives it. */
  request: Address;
  oraoTreasury: Address;
  oraoFee: bigint;
  pendingRent: bigint;
  /** `s*`, the first slot after the close in SlotHashes, as the client reads it. */
  entropySlot: bigint;
  mint: Address;
  caller: Address;
  fee: bigint;
  before: Snapshot;
};

/**
 * What one `request_round_draw` moves (Spec 08 §13.5.6) when it creates the
 * request: ORAO's fee to its treasury and a pending request's rent into the
 * request, `funded = fee + rent` out of the round, the request share to the
 * caller, anything sent to `round_vrf` back to the round; no vault field.
 * Stored: `Requested`, the request, `funded`, the entropy slot. The request
 * and `round_vrf` are compared as one sum, ORAO's fulfilment possibly
 * landing before the state after is read; ORAO's treasury only if it is in
 * the snapshot (on a shared cluster others' requests pay it too: the caller
 * checks its delta from the transaction's own balances).
 */
export function expectRequest(i: RequestInput) {
  const b = i.before;
  const r = decodeIn(b, i.round, i.program, (d) => getRoundDecoder().decode(d));
  if (!r || r.status !== RoundStatus.Paid) throw new Error("not a paid round");
  if (lamportsOf(b, i.request) !== 0n)
    throw new Error("a pre-created or pre-funded request: not predicted here");
  const stray = lamportsOf(b, i.roundVrf);
  const funded = i.oraoFee + i.pendingRent;
  if (funded + r.requestShare > r.drawMax) throw new Error("DrawUnderfunded");
  const e = blank(b, i.mint);
  add(e.lamports, i.caller, -i.fee + r.requestShare);
  add(e.lamports, i.round, stray - funded - r.requestShare);
  if (b.has(i.oraoTreasury)) add(e.lamports, i.oraoTreasury, i.oraoFee);
  if (!b.has(i.request) || !b.has(i.roundVrf))
    throw new Error("the request and round_vrf are read");
  e.pools = [{ accounts: [i.request, i.roundVrf], lamports: i.pendingRent - stray }];
  const want = {
    status: RoundStatus.Requested,
    randomness: i.request,
    funded,
    entropySlot: i.entropySlot,
    prices: r.prices,
    sponsorship: r.sponsorship,
    tickets: r.tickets,
    prepaid: r.prepaid,
  };
  e.stored = (after) =>
    fieldMismatches(
      "round",
      want,
      decodeIn(after, i.round, i.program, (d) => getRoundDecoder().decode(d)),
    );
  return { ...e, funded };
}

// --- refund_round ------------------------------------------------------------------------------

/**
 * What `refund_round` moves (Spec 08 §13.5.5): no lamport but the fee and no
 * token; the round's credits out of the assets and the open credits, its
 * reservation released, its shares no longer held, its prices owed back;
 * `accepting_round` cleared if it names it. Stored: `Refunded`.
 */
export function expectRefund(i: {
  program: Address;
  vault: Address;
  round: Address;
  mint: Address;
  caller: Address;
  fee: bigint;
  before: Snapshot;
}) {
  const b = i.before;
  const r = decodeIn(b, i.round, i.program, (d) => getRoundDecoder().decode(d));
  if (!r || r.status !== RoundStatus.Accepting || r.counted) throw new Error("not an unpaid round");
  if (r.credits + r.protocolShares + r.appShares !== r.prices)
    throw new Error("a round whose prices are not its credits and shares");
  const v = vaultIn(b, i.vault);
  const e = blank(b, i.mint);
  add(e.lamports, i.caller, -i.fee);
  e.vault.totalAssets -= r.credits;
  e.vault.openVaultCredits -= r.credits;
  e.vault.totalReservedLiability -= r.liability;
  e.vault.beaconSharesHeld -= r.protocolShares + r.appShares;
  e.vault.beaconReturnsOwed += r.prices;
  if (v.acceptingRound === r.id) e.vault.acceptingRound -= r.id;
  e.stored = (after) =>
    fieldMismatches(
      "round",
      { status: RoundStatus.Refunded, tickets: r.tickets, prices: r.prices, prepaid: r.prepaid },
      decodeIn(after, i.round, i.program, (d) => getRoundDecoder().decode(d)),
    );
  return e;
}

// --- settle_round_tickets ------------------------------------------------------------------

export type SettleInput = {
  round: { address: Address; data: Round };
  /** `["round-vrf", round]`. */
  roundVrf: Address;
  tickets: readonly { address: Address; data: RoundTicket; payout: bigint }[];
  vault: Address;
  vaultUsdc: Address;
  payoutEscrow: Address;
  mint: Address;
  /** The caller, also the fee payer. */
  caller: Address;
  fee: bigint;
  before: Snapshot;
};

/**
 * What one `settle_round_tickets` batch moves (Spec 08 §13.5.7), each
 * ticket's payout the client predicted from the round's randomness: the
 * payouts out of `vault_usdc` (or into `payout_escrow` for a beneficiary
 * that cannot receive), `prepay − charge` and the ticket's rent to its
 * payer, the settlement shares to the caller, the round's rent to its
 * rent payer if the batch ends it; the vault's books, volume and counters
 * (each ticket leaving the round's counter, its result booked after the
 * close when that counter calls for it); each integrator's reservation,
 * open tickets, volume and app shares. Also returns the draw cost the
 * batch fixes.
 */
export function expectSettlement(i: SettleInput): Expected & { drawCost: bigint } {
  const r = i.round.data;
  const first = r.status === RoundStatus.Requested;
  if (!first && r.status !== RoundStatus.Drawn) throw new Error("the round is not settleable");
  const v = vaultIn(i.before, i.vault);
  const e = blank(i.before, i.mint);
  const refund = first ? lamportsOf(i.before, i.roundVrf) : 0n;
  const cost = first ? drawCost(r.funded, r.requestShare, refund) : r.drawCost;
  add(e.lamports, i.roundVrf, -refund);
  let roundLamports = lamportsOf(i.before, i.round.address) + refund;
  add(e.lamports, i.round.address, refund);
  add(e.lamports, i.caller, -i.fee);
  const counter = counterOf(v, r.side, r.generation);
  if (counter === null && i.tickets.length > 0) throw new Error("the round's counter is gone");
  const afterClose = r.side === SIDE_AFTER && r.generation === v.generation;
  for (const t of i.tickets) {
    const d = t.data;
    if (d.round !== r.id) throw new Error("a ticket of another round");
    if (t.payout > d.payoutMax) throw new RangeError("a payout above the ticket's maximum");
    const ret = back(d.prepay, charge(cost, r.sponsorship, r.prices, d.price));
    const pending = t.payout > 0n && !canReceive(i.before.get(d.beneficiary) ?? null, i.mint);
    add(e.lamports, t.address, -d.settleShare);
    add(e.lamports, i.caller, d.settleShare);
    add(e.lamports, i.round.address, -ret);
    roundLamports -= ret;
    if (pending) {
      add(e.lamports, t.address, ret);
      add(e.usdc, i.payoutEscrow, t.payout);
    } else {
      // Closed to its payer: everything it held, less the settlement share, plus the return.
      const rest = lamportsOf(i.before, t.address) - d.settleShare;
      add(e.lamports, t.address, -rest);
      add(e.lamports, d.payer, ret + rest);
      add(e.usdc, d.beneficiary, t.payout);
    }
    // Every payout leaves `vault_usdc`: to its beneficiary, or parked in `payout_escrow`.
    add(e.usdc, i.vaultUsdc, -t.payout);
    e.vault.totalAssets -= t.payout;
    e.vault.totalReservedLiability -= d.liability;
    e.vault.openVaultCredits -= d.vaultCredit;
    e.vault.beaconSharesHeld -= d.protocolShare + d.appShare;
    e.vault.protocolSharesAccrued += d.protocolShare;
    e.vault.appSharesOwed += d.appShare;
    e.vault.volumeTotal += d.price;
    if (counter === "before") e.vault.openBeforeClose -= 1n;
    else e.vault.openAfterClose -= 1n;
    if (afterClose) afterCloseResult(e, d.vaultCredit, t.payout);
    addIntegrator(e.integrators, d.integrator, {
      reservedLiability: -d.liability,
      openTickets: -1n,
      volumeTotal: d.price,
      appSharesAccrued: d.appShare,
    });
  }
  closeRound(
    e,
    i.round,
    RoundStatus.Drawn,
    r.tickets - i.tickets.length,
    r.sponsors,
    roundLamports,
  );
  return { ...e, drawCost: cost };
}

// --- reclaim_sponsorship --------------------------------------------------------------------

export type ReclaimInput = {
  round: { address: Address; data: Round };
  sponsorship: { address: Address; sponsor: Address; amount: bigint };
  mint: Address;
  /** The caller, also the fee payer. */
  caller: Address;
  fee: bigint;
  before: Snapshot;
};

/**
 * What one `reclaim_sponsorship` moves (Spec 08 §13.5.10): the sponsor's
 * `sponsor_return` and the record's rent to the sponsor, the round's rent
 * to its rent payer if it was the last sponsor of an ended round.
 */
export function expectReclaim(i: ReclaimInput): Expected & { returned: bigint } {
  const r = i.round.data;
  const drawn = r.status === RoundStatus.Drawn || r.status === RoundStatus.Forfeited;
  if (!drawn && r.status !== RoundStatus.Refunded) throw new Error("the round has not ended");
  const e = blank(i.before, i.mint);
  add(e.lamports, i.caller, -i.fee);
  const returned = sponsorReturn(r.drawCost, r.sponsorship, i.sponsorship.amount, drawn);
  const rent = lamportsOf(i.before, i.sponsorship.address);
  add(e.lamports, i.round.address, -returned);
  add(e.lamports, i.sponsorship.address, -rent);
  add(e.lamports, i.sponsorship.sponsor, returned + rent);
  closeRound(
    e,
    i.round,
    r.status,
    r.tickets,
    r.sponsors - 1,
    lamportsOf(i.before, i.round.address) - returned,
  );
  return { ...e, returned };
}

// --- return_round_ticket ---------------------------------------------------------------------

export type ReturnInput = {
  round: { address: Address; data: Round };
  ticket: { address: Address; data: RoundTicket };
  vaultUsdc: Address;
  mint: Address;
  caller: Address;
  fee: bigint;
  before: Snapshot;
};

/**
 * What one `return_round_ticket` moves (Spec 08 §13.5.9) when it is not
 * parked: after a refund the price back to `refund_to` and the whole
 * prepay to the payer; after a forfeiture no token, the draw's charge kept,
 * the settlement share to the caller, the app share accrued and the volume
 * counted. Either way the integrator's reservation released and its open
 * tickets down by one.
 */
export function expectReturn(i: ReturnInput): Expected {
  const r = i.round.data;
  const d = i.ticket.data;
  const refunded = r.status === RoundStatus.Refunded;
  if (!refunded && r.status !== RoundStatus.Forfeited) throw new Error("not a returnable round");
  if (refunded && !canReceive(i.before.get(d.refundTo) ?? null, i.mint))
    throw new Error("a parked return: not predicted here");
  const e = blank(i.before, i.mint);
  add(e.lamports, i.caller, -i.fee);
  const c = refunded ? 0n : charge(r.drawCost, r.sponsorship, r.prices, d.price);
  const ret = back(d.prepay, c);
  const share = refunded ? 0n : d.settleShare;
  const rest = lamportsOf(i.before, i.ticket.address) - share;
  add(e.lamports, i.caller, share);
  add(e.lamports, i.round.address, -ret);
  add(e.lamports, i.ticket.address, -(rest + share));
  add(e.lamports, d.payer, ret + rest);
  if (refunded) {
    add(e.usdc, i.vaultUsdc, -d.price);
    add(e.usdc, d.refundTo, d.price);
    e.vault.beaconReturnsOwed -= d.price;
    addIntegrator(e.integrators, d.integrator, {
      reservedLiability: -d.liability,
      openTickets: -1n,
    });
  } else {
    e.vault.beaconSharesHeld -= d.appShare;
    e.vault.appSharesOwed += d.appShare;
    e.vault.volumeTotal += d.price;
    addIntegrator(e.integrators, d.integrator, {
      reservedLiability: -d.liability,
      openTickets: -1n,
      volumeTotal: d.price,
      appSharesAccrued: d.appShare,
    });
  }
  closeRound(
    e,
    i.round,
    r.status,
    r.tickets - 1,
    r.sponsors,
    lamportsOf(i.before, i.round.address) - ret,
  );
  return e;
}

// --- claim_round_payout ------------------------------------------------------------------------

/**
 * What one `claim_round_payout` moves (Spec 08 §13.5.11): the parked amount
 * from `payout_escrow` to the stored destination, the ticket closed to its
 * payer; no vault field. The amount is the payout the client predicted at
 * settlement for a parked payout, the ticket's price for a parked return:
 * what the ticket stores is checked against it, not trusted.
 */
export function expectClaimPayout(i: {
  ticket: { address: Address; data: RoundTicket };
  /** The payout predicted for this ticket at its settlement (a parked payout). */
  predicted: bigint | null;
  payoutEscrow: Address;
  mint: Address;
  caller: Address;
  fee: bigint;
  before: Snapshot;
}): Expected & { amount: bigint; destination: Address } {
  const d = i.ticket.data;
  let destination: Address;
  let amount: bigint;
  if (d.status === RoundTicketStatus.PayoutParked) {
    if (i.predicted === null) throw new Error("a parked payout needs its predicted payout");
    destination = d.beneficiary;
    amount = i.predicted;
  } else if (d.status === RoundTicketStatus.ReturnParked) {
    destination = d.refundTo;
    amount = d.price;
  } else throw new Error("WrongTicketStatus");
  if (d.payout !== amount)
    throw new Error(`the ticket stores ${d.payout} parked, ${amount} was owed`);
  const e = blank(i.before, i.mint);
  add(e.lamports, i.caller, -i.fee);
  const held = lamportsOf(i.before, i.ticket.address);
  add(e.lamports, i.ticket.address, -held);
  add(e.lamports, d.payer, held);
  add(e.usdc, i.payoutEscrow, -amount);
  add(e.usdc, destination, amount);
  return { ...e, amount, destination };
}

// --- expire_round ------------------------------------------------------------------------------

/**
 * What `expire_round` of a round never requested moves (Spec 08 §13.5.8):
 * no lamport but the fee and no token; the reservation and the credits
 * released (the credits stay in the assets, an after-close gain when the
 * round's counter calls for it), every remaining ticket leaving the
 * round's counter, the protocol's shares made claimable. And the
 * `RoundExpired` event it must emit: not requested, no request found, the
 * search made (SlotHashes still proving `s*`), the round's tickets and
 * credits, no draw cost. The vault counts the forfeiture, not as withheld.
 */
export function expectUnrequestedExpiry(i: {
  program: Address;
  round: { address: Address; data: Round };
  vault: Address;
  mint: Address;
  caller: Address;
  fee: bigint;
  before: Snapshot;
}): Expected & { event: Omit<RoundExpiredEvent, "version" | "side" | "generation"> } {
  const r = i.round.data;
  if (r.status !== RoundStatus.Paid) throw new Error("not a round paid and never requested");
  const v = vaultIn(i.before, i.vault);
  const e = blank(i.before, i.mint);
  add(e.lamports, i.caller, -i.fee);
  e.vault.totalReservedLiability -= r.liability;
  e.vault.openVaultCredits -= r.credits;
  e.vault.beaconSharesHeld -= r.protocolShares;
  e.vault.protocolSharesAccrued += r.protocolShares;
  // Counted, not as withheld: never requested, looked for and not found.
  e.vault.roundsForfeited += 1n;
  const c = releaseCounters(v, r.side, r.generation, r.tickets);
  e.vault.openBeforeClose += c.before;
  e.vault.openAfterClose += c.after;
  if (r.side === SIDE_AFTER && r.generation === v.generation) afterCloseResult(e, r.credits, 0n);
  e.stored = (after) =>
    fieldMismatches(
      "round",
      { status: RoundStatus.Forfeited, drawCost: 0n, tickets: r.tickets },
      decodeIn(after, i.round.address, i.program, (d) => getRoundDecoder().decode(d)),
    );
  return {
    ...e,
    event: {
      round: i.round.address,
      requested: false,
      requestFound: false,
      checked: true,
      tickets: r.tickets,
      forfeited: r.credits,
      drawCost: 0n,
      refund: 0n,
      forfeitsWithheld: v.forfeitsWithheld,
      refunded: false,
    },
  };
}

/** Every field of `want` that `got` does not carry, named. */
export function eventMismatches(want: Record<string, unknown>, got: Record<string, unknown>) {
  return Object.entries(want)
    .filter(([k, v]) => got[k] !== v)
    .map(([k, v]) => `${k}: expected ${String(v)}, emitted ${String(got[k])}`);
}

// --- events of a confirmed transaction ---------------------------------------------------------

/** The parts of `getTransaction(…, { encoding: "json" })` the checks read. */
export type JsonTransaction = {
  slot?: bigint;
  /** The block's time: `Clock::unix_timestamp` of the slot, what the program read as `now`. */
  blockTime?: bigint | null;
  transaction: { message: { accountKeys: readonly Address[] } };
  meta: {
    fee: bigint;
    innerInstructions?:
      | readonly {
          instructions: readonly {
            programIdIndex: number;
            accounts: readonly number[];
            data: string;
          }[];
        }[]
      | null;
    loadedAddresses?: { writable: readonly Address[]; readonly: readonly Address[] };
  } | null;
};

/**
 * The bodies (discriminator first) of every `emit_cpi!` event of
 * `discriminator` the transaction carries: inner instructions to `program`,
 * tagged as events and signed by its event authority, its only account.
 * Another program cannot emit one: only `program` can sign as its authority.
 */
export function emittedEvents(
  tx: JsonTransaction,
  program: Address,
  eventAuthority: Address,
  discriminator: ArrayLike<number>,
): Uint8Array[] {
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
  const out: Uint8Array[] = [];
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== program) continue;
      if (ix.accounts.length !== 1 || keys[ix.accounts[0]!] !== eventAuthority) continue;
      const data = new Uint8Array(getBase58Encoder().encode(ix.data));
      const tagged = EVENT_IX_TAG.every((b, k) => data[k] === b);
      const kind = Array.from(discriminator).every((b, k) => data[8 + k] === b);
      if (tagged && kind) out.push(data.slice(8));
    }
  }
  return out;
}

/** The one `RoundExpired` event of an `expire_round` transaction. */
export function roundExpiredEvent(
  tx: JsonTransaction,
  program: Address,
  eventAuthority: Address,
): RoundExpiredEvent {
  const found = emittedEvents(tx, program, eventAuthority, ROUND_EXPIRED_EVENT_DISCRIMINATOR);
  if (found.length !== 1) throw new Error(`${found.length} RoundExpired events, expected 1`);
  return getRoundExpiredEventDecoder().decode(found[0]!);
}

// --- shares --------------------------------------------------------------------------------------

export type IntegratorShares = {
  address: Address;
  authority: Address;
  appSharesAccrued: bigint;
  /** Whether its stored `share_account` can receive a claim now. */
  shareAccountReceives: boolean;
};

/**
 * Whether the sweep may close `wallet`'s USDC account: never while an
 * integrator of that authority still has app shares accrued, since that
 * account is the integrator's stored `share_account`, the claim's only
 * destination.
 */
export function mayCloseShareAccount(
  wallet: Address,
  integrators: readonly IntegratorShares[],
): boolean {
  return !integrators.some((i) => i.authority === wallet && i.appSharesAccrued > 0n);
}

/** What an open beacon account names: who it will still pay, or whose account it pays into. */
export type OpenAccounts = {
  rounds: readonly { address: Address; data: Pick<Round, "rentPayer"> }[];
  tickets: readonly {
    address: Address;
    data: Pick<RoundTicket, "payer" | "funder" | "refundTo" | "beneficiary" | "integrator">;
  }[];
  sponsorships: readonly { address: Address; data: Pick<Sponsorship, "sponsor"> }[];
  /** The authority of each integrator account (an open ticket's integrator accrues its app share). */
  integratorAuthority: ReadonlyMap<Address, Address>;
  /** The owner of each token account a ticket names (its beneficiary, its `refund_to`). */
  tokenOwner: ReadonlyMap<Address, Address>;
};
type Sponsorship = { sponsor: Address };

/**
 * Every wallet an open `Round`, `RoundTicket` or `Sponsorship` still names,
 * with why: a ticket's payer (its return and rent), funder, the owners of
 * its beneficiary and `refund_to` token accounts (its payout, its refund),
 * its integrator's authority (the app share it accrues, claimed to that
 * authority's share account); a sponsorship's sponsor; a round's rent
 * payer. The sweep must neither close their token accounts nor drain them,
 * and their keys must outlive the run.
 */
export function openReferences(open: OpenAccounts): Map<Address, string[]> {
  const out = new Map<Address, string[]>();
  const note = (w: Address | undefined, why: string) => {
    if (!w || w === SYSTEM_PROGRAM) return;
    out.set(w, [...(out.get(w) ?? []), why]);
  };
  for (const r of open.rounds) note(r.data.rentPayer, `rent payer of round ${r.address}`);
  for (const s of open.sponsorships) note(s.data.sponsor, `sponsor of ${s.address}`);
  for (const t of open.tickets) {
    const d = t.data;
    note(d.payer, `payer of ticket ${t.address}`);
    note(d.funder, `funder of ticket ${t.address}`);
    note(open.tokenOwner.get(d.beneficiary), `beneficiary owner of ticket ${t.address}`);
    note(open.tokenOwner.get(d.refundTo), `refund owner of ticket ${t.address}`);
    note(open.integratorAuthority.get(d.integrator), `integrator authority of ${t.address}`);
  }
  return out;
}

/**
 * What the sweep must keep of `wallet`, and why: nothing when no open
 * account names it and no integrator of its authority is owed shares.
 */
export function sweepHolds(
  wallet: Address,
  integrators: readonly IntegratorShares[],
  references: ReadonlyMap<Address, readonly string[]>,
): string[] {
  const out = [...(references.get(wallet) ?? [])];
  if (!mayCloseShareAccount(wallet, integrators)) out.push("integrator owed app shares");
  return out;
}

/**
 * The share books at the end of a run: nothing held for open tickets, the
 * protocol's shares claimed, `app_shares_owed` the sum of every
 * integrator's accrued shares (invariant), and every integrator still owed
 * one whose share account cannot receive (stranded before this run, its
 * key lost), none of this run's, and no more than at the start.
 */
export function shareBookMismatches(
  vault: Pick<Vault, "beaconSharesHeld" | "protocolSharesAccrued" | "appSharesOwed">,
  integrators: readonly IntegratorShares[],
  runAuthorities: ReadonlySet<Address>,
  owedAtStart: bigint,
): string[] {
  const out: string[] = [];
  if (vault.beaconSharesHeld !== 0n) out.push(`beacon_shares_held ${vault.beaconSharesHeld}`);
  if (vault.protocolSharesAccrued !== 0n)
    out.push(`protocol_shares_accrued ${vault.protocolSharesAccrued} unclaimed`);
  const sum = integrators.reduce((s, i) => s + i.appSharesAccrued, 0n);
  if (sum !== vault.appSharesOwed)
    out.push(`app_shares_owed ${vault.appSharesOwed} != integrators' ${sum}`);
  for (const i of integrators) {
    if (i.appSharesAccrued === 0n) continue;
    if (runAuthorities.has(i.authority))
      out.push(`this run's integrator ${i.address} still owed ${i.appSharesAccrued}`);
    else if (i.shareAccountReceives)
      out.push(`integrator ${i.address} owed ${i.appSharesAccrued} and claimable`);
  }
  if (vault.appSharesOwed > owedAtStart)
    out.push(`app_shares_owed rose from ${owedAtStart} to ${vault.appSharesOwed}`);
  return out;
}

// --- invariants 1 and 2 (Spec 08 §13.8), on the whole instance ---------------------------------

/** An open direct ticket (`Open`, `Requested`) or one whose payout is parked (`PayoutPending`). */
export type DirectTicket = {
  integrator: Address;
  status: TicketStatus;
  vaultCredit: bigint;
  reservedLiability: bigint;
  payout: bigint;
};

/** Every account of the instance the two invariants are sums over. */
export type InstanceState = {
  vault: Pick<
    Vault,
    | "totalAssets"
    | "totalReservedLiability"
    | "openVaultCredits"
    | "beaconSharesHeld"
    | "protocolSharesAccrued"
    | "appSharesOwed"
    | "beaconReturnsOwed"
  >;
  vaultUsdc: bigint;
  payoutEscrow: bigint;
  rounds: readonly Pick<
    Round,
    "status" | "credits" | "liability" | "protocolShares" | "appShares" | "tickets"
  >[];
  tickets: readonly Pick<
    RoundTicket,
    | "status"
    | "integrator"
    | "price"
    | "payout"
    | "liability"
    | "protocolShare"
    | "appShare"
    | "round"
  >[];
  /** Rounds by id, for each ticket's round status. */
  roundStatus: ReadonlyMap<bigint, RoundStatus>;
  direct: readonly DirectTicket[];
  integrators: readonly {
    address: Address;
    reservedLiability: bigint;
    openTickets: bigint;
    appSharesAccrued: bigint;
  }[];
};

/**
 * Invariant 1, `vault_usdc ≥ total_assets + beacon_shares_held +
 * protocol_shares_accrued + app_shares_owed + beacon_returns_owed` and
 * `payout_escrow ≥` every parked payout and return of both paths; and
 * invariant 2, each aggregate the sum it names: open credits and the
 * reservation over open direct tickets and open rounds, the held shares
 * over joined tickets, the returns owed over a refunded round's tickets
 * not yet returned, `app_shares_owed` over the integrators, and each
 * integrator's reservation and open tickets over its open direct tickets
 * and its beacon tickets not yet settled or returned. Every difference,
 * named; empty when both hold.
 */
export function invariantMismatches(s: InstanceState): string[] {
  const out: string[] = [];
  const v = s.vault;
  const books =
    v.totalAssets +
    v.beaconSharesHeld +
    v.protocolSharesAccrued +
    v.appSharesOwed +
    v.beaconReturnsOwed;
  if (s.vaultUsdc < books) out.push(`vault_usdc ${s.vaultUsdc} < the books' ${books}`);
  const open = new Set([
    RoundStatus.Accepting,
    RoundStatus.Paid,
    RoundStatus.Requested,
    RoundStatus.Drawn,
  ]);
  const directOpen = s.direct.filter((t) => t.status !== TicketStatus.PayoutPending);
  const parked =
    s.direct
      .filter((t) => t.status === TicketStatus.PayoutPending)
      .reduce((a, t) => a + t.payout, 0n) +
    s.tickets
      .filter((t) => t.status !== RoundTicketStatus.Joined)
      .reduce((a, t) => a + t.payout, 0n);
  if (s.payoutEscrow < parked) out.push(`payout_escrow ${s.payoutEscrow} < parked ${parked}`);
  const openRounds = s.rounds.filter((r) => open.has(r.status));
  const credits =
    directOpen.reduce((a, t) => a + t.vaultCredit, 0n) +
    openRounds.reduce((a, r) => a + r.credits, 0n);
  if (credits !== v.openVaultCredits)
    out.push(`open_vault_credits ${v.openVaultCredits} != the sum ${credits}`);
  const reserved =
    directOpen.reduce((a, t) => a + t.reservedLiability, 0n) +
    openRounds.reduce((a, r) => a + r.liability, 0n);
  if (reserved !== v.totalReservedLiability)
    out.push(`total_reserved_liability ${v.totalReservedLiability} != the sum ${reserved}`);
  const joined = s.tickets.filter((t) => t.status === RoundTicketStatus.Joined);
  const status = (t: { round: bigint }) => s.roundStatus.get(t.round);
  // What a joined ticket still holds: both shares until its round ends; none
  // once refunded (`refund_round` releases the round's); its app share alone
  // once forfeited (the protocol's are claimable at the expiry, each app
  // share at the ticket's return).
  const held = joined.reduce((a, t) => {
    const st = status(t);
    if (st === RoundStatus.Refunded) return a;
    if (st === RoundStatus.Forfeited) return a + t.appShare;
    return a + t.appShare + t.protocolShare;
  }, 0n);
  if (held !== v.beaconSharesHeld)
    out.push(`beacon_shares_held ${v.beaconSharesHeld} != the sum ${held}`);
  const owedBack = joined
    .filter((t) => status(t) === RoundStatus.Refunded)
    .reduce((a, t) => a + t.price, 0n);
  if (owedBack !== v.beaconReturnsOwed)
    out.push(`beacon_returns_owed ${v.beaconReturnsOwed} != the sum ${owedBack}`);
  const accrued = s.integrators.reduce((a, i) => a + i.appSharesAccrued, 0n);
  if (accrued !== v.appSharesOwed)
    out.push(`app_shares_owed ${v.appSharesOwed} != the integrators' ${accrued}`);
  for (const i of s.integrators) {
    const mine = directOpen.filter((t) => t.integrator === i.address);
    const beacon = joined.filter((t) => t.integrator === i.address);
    const r =
      mine.reduce((a, t) => a + t.reservedLiability, 0n) +
      beacon.reduce((a, t) => a + t.liability, 0n);
    const n = BigInt(mine.length + beacon.length);
    if (r !== i.reservedLiability)
      out.push(`integrator ${i.address}: reserved_liability ${i.reservedLiability} != ${r}`);
    if (n !== i.openTickets)
      out.push(`integrator ${i.address}: open_tickets ${i.openTickets} != ${n}`);
  }
  return out;
}

/** `vault_usdc` and `payout_escrow`'s amounts in a snapshot (0 if missing). */
export const usdcAmount = (s: Snapshot, a: Address, mint: Address) => usdcOf(s, a, mint);

// --- the direct path (V1), as the migration rehearsal drives it on a migrated clone ----------

export type OpenTicketInput = {
  program: Address;
  params: RiskParams;
  outcomes: readonly { p: bigint; m: bigint }[];
  price: bigint;
  appShareBps: bigint;
  nonce: bigint;
  oraoFee: bigint;
  pendingRent: bigint;
  ticketRent: bigint;
  integratorRent: bigint;
  vault: Address;
  vaultUsdc: Address;
  integrator: Address;
  shareAccount: Address;
  protocolTreasury: Address;
  funderUsdc: Address;
  payer: Address;
  ticket: Address;
  vrfPayer: Address;
  beneficiary: Address;
  mint: Address;
  feePayer: Address;
  before: Snapshot;
};

/**
 * What one `open_ticket` moves (Spec 08 §3): the protocol and app shares
 * out of the price to the treasury and the share account, the credit into
 * `vault_usdc`; the ORAO prefund (`2 × fee + rent`) into the ticket's VRF
 * payer, the crank fees and the rent into the ticket, from the payer; the
 * vault's assets, open credits, reservation, volume and counters; the
 * integrator's reservation, open tickets, nonce and volume. Stored: the
 * ticket's admission snapshot.
 */
export function expectOpenTicket(
  i: OpenTicketInput,
  fee: bigint,
  at: { slot: bigint; now: bigint | null },
) {
  const b = i.before;
  const v = vaultIn(b, i.vault);
  const p = i.params;
  const integrator = decodeIn(b, i.integrator, i.program, (d) => getIntegratorDecoder().decode(d));
  const created = integrator === null;
  if (!created && integrator.nextNonce !== i.nonce) throw new Error("WrongNonce");
  const lhs = i.outcomes.reduce((t, o) => t + o.p * o.m, 0n);
  const maxM = i.outcomes.reduce((t, o) => (o.m > t ? o.m : t), 0n);
  const w = admission({
    params: p,
    minPrice: p.minPrice,
    table: { lhs, maxM },
    price: i.price,
    appShareBps: i.appShareBps,
    vault: v,
    integrator,
    now: at.now,
  });
  const prefundLamports = 2n * i.oraoFee + i.pendingRent;
  const crank = p.crankRequestLamports + p.crankSettleLamports;
  const e = blank(b, i.mint);
  add(e.lamports, i.feePayer, -fee);
  const rent = (a: Address, r: bigint) => {
    const t = topUp(r, lamportsOf(b, a));
    add(e.lamports, a, t);
    add(e.lamports, i.payer, -t);
  };
  if (created) rent(i.integrator, i.integratorRent);
  rent(i.ticket, i.ticketRent);
  add(e.lamports, i.ticket, crank);
  add(e.lamports, i.vrfPayer, prefundLamports);
  add(e.lamports, i.payer, -(crank + prefundLamports));
  add(e.usdc, i.funderUsdc, -i.price);
  add(e.usdc, i.protocolTreasury, w.protocolShare);
  add(e.usdc, i.shareAccount, w.appShare);
  add(e.usdc, i.vaultUsdc, w.vaultCredit);
  e.vault.totalAssets += w.vaultCredit;
  e.vault.openVaultCredits += w.vaultCredit;
  e.vault.totalReservedLiability += w.liability;
  e.vault.volumeTotal += i.price;
  if (created) e.vault.integrators += 1n;
  const c = openCounters(v, at.now, 1);
  e.vault.openBeforeClose += c.before;
  e.vault.openAfterClose += c.after;
  addIntegrator(e.integrators, i.integrator, {
    reservedLiability: w.liability,
    openTickets: 1n,
    nextNonce: 1n,
    volumeTotal: i.price,
  });
  const want = {
    status: TicketStatus.Open,
    integrator: i.integrator,
    nonce: i.nonce,
    payer: i.payer,
    beneficiary: i.beneficiary,
    price: i.price,
    vaultCredit: w.vaultCredit,
    payoutMax: w.payoutMax,
    reservedLiability: w.liability,
    cap: w.cap,
    appShareBps: i.appShareBps,
    vaultMarginBps: w.vaultMarginBps,
    openSlot: at.slot,
    expirySlot: at.slot + p.tSettleSlots,
    side: c.side,
    generation: c.generation,
  };
  e.stored = (after) =>
    fieldMismatches(
      "ticket",
      want,
      decodeIn(after, i.ticket, i.program, (d) => getTicketDecoder().decode(d)),
    );
  return { ...e, admitted: w };
}

/**
 * What one `expire_ticket` of a ticket never requested moves (Spec 08 §3):
 * the VRF payer's prefund back to the payer, the settlement crank fee to
 * the caller, the ticket's other lamports to the payer as it closes; the
 * reservation and the credit released (the credit stays in the assets, an
 * after-close gain when its counter calls for it), the ticket out of its
 * counter; the integrator's reservation and open tickets.
 */
export function expectExpireTicket(i: {
  program: Address;
  vault: Address;
  ticket: Address;
  vrfPayer: Address;
  mint: Address;
  caller: Address;
  fee: bigint;
  before: Snapshot;
}) {
  const b = i.before;
  const t = decodeIn(b, i.ticket, i.program, (d) => getTicketDecoder().decode(d));
  if (!t || t.status !== TicketStatus.Open) throw new Error("not an open, unrequested ticket");
  const v = vaultIn(b, i.vault);
  const e = blank(b, i.mint);
  add(e.lamports, i.caller, -i.fee + t.crankSettleLamports);
  const prefunded = lamportsOf(b, i.vrfPayer);
  add(e.lamports, i.vrfPayer, -prefunded);
  const held = lamportsOf(b, i.ticket);
  add(e.lamports, i.ticket, -held);
  add(e.lamports, t.payer, prefunded + held - t.crankSettleLamports);
  e.vault.totalReservedLiability -= t.reservedLiability;
  e.vault.openVaultCredits -= t.vaultCredit;
  const c = releaseCounters(v, t.side, t.generation, 1);
  e.vault.openBeforeClose += c.before;
  e.vault.openAfterClose += c.after;
  if (t.side === SIDE_AFTER && t.generation === v.generation)
    afterCloseResult(e, t.vaultCredit, 0n);
  addIntegrator(e.integrators, t.integrator, {
    reservedLiability: -t.reservedLiability,
    openTickets: -1n,
  });
  e.stored = (after) => (after.get(i.ticket) ? ["ticket: still open after its expiry"] : []);
  return { ...e, ticket: t };
}

/** An SPL mint's supply. */
export function mintSupply(state: AccountState): bigint | null {
  if (!state || state.owner !== TOKEN_PROGRAM || state.data.length !== 82) return null;
  return new DataView(state.data.buffer, state.data.byteOffset, 82).getBigUint64(36, true);
}

const VIRTUAL_SHARES = 1_000n;
const VIRTUAL_ASSETS = 1n;

/**
 * What `strike_epoch` moves on the books and the tokens (Spec 08 §5), for
 * an epoch whose withdrawals are paid in full and with no next epoch
 * queued: the deposits from the deposit queue into `vault_usdc`, the
 * assets paid from it to the payable account, shares minted to the claims
 * account and burnt from the escrow at one price, `(A + 1) / (S + 1000)` on
 * the strike assets; the vault's assets and shares, its after-close
 * results cleared and its close cleared. Lamports (the strike fund's
 * reimbursement and reward) are the caller's and the queue's, and are not
 * read here: none of the accounts read may move a lamport.
 */
export function expectStrike(i: {
  params: RiskParams;
  current: { deposits: bigint; withdrawShares: bigint };
  nextLive: boolean;
  vault: Address;
  vaultUsdc: Address;
  depositQueue: Address;
  payable: Address;
  shareMint: Address;
  shareClaims: Address;
  shareEscrow: Address;
  mint: Address;
  before: Snapshot;
}) {
  const b = i.before;
  const v = vaultIn(b, i.vault);
  if (i.nextLive) throw new Error("a promotion: not predicted here");
  const s = v.totalShares;
  const a = v.totalAssets - v.openVaultCredits + v.afterCloseLoss - v.afterCloseGain;
  const minted = (i.current.deposits * (s + VIRTUAL_SHARES)) / (a + VIRTUAL_ASSETS);
  const owed = (i.current.withdrawShares * (a + VIRTUAL_ASSETS)) / (s + VIRTUAL_SHARES);
  const assets = v.totalAssets + i.current.deposits;
  const committed = v.totalReservedLiability + v.openVaultCredits;
  const p = i.params;
  const forKappa =
    p.kappaBps === 0n
      ? (1n << 64n) - 1n
      : (v.totalReservedLiability * BPS + p.kappaBps - 1n) / p.kappaBps;
  const withdrawable = sat(assets, committed > forKappa ? committed : forKappa);
  if (owed > withdrawable) throw new Error("a rationed strike: not predicted here");
  const paid = owed;
  const burnt = i.current.withdrawShares;
  const e = blank(b, i.mint);
  add(e.usdc, i.depositQueue, -i.current.deposits);
  add(e.usdc, i.vaultUsdc, i.current.deposits - paid);
  add(e.usdc, i.payable, paid);
  e.vault.totalAssets += i.current.deposits - paid;
  e.vault.totalShares += minted - burnt;
  e.vault.afterCloseGain -= v.afterCloseGain;
  e.vault.afterCloseLoss -= v.afterCloseLoss;
  e.vault.closeTs -= v.closeTs;
  const supply = mintSupply(b.get(i.shareMint) ?? null);
  const shareAmount = (st: Snapshot, x: Address) => tokenAccount(st.get(x) ?? null)?.amount ?? 0n;
  e.stored = (after) => {
    const out: string[] = [];
    const supplyAfter = mintSupply(after.get(i.shareMint) ?? null);
    if (supply === null || supplyAfter !== supply + minted - burnt)
      out.push(`share mint supply: expected ${supply! + minted - burnt}, holds ${supplyAfter}`);
    const claims = shareAmount(after, i.shareClaims) - shareAmount(b, i.shareClaims);
    if (claims !== minted) out.push(`share claims: expected +${minted}, moved ${claims}`);
    const escrow = shareAmount(after, i.shareEscrow) - shareAmount(b, i.shareEscrow);
    if (escrow !== -burnt) out.push(`share escrow: expected -${burnt}, moved ${escrow}`);
    return out;
  };
  return { ...e, minted, paid, burnt };
}
