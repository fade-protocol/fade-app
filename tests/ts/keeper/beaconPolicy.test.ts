// The pure rules of the keeper's beacon loop (apps/keeper/src/beaconPolicy.ts):
// its configuration (off until BEACON_ENABLED is set), the automatic
// sponsor's ceiling (Spec 09 §5), the next step of a round in each state, the
// alarm's reading of an expiry, the events it trusts, and its pace.
import {
  SolanaError,
  generateKeyPairSigner,
  getBase58Decoder,
  type Address,
  type Signature,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  RoundStatus,
  getRoundDrawnEventEncoder,
  getRoundExpiredEventEncoder,
  getTicketJoinedEventEncoder,
  type Round,
} from "../../../clients/js/src/generated/fade/index.ts";
import { sponsorshipToCompleteDraw } from "../../../clients/js/src/beacon/index.ts";
import {
  BEACON_ACTIVE_MS,
  BEACON_IDLE_MS,
  BEACON_QUIET_MS,
  BEACON_WAKE_HOLD_MS,
  ALARM_SEVERITY,
  DEFAULT_MIN_BALANCE_LAMPORTS,
  beaconEnabled,
  DEFAULT_SWEEP_MIN_UNITS,
  DEVNET_USDC_MINT,
  EVENT_IX_TAG,
  EXPIRY_ALARM_FAILURES,
  EXPIRY_ALARM_SLOTS,
  FULFILMENT_ALARM_SLOTS,
  REQUEST_ALARM_SLOTS,
  SLOT_MS,
  acceptingWake,
  beaconEventsOf,
  classifyExpiry,
  fulfilmentBase,
  idleTickMs,
  lateAlarm,
  nextAction,
  nextTickMs,
  overdueAlarm,
  ACKNOWLEDGEMENT_REASON_MAX,
  parseAlarmAcknowledgements,
  parseBeaconConfig,
  pausesTickets,
  sponsorAmount,
  sponsorCeiling,
  WAKE_MIN_GAP_MS,
  wakeAlarmAt,
  type JsonTx,
  type RequestState,
  type SponsorPolicy,
} from "../../../apps/keeper/src/beaconPolicy.ts";
import {
  SendRefusedError,
  beaconSigner,
  isSendRefusal,
  rpcChain,
} from "../../../apps/keeper/src/beaconChain.ts";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";

/** A fresh keypair as the Worker's secrets hold one: a JSON array of its 64 bytes. */
function secretKey(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return JSON.stringify([...d, ...x]);
}

const A = "Uqsj2jt3q7xnQxVRGMdYxMQC6ybMkHiAkkf6ere8g4N" as Address;
const B = "GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt" as Address;

/** A round with the SPEC terms of the devnet instance, every other field zero. */
function round(fields: Partial<Round>): Round {
  return {
    discriminator: new Uint8Array(8),
    version: 1,
    bump: 255,
    vrfBump: 255,
    status: RoundStatus.Accepting,
    id: 7n,
    rentPayer: A,
    firstSlot: 1_000n,
    paidSlot: 0n,
    closeSlot: 0n,
    threshold: 8_640_000n,
    drawMax: 5_105_160n,
    roundK: 1,
    minPrice: 500_000n,
    settleShare: 20_000n,
    requestShare: 50_000n,
    tickSlots: 37n,
    refundSlots: 1_715n,
    tSettleSlots: 150n,
    drawdownBps: 1_500n,
    prices: 0n,
    sponsorship: 0n,
    liability: 0n,
    credits: 0n,
    protocolShares: 0n,
    appShares: 0n,
    prepaid: 0n,
    usage: 0n,
    tickets: 0,
    sponsors: 0,
    counted: false,
    side: 0,
    generation: 0,
    randomness: A,
    seed: new Uint8Array(32),
    entropySlot: 0n,
    funded: 0n,
    drawCost: 0n,
    drawnRandomness: new Uint8Array(64),
    lastJoinSlot: 1_000n,
    reserved: new Uint8Array(24),
    ...fields,
  };
}

