// A tab opened before a deploy still asks for the chunks of its own build;
// after the deploy they are gone (the server answers 404, worker/index.ts).
// Reloading picks up the new index.html and its chunks. Guarded against loops:
// at most one reload per RELOAD_WINDOW_MS in this tab, after which the failure
// goes to the caller's own handling (the 2D receipt, no wallet, ...).

const RELOAD_AT_KEY = "fade.staleDeploy.reloadAt";
const RELOAD_WINDOW_MS = 30_000;

/**
 * What browsers reject a failed dynamic import with (Chromium, Firefox,
 * Safari), including a chunk served with the wrong MIME type.
 */
const CHUNK_LOAD_ERROR =
  /dynamically imported module|Importing a module script failed|Expected a JavaScript.*module script|Unable to preload CSS/i;

export function isChunkLoadError(e: unknown): boolean {
  return e instanceof Error && CHUNK_LOAD_ERROR.test(e.message);
}

/** Reloads the page unless this tab already did in the last 30 s; says whether it did. */
export function reloadForNewDeploy(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_AT_KEY));
    if (Number.isFinite(last) && Date.now() - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
  } catch {
    // without storage there is no loop guard: no reload
    return false;
  }
  console.warn("A part of the app is from an older deploy; reloading.");
  window.location.reload();
  return true;
}

/** For a failed dynamic import: reloads when it looks like a stale deploy, says whether it did. */
export function reloadIfStale(e: unknown): boolean {
  return isChunkLoadError(e) && reloadForNewDeploy();
}

/** Vite reports every failed lazy chunk (and its preloads) on window. */
export function installStaleDeployReload(): void {
  window.addEventListener("vite:preloadError", () => {
    reloadForNewDeploy();
  });
}
