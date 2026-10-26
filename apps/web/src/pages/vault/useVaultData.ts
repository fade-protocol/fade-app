// Everything the vault page and the dashboard read about the vault and one owner: the vault's
// history, the open requests, the providers, the owner's wallet, history and position. The
// providers come from the keeper (GET /v1/providers); the app scans the share mint and every
// open request itself only while the keeper cannot serve them. The owner's wallet,
// requests, position and own line among the providers are always read from the chain; its
// history comes from the keeper (GET /v1/wallet/:owner, lib/keeperWallet) with its newest
// transactions read from the chain, the app reading it in full only while the keeper cannot
// serve it. A page that does not show the providers (the dashboard) reads none of them.
import { isAddress, type Address } from "@solana/kit";
import { useEffect, useMemo, useRef } from "react";
import {
  ata,
  fetchDepositRequests,
  fetchEpochRecords,
  fetchOwnShares,
  fetchShareHolders,
  fetchWithdrawRequests,
  pdas,
  solBalance,
  strikeFund,
  tokenBalance,
} from "../../lib/fade";
import { fetchLpLog } from "../../lib/history";
import { ownerLogPoll, type OwnerLog } from "../../lib/keeperWallet";
import { useKeeperProviders, usePolling, useWalletPush } from "../../lib/hooks";
import { chooseProviders, firstDepositIn, needsOwn } from "../../lib/keeperViews";
import {
  claimInLog,
  pendingRequests,
  summarise,
  type PendingRequest,
  type Settling,
} from "../../lib/position";
import { providerRows } from "../../lib/providers";
import { useWallet } from "../../wallet/WalletProvider";
import type { Live, Requests, VaultData } from "./common";

/**
 * Development only: `?as=<address>` shows that wallet's position read-only,
 * to look at a populated dashboard without its keys.
 */
export function viewAs(): Address | undefined {
  if (!import.meta.env.DEV) return undefined;
  const a = new URLSearchParams(window.location.search).get("as");
  return a && isAddress(a) ? a : undefined;
}

const keyOf = (r: PendingRequest) => `${r.kind}:${r.epochId}`;
/** A settling request is dropped after this long, whatever the history says. */
const SETTLING_MAX_MS = 5 * 60_000;

/**
 * Requests that left the chain (claimed, their account closed) while this wallet's history has
 * not caught up with their claim: they keep counting until it has (see `Settling`).
 */
function useSettling(
  owner: Address | undefined,
  pending: PendingRequest[] | null,
  shares: bigint | null,
  log: Parameters<typeof claimInLog>[1] | null,
): Settling[] {
  const ref = useRef<{
    owner: Address | undefined;
    prev: PendingRequest[] | null;
    open: Map<
      string,
      { req: PendingRequest; since: number; shares: bigint | null; inWallet: boolean }
    >;
  }>({ owner, prev: null, open: new Map() });
  const st = ref.current;
  if (st.owner !== owner) {
    st.owner = owner;
    st.prev = null;
    st.open.clear();
  }
  if (pending) {
    const now = new Set(pending.map(keyOf));
    for (const r of st.prev ?? [])
      if (!now.has(keyOf(r)) && !st.open.has(keyOf(r)))
        st.open.set(keyOf(r), { req: r, since: Date.now(), shares, inWallet: false });
    for (const k of [...st.open.keys()]) if (now.has(k)) st.open.delete(k);
    st.prev = pending;
  }
  for (const [k, s] of st.open) {
    if ((log && claimInLog(s.req, log)) || Date.now() - s.since > SETTLING_MAX_MS)
      st.open.delete(k);
    else if (s.req.kind === "deposit" && s.shares !== null && shares !== null && shares > s.shares)
      s.inWallet = true;
  }
  return [...st.open.values()].map(({ req, inWallet }) => ({ req, inWallet }));
}

/** Requests of the owner that a claim would pay now: the claim is the keeper's, or the owner's. */
export const readyCount = (pending: PendingRequest[] | null) =>
  (pending ?? []).filter(
    (r) =>
      r.phase === "claimable" ||
      r.phase === "parked" ||
      (r.phase === "rationed" && (r.claimableNow ?? 0n) > 0n),
  ).length;

/**
 * A badge on the tab while a request is ready, and a browser notification when one becomes ready
 * while the page is in the background (only once the owner allowed notifications).
 */
function useReadyAlert(pending: PendingRequest[] | null) {
  const n = readyCount(pending);
  const prev = useRef(n);
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = n > 0 ? `(${n}) ${base}` : base;
    if (
      n > prev.current &&
      document.hidden &&
      "Notification" in window &&
      Notification.permission === "granted"
    )
      new Notification("Fade vault", { body: "A request of yours is priced: its claim is ready." });
    prev.current = n;
    return () => {
      document.title = document.title.replace(/^\(\d+\) /, "");
    };
  }, [n]);
}

/** The connected wallet, or (development only) the address viewed with `?as=`. */
export function useOwner(): Address | undefined {
  const { account } = useWallet();
  return (account?.address as Address | undefined) ?? viewAs();
}

/**
 * `providers: false`: the page does not show the Providers table, so neither the keeper's list,
 * nor the wallet's every share account, nor the app's own scan is read (`providers` stays null
 * and the requests read are the owner's alone).
 */
