// The wallet history's polling (lib/hooks `useWalletTickets` over `usePolling`), rendered with
// React and fake timers: while the keeper's notifications are confirmed and its answer is fresh,
// the page reads once on mount, then once per WALLET_LIVE_POLL_MS however often it re-renders;
// the interval is chosen when each poll is scheduled, so a new `through` or the clock never
// start a read; notifications lost bring the pending poll forward to WALLET_POLL_MS, no read at
// once; a notification that arrives while the tab is hidden reads the moment it is shown. And a
// keeper route's polling (`usePolling` with its push): a pushed answer that does not read leaves
// the topic not live, says so in `error`, and the polls start again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@solana/kit";

const reads = vi.hoisted(() => ({ n: 0, lag: 30 }));
const push = vi.hoisted(() => ({
  on: true,
  watchers: new Set<() => void>(),
  wallet: null as null | ((m: unknown) => void),
  topic: null as null | ((data: unknown, at: number | null) => void),
  topicLive: false,
}));

vi.mock("../../../apps/web/src/lib/keeperWallet.ts", () => ({
  markWalletChanged: () => {},
  walletTicketsRead: async (owner: string) => {
    reads.n++;
    return {
      tickets: { owner, rows: [] },
      through: Math.floor(Date.now() / 1_000) - reads.lag,
    };
  },
}));
vi.mock("../../../apps/web/src/lib/live.ts", async (orig) => ({
  ...(await orig<typeof import("../../../apps/web/src/lib/live.ts")>()),
  live: {
    watch: (cb: () => void) => {
      push.watchers.add(cb);
      return () => push.watchers.delete(cb);
    },
    wallet: (_owner: string, cb: (m: unknown) => void) => {
      push.wallet = cb;
      return () => {};
    },
    walletLive: () => push.on,
    topic: (_t: string, cb: (data: unknown, at: number | null) => void) => {
      push.topic = cb;
      return () => {};
    },
    isLive: () => push.topicLive,
  },
}));

// the little of a browser `usePolling` and React DOM touch for a component that renders nothing
const target = () => ({
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true,
});
const listeners = new Map<string, Set<() => void>>();
const document = {
  ...target(),
  visibilityState: "visible" as "visible" | "hidden",
  activeElement: null,
  addEventListener(type: string, cb: () => void) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(cb);
  },
  removeEventListener(type: string, cb: () => void) {
    listeners.get(type)?.delete(cb);
  },
};
/** The tab hidden or shown, as the browser tells the page. */
const setHidden = (hidden: boolean) => {
  document.visibilityState = hidden ? "hidden" : "visible";
  for (const cb of [...(listeners.get("visibilitychange") ?? [])]) cb();
};
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: { ...target(), document, HTMLIFrameElement: class {} },
  document,
});

// React and the hook, from the app's own packages: the app's code is typechecked by its own
// config (DOM and JSX), these modules are loaded by path and typed here by what the test uses
type Root = { render(node: unknown): void; unmount(): void };
type ReactApi = {
  createElement(type: () => null): unknown;
  act(fn: () => Promise<void>): Promise<void>;
  useEffect(fn: () => () => void, deps: unknown[]): void;
  useState(v: number): [number, (f: (n: number) => number) => void];
};
const REACT = "../../../apps/web/node_modules/react/index.js";
const REACT_DOM = "../../../apps/web/node_modules/react-dom/client.js";
const HOOKS = "../../../apps/web/src/lib/hooks.tsx";
const { createElement, act, useEffect, useState } = (await import(REACT)) as ReactApi;
const { createRoot } = (await import(REACT_DOM)) as { createRoot(node: unknown): Root };
type Polled = { data: unknown; error: string | null; loading: boolean };
const { useWalletTickets, usePolling } = (await import(HOOKS)) as {
  useWalletTickets(owner: Address): unknown;
  usePolling(
    fn: () => Promise<unknown>,
    ms: number,
    deps: unknown[],
    live: { topic: string; parse: (j: unknown, at: number | null) => unknown },
  ): Polled;
};
const { WALLET_LIVE_POLL_MS, WALLET_POLL_MS } = await import("../../../apps/web/src/lib/live.ts");

const OWNER = "Wa11et1111111111111111111111111111111111111" as Address;
const RENDER_EVERY_MS = 10_000;

/** A page holding the wallet's tickets, rendered again every RENDER_EVERY_MS (as the Dashboard is). */
function Page() {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), RENDER_EVERY_MS);
    return () => clearInterval(t);
  }, []);
  useWalletTickets(OWNER);
  return null;
}

/** A page polling a keeper route that the keeper also pushes. */
const routeReads = { n: 0, fail: false, last: null as Polled | null };
function RoutePage() {
  routeReads.last = usePolling(
    async () => {
      routeReads.n++;
      if (routeReads.fail) throw new Error("the vault history service answered an unreadable body");
      return { n: routeReads.n };
    },
    30_000,
    [],
    { topic: "vault", parse: (j: unknown) => (j && typeof j === "object" && "ok" in j ? j : null) },
  );
  return null;
}

async function mounted(page: () => null = Page) {
  const node = {
    ...target(),
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: globalThis.document,
  };
  const root = createRoot(node);
  await act(async () => root.render(createElement(page)));
  return root;
}

