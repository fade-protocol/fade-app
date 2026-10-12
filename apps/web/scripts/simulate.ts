// Checks the app's instruction building against the live devnet program
// without a wallet: every transaction is simulated (no signature, nothing
// spent) with a reference address as fee payer and signer.
//
//   pnpm --filter ./apps/web exec tsx scripts/simulate.ts [address]
//
// The address defaults to the devnet council, which holds test USDC.
import { address, createNoopSigner, type Address } from "@solana/kit";
import { getRequestDepositInstructionAsync } from "../../../clients/js/src/generated/fade";
import { PROGRAM, PROGRAM_CONFIG, USDC_MINT } from "../src/lib/config";
import { ata, depositRequestPda, fetchProtocolState, joiningEpochId, pdas } from "../src/lib/fade";
import { usdc } from "../src/lib/format";
import { quote, type Outcome } from "../src/lib/math";
import {
  CART,
  DEMO_APP_SHARE_BPS,
  DEMO_MARGIN_BPS,
  boosterPayoutTable,
  checkoutPayoutTable,
  largestWinBack,
  packSteps,
  packTicket,
  winBackPayoutTable,
  swapOut,
} from "../src/lib/payoutTables";
import { MAX_WIN_BACK_P, ticketForChance, ticketSteps } from "../src/lib/tickets";
import { simulate } from "../src/lib/tx";
import {
  fetchTicket,
  isFulfilled,
  openTicketInstruction,
  requestRandomnessInstruction,
  resolveOpener,
  settleInstruction,
  ticketAddress,
} from "../src/lib/ticket";
import { TicketStatus } from "../../../clients/js/src/generated/fade";

const state = await fetchProtocolState();
if (!state.initialized) {
  console.log("program not initialized yet");
  process.exit(0);
}
const who: Address = process.argv[2] ? address(process.argv[2]) : state.config.council;
const signer = createNoopSigner(who);
const opener = await resolveOpener(who);
const params = state.config.params;
const vault = {
  assets: state.vault.totalAssets,
  reserved: state.vault.totalReservedLiability,
  openCredits: state.vault.openVaultCredits,
};
console.log(
  `simulating as ${who}: USDC ${opener.usdcBalance === null ? "none" : usdc(opener.usdcBalance)}, nonce ${opener.nonce}`,
);
console.log(
  `vault ${usdc(vault.assets)} assets, ${usdc(vault.reserved)} reserved, ${usdc(vault.openCredits)} open credits`,
);

async function open(
  name: string,
  outcomes: readonly Outcome[],
  expected: string | null,
  price = params.minPrice,
) {
  const q = quote({
    outcomes,
    price,
    appShareBps: DEMO_APP_SHARE_BPS,
    params,
    vault,
    integratorReserved: opener.reserved,
  });
  const ix = await openTicketInstruction({
    signer,
    opener,
    treasury: state.initialized ? state.config.protocolTreasury : who,
    outcomes,
    price,
    appShareBps: DEMO_APP_SHARE_BPS,
  });
  const sim = await simulate(who, [ix]);
  const got = sim.ok ? null : sim.failure.name;
  const mark = got === expected ? "ok  " : "FAIL";
  console.log(
    `${mark} ${name}: program ${sim.ok ? `accepts (${sim.units} CU)` : `refuses ${got}: ${sim.failure.message}`}; app predicted ${q.refusal ?? "accept"}; liability ${usdc(q.liability, 6)}, cap ${q.cap === null ? "-" : usdc(q.cap, 6)}`,
  );
  if (got !== expected && !sim.ok) console.log(sim.failure.logs.slice(-6).join("\n"));
  if ((q.refusal ?? null) !== got)
    console.log("     ^ the app's prediction differs from the program");
}

const checkout = checkoutPayoutTable(params.minPrice);
console.log(`checkout payout table: p ${checkout[0]?.p} m ${checkout[0]?.m}`);
const cartFits =
  quote({ outcomes: checkout, price: params.minPrice, appShareBps: 0n, params, vault }).refusal ===
  null;
await open("A. checkout win-back", checkout, cartFits ? null : "PerTicketCap");
{
  // The swap demo pays back the trade's value; the app offers trades up to largestWinBack.
  const value = swapOut(500_000_000n);
  const max = largestWinBack({ price: params.minPrice, params, vault });
  console.log(
    `swap demo: 0.5 SOL = ${usdc(value)} test USDC; the vault pays back up to ${usdc(max)}`,
  );
  await open(
    "B. swap win-back, 0.5 SOL",
    winBackPayoutTable(params.minPrice, value),
    value <= max ? null : "PerTicketCap",
  );
  if (max > 0n)
    await open("B. swap win-back, at the live cap", winBackPayoutTable(params.minPrice, max), null);
}
{
  const pack = 5_000_000n;
  await open("C. booster, 5 USDC pack", boosterPayoutTable(pack), null, packTicket(pack));
}

