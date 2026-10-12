// Development only: "Receipt: 3D / 2D" in the Simulate panel, and
// `?receipt3d=0` to start on 2D, to compare the two. `?receipt3d=force` also
// skips the frame-time guard (for software-rendered captures). The
// production build compiles this to constants: 3D on, the guard on.
import { useEffect, useState } from "react";

const EVENT = "fade:dev-receipt3d";

const param = () =>
  typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("receipt3d");

let wanted: boolean | null = null;

export function receipt3dWanted(): boolean {
  if (!import.meta.env.DEV) return true;
  wanted ??= param() !== "0";
  return wanted;
}

export function setReceipt3dWanted(on: boolean): void {
  if (!import.meta.env.DEV) return;
  wanted = on;
  window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: on }));
}

/** Whether the frame-time guard applies. */
export function receipt3dGuarded(): boolean {
  if (!import.meta.env.DEV) return true;
  return param() !== "force";
}

export function useReceipt3dWanted(): boolean {
  if (!import.meta.env.DEV) return true;
  // A build-time constant: the hooks below run on every render, or never.
  return useWanted();
}

function useWanted(): boolean {
  const [on, setOn] = useState(receipt3dWanted);
  useEffect(() => {
    const h = (e: Event) => setOn((e as CustomEvent<boolean>).detail);
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, []);
  return on;
}
