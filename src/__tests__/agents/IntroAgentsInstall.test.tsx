/**
 * The intro's Agent CLIs page installs the way Manage CLIs does — headless,
 * in place, re-detecting on success — and keeps the terminal only for what
 * needs one: the `sudo` fallback and the CLI's own sign-in command. Disabled
 * buttons say why, and the sign-in step reads the shared login state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
const runInstallInTab = vi.fn();
vi.mock("../../lib/installCommand", async (orig) => ({
  ...(await orig<typeof import("../../lib/installCommand")>()),
  runInstallInTab: (...a: unknown[]) => runInstallInTab(...a),
}));

const openTabInRootConsole = vi.fn();
vi.mock("../../stores/rootOverlay", async (orig) => ({
  ...(await orig<typeof import("../../stores/rootOverlay")>()),
  openTabInRootConsole: (...a: unknown[]) => openTabInRootConsole(...a),
}));

import { AgentsPage } from "../../components/layout/intro/AgentsPage";
import { useSettingsStore } from "../../stores/settings";
import { ELSEWHERE_POLL_MS, resetInstallRuns } from "../../stores/installRuns";
import type { Settings } from "../../types";

const invokeMock = vi.mocked(invoke);
const updateSettings = vi.fn(async () => {});

const agent = (id: string, label: string, installed: boolean, extra: Record<string, unknown> = {}) => ({
  id,
  label,
  bin: id,
  install_cmd: `curl ${id} | sh`,
  install_cmd_sudo: "",
  shell_kind: "bash",
  docs: "",
  installed,
  ...extra,
});

type Handler = (args?: Record<string, unknown>) => unknown;
let installed: Record<string, boolean>;
let handlers: Record<string, Handler>;

function backend(extra: Record<string, Handler> = {}) {
  handlers = {
    list_agents: () => [
      agent("claude", "Claude Code", installed.claude),
      agent("codex", "Codex", installed.codex, {
        install_cmd: "npm install -g @openai/codex",
        install_cmd_sudo: "sudo npm install -g @openai/codex",
      }),
      agent("gemini", "Gemini CLI", installed.gemini),
    ],
    node_runtime_status: () => ({ npm: true, too_old: false, version: "v24.1.0", min_major: 24 }),
    agent_logins: () => [],
    ...extra,
  };
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked ${cmd}`);
    return h(args as Record<string, unknown>);
  });
}

function mount(defaultAgentCmd = "codex") {
  useSettingsStore.setState({
    settings: { default_agent_cmd: defaultAgentCmd } as Settings,
    updateSettings,
  } as never);
  const onClose = vi.fn();
  render(<AgentsPage onClose={onClose} />);
  return onClose;
}

const installButton = () => screen.findByRole("button", { name: /^Install Codex$|^Installing…$/ });

beforeEach(() => {
  installed = { claude: false, codex: false, gemini: false };
  backend();
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  updateSettings.mockClear();
  runInstallInTab.mockReset();
  openTabInRootConsole.mockReset();
  resetInstallRuns();
  vi.useRealTimers();
});

describe("intro Agents page install", () => {
  it("installs in place, re-detects and stays open", async () => {
    let finish: (v: string) => void = () => {};
    backend({
      install_agent: () =>
        new Promise<string>((r) => {
          finish = (v) => {
            installed.codex = true;
            r(v);
          };
        }),
    });
    const onClose = mount();
    fireEvent.click(await installButton());
    // In flight: the button says so and a second click cannot start another.
    const busy = await screen.findByRole("button", { name: "Installing…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Running installer…").closest("[role=status]")).toBeTruthy();
    const listsBefore = invokeMock.mock.calls.filter(([cmd]) => cmd === "list_agents").length;
    finish("ok");
    // The registry broadcast re-reads the list: step 1 turns installed.
    await waitFor(() =>
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "list_agents").length).toBeGreaterThan(listsBefore),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Install Codex$/ })).toBeNull());
    expect(screen.getAllByText("installed").length).toBeGreaterThan(0);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "install_agent")).toHaveLength(1);
    expect(runInstallInTab).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a failure with Try again and the terminal fallbacks Settings has", async () => {
    let attempts = 0;
    backend({
      install_agent: () => {
        attempts += 1;
        throw "npm ERR! code EACCES";
      },
    });
    const onClose = mount();
    fireEvent.click(await installButton());
    // The plain-language summary, the raw tail one click away.
    expect((await screen.findByRole("alert")).textContent).toMatch(/read-only/);
    expect(updateSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(attempts).toBe(2));

    fireEvent.click(await screen.findByRole("button", { name: "Run with sudo" }));
    expect(runInstallInTab).toHaveBeenCalledWith("Install Codex", "sudo npm install -g @openai/codex", "bash");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("holds Install while Node.js is missing and says why", async () => {
    backend({ node_runtime_status: () => ({ npm: false, too_old: false, version: null, min_major: 24 }) });
    mount();
    const button = await installButton();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/Install waits for Node\.js/)).toBeTruthy();
    expect(button.getAttribute("aria-describedby")).toBe("intro-agents-node");
    expect(screen.getByRole("button", { name: "Install Node.js in a terminal" })).toBeTruthy();
  });

  it("leaving the page mid-install and coming back shows the same run", async () => {
    let finish: () => void = () => {};
    backend({
      install_agent: () =>
        new Promise<string>((r) => {
          finish = () => {
            installed.codex = true;
            r("ok");
          };
        }),
    });
    mount();
    fireEvent.click(await installButton());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("install_agent", { id: "codex" }));
    cleanup();

    mount();
    // Re-attached: busy, not a fresh enabled Install that would hit the lock.
    const busy = await screen.findByRole("button", { name: "Installing…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Install Codex$|^Installing…$/ })).toBeNull());
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "install_agent")).toHaveLength(1);
  });

  it("waits on another run's lock without failure or fallbacks", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend({
      install_agent: () => {
        throw "Codex is already being installed or updated. Wait for that run to finish.";
      },
      agent_is_installed: () => installed.codex,
    });
    mount();
    fireEvent.click(await installButton());
    await screen.findByText("Codex is already being installed by another run. This page updates once it is there.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run in terminal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    installed.codex = true;
    await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Install Codex$|^Installing…$/ })).toBeNull());
    expect(runInstallInTab).not.toHaveBeenCalled();
  });

  it("shows the reason a failed default save did not stick", async () => {
    installed.claude = true;
    updateSettings.mockRejectedValueOnce("settings file is read-only" as never);
    mount("codex");
    fireEvent.click(await screen.findByRole("button", { name: /^Claude Code$/ }));
    await screen.findByText(/settings file is read-only/);
  });
});

describe("intro Agents page sign-in", () => {
  it("asks for the install first while the CLI is missing", async () => {
    mount();
    const signIn = await screen.findByRole("button", { name: /^Sign in now/ });
    expect((signIn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Install Codex first (step 1), then sign in.")).toBeTruthy();
  });

  it("opens the CLI's own login as a sign-in tab in the root console", async () => {
    installed.codex = true;
    backend({ agent_logins: () => [{ id: "codex", signed_in: false, account: null, shared: true }] });
    const onClose = mount();
    await screen.findByText("not signed in");
    fireEvent.click(await screen.findByRole("button", { name: "Sign in now (codex login --device-auth)" }));
    expect(openTabInRootConsole).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "codex", args: ["login", "--device-auth"], kind: "agent", signIn: true }),
      expect.any(Function),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers the alternate way in", async () => {
    installed.codex = true;
    backend({ agent_logins: () => [{ id: "codex", signed_in: false, account: null, shared: true }] });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in in the browser" }));
    expect(openTabInRootConsole).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "codex", args: ["login"], signIn: true }),
      expect.any(Function),
    );
  });

  it("carries the launch's environment (Gemini without a browser)", async () => {
    installed.gemini = true;
    mount("gemini");
    fireEvent.click(await screen.findByRole("button", { name: /^Sign in now \(gemini\)$/ }));
    expect(openTabInRootConsole).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "gemini", env: expect.objectContaining({ NO_BROWSER: "true" }) }),
      expect.any(Function),
    );
    expect(screen.queryByRole("button", { name: /browser|Console/ })).toBeNull();
  });

  it("does not leave step 2 empty when a login exists but the CLI is missing", async () => {
    backend({ agent_logins: () => [{ id: "codex", signed_in: true, account: "me@example.org", shared: true }] });
    mount();
    expect(await screen.findByText("Install Codex first (step 1), then sign in.")).toBeTruthy();
    expect(screen.queryByText(/signed in as/)).toBeNull();
  });

  it("shows the signed-in account and ticks the step", async () => {
    installed.claude = true;
    backend({ agent_logins: () => [{ id: "claude", signed_in: true, account: "me@example.org", shared: true }] });
    mount("claude");
    const status = await screen.findByText(/signed in as me@example\.org/);
    expect(status.closest("li")?.className).toContain("intro-step-done");
    expect(screen.queryByRole("button", { name: /^Sign in now/ })).toBeNull();
  });
});
