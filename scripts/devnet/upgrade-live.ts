// The in-place upgrade of the live devnet deployment to the current devnet
// build, and its `migrate_config` (Spec 08 §13.5.13) while `Config` is
// version 1, as rehearsed on a local clone by migrate-rehearsal.ts (the same
// instruction, the same room and the same checks: scripts/devnet/migration.ts).
//
// Without `--confirm` it is a dry run: every check below is read-only and
// the plan is printed, nothing is sent. With `--confirm`, in order:
//
//   1. the binary (target/devnet/fade.so) carries the live address,
//      `migrate_config`, `sweep_round_vrf` and the audit fixes' instructions
//      (`record_ticket_entropy`, `refund_expired_ticket`, `sweep_ticket_vrf`);
//      a run that upgrades also needs
//      `--expect-sha256 <hex>`, the sha256 of the build that was reviewed and
//      rehearsed, and refuses any other binary (a stale build, one from
//      another checkout) before the buffer is written;
//   2. the live state: the program data's upgrade authority is the
//      deployer, `Config` is version 1 (695 bytes), or version 2 (791 bytes),
//      in which case the program is only upgraded (under another binary, a
//      program change that keeps the version-2 layout) or verified (under
//      the new binary already: a confirmed verify run repeats the checks that
//      the new binary reads the live state, `readByNewBinary`); a version-1 `Config` that
//      `migrate_config` would refuse (the beacon's fields out of the current
//      parameters' bounds, a pending change) is refused before anything is
//      sent, as is a binary without it; a version-2 `Config` whose κ, live or
//      pending, is below `MIN_KAPPA_BPS`, or a `Vault` whose
//      `ticket_forfeits_withheld` bytes are not zero under a binary without
//      the audit fixes, is refused (after a rollback from them, those bytes
//      are the counter: `--vault-tail-is-counter <signature>` names the
//      transaction of its last raise, whose TicketExpired must count exactly
//      them), and a pending
//      change is reported (the no-timelock build applies the next
//      `set_params` at once, treasury included, replacing it: run
//      `apply_params` first if it is still wanted); an upgrade into the
//      audit fixes (the deployed binary predates them) is refused unless
//      `PAUSE_TICKETS` is set and no direct ticket is Open or Requested, and
//      both are checked again right before the upgrade;
//   3. the deployer holds the program data's extension, the buffer's rent and
//      the fees, with a margin; it refuses otherwise;
//   4. `solana program write-buffer` (the buffer's bytes checked against the
//      binary), `solana program extend` by the room the binary needs,
//      `solana program upgrade` from the buffer (its rent comes back), then,
//      on a version-1 `Config`, `migrate_config` with RiskParams::SPEC's
//      beacon fields in the next transaction;
//   5. after a migration, `Config` and `Vault` read back: 791 bytes, version
//      2, `PAUSE_ROUNDS` set, every version-1 byte kept, `next_round_id` 1,
//      every other Vault field unchanged unless a later transaction wrote the
//      Vault (the direct path runs again once migrated): that is reported,
//      not failed. After an upgrade only, `Config` read back version 2 and
//      read by the new binary (`set_pause_flags` simulated), the newest open
//      round read by it (`sweep_round_vrf` simulated), `sweep_ticket_vrf`
//      simulated on the deployer's first direct ticket, its pause flags and
//      beacon parameters reported as they are: an operator sets them. A
//      confirmed verify run (the new binary already deployed, Config version
//      2: a rerun after one of these checks failed) runs them again.
//
// A program upgraded but not migrated (a failed step 4) resumes at the
// migration on the next run. RPC_URL may name a local validator holding a
// clone of the live deployment (`pnpm devnet:migrate-rehearsal --serve`) to
// run the same path there first; Config's rent exemption is then checked
// against devnet's rent, which the clone's validator does not charge. Writes
// scripts/devnet/runs/upgrade-live-<ISO timestamp>.json on a confirmed run,
// whether it passed or not; no key.
//
//   pnpm devnet:upgrade-live                                   # dry run
//   pnpm devnet:upgrade-live --confirm --expect-sha256 <hex>
//   pnpm devnet:upgrade-live --confirm --expect-sha256 <hex> --vault-tail-is-counter <signature>
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import {
  address,
  createSolanaRpc,
  getAddressDecoder,
  getBase58Decoder,
  getBase64Encoder,
  isSignature,
  signature,
  type Address,
  type Base58EncodedBytes,
} from "@solana/kit";
import {
  RoundStatus,
  TICKET_DISCRIMINATOR,
  findRoundPda,
  getConfigDecoder,
  getIntegratorDecoder,
  getRoundDecoder,
  getSweepTicketVrfInstructionAsync,
  getSetPauseFlagsInstructionAsync,
  getVaultDecoder,
} from "../../clients/js/src/generated/fade/index.ts";
import { getBeaconSweepVrfInstructionAsync } from "../../clients/js/src/beacon/rounds.ts";
import {
  LIVE_PROGRAM,
  LOADER,
  PROGRAM,
  RPC_URL,
  accountData,
  accountOwner,
  currentSlot,
  fadePdas,
  fmtSol,
  integratorPda,
  loadDeployer,
  rentExempt,
  rpc,
  send,
  SendError,
  simulate,
  sleep,
  solBalance,
  transactionMeta,
  writeJson,
  type Sent,
} from "./lib.ts";
import {
  ACCOUNT_DID_NOT_DESERIALIZE,
  BEACON_FIELDS,
  BUFFER_HEADER,
  NEW_BINARY,
  PAUSE_FLAGS_AT,
  PAUSE_ROUNDS,
  PAUSE_TICKETS,
  PROGRAM_DATA_HEADER,
  SPEC_BEACON,
  V1_CONFIG_LEN,
  V2_CONFIG_LEN,
  VERSION_AT,
  bufferFits,
  bufferHolds,
  carriesMigrateConfig,
  carriesSweepRoundVrf,
  carriesAuditFixes,
  auditFixRefusals,
  counterProofOrdinal,
  VAULT_TAIL_IS_COUNTER,
  directDrainRefusals,
  TICKET_STATUS_AT,
  ticketForfeitsWithheld,
  carries,
  deployedIs,
  extendBy,
  isSha256,
  migrateIx,
  migrationMismatches,
  migrationRefusals,
  notYetUpgraded,
  programData,
  programDataAddress,
  sha256,
  sweepReadRound,
  v1PendingActive,
  vaultDrift,
} from "./migration.ts";