// The ticket sliders: the smallest and the largest ticket each demo offers.
{
  const accepts = (outcomes: readonly Outcome[], price: bigint) =>
    quote({ outcomes, price, appShareBps: DEMO_APP_SHARE_BPS, params, vault }).refusal === null;
  const winBackRange = (prize: bigint) => {
    const atChance = ticketForChance(prize, DEMO_MARGIN_BPS, MAX_WIN_BACK_P, (t) =>
      winBackPayoutTable(t, prize),
    );
    const max = atChance < params.maxPrice ? atChance : params.maxPrice;
    return ticketSteps(params.minPrice, max, (t) => {
      const b = winBackPayoutTable(t, prize);
      return (b[0]?.p ?? 0n) <= MAX_WIN_BACK_P && accepts(b, t);
    });
  };
  const show = (steps: bigint[]) => steps.map((t) => usdc(t)).join(" ");
  const checkoutSteps = winBackRange(CART.total);
  console.log(`checkout tickets: ${show(checkoutSteps)}`);
  for (const t of [checkoutSteps[0], checkoutSteps[checkoutSteps.length - 1]])
    if (t !== undefined)
      await open(`A. checkout, ticket ${usdc(t)}`, winBackPayoutTable(t, CART.total), null, t);
  const trade = swapOut(500_000_000n);
  const swapSteps = winBackRange(trade);
  console.log(`swap tickets on 0.5 SOL: ${show(swapSteps)}`);
  for (const t of [swapSteps[0], swapSteps[swapSteps.length - 1]])
    if (t !== undefined)
      await open(`B. swap 0.5 SOL, ticket ${usdc(t)}`, winBackPayoutTable(t, trade), null, t);
  const packs = packSteps(params, (p) => accepts(boosterPayoutTable(p), packTicket(p)));
  console.log(`booster packs: ${show(packs)}`);
  for (const p of [packs[0], packs[packs.length - 1]])
    if (p !== undefined)
      await open(
        `C. booster, ${usdc(p)} pack, add-on ${usdc(packTicket(p))}`,
        boosterPayoutTable(p),
        null,
        packTicket(p),
      );
}

// request_deposit for 10 test USDC
{
  const p = await pdas();
  const epochId = joiningEpochId(state.queue, state.now);
  const ix = await getRequestDepositInstructionAsync(
    {
      owner: signer,
      ownerUsdc: await ata(who),
      usdcMint: USDC_MINT,
      request: await depositRequestPda(epochId, who),
      eventAuthority: p.eventAuthority,
      program: PROGRAM,
      amount: 10_000_000n,
    },
    PROGRAM_CONFIG,
  );
  const sim = await simulate(who, [ix]);
  console.log(
    `${sim.ok ? "ok  " : "FAIL"} request_deposit 10 USDC into epoch ${epochId}: ${sim.ok ? `accepted (${sim.units} CU)` : `${sim.failure.name}: ${sim.failure.message}`}`,
  );
}

// any open ticket of this opener: simulate its next step
for (let n = opener.nonce > 5n ? opener.nonce - 5n : 0n; n < opener.nonce; n++) {
  const ticket = await ticketAddress(opener.integrator, n);
  const w = await fetchTicket(ticket);
  if (!w) continue;
  if (w.status === TicketStatus.Open) {
    const slot = await import("../src/lib/rpc").then((m) => m.rpc.getSlot().send());
    if (slot > w.expirySlot) {
      console.log(`ticket #${n} is past its request window`);
      continue;
    }
    const { instruction } = await requestRandomnessInstruction(signer, ticket, w.openSlot);
    const sim = await simulate(who, [instruction]);
    console.log(
      `${sim.ok ? "ok  " : "FAIL"} request_randomness for ticket #${n}: ${sim.ok ? "accepted" : `${sim.failure.name}: ${sim.failure.message}`}`,
    );
  } else if (w.status === TicketStatus.Requested) {
    const fulfilled = await isFulfilled(w.randomness);
    const sim = await simulate(who, [await settleInstruction(signer, ticket, w)]);
    console.log(
      `${sim.ok ? "ok  " : "FAIL"} settle_ticket for ticket #${n} (fulfilled ${fulfilled}): ${sim.ok ? "accepted" : `${sim.failure.name}: ${sim.failure.message}`}`,
    );
  }
}

// strike_epoch: resolves its accounts; refused unless an epoch is live and closed
{
  const { strikeInstruction } = await import("../src/lib/lp");
  const live = state.queue.current.live;
  const id = state.queue.current.epochId;
  const sim = await simulate(who, [await strikeInstruction(signer, id)]);
  const expected = !live
    ? "NoLiveEpoch"
    : state.now < state.queue.current.closeTs
      ? "EpochNotClosed"
      : null;
  const got = sim.ok ? null : sim.failure.name;
  console.log(
    `${got === expected ? "ok  " : "FAIL"} strike_epoch ${id}: ${sim.ok ? "accepted" : `${got}: ${sim.failure.message}`} (expected ${expected ?? "accept"})`,
  );
}
