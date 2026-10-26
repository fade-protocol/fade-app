// A founded Fade vault in litesvm (npm, mainnet feature set) for the beacon
// client tests: the program, the ORAO stand-in at ORAO's address and its
// network state, a USDC mint the tests control, the beacon turned on, and a
// 100 000 USDC founding deposit struck. Every transaction is simulated
// before it is sent, and built by the client's own `beaconTransactionMessage`
// in the format the test picks.
import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getTransactionSize,
  getU64Encoder,
  lamports,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Blockhash,
  type Decoder,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import {
  FADE_PROGRAM_ADDRESS,
  findConfigPda,
  findQueuePda,
  findVaultPda,
  getClaimDepositInstructionAsync,
  getInitializeInstructionAsync,
  getQueueDecoder,
  getRequestDepositInstructionAsync,
  getSetPauseFlagsInstructionAsync,
  getStrikeEpochInstructionAsync,
  getVaultDecoder,
  type OutcomeArgs,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  ORAO_VRF_PROGRAM_ADDRESS,
  SLOT_HASHES_SYSVAR,
  beaconTransactionMessage,
  findEventAuthorityPda,
  findOraoNetworkStatePda,
  sha256,
  type AccountRead,
  type TransactionFormat,
} from "../../../clients/js/src/beacon/index.ts";
import { Svm, SvmTransactionError } from "../utils/svm.ts";

export const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const SYSVAR_OWNER = address("Sysvar1111111111111111111111111111111111111");
export const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDC = 1_000_000n;
export const ORAO_FEE = 500_000n;
const bytes = (a: Address) => new Uint8Array(getAddressEncoder().encode(a));

/** A coin flip: half the time 1.9×, half nothing; a 5 % margin. */
export const COIN_FLIP: OutcomeArgs[] = [
  { p: 500_000_000n, m: 19_000n },
  { p: 500_000_000n, m: 0n },
];
/** Three outcomes: 2×, 0.5×, nothing. */
export const THREE_WAY: OutcomeArgs[] = [
  { p: 300_000_000n, m: 20_000n },
  { p: 600_000_000n, m: 5_000n },
  { p: 100_000_000n, m: 0n },
];

/** `RiskParams::SPEC`, as tests/ts/fade/vault.test.ts initializes with. */
export const SPEC_PARAMS = {
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
  beaconMinPrice: 500_000n,
  beaconThreshold: 8_640_000n,
  roundK: 1n,
  tickSlots: 37n,
  refundSlots: 1_715n,
  crankRoundSettleLamports: 20_000n,
};

function tokenAccountData(mint: Address, owner: Address, amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  d.set(bytes(mint), 0);
  d.set(bytes(owner), 32);
  d.set(getU64Encoder().encode(amount), 64);
  d[108] = 1; // initialised
  return d;
}

export type Sent = { meta: TransactionMetadata; units: bigint; bytes: number };

export class BeaconEnv {
  readonly svm: Svm;
  readonly deployer: KeyPairSigner;
  readonly keeper: KeyPairSigner;
  readonly treasury: Address;
  readonly oraoTreasury: Address;
  readonly eventAuthority: Address;

  private constructor(
    svm: Svm,
    deployer: KeyPairSigner,
    keeper: KeyPairSigner,
    treasury: Address,
    oraoTreasury: Address,
    eventAuthority: Address,
  ) {
    this.svm = svm;
    this.deployer = deployer;
    this.keeper = keeper;
    this.treasury = treasury;
    this.oraoTreasury = oraoTreasury;
    this.eventAuthority = eventAuthority;
  }

  /** `params` defaults to `SPEC_PARAMS`; a test may start the vault on other beacon terms. */
  static async create(params: typeof SPEC_PARAMS = SPEC_PARAMS): Promise<BeaconEnv> {
    const svm = new Svm([
      { id: FADE_PROGRAM_ADDRESS, name: "fade" },
      { id: ORAO_VRF_PROGRAM_ADDRESS, name: "orao_mock" },
    ]);
    const deployer = await svm.fundedWallet(1_000);
    const keeper = await svm.fundedWallet(1_000);
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

    const mint = new Uint8Array(82);
    mint[0] = 1;
    mint.set(bytes(deployer.address), 4);
    mint[44] = 6;
    mint[45] = 1;
    const [eventAuthority] = await findEventAuthorityPda();
    const oraoTreasury = (await svm.fundedWallet(1)).address;
    const env = new BeaconEnv(
      svm,
      deployer,
      keeper,
      address("Treasury11111111111111111111111111111111111"),
      oraoTreasury,
      eventAuthority,
    );
    env.put(USDC_MINT, mint, TOKEN);
    env.put(env.treasury, tokenAccountData(USDC_MINT, deployer.address, 0n), TOKEN);

    // ORAO's network state: discriminator, authority, treasury, fee, no
    // fulfilment authorities, no token fee, request counter.
    const state = new Uint8Array(8 + 32 + 32 + 8 + 4 + 1 + 8);
    state.set([212, 237, 148, 56, 97, 245, 51, 169], 0);
    state.set(bytes(oraoTreasury), 40);
    state.set(getU64Encoder().encode(ORAO_FEE), 72);
    const [networkState] = await findOraoNetworkStatePda();
    env.put(networkState, state, ORAO_VRF_PROGRAM_ADDRESS);
    env.setSlot(env.slot());

    await env.send(deployer, [
      await getInitializeInstructionAsync({
        payer: deployer,
        programData,
        protocolTreasury: env.treasury,
        eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
        council: deployer.address,
        guardian: deployer.address,
        params,
      }),
    ]);
    // The beacon starts paused; the council turns it on.
    await env.send(deployer, [
      await getSetPauseFlagsInstructionAsync({
        authority: deployer,
        eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
        pauseFlags: 0,
        integratorPaused: null,
      }),
    ]);
    await env.found(100_000n * USDC);
    return env;
  }

