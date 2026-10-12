// Chain access for the keeper, ported from scripts/devnet/lib.ts to run in a
// Worker: the devnet program and its PDAs, ORAO, the entropy seed (WebCrypto
// SHA-256 instead of node:crypto), and sending with a priority fee.
//
// The generated client defaults to the mainnet program id and the mainnet USDC
// mint: everything here passes the devnet ones explicitly.
import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createDefaultRpcTransport,
  createKeyPairSignerFromBytes,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getU64Encoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type RpcTransport,
  type Signature,
} from "@solana/kit";

/** The devnet deployment (feature `devnet`). */
export const PROGRAM = address("GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt");
/** The Fade-controlled test mint the devnet build pins. */
export const USDC_MINT = address("E4XYMYALrvMX19P6TxqKXe8ZYGxfj2CjMub6c2ZficTv");
export const ORAO = address("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
export const SYSTEM = address("11111111111111111111111111111111");
export const SLOT_HASHES = address("SysvarS1otHashes111111111111111111111111111");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");

export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
/** Earliest request: `open_slot + REQUEST_MIN_DELAY_SLOTS`. */
export const REQUEST_MIN_DELAY_SLOTS = 2n;
/** Microlamports per compute unit: lands quickly on devnet for a few hundred lamports. */
const PRIORITY_MICROLAMPORTS = 2_000n;

export const cfg = { programAddress: PROGRAM };

export const bytes = (a: Address) => new Uint8Array(getAddressEncoder().encode(a));
export const u64 = (v: bigint) => new Uint8Array(getU64Encoder().encode(v));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- RPC ------------------------------------------------------------------------------

/** HTTP status of a failed RPC call, if the transport reported one. */
export function rpcStatus(e: unknown): number | undefined {
  return (e as { context?: { statusCode?: number } }).context?.statusCode;
}

/**
 * An RPC client that backs off on 429 and 5xx. Retries stay short: the keeper
 * runs on an alarm, and the next tick picks up whatever this one could not do.
 */
export function makeRpc(url: string) {
  const base = createDefaultRpcTransport({ url });
  const transport = (async (request: Parameters<RpcTransport>[0]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await base(request);
      } catch (e) {
        const status = rpcStatus(e);
        const retriable = status === 429 || (status !== undefined && status >= 500);
        if (!retriable || attempt >= 3) throw e;
        await sleep(Math.min(500 * 2 ** attempt, 4_000));
      }
    }
  }) as RpcTransport;
  return createSolanaRpcFromTransport(transport);
}
export type Rpc = ReturnType<typeof makeRpc>;

export const decodeBase64 = (data: string) => new Uint8Array(getBase64Encoder().encode(data));

// --- PDAs -------------------------------------------------------------------------------

let eventAuthorityCache: Address | null = null;
export async function eventAuthority(): Promise<Address> {
  eventAuthorityCache ??= (
    await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ["__event_authority"] })
  )[0];
  return eventAuthorityCache;
}

export async function epochPda(epochId: bigint) {
  return (
    await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ["epoch", u64(epochId)] })
  )[0];
}

export async function ata(owner: Address, mint: Address) {
  return (
    await getProgramDerivedAddress({
      programAddress: ATA_PROGRAM,
      seeds: [bytes(owner), bytes(TOKEN), bytes(mint)],
    })
  )[0];
}

