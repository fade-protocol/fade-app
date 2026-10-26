// The keeper's shared-beacon loop, independent of
// where it runs: beacon.ts drives it from a Durable Object's alarm, the
// tests over litesvm. Each `tick()` first resolves the alarms the operator
// acknowledged (`BEACON_ACKNOWLEDGED_ALARMS`, configuration reviewed in git),
// then:
//
//   1. follows its transactions in flight (confirmed, failed, or resent);
//   2. reads the program's new transactions and their events, which name the
//      rounds, tickets, sponsorships and integrators to watch; an expiry
//      raises the alarm. The alarm never depends on these events alone: a
//      round found forfeited, or gone, without its expiry read is looked up
//      by its own transactions (after step 4, within a budget), and raises a
//      withheld draw when that fails, replaced by the expiry if read later;
//   3. now and then lists every round account, so that a round whose events
//      it missed is still finished;
//   4. reads every open round at one slot and does its next step
//      (beaconPolicy.ts `nextAction`): the sponsorship that completes a draw
//      (if configured), the request from `close_slot + 2` (its seed recorded
//      by `record_round_entropy` in a transaction of its own just before),
//      settlement in batches planned by the client's `planSettlement` as
//      version 1 transactions without any lookup table (plain v0 where v1 is
//      not accepted), the late binding of a request someone created, the
//      expiry, the returns of a forfeited round, the sponsorships' reclaims,
//      led by `sweep_round_vrf` when the round's `round_vrf` holds lamports;
//   5. now and then sweeps the shares (`claim_shares`) and the `round_vrf`
//      of every round it saw forfeited after its request (ORAO may fulfil
//      that request, and refund its rent there, after the round closed),
//      and retries parked payouts, each on its own backoff;
//   6. says when it wants the next tick: soon while a round is worked or waits
//      on ORAO, at the earliest slot a round can next be requested (an
//      accepting round can be paid in any slot), idle otherwise: every 5 s
//      for a minute after a wake (`wake`, the app's POST /v1/beacon/wake
//      after a join), every 20 s without one (beaconPolicy.ts
//      `BEACON_QUIET_MS`, derived there from the program's windows).
//
// Every instruction comes from the beacon client, built from account state
// read at a slot and stored keys, and is sent with a preflight, so a step
// the program would refuse costs nothing. A transaction is recorded in
// flight before it is sent and stays there until it is confirmed, fails, is
// refused outright by the RPC, or its blockhash can no longer land
// (`lastValidBlockHeight` passed), so that the keeper never sends a second
// copy of an action whose first copy could still land, even when the send's
// answer is lost.
import {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getU64Encoder,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type Signature,
} from "@solana/kit";
import {
  CONFIG_DISCRIMINATOR,
  INTEGRATOR_DISCRIMINATOR,
  PAYOUT_TABLE_DISCRIMINATOR,
  ROUND_DISCRIMINATOR,
  ROUND_TICKET_DISCRIMINATOR,
  RoundStatus,
  RoundTicketStatus,
  SPONSORSHIP_DISCRIMINATOR,
  VAULT_DISCRIMINATOR,
  findConfigPda,
  findRoundVrfPda,
  findSponsorshipPda,
  findVaultPda,
  getClaimSharesInstructionAsync,
  getConfigDecoder,
  getIntegratorDecoder,
  getIntegratorSize,
  getPayoutTableDecoder,
  getPayoutTableSize,
  getRoundDecoder,
  getRoundSize,
  getRoundTicketDecoder,
  getRoundTicketSize,
  getSponsorshipDecoder,
  getSponsorshipSize,
  getVaultDecoder,
  type PayoutTable,
  type Round,
  type RoundTicket,
  type Sponsorship,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  ORAO_VRF_PROGRAM_ADDRESS,
  RoundDrawFulfilledError,
  SLOT_HASHES_SYSVAR,
  beaconTransactionMessage,
  findEventAuthorityPda,
  findOraoNetworkStatePda,
  getBeaconClaimPayoutInstructionAsync,
  getBeaconExpireInstructionAsync,
  getBeaconReclaimInstructionAsync,
  getBeaconRecordEntropyInstructionAsync,
  getBeaconRequestDrawInstructionAsync,
  getBeaconReturnInstructionAsync,
  getBeaconSweepVrfInstructionAsync,
  getCompleteDrawInstructionAsync,
  measure,
  oraoNetworkState,
  oraoRandomness,
  planSettlement,
  predictSettlement,
  roundRandomness,
  roundRequestAddress,
  roundVrfSweepable,
  type AccountRead,
  type Budget,
  type Held,
  type TransactionFormat,
} from "../../../clients/js/src/beacon/index.ts";
import {
  SendRefusedError,
  type BeaconChain,
  type Lifetime,
  type SignatureInfo,
} from "./beaconChain.ts";
import { missingBound, noteRefusal, refusalAnswered } from "./rpcHistory.ts";
import {
  ALARM_SEVERITY,
  BEACON_ACTIVE_MS,
  acceptingWake,
  idleTickMs,
  beaconEventsOf,
  classifyExpiry,
  lateAlarm,
  nextAction,
  nextTickMs,
  overdueAlarm,
  pausesTickets,
  sponsorAmount,
  type AlarmKind,
  type BeaconConfig,
  type BeaconEvent,
  type RequestState,
  type RoundAction,
} from "./beaconPolicy.ts";

/** The SQL the engine runs: a Durable Object's `SqlStorage`, or node:sqlite in the harness and tests. */
export type Sql = {
  exec<T = Record<string, unknown>>(query: string, ...bindings: (string | number | null)[]): T[];
};

export type EngineOptions = {
  /** v1: the whole priority fee of a transaction; v0: micro-lamports per unit. */
  priority?: { v1Lamports: bigint; v0MicroLamports: bigint };
  /** Rounds the engine leaves alone at a slot (the local harness's alarm demonstrations). */
  hold?: (round: Round, slot: bigint) => boolean;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  now?: () => number;
  /** Rounds read and worked per tick (`MAX_ROUNDS_PER_TICK`); the tests lower it. */
  roundsPerTick?: number;
  /** Parked tickets tried per pass (`PARKED_PER_PASS`); the tests lower it. */
  parkedPerPass?: number;
};

/** Compute units requested per instruction, above what the program's tests measured. */
export const UNITS = {
  sponsor: 60_000,
  request: 80_000,
  record: 30_000,
  expire: 60_000,
  return: 50_000,
  reclaim: 40_000,
  claimShares: 50_000,
  claimPayout: 40_000,
  sweepVrf: 25_000,
} as const;

/** Returns or reclaims packed into one transaction at most (each its own instruction). */
const MAX_IXS_PER_TX = 8;
/** Rounds read and worked per tick. */
const MAX_ROUNDS_PER_TICK = 30;
/** New program transactions read per tick. */
const MAX_TXS_PER_TICK = 40;
/** Pages of signatures read back to the last one seen; beyond that the gap is left to the round scan. */
const MAX_SIGNATURE_PAGES = 5;
const SIGNATURE_PAGE = 200;
const RECONCILE_MS = 60_000;
/** A wake lists the rounds at most this often (`wake`). */
const WAKE_SCAN_MIN_MS = 5_000;
/** `beacon_state` key: when the loop was last woken (`wake`), ms. */
const WOKEN_AT = "woken_at";
/** `beacon_state` key: the passes' last runs and the format, as JSON (`restoreCadence`). */
const CADENCE = "cadence";
/**
 * `beacon_state` key: the signature the RPC last refused as not in its history while the events
 * were read, how often and since when, as JSON (`noteRefusal`).
 */
const HISTORY_REFUSAL = "history_refusal";
type Cadence = {
  reconcile: number;
  sweep: number;
  vrfSweep: number;
  parked: number;
  prune: number;
  format: TransactionFormat | null;
  formatSince: number;
};
const SWEEP_MS = 10 * 60_000;
const PARKED_RETRY_MS = 10 * 60_000;
/**
 * A round seen forfeited after its request has its `round_vrf` watched this
 * long from then (`sweepVrfs`): ORAO may fulfil the request it left pending,
 * and refund the pending rent to `round_vrf`, at any time after.
 */
const VRF_WATCH_MS = 7 * 24 * 3_600_000;
/**
 * Watched `round_vrf`s read a pass at most, the longest unread first, so that
 * every watched one is read in turn however many are watched.
 */
const VRFS_PER_PASS = 50;
/** `beacon_state` key: set once the watches of rounds forfeited before `beacon_vrfs` are seeded. */
const VRF_WATCHES_SEEDED = "vrf_watches_seeded";
/** Parked tickets tried a pass at most (`EngineOptions.parkedPerPass`). */
const PARKED_PER_PASS = 10;
/** A parked ticket refused `tries` times is tried again `min(10 min × 2^tries, 24 h)` later. */
const parkedBackoff = (tries: number) => Math.min(PARKED_RETRY_MS * 2 ** tries, 24 * 3_600_000);
const RESEND_MS = 2_000;
/** While rounds are being worked, events are read at most this often (new rounds can wait). */
const EVENTS_HOT_MS = 3_000;
/** A blockhash is reused this long: it stays valid about 60 s, and `lastValidBlockHeight` is tracked. */
const BLOCKHASH_MS = 10_000;
/** After a fallback to v0, v1 is tried again this much later. */
const FORMAT_RECHECK_MS = 3_600_000;
/**
 * A program that does not know `sweep_round_vrf` (refused at preflight with
 * Anchor's `InstructionFallbackNotFound`) is not sent one again for this long:
 * returns and reclaims go without it, and the next sweep after it asks again.
 */
const SWEEP_RECHECK_MS = 3_600_000;
/** A failed step waits `min(1 s × 2^attempts, 60 s)`; an entropy slot not yet visible, 300 ms. */
const backoff = (attempts: number) => Math.min(1_000 * 2 ** attempts, 60_000);
const SOON_MS = 300;
/** Closed rounds and their tickets are kept a day for the health route, alarms thirty. */
const ROUND_RETENTION_MS = 24 * 3_600_000;
const ALARM_RETENTION_MS = 30 * 24 * 3_600_000;
const PRUNE_MS = 3_600_000;
/** The keeper's balance is read again after this long, ms. */
const BALANCE_MS = 10_000;
/** What one discretionary transaction may cost in fees, above its own spend: its floor margin. */
const FEE_MARGIN_LAMPORTS = 100_000n;
/**
 * A lookup pages back through a round's own transactions, newest first,
 * `EXPIRY_SIGNATURES` signatures a page, until it finds the expiry or a
 * transaction that comes before any expiry (`PRE_EXPIRY`), or reaches the
 * round's first transaction. It reads `EXPIRY_TXS_PER_TICK` transactions a
 * tick at most, over every round looked up (`EXPIRY_LOOKUPS_PER_TICK` at
 * most), and carries its place across ticks in the round's row. A pass that
 * examines `EXPIRY_MAX_TXS` (failed ones included) without an answer stops there, inconclusive: a
 * round has at most a few hundred honest transactions (its joins, returns,
 * reclaims and closing), so only transactions naming it to bury its expiry
 * get that far. Failed ones count, since they bound a pass's work; an
 * inconclusive pass is decided by the vault's count, not by this history.
 */
const EXPIRY_SIGNATURES = 100;
const EXPIRY_TXS_PER_TICK = 20;
const EXPIRY_LOOKUPS_PER_TICK = 3;
const EXPIRY_MAX_TXS = 400;
/** Signature pages a lookup reads a tick at most (failed transactions cost no read, but a page). */
const EXPIRY_PAGES_PER_TICK = 2;
/** A round's events that only come before its expiry: a lookup that reaches one is complete. */
const PRE_EXPIRY: readonly BeaconEvent["kind"][] = [
  "opened",
  "joined",
  "paid",
  "sponsored",
  "requested",
];
/**
 * An expiry not found is concluded on (`lookUpExpiry`: by the vault's count of
 * withheld forfeitures, failing closed while one is unaccounted for) only after
 * this many lookups and this long since the first: an RPC can confirm a
 * transaction before `getTransaction` or `getSignaturesForAddress` serves
 * it. Lookups are spaced 1 s, 4 s, 15 s apart, then every 15 s.
 */
const EXPIRY_LOOKUP_TRIES = 3;
const EXPIRY_LOOKUP_MIN_MS = 30_000;
/** With one of the round's transactions unreadable (or the lookup failing), this long instead. */
const EXPIRY_UNREADABLE_MS = 120_000;
const lookupBackoff = (tries: number) => Math.min(1_000 * 4 ** (tries - 1), 15_000);
/** A confirmed expiry or settlement whose events could not be read yet is read again this long. */
const REREAD_MS = 60_000;
/** A discretionary step the balance floor declined is looked at again this much later. */
const DEFERRED_MS = 60_000;
/** Round statuses after which a round may vanish without an expiry to account for. */
const SETTLED_STATUSES: readonly string[] = [
  RoundStatus[RoundStatus.Drawn],
  RoundStatus[RoundStatus.Refunded],
];
/** The alarms that account for a forfeiture. */
const EXPIRY_ALARMS = "('withheld-draw', 'unrequested-expiry')";

/** `RoundTicket.round`'s offset (discriminator, version, bump, status). */
const TICKET_ROUND_OFFSET = 11;
/** `Sponsorship.round`'s offset (discriminator, version, bump). */
const SPONSORSHIP_ROUND_OFFSET = 10;

