// Tickets read back from the chain: the program's recent ones (live draws, the vault's APR,
// what each app brought in) and one wallet's (its dashboard, when the keeper cannot serve its
// history: lib/keeperWallet). Every figure comes from the ticket events of both paths (the rows
// themselves: lib/ticketRows, which the keeper shares), through the same transaction cache as
// the vault's history: a transaction is read once per browser.
import { fetchEncodedAccounts, type Address, type Signature } from "@solana/kit";
import { getPayoutTableDecoder } from "../../../../clients/js/src/generated/fade";
import { PROGRAM } from "./config";
import { txDecoder, type FadeEvent } from "./events";
import { ata, integratorPda } from "./fade";
import { BPS, P_SCALE } from "./math";
import { PACK_TICKETS, PREMIUM_PACKS, boosterPayoutTableAt, boosterWinP } from "./payoutTables";
import { rpc } from "./rpc";
import { findTicketEnd } from "./ticket";
import { eventsFor } from "./txCache";
import { BOOSTER_PAYOUT } from "./ticketKind";
import {
  delivered,
  roundTicketEnd,
  ticketLogOf,
  withBeaconMargins,
  type Sig,
  type TicketEnd,
  type TicketLog,
  type TicketRow,
} from "./ticketRows";
import { boundedTickets, walletRowsOf, type WalletTicketList } from "./walletHistory";

export { kindOf, type TicketKind } from "./ticketKind";
export {
  creditBack,
  delivered,
  directExpiryEnd,
  joinedRow,
  roundTicketEnd,
  ticketLogOf,
  winPayout,
  withBeaconMargins,
  type BeaconTicket,
  type LoneEnd,
  type TicketEnd,
  type TicketLog,
  type TicketRow,
} from "./ticketRows";
import { MINUS, odds } from "./format";
import { volumeSums } from "./vaultViews";
export { appShareOf, statsByApp, type AppStats } from "./vaultViews";
export {
  APR_LABEL,
  APR_MIN_TICKETS,
  APR_WINDOW_S,
  aprSeries,
  coveredFrom,
  estimateApr,
  isRefunded,
  vaultMarginOf,
  type AprEstimate,
  type AssetsPoint,
} from "./apr";

/** Successful signatures of `account`, newest first, back to `since` or `max` of them. */
async function signaturesSince(account: Address, since: number, max: number): Promise<Sig[]> {
  const out: Sig[] = [];
  let before: Signature | undefined;
  for (;;) {
    const page = await rpc
      .getSignaturesForAddress(account, {
        limit: Math.min(1000, max - out.length),
        commitment: "confirmed",
        ...(before ? { before } : {}),
      })
      .send();
    let past = false;
    for (const s of page) {
      const t = s.blockTime === null ? null : Number(s.blockTime);
      if (t !== null && t < since) {
        past = true;
        break;
      }
      if (s.err === null) out.push({ signature: s.signature, blockTime: t });
    }
    if (past || page.length === 0 || out.length >= max || page.length < 1000) break;
    before = page[page.length - 1]?.signature;
  }
  return out;
}

/** The ticket rows of these transactions, oldest first in, newest first out. */
async function build(sigs: Sig[], cap: number, since: number): Promise<TicketLog> {
  const known = await eventsFor(
    sigs.map((s) => s.signature),
    await txDecoder(),
  );
  return readBeaconMargins(ticketLogOf(sigs, known, cap, since));
}

/** `Σ p·m` of each registered payout table, by address: a table never changes once registered. */
const tableLhs = new Map<Address, bigint>();

/**
 * The `Σ p·m` of the payout tables of the log's beacon rows, read once per browser. A table that
 * cannot be read is left out, and read again on the next call.
 */
