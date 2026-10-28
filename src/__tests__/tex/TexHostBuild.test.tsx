/**
 * Viewers of a host-pinned project (a VM or remote-only project,
 * `isHostPinned`; `docs/remote_only_projects_plan.md` D6/F5):
 *  - TeX Compile opens a build tab on the host typing the plan's latexmk line
 *    (never `compile_tex`), replaces that document's previous build tab, and
 *    opens the PDF tab once the build writes it;
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
import {
  hostTexBuildArgv,
  hostTexBuildCommand,
  latexmkEngineFlag,
} from "../../lib/viewers/tex/hostTexBuild";

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

describe("the host build's command line", () => {
  it("runs latexmk in the file's folder on a ./-relative name, every arg quoted", () => {
    const argv = hostTexBuildArgv(`${ROOT}/ch 1/-main's.tex`, ROOT, "lualatex");
    expect(argv).toEqual([
      "latexmk",
      "-cd",
      "-pdflua",
      "-interaction=nonstopmode",
      "-synctex=1",
      "./ch 1/-main's.tex",
    ]);
    expect(hostTexBuildCommand(argv)).toBe(
      "'latexmk' '-cd' '-pdflua' '-interaction=nonstopmode' '-synctex=1' './ch 1/-main'\\''s.tex'",
    );
  });

  it("maps engines as the local build does, and keeps a path outside the root absolute", () => {
    expect(latexmkEngineFlag("xelatex")).toBe("-pdfxe");
    expect(latexmkEngineFlag("")).toBe("-pdf");
    expect(latexmkEngineFlag("pdflatex")).toBe("-pdf");
    const outside = hostTexBuildArgv("/elsewhere/a.tex", ROOT, null);
    expect(outside[outside.length - 1]).toBe("/elsewhere/a.tex");
  });
});

type Mtime = () => Promise<number>;
let pdfMtime: Mtime;

function setupInvoke() {
  pdfMtime = () => Promise.reject(new Error("no such file"));
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    // No TeX on this machine: a host-pinned project builds on its host anyway.
    if (cmd === "tex_capability") return Promise.resolve({ available: false, engines: [], bibtex: false, latexmk: false });
    if (cmd === "file_source") return Promise.resolve("remote");
    if (cmd === "read_file_text") return Promise.resolve(TEX_SOURCE);
    if (cmd === "write_file_text") return Promise.resolve(null);
    if (cmd === "resolve_tex_root") return Promise.resolve((args?.path as string) ?? "");
    if (cmd === "file_mtime") {
      return String(args?.path ?? "").endsWith(".pdf") ? pdfMtime() : Promise.resolve(1);
    }
    return Promise.resolve(null);
  });
}

async function renderPinned(opts: { viewer: "tex" | "sqlite" | "text"; path: string; ssh?: "connected" | "error" }) {
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
        remote: { host: "h.invalid", remote_path: ROOT, remote_only: true },
      } as never,
    ],
  });
  useRemoteStatusStore.getState().setSsh("proj", opts.ssh ?? "connected");
  useTabsStore.getState().setScope("proj");
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

  it("opens a build tab on the host, replaces it on the next Compile, and opens the PDF once written", async () => {
    const { useTabsStore } = await renderPinned({ viewer: "tex", path: `${ROOT}/paper.tex` });
    const compile = await screen.findByRole("button", { name: /compile/i });
    // No local-only controls: the hover preview and the out-dir/flags options.
    expect(document.querySelector(".file-viewer-tex-preview-toggle")).toBeNull();
    expect(document.querySelector(".file-viewer-tex-options-toggle")).toBeNull();

    await userEvent.click(compile);
    const builds = () =>
      (useTabsStore.getState().tabsByScope["proj"] ?? useTabsStore.getState().tabs).filter(
        (t) => t.kind === "shell",
      );
    await waitFor(() => expect(builds()).toHaveLength(1));
    const tab = builds()[0];
    expect(tab.cmd).toBe("");
    expect(tab.location).toBe("remote");
    expect(tab.ephemeral).toBe(true);
    expect(tab.initialInput).toBe(
      "'latexmk' '-cd' '-pdf' '-interaction=nonstopmode' '-synctex=1' './paper.tex'",
    );
    expect(mockInvoke).not.toHaveBeenCalledWith("compile_tex", expect.anything());

    // Compile again: still one build tab for the document, a fresh one.
    await userEvent.click(compile);
    await waitFor(() => expect(builds()[0]?.key).not.toBe(tab.key));
    expect(builds()).toHaveLength(1);

    // The build writes the PDF: the viewer's watch sees it appear and opens it.
    pdfMtime = () => Promise.resolve(42);
    await waitFor(
      () => {
        const all = useTabsStore.getState().tabsByScope["proj"] ?? useTabsStore.getState().tabs;
        expect(all.some((t) => t.kind === "embed" && t.embedPath === `${ROOT}/paper.pdf`)).toBe(true);
      },
      { timeout: 6000 },
    );
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
