// A kit signer backed by a wallet that signs @solana/web3.js v1 transactions
// (Reown AppKit's Solana provider). The kit transaction goes to the wallet as
// its wire bytes, read back as a web3.js VersionedTransaction; whatever the
// wallet returns comes back the same way. The wallet signs only: the app still
// sends and confirms through its own RPC (lib/tx.ts).
import {
  address,
  assertIsTransactionWithinSizeLimit,
  bytesEqual,
  getCompiledTransactionMessageDecoder,
  getTransactionCodec,
  getTransactionLifetimeConstraintFromCompiledTransactionMessage,
  type TransactionModifyingSigner,
} from "@solana/kit";
import { VersionedTransaction } from "@solana/web3.js";

/** The one capability the bridge needs from a wallet provider. */
export type VersionedTransactionSigner = {
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
};

const codec = getTransactionCodec();

/** Kit wire bytes in, the wallet's signed wire bytes out. */
export async function signWireTransaction(
  provider: VersionedTransactionSigner,
  wire: Uint8Array,
): Promise<Uint8Array> {
  const signed = await provider.signTransaction(VersionedTransaction.deserialize(wire));
  return signed.serialize();
}

/**
 * A modifying signer: wallets may legitimately rewrite the message (Phantom
 * can add a priority fee, for instance), so the transaction the wallet returns
 * replaces the one the app built, as @solana/react's Wallet Standard signer
 * does. The lifetime is carried over when the blockhash is unchanged.
 */
export function createBridgeSigner(
  owner: string,
  provider: VersionedTransactionSigner,
): TransactionModifyingSigner {
  return {
    address: address(owner),
    async modifyAndSignTransactions(transactions, config = {}) {
      config.abortSignal?.throwIfAborted();
      if (transactions.length === 0) return [];
      const [transaction] = transactions;
      if (!transaction || transactions.length > 1)
        throw new Error("the wallet signs one transaction at a time");
      const signed = codec.decode(
        await signWireTransaction(provider, new Uint8Array(codec.encode(transaction))),
      );
      assertIsTransactionWithinSizeLimit(signed);
      const existing = "lifetimeConstraint" in transaction ? transaction.lifetimeConstraint : null;
      const compiled = getCompiledTransactionMessageDecoder().decode(signed.messageBytes);
      const keepsLifetime =
        existing !== null &&
        (bytesEqual(signed.messageBytes, transaction.messageBytes) ||
          compiled.lifetimeToken ===
            ("blockhash" in existing ? existing.blockhash : existing.nonce));
      const lifetimeConstraint = keepsLifetime
        ? existing
        : await getTransactionLifetimeConstraintFromCompiledTransactionMessage(compiled);
      return Object.freeze([{ ...signed, lifetimeConstraint }]);
    },
  };
}
