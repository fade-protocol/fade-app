import { useMemo, useState } from "react";
import { ActionButton } from "../components/Button";
import { PayoutTableView } from "../components/PayoutTableView";
import { Receipt3D } from "../components/Receipt3D";
import { ScrollArea } from "../components/scroll";
import { usdc } from "../lib/format";
import {
  CHANCE_PRESETS,
  POPULAR_CHANCE,
  chanceTerms,
  customTickets,
  marginPct,
  nearestByOdds,
  ticketForOneIn,
  type ChanceTerms,
} from "../lib/chances";
import { payout as payoutOf } from "../lib/math";
import {
  CART,
  CHECKOUT_BACKS,
  DEMO_APP_SHARE_BPS,
  checkoutBackAmount,
  checkoutPayoutTable,
  checkoutPayoutTableFor,
  type CheckoutBack,
} from "../lib/payoutTables";
import { checkoutBackOf } from "../lib/ticketKind";
import { expectedReturn } from "../lib/tickets";
import { useWallet } from "../wallet/WalletProvider";
import {
  CapNotice,
  ConnectPrompt,
  FundsPrompt,
  OneSignatureNote,
  ResultBanner,
  ResumeNotice,
  SimulateButton,
  SolFallback,
  drawOf,
  missingFunds,
  shareWinOf,
  signalOf,
  useRecordResult,
  type Live,
  type WalletFunds,
} from "./common";
import { ChancePicker, type BackChoice, type ChancePreset } from "./ChancePicker";
import { Progress } from "./Progress";
import { useDevSimulation } from "./devSimulation";
import { useReceiptPreview } from "./receiptPreview";
import { isBusy, predict, useTicketFlow, type DrawResult } from "./useTicketFlow";

const isWin = (b: number) => b === 0;

/** The custom picker's first setting, as the buyer reads it. */
const BACK_LABEL: Record<CheckoutBack, string> = {
  whole: "The whole order",
  half: "Half the order",
  tenth: "10% of the order",
};

/** The payout table's winning row, as the odds table names it. */
const BACK_ROW: Record<CheckoutBack, string> = {
  whole: "Whole cart won back",
  half: "Half the cart won back",
  tenth: "10% of the cart won back",
};

/** What a win does, after the odds: "1 in 75 chance your order is free". */
const BACK_LINE: Record<CheckoutBack, string> = {
  whole: "chance your order is free.",
  half: "chance that half your order comes back.",
  tenth: "chance that 10% of your order comes back.",
};

/** The result once a win is in, before the amount sent. */
const BACK_WON: Record<CheckoutBack, string> = {
  whole: "Your order is free",
  half: "Half your order came back",
  tenth: "10% of your order came back",
};

/** The receipt's stamp for a win. */
const BACK_STAMP: Record<CheckoutBack, string> = {
  whole: "Free",
  half: "Half back",
  tenth: "10% back",
};

/**
 * The presets (the whole order) and the custom picker's stops for each part of the order a win
 * may send back, against the vault as read: a preset the program would refuse is shown disabled,
 * a custom stop it would refuse is left out.
 */
function checkoutChances(state: Live) {
  const acceptedBy =
    (table: (t: bigint) => ReturnType<typeof checkoutPayoutTable>) => (t: bigint) =>
      predict(state, table(t), t, DEMO_APP_SHARE_BPS).refusal === null;
  const accepted = acceptedBy(checkoutPayoutTable);
  const presets: ChancePreset[] = CHANCE_PRESETS.map((n) => {
    const t = ticketForOneIn(n, state.config.params, checkoutPayoutTable);
    return {
      n,
      terms: chanceTerms(t, CART.total, checkoutPayoutTable),
      refused: !accepted(t),
      popular: n === POPULAR_CHANCE,
    };
  });
  const custom = Object.fromEntries(
    CHECKOUT_BACKS.map((back) => {
      const table = checkoutPayoutTableFor(back);
      const stops = customTickets(state.config.params, table)
        .filter(acceptedBy(table))
        .map((t) => chanceTerms(t, CART.total, table, 1));
      return [back, stops];
    }),
  ) as Record<CheckoutBack, ChanceTerms[]>;
  return { presets, custom };
}

