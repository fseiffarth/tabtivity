/**
 * The intro's model pull follows `ollama-pull-progress`. A rejected `listen`
 * used to throw outside the `try`, leaving the button on "Pulling…" for good;
 * now the failure is shown and the button is back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { LocalModelsPage } from "../../components/layout/intro/LocalModelsPage";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

beforeEach(() => {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "ollama_is_installed") return true;
    if (cmd === "list_ollama_models_detailed") return [];
    if (cmd === "machine_load_snapshot") return { mem_total_bytes: 16e9 };
    if (cmd === "gpu_memory_snapshot") return [];
    return null;
  });
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  listenMock.mockReset();
});

describe("LocalModelsPage pull", () => {
  it("resets the button and shows the error when the progress listener cannot be set up", async () => {
    listenMock.mockRejectedValue(new Error("no event bus"));
    render(<LocalModelsPage onClose={() => {}} />);
    const button = await screen.findByRole("button", { name: /^Download / });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/no event bus/);
    expect(screen.getByRole("button", { name: /^Download / })).toBeTruthy();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "pull_ollama_model")).toBe(false);
  });

  it("unlistens when the pull itself fails", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "ollama_is_installed") return true;
      if (cmd === "list_ollama_models_detailed") return [];
      if (cmd === "machine_load_snapshot") return { mem_total_bytes: 16e9 };
      if (cmd === "gpu_memory_snapshot") return [];
      if (cmd === "pull_ollama_model") throw new Error("disk full");
      return null;
    });
    render(<LocalModelsPage onClose={() => {}} />);
    const button = await screen.findByRole("button", { name: /^Download / });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/disk full/);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
