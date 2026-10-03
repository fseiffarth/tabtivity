/**
 * Single source of truth for OS detection in the frontend.
 *
 * Detected once from the webview's `navigator`. Every other detector
 * (`paths.ts`, `dragPlatform.ts`, viewers, shortcuts, …) re-exports or derives
 * from these flags so the logic never drifts across the codebase.
 *
 * IMPORTANT: this module must NOT import from `paths.ts`, `dragPlatform.ts`, or
 * any other app module — keep it dependency-free so it can be the bottom of the
 * import graph with no cycles.
 */

/** True on macOS (and iOS, harmless here). Detected once from the webview. */
export const IS_MAC: boolean =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

/** True when running on Windows. `navigator.platform` is authoritative when
 *  present; otherwise we fall back to the UA string. */
export const IS_WINDOWS: boolean = (() => {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  if (platform) return /^win/i.test(platform);
  return /windows/i.test(navigator.userAgent || "");
})();

/** True on Linux — the fallback when the host is neither macOS nor Windows. */
export const IS_LINUX: boolean = !IS_MAC && !IS_WINDOWS;

/** The OS of the machine the user sits at, as a single discriminant. Windows
 *  wins over the macOS check so the two are mutually exclusive even if a UA
 *  string is unusual. Decides keys, shortcuts, window chrome and drag
 *  behaviour — everything the browser or webview does itself. */
export const PLATFORM: "windows" | "macos" | "linux" = IS_WINDOWS
  ? "windows"
  : IS_MAC
    ? "macos"
    : "linux";

export type OsName = "windows" | "macos" | "linux";

/** The same thing under the name the hosted plan uses (§1.2, §7.1). */
export const CLIENT_OS: OsName = PLATFORM;

/**
 * The OS of the machine the backend runs on (hosted plan §1.2: the
 * `HOST_OS`/`CLIENT_OS` split). In the Tauri window that is this machine; in
 * the browser desktop client it is the server's, which `installWeb.ts` stores
 * on the window from the server's `hello` BEFORE any app module loads, so
 * this constant is right at import time like the others. Decides spawn
 * policy (tmux persistence), path joins, install commands, shell choice —
 * everything that happens where the backend is.
 */
export const HOST_OS: OsName = (() => {
  if (typeof window === "undefined") return PLATFORM;
  const fromServer = (window as unknown as { __APP_HOST_OS__?: unknown }).__APP_HOST_OS__;
  return fromServer === "windows" || fromServer === "macos" || fromServer === "linux" ? fromServer : PLATFORM;
})();

export const IS_HOST_WINDOWS: boolean = HOST_OS === "windows";
export const IS_HOST_MAC: boolean = HOST_OS === "macos";
export const IS_HOST_LINUX: boolean = HOST_OS === "linux";
