// A direct ticket refunded its vault credit (`refund_expired_ticket`: its seed never recorded and
// no longer provable): every reader shows it as a refund, never as a forfeiture the vault kept
// nor as a win. The app's rows and lines (lib/ticketRows, ticketWords, draw), the wallet's
// figures (lib/dashboard, payoutEscrow), and the keeper's vault index (vaultIndex.ts), which
// carries the refund and whether it waits in escrow.
import type { Address, Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { getTicketExpiredEventEncoder } from "../../../clients/js/src/generated/fade/index.ts";
import type { TicketExpiredRecord } from "../../../clients/js/src/direct/index.ts";
import type { FadeEvent } from "../../../apps/web/src/lib/events.ts";
import { ticketLogOf, type TicketRow } from "../../../apps/web/src/lib/ticketLog.ts";
import { buyerLine, noDrawWords, vaultLine } from "../../../apps/web/src/lib/ticketWords.ts";
import { drawOfTxs, drawViewOf } from "../../../apps/web/src/lib/draw.ts";
import { ticketStats } from "../../../apps/web/src/lib/dashboard.ts";
import { parkedPayouts } from "../../../apps/web/src/lib/payoutEscrow.ts";
import { feedTicketOf, vaultEventsOf } from "../../../apps/keeper/src/vaultIndex.ts";
import { EVENT_IX_TAG, PROGRAM } from "../../../apps/keeper/src/chain.ts";
import { getBase58Decoder } from "@solana/kit";

const A = (s: string) => s.padEnd(32, "1") as Address;
const USDC = 1_000_000n;
const T0 = 1_800_000_000;
// real addresses: the keeper decodes them from the event bytes
const TICKET = "SysvarRent111111111111111111111111111111111" as Address;
const INTEGRATOR = "SysvarC1ock11111111111111111111111111111111" as Address;
const BENEFICIARY = A("buyer");
const PRICE = 50n * USDC;
const CREDIT = 49n * USDC;

const expiredEvent = (refunded: boolean, parked: boolean): TicketExpiredRecord => ({
  version: 2,
  ticket: TICKET,
  integrator: INTEGRATOR,
  forfeited: refunded ? 0n : CREDIT,
  requested: false,
  requestFound: false,
  checked: !refunded,
  pending: false,
  refunded,
  refund: refunded ? CREDIT : 0n,
  parked,
  ticketForfeitsWithheld: refunded ? 1n : 0n,
});
const opened: FadeEvent = {
  kind: "TicketOpened",
  data: {
    version: 1,
    ticket: TICKET,
    integrator: INTEGRATOR,
    nonce: 0n,
    beneficiary: BENEFICIARY,
    price: PRICE,
    vaultCredit: CREDIT,
    payoutMax: 98n * USDC,
    reservedLiability: 98n * USDC,
    cap: 98n * USDC,
    marginBps: 200n,
    appShareBps: 0n,
    openSlot: 100n,
  },
} as unknown as FadeEvent;
const expired = (refunded: boolean, parked = false): FadeEvent =>
  ({ kind: "TicketExpired", data: expiredEvent(refunded, parked) }) as FadeEvent;

/** The row the app reads of an opening and an expiry. */
function rowOf(end: FadeEvent): TicketRow {
  const sigs = [
    { signature: "end" as Signature, blockTime: T0 + 200 },
    { signature: "open" as Signature, blockTime: T0 },
  ];
  const known = new Map([
    ["open" as Signature, { events: [opened] }],
    ["end" as Signature, { events: [end] }],
  ]);
  return ticketLogOf(sigs, known, 100, 0).rows[0]!;
}

describe("a direct ticket refunded its credit", () => {
  it("ends as a refund of its credit, parked or not", () => {
    expect(rowOf(expired(true)).end).toMatchObject({
      kind: "expired",
      payout: CREDIT,
      pending: false,
      creditReturned: true,
    });
    expect(rowOf(expired(true, true)).end).toMatchObject({ pending: true, creditReturned: true });
    const forfeited = rowOf(expired(false)).end!;
    expect([forfeited.payout, forfeited.creditReturned]).toEqual([0n, undefined]);
  });

  it("reads as a cancelled draw, never as refunded, what the vault kept nor a win", () => {
    const r = rowOf(expired(true));
    const vault = vaultLine(r, false);
    expect(vault.tone).not.toBe("kept");
    expect(vault).toMatchObject({ amount: "49.00 back", tone: "muted" });
    expect(vault.detail).toContain("draw cancelled");
    const buyer = buyerLine(r, false);
    expect(buyer.amount).toBe("49.00 back");
    expect(buyer.detail).toContain("draw cancelled");
    expect(noDrawWords(r.end!)).toBe("draw cancelled");
    // "refunded" next to a checkout reads as the order refunded, while the sale stands
    for (const words of [vault.detail, buyer.detail, noDrawWords(r.end!)])
      expect(words).not.toMatch(/refund/i);
    const parked = rowOf(expired(true, true));
    expect(vaultLine(parked, false).amount).toBe("49.00 to claim");
    expect(buyerLine(parked, false).detail).toContain("waits to be claimed");
    // a forfeiture still reads as one
    const kept = vaultLine(rowOf(expired(false)), false);
    expect([kept.tone, kept.amount]).toEqual(["kept", "+49.00"]);
  });

  it("shows on its draw page as a cancelled draw, with the credit back or to claim", () => {
    const d = drawOfTxs(TICKET, [
      { signature: "end" as Signature, blockTime: T0 + 200, events: [expired(true)] },
      { signature: "open" as Signature, blockTime: T0, events: [opened] },
    ])!;
    expect(drawViewOf(d.row, null)).toMatchObject({
      state: "expired",
      title: "Draw cancelled",
      amount: "49.00 USDC back",
      pending: false,
      creditReturned: true,
    });
    const parked = drawOfTxs(TICKET, [
      { signature: "end" as Signature, blockTime: T0 + 200, events: [expired(true, true)] },
      { signature: "open" as Signature, blockTime: T0, events: [opened] },
    ])!;
    expect(drawViewOf(parked.row, null)).toMatchObject({
      amount: "49.00 USDC to claim",
      pending: true,
      creditReturned: true,
    });
  });

  it("counts in the wallet's figures as its price less the credit back, no win", () => {
    const s = ticketStats([rowOf(expired(true))], () => false);
    expect([s.wins, s.won, s.spent]).toEqual([0, 0n, PRICE - CREDIT]);
  });

  it("is a claim of the wallet's while it waits in escrow", () => {
    expect(parkedPayouts([rowOf(expired(true, true))], A("buyerUsdc"))).toHaveLength(1);
    expect(parkedPayouts([rowOf(expired(true))], A("buyerUsdc"))).toHaveLength(0);
  });
});

describe("the keeper's vault index", () => {
  const b58 = (bytes: ArrayLike<number>) => getBase58Decoder().decode(Uint8Array.from(bytes));
  const tx = (e: TicketExpiredRecord) => ({
    meta: {
      err: null,
      innerInstructions: [
        {
          instructions: [
            {
              programIdIndex: 1,
              data: b58([
                ...EVENT_IX_TAG,
                ...getTicketExpiredEventEncoder().encode(
                  e as Parameters<ReturnType<typeof getTicketExpiredEventEncoder>["encode"]>[0],
                ),
              ]),
            },
          ],
        },
      ],
    },
    transaction: { message: { accountKeys: [A("payer"), PROGRAM] } },
  });

  it("carries the refund and whether it is parked", () => {
    expect(vaultEventsOf(tx(expiredEvent(true, true)), PROGRAM)).toEqual([
      {
        kind: "expired",
        ticket: TICKET,
        integrator: INTEGRATOR,
        refund: CREDIT,
        refunded: true,
        parked: true,
      },
    ]);
  });

  it("serves the feed's end as a credit returned", () => {
    const t = feedTicketOf(
      {
        ticket: TICKET,
        integrator: INTEGRATOR,
        beacon: false,
        opened: null,
        end: {
          kind: "expired",
          payout: CREDIT,
          pending: true,
          refunded: false,
          creditReturned: true,
          at: T0,
          signature: "end",
        },
        claimed: false,
      },
      new Map(),
    );
    expect(t.end).toMatchObject({
      payout: CREDIT.toString(),
      pending: true,
      refunded: false,
      creditReturned: true,
    });
  });
});

describe("the demos' payout flow", async () => {
  const { expiredWords, refundEndOf } =
    await import("../../../apps/web/src/demos/useTicketFlow.ts");
  const { expiryEnd, isParkedRefund } = await import("../../../apps/web/src/lib/ticket.ts");
  const { REFUND_OUTCOME, TicketStatus } =
    await import("../../../clients/js/src/generated/fade/index.ts");

  it("ends a refunded ticket as a refund of its credit, not as a forfeiture", () => {
    expect(expiryEnd(expiredEvent(true, true), "end" as Signature)).toEqual({
      kind: "expired",
      signature: "end",
      refund: { amount: CREDIT, pending: true },
    });
    expect(expiryEnd(expiredEvent(false, false), "end" as Signature)).toEqual({
      kind: "expired",
      signature: "end",
    });
    expect(expiredWords({ refund: { amount: CREDIT, pending: false } })).toBe(
      "No draw in time: 49.00 USDC of the ticket came back to your wallet.",
    );
    expect(expiredWords({ refund: { amount: CREDIT, pending: true } })).toContain("escrow");
    expect(expiredWords({ refund: null })).toContain("stays with the vault");
  });

  it("ends a ticket the keeper reports refunded as a refund when its event is not readable", () => {
    const sig = "end" as Signature;
    type View = Parameters<typeof refundEndOf>[2];
    const open = (status: number, outcome = 0, payout = 0n) =>
      ({ gone: false, slot: 1n, fulfilled: false, ticket: { status, outcome, payout } }) as View;
    // parked: the ticket waits in escrow as a refund
    expect(
      refundEndOf(sig, {}, open(TicketStatus.PayoutPending, REFUND_OUTCOME, CREDIT), null),
    ).toEqual({ kind: "expired", signature: sig, refund: { amount: CREDIT, pending: true } });
    // closed, its end unreadable too: the keeper's payout, else the ticket's vault credit
    const gone = { gone: true, slot: 1n, end: null } as View;
    expect(refundEndOf(sig, { payout: CREDIT }, gone, null)?.refund).toEqual({
      amount: CREDIT,
      pending: false,
    });
    expect(refundEndOf(sig, {}, gone, { vaultCredit: CREDIT })?.refund).toEqual({
      amount: CREDIT,
      pending: false,
    });
    // the chain unreadable (a rate-limited read): followed further, never told delivered on the
    // keeper's word, whose payout on a refunded row is a parked refund's
    expect(refundEndOf(sig, { payout: CREDIT }, null, { vaultCredit: CREDIT })).toBeNull();
    expect(refundEndOf(sig, {}, null, { vaultCredit: CREDIT })).toBeNull();
    // a lagging node still shows it Open, or nothing tells the amount: followed further
    expect(refundEndOf(sig, { payout: CREDIT }, open(TicketStatus.Open), null)).toBeNull();
    expect(refundEndOf(sig, {}, gone, null)).toBeNull();
  });

  it("tells a refund parked in escrow from a settlement parked on outcome 0", () => {
    expect(isParkedRefund({ status: TicketStatus.PayoutPending, outcome: REFUND_OUTCOME })).toBe(
      true,
    );
    expect(isParkedRefund({ status: TicketStatus.PayoutPending, outcome: 0 })).toBe(false);
    expect(isParkedRefund({ status: TicketStatus.Open, outcome: REFUND_OUTCOME })).toBe(false);
  });
});

describe("an Open ticket past its window, in the demos", async () => {
  const { drawDetailShown, drawState, takeOverOffered } =
    await import("../../../apps/web/src/demos/useTicketFlow.ts");
  type Flow = import("../../../apps/web/src/demos/useTicketFlow.ts").FlowState;
  const following: Flow = {
    phase: "drawing",
    driver: "keeper",
    stalled: false,
    windowClosed: true,
    detail: "No draw in its window: waiting for the ticket to close",
    refund: null,
  } as Partial<Flow> as Flow;

  it("says why it waits, with nothing offered to sign", () => {
    expect(drawDetailShown(following)).toBe(true);
    expect(drawState(following)).toBe("Closing");
    expect(drawDetailShown({ ...following, windowClosed: false })).toBe(false);
    expect(drawState({ ...following, windowClosed: false })).toBe("Drawing");
  });

  it("offers only to keep watching once it stops following it, no wallet take-over", () => {
    const stopped = { ...following, phase: "failed", failedAt: "drawing" } as Flow;
    expect(takeOverOffered(stopped)).toBe(false);
    // a draw stopped in its window still offers the wallet to finish it
    expect(takeOverOffered({ ...stopped, windowClosed: false })).toBe(true);
  });
});
