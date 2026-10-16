/**
 * "How to start" is a paged, goal-driven intro wizard: Welcome → Your goals →
 * the setup pages the answers pull in (Projects, Agent CLIs, Local models) →
 * For you → Ask Tabtivity → What next. No answer is the full tour. It pages with
 * Back/Next, the step rail and ←/→, remembers the page and the answers, and
 * each page's one-click
 * actions reuse an existing mechanism: the + menu's project dialogs (a window
 * event), the registry's installer run in a terminal tab (`runInstallInTab`),
 * Ollama's own commands, and the help MCP's status/search commands.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const runInstallInTab = vi.fn();
vi.mock("../../lib/installCommand", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/installCommand")>()),
  runInstallInTab: (...a: unknown[]) => runInstallInTab(...a),
}));

import { HowToStart } from "../../components/layout/HowToStart";
import {
  recommendModel,
  installNeedsNpm,
  readIntroPage,
  readIntroGoals,
  writeIntroGoals,
} from "../../components/layout/intro/introData";
import { LESSONS } from "../../lib/lessons";
import { useTourStore } from "../../stores/tour";
import { OPEN_PROJECT_DIALOG_EVENT } from "../../lib/projects/projectDialogEvent";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { resetOllamaStatusPoller } from "../../lib/ollamaStatus";
import type { Settings } from "../../types";
import { BRAND, storageKey } from "../../lib/brand";

const GB = 1024 ** 3;

type Handler = (args?: Record<string, unknown>) => unknown;
function backend(handlers: Record<string, Handler>) {
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked ${cmd}`);
    return h(args);
  });
}

const heading = () => screen.getByRole("heading", { level: 2 }).textContent ?? "";
const next = () => fireEvent.click(screen.getByRole("button", { name: /^Next/ }));
const back = () => fireEvent.click(screen.getByRole("button", { name: /Back/ }));
/** The step rail's entries as shown: number + title. */
const railEntries = () =>
  Array.from(screen.getByRole("navigation").querySelectorAll(".settings-navigation-group button")).map(
    (b) => b.textContent?.trim() ?? "",
  );
const progress = () => document.querySelector(".intro-progress")?.textContent ?? "";
const goalGroup = () => screen.getByRole("group", { name: "What you want to do" });
const goalCard = (title: RegExp) => {
  const card = Array.from(goalGroup().querySelectorAll("button")).find((b) => title.test(b.textContent ?? ""));
  if (!card) throw new Error(`no goal card ${title}`);
  return card;
};
const lesson = (id: string) => LESSONS.find((l) => l.id === id)!;
const realStartLesson = useTourStore.getState().startLesson;

