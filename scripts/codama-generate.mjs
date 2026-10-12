// Generate the TypeScript client (@solana/kit) from the committed IDLs.
// Output is committed under clients/js/src/generated so integrators and tests
// import a reviewed artefact; scripts/check-client-drift.sh fails CI when it
// is stale.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const idlDir = join(root, "idls");
const outDir = join(root, "clients", "js", "src", "generated");

for (const file of readdirSync(idlDir).filter((f) => f.endsWith(".json"))) {
  const idl = JSON.parse(readFileSync(join(idlDir, file), "utf8"));
  const codama = createFromRoot(rootNodeFromAnchor(idl));
  const name = file.replace(/\.json$/, "");
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
