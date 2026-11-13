/**
 * Viewers of a host-pinned project (a VM or remote-only project,
 * `isHostPinned`; `docs/remote_only_projects_plan.md` D6/F5):
 *  - TeX Compile builds on the host in the background (`compile_tex_host`,
 *    never `compile_tex`), opens no tab of its own, and opens the PDF tab from
 *    the build's answer;
 *  - the SQLite viewer is off for a host file and points at Download to…;
 *  - every viewer holds on the Connect placeholder while the host is down, and
 *    the tab publishes no source badge or Local/Remote switch.
 *
 * `getTexCapability()` caches its probe at module scope, so each render resets
 * the module registry (as `TexViewer.test.tsx` does) and seeds the fresh stores.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { warmFileViewer } from "../helpers/warmViewer";
import { render, screen, act, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
vi.mock("../../stores/settings", () => {
  const state = { settings: { autosave: false, viewer_prefs: {} } };
  return {
    useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(state), {
      getState: () => state,
    }),
  };
});

const TEX_SOURCE = "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n";
const ROOT = "/srv/p";

/** What the host build answers: a PDF beside the source. */
function hostBuilt(args?: Record<string, unknown>) {
  const pdf = String(args?.path ?? "").replace(/\.tex$/, ".pdf");
  return Promise.resolve({ success: true, pdf_path: pdf, engine: "latexmk -pdf (host)", log: "", shell_escape: false, driver_note: null });
}

function setupInvoke() {
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    // No TeX on this machine: a host-pinned project builds on its host anyway.
    if (cmd === "tex_capability") return Promise.resolve({ available: false, engines: [], bibtex: false, latexmk: false });
    if (cmd === "file_source") return Promise.resolve("remote");
    if (cmd === "read_file_text") return Promise.resolve(TEX_SOURCE);
    if (cmd === "write_file_text") return Promise.resolve(null);
    if (cmd === "resolve_tex_root") return Promise.resolve((args?.path as string) ?? "");
    if (cmd === "file_mtime") return Promise.resolve(1);
    if (cmd === "compile_tex_host") return hostBuilt(args);
    return Promise.resolve(null);
  });
}

async function renderPinned(opts: {
  viewer: "tex" | "sqlite" | "text";
  path: string;
  ssh?: "connected" | "error";
  /** A plain remote project (with a local mirror) instead of a remote-only one. */
  mirrored?: boolean;
  /** Seeds tabs in the project's scope before the viewer mounts. */
  before?: (store: typeof import("../../stores/tabs").useTabsStore) => void;
}) {
  vi.resetModules();
  const { useProjectsStore } = await import("../../stores/projects");
  const { useRemoteStatusStore } = await import("../../stores/remote/remoteStatus");
  const { useTabsStore } = await import("../../stores/tabs");
  const { useFileSourcesStore } = await import("../../stores/viewers/fileSources");
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  useProjectsStore.setState({
    projects: [
      {
        id: "proj",
        name: "P",
        directory: "/state/proj",
        local_file: "/state/proj/project.json",
        remote: { host: "h.invalid", remote_path: ROOT, remote_only: !opts.mirrored },
      } as never,
    ],
  });
  useRemoteStatusStore.getState().setSsh("proj", opts.ssh ?? "connected");
  useTabsStore.getState().setScope("proj");
  opts.before?.(useTabsStore);
  await act(async () => {
    render(<FileViewerPane viewer={opts.viewer} path={opts.path} projectId="proj" tabKey="view1" />);
  });
  return { useTabsStore, useFileSourcesStore };
}

warmFileViewer();

describe("TeX Compile on a host-pinned project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setupInvoke();
  });
  afterEach(() => cleanup());

  it("builds on the host in the background and opens the PDF it reports, with no tab of its own", async () => {
    const { useTabsStore } = await renderPinned({ viewer: "tex", path: `${ROOT}/paper.tex` });
    const compile = await screen.findByRole("button", { name: /compile/i });
    // No local-only controls: the hover preview and the out-dir/flags options.
    expect(document.querySelector(".file-viewer-tex-preview-toggle")).toBeNull();
    expect(document.querySelector(".file-viewer-tex-options-toggle")).toBeNull();

    await userEvent.click(compile);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("compile_tex_host", { projectId: "proj", path: `${ROOT}/paper.tex`, engine: null }),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith("compile_tex", expect.anything());
    const all = () => useTabsStore.getState().tabsByScope["proj"] ?? useTabsStore.getState().tabs;
    await waitFor(() =>
      expect(all().filter((t) => t.kind === "embed" && t.embedPath === `${ROOT}/paper.pdf`)).toHaveLength(1),
    );
    expect(all().some((t) => t.kind === "shell")).toBe(false);

    // Compile again: the same PDF tab, still no build tab.
    await userEvent.click(compile);
    await waitFor(() => expect(mockInvoke.mock.calls.filter(([c]) => c === "compile_tex_host")).toHaveLength(2));
    await act(async () => {});
    expect(all().filter((t) => t.kind === "embed" && t.embedPath === `${ROOT}/paper.pdf`)).toHaveLength(1);
    expect(all().some((t) => t.kind === "shell")).toBe(false);
  }, 15_000);

  it("shows the host build's error like a local one", async () => {
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "compile_tex_host"
        ? Promise.resolve({
            success: false,
            pdf_path: null,
            engine: "latexmk -pdf (host)",
            log: "./paper.tex:3: Undefined control sequence.\nl.3 \\foo\n",
            shell_escape: false,
            driver_note: null,
          })
        : base(cmd, args),
    );
    const { useTabsStore } = await renderPinned({ viewer: "tex", path: `${ROOT}/paper.tex` });
    await userEvent.click(await screen.findByRole("button", { name: /compile/i }));
    expect(await screen.findAllByText(/Undefined control sequence/)).not.toHaveLength(0);
    const all = useTabsStore.getState().tabsByScope["proj"] ?? useTabsStore.getState().tabs;
    expect(all.some((t) => t.kind === "shell" || t.viewer === "pdf")).toBe(false);
  }, 15_000);
});

