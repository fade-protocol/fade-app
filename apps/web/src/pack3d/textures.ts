// The booster's print, drawn on canvases: the pouch (front, back and a normal map for its crimped
// seals) and the cards (their back and one face per card). In Fade's colours, after ONE Arena's
// packs: engraved rays, a medallion with the FADE mark, BOOSTER in gold, gold lines on the seals.
import * as THREE from "three";
import { CARDS, MARK, type CardArt } from "./tiers";

/** As in the Blender model of the pouch: the body between the seals has a card's proportions. */
export const W = 0.86;
export const SEAL_TOP = 0.12;
export const SEAL_BOT = 0.09;
export const H = 1.404;
export const CARD_W = 0.7;
export const CARD_H = 0.99;

const PX = 1024;
const PY = Math.round((PX * H) / W);
const WEIGHTS = CARDS.reduce((n, c) => n + c.weight, 0);

/** glTF meshes sample textures unflipped; the card planes are three's own, flipped as usual. */
function texture(c: HTMLCanvasElement, srgb: boolean, flipY: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.flipY = flipY;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function drawMark(g: CanvasRenderingContext2D, cx: number, cy: number, height: number) {
  const k = height / 247;
  const x0 = cx - (169 * k) / 2;
  const y0 = cy - height / 2;
  for (const [x, y, w, h, c] of MARK) {
    g.fillStyle = c === "p" ? "#f0eee8" : "#7c5cff";
    g.fillRect(x0 + x * k, y0 + y * k, w * k + 0.5, h * k + 0.5);
  }
}

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const q = i % 2 ? r * 0.28 : r;
    g.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q);
  }
  g.closePath();
  g.fill();
}

const sealBand = () => {
  const top = (PY * SEAL_TOP) / H;
  const bot = PY - (PY * SEAL_BOT) / H;
  return { top, bot };
};

