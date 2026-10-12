// Demo B: a swap in a wallet whose trade might be won back. Every control is in
// the wallet on the left; the panel on the right only reads out the terms and
// the draw. The swap leg is simulated on devnet (no SOL moves, an indicative
// price); the payout that may pay back the trade's value is a real ticket,
// opened with the same all-or-nothing payout table as the checkout, sized to the
// trade and kept within the vault's live cap.
import { useMemo, useState } from "react";
import { FaucetButton } from "../components/FaucetButton";
import { ScrollArea } from "../components/scroll";
import { swapDefaultTicket } from "../lib/chances";
import { fixed, sol, usdc } from "../lib/format";
import { payout } from "../lib/math";
import {
  DEMO_APP_SHARE_BPS,
  LAMPORTS_PER_SOL,
  SOL_PRICE,
  SWAP_PRESETS_LAMPORTS,
  largestWinBack,
  winBackPayoutTable,
  swapOut,
} from "../lib/payoutTables";
import { snapTicket } from "../lib/tickets";
import { ConnectButton } from "../wallet/ConnectButton";
import { useWallet } from "../wallet/WalletProvider";
import {
  ResumeNotice,
  SolFallback,
  missingFunds,
  shareWinOf,
  useRecordResult,
  type Live,
  type WalletFunds,
} from "./common";
import { Odds } from "./Odds";
import { Progress } from "./Progress";
import { SwapWallet, type TicketOption } from "./SwapWallet";
import { odds, useWinBackTickets } from "./TicketPicker";
import { useDevSimulation } from "./devSimulation";
import {
  isBusy,
  isHalved,
  vaultOf,
  predict,
  useTicketFlow,
  type DrawResult,
} from "./useTicketFlow";

const isWin = (b: number) => b === 0;

/** The round tickets the wallet's selector lists, besides the smallest and the largest. */
const LISTED = new Set([
  250_000n,
  500_000n,
  1_000_000n,
  2_500_000n,
  5_000_000n,
  10_000_000n,
  25_000_000n,
  50_000_000n,
]);

const byAmount = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** "0.5" SOL to lamports; null unless a plain decimal with at most 9 places. */
function parseSol(input: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{0,9}))?$/.exec(input.trim());
  if (!m) return null;
  return BigInt(m[1] ?? "0") * LAMPORTS_PER_SOL + BigInt((m[2] ?? "").padEnd(9, "0") || "0");
}

const solText = (lamports: bigint) => sol(lamports, 4).replace(/\.?0+$/, "");

