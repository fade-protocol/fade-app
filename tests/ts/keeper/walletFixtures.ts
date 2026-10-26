// A program history of a few wallets, for the wallet history's tests (keeper and app): tickets of
// both paths that pay out to a wallet (its USDC account the beneficiary), that its own app opened
// for others, or that it opened for itself; beacon tickets whose refund goes to the wallet or to
// another funder; payouts parked and claimed; and each wallet's deposits and withdrawals
// (requests, claims, deliveries). Also the app's own reading of it: the rows and items the app
// works out when it reads every transaction itself.
import { getBase58Decoder, type Address, type Signature } from "@solana/kit";
import {
  findIntegratorPda,
  getClaimDeliveredEventEncoder,
  getDepositClaimedEventEncoder,
  getDepositRequestedEventEncoder,
  getEpochStruckEventEncoder,
  getRoundPayoutClaimedEventEncoder,
  getRoundTicketReturnedEventEncoder,
  getRoundTicketSettledEventEncoder,
  getTicketExpiredEventEncoder,
  getTicketJoinedEventEncoder,
  getTicketOpenedEventEncoder,
  getTicketSettledEventEncoder,
  getWithdrawClaimedEventEncoder,
  getWithdrawRequestedEventEncoder,
} from "../../../clients/js/src/generated/fade/index.ts";
import { EVENT_IX_TAG, PROGRAM, USDC_MINT, ata, cfg } from "../../../apps/keeper/src/chain.ts";
import { programEventsOf, type FadeEvent } from "../../../apps/web/src/lib/fadeEvents.ts";
import { BPS, P_SCALE } from "../../../apps/web/src/lib/math.ts";
import {
  ticketLogOf,
  withBeaconMargins,
  type TicketRow,
  type TxEvents,
} from "../../../apps/web/src/lib/ticketRows.ts";
import {
  LP_KINDS,
  ownerItemsOf,
  walletRowsOf,
  type LpItem,
  type WalletKeys,
} from "../../../apps/web/src/lib/walletHistory.ts";
import { rng } from "../web/fixtures.ts";

export const HOUR = 3_600;
export const DAY = 86_400;
export const NOW = 1_800_000_000;
export const USDC = 1_000_000n;
const SHARE = 1_000_000_000n;

const b58 = (bytes: ArrayLike<number>) => getBase58Decoder().decode(Uint8Array.from(bytes));
export const A = (s: string) =>
  b58(Array.from({ length: 32 }, (_, i) => s.charCodeAt(i % s.length) + i)) as Address;
export const sig = (n: number) =>
  b58(Array.from({ length: 64 }, (_, i) => (i < 4 ? (n >> (i * 8)) & 255 : (i * 5 + 11) % 256)));
const emitted = (body: ArrayLike<number>) => b58([...EVENT_IX_TAG, ...Array.from(body)]);
/** A third app's integrator record, beside OTHER_APP. */
export const [THIRD_INTEGRATOR] = await findIntegratorPda(
  { integratorAuthority: A("ThirdApp") },
  cfg,
);

/** A transaction of the program emitting `datas`. */
export const eventTx = (...datas: string[]) => ({
  meta: {
    err: null as unknown,
    innerInstructions: [{ instructions: datas.map((data) => ({ programIdIndex: 1, data })) }],
  },
  transaction: {
    message: { accountKeys: [A("Payer"), PROGRAM] },
  },
});
export type Tx = ReturnType<typeof eventTx>;
export type HistoryTx = { signature: string; at: number; tx: Tx };

/** `Σ p·m` of a payout table whose margin is `bps`, and the table the beacon tickets join with. */
export const lhsFor = (bps: bigint) => (BPS - bps) * P_SCALE;
export const TABLE = A("Table");
export const TABLE_LHS = lhsFor(220n);
const ROUND = A("Round");
const OTHER_APP = A("OtherApp");
const FUNDER = A("FunderUsdc");

