/**
 * Python features in the native code viewer (#py), driven through the real UI:
 *  - Run/Debug open a terminal tab in the file's OWN project scope, running the
 *    venv interpreter when the project has one.
 *  - The gutter sets breakpoints (snapping off blank/comment lines), and Debug
 *    hands them to pdb.
 *  - Ctrl+Click on an imported name opens the defining file at its `def`.
 *  - None of it appears for a non-Python file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import { envName } from "../../lib/brand";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
// Run/Debug + the gutter are behind the experimental `python_run_debug` setting;
// the tests below turn it on, and the last block asserts what is left with it off.
const { settingsState } = vi.hoisted(() => ({
  settingsState: {
    settings: { autosave: false, viewer_prefs: {}, python_run_debug: true } as Record<
      string,
      unknown
    >,
  },
}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(settingsState), {
    getState: () => settingsState,
  }),
}));
vi.mock("../../stores/projects", () => {
  const state = {
    projects: [{ id: "proj", directory: "/p", local_file: "/p/project.json" }],
    activeId: "proj",
  };
  const useProjectsStore = Object.assign(
    (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
    { getState: () => state },
  );
  return { useProjectsStore };
});

// The tabs store is mocked so the test can assert on exactly what Run/Debug and
// go-to-definition ask it to open, without standing up a layout tree.
const { addTabToScope, addTab, setActive, removeTab, setViewerState } = vi.hoisted(() => ({
  addTabToScope: vi.fn((_scope: string, tab: Record<string, unknown>) => ({ ...tab, key: "t1" })),
  addTab: vi.fn((tab: Record<string, unknown>) => ({ ...tab, key: "t2" })),
  setActive: vi.fn(),
  removeTab: vi.fn(),
  setViewerState: vi.fn(),
}));
vi.mock("../../stores/tabs", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const state = {
    tabs: [] as Record<string, unknown>[],
    layout: null,
    addTabToScope,
    addTab,
    setActive,
    removeTab,
    setViewerState,
    splitWithNewTab: vi.fn(() => null),
  };
  const useTabsStore = Object.assign(
    (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
    { getState: () => state },
  );
  return {
    ...actual,
    useTabsStore,
    findGroupOfTab: () => null,
    getDetachedViewerState: () => undefined,
  };
});

// Run/Debug only show for a "main" script (a module-level `__main__` guard),
// so the fixture needs one — kept on line 3 so the blank-line-2-snaps-to-3
// breakpoint tests below still land where they expect.
const MAIN = 'from .util import helper\n\nif __name__ == "__main__":\n    helper()\n';
const UTIL = "import os\n\n\ndef helper(x):\n    return x\n";

/** What the backend's interpreter resolver hands back (#87): the project's pinned
 *  choice, else the best auto-detected environment. The *precedence* is the
 *  backend's business (`commands::python`, tested there); here it is simply the
 *  answer Run/Debug are obliged to use. */
let interpreter = "python3";

function setup() {
  interpreter = "python3";
  settingsState.settings.python_run_debug = true;
  mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "read_file_text") {
      const path = args.path as string;
      if (path === "/p/main.py") return Promise.resolve(MAIN);
      if (path === "/p/util.py") return Promise.resolve(UTIL);
      if (path === "/p/notes.txt") return Promise.resolve("plain text\n");
      return Promise.reject(new Error("no such file"));
    }
    if (cmd === "file_mtime") return Promise.resolve(1000);
    if (cmd === "python_interpreter_for") return Promise.resolve(interpreter);
    return Promise.resolve(null);
  });
}

async function renderViewer(path = "/p/main.py") {
  vi.resetModules();
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="text" path={path} projectId="proj" />);
  });
  const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
  await waitFor(() => expect(textarea.value.length).toBeGreaterThan(0));
  return textarea;
}

