/**
 * On a Windows webview the WebGL terminal renderer is always on: WebView2's
 * WebGL is dependable, so Settings shows no switch for it and neither an unset
 * nor a stale explicit `false` may leave it off (`lib/experimental.ts`).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform")>()),
  IS_WINDOWS: true,
}));

import { experimentalEnabled } from "../../lib/experimental";
import type { Settings } from "../../types";

const s = (o: Partial<Settings>): Settings => o as Settings;

describe("terminal_webgl on Windows", () => {
  it("is on whether unset or explicitly off", () => {
    expect(experimentalEnabled(s({}), "terminal_webgl")).toBe(true);
    expect(experimentalEnabled(s({ terminal_webgl: false }), "terminal_webgl")).toBe(true);
  });

  it("leaves the other GPU-path flags opt-in", () => {
    expect(experimentalEnabled(s({}), "gpu_compositing")).toBe(false);
  });
});
