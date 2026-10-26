import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The build's id: the commit the deploy builds (FADE_BUILD_ID, set by the deploy workflow), or a fresh one
 * for a local build. The bundle carries it, and build.json says which one the site serves: a
 * tab from an older build reloads before it opens a ticket (src/lib/staleDeploy.ts).
 */
const BUILD_ID = process.env.FADE_BUILD_ID || `local-${Date.now().toString(36)}`;
// Vite reads its VITE_ variables from the environment after this file: the bundle's
// import.meta.env carries it.
process.env.VITE_FADE_BUILD_ID = BUILD_ID;

/** Writes build.json next to index.html (public/_headers keeps it from being cached). */
function buildFile(): Plugin {
  return {
    name: "fade-build-file",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build.json",
        source: `${JSON.stringify({ build: BUILD_ID })}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildFile()],
  resolve: {
    // The generated client lives outside this package and resolves its own
    // copy of @solana/kit from the repository root: keep one instance.
    dedupe: ["@solana/kit", "@solana/program-client-core"],
  },
  build: {
    target: "es2022",
    // Maps stay local for debugging; public/.assetsignore keeps them off the site.
    sourcemap: "hidden",
  },
});
