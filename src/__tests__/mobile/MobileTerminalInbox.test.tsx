import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalState = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = {
      active: {
        get length() { return terminalState.lines.length; },
        getLine(row: number) {
          const value = terminalState.lines[row];
          return value == null ? undefined : { isWrapped: false, translateToString: () => value };
        },
      },
    };
    loadAddon() {}
    open() {}
    write(value: Uint8Array, callback?: () => void) {
      terminalState.lines = new TextDecoder().decode(value).split("\n");
      callback?.();
    }
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
import { BRAND, NAMES, storageKey } from "../../lib/brand";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, available: true, viewer_busy: false };

/** Repaints the session with `screen` and lets the reading view rebuild. */
async function paint(screenText: string) {
  const bytes = new TextEncoder().encode(screenText);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
}

const settle = (ms: number) => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, ms)); });

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The outbox poll, the stored-session read, the usage read, the markup
 * questions poll and the inbox previews' description the screen runs answer
 * empty here and stay out of the counted calls — these tests are about the
 * inbox drop. */
function routeOutbox(inner: (url: string, init?: RequestInit) => Promise<Response>) {
  return (url: string, init?: RequestInit) => url.endsWith("/outbox") || url.includes("/inbox?names=")
    ? Promise.resolve(jsonResponse(200, { images: [], files: [] }))
    : url.includes("/transcript")
      ? Promise.resolve(jsonResponse(200, { transcript: { available: false, reason: "no_session", entries: [], truncated: false } }))
      : url.endsWith("/status") || url.includes("/markup/questions")
        ? Promise.resolve(jsonResponse(503, { error: "desktop_unavailable" }))
        : inner(url, init);
}

const fileInput = () => screen.getByTestId("inbox-file-input") as HTMLInputElement;
const composer = () => screen.getByLabelText("Message agent") as HTMLTextAreaElement;

/** The landed files waiting beside the composer, by their thumbnail's name. */
const landed = () => Array.from(document.querySelectorAll(".composer-thumb:not(.sending)")).map((thumb) => thumb.getAttribute("title") ?? "");
/** The files still on their way, likewise. */
const sending = () => Array.from(document.querySelectorAll(".composer-thumb.sending")).map((thumb) => thumb.getAttribute("title") ?? "");
/** The prompt the phone reported as sent — the words that went out. */
const reportedPrompt = (fetchMock: ReturnType<typeof vi.fn>) => {
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/prompt"));
  return call ? (JSON.parse(String((call[1] as RequestInit).body)) as { message: string }).message : undefined;
};

function pick(files: File[]) {
  const input = fileInput();
  Object.defineProperty(input, "files", { configurable: true, value: files });
  fireEvent.change(input);
}

