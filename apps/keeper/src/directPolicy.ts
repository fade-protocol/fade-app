// The direct path's decisions, pure so that they are tested without a Durable Object
// (tests/ts/keeper/directPolicy.test.ts): what the keeper sends for a ticket it read, and
// whether the vault's count of direct expiries a withheld draw may explain is accounted for.
//
// In the window, the keeper sends `record_ticket_entropy` alone ahead of each request while the
// seed is not recorded, so that a request refused or failing never leaves the ticket's end to
// SlotHashes' retention.
//
// The program's rules (audit fixes of 22 October 2026): an Open ticket past `T_SETTLE` is
// expired only with its seed recorded and the request address derived from it named; a
// request someone created there that ORAO fulfilled is bound late and settled instead; a
// ticket whose seed was never recorded and whose entropy slot SlotHashes no longer proves is
// refunded its vault credit. A Requested ticket past `T_SETTLE` is expired from the state the
// keeper read, never by watching ORAO's in-flight answers: once ORAO is later than the
// deadline, whoever orders the slot of its fulfil chooses the end, and the expiry is counted.
import type { Address } from "@solana/kit";
import {
  TicketStatus,
  findVrfPayerPda,
  type Ticket,
} from "../../../clients/js/src/generated/fade/index.ts";
import { firstSlotAfter, firstSlotAfterRetained } from "../../../clients/js/src/beacon/index.ts";
import type { AccountRead, Held } from "../../../clients/js/src/beacon/index.ts";
import {
  oraoFulfilledNonZero,
  oraoRefundsTo,
  openTicketExpiry,
  ticketEntropyRecorded,
  ticketRequestAddress,
  type TicketExpiredRecord,
} from "../../../clients/js/src/direct/index.ts";
import { ACKNOWLEDGEMENT_REASON_MAX, classifyExpiry } from "./beaconPolicy.ts";

/** What the keeper sends next for a ticket it read. */
export type DirectStep =
  /** Nothing yet: before `open_slot + 2`, `s*` not in SlotHashes yet, or a request pending. */
  | { kind: "wait" }
  /**
   * `request_randomness` in the window: funds the request, records the seed. `record`: the seed
   * is not recorded yet, so `record_ticket_entropy` is sent alone first, on its own transaction,
   * so that a request refused or failing still leaves the seed recorded.
   */
  | { kind: "request"; request: Address; record: boolean }
  /** `settle_ticket` on the bound request, fulfilled. */
  | { kind: "settle"; request: Address }
  /** A request created through ORAO at the seed and fulfilled, after the window: late bind and settle. */
  | { kind: "bind"; request: Address }
  /** `expire_ticket`, with `record_ticket_entropy` first when the seed is not recorded yet. */
  | { kind: "expire"; request: Address; record: boolean; pending: boolean }
  /** `refund_expired_ticket`: the seed was never recorded and is no longer proven. */
  | { kind: "refund" };

/**
 * The program a ticket's seed is derived for: its seed hashes the program id, so the keeper
 * passes the deployment it serves, never the generated client's default address.
 */
export type DirectConfig = { programAddress: Address };

/**
 * The derived request address an Open ticket past its expiry needs read before `directStep`
 * can choose its end, or null (a requested ticket's is its bound one; a ticket in its window,
 * or whose seed is lost, needs none).
 */
export async function expiryRequestToRead(
  ticket: Held<Ticket>,
  slot: bigint,
  slotHashes: Uint8Array | null,
  config: DirectConfig,
): Promise<Address | null> {
  const t = ticket.data;
  if (t.status !== TicketStatus.Open || slot <= t.expirySlot || !slotHashes) return null;
  return (await ticketRequestAddress(ticket, slotHashes, config))?.request ?? null;
}

/**
 * The next step for `ticket` at `slot`. `slotHashes` is the sysvar as read with it (needed for
 * an Open ticket), `request` the account at the request it names (the bound one when
 * Requested; the derived one, from `expiryRequestToRead`, for an Open ticket past its expiry),
 * null for none. `config` names the program the seed is derived for.
 */
export async function directStep(
  ticket: Held<Ticket>,
  slot: bigint,
  slotHashes: Uint8Array | null,
  request: AccountRead | null,
  config: DirectConfig,
): Promise<DirectStep> {
  const t = ticket.data;
  if (t.status === TicketStatus.Requested) {
    if (oraoFulfilledNonZero(request)) return { kind: "settle", request: t.randomness };
    if (slot <= t.expirySlot) return { kind: "wait" };
    // Pending as the program's `TicketExpired.pending` judges it: ORAO's rent refund reaches
    // `vrf_payer` when it fulfils, after the close, only for a pending `RandomnessV2` that
    // `vrf_payer` paid for (a legacy request refunds nothing, someone else's refunds them).
    const [vrfPayer] = await findVrfPayerPda({ ticket: ticket.address }, config);
    const pending = oraoRefundsTo(request, vrfPayer);
    return { kind: "expire", request: t.randomness, record: false, pending };
  }
  if (t.status !== TicketStatus.Open || !slotHashes) return { kind: "wait" };
  if (slot > t.expirySlot) {
    if (!firstSlotAfter(slotHashes, t.openSlot)) return { kind: "wait" };
    const end = await openTicketExpiry(ticket, slotHashes, request, config);
    if (end.kind === "refund") return end;
    if (end.kind === "bind") return { kind: "bind", request: end.request };
    return { kind: "expire", request: end.request, record: end.record, pending: false };
  }
  if (slot < t.openSlot + 2n || !firstSlotAfterRetained(slotHashes, t.openSlot))
    return { kind: "wait" };
  const found = await ticketRequestAddress(ticket, slotHashes, config);
  return found
    ? { kind: "request", request: found.request, record: !ticketEntropyRecorded(t) }
    : { kind: "wait" };
}

