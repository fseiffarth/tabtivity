// Stamped by `vite.mobile.config.ts` at bundle time. The version alone does not
// move between local re-bundles (it only bumps on push), so the phone also
// shows the commit its bundle was built from and when — the way to tell by
// hand whether a refresh actually picked up the new one.
import { version as APP_VERSION } from "../../package.json";

declare const __APP_MOBILE_BUILT_AT__: string | undefined;
declare const __APP_MOBILE_COMMIT__: string | undefined;

const BUILT_AT = typeof __APP_MOBILE_BUILT_AT__ === "string" ? __APP_MOBILE_BUILT_AT__ : undefined;
const COMMIT = typeof __APP_MOBILE_COMMIT__ === "string" ? __APP_MOBILE_COMMIT__ : "";

/** `dd-mm hh:mm` in the phone's local time, or "" when the stamp is missing or unreadable. */
export function formatBuildStamp(iso: string | undefined = BUILT_AT): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `v0.1.x · <commit> · dd-mm hh:mm`, skipping whichever part is empty. */
export function formatBundleVersion(version: string, commit: string, stamp: string): string {
  return [`v${version}`, commit, stamp].filter(Boolean).join(" · ");
}

/** The bundle this phone is running, as the splash, the lock sheet and Home's
 * header all show it. */
export const BUNDLE_VERSION = formatBundleVersion(APP_VERSION, COMMIT, formatBuildStamp());
