// The all-time figures behind GET /v1/stats: tickets opened and drawn, wins, what winners
// were paid, the biggest and the last win. The program keeps no such counters, so this
// Durable Object reads the program's whole history once and then follows it, on its own alarm:
//
//   1. Listing. A round pages getSignaturesForAddress(PROGRAM) from the newest signature back
//      to the cursor (the newest signature of the last complete round), a few pages a tick,
//      and queues every successful one in `backlog`. When it reaches the cursor the round is
//      complete and its newest signature becomes the cursor. The first round reaches back to
//      the deploy.
//   2. Processing. Up to MAX_TX_PER_TICK queued transactions of complete rounds, oldest first:
//      getTransaction, decode the ticket events (statsIndex.ts), and in one storage
//      transaction add them to the totals, record the signature as done and unqueue it. A
//      signature already done is only unqueued: a transaction never counts twice.
//
// Everything is read at `finalized`, so nothing counted can be rolled back. A tick that hits
// an RPC error stops there; the next one resumes from what is stored.
import { DurableObject } from "cloudflare:workers";
import type { Address, Signature } from "@solana/kit";
import { DEFAULT_RPC_URL, PROGRAM, describeError, makeRpc, type Rpc } from "./chain.ts";
import type { Env } from "./index.ts";
import {
  applyTx,
  splitFrom,
  splitJson,
  ticketEventsOf,
  type JsonTx,
  type OpenTicket,
  type SplitJson,
  type Totals,
} from "./statsIndex.ts";

/** Tick period while there is history to read, and once caught up. */
const BUSY_INTERVAL_MS = 2_000;
const IDLE_INTERVAL_MS = 20_000;
/** getSignaturesForAddress pages per tick, of up to PAGE signatures each. */
const MAX_PAGES_PER_TICK = 2;
const PAGE = 1_000;
/** getTransaction calls per tick, one at a time. */
const MAX_TX_PER_TICK = 20;
/** Signatures remembered as done (the overlap a listing could repeat is far smaller). */
const DONE_KEPT = 20_000;
/** An opening never closed is forgotten after this long (the program expires tickets in minutes). */
const OPEN_KEPT_S = 30 * 86_400;

export type StatsView = {
  /** ISO 8601: when this answer was built. */
  updatedAt: string;
  /** The first read of the history is not finished: the figures are still climbing to their value. */
  syncing: boolean;
  /** Program transactions read so far, and the time of the newest (Unix seconds). */
  indexed: { transactions: number; through: number | null };
  all: SplitJson;
};

type Meta =
  | "cursor"
  | "round"
  | "round_head"
  | "round_before"
  | "round_listed"
  | "completed_round"
  | "caught_up"
  | "transactions"
  | "through";