describe("TeX Compile of a remote project's file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setupInvoke();
  });
  afterEach(() => cleanup());

  // The host path `compile_tex` used to get here failed with "canonicalize
  // <host path>: No such file or directory": it only opens files on this machine.
  it("builds a file read from the host there, even with TeX installed here", async () => {
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "tex_capability"
        ? Promise.resolve({ available: true, engines: ["pdflatex"], bibtex: true, latexmk: true })
        : base(cmd, args),
    );
    const { useTabsStore } = await renderPinned({ viewer: "tex", path: `${ROOT}/paper.tex`, mirrored: true });
    await userEvent.click(await screen.findByRole("button", { name: /compile/i }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("compile_tex_host", expect.objectContaining({ path: `${ROOT}/paper.tex` })),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith("compile_tex", expect.anything());
    const all = useTabsStore.getState().tabsByScope["proj"] ?? useTabsStore.getState().tabs;
    expect(all.some((t) => t.kind === "shell")).toBe(false);
  }, 15_000);

  // The reported bug: the PDF tab open on the mirror's copy was not found by the
  // host build's PDF path, so every Compile opened one more PDF tab.
  it("shows the host PDF in the PDF tab already open on the mirror's copy", async () => {
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "tex_capability"
        ? Promise.resolve({ available: true, engines: ["pdflatex"], bibtex: true, latexmk: true })
        : base(cmd, args),
    );
    const seeded = { key: "" };
    const { useTabsStore: tabs } = await renderPinned({
      viewer: "tex",
      path: `${ROOT}/paper.tex`,
      mirrored: true,
      before: (store) => {
        seeded.key = store.getState().addTab({
          label: "paper.pdf",
          cmd: "",
          cwd: "/state/proj/mirror",
          kind: "embed",
          embedPath: "/state/proj/mirror/paper.pdf",
          viewer: "pdf",
        }).key;
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: /compile/i }));
    const pdfTabs = () =>
      (tabs.getState().tabsByScope["proj"] ?? tabs.getState().tabs).filter((t) => t.viewer === "pdf");
    await waitFor(() => expect(pdfTabs().map((t) => t.embedPath)).toEqual([`${ROOT}/paper.pdf`]));
    expect(pdfTabs()[0].key).toBe(seeded.key);
  }, 15_000);

  it("still compiles the local mirror's copy on this machine", async () => {
    const base = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "tex_capability") return Promise.resolve({ available: true, engines: ["pdflatex"], bibtex: true, latexmk: true });
      if (cmd === "file_source") return Promise.resolve("local");
      if (cmd === "compile_tex") return Promise.resolve({ success: false, log: "", pdf_path: null, shell_escape: false });
      return base(cmd, args);
    });
    const { useTabsStore } = await renderPinned({ viewer: "tex", path: "/mirror/proj/paper.tex", mirrored: true });
    // Wait for `file_source` to answer before pressing Compile.
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("file_source", expect.anything()));
    await act(async () => {});
    await userEvent.click(await screen.findByRole("button", { name: /compile/i }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("compile_tex", expect.objectContaining({ path: "/mirror/proj/paper.tex" })));
    const all = useTabsStore.getState().tabsByScope["proj"] ?? useTabsStore.getState().tabs;
    expect(all.some((t) => t.kind === "shell")).toBe(false);
  }, 15_000);
});

describe("other viewers of a host-pinned project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupInvoke();
  });
  afterEach(() => cleanup());

  it("turns the SQLite viewer off for a host database and points at Download to…", async () => {
    await renderPinned({ viewer: "sqlite", path: `${ROOT}/data.db` });
    const { translateNow } = await import("../../lib/i18n");
    expect(await screen.findByText(translateNow("fileTree.sqliteHostOnly", { name: "data.db" }))).toBeTruthy();
    expect(mockInvoke).not.toHaveBeenCalledWith("sqlite_tables", expect.anything());
  });

  it("offers no auto-sync toggle, and Open externally explains the file is on the host", async () => {
    await renderPinned({ viewer: "text", path: `${ROOT}/a.py` });
    const { translateNow } = await import("../../lib/i18n");
    const open = await screen.findByRole("button", { name: translateNow("pdfViewer.openExternalTitle") });
    expect(document.querySelector(".file-viewer-autosync")).toBeNull();
    await userEvent.click(open);
    expect(await screen.findByText(translateNow("fileTree.hostFileExternalTitle"))).toBeTruthy();
  });

  it("publishes no source badge or switch, and holds at once while the host is down", async () => {
    const { useFileSourcesStore } = await renderPinned({ viewer: "text", path: `${ROOT}/a.py`, ssh: "error" });
    const { translateNow } = await import("../../lib/i18n");
    expect(screen.getByText(translateNow("remotePane.notConnected"))).toBeTruthy();
    expect(mockInvoke).not.toHaveBeenCalledWith("read_file_text", expect.anything());
    expect(useFileSourcesStore.getState().byTab["view1"]).toBeUndefined();
    expect(useFileSourcesStore.getState().controlsByTab["view1"]).toBeUndefined();
  });
});
