// The all-time figures behind GET /v1/stats: tickets opened and drawn, wins, what winners
// were paid, the biggest and the last win. The program keeps no such counters, so this
// Durable Object reads the program's whole history once and then follows it, on its own alarm:
//
//   1. Listing. A round pages getSignaturesForAddress(PROGRAM) from the newest signature back
//      to the cursor (the newest signature of the last complete round), a few pages a tick,
//      and queues every successful one in `backlog`. When it reaches the cursor the round is
//      complete and its newest signature becomes the cursor. The first round reaches back to
//      the deploy. A cursor the RPC no longer holds (a short-retention node pruned it, the
//      refusal lasting: `signaturesPage`) is listed back past without it, to its slot or to the
//      oldest signature the RPC holds (`list`): what the RPC dropped in between is not
//      counted, and nothing counts twice.
//   2. Processing. Up to MAX_TX_PER_TICK queued transactions of complete rounds, oldest first:
//      getTransaction, decode the ticket events (statsIndex.ts), and in one storage
//      transaction add them to the totals, record the signature as done and unqueue it. A
//      signature already done is only unqueued: a transaction never counts twice.
//
// Both paths' tickets count (statsIndex.ts): a direct ticket from its opening to its settlement
// or expiry, a beacon ticket from its join to its settlement or return.
//
// Everything is read at `finalized`, so nothing counted can be rolled back. A tick that hits
// an RPC error stops there; the next one resumes from what is stored. A transaction the RPC
// keeps failing to return (MAX_IN_ORDER_TRIES ticks in a row) is set aside instead of holding
// every later one back: it stays queued, read again on its own backoff, and counted when it
// is served. Counted out of order, a ticket's close can come before its opening: a direct
// ticket's win is counted without a kind; its opening, once counted, fills the kind in
// (closed_unopened), and is not remembered as open.
//
// 3. Replay. An index that counted transactions with the direct path's events alone
//    (`events_version` 1, before the beacon was counted) reads again, once, the transactions
//    it counted since REPLAY_FROM, and counts their beacon events alone: the direct ones are
//    in the totals already. The replay covers the signatures up to the cursor of the moment
//    it starts, every one of them listed then; those still queued at that moment
//    (replay_skip) are counted in full by step 2 and skipped. Each replayed transaction is
//    unqueued in the storage transaction that counts it, so none counts twice. It reads only
//    while step 2 has nothing to read right away, out of order (the same out-of-order closes
//    as above), and the figures stay served meanwhile.
//
// The vault's APR (GET /v1/apr, aprIndex.ts) comes from the same reads: step 2 records each
// transaction's openings, refunds and closes (`EpochStruck`, the vault's assets after it) as it
// counts it, in the storage transaction that counts it, for the last APR_KEPT_S. Recording is
// idempotent (keyed by ticket and by epoch), so a transaction recorded twice changes nothing.
//
// The vault page's public history (GET /v1/vault and GET /v1/feed, vaultIndex.ts) comes from the
// same reads too: step 2 records each transaction's ticket openings and ends, closes and deposit
// and withdrawal requests, keyed by ticket, by epoch and by signature, for the last
// VIEWS_KEPT_S. Each part of a ticket is written on its own, so the order the transactions are
// read in does not matter, and recording one twice changes nothing.
//
// 4. Replay of what is recorded. An index that recorded its transactions with an earlier
//    RECORDED_EVENTS_VERSION (`apr_version`: none before the APR, 1 before the vault views)
//    reads again, once, the transactions of its last APR_KEPT_S up to the cursor of the moment
//    it starts, newest first, and records their APR and vault views' events alone: the last
//    days are complete first, then the series reach back. It reads only while steps 2 and 3
//    have nothing to read right away. Until it is done, what it replays for (the APR, the vault
//    views, or both; `apr_covered`, `views_covered`) counts from the oldest point it reached
//    (every newer transaction is recorded), and says it is syncing; what was already complete
//    stays served as it is. A transaction the RPC still fails to return after LP_GIVE_UP_TRIES
//    reads is left out of that count (it is read again every hour, and recorded once served).
//
// The replays (steps 3 to 5, and the Queue's history below) are bounded by the object's
// duration: REPLAY_TICK_MS of reads a tick, the next tick REPLAY_INTERVAL_MS later when they are
// all there is to read, REPLAY_DAILY_MS a UTC day (see REPLAY_TICK_MS).
//
// The APR's answer is built at most once a minute, from the stored rows and a read of the
// Config (the protocol share) and the Vault (its total assets now), and kept: a request is
// served from it; the loop builds it again only once a transaction was counted since, or every
// APR_IDLE_REFRESH_MS. The vault views' are built from the stored rows (and the integrator records
// and payout tables they name, each read once): GET /v1/vault at most once a minute, GET
// /v1/feed at most every FEED_REFRESH_MS, and kept in memory; while the feed is asked for, the
// loop follows the program every FEED_IDLE_INTERVAL_MS instead of IDLE_INTERVAL_MS. The feed
// holds the FEED_TICKETS tickets opened last and the FEED_TICKETS with the newest events, and
// says from when it holds every ticket opened (`ticketsFrom`). Each tick
// that finds every listed transaction read notes it (`current_at`): views built once the loop
// has not for INDEX_FRESH_S (an RPC outage) say they are syncing, so the app reads the history
// itself instead of a frozen one.
//
// The liquidity providers (GET /v1/providers, providersIndex.ts) are a snapshot of the chain,
// not of the history: one read of every token account of the share mint, of the open deposit
// and withdrawal requests and epoch records, and of the vault, worked out with the app's own
// arithmetic and kept in `meta`, built again at most every PROVIDERS_REFRESH_MS while it is
// asked for. Each owner's first deposit request comes from the Queue's history, which only
// `request_deposit`, `request_withdraw` and `strike_epoch` write (far lighter than the
// program's): while the providers were asked for in the last PROVIDERS_ASKED_KEPT_MS, a round
// lists the Queue's signatures from the newest back to `lp_cursor` (the first back to the
// deploy) in the ticks the steps above leave free, and their `DepositRequested` events keep the
// earliest request of each owner (`lp_first_deposits`, a minimum: the order of reads does not
// matter, and reading one twice changes nothing). The first deposits are served once the first
// round is read in full (`lp_backfilled`), a transaction the RPC still fails to return after
// LP_GIVE_UP_TRIES reads left out of that count (it is read again every hour). From then on
// step 2 keeps them as it counts each `DepositRequested`, and a round of the Queue's history
// starts only every LP_FOLLOW_MS; the loop builds the list again only once a transaction with a
// provider's event was counted since (`lp_changed_at`), or every PROVIDERS_IDLE_REFRESH_MS.
//
// One wallet's history (GET /v1/wallet/:owner, walletIndex.ts) comes from the same reads too:
// step 2 stores each transaction's ticket events and deposit and withdrawal events, as decoded
// (`wallet_txs`), with the accounts a wallet's history finds them by (`wallet_keys`: a ticket's
// opening by its integrator record and its beneficiary, every event of a ticket by the ticket, an
// LP event by its owner), for the program's whole history. Storing one twice changes nothing,
// and the order they are stored in does not matter: the answer is worked out at each build with
// the app's own code, from the wallet's integrator record, its USDC account and the wallet
// itself, then the tickets they opened. It is built at most every WALLET_REFRESH_MS per wallet,
// one build at a time shared by the requests that wait for it, and kept in memory that long (at
// most WALLET_KEPT answers, the latest built). A build reads at most WALLET_READ_MAX stored transactions,
// counted in SQL before any is parsed: a larger wallet (a busy app's integrator) is answered
// `oversized` and syncing, and the app reads its newest history itself. It says up to when every
// program transaction is in it (`through`: the newest one counted, or just before the oldest
// one listed and not counted yet, unless the RPC keeps failing to return that one), so the app
// reads only the wallet's newer ones itself.
//
// 5. Replay for the wallets. An index that counted transactions before it stored them for the
//    wallets (no `wallet_version`) reads again, once, its whole history up to the cursor of the
//    moment it starts, newest first, in the ticks steps 2 to 4 and the Queue's history leave
//    free, and stores them. Until it is done (`wallet_covered`) every wallet's answer says it is
//    syncing; a transaction the RPC still fails to return after LP_GIVE_UP_TRIES reads is left
//    out of that count (it is read again every hour, and stored once served).
//
// The live push (GET /v1/live, liveHub.ts) pushes the same answers to open pages instead of
// letting them poll. The object accepts the WebSockets with the Hibernation API
// (`acceptWebSocket`, the `webSocketMessage` and `webSocketClose` handlers, each connection's
// subscriptions in its attachment, the app's "ping" answered "pong" by the runtime itself): an
// open page costs no duration while nothing happens, and the hub is built again from the
// attachments when the object wakes up. The push has no timer of its own: it goes out at the end
// of the alarms the loop runs anyway, which also close the connections subscribed to nothing. A
// topic subscribed to counts as asked for (the tick builds its answer as for a request; the feed,
// or a wallet, subscribed to keeps the loop following the program every FEED_IDLE_INTERVAL_MS);
// at the end of each alarm, each subscribed topic's answer, the very one its route would serve,
// goes to its subscribers when it changed or at least every LIVE_REFRESH_MS, built again only
// when a transaction changed what it shows or its window slid (`liveView`). A wallet
// subscribed to is notified of the transactions step 2 counted for it since the last push (by
// its own accounts, or by a ticket whose opening names them), its kept answer dropped first:
// the request that follows is built with them. Nothing is stored for the push: every message is
// an answer of the index, or names transactions it holds.
import { DurableObject } from "cloudflare:workers";
import { getBase58Decoder, isAddress, type Address, type Signature } from "@solana/kit";
import {
  DEPOSIT_REQUEST_DISCRIMINATOR,
  EPOCH_RECORD_DISCRIMINATOR,
  WITHDRAW_REQUEST_DISCRIMINATOR,
  findConfigPda,
  findIntegratorPda,
  findQueuePda,
  findShareMintPda,
  findVaultAuthorityPda,
  findVaultPda,
  getConfigDecoder,
  getDepositRequestDecoder,
  getEpochRecordDecoder,
  getIntegratorDecoder,
  getPayoutTableDecoder,
  getVaultDecoder,
  getWithdrawRequestDecoder,
} from "../../../clients/js/src/generated/fade/index.ts";
import { BPS } from "../../web/src/lib/math.ts";
import { TOKEN_ACCOUNT_SIZE, shareHoldersOf } from "../../web/src/lib/providers.ts";
import { getJsonTransaction } from "../../../clients/js/src/transactionFetch.ts";
import {
  DEFAULT_RPC_URL,
  PROGRAM,
  TOKEN,
  USDC_MINT,
  ata,
  cfg,
  decodeBase64,
  describeError,
  makeRpc,
  type Rpc,
} from "./chain.ts";
import { missingBound, noteRefusal, refusalAnswered } from "./rpcHistory.ts";
import type { Env } from "./index.ts";
import {
  APR_EVENTS_VERSION,
  APR_KEPT_S,
  aprEventsOf,
  aprTicketOf,
  aprView,
  type AprEvent,
  type AprView,
} from "./aprIndex.ts";
import { depositOwnersOf, providersView, type ProvidersView } from "./providersIndex.ts";
import { LiveHub, type LiveTx } from "./liveHub.ts";
import {
  LIVE_PING,
  LIVE_PONG,
  LIVE_REFRESH_MS,
  type LiveTopic,
} from "../../web/src/lib/liveProtocol.ts";
import { LP_KINDS, isAppRow, isBuyerRow } from "../../web/src/lib/walletHistory.ts";
import {
  WALLET_EVENTS_VERSION,
  WALLET_FINALITY_S,
  WALLET_READ_MAX,
  eventsFrom,
  eventsJson,
  laterTicketsOf,
  openingAccountsOf,
  oversizedWalletView,
  walletEventsOf,
  walletView,
  type WalletTx,
  type WalletView,
} from "./walletIndex.ts";
import {
  EVENTS_VERSION,
  applyTx,
  splitFrom,
  splitJson,
  ticketEventsOf,
  withWinKind,
  type JsonTx,
  type OpenTicket,
  type SplitJson,
  type TicketEvent,
  type Totals,
} from "./statsIndex.ts";
import {
  FEED_REQUESTS,
  FEED_TICKETS,
  INDEX_FRESH_S,
  RECORDED_EVENTS_VERSION,
  SERIES_DAYS,
  VIEWS_KEPT_S,
  appShareBpsOf,
  feedView,
  vaultEventsOf,
  vaultView,
  type FeedView,
  type StoredRequest,
  type StoredVaultTicket,
  type VaultEvent,
  type VaultView,
} from "./vaultIndex.ts";

/**
 * Tick period while there is history to read, and once caught up. Nothing here
 * has a deadline (it only reads, at `finalized`), so the idle period only
 * bounds how stale the figures get while nobody reads them; a read finds them
 * at most `READ_FRESH_MS` old (`freshen`).
 */
const BUSY_INTERVAL_MS = 2_000;
const IDLE_INTERVAL_MS = 60_000;
/** A read (GET /v1/stats, /v1/apr) pulls the next tick to now when the last one is older. */
const READ_FRESH_MS = 20_000;
/**
 * The replays (steps 3 to 5, and the Queue's history) are bounded by the object's duration, not
 * only by their reads: a Durable Object's duration is metered on its wall-clock time while a
 * handler runs, awaiting the RPC included, so the replays keep to a daily time budget across
 * every object of the keeper together. A tick spends REPLAY_TICK_MS at most on them;
 * a tick that had only them to read is followed by the next after REPLAY_INTERVAL_MS (at most the
 * idle period); and they spend REPLAY_DAILY_MS a UTC day at most, then wait for the next day
 * (`replay_day`, `replay_ms`). Their answers say they are syncing meanwhile, and the app reads
 * what they cover itself.
 */
const REPLAY_TICK_MS = 5_000;
const REPLAY_INTERVAL_MS = 15_000;
const REPLAY_DAILY_MS = 3 * 3_600_000;
/** getSignaturesForAddress pages per tick, of up to PAGE signatures each. */
const MAX_PAGES_PER_TICK = 2;
/** What a replay says when the RPC no longer holds the signature its listing stopped at. */
const historyGone = (replay: string, before: string) =>
  `stats: the RPC no longer holds ${before}, where the ${replay} listing stopped: it ends there, the older transactions the RPC dropped not replayed`;
/** A page of `getSignaturesForAddress`, as the RPC client types it. */
type SignaturePage = Awaited<ReturnType<ReturnType<Rpc["getSignaturesForAddress"]>["send"]>>;
const PAGE = 1_000;
/** getTransaction calls per tick, one at a time. */
const MAX_TX_PER_TICK = 20;
/**
 * getTransaction calls per tick of the APR replay (step 4): it runs once, in the ticks the
 * history leaves free, and a longer tick only delays the next by a few seconds.
 */
