import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockRejectedValue(new Error("Not available in this test")) }));
import { SettingsDialog } from "../../components/layout/SettingsPanel";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { en } from "../../lib/i18n";
import { AGENT_SCROLLBACK_ROWS } from "../../lib/terminal/scrollback";
import { dict as de } from "../../lib/i18n/de";
import { dict as es } from "../../lib/i18n/es";
import { dict as fr } from "../../lib/i18n/fr";
import { dict as it_ } from "../../lib/i18n/it";

// Settings → Power & performance → Shell scrollback (tab cost plan step 2):
// the help names the agents' fixed cap from `AGENT_SCROLLBACK_ROWS`, never a
// literal a translator copied, so the text cannot drift from the code.

describe("Shell scrollback help", () => {
  it("every language takes the agents' cap as a placeholder, not a literal", () => {
    for (const [lang, text] of [
      ["en", en["settings.shellScrollbackHelp"]],
      ["de", de["settings.shellScrollbackHelp"]],
      ["es", es["settings.shellScrollbackHelp"]],
      ["fr", fr["settings.shellScrollbackHelp"]],
      ["it", it_["settings.shellScrollbackHelp"]],
    ] as const) {
      expect(text, lang).toContain("{n}");
      expect(text, lang).not.toMatch(/\d/);
    }
  });

  it("renders the cap the code applies", async () => {
    useSettingsStore.setState({ settings: {} as Settings, updateSettings: vi.fn() } as never);
    await act(async () => {
      render(<SettingsDialog onClose={() => {}} />);
    });
    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    await act(async () => {
      fireEvent.click(within(nav).getByRole("button", { name: "Power & performance" }));
    });
    const help = screen.getByText(/Agent tabs always keep/);
    expect(help.textContent).toContain(`Agent tabs always keep ${AGENT_SCROLLBACK_ROWS.toLocaleString()} lines.`);
    expect(help.textContent).not.toContain("{n}");
  });
});
