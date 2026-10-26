// The Keeper Durable Object's direct-path bookkeeping (apps/keeper/src/keeper.ts), over SQLite in
// memory and a scripted RPC: the vrf_payer sweep's queue rotates and never waits for a sweep to
// land, a version-1 expiry is settled for the withheld reconciliation at once without delaying
// its prune, a refund parked in escrow is read as a refund (not a settlement on outcome 0), and
// the direct withheld alarm is never pruned, clears only by the operator's acknowledgement, and
// sets the pause recommendation both health routes show, read first in the alarm every sweep
// whatever its other steps meet or spend of its subrequests, and failing closed once that read
// is old; an Open ticket's seed is recorded on
// its own transaction in the window, whatever becomes of its request; an expiry someone else
// sent with its request pending is queued for the vrf_payer sweep as the keeper's own, and the
// keeper's own expiry joins that queue from its event's `pending`, the bound request read even
// when the row did not name it, or looked up among the ticket's transactions when the keeper
// never saw it Requested, and a late bind's settlement read past the request in its transaction;
// a sweep that cannot afford its listing of the unposted tickets owes
// it to the next alarm, the payouts' backfill keeps it a subrequest, and the API's own reads
// draw nothing from the alarm's count; a closure someone else sent and the first lookup missed
// is looked up again, on backoff or by the sweep, before it is given up.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import {
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  type Address,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import {
  RECORD_TICKET_ENTROPY_DISCRIMINATOR,
  REFUND_OUTCOME,
  TICKET_EXPIRED_EVENT_DISCRIMINATOR,
  TicketStatus,
  getTicketDecoder,
  getTicketEncoder,
  getRandomnessRequestedEventEncoder,
  getTicketSettledEventEncoder,
  getTicketExpiredEventEncoder,
  getVaultDecoder,
  getVaultEncoder,
  getVaultSize,
} from "../../../clients/js/src/generated/fade/index.ts";
import { EVENT_IX_TAG, PROGRAM, SLOT_HASHES, vrfPayerPda } from "../../../apps/keeper/src/chain.ts";
import { A, sig } from "./walletFixtures.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

type KeeperObject = {
  health(): Promise<{
    pauseRecommended?: boolean;
    directWithheld?: {
      pauseRecommended: boolean;
      unresolved: { ordinal: string; ticket: string | null }[];
      acknowledged: { ordinal: string; reason: string }[];
    };
  }>;
};
// Imported by a computed path: the Workers types it needs are the keeper's own typecheck's.
const KEEPER_MODULE = "../../../apps/keeper/src/keeper.ts";
const { Keeper } = (await import(KEEPER_MODULE)) as {
  Keeper: new (ctx: unknown, env: unknown) => KeeperObject;
};

const b58 = (bytes: ArrayLike<number>) => getBase58Decoder().decode(Uint8Array.from(bytes));
const base64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const T0 = 1_700_000_000_000;

function memoryState() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec: (q: string, ...b: (string | number | null)[]) => {
      const rows = db.prepare(q).all(...b);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
  return {
    storage: { sql, getAlarm: async () => null, setAlarm: async () => {} },
  };
}

type Rpc = Record<string, (...args: never[]) => { send: () => Promise<unknown> }>;

/** A keeper on `rpc` (the methods a test scripts), its storage and its private methods. */
async function keeperOver(rpc: Rpc, env: Record<string, string> = {}) {
  const state = memoryState();
  const keeper = new Keeper(state, { RPC_URL: "http://localhost:0", ...env });
  const k = keeper as unknown as Record<string, unknown>;
  k.rpc = rpc;
  k.apiRpc = rpc;
  k.signerPromise = generateKeyPairSigner();
  const call = (name: string, ...args: unknown[]) =>
    (k[name] as (...a: unknown[]) => Promise<unknown>).apply(keeper, args);
  const rows = () =>
    state.storage.sql.exec("SELECT * FROM tickets ORDER BY address").toArray() as Record<
      string,
      unknown
    >[];
  return { keeper, state, call, rows, sql: state.storage.sql };
}

