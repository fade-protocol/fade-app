// The pixel F: a solid letter whose upper-right corner dissolves into pixels,
// with the violet offset of the brand mark.
export const PAPER = "#f0eee8";
export const VIOLET = "#7c5cff";

/** The letter's solid blocks on the 32-unit grid, [x, y, w, h, colour]: the violet offset first. */
export const LOGO_BLOCKS: [number, number, number, number, string][] = [
  [4, 10, 6, 20, VIOLET],
  [10, 18, 6, 4, VIOLET],
  [6, 8, 6, 20, PAPER],
  [6, 8, 14, 6, PAPER],
  [12, 16, 6, 4, PAPER],
];

// [x, y, colour] on a 2-unit grid, the dissolve of the top bar's end.
export const PIXELS: [number, number, string][] = [
  [20, 8, PAPER],
  [22, 10, PAPER],
  [20, 12, VIOLET],
  [24, 8, PAPER],
  [22, 6, PAPER],
  [26, 4, PAPER],
  [24, 12, PAPER],
  [26, 10, VIOLET],
  [28, 6, PAPER],
  [22, 14, PAPER],
  [20, 16, PAPER],
  [24, 16, VIOLET],
  [26, 14, PAPER],
];

export function LogoMark({ size = 32, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      shapeRendering="crispEdges"
    >
      {title && <title>{title}</title>}
      {LOGO_BLOCKS.map(([x, y, w, h, c]) => (
        <rect key={`b${x}-${y}-${w}`} x={x} y={y} width={w} height={h} fill={c} />
      ))}
      {PIXELS.map(([x, y, c]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="2" height="2" fill={c} />
      ))}
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <LogoMark size={30} />
      <span>FADE</span>
    </span>
  );
}
