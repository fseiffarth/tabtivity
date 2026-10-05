import postcss from "postcss";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fitColor, fitExpr, themeColors } from "../../../mobile-web/src/themeColors";
import { applyPhoneTheme, noteDesktopTheme, phoneTerminalTheme, readPhoneTheme, resolvePhoneTheme, setPhoneTheme } from "../../../mobile-web/src/theme";

const run = (css: string, from = "/repo/mobile-web/src/style.css") =>
  postcss([themeColors({ include: (file) => file.includes("/mobile-web/src/") })]).process(css, { from }).css;

describe("phone theme colour fit", () => {
  it("reads the palette's bluish greys as tone alone, so each theme's stops supply the tint", () => {
    for (const [r, g, b] of [[0x17, 0x1a, 0x24], [0x38, 0x3c, 0x4d], [0x94, 0x98, 0xaa], [0xe7, 0xe9, 0xf2]]) {
      const fit = fitColor(r, g, b);
      expect(fit.hue).toBeNull();
      expect(fit.p).toBe(0);
    }
    // Darker grey, lower on the curve.
    expect(fitColor(0x17, 0x1a, 0x24).q).toBeLessThan(fitColor(0x94, 0x98, 0xaa).q);
  });

  it("keeps a faint wash that points away from the greys in its hue", () => {
    expect(fitColor(0x3b, 0x20, 0x27).hue).toBe("red");
    expect(fitColor(0x2b, 0x26, 0x50).hue).toBe("accent");
    expect(fitColor(0x8f, 0xb8, 0xff).hue).toBe("blue");
  });

  it("fits every colour closely, and one no anchor explains through its own hue", () => {
    const fit = fitColor(0x9f, 0xd8, 0x6a);
    expect(fit.hue).toBe("own");
    expect(fit.error).toBeLessThan(0.016);
    expect(fitExpr(fit)).toMatch(/^color-mix\(in oklab, oklch\([\d.]+% [\d.]+ [\d.]+\) [\d.]+%, /);
    expect(fitExpr(fitColor(0x7c, 0x6c, 0xff))).toBe("var(--m-accent)");
    expect(fitExpr(fitColor(0, 0, 0))).toBe("var(--m-n0)");
    expect(fitExpr(fitColor(255, 255, 255))).toBe("var(--m-n4)");
  });
});

describe("phone theme stylesheet transform", () => {
  it("rebuilds each literal on the anchors, keeping its alpha, and defines each once", () => {
    const css = run(".a { color:#e7e9f2; border:1px solid rgba(28,31,43,.92); }\n.b { background:#E7E9F2; }");
    expect(css).toContain(".a { color:var(--mc-e7e9f2); border:1px solid color-mix(in oklab, var(--mc-1c1f2b) 92%, transparent); }");
    expect(css).toContain(".b { background:var(--mc-e7e9f2); }");
    expect(css.match(/--mc-e7e9f2:/g)).toHaveLength(1);
    expect(css.startsWith(":root")).toBe(true);
  });

  it("leaves inline SVG, black shades, white paper, anchors and vendor sheets alone", () => {
    const svg = `select { background-image:url("data:image/svg+xml,%3Csvg stroke='%239aa0b4'%3E"); }`;
    expect(run(svg)).toBe(svg);
    expect(run(".s { box-shadow:0 8px 24px rgba(0,0,0,.16); }")).toBe(".s { box-shadow:0 8px 24px rgba(0,0,0,.16); }");
    expect(run(".page { background:#fff; color:#fff; }")).toBe(":root { --mc-ffffff:var(--m-n4); }\n.page { background:#fff; color:var(--mc-ffffff); }");
    expect(run(":root { --m-accent:#7c6cff; }")).toBe(":root { --m-accent:#7c6cff; }");
    expect(run(".x { color:#e7e9f2; /* theme: fixed */ }")).toBe(".x { color:#e7e9f2; /* theme: fixed */ }");
    expect(run(".xterm { color:#e7e9f2; }", "/repo/node_modules/@xterm/xterm/css/xterm.css")).toBe(".xterm { color:#e7e9f2; }");
  });

  it("gives an accent-filled control the theme's on-accent text, so Plain Dark's white accent stays readable", () => {
    expect(run(".primary { background:#6c5ce7; }")).toContain(".primary { background:var(--mc-6c5ce7); color:var(--m-on-accent); }");
    expect(run(".chip { background:#7c6cff; color:#fff; }")).toContain(".chip { background:var(--mc-7c6cff); color:var(--m-on-accent); }");
    // Dark text on the accent already flips with the theme; a grey fill is no accent.
    expect(run(".k { background:#8c7df4; color:#0b0d13; }")).toContain("color:var(--mc-0b0d13)");
    expect(run(".g { background:#1b1e29; }")).not.toContain("on-accent");
  });
});

describe("phone theme choice", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-pick");
  });

  it("paints the terminal in the desktop's palette for the phone's theme, with the cursor hidden", () => {
    expect(phoneTerminalTheme().background).toBe("#000000");
    setPhoneTheme("light_lavender");
    const lavender = phoneTerminalTheme();
    expect(lavender.background).toBe("#faf9fe");
    expect(lavender.foreground).toBe("#2c2348");
    expect(lavender.cursor).toBe(lavender.background);
    expect(lavender.cursorAccent).toBe(lavender.background);
  });
  afterEach(() => localStorage.clear());

  it("follows the desktop until the phone picks its own", () => {
    expect(readPhoneTheme()).toBe("desktop");
    applyPhoneTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light_lavender");
    noteDesktopTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    setPhoneTheme("soft_dark");
    noteDesktopTheme("fancy_light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("soft_dark");
    setPhoneTheme("desktop");
    expect(document.documentElement.getAttribute("data-theme")).toBe("fancy_light");
  });

  it("links the manifest whose launch splash is the painted theme's page colour", () => {
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = "/manifest.webmanifest";
    document.head.append(link);
    try {
      setPhoneTheme("fancy_dark");
      expect(link.getAttribute("href")).toBe("/manifest-fancy_dark.webmanifest");
      setPhoneTheme("desktop");
      expect(link.getAttribute("href")).toBe("/manifest-light_lavender.webmanifest");
    } finally {
      link.remove();
    }
  });

  it("ignores a desktop theme it does not know", () => {
    noteDesktopTheme("<script>");
    noteDesktopTheme(42);
    applyPhoneTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light_lavender");
  });

  it("resolves System by the phone's own OS and marks it, for the octagon bubbles", () => {
    expect(resolvePhoneTheme("system", "dark", true)).toEqual({ theme: "fancy_light", system: true });
    expect(resolvePhoneTheme("system", "dark", false)).toEqual({ theme: "fancy_dark", system: true });
    expect(resolvePhoneTheme("system", "dark", null)).toEqual({ theme: "dark", system: true });
    expect(resolvePhoneTheme("desktop", "system", true)).toEqual({ theme: "fancy_light", system: true });
    expect(resolvePhoneTheme("light", "system", true)).toEqual({ theme: "light", system: false });
    setPhoneTheme("system");
    expect(document.documentElement.getAttribute("data-theme-pick")).toBe("system");
    setPhoneTheme("light_lavender");
    expect(document.documentElement.hasAttribute("data-theme-pick")).toBe(false);
  });
});
