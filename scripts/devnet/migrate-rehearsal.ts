// Rehearsal of `migrate_config` (Spec 08 §13.5.13) on a real version-1
// deployment, without touching it: scripts/devnet/migrate-rehearsal.sh
// starts a local solana-test-validator holding a clone of the live devnet
// deployment (its program and program data as deployed, its config, vault,
// queue, token accounts and share mint, devnet's feature set), then this
// script, against that local validator only:
//
//   1. reads the version-1 `Config` and `Vault` the live V1 binary wrote;
//   2. upgrades the clone in place to the current devnet build
//      (target/devnet/fade.so, the binary the live deployment would get),
//      the program data extended first, as a real upgrade of a populated
//      V1 deployment does;
//   3. checks an instruction reading `Config` fails before the migration;
//   4. sends `migrate_config` with RiskParams::SPEC's beacon fields, then
//      checks every byte of the old `Config` is kept, the six fields are
//      SPEC's in `params` and `pending.params`, `version` is 2,
//      `PAUSE_ROUNDS` added to the flags, the account rent-exempt at its
//      new size with the authority paying only what was missing, every
//      `Vault` field unchanged but `next_round_id` 0 → 1, and that a second
//      migration is refused;
//   5. checks every cloned `Integrator` reads the same bytes after the
//      upgrade and the migration, and `app_shares_accrued` (its old
//      reserved tail) 0;
//   6. runs the V1 council path (`set_pause_flags`) and the V1 direct path
//      on the migrated clone, through the new binary: a direct ticket
//      opened by the deployer's existing integrator and expired past
//      T_SETTLE, a deposit and a withdrawal of the deployer's existing LP
//      shares queued in one epoch, struck and claimed; and a beacon round on
//      the migrated vault: a lone ticket sponsored in its join, never
//      requested, expired, returned, its sponsorship reclaimed, the
//      integrator's share claimed. Each transaction checked to the unit
//      (scripts/devnet/beacon-checks.ts: the join from fade_math's rules,
//      the direct open and expiry, the strike's books and tokens) and the
//      `RoundExpired` event read as emitted; invariants 1 and 2 checked on
//      the whole clone at the end. ORAO does not fulfil on a local
//      validator, so a drawn round, and a direct ticket settled, are left
//      to the devnet (e2e.ts, and the keeper's beacon loop).
//
// Writes scripts/devnet/runs/migrate-rehearsal-<ISO timestamp>.json, every
// step with its result, whether the rehearsal passed or not; no key.
//
//   pnpm devnet:migrate-rehearsal
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createSolanaRpc,
  generateKeyPairSigner,
  getAddressDecoder,
  getBase58Decoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
} from "@solana-program/token";
import {
  INTEGRATOR_DISCRIMINATOR,
  ROUND_DISCRIMINATOR,
  ROUND_TICKET_DISCRIMINATOR,
  SPONSORSHIP_DISCRIMINATOR,
  findRoundVrfPda,
  RoundStatus,
  RoundTicketStatus,
  TICKET_DISCRIMINATOR,
  fetchConfig,
  fetchMaybeDepositRequest,
  fetchMaybeEpochRecord,
  fetchMaybeIntegrator,
  fetchMaybeWithdrawRequest,
  fetchQueue,
  fetchVault,
  findDepositQueueUsdcPda,
  findIntegratorPda,
  findPayableUsdcPda,
  findPayoutEscrowPda,
  findRoundTicketPda,
  findShareClaimsPda,
  findShareEscrowPda,
  findSponsorshipPda,
  findTicketPda,
  findVrfPayerPda,
  getClaimDepositInstructionAsync,
  getClaimSharesInstructionAsync,
  getClaimWithdrawInstructionAsync,
  getConfigDecoder,
  getExpireTicketInstructionAsync,
  getIntegratorDecoder,
  getIntegratorSize,
  getOpenTicketInstructionAsync,
  getPayoutTableDecoder,
  getRegisterPayoutTableInstruction,
  getRequestDepositInstructionAsync,
  getRequestWithdrawInstructionAsync,
  getRoundDecoder,
  getRoundTicketDecoder,
  getSetPauseFlagsInstructionAsync,
  getSponsorshipDecoder,
  getStrikeEpochInstructionAsync,
  getTicketDecoder,
  getTicketSize,
  getVaultDecoder,
  type OutcomeArgs,
  type Queue,
  type Round,
} from "../../clients/js/src/generated/fade/index.ts";
import {
  SLOT_HASHES_SYSVAR,
  findOraoNetworkStatePda,
  findPayoutTablePda,
  findRoundPda,
  getBeaconExpireInstructionAsync,
  getBeaconJoinInstructionAsync,
  getBeaconReclaimInstructionAsync,
  getBeaconReturnInstructionAsync,
  lonePaySponsorship,
  newRoundTerms,
  oraoNetworkState,
  resolveJoinRound,
  roundRequestAddress,
  type Held,
} from "../../clients/js/src/beacon/index.ts";
import {
  eventMismatches,
  expectExpireTicket,
  expectJoin,
  expectOpenTicket,
  expectReclaim,
  expectReturn,
  expectStrike,
  expectUnrequestedExpiry,
  invariantMismatches,
  roundExpiredEvent,
  usdcAmount,
  type Rents,
} from "./beacon-checks.ts";
import { checkMoved, snapshot } from "./beacon-observe.ts";
import {
  ACCOUNT_DID_NOT_DESERIALIZE,
  BEACON_FIELDS,
  NEW_BINARY,
  PAUSE_FLAGS_AT,
  V1_CONFIG_LEN,
  VERSION_AT,
  deployedIs,
  extendBy,
  migrateIx,
  migrationMismatches,
  programData,
  same,
} from "./migration.ts";
import {
  LIVE_PROGRAM,
  PROGRAM,
  RPC_URL,
  USDC,
  USDC_MINT,
  accountData,
  openExpiryAccounts,
  ata,
  currentSlot,
  fadePdas,
  fmtSol,
  fmtUsdc,
  loadDeployer,
  rentExempt,
  rpc,
  transactionMeta,
  send,
  simulate,
  sleep,
  tokenAmount,
  depositRequestPda,
  epochPda,
  withdrawRequestPda,
  writeJson,
  type Sent,
} from "./lib.ts";

const cfg = { programAddress: PROGRAM };
/** Every outcome pays something: the lone ticket's table. */
const ALWAYS_PAYS: OutcomeArgs[] = [
  { p: 500_000_000n, m: 15_000n },
  { p: 500_000_000n, m: 4_560n },
];