export function useVaultData(
  state: Live,
  refreshKey: number,
  bump: () => void,
  { providers: withProviders = true }: { providers?: boolean } = {},
): VaultData {
  const { signer, account } = useWallet();
  const owner = (account?.address as Address | undefined) ?? viewAs();

  const log = usePolling(fetchLpLog, 30_000, [refreshKey]);
  const keeperProviders = useKeeperProviders(withProviders);
  // the keeper's list cannot be trusted: the app lists the providers itself
  const scanOwn = withProviders && needsOwn(keeperProviders.data, keeperProviders.error !== null);
  const scope: Requests["scope"] = scanOwn ? "all" : (owner ?? null);
  const requests = usePolling(
    async (): Promise<Requests> => {
      if (scope === null) return { deposits: [], withdraws: [], records: [], scope };
      const of = scope === "all" ? undefined : scope;
      const [deposits, withdraws, records] = await Promise.all([
        fetchDepositRequests(of),
        fetchWithdrawRequests(of),
        fetchEpochRecords(),
      ]);
      return { deposits, withdraws, records, scope };
    },
    15_000,
    [refreshKey, scope],
  );
  const holders = usePolling(async () => (scanOwn ? fetchShareHolders() : null), 30_000, [
    refreshKey,
    scanOwn,
  ]);
  const fund = usePolling(strikeFund, 30_000, [refreshKey]);
  const wallet = usePolling(
    async () => {
      if (!owner) return null;
      const { shareMint } = await pdas();
      const [usdcBal, shareBal, sol] = await Promise.all([
        tokenBalance(await ata(owner)),
        tokenBalance(await ata(owner, shareMint)),
        solBalance(owner),
      ]);
      return {
        owner,
        usdc: usdcBal,
        shares: shareBal ?? 0n,
        sol,
        hasShareAccount: shareBal !== null,
        hasUsdcAccount: usdcBal !== null,
      };
    },
    15_000,
    [owner, refreshKey],
  );
  // the fvUSDC of every share account of the wallet, for its line in the Providers table (the
  // wallet's figures above and its actions read the associated account)
  const ownSharesRead = usePolling(
    async () => (owner && withProviders ? { owner, holders: await fetchOwnShares(owner) } : null),
    15_000,
    [owner, refreshKey, withProviders],
  );
  const ownShares =
    owner && ownSharesRead.data?.owner === owner ? ownSharesRead.data.holders : null;
  const logItems = log.data?.items ?? null;
  // the keeper's history of the owner with its newest transactions, else the app's own reads
  // over the vault's (which wait for it); a poll that reads neither keeps the last one
  const lastOwnerLog = useRef<OwnerLog | null>(null);
  const ownerLogRead = usePolling(
    async () => {
      const v = owner ? await ownerLogPoll(owner, logItems, lastOwnerLog.current) : null;
      lastOwnerLog.current = v;
      return v;
    },
    15_000,
    [owner, logItems],
  );
  // the keeper indexed new transactions of the owner (its live push): its history, balances and
  // requests are read again at once; their polls stay, an action is checked against them
  useWalletPush(owner, () => {
    ownerLogRead.refresh();
    wallet.refresh();
    requests.refresh();
    ownSharesRead.refresh();
  });
  // a poll keeps its last data when the wallet changes: show only what was read for this one
  const ownerLog = {
    ...ownerLogRead,
    data: ownerLogRead.data && ownerLogRead.data.owner === owner ? ownerLogRead.data.items : null,
  };

  // a poll keeps its last data when its scope changes: only requests read for this owner count
  const ownRequests =
    owner && requests.data && (requests.data.scope === "all" || requests.data.scope === owner)
      ? requests.data
      : null;
  const pending = useMemo(() => {
    if (!owner || !ownRequests) return null;
    return pendingRequests(
      ownRequests.deposits.filter((d) => d.data.owner === owner),
      ownRequests.withdraws.filter((w) => w.data.owner === owner),
      ownRequests.records,
      state,
    );
  }, [owner, ownRequests, state]);

  const walletData = owner && wallet.data?.owner === owner ? wallet.data : null;
  const providers = useMemo(() => {
    if (!withProviders) return null;
    const all = requests.data?.scope === "all" ? requests.data : null;
    const scanned =
      scanOwn && holders.data && all
        ? providerRows(holders.data, all.deposits, all.withdraws, all.records)
        : null;
    const mine =
      owner && ownShares && ownRequests
        ? {
            owner,
            row:
              providerRows(
                ownShares,
                ownRequests.deposits.filter((d) => d.data.owner === owner),
                ownRequests.withdraws.filter((w) => w.data.owner === owner),
                ownRequests.records,
              )[0] ?? null,
            // its own history has a first request the keeper's list may not have read yet
            firstDepositAt: ownerLog.data ? firstDepositIn(ownerLog.data, owner) : null,
          }
        : null;
    return chooseProviders(keeperProviders.data, scanned, state.vault, mine);
  }, [
    withProviders,
    keeperProviders.data,
    scanOwn,
    holders.data,
    requests.data,
    owner,
    ownShares,
    ownRequests,
    ownerLog.data,
    state.vault,
  ]);
  const settling = useSettling(owner, pending, walletData?.shares ?? null, ownerLog.data);
  // a request just left the chain: read this wallet's history now rather than at the next poll
  const settlingKey = settling.map((s) => keyOf(s.req)).join();
  const refreshOwnerLog = ownerLog.refresh;
  const refreshLog = log.refresh;
  useEffect(() => {
    if (!settlingKey) return;
    refreshLog();
    refreshOwnerLog();
  }, [settlingKey, refreshLog, refreshOwnerLog]);
  useReadyAlert(pending);
  const summary = useMemo(
    () =>
      walletData && pending
        ? summarise(walletData.shares, pending, owner ? ownerLog.data : null, state.vault, settling)
        : null,
    [walletData, pending, owner, ownerLog.data, state.vault, settling],
  );

  return {
    state,
    owner,
    signer: account ? signer : undefined,
    log: log.data,
    logError: log.error,
    requests: requests.data,
    providers,
    wallet: walletData,
    ownerLog: owner ? ownerLog.data : null,
    pending,
    summary,
    fund: fund.data ?? null,
    refresh: bump,
  };
}