describe("configuration", () => {
  it("is off until BEACON_ENABLED is set, so the deployed keeper keeps its behaviour", () => {
    expect(parseBeaconConfig({}, B)).toBeNull();
    for (const off of ["", "  ", "false", "0", "yes", "on", "enabled"])
      expect(parseBeaconConfig({ BEACON_ENABLED: off }, B), off).toBeNull();
    // the other variables alone do not turn it on
    expect(parseBeaconConfig({ BEACON_SPONSOR_LAMPORTS_PER_USDC: "6666666" }, B)).toBeNull();
  });

  it('is on for "true" or "1", any case or padding, and runs on the program it is given', () => {
    for (const on of ["true", "1", " TRUE ", "True"]) {
      expect(beaconEnabled({ BEACON_ENABLED: on }), on).toBe(true);
      expect(parseBeaconConfig({ BEACON_ENABLED: on }, B)?.program, on).toBe(B);
    }
    expect(beaconEnabled({})).toBe(false);
  });

  it("defaults: the devnet test mint, no sponsorship, no pushed refunds, sweeps from 0.10 USDC, the cluster's format", () => {
    expect(parseBeaconConfig({ BEACON_ENABLED: "true" }, B)).toEqual({
      program: B,
      usdcMint: DEVNET_USDC_MINT,
      sponsor: null,
      pushRefunds: false,
      sweepMinUnits: DEFAULT_SWEEP_MIN_UNITS,
      format: null,
      minBalanceLamports: DEFAULT_MIN_BALANCE_LAMPORTS,
      acknowledged: [],
      acknowledgementError: null,
    });
    expect(DEFAULT_MIN_BALANCE_LAMPORTS).toBe(100_000_000n);
  });

  it("reads every option", () => {
    const c = parseBeaconConfig(
      {
        BEACON_ENABLED: "1",
        BEACON_USDC_MINT: B,
        BEACON_SPONSOR_LAMPORTS_PER_USDC: "6666666",
        BEACON_SPONSOR_INTEGRATORS: `${A}, ${B}`,
        BEACON_SPONSOR_MAX_LAMPORTS: "3000000",
        BEACON_PUSH_REFUNDS: "true",
        BEACON_SWEEP_MIN_UNITS: "off",
        BEACON_TX_FORMAT: "0",
        BEACON_MIN_BALANCE_LAMPORTS: "250000000",
      },
      B,
    );
    expect(c?.minBalanceLamports).toBe(250_000_000n);
    expect(c?.usdcMint).toBe(B);
    expect(c?.sponsor?.lamportsPerUsdc).toBe(6_666_666n);
    expect([...(c?.sponsor?.ownIntegrators ?? [])]).toEqual([A, B]);
    expect(c?.sponsor?.maxLamports).toBe(3_000_000n);
    expect(c?.pushRefunds).toBe(true);
    expect(c?.sweepMinUnits).toBeNull();
    expect(c?.format).toBe(0);
  });

  it("refuses a value that does not parse rather than running on a default", () => {
    const bad: Record<string, string>[] = [
      { BEACON_ENABLED: "true", BEACON_USDC_MINT: "nope" },
      { BEACON_ENABLED: "true", BEACON_SPONSOR_LAMPORTS_PER_USDC: "-1" },
      { BEACON_ENABLED: "true", BEACON_SPONSOR_LAMPORTS_PER_USDC: "0" },
      { BEACON_ENABLED: "true", BEACON_SPONSOR_LAMPORTS_PER_USDC: "1.5" },
      { BEACON_ENABLED: "true", BEACON_SPONSOR_LAMPORTS_PER_USDC: "18446744073709551616" },
      {
        BEACON_ENABLED: "true",
        BEACON_SPONSOR_LAMPORTS_PER_USDC: "1",
        BEACON_SPONSOR_INTEGRATORS: "x",
      },
      {
        BEACON_ENABLED: "true",
        BEACON_SPONSOR_LAMPORTS_PER_USDC: "1",
        BEACON_SPONSOR_MAX_LAMPORTS: "0",
      },
      { BEACON_ENABLED: "true", BEACON_PUSH_REFUNDS: "yes" },
      { BEACON_ENABLED: "true", BEACON_SWEEP_MIN_UNITS: "0" },
      { BEACON_ENABLED: "true", BEACON_TX_FORMAT: "2" },
      { BEACON_ENABLED: "true", BEACON_MIN_BALANCE_LAMPORTS: "0" },
      { BEACON_ENABLED: "true", BEACON_MIN_BALANCE_LAMPORTS: "0.1" },
    ];
    for (const env of bad) expect(() => parseBeaconConfig(env, B), JSON.stringify(env)).toThrow();
  });
});

