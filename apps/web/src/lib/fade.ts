// Reads of the devnet program's state, and every address derived from it.
import {
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getU64Encoder,
  type Address,
  type Lamports,
} from "@solana/kit";
import {
  DEPOSIT_REQUEST_DISCRIMINATOR,
  EPOCH_RECORD_DISCRIMINATOR,
  INTEGRATOR_DISCRIMINATOR,
  WITHDRAW_REQUEST_DISCRIMINATOR,
  decodeDepositRequest,
  decodeEpochRecord,
  decodeIntegrator,
  decodeWithdrawRequest,
  fetchMaybeConfig,
  fetchMaybeEpochRecord,
  fetchMaybeIntegrator,
  fetchMaybeVault,
  fetchMaybeQueue,
  findConfigPda,
  findIntegratorPda,
  findPayoutEscrowPda,
  findVaultPda,
  findQueuePda,
  findShareMintPda,
  findVaultAuthorityPda,
  findVaultUsdcPda,
  type Config,
  type DepositRequest,
  type EpochRecord,
  type Integrator,
  type Vault,
  type Queue,
  type RiskParams,
  type WithdrawRequest,
} from "../../../../clients/js/src/generated/fade";
import { ATA_PROGRAM, PROGRAM, PROGRAM_CONFIG, TOKEN_PROGRAM, USDC_MINT } from "./config";
import { rpc } from "./rpc";

export type {
  Config,
  DepositRequest,
  EpochRecord,
  Integrator,
  Vault,
  Queue,
  RiskParams,
  WithdrawRequest,
};

const addressBytes = (a: Address) => new Uint8Array(getAddressEncoder().encode(a));
const u64 = (v: bigint) => new Uint8Array(getU64Encoder().encode(v));

export type Pdas = {
  config: Address;
  vault: Address;
  queue: Address;
  vaultUsdc: Address;
  shareMint: Address;
  payoutEscrow: Address;
  vaultAuthority: Address;
  eventAuthority: Address;
};

let pdasPromise: Promise<Pdas> | null = null;
export function pdas(): Promise<Pdas> {
  pdasPromise ??= (async () => ({
    config: (await findConfigPda(PROGRAM_CONFIG))[0],
    vault: (await findVaultPda(PROGRAM_CONFIG))[0],
    queue: (await findQueuePda(PROGRAM_CONFIG))[0],
    vaultUsdc: (await findVaultUsdcPda(PROGRAM_CONFIG))[0],
    shareMint: (await findShareMintPda(PROGRAM_CONFIG))[0],
    payoutEscrow: (await findPayoutEscrowPda(PROGRAM_CONFIG))[0],
    vaultAuthority: (await findVaultAuthorityPda(PROGRAM_CONFIG))[0],
    eventAuthority: (
      await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ["__event_authority"] })
    )[0],
  }))();
  return pdasPromise;
}

export async function integratorPda(authority: Address) {
  return (await findIntegratorPda({ integratorAuthority: authority }, PROGRAM_CONFIG))[0];
}

export async function epochRecordPda(epochId: bigint) {
  return (
    await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ["epoch", u64(epochId)] })
  )[0];
}

export async function depositRequestPda(epochId: bigint, owner: Address) {
  return (
    await getProgramDerivedAddress({
      programAddress: PROGRAM,
      seeds: ["deposit", u64(epochId), addressBytes(owner)],
    })
  )[0];
}

export async function withdrawRequestPda(epochId: bigint, owner: Address) {
  return (
    await getProgramDerivedAddress({
      programAddress: PROGRAM,
      seeds: ["withdraw", u64(epochId), addressBytes(owner)],
    })
  )[0];
}

export async function ata(owner: Address, mint: Address = USDC_MINT) {
  return (
    await getProgramDerivedAddress({
      programAddress: ATA_PROGRAM,
      seeds: [addressBytes(owner), addressBytes(TOKEN_PROGRAM), addressBytes(mint)],
    })
  )[0];
}

export type ProtocolState =
  | { initialized: false }
  | {
      initialized: true;
      config: Config;
      vault: Vault;
      queue: Queue;
      /** The slot the state was read at. */
      slot: bigint;
      /** Chain time, from the latest block. */
      now: bigint;
      /** Local unix seconds when `now` was read: chain time keeps running from there. */
      fetchedAt: number;
    };