/** The live deployment's Config PDA. */
const LIVE_CONFIG = address("9SWzMCw6JssmpQinyeKEa8RN8T6w7JLyZdNSxUbhAYVU");
/** Devnet's genesis hash: an RPC named devnet that answers another cluster is refused. */
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEVNET_URL = "https://api.devnet.solana.com";
const DEVNET_HOSTS = ["api.devnet.solana.com"];
const LOCAL_HOSTS = ["127.0.0.1", "localhost"];
const DEPLOYER_KEY = "keys/deployer.json";
/**
 * The buffer's key, kept so that an interrupted write resumes into the same
 * buffer: write-buffer allocates it at full size first, then rewrites only
 * the chunks that differ from the binary.
 */
const BUFFER_KEY = "keys/upgrade-live-buffer.json";
/** A write-buffer transaction carries under 1 KiB of the binary: counted at 900 bytes. */
const WRITE_CHUNK = 900;
/** A signature fee and a priority fee, rounded up. */
const FEE_PER_TX = 10_000n;
/** Left on the deployer after the peak (buffer held, program data extended). */
const BALANCE_MARGIN = 30_000_000n;
/** How long the new binary may take to show in the program data once the upgrade is sent. */
const UPGRADE_VISIBLE_MS = 30_000;
/** Attempts at migrate_config, or at the sweep_round_vrf check, while the upgrade is not yet visible to the node that answers. */
const EARLY_ATTEMPTS = 5;

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const EXPECT_AT = args.indexOf("--expect-sha256");
/** The sha256 the binary must have to be deployed, or null when not given. */
const EXPECT_SHA256 = EXPECT_AT === -1 ? null : (args[EXPECT_AT + 1] ?? "");
const TAIL_AT = args.indexOf(VAULT_TAIL_IS_COUNTER);
/**
 * The transaction of `Vault.ticket_forfeits_withheld`'s last raise, or null when not given:
 * after a rollback from the audit fixes, what lets the counter through (`auditFixRefusals`).
 */
const TAIL_PROOF = TAIL_AT === -1 ? null : (args[TAIL_AT + 1] ?? "");

/** Refusals that need no RPC: an unknown argument, a malformed sha256, another cluster. */
function guards(): { local: boolean } {
  const valued = (at: number, i: number) => at !== -1 && (i === at || i === at + 1);
  const unknown = args.filter(
    (a, i) => a !== "--confirm" && !valued(EXPECT_AT, i) && !valued(TAIL_AT, i),
  );
  if (unknown.length) throw new Error(`upgrade-live: unknown argument ${unknown.join(" ")}`);
  if (EXPECT_SHA256 !== null && !isSha256(EXPECT_SHA256))
    throw new Error(
      `upgrade-live: --expect-sha256 takes the binary's full sha256, 64 lowercase hex digits, not "${EXPECT_SHA256}"`,
    );
  if (TAIL_PROOF !== null && !isSignature(TAIL_PROOF))
    throw new Error(
      `upgrade-live: ${VAULT_TAIL_IS_COUNTER} takes the signature of the counter's last raise, not "${TAIL_PROOF}"`,
    );
  const host = new URL(RPC_URL).hostname;
  const local = LOCAL_HOSTS.includes(host);
  if (!local && !DEVNET_HOSTS.includes(host))
    throw new Error(
      `upgrade-live runs against devnet (https://api.devnet.solana.com) or a local validator only, not ${RPC_URL}`,
    );
  return { local };
}

// --- run log -------------------------------------------------------------------------------

