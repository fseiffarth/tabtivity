/**
 * The TeX workspace single-tab contract (Implementer B's slice):
 *  (a) `openTexWorkspace` mints exactly ONE workspace tab keyed on the resolved
 *      build root; opening a child of an already-open workspace focuses + centers
 *      it rather than spawning a second tab.
 *  (b) Clicking a sidebar entry switches the center via `setViewerState`
 *      (texActivePath) — never `addTab`.
 *  (c) A compile opens the PDF as its OWN tab (not docked) beside the workspace;
 *      the forward-search reveal targets that PDF's path.
 *  (d) A reverse-search from the (standalone) PDF routes back INTO the workspace,
 *      switching the center to the producing in-structure child and reaching it
 *      via `requestJump` — no scattered standalone source tab.
 *
 * The real `PdfView` pulls pdf.js (which jsdom can't run), so it is stubbed to a
 * bare marker; every other component (the sidebar, the center `TexView`) is the
 * real one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, renderHook, screen, act, waitFor, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NAMES } from "../../lib/brand";

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
// Cross-window broadcasts are no-ops in tests. `listen` must resolve to an
// unlisten fn — modules register listeners at import and call `.catch()` on it.
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));

// Settings store: callable selector AND a getState (the structure effect reads
// viewer_prefs via getState).
vi.mock("../../stores/settings", () => {
  const state = { settings: { autosave: false, viewer_prefs: {}, debug: false } };
  const useSettingsStore = Object.assign((sel: (s: unknown) => unknown) => sel(state), {
    getState: () => state,
  });
  return { useSettingsStore };
});

// Stub the PDF viewer: jsdom can't run pdf.js. Keep every other export intact so
// the rest of the viewer graph is unaffected.
vi.mock("../../components/embed/pdf/PdfViewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/embed/pdf/PdfViewer")>();
  const React = await import("react");
  return {
    ...actual,
    PdfView: (props: { path: string }) =>
      React.createElement("div", { "data-testid": "pdf-view", "data-path": props.path }),
  };
});

const MAIN = "/p/main.tex";
const CHILD = "/p/chap.tex";
const MAIN_SRC = "\\documentclass{article}\n\\begin{document}\n\\input{chap}\nHi\n\\end{document}\n";
const CHILD_SRC = "\\section{Chapter}\nchild body\n";

/** Wire the backend mock for a compilable one-child document. */
function setupInvoke(
  syncRects: Array<{ page: number; x: number; y: number; w: number; h: number }> = [],
  engines: string[] = ["pdflatex"],
) {
  const files: Record<string, string> = { [MAIN]: MAIN_SRC, [CHILD]: CHILD_SRC };
  mockInvoke.mockImplementation((
    cmd: string,
    args?: Record<string, unknown>,
    opts?: { headers?: Record<string, string> },
  ) => {
    switch (cmd) {
      case "tex_capability":
        return Promise.resolve({ available: true, engines, bibtex: false, latexmk: false });
      case "read_file_text": {
        const text = files[(args?.path as string) ?? ""];
        return text != null ? Promise.resolve(text) : Promise.reject(new Error("missing"));
      }
      case "write_file_text": {
        // Recorded, so the ＋ (new file) test can assert the spliced \input.
        files[(args?.path as string) ?? ""] = (args?.content as string) ?? "";
        return Promise.resolve(null);
      }
      case "write_file_bytes": {
        // Bytes ride as the raw body; the path is a header (see fileAccess.ts).
        const p = decodeURIComponent(opts?.headers?.[NAMES.filePathHeader] ?? "");
        files[p] = "";
        return Promise.resolve(null);
      }
      case "resolve_tex_root":
        // A child resolves to the main; the main resolves to itself.
        return Promise.resolve((args?.path as string) === CHILD ? MAIN : (args?.path as string));
      case "compile_tex":
        return Promise.resolve({
          success: true,
          pdf_path: "/p/main.pdf",
          engine: "pdflatex",
          log: "ok",
          shell_escape: false,
        });
      case "synctex_view":
        return Promise.resolve(syncRects);
      case "synctex_edit":
        return Promise.resolve(null);
      case "file_mtime": {
        // Answers only for files that exist — texPathExists reads a failed stat
        // as absence, which is what lets the ＋ create a missing child.
        const p = (args?.path as string) ?? "";
        return files[p] != null ? Promise.resolve(1) : Promise.reject(new Error("missing"));
      }
      case "list_dir":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  });
  return files;
}

async function resetStores() {
  const { useTabsStore } = await import("../../stores/tabs");
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  const { useEditorJumpStore } = await import("../../stores/viewers/editorJump");
  useEditorJumpStore.setState({ requestsByPath: {} });
  const { usePdfSyncStore } = await import("../../stores/viewers/pdfSync");
  usePdfSyncStore.setState({ byPath: {} });
}

describe("openTexWorkspace — one tab per document", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    setupInvoke();
    await resetStores();
  });

  it("mints exactly one workspace tab keyed on the resolved root", async () => {
    const { openTexWorkspace } = await import("../../components/embed/openTexWorkspace");
    const { useTabsStore } = await import("../../stores/tabs");
    useTabsStore.getState().setScope("p");

    await openTexWorkspace(MAIN);
    const tabs = useTabsStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: "embed", viewer: "texworkspace", embedPath: MAIN });

    // Opening the SAME main again just refocuses — no second tab.
    await openTexWorkspace(MAIN);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it("opening a child focuses the existing workspace and centers the child (no 2nd tab)", async () => {
    const { openTexWorkspace } = await import("../../components/embed/openTexWorkspace");
    const { useTabsStore } = await import("../../stores/tabs");
    useTabsStore.getState().setScope("p");

    await openTexWorkspace(MAIN);
    const key = useTabsStore.getState().tabs[0].key;

    // A child resolves to the same root → same tab, centered on the child.
    await openTexWorkspace(CHILD);
    const tabs = useTabsStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].key).toBe(key);
    expect(tabs[0].viewerState?.texActivePath).toBe(CHILD);
  });

  it("adopts a legacy bare `tex` tab on the root instead of opening a second tab", async () => {
    const { openTexWorkspace } = await import("../../components/embed/openTexWorkspace");
    const { useTabsStore } = await import("../../stores/tabs");
    useTabsStore.getState().setScope("p");

    // The shape a `.tex` tab saved before the one-workspace-per-document policy
    // comes back in: `viewer` is persisted, so it restores as a plain editor —
    // no structure sidebar — and used to sit there while a re-open minted a
    // second tab beside it.
    const legacy = useTabsStore.getState().addTab({
      label: "main.tex",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: MAIN,
      viewer: "tex",
      viewerState: { scrollTop: 2382 },
    });

    await openTexWorkspace(MAIN);
    const tabs = useTabsStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].key).toBe(legacy.key); // same tab, healed in place
    expect(tabs[0].viewer).toBe("texworkspace");
    expect(tabs[0].viewerState?.scrollTop).toBe(2382); // position kept
  });

  it("leaves a CHILD editor tab a plain editor (it is not the root)", async () => {
    const { openTexWorkspace } = await import("../../components/embed/openTexWorkspace");
    const { useTabsStore } = await import("../../stores/tabs");
    useTabsStore.getState().setScope("p");

    const child = useTabsStore.getState().addTab({
      label: "child.tex",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: CHILD,
      viewer: "tex",
    });

    await openTexWorkspace(MAIN);
    const tabs = useTabsStore.getState().tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.key === child.key)?.viewer).toBe("tex");
    expect(tabs.find((t) => t.key !== child.key)?.viewer).toBe("texworkspace");
  });

  it("centers on the root (not undefined) when the main itself is re-opened", async () => {
    const { openTexWorkspace } = await import("../../components/embed/openTexWorkspace");
    const { useTabsStore } = await import("../../stores/tabs");
    useTabsStore.getState().setScope("p");
    await openTexWorkspace(CHILD); // opens the workspace centered on the child
    await openTexWorkspace(MAIN); // re-open on the main
    expect(useTabsStore.getState().tabs[0].viewerState?.texActivePath).toBe(MAIN);
  });
});

