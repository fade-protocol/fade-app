// The vault's share arithmetic as the app shows it, against fade-math shares.rs and its tests:
// what a deposit buys, what fvUSDC are worth, the share price, and what a withdrawal paid over
// several closes is due. The program's functions are written out here from the Rust, so the
// app's are checked against the rule itself, not against themselves.
import { describe, expect, it } from "vitest";
import type { EpochRecord, Vault, WithdrawRequest } from "../../../apps/web/src/lib/fade.ts";
import { livePrice, sharePrice, strikeSeries } from "../../../apps/web/src/lib/history.ts";
import { withdrawClaimRecords } from "../../../apps/web/src/lib/lp.ts";
import { queuedOf, sharesFor, sharesWorth, valueOf } from "../../../apps/web/src/lib/providers.ts";
import {
  CHAIN_R_MIN,
  INDEX_SCALE,
  depositDue,
  stillQueued,
  withdrawDue,
} from "../../../apps/web/src/lib/shares.ts";
import { A, SHARE, USDC, rng } from "./fixtures.ts";

// --- fade-math shares.rs, line for line ---------------------------------------------------------
const VS = 1_000n;
const VA = 1n;
const sharesForAssets = (a: bigint, s: bigint, t: bigint) => (a * (s + VS)) / (t + VA);
const assetsForShares = (x: bigint, s: bigint, t: bigint) => (x * (t + VA)) / (s + VS);
const proRata = (req: bigint, total: bigint, avail: bigint) =>
  avail >= total ? req : (req * avail) / total;
const RATION_HOLDBACK = 1_000_000n;
function strike(deposits: bigint, queued: bigint, s: bigint, a: bigint, out: bigint) {
  const minted = sharesForAssets(deposits, s, a);
  const owed = assetsForShares(queued, s, a);
  let paid = owed < out ? owed : out;
  if (paid < owed) {
    const hold = (owed + RATION_HOLDBACK - 1n) / RATION_HOLDBACK;
    const cap = owed > hold ? owed - hold : 0n;
    if (paid > cap) paid = cap;
  }
  return { minted, owed, paid, burnt: proRata(queued, owed, paid) };
}
type Chain = { r: bigint; v: bigint };
const START: Chain = { r: INDEX_SCALE, v: 0n };
const advance = (c: Chain, w: bigint, b: bigint, p: bigint): Chain =>
  w === 0n ? c : { r: (c.r * (w - b)) / w, v: c.v + (c.r * p) / w };

/** A settled vault account with these figures. */
const vaultAcct = (assets: bigint, shares: bigint, openCredits = 0n) =>
  ({ totalAssets: assets, totalShares: shares, openVaultCredits: openCredits }) as Vault;

describe("deposits and values (shares_for_assets, assets_for_shares)", () => {
  it("mints the first deposit at 1 USDC per fvUSDC", () => {
    // MIN_FIRST_DEPOSIT: 100 USDC → 100 000 000 × 1 000 shares
    expect(sharesFor(100n * USDC, vaultAcct(0n, 0n))).toBe(100n * SHARE);
    expect(sharesForAssets(100n * USDC, 0n, 0n)).toBe(100n * SHARE);
    // and the round trip loses at most a micro-USDC, to the vault
    const back = valueOf(100n * SHARE, vaultAcct(100n * USDC, 100n * SHARE));
    expect(back <= 100n * USDC && 100n * USDC - back <= 1n).toBe(true);
  });

  it("prices on the settled assets: open tickets' credits are left out", () => {
    const v = vaultAcct(1_050n * USDC, 1_000n * SHARE, 50n * USDC);
    expect(valueOf(1_000n * SHARE, v)).toBe(
      assetsForShares(1_000n * SHARE, 1_000n * SHARE, 1_000n * USDC),
    );
    expect(sharesFor(10n * USDC, v)).toBe(
      sharesForAssets(10n * USDC, 1_000n * SHARE, 1_000n * USDC),
    );
  });

  it("matches the program on random vaults, and a typed USDC amount leaves no dust", () => {
    const r = rng(20);
    for (let i = 0; i < 5000; i++) {
      const s = r.big(0n, 10n ** 18n);
      const a = r.big(0n, 10n ** 15n);
      const v = vaultAcct(a, s);
      const x = r.big(0n, 10n ** 15n);
      expect(sharesFor(x, v)).toBe(sharesForAssets(x, s, a));
      expect(valueOf(x, v)).toBe(assetsForShares(x, s, a));
      // the fewest shares worth at least x: worth it, and one fewer is not
      const need = sharesWorth(x, v);
      expect(valueOf(need, v)).toBeGreaterThanOrEqual(x);
      if (need > 0n) expect(valueOf(need - 1n, v)).toBeLessThan(x);
      // a deposit is never worth more than it paid, at the price it was minted
      expect(assetsForShares(sharesForAssets(x, s, a), s, a)).toBeLessThanOrEqual(x);
    }
  });

  it("makes the inflation attack a loss for the attacker", () => {
    const attacker = sharesForAssets(1n, 0n, 0n);
    let s = attacker;
    let a = 1n + 1_000_000_000n;
    const victim = sharesFor(999_000_000n, vaultAcct(a, s));
    expect(victim > 0n).toBe(true);
    s += victim;
    a += 999_000_000n;
    expect(valueOf(attacker, vaultAcct(a, s)) < 1n + 1_000_000_000n).toBe(true);
  });
});

