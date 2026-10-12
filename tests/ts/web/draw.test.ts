// A draw's page, the target of a share card's QR code: its link and route, the ticket read back
// from its transactions' events in any order, and the words the page shows for every ending.
import type { Address, Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  drawOfTxs,
  drawViewOf,
  drawnAt,
  wonTitle,
  type TicketTx,
} from "../../../apps/web/src/lib/draw.ts";
import { DRAW_PATH, drawRouteOf, drawUrl } from "../../../apps/web/src/lib/drawLink.ts";
import type { FadeEvent } from "../../../apps/web/src/lib/events.ts";
import { odds } from "../../../apps/web/src/lib/format.ts";
import { payout } from "../../../apps/web/src/lib/math.ts";
import {
  PACK_TICKETS,
  PREMIUM,
  boosterPayoutTableAt,
  boosterPayouts,
  checkoutPayoutTableFor,
  type CheckoutBack,
} from "../../../apps/web/src/lib/payoutTables.ts";
import { finderOrigins, inFinder, logoSpan, qrMatrix } from "../../../apps/web/src/lib/qr.ts";
import { oddsOf, type TicketRow } from "../../../apps/web/src/lib/ticketLog.ts";
import { T0, USDC, ticketRow } from "./fixtures.ts";

const TICKET = "13uJdCsEg4J94KDNRPbsUCWQwYdhuG3ARvgLcUD5CfN8" as Address;
const REQUEST = "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y" as Address;
const OPEN = "open" as Signature;
const DRAW = "draw" as Signature;

describe("the draw's link", () => {
  it("is the app's /w/ path and the ticket address", () => {
    expect(drawUrl(TICKET)).toBe(`https://app.fade.finance/w/${TICKET}`);
    expect(new URL(drawUrl(TICKET)).pathname).toBe(`${DRAW_PATH}${TICKET}`);
  });

  it("parses a ticket address, and tells an invalid one from another page", () => {
    expect(drawRouteOf(`/w/${TICKET}`)).toEqual({ ticket: TICKET });
    expect(drawRouteOf(`/w/${TICKET}/`)).toEqual({ ticket: TICKET });
    expect(drawRouteOf("/w/")).toEqual({ ticket: null });
    expect(drawRouteOf(`/w/${TICKET.slice(0, 30)}`)).toEqual({ ticket: null });
    expect(drawRouteOf("/w/not-an-address")).toEqual({ ticket: null });
    expect(drawRouteOf(`/w/${TICKET}0`)).toEqual({ ticket: null });
    expect(drawRouteOf("/")).toBeNull();
    expect(drawRouteOf("/vault")).toBeNull();
    expect(drawRouteOf(`/wallet/${TICKET}`)).toBeNull();
  });

  it("makes a QR code at level H whose centre the logo covers by a small odd square", () => {
    const m = qrMatrix(drawUrl(TICKET));
    const n = m.length;
    expect(n).toBe(qrMatrix(drawUrl(TICKET), "H").length);
    expect(n).toBeGreaterThan(qrMatrix(drawUrl(TICKET), "M").length);
    const { from, span } = logoSpan(n);
    expect(span % 2).toBe(1);
    expect(from * 2 + span).toBe(n);
    // well inside level H's 30%: the logo never reaches a finder
    expect((span * span) / (n * n)).toBeLessThan(0.07);
    for (const [r0, c0] of finderOrigins(n)) {
      expect(inFinder(r0, c0, n) && inFinder(r0 + 6, c0 + 6, n)).toBe(true);
      expect(inFinder(from, from, n)).toBe(false);
    }
    expect(inFinder(7, 7, n)).toBe(false);
  });
});

// --- reading a ticket back from its events ---------------------------------------------------

const opened = (r: TicketRow): FadeEvent => ({
  kind: "TicketOpened",
  data: {
    version: 1,
    ticket: r.ticket,
    integrator: r.integrator,
    nonce: 0n,
    beneficiary: r.beneficiary,
    price: r.price,
    vaultCredit: r.vaultCredit,
    payoutMax: r.payoutMax,
    reservedLiability: r.payoutMax,
    cap: r.payoutMax,
    marginBps: r.marginBps,
    appShareBps: r.appShareBps,
    openSlot: 100n,
  },
});
const requested: FadeEvent = {
  kind: "RandomnessRequested",
  data: {
    version: 1,
    ticket: TICKET,
    request: REQUEST,
    seed: new Uint8Array(32),
    entropySlot: 101n,
  },
};
const settled = (paid: bigint, pending = false): FadeEvent =>
  ({
    kind: "TicketSettled",
    data: { version: 1, ticket: TICKET, integrator: "i", outcome: 0, payout: paid, pending },
  }) as unknown as FadeEvent;

const tx = (signature: Signature, blockTime: number, ...events: FadeEvent[]): TicketTx => ({
  signature,
  blockTime,
  events,
});

