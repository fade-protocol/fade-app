// Runs the app's small-ticket demo against the live devnet program (which
// carries both the direct path and the shared beacon), from node, through
// the app's own code: the flow behind the button
// (src/lib/beaconFlow.ts), its reads (src/lib/beaconRpc.ts) and its sends
// (src/lib/tx.ts, which simulates every transaction before it signs). No
// browser and no wallet extension: the deployer (keys/deployer.json, read by
// scripts/devnet/lib.ts, never printed) signs where the user's wallet would.
//
//   pnpm web:beacon-demo   (from the repository root; VITE_BEACON_ENABLED set
//                          by the script)
//
// It refuses to run while the program's rounds are paused (`PAUSE_ROUNDS`,
// set by `migrate_config` until the council clears it) or while the beacon's
// minimum price is above the demo's ticket. It joins one 0.10 USDC ticket,
// follows the close tick, waits for automatic delivery as the app does,
// takes over when the app would offer it (request, then payout) if no
// keeper has, and checks the result against the program's event and the
// USDC moved. The run log goes to scripts/devnet/runs/beacon-app-<ISO>.json.
import type { Instruction, Signature, TransactionSigner } from "@solana/kit";

// The app's modules read their configuration at import: set it first.
process.env["VITE_RPC_URL"] ??= "https://api.devnet.solana.com";

const lib = await import("../../../scripts/devnet/lib.ts");
const { PAUSE_ROUNDS } = await import("../../../scripts/devnet/migration.ts");
const { fetchConfig } = await import("../../../clients/js/src/generated/fade/index.ts");
const config = await import("../src/lib/config.ts");
const { BEACON_TICKET_PRICE } = await import("../src/lib/beacon.ts");
const { BeaconTicketFlow } = await import("../src/lib/beaconFlow.ts");
const { appFlowDeps, findSettled } = await import("../src/lib/beaconRpc.ts");
const { simulate } = await import("../src/lib/tx.ts");
const { ata, tokenBalance, solBalance } = await import("../src/lib/fade.ts");
type Flow = import("../src/lib/beaconFlow.ts").BeaconFlow;

if (config.BEACON_PROGRAM === null) throw new Error("set VITE_BEACON_ENABLED=true");
if (config.BEACON_PROGRAM !== lib.PROGRAM)
  throw new Error("the app and the scripts disagree on the program");
if (config.USDC_MINT !== lib.USDC_MINT)
  throw new Error("the app and the scripts disagree on the mint");
// Nothing is sent while the program cannot take the demo's ticket.
const programConfig = (await fetchConfig(lib.rpc, (await lib.fadePdas()).config)).data;
if ((programConfig.pauseFlags & PAUSE_ROUNDS) !== 0)
  throw new Error(
    `rounds are paused on ${lib.PROGRAM} (PAUSE_ROUNDS set): the council clears it before the beacon takes tickets`,
  );
if (programConfig.params.beaconMinPrice > BEACON_TICKET_PRICE)
  throw new Error(
    `the beacon's minimum price is ${lib.fmtUsdc(programConfig.params.beaconMinPrice)}, above the demo's ${lib.fmtUsdc(BEACON_TICKET_PRICE)} ticket`,
  );

const startedAt = new Date();
const signer = await lib.loadDeployer();
const usdcAccount = await ata(signer.address);
const usdcBefore = (await tokenBalance(usdcAccount)) ?? 0n;
const solBefore = await solBalance(signer.address);
if (usdcBefore < BEACON_TICKET_PRICE) throw new Error("the deployer holds no test USDC");
console.log(`small-ticket demo on ${config.BEACON_PROGRAM}, as ${signer.address}`);

type Sim = { label: string; ok: boolean; units: string | null; error: string | null };
type SentLog = { label: string; signature: Signature; link: string; at: string };
const simulations: Sim[] = [];
const sends: SentLog[] = [];
// The app's deps, with each simulation also recorded (tx.send simulates again before signing).
const deps = {
  ...appFlowDeps,
  async send(
    s: TransactionSigner,
    instructions: Instruction[],
    label: string,
    units: number,
    onSigned?: (sig: Signature) => void,
  ) {
    const sim = await simulate(s.address, instructions, units);
    simulations.push({
      label,
      ok: sim.ok,
      units: sim.ok && sim.units !== null ? sim.units.toString() : null,
      error: sim.ok ? null : `${sim.failure.name ?? ""} ${sim.failure.message}`.trim(),
    });
    const sent = await appFlowDeps.send(s, instructions, label, units, onSigned);
    sends.push({
      label,
      signature: sent.signature,
      link: config.explorerTx(sent.signature),
      at: new Date().toISOString(),
    });
    console.log(`  ✓ ${label}: ${config.explorerTx(sent.signature)}`);
    return sent;
  },
};

