import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
const openFileEntry = vi.fn();
vi.mock("../../components/files/openFileEntry", () => ({ openFileEntry: (...args: unknown[]) => openFileEntry(...args) }));

import {
  clearPathLinkCache,
  findPathCandidates,
  isLinkable,
  linkPathsInHtml,
  openPathLink,
  pathLinkContext,
  resolvePathCandidates,
  unknownPaths,
} from "../../lib/terminal/pathLinks";
import { registerPathLinkProvider } from "../../lib/terminal/pathLinkProvider";
import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { useEditorJumpStore } from "../../stores/viewers/editorJump";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import type { FileEntry } from "../../lib/viewers/fileUtils";
import type { ProjectEntry } from "../../types";

const file = (path: string, isDir = false): FileEntry => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return { name, path, is_dir: isDir, size: 1, extension: !isDir && dot > 0 ? name.slice(dot) : null, mime: null };
};

const paths = (text: string) => findPathCandidates(text).map((c) => c.path);

describe("path-shaped words", () => {
  it("finds relative, dotted and absolute paths and bare file names", () => {
    expect(paths("see docs/plan.md and ./src/a.ts, then ../up/b.rs.")).toEqual(["docs/plan.md", "./src/a.ts", "../up/b.rs"]);
    expect(paths("edit /home/me/x/README.md or AGENTS.md")).toEqual(["/home/me/x/README.md", "AGENTS.md"]);
    expect(paths("the `src/lib/` folder and .github/workflows/ci.yml and .gitignore")).toEqual(["src/lib/", ".github/workflows/ci.yml", ".gitignore"]);
    expect(paths("**docs/x.md** (src/y.ts) [a/b.md](a/b.md) \"q/r.txt\"")).toEqual(["docs/x.md", "src/y.ts", "a/b.md", "a/b.md", "q/r.txt"]);
  });

  it("takes the line a path names along, inside the link", () => {
    const text = "at src/a.ts:120: and b.ts:7:3 and c.md#L5 and d.rs:10-20";
    const found = findPathCandidates(text);
    expect(found.map(({ path, line, column }) => ({ path, line, column }))).toEqual([
      { path: "src/a.ts", line: 120, column: undefined },
      { path: "b.ts", line: 7, column: 3 },
      { path: "c.md", line: 5, column: undefined },
      { path: "d.rs", line: 10, column: undefined },
    ]);
    expect(text.slice(found[0].start, found[0].end)).toBe("src/a.ts:120");
    expect(text.slice(found[1].start, found[1].end)).toBe("b.ts:7:3");
  });

  it("passes over URLs, numbers, versions and prose", () => {
    expect(paths("https://example.com/a/b.md and file:///x/y.md")).toEqual([]);
    expect(paths("3.5 of v0.1.111, 1/2 of it, and/or this — e.g. that")).toEqual(["and/or", "e.g"]);
    expect(paths("a//b.md / . ..")).toEqual([]);
  });

  it("finds Windows paths: backslashes, a drive, `.\\`", () => {
    const text = "see src\\a.ts:120 in C:\\Users\\x\\p\\src\\a.ts, .\\src\\a.ts and ..\\up\\b.rs";
    const found = findPathCandidates(text);
    expect(found.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: "src\\a.ts", line: 120 },
      { path: "C:\\Users\\x\\p\\src\\a.ts", line: undefined },
      { path: ".\\src\\a.ts", line: undefined },
      { path: "..\\up\\b.rs", line: undefined },
    ]);
    expect(text.slice(found[0].start, found[0].end)).toBe("src\\a.ts:120");
    expect(paths("the `src\\lib\\` folder and D:\\x\\.gitignore")).toEqual(["src\\lib\\", "D:\\x\\.gitignore"]);
    // Not paths: TeX commands, escaped strings, a bare drive, a lone root.
    expect(paths("\\section{x} \\textbf a\\\\b.md C: C:\\ \\")).toEqual([]);
  });
});

describe("where paths are looked up", () => {
  it("under the tab's folder, then its project's — none for a remote or unknown project", () => {
    expect(pathLinkContext("p", "/proj", "/proj/sub").bases).toEqual(["/proj/sub", "/proj"]);
    expect(pathLinkContext("p", "/proj", "/proj").bases).toEqual(["/proj"]);
    expect(pathLinkContext("p", "", "/remote/dir").bases).toEqual([]);
    expect(pathLinkContext("p", null, "/x").bases).toEqual([]);
    expect(pathLinkContext(null, null, "/home/me")).toMatchObject({ bases: ["/home/me"], projectDir: "" });
    expect(pathLinkContext(null, null, "").bases).toEqual([]);
  });
});