/** The live deployment's integrators, read from devnet (read-only) for the clone. */
async function liveIntegrators(devnet: ReturnType<typeof createSolanaRpc>): Promise<Address[]> {
  const res = (await devnet
    .getProgramAccounts(PROGRAM, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: getBase58Decoder().decode(Uint8Array.from(INTEGRATOR_DISCRIMINATOR)) as never,
            encoding: "base58",
          },
        },
      ],
    })
    .send()) as unknown as { pubkey: Address }[];
  return res.map((r) => r.pubkey);
}

/** Every account of `discriminator` the live deployment still holds, read from devnet (read-only). */
async function liveAccountsOf(
  devnet: ReturnType<typeof createSolanaRpc>,
  discriminator: Uint8Array,
): Promise<Address[]> {
  const res = (await devnet
    .getProgramAccounts(PROGRAM, {
      encoding: "base64",
      commitment: "confirmed",
      dataSlice: { offset: 0, length: 0 },
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: getBase58Decoder().decode(discriminator) as never,
            encoding: "base58",
          },
        },
      ],
    })
    .send()) as unknown as { pubkey: Address }[];
  return res.map((r) => r.pubkey);
}

/**
 * The beacon's live accounts, for the clone: every `Round` still open (the
 * accepting one included), its `round_vrf`, and every `RoundTicket` and
 * `Sponsorship`. Without them upgrade-live, run on the clone, has no live
 * round for the new binary to read, and fails on a Vault's accepting round
 * devnet still holds. Cloned if they still exist when the validator starts:
 * one may close in between, which upgrade-live then reports.
 */
async function liveRoundAccounts(devnet: ReturnType<typeof createSolanaRpc>): Promise<Address[]> {
  const rounds = await liveAccountsOf(devnet, Uint8Array.from(ROUND_DISCRIMINATOR));
  const vrfs = await Promise.all(
    rounds.map(async (round) => (await findRoundVrfPda({ round }, cfg))[0]),
  );
  return [
    ...rounds,
    ...vrfs,
    ...(await liveAccountsOf(devnet, Uint8Array.from(ROUND_TICKET_DISCRIMINATOR))),
    ...(await liveAccountsOf(devnet, Uint8Array.from(SPONSORSHIP_DISCRIMINATOR))),
  ];
}

/**
 * The accounts the local validator clones from devnet (read-only there):
 * the vault's, the queue's and the strike's token accounts and mints, every
 * live integrator, the protocol treasury, the deployer's USDC and LP
 * share accounts (the deployer's integrator's stored share account, and
 * the shares the rehearsal withdraws), and the beacon's live rounds with
 * their tickets, sponsorships and `round_vrf` (`liveRoundAccounts`).
 */
async function cloned() {
  const p = await fadePdas();
  const [escrow] = await findPayoutEscrowPda(cfg);
  const [networkState] = await findOraoNetworkStatePda();
  const [depositQueue] = await findDepositQueueUsdcPda(cfg);
  const [payable] = await findPayableUsdcPda(cfg);
  const [shareEscrow] = await findShareEscrowPda(cfg);
  const [shareClaims] = await findShareClaimsPda(cfg);
  const devnet = createSolanaRpc(DEVNET);
  const { value } = await devnet
    .getAccountInfo(p.config, { encoding: "base64", commitment: "confirmed" })
    .send();
  if (!value) throw new Error("the live config is unreadable");
  const config = new Uint8Array(getBase64Encoder().encode(value.data[0]));
  // Version-1 `Config`: discriminator, version, bump, vault-authority bump,
  // council, guardian, then the protocol treasury.
  const treasury = getAddressDecoder().decode(config.subarray(8 + 3 + 64, 8 + 3 + 96));
  const deployer = (await loadDeployer()).address;
  return {
    required: [
      p.config,
      p.vault,
      p.queue,
      p.vaultUsdc,
      p.shareMint,
      USDC_MINT,
      networkState,
      depositQueue,
      payable,
      shareEscrow,
      shareClaims,
      treasury,
      ...(await liveIntegrators(devnet)),
    ],
    optional: [
      escrow,
      await ata(deployer, USDC_MINT),
      await ata(deployer, p.shareMint),
      ...(await liveRoundAccounts(devnet)),
    ],
  };
}

/** Devnet, read in `accounts` mode only, to list what the clone holds. */
const DEVNET = "https://api.devnet.solana.com";

// --- run log -------------------------------------------------------------------------------

type Step = {
  name: string;
  result: "ok" | "failed";
  signature?: string;
  slot?: string;
  detail?: Record<string, unknown>;
  error?: string;
};
const steps: Step[] = [];
function record(name: string, sent: Sent | null, detail: Record<string, unknown> = {}) {
  steps.push({
    name,
    result: "ok",
    ...(sent ? { signature: sent.signature, slot: sent.slot.toString() } : {}),
    detail,
  });
}
function check(cond: boolean, what: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${what}`);
}
/** Runs a phase; a failure is recorded with its error and stops the rehearsal. */
async function phase(name: string, fn: () => Promise<void>): Promise<boolean> {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${name}: ${message}`);
    steps.push({ name, result: "failed", error: message });
    return false;
  }
}
// --- the upgrade ---------------------------------------------------------------------------

