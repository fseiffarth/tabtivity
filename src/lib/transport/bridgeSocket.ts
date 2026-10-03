/**
 * The Connect window's socket (hosted plan §7.2, P5): a `SocketLike` whose
 * frames travel through this desktop's own backend (`commands::connect`),
 * which holds the real socket to the server — the window's origin is the
 * app's, so it cannot carry the server's `SameSite=Strict` session itself.
 *
 * Uses the window's NATIVE Tauri internals, captured before the browser
 * transport's shim replaces them: the event listener is registered before
 * `connect_ws_open` is asked, on a name chosen here, so the server's `hello`
 * can never arrive unheard.
 */
import type { SocketFactory, SocketLike } from "./wsClient";

/** The parts of Tauri's own `__TAURI_INTERNALS__` the bridge uses. */
export interface NativeInternals {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>;
  transformCallback: (callback: (payload: unknown) => void, once?: boolean) => number;
}

interface Frame {
  kind: "text" | "binary" | "close";
  text?: string;
  binary?: string;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

function randomName(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw);
}

function fromBase64(text: string): ArrayBuffer {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

export class BridgeSocket implements SocketLike {
  readyState = CONNECTING;
  binaryType = "arraybuffer";
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  private id: number | null = null;
  private readonly event = `connect-frame-${randomName()}`;
  private listener: number | null = null;

  constructor(private readonly native: NativeInternals, url: string) {
    const resume = new URL(url, "connect://server").searchParams.get("resume");
    const handler = native.transformCallback((payload) => this.frame((payload as { payload: Frame }).payload));
    void native
      .invoke("plugin:event|listen", { event: this.event, target: { kind: "Any" }, handler })
      .then((listener) => {
        this.listener = Number(listener);
        return native.invoke("connect_ws_open", { event: this.event, resume });
      })
      .then((id) => {
        this.id = Number(id);
        if (this.readyState !== CONNECTING) {
          void native.invoke("connect_ws_close", { id: this.id }).catch(() => undefined);
          return;
        }
        this.readyState = OPEN;
        this.onopen?.({});
      })
      .catch((error: unknown) => {
        this.onerror?.(error);
        this.finish();
      });
  }

  private frame(frame: Frame): void {
    if (frame.kind === "close") {
      this.finish();
      return;
    }
    if (this.readyState !== OPEN) return;
    const data = frame.kind === "binary" ? fromBase64(frame.binary ?? "") : (frame.text ?? "");
    this.onmessage?.({ data });
  }

  private finish(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    if (this.listener !== null) {
      void this.native.invoke("plugin:event|unlisten", { event: this.event, eventId: this.listener }).catch(() => undefined);
    }
    this.onclose?.({});
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== OPEN || this.id === null) return;
    const args =
      typeof data === "string"
        ? { id: this.id, text: data }
        : { id: this.id, binary: toBase64(data instanceof Uint8Array ? data : new Uint8Array(data)) };
    void this.native.invoke("connect_ws_send", args).catch(() => this.finish());
  }

  close(): void {
    if (this.id !== null && this.readyState === OPEN) {
      void this.native.invoke("connect_ws_close", { id: this.id }).catch(() => undefined);
    }
    this.finish();
  }
}

export function bridgeSocketFactory(native: NativeInternals): SocketFactory {
  return (url) => new BridgeSocket(native, url);
}