describe("resolving paths", () => {
  beforeEach(() => {
    clearPathLinkCache();
    invoke.mockReset();
  });

  it("asks the backend once for what it does not know yet", async () => {
    invoke.mockResolvedValueOnce([file("/p/docs/plan.md"), null]);
    const first = await resolvePathCandidates(["/p"], ["docs/plan.md", "nope.md", "docs/plan.md"]);
    expect(invoke).toHaveBeenCalledWith("resolve_text_paths", { bases: ["/p"], candidates: ["docs/plan.md", "nope.md"] });
    expect([...first.keys()]).toEqual(["docs/plan.md"]);
    const again = await resolvePathCandidates(["/p"], ["docs/plan.md", "nope.md"]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(again.get("docs/plan.md")?.path).toBe("/p/docs/plan.md");
  });

  it("asks nothing without folders", async () => {
    expect((await resolvePathCandidates([], ["a/b.md"])).size).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("links only what opens in the app", () => {
    expect(isLinkable(file("/p/a.md"), "/p")).toBe(true);
    expect(isLinkable(file("/p/run.sh.desktop"), "/p")).toBe(false);
    expect(isLinkable(file("/p/docs", true), "/p")).toBe(true);
    expect(isLinkable(file("/elsewhere/docs", true), "/p")).toBe(false);
    expect(isLinkable(file("/home/docs", true), "")).toBe(false);
  });

  it("lists the words of a conversation not looked up yet", () => {
    expect(unknownPaths(["see a/b.md", "and c.ts or a/b.md"], new Map([["c.ts", null]]))).toEqual(["a/b.md"]);
  });
});

describe("chat markup", () => {
  it("makes found paths file links, leaving links and other words alone", () => {
    const links = new Map<string, FileEntry | null>([["docs/plan.md", file("/p/docs/plan.md")], ["x.md", null]]);
    const html = linkPathsInHtml("<p>Read <code>docs/plan.md:12</code>, x.md and <span class=\"md-link\">docs/plan.md</span></p>", links);
    const box = document.createElement("div");
    box.innerHTML = html;
    const anchors = box.querySelectorAll("a.file-link");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].textContent).toBe("docs/plan.md:12");
    expect(anchors[0].getAttribute("data-path-link")).toBe("docs/plan.md");
    expect(anchors[0].getAttribute("data-line")).toBe("12");
    expect(anchors[0].hasAttribute("href")).toBe(false);
    expect(box.textContent).toBe("Read docs/plan.md:12, x.md and docs/plan.md");
  });

  it("returns the markup untouched when nothing is found", () => {
    expect(linkPathsInHtml("<p>a/b.md</p>", new Map())).toBe("<p>a/b.md</p>");
  });
});

describe("opening a path link", () => {
  beforeEach(() => openFileEntry.mockReset());
  const t = (key: string) => key;

  it("opens the file's viewer and scrolls to the line", () => {
    const requestJump = vi.spyOn(useEditorJumpStore.getState(), "requestJump").mockImplementation(() => {});
    useTabsStore.setState({ scope: "p" });
    openPathLink(file("/p/src/a.ts"), { line: 12, column: 3 }, { scope: "p", projectId: "p", projectDir: "/p", cwd: "/p", t });
    expect(openFileEntry).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ path: "/p/src/a.ts" }), projectDir: "/p", projectId: "p", external: false, scope: undefined,
    }));
    expect(requestJump).toHaveBeenCalledWith("/p/src/a.ts", 12, 3);
    requestJump.mockRestore();
  });

  it("opens in the link's own scope when that is not the shown one", () => {
    useTabsStore.setState({ scope: "p" });
    openPathLink(file("/home/me/notes.md"), {}, { scope: "root", projectId: null, projectDir: "", cwd: "/home/me", t });
    expect(openFileEntry).toHaveBeenCalledWith(expect.objectContaining({ projectDir: "/home/me", scope: "root" }));
  });

  it("never hands a file without a viewer to the OS", () => {
    openPathLink(file("/p/tool.desktop"), {}, { scope: "p", projectId: "p", projectDir: "/p", cwd: "/p", t });
    expect(openFileEntry).not.toHaveBeenCalled();
  });
});