export function SwapDemo({ state, funds }: { state: Live; funds: WalletFunds | null }) {
  const { signer, account } = useWallet();
  const flow = useDevSimulation("swap", useTicketFlow(), (outcome): DrawResult => ({
    outcome,
    payout: outcome === 0 ? out + price : 0n,
    pending: false,
    sig: null,
  }));
  const s = flow.state;
  const busy = isBusy(s);
  const minPrice = state.config.params.minPrice;
  const [input, setInput] = useState("0.5");
  const [locked, setLocked] = useState<bigint | null>(null);
  // The ticket the user picked; null until they pick one, so every trade starts on its default.
  const [wanted, setWanted] = useState<bigint | null>(null);

  // The largest trade the vault can pay back, at the smallest ticket: a larger
  // ticket only lowers the vault's worst case, so every ticket fits it too.
  const maxWinBack = useMemo(
    () =>
      largestWinBack({
        price: minPrice,
        params: state.config.params,
        vault: vaultOf(state),
        halved: isHalved(state),
      }),
    [state, minPrice],
  );
  const maxLamports = (maxWinBack * LAMPORTS_PER_SOL) / SOL_PRICE;

  const parsed = parseSol(input);
  const lamports = locked ?? parsed ?? 0n;
  const out = swapOut(lamports);
  const tooSmall = out < minPrice * 2n;
  const tooLarge = out > maxWinBack;
  const valid = parsed !== null && !tooSmall && !tooLarge;
  const { steps, accepts } = useWinBackTickets(state, valid || locked !== null ? out : 0n);
  // The trade's default ticket: the cent that reaches its chance, seldom a slider step, so it
  // joins the tickets offered.
  const anchor =
    steps.length === 0 ? null : swapDefaultTicket(out, state.config.params, steps, accepts);
  const choices = useMemo(
    () => (anchor === null || steps.includes(anchor) ? steps : [...steps, anchor].sort(byAmount)),
    [steps, anchor],
  );
  const picked =
    anchor === null ? minPrice : wanted === null ? anchor : snapTicket(choices, wanted);
  // Once opened, the ticket's own price is the one shown: a resumed payout may differ.
  const price = s.onchain?.price ?? picked;
  const outcomes = valid || locked !== null ? winBackPayoutTable(price, out) : null;
  const win = outcomes?.[0];
  const q = outcomes ? predict(state, outcomes, price, DEMO_APP_SHARE_BPS) : null;
  const missing = busy ? null : missingFunds(funds, price);
  useRecordResult(s, "Swap", isWin);

  const options: TicketOption[] = useMemo(() => {
    const first = choices[0];
    const last = choices[choices.length - 1];
    // a round ticket within 5 % of the default one would read as its duplicate (1.00 by 1.04)
    const near = (t: bigint) =>
      anchor !== null && t !== anchor && (t > anchor ? t - anchor : anchor - t) * 20n < anchor;
    const listed = choices.filter(
      (t) =>
        t === first || t === last || t === price || t === anchor || (LISTED.has(t) && !near(t)),
    );
    return listed.map((t) => {
      const o = odds(winBackPayoutTable(t, out)[0]?.p ?? 0n);
      return { value: t, oneIn: o.oneIn, pct: o.pct, best: t === last && listed.length > 1 };
    });
  }, [choices, anchor, price, out]);

  const help =
    tooLarge && parsed !== null ? (
      <span className="warn-text">
        The vault can cover trades up to {usdc(maxWinBack)} USDC right now (about{" "}
        {fixed(maxLamports, 9, 2)} SOL): its per-payout cap, read live.
      </span>
    ) : tooSmall && parsed !== null ? (
      `Enter a trade worth at least ${usdc(minPrice * 2n)} USDC, twice the smallest ticket price.`
    ) : parsed === null ? (
      "Enter an amount in SOL."
    ) : null;

  const cta = !signer ? (
    <div className="mw-cta-alt">
      <p>Connect a wallet to try a swap.</p>
      <ConnectButton />
    </div>
  ) : missing && funds ? (
    <div className="mw-cta-alt">
      <p>
        {missing === "sol"
          ? "This wallet needs a little SOL."
          : `This wallet needs USDC for the ${usdc(price)} ticket.`}
      </p>
      <FaucetButton className="btn-primary" />
    </div>
  ) : null;

  const swap = () => {
    if (!outcomes || !signer) return;
    setLocked(lamports);
    void flow.start({ signer, state, outcomes, price, appShareBps: DEMO_APP_SHARE_BPS });
  };
  const done = () => {
    flow.reset();
    setLocked(null);
  };

  return (
    <div className="demo">
      <div className="demo-visual">
        <SwapWallet
          s={s}
          solPrice={SOL_PRICE}
          address={account?.address}
          input={locked !== null ? solText(locked) : input}
          onInput={setInput}
          locked={locked !== null}
          presets={SWAP_PRESETS_LAMPORTS.map((p) => ({
            label: solText(p),
            on: parsed === p,
            disabled: swapOut(p) > maxWinBack,
          }))}
          out={parsed !== null || locked !== null ? out : null}
          help={help}
          options={options}
          price={price}
          onTicket={setWanted}
          cta={cta}
          canSwap={outcomes !== null && valid && (q === null || q.refusal === null)}
          onSwap={swap}
          resume={
            signer && (
              <ResumeNotice
                owner={account?.address}
                s={s}
                onResume={(w) => void flow.resume(signer, w)}
              />
            )
          }
          onDone={done}
          share={shareWinOf(s, s.result?.outcome === 0, {
            kind: "Swap",
            price,
            oneIn: win ? odds(win.p).oneIn : null,
            traded: `${solText(lamports)} SOL`,
          })}
        />
      </div>

      <ScrollArea className="demo-panel" label="Swap win-back: the trade, its odds and the draw">
        <div className="demo-head">
          <h2>Win your trade back</h2>
          <p className="muted">
            Everything happens in the wallet. This side shows the terms and the draw, live.
          </p>
        </div>

        <section className="stack-s" aria-label="The trade">
          <span className="eyebrow-s">The trade</span>
          <dl className="kv small">
            <dt>You pay</dt>
            <dd className="mono">{lamports > 0n ? `${solText(lamports)} SOL` : "–"}</dd>
            <dt>Trade value</dt>
            <dd className="mono">{lamports > 0n ? `${usdc(out)} USDC` : "–"}</dd>
            <dt>Lucky draw</dt>
            <dd className="mono">
              {win ? `${odds(win.p).oneIn}, ${usdc(price)} USDC ticket` : "–"}
            </dd>
            <dt>Largest trade covered</dt>
            <dd className="mono">{usdc(maxWinBack)} USDC</dd>
          </dl>
        </section>

        {win && (
          <Odds
            items={[
              { label: "Ticket price", value: usdc(price), unit: "USDC" },
              { label: "Odds", value: odds(win.p).oneIn, sub: odds(win.p).pct },
              { label: "Payout", value: usdc(payout(price, win.m)), unit: "USDC", accent: true },
            ]}
          />
        )}

        <section className="stack-s" aria-label="The draw">
          <span className="eyebrow-s">The draw</span>
          {s.phase === "idle" && <p className="small muted">Waiting for a swap in the wallet.</p>}
          <Progress
            state={s}
            onTakeOver={() => void flow.takeOver()}
            onWatchAgain={flow.watchAgain}
          />
          <SolFallback s={s} />
        </section>
      </ScrollArea>
    </div>
  );
}
