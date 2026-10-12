/// <reference lib="dom" />
// The decoded events of Fade's transactions, read once per browser. A confirmed transaction never
// changes, so its events are kept in memory and in IndexedDB: a visitor who comes back reads only
// the transactions that are new since the last visit. Missing ones are fetched in JSON-RPC
// batches of 20 (the keeper's proxy limit), not one request each.
//
// IndexedDB may be missing or refuse (a private window, cleared site data): the memory cache then
// does the job for the session.
import type { Signature } from "@solana/kit";
import { PROGRAM, RPC_URL } from "./config";
import { sleep } from "./rpc";

/** One transaction's Fade events (the decoder's own shape). */
export type TxEvents<E> = { events: E[] };

/** Bump when the decoders change, so older entries are not read back. */
const VERSION = 1;
const DB = `fade-tx-${PROGRAM}`;
const STORE = "events";
const BATCH = 20;

// --- serialization: events hold bigints and byte arrays ---------------------------------
function stringify(v: unknown): string {
  return JSON.stringify(v, function (this: Record<string, unknown>, k: string, val: unknown) {
    const raw = this[k];
    if (typeof raw === "bigint") return { $n: raw.toString() };
    if (raw instanceof Uint8Array) return { $u: Array.from(raw) };
    return val;
  });
}
function parse<T>(s: string): T {
  return JSON.parse(s, (_k, v: unknown) => {
    if (v && typeof v === "object" && "$n" in v) return BigInt((v as { $n: string }).$n);
    if (v && typeof v === "object" && "$u" in v) return new Uint8Array((v as { $u: number[] }).$u);
    return v;
  }) as T;
}

// --- IndexedDB, best effort ------------------------------------------------------------------
let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (d.objectStoreNames.contains(STORE)) d.deleteObjectStore(STORE);
        d.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

async function idbGet(keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const d = await db();
  if (!d || keys.length === 0) return out;
  try {
    await new Promise<void>((resolve) => {
      const tx = d.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      for (const k of keys) {
        const r = store.get(k);
        r.onsuccess = () => {
          if (typeof r.result === "string") out.set(k, r.result);
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // unreadable: fetched again
  }
  return out;
}

async function idbPut(entries: [string, string][]): Promise<void> {
  const d = await db();
  if (!d || entries.length === 0) return;
  try {
    const tx = d.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const [k, v] of entries) store.put(v, k);
  } catch {
    // full or refused: the memory cache still holds them
  }
}

// --- batched getTransaction ------------------------------------------------------------------
type RpcReply = { id: number; result?: unknown; error?: unknown };

/**
 * `getTransaction` for each signature, `encoding: "json"`, in batches. A missing entry means an
 * error (read again later); null means the RPC does not have the transaction yet.
 */
export async function fetchJsonTxBatch(sigs: Signature[]): Promise<Map<Signature, unknown>> {
  const out = new Map<Signature, unknown>();
  for (let i = 0; i < sigs.length; i += BATCH) {
    const chunk = sigs.slice(i, i + BATCH);
    const body = chunk.map((s, id) => ({
      jsonrpc: "2.0",
      id,
      method: "getTransaction",
      params: [s, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }],
    }));
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (res && res.ok) {
        const replies = (await res.json().catch(() => [])) as RpcReply[];
        for (const r of Array.isArray(replies) ? replies : []) {
          const sig = chunk[r.id];
          if (sig && r.error === undefined) out.set(sig, r.result ?? null);
        }
        break;
      }
      // 429 or a server error: back off, then the same batch again
      if (res && res.status !== 429 && res.status < 500) break;
      await sleep(Math.min(800 * 2 ** attempt, 8_000));
    }
  }
  return out;
}

// --- the cache --------------------------------------------------------------------------------
const memory = new Map<string, TxEvents<unknown>>();

/**
 * The events of each signature: memory, then IndexedDB, then the RPC in batches. `decode` turns a
 * fetched transaction into its events. Signatures the RPC cannot return yet are left out, to be
 * read again on the next call.
 */
export async function eventsFor<E>(
  sigs: Signature[],
  decode: (tx: unknown) => TxEvents<E>,
): Promise<Map<Signature, TxEvents<E>>> {
  const out = new Map<Signature, TxEvents<E>>();
  let todo = sigs.filter((s) => {
    const m = memory.get(s) as TxEvents<E> | undefined;
    if (m) out.set(s, m);
    return !m;
  });
  if (todo.length) {
    const stored = await idbGet(todo);
    for (const [s, v] of stored) {
      const e = parse<TxEvents<E>>(v);
      memory.set(s, e);
      out.set(s as Signature, e);
    }
    todo = todo.filter((s) => !stored.has(s));
  }
  if (todo.length) {
    const fetched = await fetchJsonTxBatch(todo);
    const save: [string, string][] = [];
    for (const [s, tx] of fetched) {
      if (!tx) continue; // listed, not indexed yet
      const e = decode(tx);
      memory.set(s, e);
      out.set(s, e);
      save.push([s, stringify(e)]);
    }
    void idbPut(save);
  }
  return out;
}
