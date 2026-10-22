/**
 * Importing by clone: the Git hosting field is filled from the repository the
 * import comes from, not from a fixed default.
 *
 * A clone import used to land on "Push to GitHub/GitLab · private" whatever it
 * was cloning, and the created project carried no `git_provider` at all — the
 * pill only learned where the repo lived once the `origin` sniff ran. The URL
 * names the provider, and one anonymous `ls-remote` says whether the repo is
 * public; both now reach the field (and the created project).
 *
 * Also covers the VM tier's install button: a missing QEMU is one click, never
 * a command to retype.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  confirm: vi.fn().mockResolvedValue(false),
  message: vi.fn().mockResolvedValue(null),
}));

import { open } from "@tauri-apps/plugin-dialog";
import { ProjectDialog } from "../../components/projects/ProjectDialog";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";

const IMPORTED = {
  id: "p1",
  name: "repo",
  status: "active",
  position: 0,
  local_file: "/tmp/projects/repo/project.json",
  directory: "/tmp/projects/repo",
  git_type: "remote-public",
};

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
        return Promise.resolve({ supported: true, ok: false, reasons: [] });
      case "check_project_site":
        return Promise.resolve(null);
      case "git_clone":
        return Promise.resolve("/tmp/projects/repo");
      case "import_project":
        return Promise.resolve(IMPORTED);
      case "preview_project_scaffold":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  });
}

/** Render the dialog on its clone-import source and type a repository URL,
 *  then let the debounced visibility probe run. */
async function renderWithUrl(url: string, overrides: Record<string, unknown> = {}) {
  stubBackend(overrides);
  await act(async () => {
    render(
      <ProjectDialog
        kind="import"
        initialImportSource="git"
        onClose={() => {}}
        onProject={() => {}}
      />,
    );
  });
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText("https://github.com/owner/repo.git"), {
      target: { value: url },
    });
  });
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  await act(async () => {});
}

/** The Git hosting dropdown's current value, as its trigger renders it. */
function gitHostingValue(): string {
  const triggers = [...document.querySelectorAll(".dropdown-trigger")];
  const trigger = triggers.find((el) => el.textContent?.includes("Push to GitHub/GitLab"));
  return trigger?.textContent ?? "";
}

describe("clone import fills the Git hosting field", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    useSettingsStore.setState({ settings: { git_token: "", git_profile_url: "" } } as never);
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a public repository as public, and records its provider", async () => {
    await renderWithUrl("https://github.com/owner/repo.git", {
      git_remote_visibility: "public",
    });

    const probe = invoke.mock.calls.find((c) => c[0] === "git_remote_visibility");
    expect(probe![1]).toEqual({ url: "https://github.com/owner/repo.git" });
    expect(gitHostingValue()).toContain("public");
    expect(screen.getByText(/Filled in from the repository you are cloning: GitHub · public/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clone & Import" }));
    });
    const imported = invoke.mock.calls.find((c) => c[0] === "import_project");
    expect(imported![1]).toMatchObject({
      req: { gitType: "remote-public", gitProvider: "github" },
    });
  });

  it("keeps private for a repository that refuses an anonymous read", async () => {
    await renderWithUrl("git@gitlab.com:group/repo.git", {
      git_remote_visibility: "private",
    });
    expect(gitHostingValue()).toContain("private");
    expect(screen.getByText(/Filled in from the repository you are cloning: GitLab · private/)).toBeTruthy();
  });

  it("assumes private when the host won't say, and says so", async () => {
    await renderWithUrl("https://github.com/owner/repo.git", {
      git_remote_visibility: "unknown",
    });
    expect(gitHostingValue()).toContain("private");
    expect(screen.getByText(/public or private/)).toBeTruthy();
  });

  it("never overrides a hosting choice the user made themselves", async () => {
    stubBackend({ git_remote_visibility: "public" });
    await act(async () => {
      render(
        <ProjectDialog
          kind="import"
          initialImportSource="git"
          onClose={() => {}}
          onProject={() => {}}
        />,
      );
    });
    // Answer the field first, then type the URL: the probe must not fire at all.
    const trigger = [...document.querySelectorAll(".dropdown-trigger")].find((el) =>
      el.textContent?.includes("Push to GitHub/GitLab"),
    );
    fireEvent.click(trigger!);
    fireEvent.click(screen.getByRole("option", { name: "Local repo only (not pushed anywhere)" }));
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("https://github.com/owner/repo.git"), {
        target: { value: "https://github.com/owner/repo.git" },
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(invoke.mock.calls.some((c) => c[0] === "git_remote_visibility")).toBe(false);
    expect(
      [...document.querySelectorAll(".dropdown-trigger")].some((el) =>
        el.textContent?.includes("Local repo only"),
      ),
    ).toBe(true);
  });

  it("does not probe a folder import", async () => {
    stubBackend();
    await act(async () => {
      render(<ProjectDialog kind="import" onClose={() => {}} onProject={() => {}} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(invoke.mock.calls.some((c) => c[0] === "git_remote_visibility")).toBe(false);
  });
});

/** Render the dialog on its folder-import source, pick a folder through the
 *  (mocked) folder picker, then let the debounced visibility probe run. */
async function renderWithFolder(overrides: Record<string, unknown> = {}) {
  stubBackend(overrides);
  vi.mocked(open).mockResolvedValueOnce("/tmp/src/repo");
  await act(async () => {
    render(<ProjectDialog kind="import" onClose={() => {}} onProject={() => {}} />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Source folder/ }));
  });
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  await act(async () => {});
}

