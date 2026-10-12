// A QR code as a grid of dark modules, for the share card: the card is a picture, so the draw it
// points at is reached by scanning. The card draws the code in the pixel style of the logo, with
// the logo over its centre, so it asks for the highest error correction: H restores up to 30% of
// the code, far more than the logo covers, and still survives a recompressed screenshot.
import qrcode from "qrcode-generator";

export type QrLevel = "L" | "M" | "Q" | "H";

/** The modules of `text`'s QR code, row by row: true for a dark one. No quiet zone. */
export function qrMatrix(text: string, level: QrLevel = "H"): boolean[][] {
  const qr = qrcode(0, level);
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** The three finder patterns' top-left corners: 7 by 7 modules each, at three corners. */
export function finderOrigins(n: number): [number, number][] {
  return [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ];
}

/** The module is part of a finder pattern (its 7 by 7 square, not the light separator). */
export function inFinder(r: number, c: number, n: number): boolean {
  return finderOrigins(n).some(([r0, c0]) => r >= r0 && r < r0 + 7 && c >= c0 && c < c0 + 7);
}

/**
 * The centre square the logo covers, in modules: an odd span, so it sits on the middle module,
 * about a fifth of the side (some 5% of the code's area, well inside what level H restores).
 */
export function logoSpan(n: number): { from: number; span: number } {
  let span = Math.round(n * 0.22);
  if (span % 2 === 0) span -= 1;
  return { from: (n - span) / 2, span };
}