type RoundRow = {
  address: string;
  id: string | null;
  open: number;
  status: string | null;
  attempts: number;
  next_try_at: number;
  last_error: string | null;
  updated_at: number;
  requested_slot: string | null;
  lookup_tries: number;
  lookup_first_at: number;
  lookup_next_at: number;
  /** A pass in progress: the oldest signature read, transactions read, one unreadable (1). */
  lookup_before: string | null;
  lookup_read: number;
  lookup_gap: number;
};

type PendingRow = {
  signature: string;
  round: string;
  kind: string;
  wire: string;
  last_valid: string;
  sent_at: number;
  resent_at: number;
  confirmed_at: number;
};

export type AlarmView = {
  round: string;
  roundId: string | null;
  kind: AlarmKind;
  severity: string;
  detail: string;
  slot: string;
  at: string;
  /**
   * When it was resolved, or null: the condition it reports ended (a late
   * request fulfilled and drawn), or the operator acknowledged it.
   */
  resolvedAt: string | null;
  /** Why it was resolved (`drawn: …`, `acknowledged: <reason>`), or null. */
  resolution: string | null;
};

export type BeaconHealth = {
  program: Address;
  keeper: Address;
  format: TransactionFormat | null;
  lastTick: number;
  /** How long the last tick took, ms. */
  lastTickMs: number;
  lastSlot: string;
  openRounds: number;
  inFlight: number;
  /**
   * An unresolved critical alarm is on record (a withheld draw, a request
   * still unfulfilled past Spec 02 §3's threshold, an expiry overdue): the
   * guardian should pause new tickets (Spec 09 §10). Counted over every
   * alarm kept, not the listing below; unresolved critical alarms are never
   * pruned. `fulfilment-late` resolves once its round is drawn; any other
   * only by the operator's acknowledgement of that round and kind
   * (`BEACON_ACKNOWLEDGED_ALARMS`).
   */
  pauseRecommended: boolean;
  /** Why `BEACON_ACKNOWLEDGED_ALARMS` was ignored (none of it applied), or null. */
  acknowledgementError: string | null;
  /** The keeper's lamports at its last read, or null before one. */
  balanceLamports: string | null;
  /** Below `minBalanceLamports`: only the steps that pay or are bound to a deadline run. */
  lowBalance: boolean;
  /** Every unresolved critical alarm, then the newest others. */
  alarms: AlarmView[];
};

const le64 = (v: bigint) => new Uint8Array(getU64Encoder().encode(v));
const same = (a: ReadonlyUint8Array, b: ReadonlyUint8Array) =>
  a.length >= b.length && b.every((x, i) => a[i] === x);
const short = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);

/** `read` decoded as one of `program`'s accounts of `size` bytes and `discriminator`, or null. */
function decodeOwned<T>(
  read: AccountRead | null,
  program: Address,
  size: number,
  discriminator: ReadonlyUint8Array,
  decode: (d: Uint8Array) => T,
): T | null {
  if (!read || read.owner !== program || read.data.length !== size) return null;
  if (!same(read.data, discriminator)) return null;
  try {
    return decode(read.data);
  } catch {
    return null;
  }
}

/** A request account's state, as `nextAction` reads it. */
export function requestStateOf(read: AccountRead | null): RequestState {
  if (!read || read.owner !== ORAO_VRF_PROGRAM_ADDRESS) return "absent";
  const parsed = oraoRandomness(read.data);
  if (!parsed) return "absent";
  if (!parsed.fulfilled) return "pending";
  return parsed.randomness.some((b) => b !== 0) ? "fulfilled" : "zero";
}

export class BeaconEngine {
  private readonly chain: BeaconChain;
  private readonly signer: KeyPairSigner;
  private readonly sql: Sql;
  private readonly config: BeaconConfig;
  private readonly cfg: { programAddress: Address };
  private readonly priority: { v1Lamports: bigint; v0MicroLamports: bigint };
  private readonly hold: (round: Round, slot: bigint) => boolean;
  private readonly log: (level: "info" | "warn" | "error", message: string) => void;
  private readonly now: () => number;
  private format: TransactionFormat | null;
  private formatSince = 0;
  /** When the program last refused `sweep_round_vrf` as unknown (`SWEEP_RECHECK_MS`), or null. */
  private sweepUnknownSince: number | null = null;
  private eventAuthority: Address | null = null;
  private networkState: Address | null = null;
  private readonly tables = new Map<Address, PayoutTable>();
  private lastTick = 0;
  private lastSlot = 0n;
  private lastReconcile = 0;
  private lastSweep = 0;
  private lastParked = 0;
  private lastVrfSweep = 0;
  private lastPrune = 0;
  private reconcileDue = true;
  private lastWatch = 0;
  private lastBusy = false;
  private lastTickMs = 0;
  private blockhash: { lifetime: Lifetime; at: number } | null = null;
  private readonly unreadable = new Map<string, number>();
  /** Each requested round's ORAO request, read with the round on the next tick. */
  private readonly requests = new Map<Address, Address>();
  /** Refusals in a row of each round's expiry. */
  private readonly expireFailures = new Map<string, number>();
  private balance: { lamports: bigint; at: number } | null = null;
  private lastBalanceCheck = 0;
  private vault: Address | null = null;
  /**
   * `Vault.forfeits_withheld` at the slot this tick read its rounds, or null
   * when the vault was unreadable: the program's durable count of the
   * forfeitures a withheld draw may explain (`unaccountedWithheld`).
   */
  private forfeits: { withheld: bigint; slot: bigint } | null = null;
  /** When the round scan last ran on a wake (`WAKE_SCAN_MIN_MS`). */
  private lastWakeScan = 0;
  /** A round was first seen this tick (events, scan): worked on the next one, at once. */
  private discovered = false;
  private readonly roundsPerTick: number;
  private readonly parkedPerPass: number;

  constructor(
    chain: BeaconChain,
    signer: KeyPairSigner,
    sql: Sql,
    config: BeaconConfig,
    options: EngineOptions = {},
  ) {
    this.chain = chain;
    this.signer = signer;
    this.sql = sql;
    this.config = config;
    this.cfg = { programAddress: config.program };
    this.priority = options.priority ?? { v1Lamports: 2_000n, v0MicroLamports: 2_000n };
    this.hold = options.hold ?? (() => false);
    this.log = options.log ?? ((level, m) => console[level](`beacon: ${m}`));
    this.now = options.now ?? Date.now;
    this.format = config.format;
    this.roundsPerTick = options.roundsPerTick ?? MAX_ROUNDS_PER_TICK;
    this.parkedPerPass = options.parkedPerPass ?? PARKED_PER_PASS;
    for (const q of SCHEMA) this.sql.exec(q);
    migrate(this.sql);
    this.seedVrfWatches();
    if (config.acknowledgementError) this.log("error", config.acknowledgementError);
    this.acknowledge();
    this.restoreCadence();
  }

  // --- the cadence -----------------------------------------------------------------------

  /**
   * The passes' last runs, and the transaction format the cluster answered,
   * kept in storage at the end of every tick and read back by a new engine.
   * At its quiet pace the Durable Object hibernates between ticks, which
   * discards its memory: without them every quiet tick would list every round
   * and run the ten-minute sweeps, and ask the format again.
   */
  private restoreCadence(): void {
    const raw = this.state(CADENCE);
    if (raw === null) return;
    let c: Partial<Record<keyof Cadence, unknown>>;
    try {
      c = JSON.parse(raw) as Partial<Record<keyof Cadence, unknown>>;
    } catch {
      return;
    }
    const at = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    this.lastReconcile = at(c.reconcile);
    this.reconcileDue = this.lastReconcile === 0;
    this.lastSweep = at(c.sweep);
    this.lastVrfSweep = at(c.vrfSweep);
    this.lastParked = at(c.parked);
    this.lastPrune = at(c.prune);
    if (this.config.format === null && (c.format === 0 || c.format === 1)) {
      this.format = c.format;
      this.formatSince = at(c.formatSince);
    }
  }

  private saveCadence(): void {
    const c: Cadence = {
      reconcile: this.lastReconcile,
      sweep: this.lastSweep,
      vrfSweep: this.lastVrfSweep,
      parked: this.lastParked,
      prune: this.lastPrune,
      format: this.format,
      formatSince: this.formatSince,
    };
    this.setState(CADENCE, JSON.stringify(c));
  }

  // --- the wake --------------------------------------------------------------------------

  /**
   * Someone joined a round (the app, after its join confirms): the loop keeps
   * `BEACON_IDLE_MS` for `BEACON_WAKE_HOLD_MS` instead of its quiet pace, and
   * its next tick also lists every round, so that a join the events do not
   * serve yet is found from the accounts themselves. It takes no input: what
   * it does next is read from the chain, as on any tick. The listing runs on
   * a wake at most every `WAKE_SCAN_MIN_MS`.
   */
  wake(): void {
    const now = this.now();
    this.setState(WOKEN_AT, String(now));
    if (now - this.lastWakeScan >= WAKE_SCAN_MIN_MS) {
      this.lastWakeScan = now;
      this.reconcileDue = true;
    }
  }

  private wokenAt(): number {
    return Number(this.state(WOKEN_AT) ?? 0) || 0;
  }

  // --- the tick --------------------------------------------------------------------------

  /** One pass of the loop; returns the delay, in ms, before the next one. */
  async tick(): Promise<number> {
    const now = this.now();
    this.lastTick = now;
    // Before any RPC call: an acknowledgement never waits on a slow or saturated node.
    this.acknowledge();
    if (
      this.config.format === null &&
      this.format === 0 &&
      now - this.formatSince >= FORMAT_RECHECK_MS
    )
      this.format = null; // the cluster may have turned v1 on since: asked again
    this.format ??= await this.chain.format();
    this.eventAuthority ??= (await findEventAuthorityPda(this.cfg))[0];
    this.networkState ??= (await findOraoNetworkStatePda())[0];
    this.vault ??= (await findVaultPda(this.cfg))[0];
    let soonest = Infinity;
    this.discovered = false;
    const started = this.now();
    // Independent reads, in parallel: the RPC's round trip, not the CPU, bounds a tick.
    const watch =
      !this.lastBusy || now - this.lastWatch >= EVENTS_HOT_MS
        ? (async () => {
            this.lastWatch = now;
            await this.watchEvents();
          })().catch((e) => this.log("warn", `reading events: ${short(e)}`))
        : Promise.resolve();
    const scan =
      this.reconcileDue || now - this.lastReconcile >= RECONCILE_MS
        ? (async () => {
            this.reconcileDue = false;
            await this.reconcile();
            this.lastReconcile = now;
          })().catch((e) => {
            this.reconcileDue = true;
            this.log("warn", `listing rounds: ${short(e)}`);
          })
        : Promise.resolve();
    // The rounds are worked while the events and the scan are read: what those find is
    // worked on the next tick, and a slow listing never delays a request or a settlement.
    let waits: bigint[] = [];
    let busy = false;
    const working = (async () => {
      await this.followPending().catch((e) =>
        this.log("warn", `following transactions in flight: ${short(e)}`),
      );
      try {
        const w = await this.work();
        waits = w.waits;
        busy = w.busy;
        soonest = w.retryInMs;
      } catch (e) {
        this.log("warn", `working rounds: ${short(e)}`);
        soonest = backoff(1);
      }
    })();
    // Read every BALANCE_MS, not only by a discretionary step: with none enabled, a balance
    // below the floor still raises its alarm.
    const balance =
      now - this.lastBalanceCheck >= BALANCE_MS
        ? (async () => {
            this.lastBalanceCheck = now;
            await this.checkBalance();
          })()
        : Promise.resolve();
    await Promise.all([working, watch, scan, balance]);
    if (this.config.sweepMinUnits !== null && now - this.lastSweep >= SWEEP_MS) {
      this.lastSweep = now;
      await this.sweepShares().catch((e) => this.log("warn", `sweeping shares: ${short(e)}`));
    }
    if (now - this.lastVrfSweep >= SWEEP_MS) {
      this.lastVrfSweep = now;
      await this.sweepVrfs().catch((e) => this.log("warn", `sweeping round_vrf: ${short(e)}`));
    }
    if (now - this.lastParked >= PARKED_RETRY_MS) {
      this.lastParked = now;
      await this.retryParked().catch((e) => this.log("warn", `parked payouts: ${short(e)}`));
    }
    if (now - this.lastPrune >= PRUNE_MS) {
      this.lastPrune = now;
      this.prune(now);
    }
    const inFlight = this.pendingCount() > 0;
    // A round found while the rounds were worked is worked on the next tick, not after an idle
    // wait: a lone join pays its round at once, and its request opens a few slots later.
    if (this.discovered) soonest = Math.min(soonest, BEACON_ACTIVE_MS);
    // A confirmed transaction whose events are not served yet is read again within a second.
    if (this.rereadCount() > 0) soonest = Math.min(soonest, backoff(0));
    this.lastBusy = busy || inFlight;
    this.lastTickMs = this.now() - started;
    this.saveCadence();
    const idleMs = idleTickMs(this.now(), this.wokenAt());
    return Math.min(nextTickMs(this.lastSlot, waits, this.lastBusy, idleMs), soonest);
  }

  // --- 1. transactions in flight -------------------------------------------------------------

