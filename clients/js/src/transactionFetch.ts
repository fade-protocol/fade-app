// Reading a landed transaction whatever its version. `getTransaction`
// refuses (-32015) a transaction above the `maxSupportedTransactionVersion`
// it is asked with, and the beacon's own transactions, like an integrator's,
// are version 1 (SIMD-0385) where the cluster takes them: every reader asks
// version 1 first, and version 0 again only from an RPC that refuses the
// version-1 parameter itself.
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION,
  isSolanaError,
  type Commitment,
  type Signature,
} from "@solana/kit";

/** The `maxSupportedTransactionVersion` values a read asks, in order. */
export const TRANSACTION_VERSIONS_ASKED = [1, 0] as const;
export type AskedTransactionVersion = (typeof TRANSACTION_VERSIONS_ASKED)[number];

/**
 * Whether `e` is the RPC's -32015: the transaction is above the version
 * asked. Either a kit `SolanaError` or a raw JSON-RPC error object.
 */
export function isUnsupportedVersionError(e: unknown): boolean {
  if (isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION))
    return true;
  return (
    typeof e === "object" &&
    e !== null &&
    Number((e as { code?: unknown }).code) ===
      SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION
  );
}

/**
 * One transaction through `get`, asked in version 1, then in version 0 if
 * that throws. A null answer ("not served yet") is returned as it is, never
 * asked again in v0, which would double every read of a transaction the RPC
 * lags on. When both throw, the v0 error is thrown, unless it only says the
 * transaction is above version 0: then the v1 error, the one that tells why
 * this transaction could not be read.
 */
export async function getTransactionAnyVersion<T>(
  get: (version: AskedTransactionVersion) => Promise<T | null>,
): Promise<T | null> {
  let first: unknown;
  try {
    return await get(1);
  } catch (e) {
    first = e;
  }
  try {
    return await get(0);
  } catch (e) {
    throw isUnsupportedVersionError(e) ? first : e;
  }
}

/** The part of a kit RPC client `getJsonTransaction` calls. */
export type TransactionRpc = {
  getTransaction(
    signature: Signature,
    config: {
      commitment: Commitment;
      // kit types the parameter for version 0 only
      maxSupportedTransactionVersion: 0;
      encoding: "json";
    },
  ): { send(): Promise<unknown> };
};

/**
 * A transaction as JSON (`encoding: "json"`) over a kit RPC client, whatever
 * its version (`getTransactionAnyVersion`); null while the RPC does not serve
 * it. `T` is the caller's view of the JSON.
 */
export function getJsonTransaction<T>(
  rpc: TransactionRpc,
  signature: Signature,
  commitment: Commitment,
): Promise<T | null> {
  return getTransactionAnyVersion(async (version) => {
    const t = await rpc
      .getTransaction(signature, {
        commitment,
        maxSupportedTransactionVersion: version as 0,
        encoding: "json",
      })
      .send();
    return (t as T | null) ?? null;
  });
}
