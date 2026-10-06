import { act, render } from "@testing-library/react";
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
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND } from "../../lib/brand";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };
const NOW = 1_788_609_600; // 2026-09-04 12:00:00 UTC

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}


const PANEL = [
  "Current session: 71% used · resets 6:20pm",
  "Current week (all models): 94% used · resets Mon 9am",
  "Current week (Fable): 12% used",
].join("\n");

function statusFetch(usage: unknown) {
  return vi.fn((url: string) => url.endsWith("/status")
    ? Promise.resolve(jsonResponse(200, {
      report: { state: "idle", label: "Claude", project: "p", today: { prompts: 0, worked_s: 0, decisions: 0, done: 0 }, usage },
    }))
    : Promise.resolve(jsonResponse(404, { error: "not_found" })));
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

describe(`${BRAND.display} Mobile facts row shows the account's 5h and weekly windows`, () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads the usage panel on open and prints the session and all-models week", async () => {
    const fetchMock = statusFetch({ label: "Claude Code", supported: true, raw: PANEL, cached: false });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/tabs/tab-7/status")).toBe(true);
    const limits = [...container.querySelectorAll(".session-facts .fact-limit")];
    expect(limits[0].textContent).toMatch(/^5h 29% · in \d+h \d+m$/u);
    expect(limits[1].textContent).toMatch(/^week 6% · in \d+d \d+[hm]$/u);
    // Nearly spent is called out; the session window is not there yet.
    expect(limits.map((node) => node.classList.contains("high"))).toEqual([false, true]);
  });

  it("shows nothing for a CLI without a usage readout", async () => {
    vi.stubGlobal("fetch", statusFetch({ label: "Gemini CLI", supported: false, cached: false }));
    const { container } = render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    expect(container.querySelector(".session-facts .fact-limit")).toBeNull();
  });

  it("asks nothing for a shell tab", async () => {
    const fetchMock = statusFetch({ label: "Claude Code", supported: true, raw: PANEL, cached: false });
    vi.stubGlobal("fetch", fetchMock);
    render(<Terminal tab={{ ...TAB, kind: "shell" as const }} back={() => {}} />);
    await settle();

    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/status"))).toBe(false);
  });

  it("takes a Codex tab's context and windows from its stored session", async () => {
    const transcript = {
      available: true, version: "1:1", entries: [], truncated: false,
      usage: {
        contextLeft: 68,
        session: { used: 15, resetsAt: NOW + 3_600 },
        week: { used: 95, resetsAt: NOW + 86_400 },
      },
    };
    vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/status")
      ? Promise.resolve(jsonResponse(200, {
        report: { state: "idle", label: "Codex", project: "p", today: { prompts: 0, worked_s: 0, decisions: 0, done: 0 }, usage: { label: "Codex", supported: false, cached: false } },
      }))
      : url.includes("/transcript")
        ? Promise.resolve(jsonResponse(200, { transcript }))
        : Promise.resolve(jsonResponse(404, { error: "not_found" }))));
    const { container } = render(<Terminal tab={{ ...TAB, label: "Codex" }} back={() => {}} />);
    await settle();

    const facts = container.querySelector(".session-facts");
    expect(facts?.querySelector(".fact-context")?.textContent).toBe("68% context");
    expect([...container.querySelectorAll(".session-facts .fact-limit")].map((node) => node.textContent))
      .toEqual(["5h 85% · in 1h 0m", "week 5% · in 1d 0m"]);
    expect(facts?.querySelector(".fact-path")).toBeNull();
  });

  it("drops a stored window that has already rolled over", async () => {
    const { sessionLimits, resetPhrase } = await import("../../../mobile-web/src/terminal/sessionUsage");
    const { resolveResetAt } = await import("../../../shared/usageReport");
    const now = new Date(NOW * 1000);
    expect(sessionLimits({ session: { used: 40, resetsAt: NOW - 1 }, week: { used: 10 } }, now))
      .toEqual({ session: undefined, week: { label: "Current week", percent: 10 } });
    const at = new Date((NOW + 5_400) * 1000);
    expect(resolveResetAt(resetPhrase(at), now)?.getTime()).toBe(at.getTime());
  });
});
