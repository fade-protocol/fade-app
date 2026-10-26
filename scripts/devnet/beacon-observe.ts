// What a devnet transaction moved, read from the cluster: the accounts it
// may touch read at one slot before it and at its slot or later after it,
// then compared with what scripts/devnet/beacon-checks.ts predicts, for the
// migration rehearsal (migrate-rehearsal.ts).
import { getBase64Encoder, type Address } from "@solana/kit";
import {
  mismatches,
  seenBetween,
  type AccountState,
  type Expected,
  type JsonTransaction,
  type Snapshot,
} from "./beacon-checks.ts";
import { USDC_MINT, rpc, transactionMeta, type Sent } from "./lib.ts";

/**
 * `addresses` read at one slot (one `getMultipleAccounts` per 100), at or
 * after `minContextSlot`: the state before a transaction is read once the
 * previous one is confirmed, the state after at the transaction's slot or
 * later. Only the script's own transactions write these accounts.
 */
export async function snapshot(
  addresses: Iterable<Address>,
  minContextSlot?: bigint,
): Promise<{ state: Snapshot; slot: bigint }> {
  const list = [...new Set(addresses)];
  const state = new Map<Address, AccountState>();
  let slot = 0n;
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const { context, value } = await rpc
      .getMultipleAccounts(chunk, {
        encoding: "base64",
        commitment: "confirmed",
        ...(minContextSlot === undefined ? {} : { minContextSlot }),
      })
      .send();
    slot = slot === 0n || context.slot < slot ? context.slot : slot;
    chunk.forEach((a, k) => {
      const v = value[k];
      state.set(
        a,
        v
          ? {
              lamports: v.lamports,
              owner: v.owner,
              data: new Uint8Array(getBase64Encoder().encode(v.data[0])),
            }
          : null,
      );
    });
  }
  return { state, slot };
}

/**
 * Reads the accounts of `before` after `sent` and checks every lamport and
 * token delta, the vault's books and counters, each listed integrator's
 * books and what the instruction stored against what `expect` predicts from
 * the state before and the landed transaction (its fee, its slot and block
 * time): any unit of difference throws, naming the account. Every
 * integrator the prediction moves must be listed, or the check fails.
 */
export async function checkMoved<E extends Expected>(
  feePayer: Address,
  vault: Address,
  what: string,
  sent: Sent,
  before: { state: Snapshot; slot: bigint },
  expect: (fee: bigint, tx: JsonTransaction & { slot: bigint; blockTime: bigint | null }) => E,
  integrators: Iterable<Address> = [],
): Promise<{ expected: E; tx: JsonTransaction; after: Snapshot }> {
  if (!(before.slot < sent.slot))
    throw new Error(`${what}: the state before was not read before the transaction`);
  const tx = (await transactionMeta(sent.signature)) as unknown as JsonTransaction | null;
  if (!tx?.meta) throw new Error(`${what}: transaction ${sent.signature} not found`);
  if (tx.transaction.message.accountKeys[0] !== feePayer)
    throw new Error(`${what}: paid by another fee payer`);
  const landed = {
    ...tx,
    slot: BigInt(tx.slot ?? sent.slot),
    blockTime: tx.blockTime == null ? null : BigInt(tx.blockTime),
  };
  const expected = expect(BigInt(tx.meta.fee), landed);
  const after = await snapshot(before.state.keys(), sent.slot);
  const found = mismatches(
    expected,
    seenBetween(before.state, after.state, vault, integrators, USDC_MINT),
  );
  if (found.length) throw new Error(`${what}: moved other than predicted\n  ${found.join("\n  ")}`);
  return { expected, tx, after: after.state };
}