  private async followPending(): Promise<void> {
    // Confirmed, their events not read yet (the RPC can confirm before it serves the
    // transaction): read again, for `REREAD_MS` at most. They hold no round back.
    for (const r of this.sql.exec<PendingRow>(
      "SELECT * FROM beacon_pending WHERE confirmed_at > 0 ORDER BY sent_at",
    )) {
      if (await this.readEvents(r.signature as Signature)) this.dropPending(r.signature);
      else if (this.now() - r.confirmed_at >= REREAD_MS) {
        this.dropPending(r.signature);
        this.log("warn", `${r.kind} ${r.signature}: events unreadable, left to the lookups`);
      }
    }
    const rows = this.sql.exec<PendingRow>(
      "SELECT * FROM beacon_pending WHERE confirmed_at = 0 ORDER BY sent_at",
    );
    if (!rows.length) return;
    const statuses = await this.chain.statuses(rows.map((r) => r.signature as Signature));
    let height: bigint | null = null;
    for (const [i, r] of rows.entries()) {
      const st = statuses[i] ?? null;
      if (st?.failed && r.kind === "record") {
        // Best effort, like its send: the request records the seed too, and holds no step back.
        this.dropPending(r.signature);
        this.log("warn", `record ${r.signature} failed on chain: ${st.error ?? ""}`);
      } else if (st?.failed) {
        this.dropPending(r.signature);
        if (r.kind === "expire") this.countExpireFailure(r.round);
        this.failRound(r.round, `${r.kind} failed on chain: ${st.error ?? ""}`);
      } else if (st?.confirmed) {
        this.log("info", `${r.kind} confirmed ${r.signature}`);
        // The keeper's own expiry and settlements: their events (the alarm's `RoundExpired`,
        // `RoundDrawn`, `RoundClosed`) are read here, not left to the event cursor, and read
        // again on the next ticks while the RPC does not serve the transaction yet.
        if (
          (r.kind === "expire" || r.kind.startsWith("settle")) &&
          !(await this.readEvents(r.signature as Signature))
        )
          this.sql.exec(
            "UPDATE beacon_pending SET confirmed_at = ? WHERE signature = ?",
            this.now(),
            r.signature,
          );
        else this.dropPending(r.signature);
      } else {
        height ??= await this.chain.blockHeight();
        if (height > BigInt(r.last_valid)) {
          // Its blockhash expired: it can no longer land, the next tick rebuilds the step.
          this.dropPending(r.signature);
          this.log("warn", `${r.kind} ${r.signature} expired unconfirmed`);
        } else if (this.now() - r.resent_at >= RESEND_MS) {
          await this.chain.send(r.wire, true).catch(() => undefined);
          this.sql.exec(
            "UPDATE beacon_pending SET resent_at = ? WHERE signature = ?",
            this.now(),
            r.signature,
          );
        }
      }
    }
  }

  /** Applies the beacon events of one landed transaction; false if it could not be read. */
  private async readEvents(signature: Signature): Promise<boolean> {
    try {
      const tx = await this.chain.transaction(signature);
      if (!tx) return false;
      for (const e of beaconEventsOf(tx, this.config.program, this.eventAuthority!))
        this.apply(e, tx);
      return true;
    } catch (e) {
      this.log("warn", `reading ${signature}: ${short(e)}`);
      return false;
    }
  }

  private countExpireFailure(round: string) {
    this.expireFailures.set(round, (this.expireFailures.get(round) ?? 0) + 1);
  }

  private dropPending(signature: string) {
    this.sql.exec("DELETE FROM beacon_pending WHERE signature = ?", signature);
  }