describe("the operator's acknowledgements (BEACON_ACKNOWLEDGED_ALARMS)", () => {
  const entry = (fields: Record<string, unknown> = {}) => ({
    round: A,
    kind: "withheld-draw",
    reason: "the keeper was down",
    ...fields,
  });
  const parse = (v: unknown) => parseAlarmAcknowledgements(JSON.stringify(v));

  it("none, and no error, when unset or blank", () => {
    for (const raw of [undefined, "", "  \n"])
      expect(parseAlarmAcknowledgements(raw), String(raw)).toEqual({
        acknowledged: [],
        error: null,
      });
    expect(parse([])).toEqual({ acknowledged: [], error: null });
  });

  it("reads each round and kind with its reason, trimmed", () => {
    expect(
      parse([
        entry({ reason: "  the keeper was down  " }),
        entry({ kind: "expiry-overdue" }),
        entry({ round: B }),
      ]),
    ).toEqual({
      acknowledged: [
        { round: A, kind: "withheld-draw", reason: "the keeper was down" },
        { round: A, kind: "expiry-overdue", reason: "the keeper was down" },
        { round: B, kind: "withheld-draw", reason: "the keeper was down" },
      ],
      error: null,
    });
    const long = "x".repeat(ACKNOWLEDGEMENT_REASON_MAX);
    expect(parse([entry({ reason: long })]).acknowledged[0]?.reason).toBe(long);
  });

  it("ignores the whole list, and says why, on any invalid entry", () => {
    const bad: [raw: string, why: string][] = [
      ["[", "not JSON"],
      [JSON.stringify(entry()), "not a JSON array"],
      ["null", "not a JSON array"],
      [JSON.stringify([entry(), "x"]), "entry 1 is not an object"],
      [JSON.stringify([null]), "entry 0 is not an object"],
      [JSON.stringify([[A, "withheld-draw", "r"]]), "entry 0 is not an object"],
      [JSON.stringify([{ round: A, kind: "withheld-draw" }]), "exactly the keys"],
      [JSON.stringify([entry({ note: "x" })]), "exactly the keys"],
      [JSON.stringify([entry({ round: "nope" })]), "round is not a base58 address"],
      [JSON.stringify([entry({ round: 7 })]), "round is not a base58 address"],
      [JSON.stringify([entry({ round: ` ${A}` })]), "round is not a base58 address"],
      [JSON.stringify([entry({ kind: "withheld" })]), "kind is not an alarm kind"],
      [JSON.stringify([entry({ kind: "toString" })]), "kind is not an alarm kind"],
      [JSON.stringify([entry({ kind: "low-balance" })]), "low-balance"],
      [JSON.stringify([entry({ reason: "" })]), "reason must be a non-empty string"],
      [JSON.stringify([entry({ reason: "   " })]), "reason must be a non-empty string"],
      [JSON.stringify([entry({ reason: 1 })]), "reason must be a non-empty string"],
      [
        JSON.stringify([entry({ reason: "x".repeat(ACKNOWLEDGEMENT_REASON_MAX + 1) })]),
        `longer than ${ACKNOWLEDGEMENT_REASON_MAX}`,
      ],
      [JSON.stringify([entry(), entry({ reason: "again" })]), "entry 1 repeats round"],
    ];
    for (const [raw, why] of bad) {
      const r = parseAlarmAcknowledgements(raw);
      expect(r.acknowledged, raw).toEqual([]);
      expect(r.error, raw).toContain("BEACON_ACKNOWLEDGED_ALARMS ignored");
      expect(r.error, raw).toContain(why);
    }
  });

  it("never stops the loop: parseBeaconConfig carries the list, or why it was ignored", () => {
    const on = { BEACON_ENABLED: "true" };
    const c = parseBeaconConfig(
      { ...on, BEACON_ACKNOWLEDGED_ALARMS: JSON.stringify([entry()]) },
      B,
    );
    expect(c?.acknowledged).toEqual([
      { round: A, kind: "withheld-draw", reason: "the keeper was down" },
    ]);
    expect(c?.acknowledgementError).toBeNull();
    const bad = parseBeaconConfig({ ...on, BEACON_ACKNOWLEDGED_ALARMS: "[{" }, B);
    expect(bad?.program).toBe(B);
    expect(bad?.acknowledged).toEqual([]);
    expect(bad?.acknowledgementError).toContain("not JSON");
  });

  it("the deployed list parses: round 7's withheld draw, a reviewed false positive", () => {
    const wrangler = readFileSync(
      new URL("../../../apps/keeper/wrangler.jsonc", import.meta.url),
      "utf8",
    );
    const raw = /"BEACON_ACKNOWLEDGED_ALARMS": (".*"),/.exec(wrangler)?.[1];
    expect(raw).toBeDefined();
    const { acknowledged, error } = parseAlarmAcknowledgements(JSON.parse(raw!) as string);
    expect(error).toBeNull();
    expect(acknowledged.map((a) => [a.round, a.kind])).toEqual([
      ["DvRPRsUZYeQmZy7xDhpeNKom1WGwf4JVpTYXbyaamEGw", "withheld-draw"],
    ]);
  });
});

