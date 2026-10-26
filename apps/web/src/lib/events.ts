// Fade's events read from the chain: a transaction's events (decoded by lib/fadeEvents, which
// the keeper shares) and the program's recent transactions.
import type { Signature } from "@solana/kit";
import { getJsonTransaction } from "../../../../clients/js/src/transactionFetch.ts";
import { PROGRAM } from "./config";
import { programEventsOf, type FadeEvent, type JsonTx } from "./fadeEvents";
import { rpc, sleep } from "./rpc";
import { eventsFor, type TxEvents } from "./txCache";

export { decodeEventData, type FadeEvent } from "./fadeEvents";

/** Every Fade event in a transaction fetched with `encoding: "json"`. */
export const eventsOf = (tx: JsonTx): FadeEvent[] => programEventsOf(tx, PROGRAM);

/** A transaction as JSON, whatever its version; null while the RPC does not serve it. */
export function fetchJsonTx(signature: Signature): Promise<JsonTx | null> {
  return getJsonTransaction<JsonTx>(rpc, signature, "confirmed");
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
