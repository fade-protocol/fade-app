// Development only: `?receipt=print|won|lost|expired|failed|reset` plays the
// receipt's timeline on its own, without a wallet, to see the printing, the
// draw and each ending. `&wait=<ms>` sets how long the draw takes (default
// 3000). The production build compiles this to `return null`.
import { useEffect, useState } from "react";
import type { Draw } from "../components/Receipt";

type Preview = { draw: Draw; key: string };

const ENDINGS: Record<string, Draw | null> = {
  print: null,
  won: "won",
  lost: "lost",
  expired: "expired",
  failed: "halted",
  reset: "won",
};

export function useReceiptPreview(): Preview | null {
  if (!import.meta.env.DEV) return null;
  // A build-time constant: the hooks below run on every render, or never.
  return usePreview();
}

function usePreview(): Preview | null {
  const [mode] = useState(() => new URLSearchParams(window.location.search).get("receipt"));
  const [wait] = useState(
    () => Number(new URLSearchParams(window.location.search).get("wait")) || 3000,
  );
  const [p, setP] = useState<Preview | null>(() =>
    mode && mode in ENDINGS ? { draw: "idle", key: "idle" } : null,
  );
  useEffect(() => {
    if (!mode || !(mode in ENDINGS)) return;
    const end = ENDINGS[mode] ?? null;
    const key = `preview-${Date.now()}`;
    const at = (ms: number, next: Preview) => setTimeout(() => setP(next), ms);
    const timers = [
      at(700, { draw: "printing", key }),
      at(2700, { draw: "drawing", key }),
      ...(end ? [at(2700 + wait, { draw: end, key })] : []),
      ...(mode === "reset" ? [at(2700 + wait + 4500, { draw: "idle", key: "idle" })] : []),
    ];
    return () => timers.forEach(clearTimeout);
  }, [mode, wait]);
  return p;
}