describe("the automatic sponsor (Spec 09 §5)", () => {
  const policy = (p: Partial<SponsorPolicy> = {}): SponsorPolicy => ({
    lamportsPerUsdc: 6_666_666n,
    ownIntegrators: new Set(),
    maxLamports: null,
    ...p,
  });

  it("spends at most the protocol's shares of the round, valued and rounded down", () => {
    const r = round({ protocolShares: 14_000n });
    // 0.014 USDC at 6 666 666 lamports a USDC: 93 333.324, floored
    expect(sponsorCeiling(r, [], policy())).toBe(93_333n);
  });

  it("adds the app shares of its own integrators only", () => {
    const r = round({ protocolShares: 14_000n, appShares: 70_000n });
    const tickets = [
      { integrator: A, appShare: 35_000n },
      { integrator: B, appShare: 35_000n },
    ];
    expect(sponsorCeiling(r, tickets, policy())).toBe(93_333n);
    expect(sponsorCeiling(r, tickets, policy({ ownIntegrators: new Set([A]) }))).toBe(
      ((14_000n + 35_000n) * 6_666_666n) / 1_000_000n,
    );
    expect(sponsorCeiling(r, tickets, policy({ maxLamports: 10n }))).toBe(10n);
  });

  it("sponsors only an accepting round, only the exact amount that pays it, once, and never above its ceiling", () => {
    const accepting = round({ prices: 6_950_000n, protocolShares: 13_900n });
    const missing = sponsorshipToCompleteDraw(accepting);
    expect(missing).toBeGreaterThan(0n);
    const exact = policy({ lamportsPerUsdc: (missing * 1_000_000n) / 13_900n + 1n });
    expect(sponsorCeiling(accepting, [], exact)).toBeGreaterThanOrEqual(missing);
    expect(sponsorAmount(accepting, [], exact, false)).toBe(missing);
    // one lamport short of the ceiling: nothing
    expect(
      sponsorAmount(accepting, [], policy({ ...exact, maxLamports: missing - 1n }), false),
    ).toBeNull();
    expect(sponsorAmount(accepting, [], policy({ ...exact, maxLamports: missing }), false)).toBe(
      missing,
    );
    // already sponsored by the keeper, or no policy: nothing
    expect(sponsorAmount(accepting, [], exact, true)).toBeNull();
    expect(sponsorAmount(accepting, [], null, false)).toBeNull();
    // any other status: nothing, whatever the ceiling
    for (const status of [
      RoundStatus.Paid,
      RoundStatus.Requested,
      RoundStatus.Drawn,
      RoundStatus.Refunded,
      RoundStatus.Forfeited,
    ])
      expect(sponsorAmount({ ...accepting, status }, [], exact, false)).toBeNull();
  });
});

describe("the next step of a round", () => {
  const o = { sponsor: false, pushRefunds: false };
  const paid = round({ status: RoundStatus.Paid, paidSlot: 2_000n, closeSlot: 2_035n, tickets: 3 });
  const act = (r: Round, slot: bigint, req: RequestState = "absent", opts = o) =>
    nextAction(r, slot, req, opts).kind;

  it("an accepting round waits, or is considered for sponsorship", () => {
    expect(act(round({}), 5_000n)).toBe("wait");
    expect(act(round({}), 5_000n, "absent", { ...o, sponsor: true })).toBe("sponsor");
  });

  it("a paid round is requested from close_slot + 2 to close_slot + t_settle_slots", () => {
    expect(nextAction(paid, 2_036n, "absent", o)).toEqual({ kind: "wait", untilSlot: 2_037n });
    expect(act(paid, 2_037n)).toBe("request");
    expect(act(paid, 2_035n + 150n)).toBe("request");
    // past the window: expired, unless a request someone created is fulfilled, bound late
    for (const req of ["absent", "pending", "zero"] as const)
      expect(act(paid, 2_035n + 151n, req)).toBe("expire");
    expect(act(paid, 2_035n + 151n, "fulfilled")).toBe("late-bind");
  });

  it("a requested round is settled once fulfilled, expired only past its window", () => {
    const r = { ...paid, status: RoundStatus.Requested };
    expect(act(r, 2_040n, "pending")).toBe("wait");
    expect(act(r, 2_040n, "zero")).toBe("wait");
    expect(act(r, 2_040n, "fulfilled")).toBe("settle");
    expect(act(r, 2_186n, "fulfilled")).toBe("settle");
    expect(act(r, 2_186n, "pending")).toBe("expire");
    expect(act(r, 2_186n, "zero")).toBe("expire");
  });

  it("a drawn round is settled to its last ticket, then its sponsorships reclaimed", () => {
    const r = { ...paid, status: RoundStatus.Drawn };
    expect(act(r, 9_999n)).toBe("settle");
    expect(act({ ...r, tickets: 0, sponsors: 2 }, 9_999n)).toBe("reclaim");
    expect(act({ ...r, tickets: 0, sponsors: 0 }, 9_999n)).toBe("done");
  });

  it("a forfeited round's tickets are returned (their settlement share pays it), then reclaimed", () => {
    const r = { ...paid, status: RoundStatus.Forfeited };
    expect(act(r, 9_999n)).toBe("return");
    expect(act({ ...r, tickets: 0, sponsors: 1 }, 9_999n)).toBe("reclaim");
  });

  it("a refunded round is left to its players and sponsors unless pushing is configured", () => {
    const r = { ...paid, status: RoundStatus.Refunded, sponsors: 1 };
    expect(act(r, 9_999n)).toBe("done");
    expect(act(r, 9_999n, "absent", { ...o, pushRefunds: true })).toBe("return");
    expect(act({ ...r, tickets: 0 }, 9_999n, "absent", { ...o, pushRefunds: true })).toBe(
      "reclaim",
    );
  });
});

