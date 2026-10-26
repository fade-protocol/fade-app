// What the beacon loop needs from a cluster, as one narrow interface: the
// Durable Object and the local node harness implement it over a JSON-RPC
// endpoint (`rpcChain`), the tests over litesvm. Nothing here signs: the
// engine signs and hands over the wire transaction.
import {
  type KeyPairSigner,
  getBase58Decoder,
  isSolanaError,
  getBase64Encoder,
  type Address,
  type Base58EncodedBytes,
  type Blockhash,
  type Signature,
} from "@solana/kit";
import {
  transactionFormatFor,
  type AccountRead,
  type TransactionFormat,
} from "../../../clients/js/src/beacon/index.ts";
import { getTransactionAnyVersion } from "../../../clients/js/src/transactionFetch.ts";
import type { JsonTx } from "./beaconPolicy.ts";
import { signerFromSecret } from "./chain.ts";

/**
 * A transaction the RPC answered with a JSON-RPC error for: refused before
 * it was forwarded (a preflight that failed, a version it does not take, a
 * size, a blockhash it does not know). Anything else a send can throw (a
 * timeout, an HTTP status, a dropped connection) says nothing about whether
 * the transaction reached a leader: the engine keeps such a transaction in
 * flight (`BeaconEngine` `sendMessage`).
 */
export class SendRefusedError extends Error {
  /** Program logs, if the refusal came from a preflight simulation that ran. */
  readonly logs: readonly string[];
  constructor(message: string, logs: readonly string[]) {
    super(message);
    this.name = "SendRefusedError";
    this.logs = logs;
  }
  /**
   * Refused for its format, by a cluster that does not take version 1
   * transactions or their size: no preflight ran (no logs) and the error
   * names the version, the size or the encoding. A stale blockhash, a
   * balance too low or any program error is not.
   */
  get byFormat(): boolean {
    return (
      this.logs.length === 0 &&
      /version|too large|deserializ|decode|unsupported|invalid transaction/i.test(this.message)
    );
  }
  /** The preflight found the transaction already processed: it landed, it is not refused. */
  get alreadyProcessed(): boolean {
    return /already (been )?processed|AlreadyProcessed/i.test(
      `${this.message} ${this.logs.join(" ")}`,
    );
  }
}

/**
 * The JSON-RPC error codes after which `sendTransaction` certainly did not
 * forward the transaction: parse, request, method and parameter errors, a
 * failed preflight (-32002, with its logs, a blockhash not found among
 * them), a signature that does not verify (-32003), a node that refuses
 * while unhealthy (-32005), a signature length or a version it does not
 * take. -32603 (internal) and any code not listed
 * are not: a proxy can answer one after forwarding.
 */
const REFUSED_CODES: ReadonlySet<number> = new Set([
  -32700, -32600, -32601, -32602, -32002, -32003, -32005, -32013, -32015,
]);

/** Whether `e`, thrown by a `sendTransaction` call, is a definite refusal (see `REFUSED_CODES`). */
export function isSendRefusal(e: unknown): boolean {
  if (!isSolanaError(e)) return false;
  const code = (e.context as { __code?: unknown }).__code;
  return typeof code === "number" && REFUSED_CODES.has(code);
}

export type SignatureInfo = { signature: Signature; slot: bigint; failed: boolean };
export type Status = { failed: boolean; error: string | null; confirmed: boolean } | null;
export type Lifetime = { blockhash: Blockhash; lastValidBlockHeight: bigint };

