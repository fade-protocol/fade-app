// The devnet deployment the app talks to. The generated client defaults to the
// mainnet program id and mint: everything here passes the devnet ones.
import { address } from "@solana/kit";

type Env = { VITE_RPC_URL?: string; VITE_API_URL?: string };
const env: Env = (import.meta as { env?: Env }).env ?? {};
const nodeEnv: Env = (globalThis as { process?: { env?: Env } }).process?.env ?? ({} as Env);

/** The keeper service: it takes a ticket after its open and moves it to its result. */
export const API_URL = (
  env.VITE_API_URL ||
  nodeEnv.VITE_API_URL ||
  "https://api.fade.finance"
).replace(/\/+$/, "");

/** Solana's public devnet endpoint: rate-limited, but needs nothing. */
export const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";
/** The keeper's JSON-RPC proxy to a dedicated devnet node. */
export const KEEPER_RPC = `${API_URL}/v1/rpc`;

/**
 * The RPC every read and send goes through: the keeper's proxy, because the
 * public endpoint rate-limits a page that polls. `VITE_RPC_URL` overrides it,
 * e.g. with PUBLIC_DEVNET_RPC when the keeper is down.
 */
const DEFAULT_RPC = KEEPER_RPC;
export const RPC_URL = env.VITE_RPC_URL || nodeEnv.VITE_RPC_URL || DEFAULT_RPC;

export const PROGRAM = address("GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt");
export const USDC_MINT = address("E4XYMYALrvMX19P6TxqKXe8ZYGxfj2CjMub6c2ZficTv");
export const USDC_DECIMALS = 6;
export const SHARE_DECIMALS = 9;
export const ORAO = address("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
export const SLOT_HASHES = address("SysvarS1otHashes111111111111111111111111111");
export const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");

/** Every generated `get*InstructionAsync` and `find*Pda` takes this. */
export const PROGRAM_CONFIG = { programAddress: PROGRAM } as const;

/** The liquidity providers' page of the docs: where every mechanism behind an (i) is explained. */
export const DOCS_POOL_URL = "https://docs.fade.finance/liquidity/pool";

/** Solana's devnet SOL faucet: the fallback when a wallet needs more SOL than the in-app faucet adds. */
export const FAUCET_URL = "https://faucet.solana.com";

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddress = (a: string) =>
  `https://explorer.solana.com/address/${a}?cluster=devnet`;
