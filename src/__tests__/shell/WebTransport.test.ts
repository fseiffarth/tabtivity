/**
 * The browser desktop client's transport (hosted plan §3.5, §11 "the shim
 * against a fake daemon"): the `__TAURI_INTERNALS__` shim over `WsClient`,
 * driven through a fake socket that plays the server's half of the protocol.
 *
 * The last block drives the INSTALLED `@tauri-apps/api` (`core`, `event`,
 * `window`, `webview`) and `@tauri-apps/plugin-dialog`/`-notification` JS
 * through the shim, so an upstream rename of a command or an argument key
 * fails here (`docs/third_party_update_checklist.md`, the API internals row).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen, once } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { availableMonitors, currentMonitor, getAllWindows, getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";
import { ask, confirm, message, open, save } from "@tauri-apps/plugin-dialog";
import { DisconnectedError, linkState, resetLinkStateForTests } from "../../lib/transport/linkState";
import { KIND_CALL, KIND_RET, WsClient, type SocketLike } from "../../lib/transport/wsClient";
import { WsInternals } from "../../lib/transport/wsInternals";
import { pausePollersWhileDown, socketUrl } from "../../lib/transport/installWeb";
import { setDialogAdapter } from "../../lib/transport/dialogAdapter";
import { registerDict, useI18nStore } from "../../lib/i18n";
import { dict as de } from "../../lib/i18nDicts/de";

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: (string | Uint8Array)[] = [];
  constructor(public url: string, public protocol: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string | ArrayBuffer | Uint8Array) {
    this.sent.push(typeof data === "string" ? data : data instanceof Uint8Array ? data : new Uint8Array(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  // ── the server's half ──
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  hello(client = "web-1") {
    this.onmessage?.({ data: JSON.stringify({ t: "hello", client, protocol: 1, capabilities: { protocol: 1, hostOs: "linux", role: "admin", commands: [] } }) });
  }
  text(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  binaryRet(id: number, bytes: Uint8Array) {
    const frame = new Uint8Array(5 + bytes.byteLength);
    frame[0] = KIND_RET;
    new DataView(frame.buffer).setUint32(1, id);
    frame.set(bytes, 5);
    this.onmessage?.({ data: frame.buffer });
  }
  textFrames(): Record<string, unknown>[] {
    return this.sent.filter((f): f is string => typeof f === "string").map((f) => JSON.parse(f));
  }
}

function connected() {
  const scheduled: Array<() => void> = [];
  const client = new WsClient({
    url: "ws://127.0.0.1:8742/api/v1/desktop/ws",
    protocol: "x-desktop.v1",
    socket: (url, protocol) => new FakeSocket(url, protocol),
    schedule: (fn) => void scheduled.push(fn),
  });
  const internals = new WsInternals(client);
  client.connect();
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  socket.open();
  socket.hello();
  const invoke = internals.internals().invoke as (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
  return { client, internals, socket, invoke, scheduled };
}

beforeEach(() => {
  FakeSocket.instances = [];
  resetLinkStateForTests();
});

/** Undo for `installed()`: the test setup's stub internals come back. */
let restoreInternals: (() => void) | null = null;

afterEach(() => {
  setDialogAdapter(null);
  restoreInternals?.();
  restoreInternals = null;
});

/** `connected()`, with the shim where the real `@tauri-apps/*` JS looks for it
 *  (`installWsInternals` does the same on the page). */
function installed() {
  const link = connected();
  const w = window as unknown as Record<string, unknown>;
  const saved = [w.__TAURI_INTERNALS__, w.__TAURI_EVENT_PLUGIN_INTERNALS__];
  w.__TAURI_INTERNALS__ = link.internals.internals();
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = link.internals.eventInternals();
  restoreInternals = () => {
    [w.__TAURI_INTERNALS__, w.__TAURI_EVENT_PLUGIN_INTERNALS__] = saved;
  };
  return link;
}

/** A dialog adapter that records what reached it and answers `answer`. */
function recordingDialogs(answer = true) {
  const calls: unknown[][] = [];
  setDialogAdapter({
    open: (options) => (calls.push(["open", options]), Promise.resolve(["/srv/a.pdf"])),
    save: (options) => (calls.push(["save", options]), Promise.resolve("/srv/out.vcf")),
    confirm: (text, options) => (calls.push(["confirm", text, options]), Promise.resolve(answer)),
    message: (text, options) => (calls.push(["message", text, options]), Promise.resolve()),
  });
  return calls;
}