describe("the alarm", () => {
  it("only a round nobody requested, checked and found without a request, is a keepers' failure", () => {
    const cases: [boolean, boolean, boolean, string][] = [
      // requested, requestFound, checked
      [false, false, true, "unrequested-expiry"],
      [false, true, true, "withheld-draw"], // someone created the request and did not bind it
      [false, false, false, "withheld-draw"], // too late to look
      [false, true, false, "withheld-draw"],
      [true, true, true, "withheld-draw"], // requested, never fulfilled
      [true, false, true, "withheld-draw"],
      [true, true, false, "withheld-draw"],
      [true, false, false, "withheld-draw"],
    ];
    for (const [requested, requestFound, checked, kind] of cases)
      expect(classifyExpiry({ requested, requestFound, checked })).toBe(kind);
  });

  it("warns before an expiry: an unrequested paid round, an unfulfilled request", () => {
    const paid = round({ status: RoundStatus.Paid, closeSlot: 2_000n });
    expect(lateAlarm(paid, 2_000n + REQUEST_ALARM_SLOTS, "absent")).toBeNull();
    expect(lateAlarm(paid, 2_001n + REQUEST_ALARM_SLOTS, "absent")).toBe("request-late");
    const requested = round({
      status: RoundStatus.Requested,
      closeSlot: 2_000n,
      entropySlot: 2_001n,
    });
    expect(lateAlarm(requested, 2_001n + FULFILMENT_ALARM_SLOTS, "pending")).toBeNull();
    expect(lateAlarm(requested, 2_002n + FULFILMENT_ALARM_SLOTS, "pending")).toBe(
      "fulfilment-late",
    );
    expect(lateAlarm(requested, 2_002n + FULFILMENT_ALARM_SLOTS, "zero")).toBe("fulfilment-late");
    // fulfilled (a late binding): not late
    expect(lateAlarm(requested, 2_002n + FULFILMENT_ALARM_SLOTS, "fulfilled")).toBeNull();
    expect(FULFILMENT_ALARM_SLOTS).toBeLessThan(150n);
    expect(lateAlarm(round({}), 1_000_000n, "absent")).toBeNull();
  });

  it("counts a late fulfilment from the slot the request landed, never before the entropy slot", () => {
    const requested = round({
      status: RoundStatus.Requested,
      closeSlot: 2_000n,
      entropySlot: 2_001n,
    });
    // Requested at close + 100, after a keeper outage: ORAO is not late 61 slots after the
    // entropy slot, only 61 slots after the request.
    const at = 2_100n;
    expect(fulfilmentBase(requested, at)).toBe(at);
    expect(lateAlarm(requested, 2_002n + FULFILMENT_ALARM_SLOTS, "pending", at)).toBeNull();
    expect(lateAlarm(requested, at + FULFILMENT_ALARM_SLOTS, "pending", at)).toBeNull();
    expect(lateAlarm(requested, at + 1n + FULFILMENT_ALARM_SLOTS, "pending", at)).toBe(
      "fulfilment-late",
    );
    // The request slot unknown: from the entropy slot (fail closed).
    expect(fulfilmentBase(requested, null)).toBe(2_001n);
    expect(lateAlarm(requested, 2_002n + FULFILMENT_ALARM_SLOTS, "pending", null)).toBe(
      "fulfilment-late",
    );
    // A request slot before the entropy slot is not one: the entropy slot.
    expect(fulfilmentBase(requested, 1_990n)).toBe(2_001n);
    expect(lateAlarm(requested, 2_002n + FULFILMENT_ALARM_SLOTS, "pending", 1_990n)).toBe(
      "fulfilment-late",
    );
  });

  it("pauses on every critical alarm: a withheld draw, a late fulfilment (Spec 02 §3), an overdue expiry", () => {
    expect(Object.entries(ALARM_SEVERITY).filter(([k]) => pausesTickets(k as never))).toEqual([
      ["withheld-draw", "critical"],
      ["fulfilment-late", "critical"],
      ["expiry-overdue", "critical"],
    ]);
    // a keepers' failure, a late request and a low balance page nobody to pause
    expect(pausesTickets("unrequested-expiry")).toBe(false);
    expect(pausesTickets("request-late")).toBe(false);
    expect(pausesTickets("low-balance")).toBe(false);
  });

  it("an expiry is overdue on refusals, or for a requested round long past it", () => {
    const at = { closeSlot: 2_000n, tSettleSlots: 150n };
    const expiry = 2_151n; // the first slot `expire_round` accepts
    const paid = round({ status: RoundStatus.Paid, ...at });
    const requested = round({ status: RoundStatus.Requested, ...at });
    // refusals count only once the round has expired
    expect(overdueAlarm(paid, expiry - 1n, 10)).toBeNull();
    expect(overdueAlarm(paid, expiry, EXPIRY_ALARM_FAILURES - 1)).toBeNull();
    expect(overdueAlarm(paid, expiry, EXPIRY_ALARM_FAILURES)).toBe("expiry-overdue");
    expect(overdueAlarm(requested, expiry, EXPIRY_ALARM_FAILURES)).toBe("expiry-overdue");
    // a paid round left unexpired by a keeper that was down: its keepers' failure, no pause
    expect(overdueAlarm(paid, expiry + 10_000n, 0)).toBeNull();
    // a requested round still there long after its expiry, whatever the keeper tried
    expect(overdueAlarm(requested, 2_150n + EXPIRY_ALARM_SLOTS, 0)).toBeNull();
    expect(overdueAlarm(requested, 2_151n + EXPIRY_ALARM_SLOTS, 0)).toBe("expiry-overdue");
    for (const status of [
      RoundStatus.Accepting,
      RoundStatus.Drawn,
      RoundStatus.Forfeited,
      RoundStatus.Refunded,
    ])
      expect(overdueAlarm(round({ status, ...at }), 1_000_000n, 99)).toBeNull();
  });
});

