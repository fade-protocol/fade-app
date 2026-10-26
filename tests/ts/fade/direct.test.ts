// The direct-path helpers (clients/js/src/direct): `TicketExpired` decoded
// whatever its schema version, and the end an Open ticket past its expiry
// takes, from the seed the program finds (recorded, else proven by
// SlotHashes) and the account at the derived request address.
import { describe, expect, it } from "vitest";
import {
  address,
  getAddressDecoder,
  getConstantDecoder,
  getHiddenPrefixDecoder,
  getStructDecoder,
  getU64Decoder,
  getU8Decoder,
  type Address,
} from "@solana/kit";
import {
  FADE_PROGRAM_ADDRESS,
  TICKET_EXPIRED_EVENT_DISCRIMINATOR,
  TicketStatus,
  getTicketExpiredEventEncoder,
  type Ticket,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  decodeTicketExpired,
  openTicketExpiry,
  ticketExpiryWithheld,
  ticketRequestAddress,
  ticketSeed,
} from "../../../clients/js/src/direct/index.ts";
import {
  ORAO_RANDOMNESS_V2_DISCRIMINATOR,
  ORAO_VRF_PROGRAM_ADDRESS,
  findOraoRequestPda,
} from "../../../clients/js/src/beacon/index.ts";

const TICKET = address("SysvarRent111111111111111111111111111111111");
const INTEGRATOR = address("SysvarC1ock11111111111111111111111111111111");

/** The `TicketExpired` decoder the deployed client carried: the version-1 fields. */
const deployedV1Decoder = () =>
  getHiddenPrefixDecoder(
    getStructDecoder([
      ["version", getU8Decoder()],
      ["ticket", getAddressDecoder()],
      ["integrator", getAddressDecoder()],
      ["forfeited", getU64Decoder()],
    ]),
    [getConstantDecoder(TICKET_EXPIRED_EVENT_DISCRIMINATOR)],
  );

const v2 = {
  version: 2,
  ticket: TICKET,
  integrator: INTEGRATOR,
  forfeited: 24_950_000n,
  requested: false,
  requestFound: true,
  checked: true,
  pending: false,
  refunded: false,
  refund: 0n,
  parked: false,
  ticketForfeitsWithheld: 3n,
};

function v1Body(): Uint8Array {
  const full = new Uint8Array(getTicketExpiredEventEncoder().encode(v2));
  const body = full.slice(0, 8 + 1 + 32 + 32 + 8);
  body[8] = 1;
  return body;
}

/** SlotHashes holding `slots` (newest first), each hash its slot's low byte. */
function slotHashes(slots: bigint[]): Uint8Array {
  const d = new Uint8Array(8 + slots.length * 40);
  const view = new DataView(d.buffer);
  view.setBigUint64(0, BigInt(slots.length), true);
  slots.forEach((s, i) => {
    view.setBigUint64(8 + i * 40, s, true);
    d.fill(Number(s % 251n), 16 + i * 40, 48 + i * 40);
  });
  return d;
}

const range = (from: bigint, to: bigint) => {
  const v: bigint[] = [];
  for (let s = to; s >= from; s--) v.push(s);
  return v;
};

function ticket(overrides: Partial<Ticket> = {}): { address: Address; data: Ticket } {
  return {
    address: TICKET,
    data: {
      status: TicketStatus.Open,
      openSlot: 1_000n,
      expirySlot: 1_150n,
      entropySlot: 0n,
      seed: new Uint8Array(32),
      ...overrides,
    } as Ticket,
  };
}

function oraoFulfilled(randomness: number): Uint8Array {
  const d = new Uint8Array(137);
  d.set(ORAO_RANDOMNESS_V2_DISCRIMINATOR, 0);
  d[8] = 1;
  d.fill(randomness, 73, 137);
  return d;
}

describe("TicketExpired versions", () => {
  it("decodes a version-2 body with its findings", () => {
    const e = decodeTicketExpired(new Uint8Array(getTicketExpiredEventEncoder().encode(v2)));
    expect(e).toMatchObject({ ...v2, version: 2 });
    expect(ticketExpiryWithheld(e)).toBe(true);
  });

  it("decodes a version-1 body without the version-2 decoder", () => {
    const e = decodeTicketExpired(v1Body());
    expect(e).toEqual({
      version: 1,
      ticket: TICKET,
      integrator: INTEGRATOR,
      forfeited: 24_950_000n,
    });
    expect(ticketExpiryWithheld(e)).toBeNull();
  });

  it("the deployed version-1 decoder reads a version-2 body's prefix", () => {
    // Indexers still running the client of the program before the upgrade.
    const body = new Uint8Array(getTicketExpiredEventEncoder().encode(v2));
    expect(deployedV1Decoder().decode(body)).toMatchObject({
      version: 2,
      ticket: TICKET,
      integrator: INTEGRATOR,
      forfeited: 24_950_000n,
    });
  });

  it("refuses another event or an unknown version", () => {
    expect(() => decodeTicketExpired(new Uint8Array(90))).toThrow(/not a TicketExpired/);
    const body = v1Body();
    body[8] = 9;
    expect(() => decodeTicketExpired(body)).toThrow(/version 9/);
  });
});

describe("an Open ticket past its expiry", () => {
  it("derives the request from SlotHashes while it proves s*, and expires with a record", async () => {
    const hashes = slotHashes(range(990n, 1_160n));
    const seed = await ticketSeed(FADE_PROGRAM_ADDRESS, TICKET, 1_000n, {
      slot: 1_001n,
      hash: new Uint8Array(32).fill(Number(1_001n % 251n)),
    });
    const [request] = await findOraoRequestPda(seed);
    expect(await ticketRequestAddress(ticket(), hashes)).toEqual({ request, seed });
    expect(await openTicketExpiry(ticket(), hashes, null)).toEqual({
      kind: "expire",
      request,
      seed,
      record: true,
    });
  });

  it("binds a fulfilled request late instead of expiring it", async () => {
    const hashes = slotHashes(range(990n, 1_160n));
    const found = (await ticketRequestAddress(ticket(), hashes))!;
    const read = {
      address: found.request,
      owner: ORAO_VRF_PROGRAM_ADDRESS,
      data: oraoFulfilled(7),
    };
    expect((await openTicketExpiry(ticket(), hashes, read)).kind).toBe("bind");
    // Fulfilled with zero: forfeitable, not bound.
    const zero = { ...read, data: oraoFulfilled(0) };
    expect((await openTicketExpiry(ticket(), hashes, zero)).kind).toBe("expire");
  });

  it("uses the recorded seed once SlotHashes forgot s*, and refunds when nothing was recorded", async () => {
    const late = slotHashes(range(1_200n, 1_700n));
    expect(await openTicketExpiry(ticket(), late, null)).toEqual({ kind: "refund" });
    const seed = new Uint8Array(32).fill(5);
    const recorded = ticket({ entropySlot: 1_001n, seed });
    const [request] = await findOraoRequestPda(seed);
    expect(await openTicketExpiry(recorded, late, null)).toEqual({
      kind: "expire",
      request,
      seed,
      record: false,
    });
  });
});
