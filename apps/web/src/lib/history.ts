// The vault's history, read from the chain: the Queue's signatures and the owner-scoped reads
// below. One owner's history is the keeper's when it can serve it (lib/keeperWallet); these
// reads are its fallback.
//
// Every request and every strike writes the Queue account, so its signature
// list is the LP log; claims usually write it too (when they close a record
// whose rent the strike fund advanced), and the owner-scoped reads below catch
// the rest. Epoch records close once claimed, so the share-price series comes
// from the `EpochStruck` events, not from the records.
import type { Address, Signature } from "@solana/kit";
import { txDecoder } from "./events";
import { ata, pdas, withdrawRequestPda, type Vault } from "./fade";
import { rpc } from "./rpc";
import { eventsFor } from "./txCache";
import { afterStrike, sharePrice } from "./vaultViews";
import { LP_KINDS, mergeOwnerItems, ownerItemsOf, type LpItem } from "./walletHistory";

export { ownerOf, type LpItem } from "./walletHistory";

/** The newest `max` successful signatures of `account`, newest first. */
async function signatures(account: Address, max: number) {
  const out: { signature: Signature; blockTime: number | null }[] = [];
  let before: Signature | undefined;
  while (out.length < max) {
    const page = await rpc
      .getSignaturesForAddress(account, {
        limit: Math.min(1000, max - out.length),
        commitment: "confirmed",
        ...(before ? { before } : {}),
      })
      .send();
    for (const s of page)
      if (s.err === null)
        out.push({
          signature: s.signature,
          blockTime: s.blockTime === null ? null : Number(s.blockTime),
        });
    if (page.length === 0 || page.length < 1000) break;
    before = page[page.length - 1]?.signature;
  }
  return out;
}

/**
 * The LP events of these transactions. Reads only the ones this browser has not seen (txCache);
 * one listed but not indexed yet is read again on the next poll.
 */
async function load(sigs: { signature: Signature; blockTime: number | null }[]) {
  const known = await eventsFor(
    sigs.map((s) => s.signature),
    await txDecoder(),
  );
  return sigs.flatMap((s): LpItem[] => {
    const events = known.get(s.signature)?.events.filter((e) => LP_KINDS.has(e.kind)) ?? [];
    return events.length ? [{ signature: s.signature, blockTime: s.blockTime, events }] : [];
  });
}

/** How far back the page reads the Queue's history. */
export const LP_LOG_MAX = 2_000;

export type LpLog = { items: LpItem[]; truncated: boolean };

/** Every LP transaction of the vault, newest first. */
export async function fetchLpLog(): Promise<LpLog> {
  const p = await pdas();
  const sigs = await signatures(p.queue, LP_LOG_MAX);
  return { items: await load(sigs), truncated: sigs.length >= LP_LOG_MAX };
}

/**
 * One owner's LP transactions, newest first: the vault log filtered to them,
 * plus their share account's history (deposit claims) and their withdrawal
 * requests' (withdrawal claims), which do not always touch the Queue.
 */
export async function fetchOwnerLog(owner: Address, vaultLog: LpItem[]): Promise<LpItem[]> {
  const p = await pdas();
  const fromShares = await load(await signatures(await ata(owner, p.shareMint), 1_000));
  let merged = mergeOwnerItems(ownerItemsOf(vaultLog, owner), ownerItemsOf(fromShares, owner));
  const withdrawEpochs = new Set<bigint>();
  for (const i of merged)
    for (const e of i.events)
      if (e.kind === "WithdrawRequested") withdrawEpochs.add(e.data.epochId);
  for (const epoch of withdrawEpochs) {
    const items = await load(await signatures(await withdrawRequestPda(epoch, owner), 200));
    merged = mergeOwnerItems(merged, ownerItemsOf(items, owner));
  }
  return merged;
}

export type PricePoint = {
  /** Unix seconds. */
  t: number;
  /** Micro-USDC per whole share (shares have 9 decimals). */
  price: bigint;
  /** Vault assets after the strike, micro-USDC. */
  assets: bigint;
  epochId: bigint | null;
};

export { sharePrice };

/** The vault's settled price now: open payouts' tickets left out, as a strike does. */
export const livePrice = (vault: Vault) =>
  sharePrice(vault.totalAssets - vault.openVaultCredits, vault.totalShares);

/**
 * The share price and vault assets after each strike, oldest first, from the
 * `EpochStruck` events (`afterStrike`, lib/vaultViews), then the live figures as the last point.
 */
export function strikeSeries(log: LpItem[], vault: Vault, now: number): PricePoint[] {
  const points: PricePoint[] = [];
  const seen = new Set<bigint>();
  for (const item of [...log].reverse()) {
    for (const e of item.events) {
      if (e.kind !== "EpochStruck" || seen.has(e.data.epochId)) continue;
      seen.add(e.data.epochId);
      const { assets, price } = afterStrike(e.data);
      if (price === null) continue;
      points.push({ t: item.blockTime ?? now, price, assets, epochId: e.data.epochId });
    }
  }
  const live = livePoint(vault, now);
  if (live) points.push(live);
  return points;
}

/**
 * Today's point of the share price series: the live price on the settled assets, as the strike
 * points are (open payouts' tickets left out). Null with no shares.
 */
export function livePoint(vault: Vault, now: number): PricePoint | null {
  const price = livePrice(vault);
  return price === null
    ? null
    : { t: now, price, assets: vault.totalAssets - vault.openVaultCredits, epochId: null };
}
