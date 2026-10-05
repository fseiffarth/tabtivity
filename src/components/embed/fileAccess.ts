import { createContext, useContext } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TranslationKey } from "../../lib/i18n";
import { NAMES } from "../../lib/brand";

/**
 * The project scope that absolute-path file commands are confined to.
 *
 * Backend confinement (`src-tauri/src/commands/fs.rs`, Security #1) isolates each
 * project's filesystem from the others: a file read/write/poll is allowed only
 * inside the *scope* project's tree (plus any box sibling's tree). The scope is
 * the project that OWNS the calling viewer — NOT whichever project is globally
 * "current" — so a viewer keeps working after you switch projects, are restored
 * on relaunch, or live in a detached window, instead of failing with a spurious
 * "path is not in the current project" error.
 *
 * `FileViewerPane` publishes its owning `projectId` here; every nested viewer and
 * hook reads it via {@link useFileScope} and threads it into the wrappers below.
 * `null` is the root scope (the backend then falls back to the current project).
 */
export const FileScopeContext = createContext<string | null>(null);

/** The owning project id of the surrounding viewer (null in the root scope). */
export function useFileScope(): string | null {
  return useContext(FileScopeContext);
}

/**
 * Where a viewer's bytes come from, for its remote/local source notice:
 *  - `"remote"` — a remote (SSH) project file served straight from the host over
 *                 SFTP (remote-native, no local copy).
 *  - `"local"`  — a remote project file under the local mirror, read on the local
 *                 fs (the paired working copy synced from the host).
 *  - `"none"`   — a local project: no remote/local distinction, so no badge.
 * Resolved by the `file_source` backend command, which mirrors the exact routing
 * the read commands use so the badge can never disagree with the bytes shown.
 */
export type FileSource = "remote" | "local" | "none";

/** The resolved source of the surrounding viewer's file (`"none"` = no badge). */
export const FileSourceContext = createContext<FileSource>("none");

/** The remote/local source classification published by the enclosing viewer. */
export function useFileSource(): FileSource {
  return useContext(FileSourceContext);
}

/**
 * Whether the enclosing viewer pane is currently laid out on screen.
 *
 * The pane layer keeps every tab of every scope mounted (`CenterPanel`'s flat
 * pane layer), so a viewer's standing work — above all the `file_mtime`
 * auto-reload polls, which for a remote project are an SFTP round trip each —
 * would otherwise keep running for every hidden tab of every backgrounded
 * project forever. `FileViewerPane` publishes its `visible` prop here; each
 * poll gates its interval on it and runs one immediate catch-up check when the
 * pane is next shown, so a file that changed while the tab was hidden still
 * reloads the moment it is looked at. Defaults to `true` so a viewer rendered
 * outside a gated pane (tests, future hosts) keeps the old always-on behavior.
 */
export const PaneVisibleContext = createContext<boolean>(true);

/** Whether the surrounding viewer pane is on screen (see {@link PaneVisibleContext}). */
export function usePaneVisible(): boolean {
  return useContext(PaneVisibleContext);
}

/** Classify a path's bytes as remote-native / local-mirror / not-applicable. */
export function fileSource(path: string, projectId: string | null): Promise<FileSource> {
  return invoke<FileSource>("file_source", { path, projectId });
}

// Thin wrappers over the confined file commands. They exist so the `project_id`
// scope argument is attached uniformly and can't be forgotten at a call site.

export function readFileText(path: string, projectId: string | null): Promise<string> {
  return invoke<string>("read_file_text", { path, projectId });
}

/**
 * Read a file's bytes.
 *
 * The command answers with a **raw** IPC body, so what arrives is an `ArrayBuffer`
 * — the bytes, once — rather than a JSON array with one decimal literal per byte.
 * That distinction is the difference between a 130 MB PDF opening and the window
 * freezing for several seconds on ~400 MB of JSON and a number array it then has to
 * copy; see `read_file_bytes` in `commands/fs.rs`.
 *
 * A `number[]` is still accepted and converted, because that is what the tests' mocked
 * `invoke` returns (and what an older backend would answer) — the conversion costs
 * nothing on the array sizes a test uses and keeps every caller on one return type.
 *
 * The returned view owns its buffer and is handed out fresh on every call, which is
 * what lets a caller pass it straight to pdf.js — that DETACHES the buffer, so a
 * shared one would be pulled out from under the next reader.
 */
export async function readFileBytes(
  path: string,
  projectId: string | null,
): Promise<Uint8Array> {
  const out = await invoke<ArrayBuffer | number[]>("read_file_bytes", { path, projectId });
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  noteIpcFallback(out.length);
  return Uint8Array.from(out);
}

let ipcFallbackReported = false;