type Step = {
  name: string;
  result: "ok" | "failed";
  signature?: string;
  slot?: string;
  detail?: Record<string, unknown>;
  error?: string;
};
const steps: Step[] = [];
function record(name: string, sent: Sent | null, detail: Record<string, unknown> = {}) {
  steps.push({
    name,
    result: "ok",
    ...(sent ? { signature: sent.signature, slot: sent.slot.toString() } : {}),
    detail,
  });
  console.log(`  ✓ ${name}`);
}
function check(cond: boolean, what: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${what}`);
}

function solana(cliArgs: string[]): string {
  return execFileSync("solana", [...cliArgs, "-u", RPC_URL, "-k", DEPLOYER_KEY], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** The CLI's `--output json` answer, or its text when it is not JSON. */
function cliResult(out: string): unknown {
  try {
    return JSON.parse(out);
  } catch {
    return out.trim();
  }
}

// --- the live state, read-only -------------------------------------------------------------

type Mode = "upgrade-and-migrate" | "upgrade-only" | "migrate" | "verify";

/** The modes that replace the binary: buffer, extension, upgrade. */
const upgrades = (mode: Mode) => mode === "upgrade-and-migrate" || mode === "upgrade-only";

type Plan = {
  mode: Mode;
  local: boolean;
  deployer: Address;
  elf: Uint8Array;
  elfSha256: string;
  extend: number;
  buffer: { address: Address | null; holdsBinary: boolean; exists: boolean };
  costs: Record<string, bigint>;
  /** Whether the upgrade crosses into the audit fixes, which need the direct path drained. */
  drainRequired: boolean;
  directDrain: DirectDrain;
};

type DirectDrain = { ticketsPaused: boolean; inFlight: Address[]; refusals: string[] };

/** The direct path as an upgrade into the audit fixes needs it: tickets paused, none in flight. */
async function directDrain(pauseFlags: number): Promise<DirectDrain> {
  const accounts = await rpc
    .getProgramAccounts(PROGRAM, {
      encoding: "base64",
      commitment: "confirmed",
      dataSlice: { offset: 0, length: TICKET_STATUS_AT + 1 },
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: getBase58Decoder().decode(TICKET_DISCRIMINATOR) as Base58EncodedBytes,
            encoding: "base58",
          },
        },
      ],
    })
    .send();
  const inFlight = accounts
    .filter(({ account }) => {
      const status = new Uint8Array(getBase64Encoder().encode(account.data[0]))[TICKET_STATUS_AT];
      return status === 0 || status === 1;
    })
    .map(({ pubkey }) => pubkey);
  return {
    ticketsPaused: (pauseFlags & PAUSE_TICKETS) !== 0,
    inFlight,
    refusals: directDrainRefusals(pauseFlags, inFlight),
  };
}

/**
 * The buffer at BUFFER_KEY, if its key exists: whether it already holds the
 * binary, and whether write-buffer can resume into it (a Buffer of the
 * binary's size under the deployer, its bytes partly written).
 */
async function existingBuffer(elf: Uint8Array, deployer: Address) {
  if (!existsSync(BUFFER_KEY))
    return { address: null, holdsBinary: false, resumable: false, exists: false };
  const a = address(
    execFileSync("solana-keygen", ["pubkey", BUFFER_KEY], { encoding: "utf8" }).trim(),
  );
  const data = await accountData(a);
  if (!data) return { address: a, holdsBinary: false, resumable: false, exists: false };
  return {
    address: a,
    holdsBinary: bufferHolds(data, elf, deployer),
    resumable: bufferFits(data, elf, deployer),
    exists: true,
  };
}

/**
 * The ordinal `TAIL_PROOF`'s transaction names for the counter (`counterProofOrdinal`), or null
 * without the override. A transaction the RPC does not serve, a failed one, or one without a
 * version-2 `TicketExpired` of the program is refused.
 */
async function counterProof(eventAuthority: Address): Promise<bigint | null> {
  if (TAIL_PROOF === null) return null;
  const tx = await transactionMeta(signature(TAIL_PROOF));
  check(tx !== null, `${VAULT_TAIL_IS_COUNTER}: the RPC serves the transaction ${TAIL_PROOF}`);
  const ordinal = counterProofOrdinal(
    tx as unknown as Parameters<typeof counterProofOrdinal>[0],
    PROGRAM,
    eventAuthority,
  );
  check(
    ordinal !== null,
    `${VAULT_TAIL_IS_COUNTER}: ${TAIL_PROOF} is a successful transaction carrying a version-2 TicketExpired of ${PROGRAM}`,
  );
  return ordinal;
}

async function plan(local: boolean): Promise<Plan> {
  if (!local) {
    const genesis = await rpc.getGenesisHash().send();
    check(genesis === DEVNET_GENESIS, `the RPC answers devnet (genesis ${genesis})`);
  }
  console.log(`cluster: ${local ? `local validator ${RPC_URL}` : "devnet"}`);

  // 1. The binary.
  if (!existsSync(NEW_BINARY)) throw new Error(`missing ${NEW_BINARY}: run pnpm build:sbf:devnet`);
  const elf = new Uint8Array(readFileSync(NEW_BINARY));
  check(
    carries(elf, LIVE_PROGRAM),
    "the binary carries the live deployment's address: rebuild with pnpm build:sbf:devnet",
  );
  check(
    carriesMigrateConfig(elf),
    "the binary carries migrate_config: rebuild with pnpm build:sbf:devnet",
  );
  check(
    carriesSweepRoundVrf(elf),
    "the binary carries sweep_round_vrf: a build older than it, rebuild with pnpm build:sbf:devnet",
  );
  check(
    carriesAuditFixes(elf),
    "the binary carries record_ticket_entropy, refund_expired_ticket and sweep_ticket_vrf: a build older than the audit fixes, rebuild with pnpm build:sbf:devnet",
  );
  const elfSha256 = sha256(elf);
  console.log(`binary ${NEW_BINARY}: ${elf.length} bytes, sha256 ${elfSha256}`);
  check(
    EXPECT_SHA256 === null || EXPECT_SHA256 === elfSha256,
    `the binary is the one expected: sha256 ${elfSha256}, not ${EXPECT_SHA256}`,
  );

  // 2. The live state.
  const p = await fadePdas();
  check(p.config === LIVE_CONFIG, `the live Config is ${LIVE_CONFIG}`);
  const deployer = (await loadDeployer()).address;
  const { value: program } = await rpc
    .getAccountInfo(PROGRAM, { encoding: "base64", commitment: "confirmed" })
    .send();
  check(
    program !== null && program.owner === LOADER,
    "the program is owned by the upgradeable loader",
  );
  const programAccount = new Uint8Array(getBase64Encoder().encode(program.data[0]));
  const pdAddress = await programDataAddress();
  check(
    getAddressDecoder().decode(programAccount.subarray(4, 36)) === pdAddress,
    "the program points at its program data",
  );
  const pd = await programData();
  check(pd.authority === deployer, `the upgrade authority is the deployer ${deployer}`);
  const deployedNew = deployedIs(pd.elf, elf);
  console.log(
    `program data: ${pd.len} bytes of room, authority ${pd.authority}, ${deployedNew ? "runs the new binary" : "runs another binary"}`,
  );
  const config = await accountData(p.config);
  const vault = await accountData(p.vault);
  if (!config || !vault) throw new Error("the live Config or Vault is unreadable");
  const v1 = config.length === V1_CONFIG_LEN && config[VERSION_AT] === 1;
  const v2 = config.length === V2_CONFIG_LEN && config[VERSION_AT] === 2;
  check(
    v1 || v2,
    `Config is ${config.length} bytes, version ${config[VERSION_AT]}: neither 1 nor 2`,
  );
  const mode: Mode = v2
    ? deployedNew
      ? "verify"
      : "upgrade-only"
    : deployedNew
      ? "migrate"
      : "upgrade-and-migrate";
  // Nothing on-chain says which binary was reviewed: the operator names it.
  check(
    !(CONFIRM && upgrades(mode) && EXPECT_SHA256 === null),
    `an upgrade needs --expect-sha256 with the sha256 of the build reviewed and rehearsed (this one is ${elfSha256})`,
  );
  // The upgrade cannot be undone: what migrate_config would refuse is refused here.
  const refusals = v1 ? migrationRefusals(config) : [];
  check(refusals.length === 0, `migrate_config would refuse this Config: ${refusals.join("; ")}`);
  if (v2) {
    const c = getConfigDecoder().decode(config);
    const fixesDeployed = carriesAuditFixes(pd.elf);
    const proof = fixesDeployed ? null : await counterProof(p.eventAuthority);
    if (proof !== null)
      console.log(
        `${VAULT_TAIL_IS_COUNTER} ${TAIL_PROOF}: its TicketExpired counts ${proof}, the Vault's tail holds ${ticketForfeitsWithheld(vault)}`,
      );
    const audit = auditFixRefusals(c, vault, fixesDeployed, proof);
    check(audit.length === 0, `the audit fixes would refuse this state: ${audit.join("; ")}`);
    if (fixesDeployed)
      console.log(
        `the deployed binary carries the audit fixes: Vault.ticket_forfeits_withheld ${ticketForfeitsWithheld(vault)}`,
      );
    console.log(
      `κ ${c.params.kappaBps} bps; pending change: ${c.pending.active ? `active, due ${new Date(Number(c.pending.effectiveAt) * 1000).toISOString()}, treasury ${c.pending.protocolTreasury} (the next set_params replaces it: apply_params first if it is still wanted)` : "none"}`,
    );
  }
  const flags = config[PAUSE_FLAGS_AT]!;
  const drainRequired = upgrades(mode) && !carriesAuditFixes(pd.elf);
  const drain = await directDrain(flags);
  if (drainRequired) {
    console.log(
      `direct path: PAUSE_TICKETS ${drain.ticketsPaused ? "set" : "not set"}, ${drain.inFlight.length} ticket(s) Open or Requested`,
    );
    // The new binary's expiry of an Open ticket is one the running keeper never sends.
    check(
      !CONFIRM || drain.refusals.length === 0,
      `an upgrade into the audit fixes needs the direct path drained: ${drain.refusals.join("; ")}`,
    );
  }
  console.log(
    `Config: ${config.length} bytes, version ${config[VERSION_AT]}, pause flags ${flags}` +
      (v1 ? `, pending change ${v1PendingActive(config) ? "active" : "none"}` : ""),
  );
  console.log(
    `Vault: ${vault.length} bytes, next_round_id ${getVaultDecoder().decode(vault).nextRoundId}`,
  );

  // 3. What it costs, from the cluster's rent.
  const extend = upgrades(mode) ? extendBy(elf.length, pd.len) : 0;
  const pdLamports = await solBalance(pdAddress);
  const extendRent =
    extend > 0
      ? positive((await rentExempt(PROGRAM_DATA_HEADER + pd.len + extend)) - pdLamports)
      : 0n;
  const buffer = await existingBuffer(elf, deployer);
  check(
    !buffer.exists || buffer.resumable,
    `the buffer ${buffer.address} is not a buffer of this binary's size under the deployer: close it (solana program close ${buffer.address}) and remove ${BUFFER_KEY}`,
  );
  const bufferRent =
    upgrades(mode) && !buffer.exists ? await rentExempt(BUFFER_HEADER + elf.length) : 0n;
  const configTopUp = v1
    ? positive((await rentExempt(V2_CONFIG_LEN)) - (await solBalance(p.config)))
    : 0n;
  const writes = upgrades(mode) && !buffer.holdsBinary ? Math.ceil(elf.length / WRITE_CHUNK) : 0;
  const fees = BigInt(writes + 8) * FEE_PER_TX;
  const need = extendRent + bufferRent + configTopUp + fees + BALANCE_MARGIN;
  const balance = await solBalance(deployer);
  const costs = {
    extendRent,
    bufferRent,
    configTopUp,
    fees,
    margin: BALANCE_MARGIN,
    need,
    balance,
  };
  console.log(
    [
      `program data extension: ${extend} bytes, rent ${fmtSol(extendRent)}`,
      `buffer: ${!upgrades(mode) ? "not needed" : buffer.holdsBinary ? `${buffer.address} already holds the binary` : buffer.exists ? `${buffer.address} partly written: the write resumes into it` : `${BUFFER_HEADER + elf.length} bytes, rent ${fmtSol(bufferRent)} (back to the deployer at the upgrade)`}`,
      `Config rent top-up: ${fmtSol(configTopUp)}`,
      `fees: about ${fmtSol(fees)} (${writes} buffer writes), margin ${fmtSol(BALANCE_MARGIN)}`,
      `deployer ${deployer}: ${fmtSol(balance)}, needs ${fmtSol(need)}`,
    ].join("\n"),
  );
  if (mode !== "verify")
    check(
      balance >= need,
      `the deployer holds ${fmtSol(need)}: top it up by ${fmtSol(need - balance)}`,
    );
  return {
    mode,
    local,
    deployer,
    elf,
    elfSha256,
    extend,
    buffer,
    costs,
    drainRequired,
    directDrain: drain,
  };
}

