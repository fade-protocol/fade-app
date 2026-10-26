// The in-place upgrade of a version-1 deployment and its `migrate_config`
// (Spec 08 §13.5.13), shared by the rehearsal on a local clone
// (migrate-rehearsal.ts) and the live devnet run (upgrade-live.ts): the
// binary check, the program data's room, `migrate_config`'s instruction, and
// the checks of a migrated `Config` and `Vault`. `migrate_config` is a
// devnet-only instruction, absent from idls/fade.json and the generated
// client: it is encoded here by hand.
import { createHash } from "node:crypto";
import {
  AccountRole,
  getAddressDecoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  RoundStatus,
  TICKET_EXPIRED_EVENT_DISCRIMINATOR,
  getConfigDecoder,
  getRiskParamsDecoder,
  getRiskParamsEncoder,
  getVaultDecoder,
} from "../../clients/js/src/generated/fade/index.ts";
import { decodeTicketExpired } from "../../clients/js/src/direct/index.ts";
import { emittedEvents, type JsonTransaction } from "./beacon-checks.ts";
import { LOADER, PROGRAM, SYSTEM, accountData, bytes, fadePdas } from "./lib.ts";

/** The current devnet build: the binary the live deployment is upgraded to. */
export const NEW_BINARY = "target/devnet/fade.so";
/** Anchor's `AccountDidNotDeserialize`: a version-1 `Config` read by the current layout. */
export const ACCOUNT_DID_NOT_DESERIALIZE = 3003;
export const PAUSE_ROUNDS = 1 << 3;
/** A version-1 `Config`, discriminator included (programs/fade/src/instructions/migrate.rs). */
export const V1_CONFIG_LEN = 695;
/** A version-2 `Config`, discriminator included. */
export const V2_CONFIG_LEN = 791;
/** `Config.version`, right after the discriminator. */
export const VERSION_AT = 8;
/** `Config.pause_flags`: discriminator, version, two bumps, four keys. */
export const PAUSE_FLAGS_AT = 8 + 3 + 4 * 32;
/** RiskParams::SPEC's six beacon fields (programs/fade/src/state.rs), in `RiskParams` order. */
export const SPEC_BEACON = {
  beaconMinPrice: 500_000n,
  beaconThreshold: 8_640_000n,
  roundK: 1n,
  tickSlots: 37n,
  refundSlots: 1_715n,
  crankRoundSettleLamports: 20_000n,
};
export const BEACON_FIELDS = Object.keys(SPEC_BEACON) as (keyof typeof SPEC_BEACON)[];
/** The program's bounds on the beacon fields (programs/fade/src/constants.rs). */
const MAX_ROUND_K = 1n;
const MAX_TICK_SLOTS = 150n;
const MAX_REFUND_SLOTS = 20_000n;
/** What Anchor logs for `migrate_config`: carried by a devnet build only. */
export const MIGRATE_CONFIG_LOG = "Instruction: MigrateConfig";
/** What Anchor logs for `sweep_round_vrf` (Spec 08 §13.5.8a): carried by a build that has it. */
export const SWEEP_ROUND_VRF_LOG = "Instruction: SweepRoundVrf";
/** The instructions the audit fixes of 22 October 2026 added: a build without them is refused. */
export const AUDIT_FIX_LOGS = [
  "Instruction: RecordTicketEntropy",
  "Instruction: RefundExpiredTicket",
  "Instruction: SweepTicketVrf",
] as const;
/** `MIN_KAPPA_BPS` (programs/fade/src/constants.rs): the program refuses κ below it. */
export const MIN_KAPPA_BPS = 8_000n;
/**
 * `Vault.ticket_forfeits_withheld`, taken from the reserved tail: its 8 bytes at this offset
 * of the account (discriminator included), zero on a vault no build with it has written.
 */
export const TICKET_FORFEITS_WITHHELD_AT = 558;

// --- the binary and the program data -------------------------------------------------------

/** UpgradeableLoaderState::ProgramData: tag, slot, Option<authority>, then the program bytes. */
export const PROGRAM_DATA_HEADER = 45;
/** UpgradeableLoaderState::Buffer: tag, Option<authority>, then the program bytes. */
export const BUFFER_HEADER = 37;
/** Room left after the new binary when the program data is extended: a rebuild a few bytes larger still fits. */
export const EXTEND_MARGIN = 2_048;

/** UpgradeableLoaderState::Buffer under `deployer`, of exactly `elf`'s size, whatever its bytes. */
export function bufferFits(data: Uint8Array, elf: Uint8Array, deployer: Address): boolean {
  const authority = data[4] === 1 ? getAddressDecoder().decode(data.subarray(5, 37)) : null;
  return data[0] === 1 && authority === deployer && data.length === BUFFER_HEADER + elf.length;
}

