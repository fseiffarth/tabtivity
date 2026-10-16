// The version alone does not move between local re-bundles (it only bumps on
// push), so the phone also shows its bundle's entry hash — the way to tell by
// hand whether a refresh actually picked up the new one. The hash is read at
// run time off the page's own entry script URL (`/assets/index-<hash>.js`),
// never stamped in at build time: a stamp (a build time, the commit) inlined
// into the hashed entry would change that hash, and with it `sw.js`'s cache
// name, on every rebuild of an unchanged bundle (`vite.mobile.config.ts`).
import { version as APP_VERSION } from "../../package.json";

/** The same entry the service-worker stamp keys its cache on. */
const ENTRY_SCRIPT = /\/assets\/index-([A-Za-z0-9_-]+)\.js(?:[?#]|$)/;

/** The first 8 characters of the entry chunk's hash among `scripts`' URLs, or
 * "" when none is a hashed entry (the vite dev server serves `/src/main.tsx`). */
export function entryHash(scripts: Iterable<{ src: string }>): string {
  for (const script of scripts) {
    const hash = ENTRY_SCRIPT.exec(script.src)?.[1];
    if (hash) return hash.slice(0, 8);
  }
  return "";
}

/** `v0.1.x · <entry hash>`, without the hash when there is none. */
export function formatBundleVersion(version: string, hash: string): string {
  return [`v${version}`, hash].filter(Boolean).join(" · ");
}

function pageEntryHash(): string {
  if (typeof document === "undefined") return "";
  return entryHash(document.querySelectorAll<HTMLScriptElement>("script[src]"));
}

/** The bundle this phone is running, as the splash, the lock sheet and Home's
 * header all show it. */
export const BUNDLE_VERSION = formatBundleVersion(APP_VERSION, pageEntryHash());
