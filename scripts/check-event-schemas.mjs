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
 * emitted with (from the Rust source: a literal, or the `EVENT_VERSION`
 * constant). Change the shape and the lock forces you to say whether the
 * version moved. It cannot see a pure semantic change; that is on the author
 * and docs/event-versions.md.
 *
 * Refresh deliberately:  pnpm events:lock
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const IDL_PATH = "idls/fade.json";
const LOCK_PATH = "events.lock.json";
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

/** The version each event is emitted with, from `Name { version: <literal|EVENT_VERSION>, ... }`. */
const emittedVersions = (constant) => {
  const found = new Map();
  const source = rustSources(SRC_DIR)
    .filter((p) => !p.endsWith("events.rs"))
    .map((p) => stripComments(readFileSync(p, "utf8")))
    .join("\n");
  for (const match of source.matchAll(/(\w+)\s*\{\s*version:\s*(\d+|EVENT_VERSION)/g)) {
    const [, name, raw] = match;
    const version = raw === "EVENT_VERSION" ? constant : Number(raw);
    const seen = found.get(name);
    if (seen !== undefined && seen !== version) {
      console.error(`✗ ${name} is emitted with two different versions (${seen} and ${version}).`);
      process.exit(1);
    }
    found.set(name, version);
  }
  return found;
};

const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
const types = new Map(idl.types.map((t) => [t.name, t]));
const versions = emittedVersions(eventVersionConstant());

const actual = {};
for (const event of idl.events ?? []) {
  const type = types.get(event.name);
  const fields = (type?.type?.fields ?? []).map((f) => `${f.name}:${JSON.stringify(f.type)}`);
  if (fields[0]?.split(":")[0] !== "version") {
    console.error(`✗ ${event.name}: 'version' must be the first field`);
    process.exit(1);
  }
  actual[event.name] = {
    version: versions.get(event.name) ?? null,
    shape: createHash("sha256").update(fields.join("|")).digest("hex").slice(0, 16),
  };
}

const unresolved = Object.entries(actual)
  .filter(([, v]) => v.version === null)
  .map(([name]) => name);
if (unresolved.length > 0) {
  console.error(`✗ no emit site with a 'version' found for: ${unresolved.join(", ")}`);
  process.exit(1);
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