export const ev = {
  opened: (
    ticket: Address,
    integrator: Address,
    beneficiary: Address,
    price: bigint,
    payoutMax: bigint,
  ) =>
    emitted(
      getTicketOpenedEventEncoder().encode({
        version: 1,
        ticket,
        integrator,
        nonce: 1,
        beneficiary,
        price,
        vaultCredit: price - (price * 20n) / BPS,
        payoutMax,
        reservedLiability: payoutMax,
        cap: payoutMax,
        marginBps: 350n,
        appShareBps: 50n,
        openSlot: 10,
      }),
    ),
  joined: (
    ticket: Address,
    integrator: Address,
    beneficiary: Address,
    refundTo: Address,
    price: bigint,
  ) =>
    emitted(
      getTicketJoinedEventEncoder().encode({
        version: 1,
        ticket,
        round: ROUND,
        integrator,
        nonce: 1,
        beneficiary,
        refundTo,
        payoutTable: TABLE,
        price,
        vaultCredit: price - 700n,
        payoutMax: price * 2n,
        reservedLiability: price,
        cap: price,
        usage: price,
        protocolShare: 200n,
        appShare: 500n,
        prepay: 5_000,
        slot: 10,
        payer: A("Payer"),
        funder: A("Payer"),
        settleShare: 2_000,
      }),
    ),
  settled: (ticket: Address, integrator: Address, payout: bigint, pending: boolean) =>
    emitted(
      getTicketSettledEventEncoder().encode({
        version: 1,
        ticket,
        integrator,
        outcome: payout > 0n ? 0 : 1,
        payout,
        pending,
      }),
    ),
  roundSettled: (ticket: Address, integrator: Address, payout: bigint, pending: boolean) =>
    emitted(
      getRoundTicketSettledEventEncoder().encode({
        version: 1,
        ticket,
        round: ROUND,
        integrator,
        outcome: payout > 0n ? 0 : 1,
        payout,
        charge: 1_000n,
        pending,
      }),
    ),
  expired: (ticket: Address, integrator: Address) =>
    emitted(
      getTicketExpiredEventEncoder().encode({
        version: 2,
        ticket,
        integrator,
        forfeited: 0n,
        requested: false,
        requestFound: false,
        checked: true,
        pending: false,
        refunded: false,
        refund: 0n,
        parked: false,
        ticketForfeitsWithheld: 0n,
      }),
    ),
  /** A direct ticket refunded by `refund_expired_ticket`: its vault credit back, or parked. */
  refundedDirect: (ticket: Address, integrator: Address, refund: bigint, parked: boolean) =>
    emitted(
      getTicketExpiredEventEncoder().encode({
        version: 2,
        ticket,
        integrator,
        forfeited: 0n,
        requested: false,
        requestFound: false,
        checked: false,
        pending: false,
        refunded: true,
        refund,
        parked,
        ticketForfeitsWithheld: 1n,
      }),
    ),
  returned: (ticket: Address, refunded: boolean, parked: boolean) =>
    emitted(
      getRoundTicketReturnedEventEncoder().encode({
        version: 1,
        ticket,
        round: ROUND,
        refunded,
        price: 100_000,
        lamports: 5_000,
        parked,
        charge: 0,
      }),
    ),
  claimed: (ticket: Address) =>
    emitted(
      getRoundPayoutClaimedEventEncoder().encode({
        version: 1,
        ticket,
        destination: A("Ben"),
        amount: 1n,
      }),
    ),
  struck: (epochId: bigint) =>
    emitted(
      getEpochStruckEventEncoder().encode({
        version: 1,
        epochId,
        totalAssets: 1_000n * USDC,
        totalShares: 1_000n * SHARE,
        deposits: 0n,
        sharesMinted: 0n,
        withdrawShares: 0n,
        assetsOwed: 0n,
        assetsPaid: 0n,
        sharesBurnt: 0n,
        reward: 0n,
      }),
    ),
  deposit: (owner: Address, epochId: bigint, amount: bigint) =>
    emitted(getDepositRequestedEventEncoder().encode({ version: 1, owner, epochId, amount })),
  depositClaimed: (owner: Address, epochId: bigint, shares: bigint, delivered: boolean) =>
    emitted(
      getDepositClaimedEventEncoder().encode({ version: 1, owner, epochId, shares, delivered }),
    ),
  withdrawal: (owner: Address, epochId: bigint, shares: bigint) =>
    emitted(getWithdrawRequestedEventEncoder().encode({ version: 1, owner, epochId, shares })),
  withdrawClaimed: (
    owner: Address,
    epochId: bigint,
    assets: bigint,
    closed: boolean,
    delivered: boolean,
  ) =>
    emitted(
      getWithdrawClaimedEventEncoder().encode({
        version: 1,
        owner,
        epochId,
        atEpochId: epochId,
        assets,
        closed,
        delivered,
      }),
    ),
  delivered: (owner: Address, epochId: bigint, deposit: boolean, amount: bigint) =>
    emitted(
      getClaimDeliveredEventEncoder().encode({ version: 1, owner, epochId, deposit, amount }),
    ),
};

/** A wallet's keys, as the keeper and the app derive them. */
export async function walletKeys(owner: Address): Promise<WalletKeys> {
  const [[integrator], usdcAccount] = await Promise.all([
    findIntegratorPda({ integratorAuthority: owner }, cfg),
    ata(owner, USDC_MINT),
  ]);
  return { owner, integrator, usdcAccount };
}

export const WALLETS = [A("wallet-one"), A("wallet-two"), A("wallet-three")] as const;

/**
 * A random history over the last 10 days, oldest first, of `tickets` tickets and each wallet's
 * deposits and withdrawals. `first` numbers its signatures from there.
 */
