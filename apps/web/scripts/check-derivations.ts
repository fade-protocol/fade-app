// Cross-checks the app's derivations against what the program wrote on devnet:
// the ORAO request address from a RandomnessRequested event's seed, and the
// ticket address from a TicketOpened event's integrator and nonce.
import { createHash } from "node:crypto";
import { fetchFeed } from "../src/lib/events";
import { oraoRequestAddress, oraoSeed, ticketAddress } from "../src/lib/ticket";
import { address } from "@solana/kit";

const feed = await fetchFeed(30);
let checked = 0;
for (const item of feed)
  for (const e of item.events) {
    if (e.kind === "RandomnessRequested") {
      const req = await oraoRequestAddress(Uint8Array.from(e.data.seed));
      console.log(
        `${req === e.data.request ? "ok  " : "FAIL"} ORAO request PDA from seed for ticket ${e.data.ticket.slice(0, 8)}`,
      );
      checked++;
    }
    if (e.kind === "TicketOpened") {
      const w = await ticketAddress(e.data.integrator, e.data.nonce);
      console.log(`${w === e.data.ticket ? "ok  " : "FAIL"} ticket PDA for nonce ${e.data.nonce}`);
      checked++;
    }
  }
// WebCrypto seed equals the node:crypto derivation the devnet scripts use.
const ticket = address("GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt");
const hash = new Uint8Array(32).fill(7);
const a = await oraoSeed(ticket, 123n, 124n, hash);
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const { getAddressEncoder } = await import("@solana/kit");
const enc = (x: string) => Buffer.from(getAddressEncoder().encode(address(x)));
const b = createHash("sha256")
  .update("FADE/ORAO-SEED/v1")
  .update(enc("GqWqMEubSHgrqJCZ9zPfMHq6uQPZkr6EbiBy78j7engt"))
  .update(enc(ticket))
  .update(u64(123n))
  .update(u64(124n))
  .update(hash)
  .digest();
console.log(`${Buffer.from(a).equals(b) ? "ok  " : "FAIL"} seed derivation matches node:crypto`);
console.log(`${checked} on-chain derivations checked`);