/** The pouch's print: the front with the medallion and the price, or the back with what it holds. */
export function packPrint(price: string, front: boolean): THREE.CanvasTexture {
  const [c, g] = canvas(PX, PY);
  const w = PX;
  const h = PY;
  const { top, bot } = sealBand();
  const cx = w / 2;
  const cy = top + (bot - top) * 0.4;
  const bg = g.createRadialGradient(cx, cy, 20, cx, cy, h * 0.75);
  bg.addColorStop(0, front ? "#9a80ff" : "#5b3ee6");
  bg.addColorStop(0.35, "#5b3ee6");
  bg.addColorStop(0.75, "#2b1a6b");
  bg.addColorStop(1, "#140c33");
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);

  if (front) {
    // engraved rays and rings around the medallion
    g.save();
    g.translate(cx, cy);
    for (let i = 0; i < 96; i++) {
      g.rotate((Math.PI * 2) / 96);
      g.fillStyle = i % 2 ? "rgba(255,255,255,.05)" : "rgba(10,4,40,.10)";
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(-18, -h);
      g.lineTo(18, -h);
      g.fill();
    }
    for (let r = 230; r < h; r += 44) {
      g.strokeStyle = `rgba(240,238,232,${0.06 * Math.max(0, 1 - (r / h) * 1.2)})`;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.restore();

    // the medallion and the FADE mark
    const R = 170;
    const halo = g.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.8);
    halo.addColorStop(0, "rgba(196,182,255,.45)");
    halo.addColorStop(1, "rgba(196,182,255,0)");
    g.fillStyle = halo;
    g.beginPath();
    g.arc(cx, cy, R * 1.8, 0, Math.PI * 2);
    g.fill();
    const disc = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    disc.addColorStop(0, "#2b1a6b");
    disc.addColorStop(1, "#0c0a12");
    g.fillStyle = disc;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fill();
    const rim = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    rim.addColorStop(0, "#ffffff");
    rim.addColorStop(0.5, "#c4b6ff");
    rim.addColorStop(1, "#f0eee8");
    g.strokeStyle = rim;
    g.lineWidth = 16;
    g.beginPath();
    g.arc(cx, cy, R - 8, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 3;
    g.beginPath();
    g.arc(cx, cy, R - 30, 0, Math.PI * 2);
    g.stroke();
    drawMark(g, cx + 6, cy + 4, 190);

    // type
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    g.fillStyle = "#f0eee8";
    g.font = "700 64px Poppins, sans-serif";
    g.letterSpacing = "18px";
    g.fillText("FADE", cx + 9, top + 130);
    g.letterSpacing = "0px";
    const gold = g.createLinearGradient(0, cy + R + 40, 0, cy + R + 240);
    gold.addColorStop(0, "#fff1c4");
    gold.addColorStop(0.5, "#ffcf5a");
    gold.addColorStop(1, "#c98f2a");
    g.fillStyle = gold;
    g.font = "800 150px Poppins, sans-serif";
    g.shadowColor = "rgba(12,10,18,.55)";
    g.shadowOffsetY = 6;
    g.shadowBlur = 10;
    g.fillText("BOOSTER", cx, cy + R + 175);
    g.shadowColor = "transparent";
    g.fillStyle = "#c4b6ff";
    g.font = "500 38px 'Roboto Mono', monospace";
    g.letterSpacing = "10px";
    g.fillText("SERIES 01 · 1 CARD", cx + 5, cy + R + 245);
    g.letterSpacing = "0px";

    // the price plate
    const pw = 360;
    const ph = 92;
    const py = bot - 210;
    g.fillStyle = "rgba(12,10,18,.6)";
    roundRect(g, cx - pw / 2, py, pw, ph, 46);
    g.fill();
    g.strokeStyle = "#ffcf5a";
    g.lineWidth = 4;
    roundRect(g, cx - pw / 2, py, pw, ph, 46);
    g.stroke();
    g.fillStyle = "#f0eee8";
    g.font = "700 54px 'Roboto Mono', monospace";
    g.fillText(`${price} USDC`, cx, py + 66);

    // the rarities: each colour's width is how often a pack holds it
    let x = 140;
    const bw = w - 280;
    for (const c of CARDS) {
      g.fillStyle = c.hex;
      g.fillRect(x, bot - 78, (bw * c.weight) / WEIGHTS, 12);
      x += (bw * c.weight) / WEIGHTS;
    }
  } else {
    g.textAlign = "center";
    g.fillStyle = "rgba(240,238,232,.35)";
    g.font = "500 30px 'Roboto Mono', monospace";
    const lines = [
      "FADE · BOOSTER PACK · SERIES 01",
      "ONE CARD PER PACK",
      "LEGENDARY · EPIC · RARE · COMMON",
      "",
      "ADD A TICKET AT CHECKOUT",
      "AND THIS PACK MIGHT BE FREE",
    ];
    lines.forEach((l, i) => g.fillText(l, w / 2, top + 260 + i * 62));
  }

  // crimped seals in the pouch's own foil, and the gold lines that edge them
  for (const [y0, y1, edge] of [
    [0, top, top],
    [bot, h, bot],
  ] as const) {
    const m = g.createLinearGradient(0, y0, 0, y1);
    m.addColorStop(0, "#3a239e");
    m.addColorStop(0.45, "#7a60ff");
    m.addColorStop(1, "#33208f");
    g.fillStyle = m;
    g.fillRect(0, y0, w, y1 - y0);
    for (let x2 = 0; x2 < w; x2 += 8) {
      g.fillStyle = "rgba(255,255,255,.10)";
      g.fillRect(x2, y0, 2, y1 - y0);
      g.fillStyle = "rgba(10,4,40,.22)";
      g.fillRect(x2 + 4, y0, 2, y1 - y0);
    }
    g.fillStyle = "rgba(10,4,40,.28)";
    for (const f of [0.38, 0.62]) g.fillRect(0, y0 + (y1 - y0) * f, w, 3);
    const gl = g.createLinearGradient(0, 0, w, 0);
    gl.addColorStop(0, "#c98f2a");
    gl.addColorStop(0.5, "#fff1c4");
    gl.addColorStop(1, "#c98f2a");
    g.fillStyle = gl;
    g.fillRect(0, edge - 2, w, 4);
  }
  if (front) {
    // a fine gold frame inside the body, with small stars
    const fx = 34;
    const fy0 = top + 26;
    const fy1 = bot - 26;
    g.strokeStyle = "rgba(255,207,90,.75)";
    g.lineWidth = 3;
    g.strokeRect(fx, fy0, w - 2 * fx, fy1 - fy0);
    g.fillStyle = "#ffe08a";
    const stars: [number, number, number][] = [
      [fx, fy0, 14],
      [w - fx, fy0, 14],
      [fx, fy1, 14],
      [w - fx, fy1, 14],
      [w / 2, fy0, 18],
      [w / 2, fy1, 18],
      [w * 0.2, top + 120, 9],
      [w * 0.82, top + 300, 7],
    ];
    for (const [x2, y2, r] of stars) star(g, x2, y2, r);
  }
  return texture(c, true, false);
}

