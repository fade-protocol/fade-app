// The keeper's direct-path decisions (apps/keeper/src/directPolicy.ts): what it sends for a
// ticket it read, after the audit fixes of 22 October 2026, and the reconciliation of
// `Vault.ticket_forfeits_withheld` with the expiries it read.
import { describe, expect, it } from "vitest";
import { address, getAddressEncoder, type Address } from "@solana/kit";
import {
  TicketStatus,
  findVrfPayerPda,
  type Ticket,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  ORAO_RANDOMNESS_V1_DISCRIMINATOR,
  ORAO_RANDOMNESS_V2_DISCRIMINATOR,
  ORAO_VRF_PROGRAM_ADDRESS,
} from "../../../clients/js/src/beacon/index.ts";
import { ticketRequestAddress } from "../../../clients/js/src/direct/index.ts";
import { FADE_PROGRAM_ADDRESS } from "../../../clients/js/src/generated/fade/programs/index.ts";
import {
  DIRECT_ALARMS_LISTED,
  beaconPauseOf,
  combinedPause,
  directAlarm,
  directStep,
  expiryRequestToRead,
  parseWithheldAcknowledgements,
  unaccountedDirectWithheld,
  withheldOrdinal,
} from "../../../apps/keeper/src/directPolicy.ts";

const TICKET = address("SysvarRent111111111111111111111111111111111");
const BOUND = address("SysvarC1ock11111111111111111111111111111111");
// A deployment other than the generated client's default: the seed hashes the program id, so a
// policy that drops the config derives a request address nobody makes and these tests fail.
const CFG = { programAddress: address("GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt") };

function slotHashes(from: bigint, to: bigint): Uint8Array {
  const n = Number(to - from + 1n);
  const d = new Uint8Array(8 + n * 40);
  const view = new DataView(d.buffer);
  view.setBigUint64(0, BigInt(n), true);
  for (let i = 0; i < n; i++) {
    const s = to - BigInt(i);
    view.setBigUint64(8 + i * 40, s, true);
    d.fill(Number(s % 251n), 16 + i * 40, 48 + i * 40);
  }
  return d;
}

function ticket(overrides: Partial<Ticket> = {}): { address: Address; data: Ticket } {
  return {
    address: TICKET,
    data: {
      status: TicketStatus.Open,
      openSlot: 1_000n,
      expirySlot: 1_150n,
      entropySlot: 0n,
      seed: new Uint8Array(32),
      randomness: BOUND,
      ...overrides,
    } as Ticket,
  };
}

/** A `RandomnessV2` request at `address`, its rent paid by `client` (bytes 9..41). */
function orao(address: Address, state: "pending" | "zero" | "drawn", client?: Address) {
  const data = new Uint8Array(state === "pending" ? 749 : 137);
  data.set(ORAO_RANDOMNESS_V2_DISCRIMINATOR, 0);
  if (client) data.set(getAddressEncoder().encode(client), 9);
  if (state !== "pending") {
    data[8] = 1;
    if (state === "drawn") data.fill(9, 73, 137);
  }
  return { address, owner: ORAO_VRF_PROGRAM_ADDRESS, data };
}

describe("an Open ticket", () => {
  const live = slotHashes(990n, 1_200n);

  it("derives its request for the deployment the keeper serves", async () => {
    expect(CFG.programAddress).not.toBe(FADE_PROGRAM_ADDRESS);
    const served = await ticketRequestAddress(ticket(), live, CFG);
    const generated = await ticketRequestAddress(ticket(), live);
    expect(served!.request).not.toBe(generated!.request);
    expect(await expiryRequestToRead(ticket(), 1_151n, live, CFG)).toBe(served!.request);
    expect(await directStep(ticket(), 1_002n, live, null, CFG)).toMatchObject({
      request: served!.request,
    });
  });

  it("is requested in its window, from open_slot + 2", async () => {
    expect(await directStep(ticket(), 1_001n, slotHashes(990n, 1_000n), null, CFG)).toEqual({
      kind: "wait",
    });
    const found = await ticketRequestAddress(ticket(), live, CFG);
    expect(await directStep(ticket(), 1_002n, live, null, CFG)).toEqual({
      kind: "request",
      request: found!.request,
      record: true,
    });
  });

  it("records its seed alone ahead of a request only while the seed is not recorded", async () => {
    const found = await ticketRequestAddress(ticket(), live, CFG);
    const recorded = ticket({ entropySlot: 1_001n, seed: found!.seed });
    const step = await directStep(recorded, 1_100n, live, null, CFG);
    expect(step).toMatchObject({ kind: "request", record: false });
  });

  it("past its expiry: recorded and expired, or bound late when someone's request is drawn", async () => {
    const at = await expiryRequestToRead(ticket(), 1_151n, live, CFG);
    const found = await ticketRequestAddress(ticket(), live, CFG);
    expect(at).toBe(found!.request);
    expect(await directStep(ticket(), 1_151n, live, null, CFG)).toEqual({
      kind: "expire",
      request: at,
      record: true,
      pending: false,
    });
    expect(await directStep(ticket(), 1_151n, live, orao(at!, "pending"), CFG)).toMatchObject({
      kind: "expire",
    });
    expect(await directStep(ticket(), 1_151n, live, orao(at!, "drawn"), CFG)).toEqual({
      kind: "bind",
      request: at,
    });
  });

  it("is refunded once its seed can no longer be derived", async () => {
    const gone = slotHashes(1_300n, 1_800n);
    expect(await expiryRequestToRead(ticket(), 1_801n, gone, CFG)).toBeNull();
    expect(await directStep(ticket(), 1_801n, gone, null, CFG)).toEqual({ kind: "refund" });
  });
});

