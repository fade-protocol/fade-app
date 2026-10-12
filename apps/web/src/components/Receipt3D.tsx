// The receipt printer in 3D, with the 2D receipt as its fallback and its
// accessible text. Same props as <Receipt>.
//
// Which receipt shows is decided at the first render (support.ts), so the page
// never flashes one before the other. When 3D is tried, the 2D receipt is
// rendered but invisible from the start (still read by screen readers: its
// aria-live line announces the result), a calm glow holds its exact space, and
// the 3D chunk (three.js and the engine) and the printer model load as soon as
// the demo is on screen; the canvas (aria-hidden) fades in on its first frame.
//
// Stays 2D, and never loads three.js, under prefers-reduced-motion, Save-Data,
// without WebGL2, or after a failure earlier in this tab. Falls back to 2D,
// fading it in, on a load error, without a first frame in 6 s, on a slow first
// second (median frame over 50 ms), or when the WebGL context is lost twice
// (one restore is tried).
import { useEffect, useRef, useState } from "react";
import { usdc } from "../lib/format";
import { reloadIfStale } from "../lib/staleDeploy";
import { receipt3dGuarded, useReceipt3dWanted } from "../receipt3d/devToggle";
import {
  failedBefore,
  rememberFailure,
  saveData,
  webgl2Available,
  willTry3d,
} from "../receipt3d/support";
import type { PrinterData, PrinterScene, PrinterView, Stage } from "../receipt3d/types";
import { usePrefersReducedMotion } from "./motion";
import { PENDING, RESULT, Receipt, THANKS, backOf, isResult, type ReceiptProps } from "./Receipt";

const GLB_URL = `${import.meta.env.BASE_URL}receipt3d/printer.glb`;
/** Over this median frame time in the first second, the 3D gives way to the 2D. */
const SLOW_FRAME_MS = 50;
const PROBE_MS = 1000;
/** Without a first 3D frame by then (from the start of the load), the 2D shows. */
const FIRST_FRAME_MS = 6000;
/** The crossfade, in ms (also in the CSS). */
const FADE_MS = 350;

const isMobile = () =>
  window.matchMedia?.("(max-width: 767px), (pointer: coarse)").matches === true;

type Loaded = [typeof import("../receipt3d/engine"), ArrayBuffer];
let loading: Promise<Loaded> | null = null;

