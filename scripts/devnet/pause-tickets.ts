// Sets or clears PAUSE_TICKETS on the live devnet deployment, the first and the last step of the
// audit-fixes upgrade: `set_pause_flags`
// writes the whole flag byte, so this reads the flags `Config` holds and moves that one bit,
// PAUSE_DEPOSITS, PAUSE_NEW_INTEGRATORS and PAUSE_ROUNDS written back as they were
// (`ticketPauseFlags`). The signer is keys/deployer.json, refused unless it is the guardian or
// the council for `set`, the council for `clear` (only the council lifts a pause).
//
// `clear` also requires the new keeper while the live binary carries the audit fixes
// (`carriesAuditFixes` on the program data, as upgrade-live reads it): `GET
// <KEEPER_URL>/v1/health` (https://api.fade.finance unless KEEPER_URL names another) must answer
// with `directWithheld` and `directPauseRecommended`, which only the keeper with the audit fixes
// serves, after a tick that read the Vault's counter (`lastTick`, `directWithheld.counted`), and
// with `pauseRecommended` false: a recommended pause is resolved or acknowledged by a reviewed
// keeper deploy first, never overridden here (`newKeeperHealthRefusals`). Under a binary
// without the fixes (the cutover called off before the upgrade, or the rollback with its merge
// reverted) the old keeper is the right one, and the read is skipped with a note
// (`newKeeperRequired`). On a local validator (a clone) `--no-keeper-check` skips that read.
//
// Without `--confirm` it is a dry run: the change is simulated, nothing is sent. With
// `--confirm` it sends `set_pause_flags`, reads `Config` back and writes
// scripts/devnet/runs/pause-tickets-<set|clear>-<ISO timestamp>.json with the flags before and
// after, whether it passed or not; no key. Nothing is sent, and no record written, when the bit
// is already as asked.
//
//   pnpm devnet:pause-tickets set                 # dry run
//   pnpm devnet:pause-tickets set --confirm
//   pnpm devnet:pause-tickets clear --confirm
import {
  getSetPauseFlagsInstructionAsync,
  getConfigDecoder,
} from "../../clients/js/src/generated/fade/index.ts";
import {
  PROGRAM,
  RPC_URL,
  accountData,
  fadePdas,
  fadeErrorName,
  loadDeployer,
  send,
  simulate,
  writeJson,
  type Sent,
} from "./lib.ts";
import { carriesAuditFixes, programData } from "./migration.ts";
import {
  newKeeperHealthRefusals,
  newKeeperRequired,
  pauseFlagNames,
  pauseSignerRefusals,
  ticketPauseFlags,
  type PauseAction,
} from "./pause-flags.ts";

const DEVNET_HOSTS = ["api.devnet.solana.com"];
const LOCAL_HOSTS = ["127.0.0.1", "localhost"];
const KEEPER_URL = (process.env["KEEPER_URL"] ?? "https://api.fade.finance").replace(/\/+$/, "");
const NO_KEEPER_CHECK = "--no-keeper-check";

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");

function check(cond: boolean, what: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${what}`);
}

/** Refusals that need no RPC: the action, an unknown argument, another cluster. */
function guards(): { action: PauseAction; local: boolean; keeperCheck: boolean } {
  const action = args[0];
  if (action !== "set" && action !== "clear")
    throw new Error(
      `pause-tickets: the first argument is set or clear, not ${action ?? "nothing"}`,
    );
  const unknown = args.slice(1).filter((a) => a !== "--confirm" && a !== NO_KEEPER_CHECK);
  if (unknown.length) throw new Error(`pause-tickets: unknown argument ${unknown.join(" ")}`);
  const host = new URL(RPC_URL).hostname;
  const local = LOCAL_HOSTS.includes(host);
  if (!local && !DEVNET_HOSTS.includes(host))
    throw new Error(
      `pause-tickets runs against devnet (https://api.devnet.solana.com) or a local validator only, not ${RPC_URL}`,
    );
  const skip = args.includes(NO_KEEPER_CHECK);
  if (skip && (!local || action !== "clear"))
    throw new Error(
      `pause-tickets: ${NO_KEEPER_CHECK} is for clear on a local validator only: on devnet the unpause waits for the new keeper`,
    );
  return { action, local, keeperCheck: action === "clear" && !skip };
}

