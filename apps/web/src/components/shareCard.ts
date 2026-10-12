// Draws a win's share card on a canvas, at full size, and hands it back as a PNG. The words come
// from lib/shareWin; this file only places them: the logo and the date on top, the sentence and the
// amount in the middle, the site and the QR code to the draw at the foot. Nothing on a PNG is
// clickable, so the proof is the QR code and the site is written plainly.
import { drawUrl } from "../lib/drawLink";
import { finderOrigins, inFinder, logoSpan, qrMatrix } from "../lib/qr";
import {
  CARD_SITE,
  FORMAT_SIZE,
  cardCopy,
  cardDate,
  balancedLines,
  fitFont,
  wrapWords,
  type ShareFormat,
  type ShareWin,
} from "../lib/shareWin";
import { LOGO_BLOCKS, PAPER as LOGO_PAPER, PIXELS } from "./Logo";

const BG = "#0c0a12";
const PAPER = "#f0eee8";
const MUTED = "#a7a2b6";
const DIM = "#8e89a0";
const MINT = "#3ddc97";
const VIOLET_TEXT = "#b3a3ff";
/**
 * The QR code is inverted, light on dark, so it sits in the card instead of on a pasted sticker:
 * its tile is a shade above the card, its modules a near white cream. A scanner reads dark from
 * light by brightness alone, so the pair is kept as far apart as the palette allows (a contrast
 * ratio of about 16:1), and the finder rings take the lilac, still some 8:1 against the tile.
 */
const QR_TILE = "#15121f";
const QR_LIGHT = "#f4f1ea";
const QR_FINDER = "#b3a3ff";

const DISPLAY = "Poppins, system-ui, sans-serif";
const TEXT = "Inter, system-ui, sans-serif";
const MONO = '"Roboto Mono", ui-monospace, Menlo, monospace';

/** Each format's frame: margins, the scale of every size, the QR module in pixels. */
type Frame = {
  padX: number;
  padY: number;
  k: number;
  qrModule: number;
  /** The headline's most lines before it shrinks. */
  headlineLines: number;
  /** The share of the inner width the detail line may take. */
  detailWidth: number;
};

const FRAMES: Record<ShareFormat, Frame> = {
  post: { padX: 64, padY: 56, k: 1, qrModule: 5, headlineLines: 1, detailWidth: 0.8 },
  square: { padX: 80, padY: 80, k: 1.2, qrModule: 5, headlineLines: 2, detailWidth: 1 },
  story: { padX: 96, padY: 128, k: 1.65, qrModule: 7, headlineLines: 3, detailWidth: 1 },
};

/** Every face the card uses, loaded before the first stroke so the canvas never falls back. */
const FACES = [
  `700 150px Poppins`,
  `600 24px Poppins`,
  `400 22px Inter`,
  `500 22px Inter`,
  `500 16px "Roboto Mono"`,
];

let fontsReady: Promise<unknown> | null = null;
function loadFonts(): Promise<unknown> {
  if (typeof document === "undefined" || !document.fonts) return Promise.resolve();
  fontsReady ??= Promise.all(FACES.map((f) => document.fonts.load(f).catch(() => null))).then(
    () => document.fonts.ready,
  );
  return fontsReady;
}

type Ctx = CanvasRenderingContext2D;

function setFont(ctx: Ctx, weight: number, size: number, family: string, spacingEm = 0) {
  ctx.font = `${weight} ${size}px ${family}`;
  // ignored where canvas letter spacing is not supported: the text is a little looser there
  ctx.letterSpacing = `${spacingEm * size}px`;
}

