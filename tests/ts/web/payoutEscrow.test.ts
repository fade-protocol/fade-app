// A payout parked at settlement: whether the beneficiary could receive it now, as the program's
// `can_receive` reads a token account, and whether the Dashboard offers a claim.
import {
  fetchEncodedAccounts,
  getAddressDecoder,
  getAddressEncoder,
  type Address,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import {
  getRoundTicketEncoder,
  RoundTicketStatus,
  TicketStatus,
  type RoundTicket,
  type Ticket,
} from "../../../clients/js/src/generated/fade";
import { PROGRAM, TOKEN_PROGRAM, USDC_MINT } from "../../../apps/web/src/lib/config.ts";
import {
  escrowOf,
  parkedPayouts,
  readEscrows,
  receiverOf,
  roundDestination,
  roundEscrowOf,
} from "../../../apps/web/src/lib/payoutEscrow.ts";
import type { TicketRow, TicketEnd } from "../../../apps/web/src/lib/ticketLog.ts";

// The escrow reads go through `fetchEncodedAccounts`, answered by each test.
vi.mock("@solana/kit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/kit")>()),
  fetchEncodedAccounts: vi.fn(),
}));

const OTHER_MINT = "So11111111111111111111111111111111111111112" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;

/** An SPL token account of `mint` in `state` (1 initialised, 2 frozen). */
function tokenAccount(mint: Address, state: number, len = 165) {
  const data = new Uint8Array(len);
  data.set(getAddressEncoder().encode(mint), 0);
  if (len > 108) data[108] = state;
  return { programAddress: TOKEN_PROGRAM, data };
}

/** A valid address from one repeated byte. */
const addr = (b: number) => getAddressDecoder().decode(new Uint8Array(32).fill(b));
/** The wallet's USDC account, and another app's that funded a ticket for it. */
const WALLET = addr(1);
const FUNDER = addr(2);

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

describe("roundEscrowOf", () => {
  const roundTicket = (status: RoundTicketStatus) =>
    ({
      status,
      beneficiary: "winner" as Address,
      refundTo: "funder" as Address,
      payout: 100_000n,
    }) as unknown as RoundTicket;
  it("claims a parked payout to its beneficiary and a parked return to its funder", () => {
    expect(roundDestination(roundTicket(RoundTicketStatus.PayoutParked))).toBe("winner");
    expect(roundDestination(roundTicket(RoundTicketStatus.ReturnParked))).toBe("funder");
  });
  it("is claimable, created first, blocked or claimed as a direct ticket's", () => {
    for (const status of [RoundTicketStatus.PayoutParked, RoundTicketStatus.ReturnParked]) {
      const t = roundTicket(status);
      expect(roundEscrowOf(t, "ok", false)).toEqual({
        state: "claimable",
        createAccount: false,
        roundTicket: t,
      });
      expect(roundEscrowOf(t, "missing", true)).toEqual({
        state: "claimable",
        createAccount: true,
        roundTicket: t,
      });
      expect(roundEscrowOf(t, "missing", false)).toEqual({
        state: "blocked",
        receiver: "missing",
      });
      expect(roundEscrowOf(t, "frozen", true)).toEqual({ state: "blocked", receiver: "frozen" });
    }
    // closed by claim_round_payout: delivered
    expect(roundEscrowOf(null, "ok", true)).toEqual({ state: "claimed" });
    expect(roundEscrowOf(roundTicket(RoundTicketStatus.Joined), "ok", true)).toBeNull();
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
    expect(parkedPayouts(rows, WALLET).map((r) => r.ticket)).toEqual(["a"]);
  });
  it("keeps a beacon ticket's parked payout and its parked return, claimed from its round ticket", () => {
    const beacon = (t: string, end: Partial<TicketEnd>, refundTo = WALLET) => ({
      ...row(t, end),
      beacon: {
        round: "r" as Address,
        payoutTable: "p" as Address,
        refundTo,
        appShare: 0n,
        protocolShare: 0n,
      },
    });
    const rows = [
      beacon("win", { payout: 2_000_000n, pending: true }),
      beacon("back", { kind: "expired", refunded: true, pending: true }),
      beacon("returned", { kind: "expired", refunded: true, pending: false }),
      beacon("forfeit", { kind: "expired", pending: true }),
      // another app funded it for the wallet: the parked price is that app's to claim
      beacon("theirs", { kind: "expired", refunded: true, pending: true }, FUNDER),
      row("a", { payout: 1n, pending: true }),
    ];
    expect(parkedPayouts(rows, WALLET).map((r) => r.ticket)).toEqual(["win", "back", "a"]);
  });
});

describe("readEscrows", () => {
  /** A beacon ticket's row, refunded with its price parked for `refundTo`. */
  const parkedReturn = (t: Address, refundTo: Address) =>
    ({
      ticket: t,
      beneficiary: WALLET,
      end: { kind: "expired", payout: 0n, pending: true, refunded: true, at: null, signature: "s" },
      beacon: {
        round: addr(9),
        payoutTable: addr(8),
        refundTo,
        appShare: 0n,
        protocolShare: 0n,
      },
    }) as unknown as TicketRow;
  /** The round ticket on chain, its price parked for `refundTo`. */
  const roundTicketAccount = (refundTo: Address) => ({
    exists: true,
    programAddress: PROGRAM,
    data: new Uint8Array(
      getRoundTicketEncoder().encode({
        version: 1,
        bump: 255,
        status: RoundTicketStatus.ReturnParked,
        round: 1n,
        integrator: addr(7),
        nonce: 0n,
        payer: addr(6),
        funder: addr(5),
        refundTo,
        beneficiary: WALLET,
        payoutTable: addr(8),
        price: 100_000n,
        vaultCredit: 99_800n,
        payoutMax: 195_600n,
        liability: 0n,
        protocolShare: 0n,
        appShare: 0n,
        prepay: 0n,
        settleShare: 0n,
        payout: 100_000n,
      }),
    ),
  });

  it("offers no claim of a parked return that pays the app that funded it, only the wallet's own", async () => {
    const theirs = addr(3);
    const mine = addr(4);
    const fetch = vi.mocked(fetchEncodedAccounts);
    fetch.mockReset();
    const reads: Address[][] = [];
    fetch.mockImplementation((async (_rpc: unknown, addresses: Address[]) => {
      reads.push(addresses);
      return addresses.map((a) =>
        a === mine ? roundTicketAccount(WALLET) : { exists: true, ...tokenAccount(USDC_MINT, 1) },
      );
    }) as unknown as typeof fetchEncodedAccounts);
    const escrows = await readEscrows(
      [parkedReturn(theirs, FUNDER), parkedReturn(mine, WALLET)],
      WALLET,
    );
    // the other app's return is never read, nor offered: only the wallet's ticket and account
    expect(reads).toEqual([[mine], [WALLET]]);
    expect([...escrows.keys()]).toEqual([mine]);
    expect(escrows.get(mine)).toMatchObject({ state: "claimable", createAccount: false });
    // a wallet sees no claim at all when every parked return is another funder's
    reads.length = 0;
    expect((await readEscrows([parkedReturn(theirs, FUNDER)], WALLET)).size).toBe(0);
    expect(reads).toEqual([]);
  });
});
