/**
 * Settings → Updates (`UpdatesPanel`).
 *
 * The panel ends with Tabtivity running a binary it downloaded, so what is worth
 * locking in is not the layout but the shape of the conversation with the
 * backend — every one of these has a plausible-looking wrong version:
 *
 *  1. **No URL and no path ever leaves the renderer.** `download_app_update`
 *     and `install_app_update` take nothing; the backend re-checks and installs
 *     what it staged. A "helpful" refactor passing `check.asset.url` back would
 *     hand a compromised renderer the choice of what gets fetched and run.
 *  2. **Nothing is downloaded by the check.** Opening the panel asks GitHub one
 *     question; the artifact waits for a click.
 *  3. **A `manual` install offers no install.** A `.deb` copy must not be
 *     handed a button that would have Tabtivity overwrite a package manager's
 *     files — it is told where the download went instead.
 *  4. **Being up to date says so.** A check that answers "no" must render a
 *     sentence, not an empty panel that reads like a failed request.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { UpdatesPanel } from "../../components/layout/UpdatesPanel";
import type { InstallKind, StagedUpdate, UpdateCheck } from "../../types/update";
import { BRAND } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);

const CURRENT = "0.1.52";

function check(overrides: Partial<UpdateCheck> = {}): UpdateCheck {
  return {
    current: CURRENT,
    latest: "0.1.53",
    tag: "v0.1.53",
    name: `${BRAND.display} 0.1.53`,
    notes: "- something changed",
    publishedAt: "2026-08-20T10:00:00Z",
    htmlUrl: `https://github.com/fseiffarth/Project${BRAND.display}/releases/tag/v0.1.53`,
    updateAvailable: true,
    asset: {
      name: `${BRAND.slug}_0.1.53_amd64.AppImage`,
      url: `https://github.com/fseiffarth/Project${BRAND.display}/releases/download/v0.1.53/${BRAND.slug}_0.1.53_amd64.AppImage`,
      size: 120 * 1024 * 1024,
    },
    installKind: "appimage",
    ...overrides,
  };
}

function staged(kind: InstallKind): StagedUpdate {
  return {
    name: `${BRAND.slug}_0.1.53_amd64.AppImage`,
    version: "0.1.53",
    installKind: kind,
    bytes: 120 * 1024 * 1024,
  };
}

/** Answer each command, defaulting the ones a case does not care about. */
function backend(handlers: Record<string, unknown>) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd in handlers) return Promise.resolve(handlers[cmd]);
    if (cmd === "app_update_staged") return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

const calls = (cmd: string) => invokeMock.mock.calls.filter(([name]) => name === cmd);

beforeEach(() => {
  invokeMock.mockReset();
  backend({});
});

describe("UpdatesPanel", () => {
  it("checks on open and downloads nothing until asked", async () => {
    backend({ check_app_update: check() });
    render(<UpdatesPanel onBack={() => {}} />);

    await screen.findByText(new RegExp(String.raw`${BRAND.display} 0\.1\.53`));
    expect(calls("check_app_update")).toHaveLength(1);
    expect(calls("download_app_update")).toHaveLength(0);
  });

  it("asks the backend to download and install without naming a URL or a path", async () => {
    backend({ check_app_update: check(), download_app_update: staged("appimage") });
    render(<UpdatesPanel onBack={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: /^Download/ }));
    await waitFor(() => expect(calls("download_app_update")).toHaveLength(1));
    // The whole trust boundary: the payload is empty, so nothing the renderer
    // holds can select what is fetched.
    expect(calls("download_app_update")[0][1]).toBeUndefined();

    backend({
      check_app_update: check(),
      install_app_update: { restartRequired: true, installerLaunched: false, path: "/x" },
    });
    await userEvent.click(await screen.findByRole("button", { name: /^Install$/ }));
    await waitFor(() => expect(calls("install_app_update")).toHaveLength(1));
    expect(calls("install_app_update")[0][1]).toBeUndefined();

    // And it never went near the asset URL.
    const sent = JSON.stringify(invokeMock.mock.calls);
    expect(sent).not.toContain("releases/download");
  });

  it("says so when there is nothing newer, and offers no download", async () => {
    backend({ check_app_update: check({ updateAvailable: false, asset: null }) });
    render(<UpdatesPanel onBack={() => {}} />);

    await screen.findByText(/up to date/i);
    expect(screen.queryByRole("button", { name: /^Download/ })).toBeNull();
  });

  it("offers no install for a package-managed copy, only where the file went", async () => {
    backend({
      check_app_update: check({ installKind: "manual" }),
      app_update_staged: staged("manual"),
    });
    render(<UpdatesPanel onBack={() => {}} />);

    await screen.findByText(/package manager/i);
    expect(screen.queryByRole("button", { name: /^Install$/ })).toBeNull();
    expect(await screen.findByRole("button", { name: /where it was saved/i })).toBeTruthy();
  });

  it("reports a failed check, and still offers the way to the releases page", async () => {
    const RELEASES = `https://github.com/fseiffarth/Project${BRAND.display}/releases/latest`;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "check_app_update") return Promise.reject("GitHub answered 503");
      if (cmd === "app_update_releases_url") return Promise.resolve(RELEASES);
      return Promise.resolve(null);
    });
    render(<UpdatesPanel onBack={() => {}} />);

    await screen.findByText(/503/);
    expect(screen.queryByRole("button", { name: /^Download/ })).toBeNull();
    // A check that could not run is exactly when the manual route matters.
    await userEvent.click(await screen.findByRole("button", { name: /release page/i }));
    expect(calls("open_external_url")[0][1]).toEqual({ url: RELEASES });
  });
});
