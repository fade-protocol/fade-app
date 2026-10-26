// End-to-end run of the deployed devnet program against the real ORAO VRF
// Repeatable: every step checks the on-chain state it
// leaves, and a run first finishes whatever an interrupted one left open.
//
//   1. founding deposit, strike, claim       (skipped once the vault has assets)
//   2. a ticket left to expire                (opened first: T_SETTLE runs during 3–5)
//   3. two tickets: open, request_randomness, ORAO fulfilment, settle
//   4. a parked payout: beneficiary closed after open, settle → PayoutPending,
//      account recreated, claim_payout
//   5. two refusals, simulated: PayoutTableOverpays and PerTicketCap
//   6. expire_ticket past T_SETTLE: the credit stays with the vault
//   7. a withdrawal: request_withdraw, strike, claim_withdraw
//
// Writes scripts/devnet/runs/<ISO timestamp>.json.
//
//   pnpm devnet:e2e  (after pnpm devnet:init)
import { createAddressWithSeed, type Address, type KeyPairSigner } from "@solana/kit";
import { getCreateAccountWithSeedInstruction } from "@solana-program/system";
import {
  getCloseAccountInstruction,
  getInitializeAccount3Instruction,
  getMintToInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import {
  FADE_ERROR__EPOCH_NOT_CLOSED,
  FADE_ERROR__PAYOUT_TABLE_OVERPAYS,
  FADE_ERROR__PER_TICKET_CAP,
  TicketStatus,
  fetchConfig,
  fetchMaybeDepositRequest,
  fetchMaybeEpochRecord,
  fetchMaybeIntegrator,
  fetchMaybeTicket,
  fetchMaybeWithdrawRequest,
  fetchVault,
  fetchQueue,
  fetchTicket,
  findPayoutEscrowPda,
  getClaimDepositInstructionAsync,
  getClaimPayoutInstructionAsync,
  getClaimWithdrawInstructionAsync,
  getExpireTicketInstructionAsync,
  getOpenTicketInstructionAsync,
  getRequestDepositInstructionAsync,
  getRequestRandomnessInstructionAsync,
  getRequestWithdrawInstructionAsync,
  getSettleTicketInstructionAsync,
  getStrikeEpochInstructionAsync,
  type OutcomeArgs,
  type Queue,
} from "../../clients/js/src/generated/fade/index.ts";
import {
  PROGRAM,
  TOKEN,
  USDC,
  USDC_MINT,
  SendError,
  accountData,
  openExpiryAccounts,
  accountOwner,
  ata,
  currentSlot,
  depositRequestPda,
  epochPda,
  explorerAddress,
  fadeErrorName,
  fadePdas,
  firstSlotHashAfter,
  fmtSol,
  fmtUsdc,
  integratorPda,
  loadDeployer,
  oraoNetwork,
  oraoRequestPda,
  oraoSeed,
  parseRandomness,
  rentExempt,
  rpc,
  send,
  simulate,
  sleep,
  solBalance,
  tokenAmount,
  ticketPda,
  withdrawRequestPda,
  writeJson,
  type Sent,
} from "./lib.ts";

const cfg = { programAddress: PROGRAM };
const FOUNDING_DEPOSIT = 5_000n * USDC;
const PRICE = 7_500_000n; // the minimum ticket price
const APP_SHARE_BPS = 30n;

/** Coin flip paying 1.956x: Σ p·m = 0.978, a 220 bps margin (vault keeps 170 after the shares). */
const COIN_FLIP: OutcomeArgs[] = [
  { p: 500_000_000n, m: 19_560n },
  { p: 500_000_000n, m: 0n },
];
/** Every outcome pays something (1.5x or 0.456x), same 220 bps margin: a settlement always has a payout to park. */
const ALWAYS_PAYS: OutcomeArgs[] = [
  { p: 500_000_000n, m: 15_000n },
  { p: 500_000_000n, m: 4_560n },
];
/** RTP 105 %: pays out more than it takes in. */
const OVERPAYS: OutcomeArgs[] = [
  { p: 500_000_000n, m: 21_000n },
  { p: 500_000_000n, m: 0n },
];
/** 100x with p = 0.978 %: fair-ish (220 bps margin) but its worst case dwarfs the per-ticket cap. */
const LONG_SHOT: OutcomeArgs[] = [
  { p: 9_780_000n, m: 1_000_000n },
  { p: 990_220_000n, m: 0n },
];

// --- run log ------------------------------------------------------------------------

type Step = {
  name: string;
  result: "ok" | "failed" | "skipped";
  signature?: string;
  link?: string;
  slot?: string;
  detail?: Record<string, unknown>;
  error?: string;
};
const steps: Step[] = [];
const startedAt = new Date();

function record(name: string, sent: Sent | null, detail: Record<string, unknown> = {}) {
  const s: Step = { name, result: "ok", detail };
  if (sent) {
    s.signature = sent.signature;
    s.link = sent.link;
    s.slot = sent.slot.toString();
  }
  steps.push(s);
}

function check(cond: boolean, what: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${what}`);
}

// --- context ------------------------------------------------------------------------

type Ctx = {
  deployer: KeyPairSigner;
  pdas: Awaited<ReturnType<typeof fadePdas>>;
  deployerUsdc: Address;
  deployerShares: Address;
  treasury: Address;
  integrator: Address;
  orao: Awaited<ReturnType<typeof oraoNetwork>>;
  payoutEscrow: Address;
};

const common = (c: Ctx) => ({ eventAuthority: c.pdas.eventAuthority, program: PROGRAM });

async function chainNow(): Promise<bigint> {
  const slot = await currentSlot();
  try {
    const t = await rpc.getBlockTime(slot).send();
    if (t !== null) return BigInt(t);
  } catch {
    // recent slots may not have a block time yet
  }
  return BigInt(Math.floor(Date.now() / 1000));
}

function joiningEpochId(q: Queue, now: bigint): bigint {
  if (!q.current.live) return q.nextEpochId;
  if (now < q.current.closeTs) return q.current.epochId;
  return q.next.live ? q.next.epochId : q.nextEpochId;
}

async function nextNonce(c: Ctx): Promise<bigint> {
  const i = await fetchMaybeIntegrator(rpc, c.integrator);
  return i.exists ? i.data.nextNonce : 0n;
}

/** Seed of the beneficiary token account of a parking test: derived, so a later run can recreate it. */
const parkSeed = (nonce: bigint) => `fade-park-${nonce}`;
const parkAddress = (c: Ctx, nonce: bigint) =>
  createAddressWithSeed({
    baseAddress: c.deployer.address,
    programAddress: TOKEN,
    seed: parkSeed(nonce),
  });

async function createParkAccount(c: Ctx, nonce: bigint, label: string) {
  const addr = await parkAddress(c, nonce);
  return send(
    c.deployer,
    [
      getCreateAccountWithSeedInstruction({
        payer: c.deployer,
        newAccount: addr,
        baseAccount: c.deployer,
        base: c.deployer.address,
        seed: parkSeed(nonce),
        amount: await rentExempt(165),
        space: 165n,
        programAddress: TOKEN,
      }),
      getInitializeAccount3Instruction({
        account: addr,
        mint: USDC_MINT,
        owner: c.deployer.address,
      }),
    ],
    label,
  );
}

// --- ticket steps ----------------------------------------------------------------------

async function openTicket(
  c: Ctx,
  name: string,
  payoutTable: OutcomeArgs[],
  beneficiary: Address,
  price = PRICE,
) {
  const nonce = await nextNonce(c);
  const ticket = await ticketPda(c.integrator, nonce);
  const vaultBefore = (await fetchVault(rpc, c.pdas.vault)).data;
  const sent = await send(
    c.deployer,
    [
      await getOpenTicketInstructionAsync(
        {
          integratorAuthority: c.deployer,
          payer: c.deployer,
          funder: c.deployer,
          funderUsdc: c.deployerUsdc,
          shareAccount: c.deployerUsdc,
          protocolTreasury: c.treasury,
          beneficiary,
          usdcMint: USDC_MINT,
          ...common(c),
          price,
          payoutTable,
          appShareBps: APP_SHARE_BPS,
          nonce,
        },
        cfg,
      ),
    ],
    `${name}: open_ticket #${nonce}`,
  );
  const w = (await fetchTicket(rpc, ticket)).data;
  const vault = (await fetchVault(rpc, c.pdas.vault)).data;
  check(w.status === TicketStatus.Open, "ticket is Open");
  check(
    w.beneficiary === beneficiary && w.price === price,
    "ticket stores beneficiary and ticket price",
  );
  check(
    vault.openVaultCredits === vaultBefore.openVaultCredits + w.vaultCredit,
    "vault open credits grew by the ticket's credit",
  );
  check(
    vault.totalAssets === vaultBefore.totalAssets + w.vaultCredit,
    "vault assets grew by the credit",
  );
  record(`${name}: open_ticket`, sent, {
    ticket,
    nonce: nonce.toString(),
    price: fmtUsdc(price),
    vaultCredit: fmtUsdc(w.vaultCredit),
    payoutMax: fmtUsdc(w.payoutMax),
    reservedLiability: fmtUsdc(w.reservedLiability),
    cap: fmtUsdc(w.cap),
    marginBps: Number(w.marginBps),
    vaultMarginBps: Number(w.vaultMarginBps),
    openSlot: w.openSlot.toString(),
    expirySlot: w.expirySlot.toString(),
  });
  return { ticket, nonce, openSlot: w.openSlot, expirySlot: w.expirySlot };
}

