import { describe, it, expect } from "vitest";
// Read the stylesheet at test time: a `?raw` import yields "" under the
// config's `css: false`, which would make every assertion pass vacuously.
import { readAppStylesheet } from "../helpers/cssCorpus";

/**
 * Scrollbars are the engine's own, styled once in `styles/base.css`. Nothing
 * about them can be checked in jsdom, which draws none; what can be checked is
 * that no rule anywhere switches a surface back to WebKitGTK's native bar.
 * Each ban below was measured on WebKitGTK 2.52.6, and each failure is silent
 * in every other gate: the surface just grows a 21px grey bar.
 */
describe("stylesheet scrollbar invariants", () => {
  // Comments are prose about scrollbars, including the values banned below.
  // The whole split corpus, in import order: one offender anywhere counts.
  const css: string = readAppStylesheet().replace(/\/\*[\s\S]*?\*\//g, "");

  /** Every `selector { body }`; inside an at-rule the innermost pair counts. */
  const rules = css
    .split("}")
    .map((rule) => rule.split("{"))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({ selector: parts[parts.length - 2].trim(), body: parts[parts.length - 1] }));
  /** Those whose selector names a scrollbar pseudo-element. */
  const barRules = rules.filter((r) => r.selector.includes("::-webkit-scrollbar"));

  it("styles every bar from one baseline", () => {
    // Also the guard against the corpus being empty or unread.
    const bar = barRules.find((r) => r.selector === "*::-webkit-scrollbar");
    expect(bar?.body).toMatch(/width\s*:\s*8px/);
    expect(bar?.body).toMatch(/height\s*:\s*8px/);
    const thumb = barRules.find((r) => r.selector === "*::-webkit-scrollbar-thumb");
    expect(thumb?.body).toMatch(/background-color\s*:\s*var\(--scrollbar-thumb\)/);
  });

  it("never names a scrollbar width, which would bring the native bar back", () => {
    // The engine reads the pseudo-elements only while `scrollbar-width` is
    // `auto`; `thin` is parsed and gives the 21px native bar. `none` is how a
    // strip hides its bar.
    const offenders = [...css.matchAll(/scrollbar-width\s*:\s*([^;}]+)/g)]
      .map((m) => m[1].replace(/!important/, "").trim())
      .filter((value) => value !== "none");
    expect(offenders).toEqual([]);
  });

  it("never sets scrollbar-color or scrollbar-gutter", () => {
    // `scrollbar-color` selects the native bar too, and `scrollbar-gutter`
    // reserves the native 21px rather than the 8px these bars take.
    expect(css.match(/scrollbar-(color|gutter)\s*:[^;}]*/g) ?? []).toEqual([]);
  });

  it("sizes the bar nowhere but in the baseline", () => {
    const offenders = barRules
      // The parts of a bar (-thumb, -track, -corner) may carry a size.
      .filter((r) => !/::-webkit-scrollbar-/.test(r.selector) && r.selector !== "*::-webkit-scrollbar")
      .filter((r) => /\b(width|height)\s*:/.test(r.body))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  it("hides a strip's bar both ways, for the engines that read only one", () => {
    // `scrollbar-width: none` is what WebKitGTK and current Chromium read;
    // `::-webkit-scrollbar { display: none }` covers a WebKit that predates it.
    const hidden = barRules
      .filter((r) => /display\s*:\s*none/.test(r.body))
      .map((r) => r.selector.replace("::-webkit-scrollbar", ""));
    expect(hidden.length).toBeGreaterThan(0);
    const widthNone = rules
      .filter((r) => /scrollbar-width\s*:\s*none/.test(r.body))
      .flatMap((r) => r.selector.split(",").map((s) => s.trim()));
    expect([...hidden].sort()).toEqual([...widthNone].sort());
  });
});
