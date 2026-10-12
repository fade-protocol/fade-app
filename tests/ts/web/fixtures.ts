// Shared inputs of the web tests: the program's parameters (the specification's and devnet's),
// a protocol state built from a few numbers, ticket rows, and a small seeded pseudo-random
// generator for the property checks (the same seed gives the same cases on every run).
import type { Address, Signature } from "@solana/kit";
import type { ProtocolState, RiskParams } from "../../../apps/web/src/lib/fade.ts";
import type { TicketLog, TicketRow } from "../../../apps/web/src/lib/ticketLog.ts";

export const USDC = 1_000_000n;
/** One whole fvUSDC: shares have 9 decimals. */
export const SHARE = 1_000_000_000n;
export const DAY = 86400;
export const T0 = 1_800_000_000;

/** fade-math `Params::SPEC` (risk.rs), with the Config-only fields of the devnet deployment. */
export const SPEC: RiskParams = {
  kellyFractionBps: 5000n,
  censorshipBps: 150n,
  whaleBps: 2000n,
  utilisationBreakerBps: 7000n,
  kappaBps: 8000n,
  drawdownBps: 1500n,
  minPrice: 7_500_000n,
  maxPrice: 10_000_000_000n,
  minVaultMarginBps: 100n,
  protocolShareBps: 20n,
  maxAppShareBps: 500n,
  tSettleSlots: 150n,
  crankRequestLamports: 50_000n,
  crankSettleLamports: 200_000n,
  epochLengthSeconds: 120n,
  claimFeeLamports: 200_000n,
  strikeFeeLamports: 200_000n,
  strikeRewardLamports: 200_000n,
  fundTargetLamports: 50_000_000n,
  minDeposit: 1_000_000n,
  minWithdrawShares: 1_000_000_000n,
  minFirstDeposit: 100_000_000n,
  creditEnabled: false,
  creditBase: 0n,
  creditRateBps: 0n,
};

/** The devnet Config: the same, with a 0.10 USDC minimum ticket price. */
export const DEVNET: RiskParams = { ...SPEC, minPrice: 100_000n };

export type Live = Extract<ProtocolState, { initialized: true }>;

/** A protocol state from the figures a test cares about; the rest is a quiet, empty vault. */
export function live(
  over: {
    assets?: bigint;
    shares?: bigint;
    reserved?: bigint;
    openCredits?: bigint;
    params?: Partial<RiskParams>;
    current?: Partial<Live["queue"]["current"]>;
    drawdownTripTs?: bigint;
    priceMaxima?: bigint[];
    priceHeadHour?: bigint;
    now?: bigint;
  } = {},
): Live {
  const epoch = {
    live: false,
    epochId: 0n,
    closeTs: 0n,
    deposits: 0n,
    withdrawShares: 0n,
    depositRequests: 0,
    withdrawRequests: 0,
  };
  return {
    initialized: true,
    config: {
      pauseFlags: 0,
      params: { ...DEVNET, ...over.params },
    } as unknown as Live["config"],
    vault: {
      totalAssets: over.assets ?? 0n,
      totalShares: over.shares ?? 0n,
      totalReservedLiability: over.reserved ?? 0n,
      openVaultCredits: over.openCredits ?? 0n,
      openBeforeClose: 0,
      priceMaxima: over.priceMaxima ?? new Array<bigint>(24).fill(0n),
      priceHeadHour: over.priceHeadHour ?? 0n,
      drawdownTripTs: over.drawdownTripTs ?? 0n,
    } as unknown as Live["vault"],
    queue: {
      current: { ...epoch, ...over.current },
      next: epoch,
    } as unknown as Live["queue"],
    slot: 0n,
    now: over.now ?? BigInt(T0),
    fetchedAt: T0,
  };
}

export const A = (s: string) => s.padEnd(32, "1") as Address;

/** A ticket row: 1 USDC at a 3.5 % margin, opened a minute before T0, still drawing. */
export const ticketRow = (over: Partial<TicketRow> = {}): TicketRow => ({
  ticket: A("t"),
  integrator: A("i"),
  beneficiary: A("b"),
  price: USDC,
  payoutMax: 2n * USDC,
  vaultCredit: USDC,
  marginBps: 350n,
  appShareBps: 0n,
  openedAt: T0 - 60,
  openSig: "s" as Signature,
  end: null,
  ...over,
});

export const ticketLog = (rows: TicketRow[], over: Partial<TicketLog> = {}): TicketLog => ({
  rows,
  loneEnds: [],
  from: T0 - 7 * DAY,
  truncated: false,
  ...over,
});

/**
 * A seeded generator (mulberry32): `int(n)` in [0, n), `big(lo, hi)` in [lo, hi], `pick(xs)`.
 * Deterministic, so a failure names a case that can be replayed.
 */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  /** Uniform on a log scale between lo and hi, so small and huge values both come up. */
  const big = (lo: bigint, hi: bigint): bigint => {
    if (hi <= lo) return lo;
    const span = hi - lo;
    const digits = span.toString().length;
    const d = 1 + int(digits);
    let v = 0n;
    for (let i = 0; i < d; i++) v = v * 10n + BigInt(int(10));
    return lo + (v % (span + 1n));
  };
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  return { next, int, big, pick };
}
