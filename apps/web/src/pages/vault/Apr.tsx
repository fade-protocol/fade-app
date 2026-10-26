// The vault's APR: the keeper's (GET /v1/apr, lib/vaultApr), one request for every visitor. The
// app works it out itself from the program's recent tickets only when the keeper cannot be
// reached, or is still reading the history.
import { useMemo } from "react";
import { InfoTip } from "../../components/disclosure";
import { Tween } from "../../components/motion";
import { Skeleton } from "../../components/ui";
import { usdc } from "../../lib/format";
import { useProgramTicketsWhen, useVaultApr } from "../../lib/hooks";
import {
  APR_LABEL,
  APR_MIN_TICKETS,
  estimateApr,
  fmtApr,
  type AprEstimate,
} from "../../lib/ticketLog";
import { chooseApr, needsOwnApr } from "../../lib/vaultApr";
import type { Live } from "./common";

/** The vault's APR, or null (a skeleton) until the keeper answers or the app works it out. */
export function useApr(state: Live | null): AprEstimate | null {
  const keeper = useVaultApr();
  const own = needsOwnApr(keeper.data, keeper.error !== null);
  const tickets = useProgramTicketsWhen(own);
  const estimate = useMemo(
    () =>
      own && tickets.data && state
        ? estimateApr(
            tickets.data,
            state.vault.totalAssets,
            state.config.params.protocolShareBps,
            Math.floor(Date.now() / 1000),
          )
        : null,
    [own, tickets.data, state],
  );
  return chooseApr(keeper.data, estimate);
}

/** "≈ 22%" with its (i), or "–" with why. */
export function AprFigure({ apr }: { apr: AprEstimate | null }) {
  if (!apr) return <Skeleton w={70} h={24} inline />;
  return (
    <span className={`label-tip${apr.pct !== null ? " up" : ""}`}>
      <Tween>{apr.pct === null ? "–" : fmtApr(apr.pct)}</Tween>
      <InfoTip label={`About the ${APR_LABEL}`} docs>
        {apr.pct === null
          ? `Not enough tickets in the last 7 days to work it out (${apr.tickets} of the ${APR_MIN_TICKETS} needed).`
          : `The vault margin earned on the tickets of the last 7 days (${usdc(apr.volume, 0)} USDC over ${apr.tickets} tickets), annualised over the vault's assets: past activity, not a forecast. Results move with volume and the luck of the draws.`}
      </InfoTip>
    </span>
  );
}
