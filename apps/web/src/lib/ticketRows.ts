// Ticket rows from Fade's decoded events, pure: a direct ticket opens with TicketOpened and ends
// with TicketSettled or TicketExpired; a beacon ticket opens with TicketJoined and ends with
// RoundTicketSettled or RoundTicketReturned (its round never drew); RoundPayoutClaimed delivers
// what either parked. One arithmetic for the app (lib/ticketLog, over the transactions it reads)
// and for the keeper (the wallet history it serves, apps/keeper/src/walletIndex.ts).
import type { Address, Signature } from "@solana/kit";
import type { FadeEvent } from "./fadeEvents";
import type { TicketExpiredRecord } from "../../../../clients/js/src/direct/index.ts";
import { BPS, marginBps as marginOfLhs } from "./math";

export type TicketEnd = {
  /** A draw ran (`settled`), or the ticket closed without one (`expired`, or a beacon return). */
  kind: "settled" | "expired";
  /** Micro-USDC paid to the beneficiary; 0 for no win, an expiry or a return. */
  payout: bigint;
  /**
   * What the ticket ended with waits in escrow: the payout, its beneficiary could not receive
   * it; a refunded beacon ticket's price, its funder's account could not; or a direct ticket's
   * returned credit, its beneficiary could not.
   */
  pending: boolean;
  /**
   * A beacon ticket returned from a refunded round: its price goes back to its funder (or waits
   * in escrow, `pending`). Never a win.
   */
  refunded?: boolean;
  /**
   * A direct ticket refunded its vault credit (`refund_expired_ticket`: its seed was never
   * recorded and can no longer be proven): no draw ran, and `payout` is that credit, back to
   * its beneficiary (or waiting in escrow, `pending`). The shares its opening paid are not
   * returned, so its price and shares stay counted, as the program's `volume_total` does; the
   * vault kept nothing. Never a win, never a forfeiture.
   */
  creditReturned?: boolean;
  at: number | null;
  signature: Signature;
};

/** What a beacon ticket's join says beyond a direct opening. */
export type BeaconTicket = {
  round: Address;
  payoutTable: Address;
  /** The funder's USDC account: where a refund returns the ticket price, or parks it for. */
  refundTo: Address;
  /** Micro-USDC: the shares the join took out of the price. */
  appShare: bigint;
  protocolShare: bigint;
};

export type TicketRow = {
  ticket: Address;
  integrator: Address;
  beneficiary: Address;
  price: bigint;
  payoutMax: bigint;
  vaultCredit: bigint;
  /**
   * A beacon ticket's is its payout table's (`withBeaconMargins`), 0 while the table is not
   * read; its `appShareBps` is its app share over its price, rounded down.
   */
  marginBps: bigint;
  appShareBps: bigint;
  openedAt: number | null;
  openSig: Signature;
  end: TicketEnd | null;
  /** A ticket of the shared beacon; absent for a direct one. */
  beacon?: BeaconTicket;
};

/**
 * A settlement read without its opening (the opening is older than what was read). A beacon
 * return names no integrator: null.
 */
export type LoneEnd = TicketEnd & { ticket: Address; integrator: Address | null; beacon: boolean };

export type TicketLog = {
  /** Newest first. */
  rows: TicketRow[];
  /** Settlements whose opening is beyond the window read, newest first. */
  loneEnds: LoneEnd[];
  /** Unix seconds of the oldest transaction read; null when none was. */
  from: number | null;
  /** The read stopped at its cap before reaching the start of the window. */
  truncated: boolean;
  /**
   * Unix seconds the read reached back to: every ticket opened since is listed, unless the read
   * was `truncated`. Absent when the read had no start (everything is listed).
   */
  since?: number;
};

/** A listed signature and the time the cluster gave it (null when it did not date it). */
export type Sig = { signature: Signature; blockTime: number | null };

/** One transaction's Fade events (lib/txCache's shape). */
export type TxEvents<E> = { events: E[] };

type JoinedEvent = Extract<FadeEvent, { kind: "TicketJoined" }>;
type RoundTicketEndEvent = Extract<
  FadeEvent,
  { kind: "RoundTicketSettled" | "RoundTicketReturned" }
>;

/** What a ticket's draw paid: its payout, but nothing for a direct ticket's credit back. */
export const winPayout = (end: Pick<TicketEnd, "payout" | "creditReturned"> | null | undefined) =>
  end && !end.creditReturned ? end.payout : 0n;

/** What a refunded direct ticket got back of its price: its credit; 0 for any other end. */
export const creditBack = (end: Pick<TicketEnd, "payout" | "creditReturned"> | null | undefined) =>
  end?.creditReturned ? end.payout : 0n;

/** The end, once a `RoundPayoutClaimed` delivered what it parked: nothing waits any more. */
export const delivered = <E extends TicketEnd>(end: E): E =>
  end.pending ? { ...end, pending: false } : end;

/** A beacon ticket's row from its join; its margin is 0 until `withBeaconMargins` reads it. */
export function joinedRow(e: JoinedEvent, s: Sig, end: TicketEnd | null): TicketRow {
  const d = e.data;
  return {
    ticket: d.ticket,
    integrator: d.integrator,
    beneficiary: d.beneficiary,
    price: d.price,
    payoutMax: d.payoutMax,
    vaultCredit: d.vaultCredit,
    marginBps: 0n,
    appShareBps: d.price > 0n ? (d.appShare * BPS) / d.price : 0n,
    openedAt: s.blockTime,
    openSig: s.signature,
    end,
    beacon: {
      round: d.round,
      payoutTable: d.payoutTable,
      refundTo: d.refundTo,
      appShare: d.appShare,
      protocolShare: d.protocolShare,
    },
  };
}