describe("the terminal's path links", () => {
  beforeEach(() => {
    clearPathLinkCache();
    invoke.mockReset();
  });

  /** One terminal row: each character one cell, `中` two. */
  function row(text: string) {
    const cells: string[] = [];
    for (const ch of text) {
      cells.push(ch);
      if (ch === "中") cells.push("");
    }
    return {
      isWrapped: false,
      translateToString: () => text,
      getCell: (x: number) => (x < cells.length ? { getChars: () => cells[x], getWidth: () => (cells[x] ? 1 : 0) } : undefined),
    };
  }

  it("underlines the existing paths of a hovered row, cells counted past wide glyphs", async () => {
    const line = row("中 edit src/a.ts:3 or gone.md");
    let provider: { provideLinks: (y: number, reply: (links: unknown) => void) => void } | null = null;
    const term = {
      cols: 80,
      buffer: { active: { getLine: () => line } },
      registerLinkProvider: (p: typeof provider) => { provider = p; return { dispose() {} }; },
    };
    invoke.mockResolvedValueOnce([file("/p/src/a.ts"), null]);
    const activate = vi.fn();
    registerPathLinkProvider(term as never, () => ({ bases: ["/p"], projectDir: "/p" }), { activate, hover: vi.fn(), leave: vi.fn() });
    const links = await new Promise<{ range: unknown; text: string; activate: (e: MouseEvent) => void }[]>((resolve) =>
      provider!.provideLinks(1, (l) => resolve(l as never)));
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("src/a.ts:3");
    // "中" takes cells 1–2, so "src" starts at cell 9 (1-based), and the link
    // ends on its last cell, 18.
    expect(links[0].range).toEqual({ start: { x: 9, y: 1 }, end: { x: 18, y: 1 } });
    links[0].activate(new MouseEvent("click"));
    expect(activate).toHaveBeenCalledWith(expect.any(MouseEvent), expect.objectContaining({ path: "/p/src/a.ts" }), expect.objectContaining({ line: 3 }));
  });

  it("answers nothing without folders, before reading the row", () => {
    const getLine = vi.fn();
    let provider: { provideLinks: (y: number, reply: (links: unknown) => void) => void } | null = null;
    const term = { cols: 80, buffer: { active: { getLine } }, registerLinkProvider: (p: typeof provider) => { provider = p; return { dispose() {} }; } };
    registerPathLinkProvider(term as never, () => ({ bases: [], projectDir: "" }), { activate: vi.fn(), hover: vi.fn(), leave: vi.fn() });
    const reply = vi.fn();
    provider!.provideLinks(1, reply);
    expect(reply).toHaveBeenCalledWith(undefined);
    expect(getLine).not.toHaveBeenCalled();
  });
});

describe("the Reader's path links", () => {
  const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "s-1", launchedAt: 1000 };
  let host: HTMLElement;
  beforeEach(() => {
    clearPathLinkCache();
    localStorage.clear();
    invoke.mockReset();
    openFileEntry.mockReset();
    invoke.mockImplementation((command: string, args?: { candidates?: string[] }) => {
      if (command === "agent_tab_transcript") {
        return Promise.resolve({
          available: true,
          version: "v1",
          truncated: false,
          entries: [{ kind: "answer", text: "Wrote `docs/plan.md` — see also nope.md.", at: "2026-10-06T08:00:00Z" }],
        });
      }
      if (command === "resolve_text_paths") {
        return Promise.resolve((args?.candidates ?? []).map((c) => (c === "docs/plan.md" ? file("/p/docs/plan.md") : null)));
      }
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

  it("draws an answer with its existing paths already linked, and a click opens the file", async () => {
    render(<TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused />);
    const link = await screen.findByText("docs/plan.md");
    expect(link.tagName).toBe("A");
    expect(link.className).toBe("file-link");
    expect(screen.getByText(/nope\.md/).tagName).not.toBe("A");
    expect(invoke).toHaveBeenCalledWith("resolve_text_paths", { bases: ["/p"], candidates: ["docs/plan.md", "nope.md"] });
    fireEvent.mouseOver(link);
    expect(document.body.querySelector(".link-open-hint")?.textContent).toContain("docs/plan.md · Open in a tab");
    await act(async () => { fireEvent.click(link); });
    expect(openFileEntry).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ path: "/p/docs/plan.md" }), projectId: "p", external: false,
    }));
    await waitFor(() => expect(document.body.querySelector(".link-open-hint")).toBeNull());
  });

  it("asks nothing for a remote project's chat", async () => {
    useProjectsStore.setState({ projects: [{ id: "p", name: "P", directory: "/p", local_file: "/p/project.json", remote: { host: "h" } } as unknown as ProjectEntry] });
    render(<TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused />);
    const word = await screen.findByText("docs/plan.md");
    expect(word.tagName).toBe("CODE");
    expect(invoke).not.toHaveBeenCalledWith("resolve_text_paths", expect.anything());
  });
});