/** The tab Run/Debug opened. */
function launchedTab() {
  expect(addTabToScope).toHaveBeenCalledTimes(1);
  const [scope, tab] = addTabToScope.mock.calls[0] as [string, Record<string, unknown>];
  return { scope, tab };
}

describe("python run/debug (#py)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("Run opens a shell tab in the file's project scope, running the file", async () => {
    await renderViewer();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Run file"));
    });

    const { scope, tab } = launchedTab();
    // The file's OWN project, not whichever is globally active.
    expect(scope).toBe("proj");
    expect(tab.kind).toBe("shell");
    expect(tab.cwd).toBe("/p");
    expect(tab.initialInput).toBe("'python3' '/p/main.py'");
    expect(setActive).toHaveBeenCalledWith("t1");
  });

  it("Run uses the interpreter the backend resolved, not a bare python3", async () => {
    await renderViewer();
    // The project's venv (or conda env, or a pinned interpreter) — running with
    // the system python3 would ModuleNotFoundError on the project's own deps.
    interpreter = ".venv/bin/python";
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Run file"));
    });
    expect(launchedTab().tab.initialInput).toBe("'.venv/bin/python' '/p/main.py'");
  });

  it("Debug runs pdb under that same interpreter", async () => {
    await renderViewer();
    interpreter = "/opt/conda/envs/ml/bin/python";
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Debug file"));
    });
    expect(launchedTab().tab.initialInput).toBe(
      "'/opt/conda/envs/ml/bin/python' -m pdb '/p/main.py'",
    );
  });

  it("Debug with no breakpoints runs pdb, which stops at the first line", async () => {
    await renderViewer();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Debug file"));
    });
    expect(launchedTab().tab.initialInput).toBe("'python3' -m pdb '/p/main.py'");
  });

  it("a gutter click sets a breakpoint, and Debug hands it to pdb", async () => {
    await renderViewer();
    // Line 3 is the `if __name__ == "__main__":` guard.
    const line3 = screen.getByLabelText("Break on line 3");
    expect(line3.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      fireEvent.click(line3);
    });
    expect(
      screen.getByLabelText("Remove breakpoint on line 3").getAttribute("aria-pressed"),
    ).toBe("true");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Debug file"));
    });
    expect(launchedTab().tab.initialInput).toBe(
      "'python3' -m pdb -c 'b /p/main.py:3' -c 'continue' '/p/main.py'",
    );
  });

  it("a click on a blank line snaps down to the next executable line", async () => {
    await renderViewer();
    // Line 2 is blank — pdb refuses to break there, so the dot lands on line 3.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Break on line 2"));
    });
    expect(screen.queryByLabelText("Remove breakpoint on line 2")).toBeNull();
    expect(screen.queryByLabelText("Remove breakpoint on line 3")).not.toBeNull();
  });

  it("clicking a set breakpoint clears it", async () => {
    await renderViewer();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Break on line 3"));
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Remove breakpoint on line 3"));
    });
    expect(screen.getByLabelText("Break on line 3").getAttribute("aria-pressed")).toBe("false");
  });

  it("re-running replaces the previous run tab for the same file", async () => {
    // A live run tab for this file, marked by the env vars openPythonTab writes.
    const { useTabsStore } = await import("../../stores/tabs");
    const state = useTabsStore.getState() as unknown as { tabs: Record<string, unknown>[] };
    state.tabs = [
      {
        key: "old",
        kind: "shell",
        env: { [envName("PY_TARGET")]: "/p/main.py", [envName("PY_MODE")]: "run" },
      },
    ];
    await renderViewer();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Run file"));
    });
    // Killed rather than re-typed into: the old PTY may still be busy.
    expect(removeTab).toHaveBeenCalledWith("old");
    expect(addTabToScope).toHaveBeenCalledTimes(1);
    state.tabs = [];
  });
});

