// Changes the devnet vault's risk parameters through governance: `propose` sends
// set_params with the current parameters and the overrides below (applied at
// once by the devnet build, feature "no-timelock"; queued behind the delay
// otherwise); `apply` lands a due change (permissionless);
// `show` prints the live and pending parameters.
//
//   pnpm devnet:params show
//   MIN_PRICE_USDC=0.10 pnpm devnet:params propose  (council = keys/deployer.json)
//   pnpm devnet:params apply
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

function overrides(p: RiskParams): RiskParams {
  const next = { ...p };
  const minPrice = process.env["MIN_PRICE_USDC"];
  if (minPrice) next.minPrice = parseUsdc(minPrice);
  return next;
}

function describe(label: string, p: RiskParams) {
  console.log(
    `${label}: min price ${fmtUsdc(p.minPrice)}, max price ${fmtUsdc(p.maxPrice)}, ` +
      `epoch ${p.epochLengthSeconds} s, T_SETTLE ${p.tSettleSlots} slots`,
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
    const council = await loadDeployer();
    const params = overrides(c.params);
    const json = (p: RiskParams) =>
      JSON.stringify(p, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    if (json(params) === json(c.params)) throw new Error("nothing to change: set MIN_PRICE_USDC");
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
