// The all-time figures the keeper indexes from the program's history (GET /v1/stats): wins,
// what winners were paid, the biggest and the last win. The program keeps no such counters,
// and the app itself only reads the last days of tickets.
import { API_URL } from "./config";
import type { TicketKind } from "./ticketKind";

export type StatsWin = {
  /** Micro-USDC. */
  payout: bigint;
  kind: TicketKind | null;
  ticket: string;
  /** Unix seconds, or null when the cluster did not date it. */
  at: number | null;
};

export type StatsSplit = {
  ticketsOpened: number;
  /** Tickets whose draw ran, win or not. */
  ticketsDrawn: number;
  wins: number;
  /** Micro-USDC paid to winners. */
  paid: bigint;
  biggestWin: StatsWin | null;
  lastWin: StatsWin | null;
};

export type Stats = {
  /** The keeper is still reading the history: the figures are not complete yet. */
  syncing: boolean;
  all: StatsSplit;
};

const KINDS: readonly TicketKind[] = ["Checkout", "Swap", "Booster", "Ticket"];
const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const amount = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);

function winOf(v: unknown): StatsWin | null {
  if (!v || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  const payout = amount(w.payout);
  if (payout === null || typeof w.ticket !== "string") return null;
  return {
    payout,
    kind: KINDS.includes(w.kind as TicketKind) ? (w.kind as TicketKind) : null,
    ticket: w.ticket,
    at: typeof w.at === "number" ? w.at : null,
  };
}

/** One split of the answer; null when it does not read as one. */
export function parseSplit(v: unknown): StatsSplit | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  const ticketsOpened = count(s.ticketsOpened);
  const ticketsDrawn = count(s.ticketsDrawn);
  const wins = count(s.wins);
  const paid = amount(s.paid);
  if (ticketsOpened === null || ticketsDrawn === null || wins === null || paid === null)
    return null;
  return {
    ticketsOpened,
    ticketsDrawn,
    wins,
    paid,
    biggestWin: winOf(s.biggestWin),
    lastWin: winOf(s.lastWin),
  };
}

/** The keeper's figures; throws when it cannot be reached or answers something else. */
export async function fetchStats(): Promise<Stats> {
  const r = await fetch(`${API_URL}/v1/stats`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(6_000),
  });
  if (!r.ok) throw new Error(`the figures service answered HTTP ${r.status}`);
  const j = (await r.json()) as Record<string, unknown>;
  const all = parseSplit(j.all);
  if (!all) throw new Error("the figures service answered an unreadable body");
  return { syncing: j.syncing === true, all };
}
