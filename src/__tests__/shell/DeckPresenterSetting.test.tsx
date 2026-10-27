import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockRejectedValue(new Error("Not available in this test")) }));
import { SettingsDialog } from "../../components/layout/SettingsPanel";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { en } from "../../lib/i18n";
import { dict as de } from "../../lib/i18n/de";
import { dict as es } from "../../lib/i18n/es";
import { dict as fr } from "../../lib/i18n/fr";
import { dict as it_ } from "../../lib/i18n/it";

// Settings → Experimental after tab cost plan step 3: Debug mode no longer turns
// experiments on, so the deck presenter — which had no switch while Debug mode
// carried it — gets one, and the Debug toggle says what it does now.

async function openExperimental(settings: Partial<Settings>) {
  const updateSettings = vi.fn(async () => {});
  useSettingsStore.setState({ settings: settings as Settings, updateSettings } as never);
  await act(async () => {
    render(<SettingsDialog onClose={() => {}} />);
  });
  const nav = screen.getByRole("navigation", { name: "Settings categories" });
  await act(async () => {
    fireEvent.click(within(nav).getByRole("button", { name: en["settings.experimental"] }));
  });
  return updateSettings;
}

describe("Settings → Experimental", () => {
  it("offers a Deck presenter switch that writes the flag", async () => {
    const updateSettings = await openExperimental({ debug: true, experimental_explicit: true });
    const toggle = screen.getByRole("checkbox", { name: /Deck presenter/ }) as HTMLInputElement;
    // Marked profile, Debug on, flag unset: off.
    expect(toggle.checked).toBe(false);
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(updateSettings).toHaveBeenCalledWith({ deck_presenter: true });
  });

  it("shows the switch on for an unmarked Debug-mode profile, as before the migration", async () => {
    await openExperimental({ debug: true });
    const toggle = screen.getByRole("checkbox", { name: /Deck presenter/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it("says Debug mode turns no experiment on", async () => {
    await openExperimental({});
    expect(screen.getByText(en["settings.debugHelp"])).toBeTruthy();
  });

  it("no language still promises experiments on in debug mode", () => {
    for (const [lang, d] of [
      ["en", en],
      ["de", de],
      ["es", es],
      ["fr", fr],
      ["it", it_],
    ] as const) {
      const dict = d as Record<string, string | undefined>;
      expect(dict["settings.experimentalHelpBold"], lang).toBeUndefined();
      for (const key of [
        "settings.debugHelp",
        "settings.deckPresenter",
        "settings.deckPresenterHelp",
        "settings.experimentalHelp1",
        "settings.experimentalHelp2",
        "settings.experimentalHelp3",
      ]) {
        expect(dict[key], `${lang} ${key}`).toBeTruthy();
      }
      // The lesson no longer says the editor has no switch or rides debug builds.
      expect(dict["lessons.deckPresenter.exportFlagBody"], lang).not.toContain("deck_presenter");
    }
  });
});
