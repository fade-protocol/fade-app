// The shared beacon's Durable Object: one instance runs
// beaconEngine.ts on its alarm, its state in the object's SQLite storage.
// It runs on the keeper's program (PROGRAM, which carries both the direct
// path and the beacon) and does nothing until BEACON_ENABLED turns it on:
// without it the alarm is never set and GET /v1/beacon answers `{ "enabled": false }`, so the
// deployed keeper keeps its behaviour. It signs with a key of its own
// (BEACON_SECRET_KEY, refused when it is KEEPER_SECRET_KEY), so that its
// spends never touch the SOL the direct path settles with, and reads the
// same RPC.
import { DurableObject } from "cloudflare:workers";
import type { KeyPairSigner } from "@solana/kit";
import { DEFAULT_RPC_URL, PROGRAM, describeError, makeRpc } from "./chain.ts";
import { beaconSigner, rpcChain } from "./beaconChain.ts";
import { BeaconEngine, type BeaconHealth, type Sql } from "./beaconEngine.ts";
import {
  BEACON_IDLE_MS,
  guardedTick,
  parseBeaconConfig,
  wakeAlarmAt,
  type BeaconConfig,
} from "./beaconPolicy.ts";
import type { Env } from "./index.ts";

/** An alarm this far in the past is dead; the cron trigger replaces it. */
const STALE_ALARM_MS = 60_000;
/**
 * A tick still running after this long is abandoned: the alarm ends, records why
 * and sets the next one, so that one call that never returns cannot stop the loop.
 */
const TICK_DEADLINE_MS = 90_000;

/** The last tick that failed or was abandoned, while no tick has completed since. */
export type BeaconTickError = { at: number; message: string };

export type BeaconStatus =
  | ({ enabled: true; lastError: BeaconTickError | null } & BeaconHealth)
  | { enabled: false; error?: string };

export class BeaconKeeper extends DurableObject<Env> {
  private engine: Promise<BeaconEngine> | null = null;
  private lastError: BeaconTickError | null = null;
  /** When the last tick started (memory only: lost with a hibernation, when no tick is near). */
  private lastTickAt = 0;
  /** The tick in progress, abandoned or not (`guardedTick`). */
  private readonly ticking: { running: Promise<number> | null } = { running: null };
  private readonly config: BeaconConfig | null;
  private readonly configError: string | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    let config: BeaconConfig | null = null;
    let error: string | null = null;
    try {
      config = parseBeaconConfig(env, PROGRAM);
    } catch (e) {
      error = describeError(e);
      console.error(`beacon: configuration refused: ${error}`);
    }
    this.config = config;
    this.configError = error;
  }

  private start(config: BeaconConfig): Promise<BeaconEngine> {
    this.engine ??= (async () => {
      const signer: KeyPairSigner = await beaconSigner(this.env);
      const storage = this.ctx.storage.sql;
      const sql: Sql = {
        exec: <T>(q: string, ...b: (string | number | null)[]) =>
          storage.exec(q, ...b).toArray() as T[],
      };
      return new BeaconEngine(
        rpcChain(makeRpc(this.env.RPC_URL || DEFAULT_RPC_URL)),
        signer,
        sql,
        config,
      );
    })();
    this.engine.catch(() => {
      this.engine = null;
    });
    return this.engine;
  }

  async status(): Promise<BeaconStatus> {
    if (!this.config)
      return this.configError ? { enabled: false, error: this.configError } : { enabled: false };
    await this.ensureAlarm();
    try {
      return {
        enabled: true,
        lastError: this.lastError,
        ...(await this.start(this.config)).health(),
      };
    } catch (e) {
      return { enabled: false, error: describeError(e) };
    }
  }

  /** Called by the cron trigger: starts the loop once configured, restarts a lost alarm. */
  async ensureAlarm(): Promise<void> {
    if (!this.config) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current < Date.now() - STALE_ALARM_MS)
      await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * POST /v1/beacon/wake: a join just confirmed. Records the wake (the loop
   * keeps its 5 s pace for a minute, `BeaconEngine.wake`) and pulls the next
   * tick forward (`wakeAlarmAt`: now, never sooner than 2 s after the last
   * tick started). It changes no round state and takes no input: the tick
   * reads the chain. False while the beacon is off.
   */
  async wake(): Promise<boolean> {
    if (!this.config) return false;
    (await this.start(this.config)).wake();
    const at = wakeAlarmAt(Date.now(), await this.ctx.storage.getAlarm(), this.lastTickAt);
    if (at !== null) await this.ctx.storage.setAlarm(at);
    return true;
  }

  override async alarm(): Promise<void> {
    if (!this.config) return;
    this.lastTickAt = Date.now();
    // A failed or abandoned tick is tried again at the 5 s pace: it may have left a round unworked.
    let delay = BEACON_IDLE_MS;
    try {
      delay = await guardedTick(
        this.ticking,
        async () => (await this.start(this.config!)).tick(),
        TICK_DEADLINE_MS,
      );
      this.lastError = null;
    } catch (e) {
      this.lastError = { at: Date.now(), message: describeError(e) };
      console.error(`beacon tick failed: ${this.lastError.message}`);
    } finally {
      // An alarm set while the tick ran (a wake) is kept when it is the sooner one.
      const target = Date.now() + delay;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > target) await this.ctx.storage.setAlarm(target);
    }
  }
}
