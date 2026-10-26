// Whether the app shows the shared beacon's demo. The beacon runs on the
// app's own program (lib/config.ts `PROGRAM`), so the build only says
// whether to show it: the demo stays hidden unless `VITE_BEACON_ENABLED`
// turns it on.

/**
 * Whether `raw` turns the demo on: "true" or "1", any case or padding.
 * Anything else, unset included, hides it rather than guess.
 */
export function parseBeaconEnabled(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? "";
  return value === "true" || value === "1";
}
