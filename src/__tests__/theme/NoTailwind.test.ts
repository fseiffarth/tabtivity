/**
 * Tailwind is gone (S5 of docs/vite8_vitest5_migration_plan.md): the app styles
 * itself with its own classes, and the one thing Tailwind gave it — the
 * preflight reset — is vendored in `src/styles/reset.css`. Tailwind 3's
 * directives and functions would now reach the browser unprocessed (an
 * `@apply` or `theme()` is simply dropped as invalid CSS), and a `--tw-*`
 * variable has nothing left to define it, so none of them may come back
 * silently — and neither may the package or its PostCSS plugin.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { existsSync, readFileSync, readdirSync } from "node:fs";

type Entry = { name: string; isDirectory: () => boolean };

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }) as Entry[]) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) cssFiles(full, out);
    else if (entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

/** Tailwind syntax left in a stylesheet, comments stripped (reset.css's header names it). */
function tailwindSyntax(css: string): string[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: string[] = [];
  for (const [label, re] of [
    ["@tailwind", /@tailwind\b/],
    ["@apply", /@apply\b/],
    ["@config", /@config\b/],
    ["theme(", /(?<![\w-])theme\(/],
    ["screen(", /(?<![\w-])screen\(/],
    ["--tw-", /--tw-/],
  ] as const) {
    if (re.test(code)) found.push(label);
  }
  return found;
}

describe("no Tailwind", () => {
  const files = [...cssFiles("src"), ...cssFiles("mobile-web/src")];

  it("finds the stylesheets it guards", () => {
    // An empty walk would pass vacuously.
    expect(files).toContain("src/styles/reset.css");
    expect(files).toContain("src/styles/base.css");
    expect(files).toContain("mobile-web/src/style.css");
  });

  it("no stylesheet uses a Tailwind directive, function or --tw- variable", () => {
    const offenders = files
      .map((f) => [f, tailwindSyntax(readFileSync(f, "utf8") as string)] as const)
      .filter(([, found]) => found.length > 0)
      .map(([f, found]) => `${f}: ${found.join(", ")}`);
    expect(offenders).toEqual([]);
  });

  it("package.json has no Tailwind package", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8") as string) as Record<string, unknown>;
    const names = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((k) =>
      Object.keys((pkg[k] as Record<string, string> | undefined) ?? {}),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => n === "tailwindcss" || n.startsWith("@tailwindcss/"))).toEqual([]);
  });

  it("there is no Tailwind config, and PostCSS loads no Tailwind plugin", () => {
    const configs = ["js", "cjs", "mjs", "ts", "cts", "mts"]
      .map((ext) => `tailwind.config.${ext}`)
      .filter((f) => existsSync(f));
    expect(configs).toEqual([]);
    const postcssConfig: string = readFileSync("postcss.config.js", "utf8");
    expect(postcssConfig).toContain("autoprefixer");
    expect(postcssConfig).not.toMatch(/tailwind/i);
  });
});