describe("TeX workspace — center switching + SyncTeX", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetStores();
  });

  /** Add a workspace tab to the store and render the pane bound to it. */
  async function renderWorkspace() {
    vi.resetModules();
    const { useTabsStore } = await import("../../stores/tabs");
    useTabsStore.getState().setScope("p");
    const tab = useTabsStore.getState().addTab({
      label: "main.tex",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: MAIN,
      viewer: "texworkspace",
    });
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="texworkspace" path={MAIN} projectId="p" tabKey={tab.key} />);
    });
    return { tabKey: tab.key, useTabsStore };
  }

  it("pauses hidden children and catches up on show without discarding drafts", async () => {
    setupInvoke();
    const { tabKey, useTabsStore } = await renderWorkspace();
    const main = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(main.value).toBe(MAIN_SRC));
    fireEvent.change(main, { target: { value: MAIN_SRC + "% retained" } });
    const childRow = await screen.findByRole("button", { name: /chap\.tex/i });
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(childRow); });
      mockInvoke.mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      const polled = mockInvoke.mock.calls.filter(([cmd]) => cmd === "file_mtime").map(([, args]) => args.path);
      expect(polled).toContain(CHILD);
      expect(polled).not.toContain(MAIN);
      mockInvoke.mockClear();
      await act(async () => { useTabsStore.getState().setViewerState(tabKey, { texActivePath: MAIN }); });
      expect(mockInvoke.mock.calls.some(([cmd, args]) => cmd === "file_mtime" && args.path === MAIN)).toBe(true);
      expect(screen.getByDisplayValue(/% retained/)).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it("(b) clicking a sidebar entry switches the center via setViewerState, no new tab", async () => {
    setupInvoke();
    const { tabKey, useTabsStore } = await renderWorkspace();

    // The sidebar lists the child once the structure is gathered.
    const childRow = await screen.findByRole("button", { name: /chap\.tex/i });
    expect(useTabsStore.getState().tabs).toHaveLength(1);

    await act(async () => {
      await userEvent.click(childRow);
    });

    // The center switched by patching texActivePath — and NO tab was added.
    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState?.texActivePath,
      ).toBe(CHILD),
    );
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it("(c) a compile opens the PDF as its own tab (not docked)", async () => {
    setupInvoke([{ page: 1, x: 10, y: 20, w: 100, h: 12 }]);
    const { useTabsStore } = await renderWorkspace();

    // Only the workspace tab before a build.
    await screen.findByRole("button", { name: /compile/i });
    expect(useTabsStore.getState().tabs).toHaveLength(1);

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // A second tab — the compiled PDF — opened beside the workspace (deduped, so
    // the double open/refocus from the compile still yields exactly one).
    await waitFor(() =>
      expect(
        useTabsStore
          .getState()
          .tabs.find((t) => t.kind === "embed" && t.viewer === "pdf" && t.embedPath === "/p/main.pdf"),
      ).toBeTruthy(),
    );
    expect(useTabsStore.getState().tabs).toHaveLength(2);

    // Forward search revealed the caret's box in that PDF (path-keyed store).
    const { usePdfSyncStore } = await import("../../stores/viewers/pdfSync");
    await waitFor(() =>
      expect(usePdfSyncStore.getState().byPath["/p/main.pdf"]).toMatchObject({
        rect: { page: 1, x: 10, y: 20, w: 100, h: 12 },
      }),
    );
  });

  it("(i) the engine chosen on the main file compiles every file in the structure", async () => {
    // Two engines, so the selector is offered at all (one installed ⇒ hidden).
    setupInvoke([], ["pdflatex", "lualatex"]);
    await renderWorkspace();

    // Choose lualatex on the main file — the only pane mounted so far.
    const trigger = await screen.findByTitle(/LaTeX engine/i);
    await act(async () => {
      await userEvent.click(trigger);
    });
    await act(async () => {
      await userEvent.click(screen.getByRole("option", { name: "lualatex" }));
    });

    // Center the child and build from THERE. A child compiles its root, so the
    // engine it builds with is the document's, not the backend's default.
    const childRow = await screen.findByRole("button", { name: /chap\.tex/i });
    await act(async () => {
      await userEvent.click(childRow);
    });
    const childCompile = await screen.findByRole("button", { name: /compile main\.tex/i });
    await act(async () => {
      await userEvent.click(childCompile);
    });

    await waitFor(() => {
      const call = mockInvoke.mock.calls.find((c) => c[0] === "compile_tex");
      expect(call?.[1]).toMatchObject({ path: MAIN, engine: "lualatex" });
    });
    // And the child's own toolbar says so: one choice, shown by every pane.
    for (const el of screen.getAllByTitle(/LaTeX engine/i))
      expect(el.textContent).toContain("lualatex");
  });

  it("(d) reverse search routes back into the workspace, switching the center", async () => {
    setupInvoke([{ page: 1, x: 10, y: 20, w: 100, h: 12 }]);
    const { tabKey, useTabsStore } = await renderWorkspace();
    await screen.findByRole("button", { name: /compile/i });

    // Watch the jump channel: the child editor mounted by the center switch
    // consumes the request almost immediately, so spy rather than race the value.
    const { useEditorJumpStore } = await import("../../stores/viewers/editorJump");
    const jumpSpy = vi.spyOn(useEditorJumpStore.getState(), "requestJump");

    // A standalone PDF tab's reverse-click calls the module `jumpToSource`; for a
    // `.tex` source owned by an open workspace it focuses that workspace and
    // switches its center to the source instead of opening a scattered tab.
    const { jumpToSource } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      jumpToSource(CHILD, 2, 1, MAIN);
    });

    // The center switched to the child and a jump request reached it — no new tab.
    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState?.texActivePath,
      ).toBe(CHILD),
    );
    expect(jumpSpy).toHaveBeenCalledWith(CHILD, 2, 1);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it("(h) the structure sidebar folds to a rail and comes back, persisted per tab", async () => {
    setupInvoke();
    const { tabKey, useTabsStore } = await renderWorkspace();
    await screen.findByRole("button", { name: /chap\.tex/i });

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /hide the structure/i }));
    });

    // Folded: the tree is gone, the persisted flag is set, and the rail still
    // offers the way back (a fold must never be a one-way door).
    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState?.texSidebarHidden,
      ).toBe(true),
    );
    expect(screen.queryByRole("button", { name: /chap\.tex/i })).toBeNull();

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /show the structure/i }));
    });
    await screen.findByRole("button", { name: /chap\.tex/i });
    expect(
      useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState?.texSidebarHidden,
    ).toBe(false);
  });

  it("(i) back returns the center to the previously centered file", async () => {
    setupInvoke();
    const { tabKey, useTabsStore } = await renderWorkspace();
    const vsOf = () => useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState;

    // Nothing centered yet ⇒ nothing to go back to: the button is present (it is
    // the only navigation this tab has) but inert.
    const backBefore = await screen.findByRole("button", { name: /nothing to go back to/i });
    expect((backBefore as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /chap\.tex/i }));
    });
    await waitFor(() => expect(vsOf()?.texActivePath).toBe(CHILD));

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /back to main\.tex/i }));
    });
    await waitFor(() => expect(vsOf()?.texActivePath).toBe(MAIN));
    // One step back is the whole stack — the button goes inert again.
    const backAfter = await screen.findByRole("button", { name: /nothing to go back to/i });
    expect((backAfter as HTMLButtonElement).disabled).toBe(true);
  });

  it("(m) ↑ goes up to the parent and puts the caret on its \\input line (#tex-structure-up)", async () => {
    setupInvoke();
    const { tabKey, useTabsStore } = await renderWorkspace();
    const vsOf = () => useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState;
    const { useEditorJumpStore } = await import("../../stores/viewers/editorJump");

    // On the main document there is nothing above: present, inert, and the
    // title says so.
    const upBefore = await screen.findByRole("button", { name: /this is the main document/i });
    expect((upBefore as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /chap\.tex/i }));
    });
    await waitFor(() => expect(vsOf()?.texActivePath).toBe(CHILD));

    // The child is inputted on line 3 of main.tex; the title names both.
    const up = await screen.findByRole("button", { name: /up to main\.tex, line 3/i });
    expect((up as HTMLButtonElement).disabled).toBe(false);
    // The main pane is mounted and consumes a jump the moment it lands, so the
    // request is recorded on the way through rather than read back afterwards.
    const jumps: Array<{ line: number; column: number }> = [];
    const unsub = useEditorJumpStore.subscribe((st) => {
      const r = st.requestsByPath[MAIN];
      if (r) jumps.push({ line: r.line, column: r.column });
    });
    await act(async () => {
      await userEvent.click(up);
    });
    await waitFor(() => expect(vsOf()?.texActivePath).toBe(MAIN));
    unsub();
    expect(jumps).toEqual([{ line: 3, column: 1 }]);

    // Up was a navigation like any other: ← returns to the child.
    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /back to chap\.tex/i }));
    });
    await waitFor(() => expect(vsOf()?.texActivePath).toBe(CHILD));
  });

  it("(n) Alt+Shift+Up / Alt+Shift+Down drive up and back when focus is inside the workspace", async () => {
    setupInvoke();
    const { tabKey, useTabsStore } = await renderWorkspace();
    const vsOf = () => useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState;
    const { useEditorJumpStore } = await import("../../stores/viewers/editorJump");

    const childRow = await screen.findByRole("button", { name: /chap\.tex/i });
    await act(async () => {
      await userEvent.click(childRow);
    });
    await waitFor(() => expect(vsOf()?.texActivePath).toBe(CHILD));

    // From the centered child's editor textarea — where the global shortcut hook
    // would refuse to act — the chord bubbles to the workspace root and climbs.
    const editor = document.querySelector<HTMLTextAreaElement>(".tex-workspace textarea");
    expect(editor).not.toBeNull();
    const jumps: number[] = [];
    const unsub = useEditorJumpStore.subscribe((st) => {
      const r = st.requestsByPath[MAIN];
      if (r) jumps.push(r.line);
    });
    await act(async () => {
      fireEvent.keyDown(editor!, { key: "ArrowUp", altKey: true, shiftKey: true });
    });
    await waitFor(() => expect(vsOf()?.texActivePath).toBe(MAIN));
    unsub();
    expect(jumps).toEqual([3]);

    // Alt+Shift+Down retraces the step.
    await act(async () => {
      fireEvent.keyDown(document.querySelector(".tex-workspace")!, { key: "ArrowDown", altKey: true, shiftKey: true });
    });
    await waitFor(() => expect(vsOf()?.texActivePath).toBe(CHILD));

    // Outside the workspace the chord is nobody's: the center stays put.
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "ArrowUp", altKey: true, shiftKey: true });
    });
    expect(vsOf()?.texActivePath).toBe(CHILD);
  });

  it("(e) a commented-out \\input is not listed in the sidebar", async () => {
    // A document whose live \input{chap} is followed by a commented one. The
    // sidebar must list only the live child. (The editor's follow behaviour for
    // a commented reference is locked at the unit level in TexLinks.test.ts —
    // jsdom gives every link span a zero rect, so the coordinate-based Ctrl+click
    // path can't be exercised here.)
    const commentedMain =
      "\\documentclass{article}\n\\begin{document}\n" +
      "\\input{chap}\n" +
      "% \\input{oldstuff}\n" +
      "\\end{document}\n";
    const files: Record<string, string> = { [MAIN]: commentedMain, [CHILD]: CHILD_SRC };
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "tex_capability":
          return Promise.resolve({ available: false });
        case "read_file_text": {
          const text = files[(args?.path as string) ?? ""];
          return text != null ? Promise.resolve(text) : Promise.reject(new Error("missing"));
        }
        case "resolve_tex_root":
          return Promise.resolve((args?.path as string) === CHILD ? MAIN : (args?.path as string));
        case "file_mtime":
          return Promise.resolve(1);
        case "list_dir":
          return Promise.resolve([]);
        // A Ctrl+click that finds no reference falls through to forward-sync.
        case "synctex_view":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });
    await renderWorkspace();

    // Only the live child appears — never "oldstuff.tex".
    await screen.findByRole("button", { name: /chap\.tex/i });
    expect(screen.queryByRole("button", { name: /oldstuff\.tex/i })).toBeNull();
  });

  it("(f) switches the center in a detached popout (tab absent from the store)", async () => {
    // A detached popout renders its tabs from a Tauri seed into LOCAL React state,
    // so the layout store has NO entry for this tab: a store read is undefined and
    // a store write is a no-op. The workspace must fall back to a local mirror, or
    // the center stays pinned to the main file (the reported popout bug).
    setupInvoke();
    vi.resetModules();
    const { useTabsStore } = await import("../../stores/tabs");
    useTabsStore.getState().setScope("p");
    // Deliberately do NOT addTab — mimic the popout's empty store for this key.
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="texworkspace" path={MAIN} projectId="p" tabKey="detached-tex" visible />);
    });

    const childRow = await screen.findByRole("button", { name: /chap\.tex/i });
    expect(useTabsStore.getState().tabs.find((t) => t.key === "detached-tex")).toBeUndefined();

    await act(async () => {
      await userEvent.click(childRow);
    });

    // The center switched to the child (its body renders) even though the store
    // never gained an entry — the local mirror drove it.
    await waitFor(() => expect(screen.getByDisplayValue(/child body/)).toBeTruthy());
    expect(useTabsStore.getState().tabs.find((t) => t.key === "detached-tex")).toBeUndefined();
  });

  it("(g) in a detached popout a compile streams the PDF tab via the file-drop controller", async () => {
    // A popout's tabs aren't in the main store, so `openLinkedFile` there would add
    // the PDF tab to a window that never renders it (the reported bug). With a
    // `FileDropController` in context the workspace must route the PDF through
    // `openTab` — the same seam the Python ▶ Run uses — so it lands in the popout.
    setupInvoke([{ page: 1, x: 10, y: 20, w: 100, h: 12 }]);
    vi.resetModules();
    const { useTabsStore } = await import("../../stores/tabs");
    useTabsStore.getState().setScope("p");
    const tab = useTabsStore.getState().addTab({
      label: "main.tex",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: MAIN,
      viewer: "texworkspace",
    });
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    const { FileDropContext } = await import("../../components/files/fileDropContext");
    const openTab = vi.fn();
    const controller = { resolveTarget: vi.fn(), commit: vi.fn(), openTab };
    await act(async () => {
      render(
        <FileDropContext.Provider value={controller}>
          <FileViewerPane viewer="texworkspace" path={MAIN} projectId="p" tabKey={tab.key} />
        </FileDropContext.Provider>,
      );
    });

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // The PDF was streamed into the popout via the controller — never added to the
    // main store, which still holds only the workspace tab.
    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "embed", viewer: "pdf", embedPath: "/p/main.pdf" }),
      ),
    );
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it("(k) reverse search centers a workspace mounted in a popout (no store entry)", async () => {
    // The bug: a popped-out workspace renders its ViewerState from a one-time
    // seed into local React state, so the `setViewerState(texActivePath)` write
    // reverse search used to make landed in a store the popout never reads —
    // tex→pdf worked, pdf→tex silently did nothing. The switch has to reach the
    // window that RENDERS the workspace, which is what the texCenter registry is.
    setupInvoke();
    vi.resetModules();
    const { useTabsStore } = await import("../../stores/tabs");
    useTabsStore.getState().setScope("p");
    // Deliberately no addTab — the popout's empty store (see (f)).
    const { FileViewerPane, jumpToSource } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(
        <FileViewerPane viewer="texworkspace" path={MAIN} projectId="p" tabKey="detached-tex" visible />,
      );
    });
    await screen.findByRole("button", { name: /chap\.tex/i });

    const { useEditorJumpStore } = await import("../../stores/viewers/editorJump");
    const jumpSpy = vi.spyOn(useEditorJumpStore.getState(), "requestJump");

    await act(async () => {
      jumpToSource(CHILD, 2, 1, MAIN);
    });

    // The center switched to the producing child — its body is on screen — and
    // the caret jump reached it, with the store still holding no tab at all.
    await waitFor(() => expect(screen.getByDisplayValue(/child body/)).toBeTruthy());
    expect(jumpSpy).toHaveBeenCalledWith(CHILD, 2, 1);
    expect(useTabsStore.getState().tabs.find((t) => t.key === "detached-tex")).toBeUndefined();
  });

  it("(l) a DETACHED workspace tab is switched by broadcast, never by a store write", async () => {
    // The other half of (k), from the main window's side: the workspace tab is in
    // this store but its group has been popped out, so this heap does not render
    // it. A `setViewerState` here would write a field the popout's seeded mirror
    // never re-reads, so the switch goes out as a cross-window request instead.
    setupInvoke();
    vi.resetModules();
    const { useTabsStore } = await import("../../stores/tabs");
    const { TEX_CENTER_EVENT } = await import("../../stores/viewers/texCenter");
    const { emit } = await import("@tauri-apps/api/event");
    useTabsStore.getState().setScope("p");
    const tab = useTabsStore.getState().addTab({
      label: "main.tex",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: MAIN,
      viewer: "texworkspace",
    });
    // Pop that tab's group out: the payload stays in `tabsByScope`, its
    // arrangement moves to `detachedGroupsByScope` (see stores/tabs).
    useTabsStore.setState({
      detachedGroupsByScope: {
        p: [
          {
            id: "d1",
            label: "detached-1",
            subtree: { type: "group", id: "g1", tabKeys: [tab.key], activeKey: tab.key },
          },
        ],
      },
    });
    vi.mocked(emit).mockClear();

    // Nothing is rendered here, so the registry misses and the escalation runs.
    const { jumpToSource } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      jumpToSource(CHILD, 2, 1, MAIN);
    });

    await waitFor(() =>
      expect(emit).toHaveBeenCalledWith(
        TEX_CENTER_EVENT,
        expect.objectContaining({ root: MAIN, source: CHILD }),
      ),
    );
    // And the store was NOT written: the popout owns that field now.
    expect(
      useTabsStore.getState().tabs.find((t) => t.key === tab.key)?.viewerState?.texActivePath,
    ).toBeUndefined();
    // No scattered standalone source tab either.
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it("(j) the sidebar's ＋ creates a child file, \\inputs it, and centers it", async () => {
    const files = setupInvoke();
    const { tabKey, useTabsStore } = await renderWorkspace();
    await screen.findByRole("button", { name: /chap\.tex/i });

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /new file/i }));
    });
    const input = await screen.findByRole("textbox", { name: /file name/i });
    await act(async () => {
      await userEvent.type(input, "notes{enter}");
    });

    // The file exists, the main document gained its \input above \end{document},
    // and the re-gathered structure lists + centers the new child.
    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState?.texActivePath,
      ).toBe("/p/notes.tex"),
    );
    expect(files["/p/notes.tex"]).toBe("");
    expect(files[MAIN]).toMatch(/\\input\{notes\}\n\\end\{document\}/);
    await screen.findByRole("button", { name: /notes\.tex/i });
  });

  it("(k) the engine choice rides the workspace tab and is still set after a restart", async () => {
    // Two engines ⇒ the selector is offered (with one, the backend default is
    // the only choice and there is nothing to remember).
    setupInvoke([], ["pdflatex", "xelatex"]);
    const { tabKey, useTabsStore } = await renderWorkspace();
    const vsOf = () => useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState;

    await act(async () => {
      await userEvent.click(await screen.findByTitle(/LaTeX engine/));
    });
    await act(async () => {
      await userEvent.click(await screen.findByRole("option", { name: "xelatex" }));
    });
    await waitFor(() => expect(vsOf()?.texEngine).toBe("xelatex"));

    // The restart: the pane is torn down and re-created against the tab the
    // restored layout hands back. The toolbar must read `xelatex` again — and,
    // the part that actually matters, the build must run under it.
    cleanup();
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="texworkspace" path={MAIN} projectId="p" tabKey={tabKey} />);
    });
    expect((await screen.findByTitle(/LaTeX engine/)).textContent).toContain("xelatex");

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /^compile/i }));
    });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "compile_tex",
        expect.objectContaining({ path: MAIN, engine: "xelatex" }),
      ),
    );
  });
  it("(j) Compile pressed in a child pane first writes the main pane's unsaved draft", async () => {
    setupInvoke();
    await renderWorkspace();

    // Edit the main file in its own pane; the pane stays mounted (display:none)
    // with this draft once the center switches to the child.
    const mainBox = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(mainBox.value).toBe(MAIN_SRC));
    const edited = MAIN_SRC.replace("Hi", "Hi, edited");
    fireEvent.change(mainBox, { target: { value: edited } });

    // Center the child and build from THERE.
    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /chap\.tex/i }));
    });
    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /compile main\.tex/i }));
    });

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("compile_tex", expect.objectContaining({ path: MAIN })),
    );
    // The main draft reached disk — with the edit — BEFORE the build read it.
    // Without this the build was of main.tex as last saved: with nothing on disk
    // changed, latexmk answers "up-to-date" and the old PDF comes back as a success.
    const calls = mockInvoke.mock.calls;
    const write = calls.findIndex(
      (c) => c[0] === "write_file_text" && (c[1] as { path: string }).path === MAIN,
    );
    const compile = calls.findIndex((c) => c[0] === "compile_tex");
    expect(write).toBeGreaterThanOrEqual(0);
    expect(write).toBeLessThan(compile);
    expect((calls[write][1] as { content: string }).content).toBe(edited);
  });

  // #tex-structure-errors: the Errors/Warnings cards say WHAT is wrong, read from
  // whichever pane is centered; the tree says WHICH FILE, which is the question a
  // document split across a dozen `\input`s actually raises.
  it("badges the structure row of every file the last build reported on", async () => {
    setupInvoke();
    // A failed build whose one error and one warning are both inside the CHILD:
    // the error through `-file-line-error`, the warning through the `(…)` nesting.
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args?: unknown, opts?: unknown) =>
      cmd === "compile_tex"
        ? Promise.resolve({
            success: false,
            pdf_path: null,
            engine: "pdflatex",
            log: [
              "This is pdfTeX, Version 3.14",
              "(./main.tex",
              "(./chap.tex",
              "./chap.tex:2: Undefined control sequence.",
              "l.2 \\badcmd",
              "LaTeX Warning: Reference `fig:x' undefined on input line 2.",
              ")",
              ")",
            ].join("\n"),
            shell_escape: false,
          })
        : (base as (c: string, a?: unknown, o?: unknown) => unknown)(cmd, args, opts),
    );

    const { tabKey, useTabsStore } = await renderWorkspace();
    const { useEditorJumpStore } = await import("../../stores/viewers/editorJump");
    const jumpSpy = vi.spyOn(useEditorJumpStore.getState(), "requestJump");

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /compile/i }));
    });

    // The child's row wears both pills; the main document's row wears neither —
    // nothing in the log was attributed to it.
    const errorBadge = await screen.findByRole("button", { name: /1 error in chap\.tex/i });
    expect(await screen.findByRole("button", { name: /1 warning in chap\.tex/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /in main\.tex from the last build/i })).toBeNull();

    // Clicking a pill centers that file with the caret on the reported line —
    // the step the reader who spotted the badge was about to take by hand.
    await act(async () => {
      await userEvent.click(errorBadge);
    });
    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState?.texActivePath,
      ).toBe(CHILD),
    );
    expect(jumpSpy).toHaveBeenCalledWith(CHILD, 2, 1);
  });
});


