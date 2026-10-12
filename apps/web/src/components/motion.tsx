// Motion primitives: numbers that tween, a sliding indicator for tabs and
// segmented controls, a wrapper whose height follows its content, and the
// direction-aware entrance of a panel. CSS does the animating; these hooks only
// measure. Under prefers-reduced-motion everything is instant.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

const reducedNow = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Tweens towards `target` over `ms` with an ease-out; instant under reduced motion. */
export function useTween(target: number, ms = 300): number {
  const reduced = usePrefersReducedMotion();
  const [v, setV] = useState(target);
  const from = useRef(target);
  const shown = useRef(target);
  const raf = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (reduced || !Number.isFinite(target) || !Number.isFinite(shown.current)) {
      shown.current = target;
      setV(target);
      return;
    }
    from.current = shown.current;
    if (from.current === target) return;
    // The clock starts at the first frame: a frame's timestamp can precede the effect.
    let t0: number | null = null;
    const step = (t: number) => {
      t0 ??= t;
      const k = Math.min(1, Math.max(0, (t - t0) / ms));
      const e = 1 - (1 - k) ** 3;
      const next = k >= 1 ? target : from.current + (target - from.current) * e;
      shown.current = next;
      setV(next);
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms, reduced]);
  return v;
}

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g;

type Parsed = { before: string; after: string; value: number; decimals: number; grouped: boolean };

function parse(text: string): Parsed | null {
  // The last number is the one that moves: "1 in 1,926", "epoch 12, 3.89 %".
  const m = [...text.matchAll(NUMBER)].at(-1);
  if (!m || m.index === undefined) return null;
  const raw = m[0];
  const value = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 10) return null;
  return {
    before: text.slice(0, m.index),
    after: text.slice(m.index + raw.length),
    value,
    decimals: raw.split(".")[1]?.length ?? 0,
    grouped: raw.includes(","),
  };
}

/**
 * Shows `children`, a formatted figure such as "1,234.56" or "3.89 %": when it
 * changes, the number in it counts to the new value (~300 ms) in the same
 * format. Text around the number is kept; anything not numeric just swaps.
 */
export function Tween({ children, ms = 320 }: { children: string; ms?: number }) {
  const p = parse(children);
  const v = useTween(p?.value ?? 0, ms);
  const fmt = useRef<Intl.NumberFormat | null>(null);
  const key = p ? `${p.decimals}|${p.grouped}` : "";
  const fmtKey = useRef("");
  if (!p) return <>{children}</>;
  if (fmtKey.current !== key || !fmt.current) {
    fmt.current = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: p.decimals,
      maximumFractionDigits: p.decimals,
      useGrouping: p.grouped,
    });
    fmtKey.current = key;
  }
  // At rest the text is exactly the formatted input, never a re-rounding of it.
  if (v === p.value) return <>{children}</>;
  return (
    <>
      {p.before}
      {fmt.current.format(v)}
      {p.after}
    </>
  );
}

/**
 * Keeps an indicator under the active child of `ref` (the one with
 * aria-selected="true", aria-pressed="true" or the class "on"): it writes the
 * child's box as CSS variables on the container, and `.ind` animates to it.
 */
export function useSlidingIndicator(ref: RefObject<HTMLElement | null>, active: unknown) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>(
        ':scope > [aria-selected="true"], :scope > [aria-pressed="true"], :scope > .on',
      );
      if (!on) {
        el.style.setProperty("--ind-o", "0");
        return;
      }
      el.style.setProperty("--ind-o", "1");
      el.style.setProperty("--ind-x", `${on.offsetLeft}px`);
      el.style.setProperty("--ind-y", `${on.offsetTop}px`);
      el.style.setProperty("--ind-w", `${on.offsetWidth}px`);
      el.style.setProperty("--ind-h", `${on.offsetHeight}px`);
    };
    place();
    // The first placement does not slide in from the corner.
    const raf = requestAnimationFrame(() => el.classList.add("ind-ready"));
    const ro = new ResizeObserver(place);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [ref, active]);
}

/** The moving piece of a sliding indicator; its container sets the variables. */
export function Indicator() {
  return <span className="ind" aria-hidden="true" />;
}

/**
 * The direction of travel between two positions of a list: 1 forwards, -1
 * backwards. Panels use it to enter from the side they were reached from.
 */
export function useDirection(index: number): number {
  const prev = useRef(index);
  const dir = useRef(1);
  if (prev.current !== index) {
    dir.current = index > prev.current ? 1 : -1;
    prev.current = index;
  }
  return dir.current;
}

/** Style for an entering panel: it slides a little from the side of travel. */
export const enterStyle = (dir: number) => ({ "--dir": dir }) as CSSProperties;

/**
 * Animates its height to follow its content instead of jumping. The content
 * lays out as usual; the wrapper only clips while it animates, so popovers
 * inside are never cut off at rest.
 */
export function AnimatedHeight({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    let last = i.offsetHeight;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const done = (e?: TransitionEvent) => {
      if (e && (e.target !== o || e.propertyName !== "height")) return;
      o.style.height = "";
      o.classList.remove("is-resizing");
    };
    const ro = new ResizeObserver(() => {
      const next = i.offsetHeight;
      const from = o.classList.contains("is-resizing") ? o.offsetHeight : last;
      last = next;
      if (reducedNow() || Math.abs(next - from) < 2) return;
      o.classList.add("is-resizing");
      o.style.height = `${from}px`;
      void o.offsetHeight;
      o.style.height = `${next}px`;
      clearTimeout(fallback);
      fallback = setTimeout(done, 450);
    });
    ro.observe(i);
    o.addEventListener("transitionend", done);
    return () => {
      ro.disconnect();
      clearTimeout(fallback);
      o.removeEventListener("transitionend", done);
    };
  }, []);
  return (
    <div ref={outer} className={`auto-h${className ? ` ${className}` : ""}`}>
      <div ref={inner}>{children}</div>
    </div>
  );
}

/** Briefly true after `trigger` changes to a truthy value: for success ticks and shakes. */
export function useFlash(trigger: unknown, ms = 1600): boolean {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!trigger) return;
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [trigger, ms]);
  return on;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The keys of a live list that arrived since the last read, for `ms`: what the list's
 * entrance animation highlights. The first read only seeds what was already there, so a
 * page that opens does not light up every row. A key that encodes a row's state (a ticket
 * and its result) also lights the row up when that state changes.
 */
export function useFreshKeys(keys: readonly string[] | null, ms = 2600): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [fresh, setFresh] = useState(NONE);
  const sig = keys?.join("\n") ?? null;
  useEffect(() => {
    if (!keys) return;
    if (!seen.current) {
      seen.current = new Set(keys);
      return;
    }
    const known = seen.current;
    const added = keys.filter((k) => !known.has(k));
    for (const k of added) known.add(k);
    if (added.length === 0) return;
    setFresh(new Set(added));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFresh(NONE), ms);
    // keys is read through sig: a new array with the same keys is not an arrival
  }, [sig, ms]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return fresh;
}
