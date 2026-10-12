import { SHARE_DECIMALS, USDC_DECIMALS } from "./config";

/** The minus sign every figure uses (U+2212), never a hyphen. */
export const MINUS = "\u2212";

/**
 * Fixed-point bigint to a decimal string with `digits` decimals, truncated toward zero: a
 * figure never shows more than there is, a gain or a loss alike. A negative value that shows as
 * zero carries no sign: never "−0.00".
 */
export function fixed(value: bigint, decimals: number, digits: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  let frac = (v % scale).toString().padStart(decimals, "0").slice(0, digits);
  if (digits === 0) frac = "";
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const zero = whole === 0n && !/[1-9]/.test(frac);
  return `${neg && !zero ? MINUS : ""}${wholeStr}${frac ? `.${frac}` : ""}`;
}

/** Micro-USDC to "1 234.56". */
export const usdc = (v: bigint, digits = 2) => fixed(v, USDC_DECIMALS, digits);
export const shares = (v: bigint, digits = 2) => fixed(v, SHARE_DECIMALS, digits);
export const sol = (lamports: bigint, digits = 4) => fixed(lamports, 9, digits);

/** "15,000" for whole USDC, "2.50" otherwise. */
export const usdcTidy = (v: bigint) => usdc(v, v % 1_000_000n === 0n ? 0 : 2);

/**
 * A signed amount: "+1.50", "−1.50", and "0.00" with no sign when it shows as zero (a loss of a
 * fraction of a cent is not a "−0.00", a gain of one not a "+0.00"). `show` formats the size.
 */
export function signedAmount(v: bigint, show: (v: bigint) => string = usdc): string {
  const text = show(v < 0n ? -v : v);
  if (!/[1-9]/.test(text)) return text;
  return `${v < 0n ? MINUS : "+"}${text}`;
}

/**
 * A signed percentage from a number of percent: "+1.250 %", "−0.40%", "0.000 %" when it shows as
 * zero; "–" when there is no number to show (NaN or infinite never reach the screen).
 */
export function signedPct(v: number, digits = 2, unit = " %"): string {
  if (!Number.isFinite(v)) return "–";
  const text = Math.abs(v).toFixed(digits);
  if (!/[1-9]/.test(text)) return `${text}${unit}`;
  return `${v < 0 ? MINUS : "+"}${text}${unit}`;
}

/** Basis points to "3.50 %". */
export const bps = (v: bigint, digits = 2) => `${fixed(v, 2, digits)} %`;

/** A multiplier in bps to "24.79×". */
export function mult(mBps: bigint): string {
  const s = fixed(mBps, 4, 4).replace(/\.?0+$/, "");
  return `${s}×`;
}

/** A probability in 1e9 units to "3.89 %". */
export function chance(p: bigint, digits = 2): string {
  return `${fixed(p, 7, digits)} %`;
}

/**
 * "1 in 26" for N in "1 in N", rounded so it never reads better than N: up to the next whole
 * above ten, up to the next tenth below, and "almost always" under 1.05.
 */
export function oneInWords(n: number): string {
  if (n < 1.05) return "almost always";
  // N comes to a thousandth: the epsilon keeps an exact 100.000 at 100
  if (n >= 10) return `1 in ${Math.ceil(n - 1e-6).toLocaleString("en-US")}`;
  return `1 in ${(Math.ceil(n * 10 - 1e-6) / 10).toFixed(1)}`;
}

/** N in "1 in N" for a probability in 1e9 units, to a thousandth; null for a zero probability. */
export const oneInOf = (p: bigint) => (p <= 0n ? null : Number(1_000_000_000_000n / p) / 1000);

/**
 * N in "1 in N" for a probability in 1e9 units, rounded so the chance it reads is never better
 * than `p`: up to the next whole from 10 on, up to the next tenth below. Null for a zero chance.
 */
export function honestOneInOf(p: bigint): number | null {
  if (p <= 0n) return null;
  const tenths = (1_000_000_000n * 10n + p - 1n) / p;
  if (tenths >= 100n) return Number((1_000_000_000n + p - 1n) / p);
  return Number(tenths) / 10;
}

/** "about 1 in 26" for a probability in 1e9 units, never better than the true chance. */
export function oneIn(p: bigint): string {
  const n = honestOneInOf(p);
  if (n === null) return "never";
  if ((oneInOf(p) ?? 0) < 1.05) return "almost always";
  return `about ${oneInWords(n)}`;
}

/** "1 in 1,926" and "0.052 %" for a probability in the program's 1e9 units. */
export function odds(p: bigint): { oneIn: string; pct: string } {
  return {
    oneIn: oneIn(p).replace(/^about /, ""),
    pct: chance(p, p < 10_000_000n ? 3 : 2),
  };
}

export const short = (a: string, n = 4) => `${a.slice(0, n)}…${a.slice(-n)}`;

export function duration(seconds: number): string {
  if (seconds <= 0) return "0 s";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m} min ${s.toString().padStart(2, "0")} s` : `${s} s`;
}

export function ago(unixSeconds: number | null): string {
  if (unixSeconds === null) return "";
  const d = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (d < 60) return `${d} s ago`;
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

/** "12.5" to 12 500 000 micro-USDC, exactly; null if it is not a plain decimal. */
export function parseUsdc(input: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(input.trim());
  if (!m) return null;
  return BigInt(m[1] ?? "0") * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

/** The vault share token's symbol. */
export const SHARE_SYMBOL = "fvUSDC";

/** Vault shares as "1,000.41 fvUSDC". */
export const fv = (v: bigint, digits = 2) => `${shares(v, digits)} ${SHARE_SYMBOL}`;

/** A countdown as "1:24" (or "1:02:05" past an hour). */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toString().padStart(2, "0");
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${r}` : `${m}:${r}`;
}
