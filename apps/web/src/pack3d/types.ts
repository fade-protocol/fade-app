// The contract between the Booster demo's React side and the pack's 3D engine. Imports nothing
// from three.js.

export type PackView = {
  /** One per purchase: a new key starts a new pack. */
  key: string;
  /** rest: before a purchase; wait: the wallet or the network; drawing: the oracle; result: the draw is in. */
  phase: "rest" | "wait" | "drawing" | "result";
  /** The card the pack opens on (an index in CARDS), once the draw is in. Cosmetic. */
  card: number | null;
  /** "5.00": the pack's price, printed on it. */
  price: string;
  /** When the result arrived (performance.now()): the reveal plays from there. */
  resultAt: number | null;
};

export type PackOptions = {
  /** A WebGL2 context already taken on the canvas: the only one this scene creates. */
  context: WebGL2RenderingContext;
  glb: ArrayBuffer;
  mobile: boolean;
  view: PackView;
};

export type PackScene = {
  /** Hands the engine the game's current state; cheap and idempotent. */
  sync(view: PackView): void;
  resize(): void;
  /** Pointer position over the stage, -1..1 (null when it leaves). */
  pointer(x: number | null, y?: number): void;
  pause(): void;
  resume(): void;
  /** Renders continuously for `ms` and returns the median frame time. */
  probe(ms: number): Promise<number>;
  /** After a WebGL context restore: rebuilds what lived only on the GPU. */
  restored(): void;
  dispose(): void;
};

/** How long the reveal lasts: the fan folds, the seal tears, the card rises and turns over. */
export const REVEAL_MS = 2300;