describe("spreadsheet request ownership", () => {
  it("loads once without reading text, then once per explicit sheet switch", async () => {
    cleanup();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((cmd, args) => Promise.resolve(cmd === "read_spreadsheet" ? {
      sheet_names: ["First", "Second"], active_sheet: args.sheet ?? "First", rows: [["value"]],
    } : null));
    const { TableView } = await import("../../components/embed/TableView");
    const view = render(<TableView path="/p/book.xlsx" onOpenExternally={() => {}} />);
    await waitFor(() => expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "read_spreadsheet")).toHaveLength(1));
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "read_file_text")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: /First/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Second" }));
    await waitFor(() => expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "read_spreadsheet")).toHaveLength(2));
    view.unmount();
  });
});

it("does not repaint an offscreen PDF thumbnail after reload", async () => {
  cleanup();
  const { PdfThumb } = await import("../../components/embed/pdf/PdfViewer");
  let intersect!: (entries: { isIntersecting: boolean }[]) => void;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {}
    disconnect() {}
  });
  const page = {
    rotate: 0,
    getViewport: () => ({ height: 100, width: 100, scale: 1 }),
  };
  const first = { getPage: vi.fn().mockResolvedValue(page) };
  const second = { getPage: vi.fn().mockResolvedValue(page) };
  type Doc = import("pdfjs-dist").PDFDocumentProxy;
  try {
    const view = render(<PdfThumb doc={first as unknown as Doc} page={1} rot={0} />);
    await act(async () => intersect([{ isIntersecting: true }]));
    expect(first.getPage).toHaveBeenCalledTimes(1);
    await act(async () => intersect([{ isIntersecting: false }]));
    view.rerender(<PdfThumb doc={second as unknown as Doc} page={1} rot={0} />);
    expect(second.getPage).not.toHaveBeenCalled();
    await act(async () => intersect([{ isIntersecting: true }]));
    expect(second.getPage).toHaveBeenCalledTimes(1);
    view.unmount();
  } finally { vi.unstubAllGlobals(); }
});