describe("the beacon's key", () => {
  it("is its own: required, and never the direct path's keeper key", async () => {
    const keeper = secretKey();
    const own = secretKey();
    await expect(beaconSigner({ KEEPER_SECRET_KEY: keeper })).rejects.toThrow(/BEACON_SECRET_KEY/);
    await expect(
      beaconSigner({ KEEPER_SECRET_KEY: keeper, BEACON_SECRET_KEY: keeper }),
    ).rejects.toThrow(/must not be/);
    const signer = await beaconSigner({ KEEPER_SECRET_KEY: keeper, BEACON_SECRET_KEY: own });
    expect(signer.address).toBe(
      (await beaconSigner({ BEACON_SECRET_KEY: own, KEEPER_SECRET_KEY: secretKey() })).address,
    );
  });
});

describe("events", () => {
  const program = A;
  const authority = B;
  const b58 = getBase58Decoder();
  const eventIx = (body: Uint8Array) => b58.decode(Uint8Array.from([...EVENT_IX_TAG, ...body]));

  async function txWith(
    instructions: { programIdIndex: number; accounts: number[]; data: string }[],
    err: unknown = null,
  ): Promise<JsonTx> {
    const payer = (await generateKeyPairSigner()).address;
    return {
      meta: { err, innerInstructions: [{ instructions }] },
      transaction: { message: { accountKeys: [payer, program, authority] } },
    };
  }

  it("reads an emit_cpi! event signed by the program's event authority", async () => {
    const roundAddr = (await generateKeyPairSigner()).address;
    const body = new Uint8Array(
      getRoundExpiredEventEncoder().encode({
        version: 1,
        round: roundAddr,
        requested: false,
        requestFound: false,
        checked: true,
        tickets: 2,
        forfeited: 1n,
        drawCost: 0n,
        refund: 0n,
        side: 1,
        generation: 3,
        forfeitsWithheld: 0n,
        refunded: false,
      }),
    );
    const tx = await txWith([{ programIdIndex: 1, accounts: [2], data: eventIx(body) }]);
    const events = beaconEventsOf(tx, program, authority);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("expired");
    expect(events[0]?.round).toBe(roundAddr);
  });

  it("reads RoundDrawn: a gone round that was drawn has no expiry to look for", async () => {
    const roundAddr = (await generateKeyPairSigner()).address;
    const body = new Uint8Array(
      getRoundDrawnEventEncoder().encode({
        version: 1,
        round: roundAddr,
        drawCost: 1n,
        refund: 2n,
      }),
    );
    const tx = await txWith([{ programIdIndex: 1, accounts: [2], data: eventIx(body) }]);
    expect(beaconEventsOf(tx, program, authority)).toEqual([{ kind: "drawn", round: roundAddr }]);
  });

  it("ignores an event another program emits, one without the event authority, and a failed transaction's", async () => {
    const t = await generateKeyPairSigner();
    const body = new Uint8Array(
      getTicketJoinedEventEncoder().encode({
        version: 1,
        ticket: t.address,
        round: t.address,
        integrator: t.address,
        nonce: 0n,
        beneficiary: t.address,
        refundTo: t.address,
        payoutTable: t.address,
        price: 1n,
        vaultCredit: 1n,
        payoutMax: 1n,
        reservedLiability: 1n,
        cap: 1n,
        usage: 1n,
        protocolShare: 0n,
        appShare: 0n,
        prepay: 0n,
        slot: 0n,
        payer: t.address,
        funder: t.address,
        settleShare: 0n,
      }),
    );
    const data = eventIx(body);
    expect(
      beaconEventsOf(
        await txWith([{ programIdIndex: 1, accounts: [2], data }]),
        program,
        authority,
      ),
    ).toHaveLength(1);
    // another program
    expect(
      beaconEventsOf(
        await txWith([{ programIdIndex: 0, accounts: [2], data }]),
        program,
        authority,
      ),
    ).toHaveLength(0);
    // the program, but not through its event authority
    expect(
      beaconEventsOf(
        await txWith([{ programIdIndex: 1, accounts: [0], data }]),
        program,
        authority,
      ),
    ).toHaveLength(0);
    expect(
      beaconEventsOf(await txWith([{ programIdIndex: 1, accounts: [], data }]), program, authority),
    ).toHaveLength(0);
    // a failed transaction
    expect(
      beaconEventsOf(
        await txWith([{ programIdIndex: 1, accounts: [2], data }], { InstructionError: [0, "x"] }),
        program,
        authority,
      ),
    ).toHaveLength(0);
    // not an event, and garbage
    expect(
      beaconEventsOf(
        await txWith([{ programIdIndex: 1, accounts: [2], data: b58.decode(body) }]),
        program,
        authority,
      ),
    ).toHaveLength(0);
    expect(
      beaconEventsOf(
        await txWith([{ programIdIndex: 1, accounts: [2], data: eventIx(body.subarray(0, 20)) }]),
        program,
        authority,
      ),
    ).toHaveLength(0);
  });
});