export function CheckoutDemo({ state, funds }: { state: Live; funds: WalletFunds | null }) {
  const { signer, account } = useWallet();
  const flow = useDevSimulation("checkout", useTicketFlow(), (outcome): DrawResult => ({
    outcome,
    payout: outcome === 0 ? terms.payout : 0n,
    pending: false,
    sig: null,
  }));
  const s = flow.state;
  const [choice, setChoice] = useState<number>(POPULAR_CHANCE);
  const [customOpen, setCustomOpen] = useState(false);
  const [customBack, setCustomBack] = useState<CheckoutBack>("whole");
  /** The chance the custom picker holds, as N in "1 in N": kept when the win changes. */
  const [customOdds, setCustomOdds] = useState<number | null>(null);
  const { presets, custom } = useMemo(() => checkoutChances(state), [state]);
  // A preset the vault cannot carry falls back to the likeliest one it can, below it; with none,
  // the chosen one stays and the cap notice says why.
  const chosen = presets.findIndex((p) => p.n === choice);
  const fallback = presets.slice(0, chosen + 1).filter((p) => !p.refused);
  const preset = fallback[fallback.length - 1] ?? presets[chosen] ?? presets[0];
  // a win the vault can no longer carry hands the custom picker back to the whole order
  const pickedBack = custom[customBack].length > 0 ? customBack : "whole";
  const customStops = custom[pickedBack];
  const customPicked = customOpen
    ? nearestByOdds(customStops, customOdds ?? preset?.terms.oneInN ?? POPULAR_CHANCE)
    : undefined;
  const picked = customPicked?.price ?? preset?.terms.price ?? state.config.params.minPrice;
  // Once opened, the ticket's own price and payout table are the ones shown: a resumed payout
  // may differ from the picker, down to what its win sends back.
  const onchainTable = s.onchain ? s.onchain.payoutTable.slice(0, s.onchain.payoutTableLen) : null;
  const price = s.onchain?.price ?? picked;
  const onchainWin = onchainTable?.[0];
  const back: CheckoutBack =
    (onchainWin && checkoutBackOf({ price, payoutMax: payoutOf(price, onchainWin.m) })) ||
    (customPicked ? pickedBack : "whole");
  const terms = chanceTerms(price, CART.total, checkoutPayoutTableFor(back));
  const outcomes = terms.outcomes;
  const backs: BackChoice[] = CHECKOUT_BACKS.map((b) => ({
    back: b,
    label: BACK_LABEL[b],
    amount: checkoutBackAmount(b),
    refused: custom[b].length === 0,
  }));
  const averageBack = expectedReturn(outcomes);
  const q = predict(state, outcomes, price, DEMO_APP_SHARE_BPS);
  const busy = isBusy(s);
  const missing = busy ? null : missingFunds(funds, price);
  const preview = useReceiptPreview();
  const draw = preview?.draw ?? drawOf(s, isWin);
  useRecordResult(s, "Checkout", isWin);
  const labelled = (onchainTable ?? outcomes).map((b, i) => ({
    ...b,
    label: i === 0 ? BACK_ROW[back] : "Nothing",
  }));

  const idle = s.phase === "idle";
  const ended = s.phase === "done" || s.phase === "failed" || s.phase === "expired";

  return (
    <div className="demo">
      <div className="demo-visual">
        <div className="demo-visual-inner">
          <Receipt3D
            title="ORDER 004821"
            lines={CART.items.map((i) => ({ label: i.label, value: usdc(i.amount) }))}
            subtotal={CART.total}
            drawPrice={price}
            wonBack={back === "whole" ? undefined : terms.payout}
            stamp={BACK_STAMP[back]}
            draw={draw}
            printKey={preview?.key ?? s.times.opened ?? "idle"}
            signal={preview ? null : signalOf(s)}
            headAtRest
          />
        </div>
      </div>

      <ScrollArea className="demo-panel" label="Checkout win-back: ticket, odds and progress">
        <div className="demo-head">
          <h2>Win this order back</h2>
          <p className="muted">
            {back === "whole"
              ? "Pick your chance. If the draw lands, your order is free."
              : "Pick your chance. If the draw lands, part of your order comes back."}
          </p>
        </div>

        {idle && presets.length > 0 && (
          <ChancePicker
            presets={presets}
            selected={customOpen ? null : (preset?.n ?? null)}
            onPreset={(n) => {
              setChoice(n);
              setCustomOpen(false);
            }}
            custom={customStops}
            customOpen={customOpen}
            customValue={picked}
            onCustom={(t) => {
              const stop = customStops.find((c) => c.price === t);
              if (stop) setCustomOdds(stop.oneInN);
            }}
            onOpenCustom={() => {
              setCustomOdds(preset?.terms.oneInN ?? POPULAR_CHANCE);
              setCustomOpen(true);
            }}
            onCloseCustom={() => setCustomOpen(false)}
            backs={backs}
            back={pickedBack}
            onBack={setCustomBack}
            info={
              <>
                Better odds cost more. Whatever you pick, on average {averageBack ?? "most"} of the
                ticket price comes back. A win is paid in USDC straight to the wallet that paid.
              </>
            }
          />
        )}

        <Progress
          state={s}
          onTakeOver={() => void flow.takeOver()}
          onWatchAgain={flow.watchAgain}
        />

        <SolFallback s={s} />

        <ResultBanner
          s={s}
          won={s.result?.outcome === 0}
          share={shareWinOf(s, s.result?.outcome === 0, {
            kind: "Checkout",
            back,
            price,
            oneIn: terms.p > 0n ? terms.oneIn : null,
          })}
          wonText={`${BACK_WON[back]}: ${usdc(s.result?.payout ?? 0n)} USDC sent to your wallet`}
          lostText="Not this time. The ticket price stays with the vault; the order is paid as usual."
        />

        {terms.p > 0n && !ended && (
          <div className="chance-terms">
            <p className="chance-line">
              <span className="chance-line-odds">{terms.oneIn}</span> {BACK_LINE[back]} If you win,
              we send you <span className="mono">{usdc(terms.payout)}</span> USDC.
            </p>
            <p className="small muted">
              Odds {terms.pct}, fixed by the public payout table.
              {terms.marginBps !== null &&
                ` The vault keeps ${marginPct(terms.marginBps)} of ticket money on average.`}
            </p>
          </div>
        )}

        {q.refusal === "PerTicketCap" ? (
          <>
            <CapNotice state={state} q={q} />
            <SimulateButton
              state={state}
              signer={signer}
              outcomes={outcomes}
              price={price}
              appShareBps={DEMO_APP_SHARE_BPS}
              label="Ask the program anyway (simulation)"
            />
          </>
        ) : q.refusal ? (
          <div className="notice">
            <p className="notice-title">Not available right now</p>
            <p className="small">
              The program would refuse this payout ({q.refusal}). The vault page shows why.
            </p>
          </div>
        ) : !signer ? (
          <ConnectPrompt what="pay this cart" />
        ) : missing && funds ? (
          <FundsPrompt missing={missing} funds={funds} ticket={price} />
        ) : (
          <div className="cta-block">
            {s.phase === "done" || s.phase === "failed" || s.phase === "expired" ? (
              <button
                type="button"
                className="btn btn-outline btn-large btn-block"
                onClick={() => flow.reset()}
              >
                New cart
              </button>
            ) : (
              <ActionButton
                type="button"
                className="btn-primary btn-large btn-block"
                busy={busy}
                busyLabel="Drawing…"
                onClick={() =>
                  void flow.start({
                    signer,
                    state,
                    outcomes,
                    price,
                    appShareBps: DEMO_APP_SHARE_BPS,
                  })
                }
              >
                {`Pay ${usdc(CART.total + price)} USDC`}
              </ActionButton>
            )}
            <OneSignatureNote />
          </div>
        )}

        {signer && (
          <ResumeNotice
            owner={account?.address}
            s={s}
            onResume={(w) => void flow.resume(signer, w)}
          />
        )}

        <PayoutTableView
          outcomes={labelled}
          price={price}
          source={s.onchain && s.ticket ? s.ticket : undefined}
          highlight={s.result && s.result.outcome >= 0 ? s.result.outcome : undefined}
          caption="The odds"
          collapsed
        />
      </ScrollArea>
    </div>
  );
}
