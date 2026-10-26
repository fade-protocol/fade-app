// The one-off sweep of the closed direct tickets' vrf_payer (scripts/devnet/sweep-ticket-vrfs.ts):
// its refusals that need no RPC are run in a child process; what it sends is read as text:
// nothing before the dry run returns, an open ticket never.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

function run(args: string[], env: Record<string, string | undefined>) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/devnet/sweep-ticket-vrfs.ts", ...args],
    { env: { ...process.env, RPC_URL: undefined, ...env }, encoding: "utf8" },
  );
  return { status: r.status, err: r.stderr };
}

describe("sweep-ticket-vrfs", () => {
  const src = read("scripts/devnet/sweep-ticket-vrfs.ts");

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

  it("reads every nonce of every integrator, and never sweeps an open ticket", () => {
    expect(src).toContain("for (let start = 0n; start < nextNonce;");
    expect(src).toContain("const sweeps = held.filter((f) => !f.open);");
    expect(src).toContain("open: !!t && t.owner === PROGRAM");
  });

  it("lists the requests that refund a closed ticket's vrf_payer later, so it is run again", () => {
    // the old binary's expiries (version 1) never reach the keeper's sweep queue
    expect(src).toContain(
      "oraoRefundsTo({ address: pubkey, owner: account.owner, data }, found.vrfPayer)",
    );
    expect(src).toContain("all.filter((f) => !f.open).map((f) => [f.vrfPayer, f])");
    // read before the early return of an empty sweep, and stated in every ending
    const at = (s: string) => src.indexOf(s);
    expect(at("const pending = await owedLater(")).toBeLessThan(
      at("if (!sweeps.length) console.log(`nothing to sweep.${again}`);"),
    );
    expect(src.match(/\$\{again\}/g)).toHaveLength(2);
    // the confirmed run's last line, unless "nothing to sweep" already said it
    expect(src).toContain('${sweeps.length ? again : ""}');
    expect(src).toContain('result: ok ? (pending.length ? "pending" : "ok") : "failed"');
  });

  it("writes a pending record under --confirm when refunds are owed but nothing is sweepable yet", () => {
    const at = (s: string) => src.indexOf(s);
    const skip = "if (!sweeps.length && !pending.length) return;";
    // the only early return of a confirmed run: nothing held and nothing owed
    expect(at(skip)).toBeGreaterThan(at("if (!CONFIRM) {"));
    expect(at(skip)).toBeLessThan(at("writeJson("));
    const confirmed = src.slice(at(skip) + skip.length, at("writeJson("));
    expect(confirmed).not.toContain("return");
    // an empty sweep list is no early return any more
    expect(src).not.toMatch(
      /if \(!sweeps\.length\) \{\s*console\.log\(`nothing to sweep\.\$\{again\}`\);\s*return;/,
    );
    expect(src).toContain("stillOwed: pending.map(");
  });

  it("is run through the toolchain", () => {
    expect(read("package.json")).toContain(
      '"devnet:sweep-ticket-vrfs": "bash scripts/toolchain/with-toolchain.sh pnpm exec tsx scripts/devnet/sweep-ticket-vrfs.ts"',
    );
  });
});
