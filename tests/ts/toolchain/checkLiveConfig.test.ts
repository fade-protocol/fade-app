// scripts/ci/check-live-config.mjs, the deploy gate of the app and the
// keeper: it passes on the live program's version-2 Config only,
// and only once the live binary knows the instructions the keeper sends on the
// direct path. Each case answers its JSON-RPC calls from a local stub.
import { afterEach, describe, expect, it } from "vitest";
import { getBase58Codec } from "@solana/kit";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const LIVE = "GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt";
const CONFIG = "9SWzMCw6JssmpQinyeKEa8RN8T6w7JLyZdNSxUbhAYVU";
const PROGRAM_DATA = "4Q8J9hawmt58XLEoYNSkVrzm44RA7xMVT2hrfGP6x73K";
const AUTHORITY = "DarFJQCDvctsR6krQBw7uVmGWiaiCtcdhCGnjZDFq2od";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const DISCRIMINATOR = createHash("sha256").update("account:Config").digest().subarray(0, 8);
const IXS = {
  record_ticket_entropy: "RecordTicketEntropy",
  refund_expired_ticket: "RefundExpiredTicket",
  sweep_ticket_vrf: "SweepTicketVrf",
} as const;
const b58 = getBase58Codec();
const ixData = (ix: string) =>
  Buffer.from(createHash("sha256").update(`global:${ix}`).digest().subarray(0, 8));
const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

const config = (len: number, version: number) => {
  const d = Buffer.alloc(len);
  DISCRIMINATOR.copy(d);
  d[8] = version;
  return d;
};

const account = (data: Buffer, owner = LIVE) => ({
  data: [data.toString("base64"), "base64"],
  owner,
  lamports: 1,
  executable: false,
});

const programAccount = () => {
  const d = Buffer.alloc(36);
  d.writeUInt32LE(2, 0);
  Buffer.from(b58.encode(PROGRAM_DATA)).copy(d, 4);
  return account(d, LOADER);
};

/** The first 45 bytes of a ProgramData account (the gate's slice): tag 3, slot, Some(authority). */
const programDataHead = () => {
  const d = Buffer.alloc(45);
  d.writeUInt32LE(3, 0);
  d[12] = 1;
  Buffer.from(b58.encode(AUTHORITY)).copy(d, 13);
  return account(d, LOADER);
};

/** A simulated probe, decoded: its fee payer, program, accounts and data. */
type Probe = {
  payer: string;
  program: string;
  accounts: number;
  data: Buffer;
  opts: Record<string, unknown>;
};

/** Decodes the gate's legacy probe transaction: one signature, then the message. */
function decodeProbe(tx64: string, opts: Record<string, unknown>): Probe {
  const tx = Buffer.from(tx64, "base64");
  expect(tx[0]).toBe(1);
  const m = tx.subarray(65);
  expect([...m.subarray(0, 4)]).toEqual([1, 0, 1, 2]);
  const key = (i: number) => b58.decode(m.subarray(4 + 32 * i, 36 + 32 * i));
  const ix = m.subarray(4 + 64 + 32);
  expect(ix[0]).toBe(1); // one instruction
  expect(ix[1]).toBe(1); // to the program
  return {
    payer: key(0),
    program: key(1),
    accounts: ix[2]!,
    data: Buffer.from(ix.subarray(4, 4 + ix[3]!)),
    opts,
  };
}

/**
 * Runs the gate against a stub answering the Config with `value` (or `status`),
 * and each simulation as a binary knowing the instructions `known` does.
 */
async function gate(value: unknown, status = 200, known: string[] = Object.keys(IXS)) {
  let asked: unknown = null;
  const probes: Probe[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      let result: unknown;
      if (method === "getAccountInfo") {
        const address = params[0];
        if (address === CONFIG) asked = address;
        const v =
          address === CONFIG
            ? value
            : address === LIVE
              ? programAccount()
              : address === PROGRAM_DATA
                ? programDataHead()
                : null;
        result = { context: { slot: 1 }, value: v };
      } else {
        const probe = decodeProbe(params[0], params[1]);
        probes.push(probe);
        const ix = Object.keys(IXS).find((k) => ixData(k).equals(probe.data));
        const logs =
          ix && known.includes(ix)
            ? [
                `Program ${LIVE} invoke [1]`,
                `Program log: Instruction: ${IXS[ix as keyof typeof IXS]}`,
                "Program log: AnchorError occurred. Error Code: AccountNotEnoughKeys.",
              ]
            : [
                `Program ${LIVE} invoke [1]`,
                "Program log: AnchorError occurred. Error Code: InstructionFallbackNotFound.",
              ];
        const err = { InstructionError: [0, { Custom: ix && known.includes(ix) ? 3005 : 101 }] };
        result = { context: { slot: 1 }, value: { err, logs } };
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const child = spawn(process.execPath, ["scripts/ci/check-live-config.mjs"], {
    env: { ...process.env, RPC_URL: url },
  });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  return { code, err, asked, probes };
}

describe("the live Config deploy gate", () => {
  it("passes on a version-2 Config of the live program", async () => {
    const r = await gate(account(config(791, 2)));
    expect(r.code).toBe(0);
    expect(r.asked).toBe(CONFIG);
  });

  it("fails on the unmigrated version-1 Config", async () => {
    const r = await gate(account(config(695, 1)));
    expect(r.code).toBe(1);
    expect(r.err).toContain("695 bytes, not 791");
    expect(r.err).toContain("version 1, not 2");
    expect(r.err).toContain("pnpm devnet:upgrade-live --confirm --expect-sha256 <hex>");
  });

  it("fails on a wrong version byte, a wrong owner, a wrong account, no account, an RPC error", async () => {
    expect((await gate(account(config(791, 1)))).err).toContain("version 1, not 2");
    expect((await gate(account(config(791, 2), CONFIG))).err).toContain(`not ${LIVE}`);
    const other = config(791, 2);
    other.writeUInt8(other.readUInt8(0) ^ 1, 0);
    expect((await gate(account(other))).err).toContain("not a Config account");
    expect((await gate(null)).err).toContain("no account at");
    expect((await gate(null, 403)).code).toBe(1);
  });

  it("simulates each instruction the keeper needs, read-only, paid by the upgrade authority", async () => {
    const r = await gate(account(config(791, 2)));
    expect(r.code).toBe(0);
    expect(r.probes.map((p) => p.data)).toEqual(Object.keys(IXS).map(ixData));
    for (const p of r.probes) {
      expect(p.payer).toBe(AUTHORITY);
      expect(p.program).toBe(LIVE);
      expect(p.accounts).toBe(0);
      expect(p.opts).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true });
    }
  });

  it("fails on a version-2 Config under a binary that does not know them", async () => {
    const old = await gate(account(config(791, 2)), 200, []);
    expect(old.code).toBe(1);
    for (const ix of Object.keys(IXS))
      expect(old.err).toContain(`${ix} ({"InstructionError":[0,{"Custom":101}]})`);
    expect(old.err).toContain("pnpm devnet:upgrade-live --confirm --expect-sha256 <hex>");
    const partial = await gate(account(config(791, 2)), 200, [
      "record_ticket_entropy",
      "refund_expired_ticket",
    ]);
    expect(partial.code).toBe(1);
    expect(partial.err).toContain("does not know sweep_ticket_vrf");
    expect(partial.err).not.toContain("record_ticket_entropy");
  });
});
