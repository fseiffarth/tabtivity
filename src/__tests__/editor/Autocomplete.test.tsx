/**
 * Tests for opt-in local autocomplete (#45, DECISION A):
 *  - Ctrl+Space requests a completion ONLY when the per-type setting is on, after
 *    ensure_ollama_running; the suggestion renders as ghost text and Tab accepts.
 *  - When the setting is OFF, Ctrl+Space never calls out (privacy gate).
 *  - Partial accept: Ctrl+Right inserts only the next word and keeps the rest
 *    ghosted; a later plain Tab finishes it.
 *  - Completion-length modes: requests carry the active `mode`, and Shift+Tab
 *    toggles it (sentence → block → scope) then re-requests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { warmFileViewer } from "../helpers/warmViewer";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import { acDelayMs } from "../../components/embed/fileViewer/editorPrefs";
import { SHOWN_MS } from "../../lib/viewers/completion/completionTimings";

/** The ring the rendered editor writes: `renderTextView` resets modules. */
const timingsRing = async () => (await import("../../lib/viewers/completion/completionTimings")).completionTimings();
import { autocompleteModelAdvice, inlineGhostTail, missingRoleModel } from "../../lib/viewers/completion/autocomplete";
import { caretAtLineEnd, completionModelOrder, completionWindow, editKind, pickCompletionModel, typeThrough } from "../../lib/viewers/completion/autocomplete";

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
let delays: { ollama?: number; copilot?: number } | undefined;
let roles: Record<string, string> | undefined;
const { mockUpdateSettings } = vi.hoisted(() => ({ mockUpdateSettings: vi.fn() }));
vi.mock("../../stores/settings", () => {
  const state = () => ({
    updateSettings: mockUpdateSettings,
    settings: {
      autocomplete_delay_ms: delays,
      ollama_roles: roles,
      autosave: false,
      copilot_completion: copilotOn,
      code_completion_provider: copilotOn ? "copilot" : "ollama",
      completion_project_policies: { proj: { directory: "/p", copilot: copilotOn, local_only: false } },
      viewer_prefs: { text: { autocomplete: autocompleteOn } },
    },
  });
  // `getState`: the providers ask the AI switch (`lib/aiSwitch.ts`) first.
  return {
    useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(state()), { getState: state }),
  };
});

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

/** Resolve after the next animation frame (the ghost's render cadence). */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Move `performance.now()` forward without waiting (the offer clock). */
function skewClock() {
  const real = performance.now.bind(performance);
  let skew = 0;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => real() + skew);
  return { advance: (ms: number) => { skew += ms; }, restore: () => spy.mockRestore() };
}

/** What became of the offers, without the request counts. */
function outcomeBumps(): string[] {
  return mockBump.mock.calls.map(([, key]) => key as string).filter((key) => !key.startsWith("autocomplete.request."));
}

