/**
 * The custom mouse-cursor packs (`lib/theme/cursorPacks` + `stores/settings.applyCursor`).
 *
 * The rules worth pinning:
 *  - an unknown pack id means OFF, never half-applied — the value picks a
 *    drawing routine and lands in a `data-cursor` attribute;
 *  - a pack that cannot be drawn (no canvas backend) applies NOTHING, so the
 *    stylesheet's keyword fallbacks stand and the app keeps the system cursors
 *    rather than losing its pointer;
 *  - every emitted value carries its keyword fallback, because `cursor:
 *    url(…) x y` with no trailing keyword is an invalid declaration;
 *  - switching a pack off really clears the vars (inline root vars outrank
 *    every stylesheet, so a leftover would paint forever); and
 *  - the app's own rules read the tokens. A bare `cursor: pointer;` anywhere in
 *    the corpus is what makes a pack look half applied, so the stylesheet is
 *    scanned for one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }),
}));

import {
  buildCursorPreview,
  buildCursorVars,
  CURSOR_PACKS,
  CURSOR_SIZE,
  CURSOR_SPECS,
  CURSOR_VAR_NAMES,
  normalizeCursorPack,
} from "../../lib/theme/cursorPacks";
import { applyCursor } from "../../stores/settings";
import { readAppStylesheet } from "../helpers/cssCorpus";

const STUB_PNG = "data:image/png;base64,iVBORw0KGgo=";

/** A 2D context that accepts every call and draws nothing — jsdom has no canvas
 *  backend, and the art's *pixels* are not what these tests are about. */
function stubCanvas() {
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => undefined),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(STUB_PNG);
}

afterEach(() => {
  applyCursor(null);
  vi.restoreAllMocks();
});

describe("normalizeCursorPack", () => {
  it("accepts every offered pack", () => {
    for (const pack of CURSOR_PACKS) expect(normalizeCursorPack(pack)).toBe(pack);
  });

  it("reads anything else as 'system' rather than half-applying it", () => {
    for (const bad of ["", "system", "AURORA", "glow", null, undefined, 3 as never]) {
      expect(normalizeCursorPack(bad as string | null | undefined)).toBeNull();
    }
  });
});

// `buildCursorVars` caches by pack + palette, so a successful stubbed render
// of the default palette by an earlier test would be handed back here: load a
// fresh copy of the module (and of the store that calls it) with an empty
// cache, whatever ran before.
describe("a pack that cannot be drawn", () => {
  it("applies nothing at all, leaving the stylesheet's keyword fallbacks", async () => {
    vi.resetModules();
    const fresh = await import("../../stores/settings");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    fresh.applyCursor("aurora");
    expect(document.documentElement.getAttribute("data-cursor")).toBeNull();
    for (const name of CURSOR_VAR_NAMES) {
      expect(document.documentElement.style.getPropertyValue(name)).toBe("");
    }
  });
});

describe("CURSOR_SPECS", () => {
  it("keeps every hotspot inside the emitted image", () => {
    for (const spec of CURSOR_SPECS) {
      const [x, y] = spec.hotspot;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(CURSOR_SIZE);
      expect(y).toBeLessThanOrEqual(CURSOR_SIZE);
    }
  });

  it("names each token once", () => {
    expect(new Set(CURSOR_VAR_NAMES).size).toBe(CURSOR_VAR_NAMES.length);
  });
});

describe("buildCursorVars", () => {
  beforeEach(() => stubCanvas());

  it("returns nothing for 'system' and for an unknown id", () => {
    expect(buildCursorVars(null)).toEqual({});
    expect(buildCursorVars("glow")).toEqual({});
  });

  it("emits every shape with its hotspot AND its keyword fallback", () => {
    const vars = buildCursorVars("aurora");
    expect(Object.keys(vars).sort()).toEqual([...CURSOR_VAR_NAMES].sort());
    for (const spec of CURSOR_SPECS) {
      const [x, y] = spec.hotspot;
      // The trailing keyword is not decoration: `cursor: url(…) 2 1` with no
      // keyword after it is invalid and drops the whole declaration.
      expect(vars[spec.varName]).toBe(`url("${STUB_PNG}") ${x} ${y}, ${spec.fallback}`);
    }
  });

  it("draws every pack", () => {
    for (const pack of CURSOR_PACKS) {
      expect(Object.keys(buildCursorVars(pack))).toHaveLength(CURSOR_SPECS.length);
    }
  });

  it("hands the preview strip the same images the pointer uses", () => {
    expect(buildCursorPreview("ink")).toEqual([STUB_PNG, STUB_PNG, STUB_PNG, STUB_PNG]);
    expect(buildCursorPreview(null)).toEqual([]);
  });
});

describe("applyCursor", () => {
  beforeEach(() => stubCanvas());

  it("stamps the pack and the images on the root element", () => {
    applyCursor("pixel");
    expect(document.documentElement.getAttribute("data-cursor")).toBe("pixel");
    expect(document.documentElement.style.getPropertyValue("--cur-pointer")).toContain(
      "url(",
    );
  });

  it("clears both halves when it is switched off", () => {
    applyCursor("pixel");
    applyCursor(undefined);
    expect(document.documentElement.getAttribute("data-cursor")).toBeNull();
    for (const name of CURSOR_VAR_NAMES) {
      expect(document.documentElement.style.getPropertyValue(name)).toBe("");
    }
  });

  it("treats an unknown pack as 'system'", () => {
    applyCursor("pixel");
    applyCursor("nonsense");
    expect(document.documentElement.getAttribute("data-cursor")).toBeNull();
  });
});

describe("the app stylesheet", () => {
  it("reads the cursor tokens instead of naming a keyword a pack replaces", () => {
    // Comments first: this file's own documentation quotes the bare form it is
    // telling everyone not to write.
    const css = readAppStylesheet().replace(/\/\*[\s\S]*?\*\//g, "");
    const keywords = [...new Set(CURSOR_SPECS.map((s) => s.fallback))];
    const bare = new RegExp(`cursor:\\s*(${keywords.join("|")})\\s*[;}]`, "g");
    expect(css.match(bare) ?? []).toEqual([]);
  });
});
