import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The browser desktop client (hosted plan §7.1): the desktop app's own
 * `index.html`, with `src/main-web.tsx` as the entry, built to `web-dist/`
 * under `/desktop/` — the path the Mobile sidecar serves it at
 * (`src-tauri/src/services/mobile_control/web_client.rs`). One `index.html`
 * for both builds so the theme pre-paint script never forks.
 *
 *   npm run web:bundle
 */
function webEntry(): Plugin {
  return {
    name: "app-web-entry",
    transformIndexHtml: {
      // `pre`: on the source HTML, before vite rewrites the script tag to its
      // hashed asset.
      order: "pre",
      handler(html) {
        const swapped = html.replace('src="/src/main.tsx"', 'src="/src/main-web.tsx"');
        if (swapped === html) throw new Error("web entry: index.html does not load /src/main.tsx");
        return swapped;
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), webEntry()],
  base: "/desktop/",
  clearScreen: false,
  resolve: {
    alias: [
      // Same reason as vite.config.ts: pdfjs-dist exposes only `main`.
      {
        find: /^pdfjs-dist$/,
        replacement: fileURLToPath(new URL("./node_modules/pdfjs-dist/build/pdf.mjs", import.meta.url)),
      },
    ],
  },
  build: {
    outDir: "web-dist",
    emptyOutDir: true,
  },
});