/** Config, Vault and Queue in one round trip; `initialized: false` until `initialize` ran. */
export async function fetchProtocolState(): Promise<ProtocolState> {
  const p = await pdas();
  const [config, vault, queue] = await Promise.all([
    fetchMaybeConfig(rpc, p.config, { commitment: "confirmed" }),
    fetchMaybeVault(rpc, p.vault, { commitment: "confirmed" }),
    fetchMaybeQueue(rpc, p.queue, { commitment: "confirmed" }),
  ]);
  if (!config.exists || !vault.exists || !queue.exists) return { initialized: false };
  const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
  return {
    initialized: true,
    config: config.data,
    vault: vault.data,
    queue: queue.data,
    slot,
    now: await chainNow(slot),
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

/** The cluster's clock: the latest block time, or the local clock if the RPC has none yet. */
export async function chainNow(slot?: bigint): Promise<bigint> {
  try {
    const s = slot ?? (await rpc.getSlot({ commitment: "confirmed" }).send());
    const t = await rpc.getBlockTime(s).send();
    if (t !== null) return BigInt(t);
  } catch {
    // recent slots may not have a block time yet
  }
  return BigInt(Math.floor(Date.now() / 1000));
}

export async function fetchIntegrator(authority: Address): Promise<Integrator | null> {
  const i = await fetchMaybeIntegrator(rpc, await integratorPda(authority), {
    commitment: "confirmed",
  });
  return i.exists ? i.data : null;
}

export async function fetchEpochRecord(epochId: bigint): Promise<EpochRecord | null> {
  const r = await fetchMaybeEpochRecord(rpc, await epochRecordPda(epochId), {
    commitment: "confirmed",
  });
  return r.exists ? r.data : null;
}

/** Amount of an SPL token account, or null if it does not exist. */
export async function tokenBalance(account: Address): Promise<bigint | null> {
  const { value } = await rpc
    .getAccountInfo(account, { encoding: "base64", commitment: "confirmed" })
    .send();
  if (!value || value.owner !== TOKEN_PROGRAM) return null;
  const data = new Uint8Array(getBase64Encoder().encode(value.data[0]));
  if (data.length < 72) return null;
  return new DataView(data.buffer, data.byteOffset).getBigUint64(64, true);
}

export async function solBalance(a: Address): Promise<bigint> {
  return (await rpc.getBalance(a, { commitment: "confirmed" }).send()).value;
}

/** The epoch a request made now lands in (Spec 08 §4 rules 1–2). */
export function joiningEpochId(q: Queue, now: bigint): bigint {
  if (!q.current.live) return q.nextEpochId;
  if (now < q.current.closeTs) return q.current.epochId;
  return q.next.live ? q.next.epochId : q.nextEpochId;
}

const b58 = (bytes: Uint8Array | ReadonlyUint8ArrayLike) =>
  getBase58Decoder().decode(Uint8Array.from(bytes));
type ReadonlyUint8ArrayLike = ArrayLike<number>;

type RawAccount = {
  pubkey: Address;
  account: {
    data: readonly [string, string] | [string, string];
    executable: boolean;
    lamports: Lamports;
    owner: Address;
    space: bigint;
  };
};

const encoded = (a: RawAccount) => ({
  address: a.pubkey,
  data: new Uint8Array(getBase64Encoder().encode(a.account.data[0])),
  executable: a.account.executable,
  lamports: a.account.lamports,
  programAddress: a.account.owner,
  space: a.account.space,
});

/** The program's accounts of one type, optionally only those of one owner (at offset 10). */
async function programAccounts(
  discriminator: ArrayLike<number>,
  owner?: Address,
): Promise<RawAccount[]> {
  const res = await rpc
    .getProgramAccounts(PROGRAM, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { memcmp: { offset: 0n, bytes: b58(discriminator) as never, encoding: "base58" } },
        ...(owner ? [{ memcmp: { offset: 10n, bytes: owner as never, encoding: "base58" } }] : []),
      ] as never,
    })
    .send();
  return res as unknown as RawAccount[];
}

/** Every deposit request still open (the owner's only, when given), struck or not. */
export async function fetchDepositRequests(
  owner?: Address,
): Promise<{ address: Address; data: DepositRequest }[]> {
  return (await programAccounts(DEPOSIT_REQUEST_DISCRIMINATOR, owner)).map((a) => ({
    address: a.pubkey,
    data: decodeDepositRequest(encoded(a)).data,
  }));
}

/** Every withdrawal request still open (the owner's only, when given), struck or not. */
export async function fetchWithdrawRequests(
  owner?: Address,
): Promise<{ address: Address; data: WithdrawRequest }[]> {
  return (await programAccounts(WITHDRAW_REQUEST_DISCRIMINATOR, owner)).map((a) => ({
    address: a.pubkey,
    data: decodeWithdrawRequest(encoded(a)).data,
  }));
}

/**
 * Every epoch record still open: a record closes once each request that reads
 * it has been claimed, so this is the strikes with claims outstanding, not
 * the history (the history is in the `EpochStruck` events).
 */
export async function fetchEpochRecords(): Promise<{ address: Address; data: EpochRecord }[]> {
  return (await programAccounts(EPOCH_RECORD_DISCRIMINATOR)).map((a) => ({
    address: a.pubkey,
    data: decodeEpochRecord(encoded(a)).data,
  }));
}

/** Every token account of the share mint with a balance: wallet owner and amount. */
export async function fetchShareHolders(): Promise<{ owner: Address; amount: bigint }[]> {
  const p = await pdas();
  const res = await rpc
    .getProgramAccounts(TOKEN_PROGRAM, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: 165n },
        { memcmp: { offset: 0n, bytes: p.shareMint as never, encoding: "base58" } },
      ] as never,
    })
    .send();
  const out = new Map<Address, bigint>();
  for (const a of res as unknown as RawAccount[]) {
    const d = new Uint8Array(getBase64Encoder().encode(a.account.data[0]));
    const owner = getBase58Decoder().decode(d.subarray(32, 64)) as Address;
    const amount = new DataView(d.buffer, d.byteOffset).getBigUint64(64, true);
    // The vault's own share accounts (escrow, claims) are not providers.
    if (owner === p.vaultAuthority || amount === 0n) continue;
    out.set(owner, (out.get(owner) ?? 0n) + amount);
  }
  return [...out].map(([owner, amount]) => ({ owner, amount }));
}

/** Every integrator the program has seen. */
export async function fetchIntegrators(): Promise<{ address: Address; data: Integrator }[]> {
  return (await programAccounts(INTEGRATOR_DISCRIMINATOR)).map((a) => ({
    address: a.pubkey,
    data: decodeIntegrator(encoded(a)).data,
  }));
}

/** Strike fund: the Queue's lamports above its rent-exempt minimum. */
export async function strikeFund(): Promise<bigint | null> {
  const p = await pdas();
  const { value } = await rpc.getAccountInfo(p.queue, { encoding: "base64" }).send();
  if (!value) return null;
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(value.space)).send();
  return value.lamports - rent;
}
