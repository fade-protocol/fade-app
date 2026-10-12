// The contract between the React wrapper (main bundle) and the 3D engine (its
// own chunk, loaded on demand). Type-only: importing it pulls no three.js.
import type { Draw, Signal } from "../components/Receipt";

/** What the paper prints, already formatted by the app: the engine hardcodes no amount. */
export type PrinterData = {
  title: string;
  lines: { label: string; value: string }[];
  subtotalLabel: string;
  subtotal: string;
  drawLabel: string;
  /** The ticket, printed after the draw's label. */
  drawPrice: string | null;
  pending: string;
  totalLabel: string;
  /** Micro-USDC, as decimal strings: the total before a win and what a win rolls it down to. */
  totalFrom: string;
  totalTo: string;
  wonBackLabel: string;
  /** "−185.90" */
  wonBack: string;
  thanks: string;
  stamp: string;
  /** Printed under the receipt once a win is in. */
  footer: string | null;
};

export type PrinterView = {
  /** "idle" at rest; one value per payout. */
  key: string;
  /**
   * At rest, the head (the title and the order's lines) is printed and a payout prints the rest
   * under it; otherwise a blank stub waits in the slot.
   */
  headAtRest: boolean;
  draw: Draw;
  /** At rest, the light while the open waits: for the signature, then for the network. */
  signal: Signal;
  /** What the draw line prints for an ending ("" while there is none). */
  resultText: string;
  data: PrinterData;
  /** performance.now() when this key began: the timeline's zero. */
  startedAt: number;
  /** performance.now() when the current ending came in. */
  resultAt: number | null;
};

/** Where the printer should sit inside the canvas, in CSS px. */
export type Stage = { x: number; y: number; w: number; h: number };

export type PrinterOptions = {
  /** A WebGL2 context already taken on `canvas`: the only one the page creates. */
  context: WebGL2RenderingContext;
  glb: ArrayBuffer;
  mobile: boolean;
  /** Micro-USDC to "1,234.56": the app's own formatter, for the rolling total. */
  format: (micro: bigint) => string;
  view: PrinterView;
  stage: Stage;
};

export type PrinterScene = {
  /** Hands the engine the demo's current state; cheap and idempotent. */
  sync(view: PrinterView): void;
  setStage(stage: Stage): void;
  resize(): void;
  /** Pointer position over the visual column, -1..1 (null when it leaves). */
  pointer(x: number | null, y?: number): void;
  pause(): void;
  resume(): void;
  /** Renders continuously for `ms` and returns the median frame time. */
  probe(ms: number): Promise<number>;
  /** After a WebGL context restore: rebuilds what lived only on the GPU. */
  restored(): void;
  dispose(): void;
};
