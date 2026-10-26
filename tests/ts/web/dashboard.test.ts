// The Dashboard and the vault's position card: one wallet's value, P&L, entry price, share of
// the vault, withdrawable now, last 7 days and chart; its tickets (draws, wins, won, spent, best
// win, win rate, favourite); "My app"; and the Providers table. The figures must agree with each
// other: P&L = value + withdrawn − deposited, the chart ends on the value shown, a share of the
// vault never passes 100 %, withdrawable never passes the position.
import type { Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  appFigures,
  sharePct,
  ticketStats,
  vaultModel,
  withdrawableFor,
} from "../../../apps/web/src/lib/dashboard.ts";
import type { FadeEvent } from "../../../apps/web/src/lib/events.ts";
import type {
  DepositRequest,
  EpochRecord,
  Vault,
  WithdrawRequest,
} from "../../../apps/web/src/lib/fade.ts";
import { MINUS, signedAmount } from "../../../apps/web/src/lib/format.ts";
import { sharePrice } from "../../../apps/web/src/lib/history.ts";
import {
  ownerShareBps,
  paidProgress,
  pendingRequests,
  summarise,
  type PendingRequest,
} from "../../../apps/web/src/lib/position.ts";
import { providerRows, shareOfBps, valueOf } from "../../../apps/web/src/lib/providers.ts";
import {
  bookOf,
  heldSeries,
  pnlAt,
  pnlOf,
  positionSeries,
  type Flow,
} from "../../../apps/web/src/lib/positionPnl.ts";
import type { TicketEnd, TicketRow } from "../../../apps/web/src/lib/ticketLog.ts";
import { A, DAY, SHARE, T0, USDC, live, rng, ticketRow } from "./fixtures.ts";

const owner = A("owner");
const vaultAcct = (assets: bigint, shares: bigint) =>
  ({ totalAssets: assets, totalShares: shares, openVaultCredits: 0n }) as Vault;

