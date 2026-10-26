// scripts/check-event-schemas.mjs reads each event's version from its emit site.
// Test code must not count as one, or an instruction that forgets to emit passes
// the check; an event declared before its instruction is listed, explicitly, in
// events.pending.json. Each case runs the script on a small fixture tree.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve("scripts/check-event-schemas.mjs");
const roots: string[] = [];

const event = (name: string) => ({
  name,
  type: {
    kind: "struct",
    fields: [
      { name: "version", type: "u8" },
      { name: "amount", type: "u64" },
    ],
  },
});

/** A fixture with events `Emitted` and `Declared`, and the given program files. */
const fixture = (files: Record<string, string>, pending?: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "fade-events-"));
  roots.push(root);
  const all: Record<string, string> = {
    "idls/fade.json": JSON.stringify({
      events: [{ name: "Emitted" }, { name: "Declared" }],
      types: [event("Emitted"), event("Declared")],
    }),
    "programs/fade/src/constants.rs": "pub const EVENT_VERSION: u8 = 1;\n",
    "programs/fade/src/events.rs": "pub struct Emitted { pub version: u8 }\n",
    ...files,
  };
  if (pending) all["events.pending.json"] = JSON.stringify({ declaredNotEmitted: pending });
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

const run = (root: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const EMIT = (name: string) => `emit_cpi!(${name} { version: EVENT_VERSION, amount: 1 });`;
const PROGRAM = `pub fn handler() {\n    ${EMIT("Emitted")}\n}\n`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("check-event-schemas emit sites", () => {
  it("passes with a real emit site and the undeclared one listed as pending", () => {
    const root = fixture({ "programs/fade/src/lib.rs": PROGRAM }, ["Declared"]);
    expect(run(root, "--write").status).toBe(0);
    expect(run(root)).toMatchObject({ status: 0 });
  });

  it("does not count a #[cfg(test)] module file as an emit site", () => {
    const root = fixture({
      "programs/fade/src/lib.rs": `#[cfg(test)]\nmod event_tests;\n${PROGRAM}`,
      "programs/fade/src/event_tests.rs": `fn t() { ${EMIT("Declared")} }\n`,
    });
    const r = run(root, "--write");
    expect(r.status).toBe(1);
    expect(r.out).toContain("Declared has no emit site");
  });

  it("does not count an inline #[cfg(test)] module, braces in strings included", () => {
    const root = fixture({
      "programs/fade/src/lib.rs": `${PROGRAM}#[cfg(test)]\nmod tests {\n    fn t() { let _ = "}"; let _ = '{'; ${EMIT("Declared")} }\n}\n`,
    });
    const r = run(root, "--write");
    expect(r.status).toBe(1);
    expect(r.out).toContain("Declared has no emit site");
  });

  it("keeps program code after a #[cfg(test)] item", () => {
    const root = fixture(
      {
        "programs/fade/src/lib.rs": `#[cfg(test)]\nmod tests { fn t() { let _ = "}"; } }\n${PROGRAM}`,
      },
      ["Declared"],
    );
    expect(run(root, "--write").status).toBe(0);
  });

  it("fails when a pending event gains a real emit site", () => {
    const root = fixture(
      { "programs/fade/src/lib.rs": `${PROGRAM}pub fn other() { ${EMIT("Declared")} }\n` },
      ["Declared"],
    );
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Declared is emitted now: remove it from events.pending.json");
  });

  it("fails when the pending list names an event the IDL does not have", () => {
    const root = fixture({ "programs/fade/src/lib.rs": PROGRAM }, ["Declared", "Ghost"]);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Ghost is in events.pending.json but not an event of the IDL");
  });

  it("locks a pending event at EVENT_VERSION", () => {
    const root = fixture({ "programs/fade/src/lib.rs": PROGRAM }, ["Declared"]);
    expect(run(root, "--write").status).toBe(0);
    // The emit site then appears at another version: off the list, the drift shows.
    writeFileSync(
      join(root, "programs/fade/src/lib.rs"),
      `${PROGRAM}pub fn other() { emit_cpi!(Declared { version: 2, amount: 1 }); }\n`,
    );
    writeFileSync(join(root, "events.pending.json"), JSON.stringify({ declaredNotEmitted: [] }));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Declared moved v1 → v2");
  });
});

describe("check-event-schemas nested types", () => {
  const outcome = (fields: object[]) => ({
    name: "Outcome",
    docs: ["One outcome."],
    type: { kind: "struct", fields },
  });
  const P = { name: "p", docs: ["Probability."], type: "u64" };
  const M = { name: "m", type: "u64" };
  /** `Emitted` embeds `Outcome` through `vec<option<[Outcome; 2]>>`; `Node` refers to itself. */
  const idl = (outcomeType: object, node: object = { kind: "struct", fields: [] }) =>
    JSON.stringify({
      events: [{ name: "Emitted" }],
      types: [
        {
          name: "Emitted",
          type: {
            kind: "struct",
            fields: [
              { name: "version", type: "u8" },
              {
                name: "outcomes",
                type: { vec: { option: { array: [{ defined: { name: "Outcome" } }, 2] } } },
              },
              { name: "tree", type: { defined: { name: "Node" } } },
            ],
          },
        },
        outcomeType,
        { name: "Node", type: node },
      ],
    });
  const relock = (root: string, content: string) => {
    writeFileSync(join(root, "idls/fade.json"), content);
    return run(root);
  };
  const SELF = {
    kind: "enum",
    variants: [
      { name: "Leaf" },
      { name: "Branch", fields: [{ vec: { defined: { name: "Node" } } }] },
    ],
  };

  it("fails when a nested defined type changes shape", () => {
    const root = fixture({
      "idls/fade.json": idl(outcome([P, M]), SELF),
      "programs/fade/src/lib.rs": PROGRAM,
    });
    expect(run(root, "--write").status).toBe(0);
    const r = relock(root, idl(outcome([P, M, { name: "extra", type: "u8" }]), SELF));
    expect(r.status).toBe(1);
    expect(r.out).toContain("Emitted changed shape but is still emitted as v1");
  });

  it("fails when a type nested two levels deep changes, through a recursive type", () => {
    const deep = (leaf: string) => ({
      kind: "enum",
      variants: [
        { name: "Leaf", fields: [leaf] },
        { name: "Branch", fields: [{ vec: { defined: { name: "Node" } } }] },
      ],
    });
    const root = fixture({
      "idls/fade.json": idl(outcome([P, M]), deep("u8")),
      "programs/fade/src/lib.rs": PROGRAM,
    });
    expect(run(root, "--write").status).toBe(0);
    const r = relock(root, idl(outcome([P, M]), deep("u16")));
    expect(r.status).toBe(1);
    expect(r.out).toContain("Emitted changed shape");
  });

  it("ignores a docs-only change of a nested type", () => {
    const root = fixture({
      "idls/fade.json": idl(outcome([P, M]), SELF),
      "programs/fade/src/lib.rs": PROGRAM,
    });
    expect(run(root, "--write").status).toBe(0);
    const reworded = { ...outcome([{ ...P, docs: ["Reworded."] }, M]), docs: [] };
    expect(relock(root, idl(reworded, SELF)).status).toBe(0);
  });

  it("fails on a defined type the IDL does not declare", () => {
    const root = fixture({
      "idls/fade.json": idl({ name: "Other", type: { kind: "struct", fields: [] } }),
      "programs/fade/src/lib.rs": PROGRAM,
    });
    const r = run(root, "--write");
    expect(r.status).toBe(1);
    expect(r.out).toContain("type 'Outcome' is not in the IDL's types");
  });
});