/** UpgradeableLoaderState::Buffer under `deployer`, holding exactly `elf`. */
export function bufferHolds(data: Uint8Array, elf: Uint8Array, deployer: Address): boolean {
  return bufferFits(data, elf, deployer) && sha256(data.subarray(BUFFER_HEADER)) === sha256(elf);
}

/**
 * Whether `elf` carries `want`'s 32 bytes: the address the binary declares.
 * A mainnet build declares the mainnet address instead, and is refused.
 */
export function carries(elf: Uint8Array, want: Address): boolean {
  return Buffer.from(elf).indexOf(Buffer.from(bytes(want))) !== -1;
}

/** The bytes to extend a program data of `capacity` program bytes by for a binary of `size`: 0 when it fits. */
export function extendBy(size: number, capacity: number): number {
  return size <= capacity ? 0 : size - capacity + EXTEND_MARGIN;
}

/** Whether the deployed program bytes (`deployed`, the whole capacity) are `elf`, zero-filled after it. */
export function deployedIs(deployed: Uint8Array, elf: Uint8Array): boolean {
  if (deployed.length < elf.length) return false;
  for (let i = 0; i < elf.length; i++) if (deployed[i] !== elf[i]) return false;
  for (let i = elf.length; i < deployed.length; i++) if (deployed[i] !== 0) return false;
  return true;
}

/** Whether the binary carries `migrate_config` (a devnet build). */
export function carriesMigrateConfig(elf: Uint8Array): boolean {
  return Buffer.from(elf).indexOf(MIGRATE_CONFIG_LOG, 0, "latin1") !== -1;
}

/** Whether the binary carries every instruction of the audit fixes of 22 October 2026. */
export function carriesAuditFixes(elf: Uint8Array): boolean {
  return AUDIT_FIX_LOGS.every((log) => Buffer.from(elf).indexOf(log, 0, "latin1") !== -1);
}

/**
 * The override that reads a non-zero Vault tail as the counter under a binary without the
 * fixes: a binary with them ran, raised it, and was rolled back.
 */
export const VAULT_TAIL_IS_COUNTER = "--vault-tail-is-counter";

/**
 * The highest `ticket_forfeits_withheld` among the version-2 `TicketExpired` events `program`
 * emitted in a successful transaction, or null when it carries none. Every raise of the counter
 * emits one naming the new value, and only a binary with the audit fixes raises it (or emits a
 * version-2 event): the transaction of the last raise proves the Vault's tail is that counter.
 */
export function counterProofOrdinal(
  tx: JsonTransaction & { meta: { err?: unknown } | null },
  program: Address,
  eventAuthority: Address,
): bigint | null {
  if (!tx.meta || (tx.meta.err !== null && tx.meta.err !== undefined)) return null;
  let best: bigint | null = null;
  for (const body of emittedEvents(
    tx,
    program,
    eventAuthority,
    TICKET_EXPIRED_EVENT_DISCRIMINATOR,
  )) {
    let e: ReturnType<typeof decodeTicketExpired>;
    try {
      e = decodeTicketExpired(body);
    } catch {
      continue;
    }
    if (e.version === 2 && (best === null || e.ticketForfeitsWithheld > best))
      best = e.ticketForfeitsWithheld;
  }
  return best;
}

/**
 * What the audit fixes' new checks would refuse in a version-2 `Config` and `Vault` the
 * upgrade keeps (read-only, before anything is sent): κ below `MIN_KAPPA_BPS` in the live or
 * the pending parameters (`apply_params` now checks the pending ones again; the council
 * cancels such a change), in every mode; and, while the deployed binary predates the fixes
 * (`deployedCarriesFixes` false), a `Vault` whose new field's bytes are not zero. Once a binary
 * with the fixes runs, those bytes are `ticket_forfeits_withheld`, which it raises itself: a
 * resumed run, a verification or a later upgrade reads them as the counter, not as corruption.
 * After a rollback to a binary without the fixes, the bytes still hold that counter (the old
 * binary keeps them as reserved bytes): `counterProof`, the ordinal the last raise's
 * `TicketExpired` names (`counterProofOrdinal`, from `VAULT_TAIL_IS_COUNTER`), lets them through
 * when it equals them, and only then.
 */
