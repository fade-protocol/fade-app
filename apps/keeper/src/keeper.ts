// The keeper's Durable Object: one instance holds every ticket it tracks in its
// SQLite storage and advances them on an alarm, one step a tick, persisting
// each step so that a restart resumes where the last tick stopped.
//
//   queued     Open on chain: request_randomness from open slot + 2; past T_SETTLE, the
//              end directPolicy chooses (record and expire, bind late and settle, refund)
//   requested  Requested, ORAO not yet fulfilled: wait
//   fulfilled  Requested and fulfilled: settle_ticket
//   settled    closed by a settlement (or parked: PayoutPending)
//   expired    closed by expire_ticket past T_SETTLE
//   refunded   closed by refund_expired_ticket: its vault credit back (or parked: PayoutPending
//              with outcome REFUND_OUTCOME)
//   unknown    closed, and no settlement or expiry could be found
//
// Every ~30 s a sweep adds the open tickets nobody posted, strikes the live epoch
// once its close has passed and it is clean, claims struck LP requests, sweeps
// what ORAO refunded to the vrf_payer of a ticket expired with its request
// pending, and reconciles `Vault.ticket_forfeits_withheld` with the expiries it
// read: every direct expiry a withheld draw may explain, read or not, is a critical
// alarm until the operator acknowledges it (DIRECT_ACKNOWLEDGED_WITHHELD), and sets
// the pause recommendation (new tickets, the guardian) that /v1/health and
// /v1/beacon both show.
// Idle, the loop ticks only for that sweep (SWEEP_INTERVAL_MS, derived from
// T_SETTLE below); a posted ticket (POST /v1/tickets, the app) wakes it at once.
import { DurableObject } from "cloudflare:workers";
import {
  getBase58Decoder,
  getBase58Encoder,
  isAddress,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import {
  DEPOSIT_REQUEST_DISCRIMINATOR,
  EPOCH_RECORD_DISCRIMINATOR,
  RANDOMNESS_REQUESTED_EVENT_DISCRIMINATOR,
  REFUND_OUTCOME,
  TICKET_DISCRIMINATOR,
  TICKET_EXPIRED_EVENT_DISCRIMINATOR,
  TICKET_SETTLED_EVENT_DISCRIMINATOR,
  WITHDRAW_REQUEST_DISCRIMINATOR,
  TicketStatus,
  findVaultPda,
  findQueuePda,
  findShareMintPda,
  getClaimDepositInstructionAsync,
  getClaimWithdrawInstructionAsync,
  getDepositRequestDecoder,
  getEpochRecordDecoder,
  getExpireTicketInstructionAsync,
  getRecordTicketEntropyInstruction,
  getRefundExpiredTicketInstructionAsync,
  getSweepTicketVrfInstructionAsync,
  getVaultDecoder,
  getQueueDecoder,
  getRandomnessRequestedEventDecoder,
  getRequestRandomnessInstructionAsync,
  getSettleTicketInstructionAsync,
  getStrikeEpochInstructionAsync,
  getTicketDecoder,
  getTicketSettledEventDecoder,
  getWithdrawRequestDecoder,
  type EpochRecord,
  type Ticket,
} from "../../../clients/js/src/generated/fade/index.ts";
import { getJsonTransaction } from "../../../clients/js/src/transactionFetch.ts";
import { decodeTicketExpired, oraoRefundsTo } from "../../../clients/js/src/direct/index.ts";
import type { AccountRead } from "../../../clients/js/src/beacon/index.ts";
import {
  directAlarm,
  directStep,
  expiryRequestToRead,
  parseWithheldAcknowledgements,
  withheldOrdinal,
  type DirectAlarm,
  type DirectStep,
  type WithheldAcknowledgement,
} from "./directPolicy.ts";
import {
  DEFAULT_RPC_URL,
  EVENT_IX_TAG,
  PROGRAM,
  SLOT_HASHES,
  SYSTEM,
  USDC_MINT,
  ata,
  build,
  cfg,
  decodeBase64,
  describeError,
  epochPda,
  vrfPayerPda,
  errorText,
  eventAuthority,
  makeRpc,
  oraoTreasury,
  rpcStatus,
  sendWire,
  signerFromSecret,
  simulateBuilt,
  sleep,
  startsWith,
  type Rpc,
} from "./chain.ts";
import type { Env } from "./index.ts";

/** Tick period while a ticket is in flight. */
const ACTIVE_INTERVAL_MS = 1_500;
/**
 * How often the sweep finds the open tickets nobody posted (an integrator that
 * does not call POST /v1/tickets; the app does, which wakes this
 * object at once). Derivation (Config `t_settle_slots` 150, 400 ms slots, the
 * fastest the cluster runs): `request_randomness` is accepted from
 * `open_slot + 2` to `open_slot + 150`, and past that anyone may expire a ticket
 * whose randomness never arrived, which forfeits its price (the same cost as a
 * losing draw, whatever it would have drawn). A ticket opened just after a
 * sweep is listed by the next one (30 s, 75 slots, plus about 1 s for the
 * listing) and requested on the tick right after it (about 3 s to confirm):
 * its request lands by `open_slot + 75 + 3 + 8 = open_slot + 86`, leaving ORAO
 * 64 slots, more than Spec 02 §3's 60-slot margin (ORAO took 6 to 8 slots on
 * devnet, once 89). A longer sweep would eat into that margin, so it stays at
 * 30 s. Settlement has no deadline once the randomness is fulfilled (an expiry
 * is then refused), so a late settlement changes no outcome; nor does a late
 * claim (paid at the strike's price).
 */
const SWEEP_INTERVAL_MS = 30_000;
/**
 * Tick period while idle: the sweep's. A tick between two sweeps with nothing
 * in flight has nothing to do; a posted ticket wakes the loop on its own.
 */
const IDLE_INTERVAL_MS = SWEEP_INTERVAL_MS;
/**
 * How old the last read of `Vault.ticket_forfeits_withheld` may be before the direct alarm
 * fails closed: a few sweeps, a 429's skipped round included.
 */
const WITHHELD_READ_MAX_AGE_MS = 5 * SWEEP_INTERVAL_MS;
/** A sent transaction not seen after this long is dropped (its blockhash has expired) and rebuilt. */
const PENDING_TIMEOUT_MS = 75_000;
const RESEND_EVERY_MS = 4_000;
/** Tickets advanced per tick: one getMultipleAccounts holds 100 accounts (ticket + randomness each). */
const MAX_TICKETS_PER_TICK = 40;
/** LP claims sent per sweep. */
const MAX_CLAIMS_PER_SWEEP = 6;
/** Terminal records are kept this long for the app to read, then pruned. */
const MISS_TTL_MS = 5_000;
const RETENTION_MS = 7 * 24 * 3_600_000;
/** How often closed tickets past their retention are deleted. */
const PRUNE_INTERVAL_MS = 3_600_000;
/** An alarm this far in the past is dead; the cron trigger replaces it. */
const STALE_ALARM_MS = 60_000;
/** `fade_math::shares::CHAIN_R_MIN`: a record whose `r_after` is below it (and not 0) splits the chain. */
const CHAIN_R_MIN = 1_000_000_000_000n;

const TICKET_SIZE = 859n;
const DEPOSIT_REQUEST_SIZE = 67n;
const WITHDRAW_REQUEST_SIZE = 115n;
const EPOCH_RECORD_SIZE = 210n;

/**
 * Compute units: a request CPIs into ORAO, a settlement or a refund moves tokens, a late bind
 * is a bind and a settlement in one transaction, an expiry may record the seed first, a
 * vrf_payer sweep is one transfer. Measured in LiteSVM on 23 October 2026: request 33 299,
 * settle 38 143, late bind and settle 57 580, record 13 242 then expire 23 519 (a requested
 * ticket's expiry 20 447), refund 37 037, sweep 11 703; each budget leaves a wide margin. A
 * record alone is the record of the expiry's measure.
 */
const UNITS = {
  record: 60_000,
  request: 200_000,
  settle: 200_000,
  bind: 200_000,
  expire: 100_000,
  refund: 200_000,
  lp: 300_000,
  sweep: 60_000,
} as const;
/**
 * Expired tickets whose vrf_payer the sweep checks per sweep, the least recently checked first.
 * Each sweep is sent without waiting for it to land (the next sweep reads vrf_payer again): the
 * checks cost one getMultipleAccounts, and the sends do not hold back the tickets the same alarm
 * advances.
 */
const MAX_VRF_SWEEPS = 20;
/** Expiries whose `TicketExpired` the sweep reads per sweep: one getTransaction each. */
const MAX_EXPIRY_READS = 5;
/**
 * Outbound fetches one alarm makes at most: every RPC attempt is one, a retry included, and
 * the runtime caps the subrequests of one invocation at this number, past which every fetch
 * throws. The vault
 * read of the direct alarm comes first in the alarm, outside this gate; every other step starts
 * an item only while what the item may spend still fits (`affords`), and leaves the rest to the
 * next alarm.
 */
const SUBREQUEST_LIMIT = 50;
/** Kept back from every gated step: the retries of a call already started. */
const SUBREQUEST_MARGIN = 3;
/** How many of a ticket's newest transactions a lookup of its closure or request reads. */
const TICKET_SIGNATURES = 10;
/** The most one ticket's step spends: a closed ticket's lookup reads its last 10 transactions. */
const TICKET_STEP_SUBREQUESTS = TICKET_SIGNATURES + 1;
/**
 * How many times a closure someone else sent is looked up before the row gives it up, each miss
 * a try (`detail_tries`), as the expiries' events (`readExpiries`) and the payouts' backfill:
 * a load-balanced RPC may not list or serve the transaction for a few seconds, and a miss would
 * lose the vrf_payer sweep and the withheld ordinal's ticket for good.
 */
const CLOSURE_LOOKUP_TRIES = 10;
/** Parked refunds whose expiry is still unfound, looked up again per sweep. */
const MAX_EXPIRY_LOOKUPS = 2;
/** The sweep's listing of the unposted tickets: one getProgramAccounts. */
const LISTING_SUBREQUESTS = 1;
/** One transaction sent: its blockhash, its simulation, its send. */
const SEND_SUBREQUESTS = 3;

export type TicketState =
  "queued" | "requested" | "fulfilled" | "settled" | "expired" | "refunded" | "unknown";
const ACTIVE: readonly TicketState[] = ["queued", "requested", "fulfilled"];
type PendingKind = "request" | "settle" | "bind" | "expire" | "refund";

type Row = {
  address: string;
  state: TicketState;
  source: string;
  open_slot: string | null;
  expiry_slot: string | null;
  randomness: string | null;
  request_sig: string | null;
  settle_sig: string | null;
  expire_sig: string | null;
  /**
   * Read from the ticket while it is open (and when an expiry is sent): what `sweep_ticket_vrf`
   * names, whoever expires the ticket.
   */
  integrator: string | null;
  nonce: string | null;
  /** 1 once expired with its request pending: ORAO's refund will reach vrf_payer. */
  vrf_sweep: number;
  /** When the sweep last checked its vrf_payer (ms; 0 never): the sweep's queue order. */
  vrf_checked_at: number;
  /**
   * The `ticket_forfeits_withheld` ordinal its version-2 `TicketExpired` carries when the
   * expiry counts as withheld, "0" when it does not; null until that event is read.
   */
  withheld: string | null;
  outcome: number | null;
  payout: string | null;
  pending_kind: PendingKind | null;
  pending_sig: string | null;
  pending_wire: string | null;
  pending_sent_at: number | null;
  pending_resent_at: number | null;
  attempts: number;
  next_try_at: number;
  last_error: string | null;
  detail_tries: number;
  created_at: number;
  updated_at: number;
};

export type TicketView = {
  state: TicketState;
  openSlot?: number;
  requestSignature?: string;
  settleSignature?: string;
  expireSignature?: string;
  outcome?: number;
  payout?: string;
  /** ISO 8601. */
  updatedAt: string;
};

export type Health = {
  keeper: string;
  lamports: string;
  lastTick: number;
  queue: number;
  /**
   * The direct path's alarm (`directPolicy.directAlarm`): every direct expiry
   * `Vault.ticket_forfeits_withheld` counts is critical until the operator acknowledges it, and
   * a vault unreadable, or not read for a few sweeps, fails closed. Never pruned, never cleared
   * by time.
   */
  directWithheld?: DirectAlarm;
  /**
   * The guardian should pause new tickets (Spec 02 §7, Spec 09 §10): the direct alarm here; the
   * Worker's route ORs in the beacon's (`combinedPause`), so that /v1/health and /v1/beacon
   * show the same flag.
   */
  pauseRecommended?: boolean;
  /** Set when the upstream RPC could not be read. */
  rpcError?: string;
};

export type EnqueueResult =
  { ok: true; state: TicketState } | { ok: false; status: number; error: string };

const b58 = (bytes: ArrayLike<number>) => getBase58Decoder().decode(Uint8Array.from(bytes));
const backoff = (attempts: number) => Math.min(1_000 * 2 ** attempts, 60_000);

/** A row as the API shows it. */
function view(r: Row): TicketView {
  const v: TicketView = { state: r.state, updatedAt: new Date(r.updated_at).toISOString() };
  if (r.open_slot !== null) v.openSlot = Number(r.open_slot);
  if (r.request_sig !== null) v.requestSignature = r.request_sig;
  if (r.settle_sig !== null) v.settleSignature = r.settle_sig;
  if (r.expire_sig !== null) v.expireSignature = r.expire_sig;
  if (r.outcome !== null) v.outcome = r.outcome;
  if (r.payout !== null) v.payout = r.payout;
  return v;
}

function decodeTicket(data: Uint8Array): Ticket | null {
  if (!startsWith(data, TICKET_DISCRIMINATOR) || BigInt(data.length) !== TICKET_SIZE) return null;
  try {
    return getTicketDecoder().decode(data);
  } catch {
    return null;
  }
}

type JsonTx = {
  meta: {
    err: unknown;
    innerInstructions?:
      readonly { instructions: readonly { programIdIndex: number; data: string }[] }[] | null;
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null;
  } | null;
  transaction: { message: { accountKeys: readonly string[] } };
};

type Closure =
  | { kind: "settled"; outcome: number; payout: bigint }
  | {
      kind: "expired";
      refunded: boolean;
      withheld: bigint | null;
      /** Version 2's `pending`: ORAO's rent refund will reach the ticket's vrf_payer. */
      pending: boolean;
    }
  /** Its `request_randomness`: the ORAO request the ticket was bound to. */
  | { kind: "requested"; request: string }
  | null;

/**
 * The settlement, expiry or request of `ticket` in a transaction, from its `emit_cpi!` events.
 * A closure outranks a request: a late bind sends `request_randomness` and `settle_ticket` in
 * one transaction, whose `RandomnessRequested` comes before its `TicketSettled`, so the request
 * is returned only when the transaction closes nothing.
 */
function closureOf(tx: JsonTx, ticket: string): Closure {
  if (!tx.meta || tx.meta.err) return null;
  let requested: Closure = null;
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== PROGRAM) continue;
      const data = new Uint8Array(getBase58Encoder().encode(ix.data));
      if (!startsWith(data, EVENT_IX_TAG)) continue;
      const body = data.subarray(8);
      try {
        if (startsWith(body, TICKET_SETTLED_EVENT_DISCRIMINATOR)) {
          const e = getTicketSettledEventDecoder().decode(body);
          if (e.ticket === ticket) return { kind: "settled", outcome: e.outcome, payout: e.payout };
        } else if (startsWith(body, TICKET_EXPIRED_EVENT_DISCRIMINATOR)) {
          const e = decodeTicketExpired(body);
          if (e.ticket === ticket)
            return {
              kind: "expired",
              refunded: e.version === 2 && e.refunded,
              withheld: e.version === 2 ? (withheldOrdinal(e) ?? 0n) : null,
              pending: e.version === 2 && e.pending,
            };
        } else if (startsWith(body, RANDOMNESS_REQUESTED_EVENT_DISCRIMINATOR)) {
          const e = getRandomnessRequestedEventDecoder().decode(body);
          if (e.ticket === ticket) requested ??= { kind: "requested", request: e.request };
        }
      } catch {
        // not a decodable Fade event
      }
    }
  }
  return requested;
}

