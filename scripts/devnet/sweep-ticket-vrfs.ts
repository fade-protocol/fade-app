// The one-off sweep of every closed direct ticket's `vrf_payer` on the live devnet deployment
// (audit fixes of 22 October 2026, F-4), run once the program carries `sweep_ticket_vrf`: ORAO
// refunds a request's pending rent to `vrf_payer` when it fulfils it, which for a ticket
// expired with its request pending comes after `expire_ticket` closed the ticket, and nothing
// moved those lamports before. This reads every ticket every integrator opened,
// `0 ≤ nonce < next_nonce`, and its `vrf_payer`.
//
// The keeper queues a sweep only for the expiries whose version-2 `TicketExpired` says the
// request was pending: not for those the old binary sent (version 1, the drain under
// PAUSE_TICKETS included), whose rent ORAO may refund after this run. So the run also lists
// every request ORAO still holds pending with a closed ticket's `vrf_payer` as its client
// (`oraoRefundsTo`, one `getProgramAccounts` of ORAO's pending requests): those refund it
// later, and the sweep is run again until none is listed.
//
// Without `--confirm` it is a dry run: it lists each closed ticket's `vrf_payer` holding
// lamports, and those still owed a refund, and sends nothing. A ticket still open is skipped:
// its own close drains its `vrf_payer` to its payer. With `--confirm` it sends
// `sweep_ticket_vrf` for each, one a transaction, the lamports to the caller (the deployer:
// nothing on-chain names the payer of a closed ticket), then reads each `vrf_payer` back, and
// writes scripts/devnet/runs/sweep-ticket-vrfs-<ISO timestamp>.json (result "pending" while a
// refund is still owed, written then even with nothing to sweep yet, and no record when nothing
// is held nor owed); no key.
//
//   pnpm devnet:sweep-ticket-vrfs              # dry run
//   pnpm devnet:sweep-ticket-vrfs --confirm
import {
  getBase58Decoder,
  getBase64Encoder,
  type Address,
  type Base58EncodedBytes,
} from "@solana/kit";
import {
  ORAO_RANDOMNESS_V2_DISCRIMINATOR,
  ORAO_VRF_PROGRAM_ADDRESS,
} from "../../clients/js/src/beacon/constants.ts";
import { oraoPendingV2Client } from "../../clients/js/src/beacon/entropy.ts";
import { oraoRefundsTo } from "../../clients/js/src/direct/index.ts";
import {
  INTEGRATOR_DISCRIMINATOR,
  findTicketPda,
  findVrfPayerPda,
  getIntegratorDecoder,
  getIntegratorSize,
  getSweepTicketVrfInstructionAsync,
} from "../../clients/js/src/generated/fade/index.ts";
import {
  PROGRAM,
  RPC_URL,
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
  integrator: Address;
  nonce: bigint;
  ticket: Address;
  vrfPayer: Address;
  lamports: bigint;
  /** The program still owns the ticket: its close drains `vrf_payer`, nothing to sweep. */
  open: boolean;
};

/** Every integrator record, with its next nonce. */
async function integrators(): Promise<{ address: Address; nextNonce: bigint }[]> {
  const accounts = await rpc
    .getProgramAccounts(PROGRAM, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: BigInt(getIntegratorSize()) },
        {
          memcmp: {
            offset: 0n,
            bytes: getBase58Decoder().decode(INTEGRATOR_DISCRIMINATOR) as Base58EncodedBytes,
            encoding: "base58",
          },
        },
      ],
    })
    .send();
  return accounts.map(({ pubkey, account }) => ({
    address: pubkey,
    nextNonce: getIntegratorDecoder().decode(
      new Uint8Array(getBase64Encoder().encode(account.data[0])),
    ).nextNonce,
  }));
}

/** Every ticket of `integrator` below `nextNonce`, and its `vrf_payer`'s lamports. */
async function scan(integrator: Address, nextNonce: bigint): Promise<Found[]> {
  const found: Found[] = [];
  const cfg = { programAddress: PROGRAM };
  for (let start = 0n; start < nextNonce; start += BigInt(PER_READ / 2)) {
    const nonces: bigint[] = [];
    for (let n = start; n < nextNonce && nonces.length < PER_READ / 2; n++) nonces.push(n);
    const tickets = await Promise.all(
      nonces.map(async (nonce) => (await findTicketPda({ integrator, nonce }, cfg))[0]),
    );
    const vrfs = await Promise.all(
      tickets.map(async (ticket) => (await findVrfPayerPda({ ticket }, cfg))[0]),
    );
    const { value } = await rpc
      .getMultipleAccounts([...tickets, ...vrfs], { encoding: "base64", commitment: "confirmed" })
      .send();
    nonces.forEach((nonce, k) => {
      const t = value[k];
      const vrf = value[nonces.length + k];
      found.push({
        integrator,
        nonce,
        ticket: tickets[k]!,
        vrfPayer: vrfs[k]!,
        lamports: vrf?.lamports ?? 0n,
        open: !!t && t.owner === PROGRAM,
      });
    });
  }
  return found;
}

/**
 * ORAO's pending requests whose rent it refunds, once it fulfils them, to the `vrf_payer` of a
 * closed ticket in `closed` (keyed by `vrf_payer`): what a later run sweeps.
 */
