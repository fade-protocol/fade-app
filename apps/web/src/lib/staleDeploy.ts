// A tab opened before a deploy still asks for the chunks of its own build;
// after the deploy they are gone (the server answers 404, worker/index.ts).
// Reloading picks up the new index.html and its chunks. Guarded against loops:
// at most one reload per RELOAD_WINDOW_MS in this tab, after which the failure
// goes to the caller's own handling (the 2D receipt, no wallet, ...).
//
// A tab whose chunks are all loaded never fails a chunk load: it would keep the
// older build's reading of the chain (a ticket's end decoded with the event
// layout of its day) for as long as it stays open. So a ticket flow first asks
// the Worker which build it serves (build.json, written by vite.config.ts and
// never cached), and a tab from an older one reloads before it opens a ticket.

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

/** The build this bundle is from (vite.config.ts); null outside a production build. */
export const BUILD_ID: string | null =
  (import.meta as { env?: { VITE_FADE_BUILD_ID?: string } }).env?.VITE_FADE_BUILD_ID || null;
/** Where the Worker serves the build it is deploying now. */
export const BUILD_FILE = "/build.json";
/** A check that takes longer than this lets the flow start: it must never block a ticket. */
const BUILD_CHECK_TIMEOUT_MS = 3_000;

/** The build the site serves now; null when it cannot be told (offline, a dev server, ...). */
export async function liveBuild(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(BUILD_FILE, {
      cache: "no-store",
      signal: AbortSignal.timeout(BUILD_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { build?: unknown } | null;
    return typeof body?.build === "string" && body.build ? body.build : null;
  } catch {
    return null;
  }
}

/**
 * Before a ticket flow: reloads a tab whose bundle is older than the build the site serves,
 * and says whether it did (the flow must then not start). A build that cannot be read, or a
 * reload this tab made in the last 30 s, lets the flow go on.
 */
export async function reloadIfOlderBuild(
  own: string | null = BUILD_ID,
  fetchImpl: typeof fetch = fetch,
  reload: () => boolean = reloadForNewDeploy,
): Promise<boolean> {
  if (own === null) return false;
  const live = await liveBuild(fetchImpl);
  return live !== null && live !== own && reload();
}
