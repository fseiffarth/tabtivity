// The CLI frame replay (frames.probe.ts) only: never part of `npm test`, whose
// include pattern matches `*.test.*`, not `*.probe.*`. jsdom because xterm
// expects a window even when no terminal is opened.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: new URL("../../..", import.meta.url).pathname,
    include: ["scripts/verify-cli/parsers/*.probe.ts"],
    environment: "jsdom",
    testTimeout: 120000,
    fsModuleCache: false,
    // The summary is the output: print it for a passing run too.
    silent: false,
    reporters: ["default"],
  },
});
