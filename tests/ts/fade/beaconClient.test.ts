// Unit tests of the beacon client's pure helpers: the transaction format
// chosen from the feature gate, the v1 and v0 messages it builds, and round
// resolution in each of its cases (Spec 08 §13.5.2).
import { describe, expect, it } from "vitest";
import { address, createNoopSigner, getBase64Decoder, type Address } from "@solana/kit";
import { RoundStatus, type Round } from "../../../clients/js/src/generated/fade/index.ts";
import {
  COMPUTE_BUDGET_PROGRAM,
  TRANSACTION_V1_FEATURE,
  USAGE_SCALE,
  beaconTransactionMessage,
  featureActivationSlot,
  findOraoNetworkStatePda,
  findRoundPda,
  getBeaconRefundInstructionAsync,
  measure,
  resolveJoinRound,
  roundAcceptsJoins,
  roundDrawDoomed,
  transactionFormatFor,
} from "../../../clients/js/src/beacon/index.ts";

const FEATURE_OWNER = address("Feature111111111111111111111111111111111111");

function rpcWith(accounts: Record<string, { data: Uint8Array; owner: Address } | null>) {
  return {
    getAccountInfo: (a: Address) => ({
      send: async () => {
        const acc = accounts[a] ?? null;
        return {
          value: acc
            ? { data: [getBase64Decoder().decode(acc.data), "base64"], owner: acc.owner }
            : null,
        };
      },
    }),
  };
}

function featureData(slot: bigint | null): Uint8Array {
  const d = new Uint8Array(9);
  if (slot !== null) {
    d[0] = 1;
    new DataView(d.buffer).setBigUint64(1, slot, true);
  }
  return d;
}

describe("transaction format", () => {
  it("is v1 once SIMD-0385 is active, v0 otherwise", async () => {
    const active = rpcWith({
      [TRANSACTION_V1_FEATURE]: { data: featureData(447_120_000n), owner: FEATURE_OWNER },
    });
    expect(await featureActivationSlot(active, TRANSACTION_V1_FEATURE)).toBe(447_120_000n);
    expect(await transactionFormatFor(active)).toBe(1);
    // Proposed but not activated, absent, or not a feature account: v0.
    const pending = rpcWith({
      [TRANSACTION_V1_FEATURE]: { data: featureData(null), owner: FEATURE_OWNER },
    });
    expect(await transactionFormatFor(pending)).toBe(0);
    expect(await transactionFormatFor(rpcWith({}))).toBe(0);
    const spoofed = rpcWith({
      [TRANSACTION_V1_FEATURE]: {
        data: featureData(1n),
        owner: address("11111111111111111111111111111111"),
      },
    });
    expect(await transactionFormatFor(spoofed)).toBe(0);
  });

  const payer = createNoopSigner(address("GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt"));
  const lifetime = {
    blockhash: "11111111111111111111111111111111" as never,
    lastValidBlockHeight: 0n,
  };
  const ix = {
    programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    data: new Uint8Array(4),
  };

  it("puts the budget in the v1 header and in compute budget instructions in v0, never a lookup table", () => {
    const v1 = beaconTransactionMessage(1, payer, lifetime, [ix], {
      computeUnitLimit: 100_000,
      priorityFeeLamports: 5_000n,
    });
    expect(v1.version).toBe(1);
    expect(v1.instructions).toHaveLength(1);
    expect("config" in v1 && v1.config).toEqual({
      computeUnitLimit: 100_000,
      loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
      priorityFeeLamports: 5_000n,
    });
    const v0 = beaconTransactionMessage(0, payer, lifetime, [ix], {
      computeUnitLimit: 100_000,
      microLamportsPerUnit: 100_000n,
    });
    expect(v0.version).toBe(0);
    expect(v0.instructions.filter((i) => i.programAddress === COMPUTE_BUDGET_PROGRAM)).toHaveLength(
      2,
    );
    for (const m of [v1, v0]) {
      expect(
        m.instructions.flatMap((i) => i.accounts ?? []).some((a) => "lookupTableAddress" in a),
      ).toBe(false);
    }
    expect(measure(v1).bytes).toBeLessThan(measure(v0).bytes);
    expect(measure(v1).limit).toBe(4_096);
    expect(measure(v0).limit).toBe(1_232);
  });

  it("refuses a budget the format cannot carry", () => {
    expect(() =>
      beaconTransactionMessage(1, payer, lifetime, [ix], { computeUnitLimit: 0 }),
    ).toThrow();
    expect(() =>
      beaconTransactionMessage(1, payer, lifetime, [ix], { computeUnitLimit: 1_400_001 }),
    ).toThrow();
    expect(() =>
      beaconTransactionMessage(1, payer, lifetime, [ix], {
        computeUnitLimit: 1,
        microLamportsPerUnit: 1n,
      }),
    ).toThrow();
    expect(() =>
      beaconTransactionMessage(0, payer, lifetime, [ix], {
        computeUnitLimit: 1,
        priorityFeeLamports: 1n,
      }),
    ).toThrow();
  });
});

