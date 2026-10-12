// Tickets read back from the chain: the program's recent ones (live draws, the vault's
// estimated APR, what each app brought in) and one wallet's (its dashboard). Every figure
// comes from the TicketOpened / TicketSettled / TicketExpired events, through the same
// transaction cache as the vault's history: a transaction is read once per browser.
import type { Address, Signature } from "@solana/kit";
import { PROGRAM } from "./config";
import { txDecoder, type FadeEvent } from "./events";
import { ata, integratorPda } from "./fade";
import { BPS, P_SCALE } from "./math";
import { PACK_TICKETS, PREMIUM_PACKS, boosterPayoutTableAt, boosterWinP } from "./payoutTables";
import { rpc } from "./rpc";
import { findTicketEnd } from "./ticket";
import { eventsFor } from "./txCache";
import { BOOSTER_PAYOUT } from "./ticketKind";

export { kindOf, type TicketKind } from "./ticketKind";
import { MINUS, odds } from "./format";

export type TicketEnd = {
  kind: "settled" | "expired";
  /** Micro-USDC paid to the beneficiary; 0 for no win or an expiry. */
  payout: bigint;
  /** The payout waits in escrow: the beneficiary could not receive it. */
  pending: boolean;
  at: number | null;
  signature: Signature;
};

export type TicketRow = {
  ticket: Address;
  integrator: Address;
  beneficiary: Address;
  price: bigint;
  payoutMax: bigint;
  vaultCredit: bigint;
  marginBps: bigint;
  appShareBps: bigint;
  openedAt: number | null;
  openSig: Signature;
  end: TicketEnd | null;
};

/** A settlement read without its opening (the opening is older than what was read). */
export type LoneEnd = TicketEnd & { ticket: Address; integrator: Address };

export type TicketLog = {
  /** Newest first. */
  rows: TicketRow[];
  /** Settlements whose opening is beyond the window read, newest first. */
  loneEnds: LoneEnd[];
  /** Unix seconds of the oldest transaction read; null when none was. */
  from: number | null;
  /** The read stopped at its cap before reaching the start of the window. */
  truncated: boolean;
};

type Sig = { signature: Signature; blockTime: number | null };

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
  const rows = new Map<Address, TicketRow>();
  const ends = new Map<Address, LoneEnd>();
  for (const s of [...sigs].reverse()) {
    const tx = known.get(s.signature);
    if (!tx) continue;
    for (const e of tx.events as FadeEvent[]) {
      if (e.kind === "TicketOpened") {
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
      } else if (e.kind === "TicketSettled" || e.kind === "TicketExpired") {
        const end: LoneEnd = {
          kind: e.kind === "TicketSettled" ? "settled" : "expired",
          payout: e.kind === "TicketSettled" ? e.data.payout : 0n,
          pending: e.kind === "TicketSettled" ? e.data.pending : false,
          at: s.blockTime,
          signature: s.signature,
          ticket: e.data.ticket,
          integrator: e.data.integrator,
        };
        const row = rows.get(e.data.ticket);
        if (row) row.end = end;
        else ends.set(e.data.ticket, end);
      }
    }
  }
  const oldest = sigs.at(-1)?.blockTime ?? null;
  return {
    rows: [...rows.values()].reverse(),
    loneEnds: [...ends.values()].reverse(),
    from: oldest,
    truncated: sigs.length >= cap && (oldest === null || oldest > since),
  };
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

/** How many settlements of other apps' tickets one read resolves through the ticket's own history. */
const RESOLVE_PER_READ = 8;
const WALLET_MAX_SIGS = 600;

export type WalletTickets = {
  owner: Address;
  rows: TicketRow[];
  integrator: Address;
  /** The wallet's USDC account: the beneficiary of its own tickets. */
  usdcAccount: Address;
};

/**
 * The tickets of one wallet: those it funded as its own app (the demos open them under the wallet's
 * integrator record) and those paying out to it (its USDC account is the beneficiary). Reads the
 * integrator record's history and the USDC account's; a settlement of another app's ticket that
 * paid nothing does not touch the wallet, so the newest few are looked up on the ticket itself.
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
  const mine = log.rows.filter(
    (r) => r.integrator === integrator || r.beneficiary === usdcAccount || r.beneficiary === owner,
  );
  const now = Date.now() / 1000;
  const unresolved = mine
    .filter((r) => !r.end && r.integrator !== integrator && now - (r.openedAt ?? now) > 60)
    .slice(0, RESOLVE_PER_READ);
  await Promise.all(
    unresolved.map(async (r) => {
      const end = await findTicketEnd(r.ticket).catch(() => null);
      if (!end) return;
      r.end =
        end.kind === "settled"
          ? {
              kind: "settled",
              payout: end.payout,
              pending: end.pending,
              at: null,
              signature: end.signature,
            }
          : { kind: "expired", payout: 0n, pending: false, at: null, signature: end.signature };
    }),
  );
  return { owner, rows: mine, integrator, usdcAccount };
}

// --- what a ticket was ---------------------------------------------------------------------

/**
 * The odds of a win, "1 in N". A booster's payout table is rebuilt from its price and margin, and
 * its odds are those of any win, a premium or a second pack. Any other demo ticket is
 * all-or-nothing (lib/math `allOrNothing`), rebuilt the same way: its multiplier is the smallest
 * whose payout reaches the worst case, `ceil(payout · BPS / price)`, and its probability the
 * largest that keeps the margin, `floor((BPS − margin) · P_SCALE / m)`: the odds the demo showed.
 */
