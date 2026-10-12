// Whether the 3D receipt is tried at all, decided synchronously so the first
// render already knows which receipt to show: no 2D flash before the 3D, and no
// placeholder where the 3D will never come. Imports nothing from three.js.
import { receipt3dGuarded, receipt3dWanted } from "./devToggle";

const FAILED_KEY = "fade.receipt3d.failed";

let webgl2: boolean | null = null;
/** A cheap probe: the API exists. Creating a context can still fail; that falls back to 2D. */
export function webgl2Available(): boolean {
  webgl2 ??= typeof window !== "undefined" && typeof window.WebGL2RenderingContext === "function";
  return webgl2;
}

export function saveData(): boolean {
  return (
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true
  );
}

export function reducedMotionNow(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * A failure (no context, load error, slow frames, no first frame) keeps this tab on 2D. `key`
 * keeps each 3D scene's failures apart (the Booster demo's pack passes its own).
 */
export function failedBefore(key = FAILED_KEY): boolean {
  // `?receipt3d=force` (development captures) always tries
  if (!receipt3dGuarded()) return false;
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function rememberFailure(key = FAILED_KEY): void {
  try {
    sessionStorage.setItem(key, "1");
  } catch {
    // private mode: the next load tries again
  }
}

/** Development: "3D" in the Simulate panel tries again after a failure. */
export function forgetFailure(key = FAILED_KEY): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // nothing was kept
  }
}

/** Whether the checkout's receipt will try 3D on this load. */
export function willTry3d(): boolean {
  return (
    receipt3dWanted() && !reducedMotionNow() && !saveData() && webgl2Available() && !failedBefore()
  );
}
