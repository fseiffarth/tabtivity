/**
 * One completion walk per document, not one per pane.
 *
 * Every mounted pane of a TeX workspace used to run `gatherTexCompletions`
 * itself, so N panes of one document read the same files N times (each read a
 * network round trip over SFTP). The workspace now gathers once per generation
 * (mount, each successful compile) and hands the result to its panes:
 *  - a workspace with several panes mounted walks the document once, from the
 *    main file, and again once after a compile;
 *  - a standalone TeX tab, which has no host, still gathers by itself;
 *  - a pane takes the shared answer only when its walk reached the pane's file,
 *    waits while the host is still gathering, and gathers by itself otherwise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { warmFileViewer } from "../helpers/warmViewer";
import { render, screen, act, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke, gatherSpy } = vi.hoisted(() => ({ mockInvoke: vi.fn(), gatherSpy: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
vi.mock("../../stores/settings", () => {
  const state = { settings: { autosave: false, viewer_prefs: {}, debug: false } };
  const useSettingsStore = Object.assign((sel: (s: unknown) => unknown) => sel(state), {
    getState: () => state,
  });
  return { useSettingsStore };
});
vi.mock("../../components/embed/pdf/PdfViewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/embed/pdf/PdfViewer")>();
  const React = await import("react");
  return {
    ...actual,
    PdfView: (props: { path: string }) => React.createElement("div", { "data-testid": "pdf-view", "data-path": props.path }),
  };
});
// Pass-through, recording each call's start path: the walk itself is the real one.
vi.mock("../../lib/viewers/tex/tex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/viewers/tex/tex")>();
  return {
    ...actual,
    gatherTexCompletions: (...args: Parameters<typeof actual.gatherTexCompletions>) => {
      gatherSpy(args[0]);
      return actual.gatherTexCompletions(...args);
    },
  };
});

const MAIN = "/p/main.tex";
const CHILD = "/p/chap.tex";
const MAIN_SRC = "\\documentclass{article}\n\\begin{document}\n\\input{chap}\n\\end{document}\n";
const CHILD_SRC = "\\section{Chapter}\\label{sec:chap}\n";

function setupInvoke() {
  const files: Record<string, string> = { [MAIN]: MAIN_SRC, [CHILD]: CHILD_SRC };
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "tex_capability":
        return Promise.resolve({ available: true, engines: ["pdflatex"], bibtex: false, latexmk: false });
      case "read_file_text": {
        const text = files[(args?.path as string) ?? ""];
        return text != null ? Promise.resolve(text) : Promise.reject(new Error("missing"));
      }
      case "resolve_tex_root":
        return Promise.resolve((args?.path as string) === CHILD ? MAIN : (args?.path as string));
      case "compile_tex":
        return Promise.resolve({ success: true, pdf_path: "/p/main.pdf", engine: "pdflatex", log: "ok", shell_escape: false });
      case "file_mtime":
        return Promise.resolve(1);
      case "list_dir":
        return Promise.resolve([]);
      case "synctex_view":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  });
}

warmFileViewer();

describe("one completion walk per document", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setupInvoke();
  });

  it("a workspace with two panes mounted walks the document once, and once more per compile", async () => {
    vi.resetModules();
    const { useTabsStore } = await import("../../stores/tabs");
    useTabsStore.setState({
      scope: "p", tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {},
      tabs: [], layout: null, focusedGroupId: null, activeKey: null,
    });
    useTabsStore.getState().setScope("p");
    const tab = useTabsStore.getState().addTab({
      label: "main.tex", cmd: "", cwd: "/p", kind: "embed", embedPath: MAIN, viewer: "texworkspace",
    });
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="texworkspace" path={MAIN} projectId="p" tabKey={tab.key} />);
    });

    // Mount the child pane too: the main pane stays mounted beside it.
    const childRow = await screen.findByRole("button", { name: /chap\.tex/i });
    await act(async () => { await userEvent.click(childRow); });
    await waitFor(() => expect(screen.getAllByRole("textbox", { hidden: true })).toHaveLength(2));
    // Let every pane's effects (and the host's gather) settle.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    expect(gatherSpy.mock.calls.map(([p]) => p)).toEqual([MAIN]);

    // A successful compile is the next generation: the HOST re-walks, once.
    const compileBtn = await screen.findAllByRole("button", { name: /compile/i });
    await act(async () => { await userEvent.click(compileBtn[0]); });
    await waitFor(() => expect(gatherSpy).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(gatherSpy.mock.calls.map(([p]) => p)).toEqual([MAIN, MAIN]);
    cleanup();
  });

  it("a standalone TeX tab still gathers by itself", async () => {
    vi.resetModules();
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="tex" path={MAIN} projectId="p" />);
    });
    await waitFor(() => expect(gatherSpy.mock.calls.map(([p]) => p)).toEqual([MAIN]));
    cleanup();
  });
});

describe("TexView `completions` prop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setupInvoke();
  });

  async function renderPane(path: string, completions: import("../../lib/viewers/tex/tex").TexCompletions | null) {
    vi.resetModules();
    const { TexView } = await import("../../components/embed/fileViewer/TexView");
    await act(async () => {
      render(<TexView path={path} onOpenExternally={() => {}} completions={completions} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  }
  const shared = (files: string[]) => ({ labels: [], cites: [], commands: [], envs: [], files: new Set(files) });

  it("uses the shared answer when its walk reached the pane's file", async () => {
    await renderPane(CHILD, shared([MAIN, CHILD]));
    expect(gatherSpy).not.toHaveBeenCalled();
    cleanup();
  });

  it("waits while the host is still gathering", async () => {
    await renderPane(CHILD, null);
    expect(gatherSpy).not.toHaveBeenCalled();
    cleanup();
  });

  it("gathers by itself for a file the shared walk never reached", async () => {
    await renderPane(CHILD, shared([MAIN]));
    expect(gatherSpy.mock.calls.map(([p]) => p)).toEqual([CHILD]);
    cleanup();
  });
});