  /** Transactions in flight: sent and not yet confirmed, failed or expired. */
  private pendingCount(): number {
    return (
      this.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM beacon_pending WHERE confirmed_at = 0",
      )[0]?.n ?? 0
    );
  }

  private rereadCount(): number {
    return (
      this.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM beacon_pending WHERE confirmed_at > 0",
      )[0]?.n ?? 0
    );
  }

  private roundBusy(round: string): boolean {
    return (
      (this.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM beacon_pending WHERE round = ? AND confirmed_at = 0",
        round,
      )[0]?.n ?? 0) > 0
    );
  }

  // --- 2. events ---------------------------------------------------------------------------

  private state(key: string): string | null {
    return (
      this.sql.exec<{ value: string }>("SELECT value FROM beacon_state WHERE key = ?", key)[0]
        ?.value ?? null
    );
  }

  private setState(key: string, value: string) {
    this.sql.exec(
      "INSERT INTO beacon_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /** Reads the program's transactions since the last one seen, oldest first, and applies their events. */
  private async watchEvents(): Promise<void> {
    const program = this.config.program;
    const cursor = this.state("cursor");
    if (cursor === null) {
      // First run: start from now; the round scan finds what is already open.
      const newest = await this.chain.signatures(program, { limit: 1 });
      this.setState("cursor", newest[0]?.signature ?? "");
      this.reconcileDue = true;
      return;
    }
    const all: { signature: Signature; failed: boolean }[] = [];
    let before: Signature | undefined;
    let complete = false;
    for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
      let got: SignatureInfo[];
      const bounds = { until: cursor, before: before ?? null };
      try {
        got = await this.chain.signatures(program, {
          ...(cursor ? { until: cursor as Signature } : {}),
          ...(before ? { before } : {}),
          limit: SIGNATURE_PAGE,
        });
      } catch (e) {
        const lost = missingBound(e, bounds);
        if (lost === null) throw e;
        // Refused as not in the RPC's history: a node a slot or two behind, behind a load
        // balancer, says so of a signature it has not seen yet, so a refusal that does not last
        // is thrown, and asked again next tick (`noteRefusal`): skipping the events would send
        // the expiries they hold to `lookUpExpiry`, and a withheld draw read where none was.
        const refusal = noteRefusal(
          this.state(HISTORY_REFUSAL),
          (lost === "until" ? cursor : before)!,
          this.now(),
        );
        if (!refusal.confirmed) {
          this.setState(HISTORY_REFUSAL, refusal.record);
          throw e;
        }
        // The RPC no longer holds the cursor (its history pruned past it, or a `confirmed`
        // signature its fork dropped) or the page's bound: every call bounded by it would fail
        // for good. Start again from now, as when too far behind, and let the scan find the
        // rounds.
        this.sql.exec("DELETE FROM beacon_state WHERE key = ?", HISTORY_REFUSAL);
        const newest = await this.chain.signatures(program, { limit: 1 });
        this.log(
          "warn",
          `the RPC no longer holds ${lost === "until" ? `the event cursor ${cursor}` : `${before}`}: events skipped to now, rounds rescanned`,
        );
        this.setState("cursor", newest[0]?.signature ?? "");
        this.reconcileDue = true;
        return;
      }
      if (refusalAnswered(this.state(HISTORY_REFUSAL), bounds))
        this.sql.exec("DELETE FROM beacon_state WHERE key = ?", HISTORY_REFUSAL);
      all.push(...got);
      if (got.length < SIGNATURE_PAGE) {
        complete = true;
        break;
      }
      before = got[got.length - 1]!.signature;
    }
    if (!all.length) return;
    if (!complete) {
      // Too far behind to read every event: skip to now, and let the scan find the rounds.
      this.log("warn", `more than ${all.length} new transactions: skipped, rounds rescanned`);
      this.setState("cursor", all[0]!.signature);
      this.reconcileDue = true;
      return;
    }
    const oldestFirst = all.reverse();
    let read = 0;
    for (const s of oldestFirst) {
      if (!s.failed) {
        if (read >= MAX_TXS_PER_TICK) break;
        read++;
        const tx = await this.chain.transaction(s.signature);
        if (!tx) {
          // Not readable yet: retried from here next tick, skipped after a few tries (the round
          // scan and the account reads cover what its events would have said).
          const tries = (this.unreadable.get(s.signature) ?? 0) + 1;
          this.unreadable.set(s.signature, tries);
          if (tries < 5) break;
          this.unreadable.delete(s.signature);
          this.reconcileDue = true;
          this.log("warn", `transaction ${s.signature} unreadable: skipped`);
          this.setState("cursor", s.signature);
          continue;
        }
        for (const e of beaconEventsOf(tx, program, this.eventAuthority!)) this.apply(e, tx);
      }
      this.setState("cursor", s.signature);
    }
  }

  private watchRound(address: string, id: bigint | null) {
    if (!this.sql.exec("SELECT 1 FROM beacon_rounds WHERE address = ?", address).length)
      this.discovered = true;
    this.sql.exec(
      `INSERT INTO beacon_rounds (address, id, open, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (address) DO UPDATE SET id = COALESCE(excluded.id, beacon_rounds.id)`,
      address,
      id === null ? null : id.toString(),
      this.now(),
    );
  }

  /**
   * Watches the `round_vrf` of the round at `address`, forfeited after its
   * request, for `VRF_WATCH_MS` from the first time it is seen so
   * (`sweepVrfs`), with its ORAO request when known (null: the watch lasts
   * its full term).
   */
  private watchVrf(address: string, id: bigint, request: Address | null) {
    this.sql.exec(
      `INSERT INTO beacon_vrfs (round, id, until, request) VALUES (?, ?, ?, ?)
       ON CONFLICT (round) DO UPDATE SET request = COALESCE(beacon_vrfs.request, excluded.request)`,
      address,
      id.toString(),
      this.now() + VRF_WATCH_MS,
      request,
    );
  }

  /**
   * Once per storage (`beacon_state.vrf_watches_seeded`): watches the
   * `round_vrf` of every forfeited round already recorded whose request was
   * made (its request read, `requested_slot`, or its expiry taken as a
   * withheld draw, which every expiry after a request is), for a keeper
   * whose storage predates `beacon_vrfs`. Such a round may have closed
   * before, so neither its expiry's event nor a read of it watches it again,
   * while ORAO's refund of its pending request can still land. Its request
   * is unknown here: the watch lasts its full term. What storage no longer
   * holds is left to the one-off sweep after the program upgrade
   * (`pnpm devnet:sweep-round-vrfs`).
   */
  private seedVrfWatches() {
    if (this.state(VRF_WATCHES_SEEDED) !== null) return;
    const rows = this.sql.exec<{ round: string; id: string }>(
      `SELECT f.round AS round, r.id AS id FROM beacon_forfeits f
       JOIN beacon_rounds r ON r.address = f.round
       WHERE r.id IS NOT NULL AND (r.requested_slot IS NOT NULL OR EXISTS (
         SELECT 1 FROM beacon_alarms a WHERE a.round = f.round AND a.kind = 'withheld-draw'))`,
    );
    for (const row of rows) this.watchVrf(row.round, BigInt(row.id), null);
    this.setState(VRF_WATCHES_SEEDED, String(rows.length));
    if (rows.length)
      this.log("info", `watching the round_vrf of ${rows.length} forfeited round(s) from storage`);
  }

  private apply(e: BeaconEvent, tx: { slot?: bigint | number }) {
    switch (e.kind) {
      case "opened":
        this.watchRound(e.round, e.id);
        break;
      case "joined":
        this.watchRound(e.round, null);
        this.sql.exec(
          "INSERT OR IGNORE INTO beacon_tickets (address, round, integrator, open, parked) VALUES (?, ?, ?, 1, 0)",
          e.ticket,
          e.round,
          e.integrator,
        );
        this.sql.exec(
          "INSERT OR IGNORE INTO beacon_integrators (address, next_try_at) VALUES (?, 0)",
          e.integrator,
        );
        break;
      case "paid":
        this.watchRound(e.round, null);
        break;
      case "requested":
        // The slot the request landed: `fulfilment-late` counts from it (`fulfilmentBase`).
        this.watchRound(e.round, null);
        if (tx.slot !== undefined)
          this.sql.exec(
            "UPDATE beacon_rounds SET requested_slot = ? WHERE address = ?",
            BigInt(tx.slot).toString(),
            e.round,
          );
        break;
      case "drawn":
      case "refunded":
        // How it ended: once it is gone, there is no expiry to look for.
        this.watchRound(e.round, null);
        if (e.kind === "drawn") this.resolveFulfilment(e.round);
        this.sql.exec(
          "UPDATE beacon_rounds SET status = ? WHERE address = ? AND (status IS NULL OR status != 'closed')",
          e.kind === "drawn" ? RoundStatus[RoundStatus.Drawn] : RoundStatus[RoundStatus.Refunded],
          e.round,
        );
        break;
      case "sponsored":
        this.watchRound(e.round, null);
        this.sql.exec(
          "INSERT OR IGNORE INTO beacon_sponsors (round, sponsor) VALUES (?, ?)",
          e.round,
          e.sponsor,
        );
        break;
      case "settled":
      case "returned":
        this.sql.exec(
          "UPDATE beacon_tickets SET open = ?, parked = ? WHERE address = ?",
          e.parked ? 1 : 0,
          e.parked ? 1 : 0,
          e.ticket,
        );
        break;
      case "expired": {
        const kind = classifyExpiry(e.event);
        const ev = e.event;
        // The expiry itself, read after a lookup took it as withheld: it replaces that inference
        // (the event comes from the program's event authority; a round expires once).
        const inferred = this.sql.exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM beacon_alarms WHERE round = ? AND kind = 'withheld-draw' AND inferred = 1",
          e.round,
        )[0]?.n;
        if (inferred) {
          this.sql.exec(
            "DELETE FROM beacon_alarms WHERE round = ? AND kind = 'withheld-draw' AND inferred = 1",
            e.round,
          );
          this.log(
            "warn",
            `round ${e.round}: its expiry read, replacing the inferred withheld draw`,
          );
        }
        this.raise(
          e.round,
          kind,
          `requested ${ev.requested}, request_found ${ev.requestFound}, checked ${ev.checked}, ` +
            `${ev.tickets} ticket(s), ${ev.forfeited} forfeited, draw_cost ${ev.drawCost}` +
            (ev.refunded ? ", refunded: its entropy was never recorded" : ""),
          BigInt(tx.slot ?? 0),
        );
        // Accounted for, as read: it replaces whatever a lookup inferred for this round, and
        // takes its ordinal back from any inference that claimed it for another.
        this.recordForfeit(e.round, kind === "withheld-draw" ? ev.forfeitsWithheld : null, false);
        this.watchRound(e.round, null);
        // Forfeited after its request, read from its event: watched even when the round
        // closed before a read of it found it forfeited (its id known from earlier reads).
        if (ev.requested) {
          const id = this.sql.exec<{ id: string | null }>(
            "SELECT id FROM beacon_rounds WHERE address = ?",
            e.round,
          )[0]?.id;
          if (id != null)
            this.watchVrf(e.round, BigInt(id), this.requests.get(e.round as Address) ?? null);
        }
        break;
      }
      case "closed": {
        // A round that may have forfeited without its expiry read stays open: the next tick
        // finds its account gone and looks the expiry up (`settleVanished`).
        const row = this.sql.exec<RoundRow>(
          "SELECT * FROM beacon_rounds WHERE address = ?",
          e.round,
        )[0];
        if (row && this.expiryUnaccounted(row.address, row.status)) break;
        this.sql.exec(
          "UPDATE beacon_rounds SET open = 0, status = 'closed', updated_at = ? WHERE address = ?",
          this.now(),
          e.round,
        );
        break;
      }
    }
  }

  // --- the alarm -----------------------------------------------------------------------------

  /**
   * Records an alarm once per round and kind, and logs it: `ALARM <kind>` is
   * what a monitor greps. `inferred`: raised for an expiry the keeper could
   * not read (`lookUpExpiry`), replaced by the expiry itself if it is read
   * later (`apply`).
   */
  private raise(round: string, kind: AlarmKind, detail: string, slot: bigint, inferred = false) {
    const before = this.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM beacon_alarms WHERE round = ? AND kind = ?",
      round,
      kind,
    )[0]?.n;
    if (before) return;
    const severity = ALARM_SEVERITY[kind];
    this.sql.exec(
      "INSERT INTO beacon_alarms (round, kind, severity, detail, slot, at, inferred, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
      round,
      kind,
      severity,
      detail,
      slot.toString(),
      this.now(),
      inferred ? 1 : 0,
    );
    const id = this.sql.exec<{ id: string | null }>(
      "SELECT id FROM beacon_rounds WHERE address = ?",
      round,
    )[0]?.id;
    const what: Record<AlarmKind, string> = {
      "withheld-draw": "a withheld draw: pause new tickets (guardian)",
      "unrequested-expiry": "a round nobody requested expired: the keepers failed, no pause",
      "request-late": "a paid round is still unrequested",
      "fulfilment-late": "a requested round is still unfulfilled: pause new tickets (guardian)",
      "expiry-overdue": "a round past its expiry cannot be expired: pause new tickets (guardian)",
      "low-balance": "the keeper's balance is below its floor: only paying steps run",
    };
    this.log(
      severity === "critical" ? "error" : "warn",
      `ALARM ${kind} round ${id ?? "?"} (${round}) at slot ${slot}: ${what[kind]}; ${detail}`,
    );
    // Acknowledged already (an inferred withheld draw replaced by its expiry, or one pruned
    // and found again): resolved at once, so that it never re-opens.
    this.acknowledge(round, kind);
  }

  /**
   * A round drawn after its `fulfilment-late`: ORAO fulfilled it after all,
   * so the alarm is resolved (kept as history, no longer pausing). Spec 02
   * §3's pause holds while a request is unfulfilled; a withheld draw shows
   * as an expiry, whose alarm is never resolved.
   */
  private resolveFulfilment(round: string) {
    this.sql.exec(
      "UPDATE beacon_alarms SET resolved_at = ?, resolution = 'drawn: ORAO fulfilled the request' WHERE round = ? AND kind = 'fulfilment-late' AND resolved_at = 0",
      this.now(),
      round,
    );
  }

  /**
   * Resolves the alarms the operator acknowledged (`BEACON_ACKNOWLEDGED_ALARMS`),
   * or only `round`'s of `kind`: each acknowledgement resolves the alarm of its
   * exact round and kind, never another kind on that round nor any other
   * round's, and logs it once. Run at start, at every tick, and when an alarm
   * is recorded: `raise` records a round and kind once, so an acknowledged
   * alarm stays resolved, and one recorded again (an inferred withheld draw
   * replaced by its expiry) is resolved before anything reads it.
   */
  private acknowledge(round?: string, kind?: AlarmKind) {
    for (const a of this.config.acknowledged) {
      if (round !== undefined && (a.round !== round || a.kind !== kind)) continue;
      const open = this.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM beacon_alarms WHERE round = ? AND kind = ? AND resolved_at = 0",
        a.round,
        a.kind,
      )[0]?.n;
      if (!open) continue;
      this.sql.exec(
        "UPDATE beacon_alarms SET resolved_at = ?, resolution = ? WHERE round = ? AND kind = ? AND resolved_at = 0",
        this.now(),
        `acknowledged: ${a.reason}`,
        a.round,
        a.kind,
      );
      this.log("warn", `round ${a.round}: ${a.kind} acknowledged by the operator: ${a.reason}`);
    }
  }

  /** Every unresolved critical alarm, newest first, then the newest others, `limit` in all at least. */
  alarms(limit = 50): AlarmView[] {
    return this.sql
      .exec<{
        round: string;
        kind: AlarmKind;
        severity: string;
        detail: string;
        slot: string;
        at: number;
        resolved_at: number;
        resolution: string | null;
        id: string | null;
      }>(
        `SELECT a.round, a.kind, a.severity, a.detail, a.slot, a.at, a.resolved_at, a.resolution, r.id
         FROM beacon_alarms a LEFT JOIN beacon_rounds r ON r.address = a.round
         WHERE (a.severity = 'critical' AND a.resolved_at = 0) OR a.rowid IN
           (SELECT rowid FROM beacon_alarms WHERE severity != 'critical' OR resolved_at > 0
            ORDER BY at DESC LIMIT ?)
         ORDER BY (a.severity = 'critical' AND a.resolved_at = 0) DESC, a.at DESC`,
        limit,
      )
      .map((a) => ({
        round: a.round,
        roundId: a.id,
        kind: a.kind,
        severity: a.severity,
        detail: a.detail,
        slot: a.slot,
        at: new Date(a.at).toISOString(),
        resolvedAt: a.resolved_at > 0 ? new Date(a.resolved_at).toISOString() : null,
        resolution: a.resolution,
      }));
  }

  /** Whether any unresolved alarm on record pauses new tickets, whatever the listing shows. */
  pauseRecommended(): boolean {
    const kinds = this.sql
      .exec<{ kind: AlarmKind }>("SELECT DISTINCT kind FROM beacon_alarms WHERE resolved_at = 0")
      .map((a) => a.kind);
    return kinds.some(pausesTickets);
  }

  health(): BeaconHealth {
    const alarms = this.alarms(20);
    const floor = this.config.minBalanceLamports;
    return {
      program: this.config.program,
      keeper: this.signer.address,
      format: this.format,
      lastTick: this.lastTick,
      lastTickMs: this.lastTickMs,
      lastSlot: this.lastSlot.toString(),
      openRounds:
        this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM beacon_rounds WHERE open = 1")[0]
          ?.n ?? 0,
      inFlight: this.pendingCount(),
      pauseRecommended: this.pauseRecommended(),
      acknowledgementError: this.config.acknowledgementError,
      balanceLamports: this.balance ? this.balance.lamports.toString() : null,
      lowBalance: this.balance !== null && this.balance.lamports < floor,
      alarms,
    };
  }

  // --- 3. the round scan -----------------------------------------------------------------------

  private async reconcile(): Promise<void> {
    const found = await this.chain.programAccounts(
      this.config.program,
      getRoundSize(),
      new Uint8Array(ROUND_DISCRIMINATOR),
    );
    for (const a of found) {
      const r = this.decodeRound(a);
      if (r) this.watchRound(a.address, r.id);
    }
  }

  // --- 4. the rounds -------------------------------------------------------------------------

  private decodeRound(read: AccountRead | null): Round | null {
    return decodeOwned(read, this.config.program, getRoundSize(), ROUND_DISCRIMINATOR, (d) =>
      getRoundDecoder().decode(d),
    );
  }

  private decodeTicket(read: AccountRead | null): RoundTicket | null {
    return decodeOwned(
      read,
      this.config.program,
      getRoundTicketSize(),
      ROUND_TICKET_DISCRIMINATOR,
      (d) => getRoundTicketDecoder().decode(d),
    );
  }

  private failRound(round: string, error: string) {
    const r = this.sql.exec<RoundRow>("SELECT * FROM beacon_rounds WHERE address = ?", round)[0];
    if (!r) {
      this.log("warn", error);
      return;
    }
    this.sql.exec(
      "UPDATE beacon_rounds SET attempts = ?, next_try_at = ?, last_error = ?, updated_at = ? WHERE address = ?",
      r.attempts + 1,
      this.now() + backoff(r.attempts),
      error.slice(0, 300),
      this.now(),
      round,
    );
    this.log("warn", `round ${r.id ?? "?"}: ${error}`);
  }

  private retrySoon(round: string) {
    this.sql.exec(
      "UPDATE beacon_rounds SET next_try_at = ? WHERE address = ?",
      this.now() + SOON_MS,
      round,
    );
  }

  private succeeded(round: string) {
    this.sql.exec(
      "UPDATE beacon_rounds SET attempts = 0, next_try_at = 0, last_error = NULL WHERE address = ?",
      round,
    );
  }

  /**
   * Defers a step the balance floor declined: looked at again in
   * `DEFERRED_MS`, and moved behind the rounds that can act now (`work`'s
   * order), so that rounds waiting on a floor never hold the window.
   */
  private defer(round: string) {
    this.sql.exec(
      "UPDATE beacon_rounds SET next_try_at = ?, updated_at = ? WHERE address = ?",
      this.now() + DEFERRED_MS,
      this.now(),
      round,
    );
  }

  private async work(): Promise<{ waits: bigint[]; busy: boolean; retryInMs: number }> {
    // The window, by urgency: every round that can still be paid, requested or fulfilled
    // first (its deadline is the window's), or not read yet; then the rounds that can act
    // now; then those backing off or deferred. Within each, the one changed longest ago.
    const rows = this.sql.exec<RoundRow>(
      `SELECT * FROM beacon_rounds WHERE open = 1 ORDER BY
         CASE WHEN status IS NULL OR status IN (?, ?, ?) THEN 0 ELSE 1 END,
         CASE WHEN next_try_at > ? THEN 1 ELSE 0 END,
         updated_at
       LIMIT ?`,
      RoundStatus[RoundStatus.Accepting],
      RoundStatus[RoundStatus.Paid],
      RoundStatus[RoundStatus.Requested],
      this.now(),
      this.roundsPerTick,
    );
    // A requested round's request, known from an earlier tick, is read with it, at the same slot.
    const prefetch = rows
      .map((r) => this.requests.get(r.address as Address))
      .filter((a): a is Address => a !== undefined);
    // The vault in the same read: its forfeiture count is at the slot the rounds are read at,
    // so that a round seen gone is in it if it forfeited (`unaccountedWithheld`).
    const first = await this.chain.accounts([
      SLOT_HASHES_SYSVAR,
      this.networkState!,
      ...rows.map((r) => r.address as Address),
      ...prefetch,
      this.vault!,
    ]);
    const prefetched = new Map<Address, AccountRead | null>();
    prefetch.forEach((a, i) => prefetched.set(a, first.accounts[rows.length + 2 + i] ?? null));
    const slot = first.slot;
    this.lastSlot = slot;
    const vaultRead = first.accounts[rows.length + 2 + prefetch.length] ?? null;
    const vault = decodeOwned(
      vaultRead,
      this.config.program,
      vaultRead?.data.length ?? 0,
      VAULT_DISCRIMINATOR,
      (d) => getVaultDecoder().decode(d),
    );
    this.forfeits = vault ? { withheld: vault.forfeitsWithheld, slot } : null;
    const slotHashes = first.accounts[0]?.data ?? null;
    const network = first.accounts[1] ?? null;
    const rounds: { row: RoundRow; held: Held<Round> }[] = [];
    // Expiries to look up, after every round has had its step: a lookup is many reads, and
    // never delays a request or a settlement (`lookUps`).
    const lookups: { row: RoundRow; vanished: boolean }[] = [];
    const waits: bigint[] = [];
    let busy = false;
    let retryInMs = Infinity;
    for (const [i, row] of rows.entries()) {
      const read = first.accounts[i + 2] ?? null;
      const round = this.decodeRound(read);
      if (!round) {
        if (this.expiryUnaccounted(row.address, row.status)) {
          // Gone before the keeper saw how it ended: it may have forfeited, its expiry unread.
          lookups.push({ row, vanished: true });
          continue;
        }
        this.closeRow(row.address);
        continue;
      }
      // A lookup episode lasts while the round is forfeited or gone: a round read in any
      // other status (a read that came back empty once, then the account again), or read
      // forfeited for the first time, starts the next episode's clock afresh.
      const forfeited = RoundStatus[RoundStatus.Forfeited];
      if (
        (RoundStatus[round.status] !== forfeited || row.status !== forfeited) &&
        (row.lookup_tries > 0 ||
          row.lookup_first_at > 0 ||
          row.lookup_next_at > 0 ||
          row.lookup_before !== null)
      ) {
        this.clearLookup(row.address);
        Object.assign(row, {
          lookup_tries: 0,
          lookup_first_at: 0,
          lookup_next_at: 0,
          lookup_before: null,
          lookup_read: 0,
          lookup_gap: 0,
        });
      }
      if (round.status === RoundStatus.Drawn) this.resolveFulfilment(row.address);
      // Forfeited after its request (`funded`: `round_vrf` paid ORAO): ORAO's refund of a
      // request it left pending may land on `round_vrf` at any time, the round closed or not.
      if (round.status === RoundStatus.Forfeited && round.funded > 0n)
        this.watchVrf(row.address, round.id, round.randomness);
      if (row.id === null || row.status !== RoundStatus[round.status]) {
        this.sql.exec(
          "UPDATE beacon_rounds SET id = ?, status = ?, updated_at = ? WHERE address = ?",
          round.id.toString(),
          RoundStatus[round.status],
          this.now(),
          row.address,
        );
      }
      rounds.push({ row, held: { address: row.address as Address, data: round } });
    }

    // The request accounts the decisions depend on, read at once.
    const named = new Map<Address, Address | null>();
    for (const { held } of rounds) {
      const r = held.data;
      if (r.status === RoundStatus.Requested) {
        named.set(held.address, r.randomness);
        this.requests.set(held.address, r.randomness);
        continue;
      }
      this.requests.delete(held.address);
      if (
        r.status === RoundStatus.Paid &&
        slotHashes &&
        nextAction(r, slot, "absent", this.opts()).kind === "expire"
      )
        named.set(
          held.address,
          (await roundRequestAddress(held, slotHashes, this.cfg))?.request ?? null,
        );
    }
    const reads = new Map<Address, AccountRead | null>(prefetched);
    const toRead = [
      ...new Set([...named.values()].filter((a): a is Address => a !== null && !reads.has(a))),
    ];
    const second = toRead.length ? await this.chain.accounts(toRead) : { accounts: [] };
    toRead.forEach((a, i) => reads.set(a, second.accounts[i] ?? null));

    for (const { row, held } of rounds) {
      const r = held.data;
      if (this.hold(r, slot)) continue;
      // Forfeited: the alarm looks its expiry up, whatever the event cursor read.
      const unaccounted =
        r.status === RoundStatus.Forfeited &&
        this.expiryUnaccounted(held.address, RoundStatus[r.status]);
      if (unaccounted) lookups.push({ row, vanished: false });
      if (r.status !== RoundStatus.Paid && r.status !== RoundStatus.Requested)
        this.expireFailures.delete(held.address);
      const requestAddress = named.get(held.address) ?? null;
      const requestRead = requestAddress ? (reads.get(requestAddress) ?? null) : null;
      const requestState = requestStateOf(requestRead);
      const requestedSlot = row.requested_slot === null ? null : BigInt(row.requested_slot);
      const late = lateAlarm(r, slot, requestState, requestedSlot);
      if (late)
        this.raise(
          held.address,
          late,
          late === "request-late"
            ? `closed at slot ${r.closeSlot}, unrequested at ${slot}`
            : `entropy slot ${r.entropySlot}, requested at slot ${requestedSlot ?? "unknown"}, ` +
                `unfulfilled at ${slot}`,
          slot,
        );
      // An accepting round can be paid in any slot: woken when its request could first open.
      const wake = acceptingWake(r, slot);
      if (wake !== null) waits.push(wake);
      const failures = this.expireFailures.get(held.address) ?? 0;
      if (overdueAlarm(r, slot, failures))
        this.raise(
          held.address,
          "expiry-overdue",
          `${RoundStatus[r.status]}, expiry from slot ${r.closeSlot + r.tSettleSlots + 1n}, ` +
            `still there at ${slot}, ${failures} refused expiries; last error: ${row.last_error ?? "none"}`,
          slot,
        );
      if (this.roundBusy(held.address)) {
        busy = true;
        continue;
      }
      if (this.now() < row.next_try_at) {
        retryInMs = Math.min(retryInMs, row.next_try_at - this.now());
        continue;
      }
      const action = nextAction(r, slot, requestState, this.opts());
      if (action.kind === "wait") {
        if (action.untilSlot !== null) waits.push(action.untilSlot);
        if (r.status === RoundStatus.Requested) busy = true; // ORAO fulfils within seconds
        continue;
      }
      if (action.kind === "done") {
        if (unaccounted) continue; // kept until its expiry is accounted for
        this.sql.exec(
          "UPDATE beacon_rounds SET open = 0, updated_at = ? WHERE address = ?",
          this.now(),
          held.address,
        );
        continue;
      }
      try {
        const acted = await this.act(action, held, slot, slotHashes, network, requestRead);
        if (acted) {
          busy = true;
          this.succeeded(held.address);
        }
      } catch (e) {
        if (e instanceof RetrySoon) {
          this.retrySoon(held.address);
          retryInMs = Math.min(retryInMs, SOON_MS);
        } else {
          if (action.kind === "expire") this.countExpireFailure(held.address);
          this.failRound(held.address, `${action.kind}: ${short(e)}`);
        }
      }
    }
    retryInMs = Math.min(retryInMs, await this.lookUps(lookups));
    return { waits, busy, retryInMs };
  }

  /**
   * The tick's expiry lookups, once its rounds have had their steps: the
   * ones due, soonest due first, `EXPIRY_LOOKUPS_PER_TICK` rounds and
   * `EXPIRY_TXS_PER_TICK` transactions read at most over all of them; the
   * others wait for the next tick. A round gone whose lookup settles is
   * closed. Returns the delay before the next one is due.
   */
  private async lookUps(lookups: { row: RoundRow; vanished: boolean }[]): Promise<number> {
    let retryInMs = Infinity;
    const now = this.now();
    const due = lookups
      .filter(({ row }) => {
        if (now >= row.lookup_next_at) return true;
        retryInMs = Math.min(retryInMs, row.lookup_next_at - now);
        return false;
      })
      .sort((a, b) => a.row.lookup_next_at - b.row.lookup_next_at);
    const budget = { txs: EXPIRY_TXS_PER_TICK };
    for (const [i, { row, vanished }] of due.entries()) {
      if (i >= EXPIRY_LOOKUPS_PER_TICK || budget.txs <= 0) {
        retryInMs = Math.min(retryInMs, SOON_MS);
        break;
      }
      // The alarm's slot, if one is raised: the one this tick read its rounds at.
      const later = await this.lookUpExpiry(row, vanished, this.lastSlot, budget);
      if (later !== null) retryInMs = Math.min(retryInMs, later);
      else if (vanished) this.closeRow(row.address);
    }
    return retryInMs;
  }

  /** A round gone: closed, with its tickets not parked. */
  private closeRow(address: string) {
    this.expireFailures.delete(address);
    this.sql.exec(
      "UPDATE beacon_rounds SET open = 0, status = 'closed', updated_at = ? WHERE address = ?",
      this.now(),
      address,
    );
    this.sql.exec("UPDATE beacon_tickets SET open = 0 WHERE round = ? AND parked = 0", address);
  }

  private opts() {
    return { sponsor: this.config.sponsor !== null, pushRefunds: this.config.pushRefunds };
  }

  /** Does `action` for `round`; true if it sent something. */
  private async act(
    action: RoundAction,
    round: Held<Round>,
    slot: bigint,
    slotHashes: Uint8Array | null,
    network: AccountRead | null,
    request: AccountRead | null,
  ): Promise<boolean> {
    // Below the floor, only what pays the keeper or meets a deadline: a forfeited round's
    // returns (each pays its settlement share), and the reclaim of its own sponsorship.
    const discretionary =
      (action.kind === "reclaim" && !this.sponsoredBySelf(round.address)) ||
      (action.kind === "return" && round.data.status === RoundStatus.Refunded);
    if (discretionary && !(await this.funded(0n))) {
      this.defer(round.address);
      return false;
    }
    switch (action.kind) {
      case "sponsor":
        return this.sponsor(round);
      case "request":
      case "late-bind": {
        if (!slotHashes) throw new RetrySoon();
        // The seed is recorded ahead of the request, in a transaction of its own, as soon as
        // SlotHashes proves the entropy slot: whatever becomes of the request (refused, failed
        // on chain, never landed), whoever creates it through ORAO and reads its outcome cannot
        // wait for the sysvar to forget the round and choose its end (Spec 08 §13.5.6a). Either
        // order is accepted: the request reads a recorded seed, and a record that lands after
        // the request, or after anyone's record, succeeds without writing.
        const recorded = await this.recordEntropy(round, slotHashes, "ahead of its request");
        let built: Awaited<ReturnType<typeof getBeaconRequestDrawInstructionAsync>>;
        try {
          if (!network || network.owner !== ORAO_VRF_PROGRAM_ADDRESS)
            throw new Error("ORAO's network state is unreadable");
          const { treasury } = oraoNetworkState(network.data);
          const namedReq = await roundRequestAddress(round, slotHashes, this.cfg);
          if (!namedReq) throw new RetrySoon(); // the entropy slot is not in SlotHashes yet
          const read =
            action.kind === "late-bind" && request?.address === namedReq.request
              ? request
              : ((await this.chain.accounts([namedReq.request])).accounts[0] ?? null);
          built = await getBeaconRequestDrawInstructionAsync(
            this.signer,
            round,
            slot,
            slotHashes,
            treasury,
            read,
            this.cfg,
          );
          await this.send(
            round.address,
            built.late ? "late-bind" : "request",
            [built.instruction],
            UNITS.request,
          );
        } catch (e) {
          // The request writes the round's seed; refused (ORAO's fee above the prefund, say) or
          // not built (ORAO's network state unreadable or unparsable) when the record ahead of
          // it was not sent (refused at send), the seed is recorded on its own while SlotHashes
          // still proves it.
          if (!(e instanceof RetrySoon) && !recorded)
            await this.recordEntropy(round, slotHashes, "its request refused");
          throw e;
        }
        if (!built.late)
          // A lower bound of the slot the request lands (it cannot land before the slot it was
          // built at), until its `RoundDrawRequested` gives the slot itself.
          this.sql.exec(
            "UPDATE beacon_rounds SET requested_slot = COALESCE(requested_slot, ?) WHERE address = ?",
            slot.toString(),
            round.address,
          );
        return true;
      }
      case "expire": {
        if (!slotHashes) throw new RetrySoon();
        try {
          const ix = await getBeaconExpireInstructionAsync(
            this.signer,
            round,
            slot,
            slotHashes,
            request,
            this.cfg,
          );
          await this.send(round.address, "expire", [ix], UNITS.expire);
          return true;
        } catch (e) {
          // Fulfilled with a randomness after all: settled or bound late on the next read.
          if (e instanceof RoundDrawFulfilledError) throw new RetrySoon();
          throw e;
        }
      }
      case "settle":
        return this.settle(round, request);
      case "return":
        return this.returns(round);
      case "reclaim":
        return this.reclaims(round);
      default:
        return false;
    }
  }

  /**
   * `record_round_entropy` for a paid round whose seed is not recorded, as
   * read, while SlotHashes proves its entropy slot; nothing otherwise. True
   * if it sent the record (in flight, or landed). Best effort: a refusal is
   * logged and changes nothing else, so that the step that called it goes
   * on. A record that lands after someone else's, or after the request,
   * succeeds without writing; one refused (the round forfeited meanwhile)
   * leaves nothing to record.
   */
  private async recordEntropy(round: Held<Round>, slotHashes: Uint8Array, why: string) {
    try {
      const ix = await getBeaconRecordEntropyInstructionAsync(round, slotHashes, this.cfg);
      if (!ix) return false;
      await this.send(round.address, "record", [ix], UNITS.record);
      this.log("info", `round ${round.address}: ${why}, its entropy recorded`);
      return true;
    } catch (e) {
      this.log("warn", `round ${round.address}: recording its entropy: ${short(e)}`);
      return false;
    }
  }

  /** Every `Joined` ticket of `round`: from the events, or listed when they do not add up. */
  private async joinedTickets(round: Held<Round>): Promise<Held<RoundTicket>[]> {
    const id = round.data.id;
    const known = this.sql
      .exec<{ address: string }>(
        "SELECT address FROM beacon_tickets WHERE round = ? AND open = 1",
        round.address,
      )
      .map((t) => t.address as Address);
    let held: Held<RoundTicket>[] = [];
    if (known.length) {
      const { accounts } = await this.chain.accounts(known);
      known.forEach((address, i) => {
        const t = this.decodeTicket(accounts[i] ?? null);
        if (t && t.round === id) held.push({ address, data: t });
        else if (!t) this.sql.exec("UPDATE beacon_tickets SET open = 0 WHERE address = ?", address);
      });
    }
    let joined = held.filter((t) => t.data.status === RoundTicketStatus.Joined);
    if (joined.length !== round.data.tickets) {
      const listed = await this.chain.programAccounts(
        this.config.program,
        getRoundTicketSize(),
        new Uint8Array(ROUND_TICKET_DISCRIMINATOR),
        { offset: TICKET_ROUND_OFFSET, bytes: le64(id) },
      );
      held = [];
      for (const a of listed) {
        const t = this.decodeTicket(a);
        if (!t || t.round !== id) continue;
        held.push({ address: a.address, data: t });
        this.sql.exec(
          `INSERT INTO beacon_tickets (address, round, integrator, open, parked) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT (address) DO UPDATE SET open = 1, parked = excluded.parked`,
          a.address,
          round.address,
          t.integrator,
          t.status === RoundTicketStatus.Joined ? 0 : 1,
        );
        this.sql.exec(
          "INSERT OR IGNORE INTO beacon_integrators (address, next_try_at) VALUES (?, 0)",
          t.integrator,
        );
      }
      joined = held.filter((t) => t.data.status === RoundTicketStatus.Joined);
    }
    return joined;
  }

  private async payoutTables(addresses: Iterable<Address>): Promise<Map<Address, PayoutTable>> {
    const missing = [...new Set(addresses)].filter((a) => !this.tables.has(a));
    if (missing.length) {
      const { accounts } = await this.chain.accounts(missing);
      missing.forEach((a, i) => {
        const t = decodeOwned(
          accounts[i] ?? null,
          this.config.program,
          getPayoutTableSize(),
          PAYOUT_TABLE_DISCRIMINATOR,
          (d) => getPayoutTableDecoder().decode(d),
        );
        if (t) this.tables.set(a, t); // a registered payout table never changes
      });
    }
    return this.tables;
  }

  private sponsoredBySelf(round: string): boolean {
    return (
      this.sql.exec(
        "SELECT 1 FROM beacon_sponsors WHERE round = ? AND sponsor = ?",
        round,
        this.signer.address,
      ).length > 0
    );
  }

  private async sponsor(round: Held<Round>): Promise<boolean> {
    const policy = this.config.sponsor;
    if (!policy) return false;
    const [record] = await findSponsorshipPda(
      { round: round.address, sponsor: this.signer.address },
      this.cfg,
    );
    const tickets = await this.joinedTickets(round);
    const { accounts } = await this.chain.accounts([record]);
    const already = accounts[0] !== null && accounts[0] !== undefined;
    const amount = sponsorAmount(
      round.data,
      tickets.map((t) => ({ integrator: t.data.integrator, appShare: t.data.appShare })),
      policy,
      already,
    );
    if (amount === null) return false;
    if (!(await this.funded(amount))) return false;
    const built = await getCompleteDrawInstructionAsync(this.signer, round, {
      maxLamports: amount,
      programAddress: this.config.program,
    });
    if (!built || built.lamports !== amount) return false;
    await this.send(round.address, "sponsor", [built.instruction], UNITS.sponsor);
    if (this.balance) this.balance.lamports -= amount;
    this.log("info", `round ${round.data.id}: sponsored ${amount} lamports to complete its draw`);
    return true;
  }

  private async settle(round: Held<Round>, request: AccountRead | null): Promise<boolean> {
    const randomness = roundRandomness(
      round.data,
      round.data.status === RoundStatus.Requested ? (request?.data ?? undefined) : undefined,
    );
    const tickets = await this.joinedTickets(round);
    if (!tickets.length) return false;
    const tables = await this.payoutTables(tickets.map((t) => t.data.payoutTable));
    const items = await predictSettlement(round, randomness, tickets, tables, this.cfg);
    const format = this.format ?? 1;
    const lifetime = await this.lifetime();
    const batches = await planSettlement(
      this.signer,
      round,
      items,
      this.config.usdcMint,
      {
        format,
        lifetime,
        priority:
          format === 1
            ? { priorityFeeLamports: this.priority.v1Lamports }
            : { microLamportsPerUnit: this.priority.v0MicroLamports },
      },
      this.cfg,
    );
    for (const b of batches) {
      await this.sendMessage(round.address, `settle ${b.items.length}`, b.message, lifetime);
      this.log(
        "info",
        `round ${round.data.id}: settlement batch of ${b.items.length} sent, v${format}, ${b.bytes} bytes, ${b.locks} locks`,
      );
    }
    return batches.length > 0;
  }

  /** The returns of a forfeited (or, when pushed, refunded) round, packed several to a transaction. */
  private async returns(round: Held<Round>): Promise<boolean> {
    const tickets = await this.joinedTickets(round);
    const ixs: Instruction[] = tickets.length ? await this.vrfSweep(round) : [];
    const led = ixs.length > 0;
    for (const t of tickets)
      ixs.push(
        await getBeaconReturnInstructionAsync(
          this.signer,
          round,
          t,
          this.config.usdcMint,
          this.cfg,
        ),
      );
    return this.sendLedBySweep(round.address, "return", ixs, UNITS.return, led);
  }

  private async reclaims(round: Held<Round>): Promise<boolean> {
    const id = round.data.id;
    const known = this.sql
      .exec<{ sponsor: string }>(
        "SELECT sponsor FROM beacon_sponsors WHERE round = ?",
        round.address,
      )
      .map((s) => s.sponsor as Address);
    const addresses = await Promise.all(
      known.map(
        async (sponsor) =>
          (await findSponsorshipPda({ round: round.address, sponsor }, this.cfg))[0],
      ),
    );
    const decode = (read: AccountRead | null) =>
      decodeOwned(read, this.config.program, getSponsorshipSize(), SPONSORSHIP_DISCRIMINATOR, (d) =>
        getSponsorshipDecoder().decode(d),
      );
    let records: Held<Sponsorship>[] = [];
    if (addresses.length) {
      const { accounts } = await this.chain.accounts(addresses);
      addresses.forEach((address, i) => {
        const s = decode(accounts[i] ?? null);
        if (s && s.round === id) records.push({ address, data: s });
      });
    }
    if (records.length !== round.data.sponsors) {
      records = [];
      for (const a of await this.chain.programAccounts(
        this.config.program,
        getSponsorshipSize(),
        new Uint8Array(SPONSORSHIP_DISCRIMINATOR),
        { offset: SPONSORSHIP_ROUND_OFFSET, bytes: le64(id) },
      )) {
        const s = decode(a);
        if (s && s.round === id) records.push({ address: a.address, data: s });
      }
    }
    const ixs: Instruction[] = records.length ? await this.vrfSweep(round) : [];
    const led = ixs.length > 0;
    for (const s of records)
      ixs.push(await getBeaconReclaimInstructionAsync(this.signer, round, s, this.cfg));
    return this.sendLedBySweep(round.address, "reclaim", ixs, UNITS.reclaim, led);
  }

  /**
   * `ixs` packed (`sendPacked`), the first of them a `vrfSweep` when `led`. A
   * program that does not know the sweep refuses the first transaction at
   * preflight, the instructions packed with it too: they are sent again at
   * once without it, so that a missing sweep never holds back a return or a
   * reclaim, and no sweep is sent for `SWEEP_RECHECK_MS`.
   */
  private async sendLedBySweep(
    round: string,
    kind: string,
    ixs: Instruction[],
    units: number,
    led: boolean,
  ) {
    try {
      return await this.sendPacked(round, kind, ixs, units);
    } catch (e) {
      if (!led || !this.sweepRefusedAsUnknown(e)) throw e;
      return this.sendPacked(round, kind, ixs.slice(1), units);
    }
  }

  /** Whether the sweep is held back: the program refused it as unknown less than `SWEEP_RECHECK_MS` ago. */
  private sweepHeldBack(): boolean {
    if (this.sweepUnknownSince === null) return false;
    if (this.now() - this.sweepUnknownSince < SWEEP_RECHECK_MS) return true;
    this.sweepUnknownSince = null;
    return false;
  }

  /**
   * Whether `e` is the program refusing an instruction it does not know
   * (Anchor's `InstructionFallbackNotFound`, error 101) at preflight: a
   * program deployed without `sweep_round_vrf`. Records it, for
   * `sweepHeldBack`.
   */
  private sweepRefusedAsUnknown(e: unknown): boolean {
    if (!(e instanceof SendRefusedError)) return false;
    const unknown = e.logs.some(
      (l) =>
        l.includes("InstructionFallbackNotFound") ||
        l === `Program ${this.config.program} failed: custom program error: 0x65`,
    );
    if (!unknown) return false;
    this.sweepUnknownSince = this.now();
    this.log(
      "warn",
      `the program does not know sweep_round_vrf: none sent for the next hour (${e.message})`,
    );
    return true;
  }

  /**
   * `sweep_round_vrf` of `round`, to lead its returns or its reclaims, when its
   * `round_vrf` holds lamports (ORAO's refund for a request fulfilled after the
   * round forfeited, or a transfer): ahead of the instruction that closes the
   * round, they reach the round and so its rent payer (Spec 08 §13.5.8a). The
   * sweep succeeds with nothing to move, so a race costs nothing. Best effort:
   * an unreadable balance sends none, and `sweepVrfs` finds the lamports later.
   */
  private async vrfSweep(round: Held<Round>): Promise<Instruction[]> {
    if (this.sweepHeldBack()) return [];
    try {
      const [vrf] = await findRoundVrfPda({ round: round.address }, this.cfg);
      if (!roundVrfSweepable(round.data, await this.chain.balance(vrf))) return [];
      return [
        await getBeaconSweepVrfInstructionAsync(this.signer, round.data.id, round.data, this.cfg),
      ];
    } catch (e) {
      this.log("warn", `round ${round.data.id}: reading round_vrf: ${short(e)}`);
      return [];
    }
  }

  /**
   * The `round_vrf`s watched (`beacon_vrfs`: the rounds seen forfeited after
   * their request, for `VRF_WATCH_MS`), `VRFS_PER_PASS` a pass, the longest
   * unread first (`checked_at`): one holding lamports is swept, into its
   * round while the round exists (below the balance floor, left to the
   * round's returns and reclaims, which lead with the sweep), to the keeper
   * once it has closed, which pays the transaction's fee and more (Spec 08
   * §13.5.8a). A watch ends early once nothing more can come: the round
   * closed, its ORAO request read fulfilled (the refund lands with the
   * fulfilment) and `round_vrf` read empty no earlier than both, which is also how a landed sweep
   * of a closed round ends it, on the pass after. None while the program
   * does not know the sweep (`sweepHeldBack`).
   */
  private async sweepVrfs(): Promise<void> {
    this.sql.exec("DELETE FROM beacon_vrfs WHERE until < ?", this.now());
    if (this.sweepHeldBack()) return;
    const rows = this.sql.exec<{ round: string; id: string; request: string | null }>(
      "SELECT round, id, request FROM beacon_vrfs ORDER BY checked_at, until LIMIT ?",
      VRFS_PER_PASS,
    );
    if (!rows.length) return;
    const now = this.now();
    for (const row of rows)
      this.sql.exec("UPDATE beacon_vrfs SET checked_at = ? WHERE round = ?", now, row.round);
    // The rounds and their requests at one slot, and each round_vrf's balance from a node at that
    // slot or later: a fulfilment read is then in the balance read after it.
    const requests = rows.flatMap((r) => (r.request ? [r.request as Address] : []));
    const { slot, accounts } = await this.chain.accounts([
      ...rows.map((r) => r.round as Address),
      ...requests,
    ]);
    const requestReads = new Map(requests.map((a, i) => [a, accounts[rows.length + i] ?? null]));
    for (const [i, row] of rows.entries()) {
      const read = accounts[i] ?? null;
      const round = this.decodeRound(read);
      // An account the program still owns that does not decode is no closed round.
      if (!round && read?.owner === this.config.program) continue;
      if (this.roundBusy(row.round)) continue;
      const [vrf] = await findRoundVrfPda({ round: row.round as Address }, this.cfg);
      let lamports: bigint;
      try {
        lamports = await this.chain.balance(vrf, slot);
      } catch (e) {
        // A node behind the accounts read, or no answer: the watch reads it again on a later pass.
        this.log("info", `round ${row.id}: reading round_vrf: ${short(e)}`);
        continue;
      }
      if (!roundVrfSweepable(round, lamports)) {
        const answered = row.request
          ? ["fulfilled", "zero"].includes(
              requestStateOf(requestReads.get(row.request as Address) ?? null),
            )
          : false;
        if (read === null && lamports === 0n && answered)
          this.sql.exec("DELETE FROM beacon_vrfs WHERE round = ?", row.round);
        continue;
      }
      if (round && !(await this.funded(0n))) continue;
      const ix = await getBeaconSweepVrfInstructionAsync(
        this.signer,
        BigInt(row.id),
        round,
        this.cfg,
      );
      try {
        await this.send(row.round, "sweep_round_vrf", [ix], UNITS.sweepVrf);
      } catch (e) {
        if (this.sweepRefusedAsUnknown(e)) return;
        this.log("warn", `round ${row.id}: sweep_round_vrf: ${short(e)}`);
      }
    }
  }

  // --- the expiry, from the round's own transactions -------------------------------------------

  /**
   * Whether the round at `address`, last read in `status` (null: never
   * read), may have forfeited without an alarm to show for it: no expiry
   * alarm is on record and it did not end drawn or refunded.
   */
  private expiryUnaccounted(address: string, status: string | null): boolean {
    if (status !== null && (SETTLED_STATUSES.includes(status) || status === "closed")) return false;
    return !(
      (this.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM beacon_alarms WHERE round = ? AND kind IN ${EXPIRY_ALARMS}`,
        address,
      )[0]?.n ?? 0) > 0
    );
  }

  /**
   * Looks for how the round of `row` ended among its own transactions,
   * paging back from the newest (`EXPIRY_SIGNATURES`): its `RoundExpired`
   * raises the alarm the event would have, a `RoundDrawn` or
   * `RoundRefunded` (only when it `vanished`, its last status unknown)
   * shows nothing was withheld. A pass is complete when it reaches a
   * transaction from before any expiry (`PRE_EXPIRY`: its opening, a join,
   * its payment, a sponsorship, its request) or the round's first
   * transaction; it reads at most `budget.txs` transactions now, and goes on
   * from where it stopped on the next tick (`lookup_before`), so that the
   * honest traffic after an expiry (a return a transaction, the reclaims,
   * the closing) never hides it. Returns null once settled, or the delay
   * before the next lookup is due. Passes are spaced (`lookupBackoff`) and
   * kept in the round's row, so that a restart does not start them over.
   * Nothing found after `EXPIRY_LOOKUP_TRIES` complete passes and
   * `EXPIRY_LOOKUP_MIN_MS` since the first (`EXPIRY_UNREADABLE_MS` when a
   * transaction was unreadable, the lookup failed, or the pass stopped at
   * `EXPIRY_MAX_TXS`: an RPC lagging or a round buried, not an answer), the
   * history decides nothing: the program's durable count does
   * (`Vault.forfeits_withheld`, `unaccountedWithheld`). With every
   * forfeiture it counts as withheld accounted for, the round was no
   * withheld draw (gone: no alarm; still there forfeited: the keepers'
   * failure, a warning). Otherwise, or with the vault unreadable, it is
   * taken as a withheld draw, the safe reading (Spec 09 §10), and claims the
   * oldest unaccounted ordinal. The alarm is stored as inferred, and the
   * round's `RoundExpired`, if it is read later, replaces it (`apply`).
   * Anyone can bury a round's end under transactions naming it; that raises
   * nothing unless a forfeiture the program counts as withheld is unread.
   */
  private async lookUpExpiry(
    row: RoundRow,
    vanished: boolean,
    slot: bigint,
    budget: { txs: number },
  ): Promise<number | null> {
    const address = row.address;
    const now = this.now();
    if (now < row.lookup_next_at) return row.lookup_next_at - now;
    let before = (row.lookup_before ?? undefined) as Signature | undefined;
    let read = row.lookup_read;
    let gap = row.lookup_gap > 0;
    let reason = "not found back to the round's first transactions";
    let complete = false;
    try {
      let pages = 0;
      scan: while (budget.txs > 0 && pages++ < EXPIRY_PAGES_PER_TICK) {
        const sigs = await this.chain.signatures(address as Address, {
          ...(before ? { before } : {}),
          limit: EXPIRY_SIGNATURES,
        });
        for (const s of sigs) {
          if (read >= EXPIRY_MAX_TXS) {
            reason = `not found among its ${read} newest transactions`;
            gap = true;
            complete = true;
            break scan;
          }
          if (!s.failed) {
            if (budget.txs <= 0) break scan; // goes on from `before` on the next tick
            budget.txs--;
            const tx = await this.chain.transaction(s.signature);
            if (!tx) {
              reason = `transaction ${s.signature} unreadable`;
              gap = true;
            } else {
              const events = beaconEventsOf(tx, this.config.program, this.eventAuthority!).filter(
                (e) => e.round === address,
              );
              const expired = events.find((e) => e.kind === "expired");
              if (expired) {
                this.clearLookup(address);
                this.apply(expired, tx);
                return null;
              }
              if (vanished && events.some((e) => e.kind === "drawn" || e.kind === "refunded")) {
                this.clearLookup(address);
                return null;
              }
              const earlier = events.find((e) => PRE_EXPIRY.includes(e.kind));
              if (earlier) {
                if (!gap) reason = `not found back to its ${earlier.kind} transaction`;
                complete = true;
                break scan;
              }
            }
          }
          read++;
          before = s.signature;
        }
        if (sigs.length < EXPIRY_SIGNATURES) {
          complete = true;
          break;
        }
      }
    } catch (e) {
      reason = `lookup failed: ${short(e)}`;
      gap = true;
      complete = true;
    }
    const first = row.lookup_first_at > 0 ? row.lookup_first_at : now;
    if (!complete) {
      // The tick's budget spent mid-pass: the pass goes on from `before` on the next tick.
      this.sql.exec(
        "UPDATE beacon_rounds SET lookup_first_at = ?, lookup_next_at = 0, lookup_before = ?, lookup_read = ?, lookup_gap = ? WHERE address = ?",
        first,
        before ?? null,
        read,
        gap ? 1 : 0,
        address,
      );
      return SOON_MS;
    }
    const tries = row.lookup_tries + 1;
    const bound = gap ? EXPIRY_UNREADABLE_MS : EXPIRY_LOOKUP_MIN_MS;
    if (tries < EXPIRY_LOOKUP_TRIES || now - first < bound) {
      // The next pass starts again from the newest: the expiry may be served by then.
      const wait = lookupBackoff(tries);
      this.sql.exec(
        "UPDATE beacon_rounds SET lookup_tries = ?, lookup_first_at = ?, lookup_next_at = ?, lookup_before = NULL, lookup_read = 0, lookup_gap = 0 WHERE address = ?",
        tries,
        first,
        now + wait,
        address,
      );
      return wait;
    }
    this.clearLookup(address);
    const what =
      `expiry event not read (${vanished ? "round gone" : "round forfeited"}; ${reason}; ` +
      `${tries} lookups over ${Math.round((now - first) / 1_000)} s)`;
    // Transaction history is no proof either way: anyone can bury a round's end under
    // transactions naming it. The program's count is: with every forfeiture it counts as
    // withheld already accounted for, this round's end was no withheld draw. Gone, it was
    // drawn, refunded or forfeited by the keepers' failure; still there forfeited, the last.
    const open = this.unaccountedWithheld();
    if (open !== null && open.ordinal === null) {
      if (vanished) {
        this.log(
          "warn",
          `round ${address}: ${what}; the vault counts no withheld forfeiture unaccounted for: not a withheld draw`,
        );
      } else {
        this.raise(
          address,
          "unrequested-expiry",
          `${what}; the vault counts no withheld forfeiture unaccounted for: the keepers' failure`,
          slot,
          true,
        );
        this.recordForfeit(address, null, true);
      }
      return null;
    }
    // A forfeiture the program counts as withheld is not accounted for (or the vault was
    // unreadable): this round is taken as it, the safe reading (Spec 09 §10), and claims
    // the oldest such ordinal until that forfeiture's own expiry is read.
    this.raise(
      address,
      "withheld-draw",
      `${what}: taken as withheld` +
        (open === null
          ? " (the vault unreadable)"
          : `, ${open.count} withheld forfeiture(s) the vault counts unaccounted for`),
      slot,
      true,
    );
    this.recordForfeit(address, open?.ordinal ?? null, true);
    return null;
  }

  /**
   * Records how a round's forfeiture is accounted for: its ordinal in
   * `Vault.forfeits_withheld` (`RoundExpired.forfeits_withheld`) when it
   * counts as withheld, null otherwise; read from its expiry, or inferred by
   * a lookup. One row a round; a read expiry replaces an inference, never
   * the reverse, and takes its ordinal from any inference that claimed it
   * for another round (that alarm is kept). Rows are kept for ever, one a
   * forfeiture, since the program's count is never reset.
   */
  private recordForfeit(round: string, ordinal: bigint | null, inferred: boolean) {
    if (!inferred && ordinal !== null)
      this.sql.exec(
        "DELETE FROM beacon_forfeits WHERE inferred = 1 AND ordinal = ? AND round != ?",
        Number(ordinal),
        round,
      );
    this.sql.exec(
      `INSERT INTO beacon_forfeits (round, ordinal, inferred, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (round) DO UPDATE SET ordinal = excluded.ordinal,
         inferred = excluded.inferred, at = excluded.at
       WHERE beacon_forfeits.inferred = 1`,
      round,
      ordinal === null ? null : Number(ordinal),
      inferred ? 1 : 0,
      this.now(),
    );
  }

  /**
   * The forfeitures `Vault.forfeits_withheld` counts, at the slot this tick
   * read it, that no row accounts for: how many, and the oldest one's
   * ordinal (null when none is). Null when the vault was unreadable, and
   * the caller then fails closed. A row accounts for one ordinal, from the
   * expiry that carries it or from an inference that claimed it, so every
   * forfeiture the program counts as withheld has a critical alarm raised for
   * it, on its own round or on one a lookup could not tell apart.
   */
  private unaccountedWithheld(): { count: bigint; ordinal: bigint | null } | null {
    const f = this.forfeits;
    if (!f) return null;
    const w = Number(f.withheld);
    const known =
      this.sql.exec<{ n: number }>(
        "SELECT COUNT(DISTINCT ordinal) AS n FROM beacon_forfeits WHERE ordinal BETWEEN 1 AND ?",
        w,
      )[0]?.n ?? 0;
    const count = BigInt(Math.max(0, w - known));
    if (count === 0n) return { count, ordinal: null };
    const first = this.sql.exec<{ k: number | null }>(
      `SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM beacon_forfeits WHERE ordinal = 1) THEN 1
         ELSE (SELECT MIN(a.ordinal + 1) FROM beacon_forfeits a WHERE a.ordinal IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM beacon_forfeits b WHERE b.ordinal = a.ordinal + 1))
       END AS k`,
    )[0]?.k;
    return { count, ordinal: first === null || first === undefined ? null : BigInt(first) };
  }

  /** Ends a round's lookup episode: the next one starts its clock afresh. */
  private clearLookup(address: string) {
    this.sql.exec(
      "UPDATE beacon_rounds SET lookup_tries = 0, lookup_first_at = 0, lookup_next_at = 0, lookup_before = NULL, lookup_read = 0, lookup_gap = 0 WHERE address = ?",
      address,
    );
  }

  // --- the balance floor -----------------------------------------------------------------------

  /**
   * Whether the keeper may spend `spend` lamports, and a transaction's fees,
   * on a step that earns it nothing, and stay above its floor. Below it, the
   * `low-balance` alarm is raised once (cleared when the balance is back).
   * An unreadable balance refuses: the safe reading.
   */
  private async funded(spend: bigint): Promise<boolean> {
    const lamports = await this.checkBalance();
    return (
      lamports !== null && lamports >= this.config.minBalanceLamports + spend + FEE_MARGIN_LAMPORTS
    );
  }

  /**
   * The keeper's lamports, read again once `BALANCE_MS` old; null when
   * unreadable. Below the floor, the `low-balance` alarm is raised once; at
   * or above it, cleared. The tick calls it every `BALANCE_MS` whatever
   * steps are enabled, so the alarm does not wait for a discretionary step.
   */
  private async checkBalance(): Promise<bigint | null> {
    if (!this.balance || this.now() - this.balance.at >= BALANCE_MS) {
      try {
        this.balance = { lamports: await this.chain.balance(this.signer.address), at: this.now() };
      } catch (e) {
        this.log("warn", `reading the keeper's balance: ${short(e)}`);
        return null;
      }
    }
    const floor = this.config.minBalanceLamports;
    const lamports = this.balance.lamports;
    if (lamports >= floor)
      this.sql.exec(
        "DELETE FROM beacon_alarms WHERE round = ? AND kind = 'low-balance'",
        this.signer.address,
      );
    else
      this.raise(
        this.signer.address,
        "low-balance",
        `${lamports} lamports, floor ${floor}: sponsor, sweeps, parked payouts, reclaims and pushed refunds stopped`,
        this.lastSlot,
      );
    return lamports;
  }

  // --- 5. shares and parked payouts ----------------------------------------------------------

  /** `claim_shares` for the protocol and every integrator seen, from `sweepMinUnits` each. */
  private async sweepShares(): Promise<void> {
    const min = this.config.sweepMinUnits;
    if (min === null) return;
    if (!(await this.funded(0n))) return;
    const [config] = await findConfigPda(this.cfg);
    const [vault] = await findVaultPda(this.cfg);
    const [eventAuthority] = await findEventAuthorityPda(this.cfg);
    const integrators = this.sql
      .exec<{ address: string }>(
        "SELECT address FROM beacon_integrators WHERE next_try_at <= ? LIMIT 50",
        this.now(),
      )
      .map((i) => i.address as Address);
    const { accounts } = await this.chain.accounts([config, vault, ...integrators]);
    const c = decodeOwned(
      accounts[0] ?? null,
      this.config.program,
      accounts[0]?.data.length ?? 0,
      CONFIG_DISCRIMINATOR,
      (d) => getConfigDecoder().decode(d),
    );
    const v = decodeOwned(
      accounts[1] ?? null,
      this.config.program,
      accounts[1]?.data.length ?? 0,
      VAULT_DISCRIMINATOR,
      (d) => getVaultDecoder().decode(d),
    );
    if (!c || !v) throw new Error("config or vault unreadable");
    const common = {
      caller: this.signer,
      usdcMint: this.config.usdcMint,
      eventAuthority,
      program: this.config.program,
    };
    if (v.protocolSharesAccrued >= min) {
      const ix = await getClaimSharesInstructionAsync(
        { ...common, destination: c.protocolTreasury },
        this.cfg,
      );
      await this.send("", "claim_shares protocol", [ix], UNITS.claimShares).catch((e) =>
        this.log("warn", `claim_shares (protocol): ${short(e)}`),
      );
    }
    for (const [i, address] of integrators.entries()) {
      const it = decodeOwned(
        accounts[i + 2] ?? null,
        this.config.program,
        getIntegratorSize(),
        INTEGRATOR_DISCRIMINATOR,
        (d) => getIntegratorDecoder().decode(d),
      );
      if (!it || it.appSharesAccrued < min) continue;
      const ix = await getClaimSharesInstructionAsync(
        { ...common, integrator: address, destination: it.shareAccount },
        this.cfg,
      );
      try {
        await this.send("", "claim_shares integrator", [ix], UNITS.claimShares);
      } catch (e) {
        // Its share account cannot receive: retried in six hours, its owner may fix it.
        this.sql.exec(
          "UPDATE beacon_integrators SET next_try_at = ? WHERE address = ?",
          this.now() + 6 * 3_600_000,
          address,
        );
        this.log("warn", `claim_shares (${address}): ${short(e)}`);
      }
    }
  }

  /**
   * Parked payouts and returns, delivered once their destination can
   * receive again: the `parkedPerPass` due soonest, each refused one backed
   * off on its own (`parkedBackoff`), so that tickets whose destination
   * stays unusable never hold the others back.
   */
  private async retryParked(): Promise<void> {
    const now = this.now();
    const parked = this.sql
      .exec<{ address: string; tries: number }>(
        "SELECT address, tries FROM beacon_tickets WHERE parked = 1 AND next_try_at <= ? ORDER BY next_try_at, rowid LIMIT ?",
        now,
        this.parkedPerPass,
      )
      .map((t) => ({ address: t.address as Address, tries: t.tries }));
    if (!parked.length) return;
    if (!(await this.funded(0n))) return;
    const { accounts } = await this.chain.accounts(parked.map((p) => p.address));
    for (const [i, { address, tries }] of parked.entries()) {
      const t = this.decodeTicket(accounts[i] ?? null);
      if (!t || t.status === RoundTicketStatus.Joined) {
        if (!t)
          this.sql.exec(
            "UPDATE beacon_tickets SET open = 0, parked = 0 WHERE address = ?",
            address,
          );
        continue;
      }
      const ix = await getBeaconClaimPayoutInstructionAsync(
        this.signer,
        { address, data: t },
        this.config.usdcMint,
        this.cfg,
      );
      try {
        await this.send("", "claim_round_payout", [ix], UNITS.claimPayout);
        // Sent: its account, gone once delivered, is read on the next pass.
        this.sql.exec("UPDATE beacon_tickets SET next_try_at = ? WHERE address = ?", now, address);
      } catch (e) {
        // The preflight refuses it while the destination still cannot receive: nothing spent.
        this.sql.exec(
          "UPDATE beacon_tickets SET tries = ?, next_try_at = ? WHERE address = ?",
          tries + 1,
          now + parkedBackoff(tries + 1),
          address,
        );
        this.log("info", `claim_round_payout ${address}: ${short(e)}; retried later`);
      }
    }
  }

  // --- sending -------------------------------------------------------------------------------

  private async lifetime(): Promise<Lifetime> {
    if (this.blockhash && this.now() - this.blockhash.at < BLOCKHASH_MS)
      return this.blockhash.lifetime;
    const lifetime = await this.chain.latestBlockhash();
    this.blockhash = { lifetime, at: this.now() };
    return lifetime;
  }

  private budget(units: number): Budget {
    return this.format === 0
      ? { computeUnitLimit: units, microLamportsPerUnit: this.priority.v0MicroLamports }
      : { computeUnitLimit: units, priorityFeeLamports: this.priority.v1Lamports };
  }

  /** `ixs` in as few transactions as fit (`MAX_IXS_PER_TX` each, the format's size and locks). */
  private async sendPacked(round: string, kind: string, ixs: Instruction[], units: number) {
    if (!ixs.length) return false;
    const lifetime = await this.lifetime();
    const format = this.format ?? 1;
    let current: Instruction[] = [];
    const flush = async () => {
      if (!current.length) return;
      const message = beaconTransactionMessage(
        format,
        this.signer,
        lifetime,
        current,
        this.budget(units * current.length),
      );
      await this.sendMessage(round, `${kind} ${current.length}`, message, lifetime);
      current = [];
    };
    for (const ix of ixs) {
      const candidate = [...current, ix];
      const m = beaconTransactionMessage(
        format,
        this.signer,
        lifetime,
        candidate,
        this.budget(units * candidate.length),
      );
      if (candidate.length > MAX_IXS_PER_TX || !measure(m).fits) await flush();
      current.push(ix);
    }
    await flush();
    return true;
  }

  private async send(round: string, kind: string, ixs: Instruction[], units: number) {
    const lifetime = await this.lifetime();
    const message = beaconTransactionMessage(
      this.format ?? 1,
      this.signer,
      lifetime,
      ixs,
      this.budget(units),
    );
    await this.sendMessage(round, kind, message, lifetime);
  }

  /**
   * Signs `message` on `lifetime`, records it in flight, then sends it with
   * a preflight. It leaves the record only on a definite refusal
   * (`SendRefusedError`: the RPC answered with an error, so the transaction
   * was not forwarded). Any other error (a timeout, an HTTP status, a
   * dropped connection) leaves open whether it reached a leader, so it stays
   * in flight: resent, and followed until it is confirmed, fails, or its
   * `lastValidBlockHeight` passes, and the step is never built a second time
   * meanwhile. A v1 transaction refused by the cluster rather than by the
   * program (no program error in its logs) switches the engine to plain v0
   * without a lookup table, and the next tick rebuilds the step in v0.
   */
  private async sendMessage(
    round: string,
    kind: string,
    message: ReturnType<typeof beaconTransactionMessage>,
    lifetimeIn: Lifetime,
  ) {
    let lifetime = lifetimeIn;
    for (let attempt = 0; ; attempt++) {
      const tx = await signTransactionMessageWithSigners(
        setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
      );
      const wire = getBase64EncodedWireTransaction(tx);
      const signature = getSignatureFromTransaction(tx);
      const now = this.now();
      this.sql.exec(
        "INSERT OR IGNORE INTO beacon_pending (signature, round, kind, wire, last_valid, sent_at, resent_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
        signature,
        round,
        kind,
        wire,
        lifetime.lastValidBlockHeight.toString(),
        now,
        now,
      );
      try {
        await this.chain.send(wire, false);
        this.log("info", `${kind} sent ${signature}`);
        return;
      } catch (e) {
        if (!(e instanceof SendRefusedError)) {
          this.log("warn", `${kind} ${signature}: send uncertain (${short(e)}): kept in flight`);
          return;
        }
        if (e.alreadyProcessed) {
          this.log("info", `${kind} ${signature} already processed: followed`);
          return;
        }
        this.dropPending(signature);
        if (attempt === 0 && /blockhash/i.test(`${e.message} ${e.logs.join(" ")}`)) {
          // The reused blockhash is no longer known, so that copy cannot land: signed again
          // on a fresh one, once.
          this.blockhash = null;
          lifetime = await this.lifetime();
          continue;
        }
        if (e.byFormat && message.version === 1 && this.config.format === null) {
          this.format = 0;
          this.formatSince = this.now();
          this.log(
            "warn",
            `a v1 transaction was refused at send (${e.message}): plain v0 without a lookup table for the next hour`,
          );
          throw new RetrySoon();
        }
        throw e;
      }
    }
  }

  // --- storage -------------------------------------------------------------------------------

  private prune(now: number) {
    this.sql.exec(
      "DELETE FROM beacon_tickets WHERE open = 0 AND parked = 0 AND round IN (SELECT address FROM beacon_rounds WHERE open = 0 AND updated_at < ?)",
      now - ROUND_RETENTION_MS,
    );
    this.sql.exec(
      "DELETE FROM beacon_sponsors WHERE round IN (SELECT address FROM beacon_rounds WHERE open = 0 AND updated_at < ?)",
      now - ROUND_RETENTION_MS,
    );
    this.sql.exec(
      "DELETE FROM beacon_rounds WHERE open = 0 AND updated_at < ? AND address NOT IN (SELECT round FROM beacon_alarms)",
      now - ROUND_RETENTION_MS,
    );
    // Unresolved critical alarms are kept: `pauseRecommended` must not turn off by itself.
    this.sql.exec(
      "DELETE FROM beacon_alarms WHERE at < ? AND (severity != 'critical' OR resolved_at > 0)",
      now - ALARM_RETENTION_MS,
    );
  }
}

