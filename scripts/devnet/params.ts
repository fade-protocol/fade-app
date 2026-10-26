// Changes the devnet vault's risk parameters through governance: `propose` sends
// set_params with the current parameters and the overrides below (applied at
// once by the devnet build, feature "no-timelock"; queued behind the delay
// otherwise); `apply` lands a due change (permissionless);
// `show` prints the live and pending parameters.
//
//   pnpm devnet:params show
//   MIN_PRICE_USDC=0.10 pnpm devnet:params propose  (council = keys/deployer.json)
//
// `propose` names the live treasury, so that it stays where it is (a change applied at once
// writes the parameters and the treasury together), and refuses while a change is pending,
// which it would replace, unless REPLACE_PENDING=1.
//   pnpm devnet:params apply
//
// The beacon's terms, on the same program: e.g. Spec 09 §8's terms for a
// 0.10 USD minimum ticket, as the app's small-ticket demo needs them,
//
//   BEACON_MIN_PRICE_USDC=0.10 BEACON_THRESHOLD_USDC=9.79 \
//     ROUND_SETTLE_LAMPORTS=5000 pnpm devnet:params propose
import {
  fetchConfig,
  getApplyParamsInstructionAsync,
  getSetParamsInstructionAsync,
  type RiskParams,
} from "../../clients/js/src/generated/fade/index.ts";
import { PROGRAM, USDC, explorerTx, fadePdas, fmtUsdc, loadDeployer, rpc, send } from "./lib.ts";

const cfg = { programAddress: PROGRAM };

/** "0.10" → 100_000 base units, exactly (no float). */
function parseUsdc(v: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v.trim());
  if (!m) throw new Error(`not a USDC amount: ${v}`);
  return BigInt(m[1] ?? "0") * USDC + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** The beacon's overrides. */
const BEACON_VARS = ["BEACON_MIN_PRICE_USDC", "BEACON_THRESHOLD_USDC", "ROUND_SETTLE_LAMPORTS"];

function overrides(p: RiskParams): RiskParams {
  const next = { ...p };
  const minPrice = process.env["MIN_PRICE_USDC"];
  if (minPrice) next.minPrice = parseUsdc(minPrice);
  const beaconMin = process.env["BEACON_MIN_PRICE_USDC"];
  if (beaconMin) next.beaconMinPrice = parseUsdc(beaconMin);
  const threshold = process.env["BEACON_THRESHOLD_USDC"];
  if (threshold) next.beaconThreshold = parseUsdc(threshold);
  const settle = process.env["ROUND_SETTLE_LAMPORTS"];
  if (settle) {
    if (!/^\d+$/.test(settle)) throw new Error(`not a lamport amount: ${settle}`);
    next.crankRoundSettleLamports = BigInt(settle);
  }
  return next;
}

function describe(label: string, p: RiskParams) {
  console.log(
    `${label}: min price ${fmtUsdc(p.minPrice)}, max price ${fmtUsdc(p.maxPrice)}, ` +
      `epoch ${p.epochLengthSeconds} s, T_SETTLE ${p.tSettleSlots} slots`,
  );
  console.log(
    `${label}, beacon: min price ${fmtUsdc(p.beaconMinPrice)}, threshold ` +
      `${fmtUsdc(p.beaconThreshold)}, settlement share ${p.crankRoundSettleLamports} lamports, ` +
      `tick ${p.tickSlots} slots`,
  );
}

async function main() {
  const mode = process.argv[2] ?? "show";
  const pdas = await fadePdas();
  const config = await fetchConfig(rpc, pdas.config);
  const c = config.data;
  describe("live", c.params);
  if (c.pending.active) {
    const at = new Date(Number(c.pending.effectiveAt) * 1000).toISOString();
    describe(`pending, due ${at}`, c.pending.params);
  }
  const common = { eventAuthority: pdas.eventAuthority, program: PROGRAM };

  if (mode === "propose") {
    // The devnet build applies a change at once, the treasury it names with the parameters,
    // and a pending change is replaced by it: land that one first if it is still wanted.
    if (c.pending.active && process.env["REPLACE_PENDING"] !== "1")
      throw new Error(
        "a change is pending: run `pnpm devnet:params apply` first, or set REPLACE_PENDING=1 to replace it",
      );
    const council = await loadDeployer();
    const params = overrides(c.params);
    const json = (p: RiskParams) =>
      JSON.stringify(p, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    if (json(params) === json(c.params))
      throw new Error(`nothing to change: set MIN_PRICE_USDC or ${BEACON_VARS.join(", ")}`);
    // The live treasury: a change applied at once writes the treasury it names.
    const ix = await getSetParamsInstructionAsync(
      { council, protocolTreasury: c.protocolTreasury, params, ...common },
      cfg,
    );
    const sent = await send(council, [ix], "set_params");
    console.log(`proposed: ${explorerTx(sent.signature)}`);
    const after = await fetchConfig(rpc, pdas.config);
    if (after.data.pending.active) {
      const at = new Date(Number(after.data.pending.effectiveAt) * 1000).toISOString();
      describe(`pending, due ${at}`, after.data.pending.params);
    } else describe("applied at once", after.data.params);
  } else if (mode === "apply") {
    if (!c.pending.active) throw new Error("no pending change");
    const payer = await loadDeployer();
    const ix = await getApplyParamsInstructionAsync({ ...common }, cfg);
    const sent = await send(payer, [ix], "apply_params");
    console.log(`applied: ${explorerTx(sent.signature)}`);
    describe("live", (await fetchConfig(rpc, pdas.config)).data.params);
  } else if (mode !== "show") {
    throw new Error(`unknown mode ${mode}: show | propose | apply`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
