/**
 * The ground under the phone terminal's rows. The phone stretches xterm's
 * element to its whole box (`.terminal .xterm { height:100% }`), so a screen
 * shorter than the box leaves a strip under the last row. xterm 5 painted its
 * `.xterm-viewport` — the layer behind the rows — in the theme's background;
 * the real xterm 6 paints only its scrollable element and leaves the viewport
 * at xterm.css's `#000`. The phone's stylesheet stretches the scrollable
 * element over the viewport so the strip stays the theme's colour.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { installXtermLayout } from "../helpers/realXterm";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";

let restoreLayout: () => void;
beforeAll(() => {
  restoreLayout = installXtermLayout();
});
afterAll(() => restoreLayout());

describe("the phone terminal's ground on the real xterm 6", () => {
  it("is painted on the scrollable element, which covers xterm's unthemed viewport", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync("mobile-web/src/style.css", "utf8") as string;
    document.head.appendChild(style);
    const body = document.body.appendChild(document.createElement("div"));
    body.className = "terminal-body";
    const host = body.appendChild(document.createElement("div"));
    host.className = "terminal";
    const term = new Terminal({ cols: 20, rows: 3, theme: { background: "#fafafa" } });
    term.open(host);

    const scrollable = host.querySelector<HTMLElement>(".xterm-scrollable-element")!;
    const viewport = host.querySelector<HTMLElement>(".xterm-viewport")!;
    // xterm 6 themes the scrollable element, and follows a theme change…
    expect(scrollable.style.backgroundColor).toBe("rgb(250, 250, 250)");
    term.options.theme = { background: "#123456" };
    expect(scrollable.style.backgroundColor).toBe("rgb(18, 52, 86)");
    // …but not the viewport behind it (xterm 5 did).
    expect(viewport.style.backgroundColor).toBe("");
    // So the scrollable element fills the stretched terminal element.
    expect(getComputedStyle(host.querySelector<HTMLElement>(".xterm")!).height).toBe("100%");
    expect(getComputedStyle(scrollable).minHeight).toBe("100%");
    style.remove();
  });
});
