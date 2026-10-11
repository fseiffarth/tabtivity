/**
 * Tests for the in-tab LaTeX viewer (`TexView` in FileViewerPane):
 *  - No TeX engine on PATH → degrades to exactly the plain code editor: a
 *    textarea, a Save button, and NO Compile button.
 *  - Engine available → a Compile button appears; clicking it saves the source
 *    (write_file_text) and then invokes `compile_tex`. A successful compile opens
 *    the PDF in its own tab (there is no inline preview pane).
 *
 * `getTexCapability()` caches its probe at module scope, so each test resets the
 * module registry and re-imports FileViewerPane to get a fresh probe.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
// The viewer's external-open button reaches into the windows store; stub it so
// the component renders without the real store.
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
// Settings store: no viewer prefs (preview default OFF — #44), autosave off.
vi.mock("../../stores/settings", () => {
  const state = { settings: { autosave: false, viewer_prefs: {} } };
  return {
    useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(state), {
      getState: () => state,
    }),
  };
});

const TEX_SOURCE = "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n";

function setupInvoke(
  available: boolean,
  engines: string[] = ["pdflatex"],
  // Override what `resolve_tex_root` returns (defaults to the file itself, i.e.
  // not a child). Lets a test exercise the subtex→parent redirect.
  resolveRoot?: (path: string) => string,
  syncRects: Array<{ page: number; x: number; y: number; w: number; h: number }> = [],
) {
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "tex_capability") {
      return Promise.resolve({ available, engines, bibtex: false, latexmk: false });
    }
    if (cmd === "read_file_text") return Promise.resolve(TEX_SOURCE);
    if (cmd === "write_file_text") return Promise.resolve(null);
    if (cmd === "resolve_tex_root") {
      const p = (args?.path as string) ?? "";
      return Promise.resolve(resolveRoot ? resolveRoot(p) : p);
    }
    if (cmd === "compile_tex") {
      return Promise.resolve({
        success: true,
        pdf_path: "/p/paper.pdf",
        engine: "pdflatex",
        log: "ok",
        shell_escape: false,
      });
    }
    if (cmd === "synctex_view") return Promise.resolve(syncRects);
    if (cmd === "synctex_edit") return Promise.resolve(null);
    if (cmd === "file_mtime") return Promise.reject(new Error("no synctex"));
    if (cmd === "read_file_bytes") return Promise.resolve([37, 80, 68, 70]); // %PDF
    return Promise.resolve(null);
  });
}

async function renderTexView(path = "/p/paper.tex", projectId = "proj") {
  vi.resetModules();
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="tex" path={path} projectId={projectId} />);
  });
}

describe("TexView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The beamer/hover switches are remembered per project in localStorage
    // (`stores/viewers/texViewPref`); a test must not inherit the previous one's click.
    localStorage.clear();
  });

  it("degrades to the plain editor with no Compile button when no engine is installed", async () => {
    setupInvoke(false);
    await renderTexView();

    // Source still loads into an editable textarea with a Save button.
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(TEX_SOURCE),
    );
    expect(screen.getByRole("button", { name: /save/i })).toBeTruthy();
    // No compile affordance.
    expect(screen.queryByRole("button", { name: /compile/i })).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith("compile_tex", expect.anything());
  });

  it("accepts the highlighted TeX completion with Enter", async () => {
    setupInvoke(false);
    await renderTexView();

    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(TEX_SOURCE));
    const typed = "\\beg";
    textarea.setSelectionRange(typed.length, typed.length);
    fireEvent.change(textarea, { target: { value: typed } });
    fireEvent.select(textarea);

    await screen.findByRole("option", { name: /\\begin/ });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(textarea.value).toBe("\\begin{}");
      expect(textarea.selectionStart).toBe("\\begin{".length);
      expect(textarea.selectionEnd).toBe("\\begin{".length);
    });
  });

  it("marks an opening bracket and its source line red until its end is typed", async () => {
    setupInvoke(false);
    await renderTexView();

    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(TEX_SOURCE));
    const line = 3;
    const caret = TEX_SOURCE.indexOf("Hi") + 2;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);

    const unclosed = TEX_SOURCE.slice(0, caret) + "{" + TEX_SOURCE.slice(caret);
    fireEvent.change(textarea, { target: { value: unclosed } });
    await waitFor(() => {
      expect(document.querySelector(".file-viewer-unclosed-bracket")?.textContent).toBe("{");
      expect(
        document.querySelector(".file-viewer-gutter-line.has-unclosed-bracket")?.textContent,
      ).toBe(String(line));
    });

    fireEvent.change(textarea, {
      target: { value: unclosed.slice(0, caret + 1) + "}" + unclosed.slice(caret + 1) },
    });
    await waitFor(() => {
      expect(document.querySelector(".file-viewer-unclosed-bracket")).toBeNull();
      expect(document.querySelector(".file-viewer-gutter-line.has-unclosed-bracket")).toBeNull();
    });
  });

  it("shows a Compile button when an engine is available, and saving+compiling on click", async () => {
    setupInvoke(true, ["pdflatex"]);
    await renderTexView();

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    // A single engine → no engine selector, backend default is used.
    expect(screen.queryByTitle("LaTeX engine")).toBeNull();

    // Edit the source so it's dirty — compile must persist edits first.
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(TEX_SOURCE));
    await act(async () => {
      await userEvent.type(textarea, "%edit");
    });

    await act(async () => {
      await userEvent.click(compileBtn);
    });

    await waitFor(() => {
      // #54 added compiler options to the call; with none set they pass null.
      expect(mockInvoke).toHaveBeenCalledWith("compile_tex", {
        path: "/p/paper.tex",
        engine: null,
        outDir: null,
        extraFlags: null,
      });
    });
    // The dirty source is saved before compiling.
    expect(mockInvoke).toHaveBeenCalledWith("write_file_text", expect.objectContaining({ path: "/p/paper.tex" }));
  });

  // The build has a chord of its own (`texCompile`), listened for on the pane's
  // root so it fires with the caret in the textarea — where it is actually
  // pressed, and where the global keyboard hook drops chords. The button's
  // tooltip names the same chord, resolved from the shortcut table rather than
  // spelled into a translated string.
  it("compiles on Ctrl+Shift+B from the editor, and says so on the Compile button", async () => {
    setupInvoke(true, ["pdflatex"]);
    await renderTexView();

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    expect(compileBtn.getAttribute("title")).toBe("Save and compile to PDF (Ctrl+Shift+B)");

    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(TEX_SOURCE));
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "B", ctrlKey: true, shiftKey: true });
    });

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("compile_tex", {
        path: "/p/paper.tex",
        engine: null,
        outDir: null,
        extraFlags: null,
      }),
    );
  });

  it("#tex-beamer: the Beamer toggle shows the overlay bar, and Wrap wraps the selection", async () => {
    setupInvoke(true);
    await renderTexView();

    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(TEX_SOURCE));
    // An `article` document: off by default, so no bar.
    expect(screen.queryByRole("group", { name: /beamer overlays/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^beamer/i }));
    const bar = await screen.findByRole("group", { name: /beamer overlays/i });
    expect(bar).toBeTruthy();

    // Select "Hi" and wrap it: no frame in the document, no overlay yet, so the
    // next free slide is 2 and the default range is onward.
    const s = TEX_SOURCE.indexOf("Hi");
    textarea.focus();
    textarea.setSelectionRange(s, s + 2);
    fireEvent.select(textarea);
    fireEvent.click(screen.getByRole("button", { name: /^wrap$/i }));

    await waitFor(() => {
      expect(textarea.value).toBe(TEX_SOURCE.replace("Hi", "\\only<2->{Hi}"));
    });
    // The wrapped body stays selected, so a second Wrap re-targets.
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe("Hi");
  });

  it("#tex-beamer: the switch is the project's — another file of the same project opens with the bar, another project does not", async () => {
    setupInvoke(true);
    await renderTexView("/p/paper.tex", "proj");
    await screen.findByRole("textbox");
    expect(screen.queryByRole("group", { name: /beamer overlays/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^beamer/i }));
    await screen.findByRole("group", { name: /beamer overlays/i });
    cleanup();

    // A different .tex of the same project, in a fresh module registry: the
    // store is re-read from localStorage, i.e. this is also the relaunch case.
    await renderTexView("/p/chapter.tex", "proj");
    // (The bar's own number fields are textboxes too, so wait on the bar.)
    await screen.findByRole("group", { name: /beamer overlays/i });
    expect(screen.getByRole("button", { name: /^beamer/i }).getAttribute("aria-pressed")).toBe("true");
    cleanup();

    // Another project keeps the document default (an article: off).
    await renderTexView("/q/paper.tex", "other");
    await screen.findByRole("textbox");
    expect(screen.queryByRole("group", { name: /beamer overlays/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^beamer/i }).getAttribute("aria-pressed")).toBe("false");
  });

  it("#tex-hover-preview: switching the preview off holds for the project's other files", async () => {
    setupInvoke(true);
    await renderTexView("/p/paper.tex", "proj");
    await screen.findByRole("textbox");
    const toggle = () => screen.getByRole("button", { name: /^preview/i });
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    cleanup();

    await renderTexView("/p/chapter.tex", "proj");
    await screen.findByRole("textbox");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("#tex-beamer: a beamer document opens with the bar on", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "tex_capability") {
        return Promise.resolve({ available: true, engines: ["pdflatex"], bibtex: false, latexmk: false });
      }
      if (cmd === "read_file_text") return Promise.resolve("\\documentclass{beamer}\n\\begin{document}\n\\end{document}\n");
      if (cmd === "resolve_tex_root") return Promise.resolve((args?.path as string) ?? "");
      if (cmd === "file_mtime") return Promise.reject(new Error("no synctex"));
      return Promise.resolve(null);
    });
    await renderTexView();
    await screen.findByRole("group", { name: /beamer overlays/i });
    expect(screen.getByRole("button", { name: /^beamer/i }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders an engine selector when more than one engine is available", async () => {
    setupInvoke(true, ["pdflatex", "xelatex"]);
    await renderTexView();

    await screen.findByRole("button", { name: /compile/i });
    // Custom themed dropdown (not a native <select>); its trigger names the
    // engine "Auto" would build with — the first installed one until the
    // backend's read of the document says otherwise.
    const engine = screen.getByTitle("LaTeX engine");
    expect(engine).toBeTruthy();
    expect(engine.textContent).toContain("Auto (pdflatex)");
  });

  it("labels Auto with the engine the document asks for, and builds with no engine named", async () => {
    setupInvoke(true, ["pdflatex", "lualatex", "xelatex"]);
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "tex_auto_engine" ? Promise.resolve("lualatex") : base(cmd, args),
    );
    await renderTexView();

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    const engine = screen.getByTitle("LaTeX engine");
    await waitFor(() => expect(engine.textContent).toContain("Auto (lualatex)"));
    expect(mockInvoke).toHaveBeenCalledWith("tex_auto_engine", { path: "/p/paper.tex" });

    // "Auto" stays a request for the backend to pick, not a pinned engine.
    fireEvent.click(compileBtn);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("compile_tex", expect.objectContaining({ engine: null })),
    );
  });

  it("remembers the chosen engine on the tab, so a restart still builds under it", async () => {
    setupInvoke(true, ["pdflatex", "xelatex"]);
    // One module registry for the whole test: `renderTexView` resets modules to
    // get a fresh capability probe, and a reset store is a DIFFERENT store from
    // the one the mounted pane writes to. So reset once, then hold both.
    vi.resetModules();
    const { useTabsStore } = await import("../../stores/tabs");
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    const mount = async (key: string) => {
      await act(async () => {
        render(<FileViewerPane viewer="tex" path="/p/paper.tex" projectId="proj" tabKey={key} />);
      });
    };
    useTabsStore.getState().setScope("proj");
    const tab = useTabsStore.getState().addTab({
      label: "paper.tex",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: "/p/paper.tex",
      viewer: "tex",
    });
    await mount(tab.key);

    await act(async () => {
      await userEvent.click(await screen.findByTitle("LaTeX engine"));
    });
    await act(async () => {
      await userEvent.click(await screen.findByRole("option", { name: "xelatex" }));
    });
    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.find((t) => t.key === tab.key)?.viewerState?.texEngine,
      ).toBe("xelatex"),
    );

    // The restart: a fresh pane bound to the same restored tab comes back on
    // xelatex and compiles with it, instead of silently reverting to the
    // backend's default.
    cleanup();
    await mount(tab.key);
    expect((await screen.findByTitle("LaTeX engine")).textContent).toContain("xelatex");
    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /^compile/i }));
    });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "compile_tex",
        expect.objectContaining({ path: "/p/paper.tex", engine: "xelatex" }),
      ),
    );
  });

  it("#54: passes compiler options and offers Open PDF after a successful compile", async () => {
    setupInvoke(true, ["pdflatex"]);
    await renderTexView();

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    // No PDF yet → no Open-PDF affordance.
    expect(screen.queryByRole("button", { name: /open pdf/i })).toBeNull();

    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // compile_tex is called with the new outDir/extraFlags args (null when unset).
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "compile_tex",
        expect.objectContaining({ path: "/p/paper.tex", outDir: null, extraFlags: null }),
      ),
    );
    // After a successful compile the "Open PDF" tab action appears.
    await screen.findByRole("button", { name: /open pdf/i });
  });

  it("shows a forward-search miss notice when SyncTeX can't locate the cursor", async () => {
    // setupInvoke's synctex_view resolves [] → SyncTeX ran but matched nothing.
    setupInvoke(true, ["pdflatex"]);
    await renderTexView();

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    // No notice before compiling.
    expect(screen.queryByText(/couldn't locate the cursor/i)).toBeNull();

    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // A successful compile whose forward search finds no box surfaces the miss
    // notice — worded so it reads as a SyncTeX outcome, not a build failure.
    await screen.findByText(/couldn't locate the cursor/i);
    // …and it must NOT claim SyncTeX was unavailable (that is the other cause).
    expect(screen.queryByText(/didn't run/i)).toBeNull();
  });

  it("distinguishes 'SyncTeX unavailable' from a real miss when the command errors", async () => {
    // The synctex_view command itself REJECTS (a backend not yet rebuilt for it,
    // or the `synctex` tool absent) — this used to look identical to a miss.
    setupInvoke(true, ["pdflatex"]);
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "tex_capability")
        return Promise.resolve({ available: true, engines: ["pdflatex"], bibtex: false, latexmk: false });
      if (cmd === "read_file_text") return Promise.resolve(TEX_SOURCE);
      if (cmd === "write_file_text") return Promise.resolve(null);
      if (cmd === "resolve_tex_root") return Promise.resolve((args?.path as string) ?? "");
      if (cmd === "compile_tex")
        return Promise.resolve({ success: true, pdf_path: "/p/paper.pdf", engine: "pdflatex", log: "ok", shell_escape: false });
      if (cmd === "synctex_view") return Promise.reject(new Error("no such command"));
      if (cmd === "synctex_edit") return Promise.resolve(null);
      if (cmd === "file_mtime") return Promise.reject(new Error("no synctex"));
      if (cmd === "read_file_bytes") return Promise.resolve([37, 80, 68, 70]);
      return Promise.resolve(null);
    });
    await renderTexView();

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // The notice names the real cause (SyncTeX didn't run) rather than a miss, and
    // still confirms the PDF was updated (compile did NOT fail).
    await screen.findByText(/didn't run/i);
    await screen.findByText(/PDF updated/i);
    expect(screen.queryByText(/couldn't locate the cursor/i)).toBeNull();
  });

  it("a Ctrl+click forward search before any compile says there is no PDF yet", async () => {
    // setupInvoke's file_mtime rejects for every path: the PDF was never built.
    setupInvoke(true, ["pdflatex"]);
    await renderTexView();
    await screen.findByRole("button", { name: /compile/i });
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(TEX_SOURCE));

    // Caret in body text ("Hi"), not on a reference, so the click forward-syncs.
    const at = TEX_SOURCE.indexOf("Hi");
    textarea.setSelectionRange(at, at);
    await act(async () => {
      fireEvent.click(textarea, { ctrlKey: true });
    });

    await screen.findByText(/hasn't been compiled/i);
    // Worded as "compile first", not as SyncTeX failing to run.
    expect(screen.queryByText(/didn't run/i)).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith("synctex_view", expect.anything());
  });

  it("Ctrl+click on an \\input path opens that file even before any compile", async () => {
    // No PDF exists (nothing compiled); only the child file is on disk.
    const src = "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n";
    setupInvoke(true, ["pdflatex"]);
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "read_file_text") return Promise.resolve(src);
      if (cmd === "file_mtime") {
        return args?.path === "/p/chapters/intro.tex"
          ? Promise.resolve(1)
          : Promise.reject(new Error("missing"));
      }
      return base(cmd, args);
    });
    await renderTexView();
    const { useTabsStore } = await import("../../stores/tabs");
    await screen.findByRole("button", { name: /compile/i });
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(src));

    // The layer makes the whole command clickable: the path underlined, the
    // `\\input{` and `}` around it invisible hit spans pointing at the same ref.
    await waitFor(() =>
      expect([...document.querySelectorAll(".file-link-hit")].map((e) => e.textContent)).toEqual([
        "\\input{",
        "}",
      ]),
    );
    expect(document.querySelector(".file-link")?.textContent).toBe("chapters/intro");

    // jsdom lays out no link spans, so the click falls back to the caret: put it
    // on the path, where the underlined link sits.
    const at = src.indexOf("chapters/intro") + 3;
    textarea.setSelectionRange(at, at);
    await act(async () => {
      fireEvent.click(textarea, { ctrlKey: true });
    });

    await waitFor(() =>
      expect(
        useTabsStore.getState().tabs.some((t) => t.embedPath === "/p/chapters/intro.tex"),
      ).toBe(true),
    );
    expect(screen.queryByText(/hasn't been compiled/i)).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith("compile_tex", expect.anything());
  });

  it("Compile forces a latexmk rebuild so an unchanged-looking build still runs", async () => {
    setupInvoke(true, ["pdflatex"]);
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "tex_capability"
        ? Promise.resolve({ available: true, engines: ["pdflatex"], bibtex: false, latexmk: true })
        : base(cmd, args),
    );
    await renderTexView();

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    await act(async () => {
      await userEvent.click(compileBtn);
    });

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "compile_tex",
        expect.objectContaining({ path: "/p/paper.tex", extraFlags: ["-g"] }),
      ),
    );
  });

  it("#56: a child file compiles its resolved parent and labels the button", async () => {
    // resolve_tex_root redirects the child to its main document.
    setupInvoke(true, ["pdflatex"], () => "/p/main.tex");
    await renderTexView();

    // The button advertises the parent it will build.
    const compileBtn = await screen.findByRole("button", { name: /compile main\.tex/i });

    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // compile_tex builds the resolved parent, not the edited child.
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "compile_tex",
        expect.objectContaining({ path: "/p/main.tex" }),
      ),
    );
  });

  it("#56: runs SyncTeX forward search against the edited file after a compile", async () => {
    setupInvoke(true, ["pdflatex"]);
    await renderTexView();

    const compileBtn = await screen.findByRole("button", { name: /compile/i });
    await act(async () => {
      await userEvent.click(compileBtn);
    });

    // Forward search uses the edited file as the SyncTeX input and the compiled
    // PDF as the output, from the (initial) caret at line/column 1.
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "synctex_view",
        expect.objectContaining({ pdf: "/p/paper.pdf", input: "/p/paper.tex" }),
      ),
    );
  });

  it("Ctrl+S recompiles and reveals the live editor cursor after the fresh PDF loads", async () => {
    setupInvoke(
      true,
      ["pdflatex"],
      undefined,
      [{ page: 2, x: 10, y: 20, w: 100, h: 12 }],
    );
    await renderTexView();

    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(TEX_SOURCE));
    const caret = TEX_SOURCE.indexOf("Hi") + 1;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }),
      );
    });

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "synctex_view",
        expect.objectContaining({ line: 3, column: 2 }),
      ),
    );
    const { usePdfSyncStore } = await import("../../stores/viewers/pdfSync");
    expect(usePdfSyncStore.getState().byPath["/p/paper.pdf"]).toMatchObject({
      rect: { page: 2, x: 10, y: 20, w: 100, h: 12 },
      afterReload: true,
    });
  });
  // #tex: latexmk fails a build over configuration — warnings treated as errors
  // in a latexmkrc, a bibliography rule, an unresolved reference — while the
  // engine still writes the PDF. The backend forgives that exit status, so the
  // viewer must show the PDF and latexmk's complaint as a *note*, not refuse the
  // build and title an error card with latexmk's "use the -f option" advisory.
  it("shows a latexmk config complaint as a note, with the PDF, not as a failure", async () => {
    const NOTE = "Some warnings have been treated as errors; Warnings treated as errors";
    setupInvoke(true, ["pdflatex"]);
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "tex_capability") {
        return Promise.resolve({
          available: true,
          engines: ["pdflatex"],
          bibtex: false,
          latexmk: true,
        });
      }
      if (cmd === "read_file_text") return Promise.resolve(TEX_SOURCE);
      if (cmd === "resolve_tex_root") return Promise.resolve((args?.path as string) ?? "");
      if (cmd === "compile_tex") {
        return Promise.resolve({
          // The engine typeset the document; only latexmk objected.
          success: true,
          pdf_path: "/p/paper.pdf",
          engine: "latexmk -pdf",
          log: "Output written on paper.pdf (1 page).\nLatexmk: Use the -f option to force complete processing,\n",
          shell_escape: false,
          driver_note: NOTE,
        });
      }
      return Promise.resolve(null);
    });
    await renderTexView();

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /compile/i }));
    });

    // The note is there, quoting latexmk…
    expect(await screen.findByText(NOTE)).toBeTruthy();
    // …and no failure card is: the advisory line must never become the title.
    expect(screen.queryByText(/compilation failed/i)).toBeNull();
    expect(screen.queryByText(/use the -f option/i)).toBeNull();
  });

  // #tex: the diagnostics cards are the one place the viewer shows text a user
  // has to hand to someone else, and the app disables selection globally — so
  // every row, every card head and the log carry their own copy button.
  it("copies one error, one warning and the whole log from the diagnostics cards", async () => {
    const FAIL_LOG = [
      "(./paper.tex",
      "./paper.tex:3: Undefined control sequence.",
      "l.3 \\bogus",
      "",
      "LaTeX Warning: Reference `fig:missing' on page 1 undefined on input line 5.",
      ")",
    ].join("\n");
    setupInvoke(true, ["pdflatex"]);
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "tex_capability") {
        return Promise.resolve({
          available: true,
          engines: ["pdflatex"],
          bibtex: false,
          latexmk: false,
        });
      }
      if (cmd === "read_file_text") return Promise.resolve(TEX_SOURCE);
      if (cmd === "resolve_tex_root") return Promise.resolve((args?.path as string) ?? "");
      if (cmd === "compile_tex") {
        return Promise.resolve({
          success: false,
          pdf_path: null,
          engine: "pdflatex",
          log: FAIL_LOG,
          shell_escape: false,
        });
      }
      return Promise.resolve(null);
    });
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderTexView();

    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /compile/i }));
    });

    // One error row, one warning row — each with its own copy button, and each
    // copying `file:line: message`, the shape the log itself prints.
    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /copy this error/i }));
    });
    expect(writeText).toHaveBeenLastCalledWith("./paper.tex:3: Undefined control sequence.");

    // The warnings card copies every warning while still folded shut…
    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /copy every warning/i }));
    });
    expect(String(writeText.mock.lastCall?.[0])).toContain("fig:missing");

    // …and each row copies its own once the card is unfolded.
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: /warnings/i }));
    });
    await act(async () => {
      await userEvent.click(await screen.findByRole("button", { name: /copy this warning/i }));
    });
    expect(String(writeText.mock.lastCall?.[0])).toContain("fig:missing");
    expect(String(writeText.mock.lastCall?.[0])).toMatch(/paper\.tex:5:/);

    // The log button hands over the whole log, not the visible tail — and it
    // does so without expanding the log first.
    expect(screen.queryByText(/Undefined control sequence\./, { selector: "pre" })).toBeNull();
    await act(async () => {
      await userEvent.click(
        await screen.findByRole("button", { name: /copy the whole compilation log/i }),
      );
    });
    expect(writeText).toHaveBeenLastCalledWith(FAIL_LOG);
  });
});
