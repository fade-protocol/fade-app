// The vault page's figures, from the chain's accounts and the histories read: what the header,
// the Risk tab (health, utilisation, the cap per payout, the apps), the Performance tab and the
// Activity tab show. Pure, so each one is tested against the program's own rules
// (tests/ts/web/vaultFigures.test.ts).
import type { ProtocolState } from "./fade";
import type { LpItem, PricePoint } from "./history";
import { BPS, M_CEILING_BPS, payout, perTicketCap, withdrawable, type Vault } from "./math";
import { DEMO_APP_SHARE_BPS, DEMO_MARGIN_BPS } from "./payoutTables";
import { volumeSeries, type TicketLog } from "./ticketLog";

type Live = Extract<ProtocolState, { initialized: true }>;

/** The vault's three counters as the admission arithmetic reads them. */
export const vaultOf = (state: Pick<Live, "vault">): Vault => ({
  assets: state.vault.totalAssets,
  reserved: state.vault.totalReservedLiability,
  openCredits: state.vault.openVaultCredits,
});

/** How long the program halves every cap after a drawdown trip. */
export const HALVED_FOR_S = 48n * 3600n;

/** The drawdown breaker's aftermath: the program halves every per-payout cap for 48 h. */
export const isHalved = (state: Pick<Live, "vault" | "now">) =>
  state.vault.drawdownTripTs !== 0n && state.now < state.vault.drawdownTripTs + HALVED_FOR_S;

/** Open liability plus open tickets' credits: what the vault has promised. */
export const committedOf = (vault: Live["vault"]) =>
  vault.totalReservedLiability + vault.openVaultCredits;

/** Committed over assets, in basis points, rounded down; 0 for an empty vault. */
export const utilisationBps = (vault: Live["vault"]) =>
  vault.totalAssets === 0n ? 0n : (committedOf(vault) * BPS) / vault.totalAssets;

/**
 * What the next close can pay out now ("Available now", "Withdrawable now"): the strike's
 * `risk::withdrawable` on the vault with the live epoch's deposits joined, as strike.rs reads it.
 */
export function availableNow(state: Pick<Live, "vault" | "queue" | "config">): bigint {
  const { vault, queue, config } = state;
  return withdrawable(
    {
      assets: vault.totalAssets + (queue.current.live ? queue.current.deposits : 0n),
      reserved: vault.totalReservedLiability,
      openCredits: vault.openVaultCredits,
    },
    config.params.kappaBps,
  );
}

const PRICE_SCALE = 1_000_000_000_000_000_000n;
const HOURS = 24n;

/**
 * The drawdown breaker as the program reads it (fade-math drawdown.rs): today's share price on the
 * settled assets against the highest of the last 24 hours, and whether it has fallen past the
 * limit. Hours older than the window have left the ring.
 */
export function drawdownOf(state: Pick<Live, "vault" | "config">, now: number) {
  const { vault, config } = state;
  const settled = vault.totalAssets - vault.openVaultCredits;
  const price = (((settled > 0n ? settled : 0n) + 1n) * PRICE_SCALE) / (vault.totalShares + 1_000n);
  const nowHour = BigInt(Math.floor(now / 3600));
  // the ring keeps one maximum per hour; those older than 24 h have left it
  const top = nowHour > vault.priceHeadHour ? nowHour : vault.priceHeadHour;
  const oldest = top - HOURS + 1n;
  let max = price;
  for (let h = oldest; h <= vault.priceHeadHour; h++) {
    const v = vault.priceMaxima[Number(((h % HOURS) + HOURS) % HOURS)] ?? 0n;
    if (v > max) max = v;
  }
  const limit = config.params.drawdownBps;
  const fallBps = max === 0n ? 0n : ((max - price) * 10_000n) / max;
  const tripped = price * 10_000n <= max * (10_000n - limit);
  return { fallBps, limit, tripped };
}

export type CapRow = {
  /** The vault margin the row is for, in bps. */
  margin: bigint;
  /** The per-payout cap at that margin, micro-USDC. */
  cap: bigint;
  /** The largest multiplier a ticket of the minimum price may carry under that cap, in bps, to 0.01×. */
  maxM: bigint;
};

/**
 * The Risk tab's "Max per payout" card: the cap at the demos' vault margin, and the cap and the
 * largest multiplier on a minimum-price ticket at the margin floor, at 1.5 % and at the demos'.
 * A ticket's liability is its payout less its vault credit (risk.rs `liability`), so the payout
 * may reach the cap plus the credit; never above the program's multiplier ceiling.
 */