describe("a refusal at send", () => {
  it("switches to v0 only for a refusal of the format itself, never for a preflight or a blockhash", () => {
    expect(new SendRefusedError("Transaction version (1) is not supported", []).byFormat).toBe(
      true,
    );
    expect(new SendRefusedError("transaction too large: 2265 > 1232", []).byFormat).toBe(true);
    expect(new SendRefusedError("failed to deserialize transaction", []).byFormat).toBe(true);
    expect(new SendRefusedError("Blockhash not found", []).byFormat).toBe(false);
    expect(new SendRefusedError("insufficient funds for fee", []).byFormat).toBe(false);
    // a preflight that ran, whatever its message
    expect(
      new SendRefusedError("invalid transaction: version", ["Program log: Error Code: X"]).byFormat,
    ).toBe(false);
  });
});

describe("a send's answer", () => {
  const code = (c: number) => new SolanaError(c as never, {} as never);
  it("is a refusal only for a JSON-RPC error that certainly did not forward the transaction", () => {
    expect(isSendRefusal(code(-32002))).toBe(true); // a failed preflight
    expect(isSendRefusal(code(-32602))).toBe(true); // invalid params (a version, an encoding)
    expect(isSendRefusal(code(-32005))).toBe(true); // a node that refuses while unhealthy
    expect(isSendRefusal(code(-32603))).toBe(false); // internal: a proxy may have forwarded it
    expect(isSendRefusal(code(8_100_002))).toBe(false); // the HTTP transport's own error
    expect(isSendRefusal(new Error("fetch failed"))).toBe(false);
    expect(isSendRefusal(new TypeError("network error"))).toBe(false);
  });

  it("rpcChain throws SendRefusedError only for a refusal, any other error as is", async () => {
    const rpcThrowing = (e: unknown) => ({
      sendTransaction: () => ({
        send: () => Promise.reject(e),
      }),
    });
    await expect(rpcChain(rpcThrowing(code(-32002))).send("AA==", false)).rejects.toBeInstanceOf(
      SendRefusedError,
    );
    const timeout = new Error("The operation timed out");
    await expect(rpcChain(rpcThrowing(timeout)).send("AA==", false)).rejects.toBe(timeout);
    const internal = code(-32603);
    await expect(rpcChain(rpcThrowing(internal)).send("AA==", false)).rejects.toBe(internal);
  });

  it("rpcChain reads a transaction once when it is not served, and in v0 only when v1 is refused", async () => {
    const asked: number[] = [];
    const rpc = (answer: (version: number) => Promise<unknown>) => ({
      getTransaction: (_s: unknown, o: { maxSupportedTransactionVersion: number }) => ({
        send: () => {
          asked.push(o.maxSupportedTransactionVersion);
          return answer(o.maxSupportedTransactionVersion);
        },
      }),
    });
    const sig = "1".repeat(64) as Signature;
    // Not served (yet): one call, not a second one in v0.
    expect(await rpcChain(rpc(async () => null)).transaction(sig)).toBeNull();
    expect(asked).toEqual([1]);
    // An RPC that refuses the version-1 parameter: asked again in v0.
    asked.length = 0;
    const tx = { slot: 5n, meta: { err: null }, transaction: { message: { accountKeys: [] } } };
    const refusing = rpc(async (v) => {
      if (v === 1) throw new Error("invalid params: maxSupportedTransactionVersion");
      return tx;
    });
    expect(await rpcChain(refusing).transaction(sig)).toBe(tx);
    expect(asked).toEqual([1, 0]);
    // Both refused: not served, as before.
    asked.length = 0;
    const failing = rpc(async () => {
      throw new Error("unavailable");
    });
    expect(await rpcChain(failing).transaction(sig)).toBeNull();
    expect(asked).toEqual([1, 0]);
  });

  it("a preflight that finds the transaction already processed is not a refusal of it", () => {
    expect(
      new SendRefusedError("This transaction has already been processed", []).alreadyProcessed,
    ).toBe(true);
    expect(new SendRefusedError("Blockhash not found", []).alreadyProcessed).toBe(false);
  });
});