describe("a Requested ticket", () => {
  const req = ticket({ status: TicketStatus.Requested, entropySlot: 1_001n });

  it("settles once drawn, waits, then expires from what was read", async () => {
    expect(await directStep(req, 1_100n, null, orao(BOUND, "drawn"), CFG)).toEqual({
      kind: "settle",
      request: BOUND,
    });
    expect(await directStep(req, 1_100n, null, orao(BOUND, "pending"), CFG)).toEqual({
      kind: "wait",
    });
    const [vrfPayer] = await findVrfPayerPda({ ticket: TICKET }, CFG);
    expect(await directStep(req, 1_151n, null, orao(BOUND, "pending", vrfPayer), CFG)).toEqual({
      kind: "expire",
      request: BOUND,
      record: false,
      pending: true,
    });
    // Fulfilled with zero: forfeitable, nothing left for ORAO to refund.
    expect(await directStep(req, 1_151n, null, orao(BOUND, "zero"), CFG)).toMatchObject({
      kind: "expire",
      pending: false,
    });
    // Pending as the program's TicketExpired judges it: only a RandomnessV2 vrf_payer paid for
    // refunds vrf_payer. Someone else's refunds its creator; a legacy one never refunds.
    expect(await directStep(req, 1_151n, null, orao(BOUND, "pending", BOUND), CFG)).toMatchObject({
      kind: "expire",
      pending: false,
    });
    // vrf_payer for the generated client's default program is not the served one's
    const [otherPayer] = await findVrfPayerPda({ ticket: TICKET });
    expect(
      await directStep(req, 1_151n, null, orao(BOUND, "pending", otherPayer), CFG),
    ).toMatchObject({ kind: "expire", pending: false });
    const legacy = new Uint8Array(780);
    legacy.set(ORAO_RANDOMNESS_V1_DISCRIMINATOR, 0);
    // seed[0] = 1 and client-like bytes: nothing about it reads as a pending RandomnessV2
    legacy.fill(1, 8, 40);
    expect(
      await directStep(
        req,
        1_151n,
        null,
        { address: BOUND, owner: ORAO_VRF_PROGRAM_ADDRESS, data: legacy },
        CFG,
      ),
    ).toMatchObject({ kind: "expire", pending: false });
    // Drawn after the deadline: still settled, however late.
    expect(await directStep(req, 5_000n, null, orao(BOUND, "drawn"), CFG)).toMatchObject({
      kind: "settle",
    });
  });
});

describe("the withheld reconciliation", () => {
  it("accounts each ordinal once and fails closed on an unreadable vault", () => {
    expect(unaccountedDirectWithheld(0n, [])).toBe(0n);
    expect(unaccountedDirectWithheld(3n, [1n, 3n, 3n])).toBe(1n);
    expect(unaccountedDirectWithheld(2n, [1n, 2n, 7n])).toBe(0n);
    expect(unaccountedDirectWithheld(null, [1n])).toBeNull();
  });

  it("reads an ordinal only from a version-2 expiry that counts", () => {
    const base = {
      version: 2 as const,
      ticket: TICKET,
      integrator: BOUND,
      forfeited: 1n,
      requested: false,
      requestFound: false,
      checked: true,
      pending: false,
      refunded: false,
      refund: 0n,
      parked: false,
      ticketForfeitsWithheld: 4n,
    };
    expect(withheldOrdinal(base)).toBeNull();
    expect(withheldOrdinal({ ...base, requestFound: true })).toBe(4n);
    expect(withheldOrdinal({ ...base, checked: false, refunded: true })).toBe(4n);
    expect(
      withheldOrdinal({ version: 1, ticket: TICKET, integrator: BOUND, forfeited: 1n }),
    ).toBeNull();
  });
});

