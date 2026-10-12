// The vault's main chart: one line and its gradient area, in plain SVG, that morphs between
// series and ranges instead of jumping. Every series is resampled to the same number of points
// over its time range and each point is kept as its height in the plot (0 at the bottom of the
// axis, 1 at the top), so any two can be tweened point by point whatever their units: a share
// price near 1 morphs into deposits in the tens of thousands as smoothly as a range change. The
// axis bounds ease over the same frames, and the axis labels roll with them. The frames run on
// requestAnimationFrame and write the path attributes directly, without a React render per
// frame. The crosshair eases toward the pointer and reads the value under it. With reduced
// motion, every change is immediate.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { usePrefersReducedMotion } from "./motion";

export type FluidPoint = { t: number; v: number };

/** Samples per series: dense enough to look like a curve at any width, cheap to tween. */
const N = 180;
const PAD = { top: 18, right: 14, bottom: 28, left: 64 };
/** Horizontal grid lines, from the top. */
const GRID = 4;
const MORPH_MS = 650;
const REVEAL_MS = 1100;
/** How far the crosshair closes on the pointer each frame. */
const FOLLOW = 0.28;

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x: number) => 1 - (1 - x) ** 3;

/**
 * The value at `t`, linear between points (or held from the last point, `step`), held flat
 * beyond the ends.
 */
function valueAt(points: readonly FluidPoint[], t: number, step = false): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return 0;
  if (t <= first.t) return first.v;
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo]!;
  const b = points[hi]!;
  if (step) return a.v;
  return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/**
 * One sampled series: each point's height in the plot (`hs`, 0 at `lo`, 1 at `hi`), the axis
 * bounds, and how its axis labels are written.
 */
type Frame = { hs: Float64Array; lo: number; hi: number; fmt: (v: number) => string };

