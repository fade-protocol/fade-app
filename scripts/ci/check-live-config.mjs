// Deploy gate: the app and the keeper run against the live devnet deployment,
// so they deploy only once it runs the program they were built for:
//
//   1. its Config is version 2 (791 bytes): the app and the keeper decode that
//      Config only, written by `migrate_config` (programs/fade/src/state.rs and
//      instructions/migrate.rs; offset 8, right after the discriminator, is the
//      version byte);
//   2. its binary knows the instructions the keeper sends on the direct path
//      (`record_ticket_entropy`, `refund_expired_ticket`, `sweep_ticket_vrf`):
//      an older binary refuses each with Anchor's InstructionFallbackNotFound,
//      which would leave an Open ticket past its window Open on every tick.
//
// Both are reached by `pnpm devnet:upgrade-live --confirm`. Read-only: the
// accounts are read with getAccountInfo, and each instruction is simulated
// (simulateTransaction, signatures not verified, never sent) with its
// discriminator alone and no accounts. A binary that knows it logs Anchor's
// "Instruction: <Name>" before refusing the missing accounts; an older one
// never logs it. The simulation's fee payer is the program's upgrade
// authority, the deployer's funded wallet.
//
//   node scripts/ci/check-live-config.mjs
import { createHash } from "node:crypto";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const LIVE_PROGRAM = "GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt";
const LIVE_CONFIG = "9SWzMCw6JssmpQinyeKEa8RN8T6w7JLyZdNSxUbhAYVU";
const V2_CONFIG_LEN = 791;
const VERSION_AT = 8;
const DISCRIMINATOR = createHash("sha256").update("account:Config").digest().subarray(0, 8);
/** The instructions the keeper needs, by the name Anchor logs on dispatch. */
const REQUIRED_IXS = {
  record_ticket_entropy: "RecordTicketEntropy",
  refund_expired_ticket: "RefundExpiredTicket",
  sweep_ticket_vrf: "SweepTicketVrf",
};
/** A program account of the upgradeable loader: its tag (2) then the ProgramData address. */
const PROGRAM_TAG = 2;
/** A ProgramData account: its tag (3), the slot (8 bytes), then Option<authority>. */
const PROGRAM_DATA_TAG = 3;
const PROGRAM_DATA_AUTHORITY_AT = 12;
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A 32-byte address from base58. */
function fromBase58(s) {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error(`not base58: ${s}`);
    n = n * 58n + BigInt(v);
  }
  const out = Buffer.alloc(32);
  for (let i = 31; i >= 0 && n > 0n; i--, n >>= 8n) out[i] = Number(n & 0xffn);
  if (n > 0n) throw new Error(`not a 32-byte address: ${s}`);
  return out;
}
/** Base58 of a 32-byte address. */
function toBase58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let s = "";
  for (; n > 0n; n /= 58n) s = B58[Number(n % 58n)] + s;
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}

