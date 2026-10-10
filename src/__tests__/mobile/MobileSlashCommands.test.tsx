/**
 * The composer's `/` menu (`mobile-web/src/slashCommands.ts`). A phone draft
 * never reaches the CLI's own input line before Send, so the menu a TUI opens
 * under a typed `/` never shows on the phone; the composer offers its own —
 * the slash commands this phone sent to the tab's CLI before, kept per CLI,
 * then a built-in list of the commands that CLI documents.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completedSlashCommand,
  draftPrefix,
  draftPrefixes,
  forgetSlashCommand,
  readSlashCommands,
  rememberSlashCommand,
  slashCatalog,
  slashCli,
  slashSuggestions,
  toggleDraftPrefix,
} from "../../../mobile-web/src/slashCommands";

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

const sent: string[] = [];
class FakeWebSocket {
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  send(data: string | Uint8Array) { sent.push(ArrayBuffer.isView(data) ? new TextDecoder().decode(data) : String(data)); }
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND, storageKey } from "../../lib/brand";

const KEY = storageKey("mobile.slashCommands");
const CLAUDE_TAB = { id: "tab-c", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
const typedOut = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 400)); });
const lines = (draft: string, cli: string, used: string[] = []) => slashSuggestions(draft, cli, used).map((row) => row.line);

describe(`${BRAND.display} Mobile slash commands — which CLI`, () => {
  it("keys the known families by their label, and any other CLI by its own first word", () => {
    expect(slashCli("Claude")).toBe("claude");
    expect(slashCli("Claude Code (fenced)")).toBe("claude");
    expect(slashCli("Codex")).toBe("codex");
    expect(slashCli("Gemini CLI")).toBe("gemini");
    expect(slashCli("OpenCode mini")).toBe("opencode");
    expect(slashCli("Goose")).toBe("goose");
    expect(slashCli("  ")).toBe("agent");
  });

  it("offers each CLI only its own commands — Codex's /new is not Claude Code's", () => {
    // Codex's /new asks where the new conversation runs; /clear just starts it.
    expect(slashCatalog("codex").map((entry) => entry.command).slice(0, 2)).toEqual(["/clear", "/new"]);
    expect(slashCatalog("codex").map((entry) => entry.command)).toContain("/permissions");
    expect(slashCatalog("codex").map((entry) => entry.command)).not.toContain("/approvals");
    expect(slashCatalog("claude").map((entry) => entry.command)).toContain("/clear");
    expect(slashCatalog("claude").map((entry) => entry.command)).not.toContain("/new");
    expect(slashCatalog("gemini").map((entry) => entry.command)).toContain("/compress");
    expect(slashCatalog("goose")).toEqual([]);
  });
});

describe(`${BRAND.display} Mobile slash commands — the store`, () => {
  it("keeps what was sent per CLI, newest first, arguments and all", () => {
    const storage = memoryStorage();
    rememberSlashCommand("claude", "/model opus", storage, 1);
    rememberSlashCommand("claude", "  /compact   keep the plan ", storage, 2);
    rememberSlashCommand("codex", "/new", storage, 3);
    expect(readSlashCommands("claude", storage)).toEqual(["/compact keep the plan", "/model opus"]);
    expect(readSlashCommands("codex", storage)).toEqual(["/new"]);
    expect(readSlashCommands("gemini", storage)).toEqual([]);
  });

  it("moves a line sent again to the front instead of keeping it twice, and forgets on request", () => {
    const storage = memoryStorage();
    rememberSlashCommand("claude", "/model opus", storage, 1);
    rememberSlashCommand("claude", "/usage", storage, 2);
    rememberSlashCommand("claude", "/model opus", storage, 3);
    expect(readSlashCommands("claude", storage)).toEqual(["/model opus", "/usage"]);
    forgetSlashCommand("claude", "/model opus", storage);
    expect(readSlashCommands("claude", storage)).toEqual(["/usage"]);
    forgetSlashCommand("claude", "/usage", storage);
    expect(storage.map.has(KEY)).toBe(false);
  });

  it("ignores what is not a one-line slash command", () => {
    const storage = memoryStorage();
    for (const draft of ["plain prompt", "/", "//comment", "/model\nsecond line", `/x ${"a".repeat(300)}`]) {
      rememberSlashCommand("claude", draft, storage, 1);
    }
    expect(storage.map.has(KEY)).toBe(false);
  });

  it("caps each CLI's list, so a year of commands cannot fill the store", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 40; index += 1) rememberSlashCommand("claude", `/cmd${index}`, storage, index);
    const kept = readSlashCommands("claude", storage);
    expect(kept).toHaveLength(30);
    expect(kept[0]).toBe("/cmd39");
  });

  it("reads anything but the written shape as nothing kept, and survives a blocked store", () => {
    for (const stored of ["[]", "null", "{oops", '{"claude":"/clear"}', '{"claude":[{"line":"no slash","at":1}]}', '{"claude":[{"line":"/x"}]}']) {
      expect(readSlashCommands("claude", memoryStorage({ [KEY]: stored }))).toEqual([]);
    }
    const throwing = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    };
    expect(readSlashCommands("claude", throwing)).toEqual([]);
    expect(() => rememberSlashCommand("claude", "/clear", throwing)).not.toThrow();
  });
});

describe(`${BRAND.display} Mobile slash commands — the suggestions`, () => {
  it("offers nothing unless the draft is one line starting with a slash", () => {
    expect(lines("", "claude")).toEqual([]);
    expect(lines("compact", "claude")).toEqual([]);
    expect(lines("/compact\nmore", "claude")).toEqual([]);
  });

  it("puts the reader's own lines ahead of the built-in ones, and does not repeat the draft itself", () => {
    const used = ["/model opus", "/mcp"];
    expect(lines("/m", "claude", used)).toEqual(["/model opus", "/mcp", "/model", "/memory"]);
    expect(lines("/model", "claude", used)).toEqual(["/model opus"]);
    expect(lines("/model o", "claude", used)).toEqual(["/model opus"]);
    expect(lines("/clear", "claude")).toEqual([]);
  });

  it("falls back to commands that contain what was typed", () => {
    expect(lines("/pact", "claude")).toEqual(["/compact"]);
  });

  it("leaves room for the argument after a command that takes one", () => {
    const rows = slashSuggestions("/mod", "claude", []);
    expect(rows[0]).toMatchObject({ line: "/model", args: true, used: false });
    expect(slashSuggestions("/usa", "claude", [])[0]).toMatchObject({ line: "/usage", args: false });
  });
});

describe(`${BRAND.display} Mobile slash commands — a prefix the CLI completes`, () => {
  it("names the one known command a bare prefix continues", () => {
    expect(completedSlashCommand("/clea", "claude", [])).toBe("/clear");
    expect(completedSlashCommand(" /cle ", "codex", [])).toBe("/clear");
  });

  it("keeps a whole command, and anything that is not a bare /word, as typed", () => {
    expect(completedSlashCommand("/clear", "claude", [])).toBe("/clear");
    expect(completedSlashCommand("/model opus", "claude", [])).toBe("/model opus");
    expect(completedSlashCommand("hello", "claude", [])).toBe("hello");
  });

  it("knows no pick when more than one command, or none, continues it", () => {
    expect(completedSlashCommand("/c", "claude", [])).toBeNull();
    expect(completedSlashCommand("/zzz", "claude", [])).toBeNull();
  });

  it("counts the commands sent to this CLI before", () => {
    expect(completedSlashCommand("/cle", "claude", ["/cleanup now"])).toBeNull();
    expect(completedSlashCommand("/my-sk", "claude", ["/my-skill arg"])).toBe("/my-skill");
  });
});

describe(`${BRAND.display} Mobile slash commands — the composer`, () => {
  beforeEach(() => {
    localStorage.clear();
    sent.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }))));
    localStorage.setItem(storageKey("mobile.view.agent"), "terminal");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens a menu under a typed slash, and a pick only fills the field", async () => {
    render(<Terminal tab={CLAUDE_TAB} back={() => {}} />);
    await settle();
    const field = screen.getByLabelText("Message agent") as HTMLTextAreaElement;
    expect(screen.queryByRole("group", { name: "Commands" })).toBeNull();

    fireEvent.change(field, { target: { value: "/mod" } });
    const menu = screen.getByRole("group", { name: "Commands" });
    const before = sent.length;
    fireEvent.click(within(menu).getByText("/model"));
    expect(field.value).toBe("/model ");
    // Nothing went to the session: the reader still sends it.
    expect(sent.length).toBe(before);
  });

  it("remembers a slash command sent to this CLI and offers it first the next time", async () => {
    const view = render(<Terminal tab={CLAUDE_TAB} back={() => {}} />);
    await settle();
    const field = screen.getByLabelText("Message agent") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "/model opus" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(readSlashCommands("claude")).toEqual(["/model opus"]);
    // A prompt is not a command, and is not kept.
    fireEvent.change(field, { target: { value: "fix the build" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(readSlashCommands("claude")).toEqual(["/model opus"]);
    view.unmount();

    render(<Terminal tab={{ ...CLAUDE_TAB, id: "tab-other" }} back={() => {}} />);
    await settle();
    fireEvent.change(screen.getByLabelText("Message agent"), { target: { value: "/mo" } });
    const menu = screen.getByRole("group", { name: "Commands" });
    const picks = within(menu).getAllByRole("button").filter((button) => button.classList.contains("slash-pick"));
    expect(picks[0].textContent).toContain("/model opus");

    fireEvent.click(within(menu).getByRole("button", { name: "Forget /model opus" }));
    expect(readSlashCommands("claude")).toEqual([]);
  });

  it("keeps one CLI's commands out of another's menu", async () => {
    rememberSlashCommand("codex", "/review the auth change");
    render(<Terminal tab={CLAUDE_TAB} back={() => {}} />);
    await settle();
    fireEvent.change(screen.getByLabelText("Message agent"), { target: { value: "/rev" } });
    const menu = screen.getByRole("group", { name: "Commands" });
    expect(within(menu).queryByText("/review the auth change")).toBeNull();
    expect(within(menu).getByText("/review")).toBeTruthy();
  });

  it("puts the keys button after ＋, then Plan, Goal, Clear and Commit, the mic in the field; a tap leads the draft and sends nothing", async () => {
    render(<Terminal tab={CLAUDE_TAB} back={() => {}} />);
    await settle();
    const field = screen.getByLabelText("Message agent") as HTMLTextAreaElement;
    const plan = screen.getByRole("button", { name: "Plan" });
    const goal = screen.getByRole("button", { name: "Goal" });
    const bar = plan.closest(".composer-bar") as HTMLElement;
    const order = Array.from(bar.querySelectorAll("button")).map((button) => button.className.split(" ")[0]);
    expect(order).toEqual(["composer-add", "composer-keys", "composer-prefix", "composer-prefix", "composer-prefix", "composer-prefix", "send-icon"]);
    expect(screen.getByRole("button", { name: "Start a new conversation" }).textContent).toBe("Clear");
    expect(bar.previousElementSibling?.querySelector(".composer-dictate")).toBeTruthy();

    fireEvent.change(field, { target: { value: "fix the build" } });
    const before = sent.length;
    fireEvent.click(plan);
    expect(field.value).toBe("/plan fix the build");
    expect(plan.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(goal);
    expect(field.value).toBe("/goal fix the build");
    fireEvent.click(goal);
    expect(field.value).toBe("fix the build");
    expect(sent.length).toBe(before);
  });

  it("sends the Commit chip's prompts as prompts, the draft left alone", async () => {
    render(<Terminal tab={CLAUDE_TAB} back={() => {}} />);
    await settle();
    const field = screen.getByLabelText("Message agent") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "half a thought" } });

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    const sheet = screen.getByRole("dialog", { name: "Commit" });
    const before = sent.length;
    fireEvent.click(within(sheet).getByText("Split into commits"));
    // The line is cleared first; the words follow a key gap later.
    await typedOut();
    expect(screen.queryByRole("dialog", { name: "Commit" })).toBeNull();
    expect(sent.slice(before).join("")).toContain("Split the uncommitted changes into focused commits");
    expect(field.value).toBe("half a thought");

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    const again = sent.length;
    fireEvent.click(within(screen.getByRole("dialog", { name: "Commit" })).getByText("Commit the current state"));
    await typedOut();
    expect(sent.slice(again).join("")).toContain("Commit the current state");

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    const own = sent.length;
    fireEvent.click(within(screen.getByRole("dialog", { name: "Commit" })).getByText("Commit your changes only"));
    await typedOut();
    expect(sent.slice(own).join("")).toContain("Commit only the changes you made in this conversation");
    expect(readSlashCommands("claude")).toEqual([]);
  });

    it("offers only the chips a CLI documents", async () => {
    render(<Terminal tab={{ ...CLAUDE_TAB, id: "tab-g", label: "Gemini" }} back={() => {}} />);
    await settle();
    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Goal" })).toBeNull();
  });
});

describe(`${BRAND.display} Mobile slash commands — the Plan / Goal chips`, () => {
  const both = draftPrefixes("claude");

  it("knows which CLIs have which", () => {
    expect(draftPrefixes("codex")).toEqual(["/plan", "/goal"]);
    expect(draftPrefixes("copilot")).toEqual(["/plan"]);
    expect(draftPrefixes("aider")).toEqual([]);
  });

  it("toggles its own command, swaps the other, and keeps the words", () => {
    expect(toggleDraftPrefix("", "/plan", both)).toBe("/plan ");
    expect(toggleDraftPrefix("  ship it", "/plan", both)).toBe("/plan ship it");
    expect(toggleDraftPrefix("/plan ship it", "/plan", both)).toBe("ship it");
    expect(toggleDraftPrefix("/plan ship it", "/goal", both)).toBe("/goal ship it");
    expect(toggleDraftPrefix("/plan", "/plan", both)).toBe("");
    // Another command is words to lead, not a chip to replace.
    expect(toggleDraftPrefix("/model opus", "/plan", both)).toBe("/plan /model opus");
    expect(draftPrefix("/planning", both)).toBeNull();
  });
});
