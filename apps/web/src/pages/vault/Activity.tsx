// Activity: what the vault did lately. Four figures over the last 24 h, then one line per ticket
// (its opening, draw and settlement told as one sentence) and one per deposit or withdrawal. The
// figures and the newest lines are the keeper's (GET /v1/vault and GET /v1/feed, lib/keeperViews),
// shown at once; behind them, the lines the app read itself (lib/vaultActivity): the vault's
// history, always read on this page, and the program's tickets, read once the visitor asks for
// older lines (the Wins filter, "Show more" on the full list) or once the first page reaches
// past the feed's horizon. The feed holds every ticket opened since its horizon
// (lib/keeperViews `feedHorizon`) and, older, only those with a recent event: the list stops at
// the horizon until the program's tickets are read, so no line stands where others of its time
// are missing. When the keeper cannot serve a part, the app's own reads stand in for it, each
// part on its own (the requests and the closes reach back further than the tickets, and may
// still be read by the keeper); its figures, while the keeper still reads the last day, say the
// span they cover.
import { useEffect, useMemo, useState } from "react";
import { EventRows, stateKeys } from "../../components/EventRows";
import { Tween, useFreshKeys } from "../../components/motion";
import { Skeleton } from "../../components/ui";
import { signedAmount, usdc, usdcTidy as amount } from "../../lib/format";
import { livePoint, strikeSeries } from "../../lib/history";
import {
  asPartial,
  chooseView,
  feedHorizon,
  type KeeperFeed,
  type KeeperVault,
} from "../../lib/keeperViews";
import type { TicketLog } from "../../lib/ticketLog";
import {
  activityRows,
  feedRequestsOf,
  needsOlderTickets,
  requestsOf,
  withOlderCloses,
  withinHorizon,
} from "../../lib/vaultActivity";
import { activityFigures, spanWords, type ActivityFigures } from "../../lib/vaultFigures";
import { ACTIVITY_WINDOW_S } from "../../lib/vaultViews";
import type { VaultData } from "./common";

type Filter = "all" | "wins" | "lp";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "wins", label: "Wins" },
  { id: "lp", label: "Deposits and withdrawals" },
];
const PAGE = 40;

