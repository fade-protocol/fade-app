// `BeaconChain` over litesvm, for the keeper's beacon loop tests: every
// transaction the engine or a test sends through it is simulated (the
// preflight), executed, and kept, so that the signature list, the statuses,
// `getTransaction`'s JSON (account keys and `emit_cpi!` inner instructions)
// and a program-account scan over every address it has seen answer as an
// RPC would. `refuseV1` makes it refuse version 1 transactions at send, as a
// cluster without SIMD-0385 would.
import {
  getBase58Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signTransactionMessageWithSigners,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type Signature,
} from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import {
  beaconTransactionMessage,
  type AccountRead,
  type TransactionFormat,
} from "../../../clients/js/src/beacon/index.ts";
import {
  SendRefusedError,
  type BeaconChain,
  type SignatureInfo,
  type Status,
} from "../../../apps/keeper/src/beaconChain.ts";
import type { JsonTx } from "../../../apps/keeper/src/beaconPolicy.ts";
import type { BeaconEnv } from "../fade/beaconEnv.ts";

type Landed = {
  signature: Signature;
  slot: bigint;
  keys: Address[];
  version: number;
  meta: TransactionMetadata | null;
  error: string | null;
};

export class SvmChain implements BeaconChain {
  readonly env: BeaconEnv;
  refuseV1 = false;
  /** Accepts every transaction and lands none, as a congested cluster that drops them. */
  blackhole = false;
  /** Transactions the black hole swallowed (sends and resends). */
  swallowed = 0;
  /** Every transaction landed (or failed on chain), oldest first. */
  readonly landed: Landed[] = [];
  /** Version of each transaction sent, by signature, for the tests to read. */
  readonly versions = new Map<Signature, number>();
  private readonly seen = new Set<Address>();
  height = 100n;
  /** Transactions `transaction` answers null for, as an RPC that cannot serve them. */
  readonly unreadable = new Set<Signature>();
  /** `accounts` throws while set, as an RPC failing the engine's round reads. */
  failAccounts = false;
  /**
   * `accounts` answers null for the next `n` reads of each address set, as a
   * load-balanced or lagging RPC whose node does not serve the account yet.
   */
  readonly nullReads = new Map<Address, number>();
  /**
   * Lamports `balance` answers for each address set, from a node one slot
   * behind `accounts`, as a load-balanced RPC serving two requests from
   * nodes at different slots: a read whose `minContextSlot` that node has
   * not reached is refused.
   */
  readonly laggingBalances = new Map<Address, bigint>();
  /**
   * `transaction` answers null for the first `lagReads` reads of each landed
   * transaction, as an RPC that confirms a transaction before it serves it.
   */
  lagReads = 0;
  private readonly reads = new Map<Signature, number>();
  /**
   * While set, `send` forwards the transaction (kept in `forwarded`, landed
   * by `landForwarded`) and then throws a transport error, as an RPC whose
   * HTTP answer is lost after it passed the transaction on.
   */
  forwardThenThrow = false;
  readonly forwarded: string[] = [];
  /**
   * Called with the data of each instruction of a transaction about to land
   * (not a resend of one landed), before its preflight: what the cluster
   * does just before it (a third party's transaction landing first), or a
   * throw that refuses it at send.
   */
  beforeLand: ((data: ReadonlyUint8Array[]) => void | Promise<void>) | null = null;

  constructor(env: BeaconEnv) {
    this.env = env;
  }

  know(...addresses: Address[]) {
    for (const a of addresses) this.seen.add(a);
  }

  async accounts(addresses: readonly Address[]) {
    if (this.failAccounts) throw new Error("getMultipleAccounts: unavailable");
    return {
      slot: this.env.slot(),
      accounts: addresses.map((a) => {
        const left = this.nullReads.get(a) ?? 0;
        if (left <= 0) return this.env.account(a);
        this.nullReads.set(a, left - 1);
        return null;
      }),
    };
  }

  async programAccounts(
    program: Address,
    size: number,
    discriminator: Uint8Array,
    filter?: { offset: number; bytes: Uint8Array },
  ): Promise<AccountRead[]> {
    const out: AccountRead[] = [];
    for (const a of this.seen) {
      const read = this.env.account(a);
      if (!read || read.owner !== program || read.data.length !== size) continue;
      if (!discriminator.every((b, i) => read.data[i] === b)) continue;
      if (filter && !filter.bytes.every((b, i) => read.data[filter.offset + i] === b)) continue;
      out.push(read);
    }
    return out;
  }

  async latestBlockhash() {
    // While dropping transactions, a fresh blockhash each time: a second copy of a
    // step would then be a new transaction, not a resend of the first.
    if (this.blackhole) this.env.svm.client.expireBlockhash();
    return this.env.lifetime();
  }

  async balance(address: Address, minContextSlot?: bigint): Promise<bigint> {
    const lagging = this.laggingBalances.get(address);
    if (lagging === undefined) return this.env.lamports(address);
    if (minContextSlot !== undefined && minContextSlot > this.env.slot() - 1n)
      throw new Error("getBalance: Minimum context slot has not been reached");
    return lagging;
  }

