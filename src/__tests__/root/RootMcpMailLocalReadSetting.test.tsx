import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockRejectedValue(new Error("Not available in this test")) }));
import { SettingsDialog } from "../../components/layout/SettingsPanel";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { BRAND } from "../../lib/brand";

// Local-model mail reads (`Settings::root_mcp_mail_local_read`): the one way a
// root tab reads mail. The backend enforces it per request; these pin where the
// switch sits, when it can be flipped, and the one key it writes.

const updateSettings = vi.fn().mockResolvedValue(undefined);

function useSettings(settings: Partial<Settings>) {
  useSettingsStore.setState({ settings: settings as Settings, updateSettings } as never);
}

async function openRootConsolePage() {
  await act(async () => { render(<SettingsDialog onClose={() => {}} />); });
  const nav = screen.getByRole("navigation", { name: "Settings categories" });
  await act(async () => { fireEvent.click(within(nav).getByRole("button", { name: "Root console and MCPs" })); });
}

const mailLocalOnly = () => screen.getByRole("checkbox", { name: /Only local models get the mail tools/ }) as HTMLInputElement;
const localRead = () => screen.getByRole("checkbox", { name: /Local models may read the mails you share/ }) as HTMLInputElement;

beforeEach(() => {
  updateSettings.mockClear();
});

describe("mail tools: local models may read shared mails", () => {
  it("sits under the local-only switch, off and disabled while mail is off", async () => {
    useSettings({});
    await openRootConsolePage();
    const toggles = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(toggles.indexOf(localRead())).toBe(toggles.indexOf(mailLocalOnly()) + 1);
    expect(localRead().checked).toBe(false);
    expect(localRead().disabled).toBe(true);
  });

  it(`stays disabled while ${BRAND.display}'s tools are off, even with mail on`, async () => {
    useSettings({ root_mcp: false, root_mcp_mail: true });
    await openRootConsolePage();
    expect(localRead().disabled).toBe(true);
  });

  it("writes only its own key once mail is on", async () => {
    useSettings({ root_mcp_mail: true });
    await openRootConsolePage();
    expect(localRead().disabled).toBe(false);
    await act(async () => { fireEvent.click(localRead()); });
    expect(updateSettings).toHaveBeenCalledWith({ root_mcp_mail_local_read: true });
  });

  it("shows a stored true as on", async () => {
    useSettings({ root_mcp_mail: true, root_mcp_mail_local_read: true });
    await openRootConsolePage();
    expect(localRead().checked).toBe(true);
  });
});
