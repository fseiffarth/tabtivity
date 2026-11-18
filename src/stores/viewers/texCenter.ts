import { broadcast, listenOtherWindows } from "../../lib/window/crossWindow";

/**
 * Cross-window "center this TeX workspace on that source file" channel for
 * SyncTeX reverse search (#42), the third sibling of `pdfSync` (forward reveal)
 * and `editorJump` (the caret scroll).
 *
 * A reverse click resolves to a source file + line, and the file is regularly
 * NOT the one the workspace is centered on — the whole point of a multi-file
 * document. Switching the center used to be a `setViewerState` write into the
 * tabs store, which is correct only in the main window: a DETACHED popout's
 * workspace renders its `ViewerState` from a one-time seed into local React
 * state (see `TexWorkspaceView`'s `localVs`), so a main-window store write on a
 * popped-out workspace changed a field nobody was reading and the center never
 * moved — pdf→tex sync looked dead whenever the workspace lived in a popout.
 *
 * So the switch goes to the WINDOW THAT RENDERS the workspace instead:
 *  - every mounted workspace registers itself here, per window, keyed by its
 *    main document's path, with a callback that focuses its tab and routes the
 *    switch through its own `goTo` (so the back stack records the step);
 *  - `centerTexWorkspace` is the local half — reverse search asks it first, and
 *    in a popout (whose tabs store is empty) it is the ONLY probe that can see
 *    the workspace at all;
 *  - `requestTexCenter` is the cross-window half: the main window broadcasts it
 *    when the workspace tab exists but is detached (rendered in a popout), and
 *    the popout's `listenTexCenter` applies it through its own registry.
 * The caret jump itself still rides the `editorJump` channel, which the caller
 * posts after the center request; editors subscribe reactively, so the order
 * the two land in does not matter.
 */
export const TEX_CENTER_EVENT = "tex-workspace-center";

/** A cross-window center switch as broadcast. */
interface TexCenterPayload {
  /** The workspace's main document (the tab's identity/dedupe key). */
  root: string;
  /** The source file the center should switch to. */
  source: string;
  /** When set, the request is "recompile the document `source` belongs to"
   *  rather than a center switch — the PDF tab's recompile notice, which has
   *  no compile of its own (see `registerTexCompile`). */
  compile?: boolean;
}

// The workspaces mounted in THIS window, keyed by main document path. At most
// one per root by construction (`openTexWorkspace` dedupes the tab on it).
const mountedWorkspaces = new Map<string, (source: string) => void>();

/** Advertise a mounted workspace for `root` (call on mount). `center` focuses
 *  the workspace's tab and switches its centered file to the given source. */
export function registerTexWorkspace(root: string, center: (source: string) => void): void {
  mountedWorkspaces.set(root, center);
}

/** Drop a workspace registration (call on unmount). Identity-checked so a
 *  StrictMode remount's late cleanup cannot clear the fresh registration. */
export function unregisterTexWorkspace(root: string, center: (source: string) => void): void {
  if (mountedWorkspaces.get(root) === center) mountedWorkspaces.delete(root);
}

/** Center the workspace for `root` mounted in THIS window on `source`.
 *  Returns false — and touches nothing — when no workspace for that document
 *  is mounted here, so the caller can escalate cross-window. */
export function centerTexWorkspace(root: string, source: string): boolean {
  const center = mountedWorkspaces.get(root);
  if (!center) return false;
  center(source);
  return true;
}

/** Broadcast a center switch to the other window(s) — used when the workspace
 *  tab is detached, i.e. rendered in a popout this heap cannot reach. Best
 *  effort: a non-Tauri env (tests) simply skips the broadcast. */
export function requestTexCenter(root: string, source: string): void {
  broadcast(TEX_CENTER_EVENT, { root, source } satisfies TexCenterPayload);
}

// The compile entry points mounted in THIS window, keyed by the editor's own
// source path: every mounted TeX editor (a workspace pane or a standalone tab)
// advertises its `compile`, which saves the whole workspace and builds the main
// document whichever file it is registered under.
const mountedCompilers = new Map<string, () => void>();

/** Advertise a mounted TeX editor's compile for `path` (call on mount). The
 *  PDF viewer's "recompile" notice reaches the build through this rather than
 *  owning a compile of its own — the editor holds the unsaved draft, the engine
 *  choice and the out-dir, and a second compile path would drift from it. */
export function registerTexCompile(path: string, compile: () => void): void {
  mountedCompilers.set(path, compile);
}

/** Drop a compile registration (call on unmount). Identity-checked, like
 *  {@link unregisterTexWorkspace}. */
export function unregisterTexCompile(path: string, compile: () => void): void {
  if (mountedCompilers.get(path) === compile) mountedCompilers.delete(path);
}

/** True when an editor for `path` is mounted in THIS window and can compile. */
export function hasTexCompiler(path: string): boolean {
  return mountedCompilers.has(path);
}

/** Run the compile of the editor mounted for `path` in THIS window. Returns
 *  false — and touches nothing — when none is mounted here, so the caller can
 *  escalate cross-window. */
export function compileTexWorkspace(path: string): boolean {
  const compile = mountedCompilers.get(path);
  if (!compile) return false;
  compile();
  return true;
}

/** Broadcast a recompile request to the other window(s) — the workspace tab
 *  exists but renders in a popout this heap cannot reach. Best effort, like
 *  {@link requestTexCenter}. */
export function requestTexCompile(root: string, source: string): void {
  broadcast(TEX_CENTER_EVENT, { root, source, compile: true } satisfies TexCenterPayload);
}

/**
 * Register THIS window's listener for cross-window center broadcasts (#42).
 * Every window (main shell + each detached popout) calls this once at startup;
 * an incoming request that didn't originate here is applied through the local
 * registry, so whichever window renders the workspace switches its center.
 * Returns an unlisten. No-ops outside a Tauri context.
 */
export function listenTexCenter(): Promise<() => void> {
  return listenOtherWindows<TexCenterPayload>(TEX_CENTER_EVENT, ({ root, source, compile }) => {
    // A recompile: the clicked source's editor if it is mounted here, else the main's.
    if (!compile) centerTexWorkspace(root, source);
    else if (!compileTexWorkspace(source)) compileTexWorkspace(root);
  });
}
