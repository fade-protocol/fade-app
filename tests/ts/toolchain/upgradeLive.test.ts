// The live devnet upgrade (scripts/devnet/upgrade-live.ts) and the checks it
// shares with the migration rehearsal (scripts/devnet/migration.ts). The
// script's refusals that need no RPC are run in a child process; what it
// sends is read as text: nothing is sent before the dry run returns, and
// nothing outside `execute`. The shared checks run on synthetic accounts.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { address, getAddressEncoder, getBase58Decoder, type Address } from "@solana/kit";
import {
  RoundStatus,
  getTicketExpiredEventEncoder,
  getConfigDecoder,
  getConfigEncoder,
  getVaultDecoder,
  getVaultEncoder,
  getVaultSize,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  EXTEND_MARGIN,
  PAUSE_ROUNDS,
  SPEC_BEACON,
  V1_CONFIG_LEN,
  V2_CONFIG_LEN,
  BUFFER_HEADER,
  backToV1,
  bufferFits,
  bufferHolds,
  carriesMigrateConfig,
  carriesSweepRoundVrf,
  carries,
  deployedIs,
  extendBy,
  isSha256,
  migrationMismatches,
  notYetUpgraded,
  sweepReadRound,
  INSTRUCTION_FALLBACK_NOT_FOUND,
  NOT_DEPLOYED_YET,
  WRONG_ROUND_STATUS,
  migrationRefusals,
  v1PendingActive,
  auditFixRefusals,
  MIN_KAPPA_BPS,
  TICKET_FORFEITS_WITHHELD_AT,
  ticketForfeitsWithheld,
  directDrainRefusals,
  PAUSE_TICKETS,
  counterProofOrdinal,
  VAULT_TAIL_IS_COUNTER,
} from "../../../scripts/devnet/migration.ts";
import { EVENT_IX_TAG } from "../../../scripts/devnet/beacon-checks.ts";

const LIVE: Address = address("GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt");
const MAINNET: Address = address("HeuXg1Fn2R7TzzATextZjwySFq1m4YBgUdvXqbQuojsL");
const read = (p: string) => readFileSync(p, "utf8");

function run(args: string[], env: Record<string, string | undefined>) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/devnet/upgrade-live.ts", ...args],
    {
      env: { ...process.env, RPC_URL: undefined, ...env },
      encoding: "utf8",
    },
  );
  return { status: r.status, err: r.stderr };
}

describe("upgrade-live refusals", () => {
  it("runs against devnet or a local validator only", () => {
    for (const RPC_URL of ["https://api.mainnet-beta.solana.com", "https://example.com"]) {
      const r = run(["--confirm"], { RPC_URL });
      expect(r.status).not.toBe(0);
      expect(r.err).toContain("runs against devnet (https://api.devnet.solana.com) or a local");
    }
  });

  it("refuses an unknown argument rather than read it as a dry run", () => {
    const r = run(["--confrim"], {});
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("unknown argument --confrim");
  });

  it("refuses an --expect-sha256 that is not a full sha256, before any RPC", () => {
    for (const args of [
      ["--expect-sha256"],
      ["--expect-sha256", "a4c3653c"],
      [
        "--confirm",
        "--expect-sha256",
        "A4C3653CEFA1DDABBB98E515D1283406DD16EC9F6C59B6D605FCA4A08B52FC89",
      ],
    ]) {
      const r = run(args, { RPC_URL: "https://example.com" });
      expect(r.status).not.toBe(0);
      expect(r.err).toContain("--expect-sha256 takes the binary's full sha256");
    }
    // A well-formed one is taken as the flag's value, not as an unknown argument.
    const r = run(["--expect-sha256", "a".repeat(64), "--confrim"], {});
    expect(r.err).toContain("unknown argument --confrim");
    expect(r.err).not.toContain("aaaa");
  });

  it("refuses a --vault-tail-is-counter that is not a signature, before any RPC", () => {
    for (const args of [[VAULT_TAIL_IS_COUNTER], [VAULT_TAIL_IS_COUNTER, "3"]]) {
      const r = run(args, { RPC_URL: "https://example.com" });
      expect(r.status).not.toBe(0);
      expect(r.err).toContain(`${VAULT_TAIL_IS_COUNTER} takes the signature`);
    }
    const sig = getBase58Decoder().decode(new Uint8Array(64).fill(7));
    const r = run([VAULT_TAIL_IS_COUNTER, sig, "--confrim"], {});
    expect(r.err).toContain("unknown argument --confrim");
  });
});

