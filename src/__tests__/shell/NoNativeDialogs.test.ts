/**
 * No browser-native `confirm` / `prompt` / `alert` in the app (fixed decision
 * #5 of docs/screen_2026_10_15_medium_plan.md). WebKitGTK draws them as a bare
 * box headed with the page origin ("localhost:1420 says"), themeless and
 * blocking; the desktop asks through `useDialogs()` (`PromptDialogs`), the
 * phone through its own sheets (`ConfirmSheet` / `NameSheet` / `OptionSheet`).
 *
 * Two kinds of call are caught, comments and quoted strings stripped:
 *  - `window.confirm(…)` (and `globalThis.`/`self.`), always;
 *  - a bare `confirm(…)` / `prompt(…)` / `alert(…)` in a file that binds no
 *    such name itself — an import (`@tauri-apps/plugin-dialog`'s `confirm` is
 *    the app's own native-dialog plugin, not the browser's), a local function,
 *    a destructured prop or parameter.
 *
 * Exempt: `src/lib/transport/dialogAdapter.ts`, the browser client's stand-in
 * for the dialog plugin, which has nothing else to fall back to.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync, readdirSync } from "node:fs";

type Entry = { name: string; isDirectory: () => boolean };

const EXEMPT = new Set(["src/lib/transport/dialogAdapter.ts"]);

/** Bare `alert(` calls a later step owns: `ProjectPill.tsx`'s in-folder layout
 *  block is rewritten by step M3 of the same plan, which turns its two alerts
 *  into a `PromptDialogs` message and must drop this entry with them. */
const PENDING: Record<string, number> = { "src/components/projects/ProjectPill.tsx": 2 };

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }) as Entry[]) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Comments and quoted strings out, in one left-to-right pass so a `//` in a
 *  string (a URL) and a quote in a comment each stay what they are. What is
 *  left is code: a dictionary's "prompt(s)" is text, not a call. */
function codeOnly(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/.*$|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/gm,
    (token) => (token.startsWith("/") ? "" : '""'),
  );
}

/** Whether the file binds `name` itself, so a bare call is not the global. */
function bindsName(code: string, name: string): boolean {
  return new RegExp(
    String.raw`import\s*\{[^}]*\b${name}\b[^}]*\}\s*from` + // import { confirm } from …
      String.raw`|\b(?:const|let|var|function)\s+${name}\b` + // a local
      String.raw`|[({,]\s*${name}\s*[,}:)=]`, // a destructured prop / parameter
  ).test(code);
}

/** Every native-dialog call left in one file's source. */
function nativeDialogCalls(source: string): string[] {
  const code = codeOnly(source);
  const found: string[] = [];
  for (const m of code.matchAll(/\b(?:window|globalThis|self)\s*\.\s*(confirm|prompt|alert)\s*\(/g)) {
    found.push(m[0].replace(/\s+/g, ""));
  }
  for (const name of ["confirm", "prompt", "alert"]) {
    if (bindsName(code, name)) continue;
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$]|\.\s*)${name}\s*\(`, "g"))) {
      found.push(m[0].replace(/\s+/g, ""));
    }
  }
  return found;
}

describe("no native browser dialogs", () => {
  const files = [...sourceFiles("src"), ...sourceFiles("mobile-web/src")];

  it("finds the sources it guards", () => {
    // An empty walk would pass vacuously.
    expect(files).toContain("src/components/common/PromptDialogs.tsx");
    expect(files).toContain("mobile-web/src/components/ConfirmSheet.tsx");
    expect(files).toContain("mobile-web/src/api.ts");
    expect(files.some((f) => f.includes("__tests__"))).toBe(false);
  });

  it("the scan catches each shape it is meant to", () => {
    expect(nativeDialogCalls(`if (!window.confirm("x")) return;`)).toEqual(["window.confirm("]);
    expect(nativeDialogCalls(`const n = window . prompt("x");`)).toEqual(["window.prompt("]);
    expect(nativeDialogCalls(`globalThis.alert("x")`)).toEqual(["globalThis.alert("]);
    expect(nativeDialogCalls(`function f() { alert("x"); }`)).toEqual(["alert("]);
    expect(nativeDialogCalls(`const ok = confirm("sure?");`)).toEqual(["confirm("]);
    // Bound names, method calls and comments are not the global.
    expect(nativeDialogCalls(`import { confirm } from "@tauri-apps/plugin-dialog";\nawait confirm("x");`)).toEqual([]);
    expect(nativeDialogCalls(`const confirm = () => {};\nconfirm();`)).toEqual([]);
    expect(nativeDialogCalls(`function Row({ confirm, busy }: P) { confirm({}); }`)).toEqual([]);
    expect(nativeDialogCalls(`await roundUndo.confirm();`)).toEqual([]);
    expect(nativeDialogCalls(`// used to call window.confirm()\n/* alert("x") */`)).toEqual([]);
    expect(nativeDialogCalls(`const url = "https://x"; window.alert(url);`)).toEqual(["window.alert("]);
    expect(nativeDialogCalls(`const s = "{count} prompt(s) waiting";`)).toEqual([]);
  });

  it("no source outside tests calls window.confirm / prompt / alert", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (EXEMPT.has(file)) continue;
      const calls = nativeDialogCalls(readFileSync(file, "utf8") as string);
      const pending = PENDING[file] ?? 0;
      if (calls.length > pending || calls.some((c) => c !== "alert(" && pending > 0)) {
        offenders.push(`${file}: ${calls.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the pending exemption is still needed", () => {
    // Once the owning step has replaced them, the entry must go too, or it
    // would quietly let new alerts back into that file.
    for (const [file, count] of Object.entries(PENDING)) {
      expect(nativeDialogCalls(readFileSync(file, "utf8") as string)).toHaveLength(count);
    }
  });
});
