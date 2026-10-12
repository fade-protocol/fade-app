// Demo C: a booster pack on a shop, and an add-on of 2% of its price for a chance at more packs.
// The purchase happens in the shop on the left (the pack, the add-on, one signature); the panel on
// the right sets the pack's price and reads out the odds and the draw. The pack opens in every
// case, on a card picked in the browser; a win also pays, in USDC, a second pack's value or
// (rarely) a premium pack's, ten packs.
import { useMemo, useState } from "react";
import { FaucetButton } from "../components/FaucetButton";
import { PayoutTableView } from "../components/PayoutTableView";
import { ScrollArea } from "../components/scroll";
import { usdc } from "../lib/format";
import {
  BOOSTER_OUTCOMES,
  DEMO_APP_SHARE_BPS,
  NO_EXTRA,
  PACK_TICKETS,
  PREMIUM,
  SECOND_PACK,
  boosterPayoutTable,
  boosterPayouts,
  boosterWinP,
  packSteps,
  packTicket,
} from "../lib/payoutTables";
import { expectedReturn, snapTicket } from "../lib/tickets";
import { ConnectButton } from "../wallet/ConnectButton";
import { useWallet } from "../wallet/WalletProvider";
import {
  CapNotice,
  ResultBanner,
  ResumeNotice,
  SolFallback,
  missingFunds,
  shareWinOf,
  useRecordResult,
  type Live,
  type WalletFunds,
} from "./common";
import { BoosterGame } from "./BoosterGame";
import { Odds } from "./Odds";
import { Progress } from "./Progress";
import { TicketPicker, odds, type Preset } from "./TicketPicker";
import { useDevSimulation } from "./devSimulation";
import { isBusy, predict, useTicketFlow, type DrawResult } from "./useTicketFlow";

const isWin = (b: number) => b !== NO_EXTRA;
/** The pack the shop shows first, in micro-USDC. */
const DEFAULT_PACK = 5_000_000n;
/** Quick picks: the shop's usual packs. */
const PACKS = [5_000_000n, 10_000_000n, 25_000_000n];