describe("upgrade-live sends nothing without --confirm", () => {
  const src = read("scripts/devnet/upgrade-live.ts");
  const start = src.indexOf("async function execute(");
  const end = src.indexOf("// --- main");
  const body = src.slice(start, end);
  const outside = src.slice(0, start) + src.slice(end);

  it("every write sits in execute", () => {
    expect(start).toBeGreaterThan(0);
    for (const write of [
      '"write-buffer"',
      '"extend"',
      '"upgrade"',
      "await send(",
      '"--no-bip39-passphrase"',
    ])
      expect(outside).not.toContain(write);
    for (const write of ['"write-buffer"', '"extend"', '"upgrade"', "await send("])
      expect(body).toContain(write);
  });

  it("execute runs only after the dry run has returned", () => {
    const main = src.slice(end);
    expect(main.match(/execute\(/g)).toHaveLength(1);
    expect(main.indexOf("if (!CONFIRM) {")).toBeGreaterThan(0);
    expect(main.indexOf("if (!CONFIRM) {")).toBeLessThan(main.indexOf("await execute(pl)"));
    expect(
      main.slice(main.indexOf("if (!CONFIRM) {"), main.indexOf("await execute(pl)")),
    ).toContain("return;");
  });

  it("an upgrade into the audit fixes is refused unless the direct path is drained, then and right before the upgrade", () => {
    const planBody = src.slice(src.indexOf("async function plan("), start);
    expect(planBody).toContain(
      "const drainRequired = upgrades(mode) && !carriesAuditFixes(pd.elf);",
    );
    expect(planBody).toContain("!CONFIRM || drain.refusals.length === 0");
    const at = (s: string) => body.indexOf(s);
    expect(at("the direct path is still drained before the upgrade")).toBeGreaterThan(0);
    expect(at("the buffer holds the binary byte for byte")).toBeLessThan(
      at("the direct path is still drained before the upgrade"),
    );
    expect(at("the direct path is still drained before the upgrade")).toBeLessThan(at('"upgrade"'));
    // the run record holds both facts
    expect(src.slice(end)).toContain("ticketsPaused: pl.directDrain.ticketsPaused");
  });

  it("a drained upgrade's plan keeps the pause until the new keeper is proven live", () => {
    expect(src).toContain(
      'Accepting round (an unpaid one refunds), no ticket joins; paid rounds settle." +\n            AFTER_THE_UPGRADE',
    );
    const after = src.slice(
      src.indexOf("const AFTER_THE_UPGRADE ="),
      src.indexOf("// --- the confirmed run"),
    );
    for (const step of [
      "Deploy keeper and the Deploy app runs",
      "directWithheld and directPauseRecommended",
      "workflow_dispatch, still paused",
      "pnpm devnet:sweep-ticket-vrfs until it lists no request still owed",
    ])
      expect(after.replace(/\\n" \+\n\s*"/g, " ")).toContain(step);
    const at = (s: string) => after.indexOf(s);
    expect(at("keep PAUSE_TICKETS set until")).toBeLessThan(at("Then unpause"));
  });

  it("the buffer is written and checked before the program data is extended and upgraded", () => {
    const at = (s: string) => body.indexOf(s);
    expect(at('"write-buffer"')).toBeLessThan(at("the buffer holds the binary byte for byte"));
    expect(at("the buffer holds the binary byte for byte")).toBeLessThan(at('"extend"'));
    expect(at('"extend"')).toBeLessThan(at('"upgrade"'));
    // A lagging read after the extension is waited out, not failed (a rerun would extend again).
    const extension = body.slice(at('"extend"'), at('"upgrade"'));
    expect(extension).toContain("const pd = await waitForRoom(pl.elf.length);");
    expect(extension).not.toContain("await programData()");
    expect(at('"upgrade"')).toBeLessThan(at("await sendMigrate(deployer)"));
  });

  it("migrate_config is sent as soon as the new binary shows, every other check after it", () => {
    const at = (s: string) => body.indexOf(s);
    const between = body.slice(at('"upgrade"'), at("await sendMigrate(deployer)"));
    expect(between.match(/check\(/g)).toHaveLength(1);
    expect(between).toContain("check(\n      await waitForBinary(pl.elf)");
    expect(between).not.toContain("deployedIs(");
    expect(between).not.toContain("accountData(bufferAddress)");
    expect(at("await sendMigrate(deployer)")).toBeLessThan(
      at("the buffer closed into the upgrade"),
    );
    // An upgrade CLI that throws after landing still leads to the wait, not out of the run.
    expect(body).toMatch(/try \{\s*cli = cliResult\(\s*solana\(\[\s*"program",\s*"upgrade"/);
    expect(between).toContain("cli = { error:");
    // The old binary refuses migrate_config as unknown: sendMigrate retries on that alone.
    expect(src).toContain("const early = e instanceof SendError && notYetUpgraded(e);");
    expect(src).toContain("if (!early || attempt >= EARLY_ATTEMPTS) throw e;");
    // The program runs from the slot after its upgrade.
    expect(between).toContain("await waitPastSlot(upgraded.slot + 1n);");
  });

  it("a run that migrated asserts the beacon starts paused on SPEC, any other run reports both", () => {
    const verify = src.slice(
      src.indexOf("async function verifyV2("),
      src.indexOf("async function waitPastSlot("),
    );
    const fresh = verify.slice(verify.indexOf("if (fresh) {"));
    expect(fresh).toContain('check(roundsPaused, "PAUSE_ROUNDS set');
    expect(fresh).toContain("check(beaconParamsAreSpec,");
    expect(verify).toContain("v.acceptingRound === 0n || v.nextRoundId > 1n");
    expect(body).toContain("await verifyV2(migrated !== null, pl.local)");
    expect(src).toContain(
      'if (pl.mode === "verify") console.log("\\n", await verifyV2(false, local));',
    );
  });

  it("on a clone, Config's rent exemption is checked against devnet's rent, not the clone's", () => {
    const verify = src.slice(
      src.indexOf("async function verifyV2("),
      src.indexOf("async function waitPastSlot("),
    );
    expect(verify).toContain("(await devnetRentExempt(V2_CONFIG_LEN, local))");
    const rent = src.slice(
      src.indexOf("async function devnetRentExempt("),
      src.indexOf("async function verifyV2("),
    );
    expect(rent).toContain("if (!local) return rentExempt(space);");
    expect(rent).toContain("createSolanaRpc(DEVNET_URL).getMinimumBalanceForRentExemption(");
    expect(src).toContain('const DEVNET_URL = "https://api.devnet.solana.com";');
  });

  it("a version-2 Config under another binary is upgraded only: no migration, read by the new binary", () => {
    const plan = src.slice(src.indexOf("async function plan("), src.indexOf("function printPlan("));
    expect(plan).not.toContain("not this script's upgrade");
    expect(plan).toMatch(
      /const mode: Mode = v2\s*\? deployedNew\s*\? "verify"\s*: "upgrade-only"\s*: deployedNew\s*\? "migrate"\s*: "upgrade-and-migrate";/,
    );
    // The buffer and the extension are planned and paid for as for a migrating upgrade.
    expect(src).toContain(
      'const upgrades = (mode: Mode) => mode === "upgrade-and-migrate" || mode === "upgrade-only";',
    );
    expect(plan).toContain("const extend = upgrades(mode) ? extendBy(elf.length, pd.len) : 0;");
    expect(body).toContain("if (upgrades(pl.mode)) {");
    // Config still version 2 right before the program changes, and never migrated.
    expect(body).toContain("? config.length === V2_CONFIG_LEN && config[VERSION_AT] === 2");
    const at = (s: string) => body.indexOf(s);
    expect(at("Config is still version")).toBeLessThan(at('"upgrade"'));
    const migrations = body.slice(at("let migrated: Sent | null = null;"), at("if (afterUpgrade"));
    expect(migrations).toContain('if (pl.mode === "upgrade-and-migrate") {');
    expect(migrations).toContain('} else if (pl.mode === "migrate") {');
    expect(migrations).not.toContain("upgrade-only");
    // Read back by the new binary, after the upgrade's checks.
    expect(at("the buffer closed into the upgrade")).toBeLessThan(
      at("if (readsLiveState(pl.mode)) await readByNewBinary(deployer);"),
    );
    const readBack = body.slice(at("async function readByNewBinary("));
    expect(readBack).toContain("getSetPauseFlagsInstructionAsync(");
    expect(readBack).toContain("pause.code !== ACCOUNT_DID_NOT_DESERIALIZE");
  });

  it("what migrate_config would refuse is refused by the plan, before anything is sent", () => {
    const plan = src.slice(src.indexOf("async function plan("), src.indexOf("function printPlan("));
    expect(plan).toContain("carriesMigrateConfig(elf)");
    expect(plan).toContain("migrationRefusals(config)");
    expect(plan.indexOf("check(refusals.length === 0")).toBeLessThan(plan.indexOf("return {"));
  });

  it("a binary without sweep_round_vrf, or not the one named, is refused before anything is sent", () => {
    const plan = src.slice(src.indexOf("async function plan("), src.indexOf("function printPlan("));
    const at = (s: string) => plan.indexOf(s);
    expect(plan).toContain("carriesSweepRoundVrf(elf)");
    expect(plan).toContain("EXPECT_SHA256 === null || EXPECT_SHA256 === elfSha256");
    // Every mode: a stale build equal to the live binary is no "verify".
    expect(at("carriesSweepRoundVrf(elf)")).toBeLessThan(at("const mode: Mode"));
    // An upgrade names the reviewed binary; checked before the buffer is planned.
    expect(plan).toContain("!(CONFIRM && upgrades(mode) && EXPECT_SHA256 === null)");
    expect(at("!(CONFIRM && upgrades(mode)")).toBeGreaterThan(at("const mode: Mode"));
    expect(at("!(CONFIRM && upgrades(mode)")).toBeLessThan(at("existingBuffer("));
  });

  it("an upgrade-only run reads the newest open round through the new binary", () => {
    const upgradeOnly = body.slice(body.indexOf("async function readByNewBinary("));
    expect(upgradeOnly).toContain("await readsOpenRound(deployer)");
    expect(upgradeOnly).toContain("await knowsTicketSweep(deployer)");
    const reads = src.slice(
      src.indexOf("async function readsOpenRound("),
      src.indexOf("async function waitPastSlot("),
    );
    expect(reads).toContain("v.acceptingRound !== 0n ? v.acceptingRound : v.nextRoundId - 1n");
    expect(reads).toContain("getBeaconSweepVrfInstructionAsync(deployer, id, null");
    expect(reads).toContain("await simulate(deployer,");
    expect(reads).not.toContain("await send(");
    // The status is read again after the simulation, and both reads judge it.
    expect(reads).toContain("const after = await statusNow();");
    expect(reads.indexOf("const status = await statusNow();")).toBeLessThan(
      reads.indexOf("await simulate(deployer,"),
    );
    expect(reads.lastIndexOf("await simulate(deployer,")).toBeLessThan(
      reads.indexOf("const after = await statusNow();"),
    );
    expect(reads).toContain("sweepReadRound(sweep, [status, after])");
    // A node that does not run the new binary yet is asked again, a slot later.
    expect(reads).toMatch(
      /for \(let attempt = 1; notYetUpgraded\(sweep\) && attempt < EARLY_ATTEMPTS; attempt\+\+\) \{\s*await waitPastSlot\(await currentSlot\(\)\);\s*sweep = await simulate\(deployer, \[ix\]\);/,
    );
    expect(read("programs/fade/src/errors.rs")).toContain("WrongRoundStatus, // 6058");
  });

  it("an accepting round the program no longer owns is reported closed: a paid round drawn and closed keeps accepting_round", () => {
    const reads = src.slice(
      src.indexOf("async function readsOpenRound("),
      src.indexOf("async function waitPastSlot("),
    );
    const at = (s: string) => reads.indexOf(s);
    // round_end clears accepting_round on the refund path only, join_round only sets it, and
    // close_if_ended closes a drawn, settled round without touching the Vault.
    const roundEnd = read("programs/fade/src/instructions/round_end.rs");
    expect(roundEnd.match(/vault\.accepting_round = /g)).toHaveLength(1);
    expect(roundEnd.indexOf("vault.accepting_round = 0;")).toBeGreaterThan(0);
    expect(roundEnd.indexOf("vault.accepting_round = 0;")).toBeLessThan(
      roundEnd.indexOf("round.status = RoundStatus::Refunded;"),
    );
    const joinRound = read("programs/fade/src/instructions/join_round.rs");
    expect(joinRound.match(/vault\.accepting_round = /g)).toEqual(["vault.accepting_round = "]);
    expect(joinRound).toContain("vault.accepting_round = round.id;");
    expect(read("programs/fade/src/instructions/rounds.rs")).not.toContain("accepting_round");
    // the id read is the accepting round's, and one the program does not own reads as closed
    expect(reads).toContain("v.acceptingRound !== 0n ? v.acceptingRound : v.nextRoundId - 1n");
    expect(reads).not.toContain("status !== null || v.acceptingRound === 0n");
    expect(at("const status = await statusNow();")).toBeLessThan(at("if (status === null"));
    // on a clone, an accepting round devnet's program still owns and the clone's does not fails
    const clone = reads.slice(at("LOCAL_HOSTS.includes(new URL(RPC_URL).hostname)"));
    expect(clone).toContain("createSolanaRpc(DEVNET_URL)");
    expect(clone).toContain(".getAccountInfo(round,");
    expect(clone).toContain("value?.owner !== PROGRAM,");
    expect(at("LOCAL_HOSTS.includes(new URL(RPC_URL).hostname)")).toBeLessThan(
      at('read: "closed: no open round to read"'),
    );
    expect(reads.slice(reads.indexOf("if (status === null) return"))).toMatch(
      /^if \(status === null\) return \{ round: id\.toString\(\), read: "closed: no open round to read" \};/,
    );
  });

  it("a confirmed verify run repeats the checks after the upgrade, so a rerun after one failed proves them", () => {
    expect(src).toContain(
      'const readsLiveState = (mode: Mode) => mode === "upgrade-only" || mode === "verify";',
    );
    expect(body).toContain("if (readsLiveState(pl.mode)) await readByNewBinary(deployer);");
    const at = (s: string) => body.indexOf(s);
    expect(at("if (readsLiveState(pl.mode)) await readByNewBinary(deployer);")).toBeLessThan(
      at('record("6. Config and Vault read back"'),
    );
    const checks = body.slice(at("async function readByNewBinary("));
    for (const step of [
      "the new binary reads the version-2 Config (set_pause_flags simulated)",
      "await readsOpenRound(deployer)",
      "await knowsTicketSweep(deployer)",
    ])
      expect(checks).toContain(step);
    // the hint after such a failure says the rerun runs them again, not that it only verifies
    const hint = src.slice(src.indexOf("async function failureHint("));
    expect(hint).not.toContain("A rerun only verifies");
    expect(hint).toContain("runs the checks after the upgrade again");
  });

  it("a partly written buffer of the right size is resumed, any other refused", () => {
    expect(src).toContain("!buffer.exists || buffer.resumable");
  });

  it("is run through the toolchain on the live deployment", () => {
    expect(read("package.json")).toContain(
      '"devnet:upgrade-live": "bash scripts/devnet/upgrade-live.sh"',
    );
    const sh = read("scripts/devnet/upgrade-live.sh");
    expect(sh).toContain("pnpm exec tsx scripts/devnet/upgrade-live.ts");
    expect(src).toContain(
      'const LIVE_CONFIG = address("9SWzMCw6JssmpQinyeKEa8RN8T6w7JLyZdNSxUbhAYVU")',
    );
  });

  it("the rehearsal can serve its clone to it", () => {
    const sh = read("scripts/devnet/migrate-rehearsal.sh");
    expect(sh).toContain("--serve) serve=true ;;");
    expect(sh).toContain('wait "$validator"');
  });

  it("the clone holds the live rounds, so the new binary reads a real one there", () => {
    const rehearsal = read("scripts/devnet/migrate-rehearsal.ts");
    const cloned = rehearsal.slice(rehearsal.indexOf("async function cloned("));
    expect(cloned).toContain("...(await liveRoundAccounts(devnet)),");
    const rounds = rehearsal.slice(
      rehearsal.indexOf("async function liveRoundAccounts("),
      rehearsal.indexOf("async function cloned("),
    );
    for (const what of [
      "ROUND_DISCRIMINATOR",
      "findRoundVrfPda({ round }, cfg)",
      "ROUND_TICKET_DISCRIMINATOR",
      "SPONSORSHIP_DISCRIMINATOR",
    ])
      expect(rounds).toContain(what);
  });
});

describe("the binary and the program data", () => {
  const elfWith = (...keys: Address[]) => {
    const out = new Uint8Array(256);
    keys.forEach((k, i) => out.set(getAddressEncoder().encode(k), 16 + i * 64));
    return out;
  };

  it("the binary must carry the live address: a mainnet build or a stray file is refused", () => {
    expect(carries(elfWith(LIVE), LIVE)).toBe(true);
    expect(carries(elfWith(MAINNET), LIVE)).toBe(false);
    expect(carries(new Uint8Array(256), LIVE)).toBe(false);
  });

  it("extends by what the binary lacks plus a margin of at most 4 KiB, nothing when it fits", () => {
    expect(EXTEND_MARGIN).toBeGreaterThan(0);
    expect(EXTEND_MARGIN).toBeLessThanOrEqual(4096);
    expect(extendBy(1_210_664, 832_888)).toBe(1_210_664 - 832_888 + EXTEND_MARGIN);
    expect(extendBy(832_888, 832_888)).toBe(0);
    expect(extendBy(100, 832_888)).toBe(0);
  });

  it("a buffer is resumable under the deployer at the binary's size, and holds it only byte for byte", () => {
    const deployer = address("7YpnKCWPQGWPHuhLUsGvqYDx2f15iU7G4HdtsKiHrddG");
    const elf = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
    const buffer = (bytes: Uint8Array, authority: Address | null = deployer, tag = 1) => {
      const out = new Uint8Array(BUFFER_HEADER + bytes.length);
      out[0] = tag;
      if (authority) {
        out[4] = 1;
        out.set(getAddressEncoder().encode(authority), 5);
      }
      out.set(bytes, BUFFER_HEADER);
      return out;
    };
    const partial = new Uint8Array(elf.length);
    partial.set(elf.subarray(0, 20));
    expect(bufferHolds(buffer(elf), elf, deployer)).toBe(true);
    expect(bufferFits(buffer(partial), elf, deployer)).toBe(true);
    expect(bufferHolds(buffer(partial), elf, deployer)).toBe(false);
    expect(bufferFits(buffer(partial, LIVE), elf, deployer)).toBe(false);
    expect(bufferFits(buffer(partial, null), elf, deployer)).toBe(false);
    expect(bufferFits(buffer(partial, deployer, 3), elf, deployer)).toBe(false);
    expect(bufferFits(buffer(partial.subarray(1)), elf, deployer)).toBe(false);
  });

  it("the binary must carry migrate_config (a devnet build)", () => {
    const elf = new Uint8Array(256);
    expect(carriesMigrateConfig(elf)).toBe(false);
    elf.set(new TextEncoder().encode("Program log: Instruction: MigrateConfig"), 100);
    expect(carriesMigrateConfig(elf)).toBe(true);
  });

  it("the binary must carry sweep_round_vrf (a build that has it)", () => {
    const elf = new Uint8Array(256);
    elf.set(new TextEncoder().encode("Program log: Instruction: MigrateConfig"), 100);
    expect(carriesSweepRoundVrf(elf)).toBe(false);
    elf.set(new TextEncoder().encode("Instruction: SweepRoundVrf"), 180);
    expect(carriesSweepRoundVrf(elf)).toBe(true);
  });

  it("an expected sha256 is 64 lowercase hex digits", () => {
    expect(isSha256("a4c3653cefa1ddabbb98e515d1283406dd16ec9f6c59b6d605fca4a08b52fc89")).toBe(true);
    expect(isSha256("a4c3653c")).toBe(false);
    expect(isSha256("A4C3653CEFA1DDABBB98E515D1283406DD16EC9F6C59B6D605FCA4A08B52FC89")).toBe(
      false,
    );
    expect(isSha256("g".repeat(64))).toBe(false);
  });

  it("a deployed program is the binary followed by zeros", () => {
    const elf = Uint8Array.from([1, 2, 3]);
    expect(deployedIs(Uint8Array.from([1, 2, 3]), elf)).toBe(true);
    expect(deployedIs(Uint8Array.from([1, 2, 3, 0, 0]), elf)).toBe(true);
    expect(deployedIs(Uint8Array.from([1, 2, 3, 0, 9]), elf)).toBe(false);
    expect(deployedIs(Uint8Array.from([1, 2, 4, 0]), elf)).toBe(false);
    expect(deployedIs(Uint8Array.from([1, 2]), elf)).toBe(false);
  });
});

describe("migrationMismatches", () => {
  const zeroConfig = getConfigDecoder().decode(new Uint8Array(V2_CONFIG_LEN));
  const council = address("7YpnKCWPQGWPHuhLUsGvqYDx2f15iU7G4HdtsKiHrddG");
  const v2 = (over: Partial<typeof zeroConfig> = {}, beacon = SPEC_BEACON) =>
    new Uint8Array(
      getConfigEncoder().encode({
        ...zeroConfig,
        version: 2,
        council,
        pauseFlags: 1 | PAUSE_ROUNDS,
        params: { ...zeroConfig.params, minPrice: 10_000n, ...beacon },
        pending: { ...zeroConfig.pending, params: { ...zeroConfig.pending.params, ...beacon } },
        ...over,
      }),
    );
  const oldConfig = backToV1(v2(), 1, 1);
  const zeroVault = getVaultDecoder().decode(new Uint8Array(getVaultSize()));
  const vault = (over: Partial<typeof zeroVault> = {}) =>
    new Uint8Array(getVaultEncoder().encode({ ...zeroVault, totalAssets: 5_000_000n, ...over }));
  const oldVault = vault();
  const ok = { oldConfig, newConfig: v2(), oldVault, newVault: vault({ nextRoundId: 1n }) };

  it("a right migration has none", () => {
    expect(oldConfig.length).toBe(V1_CONFIG_LEN);
    expect(migrationMismatches(ok)).toEqual([]);
  });

  it("names each thing a wrong one got wrong", () => {
    const wrong = (over: Partial<typeof ok>) => migrationMismatches({ ...ok, ...over }).join("; ");
    expect(wrong({ newConfig: v2().subarray(0, V1_CONFIG_LEN) })).toContain("not 791");
    expect(wrong({ newConfig: v2({ version: 1 }) })).toContain("version 1, not 2");
    expect(wrong({ newConfig: v2({ pauseFlags: 1 }) })).toContain("PAUSE_ROUNDS added");
    expect(wrong({ newConfig: v2({}, { ...SPEC_BEACON, roundK: 2n }) })).toContain(
      "params.roundK is not SPEC",
    );
    expect(wrong({ newConfig: v2({ council: LIVE }) })).toContain(
      "a version-1 Config byte changed",
    );
    expect(wrong({ newVault: vault({ nextRoundId: 1n, totalAssets: 1n }) })).toContain(
      "vault.totalAssets changed",
    );
    expect(wrong({ newVault: vault() })).toContain("vault.nextRoundId 0 → 0, not 1");
    expect(wrong({ newVault: vault({ nextRoundId: 1n, acceptingRound: 1n }) })).toContain(
      "vault.acceptingRound",
    );
    expect(wrong({ newVault: oldVault.subarray(1) })).toContain("the Vault changed size");
  });

  it("a Vault written after the migration by another transaction is not a mismatch", () => {
    const traffic = { ...ok, newVault: vault({ nextRoundId: 1n, totalAssets: 7_000_000n }) };
    expect(migrationMismatches({ ...traffic, vaultWrittenSince: true })).toEqual([]);
    expect(migrationMismatches(traffic).join("; ")).toContain("vault.totalAssets changed");
    // What the migration writes is still checked.
    expect(
      migrationMismatches({ ...traffic, newVault: vault(), vaultWrittenSince: true }).join("; "),
    ).toContain("vault.nextRoundId 0 → 0, not 1");
    expect(
      migrationMismatches({
        ...traffic,
        newConfig: v2({ pauseFlags: 1 }),
        vaultWrittenSince: true,
      }).join("; "),
    ).toContain("PAUSE_ROUNDS added");
  });
});

describe("migrationRefusals", () => {
  const zeroConfig = getConfigDecoder().decode(new Uint8Array(V2_CONFIG_LEN));
  // The live state: max_price 10 000 USDC, crank_settle_lamports 200 000.
  const live = { maxPrice: 10_000_000_000n, crankSettleLamports: 200_000n };
  const v1 = (params: Partial<typeof zeroConfig.params> = {}, pendingActive = false) =>
    backToV1(
      new Uint8Array(
        getConfigEncoder().encode({
          ...zeroConfig,
          version: 2,
          params: { ...zeroConfig.params, ...live, ...params },
          pending: {
            ...zeroConfig.pending,
            active: pendingActive,
            params: { ...zeroConfig.pending.params, ...live },
          },
        }),
      ),
      1,
      0,
    );

  it("the live state passes", () => {
    expect(v1().length).toBe(V1_CONFIG_LEN);
    expect(v1PendingActive(v1())).toBe(false);
    expect(migrationRefusals(v1())).toEqual([]);
  });

  it("refuses a max_price below the beacon's threshold", () => {
    expect(migrationRefusals(v1({ maxPrice: 8_639_999n })).join("; ")).toContain(
      "below the beacon's threshold 8640000",
    );
    expect(migrationRefusals(v1({ maxPrice: 8_640_000n }))).toEqual([]);
  });

  it("refuses a crank_settle_lamports below the beacon's", () => {
    expect(migrationRefusals(v1({ crankSettleLamports: 19_999n })).join("; ")).toContain(
      "crank_settle_lamports 19999",
    );
  });

  it("refuses an active pending change", () => {
    expect(v1PendingActive(v1({}, true))).toBe(true);
    expect(migrationRefusals(v1({}, true)).join("; ")).toContain("a parameter change is pending");
  });
});

describe("auditFixRefusals", () => {
  const config = (kappaBps: bigint, pending: bigint | null = null) => ({
    params: { kappaBps },
    pending: { active: pending !== null, params: { kappaBps: pending ?? kappaBps } },
  });
  const vault = (counted: bigint) => {
    const v = new Uint8Array(getVaultSize());
    new DataView(v.buffer).setBigUint64(TICKET_FORFEITS_WITHHELD_AT, counted, true);
    return v;
  };

  it("passes a zero counter under either binary", () => {
    expect(auditFixRefusals(config(MIN_KAPPA_BPS), vault(0n), false)).toEqual([]);
    expect(auditFixRefusals(config(MIN_KAPPA_BPS), vault(0n), true)).toEqual([]);
  });

  it("reads a non-zero counter as corruption only while the deployed binary predates the fixes", () => {
    expect(auditFixRefusals(config(MIN_KAPPA_BPS), vault(3n), false).join("; ")).toContain(
      "ticket_forfeits_withheld are not zero",
    );
    // a resumed or verification run, or a later upgrade: the fixes count expiries themselves
    expect(auditFixRefusals(config(MIN_KAPPA_BPS), vault(3n), true)).toEqual([]);
    expect(ticketForfeitsWithheld(vault(3n))).toBe(3n);
  });

  it("reads a non-zero tail as the counter after a rollback only with the proof of its last raise", () => {
    // the rollback left the counter at 3 under a binary without the fixes
    expect(auditFixRefusals(config(MIN_KAPPA_BPS), vault(3n), false).join("; ")).toContain(
      VAULT_TAIL_IS_COUNTER,
    );
    expect(auditFixRefusals(config(MIN_KAPPA_BPS), vault(3n), false, 3n)).toEqual([]);
    // an older raise, or a later one than the Vault holds: not this counter
    for (const proof of [2n, 4n])
      expect(auditFixRefusals(config(MIN_KAPPA_BPS), vault(3n), false, proof).join("; ")).toContain(
        `counts ${proof}`,
      );
  });

  it("refuses κ below the floor in every mode", () => {
    for (const deployed of [false, true]) {
      expect(auditFixRefusals(config(MIN_KAPPA_BPS - 1n), vault(0n), deployed)).toHaveLength(1);
      expect(
        auditFixRefusals(config(MIN_KAPPA_BPS, MIN_KAPPA_BPS - 1n), vault(0n), deployed),
      ).toHaveLength(1);
    }
  });
});

describe("counterProofOrdinal", () => {
  const program: Address = address("GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt");
  const authority: Address = address("HeuXg1Fn2R7TzzATextZjwySFq1m4YBgUdvXqbQuojsL");
  const other: Address = address("11111111111111111111111111111111");
  const expired = (withheld: bigint) =>
    getTicketExpiredEventEncoder().encode({
      version: 2,
      ticket: other,
      integrator: other,
      forfeited: 1n,
      requested: true,
      requestFound: true,
      checked: true,
      pending: false,
      refunded: false,
      refund: 0n,
      parked: false,
      ticketForfeitsWithheld: withheld,
    });
  const tx = (
    bodies: ArrayLike<number>[],
    err: unknown = null,
    by = program,
    signer = authority,
  ) => ({
    transaction: { message: { accountKeys: [other, by, signer] } },
    meta: {
      err,
      fee: 5_000n,
      innerInstructions: [
        {
          instructions: bodies.map((b) => ({
            programIdIndex: 1,
            accounts: [2],
            data: getBase58Decoder().decode(Uint8Array.from([...EVENT_IX_TAG, ...Array.from(b)])),
          })),
        },
      ],
    },
  });

  it("names the highest counter among the program's version-2 TicketExpired events", () => {
    expect(counterProofOrdinal(tx([expired(2n), expired(3n)]), program, authority)).toBe(3n);
  });

  it("names nothing for a failed transaction, another program, another authority or no expiry", () => {
    expect(
      counterProofOrdinal(tx([expired(3n)], { InstructionError: [0, "x"] }), program, authority),
    ).toBeNull();
    expect(counterProofOrdinal(tx([expired(3n)], null, other), program, authority)).toBeNull();
    expect(
      counterProofOrdinal(tx([expired(3n)], null, program, other), program, authority),
    ).toBeNull();
    expect(counterProofOrdinal(tx([]), program, authority)).toBeNull();
  });
});

describe("directDrainRefusals", () => {
  it("passes tickets paused with none in flight", () => {
    expect(directDrainRefusals(PAUSE_TICKETS | PAUSE_ROUNDS, [])).toEqual([]);
  });

  it("refuses tickets not paused, and any ticket still Open or Requested", () => {
    expect(directDrainRefusals(PAUSE_ROUNDS, []).join("; ")).toContain("PAUSE_TICKETS is not set");
    const inFlight = directDrainRefusals(PAUSE_TICKETS, [LIVE]);
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]).toContain("1 direct ticket(s) still Open or Requested");
    expect(directDrainRefusals(0, [LIVE])).toHaveLength(2);
  });
});

describe("the post-upgrade answers", () => {
  const ok = { err: null, code: null };
  const refused = { err: { InstructionError: [0, { Custom: 6058 }] }, code: WRONG_ROUND_STATUS };

  it("WrongRoundStatus is FadeError 6058, InstructionFallbackNotFound Anchor's 101", () => {
    expect(WRONG_ROUND_STATUS).toBe(6058);
    expect(INSTRUCTION_FALLBACK_NOT_FOUND).toBe(101);
  });

  it("a sweep that succeeds reads the round, whatever its status", () => {
    for (const s of [RoundStatus.Accepting, RoundStatus.Paid, RoundStatus.Requested, null])
      expect(sweepReadRound(ok, [s, s])).toBe(true);
  });

  it("WrongRoundStatus is accepted when the round is Requested at either read", () => {
    // Read Paid, then the keeper's request lands before the simulation.
    expect(sweepReadRound(refused, [RoundStatus.Paid, RoundStatus.Requested])).toBe(true);
    // Read Requested, drawn before the second read.
    expect(sweepReadRound(refused, [RoundStatus.Requested, RoundStatus.Drawn])).toBe(true);
    expect(sweepReadRound(refused, [RoundStatus.Requested, RoundStatus.Requested])).toBe(true);
  });

  it("WrongRoundStatus is refused when no read saw the round Requested", () => {
    expect(sweepReadRound(refused, [RoundStatus.Paid, RoundStatus.Paid])).toBe(false);
    expect(sweepReadRound(refused, [RoundStatus.Accepting, RoundStatus.Accepting])).toBe(false);
    expect(sweepReadRound(refused, [RoundStatus.Paid, null])).toBe(false);
  });

  it("any other refusal is refused, Requested or not", () => {
    for (const code of [INSTRUCTION_FALLBACK_NOT_FOUND, 3003, 6000, null])
      expect(
        sweepReadRound({ err: "refused", code }, [RoundStatus.Requested, RoundStatus.Requested]),
      ).toBe(false);
  });

  it("an answer from a node without the new binary is told apart", () => {
    expect(notYetUpgraded({ code: INSTRUCTION_FALLBACK_NOT_FOUND, logs: [] })).toBe(true);
    expect(
      notYetUpgraded({ code: null, logs: [`Program ${LIVE} invoke [1]`, NOT_DEPLOYED_YET] }),
    ).toBe(true);
    expect(notYetUpgraded({ code: WRONG_ROUND_STATUS, logs: [] })).toBe(false);
    expect(notYetUpgraded({ code: null, logs: [] })).toBe(false);
  });
});