describe("How to start intro wizard", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    invoke.mockReset();
    runInstallInTab.mockReset();
    resetOllamaStatusPoller();
    backend({});
    useProjectsStore.setState({ projects: [], activeId: null, loaded: true, rootDir: `/home/u/${BRAND.slug}/root` });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    useTourStore.setState({ active: false, startLesson: realStartLesson });
  });
  afterEach(() => {
    cleanup();
    resetOllamaStatusPoller();
    useTourStore.setState({ active: false, startLesson: realStartLesson });
  });

  it("pages with Next/Back, the rail and ←/→, and remembers the page", async () => {
    const onClose = vi.fn();
    let unmount = () => {};
    // Welcome waits on the (here rejected) Super-key probe; let it settle.
    await act(async () => {
      ({ unmount } = render(<HowToStart onClose={onClose} />));
    });
    expect(heading()).toContain(`Welcome to ${BRAND.display}`);
    expect((screen.getByRole("button", { name: /Back/ }) as HTMLButtonElement).disabled).toBe(true);

    next();
    expect(heading()).toContain("Your goals");
    // Nothing picked: the full tour follows.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowRight" });
    expect(heading()).toContain("Projects");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowRight" });
    expect(heading()).toContain("Agent CLIs");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowLeft" });
    expect(heading()).toContain("Projects");
    back();
    expect(heading()).toContain("Your goals");
    back();
    expect(heading()).toContain("Welcome");

    // The rail jumps straight to a page.
    const rail = screen.getByRole("navigation");
    fireEvent.click(Array.from(rail.querySelectorAll("button")).find((b) => b.textContent?.includes(`Ask ${BRAND.display}`))!);
    expect(heading()).toContain(`Ask ${BRAND.display}`);
    expect(readIntroPage()).toBe("askApp");

    // Closed mid-way, it reopens on the same page.
    unmount();
    render(<HowToStart onClose={onClose} />);
    expect(heading()).toContain(`Ask ${BRAND.display}`);
  });

  it("types the Welcome greeting only on the first run, and only once", async () => {
    const greeting = `Hi there — I'm ${BRAND.display}.`;
    const typed = () => document.querySelector(".typewriter [aria-hidden='true']")?.textContent ?? "";

    // Re-opened from Settings: complete at once.
    let unmount = () => {};
    await act(async () => {
      ({ unmount } = render(<HowToStart onClose={() => {}} />));
    });
    expect(typed()).toContain(greeting);
    unmount();

    // First run: it starts empty (screen readers still get the whole line) …
    await act(async () => {
      render(<HowToStart onClose={() => {}} firstRun />);
    });
    expect(typed()).not.toContain(greeting);
    expect(document.querySelector(".typewriter-sr")?.textContent).toContain(greeting);
    // … and coming back to Welcome does not type it again.
    next();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(typed()).toContain(greeting);
  });

  it("finishing on the last page resets to Welcome; Skip keeps the page", () => {
    const onClose = vi.fn();
    const { unmount } = render(<HowToStart onClose={onClose} />);
    next();
    fireEvent.click(screen.getByRole("button", { name: "Skip intro" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(readIntroPage()).toBe("goals");
    unmount();

    localStorage.setItem(storageKey("intro.page"), "done");
    render(<HowToStart onClose={onClose} />);
    expect(heading()).toContain("What next");
    expect(screen.queryByRole("button", { name: "Skip intro" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start working" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(readIntroPage()).toBe("welcome");
  });

  it("the What-next links keep their events", () => {
    localStorage.setItem(storageKey("intro.page"), "done");
    const events: string[] = [];
    const record = (e: Event) => events.push(e.type);
    for (const type of ["app:start-tour", "app:open-lessons", "app:open-settings"]) window.addEventListener(type, record);
    render(<HowToStart onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Take a tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Lessons" }));
    fireEvent.click(screen.getByRole("button", { name: /Feature Guide/ }));
    for (const type of ["app:start-tour", "app:open-lessons", "app:open-settings"]) window.removeEventListener(type, record);
    expect(events).toEqual(["app:start-tour", "app:open-lessons", "app:open-settings"]);
  });

  it("Your goals: toggle cards in a group; answers shape the rail, the progress and the preview", async () => {
    await act(async () => {
      render(<HowToStart onClose={() => {}} />);
    });
    next();
    expect(heading()).toContain("Your goals");
    expect(screen.getByText(/What do you want to do with/)).toBeTruthy();

    const cards = Array.from(goalGroup().querySelectorAll("button"));
    expect(cards).toHaveLength(8);
    for (const card of cards) {
      expect(card.getAttribute("type")).toBe("button");
      expect(card.getAttribute("aria-pressed")).toBe("false");
    }
    // Nothing picked: the full tour, and the preview says so.
    expect(progress()).toBe("Step 2 of 8");
    expect(screen.getByText(/Nothing picked yet/)).toBeTruthy();
    expect(screen.queryByText(/^Next up:/)).toBeNull();

    fireEvent.click(goalCard(/Organize my day/));
    expect(goalCard(/Organize my day/).getAttribute("aria-pressed")).toBe("true");
    expect(goalCard(/Code with AI agents/).getAttribute("aria-pressed")).toBe("false");
    expect(railEntries()).toEqual([
      "1Welcome",
      "2Your goals",
      "3For you",
      `4Ask ${BRAND.display}`,
      "5What next",
    ]);
    expect(progress()).toBe("Step 2 of 5");
    expect(screen.queryByText(/Nothing picked yet/)).toBeNull();
    expect(screen.getByText(/^Next up:/).textContent).toBe(`Next up: For you · Ask ${BRAND.display}`);
    expect(screen.getByText(/^Next up:/).closest("[aria-live='polite']")).toBeTruthy();

    // A second goal adds its pages, in canonical order.
    fireEvent.click(goalCard(/Code with AI agents/));
    expect(screen.getByText(/^Next up:/).textContent).toBe(
      `Next up: Projects · Agent CLIs · For you · Ask ${BRAND.display}`,
    );
    expect(progress()).toBe("Step 2 of 7");
    // … and toggling it off takes them away again.
    fireEvent.click(goalCard(/Code with AI agents/));
    expect(goalCard(/Code with AI agents/).getAttribute("aria-pressed")).toBe("false");
    expect(railEntries()).not.toContain("3Projects");
    expect(railEntries().some((e) => /Projects|Agent CLIs|Local models/.test(e))).toBe(false);

    // Next/Back follow the route: For you comes straight after the goals.
    next();
    expect(heading()).toContain("For you");
    expect(progress()).toBe("Step 3 of 5");
    next();
    expect(heading()).toContain(`Ask ${BRAND.display}`);
    back();
    back();
    expect(heading()).toContain("Your goals");
  });

  it("Your goals: answers persist across a close and a re-open", async () => {
    let unmount = () => {};
    await act(async () => {
      ({ unmount } = render(<HowToStart onClose={() => {}} />));
    });
    next();
    fireEvent.click(goalCard(/Organize my day/));
    fireEvent.click(goalCard(/Continue on my phone/));
    expect(readIntroGoals()).toEqual(["organize", "phone"]);
    unmount();

    render(<HowToStart onClose={() => {}} />);
    expect(heading()).toContain("Your goals");
    expect(goalCard(/Organize my day/).getAttribute("aria-pressed")).toBe("true");
    expect(goalCard(/Continue on my phone/).getAttribute("aria-pressed")).toBe("true");
    expect(goalCard(/Just show me around/).getAttribute("aria-pressed")).toBe("false");
    expect(progress()).toBe("Step 2 of 5");

    // Clearing every answer forgets them.
    fireEvent.click(goalCard(/Organize my day/));
    fireEvent.click(goalCard(/Continue on my phone/));
    expect(readIntroGoals()).toEqual([]);
    expect(localStorage.getItem(storageKey("intro.goals"))).toBeNull();
  });

  it("a remembered page outside the route reopens on the goals page", () => {
    writeIntroGoals(["organize"]);
    localStorage.setItem(storageKey("intro.page"), "projects");
    const { unmount } = render(<HowToStart onClose={() => {}} />);
    expect(heading()).toContain("Your goals");
    expect(progress()).toBe("Step 2 of 5");
    unmount();

    localStorage.setItem(storageKey("intro.page"), "localModels");
    render(<HowToStart onClose={() => {}} />);
    expect(heading()).toContain("Your goals");
  });

  it("For you: the chosen goals' lessons, and Walk me through it starts one", () => {
    writeIntroGoals(["organize"]);
    localStorage.setItem(storageKey("intro.page"), "forYou");
    const startLesson = vi.fn();
    useTourStore.setState({ startLesson });
    const onClose = vi.fn();
    render(<HowToStart onClose={onClose} />);
    expect(heading()).toContain("For you");
    expect(screen.getByText(/Short guided walk-throughs/)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: /Organize my day/ })).toBeTruthy();
    for (const title of [`Read mail in ${BRAND.display}`, "Plan with the calendar", "Work a to-do board", "See your usage recap"]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    // Only the chosen goal's lessons.
    expect(screen.queryByText("Choose an AI agent")).toBeNull();
    expect(screen.queryByRole("heading", { level: 3, name: /Code with AI agents/ })).toBeNull();

    const walks = screen.getAllByRole("button", { name: "Walk me through it" });
    expect(walks).toHaveLength(4);
    fireEvent.click(walks[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(startLesson).toHaveBeenCalledTimes(1);
    expect(startLesson).toHaveBeenCalledWith(lesson("mail"));
  });

  it("For you: several goals list their lessons once each, grouped in goal order", () => {
    writeIntroGoals(["localAi", "code"]);
    localStorage.setItem(storageKey("intro.page"), "forYou");
    render(<HowToStart onClose={() => {}} />);
    const groups = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
    expect(groups.findIndex((h) => h.includes("Code with AI agents"))).toBeLessThan(
      groups.findIndex((h) => h.includes("Run AI privately")),
    );
    expect(screen.getAllByText("Choose an AI agent")).toHaveLength(1);
    expect(screen.getByText("Add a local model or agent")).toBeTruthy();
  });

  it("What next: the first step for the answers, and Change my answers goes back", () => {
    writeIntroGoals(["organize"]);
    localStorage.setItem(storageKey("intro.page"), "done");
    const startLesson = vi.fn();
    useTourStore.setState({ startLesson });
    const onClose = vi.fn();
    const { unmount } = render(<HowToStart onClose={onClose} />);
    expect(heading()).toContain("What next");
    expect(screen.getByText("Based on your answers, a good first step:")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Read mail in ${BRAND.display}` }));
    expect(startLesson).toHaveBeenCalledWith(lesson("mail"));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Starting the first step finishes the intro: the next open is Welcome.
    expect(readIntroPage()).toBe("welcome");
    unmount();

    localStorage.setItem(storageKey("intro.page"), "done");
    render(<HowToStart onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Change my answers" }));
    expect(heading()).toContain("Your goals");
    expect(goalCard(/Organize my day/).getAttribute("aria-pressed")).toBe("true");
    // The pressed button is gone; the focus lands on the picked card, not the body.
    expect(document.activeElement).toBe(goalCard(/Organize my day/));
  });

  it("What next with no answers: the quick tour is the first step", () => {
    localStorage.setItem(storageKey("intro.page"), "done");
    const startLesson = vi.fn();
    useTourStore.setState({ startLesson });
    render(<HowToStart onClose={() => {}} />);
    expect(screen.getByText("Based on your answers, a good first step:")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Quick tour" }));
    expect(startLesson).toHaveBeenCalledWith(lesson("tour"));
  });

  it("Projects: live count, and New/Import open the + menu's dialogs", () => {
    localStorage.setItem(storageKey("intro.page"), "projects");
    const kinds: unknown[] = [];
    const onOpen = (e: Event) => kinds.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_PROJECT_DIALOG_EVENT, onOpen);
    render(<HowToStart onClose={() => {}} />);
    expect(screen.getByText("No project yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New project…" }));
    fireEvent.click(screen.getByRole("button", { name: "Import a folder…" }));
    window.removeEventListener(OPEN_PROJECT_DIALOG_EVENT, onOpen);
    expect(kinds).toEqual(["new", "import"]);

    act(() => {
      useProjectsStore.setState({
        projects: [{ id: "p1", name: "demo", status: "active" } as never],
      });
    });
    expect(screen.getByText("1 project(s) open")).toBeTruthy();
  });

  it("Agent CLIs: installed state per CLI, and Install runs the registry command in a terminal tab", async () => {
    localStorage.setItem(storageKey("intro.page"), "agents");
    backend({
      list_agents: () => [
        { id: "claude", label: "Claude", bin: "claude", install_cmd: "curl claude | bash", shell_kind: "bash", docs: "", installed: true },
        { id: "codex", label: "Codex", bin: "codex", install_cmd: "curl codex | sh", shell_kind: "bash", docs: "", installed: false },
        { id: "gemini", label: "Google Gemini", bin: "gemini", install_cmd: "npm install -g @google/gemini-cli", shell_kind: "bash", docs: "", installed: false },
        { id: "aider", label: "Aider", bin: "aider", install_cmd: "x", shell_kind: "bash", docs: "", installed: false },
      ],
      node_runtime_status: () => ({ npm: false, version: null, min_major: 24, too_old: false }),
    });
    const onClose = vi.fn();
    render(<HowToStart onClose={onClose} />);
    await screen.findByRole("button", { name: "Codex" });
    // Only the featured three, not the whole registry.
    expect(screen.queryByRole("button", { name: "Aider" })).toBeNull();
    expect(screen.getByText("installed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Install Codex in a terminal" }));
    expect(runInstallInTab).toHaveBeenCalledWith("Install Codex", "curl codex | sh", "bash");
    expect(onClose).toHaveBeenCalled();

    // npm-based: the Node.js prerequisite shows up with its own installer.
    fireEvent.click(screen.getByRole("button", { name: "Google Gemini" }));
    expect(await screen.findByRole("button", { name: "Install Node.js in a terminal" })).toBeTruthy();
  });

  it("Local models: Ollama missing → install in a terminal; recommendation sized to the machine", async () => {
    localStorage.setItem(storageKey("intro.page"), "localModels");
    backend({
      ollama_is_installed: () => false,
      ollama_install_strategy: () => ({ os: "linux", command: "curl -fsSL https://ollama.com/install.sh | sh", auto: true, download_url: "" }),
      vibe_is_installed: () => false,
      vibe_install_strategy: () => ({ os: "linux", command: "curl vibe | bash" }),
      machine_load_snapshot: () => ({ mem_total_bytes: 16 * GB }),
      gpu_memory_snapshot: () => [],
      ollama_status: () => "stopped",
    });
    const onClose = vi.fn();
    render(<HowToStart onClose={onClose} />);
    expect(await screen.findByText("Ollama is not installed")).toBeTruthy();
    expect(await screen.findByText(/Recommended: qwen2.5-coder:7b/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Install Ollama in a terminal" }));
    expect(runInstallInTab).toHaveBeenCalledWith("Install Ollama", "curl -fsSL https://ollama.com/install.sh | sh", "bash");
    expect(onClose).toHaveBeenCalled();
  });

  it("Local models: running server → pull the pick, load it on the GPU, use it for tabs", async () => {
    localStorage.setItem(storageKey("intro.page"), "localModels");
    let models = [{ name: "qwen2.5-coder:3b", running: false, size_vram: 0 }];
    backend({
      ollama_is_installed: () => true,
      ollama_install_strategy: () => ({ os: "linux", command: "x", auto: true, download_url: "" }),
      vibe_is_installed: () => true,
      vibe_install_strategy: () => ({ os: "linux", command: "x" }),
      machine_load_snapshot: () => ({ mem_total_bytes: 8 * GB }),
      gpu_memory_snapshot: () => [],
      ollama_status: () => "idle",
      list_ollama_models_detailed: () => models,
      list_local_drivers: () => [],
      ensure_ollama_running: () => undefined,
      load_ollama_model: () => {
        models = [{ name: "qwen2.5-coder:3b", running: true, size_vram: 2 * GB }];
      },
    });
    const updateSettings = vi.fn(async () => {});
    useSettingsStore.setState({ updateSettings });
    render(<HowToStart onClose={() => {}} />);
    // 8 GB of RAM → the 3b model, already downloaded: no pull button.
    expect(await screen.findByText(/Downloaded: qwen2.5-coder:3b/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Download qwen/ })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Load qwen2.5-coder:3b onto the GPU" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("load_ollama_model", { model: "qwen2.5-coder:3b", device: "gpu" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Use qwen2.5-coder:3b for Local Model tabs" }));
    expect(updateSettings).toHaveBeenCalledWith({ ollama_model: "qwen2.5-coder:3b" });
    expect(screen.getByText("Runners available: Mistral (Vibe)")).toBeTruthy();
  });

  it(`Ask ${BRAND.display}: status from root_mcp_status, a plain sentence on an older backend, and search`, async () => {
    localStorage.setItem(storageKey("intro.page"), "askApp");
    backend({ root_mcp_status: () => ({ wired_clis: ["claude"] }) });
    const { unmount } = render(<HowToStart onClose={() => {}} />);
    expect(await screen.findByText(/no help server yet/)).toBeTruthy();
    unmount();

    backend({
      root_mcp_status: () => ({ help: { enabled: true, wiredClis: ["claude", "codex"] } }),
      help_search: () => [{ id: "sync", title: "Sync", sectionTitle: "Byte sync", snippet: "Byte-sync is opt-in per path." }],
    });
    render(<HowToStart onClose={() => {}} />);
    expect(await screen.findByText("Help server is on for claude, codex")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "sync" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Byte-sync is opt-in per path.")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("help_search", { query: "sync", limit: 3 });
    // ← in the search box moves the caret, not the page.
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowLeft" });
    expect(heading()).toContain(`Ask ${BRAND.display}`);
  });
});

describe("intro data", () => {
  it("recommends a model by the help corpus's table", () => {
    expect(recommendModel(0, 0).model).toBe("qwen2.5-coder:1.5b");
    expect(recommendModel(4 * GB, 0).model).toBe("qwen2.5-coder:1.5b");
    expect(recommendModel(7.7 * GB, 0).model).toBe("qwen2.5-coder:3b");
    expect(recommendModel(15.6 * GB, 0).model).toBe("qwen2.5-coder:7b");
    // An APU's 512 MB carve-out does not count as a GPU.
    expect(recommendModel(8 * GB, 0.5 * GB).model).toBe("qwen2.5-coder:3b");
    expect(recommendModel(8 * GB, 8 * GB).model).toBe("qwen2.5-coder:7b");
    expect(recommendModel(64 * GB, 24 * GB).model).toBe("qwen2.5-coder:14b");
  });

  it("spots npm-based installers", () => {
    expect(installNeedsNpm("npm install -g @google/gemini-cli")).toBe(true);
    expect(installNeedsNpm("curl -fsSL https://claude.ai/install.sh | bash")).toBe(false);
  });
});
