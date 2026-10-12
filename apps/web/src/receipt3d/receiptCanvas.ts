// The receipt's face: a canvas redrawn whenever a character prints, uploaded as
// the paper's texture. Receipt space runs in world units from the paper's tip
// (y = 0, the first line out of the printer) down towards the print head.
import * as THREE from "three";

export const PAPER_W = 1.0;
/** Texture pixels per world unit. */
export const PPU = 720;
/** The longest receipt the texture holds, in world units. */
export const MAX_LEN = 1.5;
const TEX_W = Math.round(PAPER_W * PPU);
const TEX_H = Math.round(MAX_LEN * PPU);
const PAD = Math.round(0.075 * PPU);
/** The pixel-edge square, in texture px. */
const SQ = 24;

export const COLORS = {
  paper: "#f0eee8",
  ink: "#17141f",
  inkDim: "#77728a",
  rule: "#b3aec0",
  violet: "#7c5cff",
  violetInk: "#5b3ee6",
  dark: "#1d1828",
};

/** The torn band at the tip. */
export const EDGE = (SQ * 4) / PPU;

const MONO = (weight: number, px: number) =>
  `${weight} ${px}px "Roboto Mono", ui-monospace, monospace`;

export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let grainCanvas: HTMLCanvasElement | null = null;
function grain(): HTMLCanvasElement {
  if (grainCanvas) return grainCanvas;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const img = g.createImageData(128, 128);
  const rnd = seeded(3);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 150 + rnd() * 105;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  grainCanvas = c;
  return c;
}