export function auditFixRefusals(
  config: {
    params: { kappaBps: bigint };
    pending: { active: boolean; params: { kappaBps: bigint } };
  },
  vault: Uint8Array,
  deployedCarriesFixes: boolean,
  counterProof: bigint | null = null,
): string[] {
  const out: string[] = [];
  if (config.params.kappaBps < MIN_KAPPA_BPS)
    out.push(`κ is ${config.params.kappaBps} bps, below the program's floor ${MIN_KAPPA_BPS}`);
  if (config.pending.active && config.pending.params.kappaBps < MIN_KAPPA_BPS)
    out.push(
      `the pending change sets κ to ${config.pending.params.kappaBps} bps, below the floor: cancel it first`,
    );
  const tail = vault.subarray(TICKET_FORFEITS_WITHHELD_AT, TICKET_FORFEITS_WITHHELD_AT + 8);
  if (tail.length !== 8) out.push("the Vault is too short to hold ticket_forfeits_withheld");
  else if (!deployedCarriesFixes && tail.some((b) => b !== 0)) {
    const held = ticketForfeitsWithheld(vault)!;
    if (counterProof === null)
      out.push(
        `the Vault's bytes for ticket_forfeits_withheld are not zero (${held}): after a rollback from the audit fixes, name the transaction of the counter's last raise with ${VAULT_TAIL_IS_COUNTER} <signature>`,
      );
    else if (counterProof !== held)
      out.push(
        `the Vault's bytes for ticket_forfeits_withheld hold ${held}, but the TicketExpired named by ${VAULT_TAIL_IS_COUNTER} counts ${counterProof}: name the transaction of its last raise`,
      );
  }
  return out;
}

/** `Config::PAUSE_TICKETS`: no direct ticket opens while it is set. */
export const PAUSE_TICKETS = 1 << 0;
/** `Ticket.status` (0 Open, 1 Requested), after the discriminator, version, bump and vrf_payer bump. */
export const TICKET_STATUS_AT = 11;

/**
 * What an upgrade into the audit fixes refuses about the direct path (while the deployed
 * binary predates them): tickets not paused, or a direct ticket still Open or Requested. The
 * new binary expires an Open ticket only with its seed recorded and its request address
 * named, which the keeper running until the merge never sends: an Open ticket reaching its
 * expiry between the upgrade and the keeper's deploy could end only in the new keeper's
 * refund, a withheld ordinal. The drain is also what keeps that keeper's indexers from reading
 * a version-2 `TicketExpired`. `inFlight`: the addresses of the tickets still Open or Requested.
 */
export function directDrainRefusals(pauseFlags: number, inFlight: readonly string[]): string[] {
  const out: string[] = [];
  if ((pauseFlags & PAUSE_TICKETS) === 0)
    out.push(
      "PAUSE_TICKETS is not set: the guardian sets it before the upgrade (pnpm devnet:pause-tickets set --confirm)",
    );
  if (inFlight.length)
    out.push(
      `${inFlight.length} direct ticket(s) still Open or Requested (${inFlight.slice(0, 5).join(", ")}${inFlight.length > 5 ? ", …" : ""}): wait until the keeper has settled or expired them`,
    );
  return out;
}

/** `Vault.ticket_forfeits_withheld` as the reserved tail holds it, or null for a short vault. */
export function ticketForfeitsWithheld(vault: Uint8Array): bigint | null {
  const tail = vault.subarray(TICKET_FORFEITS_WITHHELD_AT, TICKET_FORFEITS_WITHHELD_AT + 8);
  if (tail.length !== 8) return null;
  return new DataView(tail.buffer, tail.byteOffset, 8).getBigUint64(0, true);
}

/** Whether the binary carries `sweep_round_vrf`: a build older than it is refused. */
export function carriesSweepRoundVrf(elf: Uint8Array): boolean {
  return Buffer.from(elf).indexOf(SWEEP_ROUND_VRF_LOG, 0, "latin1") !== -1;
}

/** Anchor's InstructionFallbackNotFound: a binary that does not know the instruction. */
export const INSTRUCTION_FALLBACK_NOT_FOUND = 101;
/** The runtime's answer for a program upgraded in the current slot: it runs from the next one. */
export const NOT_DEPLOYED_YET = "Program is not deployed";
/** FadeError::WrongRoundStatus: a `Requested` round read, and refused, by `sweep_round_vrf`. */
export const WRONG_ROUND_STATUS = 6058;

/**
 * Whether an answer (sent or simulated) came from a node that does not run
 * the new binary yet: the old binary refuses an instruction it does not know,
 * or the upgrade's slot has not passed there. Neither changes anything, so
 * asking again a slot later is safe.
 */