/** Starts loading the engine chunk and the printer model, once per page. */
function load(): Promise<Loaded> {
  loading ??= Promise.all([
    import("../receipt3d/engine"),
    fetch(GLB_URL).then((r) => {
      if (!r.ok) throw new Error(`printer.glb: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  // a failed load is not kept: the failure itself is remembered for the tab
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/**
 * For the page that opens on the checkout: the 3D starts loading while the
 * demos load, only when this receipt will try it.
 */
export function preloadReceipt3d(): void {
  if (willTry3d()) void load().catch(() => {});
}

function dataOf(p: ReceiptProps): PrinterData {
  const price = p.drawPrice ?? 0n;
  const owed = p.subtotal + price;
  const back = backOf(owed, p.wonBack);
  return {
    title: p.title,
    lines: p.lines,
    subtotalLabel: p.subtotalLabel ?? "Subtotal",
    subtotal: usdc(p.subtotal),
    drawLabel: "Lucky draw",
    drawPrice: p.drawPrice !== undefined ? usdc(p.drawPrice) : null,
    pending: PENDING,
    totalLabel: p.totalLabel ?? "TOTAL",
    totalFrom: String(owed),
    // A win pays back the order and the ticket, and nothing is left to pay; a part of the
    // order leaves the rest paid.
    totalTo: String(owed - back),
    wonBackLabel: "Won back",
    wonBack: `−${usdc(back)}`,
    thanks: THANKS,
    stamp: (p.stamp ?? "Free").toUpperCase(),
    footer: typeof p.footer === "string" ? p.footer : null,
  };
}

export function Receipt3D(props: ReceiptProps) {
  const wanted = useReceipt3dWanted();
  const reduced = usePrefersReducedMotion();
  const allowed = wanted && !reduced && !saveData() && webgl2Available();
  const root = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const engine = useRef<PrinterScene | null>(null);
  /** "wait": the 3D is loading (the glow holds the place); "3d": it is drawn; "2d": it gave up. */
  const [stage, setStage] = useState<"wait" | "3d" | "2d">(() =>
    allowed && !failedBefore() ? "wait" : "2d",
  );
  const shown = allowed ? stage : "2d";
  /** A failure keeps this receipt on 2D for the rest of its life (and the tab's). */
  const failed = useRef(false);

  // The timeline's zero and the ending's arrival, tracked like the 2D's own
  // clock, so a 3D that arrives mid-payout picks up where the 2D is.
  const key = String(props.printKey ?? "idle");
  const track = useRef({
    key,
    startedAt: performance.now(),
    ended: "",
    resultAt: null as number | null,
  });
  if (track.current.key !== key)
    track.current = { key, startedAt: performance.now(), ended: "", resultAt: null };
  if (!isResult(props.draw)) track.current.ended = "";
  else if (track.current.ended !== props.draw) {
    track.current.ended = props.draw;
    track.current.resultAt = performance.now();
  }
  const view: PrinterView = {
    key,
    headAtRest: props.headAtRest ?? false,
    draw: props.draw,
    resultText: RESULT[props.draw] ?? "",
    signal: key === "idle" ? (props.signal ?? null) : null,
    data: dataOf(props),
    startedAt: track.current.startedAt,
    resultAt: isResult(props.draw) ? track.current.resultAt : null,
  };
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
    engine.current?.sync(view);
  });

  useEffect(() => {
    const el = root.current;
    const host = layer.current;
    if (!allowed || !el || !host) return;
    failed.current = failedBefore();
    if (failed.current) {
      setStage("2d");
      return;
    }
    let cancelled = false;
    let started = false;
    let visible = false;
    let losses = 0;
    let firstFrame = 0;
    let scene: PrinterScene | null = null;
    let canvas: HTMLCanvasElement | null = null;
    const column = el.closest<HTMLElement>(".demo-visual") ?? host;

    const measure = (): Stage => {
      if (!canvas) return { x: 0, y: 0, w: 0, h: 0 };
      const c = canvas.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const pad = Math.min(24, c.width * 0.04);
      const top = 8;
      return { x: pad, y: top, w: c.width - 2 * pad, h: Math.max(80, r.bottom - c.top - top) };
    };

    const onLost = (e: Event) => {
      e.preventDefault();
      losses++;
      setStage("2d");
      scene?.pause();
      if (losses > 1) fail("the WebGL context was lost twice");
    };
    const onRestored = () => {
      // after three.js's own listener (registered later) has rebuilt its GL state
      setTimeout(() => {
        if (cancelled || failed.current || !scene) return;
        scene.restored();
        apply();
        setStage("3d");
      }, 0);
    };

    const teardown = (s: PrinterScene | null, c: HTMLCanvasElement | null) => {
      c?.removeEventListener("webglcontextlost", onLost);
      c?.removeEventListener("webglcontextrestored", onRestored);
      s?.dispose();
      c?.remove();
    };

    function fail(why: string) {
      if (import.meta.env.DEV) console.info(`[receipt3d] staying on 2D: ${why}`);
      failed.current = true;
      rememberFailure();
      clearTimeout(firstFrame);
      setStage("2d");
      const s = scene;
      const c = canvas;
      scene = null;
      canvas = null;
      engine.current = null;
      // the crossfade back plays before the context goes
      setTimeout(() => teardown(s, c), FADE_MS + 50);
    }

    const waitFirstFrame = () => {
      firstFrame = window.setTimeout(() => {
        if (cancelled || failed.current || scene) return;
        // a background tab draws nothing: the clock restarts when it is back
        if (document.hidden) waitFirstFrame();
        else fail(`no first frame in ${FIRST_FRAME_MS / 1000} s`);
      }, FIRST_FRAME_MS);
    };

    async function start() {
      if (started || cancelled) return;
      started = true;
      waitFirstFrame();
      const c = document.createElement("canvas");
      c.className = "receipt3d-canvas";
      host!.appendChild(c);
      canvas = c;
      // the page's one WebGL context, handed to three.js as is
      const gl = c.getContext("webgl2", {
        alpha: true,
        antialias: true,
        premultipliedAlpha: true,
        depth: true,
        stencil: false,
        powerPreference: "high-performance",
      });
      if (!gl) return fail("no WebGL2");
      c.addEventListener("webglcontextlost", onLost);
      c.addEventListener("webglcontextrestored", onRestored);
      try {
        const [mod, glb] = await load();
        if (cancelled || failed.current) return;
        const s = await mod.createPrinterScene(c, {
          context: gl,
          glb,
          mobile: isMobile(),
          format: (micro) => usdc(micro),
          view: viewRef.current,
          stage: measure(),
        });
        if (cancelled || failed.current) return s.dispose();
        clearTimeout(firstFrame);
        scene = s;
        engine.current = s;
        s.sync(viewRef.current);
        apply();
        setStage("3d");
        if (receipt3dGuarded()) {
          const ms = await s.probe(PROBE_MS);
          if (!cancelled && scene === s && ms > SLOW_FRAME_MS)
            fail(`slow frames (median ${ms.toFixed(0)} ms)`);
        }
      } catch (e) {
        if (cancelled || failed.current) return;
        // an engine chunk from an older deploy: reload rather than settle for 2D
        if (reloadIfStale(e)) return;
        console.warn("The 3D receipt could not load; the 2D one stays.", e);
        fail("load error");
      }
    }

    function apply() {
      const go = visible && !document.hidden;
      if (scene) {
        if (go) scene.resume();
        else scene.pause();
      }
      // the first time the demo is on screen: no waiting for an idle moment
      if (go && !started) void start();
    }

    const io = new IntersectionObserver(([e]) => {
      visible = e?.isIntersecting ?? false;
      apply();
    });
    io.observe(el);
    document.addEventListener("visibilitychange", apply);

    const ro = new ResizeObserver(() => {
      if (!scene) return;
      scene.resize();
      scene.setStage(measure());
    });
    ro.observe(host);
    ro.observe(el);

    const onMove = (e: PointerEvent) => {
      if (!scene || !canvas || e.pointerType === "touch") return;
      const r = canvas.getBoundingClientRect();
      scene.pointer(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        ((e.clientY - r.top) / r.height) * 2 - 1,
      );
    };
    const onLeave = () => scene?.pointer(null);
    column.addEventListener("pointermove", onMove);
    column.addEventListener("pointerleave", onLeave);

    return () => {
      cancelled = true;
      clearTimeout(firstFrame);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", apply);
      column.removeEventListener("pointermove", onMove);
      column.removeEventListener("pointerleave", onLeave);
      engine.current = null;
      teardown(scene, canvas);
      scene = null;
      canvas = null;
      // turned back on (development), it waits for its first frame again
      if (!failed.current) setStage("wait");
    };
  }, [allowed]);

  return (
    <div className={`receipt3d is-${shown}`} ref={root}>
      <div className="receipt3d-box">
        <div className="receipt3d-flat">
          <Receipt {...props} />
        </div>
        {allowed && <div className="receipt3d-glow" aria-hidden="true" />}
      </div>
      {allowed && <div className="receipt3d-layer" ref={layer} aria-hidden="true" />}
    </div>
  );
}
