// LiteSVM harness for the TypeScript tests. Mirrors crates/fade-testkit: the
// program under test is loaded from SBF_OUT_DIR, and every transaction is built
// with @solana/kit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { FailedTransactionMetadata, FeatureSet, LiteSVM, type TransactionMetadata } from "litesvm";

export const FEATURES_DIR = join(process.cwd(), "tests", "fixtures", "features");

/** The mainnet feature set from tests/fixtures/features/mainnet.json (see scripts/sync-features.py). */
export function mainnetFeatureSet(): FeatureSet {
  const fixture = JSON.parse(readFileSync(join(FEATURES_DIR, "mainnet.json"), "utf8")) as {
    active: { id: string; activated_at: number }[];
  };
  const set = new FeatureSet();
  for (const f of fixture.active) set.activate(addressToBytes(f.id), BigInt(f.activated_at));
  return set;
}

export function addressToBytes(value: string): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(address(value)));
}

export function programPath(name: string): string {
  const dir = process.env["SBF_OUT_DIR"];
  if (!dir)
    throw new Error("SBF_OUT_DIR is not set — run through scripts/toolchain/with-toolchain.sh");
  return join(dir, `${name}.so`);
}

export class SvmTransactionError extends Error {
  readonly failure: FailedTransactionMetadata;
  constructor(failure: FailedTransactionMetadata) {
    super(`transaction failed: ${failure.err().toString()}\n${failure.meta().logs().join("\n")}`);
    this.failure = failure;
  }
}

export class Svm {
  readonly client: LiteSVM;

  constructor(
    programs: { id: Address; name: string }[],
    featureSet: FeatureSet = mainnetFeatureSet(),
  ) {
    this.client = new LiteSVM().withFeatureSet(featureSet);
    for (const p of programs) this.client.addProgramFromFile(p.id, programPath(p.name));
  }

  async fundedWallet(sol = 10): Promise<KeyPairSigner> {
    const signer = await generateKeyPairSigner();
    this.client.airdrop(signer.address, lamports(BigInt(sol) * 1_000_000_000n));
    return signer;
  }

  /** Sends one transaction and throws (with logs) on failure. */
  async send(feePayer: KeyPairSigner, instructions: Instruction[]): Promise<TransactionMetadata> {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => this.client.setTransactionMessageLifetimeUsingLatestBlockhash(m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    const result = this.client.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata) throw new SvmTransactionError(result);
    return result;
  }
}