it("skips Markdown parsing and image reads while hidden or editing", async () => {
  cleanup();
  const markdown = await import("../../lib/viewers/markdown");
  const parse = vi.spyOn(markdown, "renderMarkdown");
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd) => Promise.resolve(
    cmd === "read_file_text" ? "![one](image.png)\n![two](image.png)" : cmd === "read_file_bytes" ? new ArrayBuffer(1) : 1,
  ));
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  const view = render(<FileViewerPane viewer="markdown" path="/p/readme.md" projectId="p" visible={false} />);
  await act(async () => {});
  expect(parse).not.toHaveBeenCalled();
  expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "read_file_bytes")).toBe(false);
  view.rerender(<FileViewerPane viewer="markdown" path="/p/readme.md" projectId="p" visible />);
  await waitFor(() => expect(parse).toHaveBeenCalled());
  await waitFor(() => expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "read_file_bytes")).toHaveLength(1));
  fireEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
  parse.mockClear();
  mockInvoke.mockClear();
  fireEvent.change(await screen.findByRole("textbox"), { target: { value: "![changed](new.png)" } });
  expect(parse).not.toHaveBeenCalled();
  expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "read_file_bytes")).toBe(false);
  view.unmount();
  parse.mockRestore();
});

it("flushes a replaced viewer to its original scoped path and ignores late completion", async () => {
  cleanup();
  const { useEditableFile } = await import("../../components/embed/FileViewerPane");
  const { FileScopeContext } = await import("../../components/embed/fileAccess");
  const { useSettingsStore } = await import("../../stores/settings");
  const settings = useSettingsStore.getState().settings!;
  settings.autosave = true;
  let finish!: () => void;
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd, args) => {
    if (cmd === "read_file_text") return Promise.resolve(args.path === "/a" ? "old" : "replacement");
    if (cmd === "write_file_text") return new Promise<void>((r) => { finish = r; });
    return Promise.resolve(1);
  });
  const wrapper = ({ children }: { children: import("react").ReactNode }) => <FileScopeContext.Provider value="remote-project">{children}</FileScopeContext.Provider>;
  try {
    const view = renderHook(({ path }) => useEditableFile(path), { initialProps: { path: "/a" }, wrapper });
    await waitFor(() => expect(view.result.current.draft).toBe("old"));
    act(() => view.result.current.setDraft("unsaved original"));
    view.rerender({ path: "/b" });
    expect(mockInvoke).toHaveBeenCalledWith("write_file_text", expect.objectContaining({ path: "/a", projectId: "remote-project", content: "unsaved original" }));
    await waitFor(() => expect(view.result.current.draft).toBe("replacement"));
    await act(async () => finish());
    expect(view.result.current.draft).toBe("replacement");
    expect(view.result.current.isDirty).toBe(false);
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "write_file_text")).toHaveLength(1);
    view.unmount();
  } finally { settings.autosave = false; }
});