/** The edited file and one import exist; every other path is missing. */
function readOnly(path: string | undefined, source: string) {
  if (path === "/p/helper.py") return Promise.resolve("answer = 42");
  if (path === "/p/foo.py") return Promise.resolve(source);
  return Promise.reject(new Error("missing"));
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

  it("Copilot with one candidate hides the Alt+[/] hint", async () => {
    autocompleteOn = true;
    copilotOn = true;
    const original = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === "copilot_prepare") return Promise.resolve("reservation");
      if (cmd === "copilot_complete") return Promise.resolve([{ id: "session:1:0", insertText: "return only" }]);
      return original(cmd, args);
    });
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    expect(screen.getByText("return only")).toBeTruthy();
    expect(screen.getByText(/Tab: accept/).textContent).not.toMatch(/candidate/);
  });

  it("an empty Copilot answer asks the account once and shows an Inactive status", async () => {
    autocompleteOn = true;
    copilotOn = true;
    const original = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === "copilot_prepare") return Promise.resolve("reservation");
      if (cmd === "copilot_complete") return Promise.resolve([]);
      if (cmd === "copilot_account") return Promise.resolve({
        running: true, status: { kind: "Inactive", message: "Copilot is disabled for this account." },
        account: { status: "OK", user: "octo" },
      });
      return original(cmd, args);
    });
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    await waitFor(() => expect(screen.getByText("Copilot: Copilot is disabled for this account.")).toBeTruthy());
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "copilot_account")).toHaveLength(1);
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
    // Shown long enough, then dismissed with nothing taken: rejected.
    const clock = skewClock();
    try {
      clock.advance(SHOWN_MS);
      await act(async () => { fireEvent.keyDown(el, { key: "Escape" }); });
    } finally { clock.restore(); }
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    expect(screen.getByText("choice0")).toBeTruthy();
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "complete_text")).toHaveLength(3);
    expect(mockBump).toHaveBeenCalledWith("proj", "autocomplete.rejected.sentence.ollama/llama3.2:3b");
    expect(mockBump).toHaveBeenCalledWith("proj", "autocomplete.shown.sentence.ollama/llama3.2:3b");
    expect(mockBump).toHaveBeenCalledWith("proj", "autocomplete.request.ok.ollama/llama3.2:3b");
    expect(mockBump).toHaveBeenCalledWith("proj", "autocomplete.request.cache.ollama/llama3.2:3b");
    expect(mockBump.mock.calls.some(([, key]) => key.startsWith("autocomplete.dismiss."))).toBe(false);
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
    // One offer: shown once, each way of taking it once, never rejected.
    expect(outcomeBumps()).toEqual([
      "autocomplete.shown.sentence.ollama/llama3.2:3b",
      "autocomplete.line.sentence.ollama/llama3.2:3b",
      "autocomplete.tab.sentence.ollama/llama3.2:3b",
    ]);
  });

  it("a typed first character is no accept; three typed characters are", async () => {
    autocompleteOn = true;
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    await act(async () => { fireEvent.change(el, { target: { value: SOURCE + "r" } }); });
    expect(outcomeBumps()).toEqual([]);
    await act(async () => { fireEvent.change(el, { target: { value: SOURCE + "re" } }); });
    await act(async () => { fireEvent.change(el, { target: { value: SOURCE + "ret" } }); });
    expect(outcomeBumps()).toEqual([
      "autocomplete.shown.sentence.ollama/llama3.2:3b",
      "autocomplete.typed.sentence.ollama/llama3.2:3b",
    ]);
  });

  it("counts requests by outcome, with none when no model was chosen", async () => {
    autocompleteOn = true;
    const original = mockInvoke.getMockImplementation()!;
    let models: unknown[] = [];
    mockInvoke.mockImplementation((cmd: string, args: unknown) => cmd === "list_ollama_models_detailed"
      ? Promise.resolve(models) : cmd === "complete_text" ? Promise.resolve("") : original(cmd, args));
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    expect(mockBump).toHaveBeenCalledWith("proj", "autocomplete.request.error.ollama/none");
    expect((await timingsRing()).slice(-1)[0]).toEqual(expect.objectContaining({ outcome: "error", provider: "ollama", trigger: "manual" }));
    models = [{ name: "coder", running: true }];
    // The model lookup is cached for 5 s; a new endpoint key would bypass it,
    // so wait it out through the clock instead.
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
    try {
      await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    } finally { now.mockRestore(); }
    expect(mockBump).toHaveBeenCalledWith("proj", "autocomplete.request.empty.ollama/coder");
  });

  it("records each request's milestones and its stats in the timings ring", async () => {
    autocompleteOn = true;
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    mockListen.mockImplementation((name: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(name, handler);
      return Promise.resolve(() => {});
    });
    const stats = {
      endpoint: "generate", model: "llama3.2:3b", stop: "done", firstTokenMs: 40, totalMs: 90,
      referenceBytes: 0, referencesDropped: false, promptEvalCount: 120,
    };
    const original = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === "complete_text") {
        listeners.get("text-completion-test-request")?.({ payload: "ret" });
        listeners.get("text-completion-stats-test-request")?.({ payload: stats });
        return Promise.resolve("return 42");
      }
      return original(cmd, args);
    });
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    const timing = (await timingsRing()).slice(-1)[0];
    expect(timing).toEqual(expect.objectContaining({ model: "llama3.2:3b", outcome: "ok", stats }));
    expect(timing.request).toBeLessThanOrEqual(timing.contextReady!);
    expect(timing.contextReady).toBeLessThanOrEqual(timing.firstEvent!);
    expect(timing.firstEvent).toBeLessThanOrEqual(timing.done!);
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

  it("freezes references: a second automatic request reads no file", async () => {
    autocompleteOn = true;
    const source = "from helper import answer\nanswer = ";
    const original = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args: { path?: string }) => cmd === "read_file_text"
      ? readOnly(args.path, source) : original(cmd, args));
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(source));
    el.focus();
    const helperReads = () => mockInvoke.mock.calls.filter(([cmd, args]) =>
      cmd === "read_file_text" && (args as { path: string }).path !== "/p/foo.py").length;
    for (const typed of [source + "x", source + "xy"]) {
      await act(async () => { fireEvent.change(el, { target: { value: typed } }); });
      el.selectionStart = el.selectionEnd = typed.length;
      await act(async () => { await new Promise((r) => setTimeout(r, 900)); });
    }
    const requests = mockInvoke.mock.calls.filter(([cmd]) => cmd === "complete_text");
    expect(requests).toHaveLength(2);
    for (const [, args] of requests) {
      expect(args).toEqual(expect.objectContaining({
        context: [{ name: "helper.py", content: "answer = 42" }], fileName: "foo.py",
      }));
    }
    // Reads happen once: the second request reused the frozen set.
    const once = helperReads();
    expect(once).toBeGreaterThan(0);
    await act(async () => { fireEvent.change(el, { target: { value: source + "xyz" } }); });
    el.selectionStart = el.selectionEnd = source.length + 3;
    await act(async () => { await new Promise((r) => setTimeout(r, 900)); });
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "complete_text")).toHaveLength(3);
    expect(helperReads()).toBe(once);
  });

  it("starts the model lookup, reference reads and reservation together", async () => {
    autocompleteOn = true;
    const source = "from helper import answer\nanswer = ";
    const original = mockInvoke.getMockImplementation()!;
    let release!: (text: string) => void;
    mockInvoke.mockImplementation((cmd: string, args: { path?: string }) => cmd === "read_file_text"
      ? args.path === "/p/helper.py" ? new Promise<string>((r) => { release = r; }) : Promise.resolve(source)
      : original(cmd, args));
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(source));
    el.selectionStart = el.selectionEnd = source.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    expect(mockInvoke).toHaveBeenCalledWith("prepare_text_completion");
    expect(mockInvoke).toHaveBeenCalledWith("list_ollama_models_detailed");
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "complete_text")).toBe(false);
    await act(async () => { release("answer = 42"); });
    await waitFor(() => expect(screen.getByText("return 42")).toBeTruthy());
  });

  it("sends a model no references once its stats said it drops them", async () => {
    autocompleteOn = true;
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    mockListen.mockImplementation((name: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(name, handler);
      return Promise.resolve(() => {});
    });
    const source = "from helper import answer\nanswer = ";
    const original = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args: { path?: string; candidate?: number }) => {
      if (cmd === "read_file_text") return readOnly(args.path, source);
      if (cmd === "complete_text") {
        listeners.get("text-completion-stats-test-request")?.({ payload: {
          endpoint: "generate", model: "llama3.2:3b", stop: "done", firstTokenMs: 5, totalMs: 9,
          referenceBytes: 0, referencesDropped: true,
        } });
        return Promise.resolve(`choice${args.candidate}`);
      }
      return original(cmd, args);
    });
    await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(source));
    el.selectionStart = el.selectionEnd = source.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    await act(async () => { fireEvent.keyDown(el, { key: "]", altKey: true }); });
    const requests = mockInvoke.mock.calls.filter(([cmd]) => cmd === "complete_text");
    expect(requests).toHaveLength(2);
    expect(requests[0][1]).toEqual(expect.objectContaining({ context: [{ name: "helper.py", content: "answer = 42" }] }));
    expect((requests[1][1] as { context?: unknown }).context).toBeUndefined();
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
    // Streamed text renders once per frame.
    await act(async () => { publish({ payload: "return 42" }); await nextFrame(); });
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

  it("renders a burst of streamed tokens once, on the next frame; the final text lands at once", async () => {
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
    await act(async () => {
      for (const payload of ["r", "ret", "return"]) publish({ payload });
    });
    expect(screen.queryByText("return")).toBeNull();
    await act(async () => { await nextFrame(); });
    expect(screen.getByText("return")).toBeTruthy();
    await act(async () => { publish({ payload: "return 4" }); finish("return 42"); });
    // The final answer cancelled the pending frame and rendered without one.
    expect(screen.getByText("return 42")).toBeTruthy();
    await act(async () => { await nextFrame(); });
    expect(screen.getByText("return 42")).toBeTruthy();
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

  it("Ctrl+Right accepts only the next word, keeping the rest ghosted; Tab finishes it", async () => {
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

    // The hint names the chord.
    expect(screen.getByText(/Ctrl\+→: word/)).toBeTruthy();
    // Ctrl+Right inserts just "return", leaving " 42" ghosted.
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "ArrowRight", ctrlKey: true });
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

  it("plain Right dismisses the ghost and inserts nothing", async () => {
    autocompleteOn = true;
    await renderTextView();
    const el = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    expect(screen.getByText("return 42")).toBeTruthy();
    let prevented = false;
    await act(async () => { prevented = !fireEvent.keyDown(el, { key: "ArrowRight" }); });
    expect(prevented).toBe(false);
    expect(el.value).toBe(SOURCE);
    expect(screen.queryByText("return 42")).toBeNull();
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

describe("autocomplete trigger (spending)", () => {
  beforeEach(() => {
    copilotOn = false;
    vi.clearAllMocks();
    setup();
  });
  const idle = () => act(async () => { await new Promise((r) => setTimeout(r, 1500)); });

  it("Copilot asks only on request: a typing pause sends nothing", async () => {
    autocompleteOn = true;
    copilotOn = true;
    await renderTextView();
    const el = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    expect(screen.getByText("On request")).toBeTruthy();
    el.focus();
    const typed = SOURCE + "ret";
    await act(async () => { fireEvent.change(el, { target: { value: typed } }); });
    el.selectionStart = el.selectionEnd = typed.length;
    await idle();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "copilot_complete")).toBe(false);
  });

  it("a local model asks automatically, but never with text after the caret", async () => {
    autocompleteOn = true;
    await renderTextView();
    const el = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    expect(screen.getByText("Auto")).toBeTruthy();
    el.focus();
    const typed = "defx foo():\n    ";
    await act(async () => { fireEvent.change(el, { target: { value: typed } }); });
    el.selectionStart = el.selectionEnd = 4;
    await idle();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "complete_text")).toBe(false);
  });

  it("an automatic request says so; Ctrl+Space says manual", async () => {
    autocompleteOn = true;
    await renderTextView();
    const el = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.focus();
    const typed = SOURCE + "r";
    await act(async () => { fireEvent.change(el, { target: { value: typed } }); });
    el.selectionStart = el.selectionEnd = typed.length;
    await idle();
    expect(mockInvoke).toHaveBeenCalledWith("complete_text", expect.objectContaining({ trigger: "auto" }));
    await act(async () => { fireEvent.keyDown(el, { key: "Escape" }); });
    await act(async () => { fireEvent.change(el, { target: { value: typed + "x" } }); });
    el.selectionStart = el.selectionEnd = typed.length + 1;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    const requests = mockInvoke.mock.calls.filter(([cmd]) => cmd === "complete_text");
    expect(requests).toHaveLength(2);
    expect(requests[1][1]).toEqual(expect.objectContaining({ trigger: "manual" }));
  });

  it("no automatic request after a deletion; typing asks again", async () => {
    autocompleteOn = true;
    await renderTextView();
    const el = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.focus();
    const cut = SOURCE.slice(0, -1);
    await act(async () => { fireEvent.change(el, { target: { value: cut } }); });
    el.selectionStart = el.selectionEnd = cut.length;
    await idle();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "complete_text")).toBe(false);
    await act(async () => { fireEvent.change(el, { target: { value: cut + "r" } }); });
    el.selectionStart = el.selectionEnd = cut.length + 1;
    await idle();
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "complete_text")).toHaveLength(1);
  });

  it("no automatic request straight after Tab accepted a suggestion", async () => {
    autocompleteOn = true;
    await renderTextView();
    const el = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.focus();
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    await act(async () => { fireEvent.keyDown(el, { key: "Tab" }); });
    expect(el.value).toBe(SOURCE + "return 42");
    el.selectionStart = el.selectionEnd = el.value.length;
    await idle();
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "complete_text")).toHaveLength(1);
  });

  it("the automatic timer waits the stored delay", async () => {
    autocompleteOn = true;
    delays = { ollama: 100 };
    try {
      await renderTextView();
      const el = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
      await waitFor(() => expect(el.value).toBe(SOURCE));
      el.focus();
      await act(async () => { fireEvent.change(el, { target: { value: SOURCE + "r" } }); });
      el.selectionStart = el.selectionEnd = SOURCE.length + 1;
      await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
      expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "complete_text")).toBe(true);
    } finally { delays = undefined; }
  });

  it("a stored delay that is not a choice uses the default", async () => {
    autocompleteOn = true;
    delays = { ollama: 250 };
    try {
      await renderTextView();
      const el = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
      await waitFor(() => expect(el.value).toBe(SOURCE));
      el.focus();
      await act(async () => { fireEvent.change(el, { target: { value: SOURCE + "r" } }); });
      el.selectionStart = el.selectionEnd = SOURCE.length + 1;
      await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
      expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "complete_text")).toBe(false);
      await idle();
      expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "complete_text")).toBe(true);
    } finally { delays = undefined; }
    expect(acDelayMs({ ollama: 250, copilot: 400 }, false)).toBe(600);
    expect(acDelayMs({ copilot: 400 }, true)).toBe(400);
    expect(acDelayMs(undefined, true)).toBe(200);
  });

  it("the Delay choice shows beside Auto and writes the provider's delay", async () => {
    autocompleteOn = true;
    delays = { copilot: 400 };
    try {
      await renderTextView();
      await act(async () => { fireEvent.click(screen.getByText("600 ms")); });
      await act(async () => { fireEvent.click(screen.getByRole("option", { name: "100 ms" })); });
      expect(mockUpdateSettings).toHaveBeenCalledWith({ autocomplete_delay_ms: { copilot: 400, ollama: 100 } });
    } finally { delays = undefined; }
  });

  it("no Delay choice while the trigger is on request", async () => {
    autocompleteOn = true;
    copilotOn = true;
    await renderTextView();
    expect(screen.getByText("On request")).toBeTruthy();
    expect(screen.queryByText("200 ms")).toBeNull();
  });

  it("no automatic request after undo", async () => {
    autocompleteOn = true;
    await renderTextView();
    const el = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.focus();
    await act(async () => { fireEvent.change(el, { target: { value: SOURCE + "ret" } }); });
    await act(async () => { fireEvent.keyDown(el, { key: "z", ctrlKey: true }); });
    expect(el.value).toBe(SOURCE);
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await idle();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "complete_text")).toBe(false);
  });

  it("the tab's autocomplete config keeps its identity across re-renders", async () => {
    const { renderHook } = await import("@testing-library/react");
    const { useTabAiPrefs } = await import("../../components/embed/fileViewer/editorPrefs");
    const { result, rerender } = renderHook(() => useTabAiPrefs(undefined, "text"));
    const first = result.current.ac;
    rerender();
    expect(result.current.ac).toBe(first);
  });

  it("waits for an IME composition to end before asking", async () => {
    autocompleteOn = true;
    await renderTextView();
    const el = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.focus();
    const typed = SOURCE + "re";
    await act(async () => {
      fireEvent.compositionStart(el);
      fireEvent.change(el, { target: { value: typed } });
    });
    el.selectionStart = el.selectionEnd = typed.length;
    await idle();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "complete_text")).toBe(false);
    await act(async () => { fireEvent.compositionEnd(el); });
    await idle();
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "complete_text")).toHaveLength(1);
  });

  it("the edit kind tells typing from deletion", () => {
    expect(editKind("abc", "abxc")).toBe("insert");
    expect(editKind("abc", "ac")).toBe("delete");
    // Typing over a longer selection still put text in.
    expect(editKind("a long word", "a w")).toBe("insert");
    expect(editKind("aaa", "aa")).toBe("delete");
  });

  it("caret at line end tolerates closers and whitespace only", () => {
    expect(caretAtLineEnd("foo(bar", 7)).toBe(true);
    expect(caretAtLineEnd("foo(ba)  \nnext", 6)).toBe(true);
    expect(caretAtLineEnd("$x^2$ and", 4)).toBe(false);
    expect(caretAtLineEnd("\\cite{a} more", 8)).toBe(false);
  });
});

