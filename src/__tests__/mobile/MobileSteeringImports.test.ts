/**
 * Keyboard steering reaches the phone bundle, which has no Tauri and none of
 * the desktop's stores: walk every relative import from
 * `mobile-web/src/steering/*` (and what those pull in) and fail on either.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error node:fs has no type declarations
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
// @ts-expect-error node:path has no type declarations
import { dirname, join, relative, resolve, sep } from "node:path";

declare const process: { cwd(): string };

const ROOT: string = process.cwd();
const STEERING = join(ROOT, "mobile-web", "src", "steering");
const STORES = join(ROOT, "src", "stores") + sep;

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function resolveRelative(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every file reachable by relative imports from the steering folder, with the specifiers that name a forbidden module. */
function walkGraph(): { files: string[]; offenders: string[]; unresolved: string[] } {
  const queue: string[] = readdirSync(STEERING)
    .filter((name: string) => /\.tsx?$/.test(name))
    .map((name: string) => join(STEERING, name));
  const seen = new Set<string>();
  const offenders: string[] = [];
  const unresolved: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source: string = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (spec.startsWith("@tauri-apps")) offenders.push(`${relative(ROOT, file)} imports ${spec}`);
      if (!spec.startsWith(".")) continue;
      const target = resolveRelative(file, spec);
      if (target === null) {
        // CSS and other assets are not code; anything else must resolve.
        if (!/\.(css|svg|png|json)$/.test(spec)) unresolved.push(`${relative(ROOT, file)} -> ${spec}`);
        continue;
      }
      if (target.startsWith(STORES)) offenders.push(`${relative(ROOT, file)} imports ${relative(ROOT, target)}`);
      if (/\.tsx?$/.test(target)) queue.push(target);
    }
  }
  return { files: [...seen], offenders, unresolved };
}

describe("keyboard steering's import graph", () => {
  it("reaches no Tauri module and no desktop store", () => {
    const { files, offenders, unresolved } = walkGraph();
    expect(files.length).toBeGreaterThan(4);
    expect(unresolved).toEqual([]);
    expect(offenders).toEqual([]);
  });

  it("includes the shared key helpers, so the check is looking at the right graph", () => {
    const names = walkGraph().files.map((file) => relative(ROOT, file).split(sep).join("/"));
    expect(names).toContain("src/lib/shortcuts/keyNames.ts");
    expect(names).toContain("src/lib/shortcuts/steeringBindings.ts");
    expect(names).not.toContain("src/lib/shortcuts/shortcuts.ts");
  });
});
