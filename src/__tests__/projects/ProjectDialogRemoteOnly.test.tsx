/**
 * Creating a remote-only project (F2): the "Keep a local copy" card under the
 * Remote card, on by default (D12/D13). Off, the dialog asks for no local
 * location, sends a top-level `remoteOnly: true` and no `mirrorParent`, and:
 *
 *  - a **New** awaits the project's first pooled connect, then runs
 *    `remote_project_init_host` (the scaffold and `git init` happen on the host),
 *    and only then opens the description agent tab — which edits what the init
 *    wrote; a failed init keeps the dialog open with a retry of the init alone;
 *  - a **clone** creates the empty host folder and opens one visible host shell
 *    tab running `git clone --progress <url> .`, never the init;
 *  - auto-connect (D14) is pre-ticked only for a password-less headless sign-in
 *    with no OpenVPN tunnel, and an HPC host gets the D9 warning line.
 *
 * The SSH connect → browse flow is its own hook (`useRemoteSession`), mocked here
 * at the state the details step is reached with.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, screen, cleanup } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  confirm: vi.fn().mockResolvedValue(false),
  message: vi.fn().mockResolvedValue(null),
}));

/** What the mocked SSH flow reports: connected and browsed to `/srv`. */
const session = {
  /** The secret the dialog's sign-in typed ("" = none: key/agent auth). */
  typedSignIn: "",
  headless: true,
  sshViaTerminal: false,
  vpnEnabled: false,
  vpnConfig: "",
};
vi.mock("../../components/projects/useRemoteSession", async () => {
  const { joinRemotePath } = await import("../../lib/projects/scaffold");
  return {
    useRemoteSession: ({ kind }: { kind: "new" | "import" }) => ({
      ...session,
      remotePassword: session.typedSignIn,
      isRemoteProject: true,
      isRemote: true,
      remoteConn: { user: "ada", host: "box.example", port: null },
      winManual: false,
      step: "details",
      setStep: () => {},
      remoteReady: true,
      remoteBrowsePath: "/srv",
      remoteChosenPath: "/srv",
      setRemoteChosenPath: () => {},
      rememberChosenPath: () => {},
      toggleRemoteProject: () => {},
      buildRemoteSpec: (safeName: string, joinName: boolean = kind === "new") => ({
        user: "ada",
        host: "box.example",
        remote_path: joinName ? joinRemotePath("/srv", safeName) : "/srv",
        openvpn: session.vpnEnabled && session.vpnConfig ? { config: session.vpnConfig } : undefined,
      }),
    }),
  };
});
vi.mock("../../components/projects/RemoteProjectSection", () => ({ RemoteProjectSection: () => null }));

import { ProjectDialog } from "../../components/projects/ProjectDialog";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";

const CREATED = {
  id: "p1",
  name: "app",
  status: "active",
  position: 0,
  local_file: "/tmp/state/remote-projects/p1/project.json",
  directory: "/tmp/state/remote-projects/p1",
  git_type: "local",
  remote: { user: "ada", host: "box.example", remote_path: "/srv/app", remote_only: true },
};

const INIT_REPORT = { written: ["AGENTS.md"], kept: [], git: "initialized", committed: true, gitType: "local" };

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
      case "vm_doctor":
        return Promise.resolve({ supported: true, ok: false, reasons: [] });
      case "create_project":
      case "import_project":
        return Promise.resolve(CREATED);
      case "remote_project_init_host":
        return Promise.resolve(INIT_REPORT);
      default:
        return Promise.resolve(null);
    }
  });
}

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);
const order = (cmd: string) => invoke.mock.calls.findIndex((c) => c[0] === cmd);

/** The checkbox of the `toggle-card` titled `title`. */
function card(title: string): HTMLInputElement {
  const label = [...document.querySelectorAll("label.toggle-card")].find((el) =>
    el.querySelector(".toggle-card-title")?.textContent?.startsWith(title),
  );
  return label!.querySelector("input[type=checkbox]") as HTMLInputElement;
}

async function renderDialog(
  kind: "new" | "import",
  opts: { initialImportSource?: "folder" | "git"; overrides?: Record<string, unknown> } = {},
) {
  stubBackend(opts.overrides);
  const onClose = vi.fn();
  await act(async () => {
    render(
      <ProjectDialog
        kind={kind}
        initialImportSource={opts.initialImportSource}
        onClose={onClose}
        onProject={() => {}}
      />,
    );
  });
  return { onClose };
}

async function keepLocalCopy(on: boolean) {
  await act(async () => {
    fireEvent.click(card("Keep a local copy"));
  });
  expect(card("Keep a local copy").checked).toBe(on);
}

