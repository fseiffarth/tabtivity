/**
 * Threat model row 28: a deeply nested .json/.yaml used to blow the parser's
 * stack during render, and with no error boundary anywhere the RangeError
 * unmounted the whole window (and every unsaved draft in it).
 *
 * Pinned here: the parser bails on deep flow AND deep block nesting with a
 * translated reason instead of throwing; such a file renders the tree's notice;
 * and the one `ViewerErrorBoundary` in `FileViewerPane` catches a viewer that
 * does throw, recovers when the pane moves to another file, and leaves the
 * other panes — and their drafts — alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { parseYaml, MAX_YAML_DEPTH } from "../../lib/viewers/yaml";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
const { settingsState } = vi.hoisted(() => ({
  settingsState: { settings: { autosave: false, viewer_prefs: {} } as Record<string, unknown> },
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
vi.mock("../../stores/tabs", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const state = {
    tabs: [] as Record<string, unknown>[],
    layout: null,
    addTabToScope: vi.fn(),
    addTab: vi.fn(),
    setActive: vi.fn(),
    removeTab: vi.fn(),
    setViewerState: vi.fn(),
    splitWithNewTab: vi.fn(() => null),
  };
  const useTabsStore = Object.assign(
    (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
    { getState: () => state },
  );
  return { ...actual, useTabsStore, findGroupOfTab: () => null, getDetachedViewerState: () => undefined };
});
// A stand-in viewer that throws while rendering any file named `bad…`: what a
// parser blowing its stack on a hostile file looks like to React.
vi.mock("../../components/embed/OdtView", () => ({
  OdtView: ({ path }: { path: string }) => {
    if (path.includes("/bad")) throw new RangeError("Maximum call stack size exceeded");
    return <div>odt shows {path}</div>;
  },
}));

const files: Record<string, string> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(files)) delete files[k];
  mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "read_file_text") {
      const text = files[args.path as string];
      return text == null ? Promise.reject(new Error("no such file")) : Promise.resolve(text);
    }
    if (cmd === "file_mtime") return Promise.resolve(1000);
    if (cmd === "write_file_text") {
      files[args.path as string] = args.content as string;
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
});

/** Mute React's report of an error a boundary caught, the boundary's own, and
 *  jsdom's echo of the render error React re-dispatches in development. */
let consoleError: ReturnType<typeof vi.spyOn>;
const muteWindowError = (e: ErrorEvent) => e.preventDefault();
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  window.addEventListener("error", muteWindowError);
});
afterEach(() => {
  consoleError.mockRestore();
  window.removeEventListener("error", muteWindowError);
});

describe("YAML/JSON nesting cap", () => {
  it("bails on deep flow nesting with the reason, without throwing", () => {
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    const doc = parseYaml(deep);
    expect(doc.error?.messageKey).toBe("yamlParse.tooDeep");
    expect(doc.error?.messageVars).toEqual({ max: String(MAX_YAML_DEPTH) });

    const json = '{"a":'.repeat(50_000) + "1" + "}".repeat(50_000);
    expect(parseYaml(json, { strict: true }).error?.messageKey).toBe("yamlParse.tooDeep");
  });

  it("bails on deep block nesting too: one-line `- - -` and indented maps", () => {
    // Two bytes a level, no indentation growth: the cheap block bomb.
    expect(parseYaml("- ".repeat(50_000) + "x").error?.messageKey).toBe("yamlParse.tooDeep");

    const lines: string[] = [];
    for (let i = 0; i <= MAX_YAML_DEPTH + 5; i++) lines.push(" ".repeat(i) + "k:");
    lines.push(" ".repeat(MAX_YAML_DEPTH + 6) + "k: 1");
    const doc = parseYaml(lines.join("\n") + "\n");
    expect(doc.error?.messageKey).toBe("yamlParse.tooDeep");
    expect(doc.error?.line).toBeGreaterThan(MAX_YAML_DEPTH);
  });

  it("still reads nesting right up to the cap", () => {
    const n = MAX_YAML_DEPTH + 1; // the root plus MAX_YAML_DEPTH nested levels
    expect(parseYaml("[".repeat(n) + "]".repeat(n)).error).toBeNull();
    expect(parseYaml("[".repeat(n + 1) + "]".repeat(n + 1)).error?.messageKey).toBe("yamlParse.tooDeep");
    expect(parseYaml("- ".repeat(MAX_YAML_DEPTH) + "x").error).toBeNull();
  });

  for (const [name, path, text] of [
    ["flow JSON", "/p/deep.json", "[".repeat(100_000) + "]".repeat(100_000)],
    ["block YAML", "/p/deep.yaml", "- ".repeat(50_000) + "x\n"],
  ] as const) {
    it(`renders a deep ${name} file as the tree's notice, not a crash`, async () => {
      files[path] = text;
      vi.resetModules();
      const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
      await act(async () => {
        render(<FileViewerPane viewer="yaml" path={path} projectId="proj" />);
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Tree" }));
      });
      expect(await screen.findByText(/nests deeper than 512 levels/)).toBeTruthy();
      expect(screen.queryByText("This viewer stopped on an error")).toBeNull();
    });
  }
});

