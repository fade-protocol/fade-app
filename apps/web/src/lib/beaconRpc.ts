// The small-ticket demo's reads over the app's RPC: accounts at `confirmed`,
// all of one read in one `getMultipleAccounts` (one slot), and the end of a
// ticket that was paid out by someone else, read from its last transaction;
// and the flow's dependencies in the app (`appFlowDeps`).
import { getBase58Encoder, getBase64Encoder, type Address, type Signature } from "@solana/kit";
import type { AccountRead } from "../../../../clients/js/src/beacon/index.ts";
import { getJsonTransaction } from "../../../../clients/js/src/transactionFetch.ts";
import { returnedEventOf, settledEventOf, type AccountReader } from "./beacon";
import type { FlowDeps } from "./beaconFlow";
import { wakeBeacon } from "./keeper";
import { rpc, sleep } from "./rpc";
import { send } from "./tx";

/** `getMultipleAccounts` answers at most 100 addresses a call. */
const MAX_ACCOUNTS = 100;

export const rpcReader: AccountReader = {
  // A node behind `minContextSlot` refuses the read (it throws), and the flow reads again.
  async accounts(addresses, minContextSlot) {
    if (addresses.length > MAX_ACCOUNTS) throw new Error("too many accounts in one read");
    const { value } = await rpc
      .getMultipleAccounts([...addresses], {
        encoding: "base64",
        commitment: "confirmed",
        ...(minContextSlot !== undefined ? { minContextSlot } : {}),
      })
      .send();
    return value.map((v, i): AccountRead | null =>
      v
        ? {
            address: addresses[i]!,
            owner: v.owner,
            data: new Uint8Array(getBase64Encoder().encode(v.data[0])),
          }
        : null,
    );
  },
  async slot(minContextSlot) {
    return rpc
      .getSlot({
        commitment: "confirmed",
        ...(minContextSlot !== undefined ? { minContextSlot } : {}),
      })
      .send();
  },
  async rent(space) {
    return rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
  },
  async lamports(address) {
    return (await rpc.getBalance(address, { commitment: "confirmed" }).send()).value;
  },
};

type JsonTx = {
  meta: {
    err: unknown;
    innerInstructions?:
      readonly { instructions: readonly { programIdIndex: number; data: string }[] }[] | null;
  } | null;
  transaction: { message: { accountKeys: readonly string[] } };
};

/**
 * A transaction as JSON, whatever its version: a keeper sends version 1
 * transactions where the cluster takes them.
 */
const jsonTx = (signature: Signature) =>
  getJsonTransaction<JsonTx>(rpc, signature, "confirmed").catch(() => null);

/** The data of every inner instruction to `program` in `tx`: the program's event authority alone emits events there. */
function* programInner(tx: JsonTx, program: Address): Generator<Uint8Array> {
  const keys = tx.transaction.message.accountKeys;
  const b58 = getBase58Encoder();
  for (const group of tx.meta?.innerInstructions ?? [])
    for (const ix of group.instructions)
      if (keys[ix.programIdIndex] === program) yield new Uint8Array(b58.encode(ix.data));
}

/**
 * How `ticket` was paid out, from the `RoundTicketSettled` event of its
 * transactions (newest first), or null if none is readable. Only inner
 * instructions to `program` are read: the program's event authority alone
 * emits them. For display only; nothing is moved on it.
 */
export async function findSettled(
  program: Address,
  ticket: Address,
): Promise<{ outcome: number; payout: bigint; parked: boolean; signature: Signature } | null> {
  const sigs = await rpc
    .getSignaturesForAddress(ticket, { limit: 10, commitment: "confirmed" })
    .send();
  for (const s of sigs) {
    if (s.err !== null) continue;
    const tx = await jsonTx(s.signature);
    if (!tx?.meta || tx.meta.err) continue;
    for (const data of programInner(tx, program)) {
      const e = settledEventOf(data, ticket);
      if (e) return { ...e, signature: s.signature };
    }
  }
  return null;
}

/**
 * Whether the landed close `signature` refunded `ticket`'s price, from its
 * `RoundTicketReturned` event, or null if the transaction or the event is
 * not readable.
 */
export async function findReturned(
  program: Address,
  ticket: Address,
  signature: Signature,
): Promise<{ refunded: boolean; parked: boolean } | null> {
  const tx = await jsonTx(signature);
  if (!tx?.meta || tx.meta.err) return null;
  for (const data of programInner(tx, program)) {
    const e = returnedEventOf(data, ticket);
    if (e) return e;
  }
  return null;
}

/**
 * The flow's dependencies in the app: the RPC, `send`, which simulates before it signs, and
 * the keeper's wake after a join.
 */
export const appFlowDeps: FlowDeps = {
  reader: rpcReader,
  send: (signer, instructions, label, units, onSigned) =>
    send(signer, instructions, label, units, onSigned ? { onSigned } : {}),
  findSettled,
  findReturned,
  sleep,
  now: () => Date.now(),
  joined: () => wakeBeacon(),
};
