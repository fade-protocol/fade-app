// Names the devnet share mint for wallets: set_share_metadata creates the
// Metaplex Token Metadata account on the first run and rewrites it after, so
// re-running it with another name, symbol or URI updates what wallets show.
//
//   pnpm devnet:share-metadata  (council = keys/deployer.json)
//   SHARE_NAME=… SHARE_SYMBOL=… SHARE_URI=… pnpm devnet:share-metadata
import {
  fetchConfig,
  getSetShareMetadataInstructionAsync,
} from "../../clients/js/src/generated/fade/index.ts";
import {
  PROGRAM,
  accountData,
  explorerAddress,
  fadePdas,
  loadDeployer,
  rpc,
  send,
  simulate,
} from "./lib.ts";

const NAME = process.env["SHARE_NAME"] ?? "Fade Vault USDC";
const SYMBOL = process.env["SHARE_SYMBOL"] ?? "fvUSDC";
const URI = process.env["SHARE_URI"] ?? "https://fade.finance/tokens/fvusdc.json";

/** Name, symbol and URI from a Token Metadata `Metadata` account (NUL padding trimmed). */
function parseMetadata(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset);
  let at = 65; // key, update authority, mint
  const text = () => {
    const len = view.getUint32(at, true);
    const s = new TextDecoder().decode(data.slice(at + 4, at + 4 + len));
    at += 4 + len;
    return s.replace(/\0+$/, "");
  };
  return { name: text(), symbol: text(), uri: text() };
}

async function main() {
  const council = await loadDeployer();
  const pdas = await fadePdas();
  const config = await fetchConfig(rpc, pdas.config);
  if (config.data.council !== council.address)
    throw new Error(`keys/deployer.json is not the council (${config.data.council})`);

  const ix = await getSetShareMetadataInstructionAsync(
    {
      council,
      payer: council,
      eventAuthority: pdas.eventAuthority,
      program: PROGRAM,
      name: NAME,
      symbol: SYMBOL,
      uri: URI,
    },
    { programAddress: PROGRAM },
  );
  const metadata = ix.accounts[5].address;
  const before = await accountData(metadata);
  console.log(
    `share mint ${pdas.shareMint}\nmetadata   ${metadata} (${before ? "exists: rewrite" : "absent: create"})`,
  );
  if (before) console.log("  current:", parseMetadata(before));

  const dry = await simulate(council, [ix]);
  if (dry.err) {
    throw new Error(
      `simulation failed: ${JSON.stringify(dry.err, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}\n  ${dry.logs.join("\n  ")}`,
    );
  }
  await send(council, [ix], "set_share_metadata");

  const after = await accountData(metadata);
  if (!after) throw new Error("metadata account missing after the transaction");
  console.log("  now:", parseMetadata(after));
  console.log(explorerAddress(pdas.shareMint));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
