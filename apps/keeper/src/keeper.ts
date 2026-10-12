// The keeper's Durable Object: one instance holds every ticket it tracks in its
// SQLite storage and advances them on an alarm, one step a tick, persisting
// each step so that a restart resumes where the last tick stopped.
//
//   queued     Open on chain: request_randomness from open slot + 2
//   requested  Requested, ORAO not yet fulfilled: wait
//   fulfilled  Requested and fulfilled: settle_ticket
//   settled    closed by a settlement (or parked: PayoutPending)
//   expired    closed by expire_ticket past T_SETTLE
//   unknown    closed, and no settlement or expiry could be found
//
// Every ~30 s a sweep adds the open tickets nobody posted, strikes the live epoch
// once its close has passed and it is clean, and claims struck LP requests.
import { DurableObject } from "cloudflare:workers";
import {
  getBase58Decoder,
  getBase58Encoder,
  isAddress,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import {
  DEPOSIT_REQUEST_DISCRIMINATOR,
  EPOCH_RECORD_DISCRIMINATOR,
  TICKET_DISCRIMINATOR,
  TICKET_EXPIRED_EVENT_DISCRIMINATOR,
  TICKET_SETTLED_EVENT_DISCRIMINATOR,
  WITHDRAW_REQUEST_DISCRIMINATOR,
  TicketStatus,
  findVaultPda,
  findQueuePda,
  findShareMintPda,
  getClaimDepositInstructionAsync,
  getClaimWithdrawInstructionAsync,
  getDepositRequestDecoder,
  getEpochRecordDecoder,
  getExpireTicketInstructionAsync,
  getVaultDecoder,
  getQueueDecoder,
  getRequestRandomnessInstructionAsync,
  getSettleTicketInstructionAsync,
  getStrikeEpochInstructionAsync,
  getTicketDecoder,
  getTicketExpiredEventDecoder,
  getTicketSettledEventDecoder,
  getWithdrawRequestDecoder,
  type EpochRecord,
  type Ticket,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  DEFAULT_RPC_URL,
  EVENT_IX_TAG,
  PROGRAM,
  REQUEST_MIN_DELAY_SLOTS,
  SLOT_HASHES,
  SYSTEM,
  USDC_MINT,
  ata,
  build,
  cfg,
  decodeBase64,
  describeError,
  epochPda,
  errorText,
  eventAuthority,
  firstSlotHashAfter,
  isFulfilled,
  makeRpc,
  oraoRequestPda,
  oraoSeed,
  oraoTreasury,
  rpcStatus,
  sendWire,
  signerFromSecret,
  simulateBuilt,
  sleep,
  startsWith,
  type Rpc,
} from "./chain.ts";
import type { Env } from "./index.ts";

/** Tick period while a ticket is in flight, and while idle. */
const ACTIVE_INTERVAL_MS = 1_500;
const IDLE_INTERVAL_MS = 15_000;
const SWEEP_INTERVAL_MS = 30_000;
/** A sent transaction not seen after this long is dropped (its blockhash has expired) and rebuilt. */
const PENDING_TIMEOUT_MS = 75_000;
const RESEND_EVERY_MS = 4_000;
/** Tickets advanced per tick: one getMultipleAccounts holds 100 accounts (ticket + randomness each). */
const MAX_TICKETS_PER_TICK = 40;
/** LP claims sent per sweep. */
const MAX_CLAIMS_PER_SWEEP = 6;
/** Terminal records are kept this long for the app to read, then pruned. */
const MISS_TTL_MS = 5_000;
const RETENTION_MS = 7 * 24 * 3_600_000;
/** How often closed tickets past their retention are deleted. */
const PRUNE_INTERVAL_MS = 3_600_000;
/** An alarm this far in the past is dead; the cron trigger replaces it. */
const STALE_ALARM_MS = 60_000;
/** `fade_math::shares::CHAIN_R_MIN`: a record whose `r_after` is below it (and not 0) splits the chain. */
const CHAIN_R_MIN = 1_000_000_000_000n;

const TICKET_SIZE = 859n;
const DEPOSIT_REQUEST_SIZE = 67n;
const WITHDRAW_REQUEST_SIZE = 115n;
const EPOCH_RECORD_SIZE = 210n;

/** Compute units: a request CPIs into ORAO, a settlement moves tokens. */
const UNITS = { request: 200_000, settle: 200_000, expire: 100_000, lp: 300_000 } as const;

export type TicketState = "queued" | "requested" | "fulfilled" | "settled" | "expired" | "unknown";
const ACTIVE: readonly TicketState[] = ["queued", "requested", "fulfilled"];
type PendingKind = "request" | "settle" | "expire";

type Row = {
  address: string;
  state: TicketState;
  source: string;
  open_slot: string | null;
  expiry_slot: string | null;
  randomness: string | null;
  request_sig: string | null;
  settle_sig: string | null;
  expire_sig: string | null;
  outcome: number | null;
  payout: string | null;
  pending_kind: PendingKind | null;
  pending_sig: string | null;
  pending_wire: string | null;
  pending_sent_at: number | null;
  pending_resent_at: number | null;
  attempts: number;
  next_try_at: number;
  last_error: string | null;
  detail_tries: number;
  created_at: number;
  updated_at: number;
};

export type TicketView = {
  state: TicketState;
  openSlot?: number;
  requestSignature?: string;
  settleSignature?: string;
  expireSignature?: string;
  outcome?: number;
  payout?: string;
  /** ISO 8601. */
  updatedAt: string;
};

export type Health = {
  keeper: string;
  lamports: string;
  lastTick: number;
  queue: number;
  /** Set when the upstream RPC could not be read. */
  rpcError?: string;
};

export type EnqueueResult =
  { ok: true; state: TicketState } | { ok: false; status: number; error: string };

const b58 = (bytes: ArrayLike<number>) => getBase58Decoder().decode(Uint8Array.from(bytes));
const backoff = (attempts: number) => Math.min(1_000 * 2 ** attempts, 60_000);

/** A row as the API shows it. */
function view(r: Row): TicketView {
  const v: TicketView = { state: r.state, updatedAt: new Date(r.updated_at).toISOString() };
  if (r.open_slot !== null) v.openSlot = Number(r.open_slot);
  if (r.request_sig !== null) v.requestSignature = r.request_sig;
  if (r.settle_sig !== null) v.settleSignature = r.settle_sig;
  if (r.expire_sig !== null) v.expireSignature = r.expire_sig;
  if (r.outcome !== null) v.outcome = r.outcome;
  if (r.payout !== null) v.payout = r.payout;
  return v;
}

function decodeTicket(data: Uint8Array): Ticket | null {
  if (!startsWith(data, TICKET_DISCRIMINATOR) || BigInt(data.length) !== TICKET_SIZE) return null;
  try {
    return getTicketDecoder().decode(data);
  } catch {
    return null;
  }
}

type JsonTx = {
  meta: {
    err: unknown;
    innerInstructions?:
      readonly { instructions: readonly { programIdIndex: number; data: string }[] }[] | null;
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null;
  } | null;
  transaction: { message: { accountKeys: readonly string[] } };
};

type Closure = { kind: "settled"; outcome: number; payout: bigint } | { kind: "expired" } | null;

/** The settlement or expiry of `ticket` in a transaction, from its `emit_cpi!` events. */
function closureOf(tx: JsonTx, ticket: string): Closure {
  if (!tx.meta || tx.meta.err) return null;
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== PROGRAM) continue;
      const data = new Uint8Array(getBase58Encoder().encode(ix.data));
      if (!startsWith(data, EVENT_IX_TAG)) continue;
      const body = data.subarray(8);
      try {
        if (startsWith(body, TICKET_SETTLED_EVENT_DISCRIMINATOR)) {
          const e = getTicketSettledEventDecoder().decode(body);
          if (e.ticket === ticket) return { kind: "settled", outcome: e.outcome, payout: e.payout };
        } else if (startsWith(body, TICKET_EXPIRED_EVENT_DISCRIMINATOR)) {
          const e = getTicketExpiredEventDecoder().decode(body);
          if (e.ticket === ticket) return { kind: "expired" };
        }
      } catch {
        // not a decodable Fade event
      }
    }
  }
  return null;
}

