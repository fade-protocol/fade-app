// The app's side of the keeper's liquidity providers (GET /v1/providers): reading the answer,
// against a local stub of the route serving what the keeper builds; weighing it against the
// latest read and its age; and choosing what the Providers table shows: the keeper's list with
// the connected wallet's own line read from the chain, the app's own scan while the keeper
// cannot serve, the keeper's kept answer until that scan arrives, never a blank once either is in.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getBase58Decoder, type Address, type Signature } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { providersView, type ProvidersView } from "../../../apps/keeper/src/providersIndex.ts";
import type { FadeEvent } from "../../../apps/web/src/lib/events.ts";
import type { DepositRequest, Vault, WithdrawRequest } from "../../../apps/web/src/lib/fade.ts";
import {
  TOKEN_ACCOUNT_SIZE,
  providerLines,
  providerRows,
  shareHoldersOf,
  type ProviderRow,
} from "../../../apps/web/src/lib/providers.ts";
import { USDC } from "./fixtures.ts";

const NOW = 1_800_000_000;
const SHARE = 1_000_000_000n;
const A = (s: string) => s.padEnd(32, "1") as Address;

const vault = {
  totalAssets: 10_000n * USDC,
  openVaultCredits: 400n * USDC,
  totalShares: 9_000n * SHARE,
} as Vault;
const holders = [
  { owner: A("big"), amount: 5_000n * SHARE },
  { owner: A("mid"), amount: 2_500n * SHARE },
  { owner: A("me"), amount: 1_000n * SHARE },
  { owner: A("small"), amount: 500n * SHARE },
];
const deposits = [
  {
    address: A("d1"),
    data: { owner: A("new"), amount: 300n * USDC, parked: false } as DepositRequest,
  },
];
const withdraws = [
  {
    address: A("w1"),
    data: { owner: A("mid"), shares: 400n * SHARE, rEntry: 0n, parked: false } as WithdrawRequest,
  },
];
const FIRST = new Map([
  [A("big"), NOW - 30 * 86_400],
  [A("me"), NOW - 3 * 86_400],
]);

/** What the keeper answers over these accounts. */
const keeperAnswer = (known = true, at = NOW): ProvidersView =>
  providersView({
    holders,
    deposits,
    withdraws,
    records: [],
    vault,
    firstDeposits: FIRST,
    firstDepositsKnown: known,
    now: at,
  });