function sample(
  points: readonly FluidPoint[],
  t0: number,
  t1: number,
  zeroBased: boolean,
  step: boolean,
  fmt: (v: number) => string,
): Frame {
  const ys = new Float64Array(N);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < N; i++) {
    const v = valueAt(points, t0 + ((t1 - t0) * i) / (N - 1), step);
    ys[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) lo = hi = 0;
  const pad = (hi - lo) * 0.14 || Math.abs(hi) * 0.004 || 1;
  const a = zeroBased ? Math.min(0, lo) : lo - pad;
  const b = hi + pad;
  const hs = ys.map((v) => (v - a) / (b - a));
  return { hs, lo: a, hi: b, fmt };
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const stamp = (t: number) =>
  `${dateFmt.format(new Date(t * 1000))} ${timeFmt.format(new Date(t * 1000))}`;

export function FluidChart({
  points,
  from,
  to,
  format,
  axisFormat = format,
  label,
  zeroBased = false,
  step = false,
}: {
  /** Sorted by time. */
  points: readonly FluidPoint[];
  /** The time range shown, Unix seconds. */
  from: number;
  to: number;
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
  /** What the chart shows, for screen readers. */
  label: string;
  /** The axis starts at 0 (volumes). */
  zeroBased?: boolean;
  /** Each point holds until the next (per-period totals): steps, not slopes. */
  step?: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const gid = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 640, h: 240 });
  const line = useRef<SVGPathElement>(null);
  const area = useRef<SVGPathElement>(null);
  const clip = useRef<SVGRectElement>(null);
  const endDot = useRef<SVGCircleElement>(null);
  const cross = useRef<SVGGElement>(null);
  const crossLine = useRef<SVGLineElement>(null);
  const crossDot = useRef<SVGCircleElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const tipValue = useRef<HTMLSpanElement>(null);
  const tipTime = useRef<HTMLSpanElement>(null);
  const gridText = useRef<(SVGTextElement | null)[]>([]);
  const live = useRef<HTMLSpanElement>(null);

  // everything the frames read, kept out of React state
  const st = useRef({
    disp: null as Frame | null,
    from: null as Frame | null,
    to: null as Frame | null,
    start: 0,
    revealStart: 0,
    reveal: 1,
    hoverTarget: null as number | null,
    hoverX: 0,
    raf: 0,
    w: 640,
    h: 240,
    points: points,
    t0: from,
    t1: to,
    format,
    reduced,
    step,
  });
  const s = st.current;
  s.step = step;
  s.points = points;
  s.format = format;
  s.reduced = reduced;
  s.w = size.w;
  s.h = size.h;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      if (!e) return;
      const w = Math.max(240, Math.round(e.contentRect.width));
      const h = Math.max(140, Math.round(e.contentRect.height));
      setSize((o) => (o.w === w && o.h === h ? o : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Draws the current frame; returns whether another one is needed. */
  const draw = (now: number): boolean => {
    let more = false;
    if (s.to && s.from && s.disp) {
      const p = s.reduced ? 1 : Math.min(1, (now - s.start) / MORPH_MS);
      const e = easeInOut(p);
      for (let i = 0; i < N; i++) s.disp.hs[i] = s.from.hs[i]! + (s.to.hs[i]! - s.from.hs[i]!) * e;
      s.disp.lo = s.from.lo + (s.to.lo - s.from.lo) * e;
      s.disp.hi = s.from.hi + (s.to.hi - s.from.hi) * e;
      // the labels keep the old series' writing for the first half, the new one's after
      s.disp.fmt = e < 0.5 ? s.from.fmt : s.to.fmt;
      if (p < 1) more = true;
    }
    if (s.reveal < 1) {
      s.reveal = s.reduced ? 1 : Math.min(1, (now - s.revealStart) / REVEAL_MS);
      if (s.reveal < 1) more = true;
    }
    const d = s.disp;
    if (!d) return more;
    const iw = s.w - PAD.left - PAD.right;
    const ih = s.h - PAD.top - PAD.bottom;
    const span = d.hi - d.lo || 1;
    const X = (i: number) => PAD.left + (i / (N - 1)) * iw;
    const Y = (h: number) => PAD.top + (1 - h) * ih;
    let path = "";
    for (let i = 0; i < N; i++)
      path += `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(d.hs[i]!).toFixed(1)}`;
    line.current?.setAttribute("d", path);
    area.current?.setAttribute(
      "d",
      `${path}L${X(N - 1).toFixed(1)},${PAD.top + ih}L${PAD.left},${PAD.top + ih}Z`,
    );
    clip.current?.setAttribute("width", String(PAD.left + easeOut(s.reveal) * (iw + PAD.right)));
    endDot.current?.setAttribute("cx", X(N - 1).toFixed(1));
    endDot.current?.setAttribute("cy", Y(d.hs[N - 1]!).toFixed(1));
    endDot.current?.setAttribute("opacity", s.reveal >= 1 ? "1" : "0");
    for (let g = 0; g < GRID; g++) {
      const el = gridText.current[g];
      if (el) el.textContent = d.fmt(d.hi - (span * (g + 0.5)) / GRID);
    }

    if (s.hoverTarget !== null) {
      const k = s.reduced ? 1 : FOLLOW;
      s.hoverX += (s.hoverTarget - s.hoverX) * k;
      if (Math.abs(s.hoverTarget - s.hoverX) > 0.3) more = true;
      else s.hoverX = s.hoverTarget;
      const x = Math.min(Math.max(s.hoverX, PAD.left), PAD.left + iw);
      const fi = ((x - PAD.left) / iw) * (N - 1);
      const i0 = Math.floor(fi);
      const i1 = Math.min(N - 1, i0 + 1);
      const y = Y(d.hs[i0]! + (d.hs[i1]! - d.hs[i0]!) * (fi - i0));
      crossLine.current?.setAttribute("x1", x.toFixed(1));
      crossLine.current?.setAttribute("x2", x.toFixed(1));
      crossDot.current?.setAttribute("cx", x.toFixed(1));
      crossDot.current?.setAttribute("cy", y.toFixed(1));
      const t = s.t0 + ((x - PAD.left) / iw) * (s.t1 - s.t0);
      // the figure is read from the series itself, not from the eased line
      if (tipValue.current) tipValue.current.textContent = s.format(valueAt(s.points, t, s.step));
      if (tipTime.current) tipTime.current.textContent = stamp(t);
      if (tip.current) {
        const tw = tip.current.offsetWidth;
        const left = Math.min(Math.max(x - tw / 2, 4), s.w - tw - 4);
        const top = Math.max(2, y - tip.current.offsetHeight - 14);
        tip.current.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
      }
    }
    return more;
  };

  const kick = () => {
    if (s.raf) return;
    const loop = (now: number) => {
      s.raf = 0;
      if (draw(now)) s.raf = requestAnimationFrame(loop);
    };
    s.raf = requestAnimationFrame(loop);
  };

  useEffect(
    () => () => {
      cancelAnimationFrame(s.raf);
      // a frame cancelled here must not look pending to the next kick (StrictMode remounts)
      s.raf = 0;
    },
    [s],
  );

  // a new series or range: morph from what is on screen; the first one draws itself in
  useEffect(() => {
    const target = sample(points, from, to, zeroBased, step, axisFormat);
    s.t0 = from;
    s.t1 = to;
    const now = performance.now();
    if (!s.disp) {
      s.disp = { ...target, hs: Float64Array.from(target.hs) };
      s.from = target;
      s.to = target;
      s.reveal = 0;
      s.revealStart = now;
    } else {
      s.from = { ...s.disp, hs: Float64Array.from(s.disp.hs) };
      s.to = target;
      s.start = now;
    }
    if (s.reduced) draw(now + MORPH_MS + REVEAL_MS);
    kick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, from, to, zeroBased, step]);

  // a resize redraws at once
  useEffect(() => {
    if (draw(performance.now())) kick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h]);

  const show = (on: boolean) => {
    cross.current?.classList.toggle("on", on);
    tip.current?.classList.toggle("on", on);
  };
  const pointAt = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const x = clientX - r.left;
    if (s.hoverTarget === null) s.hoverX = x;
    s.hoverTarget = x;
    show(true);
    kick();
  };
  const leave = () => {
    s.hoverTarget = null;
    show(false);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const iw = s.w - PAD.left - PAD.right;
    const step = e.shiftKey ? iw / 6 : iw / 30;
    const cur = s.hoverTarget ?? PAD.left + iw;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = cur - step;
    else if (e.key === "ArrowRight") next = cur + step;
    else if (e.key === "Home") next = PAD.left;
    else if (e.key === "End") next = PAD.left + iw;
    else if (e.key === "Escape") return leave();
    if (next === null) return;
    e.preventDefault();
    next = Math.min(Math.max(next, PAD.left), PAD.left + iw);
    if (s.hoverTarget === null) s.hoverX = next;
    s.hoverTarget = next;
    show(true);
    kick();
    const t = s.t0 + ((next - PAD.left) / iw) * (s.t1 - s.t0);
    if (live.current)
      live.current.textContent = `${s.format(valueAt(s.points, t, s.step))}, ${stamp(t)}`;
  };

  const { w, h } = size;
  const ih = h - PAD.top - PAD.bottom;
  const last = points[points.length - 1];
  const span = to - from;
  const xFmt = (t: number) =>
    span <= 1.5 * 86400 ? timeFmt.format(new Date(t * 1000)) : dateFmt.format(new Date(t * 1000));

  return (
    <div
      className="fchart"
      ref={box}
      tabIndex={0}
      role="group"
      aria-roledescription="chart"
      aria-label={`${label}${last ? `, latest ${format(last.v)}` : ""}. Arrow keys read the values.`}
      onPointerMove={(e) => pointAt(e.clientX)}
      onPointerDown={(e) => pointAt(e.clientX)}
      onPointerLeave={leave}
      onFocus={(e) => {
        if (e.currentTarget.matches(":focus-visible")) {
          s.hoverTarget = null;
          onKey({
            key: "End",
            preventDefault() {},
            shiftKey: false,
          } as KeyboardEvent<HTMLDivElement>);
        }
      }}
      onBlur={leave}
      onKeyDown={onKey}
    >
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        <defs>
          <linearGradient id={`fa-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--violet)" stopOpacity="0.38" />
            <stop offset="70%" stopColor="var(--violet)" stopOpacity="0.06" />
            <stop offset="100%" stopColor="var(--violet)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`fl-${gid}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--violet-2)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--violet-2)" />
          </linearGradient>
          <clipPath id={`fc-${gid}`}>
            <rect ref={clip} x="0" y="0" width={w} height={h} />
          </clipPath>
        </defs>
        {Array.from({ length: GRID }, (_, g) => {
          const y = PAD.top + ((g + 0.5) / GRID) * ih;
          return (
            <g key={g}>
              <line x1={PAD.left} x2={w - PAD.right} y1={y} y2={y} className="fchart-grid" />
              <text
                ref={(el) => {
                  gridText.current[g] = el;
                }}
                x={PAD.left - 10}
                y={y + 4}
                textAnchor="end"
                className="fchart-axis"
              />
            </g>
          );
        })}
        {[0, 0.5, 1].map((f) => (
          <text
            key={f}
            x={PAD.left + f * (w - PAD.left - PAD.right)}
            y={h - 8}
            textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}
            className="fchart-axis"
          >
            {xFmt(from + f * span)}
          </text>
        ))}
        <g clipPath={`url(#fc-${gid})`}>
          <path ref={area} fill={`url(#fa-${gid})`} />
          <path ref={line} className="fchart-line" stroke={`url(#fl-${gid})`} />
        </g>
        <circle ref={endDot} r="4" className="fchart-end" opacity="0" />
        <g ref={cross} className="fchart-cross">
          <line ref={crossLine} y1={PAD.top} y2={PAD.top + ih} className="fchart-cursor" />
          <circle ref={crossDot} r="5" className="fchart-dot" />
        </g>
      </svg>
      <div ref={tip} className="fchart-tip" aria-hidden="true">
        <span ref={tipValue} className="mono" />
        <span ref={tipTime} className="small muted" />
      </div>
      <span ref={live} className="sr-only" aria-live="polite" />
    </div>
  );
}