/** A step to retry within a few hundred milliseconds, not an error: SlotHashes one slot behind, a format switch. */
class RetrySoon extends Error {
  constructor() {
    super("retry soon");
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS beacon_rounds (
    address TEXT PRIMARY KEY,
    id TEXT,
    open INTEGER NOT NULL DEFAULT 1,
    status TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_try_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at INTEGER NOT NULL,
    requested_slot TEXT,
    lookup_tries INTEGER NOT NULL DEFAULT 0,
    lookup_first_at INTEGER NOT NULL DEFAULT 0,
    lookup_next_at INTEGER NOT NULL DEFAULT 0,
    lookup_before TEXT,
    lookup_read INTEGER NOT NULL DEFAULT 0,
    lookup_gap INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS beacon_rounds_open ON beacon_rounds (open, updated_at)",
  `CREATE TABLE IF NOT EXISTS beacon_tickets (
    address TEXT PRIMARY KEY,
    round TEXT NOT NULL,
    integrator TEXT NOT NULL,
    open INTEGER NOT NULL DEFAULT 1,
    parked INTEGER NOT NULL DEFAULT 0,
    next_try_at INTEGER NOT NULL DEFAULT 0,
    tries INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS beacon_tickets_round ON beacon_tickets (round, open)",
  `CREATE TABLE IF NOT EXISTS beacon_sponsors (
    round TEXT NOT NULL,
    sponsor TEXT NOT NULL,
    PRIMARY KEY (round, sponsor)
  )`,
  `CREATE TABLE IF NOT EXISTS beacon_integrators (
    address TEXT PRIMARY KEY,
    next_try_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS beacon_pending (
    signature TEXT PRIMARY KEY,
    round TEXT NOT NULL,
    kind TEXT NOT NULL,
    wire TEXT NOT NULL,
    last_valid TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    resent_at INTEGER NOT NULL,
    confirmed_at INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS beacon_pending_round ON beacon_pending (round)",
  `CREATE TABLE IF NOT EXISTS beacon_alarms (
    round TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    detail TEXT NOT NULL,
    slot TEXT NOT NULL,
    at INTEGER NOT NULL,
    inferred INTEGER NOT NULL DEFAULT 0,
    resolved_at INTEGER NOT NULL DEFAULT 0,
    resolution TEXT,
    PRIMARY KEY (round, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS beacon_forfeits (
    round TEXT PRIMARY KEY,
    ordinal INTEGER,
    inferred INTEGER NOT NULL,
    at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS beacon_forfeits_ordinal ON beacon_forfeits (ordinal)",
  `CREATE TABLE IF NOT EXISTS beacon_vrfs (
    round TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    until INTEGER NOT NULL,
    request TEXT,
    checked_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS beacon_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

/** Columns added to tables an earlier version created: added to existing storage on start. */
const ADDED_COLUMNS: readonly [table: string, column: string, declaration: string][] = [
  ["beacon_rounds", "requested_slot", "TEXT"],
  ["beacon_rounds", "lookup_tries", "INTEGER NOT NULL DEFAULT 0"],
  ["beacon_rounds", "lookup_first_at", "INTEGER NOT NULL DEFAULT 0"],
  ["beacon_rounds", "lookup_next_at", "INTEGER NOT NULL DEFAULT 0"],
  ["beacon_pending", "confirmed_at", "INTEGER NOT NULL DEFAULT 0"],
  ["beacon_rounds", "lookup_before", "TEXT"],
  ["beacon_rounds", "lookup_read", "INTEGER NOT NULL DEFAULT 0"],
  ["beacon_rounds", "lookup_gap", "INTEGER NOT NULL DEFAULT 0"],
  ["beacon_alarms", "inferred", "INTEGER NOT NULL DEFAULT 0"],
  ["beacon_alarms", "resolved_at", "INTEGER NOT NULL DEFAULT 0"],
  ["beacon_alarms", "resolution", "TEXT"],
  ["beacon_tickets", "next_try_at", "INTEGER NOT NULL DEFAULT 0"],
  ["beacon_tickets", "tries", "INTEGER NOT NULL DEFAULT 0"],
];

/** Indexes over added columns: created once the columns exist (`migrate`). */
const INDEXES = [
  "DROP INDEX IF EXISTS beacon_tickets_parked",
  "CREATE INDEX IF NOT EXISTS beacon_tickets_parked_due ON beacon_tickets (parked, next_try_at)",
];

function migrate(sql: Sql) {
  for (const [table, column, declaration] of ADDED_COLUMNS) {
    const have = sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
    if (!have.includes(column))
      sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
  for (const q of INDEXES) sql.exec(q);
}