/** The violet rubber stamp, eroded like real ink. Shared by the 3D slam and the bake. */
export function makeStampCanvas(text: string, seed = 11): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 560;
  c.height = 220;
  const g = c.getContext("2d")!;
  const rnd = seeded(seed);
  g.strokeStyle = g.fillStyle = COLORS.violetInk;
  g.lineWidth = 14;
  g.beginPath();
  g.roundRect(14, 14, c.width - 28, c.height - 28, 26);
  g.stroke();
  // a longer word ("HALF BACK") sets smaller, to fit inside the frame
  let size = 132;
  g.letterSpacing = "14px";
  g.font = `700 ${size}px Poppins, sans-serif`;
  while (size > 40 && g.measureText(text).width > c.width - 80) {
    size -= 4;
    g.font = `700 ${size}px Poppins, sans-serif`;
  }
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, c.width / 2 + 7, c.height / 2 + 10);
  // ink roughness: specks, scuffs and a lighter pressure band
  g.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 1400; i++) {
    g.globalAlpha = 0.35 + rnd() * 0.65;
    const r = 0.6 + rnd() * rnd() * 3.2;
    g.beginPath();
    g.arc(rnd() * c.width, rnd() * c.height, r, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 9; i++) {
    g.globalAlpha = 0.25 + rnd() * 0.3;
    g.lineWidth = 1 + rnd() * 2.5;
    g.beginPath();
    const y = rnd() * c.height;
    g.moveTo(rnd() * c.width * 0.3, y);
    g.lineTo(c.width * (0.5 + rnd() * 0.5), y + (rnd() - 0.5) * 24);
    g.stroke();
  }
  const band = g.createLinearGradient(0, 0, c.width, c.height);
  band.addColorStop(0, "rgba(0,0,0,0)");
  band.addColorStop(0.7, "rgba(0,0,0,0)");
  band.addColorStop(1, "rgba(0,0,0,0.35)");
  g.globalAlpha = 1;
  g.fillStyle = band;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

export const STAMP = { w: 0.44, rot: 0.14 };

export type Seg = { t: string; c?: string };
export type RowKind = "edge" | "space" | "title" | "note" | "item" | "rule" | "total";
export type Row = {
  id: string;
  kind: RowKind;
  /** Height in world units. */
  h: number;
  segs?: Seg[];
  value?: string;
  /** Characters typed so far (label, then value). */
  n: number;
  accent?: boolean;
  bold?: boolean;
  valueColor?: string;
  /** Laid out by `layout()`. */
  y: number;
};
export type RowInit = Omit<Row, "n" | "y"> & { n?: number };

/** Typed in full. */
export const ALL = 1e9;

export class ReceiptCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  rows: Row[] = [];
  active: Row | null = null;
  /** Baked into the paper once the slam lands. */
  stamp: { canvas: HTMLCanvasElement; cx: number; cy: number } | null = null;
  tearY: number | null = null;
  length = 0;
  dirty = true;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pattern: CanvasPattern | null;

  constructor(private readonly seed = 7) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = TEX_W;
    this.canvas.height = TEX_H;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.pattern = this.ctx.createPattern(grain(), "repeat");
  }

  setRows(rows: RowInit[]): void {
    this.rows = rows.map((r) => ({ n: 0, ...r, y: 0 }));
    this.layout();
  }

  layout(): void {
    let y = 0;
    for (const r of this.rows) {
      r.y = y;
      y += r.h;
    }
    this.length = y;
    this.dirty = true;
  }

  row(id: string): Row | undefined {
    return this.rows.find((r) => r.id === id);
  }

  insertAfter(id: string, row: RowInit): Row {
    const i = this.rows.findIndex((r) => r.id === id);
    const r: Row = { n: 0, ...row, y: 0 };
    this.rows.splice(i + 1, 0, r);
    this.layout();
    return r;
  }

  static labelLen(row: Row): number {
    return (row.segs ?? []).reduce((n, s) => n + s.t.length, 0);
  }

  static len(row: Row): number {
    if (row.kind === "rule") return 26;
    if (row.kind === "space" || row.kind === "edge") return 0;
    return ReceiptCanvas.labelLen(row) + (row.value?.length ?? 0);
  }

  draw(): void {
    const g = this.ctx;
    const rnd = seeded(this.seed);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.clearRect(0, 0, TEX_W, TEX_H);
    const edgePx = Math.round(EDGE * PPU);

    g.fillStyle = COLORS.paper;
    g.fillRect(0, edgePx, TEX_W, TEX_H - edgePx);
    if (this.pattern) {
      g.save();
      g.globalCompositeOperation = "multiply";
      g.globalAlpha = 0.09;
      g.fillStyle = this.pattern;
      g.fillRect(0, edgePx, TEX_W, TEX_H - edgePx);
      g.restore();
    }

    // the torn tip dissolves into brand pixels
    const odds = [0.3, 0.5, 0.72, 0.9];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < TEX_W / SQ; c++) {
        const here = rnd() < odds[r]!;
        const tone = rnd();
        if (!here) continue;
        g.fillStyle = tone < 0.58 ? COLORS.paper : tone < 0.9 ? COLORS.violet : COLORS.dark;
        g.fillRect(c * SQ, r * SQ, SQ, SQ);
      }
    }

    for (const row of this.rows) this.drawRow(g, row);

    if (this.stamp) {
      const s = this.stamp;
      const w = STAMP.w * PPU;
      const h = (w * s.canvas.height) / s.canvas.width;
      g.save();
      g.globalCompositeOperation = "multiply";
      g.globalAlpha = 0.92;
      g.translate(s.cx * PPU, s.cy * PPU);
      g.rotate(-STAMP.rot);
      g.drawImage(s.canvas, -w / 2, -h / 2, w, h);
      g.restore();
    }

    if (this.tearY !== null) {
      // the bottom edge of a strip torn off: pixels, then nothing
      const top = Math.round(this.tearY * PPU) - SQ * 3;
      g.clearRect(0, top, TEX_W, TEX_H - top);
      const r2 = seeded(this.seed * 31 + 5);
      const keep = [0.9, 0.6, 0.3];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < TEX_W / SQ; c++) {
          const here = r2() < keep[r]!;
          const tone = r2();
          if (!here) continue;
          g.fillStyle = tone < 0.6 ? COLORS.paper : tone < 0.9 ? COLORS.violet : COLORS.dark;
          g.fillRect(c * SQ, top + r * SQ, SQ, SQ);
        }
      }
    }

    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  private drawRow(g: CanvasRenderingContext2D, row: Row): void {
    const y0 = row.y * PPU;
    const h = row.h * PPU;
    if (row.kind === "space" || row.kind === "edge" || h < 1) return;
    g.save();
    g.beginPath();
    g.rect(0, y0, TEX_W, h);
    g.clip();
    g.textBaseline = "alphabetic";
    g.letterSpacing = "0px";

    if (row.kind === "rule") {
      const p = Math.min(1, row.n / 26);
      if (p > 0) {
        g.strokeStyle = COLORS.rule;
        g.lineWidth = 3;
        g.setLineDash([12, 9]);
        g.beginPath();
        const y = Math.round(y0 + h / 2) + 0.5;
        g.moveTo(PAD, y);
        g.lineTo(PAD + p * (TEX_W - 2 * PAD), y);
        g.stroke();
      }
      g.restore();
      return;
    }

    const centred = row.kind === "title" || row.kind === "note";
    const base = y0 + h * (centred ? 0.62 : 0.66);
    let left = row.n;
    let caretX: number | null = null;

    if (centred) {
      // the order number on top, the sign-off at the bottom: centred, letter-spaced
      const title = row.kind === "title";
      const px = title ? 34 : 26;
      const spacing = title ? 12 : 6;
      g.font = MONO(500, px);
      g.letterSpacing = `${spacing}px`;
      g.fillStyle = COLORS.inkDim;
      const text = (row.segs ?? []).map((s) => s.t).join("");
      const w = g.measureText(text).width - spacing;
      const x = (TEX_W - w) / 2;
      const typed = text.slice(0, Math.max(0, left));
      g.fillText(typed, x, base);
      if (left < text.length) caretX = x + g.measureText(typed).width;
    } else {
      const total = row.kind === "total";
      const strong = total || row.accent === true || row.bold === true;
      g.font = MONO(total ? 700 : 500, total ? 46 : 38);
      let x = PAD;
      for (const s of row.segs ?? []) {
        const k = Math.max(0, Math.min(s.t.length, left));
        left -= s.t.length;
        g.fillStyle = s.c ?? (row.accent ? COLORS.violetInk : COLORS.ink);
        const typed = s.t.slice(0, k);
        g.fillText(typed, x, base);
        if (k < s.t.length && caretX === null) caretX = x + g.measureText(typed).width;
        x += g.measureText(s.t).width;
      }
      if (row.value) {
        const value = row.value;
        let px = total ? 46 : 38;
        const room = TEX_W - PAD - x - 18;
        g.font = MONO(strong ? 700 : 500, px);
        while (g.measureText(value).width > room && px > 16) {
          px -= 1;
          g.font = MONO(strong ? 700 : 500, px);
        }
        const vx = TEX_W - PAD - g.measureText(value).width;
        const k = Math.max(0, Math.min(value.length, left));
        g.fillStyle = row.valueColor ?? (row.accent || total ? COLORS.violetInk : COLORS.ink);
        const typed = value.slice(0, k);
        g.fillText(typed, vx, base);
        if (k < value.length && k > 0 && caretX === null) caretX = vx + g.measureText(typed).width;
      }
    }

    if (caretX !== null && this.active === row) {
      // the print head's hot spot
      g.fillStyle = COLORS.violet;
      g.globalAlpha = 0.85;
      g.fillRect(caretX + 2, base - 28, 16, 33);
    }
    g.restore();
  }

  dispose(): void {
    this.texture.dispose();
    this.canvas.width = this.canvas.height = 0;
  }
}
