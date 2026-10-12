// The signature visual: a receipt that a thermal printer feeds out of its slot
// in small jerks, typing each line, while a payout runs. The lucky draw then
// scrambles until the flow reports the result: a win prints the amount won back, lands a
// stamp and rolls the total down; a loss tears the receipt off. At rest (first
// load, after "New cart", under prefers-reduced-motion) it is simply printed, or,
// with `headAtRest`, like a till with the order rung up: only its head (the title
// and the order's lines) is out of the slot, and a payment prints the rest under it.
//
// One clock per payout drives the timeline: what is typed and how far the paper
// has fed are derived from the time since the payout started, so re-renders
// (polling) never replay anything, and the clock stops while the receipt is out
// of sight (another demo tab) or has nothing left to animate.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { usdc } from "../lib/format";
import { Tween, usePrefersReducedMotion } from "./motion";
import { Pixels, seeded } from "./ui";

export type Draw =
  | "idle"
  /** The payout is being checked or signed: the receipt prints. */
  | "printing"
  | "drawing"
  | "won"
  | "lost"
  | "expired"
  /** Failed before the open was sent: nothing moved. */
  | "unpaid"
  /** The open's confirmation failed: whether it landed is unknown. */
  | "unconfirmed"
  /** Opened, then finishing it failed: it can still be followed. */
  | "halted"
  /** Drawn, but the outcome is not readable here. */
  | "settled";

export type ReceiptLine = { label: string; value: string };

/** At rest, the printer's light while the open waits: for the signature, then for the network. */
export type Signal = "sign" | "confirm" | null;

/** What the lucky draw prints once the payout has ended. */
export const RESULT: Partial<Record<Draw, string>> = {
  won: "WON",
  lost: "NOT THIS TIME",
  expired: "NO DRAW IN TIME",
  unpaid: "NOT PAID",
  unconfirmed: "NOT CONFIRMED",
  halted: "ON HOLD",
  settled: "DRAWN",
};

export const PENDING = "PENDING";
/** The receipt's last line, printed on every receipt like a till's sign-off. */
export const THANKS = "THANK YOU · SEE YOU SOON";

/** With `headAtRest`, the blank paper out of the slot under the head's last line, in px. */
const HEAD_MARGIN_PX = 6;

/** The printer, in ms and px. */
const PRINT = {
  /** Before the first feed. */
  delay: 220,
  char: 17,
  /** Between two lines. */
  pause: 70,
  /** One jerk of the paper. */
  stepPx: 9,
  stepMs: 30,
};

/** After the result is known (ms from the reveal). */
const WON = {
  char: 70,
  row: 260,
  rowType: 430,
  stamp: 840,
  roll: 1000,
  confetti: 980,
  footer: 1260,
  end: 1900,
};
const LOST = { char: 30, tear: 470, end: 1100 };
const QUIET = { char: 30, end: 800 };

export const isResult = (d: Draw) => RESULT[d] !== undefined;

/**
 * What a win takes off the total: all of it, or `wonBack` when that is less, to the cent the
 * receipt prints, so its lines add up as printed.
 */
export const backOf = (owed: bigint, wonBack: bigint | undefined) =>
  wonBack !== undefined && wonBack < owed ? (wonBack / 10_000n) * 10_000n : owed;

type Seg = { text: string; cls?: string };
type Item = { key: string; segs: Seg[]; value?: Seg[] };

const len = (segs: Seg[] | undefined) => (segs ?? []).reduce((n, s) => n + s.text.length, 0);

/** Text typed `n` characters in; the rest is kept as transparent text so nothing reflows. */
function Typed({ segs, n, caret }: { segs: Seg[]; n: number; caret: boolean }) {
  let left = n;
  let cursor = caret;
  return (
    <>
      {segs.map((s, i) => {
        const k = Math.max(0, Math.min(s.text.length, left));
        left -= s.text.length;
        if (k >= s.text.length)
          return (
            <span key={i} className={s.cls}>
              {s.text}
            </span>
          );
        // The caret sits after the last typed character: in the first unfinished segment.
        const here = cursor;
        cursor = false;
        return (
          <span key={i} className={s.cls}>
            <span className={here ? "t-on t-caret" : "t-on"}>{s.text.slice(0, k)}</span>
            <span className="t-ghost">{s.text.slice(k)}</span>
          </span>
        );
      })}
    </>
  );
}