const positive = (v: bigint) => (v > 0n ? v : 0n);

function printPlan(pl: Plan) {
  const upgradeSteps = [
    pl.buffer.holdsBinary
      ? `the buffer ${pl.buffer.address} already holds the binary`
      : pl.buffer.exists
        ? `solana program write-buffer ${NEW_BINARY} resumed into ${pl.buffer.address}, then check its bytes`
        : `solana program write-buffer ${NEW_BINARY} into ${BUFFER_KEY}'s address, then check its bytes`,
    pl.extend > 0 ? `solana program extend ${PROGRAM} ${pl.extend}` : "no program data extension",
    `solana program upgrade <buffer> ${PROGRAM}`,
  ];
  const lines: Record<Mode, string[]> = {
    "upgrade-and-migrate": [
      ...upgradeSteps,
      "migrate_config with RiskParams::SPEC's beacon fields, as soon as the new binary shows",
      "read back the program data, the buffer, Config and Vault",
    ],
    "upgrade-only": [
      ...upgradeSteps,
      "read back the program data and the buffer; Config still version 2, read by the new binary, and the newest open round read by it",
    ],
    migrate: [
      "the program already runs the new binary on a version-1 Config: migrate_config only",
      "read back Config and Vault",
    ],
    verify: [
      "Config is already version 2 under the new binary: verify only, nothing to send",
      "with --confirm, the checks after an upgrade again: Config, the newest open round and sweep_ticket_vrf read by the new binary (simulated)",
    ],
  };
  console.log(`\nplan (${pl.mode}):`);
  lines[pl.mode].forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
  if (upgrades(pl.mode) && EXPECT_SHA256 === null)
    console.log(
      `\n--confirm needs --expect-sha256 ${pl.elfSha256} once that is the sha256 recorded for the reviewed build.`,
    );
  if (pl.drainRequired && pl.directDrain.refusals.length)
    console.log(
      `\n--confirm is refused until the direct path is drained: ${pl.directDrain.refusals.join("; ")}.`,
    );
  if (pl.mode === "upgrade-only")
    console.log(
      "\nConfig keeps its version-2 layout: the keeper and the app keep running. A transaction\n" +
        "in the upgrade's slot fails (the program runs from the next) and is sent again." +
        (pl.drainRequired
          ? "\nPAUSE_TICKETS stops the beacon too until the unpause: no join, no sponsorship of an\n" +
            "Accepting round (an unpaid one refunds), no ticket joins; paid rounds settle." +
            AFTER_THE_UPGRADE
          : ""),
    );
  else if (pl.mode !== "verify")
    console.log(
      "\nBefore --confirm: wait until the keeper has nothing in flight (a keeper deploy from this\n" +
        "branch is refused until the migration); every instruction reading Config fails between the\n" +
        "upgrade and the migration.",
    );
}

