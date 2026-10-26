#!/usr/bin/env node
/**
 * Fails when an event's wire format changes without its schema `version` moving.
 *
 * Anchor's event discriminator is `sha256("event:<Name>")[..8]`: it hashes the
 * NAME, not the fields, so two incompatible versions of the same event are
 * indistinguishable on the wire. The `version: u8` every Fade event carries as
 * its first field is the only in-band signal an indexer can dispatch on.
 *
 * This check pins both halves in `events.lock.json`: the field list of every
 * event (from the IDL, so it tracks the real layout) and the version it is
 * emitted with (from the Rust source: a literal, the `EVENT_VERSION`
 * constant, or an event's own `*_VERSION: u8` constant in constants.rs). Change the shape and the lock forces you to say whether the
 * version moved. It cannot see a pure semantic change; that is on the author
 * and docs/event-versions.md.
 *
 * Only program code counts as an emit site: `#[cfg(test)]` items, and the files
 * of `#[cfg(test)] mod name;`, are ignored, so a test cannot stand in for an
 * instruction that forgets to emit. An event declared before the instruction
 * that emits it is listed in `events.pending.json` and locked at `EVENT_VERSION`;
 * the check fails when a listed event gains an emit site (take it off the list)
 * and when an unlisted event has none.
 *
 * Refresh deliberately:  pnpm events:lock
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const IDL_PATH = "idls/fade.json";
const LOCK_PATH = "events.lock.json";
const PENDING_PATH = "events.pending.json";
const SRC_DIR = "programs/fade/src";
const write = process.argv.includes("--write");

const rustSources = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? rustSources(path) : path.endsWith(".rs") ? [path] : [];
  });

const stripComments = (s) => s.replace(/\/\/.*$/gm, "");

/** `EVENT_VERSION` from constants.rs. */
const eventVersionConstant = () => {
  const src = stripComments(readFileSync(join(SRC_DIR, "constants.rs"), "utf8"));
  const m = src.match(/pub const EVENT_VERSION:\s*u8\s*=\s*(\d+)\s*;/);
  if (!m) {
    console.error("✗ EVENT_VERSION not found in constants.rs");
    process.exit(1);
  }
  return Number(m[1]);
};

