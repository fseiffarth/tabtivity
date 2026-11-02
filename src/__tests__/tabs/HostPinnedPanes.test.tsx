/**
 * Tabs and panes of a host-pinned project (a VM or remote-only project,
 * `isHostPinned`; `docs/remote_only_projects_plan.md` F6/F7): the "+" menu
 * offers no row that starts on this machine, and while the host is down every
 * pane holds on the Connect placeholder — the Files tab included, which on a
 * plain remote project browses the mirror offline.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

// The derivation is what is under test: a stand-in records what PaneSlot hands
// the shared render switch.
const lastProps = new Map<string, Record<string, unknown>>();
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: { tab: { key: string } }) => {
    lastProps.set(props.tab.key, props as unknown as Record<string, unknown>);
    return <div data-testid={`pane-${props.tab.key}`} />;
  },
}));

import { NewTabMenu } from "../../components/tabs/NewTabMenu";
import { PaneSlot } from "../../components/layout/PaneSlot";
import { translateNow } from "../../lib/i18n";
import type { TabEntry } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";

beforeEach(() => {
  vi.clearAllMocks();
  lastProps.clear();
  Element.prototype.scrollIntoView = vi.fn();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_agents") return Promise.resolve([{ id: "claude", bin: "claude", installed: true }]);
    // A key saved for Claude's provider: the API section has a row to offer.
    if (cmd === "agent_logins") return Promise.resolve([{ id: "claude", api_key_saved: true }]);
    return Promise.resolve(null);
  });
});
afterEach(() => cleanup());

function renderMenu(hostPinned: boolean) {
  return render(
    <NewTabMenu
      scope="p1"
      projectCwd="/state/p1"
      projectName=""
      anchor={{ x: 0, y: 0 }}
      onPick={vi.fn()}
      onClose={vi.fn()}
      onManageAgents={vi.fn()}
      hostPinned={hostPinned}
    />,
  );
}

const groupLabels = () =>
  [...document.querySelectorAll(".tab-new-menu-group-label")].map((el) => el.textContent ?? "");

describe("the popout's + menu on a host-pinned scope", () => {
  it("offers the local-model, API-key and Cloud rows on an ordinary project", async () => {
    renderMenu(false);
    await waitFor(() => expect(groupLabels()).toContain(translateNow("newTabMenu.groupApiKey")));
    expect(groupLabels()).toContain(translateNow("newTabMenu.groupLocalModel"));
    expect(document.body.textContent).toContain(translateNow("newTabMenu.cloudSession"));
  });

  it("drops all three on a pinned one, and keeps Agents and Shell", async () => {
    renderMenu(true);
    await waitFor(() => expect(screen.getByRole("button", { name: /Claude/ })).toBeTruthy());
    expect(groupLabels()).toContain(translateNow("newTabMenu.groupAgents"));
    expect(groupLabels()).toContain(translateNow("newTabMenu.groupShell"));
    expect(groupLabels()).not.toContain(translateNow("newTabMenu.groupApiKey"));
    expect(groupLabels()).not.toContain(translateNow("newTabMenu.groupLocalModel"));
    expect(document.body.textContent).not.toContain(translateNow("newTabMenu.cloudSession"));
    // Nothing probes the API keys or the local model for a menu that offers neither.
    expect(mockInvoke).not.toHaveBeenCalledWith("agent_logins");
    expect(mockInvoke).not.toHaveBeenCalledWith("list_ollama_models_detailed");
  });
});

const remote = { host: "h.invalid", remote_path: "/srv/p" };
const project = (pinned: boolean): ProjectEntry =>
  ({
    id: "p1",
    name: "P",
    directory: "/state/p1",
    local_file: "/state/p1/project.json",
    remote: { ...remote, ...(pinned ? { remote_only: true } : {}) },
  }) as unknown as ProjectEntry;

const tabOf = (key: string, kind: TabEntry["kind"], extra: Partial<TabEntry> = {}): TabEntry =>
  ({ key, label: key, cmd: kind === "agent" ? "claude" : "", cwd: "/state/p1", kind, ...extra }) as TabEntry;

function renderSlot(tab: TabEntry, pinned: boolean, ssh: "connected" | "error") {
  act(() => {
    render(
      <PaneSlot
        tab={tab}
        scopeKey="p1"
        groupId="g1"
        visible
        focused={false}
        paneProject={project(pinned)}
        paneBox={undefined}
        projectSsh={ssh}
        hostSsh={undefined}
        localPersistEnabled={false}
        onConnect={() => {}}
        mobileAgentTmuxReady={new Map()}
        sleepAfterMs={null}
        inPopout={false}
        drawnElsewhere={false}
      />,
    );
  });
  return lastProps.get(tab.key)!;
}

describe("PaneSlot holds a pinned project's panes while its host is down", () => {
  it("holds an agent tab that stored a local location", () => {
    const props = renderSlot(tabOf("a1", "agent", { location: "local" }), true, "error");
    expect(props.holdRemoteTerminal).toBe(true);
    // Never the mirror as its cwd.
    expect(props.terminalCwd).toBe("/state/p1");
  });

  it("holds the Files tab instead of browsing a mirror there is none of", () => {
    const props = renderSlot(tabOf("f1", "files"), true, "error");
    expect(props.holdRemoteTerminal).toBe(true);
    expect(props.filesProjectDir).toBe("/state/p1");
  });

  it("lets the Files tab list the host again once connected", () => {
    const props = renderSlot(tabOf("f1", "files"), true, "connected");
    expect(props.holdRemoteTerminal).toBe(false);
  });

  it("keeps a plain remote project's offline Files tab on its mirror", () => {
    const props = renderSlot(tabOf("f1", "files"), false, "error");
    expect(props.holdRemoteTerminal).toBe(false);
    expect(props.filesProjectDir).toBe("/state/p1/mirror");
  });
});
