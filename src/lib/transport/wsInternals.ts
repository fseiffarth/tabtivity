/**
 * `window.__TAURI_INTERNALS__` for a browser (hosted plan §1.2, §3.5): every
 * `invoke()` and `listen()` in `@tauri-apps/api` v2 funnels through this
 * object (plus `__TAURI_EVENT_PLUGIN_INTERNALS__` for unlisten), so installing
 * WebSocket-backed implementations before the app loads leaves the 185 files
 * that import the API untouched.
 *
 * Routing of `invoke(cmd, args, options)`:
 * - `plugin:event|listen/unlisten/emit/emit_to` → a local callback table and
 *   `sub`/`unsub` frames; a frontend `emit` reaches this page's listeners and
 *   the user's other clients.
 * - `plugin:dialog|open/save/message/ask/confirm` → `dialogAdapter` (the
 *   server-side picker, the shared prompt dialogs).
 * - `plugin:notification|*` → the Web Notifications API (the plugin itself
 *   uses `window.Notification` for the rest).
 * - `plugin:drag|start_drag` → a download from the user-content origin.
 * - `plugin:window|*`, `plugin:webview|*` → `adaptWindowCommand`.
 * - a bytes body (`write_file_bytes`) → a binary frame; `read_file_bytes`
 *   answers one, resolved as an ArrayBuffer like Tauri's raw response.
 * - everything else by its class (`commandClasses.ts`): `core`/`admin` and
 *   the transport's own names go to the server; `client` to
 *   `adaptClientCommand` or a `{code:"client"}` rejection; `off` is refused
 *   with its reason; an unknown name is sent and refused by the server.
 *
 * Written against `@tauri-apps/api` 2.11 (`core.js`, `event.js`, `window.js`);
 * a Tauri upgrade re-checks the member list (`docs/third_party_update_checklist.md`).
 */
import { COMMAND_CLASSES, OFF_REASONS } from "./commandClasses";
import { adaptClientCommand, adaptWindowCommand } from "./clientAdapters";
import { dialogAdapter, type MessageOptions, type OpenOptions, type SaveOptions } from "./dialogAdapter";
import type { WsClient } from "./wsClient";

type Callback = (payload: unknown) => void;

/** Tauri's `listen` payload shape: `{event, id, payload}`. */
interface TauriEvent {
  event: string;
  id: number;
  payload: unknown;
}

interface InvokeOptions {
  headers?: Record<string, string> | Headers;
}

/** The names the transport answers itself (`web_client.rs`), not in the table. */
const TRANSPORT_COMMANDS = new Set(["server_capabilities", "desktop_file_ticket", "desktop_file_grant"]);

/** The raw-body commands (`fs.rs`). */
const RAW_ANSWER = new Set(["read_file_bytes"]);

export class WsInternals {
  private readonly callbacks = new Map<number, { callback: Callback; once: boolean }>();
  private nextCallback = 1;
  /** event name → listener ids; a `sub` is held while the set is non-empty. */
  private readonly listeners = new Map<string, Set<number>>();
  /** listener id → event name, for `unregisterListener(event, id)`. */
  private readonly listenerEvents = new Map<number, string>();

  constructor(private readonly client: WsClient) {
    client.onEvent((name, payload) => this.deliver(name, payload));
  }

  /** `__TAURI_INTERNALS__`. */
  internals(): Record<string, unknown> {
    return {
      invoke: (cmd: string, args?: unknown, options?: InvokeOptions) => this.invoke(cmd, args, options),
      transformCallback: (callback: Callback, once = false) => this.transformCallback(callback, once),
      unregisterCallback: (id: number) => {
        this.callbacks.delete(id);
      },
      convertFileSrc: (path: string) => path,
      // What a Tauri window's init script writes; `fileAccess.ts` reads it to
      // know it runs in a Tauri window (it does not: `metadata` is a page's).
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    };
  }

  /** `__TAURI_EVENT_PLUGIN_INTERNALS__`. */
  eventInternals(): Record<string, unknown> {
    return {
      unregisterListener: (event: string, id: number) => this.unlisten(event, id),
    };
  }

  transformCallback(callback: Callback, once: boolean): number {
    const id = this.nextCallback++;
    this.callbacks.set(id, { callback, once });
    return id;
  }

  private runCallback(id: number, payload: unknown): void {
    const entry = this.callbacks.get(id);
    if (!entry) return;
    if (entry.once) this.callbacks.delete(id);
    entry.callback(payload);
  }

  /** An event from the server (or a local emit) to every listener of its name. */
  deliver(name: string, payload: unknown): void {
    const ids = this.listeners.get(name);
    if (!ids) return;
    for (const id of [...ids]) {
      const event: TauriEvent = { event: name, id, payload };
      this.runCallback(id, event);
    }
  }

  private listen(event: string, handlerId: number): number {
    let ids = this.listeners.get(event);
    if (!ids) {
      ids = new Set();
      this.listeners.set(event, ids);
      this.client.subscribe(event);
    }
    ids.add(handlerId);
    this.listenerEvents.set(handlerId, event);
    return handlerId;
  }

  private unlisten(event: string, id: number): void {
    const ids = this.listeners.get(event);
    this.callbacks.delete(id);
    this.listenerEvents.delete(id);
    if (!ids || !ids.delete(id)) return;
    if (ids.size === 0) {
      this.listeners.delete(event);
      this.client.unsubscribe(event);
    }
  }

