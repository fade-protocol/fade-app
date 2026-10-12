// End-to-end check of the deployed keeper on devnet:
//
//   1. the keeper's balance, from GET /v1/health
//   2. a ticket opened by the deployer and POSTed: the keeper requests, waits
//      for ORAO and settles; GET /v1/tickets/:address is polled every second
//   3. a ticket opened and NOT posted: the sweep must find it and settle it
//   4. no Fade ticket left open, and the keeper's balance after
//
//   pnpm --filter @fade/keeper e2e     (KEEPER_URL overrides https://api.fade.finance)
import { type Address } from "@solana/kit";
import {
  TicketStatus,
  fetchConfig,
  fetchMaybeIntegrator,
  fetchMaybeTicket,
  fetchTicket,
  getOpenTicketInstructionAsync,
  getTicketDecoder,
  type OutcomeArgs,
} from "../../../clients/js/src/generated/fade/index.ts";
import {
  PROGRAM,
  USDC_MINT,
  ata,
  explorerTx,
  fadePdas,
  integratorPda,
  loadDeployer,
  rpc,
  send,
  sleep,
  ticketPda,
} from "../../../scripts/devnet/lib.ts";

const KEEPER_URL = (process.env["KEEPER_URL"] ?? "https://api.fade.finance").replace(/\/+$/, "");
const cfg = { programAddress: PROGRAM };
const PRICE = 7_500_000n; // the minimum price
/** Coin flip paying 1.956x: a 220 bps margin. */
const COIN_FLIP: OutcomeArgs[] = [
  { p: 500_000_000n, m: 19_560n },
  { p: 500_000_000n, m: 0n },
];

type View = {
  state: string;
  openSlot?: number;
  requestSignature?: string;
  settleSignature?: string;
  expireSignature?: string;
  outcome?: number;
  payout?: string;
  updatedAt: string;
};

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(`${KEEPER_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json" },
  });
  return { status: r.status, body: (await r.json()) as T };
}

const health = () =>
  api<{ keeper: string; lamports: string; lastTick: number; queue: number }>("/v1/health");

async function openTicket(label: string): Promise<{ ticket: Address; confirmedAt: number }> {
  const deployer = await loadDeployer();
  const pdas = await fadePdas();
  const config = (await fetchConfig(rpc, pdas.config)).data;
  const integrator = await integratorPda(deployer.address);
  const i = await fetchMaybeIntegrator(rpc, integrator);
  const nonce = i.exists ? i.data.nextNonce : 0n;
  const usdc = await ata(deployer.address, USDC_MINT);
  await send(
    deployer,
    [
      await getOpenTicketInstructionAsync(
        {
          integratorAuthority: deployer,
          payer: deployer,
          funder: deployer,
          funderUsdc: usdc,
          shareAccount: usdc,
          protocolTreasury: config.protocolTreasury,
          beneficiary: usdc,
          usdcMint: USDC_MINT,
          eventAuthority: pdas.eventAuthority,
          program: PROGRAM,
          price: PRICE,
          payoutTable: COIN_FLIP,
          appShareBps: 30n,
          nonce,
        },
        cfg,
      ),
    ],
    `${label}: open_ticket #${nonce}`,
  );
  const ticket = await ticketPda(integrator, nonce);
  const w = (await fetchTicket(rpc, ticket)).data;
  console.log(`  ticket ${ticket}, open slot ${w.openSlot}, expiry slot ${w.expirySlot}`);
  return { ticket, confirmedAt: Date.now() };
}

async function waitTerminal(ticket: Address, startedAt: number, timeoutMs = 180_000) {
  let last = "";
  for (;;) {
    const { body } = await api<View>(`/v1/tickets/${ticket}`);
    if (body.state !== last) {
      console.log(`  +${((Date.now() - startedAt) / 1000).toFixed(1)} s: ${body.state}`);
      last = body.state;
    }
    if (["settled", "expired", "unknown"].includes(body.state)) return body;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`${ticket} still ${body.state}`);
    await sleep(1_000);
  }
}

function report(label: string, v: View, startedAt: number) {
  console.log(`  ${label}: ${v.state} after ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
  if (v.requestSignature) console.log(`    request  ${explorerTx(v.requestSignature)}`);
  if (v.settleSignature) console.log(`    settle   ${explorerTx(v.settleSignature)}`);
  if (v.expireSignature) console.log(`    expire   ${explorerTx(v.expireSignature)}`);
  if (v.payout !== undefined)
    console.log(`    outcome ${v.outcome}, payout ${v.payout} base units`);
}

async function main() {
  const before = (await health()).body;
  console.log(`keeper ${before.keeper}: ${before.lamports} lamports, queue ${before.queue}`);

  console.log("\n▶ posted ticket");
  const a = await openTicket("A");
  const posted = await api<{ status: string }>("/v1/tickets", {
    method: "POST",
    body: JSON.stringify({ ticket: a.ticket }),
  });
  console.log(`  POST /v1/tickets → ${posted.status} ${JSON.stringify(posted.body)}`);
  report("A", await waitTerminal(a.ticket, a.confirmedAt), a.confirmedAt);

  console.log("\n▶ ticket left for the sweep (not posted)");
  const b = await openTicket("B");
  // Only the chain is watched here: a GET of an untracked address would queue it.
  for (;;) {
    const m = await fetchMaybeTicket(rpc, b.ticket);
    if (!m.exists || m.data.status === TicketStatus.PayoutPending) break;
    if (Date.now() - b.confirmedAt > 240_000) throw new Error("the sweep did not pick B up");
    await sleep(2_000);
  }
  report("B", (await api<View>(`/v1/tickets/${b.ticket}`)).body, b.confirmedAt);

  console.log("\n▶ open tickets left");
  const accounts = await rpc
    .getProgramAccounts(PROGRAM, {
      encoding: "base64",
      filters: [{ dataSize: 859n }],
    })
    .send();
  const open = accounts.filter((x) => {
    const w = getTicketDecoder().decode(Buffer.from(x.account.data[0], "base64"));
    return w.status !== TicketStatus.PayoutPending;
  });
  console.log(`  ${open.length} open or requested`);

  await sleep(11_000); // the health route caches the balance for 10 s
  const after = (await health()).body;
  const delta = BigInt(after.lamports) - BigInt(before.lamports);
  console.log(
    `\nkeeper ${before.lamports} → ${after.lamports} lamports (${delta >= 0n ? "+" : ""}${delta})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
