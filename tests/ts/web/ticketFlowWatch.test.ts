// The demos' payout flow (demos/useTicketFlow) following an Open ticket whose window closes with
// no draw, rendered with React and fake timers: the keeper answers "queued" on every tick and the
// chain is read every other tick only. Once a read shows the window closed, the flow says
// "Closing" on every tick, never offers to take over (there is nothing left to sign), and stops
// following the ticket CLOSE_WAIT_MS later.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, TransactionSigner } from "@solana/kit";
import { readFileSync } from "node:fs";

const chain = vi.hoisted(() => ({ reads: 0, expirySlot: 0n, closeAt: 0 }));

vi.mock("../../../apps/web/src/lib/keeper.ts", async (orig) => ({
  ...(await orig<typeof import("../../../apps/web/src/lib/keeper.ts")>()),
  submitTicket: async () => true,
  ticketStatus: async () => ({ state: "queued" }),
}));
vi.mock("../../../apps/web/src/lib/ticket.ts", async (orig) => {
  const { TicketStatus } = await import("../../../clients/js/src/generated/fade/index.ts");
  return {
    ...(await orig<typeof import("../../../apps/web/src/lib/ticket.ts")>()),
    // the slot passes the ticket's expiry at `closeAt`
    readTicket: async () => {
      chain.reads++;
      const slot = Date.now() < chain.closeAt ? chain.expirySlot : chain.expirySlot + 1n;
      return {
        gone: false,
        slot,
        fulfilled: false,
        ticket: {
          status: TicketStatus.Open,
          expirySlot: chain.expirySlot,
          randomness: "Randomness111111111111111111111111111111111",
          outcome: 0,
          payout: 0n,
        },
      };
    },
  };
});

// the little of a browser React DOM touches for a component that renders nothing
const target = () => ({
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true,
});
const document = { ...target(), activeElement: null };
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: { ...target(), document, HTMLIFrameElement: class {} },
  document,
});

// React and the hook, from the app's own packages, typed here by what the test uses
type Root = { render(node: unknown): void; unmount(): void };
type ReactApi = {
  createElement(type: () => null): unknown;
  act(fn: () => Promise<void>): Promise<void>;
};
const REACT = "../../../apps/web/node_modules/react/index.js";
const REACT_DOM = "../../../apps/web/node_modules/react-dom/client.js";
const { createElement, act } = (await import(REACT)) as ReactApi;
const { createRoot } = (await import(REACT_DOM)) as { createRoot(node: unknown): Root };
const { useTicketFlow, drawState, drawDetailShown, takeOverOffered, STALL_MS, CLOSE_WAIT_MS } =
  await import("../../../apps/web/src/demos/useTicketFlow.ts");
type Flow = ReturnType<typeof useTicketFlow>;

const TICKET = "Ticket1111111111111111111111111111111111111" as Address;
const signer = { address: "Wa11et1111111111111111111111111111111111111" } as TransactionSigner;

let flow: Flow | null = null;
function Page() {
  flow = useTicketFlow();
  return null;
}

async function mounted() {
  const node = {
    ...target(),
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: globalThis.document,
  };
  const root = createRoot(node);
  await act(async () => root.render(createElement(Page)));
  return root;
}

const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("an Open ticket past its window, followed by the demos' flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    chain.reads = 0;
    chain.expirySlot = 1_000n;
    // long enough in its window for the queued draw to count as stalled
    chain.closeAt = Date.now() + STALL_MS + 10_000;
  });
  afterEach(() => vi.useRealTimers());

  it("says Closing on every tick, with no take-over offered, until it stops following it", async () => {
    const root = await mounted();
    await act(async () => void flow!.resume(signer, TICKET));
    // in its window, past STALL_MS with no progress: the take-over is offered
    await pass(STALL_MS + 5_000);
    expect(flow!.state.stalled).toBe(true);
    expect(flow!.state.windowClosed).toBe(false);
    // the first read past the expiry
    while (!flow!.state.windowClosed) await pass(1_000);
    const closedAt = Date.now();
    const readsAtClose = chain.reads;
    const seen: { closed: boolean; stalled: boolean; state: string; shown: boolean }[] = [];
    while (flow!.state.phase === "drawing" && Date.now() - closedAt < CLOSE_WAIT_MS + 10_000) {
      await pass(1_000);
      const s = flow!.state;
      if (s.phase === "drawing")
        seen.push({
          closed: s.windowClosed,
          stalled: s.stalled,
          state: drawState(s),
          shown: drawDetailShown(s),
        });
    }
    // the chain read every other tick only: the ticks without a read keep the window closed
    expect(chain.reads - readsAtClose).toBeLessThan(seen.length);
    expect(seen.length).toBeGreaterThan(CLOSE_WAIT_MS / 1_000 - 5);
    for (const s of seen)
      expect(s).toEqual({ closed: true, stalled: false, state: "Closing", shown: true });
    expect(flow!.state.phase).toBe("failed");
    expect(flow!.state.failure?.message).toContain("The draw window closed with no draw");
    // next to a checkout "refund" reads as the order refunded, while the sale stands
    expect(flow!.state.failure?.message).toContain(
      "the draw is cancelled and its credit comes back",
    );
    expect(flow!.state.failure?.message).not.toMatch(/refund/i);
    // nothing for the wallet to sign: only following it again is offered
    expect(takeOverOffered(flow!.state)).toBe(false);
    expect(Date.now() - closedAt).toBeGreaterThan(CLOSE_WAIT_MS);
    await act(async () => root.unmount());
  });

  it("names a direct refund a cancelled draw in both closed-window failures, keeper up or down", () => {
    const src = readFileSync("apps/web/src/demos/useTicketFlow.ts", "utf8");
    const messages = src.match(/"The draw window closed with no draw[^"]*"/g) ?? [];
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m).toContain("the draw is cancelled and its credit comes back");
      expect(m).not.toMatch(/refund/i);
      // the builders' words stay in the docs
      expect(m).not.toMatch(/settle|forfeit|expir|anyone can send/i);
    }
  });
});