export class Keeper extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly rpc: Rpc;
  private readonly apiRpc: Rpc;
  private signerPromise: Promise<KeyPairSigner> | null = null;
  private treasury: Address | null = null;
  private lastTick = 0;
  private lastSweep = 0;
  /**
   * Set when a due sweep could not afford its listing of the unposted tickets: the next alarm
   * lists them, rather than the next sweep a full `SWEEP_INTERVAL_MS` later.
   */
  private listingOwed = false;
  private lastPrune = 0;
  /**
   * Outbound fetches the current alarm has made (`SUBREQUEST_LIMIT`): the alarm's own client
   * (`rpc`) counts them; the API's calls go through `apiRpc`, which Cloudflare bills to their
   * own invocations, and draw nothing from it.
   */
  private spent = 0;
  private balance: { lamports: bigint; at: number } | null = null;
  private readonly acknowledged: WithheldAcknowledgement[];
  private readonly acknowledgementError: string | null;
  /** Addresses a lookup found no account at, until when. */
  private readonly misses = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.rpc = makeRpc(env.RPC_URL || DEFAULT_RPC_URL, undefined, () => this.spent++);
    this.apiRpc = makeRpc(env.RPC_URL || DEFAULT_RPC_URL);
    const acks = parseWithheldAcknowledgements(env.DIRECT_ACKNOWLEDGED_WITHHELD);
    this.acknowledged = acks.acknowledged;
    this.acknowledgementError = acks.error;
    if (acks.error) console.error(acks.error);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tickets (
      address TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      source TEXT NOT NULL,
      open_slot TEXT,
      expiry_slot TEXT,
      randomness TEXT,
      request_sig TEXT,
      settle_sig TEXT,
      expire_sig TEXT,
      outcome INTEGER,
      payout TEXT,
      pending_kind TEXT,
      pending_sig TEXT,
      pending_wire TEXT,
      pending_sent_at INTEGER,
      pending_resent_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_try_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      detail_tries INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // Columns added since the table was first created: ALTER TABLE fails once they exist.
    for (const column of [
      "integrator TEXT",
      "nonce TEXT",
      "vrf_sweep INTEGER NOT NULL DEFAULT 0",
      "withheld TEXT",
      "vrf_checked_at INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        this.sql.exec(`ALTER TABLE tickets ADD COLUMN ${column}`);
      } catch {
        // already there
      }
    }
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS keeper_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    // Every direct expiry read that counts as withheld, by its ordinal; never pruned, so that
    // the reconciliation with `Vault.ticket_forfeits_withheld` holds over the whole history.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS direct_withheld (
        ordinal INTEGER PRIMARY KEY,
        ticket TEXT NOT NULL,
        refunded INTEGER NOT NULL,
        at INTEGER NOT NULL
      )`,
    );
    // The sweep's queue, least recently checked first, holding only rows it can sweep: their
    // request is not needed to send a sweep (a row that never named it is looked up, and kept
    // queued by its vrf_payer alone when that fails).
    this.sql.exec("DROP INDEX IF EXISTS tickets_vrf_sweep");
    this.sql.exec("DROP INDEX IF EXISTS tickets_vrf_queue");
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS tickets_vrf_due ON tickets (vrf_checked_at)
       WHERE vrf_sweep = 1 AND integrator IS NOT NULL AND nonce IS NOT NULL`,
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS tickets_expiry_unread ON tickets (updated_at)
       WHERE state IN ('expired', 'refunded') AND withheld IS NULL AND expire_sig IS NOT NULL
         AND detail_tries < 10`,
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS tickets_expiry_unfound ON tickets (updated_at)
       WHERE state IN ('expired', 'refunded') AND expire_sig IS NULL AND detail_tries < 10`,
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS tickets_state ON tickets (state)");
    // The loop reads only what it works on: open tickets by state and age, and settled ones
    // still missing their payout through a partial index. Without these the loop's query
    // scanned the whole table (every ticket kept for RETENTION_MS) on each tick, millions of
    // rows a day, and ran the account into its daily read limit.
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS tickets_state_created ON tickets (state, created_at)",
    );
    // the retention prune reads only the rows it deletes
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS tickets_state_updated ON tickets (state, updated_at)",
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS tickets_missing_payout ON tickets (created_at)
       WHERE state = 'settled' AND payout IS NULL AND settle_sig IS NOT NULL AND detail_tries < 10`,
    );
  }

  // --- API (called by the Worker through the stub) --------------------------------------

  /** Validates that `ticket` is a Fade ticket account and queues it. */
  async enqueue(ticket: string, source = "post"): Promise<EnqueueResult> {
    if (!isAddress(ticket)) return { ok: false, status: 400, error: "not a base58 address" };
    const existing = this.row(ticket);
    if (existing && ACTIVE.includes(existing.state)) {
      await this.ensureAlarm(true);
      return { ok: true, state: existing.state };
    }
    // The app posts right after its open confirms: give a lagging RPC node a moment.
    // A lookup (a GET of an untracked address) reads once, and remembers a miss briefly.
    const lookup = source === "lookup";
    if (lookup && (this.misses.get(ticket) ?? 0) > Date.now())
      return { ok: false, status: 404, error: "account not found" };
    let found: { owner: string; data: Uint8Array } | null = null;
    for (let i = 0; i < (lookup ? 1 : 3) && !found; i++) {
      if (i) await sleep(1_000);
      const { value } = await this.apiRpc
        .getAccountInfo(ticket, { encoding: "base64", commitment: "confirmed" })
        .send();
      if (value) found = { owner: value.owner, data: decodeBase64(value.data[0]) };
    }
    if (!found) {
      if (existing) return { ok: true, state: existing.state };
      if (this.misses.size > 10_000) this.misses.clear();
      this.misses.set(ticket, Date.now() + MISS_TTL_MS);
      return { ok: false, status: 404, error: "account not found" };
    }
    const w = found.owner === PROGRAM ? decodeTicket(found.data) : null;
    if (!w) return { ok: false, status: 422, error: "not a Fade ticket account" };
    this.track(ticket, w, source);
    await this.ensureAlarm(true);
    return { ok: true, state: this.row(ticket)?.state ?? "queued" };
  }

  /** The keeper's record of `ticket`; an untracked ticket still open on chain is queued on the way. */
  async status(ticket: string): Promise<TicketView> {
    if (!isAddress(ticket)) return { state: "unknown", updatedAt: new Date().toISOString() };
    const r = this.row(ticket);
    if (r) return view(r);
    const res = await this.enqueue(ticket, "lookup").catch(() => null);
    const after = this.row(ticket);
    if (res?.ok && after) return view(after);
    return { state: "unknown", updatedAt: new Date().toISOString() };
  }

  async health(): Promise<Health> {
    await this.ensureAlarm(false);
    const signer = await this.signer();
    let rpcError: string | undefined;
    if (!this.balance || Date.now() - this.balance.at > 10_000) {
      try {
        const { value } = await this.apiRpc
          .getBalance(signer.address, { commitment: "confirmed" })
          .send();
        this.balance = { lamports: value, at: Date.now() };
      } catch (e) {
        rpcError = describeError(e);
      }
    }
    const alarm = this.directWithheld();
    return {
      keeper: signer.address,
      lamports: this.balance ? this.balance.lamports.toString() : "unknown",
      lastTick: this.lastTick,
      queue: this.activeCount(),
      directWithheld: alarm,
      pauseRecommended: alarm.pauseRecommended,
      ...(rpcError ? { rpcError } : {}),
    };
  }

  /** The direct path's pause recommendation, for /v1/beacon's combined flag. */
  async directPause(): Promise<boolean> {
    return this.directWithheld().pauseRecommended;
  }

  /** Called by the cron trigger: restarts the loop should its alarm ever be lost. */
  async ensureAlarm(soon: boolean): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const target = Date.now() + (soon ? 0 : IDLE_INTERVAL_MS);
    // an alarm left in the past (its handler kept failing, e.g. over a platform limit) never
    // fires again on its own: replace it
    if (current === null || current > target || current < Date.now() - STALE_ALARM_MS)
      await this.ctx.storage.setAlarm(target);
  }

  // --- the loop -----------------------------------------------------------------------

  override async alarm(): Promise<void> {
    this.spent = 0;
    try {
      await this.tick();
    } catch (e) {
      console.error(`tick failed: ${describeError(e)}`);
    } finally {
      // a listing the alarm could not afford is owed to the next alarm, not to the next sweep
      const delay =
        this.activeCount() > 0 || this.listingOwed ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
      const current = await this.ctx.storage.getAlarm();
      const target = Date.now() + delay;
      if (current === null || current > target) await this.ctx.storage.setAlarm(target);
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    this.lastTick = now;
    const open = this.sql
      .exec<Row>(
        `SELECT * FROM tickets WHERE state IN ('queued', 'requested', 'fulfilled')
         ORDER BY created_at LIMIT ?`,
        MAX_TICKETS_PER_TICK,
      )
      .toArray();
    const missing =
      open.length < MAX_TICKETS_PER_TICK
        ? this.sql
            .exec<Row>(
              `SELECT * FROM tickets INDEXED BY tickets_missing_payout
               WHERE state = 'settled' AND payout IS NULL AND settle_sig IS NOT NULL AND detail_tries < 10
               ORDER BY created_at LIMIT ?`,
              MAX_TICKETS_PER_TICK - open.length,
            )
            .toArray()
        : [];
    const rows = [...open, ...missing];
    const sweepDue = now - this.lastSweep >= SWEEP_INTERVAL_MS;
    const listingDue = sweepDue || this.listingOwed;
    // The direct alarm's vault read comes before any other work of the alarm: whatever the rest
    // spends of the alarm's subrequests, the counter is read.
    if (sweepDue) await this.readWithheldCounter();
    // the listing's subrequest is kept back from the payouts' backfill
    if (rows.length) await this.advance(rows, listingDue ? LISTING_SUBREQUESTS : 0);
    if (!sweepDue && this.listingOwed) {
      try {
        this.listingOwed = !(await this.sweepTickets());
      } catch (e) {
        this.listingOwed = false; // the listing ran: the next sweep lists again
        console.error(`listing failed: ${describeError(e)}`);
      }
    }
    if (sweepDue) {
      this.lastSweep = now;
      try {
        await this.sweep();
      } catch (e) {
        console.error(`sweep failed: ${describeError(e)}`);
        if (rpcStatus(e) === 429) this.lastSweep = now + SWEEP_INTERVAL_MS; // back off a round
      }
      if (now - this.lastPrune >= PRUNE_INTERVAL_MS) {
        this.lastPrune = now;
        this.sql.exec(
          "DELETE FROM tickets WHERE state IN ('settled', 'expired', 'refunded', 'unknown') AND updated_at < ?",
          now - RETENTION_MS,
        );
      }
    }
  }

  /**
   * One tick's work on `rows`: the transactions in flight first, then the steps with a deadline
   * (requests, expiries) and settlements, and last the payouts settled rows still miss, which
   * have none and leave `reserve` subrequests to the rest of the alarm.
   */
  private async advance(rows: Row[], reserve = 0): Promise<void> {
    const now = Date.now();

    // 1. Transactions in flight: confirmed, failed, or still to resend.
    const inFlight = rows.filter((r) => r.pending_sig);
    if (inFlight.length) {
      const { value } = await this.rpc
        .getSignatureStatuses(inFlight.map((r) => r.pending_sig as Signature))
        .send();
      for (const [i, r] of inFlight.entries()) {
        const st = value[i];
        if (st?.err) {
          this.failPending(r, `${r.pending_kind} failed on chain: ${errorText(st.err)}`);
        } else if (
          st?.confirmationStatus === "confirmed" ||
          st?.confirmationStatus === "finalized"
        ) {
          this.confirmPending(r);
        } else if (now - (r.pending_sent_at ?? 0) > PENDING_TIMEOUT_MS) {
          this.failPending(r, `${r.pending_kind} not confirmed in time`);
        } else if (
          now - (r.pending_resent_at ?? 0) > RESEND_EVERY_MS &&
          r.pending_wire &&
          this.affords(1)
        ) {
          await sendWire(this.rpc, r.pending_wire, true).catch(() => undefined);
          this.sql.exec(
            "UPDATE tickets SET pending_resent_at = ? WHERE address = ?",
            now,
            r.address,
          );
        }
      }
    }

    // 2. Everything else, the steps with a deadline included.
    await this.advanceActive(rows, now);

    // 3. Settled tickets still missing their outcome and payout: no deadline, so after the
    // rest, and only with what the alarm keeps back for its sweep left over.
    for (const r of rows) {
      const fresh = this.row(r.address);
      if (
        fresh?.state === "settled" &&
        fresh.payout === null &&
        fresh.settle_sig &&
        this.affords(1 + reserve)
      )
        await this.fillClosure(fresh, fresh.settle_sig).catch(() => undefined);
    }
  }

  /** The active rows' steps, from one read of the chain. */
  private async advanceActive(rows: Row[], now: number): Promise<void> {
    // Everything else, from one read of the chain (and one more for the request address
    // of each Open ticket past its expiry, derived from what the first read holds, and for the
    // bound request of a Requested ticket whose row did not name it: one someone else sent).
    const todo = rows
      .map((r) => this.row(r.address))
      .filter((r): r is Row => !!r && ACTIVE.includes(r.state) && !r.pending_sig);
    if (!todo.length) return;
    const needsHashes = todo.some((r) => r.state === "queued");
    const keys: Address[] = todo.map((r) => r.address as Address);
    const randomnessAt = new Map<string, number>();
    for (const r of todo) {
      if (r.randomness && r.randomness !== SYSTEM) {
        randomnessAt.set(r.address, keys.length);
        keys.push(r.randomness as Address);
      }
    }
    const hashesAt = needsHashes ? keys.push(SLOT_HASHES) - 1 : -1;
    const { context, value: accounts } = await this.rpc
      .getMultipleAccounts(keys, { encoding: "base64", commitment: "confirmed" })
      .send();
    const slot = context.slot;
    const hashesAcc = hashesAt >= 0 ? accounts[hashesAt] : null;
    const slotHashes = hashesAcc ? decodeBase64(hashesAcc.data[0]) : null;
    const readOf = (address: Address, acc: (typeof accounts)[number]): AccountRead | null =>
      acc ? { address, owner: acc.owner, data: decodeBase64(acc.data[0]) } : null;

    const tickets = new Map<string, Ticket | null>();
    const derived = new Map<string, Address>();
    for (const [i, r] of todo.entries()) {
      const acc = accounts[i];
      const w = acc && acc.owner === PROGRAM ? decodeTicket(decodeBase64(acc.data[0])) : null;
      tickets.set(r.address, w);
      if (!w) continue;
      if (w.status === TicketStatus.Requested) {
        if (r.randomness !== w.randomness) derived.set(r.address, w.randomness);
        continue;
      }
      const request = await expiryRequestToRead(
        { address: r.address as Address, data: w },
        slot,
        slotHashes,
        cfg,
      );
      if (request) derived.set(r.address, request);
    }
    const derivedReads = new Map<string, AccountRead | null>();
    if (derived.size) {
      const list = [...derived.values()];
      const { value } = await this.rpc
        .getMultipleAccounts(list, { encoding: "base64", commitment: "confirmed" })
        .send();
      list.forEach((a, k) => derivedReads.set(a, readOf(a, value[k] ?? null)));
    }

    for (const [i, r] of todo.entries()) {
      if (!this.affords(TICKET_STEP_SUBREQUESTS)) break; // the rest on the next alarm
      try {
        if (!accounts[i]) {
          // a miss backs off (`resolveClosed`): its tries span minutes, not three ticks
          if (now >= r.next_try_at) await this.resolveClosed(r);
          continue;
        }
        const w = tickets.get(r.address);
        if (!w) {
          this.update(r.address, { state: "unknown", last_error: "not a Fade ticket" });
          continue;
        }
        this.syncFromChain(r, w);
        if (now < r.next_try_at) continue;

        if (w.status === TicketStatus.PayoutPending) {
          if (w.outcome === REFUND_OUTCOME) {
            // a refund parked for a beneficiary who could not receive it: no draw ran
            // (someone else sent it): its `TicketExpired` names its withheld ordinal. Missed
            // here (the RPC does not serve it yet), it is looked up again by the sweep
            // (`findUnfoundExpiries`).
            if (!r.expire_sig) await this.findExpiry(r).catch(() => false);
            this.update(r.address, { state: "refunded", payout: w.payout.toString() });
          } else {
            this.update(r.address, {
              state: "settled",
              outcome: w.outcome,
              payout: w.payout.toString(),
            });
          }
          continue;
        }
        // the request the ticket names: from the first read when the row named it, from the
        // follow-up read otherwise (`derived`)
        const ri = randomnessAt.get(r.address);
        const d = derived.get(r.address);
        const request = d
          ? (derivedReads.get(d) ?? null)
          : w.status === TicketStatus.Requested && ri !== undefined
            ? readOf(w.randomness, accounts[ri] ?? null)
            : null;
        const step = await directStep(
          { address: r.address as Address, data: w },
          slot,
          slotHashes,
          request,
          cfg,
        );
        if (step.kind === "wait") {
          this.setState(r, w.status === TicketStatus.Requested ? "requested" : "queued");
        } else {
          if (step.kind === "settle") this.setState(r, "fulfilled");
          await this.act(r, step, w);
        }
      } catch (e) {
        this.recordError(r, describeError(e));
        if (rpcStatus(e) === 429) break; // leave the rest to the next tick
      }
    }
  }

  /** Builds, sends (with preflight) and records one ticket transaction. */
  private async act(r: Row, step: Exclude<DirectStep, { kind: "wait" }>, w: Ticket): Promise<void> {
    const signer = await this.signer();
    const common = { eventAuthority: await eventAuthority(), program: PROGRAM };
    const ticket = r.address as Address;
    const request = async (randomness: Address) => {
      this.treasury ??= await oraoTreasury(this.rpc);
      return getRequestRandomnessInstructionAsync(
        { caller: signer, ticket, oraoTreasury: this.treasury, request: randomness, ...common },
        cfg,
      );
    };
    const settle = (randomness: Address) =>
      getSettleTicketInstructionAsync(
        {
          caller: signer,
          integrator: w.integrator,
          ticket,
          randomness,
          beneficiary: w.beneficiary,
          payer: w.payer,
          usdcMint: USDC_MINT,
          ...common,
        },
        cfg,
      );
    const ixs: Instruction[] = [];
    switch (step.kind) {
      case "request":
        // The seed is recorded on its own transaction first, whatever becomes of the request
        // (refused at preflight, failed on chain, dropped): an Open ticket's end then never
        // depends on SlotHashes still proving `s*` when it expires (see `refund_expired_ticket`).
        if (step.record) await this.recordEntropy(ticket, common);
        ixs.push(await request(step.request));
        break;
      case "settle":
        ixs.push(await settle(step.request));
        break;
      case "bind":
        // a request someone created at the seed, fulfilled after the window: bound and
        // settled in one transaction (settlement has no deadline)
        ixs.push(await request(step.request), await settle(step.request));
        break;
      case "expire":
        if (step.record) ixs.push(getRecordTicketEntropyInstruction({ ticket, ...common }, cfg));
        ixs.push(
          await getExpireTicketInstructionAsync(
            {
              caller: signer,
              integrator: w.integrator,
              ticket,
              randomness: step.request,
              payer: w.payer,
              ...common,
            },
            cfg,
          ),
        );
        break;
      case "refund":
        ixs.push(
          await getRefundExpiredTicketInstructionAsync(
            {
              caller: signer,
              integrator: w.integrator,
              ticket,
              beneficiary: w.beneficiary,
              payer: w.payer,
              usdcMint: USDC_MINT,
              ...common,
            },
            cfg,
          ),
        );
        break;
    }
    const tx = await build(this.rpc, signer, ixs, UNITS[step.kind]);
    try {
      await sendWire(this.rpc, tx.wire);
    } catch (e) {
      // a refused request may be ORAO's treasury rotated: read it again on the next try
      if (step.kind === "request" || step.kind === "bind") this.treasury = null;
      throw e;
    }
    const now = Date.now();
    this.update(r.address, {
      pending_kind: step.kind,
      pending_sig: tx.signature,
      pending_wire: tx.wire,
      pending_sent_at: now,
      pending_resent_at: now,
      ...(step.kind === "request" || step.kind === "bind" ? { randomness: step.request } : {}),
      ...(step.kind === "expire"
        ? {
            integrator: w.integrator,
            nonce: w.nonce.toString(),
            vrf_sweep: step.pending ? 1 : 0,
          }
        : {}),
    });
    console.log(`${step.kind} ${r.address}: sent ${tx.signature}`);
  }

  private confirmPending(r: Row): void {
    const sig = r.pending_sig;
    const cleared = {
      pending_kind: null,
      pending_sig: null,
      pending_wire: null,
      pending_sent_at: null,
      pending_resent_at: null,
      attempts: 0,
      next_try_at: 0,
      last_error: null,
    };
    if (r.pending_kind === "request") {
      this.update(r.address, { ...cleared, state: "requested", request_sig: sig });
    } else if (r.pending_kind === "settle" || r.pending_kind === "bind") {
      this.update(r.address, { ...cleared, state: "settled", settle_sig: sig });
    } else if (r.pending_kind === "refund") {
      this.update(r.address, { ...cleared, state: "refunded", expire_sig: sig });
    } else {
      this.update(r.address, { ...cleared, state: "expired", expire_sig: sig });
    }
    console.log(`${r.pending_kind} ${r.address}: confirmed ${sig}`);
  }

  /**
   * Sends `record_ticket_entropy` alone without waiting for it to land, ahead of the request
   * that records the same seed: whichever lands second changes nothing (a recorded ticket is
   * left as it is; a requested one refuses the record, and the simulation keeps it unsent).
   * Never throws: the request is sent whatever becomes of the record.
   */
  private async recordEntropy(
    ticket: Address,
    common: { eventAuthority: Address; program: Address },
  ): Promise<void> {
    try {
      await this.sendUnconfirmed(
        getRecordTicketEntropyInstruction({ ticket, ...common }, cfg),
        `record ${ticket}`,
        "record",
      );
    } catch (e) {
      console.warn(`record ${ticket}: ${describeError(e)}`);
    }
  }

  private failPending(r: Row, error: string): void {
    if (r.pending_kind === "request" || r.pending_kind === "bind") this.treasury = null;
    this.update(r.address, {
      pending_kind: null,
      pending_sig: null,
      pending_wire: null,
      pending_sent_at: null,
      pending_resent_at: null,
      attempts: r.attempts + 1,
      next_try_at: Date.now() + backoff(r.attempts),
      last_error: error,
    });
    console.warn(`${r.address}: ${error}`);
  }

  private recordError(r: Row, error: string): void {
    this.update(r.address, {
      attempts: r.attempts + 1,
      next_try_at: Date.now() + backoff(r.attempts),
      last_error: error,
    });
    console.warn(`${r.address}: ${error}`);
  }

  /** The ticket account is gone: find who closed it, and how. */
  private async resolveClosed(r: Row): Promise<void> {
    if (r.settle_sig) return this.update(r.address, { state: "settled" });
    // A row the keeper re-tracked before track() kept a closed row's state: its expiry's event
    // says whether it was a refund (findExpiry reads it), the signature alone does not.
    if (await this.findExpiry(r)) return;
    const tries = r.detail_tries + 1;
    this.update(r.address, {
      detail_tries: tries,
      next_try_at: Date.now() + backoff(tries),
      ...(tries >= CLOSURE_LOOKUP_TRIES
        ? { state: "unknown" as const, last_error: "closed, outcome not found" }
        : {}),
    });
  }

  /**
   * Parked refunds whose expiry `findExpiry` missed when the keeper read them (the RPC did not
   * serve the transaction yet, or a 429), looked up again each sweep until found or out of
   * tries: the expiry names the withheld ordinal and, from its `pending`, queues the vrf_payer
   * sweep. Bookkeeping: `updated_at` is left as it was.
   */
  private async findUnfoundExpiries(): Promise<void> {
    const rows = this.sql
      .exec<Row>(
        `SELECT * FROM tickets INDEXED BY tickets_expiry_unfound
         WHERE state IN ('expired', 'refunded') AND expire_sig IS NULL AND detail_tries < 10
         ORDER BY updated_at LIMIT ?`,
        MAX_EXPIRY_LOOKUPS,
      )
      .toArray();
    for (const r of rows) {
      if (!this.affords(TICKET_STEP_SUBREQUESTS)) break;
      // a failed read spends a try too, or a row that keeps failing would hold the queue
      if (!(await this.findExpiry(r).catch(() => false)))
        this.update(r.address, { detail_tries: r.detail_tries + 1 }, false);
    }
  }

  /**
   * Looks the ticket's settlement or expiry up in its newest transactions and records it: true
   * once found. Used for a closed ticket, and for a refund parked in escrow that someone else
   * sent (its ticket remains, so its `TicketExpired` is what names its withheld ordinal). An
   * expiry whose event says its request was pending puts the row on the vrf_payer sweep's
   * queue, with the integrator and nonce `syncFromChain` read while the ticket was open, and
   * the request it was bound to: the row's, or, when the row never saw the ticket Requested
   * (someone else sent the request), the `RandomnessRequested` among its older transactions.
   */
  private async findExpiry(r: Row): Promise<boolean> {
    const sigs = await this.rpc
      .getSignaturesForAddress(r.address as Address, {
        limit: TICKET_SIGNATURES,
        commitment: "confirmed",
      })
      .send();
    for (const [i, s] of sigs.entries()) {
      if (s.err !== null) continue;
      const tx = await this.fetchTx(s.signature);
      const o = tx ? closureOf(tx, r.address) : null;
      if (o?.kind === "settled") {
        this.update(r.address, {
          state: "settled",
          settle_sig: s.signature,
          outcome: o.outcome,
          payout: o.payout.toString(),
        });
        return true;
      }
      if (o?.kind === "expired") {
        const request =
          o.pending && !r.randomness
            ? await this.requestIn(r.address, sigs.slice(i + 1)).catch(() => null)
            : null;
        this.update(r.address, {
          state: o.refunded ? "refunded" : "expired",
          expire_sig: s.signature,
          ...(o.withheld !== null ? { withheld: o.withheld.toString() } : {}),
          // an expiry someone else sent (a slot leader ordering it ahead of a late fulfil, say)
          // leaves ORAO's rent refund to vrf_payer as the keeper's own does: queued for the sweep
          ...(o.pending ? { vrf_sweep: 1 } : {}),
          ...(request ? { randomness: request } : {}),
        });
        return true;
      }
    }
    return false;
  }

  /**
   * The ORAO request `ticket` was bound to, from the `RandomnessRequested` among `sigs` (its
   * transactions, newest first; read again when not given): null when none of them holds it.
   */
  private async requestIn(
    ticket: string,
    sigs?: readonly { signature: Signature; err: unknown }[],
  ): Promise<string | null> {
    const list =
      sigs ??
      (await this.rpc
        .getSignaturesForAddress(ticket as Address, {
          limit: TICKET_SIGNATURES,
          commitment: "confirmed",
        })
        .send());
    for (const s of list) {
      if (s.err !== null) continue;
      if (!this.affords(1)) return null;
      const tx = await this.fetchTx(s.signature);
      const o = tx ? closureOf(tx, ticket) : null;
      if (o?.kind === "requested") return o.request;
    }
    return null;
  }

  /** Outcome and payout of a settlement, from its TicketSettled event. */
  private async fillClosure(r: Row, sig: string): Promise<void> {
    const tx = await this.fetchTx(sig as Signature);
    const o = tx ? closureOf(tx, r.address) : null;
    if (o?.kind === "settled")
      this.update(r.address, { outcome: o.outcome, payout: o.payout.toString() });
    else this.update(r.address, { detail_tries: r.detail_tries + 1 });
  }

  /** A transaction as JSON, whatever its version; null while the RPC does not serve it. */
  private fetchTx(sig: Signature): Promise<JsonTx | null> {
    return getJsonTransaction<JsonTx>(this.rpc, sig, "confirmed");
  }

  // --- the sweep ----------------------------------------------------------------------

  /**
   * The sweep's steps, after the tick read the vault's withheld counter. The expiries' events
   * are read and the withheld ordinals recorded whichever earlier step throws (the tick still
   * sees that error, and backs off on a 429).
   */
  private async sweep(): Promise<void> {
    try {
      this.listingOwed = false; // a listing that throws has run: the next sweep lists again
      this.listingOwed = !(await this.sweepTickets());
      await this.strike();
      await this.claims();
      await this.sweepVrfPayers();
    } finally {
      await this.readExpiries();
      await this.findUnfoundExpiries();
      this.reconcileWithheld();
    }
  }

  /** Whether a step that may spend `n` more subrequests still fits in this alarm. */
  private affords(n: number): boolean {
    return this.spent + n <= SUBREQUEST_LIMIT - SUBREQUEST_MARGIN;
  }

  /**
   * The `TicketExpired` of the keeper's own expiries and refunds: whether each counts as
   * withheld, and whether its request was pending (the vrf_payer sweep's queue). A version-1 event (an expiry before the program's upgrade) predates the counter,
   * so it accounts for no ordinal: recorded as "0" at once rather than read again. These writes
   * are bookkeeping and leave `updated_at`, which the retention prune reads, as it was.
   */
  private async readExpiries(): Promise<void> {
    const rows = this.sql
      .exec<Row>(
        `SELECT * FROM tickets INDEXED BY tickets_expiry_unread
         WHERE state IN ('expired', 'refunded') AND withheld IS NULL AND expire_sig IS NOT NULL
           AND detail_tries < 10
         ORDER BY updated_at LIMIT ?`,
        MAX_EXPIRY_READS,
      )
      .toArray();
    for (const r of rows) {
      // past the alarm's subrequests a read fails: it would spend a try for nothing
      if (!this.affords(1)) break;
      const tx = await this.fetchTx(r.expire_sig as Signature).catch(() => null);
      const o = tx ? closureOf(tx, r.address) : null;
      // the event's `pending` is the program's verdict: it queues the vrf_payer sweep whatever
      // the send predicted (a bound request the keeper's read did not hold, say)
      if (o?.kind === "expired")
        this.update(
          r.address,
          { withheld: (o.withheld ?? 0n).toString(), ...(o.pending ? { vrf_sweep: 1 } : {}) },
          false,
        );
      else this.update(r.address, { detail_tries: r.detail_tries + 1 }, false);
    }
  }

  /**
   * ORAO's rent refund for a ticket expired with its request pending reaches the ticket's
   * vrf_payer when ORAO fulfils, after the ticket's close: `sweep_ticket_vrf` moves it to the
   * keeper once it is there. Done once vrf_payer is empty and the request owes it nothing:
   * fulfilled, or one that never refunds vrf_payer (a legacy request, or one someone else
   * created, which refunds its own creator). Every row checked moves to the back
   * of the queue (`vrf_checked_at`), so that requests ORAO never answers cannot hold the queue;
   * a sweep is sent without waiting for it to land, and the row stays queued until a later
   * sweep reads its vrf_payer empty. A row that never named its request (the keeper had last
   * read the ticket Open when someone else requested and expired it) has it looked up among
   * the ticket's transactions on its first check; one whose request stays unknown is swept by
   * its vrf_payer alone, the request counted as still owing, until the row is pruned.
   */
  private async sweepVrfPayers(): Promise<void> {
    const rows = this.sql
      .exec<Row>(
        `SELECT * FROM tickets INDEXED BY tickets_vrf_due
         WHERE vrf_sweep = 1 AND integrator IS NOT NULL AND nonce IS NOT NULL
         ORDER BY vrf_checked_at LIMIT ?`,
        MAX_VRF_SWEEPS,
      )
      .toArray();
    if (!rows.length || !this.affords(1)) return;
    const checkedAt = Date.now();
    for (const r of rows) {
      if (!r.randomness && r.vrf_checked_at === 0) {
        // a lookup this alarm cannot afford leaves the row first in the queue, for the next sweep
        if (!this.affords(TICKET_STEP_SUBREQUESTS + 1)) continue;
        const request = await this.requestIn(r.address).catch(() => null);
        if (request) {
          r.randomness = request;
          this.update(r.address, { randomness: request }, false);
        }
      }
      this.update(r.address, { vrf_checked_at: checkedAt }, false);
    }
    if (!this.affords(1)) return;
    const vrfPayers = await Promise.all(rows.map((r) => vrfPayerPda(r.address as Address)));
    const requestAt = new Map<string, number>();
    const keys: Address[] = [...vrfPayers];
    for (const r of rows)
      if (r.randomness) requestAt.set(r.address, keys.push(r.randomness as Address) - 1);
    const { value } = await this.rpc
      .getMultipleAccounts(keys, { encoding: "base64", commitment: "confirmed" })
      .send();
    const signer = await this.signer();
    for (const [i, r] of rows.entries()) {
      const lamports = value[i]?.lamports ?? 0n;
      const at = requestAt.get(r.address);
      const request = at === undefined ? null : value[at];
      // owed: ORAO still holds rent it refunds to this vrf_payer when it fulfils (a legacy,
      // unparsable or someone else's request owes it nothing); a request still unknown may
      // still owe it
      const owed =
        at === undefined ||
        oraoRefundsTo(
          request
            ? {
                address: r.randomness as Address,
                owner: request.owner,
                data: decodeBase64(request.data[0]),
              }
            : null,
          vrfPayers[i]!,
        );
      if (lamports > 0n) {
        const ix = await getSweepTicketVrfInstructionAsync(
          {
            caller: signer,
            integrator: r.integrator as Address,
            nonce: BigInt(r.nonce as string),
            eventAuthority: await eventAuthority(),
            program: PROGRAM,
          },
          cfg,
        );
        const label = `sweep_ticket_vrf ${r.address} (${lamports} lamports)`;
        // one refused send leaves the others to go; the row is checked again next sweep
        await this.sendUnconfirmed(ix, label, "sweep").catch((e: unknown) =>
          console.warn(`${label}: not sent: ${describeError(e)}`),
        );
      } else if (!owed) {
        this.update(r.address, { vrf_sweep: 0 }, false);
      }
    }
  }

  /**
   * Reads and stores `Vault.ticket_forfeits_withheld`, "unreadable" when the read fails. Never
   * throws: an unreadable counter fails the direct alarm closed.
   */
  private async readWithheldCounter(): Promise<void> {
    let counted: string | null = null;
    try {
      const [vault] = await findVaultPda(cfg);
      const { value } = await this.rpc
        .getAccountInfo(vault, { encoding: "base64", commitment: "confirmed" })
        .send();
      if (value)
        counted = getVaultDecoder()
          .decode(decodeBase64(value.data[0]))
          .ticketForfeitsWithheld.toString();
    } catch (e) {
      console.warn(`withheld reconciliation: vault unreadable: ${describeError(e)}`);
    }
    this.sql.exec(
      "INSERT OR REPLACE INTO keeper_state (key, value) VALUES ('ticket_forfeits_withheld', ?)",
      counted ?? "unreadable",
    );
    if (counted !== null)
      this.sql.exec(
        "INSERT OR REPLACE INTO keeper_state (key, value) VALUES ('ticket_forfeits_withheld_read_at', ?)",
        String(Date.now()),
      );
  }

  /**
   * Compares the vault's withheld counter (`readWithheldCounter`) with the withheld expiries
   * read, and records every one read from the keeper's own expiries. Any withheld direct
   * expiry, and any the keeper cannot account for (an expiry it did not send, or the vault
   * unreadable), is a critical alarm: a withheld draw, for which the guardian pauses new tickets.
   */
  private reconcileWithheld(): void {
    const fresh = this.sql
      .exec<Row>(
        "SELECT * FROM tickets WHERE withheld IS NOT NULL AND withheld != '0' AND state IN ('expired', 'refunded')",
      )
      .toArray();
    for (const r of fresh)
      this.sql.exec(
        "INSERT OR IGNORE INTO direct_withheld (ordinal, ticket, refunded, at) VALUES (?, ?, ?, ?)",
        Number(r.withheld),
        r.address,
        r.state === "refunded" ? 1 : 0,
        r.updated_at,
      );
    const a = this.directWithheld();
    if (a.pauseRecommended)
      console.error(
        `ALARM direct withheld draw: the vault counts ${a.counted ?? "(unreadable)"}, ${a.unresolvedCount ?? "all"} unresolved, ${a.unaccounted ?? "all"} unaccounted for: pause new tickets (guardian)`,
      );
  }

  /**
   * The direct path's alarm as /v1/health shows it (see `Health.directWithheld`). The vault's
   * counter counts only while its last read is recent (WITHHELD_READ_MAX_AGE_MS): a counter the
   * sweep stopped reading fails closed, as an unreadable one does.
   */
  private directWithheld(): DirectAlarm {
    const state = (key: string) =>
      this.sql
        .exec<{ value: string }>("SELECT value FROM keeper_state WHERE key = ?", key)
        .toArray()[0]?.value ?? null;
    const stored = state("ticket_forfeits_withheld");
    const readAt = Number(state("ticket_forfeits_withheld_read_at") ?? 0);
    const counted =
      stored === null || stored === "unreadable" || Date.now() - readAt > WITHHELD_READ_MAX_AGE_MS
        ? null
        : BigInt(stored);
    const all = this.sql
      .exec<{
        ordinal: number;
        ticket: string;
        refunded: number;
        at: number;
      }>("SELECT * FROM direct_withheld ORDER BY ordinal")
      .toArray();
    return directAlarm(
      counted,
      all.map((x) => ({
        ordinal: BigInt(x.ordinal),
        ticket: x.ticket,
        refunded: x.refunded === 1,
      })),
      this.acknowledged,
      this.acknowledgementError,
    );
  }

  private programAccounts(discriminator: ArrayLike<number>, size: bigint) {
    return this.rpc
      .getProgramAccounts(PROGRAM, {
        encoding: "base64",
        commitment: "confirmed",
        filters: [
          { dataSize: size },
          {
            memcmp: {
              offset: 0n,
              bytes: b58(discriminator) as Base58EncodedBytes,
              encoding: "base58",
            },
          },
        ],
      })
      .send();
  }

  /**
   * Open or requested tickets that nobody posted. False when the alarm could not afford the
   * listing: the tick lists them on the next alarm.
   */
  private async sweepTickets(): Promise<boolean> {
    if (!this.affords(LISTING_SUBREQUESTS)) return false;
    const accounts = await this.programAccounts(TICKET_DISCRIMINATOR, TICKET_SIZE);
    let added = 0;
    for (const { pubkey, account } of accounts) {
      const w = decodeTicket(decodeBase64(account.data[0]));
      if (!w || w.status === TicketStatus.PayoutPending) continue;
      const r = this.row(pubkey);
      if (r && ACTIVE.includes(r.state)) continue;
      this.track(pubkey, w, "sweep");
      added++;
    }
    if (added) {
      console.log(`sweep: queued ${added} ticket(s)`);
      await this.ensureAlarm(true);
    }
    return true;
  }

  /** Strikes the live epoch once its close has passed and no ticket opened before it is open. */
  private async strike(): Promise<void> {
    if (!this.affords(1)) return;
    const [queue] = await findQueuePda(cfg);
    const [vault] = await findVaultPda(cfg);
    const { value } = await this.rpc
      .getMultipleAccounts([queue, vault], { encoding: "base64", commitment: "confirmed" })
      .send();
    if (!value[0] || !value[1]) return;
    const q = getQueueDecoder().decode(decodeBase64(value[0].data[0]));
    const p = getVaultDecoder().decode(decodeBase64(value[1].data[0]));
    if (!q.current.live) return;
    if (BigInt(Math.floor(Date.now() / 1000)) < q.current.closeTs) return;
    if (p.openBeforeClose !== 0) {
      console.log(`strike: epoch ${q.current.epochId} closed, ${p.openBeforeClose} ticket(s) open`);
      return;
    }
    const signer = await this.signer();
    const ix = await getStrikeEpochInstructionAsync(
      {
        caller: signer,
        record: await epochPda(q.current.epochId),
        usdcMint: USDC_MINT,
        eventAuthority: await eventAuthority(),
        program: PROGRAM,
      },
      cfg,
    );
    await this.lpSend(ix, `strike_epoch ${q.current.epochId}`);
  }

  /** Claims struck deposit and withdrawal requests, each paid by its CLAIM_FEE. */
  private async claims(): Promise<void> {
    if (!this.affords(3)) return;
    const [deposits, withdraws] = await Promise.all([
      this.programAccounts(DEPOSIT_REQUEST_DISCRIMINATOR, DEPOSIT_REQUEST_SIZE),
      this.programAccounts(WITHDRAW_REQUEST_DISCRIMINATOR, WITHDRAW_REQUEST_SIZE),
    ]);
    if (!deposits.length && !withdraws.length) return;
    const records = new Map<bigint, { address: Address; data: EpochRecord }>();
    for (const { pubkey, account } of await this.programAccounts(
      EPOCH_RECORD_DISCRIMINATOR,
      EPOCH_RECORD_SIZE,
    )) {
      const data = getEpochRecordDecoder().decode(decodeBase64(account.data[0]));
      records.set(data.epochId, { address: pubkey, data });
    }
    const signer = await this.signer();
    const common = { eventAuthority: await eventAuthority(), program: PROGRAM };
    let sent = 0;

    for (const { pubkey, account } of deposits) {
      if (sent >= MAX_CLAIMS_PER_SWEEP || !this.affords(SEND_SUBREQUESTS)) return;
      const d = getDepositRequestDecoder().decode(decodeBase64(account.data[0]));
      const rec = records.get(d.epochId);
      if (d.parked || !rec) continue;
      const [shareMint] = await findShareMintPda(cfg);
      const ix = await getClaimDepositInstructionAsync(
        {
          caller: signer,
          request: pubkey,
          owner: d.owner,
          record: rec.address,
          ownerShares: await ata(d.owner, shareMint),
          rentReceiver: rec.data.rentPayer,
          ...common,
        },
        cfg,
      );
      if (await this.lpSend(ix, `claim_deposit ${pubkey}`)) sent++;
    }

    for (const { pubkey, account } of withdraws) {
      if (sent >= MAX_CLAIMS_PER_SWEEP || !this.affords(SEND_SUBREQUESTS)) return;
      const wr = getWithdrawRequestDecoder().decode(decodeBase64(account.data[0]));
      if (wr.parked) continue;
      const first = wr.rEntry === 0n;
      const entry = records.get(wr.epochId);
      if (first && !entry) continue; // not struck yet
      const chain = first ? (entry as { data: EpochRecord }).data.chainId : wr.chainId;
      const from = first || wr.chainId < wr.epochId ? wr.epochId : wr.chainId;
      // The first record of the chain that ends it or splits it: the claim that pays out.
      let at: { address: Address; data: EpochRecord } | null = null;
      for (const rec of records.values()) {
        const { epochId, chainId, rAfter } = rec.data;
        if (epochId < from || chainId !== chain) continue;
        if (rAfter !== 0n && rAfter >= CHAIN_R_MIN) continue;
        if (!at || epochId < at.data.epochId) at = rec;
      }
      if (!at) continue;
      const withEntry = first && at.data.epochId !== wr.epochId && entry;
      const ix = await getClaimWithdrawInstructionAsync(
        {
          caller: signer,
          request: pubkey,
          owner: wr.owner,
          atRecord: at.address,
          ownerUsdc: await ata(wr.owner, USDC_MINT),
          usdcMint: USDC_MINT,
          rentReceiver: at.data.rentPayer,
          ...(withEntry
            ? { entryRecord: entry.address, entryRentReceiver: entry.data.rentPayer }
            : {}),
          ...common,
        },
        cfg,
      );
      if (await this.lpSend(ix, `claim_withdraw ${pubkey} at epoch ${at.data.epochId}`)) sent++;
    }
  }

  /**
   * Simulates, then sends a transaction without waiting for it to land: for a step whose effect
   * the next sweep reads back from the chain. Returns its signature, or null when refused.
   */
  private async sendUnconfirmed(
    ix: Instruction,
    label: string,
    units: keyof typeof UNITS,
  ): Promise<Signature | null> {
    if (!this.affords(SEND_SUBREQUESTS)) {
      console.log(`${label}: not sent, left to the next alarm (subrequests)`);
      return null;
    }
    const signer = await this.signer();
    const tx = await build(this.rpc, signer, [ix], UNITS[units]);
    const refused = await simulateBuilt(this.rpc, tx);
    if (refused) {
      console.log(`${label}: not sent, simulation refused: ${refused}`);
      return null;
    }
    await sendWire(this.rpc, tx.wire);
    console.log(`${label}: sent ${tx.signature}`);
    return tx.signature;
  }

  /** Simulates, then sends and waits for an LP transaction. Returns its signature, or null. */
  private async lpSend(
    ix: Instruction,
    label: string,
    units: keyof typeof UNITS = "lp",
  ): Promise<Signature | null> {
    if (!this.affords(SEND_SUBREQUESTS)) {
      console.log(`${label}: not sent, left to the next alarm (subrequests)`);
      return null;
    }
    const signer = await this.signer();
    const tx = await build(this.rpc, signer, [ix], UNITS[units]);
    const refused = await simulateBuilt(this.rpc, tx);
    if (refused) {
      console.log(`${label}: not sent, simulation refused: ${refused}`);
      return null;
    }
    await sendWire(this.rpc, tx.wire);
    const sentAt = Date.now();
    let resent = sentAt;
    // a status poll and a resend per round, while the alarm's subrequests last: a claim not
    // seen confirmed is read back from the chain by a later sweep
    while (Date.now() - sentAt < 45_000 && this.affords(2)) {
      await sleep(1_500);
      const { value } = await this.rpc.getSignatureStatuses([tx.signature]).send();
      const st = value[0];
      if (st?.err) {
        console.warn(`${label}: failed on chain: ${errorText(st.err)}`);
        return null;
      }
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
        console.log(`${label}: confirmed ${tx.signature}`);
        return tx.signature;
      }
      if (Date.now() - resent > RESEND_EVERY_MS) {
        resent = Date.now();
        await sendWire(this.rpc, tx.wire, true).catch(() => undefined);
      }
    }
    console.warn(`${label}: not seen confirmed (${tx.signature})`);
    return null;
  }

  // --- storage ------------------------------------------------------------------------

  private row(address: string): Row | null {
    return (
      this.sql.exec<Row>("SELECT * FROM tickets WHERE address = ?", address).toArray()[0] ?? null
    );
  }

  private activeCount(): number {
    const r = this.sql
      .exec<{
        n: number;
      }>("SELECT COUNT(*) AS n FROM tickets WHERE state IN ('queued', 'requested', 'fulfilled')")
      .one();
    return r.n;
  }

  /**
   * Starts (or restarts) tracking a ticket found on chain. A row whose closure the keeper already
   * recorded (its settlement or expiry signature) keeps its state: a lagging RPC node can still
   * list a closed ticket as Open, and a parked refund POSTed again is the same refund, so a
   * re-track must not turn a refund into an expiry when the account is found gone.
   */
  private track(address: string, w: Ticket, source: string): void {
    const now = Date.now();
    const state: TicketState = w.status === TicketStatus.Requested ? "requested" : "queued";
    const randomness = w.status === TicketStatus.Requested ? w.randomness : null;
    this.sql.exec(
      `INSERT INTO tickets (address, state, source, open_slot, expiry_slot, randomness, integrator, nonce,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET
         state = CASE WHEN tickets.settle_sig IS NULL AND tickets.expire_sig IS NULL
           THEN excluded.state ELSE tickets.state END,
         randomness = excluded.randomness,
         attempts = 0, next_try_at = 0, detail_tries = 0, updated_at = excluded.updated_at`,
      address,
      state,
      source,
      w.openSlot.toString(),
      w.expirySlot.toString(),
      randomness,
      w.integrator,
      w.nonce.toString(),
      now,
      now,
    );
    console.log(`tracking ${address} (${source}, ${state})`);
  }

  private syncFromChain(r: Row, w: Ticket): void {
    const randomness = w.status === TicketStatus.Requested ? w.randomness : null;
    if (
      r.open_slot === null ||
      r.integrator === null ||
      r.nonce === null ||
      (randomness && r.randomness !== randomness)
    ) {
      // integrator and nonce now, while the ticket is open: an expiry someone else sends closes
      // it, and the vrf_payer sweep then needs them
      this.update(r.address, {
        open_slot: w.openSlot.toString(),
        expiry_slot: w.expirySlot.toString(),
        integrator: w.integrator,
        nonce: w.nonce.toString(),
        ...(randomness ? { randomness } : {}),
      });
    }
  }

  private setState(r: Row, state: TicketState): void {
    if (r.state !== state) this.update(r.address, { state });
  }

  /**
   * Writes `fields`; `touch` (the default) also sets `updated_at`, which orders the loop's
   * queues and the retention prune. Bookkeeping that changes nothing the API shows passes false.
   */
  private update(address: string, fields: Partial<Omit<Row, "address">>, touch = true): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const assignments = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => fields[k] ?? null);
    if (touch)
      this.sql.exec(
        `UPDATE tickets SET ${assignments}, updated_at = ? WHERE address = ?`,
        ...values,
        Date.now(),
        address,
      );
    else this.sql.exec(`UPDATE tickets SET ${assignments} WHERE address = ?`, ...values, address);
  }

  private signer(): Promise<KeyPairSigner> {
    this.signerPromise ??= signerFromSecret(this.env.KEEPER_SECRET_KEY, "KEEPER_SECRET_KEY");
    this.signerPromise.catch(() => {
      this.signerPromise = null;
    });
    return this.signerPromise;
  }
}