/**
 * The direct expiries `Vault.ticket_forfeits_withheld` counts that no expiry the keeper read
 * accounts for: `counted` is the vault's counter, `ordinals` the `ticket_forfeits_withheld` of
 * every version-2 `TicketExpired` read that counts as withheld. Null `counted` (the vault
 * unreadable) fails closed: every expiry is taken as unaccounted for.
 */
export function unaccountedDirectWithheld(
  counted: bigint | null,
  ordinals: Iterable<bigint>,
): bigint | null {
  if (counted === null) return null;
  const seen = new Set<bigint>();
  for (const o of ordinals) if (o >= 1n && o <= counted) seen.add(o);
  return counted - BigInt(seen.size);
}

/**
 * The ordinal a version-2 expiry carries when it counts as withheld, else null: the beacon's
 * rule (`classifyExpiry`), every expiry but the keepers' failure (`checked && !request_found`
 * on a ticket never requested).
 */
export function withheldOrdinal(e: TicketExpiredRecord): bigint | null {
  if (e.version !== 2) return null;
  return classifyExpiry(e) === "withheld-draw" ? e.ticketForfeitsWithheld : null;
}

// --- the direct withheld alarm -----------------------------------------------------------

/**
 * A direct expiry the operator has reviewed and found not to call for the pause (a false
 * positive, such as a refund caused by the keeper's own outage or the upgrade window), named by
 * its `Vault.ticket_forfeits_withheld` ordinal. Configuration, reviewed in git and deployed
 * (`DIRECT_ACKNOWLEDGED_WITHHELD`), as the beacon's `BEACON_ACKNOWLEDGED_ALARMS`: the keeper has
 * no route that writes alarms.
 */
export type WithheldAcknowledgement = { ordinal: bigint; reason: string };

const DIRECT_ACK_KEYS = ["ordinal", "reason"];

/**
 * `DIRECT_ACKNOWLEDGED_WITHHELD` read: a JSON array of `{ ordinal, reason }` objects with exactly
 * those keys, `ordinal` a positive integer (a number or a decimal string), `reason` a non-empty
 * string of at most `ACKNOWLEDGEMENT_REASON_MAX` characters once trimmed, and no ordinal twice.
 * Unset or blank: none, no error. Anything else invalid ignores the whole list (nothing
 * acknowledged) and says why: a typo neither silences the alarm nor stops the loop.
 */