describe("pace", () => {
  it("wakes for an accepting round holding a ticket or a sponsorship when its request could first open", () => {
    const accepting = round({ status: RoundStatus.Accepting, tickSlots: 37n, tickets: 1 });
    // paid at 100 at the earliest: closes at 111, requested from 113
    expect(acceptingWake(accepting, 100n)).toBe(113n);
    // on a boundary: a payment from 111 closes at 148
    expect(acceptingWake(accepting, 111n)).toBe(150n);
    expect(acceptingWake({ ...accepting, tickets: 0, sponsorship: 1n }, 100n)).toBe(113n);
    expect(acceptingWake({ ...accepting, tickets: 0 }, 100n)).toBeNull();
    expect(acceptingWake({ ...accepting, status: RoundStatus.Paid }, 100n)).toBeNull();
    expect(nextTickMs(100n, [acceptingWake(accepting, 100n)!], false)).toBe(12 * SLOT_MS);
  });

  it("ticks fast while busy, at a round's request slot, idle otherwise", () => {
    expect(nextTickMs(100n, [], true)).toBe(BEACON_ACTIVE_MS);
    expect(nextTickMs(100n, [], true, BEACON_QUIET_MS)).toBe(BEACON_ACTIVE_MS);
    // nothing to wait for: the quiet pace unless told otherwise
    expect(nextTickMs(100n, [], false)).toBe(BEACON_QUIET_MS);
    expect(nextTickMs(100n, [], false, BEACON_IDLE_MS)).toBe(BEACON_IDLE_MS);
    // ten slots ahead: woken one slot early, whatever the idle pace
    expect(nextTickMs(100n, [110n], false)).toBe(9 * SLOT_MS);
    expect(nextTickMs(100n, [110n], false, BEACON_IDLE_MS)).toBe(9 * SLOT_MS);
    // already due
    expect(nextTickMs(100n, [99n], false)).toBe(BEACON_ACTIVE_MS);
    // far ahead: idle at most
    expect(nextTickMs(100n, [100_000n], false)).toBe(BEACON_QUIET_MS);
    expect(nextTickMs(100n, [100_000n], false, BEACON_IDLE_MS)).toBe(BEACON_IDLE_MS);
  });

  it("idles at 5 s for a minute after a wake, at the quiet pace otherwise", () => {
    const now = 10_000_000;
    expect(idleTickMs(now, 0)).toBe(BEACON_QUIET_MS);
    expect(idleTickMs(now, now)).toBe(BEACON_IDLE_MS);
    expect(idleTickMs(now, now - BEACON_WAKE_HOLD_MS + 1)).toBe(BEACON_IDLE_MS);
    expect(idleTickMs(now, now - BEACON_WAKE_HOLD_MS)).toBe(BEACON_QUIET_MS);
  });

  it("keeps the quiet pace inside the program's windows", () => {
    // Config defaults: the request window closes 150 slots after the close; Spec 02 §3 leaves
    // ORAO 60 of them. Worst case: a join nobody announced pays its round one slot before its
    // close, just after a tick; it is seen a quiet period and a tick later, then two
    // transactions (record_round_entropy, request_round_draw) of about 3 s each land.
    const tSettle = 150;
    const oraoMargin = Number(FULFILMENT_ALARM_SLOTS);
    const slots = (ms: number) => Math.ceil(ms / SLOT_MS);
    const requestedBy = slots(BEACON_QUIET_MS) + slots(1_000) + 2 * slots(3_000);
    expect(requestedBy).toBeLessThanOrEqual(tSettle - oraoMargin);
    // well inside the ~512 slots SlotHashes keeps the entropy slot
    expect(requestedBy).toBeLessThan(512 - 2);
    // the idle pace is no slower than the quiet one, and the active one is the fastest
    expect(BEACON_ACTIVE_MS).toBeLessThan(BEACON_IDLE_MS);
    expect(BEACON_IDLE_MS).toBeLessThan(BEACON_QUIET_MS);
  });

  it("pulls the next tick forward on a wake, at most one tick per WAKE_MIN_GAP_MS", () => {
    const now = 1_000_000;
    // no tick for a while: now
    expect(wakeAlarmAt(now, null, 0)).toBe(now);
    expect(wakeAlarmAt(now, now + BEACON_QUIET_MS, 0)).toBe(now);
    expect(wakeAlarmAt(now, now + BEACON_ACTIVE_MS + 1, now - WAKE_MIN_GAP_MS)).toBe(now);
    // already due within the active pace, or in the past (fires at once): left alone
    expect(wakeAlarmAt(now, now + BEACON_ACTIVE_MS, 0)).toBeNull();
    expect(wakeAlarmAt(now, now, 0)).toBeNull();
    expect(wakeAlarmAt(now, now - 5_000, 0)).toBeNull();
    // a tick started 500 ms ago: the wake's tick waits for the gap
    expect(wakeAlarmAt(now, now + BEACON_QUIET_MS, now - 500)).toBe(now - 500 + WAKE_MIN_GAP_MS);
    // a burst: once set, every later wake before it leaves it
    const at = wakeAlarmAt(now, now + BEACON_QUIET_MS, now - 500)!;
    expect(wakeAlarmAt(now + 100, at, now - 500)).toBeNull();
  });
});