/** The keeper's `GET /v1/health`, judged by `newKeeperHealthRefusals`. */
async function keeperHealth() {
  const res = await fetch(`${KEEPER_URL}/v1/health`);
  check(res.ok, `GET ${KEEPER_URL}/v1/health answers (status ${res.status})`);
  const health = (await res.json()) as Record<string, unknown>;
  const refusals = newKeeperHealthRefusals(health);
  check(
    refusals.length === 0,
    `the new keeper serves ${KEEPER_URL}, has read the chain and recommends no pause: ${refusals.join("; ")}`,
  );
  return {
    url: KEEPER_URL,
    lastTick: health["lastTick"],
    counted: (health["directWithheld"] as Record<string, unknown>)["counted"],
    pauseRecommended: health["pauseRecommended"],
    directPauseRecommended: health["directPauseRecommended"],
    beaconPauseRecommended: health["beaconPauseRecommended"],
  };
}

async function main() {
  const { action, local, keeperCheck } = guards();
  console.log(`cluster: ${local ? `local validator ${RPC_URL}` : "devnet"}`);
  const p = await fadePdas();
  const data = await accountData(p.config);
  if (!data) throw new Error("the Config is unreadable");
  const config = getConfigDecoder().decode(data);
  check(config.version === 2, `Config is version 2, not ${config.version}`);
  const deployer = await loadDeployer();
  const refusals = pauseSignerRefusals(action, deployer.address, config);
  check(refusals.length === 0, refusals.join("; "));

  const before = config.pauseFlags;
  const after = ticketPauseFlags(before, action);
  const named = (f: number) => `${f} (${pauseFlagNames(f).join(", ") || "none"})`;
  console.log(`pause flags: ${named(before)}`);
  if (after === before) {
    console.log(`PAUSE_TICKETS is already ${action === "set" ? "set" : "clear"}: nothing to send.`);
    return;
  }
  console.log(`${action} PAUSE_TICKETS: ${named(before)} → ${named(after)}`);

  // The live binary decides which keeper the unpause waits for.
  const liveCarriesAuditFixes = keeperCheck ? carriesAuditFixes((await programData()).elf) : null;
  if (keeperCheck && !liveCarriesAuditFixes)
    console.log(
      "the live binary predates the audit fixes (the cutover called off, or rolled back): the old keeper is the one to serve it, its GET /v1/health is not checked",
    );
  const keeper = newKeeperRequired(keeperCheck, liveCarriesAuditFixes === true)
    ? await keeperHealth()
    : null;
  if (keeper) {
    console.log(
      `keeper ${keeper.url}: new keeper live, last tick ${keeper.lastTick}, ticket_forfeits_withheld ${keeper.counted}, pauseRecommended ${String(keeper.pauseRecommended)} (direct ${String(keeper.directPauseRecommended)}, beacon ${String(keeper.beaconPauseRecommended)})`,
    );
  }

  const ix = await getSetPauseFlagsInstructionAsync(
    {
      authority: deployer,
      pauseFlags: after,
      integratorPaused: null,
      eventAuthority: p.eventAuthority,
      program: PROGRAM,
    },
    { programAddress: PROGRAM },
  );
  if (!CONFIRM) {
    const sim = await simulate(deployer, [ix]);
    console.log(
      `set_pause_flags(${after}) simulated: ${sim.err === null ? "ok" : `refused, ${fadeErrorName(sim.code)} (${sim.code ?? JSON.stringify(sim.err)})`}`,
    );
    console.log("\ndry run: nothing sent. Run again with --confirm to send it.");
    return;
  }

  const startedAt = new Date();
  let ok = true;
  let sent: Sent | null = null;
  let readBack: number | null = null;
  let error: string | undefined;
  try {
    sent = await send(deployer, [ix], `set_pause_flags ${after}`);
    const now = await accountData(p.config);
    if (!now) throw new Error("the Config is unreadable after the change");
    readBack = getConfigDecoder().decode(now).pauseFlags;
    check(readBack === after, `Config reads pause flags ${after} back, not ${readBack}`);
  } catch (e) {
    ok = false;
    error = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${error}`);
  }
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const path = `scripts/devnet/runs/pause-tickets-${action}-${local ? "local-" : ""}${stamp}.json`;
  writeJson(path, {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    cluster: local ? `local validator ${RPC_URL}` : "devnet",
    program: PROGRAM,
    config: p.config,
    action,
    signer: deployer.address,
    flagsBefore: { value: before, names: pauseFlagNames(before) },
    flagsAfter: { value: after, names: pauseFlagNames(after) },
    readBack,
    ...(liveCarriesAuditFixes !== null ? { liveCarriesAuditFixes } : {}),
    ...(keeper ? { keeper } : {}),
    ...(sent ? { signature: sent.signature, slot: sent.slot.toString() } : {}),
    result: ok ? "ok" : "failed",
    ...(error ? { error } : {}),
  });
  console.log(`\npause-tickets ${action} ${ok ? "ok" : "FAILED"}, run written to ${path}`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
