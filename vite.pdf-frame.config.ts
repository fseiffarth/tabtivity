import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { BRAND } from "./src/lib/brand";

/* The sealed pdf.js frame of the phone's markup view
 * (`mobile-web/src/pdfFrame/main.ts`), built after the app bundle into the
 * same `mobile-dist/`.
 *
 * Its own build because its script must be a *classic* one — the frame runs
 * in an opaque origin (`sandbox="allow-scripts"`), and a module script there
 * is a CORS request the sidecar's static route does not answer. Rollup emits
 * an IIFE only for a single entry, so it cannot share the app's build.
 *
 * `pdf-frame.html` is written here, naming the hashed script, rather than kept
 * in `mobile-web/`: an HTML entry would come out with a module script. The
 * service worker's precache list leaves the frame out (it is read off the
 * app's own `index.html`), so the phone fetches it when it is first used. */
function framePage(): Plugin {
  let outDir = "";
  let script = "";
  return {
    name: "app-pdf-frame-page",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find((chunk) => chunk.type === "chunk" && chunk.isEntry);
      script = entry?.fileName ?? "";
    },
    closeBundle() {
      if (!/^assets\/pdf-frame-[A-Za-z0-9_-]+\.js$/.test(script)) {
        throw new Error(`pdf-frame: unexpected entry name ${JSON.stringify(script)}`);
      }
      writeFileSync(
        resolve(outDir, "pdf-frame.html"),
        `<!doctype html>\n<html><head><meta charset="utf-8"><title>${BRAND.display} PDF frame</title></head>` +
          `<body><script src="/${script}"></script></body></html>\n`,
      );
    },
  };
}

export default defineConfig({
  root: "mobile-web",
  base: "/",
  publicDir: false,
  plugins: [framePage()],
  build: {
    outDir: "../mobile-dist",
    // The app bundle is already there; this adds to it.
    emptyOutDir: false,
    copyPublicDir: false,
    modulePreload: false,
    // pdf.js and its worker in one script, by design: nothing is split off a
    // classic frame script.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: resolve("mobile-web/src/pdfFrame/main.ts"),
      output: {
        format: "iife",
        entryFileNames: "assets/pdf-frame-[hash].js",
        inlineDynamicImports: true,
      },
    },
  },
});