  invoke(cmd: string, args?: unknown, options?: InvokeOptions): Promise<unknown> {
    if (cmd.startsWith("plugin:")) return this.plugin(cmd, (args ?? {}) as Record<string, unknown>);
    if (args instanceof ArrayBuffer || ArrayBuffer.isView(args)) {
      const bytes = args instanceof ArrayBuffer ? new Uint8Array(args) : new Uint8Array(args.buffer, args.byteOffset, args.byteLength);
      return this.client.callRaw(cmd, headersOf(options), bytes);
    }
    const record = (args ?? {}) as Record<string, unknown>;
    if (TRANSPORT_COMMANDS.has(cmd) || RAW_ANSWER.has(cmd)) return this.client.call(cmd, record);
    const klass = COMMAND_CLASSES[cmd];
    switch (klass) {
      case "client": {
        const adapted = adaptClientCommand(this.client, cmd, record);
        return adapted ?? Promise.reject({ code: "client", command: cmd });
      }
      case "off":
        return Promise.reject({ code: "off", command: cmd, reason: OFF_REASONS[cmd] });
      default:
        // core, admin — and a name the table does not know, which the server
        // refuses as `unknown` (never defaulted anywhere).
        return this.client.call(cmd, record);
    }
  }

  private plugin(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    const [plugin, command] = cmd.slice("plugin:".length).split("|", 2);
    switch (plugin) {
      case "event":
        return this.eventPlugin(command, args);
      case "dialog":
        return dialogPlugin(command, args);
      case "notification":
        return notificationPlugin(command);
      case "drag": {
        const items = args.item;
        const paths = Array.isArray(items) ? items.map(String) : [];
        return Promise.all(paths.map((path) => this.client.call("desktop_file_ticket", { path, download: true }))).then((tickets) => {
          for (const ticket of tickets as { url: string }[]) window.open(ticket.url, "_blank", "noopener");
        });
      }
      case "window":
      case "webview":
        return adaptWindowCommand(command, args);
      case "resources":
        return Promise.resolve();
      default:
        return Promise.reject({ code: "client", command: cmd });
    }
  }

  private eventPlugin(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case "listen":
        return Promise.resolve(this.listen(String(args.event), Number(args.handler)));
      case "unlisten":
        this.unlisten(String(args.event), Number(args.eventId));
        return Promise.resolve();
      case "emit":
      case "emit_to": {
        const name = String(args.event);
        // This page's own listeners hear it (Tauri's emit reaches the emitter
        // too); the server carries it to the user's other clients.
        this.deliver(name, args.payload);
        this.client.emit(name, args.payload);
        return Promise.resolve();
      }
      default:
        return Promise.reject({ code: "client", command: `plugin:event|${command}` });
    }
  }
}

function headersOf(options?: InvokeOptions): Record<string, string> {
  const headers = options?.headers;
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  return { ...headers };
}

function dialogPlugin(command: string, args: Record<string, unknown>): Promise<unknown> {
  const adapter = dialogAdapter();
  const options = (args.options ?? {}) as Record<string, unknown>;
  switch (command) {
    case "open":
      return adapter.open(options as OpenOptions);
    case "save":
      return adapter.save(options as SaveOptions);
    case "message": {
      // `message`, `ask` and `confirm` all arrive as `plugin:dialog|message`;
      // `buttons` (plugin-dialog 2.7's `buttonsToRust`) tells them apart, and
      // the answer is the LABEL of the pressed button, which `ask`/`confirm`
      // compare with their ok label.
      const buttons = args.buttons as string | Record<string, unknown> | undefined;
      const text = String(args.message ?? "");
      let ok = "Ok";
      let cancel: string | null = null;
      if (buttons === "OkCancel") cancel = "Cancel";
      else if (buttons === "YesNo") [ok, cancel] = ["Yes", "No"];
      else if (typeof buttons === "object" && buttons !== null) {
        if ("OkCustom" in buttons) ok = String(buttons.OkCustom);
        else if (Array.isArray(buttons.OkCancelCustom)) [ok, cancel] = buttons.OkCancelCustom.map(String) as [string, string];
        else if (Array.isArray(buttons.YesNoCancelCustom)) [ok, cancel] = buttons.YesNoCancelCustom.slice(0, 2).map(String) as [string, string];
      }
      const opts: MessageOptions = { title: args.title as string | undefined, kind: args.kind as MessageOptions["kind"], okLabel: ok, cancelLabel: cancel ?? undefined };
      if (cancel === null) return adapter.message(text, opts).then(() => ok);
      const no = cancel;
      return adapter.confirm(text, opts).then((yes) => (yes ? ok : no));
    }
    default:
      return Promise.reject({ code: "client", command: `plugin:dialog|${command}` });
  }
}

function notificationPlugin(command: string): Promise<unknown> {
  switch (command) {
    case "is_permission_granted":
      return Promise.resolve(typeof Notification !== "undefined" && Notification.permission === "granted");
    case "register_action_types":
    case "create_channel":
    case "delete_channel":
    case "cancel":
    case "remove_active":
      return Promise.resolve();
    case "get_pending":
    case "get_active":
    case "listChannels":
      return Promise.resolve([]);
    default:
      return Promise.resolve();
  }
}

/** Install the shim on `window`; the app's `@tauri-apps/api` finds it there. */
export function installWsInternals(client: WsClient): WsInternals {
  const internals = new WsInternals(client);
  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = internals.internals();
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = internals.eventInternals();
  return internals;
}