export function oddsOf(r: Pick<TicketRow, "price" | "payoutMax" | "marginBps">) {
  if (r.payoutMax === 0n || r.price <= 0n || r.marginBps >= BPS) return "–";
  const p =
    r.payoutMax === r.price * BOOSTER_PAYOUT
      ? boosterWinP(boosterPayoutTableAt(r.price * PACK_TICKETS, r.marginBps))
      : ((BPS - r.marginBps) * P_SCALE) / ((r.payoutMax * BPS + r.price - 1n) / r.price);
  if (p <= 0n) return "–";
  return odds(p).oneIn;
}

// --- the vault's estimated APR -------------------------------------------------------------

const DAY = 86400;

export type AprEstimate = {
  /** Percent a year, or null when the last 24 h hold too few tickets to say. */
  pct: number | null;
  tickets: number;
  /** Micro-USDC of ticket prices over the last 24 h (extrapolated when the read was capped). */
  volume: bigint;
  /** Micro-USDC the vault's margin kept on that volume. */
  margin: bigint;
};

/** Fewer tickets than this in 24 h and the estimate is not shown. */
export const APR_MIN_TICKETS = 5;

/**
 * The vault margin earned on the last 24 h of ticket volume, annualised over the vault's assets
 * now. Each ticket's vault margin is its margin less its app share and the protocol share. A
 * read capped before 24 h scales its volume up to a day.
 */
export function estimateApr(
  log: TicketLog,
  totalAssets: bigint,
  protocolShareBps: bigint,
  now: number,
): AprEstimate {
  const since = now - DAY;
  let volume = 0n;
  let margin = 0n;
  let tickets = 0;
  for (const r of log.rows) {
    if (r.openedAt === null || r.openedAt < since) continue;
    tickets += 1;
    volume += r.price;
    const vm = r.marginBps - r.appShareBps - protocolShareBps;
    if (vm > 0n) margin += (r.price * vm) / BPS;
  }
  if (log.truncated && log.from !== null && log.from > since) {
    const span = BigInt(Math.max(60, now - log.from));
    volume = (volume * BigInt(DAY)) / span;
    margin = (margin * BigInt(DAY)) / span;
  }
  const pct =
    tickets < APR_MIN_TICKETS || totalAssets === 0n
      ? null
      : (Number(margin) * 365 * 100) / Number(totalAssets);
  return { pct, tickets, volume, margin };
}

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

// --- what each app brought in ----------------------------------------------------------------

export type AppStats = {
  tickets: number;
  volume: bigint;
  /** The vault's result on the tickets read both ends of: its credit, less what it paid. */
  result: bigint;
  settled: number;
  appShare: bigint;
  /** Payouts to the app's customers. */
  paidOut: bigint;
};

/** Per integrator record, over the tickets read. */
export function statsByApp(log: TicketLog): Map<Address, AppStats> {
  const m = new Map<Address, AppStats>();
  for (const r of log.rows) {
    let s = m.get(r.integrator);
    if (!s) {
      s = { tickets: 0, volume: 0n, result: 0n, settled: 0, appShare: 0n, paidOut: 0n };
      m.set(r.integrator, s);
    }
    s.tickets += 1;
    s.volume += r.price;
    s.appShare += (r.price * r.appShareBps) / BPS;
    if (r.end) {
      s.settled += 1;
      s.result += r.vaultCredit - r.end.payout;
      s.paidOut += r.end.payout;
    }
  }
  return m;
}

/** Ticket volume per bucket of `bucketS` seconds over [from, to], as chart points at each bucket's start (USDC). */
export function volumeSeries(
  log: TicketLog,
  from: number,
  to: number,
  bucketS: number,
): { t: number; v: number }[] {
  const n = Math.max(1, Math.ceil((to - from) / bucketS));
  const sums = new Array<number>(n).fill(0);
  for (const r of log.rows) {
    if (r.openedAt === null || r.openedAt < from || r.openedAt > to) continue;
    const i = Math.min(n - 1, Math.floor((r.openedAt - from) / bucketS));
    sums[i]! += Number(r.price) / 1e6;
  }
  return sums.map((v, i) => ({ t: from + i * bucketS, v }));
}