async function payoutTableLhs(log: Pick<TicketLog, "rows">): Promise<ReadonlyMap<Address, bigint>> {
  const missing = [
    ...new Set(
      log.rows.flatMap((r) =>
        r.beacon && !tableLhs.has(r.beacon.payoutTable) ? [r.beacon.payoutTable] : [],
      ),
    ),
  ];
  if (missing.length) {
    try {
      const accounts = await fetchEncodedAccounts(rpc, missing, { commitment: "confirmed" });
      accounts.forEach((a, i) => {
        if (!a.exists || a.programAddress !== PROGRAM) return;
        try {
          tableLhs.set(missing[i]!, getPayoutTableDecoder().decode(a.data).lhs);
        } catch {
          // not a payout table
        }
      });
    } catch {
      // unreadable now: those rows keep a zero margin until the next read
    }
  }
  return tableLhs;
}

/** The log with its beacon rows' margins, their payout tables read once per browser. */
export async function readBeaconMargins<L extends Pick<TicketLog, "rows">>(log: L): Promise<L> {
  return withBeaconMargins(log, await payoutTableLhs(log));
}

/** How far back the program's tickets are read: the per-app table's window. */
export const PROGRAM_WINDOW_S = 7 * 86400;
/** The most program transactions read at once (each ticket takes about three). */
const PROGRAM_MAX_SIGS = 1500;

let programInFlight: Promise<TicketLog> | null = null;

/**
 * The program's tickets over the last 7 days (or its newest 1 500 transactions). Callers on the
 * same page share one read.
 */
export function fetchProgramTickets(): Promise<TicketLog> {
  programInFlight ??= (async () => {
    const since = Math.floor(Date.now() / 1000) - PROGRAM_WINDOW_S;
    const sigs = await signaturesSince(PROGRAM, since, PROGRAM_MAX_SIGS);
    return build(sigs, PROGRAM_MAX_SIGS, since);
  })().finally(() => {
    programInFlight = null;
  });
  return programInFlight;
}

/**
 * How a beacon ticket ended, from its own history: every settlement, return and claim of what
 * they parked names its round ticket. Null while it has not ended (or the RPC has not indexed
 * its end yet).
 */
async function findRoundTicketEnd(ticket: Address): Promise<TicketEnd | null> {
  const sigs = await signaturesSince(ticket, 0, 8);
  const known = await eventsFor(
    sigs.map((s) => s.signature),
    await txDecoder(),
  );
  let claimed = false;
  let end: TicketEnd | null = null;
  for (const s of sigs)
    for (const e of (known.get(s.signature)?.events ?? []) as FadeEvent[]) {
      if (e.kind === "RoundPayoutClaimed" && e.data.ticket === ticket) claimed = true;
      else if (
        (e.kind === "RoundTicketSettled" || e.kind === "RoundTicketReturned") &&
        e.data.ticket === ticket
      )
        end ??= roundTicketEnd(e, s);
    }
  return end && claimed ? delivered(end) : end;
}

/** How many settlements of other apps' tickets one read resolves through the ticket's own history. */
const RESOLVE_PER_READ = 8;
const WALLET_MAX_SIGS = 600;

/** One wallet's tickets (lib/walletHistory): the keeper's history, or the app's own reads. */
export type WalletTickets = WalletTicketList & {
  owner: Address;
  integrator: Address;
  /** The wallet's USDC account: the beneficiary of its own tickets. */
  usdcAccount: Address;
};

/**
 * The tickets of one wallet: those it funded as its own app (the demos open them under the wallet's
 * integrator record) and those paying out to it (its USDC account is the beneficiary). Reads the
 * integrator record's history and the USDC account's. The end of another app's ticket may touch
 * neither: a direct settlement that paid nothing, a beacon settlement that did not pay (it names
 * the beneficiary only for a win), a beacon return (its price goes to the funder) or forfeiture.
 * The newest few such tickets are looked up on the ticket itself. The fallback of the keeper's
 * history (lib/keeperWallet).
 */