let body: unknown = keeperAnswer();
let status = 200;
let requests = 0;
let server: Server;
let lib: typeof import("../../../apps/web/src/lib/keeperViews.ts");
beforeAll(async () => {
  server = createServer((req, res) => {
    requests += 1;
    if (req.url !== "/v1/providers") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.VITE_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // the app's config, read again with it
  vi.resetModules();
  lib = await import("../../../apps/web/src/lib/keeperViews.ts");
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("the keeper's providers, read by the app", () => {
  it("reads the answer at once, one request for every caller on the page, equal to the app's own list", async () => {
    body = keeperAnswer();
    status = 200;
    const before = requests;
    const [a, b] = await Promise.all([lib.fetchKeeperProviders(), lib.fetchKeeperProviders()]);
    expect(requests - before).toBe(1);
    expect(a).toBe(b);
    expect(a.syncing).toBe(false);
    expect(a.firstDepositsSyncing).toBe(false);
    expect(a.updatedAt).toBe(NOW);
    expect(a.lines).toEqual(
      providerLines(providerRows(holders, deposits, withdraws, []), vault, FIRST),
    );
    expect(lib.lastKeeperProviders()).toBe(a);
  });

  it("throws on a failing route or an unreadable body, the last answer kept", async () => {
    body = keeperAnswer();
    status = 200;
    const kept = await lib.fetchKeeperProviders();
    status = 503;
    await expect(lib.fetchKeeperProviders()).rejects.toThrow(/HTTP 503/);
    status = 200;
    body = { updatedAt: "now", rows: [{ owner: 3 }] };
    await expect(lib.fetchKeeperProviders()).rejects.toThrow(/unreadable/);
    expect(lib.lastKeeperProviders()).toBe(kept);
  });

  it("reads no first deposit as known when the answer does not say so", () => {
    const v = JSON.parse(JSON.stringify(keeperAnswer())) as Record<string, unknown>;
    delete v.firstDepositsSyncing;
    expect(lib.parseKeeperProviders(v)!.firstDepositsSyncing).toBe(true);
  });

  it("takes an answer as syncing once the latest read failed or it is older than 12 minutes", () => {
    const k = lib.parseKeeperProviders(JSON.parse(JSON.stringify(keeperAnswer())))!;
    expect(lib.providersAsRead(k, false, NOW + lib.PROVIDERS_MAX_AGE_S)!.syncing).toBe(false);
    expect(lib.providersAsRead(k, false, NOW + lib.PROVIDERS_MAX_AGE_S + 1)!.syncing).toBe(true);
    expect(lib.providersAsRead(k, true, NOW)!.syncing).toBe(true);
    expect(lib.providersAsRead(null, true, NOW)).toBeNull();
    expect(lib.needsOwn(lib.providersAsRead(k, false, NOW), false)).toBe(false);
    expect(lib.needsOwn(lib.providersAsRead(k, true, NOW), true)).toBe(true);
    // waiting for the first answer: a skeleton, no scan
    expect(lib.needsOwn(null, false)).toBe(false);
  });

  it("shows an answer remembered from an earlier page as it is until this page's first read settles", () => {
    const old = lib.parseKeeperProviders(JSON.parse(JSON.stringify(keeperAnswer())))!;
    const later = NOW + lib.PROVIDERS_MAX_AGE_S + 3_600;
    const weigh = (read: { data: typeof old | null; error: string | null; loading: boolean }) =>
      lib.keeperAsRead(read, old, lib.providersAsRead, later);
    // the first read pending: the remembered answer, no scan started
    const pending = weigh({ data: null, error: null, loading: true })!;
    expect(pending).toBe(old);
    expect(lib.needsOwn(pending, false)).toBe(false);
    // that read failed: the remembered answer shown, the app scans itself
    const failed = weigh({ data: null, error: "HTTP 503", loading: false })!;
    expect(failed.lines).toEqual(old.lines);
    expect(lib.needsOwn(failed, true)).toBe(true);
    // it brought the same outdated answer: the app scans itself
    expect(lib.needsOwn(weigh({ data: old, error: null, loading: false }), false)).toBe(true);
    // it brought a fresh one: that one, no scan
    const fresh = { ...old, updatedAt: later };
    expect(
      lib.keeperAsRead(
        { data: fresh, error: null, loading: false },
        old,
        lib.providersAsRead,
        later,
      ),
    ).toBe(fresh);
    // nothing remembered: a skeleton while waiting
    expect(
      lib.keeperAsRead(
        { data: null, error: null, loading: true },
        null,
        lib.providersAsRead,
        later,
      ),
    ).toBeNull();
  });
});

describe("the Providers table's list", () => {
  const keeper = () => lib.parseKeeperProviders(JSON.parse(JSON.stringify(keeperAnswer())))!;
  const scanned = () => providerRows(holders, deposits, withdraws, []);
  const row = (owner: Address, shares: bigint): ProviderRow => ({
    owner,
    shares,
    depositIn: 0n,
    sharesOut: 0n,
  });

  it("shows the keeper's list with the wallet's own line as the app reads it, re-ranked", () => {
    const live = { ...vault, totalShares: vault.totalShares + 5_000n * SHARE };
    const shown = lib.chooseProviders(keeper(), null, live, {
      owner: A("me"),
      row: row(A("me"), 6_000n * SHARE),
    })!;
    expect(shown.firstDeposits).toBe(true);
    expect(shown.lines[0]).toEqual({
      ...providerLines([row(A("me"), 6_000n * SHARE)], live)[0],
      // the first deposit the keeper read stays
      firstDepositAt: FIRST.get(A("me")),
    });
    // every other line the keeper's, in its order
    expect(shown.lines.slice(1)).toEqual(keeper().lines.filter((l) => l.owner !== A("me")));
  });

  it("adds a wallet the keeper does not list yet, and leaves out one that holds and asks for nothing", () => {
    const added = lib.chooseProviders(keeper(), null, vault, {
      owner: A("fresh"),
      row: { ...row(A("fresh"), 0n), depositIn: 10n * USDC },
    })!;
    expect(added.lines.length).toBe(keeper().lines.length + 1);
    expect(added.lines.at(-1)).toMatchObject({ owner: A("fresh"), firstDepositAt: null });
    const gone = lib.chooseProviders(keeper(), null, vault, { owner: A("me"), row: null })!;
    expect(gone.lines.map((l) => l.owner)).not.toContain(A("me"));
    // the wallet's own read not in yet: the keeper's line meanwhile
    expect(lib.chooseProviders(keeper(), null, vault, null)!.lines).toEqual(keeper().lines);
  });

  it("dates the wallet's own first deposit from its history when the keeper has not read it yet", () => {
    const at = NOW - 120;
    const requested = (owner: Address) =>
      ({ kind: "DepositRequested", data: { owner } }) as unknown as FadeEvent;
    const ownerLog = [
      { signature: "s3" as Signature, blockTime: at + 60, events: [requested(A("fresh"))] },
      { signature: "s2" as Signature, blockTime: at, events: [requested(A("fresh"))] },
      // another wallet's request, and an undated one, do not count
      { signature: "s1" as Signature, blockTime: at - 60, events: [requested(A("other"))] },
      { signature: "s0" as Signature, blockTime: null, events: [requested(A("fresh"))] },
    ];
    expect(lib.firstDepositIn(ownerLog, A("fresh"))).toBe(at);
    const own = { ...row(A("fresh"), 0n), depositIn: 10n * USDC };
    const added = lib.chooseProviders(keeper(), null, vault, {
      owner: A("fresh"),
      row: own,
      firstDepositAt: lib.firstDepositIn(ownerLog, A("fresh")),
    })!;
    expect(added.lines.find((l) => l.owner === A("fresh"))!.firstDepositAt).toBe(at);
    // on the app's own scan too
    const stale = lib.providersAsRead(keeper(), true, NOW)!;
    const scan = lib.chooseProviders(stale, [...scanned(), own], vault, {
      owner: A("fresh"),
      row: own,
      firstDepositAt: at,
    })!;
    expect(scan.lines.find((l) => l.owner === A("fresh"))!.firstDepositAt).toBe(at);
    // listed and in its history: the earliest of both
    const listed = FIRST.get(A("me"))!;
    const both = (own: number) =>
      lib
        .chooseProviders(keeper(), null, vault, {
          owner: A("me"),
          row: row(A("me"), 1_000n * SHARE),
          firstDepositAt: own,
        })!
        .lines.find((l) => l.owner === A("me"))!.firstDepositAt;
    expect(both(listed + 3_600)).toBe(listed);
    expect(both(listed - 3_600)).toBe(listed - 3_600);
    // fvUSDC received by transfer, no request anywhere: no date
    expect(lib.firstDepositIn([], A("gift"))).toBeNull();
  });

  it("keeps the line of a wallet whose fvUSDC sits outside its associated account, at its rank", () => {
    const me = getBase58Decoder().decode(new Uint8Array(32).fill(7)) as Address;
    const listed = holders.map((h) => (h.owner === A("me") ? { ...h, owner: me } : h));
    const answer = lib.parseKeeperProviders(
      JSON.parse(
        JSON.stringify(
          providersView({
            holders: listed,
            deposits,
            withdraws,
            records: [],
            vault,
            firstDeposits: new Map(),
            firstDepositsKnown: true,
            now: NOW,
          }),
        ),
      ),
    )!;
    // the token accounts the wallet owns, as getTokenAccountsByOwner returns them: its
    // associated account emptied, the fvUSDC in another one
    const tokenAccount = (amount: bigint) => {
      const d = new Uint8Array(TOKEN_ACCOUNT_SIZE);
      d.fill(9, 0, 32);
      d.set(new Uint8Array(32).fill(7), 32);
      new DataView(d.buffer).setBigUint64(64, amount, true);
      return d;
    };
    const vaultAuthority = getBase58Decoder().decode(new Uint8Array(32).fill(3)) as Address;
    const own = shareHoldersOf([tokenAccount(0n), tokenAccount(1_000n * SHARE)], vaultAuthority);
    expect(own).toEqual([{ owner: me, amount: 1_000n * SHARE }]);
    const shown = lib.chooseProviders(answer, null, vault, {
      owner: me,
      row: providerRows(own, [], [], [])[0] ?? null,
    })!;
    // the same list and count as every other visitor sees
    expect(shown.lines).toEqual(answer.lines);
    expect(shown.lines.map((l) => l.owner)).toContain(me);
  });

  it("falls back on the app's own scan, keeping the first deposits the keeper read", () => {
    const stale = lib.providersAsRead(keeper(), true, NOW)!;
    const own = lib.chooseProviders(stale, scanned(), vault, null)!;
    expect(own.lines).toEqual(providerLines(scanned(), vault, FIRST));
    expect(own.firstDeposits).toBe(true);
    // the keeper's answer kept until the scan arrives: never a blank
    expect(lib.chooseProviders(stale, null, vault, null)!.lines).toEqual(stale.lines);
    // no keeper at all: the scan alone, without first deposits
    const alone = lib.chooseProviders(null, scanned(), vault, null)!;
    expect(alone.firstDeposits).toBe(false);
    expect(alone.lines.every((l) => l.firstDepositAt === null)).toBe(true);
    // nothing in yet: a skeleton
    expect(lib.chooseProviders(null, null, vault, null)).toBeNull();
  });

  it("does not show first deposits while the keeper has not read back to them", () => {
    const syncing = lib.parseKeeperProviders(JSON.parse(JSON.stringify(keeperAnswer(false))))!;
    const shown = lib.chooseProviders(syncing, null, vault, null)!;
    expect(shown.firstDeposits).toBe(false);
    expect(shown.lines.every((l) => l.firstDepositAt === null)).toBe(true);
  });
});
