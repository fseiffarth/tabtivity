/**
 * The Copilot card (#45a): the account line follows the server's verdict
 * (`copilot_account`), a failed sign-in has its own line, and the Details fold
 * reads `copilot_diagnostics` — tolerating a backend without it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn(() => Promise.resolve(() => {})) }));

let settings: Record<string, unknown> = {};
const mockUpdateSettings = vi.fn();
vi.mock("../../stores/settings", () => {
  const state = () => ({ settings, updateSettings: mockUpdateSettings });
  return {
    SETTINGS_CHANGED_EVENT: "settings-changed",
    useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(state()), { getState: state }),
  };
});
vi.mock("../../stores/projects", () => {
  const state = { projects: [{ id: "proj", name: "Proj", directory: "/p" }], activeId: "proj" };
  return {
    useProjectsStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), { getState: () => state }),
  };
});

type Account = { running: boolean; status?: { kind: string; message: string | null }; account?: { status?: string; user?: string } };

function backend(account: Account, extra: (cmd: string, args: unknown) => unknown = () => undefined) {
  mockInvoke.mockImplementation((cmd: string, args: unknown) => {
    const handled = extra(cmd, args);
    if (handled !== undefined) return handled;
    if (cmd === "copilot_setup") return Promise.resolve({ supported: true, installed: true, installCommand: null });
    if (cmd === "copilot_account") return Promise.resolve(account);
    return Promise.resolve(null);
  });
}

async function renderCard() {
  const { CopilotCompletionCard } = await import("../../components/layout/CopilotCompletionCard");
  await act(async () => { render(<CopilotCompletionCard />); });
}

describe("Copilot card account and details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = {
      code_completion_provider: "copilot",
      completion_project_policies: { proj: { directory: "/p", copilot: true, local_only: false } },
    };
  });

  it("is signed in only for OK or MaybeOK", async () => {
    backend({ running: true, account: { status: "MaybeOK", user: "octo" } });
    await renderCard();
    await waitFor(() => expect(screen.getByText("Signed in as octo.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("says when the account has no Copilot access, and offers to switch", async () => {
    backend({ running: true, account: { status: "NotAuthorized", user: "octo" } });
    await renderCard();
    await waitFor(() => expect(screen.getByText(/Signed in as octo, but this GitHub account has no Copilot access\./)).toBeTruthy());
    expect(screen.queryByText("Signed in as octo.")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("a user name without a good verdict is not signed in", async () => {
    backend({ running: true, account: { status: "NotSignedIn", user: "octo" } });
    await renderCard();
    await waitFor(() => expect(screen.getByText("Not signed in for this project.")).toBeTruthy());
  });

  it("a refused device flow gets its own line", async () => {
    backend({ running: true, account: { status: "NotSignedIn" } }, (cmd) =>
      cmd === "copilot_sign_in" ? Promise.reject("copilot_sign_in_failed") : undefined);
    await renderCard();
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub" })); });
    expect(screen.getByText(/The sign-in did not finish/)).toBeTruthy();
    expect(screen.queryByText(/Copilot: copilot_sign_in_failed/)).toBeNull();
  });

  it("Details reads the server log on open and on Refresh", async () => {
    let lines = ["[info] started"];
    backend({ running: true, account: { status: "OK", user: "octo" } }, (cmd, args) => {
      if (cmd !== "copilot_diagnostics") return undefined;
      expect(args).toEqual({ projectId: "proj" });
      return Promise.resolve({ lines });
    });
    await renderCard();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "copilot_diagnostics")).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Details/ })); });
    expect(screen.getByText("[info] started")).toBeTruthy();
    lines = ["[info] started", "[warn] retry"];
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })); });
    expect(screen.getByText(/\[warn\] retry/)).toBeTruthy();
  });

  it("Details tolerates a backend without the command", async () => {
    backend({ running: true, account: { status: "OK", user: "octo" } }, (cmd) =>
      cmd === "copilot_diagnostics" ? Promise.reject("command copilot_diagnostics not found") : undefined);
    await renderCard();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Details/ })); });
    expect(screen.getByText("This build cannot show the server log.")).toBeTruthy();
  });
});