export interface BeaconChain {
  /** Accounts at one slot (missing ones as null) and that slot. */
  accounts(
    addresses: readonly Address[],
  ): Promise<{ slot: bigint; accounts: (AccountRead | null)[] }>;
  /** Every account of `program` of `size` bytes starting with `discriminator`, optionally `bytes` at `offset`. */
  programAccounts(
    program: Address,
    size: number,
    discriminator: Uint8Array,
    filter?: { offset: number; bytes: Uint8Array },
  ): Promise<AccountRead[]>;
  latestBlockhash(): Promise<Lifetime>;
  /**
   * `address`'s lamports, at `confirmed`, from a node at `minContextSlot` or
   * later when given: a node behind it refuses the read, which then throws.
   */
  balance(address: Address, minContextSlot?: bigint): Promise<bigint>;
  /** The confirmed block height: a transaction whose `lastValidBlockHeight` is below it can never land. */
  blockHeight(): Promise<bigint>;
  /**
   * Sends a signed base64 wire transaction, with a preflight unless
   * `skipPreflight`. Throws `SendRefusedError` only when the transaction was
   * certainly not forwarded; any other error leaves that open.
   */
  send(wire: string, skipPreflight: boolean): Promise<void>;
  statuses(signatures: readonly Signature[]): Promise<Status[]>;
  /** Signatures naming `program`, newest first, before `before` and after `until` (both excluded). */
  signatures(
    program: Address,
    options: { until?: Signature; before?: Signature; limit: number },
  ): Promise<SignatureInfo[]>;
  /** A landed transaction, whatever its version, or null. */
  transaction(signature: Signature): Promise<JsonTx | null>;
  /** The format beacon transactions are built in on this cluster. */
  format(): Promise<TransactionFormat>;
}

/**
 * The beacon loop's signer: `BEACON_SECRET_KEY`, its own key, required and
 * refused when it is the direct path's `KEEPER_SECRET_KEY`. The beacon then
 * pays its sponsorships and fees from a balance the direct path never needs
 * for its settlements, whatever volume or sponsorship the beacon sees.
 */
export async function beaconSigner(env: {
  BEACON_SECRET_KEY?: string;
  KEEPER_SECRET_KEY?: string;
}): Promise<KeyPairSigner> {
  if (!env.BEACON_SECRET_KEY?.trim())
    throw new Error("BEACON_SECRET_KEY is not set: the beacon loop needs a key of its own");
  const signer = await signerFromSecret(env.BEACON_SECRET_KEY, "BEACON_SECRET_KEY");
  if (env.KEEPER_SECRET_KEY?.trim()) {
    const keeper = await signerFromSecret(env.KEEPER_SECRET_KEY, "KEEPER_SECRET_KEY");
    if (keeper.address === signer.address)
      throw new Error("BEACON_SECRET_KEY must not be the direct path's KEEPER_SECRET_KEY");
  }
  return signer;
}

const errorText = (err: unknown) =>
  (
    JSON.stringify(err, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v)) ?? String(err)
  ).slice(0, 300);

const decode64 = (s: string) => new Uint8Array(getBase64Encoder().encode(s));

/** Logs a failed send or preflight carried, wherever kit put them. */
function logsOf(e: unknown): string[] {
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 6; depth++) {
    const ctx = (cur as { context?: { logs?: unknown } }).context;
    if (ctx && Array.isArray(ctx.logs)) return ctx.logs as string[];
    cur = (cur as { cause?: unknown }).cause;
  }
  return [];
}

/**
 * `BeaconChain` over a kit RPC client (`makeRpc` in chain.ts, or the
 * scripts' own), commitment `confirmed` everywhere.
 */
