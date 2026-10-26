// One provider's position, from their wallet, their open requests and their
// LP history. Every figure but the PnL is read directly from the chain; the
// PnL is a net-flow sum over the history this page could read, and says so
// when that history does not explain the wallet's shares.
import type { Address } from "@solana/kit";
import type { Vault, Queue, RiskParams } from "./fade";
import { livePrice, type LpItem } from "./history";
import { withdrawClaimRecords } from "./lp";
import {
  queuedOf,
  shareOfBps,
  valueOf,
  type DepositReq,
  type Rec,
  type WithdrawReq,
} from "./providers";
import { depositDue, stillQueued } from "./shares";

const SHARE_UNIT = 1_000_000_000n;

export type RequestPhase =
  | "queued" // epoch live, before its close
  | "awaiting-strike" // closed, not struck yet
  | "next-epoch" // lands in the epoch after the live one
  | "claimable" // struck: the keeper claims it
  | "rationed" // struck, part paid; the rest waits for a later strike
  | "parked"; // claimed, but the owner's account could not receive

export type PendingRequest = {
  kind: "deposit" | "withdraw";
  address: Address;
  epochId: bigint;
  /** Deposit: micro-USDC. Withdrawal: shares. */
  amount: bigint;
  /** Micro-USDC, estimated at the live price where not final. */
  value: bigint;
  /** A struck deposit: the shares it is due. */
  sharesDue?: bigint;
  /** A withdrawal: USDC a claim would pay now, exactly (a part of it while rationed). */
  claimableNow?: bigint;
  /** A withdrawal: USDC already paid to it by earlier claims. */
  paid?: bigint;
  /** A withdrawal: shares still queued for later strikes (all of them until it is struck). */
  queuedShares?: bigint;
  phase: RequestPhase;
  /** Unix seconds of the strike that made it claimable, when known. */
  struckTs: number | null;
  /** Seconds until the epoch closes (strike due), when it is the live one. */
  closesIn: number | null;
  deposit?: DepositReq;
  withdraw?: WithdrawReq;
};

function phaseOf(
  epochId: bigint,
  queue: Queue,
  now: bigint,
): { phase: RequestPhase; closesIn: number | null } {
  const cur = queue.current;
  if (cur.live && cur.epochId === epochId) {
    const left = Number(cur.closeTs - now);
    return left > 0
      ? { phase: "queued", closesIn: left }
      : { phase: "awaiting-strike", closesIn: 0 };
  }
  return { phase: "next-epoch", closesIn: null };
}

export function pendingRequests(
  deposits: DepositReq[],
  withdraws: WithdrawReq[],
  records: Rec[],
  state: { vault: Vault; queue: Queue; now: bigint },
): PendingRequest[] {
  const { vault, queue, now } = state;
  const byEpoch = new Map(records.map((r) => [r.data.epochId, r]));
  const out: PendingRequest[] = [];
  for (const d of deposits) {
    const rec = byEpoch.get(d.data.epochId);
    const base = {
      kind: "deposit" as const,
      address: d.address,
      epochId: d.data.epochId,
      amount: d.data.amount,
      deposit: d,
    };
    if (d.data.parked) {
      out.push({
        ...base,
        value: valueOf(d.data.sharesDue, vault),
        phase: "parked",
        struckTs: null,
        closesIn: null,
      });
    } else if (rec) {
      const due = depositDue(d.data.amount, rec.data.deposits, rec.data.sharesMinted) ?? 0n;
      out.push({
        ...base,
        value: valueOf(due, vault),
        sharesDue: due,
        phase: "claimable",
        struckTs: Number(rec.data.struckTs),
        closesIn: null,
      });
    } else {
      out.push({
        ...base,
        value: d.data.amount,
        struckTs: null,
        ...phaseOf(d.data.epochId, queue, now),
      });
    }
  }
  for (const w of withdraws) {
    const r = w.data;
    const base = {
      kind: "withdraw" as const,
      address: w.address,
      epochId: r.epochId,
      amount: r.shares,
      withdraw: w,
    };
    const estimate = valueOf(r.shares, vault);
    if (r.parked) {
      out.push({ ...base, value: r.undelivered, phase: "parked", struckTs: null, closesIn: null });
      continue;
    }
    const pick = withdrawClaimRecords(r, records);
    if (pick && !pick.partial) {
      // the chain ends (or splits) at a strike: the claim settles it, and its amount is exact
      const queued =
        pick.at.data.rAfter === 0n
          ? 0n
          : (stillQueued(r.shares, pick.rEntry, pick.at.data.rAfter) ?? 0n);
      out.push({
        ...base,
        value: pick.dueNow + r.undelivered + valueOf(queued, vault),
        claimableNow: pick.dueNow + r.undelivered,
        paid: r.paid,
        queuedShares: queued,
        phase: "claimable",
        struckTs: Number(pick.at.data.struckTs),
        closesIn: null,
      });
    } else if (pick || r.rEntry !== 0n || byEpoch.has(r.epochId)) {
      // Struck, but the strikes so far could only pay part: the rest is queued again. What they
      // paid can be claimed now (a partial claim), exactly; the rest is valued at the live price.
      // shares still queued: read at the latest record of the request's chain
      let latest = pick?.at ?? null;
      if (!latest && r.rEntry !== 0n)
        for (const rec of records)
          if (rec.data.chainId === r.chainId && (!latest || rec.data.epochId > latest.data.epochId))
            latest = rec;
      const rEntry = pick?.rEntry ?? r.rEntry;
      const queued =
        latest && rEntry !== 0n
          ? (stillQueued(r.shares, rEntry, latest.data.rAfter) ?? r.shares)
          : r.shares;
      const now = pick ? pick.dueNow + r.undelivered : r.undelivered;
      out.push({
        ...base,
        value: now + valueOf(queued, vault),
        claimableNow: now,
        paid: r.paid,
        queuedShares: queued,
        phase: "rationed",
        struckTs: pick ? Number(pick.at.data.struckTs) : null,
        closesIn: null,
      });
    } else {
      out.push({ ...base, value: estimate, struckTs: null, ...phaseOf(r.epochId, queue, now) });
    }
  }
  return out.sort((a, b) => Number(b.epochId - a.epochId));
}

