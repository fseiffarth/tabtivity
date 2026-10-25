import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
const openFileEntry = vi.fn();
vi.mock("../../components/files/openFileEntry", () => ({ openFileEntry: (...args: unknown[]) => openFileEntry(...args) }));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { clearPathLinkCache } from "../../lib/terminal/pathLinks";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";
import type { FileEntry } from "../../lib/viewers/fileUtils";

const file = (path: string, size = 10): FileEntry => {
  const name = path.split("/").pop() ?? path;
  return { name, path, is_dir: false, size, extension: /\.[^.]+$/u.exec(name)?.[0] ?? null, mime: null };
};
const ON_DISK: Record<string, FileEntry> = {
  "figs/plot.png": file("/p/figs/plot.png"),
  "paper.pdf": file("/p/paper.pdf", 2048),
  "src/a.ts": file("/p/src/a.ts"),
  "huge.png": file("/p/huge.png", 64 * 1024 * 1024),
};

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "s-1", launchedAt: 1000 };

describe("the Reader's answer previews", () => {
  let host: HTMLElement;
  let answer = "";
  beforeEach(() => {
    localStorage.clear();
    clearPathLinkCache();
    invoke.mockReset();
    openFileEntry.mockReset();
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:plot"), revokeObjectURL: vi.fn() });
    invoke.mockImplementation((command: string, args?: { candidates?: string[] }) => {
      if (command === "agent_tab_transcript") {
        return Promise.resolve({
          available: true, version: "v1", truncated: false,
          entries: [
            { kind: "prompt", text: "show me the plot", at: "2026-10-22T08:00:00Z" },
            { kind: "answer", text: answer, at: "2026-10-22T08:00:05Z" },
          ],
        });
      }
      if (command === "resolve_text_paths") return Promise.resolve((args?.candidates ?? []).map((path) => ON_DISK[path] ?? null));
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

  it("draws the pictures and PDFs an answer names under its words, never its code files", async () => {
    answer = "Here it is: `figs/plot.png`, from `paper.pdf` (made by src/a.ts).";
    mount();
    const picture = await screen.findByRole("button", { name: /plot\.png/u });
    expect(picture.querySelector("img")?.getAttribute("src")).toBe("blob:plot");
    expect(screen.getByRole("button", { name: /paper\.pdf/u }).textContent).toContain("PDF");
    expect(document.querySelectorAll(".terminal-reader-turn.agent .inbox-album button")).toHaveLength(2);
    expect(invoke).toHaveBeenCalledWith("read_file_bytes", { path: "/p/figs/plot.png", projectId: "p" });
    expect(invoke).not.toHaveBeenCalledWith("read_file_bytes", { path: "/p/paper.pdf", projectId: "p" });
    // The words keep their links.
    expect(document.querySelector('.terminal-reader-turn.agent a.file-link[data-path-link="figs/plot.png"]')).not.toBeNull();
  });

  it("opens the file in its viewer tab on a click", async () => {
    answer = "See figs/plot.png";
    mount();
    const picture = await screen.findByRole("button", { name: /plot\.png/u });
    await act(async () => { fireEvent.click(picture); });
    expect(openFileEntry).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ path: "/p/figs/plot.png" }), projectId: "p", external: false,
    }));
  });

  it("shows a too-big picture as a card without reading it", async () => {
    answer = "The raw dump is huge.png";
    mount();
    const card = await screen.findByRole("button", { name: /huge\.png/u });
    expect(card.querySelector("img")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("read_file_bytes", expect.objectContaining({ path: "/p/huge.png" }));
  });

  it("draws nothing for an answer naming no picture or PDF", async () => {
    answer = "Changed src/a.ts and docs/missing.png";
    mount();
    await waitFor(() => expect(document.querySelector('a.file-link[data-path-link="src/a.ts"]')).not.toBeNull());
    expect(document.querySelector(".inbox-album")).toBeNull();
  });
});