function solana(args: string[]) {
  return execFileSync("solana", [...args, "-u", RPC_URL, "-k", "keys/deployer.json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// --- a beacon round on the migrated vault --------------------------------------------------

async function beaconRound(deployer: Awaited<ReturnType<typeof loadDeployer>>) {
  const p = await fadePdas();
  const [eventAuthority] = await getProgramDerivedAddress({
    programAddress: PROGRAM,
    seeds: ["__event_authority"],
  });
  const common = { eventAuthority, program: PROGRAM };
  const [table] = await findPayoutTablePda(ALWAYS_PAYS, cfg);
  record(
    "6. register_payout_table",
    await send(
      deployer,
      [
        getRegisterPayoutTableInstruction(
          { payer: deployer, payoutTable: table, ...common, outcomes: ALWAYS_PAYS },
          cfg,
        ),
      ],
      "register_payout_table",
    ),
  );

  // A fresh integrator (its share account) and payer; the deployer funds the price.
  const integrator = await generateKeyPairSigner();
  const payer = await generateKeyPairSigner();
  const ataOf = async (owner: Address) =>
    (
      await findAssociatedTokenPda({ owner, mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    )[0];
  const deployerUsdc = await ataOf(deployer.address);
  const setupIxs: Instruction[] = [
    getTransferSolInstruction({
      source: deployer,
      destination: payer.address,
      amount: 50_000_000n,
    }),
    getTransferSolInstruction({
      source: deployer,
      destination: integrator.address,
      amount: 5_000_000n,
    }),
  ];
  for (const owner of [deployer.address, integrator.address, payer.address])
    setupIxs.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: deployer,
        owner,
        mint: USDC_MINT,
      }),
    );
  setupIxs.push(
    getMintToInstruction({
      mint: USDC_MINT,
      token: deployerUsdc,
      mintAuthority: deployer,
      amount: 10n * USDC,
    }),
  );
  await send(deployer, setupIxs, "fund the round's wallets");

  // The lone join, its sponsorship paying its round at once.
  const vault = (await fetchVault(rpc, p.vault)).data;
  check(vault.nextRoundId === 1n && vault.acceptingRound === 0n, "the migrated vault's round ids");
  const slot = await currentSlot();
  const target = await resolveJoinRound(vault, null, slot, cfg);
  check(target.creates && target.landsIn === 1n, "the first join creates round 1");
  const params = (await fetchConfig(rpc, p.config)).data.params;
  const [networkState] = await findOraoNetworkStatePda();
  const network = await accountData(networkState);
  if (!network) throw new Error("ORAO network state not cloned");
  const { fee } = oraoNetworkState(network);
  const pendingRent = await rentExempt(749);
  const rents: Rents = {
    round: await rentExempt(411),
    ticket: await rentExempt(291),
    sponsorship: await rentExempt(58),
    integrator: await rentExempt(getIntegratorSize()),
  };
  const price = params.beaconMinPrice;
  const sponsorship = lonePaySponsorship(
    target,
    null,
    price,
    newRoundTerms(params, fee, pendingRent),
  );
  const shareAccount = await ataOf(integrator.address);
  const [integratorAccount] = await findIntegratorPda(
    { integratorAuthority: integrator.address },
    cfg,
  );
  const [ticketAddress] = await findRoundTicketPda(
    { integrator: integratorAccount, nonce: 0n },
    cfg,
  );
  const [roundAddress] = await findRoundPda(1n, cfg);
  const [recordAddress] = await findSponsorshipPda(
    { round: roundAddress, sponsor: payer.address },
    cfg,
  );
  const beneficiary = await ataOf(payer.address);
  const tableData = await accountData(table);
  if (!tableData) throw new Error("payout table not registered");
  const before = await snapshot([
    deployer.address,
    payer.address,
    deployerUsdc,
    p.vault,
    p.vaultUsdc,
    target.round,
    target.nextRound,
    integratorAccount,
    ticketAddress,
    beneficiary,
    recordAddress,
    networkState,
  ]);
  const join = await send(
    deployer,
    [
      await getBeaconJoinInstructionAsync(
        {
          integratorAuthority: integrator,
          payer,
          funder: deployer,
          funderUsdc: deployerUsdc,
          shareAccount,
          beneficiary,
          payoutTable: table,
          usdcMint: USDC_MINT,
          price,
          appShareBps: 30,
          nonce: 0n,
          sponsorship,
        },
        target,
        cfg,
      ),
    ],
    "join_round (lone, sponsored)",
  );
  // The price, prepay, sponsorship, rents, credit, reservation, held shares,
  // counters and every stored field, from fade_math's rules on the state
  // before (beacon-checks.ts `expectJoin`): to the unit.
  const { expected: joined } = await checkMoved(
    deployer.address,
    p.vault,
    "join_round",
    join,
    before,
    (f, tx) =>
      expectJoin(
        {
          program: PROGRAM,
          params,
          oraoFee: fee,
          pendingRent,
          rents,
          vault: p.vault,
          vaultUsdc: p.vaultUsdc,
          rounds: { accepting: null, next: roundAddress },
          integrator: integratorAccount,
          integratorAuthority: integrator.address,
          shareAccount,
          ticket: ticketAddress,
          sponsorshipRecord: recordAddress,
          table: { address: table, data: getPayoutTableDecoder().decode(tableData) },
          payer: payer.address,
          funder: deployer.address,
          funderUsdc: deployerUsdc,
          beneficiary,
          mint: USDC_MINT,
          feePayer: deployer.address,
          price,
          appShareBps: 30n,
          nonce: 0n,
          sponsorship,
          before: before.state,
        },
        f,
        { slot: tx.slot, now: tx.blockTime },
      ),
    [integratorAccount],
  );
  const readRound = async (): Promise<Held<Round>> => {
    const d = await accountData(roundAddress);
    if (!d) throw new Error("round 1 gone");
    return { address: roundAddress, data: getRoundDecoder().decode(d) };
  };
  let r = await readRound();
  check(r.data.status === RoundStatus.Paid && r.data.tickets === 1, "paid by its own sponsorship");
  check(joined.becamePaid, "the prediction has the join pay its round");
  record("6. join_round (lone, sponsored)", join, {
    round: "1",
    price: fmtUsdc(price),
    sponsorship: fmtSol(sponsorship),
    prepay: fmtSol(joined.prepay),
    liability: fmtUsdc(joined.admitted.liability),
    closeSlot: r.data.closeSlot.toString(),
    checkedToTheUnit: true,
  });

  // Never requested: past T_SETTLE it is forfeited.
  const expiry = r.data.closeSlot + r.data.tSettleSlots + 1n;
  for (let s = await currentSlot(); s < expiry; s = await currentSlot()) await sleep(1_000);
  const hashes = await accountData(SLOT_HASHES_SYSVAR);
  if (!hashes) throw new Error("SlotHashes unreadable");
  const named = await roundRequestAddress(r, hashes, cfg);
  const b1 = await snapshot([deployer.address, r.address, p.vault, p.vaultUsdc]);
  const expired = await send(
    deployer,
    [
      await getBeaconExpireInstructionAsync(
        deployer,
        r,
        await currentSlot(),
        hashes,
        named ? await readAccountRead(named.request) : null,
        cfg,
      ),
    ],
    "expire_round",
  );
  const { expected, tx } = await checkMoved(
    deployer.address,
    p.vault,
    "expire_round",
    expired,
    b1,
    (f) =>
      expectUnrequestedExpiry({
        program: PROGRAM,
        round: r,
        vault: p.vault,
        mint: USDC_MINT,
        caller: deployer.address,
        fee: f,
        before: b1.state,
      }),
  );
  const event = roundExpiredEvent(tx, PROGRAM, eventAuthority);
  const wrong = eventMismatches(expected.event, event);
  check(wrong.length === 0, `RoundExpired: ${wrong.join(", ")}`);
  record("6. expire_round", expired, {
    requested: event.requested,
    requestFound: event.requestFound,
    checked: event.checked,
    tickets: event.tickets,
    forfeited: fmtUsdc(event.forfeited),
    booksCheckedToTheUnit: true,
  });

  // The ticket returned, the sponsorship reclaimed: each checked to the unit.
  r = await readRound();
  const td = await accountData(ticketAddress);
  if (!td) throw new Error("ticket gone");
  const ticket = { address: ticketAddress, data: getRoundTicketDecoder().decode(td) };
  check(ticket.data.status === RoundTicketStatus.Joined, "the ticket is joined");
  const b2 = await snapshot([
    deployer.address,
    r.address,
    ticket.address,
    ticket.data.payer,
    ticket.data.refundTo,
    ticket.data.integrator,
    r.data.rentPayer,
    p.vault,
    p.vaultUsdc,
  ]);
  const returned = await send(
    deployer,
    [await getBeaconReturnInstructionAsync(deployer, r, ticket, USDC_MINT, cfg)],
    "return_round_ticket",
  );
  await checkMoved(
    deployer.address,
    p.vault,
    "return_round_ticket",
    returned,
    b2,
    (f) =>
      expectReturn({
        round: r,
        ticket,
        vaultUsdc: p.vaultUsdc,
        mint: USDC_MINT,
        caller: deployer.address,
        fee: f,
        before: b2.state,
      }),
    [ticket.data.integrator],
  );
  record("6. return_round_ticket", returned, { checkedToTheUnit: true });

  r = await readRound();
  const rd = await accountData(recordAddress);
  if (!rd) throw new Error("no sponsorship record");
  const sponsorshipRecord = { address: recordAddress, data: getSponsorshipDecoder().decode(rd) };
  const b3 = await snapshot([
    deployer.address,
    r.address,
    recordAddress,
    payer.address,
    r.data.rentPayer,
    p.vault,
  ]);
  const reclaimed = await send(
    deployer,
    [await getBeaconReclaimInstructionAsync(deployer, r, sponsorshipRecord, cfg)],
    "reclaim_sponsorship",
  );
  const { expected: rec } = await checkMoved(
    deployer.address,
    p.vault,
    "reclaim_sponsorship",
    reclaimed,
    b3,
    (f) =>
      expectReclaim({
        round: r,
        sponsorship: {
          address: recordAddress,
          sponsor: payer.address,
          amount: sponsorshipRecord.data.amount,
        },
        mint: USDC_MINT,
        caller: deployer.address,
        fee: f,
        before: b3.state,
      }),
  );
  check((await accountData(roundAddress)) === null, "the round closed with its last record");
  record("6. reclaim_sponsorship", reclaimed, {
    sponsorReturn: fmtSol(rec.returned),
    checkedToTheUnit: true,
  });

  // The forfeited ticket's app share, claimed to the integrator's share account.
  const owed = await fetchMaybeIntegrator(rpc, integratorAccount);
  check(owed.exists && owed.data.appSharesAccrued > 0n, "the forfeiture accrued the app share");
  const usdcBefore = (await tokenAmount(shareAccount)) ?? 0n;
  const claimed = await send(
    deployer,
    [
      await getClaimSharesInstructionAsync(
        {
          caller: deployer,
          integrator: integratorAccount,
          destination: shareAccount,
          usdcMint: USDC_MINT,
          ...common,
        },
        cfg,
      ),
    ],
    "claim_shares (integrator)",
  );
  const usdcAfter = (await tokenAmount(shareAccount)) ?? 0n;
  check(usdcAfter - usdcBefore === owed.data.appSharesAccrued, "the share claimed to the unit");
  record("6. claim_shares (integrator)", claimed, { amount: fmtUsdc(owed.data.appSharesAccrued) });
}

// --- the V1 direct path on the migrated clone ---------------------------------------------

/** The live V1 run's coin flip (scripts/devnet/e2e.ts): a direct ticket's payout table. */
const COIN_FLIP: OutcomeArgs[] = [
  { p: 500_000_000n, m: 19_560n },
  { p: 500_000_000n, m: 0n },
];

type Direct = { ticket: Address; vrfPayer: Address; expirySlot: bigint };

/**
 * `open_ticket` by the deployer's integrator as the live V1 binary created
 * it, through the new binary: every token and lamport delta, the vault's
 * books and counters, the integrator's books and the ticket's admission
 * snapshot predicted from the state before (`expectOpenTicket`).
 */
async function openDirect(deployer: Awaited<ReturnType<typeof loadDeployer>>): Promise<Direct> {
  const p = await fadePdas();
  const config = (await fetchConfig(rpc, p.config)).data;
  const params = config.params;
  const integrator = await integratorPdaOf(deployer.address);
  const existing = await fetchMaybeIntegrator(rpc, integrator);
  check(existing.exists, "the deployer's integrator is in the clone, as V1 created it");
  const deployerUsdc = await ata(deployer.address, USDC_MINT);
  check(
    existing.data.shareAccount === deployerUsdc,
    "its stored share account is the deployer's USDC account",
  );
  const nonce = existing.data.nextNonce;
  const [ticket] = await findTicketPdaOf(integrator, nonce);
  const [vrfPayer] = await findVrfPayerPda({ ticket }, cfg);
  const [networkState] = await findOraoNetworkStatePda();
  const network = await accountData(networkState);
  if (!network) throw new Error("ORAO network state not cloned");
  const { fee: oraoFee } = oraoNetworkState(network);
  const price = 1n * USDC;
  const pendingRent = await rentExempt(749);
  const ticketRent = await rentExempt(getTicketSize());
  const integratorRent = await rentExempt(getIntegratorSize());
  const before = await snapshot([
    deployer.address,
    deployerUsdc,
    config.protocolTreasury,
    p.vault,
    p.vaultUsdc,
    integrator,
    ticket,
    vrfPayer,
    networkState,
  ]);
  const sent = await send(
    deployer,
    [
      await getOpenTicketInstructionAsync(
        {
          integratorAuthority: deployer,
          payer: deployer,
          funder: deployer,
          funderUsdc: deployerUsdc,
          shareAccount: deployerUsdc,
          protocolTreasury: config.protocolTreasury,
          beneficiary: deployerUsdc,
          usdcMint: USDC_MINT,
          eventAuthority: p.eventAuthority,
          program: PROGRAM,
          price,
          payoutTable: COIN_FLIP,
          appShareBps: 30n,
          nonce,
        },
        cfg,
      ),
    ],
    "open_ticket",
  );
  const { expected } = await checkMoved(
    deployer.address,
    p.vault,
    "open_ticket",
    sent,
    before,
    (f, tx) =>
      expectOpenTicket(
        {
          program: PROGRAM,
          params,
          outcomes: COIN_FLIP.map((o) => ({ p: BigInt(o.p), m: BigInt(o.m) })),
          price,
          appShareBps: 30n,
          nonce,
          oraoFee,
          pendingRent,
          ticketRent,
          integratorRent,
          vault: p.vault,
          vaultUsdc: p.vaultUsdc,
          integrator,
          shareAccount: deployerUsdc,
          protocolTreasury: config.protocolTreasury,
          funderUsdc: deployerUsdc,
          payer: deployer.address,
          ticket,
          vrfPayer,
          beneficiary: deployerUsdc,
          mint: USDC_MINT,
          feePayer: deployer.address,
          before: before.state,
        },
        f,
        { slot: tx.slot, now: tx.blockTime },
      ),
    [integrator],
  );
  const t = getTicketDecoder().decode((await accountData(ticket))!);
  record("6. open_ticket (V1 direct path, the deployer's V1 integrator)", sent, {
    ticket,
    nonce: nonce.toString(),
    price: fmtUsdc(price),
    vaultCredit: fmtUsdc(expected.admitted.vaultCredit),
    liability: fmtUsdc(expected.admitted.liability),
    cap: fmtUsdc(expected.admitted.cap),
    expirySlot: t.expirySlot.toString(),
    checkedToTheUnit: true,
  });
  return { ticket, vrfPayer, expirySlot: t.expirySlot };
}

/** `expire_ticket` past T_SETTLE, never requested: `expectExpireTicket`, to the unit. */
async function expireDirect(deployer: Awaited<ReturnType<typeof loadDeployer>>, d: Direct) {
  const p = await fadePdas();
  for (let s = await currentSlot(); s <= d.expirySlot; s = await currentSlot()) await sleep(1_000);
  const t = getTicketDecoder().decode((await accountData(d.ticket))!);
  // Never requested: its seed recorded, and the request address derived from it named.
  const open = await openExpiryAccounts(d.ticket, t, PROGRAM);
  if (!open) throw new Error("the direct ticket's seed can no longer be derived");
  const before = await snapshot([deployer.address, p.vault, d.ticket, d.vrfPayer, t.integrator]);
  const sent = await send(
    deployer,
    [
      ...(open.record ? [open.record] : []),
      await getExpireTicketInstructionAsync(
        {
          caller: deployer,
          integrator: t.integrator,
          ticket: d.ticket,
          randomness: open.randomness,
          payer: t.payer,
          eventAuthority: p.eventAuthority,
          program: PROGRAM,
        },
        cfg,
      ),
    ],
    "expire_ticket",
  );
  await checkMoved(
    deployer.address,
    p.vault,
    "expire_ticket",
    sent,
    before,
    (f) =>
      expectExpireTicket({
        program: PROGRAM,
        vault: p.vault,
        ticket: d.ticket,
        vrfPayer: d.vrfPayer,
        mint: USDC_MINT,
        caller: deployer.address,
        fee: f,
        before: before.state,
      }),
    [t.integrator],
  );
  record("6. expire_ticket (V1 direct path)", sent, {
    ticket: d.ticket,
    forfeitedToVault: fmtUsdc(t.vaultCredit),
    checkedToTheUnit: true,
  });
}

async function chainNow(): Promise<bigint> {
  const t = await rpc.getBlockTime(await currentSlot()).send();
  return t === null ? BigInt(Math.floor(Date.now() / 1000)) : BigInt(t);
}

function joiningEpochId(q: Queue, now: bigint): bigint {
  if (!q.current.live) return q.nextEpochId;
  if (now < q.current.closeTs) return q.current.epochId;
  return q.next.live ? q.next.epochId : q.nextEpochId;
}

/**
 * A deposit and a withdrawal of the deployer's existing LP shares (cloned)
 * queued in one epoch, the strike, and both claims, through the new binary:
 * each request's tokens and the epoch's totals, the counters rolled by the
 * request that opens the epoch; the strike's books and tokens
 * (`expectStrike`); each claim the whole of what the strike gave its only
 * request.
 */
async function depositAndWithdraw(deployer: Awaited<ReturnType<typeof loadDeployer>>) {
  const p = await fadePdas();
  const common = { eventAuthority: p.eventAuthority, program: PROGRAM };
  const deployerUsdc = await ata(deployer.address, USDC_MINT);
  const deployerShares = await ata(deployer.address, p.shareMint);
  const lpShares = (await tokenAmount(deployerShares)) ?? 0n;
  const params = (await fetchConfig(rpc, p.config)).data.params;
  check(lpShares >= params.minWithdrawShares, "the deployer's LP shares are in the clone");
  const amount = 10n * USDC;
  const shares = params.minWithdrawShares;
  const q = (await fetchQueue(rpc, p.queue)).data;
  check(!q.current.live && !q.next.live, "no epoch live in the clone");
  const epochId = joiningEpochId(q, await chainNow());
  const vaultBefore = (await fetchVault(rpc, p.vault)).data;
  const [depositQueue] = await findDepositQueueUsdcPda(cfg);
  const [shareEscrow] = await findShareEscrowPda(cfg);
  const usdcBefore = (await tokenAmount(deployerUsdc)) ?? 0n;
  const queueBefore = (await tokenAmount(depositQueue)) ?? 0n;
  const dep = await depositRequestPda(epochId, deployer.address);
  const sentDeposit = await send(
    deployer,
    [
      await getRequestDepositInstructionAsync(
        {
          owner: deployer,
          ownerUsdc: deployerUsdc,
          usdcMint: USDC_MINT,
          request: dep,
          ...common,
          amount,
        },
        cfg,
      ),
    ],
    "request_deposit",
  );
  const q1 = (await fetchQueue(rpc, p.queue)).data;
  const v1 = (await fetchVault(rpc, p.vault)).data;
  check(q1.current.live && q1.current.epochId === epochId, "the deposit opened the epoch");
  check(q1.current.deposits === amount, "the epoch counts the deposit, to the unit");
  check((await tokenAmount(deployerUsdc)) === usdcBefore - amount, "the owner paid the deposit");
  check((await tokenAmount(depositQueue)) === queueBefore + amount, "the deposit is queued");
  // Opening the epoch rolls the counters (Spec 08 §4 rules 1 and 6).
  check(v1.generation === vaultBefore.generation + 1, "a new generation");
  check(v1.closeTs === q1.current.closeTs, "the vault holds the live close");
  check(
    v1.openBeforeClose === vaultBefore.openBeforeClose + vaultBefore.openAfterClose &&
      v1.openAfterClose === 0,
    "after moved into before",
  );
  check(v1.afterCloseGain === 0n && v1.afterCloseLoss === 0n, "after-close results cleared");
  check(v1.totalAssets === vaultBefore.totalAssets, "a request moves no asset");
  record("6. request_deposit (V1)", sentDeposit, {
    epochId: epochId.toString(),
    amount: fmtUsdc(amount),
    closeTs: q1.current.closeTs.toString(),
    checkedToTheUnit: true,
  });

  const escrowBefore = (await tokenAmount(shareEscrow)) ?? 0n;
  const wd = await withdrawRequestPda(epochId, deployer.address);
  const sentWithdraw = await send(
    deployer,
    [
      await getRequestWithdrawInstructionAsync(
        {
          owner: deployer,
          ownerShares: deployerShares,
          usdcMint: USDC_MINT,
          request: wd,
          ...common,
          shares,
        },
        cfg,
      ),
    ],
    "request_withdraw",
  );
  const q2 = (await fetchQueue(rpc, p.queue)).data;
  check(q2.current.withdrawShares === shares, "the epoch counts the withdrawal, to the share");
  check((await tokenAmount(deployerShares)) === lpShares - shares, "the owner's shares escrowed");
  check((await tokenAmount(shareEscrow)) === escrowBefore + shares, "the escrow holds them");
  record("6. request_withdraw (V1, the deployer's existing LP shares)", sentWithdraw, {
    epochId: epochId.toString(),
    shares: shares.toString(),
    checkedToTheUnit: true,
  });

  // The strike once the epoch has closed.
  for (let now = await chainNow(); now < q2.current.closeTs; now = await chainNow()) {
    console.log(`    waiting ${q2.current.closeTs - now} s for the epoch close`);
    await sleep(Math.min(Number(q2.current.closeTs - now), 15) * 1000 + 1000);
  }
  const [payable] = await findPayableUsdcPda(cfg);
  const [shareClaims] = await findShareClaimsPda(cfg);
  const record_ = await epochPda(epochId);
  const before = await snapshot([
    p.vault,
    p.vaultUsdc,
    depositQueue,
    payable,
    p.shareMint,
    shareClaims,
    shareEscrow,
  ]);
  let struck: Sent | null = null;
  for (let attempt = 0; attempt < 8 && !struck; attempt++) {
    try {
      struck = await send(
        deployer,
        [
          await getStrikeEpochInstructionAsync(
            { caller: deployer, record: record_, usdcMint: USDC_MINT, ...common },
            cfg,
          ),
        ],
        `strike_epoch ${epochId}`,
      );
    } catch (e) {
      if (attempt >= 7) throw e;
      console.log("    the clock is not past the close yet, retrying");
      await sleep(3_000);
    }
  }
  if (!struck) throw new Error("no strike");
  const { expected: k } = await checkMoved(
    deployer.address,
    p.vault,
    "strike_epoch",
    struck,
    before,
    () =>
      expectStrike({
        params,
        current: { deposits: q2.current.deposits, withdrawShares: q2.current.withdrawShares },
        nextLive: q2.next.live,
        vault: p.vault,
        vaultUsdc: p.vaultUsdc,
        depositQueue,
        payable,
        shareMint: p.shareMint,
        shareClaims,
        shareEscrow,
        mint: USDC_MINT,
        before: before.state,
      }),
  );
  record("6. strike_epoch (V1)", struck, {
    epochId: epochId.toString(),
    deposits: fmtUsdc(q2.current.deposits),
    sharesMinted: k.minted.toString(),
    sharesBurnt: k.burnt.toString(),
    assetsPaid: fmtUsdc(k.paid),
    checkedToTheUnit: true,
  });

  // Each claim: the whole of what the strike gave its only request.
  const epochRecord = await fetchMaybeEpochRecord(rpc, record_);
  const rentReceiver = epochRecord.exists ? { rentReceiver: epochRecord.data.rentPayer } : {};
  const sharesBefore = (await tokenAmount(deployerShares)) ?? 0n;
  const claimedDeposit = await send(
    deployer,
    [
      await getClaimDepositInstructionAsync(
        {
          caller: deployer,
          request: dep,
          owner: deployer.address,
          record: record_,
          ownerShares: deployerShares,
          ...rentReceiver,
          ...common,
        },
        cfg,
      ),
    ],
    "claim_deposit",
  );
  check(
    (await tokenAmount(deployerShares)) === sharesBefore + k.minted,
    "the depositor received every share minted",
  );
  check(!(await fetchMaybeDepositRequest(rpc, dep)).exists, "the deposit request closed");
  record("6. claim_deposit (V1)", claimedDeposit, {
    shares: k.minted.toString(),
    checkedToTheUnit: true,
  });
  const usdcBeforeClaim = (await tokenAmount(deployerUsdc)) ?? 0n;
  const claimedWithdraw = await send(
    deployer,
    [
      await getClaimWithdrawInstructionAsync(
        {
          caller: deployer,
          request: wd,
          owner: deployer.address,
          atRecord: record_,
          ownerUsdc: deployerUsdc,
          usdcMint: USDC_MINT,
          ...((await fetchMaybeEpochRecord(rpc, record_)).exists
            ? { rentReceiver: epochRecord.exists ? epochRecord.data.rentPayer : deployer.address }
            : {}),
          ...common,
        },
        cfg,
      ),
    ],
    "claim_withdraw",
  );
  check(
    (await tokenAmount(deployerUsdc)) === usdcBeforeClaim + k.paid,
    "the withdrawer received every unit the strike paid",
  );
  check(!(await fetchMaybeWithdrawRequest(rpc, wd)).exists, "the withdrawal request closed");
  record("6. claim_withdraw (V1)", claimedWithdraw, {
    usdc: fmtUsdc(k.paid),
    checkedToTheUnit: true,
  });
}

/** Every account of this program of `size` bytes and `discriminator`, on the local clone. */
async function programAccounts<T>(
  size: number,
  discriminator: ArrayLike<number>,
  decode: (d: Uint8Array) => T,
): Promise<{ address: Address; data: T }[]> {
  const res = (await rpc
    .getProgramAccounts(PROGRAM, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: BigInt(size) },
        {
          memcmp: {
            offset: 0n,
            bytes: getBase58Decoder().decode(Uint8Array.from(discriminator)) as never,
            encoding: "base58",
          },
        },
      ],
    })
    .send()) as unknown as { pubkey: Address; account: { data: readonly [string, string] } }[];
  return res.map((a) => ({
    address: a.pubkey,
    data: decode(new Uint8Array(getBase64Encoder().encode(a.account.data[0]))),
  }));
}

