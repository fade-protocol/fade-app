// The cutover's pause and unpause (scripts/devnet/pause-tickets.ts): the flags it writes and who
// may send them run on synthetic values (scripts/devnet/pause-flags.ts), its refusals that need no
// RPC in a child process, and what it sends is read as text: nothing before the dry run returns,
// the unpause only once the new keeper answers.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { address } from "@solana/kit";
import {
  newKeeperHealthRefusals,
  newKeeperRequired,
  pauseFlagNames,
  pauseSignerRefusals,
  ticketPauseFlags,
} from "../../../scripts/devnet/pause-flags.ts";

const read = (p: string) => readFileSync(p, "utf8");

function run(args: string[], env: Record<string, string | undefined>) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/devnet/pause-tickets.ts", ...args],
    {
      env: { ...process.env, RPC_URL: undefined, ...env },
      encoding: "utf8",
    },
  );
  return { status: r.status, err: r.stderr };
}

const GUARDIAN = address("DpWA1byEKKJDEp3Wmx48pq2xJwcpL59QyA48RdeDLbiS");
const COUNCIL = address("GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt");
const OTHER = address("HeuXg1Fn2R7TzzATextZjwySFq1m4YBgUdvXqbQuojsL");

describe("ticketPauseFlags", () => {
  it("moves PAUSE_TICKETS alone, every other flag written back as read", () => {
    // PAUSE_DEPOSITS | PAUSE_NEW_INTEGRATORS | PAUSE_ROUNDS
    for (const others of [0, 2, 4, 8, 2 | 4 | 8]) {
      expect(ticketPauseFlags(others, "set")).toBe(others | 1);
      expect(ticketPauseFlags(others | 1, "clear")).toBe(others);
      // a round trip restores the byte the pause found
      expect(ticketPauseFlags(ticketPauseFlags(others, "set"), "clear")).toBe(others);
    }
    expect(ticketPauseFlags(1, "set")).toBe(1);
    expect(ticketPauseFlags(8, "clear")).toBe(8);
  });

  it("names each flag", () => {
    expect(pauseFlagNames(0)).toEqual([]);
    expect(pauseFlagNames(1 | 8)).toEqual(["PAUSE_TICKETS", "PAUSE_ROUNDS"]);
    expect(pauseFlagNames(2 | 4)).toEqual(["PAUSE_DEPOSITS", "PAUSE_NEW_INTEGRATORS"]);
    expect(pauseFlagNames(16)).toEqual(["unknown bits 16"]);
  });
});

describe("pauseSignerRefusals", () => {
  const config = { guardian: GUARDIAN, council: COUNCIL };

  it("lets the guardian or the council pause", () => {
    expect(pauseSignerRefusals("set", GUARDIAN, config)).toEqual([]);
    expect(pauseSignerRefusals("set", COUNCIL, config)).toEqual([]);
    expect(pauseSignerRefusals("set", OTHER, config)).toHaveLength(1);
  });

  it("lets only the council unpause, as set_pause_flags does", () => {
    expect(pauseSignerRefusals("clear", COUNCIL, config)).toEqual([]);
    expect(pauseSignerRefusals("clear", GUARDIAN, config)[0]).toContain("only the council");
    expect(pauseSignerRefusals("clear", OTHER, config)).toHaveLength(1);
    // devnet: council = guardian = the deployer
    expect(
      pauseSignerRefusals("clear", GUARDIAN, { guardian: GUARDIAN, council: GUARDIAN }),
    ).toEqual([]);
  });
});

describe("newKeeperHealthRefusals", () => {
  /** The new keeper's health once it has ticked, nothing to pause for. */
  const live = {
    lastTick: 1_761_379_244_000,
    pauseRecommended: false,
    directPauseRecommended: false,
    beaconPauseRecommended: false,
    directWithheld: { counted: "0", unaccounted: "0", unresolved: [], pauseRecommended: false },
  };

  it("passes the new keeper's health once it has ticked and recommends no pause", () => {
    expect(newKeeperHealthRefusals(live)).toEqual([]);
    // the beacon off: its side null
    expect(newKeeperHealthRefusals({ ...live, beaconPauseRecommended: null })).toEqual([]);
    // an acknowledged ordinal: counted 1, nothing unresolved
    expect(
      newKeeperHealthRefusals({
        ...live,
        directWithheld: { ...live.directWithheld, counted: "1" },
      }),
    ).toEqual([]);
  });

  it("refuses a new keeper that has not ticked, or not read the Vault's counter", () => {
    // started, no tick yet: the fail-closed defaults (the rehearsal's clone 3 was let through)
    const fresh = {
      ...live,
      lastTick: 0,
      pauseRecommended: true,
      directPauseRecommended: true,
      directWithheld: { counted: null, unaccounted: null, unresolved: [], pauseRecommended: true },
    };
    const r = newKeeperHealthRefusals(fresh);
    expect(r).toHaveLength(3);
    expect(r[0]).toContain("has not ticked yet");
    expect(r[1]).toContain("has not read the Vault's ticket_forfeits_withheld");
    expect(newKeeperHealthRefusals({ ...live, lastTick: 0 })).toHaveLength(1);
    expect(newKeeperHealthRefusals({ ...live, lastTick: "1" })).toHaveLength(1);
    // ticked, the vault unreadable
    expect(
      newKeeperHealthRefusals({
        ...live,
        directWithheld: { ...live.directWithheld, counted: null },
      }),
    ).toHaveLength(1);
  });

  it("refuses a keeper that recommends the pause, direct or beacon, until its alarm is resolved or acknowledged", () => {
    const direct = newKeeperHealthRefusals({
      ...live,
      pauseRecommended: true,
      directPauseRecommended: true,
      directWithheld: { ...live.directWithheld, counted: "1", unresolved: [{ ordinal: "1" }] },
    });
    expect(direct).toHaveLength(1);
    expect(direct[0]).toContain("recommends the pause");
    expect(direct[0]).toContain("DIRECT_ACKNOWLEDGED_WITHHELD");
    const beacon = newKeeperHealthRefusals({
      ...live,
      pauseRecommended: true,
      beaconPauseRecommended: true,
    });
    expect(beacon).toHaveLength(1);
    expect(beacon[0]).toContain("BEACON_ACKNOWLEDGED_ALARMS");
    // absent counts as recommending it
    const { pauseRecommended: _, ...without } = live;
    expect(newKeeperHealthRefusals(without)).toHaveLength(1);
  });

  it("refuses the old keeper's health, or no answer", () => {
    expect(newKeeperHealthRefusals({ keeper: "x", lamports: "1", queue: 0 })).toHaveLength(2);
    expect(newKeeperHealthRefusals({ directPauseRecommended: false })).toHaveLength(1);
    expect(newKeeperHealthRefusals(null)).toHaveLength(1);
    expect(newKeeperHealthRefusals("ok")).toHaveLength(1);
  });
});