export function BoosterDemo({ state, funds }: { state: Live; funds: WalletFunds | null }) {
  const { signer, account } = useWallet();
  const flow = useDevSimulation("booster", useTicketFlow(), (outcome): DrawResult => ({
    outcome,
    payout: boosterPayouts(pack)[outcome] ?? 0n,
    pending: false,
    sig: null,
  }));
  const s = flow.state;
  const [wanted, setWanted] = useState(DEFAULT_PACK);
  // the packs whose add-on the program would accept against the vault as read
  const steps = useMemo(
    () =>
      packSteps(
        state.config.params,
        (p) =>
          predict(state, boosterPayoutTable(p), packTicket(p), DEMO_APP_SHARE_BPS).refusal === null,
      ),
    [state],
  );
  const picked = steps.length > 0 ? snapTicket(steps, wanted) : DEFAULT_PACK;
  // Once bought, the ticket's own price says which pack it was: a resumed purchase may differ.
  const pack = s.onchain ? s.onchain.price * PACK_TICKETS : picked;
  const addOn = packTicket(pack);
  const outcomes = boosterPayoutTable(pack);
  const [premiumValue] = boosterPayouts(pack);
  const pWin = boosterWinP(outcomes);
  const oddsOf = (i: number) => odds(outcomes[i]?.p ?? 0n).oneIn;
  const q = predict(state, outcomes, addOn, DEMO_APP_SHARE_BPS);
  const back = expectedReturn(outcomes);
  const busy = isBusy(s);
  const missing = busy ? null : missingFunds(funds, addOn);
  useRecordResult(s, "Booster", isWin);
  const describe = (p: bigint) =>
    `${usdc(p)} USDC pack: add ${usdc(packTicket(p))} USDC for ${odds(boosterWinP(boosterPayoutTable(p))).oneIn} to win a second or a premium pack`;
  const presets: Preset[] = PACKS.filter((p) => steps.includes(p)).map((p) => ({
    label: `${usdc(p, 0)} USDC`,
    value: p,
  }));
  const onchainTable = s.onchain ? s.onchain.payoutTable.slice(0, s.onchain.payoutTableLen) : null;
  const labelled = (onchainTable ?? outcomes).map((b, i) => ({
    ...b,
    label: BOOSTER_OUTCOMES[i] ?? "",
  }));

  const cta = !signer ? (
    <div className="pg-cta-alt">
      <p>Connect a wallet to buy a pack.</p>
      <ConnectButton />
    </div>
  ) : missing && funds ? (
    <div className="pg-cta-alt">
      <p>
        {missing === "sol"
          ? "This wallet needs a little SOL."
          : `This wallet needs USDC for the ${usdc(addOn)} add-on.`}
      </p>
      <FaucetButton className="btn-primary" />
    </div>
  ) : null;

  return (
    <div className="demo">
      <div className="demo-visual">
        <BoosterGame
          s={s}
          balance={funds?.usdc ?? null}
          pack={pack}
          addOn={addOn}
          premiumValue={premiumValue}
          odds={{ second: oddsOf(SECOND_PACK), premium: oddsOf(PREMIUM) }}
          cta={cta}
          canBuy={q.refusal === null}
          onBuy={() => {
            if (!signer) return;
            void flow.start({
              signer,
              state,
              outcomes,
              price: addOn,
              appShareBps: DEMO_APP_SHARE_BPS,
            });
          }}
          onAgain={() => flow.reset()}
          share={shareWinOf(
            s,
            s.result !== null && s.result.outcome >= 0 && isWin(s.result.outcome),
            {
              kind: "Booster",
              price: addOn,
              oneIn: s.result && s.result.outcome >= 0 ? oddsOf(s.result.outcome) : null,
            },
          )}
          resume={
            signer && (
              <ResumeNotice
                owner={account?.address}
                s={s}
                onResume={(w) => void flow.resume(signer, w)}
              />
            )
          }
        />
      </div>

      <ScrollArea className="demo-panel" label="Booster: the pack, its odds and the draw">
        <div className="demo-head">
          <h2>Buy a pack, maybe win a premium one</h2>
          <p className="muted">
            Add 2% to the price at checkout. The pack opens either way; if the draw lands, a second
            pack or a premium pack comes with it, paid in USDC to your wallet.
          </p>
        </div>

        {s.phase === "idle" && steps.length > 0 && (
          <TicketPicker
            steps={steps}
            value={pack}
            onChange={setWanted}
            describe={describe}
            presets={presets}
            label="Pack price"
            info={
              <>
                The add-on is 2% of the pack's price. Whatever the pack, on average {back ?? "most"}{" "}
                of the add-on comes back. A second pack pays the pack's price, a premium pack ten
                times it, in USDC straight to the wallet that paid.
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
          won={s.result !== null && s.result.outcome >= 0 && isWin(s.result.outcome)}
          wonText={`${s.result?.outcome === PREMIUM ? "You won a premium pack" : "You won a second pack"}: ${usdc(s.result?.payout ?? 0n)} USDC to your wallet`}
          lostText="Enjoy your cards."
        />

        <Odds
          items={[
            { label: "Add-on", value: usdc(addOn), unit: "USDC" },
            // any win: a second pack or a premium one
            { label: "Odds", value: odds(pWin).oneIn, sub: odds(pWin).pct },
            { label: "Top prize", value: usdc(premiumValue), unit: "USDC", accent: true },
          ]}
        />

        {q.refusal === "PerTicketCap" && <CapNotice state={state} q={q} />}
        {q.refusal && q.refusal !== "PerTicketCap" && (
          <div className="notice">
            <p className="notice-title">Not available right now</p>
            <p className="small">
              The program would refuse this add-on ({q.refusal}). The vault page shows why.
            </p>
          </div>
        )}

        <PayoutTableView
          outcomes={labelled}
          price={addOn}
          source={s.onchain && s.ticket ? s.ticket : undefined}
          highlight={s.result && s.result.outcome >= 0 ? s.result.outcome : undefined}
          caption="The odds"
          collapsed
        />
      </ScrollArea>
    </div>
  );
}
