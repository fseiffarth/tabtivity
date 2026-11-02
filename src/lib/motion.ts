/**
 * The exit duration a floating surface is held for, read off the element so
 * the one reduced-motion block in `base.css` reaches JS too: there the token is
 * `0ms` and the surface closes at once. So does a build with no stylesheet.
 */
export function surfaceExitMs(el: Element): number {
  const ms = Number.parseFloat(getComputedStyle(el).getPropertyValue("--motion-exit"));
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}
