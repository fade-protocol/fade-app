// The deposit / withdraw card: the amount a request carries for what is typed or picked, "you
// receive" at today's price (the program's share arithmetic), "ready in", and the fees in SOL.
import { describe, expect, it } from "vitest";
import {
  DEPOSIT_REQUEST_SPACE,
  TOKEN_ACCOUNT_RENT,
  TX_FEE,
  WITHDRAW_REQUEST_SPACE,
  rentFor,
  requestAmount,
  requestFees,
} from "../../../apps/web/src/lib/actionQuote.ts";
import type { Vault } from "../../../apps/web/src/lib/fade.ts";
import { usdc } from "../../../apps/web/src/lib/format.ts";
import { closeOnGrid, settleEta, valueOf } from "../../../apps/web/src/lib/position.ts";
import { DEVNET, SHARE, T0, USDC, live, rng } from "./fixtures.ts";

const vault = (assets: bigint, shares: bigint) =>
  ({ totalAssets: assets, totalShares: shares, openVaultCredits: 0n }) as Vault;
/** The program's assets_for_shares / shares_for_assets (fade-math shares.rs). */
const assetsFor = (x: bigint, v: Vault) => (x * (v.totalAssets + 1n)) / (v.totalShares + 1_000n);
const sharesFor = (a: bigint, v: Vault) => (a * (v.totalShares + 1_000n)) / (v.totalAssets + 1n);

describe("the amount of a request", () => {
  const v = vault(1_050n * USDC, 1_000n * SHARE);
  const base = {
    pct: null,
    text: "",
    usdcBalance: 500n * USDC,
    shareBalance: 100n * SHARE,
    vault: v,
  };

  it("deposits what is typed, or a share of the wallet, for the shares the program would mint", () => {
    const typed = requestAmount({ ...base, side: "deposit", text: "105" });
    expect(typed.amount).toBe(105n * USDC);
    expect(typed.estimate).toBe(sharesFor(105n * USDC, v));
    expect(requestAmount({ ...base, side: "deposit", pct: 25 }).amount).toBe(125n * USDC);
    expect(requestAmount({ ...base, side: "deposit", pct: 100 }).amount).toBe(500n * USDC);
    expect(requestAmount({ ...base, side: "deposit", text: "1.2345678" })).toEqual({
      amount: null,
      estimate: null,
    });
  });

  it("withdraws the fewest shares worth what is typed, or the whole position a dust away", () => {
    const w = requestAmount({ ...base, side: "withdraw", text: "21" });
    expect(valueOf(w.amount!, v)).toBeGreaterThanOrEqual(21n * USDC);
    expect(valueOf(w.amount! - 1n, v)).toBeLessThan(21n * USDC);
    expect(w.estimate).toBe(assetsFor(w.amount!, v));
    expect(usdc(w.estimate!)).toBe("21.00");
    // the whole position typed in USDC as the card shows it (truncated to the cent) is the whole
    // position: no fvUSDC dust is left behind
    const all = requestAmount({
      ...base,
      side: "withdraw",
      text: usdc(valueOf(100n * SHARE, v)).replace(/,/g, ""),
    });
    expect(all.amount).toBe(100n * SHARE);
    // "Max" is every share, the quick picks a share of them
    expect(requestAmount({ ...base, side: "withdraw", pct: 100 }).amount).toBe(100n * SHARE);
    expect(requestAmount({ ...base, side: "withdraw", pct: 50 }).amount).toBe(50n * SHARE);
    // a cent less than the position shown is a cent less
    const less = requestAmount({ ...base, side: "withdraw", text: "104.98" });
    expect(less.amount! < 100n * SHARE).toBe(true);
    // more than the position stays more: the card refuses it
    expect(requestAmount({ ...base, side: "withdraw", text: "1000" }).amount! > 100n * SHARE).toBe(
      true,
    );
  });

  it("never estimates more than the program would give, over random vaults and amounts", () => {
    const r = rng(60);
    for (let i = 0; i < 3000; i++) {
      const v2 = vault(r.big(0n, 10n ** 13n), r.big(0n, 10n ** 16n));
      const shareBalance = r.big(0n, v2.totalShares);
      const usdcText = usdc(r.big(0n, 10n ** 12n), 6).replace(/,/g, "");
      const dep = requestAmount({
        side: "deposit",
        pct: null,
        text: usdcText,
        usdcBalance: 0n,
        shareBalance,
        vault: v2,
      });
      expect(dep.estimate).toBe(sharesFor(dep.amount!, v2));
      const wd = requestAmount({
        side: "withdraw",
        pct: null,
        text: usdcText,
        usdcBalance: 0n,
        shareBalance,
        vault: v2,
      });
      expect(wd.estimate).toBe(assetsFor(wd.amount!, v2));
      // the shares asked for are worth what was typed, unless the whole position was taken
      if (wd.amount! !== shareBalance) expect(wd.estimate! >= dep.amount!).toBe(true);
      else expect(wd.estimate).toBe(valueOf(shareBalance, v2));
      const pick = requestAmount({
        side: "withdraw",
        pct: r.pick([25, 50, 75, 100]),
        text: "",
        usdcBalance: 0n,
        shareBalance,
        vault: v2,
      });
      expect(pick.amount! <= shareBalance).toBe(true);
    }
  });
});