/** A keypair signer from a secret holding the 64-byte keypair as a JSON array. */
export async function signerFromSecret(
  raw: string | undefined,
  name: string,
): Promise<KeyPairSigner> {
  if (!raw) throw new Error(`${name} is not set`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not a JSON array`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 64) throw new Error(`${name} must hold 64 bytes`);
  return createKeyPairSignerFromBytes(Uint8Array.from(parsed as number[]));
}

// --- ORAO -------------------------------------------------------------------------------

export async function oraoTreasury(rpc: Rpc): Promise<Address> {
  const [networkState] = await getProgramDerivedAddress({
    programAddress: ORAO,
    seeds: ["orao-vrf-network-configuration"],
  });
  const { value } = await rpc
    .getAccountInfo(networkState, { encoding: "base64", commitment: "confirmed" })
    .send();
  if (!value) throw new Error(`ORAO network state ${networkState} not found`);
  const state = decodeBase64(value.data[0]);
  return getAddressDecoder().decode(state.subarray(40, 72));
}

export async function oraoRequestPda(seed: Uint8Array) {
  return (
    await getProgramDerivedAddress({
      programAddress: ORAO,
      seeds: ["orao-vrf-randomness-request", seed],
    })
  )[0];
}

/** ORAO randomness v2 account: pending (749 bytes, tag 0) or fulfilled (137 bytes, tag 1). */
export function isFulfilled(data: Uint8Array): boolean {
  return data[8] === 1 && data.length >= 137;
}

/** The first SlotHashes entry strictly after `slot`, as the program reads it, or null. */
export function firstSlotHashAfter(
  slotHashes: Uint8Array,
  slot: bigint,
): { slot: bigint; hash: Uint8Array } | null {
  const view = new DataView(slotHashes.buffer, slotHashes.byteOffset, slotHashes.byteLength);
  const n = Number(view.getBigUint64(0, true));
  let found: { slot: bigint; hash: Uint8Array } | null = null;
  // Entries are newest first: walk until the first one at or before `slot`.
  for (let i = 0; i < n; i++) {
    const off = 8 + i * 40;
    if (off + 40 > slotHashes.length) break;
    const s = view.getBigUint64(off, true);
    if (s <= slot) break;
    found = { slot: s, hash: slotHashes.slice(off + 8, off + 40) };
  }
  return found;
}

/** `SHA256("FADE/ORAO-SEED/v1" ‖ program ‖ ticket ‖ open_slot ‖ s* ‖ h*)` (Technical Specification §3.6). */
export async function oraoSeed(
  ticket: Address,
  openSlot: bigint,
  entropySlot: bigint,
  entropyHash: Uint8Array,
): Promise<Uint8Array> {
  const parts = [
    new TextEncoder().encode("FADE/ORAO-SEED/v1"),
    bytes(PROGRAM),
    bytes(ticket),
    u64(openSlot),
    u64(entropySlot),
    entropyHash,
  ];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}

// --- sending ------------------------------------------------------------------------------

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

export type Built = { signature: Signature; wire: string };

export async function build(
  rpc: Rpc,
  payer: KeyPairSigner,
  instructions: Instruction[],
  units: number,
): Promise<Built> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([...computeBudget(units), ...instructions], m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(tx);
  return { signature: getSignatureFromTransaction(tx), wire: getBase64EncodedWireTransaction(tx) };
}

/** Simulates a built transaction: null if it would succeed, else a short reason. */
export async function simulateBuilt(rpc: Rpc, b: Built): Promise<string | null> {
  const { value } = await rpc
    .simulateTransaction(b.wire as Parameters<Rpc["simulateTransaction"]>[0], {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: true,
    })
    .send();
  if (!value.err) return null;
  const line = (value.logs ?? []).find((l) => l.includes("Error Code")) ?? "";
  return `${errorText(value.err)} ${line}`.trim();
}

/** Sends with preflight. Throws with the program error on a preflight failure. */
export async function sendWire(rpc: Rpc, wire: string, skipPreflight = false): Promise<void> {
  await rpc
    .sendTransaction(wire as Parameters<Rpc["sendTransaction"]>[0], {
      encoding: "base64",
      preflightCommitment: "confirmed",
      skipPreflight,
      maxRetries: 0n,
    })
    .send();
}

export function errorText(err: unknown): string {
  const text = JSON.stringify(err, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v));
  return (text ?? String(err)).slice(0, 300);
}

/** The most useful line of a failed send: its program logs' error line, or its message. */
export function describeError(e: unknown): string {
  const status = rpcStatus(e);
  if (status !== undefined) return `RPC answered HTTP ${status}`;
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    const ctx = (cur as { context?: { logs?: unknown } }).context;
    if (ctx && Array.isArray(ctx.logs)) {
      const line = (ctx.logs as string[]).find((l) => l.includes("Error Code"));
      if (line) return line.slice(0, 300);
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

// --- events ------------------------------------------------------------------------------

/** `sha256("anchor:event")[..8]`: the tag of every `emit_cpi!` inner instruction. */
export const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export const startsWith = (data: Uint8Array, prefix: ArrayLike<number>, at = 0) => {
  if (data.length < at + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[at + i] !== prefix[i]) return false;
  return true;
};

export type Confirmation = { ok: true } | { ok: false; error: string };

/**
 * Sends a built transaction and polls until it is confirmed, it fails, or
 * `timeoutMs` passes (resending every few seconds meanwhile).
 */
export async function sendAndConfirm(
  rpc: Rpc,
  b: Built,
  timeoutMs = 45_000,
): Promise<Confirmation> {
  await sendWire(rpc, b.wire);
  const sentAt = Date.now();
  let resent = sentAt;
  while (Date.now() - sentAt < timeoutMs) {
    await sleep(1_500);
    const { value } = await rpc.getSignatureStatuses([b.signature]).send();
    const st = value[0];
    if (st?.err) return { ok: false, error: `failed on chain: ${errorText(st.err)}` };
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized")
      return { ok: true };
    if (Date.now() - resent > 4_000) {
      resent = Date.now();
      await sendWire(rpc, b.wire, true).catch(() => undefined);
    }
  }
  return { ok: false, error: `not confirmed within ${Math.round(timeoutMs / 1000)} s` };
}