/**
 * What follows a drained upgrade, before the council clears PAUSE_TICKETS (only the council lifts
 * a pause): the merge deploys the keeper and the app in two workflows, one of which can fail while
 * the other deploys, and the old keeper cannot end an Open ticket on the new binary.
 */
const AFTER_THE_UPGRADE =
  "\nThen merge, and keep PAUSE_TICKETS set until both the Deploy keeper and the Deploy app runs\n" +
  "succeeded and GET /v1/health answers with directWithheld and directPauseRecommended (only the\n" +
  "new keeper serves them); a failed deploy is run again with workflow_dispatch, still paused.\n" +
  "Then unpause with pnpm devnet:pause-tickets clear --confirm (it checks that health answer\n" +
  "and moves PAUSE_TICKETS alone), and run pnpm devnet:sweep-ticket-vrfs until it lists no\n" +
  "request still owed.";

// --- the confirmed run ---------------------------------------------------------------------

/**
 * The rent exemption of `space` bytes as devnet charges it. A local clone's validator
 * charges its own genesis rent, not devnet's, so on a clone the live accounts it copied are
 * checked against devnet's rent, read from devnet (nothing is sent to it).
 */
async function devnetRentExempt(space: number, local: boolean): Promise<bigint> {
  if (!local) return rentExempt(space);
  return createSolanaRpc(DEVNET_URL).getMinimumBalanceForRentExemption(BigInt(space)).send();
}

/**
 * Config 791 bytes, version 2, readable by the current layout, and the
 * Vault's round ids started. `fresh`: migrated by this run, so the beacon
 * starts paused with RiskParams::SPEC's parameters; otherwise both are an
 * operator's since, reported and not checked.
 */
async function verifyV2(fresh: boolean, local: boolean) {
  const p = await fadePdas();
  const config = await accountData(p.config);
  const vault = await accountData(p.vault);
  if (!config || !vault) throw new Error("the Config or Vault is unreadable");
  check(config.length === V2_CONFIG_LEN, `Config is ${config.length} bytes, not 791`);
  const c = getConfigDecoder().decode(config);
  check(c.version === 2, `Config version ${c.version}, not 2`);
  const v = getVaultDecoder().decode(vault);
  check(v.nextRoundId >= 1n, "vault.next_round_id starts at 1");
  check(
    v.acceptingRound === 0n || v.nextRoundId > 1n,
    "no round is accepting unless one was opened (next_round_id past 1)",
  );
  const roundsPaused = (c.pauseFlags & PAUSE_ROUNDS) !== 0;
  const beaconParamsAreSpec = BEACON_FIELDS.every((k) => c.params[k] === SPEC_BEACON[k]);
  if (fresh) {
    check(roundsPaused, "PAUSE_ROUNDS set: the beacon starts paused");
    check(beaconParamsAreSpec, "the beacon parameters are RiskParams::SPEC's");
  }
  check(
    (await rpc.getBalance(p.config, { commitment: "confirmed" }).send()).value >=
      (await devnetRentExempt(V2_CONFIG_LEN, local)),
    "Config is rent-exempt at 791 bytes",
  );
  return {
    configBytes: config.length,
    version: c.version,
    pauseFlags: c.pauseFlags,
    roundsPaused,
    beaconParams: Object.fromEntries(BEACON_FIELDS.map((k) => [k, c.params[k].toString()])),
    beaconParamsAreSpec,
    nextRoundId: v.nextRoundId.toString(),
    acceptingRound: v.acceptingRound.toString(),
  };
}

/**
 * `sweep_round_vrf` simulated on the newest round the program still owns
 * (the accepting round, else the last one opened): the new binary
 * deserialises a live `Round` and knows the sweep. It succeeds, moving at
 * most what `round_vrf` holds, or refuses a `Requested` round
 * (`WrongRoundStatus`) once it has read it. The status is read before and
 * after the simulation, since the keeper may request the round's draw in
 * between (`sweepReadRound`). A node that does not run the new binary yet is
 * asked again a slot later (`notYetUpgraded`). Nothing to read when the last
 * round opened has closed and none is accepting: reported, not failed. So is
 * an accepting round the program no longer owns: `round_end` clears
 * `vault.accepting_round` only on a refund, and a `Paid` round keeps its id
 * there once it is drawn, settled and closed (`close_if_ended`). Under `PAUSE_TICKETS` no
 * join opens another, so the live devnet may hold no round left to read.
 */
