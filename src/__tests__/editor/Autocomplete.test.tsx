/**
 * Tests for opt-in local autocomplete (#45, DECISION A):
 *  - Ctrl+Space requests a completion ONLY when the per-type setting is on, after
 *    ensure_ollama_running; the suggestion renders as ghost text and Tab accepts.
 *  - When the setting is OFF, Ctrl+Space never calls out (privacy gate).
 *  - Partial accept: → (Right) inserts only the next word and keeps the rest
 *    ghosted; a later plain Tab finishes it.
 *  - Completion-length modes: requests carry the active `mode`, and Shift+Tab
 *    toggles it (sentence → block → scope) then re-requests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { warmFileViewer } from "../helpers/warmViewer";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import { completionModelOrder, completionWindow, pickCompletionModel, typeThrough } from "../../lib/viewers/completion/autocomplete";

const { mockInvoke, mockListen, mockBump } = vi.hoisted(() => ({ mockInvoke: vi.fn(), mockListen: vi.fn(), mockBump: vi.fn() }));
vi.mock("../../stores/usage", () => ({ bumpUsage: mockBump }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mockListen, emit: vi.fn() }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
// The file at /p/foo.py belongs to a project rooted at /p, so the context-file
// picker (#45) lists that project's files.
vi.mock("../../stores/projects", () => {
  const state = {
    projects: [
      { id: "proj", directory: "/p", local_file: "/p/project.json" },
      {
        id: "win",
        directory: "C:\\Work\\Demo",
        local_file: "C:\\Work\\Demo\\project.json",
      },
    ],
    activeId: "proj",
  };
  // Callable like a real zustand hook (selector) AND exposes getState(), since
  // FileViewerPane reads it both ways (subscribes for the disconnected gate,
  // reads getState() in handlers).
  const useProjectsStore = Object.assign(
    (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
    { getState: () => state },
  );
  return { useProjectsStore };
});

const SOURCE = "def foo():\n    ";

// The settings the mocked store returns — toggled per test via this ref.
let autocompleteOn = false;
let copilotOn = false;
vi.mock("../../stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) =>
    sel({
      settings: {
        autosave: false,
        copilot_completion: copilotOn,
        code_completion_provider: copilotOn ? "copilot" : "ollama",
        completion_project_policies: { proj: { directory: "/p", copilot: copilotOn, local_only: false } },
        viewer_prefs: { text: { autocomplete: autocompleteOn } },
      },
    }),
}));

function setup() {
  mockListen.mockImplementation(() => Promise.resolve(() => {}));
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "read_file_text") return Promise.resolve(SOURCE);
    if (cmd === "file_mtime") return Promise.resolve(1000);
    if (cmd === "list_project_paths")
      return Promise.resolve([{ path: "helper.py", is_dir: false }]);
    if (cmd === "ensure_ollama_running") return Promise.resolve(null);
    // Completion runs against whichever model is currently loaded in memory.
    if (cmd === "list_ollama_models_detailed")
      return Promise.resolve([{ name: "llama3.2:3b", running: true }]);
    if (cmd === "prepare_text_completion") return Promise.resolve("test-request");
    if (cmd === "complete_text") return Promise.resolve("return 42");
    return Promise.resolve(null);
  });
}

async function renderTextView(path = "/p/foo.py") {
  vi.resetModules();
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<FileViewerPane viewer="text" path={path} projectId="proj" />);
  });
  return { ...view, setVisible: (visible: boolean) => view.rerender(
    <FileViewerPane viewer="text" path={path} projectId="proj" visible={visible} />,
  ) };
}

warmFileViewer();

describe("local autocomplete (#45)", () => {
  beforeEach(() => {
    copilotOn = false;
    vi.clearAllMocks();
    setup();
  });

  it("offers Copilot without a local model and cycles the actual returned items without another request", async () => {
    autocompleteOn = true;
    copilotOn = true;
    const original = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === "list_ollama_models_detailed") return Promise.resolve([]);
      if (cmd === "copilot_prepare") return Promise.resolve("reservation");
      if (cmd === "copilot_complete") return Promise.resolve([
        { id: "session:1:0", insertText: "return first" },
        { id: "session:1:1", insertText: "return second" },
      ]);
      return original(cmd, args);
    });
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    expect(screen.getByRole("button", { name: /Autocomplete/ })).toBeTruthy();
    expect(screen.queryByText("Sentence")).toBeNull();
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    expect(screen.getByText("return first")).toBeTruthy();
    for (const text of ["return second", "return first"]) {
      await act(async () => { fireEvent.keyDown(el, { key: "]", altKey: true }); });
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "copilot_complete")).toHaveLength(1);
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "complete_text")).toBe(false);
  });

  it("cycles three candidates on demand and reuses both caches when revisiting", async () => {
    autocompleteOn = true;
    const original = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args: { candidate?: number }) => cmd === "complete_text"
      ? Promise.resolve(`choice${args.candidate}`) : original(cmd, args));
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    expect(screen.getByText("choice0")).toBeTruthy();
    // The middle step is German QWERTZ, where `]` hides behind AltGr: Alt on
    // the US `]` position types "+" and must cycle just the same.
    for (const index of [1, 2, 0]) {
      const chord = index === 2 ? { key: "+", code: "BracketRight", altKey: true } : { key: "]", altKey: true };
      await act(async () => { fireEvent.keyDown(el, chord); });
      expect(screen.getByText(`choice${index}`)).toBeTruthy();
    }
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "complete_text")).toHaveLength(3);
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "list_ollama_models_detailed")).toHaveLength(1);
    await act(async () => { fireEvent.keyDown(el, { key: "Escape" }); });
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    expect(screen.getByText("choice0")).toBeTruthy();
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "complete_text")).toHaveLength(3);
    expect(mockBump).toHaveBeenCalledWith("proj", "autocomplete.dismiss.sentence.ollama/llama3.2:3b");
  });

  it("accepts a line with Alt+Right and counts partial acceptance only once", async () => {
    autocompleteOn = true;
    const original = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args: unknown) => cmd === "complete_text"
      ? Promise.resolve("first\nsecond\nthird") : original(cmd, args));
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    await act(async () => { fireEvent.keyDown(el, { key: "ArrowRight", altKey: true }); });
    expect(el.value).toBe(SOURCE + "first\n");
    await act(async () => { fireEvent.keyDown(el, { key: "Tab" }); });
    expect(el.value).toBe(SOURCE + "first\nsecond\nthird");
    expect(mockBump).toHaveBeenCalledTimes(1);
    expect(mockBump).toHaveBeenCalledWith("proj", "autocomplete.accept.sentence.ollama/llama3.2:3b");
  });

  it("automatically includes imports and refreshes context before reusing a completion", async () => {
    autocompleteOn = true;
    const source = "from helper import answer\nanswer = ";
    let reference = "answer = 42";
    const original = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args: { path?: string }) => cmd === "read_file_text"
      ? Promise.resolve(args.path === "/p/helper.py" ? reference : source) : original(cmd, args));
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(source));
    el.selectionStart = el.selectionEnd = source.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    expect(mockInvoke).toHaveBeenCalledWith("complete_text", expect.objectContaining({
      context: expect.arrayContaining([{ name: "helper.py", content: "answer = 42" }]),
    }));
    reference = "answer = 99";
    await act(async () => { fireEvent.keyDown(el, { key: "Escape" }); });
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "complete_text")).toHaveLength(2);
    expect(mockInvoke).toHaveBeenLastCalledWith("cancel_text_completion", expect.anything());
  });

  it("streams before completion, cancels on matching input, and retains only the untyped ghost", async () => {
    autocompleteOn = true;
    const original = mockInvoke.getMockImplementation()!;
    let finish!: (value: string) => void;
    mockInvoke.mockImplementation((cmd: string, args: unknown) => cmd === "complete_text"
      ? new Promise<string>((resolve) => { finish = resolve; }) : original(cmd, args));
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    const publish = mockListen.mock.calls.find(([event]) => event === "text-completion-test-request")![1];
    await act(async () => { publish({ payload: "return 42" }); });
    expect(screen.getByText("return 42")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(el, { key: "r" });
      fireEvent.change(el, { target: { value: SOURCE + "r" } });
    });
    expect(screen.getByText("eturn 42")).toBeTruthy();
    expect(mockInvoke).toHaveBeenCalledWith("cancel_text_completion", { requestId: "test-request" });
    // Neither a queued event nor the final response can resurrect it.
    await act(async () => { publish({ payload: "return 999" }); finish("return 999"); });
    expect(screen.queryByText("return 999")).toBeNull();
    fireEvent.keyDown(el, { key: "Tab" });
    expect(el.value).toBe(SOURCE + "return 42");
  });

  it("cancels while waiting for the first token and rejects late output", async () => {
    autocompleteOn = true;
    const original = mockInvoke.getMockImplementation()!;
    let finish!: (value: string) => void;
    mockInvoke.mockImplementation((cmd: string, args: unknown) => cmd === "complete_text"
      ? new Promise<string>((resolve) => { finish = resolve; }) : original(cmd, args));
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    await act(async () => { fireEvent.change(el, { target: { value: SOURCE + "x" } }); });
    expect(mockInvoke).toHaveBeenCalledWith("cancel_text_completion", { requestId: "test-request" });
    await act(async () => { finish("stale ghost"); });
    expect(screen.queryByText("stale ghost")).toBeNull();
  });

  it("cancels a reservation that arrives after Escape without starting generation", async () => {
    autocompleteOn = true;
    const original = mockInvoke.getMockImplementation()!;
    let reserve!: (value: string) => void;
    mockInvoke.mockImplementation((cmd: string, args: unknown) => cmd === "prepare_text_completion"
      ? new Promise<string>((resolve) => { reserve = resolve; }) : original(cmd, args));
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    await act(async () => { fireEvent.keyDown(el, { key: "Escape" }); reserve("late-request"); });
    expect(mockInvoke).toHaveBeenCalledWith("cancel_text_completion", { requestId: "late-request" });
    expect(mockInvoke).not.toHaveBeenCalledWith("complete_text", expect.anything());
  });

  it.each(["hide", "disable", "unmount"])("cancels and detaches the event listener on %s", async (action) => {
    autocompleteOn = true;
    const original = mockInvoke.getMockImplementation()!;
    let finish!: (value: string) => void;
    const unlisten = vi.fn();
    mockListen.mockResolvedValue(unlisten);
    mockInvoke.mockImplementation((cmd: string, args: unknown) => cmd === "complete_text"
      ? new Promise<string>((resolve) => { finish = resolve; }) : original(cmd, args));
    const view = await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    await act(async () => {
      if (action === "unmount") view.unmount();
      else {
        if (action === "disable") autocompleteOn = false;
        view.setVisible(action !== "hide");
      }
    });
    expect(mockInvoke).toHaveBeenCalledWith("cancel_text_completion", { requestId: "test-request" });
    await act(async () => { finish("late ghost"); });
    expect(unlisten).toHaveBeenCalled();
    expect(screen.queryByText("late ghost")).toBeNull();
  });

  it("does NOT call out on Ctrl+Space when the per-type setting is OFF", async () => {
    autocompleteOn = false;
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));
    await act(async () => {
      fireEvent.keyDown(textarea, { key: " ", ctrlKey: true });
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("list_ollama_models_detailed");
    expect(mockInvoke).not.toHaveBeenCalledWith("complete_text", expect.anything());
  });

  it("requests + shows a ghost suggestion on Ctrl+Space when enabled, Tab accepts", async () => {
    autocompleteOn = true;
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));
    // Caret at end.
    textarea.selectionStart = textarea.selectionEnd = SOURCE.length;

    await act(async () => {
      fireEvent.keyDown(textarea, { key: " ", ctrlKey: true });
    });

    // It resolves the currently-loaded local model first (local-only), then
    // completes against it.
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("list_ollama_models_detailed"));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "complete_text",
        expect.objectContaining({ prefix: SOURCE, suffix: "", language: "python" }),
      ),
    );
    // Ghost text appears.
    await waitFor(() => expect(screen.getByText("return 42")).toBeTruthy());

    // Tab accepts → inserted into the buffer.
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Tab" });
    });
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE + "return 42"),
    );
  });

  it("→ (Right) accepts only the next word, keeping the rest ghosted; Tab finishes it", async () => {
    autocompleteOn = true;
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));
    textarea.selectionStart = textarea.selectionEnd = SOURCE.length;

    await act(async () => {
      fireEvent.keyDown(textarea, { key: " ", ctrlKey: true });
    });
    // Suggestion is the two-word "return 42".
    await waitFor(() => expect(screen.getByText("return 42")).toBeTruthy());

    // Right inserts just "return", leaving " 42" ghosted.
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "ArrowRight" });
    });
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE + "return"),
    );
    await waitFor(() => expect(screen.getByText("42")).toBeTruthy());

    // Plain Tab now accepts the remaining " 42".
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Tab" });
    });
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE + "return 42"),
    );
  });

  it("keeps the ghost when Enter inserts its matching newline and indentation", async () => {
    autocompleteOn = true;
    const original = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args: unknown) => cmd === "complete_text"
      ? Promise.resolve("\n    return 42") : original(cmd, args));
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    await waitFor(() => expect(screen.getByText("return 42")).toBeTruthy());
    await act(async () => { fireEvent.keyDown(el, { key: "Enter" }); });
    expect(el.value).toBe(SOURCE + "\n    ");
    expect(screen.getByText("return 42")).toBeTruthy();
  });

  it("Shift+Tab toggles to Block mode and re-requests in it", async () => {
    autocompleteOn = true;
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));
    textarea.selectionStart = textarea.selectionEnd = SOURCE.length;

    // First request defaults to "sentence" mode; its suggestion must be showing
    // for Shift+Tab to toggle (vs. its normal outdent role).
    await act(async () => {
      fireEvent.keyDown(textarea, { key: " ", ctrlKey: true });
    });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("complete_text", expect.objectContaining({ mode: "sentence" })),
    );
    await waitFor(() => expect(screen.getByText("return 42")).toBeTruthy());

    // Shift+Tab advances sentence → block and re-requests.
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });
    });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("complete_text", expect.objectContaining({ mode: "block" })),
    );
  });

  it("attaches a project file as context and forwards it to complete_text (#45)", async () => {
    autocompleteOn = true;
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));
    textarea.selectionStart = textarea.selectionEnd = SOURCE.length;

    // Open the context-file picker and pick the project's helper file.
    await act(async () => {
      fireEvent.click(screen.getByTitle("Add a project file as autocomplete context"));
    });
    const row = await screen.findByText("helper.py");
    await act(async () => {
      fireEvent.mouseDown(row);
    });
    // The chip for the attached file shows in the context bar.
    await waitFor(() => expect(screen.getByTitle("helper.py")).toBeTruthy());

    // Requesting a completion now carries the attached file as context.
    await act(async () => {
      fireEvent.keyDown(textarea, { key: " ", ctrlKey: true });
    });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "complete_text",
        expect.objectContaining({
          context: [{ name: "helper.py", content: SOURCE }],
        }),
      ),
    );
  });

  it("selects a Windows project with mixed separators and casing", async () => {
    autocompleteOn = true;
    await renderTextView("c:/work/demo/src/foo.py");
    await act(async () => {
      fireEvent.click(screen.getByTitle("Add a project file as autocomplete context"));
    });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("list_project_paths", {
        projectDir: "C:\\Work\\Demo",
      }),
    );
  });

  it("auto-suggests after an idle pause once typing (no Ctrl+Space needed)", async () => {
    autocompleteOn = true;
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));

    // Focus + type a char: the focused editor auto-requests after the debounce.
    textarea.focus();
    const typed = SOURCE + "r";
    await act(async () => {
      fireEvent.change(textarea, { target: { value: typed } });
    });
    textarea.selectionStart = textarea.selectionEnd = typed.length;

    await waitFor(
      () => expect(mockInvoke).toHaveBeenCalledWith("complete_text", expect.anything()),
      { timeout: 2000 },
    );
    await waitFor(() => expect(screen.getByText("return 42")).toBeTruthy());
  });
});

describe("autocomplete window and type-through", () => {
  it("caps a large document on line boundaries and keeps the caret-adjacent text", () => {
    const before = "old line\n".repeat(5000) + "current ";
    const after = "line\n" + "later line\n".repeat(5000);
    const window = completionWindow(before + after, before.length);
    expect(window.prefix.length).toBeLessThanOrEqual(4096);
    expect(window.suffix.length).toBeLessThanOrEqual(1024);
    expect(window.prefix).toMatch(/^old line\n/);
    expect(window.prefix.endsWith("current ")).toBe(true);
    expect(window.suffix.startsWith("line\n")).toBe(true);
    expect(window.suffix.endsWith("\n")).toBe(true);
  });

  it("bounds single lines without splitting Unicode characters", () => {
    const text = "😀".repeat(6000);
    const window = completionWindow(text, 6000);
    expect(window.prefix.length).toBeLessThanOrEqual(4096);
    expect(window.suffix.length).toBeLessThanOrEqual(1024);
    expect(window.prefix + window.suffix).toBe("😀".repeat(2560));
    const odd = completionWindow("x" + text + "z", 6002);
    expect(odd.prefix).not.toMatch(/^[\uDC00-\uDFFF]/);
    expect(odd.suffix).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("retains matching multicharacter insertions but rejects replacement, deletion and suffix edits", () => {
    const ghost = { at: 2, text: "hello world" };
    expect(typeThrough("ab!", "abhello !", ghost)).toEqual({ at: 8, text: "world" });
    expect(typeThrough("ab!", "abhello world!", ghost)).toBeNull();
    expect(typeThrough("ab!", "ax!", ghost)).toBeNull();
    expect(typeThrough("ab!", "a!", ghost)).toBeNull();
    expect(typeThrough("ab!", "abhello?", ghost)).toBeNull();
    expect(typeThrough("ab!", "abhola!", ghost)).toBeNull();
  });
});

describe("code/prose autocomplete model split", () => {
  const loaded = [{ name: "any" }, { name: "coder" }, { name: "writer" }];

  it("prose languages prefer the prose role and fall back to the code role", () => {
    expect(completionModelOrder("markdown", "coder", "writer")).toEqual(["writer", "coder"]);
    expect(completionModelOrder("tex", "coder", undefined)).toEqual(["coder"]);
    expect(completionModelOrder("plain", undefined, "writer")).toEqual(["writer"]);
    expect(completionModelOrder("rust", "coder", "writer")).toEqual(["coder"]);
  });

  it("picks the first preferred model that is resident, else any resident one", () => {
    expect(pickCompletionModel(loaded, ["writer", "coder"])?.name).toBe("writer");
    expect(pickCompletionModel(loaded, ["unloaded", "coder"])?.name).toBe("coder");
    expect(pickCompletionModel(loaded, ["unloaded"])?.name).toBe("any");
    expect(pickCompletionModel([], ["coder"])).toBeUndefined();
  });
});
