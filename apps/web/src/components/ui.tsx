import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { explorerAddress, explorerTx } from "../lib/config";
import { short } from "../lib/format";
import type { ProgramFailure } from "../lib/tx";
import { InfoTip } from "./disclosure";
import { Tween, usePrefersReducedMotion } from "./motion";

export { usePrefersReducedMotion };

export function ExtIcon() {
  return (
    <svg className="ext-icon" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3 1h6v6M9 1L1 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function ExplorerTx({ sig, children }: { sig: string; children?: ReactNode }) {
  return (
    <a className="ext" href={explorerTx(sig)} target="_blank" rel="noreferrer">
      {children ?? <span className="mono">{short(sig, 6)}</span>}
      <ExtIcon />
      <span className="sr-only"> (opens the Solana explorer)</span>
    </a>
  );
}

export function ExplorerAddress({ address, children }: { address: string; children?: ReactNode }) {
  return (
    <a className="ext" href={explorerAddress(address)} target="_blank" rel="noreferrer">
      {children ?? <span className="mono">{short(address)}</span>}
      <ExtIcon />
      <span className="sr-only"> (opens the Solana explorer)</span>
    </a>
  );
}

export function FailureBox({ failure, title }: { failure: ProgramFailure; title?: string }) {
  const errorLine = failure.logs.find((l) => l.includes("Error Code:"));
  return (
    <div className="failure" role="alert">
      <p className="failure-title">
        <span className="failure-icon" aria-hidden="true" />
        {title ?? "Refused by the program"}
      </p>
      {failure.name && (
        <p className="failure-name mono">
          {failure.name}
          {failure.code !== null && <span className="muted"> ({failure.code})</span>}
        </p>
      )}
      <p>{failure.message}</p>
      {errorLine && (
        <p className="mono small muted log">{errorLine.replace(/^Program log: /, "")}</p>
      )}
    </div>
  );
}

export function Stat({
  label,
  value,
  unit,
  sub,
  info,
  accent,
}: {
  label: string;
  /** A formatted figure tweens when it changes; any other node is shown as is. */
  value: ReactNode;
  unit?: string | undefined;
  sub?: ReactNode;
  /** What the figure means: behind an (i) next to the label. */
  info?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={`stat${accent ? " stat-accent" : ""}`}>
      <div className="stat-label label-tip">
        {label}
        {info && <InfoTip label={`About ${label.toLowerCase()}`}>{info}</InfoTip>}
      </div>
      <div className="stat-value">
        <span className="mono">{typeof value === "string" ? <Tween>{value}</Tween> : value}</span>
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export type ChipTone = "won" | "neutral" | "warn" | "info" | "bad";

export function Chip({ tone = "neutral", children }: { tone?: ChipTone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role={label ? "status" : undefined}>
      <i />
      <i />
      <i />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

/** Deterministic pseudo-random numbers, so the pixels never jump between renders. */
export function seeded(seed: number) {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** The receipt's torn edge, dissolving into pixels. */
export function Pixels({
  count = 18,
  rows = 4,
  seed = 3,
  className,
  style,
}: {
  count?: number;
  rows?: number;
  seed?: number;
  className?: string;
  style?: CSSProperties | undefined;
}) {
  const rnd = seeded(seed);
  const cells = Array.from({ length: count * rows }, (_, i) => {
    const row = Math.floor(i / count);
    const keep = rnd() < 0.78 - row * (0.7 / rows);
    const tone = rnd();
    return { i, row, keep, tone: tone < 0.45 ? "paper" : tone < 0.82 ? "violet" : "dim" };
  });
  return (
    <div
      className={`pixels ${className ?? ""}`}
      style={{ gridTemplateColumns: `repeat(${count}, 1fr)`, ...style }}
      aria-hidden="true"
    >
      {cells.map((c) => (
        <span
          key={c.i}
          className={c.keep ? `px px-${c.tone}` : "px"}
          style={{ "--r": c.row, "--d": `${(c.i % count) * 23}ms` } as CSSProperties}
        />
      ))}
    </div>
  );
}

/** A burst of square pixels: the win moment. Hidden under prefers-reduced-motion. */
export function PixelBurst({ seed = 5, count = 42 }: { seed?: number; count?: number }) {
  const rnd = seeded(seed);
  return (
    <div className="burst" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => {
        const angle = rnd() * Math.PI * 2;
        const dist = 90 + rnd() * 190;
        const size = rnd() < 0.3 ? 10 : rnd() < 0.6 ? 7 : 5;
        const tone = rnd();
        return (
          <i
            key={i}
            className={tone < 0.55 ? "b-violet" : tone < 0.9 ? "b-paper" : "b-dim"}
            style={
              {
                "--x": `${Math.cos(angle) * dist}px`,
                "--y": `${Math.sin(angle) * dist * 0.75 - 40}px`,
                "--s": `${size}px`,
                "--d": `${Math.round(rnd() * 140)}ms`,
                "--t": `${900 + Math.round(rnd() * 600)}ms`,
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

/** Counts a number from `from` to `to` (an ease-out over `ms`), formatted by `format`. */
export function CountTo({
  from,
  to,
  ms = 900,
  format,
}: {
  from: number;
  to: number;
  ms?: number;
  format: (v: number) => string;
}) {
  const reduced = usePrefersReducedMotion();
  const [v, setV] = useState(reduced ? to : from);
  const raf = useRef(0);
  useEffect(() => {
    if (reduced) {
      setV(to);
      return;
    }
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - (1 - k) ** 3;
      setV(from + (to - from) * e);
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [from, to, ms, reduced]);
  return <>{format(v)}</>;
}

/** Seconds from `since` to `until`, ticking while `until` is not set yet. */
export function useElapsed(since: number | undefined, until: number | undefined): number | null {
  const running = since !== undefined && until === undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [running]);
  if (since === undefined) return null;
  return Math.max(0, ((until ?? now) - since) / 1000);
}

export function NotInitialized() {
  return (
    <div className="notice">
      <p className="notice-title">The vault is being set up</p>
      <p>
        The program is deployed but not initialized yet. This page reads it every few seconds and
        fills in by itself once it is.
      </p>
    </div>
  );
}

export function Skeleton({
  h = 18,
  w = "100%",
  inline,
}: {
  h?: number;
  w?: number | string;
  inline?: boolean;
}) {
  return (
    <span
      className={`skeleton${inline ? " skeleton-inline" : ""}`}
      style={{ height: h, width: w }}
      aria-hidden="true"
    />
  );
}
