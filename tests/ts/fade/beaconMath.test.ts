// The client's beacon arithmetic, seed, outcome and payout table hash
// against the reference vectors the Rust crate and scripts/oracle/fade_ref.py
// are checked against (crates/fade-math/tests/vectors/beacon.json): 2 000
// scalar cases, 200 seeds and outcomes, 200 payout tables.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAddressDecoder, getAddressEncoder } from "@solana/kit";
import * as beacon from "../../../clients/js/src/beacon/index.ts";
import {
  charge,
  closeSlot,
  drawCost,
  firstSlotAfter,
  firstSlotAfterRetained,
  fits,
  inRequestWindow,
  isExpired,
  isPaid,
  joinFits,
  oraoNetworkState,
  oraoRandomness,
  outcomeHash,
  paidUnits,
  payoutTableHash,
  prepay,
  refundOpen,
  requestFits,
  roundSeed,
  sponsorReturn,
  sponsorshipToPay,
  usage,
  withinJoinShare,
  type Terms,
} from "../../../clients/js/src/beacon/index.ts";

type Raw = Record<string, unknown>;

// Slots in the vectors exceed 2^53: integers of 16 digits or more are read as strings.
const text = readFileSync(
  join(process.cwd(), "crates", "fade-math", "tests", "vectors", "beacon.json"),
  "utf8",
).replace(/([:[,]\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
const vectors = JSON.parse(text) as {
  scalars: Raw[];
  rounds: Raw[];
  seeds: Raw[];
  payout_tables: { outcomes: [number | string, number | string][]; hash: string }[];
};

const big = (v: unknown) => BigInt(v as string | number);
const hex = (h: unknown) => Uint8Array.from(Buffer.from(h as string, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const attempt = <T>(f: () => T): T | null => {
  try {
    return f();
  } catch {
    return null;
  }
};

describe("beacon arithmetic (vectors)", () => {
  it("matches fade_math::beacon on every scalar case", () => {
    expect(vectors.scalars.length).toBe(2_000);
    for (const v of vectors.scalars) {
      const terms: Terms = {
        threshold: big(v["threshold"]),
        drawMax: big(v["draw_max"]),
        roundK: big(v["round_k"]),
      };
      const price = big(v["price"]);
      const prices = big(v["prices"]);
      const s = big(v["sponsorship"]);
      const ctx = JSON.stringify(v);
      expect(
        requestFits(big(v["fee"]), big(v["pending_rent"]), big(v["request_share"]), terms.drawMax),
        ctx,
      ).toBe(v["request_fits"]);
      expect(prepay(terms, price), ctx).toBe(big(v["prepay"]));
      expect(isPaid(terms, prices, s), ctx).toBe(v["is_paid"]);
      expect(paidUnits(terms, prices, s), ctx).toBe(big(v["paid_units"]));
      expect(sponsorshipToPay(terms, prices, s), ctx).toBe(big(v["sponsorship_to_pay"]));
      const u = attempt(() => usage(big(v["liability"]), big(v["cap"])));
      expect(u, ctx).toBe(v["usage"] === null ? null : big(v["usage"]));
      expect(fits(terms, big(v["usage_total"]), prices, s), ctx).toBe(v["fits"]);
      expect(withinJoinShare(terms, big(v["usage_total"]), price, s, false), ctx).toBe(
        v["within_join_share"],
      );
      expect(withinJoinShare(terms, big(v["usage_total"]), price, s, true), ctx).toBe(
        v["within_join_share_paying"],
      );
      expect(closeSlot(big(v["paid_slot"]), big(v["tick"])), ctx).toBe(big(v["close_slot"]));
      expect(drawCost(big(v["funded"]), big(v["request_share"]), big(v["refund"])), ctx).toBe(
        big(v["draw_cost"]),
      );
      expect(charge(big(v["cost"]), s, prices, price), ctx).toBe(big(v["charge"]));
      expect(sponsorReturn(big(v["cost"]), s, big(v["amount"]), v["drawn"] as boolean), ctx).toBe(
        big(v["sponsor_return"]),
      );
    }
  });
});

describe("a join's capacity decision (vectors)", () => {
  it("admits and refuses every join of the 500 reference rounds as Book::join does", () => {
    expect(vectors.rounds.length).toBe(500);
    let refused = 0;
    for (const r of vectors.rounds) {
      const terms: Terms = {
        threshold: big(r["threshold"]),
        drawMax: big(r["draw_max"]),
        roundK: big(r["round_k"]),
      };
      let book = { usage: 0n, prices: 0n, sponsorship: 0n };
      for (const step of r["steps"] as Raw[]) {
        if (step["kind"] === "join") {
          const e = step["entry"] as Raw;
          const ctx = JSON.stringify(step);
          expect(
            joinFits(terms, book, big(e["usage"]), big(e["price"]), big(step["sponsorship"])),
            ctx,
          ).toBe(step["fits"]);
          if (!step["fits"]) refused += 1;
        }
        const b = step["book"] as Raw;
        book = {
          usage: big(b["usage"]),
          prices: big(b["prices"]),
          sponsorship: big(b["sponsorship"]),
        };
      }
    }
    expect(refused).toBeGreaterThan(100);
  });

  it("holds a join before the payment to its own share, as one after it", () => {
    // The final audit's fourth pass: seven honest 1 USDC joins at 0.01 cap,
    // then a 0.50 USDC long shot at 0.711 caps that the unpaid bound alone admits.
    const terms: Terms = { threshold: 8_640_000n, drawMax: 1_660_392n, roundK: 1n };
    const cap = 1_000_000_000n;
    const book = { usage: 7n * (cap / 100n), prices: 7_000_000n, sponsorship: 0n };
    expect(fits(terms, book.usage + 711_000_000n, book.prices + 500_000n, 0n)).toBe(true);
    expect(isPaid(terms, book.prices + 500_000n, 0n)).toBe(false);
    expect(joinFits(terms, book, 711_000_000n, 500_000n, 0n)).toBe(false);
    // 0.50 USDC is 5.8 % of T_r, its share: the h · k floor is the paying join's
    const own = (cap * 500_000n) / terms.threshold;
    expect(joinFits(terms, book, cap / 10n, 500_000n, 0n)).toBe(false);
    expect(joinFits(terms, book, own, 500_000n, 0n)).toBe(true);
    expect(joinFits(terms, book, own + 1n, 500_000n, 0n)).toBe(false);
    // the join completing the payment keeps h · k caps, and only that join
    const nearly = { usage: book.usage, prices: 8_000_000n, sponsorship: 0n };
    expect(joinFits(terms, nearly, cap / 10n, 640_000n, 0n)).toBe(true);
    expect(joinFits(terms, nearly, cap / 10n + 1n, 640_000n, 0n)).toBe(false);
    const paid = { usage: book.usage + cap / 10n, prices: 8_640_000n, sponsorship: 0n };
    expect(joinFits(terms, paid, cap / 10n, 100_000n, 0n)).toBe(false);
    // room bought by a third party's sponsorship is not the long shot's either
    const sponsored = { usage: 0n, prices: 0n, sponsorship: 1_328_312n };
    expect(joinFits(terms, sponsored, 711_000_000n, 500_000n, 0n)).toBe(false);
  });
});

describe("window predicates", () => {
  const U64_MAX = (1n << 64n) - 1n;
  const close = 1_000n;
  const tSettle = 150n;

  it("opens the request window at close + 2 and shuts it after close + t_settle", () => {
    expect(inRequestWindow(close, close, tSettle)).toBe(false);
    expect(inRequestWindow(close + 1n, close, tSettle)).toBe(false);
    expect(inRequestWindow(close + 2n, close, tSettle)).toBe(true);
    expect(inRequestWindow(close + tSettle - 1n, close, tSettle)).toBe(true);
    expect(inRequestWindow(close + tSettle, close, tSettle)).toBe(true);
    expect(inRequestWindow(close + tSettle + 1n, close, tSettle)).toBe(false);
  });

  it("expires strictly after close + t_settle, the slot after the window's last", () => {
    expect(isExpired(close + tSettle - 1n, close, tSettle)).toBe(false);
    expect(isExpired(close + tSettle, close, tSettle)).toBe(false);
    expect(isExpired(close + tSettle + 1n, close, tSettle)).toBe(true);
    // No slot is both in the window and expired, and none after close + 1 is neither.
    for (let s = close; s <= close + tSettle + 3n; s++) {
      const w = inRequestWindow(s, close, tSettle);
      const e = isExpired(s, close, tSettle);
      expect(w && e).toBe(false);
      expect(w || e).toBe(s >= close + 2n);
    }
  });

  it("opens the refund at first_slot + refund_slots", () => {
    expect(refundOpen(10n + 1_715n - 1n, 10n, 1_715n)).toBe(false);
    expect(refundOpen(10n + 1_715n, 10n, 1_715n)).toBe(true);
    expect(refundOpen(10n + 1_715n + 1n, 10n, 1_715n)).toBe(true);
  });

  // fade_math::beacon adds with `saturating_add`: a bound past u64::MAX is
  // u64::MAX, which the slot u64::MAX reaches (window open, refund open)
  // and never passes (never expired).
  it("saturates its bounds at u64::MAX as fade_math does", () => {
    expect(inRequestWindow(U64_MAX, U64_MAX - 1n, tSettle)).toBe(true);
    expect(inRequestWindow(U64_MAX, U64_MAX, tSettle)).toBe(true);
    expect(inRequestWindow(U64_MAX - 1n, U64_MAX - 1n, tSettle)).toBe(false);
    expect(inRequestWindow(U64_MAX, U64_MAX - 2n, 1n)).toBe(false);
    expect(isExpired(U64_MAX, U64_MAX - 1n, tSettle)).toBe(false);
    expect(isExpired(U64_MAX, U64_MAX, 0n)).toBe(false);
    expect(isExpired(U64_MAX, U64_MAX - 2n, 1n)).toBe(true);
    expect(refundOpen(U64_MAX, U64_MAX - 1n, 1_715n)).toBe(true);
    expect(refundOpen(U64_MAX - 1n, U64_MAX - 1n, 1_715n)).toBe(false);
  });
});

describe("seeds and outcomes (vectors)", () => {
  const addr = (h: unknown) => getAddressDecoder().decode(hex(h));

  it("derives each round's seed and each ticket's outcome hash", async () => {
    expect(vectors.seeds.length).toBe(200);
    for (const v of vectors.seeds) {
      const seed = await roundSeed(addr(v["program"]), addr(v["round"]), big(v["close_slot"]), {
        slot: big(v["entropy_slot"]),
        hash: hex(v["entropy_hash"]),
      });
      expect(toHex(seed)).toBe(v["seed"]);
      const h = await outcomeHash(
        addr(v["program"]),
        addr(v["round"]),
        addr(v["ticket"]),
        hex(v["randomness"]),
        Number(v["i"]),
      );
      expect(toHex(h)).toBe(v["outcome"]);
    }
  });

  it("hashes each payout table as register_payout_table does", async () => {
    expect(vectors.payout_tables.length).toBe(200);
    for (const t of vectors.payout_tables) {
      const outcomes = t.outcomes.map(([p, m]) => ({ p: BigInt(p), m: BigInt(m) }));
      expect(toHex(await payoutTableHash(outcomes))).toBe(t.hash);
    }
  });
});

describe("SlotHashes", () => {
  // Newest first, 108 skipped: as `slot_hashes::tests::first_after_with_gaps`.
  function build(slots: number[]): Uint8Array {
    const d = new Uint8Array(8 + slots.length * 40);
    const view = new DataView(d.buffer);
    view.setBigUint64(0, BigInt(slots.length), true);
    slots.forEach((s, i) => {
      view.setBigUint64(8 + i * 40, BigInt(s), true);
      d.fill(s % 251, 16 + i * 40, 48 + i * 40);
    });
    return d;
  }
  const d = build([110, 109, 107, 106, 100]);

  it("finds the first slot after t", () => {
    expect(firstSlotAfter(d, 99n)?.slot).toBe(100n);
    expect(firstSlotAfter(d, 100n)?.slot).toBe(106n);
    expect(firstSlotAfter(d, 107n)?.slot).toBe(109n);
    expect(firstSlotAfter(d, 109n)?.slot).toBe(110n);
    expect(firstSlotAfter(d, 110n)).toBeNull();
    expect(firstSlotAfter(d, 109n)?.hash).toEqual(new Uint8Array(32).fill(110 % 251));
  });

  it("only while the sysvar proves it", () => {
    expect(firstSlotAfterRetained(d, 100n)?.slot).toBe(106n);
    expect(firstSlotAfterRetained(d, 99n)?.slot).toBe(100n);
    expect(firstSlotAfter(d, 97n)?.slot).toBe(100n);
    expect(firstSlotAfterRetained(d, 97n)).toBeNull();
    expect(firstSlotAfterRetained(build([]), 1n)).toBeNull();
  });
});

// The constants and ORAO layouts the client copies by hand, against the
// fixture programs/fade/tests/client_constants.rs writes from the Rust values
// and checks: a wrong offset or discriminator on either side fails one test.
describe("client constants (Rust fixture)", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(process.cwd(), "tests", "fixtures", "beacon", "client_constants.json"),
      "utf8",
    ),
  ) as {
    constants: Record<string, string | number | number[]>;
    network_state: { data: string; treasury: string; fee: number };
    requests: {
      name: string;
      data: string;
      fulfilled: boolean;
      seed: string;
      randomness: string;
    }[];
  };
  const asJson = (v: unknown): unknown => {
    if (v instanceof Uint8Array) {
      // Seeds are UTF-8 strings in the fixture, discriminators byte arrays.
      return v.length === 8 ? [...v] : new TextDecoder().decode(v);
    }
    return typeof v === "bigint" ? Number(v) : v;
  };

  it("every constant the client copies equals the program's", () => {
    const names = Object.keys(fixture.constants);
    expect(names.length).toBe(16);
    for (const name of names) {
      expect(asJson((beacon as Record<string, unknown>)[name]), name).toEqual(
        fixture.constants[name],
      );
    }
  });

  it("parses ORAO's network state as orao_layout::network_state does", () => {
    const parsed = oraoNetworkState(hex(fixture.network_state.data));
    expect(toHex(getAddressEncoder().encode(parsed.treasury) as Uint8Array)).toBe(
      fixture.network_state.treasury,
    );
    expect(parsed.fee).toBe(BigInt(fixture.network_state.fee));
  });

  it("parses both request layouts as orao_layout::randomness does", () => {
    expect(fixture.requests.map((r) => r.name)).toEqual([
      "v2 pending",
      "v2 fulfilled",
      "v1 pending",
      "v1 fulfilled",
    ]);
    for (const r of fixture.requests) {
      const parsed = oraoRandomness(hex(r.data));
      expect(parsed, r.name).not.toBeNull();
      expect(parsed!.fulfilled, r.name).toBe(r.fulfilled);
      if (parsed!.fulfilled) {
        expect(toHex(parsed!.seed), r.name).toBe(r.seed);
        expect(toHex(parsed!.randomness), r.name).toBe(r.randomness);
      }
    }
  });
});
