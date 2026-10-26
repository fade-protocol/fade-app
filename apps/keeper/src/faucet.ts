// The devnet faucet behind POST /v1/faucet: test USDC, plus a little devnet SOL
// to a wallet that has almost none, from a key of its own (FAUCET_SECRET_KEY),
// never the keeper's or the deployer's.
//
// Every limit is checked in this Durable Object's SQLite before any RPC call,
// and the claim is recorded in the same synchronous step: a refused request
// costs no RPC, and two requests racing across an await cannot both pass. An
// accepted claim costs one balance read and one transaction (the recipient's
// USDC account is created in it when missing). A send that fails does not
// count against the wallet, so its owner can try again, but it still counts
// against the connection's attempts, so failing sends cannot be repeated to
// spend RPC calls without end. Program and PDA addresses are refused up front.
import { DurableObject } from "cloudflare:workers";
import { isAddress, isOffCurveAddress, type Address, type KeyPairSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  DEFAULT_RPC_URL,
  USDC_MINT,
  build,
  describeError,
  makeRpc,
  sendWire,
  signerFromSecret,
  type Rpc,
} from "./chain.ts";
import type { Env } from "./index.ts";

/** Test USDC per claim, base units (6 decimals). */
export const FAUCET_USDC = 1_000_000_000n;
const USDC_DECIMALS = 6;
/**
 * Devnet SOL sent with a claim when the wallet holds less than SOL_TOP_UP_BELOW,
 * at most once a day per wallet and per IP address: claims come every few
 * minutes, and fresh wallets must not drain the faucet's SOL. Enough for the
 * SOL a first small ticket on the shared draw fronts while it runs (its rents
 * and its draw, about 0.011 to 0.017 SOL), plus its fees.
 */
const SOL_TOP_UP = 20_000_000n;
const SOL_TOP_UP_BELOW = 5_000_000n;
/** The faucet keeps this much SOL for its own fees and the accounts it creates. */
const FAUCET_SOL_RESERVE = 200_000_000n;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** One claim per wallet, and one per IP address, every CLAIM_EVERY_MS. */
const CLAIM_EVERY_MS = 5 * MINUTE_MS;
/** Attempts per IP address per hour, failed sends included. */
const PER_IP_ATTEMPTS_PER_HOUR = 20;
/** Claims per day across everyone: bounds what a swarm of wallets and addresses can take. */
const GLOBAL_PER_DAY = 300;

export type ClaimResult =
  | { ok: true; signature: string; usdc: string; sol: string }
  | { ok: false; status: number; error: string; retryAt?: number };

export type FaucetInfo = { usdc: string; perDay: number; remainingToday: number };

