/**
 * `src/styles/reset.css` is Tailwind 3.4.19's preflight, vendored when Tailwind
 * was removed (S5 of docs/vite8_vitest5_migration_plan.md). The table below was
 * captured ONCE from what Tailwind itself emitted for this repo, before the
 * removal, and frozen here — so the vendored copy is held to Tailwind's real
 * output, not to a re-reading of it. Every rule, in order, with every
 * declaration and its value; nothing missing, nothing added.
 *
 * Editing the reset on purpose is fine — then change this table with it and
 * say why in reset.css's header. The test is parsed with PostCSS (a direct
 * devDependency, pure JS), the same parser the table was captured with.
 */
import { describe, it, expect } from "vitest";
import postcss from "postcss";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";

// Tailwind 3.4.19's preflight as `@tailwind base` emitted it for this repo's
// tailwind.config.js (tailwindcss PostCSS plugin alone, before autoprefixer),
// captured 2026-10-14 from develop 5af871a9 (A5a). theme() values resolved
// as emitted. Rule order = source order. Selector = postcss `rule.selectors`
// joined with ", ". Dropped by design (S5 step 1): every --tw-* declaration
// and the rules they leave empty: *, ::before, ::after; ::backdrop; ::before, ::after.
const EXPECTED_PREFLIGHT: ReadonlyArray<{
  selector: string;
  declarations: ReadonlyArray<{ property: string; value: string }>;
}> = [
  { selector: "*, ::before, ::after", declarations: [
    { property: "box-sizing", value: "border-box" },
    { property: "border-width", value: "0" },
    { property: "border-style", value: "solid" },
    { property: "border-color", value: "#e5e7eb" },
  ] },
  { selector: "html, :host", declarations: [
    { property: "line-height", value: "1.5" },
    { property: "-webkit-text-size-adjust", value: "100%" },
    { property: "-moz-tab-size", value: "4" },
    { property: "tab-size", value: "4" },
    { property: "font-family", value: "ui-sans-serif, system-ui, sans-serif, \"Apple Color Emoji\", \"Segoe UI Emoji\", \"Segoe UI Symbol\", \"Noto Color Emoji\"" },
    { property: "font-feature-settings", value: "normal" },
    { property: "font-variation-settings", value: "normal" },
    { property: "-webkit-tap-highlight-color", value: "transparent" },
  ] },
  { selector: "body", declarations: [
    { property: "margin", value: "0" },
    { property: "line-height", value: "inherit" },
  ] },
  { selector: "hr", declarations: [
    { property: "height", value: "0" },
    { property: "color", value: "inherit" },
    { property: "border-top-width", value: "1px" },
  ] },
  { selector: "abbr:where([title])", declarations: [
    { property: "text-decoration", value: "underline dotted" },
  ] },
  { selector: "h1, h2, h3, h4, h5, h6", declarations: [
    { property: "font-size", value: "inherit" },
    { property: "font-weight", value: "inherit" },
  ] },
  { selector: "a", declarations: [
    { property: "color", value: "inherit" },
    { property: "text-decoration", value: "inherit" },
  ] },
  { selector: "b, strong", declarations: [
    { property: "font-weight", value: "bolder" },
  ] },
  { selector: "code, kbd, samp, pre", declarations: [
    { property: "font-family", value: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace" },
    { property: "font-feature-settings", value: "normal" },
    { property: "font-variation-settings", value: "normal" },
    { property: "font-size", value: "1em" },
  ] },
  { selector: "small", declarations: [
    { property: "font-size", value: "80%" },
  ] },
  { selector: "sub, sup", declarations: [
    { property: "font-size", value: "75%" },
    { property: "line-height", value: "0" },
    { property: "position", value: "relative" },
    { property: "vertical-align", value: "baseline" },
  ] },
  { selector: "sub", declarations: [
    { property: "bottom", value: "-0.25em" },
  ] },
  { selector: "sup", declarations: [
    { property: "top", value: "-0.5em" },
  ] },
  { selector: "table", declarations: [
    { property: "text-indent", value: "0" },
    { property: "border-color", value: "inherit" },
    { property: "border-collapse", value: "collapse" },
  ] },
  { selector: "button, input, optgroup, select, textarea", declarations: [
    { property: "font-family", value: "inherit" },
    { property: "font-feature-settings", value: "inherit" },
    { property: "font-variation-settings", value: "inherit" },
    { property: "font-size", value: "100%" },
    { property: "font-weight", value: "inherit" },
    { property: "line-height", value: "inherit" },
    { property: "letter-spacing", value: "inherit" },
    { property: "color", value: "inherit" },
    { property: "margin", value: "0" },
    { property: "padding", value: "0" },
  ] },
  { selector: "button, select", declarations: [
    { property: "text-transform", value: "none" },
  ] },
  { selector: "button, input:where([type='button']), input:where([type='reset']), input:where([type='submit'])", declarations: [
    { property: "-webkit-appearance", value: "button" },
    { property: "background-color", value: "transparent" },
    { property: "background-image", value: "none" },
  ] },
  { selector: ":-moz-focusring", declarations: [
    { property: "outline", value: "auto" },
  ] },
  { selector: ":-moz-ui-invalid", declarations: [
    { property: "box-shadow", value: "none" },
  ] },
  { selector: "progress", declarations: [
    { property: "vertical-align", value: "baseline" },
  ] },
  { selector: "::-webkit-inner-spin-button, ::-webkit-outer-spin-button", declarations: [
    { property: "height", value: "auto" },
  ] },
  { selector: "[type='search']", declarations: [
    { property: "-webkit-appearance", value: "textfield" },
    { property: "outline-offset", value: "-2px" },
  ] },
  { selector: "::-webkit-search-decoration", declarations: [
    { property: "-webkit-appearance", value: "none" },
  ] },
  { selector: "::-webkit-file-upload-button", declarations: [
    { property: "-webkit-appearance", value: "button" },
    { property: "font", value: "inherit" },
  ] },
  { selector: "summary", declarations: [
    { property: "display", value: "list-item" },
  ] },
  { selector: "blockquote, dl, dd, h1, h2, h3, h4, h5, h6, hr, figure, p, pre", declarations: [
    { property: "margin", value: "0" },
  ] },
  { selector: "fieldset", declarations: [
    { property: "margin", value: "0" },
    { property: "padding", value: "0" },
  ] },
  { selector: "legend", declarations: [
    { property: "padding", value: "0" },
  ] },
  { selector: "ol, ul, menu", declarations: [
    { property: "list-style", value: "none" },
    { property: "margin", value: "0" },
    { property: "padding", value: "0" },
  ] },
  { selector: "dialog", declarations: [
    { property: "padding", value: "0" },
  ] },
  { selector: "textarea", declarations: [
    { property: "resize", value: "vertical" },
  ] },
  { selector: "input::placeholder, textarea::placeholder", declarations: [
    { property: "opacity", value: "1" },
    { property: "color", value: "#9ca3af" },
  ] },
  { selector: "button, [role=\"button\"]", declarations: [
    { property: "cursor", value: "pointer" },
  ] },
  { selector: ":disabled", declarations: [
    { property: "cursor", value: "default" },
  ] },
  { selector: "img, svg, video, canvas, audio, iframe, embed, object", declarations: [
    { property: "display", value: "block" },
    { property: "vertical-align", value: "middle" },
  ] },
  { selector: "img, video", declarations: [
    { property: "max-width", value: "100%" },
    { property: "height", value: "auto" },
  ] },
  { selector: "[hidden]:where(:not([hidden=\"until-found\"]))", declarations: [
    { property: "display", value: "none" },
  ] },
];

const RESET: string = readFileSync("src/styles/reset.css", "utf8");

type Rule = { selector: string; declarations: Array<{ property: string; value: string }> };

function parsedRules(css: string): { rules: Rule[]; other: string[] } {
  const rules: Rule[] = [];
  const other: string[] = [];
  for (const node of postcss.parse(css).nodes) {
    if (node.type === "comment") continue;
    if (node.type !== "rule") {
      other.push(node.type === "atrule" ? `@${node.name} ${node.params}` : node.type);
      continue;
    }
    const declarations: Rule["declarations"] = [];
    for (const child of node.nodes) {
      if (child.type === "comment") continue;
      if (child.type !== "decl") {
        other.push(`${node.selector} > ${child.type}`);
        continue;
      }
      declarations.push({ property: child.prop, value: child.important ? `${child.value} !important` : child.value });
    }
    rules.push({ selector: node.selectors.join(", "), declarations });
  }
  return { rules, other };
}

describe("reset.css = Tailwind 3.4.19's preflight", () => {
  const { rules, other } = parsedRules(RESET);

  it("has exactly the captured rules and declarations, in order", () => {
    expect(rules).toEqual(EXPECTED_PREFLIGHT);
  });

  it("holds nothing else — no at-rules, no nested rules", () => {
    expect(other).toEqual([]);
  });

  it("keeps Tailwind's MIT notice", () => {
    expect(RESET).toContain("tailwindcss v3.4.19 | MIT License");
    expect(RESET).toContain("Copyright (c) Tailwind Labs, Inc.");
    expect(RESET).toContain("Permission is hereby granted, free of charge");
  });

  it("is the first stylesheet index.css imports, where @tailwind base used to emit it", () => {
    const index: string = readFileSync("src/styles/index.css", "utf8");
    const imports = [...index.matchAll(/@import "(.+?)";/g)].map((m) => m[1]);
    expect(imports[0]).toBe("./reset.css");
    expect(imports[1]).toBe("./base.css");
    expect(imports.filter((i) => i === "./reset.css")).toHaveLength(1);
  });
});