async function requestRandomness(c: Ctx, name: string, ticket: Address) {
  const w = (await fetchTicket(rpc, ticket)).data;
  // s*: the first slot after the open, once it is in SlotHashes (and the request window is open).
  let entropy: Awaited<ReturnType<typeof firstSlotHashAfter>> = null;
  for (let i = 0; i < 60; i++) {
    const slot = await currentSlot();
    if (slot >= w.openSlot + 2n) entropy = await firstSlotHashAfter(w.openSlot);
    if (entropy) break;
    await sleep(400);
  }
  if (!entropy) throw new Error("no SlotHashes entry after the open slot");
  const seed = oraoSeed(ticket, w.openSlot, entropy.slot, entropy.hash);
  const request = await oraoRequestPda(seed);
  const sent = await send(
    c.deployer,
    [
      await getRequestRandomnessInstructionAsync(
        {
          caller: c.deployer,
          ticket,
          oraoTreasury: c.orao.treasury,
          request,
          ...common(c),
        },
        cfg,
      ),
    ],
    `${name}: request_randomness`,
  );
  const after = (await fetchTicket(rpc, ticket)).data;
  check(after.status === TicketStatus.Requested, "ticket is Requested");
  check(after.randomness === request, "ticket bound the ORAO request");
  check(after.entropySlot === entropy.slot, "entropy slot matches the client's");
  check(Buffer.from(after.seed).equals(Buffer.from(seed)), "seed matches the client's derivation");
  record(`${name}: request_randomness`, sent, {
    request,
    entropySlot: entropy.slot.toString(),
    slotsAfterOpen: (sent.slot - w.openSlot).toString(),
  });
  return { request, requestSlot: sent.slot, requestSig: sent.signature };
}

