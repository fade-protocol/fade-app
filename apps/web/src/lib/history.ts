// The vault's history, read from the chain alone: no indexer, no database.
//
// Every request and every strike writes the Queue account, so its signature
// list is the LP log; claims usually write it too (when they close a record
// whose rent the strike fund advanced), and the owner-scoped reads below catch
// the rest. Epoch records close once claimed, so the share-price series comes
// from the `EpochStruck` events, not from the records.
import type { Address, Signature } from "@solana/kit";
import { txDecoder, type FadeEvent } from "./events";
import { ata, pdas, withdrawRequestPda, type Vault } from "./fade";
import { rpc } from "./rpc";
import { eventsFor } from "./txCache";

export type LpItem = {
  signature: Signature;
  blockTime: number | null;
  events: FadeEvent[];
};

const LP_KINDS = new Set<FadeEvent["kind"]>([
  "DepositRequested",
  "DepositClaimed",
  "WithdrawRequested",
  "WithdrawClaimed",
  "ClaimDelivered",
  "EpochStruck",
]);

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

/** The LP owner an event belongs to, if any. */
export function ownerOf(e: FadeEvent): Address | null {
  switch (e.kind) {
    case "DepositRequested":
    case "DepositClaimed":
    case "WithdrawRequested":
    case "WithdrawClaimed":
    case "ClaimDelivered":
      return e.data.owner;
    default:
      return null;
  }
}

/**
 * One owner's LP transactions, newest first: the vault log filtered to them,
 * plus their share account's history (deposit claims) and their withdrawal
 * requests' (withdrawal claims), which do not always touch the Queue.
 */
export async function fetchOwnerLog(owner: Address, vaultLog: LpItem[]): Promise<LpItem[]> {
  const p = await pdas();
  const mine = (items: LpItem[]) =>
    items
      .map((i) => ({ ...i, events: i.events.filter((e) => ownerOf(e) === owner) }))
      .filter((i) => i.events.length > 0);
  const fromShares = await load(await signatures(await ata(owner, p.shareMint), 1_000));
  const merged = new Map<string, LpItem>();
  for (const i of [...mine(vaultLog), ...mine(fromShares)]) merged.set(i.signature, i);
  const withdrawEpochs = new Set<bigint>();
  for (const i of merged.values())
    for (const e of i.events)
      if (e.kind === "WithdrawRequested") withdrawEpochs.add(e.data.epochId);
  for (const epoch of withdrawEpochs) {
    const items = await load(await signatures(await withdrawRequestPda(epoch, owner), 200));
    for (const i of mine(items)) merged.set(i.signature, i);
  }
  return [...merged.values()].sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0));
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

const SHARE_UNIT = 1_000_000_000n;
/** The program's virtual offsets (fade-math shares.rs): `A + 1` assets for `S + 1000` shares. */
const VIRTUAL_ASSETS = 1n;
const VIRTUAL_SHARES = 1_000n;

/**
 * Micro-USDC per whole share for `assets` against `shares`, as the program prices a share
 * (fade-math `assets_for_shares` of one whole share, `drawdown::share_price` scaled down):
 * `(A + 1) / (S + 1000)`, rounded down. Null with no shares.
 */
export const sharePrice = (assets: bigint, shares: bigint) =>
  shares === 0n ? null : ((assets + VIRTUAL_ASSETS) * SHARE_UNIT) / (shares + VIRTUAL_SHARES);

/** The vault's settled price now: open payouts' tickets left out, as a strike does. */
export const livePrice = (vault: Vault) =>
  sharePrice(vault.totalAssets - vault.openVaultCredits, vault.totalShares);

/**
 * The share price and vault assets after each strike, oldest first, from the
 * `EpochStruck` events, then the live figures as the last point.
 */
export function strikeSeries(log: LpItem[], vault: Vault, now: number): PricePoint[] {
  const points: PricePoint[] = [];
  const seen = new Set<bigint>();
  for (const item of [...log].reverse()) {
    for (const e of item.events) {
      if (e.kind !== "EpochStruck" || seen.has(e.data.epochId)) continue;
      seen.add(e.data.epochId);
      const d = e.data;
      const assets = d.totalAssets + d.deposits - d.assetsPaid;
      const shares = d.totalShares + d.sharesMinted - d.sharesBurnt;
      const price = sharePrice(assets, shares);
      if (price === null) continue;
      points.push({ t: item.blockTime ?? now, price, assets, epochId: d.epochId });
    }
  }
  const live = livePrice(vault);
  // on the settled assets, as the strike points are (open payouts' tickets left out)
  if (live !== null)
    points.push({
      t: now,
      price: live,
      assets: vault.totalAssets - vault.openVaultCredits,
      epochId: null,
    });
  return points;
}