export function capTable(state: Pick<Live, "vault" | "config" | "now">) {
  const p = state.config.params;
  const vault = vaultOf(state);
  const price = p.minPrice;
  const credit = price - (price * p.protocolShareBps) / BPS;
  // the vault's margin in the demos, after the live protocol share
  const demoMargin = DEMO_MARGIN_BPS - DEMO_APP_SHARE_BPS - p.protocolShareBps;
  const halved = isHalved(state);
  const demoCap = perTicketCap(vault, demoMargin, p, halved);
  const rows: CapRow[] = [p.minVaultMarginBps, 150n, demoMargin]
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((margin) => {
      const cap = perTicketCap(vault, margin, p, halved);
      const m = price === 0n ? 0n : ((cap + credit) * BPS) / price;
      const top = m > M_CEILING_BPS ? M_CEILING_BPS : m;
      return { margin, cap, maxM: top - (top % 100n) };
    });
  return {
    price,
    credit,
    demoMargin,
    demoCap,
    halved,
    rows,
    /** The most one app may hold in open liability: `whale_bps · assets`. */
    appCeiling: (state.vault.totalAssets * p.whaleBps) / BPS,
  };
}

/** The liability of a ticket of `price` at multiplier `m` and vault credit `credit` (risk.rs). */
export const liabilityOf = (price: bigint, m: bigint, credit: bigint) => {
  const max = payout(price, m);
  return max > credit ? max - credit : 0n;
};

/** One app's open liability as a share of the vault, in bps, and of the cap per app, 0 to 100. */
export function appRisk(reserved: bigint, assets: bigint, whaleBps: bigint) {
  const risk = assets === 0n ? 0n : (reserved * BPS) / assets;
  const fill = whaleBps === 0n ? 0 : Math.min(100, (Number(risk) / Number(whaleBps)) * 100);
  return { risk, fill };
}

// --- the Activity tab's four figures --------------------------------------------------------

const DAY = 86400;

export type ActivityFigures = {
  /** Tickets opened over the span. */
  n: number;
  /** Payouts of the tickets settled over the span. */
  paid: bigint;
  /** What the vault kept on those tickets: their vault credits less their payouts. */
  result: bigint;
  /** Deposits less withdrawals paid by the closes of the last 24 h. */
  net: bigint;
  /** "24 h", or less when the read was capped inside the day. */
  span: string;
};

/**
 * The last 24 h of the vault: tickets opened, paid to winners, the vault's result on the tickets
 * that ended, and the net deposits of the closes. A capped ticket read covers less than a day:
 * the figures then say over how long.
 */
export function activityFigures(
  tickets: TicketLog,
  items: readonly LpItem[],
  now: number,
): ActivityFigures {
  const since = Math.max(now - DAY, tickets.truncated && tickets.from ? tickets.from : 0);
  let n = 0;
  let paid = 0n;
  let result = 0n;
  for (const r of tickets.rows) {
    if ((r.openedAt ?? 0) >= since) n += 1;
    const at = r.end?.at ?? null;
    if (r.end && at !== null && at >= since) {
      paid += r.end.payout;
      result += r.vaultCredit - r.end.payout;
    }
  }
  let net = 0n;
  for (const item of items)
    if ((item.blockTime ?? 0) >= now - DAY)
      for (const e of item.events)
        if (e.kind === "EpochStruck") net += e.data.deposits - e.data.assetsPaid;
  const hours = Math.max(1, Math.round((now - since) / 3600));
  return { n, paid, result, net, span: hours >= 24 ? "24 h" : `${hours} h` };
}

// --- the Performance tab: the share price close by close -------------------------------------

export type StrikePoint = Pick<PricePoint, "t" | "price" | "assets" | "epochId"> & {
  carried?: boolean;
};

/** The points from `cut` on, led by the last one before it, carried to `cut`. */
export function fromCut(series: readonly StrikePoint[], cut: number): StrikePoint[] {
  const inside = series.filter((p) => p.t >= cut);
  const before = series.filter((p) => p.t < cut).at(-1);
  return before ? [{ ...before, t: cut, carried: true }, ...inside] : inside;
}

