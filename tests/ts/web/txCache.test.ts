// apps/web/src/lib/txCache.ts keeps each transaction's decoded events in IndexedDB for good, and
// drops them only when its VERSION moves. An event whose wire format changes (events.lock.json)
// gets a new decoder in the app, so the entries decoded before it must not be read back: a
// version-2 TicketExpired stored by a bundle without its refund tail would show a refund as a
// forfeiture. Each cache version records the events lock it was cut for.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The sha256 of events.lock.json each cache version was cut for. */
const CUT_FOR: Record<number, string> = {
  3: "a2b8d6cefccfd95a875c4bcaf747599442a42d34128742b90cea12b4275ede39",
};

describe("the app's event cache", () => {
  it("moves its version with the events lock", () => {
    const version = Number(
      readFileSync("apps/web/src/lib/txCache.ts", "utf8").match(/^const VERSION = (\d+);$/m)?.[1],
    );
    const lock = createHash("sha256").update(readFileSync("events.lock.json")).digest("hex");
    expect(
      CUT_FOR[version],
      "events.lock.json changed: bump VERSION in apps/web/src/lib/txCache.ts and record the lock's sha256 here",
    ).toBe(lock);
  });
});
