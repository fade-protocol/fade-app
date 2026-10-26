// Reading a transaction whatever its version (clients/js/src/transactionFetch.ts): version 1
// first, version 0 only from an RPC that refuses the version-1 parameter, and the app's batched
// reader (apps/web/src/lib/txCache.ts) the same way, one signature at a time.
import {
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION,
  SolanaError,
  type Signature,
} from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getJsonTransaction,
  getTransactionAnyVersion,
  isUnsupportedVersionError,
  type TransactionRpc,
} from "../../../clients/js/src/transactionFetch.ts";
import { fetchJsonTxBatch } from "../../../apps/web/src/lib/txCache.ts";

const SIG = "1".repeat(64) as Signature;
const unsupported = () =>
  new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION, {
    __serverMessage: "Transaction version (1) is not supported by the requesting client",
  });
const invalidParams = () =>
  new SolanaError(SOLANA_ERROR__JSON_RPC__INVALID_PARAMS, { __serverMessage: "invalid params" });

/** A `get` that answers `answer(version)` and records the versions asked. */
function getter(answer: (version: 0 | 1) => Promise<unknown>) {
  const asked: number[] = [];
  const get = (version: 0 | 1) => {
    asked.push(version);
    return answer(version);
  };
  return { asked, get };
}

describe("reading a transaction whatever its version", () => {
  it("asks version 1 first and returns its answer", async () => {
    const tx = { version: 1 };
    const { asked, get } = getter(async () => tx);
    expect(await getTransactionAnyVersion(get)).toBe(tx);
    expect(asked).toEqual([1]);
  });

  it("does not ask again in v0 a transaction not served yet", async () => {
    const { asked, get } = getter(async () => null);
    expect(await getTransactionAnyVersion(get)).toBeNull();
    expect(asked).toEqual([1]);
  });

  it("asks again in v0 when the RPC refuses the version-1 parameter", async () => {
    const tx = { version: 0 };
    const { asked, get } = getter(async (v) => {
      if (v === 1) throw invalidParams();
      return tx;
    });
    expect(await getTransactionAnyVersion(get)).toBe(tx);
    expect(asked).toEqual([1, 0]);
  });

  it("throws the v0 error when both fail, or the v1 one when v0 only says the version is above it", async () => {
    const down = new Error("unavailable");
    const both = getter(async (v) => {
      if (v === 1) throw invalidParams();
      throw down;
    });
    await expect(getTransactionAnyVersion(both.get)).rejects.toBe(down);
    // A v1 transaction whose v1 read failed: v0's -32015 says nothing about why.
    const first = new Error("rate limited");
    const v1tx = getter(async (v) => {
      if (v === 1) throw first;
      throw unsupported();
    });
    await expect(getTransactionAnyVersion(v1tx.get)).rejects.toBe(first);
    expect(v1tx.asked).toEqual([1, 0]);
  });

  it("knows the RPC's -32015 from kit's error and from a raw JSON-RPC error", () => {
    expect(isUnsupportedVersionError(unsupported())).toBe(true);
    expect(isUnsupportedVersionError({ code: -32015, message: "Transaction version (1)" })).toBe(
      true,
    );
    expect(isUnsupportedVersionError(invalidParams())).toBe(false);
    expect(isUnsupportedVersionError({ code: -32602 })).toBe(false);
    expect(isUnsupportedVersionError(null)).toBe(false);
  });

  it("over a kit RPC client: JSON, the commitment asked, version 1 then 0", async () => {
    const calls: unknown[] = [];
    const tx = { slot: 5n };
    const rpc: TransactionRpc = {
      getTransaction: (signature, config) => ({
        send: async () => {
          calls.push([signature, config]);
          if (config.maxSupportedTransactionVersion !== 0) throw invalidParams();
          return tx;
        },
      }),
    };
    expect(await getJsonTransaction(rpc, SIG, "finalized")).toBe(tx);
    expect(calls).toEqual([
      [SIG, { commitment: "finalized", maxSupportedTransactionVersion: 1, encoding: "json" }],
      [SIG, { commitment: "finalized", maxSupportedTransactionVersion: 0, encoding: "json" }],
    ]);
  });
});

describe("the app's batched transaction reads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks a batch in version 1, then only the signatures it refused in version 0", async () => {
    const a = "2".repeat(64) as Signature;
    const b = "3".repeat(64) as Signature;
    const c = "4".repeat(64) as Signature;
    const batches: { sig: string; version: number }[][] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        id: number;
        params: [string, { maxSupportedTransactionVersion: number }];
      }[];
      batches.push(
        body.map((r) => ({
          sig: r.params[0],
          version: r.params[1].maxSupportedTransactionVersion,
        })),
      );
      const replies = body.map((r) => {
        const [sig, { maxSupportedTransactionVersion: v }] = r.params;
        // a: a v1 transaction; b: refused in v1 by this RPC, served in v0; c: refused in both
        if (sig === a) return { id: r.id, result: { version: 1 } };
        if (sig === b && v === 0) return { id: r.id, result: { version: 0 } };
        if (sig === c && v === 0)
          return { id: r.id, error: { code: -32015, message: "not supported" } };
        return { id: r.id, error: { code: -32602, message: "invalid params" } };
      });
      return new Response(JSON.stringify(replies), { status: 200 });
    });
    const out = await fetchJsonTxBatch([a, b, c]);
    expect(batches).toEqual([
      [
        { sig: a, version: 1 },
        { sig: b, version: 1 },
        { sig: c, version: 1 },
      ],
      [
        { sig: b, version: 0 },
        { sig: c, version: 0 },
      ],
    ]);
    expect(out.get(a)).toEqual({ version: 1 });
    expect(out.get(b)).toEqual({ version: 0 });
    // Missing: an error, read again later.
    expect(out.has(c)).toBe(false);
  });
});