export function ActivityPanel({
  data,
  keeper,
  feed,
  tickets,
  olderPending,
  onOlder,
}: {
  data: VaultData;
  /** The keeper's vault history (the figures, the closes), null until it answers or when down. */
  keeper: KeeperVault | null;
  /** The keeper's newest tickets and requests, null until it answers or when it cannot be reached. */
  feed: KeeperFeed | null;
  /**
   * The program's tickets the app read itself: when the keeper cannot serve them, or once
   * `onOlder` asked for the lines behind the feed's.
   */
  tickets: TicketLog | null;
  /** The program's tickets were asked for and are still being read. */
  olderPending: boolean;
  /** The visitor asks for older lines than the feed's: the page reads the program's tickets. */
  onOlder: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [count, setCount] = useState(PAGE);
  const now = Math.floor(Date.now() / 60_000) * 60;
  const items = data.log?.items ?? null;
  // each line is true on its own: the feed's partial lines show while the app reads its own
  const lines = chooseView(feed, tickets, undefined, asPartial);
  const fromFeed = lines && "keeper" in lines ? lines.keeper : null;
  const ownTickets = lines && "own" in lines ? lines.own : null;
  const asked = chooseView(feed, items, (f) => f.requestsSyncing, asPartial);
  const feedRequests = asked && "keeper" in asked ? asked.keeper.requests : null;
  const closes = chooseView(keeper, items, (k) => k.seriesSyncing, asPartial);
  const keeperCloses = closes && "keeper" in closes ? closes.keeper : null;
  const ownCloses = useMemo(
    () => (items ? strikeSeries(items, data.state.vault, now) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, data.state.vault],
  );

  const rows = useMemo(() => {
    const ownRequests = items && requestsOf(items);
    const ticketHead = fromFeed?.rows ?? ownTickets?.rows ?? null;
    const requestHead = feedRequests ? feedRequestsOf(feedRequests) : ownRequests;
    if (!ticketHead || !requestHead) return null;
    // a withdrawal is valued at the share price of its time: after the closes, then today's
    const prices = keeperCloses
      ? withOlderCloses(keeperCloses.strikes, ownCloses, livePoint(data.state.vault, now))
      : (ownCloses ?? []);
    return activityRows({
      tickets: { head: ticketHead, tail: fromFeed ? (tickets?.rows ?? null) : null },
      requests: { head: requestHead, tail: feedRequests ? ownRequests : null },
      prices,
      now,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    fromFeed,
    ownTickets,
    tickets,
    feedRequests,
    items,
    keeperCloses,
    ownCloses,
    data.state.vault,
  ]);

  // Past the feed's horizon, while the program's tickets are not read, the list stops: older
  // tickets with no recent event are not in the feed (the deposits and withdrawals filter
  // shows only requests, held in full, and stops nowhere)
  const horizon = fromFeed && !tickets && filter !== "lp" ? feedHorizon(fromFeed) : null;
  const cut = useMemo(
    () => (rows ? withinHorizon(rows, horizon, now) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, horizon],
  );
  const shown = cut?.shown ?? null;
  const held = cut?.held ?? 0;

  // the lines behind the feed's are no arrivals: they do not light up as they load
  const fresh = useFreshKeys(shown ? stateKeys(shown.filter((r) => !r.older)) : null);

  // the keeper's 24 h, else the app's own over the tickets and the history it read, else the
  // keeper's while it still reads the history, over the span it covers
  const figures = useMemo((): ActivityFigures | null => {
    const source = chooseView(
      keeper,
      tickets && items ? { tickets, items } : null,
      undefined,
      (k) => k.coveredFrom !== null,
    );
    if (!source) return null;
    if ("keeper" in source) {
      const from = source.keeper.coveredFrom;
      const span =
        source.keeper.syncing && from !== null && from > now - ACTIVITY_WINDOW_S
          ? spanWords(now - from)
          : "24 h";
      return { ...source.keeper.activity, span };
    }
    return activityFigures(source.own.tickets, source.own.items, now);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keeper, tickets, items]);

  const failed = data.logError !== null && !fromFeed;

  const matching = (shown ?? []).filter((r) =>
    filter === "all" ? true : filter === "wins" ? r.win : r.kind === "lp",
  );

  const needsOlder = needsOlderTickets({
    filter,
    count,
    page: PAGE,
    shown: matching.length,
    held,
  });
  useEffect(() => {
    if (needsOlder) onOlder();
  }, [needsOlder, onOlder]);

  return (
    <section className="activity" aria-label="Recent activity">
      <dl className="metrics metrics-4 activity-figures">
        <div className="metric">
          <dt>Tickets, {figures?.span ?? "24 h"}</dt>
          <dd>
            {figures ? (
              <Tween>{figures.n.toLocaleString("en-US")}</Tween>
            ) : (
              <Skeleton w={60} h={24} inline />
            )}
          </dd>
        </div>
        <div className="metric">
          <dt>Paid to winners</dt>
          <dd>
            {figures ? <Tween>{usdc(figures.paid)}</Tween> : <Skeleton w={80} h={24} inline />}
          </dd>
        </div>
        <div className="metric">
          <dt>Vault result</dt>
          <dd
            className={
              figures ? (figures.result > 0n ? "up" : figures.result < 0n ? "down" : "") : ""
            }
          >
            {figures ? (
              <Tween>{signedAmount(figures.result, amount)}</Tween>
            ) : (
              <Skeleton w={80} h={24} inline />
            )}
          </dd>
        </div>
        <div className="metric">
          <dt>Net deposits</dt>
          <dd>
            {figures ? (
              <Tween>{signedAmount(figures.net, amount)}</Tween>
            ) : (
              <Skeleton w={80} h={24} inline />
            )}
          </dd>
        </div>
      </dl>
      <div className="activity-list">
        <div className="pills" role="group" aria-label="Filter activity">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`pill${filter === f.id ? " on" : ""}`}
              aria-pressed={filter === f.id}
              onClick={() => {
                setFilter(f.id);
                setCount(PAGE);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        {!rows && !failed && (
          <div className="stack-s">
            <Skeleton h={22} />
            <Skeleton h={22} />
            <Skeleton h={22} />
          </div>
        )}
        {failed && !rows && (
          <p className="error small">
            The network did not answer ({data.logError}). This list tries again every 30 seconds.
          </p>
        )}
        {rows && matching.length === 0 && !olderPending && !(needsOlder && held > 0) && (
          <p className="small muted">Nothing yet.</p>
        )}
        {matching.length > 0 && (
          <EventRows
            rows={matching.slice(0, count)}
            relative
            label="Recent activity"
            fresh={fresh}
          />
        )}
        {rows && matching.length < count && olderPending && (
          <div className="stack-s">
            <Skeleton h={22} />
            <Skeleton h={22} />
          </div>
        )}
        {(matching.length > count || (filter === "all" && held > 0 && !olderPending)) && (
          <button
            type="button"
            className="link-btn small"
            onClick={() => setCount((c) => c + PAGE)}
          >
            Show more
          </button>
        )}
        <p className="small activity-note">
          Amounts on the right are what the winner received, or what the vault kept when nobody won.
        </p>
      </div>
    </section>
  );
}