async function readsOpenRound(deployer: Awaited<ReturnType<typeof loadDeployer>>) {
  const vault = await accountData((await fadePdas()).vault);
  if (!vault) throw new Error("the Vault is unreadable");
  const v = getVaultDecoder().decode(vault);
  const id = v.acceptingRound !== 0n ? v.acceptingRound : v.nextRoundId - 1n;
  if (id < 1n) return { round: null, read: "no round opened yet" };
  const [round] = await findRoundPda({ roundId: id }, { programAddress: PROGRAM });
  // Decoded by this checkout's layout, read by the new binary's. Null once closed.
  const statusNow = async () => {
    const data = (await accountOwner(round)) === PROGRAM ? await accountData(round) : null;
    return data ? getRoundDecoder().decode(data).status : null;
  };
  const status = await statusNow();
  // A paid round drawn and closed keeps vault.accepting_round: closed, as join_round reads it.
  // On a clone, closed only if devnet has closed it too: a clone without the round accounts
  // would otherwise report the round closed and the new binary never read it.
  if (
    status === null &&
    v.acceptingRound !== 0n &&
    LOCAL_HOSTS.includes(new URL(RPC_URL).hostname)
  ) {
    const { value } = await createSolanaRpc(DEVNET_URL)
      .getAccountInfo(round, { encoding: "base64", commitment: "confirmed" })
      .send();
    check(
      value?.owner !== PROGRAM,
      `the clone holds the Vault's accepting round ${id} as devnet does (devnet's program owns it, the clone's does not: clone the round accounts)`,
    );
  }
  if (status === null) return { round: id.toString(), read: "closed: no open round to read" };
  const ix = await getBeaconSweepVrfInstructionAsync(deployer, id, null, {
    programAddress: PROGRAM,
  });
  let sweep = await simulate(deployer, [ix]);
  for (let attempt = 1; notYetUpgraded(sweep) && attempt < EARLY_ATTEMPTS; attempt++) {
    await waitPastSlot(await currentSlot());
    sweep = await simulate(deployer, [ix]);
  }
  const after = await statusNow();
  check(
    sweepReadRound(sweep, [status, after]),
    `the new binary reads round ${id}, ${RoundStatus[status]}${after !== status ? ` then ${after === null ? "closed" : RoundStatus[after]}` : ""} (sweep_round_vrf simulated: ${sweep.code ?? JSON.stringify(sweep.err)})`,
  );
  return {
    round: id.toString(),
    status: RoundStatus[status],
    ...(after !== status ? { statusAfter: after === null ? "closed" : RoundStatus[after] } : {}),
    sweepRoundVrfSimulation: sweep.code ?? "ok",
  };
}

async function waitPastSlot(slot: bigint) {
  for (let s = await currentSlot(); s <= slot; s = await currentSlot()) await sleep(400);
}

/**
 * `sweep_ticket_vrf(0)` simulated for the deployer's integrator: the new binary knows the
 * instruction. It succeeds (the ticket closed, moving at most what its vrf_payer holds) or
 * refuses a ticket still open (`WrongTicketStatus`); an unknown instruction fails the check.
 * Nothing to simulate while the deployer has opened no direct ticket: reported, not failed.
 */
async function knowsTicketSweep(deployer: Awaited<ReturnType<typeof loadDeployer>>) {
  const integrator = await integratorPda(deployer.address);
  const data = (await accountOwner(integrator)) === PROGRAM ? await accountData(integrator) : null;
  if (!data || getIntegratorDecoder().decode(data).nextNonce === 0n)
    return { sweepTicketVrf: "the deployer has opened no direct ticket: nothing to simulate" };
  const p = await fadePdas();
  const ix = await getSweepTicketVrfInstructionAsync(
    {
      caller: deployer,
      integrator,
      nonce: 0n,
      eventAuthority: p.eventAuthority,
      program: PROGRAM,
    },
    { programAddress: PROGRAM },
  );
  let sweep = await simulate(deployer, [ix]);
  for (let attempt = 1; notYetUpgraded(sweep) && attempt < EARLY_ATTEMPTS; attempt++) {
    await waitPastSlot(await currentSlot());
    sweep = await simulate(deployer, [ix]);
  }
  check(
    sweep.err === null || sweep.code === WRONG_TICKET_STATUS,
    `the new binary knows sweep_ticket_vrf (simulated: ${sweep.code ?? JSON.stringify(sweep.err)})`,
  );
  return { sweepTicketVrfSimulation: sweep.code ?? "ok" };
}

/** FadeError::WrongTicketStatus: a ticket still open, read by `sweep_ticket_vrf`. */
const WRONG_TICKET_STATUS = 6029;