/** An elliptical glow, as the mockup's CSS radial gradients. */
function glow(
  ctx: Ctx,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: string,
  w: number,
  h: number,
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, color);
  g.addColorStop(0.6, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-cx, -cy * (rx / ry), w, h * (rx / ry));
  ctx.restore();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** The pixel F; `letter` recolours its paper parts (the QR code's cream, on its tile). */
function drawLogo(ctx: Ctx, x: number, y: number, size: number, letter = LOGO_PAPER) {
  const u = size / 32;
  const colour = (c: string) => (c === LOGO_PAPER ? letter : c);
  for (const [bx, by, bw, bh, c] of LOGO_BLOCKS) {
    ctx.fillStyle = colour(c);
    ctx.fillRect(x + bx * u, y + by * u, bw * u, bh * u);
  }
  for (const [px, py, c] of PIXELS) {
    ctx.fillStyle = colour(c);
    ctx.fillRect(x + px * u, y + py * u, 2 * u, 2 * u);
  }
}

/**
 * The QR code, inverted, on its dark tile with a quiet zone of four modules; returns the tile's
 * size. Each module the code calls dark is a cream square pixel with a thin gap of tile on its
 * right and bottom, in the logo's pixel style; the three finder patterns are solid lilac rings
 * around cream centres; and the pixel F sits on the cleared centre (level H error correction
 * restores what it covers). Inverted codes are an option of the QR standard that phone scanners
 * read, which is why the quiet zone is the full four modules the standard asks for. Every edge
 * falls on a whole pixel: a fractional one would blur the gaps into grey.
 */
function drawQr(
  ctx: Ctx,
  url: string,
  right: number,
  bottom: number,
  module: number,
  radius: number,
) {
  const m = qrMatrix(url, "H");
  const n = m.length;
  const u = module;
  const gap = u >= 4 ? 1 : 0;
  const quiet = 4 * u;
  const size = n * u + 2 * quiet;
  const x0 = Math.round(right - size);
  const y0 = Math.round(bottom - size);
  ctx.fillStyle = QR_TILE;
  roundRect(ctx, x0, y0, size, size, radius);
  ctx.fill();
  const ox = x0 + quiet;
  const oy = y0 + quiet;
  const logo = logoSpan(n);
  const underLogo = (i: number) => i >= logo.from && i < logo.from + logo.span;
  ctx.fillStyle = QR_LIGHT;
  m.forEach((row, r) =>
    row.forEach((on, c) => {
      if (!on || inFinder(r, c, n) || (underLogo(r) && underLogo(c))) return;
      ctx.fillRect(ox + c * u, oy + r * u, u - gap, u - gap);
    }),
  );
  for (const [r0, c0] of finderOrigins(n)) {
    const fx = ox + c0 * u;
    const fy = oy + r0 * u;
    // whole modules, no gap: a scanner finds the pattern by its 1:1:3:1:1 widths
    ctx.fillStyle = QR_FINDER;
    ctx.fillRect(fx, fy, 7 * u, 7 * u);
    ctx.fillStyle = QR_TILE;
    ctx.fillRect(fx + u, fy + u, 5 * u, 5 * u);
    ctx.fillStyle = QR_LIGHT;
    ctx.fillRect(fx + 2 * u, fy + 2 * u, 3 * u, 3 * u);
  }
  // the logo, cream with its violet offset, a module in from the cleared square's edges
  const inset = (logo.from + 1) * u;
  drawLogo(ctx, ox + inset, oy + inset, (logo.span - 2) * u, QR_LIGHT);
  return size;
}

/** One line of the middle block, already sized. */
type Piece = {
  lines: string[];
  weight: number;
  size: number;
  family: string;
  spacing: number;
  color: string;
  lineHeight: number;
  /** Space above, in pixels. */
  gap: number;
  /** A second run on the same line (the amount's unit), drawn after the first. */
  tail?: { text: string; weight: number; size: number; color: string };
};

const pieceHeight = (p: Piece) => p.lines.length * p.size * p.lineHeight;

/** Draws `win` in `format` on a new canvas, fonts loaded. */
export async function drawShareCard(
  win: ShareWin,
  format: ShareFormat,
): Promise<HTMLCanvasElement> {
  await loadFonts();
  const { w: W, h: H } = FORMAT_SIZE[format];
  const f = FRAMES[format];
  const k = f.k;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot draw the card.");
  const copy = cardCopy(win);
  const inner = W - 2 * f.padX;

  // the card: rounded, the violet glow top right, a faint green one bottom left
  const radius = 28 * k;
  roundRect(ctx, 0, 0, W, H, radius);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  const gs = W / 1200;
  glow(
    ctx,
    W * 0.85,
    H * 0.2,
    900 * gs * (format === "story" ? 1.2 : 1),
    500 * gs * (format === "post" ? 1 : 1.6),
    "rgba(124,92,255,0.35)",
    W,
    H,
  );
  glow(
    ctx,
    W * 0.1,
    H * 1.1,
    600 * gs,
    400 * gs * (format === "post" ? 1 : 1.6),
    "rgba(61,220,151,0.18)",
    W,
    H,
  );
  ctx.restore();
  roundRect(ctx, 1, 1, W - 2, H - 2, radius - 1);
  ctx.strokeStyle = "rgba(240,238,232,0.10)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // top: the logo and the word, the date
  const logo = (format === "story" ? 40 : 34) * k;
  const top = f.padY;
  drawLogo(ctx, f.padX - 4 * (logo / 32), top, logo);
  setFont(ctx, 700, (format === "story" ? 24 : 20) * k, DISPLAY, 0.14);
  ctx.fillStyle = PAPER;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText("FADE", f.padX + logo, top + logo * 0.56);
  setFont(ctx, 500, 15 * k, MONO, 0.04);
  ctx.fillStyle = DIM;
  ctx.textAlign = "right";
  ctx.fillText(cardDate(win.at), W - f.padX, top + logo * 0.56);

  // foot: the site, "Drawn on Solana. Scan to verify." and the QR code
  const bottom = H - f.padY;
  const qrSize = drawQr(ctx, drawUrl(win.ticket), W - f.padX, bottom, f.qrModule, 8 * k);
  setFont(ctx, 500, 15 * k, MONO, 0);
  ctx.textAlign = "right";
  ctx.fillStyle = DIM;
  const vx = W - f.padX - qrSize - 18 * k;

  const vy = bottom - qrSize / 2;
  const vlh = 15 * k * 1.5;
  ctx.fillText("Drawn on Solana.", vx, vy - vlh / 2);
  ctx.fillText("Scan to verify.", vx, vy + vlh / 2);
  setFont(ctx, 500, 17 * k, MONO, 0.01);
  ctx.textAlign = "left";
  ctx.fillStyle = PAPER;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(CARD_SITE, f.padX, bottom - 4 * k);

  // middle: the sentence, the amount, the line under it
  const measureAt =
    (weight: number, family: string, spacing: number, text: string) => (size: number) => {
      setFont(ctx, weight, size, family, spacing);
      return ctx.measureText(text).width;
    };
  const pieces: Piece[] = [];
  if (copy.lead) {
    pieces.push({
      lines: [copy.lead],
      weight: 400,
      size: fitFont(measureAt(400, TEXT, 0, copy.lead), inner, 32 * k, 18 * k),
      family: TEXT,
      spacing: 0,
      color: MUTED,
      lineHeight: 1.25,
      gap: 0,
    });
  }
  if (copy.bigWord) {
    pieces.push({
      lines: [copy.headline],
      weight: 700,
      size: fitFont(measureAt(700, DISPLAY, -0.033, copy.headline), inner, 156 * k, 60 * k),
      family: DISPLAY,
      spacing: -0.033,
      color: MINT,
      lineHeight: 1.0,
      gap: 4 * k,
    });
  } else {
    // the headline stays on one line while it shrinks a little, else breaks into balanced lines
    const measure = (t: string) => ctx.measureText(t).width;
    const start = 76 * k;
    let size = start;
    let lines: string[] | null = null;
    for (; size >= start * 0.8; size -= 2) {
      setFont(ctx, 700, size, DISPLAY, -0.03);
      if (measure(copy.headline) <= inner) {
        lines = [copy.headline];
        break;
      }
    }
    if (!lines)
      for (size = start; size > 36 * k; size -= 2) {
        setFont(ctx, 700, size, DISPLAY, -0.03);
        lines = balancedLines(copy.headline, f.headlineLines, inner, measure);
        if (lines) break;
      }
    lines ??= [copy.headline];
    pieces.push({
      lines,
      weight: 700,
      size,
      family: DISPLAY,
      spacing: -0.03,
      color: PAPER,
      lineHeight: 1.08,
      gap: 0,
    });
  }
  // the amount and its unit on one line, shrunk together when a large amount would overflow
  const amountColor = copy.bigWord ? PAPER : copy.accent === "violet" ? VIOLET_TEXT : MINT;
  const unitColor = copy.bigWord ? DIM : amountColor;
  const unitWeight = copy.bigWord ? 600 : 700;
  const unitRatio = copy.bigWord ? 24 / 46 : 1;
  const amountSize = fitFont(
    (s) => {
      setFont(ctx, 700, s, DISPLAY, -0.01);
      const a = ctx.measureText(`${copy.amount} `).width;
      setFont(ctx, unitWeight, s * unitRatio, DISPLAY, 0);
      return a + ctx.measureText(copy.unit).width;
    },
    inner,
    46 * k,
    22 * k,
  );
  pieces.push({
    lines: [`${copy.amount} `],
    weight: 700,
    size: amountSize,
    family: DISPLAY,
    spacing: -0.01,
    color: amountColor,
    lineHeight: 1.2,
    gap: (copy.bigWord ? 20 : 12) * k,
    tail: { text: copy.unit, weight: unitWeight, size: amountSize * unitRatio, color: unitColor },
  });
  setFont(ctx, 400, 23 * k, TEXT, 0);
  pieces.push({
    lines: wrapWords(copy.detail, inner * f.detailWidth, (s) => ctx.measureText(s).width),
    weight: 400,
    size: 23 * k,
    family: TEXT,
    spacing: 0,
    color: MUTED,
    lineHeight: 1.4,
    gap: 14 * k,
  });

  // where each line goes, relative to the block's top, and how far right it reaches
  type Placed = { p: Piece; line: string; top: number; lh: number; right: number };
  const placed: Placed[] = [];
  let at = 0;
  for (const p of pieces) {
    at += p.gap;
    for (const line of p.lines) {
      const lh = p.size * p.lineHeight;
      setFont(ctx, p.weight, p.size, p.family, p.spacing);
      let right = f.padX + ctx.measureText(line).width;
      if (p.tail) {
        setFont(ctx, p.tail.weight, p.tail.size, DISPLAY, 0);
        right += ctx.measureText(p.tail.text).width;
      }
      placed.push({ p, line, top: at, lh, right });
      at += lh;
    }
  }
  const blockH = at;
  // centred between the top row and the foot (a little high on a story, where the eye lands),
  // then raised if a line would run into the QR code and its caption
  const regionTop = top + logo + 24 * k;
  const footTop = bottom - qrSize - 20 * k;
  setFont(ctx, 500, 15 * k, MONO, 0);
  const footLeft = vx - ctx.measureText("Drawn on Solana.").width - 28 * k;
  const lift = format === "post" ? 0.5 : 0.42;
  let y0 = regionTop + Math.max(0, (bottom - 40 * k - regionTop - blockH) * lift);
  for (const l of placed)
    if (l.right > footLeft && y0 + l.top + l.lh > footTop) y0 = footTop - l.top - l.lh;
  y0 = Math.max(regionTop, y0);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const { p, line, top: lt, lh } of placed) {
    setFont(ctx, p.weight, p.size, p.family, p.spacing);
    // the font's own box, centred in the line: the amount and its unit then share a baseline
    const m = ctx.measureText(line);
    const asc = m.fontBoundingBoxAscent ?? p.size * 0.9;
    const desc = m.fontBoundingBoxDescent ?? p.size * 0.25;
    const base = y0 + lt + (lh - (asc + desc)) / 2 + asc;
    ctx.fillStyle = p.color;
    ctx.fillText(line, f.padX, base);
    if (p.tail) {
      const x = f.padX + m.width;
      setFont(ctx, p.tail.weight, p.tail.size, DISPLAY, 0);
      ctx.fillStyle = p.tail.color;
      ctx.fillText(p.tail.text, x, base);
    }
  }
  ctx.letterSpacing = "0px";
  return canvas;
}

/** The canvas as a PNG. */
export function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("The image could not be made."))),
      "image/png",
    ),
  );
}
