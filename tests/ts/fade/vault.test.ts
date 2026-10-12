// The generated client end to end, in litesvm (npm) under the mainnet feature
// set: initialize, a founding deposit, the strike, and the claim a keeper sends
// on the liquidity provider's behalf. The Rust suites cover the protocol; this
// one proves the committed client matches the program.
import { describe, expect, it } from "vitest";
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  lamports,
  type Address,
} from "@solana/kit";
import {
  FADE_PROGRAM_ADDRESS,
  fetchQueue,
  findConfigPda,
  findVaultPda,
  findQueuePda,
  findShareMintPda,
  getClaimDepositInstructionAsync,
  getInitializeInstructionAsync,
  getRequestDepositInstructionAsync,
  getStrikeEpochInstructionAsync,
  fetchVault,
} from "../../../clients/js/src/generated/fade/index.ts";
import { Svm } from "../utils/svm.ts";

const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC = 1_000_000n;
const bytes = (a: Address) => new Uint8Array(getAddressEncoder().encode(a));

function tokenAccount(mint: Address, owner: Address, amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  d.set(bytes(mint), 0);
  d.set(bytes(owner), 32);
  d.set(getU64Encoder().encode(amount), 64);
  d[108] = 1; // initialised
  return d;
}

function mint(authority: Address, decimals: number): Uint8Array {
  const d = new Uint8Array(82);
  d[0] = 1;
  d.set(bytes(authority), 4);
  d[44] = decimals;
  d[45] = 1;
  return d;
}

async function ata(owner: Address, tokenMint: Address): Promise<Address> {
  const [a] = await getProgramDerivedAddress({
    programAddress: ATA,
    seeds: [bytes(owner), bytes(TOKEN), bytes(tokenMint)],
  });
  return a;
}

describe("fade client (litesvm npm, mainnet features)", () => {
  it("initialize, deposit, strike and claim through the generated client", async () => {
    const svm = new Svm([{ id: FADE_PROGRAM_ADDRESS, name: "fade" }]);
    const deployer = await svm.fundedWallet(100);
    const lp = await svm.fundedWallet(10);
    const keeper = await svm.fundedWallet(10);
    const put = (addr: Address, data: Uint8Array, owner: Address) =>
      svm.client.setAccount({
        address: addr,
        data,
        executable: false,
        lamports: lamports(svm.client.minimumBalanceForRentExemption(BigInt(data.length))),
        programAddress: owner,
        space: BigInt(data.length),
      });

    // The deployer becomes the program's upgrade authority, which initialize requires.
    const [programData] = await getProgramDerivedAddress({
      programAddress: LOADER,
      seeds: [bytes(FADE_PROGRAM_ADDRESS)],
    });
    const pd = svm.client.getAccount(programData);
    if (!pd.exists) throw new Error("programdata");
    const data = new Uint8Array(pd.data);
    data[12] = 1;
    data.set(bytes(deployer.address), 13);
    svm.client.setAccount({ ...pd, data });

    put(USDC_MINT, mint(deployer.address, 6), TOKEN);
    const treasury = address("Treasury11111111111111111111111111111111111");
    put(treasury, tokenAccount(USDC_MINT, deployer.address, 0n), TOKEN);
    const lpUsdc = await ata(lp.address, USDC_MINT);
    put(lpUsdc, tokenAccount(USDC_MINT, lp.address, 1_000n * USDC), TOKEN);

    const [eventAuthority] = await getProgramDerivedAddress({
      programAddress: FADE_PROGRAM_ADDRESS,
      seeds: ["__event_authority"],
    });
    const params = {
      kellyFractionBps: 5_000n,
      censorshipBps: 150n,
      whaleBps: 2_000n,
      utilisationBreakerBps: 7_000n,
      kappaBps: 8_000n,
      drawdownBps: 1_500n,
      minPrice: 25n * USDC,
      maxPrice: 10_000n * USDC,
      minVaultMarginBps: 100n,
      protocolShareBps: 20n,
      maxAppShareBps: 500n,
      tSettleSlots: 150n,
      crankRequestLamports: 50_000n,
      crankSettleLamports: 200_000n,
      epochLengthSeconds: 600n,
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
    await svm.send(deployer, [
      await getInitializeInstructionAsync({
        payer: deployer,
        programData,
        protocolTreasury: treasury,
        eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
        council: deployer.address,
        guardian: deployer.address,
        params,
      }),
    ]);

    const [config] = await findConfigPda();
    const [queue] = await findQueuePda();
    const [vault] = await findVaultPda();
    const [shareMint] = await findShareMintPda();
    const epoch = getU64Encoder().encode(1n);
    const [request] = await getProgramDerivedAddress({
      programAddress: FADE_PROGRAM_ADDRESS,
      seeds: ["deposit", epoch, bytes(lp.address)],
    });
    await svm.send(lp, [
      await getRequestDepositInstructionAsync({
        owner: lp,
        ownerUsdc: lpUsdc,
        config,
        queue,
        vault,
        usdcMint: USDC_MINT,
        request,
        eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
        amount: 500n * USDC,
      }),
    ]);
    const rpc = {
      getAccountInfo: (a: Address) => ({
        send: async () => {
          const acc = svm.client.getAccount(a);
          return {
            value: acc.exists
              ? {
                  data: [Buffer.from(acc.data).toString("base64"), "base64"],
                  executable: acc.executable,
                  lamports: acc.lamports,
                  owner: acc.programAddress,
                  space: acc.space,
                }
              : null,
          };
        },
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = await fetchQueue(rpc as any, queue);
    expect(q.data.current.live).toBe(true);
    expect(q.data.current.epochId).toBe(1n);

    const clock = svm.client.getClock();
    clock.unixTimestamp = q.data.current.closeTs;
    svm.client.setClock(clock);
    const [record] = await getProgramDerivedAddress({
      programAddress: FADE_PROGRAM_ADDRESS,
      seeds: ["epoch", epoch],
    });
    await svm.send(keeper, [
      await getStrikeEpochInstructionAsync({
        caller: keeper,
        config,
        queue,
        vault,
        record,
        usdcMint: USDC_MINT,
        eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
      }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = await fetchVault(rpc as any, vault);
    expect(p.data.totalAssets).toBe(500n * USDC);

    const lpShares = await ata(lp.address, shareMint);
    await svm.send(keeper, [
      await getClaimDepositInstructionAsync({
        caller: keeper,
        config,
        request,
        owner: lp.address,
        record,
        ownerShares: lpShares,
        shareMint,
        rentReceiver: queue,
        eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
      }),
    ]);
    const shares = svm.client.getAccount(lpShares);
    if (!shares.exists) throw new Error("share account");
    const amount = new DataView(shares.data.buffer, shares.data.byteOffset).getBigUint64(64, true);
    expect(amount).toBe(p.data.totalShares);
    expect(svm.client.getAccount(record).exists).toBe(false);
  });
});
