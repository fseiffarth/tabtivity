/**
 * Regression lock for "Settings search does not find the Cockpit switch".
 *
 * Settings search finds a control only when its label key sits in
 * `SEARCH_INDEX` (`settingsIndex.ts`); nothing ties a new `ToggleCard` to that
 * list, so new switches (Cockpit, hands-free voice, the assistant, markup
 * auto-reload, …) shipped unfindable. This reads every labelled control in
 * `SettingsPanel.tsx` and the sub-panels the dialog renders, and searches for
 * its English label.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { translate, type TranslationKey, type useT } from "../../lib/i18n";
import { searchSettings } from "../../components/layout/settingsIndex";

/** The Settings dialog and the sub-panels it renders. A new sub-panel file
 *  goes here too. Left out on purpose: `RootMcpSecurity` (its rows sit in
 *  per-entry forms), `agentNotices` (inside each agent card's own fold) and
 *  `ServerSettings` (only the browser client renders it, mostly for admins). */
const PANELS = [
  "src/components/layout/SettingsPanel.tsx",
  "src/components/layout/UpdatesPanel.tsx",
  "src/components/layout/VoiceSettings.tsx",
  "src/components/settings/AgentAccounts.tsx",
  "src/components/settings/AgentCronSection.tsx",
  "src/components/settings/AgentFenceCard.tsx",
  "src/components/settings/ClaudeTokenRow.tsx",
  "src/components/settings/OllamaPanel.tsx",
  "src/components/agents/AppToolsSettings.tsx",
  "src/components/agents/CockpitMcpSettings.tsx",
  "src/components/agents/GitPushMcp.tsx",
  "src/components/agents/MarkupMcpSettings.tsx",
  "src/components/agents/AgentScheduleMcpSettings.tsx",
  "src/components/agents/PrintMcpSettings.tsx",
  "src/components/agents/TabsMcpSettings.tsx",
];

/** Rows search deliberately does not offer: status lines rather than settings,
 *  and rows inside a per-agent card's own fold (every card has one, so a path
 *  cannot name the right card). */
const NOT_SEARCHED = new Set<string>([
  "settings.voice.naturalMissing",
  "settings.voice.gpuCrashed",
  "settings.agentFencePlatformAccepted",
  "settings.codexAutoReview",
]);

/** The label keys of the panels' switches and rows (`label` as the first prop). */
const CONTROL_LABELS = [
  ...new Set(
    PANELS.flatMap((file) => [...(readFileSync(file, "utf8") as string).matchAll(/<(?:ToggleCard|ToggleRow|SettingRow)\s+label=\{(?:<>)?\{?t\("([^"]+)"/g)])
      .map((m) => m[1] as TranslationKey)
      .filter((key) => !NOT_SEARCHED.has(key)),
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
});
