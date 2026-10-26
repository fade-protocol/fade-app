// The pause flags of `Config` (programs/fade/src/state.rs) as pause-tickets.ts moves them: one
// bit, PAUSE_TICKETS, set or cleared, every other flag written back as it was read, since
// `set_pause_flags` writes the whole byte. Pure: the tests run them on synthetic values.
import type { Address } from "@solana/kit";

/** `Config::PAUSE_*`, by bit. */
export const PAUSE_FLAG_NAMES: readonly [number, string][] = [
  [1 << 0, "PAUSE_TICKETS"],
  [1 << 1, "PAUSE_DEPOSITS"],
  [1 << 2, "PAUSE_NEW_INTEGRATORS"],
  [1 << 3, "PAUSE_ROUNDS"],
];
const PAUSE_TICKETS = 1 << 0;
/** `Config::PAUSE_ALL`: a byte with any other bit set is refused by the program. */
const PAUSE_ALL = PAUSE_FLAG_NAMES.reduce((all, [bit]) => all | bit, 0);

export type PauseAction = "set" | "clear";

/** The names of the flags `flags` holds, a bit outside `PAUSE_ALL` named by its value. */
export function pauseFlagNames(flags: number): string[] {
  const names = PAUSE_FLAG_NAMES.filter(([bit]) => (flags & bit) !== 0).map(([, n]) => n);
  const unknown = flags & ~PAUSE_ALL & 0xff;
  return unknown ? [...names, `unknown bits ${unknown}`] : names;
}

/**
 * The byte `set_pause_flags` writes to set or clear PAUSE_TICKETS from `flags`: that bit alone
 * moves, PAUSE_DEPOSITS, PAUSE_NEW_INTEGRATORS and PAUSE_ROUNDS stay as they are.
 */
export function ticketPauseFlags(flags: number, action: PauseAction): number {
  return action === "set" ? flags | PAUSE_TICKETS : flags & ~PAUSE_TICKETS & 0xff;
}

/**
 * Why `signer` cannot send the change (empty when it can): the guardian or the council sets a
 * flag, only the council clears one (`set_pause_flags`, `GuardianCannotUnpause`).
 */
export function pauseSignerRefusals(
  action: PauseAction,
  signer: Address,
  config: { guardian: Address; council: Address },
): string[] {
  if (signer === config.council) return [];
  if (action === "set")
    return signer === config.guardian
      ? []
      : [`the signer ${signer} is neither the guardian ${config.guardian} nor the council`];
  return [
    `the signer ${signer} is not the council ${config.council}: only the council clears a pause`,
  ];
}

/**
 * Why a `GET /v1/health` answer does not let tickets resume (empty when it does):
 *
 * - it is not the new keeper's: only the keeper with the audit fixes serves `directWithheld` and
 *   `directPauseRecommended`, and the old one cannot end an Open ticket on the new binary;
 * - the new keeper has not ticked yet (`lastTick` 0) or has not read the Vault's
 *   `ticket_forfeits_withheld` (`directWithheld.counted` null): its `pauseRecommended` is then
 *   the fail-closed default, not a reading, and says nothing about the upgrade window;
 * - it recommends the pause (`pauseRecommended`, the direct path's alarm or the beacon's): an
 *   unresolved withheld draw is what the pause is for. The way out is the alarm's own: resolved,
 *   or acknowledged by a reviewed deploy (`DIRECT_ACKNOWLEDGED_WITHHELD` for a direct ordinal, such
 *   as an upgrade window's refund; `BEACON_ACKNOWLEDGED_ALARMS` for a round), never this script.
 *
 * So tickets stay paused until the new keeper answers, has read the chain, and sees nothing to
 * pause for.
 */
export function newKeeperHealthRefusals(health: unknown): string[] {
  if (typeof health !== "object" || health === null)
    return ["GET /v1/health did not answer a JSON object"];
  const h = health as Record<string, unknown>;
  const out: string[] = [];
  const withheld = h["directWithheld"];
  if (typeof withheld !== "object" || withheld === null)
    out.push(
      "GET /v1/health has no directWithheld: the keeper serving it predates the audit fixes",
    );
  if (typeof h["directPauseRecommended"] !== "boolean")
    out.push(
      "GET /v1/health has no directPauseRecommended: the keeper serving it predates the audit fixes",
    );
  if (out.length) return out;
  const lastTick = h["lastTick"];
  if (typeof lastTick !== "number" || !(lastTick > 0))
    out.push(
      "the keeper has not ticked yet (lastTick 0): wait for its first tick, its pause recommendation is the fail-closed default until then",
    );
  const counted = (withheld as Record<string, unknown>)["counted"];
  if (typeof counted !== "string")
    out.push(
      "the keeper has not read the Vault's ticket_forfeits_withheld (directWithheld.counted null): wait for a tick that reads it, or see its rpcError",
    );
  if (h["pauseRecommended"] !== false)
    out.push(
      `the keeper recommends the pause (pauseRecommended ${String(h["pauseRecommended"])}: direct ${String(h["directPauseRecommended"])}, beacon ${String(h["beaconPauseRecommended"])}): ` +
        "resolve its alarms, or acknowledge them by a reviewed deploy (DIRECT_ACKNOWLEDGED_WITHHELD for a direct ordinal such as an upgrade window's refund, BEACON_ACKNOWLEDGED_ALARMS for a round), before the unpause",
    );
  return out;
}

/**
 * Whether `clear` waits for the new keeper's `GET /v1/health`: only while the live binary
 * carries the audit fixes (`carriesAuditFixes`), since the old keeper cannot end an Open ticket
 * on it. Under a binary without them (the cutover called off before the upgrade, or the
 * rollback, its merge reverted) the old keeper is the one that should be running, and the
 * unpause goes ahead without it. `keeperCheck` is false for `set` and for a clone's
 * `--no-keeper-check`.
 */
export function newKeeperRequired(keeperCheck: boolean, liveCarriesAuditFixes: boolean): boolean {
  return keeperCheck && liveCarriesAuditFixes;
}