describe("the position's P&L", () => {
  const ev = (kind: FadeEvent["kind"], data: object) =>
    ({ kind, data: { version: 1, owner, ...data } }) as unknown as FadeEvent;
  const item = (t: number, sig: string, events: FadeEvent[]) => ({
    signature: sig as Signature,
    blockTime: t,
    events,
  });

  it("is value + withdrawn − deposited, the same on the card and the dashboard", () => {
    // 1 000 USDC in for 1 000 fvUSDC; 200 fvUSDC out for 210 USDC; 800 fvUSDC left
    const log = [
      item(T0 + 3 * DAY, "c", [
        ev("WithdrawClaimed", {
          epochId: 5n,
          atEpochId: 5n,
          assets: 210n * USDC,
          closed: true,
          delivered: true,
        }),
      ]),
      item(T0 + 2 * DAY, "b", [ev("WithdrawRequested", { epochId: 5n, shares: 200n * SHARE })]),
      item(T0 + 60, "a2", [
        ev("DepositClaimed", { epochId: 3n, shares: 1_000n * SHARE, delivered: true }),
      ]),
      item(T0, "a", [ev("DepositRequested", { epochId: 3n, amount: 1_000n * USDC })]),
    ];
    const v = vaultAcct(1_100n * USDC, 1_000n * SHARE);
    const s = summarise(800n * SHARE, [], log, v);
    const value = valueOf(800n * SHARE, v);
    expect(s.value).toBe(value);
    expect(s.history!.deposited).toBe(1_000n * USDC);
    expect(s.history!.withdrawn).toBe(210n * USDC);
    expect(s.history!.pnl).toBe(value + 210n * USDC - 1_000n * USDC);
    expect(s.history!.unexplainedShares).toBe(0n);
    // the dashboard's book from the same history: total = unrealized + realized = the same P&L
    const model = vaultModel(log, [], 800n * SHARE);
    expect(model.reconciled).toBe(true);
    expect(pnlOf(model.book, value).total).toBe(s.history!.pnl);
    expect(pnlOf(model.book, value).total).toBe(
      value + model.book.withdrawn - model.book.deposited,
    );
  });

  it("does not tell a P&L the history cannot explain", () => {
    const model = vaultModel([], [], 5n * SHARE);
    expect(model.reconciled).toBe(false);
  });

  it("holds the identity over random histories, open withdrawals included", () => {
    const r = rng(70);
    for (let i = 0; i < 500; i++) {
      const flows: Flow[] = [];
      let held = 0n;
      let t = T0;
      for (let k = 0; k < 1 + r.int(8); k++) {
        t += r.int(5 * DAY);
        if (held === 0n || r.int(2)) {
          const assets = r.big(USDC, 10n ** 11n);
          const shares = r.big(1n, assets * 1_000n);
          flows.push({ kind: "deposit", t, assets, shares });
          held += shares;
        } else {
          const shares = r.big(1n, held);
          flows.push({ kind: "withdraw", t, assets: r.big(0n, 10n ** 11n), shares });
          held -= shares;
        }
      }
      const b = bookOf(flows);
      expect(b.shares).toBe(held);
      const value = r.big(0n, 10n ** 12n);
      const p = pnlOf(b, value);
      expect(p.total).toBe(value + b.withdrawn - b.deposited);
      expect(p.total).toBe(p.unrealized + p.realized);
      expect(b.cost >= 0n).toBe(true);
      if (held === 0n) expect(b.cost).toBe(0n);
      // the chart ends on the value shown, and its last P&L is the P&L shown
      const prices = [
        { t: T0 - DAY, price: USDC },
        { t: t + DAY, price: r.big(1n, 3n * USDC) },
      ];
      const series = positionSeries(flows, prices, t + DAY, value);
      expect(series.at(-1)).toEqual({ t: t + DAY, value, pnl: p.total });
      // last 7 days: today's P&L less the P&L a week ago, read from the same series
      const week = p.total - pnlAt(series, t + DAY - 7 * DAY);
      expect(week).toBe(series.at(-1)!.pnl - pnlAt(series, t + DAY - 7 * DAY));
    }
  });

  it("charts a position it cannot explain by its value only, ending on the value shown", () => {
    const prices = [
      { t: T0 - 100 * DAY, price: 900_000n },
      { t: T0 - 2 * DAY, price: 1_000_000n },
      { t: T0, price: 1_049_999n },
    ];
    const s = heldSeries(10n * SHARE, prices, T0, 10_499_999n);
    expect(s.map((p) => p.t)).toEqual([T0 - 2 * DAY, T0]);
    expect(s.map((p) => p.value)).toEqual([10n * USDC, 10_499_999n]);
    expect(s.every((p) => p.pnl === 0n)).toBe(true);
  });

  it("ends the chart on the program's value, not on a price rounded first", () => {
    // the live price is rounded down to the micro-USDC; the value is not rounded twice
    const v = vaultAcct(1_234_567_891n, 1_000_000_000_007n);
    const shares = 777_777_777_777n;
    const live = sharePrice(v.totalAssets, v.totalShares)!;
    const value = valueOf(shares, v);
    const flows: Flow[] = [{ kind: "deposit", t: T0, assets: 900n * USDC, shares }];
    const series = positionSeries(flows, [{ t: T0 + DAY, price: live }], T0 + DAY, value);
    expect(series.at(-1)!.value).toBe(value);
    expect(series.at(-1)!.pnl).toBe(pnlOf(bookOf(flows), value).total);
  });
});

