import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { NAMES } from "./src/lib/brand";

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: [
      // pdfjs-dist's package.json exposes only `main` (no `exports`/`module`),
      // which Vite's package-entry resolver handles inconsistently across
      // platforms — it fails on Windows ("Failed to resolve entry for package
      // pdfjs-dist"). Point the bare specifier straight at the file `main`
      // references. The regex anchors an exact match so subpath imports like
      // `pdfjs-dist/build/pdf.worker.min.mjs?url` are left untouched.
      {
        find: /^pdfjs-dist$/,
        replacement: fileURLToPath(
          new URL(
            "./node_modules/pdfjs-dist/build/pdf.mjs",
            import.meta.url,
          ),
        ),
      },
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // src/__tests__ is here because vite full-reloads the live window for a
      // changed file it watches but has no module-graph entry for — and test
      // files are exactly that. Concurrent agent sessions editing tests were
      // reloading the app the user was working in.
      //
      // dist/ and mobile-dist/ are here for the same reason and a worse case:
      // they are the BUILD's outputs, and `npm run build` is a mandated gate
      // (AGENTS.md) that anyone — a person or an agent — is expected to run
      // while a dev session is up. `mobile:build` writes mobile-dist/, the
      // watcher sees files with no module-graph entry, and every open Tabtivity
      // webview full-reloads: the main window and each popout, several times
      // per build. Observed in hotreload.log as three `page reload
      // mobile-dist/index.html` lines per gate run. Running the tests must not
      // reload the window; neither must running the build.
      ignored: [
        "**/src-tauri/**",
        "**/target/**",
        `**/${NAMES.projectDir}/**`,
        "**/src/__tests__/**",
        "**/dist/**",
        "**/mobile-dist/**",
      ],
    },
  },
}));
