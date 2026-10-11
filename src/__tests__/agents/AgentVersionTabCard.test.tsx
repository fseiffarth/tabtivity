/**
 * The agent tab's "CLI is newer than Tabtivity was checked with" card
 * (`TerminalVersionCard`, `stores/agents/agentVersionNotice`).
 *
 *  1. Only *newer* drift speaks; older drift, a match, and an already-dismissed
 *     release stay quiet on the tab (Manage Agents still lists them).
 *  2. Concurrent panes share one read; a later focus reads the cache again.
 *  3. × hides for this window; the button persists the dismissal by version.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { TerminalVersionCard } from "../../components/terminal/TerminalVersionCard";
import {
  newerNotice,
  resetAgentVersionNotice,
  useAgentVersionNoticeStore,
} from "../../stores/agents/agentVersionNotice";

const invokeMock = vi.mocked(invoke);

const report = (overrides: Record<string, unknown> = {}) => ({
  agent: "claude",
  label: "Claude Code",
  version: "2.1.290",
  state: "moved" as const,
  stale: [{ version: "2.1.282", surface: "§1.1", direction: "newer" as const }],
  dismissed: false,
  ...overrides,
});

function mockVersions(rows: unknown[]) {
  invokeMock.mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "agent_versions" ? rows : null),
  );
}

function host() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

describe("agent tab version card", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetAgentVersionNotice();
    document.body.innerHTML = "";
  });

  it("speaks only for newer drift", () => {
    expect(newerNotice(report())).toMatchObject({ installed: "2.1.290", verified: "2.1.282" });
    expect(
      newerNotice(report({ stale: [{ version: "2.1.282", surface: "x", direction: "older" }] })),
    ).toBeNull();
    expect(newerNotice(report({ state: "match", stale: [] }))).toBeNull();
    expect(newerNotice(report({ dismissed: true }))).toBeNull();
  });

  it("hides the checked Codex release while the running backend still has its old table", async () => {
    const oldBackend = report({
      agent: "codex",
      version: "0.161.0",
      stale: [
        { version: "0.157.0", surface: "mode lines", direction: "newer" },
        { version: "0.159.2", surface: "model sheet", direction: "newer" },
      ],
    });
    expect(newerNotice(oldBackend)).toBeNull();
    expect(newerNotice({ ...oldBackend, version: "0.161.1" })?.installed).toBe("0.161.1");
    mockVersions([oldBackend]);
    const pane = host();
    render(<TerminalVersionCard host={pane} cmd="codex" />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("agent_versions", { refresh: false }));
    expect(pane.querySelector(".terminal-version-drift")).toBeNull();
  });

  it("names the closest verified release when several checks are newer-stale", () => {
    const notice = newerNotice(
      report({
        agent: "codex",
        version: "0.160.0",
        stale: [
          { version: "0.151.0", surface: "a", direction: "newer" },
          { version: "0.157.0", surface: "b", direction: "newer" },
        ],
      }),
    );
    expect(notice?.verified).toBe("0.157.0");
  });

  it("shows on the matching agent's tab, from one unforced read shared by all panes", async () => {
    mockVersions([report()]);
    const a = host();
    const b = host();
    render(
      <>
        <TerminalVersionCard host={a} cmd="claude" />
        <TerminalVersionCard host={b} cmd="claude" />
        <TerminalVersionCard host={host()} cmd="codex" />
      </>,
    );
    await waitFor(() => expect(a.textContent).toContain("2.1.290"));
    expect(b.textContent).toContain("2.1.282");
    const reads = invokeMock.mock.calls.filter(([cmd]) => cmd === "agent_versions");
    expect(reads).toEqual([["agent_versions", { refresh: false }]]);
    expect(screen.getAllByRole("status")).toHaveLength(2);
  });

  it("replaces a stale installed version when the window regains focus", async () => {
    mockVersions([report({ version: "2.1.290" })]);
    const a = host();
    render(<TerminalVersionCard host={a} cmd="claude" />);
    await waitFor(() => expect(a.textContent).toContain("2.1.290"));

    mockVersions([report({ version: "2.1.299" })]);
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(a.textContent).toContain("2.1.299"));
    expect(a.textContent).not.toContain("2.1.290");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "agent_versions")).toHaveLength(2);
  });

  it("× hides it for the window without persisting anything", async () => {
    mockVersions([report()]);
    const a = host();
    render(<TerminalVersionCard host={a} cmd="claude" />);
    await waitFor(() => expect(a.textContent).toContain("2.1.290"));
    await userEvent.click(screen.getByRole("button", { name: "Hide until restart" }));
    expect(a.textContent).toBe("");
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "dismiss_agent_version")).toBe(false);
  });

  it("the button dismisses this version persistently", async () => {
    mockVersions([report()]);
    const a = host();
    render(<TerminalVersionCard host={a} cmd="claude" />);
    await waitFor(() => expect(a.textContent).toContain("2.1.290"));
    await userEvent.click(screen.getByRole("button", { name: /2\.1\.290/ }));
    expect(invokeMock).toHaveBeenCalledWith("dismiss_agent_version", {
      agent: "claude",
      version: "2.1.290",
    });
    expect(a.textContent).toBe("");
  });

  it("a dismissal from Manage Agents clears the tab card", async () => {
    mockVersions([report()]);
    const a = host();
    render(<TerminalVersionCard host={a} cmd="claude" />);
    await waitFor(() => expect(a.textContent).toContain("2.1.290"));
    act(() => useAgentVersionNoticeStore.getState().noteDismissed("claude", "2.1.290"));
    expect(a.textContent).toBe("");
  });
});