describe("the position's figures", () => {
  it("never lets a share of the vault pass 100 %, nor read 100.0 % short of it", () => {
    expect(sharePct(9_996n)).toBe("99.9%");
    expect(sharePct(10_000n)).toBe("100.0%");
    expect(sharePct(5n)).toBe("0.0%");
    expect(shareOfBps(1n, 3n)).toBe(3_333n);
    expect(shareOfBps(1n, 0n)).toBe(0n);
  });

  it("counts open withdrawals' escrowed shares in the owner's share of the vault", () => {
    const req = (phase: PendingRequest["phase"], amount: bigint, queuedShares?: bigint) =>
      ({
        kind: "withdraw",
        phase,
        amount,
        ...(queuedShares !== undefined ? { queuedShares } : {}),
      }) as PendingRequest;
    expect(ownerShareBps(null, [], 100n)).toBeNull();
    expect(ownerShareBps(10n, [], 0n)).toBeNull();
    expect(ownerShareBps(10n * SHARE, [req("queued", 15n * SHARE)], 100n * SHARE)).toBe(2_500n);
    // rationed: only the shares still queued; parked: none (they were paid)
    expect(
      ownerShareBps(
        10n * SHARE,
        [req("rationed", 15n * SHARE, 5n * SHARE), req("parked", 9n * SHARE)],
        100n * SHARE,
      ),
    ).toBe(1_500n);
  });

  it("keeps every provider's share at or under 100 % in all, over random vaults", () => {
    const r = rng(71);
    for (let i = 0; i < 300; i++) {
      const n = 1 + r.int(20);
      const holders = Array.from({ length: n }, (_, k) => ({
        owner: A(`h${k % 7}`),
        amount: r.big(1n, 10n ** 13n),
      }));
      const withdraws = Array.from({ length: r.int(5) }, (_, k) => ({
        address: A(`w${k}`),
        data: {
          owner: A(`h${k}`),
          epochId: BigInt(k + 1),
          shares: r.big(1n, 10n ** 12n),
          rEntry: 0n,
          parked: false,
          chainId: 0n,
        } as WithdrawRequest,
      }));
      const deposits = Array.from({ length: r.int(5) }, (_, k) => ({
        address: A(`d${k}`),
        data: {
          owner: A(`n${k}`),
          epochId: 9n,
          amount: r.big(1n, 10n ** 10n),
          parked: false,
        } as DepositRequest,
      }));
      const total =
        holders.reduce((s, h) => s + h.amount, 0n) +
        withdraws.reduce((s, w) => s + w.data.shares, 0n);
      const rows = providerRows(holders, deposits, withdraws, []);
      const sum = rows.reduce((s, row) => s + shareOfBps(row.shares + row.sharesOut, total), 0n);
      expect(sum).toBeLessThanOrEqual(10_000n);
      expect(10_000n - sum).toBeLessThan(BigInt(rows.length));
      // every provider once, the largest holding first, new depositors listed too
      expect(new Set(rows.map((x) => x.owner)).size).toBe(rows.length);
      for (let k = 1; k < rows.length; k++)
        expect(
          rows[k - 1]!.shares + rows[k - 1]!.sharesOut >= rows[k]!.shares + rows[k]!.sharesOut,
        ).toBe(true);
      expect(rows.reduce((s, x) => s + x.depositIn, 0n)).toBe(
        deposits.reduce((s, d) => s + d.data.amount, 0n),
      );
    }
  });

  it("never offers more withdrawable than the position, nor than the vault can pay", () => {
    expect(withdrawableFor(100n, 40n)).toBe(40n);
    expect(withdrawableFor(30n, 40n)).toBe(30n);
    const r = rng(72);
    for (let i = 0; i < 500; i++) {
      const value = r.big(0n, 10n ** 12n);
      const available = r.big(0n, 10n ** 12n);
      const w = withdrawableFor(value, available);
      expect(w <= value && w <= available).toBe(true);
    }
  });

  it("splits a withdrawal paid in parts into paid, to claim and to come, adding up", () => {
    const bar = paidProgress(40n * USDC, 10n * USDC, 100n * USDC)!;
    expect(bar).toEqual({
      paid: 40n * USDC,
      now: 10n * USDC,
      toCome: 50n * USDC,
      paidPct: 40,
      nowPct: 10,
    });
    expect(paidProgress(0n, 0n, 0n)).toBeNull();
    // never a negative "to come"
    expect(paidProgress(60n, 50n, 100n)!.toCome).toBe(0n);
  });

  it("values requests in progress and adds them to the P&L", () => {
    const state = live({
      assets: 1_000n * USDC,
      shares: 1_000n * SHARE,
      current: { live: true, epochId: 9n, closeTs: BigInt(T0 + 60) },
    });
    const dep = {
      address: A("d"),
      data: {
        owner,
        epochId: 9n,
        amount: 50n * USDC,
        parked: false,
        sharesDue: 0n,
      } as DepositRequest,
    };
    const wd = {
      address: A("w"),
      data: {
        owner,
        epochId: 9n,
        shares: 100n * SHARE,
        rEntry: 0n,
        vEntry: 0n,
        paid: 0n,
        chainId: 0n,
        undelivered: 0n,
        parked: false,
      } as WithdrawRequest,
    };
    const pending = pendingRequests([dep], [wd], [], {
      vault: state.vault,
      queue: state.queue,
      now: BigInt(T0),
    });
    expect(pending.map((p) => [p.kind, p.phase, p.value])).toEqual([
      ["deposit", "queued", 50n * USDC],
      ["withdraw", "queued", valueOf(100n * SHARE, state.vault)],
    ]);
    const s = summarise(0n, pending, [], state.vault);
    expect(s.pendingIn).toBe(50n * USDC);
    expect(s.pendingOut).toBe(valueOf(100n * SHARE, state.vault));
    expect(s.history!.pnl).toBe(
      s.value + s.pendingIn + s.pendingOut + s.history!.withdrawn - s.history!.deposited,
    );
    // a struck deposit is valued at the shares it is due
    const rec = {
      address: A("r"),
      data: {
        epochId: 9n,
        deposits: 100n * USDC,
        sharesMinted: 99n * SHARE,
        struckTs: BigInt(T0),
      } as EpochRecord,
    };
    const [struck] = pendingRequests([dep], [], [rec], {
      vault: state.vault,
      queue: state.queue,
      now: BigInt(T0),
    });
    expect(struck!.phase).toBe("claimable");
    expect(struck!.sharesDue).toBe((50n * USDC * 99n * SHARE) / (100n * USDC));
    expect(struck!.value).toBe(valueOf(struck!.sharesDue!, state.vault));
  });

  it("writes the P&L with its sign, and a zero as zero", () => {
    expect(signedAmount(12_340_000n)).toBe("+12.34");
    expect(signedAmount(-12_340_000n)).toBe(`${MINUS}12.34`);
    expect(signedAmount(-3n)).toBe("0.00");
  });
});

