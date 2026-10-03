/**
 * The browser desktop client's one socket to the server (hosted plan §3.5),
 * the mirror of `src-tauri/src/services/mobile_control/web_client.rs`.
 *
 * Frames, text (JSON):
 *   → {t:"call", id, cmd, args}        ← {t:"ret", id, ok} | {t:"ret", id, err}
 *   → {t:"sub"|"unsub", name}          ← {t:"event", name, payload}
 *   → {t:"emit", name, payload}        ← {t:"hello", client, protocol, capabilities}
 * Frames, binary (`[u8 kind][u32be id][payload]`):
 *   → kind 1: a raw call body, payload `[u32be hlen][header JSON {cmd, headers}][bytes]`
 *   ← kind 2: a raw answer, payload = the bytes (resolved as an ArrayBuffer)
 *
 * Reconnect: the socket is reopened with a growing delay and `?resume=<id>`,
 * so the server keeps this page's client id — and with it its terminal views
 * and PTYs — inside its grace window. While down, every pending call rejects
 * with `DisconnectedError` and no new call is sent (plan §3.5: replaying a
 * queue of stale mutations is worse than an error). Subscriptions are
 * re-sent after every `hello`.
 */
import type { CommandClass } from "./commandClasses";
import { DisconnectedError, setLinkState } from "./linkState";

export interface CommandCapability {
  name: string;
  class: CommandClass;
  served: boolean;
  refusal?: { code: string; reason?: string; feature?: string };
}

export interface ServerCapabilities {
  protocol: number;
  hostOs: "linux" | "windows" | "macos";
  role: "user" | "admin";
  /** `admin-helper` on a hosted server: CLIs are the administrator's. */
  cliInstalls?: "self" | "admin-helper";
  commands: CommandCapability[];
}

export interface Hello {
  client: string;
  protocol: number;
  capabilities: ServerCapabilities;
}

export type EventHandler = (name: string, payload: unknown) => void;

/** The subset of the DOM `WebSocket` the client uses; a test passes a fake. */
export interface SocketLike {
  readyState: number;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
}

export type SocketFactory = (url: string, protocol: string) => SocketLike;

export interface WsClientOptions {
  /** `ws://127.0.0.1:8742/api/v1/desktop/ws` */
  url: string;
  /** The subprotocol (`NAMES.desktopProtocol`). */
  protocol: string;
  socket?: SocketFactory;
  /** Reconnect backoff bounds, ms. */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Test seam for the backoff timer. */
  schedule?: (fn: () => void, ms: number) => void;
}

