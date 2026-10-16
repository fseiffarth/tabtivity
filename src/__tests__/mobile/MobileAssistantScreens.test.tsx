/**
 * The chat assistant on the phone (`docs/assistant_plan.md`, S5b): its row on
 * the home list, the chat list behind it, the New chat sheet fed by the host's
 * opaque launch ids, and the Focus chat with every folder-shaped affordance
 * (files, outbox, inbox uploads, Commit, Mark up, schedules) left out.
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
import { rememberScopeKind } from "../../../mobile-web/src/scopeKind";
import { scopeCaption } from "../../../mobile-web/src/projectOrder";
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

describe("Mobile assistant — the home row", () => {
  it("is a row of its own kind, captioned as the chat assistant", async () => {
    expect(scopeCaption({ kind: "assistant", status: "active" })).toMatch(/^✦ /);
    fetchMock.mockImplementation((url: string) => json(String(url)).then(() => new Response(
      JSON.stringify(String(url).includes("alerts") ? { alerts: { enabled: false, items: [] } } : { projects: [
        { id: "scope", label: "Tabby", status: "active", kind: "assistant", live_sessions: 2 },
        { id: "p", label: "Alpha", status: "active", live_sessions: 1 },
      ] }),
      { status: 200 },
    )));
    const open = vi.fn();
    render(<Home open={open} openTab={() => {}} todo={() => {}} mail={() => {}} />);
    const row = (await screen.findByText("Tabby")).closest("button") as HTMLElement;
    expect(within(row).getByText(/chat assistant/)).toBeTruthy();
    fireEvent.click(row);
    expect(open).toHaveBeenCalledWith("scope");
  });
});

describe("Mobile assistant — the chat list", () => {
  const serve = (tabs: unknown[]) => fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/launch-options")) return json(OPTIONS);
    if (init?.method === "POST") return json({ tab: chat("new", "Claude") });
    return json({ ...SCOPE, tabs });
  });

  it("lists the newest chat first, with no schedule, prompts, outbox or file route", async () => {
    serve([chat("old", "first chat"), chat("mid", "second chat"), chat("new", "third chat")]);
    const { container } = render(<Project id="scope" back={() => {}} terminal={() => {}} />);
    await screen.findByText("third chat");
    expect([...container.querySelectorAll(".tab-card strong")].map((node) => node.textContent)).toEqual(["third chat", "second chat", "first chat"]);
    expect(container.querySelector(".tab-card-schedule")).toBeNull();
    expect(container.querySelector(".tab-card-grip")).toBeNull();
    expect(container.querySelector(".drawer-open")).toBeNull();
    expect(screen.queryByText(/Collected prompts/)).toBeNull();
    expect(urls().filter((url) => /outbox|files|git|prompts|schedules/.test(url))).toEqual([]);
    // The header's ＋ is the New chat button; a close ✕ stays on each card.
    expect(screen.getByLabelText("New chat")).toBeTruthy();
    expect(container.querySelectorAll(".tab-card-close")).toHaveLength(3);
  });

  it("says so when there are no chats", async () => {
    serve([]);
    render(<Project id="scope" back={() => {}} terminal={() => {}} />);
    expect(await screen.findByText(/No chats yet/)).toBeTruthy();
  });

  it("starts a chat from an opaque launch id, alone in the request, and opens it", async () => {
    serve([]);
    const terminal = vi.fn();
    render(<Project id="scope" back={() => {}} terminal={terminal} />);
    await screen.findByText(/No chats yet/);
    fireEvent.click(screen.getByLabelText("New chat"));
    const dialog = await screen.findByRole("dialog");
    // The local model is listed under its own group, named by the model.
    await within(dialog).findByText("qwen3:8b");
    // A CLI that is not signed in on the desktop is dimmed and says why.
    expect((within(dialog).getByText("Codex") as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText(/Codex is not signed in/)).toBeTruthy();
    fireEvent.click(within(dialog).getByText("Claude"));
    await waitFor(() => expect(terminal).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(String(post?.[0])).toBe("/api/v1/projects/scope/tabs");
    const body = JSON.parse(String((post?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({ project_id: "scope", kind: "agent", assistant: "h-claude" });
    expect(String(body.idempotency_key).length).toBeGreaterThanOrEqual(16);
    expect(body).not.toHaveProperty("agent_id");
    expect(body).not.toHaveProperty("local");
    expect(body).not.toHaveProperty("worktree");
  });

  it("names a local launch by its opaque id too", async () => {
    serve([]);
    render(<Project id="scope" back={() => {}} terminal={() => {}} />);
    await screen.findByText(/No chats yet/);
    fireEvent.click(screen.getByLabelText("New chat"));
    fireEvent.click(await screen.findByText("qwen3:8b"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toMatchObject({ assistant: "h-oc-qwen" });
  });

  it("tells the reader when Ollama is down and no local model is listed", async () => {
    fetchMock.mockImplementation((url: string) => String(url).endsWith("/launch-options")
      ? json({ ...OPTIONS, assistant: { ollama_reachable: false, launches: [OPTIONS.assistant.launches[0]] } })
      : json({ ...SCOPE, tabs: [] }));
    render(<Project id="scope" back={() => {}} terminal={() => {}} />);
    await screen.findByText(/No chats yet/);
    fireEvent.click(screen.getByLabelText("New chat"));
    expect(await screen.findByText(/Ollama is not running/)).toBeTruthy();
  });

  it("starts a restored chat that has no process yet, then opens it once its session is live", async () => {
    let live = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") { live = true; return json({ status: "activated" }); }
      return json({ ...SCOPE, tabs: [chat("c1", "old chat", { available: live })] });
    });
    const terminal = vi.fn();
    render(<Project id="scope" back={() => {}} terminal={terminal} />);
    await screen.findByText(/Not running/);
    fireEvent.click(screen.getByLabelText("Open old chat"));
    await waitFor(() => expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", available: true })), { timeout: 4000 });
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(String(post?.[0])).toBe("/api/v1/projects/scope/activate?tab=c1");
  });

  it("leaves a project exactly as it was: schedules, prompts and the outbox are still read", async () => {
    rememberScopeKind("p", "project");
    fetchMock.mockImplementation((url: string) => String(url).endsWith("/outbox")
      ? json({ files: [] })
      : json({ project: { id: "p", label: "Alpha", status: "active", live_sessions: 1 }, desktop_available: true, tabs: [chat("a", "claude 1")], agents: [] }));
    const { container } = render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    expect(container.querySelector(".tab-card-schedule")).toBeTruthy();
    expect(screen.getByText(/Collected prompts/)).toBeTruthy();
    await waitFor(() => expect(urls().some((url) => /outbox/.test(url))).toBe(true));
  });
});

describe("Mobile assistant — the Focus chat", () => {
  const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };
  const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

  beforeEach(() => {
    localStorage.setItem(storageKey("mobile.view.agent"), "terminal");
    fetchMock.mockImplementation(() => json({ error: "not_found" }, 404));
  });

  it("offers no attach, Commit, file drawer or outbox for a chat, and reads none of them", async () => {
    const { container } = render(<Terminal tab={TAB} project="scope" back={() => {}} />);
    await settle();
    expect(screen.getByLabelText("Message agent")).toBeTruthy();
    expect(container.querySelector(".composer-add")).toBeNull();
    expect(container.querySelector(".composer-commit")).toBeNull();
    expect(container.querySelector(".drawer-open")).toBeNull();
    expect(container.querySelector(".terminal-gallery")).toBeNull();
    expect(urls().filter((url) => /outbox|uncommitted|markup|\/projects\//.test(url))).toEqual([]);
  });

  it("keeps all of them on a project's chat", async () => {
    rememberScopeKind("p", "project");
    const { container } = render(<Terminal tab={TAB} project="p" back={() => {}} />);
    await settle();
    expect(container.querySelector(".composer-add")).toBeTruthy();
    expect(container.querySelector(".composer-commit")).toBeTruthy();
    expect(urls().some((url) => /outbox/.test(url))).toBe(true);
  });
});