/** The share price's change over the points, in percent; null without a price to start from. */
export function changePct(points: readonly StrikePoint[]): number | null {
  const first = points[0];
  const last = points.at(-1);
  return first && last && first.price > 0n
    ? (Number(last.price - first.price) / Number(first.price)) * 100
    : null;
}

export type CloseMove = {
  epoch: bigint;
  /** The close's change of the share price, in percent. */
  pct: number;
  t: number;
  before: bigint;
  after: bigint;
  assets: bigint;
};

/** Each close's move of the share price, from the close before it. */
export function closeMoves(points: readonly StrikePoint[]): CloseMove[] {
  const strikes = points.filter((p) => p.epochId !== null);
  const moves: CloseMove[] = [];
  for (let i = 1; i < strikes.length; i++) {
    const a = strikes[i - 1]!;
    const b = strikes[i]!;
    if (a.price > 0n && !b.carried)
      moves.push({
        epoch: b.epochId!,
        pct: (Number(b.price - a.price) / Number(a.price)) * 100,
        t: b.t,
        before: a.price,
        after: b.price,
        assets: b.assets,
      });
  }
  return moves;
}

/** The average move and its spread (population standard deviation), in percent. */
export function moveStats(moves: readonly Pick<CloseMove, "pct">[]) {
  if (moves.length === 0) return { mean: 0, sd: 0 };
  const mean = moves.reduce((s, m) => s + m.pct, 0) / moves.length;
  const sd = Math.sqrt(moves.reduce((s, m) => s + (m.pct - mean) ** 2, 0) / moves.length);
  return { mean, sd };
}

// --- the Overview chart --------------------------------------------------------------------

export type ChartSeries = "price" | "deposits" | "volume";
export type ChartRange = "1D" | "7D" | "1M" | "ALL";
const HOUR = 3600;
const RANGE_S: Record<Exclude<ChartRange, "ALL">, number> = {
  "1D": DAY,
  "7D": 7 * DAY,
  "1M": 30 * DAY,
};

/**
 * Where the chart starts: the range back from now, but never before the first data (a young
 * vault's week is not a flat line of nothing), and at least an hour back.
 */
export const windowStart = (range: ChartRange, first: number, now: number) => {
  const earliest = Math.min(first, now - HOUR);
  return range === "ALL" ? earliest : Math.max(earliest, now - RANGE_S[range]);
};

/** The period a volume point totals: the shortest of 15 min, 1 h, 6 h, a day giving at most 48. */
export const bucketFor = (span: number) =>
  [900, HOUR, 6 * HOUR].find((b) => span / b <= 48) ?? 86400;

export type ChartView = {
  points: { t: number; v: number }[];
  from: number;
  to: number;
  /** The figure above the chart: the last point (price, deposits) or the total over the window (volume). */
  headline: number;
  unit: string;
  /** Percent from the window's start to its end; null for the volume or without a start. */
  change: number | null;
};

/**
 * The Overview chart: the share price or the vault's assets after each close then today's, or the
 * ticket volume per bucket over the window. Points in USDC.
 */
export function chartView(
  series: ChartSeries,
  range: ChartRange,
  strikes: readonly PricePoint[] | null,
  tickets: TicketLog | null,
  now: number,
): ChartView | null {
  if (series === "volume") {
    if (!tickets) return null;
    const oldest = tickets.rows.at(-1)?.openedAt ?? tickets.from ?? now - DAY;
    const from = windowStart(range, oldest, now);
    const points = volumeSeries(tickets, from, now, bucketFor(now - from));
    const total = points.reduce((s, p) => s + p.v, 0);
    return { points, from, to: now, headline: total, unit: "USDC of tickets", change: null };
  }
  if (!strikes || strikes.length === 0) return null;
  const pts = strikes.map((p) => ({
    t: p.t,
    v: series === "price" ? Number(p.price) / 1e6 : Number(p.assets) / 1e6,
  }));
  const first = pts[0]!.t;
  const from = windowStart(range, first, now);
  // the value at the window's start: the last point before it, or the first one
  const before = pts.filter((p) => p.t <= from).at(-1) ?? pts[0]!;
  const last = pts[pts.length - 1]!;
  const change = before.v > 0 ? ((last.v - before.v) / before.v) * 100 : null;
  return {
    points: pts,
    from,
    to: now,
    headline: last.v,
    unit: series === "price" ? "USDC per fvUSDC" : "USDC",
    change,
  };
}