/**
 * A raw-body command answered as a JSON number array. Inside Tauri that has one
 * meaning: this window's IPC has dropped to the `postMessage` fallback (Tauri
 * switches a window over for good after one failed custom-protocol fetch, and
 * says so only on the devtools console). On that path every binary read is
 * handed back as a script — `runCallback(id, [37,80,68,…])` — that the engine
 * has to parse: measured on WebKitGTK 2.52, one 80 MB PDF read this way takes
 * the renderer from 0.2 GB to 2.8–6 GB and leaves it above 1.9 GB afterwards.
 * That is the shape of "the popout grows on every recompile until it is
 * restarted", so the first time it happens it goes into crash.log, where the
 * watchdog's ceiling reports for the same window will sit beside it.
 *
 * Outside Tauri there is nothing to report: the tests' mocked `invoke` answers
 * arrays by design, and their setup stubs `__TAURI_INTERNALS__` too — what only
 * the real runtime's init script writes is `metadata` (the current window), so
 * that is the field that means "a Tauri window".
 */
function noteIpcFallback(bytes: number): void {
  if (ipcFallbackReported) return;
  const internals =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__;
  if (typeof internals?.metadata !== "object" || internals.metadata === null) return;
  ipcFallbackReported = true;
  void Promise.resolve().then(() => invoke("report_frontend_error", {
    kind: "ipc-fallback",
    message:
      `read_file_bytes arrived as a JSON number array (${bytes} bytes) instead of a raw body: ` +
      "this window's IPC is on Tauri's postMessage fallback, so every binary read is evaluated " +
      "as a script — the renderer's memory will climb by gigabytes per PDF reload until the " +
      "window is recreated. Look for 'IPC custom protocol failed' in this window's devtools console.",
    stack: null,
  })).catch(() => {});
}

export function writeFileText(
  path: string,
  content: string,
  projectId: string | null,
): Promise<void> {
  return invoke("write_file_text", { path, content, projectId });
}

/**
 * Write a file's bytes.
 *
 * The bytes ride as the invoke's **raw body** and the two scalars as headers, which
 * is the only shape Tauri offers for a binary upload (one raw body per call). The
 * reason is `readFileBytes`' in reverse: this used to be `Array.from(content)` and
 * let it be JSON — a JS array as long as the file, then its JSON text — which for a
 * rebuilt PDF of any size is the step that takes the renderer down. A remark
 * autosave reaches this with no click behind it, so it must not be the costly path.
 *
 * `encodeURIComponent` because a header is ASCII and a project path is not; the
 * backend decodes it and confines it to the same roots as before.
 */
export function writeFileBytes(
  path: string,
  content: number[] | Uint8Array,
  projectId: string | null,
): Promise<void> {
  const bytes = content instanceof Uint8Array ? content : Uint8Array.from(content);
  return invoke("write_file_bytes", bytes, {
    headers: {
      [NAMES.filePathHeader]: encodeURIComponent(path),
      [NAMES.fileProjectHeader]: encodeURIComponent(projectId ?? ""),
    },
  });
}

export function fileMtime(path: string, projectId: string | null): Promise<number> {
  return invoke<number>("file_mtime", { path, projectId });
}

export function detectMime(path: string, projectId: string | null): Promise<string> {
  return invoke<string>("detect_mime", { path, projectId });
}

/**
 * Turn a raw file-read/stat failure into a sentence a user can act on.
 *
 * The backend surfaces low-level text — `sftp metadata failed: …`,
 * `sftp read failed: …`, an OS `No such file or directory` — which means nothing
 * to someone who just clicked a file. The single most common cause on a remote
 * project is opening a file that only exists in the local mirror while the viewer
 * is reading the host over SFTP (never synced): say that, and point at the fix.
 * Falls back to a plain "couldn't open" rather than dumping the raw string.
 *
 * Returns the i18n key, not the sentence: every caller already has a `t`, and the
 * copy belongs in `lib/i18n` with the rest of it.
 */
export function describeFileErrorKey(e: unknown): TranslationKey {
  const raw = String(e);
  const remote = /sftp/i.test(raw);
  if (/permission|denied|eacces/i.test(raw)) {
    return "fileError.permission";
  }
  // A remote stat/metadata failure means the host doesn't have this path — on a
  // remote project that's overwhelmingly a local-only file (never synced), which
  // is the actionable thing to say. An explicit "no such file" says the same.
  if (
    /no such file|not found|does not exist|enoent/i.test(raw) ||
    (remote && /metadata|stat/i.test(raw))
  ) {
    return remote ? "fileError.remoteMissing" : "fileError.missing";
  }
  if (remote) {
    return "fileError.remoteRead";
  }
  return "fileError.open";
}
