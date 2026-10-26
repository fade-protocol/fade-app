// Read-only probe: does the cluster accept version 1 transactions (SIMD-0385)
// and their larger size (SIMD-0296)? Reads the feature gates, then simulates
// (signatures not verified, nothing sent, nothing signed) four transactions
// on mainnet and devnet: v1 small, v1 above 1 232 bytes, and v0 small and
// above 1 232 bytes as controls. The large ones carry 40 more read-only
// accounts on the transfer, which the System program ignores: the size
// comes from account keys, as a settlement batch's does. The fee payer is ORAO's treasury, read from
// ORAO's network state: a funded system account on both clusters, which a
// simulation without signature verification may name.
//
//   pnpm exec tsx scripts/devnet/tx-format-probe.ts [mainnet|devnet ...]
import {
  AccountRole,
  address,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  ACCOUNT_LOCKS_128_FEATURE,
  TRANSACTION_V1_FEATURE,
  beaconTransactionMessage,
  featureActivationSlot,
  measure,
  type TransactionFormat,
} from "../../clients/js/src/beacon/transaction.ts";

const CLUSTERS: Record<string, string> = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};
const ORAO = address("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function memo(): Instruction {
  return { programAddress: MEMO, accounts: [], data: new TextEncoder().encode("fade tx probe") };
}

async function extraAccounts(n: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const [a] = await getProgramDerivedAddress({
      programAddress: MEMO,
      seeds: [new TextEncoder().encode(`fade-probe-${i}`)],
    });
    out.push({ address: a, role: AccountRole.READONLY });
  }
  return out;
}

async function probe(name: string, url: string) {
  const rpc = createSolanaRpc(url);
  const v1 = await featureActivationSlot(rpc, TRANSACTION_V1_FEATURE);
  const locks128 = await featureActivationSlot(rpc, ACCOUNT_LOCKS_128_FEATURE);
  const [networkState] = await getProgramDerivedAddress({
    programAddress: ORAO,
    seeds: [new TextEncoder().encode("orao-vrf-network-configuration")],
  });
  const state = await rpc.getAccountInfo(networkState, { encoding: "base64" }).send();
  if (!state.value) throw new Error(`${name}: ORAO network state missing`);
  const data = getBase64Encoder().encode(state.value.data[0]);
  const treasury: Address = getAddressDecoder().decode(data.slice(40, 72));
  const payer = createNoopSigner(treasury);
  const { value: lifetime } = await rpc.getLatestBlockhash().send();
  const extra = await extraAccounts(40);
  const cases: { label: string; format: TransactionFormat; extra: number }[] = [
    { label: "v1, small", format: 1, extra: 0 },
    { label: "v1, above 1 232 bytes", format: 1, extra: 40 },
    { label: "v0, small (control)", format: 0, extra: 0 },
    { label: "v0, above 1 232 bytes (control)", format: 0, extra: 40 },
  ];
  const results = [];
  for (const c of cases) {
    const message = beaconTransactionMessage(
      c.format,
      payer,
      lifetime,
      [
        (() => {
          const t = getTransferSolInstruction({ source: payer, destination: treasury, amount: 0n });
          return { ...t, accounts: [...t.accounts, ...extra.slice(0, c.extra)] };
        })(),
        memo(),
      ],
      { computeUnitLimit: 400_000 },
    );
    const size = measure(message);
    const wire = getBase64EncodedWireTransaction(compileTransaction(message));
    let outcome: string;
    try {
      const { value } = await rpc
        .simulateTransaction(wire, {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: true,
        })
        .send();
      outcome = value.err
        ? `simulated, failed: ${JSON.stringify(value.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`
        : `simulated, succeeded (${value.unitsConsumed} units)`;
    } catch (e) {
      outcome = `refused by the RPC: ${(e as Error).message.split("\n")[0]}`;
    }
    results.push({ case: c.label, bytes: size.bytes, locks: size.locks, outcome });
  }
  return {
    cluster: name,
    slot: (await rpc.getSlot().send()).toString(),
    version: (await rpc.getVersion().send())["solana-core"],
    transactionV1ActivatedAt: v1?.toString() ?? null,
    accountLocks128ActivatedAt: locks128?.toString() ?? null,
    results,
  };
}

const wanted = process.argv.slice(2);
for (const name of wanted.length ? wanted : Object.keys(CLUSTERS)) {
  const url = CLUSTERS[name];
  if (!url) throw new Error(`unknown cluster ${name}`);
  console.log(JSON.stringify(await probe(name, url), null, 1));
}