describe("the direct withheld alarm", () => {
  const read = (ordinal: bigint, refunded = false) => ({
    ordinal,
    ticket: `t${ordinal}`,
    refunded,
  });

  it("keeps every counted ordinal critical until it is acknowledged, read or not", () => {
    const a = directAlarm(3n, [read(1n, true), read(3n)], []);
    expect(a.pauseRecommended).toBe(true);
    expect(a.unaccounted).toBe("1");
    expect(a.unresolved).toEqual([
      { ordinal: "1", ticket: "t1", refunded: true },
      { ordinal: "2", ticket: null, refunded: null },
      { ordinal: "3", ticket: "t3", refunded: false },
    ]);
    const acked = directAlarm(
      3n,
      [read(1n), read(3n)],
      [1n, 2n, 3n].map((ordinal) => ({ ordinal, reason: "reviewed" })),
    );
    expect([acked.pauseRecommended, acked.unresolved, acked.unresolvedCount]).toEqual([
      false,
      [],
      "0",
    ]);
    // an acknowledgement of an ordinal the vault has not counted yet resolves nothing
    const ahead = directAlarm(1n, [read(1n)], [{ ordinal: 2n, reason: "too early" }]);
    expect([ahead.pauseRecommended, ahead.acknowledged]).toEqual([true, []]);
  });

  it("fails closed on an unreadable vault, and counts past the listing", () => {
    expect(directAlarm(null, [read(1n)], []).pauseRecommended).toBe(true);
    expect(directAlarm(0n, [], []).pauseRecommended).toBe(false);
    const many = directAlarm(BigInt(DIRECT_ALARMS_LISTED + 10), [], []);
    expect(many.unresolved).toHaveLength(DIRECT_ALARMS_LISTED);
    expect(many.unresolvedCount).toBe(String(DIRECT_ALARMS_LISTED + 10));
  });

  it("reads the operator's acknowledgements, or ignores a malformed list whole", () => {
    expect(parseWithheldAcknowledgements(undefined)).toEqual({ acknowledged: [], error: null });
    expect(
      parseWithheldAcknowledgements(
        '[{"ordinal": 1, "reason": " gap "}, {"ordinal": "2", "reason": "x"}]',
      ),
    ).toEqual({
      acknowledged: [
        { ordinal: 1n, reason: "gap" },
        { ordinal: 2n, reason: "x" },
      ],
      error: null,
    });
    for (const bad of [
      "{",
      "{}",
      '[{"ordinal": 0, "reason": "x"}]',
      '[{"ordinal": -1, "reason": "x"}]',
      '[{"ordinal": 1.5, "reason": "x"}]',
      '[{"ordinal": 1, "reason": ""}]',
      '[{"ordinal": 1}]',
      '[{"ordinal": 1, "reason": "x", "extra": 1}]',
      '[{"ordinal": 1, "reason": "x"}, {"ordinal": "1", "reason": "y"}]',
      JSON.stringify([{ ordinal: 1, reason: "x".repeat(201) }]),
    ]) {
      const r = parseWithheldAcknowledgements(bad);
      expect(r.acknowledged, bad).toEqual([]);
      expect(r.error, bad).toMatch(/^DIRECT_ACKNOWLEDGED_WITHHELD ignored: /);
    }
  });

  it("combines with the beacon's recommendation", () => {
    expect(combinedPause(false, null)).toBe(false);
    expect(combinedPause(false, false)).toBe(false);
    expect(combinedPause(true, null)).toBe(true);
    expect(combinedPause(false, true)).toBe(true);
  });

  it("reads the beacon's side as off only while it is off, and fails closed when it cannot be read", () => {
    expect(beaconPauseOf({ enabled: false })).toBeNull();
    expect(beaconPauseOf({ enabled: true, pauseRecommended: false })).toBe(false);
    expect(beaconPauseOf({ enabled: true, pauseRecommended: true })).toBe(true);
    // BEACON_ENABLED set with another BEACON_* variable refused, or a start that threw
    expect(beaconPauseOf({ enabled: false, error: "BEACON_TX_FORMAT: expected 0 or legacy" })).toBe(
      true,
    );
    // the status call itself threw
    expect(beaconPauseOf(undefined)).toBe(true);
    expect(combinedPause(false, beaconPauseOf({ enabled: false, error: "x" }))).toBe(true);
  });
});
