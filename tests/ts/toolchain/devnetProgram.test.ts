// The devnet program: one deployment, at one address, carrying both the
// direct path and the shared beacon. The address is written in three places
// (the program's declare_id!, the devnet scripts' lib and the migration
// rehearsal); a drift would build a binary at one address and drive it at
// another. Each place is read as text and compared; the scripts' program is
// resolved in a child process, nothing is sent. The beacon's retired devnet
// instance is named nowhere outside the run records.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const LIVE = "GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt";
/** The beacon's retired devnet instance, closed by the operator. */
const RETIRED = "xDRo1kCxPp1rgojtFSM65spLVtGRGVt3QiyVyKkeL2x";
const read = (p: string) => readFileSync(p, "utf8");

/** PROGRAM as scripts/devnet/lib.ts resolves it under `env`. */
function programFor(env: Record<string, string | undefined>) {
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      'import("./scripts/devnet/lib.ts").then((m) => { console.log(m.PROGRAM); process.exit(0); })',
    ],
    { env: { ...process.env, ...env }, encoding: "utf8" },
  );
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

describe("the devnet program", () => {
  it("the devnet build declares the live address, the mainnet build its own", () => {
    const lib = read("programs/fade/src/lib.rs");
    expect(lib).toContain(`#[cfg(feature = "devnet")]\ndeclare_id!("${LIVE}");`);
    expect(lib).toContain(
      '#[cfg(not(feature = "devnet"))]\ndeclare_id!("HeuXg1Fn2R7TzzATextZjwySFq1m4YBgUdvXqbQuojsL");',
    );
    expect(lib.match(/declare_id!/g)).toHaveLength(2);
    expect(read("programs/fade/Cargo.toml")).not.toContain("devnet-beacon");
    const build = read("scripts/build-sbf-devnet.sh");
    expect(build).toContain('features="devnet,no-timelock"');
    expect(build).toContain('out="$FADE_ROOT/target/devnet"');
  });

  it("the scripts act on the live program, whatever the environment", () => {
    expect(programFor({}).out).toBe(LIVE);
    expect(programFor({ FADE_INSTANCE: "beacon" }).out).toBe(LIVE);
    expect(read("scripts/devnet/lib.ts")).not.toContain("FADE_INSTANCE");
  });

  it("the retired beacon instance is named nowhere but the run records", () => {
    const r = spawnSync(
      "git",
      [
        "grep",
        "-l",
        RETIRED,
        "--",
        ".",
        ":!scripts/devnet/runs",
        ":!docs",
        ":!tests/ts/toolchain/devnetProgram.test.ts",
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1); // git grep: nothing found
    expect(r.stdout.trim()).toBe("");
    // The same search finds the live address: the empty answer above is not a failed search.
    const live = spawnSync("git", ["grep", "-l", LIVE, "--", "scripts/devnet/lib.ts"], {
      encoding: "utf8",
    });
    expect(live.stdout.trim()).toBe("scripts/devnet/lib.ts");
    const pkg = read("package.json");
    expect(pkg).not.toContain("deploy-beacon");
    expect(pkg).not.toContain("beacon-e2e");
    expect(pkg).not.toContain("FADE_INSTANCE");
  });

  it("the migration rehearsal runs against a local validator only, on the live build", () => {
    for (const RPC_URL of [undefined, "https://api.devnet.solana.com", "https://example.com"]) {
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/devnet/migrate-rehearsal.ts"],
        { env: { ...process.env, RPC_URL }, encoding: "utf8" },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("runs against a local validator only");
    }
    const sh = read("scripts/devnet/migrate-rehearsal.sh");
    expect(sh).toContain(`live="${LIVE}"`);
    expect(sh).not.toContain(RETIRED);
    expect(sh).toContain('local_url="http://127.0.0.1:${port}"');
    expect(sh).toContain('RPC_URL="$local_url"');
    expect(sh).not.toMatch(/program (deploy|upgrade|extend|set-upgrade-authority|close)/);
  });
});
