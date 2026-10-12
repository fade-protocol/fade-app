// The app's Worker: an app route (a draw's link included) gets the single-page shell, anything
// that looks like a file and was not found gets a real 404, never the shell.
import { describe, expect, it } from "vitest";
import worker from "../../../apps/web/worker/index.ts";

const TICKET = "13uJdCsEg4J94KDNRPbsUCWQwYdhuG3ARvgLcUD5CfN8";

/** The Worker's answer to `path`, and the path it asked the static assets for, if any. */
async function serve(path: string, method = "GET") {
  let asked: string | null = null;
  const env = {
    ASSETS: {
      fetch: async (r: Request) => {
        asked = new URL(r.url).pathname;
        return new Response("<!doctype html>", { status: 200 });
      },
    },
  };
  const res = await worker.fetch(new Request(`https://app.fade.finance${path}`, { method }), env);
  return { status: res.status, asked: asked as string | null };
}

describe("the app's Worker", () => {
  it("serves the shell for a draw's link, valid or not", async () => {
    expect(await serve(`/w/${TICKET}`)).toEqual({ status: 200, asked: "/" });
    expect(await serve(`/w/${TICKET}/`)).toEqual({ status: 200, asked: "/" });
    expect(await serve("/w/not-a-ticket")).toEqual({ status: 200, asked: "/" });
    expect(await serve("/dashboard")).toEqual({ status: 200, asked: "/" });
  });

  it("keeps a real 404 for a missing file", async () => {
    expect(await serve("/assets/engine-x1y2.js")).toEqual({ status: 404, asked: null });
    expect(await serve("/logo.svg")).toEqual({ status: 404, asked: null });
    expect(await serve(`/w/${TICKET}.png`)).toEqual({ status: 404, asked: null });
  });

  it("refuses anything but a read", async () => {
    expect((await serve(`/w/${TICKET}`, "POST")).status).toBe(405);
  });
});