/** Invariants 1 and 2 of Spec 08 §13.8 on the whole migrated clone. */
async function invariants() {
  const p = await fadePdas();
  const [escrow] = await findPayoutEscrowPda(cfg);
  const [vault, rounds, tickets, direct, integrators] = await Promise.all([
    fetchVault(rpc, p.vault),
    programAccounts(411, ROUND_DISCRIMINATOR, (d) => getRoundDecoder().decode(d)),
    programAccounts(291, ROUND_TICKET_DISCRIMINATOR, (d) => getRoundTicketDecoder().decode(d)),
    programAccounts(getTicketSize(), TICKET_DISCRIMINATOR, (d) => getTicketDecoder().decode(d)),
    programAccounts(getIntegratorSize(), INTEGRATOR_DISCRIMINATOR, (d) =>
      getIntegratorDecoder().decode(d),
    ),
  ]);
  const tokens = await snapshot([p.vaultUsdc, escrow]);
  const wrong = invariantMismatches({
    vault: vault.data,
    vaultUsdc: usdcAmount(tokens.state, p.vaultUsdc, USDC_MINT),
    payoutEscrow: usdcAmount(tokens.state, escrow, USDC_MINT),
    rounds: rounds.map((r) => r.data),
    tickets: tickets.map((t) => t.data),
    roundStatus: new Map(rounds.map((r) => [r.data.id, r.data.status])),
    direct: direct.map((t) => t.data),
    integrators: integrators.map((i) => ({ address: i.address, ...i.data })),
  });
  check(wrong.length === 0, `invariants 1-2: ${wrong.join("; ")}`);
  record("7. invariants 1 and 2 on the migrated clone", null, {
    rounds: rounds.length,
    roundTickets: tickets.length,
    directTickets: direct.length,
    integrators: integrators.length,
    vaultUsdc: fmtUsdc(usdcAmount(tokens.state, p.vaultUsdc, USDC_MINT)),
    totalAssets: fmtUsdc(vault.data.totalAssets),
  });
}