/** The crimp ridges and grooves of the seals, their embossed junction, corner creases and the medallion's rim. */
export function packNormals(): THREE.CanvasTexture {
  const [c, g] = canvas(PX, PY);
  const w = PX;
  const { top, bot } = sealBand();
  const tilt = (nx: number, ny: number, a = 1) => {
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    g.fillStyle = `rgba(${Math.round(128 + 127 * nx)},${Math.round(128 - 127 * ny)},${Math.round(255 * nz)},${a})`;
  };
  g.fillStyle = "rgb(128,128,255)";
  g.fillRect(0, 0, w, PY);
  for (const [y0, y1] of [
    [0, top],
    [bot, PY],
  ] as const) {
    for (let x = 0; x < w; x++) {
      tilt(0.75 * Math.sin((x / 8) * Math.PI * 2), 0);
      g.fillRect(x, y0, 1, y1 - y0);
    }
    for (const f of [0.38, 0.62]) {
      const y = y0 + (y1 - y0) * f;
      tilt(0, 0.7);
      g.fillRect(0, y - 3, w, 3);
      tilt(0, -0.7);
      g.fillRect(0, y, w, 3);
    }
  }
  for (const [y, s] of [
    [top, 1],
    [bot, -1],
  ] as const) {
    for (let d = 0; d < 14; d++) {
      tilt(0, s * 0.6 * (1 - d / 14));
      g.fillRect(0, y + s * d, w, 1);
    }
  }
  // creases fanning out of the body's corners, where the pouch pinches in
  for (const [x0, y0, dx, dy] of [
    [0, top, 1, 1],
    [w, top, -1, 1],
    [0, bot, 1, -1],
    [w, bot, -1, -1],
  ] as const) {
    for (let i = 0; i < 5; i++) {
      const len = 70 + i * 26;
      const ang = Math.atan2(dy * (0.6 + i * 0.35), dx);
      const nx = -Math.sin(ang) * 0.55;
      const ny = Math.cos(ang) * 0.55;
      g.save();
      g.translate(x0 + dx * (6 + i * 9), y0 + dy * 4);
      g.rotate(ang);
      tilt(nx, ny, 0.8);
      g.fillRect(0, -1.5, len, 3);
      tilt(-nx, -ny, 0.8);
      g.fillRect(0, 1.5, len * 0.9, 3);
      g.restore();
    }
  }
  // the medallion's raised rim
  const cx = w / 2;
  const cy = top + (bot - top) * 0.4;
  const R = 170;
  for (let a = 0; a < 360; a++) {
    const rad = (a * Math.PI) / 180;
    const nx = Math.cos(rad);
    const ny = Math.sin(rad);
    for (const [r, s] of [
      [R - 18, 1],
      [R + 2, -1],
    ] as const) {
      tilt(0.7 * nx * s, 0.7 * ny * s);
      g.fillRect(cx + r * nx - 4, cy + r * ny - 4, 8, 8);
    }
  }
  return texture(c, false, false);
}