/**
 * The close of an epoch opened at `now`, as the program sets it (fade-math `close_ts`): the next
 * multiple of the epoch length strictly after `now`.
 */
export function closeOnGrid(now: number, length: number): number {
  return length <= 0 ? now : (Math.floor(now / length) + 1) * length;
}

/**
 * Seconds until a request made now settles: the close of the epoch it joins, which the keeper
 * strikes on its next pass. A request that opens an epoch, or joins the one after a closed epoch
 * (struck first, then closed on the grid), settles at the next multiple of the epoch length.
 */
export function settleEta(queue: Queue, params: RiskParams, now: number): number {
  const length = Number(params.epochLengthSeconds);
  const cur = queue.current;
  const left = Number(cur.closeTs) - now;
  if (cur.live && left > 0) return left;
  return closeOnGrid(now, length) - now;
}

/**
 * A request the chain no longer shows (claimed, its account closed) while this wallet's history
 * has not caught up with its claim yet. It keeps counting at its last value until the claim is in
 * the history, so the PnL does not dip in between. A deposit whose shares already reached the
 * wallet counts as shares instead (`inWallet`).
 */
export type Settling = { req: PendingRequest; inWallet: boolean };

export type Summary = {
  shares: bigint;
  /** Micro-USDC, at the live settled price. */
  value: bigint;
  /** Requests still open (or settling), valued at the live price where not final. */
  pendingIn: bigint;
  pendingOut: bigint;
  /** The rest is read from the history: null until it is. */
  history: {
    /** USDC sent in through deposit requests, over the history read. */
    deposited: bigint;
    /** USDC received through withdrawal claims: the history, or the chain where it is ahead. */
    withdrawn: bigint;
    pnl: bigint;
    /** PnL over deposited, in basis points; null with nothing deposited. */
    pnlBps: bigint | null;
    /** Shares the history does not explain (transfers in or out, or history beyond reach). */
    unexplainedShares: bigint;
  } | null;
};

/** Whether the history holds the claim that closed `req`. */
export function claimInLog(req: PendingRequest, log: LpItem[]): boolean {
  return log.some((i) =>
    i.events.some((e) =>
      req.kind === "deposit"
        ? e.kind === "DepositClaimed" && e.data.epochId === req.epochId
        : e.kind === "WithdrawClaimed" && e.data.epochId === req.epochId && e.data.closed,
    ),
  );
}

/** USDC a withdrawal request has delivered so far, by the chain: what it paid, less what is parked. */
const deliveredOf = (r: PendingRequest) => {
  // after a split `paid` restarts at 0 for the new chain: never below 0
  const d = r.withdraw ? r.withdraw.data.paid - r.withdraw.data.undelivered : 0n;
  return d > 0n ? d : 0n;
};