async function owedLater(
  closed: Map<Address, Found>,
): Promise<{ found: Found; request: Address }[]> {
  if (!closed.size) return [];
  const b58 = (b: Uint8Array) => getBase58Decoder().decode(b) as Base58EncodedBytes;
  const accounts = await rpc
    .getProgramAccounts(ORAO_VRF_PROGRAM_ADDRESS, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        {
          memcmp: { offset: 0n, bytes: b58(ORAO_RANDOMNESS_V2_DISCRIMINATOR), encoding: "base58" },
        },
        // the tag of a pending `RandomnessV2`
        { memcmp: { offset: 8n, bytes: b58(Uint8Array.of(0)), encoding: "base58" } },
      ],
    })
    .send();
  const owed: { found: Found; request: Address }[] = [];
  for (const { pubkey, account } of accounts) {
    const data = new Uint8Array(getBase64Encoder().encode(account.data[0]));
    const client = oraoPendingV2Client(data);
    const found = client ? closed.get(client) : undefined;
    if (found && oraoRefundsTo({ address: pubkey, owner: account.owner, data }, found.vrfPayer))
      owed.push({ found, request: pubkey });
  }
  return owed;
}

const describeFound = (f: Found) =>
  `ticket ${f.ticket} (integrator ${f.integrator}, nonce ${f.nonce}), vrf_payer ${f.vrfPayer}: ${fmtSol(f.lamports)}`;

async function main() {
  const unknown = args.filter((a) => a !== "--confirm");
  if (unknown.length) throw new Error(`sweep-ticket-vrfs: unknown argument ${unknown.join(" ")}`);
  const host = new URL(RPC_URL).hostname;
  if (!LOCAL_HOSTS.includes(host) && !DEVNET_HOSTS.includes(host))
    throw new Error(
      `sweep-ticket-vrfs runs against devnet (https://api.devnet.solana.com) or a local validator only, not ${RPC_URL}`,
    );

  const all: Found[] = [];
  for (const i of await integrators()) all.push(...(await scan(i.address, i.nextNonce)));
  const held = all.filter((f) => f.lamports > 0n);
  const sweeps = held.filter((f) => !f.open);
  const open = held.filter((f) => f.open);
  // read before the sweeps: a request ORAO fulfils meanwhile is swept now or by the next run
  const pending = await owedLater(new Map(all.filter((f) => !f.open).map((f) => [f.vrfPayer, f])));
  console.log(`${all.length} ticket address(es) read`);
  for (const f of sweeps) console.log(`  to sweep: ${describeFound(f)}`);
  for (const f of open) console.log(`  skipped, still open: ${describeFound(f)}`);
  for (const p of pending)
    console.log(
      `  still owed: ticket ${p.found.ticket}, request ${p.request} pending: ORAO refunds its rent to vrf_payer ${p.found.vrfPayer} when it fulfils it`,
    );
  const again = pending.length
    ? `\n${pending.length} request(s) still pending refund a closed ticket's vrf_payer later: run this again once ORAO has fulfilled them, until none is listed.`
    : "";
  if (!sweeps.length) console.log(`nothing to sweep.${again}`);
  if (!CONFIRM) {
    if (sweeps.length)
      console.log(`\ndry run: nothing sent. Run again with --confirm to sweep them.${again}`);
    return;
  }
  // Nothing held and nothing owed: no record. A refund still owed is recorded even with
  // nothing to sweep yet, the usual state right after the upgrade (ORAO answers later).
  if (!sweeps.length && !pending.length) return;

  const deployer = await loadDeployer();
  const p = await fadePdas();
  const startedAt = new Date();
  const results: Record<string, unknown>[] = [];
  let ok = true;
  for (const f of sweeps) {
    try {
      const ix = await getSweepTicketVrfInstructionAsync(
        {
          caller: deployer,
          integrator: f.integrator,
          nonce: f.nonce,
          eventAuthority: p.eventAuthority,
          program: PROGRAM,
        },
        { programAddress: PROGRAM },
      );
      const sent = await send(deployer, [ix], `sweep_ticket_vrf ${f.ticket}`, 60_000);
      const left = await solBalance(f.vrfPayer);
      if (left !== 0n) ok = false;
      results.push({
        ticket: f.ticket,
        integrator: f.integrator,
        nonce: f.nonce.toString(),
        vrfPayer: f.vrfPayer,
        lamports: f.lamports,
        signature: sent.signature,
        slot: sent.slot.toString(),
        left,
      });
    } catch (e) {
      ok = false;
      const error = e instanceof Error ? e.message : String(e);
      console.error(`  ✗ ticket ${f.ticket}: ${error}`);
      results.push({ ticket: f.ticket, vrfPayer: f.vrfPayer, lamports: f.lamports, error });
    }
  }
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const local = LOCAL_HOSTS.includes(host);
  const path = `scripts/devnet/runs/sweep-ticket-vrfs-${local ? "local-" : ""}${stamp}.json`;
  writeJson(path, {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    cluster: local ? `local validator ${RPC_URL}` : "devnet",
    program: PROGRAM,
    caller: deployer.address,
    result: ok ? (pending.length ? "pending" : "ok") : "failed",
    sweeps: results,
    skippedOpen: open.map((f) => f.ticket),
    stillOwed: pending.map((p) => ({ ticket: p.found.ticket, request: p.request })),
  });
  console.log(
    `\nsweep-ticket-vrfs ${ok ? (pending.length ? "pending" : "ok") : "FAILED"}, run written to ${path}${sweeps.length ? again : ""}`,
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
