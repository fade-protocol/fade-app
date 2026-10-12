// Fade emits its events through a self-CPI (`emit_cpi!`): each one is an inner
// instruction to the program whose data is Anchor's event tag followed by the
// event's discriminator and fields. This decodes them from fetched transactions.
import { getBase58Encoder, type Address, type Signature } from "@solana/kit";
import {
  CLAIM_DELIVERED_EVENT_DISCRIMINATOR,
  DEPOSIT_CLAIMED_EVENT_DISCRIMINATOR,
  DEPOSIT_REQUESTED_EVENT_DISCRIMINATOR,
  EPOCH_STRUCK_EVENT_DISCRIMINATOR,
  RANDOMNESS_REQUESTED_EVENT_DISCRIMINATOR,
  TICKET_EXPIRED_EVENT_DISCRIMINATOR,
  TICKET_OPENED_EVENT_DISCRIMINATOR,
  TICKET_SETTLED_EVENT_DISCRIMINATOR,
  WITHDRAW_CLAIMED_EVENT_DISCRIMINATOR,
  WITHDRAW_REQUESTED_EVENT_DISCRIMINATOR,
  getClaimDeliveredEventDecoder,
  getDepositClaimedEventDecoder,
  getDepositRequestedEventDecoder,
  getEpochStruckEventDecoder,
  getRandomnessRequestedEventDecoder,
  getTicketExpiredEventDecoder,
  getTicketOpenedEventDecoder,
  getTicketSettledEventDecoder,
  getWithdrawClaimedEventDecoder,
  getWithdrawRequestedEventDecoder,
  type ClaimDeliveredEvent,
  type DepositClaimedEvent,
  type DepositRequestedEvent,
  type EpochStruckEvent,
  type RandomnessRequestedEvent,
  type TicketExpiredEvent,
  type TicketOpenedEvent,
  type TicketSettledEvent,
  type WithdrawClaimedEvent,
  type WithdrawRequestedEvent,
} from "../../../../clients/js/src/generated/fade";
import { PROGRAM } from "./config";
import { rpc, sleep } from "./rpc";
import { eventsFor, type TxEvents } from "./txCache";

/** `sha256("anchor:event")[..8]`, little end first: the tag of every `emit_cpi!`. */
const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export type FadeEvent =
  | { kind: "TicketOpened"; data: TicketOpenedEvent }
  | { kind: "RandomnessRequested"; data: RandomnessRequestedEvent }
  | { kind: "TicketSettled"; data: TicketSettledEvent }
  | { kind: "TicketExpired"; data: TicketExpiredEvent }
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
    decode: (b) => ({ kind: "TicketExpired", data: getTicketExpiredEventDecoder().decode(b) }),
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

type JsonTx = {
  blockTime?: bigint | number | null;
  slot: bigint | number;
  meta: {
    err: unknown;
    innerInstructions?:
      readonly { instructions: readonly { programIdIndex: number; data: string }[] }[] | null;
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null;
  } | null;
  transaction: { message: { accountKeys: readonly string[] } };
};

/** Every Fade event in a transaction fetched with `encoding: "json"`. */
const accountKeys = (tx: JsonTx): string[] => [
  ...tx.transaction.message.accountKeys,
  ...(tx.meta?.loadedAddresses?.writable ?? []),
  ...(tx.meta?.loadedAddresses?.readonly ?? []),
];

export function eventsOf(tx: JsonTx): FadeEvent[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = accountKeys(tx);
  const out: FadeEvent[] = [];
  const b58 = getBase58Encoder();
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== PROGRAM) continue;
      const e = decodeEventData(new Uint8Array(b58.encode(ix.data)));
      if (e) out.push(e);
    }
  }
  return out;
}

export async function fetchJsonTx(signature: Signature): Promise<JsonTx | null> {
  const t = await rpc
    .getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
      encoding: "json",
    })
    .send();
  return (t as unknown as JsonTx | null) ?? null;
}

/** The events of a transaction just confirmed; the RPC may need a moment to index it. */
export async function eventsOfSignature(signature: Signature): Promise<FadeEvent[]> {
  for (let i = 0; i < 10; i++) {
    const tx = await fetchJsonTx(signature).catch(() => null);
    if (tx) return eventsOf(tx);
    await sleep(1_000);
  }
  return [];
}

export type FeedItem = {
  signature: Signature;
  blockTime: number | null;
  slot: bigint;
  events: FadeEvent[];
};

/**
 * The decoder every cached transaction goes through: its Fade events. One decoder for the feed
 * and the liquidity provider history, so a transaction read for one serves the other.
 */
export async function txDecoder(): Promise<(tx: unknown) => TxEvents<FadeEvent>> {
  return (tx) => ({ events: eventsOf(tx as JsonTx) });
}

/**
 * The program's recent transactions with their decoded events. Reads only the transactions this
 * browser has not seen (txCache: memory, then IndexedDB, then the RPC in batches).
 */
export async function fetchFeed(limit = 40): Promise<FeedItem[]> {
  const sigs = (
    await rpc.getSignaturesForAddress(PROGRAM, { limit, commitment: "confirmed" }).send()
  ).filter((s) => s.err === null);
  const known = await eventsFor(
    sigs.map((s) => s.signature),
    await txDecoder(),
  );
  return sigs.flatMap((s) => {
    const e = known.get(s.signature);
    return e && e.events.length > 0
      ? [
          {
            signature: s.signature,
            blockTime: s.blockTime === null ? null : Number(s.blockTime),
            slot: s.slot,
            events: e.events,
          },
        ]
      : [];
  });
}