describe("drawOfTxs", () => {
  const row = ticketRow({ ticket: TICKET, price: 2n * USDC, payoutMax: 200n * USDC });

  it("rebuilds the ticket from newest-first transactions, with its draw and randomness", () => {
    const d = drawOfTxs(TICKET, [
      tx(DRAW, T0 + 9, settled(200n * USDC)),
      tx("req" as Signature, T0 + 2, requested),
      tx(OPEN, T0, opened(row)),
    ])!;
    expect(d.randomness).toBe(REQUEST);
    expect(d.row.price).toBe(2n * USDC);
    expect(d.row.openedAt).toBe(T0);
    expect(d.row.openSig).toBe(OPEN);
    expect(d.row.end).toEqual({
      kind: "settled",
      payout: 200n * USDC,
      pending: false,
      at: T0 + 9,
      signature: DRAW,
    });
  });

  it("ignores other tickets' events and finds nothing without an opening", () => {
    const other = ticketRow({ ticket: REQUEST });
    expect(drawOfTxs(TICKET, [tx(OPEN, T0, opened(other))])).toBeNull();
    expect(drawOfTxs(TICKET, [tx(DRAW, T0, settled(USDC))])).toBeNull();
    expect(drawOfTxs(TICKET, [])).toBeNull();
    const d = drawOfTxs(TICKET, [tx(OPEN, T0, opened(row))])!;
    expect(d.row.end).toBeNull();
    expect(d.randomness).toBeNull();
  });

  it("reads an expiry as an ending with no payout", () => {
    const expired = {
      kind: "TicketExpired",
      data: { version: 1, ticket: TICKET },
    } as unknown as FadeEvent;
    const d = drawOfTxs(TICKET, [tx(DRAW, T0 + 90, expired), tx(OPEN, T0, opened(row))])!;
    expect(d.row.end?.kind).toBe("expired");
    expect(d.row.end?.payout).toBe(0n);
  });
});

// --- what the page shows ---------------------------------------------------------------------

const end = (paid: bigint, pending = false) => ({
  kind: "settled" as const,
  payout: paid,
  pending,
  at: T0,
  signature: DRAW,
});
const checkoutRow = (back: CheckoutBack, price: bigint) => {
  const max = payout(price, checkoutPayoutTableFor(back)(price)[0]!.m);
  return ticketRow({ ticket: TICKET, price, payoutMax: max, end: end(max) });
};
const pack = 5n * USDC;
const addOn = pack / PACK_TICKETS;
const [premiumValue, secondValue] = boosterPayouts(pack);
const booster = (paid: bigint) =>
  ticketRow({ ticket: TICKET, price: addOn, payoutMax: addOn * 500n, end: end(paid) });

describe("drawViewOf", () => {
  it("says what a checkout win brought back, the amount, the price and the odds", () => {
    const words: Record<CheckoutBack, string> = {
      whole: "Order came back free",
      half: "Half the order came back",
      tenth: "10% of the order came back",
    };
    for (const back of ["whole", "half", "tenth"] as const) {
      const r = checkoutRow(back, 2_850_000n);
      const v = drawViewOf(r, REQUEST);
      expect(v.state).toBe("won");
      expect(v.title).toBe(words[back]);
      expect(v.amount).toMatch(/^\+[\d,]+\.\d\d USDC$/);
      expect(v.price).toBe("2.85 USDC");
      expect(v.oneIn).toBe(oddsOf(r));
      expect(v.at?.getTime()).toBe(T0 * 1000);
      expect(v.drawSig).toBe(DRAW);
      expect(v.randomness).toBe(REQUEST);
    }
  });

  it("names a swap's and a booster's win, with the odds of the booster's own extra", () => {
    const swap = ticketRow({ ticket: TICKET, end: end(2n * USDC) });
    expect(drawViewOf(swap, null).title).toBe("This trade was free");
    const premium = drawViewOf(booster(premiumValue!), null);
    expect(premium.title).toBe("Premium pack");
    const table = boosterPayoutTableAt(pack, booster(premiumValue!).marginBps);
    expect(premium.oneIn).toBe(odds(table[PREMIUM]!.p).oneIn);
    expect(drawViewOf(booster(secondValue!), null).title).toBe("Second pack");
    expect(wonTitle({ price: addOn, payoutMax: addOn * 500n }, premiumValue!)).toBe("Premium pack");
  });

  it("rounds the odds so they never read better than the table", () => {
    const r = checkoutRow("whole", 2_850_000n);
    const n = Number(
      drawViewOf(r, null)
        .oneIn!.replace(/^1 in /, "")
        .replace(/,/g, ""),
    );
    expect(Number.isInteger(n)).toBe(true);
    expect(drawViewOf(r, null).oneIn).toBe(oddsOf(r));
  });

  it("words a draw that paid nothing, one never drawn and one still drawing", () => {
    const lost = drawViewOf(ticketRow({ ticket: TICKET, end: end(0n) }), REQUEST);
    expect(lost).toMatchObject({
      state: "lost",
      title: "Not this time",
      amount: null,
      drawSig: DRAW,
    });
    const expired = drawViewOf(
      ticketRow({ ticket: TICKET, end: { ...end(0n), kind: "expired" } }),
      null,
    );
    expect(expired).toMatchObject({ state: "expired", title: "No draw in time", amount: null });
    const drawing = drawViewOf(ticketRow({ ticket: TICKET }), null);
    expect(drawing).toMatchObject({ state: "drawing", title: "Still drawing", drawSig: null });
    expect(drawing.at?.getTime()).toBe((T0 - 60) * 1000);
  });

  it("flags a payout waiting in escrow", () => {
    const r = checkoutRow("whole", USDC);
    expect(drawViewOf({ ...r, end: { ...r.end!, pending: true } }, null).pending).toBe(true);
    expect(drawViewOf(r, null).pending).toBe(false);
  });

  it("keeps to the product's words", () => {
    const views = [
      ...(["whole", "half", "tenth"] as const).map((b) => drawViewOf(checkoutRow(b, USDC), null)),
      drawViewOf(booster(premiumValue!), null),
      drawViewOf(ticketRow({ ticket: TICKET, end: end(0n) }), null),
    ];
    for (const v of views) {
      const text = [v.title, v.amount, v.price, v.oneIn].join(" ");
      expect(text).not.toMatch(/refund|jackpot|bet|stake|—|·/i);
    }
  });
});

describe("drawnAt", () => {
  it("writes the day and the time", () => {
    expect(drawnAt(new Date(2026, 9, 9, 13, 5))).toBe("9 Oct 2026, 13:05");
  });
});
