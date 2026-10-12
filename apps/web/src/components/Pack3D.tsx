// The Booster demo's pack in 3D, with a 2D pack as its fallback. Built like the checkout's 3D
// receipt (Receipt3D.tsx): which pack shows is decided at the first render (no 2D flash before the
// 3D), the 3D chunk (three.js and the engine) and the model load as soon as the game is on
// screen, and the canvas fades in on its first frame.
//
// Stays 2D, and never loads three.js, under prefers-reduced-motion, Save-Data, without WebGL2, or
// after a failure earlier in this tab. Falls back to 2D on a load error, without a first frame in
// 6 s, on a slow first second (median frame over 50 ms), or when the WebGL context is lost twice.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { reloadIfStale } from "../lib/staleDeploy";
import { CARDS, MARK } from "../pack3d/tiers";
import type { PackScene, PackView } from "../pack3d/types";
import { receipt3dGuarded, useReceipt3dWanted } from "../receipt3d/devToggle";
import {
  failedBefore,
  rememberFailure,
  saveData,
  webgl2Available,
  willTry3d,
} from "../receipt3d/support";
import { usePrefersReducedMotion } from "./motion";

export const PACK_FAILED_KEY = "fade.pack3d.failed";
const GLB_URL = `${import.meta.env.BASE_URL}pack3d/pack.glb`;
const SLOW_FRAME_MS = 50;
const PROBE_MS = 1000;
const FIRST_FRAME_MS = 6000;
/** The crossfade, in ms (also in the CSS). */
const FADE_MS = 350;

const isMobile = () =>
  window.matchMedia?.("(max-width: 767px), (pointer: coarse)").matches === true;

type Loaded = [typeof import("../pack3d/engine"), ArrayBuffer];
let loading: Promise<Loaded> | null = null;

