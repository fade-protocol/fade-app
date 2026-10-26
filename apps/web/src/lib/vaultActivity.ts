// The Activity tab's lines (pages/vault/Activity.tsx): one per ticket (its opening, draw and
// settlement told as one sentence) and one per deposit or withdrawal request, newest first. The
// keeper's feed (GET /v1/feed, lib/keeperViews) serves the newest tickets and requests; behind
// them come those the app read itself and the feed does not hold (the vault's history, and the
// program's tickets once the visitor asks for older lines), so the list reaches as far back as
// the app's own reads do. A withdrawal is valued at the share price of the close in force at its
// time, looked up in the keeper's closes led by the app's own older ones.
import type { FeedRequest, FeedRow } from "./keeperViews";
import type { LpItem } from "./history";
import { priceAt, valueAt } from "./positionPnl";
import { shares as fmtShares, usdc, usdcTidy as amount } from "./format";
import type { TicketRow } from "./ticketLog";
import { vaultLine, type LineTone } from "./ticketWords";
import type { StrikePoint } from "./vaultFigures";

/** A deposit or withdrawal request, from the keeper's feed or the vault's history. */
export type ActivityRequest = {
  /** The transaction's signature and the request's rank among its requests, as the keeper keys it. */
  key: string;
  t: number | null;
  signature: string;
} & ({ kind: "deposit"; amount: bigint } | { kind: "withdrawal"; shares: bigint });

/** One line of the list (components/EventRows). */
export type ActivityRow = {
  kind: "ticket" | "lp";
  key: string;
  stateKey?: string;
  t: number | null;
  title: string;
  detail: string;
  amount: string;
  tone: LineTone;
  win?: boolean;
  drawing?: boolean;
  signature: string;
  /** Behind the keeper's newest lines, from what the app read itself: not an arrival. */
  older?: true;
};

type Ticket = FeedRow | TicketRow;

/** The requests of the keeper's feed. */
export const feedRequestsOf = (requests: readonly FeedRequest[]): ActivityRequest[] =>
  requests.map((r) => ({ ...r, key: `${r.signature}-${r.index}`, t: r.at }));

/** The requests of the vault's history, keyed as the keeper keys them. */
export function requestsOf(items: readonly LpItem[]): ActivityRequest[] {
  return items.flatMap((item) => {
    let index = 0;
    return item.events.flatMap((e): ActivityRequest[] => {
      if (e.kind !== "DepositRequested" && e.kind !== "WithdrawRequested") return [];
      const base = {
        key: `${item.signature}-${index++}`,
        t: item.blockTime,
        signature: item.signature,
      };
      return e.kind === "DepositRequested"
        ? [{ ...base, kind: "deposit", amount: e.data.amount }]
        : [{ ...base, kind: "withdrawal", shares: e.data.shares }];
    });
  });
}

/**
 * The closes a withdrawal's price is looked up in: the keeper's, led by the app's own closes
 * older than its first (it serves 30 days; the app's history may reach further), then today's
 * point.
 */
export function withOlderCloses(
  keeper: readonly StrikePoint[],
  own: readonly StrikePoint[] | null,
  live: StrikePoint | null,
): StrikePoint[] {
  const first = keeper[0];
  const older = (own ?? []).filter(
    (p) =>
      p.epochId !== null &&
      (!first || first.epochId === null || (p.epochId < first.epochId && p.t <= first.t)),
  );
  return [...older, ...keeper, ...(live ? [live] : [])];
}

/** `head`, then the entries of `tail` it does not hold, marked as older. */
function behind<T>(
  head: readonly T[],
  tail: readonly T[] | null,
  key: (x: T) => string,
): { x: T; older: boolean }[] {
  const held = new Set(head.map(key));
  return [
    ...head.map((x) => ({ x, older: false })),
    ...(tail ?? []).filter((x) => !held.has(key(x))).map((x) => ({ x, older: true })),
  ];
}

/**
 * The lines, newest first: the tickets and the requests of `head` (the keeper's feed, or the
 * app's own reads when it cannot serve them), then those of `tail` (the app's own, behind the
 * feed) the head does not hold. `prices`, oldest first, values each withdrawal.
 */
export function activityRows(i: {
  tickets: { head: readonly Ticket[]; tail: readonly Ticket[] | null };
  requests: { head: readonly ActivityRequest[]; tail: readonly ActivityRequest[] | null };
  prices: readonly { t: number; price: bigint }[];
  now: number;
}): ActivityRow[] {
  const out: ActivityRow[] = [];
  for (const { x: r, older } of behind(i.tickets.head, i.tickets.tail, (r) => r.ticket)) {
    const l = vaultLine(r, false);
    out.push({
      kind: "ticket",
      key: r.ticket,
      stateKey: `${r.ticket}:${r.end?.kind ?? "open"}`,
      t: r.openedAt,
      title: l.title,
      detail: l.detail,
      amount: l.amount,
      tone: l.tone,
      win: l.tone === "won",
      drawing: !r.end,
      signature: r.end?.signature ?? r.openSig,
      ...(older ? { older: true as const } : {}),
    });
  }
  for (const { x: q, older } of behind(i.requests.head, i.requests.tail, (q) => q.key)) {
    const base = {
      kind: "lp" as const,
      key: q.key,
      t: q.t,
      signature: q.signature,
      tone: "plain" as const,
      ...(older ? { older: true as const } : {}),
    };
    if (q.kind === "deposit")
      out.push({
        ...base,
        title: "Deposit",
        detail: `a liquidity provider added ${amount(q.amount)} USDC`,
        amount: `+${amount(q.amount)}`,
      });
    else {
      const p = priceAt(i.prices, q.t ?? i.now);
      out.push({
        ...base,
        title: "Withdrawal",
        detail: `a liquidity provider took out ${fmtShares(q.shares)} fvUSDC`,
        amount: p === null ? "" : `−${usdc(valueAt(q.shares, p))}`,
      });
    }
  }
  return out.sort((a, b) => (b.t ?? i.now) - (a.t ?? i.now));
}

/**
 * The lines the list shows while the program's tickets are not read: those at or after the
 * feed's horizon (lib/keeperViews `feedHorizon`), every ticket opened since being in the feed;
 * older ones would stand where others of their time are missing. Null `horizon`: every line.
 * Returns them and how many it holds back.
 */
export function withinHorizon(
  rows: readonly ActivityRow[],
  horizon: number | null,
  now: number,
): { shown: ActivityRow[]; held: number } {
  if (horizon === null) return { shown: [...rows], held: 0 };
  const shown = rows.filter((r) => (r.t ?? now) >= horizon);
  return { shown, held: rows.length - shown.length };
}

/**
 * Whether the Activity list asks for the program's tickets (`onOlder`): for the Wins filter, for
 * "Show more" on the full list, and for a first page that the feed's horizon cuts short; never
 * for the deposits and withdrawals alone, which the feed and the vault's history hold in full.
 */
export function needsOlderTickets(i: {
  filter: "all" | "wins" | "lp";
  /** Lines asked for: the page, and a page more for each "Show more". */
  count: number;
  page: number;
  /** Lines of the filter shown, and lines held back past the horizon. */
  shown: number;
  held: number;
}): boolean {
  if (i.filter === "wins") return true;
  if (i.filter === "lp") return false;
  return i.count > i.page || (i.held > 0 && i.shown < i.count);
}