  put(addr: Address, data: Uint8Array, owner: Address, extraLamports = 0n) {
    this.svm.client.setAccount({
      address: addr,
      data,
      executable: false,
      lamports: lamports(
        this.svm.client.minimumBalanceForRentExemption(BigInt(data.length)) + extraLamports,
      ),
      programAddress: owner,
      space: BigInt(data.length),
    });
  }

  /** A fresh USDC token account of `owner` holding `amount`. */
  async usdcAccount(owner: Address, amount: bigint): Promise<Address> {
    const a = (await this.svm.fundedWallet(0)).address;
    this.put(a, tokenAccountData(USDC_MINT, owner, amount), TOKEN);
    return a;
  }

  /** Freezes (`state = 2`) or thaws (`1`) a token account. */
  setTokenState(account: Address, state: 1 | 2) {
    const acc = this.svm.client.getAccount(account);
    if (!acc.exists) throw new Error("token account");
    const data = new Uint8Array(acc.data);
    data[108] = state;
    this.svm.client.setAccount({ ...acc, data });
  }

  balance(account: Address): bigint {
    const acc = this.svm.client.getAccount(account);
    if (!acc.exists) throw new Error(`no account ${account}`);
    return new DataView(acc.data.buffer, acc.data.byteOffset).getBigUint64(64, true);
  }

  lamports(account: Address): bigint {
    const acc = this.svm.client.getAccount(account);
    return acc.exists ? acc.lamports : 0n;
  }

  exists(account: Address): boolean {
    const acc = this.svm.client.getAccount(account);
    return acc.exists && acc.data.length > 0;
  }

  data(account: Address): Uint8Array {
    const acc = this.svm.client.getAccount(account);
    if (!acc.exists) throw new Error(`no account ${account}`);
    return new Uint8Array(acc.data);
  }

  /** `account` as a client reads it, null if it does not exist. */
  account(account: Address): AccountRead | null {
    const acc = this.svm.client.getAccount(account);
    if (!acc.exists) return null;
    return { address: account, owner: acc.programAddress, data: new Uint8Array(acc.data) };
  }

  read<T>(account: Address, decoder: Decoder<T>): T {
    return decoder.decode(this.data(account));
  }

  async vault() {
    const [v] = await findVaultPda();
    return this.read(v, getVaultDecoder());
  }

  slot(): bigint {
    return this.svm.client.getClock().slot;
  }

  /**
   * Sets the clock's slot (its time unchanged, so the live epoch stays open)
   * and rewrites SlotHashes with the 512 slots before it, each hash the
   * slot's little-endian bytes then a fill byte.
   */
  setSlot(slot: bigint) {
    const clock = this.svm.client.getClock();
    clock.slot = slot;
    this.svm.client.setClock(clock);
    const data = new Uint8Array(20_488);
    const view = new DataView(data.buffer);
    let n = 0;
    for (let s = slot - 1n; s >= 0n && n < 512; s--, n++) {
      const off = 8 + n * 40;
      view.setBigUint64(off, s, true);
      view.setBigUint64(off + 8, s, true);
      data.fill(Number(s % 251n), off + 16, off + 40);
    }
    view.setBigUint64(0, BigInt(n), true);
    this.put(SLOT_HASHES_SYSVAR, data, SYSVAR_OWNER);
  }

  lifetime(): { blockhash: Blockhash; lastValidBlockHeight: bigint } {
    return { blockhash: this.svm.client.latestBlockhash(), lastValidBlockHeight: 1_000_000n };
  }

  /**
   * Builds `instructions` as one transaction of `format`, simulates it, then
   * sends it; throws with the logs if either fails.
   */
  async send(
    feePayer: KeyPairSigner,
    instructions: Instruction[],
    options: { format?: TransactionFormat; units?: number } = {},
  ): Promise<Sent> {
    const message = beaconTransactionMessage(
      options.format ?? 1,
      feePayer,
      this.lifetime(),
      instructions,
      {
        computeUnitLimit: options.units ?? 600_000,
      },
    );
    return this.sendMessage(message);
  }