type Latency = {
  ticket: string;
  request: string;
  requestSlot: string;
  fulfilSlot: string;
  slots: number;
  seconds: number | null;
  wallClockSeconds: number;
  fulfilSignature: string | null;
};
const latencies: Latency[] = [];

async function waitFulfilled(
  name: string,
  ticket: Address,
  r: { request: Address; requestSlot: bigint; requestSig: string },
) {
  const started = Date.now();
  for (;;) {
    const data = await accountData(r.request);
    if (data && parseRandomness(data).fulfilled) break;
    if (Date.now() - started > 180_000)
      throw new Error(`${name}: ORAO did not fulfil within 180 s`);
    await sleep(800);
  }
  const wall = (Date.now() - started) / 1000;
  // The fulfilment is the request account's newest transaction other than ours.
  const sigs = await rpc
    .getSignaturesForAddress(r.request, { limit: 10, commitment: "confirmed" })
    .send();
  const fulfil = sigs.find((s) => s.signature !== r.requestSig && s.err === null);
  const ours = sigs.find((s) => s.signature === r.requestSig);
  const fulfilSlot = fulfil?.slot ?? (await currentSlot());
  const seconds =
    fulfil?.blockTime != null && ours?.blockTime != null
      ? Number(fulfil.blockTime - ours.blockTime)
      : null;
  const l: Latency = {
    ticket,
    request: r.request,
    requestSlot: r.requestSlot.toString(),
    fulfilSlot: fulfilSlot.toString(),
    slots: Number(fulfilSlot - r.requestSlot),
    seconds,
    wallClockSeconds: wall,
    fulfilSignature: fulfil?.signature ?? null,
  };
  latencies.push(l);
  console.log(
    `  ✓ ${name}: ORAO fulfilled after ${l.slots} slots (${seconds ?? "?"} s by block time, ${wall.toFixed(1)} s polled)`,
  );
  steps.push({
    name: `${name}: ORAO fulfilment`,
    result: "ok",
    ...(fulfil
      ? {
          signature: fulfil.signature,
          link: `https://explorer.solana.com/tx/${fulfil.signature}?cluster=devnet`,
        }
      : {}),
    slot: fulfilSlot.toString(),
    detail: { ...l },
  });
}

