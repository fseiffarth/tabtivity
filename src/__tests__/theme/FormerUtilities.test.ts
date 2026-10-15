/**
 * With Tailwind removed (S5 of docs/vite8_vitest5_migration_plan.md), a class
 * named like one of its utilities no longer styles anything by itself. These
 * are the 54 utility selectors Tailwind 3's content scanner emitted for this
 * repo before the removal. When it went, none of them was relied on (S5's
 * triage); the two the app does use, `inline` and `static`, were collisions
 * its own rules already overrode.
 *
 * So the rule now: every class token in app code (`className`/`class`
 * attributes, class-named props and variables, `classList` calls,
 * `.className =`, `setAttribute("class", …)`, `class="…"` in HTML strings)
 * that carries one of these names must have a rule of its own in our CSS —
 * a selector where the class stands alone in its compound (`.truncate`,
 * `.list .truncate:hover`) — or be a known collision below. That catches a
 * missed re-homing and anyone later writing `className="truncate"` expecting
 * Tailwind to style it.
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync, readdirSync } from "node:fs";
import { readAppStylesheet } from "../helpers/cssCorpus";

const FORMER_UTILITIES = [
  "container", "visible", "invisible", "collapse", "static", "fixed", "absolute", "relative", "sticky",
  "isolate", "m-1", "block", "inline-block", "inline", "flex", "table", "table-cell", "table-row", "grid",
  "contents", "list-item", "hidden", "w-1", "w-2", "w-7", "shrink", "grow", "border-collapse", "transform",
  "select-all", "resize", "flex-wrap", "overflow-scroll", "truncate", "break-all", "rounded", "border",
  "pr-1", "uppercase", "lowercase", "italic", "ordinal", "underline", "line-through", "shadow", "outline",
  "ring", "blur", "grayscale", "invert", "filter", "backdrop-filter", "transition", "[path:line]",
] as const;
const NAMES = new Set<string>(FORMER_UTILITIES);

/**
 * Collisions: the app uses the name as a modifier under its own compound
 * selector, never for what Tailwind's utility did. Each entry lists the only
 * files allowed to use it and the compound rule that gives it its meaning. A
 * use anywhere else fails — it may be someone expecting the utility.
 */
const KNOWN_COLLISIONS: Record<string, { files: string[]; selector: string }> = {
  // BoxScopeChip passes `className="inline"` to PillStatusBars (root row of the
  // box chip menu). Tailwind's `.inline{display:inline}` lost to the later
  // `.pill-status-bars{display:flex}` (equal specificity), so it never applied.
  inline: { files: ["src/components/projects/BoxScopeChip.tsx"], selector: ".pill-status-bars.inline" },
  // PillStatusBars marks non-interactive bars `static`. Tailwind's
  // `.static{position:static}` lost to the later `.pill-status-bar{position:relative}`.
  static: { files: ["src/components/projects/PillStatusBars.tsx"], selector: ".pill-status-bar.static" },
};

type Entry = { name: string; isDirectory: () => boolean };

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }) as Entry[]) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") sourceFiles(full, out);
    } else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(entry.name) && !/\.d\.ts$|\.(test|spec)\.[jt]sx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const CLASS_KEY = /^class(Name|Names|es)?$|ClassName$/;
const CLASS_VAR = /class|^cls$|Cls$/i;

/** Whether a string/template node sits where its text becomes an element's class list. */
function inClassContext(node: ts.Node): boolean {
  let cur: ts.Node = node;
  for (let p = node.parent; p; cur = p, p = p.parent) {
    if (ts.isJsxAttribute(p)) return /^class(Name)?$/.test(p.name.getText());
    if (ts.isPropertyAssignment(p)) return cur === p.initializer && CLASS_KEY.test(p.name.getText());
    if (ts.isVariableDeclaration(p)) return cur === p.initializer && CLASS_VAR.test(p.name.getText());
    if (ts.isBinaryExpression(p) && ts.isPropertyAccessExpression(p.left) && cur === p.right) {
      const op = p.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.PlusEqualsToken) return p.left.name.text === "className";
    }
    if (ts.isCallExpression(p)) {
      if (cur === p.expression) return false;
      const callee = p.expression.getText();
      if (/\.classList\.(add|remove|toggle|replace|contains)$/.test(callee)) return true;
      if (/\.setAttribute$/.test(callee)) {
        const first = p.arguments[0];
        return !!first && ts.isStringLiteral(first) && first.text === "class" && cur === p.arguments[1];
      }
      if (/^(clsx|cn|cx|classNames)$/.test(callee)) continue;
      // `[a, b].join(" ")` and friends: look through the array's method call.
      if (ts.isPropertyAccessExpression(p.expression) && /^(join|concat|trim|filter)$/.test(p.expression.name.text)) continue;
      return false;
    }
    if (ts.isPropertyAccessExpression(p) && cur === p.expression) continue;
    if (
      ts.isParenthesizedExpression(p) || ts.isConditionalExpression(p) || ts.isBinaryExpression(p) ||
      ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isArrayLiteralExpression(p) ||
      ts.isJsxExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSpreadElement(p) ||
      ts.isSatisfiesExpression(p)
    ) continue;
    return false;
  }
  return false;
}