describe("folder import with an existing origin fills the Git hosting field", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    useSettingsStore.setState({ settings: { git_token: "", git_profile_url: "" } } as never);
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the origin's provider and visibility, and publishes nothing new", async () => {
    await renderWithFolder({
      git_folder_origin: "git@github.com:owner/repo.git",
      git_remote_visibility: "public",
    });

    const read = invoke.mock.calls.find((c) => c[0] === "git_folder_origin");
    expect(read![1]).toEqual({ sourceDir: "/tmp/src/repo" });
    const probe = invoke.mock.calls.find((c) => c[0] === "git_remote_visibility");
    expect(probe![1]).toEqual({ url: "git@github.com:owner/repo.git" });
    expect(gitHostingValue()).toContain("public");
    expect(screen.getByText(/Filled in from this folder's git origin: GitHub · public/)).toBeTruthy();
    // No token is set, yet no "set up the connection" gate: there is nothing to publish.
    expect(screen.queryByRole("button", { name: /Set up/ })).toBe(null);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Import" }));
    });
    const imported = invoke.mock.calls.find((c) => c[0] === "import_project");
    expect(imported![1]).toMatchObject({
      req: { gitType: "remote-public", gitProvider: "github" },
    });
    expect(invoke.mock.calls.some((c) => c[0] === "publish_project")).toBe(false);
  });

  it("keeps a local repository for a folder without an origin", async () => {
    await renderWithFolder({ git_folder_origin: null });
    expect(invoke.mock.calls.some((c) => c[0] === "git_remote_visibility")).toBe(false);
    expect(
      [...document.querySelectorAll(".dropdown-trigger")].some((el) =>
        el.textContent?.includes("Local repo only"),
      ),
    ).toBe(true);
  });
});

describe("VM tier prerequisites", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSettingsStore.setState({ settings: { git_token: "", git_profile_url: "" } } as never);
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
    useTabsStore.setState({ tabsByScope: {}, activeByScope: {} } as never);
  });

  it("offers the doctor's install command as a one-click tab", async () => {
    stubBackend({
      vm_doctor: {
        supported: true,
        ok: false,
        reasons: ["'qemu-system-x86_64' not found."],
        install_command: "sudo apt-get install -y qemu-system-x86 qemu-utils",
      },
    });
    await act(async () => {
      render(
        <ProjectDialog
          kind="import"
          initialImportSource="git"
          onClose={() => {}}
          onProject={() => {}}
        />,
      );
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Install the missing packages in a tab" }),
      );
    });
    const rootTabs = useTabsStore.getState().tabsByScope["root"] ?? [];
    expect(rootTabs.some((t) => t.initialInput === "sudo apt-get install -y qemu-system-x86 qemu-utils")).toBe(
      true,
    );
  });

  it("shows no button when nothing missing is installable", async () => {
    stubBackend({
      vm_doctor: {
        supported: true,
        ok: false,
        reasons: ["/dev/kvm is not accessible."],
      },
    });
    await act(async () => {
      render(
        <ProjectDialog
          kind="import"
          initialImportSource="git"
          onClose={() => {}}
          onProject={() => {}}
        />,
      );
    });
    expect(screen.queryByRole("button", { name: "Install the missing packages in a tab" })).toBe(
      null,
    );
    expect(screen.getByText(/dev\/kvm is not accessible/)).toBeTruthy();
  });
});
