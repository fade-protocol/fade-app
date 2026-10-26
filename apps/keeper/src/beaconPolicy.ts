// The pure part of the keeper's shared-beacon loop:
// its configuration, what to do with a round in each state, the automatic
// sponsor's ceiling (Spec 09 §5), the alarm's reading of an expiry (Spec 09
// §3 and §10, Spec 08 §13.5.8), the events it watches rounds from, and its
// pace. No I/O here: beaconEngine.ts reads the chain and sends, beacon.ts
// runs it in a Durable Object, and tests/ts/keeper/beaconPolicy.test.ts
// checks every rule below.
//
// Nothing here is trusted by the program: every decision is taken from
// account state read at a slot, every instruction is built by the beacon
// client from stored keys, and the program checks each again. Events only
// tell the keeper which rounds and tickets to read.
import { getBase58Encoder, isAddress, type Address, type ReadonlyUint8Array } from "@solana/kit";
import {
  ROUND_CLOSED_EVENT_DISCRIMINATOR,
  ROUND_DRAW_REQUESTED_EVENT_DISCRIMINATOR,
  ROUND_DRAWN_EVENT_DISCRIMINATOR,
  ROUND_EXPIRED_EVENT_DISCRIMINATOR,
  ROUND_OPENED_EVENT_DISCRIMINATOR,
  ROUND_PAID_EVENT_DISCRIMINATOR,
  ROUND_REFUNDED_EVENT_DISCRIMINATOR,
  ROUND_SPONSORED_EVENT_DISCRIMINATOR,
  ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR,
  ROUND_TICKET_SETTLED_EVENT_DISCRIMINATOR,
  RoundStatus,
  TICKET_JOINED_EVENT_DISCRIMINATOR,
  getRoundClosedEventDecoder,
  getRoundDrawRequestedEventDecoder,
  getRoundDrawnEventDecoder,
  getRoundExpiredEventDecoder,
  getRoundOpenedEventDecoder,
  getRoundPaidEventDecoder,
  getRoundRefundedEventDecoder,
  getRoundSponsoredEventDecoder,
  getRoundTicketReturnedEventDecoder,
  getRoundTicketSettledEventDecoder,
  getTicketJoinedEventDecoder,
  type Round,
  type RoundExpiredEvent,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  REQUEST_DELAY_SLOTS,
  closeSlot,
  inRequestWindow,
  isExpired,
  sponsorshipToCompleteDraw,
  type TransactionFormat,
} from "../../../clients/js/src/beacon/index.ts";

// --- configuration ----------------------------------------------------------------------

/** The Fade-controlled test mint the devnet builds pin. */
export const DEVNET_USDC_MINT = "E4XYMYALrvMX19P6TxqKXe8ZYGxfj2CjMub6c2ZficTv" as Address;

/** The automatic sponsor's rules (Spec 09 §5). */
export type SponsorPolicy = {
  /** Lamports one USDC (10⁶ base units) is worth to the keeper's operator: 10⁹ / P at a SOL price P. */
  lamportsPerUsdc: bigint;
  /**
   * Integrators whose app shares come back to the keeper's operator: the
   * shares of their tickets in a round count towards what it may spend on
   * that round. The protocol's shares always count.
   */
  ownIntegrators: ReadonlySet<Address>;
  /** An absolute ceiling per round, below the fees, if set. */
  maxLamports: bigint | null;
};

export type BeaconConfig = {
  /** The beacon program the keeper acts on. */
  program: Address;
  usdcMint: Address;
  /** null: the keeper never sponsors. */
  sponsor: SponsorPolicy | null;
  /**
   * Whether the keeper pushes the returns and sponsorship reclaims of a
   * refunded round, which pay nobody (Spec 08 §13.5.5): off by default, the
   * players and sponsors pull them.
   */
  pushRefunds: boolean;
  /** Shares at least this large (USDC base units) are swept by `claim_shares`; null: never. */
  sweepMinUnits: bigint | null;
  /** Forces a transaction format; null: v1 where SIMD-0385 is active, plain v0 otherwise. */
  format: TransactionFormat | null;
  /**
   * The keeper's balance floor, lamports: below it (or when a spend would
   * take it below), the loop stops every step that earns it nothing (the
   * sponsor, the share sweep, parked payouts, reclaims, pushed refunds) and
   * keeps only the requests, settlements, late bindings, expiries and the
   * returns of forfeited rounds, which pay it or are bound to a deadline.
   */
  minBalanceLamports: bigint;
  /**
   * The operator's acknowledgements (`BEACON_ACKNOWLEDGED_ALARMS`): each
   * resolves the one alarm of its round and kind, nothing else. Empty when
   * the variable is unset, or when it does not parse (`acknowledgementError`).
   */
  acknowledged: AlarmAcknowledgement[];
  /** Why `BEACON_ACKNOWLEDGED_ALARMS` was ignored, or null: shown on GET /v1/beacon. */
  acknowledgementError: string | null;
};