describe("autocomplete window and type-through", () => {
  it("caps a large document on line boundaries and keeps the caret-adjacent text", () => {
    const before = "old line\n".repeat(5000) + "current ";
    const after = "line\n" + "later line\n".repeat(5000);
    const window = completionWindow(before + after, before.length);
    expect(window.prefix.length).toBeLessThanOrEqual(4096);
    expect(window.prefix.length).toBeGreaterThan(3000);
    expect(window.suffix.length).toBeLessThanOrEqual(2048);
    expect(window.suffix.length).toBeGreaterThan(1024);
    expect(window.prefix).toMatch(/^old line\n/);
    expect(window.prefix.endsWith("current ")).toBe(true);
    expect(window.suffix.startsWith("line\n")).toBe(true);
    expect(window.suffix.endsWith("\n")).toBe(true);
  });

  it("two nearby carets in a long file share the window start", () => {
    const text = "const value = compute(1);\n".repeat(2000);
    const caret = 4096 + 1024 * 5 + 100;
    const a = completionWindow(text, caret);
    const b = completionWindow(text, caret + 40);
    expect(caret - a.prefix.length).toBe(caret + 40 - b.prefix.length);
    expect(a.prefix.startsWith("const value")).toBe(true);
    // A start at the next step moves the window by about one step, not a line.
    const c = completionWindow(text, caret + 1024);
    expect(caret + 1024 - c.prefix.length - (caret - a.prefix.length)).toBeGreaterThan(1000);
  });

  it("bounds single lines without splitting Unicode characters", () => {
    const text = "😀".repeat(6000);
    const window = completionWindow(text, 6000);
    expect(window.prefix.length).toBeLessThanOrEqual(4096);
    expect(window.suffix.length).toBeLessThanOrEqual(2048);
    // Start at the step boundary 2048, end at caret + 2048.
    expect(window.prefix + window.suffix).toBe("😀".repeat(3000));
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

describe("ghost rendering (A6)", () => {
  beforeEach(() => {
    copilotOn = false;
    vi.clearAllMocks();
    setup();
  });

  const ghost = (container: HTMLElement) => container.querySelector(".file-viewer-ghost") as HTMLElement;

  /** The editor alone, unwrapped: every viewer host passes `wrap` today. */
  async function renderBareEditor(text: string) {
    vi.resetModules();
    const { useState } = await import("react");
    const { CodeEditor } = await import("../../components/embed/fileViewer/CodeEditor");
    function Harness() {
      const [draft, setDraft] = useState(text);
      return (
        <CodeEditor
          error={null} draft={draft} setDraft={setDraft} loaded save={() => {}} path="/p/foo.py"
          autocomplete={{ enabled: true, mode: "sentence" }}
          incFont={() => {}} decFont={() => {}} resetFont={() => {}}
        />
      );
    }
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<Harness />); });
    return view;
  }

  it("a one-line ghost at a line end paints inline over the highlight, carrying the closers", async () => {
    autocompleteOn = true;
    const original = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args: unknown) => cmd === "complete_text" ? Promise.resolve("42") : original(cmd, args));
    const view = await renderBareEditor("print()\n");
    const el = view.container.querySelector("textarea")!;
    el.focus();
    el.selectionStart = el.selectionEnd = 6;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    const layer = ghost(view.container);
    expect(view.container.querySelector(".file-viewer-highlight")).not.toBeNull();
    expect(layer.classList.contains("is-inline")).toBe(true);
    const cover = layer.querySelector(".file-viewer-ghost-cover")!;
    expect(cover.textContent).toBe("42)");
    expect(cover.querySelector(".file-viewer-ghost-text")!.textContent).toBe("42");
    // The full document stays in the layer, so it scrolls like the others.
    expect(layer.textContent).toBe("print(42)\n");
  });

  it("the soft-wrapped viewer keeps the opaque projection, even for a one-line ghost", async () => {
    autocompleteOn = true;
    const view = await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    expect(view.container.querySelector(".file-viewer-code-area.is-wrapped")).not.toBeNull();
    const layer = ghost(view.container);
    expect(layer.classList.contains("is-inline")).toBe(false);
    expect(layer.textContent).toBe(SOURCE + "return 42");
  });

  it("a multi-line ghost keeps the opaque projection", async () => {
    autocompleteOn = true;
    const original = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args: unknown) => cmd === "complete_text"
      ? Promise.resolve("first\nsecond") : original(cmd, args));
    const view = await renderTextView();
    const el = await screen.findByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    el.selectionStart = el.selectionEnd = SOURCE.length;
    await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
    const layer = ghost(view.container);
    expect(layer.classList.contains("is-inline")).toBe(false);
    expect(layer.querySelector(".file-viewer-ghost-cover")).toBeNull();
  });

  it("inline only with a highlight layer, no wrap, no line break and closers after the caret", () => {
    const on = { highlighted: true, wrapped: false };
    expect(inlineGhostTail("foo(bar\nnext", 7, "baz", on)).toBe(0);
    expect(inlineGhostTail("foo()  \nnext", 4, "x", on)).toBe(3);
    expect(inlineGhostTail("foo()\r\nnext", 4, "x", on)).toBe(1);
    expect(inlineGhostTail("x = f(y)", 6, "z", on)).toBeNull();
    expect(inlineGhostTail("foo(", 4, "a\nb", on)).toBeNull();
    expect(inlineGhostTail("foo(", 4, "a\r", on)).toBeNull();
    expect(inlineGhostTail("foo(", 4, "a", { highlighted: false, wrapped: false })).toBeNull();
    expect(inlineGhostTail("foo(", 4, "a", { highlighted: true, wrapped: true })).toBeNull();
  });
});