export function parseWithheldAcknowledgements(raw: string | undefined): {
  acknowledged: WithheldAcknowledgement[];
  error: string | null;
} {
  const text = raw?.trim() ?? "";
  if (text === "") return { acknowledged: [], error: null };
  const refuse = (why: string) => ({
    acknowledged: [],
    error: `DIRECT_ACKNOWLEDGED_WITHHELD ignored: ${why}`,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("not JSON");
  }
  if (!Array.isArray(parsed)) return refuse("not a JSON array");
  const out: WithheldAcknowledgement[] = [];
  const seen = new Set<bigint>();
  for (const [i, entry] of parsed.entries()) {
    const at = `entry ${i}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return refuse(`${at} is not an object`);
    const keys = Object.keys(entry).sort();
    if (keys.length !== DIRECT_ACK_KEYS.length || keys.some((k, j) => k !== DIRECT_ACK_KEYS[j]))
      return refuse(`${at} must have exactly the keys ordinal and reason`);
    const { ordinal, reason } = entry as Record<string, unknown>;
    const digits =
      typeof ordinal === "number" && Number.isSafeInteger(ordinal)
        ? String(ordinal)
        : typeof ordinal === "string"
          ? ordinal.trim()
          : "";
    if (!/^[0-9]{1,20}$/.test(digits) || BigInt(digits) < 1n || BigInt(digits) >= 1n << 64n)
      return refuse(`${at}: ordinal is not a positive integer`);
    if (typeof reason !== "string" || reason.trim() === "")
      return refuse(`${at}: reason must be a non-empty string`);
    if (reason.trim().length > ACKNOWLEDGEMENT_REASON_MAX)
      return refuse(`${at}: reason is longer than ${ACKNOWLEDGEMENT_REASON_MAX} characters`);
    const o = BigInt(digits);
    if (seen.has(o)) return refuse(`${at} repeats ordinal ${o}`);
    seen.add(o);
    out.push({ ordinal: o, reason: reason.trim() });
  }
  return { acknowledged: out, error: null };
}

/** A withheld direct expiry the keeper read: its ordinal, its ticket, whether it was a refund. */
export type WithheldRead = { ordinal: bigint; ticket: string; refunded: boolean };

/** The direct path's alarm, as /v1/health shows it. */
export type DirectAlarm = {
  /** `Vault.ticket_forfeits_withheld` at the last sweep; null: the vault unreadable. */
  counted: string | null;
  /** The ordinals counted that no expiry read accounts for; null when the vault is unreadable. */
  unaccounted: string | null;
  /**
   * Every counted ordinal the operator has not acknowledged, oldest first (at most
   * `DIRECT_ALARMS_LISTED`): its ticket and kind when its expiry was read, null otherwise.
   * Never pruned and never cleared by time: only an acknowledgement resolves one.
   */
  unresolved: { ordinal: string; ticket: string | null; refunded: boolean | null }[];
  /** How many counted ordinals are unresolved, whatever the listing shows. */
  unresolvedCount: string | null;
  /** The acknowledged ordinals that the vault counts, with their reasons. */
  acknowledged: { ordinal: string; ticket: string | null; reason: string }[];
  /** Why `DIRECT_ACKNOWLEDGED_WITHHELD` was ignored, or null. */
  acknowledgementError: string | null;
  /**
   * The guardian should pause new tickets (Spec 02 §7): a counted direct expiry a withheld draw
   * may explain is unresolved, or the vault's counter cannot be read (fail closed).
   */
  pauseRecommended: boolean;
};

/** Unresolved ordinals listed at most: the pause counts every one. */
export const DIRECT_ALARMS_LISTED = 50;

/**
 * The direct alarm from the vault's counter, the withheld expiries read and the operator's
 * acknowledgements. Every ordinal from 1 to `counted` is an expiry a withheld draw may explain
 * (`withheld_forfeit`), so each is critical until acknowledged, read or not; an ordinal read but
 * above `counted` (a counter read before the expiry landed) waits for the next read.
 */
export function directAlarm(
  counted: bigint | null,
  read: readonly WithheldRead[],
  acknowledgements: readonly WithheldAcknowledgement[],
  acknowledgementError: string | null = null,
): DirectAlarm {
  const byOrdinal = new Map<bigint, WithheldRead>(read.map((r) => [r.ordinal, r]));
  const unaccounted = unaccountedDirectWithheld(
    counted,
    read.map((r) => r.ordinal),
  );
  if (counted === null)
    return {
      counted: null,
      unaccounted: null,
      unresolved: [],
      unresolvedCount: null,
      acknowledged: [],
      acknowledgementError,
      pauseRecommended: true,
    };
  const acks = new Map(acknowledgements.map((a) => [a.ordinal, a.reason]));
  const acknowledged = [...acks.entries()]
    .filter(([o]) => o >= 1n && o <= counted)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([o, reason]) => ({
      ordinal: o.toString(),
      ticket: byOrdinal.get(o)?.ticket ?? null,
      reason,
    }));
  const unresolvedCount = counted - BigInt(acknowledged.length);
  const unresolved: DirectAlarm["unresolved"] = [];
  for (let o = 1n; o <= counted && unresolved.length < DIRECT_ALARMS_LISTED; o++) {
    if (acks.has(o)) continue;
    const r = byOrdinal.get(o);
    unresolved.push({
      ordinal: o.toString(),
      ticket: r?.ticket ?? null,
      refunded: r?.refunded ?? null,
    });
  }
  return {
    counted: counted.toString(),
    unaccounted: unaccounted === null ? null : unaccounted.toString(),
    unresolved,
    unresolvedCount: unresolvedCount.toString(),
    acknowledged,
    acknowledgementError,
    pauseRecommended: unresolvedCount > 0n,
  };
}

/**
 * The pause recommendation both health routes show: the direct path's alarm or the beacon's
 * (null while the beacon is off: then the direct path's alone).
 */
export const combinedPause = (direct: boolean, beacon: boolean | null): boolean =>
  direct || beacon === true;

/**
 * The beacon's side of `combinedPause` from its status: null only while it is off (no
 * `BEACON_ENABLED`). A beacon meant to run that cannot be read (a configuration it refused, a
 * start or a health read that threw, or a status call that threw: `undefined`) fails closed, as
 * the direct side does: its persisted alarms must not drop out of the flag the guardian reads.
 */
export const beaconPauseOf = (
  s: { enabled: true; pauseRecommended: boolean } | { enabled: false; error?: string } | undefined,
): boolean | null =>
  s === undefined ? true : s.enabled ? s.pauseRecommended : s.error !== undefined ? true : null;