/** The environment variables the beacon loop reads (a subset of the Worker's `Env`). */
export type BeaconEnvVars = {
  /** "true" or "1" runs the loop on the keeper's program; anything else, or unset, leaves it off. */
  BEACON_ENABLED?: string;
  BEACON_USDC_MINT?: string;
  BEACON_SPONSOR_LAMPORTS_PER_USDC?: string;
  BEACON_SPONSOR_INTEGRATORS?: string;
  BEACON_SPONSOR_MAX_LAMPORTS?: string;
  BEACON_PUSH_REFUNDS?: string;
  BEACON_SWEEP_MIN_UNITS?: string;
  BEACON_TX_FORMAT?: string;
  BEACON_MIN_BALANCE_LAMPORTS?: string;
  /** A JSON array of `AlarmAcknowledgement`s (`parseAlarmAcknowledgements`). */
  BEACON_ACKNOWLEDGED_ALARMS?: string;
  /**
   * The beacon loop's own keypair (a 64-byte JSON array), required once the
   * loop is enabled and refused when it is the direct path's keeper key: the
   * beacon's spends can then never take the SOL the direct path settles with.
   */
  BEACON_SECRET_KEY?: string;
};

/** Shares below 0.10 USDC are left to accrue: a claim costs its sender a transaction fee. */
export const DEFAULT_SWEEP_MIN_UNITS = 100_000n;
/** 0.1 SOL: about a thousand of the loop's transactions at its priority fee. */
export const DEFAULT_MIN_BALANCE_LAMPORTS = 100_000_000n;