const MAX_APR_REPLAY_PER_TICK = 50;
/** Failed reads of one transaction, each retried on the next tick in order, before it is set aside. */
const MAX_IN_ORDER_TRIES = 3;
/** A transaction set aside is read again after `min(1 min × 2^(tries − MAX_IN_ORDER_TRIES), 1 h)`. */
const asideBackoffMs = (tries: number) =>
  Math.min(60_000 * 2 ** Math.max(0, tries - MAX_IN_ORDER_TRIES), 3_600_000);
/** Signatures remembered as done (the overlap a listing could repeat is far smaller). */
const DONE_KEPT = 20_000;
/**
 * An opening never closed, or a close whose opening was never counted, is forgotten after this
 * long (the program expires tickets in minutes).
 */
const OPEN_KEPT_S = 30 * 86_400;
/**
 * How far back the replay reads (Unix seconds, 18 October 2026 00:00 UTC): no beacon event is
 * older. The beacon's binary reached the live devnet program on 18 October 2026 with its rounds
 * paused, and they opened on the 19th; the mainnet program does not run it yet.
 */
export const REPLAY_FROM = 1_792_281_600;
/** A replayed transaction the RPC failed to return is read again after `min(1 min × 2^(tries − 1), 1 h)`. */
const replayBackoffMs = (tries: number) =>
  Math.min(60_000 * 2 ** Math.max(0, tries - 1), 3_600_000);
/** The APR's answer is built again once it is this old. */
const APR_REFRESH_MS = 60_000;
/** Older than this, a request waits for a new answer instead of being served the kept one. */
const APR_STALE_MS = 5 * 60_000;
/** The loop keeps the APR's answer fresh for this long after a request, then waits for the next. */
const APR_ASKED_KEPT_MS = 3_600_000;
/**
 * The loop builds the APR's answer again (at most every APR_REFRESH_MS) once a transaction was
 * counted since the last build, else once it is this old: its trailing window slides.
 */
const APR_IDLE_REFRESH_MS = 10 * 60_000;
/** Payout tables read in one getMultipleAccounts call (the RPC's limit). */
const ACCOUNTS_PER_CALL = 100;
/** GET /v1/vault's answer is built again once it is this old, and older than the next, waited for. */
const VAULT_REFRESH_MS = 60_000;
const VAULT_STALE_MS = 5 * 60_000;
/** GET /v1/feed's answer is built again once it is this old, and older than the next, waited for. */
const FEED_REFRESH_MS = 5_000;
const FEED_STALE_MS = 60_000;
/**
 * Tick period once caught up while the feed (or a wallet, on the live push) was asked for in the
 * last FEED_ASKED_KEPT_MS: a read's own freshness (READ_FRESH_MS), kept without a read.
 */
const FEED_IDLE_INTERVAL_MS = READ_FRESH_MS;
const FEED_ASKED_KEPT_MS = 120_000;
/** GET /v1/providers' answer is built again once it is this old, and older than the next, waited for. */
const PROVIDERS_REFRESH_MS = 120_000;
const PROVIDERS_STALE_MS = 10 * 60_000;
/**
 * The loop keeps the providers' answer fresh, and follows the Queue's history for their first
 * deposits, for this long after a request.
 */
const PROVIDERS_ASKED_KEPT_MS = 3_600_000;
/**
 * The loop builds the providers' answer again (at most every PROVIDERS_REFRESH_MS) once a
 * transaction with a liquidity provider's event was counted since the last build
 * (`lp_changed_at`), else once it is this old (a share transfer outside the program, which the
 * program's history does not show).
 */
const PROVIDERS_IDLE_REFRESH_MS = 5 * 60_000;
/**
 * Once the first deposits are read back to the deploy, step 2 keeps them (each counted
 * `DepositRequested`), and the Queue's history is followed only this often, a net for a
 * transaction counted before step 2 kept them.
 */
const LP_FOLLOW_MS = 10 * 60_000;
/** getTransaction calls per tick of the Queue's history. */
const MAX_LP_TX_PER_TICK = 20;
/**
 * Failed reads of one Queue transaction before the first deposits are served without it (about
 * two hours of backoff): it stays listed and is read again every hour, and keeps the earliest
 * request it holds once the RPC serves it.
 */
const LP_GIVE_UP_TRIES = 8;
/** One wallet's answer is built again once it is this old. */
const WALLET_REFRESH_MS = 10_000;
/**
 * The most answers kept in memory, the latest built: an answer is dropped once WALLET_REFRESH_MS
 * old (it is never served past that), so this bounds only the wallets built in the last 10 s.
 */
const WALLET_KEPT = 32;
/**
 * Accounts bound in one `IN (…)` of the wallet history's queries: Durable Object SQLite refuses a
 * statement with more than 100 bound parameters ("too many SQL variables").
 */
const KEYS_PER_QUERY = 90;
/**
 * Failed reads of a listed transaction before it stops holding the wallets' `through` back
 * (about 7 minutes after it is set aside, under the app's WALLET_TAIL_MAX_S of 15): an
 * unreadable one would otherwise freeze `through`, and turn the keeper's history off for every
 * wallet while nothing says so. It stays queued and is stored once the RPC serves it.
 */
const WALLET_THROUGH_GIVE_UP_TRIES = MAX_IN_ORDER_TRIES + 3;

export type StatsView = {
  /** ISO 8601: when this answer was built. */
  updatedAt: string;
  /** The first read of the history is not finished: the figures are still climbing to their value. */
  syncing: boolean;
  /**
   * Program transactions read so far, the time of the newest (Unix seconds), and whether the
   * replay of the beacon's events (stats.ts, step 3) is still running.
   */
  indexed: { transactions: number; through: number | null; replaying: boolean };
  all: SplitJson;
};

type Meta =
  | "cursor"
  | "round"
  | "round_head"
  | "round_before"
  | "round_listed"
  | "round_head_slot"
  | "round_cursor_lost"
  | "cursor_slot"
  | "refusal_round"
  | "completed_round"
  | "caught_up"
  | "transactions"
  | "through"
  | "events_version"
  | "replay_before"
  | "replay_listed"
  | "replay_listing"
  | "refusal_replay"
  | "apr_version"
  | "apr_covered"
  | "apr_replay_before"
  | "apr_replay_listed"
  | "apr_replay_listing"
  | "refusal_apr_replay"
  | "apr_replay_from"
  | "apr_replay_floor"
  | "apr_view"
  | "apr_view_at"
  | "views_covered"
  | "current_at"
  | "providers_view"
  | "providers_view_at"
  | "lp_cursor"
  | "lp_cursor_slot"
  | "lp_round_head_slot"
  | "lp_round_cursor_lost"
  | "refusal_lp"
  | "lp_round"
  | "lp_round_head"
  | "lp_round_before"
  | "lp_completed"
  | "lp_backfilled"
  | "wallet_version"
  | "wallet_covered"
  | "wallet_replay_before"
  | "wallet_replay_listed"
  | "wallet_replay_listing"
  | "refusal_wallet_replay"
  | "apr_view_tx"
  | "lp_changed_at"
  | "lp_followed_at"
  | "replay_day"
  | "replay_ms"
  | "apr_asked_at";

/**
 * Transactions counted and not pushed yet, kept for the wallets' notifications (one alarm's worth;
 * the oldest dropped past it).
 */
const LIVE_TXS_KEPT = 1_000;

/** The vault views' answers, kept in memory. */
type ViewKind = "vault" | "feed";

/**
 * `vault_tickets.refunded`: 0 for none, `REFUNDED_PRICE` for a beacon ticket whose round was
 * refunded (its price back to its funder), `REFUNDED_CREDIT` for a direct ticket refunded its
 * vault credit (`refund_expired_ticket`, its payout).
 */
const REFUNDED_PRICE = 1;
const REFUNDED_CREDIT = 2;

/** The `refunded` code of a ticket's end. */
const refundedCode = (e: Extract<VaultEvent, { kind: "settled" | "expired" | "returned" }>) =>
  e.kind === "returned" && e.refunded
    ? REFUNDED_PRICE
    : e.kind === "expired" && e.refunded
      ? REFUNDED_CREDIT
      : 0;

