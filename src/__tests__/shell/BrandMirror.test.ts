/**
 * The frontend brand module (`src/lib/brand.ts`) and the backend one
 * (`src-tauri/src/brand.rs`) are built separately, yet many names cross
 * between them: a header the webview sends and the backend reads, a tab
 * command one side saves and the other maps, a folder both look into. This
 * holds every shared name to the backend's, for the current brand and the old
 * one, and holds the few static files that must spell a name themselves to
 * the brand module.
 */
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND,
  LEGACY_BRAND,
  LEGACY_MOBILE_ACCESS_KEY,
  LEGACY_MOBILE_HOST_KEY,
  LEGACY_NAMES,
  MOBILE_ACCESS_KEY,
  MOBILE_DEVICES_KEY,
  MOBILE_HOST_KEY,
  NAMES,
  envName,
  storageDashKey,
  tabCommand,
} from "../../lib/brand";
import { readRustBrand } from "../helpers/rustBrand";

const rust = readRustBrand();

/** `gitRefBackup` → `GIT_REF_BACKUP`. */
function rustName(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/** Names only the frontend has; everything else in `NAMES` must exist in brand.rs. */
const FRONTEND_ONLY = new Set([
  "storagePrefix",
  "storageDashPrefix",
  "storageColonPrefix",
  "mobileAuthDb",
  "mobileMarkupDb",
  "mobileShellCachePrefix",
  "mobileOpenMessage",
  "mobileNotificationTagPrefix",
]);

describe("brand mirror", () => {
  it("spells the brand's forms as the backend does", () => {
    expect(BRAND.display).toBe(rust.current.DISPLAY);
    expect(BRAND.slug).toBe(rust.current.SLUG);
    expect(BRAND.upper).toBe(rust.current.UPPER);
    expect(BRAND.envPrefix).toBe(rust.current.ENV_PREFIX);
    expect(LEGACY_BRAND.display).toBe(rust.legacy.LEGACY_DISPLAY);
    expect(LEGACY_BRAND.slug).toBe(rust.legacy.LEGACY_SLUG);
    expect(LEGACY_BRAND.upper).toBe(rust.legacy.LEGACY_UPPER);
    expect(LEGACY_BRAND.envPrefix).toBe(rust.legacy.LEGACY_ENV_PREFIX);
  });

  it("builds every shared name exactly as the backend does", () => {
    const shared = Object.keys(NAMES).filter((k) => !FRONTEND_ONLY.has(k));
    expect(shared.length).toBeGreaterThan(20);
    for (const key of shared) {
      const name = rustName(key);
      expect(rust.current[name], `brand.rs has no ${name}`).toBeDefined();
      expect(NAMES[key as keyof typeof NAMES], key).toBe(rust.current[name]);
      expect(LEGACY_NAMES[key as keyof typeof NAMES], `legacy ${key}`).toBe(
        rust.legacy[`LEGACY_${name}`],
      );
    }
  });

  it("keys the phone switches as the backend's serde keys", () => {
    expect(MOBILE_HOST_KEY).toBe(rust.current.MOBILE_HOST_KEY);
    expect(MOBILE_ACCESS_KEY).toBe(rust.current.MOBILE_ACCESS_KEY);
    expect(MOBILE_DEVICES_KEY).toBe(rust.current.MOBILE_DEVICES_KEY);
    expect(LEGACY_MOBILE_HOST_KEY).toBe(rust.legacy.LEGACY_MOBILE_HOST_KEY);
    expect(LEGACY_MOBILE_ACCESS_KEY).toBe(rust.legacy.LEGACY_MOBILE_ACCESS_KEY);
  });

  it("builds env names and tab commands on the backend's prefixes", () => {
    expect(envName("TAB_UID")).toBe(`${rust.current.ENV_PREFIX}TAB_UID`);
    expect(tabCommand("mail")).toBe(`${rust.current.TAB_COMMAND_PREFIX}mail__`);
  });

  it("has an old spelling for every name once the brand is renamed", () => {
    // Renamed: every name moved, so every dual read has a second place to
    // look. (Unchanged, the two tables are the same and nothing looks twice.)
    const renamed: boolean = (BRAND.slug as string) !== (LEGACY_BRAND.slug as string);
    if (!renamed) {
      expect(NAMES).toEqual(LEGACY_NAMES);
      return;
    }
    for (const key of Object.keys(NAMES) as (keyof typeof NAMES)[]) {
      expect(NAMES[key], key).not.toBe(LEGACY_NAMES[key]);
      expect(NAMES[key], key).toContain(BRAND.slug);
      expect(LEGACY_NAMES[key], key).toContain(LEGACY_BRAND.slug);
    }
    expect(MOBILE_HOST_KEY).not.toBe(LEGACY_MOBILE_HOST_KEY);
    expect(MOBILE_ACCESS_KEY).not.toBe(LEGACY_MOBILE_ACCESS_KEY);
  });

  it("index.html pre-paints from the storage keys the settings store writes", () => {
    // The pre-paint script runs before any module loads, so it spells the keys
    // itself; a rename has to edit it together with the brand module.
    // It reads the current key and, while that is absent, the one an older
    // build wrote: the keys are only moved by a module that runs after it.
    const html: string = readFileSync("index.html", "utf8");
    expect(html).toContain(`var KEY = "${NAMES.storageDashPrefix}";`);
    expect(html).toContain(`var OLD_KEY = "${LEGACY_NAMES.storageDashPrefix}";`);
    expect(storageDashKey("theme")).toBe(`${NAMES.storageDashPrefix}theme`);
    for (const key of ["theme", "accent", "theme-vars", "corners"]) {
      expect(html).toContain(`stored("${key}")`);
    }
    expect(html).not.toContain("localStorage.getItem(\"");
    // The script itself, run against a storage that holds only old keys,
    // only current ones, or both.
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const paint = (entries: Record<string, string>) => {
      const attrs: Record<string, string> = {};
      const props: Record<string, string> = {};
      const env = {
        localStorage: { getItem: (key: string) => (key in entries ? entries[key] : null) },
        document: {
          documentElement: {
            setAttribute: (name: string, value: string) => { attrs[name] = value; },
            style: { setProperty: (name: string, value: string) => { props[name] = value; } },
          },
        },
      };
      new Function("localStorage", "document", script)(env.localStorage, env.document);
      return { theme: attrs["data-theme"], accent: props["--accent"], radius: props["--radius"] };
    };
    const old = LEGACY_NAMES.storageDashPrefix;
    const cur = NAMES.storageDashPrefix;
    expect(paint({})).toEqual({ theme: "light_lavender", accent: undefined, radius: undefined });
    expect(paint({ [`${old}theme`]: "light", [`${old}accent`]: "#112233", [`${old}corners`]: "square" })).toEqual({
      theme: "light",
      accent: "#112233",
      radius: "0px",
    });
    expect(paint({ [`${cur}theme`]: "fancy_dark", [`${old}theme`]: "light", [`${old}accent`]: "#112233" })).toEqual({
      theme: "fancy_dark",
      accent: "#112233",
      radius: undefined,
    });
    expect(html).toContain(`<title>${BRAND.display}</title>`);
  });

  it("the phone service worker spells its names as the brand module does", () => {
    // `sw.js` is served as a static file and cannot import a module, so it
    // spells its cache name, its message type and its tag prefix itself.
    const sw: string = readFileSync("mobile-web/public/sw.js", "utf8");
    expect(sw).toContain(`const CACHE = "${NAMES.mobileShellCachePrefix}__APP_BUILD__";`);
    expect(sw).toContain(`type: "${NAMES.mobileOpenMessage}"`);
    expect(sw).toContain(`\`${NAMES.mobileNotificationTagPrefix}\${data.tag}\``);
  });

  it("the phone's static pages show the brand's display name", () => {
    const html: string = readFileSync("mobile-web/index.html", "utf8");
    expect(html).toContain(`<title>${BRAND.display} Mobile</title>`);
    expect(html).toContain(`name="apple-mobile-web-app-title" content="${BRAND.display}"`);
    const manifest = JSON.parse(readFileSync("mobile-web/public/manifest.webmanifest", "utf8")) as {
      name: string;
      short_name: string;
    };
    expect(manifest.name).toBe(`${BRAND.display} Mobile`);
    expect(manifest.short_name).toBe(BRAND.display);
  });
});