describe("autocomplete role model (A5)", () => {
  beforeEach(() => {
    copilotOn = false;
    vi.clearAllMocks();
    setup();
  });

  it("an automatic request with the role model unloaded asks nothing and offers Load", async () => {
    autocompleteOn = true;
    roles = { autocomplete: "qwen2.5-coder:1.5b" };
    try {
      const original = mockInvoke.getMockImplementation()!;
      let loaded = false;
      mockInvoke.mockImplementation((cmd: string, args: unknown) => {
        if (cmd === "load_ollama_model") { loaded = true; return Promise.resolve(null); }
        if (cmd === "list_ollama_models_detailed") return Promise.resolve([
          { name: "llama3.2:3b", running: true },
          ...(loaded ? [{ name: "qwen2.5-coder:1.5b", running: true, capabilities: ["completion", "insert"] }] : []),
        ]);
        return original(cmd, args);
      });
      await renderTextView();
      const el = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
      await waitFor(() => expect(el.value).toBe(SOURCE));
      el.focus();
      await act(async () => { fireEvent.change(el, { target: { value: SOURCE + "r" } }); });
      el.selectionStart = el.selectionEnd = SOURCE.length + 1;
      await act(async () => { await new Promise((r) => setTimeout(r, 900)); });
      expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "complete_text")).toBe(false);
      expect(screen.getByText(/qwen2\.5-coder:1\.5b not loaded/)).toBeTruthy();
      expect(mockBump).toHaveBeenCalledWith("proj", "autocomplete.request.error.ollama/none");
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load" })); });
      expect(mockInvoke).toHaveBeenCalledWith("load_ollama_model", { model: "qwen2.5-coder:1.5b", device: "auto" });
      await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("complete_text",
        expect.objectContaining({ model: "qwen2.5-coder:1.5b", insert: true, trigger: "auto" })));
      // The pill now names the model that answered.
      await waitFor(() => expect(screen.getByText(/^qwen2\.5-coder:1\.5b · Tab: accept/)).toBeTruthy());
    } finally { roles = undefined; }
  });

  it("Ctrl+Space still answers from another resident model, and names it", async () => {
    autocompleteOn = true;
    roles = { autocomplete: "qwen2.5-coder:1.5b" };
    try {
      await renderTextView();
      const el = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
      await waitFor(() => expect(el.value).toBe(SOURCE));
      el.selectionStart = el.selectionEnd = SOURCE.length;
      await act(async () => { fireEvent.keyDown(el, { key: " ", ctrlKey: true }); });
      expect(mockInvoke).toHaveBeenCalledWith("complete_text", expect.objectContaining({ model: "llama3.2:3b" }));
      expect(screen.getByText(/^llama3\.2:3b · Tab: accept/)).toBeTruthy();
    } finally { roles = undefined; }
  });

  it("names the role model that is missing for the language, roles only", () => {
    const loaded = [{ name: "any" }, { name: "writer" }];
    expect(missingRoleModel(loaded, "python", "coder")).toBe("coder");
    expect(missingRoleModel(loaded, "python", undefined)).toBeUndefined();
    expect(missingRoleModel(loaded, "markdown", "coder", "writer")).toBeUndefined();
    expect(missingRoleModel(loaded, "markdown", "coder", "poet")).toBe("poet");
    expect(missingRoleModel([{ name: "coder" }], "python", "coder")).toBeUndefined();
  });

  it("advises on the autocomplete role only from reported capabilities", () => {
    const chat = { name: "chat", capabilities: ["completion", "tools"] };
    const fim = { name: "fim", capabilities: ["completion", "insert"] };
    const unknown = { name: "unknown", capabilities: [] };
    expect(autocompleteModelAdvice([chat, fim], "chat")).toEqual({ kind: "noInsert", model: "chat" });
    expect(autocompleteModelAdvice([chat, fim], "fim")).toBeNull();
    expect(autocompleteModelAdvice([unknown], "unknown")).toBeNull();
    expect(autocompleteModelAdvice([chat], undefined)).toEqual({ kind: "noFim" });
    expect(autocompleteModelAdvice([chat, fim], undefined)).toBeNull();
    expect(autocompleteModelAdvice([], undefined)).toBeNull();
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