/** A JSON-RPC call, retried on a rate limit or a server error. */
async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).catch((e) => ({ ok: false, status: 0, error: e }));
    if (res.ok) {
      const body = await res.json();
      if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
      return body.result;
    }
    const retriable = res.status === 0 || res.status === 429 || res.status >= 500;
    if (!retriable || attempt >= 5) throw new Error(`${method}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

/** The account at `address` (base64 data, optionally a slice), or null. */
async function getAccountInfo(address, dataSlice) {
  const opts = { encoding: "base64", commitment: "confirmed", ...(dataSlice ? { dataSlice } : {}) };
  const value = (await rpc("getAccountInfo", [address, opts])).value;
  return value ? { ...value, bytes: Buffer.from(value.data[0], "base64") } : null;
}

/** The problems of the live Config, none when it is the live program's version-2 Config. */
async function configProblems() {
  const value = await getAccountInfo(LIVE_CONFIG);
  if (!value) return [`no account at ${LIVE_CONFIG}`];
  const problems = [];
  const data = value.bytes;
  if (value.owner !== LIVE_PROGRAM) problems.push(`owned by ${value.owner}, not ${LIVE_PROGRAM}`);
  if (!data.subarray(0, 8).equals(DISCRIMINATOR)) problems.push("not a Config account");
  if (data.length !== V2_CONFIG_LEN) problems.push(`${data.length} bytes, not ${V2_CONFIG_LEN}`);
  if (data[VERSION_AT] !== 2) problems.push(`version ${data[VERSION_AT]}, not 2`);
  return problems;
}

/** The live program's upgrade authority, the simulations' fee payer. */
async function upgradeAuthority() {
  const program = await getAccountInfo(LIVE_PROGRAM);
  if (
    !program ||
    program.owner !== UPGRADEABLE_LOADER ||
    program.bytes.readUInt32LE(0) !== PROGRAM_TAG
  )
    throw new Error(`${LIVE_PROGRAM} is not a program of the upgradeable loader`);
  const programData = toBase58(program.bytes.subarray(4, 36));
  const pd = await getAccountInfo(programData, {
    offset: 0,
    length: PROGRAM_DATA_AUTHORITY_AT + 33,
  });
  if (!pd || pd.bytes.readUInt32LE(0) !== PROGRAM_DATA_TAG)
    throw new Error(`${programData} is not the program's ProgramData`);
  if (pd.bytes[PROGRAM_DATA_AUTHORITY_AT] !== 1)
    throw new Error(`${LIVE_PROGRAM} has no upgrade authority`);
  return pd.bytes.subarray(PROGRAM_DATA_AUTHORITY_AT + 1, PROGRAM_DATA_AUTHORITY_AT + 33);
}

/**
 * A legacy transaction, base64, of one instruction to the live program with
 * `data` and no accounts, paid by `payer`; its signature and blockhash are
 * zeros (the simulation verifies no signature and replaces the blockhash).
 */
function probeTransaction(payer, data) {
  const message = Buffer.concat([
    Buffer.from([1, 0, 1]), // one signer (the payer), the program read-only
    Buffer.from([2]),
    payer,
    fromBase58(LIVE_PROGRAM),
    Buffer.alloc(32),
    Buffer.from([1, 1, 0, data.length]), // one instruction: program 1, no accounts
    data,
  ]);
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString("base64");
}

/** The required instructions the live binary does not know. */
async function unknownInstructions() {
  const payer = await upgradeAuthority();
  const unknown = [];
  for (const [ix, name] of Object.entries(REQUIRED_IXS)) {
    const data = createHash("sha256").update(`global:${ix}`).digest().subarray(0, 8);
    const sim = await rpc("simulateTransaction", [
      probeTransaction(payer, data),
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      },
    ]);
    const logs = sim.value.logs ?? [];
    if (!logs.includes(`Program log: Instruction: ${name}`))
      unknown.push(`${ix} (${JSON.stringify(sim.value.err)})`);
  }
  return unknown;
}

const problems = await configProblems();
if (problems.length) {
  console.error(
    `✗ the live Config ${LIVE_CONFIG} is not migrated: ${problems.join("; ")}.\n` +
      "  Run pnpm devnet:upgrade-live --confirm --expect-sha256 <hex> before deploying the app or the keeper.",
  );
  process.exit(1);
}
const unknown = await unknownInstructions();
if (unknown.length) {
  console.error(
    `✗ the live program ${LIVE_PROGRAM} does not know ${unknown.join("; ")}.\n` +
      "  Run pnpm devnet:upgrade-live --confirm --expect-sha256 <hex> before deploying the app or the keeper.",
  );
  process.exit(1);
}
console.log(
  `✓ the live Config ${LIVE_CONFIG} is version 2 (${V2_CONFIG_LEN} bytes), ` +
    `and the live program knows ${Object.keys(REQUIRED_IXS).join(", ")}`,
);
