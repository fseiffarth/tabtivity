/**
 * The intro's Local models page installs in place where Settings' one-click
 * path needs no password — Vibe always, Ollama on Windows — with a live log
 * and a re-detect, keeps the terminal for Ollama's sudo script on
 * Linux/macOS, and says why Download is disabled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
const runInstallInTab = vi.fn();
vi.mock("../../lib/installCommand", async (orig) => ({
  ...(await orig<typeof import("../../lib/installCommand")>()),
  runInstallInTab: (...a: unknown[]) => runInstallInTab(...a),
}));

import { LocalModelsPage } from "../../components/layout/intro/LocalModelsPage";
import { resetOllamaStatusPoller } from "../../lib/ollamaStatus";
import { ELSEWHERE_POLL_MS, resetInstallRuns } from "../../stores/installRuns";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
type Handler = () => unknown;
let progress: (line: string) => void = () => {};

function backend(extra: Record<string, Handler>) {
  const handlers: Record<string, Handler> = {
    ollama_is_installed: () => false,
    ollama_install_strategy: () => ({ os: "linux", command: "curl ollama | sh", auto: true, download_url: "" }),
    vibe_is_installed: () => false,
    vibe_install_strategy: () => ({ os: "linux", command: "curl vibe | bash" }),
    machine_load_snapshot: () => ({ mem_total_bytes: 16e9 }),
    gpu_memory_snapshot: () => [],
    ollama_status: () => "stopped",
    list_ollama_models_detailed: () => [],
    list_local_drivers: () => [],
    ...extra,
  };
  invokeMock.mockImplementation(async (cmd: string) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked ${cmd}`);
    return h();
  });
}

beforeEach(() => {
  resetOllamaStatusPoller();
  listenMock.mockImplementation(async (_event, handler) => {
    progress = (line) => (handler as (e: { payload: { line: string } }) => void)({ payload: { line } });
    return () => {};
  });
});

afterEach(() => {
  cleanup();
  resetOllamaStatusPoller();
  invokeMock.mockReset();
  listenMock.mockReset();
  runInstallInTab.mockReset();
  resetInstallRuns();
  vi.useRealTimers();
});

describe("LocalModelsPage installs", () => {
  it("installs Vibe in place with a live log, then re-detects and stays open", async () => {
    let vibe = false;
    let finish: () => void = () => {};
    backend({
      vibe_is_installed: () => vibe,
      install_vibe: () =>
        new Promise<string>((r) => {
          finish = () => {
            vibe = true;
            r("ok");
          };
        }),
    });
    const onClose = vi.fn();
    render(<LocalModelsPage onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install Vibe" }));
    const busy = await screen.findByRole("button", { name: "Installing…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(listenMock).toHaveBeenCalled());
    progress("Downloading uv");
    expect((await screen.findByRole("log")).textContent).toContain("Downloading uv");
    finish();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Install Vibe" })).toBeNull());
    expect(screen.queryByRole("log")).toBeNull();
    expect(runInstallInTab).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("re-detects a Vibe install that ends after the page was left and opened again", async () => {
    let vibe = false;
    let finish: () => void = () => {};
    backend({
      vibe_is_installed: () => vibe,
      install_vibe: () =>
        new Promise<string>((r) => {
          finish = () => {
            vibe = true;
            r("ok");
          };
        }),
    });
    render(<LocalModelsPage onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install Vibe" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("install_vibe", undefined));
    cleanup();

    render(<LocalModelsPage onClose={() => {}} />);
    const busy = await screen.findByRole("button", { name: "Installing…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Install Vibe|Installing…/ })).toBeNull());
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "install_vibe")).toHaveLength(1);
  });

  it("waits on another run's lock without offering the terminal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let vibe = false;
    backend({
      vibe_is_installed: () => vibe,
      install_vibe: () => {
        throw "Vibe is already being installed or updated. Wait for that run to finish.";
      },
    });
    render(<LocalModelsPage onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install Vibe" }));
    await screen.findByText("Already being installed by another run. This page updates once it is there.");
    expect(screen.queryByRole("button", { name: "Run in terminal" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    vibe = true;
    await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Install Vibe|Installing…/ })).toBeNull());
  });

  it("offers the terminal after a failed Vibe install", async () => {
    backend({
      install_vibe: () => {
        throw "uv: network unreachable";
      },
    });
    const onClose = vi.fn();
    render(<LocalModelsPage onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install Vibe" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run in terminal" }));
    expect(runInstallInTab).toHaveBeenCalledWith("Install Vibe", "curl vibe | bash", "bash");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("installs Ollama headless on Windows and starts it", async () => {
    let ollama = false;
    backend({
      ollama_is_installed: () => ollama,
      ollama_install_strategy: () => ({ os: "windows", command: "winget install Ollama.Ollama", auto: true, download_url: "" }),
      install_ollama: () => {
        ollama = true;
        return "ok";
      },
      ensure_ollama_running: () => undefined,
    });
    const onClose = vi.fn();
    render(<LocalModelsPage onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install Ollama" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("ensure_ollama_running"));
    expect(runInstallInTab).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the terminal for Ollama's sudo script on Linux", async () => {
    backend({});
    const onClose = vi.fn();
    render(<LocalModelsPage onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install Ollama in a terminal" }));
    expect(runInstallInTab).toHaveBeenCalledWith("Install Ollama", "curl ollama | sh", "bash");
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "install_ollama")).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says why Download is disabled", async () => {
    backend({});
    render(<LocalModelsPage onClose={() => {}} />);
    const pull = await screen.findByRole("button", { name: /^Download / });
    expect((pull as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText("Install Ollama first (step 1).")).toBeTruthy();
    expect(pull.getAttribute("aria-describedby")).toBe("intro-models-pull-blocked");
  });
});
