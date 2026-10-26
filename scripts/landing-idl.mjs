// Write the public IDL the landing serves (apps/landing/public/idl/fade.json,
// fade.finance/idl/fade.json) from the committed idls/fade.json: the program
// and the USDC mint it names become the devnet deployment's (read from the
// app's config, the deployment the public build talks to), the repository
// link goes, and the description reads as the
// published copy does. Everything else is the program's IDL as built.
// scripts/verify.sh runs it and fails when the committed file differs:
//   node scripts/landing-idl.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAINNET_PROGRAM = "HeuXg1Fn2R7TzzATextZjwySFq1m4YBgUdvXqbQuojsL";
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DESCRIPTION = "Fade: a permissionless payout protocol for Solana";

const config = readFileSync(join(root, "apps/web/src/lib/config.ts"), "utf8");
const constant = (name) => {
  const m = config.match(
    new RegExp(`export const ${name} = address\\("([1-9A-HJ-NP-Za-km-z]{32,44})"\\)`),
  );
  if (!m) throw new Error(`apps/web/src/lib/config.ts: no ${name} address`);
  return m[1];
};
const program = constant("PROGRAM");
const usdc = constant("USDC_MINT");

const idl = JSON.parse(
  readFileSync(join(root, "idls/fade.json"), "utf8")
    .replaceAll(MAINNET_PROGRAM, program)
    .replaceAll(MAINNET_USDC, usdc),
);
if (idl.address !== program)
  throw new Error("idls/fade.json does not carry the mainnet program address");
delete idl.metadata.repository;
idl.metadata.description = DESCRIPTION;

// Formatted as prettier formats the committed file, so the check below compares content only.
const out = join(root, "apps/landing/public/idl/fade.json");
const options = { ...(await resolveConfig(out)), filepath: out };
writeFileSync(out, await format(JSON.stringify(idl, null, 2), options));
