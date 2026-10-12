// The vault's estimated APR: read once per page from the program's recent tickets.
import { useMemo } from "react";
import { InfoTip } from "../../components/disclosure";
import { Tween } from "../../components/motion";
import { Skeleton } from "../../components/ui";
import { usdc } from "../../lib/format";
import { useProgramTickets } from "../../lib/hooks";
import { APR_MIN_TICKETS, estimateApr, fmtApr, type AprEstimate } from "../../lib/ticketLog";
import type { Live } from "./common";

/** The vault's estimated APR from the program's recent tickets, or null until they are read. */
export function useApr(state: Live | null): AprEstimate | null {
  const tickets = useProgramTickets();
  return useMemo(
    () =>
      tickets.data && state
        ? estimateApr(
            tickets.data,
            state.vault.totalAssets,
            state.config.params.protocolShareBps,
            Math.floor(Date.now() / 1000),
          )
        : null,
    [tickets.data, state],
  );
}

/** "≈ 22%" with its (i), or "–" with why. */
export function AprFigure({ apr }: { apr: AprEstimate | null }) {
  if (!apr) return <Skeleton w={70} h={24} inline />;
  return (
    <span className={`label-tip${apr.pct !== null ? " up" : ""}`}>
      <Tween>{apr.pct === null ? "–" : fmtApr(apr.pct)}</Tween>
      <InfoTip label="About the estimated APR" docs>
        {apr.pct === null
          ? `Not enough tickets in the last 24 h to estimate it (${apr.tickets} of the ${APR_MIN_TICKETS} needed).`
          : `The vault margin earned on the last 24 h of tickets (${usdc(apr.volume, 0)} USDC over ${apr.tickets} tickets), annualised over the vault's assets. Not a forecast: results move with volume and the luck of the draws.`}
      </InfoTip>
    </span>
  );
}
