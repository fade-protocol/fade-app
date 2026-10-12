// The app is a fixed-height shell on desktop: what is longer than its panel
// scrolls inside the panel, never the page. A ScrollArea fades its edges while
// there is more to see, and becomes a keyboard stop only when it can scroll.
// Below the desktop breakpoint the page scrolls and these are plain blocks.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export function ScrollArea({
  label,
  children,
  className,
  id,
}: {
  /** Names the region for screen readers and keyboard users. */
  label: string;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const scrollable = edges.top || edges.bottom;

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Content changes size without the area changing: watch the children too.
    const mo = new MutationObserver(() => {
      for (const c of Array.from(el.children)) ro.observe(c);
      measure();
    });
    for (const c of Array.from(el.children)) ro.observe(c);
    mo.observe(el, { childList: true, subtree: true });
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [measure]);

  return (
    <div
      ref={ref}
      id={id}
      className={`scroll-area${className ? ` ${className}` : ""}`}
      data-more-top={edges.top || undefined}
      data-more-bottom={edges.bottom || undefined}
      role={scrollable ? "region" : undefined}
      aria-label={scrollable ? label : undefined}
      tabIndex={scrollable ? 0 : undefined}
    >
      {children}
    </div>
  );
}

/**
 * A small button that opens a panel of explanations next to it, for content
 * that would otherwise take a block of the screen. Closes on Escape, on a
 * click elsewhere, and gives focus back to its button.
 */
export function Popover({
  label,
  title,
  children,
  align = "end",
}: {
  label: ReactNode;
  title: string;
  children: ReactNode;
  align?: "start" | "end";
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span className="pop-wrap" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className={`pop-btn${open ? " on" : ""}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <rect x="6.3" y="6" width="1.4" height="4.4" rx="0.5" fill="currentColor" />
          <rect x="6.3" y="3.4" width="1.4" height="1.4" rx="0.5" fill="currentColor" />
        </svg>
        {label}
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={title} className={`pop pop-${align}`}>
          {children}
        </div>
      )}
    </span>
  );
}
