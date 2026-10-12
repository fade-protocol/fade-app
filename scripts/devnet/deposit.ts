// Tops up the devnet vault from the deployer: mints the test USDC it lacks,
// then requests a deposit. The keeper prices the epoch at its close and
// delivers the shares, as for any liquidity provider.
//
//   AMOUNT_USDC=15000 pnpm devnet:deposit  (needs keys/deployer.json, the test USDC mint authority)
import { getMintToInstruction } from "@solana-program/token";
import {
  fetchQueue,
  fetchVault,
  getRequestDepositInstructionAsync,
} from "../../clients/js/src/generated/fade/index.ts";
import {
  PROGRAM,
  USDC,
  USDC_MINT,
  ata,
  currentSlot,
  depositRequestPda,
  fadePdas,
  fmtUsdc,
  loadDeployer,
  rpc,
  send,
  tokenAmount,
} from "./lib.ts";

const amount = BigInt(process.env["AMOUNT_USDC"] ?? "10000") * USDC;
const cfg = { programAddress: PROGRAM };

async function chainNow(): Promise<bigint> {
  const slot = await currentSlot();
  try {
    const t = await rpc.getBlockTime(slot).send();
    if (t !== null) return BigInt(t);
  } catch {
    // recent slots may not have a block time yet
  }
  return BigInt(Math.floor(Date.now() / 1000));
}

const deployer = await loadDeployer();
const pdas = await fadePdas();
const ownerUsdc = await ata(deployer.address, USDC_MINT);

const held = (await tokenAmount(ownerUsdc)) ?? 0n;
if (held < amount) {
  await send(
    deployer,
    [
      getMintToInstruction({
        mint: USDC_MINT,
        token: ownerUsdc,
        mintAuthority: deployer,
        amount: amount - held,
      }),
    ],
    "mint test USDC",
  );
  console.log(`minted ${fmtUsdc(amount - held)}`);
}

const q = (await fetchQueue(rpc, pdas.queue)).data;
const now = await chainNow();
const epochId = !q.current.live
  ? q.nextEpochId
  : now < q.current.closeTs
    ? q.current.epochId
    : q.next.live
      ? q.next.epochId
      : q.nextEpochId;
const request = await depositRequestPda(epochId, deployer.address);
await send(
  deployer,
  [
    await getRequestDepositInstructionAsync(
      {
        owner: deployer,
        ownerUsdc,
        usdcMint: USDC_MINT,
        request,
        eventAuthority: pdas.eventAuthority,
        program: PROGRAM,
        amount,
      },
      cfg,
    ),
  ],
  "request_deposit",
);
const vault = (await fetchVault(rpc, pdas.vault)).data;
console.log(`requested ${fmtUsdc(amount)} into epoch ${epochId}`);
console.log(`vault now ${fmtUsdc(vault.totalAssets)}; the deposit joins it at the epoch close`);