function insertTicket(
  sql: ReturnType<typeof memoryState>["storage"]["sql"],
  address: string,
  fields: Record<string, string | number | null>,
) {
  const cols = {
    address,
    state: "expired",
    source: "test",
    created_at: T0,
    updated_at: T0,
    ...fields,
  };
  const keys = Object.keys(cols);
  sql.exec(
    `INSERT INTO tickets (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    ...(Object.values(cols) as (string | number | null)[]),
  );
}

const ORAO = "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y";
const V2 = [139, 239, 184, 215, 227, 86, 191, 226];
const V1 = [188, 96, 216, 248, 93, 94, 49, 112];
const account = (bytes: ArrayLike<number>) => ({
  data: [base64(Uint8Array.from(bytes)), "base64"],
  owner: ORAO,
  lamports: 1n,
});
/** ORAO's request account, pending: `RandomnessV2` with tag 0, its rent paid by `client`. */
const pendingRequest = (client: string) =>
  account([...V2, 0, ...getAddressEncoder().encode(client as Address), ...Array(708).fill(0)]);
/** A fulfilled `RandomnessV2`, shrunk: its rent refunded to `client`. */
const fulfilledRequest = (client: string) =>
  account([...V2, 1, ...getAddressEncoder().encode(client as Address), ...Array(96).fill(9)]);
/** A legacy `Randomness` (ORAO's deprecated `request`): seed, then randomness (zero: pending). */
const legacyRequest = (randomness: number) =>
  account([...V1, ...Array(32).fill(2), ...Array(64).fill(randomness), ...Array(676).fill(0)]);

describe("the vrf_payer sweep", () => {
  it("rotates its queue, so that requests ORAO never answers cannot hold it", async () => {
    const reads: string[][] = [];
    const { call, sql, rows } = await keeperOver({
      getMultipleAccounts: (list: string[]) => ({
        send: async () => {
          reads.push(list);
          // every vrf_payer empty, every request still pending on its rent
          const half = list.length / 2;
          return { value: list.map((_, i) => (i < half ? null : pendingRequest(list[i - half]!))) };
        },
      }),
    } as unknown as Rpc);
    for (let i = 0; i < 25; i++)
      insertTicket(sql, A(`dead${String(i).padStart(2, "0")}`), {
        vrf_sweep: 1,
        integrator: A("Integrator"),
        nonce: String(i),
        randomness: A(`request${i}`),
      });
    // rows it could not sweep never take a slot of the queue
    for (let i = 0; i < 3; i++)
      insertTicket(sql, A(`partial${i}`), { vrf_sweep: 1, randomness: A(`r${i}`) });

    await call("sweepVrfPayers");
    await call("sweepVrfPayers");
    expect(reads.map((l) => l.length)).toEqual([40, 40]);
    const requests = (l: string[]) => new Set(l.slice(l.length / 2));
    const first = requests(reads[0]!);
    const second = requests(reads[1]!);
    // the five the first sweep left are checked first by the second
    const all = new Set(Array.from({ length: 25 }, (_, i) => A(`request${i}`)));
    const left = [...all].filter((a) => !first.has(a));
    expect(left).toHaveLength(5);
    for (const a of left) expect(second.has(a)).toBe(true);
    // still queued (pending), and the bookkeeping does not delay their prune
    for (const r of rows().filter((r) => r.nonce !== null)) {
      expect(r.vrf_sweep).toBe(1);
      expect(r.updated_at).toBe(T0);
      expect(r.vrf_checked_at).toBeGreaterThan(0);
    }
  });

  it("sends a sweep without waiting for it to land, and keeps the row queued", async () => {
    const sent: string[] = [];
    let statuses = 0;
    const { call, sql, rows } = await keeperOver({
      getMultipleAccounts: (list: string[]) => ({
        send: async () => ({
          value: [{ lamports: 4_259_520n, data: ["", "base64"], owner: A("System") }, null],
        }),
      }),
      getLatestBlockhash: () => ({
        send: async () => ({
          value: { blockhash: b58(Array(32).fill(7)), lastValidBlockHeight: 100n },
        }),
      }),
      simulateTransaction: () => ({ send: async () => ({ value: { err: null, logs: [] } }) }),
      sendTransaction: (wire: string) => ({ send: async () => (sent.push(wire), "sig") }),
      getSignatureStatuses: () => ({ send: async () => (statuses++, { value: [null] }) }),
    } as unknown as Rpc);
    insertTicket(sql, A("refunded"), {
      vrf_sweep: 1,
      integrator: A("Integrator"),
      nonce: "3",
      randomness: A("request"),
    });
    const started = Date.now();
    await call("sweepVrfPayers");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(sent).toHaveLength(1);
    expect(statuses).toBe(0);
    expect(rows()[0]!.vrf_sweep).toBe(1);
  });

  it("takes a row off the queue once its request owes vrf_payer nothing, legacy included", async () => {
    const cases = {
      own: (p: string) => pendingRequest(p),
      fulfilled: (p: string) => fulfilledRequest(p),
      stranger: () => pendingRequest(A("Stranger")),
      // its byte 8 is seed[0], never a RandomnessV2 tag: it never shrinks, so never refunds
      legacyPending: () => legacyRequest(0),
      legacyFulfilled: () => legacyRequest(5),
      unparsable: () => account([1, 2, 3]),
      gone: () => null,
    };
    const names = Object.keys(cases) as (keyof typeof cases)[];
    const byRequest = new Map(names.map((n) => [A(`req${n}`), cases[n]]));
    const { call, sql, rows } = await keeperOver({
      getMultipleAccounts: (list: string[]) => ({
        send: async () => {
          const half = list.length / 2;
          return {
            value: list.map((a, i) =>
              i < half ? null : (byRequest.get(a as Address)?.(list[i - half]!) ?? null),
            ),
          };
        },
      }),
    } as unknown as Rpc);
    for (const [i, n] of names.entries())
      insertTicket(sql, A(`t${n}`), {
        vrf_sweep: 1,
        integrator: A("Integrator"),
        nonce: String(i),
        randomness: A(`req${n}`),
      });
    await call("sweepVrfPayers");
    const queued = rows()
      .filter((r) => r.vrf_sweep === 1)
      .map((r) => r.address);
    expect(queued).toEqual([A("town")]);
  });
});

describe("the keeper's own expiry", () => {
  it("reads the bound request of a Requested ticket its row did not name, and queues the sweep", async () => {
    // the app sent request_randomness itself: the row, still queued, names no request
    const address = A("AppRequested");
    const integrator = A("Integrator");
    const request = A("AppRequest");
    const vrfPayer = await vrfPayerPda(address);
    const zero = getTicketDecoder().decode(new Uint8Array(859));
    const data = getTicketEncoder().encode({
      ...zero,
      status: TicketStatus.Requested,
      integrator,
      nonce: 9n,
      randomness: request,
      openSlot: 1_000n,
      expirySlot: 1_150n,
    });
    const reads: string[][] = [];
    const sent: string[] = [];
    const { call, sql, rows } = await keeperOver({
      getMultipleAccounts: (list: string[]) => ({
        send: async () => {
          reads.push(list);
          return {
            context: { slot: 1_200n },
            value: list.map((a) =>
              a === address
                ? { data: [base64(Uint8Array.from(data)), "base64"], owner: PROGRAM }
                : a === request
                  ? pendingRequest(vrfPayer)
                  : null,
            ),
          };
        },
      }),
      getLatestBlockhash: () => ({
        send: async () => ({
          value: { blockhash: b58(Array(32).fill(7)), lastValidBlockHeight: 100n },
        }),
      }),
      simulateTransaction: () => ({ send: async () => ({ value: { err: null, logs: [] } }) }),
      sendTransaction: (wire: string) => ({ send: async () => (sent.push(wire), "sig") }),
    } as unknown as Rpc);
    insertTicket(sql, address, { state: "queued" });
    await call("advance", rows());
    expect(reads.some((l) => l.includes(request))).toBe(true);
    expect(sent).toHaveLength(1);
    const r = rows()[0]!;
    expect([r.pending_kind, r.randomness, r.integrator, r.nonce, r.vrf_sweep]).toEqual([
      "expire",
      request,
      integrator,
      "9",
      1,
    ]);
  });

  it("joins the vrf_payer sweep's queue from its event's pending, whatever the send predicted", async () => {
    const address = A("MispredictedExpiry");
    const integrator = A("Integrator");
    const body = getTicketExpiredEventEncoder().encode({
      version: 2,
      ticket: address,
      integrator,
      forfeited: 49_000_000n,
      requested: true,
      requestFound: true,
      checked: true,
      pending: true,
      refunded: false,
      refund: 0n,
      parked: false,
      ticketForfeitsWithheld: 4n,
    });
    const { call, sql, rows } = await keeperOver({
      getTransaction: () => ({
        send: async () => ({
          slot: 1n,
          meta: {
            err: null,
            innerInstructions: [
              {
                instructions: [
                  { programIdIndex: 1, data: b58([...EVENT_IX_TAG, ...Uint8Array.from(body)]) },
                ],
              },
            ],
          },
          transaction: { message: { accountKeys: [A("Keeper"), PROGRAM] } },
        }),
      }),
    } as unknown as Rpc);
    insertTicket(sql, address, {
      expire_sig: sig(3),
      vrf_sweep: 0,
      integrator,
      nonce: "5",
      randomness: A("Request"),
    });
    await call("readExpiries");
    const r = rows()[0]!;
    expect([r.withheld, r.vrf_sweep, r.updated_at]).toEqual(["4", 1, T0]);
  });
});

describe("a refunded ticket tracked again", () => {
  const address = A("RetrackedRefund");
  const integrator = A("Integrator");
  const zero = getTicketDecoder().decode(new Uint8Array(859));
  const open = getTicketDecoder().decode(
    Uint8Array.from(
      getTicketEncoder().encode({
        ...zero,
        status: TicketStatus.Open,
        integrator,
        nonce: 7n,
        openSlot: 1_000n,
        expirySlot: 1_150n,
      }),
    ),
  );
  const refundEvent = getTicketExpiredEventEncoder().encode({
    version: 2,
    ticket: address,
    integrator,
    forfeited: 0n,
    requested: false,
    requestFound: false,
    checked: false,
    pending: false,
    refunded: true,
    refund: 49_000_000n,
    parked: false,
    ticketForfeitsWithheld: 1n,
  });
  const gone = (txs: number[]) =>
    ({
      getMultipleAccounts: (list: string[]) => ({
        send: async () => ({ context: { slot: 2_000n }, value: list.map(() => null) }),
      }),
      getSignaturesForAddress: () => ({ send: async () => [{ signature: sig(9), err: null }] }),
      getTransaction: () => ({
        send: async () => {
          txs.push(1);
          return {
            slot: 1_800n,
            meta: {
              err: null,
              innerInstructions: [
                {
                  instructions: [
                    {
                      programIdIndex: 1,
                      data: b58([...EVENT_IX_TAG, ...Uint8Array.from(refundEvent)]),
                    },
                  ],
                },
              ],
            },
            transaction: { message: { accountKeys: [A("Anyone"), PROGRAM] } },
          };
        },
      }),
    }) as unknown as Rpc;

  it("keeps its refund when a lagging node still lists it as Open", async () => {
    const txs: number[] = [];
    const { call, sql, rows } = await keeperOver(gone(txs));
    insertTicket(sql, address, { state: "refunded", expire_sig: sig(9), payout: "49000000" });
    await call("track", address, open, "sweep");
    expect(rows()[0]!.state).toBe("refunded");
    await call("advance", rows());
    expect([rows()[0]!.state, rows()[0]!.expire_sig]).toEqual(["refunded", sig(9)]);
  });

  it("is read back as a refund from its event when an earlier re-track had reset it", async () => {
    const txs: number[] = [];
    const { call, sql, rows } = await keeperOver(gone(txs));
    // a row reset to queued, its expiry signature kept, before track() kept a closed row's state
    insertTicket(sql, address, { state: "queued", expire_sig: sig(9) });
    await call("advance", rows());
    expect([rows()[0]!.state, rows()[0]!.expire_sig]).toEqual(["refunded", sig(9)]);
    expect(txs.length).toBeGreaterThan(0);
  });
});

describe("an expiry someone else sent", () => {
  it("puts a ticket expired with its request pending on the vrf_payer sweep's queue", async () => {
    // F-3: the slot leader orders its own expiry ahead of ORAO's late fulfil
    const address = A("LeaderExpired");
    const integrator = A("Integrator");
    const request = A("PendingRequest");
    const vrfPayer = await vrfPayerPda(address);
    const zero = getTicketDecoder().decode(new Uint8Array(859));
    const data = getTicketEncoder().encode({
      ...zero,
      status: TicketStatus.Requested,
      integrator,
      nonce: 42n,
      randomness: request,
      openSlot: 1_000n,
      expirySlot: 1_150n,
    });
    const body = getTicketExpiredEventEncoder().encode({
      version: 2,
      ticket: address,
      integrator,
      forfeited: 49_000_000n,
      requested: true,
      requestFound: true,
      checked: true,
      pending: true,
      refunded: false,
      refund: 0n,
      parked: false,
      ticketForfeitsWithheld: 1n,
    });
    let open = true;
    const swept: string[][] = [];
    const { call, sql, rows } = await keeperOver({
      getMultipleAccounts: (list: string[]) => ({
        send: async () => {
          if (!open) swept.push(list);
          return {
            context: { slot: 1_100n },
            value: list.map((a) =>
              a === address && open
                ? { data: [base64(Uint8Array.from(data)), "base64"], owner: PROGRAM }
                : a === request
                  ? pendingRequest(vrfPayer)
                  : null,
            ),
          };
        },
      }),
      getSignaturesForAddress: () => ({ send: async () => [{ signature: sig(7), err: null }] }),
      getTransaction: () => ({
        send: async () => ({
          slot: 1_200n,
          meta: {
            err: null,
            innerInstructions: [
              {
                instructions: [
                  { programIdIndex: 1, data: b58([...EVENT_IX_TAG, ...Uint8Array.from(body)]) },
                ],
              },
            ],
          },
          transaction: { message: { accountKeys: [A("Leader"), PROGRAM] } },
        }),
      }),
    } as unknown as Rpc);
    // tracked before its integrator and nonce were recorded: read from chain while it is open
    insertTicket(sql, address, { state: "requested", randomness: request });
    await call("advance", rows());
    expect(rows()[0]!.state).toBe("requested");
    expect([rows()[0]!.integrator, rows()[0]!.nonce]).toEqual([integrator, "42"]);

    open = false;
    await call("advance", rows());
    const r = rows()[0]!;
    expect([r.state, r.expire_sig, r.withheld, r.vrf_sweep]).toEqual(["expired", sig(7), "1", 1]);
    await call("sweepVrfPayers");
    expect(swept.at(-1)).toContain(request);
  });

  it("leaves a ticket whose bound request was not pending off the queue", async () => {
    const address = A("FulfilledExpired");
    const integrator = A("Integrator");
    const body = getTicketExpiredEventEncoder().encode({
      version: 2,
      ticket: address,
      integrator,
      forfeited: 49_000_000n,
      requested: true,
      requestFound: true,
      checked: true,
      pending: false,
      refunded: false,
      refund: 0n,
      parked: false,
      ticketForfeitsWithheld: 2n,
    });
    const { call, sql, rows } = await keeperOver({
      getSignaturesForAddress: () => ({ send: async () => [{ signature: sig(8), err: null }] }),
      getTransaction: () => ({
        send: async () => ({
          slot: 1n,
          meta: {
            err: null,
            innerInstructions: [
              {
                instructions: [
                  { programIdIndex: 1, data: b58([...EVENT_IX_TAG, ...Uint8Array.from(body)]) },
                ],
              },
            ],
          },
          transaction: { message: { accountKeys: [A("Leader"), PROGRAM] } },
        }),
      }),
    } as unknown as Rpc);
    insertTicket(sql, address, {
      state: "requested",
      integrator,
      nonce: "1",
      randomness: A("Request"),
    });
    await call("resolveClosed", rows()[0]);
    const r = rows()[0]!;
    expect([r.state, r.withheld, r.vrf_sweep]).toEqual(["expired", "2", 0]);
  });
});

describe("the expiries' withheld ordinals", () => {
  const ticket = A("OldExpiry");
  const integrator = A("Integrator");
  // the version-1 body: discriminator, version, ticket, integrator, forfeited
  const v1Body = Uint8Array.from([
    ...TICKET_EXPIRED_EVENT_DISCRIMINATOR,
    1,
    ...getAddressEncoder().encode(ticket),
    ...getAddressEncoder().encode(integrator),
    ...Array(8).fill(0),
  ]);
  const tx = (body: Uint8Array) => ({
    slot: 1n,
    meta: {
      err: null,
      innerInstructions: [
        { instructions: [{ programIdIndex: 1, data: b58([...EVENT_IX_TAG, ...body]) }] },
      ],
    },
    transaction: { message: { accountKeys: [A("Payer"), PROGRAM] } },
  });

  it("records a version-1 expiry as accounting for no ordinal at once, its prune untouched", async () => {
    let gets = 0;
    const { call, sql, rows } = await keeperOver({
      getTransaction: () => ({ send: async () => (gets++, tx(v1Body)) }),
    } as unknown as Rpc);
    insertTicket(sql, ticket, { expire_sig: sig(1) });
    await call("readExpiries");
    await call("readExpiries");
    expect(gets).toBe(1);
    const r = rows()[0]!;
    expect([r.withheld, r.detail_tries, r.updated_at]).toEqual(["0", 0, T0]);
  });

  it("records a version-2 withheld expiry's ordinal", async () => {
    const body = getTicketExpiredEventEncoder().encode({
      version: 2,
      ticket,
      integrator,
      forfeited: 0n,
      requested: false,
      requestFound: false,
      checked: false,
      pending: false,
      refunded: true,
      refund: 49_000_000n,
      parked: false,
      ticketForfeitsWithheld: 3n,
    });
    const { call, sql, rows } = await keeperOver({
      getTransaction: () => ({ send: async () => tx(Uint8Array.from(body)) }),
    } as unknown as Rpc);
    insertTicket(sql, ticket, { state: "refunded", expire_sig: sig(2) });
    await call("readExpiries");
    expect(rows()[0]!.withheld).toBe("3");
  });
});

describe("a refund parked in escrow", () => {
  it("is a refund, not a settlement on outcome 0", async () => {
    const address = A("ParkedRefund");
    const zero = getTicketDecoder().decode(new Uint8Array(859));
    const data = getTicketEncoder().encode({
      ...zero,
      status: TicketStatus.PayoutPending,
      outcome: REFUND_OUTCOME,
      payout: 49_000_000n,
      openSlot: 10n,
      expirySlot: 160n,
    });
    expect(data.length).toBe(859);
    const { call, sql, rows } = await keeperOver({
      getMultipleAccounts: (list: string[]) => ({
        send: async () => ({
          context: { slot: 1_000n },
          value: list.map((a) =>
            a === address
              ? { data: [base64(Uint8Array.from(data)), "base64"], owner: PROGRAM }
              : null,
          ),
        }),
      }),
      getSignaturesForAddress: () => ({ send: async () => [] }),
    } as unknown as Rpc);
    insertTicket(sql, address, { state: "queued" });
    await call("advance", rows());
    const r = rows()[0]!;
    expect([r.state, r.payout, r.outcome]).toEqual(["refunded", "49000000", null]);
  });
});

describe("a closure someone else sent, missed by the first lookup", () => {
  const integrator = A("Integrator");
  /** An expiry's transaction: a version-2 `TicketExpired` for `ticket`. */
  const expiryTx = (ticket: Address, fields: { pending: boolean; refunded: boolean }) => {
    const body = getTicketExpiredEventEncoder().encode({
      version: 2,
      ticket,
      integrator,
      forfeited: fields.refunded ? 0n : 49_000_000n,
      requested: fields.pending,
      requestFound: fields.pending,
      checked: fields.pending,
      pending: fields.pending,
      refunded: fields.refunded,
      refund: fields.refunded ? 49_000_000n : 0n,
      parked: fields.refunded,
      ticketForfeitsWithheld: 4n,
    });
    return {
      slot: 1n,
      meta: {
        err: null,
        innerInstructions: [
          {
            instructions: [
              { programIdIndex: 1, data: b58([...EVENT_IX_TAG, ...Uint8Array.from(body)]) },
            ],
          },
        ],
      },
      transaction: { message: { accountKeys: [A("Other"), PROGRAM] } },
    };
  };

  it("finds a parked refund's expiry at a later sweep, its ordinal and ticket named", async () => {
    const address = A("ParkedLate");
    const zero = getTicketDecoder().decode(new Uint8Array(859));
    const data = getTicketEncoder().encode({
      ...zero,
      status: TicketStatus.PayoutPending,
      outcome: REFUND_OUTCOME,
      payout: 49_000_000n,
      openSlot: 10n,
      expirySlot: 160n,
    });
    let served = false; // the RPC lists the expiry only once it serves it
    const { call, sql, rows } = await keeperOver({
      getMultipleAccounts: (list: string[]) => ({
        send: async () => ({
          context: { slot: 1_000n },
          value: list.map((a) =>
            a === address
              ? { data: [base64(Uint8Array.from(data)), "base64"], owner: PROGRAM }
              : null,
          ),
        }),
      }),
      getSignaturesForAddress: () => ({
        send: async () => (served ? [{ signature: sig(41), err: null }] : []),
      }),
      getTransaction: () => ({
        send: async () => expiryTx(address, { pending: false, refunded: true }),
      }),
    } as unknown as Rpc);
    insertTicket(sql, address, { state: "queued" });
    await call("advance", rows());
    let r = rows()[0]!;
    // missed: a refund all the same, its expiry still to find
    expect([r.state, r.payout, r.expire_sig, r.withheld]).toEqual([
      "refunded",
      "49000000",
      null,
      null,
    ]);
    await call("findUnfoundExpiries");
    expect(rows()[0]!.detail_tries).toBe(1);
    served = true;
    await call("findUnfoundExpiries");
    r = rows()[0]!;
    expect([r.state, r.expire_sig, r.withheld]).toEqual(["refunded", sig(41), "4"]);
    // found: never looked up again
    await call("findUnfoundExpiries");
    expect(rows()[0]!.detail_tries).toBe(1);
  });

  it("gives a parked refund's lookup up after its tries, a failed read counted", async () => {
    const address = A("ParkedNever");
    let lookups = 0;
    const { call, sql, rows } = await keeperOver({
      getSignaturesForAddress: () => ({
        send: async () => {
          lookups++;
          if (lookups % 2) throw new Error("429");
          return [];
        },
      }),
    } as unknown as Rpc);
    insertTicket(sql, address, { state: "refunded", payout: "49000000" });
    for (let i = 0; i < 12; i++) await call("findUnfoundExpiries");
    expect(lookups).toBe(10);
    expect([rows()[0]!.state, rows()[0]!.detail_tries]).toEqual(["refunded", 10]);
  });

  it("looks a closed ticket up on backoff over minutes before it is unknown, and queues its sweep once found", async () => {
    const address = A("ClosedLate");
    let served = false;
    let lookups = 0;
    const { call, sql, rows } = await keeperOver({
      getMultipleAccounts: (list: string[]) => ({
        send: async () => ({ context: { slot: 1_000n }, value: list.map(() => null) }),
      }),
      getSignaturesForAddress: () => ({
        send: async () => (lookups++, served ? [{ signature: sig(42), err: null }] : []),
      }),
      getTransaction: () => ({
        send: async () => expiryTx(address, { pending: true, refunded: false }),
      }),
    } as unknown as Rpc);
    insertTicket(sql, address, {
      state: "requested",
      integrator,
      nonce: "3",
      randomness: A("ClosedRequest"),
    });
    const now = vi.spyOn(Date, "now");
    try {
      let t = T0;
      now.mockImplementation(() => t);
      // ticks 1.5 s apart: the first misses, the next ones wait out its backoff
      for (let i = 0; i < 4; i++, t += 1_500) await call("advance", rows());
      expect(lookups).toBe(2);
      let r = rows()[0]!;
      expect([r.state, r.detail_tries]).toEqual(["requested", 2]);
      expect(r.next_try_at).toBeGreaterThan(t);
      // still active well past the three ticks main allowed
      t += 60_000;
      await call("advance", rows());
      expect(rows()[0]!.state).toBe("requested");
      served = true;
      t += 60_000;
      await call("advance", rows());
      r = rows()[0]!;
      expect([r.state, r.expire_sig, r.withheld, r.vrf_sweep]).toEqual([
        "expired",
        sig(42),
        "4",
        1,
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("marks a closed ticket unknown only after its tries", async () => {
    const address = A("ClosedNever");
    const { call, sql, rows } = await keeperOver({
      getSignaturesForAddress: () => ({ send: async () => [] }),
    } as unknown as Rpc);
    insertTicket(sql, address, { state: "requested" });
    for (let i = 1; i < 10; i++) {
      await call("resolveClosed", rows()[0]);
      expect([rows()[0]!.state, rows()[0]!.detail_tries]).toEqual(["requested", i]);
    }
    await call("resolveClosed", rows()[0]);
    expect(rows()[0]!.state).toBe("unknown");
  });
});

describe("the direct withheld alarm", () => {
  const counted = (
    sql: ReturnType<typeof memoryState>["storage"]["sql"],
    n: string,
    readAt = Date.now(),
  ) => {
    sql.exec(
      "INSERT OR REPLACE INTO keeper_state (key, value) VALUES ('ticket_forfeits_withheld', ?)",
      n,
    );
    sql.exec(
      "INSERT OR REPLACE INTO keeper_state (key, value) VALUES ('ticket_forfeits_withheld_read_at', ?)",
      String(readAt),
    );
  };
  const rpc = {
    getBalance: () => ({ send: async () => ({ value: 1n }) }),
  } as unknown as Rpc;

  it("is never pruned and pauses until each ordinal is acknowledged", async () => {
    const { keeper, sql } = await keeperOver(rpc);
    counted(sql, "2");
    // read a month ago: still on record
    sql.exec(
      "INSERT INTO direct_withheld (ordinal, ticket, refunded, at) VALUES (1, ?, 1, ?)",
      A("Refunded"),
      Date.now() - 30 * 86_400_000,
    );
    const h = await keeper.health();
    expect(h.pauseRecommended).toBe(true);
    expect(h.directWithheld?.unresolved).toEqual([
      { ordinal: "1", ticket: A("Refunded"), refunded: true },
      { ordinal: "2", ticket: null, refunded: null },
    ]);
  });

  it("clears only the ordinals the operator acknowledged", async () => {
    const ack = (ordinals: number[]) =>
      JSON.stringify(ordinals.map((o) => ({ ordinal: o, reason: "upgrade window refund" })));
    const one = await keeperOver(rpc, { DIRECT_ACKNOWLEDGED_WITHHELD: ack([1]) });
    counted(one.sql, "2");
    const h1 = await one.keeper.health();
    expect(h1.pauseRecommended).toBe(true);
    expect(h1.directWithheld?.unresolved.map((u) => u.ordinal)).toEqual(["2"]);
    const both = await keeperOver(rpc, { DIRECT_ACKNOWLEDGED_WITHHELD: ack([1, 2]) });
    counted(both.sql, "2");
    const h2 = await both.keeper.health();
    expect(h2.pauseRecommended).toBe(false);
    expect(h2.directWithheld?.acknowledged.map((a) => a.ordinal)).toEqual(["1", "2"]);
  });

  it("fails closed while the vault's counter is unreadable", async () => {
    const { keeper, sql } = await keeperOver(rpc);
    counted(sql, "unreadable");
    expect((await keeper.health()).pauseRecommended).toBe(true);
    counted(sql, "0");
    expect((await keeper.health()).pauseRecommended).toBe(false);
  });

  it("fails closed once the vault's counter has not been read for a few sweeps", async () => {
    const { keeper, sql } = await keeperOver(rpc);
    counted(sql, "0", Date.now() - 120_000);
    expect((await keeper.health()).pauseRecommended).toBe(false);
    counted(sql, "0", Date.now() - 180_000);
    const h = await keeper.health();
    expect(h.pauseRecommended).toBe(true);
    expect(h.directWithheld?.unresolved).toEqual([]);
    // a counter stored before its read time was: stale as well
    sql.exec("DELETE FROM keeper_state WHERE key = 'ticket_forfeits_withheld_read_at'");
    expect((await keeper.health()).pauseRecommended).toBe(true);
  });

  it("reads the vault every sweep, whichever other step throws", async () => {
    const zeroVault = getVaultDecoder().decode(new Uint8Array(getVaultSize()));
    const vault = getVaultEncoder().encode({ ...zeroVault, ticketForfeitsWithheld: 1n });
    const failing = {
      ...rpc,
      getProgramAccounts: () => ({
        send: async () => {
          throw new Error("getProgramAccounts: 429 Too Many Requests");
        },
      }),
      getAccountInfo: () => ({
        send: async () => ({
          value: { data: [base64(Uint8Array.from(vault)), "base64"], owner: PROGRAM, lamports: 1n },
        }),
      }),
    } as unknown as Rpc;
    const { keeper, sql, call } = await keeperOver(failing);
    counted(sql, "0", Date.now() - 30_000);
    // the sweep's failure is the tick's to log: the counter was read before it
    await call("tick");
    const h = await keeper.health();
    expect(h.pauseRecommended).toBe(true);
    expect(h.directWithheld?.unresolved).toEqual([{ ordinal: "1", ticket: null, refunded: null }]);
  });

  it("reads the vault first, whatever the rest of the alarm has spent of its subrequests", async () => {
    const zeroVault = getVaultDecoder().decode(new Uint8Array(getVaultSize()));
    const vault = getVaultEncoder().encode(zeroVault);
    let reads = 0;
    let gets = 0;
    const { keeper, sql, call, rows } = await keeperOver({
      ...rpc,
      getAccountInfo: () => ({
        send: async () => (
          reads++,
          {
            value: {
              data: [base64(Uint8Array.from(vault)), "base64"],
              owner: PROGRAM,
              lamports: 1n,
            },
          }
        ),
      }),
      getTransaction: () => ({ send: async () => (gets++, null) }),
    } as unknown as Rpc);
    insertTicket(sql, A("Unread"), { expire_sig: sig(3), updated_at: Date.now() });
    // the alarm's subrequests spent but for the margin
    (keeper as unknown as { spent: number }).spent = 47;
    await call("tick");
    expect(reads).toBe(1);
    expect((await keeper.health()).pauseRecommended).toBe(false);
    // the expiry left unread, its tries kept for an alarm that can make the read
    expect(gets).toBe(0);
    expect(rows()[0]!.detail_tries).toBe(0);
  });
});

describe("an Open ticket in its window", () => {
  /** SlotHashes holding `from` ..= `to`, newest first. */
  function slotHashes(from: bigint, to: bigint): Uint8Array {
    const n = Number(to - from + 1n);
    const d = new Uint8Array(8 + n * 40);
    const view = new DataView(d.buffer);
    view.setBigUint64(0, BigInt(n), true);
    for (let i = 0; i < n; i++) view.setBigUint64(8 + i * 40, to - BigInt(i), true);
    return d;
  }
  const holds = (wire: string, bytes: ArrayLike<number>) =>
    Buffer.from(wire, "base64").includes(Buffer.from(Uint8Array.from(bytes)));

  it("has its seed recorded alone when its request is refused, and ORAO's treasury read again", async () => {
    const address = A("OpenTicket");
    const zero = getTicketDecoder().decode(new Uint8Array(859));
    const data = getTicketEncoder().encode({
      ...zero,
      status: TicketStatus.Open,
      openSlot: 1_000n,
      expirySlot: 1_150n,
    });
    const sent: string[] = [];
    const simulated: string[] = [];
    const { keeper, call, sql, rows } = await keeperOver({
      getMultipleAccounts: (list: string[]) => ({
        send: async () => ({
          context: { slot: 1_010n },
          value: list.map((a) =>
            a === address
              ? { data: [base64(Uint8Array.from(data)), "base64"], owner: PROGRAM }
              : a === SLOT_HASHES
                ? { data: [base64(slotHashes(990n, 1_009n)), "base64"], owner: A("Sysvar") }
                : null,
          ),
        }),
      }),
      getLatestBlockhash: () => ({
        send: async () => ({
          value: { blockhash: b58(Array(32).fill(7)), lastValidBlockHeight: 100n },
        }),
      }),
      simulateTransaction: (wire: string) => ({
        send: async () => (simulated.push(wire), { value: { err: null, logs: [] } }),
      }),
      sendTransaction: (wire: string) => ({
        send: async () => {
          sent.push(wire);
          // the request is refused at preflight (ORAO's treasury rotated, say)
          if (!holds(wire, RECORD_TICKET_ENTROPY_DISCRIMINATOR))
            throw new Error("Error Code: TreasuryMismatch");
          return "sig";
        },
      }),
    } as unknown as Rpc);
    const k = keeper as unknown as { treasury: string | null };
    k.treasury = A("OldTreasury");
    insertTicket(sql, address, { state: "queued" });
    await call("advance", rows());

    expect(sent).toHaveLength(2);
    expect(holds(sent[0]!, RECORD_TICKET_ENTROPY_DISCRIMINATOR)).toBe(true);
    expect(simulated).toEqual([sent[0]]);
    const r = rows()[0]!;
    expect([r.state, r.pending_sig, r.attempts]).toEqual(["queued", null, 1]);
    expect(String(r.last_error)).toContain("TreasuryMismatch");
    expect(k.treasury).toBeNull();
  });
});

describe("an expiry the keeper never saw Requested", () => {
  /** A landed transaction whose Fade inner instructions emit `bodies`. */
  const emitting = (...bodies: Uint8Array[]) => ({
    slot: 1n,
    meta: {
      err: null,
      innerInstructions: [
        {
          instructions: bodies.map((body) => ({
            programIdIndex: 1,
            data: b58([...EVENT_IX_TAG, ...body]),
          })),
        },
      ],
    },
    transaction: { message: { accountKeys: [A("Cranker"), PROGRAM] } },
  });

  it("reads its request from the ticket's RandomnessRequested, and the sweep checks it", async () => {
    // the app requested while the keeper was down; a third party expired it, ORAO pending
    const address = A("RequestedByApp");
    const integrator = A("Integrator");
    const request = A("AppRequest");
    const vrfPayer = await vrfPayerPda(address);
    const expired = Uint8Array.from(
      getTicketExpiredEventEncoder().encode({
        version: 2,
        ticket: address,
        integrator,
        forfeited: 49_000_000n,
        requested: true,
        requestFound: true,
        checked: true,
        pending: true,
        refunded: false,
        refund: 0n,
        parked: false,
        ticketForfeitsWithheld: 1n,
      }),
    );
    const requested = Uint8Array.from(
      getRandomnessRequestedEventEncoder().encode({
        version: 2,
        ticket: address,
        request,
        seed: new Uint8Array(32),
        entropySlot: 1_002n,
      }),
    );
    const txs = new Map<string, unknown>([
      [sig(21), emitting(expired)],
      [sig(22), emitting(requested)],
      [sig(23), emitting()],
    ]);
    const swept: string[][] = [];
    const { call, sql, rows } = await keeperOver({
      getSignaturesForAddress: () => ({
        send: async () =>
          [sig(21), sig(22), sig(23)].map((signature) => ({ signature, err: null })),
      }),
      getTransaction: (s: string) => ({ send: async () => txs.get(s) ?? null }),
      getMultipleAccounts: (list: string[]) => ({
        send: async () => (
          swept.push(list),
          { value: list.map((a) => (a === request ? pendingRequest(vrfPayer) : null)) }
        ),
      }),
    } as unknown as Rpc);
    // last read Open: integrator and nonce known, no request
    insertTicket(sql, address, { state: "queued", integrator, nonce: "7", randomness: null });
    await call("resolveClosed", rows()[0]);
    const r = rows()[0]!;
    expect([r.state, r.vrf_sweep, r.randomness]).toEqual(["expired", 1, request]);
    await call("sweepVrfPayers");
    expect(swept.at(-1)).toEqual([vrfPayer, request]);
    // still owed by ORAO: kept queued
    expect(rows()[0]!.vrf_sweep).toBe(1);
  });

  it("reads a late bind's settlement past its RandomnessRequested, in fillClosure and findExpiry", async () => {
    // request_randomness and settle_ticket in one transaction: the request's event comes first
    const bound = A("LateBound");
    const theirs = A("BoundByOther");
    const bind = (ticket: string) =>
      emitting(
        Uint8Array.from(
          getRandomnessRequestedEventEncoder().encode({
            version: 2,
            ticket: ticket as Address,
            request: A("BindRequest"),
            seed: new Uint8Array(32),
            entropySlot: 1_002n,
          }),
        ),
        Uint8Array.from(
          getTicketSettledEventEncoder().encode({
            version: 2,
            ticket: ticket as Address,
            integrator: A("Integrator"),
            outcome: 1,
            payout: 98_000_000n,
            pending: false,
          }),
        ),
      );
    const txs = new Map<string, unknown>([
      [sig(31), bind(bound)],
      [sig(32), bind(theirs)],
      [sig(33), emitting()],
    ]);
    const { call, sql, rows } = await keeperOver({
      getSignaturesForAddress: () => ({
        send: async () => [sig(32), sig(33)].map((signature) => ({ signature, err: null })),
      }),
      getTransaction: (s: string) => ({ send: async () => txs.get(s) ?? null }),
    } as unknown as Rpc);
    // the keeper's own bind: settled, its outcome and payout still to read
    insertTicket(sql, bound, { state: "settled", settle_sig: sig(31), detail_tries: 0 });
    // someone else's bind closed a ticket the keeper last read Open
    insertTicket(sql, theirs, { state: "queued", integrator: A("Integrator"), nonce: "9" });
    const [own, other] = [
      rows().find((r) => r.address === bound)!,
      rows().find((r) => r.address === theirs)!,
    ];
    await call("fillClosure", own, sig(31));
    expect(await call("findExpiry", other)).toBe(true);
    const after = new Map(rows().map((r) => [r.address, r]));
    const o = after.get(bound)!;
    expect([o.state, o.outcome, o.payout, o.detail_tries]).toEqual(["settled", 1, "98000000", 0]);
    const t = after.get(theirs)!;
    expect([t.state, t.settle_sig, t.outcome, t.payout]).toEqual([
      "settled",
      sig(32),
      1,
      "98000000",
    ]);
  });

  it("keeps a row whose request stays unknown queued by its vrf_payer alone, looked up once", async () => {
    const address = A("RequestUnknown");
    let lookups = 0;
    const reads: string[][] = [];
    const { call, sql, rows } = await keeperOver({
      getSignaturesForAddress: () => ({ send: async () => (lookups++, []) }),
      getMultipleAccounts: (list: string[]) => ({
        send: async () => (reads.push(list), { value: list.map(() => null) }),
      }),
    } as unknown as Rpc);
    insertTicket(sql, address, {
      vrf_sweep: 1,
      integrator: A("Integrator"),
      nonce: "8",
      randomness: null,
    });
    await call("sweepVrfPayers");
    await call("sweepVrfPayers");
    expect(lookups).toBe(1);
    expect(reads).toEqual([[await vrfPayerPda(address)], [await vrfPayerPda(address)]]);
    // an empty vrf_payer with a request that may still refund it: not dropped
    expect(rows()[0]!.vrf_sweep).toBe(1);
  });
});

describe("the sweep's listing of the unposted tickets", () => {
  const zeroVault = getVaultDecoder().decode(new Uint8Array(getVaultSize()));
  const vault = Uint8Array.from(getVaultEncoder().encode(zeroVault));
  const vaultRead = {
    getAccountInfo: () => ({
      send: async () => ({
        value: { data: [base64(vault), "base64"], owner: PROGRAM, lamports: 1n },
      }),
    }),
  };

  it("is owed to the next alarm when the sweep's alarm could not afford it", async () => {
    let listings = 0;
    const { keeper, call } = await keeperOver({
      ...vaultRead,
      getProgramAccounts: () => ({ send: async () => (listings++, []) }),
    } as unknown as Rpc);
    const k = keeper as unknown as { spent: number; listingOwed: boolean };
    k.spent = 47;
    await call("tick");
    expect(listings).toBe(0);
    expect(k.listingOwed).toBe(true);
    // the next alarm, the sweep not due again: the listing runs alone
    k.spent = 0;
    await call("tick");
    expect(listings).toBe(1);
    expect(k.listingOwed).toBe(false);
    await call("tick");
    expect(listings).toBe(1);
  });

  it("keeps its subrequest back from the payouts' backfill", async () => {
    let listings = 0;
    let gets = 0;
    const keeperRef: { spent: number }[] = [];
    const { keeper, sql, call } = await keeperOver({
      ...vaultRead,
      getProgramAccounts: () => ({ send: async () => (listings++, []) }),
      // every read the RPC lags on, each one of the alarm's subrequests
      getTransaction: () => ({ send: async () => (gets++, keeperRef[0]!.spent++, null) }),
    } as unknown as Rpc);
    keeperRef.push(keeper as unknown as { spent: number });
    // the alarm's earlier steps spent some: the backfill would take the rest
    keeperRef[0]!.spent = 7;
    for (let i = 0; i < 40; i++)
      insertTicket(sql, A(`settled${String(i).padStart(2, "0")}`), {
        state: "settled",
        settle_sig: sig(100 + i),
      });
    await call("tick");
    expect(gets).toBe(39);
    expect(listings).toBe(1);
  });

  it("draws nothing from the alarm's subrequests for the API's own reads", async () => {
    // a JSON-RPC endpoint: a balance, and no account anywhere
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        const value = method === "getBalance" ? 1 : null;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const keeper = new Keeper(memoryState(), { RPC_URL: url });
      const k = keeper as unknown as Record<string, unknown> & { spent: number };
      k.signerPromise = generateKeyPairSigner();
      await keeper.health();
      await (keeper as unknown as { status(t: string): Promise<unknown> }).status(A("Untracked"));
      expect(k.spent).toBe(0);
      // the alarm's own reads are counted
      await (k.readWithheldCounter as () => Promise<void>).call(keeper);
      expect(k.spent).toBe(1);
    } finally {
      server.close();
    }
  });
});
