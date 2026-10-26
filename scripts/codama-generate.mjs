// Generate the TypeScript client (@solana/kit) from the committed IDLs.
// Output is committed under clients/js/src/generated so integrators and tests
// import a reviewed artefact; scripts/check-client-drift.sh fails CI when it
// is stale.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bottomUpTransformerVisitor,
  createFromRoot,
  isNode,
  pdaLinkNode,
  pdaNode,
  visit,
} from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const idlDir = join(root, "idls");
const outDir = join(root, "clients", "js", "src", "generated");

// Codama names a PDA after the first instruction account it finds it on, in
// the IDL's alphabetical instruction order, and renames a later one with the
// same account name but other seeds. `join_round`'s `ticket` (seeds
// "round-ticket") sorts before `open_ticket`'s (seeds "ticket"), so left alone
// `findTicketPda` would silently derive a beacon ticket's address for every
// existing caller. Each PDA is named here after what it derives, and the seeds
// are checked so that a future collision fails the generation instead.
const PDA_NAMES = {
  fade: {
    ticket: { name: "roundTicket", seed: "round-ticket" },
    openTicketTicket: { name: "ticket", seed: "ticket" },
  },
};

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(text) {
  let n = 0n;
  for (const c of text) {
    const digit = BASE58.indexOf(c);
    if (digit < 0) throw new Error(`not base58: ${text}`);
    n = n * 58n + BigInt(digit);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function firstSeed(pda) {
  const seed = (pda.seeds ?? [])[0];
  if (!seed || !isNode(seed, "constantPdaSeedNode")) return undefined;
  const value = seed.value;
  if (isNode(value, "bytesValueNode") && value.encoding === "base58") {
    return base58Decode(value.data).toString("utf8");
  }
  if (isNode(value, "bytesValueNode") && value.encoding === "base16") {
    return Buffer.from(value.data, "hex").toString("utf8");
  }
  if (isNode(value, "bytesValueNode") && value.encoding === "utf8") return value.data;
  if (isNode(value, "stringValueNode")) return value.string;
  return undefined;
}

function renamePdas(root, names) {
  const seen = new Set();
  const renamed = visit(
    root,
    bottomUpTransformerVisitor([
      {
        select: "[pdaNode]",
        transform: (node) => {
          const rule = names[node.name];
          if (!rule) return node;
          const seed = firstSeed(node);
          if (seed !== rule.seed) {
            throw new Error(
              `PDA "${node.name}": first seed ${JSON.stringify(seed)}, expected ${JSON.stringify(rule.seed)}`,
            );
          }
          seen.add(node.name);
          return pdaNode({ ...node, name: rule.name });
        },
      },
      {
        select: "[pdaLinkNode]",
        transform: (node) =>
          names[node.name] ? pdaLinkNode(names[node.name].name, node.program) : node,
      },
    ]),
  );
  for (const name of Object.keys(names)) {
    if (!seen.has(name)) throw new Error(`PDA "${name}" not found: update PDA_NAMES`);
  }
  return renamed;
}

for (const file of readdirSync(idlDir).filter((f) => f.endsWith(".json"))) {
  const idl = JSON.parse(readFileSync(join(idlDir, file), "utf8"));
  const name = file.replace(/\.json$/, "");
  let rootNode = rootNodeFromAnchor(idl);
  if (PDA_NAMES[name]) rootNode = renamePdas(rootNode, PDA_NAMES[name]);
  const codama = createFromRoot(rootNode);
  const target = join(outDir, name);
  codama.accept(
    renderVisitor(join(root, "clients", "js"), {
      generatedFolder: join("src", "generated", name),
      deleteFolderBeforeRendering: true,
      formatCode: false,
      syncPackageJson: false,
      kitImportStrategy: "preferRoot",
    }),
  );
  console.log(`${file} -> ${target}`);
}
