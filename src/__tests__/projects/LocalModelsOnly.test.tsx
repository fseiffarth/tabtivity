/**
 * Local models only (`services::agent_privacy`): the record's reading, the
 * switches of the Agent privacy dialog, the + menu offering only local-model
 * rows in such a project, a refusal reaching the dialog, and the strings in
 * every dictionary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent, screen } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { AgentPrivacyDialog } from "../../components/projects/AgentPrivacyDialog";
import { NewTabMenu } from "../../components/tabs/NewTabMenu";
import { isCutNetwork, isLocalModelsOnly } from "../../lib/projects/localModelsOnly";
import { dropErrorKey } from "../../lib/terminal/terminalDrop";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { enSource as en, translate } from "../../lib/i18n";
import "../../lib/i18n/all";
import { dict as de } from "../../lib/i18n/de";
import { dict as es } from "../../lib/i18n/es";
import { dict as fr } from "../../lib/i18n/fr";
import { dict as it_ } from "../../lib/i18n/it";
import type { ProjectEntry } from "../../types";

const proj = (extra: Partial<ProjectEntry> = {}): ProjectEntry =>
  ({ id: "p1", name: "Secret", status: "active", position: 1, local_file: "/w/p1/project.json", directory: "/w/p1", ...extra }) as ProjectEntry;

describe("the record", () => {
  it("reads absent and null as off, a malformed record as on", () => {
    expect(isLocalModelsOnly(proj())).toBe(false);
    expect(isLocalModelsOnly(undefined)).toBe(false);
    expect(isLocalModelsOnly(proj({ agent_privacy: undefined }))).toBe(false);
    expect(isLocalModelsOnly(proj({ agent_privacy: null as unknown as undefined }))).toBe(false);
    expect(isLocalModelsOnly(proj({ agent_privacy: {} }))).toBe(false);
    expect(isLocalModelsOnly(proj({ agent_privacy: { local_models_only: false } }))).toBe(false);
    expect(isLocalModelsOnly(proj({ agent_privacy: { local_models_only: true } }))).toBe(true);
    expect(isLocalModelsOnly(proj({ agent_privacy: "yes" as unknown as undefined }))).toBe(true);
    expect(isCutNetwork(proj({ agent_privacy: { local_models_only: true, cut_network: true } }))).toBe(true);
    expect(isCutNetwork(proj({ agent_privacy: { local_models_only: true } }))).toBe(false);
  });
});

describe("the Agent privacy dialog", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useProjectsStore.setState({ projects: [proj()] });
  });
  afterEach(cleanup);

  it("shows both switches with their guarantee text, and Cut network cannot be turned on", () => {
    render(<AgentPrivacyDialog project={proj()} onClose={() => {}} />);
    const switches = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(switches).toHaveLength(2);
    expect(switches[0].disabled).toBe(false);
    expect(switches[1].disabled).toBe(true);
    expect(screen.getByText(translate("en", "agentPrivacy.cutNotYet"))).toBeTruthy();
    expect(screen.getByText(/Not covered: what the local agent does with its own network/)).toBeTruthy();
  });

  it("saves through the backend command and records the answer", async () => {
    mockInvoke.mockResolvedValue({ local_models_only: true, cut_network: false, closed_tabs: [] });
    const onClose = vi.fn();
    render(<AgentPrivacyDialog project={proj()} onClose={onClose} />);
    const save = screen.getByText(translate("en", "agentPrivacy.save")) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(save.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(save);
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_project_agent_privacy", {
      projectId: "p1",
      localModelsOnly: true,
      cutNetwork: false,
    });
    expect(onClose).toHaveBeenCalled();
    expect(isLocalModelsOnly(useProjectsStore.getState().projects[0])).toBe(true);
  });

  it("closes the project's cloud agent tabs when the switch goes on, and keeps its local ones", async () => {
    const closed: string[] = [];
    useTabsStore.setState({
      tabsByScope: {
        p1: [
          { key: "cloud", kind: "agent", label: "Claude", cmd: "claude", cwd: "/w/p1" },
          { key: "local", kind: "local_agent", label: "m", cmd: "vibe", cwd: "/w/p1" },
          { key: "sh", kind: "shell", label: "sh", cmd: "", cwd: "/w/p1" },
        ],
      } as never,
      removeTabInScope: ((scope: string, key: string) => void closed.push(`${scope}:${key}`)) as never,
    });
    mockInvoke.mockResolvedValue({ local_models_only: true, cut_network: false, closed_tabs: ["p1:cloud"] });
    await act(async () => {
      await useProjectsStore.getState().setProjectAgentPrivacy("p1", true, false);
    });
    expect(closed).toEqual(["p1:cloud"]);
  });

  it("closes the tabs of other scopes the backend ended because their fence showed the folder", async () => {
    const closed: string[] = [];
    useTabsStore.setState({
      tabsByScope: {
        p1: [{ key: "cloud", kind: "agent", label: "Claude", cmd: "claude", cwd: "/w/p1" }],
        parent: [
          { key: "a", kind: "agent", label: "Claude", cmd: "claude", cwd: "/w" },
          { key: "b", kind: "agent", label: "Codex", cmd: "codex", cwd: "/w" },
        ],
        root: [{ key: "r", kind: "agent", label: "Root", cmd: "claude", cwd: "/" }],
      } as never,
      removeTabInScope: ((scope: string, key: string) => void closed.push(`${scope}:${key}`)) as never,
    });
    mockInvoke.mockResolvedValue({ local_models_only: true, cut_network: false, closed_tabs: ["p1:cloud", "parent:a", "root:r"] });
    await act(async () => {
      await useProjectsStore.getState().setProjectAgentPrivacy("p1", true, false);
    });
    expect(closed.sort()).toEqual(["p1:cloud", "parent:a", "root:r"]);
  });

  it("shows the backend's refusal, naming the project, and stays open", async () => {
    mockInvoke.mockRejectedValue('"Secret" cannot be set to Local models only: it is a remote or VM project.');
    const onClose = vi.fn();
    render(<AgentPrivacyDialog project={proj()} onClose={onClose} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    await act(async () => {
      fireEvent.click(screen.getByText(translate("en", "agentPrivacy.save")));
    });
    expect(screen.getByText(/cannot be set to Local models only/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(isLocalModelsOnly(useProjectsStore.getState().projects[0])).toBe(false);
  });
});

describe("the + menu", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(null);
    useProjectsStore.setState({ projects: [proj()] });
  });
  afterEach(cleanup);

  const open = (localModelsOnly: boolean) =>
    render(
      <NewTabMenu
        scope="p1"
        projectCwd="/w/p1"
        projectName=""
        anchor={{ x: 0, y: 0 }}
        onPick={vi.fn()}
        onClose={vi.fn()}
        onManageAgents={vi.fn()}
        localModelsOnly={localModelsOnly}
      />,
    );

  it("lists the agent group only outside a local-models-only project", () => {
    open(false);
    expect(screen.queryByText(translate("en", "newTabMenu.groupAgents"))).not.toBeNull();
    cleanup();
    open(true);
    expect(screen.queryByText(translate("en", "newTabMenu.groupAgents"))).toBeNull();
    // The shell group stays: a shell is the user's.
    expect(screen.queryAllByText(translate("en", "newTabMenu.groupShell")).length).toBeGreaterThan(0);
  });
});

describe("strings", () => {
  it("carries every agentPrivacy key in every dictionary, with the same placeholders", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("agentPrivacy.") || k === "terminal.drop.localModelsOnly");
    expect(keys.length).toBeGreaterThan(10);
    const placeholders = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort().join(",");
    for (const [name, dict] of Object.entries({ de, es, fr, it: it_ })) {
      for (const key of keys) {
        const value = (dict as Record<string, string>)[key];
        expect(value, `${name}: ${key}`).toBeTruthy();
        expect(placeholders(value), `${name}: ${key}`).toBe(placeholders((en as Record<string, string>)[key]));
      }
    }
  });

  it("maps the drop refusal to its message", () => {
    expect(dropErrorKey("local_models_only")).toBe("terminal.drop.localModelsOnly");
  });
});
