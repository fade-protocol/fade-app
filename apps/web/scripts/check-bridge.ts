// Checks the wallet bridge (src/wallet/bridge.ts) without a wallet: a fake
// provider signs @solana/web3.js VersionedTransactions with a local keypair,
// the way Reown's Solana provider does, and the kit transaction must come back
// carrying a valid signature. A tampered signature must fail every check.
//
//   pnpm --filter ./apps/web exec tsx scripts/check-bridge.ts
//
// Then devnet confirms it: simulating with `sigVerify: true` from the fresh,
// unfunded fee payer fails on the missing account, which the runtime checks
// only after the signatures, while the tampered copy fails on the signature.
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  signTransactionMessageWithSigners,
  verifySignature,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { COMPUTE_BUDGET } from "../src/lib/config";
import { rpc } from "../src/lib/rpc";
import { createBridgeSigner, type VersionedTransactionSigner } from "../src/wallet/bridge";

let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

const keypair = Keypair.generate();
const kitKeys = await createKeyPairSignerFromBytes(keypair.secretKey);
const owner = keypair.publicKey.toBase58();

/** Signs in place, like an injected wallet returning the signed transaction. */
const injected: VersionedTransactionSigner = {
  async signTransaction(tx) {
    tx.sign([keypair]);
    return VersionedTransaction.deserialize(tx.serialize());
  },
};
/** Returns only a signature, which Reown's WalletConnect provider adds itself. */
const walletConnect: VersionedTransactionSigner = {
  async signTransaction(tx) {
    const signature = await signBytes(
      kitKeys.keyPair.privateKey,
      new Uint8Array(tx.message.serialize()),
    );
    tx.addSignature(new PublicKey(owner), signature);
    return tx;
  },
};

/** Rewrites the message before signing (as a wallet adding its own fee might). */
const OTHER_BLOCKHASH = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const rewriting: VersionedTransactionSigner = {
  async signTransaction(tx) {
    tx.message.recentBlockhash = OTHER_BLOCKHASH;
    tx.sign([keypair]);
    return tx;
  },
};

const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();

async function signedWith(provider: VersionedTransactionSigner) {
  const signer = createBridgeSigner(owner, provider);
  const limit = new Uint8Array([2, 0x40, 0x0d, 0x03, 0x00]); // SetComputeUnitLimit 200_000
  return signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) =>
        appendTransactionMessageInstructions([{ programAddress: COMPUTE_BUDGET, data: limit }], m),
    ),
  );
}

const blockhashOf = (tx: { lifetimeConstraint: object }) =>
  "blockhash" in tx.lifetimeConstraint ? tx.lifetimeConstraint.blockhash : null;

const verify = (tx: Transaction) => {
  const sig = tx.signatures[kitKeys.address];
  return sig ? verifySignature(kitKeys.keyPair.publicKey, sig, tx.messageBytes) : false;
};

const tamper = (tx: Transaction): Transaction => {
  const sig = new Uint8Array(tx.signatures[kitKeys.address]!);
  sig[0] = sig[0]! ^ 1;
  return { ...tx, signatures: { ...tx.signatures, [kitKeys.address]: sig as SignatureBytes } };
};

async function simulateVerified(tx: Transaction) {
  const { value } = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(tx), {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: true,
    })
    .send();
  return JSON.stringify(value.err);
}

for (const [name, provider] of [
  ["injected wallet", injected],
  ["WalletConnect wallet", walletConnect],
] as const) {
  const tx = await signedWith(provider);
  check(Boolean(getSignatureFromTransaction(tx)), `${name}: kit reads the fee payer signature`);
  check(await verify(tx), `${name}: the ed25519 signature verifies over the kit message`);
  check(blockhashOf(tx) === latest.blockhash, `${name}: the blockhash lifetime is kept`);
  check(!(await verify(tamper(tx))), `${name}: a tampered signature does not verify`);
  check(
    getTransactionEncoder().encode(tx).length ===
      VersionedTransaction.deserialize(
        new Uint8Array(getTransactionEncoder().encode(tx)),
      ).serialize().length,
    `${name}: the wire bytes round-trip through web3.js`,
  );
  const real = await simulateVerified(tx);
  const bad = await simulateVerified(tamper(tx));
  check(
    real.includes("AccountNotFound"),
    `${name}: devnet passes the signature check (unfunded payer: ${real})`,
  );
  check(
    bad.includes("SignatureFailure"),
    `${name}: devnet rejects the tampered signature (${bad})`,
  );
}

{
  const tx = await signedWith(rewriting);
  check(await verify(tx), "rewriting wallet: the signature verifies over the wallet's message");
  check(
    blockhashOf(tx) === OTHER_BLOCKHASH,
    "rewriting wallet: the lifetime is read back from the wallet's message",
  );
}

process.exit(failed ? 1 : 0);