describe("the Tickets tab", () => {
  const end = (payout: bigint, kind: TicketEnd["kind"] = "settled"): TicketEnd => ({
    kind,
    payout,
    pending: false,
    at: T0,
    signature: "e" as Signature,
  });

  it("counts draws, wins, won, spent, the best win, the win rate and the favourite", () => {
    const rows: TicketRow[] = [
      // a booster add-on of 0.10 that won a second pack (5 USDC)
      ticketRow({ ticket: A("1"), price: 100_000n, payoutMax: 50n * USDC, end: end(5n * USDC) }),
      ticketRow({ ticket: A("2"), price: 100_000n, payoutMax: 50n * USDC, end: end(0n) }),
      ticketRow({ ticket: A("3"), price: 100_000n, payoutMax: 50n * USDC }),
      // a swap ticket of 1 USDC won back 75.10
      ticketRow({ ticket: A("4"), price: USDC, payoutMax: 75_100_000n, end: end(75_100_000n) }),
      ticketRow({ ticket: A("5"), price: USDC, payoutMax: 75_100_000n, end: end(0n, "expired") }),
    ];
    const s = ticketStats(rows, () => true);
    expect(s.draws).toBe(5);
    expect(s.wins).toBe(2);
    expect(s.won).toBe(80_100_000n);
    expect(s.spent).toBe(2_300_000n);
    expect(s.best?.ticket).toBe(A("4"));
    expect(s.winRate).toBe(40);
    expect(s.favourite).toEqual(["Booster", 3]);
    expect([...s.byKind.values()].reduce((a, b) => a + b, 0)).toBe(5);
    expect(ticketStats([], () => true)).toMatchObject({
      draws: 0,
      wins: 0,
      won: 0n,
      spent: 0n,
      best: null,
      winRate: 0,
      favourite: null,
    });
  });

  it("keeps its figures consistent over random wallets", () => {
    const r = rng(73);
    for (let i = 0; i < 500; i++) {
      const rows = Array.from({ length: r.int(40) }, (_, k) => {
        const price = r.big(10_000n, 20n * USDC);
        const payoutMax = r.pick([
          price * 500n,
          185_900_000n + price,
          r.big(price * 2n, price * 900n),
        ]);
        const outcome = r.int(4);
        return ticketRow({
          ticket: A(`x${k}`),
          price,
          payoutMax,
          end:
            outcome === 0
              ? null
              : end(
                  outcome === 1 ? r.big(1n, payoutMax) : 0n,
                  outcome === 3 ? "expired" : "settled",
                ),
        });
      });
      const s = ticketStats(rows, () => r.int(2) === 1);
      const winners = rows.filter((x) => (x.end?.payout ?? 0n) > 0n);
      expect(s.draws).toBe(rows.length);
      expect(s.wins).toBe(winners.length);
      expect(s.won).toBe(winners.reduce((a, x) => a + x.end!.payout, 0n));
      expect(s.spent).toBe(rows.reduce((a, x) => a + x.price, 0n));
      // won − spent is the buyer's result, ticket by ticket
      expect(s.won - s.spent).toBe(rows.reduce((a, x) => a + (x.end?.payout ?? 0n) - x.price, 0n));
      expect([...s.byKind.values()].reduce((a, b) => a + b, 0)).toBe(rows.length);
      expect(s.winRate).toBe(rows.length ? Math.round((winners.length * 100) / rows.length) : 0);
      expect(s.winRate >= 0 && s.winRate <= 100).toBe(true);
      if (s.best) for (const x of winners) expect(x.end!.payout <= s.best.end!.payout).toBe(true);
      if (s.favourite) for (const n of s.byKind.values()) expect(n <= s.favourite[1]).toBe(true);
    }
  });
});