const CW = 512;
const CH = 724;

export function cardBack(): THREE.CanvasTexture {
  const [c, g] = canvas(CW, CH);
  roundRect(g, 0, 0, CW, CH, 34);
  g.save();
  g.clip();
  const bg = g.createRadialGradient(CW / 2, CH / 2, 10, CW / 2, CH / 2, CH * 0.7);
  bg.addColorStop(0, "#5b3ee6");
  bg.addColorStop(1, "#140c33");
  g.fillStyle = bg;
  g.fillRect(0, 0, CW, CH);
  g.translate(CW / 2, CH / 2);
  for (let i = 0; i < 48; i++) {
    g.rotate(Math.PI / 24);
    g.fillStyle = i % 2 ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.08)";
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(-30, -CH);
    g.lineTo(30, -CH);
    g.fill();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "rgba(12,10,18,.55)";
  g.beginPath();
  g.arc(CW / 2, CH / 2, 130, 0, Math.PI * 2);
  g.fill();
  drawMark(g, CW / 2 + 4, CH / 2 + 2, 170);
  g.restore();
  g.strokeStyle = "#e3dcff";
  g.lineWidth = 12;
  roundRect(g, 6, 6, CW - 12, CH - 12, 30);
  g.stroke();
  return texture(c, true, true);
}

/** A card's face: its rarity, number, emblem, name and series tag. */
export function cardFace(art: CardArt): THREE.CanvasTexture {
  const [c, g] = canvas(CW, CH);
  const col = art.hex;
  roundRect(g, 0, 0, CW, CH, 34);
  g.save();
  g.clip();
  g.fillStyle = "#120f19";
  g.fillRect(0, 0, CW, CH);
  const rg = g.createRadialGradient(CW / 2, 290, 10, CW / 2, 290, 320);
  rg.addColorStop(0, `${col}66`);
  rg.addColorStop(1, "#120f1900");
  g.fillStyle = rg;
  g.fillRect(0, 0, CW, CH);
  g.fillStyle = col;
  g.font = "700 26px 'Roboto Mono', monospace";
  g.textBaseline = "top";
  g.fillText(art.rarity.toUpperCase(), 40, 36);
  g.textAlign = "right";
  g.fillText(`NO. ${art.no}`, CW - 40, 36);
  g.textAlign = "left";
  g.fillStyle = "#0a0810";
  roundRect(g, 34, 86, CW - 68, 400, 18);
  g.fill();
  const cell = 34;
  const ox = (CW - 9 * cell) / 2;
  const oy = 86 + (400 - 9 * cell) / 2;
  art.sprite.forEach((on, i) => {
    if (!on) return;
    g.fillStyle = col;
    g.fillRect(ox + (i % 9) * cell + 2, oy + Math.floor(i / 9) * cell + 2, cell - 4, cell - 4);
  });
  g.textAlign = "center";
  g.fillStyle = "#f0eee8";
  g.font = "700 40px Poppins, sans-serif";
  g.fillText(art.name, CW / 2, 512);
  // the series tag
  const tag = "SERIES 01";
  g.font = "700 40px 'Roboto Mono', monospace";
  const tw = g.measureText(tag).width + 56;
  g.fillStyle = col;
  roundRect(g, CW / 2 - tw / 2, 580, tw, 66, 33);
  g.fill();
  g.fillStyle = "#0c0a12";
  g.fillText(tag, CW / 2, 592);
  g.restore();
  g.strokeStyle = col;
  g.lineWidth = 12;
  roundRect(g, 6, 6, CW - 12, CH - 12, 30);
  g.stroke();
  return texture(c, true, true);
}