function load(): Promise<Loaded> {
  loading ??= Promise.all([
    import("../pack3d/engine"),
    fetch(GLB_URL).then((r) => {
      if (!r.ok) throw new Error(`pack.glb: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Whether this load will try the 3D pack. */
export const willTryPack3d = () => willTry3d() && !failedBefore(PACK_FAILED_KEY);

/** For the page that opens on the booster: the 3D starts loading while the demos load. */
export function preloadPack3d(): void {
  if (willTryPack3d()) void load().catch(() => {});
}

/** The FADE mark, from its rectangles. */
export function FadeMark({ height = 48 }: { height?: number }) {
  return (
    <svg
      width={(height * 169) / 247}
      height={height}
      viewBox="0 0 169 247"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      {MARK.map(([x, y, w, h, c], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill={c === "p" ? "#f0eee8" : "#7c5cff"} />
      ))}
    </svg>
  );
}

/**
 * The pack's print, flat: the standard pack, or the premium one in gold. Sized by its container
 * (a `.pf`): every measure is a share of its height.
 */
export function PackArt({ price, premium = false }: { price: string; premium?: boolean }) {
  return (
    <div className={`pf-pack${premium ? " is-premium" : ""}`} aria-hidden="true">
      <div className="pf-seal" />
      <div className="pf-body">
        <span className="pf-brand">FADE</span>
        <span className="pf-medal">
          <FadeMark height={46} />
        </span>
        <span className="pf-title">{premium ? "PREMIUM" : "BOOSTER"}</span>
        <span className="pf-price mono">{price} USDC</span>
      </div>
      <div className="pf-seal is-bottom" />
    </div>
  );
}

/** The 2D pack: the same pack and card, flat. Its reveal is CSS, and its final frame is the rest state. */
function PackFlat({ view }: { view: PackView }) {
  const art = view.phase === "result" && view.card !== null ? CARDS[view.card] : null;
  return (
    <div className={`pf${art ? " is-open" : ""}${view.phase === "drawing" ? " is-shaking" : ""}`}>
      <PackArt price={view.price} />
      {art && (
        <div className="pf-card" key={view.key} style={{ "--c": art.hex } as CSSProperties}>
          <div className="pf-rar mono">
            <span>{art.rarity}</span>
            <span>No. {art.no}</span>
          </div>
          <div className="pf-art" aria-hidden="true">
            {art.sprite.map((on, i) => (
              <i key={i} style={on ? undefined : { background: "transparent" }} />
            ))}
          </div>
          <b className="pf-name">{art.name}</b>
          <span className="pf-tag mono">Series 01</span>
        </div>
      )}
    </div>
  );
}

export function Pack3D({ view }: { view: PackView }) {
  const wanted = useReceipt3dWanted();
  const reduced = usePrefersReducedMotion();
  const allowed = wanted && !reduced && !saveData() && webgl2Available();
  const root = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const engine = useRef<PackScene | null>(null);
  const [stage, setStage] = useState<"wait" | "3d" | "2d">(() =>
    allowed && !failedBefore(PACK_FAILED_KEY) ? "wait" : "2d",
  );
  const shown = allowed ? stage : "2d";
  const failed = useRef(false);

  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
    engine.current?.sync(view);
  });

  useEffect(() => {
    const el = root.current;
    const host = layer.current;
    if (!allowed || !el || !host) return;
    failed.current = failedBefore(PACK_FAILED_KEY);
    if (failed.current) {
      setStage("2d");
      return;
    }
    let cancelled = false;
    let started = false;
    let visible = false;
    let losses = 0;
    let firstFrame = 0;
    let scene: PackScene | null = null;
    let canvas: HTMLCanvasElement | null = null;

    const onLost = (e: Event) => {
      e.preventDefault();
      losses++;
      setStage("2d");
      scene?.pause();
      if (losses > 1) fail("the WebGL context was lost twice");
    };
    const onRestored = () => {
      setTimeout(() => {
        if (cancelled || failed.current || !scene) return;
        scene.restored();
        apply();
        setStage("3d");
      }, 0);
    };
    const teardown = (s: PackScene | null, c: HTMLCanvasElement | null) => {
      c?.removeEventListener("webglcontextlost", onLost);
      c?.removeEventListener("webglcontextrestored", onRestored);
      s?.dispose();
      c?.remove();
    };

    function fail(why: string) {
      if (import.meta.env.DEV) console.info(`[pack3d] staying on 2D: ${why}`);
      failed.current = true;
      rememberFailure(PACK_FAILED_KEY);
      clearTimeout(firstFrame);
      setStage("2d");
      const s = scene;
      const c = canvas;
      scene = null;
      canvas = null;
      engine.current = null;
      setTimeout(() => teardown(s, c), FADE_MS + 50);
    }

    const waitFirstFrame = () => {
      firstFrame = window.setTimeout(() => {
        if (cancelled || failed.current || scene) return;
        if (document.hidden) waitFirstFrame();
        else fail(`no first frame in ${FIRST_FRAME_MS / 1000} s`);
      }, FIRST_FRAME_MS);
    };

    async function start() {
      if (started || cancelled) return;
      started = true;
      waitFirstFrame();
      const c = document.createElement("canvas");
      c.className = "pack3d-canvas";
      host!.appendChild(c);
      canvas = c;
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
        const s = await mod.createPackScene(c, {
          context: gl,
          glb,
          mobile: isMobile(),
          view: viewRef.current,
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
        if (reloadIfStale(e)) return;
        console.warn("The 3D pack could not load; the 2D one stays.", e);
        fail("load error");
      }
    }

    function apply() {
      const go = visible && !document.hidden;
      if (scene) {
        if (go) scene.resume();
        else scene.pause();
      }
      if (go && !started) void start();
    }

    const io = new IntersectionObserver(([e]) => {
      visible = e?.isIntersecting ?? false;
      apply();
    });
    io.observe(el);
    document.addEventListener("visibilitychange", apply);

    const ro = new ResizeObserver(() => scene?.resize());
    ro.observe(host);

    const onMove = (e: PointerEvent) => {
      if (!scene || !canvas || e.pointerType === "touch") return;
      const r = canvas.getBoundingClientRect();
      scene.pointer(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        ((e.clientY - r.top) / r.height) * 2 - 1,
      );
    };
    const onLeave = () => scene?.pointer(null);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);

    return () => {
      cancelled = true;
      clearTimeout(firstFrame);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", apply);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      engine.current = null;
      teardown(scene, canvas);
      scene = null;
      canvas = null;
      if (!failed.current) setStage("wait");
    };
  }, [allowed]);

  return (
    <div className={`pack3d is-${shown}`} ref={root}>
      <div className="pack3d-flat">
        <PackFlat view={view} />
      </div>
      {allowed && <div className="pack3d-glow" aria-hidden="true" />}
      {allowed && <div className="pack3d-layer" ref={layer} aria-hidden="true" />}
    </div>
  );
}