function positiveInteger(raw: string, name: string): bigint {
  if (!/^[0-9]{1,20}$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const v = BigInt(raw);
  if (v <= 0n || v >= 1n << 64n) throw new Error(`${name} must be a positive u64`);
  return v;
}

function addressVar(raw: string, name: string): Address {
  const v = raw.trim();
  if (!isAddress(v)) throw new Error(`${name} is not a base58 address`);
  return v;
}

/** Whether `BEACON_ENABLED` turns the beacon loop on: "true" or "1", any case. */
export function beaconEnabled(env: Pick<BeaconEnvVars, "BEACON_ENABLED">): boolean {
  const v = (env.BEACON_ENABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/**
 * The beacon loop's configuration on `program` (the keeper's own program,
 * which carries both the direct path and the beacon), or null unless
 * `BEACON_ENABLED` turns it on: the deployed keeper then runs exactly as
 * before, its beacon loop never scheduled. A value that does not parse
 * throws, so that a typo stops the loop instead of running it with a default;
 * except `BEACON_ACKNOWLEDGED_ALARMS`, which is ignored and reported instead
 * (`parseAlarmAcknowledgements`): a typo there must not stop the alarm either.
 */
export function parseBeaconConfig(env: BeaconEnvVars, program: Address): BeaconConfig | null {
  if (!beaconEnabled(env)) return null;
  const usdcMint = env.BEACON_USDC_MINT?.trim()
    ? addressVar(env.BEACON_USDC_MINT, "BEACON_USDC_MINT")
    : DEVNET_USDC_MINT;
  let sponsor: SponsorPolicy | null = null;
  const rate = env.BEACON_SPONSOR_LAMPORTS_PER_USDC?.trim();
  if (rate) {
    const own = new Set<Address>();
    for (const part of (env.BEACON_SPONSOR_INTEGRATORS ?? "").split(",")) {
      if (part.trim()) own.add(addressVar(part, "BEACON_SPONSOR_INTEGRATORS"));
    }
    const max = env.BEACON_SPONSOR_MAX_LAMPORTS?.trim();
    sponsor = {
      lamportsPerUsdc: positiveInteger(rate, "BEACON_SPONSOR_LAMPORTS_PER_USDC"),
      ownIntegrators: own,
      maxLamports: max ? positiveInteger(max, "BEACON_SPONSOR_MAX_LAMPORTS") : null,
    };
  }
  const push = env.BEACON_PUSH_REFUNDS?.trim() ?? "";
  if (push !== "" && push !== "true" && push !== "false")
    throw new Error("BEACON_PUSH_REFUNDS must be true or false");
  const sweep = env.BEACON_SWEEP_MIN_UNITS?.trim() ?? "";
  const format = env.BEACON_TX_FORMAT?.trim() ?? "";
  if (format !== "" && format !== "1" && format !== "0")
    throw new Error("BEACON_TX_FORMAT must be 1 or 0");
  const floor = env.BEACON_MIN_BALANCE_LAMPORTS?.trim() ?? "";
  const { acknowledged, error: acknowledgementError } = parseAlarmAcknowledgements(
    env.BEACON_ACKNOWLEDGED_ALARMS,
  );
  return {
    program,
    usdcMint,
    sponsor,
    pushRefunds: push === "true",
    sweepMinUnits:
      sweep === "off"
        ? null
        : sweep
          ? positiveInteger(sweep, "BEACON_SWEEP_MIN_UNITS")
          : DEFAULT_SWEEP_MIN_UNITS,
    format: format === "" ? null : format === "1" ? 1 : 0,
    minBalanceLamports: floor
      ? positiveInteger(floor, "BEACON_MIN_BALANCE_LAMPORTS")
      : DEFAULT_MIN_BALANCE_LAMPORTS,
    acknowledged,
    acknowledgementError,
  };
}

// --- the automatic sponsor -----------------------------------------------------------------

/** One ticket's part of what the sponsor may spend: its integrator and its app share. */
export type TicketShares = { integrator: Address; appShare: bigint };

/**
 * The most the keeper may sponsor `round` with (Spec 09 §5): what the
 * round's tickets pay its operator in shares, the protocol's and the app
 * shares of its own integrators, valued at `lamportsPerUsdc` and rounded
 * down, and no more than `maxLamports`. `tickets` must be every ticket of
 * the round still in it; a missing one only lowers the ceiling.
 */
export function sponsorCeiling(
  round: Pick<Round, "protocolShares">,
  tickets: readonly TicketShares[],
  policy: SponsorPolicy,
): bigint {
  let usdc = round.protocolShares;
  for (const t of tickets) if (policy.ownIntegrators.has(t.integrator)) usdc += t.appShare;
  const lamports = (usdc * policy.lamportsPerUsdc) / 1_000_000n;
  return policy.maxLamports !== null && policy.maxLamports < lamports
    ? policy.maxLamports
    : lamports;
}

/**
 * The sponsorship the keeper sends to `round`, or null. Only an
 * `Accepting` round, only the exact amount that pays it at once (so that
 * no later refund can return a top-up that bought capacity), only once
 * (`alreadySponsored`: the keeper's record for this round exists), and
 * never above `sponsorCeiling`.
 */
export function sponsorAmount(
  round: Round,
  tickets: readonly TicketShares[],
  policy: SponsorPolicy | null,
  alreadySponsored: boolean,
): bigint | null {
  if (!policy || alreadySponsored || round.status !== RoundStatus.Accepting) return null;
  const missing = sponsorshipToCompleteDraw(round);
  if (missing === 0n) return null;
  return missing <= sponsorCeiling(round, tickets, policy) ? missing : null;
}

// --- what to do with a round --------------------------------------------------------------

/** How a round's ORAO request reads, when the keeper read it. */
export type RequestState = "absent" | "pending" | "zero" | "fulfilled";

export type RoundAction =
  | { kind: "wait"; untilSlot: bigint | null }
  | { kind: "sponsor" }
  | { kind: "request" }
  | { kind: "late-bind" }
  | { kind: "settle" }
  | { kind: "expire" }
  | { kind: "return" }
  | { kind: "reclaim" }
  | { kind: "done" };

/**
 * The next step for `round` at `slot` (Spec 08 §13.5): the keeper requests
 * a paid round's draw from `close_slot + 2`, settles a requested round once
 * its request is fulfilled with a randomness and a drawn one until no
 * ticket is left, binds late (after the window) a request someone created
 * and ORAO fulfilled, expires a round whose window passed without that,
 * and returns the tickets of a forfeited round (paid by their settlement
 * share). `request` is the round's request as read: the stored one once
 * requested, ORAO's address for its seed while SlotHashes proves it for a
 * paid round past its window; "absent" otherwise.
 */
export function nextAction(
  round: Round,
  slot: bigint,
  request: RequestState,
  options: { sponsor: boolean; pushRefunds: boolean },
): RoundAction {
  switch (round.status) {
    case RoundStatus.Accepting:
      return options.sponsor ? { kind: "sponsor" } : { kind: "wait", untilSlot: null };
    case RoundStatus.Paid: {
      const opens = round.closeSlot + REQUEST_DELAY_SLOTS;
      if (inRequestWindow(slot, round.closeSlot, round.tSettleSlots)) return { kind: "request" };
      if (!isExpired(slot, round.closeSlot, round.tSettleSlots))
        return { kind: "wait", untilSlot: opens };
      return request === "fulfilled" ? { kind: "late-bind" } : { kind: "expire" };
    }
    case RoundStatus.Requested:
      if (request === "fulfilled") return { kind: "settle" };
      if (isExpired(slot, round.closeSlot, round.tSettleSlots)) return { kind: "expire" };
      return { kind: "wait", untilSlot: null };
    case RoundStatus.Drawn:
      if (round.tickets > 0) return { kind: "settle" };
      return round.sponsors > 0 ? { kind: "reclaim" } : { kind: "done" };
    case RoundStatus.Forfeited:
      if (round.tickets > 0) return { kind: "return" };
      return round.sponsors > 0 ? { kind: "reclaim" } : { kind: "done" };
    case RoundStatus.Refunded:
      if (!options.pushRefunds) return { kind: "done" };
      if (round.tickets > 0) return { kind: "return" };
      return round.sponsors > 0 ? { kind: "reclaim" } : { kind: "done" };
    default:
      return { kind: "done" };
  }
}

// --- the alarm ------------------------------------------------------------------------------

export type AlarmKind =
  /** A round nobody requested expired: the keepers failed; no pause (Spec 08 §13.10 table). */
  | "unrequested-expiry"
  /**
   * Any other expiry, or one the keeper could not read: the signature of a
   * withheld draw; the guardian pauses new tickets.
   */
  | "withheld-draw"
  /** Warning before the expiry: a paid round still unrequested well into its window. */
  | "request-late"
  /**
   * A requested round still unfulfilled after `FULFILMENT_ALARM_SLOTS`: Spec
   * 02 §3's circuit breaker, which pauses new tickets before any expiry.
   */
  | "fulfilment-late"
  /**
   * A paid or requested round past its expiry that the keeper cannot
   * expire (`EXPIRY_ALARM_FAILURES` refusals), or a requested one still
   * there `EXPIRY_ALARM_SLOTS` after it: it can neither settle nor forfeit.
   */
  | "expiry-overdue"
  /** The keeper's balance fell below its floor: the steps that earn nothing are stopped. */
  | "low-balance";

export type AlarmSeverity = "warning" | "critical";

export const ALARM_SEVERITY: Record<AlarmKind, AlarmSeverity> = {
  "unrequested-expiry": "warning",
  "withheld-draw": "critical",
  "request-late": "warning",
  "fulfilment-late": "critical",
  "expiry-overdue": "critical",
  "low-balance": "warning",
};

/** The alarms on which the guardian should pause new tickets: every critical one. */
export const pausesTickets = (kind: AlarmKind) => ALARM_SEVERITY[kind] === "critical";

/**
 * A request still unfulfilled this many slots after it landed (after its
 * entropy slot when the keeper does not know when it landed) is late: Spec 02 §3's operational threshold, 60 slots, well below the
 * 150-slot `t_settle_slots` (ORAO took 6 to 8 slots on devnet, once 89).
 * Spec 02 §3 pauses new tickets there, so the alarm is critical.
 */
export const FULFILMENT_ALARM_SLOTS = 60n;
/** A paid round still unrequested this many slots after its close: the keepers are behind. */
export const REQUEST_ALARM_SLOTS = 30n;
/** A requested round still there this many slots after its expiry is overdue. */
export const EXPIRY_ALARM_SLOTS = 60n;
/** The keeper's expiry of a round refused this many times in a row: overdue. */
export const EXPIRY_ALARM_FAILURES = 3;

/**
 * What an expiry means (Spec 08 §13.5.8): only `checked && !request_found`
 * on a round never requested is a keepers' failure. The same rule reads a
 * direct ticket's `TicketExpired` (version 2, the same three fields), which
 * the Keeper object reconciles with `Vault.ticket_forfeits_withheld`
 * (directPolicy.ts). Everything else, a
 * request pending, one fulfilled with zero, a requested round unfulfilled,
 * or an expiry too late for the program to look for a request, is treated
 * as a withheld draw and pauses new tickets (Spec 09 §10).
 */
export function classifyExpiry(
  e: Pick<RoundExpiredEvent, "requested" | "requestFound" | "checked">,
): "unrequested-expiry" | "withheld-draw" {
  return !e.requested && e.checked && !e.requestFound ? "unrequested-expiry" : "withheld-draw";
}

/**
 * The slot `fulfilment-late` counts from: the slot the round's request
 * landed (`requestedSlot`, when the keeper knows it), never before the
 * entropy slot. Spec 02 §3's breaker measures how long ORAO leaves a
 * request unfulfilled, so a request sent late in its window (a keepers'
 * failure, `request-late`) does not make ORAO late. Unknown, the entropy
 * slot: the earliest a request can land, so the alarm comes no later than
 * it should (fail closed).
 */
export function fulfilmentBase(round: Round, requestedSlot: bigint | null): bigint {
  return requestedSlot !== null && requestedSlot > round.entropySlot
    ? requestedSlot
    : round.entropySlot;
}

/**
 * The warning a round raises at `slot` before any expiry, if one; `request`
 * is its request as read (a requested round's fulfilled request is not late,
 * even when it was bound late), `requestedSlot` the slot its request landed,
 * or a lower bound of it, if the keeper knows one (`fulfilmentBase`).
 */
export function lateAlarm(
  round: Round,
  slot: bigint,
  request: RequestState,
  requestedSlot: bigint | null = null,
): "request-late" | "fulfilment-late" | null {
  if (round.status === RoundStatus.Paid && slot > round.closeSlot + REQUEST_ALARM_SLOTS)
    return "request-late";
  if (
    round.status === RoundStatus.Requested &&
    request !== "fulfilled" &&
    slot > fulfilmentBase(round, requestedSlot) + FULFILMENT_ALARM_SLOTS
  )
    return "fulfilment-late";
  return null;
}

/**
 * `expiry-overdue` for `round` at `slot`, or null: a round that should
 * have forfeited and has not. A requested round `EXPIRY_ALARM_SLOTS` past
 * its expiry, or a paid or requested round past it whose expiry the keeper
 * saw refused `expireFailures` times in a row (`EXPIRY_ALARM_FAILURES`).
 * A paid round merely left unexpired raises nothing more than its
 * `request-late`: a keeper that was down expires it when it comes back,
 * and that is the keepers' failure, not a pause (Spec 08 §13.10).
 */
export function overdueAlarm(
  round: Round,
  slot: bigint,
  expireFailures: number,
): "expiry-overdue" | null {
  if (round.status !== RoundStatus.Paid && round.status !== RoundStatus.Requested) return null;
  if (!isExpired(slot, round.closeSlot, round.tSettleSlots)) return null;
  if (expireFailures >= EXPIRY_ALARM_FAILURES) return "expiry-overdue";
  if (
    round.status === RoundStatus.Requested &&
    slot > round.closeSlot + round.tSettleSlots + EXPIRY_ALARM_SLOTS
  )
    return "expiry-overdue";
  return null;
}

// --- the operator's acknowledgements -----------------------------------------------------

/**
 * An alarm the operator has reviewed and found not to call for the pause
 * (a false positive, such as an expiry caused by the keeper's own outage).
 * It is configuration, reviewed in git and deployed: the keeper has no route
 * that writes alarms.
 */
export type AlarmAcknowledgement = { round: Address; kind: AlarmKind; reason: string };

/** The longest `reason` an acknowledgement may give: it is logged and stored with the alarm. */
export const ACKNOWLEDGEMENT_REASON_MAX = 200;

const ACKNOWLEDGEMENT_KEYS = ["kind", "reason", "round"];

/**
 * `BEACON_ACKNOWLEDGED_ALARMS` read: a JSON array of `{ round, kind, reason }`
 * objects with exactly those keys, `round` a base58 address, `kind` a round's
 * alarm kind, `reason` a non-empty string of at most
 * `ACKNOWLEDGEMENT_REASON_MAX` characters once trimmed, and no round and kind
 * twice. `low-balance` is refused: it is the keeper's, not a round's, and
 * clears by itself once the balance is back. Unset or blank: none, no error.
 * Anything else invalid ignores the whole list (nothing acknowledged) and
 * says why: a typo neither resolves an alarm nor stops the loop.
 */
export function parseAlarmAcknowledgements(raw: string | undefined): {
  acknowledged: AlarmAcknowledgement[];
  error: string | null;
} {
  const text = raw?.trim() ?? "";
  if (text === "") return { acknowledged: [], error: null };
  const refuse = (why: string) => ({
    acknowledged: [],
    error: `BEACON_ACKNOWLEDGED_ALARMS ignored: ${why}`,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("not JSON");
  }
  if (!Array.isArray(parsed)) return refuse("not a JSON array");
  const out: AlarmAcknowledgement[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of parsed.entries()) {
    const at = `entry ${i}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return refuse(`${at} is not an object`);
    const keys = Object.keys(entry).sort();
    if (
      keys.length !== ACKNOWLEDGEMENT_KEYS.length ||
      keys.some((k, j) => k !== ACKNOWLEDGEMENT_KEYS[j])
    )
      return refuse(`${at} must have exactly the keys round, kind and reason`);
    const { round, kind, reason } = entry as Record<string, unknown>;
    if (typeof round !== "string" || !isAddress(round))
      return refuse(`${at}: round is not a base58 address`);
    if (typeof kind !== "string" || !Object.hasOwn(ALARM_SEVERITY, kind))
      return refuse(`${at}: kind is not an alarm kind`);
    if (kind === "low-balance")
      return refuse(`${at}: low-balance is not a round's alarm and clears by itself`);
    if (typeof reason !== "string" || reason.trim() === "")
      return refuse(`${at}: reason must be a non-empty string`);
    if (reason.trim().length > ACKNOWLEDGEMENT_REASON_MAX)
      return refuse(`${at}: reason is longer than ${ACKNOWLEDGEMENT_REASON_MAX} characters`);
    const key = `${round} ${kind}`;
    if (seen.has(key)) return refuse(`${at} repeats round ${round} and kind ${kind}`);
    seen.add(key);
    out.push({ round, kind: kind as AlarmKind, reason: reason.trim() });
  }
  return { acknowledged: out, error: null };
}

// --- events ------------------------------------------------------------------------------

/** `sha256("anchor:event")[..8]`: the tag of every `emit_cpi!` inner instruction. */
export const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

/** A landed transaction as `getTransaction` returns it in `json` encoding. */
export type JsonTx = {
  slot?: bigint | number;
  meta: {
    err: unknown;
    innerInstructions?:
      | readonly {
          instructions: readonly {
            programIdIndex: number;
            accounts?: readonly number[];
            data: string;
          }[];
        }[]
      | null;
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null;
  } | null;
  transaction: { message: { accountKeys: readonly string[] } };
};

/** The beacon events the keeper reads, decoded. */
export type BeaconEvent =
  | { kind: "opened"; round: Address; id: bigint }
  | { kind: "joined"; round: Address; ticket: Address; integrator: Address }
  | { kind: "paid"; round: Address; closeSlot: bigint }
  | { kind: "sponsored"; round: Address; sponsor: Address }
  | { kind: "requested"; round: Address; request: Address }
  | { kind: "drawn"; round: Address }
  | { kind: "settled"; round: Address; ticket: Address; integrator: Address; parked: boolean }
  | { kind: "returned"; round: Address; ticket: Address; parked: boolean }
  | { kind: "refunded"; round: Address }
  | { kind: "expired"; round: Address; event: RoundExpiredEvent }
  | { kind: "closed"; round: Address };

const startsWith = (data: ReadonlyUint8Array, prefix: ReadonlyUint8Array) =>
  data.length >= prefix.length && prefix.every((b, i) => data[i] === b);

/** One event body (after the 8-byte tag), or null if it is not one the keeper reads. */
export function decodeBeaconEvent(body: Uint8Array): BeaconEvent | null {
  try {
    if (startsWith(body, ROUND_OPENED_EVENT_DISCRIMINATOR)) {
      const e = getRoundOpenedEventDecoder().decode(body);
      return { kind: "opened", round: e.round, id: e.id };
    }
    if (startsWith(body, TICKET_JOINED_EVENT_DISCRIMINATOR)) {
      const e = getTicketJoinedEventDecoder().decode(body);
      return { kind: "joined", round: e.round, ticket: e.ticket, integrator: e.integrator };
    }
    if (startsWith(body, ROUND_PAID_EVENT_DISCRIMINATOR)) {
      const e = getRoundPaidEventDecoder().decode(body);
      return { kind: "paid", round: e.round, closeSlot: e.closeSlot };
    }
    if (startsWith(body, ROUND_SPONSORED_EVENT_DISCRIMINATOR)) {
      const e = getRoundSponsoredEventDecoder().decode(body);
      return { kind: "sponsored", round: e.round, sponsor: e.sponsor };
    }
    if (startsWith(body, ROUND_DRAW_REQUESTED_EVENT_DISCRIMINATOR)) {
      const e = getRoundDrawRequestedEventDecoder().decode(body);
      return { kind: "requested", round: e.round, request: e.request };
    }
    if (startsWith(body, ROUND_DRAWN_EVENT_DISCRIMINATOR)) {
      const e = getRoundDrawnEventDecoder().decode(body);
      return { kind: "drawn", round: e.round };
    }
    if (startsWith(body, ROUND_TICKET_SETTLED_EVENT_DISCRIMINATOR)) {
      const e = getRoundTicketSettledEventDecoder().decode(body);
      return {
        kind: "settled",
        round: e.round,
        ticket: e.ticket,
        integrator: e.integrator,
        parked: e.pending,
      };
    }
    if (startsWith(body, ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR)) {
      const e = getRoundTicketReturnedEventDecoder().decode(body);
      return { kind: "returned", round: e.round, ticket: e.ticket, parked: e.parked };
    }
    if (startsWith(body, ROUND_REFUNDED_EVENT_DISCRIMINATOR)) {
      const e = getRoundRefundedEventDecoder().decode(body);
      return { kind: "refunded", round: e.round };
    }
    if (startsWith(body, ROUND_EXPIRED_EVENT_DISCRIMINATOR)) {
      const e = getRoundExpiredEventDecoder().decode(body);
      return { kind: "expired", round: e.round, event: e };
    }
    if (startsWith(body, ROUND_CLOSED_EVENT_DISCRIMINATOR)) {
      const e = getRoundClosedEventDecoder().decode(body);
      return { kind: "closed", round: e.round };
    }
  } catch {
    // a body too short for its discriminator's layout: not an event of this program
  }
  return null;
}

/**
 * The beacon events of a landed transaction: only an `emit_cpi!` inner
 * instruction to `program` whose first account is the program's event
 * authority counts. Only the program can sign for that PDA, so no other
 * program, and no top-level instruction, can forge one. A failed
 * transaction has none.
 */
export function beaconEventsOf(tx: JsonTx, program: Address, eventAuthority: Address) {
  const out: BeaconEvent[] = [];
  if (!tx.meta || tx.meta.err) return out;
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== program) continue;
      const first = ix.accounts?.[0];
      if (first === undefined || keys[first] !== eventAuthority) continue;
      let data: Uint8Array;
      try {
        data = new Uint8Array(getBase58Encoder().encode(ix.data));
      } catch {
        continue;
      }
      if (!startsWith(data, EVENT_IX_TAG)) continue;
      const e = decodeBeaconEvent(data.subarray(8));
      if (e) out.push(e);
    }
  }
  return out;
}

// --- pace ----------------------------------------------------------------------------------

/**
 * The slot at which an `Accepting` round that holds a ticket or a
 * sponsorship could first be requested, read at `slot`: a payment after
 * `slot` closes it at the next multiple of `tick_slots` at the earliest
 * (`closeSlot`), and its request opens `REQUEST_DELAY_SLOTS` later. A
 * payment can land in any slot, so the loop wakes there rather than at its
 * idle pace. null for any other round.
 */
export function acceptingWake(
  round: Pick<Round, "status" | "tickets" | "sponsorship" | "tickSlots">,
  slot: bigint,
): bigint | null {
  if (round.status !== RoundStatus.Accepting) return null;
  if (round.tickets === 0 && round.sponsorship === 0n) return null;
  if (round.tickSlots <= 0n) return null;
  return closeSlot(slot, round.tickSlots) + REQUEST_DELAY_SLOTS;
}

/** A slot lasts about this long (400 ms target; devnet runs a little slower). */
export const SLOT_MS = 400;
/** Tick period while a round is about to close, requested or being settled. */
export const BEACON_ACTIVE_MS = 500;
/**
 * Tick period with nothing to wait for while a wake is recent
 * (`BEACON_WAKE_HOLD_MS`): the app said it joined a round, which the next
 * reads may not serve yet (an RPC can confirm a transaction before it lists
 * it), so the loop looks again every 5 s until it has it on record.
 */
export const BEACON_IDLE_MS = 5_000;
/** How long after a wake (POST /v1/beacon/wake) the loop keeps `BEACON_IDLE_MS`. */
export const BEACON_WAKE_HOLD_MS = 60_000;
/**
 * Tick period with nothing to wait for and no recent wake: no round on
 * record that holds a ticket or a sponsorship, nothing in flight.
 *
 * Derivation (Config defaults: `tick_slots` 37, `t_settle_slots` 150,
 * `REQUEST_DELAY_SLOTS` 2; 400 ms slots, the fastest the cluster runs, so
 * that a time reads as the most slots). What the loop can miss while it
 * sleeps is a join it was not told about (the app wakes it; a third-party
 * integrator need not) that pays its round at once: the round then closes at
 * the next multiple of `tick_slots`, as early as one slot later, its request
 * window is `close_slot + 2 ..= close_slot + 150`, and past it anyone may
 * expire the round (its tickets forfeit: each payer gets back its prepay
 * less its charge, the price is lost as on a losing draw). Seen at the
 * latest one quiet period plus a tick after the payment, the round is
 * requested two transactions later (`record_round_entropy`, then
 * `request_round_draw`, each sent and confirmed in about 3 s), so its request
 * lands by `close_slot + 50 + 3 + 15 = close_slot + 68` slots in the worst
 * case: 82 slots before the expiry, more than Spec 02 §3's 60-slot ORAO
 * margin (`FULFILMENT_ALARM_SLOTS`; ORAO took 6 to 8 slots on devnet, once
 * 89), and far inside the ~512 slots SlotHashes keeps the entropy slot. The
 * 1,715-slot refund window binds no keeper step, and an expiry, a
 * settlement, a return or a reclaim done late changes no outcome (none has
 * a deadline once the draw is fulfilled or forfeited). 20 s is the longest
 * period that keeps that margin; 60 s (150 slots) would not.
 *
 * Such a round still raises `request-late` (`close_slot + 30`) in that worst
 * case, a warning: the keepers were slow, no ticket is at risk.
 */
export const BEACON_QUIET_MS = 20_000;

/**
 * The period of a tick with nothing to wait for, at `now`: `BEACON_IDLE_MS`
 * for `BEACON_WAKE_HOLD_MS` after the last wake (`wokenAt`, ms; 0 for
 * none), `BEACON_QUIET_MS` otherwise.
 */
export function idleTickMs(now: number, wokenAt: number): number {
  return wokenAt > 0 && now - wokenAt < BEACON_WAKE_HOLD_MS ? BEACON_IDLE_MS : BEACON_QUIET_MS;
}

/**
 * When the next tick is due: soon while any round needs work or waits on
 * ORAO, the slot before the earliest slot a round waits for (a paid round's
 * `close_slot + 2`, an accepting round's `acceptingWake`), `idleMs`
 * (`idleTickMs`) otherwise. `waits` are the slots rounds wait for; `busy` is
 * whether any round has work now or a transaction in flight.
 */
export function nextTickMs(
  slot: bigint,
  waits: readonly bigint[],
  busy: boolean,
  idleMs: number = BEACON_QUIET_MS,
): number {
  if (busy) return BEACON_ACTIVE_MS;
  let best = idleMs;
  for (const w of waits) {
    const ahead = w > slot ? Number(w - slot) * SLOT_MS : 0;
    best = Math.min(best, Math.max(BEACON_ACTIVE_MS, ahead - SLOT_MS));
  }
  return best;
}

/** A wake never starts a tick sooner than this after the last one started (`wakeAlarmAt`). */
export const WAKE_MIN_GAP_MS = 2_000;

/**
 * Where a wake at `now` sets the alarm, or null to leave it (set for
 * `alarmAt`, null for none): at `now`, or `WAKE_MIN_GAP_MS` after the last
 * tick started (`lastTickAt`, ms; 0 for none known), unless the alarm is
 * already due by then (within `BEACON_ACTIVE_MS`). A wake asks for one tick
 * soon, never more, so a burst of wakes, however many, ticks the loop at
 * most every `WAKE_MIN_GAP_MS`.
 */
export function wakeAlarmAt(
  now: number,
  alarmAt: number | null,
  lastTickAt: number,
): number | null {
  const at = Math.max(now, lastTickAt + WAKE_MIN_GAP_MS);
  return alarmAt === null || alarmAt > at + BEACON_ACTIVE_MS ? at : null;
}

/**
 * Runs one tick with a deadline, never two at once. `state.running` holds the
 * tick in progress: while it runs (abandoned or not) no other starts, so a
 * tick that outlives its alarm cannot send what the next one sends. Resolves to
 * the delay before the next tick; rejects when the tick fails, when it is still
 * running at `deadlineMs`, or when the previous one is.
 */
export async function guardedTick(
  state: { running: Promise<number> | null },
  tick: () => Promise<number>,
  deadlineMs: number,
): Promise<number> {
  if (state.running) throw new Error("the previous tick, abandoned, is still running");
  const run = tick();
  state.running = run;
  void run.then(
    () => (state.running = null),
    () => (state.running = null),
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`tick still running after ${deadlineMs / 1000} s`)),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
