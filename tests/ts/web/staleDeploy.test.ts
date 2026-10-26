// A tab from an older deploy reloads before it opens a ticket (apps/web/src/lib/staleDeploy.ts):
// it would otherwise read the ticket's end with its own build's event layouts. A build that
// cannot be read never blocks the flow.
import { describe, expect, it } from "vitest";
import {
  BUILD_FILE,
  liveBuild,
  reloadIfOlderBuild,
} from "../../../apps/web/src/lib/staleDeploy.ts";

const serving = (body: unknown, status = 200) =>
  (async (url: string | URL | Request) => {
    expect(String(url)).toBe(BUILD_FILE);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

describe("the deploy version check", () => {
  it("reloads a tab whose build is older than the one the site serves", async () => {
    let reloads = 0;
    const reload = () => (reloads++, true);
    expect(await reloadIfOlderBuild("old", serving({ build: "new" }), reload)).toBe(true);
    expect(reloads).toBe(1);
  });

  it("lets the flow start on the build the site serves", async () => {
    let reloads = 0;
    const reload = () => (reloads++, true);
    expect(await reloadIfOlderBuild("same", serving({ build: "same" }), reload)).toBe(false);
    expect(reloads).toBe(0);
  });

  it("lets the flow start when the reload guard refuses (a reload in the last 30 s)", async () => {
    expect(await reloadIfOlderBuild("old", serving({ build: "new" }), () => false)).toBe(false);
  });

  it("never blocks the flow on a build it cannot read", async () => {
    const reload = () => {
      throw new Error("no reload expected");
    };
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    expect(await reloadIfOlderBuild("old", failing, reload)).toBe(false);
    expect(await reloadIfOlderBuild("old", serving("Not found", 404), reload)).toBe(false);
    expect(await reloadIfOlderBuild("old", serving({ other: 1 }), reload)).toBe(false);
    // a bundle outside a production build (dev server, tests) has no build to compare
    expect(await reloadIfOlderBuild(null, serving({ build: "new" }), reload)).toBe(false);
    expect(await liveBuild(serving(null))).toBe(null);
  });
});