export class Stats extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly rpc: Rpc;
  /**
   * When GET /v1/apr was last asked (milliseconds; also stored as `apr_asked_at`, which
   * outlives a hibernation), and the build of its answer under way.
   */
  private aprAskedAt = -Infinity;
  /** When the last tick started (memory only: after a hibernation the first read asks for one). */
  private lastTickAt = 0;
  private aprBuild: Promise<AprView> | null = null;
  /** When GET /v1/feed was last asked (milliseconds). */
  private feedAskedAt = -Infinity;
  /** When GET /v1/providers was last asked (milliseconds), and the build of its answer under way. */
  private providersAskedAt = -Infinity;
  private providersBuild: Promise<ProvidersView> | null = null;
  /** The vault views' answers kept (and when they were built, milliseconds), and their builds under way. */
  private readonly kept = new Map<ViewKind, { view: unknown; at: number }>();
  private readonly building = new Map<ViewKind, Promise<unknown>>();
  /** The wallets' answers kept (and when they were built, milliseconds), the latest asked last. */
  private readonly wallets = new Map<Address, { view: WalletView; at: number }>();
  /** The wallets' builds under way: requests at the same time share one. */
  private readonly walletBuilds = new Map<Address, Promise<WalletView>>();
  /** The live push's connections (liveHub.ts), restored from their attachments on first use. */
  private hub: LiveHub<WebSocket> | null = null;
  /** The transactions counted since the last push, for the wallets' notifications. */
  private liveTxs: (LiveTx & { tickets: string[] })[] = [];
  /**
   * When a wallet was last subscribed to on the live push (milliseconds): the loop follows the
   * program every FEED_IDLE_INTERVAL_MS meanwhile, as for the feed, so its notifications come soon.
   */
  private liveAt = -Infinity;
  /** When the last transaction with vault views' events was recorded (milliseconds). */
  private viewsChangedAt = Date.now();
  /** The last tick's state: following the program (busy), replaying only, or neither. */
  private paced: "busy" | "replaying" | "idle" = "idle";
  /** This tick's replays: when they must stop reading (milliseconds), and whether they read. */
  private replayDeadline = Infinity;
  private replayRead = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.rpc = makeRpc(env.RPC_URL || DEFAULT_RPC_URL);
    // the app's heartbeat, answered by the runtime itself without waking the object; set before
    // any connection is accepted and on every wake-up (nothing to set where there is no runtime)
    try {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(LIVE_PING, LIVE_PONG));
    } catch {
      // not the Workers runtime (tests)
    }
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS backlog (
      signature TEXT PRIMARY KEY,
      round INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      block_time INTEGER
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS backlog_order ON backlog (round, idx)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS done (signature TEXT PRIMARY KEY)");
    // Queued transactions the RPC failed to return: failed reads in a row, and when to read again.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS failures (
      signature TEXT PRIMARY KEY,
      tries INTEGER NOT NULL,
      retry_at INTEGER NOT NULL
    )`);
    // Tickets closed before their opening was counted (a transaction set aside): see count().
    this.sql.exec(`CREATE TABLE IF NOT EXISTS closed_unopened (
      ticket TEXT PRIMARY KEY,
      closed_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS open_tickets (
      ticket TEXT PRIMARY KEY,
      price TEXT NOT NULL,
      payout_max TEXT NOT NULL,
      opened_at INTEGER
    )`);
    // Null for a ticket remembered before the index kept them: a direct one, whose close names it.
    this.addColumn("open_tickets", "integrator", "TEXT");
    this.addColumn("open_tickets", "beacon", "INTEGER NOT NULL DEFAULT 0");
    // Step 3: the transactions to replay, and the ones queued for step 2 when it started.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS replay (
      signature TEXT PRIMARY KEY,
      idx INTEGER NOT NULL,
      block_time INTEGER,
      tries INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS replay_skip (signature TEXT PRIMARY KEY)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS totals (split TEXT PRIMARY KEY, json TEXT NOT NULL)");
    // The APR's records (aprIndex.ts): a direct ticket's margin and app share, or a beacon
    // ticket's payout table and shares; micro-USDC and basis points as decimal strings.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS apr_tickets (
      ticket TEXT PRIMARY KEY,
      opened_at INTEGER,
      price TEXT NOT NULL,
      margin_bps TEXT,
      app_share_bps TEXT,
      payout_table TEXT,
      app_share TEXT,
      protocol_share TEXT
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS apr_tickets_opened ON apr_tickets (opened_at)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS apr_refunds (ticket TEXT PRIMARY KEY, at INTEGER)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS apr_strikes (
      epoch_id TEXT PRIMARY KEY,
      t INTEGER NOT NULL,
      assets TEXT NOT NULL
    )`);
    // `Σ p·m` of each payout table a beacon ticket joined with: a table never changes.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS payout_tables (address TEXT PRIMARY KEY, lhs TEXT NOT NULL)",
    );
    // The vault views' records (vaultIndex.ts): each ticket's opening and end, written apart;
    // micro-USDC and basis points as decimal strings. `last_at`: its newest event's time.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS vault_tickets (
      ticket TEXT PRIMARY KEY,
      integrator TEXT,
      beacon INTEGER NOT NULL DEFAULT 0,
      opened_at INTEGER,
      open_sig TEXT,
      price TEXT,
      payout_max TEXT,
      vault_credit TEXT,
      margin_bps TEXT,
      app_share_bps TEXT,
      payout_table TEXT,
      app_share TEXT,
      end_kind TEXT,
      payout TEXT,
      pending INTEGER,
      refunded INTEGER,
      end_at INTEGER,
      end_sig TEXT,
      claimed INTEGER NOT NULL DEFAULT 0,
      last_at INTEGER
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS vault_tickets_last ON vault_tickets (last_at)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS vault_tickets_opened ON vault_tickets (opened_at)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS vault_strikes (
      epoch_id TEXT PRIMARY KEY,
      t INTEGER NOT NULL,
      total_assets TEXT NOT NULL,
      total_shares TEXT NOT NULL,
      deposits TEXT NOT NULL,
      shares_minted TEXT NOT NULL,
      assets_paid TEXT NOT NULL,
      shares_burnt TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS vault_requests (
      signature TEXT NOT NULL,
      idx INTEGER NOT NULL,
      kind TEXT NOT NULL,
      amount TEXT NOT NULL,
      at INTEGER,
      PRIMARY KEY (signature, idx)
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS vault_requests_at ON vault_requests (at)");
    // The app key of each integrator record the per-app figures name: a record never changes it.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS integrators (address TEXT PRIMARY KEY, authority TEXT NOT NULL)",
    );
    // Step 4: the transactions to read again for the APR and the vault views.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS apr_replay (
      signature TEXT PRIMARY KEY,
      idx INTEGER NOT NULL,
      block_time INTEGER,
      tries INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0
    )`);
    // The Queue's history, for each owner's first deposit request: the signatures listed and not
    // read yet (by round, as `backlog`), and the earliest request read of each owner.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS lp_backlog (
      signature TEXT PRIMARY KEY,
      round INTEGER NOT NULL,
      block_time INTEGER,
      tries INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS lp_first_deposits (
      owner TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      signature TEXT NOT NULL
    )`);
    // The wallets' history (walletIndex.ts): each transaction's events as decoded, and the
    // accounts they are found by.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS wallet_txs (
      signature TEXT PRIMARY KEY,
      at INTEGER,
      slot INTEGER NOT NULL,
      events TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS wallet_keys (
      key TEXT NOT NULL,
      signature TEXT NOT NULL,
      PRIMARY KEY (key, signature)
    )`);
    // Step 5: the transactions to read again for the wallets.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS wallet_replay (
      signature TEXT PRIMARY KEY,
      idx INTEGER NOT NULL,
      block_time INTEGER,
      tries INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0
    )`);
  }

  // --- API ---------------------------------------------------------------------------------

  async stats(): Promise<StatsView> {
    await this.freshen();
    return this.statsView();
  }

  private statsView(): StatsView {
    const t = this.totals();
    const through = this.meta("through");
    return {
      updatedAt: new Date().toISOString(),
      syncing: this.meta("caught_up") !== "1",
      indexed: {
        transactions: Number(this.meta("transactions") ?? 0),
        through: through === null ? null : Number(through),
        replaying: this.replaying(),
      },
      all: splitJson(t.all),
    };
  }

  /**
   * The vault's APR (GET /v1/apr): the answer kept, built again in the background once it is a
   * minute old; a request waits for a build only when there is none, or it is too old to serve.
   */
  async apr(): Promise<AprView> {
    await this.freshen();
    this.aprAskedAt = Date.now();
    this.setMeta("apr_asked_at", String(this.aprAskedAt));
    return this.aprServed();
  }

  /**
   * The answer kept while it is younger than APR_STALE_MS, built again in the background when
   * `due` (a request: once it is APR_REFRESH_MS old); else built now.
   */
  private async aprServed(
    due: () => boolean = () => Date.now() - Number(this.meta("apr_view_at") ?? 0) >= APR_REFRESH_MS,
  ): Promise<AprView> {
    const kept = this.meta("apr_view");
    const age = Date.now() - Number(this.meta("apr_view_at") ?? 0);
    if (kept !== null && age < APR_STALE_MS) {
      if (due()) void this.buildApr().catch(() => {});
      return JSON.parse(kept) as AprView;
    }
    try {
      return await this.buildApr();
    } catch (e) {
      if (kept !== null) return JSON.parse(kept) as AprView;
      throw e;
    }
  }

  /**
   * The vault page's public history (GET /v1/vault): the answer kept, built again in the
   * background once it is a minute old.
   */
  async vault(): Promise<VaultView> {
    await this.freshen();
    return this.served("vault", () => this.buildVault(), VAULT_REFRESH_MS, VAULT_STALE_MS);
  }

  /** The newest tickets and requests (GET /v1/feed): built again once it is FEED_REFRESH_MS old. */
  async feed(): Promise<FeedView> {
    await this.freshen();
    this.feedAskedAt = Date.now();
    return this.served("feed", () => this.buildFeed(), FEED_REFRESH_MS, FEED_STALE_MS);
  }

  /**
   * The liquidity providers (GET /v1/providers): the answer kept, built again in the background
   * once it is PROVIDERS_REFRESH_MS old; a request waits for a build only when there is none, or
   * it is too old to serve.
   */
  async providers(): Promise<ProvidersView> {
    await this.freshen();
    this.providersAskedAt = Date.now();
    return this.providersServed();
  }

  /** As `aprServed`, for the providers (a request: due once PROVIDERS_REFRESH_MS old). */
  private async providersServed(
    due: () => boolean = () =>
      Date.now() - Number(this.meta("providers_view_at") ?? 0) >= PROVIDERS_REFRESH_MS,
  ): Promise<ProvidersView> {
    const kept = this.meta("providers_view");
    const age = Date.now() - Number(this.meta("providers_view_at") ?? 0);
    if (kept !== null && age < PROVIDERS_STALE_MS) {
      if (due()) void this.buildProviders().catch(() => {});
      return JSON.parse(kept) as ProvidersView;
    }
    try {
      return await this.buildProviders();
    } catch (e) {
      if (kept !== null) return JSON.parse(kept) as ProvidersView;
      throw e;
    }
  }

  /**
   * One wallet's history (GET /v1/wallet/:owner): the answer kept for it while it is younger
   * than WALLET_REFRESH_MS, else built now from the stored transactions (one build at a time
   * per wallet, shared by the requests that wait for it).
   */
  async wallet(owner: Address): Promise<WalletView> {
    await this.freshen();
    this.dropOldWallets();
    const kept = this.wallets.get(owner);
    if (kept) return kept.view;
    let build = this.walletBuilds.get(owner);
    if (!build) {
      build = this.buildWallet(owner)
        .then((view) => {
          this.wallets.delete(owner);
          this.wallets.set(owner, { view, at: Date.now() });
          this.dropOldWallets();
          for (const k of this.wallets.keys()) {
            if (this.wallets.size <= WALLET_KEPT) break;
            this.wallets.delete(k);
          }
          return view;
        })
        .finally(() => this.walletBuilds.delete(owner));
      this.walletBuilds.set(owner, build);
    }
    return build;
  }

  /**
   * Drops the answers WALLET_REFRESH_MS old or more: none of them is served again. They are kept
   * in the order they were built, so the old ones come first.
   */
  private dropOldWallets(): void {
    const now = Date.now();
    for (const [k, w] of this.wallets) {
      if (now - w.at < WALLET_REFRESH_MS) break;
      this.wallets.delete(k);
    }
  }

  /** Called by the cron trigger and by every read: restarts the loop should its alarm be lost. */
  async ensureAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    // replace an alarm left in the past: its handler kept failing and it will not fire again
    if (current === null || current < Date.now() - 60_000)
      await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * `ensureAlarm`, and a tick now when the last one is `READ_FRESH_MS` old: while
   * someone reads, the figures follow the program at the pace they did before the
   * idle period grew; while nobody does, the loop ticks once a minute. This read
   * answers from what is stored, as before; the tick it asks for serves the next.
   */
  private async freshen(): Promise<void> {
    await this.ensureAlarm();
    if (Date.now() - this.lastTickAt < READ_FRESH_MS) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > Date.now() + BUSY_INTERVAL_MS)
      await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * One tick, then the live push. The next alarm comes after BUSY_INTERVAL_MS while the program's
   * history is read, REPLAY_INTERVAL_MS while only the replays are, else the idle period: the
   * push has no timer of its own, it goes out at the end of the alarms the loop runs anyway.
   */
  override async alarm(): Promise<void> {
    this.lastTickAt = Date.now();
    const hub = this.openHub();
    // the topics subscribed to count as asked for: the tick builds their answers as for a request
    if (hub) this.noteLiveAsks(hub);
    try {
      await this.tick();
    } catch (e) {
      this.paced = "idle";
      console.error(`stats tick failed: ${describeError(e)}`);
    } finally {
      if (hub) {
        await this.pushLive(hub).catch((e: unknown) =>
          console.error(`stats live push failed: ${describeError(e)}`),
        );
        hub.reap();
      }
      // no connection: no wallet to tell of what this tick counted
      else this.liveTxs = [];
      const idle =
        Date.now() - Math.max(this.feedAskedAt, this.liveAt) < FEED_ASKED_KEPT_MS
          ? FEED_IDLE_INTERVAL_MS
          : IDLE_INTERVAL_MS;
      const period =
        this.paced === "busy"
          ? BUSY_INTERVAL_MS
          : this.paced === "replaying"
            ? Math.min(REPLAY_INTERVAL_MS, idle)
            : idle;
      const target = Date.now() + period;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > target) await this.ctx.storage.setAlarm(target);
    }
  }

  // --- the loop ------------------------------------------------------------------------------

  /** One bounded step; true while there is more to read right away. */
  private async tick(): Promise<boolean> {
    this.startReplay();
    this.startAprReplay();
    this.startWalletReplay();
    const listing = await this.list();
    const { left, ready } = await this.process();
    if (!listing && left === 0 && this.meta("completed_round") !== null)
      this.setMeta("caught_up", "1");
    // every listed transaction read (those set aside wait for their retry): the vault views
    // stay complete while this keeps being true (vaultIndex.ts, INDEX_FRESH_S)
    if (!listing && ready === 0 && this.meta("completed_round") !== null)
      this.setMeta("current_at", String(Math.floor(Date.now() / 1_000)));
    const following = listing || ready > 0;
    const replaying = following ? false : await this.replays();
    await this.refreshApr();
    await this.refreshProviders();
    // Only transactions set aside left: their own backoff, not the busy period, paces them.
    this.paced = following ? "busy" : replaying ? "replaying" : "idle";
    return following || replaying;
  }

  /**
   * The replays, in the ticks the history leaves free, the beacon's first, within this tick's
   * REPLAY_TICK_MS and the day's REPLAY_DAILY_MS. True while one has more to read right away.
   */
  private async replays(): Promise<boolean> {
    const day = Math.floor(Date.now() / 86_400_000);
    const spent = Number(this.meta("replay_day")) === day ? Number(this.meta("replay_ms") ?? 0) : 0;
    if (spent >= REPLAY_DAILY_MS) return false;
    const started = Date.now();
    this.replayDeadline = started + REPLAY_TICK_MS;
    this.replayRead = false;
    try {
      const replaying = await this.replay();
      const aprReplaying = replaying ? false : await this.aprReplay();
      // The Queue's history, for the providers' first deposits, takes the ticks left free after:
      // it is light, while the wallets' replay is a one-off backfill of the whole history whose
      // answers say syncing meanwhile, and takes the ticks it leaves free.
      const lpReading =
        replaying || aprReplaying || !this.providersAsked() ? false : await this.followLp();
      const walletReplaying =
        replaying || aprReplaying || lpReading ? false : await this.walletReplay();
      return replaying || aprReplaying || lpReading || walletReplaying;
    } finally {
      this.replayDeadline = Infinity;
      if (this.replayRead) {
        const total = spent + (Date.now() - started);
        this.ctx.storage.transactionSync(() => {
          this.setMeta("replay_day", String(day));
          this.setMeta("replay_ms", String(total));
        });
        if (total >= REPLAY_DAILY_MS)
          console.warn(
            `stats: the replays spent their ${REPLAY_DAILY_MS / 3_600_000} h of today; ` +
              "they go on tomorrow (UTC), their answers syncing meanwhile",
          );
      }
    }
  }

  /** Whether this tick's replays must stop reading; marks that they read otherwise. */
  private replayOver(): boolean {
    if (Date.now() >= this.replayDeadline) return true;
    this.replayRead = true;
    return false;
  }

  /**
   * One page of `address`'s signatures at `finalized`, newest first, after `until` and before
   * `before` (both excluded, either absent). `lost` names a bound the RPC no longer holds
   * (`missingBound`: its history pruned past it), the page then empty; any other error is thrown.
   * So is a refusal that does not last yet (`noteRefusal`, kept in `refusal`, one per listing): a
   * node a slot or two behind a load balancer refuses a signature it has not seen yet as a pruned
   * one, and what the caller does with `lost` (a cursor dropped, a listing ended) is not undone,
   * so the call is asked again next tick instead, at no extra cost.
   */
  private async signaturesPage(
    address: Address,
    until: string | null,
    before: string | null,
    refusal: Meta,
  ): Promise<{ sigs: SignaturePage; lost: "until" | "before" | null }> {
    const bounds = { until, before };
    try {
      const sigs = await this.rpc
        .getSignaturesForAddress(address, {
          limit: PAGE,
          commitment: "finalized",
          ...(until ? { until: until as Signature } : {}),
          ...(before ? { before: before as Signature } : {}),
        })
        .send();
      if (refusalAnswered(this.meta(refusal), bounds)) this.delMeta(refusal);
      return { sigs, lost: null };
    } catch (e) {
      const lost = missingBound(e, bounds);
      if (lost === null) throw e;
      const noted = noteRefusal(
        this.meta(refusal),
        (lost === "until" ? until : before)!,
        Date.now(),
      );
      if (!noted.confirmed) {
        this.setMeta(refusal, noted.record);
        throw e;
      }
      this.delMeta(refusal);
      return { sigs: [], lost };
    }
  }

  /**
   * Pages the newest signatures back to the cursor; true while the round is not complete.
   *
   * A cursor the RPC no longer holds (`round_cursor_lost`: a short-retention node pruned it, as a
   * local validator does within minutes, its refusal lasting: `signaturesPage`) refuses every
   * call bounded by it, so the round pages back without it instead, to the first signature older
   * than the cursor's slot (`cursor_slot`) or, for a cursor stored without it, older than the
   * newest transaction counted (`through`), or to the oldest signature the RPC holds: what the RPC
   * dropped in between cannot be read from it, and is said once. A signature listed again is
   * counted once (`done`). A `before` it no longer holds ends the round with what it listed, for
   * the same reason.
   */
  private async list(): Promise<boolean> {
    const cursor = this.meta("cursor");
    const cursorSlot = this.meta("cursor_slot");
    const round = Number(this.meta("round") ?? 0) + (this.meta("round_head") === null ? 1 : 0);
    for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
      const before = this.meta("round_before");
      const lostCursor = this.meta("round_cursor_lost") !== null;
      const until = cursor && !lostCursor ? cursor : null;
      const { sigs: listedSigs, lost } = await this.signaturesPage(
        PROGRAM,
        until,
        before,
        "refusal_round",
      );
      if (lost === "until") {
        console.warn(
          `stats: the RPC no longer holds the cursor ${cursor}: this round lists back to the oldest signature it holds` +
            (cursorSlot !== null
              ? ` or slot ${cursorSlot}`
              : " or the newest transaction counted") +
            "; the transactions it dropped in between are not counted",
        );
        this.setMeta("round_cursor_lost", "1");
        continue;
      }
      if (lost === "before")
        console.warn(
          `stats: the RPC no longer holds ${before}, where this round's listing stopped: the round ends with what it listed; the older transactions it dropped are not counted`,
        );
      // Without the cursor, the round ends at the first signature older than the cursor's slot,
      // or, for a cursor stored before its slot was, older than the newest transaction counted
      // (`through`): `done` keeps the last DONE_KEPT signatures only, so a listing reaching
      // further back than that could count an old transaction twice.
      const slotFloor = lostCursor && cursorSlot !== null ? BigInt(cursorSlot) : null;
      const through = this.meta("through");
      const timeFloor =
        lostCursor && slotFloor === null && through !== null ? Number(through) : null;
      const end =
        slotFloor !== null
          ? listedSigs.findIndex((s) => BigInt(s.slot) < slotFloor)
          : timeFloor !== null
            ? listedSigs.findIndex((s) => s.blockTime !== null && Number(s.blockTime) < timeFloor)
            : -1;
      const sigs = end === -1 ? listedSigs : listedSigs.slice(0, end);
      const listed = Number(this.meta("round_listed") ?? 0);
      this.ctx.storage.transactionSync(() => {
        this.setMeta("round", String(round));
        if (this.meta("round_head") === null && sigs[0]) {
          this.setMeta("round_head", sigs[0].signature);
          if (sigs[0].slot != null) this.setMeta("round_head_slot", String(sigs[0].slot));
        }
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
        if (lost === null && end === -1 && sigs.length === PAGE && last) {
          this.setMeta("round_before", last.signature);
        } else {
          // reached the cursor (or the deploy, or its floor, or what the RPC holds): the round is
          // complete. A lost cursor with nothing newer stays lost: the next round lists back to
          // its floor again rather than asking for it.
          const head = this.meta("round_head");
          if (head !== null) {
            this.setMeta("cursor", head);
            // a head listed without its slot: no slot is known for the new cursor
            const headSlot = this.meta("round_head_slot");
            if (headSlot !== null) this.setMeta("cursor_slot", headSlot);
            else this.delMeta("cursor_slot");
            this.delMeta("round_cursor_lost");
          }
          this.setMeta("completed_round", String(round));
          for (const k of [
            "round_head",
            "round_head_slot",
            "round_before",
            "round_listed",
          ] as const)
            this.delMeta(k);
        }
      });
      if (this.meta("round_before") === null) return false;
    }
    return true;
  }

  /**
   * Reads and counts queued transactions, oldest first, skipping the ones set aside until their
   * retry is due. Returns how many are left, and how many of those can be read right away.
   */
  private async process(): Promise<{ left: number; ready: number }> {
    const completed = this.meta("completed_round");
    if (completed === null) return { left: 0, ready: 0 };
    const now = Date.now();
    const rows = this.sql
      .exec<{ signature: string; block_time: number | null }>(
        `SELECT b.signature, b.block_time FROM backlog b LEFT JOIN failures f USING (signature)
         WHERE b.round <= ? AND (f.retry_at IS NULL OR f.retry_at <= ?)
         ORDER BY b.round, b.idx DESC LIMIT ?`,
        Number(completed),
        now,
        MAX_TX_PER_TICK,
      )
      .toArray();
    for (const row of rows) {
      let tx: JsonTx | null;
      try {
        tx = await getJsonTransaction<JsonTx>(this.rpc, row.signature as Signature, "finalized");
      } catch (e) {
        if (this.failed(row.signature, describeError(e), now)) continue;
        break;
      }
      if (!tx) {
        // Listed at `finalized`, so normally served within a tick or two.
        if (this.failed(row.signature, "not served", now)) continue;
        break;
      }
      this.count(row.signature, tx, row.block_time);
    }
    const left = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM backlog WHERE round <= ?", Number(completed))
      .one().n;
    const aside = this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM backlog b JOIN failures f USING (signature)
         WHERE b.round <= ? AND f.retry_at > ?`,
        Number(completed),
        Date.now(),
      )
      .one().n;
    return { left, ready: left - aside };
  }

  /**
   * Records a failed read of a queued transaction. True once it is set aside (the tick goes on
   * with the next one, and it is read again on its backoff); false while it is still retried in
   * order (the tick stops there).
   */
  private failed(signature: string, reason: string, now: number): boolean {
    const tries =
      (this.sql
        .exec<{ tries: number }>("SELECT tries FROM failures WHERE signature = ?", signature)
        .toArray()[0]?.tries ?? 0) + 1;
    const aside = tries >= MAX_IN_ORDER_TRIES;
    const retryAt = aside ? now + asideBackoffMs(tries) : now;
    this.sql.exec(
      "INSERT OR REPLACE INTO failures (signature, tries, retry_at) VALUES (?, ?, ?)",
      signature,
      tries,
      retryAt,
    );
    console.warn(
      `stats: transaction ${signature} unreadable (${tries} tries): ${reason}; ` +
        (aside
          ? `set aside, read again in ${Math.round((retryAt - now) / 1_000)} s`
          : "retried next tick") +
        (tries === WALLET_THROUGH_GIVE_UP_TRIES
          ? "; the wallets' history no longer waits for it (`through` goes past it)"
          : ""),
    );
    return aside;
  }

  /** Adds one transaction to the totals, once. */
  private count(signature: string, tx: JsonTx, listedTime: number | null): void {
    const at = tx.blockTime == null ? listedTime : Number(tx.blockTime);
    this.ctx.storage.transactionSync(() => {
      const seen = this.sql
        .exec("SELECT 1 FROM done WHERE signature = ?", signature)
        .toArray().length;
      if (!seen) {
        this.apply(signature, ticketEventsOf(tx, PROGRAM), at);
        this.recordApr(aprEventsOf(tx, PROGRAM), at);
        const views = vaultEventsOf(tx, PROGRAM);
        this.recordViews(signature, views, at);
        this.recordFirstDeposits(signature, tx, at);
        const found = this.recordWallet(signature, tx, at);
        // a request, a close, a claim or a delivery: the providers' answer is due again
        if (
          views.some((e) => e.kind === "struck") ||
          found?.events.some((e) => LP_KINDS.has(e.kind))
        )
          this.setMeta("lp_changed_at", String(Date.now()));
        if (found) {
          this.liveTxs.push({
            signature,
            at,
            keys: found.keys,
            tickets: [...laterTicketsOf(found.events)],
          });
          if (this.liveTxs.length > LIVE_TXS_KEPT) this.liveTxs.shift();
        }
        this.sql.exec("INSERT INTO done (signature) VALUES (?)", signature);
        this.setMeta("transactions", String(Number(this.meta("transactions") ?? 0) + 1));
        if (at !== null && at > Number(this.meta("through") ?? 0))
          this.setMeta("through", String(at));
      }
      this.sql.exec("DELETE FROM backlog WHERE signature = ?", signature);
      this.sql.exec("DELETE FROM failures WHERE signature = ?", signature);
    });
    this.prune(at);
  }

  /**
   * Adds one transaction's ticket events to the totals, and remembers or forgets its tickets.
   * Inside the storage transaction that records the transaction as counted.
   */
  private apply(signature: string, events: readonly TicketEvent[], at: number | null): void {
    if (!events.length) return;
    // Tickets this transaction closes without their opening read: counted out of order.
    const unopened = new Set<Address>();
    const applied = applyTx(this.totals(), events, {
      signature,
      at,
      openOf: (ticket) => {
        const open = this.openOf(ticket);
        if (!open) unopened.add(ticket);
        return open;
      },
    });
    let totals = applied.totals;
    for (const [ticket, o] of applied.opened) {
      if (this.closedUnopened(ticket)) {
        // Already closed: its win, if any, gets its kind; nothing stays open.
        totals = withWinKind(totals, ticket, o);
        this.sql.exec("DELETE FROM closed_unopened WHERE ticket = ?", ticket);
        continue;
      }
      this.sql.exec(
        `INSERT OR REPLACE INTO open_tickets (ticket, price, payout_max, opened_at, integrator, beacon)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ticket,
        o.price.toString(),
        o.payoutMax.toString(),
        at,
        o.integrator,
        o.beacon ? 1 : 0,
      );
    }
    for (const ticket of applied.closed) {
      this.sql.exec("DELETE FROM open_tickets WHERE ticket = ?", ticket);
      if (unopened.has(ticket))
        this.sql.exec(
          "INSERT OR REPLACE INTO closed_unopened (ticket, closed_at) VALUES (?, ?)",
          ticket,
          at ?? Math.floor(Date.now() / 1_000),
        );
    }
    this.saveTotals(totals);
  }

  /** Keeps the done list and the openings bounded. */
  private prune(at: number | null): void {
    this.sql.exec("DELETE FROM done WHERE rowid <= (SELECT MAX(rowid) FROM done) - ?", DONE_KEPT);
    if (at !== null) {
      this.sql.exec("DELETE FROM open_tickets WHERE opened_at < ?", at - OPEN_KEPT_S);
      this.sql.exec("DELETE FROM closed_unopened WHERE closed_at < ?", at - OPEN_KEPT_S);
    }
  }

  // --- the replay (step 3) -------------------------------------------------------------------

  /**
   * Starts the replay, once, for an index whose counted transactions were read with an earlier
   * `EVENTS_VERSION`: from the cursor (the newest signature of the last complete round, every
   * one up to it listed), back to REPLAY_FROM. A new index records the version and replays
   * nothing.
   */
  private startReplay(): void {
    const version = Number(this.meta("events_version") ?? 1);
    if (version >= EVENTS_VERSION) return;
    // Nothing listed before this version: nothing was counted without the beacon.
    const fresh = this.meta("cursor") === null && this.meta("round_head") === null;
    this.ctx.storage.transactionSync(() => {
      const cursor = this.meta("cursor");
      if (!fresh && cursor !== null) {
        this.sql.exec(
          "INSERT OR IGNORE INTO replay_skip (signature) SELECT signature FROM backlog",
        );
        this.sql.exec(
          "INSERT OR IGNORE INTO replay (signature, idx, block_time) VALUES (?, 0, NULL)",
          cursor,
        );
        this.setMeta("replay_before", cursor);
        this.setMeta("replay_listed", "1");
        this.setMeta("replay_listing", "1");
      }
      this.setMeta("events_version", String(EVENTS_VERSION));
    });
  }

  private replaying(): boolean {
    return (
      this.meta("replay_listing") !== null ||
      this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM replay").one().n > 0
    );
  }

  /**
   * One bounded step of the replay: lists its signatures back to REPLAY_FROM, then reads and
   * counts the beacon's events of up to MAX_TX_PER_TICK of them, oldest first. True while there
   * is more to read right away.
   */
  private async replay(): Promise<boolean> {
    if (this.meta("replay_listing") !== null) return this.listReplay();
    const now = Date.now();
    const rows = this.sql
      .exec<{ signature: string; block_time: number | null; tries: number }>(
        `SELECT signature, block_time, tries FROM replay WHERE retry_at <= ?
         ORDER BY idx DESC LIMIT ?`,
        now,
        MAX_TX_PER_TICK,
      )
      .toArray();
    for (const row of rows) {
      if (
        this.sql.exec("SELECT 1 FROM replay_skip WHERE signature = ?", row.signature).toArray()
          .length
      ) {
        // Queued when the replay started: step 2 counts it in full.
        this.unqueueReplay(row.signature);
        continue;
      }
      if (this.replayOver()) break;
      let tx: JsonTx | null;
      try {
        tx = await getJsonTransaction<JsonTx>(this.rpc, row.signature as Signature, "finalized");
      } catch (e) {
        this.replayFailed(row.signature, row.tries, describeError(e), now);
        continue;
      }
      if (!tx) {
        this.replayFailed(row.signature, row.tries, "not served", now);
        continue;
      }
      const at = tx.blockTime == null ? row.block_time : Number(tx.blockTime);
      const beacon = ticketEventsOf(tx, PROGRAM).filter(
        (e) => e.kind === "returned" || (e.kind !== "expired" && e.beacon),
      );
      this.ctx.storage.transactionSync(() => {
        const queued = this.sql
          .exec("SELECT 1 FROM replay WHERE signature = ?", row.signature)
          .toArray().length;
        if (queued) this.apply(row.signature, beacon, at);
        this.unqueueReplay(row.signature);
      });
      this.prune(at);
    }
    const left = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM replay").one().n;
    if (left === 0) {
      this.sql.exec("DELETE FROM replay_skip");
      return false;
    }
    const ready = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM replay WHERE retry_at <= ?", Date.now())
      .one().n;
    return ready > 0;
  }

  /** Pages the replay's signatures back to REPLAY_FROM; true while there are more to list. */
  private async listReplay(): Promise<boolean> {
    for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
      if (this.replayOver()) return true;
      const before = this.meta("replay_before") as Signature;
      const { sigs, lost } = await this.signaturesPage(PROGRAM, null, before, "refusal_replay");
      if (lost) console.warn(historyGone("replay", before));
      const listed = Number(this.meta("replay_listed") ?? 0);
      // Newest first: the replay ends at the first signature older than REPLAY_FROM.
      const end = sigs.findIndex((s) => s.blockTime !== null && Number(s.blockTime) < REPLAY_FROM);
      const kept = end === -1 ? sigs : sigs.slice(0, end);
      this.ctx.storage.transactionSync(() => {
        kept.forEach((s, i) => {
          if (s.err !== null) return;
          this.sql.exec(
            "INSERT OR IGNORE INTO replay (signature, idx, block_time) VALUES (?, ?, ?)",
            s.signature,
            listed + i,
            s.blockTime === null ? null : Number(s.blockTime),
          );
        });
        this.setMeta("replay_listed", String(listed + kept.length));
        const last = sigs[sigs.length - 1];
        if (!lost && end === -1 && sigs.length === PAGE && last) {
          this.setMeta("replay_before", last.signature);
        } else {
          for (const k of ["replay_before", "replay_listed", "replay_listing"] as const)
            this.delMeta(k);
        }
      });
      if (this.meta("replay_listing") === null) return true;
    }
    return true;
  }

  private unqueueReplay(signature: string): void {
    this.sql.exec("DELETE FROM replay WHERE signature = ?", signature);
    this.sql.exec("DELETE FROM replay_skip WHERE signature = ?", signature);
  }

  /** A replayed transaction the RPC failed to return: read again on its backoff, the others go on. */
  private replayFailed(signature: string, tries: number, reason: string, now: number): void {
    const retryAt = now + replayBackoffMs(tries + 1);
    this.sql.exec(
      "UPDATE replay SET tries = ?, retry_at = ? WHERE signature = ?",
      tries + 1,
      retryAt,
      signature,
    );
    console.warn(
      `stats replay: transaction ${signature} unreadable (${tries + 1} tries): ${reason}; ` +
        `read again in ${Math.round((retryAt - now) / 1_000)} s`,
    );
  }

  // --- the APR (step 4 and the answer) --------------------------------------------------------

  /** Records one transaction's APR events, inside the storage transaction that reads it. */
  private recordApr(events: readonly AprEvent[], at: number | null): void {
    for (const e of events) {
      if (e.kind === "direct")
        this.sql.exec(
          `INSERT OR REPLACE INTO apr_tickets (ticket, opened_at, price, margin_bps, app_share_bps)
           VALUES (?, ?, ?, ?, ?)`,
          e.ticket,
          at,
          e.price.toString(),
          e.marginBps.toString(),
          e.appShareBps.toString(),
        );
      else if (e.kind === "beacon")
        this.sql.exec(
          `INSERT OR REPLACE INTO apr_tickets (ticket, opened_at, price, payout_table, app_share, protocol_share)
           VALUES (?, ?, ?, ?, ?, ?)`,
          e.ticket,
          at,
          e.price.toString(),
          e.payoutTable,
          e.appShare.toString(),
          e.protocolShare.toString(),
        );
      else if (e.kind === "refunded")
        this.sql.exec(
          "INSERT OR REPLACE INTO apr_refunds (ticket, at) VALUES (?, ?)",
          e.ticket,
          at,
        );
      else if (at !== null)
        this.sql.exec(
          "INSERT OR REPLACE INTO apr_strikes (epoch_id, t, assets) VALUES (?, ?, ?)",
          e.epochId.toString(),
          at,
          e.assets.toString(),
        );
    }
  }

  /**
   * Starts the replay of what is recorded (step 4), once, for an index that recorded its
   * transactions with an earlier RECORDED_EVENTS_VERSION: from the cursor back to APR_KEPT_S
   * before now. It replays for the APR when the index recorded none (no version), and for the
   * vault views when it recorded the APR alone (version 1): what was complete stays so. A new
   * index records everything from its first read: the whole history is covered.
   */
  private startAprReplay(): void {
    const version = Number(this.meta("apr_version") ?? 0);
    if (version >= RECORDED_EVENTS_VERSION) return;
    this.ctx.storage.transactionSync(() => {
      const cursor = this.meta("cursor");
      if (cursor !== null) {
        this.sql.exec(
          "INSERT OR IGNORE INTO apr_replay (signature, idx, block_time) VALUES (?, 0, NULL)",
          cursor,
        );
        this.setMeta("apr_replay_before", cursor);
        this.setMeta("apr_replay_listed", "1");
        this.setMeta("apr_replay_listing", "1");
        this.setMeta("apr_replay_from", String(Math.floor(Date.now() / 1_000) - APR_KEPT_S));
        if (version < APR_EVENTS_VERSION) this.delMeta("apr_covered");
        this.delMeta("views_covered");
      } else {
        // nothing counted yet: step 2 records every transaction from the deploy
        this.setMeta("apr_covered", "0");
        this.setMeta("views_covered", "0");
      }
      this.setMeta("apr_version", String(RECORDED_EVENTS_VERSION));
    });
  }

  /**
   * Unix seconds from which every ticket is recorded for the APR: the whole history (0) or the
   * replay's floor once it is done; while it runs, the newest transaction it has still to read
   * (every newer one is recorded), and nothing while it lists.
   */
  private aprCovered(): number {
    return this.covered("apr_covered");
  }

  /** The same for the vault views. */
  private viewsCovered(): number {
    return this.covered("views_covered");
  }

  private covered(k: "apr_covered" | "views_covered"): number {
    const covered = this.meta(k);
    if (covered !== null) return Number(covered);
    if (this.meta("apr_replay_listing") !== null) return Infinity;
    const newest = this.sql
      .exec<{ t: number | null }>("SELECT MAX(block_time) AS t FROM apr_replay")
      .one().t;
    return newest ?? Infinity;
  }

  /**
   * One bounded step of the replay of what is recorded: lists its signatures back to its floor,
   * then reads and records the APR and vault views' events of up to MAX_APR_REPLAY_PER_TICK of
   * them, newest first. True while there is more to read right away.
   */
  private async aprReplay(): Promise<boolean> {
    if (this.meta("apr_replay_listing") !== null) return this.listAprReplay();
    const done = this.meta("apr_covered") !== null && this.meta("views_covered") !== null;
    const now = Date.now();
    const rows = this.sql
      .exec<{ signature: string; block_time: number | null; tries: number }>(
        `SELECT signature, block_time, tries FROM apr_replay WHERE retry_at <= ?
         ORDER BY idx LIMIT ?`,
        now,
        MAX_APR_REPLAY_PER_TICK,
      )
      .toArray();
    // done, but for the transactions given up on: each read again on its hourly backoff
    if (done && !rows.length) return false;
    for (const row of rows) {
      if (this.replayOver()) break;
      let tx: JsonTx | null;
      try {
        tx = await getJsonTransaction<JsonTx>(this.rpc, row.signature as Signature, "finalized");
      } catch (e) {
        this.aprReplayFailed(row.signature, row.tries, describeError(e), now);
        continue;
      }
      if (!tx) {
        this.aprReplayFailed(row.signature, row.tries, "not served", now);
        continue;
      }
      const at = tx.blockTime == null ? row.block_time : Number(tx.blockTime);
      const events = aprEventsOf(tx, PROGRAM);
      const views = vaultEventsOf(tx, PROGRAM);
      this.ctx.storage.transactionSync(() => {
        this.recordApr(events, at);
        this.recordViews(row.signature, views, at);
        this.sql.exec("DELETE FROM apr_replay WHERE signature = ?", row.signature);
      });
    }
    // every transaction read, or given up on (LP_GIVE_UP_TRIES failed reads, as the wallets'
    // replay and the Queue's history give up): the answers count from the replay's floor
    const left = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM apr_replay WHERE tries < ?", LP_GIVE_UP_TRIES)
      .one().n;
    if (left === 0 && !done) {
      this.ctx.storage.transactionSync(() => {
        const floor = this.meta("apr_replay_floor") ?? "0";
        if (this.meta("apr_covered") === null) this.setMeta("apr_covered", floor);
        if (this.meta("views_covered") === null) this.setMeta("views_covered", floor);
        this.delMeta("apr_replay_floor");
        this.delMeta("apr_replay_from");
      });
      // the answers now cover their whole windows: build them again on the next request
      this.delMeta("apr_view_at");
      this.kept.clear();
      return false;
    }
    const ready = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM apr_replay WHERE retry_at <= ?", Date.now())
      .one().n;
    return ready > 0;
  }

  /** Pages the APR replay's signatures back to its floor; true while there are more to list. */
  private async listAprReplay(): Promise<boolean> {
    const from = Number(this.meta("apr_replay_from") ?? 0);
    for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
      if (this.replayOver()) return true;
      const before = this.meta("apr_replay_before") as Signature;
      const { sigs, lost } = await this.signaturesPage(PROGRAM, null, before, "refusal_apr_replay");
      if (lost) console.warn(historyGone("APR replay", before));
      const listed = Number(this.meta("apr_replay_listed") ?? 0);
      // Newest first: the replay ends at the first signature older than its floor.
      const end = sigs.findIndex((s) => s.blockTime !== null && Number(s.blockTime) < from);
      const kept = end === -1 ? sigs : sigs.slice(0, end);
      this.ctx.storage.transactionSync(() => {
        kept.forEach((s, i) => {
          if (s.err !== null) return;
          this.sql.exec(
            "INSERT OR IGNORE INTO apr_replay (signature, idx, block_time) VALUES (?, ?, ?)",
            s.signature,
            listed + i,
            s.blockTime === null ? null : Number(s.blockTime),
          );
        });
        this.setMeta("apr_replay_listed", String(listed + kept.length));
        const last = sigs[sigs.length - 1];
        if (!lost && end === -1 && sigs.length === PAGE && last) {
          this.setMeta("apr_replay_before", last.signature);
        } else {
          // the floor reached, or the deploy: everything since is recorded once the list is read;
          // the history the RPC dropped: everything since the oldest transaction listed
          const oldest = lost
            ? this.sql
                .exec<{ t: number | null }>("SELECT MIN(block_time) AS t FROM apr_replay")
                .one().t
            : null;
          this.setMeta(
            "apr_replay_floor",
            lost
              ? String(Math.max(from, oldest ?? Math.floor(Date.now() / 1_000)))
              : end === -1
                ? "0"
                : String(from),
          );
          for (const k of ["apr_replay_before", "apr_replay_listed", "apr_replay_listing"] as const)
            this.delMeta(k);
        }
      });
      if (this.meta("apr_replay_listing") === null) return true;
    }
    return true;
  }

  /** A transaction of the APR replay the RPC failed to return: read again on its backoff. */
  private aprReplayFailed(signature: string, tries: number, reason: string, now: number): void {
    const retryAt = now + replayBackoffMs(tries + 1);
    this.sql.exec(
      "UPDATE apr_replay SET tries = ?, retry_at = ? WHERE signature = ?",
      tries + 1,
      retryAt,
      signature,
    );
    console.warn(
      `stats apr replay: transaction ${signature} unreadable (${tries + 1} tries): ${reason}; ` +
        `read again in ${Math.round((retryAt - now) / 1_000)} s` +
        (tries + 1 === LP_GIVE_UP_TRIES
          ? "; the APR and the vault views no longer wait for it (recorded once served)"
          : ""),
    );
  }

  /**
   * Whether the loop builds the APR's answer again: APR_REFRESH_MS old, and a transaction was
   * counted since it was built (the vault's tickets and assets changed), or APR_IDLE_REFRESH_MS
   * old.
   */
  private aprDue(): boolean {
    const age = Date.now() - Number(this.meta("apr_view_at") ?? 0);
    if (age < APR_REFRESH_MS) return false;
    return age >= APR_IDLE_REFRESH_MS || this.meta("apr_view_tx") !== this.meta("transactions");
  }

  /** Builds the APR's answer again when it is due and someone asked for it lately. */
  private async refreshApr(): Promise<void> {
    const stored = this.meta("apr_asked_at");
    const kept = stored === null ? NaN : Number(stored);
    const asked = Math.max(this.aprAskedAt, Number.isFinite(kept) ? kept : -Infinity);
    if (Date.now() - asked > APR_ASKED_KEPT_MS) return;
    if (!this.aprDue()) return;
    try {
      await this.buildApr();
    } catch (e) {
      console.warn(`stats apr: answer not built: ${describeError(e)}`);
    }
  }

  /** Builds the APR's answer and keeps it; callers at the same time share one build. */
  private buildApr(): Promise<AprView> {
    this.aprBuild ??= this.buildAprNow().finally(() => {
      this.aprBuild = null;
    });
    return this.aprBuild;
  }

  private async buildAprNow(): Promise<AprView> {
    // an index counted before the APR is syncing from its first request on
    this.startAprReplay();
    const counted = this.meta("transactions") ?? "0";
    const now = Math.floor(Date.now() / 1_000);
    const [[config], [vault]] = await Promise.all([findConfigPda(cfg), findVaultPda(cfg)]);
    const { value } = await this.rpc
      .getMultipleAccounts([config, vault], { encoding: "base64", commitment: "confirmed" })
      .send();
    if (!value[0] || !value[1]) throw new Error("the program is not initialised");
    const protocolShareBps = getConfigDecoder().decode(decodeBase64(value[0].data[0])).params
      .protocolShareBps;
    const totalAssets = getVaultDecoder().decode(decodeBase64(value[1].data[0])).totalAssets;
    await this.readPayoutTables();
    this.pruneApr(now);
    const lhs = new Map(
      this.sql
        .exec<{ address: string; lhs: string }>("SELECT address, lhs FROM payout_tables")
        .toArray()
        .map((r) => [r.address as Address, BigInt(r.lhs)] as const),
    );
    const tickets = this.sql
      .exec<{
        opened_at: number | null;
        price: string;
        margin_bps: string | null;
        app_share_bps: string | null;
        payout_table: string | null;
        app_share: string | null;
        protocol_share: string | null;
        refunded: number;
      }>(
        `SELECT t.opened_at, t.price, t.margin_bps, t.app_share_bps, t.payout_table, t.app_share,
                t.protocol_share, (r.ticket IS NOT NULL) AS refunded
         FROM apr_tickets t LEFT JOIN apr_refunds r USING (ticket)`,
      )
      .toArray()
      .map((r) =>
        aprTicketOf(
          {
            openedAt: r.opened_at,
            price: BigInt(r.price),
            direct:
              r.payout_table === null
                ? {
                    marginBps: BigInt(r.margin_bps ?? 0),
                    appShareBps: BigInt(r.app_share_bps ?? 0),
                  }
                : null,
            beacon:
              r.payout_table !== null
                ? {
                    payoutTable: r.payout_table as Address,
                    appShare: BigInt(r.app_share ?? 0),
                    protocolShare: BigInt(r.protocol_share ?? 0),
                  }
                : null,
            refunded: r.refunded === 1,
          },
          lhs,
        ),
      );
    const strikes = this.sql
      .exec<{ t: number; assets: string }>("SELECT t, assets FROM apr_strikes ORDER BY t")
      .toArray()
      .map((r) => ({ t: r.t, assets: BigInt(r.assets) }));
    const view = aprView({
      tickets,
      strikes,
      totalAssets,
      protocolShareBps,
      now,
      coveredFrom: this.aprCovered(),
      syncing: this.meta("caught_up") !== "1" || this.meta("apr_covered") === null,
    });
    this.ctx.storage.transactionSync(() => {
      this.setMeta("apr_view", JSON.stringify(view));
      this.setMeta("apr_view_at", String(Date.now()));
      this.setMeta("apr_view_tx", counted);
    });
    return view;
  }

  /** Reads the `Σ p·m` of the payout tables beacon tickets joined with that are not read yet. */
  private async readPayoutTables(): Promise<void> {
    const missing = this.sql
      .exec<{ payout_table: string }>(
        `SELECT payout_table FROM (
           SELECT payout_table FROM apr_tickets UNION SELECT payout_table FROM vault_tickets
         )
         WHERE payout_table IS NOT NULL
           AND payout_table NOT IN (SELECT address FROM payout_tables)
         LIMIT ?`,
        ACCOUNTS_PER_CALL,
      )
      .toArray()
      .map((r) => r.payout_table as Address);
    await this.readTables(missing);
  }

  /** Reads the `Σ p·m` of these payout tables, those not read yet (a table never changes). */
  private async readTables(tables: readonly Address[]): Promise<void> {
    const read = new Set(
      this.sql
        .exec<{ address: string }>("SELECT address FROM payout_tables")
        .toArray()
        .map((r) => r.address),
    );
    const missing = [...new Set(tables)].filter((t) => !read.has(t)).slice(0, ACCOUNTS_PER_CALL);
    if (!missing.length) return;
    const { value } = await this.rpc
      .getMultipleAccounts(missing, { encoding: "base64", commitment: "finalized" })
      .send();
    value.forEach((a, i) => {
      if (!a || a.owner !== PROGRAM) return;
      try {
        const lhs = getPayoutTableDecoder().decode(decodeBase64(a.data[0])).lhs;
        this.sql.exec(
          "INSERT OR REPLACE INTO payout_tables (address, lhs) VALUES (?, ?)",
          missing[i]!,
          lhs.toString(),
        );
      } catch {
        // not a payout table: its tickets keep a zero margin, as in the app
      }
    });
  }

  /** `Σ p·m` of every payout table read, by address. */
  private payoutLhs(): Map<Address, bigint> {
    return new Map(
      this.sql
        .exec<{ address: string; lhs: string }>("SELECT address, lhs FROM payout_tables")
        .toArray()
        .map((r) => [r.address as Address, BigInt(r.lhs)] as const),
    );
  }

  /**
   * Forgets the tickets and refunds older than APR_KEPT_S, and the closes too but the last one
   * before: the assets the oldest point reads.
   */
  private pruneApr(now: number): void {
    const cutoff = now - APR_KEPT_S;
    this.sql.exec("DELETE FROM apr_tickets WHERE opened_at < ?", cutoff);
    this.sql.exec("DELETE FROM apr_refunds WHERE at < ?", cutoff);
    this.sql.exec(
      "DELETE FROM apr_strikes WHERE t < (SELECT MAX(t) FROM apr_strikes WHERE t < ?)",
      cutoff,
    );
  }

  // --- the vault views (GET /v1/vault, GET /v1/feed) ---------------------------------------

  /**
   * Records one transaction's vault views' events, inside the storage transaction that reads it.
   * Each part of a ticket goes in its own columns, so an end read before its opening (the replay
   * reads newest first) keeps both, and a transaction recorded twice changes nothing.
   */
  private recordViews(signature: string, events: readonly VaultEvent[], at: number | null): void {
    if (events.length) this.viewsChangedAt = Date.now();
    let request = 0;
    const upsert = (ticket: string, cols: Record<string, string | number | null>, set: string) => {
      const names = Object.keys(cols);
      this.sql.exec(
        `INSERT INTO vault_tickets (ticket, last_at, ${names.join(", ")})
         VALUES (?, ?, ${names.map(() => "?").join(", ")})
         ON CONFLICT (ticket) DO UPDATE SET ${set},
           last_at = MAX(COALESCE(last_at, 0), COALESCE(excluded.last_at, 0))`,
        ticket,
        at,
        ...Object.values(cols),
      );
    };
    const opening = (cols: Record<string, string | number | null>) =>
      [
        "integrator = excluded.integrator",
        "beacon = excluded.beacon",
        ...Object.keys(cols)
          .filter((c) => c !== "integrator" && c !== "beacon")
          .map((c) => `${c} = excluded.${c}`),
      ].join(", ");
    const ending = (cols: Record<string, string | number | null>) =>
      [
        "integrator = COALESCE(integrator, excluded.integrator)",
        "beacon = MAX(beacon, excluded.beacon)",
        ...Object.keys(cols)
          .filter((c) => c !== "integrator" && c !== "beacon")
          .map((c) => `${c} = excluded.${c}`),
      ].join(", ");
    for (const e of events) {
      if (e.kind === "opened" || e.kind === "joined") {
        const cols = {
          integrator: e.integrator,
          beacon: e.kind === "joined" ? 1 : 0,
          opened_at: at,
          open_sig: signature,
          price: e.price.toString(),
          payout_max: e.payoutMax.toString(),
          vault_credit: e.vaultCredit.toString(),
          margin_bps: e.kind === "opened" ? e.marginBps.toString() : "0",
          app_share_bps: (e.kind === "opened"
            ? e.appShareBps
            : appShareBpsOf(e.appShare, e.price)
          ).toString(),
          payout_table: e.kind === "joined" ? e.payoutTable : null,
          app_share:
            e.kind === "joined"
              ? e.appShare.toString()
              : ((e.price * e.appShareBps) / BPS).toString(),
        };
        upsert(e.ticket, cols, opening(cols));
      } else if (e.kind === "settled" || e.kind === "expired" || e.kind === "returned") {
        const cols = {
          integrator: e.kind === "returned" ? null : e.integrator,
          beacon: e.kind === "returned" || (e.kind === "settled" && e.beacon) ? 1 : 0,
          end_kind: e.kind === "settled" ? "settled" : "expired",
          payout:
            e.kind === "settled"
              ? e.payout.toString()
              : e.kind === "expired"
                ? e.refund.toString()
                : "0",
          // a parked return, or a parked direct refund, waits in escrow
          pending: e.kind === "settled" ? Number(e.pending) : Number(e.parked),
          refunded: refundedCode(e),
          end_at: at,
          end_sig: signature,
        };
        upsert(e.ticket, cols, ending(cols));
      } else if (e.kind === "claimed") {
        upsert(e.ticket, { claimed: 1 }, "claimed = 1");
      } else if (e.kind === "struck") {
        if (at !== null)
          this.sql.exec(
            `INSERT OR REPLACE INTO vault_strikes (epoch_id, t, total_assets, total_shares, deposits,
               shares_minted, assets_paid, shares_burnt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            e.epochId.toString(),
            at,
            e.totalAssets.toString(),
            e.totalShares.toString(),
            e.deposits.toString(),
            e.sharesMinted.toString(),
            e.assetsPaid.toString(),
            e.sharesBurnt.toString(),
          );
      } else {
        this.sql.exec(
          "INSERT OR REPLACE INTO vault_requests (signature, idx, kind, amount, at) VALUES (?, ?, ?, ?, ?)",
          signature,
          request++,
          e.kind,
          (e.kind === "deposit" ? e.amount : e.shares).toString(),
          at,
        );
      }
    }
  }

  /**
   * A view's answer kept in memory, built again in the background once it is `refreshMs` old;
   * a request waits for a build only when there is none, or it is older than `staleMs`.
   */
  private async served<T>(
    kind: ViewKind,
    build: () => Promise<T>,
    refreshMs: number,
    staleMs: number,
  ): Promise<T> {
    const kept = this.kept.get(kind);
    const age = kept ? Date.now() - kept.at : Infinity;
    if (kept && age < staleMs) {
      if (age >= refreshMs) void this.rebuild(kind, build).catch(() => {});
      return kept.view as T;
    }
    try {
      return await this.rebuild(kind, build);
    } catch (e) {
      if (kept) return kept.view as T;
      throw e;
    }
  }

  /** Builds a view's answer and keeps it; callers at the same time share one build. */
  private rebuild<T>(kind: ViewKind, build: () => Promise<T>): Promise<T> {
    let p = this.building.get(kind) as Promise<T> | undefined;
    if (!p) {
      p = build()
        .then((view) => {
          this.kept.set(kind, { view, at: Date.now() });
          return view;
        })
        .finally(() => this.building.delete(kind));
      this.building.set(kind, p);
    }
    return p;
  }

  private async buildVault(): Promise<VaultView> {
    // an index recorded before the vault views is syncing from its first request on
    this.startAprReplay();
    const now = Math.floor(Date.now() / 1_000);
    this.pruneViews(now);
    const tickets = this.storedTickets(
      `WHERE opened_at >= ? OR end_at >= ?`,
      now - SERIES_DAYS * 86_400,
      now - 86_400,
    );
    const authorities = await this.readAuthorities(tickets);
    const strikes = this.sql
      .exec<{
        epoch_id: string;
        t: number;
        total_assets: string;
        total_shares: string;
        deposits: string;
        shares_minted: string;
        assets_paid: string;
        shares_burnt: string;
      }>("SELECT * FROM vault_strikes ORDER BY t")
      .toArray()
      .map((r) => ({
        t: r.t,
        epochId: BigInt(r.epoch_id),
        totalAssets: BigInt(r.total_assets),
        totalShares: BigInt(r.total_shares),
        deposits: BigInt(r.deposits),
        sharesMinted: BigInt(r.shares_minted),
        assetsPaid: BigInt(r.assets_paid),
        sharesBurnt: BigInt(r.shares_burnt),
      }));
    const withdrawalsAt = this.sql
      .exec<{ at: number }>(
        "SELECT DISTINCT at FROM vault_requests WHERE kind = 'withdrawal' AND at IS NOT NULL",
      )
      .toArray()
      .map((r) => r.at);
    return vaultView({
      tickets,
      strikes,
      authorities,
      now,
      coveredFrom: this.viewsCovered(),
      caughtUp: this.meta("caught_up") === "1",
      currentAt: this.currentAt(),
      withdrawalsAt,
    });
  }

  private async buildFeed(): Promise<FeedView> {
    this.startAprReplay();
    const now = Math.floor(Date.now() / 1_000);
    try {
      await this.readPayoutTables();
    } catch (e) {
      // their tickets' odds wait for the next build
      console.warn(`stats feed: payout tables not read: ${describeError(e)}`);
    }
    // the tickets opened last, those whose opening is not kept by their end (the Activity
    // tab's order), and the newest events (the live draws' order)
    const openedAt = (t: StoredVaultTicket) => t.opened?.at ?? t.end?.at ?? 0;
    const tickets = [
      ...this.storedTickets(
        "WHERE opened_at IS NOT NULL ORDER BY opened_at DESC LIMIT ?",
        FEED_TICKETS,
      ),
      ...this.storedTickets(
        "WHERE opened_at IS NULL AND end_kind IS NOT NULL ORDER BY last_at DESC LIMIT ?",
        FEED_TICKETS,
      ),
    ]
      .sort((a, b) => openedAt(b) - openedAt(a))
      .slice(0, FEED_TICKETS);
    const recent = this.storedTickets(
      `WHERE opened_at IS NOT NULL OR end_kind IS NOT NULL ORDER BY last_at DESC LIMIT ?`,
      FEED_TICKETS,
    );
    const requests = this.sql
      .exec<{ signature: string; idx: number; kind: string; amount: string; at: number | null }>(
        "SELECT signature, idx, kind, amount, at FROM vault_requests ORDER BY at DESC, signature, idx LIMIT ?",
        FEED_REQUESTS,
      )
      .toArray()
      .map((r): StoredRequest =>
        r.kind === "deposit"
          ? {
              kind: "deposit",
              amount: BigInt(r.amount),
              at: r.at,
              signature: r.signature,
              index: r.idx,
            }
          : {
              kind: "withdrawal",
              shares: BigInt(r.amount),
              at: r.at,
              signature: r.signature,
              index: r.idx,
            },
      );
    const lhs = new Map(
      this.sql
        .exec<{ address: string; lhs: string }>("SELECT address, lhs FROM payout_tables")
        .toArray()
        .map((r) => [r.address as Address, BigInt(r.lhs)] as const),
    );
    return feedView({
      tickets,
      recent,
      requests,
      lhs,
      now,
      coveredFrom: this.viewsCovered(),
      caughtUp: this.meta("caught_up") === "1",
      currentAt: this.currentAt(),
    });
  }

  /** Unix seconds: when the loop last found every listed transaction read; null before. */
  private currentAt(): number | null {
    const v = this.meta("current_at");
    return v === null ? null : Number(v);
  }

  /** The stored tickets a clause selects, as vaultIndex.ts reads them. */
  private storedTickets(clause: string, ...bindings: (string | number)[]): StoredVaultTicket[] {
    return this.sql
      .exec<{
        ticket: string;
        integrator: string | null;
        beacon: number;
        opened_at: number | null;
        open_sig: string | null;
        price: string | null;
        payout_max: string | null;
        vault_credit: string | null;
        margin_bps: string | null;
        app_share_bps: string | null;
        payout_table: string | null;
        app_share: string | null;
        end_kind: string | null;
        payout: string | null;
        pending: number | null;
        refunded: number | null;
        end_at: number | null;
        end_sig: string | null;
        claimed: number;
      }>(`SELECT * FROM vault_tickets ${clause}`, ...bindings)
      .toArray()
      .map((r) => ({
        ticket: r.ticket as Address,
        integrator: r.integrator as Address | null,
        beacon: r.beacon === 1,
        opened:
          r.open_sig === null
            ? null
            : {
                at: r.opened_at,
                signature: r.open_sig,
                price: BigInt(r.price ?? 0),
                payoutMax: BigInt(r.payout_max ?? 0),
                vaultCredit: BigInt(r.vault_credit ?? 0),
                marginBps: BigInt(r.margin_bps ?? 0),
                appShareBps: BigInt(r.app_share_bps ?? 0),
                payoutTable: r.payout_table as Address | null,
                appShare: BigInt(r.app_share ?? 0),
              },
        end:
          r.end_kind === null || r.end_sig === null
            ? null
            : {
                kind: r.end_kind === "settled" ? "settled" : "expired",
                payout: BigInt(r.payout ?? 0),
                pending: r.pending === 1,
                refunded: r.refunded === REFUNDED_PRICE,
                creditReturned: r.refunded === REFUNDED_CREDIT,
                at: r.end_at,
                signature: r.end_sig,
              },
        claimed: r.claimed === 1,
      }));
  }

  /**
   * The app key of the integrator records these tickets name, those not read yet read now (a
   * record never changes its key). A read that fails leaves them unnamed until the next build.
   */
  private async readAuthorities(
    tickets: readonly StoredVaultTicket[],
  ): Promise<Map<Address, Address>> {
    const known = new Map(
      this.sql
        .exec<{ address: string; authority: string }>("SELECT address, authority FROM integrators")
        .toArray()
        .map((r) => [r.address as Address, r.authority as Address] as const),
    );
    const missing = [
      ...new Set(
        tickets.flatMap((t) =>
          t.integrator !== null && !known.has(t.integrator) ? [t.integrator] : [],
        ),
      ),
    ].slice(0, ACCOUNTS_PER_CALL);
    if (!missing.length) return known;
    try {
      const { value } = await this.rpc
        .getMultipleAccounts(missing, { encoding: "base64", commitment: "finalized" })
        .send();
      value.forEach((a, i) => {
        if (!a || a.owner !== PROGRAM) return;
        try {
          const authority = getIntegratorDecoder().decode(decodeBase64(a.data[0])).authority;
          this.sql.exec(
            "INSERT OR REPLACE INTO integrators (address, authority) VALUES (?, ?)",
            missing[i]!,
            authority,
          );
          known.set(missing[i]!, authority);
        } catch {
          // not an integrator record
        }
      });
    } catch (e) {
      console.warn(`stats vault: integrator records not read: ${describeError(e)}`);
    }
    return known;
  }

  /**
   * Forgets the tickets and requests older than VIEWS_KEPT_S, and the closes too but the last
   * one before: the value the oldest point of the series starts from.
   */
  private pruneViews(now: number): void {
    const cutoff = now - VIEWS_KEPT_S;
    this.sql.exec("DELETE FROM vault_tickets WHERE COALESCE(last_at, 0) < ?", cutoff);
    this.sql.exec("DELETE FROM vault_requests WHERE COALESCE(at, 0) < ?", cutoff);
    this.sql.exec(
      "DELETE FROM vault_strikes WHERE t < (SELECT MAX(t) FROM vault_strikes WHERE t < ?)",
      cutoff,
    );
  }

  // --- the liquidity providers -----------------------------------------------------------

  private providersAsked(): boolean {
    return Date.now() - this.providersAskedAt <= PROVIDERS_ASKED_KEPT_MS;
  }

  /**
   * Whether the loop builds the providers' answer again: PROVIDERS_REFRESH_MS old, and a
   * transaction with a liquidity provider's event was counted since (`lp_changed_at`), or
   * PROVIDERS_IDLE_REFRESH_MS old.
   */
  private providersDue(): boolean {
    const at = Number(this.meta("providers_view_at") ?? 0);
    const age = Date.now() - at;
    if (age < PROVIDERS_REFRESH_MS) return false;
    return age >= PROVIDERS_IDLE_REFRESH_MS || Number(this.meta("lp_changed_at") ?? 0) >= at;
  }

  /** Builds the providers' answer again when it is due and someone asked for it lately. */
  private async refreshProviders(): Promise<void> {
    if (!this.providersAsked()) return;
    if (!this.providersDue()) return;
    try {
      await this.buildProviders();
    } catch (e) {
      console.warn(`stats providers: answer not built: ${describeError(e)}`);
    }
  }

  /** Builds the providers' answer and keeps it; callers at the same time share one build. */
  private buildProviders(): Promise<ProvidersView> {
    this.providersBuild ??= this.buildProvidersNow().finally(() => {
      this.providersBuild = null;
    });
    return this.providersBuild;
  }

  /**
   * One read of every account the list is made of, as the app reads them (lib/fade
   * `fetchShareHolders`, `fetchDepositRequests`, `fetchWithdrawRequests`, `fetchEpochRecords`),
   * at `confirmed`, worked out with the app's arithmetic (lib/providers).
   */
  private async buildProvidersNow(): Promise<ProvidersView> {
    const now = Math.floor(Date.now() / 1_000);
    const [[shareMint], [vaultAuthority], [vault]] = await Promise.all([
      findShareMintPda(cfg),
      findVaultAuthorityPda(cfg),
      findVaultPda(cfg),
    ]);
    const b58 = getBase58Decoder();
    const ofProgram = (discriminator: ArrayLike<number>) =>
      this.rpc
        .getProgramAccounts(PROGRAM, {
          encoding: "base64",
          commitment: "confirmed",
          filters: [
            {
              memcmp: {
                offset: 0n,
                bytes: b58.decode(Uint8Array.from(discriminator)) as never,
                encoding: "base58",
              },
            },
          ],
        })
        .send();
    const [tokens, deposits, withdraws, records, vaultInfo] = await Promise.all([
      this.rpc
        .getProgramAccounts(TOKEN, {
          encoding: "base64",
          commitment: "confirmed",
          filters: [
            { dataSize: BigInt(TOKEN_ACCOUNT_SIZE) },
            { memcmp: { offset: 0n, bytes: shareMint as never, encoding: "base58" } },
          ],
        })
        .send(),
      ofProgram(DEPOSIT_REQUEST_DISCRIMINATOR),
      ofProgram(WITHDRAW_REQUEST_DISCRIMINATOR),
      ofProgram(EPOCH_RECORD_DISCRIMINATOR),
      this.rpc.getAccountInfo(vault, { encoding: "base64", commitment: "confirmed" }).send(),
    ]);
    if (!vaultInfo.value) throw new Error("the program is not initialised");
    const decoded = <T>(
      accounts: readonly { pubkey: Address; account: { data: readonly [string, unknown] } }[],
      decode: (bytes: Uint8Array) => T,
    ) =>
      accounts.map((a) => ({ address: a.pubkey, data: decode(decodeBase64(a.account.data[0])) }));
    const view = providersView({
      holders: shareHoldersOf(
        tokens.map((a) => decodeBase64(a.account.data[0])),
        vaultAuthority,
      ),
      deposits: decoded(deposits, (b) => getDepositRequestDecoder().decode(b)),
      withdraws: decoded(withdraws, (b) => getWithdrawRequestDecoder().decode(b)),
      records: decoded(records, (b) => getEpochRecordDecoder().decode(b)),
      vault: getVaultDecoder().decode(decodeBase64(vaultInfo.value.data[0])),
      firstDeposits: new Map(
        this.sql
          .exec<{ owner: string; at: number }>("SELECT owner, at FROM lp_first_deposits")
          .toArray()
          .map((r) => [r.owner as Address, r.at] as const),
      ),
      firstDepositsKnown: this.meta("lp_backfilled") === "1",
      now,
    });
    this.ctx.storage.transactionSync(() => {
      this.setMeta("providers_view", JSON.stringify(view));
      this.setMeta("providers_view_at", String(Date.now()));
    });
    return view;
  }

  /**
   * Keeps the earliest deposit request of each owner a transaction holds: a minimum, so the
   * order of reads does not matter and reading one twice changes nothing. Inside the storage
   * transaction that reads it.
   */
  private recordFirstDeposits(signature: string, tx: JsonTx, at: number | null): void {
    if (at === null) return;
    const owners = depositOwnersOf(tx, PROGRAM);
    // the providers' answer names the first deposits: due again
    if (owners.length) this.setMeta("lp_changed_at", String(Date.now()));
    for (const owner of owners)
      this.sql.exec(
        `INSERT INTO lp_first_deposits (owner, at, signature) VALUES (?, ?, ?)
         ON CONFLICT (owner) DO UPDATE SET at = excluded.at, signature = excluded.signature
         WHERE excluded.at < lp_first_deposits.at`,
        owner,
        at,
        signature,
      );
  }

  /**
   * One bounded step of the Queue's history: lists its new signatures, then reads up to
   * MAX_LP_TX_PER_TICK of those listed by complete rounds. True while there is more to read
   * right away. A failure is logged and waits for the next tick. Once the first deposits are
   * read back to the deploy, step 2 keeps them as it counts the transactions, and a new round
   * starts only every LP_FOLLOW_MS.
   */
  private async followLp(): Promise<boolean> {
    if (
      this.meta("lp_backfilled") !== null &&
      this.meta("lp_round_head") === null &&
      Date.now() - Number(this.meta("lp_followed_at") ?? 0) < LP_FOLLOW_MS &&
      this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM lp_backlog WHERE retry_at <= ?", Date.now())
        .one().n === 0
    )
      return false;
    try {
      const listing = await this.listLp();
      const reading = await this.processLp();
      return listing || reading;
    } catch (e) {
      console.warn(`stats providers: the Queue's history not read: ${describeError(e)}`);
      return false;
    }
  }

  /**
   * Pages the Queue's newest signatures back to `lp_cursor`; true while the round is not complete.
   * A cursor the RPC no longer holds (`lp_round_cursor_lost`) is listed back past without it, to
   * the first signature older than its slot (`lp_cursor_slot`): `processLp` keeps no record of
   * what it read, so without that floor the Queue's whole history would be read again (a cursor
   * stored without its slot is, back to the oldest signature the RPC holds: a first deposit read
   * again is kept once). A `before` it no longer holds ends the round with what it listed, as
   * `list` does.
   */
  private async listLp(): Promise<boolean> {
    const [queue] = await findQueuePda(cfg);
    const cursor = this.meta("lp_cursor");
    const cursorSlot = this.meta("lp_cursor_slot");
    const round =
      Number(this.meta("lp_round") ?? 0) + (this.meta("lp_round_head") === null ? 1 : 0);
    for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
      if (this.replayOver()) return true;
      const before = this.meta("lp_round_before");
      const lostCursor = this.meta("lp_round_cursor_lost") !== null;
      const until = cursor && !lostCursor ? cursor : null;
      const { sigs: listedSigs, lost } = await this.signaturesPage(
        queue,
        until,
        before,
        "refusal_lp",
      );
      if (lost === "until") {
        console.warn(
          `stats providers: the RPC no longer holds the Queue's cursor ${cursor}: listed back to ` +
            (cursorSlot !== null ? `its slot ${cursorSlot}` : "the oldest signature it holds"),
        );
        this.setMeta("lp_round_cursor_lost", "1");
        continue;
      }
      if (lost === "before")
        console.warn(
          `stats providers: the RPC no longer holds ${before}, where the Queue's listing stopped: the round ends with what it listed`,
        );
      const slotFloor = lostCursor && cursorSlot !== null ? BigInt(cursorSlot) : null;
      const end = slotFloor === null ? -1 : listedSigs.findIndex((s) => BigInt(s.slot) < slotFloor);
      const sigs = end === -1 ? listedSigs : listedSigs.slice(0, end);
      this.ctx.storage.transactionSync(() => {
        this.setMeta("lp_round", String(round));
        if (this.meta("lp_round_head") === null && sigs[0]) {
          this.setMeta("lp_round_head", sigs[0].signature);
          if (sigs[0].slot != null) this.setMeta("lp_round_head_slot", String(sigs[0].slot));
        }
        for (const s of sigs) {
          if (s.err !== null) continue;
          this.sql.exec(
            "INSERT OR IGNORE INTO lp_backlog (signature, round, block_time) VALUES (?, ?, ?)",
            s.signature,
            round,
            s.blockTime === null ? null : Number(s.blockTime),
          );
        }
        const last = sigs[sigs.length - 1];
        if (lost === null && end === -1 && sigs.length === PAGE && last) {
          this.setMeta("lp_round_before", last.signature);
        } else {
          // reached the cursor (or the deploy, or its slot, or what the RPC holds): the round is
          // complete. A lost cursor with nothing newer stays lost: the next round lists back to
          // its slot again rather than asking for it.
          const head = this.meta("lp_round_head");
          if (head !== null) {
            this.setMeta("lp_cursor", head);
            const headSlot = this.meta("lp_round_head_slot");
            if (headSlot !== null) this.setMeta("lp_cursor_slot", headSlot);
            else this.delMeta("lp_cursor_slot");
            this.delMeta("lp_round_cursor_lost");
          }
          this.setMeta("lp_completed", String(round));
          this.setMeta("lp_followed_at", String(Date.now()));
          this.delMeta("lp_round_head");
          this.delMeta("lp_round_head_slot");
          this.delMeta("lp_round_before");
        }
      });
      if (this.meta("lp_round_before") === null) return false;
    }
    return true;
  }

  /**
   * Reads queued signatures of complete rounds and keeps each owner's earliest deposit request.
   * True while some can be read right away.
   */
  private async processLp(): Promise<boolean> {
    const completed = this.meta("lp_completed");
    if (completed === null) return false;
    const now = Date.now();
    const rows = this.sql
      .exec<{ signature: string; block_time: number | null; tries: number }>(
        `SELECT signature, block_time, tries FROM lp_backlog WHERE round <= ? AND retry_at <= ?
         LIMIT ?`,
        Number(completed),
        now,
        MAX_LP_TX_PER_TICK,
      )
      .toArray();
    for (const row of rows) {
      if (this.replayOver()) break;
      let tx: JsonTx | null = null;
      let reason = "not served";
      try {
        tx = await getJsonTransaction<JsonTx>(this.rpc, row.signature as Signature, "finalized");
      } catch (e) {
        reason = describeError(e);
      }
      if (!tx) {
        const tries = row.tries + 1;
        this.sql.exec(
          "UPDATE lp_backlog SET tries = ?, retry_at = ? WHERE signature = ?",
          tries,
          now + replayBackoffMs(tries),
          row.signature,
        );
        console.warn(
          `stats providers: transaction ${row.signature} unreadable (${tries} tries): ${reason}` +
            (tries >= LP_GIVE_UP_TRIES
              ? "; the first deposits are served without it, read again every hour"
              : ""),
        );
        continue;
      }
      const at = tx.blockTime == null ? row.block_time : Number(tx.blockTime);
      const read = tx;
      this.ctx.storage.transactionSync(() => {
        this.recordFirstDeposits(row.signature, read, at);
        this.sql.exec("DELETE FROM lp_backlog WHERE signature = ?", row.signature);
      });
    }
    const left = this.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM lp_backlog WHERE round <= ? AND tries < ?",
        Number(completed),
        LP_GIVE_UP_TRIES,
      )
      .one().n;
    // every signature of the first complete round read, or given up on: the first deposits known
    if (left === 0 && this.meta("lp_backfilled") === null)
      this.ctx.storage.transactionSync(() => {
        this.setMeta("lp_backfilled", "1");
        this.setMeta("lp_changed_at", String(Date.now()));
      });
    const ready = this.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM lp_backlog WHERE round <= ? AND retry_at <= ?",
        Number(completed),
        Date.now(),
      )
      .one().n;
    return ready > 0;
  }

  // --- the wallets' history (GET /v1/wallet/:owner, step 5) --------------------------------

  /**
   * Stores one transaction's events for the wallets, inside the storage transaction that reads
   * it. Keyed by signature: a transaction stored twice changes nothing.
   */
  private recordWallet(
    signature: string,
    tx: JsonTx,
    at: number | null,
  ): ReturnType<typeof walletEventsOf> {
    const found = walletEventsOf(tx, PROGRAM);
    if (!found) return null;
    const slot = (tx as { slot?: number | bigint | null }).slot;
    this.sql.exec(
      "INSERT OR REPLACE INTO wallet_txs (signature, at, slot, events) VALUES (?, ?, ?, ?)",
      signature,
      at,
      slot == null ? 0 : Number(slot),
      eventsJson(found.events),
    );
    for (const key of found.keys)
      this.sql.exec(
        "INSERT OR IGNORE INTO wallet_keys (key, signature) VALUES (?, ?)",
        key,
        signature,
      );
    return found;
  }

  /**
   * Starts the replay for the wallets (step 5), once, for an index that counted transactions
   * before it stored them for the wallets: from the cursor back to the deploy. A new index stores
   * every transaction from its first read: its whole history is covered.
   */
  private startWalletReplay(): void {
    if (Number(this.meta("wallet_version") ?? 0) >= WALLET_EVENTS_VERSION) return;
    this.ctx.storage.transactionSync(() => {
      const cursor = this.meta("cursor");
      if (cursor !== null) {
        this.sql.exec(
          "INSERT OR IGNORE INTO wallet_replay (signature, idx, block_time) VALUES (?, 0, NULL)",
          cursor,
        );
        this.setMeta("wallet_replay_before", cursor);
        this.setMeta("wallet_replay_listed", "1");
        this.setMeta("wallet_replay_listing", "1");
        this.delMeta("wallet_covered");
      } else {
        // nothing counted yet: step 2 stores every transaction from the deploy
        this.setMeta("wallet_covered", "1");
      }
      this.setMeta("wallet_version", String(WALLET_EVENTS_VERSION));
    });
  }

  /**
   * One bounded step of the replay for the wallets: lists its signatures back to the deploy, then
   * reads and stores up to MAX_APR_REPLAY_PER_TICK of them, newest first. True while there is
   * more to read right away.
   */
  private async walletReplay(): Promise<boolean> {
    if (this.meta("wallet_replay_listing") !== null) return this.listWalletReplay();
    const now = Date.now();
    const rows = this.sql
      .exec<{ signature: string; block_time: number | null; tries: number }>(
        `SELECT signature, block_time, tries FROM wallet_replay WHERE retry_at <= ?
         ORDER BY idx LIMIT ?`,
        now,
        MAX_APR_REPLAY_PER_TICK,
      )
      .toArray();
    for (const row of rows) {
      if (this.replayOver()) break;
      let tx: JsonTx | null = null;
      let reason = "not served";
      try {
        tx = await getJsonTransaction<JsonTx>(this.rpc, row.signature as Signature, "finalized");
      } catch (e) {
        reason = describeError(e);
      }
      if (!tx) {
        const tries = row.tries + 1;
        this.sql.exec(
          "UPDATE wallet_replay SET tries = ?, retry_at = ? WHERE signature = ?",
          tries,
          now + replayBackoffMs(tries),
          row.signature,
        );
        console.warn(
          `stats wallets: transaction ${row.signature} unreadable (${tries} tries): ${reason}` +
            (tries >= LP_GIVE_UP_TRIES
              ? "; the wallets are served without it, read again every hour"
              : ""),
        );
        continue;
      }
      const read = tx;
      const at = read.blockTime == null ? row.block_time : Number(read.blockTime);
      this.ctx.storage.transactionSync(() => {
        this.recordWallet(row.signature, read, at);
        this.sql.exec("DELETE FROM wallet_replay WHERE signature = ?", row.signature);
      });
    }
    const left = this.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM wallet_replay WHERE tries < ?",
        LP_GIVE_UP_TRIES,
      )
      .one().n;
    if (left === 0 && this.meta("wallet_covered") === null) {
      // every transaction read, or given up on: the wallets' answers are complete
      this.setMeta("wallet_covered", "1");
      this.wallets.clear();
    }
    const ready = this.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM wallet_replay WHERE retry_at <= ?",
        Date.now(),
      )
      .one().n;
    return ready > 0;
  }

  /** Pages the wallet replay's signatures back to the deploy; true while there are more to list. */
  private async listWalletReplay(): Promise<boolean> {
    for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
      if (this.replayOver()) return true;
      const before = this.meta("wallet_replay_before") as Signature;
      const { sigs, lost } = await this.signaturesPage(
        PROGRAM,
        null,
        before,
        "refusal_wallet_replay",
      );
      if (lost) console.warn(historyGone("wallets' replay", before));
      const listed = Number(this.meta("wallet_replay_listed") ?? 0);
      this.ctx.storage.transactionSync(() => {
        sigs.forEach((s, i) => {
          if (s.err !== null) return;
          this.sql.exec(
            "INSERT OR IGNORE INTO wallet_replay (signature, idx, block_time) VALUES (?, ?, ?)",
            s.signature,
            listed + i,
            s.blockTime === null ? null : Number(s.blockTime),
          );
        });
        this.setMeta("wallet_replay_listed", String(listed + sigs.length));
        const last = sigs[sigs.length - 1];
        if (!lost && sigs.length === PAGE && last)
          this.setMeta("wallet_replay_before", last.signature);
        else
          for (const k of [
            "wallet_replay_before",
            "wallet_replay_listed",
            "wallet_replay_listing",
          ] as const)
            this.delMeta(k);
      });
      if (this.meta("wallet_replay_listing") === null) return true;
    }
    return true;
  }

  /**
   * Unix seconds up to which every program transaction is stored for the wallets: the newest one
   * counted, or, once every listed one is read, the last time the loop found it so less
   * WALLET_FINALITY_S (a transaction confirmed before it may have been finalized, and listed,
   * only after); just before the oldest one listed and not read yet when there is one, unless
   * the RPC failed to return it WALLET_THROUGH_GIVE_UP_TRIES times (it is then left out, as the
   * wallets' replay leaves out one it gives up on). Null before any is read.
   */
  private walletThrough(): number | null {
    const counted = this.meta("through");
    const current = this.currentAt();
    let through: number | null = counted === null ? null : Number(counted);
    if (current !== null && this.meta("caught_up") === "1")
      through = Math.max(through ?? 0, current - WALLET_FINALITY_S);
    const oldest = this.sql
      .exec<{ t: number | null }>(
        `SELECT MIN(b.block_time) AS t FROM backlog b LEFT JOIN failures f USING (signature)
         WHERE f.tries IS NULL OR f.tries < ?`,
        WALLET_THROUGH_GIVE_UP_TRIES,
      )
      .one().t;
    if (oldest !== null && through !== null) through = Math.min(through, oldest - 1);
    return through;
  }

  /**
   * The stored transactions any of these accounts finds, counted without reading them (an upper
   * bound: one found by several accounts in different statements counts more than once).
   */
  private walletTxCount(keys: readonly string[]): number {
    let n = 0;
    for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
      const chunk = keys.slice(i, i + KEYS_PER_QUERY);
      n += this.sql
        .exec<{ n: number }>(
          `SELECT COUNT(DISTINCT signature) AS n FROM wallet_keys
           WHERE key IN (${chunk.map(() => "?").join(", ")})`,
          ...chunk,
        )
        .one().n;
    }
    return n;
  }

  /** The stored transactions any of these accounts finds. */
  private walletTxs(keys: readonly string[]): WalletTx[] {
    const out: WalletTx[] = [];
    for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
      const chunk = keys.slice(i, i + KEYS_PER_QUERY);
      const rows = this.sql
        .exec<{ signature: string; at: number | null; slot: number; events: string }>(
          `SELECT signature, at, slot, events FROM wallet_txs WHERE signature IN (
             SELECT signature FROM wallet_keys WHERE key IN (${chunk.map(() => "?").join(", ")})
           )`,
          ...chunk,
        )
        .toArray();
      for (const r of rows)
        out.push({
          signature: r.signature,
          at: r.at,
          slot: r.slot,
          events: eventsFrom(r.events),
        });
    }
    return out;
  }

  /**
   * One wallet's answer from the stored transactions: those its integrator record, its USDC
   * account and the wallet itself find, then every transaction of the tickets they opened for
   * it, worked out with the app's own code (walletIndex.ts); `oversized` past WALLET_READ_MAX of
   * them. The transactions, `through` and whether it is syncing are read in one synchronous
   * section, before any wait: the loop's tick cannot store a transaction in between, so the
   * answer holds every one `through` says it does.
   */
  private async buildWallet(owner: Address): Promise<WalletView> {
    const [[integrator], usdcAccount] = await Promise.all([
      findIntegratorPda({ integratorAuthority: owner }, cfg),
      ata(owner, USDC_MINT),
    ]);
    const keys = { owner, integrator, usdcAccount };
    const now = Math.floor(Date.now() / 1_000);
    const current = this.currentAt();
    const through = this.walletThrough();
    const syncing =
      this.meta("caught_up") !== "1" ||
      this.meta("wallet_covered") === null ||
      current === null ||
      now - current > INDEX_FRESH_S;
    const own = [owner, integrator, usdcAccount];
    let read = this.walletTxCount(own);
    if (read > WALLET_READ_MAX) return oversizedWalletView(keys, through, now);
    const txs = new Map<string, WalletTx>();
    const tickets = new Set<string>();
    const tables = new Set<Address>();
    for (const t of this.walletTxs(own)) {
      txs.set(t.signature, t);
      for (const e of t.events)
        if (
          (e.kind === "TicketOpened" || e.kind === "TicketJoined") &&
          (isAppRow(e.data, keys) || isBuyerRow(e.data, keys))
        ) {
          tickets.add(e.data.ticket);
          if (e.kind === "TicketJoined") tables.add(e.data.payoutTable);
        }
    }
    read += this.walletTxCount([...tickets]);
    if (read > WALLET_READ_MAX) return oversizedWalletView(keys, through, now);
    for (const t of this.walletTxs([...tickets])) txs.set(t.signature, t);
    try {
      await this.readTables([...tables]);
    } catch (e) {
      // their tickets' odds wait for the next build
      console.warn(`stats wallets: payout tables not read: ${describeError(e)}`);
    }
    return walletView({
      keys,
      txs: [...txs.values()],
      lhs: this.payoutLhs(),
      through,
      syncing,
      now,
    });
  }

  // --- the live push ------------------------------------------------------------------------

  /** The hub, built on first use from the connections the object holds (liveHub.ts). */
  private liveHub(): LiveHub<WebSocket> {
    if (!this.hub) {
      const hub = new LiveHub<WebSocket>();
      for (const ws of this.ctx.getWebSockets()) hub.restore(ws, ws.deserializeAttachment());
      this.hub = hub;
    }
    return this.hub;
  }

  /** The hub when some connection is open; null otherwise (or where the runtime has none). */
  private openHub(): LiveHub<WebSocket> | null {
    try {
      const hub = this.liveHub();
      return hub.size ? hub : null;
    } catch {
      return null;
    }
  }

  /** GET /v1/live, the WebSocket upgrade the Worker forwards (index.ts). */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("expected a WebSocket upgrade", { status: 426 });
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const refused = this.liveHub().admit(ip);
    if (refused) return new Response(refused, { status: 503, headers: { "Retry-After": "30" } });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.acceptLive(server, ip);
    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptLive(ws: WebSocket, ip: string): void {
    this.ctx.acceptWebSocket(ws);
    this.liveHub().add(ws, ip);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const hub = this.liveHub();
    const op = hub.handle(ws, message);
    if (op.kind !== "subscribe") return;
    this.noteLiveAsks(hub);
    if (op.wallets.length) {
      let subscribed = false;
      for (const owner of op.wallets) {
        if (!isAddress(owner)) continue;
        const [[integrator], usdcAccount] = await Promise.all([
          findIntegratorPda({ integratorAuthority: owner }, cfg),
          ata(owner, USDC_MINT),
        ]);
        hub.subscribeWallet(ws, owner, [owner, integrator, usdcAccount]);
        subscribed = true;
      }
      if (!subscribed) hub.acknowledge(ws);
    }
    // a new subscriber gets the topic's last answer at once, built now when there is none
    for (const topic of op.topics) {
      if (hub.sendView(ws, topic)) continue;
      try {
        hub.publish(topic, await this.liveView(topic));
      } catch (e) {
        console.warn(`stats live: ${topic} not built: ${describeError(e)}`);
      }
    }
    await this.freshen();
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.liveHub().remove(ws);
    try {
      // 1005 and 1006 say no code was sent: they cannot be sent back
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // closed already
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.liveHub().remove(ws);
  }

  /**
   * The topics subscribed to count as asked for, as a request to their route would, and a wallet
   * subscribed to keeps the loop following the program as the feed does. A connection subscribed
   * to nothing asks for nothing (and is closed, `reap`).
   */
  private noteLiveAsks(hub: LiveHub<WebSocket>): void {
    const now = Date.now();
    if (hub.hasWallets()) this.liveAt = now;
    const wanted = hub.wanted();
    if (wanted.has("feed")) this.feedAskedAt = now;
    if (wanted.has("apr")) this.aprAskedAt = now;
    if (wanted.has("providers")) this.providersAskedAt = now;
  }

  /**
   * A topic's answer as its route serves it. The feed and the vault history are built again
   * here (instead of in the background) once a transaction with their events was recorded since
   * their last build and they are as old as their route would rebuild them, or once they are
   * LIVE_REFRESH_MS old (their windows slide), so a change goes out with this push; the APR and
   * the providers come from what the tick built, built again only when due (`aprDue`,
   * `providersDue`): data that did not change is not read again for the push.
   */
  private async liveView(topic: LiveTopic): Promise<unknown> {
    switch (topic) {
      case "stats":
        return this.statsView();
      case "apr":
        return this.aprServed(() => this.aprDue());
      case "providers":
        return this.providersServed(() => this.providersDue());
      case "vault":
        return this.freshView("vault", () => this.buildVault(), VAULT_REFRESH_MS);
      case "feed":
        return this.freshView("feed", () => this.buildFeed(), FEED_REFRESH_MS);
    }
  }

  /**
   * A view's answer kept while younger than `refreshMs`, or while nothing it shows was recorded
   * since it was built and it is younger than LIVE_REFRESH_MS; else built now (the kept one if
   * that fails).
   */
  private async freshView<T>(
    kind: ViewKind,
    build: () => Promise<T>,
    refreshMs: number,
  ): Promise<T> {
    const kept = this.kept.get(kind);
    const age = kept ? Date.now() - kept.at : Infinity;
    if (kept && (age < refreshMs || (kept.at > this.viewsChangedAt && age < LIVE_REFRESH_MS)))
      return kept.view as T;
    try {
      return await this.rebuild(kind, build);
    } catch (e) {
      if (kept) return kept.view as T;
      throw e;
    }
  }

  /**
   * One push, at the end of an alarm: each topic subscribed to (sent when it changed, or to keep
   * it fresh), then a notification to each subscribed wallet the transactions counted since the
   * last push concern. Its kept answer is dropped first, so the request that follows the
   * notification is built with them.
   */
  private async pushLive(hub: LiveHub<WebSocket>): Promise<void> {
    const txs = this.liveTxs;
    this.liveTxs = [];
    for (const topic of hub.wanted()) {
      try {
        if (hub.publish(topic, await this.liveView(topic)) < 0)
          console.warn(`stats live: the ${topic} answer is larger than a message may be`);
      } catch (e) {
        console.warn(`stats live: ${topic} not built: ${describeError(e)}`);
      }
    }
    if (txs.length && hub.hasWallets()) {
      const matches = hub.matchWallets(
        txs.map((t) => ({ ...t, keys: [...t.keys, ...this.openingKeys(t.tickets)] })),
      );
      for (const owner of matches.keys()) this.wallets.delete(owner as Address);
      hub.notifyWallets(matches);
    }
    hub.flush();
  }

  /**
   * The accounts the stored openings of these tickets name (walletIndex `openingAccountsOf`):
   * every ticket's, however many one transaction settles, and only its opening's, not the other
   * accounts of the transactions that name it.
   */
  private openingKeys(tickets: readonly string[]): string[] {
    const keys = new Set<string>();
    for (let i = 0; i < tickets.length; i += KEYS_PER_QUERY) {
      const chunk = tickets.slice(i, i + KEYS_PER_QUERY);
      const rows = this.sql
        .exec<{ events: string }>(
          `SELECT t.events FROM wallet_txs t WHERE t.signature IN (
             SELECT signature FROM wallet_keys WHERE key IN (${chunk.map(() => "?").join(", ")})
           ) AND (t.events LIKE '%"TicketOpened"%' OR t.events LIKE '%"TicketJoined"%')`,
          ...chunk,
        )
        .toArray();
      const wanted = new Set(chunk);
      for (const r of rows)
        for (const k of openingAccountsOf(eventsFrom(r.events), wanted)) keys.add(k);
    }
    return [...keys];
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
      .exec<{ price: string; payout_max: string; integrator: string | null; beacon: number }>(
        "SELECT price, payout_max, integrator, beacon FROM open_tickets WHERE ticket = ?",
        ticket,
      )
      .toArray()[0];
    return r
      ? {
          price: BigInt(r.price),
          payoutMax: BigInt(r.payout_max),
          beacon: r.beacon === 1,
          integrator: r.integrator as Address | null,
        }
      : null;
  }

  private closedUnopened(ticket: Address): boolean {
    return (
      this.sql.exec("SELECT 1 FROM closed_unopened WHERE ticket = ?", ticket).toArray().length > 0
    );
  }

  /**
   * Adds a column to a table created before it, once. The columns are read
   * with the `PRAGMA table_info(x)` statement, as faucet.ts and the beacon
   * engine's `migrate` do on the Workers SQLite authorizer.
   */
  private addColumn(table: string, column: string, type: string): void {
    const has = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .some((c) => c.name === column);
    if (!has) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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