describe("ViewerErrorBoundary", () => {
  function Boom({ when }: { when: boolean }) {
    if (when) throw new Error("kaboom");
    return <p>viewer is fine</p>;
  }

  it("shows its card for a throwing viewer and resets when the file changes", async () => {
    const { ViewerErrorBoundary } = await import("../../components/embed/ViewerErrorBoundary");
    const open = vi.fn();
    const ui = (key: string, bad: boolean, sourcePath: string | null) => (
      <ViewerErrorBoundary resetKey={key} sourcePath={sourcePath} projectId="proj" onOpenExternally={open}>
        <Boom when={bad} />
      </ViewerErrorBoundary>
    );
    const { rerender } = render(ui("a", true, null));
    expect(screen.getByText("This viewer stopped on an error")).toBeTruthy();
    expect(screen.getByText("kaboom")).toBeTruthy();
    // Not a text file: no source to offer.
    expect(screen.queryByRole("button", { name: "Show source" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open externally" }));
    expect(open).toHaveBeenCalledTimes(1);

    // Same file, still broken: stays on the card.
    rerender(ui("a", false, null));
    expect(screen.getByText("This viewer stopped on an error")).toBeTruthy();
    // Try again re-renders the viewer, which now works.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("viewer is fine")).toBeTruthy();

    // Another file clears a caught error without a click.
    rerender(ui("a", true, null));
    expect(screen.getByText("This viewer stopped on an error")).toBeTruthy();
    rerender(ui("b", false, null));
    expect(screen.getByText("viewer is fine")).toBeTruthy();
  });

  it("shows a text file's source as plain text", async () => {
    files["/p/x.yaml"] = "a: [1, 2\n";
    const { ViewerErrorBoundary } = await import("../../components/embed/ViewerErrorBoundary");
    render(
      <ViewerErrorBoundary resetKey="k" sourcePath="/p/x.yaml" projectId="proj" onOpenExternally={() => {}}>
        <Boom when />
      </ViewerErrorBoundary>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    });
    expect((await screen.findByText(/a: \[1, 2/)).tagName).toBe("PRE");
    expect(mockInvoke).toHaveBeenCalledWith("read_file_text", { path: "/p/x.yaml", projectId: "proj" });
  });

  it("keeps a throwing viewer inside its pane: other panes and their drafts survive", async () => {
    files["/p/config.yaml"] = "port: 8080\n";
    vi.resetModules();
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    const panes = (odtPath: string) => (
      <div>
        <FileViewerPane viewer="odt" path={odtPath} projectId="proj" />
        <FileViewerPane viewer="yaml" path="/p/config.yaml" projectId="proj" />
      </div>
    );
    let rerender!: (ui: React.ReactElement) => void;
    await act(async () => {
      ({ rerender } = render(panes("/p/good.odt")));
    });
    expect(screen.getByText("odt shows /p/good.odt")).toBeTruthy();

    // An unsaved edit in the YAML pane.
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Tree" }));
    });
    const port = (await screen.findByLabelText("Value of port")) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(port, { target: { value: "9090" } });
      fireEvent.keyDown(port, { key: "Enter" });
    });

    // The ODT pane moves to a file its viewer throws on.
    await act(async () => {
      rerender(panes("/p/bad.odt"));
    });
    expect(screen.getByText("This viewer stopped on an error")).toBeTruthy();
    expect(screen.getByText("Maximum call stack size exceeded")).toBeTruthy();
    // Binary viewer: no source button.
    expect(screen.queryByRole("button", { name: "Show source" })).toBeNull();

    // The YAML pane is still there with its draft, and still saves it.
    expect((screen.getByLabelText("Value of port") as HTMLInputElement).value).toBe("9090");
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Save"));
    });
    await waitFor(() => expect(files["/p/config.yaml"]).toBe("port: 9090\n"));

    // Back to a good file: the ODT pane recovers on its own.
    await act(async () => {
      rerender(panes("/p/good2.odt"));
    });
    expect(screen.getByText("odt shows /p/good2.odt")).toBeTruthy();
    expect(screen.queryByText("This viewer stopped on an error")).toBeNull();
  });
});