describe("python go-to-definition (#py)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("Ctrl+Click on an imported name opens the defining file at its def", async () => {
    const textarea = await renderViewer();
    // Caret inside the `helper()` call on line 3.
    const caret = MAIN.lastIndexOf("helper") + 2;
    textarea.selectionStart = textarea.selectionEnd = caret;

    await act(async () => {
      fireEvent.click(textarea, { ctrlKey: true });
    });

    // The sibling module was resolved and opened as its own viewer tab.
    await waitFor(() => expect(addTab).toHaveBeenCalled());
    const opened = addTab.mock.calls[0][0] as Record<string, unknown>;
    expect(opened.embedPath).toBe("/p/util.py");
    expect(opened.kind).toBe("embed");
  });

  it("a plain click (no modifier) never navigates", async () => {
    const textarea = await renderViewer();
    textarea.selectionStart = textarea.selectionEnd = MAIN.lastIndexOf("helper") + 2;
    await act(async () => {
      fireEvent.click(textarea);
    });
    expect(addTab).not.toHaveBeenCalled();
  });

  it("Ctrl+Click on an unresolvable name does nothing", async () => {
    const textarea = await renderViewer();
    // `os` is imported by util.py, not by this file, and is not in the tree.
    textarea.selectionStart = textarea.selectionEnd = MAIN.indexOf("from") + 1;
    await act(async () => {
      fireEvent.click(textarea, { ctrlKey: true });
    });
    expect(addTab).not.toHaveBeenCalled();
  });
});

describe("a plain module (no __main__ guard) keeps no Run/Debug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("hides Run/Debug on a Python file with nothing to execute", async () => {
    await renderViewer("/p/util.py");
    expect(screen.queryByLabelText("Run file")).toBeNull();
    expect(screen.queryByLabelText("Debug file")).toBeNull();
  });
});

describe("non-Python files keep the plain editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("shows no Run/Debug buttons and no breakpoint gutter", async () => {
    await renderViewer("/p/notes.txt");
    expect(screen.queryByLabelText("Run file")).toBeNull();
    expect(screen.queryByLabelText("Debug file")).toBeNull();
    expect(screen.queryByLabelText("Break on line 1")).toBeNull();
  });
});

describe("the experimental gate (`python_run_debug`, default off)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
    delete settingsState.settings.python_run_debug; // unset, not false
  });

  it("hides Debug and the breakpoint gutter on a Python file, but keeps Run", async () => {
    await renderViewer();
    // Run is deliberately ungated: it opens a plain terminal tab, nothing
    // experimental about it. Only Debug (pdb) and the gutter that feeds it
    // sit behind the flag.
    expect(screen.queryByLabelText("Run file")).not.toBeNull();
    expect(screen.queryByLabelText("Debug file")).toBeNull();
    // The gutter exists only to feed Debug, so it goes with it.
    expect(screen.queryByLabelText("Break on line 3")).toBeNull();
  });

  it("debug mode turns it on with no toggle to tick", async () => {
    settingsState.settings.debug = true;
    await renderViewer();
    expect(screen.queryByLabelText("Run file")).not.toBeNull();
    expect(screen.queryByLabelText("Break on line 3")).not.toBeNull();
    delete settingsState.settings.debug;
  });

  it("an explicit off still wins inside debug mode", async () => {
    settingsState.settings.debug = true;
    settingsState.settings.python_run_debug = false;
    await renderViewer();
    expect(screen.queryByLabelText("Debug file")).toBeNull();
    delete settingsState.settings.debug;
  });

  it("still follows Ctrl+Click to a definition — reading is not running", async () => {
    const textarea = await renderViewer();
    textarea.selectionStart = textarea.selectionEnd = MAIN.lastIndexOf("helper") + 2;
    await act(async () => {
      fireEvent.click(textarea, { ctrlKey: true });
    });
    await waitFor(() => expect(addTab).toHaveBeenCalled());
    expect((addTab.mock.calls[0][0] as Record<string, unknown>).embedPath).toBe("/p/util.py");
  });
});
