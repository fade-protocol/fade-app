// What an RPC's bounded history means for the keeper's readers of `getSignaturesForAddress`.
// Imported by the Worker's objects and by the beacon's engine, which runs in the scripts and the
// tests too: kit alone, nothing of the Worker.
import {
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND,
} from "@solana/kit";

/**
 * Which of the signatures a `getSignaturesForAddress` call was bounded by the RPC refused as not
 * in its history (`-32020`, `SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND`), or null for any other
 * error. A node keeps a bounded history (a validator's ledger limit, a provider's retention): once
 * an indexer's cursor ages out of it, or was a `confirmed` signature its fork dropped, every call
 * bounded by it fails for good, so the caller has to stop asking for it, once the refusal lasts
 * (`noteRefusal`). Agave names the signature in its message; when it names neither, `until` is
 * blamed first (the caller retries without it, and a `before` still refused is then named by
 * elimination).
 */
export function missingBound(
  e: unknown,
  bounds: { until?: string | null; before?: string | null },
): "until" | "before" | null {
  if (!isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_FILTER_TRANSACTION_NOT_FOUND))
    return null;
  const message = String((e.context as { __serverMessage?: unknown }).__serverMessage ?? e.message);
  if (bounds.before && message.includes(bounds.before)) return "before";
  if (bounds.until && message.includes(bounds.until)) return "until";
  if (bounds.until) return "until";
  if (bounds.before) return "before";
  return null;
}

/** Refusals of one bound that confirm the RPC no longer holds it (`noteRefusal`). */
export const REFUSALS_TO_CONFIRM = 3;
/** The least time between a bound's first refusal and the one that confirms it (`noteRefusal`). */
export const REFUSAL_SPAN_MS = 60_000;

/** A bound refused so far, as a reader keeps it between its ticks (`noteRefusal`). */
type Refusal = { bound: string; first: number; count: number };

/**
 * Notes one more refusal of `bound` over `stored` (the record kept, or null) at `now` (ms), and
 * says whether it is confirmed: REFUSALS_TO_CONFIRM refusals of it, spread over REFUSAL_SPAN_MS
 * at least. A load-balanced provider can route a call to a node a slot or two behind, which
 * refuses a signature it has not seen yet exactly as a pruned one: a single refusal is not
 * acted on (the caller throws it, and the next tick asks again, with no extra call), so an
 * irreversible step (a cursor dropped, a listing ended) waits for one that lasts. A record of
 * another bound starts over. `record` is what to keep.
 */
export function noteRefusal(
  stored: string | null,
  bound: string,
  now: number,
): { record: string; confirmed: boolean } {
  const prev = parseRefusal(stored);
  const next: Refusal =
    prev && prev.bound === bound
      ? { bound, first: prev.first, count: prev.count + 1 }
      : { bound, first: now, count: 1 };
  return {
    record: JSON.stringify(next),
    confirmed: next.count >= REFUSALS_TO_CONFIRM && now - next.first >= REFUSAL_SPAN_MS,
  };
}

/**
 * Whether `stored`, a refusal kept by `noteRefusal`, is answered by a call bounded by `bounds`
 * that succeeded: the RPC holds that bound after all, so its count starts over.
 */
export function refusalAnswered(
  stored: string | null,
  bounds: { until?: string | null; before?: string | null },
): boolean {
  const prev = parseRefusal(stored);
  return prev !== null && (prev.bound === bounds.until || prev.bound === bounds.before);
}

function parseRefusal(stored: string | null): Refusal | null {
  if (stored === null) return null;
  try {
    const r = JSON.parse(stored) as Partial<Refusal>;
    return typeof r.bound === "string" && typeof r.first === "number" && typeof r.count === "number"
      ? (r as Refusal)
      : null;
  } catch {
    return null;
  }
}
