/**
 * Regression: choosing "Push to GitHub/GitLab" when creating a project must
 * actually publish it.
 *
 * The git-hosting dropdown used to *record* the choice and stop there: the
 * project came out labeled `remote-private` with no repository on the host, no
 * `origin`, and — because the Push button keys off an upstream branch — no way
 * to push it either. Creation now runs the same `publish_project` the pill's
 * Publish… window drives.
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

const CREATED = {
  id: "p1",
  name: "PyTest CI/CD",
  status: "active",
  position: 0,
  local_file: "/tmp/p1/project.json",
  directory: "/tmp/p1",
  git_type: "remote-private",
};

/** Backend answers for everything the dialog probes on open. */
function stubBackend(overrides: Record<string, unknown> = {}) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd in overrides) {
      const value = overrides[cmd];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    switch (cmd) {
      case "projects_root_dir":
        return Promise.resolve("/tmp/projects");
      case "remote_mirror_root_dir":
        return Promise.resolve("/tmp/projects-ssh");
      case "git_available":
        return Promise.resolve(true);
      case "provider_cli_available":
        return Promise.resolve(true);
      case "vm_doctor":
        return Promise.resolve({ ok: false });
      case "check_project_site":
        return Promise.resolve(null);
      case "create_project":
        return Promise.resolve(CREATED);
      case "publish_project":
        return Promise.resolve("https://github.com/someone/pytest-ci-cd");
      // A saved github.com host token is what the dialog treats as "GitHub is
      // connected"; without it submit is blocked on the connect notice.
      case "get_git_hosts":
        return Promise.resolve([{ profile_url: "https://github.com/someone", origin: "https://github.com", has_token: true }]);
      default:
        return Promise.resolve(null);
    }
  });
}

/** Pick an option out of one of the app's custom (non-native) dropdowns —
 *  matched by the trigger's visible text, since it is a themed trigger + menu
 *  rather than a native <select>. */
function chooseOption(triggerLabel: string, optionLabel: string) {
  const trigger = [...document.querySelectorAll(".dropdown-trigger")].find((el) =>
    el.textContent?.includes(triggerLabel),
  );
  expect(trigger).toBeTruthy();
  fireEvent.click(trigger!);
  fireEvent.click(screen.getByRole("option", { name: optionLabel }));
}

async function fillAndSubmit() {
  fireEvent.change(screen.getByPlaceholderText("my-project"), {
    target: { value: "PyTest CI/CD" },
  });
  chooseOption("Local repo only", "Push to GitHub/GitLab · private");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
  });
}

describe("new project with git hosting", () => {
  beforeEach(() => {
    localStorage.clear(); // ProjectDialog reopens on its last answers (projectDialogMemory)
    invoke.mockReset();
    useSettingsStore.setState({ settings: {} } as never);
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  });

  it("creates the hosted repository and pushes, not just the label", async () => {
    stubBackend();
    const onClose = vi.fn();
    await act(async () => {
      render(<ProjectDialog kind="new" onClose={onClose} onProject={() => {}} />);
    });

    await fillAndSubmit();

    const published = invoke.mock.calls.find((c) => c[0] === "publish_project");
    expect(published).toBeTruthy();
    expect(published![1]).toMatchObject({
      projectId: "p1",
      provider: "github",
      visibility: "private",
      publishFrom: "local",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the dialog open on a failed publish, and retries the publish alone", async () => {
    stubBackend({ publish_project: new Error("gh: HTTP 401") });
    const onClose = vi.fn();
    await act(async () => {
      render(<ProjectDialog kind="new" onClose={onClose} onProject={() => {}} />);
    });

    await fillAndSubmit();

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/gh: HTTP 401/)).toBeTruthy();
    // The project exists now — a retry must publish, never create a second one.
    const createsBefore = invoke.mock.calls.filter((c) => c[0] === "create_project").length;
    stubBackend();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry publish" }));
    });
    expect(invoke.mock.calls.filter((c) => c[0] === "create_project").length).toBe(
      createsBefore,
    );
    expect(invoke.mock.calls.filter((c) => c[0] === "publish_project").length).toBe(2);
    expect(onClose).toHaveBeenCalled();
  });

  it("explains a missing name and keeps entered values and operation errors beside the fixed actions after failure", async () => {
    stubBackend({ create_project: new Error("Disk full") });
    const onClose = vi.fn();
    await act(async () => {
      render(<ProjectDialog kind="new" onClose={onClose} onProject={() => {}} />);
    });
    const name = screen.getByPlaceholderText("my-project") as HTMLInputElement;
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(name.getAttribute("aria-describedby")!)?.textContent).toBe("Enter a project name.");
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: "Keep my name" } });
    const description = screen.getByPlaceholderText("What this project is for") as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "Keep my description" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create" })); });
    expect(name.value).toBe("Keep my name");
    expect(description.value).toBe("Keep my description");
    const error = screen.getByRole("alert");
    expect(error.textContent).toContain("Disk full");
    expect(error.closest(".dialog-scroll")).toBeNull();
    expect(screen.getByRole("button", { name: "Create" }).closest(".dialog-scroll")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("associates an invalid clone URL with its guidance and leaves import disabled", async () => {
    stubBackend();
    await act(async () => { render(<ProjectDialog kind="import" initialImportSource="git" onClose={() => {}} onProject={() => {}} />); });
    const url = screen.getByPlaceholderText("https://github.com/owner/repo.git");
    fireEvent.change(url, { target: { value: "not-a-repository" } });
    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(url.getAttribute("aria-describedby")!)?.textContent).toBe("Enter a repository URL to clone or fork.");
    expect((screen.getByRole("button", { name: /Clone.*import/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("leaves a plain local repo alone", async () => {
    stubBackend();
    await act(async () => {
      render(<ProjectDialog kind="new" onClose={() => {}} onProject={() => {}} />);
    });
    fireEvent.change(screen.getByPlaceholderText("my-project"), {
      target: { value: "Local Only" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(invoke.mock.calls.some((c) => c[0] === "publish_project")).toBe(false);
  });
});
