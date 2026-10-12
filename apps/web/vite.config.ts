import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
