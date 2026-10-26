// Fade's events, decoded: each one is an inner instruction to the program (`emit_cpi!`) whose
// data is Anchor's event tag followed by the event's discriminator and fields. Pure, so the
// keeper decodes a transaction exactly as the app does (lib/events reads them from the chain;
// the keeper's wallet history, apps/keeper/src/walletIndex.ts, records them).
import { getBase58Encoder, type Address } from "@solana/kit";
import {
  CLAIM_DELIVERED_EVENT_DISCRIMINATOR,
  DEPOSIT_CLAIMED_EVENT_DISCRIMINATOR,
  DEPOSIT_REQUESTED_EVENT_DISCRIMINATOR,
  EPOCH_STRUCK_EVENT_DISCRIMINATOR,
  RANDOMNESS_REQUESTED_EVENT_DISCRIMINATOR,
  ROUND_PAYOUT_CLAIMED_EVENT_DISCRIMINATOR,
  ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR,
  ROUND_TICKET_SETTLED_EVENT_DISCRIMINATOR,
  TICKET_EXPIRED_EVENT_DISCRIMINATOR,
  TICKET_JOINED_EVENT_DISCRIMINATOR,
  TICKET_OPENED_EVENT_DISCRIMINATOR,
  TICKET_SETTLED_EVENT_DISCRIMINATOR,
  WITHDRAW_CLAIMED_EVENT_DISCRIMINATOR,
  WITHDRAW_REQUESTED_EVENT_DISCRIMINATOR,
  getClaimDeliveredEventDecoder,
  getDepositClaimedEventDecoder,
  getDepositRequestedEventDecoder,
  getEpochStruckEventDecoder,
  getRandomnessRequestedEventDecoder,
  getRoundPayoutClaimedEventDecoder,
  getRoundTicketReturnedEventDecoder,
  getRoundTicketSettledEventDecoder,
  getTicketJoinedEventDecoder,
  getTicketOpenedEventDecoder,
  getTicketSettledEventDecoder,
  getWithdrawClaimedEventDecoder,
  getWithdrawRequestedEventDecoder,
  type ClaimDeliveredEvent,
  type DepositClaimedEvent,
  type DepositRequestedEvent,
  type EpochStruckEvent,
  type RandomnessRequestedEvent,
  type RoundPayoutClaimedEvent,
  type RoundTicketReturnedEvent,
  type RoundTicketSettledEvent,
  type TicketJoinedEvent,
  type TicketOpenedEvent,
  type TicketSettledEvent,
  type WithdrawClaimedEvent,
  type WithdrawRequestedEvent,
} from "../../../../clients/js/src/generated/fade";
import {
  decodeTicketExpired,
  type TicketExpiredRecord,
} from "../../../../clients/js/src/direct/index.ts";

/** `sha256("anchor:event")[..8]`, little end first: the tag of every `emit_cpi!`. */
const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export type FadeEvent =
  | { kind: "TicketOpened"; data: TicketOpenedEvent }
  | { kind: "RandomnessRequested"; data: RandomnessRequestedEvent }
  | { kind: "TicketSettled"; data: TicketSettledEvent }
  /** Either schema version: a version-1 body carries no findings and no refund. */
  | { kind: "TicketExpired"; data: TicketExpiredRecord }
  | { kind: "TicketJoined"; data: TicketJoinedEvent }
  | { kind: "RoundTicketSettled"; data: RoundTicketSettledEvent }
  | { kind: "RoundTicketReturned"; data: RoundTicketReturnedEvent }
  | { kind: "RoundPayoutClaimed"; data: RoundPayoutClaimedEvent }
  | { kind: "DepositRequested"; data: DepositRequestedEvent }
  | { kind: "DepositClaimed"; data: DepositClaimedEvent }
  | { kind: "WithdrawRequested"; data: WithdrawRequestedEvent }
  | { kind: "WithdrawClaimed"; data: WithdrawClaimedEvent }
  | { kind: "EpochStruck"; data: EpochStruckEvent }
  | { kind: "ClaimDelivered"; data: ClaimDeliveredEvent };

