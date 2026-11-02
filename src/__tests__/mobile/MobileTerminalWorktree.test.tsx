import { act, fireEvent, render, screen } from "@testing-library/react";
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

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND } from "../../lib/brand";

const TAB = {
  id: "tab-7", label: "Claude · topic", kind: "agent" as const, available: true, viewer_busy: false,
  worktree: { label: "topic", branch: "topic" }, worktree_movable: true,
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

function worktreeFetch(move: () => Response) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/worktrees")) {
      return Promise.resolve(jsonResponse(200, {
        worktrees: [
          { id: "w-main", label: "", branch: "main", main: true },
          { id: "w-topic", label: "topic", branch: "topic", main: false },
        ],
        current: "w-topic",
        carries: true,
      }));
    }
    if (url.endsWith("/worktree") && init?.method === "POST") return Promise.resolve(move());
    return Promise.resolve(jsonResponse(404, { error: "not_found" }));
  });
}

describe(`${BRAND.display} Mobile facts row moves the agent to another worktree, as the desktop Reader does`, () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names the worktree, lists the places and moves on a pick", async () => {
    const fetchMock = worktreeFetch(() => jsonResponse(200, { moved: "carried" }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    expect(container.querySelector(".session-facts .fact-worktree")?.textContent).toBe("worktree topic");
    const chip = screen.getByTitle(/Move this agent to another worktree/u);
    fireEvent.click(chip);
    await settle();

    const sheet = screen.getByRole("dialog", { name: "Move the agent to a worktree" });
    const rows = [...sheet.querySelectorAll(".option-list button")];
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^mainproject folder/u),
      expect.stringMatching(/^topicworktree topic/u),
    ]);
    expect(rows[1].getAttribute("aria-current")).toBe("true");
    expect(sheet.textContent).toContain("carries on with this conversation");

    fireEvent.click(rows[0]);
    await settle();
    const post = fetchMock.mock.calls.find(([url, init]) => url === "/api/v1/tabs/tab-7/worktree" && init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ worktree: "w-main" });
    expect(screen.queryByRole("dialog", { name: "Move the agent to a worktree" })).toBeNull();
  });

  it("keeps the sheet up and says so when the move failed", async () => {
    vi.stubGlobal("fetch", worktreeFetch(() => jsonResponse(409, { error: "move_failed" })));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByTitle(/Move this agent to another worktree/u));
    await settle();
    fireEvent.click(screen.getAllByRole("button", { name: /project folder/u })[0]);
    await settle();

    const sheet = screen.getByRole("dialog", { name: "Move the agent to a worktree" });
    expect(sheet.querySelector(".sheet-note.error")?.textContent).toContain("couldn't be moved");
  });

  it("leaves a tab the move does not apply to with its plain branch", async () => {
    const fetchMock = worktreeFetch(() => jsonResponse(200, { moved: "carried" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Terminal tab={{ ...TAB, worktree_movable: undefined }} back={() => {}} />);
    await settle();

    expect(screen.queryByTitle(/Move this agent to another worktree/u)).toBeNull();
  });

  it("is off while the agent works", async () => {
    vi.stubGlobal("fetch", worktreeFetch(() => jsonResponse(200, { moved: "carried" })));
    render(<Terminal tab={{ ...TAB, agent_status: "working" as const }} back={() => {}} />);
    await settle();

    expect((screen.getByTitle(/Move this agent to another worktree/u) as HTMLButtonElement).disabled).toBe(true);
  });
});
