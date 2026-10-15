/**
 * The phone's service-worker cache name is content-derived: `sw.js` is
 * stamped with the entry chunk's hash (`vite.mobile.config.ts`
 * `stampServiceWorker`), so two builds of an unchanged tree must give the same
 * name. A build-time value inlined into the bundle — a build time, the commit,
 * as `define`s once did — changes the entry hash on every rebuild, and every
 * phone then drops its cache and re-downloads a bundle that did not change.
 *
 * Builds the phone bundle twice, as `npm run mobile:bundle` does, into scratch
 * directories outside the tree.
 */
// @ts-expect-error node:child_process has no type declarations in this project (no @types/node)
import { spawnSync } from "node:child_process";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
// @ts-expect-error node:os has no type declarations in this project (no @types/node)
import { tmpdir } from "node:os";
// @ts-expect-error node:path has no type declarations in this project (no @types/node)
import { dirname, join } from "node:path";
// @ts-expect-error node:url has no type declarations in this project (no @types/node)
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND } from "../../lib/brand";

declare const process: { execPath: string };

const repoRoot: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** One phone build into a fresh scratch dir: its worker's cache name and entry script. */
function buildPhone(): { cache: string; entry: string } {
  const outDir = mkdtempSync(join(tmpdir(), `${BRAND.slug}-sw-cache-`));
  try {
    const run = spawnSync(
      process.execPath,
      [join(repoRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "vite.mobile.config.ts", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    const cache = /const CACHE = "([^"]+)"/.exec(readFileSync(join(outDir, "sw.js"), "utf8"))?.[1] ?? "";
    const entry = /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(readFileSync(join(outDir, "index.html"), "utf8"))?.[0] ?? "";
    return { cache, entry };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe(`${BRAND.display} Mobile service-worker cache name`, () => {
  it("is the same for two builds of an unchanged tree", () => {
    const first = buildPhone();
    const second = buildPhone();
    expect(first.entry).not.toBe("");
    expect(first.cache).toMatch(/-[A-Za-z0-9_-]+$/);
    expect(first.cache).not.toContain("__APP_BUILD__");
    expect(second).toEqual(first);
  }, 180_000);
});