type Mark = {
  at: string;
  ms: number;
  phase: string;
  stage: string | null;
  slot: string | null;
  slotsLeft: string | null;
};
const marks: Mark[] = [];
const t0 = Date.now();
let lastKey = "";
const flow = new BeaconTicketFlow(
  deps,
  { program: config.BEACON_PROGRAM, usdcMint: config.USDC_MINT },
  (s: Flow) => {
    const slotsLeft = s.stage?.kind === "closing" ? s.stage.slotsLeft.toString() : null;
    const key = `${s.phase}:${s.stage?.kind ?? ""}:${slotsLeft ?? ""}:${s.stalled}`;
    if (key === lastKey) return;
    lastKey = key;
    marks.push({
      at: new Date().toISOString(),
      ms: Date.now() - t0,
      phase: s.phase,
      stage: s.stage?.kind ?? null,
      slot: s.slot?.toString() ?? null,
      slotsLeft,
    });
    if (s.stage?.kind === "closing")
      console.log(
        `    the draw closes at slot ${s.stage.closeSlot}, ${s.stage.slotsLeft} slots left`,
      );
    else if (s.stage)
      console.log(`    ${s.phase}: ${s.stage.kind}${s.stalled ? " (offered to the wallet)" : ""}`);
  },
);

const joined = await flow.start(signer, usdcAccount);
if (!joined) throw new Error(`the join failed: ${flow.state.failure?.message}`);
let tookOver: string | null = null;
const deadline = Date.now() + 240_000;
for (;;) {
  const s = flow.state;
  if (s.phase === "done" || s.phase === "failed") break;
  // As the user would: "Finish with my wallet" once the app offers it.
  if (s.stalled && s.driver === "keeper" && !tookOver) {
    tookOver = `${s.stage?.kind} at slot ${s.slot}`;
    flow.takeOver();
  }
  if (Date.now() > deadline) throw new Error(`still ${s.phase} after 240 s`);
  await lib.sleep(250);
}
// As the user would: "Take it back" when the app offers the draw's unused SOL (the keeper
// usually reclaims it first, and then the round is gone and nothing is offered).
const reclaimOffered = flow.state.phase === "done" && flow.state.sponsorshipLeft;
if (reclaimOffered) await flow.reclaim();
const end = flow.state;
const usdcAfter = (await tokenBalance(usdcAccount)) ?? 0n;
const event = end.ticket ? await findSettled(config.BEACON_PROGRAM, end.ticket) : null;

const problems: string[] = [];
if (end.phase !== "done") problems.push(`ended ${end.phase}: ${end.failure?.message}`);
if (simulations.some((x) => !x.ok)) problems.push("a transaction was refused in simulation");
// Every send was simulated first; a step refused after its simulation (a take-back
// the keeper sent first) leaves a simulation without a send, which is fine.
if (sends.some((x) => !simulations.some((y) => y.label === x.label)))
  problems.push("a send without its simulation");
if (!marks.some((m) => m.stage === "closing")) problems.push("the close tick was never shown");
if (end.end?.kind === "paid") {
  if (!event) problems.push("no RoundTicketSettled event found");
  else {
    if (event.outcome !== end.end.outcome.index || event.payout !== end.end.outcome.payout)
      problems.push("the result shown is not the program's");
    if (usdcAfter - usdcBefore !== event.payout - BEACON_TICKET_PRICE)
      problems.push(
        `USDC moved ${usdcAfter - usdcBefore}, expected ${event.payout - BEACON_TICKET_PRICE}`,
      );
  }
} else problems.push(`no payout: ${JSON.stringify(end.end)}`);
if (end.sponsorshipLeft)
  problems.push(
    reclaimOffered
      ? "the sponsorship could not be taken back"
      : "the sponsorship was left on the round",
  );

const log = {
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  program: config.BEACON_PROGRAM,
  rpc: process.env["VITE_RPC_URL"],
  wallet: signer.address,
  round: end.round,
  ticket: end.ticket,
  sponsorship: end.sponsorship,
  fronted: end.fronted,
  end: end.end,
  event,
  tookOver,
  reclaimed: reclaimOffered && !end.sponsorshipLeft,
  usdc: { before: usdcBefore, after: usdcAfter },
  sol: { before: solBefore, after: await solBalance(signer.address) },
  simulations,
  sends,
  marks,
  problems,
};
const name = `beacon-app-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
const path = new URL(`../../../scripts/devnet/runs/${name}`, import.meta.url).pathname;
lib.writeJson(path, log);
console.log(`run log: scripts/devnet/runs/${name}`);
if (problems.length) {
  console.error(`FAILED:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `ok: ${end.end?.kind === "paid" && end.end.outcome.payout > 0n ? `+${end.end.outcome.payout}` : "not this time"}, ${sends.length} transactions, each simulated first`,
);
