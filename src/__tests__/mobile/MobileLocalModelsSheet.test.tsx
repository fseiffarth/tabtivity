/**
 * The phone's Local models sheet and its Home row (plan
 * `docs/mobile_local_model_control_plan.md` §6): the desktop's installed
 * Ollama models with state, placement and keep-alive; Load / Unload / Start
 * Ollama; polling fast while something moves and slow otherwise; and no
 * download, update or delete control anywhere.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeLocalModels, type LocalModelList, type LocalModelRow } from "../../../mobile-web/src/api";
import { FAST_POLL, SLOW_POLL, keepAliveKey, modelSizeLabel, placementKey, pollDelay, sortModels, summary } from "../../../mobile-web/src/localModels";
import { LocalModelsSection, LocalModelsSheet } from "../../../mobile-web/src/screens/LocalModelsSheet";
import { BRAND } from "../../lib/brand";

const GB = 1024 ** 3;

function row(over: Partial<LocalModelRow> & { name: string }): LocalModelRow {
  return { size: 5 * GB, parameter_size: null, quantization: null, state: "idle", for_tabs: false, remote: false, ...over };
}

function listOf(models: LocalModelRow[], over: Partial<LocalModelList> = {}): LocalModelList {
  return { server: "running", can_start: false, start_failed: false, models, ...over };
}

const LOADED = row({ name: "qwen3.5:9b", parameter_size: "9B", quantization: "Q4_K_M", state: "loaded", loaded_size: 7 * GB, vram: 7 * GB, pinned: true, expires_in: null, for_tabs: true });
const IDLE = row({ name: "llama3:latest", parameter_size: "8B", quantization: "Q4_0" });
const CLOUD = row({ name: "gpt-oss:120b-cloud", size: 384, remote: true });

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Every GET answers `get()`; every POST answers `post(body)`. */
function serve(get: () => Response | Promise<Response>, post?: (body: Record<string, unknown>) => Response | Promise<Response>) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      if (!post) throw new Error("unexpected POST");
      return post(JSON.parse(String(init?.body)) as Record<string, unknown>);
    }
    expect(String(input)).toBe("/api/v1/local-models");
    return get();
  });
}

/** Fake time in steps, each answered before the next: a response body is
 * read on the real event loop, so one long jump would skip the reads it
 * should have scheduled. */
async function tick(ms: number, step = 500) {
  for (let spent = 0; spent < ms; spent += step) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(step, ms - spent)); });
  }
}

const gets = () => fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === "GET").length;
const posts = () => fetchMock.mock.calls
  .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown);

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("local models — pure helpers", () => {
  it("sorts loaded, then loading, then the rest by name", () => {
    const sorted = sortModels([row({ name: "b" }), row({ name: "z", state: "loading" }), row({ name: "a", state: "failed" }), row({ name: "y", state: "loaded" })]);
    expect(sorted.map((model) => model.name)).toEqual(["y", "z", "a", "b"]);
  });

  it("places a loaded model on the GPU, partly, or on the CPU — and omits a missing reading", () => {
    expect(placementKey(LOADED)).toEqual({ key: "onGpu" });
    expect(placementKey({ ...LOADED, vram: 3.5 * GB })).toEqual({ key: "partGpu", pct: 50 });
    expect(placementKey({ ...LOADED, vram: 0 })).toEqual({ key: "onCpu" });
    expect(placementKey({ ...LOADED, vram: undefined })).toBeNull();
    expect(placementKey({ ...LOADED, loaded_size: undefined })).toBeNull();
    expect(placementKey({ ...LOADED, loaded_size: 0, vram: 0 })).toBeNull();
    expect(placementKey(IDLE)).toBeNull();
  });

  it("says pinned, or the minutes left rounded up", () => {
    expect(keepAliveKey(LOADED)).toEqual({ key: "pinned" });
    const timed = { ...LOADED, pinned: false };
    expect(keepAliveKey({ ...timed, expires_in: 240 })).toEqual({ key: "expires", minutes: 4 });
    expect(keepAliveKey({ ...timed, expires_in: 241 })).toEqual({ key: "expires", minutes: 5 });
    expect(keepAliveKey({ ...timed, expires_in: 0 })).toEqual({ key: "expires", minutes: 1 });
    expect(keepAliveKey({ ...timed, expires_in: null })).toBeNull();
    expect(keepAliveKey(IDLE)).toBeNull();
  });

  it("polls fast while a load, a start or a request is in flight", () => {
    expect(pollDelay(listOf([IDLE]), false)).toBe(SLOW_POLL);
    expect(pollDelay(listOf([IDLE]), true)).toBe(FAST_POLL);
    expect(pollDelay(listOf([{ ...IDLE, state: "loading" }]), false)).toBe(FAST_POLL);
    expect(pollDelay(listOf([], { server: "starting" }), false)).toBe(FAST_POLL);
    expect(pollDelay(null, false)).toBe(SLOW_POLL);
    expect([FAST_POLL, SLOW_POLL]).toEqual([2_500, 10_000]);
  });

  it("summarises the list for Home", () => {
    expect(summary(listOf([LOADED, IDLE, CLOUD]))).toEqual({ key: "summary", loaded: 1, installed: 3 });
    expect(summary(listOf([], { server: "stopped" }))).toEqual({ key: "serverStopped" });
    expect(summary(listOf([], { server: "unreachable" }))).toEqual({ key: "unreachable" });
  });

  it("spells a model's size in gigabytes", () => {
    expect(modelSizeLabel(6594474711)).toBe("6.1 GB");
    expect(modelSizeLabel(384)).toBe("384 B");
  });

  it("reads a list strictly: residency only when loaded, a non-list as none", () => {
    expect(normalizeLocalModels({ projects: [] })).toBeNull();
    const list = normalizeLocalModels({
      server: "bogus",
      can_start: true,
      start_failed: false,
      models: [
        { name: "a", size: 1, state: "idle", vram: 5, pinned: true },
        { name: "b", size: 1, state: "loaded", loaded_size: 9, vram: 9, pinned: false, expires_in: 60 },
        { size: 1 },
        { name: "c", state: "weird" },
      ],
    });
    expect(list?.server).toBe("unreachable");
    expect(list?.can_start).toBe(false);
    expect(list?.models.map((model) => model.name)).toEqual(["a", "b", "c"]);
    expect(list?.models[0].vram).toBeUndefined();
    expect(list?.models[0].pinned).toBeUndefined();
    expect(list?.models[1]).toMatchObject({ loaded_size: 9, vram: 9, pinned: false, expires_in: 60 });
    expect(list?.models[2].state).toBe("idle");
  });
});

