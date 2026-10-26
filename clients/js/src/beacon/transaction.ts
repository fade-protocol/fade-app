// Transaction formats for the beacon's transactions, without any address
// lookup table (team decision, 14 October 2026): version 1 transactions
// (SIMD-0385, with SIMD-0296's larger size) where the cluster accepts them,
// plain version 0 with no lookup table otherwise. A lookup table would make
// every batch depend on an account a keeper creates, extends and pays for,
// and on its warm-up slot; v1 reaches the same batch sizes without one,
// because account locks, not bytes, bind a v1 batch.
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getTransactionMessageSize,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";

/** A version 1 transaction (SIMD-0385), or a version 0 one without lookup table. */
export type TransactionFormat = 1 | 0;

/** The feature gate of SIMD-0385, "Transaction V1". */
export const TRANSACTION_V1_FEATURE = address("txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL");
/** The feature gate that raises the account lock limit to 128 (inactive on mainnet and devnet). */
export const ACCOUNT_LOCKS_128_FEATURE = address("9LZdXeKGeBV6hRLdxS1rHbHoEUsKqesCC2ZAPTPKJAbK");
/** The compute budget program, which a v0 transaction names for its limit and price. */
export const COMPUTE_BUDGET_PROGRAM = address("ComputeBudget111111111111111111111111111111");

/** Accounts one transaction may lock while `ACCOUNT_LOCKS_128_FEATURE` is inactive. */
export const MAX_ACCOUNT_LOCKS = 64;
/** Instructions one transaction may run, its own and every CPI. */
export const MAX_INSTRUCTION_TRACE = 64;
/** Compute units one transaction may request. */
export const MAX_COMPUTE_UNITS = 1_400_000;
/**
 * The runtime's ceiling on the account data a transaction loads (64 MiB). A
 * v0 transaction gets it by default; a v1 transaction that leaves the field
 * unset is budgeted zero bytes and fails, so it is always set.
 */
export const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024;

/** The wire size of a legacy or v0 transaction: one 1 280-byte packet less its headers. */
export const V0_TRANSACTION_SIZE_LIMIT = 1_232;
/** The wire size of a v1 transaction (SIMD-0296). */
export const V1_TRANSACTION_SIZE_LIMIT = 4_096;

/** The wire size limit of a transaction of `format`. */
export function transactionSizeLimit(format: TransactionFormat): number {
  return format === 1 ? V1_TRANSACTION_SIZE_LIMIT : V0_TRANSACTION_SIZE_LIMIT;
}

/** What a transaction may spend. */
export type Budget = {
  /** Compute units requested; a v1 transaction without it gets none. */
  computeUnitLimit: number;
  /** v0 only: micro-lamports per unit. */
  microLamportsPerUnit?: bigint;
  /** v1 only: the whole priority fee, in lamports. */
  priorityFeeLamports?: bigint;
  /** Defaults to `MAX_LOADED_ACCOUNTS_DATA_SIZE`. */
  loadedAccountsDataSizeLimit?: number;
};

/**
 * A transaction message of `format` with `instructions`, its budget in v1's
 * header or in v0's compute budget instructions, and never a lookup table:
 * every account is a static key. A probe or a size estimate passes
 * `createNoopSigner(address)` as the fee payer.
 */
export function beaconTransactionMessage(
  format: TransactionFormat,
  feePayer: TransactionSigner,
  lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint },
  instructions: readonly Instruction[],
  budget: Budget,
) {
  if (!Number.isInteger(budget.computeUnitLimit) || budget.computeUnitLimit <= 0) {
    throw new Error("a transaction needs a positive compute unit limit");
  }
  if (budget.computeUnitLimit > MAX_COMPUTE_UNITS) {
    throw new Error(`a transaction may request at most ${MAX_COMPUTE_UNITS} compute units`);
  }
  const loaded = budget.loadedAccountsDataSizeLimit ?? MAX_LOADED_ACCOUNTS_DATA_SIZE;
  if (format === 1) {
    if (budget.microLamportsPerUnit !== undefined) {
      throw new Error("a v1 transaction pays a priority fee in lamports, not per unit");
    }
    return pipe(
      createTransactionMessage({ version: 1 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
      (m) =>
        setTransactionMessageConfig(
          {
            computeUnitLimit: budget.computeUnitLimit,
            loadedAccountsDataSizeLimit: loaded,
            ...(budget.priorityFeeLamports !== undefined
              ? { priorityFeeLamports: budget.priorityFeeLamports }
              : {}),
          },
          m,
        ),
    );
  }
  if (budget.priorityFeeLamports !== undefined) {
    throw new Error("a v0 transaction pays a priority fee per unit, not in lamports");
  }
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => setTransactionMessageComputeUnitLimit(budget.computeUnitLimit, m),
    (m) =>
      budget.microLamportsPerUnit !== undefined
        ? setTransactionMessageComputeUnitPrice(budget.microLamportsPerUnit, m)
        : m,
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
}

export type BeaconTransactionMessage = ReturnType<typeof beaconTransactionMessage>;

/** Every distinct account a message locks: its fee payer, programs and accounts. */
export function lockedAccounts(message: BeaconTransactionMessage): Set<Address> {
  const keys = new Set<Address>([message.feePayer.address]);
  for (const ix of message.instructions) {
    keys.add(ix.programAddress);
    for (const a of ix.accounts ?? []) keys.add(a.address);
  }
  return keys;
}

/**
 * Wire size, account locks and whether `message` fits its format's limits.
 * A message above the lock limit is not compiled (kit refuses to) and
 * measures `Infinity` bytes.
 */
export function measure(message: BeaconTransactionMessage): {
  bytes: number;
  limit: number;
  locks: number;
  fits: boolean;
} {
  const limit = transactionSizeLimit(message.version);
  const locks = lockedAccounts(message).size;
  if (locks > MAX_ACCOUNT_LOCKS) return { bytes: Infinity, limit, locks, fits: false };
  const bytes = getTransactionMessageSize(message);
  return { bytes, limit, locks, fits: bytes <= limit };
}

type FeatureRpc = {
  getAccountInfo(
    address: Address,
    config: { encoding: "base64"; commitment?: "confirmed" | "finalized" },
  ): {
    send(): Promise<{
      value: { data: readonly [string, string] | string[]; owner: Address } | null;
    }>;
  };
};

const FEATURE_OWNER = address("Feature111111111111111111111111111111111111");

/**
 * The slot at which `feature` activated on the cluster `rpc` serves, or null:
 * a feature account is an `Option<u64>`, `1` then the slot once active.
 */
export async function featureActivationSlot(
  rpc: FeatureRpc,
  feature: Address,
): Promise<bigint | null> {
  const { value } = await rpc
    .getAccountInfo(feature, { encoding: "base64", commitment: "finalized" })
    .send();
  if (!value || value.owner !== FEATURE_OWNER) return null;
  const data = Uint8Array.from(atob(String(value.data[0])), (c) => c.charCodeAt(0));
  if (data.length < 9 || data[0] !== 1) return null;
  return new DataView(data.buffer, data.byteOffset).getBigUint64(1, true);
}

/**
 * The format a client builds beacon transactions in on the cluster `rpc`
 * serves: v1 once SIMD-0385 is active, plain v0 without a lookup table
 * otherwise (and smaller batches, `planSettlement` sizes them by format).
 */
export async function transactionFormatFor(rpc: FeatureRpc): Promise<TransactionFormat> {
  return (await featureActivationSlot(rpc, TRANSACTION_V1_FEATURE)) === null ? 0 : 1;
}