export async function walletHistory(seed: number, tickets = 90, first = 0): Promise<HistoryTx[]> {
  const r = rng(seed);
  const keys = await Promise.all(WALLETS.map(walletKeys));
  const out: HistoryTx[] = [];
  let n = first;
  const push = (at: number, ...datas: string[]) =>
    out.push({ signature: sig(++n), at, tx: eventTx(...datas) });
  for (let i = 0; i < tickets; i++) {
    const w = keys[r.int(keys.length)]!;
    const ticket = A(`t${seed}-${i}`);
    // paid to the wallet by another app; its own app's for a customer; its own, for itself;
    // nobody's of these wallets
    const shape = r.int(4);
    const integrator =
      shape === 0 ? r.pick([OTHER_APP, THIRD_INTEGRATOR]) : shape === 3 ? OTHER_APP : w.integrator;
    const beneficiary =
      shape === 1 || shape === 3 ? A(`customer-${i}`) : r.pick([w.usdcAccount, w.owner]);
    const at = NOW - 10 * DAY + r.int(10 * DAY - HOUR);
    const end = at + 5 + r.int(600);
    const price = r.big(10_000n, 20n * USDC);
    if (r.int(3) === 0) {
      const refundTo = r.int(2) === 0 ? w.usdcAccount : FUNDER;
      push(at, ev.joined(ticket, integrator, beneficiary, refundTo, price));
      const k = r.int(6);
      if (k === 0) continue; // still drawing
      if (k === 1) push(end, ev.returned(ticket, true, r.int(2) === 0));
      else if (k === 2) push(end, ev.returned(ticket, false, false));
      else {
        const payout = k === 3 ? price * 2n : 0n;
        const parked = payout > 0n && r.int(2) === 0;
        push(end, ev.roundSettled(ticket, integrator, payout, parked));
        if (parked && r.int(2) === 0) push(end + 30, ev.claimed(ticket));
      }
    } else {
      const payoutMax = price * BigInt(2 + r.int(40));
      push(at, ev.opened(ticket, integrator, beneficiary, price, payoutMax));
      const k = r.int(6);
      if (k === 0) continue;
      if (k === 1) push(end, ev.expired(ticket, integrator));
      else
        push(
          end,
          ev.settled(ticket, integrator, k === 2 ? payoutMax : 0n, k === 2 && r.int(3) === 0),
        );
    }
  }
  let epoch = 1n;
  for (let t = NOW - 10 * DAY + r.int(HOUR); t < NOW; t += HOUR * (2 + r.int(8))) {
    const w = r.pick([...keys.map((k) => k.owner), A("someone-else")]);
    epoch += 1n;
    const k = r.int(3);
    if (k === 0) {
      push(t, ev.deposit(w, epoch, r.big(USDC, 100n * USDC)));
      push(
        t + 200,
        ev.struck(epoch),
        ev.depositClaimed(w, epoch, r.big(SHARE, 90n * SHARE), r.int(4) !== 0),
      );
    } else if (k === 1) {
      push(t, ev.withdrawal(w, epoch, r.big(SHARE, 10n * SHARE)));
      const delivered = r.int(3) !== 0;
      push(
        t + 200,
        ev.struck(epoch),
        ev.withdrawClaimed(w, epoch, r.big(USDC, 9n * USDC), true, delivered),
      );
      if (!delivered) push(t + 900, ev.delivered(w, epoch, false, r.big(USDC, 9n * USDC)));
    } else push(t, ev.struck(epoch));
  }
  return out.sort((a, b) => a.at - b.at || a.signature.localeCompare(b.signature));
}

/** The decoded events of each transaction, as the app reads them (lib/events `txDecoder`). */
export function appKnown(h: readonly HistoryTx[]): Map<Signature, TxEvents<FadeEvent>> {
  return new Map(
    h.map((x) => [x.signature as Signature, { events: programEventsOf(x.tx, PROGRAM) }]),
  );
}

/**
 * The app's own reading of a wallet's history over every transaction of `h`: its ticket rows
 * (lib/ticketRows `ticketLogOf`, its beacon margins read from the table) and its deposits and
 * withdrawals (lib/walletHistory `ownerItemsOf`), newest first.
 */
export function appWallet(
  h: readonly HistoryTx[],
  keys: WalletKeys,
): { rows: TicketRow[]; items: LpItem[] } {
  const newest = [...h].reverse();
  const known = appKnown(h);
  const sigs = newest.map((x) => ({ signature: x.signature as Signature, blockTime: x.at }));
  const log = withBeaconMargins(
    ticketLogOf(sigs, known, Infinity, 0),
    new Map([[TABLE, TABLE_LHS]]),
  );
  const items = newest.flatMap((x): LpItem[] => {
    const events = known.get(x.signature as Signature)!.events.filter((e) => LP_KINDS.has(e.kind));
    return events.length ? [{ signature: x.signature as Signature, blockTime: x.at, events }] : [];
  });
  return {
    rows: walletRowsOf(log.rows, keys).map(plainEnd),
    items: ownerItemsOf(items, keys.owner),
  };
}

/**
 * The row with its end as a `TicketEnd` alone: `ticketLogOf` keeps on a row the settlement it
 * read first (with its ticket, integrator and path), which the route does not carry.
 */
export function plainEnd(r: TicketRow): TicketRow {
  if (!r.end) return r;
  const { kind, payout, pending, refunded, at, signature } = r.end;
  return { ...r, end: { kind, payout, pending, ...(refunded ? { refunded } : {}), at, signature } };
}
