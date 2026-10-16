/**
 * The header's ? with nothing to open: it shows how to install an agent, both
 * ways — the cloud agent CLIs page first, the local models page one click
 * away — and "Ask the help agent" tries again once something is installed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { HelpAgentButton } from "../../components/header/HelpAgentButton";
import { __resetHelpAgentForTests } from "../../components/header/helpAgent";
import { en } from "../../lib/i18n";

const translate = (key: keyof typeof en) => en[key];

let claudeInstalled = false;

beforeEach(() => {
  __resetHelpAgentForTests();
  claudeInstalled = false;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "list_agents") {
      return Promise.resolve([
        { id: "claude", label: "Claude Code", bin: "claude", install_cmd: "npm i -g x", shell_kind: "sh", docs: "", installed: claudeInstalled },
      ]);
    }
    if (cmd === "root_mcp_status") return Promise.resolve({ help: { enabled: true, wiredClis: ["claude"] } });
    if (cmd === "list_ollama_models_detailed" || cmd === "probe_binaries") return Promise.resolve([]);
    return Promise.resolve(null);
  });
  useSettingsStore.setState({ settings: { default_agent_cmd: "claude" } as never });
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { root: [] },
    layoutByScope: { root: null },
    focusedGroupByScope: { root: null },
  });
  useRootOverlayStore.setState({ open: false, installTabs: {} });
});

describe("HelpAgentButton", () => {
  it("shows both install paths when there is no agent, and opens the agent once one is installed", async () => {
    render(<HelpAgentButton />);
    fireEvent.click(screen.getByRole("button", { name: translate("helpAgent.button") }));

    const dialog = await screen.findByRole("dialog", { name: translate("helpAgent.setup.title") });
    expect(dialog.textContent).toContain(translate("helpAgent.setup.cloudLead"));
    expect(useTabsStore.getState().tabsByScope.root).toHaveLength(0);

    fireEvent.click(screen.getAllByRole("button", { name: new RegExp(translate("helpAgent.setup.localTitle")) })[0]);
    expect(dialog.textContent).toContain(translate("helpAgent.setup.localLead"));

    claudeInstalled = true;
    fireEvent.click(screen.getByRole("button", { name: translate("helpAgent.setup.askAgain") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useTabsStore.getState().tabsByScope.root).toHaveLength(1);
    expect(useRootOverlayStore.getState().open).toBe(true);
  });
});
