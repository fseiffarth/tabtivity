/**
 * The half-typed message survives leaving the session
 * (`mobile-web/src/drafts.ts`). Going back to the tab list unmounts the terminal
 * screen and the phone cold-starts the PWA whenever it likes; the composer's
 * text is the one thing on that screen the reader made, so it is kept on the
 * phone — per tab, so two sessions never hand each other a message meant for
 * the other, and never sent across the bridge: an unsent message is not
 * something the desktop is told about.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAFT_SAVE_DELAY, readDraft, writeDraft } from "../../../mobile-web/src/drafts";

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
import { BRAND, storageKey } from "../../lib/brand";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };
const KEY = storageKey("mobile.drafts");

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

describe(`${BRAND.display} Mobile composer drafts — the store`, () => {
  it("round-trips one tab's draft, and keeps the tabs apart", () => {
    const storage = memoryStorage();
    writeDraft("tab-a", "half a thought", storage, 1_000);
    writeDraft("tab-b", "another one", storage, 2_000);
    expect(readDraft("tab-a", storage)).toBe("half a thought");
    expect(readDraft("tab-b", storage)).toBe("another one");
    expect(readDraft("tab-c", storage)).toBe("");
  });

  it("forgets a tab's draft once its composer is empty — sent or cleared, there is nothing to come back to", () => {
    const storage = memoryStorage();
    writeDraft("tab-a", "typed", storage, 1_000);
    writeDraft("tab-b", "kept", storage, 1_000);
    writeDraft("tab-a", "", storage, 2_000);
    expect(readDraft("tab-a", storage)).toBe("");
    expect(readDraft("tab-b", storage)).toBe("kept");
    // The last draft gone takes the whole record with it rather than leaving
    // an empty object behind in the phone's store.
    writeDraft("tab-b", "", storage, 3_000);
    expect(storage.map.has(KEY)).toBe(false);
  });

  it("keeps the newest twenty drafts, so a year of sessions cannot fill the store", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 25; index += 1) writeDraft(`tab-${index}`, `draft ${index}`, storage, 1_000 + index);
    expect(readDraft("tab-24", storage)).toBe("draft 24");
    expect(readDraft("tab-5", storage)).toBe("draft 5");
    expect(readDraft("tab-4", storage)).toBe("");
    expect(Object.keys(JSON.parse(storage.map.get(KEY) ?? "{}") as object)).toHaveLength(20);
  });

  it("reads anything but the written shape as no draft at all, rather than putting it in a composer", () => {
    for (const stored of ["[]", "null", "{oops", '{"tab-a":"bare string"}', '{"tab-a":{"text":7,"at":1}}', '{"tab-a":{"text":"t"}}']) {
      expect(readDraft("tab-a", memoryStorage({ [KEY]: stored }))).toBe("");
    }
    // A sound entry beside a broken one still reads.
    expect(readDraft("tab-b", memoryStorage({ [KEY]: '{"tab-a":"bare","tab-b":{"text":"kept","at":9}}' }))).toBe("kept");
  });

  it("survives a blocked store the way the view preferences do", () => {
    const throwing = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    };
    expect(readDraft("tab-a", throwing)).toBe("");
    expect(() => writeDraft("tab-a", "typed", throwing)).not.toThrow();
  });
});

describe(`${BRAND.display} Mobile composer drafts — the composer`, () => {
  beforeEach(() => {
    // The kept draft is what these tests are about, so each starts on a clean
    // store — and it is wiped here rather than in `afterEach`, since the unmount
    // that flushes a draft runs in Testing Library's own cleanup, after it.
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }))));
    localStorage.setItem(storageKey("mobile.view.agent"), "terminal");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens on the draft this tab was left holding, and writes back what was typed when the screen goes away", async () => {
    writeDraft(TAB.id, "the paragraph I left to fetch");
    const view = render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const field = screen.getByLabelText("Message agent") as HTMLTextAreaElement;
    expect(field.value).toBe("the paragraph I left to fetch");

    fireEvent.change(field, { target: { value: "the paragraph I left to fetch, finished" } });
    // Leaving for the tab list is an unmount, and it flushes what the save
    // delay still owes — without that the last words typed on the way out are
    // the ones lost.
    view.unmount();
    expect(readDraft(TAB.id)).toBe("the paragraph I left to fetch, finished");
  });

  it("writes the draft a moment after the typing stops, without waiting for the screen to close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      render(<Terminal tab={TAB} back={() => {}} />);
      await act(async () => { await Promise.resolve(); });
      fireEvent.change(screen.getByLabelText("Message agent"), { target: { value: "still typing" } });
      expect(readDraft(TAB.id)).toBe("");
      act(() => { vi.advanceTimersByTime(DRAFT_SAVE_DELAY); });
      expect(readDraft(TAB.id)).toBe("still typing");
    } finally {
      vi.useRealTimers();
    }
  });
});