export function notYetUpgraded(answer: { code: number | null; logs: readonly string[] }): boolean {
  return (
    answer.code === INSTRUCTION_FALLBACK_NOT_FOUND ||
    answer.logs.some((l) => l.includes(NOT_DEPLOYED_YET))
  );
}

/**
 * Whether `sweep_round_vrf`'s simulated answer shows that the binary read a
 * live `Round`: success, or `WrongRoundStatus`, which it returns only for a
 * `Requested` round after deserialising it. `statuses` are the round's
 * statuses read before and after the simulation: a round requested between
 * the two reads is `Requested` in one of them, so the refusal is accepted
 * whichever side of the simulation the request landed on.
 */
export function sweepReadRound(
  sweep: { err: unknown; code: number | null },
  statuses: readonly (RoundStatus | null)[],
): boolean {
  return (
    sweep.err === null ||
    (sweep.code === WRONG_ROUND_STATUS && statuses.includes(RoundStatus.Requested))
  );
}

/** A full lowercase SHA-256 in hex, as `sha256` prints it. */
export const isSha256 = (s: string) => /^[0-9a-f]{64}$/.test(s);

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export async function programDataAddress(): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: LOADER, seeds: [bytes(PROGRAM)] }))[0];
}

/** The program data's upgrade authority, its program bytes (the whole capacity) and their SHA-256. */
export async function programData(): Promise<{
  authority: Address | null;
  elf: Uint8Array;
  sha256: string;
  len: number;
}> {
  const data = await accountData(await programDataAddress());
  if (!data) throw new Error("no program data");
  const authority = data[12] === 1 ? getAddressDecoder().decode(data.subarray(13, 45)) : null;
  const elf = data.subarray(PROGRAM_DATA_HEADER);
  return { authority, elf, sha256: sha256(elf), len: elf.length };
}

// --- migrate_config ------------------------------------------------------------------------

export async function migrateIx(authority: Address): Promise<Instruction> {
  const p = await fadePdas();
  const data = new Uint8Array(8 + 6 * 8);
  data.set(createHash("sha256").update("global:migrate_config").digest().subarray(0, 8), 0);
  const view = new DataView(data.buffer);
  BEACON_FIELDS.forEach((k, i) => view.setBigUint64(8 + i * 8, SPEC_BEACON[k], true));
  return {
    programAddress: PROGRAM,
    accounts: [
      { address: authority, role: AccountRole.WRITABLE_SIGNER },
      { address: PROGRAM, role: AccountRole.READONLY },
      { address: await programDataAddress(), role: AccountRole.READONLY },
      { address: p.config, role: AccountRole.WRITABLE },
      { address: p.vault, role: AccountRole.WRITABLE },
      { address: SYSTEM, role: AccountRole.READONLY },
    ],
    data,
  };
}

/**
 * The version-1 bytes a version-2 `Config` came from, by removing the six
 * beacon fields after each `RiskParams` and restoring the version and the
 * pause flags: computed from the generated layout, not the program's.
 */
export function backToV1(v2: Uint8Array, version: number, pauseFlags: number): Uint8Array {
  const paramsAt = PAUSE_FLAGS_AT + 1;
  const full = getRiskParamsEncoder().fixedSize;
  const v1Params = full - 48;
  const pendingParamsAt = paramsAt + full + 1 + 8;
  const out = new Uint8Array([
    ...v2.subarray(0, paramsAt + v1Params),
    ...v2.subarray(paramsAt + full, pendingParamsAt + v1Params),
    ...v2.subarray(pendingParamsAt + full),
  ]);
  out[VERSION_AT] = version;
  out[paramsAt - 1] = pauseFlags;
  return out;
}

/** Whether a version-1 `Config` holds a pending parameter change (`pending.active`). */
export function v1PendingActive(v1: Uint8Array): boolean {
  return v1[PAUSE_FLAGS_AT + 1 + getRiskParamsEncoder().fixedSize - 48] === 1;
}

/**
 * Why `migrate_config` with SPEC_BEACON would refuse this version-1 `Config`
 * (empty when it would not): the beacon fields `RiskParams::beacon_is_valid`
 * checks against the current `max_price` and `crank_settle_lamports`, and a
 * pending change, refused outright rather than carried into version 2. The
 * other fields passed the same checks when they were set.
 */
