// Shared helpers for the devnet scripts (init.ts, e2e.ts): the devnet cluster,
// the deployer key, the devnet program id and every PDA bound to it, and a
// send-and-confirm with a priority fee and readable failures.
//
// The generated client defaults to the mainnet program id and the mainnet USDC
// mint: everything here passes the devnet ones explicitly.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  createSolanaRpcSubscriptions,
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
  type RpcTransport,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import {
  findConfigPda,
  findIntegratorPda,
  findVaultPda,
  findQueuePda,
  findShareMintPda,
  findVaultAuthorityPda,
  findVaultUsdcPda,
  findVrfPayerPda,
  findTicketPda,
  getFadeErrorMessage,
  type FadeError,
} from "../../clients/js/src/generated/fade/index.ts";

export const RPC_URL = process.env["RPC_URL"] ?? "https://api.devnet.solana.com";
export const WS_URL = process.env["WS_URL"] ?? RPC_URL.replace(/^http/, "ws");

/** The devnet deployment (feature `devnet`, keys/devnet-fade-program.json). */
export const PROGRAM = address("GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt");
/** The Fade-controlled test mint the devnet build pins (keys/devnet-usdc-mint.json). */
export const USDC_MINT = address("E4XYMYALrvMX19P6TxqKXe8ZYGxfj2CjMub6c2ZficTv");
export const USDC = 1_000_000n;

export const ORAO = address("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
export const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM = address("11111111111111111111111111111111");
export const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
export const SLOT_HASHES = address("SysvarS1otHashes111111111111111111111111111");
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");

/** Microlamports per compute unit: enough to land quickly on devnet, a few hundred lamports a transaction. */
const PRIORITY_MICROLAMPORTS = BigInt(process.env["PRIORITY_MICROLAMPORTS"] ?? "2000");

/** The public devnet endpoint rate-limits bursts (HTTP 429): back off and retry rather than fail a step. */
const baseTransport = createDefaultRpcTransport({ url: RPC_URL });
const retryingTransport = (async (request: Parameters<RpcTransport>[0]) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await baseTransport(request);
    } catch (e) {
      const status = (e as { context?: { statusCode?: number } }).context?.statusCode;
      const retriable = status === 429 || (status !== undefined && status >= 500);
      if (!retriable || attempt >= 8) throw e;
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15_000)));
    }
  }
}) as RpcTransport;
export const rpc = createSolanaRpcFromTransport(retryingTransport);
export const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
// Confirmation by HTTP polling: the public devnet WebSocket endpoint drops
// connections, which left tickets open mid-run.
async function sendAndPoll(
  tx: Parameters<typeof getBase64EncodedWireTransaction>[0],
): Promise<void> {
  const wire = getBase64EncodedWireTransaction(tx);
  const signature = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  const deadline = Date.now() + 90_000;
  let resent = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const st = value[0];
    if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"))
      return;
    if (Date.now() - resent > 5_000) {
      resent = Date.now();
      await rpc
        .sendTransaction(wire, { encoding: "base64", skipPreflight: true })
        .send()
        .catch(() => undefined);
    }
  }
  throw new Error(`transaction ${signature} not confirmed within 90 s`);
}

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddress = (a: string) =>
  `https://explorer.solana.com/address/${a}?cluster=devnet`;

export const bytes = (a: Address) => new Uint8Array(getAddressEncoder().encode(a));
export const u64 = (v: bigint) => new Uint8Array(getU64Encoder().encode(v));
export const fmtUsdc = (v: bigint) => `${(Number(v) / 1e6).toFixed(6)} USDC`;
export const fmtSol = (v: bigint) => `${(Number(v) / 1e9).toFixed(6)} SOL`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- keys -------------------------------------------------------------------------

export async function loadKeypair(name: string): Promise<KeyPairSigner> {
  const path = join("keys", name);
  return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
}

export const loadDeployer = () => loadKeypair("deployer.json");

// --- PDAs bound to the devnet program --------------------------------------------------

const cfg = { programAddress: PROGRAM };

