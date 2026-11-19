import { expect, it } from "vitest";
// @ts-expect-error Node types are not included in this project.
import { readFileSync, writeFileSync } from "node:fs";
// @ts-expect-error Node types are not included in this project.
import process from "node:process";
import { settingsLinkTargets } from "../../components/layout/settingsIndex";
import { translate, type TranslationKey, type useT } from "../../lib/i18n";

const t = ((key: TranslationKey, params?: Record<string, string>) => translate("en", key, params)) as ReturnType<typeof useT>;

it("keeps agent help destinations aligned with the settings registry", () => {
  const file = "docs/help/settings-links.md";
  const targets = settingsLinkTargets(t);
  const text = [
    "---", "id: settings-links", "title: Links to settings and individual controls",
    "keywords: [settings, links, navigation, token, authentication, configuration, deep links]",
    "related: [settings-and-appearance, git, talking-to-an-agent]", "---", "",
    "Agents can use these destinations in Markdown answers. Clicking a link opens the desktop settings page, expands containing sections and highlights the control where available. Links never fill or change values. On the phone these destinations explain that desktop navigation is required.", "",
    "Search settings also offers Copy link beside each result. Prefer those links or the catalog below over guessing a destination. A removed control falls back to its containing page.", "",
    "<!-- Generated from settingsLinkTargets. Update with UPDATE_SETTINGS_LINKS=1 and the SettingsLinkCatalog test. -->", "",
    "| Page | Setting | Link |", "|---|---|---|",
    ...targets.map((target) => `| ${target.entry} | ${target.label.replace(/\|/g, "\\|")} | ${target.url} |`), "",
  ].join("\n");
  if (process.env.UPDATE_SETTINGS_LINKS === "1") writeFileSync(file, text);
  expect(readFileSync(file, "utf8").replaceAll("\r\n", "\n")).toBe(text);
});
