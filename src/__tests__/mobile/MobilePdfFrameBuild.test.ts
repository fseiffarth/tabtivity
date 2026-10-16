/**
 * The sealed PDF frame's build (`vite.pdf-frame.config.ts`): one classic
 * script, so the IIFE options carry what the ES module it is bundled from
 * took for granted. Rolldown, unlike Rollup, emits neither `"use strict"`
 * (its `output.strict` defaults to `'auto'`) nor an `import.meta.url` for an
 * IIFE — without the two options below the frame's pdf.js runs in sloppy mode
 * and reads its script name as `undefined`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("vite", () => ({ defineConfig: <T>(config: T): T => config }));

/** Through a variable: the config is outside the type-checked projects. */
const CONFIG_MODULE: string = "../../../vite.pdf-frame.config.ts";

interface FrameConfig {
  define: Record<string, string>;
  build: {
    target: string[];
    rolldownOptions: { output: { format: string; strict: unknown; codeSplitting: unknown; intro: string } };
  };
}

async function frameConfig(): Promise<FrameConfig> {
  return ((await import(/* @vite-ignore */ CONFIG_MODULE)) as { default: FrameConfig }).default;
}

describe("the PDF frame's build", () => {
  it("is one strict-mode classic script", async () => {
    const { output } = (await frameConfig()).build.rolldownOptions;
    expect(output.format).toBe("iife");
    expect(output.codeSplitting).toBe(false);
    expect(output.strict).toBe(true);
  });

  it("binds import.meta.url to the frame script's own URL", async () => {
    const config = await frameConfig();
    const name = config.define["import.meta.url"];
    expect(name).toMatch(/^[A-Za-z_$][\w$]*$/);
    expect(config.build.rolldownOptions.output.intro).toBe(
      `var ${name} = document.currentScript && document.currentScript.src;`,
    );
  });

  it("keeps vite 6's browser floor", async () => {
    expect((await frameConfig()).build.target).toEqual(["es2020", "edge88", "firefox78", "chrome87", "safari14"]);
  });
});