type Entry = { disc: ArrayLike<number>; decode: (b: Uint8Array) => FadeEvent };
const KNOWN: Entry[] = [
  {
    disc: TICKET_OPENED_EVENT_DISCRIMINATOR,
    decode: (b) => ({ kind: "TicketOpened", data: getTicketOpenedEventDecoder().decode(b) }),
  },
  {
    disc: RANDOMNESS_REQUESTED_EVENT_DISCRIMINATOR,
    decode: (b) => ({
      kind: "RandomnessRequested",
      data: getRandomnessRequestedEventDecoder().decode(b),
    }),
  },
  {
    disc: TICKET_SETTLED_EVENT_DISCRIMINATOR,
    decode: (b) => ({ kind: "TicketSettled", data: getTicketSettledEventDecoder().decode(b) }),
  },
  {
    disc: TICKET_EXPIRED_EVENT_DISCRIMINATOR,
    decode: (b) => ({ kind: "TicketExpired", data: decodeTicketExpired(b) }),
  },
  {
    disc: TICKET_JOINED_EVENT_DISCRIMINATOR,
    decode: (b) => ({ kind: "TicketJoined", data: getTicketJoinedEventDecoder().decode(b) }),
  },
  {
    disc: ROUND_TICKET_SETTLED_EVENT_DISCRIMINATOR,
    decode: (b) => ({
      kind: "RoundTicketSettled",
      data: getRoundTicketSettledEventDecoder().decode(b),
    }),
  },
  {
    disc: ROUND_TICKET_RETURNED_EVENT_DISCRIMINATOR,
    decode: (b) => ({
      kind: "RoundTicketReturned",
      data: getRoundTicketReturnedEventDecoder().decode(b),
    }),
  },
  {
    disc: ROUND_PAYOUT_CLAIMED_EVENT_DISCRIMINATOR,
    decode: (b) => ({
      kind: "RoundPayoutClaimed",
      data: getRoundPayoutClaimedEventDecoder().decode(b),
    }),
  },
  {
    disc: DEPOSIT_REQUESTED_EVENT_DISCRIMINATOR,
    decode: (b) => ({
      kind: "DepositRequested",
      data: getDepositRequestedEventDecoder().decode(b),
    }),
  },
  {
    disc: DEPOSIT_CLAIMED_EVENT_DISCRIMINATOR,
    decode: (b) => ({ kind: "DepositClaimed", data: getDepositClaimedEventDecoder().decode(b) }),
  },
  {
    disc: WITHDRAW_REQUESTED_EVENT_DISCRIMINATOR,
    decode: (b) => ({
      kind: "WithdrawRequested",
      data: getWithdrawRequestedEventDecoder().decode(b),
    }),
  },
  {
    disc: WITHDRAW_CLAIMED_EVENT_DISCRIMINATOR,
    decode: (b) => ({ kind: "WithdrawClaimed", data: getWithdrawClaimedEventDecoder().decode(b) }),
  },
  {
    disc: CLAIM_DELIVERED_EVENT_DISCRIMINATOR,
    decode: (b) => ({ kind: "ClaimDelivered", data: getClaimDeliveredEventDecoder().decode(b) }),
  },
  {
    disc: EPOCH_STRUCK_EVENT_DISCRIMINATOR,
    decode: (b) => ({ kind: "EpochStruck", data: getEpochStruckEventDecoder().decode(b) }),
  },
];

const startsWith = (data: Uint8Array, prefix: ArrayLike<number>, at = 0) => {
  if (data.length < at + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[at + i] !== prefix[i]) return false;
  return true;
};

/** Decodes one inner-instruction payload, or null if it is not a known Fade event. */
export function decodeEventData(data: Uint8Array): FadeEvent | null {
  if (!startsWith(data, EVENT_IX_TAG)) return null;
  const body = data.subarray(8);
  for (const k of KNOWN) {
    if (startsWith(body, k.disc)) {
      try {
        return k.decode(body);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** A transaction as `getTransaction` returns it with `encoding: "json"`. */
export type JsonTx = {
  blockTime?: bigint | number | null;
  slot?: bigint | number;
  meta: {
    err: unknown;
    innerInstructions?:
      readonly { instructions: readonly { programIdIndex: number; data: string }[] }[] | null;
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null;
  } | null;
  transaction: { message: { accountKeys: readonly string[] } };
};

/** Every account a transaction names, its address lookup tables' included. */
export const accountKeysOf = (tx: JsonTx): string[] => [
  ...tx.transaction.message.accountKeys,
  ...(tx.meta?.loadedAddresses?.writable ?? []),
  ...(tx.meta?.loadedAddresses?.readonly ?? []),
];

/** Every Fade event `program` emitted in a successful transaction, in order. */
export function programEventsOf(tx: JsonTx, program: Address): FadeEvent[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = accountKeysOf(tx);
  const out: FadeEvent[] = [];
  const b58 = getBase58Encoder();
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== program) continue;
      const e = decodeEventData(new Uint8Array(b58.encode(ix.data)));
      if (e) out.push(e);
    }
  }
  return out;
}
