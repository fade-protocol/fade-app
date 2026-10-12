// Phase 0 proof, transaction level: the binary runs in litesvm (npm) under the
// mainnet feature set through the Codama-generated client; emit_cpi! shows up
// as an inner instruction; a system-owned PDA can pay through invoke_signed.
import { describe, expect, it } from "vitest";
import { address, getProgramDerivedAddress, getAddressEncoder } from "@solana/kit";
import { FeatureSet } from "litesvm";
import {
  TOOLCHAIN_SMOKE_PROGRAM_ADDRESS,
  findVrfPayerPda,
  getFundPdaInstructionAsync,
  getPdaTransferInstructionAsync,
  getPingInstruction,
  parsePingedEvent,
} from "../../../clients/js/src/generated/toolchain_smoke/index.ts";
import { readFileSync } from "node:fs";
import { Svm, programPath } from "../utils/svm.ts";

const SLOT_HASHES = address("SysvarS1otHashes111111111111111111111111111");
const EMIT_CPI_PREFIX = [228, 69, 165, 46, 81, 203, 154, 29];

describe("toolchain smoke (litesvm npm, mainnet features)", () => {
  it("ping reads SlotHashes and emits through emit_cpi", async () => {
    const svm = new Svm([{ id: TOOLCHAIN_SMOKE_PROGRAM_ADDRESS, name: "toolchain_smoke" }]);
    const payer = await svm.fundedWallet();
    const [eventAuthority] = await getProgramDerivedAddress({
      programAddress: TOOLCHAIN_SMOKE_PROGRAM_ADDRESS,
      seeds: ["__event_authority"],
    });
    const meta = await svm.send(payer, [
      getPingInstruction({
        slotHashes: SLOT_HASHES,
        eventAuthority,
        program: TOOLCHAIN_SMOKE_PROGRAM_ADDRESS,
      }),
    ]);
    const inner = meta.innerInstructions().flat();
    const emitted = inner
      .map((i) => i.instruction().data())
      .find((d) => EMIT_CPI_PREFIX.every((b, k) => d[k] === b));
    expect(emitted, "emit_cpi inner instruction").toBeDefined();
    const event = parsePingedEvent(emitted!.slice(8));
    expect(event.version).toBe(1);
    // litesvm seeds SlotHashes with the current slot itself; on a cluster the newest entry is the previous slot.
    expect(event.latestSlot).toBeLessThanOrEqual(event.currentSlot);
    expect(event.latestHash.some((b) => b !== 0)).toBe(true);
    expect(meta.logs().some((l) => l.includes("Program data:"))).toBe(false);
  });

  it("a system-owned PDA can pay via invoke_signed", async () => {
    const svm = new Svm([{ id: TOOLCHAIN_SMOKE_PROGRAM_ADDRESS, name: "toolchain_smoke" }]);
    const payer = await svm.fundedWallet();
    const recipient = await svm.fundedWallet(1);
    const [vrfPayer] = await findVrfPayerPda({ payer: payer.address });
    await svm.send(payer, [
      await getFundPdaInstructionAsync({ payer, lamports: 5_000_000n }),
      await getPdaTransferInstructionAsync({
        payer,
        recipient: recipient.address,
        lamports: 3_000_000n,
      }),
    ]);
    expect(svm.client.getBalance(vrfPayer)).toBe(2_000_000n);
    expect(svm.client.getBalance(recipient.address)).toBe(1_000_000_000n + 3_000_000n);
  });

  it("negative control: the binary cannot run when no SBPF version feature is active", async (ctx) => {
    const elf = readFileSync(programPath("toolchain_smoke"));
    if (elf.readUInt32LE(0x30) === 0) ctx.skip(); // a v0 ELF has no feature gate
    const bare = new Svm(
      [{ id: TOOLCHAIN_SMOKE_PROGRAM_ADDRESS, name: "toolchain_smoke" }],
      new FeatureSet(),
    );
    const payer = await bare.fundedWallet();
    await expect(
      bare.send(payer, [await getFundPdaInstructionAsync({ payer, lamports: 1n })]),
    ).rejects.toThrow();
  });
});
