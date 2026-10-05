import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import autoprefixer from "autoprefixer";
import { manifestPath, PAGE_COLOR, type PaintedTheme } from "./mobile-web/src/pageColors";
import { shellAssets } from "./mobile-web/src/shellAssets";
import { themeColors } from "./mobile-web/src/themeColors";

const BUILD_PLACEHOLDER = "__APP_BUILD__";
const ASSETS_PLACEHOLDER = "__APP_ASSETS__";

/* Stamp the emitted `sw.js` with this build's entry hash and asset list.
 *
 * The service worker lives in `public/`, so vite copies it byte-for-byte and
 * never fingerprints it. That left the browser with an unchanging `sw.js` — no
 * new worker was ever installed, its `activate` never purged the old cache,
 * and a phone could keep booting a superseded bundle out of it. Giving the
 * cache a per-build name fixes both halves at once: the bytes change, so the
 * browser installs; the name changes, so `activate` drops what came before.
 *
 * The asset list is what the worker precaches, so the shell can boot offline
 * after the first visit — the worker only sees the page's asset requests once
 * it controls the page, which on the first visit is after they were made.
 *
 * Runs in `closeBundle`, the one hook that is after vite has copied `public/`
 * into outDir. Failures throw rather than warn — a silently unstamped worker
 * is the exact bug this exists to prevent.
 */
function stampServiceWorker(): Plugin {
  let outDir = "";
  return {
    name: "app-stamp-sw",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const shell = readFileSync(resolve(outDir, "index.html"), "utf8");
      const entry = /\/assets\/index-([A-Za-z0-9_-]+)\.js/.exec(shell)?.[1];
      if (!entry) {
        throw new Error("stamp-sw: no hashed entry script in the emitted index.html");
      }
      const assets = shellAssets(shell);
      if (assets.some((asset) => asset.includes(",") || asset.includes('"'))) {
        throw new Error("stamp-sw: an asset path cannot be stamped into the worker's list");
      }
      const worker = resolve(outDir, "sw.js");
      const source = readFileSync(worker, "utf8");
      for (const placeholder of [BUILD_PLACEHOLDER, ASSETS_PLACEHOLDER]) {
        if (!source.includes(placeholder)) {
          throw new Error(`stamp-sw: ${placeholder} is missing from sw.js`);
        }
      }
      writeFileSync(worker, source.replaceAll(BUILD_PLACEHOLDER, entry).replaceAll(ASSETS_PLACEHOLDER, assets.join(",")));
    },
  };
}

/* One copy of `public/manifest.webmanifest` per theme, its splash and chrome in
 * that theme's page colour (`pageColors.ts`). An installed app paints its
 * launch splash from the manifest before any of the page runs, so the page
 * links the copy for the theme it paints in (`theme.applyPhoneTheme`). The
 * plain one stays for the default theme's first load. */
function themedManifests(): Plugin {
  let publicDir = "";
  return {
    name: "app-themed-manifests",
    apply: "build",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle() {
      const manifest = JSON.parse(readFileSync(resolve(publicDir, "manifest.webmanifest"), "utf8"));
      for (const [theme, color] of Object.entries(PAGE_COLOR)) {
        this.emitFile({
          type: "asset",
          fileName: manifestPath(theme as PaintedTheme).slice(1),
          source: `${JSON.stringify({ ...manifest, background_color: color, theme_color: color }, null, 2)}\n`,
        });
      }
    },
  };
}

/** The short commit HEAD points at, or "" outside git — the same hash the
 * desktop's `TABTIVITY_BUILD_COMMIT` bakes in. */
function headCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  root: "mobile-web",
  plugins: [react(), themedManifests(), stampServiceWorker()],
  base: "/",
  // The phone's own sheets are written in one palette and rebuilt onto the
  // theme anchors in `themes.css` (`themeColors.ts`). Declaring PostCSS here
  // replaces the root config, whose Tailwind the phone never used.
  css: {
    postcss: {
      plugins: [themeColors({ include: (file) => file.replaceAll("\\", "/").includes("/mobile-web/src/") }), autoprefixer()],
    },
  },
  // The commit and build time the phone shows beside its version (see `src/buildInfo.ts`).
  define: {
    __APP_MOBILE_BUILT_AT__: JSON.stringify(new Date().toISOString()),
    __APP_MOBILE_COMMIT__: JSON.stringify(headCommit()),
  },
  build: {
    outDir: "../mobile-dist",
    emptyOutDir: true,
  },
});