export async function fetchWalletTickets(owner: Address): Promise<WalletTickets> {
  const [integrator, usdcAccount] = await Promise.all([integratorPda(owner), ata(owner)]);
  const [a, b] = await Promise.all([
    signaturesSince(integrator, 0, WALLET_MAX_SIGS),
    signaturesSince(usdcAccount, 0, WALLET_MAX_SIGS),
  ]);
  const merged = new Map<Signature, Sig>();
  for (const s of [...a, ...b]) merged.set(s.signature, s);
  const sigs = [...merged.values()].sort((x, y) => (y.blockTime ?? 0) - (x.blockTime ?? 0));
  const log = await build(sigs, Infinity, 0);
  const keys = { owner, integrator, usdcAccount };
  const mine = walletRowsOf(log.rows, keys);
  const now = Date.now() / 1000;
  const unresolved = mine
    .filter((r) => !r.end && r.integrator !== integrator && now - (r.openedAt ?? now) > 60)
    .slice(0, RESOLVE_PER_READ);
  await Promise.all(
    unresolved.map(async (r) => {
      if (r.beacon) {
        r.end = await findRoundTicketEnd(r.ticket).catch(() => null);
        return;
      }
      const end = await findTicketEnd(r.ticket).catch(() => null);
      // a closed ticket's end is read from its transactions, so it has its signature
      if (!end || !end.signature) return;
      r.end =
        end.kind === "settled"
          ? {
              kind: "settled",
              payout: end.payout,
              pending: end.pending,
              at: null,
              signature: end.signature,
            }
          : {
              kind: "expired",
              payout: end.refund?.amount ?? 0n,
              pending: end.refund?.pending ?? false,
              ...(end.refund ? { creditReturned: true } : {}),
              at: null,
              signature: end.signature,
            };
    }),
  );
  return { owner, integrator, usdcAccount, ...boundedTickets(mine, keys, Infinity) };
}

// --- what a ticket was ---------------------------------------------------------------------

/**
 * The odds of a win, "1 in N". A booster's payout table is rebuilt from its price and margin, and
 * its odds are those of any win, a premium or a second pack. Any other demo ticket is
 * all-or-nothing (lib/math `allOrNothing`), rebuilt the same way: its multiplier is the smallest
 * whose payout reaches the worst case, `ceil(payout · BPS / price)`, and its probability the
 * largest that keeps the margin, `floor((BPS − margin) · P_SCALE / m)`: the odds the demo showed.
 */
export function oddsOf(
  r: Pick<TicketRow, "price" | "payoutMax" | "marginBps"> & { beacon?: unknown },
) {
  if (r.payoutMax === 0n || r.price <= 0n || r.marginBps >= BPS) return "–";
  // a beacon ticket's margin is 0 until its payout table is read: its odds are not known yet
  if (r.beacon && r.marginBps === 0n) return "–";
  const p =
    r.payoutMax === r.price * BOOSTER_PAYOUT
      ? boosterWinP(boosterPayoutTableAt(r.price * PACK_TICKETS, r.marginBps))
      : ((BPS - r.marginBps) * P_SCALE) / ((r.payoutMax * BPS + r.price - 1n) / r.price);
  if (p <= 0n) return "–";
  return odds(p).oneIn;
}

// --- the vault's APR (lib/apr) ---------------------------------------------------------------

/**
 * "≈ 22%" / "≈ 3.4%" / "≈ 0.08%", "≈ −12%" for a loss: the decimals follow the size, whatever
 * the sign, and a result that shows as zero has no sign. "–" when there is no number to show.
 */
export function fmtApr(pct: number): string {
  if (!Number.isFinite(pct)) return "–";
  const size = Math.abs(pct);
  const digits = size >= 10 ? 0 : size >= 1 ? 1 : 2;
  const text = size.toFixed(digits);
  return `≈ ${pct < 0 && /[1-9]/.test(text) ? MINUS : ""}${text}%`;
}

// --- what each app brought in, the ticket volume (lib/vaultViews) ---------------------------

/**
 * Ticket volume per bucket of `bucketS` seconds over [from, to], as chart points at each bucket's
 * start (USDC). A refunded beacon ticket is left out.
 */
export function volumeSeries(
  log: TicketLog,
  from: number,
  to: number,
  bucketS: number,
): { t: number; v: number }[] {
  return volumeSums(log, from, to, bucketS).map((v, i) => ({
    t: from + i * bucketS,
    v: Number(v) / 1e6,
  }));
}
