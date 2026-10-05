import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    css: false,
    setupFiles: ["./src/test-setup.ts"],
    // Collect only this tree's own sources. Full checkouts nest inside the
    // repo — `target/freeze-tree` (package-dev.sh --head), agent worktrees
    // under `.claude/worktrees/` — and a run must never test another tree:
    // an agent working in one of those runs `npm test` from its own root.
    include: ["{src,mobile-web,shared,scripts}/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // The full suite runs heavy viewer renders + real-timer polls across many
    // parallel forks; the 5s default test timeout is too tight under that load
    // and trips otherwise-passing tests. Give them headroom.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
