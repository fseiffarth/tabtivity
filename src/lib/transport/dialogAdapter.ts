/**
 * How the browser shim answers `@tauri-apps/plugin-dialog` (hosted plan §3.5):
 * `open`/`save` with a **server-side** file picker — the files are the
 * server's, a browser `<input type=file>` would pick from the laptop — and
 * `confirm`/`message`/`ask` with the app's shared `PromptDialogs`.
 *
 * The shim runs before React does, so the UI registers itself here once it
 * has mounted (`WebShell`); until then, and in a test, the window's own
 * `confirm`/`alert` stand in and a file pick answers "cancelled".
 */

/** `@tauri-apps/plugin-dialog`'s `open()` options, the ones the app passes. */
export interface OpenOptions {
  title?: string;
  directory?: boolean;
  multiple?: boolean;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export interface SaveOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export interface MessageOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
  cancelLabel?: string;
}

export interface DialogAdapter {
  open(options: OpenOptions): Promise<string | string[] | null>;
  save(options: SaveOptions): Promise<string | null>;
  confirm(message: string, options: MessageOptions): Promise<boolean>;
  message(message: string, options: MessageOptions): Promise<void>;
}

const fallback: DialogAdapter = {
  open: () => Promise.resolve(null),
  save: () => Promise.resolve(null),
  confirm: (message) => Promise.resolve(typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(message) : false),
  message: (message) => {
    if (typeof window !== "undefined" && typeof window.alert === "function") window.alert(message);
    return Promise.resolve();
  },
};

let current: DialogAdapter = fallback;

export function setDialogAdapter(adapter: DialogAdapter | null): void {
  current = adapter ?? fallback;
}

export function dialogAdapter(): DialogAdapter {
  return current;
}
