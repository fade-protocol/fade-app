// Initialises the devnet deployment, once: council = guardian = the deployer,
// the protocol treasury a USDC account the deployer owns, and the parameters
// of the Technical Specification §2 (RiskParams::SPEC) except a short epoch.
// Re-running it on an initialised deployment only prints the state.
//
//   pnpm devnet:init  (needs keys/deployer.json, the program's upgrade authority)
import { createAddressWithSeed, type Address } from "@solana/kit";
import { getCreateAccountWithSeedInstruction } from "@solana-program/system";
import { getInitializeAccount3Instruction } from "@solana-program/token";
import {
  fetchMaybeConfig,
  getInitializeInstructionAsync,
  type RiskParamsArgs,
} from "../../clients/js/src/generated/fade/index.ts";
import {
  PROGRAM,
  TOKEN,
  USDC,
  USDC_MINT,
  accountOwner,
  explorerAddress,
  fadePdas,
  fmtSol,
  loadDeployer,
  rentExempt,
  rpc,
  send,
  solBalance,
} from "./lib.ts";

/** RiskParams::SPEC (programs/fade/src/state.rs), with one devnet change. */
const DEVNET_PARAMS: RiskParamsArgs = {
  kellyFractionBps: 5_000n,
  censorshipBps: 150n,
  whaleBps: 2_000n,
  utilisationBreakerBps: 7_000n,
  kappaBps: 8_000n,
  drawdownBps: 1_500n,
  minPrice: 7_500_000n,
  maxPrice: 10_000n * USDC,
  minVaultMarginBps: 100n,
  protocolShareBps: 20n,
  maxAppShareBps: 500n,
  tSettleSlots: 150n,
  crankRequestLamports: 50_000n,
  crankSettleLamports: 200_000n,
  // Devnet only: 120 s instead of the specified 600 s, so that a deposit,
  // its strike and its claim fit in a two-minute run. Everything else is SPEC.
  epochLengthSeconds: 120n,
  claimFeeLamports: 200_000n,
  strikeFeeLamports: 200_000n,
  strikeRewardLamports: 200_000n,
  fundTargetLamports: 50_000_000n,
  minDeposit: USDC,
  minWithdrawShares: 1_000_000_000n,
  minFirstDeposit: 100n * USDC,
  creditEnabled: false,
  creditBase: 0n,
  creditRateBps: 0n,
};

/** The treasury: a plain token account at an address derived from the deployer, so no extra key is needed. */
const TREASURY_SEED = "fade-treasury";
async function treasuryAddress(deployer: Address) {
  return createAddressWithSeed({
    baseAddress: deployer,
    programAddress: TOKEN,
    seed: TREASURY_SEED,
  });
}

async function main() {
  const deployer = await loadDeployer();
  const pdas = await fadePdas();
  const before = await solBalance(deployer.address);
  console.log(`deployer ${deployer.address}: ${fmtSol(before)}`);
  console.log(`program  ${PROGRAM}`);

  const existing = await fetchMaybeConfig(rpc, pdas.config);
  if (existing.exists) {
    const c = existing.data;
    console.log(`already initialised: config ${pdas.config}`);
    console.log(`  council ${c.council}, guardian ${c.guardian}`);
    console.log(
      `  treasury ${c.protocolTreasury}, mint ${c.usdcMint}, pause flags ${c.pauseFlags}`,
    );
    console.log(
      `  epoch ${c.params.epochLengthSeconds} s, min price ${c.params.minPrice}, T_SETTLE ${c.params.tSettleSlots} slots`,
    );
    return;
  }

  const treasury = await treasuryAddress(deployer.address);
  if ((await accountOwner(treasury)) !== TOKEN) {
    await send(
      deployer,
      [
        getCreateAccountWithSeedInstruction({
          payer: deployer,
          newAccount: treasury,
          baseAccount: deployer,
          base: deployer.address,
          seed: TREASURY_SEED,
          amount: await rentExempt(165),
          space: 165n,
          programAddress: TOKEN,
        }),
        getInitializeAccount3Instruction({
          account: treasury,
          mint: USDC_MINT,
          owner: deployer.address,
        }),
      ],
      "create protocol treasury",
    );
  }

  await send(
    deployer,
    [
      await getInitializeInstructionAsync(
        {
          payer: deployer,
          fadeProgram: PROGRAM,
          programData: pdas.programData,
          usdcMint: USDC_MINT,
          protocolTreasury: treasury,
          eventAuthority: pdas.eventAuthority,
          program: PROGRAM,
          council: deployer.address,
          guardian: deployer.address,
          params: DEVNET_PARAMS,
        },
        { programAddress: PROGRAM },
      ),
    ],
    "initialize",
  );

  const config = await fetchMaybeConfig(rpc, pdas.config);
  if (!config.exists) throw new Error("config missing after initialize");
  if (config.data.council !== deployer.address || config.data.protocolTreasury !== treasury)
    throw new Error("config does not hold what initialize was given");
  const after = await solBalance(deployer.address);
  console.log(`initialised. config ${explorerAddress(pdas.config)}`);
  for (const [k, v] of Object.entries(pdas)) console.log(`  ${k.padEnd(15)} ${v}`);
  console.log(`  treasury        ${treasury}`);
  console.log(`SOL spent: ${fmtSol(before - after)} (includes the 0.05 SOL strike fund)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