  /**
   * `n` landed transactions naming `keys` (the program, a round) that run
   * nothing of it: what anyone can send for a fee each, as a readonly
   * account of an instruction to another program.
   */
  spam(n: number, keys: Address[]) {
    const b58 = getBase58Decoder();
    for (let i = 0; i < n; i++) {
      const sig = crypto.getRandomValues(new Uint8Array(64));
      this.landed.push({
        signature: b58.decode(sig) as Signature,
        slot: this.env.slot(),
        keys: [...keys],
        version: 1,
        meta: null,
        error: null,
      });
    }
  }

  async blockHeight() {
    return this.height;
  }

  /** Lands every transaction `forwardThenThrow` forwarded, oldest first, without a preflight. */
  async landForwarded() {
    for (const wire of this.forwarded.splice(0)) await this.land(wire, true);
  }

  async send(wire: string, skipPreflight: boolean): Promise<void> {
    if (this.forwardThenThrow) {
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
      const signature = getSignatureFromTransaction(tx);
      if (!this.landed.some((l) => l.signature === signature) && !this.forwarded.includes(wire))
        this.forwarded.push(wire);
      throw new Error("fetch failed: the operation timed out");
    }
    return this.land(wire, skipPreflight);
  }

  private async land(wire: string, skipPreflight: boolean): Promise<void> {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const signature = getSignatureFromTransaction(tx);
    if (this.landed.some((l) => l.signature === signature)) return; // a resend
    if (this.blackhole) {
      this.swallowed++;
      return;
    }
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (this.beforeLand)
      await this.beforeLand(
        "instructionPayloads" in compiled
          ? compiled.instructionPayloads.map((p) => p.instructionData)
          : compiled.instructions.map((ix) => ix.data ?? new Uint8Array()),
      );
    const version = compiled.version === "legacy" ? -1 : compiled.version;
    if (this.refuseV1 && version === 1) {
      throw new SendRefusedError("Transaction version (1) is not supported", []);
    }
    const keys = [...compiled.staticAccounts];
    if (!skipPreflight) {
      const sim = this.env.svm.client.simulateTransaction(tx);
      if (sim instanceof FailedTransactionMetadata) {
        const err = sim.err();
        // litesvm's fieldless errors are numbers; the one an RPC names in its own words here
        const text = typeof err === "number" && err === 7 ? "Blockhash not found" : String(err);
        throw new SendRefusedError(`preflight: ${text}`, sim.meta().logs());
      }
    }
    this.know(...keys);
    this.versions.set(signature, version);
    const result = this.env.svm.client.sendTransaction(tx);
    const slot = this.env.slot();
    if (result instanceof FailedTransactionMetadata) {
      this.landed.push({
        signature,
        slot,
        keys,
        version,
        meta: null,
        error: result.err().toString(),
      });
    } else {
      this.landed.push({ signature, slot, keys, version, meta: result, error: null });
    }
  }

  async statuses(signatures: readonly Signature[]): Promise<Status[]> {
    return signatures.map((s) => {
      const l = this.landed.find((x) => x.signature === s);
      if (!l) return null;
      return { failed: l.error !== null, error: l.error, confirmed: true };
    });
  }

  async signatures(
    program: Address,
    options: { until?: Signature; before?: Signature; limit: number },
  ): Promise<SignatureInfo[]> {
    const newestFirst = [...this.landed].reverse().filter((l) => l.keys.includes(program));
    let start = 0;
    if (options.before) start = newestFirst.findIndex((l) => l.signature === options.before) + 1;
    const out: SignatureInfo[] = [];
    for (const l of newestFirst.slice(start)) {
      if (l.signature === options.until || out.length >= options.limit) break;
      out.push({ signature: l.signature, slot: l.slot, failed: l.error !== null });
    }
    return out;
  }

  async transaction(signature: Signature): Promise<JsonTx | null> {
    const l = this.landed.find((x) => x.signature === signature);
    if (!l || this.unreadable.has(signature)) return null;
    const reads = (this.reads.get(signature) ?? 0) + 1;
    this.reads.set(signature, reads);
    if (reads <= this.lagReads) return null;
    if (!l.meta)
      return {
        slot: l.slot,
        meta: { err: l.error },
        transaction: { message: { accountKeys: l.keys } },
      };
    const b58 = getBase58Decoder();
    return {
      slot: l.slot,
      meta: {
        err: null,
        innerInstructions: l.meta.innerInstructions().map((group) => ({
          instructions: group.map((inner) => {
            const ix = inner.instruction();
            return {
              programIdIndex: ix.programIdIndex(),
              accounts: Array.from(ix.accounts()),
              data: b58.decode(ix.data()),
            };
          }),
        })),
      },
      transaction: { message: { accountKeys: l.keys } },
    };
  }

  /** The cluster advertises v1 (SIMD-0385 active) unless told otherwise, even while `refuseV1`. */
  advertised: TransactionFormat = 1;
  async format(): Promise<TransactionFormat> {
    return this.advertised;
  }

  /** A test's own transaction (a join, a sponsor of its own), through the chain so that its events are seen. */
  async sendInstructions(
    signer: KeyPairSigner,
    instructions: Instruction[],
    format: TransactionFormat = 1,
  ): Promise<Signature> {
    const message = beaconTransactionMessage(format, signer, this.env.lifetime(), instructions, {
      computeUnitLimit: 600_000,
    });
    const tx = await signTransactionMessageWithSigners(
      setTransactionMessageLifetimeUsingBlockhash(this.env.lifetime(), message),
    );
    await this.land(getBase64EncodedWireTransaction(tx), false);
    return getSignatureFromTransaction(tx);
  }
}