/** Index just past the string, raw string or char literal opening at `i`, or `i` if none does. */
const skipLiteral = (src, i) => {
  const raw = /^b?r(#*)"/.exec(src.slice(i, i + 260));
  if (raw) {
    const end = src.indexOf(`"${raw[1]}`, i + raw[0].length);
    return end < 0 ? src.length : end + 1 + raw[1].length;
  }
  if (src[i] === '"') {
    let j = i + 1;
    while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  const char = /^'(?:\\.[^']*|[^\\'\n])'/.exec(src.slice(i, i + 16));
  return char ? i + char[0].length : i;
};

/** End of the item starting at `i`: its first `;` or its balanced `{ … }` block. */
const itemEnd = (src, i) => {
  let depth = 0;
  for (let j = i; j < src.length;) {
    const next = skipLiteral(src, j);
    if (next !== j) {
      j = next;
      continue;
    }
    const c = src[j];
    if (c === "{" || c === "(" || c === "[") depth += 1;
    else if (c === "}" || c === ")" || c === "]") {
      depth -= 1;
      if (depth === 0 && c === "}") return j + 1;
    } else if (c === ";" && depth === 0) return j + 1;
    j += 1;
  }
  return src.length;
};

/**
 * `src` without its `#[cfg(test)]` items, and the names of the `#[cfg(test)] mod name;`
 * it declares (their files are test-only too).
 */
const stripTestItems = (src) => {
  const testModules = [];
  let out = "";
  let from = 0;
  const attribute = /#\[\s*cfg\s*\(\s*test\s*\)\s*\]/g;
  for (let m = attribute.exec(src); m; m = attribute.exec(src)) {
    if (m.index < from) continue;
    const end = itemEnd(src, m.index + m[0].length);
    const item = src.slice(m.index + m[0].length, end);
    const mod = /^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/.exec(item);
    if (mod) testModules.push(mod[1]);
    out += src.slice(from, m.index);
    from = end;
    attribute.lastIndex = end;
  }
  return { code: out + src.slice(from), testModules };
};

/** Where `mod name;` declared in `file` lives: its file and its directory of submodules. */
const moduleLocation = (file, name) => {
  const stem = basename(file, ".rs");
  const dir = ["lib", "main", "mod"].includes(stem) ? dirname(file) : join(dirname(file), stem);
  return { files: [join(dir, `${name}.rs`), join(dir, name, "mod.rs")], dir: join(dir, name) };
};

/** The program's source, test-only code removed, keyed by file. */
const programSources = () => {
  const files = rustSources(SRC_DIR);
  const stripped = new Map();
  const excluded = { files: new Set(), dirs: [] };
  for (const file of files) {
    const { code, testModules } = stripTestItems(stripComments(readFileSync(file, "utf8")));
    stripped.set(file, code);
    for (const name of testModules) {
      const where = moduleLocation(file, name);
      where.files.forEach((f) => excluded.files.add(f));
      excluded.dirs.push(`${where.dir}/`);
    }
  }
  return [...stripped].filter(
    ([file]) => !excluded.files.has(file) && !excluded.dirs.some((d) => file.startsWith(d)),
  );
};

/** Every `pub const NAME_VERSION: u8 = N;` of constants.rs, `EVENT_VERSION` included. */
const versionConstants = () => {
  const src = stripComments(readFileSync(join(SRC_DIR, "constants.rs"), "utf8"));
  return new Map(
    [...src.matchAll(/pub const (\w+_VERSION):\s*u8\s*=\s*(\d+)\s*;/g)].map(([, n, v]) => [
      n,
      Number(v),
    ]),
  );
};

/** The version each event is emitted with, from `Name { version: <literal|CONSTANT>, ... }`. */
const emittedVersions = (constant) => {
  const constants = versionConstants();
  const found = new Map();
  const source = programSources()
    .filter(([p]) => !p.endsWith("events.rs"))
    .map(([, code]) => code)
    .join("\n");
  for (const match of source.matchAll(/(\w+)\s*\{\s*version:\s*(\d+|[A-Z_]+_VERSION)\b/g)) {
    const [, name, raw] = match;
    const version =
      raw === "EVENT_VERSION" ? constant : /^\d+$/.test(raw) ? Number(raw) : constants.get(raw);
    if (version === undefined) {
      console.error(
        `✗ ${name} is emitted with ${raw}, which constants.rs does not define as a u8.`,
      );
      process.exit(1);
    }
    const seen = found.get(name);
    if (seen !== undefined && seen !== version) {
      console.error(`✗ ${name} is emitted with two different versions (${seen} and ${version}).`);
      process.exit(1);
    }
    found.set(name, version);
  }
  return found;
};

/** Events declared before the instruction that emits them (`events.pending.json`). */
const pendingEvents = () => {
  let list;
  try {
    list = JSON.parse(readFileSync(PENDING_PATH, "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT") return new Set();
    console.error(`✗ ${PENDING_PATH} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const names = list?.declaredNotEmitted;
  if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
    console.error(`✗ ${PENDING_PATH}: 'declaredNotEmitted' must be an array of event names`);
    process.exit(1);
  }
  const set = new Set(names);
  if (set.size !== names.length) {
    console.error(`✗ ${PENDING_PATH} lists an event twice`);
    process.exit(1);
  }
  return set;
};

const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
const types = new Map(idl.types.map((t) => [t.name, t]));
const constant = eventVersionConstant();
const versions = emittedVersions(constant);
const pending = pendingEvents();

const idlEvents = new Set((idl.events ?? []).map((e) => e.name));
const coverage = [
  ...[...pending]
    .filter((name) => !idlEvents.has(name))
    .map((name) => `  ${name} is in ${PENDING_PATH} but not an event of the IDL: remove it.`),
  ...[...pending]
    .filter((name) => versions.has(name))
    .map((name) => `  ${name} is emitted now: remove it from ${PENDING_PATH}.`),
  ...[...idlEvents]
    .filter((name) => !pending.has(name) && !versions.has(name))
    .map(
      (name) =>
        `  ${name} has no emit site with a 'version' (test code does not count). Emit it, or list it in ${PENDING_PATH} if its instruction does not exist yet.`,
    ),
];
if (coverage.length > 0) {
  console.error(`✗ Event emit sites:\n${coverage.join("\n")}`);
  process.exit(1);
}

/**
 * `type` with every `{ defined }` it reaches carrying the layout of that type
 * (`of`), at any depth: inside vec, option, coption, array, generics and the
 * fields or variants of another defined type. Docs are dropped, since they are
 * not on the wire. A type already being expanded is marked `cycle` instead of
 * expanded again. A type with no `defined` comes back unchanged, so its hash
 * does not move.
 */
const expand = (type, stack = []) => {
  if (Array.isArray(type)) return type.map((t) => expand(t, stack));
  if (type === null || typeof type !== "object") return type;
  if ("defined" in type) {
    const ref = typeof type.defined === "string" ? { name: type.defined } : type.defined;
    const defined = expand(type.defined, stack);
    if (stack.includes(ref.name)) return { ...type, defined, cycle: true };
    const def = types.get(ref.name);
    if (!def) {
      console.error(`✗ type '${ref.name}' is not in the IDL's types`);
      process.exit(1);
    }
    const layout = Object.fromEntries(Object.entries(def).filter(([key]) => key !== "name"));
    return { ...type, defined, of: expand(layout, [...stack, ref.name]) };
  }
  return Object.fromEntries(
    Object.entries(type)
      .filter(([key]) => key !== "docs")
      .map(([key, value]) => [key, expand(value, stack)]),
  );
};

const actual = {};
for (const event of idl.events ?? []) {
  const type = types.get(event.name);
  const fields = (type?.type?.fields ?? []).map(
    (f) => `${f.name}:${JSON.stringify(expand(f.type, [event.name]))}`,
  );
  if (fields[0]?.split(":")[0] !== "version") {
    console.error(`✗ ${event.name}: 'version' must be the first field`);
    process.exit(1);
  }
  actual[event.name] = {
    version: pending.has(event.name) ? constant : versions.get(event.name),
    shape: createHash("sha256").update(fields.join("|")).digest("hex").slice(0, 16),
  };
}

if (write) {
  let previous = {};
  try {
    previous = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  } catch {
    // first lock
  }
  for (const [name, entry] of Object.entries(previous)) {
    if (!actual[name]) actual[name] = { ...entry, retired: true };
  }
  const retired = Object.values(actual).filter((v) => v.retired).length;
  writeFileSync(LOCK_PATH, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(
    `✓ wrote ${LOCK_PATH} (${Object.keys(actual).length - retired} events, ${retired} retired)`,
  );
  process.exit(0);
}

let locked;
try {
  locked = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
} catch {
  console.error(`✗ ${LOCK_PATH} is missing — create it with 'pnpm events:lock'.`);
  process.exit(1);
}

const problems = [];
for (const [name, now] of Object.entries(actual)) {
  const before = locked[name];
  if (before?.retired) {
    problems.push(
      `  ! ${name} is RETIRED but reappears in the IDL: its discriminator is burned, pick another name.`,
    );
    continue;
  }
  if (!before) {
    problems.push(`  + ${name} is new — it ships as v${now.version}.`);
    continue;
  }
  if (before.shape !== now.shape && before.version === now.version) {
    problems.push(
      `  ! ${name} changed shape but is still emitted as v${now.version}. Bump 'version' and document it in docs/event-versions.md.`,
    );
  } else if (before.shape !== now.shape) {
    problems.push(
      `  ~ ${name} changed shape and moved v${before.version} → v${now.version}. Confirm docs/event-versions.md records it.`,
    );
  } else if (before.version !== now.version) {
    problems.push(
      `  ~ ${name} moved v${before.version} → v${now.version} with no field change. Confirm docs/event-versions.md records it.`,
    );
  }
}
for (const [name, entry] of Object.entries(locked)) {
  if (!entry.retired && !actual[name])
    problems.push(`  - ${name} was removed; 'pnpm events:lock' keeps it as retired.`);
}

if (problems.length === 0) {
  console.log(`✓ event schemas match ${LOCK_PATH} (${Object.keys(actual).length} events)`);
  process.exit(0);
}
console.error(
  "✗ Event schema drift:\n" +
    problems.join("\n") +
    "\n\n  Once docs/event-versions.md is up to date:  pnpm events:lock\n",
);
process.exit(1);