describe(`${BRAND.display} Mobile composer + and the frozen reading view`, () => {
  beforeEach(() => {
    // The composer's draft is kept on the phone now (`drafts.ts`), and the
    // unmount that flushes it runs in Testing Library's own cleanup — after this
    // file's `afterEach` — so the slate is wiped here rather than there.
    localStorage.clear();
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    // These read the Focus view; the phone opens on Terminal until the
    // reader chose Focus for the agent, so the stored choice is preset.
    localStorage.setItem(storageKey("mobile.view.agent"), "focus");
    localStorage.setItem(storageKey("mobile.view.shell"), "focus");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers the phone's files and a project @ from the +", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});

    fireEvent.click(screen.getByRole("button", { name: "Add to the message" }));
    const sheet = screen.getByRole("dialog", { name: "Add to the message" });
    expect(sheet.textContent).toContain("From this phone");
    expect(sheet.textContent).toContain("A project file (@)");

    // The project option is the old +: an @ into the draft, no sheet left up.
    fireEvent.click(screen.getByRole("button", { name: /A project file/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(composer().value).toBe("@");

    // The phone option opens the native picker — the hidden file input.
    fireEvent.click(screen.getByRole("button", { name: "Add to the message" }));
    fireEvent.click(screen.getByRole("button", { name: /From this phone/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(click).toHaveBeenCalledTimes(1);
    expect(fileInput().multiple).toBe(true);
  });

  it("offers the gallery as its own entry: a media-only picker over the same inbox drop", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, {
      attachment: { name: "20260917-120000-IMG_0099.jpg", reference: `${NAMES.inboxDir}/20260917-120000-IMG_0099.jpg`, size: 3 },
    }));
    vi.stubGlobal("fetch", routeOutbox(fetchMock));
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    const gallery = screen.getByTestId("inbox-gallery-input") as HTMLInputElement;
    const click = vi.spyOn(gallery, "click").mockImplementation(() => {});

    fireEvent.click(screen.getByRole("button", { name: "Add to the message" }));
    fireEvent.click(screen.getByRole("button", { name: /From the gallery/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(click).toHaveBeenCalledTimes(1);
    // The media `accept` is what opens the photo picker rather than the file browser.
    expect(gallery.accept).toBe("image/*,video/*");
    expect(gallery.multiple).toBe(true);
    // "From this phone" names non-media types too, or Android offers only the
    // camera and the photo picker — no way into the phone's files.
    expect(fileInput().accept).toContain("application/*");

    Object.defineProperty(gallery, "files", { configurable: true, value: [new File(["abc"], "IMG_0099.jpg", { type: "image/jpeg" })] });
    fireEvent.change(gallery);
    await settle(0);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/v1/tabs/tab-7/inbox?name=IMG_0099.jpg");
    expect(landed().some((text) => text.includes("IMG_0099.jpg"))).toBe(true);
  });

  it("sends a picked file into the project inbox and puts the desktop's reference after the message on Send", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, {
      attachment: { name: "20260831-120000-IMG_0042.jpg", reference: `${NAMES.inboxDir}/20260831-120000-IMG_0042.jpg`, size: 3 },
    }));
    vi.stubGlobal("fetch", routeOutbox(fetchMock));
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    fireEvent.change(composer(), { target: { value: "look at this" } });

    pick([new File(["abc"], "IMG_0042.jpg", { type: "image/jpeg" })]);
    expect(sending()).toEqual(["IMG_0042.jpg"]);
    await settle(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/tabs/tab-7/inbox?name=IMG_0042.jpg");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/jpeg");
    expect(init.body).toBeInstanceOf(File);

    // Delivered: the draft is left alone — the reader may still be typing —
    // and the file waits as a thumbnail beside it, never as `@` text in it.
    expect(composer().value).toBe("look at this");
    expect(landed()).toHaveLength(1);
    expect(landed()[0]).toContain("IMG_0042.jpg");
    // The picker is reset so the same photo can be picked again.
    expect(fileInput().value).toBe("");

    fireEvent.change(composer(), { target: { value: "look at this, the left one" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle(0);
    expect(reportedPrompt(fetchMock)).toBe(`look at this, the left one @${NAMES.inboxDir}/20260831-120000-IMG_0042.jpg `);
    expect(composer().value).toBe("");
    expect(landed()).toHaveLength(0);
  });

  it("never touches the draft while a file is on its way, and holds Send until it lands", async () => {
    let answer: (response: Response) => void = () => {};
    const fetchMock = vi.fn((url: string) => url.includes("/inbox?")
      ? new Promise<Response>((resolve) => { answer = resolve; })
      : Promise.resolve(jsonResponse(200, {})));
    vi.stubGlobal("fetch", routeOutbox(fetchMock));
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});

    pick([new File(["abc"], "plan.pdf", { type: "application/pdf" })]);
    fireEvent.change(composer(), { target: { value: "half a sent" } });
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    // Enter does not slip past the disabled button either.
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(reportedPrompt(fetchMock)).toBeUndefined();

    await act(async () => {
      answer(jsonResponse(201, { attachment: { name: "20261002-090000-plan.pdf", reference: `${NAMES.inboxDir}/20261002-090000-plan.pdf`, size: 3 } }));
    });
    await settle(0);
    expect(composer().value).toBe("half a sent");
    expect(send.disabled).toBe(false);

    // ✕ leaves a landed file out of the message; the words alone still go.
    fireEvent.click(screen.getByRole("button", { name: "Leave plan.pdf out of the message" }));
    expect(landed()).toHaveLength(0);
    fireEvent.click(send);
    await settle(0);
    expect(reportedPrompt(fetchMock)).toBe("half a sent");
  });

  it("keeps a landed file with the saved draft and brings it back as a thumbnail, not as @ text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, {
      attachment: { name: "20261002-090000-a.png", reference: `${NAMES.inboxDir}/20261002-090000-a.png`, size: 3 },
    }));
    vi.stubGlobal("fetch", routeOutbox(fetchMock));
    const view = render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    fireEvent.change(composer(), { target: { value: "see" } });
    pick([new File(["abc"], "a.png", { type: "image/png" })]);
    await settle(0);
    view.unmount();

    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    expect(composer().value).toBe("see ");
    expect(landed()).toEqual(["a.png"]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle(0);
    expect(reportedPrompt(fetchMock)).toBe(`see @${NAMES.inboxDir}/20261002-090000-a.png `);
  });

  it("reports a refused or oversized file and keeps the draft untouched", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(507, { error: "inbox_full" }));
    vi.stubGlobal("fetch", routeOutbox(fetchMock));
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});

    const huge = new File([""], "movie.mp4", { type: "video/mp4" });
    Object.defineProperty(huge, "size", { value: 24 * 1024 * 1024 + 1 });
    pick([huge, new File(["abc"], "notes.txt", { type: "text/plain" })]);
    await settle(0);

    // The oversized one never left the phone.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // (The voice-unavailable notice is also an alert in jsdom; count only ours.)
    const failed = () => Array.from(document.querySelectorAll(".inbox-upload.error")).map((row) => row.textContent ?? "");
    expect(failed().some((text) => text.includes("movie.mp4") && text.includes("larger than 24 MB"))).toBe(true);
    expect(failed().some((text) => text.includes("notes.txt") && text.includes("inbox is full"))).toBe(true);
    expect(composer().value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss movie.mp4" }));
    expect(failed()).toHaveLength(1);
    expect(failed()[0]).toContain("notes.txt");
  });

  it("lists the desktop's images from the + and attaches one by its opaque id", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { images: [
        { id: "clipboard", name: "Clipboard image", source: "Clipboard", width: 1920, height: 1080 },
        { id: "0123456789abcdef0123456789abcdef", name: "Screenshot_2026-09-03.png", source: "Screenshots", size: 1_300_000, age_secs: 200 },
      ] }))
      .mockResolvedValueOnce(jsonResponse(201, {
        attachment: { name: "20260903-100000-Screenshot_2026-09-03.png", reference: `${NAMES.inboxDir}/20260903-100000-Screenshot_2026-09-03.png`, size: 1_300_000 },
      }));
    vi.stubGlobal("fetch", routeOutbox(fetchMock));
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    fireEvent.change(composer(), { target: { value: "fix this" } });

    fireEvent.click(screen.getByRole("button", { name: "Add to the message" }));
    expect(screen.getByRole("dialog", { name: "Add to the message" }).textContent).toContain("From the desktop");
    fireEvent.click(screen.getByRole("button", { name: /From the desktop/ }));
    // The list is asked for as the sheet opens, and the sheet says so.
    const sheet = screen.getByRole("dialog", { name: "From the desktop" });
    expect(sheet.textContent).toContain("Looking on the desktop…");
    await settle(0);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/tabs/tab-7/desktop-images");
    expect(sheet.textContent).toContain("Clipboard image");
    expect(sheet.textContent).toContain("Clipboard · 1920×1080");
    expect(sheet.textContent).toContain("Screenshots · 3 min ago · 1.2 MB");

    fireEvent.click(screen.getByRole("button", { name: /Screenshot_2026-09-03\.png/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // A pending thumbnail names the file while the desktop copies it.
    expect(sending()).toEqual(["Screenshot_2026-09-03.png"]);
    expect(screen.getByRole("status").textContent).toContain("Copying from the desktop");
    await settle(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/v1/tabs/tab-7/desktop-images");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ image_id: "0123456789abcdef0123456789abcdef" });
    expect(composer().value).toBe("fix this");
    expect(landed().some((text) => text.includes("Screenshot_2026-09-03.png"))).toBe(true);
  });

  it("says when the desktop has nothing to attach, and names a copy that failed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { images: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { images: [{ id: "clipboard", name: "Clipboard image", source: "Clipboard" }] }))
      .mockResolvedValueOnce(jsonResponse(409, { error: "no_clipboard_image" }));
    vi.stubGlobal("fetch", routeOutbox(fetchMock));
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Add to the message" }));
    fireEvent.click(screen.getByRole("button", { name: /From the desktop/ }));
    await settle(0);
    expect(screen.getByRole("dialog", { name: "From the desktop" }).textContent).toContain("Nothing to attach");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    // Re-opening asks again: the clipboard has an image now, but it is gone
    // again by the time the desktop goes to copy it.
    fireEvent.click(screen.getByRole("button", { name: "Add to the message" }));
    fireEvent.click(screen.getByRole("button", { name: /From the desktop/ }));
    await settle(0);
    fireEvent.click(screen.getByRole("button", { name: /Clipboard image/ }));
    await settle(0);
    const failed = Array.from(document.querySelectorAll(".inbox-upload.error")).map((row) => row.textContent ?? "");
    expect(failed.some((text) => text.includes("Clipboard image") && text.includes("no longer holds an image"))).toBe(true);
    expect(composer().value).toBe("");
  });

  it("holds the reading view still while a composer sheet is up and resumes when it closes", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    await paint("Earlier answer\n> \n? for shortcuts");
    expect(screen.getByText("Earlier answer")).toBeTruthy();

    // Claude's silent default earns the mode sheet from the label alone.
    fireEvent.click(screen.getByTitle("Choose the permission mode"));
    expect(screen.getByRole("dialog", { name: "Permission mode" })).toBeTruthy();

    // The session repaints under the sheet; the reading view does not follow.
    await paint("Earlier answer\nLater answer\n> \nplan mode on (shift+tab to cycle)");
    expect(screen.queryByText("Later answer")).toBeNull();
    // …but the sheet read the live screen: Plan is now the current mode.
    const plan = screen.getAllByRole("button").find((button) => button.querySelector("strong")?.textContent === "Plan");
    expect(plan?.getAttribute("aria-current")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Later answer")).toBeTruthy();
    // The input box and the status line under it are the composer's own job:
    // the chips carry those facts, so the reading view never paints them.
    expect(screen.queryByText("plan mode on (shift+tab to cycle)")).toBeNull();
  });
});