export function summarise(
  shares: bigint,
  pending: PendingRequest[],
  log: LpItem[] | null,
  vault: Vault,
  settling: Settling[] = [],
): Summary {
  const open = [...pending, ...settling.filter((s) => !s.inWallet).map((s) => s.req)];
  const pendingIn = open.filter((p) => p.kind === "deposit").reduce((s, p) => s + p.value, 0n);
  const pendingOut = open.filter((p) => p.kind === "withdraw").reduce((s, p) => s + p.value, 0n);
  const value = valueOf(shares, vault);
  if (!log) return { shares, value, pendingIn, pendingOut, history: null };

  let deposited = 0n;
  let claimedShares = 0n;
  let queuedOut = 0n;
  // the net USDC in, over time, and its peak: the PnL's percentage is on the most ever invested
  let net = 0n;
  let peak = 0n;
  const withdrawnBy = new Map<bigint, bigint>();
  // USDC a claim could not deliver (the account could not receive): owed, not received yet
  const parkedBy = new Map<bigint, bigint>();
  const addOut = (epoch: bigint, v: bigint) => {
    withdrawnBy.set(epoch, (withdrawnBy.get(epoch) ?? 0n) + v);
    net -= v;
  };
  // oldest first: a claim that delivers also delivers what earlier claims parked
  for (const item of [...log].reverse())
    for (const e of item.events) {
      switch (e.kind) {
        case "DepositRequested":
          deposited += e.data.amount;
          net += e.data.amount;
          if (net > peak) peak = net;
          break;
        case "DepositClaimed":
          if (e.data.delivered) claimedShares += e.data.shares;
          break;
        case "WithdrawRequested":
          queuedOut += e.data.shares;
          break;
        case "WithdrawClaimed": {
          const parked = parkedBy.get(e.data.epochId) ?? 0n;
          if (e.data.delivered) {
            // the program sends what is due now plus what was parked; the event reports the first
            addOut(e.data.epochId, e.data.assets + parked);
            parkedBy.delete(e.data.epochId);
          } else parkedBy.set(e.data.epochId, parked + e.data.assets);
          break;
        }
        case "ClaimDelivered":
          if (e.data.deposit) claimedShares += e.data.amount;
          else {
            addOut(e.data.epochId, e.data.amount);
            parkedBy.delete(e.data.epochId);
          }
          break;
        default:
          break;
      }
    }
  // The chain is ahead of the history right after a claim: what an open (or settling) withdrawal
  // has already delivered counts, whether or not its claim is in the history yet.
  for (const r of [...pending, ...settling.map((s) => s.req)])
    if (r.kind === "withdraw") {
      const chain = deliveredOf(r);
      if (chain > (withdrawnBy.get(r.epochId) ?? 0n)) withdrawnBy.set(r.epochId, chain);
    }
  // A deposit whose shares reached the wallet before its claim reached the history.
  for (const s of settling) if (s.inWallet) claimedShares += s.req.sharesDue ?? 0n;
  let withdrawn = 0n;
  for (const v of withdrawnBy.values()) withdrawn += v;
  const pnl = value + pendingIn + pendingOut + withdrawn - deposited;
  return {
    shares,
    value,
    pendingIn,
    pendingOut,
    history: {
      deposited,
      withdrawn,
      pnl,
      pnlBps: peak === 0n ? null : (pnl * 10_000n) / peak,
      unexplainedShares: shares - (claimedShares - queuedOut),
    },
  };
}

/**
 * The owner's share of the vault, in basis points: the fvUSDC in the wallet plus those its open
 * withdrawals still hold in escrow (all of them until struck, then those still queued). Null
 * without a wallet read or with no shares at all.
 */
export function ownerShareBps(
  walletShares: bigint | null,
  pending: readonly PendingRequest[] | null,
  totalShares: bigint,
): bigint | null {
  if (walletShares === null || totalShares === 0n) return null;
  const escrowed = (pending ?? [])
    .filter((r) => r.kind === "withdraw" && r.phase !== "parked")
    .reduce((n, r) => n + (r.queuedShares ?? r.amount), 0n);
  return shareOfBps(walletShares + escrowed, totalShares);
}

/**
 * A withdrawal paid over several closes, as its progress bar shows it: of `total` (what it was
 * paid plus what it is worth now), the part paid, the part a claim pays now and the part to come,
 * each in USDC and in percent of the bar.
 */
export function paidProgress(paid: bigint, now: bigint, total: bigint) {
  if (total <= 0n) return null;
  const left = total - paid - now;
  const pct = (v: bigint) => Number((v * 10_000n) / total) / 100;
  return {
    paid,
    now,
    toCome: left > 0n ? left : 0n,
    paidPct: pct(paid),
    nowPct: pct(now),
  };
}

/** The live share price as a JS number of USDC per share, for display only. */
export const priceNumber = (vault: Vault) => {
  const p = livePrice(vault);
  return p === null ? null : Number(p) / 1e6;
};

export { SHARE_UNIT };
