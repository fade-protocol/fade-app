import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeRpc, withDeadline } from "../../../apps/keeper/src/chain.ts";
import { guardedTick } from "../../../apps/keeper/src/beaconPolicy.ts";

describe("the beacon loop's tick guard", () => {
  it("returns the tick's delay and frees the slot", async () => {
    const state = { running: null as Promise<number> | null };
    expect(await guardedTick(state, async () => 1_234, 1_000)).toBe(1_234);
    await Promise.resolve();
    expect(state.running).toBeNull();
  });

  it("abandons a tick past its deadline, and starts no other while it still runs", async () => {
    const state = { running: null as Promise<number> | null };
    let finish: (v: number) => void = () => {};
    const hung = new Promise<number>((r) => (finish = r));
    await expect(guardedTick(state, () => hung, 20)).rejects.toThrow("tick still running after");
    let started = false;
    await expect(
      guardedTick(
        state,
        async () => {
          started = true;
          return 0;
        },
        20,
      ),
    ).rejects.toThrow("previous tick, abandoned, is still running");
    expect(started).toBe(false);
    // Once the abandoned tick returns, the next one runs.
    finish(5);
    await hung;
    await Promise.resolve();
    expect(await guardedTick(state, async () => 7, 20)).toBe(7);
  });

  it("passes a failing tick's error on and frees the slot", async () => {
    const state = { running: null as Promise<number> | null };
    await expect(
      guardedTick(
        state,
        async () => {
          throw new Error("boom");
        },
        1_000,
      ),
    ).rejects.toThrow("boom");
    await Promise.resolve();
    expect(state.running).toBeNull();
  });
});

describe("the keeper's RPC client", () => {
  let server: Server;
  let url = "";
  beforeAll(async () => {
    // An endpoint that accepts the request and never answers.
    server = createServer(() => {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("fails a request the endpoint never answers, at its deadline", async () => {
    const started = Date.now();
    await expect(makeRpc(url, 200).getSlot().send()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("clears its deadline once answered: no timer is left to keep the object from hibernating", async () => {
    const answering = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id } = JSON.parse(body) as { id: unknown };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: 42 }));
      });
    });
    await new Promise<void>((r) => answering.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(answering.address() as AddressInfo).port}`;
    const DEADLINE = 12_345;
    const set = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    try {
      expect(await makeRpc(at, DEADLINE).getSlot().send()).toBe(42n);
      const timers = set.mock.calls
        .map((c, i) => ({ delay: c[1], id: set.mock.results[i]?.value as unknown }))
        .filter((t) => t.delay === DEADLINE);
      expect(timers).toHaveLength(1);
      expect(clear.mock.calls.map((c) => c[0])).toContain(timers[0]!.id);
    } finally {
      set.mockRestore();
      clear.mockRestore();
      answering.closeAllConnections();
      answering.close();
    }
  });

  it("counts every attempt, each retry included: each is a subrequest", async () => {
    let calls = 0;
    const busy = createServer((req, res) => {
      calls++;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id } = JSON.parse(body) as { id: unknown };
        if (calls === 1) {
          res.statusCode = 429;
          res.end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: 7 }));
      });
    });
    await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(busy.address() as AddressInfo).port}`;
    let attempts = 0;
    try {
      expect(
        await makeRpc(at, 5_000, () => attempts++)
          .getSlot()
          .send(),
      ).toBe(7n);
      expect([calls, attempts]).toEqual([2, 2]);
    } finally {
      busy.closeAllConnections();
      busy.close();
    }
  });

  it("aborts at the deadline and clears it on a failure too", async () => {
    await expect(
      withDeadline(
        20,
        (signal) =>
          new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      ),
    ).rejects.toThrow("no answer in 20 ms");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    try {
      await expect(
        withDeadline(10_000, async () => Promise.reject(new Error("refused"))),
      ).rejects.toThrow("refused");
      expect(clear).toHaveBeenCalled();
    } finally {
      clear.mockRestore();
    }
  });
});