export class Stats extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly rpc: Rpc;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.rpc = makeRpc(env.RPC_URL || DEFAULT_RPC_URL);
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS backlog (
      signature TEXT PRIMARY KEY,
      round INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      block_time INTEGER
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS backlog_order ON backlog (round, idx)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS done (signature TEXT PRIMARY KEY)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS open_tickets (
      ticket TEXT PRIMARY KEY,
      price TEXT NOT NULL,
      payout_max TEXT NOT NULL,
      opened_at INTEGER
    )`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS totals (split TEXT PRIMARY KEY, json TEXT NOT NULL)");
  }

  // --- API ---------------------------------------------------------------------------------

  async stats(): Promise<StatsView> {
    await this.ensureAlarm();
    const t = this.totals();
    const through = this.meta("through");
    return {
      updatedAt: new Date().toISOString(),
      syncing: this.meta("caught_up") !== "1",
      indexed: {
        transactions: Number(this.meta("transactions") ?? 0),
        through: through === null ? null : Number(through),
      },
      all: splitJson(t.all),
    };
  }

  /** Called by the cron trigger and by every read: restarts the loop should its alarm be lost. */
  async ensureAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    // replace an alarm left in the past: its handler kept failing and it will not fire again
    if (current === null || current < Date.now() - 60_000)
      await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    let busy = false;
    try {
      busy = await this.tick();
    } catch (e) {
      console.error(`stats tick failed: ${describeError(e)}`);
    } finally {
      const target = Date.now() + (busy ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS);
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > target) await this.ctx.storage.setAlarm(target);
    }
  }

  // --- the loop ------------------------------------------------------------------------------

  /** One bounded step; true while there is more to read right away. */
  private async tick(): Promise<boolean> {
    const listing = await this.list();
    const left = await this.process();
    if (!listing && left === 0 && this.meta("completed_round") !== null)
      this.setMeta("caught_up", "1");
    return listing || left > 0;
  }

  /** Pages the newest signatures back to the cursor; true while the round is not complete. */
  private async list(): Promise<boolean> {
    const cursor = this.meta("cursor");
    const round = Number(this.meta("round") ?? 0) + (this.meta("round_head") === null ? 1 : 0);
    for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
      const before = this.meta("round_before");
      const sigs = await this.rpc
        .getSignaturesForAddress(PROGRAM, {
          limit: PAGE,
          commitment: "finalized",
          ...(cursor ? { until: cursor as Signature } : {}),
          ...(before ? { before: before as Signature } : {}),
        })
        .send();
      const listed = Number(this.meta("round_listed") ?? 0);
      this.ctx.storage.transactionSync(() => {
        this.setMeta("round", String(round));
        if (this.meta("round_head") === null && sigs[0])
          this.setMeta("round_head", sigs[0].signature);
        sigs.forEach((s, i) => {
          if (s.err !== null) return;
          this.sql.exec(
            "INSERT OR IGNORE INTO backlog (signature, round, idx, block_time) VALUES (?, ?, ?, ?)",
            s.signature,
            round,
            listed + i,
            s.blockTime === null ? null : Number(s.blockTime),
          );
        });
        this.setMeta("round_listed", String(listed + sigs.length));
        const last = sigs[sigs.length - 1];
        if (sigs.length === PAGE && last) {
          this.setMeta("round_before", last.signature);
        } else {
          // reached the cursor (or the deploy): the round is complete
          const head = this.meta("round_head");
          if (head !== null) this.setMeta("cursor", head);
          this.setMeta("completed_round", String(round));
          for (const k of ["round_head", "round_before", "round_listed"] as const) this.delMeta(k);
        }
      });
      if (this.meta("round_before") === null) return false;
    }
    return true;
  }

  /** Reads and counts queued transactions, oldest first; returns how many are left. */
  private async process(): Promise<number> {
    const completed = this.meta("completed_round");
    if (completed === null) return 0;
    const rows = this.sql
      .exec<{ signature: string; block_time: number | null }>(
        "SELECT signature, block_time FROM backlog WHERE round <= ? ORDER BY round, idx DESC LIMIT ?",
        Number(completed),
        MAX_TX_PER_TICK,
      )
      .toArray();
    for (const row of rows) {
      const tx = (await this.rpc
        .getTransaction(row.signature as Signature, {
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
          encoding: "json",
        })
        .send()) as unknown as JsonTx | null;
      if (!tx) break; // not served yet: the next tick tries again, in the same order
      this.count(row.signature, tx, row.block_time);
    }
    return this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM backlog WHERE round <= ?", Number(completed))
      .one().n;
  }

  /** Adds one transaction to the totals, once. */
  private count(signature: string, tx: JsonTx, listedTime: number | null): void {
    const at = tx.blockTime == null ? listedTime : Number(tx.blockTime);
    this.ctx.storage.transactionSync(() => {
      const seen = this.sql
        .exec("SELECT 1 FROM done WHERE signature = ?", signature)
        .toArray().length;
      if (!seen) {
        const events = ticketEventsOf(tx, PROGRAM);
        if (events.length) {
          const applied = applyTx(this.totals(), events, {
            signature,
            at,
            openOf: (ticket) => this.openOf(ticket),
          });
          this.saveTotals(applied.totals);
          for (const [ticket, o] of applied.opened)
            this.sql.exec(
              "INSERT OR REPLACE INTO open_tickets (ticket, price, payout_max, opened_at) VALUES (?, ?, ?, ?)",
              ticket,
              o.price.toString(),
              o.payoutMax.toString(),
              at,
            );
          for (const ticket of applied.closed)
            this.sql.exec("DELETE FROM open_tickets WHERE ticket = ?", ticket);
        }
        this.sql.exec("INSERT INTO done (signature) VALUES (?)", signature);
        this.setMeta("transactions", String(Number(this.meta("transactions") ?? 0) + 1));
        if (at !== null && at > Number(this.meta("through") ?? 0))
          this.setMeta("through", String(at));
      }
      this.sql.exec("DELETE FROM backlog WHERE signature = ?", signature);
    });
    // keep the done list and the openings bounded
    this.sql.exec("DELETE FROM done WHERE rowid <= (SELECT MAX(rowid) FROM done) - ?", DONE_KEPT);
    if (at !== null)
      this.sql.exec("DELETE FROM open_tickets WHERE opened_at < ?", at - OPEN_KEPT_S);
  }

  // --- storage -------------------------------------------------------------------------------

  private totals(): Totals {
    const rows = this.sql
      .exec<{ split: string; json: string }>("SELECT split, json FROM totals")
      .toArray();
    const of = (k: string) => rows.find((r) => r.split === k)?.json;
    return { all: splitFrom(of("all")) };
  }

  private saveTotals(t: Totals): void {
    const put = (k: string, v: unknown) =>
      this.sql.exec(
        "INSERT OR REPLACE INTO totals (split, json) VALUES (?, ?)",
        k,
        JSON.stringify(v),
      );
    put("all", splitJson(t.all));
  }

  private openOf(ticket: Address): OpenTicket | null {
    const r = this.sql
      .exec<{ price: string; payout_max: string }>(
        "SELECT price, payout_max FROM open_tickets WHERE ticket = ?",
        ticket,
      )
      .toArray()[0];
    return r ? { price: BigInt(r.price), payoutMax: BigInt(r.payout_max) } : null;
  }

  private meta(k: Meta): string | null {
    return (
      this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null
    );
  }

  private setMeta(k: Meta, v: string): void {
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, v);
  }

  private delMeta(k: Meta): void {
    this.sql.exec("DELETE FROM meta WHERE k = ?", k);
  }
}