describe("local models — the sheet", () => {
  it("lists every model with its facts, state and button — and nothing that downloads or deletes", async () => {
    serve(() => json(listOf([
      IDLE,
      CLOUD,
      { ...LOADED, name: "part:7b", vram: 3.5 * GB, pinned: false, expires_in: 240, for_tabs: false },
      LOADED,
      row({ name: "busy:3b", state: "loading" }),
      row({ name: "broken:1b", state: "failed" }),
    ])));
    render(<LocalModelsSheet onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Local models" });
    await within(dialog).findByText("qwen3.5:9b");
    const card = (name: string) => within(dialog).getByText(name).closest("li") as HTMLElement;

    expect(card("qwen3.5:9b").textContent).toContain("9B · Q4_K_M · 5.0 GB");
    expect(card("qwen3.5:9b").textContent).toContain("On the GPU · Stays loaded until unloaded");
    expect(card("qwen3.5:9b").textContent).toContain("Used for new local-model tabs");
    expect(within(card("qwen3.5:9b")).getByRole("button", { name: "Unload qwen3.5:9b" }).textContent).toBe("Unload");
    expect(card("part:7b").textContent).toContain("50% on the GPU · Unloads in 4 min");
    expect(card("part:7b").textContent).not.toContain("Used for new");
    expect(within(card("llama3:latest")).getByRole("button", { name: "Load llama3:latest" }).textContent).toBe("Load");
    expect(card("busy:3b").textContent).toContain("Loading into memory…");
    expect((within(card("busy:3b")).getByRole("button", { name: "Load busy:3b" }) as HTMLButtonElement).disabled).toBe(true);
    expect(card("broken:1b").textContent).toContain("The last load failed");
    expect(card("gpt-oss:120b-cloud").textContent).toContain("Runs in the cloud");
    expect(within(card("gpt-oss:120b-cloud")).queryByRole("button")).toBeNull();
    // Loaded first, then loading, then by name.
    const names = within(dialog).getAllByRole("listitem").map((item) => item.querySelector("strong")?.textContent);
    expect(names).toEqual(["part:7b", "qwen3.5:9b", "busy:3b", "broken:1b", "gpt-oss:120b-cloud", "llama3:latest"]);

    expect(dialog.textContent).toContain("Downloading, updating and deleting models is only possible on the desktop.");
    for (const button of within(dialog).getAllByRole("button")) {
      expect(button.textContent ?? "").not.toMatch(/download|delete|pull|remove|update|install/i);
      expect(button.getAttribute("aria-label") ?? "").not.toMatch(/download|delete|pull|remove|update|install/i);
    }
  });

  it("loads on a tap, shows it loading, and takes the list from the answer", async () => {
    let answer!: (response: Response) => void;
    serve(() => json(listOf([IDLE])), () => new Promise<Response>((resolve) => { answer = resolve; }));
    render(<LocalModelsSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load llama3:latest" }));
    expect(posts()).toEqual([{ action: "load", model: "llama3:latest" }]);
    const card = screen.getByText("llama3:latest").closest("li") as HTMLElement;
    expect(card.textContent).toContain("Loading into memory…");
    expect((within(card).getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    const before = gets();
    answer(json(listOf([{ ...IDLE, state: "loading" }]), 202));
    await waitFor(() => expect((within(card).getByRole("button") as HTMLButtonElement).disabled).toBe(true));
    expect(card.textContent).toContain("Loading into memory…");
    expect(gets()).toBe(before);
  });

  it("unloads at once, with no confirmation", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    serve(() => json(listOf([LOADED])), () => json(listOf([{ ...LOADED, state: "idle", loaded_size: undefined, vram: undefined, pinned: undefined }])));
    render(<LocalModelsSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unload qwen3.5:9b" }));
    expect(await screen.findByRole("button", { name: "Load qwen3.5:9b" })).toBeTruthy();
    expect(posts()).toEqual([{ action: "unload", model: "qwen3.5:9b" }]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("says why an unload was refused, under its row", async () => {
    serve(() => json(listOf([LOADED])), () => json({ error: "model_loading" }, 409));
    render(<LocalModelsSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unload qwen3.5:9b" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Wait until it has finished loading.");
    expect(alert.closest("li")?.textContent).toContain("qwen3.5:9b");
  });

  it("reads the list again instead of failing when a load's answer missed the deadline", async () => {
    let started = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    serve(
      async () => {
        if (!started) return json(listOf([IDLE]));
        await held;
        return json(listOf([{ ...IDLE, state: "loading" }]));
      },
      () => { started = true; return json({ error: "desktop_unavailable" }, 503); },
    );
    render(<LocalModelsSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load llama3:latest" }));
    await waitFor(() => expect(gets()).toBe(2));
    // While the read is on its way, the 503 says nothing of its own.
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 30); }); });
    expect(screen.queryByRole("alert")).toBeNull();
    release();
    const card = screen.getByText("llama3:latest").closest("li") as HTMLElement;
    await waitFor(() => expect(card.textContent).toContain("Loading into memory…"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Open .* on the desktop/)).toBeNull();
  });

  it("polls fast for 30 s after a write went unconfirmed, then slows down", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    serve(() => json(listOf([IDLE])), () => json({ error: "desktop_unavailable" }, 503));
    render(<LocalModelsSheet onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(gets()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Load llama3:latest" }));
    await tick(100, 50);
    expect(posts()).toHaveLength(1);
    expect(gets()).toBe(2);
    // The list stays idle, yet it is read every 2.5 s: the load may have started.
    await tick(29_000);
    expect(gets()).toBe(13);
    await tick(2_000);
    const settled = gets();
    await tick(8_000);
    expect(gets()).toBe(settled);
    await tick(2_000);
    expect(gets()).toBe(settled + 1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("restarts the fast reads for each write that goes unconfirmed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    serve(() => json(listOf([IDLE, row({ name: "phi3:mini" })])), () => json({ error: "desktop_unavailable" }, 503));
    render(<LocalModelsSheet onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "Load llama3:latest" }));
    await tick(20_000);
    fireEvent.click(screen.getByRole("button", { name: "Load phi3:mini" }));
    await tick(20_000);
    // 40 s after the first, 20 s after the second: still on the fast clock.
    const now = gets();
    await tick(5_000);
    expect(gets()).toBe(now + 2);
  });

  it("reads nothing more once closed while a write is on its way", async () => {
    let answer!: (response: Response) => void;
    const onChange = vi.fn();
    serve(() => json(listOf([IDLE])), () => new Promise<Response>((resolve) => { answer = resolve; }));
    const view = render(<LocalModelsSheet onClose={() => {}} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load llama3:latest" }));
    const before = gets();
    view.unmount();
    await act(async () => {
      answer(json({ error: "desktop_unavailable" }, 503));
      await new Promise((resolve) => { setTimeout(resolve, 30); });
    });
    expect(gets()).toBe(before);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("says to open the app only when the read also finds no window", async () => {
    let open = true;
    serve(
      () => (open ? json(listOf([IDLE])) : json({ error: "desktop_unavailable" }, 503)),
      () => { open = false; return json({ error: "desktop_unavailable" }, 503); },
    );
    render(<LocalModelsSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load llama3:latest" }));
    expect((await screen.findByRole("alert")).textContent).toBe(`Open ${BRAND.display} on the desktop to see and load models.`);
    expect(screen.queryByText("llama3:latest")).toBeNull();
  });

  it("says to open the app when there is no desktop window", async () => {
    serve(() => json({ error: "desktop_unavailable" }, 503));
    render(<LocalModelsSheet onClose={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toBe(`Open ${BRAND.display} on the desktop to see and load models.`);
  });

  it("offers Start Ollama when the desktop can start it, and says when a start failed", async () => {
    serve(
      () => json(listOf([IDLE], { server: "stopped", can_start: true, start_failed: true })),
      () => json(listOf([IDLE], { server: "starting" }), 202),
    );
    render(<LocalModelsSheet onClose={() => {}} />);
    expect(await screen.findByText("Ollama isn't running on the desktop.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Ollama didn't start. Start it on the desktop.");
    // No Load while the server is down.
    expect(screen.queryByRole("button", { name: /^Load / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Start Ollama/ }));
    expect(await screen.findByText("Starting Ollama…")).toBeTruthy();
    expect(posts()).toEqual([{ action: "start" }]);
    expect(screen.queryByRole("button", { name: /Start Ollama/ })).toBeNull();
  });

  it("says when the desktop refused a Start, under its button", async () => {
    serve(
      () => json(listOf([IDLE], { server: "stopped", can_start: true })),
      () => json({ error: "desktop_error" }, 502),
    );
    render(<LocalModelsSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Start Ollama/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("That didn't work. Check Ollama on the desktop.");
    expect(posts()).toEqual([{ action: "start" }]);
    await waitFor(() => expect(gets()).toBe(2));
    expect(screen.getByRole("button", { name: /Start Ollama/ })).toBeTruthy();
  });

  it("offers no Start when the desktop cannot start Ollama without asking", async () => {
    serve(() => json(listOf([], { server: "unreachable" })));
    render(<LocalModelsSheet onClose={() => {}} />);
    expect(await screen.findByText(/isn't answering/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Start Ollama/ })).toBeNull();
  });

  it("polls every 2.5 s while a model loads, every 10 s otherwise, and stops when closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let loading = true;
    serve(() => json(listOf([{ ...IDLE, state: loading ? "loading" : "idle" }])));
    const view = render(<LocalModelsSheet onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(gets()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(gets()).toBe(2);
    loading = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(gets()).toBe(3);
    // Idle now: nothing at 2.5 s, the next read at 10 s.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(gets()).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(7_500); });
    expect(gets()).toBe(4);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(gets()).toBe(4);
  });

  it("polls fast while Ollama starts and stops while the page is hidden", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    serve(() => json(listOf([], { server: "starting" })));
    render(<LocalModelsSheet onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(gets()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(gets()).toBe(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      await act(async () => { fireEvent(document, new Event("visibilitychange")); });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(gets()).toBe(2);
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      await act(async () => { fireEvent(document, new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
      expect(gets()).toBe(3);
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }
  });
});

describe("local models — the Home row", () => {
  it.each([
    ["the switch is off", () => json({ error: "local_models_disabled" }, 403)],
    ["the sidecar predates the routes", () => new Response("not found", { status: 404 })],
    ["Ollama is not installed", () => json(listOf([], { server: "not_installed" }))],
    ["the answer is not a list", () => json({ projects: [] })],
  ])("is left out when %s", async (_name, answer) => {
    serve(answer);
    const view = render(<LocalModelsSection />);
    await waitFor(() => expect(gets()).toBe(1));
    await act(async () => {});
    expect(view.container.innerHTML).toBe("");
  });

  it("says to open the app with no desktop window", async () => {
    serve(() => json({ error: "desktop_unavailable" }, 503));
    render(<LocalModelsSection />);
    expect(await screen.findByText(`Open ${BRAND.display} on the desktop to see and load models.`)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Local models" })).toBeTruthy();
  });

  it("keeps the newer list when an older read lands after it", async () => {
    let releaseFirst: (response: Response) => void = () => {};
    let call = 0;
    serve(() => {
      call += 1;
      if (call === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve; });
      return json(listOf([LOADED, IDLE]));
    });
    render(<LocalModelsSection />);
    await waitFor(() => expect(gets()).toBe(1));
    // The page flips back into view before the first read answers.
    await act(async () => { fireEvent(document, new Event("visibilitychange")); });
    const button = await screen.findByRole("button", { name: /Ollama models on the desktop/ });
    await waitFor(() => expect(button.textContent).toContain("1 loaded · 2 installed"));
    await act(async () => { releaseFirst(json(listOf([LOADED, IDLE, CLOUD]))); });
    await act(async () => {});
    expect(button.textContent).toContain("1 loaded · 2 installed");
  });

  it("captions the row with the counts and opens the sheet", async () => {
    serve(() => json(listOf([LOADED, IDLE, CLOUD])));
    render(<LocalModelsSection />);
    const button = await screen.findByRole("button", { name: /Ollama models on the desktop/ });
    await waitFor(() => expect(button.textContent).toContain("1 loaded · 3 installed"));
    fireEvent.click(button);
    expect(await screen.findByRole("dialog", { name: "Local models" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
