// The Dashboard's figures: one wallet's place in the vault (its book, from its history and its
// open requests) and its tickets as a buyer, or as an app opening them for others. Pure, so
// each figure is tested on its own (tests/ts/web/dashboard.test.ts).
import { fixed } from "./format";
import { BPS } from "./math";
import type { PendingRequest } from "./position";
import {
  bookOf,
  flowsOf,
  movesOf,
  type Book,
  type Flow,
  type LogItem,
  type Move,
} from "./positionPnl";
import type { TicketKind, TicketRow } from "./ticketLog";
import { buyerLine, type Line } from "./ticketWords";

export type VaultModel = {
  moves: Move[];
  /** The history explains the wallet's fvUSDC: the P&L can be told. */
  reconciled: boolean;
  book: Book;
  flows: Flow[];
};

/**
 * The owner's book from their history and their open requests: an open withdrawal counts at
 * what it delivered by the chain (what it paid, less what is parked) plus what it is worth now.
 */
export function vaultModel(
  ownerLog: readonly LogItem[],
  pending: readonly PendingRequest[],
  walletShares: bigint,
): VaultModel {
  const moves = movesOf(
    ownerLog,
    pending.filter((r) => r.kind === "deposit").map((r) => r.epochId),
    pending
      .filter((r) => r.kind === "withdraw")
      .map((r) => {
        const w = r.withdraw?.data;
        const delivered = w ? w.paid - w.undelivered : 0n;
        return { epochId: r.epochId, delivered: delivered > 0n ? delivered : 0n, due: r.value };
      }),
  );
  const flows = flowsOf(moves);
  const book = bookOf(flows);
  return { moves, flows, book, reconciled: book.shares === walletShares };
}

/** What this position could take at the next close: its value, up to what the vault can pay out. */
export const withdrawableFor = (value: bigint, available: bigint) =>
  value < available ? value : available;

/** A share of the vault in basis points as "12.3%", rounded down: never "100.0%" short of it. */
export const sharePct = (bps: bigint) => `${fixed(bps, 2, 1)}%`;

export type TicketStats = {
  draws: number;
  /** Tickets whose draw paid something. */
  wins: number;
  /** Payouts, micro-USDC. */
  won: bigint;
  /** Ticket prices paid, micro-USDC. */
  spent: bigint;
  best: TicketRow | null;
  /** Wins over draws, in whole percent, rounded to the nearest. */
  winRate: number;
  /** Tickets per kind of demo, and the most frequent one (the first seen on a tie). */
  byKind: Map<TicketKind, number>;
  favourite: [TicketKind, number] | null;
};

/** The Tickets tab's figures over a wallet's tickets; `demo` says which came from the demos. */
export function ticketStats(
  rows: readonly TicketRow[],
  demo: (r: TicketRow) => boolean,
  line: (r: TicketRow, demoApp: boolean) => Line & { kind: TicketKind } = buyerLine,
): TicketStats {
  let won = 0n;
  let spent = 0n;
  let wins = 0;
  let best: TicketRow | null = null;
  const byKind = new Map<TicketKind, number>();
  for (const r of rows) {
    const payout = r.end?.payout ?? 0n;
    won += payout;
    spent += r.price;
    if (payout > 0n) {
      wins += 1;
      if (!best || payout > (best.end?.payout ?? 0n)) best = r;
    }
    const k = line(r, demo(r)).kind;
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  const favourite = [...byKind.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const winRate = rows.length ? Math.round((wins * 100) / rows.length) : 0;
  return { draws: rows.length, wins, won, spent, best, winRate, byKind, favourite };
}

/**
 * "My app": the app share its tickets earned, what its customers won, and its open exposure
 * against the cap per app (`whale_bps · assets`), in percent of that cap, to 100.
 */
export function appFigures(
  rows: readonly TicketRow[],
  reservedLiability: bigint,
  totalAssets: bigint,
  whaleBps: bigint,
) {
  const appShare = rows.reduce((n, r) => n + (r.price * r.appShareBps) / BPS, 0n);
  const paid = rows.reduce((n, r) => n + (r.end?.payout ?? 0n), 0n);
  const cap = (totalAssets * whaleBps) / BPS;
  const used = cap === 0n ? 0 : Math.min(100, Number((reservedLiability * 10_000n) / cap) / 100);
  return { appShare, paid, cap, used };
}
