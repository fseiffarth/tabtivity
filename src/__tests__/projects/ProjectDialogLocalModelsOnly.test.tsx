/**
 * The New Project dialog's Local models only switch: stored on the project
 * before the window learns of it (so no tab of it can open on a cloud model
 * first), the cloud fill agents hidden while it is on, and offered only where
 * the backend can cover the project. The dialog also reopens on its last
 * answers (`projectDialogMemory`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, screen, cleanup } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  confirm: vi.fn().mockResolvedValue(false),
  message: vi.fn().mockResolvedValue(null),
}));

import { ProjectDialog } from "../../components/projects/ProjectDialog";
import { readProjectDialogMemory, writeProjectDialogMemory } from "../../components/projects/projectDialogMemory";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import type { ProjectEntry } from "../../types";

function stubBackend(privacy: "ok" | "refuse" = "ok") {
  invoke.mockImplementation((cmd: string, args?: { req?: { name?: string; directory?: string } }) => {
    switch (cmd) {
      case "projects_root_dir":
        return Promise.resolve("/tmp/projects");
      case "remote_mirror_root_dir":
        return Promise.resolve("/tmp/projects-ssh");
      case "git_available":
        return Promise.resolve(true);
      case "vm_doctor":
        return Promise.resolve({ ok: false });
      case "project_folder_exists":
        return Promise.resolve(false);
      case "create_project":
        return Promise.resolve({ id: "p1", name: args?.req?.name, directory: args?.req?.directory } as ProjectEntry);
      case "set_project_agent_privacy":
        return privacy === "ok"
          ? Promise.resolve({ local_models_only: true, cut_network: false, closed_tabs: [] })
          : Promise.reject("Ollama is not on this machine");
      default:
        return Promise.resolve(null);
    }
  });
}

async function openNew(onProject: (p: ProjectEntry) => void = () => {}) {
  await act(async () => {
    render(<ProjectDialog kind="new" onClose={() => {}} onProject={onProject} />);
  });
}

async function typeName(value: string) {
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText("my-project"), { target: { value } });
  });
}

const localSwitch = () =>
  screen.getByText("Local models only").closest("label")!.querySelector("input") as HTMLInputElement;

describe("New Project: Local models only", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    invoke.mockReset();
    useSettingsStore.setState({ settings: { git_token: "", git_profile_url: "" } } as never);
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  });

  it("stores the setting before the project reaches the window", async () => {
    stubBackend();
    const order: string[] = [];
    await openNew((p) => {
      order.push(`onProject:${JSON.stringify(p.agent_privacy ?? null)}`);
    });
    await typeName("secret");
    await act(async () => {
      fireEvent.click(localSwitch());
    });
    invoke.mockImplementation(((orig) => (cmd: string, args?: unknown) => {
      if (cmd === "create_project" || cmd === "set_project_agent_privacy") order.push(cmd);
      return orig(cmd, args);
    })(invoke.getMockImplementation()!));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    expect(order).toEqual([
      "create_project",
      "set_project_agent_privacy",
      'onProject:{"local_models_only":true,"cut_network":false}',
    ]);
    const call = invoke.mock.calls.find((c) => c[0] === "set_project_agent_privacy");
    expect(call?.[1]).toEqual({ projectId: "p1", localModelsOnly: true, cutNetwork: false });
  });

  it("keeps the setting on a container project the window receives", async () => {
    stubBackend();
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "set_project_sandbox") return Promise.resolve({ outcome: "applied", spec: { enabled: true } });
      if (cmd === "sandbox_preflight") return Promise.resolve({ status: "ok", image: "img", build_command: null });
      return base(cmd, args);
    });
    writeProjectDialogMemory("new", { tierChoice: "container" });
    const made: ProjectEntry[] = [];
    await openNew((p) => {
      made.push(p);
    });
    await typeName("secret");
    await act(async () => {
      fireEvent.click(localSwitch());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(invoke.mock.calls.some((c) => c[0] === "set_project_sandbox")).toBe(true);
    expect(made).toHaveLength(1);
    expect(made[0].agent_privacy).toEqual({ local_models_only: true, cut_network: false });
    expect(made[0].sandbox).toEqual({ enabled: true });
  });

  it("is not stored when the switch is off", async () => {
    stubBackend();
    await openNew();
    await typeName("open");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(invoke.mock.calls.some((c) => c[0] === "create_project")).toBe(true);
    expect(invoke.mock.calls.some((c) => c[0] === "set_project_agent_privacy")).toBe(false);
  });

  it("says so when the backend refuses, with the project already made", async () => {
    stubBackend("refuse");
    const made: ProjectEntry[] = [];
    await openNew((p) => {
      made.push(p);
    });
    await typeName("secret");
    await act(async () => {
      fireEvent.click(localSwitch());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(made).toHaveLength(1);
    expect(made[0].agent_privacy).toBeUndefined();
    expect(await screen.findByText(/Local models only could not be turned on: Ollama is not on this machine/)).toBeTruthy();
  });

  it("hides the cloud description agents while on", async () => {
    stubBackend();
    await openNew();
    await act(async () => {
      fireEvent.click(localSwitch());
    });
    const dropdown = screen.getByTitle(/description/i);
    await act(async () => {
      fireEvent.click(dropdown);
    });
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("reopens on the last answers; a created project clears them all", async () => {
    stubBackend();
    await openNew();
    await typeName("draft");
    await act(async () => {
      fireEvent.click(localSwitch());
    });
    cleanup();
    expect(readProjectDialogMemory("new")).toMatchObject({ name: "draft", localModelsOnly: true });

    await openNew();
    expect((screen.getByPlaceholderText("my-project") as HTMLInputElement).value).toBe("draft");
    expect(localSwitch().checked).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(readProjectDialogMemory("new")).toEqual({});
  });
});