const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("the wallet history's polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    reads.n = 0;
    reads.lag = 30;
    push.on = true;
    push.topicLive = false;
    routeReads.n = 0;
    routeReads.fail = false;
    document.visibilityState = "visible";
  });
  afterEach(() => vi.useRealTimers());

  it("reads once on mount, then once per live interval while the keeper is fresh", async () => {
    const root = await mounted();
    expect(reads.n).toBe(1);
    await pass(WALLET_LIVE_POLL_MS - 1_000);
    expect(reads.n).toBe(1);
    await pass(1_000);
    expect(reads.n).toBe(2);
    await pass(WALLET_LIVE_POLL_MS * 2);
    expect(reads.n).toBe(4);
    await act(async () => root.unmount());
  });

  it("does not read when the interval the clock gives changes between two polls", async () => {
    // the keeper's answer lags near the freshness bound: by the next render it is past it
    reads.lag = 140;
    const root = await mounted();
    expect(reads.n).toBe(1);
    await pass(WALLET_LIVE_POLL_MS - 1_000);
    expect(reads.n).toBe(1);
    await pass(1_000);
    expect(reads.n).toBe(2);
    await pass(WALLET_LIVE_POLL_MS * 2);
    expect(reads.n).toBe(4);
    await act(async () => root.unmount());
  });

  it("polls at the usual pace while the keeper's answer is stale", async () => {
    reads.lag = 200;
    const root = await mounted();
    expect(reads.n).toBe(1);
    await pass(WALLET_POLL_MS - 1_000);
    expect(reads.n).toBe(1);
    await pass(1_000);
    expect(reads.n).toBe(2);
    await pass(WALLET_POLL_MS * 4);
    expect(reads.n).toBe(6);
    await act(async () => root.unmount());
  });

  it("brings a pending poll forward when the notifications stop, without reading at once", async () => {
    const root = await mounted();
    await pass(20_000);
    expect(reads.n).toBe(1);
    push.on = false;
    await act(async () => push.watchers.forEach((cb) => cb()));
    expect(reads.n).toBe(1);
    await pass(WALLET_POLL_MS - 1_000);
    expect(reads.n).toBe(1);
    await pass(1_000);
    expect(reads.n).toBe(2);
    await pass(WALLET_POLL_MS);
    expect(reads.n).toBe(3);
    await act(async () => root.unmount());
  });

  it("reads at once when shown again after a notification that arrived while the tab was hidden", async () => {
    const root = await mounted();
    expect(reads.n).toBe(1);
    // hidden, then the keeper indexes the wallet's settled ticket within the 30 s it stays open
    await act(async () => setHidden(true));
    await pass(15_000);
    await act(async () => push.wallet?.({ type: "wallet", signatures: ["s"], at: null }));
    await pass(5_000);
    // nothing read while hidden
    expect(reads.n).toBe(1);
    await pass(60_000);
    expect(reads.n).toBe(1);
    // shown: exactly one read, at once, not at the next poll two minutes away
    await act(async () => setHidden(false));
    await pass(0);
    expect(reads.n).toBe(2);
    await pass(10_000);
    expect(reads.n).toBe(2);
    await act(async () => root.unmount());
  });

  it("does not read on show when no poll came due while hidden", async () => {
    const root = await mounted();
    await act(async () => setHidden(true));
    await pass(10_000);
    await act(async () => setHidden(false));
    await pass(0);
    expect(reads.n).toBe(1);
    await act(async () => root.unmount());
  });

  it("polls again, its error said, while the keeper pushes answers that do not read", async () => {
    const root = await mounted(RoutePage);
    expect(routeReads.n).toBe(1);
    // live, its answers read: no poll
    push.topicLive = true;
    await act(async () => {
      push.watchers.forEach((cb) => cb());
      push.topic?.({ ok: true }, 1_800_000_000);
    });
    await pass(90_000);
    expect(routeReads.n).toBe(1);
    expect(routeReads.last).toMatchObject({ data: { ok: true }, error: null, loading: false });
    // an answer of a shape this app cannot read (a keeper deployed before it): the polls decide
    await act(async () => push.topic?.({ changed: true }, 1_800_000_090));
    await pass(0);
    expect(routeReads.n).toBe(2);
    expect(routeReads.last!.loading).toBe(false);
    await pass(30_000);
    expect(routeReads.n).toBe(3);
    // and once a pushed answer reads again, the topic is live again: the polls stop
    await act(async () => push.topic?.({ ok: true }, 1_800_000_150));
    const n = routeReads.n;
    await pass(90_000);
    expect(routeReads.n).toBe(n);
    await act(async () => root.unmount());
  });

  it("ends with an error, never loading for good, when neither the push nor the route reads", async () => {
    // the route's own answer does not read either: its error is what starts the app's own reads
    routeReads.fail = true;
    push.topicLive = true;
    const root = await mounted(RoutePage);
    await act(async () => push.watchers.forEach((cb) => cb()));
    const n = routeReads.n;
    await act(async () => push.topic?.({ changed: true }, null));
    await pass(0);
    expect(routeReads.n).toBe(n + 1);
    expect(routeReads.last).toMatchObject({ data: null, loading: false });
    expect(routeReads.last!.error).toMatch(/unreadable/);
    await act(async () => root.unmount());
  });
});
