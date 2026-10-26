// The one-off sweep of every live devnet round's `round_vrf` (Spec 08
// §13.5.8a), run once the program carries `sweep_round_vrf`: ORAO refunds a
// request it fulfils after `expire_round` forfeited its round to that
// round's `round_vrf`. The keeper watches the rounds it saw forfeited after
// their request (and, once, those its storage recorded so), but a round that
// closed before then and that its storage no longer holds is watched by
// nothing. This reads every round the vault created, `1 ≤ id <
// next_round_id`, and its `round_vrf`.
//
// Without `--confirm` it is a dry run: it lists each `round_vrf` holding
// lamports, the round open (they go into it, and its close pays its rent
// payer) or closed (they go to the caller, the deployer), and sends nothing.
// A `Requested` round is skipped: what its `round_vrf` holds is its draw's
// refund. With `--confirm` it sends `sweep_round_vrf` for each, one a
// transaction, then reads each `round_vrf` back, and writes
// scripts/devnet/runs/sweep-round-vrfs-<ISO timestamp>.json; no key.
//
//   pnpm devnet:sweep-round-vrfs              # dry run
//   pnpm devnet:sweep-round-vrfs --confirm
import { getBase64Encoder, type Address } from "@solana/kit";
import {
  RoundStatus,
  findRoundPda,
  findRoundVrfPda,
  getRoundDecoder,
  getVaultDecoder,
} from "../../clients/js/src/generated/fade/index.ts";
import {
  getBeaconSweepVrfInstructionAsync,
  roundVrfSweepable,
} from "../../clients/js/src/beacon/index.ts";
import {
  PROGRAM,
  RPC_URL,
  accountData,
  fadePdas,
  fmtSol,
  loadDeployer,
  rpc,
  send,
  solBalance,
  writeJson,
} from "./lib.ts";

const DEVNET_HOSTS = ["api.devnet.solana.com"];
const LOCAL_HOSTS = ["127.0.0.1", "localhost"];
/** Accounts a `getMultipleAccounts` call reads at most. */
const PER_READ = 100;

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");

type Found = {
  id: bigint;
  roundVrf: Address;
  lamports: bigint;
  /** The round's status while the program owns it, null once it has closed. */
  status: RoundStatus | null;
};

/** Every round id below `next_round_id`: its round read, and its `round_vrf`'s lamports. */
async function scan(nextRoundId: bigint): Promise<Found[]> {
  const found: Found[] = [];
  for (let start = 1n; start < nextRoundId; start += BigInt(PER_READ / 2)) {
    const ids: bigint[] = [];
    for (let id = start; id < nextRoundId && ids.length < PER_READ / 2; id++) ids.push(id);
    const rounds = await Promise.all(
      ids.map(async (id) => (await findRoundPda({ roundId: id }, { programAddress: PROGRAM }))[0]),
    );
    const vrfs = await Promise.all(
      rounds.map(
        async (round) => (await findRoundVrfPda({ round }, { programAddress: PROGRAM }))[0],
      ),
    );
    const { value } = await rpc
      .getMultipleAccounts([...rounds, ...vrfs], { encoding: "base64", commitment: "confirmed" })
      .send();
    ids.forEach((id, k) => {
      const round = value[k];
      const vrf = value[ids.length + k];
      const status =
        round && round.owner === PROGRAM
          ? getRoundDecoder().decode(new Uint8Array(getBase64Encoder().encode(round.data[0])))
              .status
          : null;
      found.push({ id, roundVrf: vrfs[k]!, lamports: vrf?.lamports ?? 0n, status });
    });
  }
  return found;
}

const describeFound = (f: Found) =>
  `round ${f.id} (${f.status === null ? "closed: to the caller" : `${RoundStatus[f.status]}: into the round`}), ` +
  `round_vrf ${f.roundVrf}: ${fmtSol(f.lamports)}`;

async function main() {
  const unknown = args.filter((a) => a !== "--confirm");
  if (unknown.length) throw new Error(`sweep-round-vrfs: unknown argument ${unknown.join(" ")}`);
  const host = new URL(RPC_URL).hostname;
  if (!LOCAL_HOSTS.includes(host) && !DEVNET_HOSTS.includes(host))
    throw new Error(
      `sweep-round-vrfs runs against devnet (https://api.devnet.solana.com) or a local validator only, not ${RPC_URL}`,
    );

  const vault = await accountData((await fadePdas()).vault);
  if (!vault) throw new Error("the Vault is unreadable");
  const { nextRoundId } = getVaultDecoder().decode(vault);
  const all = await scan(nextRoundId);
  const held = all.filter((f) => f.lamports > 0n);
  const sweeps = held.filter((f) =>
    roundVrfSweepable(f.status === null ? null : { status: f.status }, f.lamports),
  );
  const requested = held.filter((f) => !sweeps.includes(f));
  console.log(`${all.length} round(s) read, 1 to ${nextRoundId - 1n}`);
  for (const f of sweeps) console.log(`  to sweep: ${describeFound(f)}`);
  for (const f of requested) console.log(`  skipped, its draw's refund: ${describeFound(f)}`);
  if (!sweeps.length) {
    console.log("nothing to sweep.");
    return;
  }
  if (!CONFIRM) {
    console.log("\ndry run: nothing sent. Run again with --confirm to sweep them.");
    return;
  }

  const deployer = await loadDeployer();
  const startedAt = new Date();
  const results: Record<string, unknown>[] = [];
  let ok = true;
  for (const f of sweeps) {
    try {
      const ix = await getBeaconSweepVrfInstructionAsync(deployer, f.id, null, {
        programAddress: PROGRAM,
      });
      const sent = await send(deployer, [ix], `sweep_round_vrf ${f.id}`, 40_000);
      const left = await solBalance(f.roundVrf);
      if (left !== 0n) ok = false;
      results.push({
        round: f.id.toString(),
        roundVrf: f.roundVrf,
        lamports: f.lamports,
        to: f.status === null ? "caller" : "round",
        signature: sent.signature,
        slot: sent.slot.toString(),
        left,
      });
    } catch (e) {
      ok = false;
      const error = e instanceof Error ? e.message : String(e);
      console.error(`  ✗ round ${f.id}: ${error}`);
      results.push({ round: f.id.toString(), roundVrf: f.roundVrf, lamports: f.lamports, error });
    }
  }
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const local = LOCAL_HOSTS.includes(host);
  const path = `scripts/devnet/runs/sweep-round-vrfs-${local ? "local-" : ""}${stamp}.json`;
  writeJson(path, {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    cluster: local ? `local validator ${RPC_URL}` : "devnet",
    program: PROGRAM,
    nextRoundId: nextRoundId.toString(),
    caller: deployer.address,
    result: ok ? "ok" : "failed",
    sweeps: results,
    skippedRequested: requested.map((f) => f.id.toString()),
  });
  console.log(`\nsweep-round-vrfs ${ok ? "ok" : "FAILED"}, run written to ${path}`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