export function migrationRefusals(v1: Uint8Array): string[] {
  const out: string[] = [];
  const at = PAUSE_FLAGS_AT + 1;
  const v1Params = getRiskParamsEncoder().fixedSize - 48;
  const padded = new Uint8Array(v1Params + 48);
  padded.set(v1.subarray(at, at + v1Params));
  const p = getRiskParamsDecoder().decode(padded);
  const b = SPEC_BEACON;
  const within = (v: bigint, lo: bigint, hi: bigint) => lo <= v && v <= hi;
  if (
    !within(b.beaconMinPrice, 1n, p.maxPrice) ||
    !within(b.beaconThreshold, b.beaconMinPrice, p.maxPrice)
  )
    out.push(
      `max_price ${p.maxPrice} is below the beacon's threshold ${b.beaconThreshold}: migrate_config would refuse (6001)`,
    );
  if (
    !within(b.roundK, 1n, MAX_ROUND_K) ||
    !within(b.tickSlots, 1n, MAX_TICK_SLOTS) ||
    !within(b.refundSlots, b.tickSlots, MAX_REFUND_SLOTS)
  )
    out.push("SPEC_BEACON is out of the program's bounds");
  if (!within(b.crankRoundSettleLamports, 1n, p.crankSettleLamports))
    out.push(
      `crank_settle_lamports ${p.crankSettleLamports} is below the beacon's ${b.crankRoundSettleLamports}: migrate_config would refuse (6001)`,
    );
  if (v1PendingActive(v1))
    out.push(
      "a parameter change is pending: apply or cancel it (apply_params, cancel_params) first",
    );
  return out;
}

export const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const replacer = (_k: string, v: unknown) =>
  typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Array.from(v) : v;

/**
 * What a migration got wrong, from the `Config` and `Vault` bytes before and
 * after it (empty when right): `Config` 791 bytes, version 2, `PAUSE_ROUNDS`
 * added to the flags and the others kept, the six fields SPEC's in `params`
 * and `pending.params`, every version-1 byte kept; the `Vault` the same size,
 * `next_round_id` 0 → 1, no round accepting, and every other field unchanged
 * unless `vaultWrittenSince` (a later transaction wrote the Vault: its other
 * fields are then `vaultDrift`'s to report, not a migration's mistake).
 */
export function migrationMismatches(a: {
  oldConfig: Uint8Array;
  newConfig: Uint8Array;
  oldVault: Uint8Array;
  newVault: Uint8Array;
  vaultWrittenSince?: boolean;
}): string[] {
  const wrong: string[] = [];
  const flags = a.oldConfig[PAUSE_FLAGS_AT]!;
  if (a.newConfig.length !== V2_CONFIG_LEN)
    return [`Config is ${a.newConfig.length} bytes, not 791`];
  const config = getConfigDecoder().decode(a.newConfig);
  if (config.version !== 2) wrong.push(`Config version ${config.version}, not 2`);
  if (config.pauseFlags !== (flags | PAUSE_ROUNDS))
    wrong.push(
      `pause flags ${config.pauseFlags}, not ${flags | PAUSE_ROUNDS} (PAUSE_ROUNDS added)`,
    );
  for (const k of BEACON_FIELDS) {
    if (config.params[k] !== SPEC_BEACON[k]) wrong.push(`params.${k} is not SPEC`);
    if (config.pending.params[k] !== SPEC_BEACON[k]) wrong.push(`pending.params.${k} is not SPEC`);
  }
  if (!same(backToV1(a.newConfig, a.oldConfig[VERSION_AT]!, flags), a.oldConfig))
    wrong.push("a version-1 Config byte changed");
  if (a.newVault.length !== a.oldVault.length) return [...wrong, "the Vault changed size"];
  const vb = getVaultDecoder().decode(a.oldVault);
  const va = getVaultDecoder().decode(a.newVault);
  if (!a.vaultWrittenSince)
    wrong.push(...vaultDrift(a.oldVault, a.newVault).map((k) => `vault.${k} changed`));
  if (va.nextRoundId !== (vb.nextRoundId === 0n ? 1n : vb.nextRoundId))
    wrong.push(`vault.nextRoundId ${vb.nextRoundId} → ${va.nextRoundId}, not 1`);
  if (va.acceptingRound !== 0n) wrong.push(`vault.acceptingRound ${va.acceptingRound}, not 0`);
  return wrong;
}

/** The Vault fields that differ, `next_round_id` aside (the one `migrate_config` writes). */
export function vaultDrift(oldVault: Uint8Array, newVault: Uint8Array): string[] {
  const vb = getVaultDecoder().decode(oldVault);
  const va = getVaultDecoder().decode(newVault);
  return (Object.keys(vb) as (keyof typeof vb)[]).filter(
    (k) =>
      k !== "nextRoundId" && JSON.stringify(vb[k], replacer) !== JSON.stringify(va[k], replacer),
  );
}