type Use = { name: string; site: string };

/** Whole whitespace-delimited tokens of `text`; `open*` = the chunk touches a `${…}` there. */
function tokens(text: string, openLeft = false, openRight = false): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const start = m.index ?? 0;
    if (openLeft && start === 0) continue;
    if (openRight && start + m[0].length === text.length) continue;
    out.push(m[0]);
  }
  return out;
}

const HTML_CLASS = /\bclass\s*=\s*\\?["']([^"'\\$]*)/g;

function scanFile(file: string, uses: Use[]): void {
  const text: string = readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".jsx") ? ts.ScriptKind.JSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const add = (node: ts.Node, toks: string[]) => {
    for (const name of toks) {
      if (!NAMES.has(name)) continue;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      uses.push({ name, site: `${file}:${line}` });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (inClassContext(node)) add(node, tokens(node.text));
      for (const m of node.text.matchAll(HTML_CLASS)) add(node, tokens(m[1]));
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const template = ts.isTemplateHead(node) ? node.parent : node.parent.parent;
      const raw = node.text;
      if (inClassContext(template)) {
        add(node, tokens(raw, !ts.isTemplateHead(node) && !/^\s/.test(raw), !ts.isTemplateTail(node) && !/\s$/.test(raw)));
      }
      for (const m of raw.matchAll(HTML_CLASS)) add(node, tokens(m[1]));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function scanApp(): { files: number; uses: Use[] } {
  const files = sourceFiles("src");
  const uses: Use[] = [];
  for (const f of files) scanFile(f, uses);
  const html: string = readFileSync("index.html", "utf8");
  html.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\bclass\s*=\s*["']([^"']*)["']/g)) {
      for (const name of tokens(m[1])) if (NAMES.has(name)) uses.push({ name, site: `index.html:${i + 1}` });
    }
  });
  return { files: files.length, uses };
}

const CSS = [
  readAppStylesheet(),
  readFileSync("src/components/files/QuickOpen.css", "utf8") as string,
  readFileSync("src/components/embed/ImageAnnotator.css", "utf8") as string,
  readFileSync("src/dev/devPerf.css", "utf8") as string,
]
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Every selector of every rule (comma-split), at-rule preludes skipped. */
const SELECTORS: string[] = [...CSS.matchAll(/([^{}@;]+)\{/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()));

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The class as CSS source spells it: `[path:line]` → `\[path\:line\]`. */
const cssClass = (name: string) => "." + name.replace(/[\\[\]:!]/g, "\\$&");

/** A selector where `.name` is the only class/attribute/id in its compound. */
function hasStandaloneRule(name: string): boolean {
  const re = new RegExp(`(^|[\\s>+~(])${escapeRegExp(cssClass(name))}(?![\\w\\\\.#[-])`);
  return SELECTORS.some((s) => re.test(s));
}

describe("former Tailwind utility names", () => {
  const { files, uses } = scanApp();

  it("escapes CSS punctuation and existing backslashes", () => {
    expect(cssClass("[path:line]")).toBe(".\\[path\\:line\\]");
    expect(cssClass("a\\:b!")).toBe(".a\\\\\\:b\\!");
  });

  it("scans the app's sources", () => {
    expect(files).toBeGreaterThan(500);
  });

  it("every utility-named class the app uses has a rule of its own, or is a known collision", () => {
    const offenders = uses
      .filter(({ name, site }) => {
        const known = KNOWN_COLLISIONS[name];
        if (known) return !known.files.some((f) => site.startsWith(`${f}:`));
        return !hasStandaloneRule(name);
      })
      .map(({ name, site }) => `${name} at ${site}`);
    expect(offenders).toEqual([]);
  });

  it("each known collision is still used, and its compound rule still exists", () => {
    for (const [name, { files: allowed, selector }] of Object.entries(KNOWN_COLLISIONS)) {
      expect(uses.filter((u) => u.name === name).map((u) => u.site.replace(/:\d+$/, "")), name).toEqual(
        expect.arrayContaining(allowed),
      );
      const compound = new RegExp(`(^|[\\s>+~(])${escapeRegExp(selector)}(?![\\w\\\\.#[-])`);
      expect(SELECTORS.some((s) => compound.test(s)), selector).toBe(true);
    }
  });
});