async function typeName(name: string) {
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText("my-project"), { target: { value: name } });
  });
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe("ProjectDialog · remote-only", () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.assign(session, {
      typedSignIn: "",
      headless: true,
      sshViaTerminal: false,
      vpnEnabled: false,
      vpnConfig: "",
    });
    useSettingsStore.setState({ settings: { git_token: "", git_profile_url: "" } } as never);
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
    useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
    useTabsStore.getState().addTab = vi.fn() as never;
  });
  afterEach(() => cleanup());

  it("keeps a local copy by default; turning it off hides Local location", async () => {
    await renderDialog("new");
    expect(card("Keep a local copy").checked).toBe(true);
    expect(screen.getByText("Local location")).toBeTruthy();
    await keepLocalCopy(false);
    expect(screen.queryByText("Local location")).toBeNull();
    expect(screen.getByText(/^No local copy: the file panel/)).toBeTruthy();
  });

  it("a New sends remoteOnly without mirrorParent, awaits the connect, inits the host, then opens the agent tab", async () => {
    await renderDialog("new");
    await keepLocalCopy(false);
    await typeName("app");
    // Ask for a description agent, so a tab is opened after the init.
    await act(async () => {
      fireEvent.click(screen.getByTitle("Project description fill mode"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Claude" }));
    });
    await click("Create");

    const req = calls("create_project")[0][1] as { req: Record<string, unknown> };
    expect(req.req).toMatchObject({ remoteOnly: true, remote: { remote_path: "/srv/app" } });
    expect(req.req.mirrorParent).toBeUndefined();
    expect(calls("remote_project_init_host")[0][1]).toEqual({ projectId: "p1", scaffold: true, git: true });
    // connect → init → the description prompt (written over SFTP) and its tab.
    expect(order("remote_connect")).toBeGreaterThan(order("create_project"));
    expect(order("remote_project_init_host")).toBeGreaterThan(order("remote_connect"));
    expect(order("write_project_file")).toBeGreaterThan(order("remote_project_init_host"));
    expect(useTabsStore.getState().addTab).toHaveBeenCalledTimes(1);
  });

  it("a failed init keeps the dialog open, skips the agent tab, and retries the init alone", async () => {
    const { onClose } = await renderDialog("new", {
      overrides: { remote_project_init_host: new Error("disk full") },
    });
    await keepLocalCopy(false);
    await typeName("app");
    await click("Create");
    expect(screen.getByText(/setting up its folder on the host failed: Error: disk full/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(useTabsStore.getState().addTab).not.toHaveBeenCalled();

    invoke.mockClear();
    stubBackend();
    await click("Retry host setup");
    expect(calls("create_project")).toHaveLength(0);
    expect(calls("remote_project_init_host")).toHaveLength(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("a connect that fails never reaches the init", async () => {
    const { onClose } = await renderDialog("new", {
      overrides: { remote_connect: new Error("Permission denied") },
    });
    await keepLocalCopy(false);
    await typeName("app");
    await click("Create");
    expect(calls("remote_project_init_host")).toHaveLength(0);
    // The error is shown (worded by `ErrorNote`), with the init's retry.
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry host setup" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a clone creates the host folder and opens one host tab with the clone argv, never the init", async () => {
    const { onClose } = await renderDialog("import", { initialImportSource: "git" });
    await keepLocalCopy(false);
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("https://github.com/owner/repo.git"), {
        target: { value: "https://github.com/owner/app.git" },
      });
    });
    await click("Clone & Import");

    expect(calls("git_clone")).toHaveLength(0);
    expect(calls("import_project")).toHaveLength(0);
    const req = calls("create_project")[0][1] as { req: Record<string, unknown> };
    expect(req.req).toMatchObject({ remoteOnly: true, remote: { remote_path: "/srv/app" } });
    expect(calls("remote_project_init_host")).toHaveLength(0);
    expect(useTabsStore.getState().addTab).toHaveBeenCalledTimes(1);
    expect(useTabsStore.getState().addTab).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "git",
        args: ["clone", "--progress", "https://github.com/owner/app.git", "."],
        kind: "shell",
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("a plain remote clone is still not offered (its tree would be cloned locally)", async () => {
    await renderDialog("import", { initialImportSource: "git" });
    expect(screen.queryByPlaceholderText("https://github.com/owner/repo.git")).toBeNull();
  });

  it("pre-ticks auto-connect only for a password-less, VPN-less connect", async () => {
    await renderDialog("new");
    await keepLocalCopy(false);
    expect(card("Auto-connect on launch").checked).toBe(true);
    await typeName("app");
    await click("Create");
    const req = calls("create_project")[0][1] as { req: { remote: Record<string, unknown> } };
    expect(req.req.remote.auto_connect).toBe(true);
    cleanup();

    session.typedSignIn = "pw-test";
    await renderDialog("new");
    await keepLocalCopy(false);
    expect(card("Auto-connect on launch").checked).toBe(false);
    cleanup();

    session.typedSignIn = "";
    session.vpnEnabled = true;
    session.vpnConfig = "/state/vpn/site.ovpn";
    await renderDialog("new");
    await keepLocalCopy(false);
    expect(card("Auto-connect on launch").checked).toBe(false);
  });

  it("warns on an HPC-tagged host", async () => {
    useSettingsStore.setState({
      settings: { git_token: "", git_profile_url: "", hpc_hosts: { "ada@box.example:22": true } },
    } as never);
    await renderDialog("new");
    await keepLocalCopy(false);
    expect(screen.getByText(/tagged as a shared cluster \(HPC\)/)).toBeTruthy();
    expect(card("Auto-connect on launch").disabled).toBe(true);
  });

  it("a plain remote project is unchanged: mirrorParent sent, no remoteOnly, no init", async () => {
    await renderDialog("new");
    await typeName("app");
    await click("Create");
    const req = calls("create_project")[0][1] as { req: Record<string, unknown> };
    expect(req.req.remoteOnly).toBeUndefined();
    expect(req.req.mirrorParent).toBe("/tmp/projects-ssh");
    expect(calls("remote_project_init_host")).toHaveLength(0);
  });
});