async function settle(c: Ctx, name: string, ticket: Address, request: Address) {
  const w = (await fetchTicket(rpc, ticket)).data;
  const beneficiaryBefore = (await tokenAmount(w.beneficiary)) ?? 0n;
  const escrowBefore = (await tokenAmount(c.payoutEscrow)) ?? 0n;
  const vaultBefore = (await fetchVault(rpc, c.pdas.vault)).data;
  const sent = await send(
    c.deployer,
    [
      await getSettleTicketInstructionAsync(
        {
          caller: c.deployer,
          integrator: c.integrator,
          ticket,
          randomness: request,
          beneficiary: w.beneficiary,
          payer: c.deployer.address,
          usdcMint: USDC_MINT,
          ...common(c),
        },
        cfg,
      ),
    ],
    `${name}: settle_ticket`,
  );
  const vault = (await fetchVault(rpc, c.pdas.vault)).data;
  const after = await fetchMaybeTicket(rpc, ticket);
  const beneficiaryAfter = (await tokenAmount(w.beneficiary)) ?? 0n;
  const escrowAfter = (await tokenAmount(c.payoutEscrow)) ?? 0n;
  const parked = after.exists && after.data.status === TicketStatus.PayoutPending;
  const payout = parked ? escrowAfter - escrowBefore : beneficiaryAfter - beneficiaryBefore;
  const outcomes = w.payoutTable.slice(0, w.payoutTableLen);
  const outcome = outcomes.findIndex((b) => (w.price * b.m) / 10_000n === payout);
  check(outcome >= 0, `payout ${payout} is one of the payout table's`);
  check(
    vault.openVaultCredits === vaultBefore.openVaultCredits - w.vaultCredit,
    "the ticket's credit left the open credits",
  );
  check(vault.totalAssets === vaultBefore.totalAssets - payout, "vault assets fell by the payout");
  check(parked || !after.exists, "settled ticket closed (or parked)");
  if (parked)
    check(after.exists && after.data.payout === payout, "parked payout recorded on the ticket");
  const multiplier = Number(outcomes[outcome]?.m ?? 0n) / 10_000;
  const result = payout > w.price ? "won" : payout === 0n ? "lost" : "partial";
  console.log(
    `    → ${result}: outcome ${outcome} (${multiplier}x), payout ${fmtUsdc(payout)}${parked ? " PARKED in payout_escrow" : ""}`,
  );
  record(`${name}: settle_ticket`, sent, {
    result,
    outcome,
    multiplier,
    price: fmtUsdc(w.price),
    payout: fmtUsdc(payout),
    parked,
  });
  return { payout, parked, result };
}

async function playTicket(c: Ctx, name: string) {
  const { ticket } = await openTicket(c, name, COIN_FLIP, c.deployerUsdc);
  const r = await requestRandomness(c, name, ticket);
  await waitFulfilled(name, ticket, r);
  return settle(c, name, ticket, r.request);
}

// --- vault steps ----------------------------------------------------------------------

async function waitForClose(closeTs: bigint) {
  for (;;) {
    const now = await chainNow();
    if (now >= closeTs) return;
    const left = Number(closeTs - now);
    console.log(`    waiting ${left} s for the epoch close`);
    await sleep(Math.min(left, 20) * 1000 + 1000);
  }
}

/** Strikes the live epoch once it has closed, then claims the deployer's requests in it. */
async function strikeAndClaim(c: Ctx, name: string) {
  const q = (await fetchQueue(rpc, c.pdas.queue)).data;
  check(q.current.live, "an epoch is live");
  const epochId = q.current.epochId;
  await waitForClose(q.current.closeTs);
  const recordAddr = await epochPda(epochId);
  const vaultBefore = (await fetchVault(rpc, c.pdas.vault)).data;
  let sent: Sent | null = null;
  for (let attempt = 0; attempt < 8 && !sent; attempt++) {
    try {
      sent = await send(
        c.deployer,
        [
          await getStrikeEpochInstructionAsync(
            { caller: c.deployer, record: recordAddr, usdcMint: USDC_MINT, ...common(c) },
            cfg,
          ),
        ],
        `${name}: strike_epoch ${epochId}`,
      );
    } catch (e) {
      if (e instanceof SendError && e.code === FADE_ERROR__EPOCH_NOT_CLOSED) {
        console.log("    clock not past the close yet, retrying");
        await sleep(3000);
        continue;
      }
      throw e;
    }
  }
  if (!sent) throw new Error("strike kept failing with EpochNotClosed");
  const vault = (await fetchVault(rpc, c.pdas.vault)).data;
  const rec = await fetchMaybeEpochRecord(rpc, recordAddr);
  const recData = rec.exists ? rec.data : null;
  check(
    vault.totalAssets ===
      vaultBefore.totalAssets + q.current.deposits - (recData?.assetsPaid ?? 0n),
    "vault assets = before + deposits − assets paid",
  );
  record(`${name}: strike_epoch`, sent, {
    epochId: epochId.toString(),
    record: recordAddr,
    deposits: fmtUsdc(q.current.deposits),
    withdrawShares: q.current.withdrawShares.toString(),
    sharesMinted: recData?.sharesMinted.toString() ?? null,
    sharesBurnt: recData?.sharesBurnt.toString() ?? null,
    assetsPaid: recData ? fmtUsdc(recData.assetsPaid) : null,
    vaultAssetsAfter: fmtUsdc(vault.totalAssets),
    vaultSharesAfter: vault.totalShares.toString(),
  });

  // claims of the deployer's own requests in that epoch
  const dep = await depositRequestPda(epochId, c.deployer.address);
  const d = await fetchMaybeDepositRequest(rpc, dep);
  if (d.exists && recData) {
    const before = (await tokenAmount(c.deployerShares)) ?? 0n;
    const r = await fetchMaybeEpochRecord(rpc, recordAddr);
    const s = await send(
      c.deployer,
      [
        await getClaimDepositInstructionAsync(
          {
            caller: c.deployer,
            request: dep,
            owner: c.deployer.address,
            record: recordAddr,
            ownerShares: c.deployerShares,
            ...(r.exists ? { rentReceiver: r.data.rentPayer } : {}),
            ...common(c),
          },
          cfg,
        ),
      ],
      `${name}: claim_deposit`,
    );
    const after = (await tokenAmount(c.deployerShares)) ?? 0n;
    const expected = (recData.sharesMinted * d.data.amount) / (recData.deposits || 1n);
    check(after > before, "the LP received shares");
    check(!(await fetchMaybeDepositRequest(rpc, dep)).exists, "deposit request closed");
    record(`${name}: claim_deposit`, s, {
      deposited: fmtUsdc(d.data.amount),
      sharesReceived: (after - before).toString(),
      sharesExpectedApprox: expected.toString(),
      lpShareBalance: after.toString(),
    });
  }
  const wd = await withdrawRequestPda(epochId, c.deployer.address);
  const w = await fetchMaybeWithdrawRequest(rpc, wd);
  if (w.exists && recData) {
    const before = (await tokenAmount(c.deployerUsdc)) ?? 0n;
    const r = await fetchMaybeEpochRecord(rpc, recordAddr);
    const s = await send(
      c.deployer,
      [
        await getClaimWithdrawInstructionAsync(
          {
            caller: c.deployer,
            request: wd,
            owner: c.deployer.address,
            atRecord: recordAddr,
            ownerUsdc: c.deployerUsdc,
            usdcMint: USDC_MINT,
            ...(r.exists ? { rentReceiver: r.data.rentPayer } : {}),
            ...common(c),
          },
          cfg,
        ),
      ],
      `${name}: claim_withdraw`,
    );
    const after = (await tokenAmount(c.deployerUsdc)) ?? 0n;
    const left = await fetchMaybeWithdrawRequest(rpc, wd);
    check(after > before, "the LP received USDC");
    record(`${name}: claim_withdraw`, s, {
      shares: w.data.shares.toString(),
      usdcReceived: fmtUsdc(after - before),
      assetsPaidByStrike: fmtUsdc(recData.assetsPaid),
      requestClosed: !left.exists,
    });
  }
}

