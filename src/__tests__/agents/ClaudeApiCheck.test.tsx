/**
 * Settings → Manage CLIs → Claude → "API connection" (`ClaudeApiCheck`, backend
 * `claude_api_check` over `claude doctor`'s connectivity section).
 *
 * What has to hold:
 *
 *  1. **Each verdict says its own thing.** Reachable shows the HTTP status, an
 *     unreachable API its error, a session `doctor` did not test the reason.
 *  2. **Nothing runs on its own.** The check starts on the button, not on mount.
 *  3. **Only a Claude with the section is offered it** (2.1.331 and later).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { ClaudeApiCheck, versionAtLeast, type ClaudeApiCheckResult } from "../../components/settings/ClaudeApiCheck";
import { enSource as en } from "../../lib/i18n/en";

const invokeMock = vi.mocked(invoke);

const base: ClaudeApiCheckResult = {
  verdict: "ok",
  reachable: true,
  status: 200,
  elapsedMs: 142,
  error: null,
  host: "api.anthropic.com",
  via: null,
  notTested: null,
  lines: ["- API (api.anthropic.com): answered HTTP 200 in 142 ms"],
};

function answer(result: ClaudeApiCheckResult | Error) {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "claude_api_check"
      ? result instanceof Error
        ? Promise.reject(result.message)
        : Promise.resolve(result)
      : Promise.resolve(null),
  );
}

beforeEach(() => answer(base));
afterEach(cleanup);

describe("ClaudeApiCheck", () => {
  it("runs only on the button and shows the status", async () => {
    render(<ClaudeApiCheck />);
    expect(screen.getByText(en["agents.apiCheckIdle"])).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalledWith("claude_api_check");

    fireEvent.click(screen.getByText(en["agents.apiCheckRun"]));
    await waitFor(() => expect(screen.getByText("The API answered HTTP 200 in 142 ms.")).toBeTruthy());
    // The CLI's own line is shown below the verdict, without its list dash.
    expect(screen.getByText("API (api.anthropic.com): answered HTTP 200 in 142 ms")).toBeTruthy();
  });

  it("shows the error of an unreachable API", async () => {
    answer({
      ...base,
      verdict: "unreachable",
      reachable: false,
      status: null,
      error: "Connection refused (ECONNREFUSED)",
      lines: ["- API (api.anthropic.com): failed after 4 ms: Connection refused (ECONNREFUSED)"],
    });
    render(<ClaudeApiCheck />);
    fireEvent.click(screen.getByText(en["agents.apiCheckRun"]));
    await waitFor(() =>
      expect(screen.getByText("The API cannot be reached: Connection refused (ECONNREFUSED)")).toBeTruthy(),
    );
  });

  it("says why doctor tested nothing", async () => {
    answer({
      ...base,
      verdict: "notTested",
      reachable: null,
      status: null,
      elapsedMs: null,
      host: "",
      notTested: "this session uses a cloud provider or a gateway",
      lines: ["- Not tested: this session uses a cloud provider or a gateway"],
    });
    render(<ClaudeApiCheck />);
    fireEvent.click(screen.getByText(en["agents.apiCheckRun"]));
    await waitFor(() =>
      expect(screen.getByText("Not tested: this session uses a cloud provider or a gateway")).toBeTruthy(),
    );
  });

  it("shows a failure to run doctor at all", async () => {
    answer(new Error("claude doctor did not finish within 30s"));
    render(<ClaudeApiCheck />);
    fireEvent.click(screen.getByText(en["agents.apiCheckRun"]));
    await waitFor(() =>
      expect(screen.getByText("Could not run the check: claude doctor did not finish within 30s")).toBeTruthy(),
    );
  });
});

describe("versionAtLeast", () => {
  it("offers the check from 2.1.331 on", () => {
    expect(versionAtLeast("2.1.331", "2.1.331")).toBe(true);
    expect(versionAtLeast("2.1.332", "2.1.331")).toBe(true);
    expect(versionAtLeast("2.2.0", "2.1.331")).toBe(true);
    expect(versionAtLeast("3.0.0", "2.1.331")).toBe(true);
    expect(versionAtLeast("2.1.330", "2.1.331")).toBe(false);
    expect(versionAtLeast("2.0.999", "2.1.331")).toBe(false);
    expect(versionAtLeast(null, "2.1.331")).toBe(false);
  });
});
