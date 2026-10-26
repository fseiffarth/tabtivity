import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
const openFileEntry = vi.fn();
vi.mock("../../lib/files/openFileEntry", () => ({ openFileEntry: (...args: unknown[]) => openFileEntry(...args) }));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { NAMES } from "../../lib/brand";
import { resetInboxFiles } from "../../../mobile-web/src/terminal/inboxRefs";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";

const PNG = "20261015-101500-shot.png";
const PDF = "20261015-101501-paper.pdf";
const GONE = "20261015-101502-old.png";
const ref = (leaf: string) => `@${NAMES.inboxDir}/${leaf}`;

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "s-1", launchedAt: 1000 };
const prompt = `look at these ${ref(PNG)} ${ref(PDF)} ${ref(GONE)} `;

describe("the Reader's inbox previews", () => {
  let host: HTMLElement;
  beforeEach(() => {
    localStorage.clear();
    resetInboxFiles();
    invoke.mockReset();
    openFileEntry.mockReset();
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:shot"), revokeObjectURL: vi.fn() });
    invoke.mockImplementation((command: string, args?: { names?: string[] }) => {
      if (command === "agent_tab_transcript") {
        return Promise.resolve({ available: true, version: "v1", truncated: false, entries: [{ kind: "prompt", text: prompt, at: "2026-10-15T08:00:00Z" }] });
      }
      if (command === "project_inbox_describe") {
        const known: Record<string, { kind: string; size: number }> = { [PNG]: { kind: "image/png", size: 10 }, [PDF]: { kind: "application/pdf", size: 2048 } };
        return Promise.resolve((args?.names ?? []).filter((name) => known[name]).map((name) => ({ name, original: name.slice(16), modified: 0, ...known[name] })));
      }
      if (command === "read_file_bytes") return Promise.resolve(new Uint8Array([1, 2, 3]).buffer);
      return Promise.resolve([]);
    });
    useProjectsStore.setState({ projects: [{ id: "p", name: "P", directory: "/p", local_file: "/p/project.json" } as unknown as ProjectEntry] });
    useTabsStore.setState((state) => ({ ...state, scope: "p", tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ byAgent: {} });
    useAgentClearUndoStore.setState({ cleared: {}, marks: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    host.remove();
    useProjectsStore.setState({ projects: [] });
  });

  const mount = () => render(<TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused />);

  it("draws a prompt's inbox files as a picture and cards in its bubble, not as @ text", async () => {
    mount();
    const open = await screen.findByRole("button", { name: /shot\.png/u });
    expect(open.querySelector("img")?.getAttribute("src")).toBe("blob:shot");
    expect(screen.getByText("paper.pdf")).toBeTruthy();
    expect(screen.getByText(/old\.png/u)).toBeTruthy();
    expect(screen.getByText("look at these")).toBeTruthy();
    expect(document.querySelector(".terminal-reader-turn.user.with-files")).not.toBeNull();
    expect(document.querySelector(".terminal-reader-md")?.textContent).not.toContain(NAMES.inboxDir);
    expect(invoke).toHaveBeenCalledWith("project_inbox_describe", { projectId: "p", names: [PNG, PDF, GONE] });
    expect(invoke).toHaveBeenCalledWith("read_file_bytes", { path: `/p/${NAMES.inboxDir}/${PNG}`, projectId: "p" });
  });

  it("opens a file in its viewer tab on a click", async () => {
    mount();
    const picture = await screen.findByRole("button", { name: /shot\.png/u });
    await act(async () => { fireEvent.click(picture); });
    expect(openFileEntry).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ path: `/p/${NAMES.inboxDir}/${PNG}`, extension: ".png" }), projectId: "p", external: false,
    }));
  });

  it("keeps the plain references and asks nothing for a remote project", async () => {
    useProjectsStore.setState({ projects: [{ id: "p", name: "P", directory: "/p", local_file: "/p/project.json", remote: { host: "h" } } as unknown as ProjectEntry] });
    mount();
    await waitFor(() => expect(document.querySelector(".terminal-reader-md")?.textContent).toContain(ref(PNG)));
    expect(document.querySelector(".inbox-album")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("project_inbox_describe", expect.anything());
  });
});