describe("newKeeperRequired", () => {
  it("waits for the new keeper only while the live binary carries the audit fixes", () => {
    // the forward path: the new binary live, the keeper not yet deployed
    expect(newKeeperRequired(true, true)).toBe(true);
    // the cutover called off before the upgrade, or rolled back with its merge reverted: the
    // old binary is live, and the old keeper is the right one
    expect(newKeeperRequired(true, false)).toBe(false);
    // set, or a clone's --no-keeper-check
    expect(newKeeperRequired(false, true)).toBe(false);
    expect(newKeeperRequired(false, false)).toBe(false);
  });
});

describe("pause-tickets", () => {
  const src = read("scripts/devnet/pause-tickets.ts");

  it("runs against devnet or a local validator only", () => {
    const r = run(["set", "--confirm"], { RPC_URL: "https://api.mainnet-beta.solana.com" });
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("runs against devnet (https://api.devnet.solana.com) or a local");
  });

  it("takes set or clear, and refuses an unknown argument rather than read it as a dry run", () => {
    expect(run([], {}).err).toContain("the first argument is set or clear");
    expect(run(["unpause"], {}).err).toContain("the first argument is set or clear");
    const r = run(["set", "--confrim"], {});
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("unknown argument --confrim");
  });

  it("skips the new keeper's check only to clear on a local validator", () => {
    expect(run(["clear", "--no-keeper-check"], {}).err).toContain(
      "--no-keeper-check is for clear on a local validator only",
    );
    expect(run(["set", "--no-keeper-check"], { RPC_URL: "http://127.0.0.1:18899" }).err).toContain(
      "--no-keeper-check is for clear on a local validator only",
    );
  });

  it("sends only with --confirm, after the dry run, from the flags Config holds", () => {
    expect(src.match(/await send\(/g)).toHaveLength(1);
    const at = (s: string) => src.indexOf(s);
    expect(at("if (!CONFIRM) {")).toBeGreaterThan(0);
    expect(at("if (!CONFIRM) {")).toBeLessThan(at("await send("));
    expect(src.slice(at("if (!CONFIRM) {"), at("await send("))).toContain("return;");
    expect(src).toContain("const after = ticketPauseFlags(before, action);");
    expect(src).toContain("pauseFlags: after,");
    expect(src).toContain("integratorPaused: null,");
    // the signer and, for the unpause, the new keeper are checked before anything is built
    expect(at("pauseSignerRefusals(action, deployer.address, config)")).toBeLessThan(
      at("getSetPauseFlagsInstructionAsync("),
    );
    expect(at("? await keeperHealth()")).toBeLessThan(at("getSetPauseFlagsInstructionAsync("));
    expect(src).toContain('return { action, local, keeperCheck: action === "clear" && !skip };');
  });

  it("reads the live binary to decide which keeper the unpause waits for", () => {
    const at = (s: string) => src.indexOf(s);
    // read as upgrade-live reads it, only when the keeper is to be checked
    expect(src).toContain('import { carriesAuditFixes, programData } from "./migration.ts";');
    expect(src).toContain(
      "const liveCarriesAuditFixes = keeperCheck ? carriesAuditFixes((await programData()).elf) : null;",
    );
    // the binary is read first, and decides the keeper's check
    expect(at("const liveCarriesAuditFixes =")).toBeLessThan(at("? await keeperHealth()"));
    expect(src).toMatch(
      /const keeper = newKeeperRequired\(keeperCheck, liveCarriesAuditFixes === true\)\s*\? await keeperHealth\(\)\s*: null;/,
    );
    expect(src.match(/await keeperHealth\(\)/g)).toHaveLength(1);
    // the skip is said, and the record keeps what was read
    expect(src).toContain("the live binary predates the audit fixes");
    expect(src.slice(at("writeJson("))).toContain("liveCarriesAuditFixes");
  });

  it("records the flags before and after, and reads them back", () => {
    const record = src.slice(src.indexOf("writeJson("));
    expect(record).toContain("flagsBefore: { value: before, names: pauseFlagNames(before) },");
    expect(record).toContain("flagsAfter: { value: after, names: pauseFlagNames(after) },");
    expect(src).toContain("check(readBack === after,");
    expect(src).toContain("scripts/devnet/runs/pause-tickets-${action}-");
  });

  it("is run through the toolchain", () => {
    expect(read("package.json")).toContain(
      '"devnet:pause-tickets": "bash scripts/toolchain/with-toolchain.sh pnpm exec tsx scripts/devnet/pause-tickets.ts"',
    );
  });
});