// --- recovery of an interrupted run -----------------------------------------------------

async function recover(c: Ctx) {
  const next = await nextNonce(c);
  for (let n = next > 16n ? next - 16n : 0n; n < next; n++) {
    const ticket = await ticketPda(c.integrator, n);
    const m = await fetchMaybeTicket(rpc, ticket);
    if (!m.exists) continue;
    const w = m.data;
    console.log(`recovering ticket #${n} (${TicketStatus[w.status]})`);
    if (w.status === TicketStatus.PayoutPending) {
      if ((await accountOwner(w.beneficiary)) !== TOKEN)
        await createParkAccount(c, n, `recover: recreate beneficiary #${n}`);
      const s = await send(
        c.deployer,
        [
          await getClaimPayoutInstructionAsync(
            {
              caller: c.deployer,
              ticket,
              beneficiary: w.beneficiary,
              payer: c.deployer.address,
              usdcMint: USDC_MINT,
              ...common(c),
            },
            cfg,
          ),
        ],
        `recover: claim_payout #${n}`,
      );
      record(`recover: claim_payout #${n}`, s);
      continue;
    }
    if (w.status === TicketStatus.Requested) {
      const data = await accountData(w.randomness);
      if (data && parseRandomness(data).fulfilled) {
        await settle(c, `recover #${n}`, ticket, w.randomness);
        const after = await fetchMaybeTicket(rpc, ticket);
        if (after.exists) await recover(c);
        continue;
      }
    }
    // Open, or requested and never fulfilled: wait out T_SETTLE and expire (an Open one
    // names its derived request address, its seed recorded first).
    while ((await currentSlot()) <= w.expirySlot) await sleep(4000);
    const open = w.status === TicketStatus.Requested ? null : await openExpiryAccounts(ticket, w);
    if (w.status !== TicketStatus.Requested && !open)
      throw new Error(`ticket #${n}: its seed can no longer be derived: refund_expired_ticket`);
    const s = await send(
      c.deployer,
      [
        ...(open?.record ? [open.record] : []),
        await getExpireTicketInstructionAsync(
          {
            caller: c.deployer,
            integrator: c.integrator,
            ticket,
            randomness: open ? open.randomness : w.randomness,
            payer: c.deployer.address,
            ...common(c),
          },
          cfg,
        ),
      ],
      `recover: expire_ticket #${n}`,
    );
    record(`recover: expire_ticket #${n}`, s);
  }
  const q = (await fetchQueue(rpc, c.pdas.queue)).data;
  if (q.current.live) {
    console.log(`recovering live epoch ${q.current.epochId}`);
    await strikeAndClaim(c, "recover");
  }
}

// --- main ------------------------------------------------------------------------------