describe("round resolution", () => {
  const round = (id: bigint, status: RoundStatus, closeSlot = 0n, usage = 0n) =>
    ({ id, status, closeSlot, usage, roundK: 1 }) as Round;
  const pda = async (id: bigint) => (await findRoundPda(id))[0];

  it("joins the accepting round while it accepts", async () => {
    for (const r of [round(4n, RoundStatus.Accepting), round(4n, RoundStatus.Paid, 100n)]) {
      const t = await resolveJoinRound({ acceptingRound: 4n, nextRoundId: 5n }, r, 99n);
      expect(t).toEqual({
        round: await pda(4n),
        nextRound: await pda(5n),
        landsIn: 4n,
        creates: false,
      });
    }
  });

  it("lands in the next round when a paid one has no room for the join, with the same pair", async () => {
    // Full to the unit: no join of any usage fits.
    const full = round(4n, RoundStatus.Paid, 100n, USAGE_SCALE);
    for (const usage of [undefined, 1n, 500_000_000n]) {
      const t = await resolveJoinRound(
        { acceptingRound: 4n, nextRoundId: 5n },
        full,
        99n,
        {},
        usage,
      );
      expect(t).toEqual({
        round: await pda(4n),
        nextRound: await pda(5n),
        landsIn: 5n,
        creates: true,
      });
    }
    // Room for a small join, not for a large one; an unpaid round is never full.
    const most = round(4n, RoundStatus.Paid, 100n, 600_000_000n);
    const at = (r: Round, usage: bigint) =>
      resolveJoinRound({ acceptingRound: 4n, nextRoundId: 5n }, r, 99n, {}, usage);
    expect((await at(most, 400_000_000n)).landsIn).toBe(4n);
    expect((await at(most, 400_000_001n)).landsIn).toBe(5n);
    const unpaid = round(4n, RoundStatus.Accepting, 0n, USAGE_SCALE);
    expect((await at(unpaid, USAGE_SCALE)).landsIn).toBe(4n);
  });

  it("creates the next round once the accepting one has closed, with the same pair", async () => {
    for (const r of [
      round(4n, RoundStatus.Paid, 100n),
      round(4n, RoundStatus.Requested, 100n),
      null,
    ]) {
      const t = await resolveJoinRound({ acceptingRound: 4n, nextRoundId: 5n }, r, 100n);
      expect(t).toEqual({
        round: await pda(4n),
        nextRound: await pda(5n),
        landsIn: 5n,
        creates: true,
      });
    }
    expect(roundAcceptsJoins(round(4n, RoundStatus.Paid, 100n), 99n)).toBe(true);
    expect(roundAcceptsJoins(round(4n, RoundStatus.Paid, 100n), 100n)).toBe(false);
    expect(roundAcceptsJoins(round(4n, RoundStatus.Drawn, 100n), 0n)).toBe(false);
  });

  it("creates the next id when no round accepts", async () => {
    const t = await resolveJoinRound({ acceptingRound: 0n, nextRoundId: 7n }, null, 1n);
    expect(t).toEqual({
      round: await pda(7n),
      nextRound: await pda(8n),
      landsIn: 7n,
      creates: true,
    });
  });

  it("refuses a round read that is not the vault's accepting round", async () => {
    await expect(
      resolveJoinRound(
        { acceptingRound: 4n, nextRoundId: 5n },
        round(3n, RoundStatus.Accepting),
        1n,
      ),
    ).rejects.toThrow();
  });
});

describe("refunding a round whose draw no longer fits", () => {
  const FEE = 500_000n;
  const RENT = 6_103_680n;
  const SHARE = 50_000n;
  const drawMax = 2n * FEE + RENT + SHARE;
  const r = {
    id: 3n,
    status: RoundStatus.Accepting,
    firstSlot: 10n,
    lastJoinSlot: 10n,
    refundSlots: 1_500n,
    requestShare: SHARE,
    drawMax,
  } as Round;
  const held = { address: address("GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt"), data: r };
  const anyone = createNoopSigner(address("11111111111111111111111111111112"));

  it("is doomed past one fee of margin, not at it", () => {
    expect(roundDrawDoomed(r, { oraoFee: 2n * FEE, pendingRent: RENT })).toBe(false);
    expect(roundDrawDoomed(r, { oraoFee: 2n * FEE + 1n, pendingRent: RENT })).toBe(true);
  });

  it("lets anyone build it, without a ticket, once the window is open", async () => {
    const live = { oraoFee: 2n * FEE + 1n, pendingRent: RENT };
    const ix = await getBeaconRefundInstructionAsync(anyone, held, 1_510n, null, {}, live);
    const keys = ix.accounts!.map((a) => a.address);
    expect(keys[3]).toBe(held.address);
    expect(keys[4]).toBe((await findOraoNetworkStatePda())[0]);
    await expect(
      getBeaconRefundInstructionAsync(anyone, held, 1_509n, null, {}, live),
    ).rejects.toThrow(/window/);
    await expect(
      getBeaconRefundInstructionAsync(
        anyone,
        held,
        1_510n,
        null,
        {},
        {
          oraoFee: 2n * FEE,
          pendingRent: RENT,
        },
      ),
    ).rejects.toThrow(/participant/);
    await expect(getBeaconRefundInstructionAsync(anyone, held, 1_510n, null)).rejects.toThrow(
      /participant/,
    );
  });
});
