/**
 * The type-check gate (`docs/typescript7_plan.md`): `npm run build` and
 * `npm run mobile:build` type-check with TypeScript 7's native compiler, run by
 * path (`typescript-native`), while `typescript` 5.x stays installed for
 * typescript-eslint and editors. Nothing else in the build reads types, so a
 * build that silently stopped type-checking — a revert to a bare `tsc`, a flag
 * that skips checking, a tsconfig that matches nothing — would pass every
 * other gate.
 *
 * Each project is checked with the exact compiler and flags its package.json
 * script runs, through a scratch tsconfig that extends the real one and adds
 * one file with a planted error: the run must report that error (non-zero
 * exit) and no other, and its program must still hold the project's sources.
 * Nothing is written into the tree.
 */
// @ts-expect-error node:child_process has no type declarations in this project (no @types/node)
import { spawnSync } from "node:child_process";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error node:module has no type declarations in this project (no @types/node)
import { createRequire } from "node:module";
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
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8"));
const scripts = readJson(join(repoRoot, "package.json")).scripts as Record<string, string>;
const slashes = (path: string) => path.replace(/\\/g, "/");
const major = (version: string) => Number(version.split(".")[0]);

interface TypeCheck {
  /** The compiler's launcher, relative to the repo root. */
  compiler: string;
  /** The tsconfig the script checks. */
  project: string;
  /** The script's other flags, passed on unchanged. */
  flags: string[];
}

/** The one type-check step of a package.json script, as the script runs it. */
function typeCheckOf(name: string): TypeCheck {
  const steps = scripts[name].split("&&").map((step) => step.trim());
  const checks = steps.filter((step) => /(^|[\s/])tsc(\s|$)/.test(step));
  expect(checks, `"${name}" must run exactly one tsc step: ${scripts[name]}`).toHaveLength(1);
  const [runner, compiler, ...rest] = checks[0].split(/\s+/);
  // A bare `tsc` (or `npx tsc`) is whichever package owns node_modules/.bin/tsc,
  // which depends on how node_modules was installed — usually 5.9.
  expect(runner, `"${name}" must run the native compiler by path (node node_modules/<pkg>/bin/tsc), not "${checks[0]}"`).toBe("node");
  const owner = /^node_modules\/(.+)\/bin\/tsc$/.exec(compiler)?.[1];
  expect(owner, `"${name}" runs an unexpected compiler: ${compiler}`).toBeTruthy();
  const pkg = readJson(join(repoRoot, "node_modules", owner as string, "package.json"));
  expect(pkg.name, `${compiler} is not TypeScript's`).toBe("typescript");
  expect(major(String(pkg.version)), `${compiler} is TypeScript ${String(pkg.version)}, not the native 7+`).toBeGreaterThanOrEqual(7);
  const at = rest.findIndex((flag) => flag === "-p" || flag === "--project");
  const project = at < 0 ? "tsconfig.json" : rest[at + 1];
  const flags = at < 0 ? rest : [...rest.slice(0, at), ...rest.slice(at + 2)];
  return { compiler, project, flags };
}

/** `version` within an npm range of plain comparators (`>=a <b || ^c`). */
function satisfies(version: string, range: string): boolean {
  const [maj, min, pat] = version.split(/[.-]/).map(Number);
  const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const meets = (comparator: string): boolean => {
    const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+)\.(\d+)\.(\d+)$/.exec(comparator);
    if (!m) throw new Error(`range syntax this check does not know: "${comparator}" in "${range}"`);
    const want = [Number(m[2]), Number(m[3]), Number(m[4])];
    const c = cmp([maj, min, pat], want);
    switch (m[1]) {
      case ">=": return c >= 0;
      case "<=": return c <= 0;
      case ">": return c > 0;
      case "<": return c < 0;
      case "^": return c >= 0 && maj === want[0] && (want[0] > 0 || min === want[1]);
      case "~": return c >= 0 && maj === want[0] && min === want[1];
      default: return c === 0;
    }
  };
  return range.split("||").some((part) => part.trim().split(/\s+/).every(meets));
}

describe("the type-check gate", () => {
  it("build and mobile:build run the native TypeScript by path, and build runs mobile:build", () => {
    expect(typeCheckOf("build").project).toBe("tsconfig.json");
    expect(typeCheckOf("mobile:build").project).toBe("tsconfig.mobile.json");
    expect(scripts.build.split("&&").map((step) => step.trim())).toContain("npm run mobile:build");
  });

  it.each([
    ["build", "src/main.tsx"],
    ["mobile:build", "mobile-web/src/main.tsx"],
  ])("%s type-checks clean and fails on a planted error", (name, entry) => {
    const { compiler, project, flags } = typeCheckOf(name);
    const scratch: string = mkdtempSync(join(tmpdir(), `${BRAND.slug}-typecheck-`));
    try {
      const planted = join(scratch, "planted-type-error.ts");
      writeFileSync(planted, 'const planted: number = "not a number";\nexport { planted };\n');
      const config = join(scratch, "tsconfig.json");
      // `files` adds the planted file; `include` and every option are inherited.
      writeFileSync(config, JSON.stringify({ extends: join(repoRoot, project), files: [planted] }));
      const run = spawnSync(process.execPath, [join(repoRoot, compiler), "-p", config, "--pretty", "false", "--listFiles", ...flags], {
        cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      });
      expect(run.error, "the compiler did not start").toBeUndefined();
      const lines: string[] = `${run.stdout}\n${run.stderr}`.split(/\r?\n/).map(slashes);
      const errors = lines.filter((line) => /\berror TS\d+:/.test(line));
      const isPlanted = (line: string) => line.includes("planted-type-error.ts");
      expect(errors.filter((line) => !isPlanted(line)), `${project} no longer type-checks clean`).toEqual([]);
      expect(errors.filter(isPlanted), "the planted error went unreported").toEqual([
        expect.stringMatching(/planted-type-error\.ts\(1,7\): error TS2322:/),
      ]);
      expect(run.status, "a type error must fail the step").not.toBe(0);
      // The scratch config still checks the project itself, not just the planted file.
      expect(lines.includes(slashes(join(repoRoot, entry))), `${project}'s program no longer holds ${entry}: does its include still cover it?`).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);

  it("leaves typescript-eslint a TypeScript in its peer range", () => {
    // The range check itself can say no.
    expect([satisfies("5.9.3", ">=4.8.4 <6.1.0"), satisfies("6.1.0", ">=4.8.4 <6.1.0"), satisfies("7.0.2", "^5.0.0 || ^7.0.0")]).toEqual([true, false, true]);
    const dependents = [
      join(repoRoot, "node_modules", "typescript-eslint"),
      ...readdirSync(join(repoRoot, "node_modules", "@typescript-eslint")).map((dir: string) => join(repoRoot, "node_modules", "@typescript-eslint", dir)),
    ];
    let checked = 0;
    for (const dir of dependents) {
      const manifest = join(dir, "package.json");
      const pkg = readJson(manifest);
      const range = (pkg.peerDependencies as Record<string, string> | undefined)?.typescript;
      if (!range) continue;
      // The `typescript` this package actually loads, resolved from where it sits.
      const typescript: string = createRequire(manifest).resolve("typescript/package.json");
      const version = String(readJson(typescript).version);
      expect(satisfies(version, range), `${String(pkg.name)} needs typescript ${range}, loads ${version} (${typescript})`).toBe(true);
      checked += 1;
    }
    expect(checked, "no typescript-eslint package declares a typescript peer").toBeGreaterThan(0);
  });
});
