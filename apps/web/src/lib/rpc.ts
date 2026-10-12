import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type RpcTransport,
} from "@solana/kit";
import { RPC_URL } from "./config";

/** The public devnet endpoint rate-limits bursts (HTTP 429): back off and retry. */
const base = createDefaultRpcTransport({ url: RPC_URL });
const retrying = (async (request: Parameters<RpcTransport>[0]) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await base(request);
    } catch (e) {
      const status = (e as { context?: { statusCode?: number } }).context?.statusCode;
      const retriable = status === 429 || (status !== undefined && status >= 500);
      if (!retriable || attempt >= 5) throw e;
      await sleep(Math.min(800 * 2 ** attempt, 8_000));
    }
  }
}) as RpcTransport;

export const rpc = createSolanaRpcFromTransport(retrying);
export type Rpc = typeof rpc;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
