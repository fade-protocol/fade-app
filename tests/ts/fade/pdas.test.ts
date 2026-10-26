// The generated client's ticket PDAs derive what the program derives: a direct
// ticket at ["ticket", integrator, nonce], a beacon ticket at
// ["round-ticket", integrator, nonce]. Codama names PDAs after instruction
// accounts, and both instructions call theirs `ticket`; scripts/codama-generate.mjs
// renames them by seed, and this pins the result.
import { describe, expect, it } from "vitest";
import { address, getAddressEncoder, getProgramDerivedAddress, getU64Encoder } from "@solana/kit";
import {
  FADE_PROGRAM_ADDRESS,
  findRoundTicketPda,
  findRoundVrfPda,
  findSponsorshipPda,
  findTicketPda,
} from "../../../clients/js/src/generated/fade/index.ts";

const integrator = address("GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt");

async function derive(seed: string, nonce: bigint) {
  const [pda] = await getProgramDerivedAddress({
    programAddress: FADE_PROGRAM_ADDRESS,
    seeds: [
      new TextEncoder().encode(seed),
      getAddressEncoder().encode(integrator),
      getU64Encoder().encode(nonce),
    ],
  });
  return pda;
}

describe("ticket PDAs", () => {
  it("findTicketPda derives a direct ticket", async () => {
    const [pda] = await findTicketPda({ integrator, nonce: 7n });
    expect(pda).toBe(await derive("ticket", 7n));
  });

  it("findRoundTicketPda derives a beacon ticket", async () => {
    const [pda] = await findRoundTicketPda({ integrator, nonce: 7n });
    expect(pda).toBe(await derive("round-ticket", 7n));
    expect(pda).not.toBe(await derive("ticket", 7n));
  });
});

describe("sponsorship PDA", () => {
  it("findSponsorshipPda derives a sponsorship record", async () => {
    const round = address("HeuXg1Fn2R7TzzATextZjwySFq1m4YBgUdvXqbQuojsL");
    const sponsor = integrator;
    const [pda] = await findSponsorshipPda({ round, sponsor });
    const [expected] = await getProgramDerivedAddress({
      programAddress: FADE_PROGRAM_ADDRESS,
      seeds: [
        new TextEncoder().encode("sponsorship"),
        getAddressEncoder().encode(round),
        getAddressEncoder().encode(sponsor),
      ],
    });
    expect(pda).toBe(expected);
  });
});

describe("round_vrf PDA", () => {
  it("findRoundVrfPda derives the account that pays ORAO for a round", async () => {
    const round = address("HeuXg1Fn2R7TzzATextZjwySFq1m4YBgUdvXqbQuojsL");
    const [pda] = await findRoundVrfPda({ round });
    const [expected] = await getProgramDerivedAddress({
      programAddress: FADE_PROGRAM_ADDRESS,
      seeds: [new TextEncoder().encode("round-vrf"), getAddressEncoder().encode(round)],
    });
    expect(pda).toBe(expected);
  });
});