export class Keeper extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly rpc: Rpc;
  private signerPromise: Promise<KeyPairSigner> | null = null;
  private treasury: Address | null = null;
  private lastTick = 0;
  private lastSweep = 0;
  private lastPrune = 0;
  private balance: { lamports: bigint; at: number } | null = null;
  /** Addresses a lookup found no account at, until when. */
  private readonly misses = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.rpc = makeRpc(env.RPC_URL || DEFAULT_RPC_URL);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tickets (
      address TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      source TEXT NOT NULL,
      open_slot TEXT,
      expiry_slot TEXT,
      randomness TEXT,
      request_sig TEXT,
      settle_sig TEXT,
      expire_sig TEXT,
      outcome INTEGER,
      payout TEXT,
      pending_kind TEXT,
      pending_sig TEXT,
      pending_wire TEXT,
      pending_sent_at INTEGER,
      pending_resent_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_try_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      detail_tries INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS tickets_state ON tickets (state)");
    // The loop reads only what it works on: open tickets by state and age, and settled ones
    // still missing their payout through a partial index. Without these the loop's query
    // scanned the whole table (every ticket kept for RETENTION_MS) on each tick, millions of
    // rows a day, and ran the account into its daily read limit.
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS tickets_state_created ON tickets (state, created_at)",
    );
    // the retention prune reads only the rows it deletes
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS tickets_state_updated ON tickets (state, updated_at)",
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS tickets_missing_payout ON tickets (created_at)
       WHERE state = 'settled' AND payout IS NULL AND settle_sig IS NOT NULL AND detail_tries < 10`,
    );
  }

  // --- API (called by the Worker through the stub) --------------------------------------

  /** Validates that `ticket` is a Fade ticket account and queues it. */
  async enqueue(ticket: string, source = "post"): Promise<EnqueueResult> {
    if (!isAddress(ticket)) return { ok: false, status: 400, error: "not a base58 address" };
    const existing = this.row(ticket);
    if (existing && ACTIVE.includes(existing.state)) {
      await this.ensureAlarm(true);
      return { ok: true, state: existing.state };
    }
    // The app posts right after its open confirms: give a lagging RPC node a moment.
    // A lookup (a GET of an untracked address) reads once, and remembers a miss briefly.
    const lookup = source === "lookup";
    if (lookup && (this.misses.get(ticket) ?? 0) > Date.now())
      return { ok: false, status: 404, error: "account not found" };
    let found: { owner: string; data: Uint8Array } | null = null;
    for (let i = 0; i < (lookup ? 1 : 3) && !found; i++) {
      if (i) await sleep(1_000);
      const { value } = await this.rpc
        .getAccountInfo(ticket, { encoding: "base64", commitment: "confirmed" })
        .send();
      if (value) found = { owner: value.owner, data: decodeBase64(value.data[0]) };
    }
    if (!found) {
      if (existing) return { ok: true, state: existing.state };
      if (this.misses.size > 10_000) this.misses.clear();
      this.misses.set(ticket, Date.now() + MISS_TTL_MS);
      return { ok: false, status: 404, error: "account not found" };
    }
    const w = found.owner === PROGRAM ? decodeTicket(found.data) : null;
    if (!w) return { ok: false, status: 422, error: "not a Fade ticket account" };
    this.track(ticket, w, source);
    await this.ensureAlarm(true);
    return { ok: true, state: this.row(ticket)?.state ?? "queued" };
  }

  /** The keeper's record of `ticket`; an untracked ticket still open on chain is queued on the way. */
  async status(ticket: string): Promise<TicketView> {
    if (!isAddress(ticket)) return { state: "unknown", updatedAt: new Date().toISOString() };
    const r = this.row(ticket);
    if (r) return view(r);
    const res = await this.enqueue(ticket, "lookup").catch(() => null);
    const after = this.row(ticket);
    if (res?.ok && after) return view(after);
    return { state: "unknown", updatedAt: new Date().toISOString() };
  }

  async health(): Promise<Health> {
    await this.ensureAlarm(false);
    const signer = await this.signer();
    let rpcError: string | undefined;
    if (!this.balance || Date.now() - this.balance.at > 10_000) {
      try {
        const { value } = await this.rpc
          .getBalance(signer.address, { commitment: "confirmed" })
          .send();
        this.balance = { lamports: value, at: Date.now() };
      } catch (e) {
        rpcError = describeError(e);
      }
    }
    return {
      keeper: signer.address,
      lamports: this.balance ? this.balance.lamports.toString() : "unknown",
      lastTick: this.lastTick,
      queue: this.activeCount(),
      ...(rpcError ? { rpcError } : {}),
    };
  }

  /** Called by the cron trigger: restarts the loop should its alarm ever be lost. */
  async ensureAlarm(soon: boolean): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const target = Date.now() + (soon ? 0 : IDLE_INTERVAL_MS);
    // an alarm left in the past (its handler kept failing, e.g. over a platform limit) never
    // fires again on its own: replace it
    if (current === null || current > target || current < Date.now() - STALE_ALARM_MS)
      await this.ctx.storage.setAlarm(target);
  }

  // --- the loop -----------------------------------------------------------------------

  override async alarm(): Promise<void> {
    try {
      await this.tick();
    } catch (e) {
      console.error(`tick failed: ${describeError(e)}`);
    } finally {
      const delay = this.activeCount() > 0 ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
      const current = await this.ctx.storage.getAlarm();
      const target = Date.now() + delay;
      if (current === null || current > target) await this.ctx.storage.setAlarm(target);
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    this.lastTick = now;
    const open = this.sql
      .exec<Row>(
        `SELECT * FROM tickets WHERE state IN ('queued', 'requested', 'fulfilled')
         ORDER BY created_at LIMIT ?`,
        MAX_TICKETS_PER_TICK,
      )
      .toArray();
    const missing =
      open.length < MAX_TICKETS_PER_TICK
        ? this.sql
            .exec<Row>(
              `SELECT * FROM tickets INDEXED BY tickets_missing_payout
               WHERE state = 'settled' AND payout IS NULL AND settle_sig IS NOT NULL AND detail_tries < 10
               ORDER BY created_at LIMIT ?`,
              MAX_TICKETS_PER_TICK - open.length,
            )
            .toArray()
        : [];
    const rows = [...open, ...missing];
    if (rows.length) await this.advance(rows);
    if (now - this.lastSweep >= SWEEP_INTERVAL_MS) {
      this.lastSweep = now;
      try {
        await this.sweep();
      } catch (e) {
        console.error(`sweep failed: ${describeError(e)}`);
        if (rpcStatus(e) === 429) this.lastSweep = now + SWEEP_INTERVAL_MS; // back off a round
      }
      if (now - this.lastPrune >= PRUNE_INTERVAL_MS) {
        this.lastPrune = now;
        this.sql.exec(
          "DELETE FROM tickets WHERE state IN ('settled', 'expired', 'unknown') AND updated_at < ?",
          now - RETENTION_MS,
        );
      }
    }
  }

  private async advance(rows: Row[]): Promise<void> {
    const now = Date.now();

    // 1. Transactions in flight: confirmed, failed, or still to resend.
    const inFlight = rows.filter((r) => r.pending_sig);
    if (inFlight.length) {
      const { value } = await this.rpc
        .getSignatureStatuses(inFlight.map((r) => r.pending_sig as Signature))
        .send();
      for (const [i, r] of inFlight.entries()) {
        const st = value[i];
        if (st?.err) {
          this.failPending(r, `${r.pending_kind} failed on chain: ${errorText(st.err)}`);
        } else if (
          st?.confirmationStatus === "confirmed" ||
          st?.confirmationStatus === "finalized"
        ) {
          this.confirmPending(r);
        } else if (now - (r.pending_sent_at ?? 0) > PENDING_TIMEOUT_MS) {
          this.failPending(r, `${r.pending_kind} not confirmed in time`);
        } else if (now - (r.pending_resent_at ?? 0) > RESEND_EVERY_MS && r.pending_wire) {
          await sendWire(this.rpc, r.pending_wire, true).catch(() => undefined);
          this.sql.exec(
            "UPDATE tickets SET pending_resent_at = ? WHERE address = ?",
            now,
            r.address,
          );
        }
      }
    }

    // 2. Settled tickets still missing their outcome and payout.
    for (const r of rows) {
      const fresh = this.row(r.address);
      if (fresh?.state === "settled" && fresh.payout === null && fresh.settle_sig)
        await this.fillClosure(fresh, fresh.settle_sig).catch(() => undefined);
    }

    // 3. Everything else, from one read of the chain.
    const todo = rows
      .map((r) => this.row(r.address))
      .filter((r): r is Row => !!r && ACTIVE.includes(r.state) && !r.pending_sig);
    if (!todo.length) return;
    const needsHashes = todo.some((r) => r.state === "queued");
    const keys: Address[] = todo.map((r) => r.address as Address);
    const randomnessAt = new Map<string, number>();
    for (const r of todo) {
      if (r.randomness && r.randomness !== SYSTEM) {
        randomnessAt.set(r.address, keys.length);
        keys.push(r.randomness as Address);
      }
    }
    const hashesAt = needsHashes ? keys.push(SLOT_HASHES) - 1 : -1;
    const { context, value: accounts } = await this.rpc
      .getMultipleAccounts(keys, { encoding: "base64", commitment: "confirmed" })
      .send();
    const slot = context.slot;
    const hashesAcc = hashesAt >= 0 ? accounts[hashesAt] : null;
    const slotHashes = hashesAcc ? decodeBase64(hashesAcc.data[0]) : null;

    for (const [i, r] of todo.entries()) {
      try {
        const acc = accounts[i];
        if (!acc) {
          await this.resolveClosed(r);
          continue;
        }
        const w = acc.owner === PROGRAM ? decodeTicket(decodeBase64(acc.data[0])) : null;
        if (!w) {
          this.update(r.address, { state: "unknown", last_error: "not a Fade ticket" });
          continue;
        }
        this.syncFromChain(r, w);
        if (now < r.next_try_at) continue;

        if (w.status === TicketStatus.PayoutPending) {
          this.update(r.address, {
            state: "settled",
            outcome: w.outcome,
            payout: w.payout.toString(),
          });
        } else if (w.status === TicketStatus.Open) {
          this.setState(r, "queued");
          if (slot > w.expirySlot) {
            await this.act(r, "expire", w, SYSTEM);
          } else if (slot >= w.openSlot + REQUEST_MIN_DELAY_SLOTS && slotHashes) {
            const entropy = firstSlotHashAfter(slotHashes, w.openSlot);
            if (!entropy) continue; // s* not in SlotHashes yet
            const seed = await oraoSeed(
              r.address as Address,
              w.openSlot,
              entropy.slot,
              entropy.hash,
            );
            await this.act(r, "request", w, await oraoRequestPda(seed));
          }
        } else if (w.status === TicketStatus.Requested) {
          const ri = randomnessAt.get(r.address);
          const rAcc = ri === undefined ? null : accounts[ri];
          const fulfilled = rAcc ? isFulfilled(decodeBase64(rAcc.data[0])) : false;
          if (fulfilled) {
            this.setState(r, "fulfilled");
            await this.act(r, "settle", w, w.randomness);
          } else if (slot > w.expirySlot) {
            await this.act(r, "expire", w, w.randomness);
          } else {
            this.setState(r, "requested");
          }
        }
      } catch (e) {
        this.recordError(r, describeError(e));
        if (rpcStatus(e) === 429) break; // leave the rest to the next tick
      }
    }
  }

  /** Builds, sends (with preflight) and records one ticket transaction. */
  private async act(r: Row, kind: PendingKind, w: Ticket, randomness: Address): Promise<void> {
    const signer = await this.signer();
    const common = { eventAuthority: await eventAuthority(), program: PROGRAM };
    const ticket = r.address as Address;
    let ix: Instruction;
    if (kind === "request") {
      this.treasury ??= await oraoTreasury(this.rpc);
      ix = await getRequestRandomnessInstructionAsync(
        { caller: signer, ticket, oraoTreasury: this.treasury, request: randomness, ...common },
        cfg,
      );
    } else if (kind === "settle") {
      ix = await getSettleTicketInstructionAsync(
        {
          caller: signer,
          integrator: w.integrator,
          ticket,
          randomness,
          beneficiary: w.beneficiary,
          payer: w.payer,
          usdcMint: USDC_MINT,
          ...common,
        },
        cfg,
      );
    } else {
      ix = await getExpireTicketInstructionAsync(
        {
          caller: signer,
          integrator: w.integrator,
          ticket,
          randomness,
          payer: w.payer,
          ...common,
        },
        cfg,
      );
    }
    const tx = await build(this.rpc, signer, [ix], UNITS[kind]);
    await sendWire(this.rpc, tx.wire);
    const now = Date.now();
    this.update(r.address, {
      pending_kind: kind,
      pending_sig: tx.signature,
      pending_wire: tx.wire,
      pending_sent_at: now,
      pending_resent_at: now,
      ...(kind === "request" ? { randomness } : {}),
    });
    console.log(`${kind} ${r.address}: sent ${tx.signature}`);
  }

  private confirmPending(r: Row): void {
    const sig = r.pending_sig;
    const cleared = {
      pending_kind: null,
      pending_sig: null,
      pending_wire: null,
      pending_sent_at: null,
      pending_resent_at: null,
      attempts: 0,
      next_try_at: 0,
      last_error: null,
    };
    if (r.pending_kind === "request") {
      this.update(r.address, { ...cleared, state: "requested", request_sig: sig });
    } else if (r.pending_kind === "settle") {
      this.update(r.address, { ...cleared, state: "settled", settle_sig: sig });
    } else {
      this.update(r.address, { ...cleared, state: "expired", expire_sig: sig });
    }
    console.log(`${r.pending_kind} ${r.address}: confirmed ${sig}`);
  }

  private failPending(r: Row, error: string): void {
    this.update(r.address, {
      pending_kind: null,
      pending_sig: null,
      pending_wire: null,
      pending_sent_at: null,
      pending_resent_at: null,
      attempts: r.attempts + 1,
      next_try_at: Date.now() + backoff(r.attempts),
      last_error: error,
    });
    console.warn(`${r.address}: ${error}`);
  }

  private recordError(r: Row, error: string): void {
    this.update(r.address, {
      attempts: r.attempts + 1,
      next_try_at: Date.now() + backoff(r.attempts),
      last_error: error,
    });
    console.warn(`${r.address}: ${error}`);
  }

  /** The ticket account is gone: find who closed it, and how. */
  private async resolveClosed(r: Row): Promise<void> {
    if (r.settle_sig) return this.update(r.address, { state: "settled" });
    if (r.expire_sig) return this.update(r.address, { state: "expired" });
    const sigs = await this.rpc
      .getSignaturesForAddress(r.address as Address, { limit: 10, commitment: "confirmed" })
      .send();
    for (const s of sigs) {
      if (s.err !== null) continue;
      const tx = await this.fetchTx(s.signature);
      const o = tx ? closureOf(tx, r.address) : null;
      if (o?.kind === "settled") {
        return this.update(r.address, {
          state: "settled",
          settle_sig: s.signature,
          outcome: o.outcome,
          payout: o.payout.toString(),
        });
      }
      if (o?.kind === "expired")
        return this.update(r.address, { state: "expired", expire_sig: s.signature });
    }
    const tries = r.detail_tries + 1;
    this.update(r.address, {
      detail_tries: tries,
      ...(tries >= 3 ? { state: "unknown" as const, last_error: "closed, outcome not found" } : {}),
    });
  }

  /** Outcome and payout of a settlement, from its TicketSettled event. */
  private async fillClosure(r: Row, sig: string): Promise<void> {
    const tx = await this.fetchTx(sig as Signature);
    const o = tx ? closureOf(tx, r.address) : null;
    if (o?.kind === "settled")
      this.update(r.address, { outcome: o.outcome, payout: o.payout.toString() });
    else this.update(r.address, { detail_tries: r.detail_tries + 1 });
  }

  private async fetchTx(sig: Signature): Promise<JsonTx | null> {
    const t = await this.rpc
      .getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
        encoding: "json",
      })
      .send();
    return (t as unknown as JsonTx | null) ?? null;
  }

  // --- the sweep ----------------------------------------------------------------------

  private async sweep(): Promise<void> {
    await this.sweepTickets();
    await this.strike();
    await this.claims();
  }

  private programAccounts(discriminator: ArrayLike<number>, size: bigint) {
    return this.rpc
      .getProgramAccounts(PROGRAM, {
        encoding: "base64",
        commitment: "confirmed",
        filters: [
          { dataSize: size },
          {
            memcmp: {
              offset: 0n,
              bytes: b58(discriminator) as Base58EncodedBytes,
              encoding: "base58",
            },
          },
        ],
      })
      .send();
  }

  /** Open or requested tickets that nobody posted. */
  private async sweepTickets(): Promise<void> {
    const accounts = await this.programAccounts(TICKET_DISCRIMINATOR, TICKET_SIZE);
    let added = 0;
    for (const { pubkey, account } of accounts) {
      const w = decodeTicket(decodeBase64(account.data[0]));
      if (!w || w.status === TicketStatus.PayoutPending) continue;
      const r = this.row(pubkey);
      if (r && ACTIVE.includes(r.state)) continue;
      this.track(pubkey, w, "sweep");
      added++;
    }
    if (added) {
      console.log(`sweep: queued ${added} ticket(s)`);
      await this.ensureAlarm(true);
    }
  }

  /** Strikes the live epoch once its close has passed and no ticket opened before it is open. */
  private async strike(): Promise<void> {
    const [queue] = await findQueuePda(cfg);
    const [vault] = await findVaultPda(cfg);
    const { value } = await this.rpc
      .getMultipleAccounts([queue, vault], { encoding: "base64", commitment: "confirmed" })
      .send();
    if (!value[0] || !value[1]) return;
    const q = getQueueDecoder().decode(decodeBase64(value[0].data[0]));
    const p = getVaultDecoder().decode(decodeBase64(value[1].data[0]));
    if (!q.current.live) return;
    if (BigInt(Math.floor(Date.now() / 1000)) < q.current.closeTs) return;
    if (p.openBeforeClose !== 0) {
      console.log(`strike: epoch ${q.current.epochId} closed, ${p.openBeforeClose} ticket(s) open`);
      return;
    }
    const signer = await this.signer();
    const ix = await getStrikeEpochInstructionAsync(
      {
        caller: signer,
        record: await epochPda(q.current.epochId),
        usdcMint: USDC_MINT,
        eventAuthority: await eventAuthority(),
        program: PROGRAM,
      },
      cfg,
    );
    await this.lpSend(ix, `strike_epoch ${q.current.epochId}`);
  }

  /** Claims struck deposit and withdrawal requests, each paid by its CLAIM_FEE. */
  private async claims(): Promise<void> {
    const [deposits, withdraws] = await Promise.all([
      this.programAccounts(DEPOSIT_REQUEST_DISCRIMINATOR, DEPOSIT_REQUEST_SIZE),
      this.programAccounts(WITHDRAW_REQUEST_DISCRIMINATOR, WITHDRAW_REQUEST_SIZE),
    ]);
    if (!deposits.length && !withdraws.length) return;
    const records = new Map<bigint, { address: Address; data: EpochRecord }>();
    for (const { pubkey, account } of await this.programAccounts(
      EPOCH_RECORD_DISCRIMINATOR,
      EPOCH_RECORD_SIZE,
    )) {
      const data = getEpochRecordDecoder().decode(decodeBase64(account.data[0]));
      records.set(data.epochId, { address: pubkey, data });
    }
    const signer = await this.signer();
    const common = { eventAuthority: await eventAuthority(), program: PROGRAM };
    let sent = 0;

    for (const { pubkey, account } of deposits) {
      if (sent >= MAX_CLAIMS_PER_SWEEP) return;
      const d = getDepositRequestDecoder().decode(decodeBase64(account.data[0]));
      const rec = records.get(d.epochId);
      if (d.parked || !rec) continue;
      const [shareMint] = await findShareMintPda(cfg);
      const ix = await getClaimDepositInstructionAsync(
        {
          caller: signer,
          request: pubkey,
          owner: d.owner,
          record: rec.address,
          ownerShares: await ata(d.owner, shareMint),
          rentReceiver: rec.data.rentPayer,
          ...common,
        },
        cfg,
      );
      if (await this.lpSend(ix, `claim_deposit ${pubkey}`)) sent++;
    }

    for (const { pubkey, account } of withdraws) {
      if (sent >= MAX_CLAIMS_PER_SWEEP) return;
      const wr = getWithdrawRequestDecoder().decode(decodeBase64(account.data[0]));
      if (wr.parked) continue;
      const first = wr.rEntry === 0n;
      const entry = records.get(wr.epochId);
      if (first && !entry) continue; // not struck yet
      const chain = first ? (entry as { data: EpochRecord }).data.chainId : wr.chainId;
      const from = first || wr.chainId < wr.epochId ? wr.epochId : wr.chainId;
      // The first record of the chain that ends it or splits it: the claim that pays out.
      let at: { address: Address; data: EpochRecord } | null = null;
      for (const rec of records.values()) {
        const { epochId, chainId, rAfter } = rec.data;
        if (epochId < from || chainId !== chain) continue;
        if (rAfter !== 0n && rAfter >= CHAIN_R_MIN) continue;
        if (!at || epochId < at.data.epochId) at = rec;
      }
      if (!at) continue;
      const withEntry = first && at.data.epochId !== wr.epochId && entry;
      const ix = await getClaimWithdrawInstructionAsync(
        {
          caller: signer,
          request: pubkey,
          owner: wr.owner,
          atRecord: at.address,
          ownerUsdc: await ata(wr.owner, USDC_MINT),
          usdcMint: USDC_MINT,
          rentReceiver: at.data.rentPayer,
          ...(withEntry
            ? { entryRecord: entry.address, entryRentReceiver: entry.data.rentPayer }
            : {}),
          ...common,
        },
        cfg,
      );
      if (await this.lpSend(ix, `claim_withdraw ${pubkey} at epoch ${at.data.epochId}`)) sent++;
    }
  }

  /** Simulates, then sends and waits for an LP transaction. Returns its signature, or null. */
  private async lpSend(ix: Instruction, label: string): Promise<Signature | null> {
    const signer = await this.signer();
    const tx = await build(this.rpc, signer, [ix], UNITS.lp);
    const refused = await simulateBuilt(this.rpc, tx);
    if (refused) {
      console.log(`${label}: not sent, simulation refused: ${refused}`);
      return null;
    }
    await sendWire(this.rpc, tx.wire);
    const sentAt = Date.now();
    let resent = sentAt;
    while (Date.now() - sentAt < 45_000) {
      await sleep(1_500);
      const { value } = await this.rpc.getSignatureStatuses([tx.signature]).send();
      const st = value[0];
      if (st?.err) {
        console.warn(`${label}: failed on chain: ${errorText(st.err)}`);
        return null;
      }
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
        console.log(`${label}: confirmed ${tx.signature}`);
        return tx.signature;
      }
      if (Date.now() - resent > RESEND_EVERY_MS) {
        resent = Date.now();
        await sendWire(this.rpc, tx.wire, true).catch(() => undefined);
      }
    }
    console.warn(`${label}: not confirmed within 45 s (${tx.signature})`);
    return null;
  }

  // --- storage ------------------------------------------------------------------------

  private row(address: string): Row | null {
    return (
      this.sql.exec<Row>("SELECT * FROM tickets WHERE address = ?", address).toArray()[0] ?? null
    );
  }

  private activeCount(): number {
    const r = this.sql
      .exec<{
        n: number;
      }>("SELECT COUNT(*) AS n FROM tickets WHERE state IN ('queued', 'requested', 'fulfilled')")
      .one();
    return r.n;
  }

  /** Starts (or restarts) tracking a ticket found on chain. */
  private track(address: string, w: Ticket, source: string): void {
    const now = Date.now();
    const state: TicketState = w.status === TicketStatus.Requested ? "requested" : "queued";
    const randomness = w.status === TicketStatus.Requested ? w.randomness : null;
    this.sql.exec(
      `INSERT INTO tickets (address, state, source, open_slot, expiry_slot, randomness, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET state = excluded.state, randomness = excluded.randomness,
         attempts = 0, next_try_at = 0, detail_tries = 0, updated_at = excluded.updated_at`,
      address,
      state,
      source,
      w.openSlot.toString(),
      w.expirySlot.toString(),
      randomness,
      now,
      now,
    );
    console.log(`tracking ${address} (${source}, ${state})`);
  }

  private syncFromChain(r: Row, w: Ticket): void {
    const randomness = w.status === TicketStatus.Requested ? w.randomness : null;
    if (r.open_slot === null || (randomness && r.randomness !== randomness)) {
      this.update(r.address, {
        open_slot: w.openSlot.toString(),
        expiry_slot: w.expirySlot.toString(),
        ...(randomness ? { randomness } : {}),
      });
    }
  }

  private setState(r: Row, state: TicketState): void {
    if (r.state !== state) this.update(r.address, { state });
  }

  private update(address: string, fields: Partial<Omit<Row, "address">>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const assignments = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => fields[k] ?? null);
    this.sql.exec(
      `UPDATE tickets SET ${assignments}, updated_at = ? WHERE address = ?`,
      ...values,
      Date.now(),
      address,
    );
  }

  private signer(): Promise<KeyPairSigner> {
    this.signerPromise ??= signerFromSecret(this.env.KEEPER_SECRET_KEY, "KEEPER_SECRET_KEY");
    this.signerPromise.catch(() => {
      this.signerPromise = null;
    });
    return this.signerPromise;
  }
}
