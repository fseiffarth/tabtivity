import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}), emit: vi.fn(() => Promise.resolve()) }));

import { VoiceSettings } from "../../components/layout/VoiceSettings";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

// Settings → Voice: the candidate languages `detect` picks among
// (docs/voice_language_detection_plan.md, D2).

function box(name: string) {
  return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

describe("the detect candidates in Settings → Voice", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((command: string, args?: { patch?: Partial<Settings> }) => {
      if (command === "voice_status") return Promise.reject("not-built");
      if (command === "patch_settings") return Promise.resolve({ ...useSettingsStore.getState().settings, ...args?.patch });
      return Promise.resolve(null);
    });
  });
  afterEach(() => useSettingsStore.setState({ settings: null, loaded: false }));

  const open = async (settings: Partial<Settings>) => {
    useSettingsStore.setState({ settings: settings as Settings, loaded: true });
    await act(async () => {
      render(<VoiceSettings />);
    });
  };

  it("offers no checkboxes until the model is asked to pick", async () => {
    await open({ voice_lang: "de" });
    expect(screen.queryByRole("checkbox", { name: "English" })).toBeNull();
  });

  it("ticks the UI language and English by default, and saves a change as app languages in order", async () => {
    await open({ voice_lang: "detect" });
    expect(box("English").checked).toBe(true);
    expect(box("Deutsch").checked).toBe(false);
    await act(async () => {
      fireEvent.click(box("Deutsch"));
    });
    expect(invoke).toHaveBeenCalledWith("patch_settings", { patch: { voice_detect_langs: ["en", "de"] } });
  });

  it("never lets the last candidate go", async () => {
    await open({ voice_lang: "detect", voice_detect_langs: ["fr"] });
    expect(box("Français").disabled).toBe(true);
  });
});