describe("My app", () => {
  it("sums its app share and its customers' winnings, and its exposure against the cap per app", () => {
    const rows = [
      ticketRow({
        price: 10n * USDC,
        appShareBps: 150n,
        end: {
          kind: "settled",
          payout: 25n * USDC,
          pending: false,
          at: T0,
          signature: "e" as Signature,
        },
      }),
      ticketRow({ price: 3n * USDC, appShareBps: 33n }),
    ];
    const f = appFigures(rows, 500n * USDC, 100_000n * USDC, 2000n);
    // floored per ticket, as the program pays each app share
    expect(f.appShare).toBe(150_000n + 9_900n);
    expect(f.paid).toBe(25n * USDC);
    expect(f.cap).toBe(20_000n * USDC);
    expect(f.used).toBe(2.5);
    expect(appFigures([], 30_000n * USDC, 100_000n * USDC, 2000n).used).toBe(100);
    expect(appFigures([], USDC, 0n, 2000n)).toEqual({ appShare: 0n, paid: 0n, cap: 0n, used: 0 });
  });
  it("counts no app share, and no price spent, on a refunded beacon ticket", () => {
    const beacon = (refunded: boolean): TicketRow =>
      ticketRow({
        price: 100_000n,
        payoutMax: 195_600n,
        appShareBps: 300n,
        end: {
          kind: "expired",
          payout: 0n,
          pending: false,
          ...(refunded ? { refunded: true } : {}),
          at: T0,
          signature: "e" as Signature,
        },
        beacon: {
          round: A("round"),
          payoutTable: A("table"),
          refundTo: A("funder"),
          appShare: 3_000n,
          protocolShare: 200n,
        },
      });
    const rows = [beacon(true), beacon(false)];
    // the forfeit kept its share; the refund gave the whole price back
    expect(appFigures(rows, 0n, 100_000n * USDC, 2000n).appShare).toBe(3_000n);
    expect(ticketStats(rows, () => true).spent).toBe(100_000n);
  });
});
