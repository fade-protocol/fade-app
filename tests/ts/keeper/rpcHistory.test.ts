// What the keeper's readers of `getSignaturesForAddress` take from a refusal of the RPC
// (apps/keeper/src/rpcHistory.ts): which bound it refused, and when that refusal lasts enough to
// act on, a node a slot or two behind a load balancer refusing a fresh signature as a pruned one.
import {
  SolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  missingBound,
  noteRefusal,
  refusalAnswered,
  REFUSAL_SPAN_MS,
  REFUSALS_TO_CONFIRM,
} from "../../../apps/keeper/src/rpcHistory.ts";

const refused = (message: string) =>
  new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND, {
    __serverMessage: message,
  });

describe("the bound an RPC refused", () => {
  it("is the one Agave names, either", () => {
    const bounds = { until: "Until1", before: "Before1" };
    expect(missingBound(refused("Transaction Before1 not found"), bounds)).toBe("before");
    expect(missingBound(refused("Transaction Until1 not found"), bounds)).toBe("until");
  });

  it("is `until` first, then `before`, when the message names neither", () => {
    const message = "Transaction history is not available from this node";
    expect(missingBound(refused(message), { until: "Until1", before: "Before1" })).toBe("until");
    expect(missingBound(refused(message), { until: null, before: "Before1" })).toBe("before");
    expect(missingBound(refused(message), { until: null, before: null })).toBeNull();
  });

  it("is none for any other error: it is thrown, never read as pruning", () => {
    const bounds = { until: "Until1", before: "Before1" };
    expect(
      missingBound(
        new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY, {
          numSlotsBehind: 42,
        }),
        bounds,
      ),
    ).toBeNull();
    expect(missingBound(new Error("Transaction Until1 not found"), bounds)).toBeNull();
    expect(missingBound(new Error("HTTP 429"), bounds)).toBeNull();
  });
});

describe("a refusal acted on", () => {
  it("lasts REFUSALS_TO_CONFIRM refusals spread over REFUSAL_SPAN_MS at least", () => {
    let stored: string | null = null;
    const at = [0, 1_000, 2_000, 3_000, REFUSAL_SPAN_MS];
    const confirmed = at.map((t) => {
      const n = noteRefusal(stored, "Sig1", 5_000_000 + t);
      stored = n.record;
      return n.confirmed;
    });
    // three refusals within a few seconds are not enough: a node behind can refuse in a burst
    expect(REFUSALS_TO_CONFIRM).toBe(3);
    expect(confirmed).toEqual([false, false, false, false, true]);
  });

  it("starts over for another bound, and once a call bounded by it succeeds", () => {
    let n = noteRefusal(null, "Sig1", 0);
    n = noteRefusal(n.record, "Sig1", REFUSAL_SPAN_MS / 2);
    // another bound refused: its own count, from one
    const other = noteRefusal(n.record, "Sig2", REFUSAL_SPAN_MS);
    expect(other.confirmed).toBe(false);
    expect(noteRefusal(other.record, "Sig2", REFUSAL_SPAN_MS + 1).confirmed).toBe(false);
    // a call bounded by the bound kept that succeeded answers it; one bounded by others does not
    expect(refusalAnswered(n.record, { until: "Sig1", before: null })).toBe(true);
    expect(refusalAnswered(n.record, { until: null, before: "Sig1" })).toBe(true);
    expect(refusalAnswered(n.record, { until: "Sig3", before: "Sig4" })).toBe(false);
    expect(refusalAnswered(null, { until: "Sig1" })).toBe(false);
  });

  it("starts over from a record it cannot read", () => {
    for (const stored of ["not json", "{}", '{"bound":"Sig1","first":"0","count":9}']) {
      const n = noteRefusal(stored, "Sig1", REFUSAL_SPAN_MS * 10);
      expect(n.confirmed).toBe(false);
      expect(JSON.parse(n.record)).toEqual({
        bound: "Sig1",
        first: REFUSAL_SPAN_MS * 10,
        count: 1,
      });
    }
  });
});
