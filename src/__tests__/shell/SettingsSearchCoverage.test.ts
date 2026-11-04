/**
 * Regression lock for "Settings search does not find the Cockpit switch".
 *
 * Settings search finds a control only when its label key sits in
 * `SEARCH_INDEX` (`settingsIndex.ts`); nothing ties a new `ToggleCard` to that
 * list, so new switches (Cockpit, hands-free voice, the assistant, markup
 * auto-reload, …) shipped unfindable. This reads every labelled control in
 * `SettingsPanel.tsx` and searches for its English label.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { translate, type TranslationKey, type useT } from "../../lib/i18n";
import { searchSettings } from "../../components/layout/settingsIndex";

const PANEL: string = readFileSync("src/components/layout/SettingsPanel.tsx", "utf8");

/** The label keys of the panel's switches and rows (`label` as the first prop). */
const CONTROL_LABELS = [
  ...new Set(
    [...PANEL.matchAll(/<(?:ToggleCard|ToggleRow|SettingRow)\s+label=\{(?:<>)?\{?t\("([^"]+)"/g)].map((m) => m[1] as TranslationKey),
  ),
];

const t = ((key: TranslationKey, params?: Record<string, string>) => translate("en", key, params)) as ReturnType<typeof useT>;

describe("Settings search covers every control", () => {
  it("reads the panel's controls", () => {
    expect(CONTROL_LABELS.length).toBeGreaterThan(40);
  });

  it.each(CONTROL_LABELS)("finds %s by its label", (key) => {
    const label = t(key);
    const hit = searchSettings(label, t, () => true).find((r) => r.label === label && r.path);
    expect(hit, `add "${key}" to SEARCH_INDEX in settingsIndex.ts`).toBeDefined();
  });

  it("finds the cockpit by another word for it", () => {
    const hit = searchSettings("dashboard", t, () => true).find((r) => r.label === t("settings.cockpit"));
    expect(hit?.page).toBe("settings-anchor-experimental");
  });
});
