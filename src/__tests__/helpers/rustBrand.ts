/**
 * Reads the backend brand module (`src-tauri/src/brand.rs`) so a test can hold
 * the frontend's copy of a name to it. The two sides are built separately, so
 * nothing but a test keeps a shared name — a protocol, a storage key, a
 * header — the same on both.
 */
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";

// vitest runs from the repo root, as the other source-reading tests assume.
const SOURCE: string = readFileSync("src-tauri/src/brand.rs", "utf8");

function macroLiteral(name: string): string {
  const m = new RegExp(`macro_rules! ${name} \\{\\s*\\(\\) => \\{\\s*"([^"]*)"`).exec(SOURCE);
  if (!m) throw new Error(`brand.rs no longer defines ${name}!()`);
  return m[1];
}

export interface RustBrand {
  /** Current names by constant, e.g. `TERMINAL_PROTOCOL`. */
  current: Record<string, string>;
  /** Old names by constant, e.g. `LEGACY_TERMINAL_PROTOCOL`. */
  legacy: Record<string, string>;
}

export function readRustBrand(): RustBrand {
  const forms = {
    current: { slug: macroLiteral("app_slug"), name: macroLiteral("app_name"), upper: macroLiteral("app_upper") },
    legacy: { slug: macroLiteral("legacy_slug"), name: macroLiteral("legacy_name"), upper: macroLiteral("legacy_upper") },
  };
  const out: RustBrand = { current: {}, legacy: {} };
  const row = /(\w+) \/ (LEGACY_\w+) = \[([^\]]*)\];/g;
  for (let m = row.exec(SOURCE); m; m = row.exec(SOURCE)) {
    const build = (f: { slug: string; name: string; upper: string }) => {
      let value = "";
      const part = /"((?:[^"\\]|\\.)*)"|\b(slug|name|upper)\b/g;
      for (let p = part.exec(m[3]); p; p = part.exec(m[3])) {
        value += p[2] ? f[p[2] as "slug" | "name" | "upper"] : p[1];
      }
      return value;
    };
    out.current[m[1]] = build(forms.current);
    out.legacy[m[2]] = build(forms.legacy);
  }
  if (Object.keys(out.current).length === 0) throw new Error("brand.rs: no names! table found");
  out.current.DISPLAY = forms.current.name;
  out.current.SLUG = forms.current.slug;
  out.current.UPPER = forms.current.upper;
  out.current.ENV_PREFIX = `${forms.current.upper}_`;
  out.legacy.LEGACY_DISPLAY = forms.legacy.name;
  out.legacy.LEGACY_SLUG = forms.legacy.slug;
  out.legacy.LEGACY_UPPER = forms.legacy.upper;
  out.legacy.LEGACY_ENV_PREFIX = `${forms.legacy.upper}_`;
  return out;
}