describe("the share price shown", () => {
  it("is what one whole fvUSDC is worth as the program pays it", () => {
    // 1:1 vault: exactly 1.000000
    expect(sharePrice(100n * USDC, 100n * SHARE)).toBe(USDC);
    // a vault up 5 %: a whole fvUSDC redeems for 1.049999 USDC (the virtual offsets), so the
    // price reads 1.0499, not the 1.0500 of assets over shares
    expect(sharePrice(105n * USDC, 100n * SHARE)).toBe(1_049_999n);
    expect(valueOf(SHARE, vaultAcct(105n * USDC, 100n * SHARE))).toBe(1_049_999n);
    expect(sharePrice(0n, 0n)).toBeNull();
    const r = rng(21);
    for (let i = 0; i < 3000; i++) {
      const s = r.big(1n, 10n ** 18n);
      const a = r.big(0n, 10n ** 15n);
      expect(sharePrice(a, s)).toBe(assetsForShares(SHARE, s, a));
      // the drawdown breaker's price, scaled from 10¹⁸ to micro-USDC per share
      expect(sharePrice(a, s)).toBe(((a + 1n) * 10n ** 18n) / (s + 1_000n) / 10n ** 9n);
    }
  });

  it("is the live point of the series, on the settled assets", () => {
    const v = { ...vaultAcct(1_100n * USDC, 1_000n * SHARE, 100n * USDC) } as Vault;
    expect(livePrice(v)).toBe(sharePrice(1_000n * USDC, 1_000n * SHARE));
    const series = strikeSeries([], v, 1_000);
    expect(series).toEqual([
      { t: 1_000, price: livePrice(v), assets: 1_000n * USDC, epochId: null },
    ]);
  });

  it("reads each close's price from its event, after the strike's flows", () => {
    const ev = {
      kind: "EpochStruck",
      data: {
        epochId: 4n,
        totalAssets: 1_000n * USDC,
        totalShares: 1_000n * SHARE,
        deposits: 100n * USDC,
        sharesMinted: sharesForAssets(100n * USDC, 1_000n * SHARE, 1_000n * USDC),
        assetsPaid: 50n * USDC,
        sharesBurnt: 50n * SHARE,
      },
    };
    const log = [{ signature: "x" as never, blockTime: 500, events: [ev as never] }];
    const [p] = strikeSeries(log, vaultAcct(1_050n * USDC, 1_050n * SHARE), 1_000);
    expect(p!.assets).toBe(1_050n * USDC);
    expect(p!.price).toBe(
      sharePrice(1_050n * USDC, 1_000n * SHARE + ev.data.sharesMinted - 50n * SHARE),
    );
  });
});

