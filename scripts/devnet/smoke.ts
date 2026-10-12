// Phase 0 devnet spike, against the deployed program and the real ORAO VRF:
//   1. ping                — the deployed binary executes (v0 then v3 in place)
//   2. fund_pda / transfer — a system-owned PDA pays through invoke_signed
//   3. orao_request        — the PDA pays ORAO request_v2; we wait for fulfilment,
//                            check the account layout and the rent refund, and
//                            time the fulfilment in slots.
//
//   pnpm devnet:smoke  (needs keys/deployer.json funded on devnet)
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64Encoder,
  getAddressDecoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  TOOLCHAIN_SMOKE_PROGRAM_ADDRESS,
  findNetworkStatePda,
  findRequestPda,
  findVrfPayerPda,
  getFundPdaInstructionAsync,
  getOraoRequestInstructionAsync,
  getPdaTransferInstructionAsync,
  getPingInstruction,
} from "../../clients/js/src/generated/toolchain_smoke/index.ts";

const RPC_URL = process.env["RPC_URL"] ?? "https://api.devnet.solana.com";
const ORAO = address("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
const SLOT_HASHES = address("SysvarS1otHashes111111111111111111111111111");
const RANDOMNESS_V2_DISCRIMINATOR = [139, 239, 184, 215, 227, 86, 191, 226];

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, "ws"));
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

async function send(payer: KeyPairSigner, instructions: Instruction[], label: string) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(tx);
  await sendAndConfirm(tx, { commitment: "confirmed" });
  const sig = getSignatureFromTransaction(tx);
  const slot = Number(await rpc.getSlot({ commitment: "confirmed" }).send());
  console.log(`${label}: ${sig} (slot ~${slot})`);
  return slot;
}

async function accountData(addr: Address): Promise<Uint8Array | null> {
  const { value } = await rpc
    .getAccountInfo(addr, { encoding: "base64", commitment: "confirmed" })
    .send();
  return value ? new Uint8Array(getBase64Encoder().encode(value.data[0])) : null;
}

async function main() {
  const deployer = await createKeyPairSignerFromBytes(
    new Uint8Array(JSON.parse(readFileSync("keys/deployer.json", "utf8"))),
  );
  console.log(`deployer ${deployer.address} on ${RPC_URL}`);
  const [eventAuthority] = await getProgramDerivedAddress({
    programAddress: TOOLCHAIN_SMOKE_PROGRAM_ADDRESS,
    seeds: ["__event_authority"],
  });
  const [vrfPayer] = await findVrfPayerPda({ payer: deployer.address });

  // 1. ping
  await send(
    deployer,
    [
      getPingInstruction({
        slotHashes: SLOT_HASHES,
        eventAuthority,
        program: TOOLCHAIN_SMOKE_PROGRAM_ADDRESS,
      }),
    ],
    "ping",
  );

  // 2. PDA pays via invoke_signed
  await send(
    deployer,
    [
      await getFundPdaInstructionAsync({ payer: deployer, lamports: 10_000_000n }),
      await getPdaTransferInstructionAsync({
        payer: deployer,
        recipient: deployer.address,
        lamports: 4_000_000n,
      }),
    ],
    "fund_pda + pda_transfer",
  );

  // 3. ORAO request paid by the PDA
  const [networkState] = await findNetworkStatePda({ programAddress: ORAO });
  const state = await accountData(networkState);
  if (!state) throw new Error(`ORAO network state ${networkState} not found — wrong cluster?`);
  const treasury = getAddressDecoder().decode(state.subarray(40, 72));
  const requestFee = new DataView(state.buffer, state.byteOffset + 72, 8).getBigUint64(0, true);
  console.log(
    `ORAO network_state ${networkState}: treasury ${treasury}, request_fee ${requestFee} lamports`,
  );

  const seed = new Uint8Array(randomBytes(32));
  const [request] = await findRequestPda({ seed }, { programAddress: ORAO });
  const pendingRent = 4_455_160n; // rent of the 749-byte pending account, verified on mainnet
  const before = await rpc.getBalance(vrfPayer, { commitment: "confirmed" }).send();
  const requestSlot = await send(
    deployer,
    [
      await getFundPdaInstructionAsync({
        payer: deployer,
        lamports: requestFee + pendingRent + 100_000n,
      }),
      await getOraoRequestInstructionAsync({
        payer: deployer,
        treasury,
        oraoProgram: ORAO,
        networkState,
        request,
        seed,
      }),
    ],
    "orao_request",
  );
  console.log(`request account ${request}, client should be vrf_payer ${vrfPayer}`);

  // wait for fulfilment: the account shrinks from 749 to 137 bytes, tag byte 8 becomes 1
  const started = Date.now();
  for (;;) {
    const data = await accountData(request);
    if (!data) throw new Error("request account vanished");
    if (data.length === 137 && data[8] === 1) {
      const slot = Number(await rpc.getSlot({ commitment: "confirmed" }).send());
      const disc = Array.from(data.subarray(0, 8));
      const client = getAddressDecoder().decode(data.subarray(9, 41));
      const seedBack = data.subarray(41, 73);
      const randomness = data.subarray(73, 137);
      const after = await rpc.getBalance(vrfPayer, { commitment: "confirmed" }).send();
      console.log(
        `fulfilled after ~${slot - requestSlot} slots (${((Date.now() - started) / 1000).toFixed(1)} s wall clock)`,
      );
      console.log(
        `  discriminator ok: ${disc.every((b, i) => b === RANDOMNESS_V2_DISCRIMINATOR[i])}`,
      );
      console.log(`  client == vrf_payer: ${client === vrfPayer}`);
      console.log(`  seed round-trips: ${seedBack.every((b, i) => b === seed[i])}`);
      console.log(`  randomness non-zero: ${randomness.some((b) => b !== 0)}`);
      console.log(
        `  vrf_payer balance before ${before.value}, after ${after.value} (refund ${after.value - before.value + requestFee + pendingRent + 100_000n - (requestFee + pendingRent + 100_000n)} → net cost ${before.value + requestFee + pendingRent + 100_000n - after.value} lamports)`,
      );
      return;
    }
    if (Date.now() - started > 120_000)
      throw new Error(`not fulfilled after 120 s (length ${data.length}, tag ${data[8]})`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
