// The booster's payout table: a premium pack (ten packs' value), a second pack or no extra, for
// an add-on of 2% of the pack, checked against the app's mirror of the program's rules.
import { describe, expect, it } from "vitest";
import type { RiskParams } from "../../../clients/js/src/generated/fade/index.ts";
import {
  M_CEILING_BPS,
  P_SCALE,
  marginBps,
  quote,
  summarize,
} from "../../../apps/web/src/lib/math.ts";
import {
  DEMO_APP_SHARE_BPS,
  DEMO_MARGIN_BPS,
  NO_EXTRA,
  PACK_RANGE,
  PREMIUM,
  SECOND_PACK,
  boosterPayoutTable,
  boosterPayouts,
  boosterWinP,
  packTicket,
} from "../../../apps/web/src/lib/payoutTables.ts";

const USDC = 1_000_000n;

/** The devnet params as read from the Config account. */
const PARAMS: RiskParams = {
  kellyFractionBps: 5000n,
  censorshipBps: 150n,
  whaleBps: 2000n,
  utilisationBreakerBps: 7000n,
  kappaBps: 8000n,
  drawdownBps: 1500n,
  minPrice: 100_000n,
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
  // Shared beacon (Spec 08 §13.3): RiskParams::SPEC.
  beaconMinPrice: 500_000n,
  beaconThreshold: 8_640_000n,
  roundK: 1n,
  tickSlots: 37n,
  refundSlots: 1_715n,
  crankRoundSettleLamports: 20_000n,
};

const admit = (pack: bigint, assets: bigint) =>
  quote({
    outcomes: boosterPayoutTable(pack),
    price: packTicket(pack),
    appShareBps: DEMO_APP_SHARE_BPS,
    params: PARAMS,
    vault: { assets, reserved: 0n, openCredits: 0n },
  });

describe("booster payout table", () => {
  const packs = [5n, 10n, 25n, 100n].map((n) => n * USDC);

  it.each(packs)("is valid and keeps the demo margin for a %s micro-USDC pack", (pack) => {
    const outcomes = boosterPayoutTable(pack);
    const s = summarize(outcomes);
    if ("problem" in s) throw new Error(s.problem);
    expect(outcomes.reduce((sum, b) => sum + b.p, 0n)).toBe(P_SCALE);
    expect(s.lhs).toBeLessThanOrEqual((10_000n - DEMO_MARGIN_BPS) * P_SCALE);
    expect(marginBps(s.lhs)).toBe(DEMO_MARGIN_BPS);
    expect(s.maxM).toBeLessThanOrEqual(M_CEILING_BPS);
  });

  it.each(packs)("pays ten packs, one pack or nothing for a %s micro-USDC pack", (pack) => {
    const price = packTicket(pack);
    expect(price * 50n).toBe(pack);
    const outcomes = boosterPayoutTable(pack);
    const paid = outcomes.map((b) => (price * b.m) / 10_000n);
    expect(paid).toEqual([...boosterPayouts(pack)]);
    expect(paid).toEqual([10n * pack, pack, 0n]);
    expect(outcomes[NO_EXTRA]!.m).toBe(0n);
  });

  it.each(packs)("splits the expected return evenly for a %s micro-USDC pack", (pack) => {
    const outcomes = boosterPayoutTable(pack);
    const premium = outcomes[PREMIUM]!;
    const second = outcomes[SECOND_PACK]!;
    // 9 650 bps of the ticket come back on average: half through each win
    expect(premium.p * premium.m).toBe(4_825n * P_SCALE);
    expect(second.p * second.m).toBe(4_825n * P_SCALE);
    // the table is the same for every pack: a fiftieth of the pack buys it
    expect(premium).toEqual({ p: 965_000n, m: 5_000_000n });
    expect(second).toEqual({ p: 9_650_000n, m: 500_000n });
    expect(outcomes[NO_EXTRA]!.p).toBe(989_385_000n);
    // 1 in 1,036 for a premium pack, 1 in 104 for a second, 1 in 94 for either
    expect(Math.round(Number(P_SCALE) / Number(premium.p))).toBe(1036);
    expect(Math.round(Number(P_SCALE) / Number(second.p))).toBe(104);
    expect(Math.round(Number(P_SCALE) / Number(boosterWinP(outcomes)))).toBe(94);
  });

  it("is admitted by a 20 000 USDC vault for the 5 USDC pack, not for the 100 USDC one", () => {
    expect(admit(PACK_RANGE[0], 20_000n * USDC).refusal).toBeNull();
    // a premium pack of 1 000 USDC exceeds the per-ticket cap of such a vault
    expect(admit(PACK_RANGE[1], 20_000n * USDC).refusal).toBe("PerTicketCap");
    expect(admit(PACK_RANGE[1], 1_000_000n * USDC).refusal).toBeNull();
  });
});