export class Faucet extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly rpc: Rpc;
  private signerPromise: Promise<KeyPairSigner> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.rpc = makeRpc(env.RPC_URL || DEFAULT_RPC_URL);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      ip TEXT NOT NULL,
      at INTEGER NOT NULL,
      signature TEXT,
      failed INTEGER NOT NULL DEFAULT 0,
      sol INTEGER NOT NULL DEFAULT 0
    )`);
    const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(claims)").toArray();
    if (!columns.some((c) => c.name === "failed"))
      this.sql.exec("ALTER TABLE claims ADD COLUMN failed INTEGER NOT NULL DEFAULT 0");
    if (!columns.some((c) => c.name === "sol"))
      this.sql.exec("ALTER TABLE claims ADD COLUMN sol INTEGER NOT NULL DEFAULT 0");
    this.sql.exec("CREATE INDEX IF NOT EXISTS claims_owner ON claims (owner, at)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS claims_ip ON claims (ip, at)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS claims_at ON claims (at)");
  }

  info(): FaucetInfo {
    this.prune(Date.now());
    return {
      usdc: FAUCET_USDC.toString(),
      perDay: GLOBAL_PER_DAY,
      remainingToday: Math.max(
        0,
        GLOBAL_PER_DAY - this.since(DAY_MS, "failed = 0", [], Date.now()).count,
      ),
    };
  }

  async claim(owner: string, ip: string): Promise<ClaimResult> {
    if (!isAddress(owner)) return { ok: false, status: 400, error: "not a base58 address" };
    if (isOffCurveAddress(owner)) return { ok: false, status: 400, error: "not a wallet address" };
    const now = Date.now();
    this.prune(now);

    // Limits, then the reservation, with no await in between.
    const byWallet = this.since(CLAIM_EVERY_MS, "owner = ? AND failed = 0", [owner], now);
    if (byWallet.count > 0)
      return refused("this wallet claimed a few minutes ago", byWallet.oldest + CLAIM_EVERY_MS);
    const byIp = this.since(CLAIM_EVERY_MS, "ip = ? AND failed = 0", [ip], now);
    if (byIp.count > 0)
      return refused("this connection claimed a few minutes ago", byIp.oldest + CLAIM_EVERY_MS);
    const tries = this.since(HOUR_MS, "ip = ?", [ip], now);
    if (tries.count >= PER_IP_ATTEMPTS_PER_HOUR)
      return refused("too many attempts from this connection", tries.oldest + HOUR_MS);
    const all = this.since(DAY_MS, "failed = 0", [], now);
    if (all.count >= GLOBAL_PER_DAY)
      return refused("free USDC has run out for today", all.oldest + DAY_MS);
    const solAllowed =
      this.since(DAY_MS, "(owner = ? OR ip = ?) AND sol > 0", [owner, ip], now).count === 0;
    const id = this.sql
      .exec<{ id: number }>(
        "INSERT INTO claims (owner, ip, at) VALUES (?, ?, ?) RETURNING id",
        owner,
        ip,
        now,
      )
      .one().id;

    try {
      const sent = await this.send(owner as Address, solAllowed);
      this.sql.exec(
        "UPDATE claims SET signature = ?, sol = ? WHERE id = ?",
        sent.signature,
        Number(sent.sol),
        id,
      );
      return { ok: true, ...sent };
    } catch (e) {
      this.sql.exec("UPDATE claims SET failed = 1 WHERE id = ?", id);
      console.error(`faucet: claim for ${owner} failed: ${describeError(e)}`);
      return { ok: false, status: 503, error: "free USDC could not be sent, try again shortly" };
    }
  }

  /** USDC, the recipient's account if missing, and SOL if it has almost none, in one transaction. */
  private async send(owner: Address, solAllowed: boolean) {
    const faucet = await this.signer();
    const [[from], [to], { value: ownerSol }, { value: faucetSol }] = await Promise.all([
      findAssociatedTokenPda({
        owner: faucet.address,
        mint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
      findAssociatedTokenPda({ owner, mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      this.rpc.getBalance(owner, { commitment: "confirmed" }).send(),
      this.rpc.getBalance(faucet.address, { commitment: "confirmed" }).send(),
    ]);
    const topUp =
      solAllowed && ownerSol < SOL_TOP_UP_BELOW && faucetSol > FAUCET_SOL_RESERVE + SOL_TOP_UP;
    const ixs = [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: faucet,
        owner,
        mint: USDC_MINT,
      }),
      getTransferCheckedInstruction({
        source: from,
        mint: USDC_MINT,
        destination: to,
        authority: faucet,
        amount: FAUCET_USDC,
        decimals: USDC_DECIMALS,
      }),
      ...(topUp
        ? [getTransferSolInstruction({ source: faucet, destination: owner, amount: SOL_TOP_UP })]
        : []),
    ];
    const tx = await build(this.rpc, faucet, ixs, 60_000);
    await sendWire(this.rpc, tx.wire);
    return {
      signature: tx.signature as string,
      usdc: FAUCET_USDC.toString(),
      sol: (topUp ? SOL_TOP_UP : 0n).toString(),
    };
  }

  /** Claims in the last `windowMs` matching `where`, and when the oldest of them was made. */
  private since(windowMs: number, where: string, args: unknown[], now: number) {
    const row = this.sql
      .exec<{ n: number; first: number | null }>(
        `SELECT COUNT(*) AS n, MIN(at) AS first FROM claims WHERE at > ? AND ${where}`,
        now - windowMs,
        ...args,
      )
      .one();
    return { count: row.n, oldest: row.first ?? now };
  }

  private prune(now: number): void {
    this.sql.exec("DELETE FROM claims WHERE at <= ?", now - 2 * DAY_MS);
  }

  private signer(): Promise<KeyPairSigner> {
    this.signerPromise ??= signerFromSecret(this.env.FAUCET_SECRET_KEY, "FAUCET_SECRET_KEY");
    this.signerPromise.catch(() => {
      this.signerPromise = null;
    });
    return this.signerPromise;
  }
}

function refused(error: string, retryAt: number): ClaimResult {
  return { ok: false, status: 429, error, retryAt };
}