const integratorPdaOf = async (authority: Address) =>
  (await findIntegratorPda({ integratorAuthority: authority }, cfg))[0];
const findTicketPdaOf = (integrator: Address, nonce: bigint) =>
  findTicketPda({ integrator, nonce }, cfg);

async function readAccountRead(address: Address) {
  const { value } = await rpc
    .getAccountInfo(address, { encoding: "base64", commitment: "confirmed" })
    .send();
  if (!value) return null;
  const data = await accountData(address);
  return data ? { address, owner: value.owner, data } : null;
}

// --- main ----------------------------------------------------------------------------------

/**
 * The local validator's rent is the default one (`Rent::default()`, 6 960
 * lamports a byte with the 128-byte overhead), devnet's is lower (5 080 a
 * byte, exemption threshold 1): every account cloned from devnet is
 * rent-exempt there and short of it here, which Anchor's `init_if_needed`
 * refuses (`ConstraintRentExempt`) on an existing integrator. That is the
 * local cluster's difference, not the upgrade's: the deployer tops each
 * cloned account up to the local minimum first, and the log records it.
 */
async function localRent(deployer: Awaited<ReturnType<typeof loadDeployer>>) {
  const { required, optional } = await cloned();
  const topped: { account: Address; lamports: string }[] = [];
  const ixs: Instruction[] = [];
  for (const a of [...required, ...optional]) {
    const { value } = await rpc
      .getAccountInfo(a, { encoding: "base64", commitment: "confirmed" })
      .send();
    if (!value) continue;
    const size = getBase64Encoder().encode(value.data[0]).length;
    const need = await rentExempt(size);
    if (value.lamports >= need) continue;
    const missing = need - value.lamports;
    ixs.push(getTransferSolInstruction({ source: deployer, destination: a, amount: missing }));
    topped.push({ account: a, lamports: missing.toString() });
  }
  for (let i = 0; i < ixs.length; i += 10)
    await send(deployer, ixs.slice(i, i + 10), "top up cloned accounts to the local rent");
  record(
    "0. cloned accounts topped up to the local validator's rent (an artifact of the local cluster)",
    null,
    {
      localRentPerByte: ((await rentExempt(1)) - (await rentExempt(0))).toString(),
      devnetRentPerByte: "5080",
      topped,
    },
  );
}