describe("the browser transport", () => {
  it("offers the subprotocol, waits for hello, and is up", async () => {
    const { client, socket } = connected();
    expect(socket.protocol).toBe("x-desktop.v1");
    expect(client.up).toBe(true);
    expect(client.clientId).toBe("web-1");
    expect(linkState()).toBe("up");
    expect((await client.whenReady()).capabilities.hostOs).toBe("linux");
  });

  it("sends a call frame and resolves or rejects by id", async () => {
    const { socket, invoke } = connected();
    const ok = invoke("agent_is_installed", { id: "claude" });
    const bad = invoke("pty_write", { id: "p", data: new Uint8Array([104, 105]) });
    const [first, second] = socket.textFrames();
    expect(first).toEqual({ t: "call", id: 1, cmd: "agent_is_installed", args: { id: "claude" } });
    // Bytes in arguments travel as arrays, as Tauri's own IPC sends them.
    expect(second.args).toEqual({ id: "p", data: [104, 105] });
    socket.text({ t: "ret", id: 2, err: "no such pty" });
    socket.text({ t: "ret", id: 1, ok: true });
    await expect(ok).resolves.toBe(true);
    await expect(bad).rejects.toBe("no such pty");
  });

  it("refuses client and off commands locally, by the generated class table", async () => {
    const { socket, invoke } = connected();
    await expect(invoke("capture_screenshot", {})).rejects.toMatchObject({ code: "client", command: "capture_screenshot" });
    await expect(invoke("save_settings", {})).rejects.toMatchObject({ code: "off", reason: "whole-document-save" });
    expect(socket.textFrames()).toEqual([]);
    // A client command with a browser form is answered here.
    await expect(invoke("list_recent_downloads", { paths: [] })).resolves.toEqual([]);
  });

  it("subscribes once per event name and delivers to every listener", async () => {
    const { internals, socket, invoke } = connected();
    const seen: unknown[] = [];
    const a = internals.transformCallback((e) => seen.push(["a", (e as { payload: unknown }).payload]), false);
    const b = internals.transformCallback((e) => seen.push(["b", (e as { payload: unknown }).payload]), false);
    await invoke("plugin:event|listen", { event: "workspace:patch", target: { kind: "Any" }, handler: a });
    await invoke("plugin:event|listen", { event: "workspace:patch", target: { kind: "Any" }, handler: b });
    expect(socket.textFrames()).toEqual([{ t: "sub", name: "workspace:patch" }]);
    socket.text({ t: "event", name: "workspace:patch", payload: { v: 2 } });
    expect(seen).toEqual([["a", { v: 2 }], ["b", { v: 2 }]]);
    await invoke("plugin:event|unlisten", { event: "workspace:patch", eventId: a });
    expect(socket.textFrames().filter((f: Record<string, unknown>) => f.t === "unsub")).toEqual([]);
    (internals.eventInternals().unregisterListener as (e: string, id: number) => void)("workspace:patch", b);
    expect(socket.textFrames().filter((f: Record<string, unknown>) => f.t === "unsub")).toEqual([{ t: "unsub", name: "workspace:patch" }]);
    socket.text({ t: "event", name: "workspace:patch", payload: { v: 3 } });
    expect(seen).toHaveLength(2);
  });

  it("a frontend emit reaches this page's listeners and the server", async () => {
    const { internals, socket, invoke } = connected();
    const seen: unknown[] = [];
    const id = internals.transformCallback((e) => seen.push((e as { payload: unknown }).payload), false);
    await invoke("plugin:event|listen", { event: "detached-seed", target: { kind: "Any" }, handler: id });
    await invoke("plugin:event|emit", { event: "detached-seed", payload: { key: 1 } });
    expect(seen).toEqual([{ key: 1 }]);
    const frames = socket.textFrames();
    expect(frames[frames.length - 1]).toEqual({ t: "emit", name: "detached-seed", payload: { key: 1 } });
  });

  it("carries a bytes body as a binary frame and a raw answer back as an ArrayBuffer", async () => {
    const { socket, invoke } = connected();
    const write = invoke("write_file_bytes", new Uint8Array([1, 2, 3]), { headers: { "x-path": "%2Ftmp%2Fa" } });
    const frame = socket.sent[0] as Uint8Array;
    expect(frame[0]).toBe(KIND_CALL);
    const view = new DataView(frame.buffer, frame.byteOffset);
    const id = view.getUint32(1);
    const hlen = view.getUint32(5);
    const header = JSON.parse(new TextDecoder().decode(frame.slice(9, 9 + hlen)));
    expect(header).toEqual({ cmd: "write_file_bytes", headers: { "x-path": "%2Ftmp%2Fa" } });
    expect([...frame.slice(9 + hlen)]).toEqual([1, 2, 3]);
    socket.text({ t: "ret", id, ok: null });
    await expect(write).resolves.toBeNull();

    const read = invoke("read_file_bytes", { path: "/tmp/a", projectId: null });
    const sentFrames = socket.textFrames();
    const readId = (sentFrames[sentFrames.length - 1] as { id: number }).id;
    socket.binaryRet(readId, new Uint8Array([9, 8]));
    const out = (await read) as ArrayBuffer;
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(out)]).toEqual([9, 8]);
  });

  it("rejects pending and new calls while down, then resumes with its id and its subscriptions", async () => {
    const { client, socket, invoke, scheduled } = connected();
    await invoke("plugin:event|listen", { event: "terminal-output", target: { kind: "Any" }, handler: 1 });
    const pending = invoke("pty_scrollback", { id: "p" });
    socket.close();
    expect(linkState()).toBe("down");
    await expect(pending).rejects.toBeInstanceOf(DisconnectedError);
    await expect(invoke("pty_write", { id: "p", data: [] })).rejects.toMatchObject({ code: "disconnected" });
    expect(client.up).toBe(false);
    // The backoff timer fires: a new socket, asking to resume the old id.
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    const next = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(next).not.toBe(socket);
    expect(next.url).toBe("ws://127.0.0.1:8742/api/v1/desktop/ws?resume=web-1");
    expect(linkState()).toBe("connecting");
    next.open();
    next.hello("web-1");
    expect(linkState()).toBe("up");
    expect(next.textFrames()).toEqual([{ t: "sub", name: "terminal-output" }]);
  });

  it("close() settles in-flight calls and ready waiters itself, before the socket's late onclose", async () => {
    // A real WebSocket fires `onclose` asynchronously, after `close()` has
    // already dropped the socket: hold it back the way the browser does.
    const { client, socket, invoke, scheduled } = connected();
    let lateClose: (() => void) | null = null;
    socket.close = () => {
      socket.readyState = 3;
      lateClose = () => socket.onclose?.({});
    };
    const pending = invoke("pty_scrollback", { id: "p" });
    const raw = client.callRaw("write_file_bytes", { path: "/srv/a" }, new Uint8Array([1]));
    client.close();
    await expect(pending).rejects.toBeInstanceOf(DisconnectedError);
    await expect(raw).rejects.toBeInstanceOf(DisconnectedError);
    expect(client.up).toBe(false);
    expect(client.hello).toBeNull();
    expect(linkState()).toBe("down");
    // A waiter registered while closed is refused at once, not parked forever.
    await expect(client.whenReady()).rejects.toBeInstanceOf(DisconnectedError);
    // The late onclose and a late frame on the dropped socket change nothing.
    lateClose!();
    socket.hello();
    expect(client.hello).toBeNull();
    expect(linkState()).toBe("down");
    expect(scheduled).toHaveLength(0);
  });

  it("close() rejects a whenReady() waiting for the first hello", async () => {
    const client = new WsClient({
      url: "ws://127.0.0.1:8742/api/v1/desktop/ws",
      protocol: "x-desktop.v1",
      socket: (url, protocol) => {
        const socket = new FakeSocket(url, protocol);
        socket.close = () => {
          socket.readyState = 3;
        };
        return socket;
      },
      schedule: () => {},
    });
    client.connect();
    const ready = client.whenReady();
    client.close();
    await expect(ready).rejects.toBeInstanceOf(DisconnectedError);
  });

  it("pauses interval pollers while the link is down", () => {
    const { socket, scheduled } = connected();
    vi.useFakeTimers();
    const target = { setInterval: globalThis.setInterval.bind(globalThis) } as unknown as Pick<Window, "setInterval">;
    pausePollersWhileDown(target);
    const ticks = vi.fn();
    target.setInterval(ticks, 100);
    vi.advanceTimersByTime(250);
    expect(ticks).toHaveBeenCalledTimes(2);
    socket.close();
    vi.advanceTimersByTime(300);
    expect(ticks).toHaveBeenCalledTimes(2);
    scheduled[0]();
    const next = FakeSocket.instances[FakeSocket.instances.length - 1];
    next.open();
    next.hello();
    vi.advanceTimersByTime(100);
    expect(ticks).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("answers the dialog plugin with the pressed button's label, as plugin-dialog expects", async () => {
    const { invoke } = connected();
    const asked: unknown[] = [];
    setDialogAdapter({
      open: () => Promise.resolve(["/srv/a.pdf"]),
      save: () => Promise.resolve("/srv/out.vcf"),
      confirm: (message, options) => {
        asked.push([message, options.okLabel, options.cancelLabel]);
        return Promise.resolve(true);
      },
      message: () => Promise.resolve(),
    });
    await expect(invoke("plugin:dialog|open", { options: { multiple: true } })).resolves.toEqual(["/srv/a.pdf"]);
    await expect(invoke("plugin:dialog|save", { options: {} })).resolves.toBe("/srv/out.vcf");
    // `confirm()` compares the answer with "Ok"; `ask()` with "Yes".
    await expect(invoke("plugin:dialog|message", { message: "Sure?", buttons: "OkCancel" })).resolves.toBe("Ok");
    await expect(invoke("plugin:dialog|message", { message: "Really?", buttons: "YesNo" })).resolves.toBe("Yes");
    await expect(invoke("plugin:dialog|message", { message: "Custom", buttons: { OkCancelCustom: ["Go", "Stay"] } })).resolves.toBe("Go");
    await expect(invoke("plugin:dialog|message", { message: "Note", buttons: "Ok" })).resolves.toBe("Ok");
    expect(asked).toEqual([["Sure?", "OK", "Cancel"], ["Really?", "Yes", "No"], ["Custom", "Go", "Stay"]]);
  });

  it("shows the default dialog buttons in the app language, answering with the plugin's English tokens", async () => {
    const { invoke } = connected();
    const asked: unknown[] = [];
    setDialogAdapter({
      open: () => Promise.resolve(null),
      save: () => Promise.resolve(null),
      confirm: (message, options) => {
        asked.push([message, options.okLabel, options.cancelLabel]);
        return Promise.resolve(false);
      },
      message: () => Promise.resolve(),
    });
    registerDict("de", de);
    const before = useI18nStore.getState().lang;
    useI18nStore.setState({ lang: "de" });
    try {
      // Declined: the answer is the cancel TOKEN `ask`/`confirm` compare against.
      await expect(invoke("plugin:dialog|message", { message: "Sicher?", buttons: "YesNo" })).resolves.toBe("No");
      await expect(invoke("plugin:dialog|message", { message: "Wirklich?", buttons: "OkCancel" })).resolves.toBe("Cancel");
    } finally {
      useI18nStore.setState({ lang: before });
    }
    expect(asked).toEqual([["Sicher?", "Ja", "Nein"], ["Wirklich?", "OK", "Abbrechen"]]);
  });

  it("answers the window plugin for the one page it is", async () => {
    const { invoke } = connected();
    await expect(invoke("plugin:window|get_all_windows")).resolves.toEqual(["main"]);
    await expect(invoke("plugin:window|is_maximized", { label: "main" })).resolves.toBe(true);
    await expect(invoke("plugin:window|maximize", { label: "main" })).resolves.toBeUndefined();
    const { internals } = connected();
    const metadata = internals.internals().metadata as { currentWindow: { label: string }; currentWebview: { label: string } };
    expect(metadata.currentWindow.label).toBe("main");
    expect(metadata.currentWebview.label).toBe("main");
  });

  it("derives the socket URL from the page it was served from", () => {
    expect(socketUrl({ protocol: "http:", host: "127.0.0.1:8742" })).toBe("ws://127.0.0.1:8742/api/v1/desktop/ws");
    expect(socketUrl({ protocol: "https:", host: "desk.example.ts.net" })).toBe("wss://desk.example.ts.net/api/v1/desktop/ws");
  });
});