async function step(name: string, fn: () => Promise<void>) {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${name}: ${message}`);
    steps.push({ name, result: "failed", error: message });
    return false;
  }
  return true;
}

async function main() {
  const deployer = await loadDeployer();
  const pdas = await fadePdas();
  const config = (await fetchConfig(rpc, pdas.config)).data;
  const c: Ctx = {
    deployer,
    pdas,
    deployerUsdc: await ata(deployer.address, USDC_MINT),
    deployerShares: await ata(deployer.address, pdas.shareMint),
    treasury: config.protocolTreasury,
    integrator: await integratorPda(deployer.address),
    orao: await oraoNetwork(),
    payoutEscrow: (await findPayoutEscrowPda(cfg))[0],
  };
  const solBefore = await solBalance(deployer.address);
  console.log(`deployer ${deployer.address}: ${fmtSol(solBefore)}`);
  console.log(
    `program ${PROGRAM}, epoch ${config.params.epochLengthSeconds} s, T_SETTLE ${config.params.tSettleSlots} slots`,
  );
  console.log(`ORAO fee ${c.orao.requestFee} lamports, treasury ${c.orao.treasury}`);

  // Enough test USDC for the deposit and the ticket prices.
  const usdc = (await tokenAmount(c.deployerUsdc)) ?? 0n;
  if (usdc < FOUNDING_DEPOSIT + 1_000n * USDC) {
    const s = await send(
      deployer,
      [
        getMintToInstruction({
          mint: USDC_MINT,
          token: c.deployerUsdc,
          mintAuthority: deployer,
          amount: 10_000n * USDC,
        }),
      ],
      "mint test USDC",
    );
    record("mint test USDC", s, { amount: fmtUsdc(10_000n * USDC) });
  }

  let ok = await step("recover an interrupted run", () => recover(c));

  ok &&= await step("1. founding deposit, strike, claim", async () => {
    const vault = (await fetchVault(rpc, pdas.vault)).data;
    if (vault.totalAssets > 0n) {
      console.log(`  vault already holds ${fmtUsdc(vault.totalAssets)}: skipped`);
      steps.push({
        name: "1. founding deposit",
        result: "skipped",
        detail: { vaultAssets: fmtUsdc(vault.totalAssets) },
      });
      return;
    }
    const q = (await fetchQueue(rpc, pdas.queue)).data;
    const epochId = joiningEpochId(q, await chainNow());
    const request = await depositRequestPda(epochId, deployer.address);
    const s = await send(
      deployer,
      [
        await getRequestDepositInstructionAsync(
          {
            owner: deployer,
            ownerUsdc: c.deployerUsdc,
            usdcMint: USDC_MINT,
            request,
            ...common(c),
            amount: FOUNDING_DEPOSIT,
          },
          cfg,
        ),
      ],
      "request_deposit",
    );
    const q2 = (await fetchQueue(rpc, pdas.queue)).data;
    check(
      q2.current.live && q2.current.epochId === epochId,
      "the request opened the expected epoch",
    );
    check(q2.current.deposits === FOUNDING_DEPOSIT, "the epoch counts the deposit");
    record("1. request_deposit", s, {
      epochId: epochId.toString(),
      amount: fmtUsdc(FOUNDING_DEPOSIT),
      closeTs: q2.current.closeTs.toString(),
    });
    await strikeAndClaim(c, "1.");
    const p = (await fetchVault(rpc, pdas.vault)).data;
    check(p.totalAssets === FOUNDING_DEPOSIT, "vault holds the founding deposit");
  });
  if (!ok) return finish(c, solBefore);

  // Optional top-up: VAULT_TARGET_USDC=12000 grows the vault to that size, so the
  // web app's checkout demo (a 185.90 win-back) fits the per-ticket cap.
  const target = BigInt(process.env["VAULT_TARGET_USDC"] ?? "0") * USDC;
  if (target > 0n) {
    ok &&= await step("1b. top up the vault", async () => {
      const vault = (await fetchVault(rpc, pdas.vault)).data;
      if (vault.totalAssets >= target) {
        console.log(`  vault already holds ${fmtUsdc(vault.totalAssets)}: skipped`);
        return;
      }
      const amount = target - vault.totalAssets;
      const q = (await fetchQueue(rpc, pdas.queue)).data;
      const epochId = joiningEpochId(q, await chainNow());
      const request = await depositRequestPda(epochId, deployer.address);
      const s = await send(
        deployer,
        [
          await getRequestDepositInstructionAsync(
            {
              owner: deployer,
              ownerUsdc: c.deployerUsdc,
              usdcMint: USDC_MINT,
              request,
              ...common(c),
              amount,
            },
            cfg,
          ),
        ],
        "request_deposit (top-up)",
      );
      record("1b. request_deposit", s, { epochId: epochId.toString(), amount: fmtUsdc(amount) });
      await strikeAndClaim(c, "1b.");
    });
    if (!ok) return finish(c, solBefore);
  }

  let expiring: { ticket: Address; expirySlot: bigint } | null = null;
  await step("2. open a ticket left to expire", async () => {
    const o = await openTicket(c, "2. expiry", COIN_FLIP, c.deployerUsdc);
    expiring = { ticket: o.ticket, expirySlot: o.expirySlot };
  });

  for (const label of ["3a. ticket", "3b. ticket"]) {
    await step(label, async () => {
      await playTicket(c, label);
    });
  }

  await step("4. parked payout", async () => {
    const name = "4. park";
    const nonce = await nextNonce(c);
    const beneficiary = await parkAddress(c, nonce);
    if ((await accountOwner(beneficiary)) !== TOKEN)
      await createParkAccount(c, nonce, `${name}: create beneficiary`);
    const { ticket } = await openTicket(c, name, ALWAYS_PAYS, beneficiary);
    // The beneficiary disappears after the open: settlement cannot pay it.
    const closed = await send(
      deployer,
      [
        getCloseAccountInstruction({
          account: beneficiary,
          destination: deployer.address,
          owner: deployer,
        }),
      ],
      `${name}: close the beneficiary account`,
    );
    check((await accountOwner(beneficiary)) === null, "beneficiary account is gone");
    record(`${name}: close beneficiary`, closed, { beneficiary });
    const r = await requestRandomness(c, name, ticket);
    await waitFulfilled(name, ticket, r);
    const s = await settle(c, name, ticket, r.request);
    check(s.parked, "settlement parked the payout");
    const w = (await fetchTicket(rpc, ticket)).data;
    check(w.status === TicketStatus.PayoutPending, "ticket is PayoutPending");
    // Claiming while the account is still missing fails; recreate it, then claim.
    const recreated = await createParkAccount(
      c,
      nonce,
      `${name}: recreate the beneficiary account`,
    );
    record(`${name}: recreate beneficiary`, recreated);
    const escrowBefore = (await tokenAmount(c.payoutEscrow)) ?? 0n;
    const claimed = await send(
      deployer,
      [
        await getClaimPayoutInstructionAsync(
          {
            caller: deployer,
            ticket,
            beneficiary,
            payer: deployer.address,
            usdcMint: USDC_MINT,
            ...common(c),
          },
          cfg,
        ),
      ],
      `${name}: claim_payout`,
    );
    const got = (await tokenAmount(beneficiary)) ?? 0n;
    check(got === s.payout, "beneficiary received the parked payout");
    check(
      ((await tokenAmount(c.payoutEscrow)) ?? 0n) === escrowBefore - s.payout,
      "escrow released it",
    );
    check(!(await fetchMaybeTicket(rpc, ticket)).exists, "ticket closed by the claim");
    record(`${name}: claim_payout`, claimed, { beneficiary, payout: fmtUsdc(got) });
    // Hand the test account's USDC and rent back to the deployer.
    await send(
      deployer,
      [
        getTransferCheckedInstruction({
          source: beneficiary,
          mint: USDC_MINT,
          destination: c.deployerUsdc,
          authority: deployer,
          amount: got,
          decimals: 6,
        }),
        getCloseAccountInstruction({
          account: beneficiary,
          destination: deployer.address,
          owner: deployer,
        }),
      ],
      `${name}: sweep the test beneficiary`,
    );
  });

  await step("5. refusals (simulated)", async () => {
    const nonce = await nextNonce(c);
    for (const [name, table, expected] of [
      ["5a. PayoutTableOverpays", OVERPAYS, FADE_ERROR__PAYOUT_TABLE_OVERPAYS],
      ["5b. PerTicketCap", LONG_SHOT, FADE_ERROR__PER_TICKET_CAP],
    ] as const) {
      const sim = await simulate(deployer, [
        await getOpenTicketInstructionAsync(
          {
            integratorAuthority: deployer,
            payer: deployer,
            funder: deployer,
            funderUsdc: c.deployerUsdc,
            shareAccount: c.deployerUsdc,
            protocolTreasury: c.treasury,
            beneficiary: c.deployerUsdc,
            usdcMint: USDC_MINT,
            ...common(c),
            price: PRICE,
            payoutTable: [...table],
            appShareBps: APP_SHARE_BPS,
            nonce,
          },
          cfg,
        ),
      ]);
      const errLine = sim.logs.find((l) => l.includes("Error Code")) ?? null;
      check(
        sim.code === expected,
        `${name}: expected ${fadeErrorName(expected)}, got ${fadeErrorName(sim.code)}`,
      );
      console.log(`  ✓ ${name}: refused with ${fadeErrorName(sim.code)}`);
      steps.push({
        name,
        result: "ok",
        detail: { simulated: true, errorCode: sim.code, log: errLine },
      });
    }
  });

  await step("6. expire_ticket past T_SETTLE", async () => {
    const e = expiring as { ticket: Address; expirySlot: bigint } | null;
    if (!e) throw new Error("no ticket was opened for the expiry");
    for (;;) {
      const slot = await currentSlot();
      if (slot > e.expirySlot) break;
      console.log(
        `    slot ${slot}, expiry ${e.expirySlot}: ${e.expirySlot - slot + 1n} slots to go`,
      );
      await sleep(Math.min(Number(e.expirySlot - slot + 1n) * 400 + 500, 15_000));
    }
    const w = (await fetchTicket(rpc, e.ticket)).data;
    const vaultBefore = (await fetchVault(rpc, pdas.vault)).data;
    // Never requested: its seed recorded, and the request address derived from it named.
    const open = await openExpiryAccounts(e.ticket, w);
    if (!open) throw new Error("the expiring ticket's seed can no longer be derived");
    let s: Sent | null = null;
    for (let i = 0; i < 5 && !s; i++) {
      try {
        s = await send(
          deployer,
          [
            ...(open.record ? [open.record] : []),
            await getExpireTicketInstructionAsync(
              {
                caller: deployer,
                integrator: c.integrator,
                ticket: e.ticket,
                randomness: open.randomness,
                payer: deployer.address,
                ...common(c),
              },
              cfg,
            ),
          ],
          "6. expire_ticket",
        );
      } catch (err) {
        if (i === 4) throw err;
        await sleep(3000);
      }
    }
    if (!s) throw new Error("expire_ticket did not land");
    const vault = (await fetchVault(rpc, pdas.vault)).data;
    check(!(await fetchMaybeTicket(rpc, e.ticket)).exists, "expired ticket closed");
    check(vault.totalAssets === vaultBefore.totalAssets, "the credit stays in the vault's assets");
    check(
      vault.openVaultCredits === vaultBefore.openVaultCredits - w.vaultCredit,
      "and is no longer an open credit",
    );
    record("6. expire_ticket", s, {
      ticket: e.ticket,
      forfeitedToVault: fmtUsdc(w.vaultCredit),
      expirySlot: e.expirySlot.toString(),
    });
  });

  await step("7. withdrawal: request, strike, claim", async () => {
    const shares = (await tokenAmount(c.deployerShares)) ?? 0n;
    check(shares > 0n, "the LP holds shares");
    let amount = shares / 100n;
    if (amount < 1_000_000_000n) amount = shares < 1_000_000_000n ? shares : 1_000_000_000n;
    const q = (await fetchQueue(rpc, pdas.queue)).data;
    const epochId = joiningEpochId(q, await chainNow());
    const request = await withdrawRequestPda(epochId, deployer.address);
    const s = await send(
      deployer,
      [
        await getRequestWithdrawInstructionAsync(
          {
            owner: deployer,
            ownerShares: c.deployerShares,
            usdcMint: USDC_MINT,
            request,
            ...common(c),
            shares: amount,
          },
          cfg,
        ),
      ],
      "7. request_withdraw",
    );
    const q2 = (await fetchQueue(rpc, pdas.queue)).data;
    check(
      q2.current.live && q2.current.withdrawShares >= amount,
      "the epoch counts the withdrawal",
    );
    record("7. request_withdraw", s, {
      epochId: epochId.toString(),
      shares: amount.toString(),
      closeTs: q2.current.closeTs.toString(),
    });
    await strikeAndClaim(c, "7.");
  });

  finish(c, solBefore);
}

async function finish(c: Ctx, solBefore: bigint) {
  const solAfter = await solBalance(c.deployer.address);
  const vault = (await fetchVault(rpc, c.pdas.vault)).data;
  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    cluster: "devnet",
    program: PROGRAM,
    accounts: {
      ...c.pdas,
      treasury: c.treasury,
      integrator: c.integrator,
      payoutEscrow: c.payoutEscrow,
    },
    sol: {
      before: fmtSol(solBefore),
      after: fmtSol(solAfter),
      spent: fmtSol(solBefore - solAfter),
    },
    vault: {
      totalAssets: fmtUsdc(vault.totalAssets),
      totalShares: vault.totalShares.toString(),
      openVaultCredits: fmtUsdc(vault.openVaultCredits),
      reserved: fmtUsdc(vault.totalReservedLiability),
    },
    oraoLatency: latencies,
    steps,
  };
  const path = `scripts/devnet/runs/${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
  writeJson(path, summary);

  console.log("\n=== summary ===");
  for (const s of steps) {
    const mark = s.result === "ok" ? "ok  " : s.result === "skipped" ? "skip" : "FAIL";
    console.log(
      `${mark} ${s.name}${s.link ? `  ${s.link}` : ""}${s.error ? `  ${s.error.split("\n")[0]}` : ""}`,
    );
  }
  for (const l of latencies)
    console.log(
      `ORAO ${l.ticket.slice(0, 8)}…: ${l.slots} slots, ${l.seconds ?? "?"} s (block time), ${l.wallClockSeconds.toFixed(1)} s polled`,
    );
  console.log(
    `vault ${summary.vault.totalAssets}, ${summary.vault.totalShares} shares — ${explorerAddress(c.pdas.vault)}`,
  );
  console.log(`SOL ${summary.sol.before} → ${summary.sol.after} (spent ${summary.sol.spent})`);
  console.log(`run written to ${path}`);
  const failed = steps.some((s) => s.result === "failed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