/** Cycling characters at a fixed width, like a slot machine's reels. */
function Scramble({ width, run }: { width: number; run: boolean }) {
  const [text, setText] = useState(() => "·".repeat(width));
  useEffect(() => {
    if (!run) return;
    const glyphs = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ#%&*+?";
    const t = setInterval(() => {
      let s = "";
      for (let i = 0; i < width; i++) s += glyphs[Math.floor(Math.random() * glyphs.length)];
      setText(s);
    }, 75);
    return () => clearInterval(t);
  }, [run, width]);
  return (
    <span className="r-scramble" aria-hidden="true">
      {text}
    </span>
  );
}

/** Whether `ref` is on screen: false inside a hidden tab, so clocks can stop. */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setOn(e?.isIntersecting ?? true));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}

/** A few pixels of the torn edge flying up: the win, kept small. */
function EdgeConfetti({ seed }: { seed: number }) {
  const rnd = seeded(seed);
  return (
    <div className="r-confetti" aria-hidden="true">
      {Array.from({ length: 16 }, (_, i) => {
        const tone = rnd();
        return (
          <i
            key={i}
            className={tone < 0.6 ? "b-violet" : tone < 0.92 ? "b-paper" : "b-dim"}
            style={
              {
                "--x0": `${4 + rnd() * 92}%`,
                "--y0": `${rnd() * 40}px`,
                "--dx": `${(rnd() - 0.5) * 50}px`,
                "--dy": `${-(50 + rnd() * 90)}px`,
                "--s": `${rnd() < 0.4 ? 8 : 6}px`,
                "--d": `${Math.round(rnd() * 180)}ms`,
                "--t": `${700 + Math.round(rnd() * 400)}ms`,
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

export type ReceiptProps = Props;
type Props = {
  title: string;
  lines: ReceiptLine[];
  subtotalLabel?: string;
  /** Micro-USDC: also what a win pays back. */
  subtotal: bigint;
  draw: Draw;
  idleText?: string;
  /** Micro-USDC: the ticket, shown as the lucky draw's price. */
  drawPrice?: bigint;
  /**
   * Micro-USDC: what a win sends back, when it is less than the order and the ticket (a part of
   * the order). The total then rolls down to what is left paid, not to zero.
   */
  wonBack?: bigint | undefined;
  /** The win's stamp ("Free"). */
  stamp?: string;
  totalLabel?: string;
  /** One value per payout ("idle" at rest): a new one prints the receipt. */
  printKey?: string | number;
  /** Printed under the total once a win is in. */
  footer?: ReactNode;
  seed?: number;
  /**
   * Like a till with the order rung up: at rest only the head (the title and `lines`) is out of
   * the slot, and a payout prints the rest (the subtotal, the lucky draw, the total) under it.
   */
  headAtRest?: boolean;
  /** At rest: the light blinks while the wallet is asked, pulses while the network confirms. */
  signal?: Signal;
};

export function Receipt(props: Props) {
  const key = String(props.printKey ?? "idle");
  const reduced = usePrefersReducedMotion();
  // "New cart": the finished receipt slides away and the idle one is shown printed.
  const last = useRef<Props>(props);
  const [prevKey, setPrevKey] = useState(key);
  const [leaving, setLeaving] = useState<Props | null>(null);
  if (prevKey !== key) {
    setPrevKey(key);
    if (key === "idle" && !reduced) setLeaving(last.current);
  }
  useEffect(() => {
    last.current = props;
  });
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setLeaving(null), 720);
    return () => clearTimeout(t);
  }, [leaving]);

  return (
    <div className="receipt-stack">
      {/* a new payout is a new sheet: nothing carries over from the last one */}
      <Paper
        key={key}
        {...props}
        runKey={key}
        still={reduced || key === "idle"}
        fresh={leaving !== null}
      />
      {leaving && (
        <div className="receipt-leaving" aria-hidden="true">
          <Paper {...leaving} runKey="leaving" still />
        </div>
      )}
    </div>
  );
}

function Paper({
  title,
  lines,
  subtotalLabel = "Subtotal",
  subtotal,
  draw,
  idleText,
  drawPrice,
  wonBack: wonBackAmount,
  stamp = "Free",
  totalLabel = "TOTAL",
  footer,
  seed = 7,
  headAtRest = false,
  signal = null,
  runKey,
  still,
  fresh = false,
}: Props & { runKey: string; still: boolean; fresh?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(wrap);
  const price = drawPrice ?? 0n;
  const idle = draw === "idle";
  // At rest on a till: only the head is out of the slot, the rest not printed yet.
  const head = idle && headAtRest;

  // The clock: zero when this payout started (each payout mounts its own sheet),
  // and when its result came in.
  const run = useRef({ t0: performance.now(), result: null as number | null, ended: "" });
  // A payout that resumes after an ending (a retry after "on hold") plays its next one afresh.
  if (!isResult(draw)) run.current.ended = "";
  else if (run.current.ended !== draw) {
    run.current.ended = draw;
    run.current.result = performance.now();
  }
  const [now, setNow] = useState(() => performance.now());
  const e = head ? 0 : still ? Infinity : Math.max(0, now - run.current.t0);

  const drawLabel: Seg[] = [{ text: "Lucky draw" }];
  if (drawPrice !== undefined && !idle)
    drawLabel.push({ text: ` · ${usdc(drawPrice)}`, cls: "r-draw-price" });
  const items: Item[] = [
    { key: "title", segs: [{ text: title }] },
    ...lines.map((l) => ({
      key: `l-${l.label}`,
      segs: [{ text: l.label }],
      value: [{ text: l.value }],
    })),
    { key: "rule-1", segs: [] },
    { key: "sub", segs: [{ text: subtotalLabel }], value: [{ text: usdc(subtotal) }] },
    { key: "draw", segs: drawLabel, value: [{ text: PENDING }] },
    { key: "rule-2", segs: [] },
    {
      key: "total",
      segs: [{ text: totalLabel }],
      value: [{ text: `${usdc(subtotal + price)} USDC` }],
    },
    { key: "thanks", segs: [{ text: THANKS }] },
  ];

  // Where each line ends on the paper, so the feed stops just under it.
  const [marks, setMarks] = useState<{ bottoms: number[]; height: number } | null>(null);
  const contentKey = items.map((i) => len(i.segs) + len(i.value)).join(",");
  useLayoutEffect(() => {
    const el = paper.current;
    if (!el) return;
    const measure = () => {
      const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-p]"));
      setMarks({
        bottoms: rows.map((r) => r.offsetTop + r.offsetHeight),
        height: el.offsetHeight,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [runKey, contentKey]);

  // With `headAtRest`, the head is printed before the clock starts, at rest as during a payout,
  // so a payout picks up the paper where the resting one left it.
  const headN = headAtRest ? 1 + lines.length : 0;
  const headBottom = headN > 0 ? (marks?.bottoms[headN - 1] ?? 0) : 0;
  const minFed = headN > 0 ? headBottom + HEAD_MARGIN_PX : 0;

  // The print schedule: per line, a stepped feed, then its characters.
  let t = PRINT.delay;
  let fedTo = headBottom;
  const sched = items.map((it, k) => {
    const n = len(it.segs) + len(it.value);
    if (k < headN)
      return { from: 0, to: headBottom, steps: 1, feedAt: -Infinity, typeAt: -Infinity, n };
    const to = marks?.bottoms[k] ?? 0;
    const steps = Math.max(1, Math.ceil((to - fedTo) / PRINT.stepPx));
    const feedAt = t;
    t += steps * PRINT.stepMs;
    const typeAt = t;
    t += n * PRINT.char + PRINT.pause;
    const s = { from: fedTo, to, steps, feedAt, typeAt, n };
    fedTo = to;
    return s;
  });
  const height = marks?.height ?? 0;
  // One line's height (two adjacent rows), for the won-back line's room.
  const drawAt = lines.length + 3;
  const rowH = marks ? (marks.bottoms[drawAt] ?? 0) - (marks.bottoms[drawAt - 1] ?? 0) : 0;
  const tailSteps = Math.max(1, Math.ceil((height - fedTo) / PRINT.stepPx));
  const printEnd = marks ? t + tailSteps * PRINT.stepMs : Infinity;
  const printing = e < printEnd;

  let fed = height;
  if (printing) {
    fed = minFed;
    for (const s of sched) {
      if (e < s.feedAt) break;
      const k = Math.min(s.steps, Math.floor((e - s.feedAt) / PRINT.stepMs) + 1);
      fed = Math.max(minFed, s.from + ((s.to - s.from) * k) / s.steps);
    }
    if (marks && e >= t) {
      const k = Math.min(tailSteps, Math.floor((e - t) / PRINT.stepMs) + 1);
      fed = Math.max(minFed, fedTo + ((height - fedTo) * k) / tailSteps);
    }
  }
  const typed = (k: number) => {
    const s = sched[k];
    if (!printing || !s) return { n: Infinity, caret: false };
    const n = Math.max(0, Math.floor((e - s.typeAt) / PRINT.char));
    return { n: e < s.typeAt ? 0 : n, caret: e >= s.typeAt && n < s.n };
  };

  // The result plays once the receipt is printed and the flow has reported it.
  const resultAt = run.current.result === null ? null : run.current.result - run.current.t0;
  const reveal = still ? 0 : resultAt === null ? Infinity : Math.max(printEnd, resultAt);
  const r = e - reveal; // ms into the result; negative before it
  const won = draw === "won";
  const lost = draw === "lost";
  const end = won ? WON.end : lost ? LOST.end : QUIET.end;
  const animating = !still && (printing || (isResult(draw) && r < end));

  // The clock runs only while something moves and the receipt is on screen.
  useEffect(() => {
    if (!animating || !onScreen) return;
    let raf = requestAnimationFrame(function tick(ts) {
      setNow(ts);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [animating, onScreen]);

  const revealed = isResult(draw) && r >= 0;
  const resultText = RESULT[draw] ?? "";
  const resultTyped = (char: number) => (still ? Infinity : Math.floor(r / char) + 1);

  // The lucky draw's value, by stage.
  const drawTyped = typed(drawAt);
  let drawValue: ReactNode;
  if (idle) drawValue = drawPrice !== undefined ? usdc(drawPrice) : (idleText ?? "at checkout");
  else if (revealed)
    drawValue = (
      <Typed
        segs={[{ text: resultText }]}
        n={resultTyped(won ? WON.char : lost ? LOST.char : QUIET.char)}
        caret={false}
      />
    );
  else if ((draw === "drawing" || isResult(draw)) && drawTyped.n >= len(drawLabel))
    drawValue = still ? (
      <span className="r-scramble">DRAWING</span>
    ) : (
      <Scramble width={PENDING.length} run={onScreen} />
    );
  else
    drawValue = (
      <Typed
        segs={[{ text: PENDING }]}
        n={drawTyped.n - len(drawLabel)}
        caret={drawTyped.caret && drawTyped.n >= len(drawLabel)}
      />
    );

  const rowShown = won && revealed && r >= WON.row;
  const stamped = won && revealed && r >= WON.stamp;
  const rolled = won && revealed && r >= WON.roll;
  const torn = lost && revealed && r >= LOST.tear;
  const footerShown = won && revealed && r >= WON.footer;
  const WON_BACK = "Won back";
  // A win pays back the order and the ticket, and nothing is left to pay; a part of the order
  // leaves the rest paid.
  const owed = subtotal + price;
  const back = backOf(owed, wonBackAmount);
  const wonBack = `−${usdc(back)}`;
  const wonBackTyped = still ? Infinity : Math.floor((r - WON.rowType) / PRINT.char);

  const cls = [
    "receipt-wrap",
    `draw-${draw}`,
    still && !head ? "is-still" : "",
    head ? "is-head" : printing ? "is-printing" : "",
    head && signal ? `is-${signal}` : "",
    !still && !idle && !printing && !revealed ? "is-waiting" : "",
    revealed ? "is-revealed" : "",
    fresh ? "is-fresh" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const summary =
    draw === "drawing"
      ? "Drawing"
      : !revealed
        ? ""
        : won
          ? `Won back: ${usdc(back < owed ? back : subtotal)} USDC`
          : lost
            ? "Not this time"
            : resultText.toLowerCase();

  const row = (k: number, it: Item) => {
    const ty = typed(k);
    const head = len(it.segs);
    return (
      <div className="r-row" data-p key={it.key}>
        <span>
          <Typed segs={it.segs} n={ty.n} caret={ty.caret && ty.n < head} />
        </span>
        <span>
          <Typed segs={it.value ?? []} n={ty.n - head} caret={ty.caret && ty.n >= head} />
        </span>
      </div>
    );
  };
  const titleTyped = typed(0);
  const total = items.length - 2;
  const thanks = items.length - 1;
  const thanksTyped = typed(thanks);
  const totalTyped = typed(total);
  const totalHead = len(items[total]?.segs);

  return (
    <div className={cls} ref={wrap}>
      <div className="printer" aria-hidden="true">
        <i />
      </div>
      <div
        className={`receipt-clip${stamped && !still ? " is-thud" : ""}${torn && !still ? " is-torn" : ""}`}
      >
        <div
          className="receipt"
          ref={paper}
          style={printing ? ({ "--fed": `${fed}px` } as CSSProperties) : undefined}
        >
          <p className="receipt-title" data-p>
            <Typed segs={items[0]?.segs ?? []} n={titleTyped.n} caret={titleTyped.caret} />
          </p>
          {lines.map((_, i) => row(1 + i, items[1 + i]!))}
          <div className="r-rule" data-p />
          {row(lines.length + 2, items[lines.length + 2]!)}
          <div className={`r-row r-draw${won && revealed ? " r-v" : ""}`} data-p>
            <span>
              <Typed
                segs={drawLabel}
                n={drawTyped.n}
                caret={drawTyped.caret && drawTyped.n < len(drawLabel)}
              />
            </span>
            <span className="r-draw-value">{drawValue}</span>
          </div>
          <div className={`r-reveal${rowShown ? " show" : ""}`} aria-hidden={!rowShown}>
            <div className="r-row r-v">
              <span>
                <Typed segs={[{ text: WON_BACK }]} n={wonBackTyped} caret={false} />
              </span>
              <span>
                <Typed
                  segs={[{ text: wonBack }]}
                  n={wonBackTyped - WON_BACK.length}
                  caret={false}
                />
              </span>
            </div>
          </div>
          <div className="r-rule" data-p />
          <div className="r-row r-total" data-p>
            <span>
              <Typed
                segs={items[total]?.segs ?? []}
                n={totalTyped.n}
                caret={totalTyped.caret && totalTyped.n < totalHead}
              />
            </span>
            <span>
              {printing ? (
                <Typed
                  segs={items[total]?.value ?? []}
                  n={totalTyped.n - totalHead}
                  caret={totalTyped.caret && totalTyped.n >= totalHead}
                />
              ) : (
                <>
                  <Tween ms={620}>{usdc(rolled ? owed - back : owed)}</Tween> USDC
                </>
              )}
            </span>
          </div>
          <div className="r-thanks" data-p>
            <Typed segs={items[thanks]?.segs ?? []} n={thanksTyped.n} caret={thanksTyped.caret} />
          </div>
          {/* kept in the layout (blank) until a win prints it, so nothing shifts */}
          {footer !== undefined && (
            <div className="r-foot" aria-hidden={!footerShown}>
              {typeof footer === "string" ? (
                <Typed
                  segs={[{ text: footer }]}
                  n={
                    !footerShown ? 0 : still ? Infinity : Math.floor((r - WON.footer) / PRINT.char)
                  }
                  caret={false}
                />
              ) : footerShown ? (
                footer
              ) : null}
            </div>
          )}
          {won && (still || stamped) && <span className="r-stamp">{stamp}</span>}
        </div>
        <Pixels
          count={22}
          rows={5}
          seed={seed}
          className="receipt-pixels"
          style={printing ? { transform: `translateY(${Math.round(fed - height)}px)` } : undefined}
        />
        {won && revealed && !still && r >= WON.confetti && <EdgeConfetti seed={seed + 11} />}
      </div>
      {/* the won-back line's room: the paper feeds into it, so the slot never moves */}
      <div
        className={`r-spare${rowShown ? " used" : ""}`}
        style={{ height: rowShown ? 0 : rowH }}
      />
      <p className="sr-only" aria-live="polite">
        {summary}
      </p>
    </div>
  );
}
