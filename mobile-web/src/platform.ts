/**
 * Which Apple touch device this is. iPadOS 13+ sends a Mac's user agent by
 * default, so a "Macintosh" that takes more than one touch is an iPad.
 */
export function appleTouchDevice(nav: Pick<Navigator, "userAgent" | "maxTouchPoints"> | undefined
  = typeof navigator === "undefined" ? undefined : navigator): "iPhone" | "iPad" | null {
  if (!nav) return null;
  if (/iPad/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1)) return "iPad";
  if (/iPhone|iPod/.test(nav.userAgent)) return "iPhone";
  return null;
}

/** Whether this runs as the app added to the Home Screen — no browser
 * around it, so no back button and no tab strip to return by. */
export function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
  return typeof window.matchMedia === "function"
    && (window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: fullscreen)").matches);
}

/**
 * Whether a `window.open` would strand the user: the installed app on an
 * iPhone or iPad shows the opened file over the whole screen, with no way
 * back into the app. Files are read inside the app there instead.
 */
export function openingOutsideStrands(): boolean {
  return appleTouchDevice() !== null && isInstalledApp();
}