async function execute(pl: Plan) {
  const deployer = await loadDeployer();
  const p = await fadePdas();
  let upgraded: { slot: bigint; at: number } | null = null;
  let afterUpgrade: { bufferAddress: Address; cli: unknown } | null = null;

  if (upgrades(pl.mode)) {
    // The buffer first: the program is untouched until it holds the binary.
    if (!existsSync(BUFFER_KEY)) {
      execFileSync(
        "solana-keygen",
        ["new", "--no-bip39-passphrase", "--silent", "--outfile", BUFFER_KEY],
        { stdio: "ignore" },
      );
      chmodSync(BUFFER_KEY, 0o600);
    }
    const bufferAddress = address(
      execFileSync("solana-keygen", ["pubkey", BUFFER_KEY], { encoding: "utf8" }).trim(),
    );
    if (!pl.buffer.holdsBinary) {
      const out = solana([
        "program",
        "write-buffer",
        NEW_BINARY,
        "--buffer",
        BUFFER_KEY,
        "--buffer-authority",
        DEPLOYER_KEY,
        "--output",
        "json",
      ]);
      record("1. write-buffer", null, { buffer: bufferAddress, cli: cliResult(out) });
    }
    const bufferData = await accountData(bufferAddress);
    check(
      bufferData !== null && bufferHolds(bufferData, pl.elf, deployer.address),
      "the buffer holds the binary byte for byte, under the deployer",
    );
    record("1. buffer checked", null, {
      buffer: bufferAddress,
      sha256: sha256(bufferData.subarray(BUFFER_HEADER)),
      bytes: bufferData.length - BUFFER_HEADER,
      slot: (await currentSlot()).toString(),
    });

    // Config still in the version planned right before the program changes.
    const config = await accountData(p.config);
    check(
      config !== null &&
        (pl.mode === "upgrade-only"
          ? config.length === V2_CONFIG_LEN && config[VERSION_AT] === 2
          : config.length === V1_CONFIG_LEN),
      `Config is still version ${pl.mode === "upgrade-only" ? 2 : 1}`,
    );
    // Still drained right before the program changes: the buffer's write took minutes.
    if (pl.drainRequired) {
      const drain = await directDrain(config[PAUSE_FLAGS_AT]!);
      check(
        drain.refusals.length === 0,
        `the direct path is still drained before the upgrade: ${drain.refusals.join("; ")}`,
      );
      record("1. direct path drained", null, {
        ticketsPaused: drain.ticketsPaused,
        inFlight: drain.inFlight.length,
      });
    }

    if (pl.extend > 0) {
      const out = solana(["program", "extend", PROGRAM, String(pl.extend), "--output", "json"]);
      const pd = await waitForRoom(pl.elf.length);
      check(
        pd !== null && pd.len >= pl.elf.length,
        `the program data has room for the binary within ${UPGRADE_VISIBLE_MS / 1000} s of the extension`,
      );
      // An upgrade in the slot of the extension is refused.
      await waitPastSlot(await currentSlot());
      record("2. extend", null, {
        by: pl.extend,
        programDataBytes: pd.len,
        slot: (await currentSlot()).toString(),
        cli: cliResult(out),
      });
    }

    // On a version-1 Config, every instruction reading Config fails from here
    // until the migration lands, so nothing but the wait for the new binary
    // sits in between. The CLI may also throw after the upgrade landed (a
    // confirmation timeout): the program data decides.
    let cli: unknown;
    try {
      cli = cliResult(
        solana([
          "program",
          "upgrade",
          bufferAddress,
          PROGRAM,
          "--upgrade-authority",
          DEPLOYER_KEY,
          "--output",
          "json",
        ]),
      );
    } catch (e) {
      cli = { error: e instanceof Error ? e.message : String(e) };
    }
    upgraded = { slot: await currentSlot(), at: Date.now() };
    check(
      await waitForBinary(pl.elf),
      `the program runs the new binary within ${UPGRADE_VISIBLE_MS / 1000} s of the upgrade`,
    );
    // The program data shows the binary in the upgrade's slot; it runs from the next.
    await waitPastSlot(upgraded.slot + 1n);
    afterUpgrade = { bufferAddress, cli };
  }

  // Unless only upgraded, the program now runs the new binary on a version-1
  // Config (checked right before the upgrade, or by plan() in "migrate"
  // mode): migrate at once.
  let oldConfig: Uint8Array | null = null;
  let oldVault: Uint8Array | null = null;
  let migrated: Sent | null = null;
  let migratedAt = 0;
  if (pl.mode === "upgrade-and-migrate") {
    // Read before sending, but checked only once the migration is sent:
    // neither account can change under the new binary until migrate_config runs.
    [oldConfig, oldVault] = await Promise.all([accountData(p.config), accountData(p.vault)]);
    migrated = await sendMigrate(deployer);
    migratedAt = Date.now();
  } else if (pl.mode === "migrate") {
    oldConfig = await accountData(p.config);
    oldVault = await accountData(p.vault);
    if (!oldConfig || !oldVault) throw new Error("the Config or Vault is unreadable");
    check(oldConfig.length === V1_CONFIG_LEN, "Config is version 1 before the migration");
    migrated = await sendMigrate(deployer);
    migratedAt = Date.now();
  }

  if (afterUpgrade && upgraded) {
    const { bufferAddress, cli } = afterUpgrade;
    record("3. upgrade", null, { slot: upgraded.slot.toString(), cli });
    const pd = await programData();
    check(deployedIs(pd.elf, pl.elf), "the program runs the new binary");
    check((await accountData(bufferAddress)) === null, "the buffer closed into the upgrade");
    record("3. new binary deployed", null, { sha256: pl.elfSha256, programDataBytes: pd.len });
  }

  if (migrated) {
    if (!oldConfig || !oldVault) throw new Error("the Config or Vault was unreadable");
    check(oldConfig.length === V1_CONFIG_LEN, "Config was version 1 before the migration");
    record("4. migrate_config", migrated, {
      afterUpgrade: upgraded
        ? { slots: (migrated.slot - upgraded.slot).toString(), ms: migratedAt - upgraded.at }
        : "resumed: the program was already upgraded",
    });
    const newConfig = await accountData(p.config);
    const newVault = await accountData(p.vault);
    if (!newConfig || !newVault) throw new Error("the Config or Vault is gone");
    // Read after the accounts: when the migration is still the Vault's latest
    // transaction, nothing else wrote what was read.
    const [latest] = await rpc
      .getSignaturesForAddress(p.vault, { limit: 1, commitment: "confirmed" })
      .send();
    const vaultWrittenSince = latest?.signature !== migrated.signature;
    const wrong = migrationMismatches({
      oldConfig,
      newConfig,
      oldVault,
      newVault,
      vaultWrittenSince,
    });
    check(wrong.length === 0, `the migration: ${wrong.join("; ")}`);
    check(getVaultDecoder().decode(newVault).nextRoundId === 1n, "vault.next_round_id is 1");
    check(
      ((newConfig[PAUSE_FLAGS_AT] ?? 0) & PAUSE_ROUNDS) !== 0,
      "PAUSE_ROUNDS set: the beacon starts paused",
    );
    const again = await simulate(deployer, [await migrateIx(deployer.address)]);
    check(again.code === ACCOUNT_DID_NOT_DESERIALIZE, "a second migration is refused");
    // An instruction reading Config deserialises it again (simulated only).
    const pause = await simulate(deployer, [
      await getSetPauseFlagsInstructionAsync(
        {
          authority: deployer,
          pauseFlags: newConfig[PAUSE_FLAGS_AT]!,
          integratorPaused: null,
          eventAuthority: p.eventAuthority,
          program: PROGRAM,
        },
        { programAddress: PROGRAM },
      ),
    ]);
    check(
      pause.code !== ACCOUNT_DID_NOT_DESERIALIZE,
      "the new binary reads the migrated Config (set_pause_flags simulated)",
    );
    record("5. every version-1 byte kept, the Vault unchanged but next_round_id 0 → 1", null, {
      vaultWrittenSince,
      ...(vaultWrittenSince
        ? { vaultChangedByLaterTransactions: vaultDrift(oldVault, newVault) }
        : {}),
      secondMigrationRefused: true,
      setPauseFlagsSimulation: pause.code ?? (pause.err ? "refused" : "ok"),
    });
  }
  // After an upgrade, and again on every confirmed verify run: a rerun after one of these
  // failed (the program upgraded, Config version 2) is a verify run, and records ok only once
  // they pass.
  if (readsLiveState(pl.mode)) await readByNewBinary(deployer);
  record("6. Config and Vault read back", null, await verifyV2(migrated !== null, pl.local));
}

