import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockRejectedValue(new Error("Not available in this test")) }));
import { SettingsDialog } from "../../components/layout/SettingsPanel";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { BRAND } from "../../lib/brand";

// The mail tools' local-only companion (`Settings::root_mcp_mail_local_only`):
// a switch under "Agents get Tabtivity's mail tools" that the backend enforces
// per request. These pin the Settings side of it: where it sits, when it can
// be flipped, and the one key it writes.

const updateSettings = vi.fn().mockResolvedValue(undefined);

function useSettings(settings: Partial<Settings>) {
  useSettingsStore.setState({ settings: settings as Settings, updateSettings } as never);
}

async function openRootConsolePage() {
  await act(async () => { render(<SettingsDialog onClose={() => {}} />); });
  const nav = screen.getByRole("navigation", { name: "Settings categories" });
  await act(async () => { fireEvent.click(within(nav).getByRole("button", { name: "Root console and MCPs" })); });
  expect(document.getElementById("settings-anchor-rootConsole")).toBeTruthy();
}

const mailSwitch = () => screen.getByRole("checkbox", { name: new RegExp(String.raw`Agents get ${BRAND.display}'s mail tools`) }) as HTMLInputElement;
const mailLocalOnly = () => screen.getByRole("checkbox", { name: /Only local models get the mail tools/ }) as HTMLInputElement;

beforeEach(() => {
  updateSettings.mockClear();
});

describe("mail tools: local models only", () => {
  it("sits right under the mail switch, off and disabled while mail is off", async () => {
    useSettings({});
    await openRootConsolePage();
    const toggles = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(toggles.indexOf(mailLocalOnly())).toBe(toggles.indexOf(mailSwitch()) + 1);
    // Absent means off, and mail itself starts off, so there is nothing to narrow.
    expect(mailLocalOnly().checked).toBe(false);
    expect(mailLocalOnly().disabled).toBe(true);
  });

  it("is enabled once mail is on and writes only its own key", async () => {
    useSettings({ root_mcp_mail: true });
    await openRootConsolePage();
    expect(mailLocalOnly().disabled).toBe(false);
    await act(async () => { fireEvent.click(mailLocalOnly()); });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ root_mcp_mail_local_only: true });
  });

  it("shows a stored true as on and clears it with an explicit false", async () => {
    useSettings({ root_mcp_mail: true, root_mcp_mail_local_only: true });
    await openRootConsolePage();
    expect(mailLocalOnly().checked).toBe(true);
    await act(async () => { fireEvent.click(mailLocalOnly()); });
    expect(updateSettings).toHaveBeenCalledWith({ root_mcp_mail_local_only: false });
  });

  it("stays independent of the endpoint-wide local-only switch", async () => {
    useSettings({ root_mcp_mail: true, root_mcp_local_only: true });
    await openRootConsolePage();
    const everyTool = screen.getByRole("checkbox", { name: /Only local models get these tools/ }) as HTMLInputElement;
    expect(everyTool.checked).toBe(true);
    // The endpoint-wide switch does not tick the mail one for it.
    expect(mailLocalOnly().checked).toBe(false);
    expect(mailLocalOnly().disabled).toBe(false);
  });

  it("is disabled, keeping its stored value, while the tools are switched off", async () => {
    useSettings({ root_mcp: false, root_mcp_mail: true, root_mcp_mail_local_only: true });
    await openRootConsolePage();
    expect(mailLocalOnly().disabled).toBe(true);
    expect(mailLocalOnly().checked).toBe(true);
  });

  it("is found by the settings search", async () => {
    useSettings({});
    await act(async () => { render(<SettingsDialog onClose={() => {}} />); });
    // A page shows at most three matching labels; these words keep the root
    // console's to the two local-only switches and the mail one.
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings…" }), { target: { value: "local models mail" } });
    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    const hits = within(nav).getAllByRole("button").map((b) => b.textContent ?? "");
    expect(hits.some((h) => h.includes("Only local models get the mail tools"))).toBe(true);
  });
});