export async function fadePdas() {
  const [config] = await findConfigPda(cfg);
  const [vault] = await findVaultPda(cfg);
  const [queue] = await findQueuePda(cfg);
  const [vaultAuthority] = await findVaultAuthorityPda(cfg);
  const [vaultUsdc] = await findVaultUsdcPda(cfg);
  const [shareMint] = await findShareMintPda(cfg);
  const [eventAuthority] = await getProgramDerivedAddress({
    programAddress: PROGRAM,
    seeds: ["__event_authority"],
  });
  const [programData] = await getProgramDerivedAddress({
    programAddress: LOADER,
    seeds: [bytes(PROGRAM)],
  });
  return {
    config,
    vault,
    queue,
    vaultAuthority,
    vaultUsdc,
    shareMint,
    eventAuthority,
    programData,
  };
}

export async function integratorPda(authority: Address) {
  return (await findIntegratorPda({ integratorAuthority: authority }, cfg))[0];
}
export async function ticketPda(integrator: Address, nonce: bigint) {
  return (await findTicketPda({ integrator, nonce }, cfg))[0];
}
export async function vrfPayerPda(ticket: Address) {
  return (await findVrfPayerPda({ ticket }, cfg))[0];
}
export async function epochPda(epochId: bigint) {
  return (
    await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ["epoch", u64(epochId)] })
  )[0];
}
export async function depositRequestPda(epochId: bigint, owner: Address) {
  return (
    await getProgramDerivedAddress({
      programAddress: PROGRAM,
      seeds: ["deposit", u64(epochId), bytes(owner)],
    })
  )[0];
}
export async function withdrawRequestPda(epochId: bigint, owner: Address) {
  return (
    await getProgramDerivedAddress({
      programAddress: PROGRAM,
      seeds: ["withdraw", u64(epochId), bytes(owner)],
    })
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

// --- reads ------------------------------------------------------------------------------

export async function accountData(addr: Address): Promise<Uint8Array | null> {
  const { value } = await rpc
    .getAccountInfo(addr, { encoding: "base64", commitment: "confirmed" })
    .send();
  return value ? new Uint8Array(getBase64Encoder().encode(value.data[0])) : null;
}

export async function accountOwner(addr: Address): Promise<Address | null> {
  const { value } = await rpc
    .getAccountInfo(addr, { encoding: "base64", commitment: "confirmed" })
    .send();
  return value ? value.owner : null;
}

/** Amount of an SPL token account, or null if it is not one. */
export async function tokenAmount(addr: Address): Promise<bigint | null> {
  const data = await accountData(addr);
  if (!data || data.length !== 165) return null;
  return new DataView(data.buffer, data.byteOffset).getBigUint64(64, true);
}

export async function solBalance(addr: Address): Promise<bigint> {
  return (await rpc.getBalance(addr, { commitment: "confirmed" }).send()).value;
}

export async function currentSlot(): Promise<bigint> {
  return rpc.getSlot({ commitment: "confirmed" }).send();
}

export async function rentExempt(space: number): Promise<bigint> {
  return rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
}

// --- ORAO -------------------------------------------------------------------------------

export async function oraoNetwork() {
  const [networkState] = await getProgramDerivedAddress({
    programAddress: ORAO,
    seeds: ["orao-vrf-network-configuration"],
  });
  const state = await accountData(networkState);
  if (!state) throw new Error(`ORAO network state ${networkState} not found: wrong cluster?`);
  const treasury = getAddressDecoder().decode(state.subarray(40, 72));
  const requestFee = new DataView(state.buffer, state.byteOffset + 72, 8).getBigUint64(0, true);
  return { networkState, treasury, requestFee };
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
export function parseRandomness(
  data: Uint8Array,
): { fulfilled: false } | { fulfilled: true; seed: Uint8Array; randomness: Uint8Array } {
  if (data[8] === 1 && data.length >= 137)
    return { fulfilled: true, seed: data.slice(41, 73), randomness: data.slice(73, 137) };
  return { fulfilled: false };
}

/** The first SlotHashes entry strictly after `slot`, as the program reads it, or null. */
export async function firstSlotHashAfter(
  slot: bigint,
): Promise<{ slot: bigint; hash: Uint8Array } | null> {
  const data = await accountData(SLOT_HASHES);
  if (!data) throw new Error("SlotHashes unreadable");
  const view = new DataView(data.buffer, data.byteOffset);
  const n = Number(view.getBigUint64(0, true));
  let found: { slot: bigint; hash: Uint8Array } | null = null;
  // Entries are newest first: walk until the first one at or before `slot`.
  for (let i = 0; i < n; i++) {
    const off = 8 + i * 40;
    const s = view.getBigUint64(off, true);
    if (s <= slot) break;
    found = { slot: s, hash: data.slice(off + 8, off + 40) };
  }
  return found;
}

/** `SHA256("FADE/ORAO-SEED/v1" ‖ program ‖ ticket ‖ open_slot ‖ s* ‖ h*)` (Technical Specification §3.6). */
export function oraoSeed(
  ticket: Address,
  openSlot: bigint,
  entropySlot: bigint,
  entropyHash: Uint8Array,
): Uint8Array {
  return new Uint8Array(
    createHash("sha256")
      .update("FADE/ORAO-SEED/v1")
      .update(bytes(PROGRAM))
      .update(bytes(ticket))
      .update(u64(openSlot))
      .update(u64(entropySlot))
      .update(entropyHash)
      .digest(),
  );
}

// --- sending -----------------------------------------------------------------------------

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

async function build(payer: KeyPairSigner, instructions: Instruction[], units: number) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([...computeBudget(units), ...instructions], m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(tx);
  return tx;
}

/** Fade custom error code (6000+) carried by a transaction error, if any. */
export function customErrorCode(err: unknown): number | null {
  const text = JSON.stringify(err, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v));
  const m = /"Custom":(\d+)/.exec(text ?? "");
  return m?.[1] ? Number(m[1]) : null;
}

export function fadeErrorName(code: number | null): string {
  if (code === null) return "unknown";
  try {
    return `${code} (${getFadeErrorMessage(code as FadeError)})`;
  } catch {
    return String(code);
  }
}

export class SendError extends Error {
  constructor(
    label: string,
    readonly logs: readonly string[],
    readonly code: number | null,
    cause: unknown,
  ) {
    super(
      `${label} failed: ${cause instanceof Error ? cause.message : String(cause)}` +
        (code !== null ? `\n  program error ${fadeErrorName(code)}` : "") +
        (logs.length ? `\n  logs:\n    ${logs.join("\n    ")}` : ""),
    );
  }
}

function logsOf(e: unknown): string[] {
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    const ctx = (cur as { context?: { logs?: unknown } }).context;
    if (ctx && Array.isArray(ctx.logs)) return ctx.logs as string[];
    cur = (cur as { cause?: unknown }).cause;
  }
  return [];
}

export type Sent = { signature: Signature; slot: bigint; link: string };

/** Sends, waits for `confirmed`, prints the explorer link. Throws a SendError with the logs on failure. */
export async function send(
  payer: KeyPairSigner,
  instructions: Instruction[],
  label: string,
  units = 400_000,
): Promise<Sent> {
  const tx = await build(payer, instructions, units);
  const signature = getSignatureFromTransaction(tx);
  try {
    await sendAndPoll(tx);
  } catch (e) {
    let logs = logsOf(e);
    if (!logs.length) {
      // Landed but failed, or failed preflight without logs: ask the cluster.
      const t = await rpc
        .getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
          encoding: "json",
        })
        .send()
        .catch(() => null);
      logs = (t?.meta?.logMessages as string[] | undefined) ?? [];
    }
    throw new SendError(label, logs, customErrorCode(e), e);
  }
  const status = await rpc.getSignatureStatuses([signature]).send();
  const slot = status.value[0]?.slot ?? (await currentSlot());
  const link = explorerTx(signature);
  console.log(`  ✓ ${label}: ${link} (slot ${slot})`);
  return { signature, slot, link };
}

/** Simulates without sending: returns the error and logs (null error = would succeed). */
export async function simulate(
  payer: KeyPairSigner,
  instructions: Instruction[],
  units = 400_000,
): Promise<{ err: unknown; code: number | null; logs: string[] }> {
  const tx = await build(payer, instructions, units);
  const { value } = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(tx), {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: true,
    })
    .send();
  return {
    err: value.err,
    code: value.err ? customErrorCode(value.err) : null,
    logs: (value.logs as string[] | null) ?? [],
  };
}

// --- run log -----------------------------------------------------------------------------

export function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(data, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n",
  );
}