/** The modes whose confirmed run checks the new binary reads the live version-2 state. */
const readsLiveState = (mode: Mode) => mode === "upgrade-only" || mode === "verify";

/**
 * The new binary reads the live state: the version-2 Config (`set_pause_flags` simulated), the
 * newest open round (`readsOpenRound`) and `sweep_ticket_vrf` (`knowsTicketSweep`). Simulated
 * only.
 */
async function readByNewBinary(deployer: Awaited<ReturnType<typeof loadDeployer>>) {
  const p = await fadePdas();
  const config = await accountData(p.config);
  check(config !== null, "Config is readable");
  const pause = await simulate(deployer, [
    await getSetPauseFlagsInstructionAsync(
      {
        authority: deployer,
        pauseFlags: config[PAUSE_FLAGS_AT]!,
        integratorPaused: null,
        eventAuthority: p.eventAuthority,
        program: PROGRAM,
      },
      { programAddress: PROGRAM },
    ),
  ]);
  check(
    pause.code !== ACCOUNT_DID_NOT_DESERIALIZE,
    "the new binary reads the version-2 Config (set_pause_flags simulated)",
  );
  record("4. Config read by the new binary", null, {
    setPauseFlagsSimulation: pause.code ?? (pause.err ? "refused" : "ok"),
  });
  record("5. the newest open round read by the new binary", null, await readsOpenRound(deployer));
  record("5b. sweep_ticket_vrf known to the new binary", null, await knowsTicketSweep(deployer));
}

/**
 * Polls the program data until it has room for `bytes`, for
 * UPGRADE_VISIBLE_MS, for the same reason as waitForBinary: failing on a
 * lagging read would abort a paid extension, and a rerun planned from that
 * read would extend again. Null when the wait runs out.
 */
async function waitForRoom(bytes: number): Promise<Awaited<ReturnType<typeof programData>> | null> {
  const until = Date.now() + UPGRADE_VISIBLE_MS;
  for (;;) {
    const pd = await programData().catch(() => null);
    if (pd && pd.len >= bytes) return pd;
    if (Date.now() >= until) return null;
    await sleep(400);
  }
}

/**
 * Polls the program data until it holds `elf`, for UPGRADE_VISIBLE_MS: a
 * load-balanced RPC may answer from a node a little behind the one the CLI
 * confirmed against. False when the wait runs out.
 */
async function waitForBinary(elf: Uint8Array): Promise<boolean> {
  const until = Date.now() + UPGRADE_VISIBLE_MS;
  for (;;) {
    const pd = await programData().catch(() => null);
    if (pd && deployedIs(pd.elf, elf)) return true;
    if (Date.now() >= until) return false;
    await sleep(400);
  }
}

/**
 * Sends `migrate_config`, again for a few slots while the node that answers
 * still runs the old binary (which refuses it as an unknown instruction) or
 * has not started the new one yet (not deployed): either changes nothing.
 */
async function sendMigrate(deployer: Awaited<ReturnType<typeof loadDeployer>>): Promise<Sent> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send(deployer, [await migrateIx(deployer.address)], "migrate_config");
    } catch (e) {
      const early = e instanceof SendError && notYetUpgraded(e);
      if (!early || attempt >= EARLY_ATTEMPTS) throw e;
      await waitPastSlot(await currentSlot());
    }
  }
}

/** What a failed run left, read back: what to do next depends on it. */
async function failureHint(elf: Uint8Array): Promise<string> {
  try {
    const [pd, config] = await Promise.all([programData(), accountData((await fadePdas()).config)]);
    const upgraded = deployedIs(pd.elf, elf);
    const migrated = config?.length === V2_CONFIG_LEN && config[VERSION_AT] === 2;
    if (!upgraded)
      return "The program still runs its previous binary: fix the failure above, then run pnpm devnet:upgrade-live --confirm --expect-sha256 <hex> again.";
    if (!migrated)
      return "The program is upgraded but Config is not migrated: run pnpm devnet:upgrade-live --confirm again, which resumes at the migration.";
    return "The program is upgraded and Config is version 2: the failure is in a check after the upgrade. Fix its cause, then run pnpm devnet:upgrade-live --confirm again: under the new binary it is a verify run, which runs the checks after the upgrade again (Config, the newest open round and sweep_ticket_vrf read by the new binary) and records ok only once they pass.";
  } catch (e) {
    return `The state after the failure is unreadable (${e instanceof Error ? e.message : String(e)}): run pnpm devnet:upgrade-live to read it.`;
  }
}

// --- main ----------------------------------------------------------------------------------

async function main() {
  const { local } = guards();
  const pl = await plan(local);
  printPlan(pl);
  if (!CONFIRM) {
    if (pl.mode === "verify") console.log("\n", await verifyV2(false, local));
    console.log("\ndry run: nothing sent. Run again with --confirm to proceed.");
    return;
  }
  const startedAt = new Date();
  let ok = true;
  console.log(`\n▶ ${pl.mode}`);
  try {
    await execute(pl);
  } catch (e) {
    ok = false;
    const message = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${message}`);
    steps.push({ name: pl.mode, result: "failed", error: message });
  }
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const path = `scripts/devnet/runs/upgrade-live-${local ? "local-" : ""}${stamp}.json`;
  writeJson(path, {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    cluster: local ? `local validator ${RPC_URL}, the live devnet deployment cloned` : "devnet",
    program: PROGRAM,
    config: LIVE_CONFIG,
    mode: pl.mode,
    binary: { path: NEW_BINARY, bytes: pl.elf.length, sha256: pl.elfSha256 },
    costs: pl.costs,
    ...(TAIL_PROOF !== null ? { vaultTailIsCounter: TAIL_PROOF } : {}),
    directDrain: {
      required: pl.drainRequired,
      ticketsPaused: pl.directDrain.ticketsPaused,
      inFlight: pl.directDrain.inFlight,
    },
    result: ok ? "ok" : "failed",
    steps,
  });
  console.log(`\nupgrade-live ${ok ? "ok" : "FAILED"}, run written to ${path}`);
  if (!ok) {
    console.error(await failureHint(pl.elf));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
