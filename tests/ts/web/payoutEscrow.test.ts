// A payout parked at settlement: whether the beneficiary could receive it now, as the program's
// `can_receive` reads a token account, and whether the Dashboard offers a claim.
import { getAddressEncoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { TicketStatus, type Ticket } from "../../../clients/js/src/generated/fade";
import { TOKEN_PROGRAM, USDC_MINT } from "../../../apps/web/src/lib/config.ts";
import { escrowOf, parkedPayouts, receiverOf } from "../../../apps/web/src/lib/payoutEscrow.ts";
import type { TicketRow, TicketEnd } from "../../../apps/web/src/lib/ticketLog.ts";

const OTHER_MINT = "So11111111111111111111111111111111111111112" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;

/** An SPL token account of `mint` in `state` (1 initialised, 2 frozen). */
function tokenAccount(mint: Address, state: number, len = 165) {
  const data = new Uint8Array(len);
  data.set(getAddressEncoder().encode(mint), 0);
  if (len > 108) data[108] = state;
  return { programAddress: TOKEN_PROGRAM, data };
}

const ticket = (status: TicketStatus) => ({ status, payout: 5_000_000n }) as unknown as Ticket;

describe("receiverOf", () => {
  it("reads an initialised USDC account as able to receive", () => {
    expect(receiverOf(tokenAccount(USDC_MINT, 1), USDC_MINT)).toBe("ok");
  });
  it("tells a missing account from a frozen one", () => {
    expect(receiverOf(null, USDC_MINT)).toBe("missing");
    expect(receiverOf(tokenAccount(USDC_MINT, 2), USDC_MINT)).toBe("frozen");
  });
  it("refuses another mint, another owner program, a wrong size or an uninitialised account", () => {
    expect(receiverOf(tokenAccount(OTHER_MINT, 1), USDC_MINT)).toBe("unusable");
    expect(
      receiverOf({ programAddress: SYSTEM, data: tokenAccount(USDC_MINT, 1).data }, USDC_MINT),
    ).toBe("unusable");
    expect(receiverOf(tokenAccount(USDC_MINT, 1, 170), USDC_MINT)).toBe("unusable");
    expect(receiverOf(tokenAccount(USDC_MINT, 0), USDC_MINT)).toBe("unusable");
  });
});

describe("escrowOf", () => {
  const pending = ticket(TicketStatus.PayoutPending);
  it("is claimable when the ticket still holds the payout and the account can receive", () => {
    expect(escrowOf(pending, "ok", true)).toEqual({
      state: "claimable",
      createAccount: false,
      ticket: pending,
    });
    // permissionless: another beneficiary's ready account is claimable too
    expect(escrowOf(pending, "ok", false)?.state).toBe("claimable");
  });
  it("creates the wallet's own USDC account first when it is missing, never someone else's", () => {
    expect(escrowOf(pending, "missing", true)).toEqual({
      state: "claimable",
      createAccount: true,
      ticket: pending,
    });
    expect(escrowOf(pending, "missing", false)).toEqual({ state: "blocked", receiver: "missing" });
  });
  it("is blocked while the account is frozen or not a USDC account", () => {
    expect(escrowOf(pending, "frozen", true)).toEqual({ state: "blocked", receiver: "frozen" });
    expect(escrowOf(pending, "unusable", true)).toEqual({ state: "blocked", receiver: "unusable" });
  });
  it("is claimed once the ticket account is closed", () => {
    expect(escrowOf(null, "ok", true)).toEqual({ state: "claimed" });
  });
  it("offers nothing for a ticket not waiting on a payout", () => {
    expect(escrowOf(ticket(TicketStatus.Requested), "ok", true)).toBeNull();
    expect(escrowOf(ticket(TicketStatus.Open), "ok", true)).toBeNull();
  });
});

describe("parkedPayouts", () => {
  const row = (t: string, end: Partial<TicketEnd> | null) =>
    ({
      ticket: t as Address,
      end: end ? ({ kind: "settled", payout: 0n, pending: false, ...end } as TicketEnd) : null,
    }) as TicketRow;
  it("keeps settled wins that wait in escrow, and only those", () => {
    const rows = [
      row("a", { payout: 2_000_000n, pending: true }),
      row("b", { payout: 2_000_000n, pending: false }),
      row("c", { payout: 0n, pending: true }),
      row("d", { kind: "expired", pending: true, payout: 1n }),
      row("e", null),
    ];
    expect(parkedPayouts(rows).map((r) => r.ticket)).toEqual(["a"]);
  });
});
