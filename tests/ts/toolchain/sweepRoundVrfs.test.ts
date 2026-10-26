// The one-off sweep of the live rounds' round_vrf (scripts/devnet/sweep-round-vrfs.ts):
// its refusals that need no RPC are run in a child process; what it sends is
// read as text: nothing before the dry run returns, a `Requested` round never.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

function run(args: string[], env: Record<string, string | undefined>) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/devnet/sweep-round-vrfs.ts", ...args],
    { env: { ...process.env, RPC_URL: undefined, ...env }, encoding: "utf8" },
  );
  return { status: r.status, err: r.stderr };
}

describe("sweep-round-vrfs", () => {
  const src = read("scripts/devnet/sweep-round-vrfs.ts");

  it("runs against devnet or a local validator only", () => {
    const r = run(["--confirm"], { RPC_URL: "https://api.mainnet-beta.solana.com" });
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("runs against devnet (https://api.devnet.solana.com) or a local");
  });

  it("refuses an unknown argument rather than read it as a dry run", () => {
    const r = run(["--confrim"], {});
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("unknown argument --confrim");
  });

  it("sends only with --confirm, after the dry run's listing", () => {
    expect(src.match(/await send\(/g)).toHaveLength(1);
    const at = (s: string) => src.indexOf(s);
    expect(at("if (!CONFIRM) {")).toBeGreaterThan(0);
    expect(at("if (!CONFIRM) {")).toBeLessThan(at("await send("));
    expect(src.slice(at("if (!CONFIRM) {"), at("await send("))).toContain("return;");
  });

  it("reads every round the vault created, and never sweeps a Requested one", () => {
    expect(src).toContain("for (let start = 1n; start < nextRoundId;");
    expect(src).toContain(
      "roundVrfSweepable(f.status === null ? null : { status: f.status }, f.lamports)",
    );
    // A closed round is read as null: what its round_vrf holds goes to the caller.
    expect(src).toContain("round && round.owner === PROGRAM");
    expect(src).toContain("getBeaconSweepVrfInstructionAsync(deployer, f.id, null");
  });

  it("is run through the toolchain", () => {
    expect(read("package.json")).toContain(
      '"devnet:sweep-round-vrfs": "bash scripts/toolchain/with-toolchain.sh pnpm exec tsx scripts/devnet/sweep-round-vrfs.ts"',
    );
  });
});