describe("a withdrawal over several closes (Spec 08 §5)", () => {
  it("is claimed once for the exact total, partial claims or not", () => {
    // shares.rs: 500 shares owed 510 USDC receive 400 at epoch k; at k+1 the rest is paid
    const s0 = sharesForAssets(5_000_000_000n, 0n, 0n);
    const assets = 5_100_000_000n;
    const queued = 500n * SHARE;
    const k = strike(1_000_000_000n, queued, s0, assets, 400_000_000n);
    expect(k.owed).toBe(510_000_000n - 1n);
    const c1 = advance(START, queued, k.burnt, k.paid);
    const left = queued - k.burnt;
    const s1 = s0 + k.minted - k.burnt;
    const a1 = assets + 1_000_000_000n - k.paid + 30_000_000n;
    const k2 = strike(0n, left, s1, a1, 2n ** 64n);
    const c2 = advance(c1, left, k2.burnt, k2.paid);
    expect(c2.r).toBe(0n);
    const one = withdrawDue(queued, START.r, START.v, c2.v)!;
    const total = k.paid + k2.paid;
    expect(one <= total && total - one <= 2n).toBe(true);
    expect(withdrawDue(queued, START.r, START.v, c1.v)!).toBeLessThanOrEqual(one);
    expect(stillQueued(queued, START.r, c1.r)).toBe(left);
  });

  it("is read by the claim the program accepts, partial while the chain runs", () => {
    const owner = A("owner");
    const rec = (
      epochId: bigint,
      before: Chain,
      after: Chain,
      over: Partial<EpochRecord> = {},
    ) => ({
      address: A(`r${epochId}`),
      data: {
        epochId,
        chainId: 1n,
        rBefore: before.r,
        vBefore: before.v,
        rAfter: after.r,
        vAfter: after.v,
        struckTs: 100n * epochId,
        ...over,
      } as EpochRecord,
    });
    const s0 = 1_000n * SHARE;
    const a0 = 1_000n * USDC;
    const k1 = strike(0n, 400n * SHARE, s0, a0, 200n * USDC);
    const c1 = advance(START, 400n * SHARE, k1.burnt, k1.paid);
    const request = {
      owner,
      epochId: 1n,
      shares: 400n * SHARE,
      rEntry: 0n,
      vEntry: 0n,
      paid: 0n,
      chainId: 0n,
      undelivered: 0n,
      parked: false,
    } as WithdrawRequest;
    const r1 = rec(1n, START, c1);
    // first claim, chain running: a partial claim of what the strike paid
    const pick = withdrawClaimRecords(request, [r1])!;
    expect(pick.partial).toBe(true);
    expect(pick.dueNow).toBe(withdrawDue(400n * SHARE, START.r, START.v, c1.v));
    expect(pick.dueNow).toBeLessThanOrEqual(k1.paid);
    expect(queuedOf({ ...request, rEntry: START.r, chainId: 1n }, [r1])).toBe(
      stillQueued(400n * SHARE, START.r, c1.r),
    );
    // the next close pays the rest: the claim settles it at the chain's end, less what was paid
    const left = 400n * SHARE - k1.burnt;
    const k2 = strike(0n, left, s0 - k1.burnt, a0 - k1.paid, 2n ** 64n);
    const c2 = advance(c1, left, k2.burnt, k2.paid);
    const after = { ...request, rEntry: START.r, vEntry: START.v, paid: pick.dueNow, chainId: 1n };
    const end = withdrawClaimRecords(after, [r1, rec(2n, c1, c2)])!;
    expect(end.partial).toBe(false);
    expect(end.dueNow + pick.dueNow).toBe(withdrawDue(400n * SHARE, START.r, START.v, c2.v));
    expect(k1.paid + k2.paid - (end.dueNow + pick.dueNow)).toBeLessThanOrEqual(2n);
    // nothing new to pay: no partial claim
    expect(withdrawClaimRecords({ ...after, paid: pick.dueNow }, [r1])).toBeNull();
    expect(CHAIN_R_MIN < INDEX_SCALE).toBe(true);
  });

  it("never pays out more than the strikes paid, over random rationed chains", () => {
    const r = rng(22);
    for (let i = 0; i < 500; i++) {
      let s = r.big(SHARE, 10n ** 15n);
      let a = r.big(USDC, 10n ** 12n);
      const queued = r.big(1n, s);
      let chain = START;
      let left = queued;
      let paidTotal = 0n;
      for (let k = 0; k < 4 && left > 0n; k++) {
        const out = r.int(3) === 0 ? 2n ** 64n : r.big(0n, assetsForShares(left, s, a));
        const st = strike(0n, left, s, a, out);
        chain = advance(chain, left, st.burnt, st.paid);
        paidTotal += st.paid;
        left -= st.burnt;
        s -= st.burnt;
        a -= st.paid;
        const due = withdrawDue(queued, START.r, START.v, chain.v)!;
        expect(due).toBeLessThanOrEqual(paidTotal);
        expect(stillQueued(queued, START.r, chain.r)).toBeLessThanOrEqual(left);
        if (chain.r !== 0n && chain.r < CHAIN_R_MIN) break; // the chain splits there
      }
    }
  });

  it("shares a deposit epoch's minted shares without ever handing out more", () => {
    const minted = 980_392_156_862n;
    const parts = [1n, 333_333_333n, 666_666_666n];
    const deposits = parts.reduce((x, y) => x + y, 0n);
    const paid = parts.reduce((n, a) => n + depositDue(a, deposits, minted)!, 0n);
    expect(paid <= minted && minted - paid < BigInt(parts.length)).toBe(true);
    expect(depositDue(1n, 0n, 5n)).toBeNull();
    expect(depositDue(6n, 5n, 5n)).toBeNull();
    expect(withdrawDue(1n, 0n, 0n, 0n)).toBeNull();
    expect(withdrawDue(1n, 1n, 5n, 4n)).toBeNull();
    expect(stillQueued(1n, 0n, 1n)).toBeNull();
    const r = rng(23);
    for (let i = 0; i < 500; i++) {
      const n = 1 + r.int(20);
      const amounts = Array.from({ length: n }, () => r.big(1n, 10n ** 12n));
      const total = amounts.reduce((x, y) => x + y, 0n);
      const m = r.big(0n, 10n ** 15n);
      const handed = amounts.reduce((sum, x) => sum + depositDue(x, total, m)!, 0n);
      expect(handed <= m && m - handed < BigInt(n)).toBe(true);
    }
  });
});
