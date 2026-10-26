// The small-ticket demo's state for React: the flow itself (lib/beaconFlow.ts)
// over the app's RPC, with every transaction simulated before the wallet is
// asked to sign (lib/tx.ts).
import type { Address, TransactionSigner } from "@solana/kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BeaconTarget } from "../lib/beacon";
import {
  BeaconTicketFlow,
  INITIAL_FLOW,
  quoteJoin,
  type BeaconFlow,
  type JoinQuote,
} from "../lib/beaconFlow";
import { appFlowDeps } from "../lib/beaconRpc";
import { ata } from "../lib/fade";
import { usePolling } from "../lib/hooks";

/** How often the join's needs are read again while no ticket runs. */
const QUOTE_MS = 30_000;

export function useBeaconFlow(target: BeaconTarget) {
  const [state, setState] = useState<BeaconFlow>(INITIAL_FLOW);
  const flow = useMemo(() => new BeaconTicketFlow(appFlowDeps, target, setState), [target]);
  // Stop following when the demo goes away.
  useEffect(() => () => flow.stop(), [flow]);
  const start = useCallback(
    (signer: TransactionSigner, usdcAccount: Address) => flow.start(signer, usdcAccount),
    [flow],
  );
  return {
    state,
    start,
    takeOver: useCallback(() => flow.takeOver(), [flow]),
    watchAgain: useCallback(() => flow.watchAgain(), [flow]),
    claim: useCallback(() => flow.claim(), [flow]),
    reclaim: useCallback(() => flow.reclaim(), [flow]),
    reset: useCallback(() => void flow.reset(), [flow]),
  };
}

/**
 * What a join by `signer` needs now (the SOL it fronts, plus the fees), or
 * why it would be refused, read while no ticket runs (`idle`): the demo asks
 * for that SOL before the button, not after it. Null until read.
 */
export function useJoinQuote(
  target: BeaconTarget,
  signer: TransactionSigner | undefined,
  idle: boolean,
): JoinQuote | null {
  const { data } = usePolling(
    async () =>
      signer && idle
        ? quoteJoin(appFlowDeps.reader, target, signer, await ata(signer.address))
        : null,
    QUOTE_MS,
    [target, signer?.address, idle],
  );
  return data;
}