const SOCKET_OPEN = 1;
export const KIND_CALL = 1;
export const KIND_RET = 2;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class WsClient {
  hello: Hello | null = null;
  /** The server's id for this page; sent back as `?resume=` on a reconnect. */
  clientId: string | null = null;

  private socket: SocketLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Subscription reference counts, re-sent after every hello. */
  private readonly subs = new Map<string, number>();
  private readonly handlers = new Set<EventHandler>();
  private readyWaiters: Array<(hello: Hello) => void> = [];
  private closed = false;
  private attempt = 0;
  private readonly options: Required<Pick<WsClientOptions, "url" | "protocol" | "reconnectMinMs" | "reconnectMaxMs">> & WsClientOptions;

  constructor(options: WsClientOptions) {
    this.options = { reconnectMinMs: 500, reconnectMaxMs: 10_000, ...options };
  }

  /** Open the socket; reconnects on its own until `close()`. */
  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }

  /** Resolves with the first `hello` (or the last one received). */
  whenReady(): Promise<Hello> {
    if (this.hello) return Promise.resolve(this.hello);
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  get up(): boolean {
    return this.socket !== null && this.socket.readyState === SOCKET_OPEN && this.hello !== null;
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  call(cmd: string, args: unknown): Promise<unknown> {
    if (!this.up) return Promise.reject(new DisconnectedError());
    const id = this.nextId++;
    const frame = JSON.stringify({ t: "call", id, cmd, args: args ?? {} }, ipcReplacer);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.send(frame);
    });
  }

  /** A call whose body is bytes (`write_file_bytes`), headers carried alongside. */
  callRaw(cmd: string, headers: Record<string, string>, body: Uint8Array): Promise<unknown> {
    if (!this.up) return Promise.reject(new DisconnectedError());
    const id = this.nextId++;
    const header = new TextEncoder().encode(JSON.stringify({ cmd, headers }));
    const frame = new Uint8Array(1 + 4 + 4 + header.byteLength + body.byteLength);
    const view = new DataView(frame.buffer);
    frame[0] = KIND_CALL;
    view.setUint32(1, id);
    view.setUint32(5, header.byteLength);
    frame.set(header, 9);
    frame.set(body, 9 + header.byteLength);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.send(frame);
    });
  }

  subscribe(name: string): void {
    const count = this.subs.get(name) ?? 0;
    this.subs.set(name, count + 1);
    if (count === 0 && this.up) this.socket!.send(JSON.stringify({ t: "sub", name }));
  }

  unsubscribe(name: string): void {
    const count = this.subs.get(name) ?? 0;
    if (count <= 1) {
      this.subs.delete(name);
      if (count === 1 && this.up) this.socket!.send(JSON.stringify({ t: "unsub", name }));
    } else {
      this.subs.set(name, count - 1);
    }
  }

  /** A frontend `emit`: the server rebroadcasts it to the user's other clients. */
  emit(name: string, payload: unknown): void {
    if (!this.up) return;
    this.socket!.send(JSON.stringify({ t: "emit", name, payload: payload ?? null }, ipcReplacer));
  }

  private open(): void {
    const factory: SocketFactory = this.options.socket ?? ((url, protocol) => new WebSocket(url, protocol) as unknown as SocketLike);
    const url = this.clientId ? `${this.options.url}?resume=${encodeURIComponent(this.clientId)}` : this.options.url;
    setLinkState("connecting");
    let socket: SocketLike;
    try {
      socket = factory(url, this.options.protocol);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      // `up` waits for the hello frame.
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => {
      // The close that follows does the work.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.hello = null;
      setLinkState("down");
      const error = new DisconnectedError();
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(this.options.reconnectMaxMs, this.options.reconnectMinMs * 2 ** Math.min(this.attempt, 8));
    this.attempt += 1;
    const schedule = this.options.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    schedule(() => {
      if (!this.closed && this.socket === null) this.open();
    }, delay);
  }

  private receive(data: unknown): void {
    if (typeof data === "string") {
      let frame: { t?: string; id?: number; ok?: unknown; err?: unknown; name?: string; payload?: unknown; client?: string; protocol?: number; capabilities?: ServerCapabilities };
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      switch (frame.t) {
        case "hello": {
          this.hello = { client: frame.client ?? "", protocol: frame.protocol ?? 0, capabilities: frame.capabilities! };
          this.clientId = this.hello.client;
          this.attempt = 0;
          for (const name of this.subs.keys()) this.socket?.send(JSON.stringify({ t: "sub", name }));
          setLinkState("up");
          const waiters = this.readyWaiters;
          this.readyWaiters = [];
          for (const resolve of waiters) resolve(this.hello);
          return;
        }
        case "ret": {
          const pending = this.pending.get(frame.id!);
          if (!pending) return;
          this.pending.delete(frame.id!);
          if ("err" in frame) pending.reject(frame.err);
          else pending.resolve(frame.ok);
          return;
        }
        case "event":
          for (const handler of this.handlers) handler(frame.name ?? "", frame.payload);
          return;
        default:
          return;
      }
    }
    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      if (bytes.byteLength < 5 || bytes[0] !== KIND_RET) return;
      const id = new DataView(data).getUint32(1);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.resolve(data.slice(5));
    }
  }
}

/**
 * What Tauri's own IPC does to arguments before JSON (`process-ipc-message-fn.js`):
 * a `Map` becomes an object, bytes become arrays, and a `Channel` becomes its
 * IPC form through `__TAURI_TO_IPC_KEY__`.
 */
export function ipcReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (value instanceof Uint8Array) return Array.from(value);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (typeof value === "object" && value !== null && "__TAURI_TO_IPC_KEY__" in value) {
    return (value as { __TAURI_TO_IPC_KEY__: () => unknown }).__TAURI_TO_IPC_KEY__();
  }
  return value;
}
