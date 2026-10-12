// Progressive disclosure: what explains a figure lives one level down, in an
// (i) tooltip or a "Details" section that opens with an animated height.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { DOCS_POOL_URL } from "../lib/config";

/**
 * A small (i) button with a tooltip. It opens on hover, on keyboard focus and
 * on tap (a tap pins it until the next tap, Escape or a tap elsewhere). The
 * text is the button's accessible description, so screen readers read it
 * without opening anything. The bubble is positioned in the viewport, so
 * clipping containers never cut it.
 *
 * With `docs`, the bubble ends with a link to the docs: the pointer can move
 * onto it, and Tab from the open button moves the focus to it.
 */
export function InfoTip({
  children,
  label = "More information",
  docs,
}: {
  /** Phrasing content only: it renders inside a span. */
  children: ReactNode;
  label?: string;
  /** A docs link at the end of the bubble: `true` for the liquidity page, or a URL. */
  docs?: boolean | string;
}) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const link = useRef<HTMLAnchorElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean; origin: number } | null>(
    null,
  );
  const open = hover || focus || pinned;
  const href = docs === true ? DOCS_POOL_URL : docs || null;

  const close = useCallback(() => {
    setHover(false);
    setFocus(false);
    setPinned(false);
  }, []);
  const inside = (n: EventTarget | null) =>
    n instanceof Node && (btn.current?.contains(n) || tip.current?.contains(n));
  const hoverOn = () => {
    clearTimeout(leaveTimer.current);
    setHover(true);
  };
  // a short delay lets the pointer cross the gap to a bubble that holds a link
  const hoverOff = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHover(false), href ? 160 : 0);
  };
  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const b = btn.current?.getBoundingClientRect();
    const t = tip.current;
    if (!b || !t) return;
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const centre = b.left + b.width / 2;
    const x = Math.min(Math.max(12, centre - w / 2), vw - 12 - w);
    // Above when there is room under the sticky header, below otherwise.
    const below = b.top - h - 10 < 76;
    const y = below ? b.bottom + 8 : b.top - h - 8;
    setPos({ x, y, below, origin: centre - x });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (tip.current?.contains(document.activeElement)) btn.current?.focus();
      close();
    };
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target)) close();
    };
    const onScroll = () => close();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, close]);

  return (
    <span className="tip-wrap">
      <button
        ref={btn}
        type="button"
        className={`tip-btn${open ? " on" : ""}`}
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onPointerEnter={(e) => e.pointerType === "mouse" && hoverOn()}
        onPointerLeave={(e) => e.pointerType === "mouse" && hoverOff()}
        onFocus={(e) => setFocus(e.currentTarget.matches(":focus-visible"))}
        onBlur={(e) => {
          if (inside(e.relatedTarget)) return;
          setFocus(false);
          setPinned(false);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Tab" || e.shiftKey || !href || !open) return;
          e.preventDefault();
          link.current?.focus();
        }}
        onClick={() => setPinned((p) => !p)}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <rect x="6.3" y="6" width="1.4" height="4.4" rx="0.5" fill="currentColor" />
          <rect x="6.3" y="3.4" width="1.4" height="1.4" rx="0.5" fill="currentColor" />
        </svg>
      </button>
      {createPortal(
        <span
          ref={tip}
          id={id}
          role="tooltip"
          className={`tip${open && pos ? " open" : ""}${pos?.below ? " below" : ""}${href ? " has-link" : ""}`}
          style={
            (pos
              ? { left: pos.x, top: pos.y, "--origin": `${pos.origin}px` }
              : { left: 0, top: 0 }) as CSSProperties
          }
          onPointerEnter={(e) => e.pointerType === "mouse" && href && hoverOn()}
          onPointerLeave={(e) => e.pointerType === "mouse" && href && hoverOff()}
        >
          {children}
          {href && (
            <a
              ref={link}
              className="tip-link"
              href={href}
              target="_blank"
              rel="noreferrer"
              tabIndex={open ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key !== "Tab") return;
                // the bubble sits outside the page's order: Shift+Tab goes back to the
                // button, Tab on to what follows it
                e.preventDefault();
                if (e.shiftKey) btn.current?.focus();
                else {
                  close();
                  focusNext(btn.current);
                }
              }}
              onBlur={(e) => {
                if (!inside(e.relatedTarget)) close();
              }}
            >
              Learn more in the docs
              <span className="sr-only"> (opens docs.fade.finance)</span>
            </a>
          )}
        </span>,
        document.body,
      )}
    </span>
  );
}

/** Moves the focus to the next focusable element after `from`, in document order. */
function focusNext(from: HTMLElement | null) {
  if (!from) return;
  const all = [
    ...document.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => !el.closest(".tip") && el.offsetParent !== null);
  const i = all.indexOf(from);
  all[i + 1]?.focus();
}

/** Content whose height opens and closes smoothly; hidden content is inert. */
export function Collapse({
  open,
  id,
  children,
  className,
}: {
  open: boolean;
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      id={id}
      className={`collapse${open ? " open" : ""}${className ? ` ${className}` : ""}`}
      inert={!open}
    >
      <div className="collapse-inner">{children}</div>
    </div>
  );
}

/** A "Details" toggle and the section it opens. */
export function Disclosure({
  summary,
  openSummary,
  children,
  className,
  defaultOpen = false,
}: {
  summary: ReactNode;
  /** The toggle's text while open, if it differs ("Fewer odds"). */
  openSummary?: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`disclosure${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="disclosure-btn"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="chev" aria-hidden="true" />
        {open && openSummary ? openSummary : summary}
      </button>
      <Collapse open={open} id={id}>
        <div className="disclosure-body">{children}</div>
      </Collapse>
    </div>
  );
}