async function rehearse() {
  const deployer = await loadDeployer();
  const p = await fadePdas();
  await localRent(deployer);

  // 1. The version-1 state, as the live V1 binary wrote it.
  const v1 = await programData();
  check(v1.authority === deployer.address, "the deployer is the clone's upgrade authority");
  const oldConfig = await accountData(p.config);
  const oldVault = await accountData(p.vault);
  if (!oldConfig || !oldVault) throw new Error("config or vault not cloned");
  check(
    oldConfig.length === V1_CONFIG_LEN && oldConfig[VERSION_AT] === 1,
    "a version-1 Config (695 bytes)",
  );
  const configLamportsBefore = (await rpc.getBalance(p.config, { commitment: "confirmed" }).send())
    .value;
  // Every live integrator, as the V1 binary wrote it.
  const v1Integrators = await programAccounts(
    getIntegratorSize(),
    INTEGRATOR_DISCRIMINATOR,
    (d) => d,
  );
  check(v1Integrators.length > 0, "the live integrators are in the clone");
  record("1. version-1 state cloned from devnet", null, {
    integrators: v1Integrators.length,
    programSha256: v1.sha256,
    programBytes: v1.len,
    configBytes: oldConfig.length,
    configVersion: oldConfig[VERSION_AT],
    pauseFlags: oldConfig[PAUSE_FLAGS_AT],
    vaultBytes: oldVault.length,
  });

  // 2. The upgrade in place, as the live deployment gets it (upgrade-live.ts):
  // the program data extended by the same room first.
  const elf = new Uint8Array(readFileSync(NEW_BINARY));
  const room = extendBy(elf.length, v1.len);
  if (room > 0) solana(["program", "extend", PROGRAM, String(room)]);
  solana([
    "program",
    "deploy",
    NEW_BINARY,
    "--program-id",
    PROGRAM,
    "--upgrade-authority",
    "keys/deployer.json",
  ]);
  // The upgrade takes effect from the next slot.
  const upgradedAt = await currentSlot();
  for (let s = upgradedAt; s <= upgradedAt + 1n; s = await currentSlot()) await sleep(500);
  const v2 = await programData();
  check(deployedIs(v2.elf, elf), "the clone now runs the current devnet build");
  record("2. upgraded in place", null, {
    binarySha256: createHash("sha256").update(elf).digest("hex"),
    binaryBytes: elf.length,
    programDataBytes: v2.len,
    extendedBy: room,
  });

  // 3. Until the migration, every instruction that reads Config fails.
  const config1Flags = oldConfig[PAUSE_FLAGS_AT]!;
  const pauseIx = async (flags: number) =>
    getSetPauseFlagsInstructionAsync(
      {
        authority: deployer,
        pauseFlags: flags,
        integratorPaused: null,
        eventAuthority: p.eventAuthority,
        program: PROGRAM,
      },
      cfg,
    );
  const refused = await simulate(deployer, [await pauseIx(config1Flags)]);
  check(refused.code === ACCOUNT_DID_NOT_DESERIALIZE, "set_pause_flags refused before migrating");
  record("3. a version-1 Config is refused before the migration", null, {
    error: refused.code,
  });

  // 4. migrate_config.
  const deployerBefore = (
    await rpc.getBalance(deployer.address, { commitment: "confirmed" }).send()
  ).value;
  const migrated = await send(deployer, [await migrateIx(deployer.address)], "migrate_config");
  const newConfig = await accountData(p.config);
  const newVault = await accountData(p.vault);
  if (!newConfig || !newVault) throw new Error("config or vault gone");
  // Config 791 bytes, version 2, PAUSE_ROUNDS added, SPEC's six fields,
  // every version-1 byte kept; every Vault field kept but next_round_id 0 → 1.
  const wrong = migrationMismatches({ oldConfig, newConfig, oldVault, newVault });
  check(wrong.length === 0, `the migration: ${wrong.join("; ")}`);
  const config = getConfigDecoder().decode(newConfig);
  const rent = await rentExempt(791);
  const configLamports = (await rpc.getBalance(p.config, { commitment: "confirmed" }).send()).value;
  const lacking = rent > configLamportsBefore ? rent - configLamportsBefore : 0n;
  check(configLamports === configLamportsBefore + lacking, "the Config topped up to its rent");
  const deployerAfter = (await rpc.getBalance(deployer.address, { commitment: "confirmed" }).send())
    .value;
  const meta = await transactionMeta(migrated.signature);
  const fee = BigInt(meta?.meta?.fee ?? 0n);
  check(
    deployerBefore - deployerAfter === fee + lacking,
    "the authority paid the fee and the rent missing",
  );
  const vb = getVaultDecoder().decode(oldVault);
  const va = getVaultDecoder().decode(newVault);
  const again = await simulate(deployer, [await migrateIx(deployer.address)]);
  // A version-2 Config is not a version-1 one: `migrated_config_data` refuses it.
  check(again.code === ACCOUNT_DID_NOT_DESERIALIZE, "a second migration is refused");
  record("4. migrate_config", migrated, {
    configBytes: newConfig.length,
    version: config.version,
    pauseFlags: config.pauseFlags,
    beaconParams: Object.fromEntries(BEACON_FIELDS.map((k) => [k, config.params[k].toString()])),
    rentTopUp: lacking.toString(),
    nextRoundId: `${vb.nextRoundId} → ${va.nextRoundId}`,
    vaultTotalAssets: fmtUsdc(va.totalAssets),
    everyOtherByteKept: true,
    secondMigrationRefused: true,
  });

  // 5. Every cloned integrator reads the bytes the V1 binary wrote, its old
  // reserved tail now `app_shares_accrued`, which must be 0: an integrator
  // whose tail was not zero would be owed shares nothing paid in.
  const after = await programAccounts(getIntegratorSize(), INTEGRATOR_DISCRIMINATOR, (d) => d);
  check(after.length === v1Integrators.length, "every integrator still there");
  for (const i of v1Integrators) {
    const now = after.find((x) => x.address === i.address);
    check(now !== undefined && same(now.data, i.data), `integrator ${i.address}: bytes unchanged`);
    const d = getIntegratorDecoder().decode(now.data);
    check(d.appSharesAccrued === 0n, `integrator ${i.address}: app_shares_accrued reads 0`);
  }
  record("5. cloned integrators read through the new layout", null, {
    integrators: v1Integrators.map((i) => i.address),
    bytesUnchanged: true,
    appSharesAccrued: "0 for every one",
  });

  // 6. The V1 council path reads the new Config; rounds turned on; the V1
  // direct path and a beacon round on the migrated vault.
  const on = await send(deployer, [await pauseIx(config1Flags)], "set_pause_flags: rounds on");
  check(
    (await fetchConfig(rpc, p.config)).data.pauseFlags === config1Flags,
    "rounds on, the other flags as before",
  );
  record("6. set_pause_flags: rounds on", on, { pauseFlags: config1Flags });
  const direct = await openDirect(deployer);
  await beaconRound(deployer);
  await expireDirect(deployer, direct);
  await depositAndWithdraw(deployer);

  // 7. Invariants 1 and 2 on the whole clone.
  await invariants();
}

async function main() {
  if (process.argv[2] === "accounts") {
    const { required, optional } = await cloned();
    console.log(JSON.stringify({ program: PROGRAM, required, optional }));
    return;
  }
  // Against the local validator only: the live deployment is cloned, never named.
  const host = new URL(RPC_URL).hostname;
  if (host !== "127.0.0.1" && host !== "localhost")
    throw new Error(`migrate-rehearsal runs against a local validator only, not ${RPC_URL}`);
  const startedAt = new Date();
  // Every phase's result goes to the log, whether the rehearsal passes or not.
  const ok = await phase("rehearsal", rehearse);
  const path = `scripts/devnet/runs/migrate-rehearsal-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
  writeJson(path, {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    cluster: "local solana-test-validator, devnet's feature set, the live devnet deployment cloned",
    note: "signatures are the local validator's: no explorer link; devnet was only read",
    program: PROGRAM,
    newBinary: NEW_BINARY,
    result: ok ? "ok" : "failed",
    steps,
  });
  console.log(`\nrehearsal ${ok ? "ok" : "FAILED"}, run written to ${path}`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