describe("the installed @tauri-apps JS through the shim", () => {
  it("core: invoke reaches the server as a call frame, a bytes body as a binary frame", async () => {
    const { socket } = installed();
    const named = tauriInvoke("agent_is_installed", { id: "claude" });
    const bare = tauriInvoke("server_capabilities");
    expect(socket.textFrames()).toEqual([
      { t: "call", id: 1, cmd: "agent_is_installed", args: { id: "claude" } },
      { t: "call", id: 2, cmd: "server_capabilities", args: {} },
    ]);
    socket.text({ t: "ret", id: 1, ok: true });
    socket.text({ t: "ret", id: 2, ok: { protocol: 1 } });
    await expect(named).resolves.toBe(true);
    await expect(bare).resolves.toEqual({ protocol: 1 });

    const write = tauriInvoke("write_file_bytes", new Uint8Array([7]), { headers: new Headers({ "X-Path": "%2Ftmp%2Fa" }) });
    const frame = socket.sent[socket.sent.length - 1] as Uint8Array;
    expect(frame[0]).toBe(KIND_CALL);
    const view = new DataView(frame.buffer, frame.byteOffset);
    const hlen = view.getUint32(5);
    expect(JSON.parse(new TextDecoder().decode(frame.slice(9, 9 + hlen)))).toEqual({ cmd: "write_file_bytes", headers: { "x-path": "%2Ftmp%2Fa" } });
    expect([...frame.slice(9 + hlen)]).toEqual([7]);
    socket.text({ t: "ret", id: view.getUint32(1), ok: null });
    await expect(write).resolves.toBeNull();
  });

  it("event: listen subscribes once, delivers Tauri's event shape, and its unlisten unsubscribes", async () => {
    const { socket } = installed();
    const seen: unknown[] = [];
    const first = await listen<{ v: number }>("workspace:patch", (event) => seen.push(["a", event.event, event.payload]));
    const second = await listen<{ v: number }>("workspace:patch", (event) => seen.push(["b", typeof event.id, event.payload]), { target: "main" });
    expect(socket.textFrames()).toEqual([{ t: "sub", name: "workspace:patch" }]);
    socket.text({ t: "event", name: "workspace:patch", payload: { v: 1 } });
    expect(seen).toEqual([["a", "workspace:patch", { v: 1 }], ["b", "number", { v: 1 }]]);
    await first();
    expect(socket.textFrames().filter((f) => f.t === "unsub")).toEqual([]);
    await second();
    expect(socket.textFrames().filter((f) => f.t === "unsub")).toEqual([{ t: "unsub", name: "workspace:patch" }]);
    socket.text({ t: "event", name: "workspace:patch", payload: { v: 2 } });
    expect(seen).toHaveLength(2);
  });

  it("event: once hears one event, then lets its subscription go", async () => {
    const { socket } = installed();
    const seen: unknown[] = [];
    await once<string>("pty-exit", (event) => seen.push(event.payload));
    socket.text({ t: "event", name: "pty-exit", payload: "first" });
    await Promise.resolve();
    socket.text({ t: "event", name: "pty-exit", payload: "second" });
    expect(seen).toEqual(["first"]);
    expect(socket.textFrames()).toEqual([{ t: "sub", name: "pty-exit" }, { t: "unsub", name: "pty-exit" }]);
  });

  it("event: emit and emitTo reach this page's listeners and the server", async () => {
    const { socket } = installed();
    const seen: unknown[] = [];
    await listen("detached-seed", (event) => seen.push(event.payload));
    await emit("detached-seed", { key: 1 });
    await emitTo("main", "detached-seed", { key: 2 });
    expect(seen).toEqual([{ key: 1 }, { key: 2 }]);
    expect(socket.textFrames().filter((f) => f.t === "emit")).toEqual([
      { t: "emit", name: "detached-seed", payload: { key: 1 } },
      { t: "emit", name: "detached-seed", payload: { key: 2 } },
    ]);
  });

  it("window: answers the one page it is, locally", async () => {
    const { socket } = installed();
    const win = getCurrentWindow();
    expect(win.label).toBe("main");
    expect((await getAllWindows()).map((w) => w.label)).toEqual(["main"]);
    await expect(win.isMaximized()).resolves.toBe(true);
    await expect(win.isMinimized()).resolves.toBe(false);
    await expect(win.scaleFactor()).resolves.toBe(window.devicePixelRatio || 1);
    await expect(win.maximize()).resolves.toBeUndefined();
    expect(getCurrentWebview().label).toBe("main");
    expect(socket.textFrames()).toEqual([]);
  });

  it("window: sizes, positions and monitors answer in the shapes window.js reads", async () => {
    installed();
    const win = getCurrentWindow();
    const scale = window.devicePixelRatio || 1;
    const size = await win.outerSize();
    expect([size.width, size.height]).toEqual([Math.round(window.innerWidth * scale), Math.round(window.innerHeight * scale)]);
    expect((await win.innerSize()).width).toBe(size.width);
    const outer = await win.outerPosition();
    const inner = await win.innerPosition();
    expect([outer.x, outer.y, inner.x, inner.y]).toEqual([0, 0, 0, 0]);
    // A page knows no monitors: "none" is an answer window.js can map.
    await expect(currentMonitor()).resolves.toBeNull();
    await expect(primaryMonitor()).resolves.toBeNull();
    await expect(availableMonitors()).resolves.toEqual([]);
  });

  it("window/webview: title, fullscreen and zoom read the keys window.js and webview.js send", async () => {
    installed();
    // jsdom has no Fullscreen API.
    const root = document.documentElement as unknown as { requestFullscreen?: () => Promise<void>; style: CSSStyleDeclaration };
    const request = vi.fn(() => Promise.resolve());
    root.requestFullscreen = request;
    const savedTitle = document.title;
    try {
      await getCurrentWindow().setTitle("Board");
      expect(document.title).toBe("Board");
      await getCurrentWindow().setFullscreen(true);
      expect(request).toHaveBeenCalledTimes(1);
      await getCurrentWebview().setZoom(1.25);
      expect(root.style.getPropertyValue("zoom")).toBe("1.25");
    } finally {
      document.title = savedTitle;
      delete root.requestFullscreen;
      root.style.removeProperty("zoom");
    }
  });

  it("notification: the list calls answer under the names the installed plugin sends", async () => {
    const { socket } = installed();
    const { active, channels, pending } = await import("@tauri-apps/plugin-notification");
    await expect(channels()).resolves.toEqual([]);
    await expect(pending()).resolves.toEqual([]);
    await expect(active()).resolves.toEqual([]);
    expect(socket.textFrames()).toEqual([]);
  });

  it("plugin-dialog: open and save hand their options to the server-side picker", async () => {
    const { socket } = installed();
    const calls = recordingDialogs();
    const filters = [{ name: "PDF", extensions: ["pdf"] }];
    await expect(open({ multiple: true, directory: false, filters })).resolves.toEqual(["/srv/a.pdf"]);
    await expect(save({ defaultPath: "/srv/out.vcf", filters })).resolves.toBe("/srv/out.vcf");
    expect(calls).toEqual([
      ["open", { multiple: true, directory: false, filters }],
      ["save", { defaultPath: "/srv/out.vcf", filters }],
    ]);
    expect(socket.textFrames()).toEqual([]);
  });

  it("plugin-dialog: message, ask and confirm keep their text, title, kind and button labels", async () => {
    installed();
    const calls = recordingDialogs(true);
    await expect(message("Saved", { title: "Export", kind: "info" })).resolves.toBe("Ok");
    await expect(message("Done", { okLabel: "Got it" })).resolves.toBe("Got it");
    await expect(ask("Really?", { title: "Remove", kind: "warning" })).resolves.toBe(true);
    await expect(confirm("Sure?")).resolves.toBe(true);
    await expect(confirm("Delete it?", { okLabel: "Delete", cancelLabel: "Keep" })).resolves.toBe(true);
    expect(calls).toEqual([
      ["message", "Saved", { title: "Export", kind: "info", okLabel: "OK", cancelLabel: undefined }],
      ["message", "Done", { title: undefined, kind: undefined, okLabel: "Got it", cancelLabel: undefined }],
      ["confirm", "Really?", { title: "Remove", kind: "warning", okLabel: "Yes", cancelLabel: "No" }],
      ["confirm", "Sure?", { title: undefined, kind: undefined, okLabel: "OK", cancelLabel: "Cancel" }],
      ["confirm", "Delete it?", { title: undefined, kind: undefined, okLabel: "Delete", cancelLabel: "Keep" }],
    ]);
  });

  it("plugin-dialog: a declined ask or confirm reads as false", async () => {
    installed();
    recordingDialogs(false);
    await expect(ask("Really?")).resolves.toBe(false);
    await expect(confirm("Sure?")).resolves.toBe(false);
    await expect(confirm("Delete it?", { okLabel: "Delete" })).resolves.toBe(false);
  });
});