  /** Sends a planned message, its lifetime replaced by the latest blockhash. */
  async sendMessage(message: ReturnType<typeof beaconTransactionMessage>): Promise<Sent> {
    const tx = await signTransactionMessageWithSigners(
      setTransactionMessageLifetimeUsingBlockhash(this.lifetime(), message),
    );
    const wire = getTransactionSize(tx);
    const sim = this.svm.client.simulateTransaction(tx);
    if (sim instanceof FailedTransactionMetadata) throw new SvmTransactionError(sim);
    const result = this.svm.client.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata) throw new SvmTransactionError(result);
    this.svm.client.expireBlockhash();
    return { meta: result, units: result.computeUnitsConsumed(), bytes: wire };
  }

  /** ORAO's quorum fulfils `request` with `randomness`; the rent refund goes to `client`. */
  async fulfill(request: Address, client: Address, randomness: Uint8Array) {
    const disc = (await sha256(new TextEncoder().encode("global:fulfill"))).slice(0, 8);
    const data = new Uint8Array(72);
    data.set(disc, 0);
    data.set(randomness, 8);
    await this.send(this.keeper, [
      {
        programAddress: ORAO_VRF_PROGRAM_ADDRESS,
        accounts: [
          { address: request, role: 1 },
          { address: client, role: 1 },
        ],
        data,
      },
    ]);
  }

  /**
   * Someone outside Fade (`stranger`) creates the ORAO request for `seed`
   * through ORAO's `request_v2`, as anyone may once the seed is public, or,
   * `legacy`, through the deprecated `request`, which creates the legacy
   * `Randomness` layout at the same address.
   */
  async preCreate(stranger: KeyPairSigner, request: Address, seed: Uint8Array, legacy = false) {
    const name = legacy ? "global:request" : "global:request_v2";
    const disc = (await sha256(new TextEncoder().encode(name))).slice(0, 8);
    const data = new Uint8Array(40);
    data.set(disc, 0);
    data.set(seed, 8);
    const [networkState] = await findOraoNetworkStatePda();
    await this.send(stranger, [
      {
        programAddress: ORAO_VRF_PROGRAM_ADDRESS,
        accounts: [
          // The fee payer: its signature covers this signer.
          { address: stranger.address, role: AccountRole.WRITABLE_SIGNER },
          { address: networkState, role: AccountRole.WRITABLE },
          { address: this.oraoTreasury, role: AccountRole.WRITABLE },
          { address: request, role: AccountRole.WRITABLE },
          { address: address("11111111111111111111111111111111"), role: AccountRole.READONLY },
        ],
        data,
      },
    ]);
  }

  /** A deposit of `amount` by a fresh liquidity provider, struck and claimed. */
  private async found(amount: bigint) {
    const lp = await this.svm.fundedWallet(10);
    const lpUsdc = await this.usdcAccount(lp.address, amount);
    const [config] = await findConfigPda();
    const [queue] = await findQueuePda();
    const [vault] = await findVaultPda();
    const epoch = getU64Encoder().encode(1n);
    const [request] = await getProgramDerivedAddress({
      programAddress: FADE_PROGRAM_ADDRESS,
      seeds: ["deposit", epoch, bytes(lp.address)],
    });
    await this.send(lp, [
      await getRequestDepositInstructionAsync({
        owner: lp,
        ownerUsdc: lpUsdc,
        config,
        queue,
        vault,
        usdcMint: USDC_MINT,
        request,
        eventAuthority: this.eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
        amount,
      }),
    ]);
    const q = this.read(queue, getQueueDecoder());
    const clock = this.svm.client.getClock();
    clock.unixTimestamp = q.current.closeTs;
    this.svm.client.setClock(clock);
    const [record] = await getProgramDerivedAddress({
      programAddress: FADE_PROGRAM_ADDRESS,
      seeds: ["epoch", epoch],
    });
    await this.send(this.keeper, [
      await getStrikeEpochInstructionAsync({
        caller: this.keeper,
        record,
        usdcMint: USDC_MINT,
        eventAuthority: this.eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
      }),
    ]);
    const [shareMint] = await getProgramDerivedAddress({
      programAddress: FADE_PROGRAM_ADDRESS,
      seeds: ["shares"],
    });
    const [lpShares] = await getProgramDerivedAddress({
      programAddress: ATA,
      seeds: [bytes(lp.address), bytes(TOKEN), bytes(shareMint)],
    });
    await this.send(this.keeper, [
      await getClaimDepositInstructionAsync({
        caller: this.keeper,
        request,
        owner: lp.address,
        record,
        ownerShares: lpShares,
        rentReceiver: queue,
        eventAuthority: this.eventAuthority,
        program: FADE_PROGRAM_ADDRESS,
      }),
    ]);
  }
}