export function rpcChain(rpcIn: unknown): BeaconChain {
  // The RPC's generated method types are too precise to name here; every
  // call below passes what the JSON-RPC method takes.
  const rpc = rpcIn as Record<string, (...args: unknown[]) => { send(): Promise<unknown> }>;
  const call = <T>(method: string, ...args: unknown[]) =>
    (rpc[method] as (...a: unknown[]) => { send(): Promise<T> })(...args).send();
  return {
    async accounts(addresses) {
      if (!addresses.length) {
        return { slot: await call<bigint>("getSlot", { commitment: "confirmed" }), accounts: [] };
      }
      const out: (AccountRead | null)[] = [];
      let slot = 0n;
      for (let i = 0; i < addresses.length; i += 100) {
        const chunk = addresses.slice(i, i + 100);
        const res = await call<{
          context: { slot: bigint };
          value: ({ owner: Address; data: readonly [string, string] } | null)[];
        }>("getMultipleAccounts", chunk, { encoding: "base64", commitment: "confirmed" });
        slot = res.context.slot;
        res.value.forEach((v, j) =>
          out.push(v ? { address: chunk[j]!, owner: v.owner, data: decode64(v.data[0]) } : null),
        );
      }
      return { slot, accounts: out };
    },
    async programAccounts(program, size, discriminator, filter) {
      const filters: unknown[] = [
        { dataSize: BigInt(size) },
        {
          memcmp: {
            offset: 0n,
            bytes: getBase58Decoder().decode(discriminator) as Base58EncodedBytes,
            encoding: "base58",
          },
        },
      ];
      if (filter) {
        filters.push({
          memcmp: {
            offset: BigInt(filter.offset),
            bytes: getBase58Decoder().decode(filter.bytes) as Base58EncodedBytes,
            encoding: "base58",
          },
        });
      }
      const res = await call<
        { pubkey: Address; account: { owner: Address; data: readonly [string, string] } }[]
      >("getProgramAccounts", program, { encoding: "base64", commitment: "confirmed", filters });
      return res.map((a) => ({
        address: a.pubkey,
        owner: a.account.owner,
        data: decode64(a.account.data[0]),
      }));
    },
    async latestBlockhash() {
      const res = await call<{ value: Lifetime }>("getLatestBlockhash", {
        commitment: "confirmed",
      });
      return res.value;
    },
    async balance(address, minContextSlot) {
      const res = await call<{ value: bigint }>("getBalance", address, {
        commitment: "confirmed",
        ...(minContextSlot !== undefined ? { minContextSlot } : {}),
      });
      return BigInt(res.value);
    },
    async blockHeight() {
      return call<bigint>("getBlockHeight", { commitment: "confirmed" });
    },
    async send(wire, skipPreflight) {
      try {
        await call("sendTransaction", wire, {
          encoding: "base64",
          preflightCommitment: "confirmed",
          skipPreflight,
          maxRetries: 0n,
        });
      } catch (e) {
        // Only a JSON-RPC refusal becomes a `SendRefusedError`; a transport error is thrown as
        // is, and the engine keeps the transaction in flight.
        if (!isSendRefusal(e)) throw e;
        const message = e instanceof Error ? e.message : String(e);
        throw new SendRefusedError(message.slice(0, 300), logsOf(e));
      }
    },
    async statuses(signatures) {
      if (!signatures.length) return [];
      const res = await call<{
        value: ({ err: unknown; confirmationStatus: string | null } | null)[];
      }>("getSignatureStatuses", signatures);
      return res.value.map((s) =>
        s
          ? {
              failed: s.err !== null,
              error: s.err !== null ? errorText(s.err) : null,
              confirmed:
                s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized",
            }
          : null,
      );
    },
    async signatures(program, options) {
      const res = await call<{ signature: Signature; slot: bigint; err: unknown }[]>(
        "getSignaturesForAddress",
        program,
        {
          commitment: "confirmed",
          limit: options.limit,
          ...(options.until ? { until: options.until } : {}),
          ...(options.before ? { before: options.before } : {}),
        },
      );
      return res.map((s) => ({ signature: s.signature, slot: s.slot, failed: s.err !== null }));
    },
    async transaction(signature) {
      // An error in both versions reads as not served: the callers retry, then skip it.
      return getTransactionAnyVersion((version) =>
        call<JsonTx | null>("getTransaction", signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: version,
          encoding: "json",
        }),
      ).catch(() => null);
    },
    async format() {
      return transactionFormatFor(rpcIn as Parameters<typeof transactionFormatFor>[0]);
    },
  };
}
