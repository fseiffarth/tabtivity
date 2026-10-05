/**
 * A new project never moves into a folder that already exists: the dialog says
 * so and blocks Create, and `create_project` (the real gate) is never called.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  confirm: vi.fn().mockResolvedValue(false),
  message: vi.fn().mockResolvedValue(null),
}));

import { ProjectDialog } from "../../components/projects/ProjectDialog";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";

function stubBackend(existing: string[]) {
  invoke.mockImplementation((cmd: string, args?: { directory?: string }) => {
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
        return Promise.resolve(existing.includes(args?.directory ?? ""));
      default:
        return Promise.resolve(null);
    }
  });
}

async function typeName(value: string) {
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText("my-project"), { target: { value } });
  });
}

describe("new project into an existing folder", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSettingsStore.setState({ settings: { git_token: "", git_profile_url: "" } } as never);
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  });

  it("says the folder exists and blocks Create", async () => {
    stubBackend(["/tmp/projects/taken"]);
    await act(async () => {
      render(<ProjectDialog kind="new" onClose={() => {}} onProject={() => {}} />);
    });

    await typeName("taken");

    expect(await screen.findByText(/\/tmp\/projects\/taken already exists/)).toBeTruthy();
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(create);
    });
    expect(invoke.mock.calls.some((c) => c[0] === "create_project")).toBe(false);
  });

  it("clears the notice once the name points at a free folder", async () => {
    stubBackend(["/tmp/projects/taken"]);
    await act(async () => {
      render(<ProjectDialog kind="new" onClose={() => {}} onProject={() => {}} />);
    });

    await typeName("taken");
    await screen.findByText(/already exists/);
    await typeName("fresh");

    await vi.waitFor(() => expect(screen.queryByText(/already exists/)).toBeNull());
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
  });
});
