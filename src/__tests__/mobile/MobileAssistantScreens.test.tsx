/**
 * The chat assistant on the phone: one chat, opened from Home's FAB (no row on
 * the list) — the last chat, started again when it has no process, or a new
 * one on the desktop's default launch (`TabbyOpen`) — and the Focus chat, whose
 * head switches the CLI or relaunches it by the host's opaque launch ids, with
 * every project-shaped affordance (files, outbox, Commit, Mark up, schedules)
 * left out. The composer's + stays: its files land in the chat's own folder.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = { active: { length: 0, getLine() { return undefined; } } };
    loadAddon() {}
    open() {}
    write(_value: Uint8Array, callback?: () => void) { callback?.(); }
    onData() { return { dispose() {} }; }
    scrollLines() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

class FakeWebSocket {
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  send() {}
  close() { this.readyState = 3; }
}

import { Home } from "../../../mobile-web/src/screens/Home";
import { Project } from "../../../mobile-web/src/screens/Project";
import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { TabbyOpen } from "../../../mobile-web/src/screens/TabbyOpen";
import { rememberScopeKind } from "../../../mobile-web/src/scopeKind";
import { storageKey } from "../../lib/brand";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const urls = () => fetchMock.mock.calls.map(([url]) => String(url));

const chat = (id: string, label: string, extra: Record<string, unknown> = {}) =>
  ({ id, label, kind: "agent", available: true, viewer_busy: false, ...extra });
const SCOPE = {
  project: { id: "scope", label: "Tabby", status: "active", kind: "assistant", live_sessions: 2 },
  desktop_available: true,
  agents: [],
  shells: false,
};
const OPTIONS = {
  worktrees: [], cloud: [], sign_in: [],
  assistant: {
    ollama_reachable: true,
    launches: [
      { id: "h-claude", label: "Claude", local: false, ready: true, default: true },
      { id: "h-codex", label: "Codex", local: false, ready: false, default: false },
      { id: "h-oc-qwen", label: "OpenCode", local: true, model: "qwen3:8b", ready: true, default: false },
    ],
  },
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  rememberScopeKind("scope", "assistant");
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
const deletes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE").map(([url]) => String(url));

describe("Mobile assistant — Home", () => {
  const list = (listed: () => boolean) => fetchMock.mockImplementation((url: string) => json(String(url).includes("alerts") ? { alerts: { enabled: false, items: [] } } : { projects: [
    ...(listed() ? [{ id: "scope", label: "Tabby", status: "active", kind: "assistant", live_sessions: 2 }] : []),
    { id: "p", label: "Alpha", status: "active", live_sessions: 1 },
  ] }));

  it("lists no row for the assistant", async () => {
    list(() => true);
    const { container } = render(<Home open={() => {}} openTab={() => {}} tabby={() => {}} todo={() => {}} mail={() => {}} />);
    await screen.findByText("Alpha");
    expect([...container.querySelectorAll(".home-project-card strong")].map((node) => node.textContent)).toEqual(["Alpha"]);
  });

  it("floats Tabby's button, with the desktop's Tabby icon, that opens its chat in one tap, only while it is listed", async () => {
    let listed = true;
    list(() => listed);
    const open = vi.fn();
    const tabby = vi.fn();
    const { container } = render(<Home open={open} openTab={() => {}} tabby={tabby} todo={() => {}} mail={() => {}} />);
    const fab = await screen.findByRole("button", { name: /Open Tabby/ });
    expect(fab.classList.contains("fab-round")).toBe(true);
    expect(fab.querySelector("svg.app-icon")).toBeTruthy();
    expect(container.querySelector(".home-screen.has-fab")).toBeTruthy();
    fireEvent.click(fab);
    expect(tabby).toHaveBeenCalledWith("scope");
    expect(open).not.toHaveBeenCalled();
    // A search that misses the row keeps the button: it answers a query, not
    // whether the assistant is on.
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(container.querySelector("input.search") as HTMLInputElement, { target: { value: "alp" } });
    listed = false;
    await waitFor(() => expect(urls().some((url) => url.includes("view=search"))).toBe(true));
    expect(screen.getByRole("button", { name: /Open Tabby/ })).toBeTruthy();
    // The active list without it means the switch went off.
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Open Tabby/ })).toBeNull());
    expect(container.querySelector(".home-screen.has-fab")).toBeNull();
  });
});

describe("Mobile assistant — opening the chat", () => {
  it("opens the last chat when it is running, starting nothing", async () => {
    fetchMock.mockImplementation(() => json({ ...SCOPE, tabs: [chat("old", "first"), chat("new", "second")] }));
    const ready = vi.fn();
    render(<TabbyOpen id="scope" ready={ready} back={() => {}} />);
    await waitFor(() => expect(ready).toHaveBeenCalledWith(expect.objectContaining({ id: "new" })));
    expect(posts()).toEqual([]);
  });

  it("starts the last chat when it has no process, then opens it once its session is live", async () => {
    let live = false;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") { live = true; return json({ status: "activated" }); }
      return json({ ...SCOPE, tabs: [chat("c1", "old chat", { available: live })] });
    });
    const ready = vi.fn();
    render(<TabbyOpen id="scope" ready={ready} back={() => {}} />);
    await waitFor(() => expect(ready).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", available: true })), { timeout: 4000 });
    expect(String(posts()[0]?.[0])).toBe("/api/v1/projects/scope/activate?tab=c1");
  });

  it("with no chat, starts one on the default launch by its opaque id, alone in the request", async () => {
    let made = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/launch-options")) return json(OPTIONS);
      if (init?.method === "POST") { made = true; return json({ tab: chat("new", "Claude") }); }
      return json({ ...SCOPE, tabs: made ? [chat("new", "Claude")] : [] });
    });
    const ready = vi.fn();
    render(<TabbyOpen id="scope" ready={ready} back={() => {}} />);
    await waitFor(() => expect(ready).toHaveBeenCalledWith(expect.objectContaining({ id: "new" })));
    const post = posts()[0];
    expect(String(post?.[0])).toBe("/api/v1/projects/scope/tabs");
    const body = JSON.parse(String((post?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({ project_id: "scope", kind: "agent", assistant: "h-claude" });
    expect(String(body.idempotency_key).length).toBeGreaterThanOrEqual(16);
    expect(body).not.toHaveProperty("agent_id");
    expect(body).not.toHaveProperty("local");
    expect(body).not.toHaveProperty("worktree");
    expect(deletes()).toEqual([]);
  });

  it("says what stands in the way when no launch is ready, and Retry asks again", async () => {
    fetchMock.mockImplementation((url: string) => String(url).endsWith("/launch-options")
      ? json({ ...OPTIONS, assistant: { ollama_reachable: false, launches: [OPTIONS.assistant.launches[1]] } })
      : json({ ...SCOPE, tabs: [] }));
    const ready = vi.fn();
    render(<TabbyOpen id="scope" ready={ready} back={() => {}} />);
    expect(await screen.findByText(/Codex is not signed in/)).toBeTruthy();
    const before = urls().length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(urls().length).toBeGreaterThan(before));
    expect(ready).not.toHaveBeenCalled();
    expect(posts()).toEqual([]);
  });

  it("a project screen that lands on the assistant scope goes back", async () => {
    fetchMock.mockImplementation(() => json({ ...SCOPE, tabs: [chat("c1", "chat")] }));
    const back = vi.fn();
    render(<Project id="scope" back={back} terminal={() => {}} />);
    await waitFor(() => expect(back).toHaveBeenCalled());
  });

  it("leaves a project exactly as it was: schedules, prompts and the outbox are still read", async () => {
    rememberScopeKind("p", "project");
    fetchMock.mockImplementation((url: string) => String(url).endsWith("/outbox")
      ? json({ files: [] })
      : json({ project: { id: "p", label: "Alpha", status: "active", live_sessions: 1 }, desktop_available: true, tabs: [chat("a", "claude 1", { schedules: { total: 1, enabled: 1 } })], agents: [] }));
    const { container } = render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    expect(container.querySelector(".tab-card-schedule")).toBeTruthy();
    expect(screen.getByText(/Collected prompts/)).toBeTruthy();
    await waitFor(() => expect(urls().some((url) => /outbox/.test(url))).toBe(true));
  });
});

describe("Mobile assistant — the Focus chat", () => {
  const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false, assistant_launch: "h-claude" };
  const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

  beforeEach(() => {
    localStorage.setItem(storageKey("mobile.view.agent"), "terminal");
  });

  /** The chat's scope: `tab-7` and an older one, the launches, and a create. */
  const serve = () => {
    let made: string | null = null;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/launch-options")) return json(OPTIONS);
      if (init?.method === "POST" && path.endsWith("/tabs")) {
        made = (JSON.parse(String(init.body)) as { assistant: string }).assistant;
        return json({ tab: chat("fresh", "Fresh", { assistant_launch: made }) });
      }
      if (init?.method === "DELETE") return json({ closed: true });
      if (path.endsWith("/assistant-models")) return json({ rows: [{ id: "default", label: "Default (recommended)" }, { id: "claude-opus-5-5", label: "Opus 5.5" }], current: "default" });
      if (init?.method === "POST" && path.endsWith("/assistant-model")) return json({ switched: true });
      if (path === "/api/v1/projects/scope") return json({ ...SCOPE, tabs: [chat("old", "Old"), { ...TAB }, ...(made ? [chat("fresh", "Fresh")] : [])] });
      return json({ error: "not_found" }, 404);
    });
  };

  it("offers no Commit, file drawer or outbox for a chat, and reads none of them", async () => {
    serve();
    const { container } = render(<Terminal tab={TAB} project="scope" back={() => {}} />);
    await settle();
    expect(screen.getByLabelText("Message agent")).toBeTruthy();
    expect(container.querySelector(".composer-commit")).toBeNull();
    expect(container.querySelector(".drawer-open")).toBeNull();
    expect(container.querySelector(".terminal-gallery")).toBeNull();
    expect(urls().filter((url) => /outbox|uncommitted|markup/.test(url))).toEqual([]);
    // The one scope read is the launches, for the head's CLI dropdown.
    expect(urls().filter((url) => /\/projects\//.test(url))).toEqual(["/api/v1/projects/scope/launch-options"]);
  });

  it("keeps the composer's + as a project chat has it, minus the project file", async () => {
    serve();
    const { container } = render(<Terminal tab={TAB} project="scope" back={() => {}} />);
    await settle();
    const add = container.querySelector<HTMLButtonElement>(".composer-add");
    expect(add).toBeTruthy();
    fireEvent.click(add!);
    const sheet = await screen.findByRole("dialog", { name: "Add to the message" });
    const tiles = within(sheet).getAllByRole("button").map((button) => button.className).filter((name) => name.startsWith("attach-tile"));
    expect(tiles.map((name) => name.replace("attach-tile attach-tile-", ""))).toEqual(["camera", "gallery", "files", "desktop"]);
  });

  it("names its CLI in the head, and a pick starts a fresh chat on it in place of every other", async () => {
    serve();
    const openTab = vi.fn();
    render(<Terminal tab={TAB} project="scope" back={() => {}} openTab={openTab} />);
    const title = await screen.findByRole("button", { name: /^Claude/ });
    fireEvent.click(title);
    const menu = await screen.findByRole("menu");
    // A CLI that is not signed in on the desktop is dimmed and says why.
    const codex = within(menu).getByRole("menuitemradio", { name: /Codex/ });
    expect(codex.getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByText(/Codex is not signed in/)).toBeTruthy();
    fireEvent.click(codex);
    expect(posts()).toEqual([]);
    // One row per CLI: the model is the model dropdown's.
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /^OpenCode$/ }));
    await waitFor(() => expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ id: "fresh" })));
    expect(JSON.parse(String((posts()[0]?.[1] as RequestInit).body))).toMatchObject({ kind: "agent", assistant: "h-oc-qwen" });
    expect(deletes().sort()).toEqual(["/api/v1/tabs/old", "/api/v1/tabs/tab-7"]);
  });

  it("switches the model from the head's model line, with no status line", async () => {
    serve();
    const { container } = render(<Terminal tab={TAB} project="scope" back={() => {}} />);
    const model = await screen.findByRole("button", { name: /Default \(recommended\)/ });
    expect(container.querySelector(".session-facts")).toBeNull();
    fireEvent.click(model);
    fireEvent.click(await screen.findByRole("button", { name: /Opus 5\.5/ }));
    await waitFor(() => expect(posts().some(([url]) => String(url).endsWith("/tabs/tab-7/assistant-model"))).toBe(true));
    const sent = posts().find(([url]) => String(url).endsWith("/assistant-model"));
    expect(JSON.parse(String((sent?.[1] as RequestInit).body))).toEqual({ model: "claude-opus-5-5" });
  });

  it("Relaunch starts a fresh session on the same launch", async () => {
    serve();
    const openTab = vi.fn();
    render(<Terminal tab={TAB} project="scope" back={() => {}} openTab={openTab} />);
    fireEvent.click(await screen.findByRole("button", { name: "Relaunch" }));
    await waitFor(() => expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ id: "fresh" })));
    expect(JSON.parse(String((posts()[0]?.[1] as RequestInit).body))).toMatchObject({ assistant: "h-claude" });
  });

  it("keeps all of them on a project's chat", async () => {
    fetchMock.mockImplementation(() => json({ error: "not_found" }, 404));
    rememberScopeKind("p", "project");
    const { container } = render(<Terminal tab={TAB} project="p" back={() => {}} />);
    await settle();
    expect(container.querySelector(".composer-add")).toBeTruthy();
    expect(container.querySelector(".composer-commit")).toBeTruthy();
    expect(urls().some((url) => /outbox/.test(url))).toBe(true);
    expect(container.querySelector(".tabby-relaunch")).toBeNull();
  });
});
