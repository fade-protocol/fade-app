// The booster's cards: what a pack can hold, from the commonest to the rarest. They are the
// product a shop sells, and purely cosmetic: the card a pack opens on is picked in the browser,
// and has nothing to do with the draw that may make the pack free. Shared by the 3D scene and the
// 2D pack; imports nothing from three.js.

export type CardArt = {
  rarity: string;
  name: string;
  /** The rarity's colour: the card's frame, its emblem and its tag. */
  hex: string;
  /** Its number in the series, "01". */
  no: string;
  /** How often a pack holds it, out of 100. */
  weight: number;
  /** A 9 × 9 symmetric pixel emblem, row by row. */
  sprite: boolean[];
};

const ART: [string, string, string, number][] = [
  ["Legendary", "Fade Dragon", "#ffcf5a", 3],
  ["Epic", "Violet Comet", "#b98cff", 12],
  ["Rare", "Blue Tide", "#5eb8ff", 30],
  ["Common", "Pebble", "#8fa3b8", 55],
];
const FILL = [0.62, 0.55, 0.5, 0.42];

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sprite(i: number): boolean[] {
  const r = seeded(101 + i * 7);
  const on: boolean[] = [];
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 5; x++)
      on[y * 9 + x] = on[y * 9 + 8 - x] = r() < (FILL[i] ?? 0.3) * (1 - Math.abs(4 - y) / 9);
  return on;
}

export const CARDS: CardArt[] = ART.map(([rarity, name, hex, weight], i) => ({
  rarity,
  name,
  hex,
  no: String(i + 1).padStart(2, "0"),
  weight,
  sprite: sprite(i),
}));

/** The card a pack opens on, by its weight: the same for the same pack (`key`), every render. */
export function cardFor(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  const total = CARDS.reduce((n, c) => n + c.weight, 0);
  let x = seeded(h)() * total;
  for (let i = 0; i < CARDS.length; i++) {
    x -= CARDS[i]!.weight;
    if (x < 0) return i;
  }
  return CARDS.length - 1;
}

/**
 * The FADE mark (from its design file): its rectangles on a 169 × 247 grid,
 * p for paper, v for the violet offset.
 */
export const MARK: [number, number, number, number, "p" | "v"][] = [
  [13, 78, 117, 39, "v"],
  [13, 117, 39, 130, "v"],
  [52, 143, 65, 39, "v"],
  [0, 65, 117, 39, "p"],
  [0, 104, 39, 130, "p"],
  [39, 130, 65, 39, "p"],
  [117, 65, 13, 13, "p"],
  [130, 78, 13, 13, "v"],
  [156, 91, 13, 13, "p"],
  [130, 39, 13, 13, "p"],
  [104, 39, 13, 13, "p"],
  [156, 39, 13, 13, "p"],
  [130, 13, 13, 13, "p"],
  [156, 0, 13, 13, "p"],
  [91, 26, 13, 13, "p"],
  [130, 130, 13, 13, "v"],
  [117, 143, 13, 13, "p"],
  [143, 156, 13, 13, "p"],
];
