// Building, simulating and sending transactions. Every transaction is simulated
// against the program before the wallet is asked to sign it, so a refusal is
// shown with the program's own words and costs nothing.
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import { COMPUTE_BUDGET, explorerTx } from "./config";
import { rpc, sleep } from "./rpc";

/** Microlamports per compute unit: lands quickly on devnet for a few hundred lamports. */
const PRIORITY_MICROLAMPORTS = 2_000n;

function computeBudget(units: number): Instruction[] {
  const limit = new Uint8Array(5);
  limit[0] = 2;
  new DataView(limit.buffer).setUint32(1, units, true);
  const price = new Uint8Array(9);
  price[0] = 3;
  new DataView(price.buffer).setBigUint64(1, PRIORITY_MICROLAMPORTS, true);
  return [
    { programAddress: COMPUTE_BUDGET, data: limit },
    { programAddress: COMPUTE_BUDGET, data: price },
  ];
}

async function message(payer: TransactionSigner, instructions: Instruction[], units: number) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([...computeBudget(units), ...instructions], m),
  );
}

/** A program refusal, decoded from the transaction error and the program's logs. */
export type ProgramFailure = {
  /** Fade's custom error number (6000+), when the failure is the program's. */
  code: number | null;
  /** Anchor's error name, e.g. `PerTicketCap`. */
  name: string | null;
  /** The program's own message, e.g. "worst-case payout above the per-ticket cap". */
  message: string;
  logs: string[];
};

const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? Number(v) : v);

export function decodeFailure(err: unknown, logs: readonly string[]): ProgramFailure {
  const text = JSON.stringify(err, bigintSafe) ?? String(err);
  const custom = /"Custom":(\d+)/.exec(text);
  const code = custom?.[1] ? Number(custom[1]) : null;
  // Anchor: "Program log: AnchorError ... Error Code: PerTicketCap. Error Number: 6020. Error Message: ...".
  const line = logs.find((l) => l.includes("Error Code:"));
  const name = line ? (/Error Code: (\w+)/.exec(line)?.[1] ?? null) : null;
  const msg = line ? (/Error Message: (.*?)\.?$/.exec(line)?.[1] ?? null) : null;
  let message = msg ?? "";
  if (!message) {
    if (text.includes("InsufficientFundsForFee") || text.includes("AccountNotFound"))
      message = "the wallet has no SOL to pay the transaction fee";
    else if (logs.some((l) => l.includes("insufficient funds")))
      message = "insufficient funds in the wallet (USDC or SOL)";
    else if (logs.some((l) => l.includes("insufficient lamports")))
      message = "not enough SOL in the wallet";
    else message = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  }
  return { code, name, message, logs: [...logs] };
}

export class TxError extends Error {
  constructor(
    readonly label: string,
    readonly failure: ProgramFailure,
    /** Sent but not confirmed in time: it may still land (see `signatureStatus`). */
    readonly pending: Signature | null = null,
  ) {
    super(`${label}: ${failure.name ? `${failure.name}, ` : ""}${failure.message}`);
  }
}

export type Simulation =
  { ok: true; logs: string[]; units: bigint | null } | { ok: false; failure: ProgramFailure };

/**
 * Simulates without signatures: the fee payer and every signer only need an
 * address. Spends nothing.
 */
export async function simulate(
  feePayer: Address | TransactionSigner,
  instructions: Instruction[],
  units = 400_000,
): Promise<Simulation> {
  const payer = typeof feePayer === "string" ? createNoopSigner(feePayer) : feePayer;
  const tx = compileTransaction(await message(payer, instructions, units));
  const { value } = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(tx), {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: true,
    })
    .send();
  const logs = (value.logs as readonly string[] | null) ?? [];
  if (value.err) return { ok: false, failure: decodeFailure(value.err, logs) };
  return { ok: true, logs: [...logs], units: value.unitsConsumed ?? null };
}

export type Sent = { signature: Signature; link: string; slot: bigint };

/**
 * Simulate, then ask the wallet to sign, send and wait for `confirmed`.
 * Throws a TxError with the program's reason if either fails.
 */
export async function send(
  signer: TransactionSigner,
  instructions: Instruction[],
  label: string,
  units = 400_000,
  hooks: { onSigned?: (signature: Signature) => void } = {},
): Promise<Sent> {
  const sim = await simulate(signer.address, instructions, units);
  if (!sim.ok) throw new TxError(label, sim.failure);
  const signed = await signTransactionMessageWithSigners(
    await message(signer, instructions, units),
  );
  const signature = getSignatureFromTransaction(signed);
  hooks.onSigned?.(signature);
  try {
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), {
        encoding: "base64",
        preflightCommitment: "confirmed",
        maxRetries: 3n,
      })
      .send();
  } catch (e) {
    const logs = findLogs(e);
    throw new TxError(label, decodeFailure((e as { cause?: unknown }).cause ?? e, logs));
  }
  return { signature, link: explorerTx(signature), slot: await confirm(signature, label) };
}

function findLogs(e: unknown): string[] {
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    const ctx = (cur as { context?: { logs?: unknown } }).context;
    if (ctx && Array.isArray(ctx.logs)) return ctx.logs as string[];
    cur = (cur as { cause?: unknown }).cause;
  }
  return [];
}

/** Polls the signature until `confirmed`; a landed failure is decoded from its logs. */
export async function confirm(
  signature: Signature,
  label: string,
  timeoutMs = 90_000,
): Promise<bigint> {
  const started = Date.now();
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const s = value[0];
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      if (s.err) {
        const t = await rpc
          .getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
            encoding: "json",
          })
          .send()
          .catch(() => null);
        throw new TxError(
          label,
          decodeFailure(s.err, (t?.meta?.logMessages as string[] | undefined) ?? []),
        );
      }
      return s.slot;
    }
    if (Date.now() - started > timeoutMs)
      throw new TxError(
        label,
        {
          code: null,
          name: null,
          message:
            "the transaction was not confirmed in time; it may still land, check the explorer",
          logs: [],
        },
        signature,
      );
    await sleep(1_000);
  }
}

/** Where a sent transaction is: landed (confirmed), failed (with the program's reason), or not seen yet. */
export async function signatureStatus(
  signature: Signature,
): Promise<
  { state: "landed" } | { state: "failed"; failure: ProgramFailure } | { state: "unknown" }
> {
  const { value } = await rpc
    .getSignatureStatuses([signature], { searchTransactionHistory: true })
    .send();
  const s = value[0];
  if (!s || (s.confirmationStatus !== "confirmed" && s.confirmationStatus !== "finalized"))
    return { state: "unknown" };
  if (!s.err) return { state: "landed" };
  const t = await rpc
    .getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
      encoding: "json",
    })
    .send()
    .catch(() => null);
  return {
    state: "failed",
    failure: decodeFailure(s.err, (t?.meta?.logMessages as string[] | undefined) ?? []),
  };
}