/** How a beacon ticket ended: its round's settlement (a draw), or its return (no draw). */
export function roundTicketEnd(e: RoundTicketEndEvent, s: Sig): TicketEnd {
  if (e.kind === "RoundTicketSettled")
    return {
      kind: "settled",
      payout: e.data.payout,
      pending: e.data.pending,
      at: s.blockTime,
      signature: s.signature,
    };
  return {
    kind: "expired",
    payout: 0n,
    // a refunded price that its funder's account could not receive waits in escrow
    pending: e.data.parked,
    ...(e.data.refunded ? { refunded: true } : {}),
    at: s.blockTime,
    signature: s.signature,
  };
}

/**
 * How a direct ticket closed without a draw: forfeited (its credit kept by the vault), or, from
 * a version-2 `TicketExpired` with `refunded`, its vault credit returned to its beneficiary,
 * waiting in escrow when `parked`. A version-1 event is always a forfeiture. Total over a
 * version-2 record stored without its version-2 fields (the keeper's wallet index, which replays
 * stored events, kept what a version-1 decoder read of the body): read as a forfeiture.
 */
export function directExpiryEnd(e: TicketExpiredRecord, s: Sig): TicketEnd {
  const refunded = e.version === 2 && e.refunded === true;
  return {
    kind: "expired",
    payout: refunded ? e.refund : 0n,
    pending: refunded && e.parked === true,
    ...(refunded ? { creditReturned: true } : {}),
    at: s.blockTime,
    signature: s.signature,
  };
}

/**
 * The ticket rows of these transactions (newest first, as listed) from their decoded events.
 * A beacon row's margin is 0 here: `withBeaconMargins` reads it from its payout table.
 */
export function ticketLogOf(
  sigs: readonly Sig[],
  known: ReadonlyMap<Signature, TxEvents<unknown>>,
  cap: number,
  since: number,
): TicketLog {
  const rows = new Map<Address, TicketRow>();
  const ends = new Map<Address, LoneEnd>();
  const claimed = new Set<Address>();
  const end = (e: LoneEnd) => {
    const row = rows.get(e.ticket);
    if (row) row.end = e;
    else ends.set(e.ticket, e);
  };
  for (const s of [...sigs].reverse()) {
    const tx = known.get(s.signature);
    if (!tx) continue;
    for (const e of tx.events as FadeEvent[]) {
      if (e.kind === "TicketJoined") {
        const d = e.data;
        rows.set(d.ticket, joinedRow(e, s, ends.get(d.ticket) ?? null));
        ends.delete(d.ticket);
      } else if (e.kind === "RoundTicketSettled" || e.kind === "RoundTicketReturned") {
        end({
          ...roundTicketEnd(e, s),
          ticket: e.data.ticket,
          integrator:
            e.kind === "RoundTicketSettled"
              ? e.data.integrator
              : (rows.get(e.data.ticket)?.integrator ?? null),
          beacon: true,
        });
      } else if (e.kind === "RoundPayoutClaimed") {
        claimed.add(e.data.ticket);
      } else if (e.kind === "TicketOpened") {
        const d = e.data;
        rows.set(d.ticket, {
          ticket: d.ticket,
          integrator: d.integrator,
          beneficiary: d.beneficiary,
          price: d.price,
          payoutMax: d.payoutMax,
          vaultCredit: d.vaultCredit,
          marginBps: d.marginBps,
          appShareBps: d.appShareBps,
          openedAt: s.blockTime,
          openSig: s.signature,
          end: ends.get(d.ticket) ?? null,
        });
        ends.delete(d.ticket);
      } else if (e.kind === "TicketSettled") {
        end({
          kind: "settled",
          payout: e.data.payout,
          pending: e.data.pending,
          at: s.blockTime,
          signature: s.signature,
          ticket: e.data.ticket,
          integrator: e.data.integrator,
          beacon: false,
        });
      } else if (e.kind === "TicketExpired") {
        end({
          ...directExpiryEnd(e.data, s),
          ticket: e.data.ticket,
          integrator: e.data.integrator,
          beacon: false,
        });
      }
    }
  }
  for (const r of rows.values()) if (r.end && claimed.has(r.ticket)) r.end = delivered(r.end);
  for (const [t, e] of ends) if (claimed.has(t)) ends.set(t, delivered(e));
  const oldest = sigs.at(-1)?.blockTime ?? null;
  return {
    rows: [...rows.values()].reverse(),
    loneEnds: [...ends.values()].reverse(),
    from: oldest,
    truncated: sigs.length >= cap && (oldest === null || oldest > since),
    since,
  };
}

/** The log with each beacon row's margin read from its payout table's `Σ p·m`, when known. */
export function withBeaconMargins<L extends Pick<TicketLog, "rows">>(
  log: L,
  lhs: ReadonlyMap<Address, bigint>,
): L {
  for (const r of log.rows) {
    const l = r.beacon ? lhs.get(r.beacon.payoutTable) : undefined;
    if (l !== undefined) r.marginBps = marginOfLhs(l) ?? 0n;
  }
  return log;
}