describe("the fees", () => {
  const params = DEVNET;

  it("charges a first request its delivery fee, the account rents and the network fee", () => {
    const f = requestFees({
      side: "deposit",
      params,
      hasRequest: false,
      fund: 10n ** 9n,
      createsTokenAccount: true,
    });
    expect(f.claimFee).toBe(200_000n);
    expect(f.strikeFee).toBe(0n);
    expect(f.rent).toBe(rentFor(DEPOSIT_REQUEST_SPACE));
    expect(f.rent).toBe((128n + 67n) * 3480n * 2n);
    expect(f.tokenRent).toBe(TOKEN_ACCOUNT_RENT);
    expect(TOKEN_ACCOUNT_RENT).toBe(2_039_280n);
    // fees are what is spent; the rents come back, so only "needed" counts them
    expect(f.fees).toBe(200_000n + TX_FEE);
    expect(f.needed).toBe(f.fees + f.rent + f.tokenRent);
  });

  it("adds the pricing fee while the fund is under its target, and nothing twice", () => {
    const low = requestFees({
      side: "withdraw",
      params,
      hasRequest: false,
      fund: 1n,
      createsTokenAccount: false,
    });
    expect(low.strikeFee).toBe(200_000n);
    expect(low.rent).toBe(rentFor(WITHDRAW_REQUEST_SPACE));
    const again = requestFees({
      side: "withdraw",
      params,
      hasRequest: true,
      fund: null,
      createsTokenAccount: false,
    });
    expect(again).toEqual({
      claimFee: 0n,
      strikeFee: 0n,
      rent: 0n,
      tokenRent: 0n,
      fees: TX_FEE,
      needed: TX_FEE,
    });
  });
});

describe("ready in", () => {
  it("is the live epoch's close, or the next multiple of the epoch length", () => {
    const s = live({ current: { live: true, closeTs: BigInt(T0 + 84) } });
    expect(settleEta(s.queue, s.config.params, T0)).toBe(84);
    // nothing live: a request opens an epoch closing on the grid
    const idle = live();
    expect(settleEta(idle.queue, idle.config.params, T0)).toBe(closeOnGrid(T0, 120) - T0);
    expect(closeOnGrid(240, 120)).toBe(360);
    expect(closeOnGrid(239, 120)).toBe(240);
    const r = rng(61);
    for (let i = 0; i < 500; i++) {
      const now = T0 + r.int(100_000);
      const eta = settleEta(idle.queue, idle.config.params, now);
      expect(eta > 0 && eta <= 120 && (now + eta) % 120 === 0).toBe(true);
    }
  });
});
