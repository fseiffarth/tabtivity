import {
  internalViewerFor,
  type FileEntry,
  type InternalViewer,
} from "../viewers/fileUtils";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useWindowsStore } from "../../stores/windows";
import { openTexWorkspace } from "../viewers/tex/openTexWorkspace";
import { openTabInNewSubwindow, openTabInScope } from "../tabs/tabScopeContext";

/**
 * The single open-a-file policy shared by every file listing (the FileTree in
 * the side panel / subwindow sidebar / Files tab, and the FileBrowser). It is
 * the seam that makes a double-click mean the same thing everywhere:
 *
 *  - A file with a **native in-app viewer** (`internalViewerFor`) opens as an
 *    embed tab in the project's **focused subwindow** — reusing an already-open
 *    viewer tab for that exact file rather than stacking duplicates. In a
 *    detached popout the caller passes `placeTab` so the tab streams into that
 *    window (like the Python ▶ Run) instead of the main window's tab store.
 *  - A file with **no native viewer**, or an explicit `external` open
 *    (Shift+double-click), opens in the OS default app via `open_file`.
 *
 * `newSubwindow` (Ctrl+click on an agent's file link) puts the viewer tab in a
 * new subwindow beside the focused one instead (`openTabInNewSubwindow`).
 *
 * `disabled` honours the per-type viewer opt-out (#48); omit it to treat every
 * viewer as enabled.
 */
export function openFileEntry(opts: {
  entry: FileEntry;
  /** Project root, used as the embed tab's cwd. */
  projectDir: string;
  /** Owning project id, forwarded to `open_file` for window tracking. */
  projectId: string | null;
  /** Telemetry origin passed to `open_file` (e.g. "side_file_tree"). */
  origin: string;
  /** Force the OS-default-app path regardless of any native viewer (Shift). */
  external: boolean;
  /** Native viewers the user opted out of (#48); omit = all enabled. */
  disabled?: ReadonlySet<InternalViewer>;
  /** Detached-popout placement override: stream the tab into that window
   *  instead of writing the (non-authoritative) local tab store. */
  placeTab?: (tab: Omit<TabEntry, "key">) => void;
  /** The scope the tab belongs to when it is not the active one — the root
   *  console's (`TabScopeContext`). Omit/null = the active scope. */
  scope?: string | null;
  /** Open the viewer tab in a new subwindow beside the focused one. */
  newSubwindow?: boolean;
}): void {
  const { entry, projectDir, projectId, origin, external, disabled, scope, newSubwindow } = opts;
  const tabScope = scope ?? useTabsStore.getState().scope;
  const placeTab = opts.placeTab ?? (newSubwindow
    ? (tab: Omit<TabEntry, "key">) => openTabInNewSubwindow(tabScope, tab)
    : undefined);
  if (entry.is_dir) return;

  const viewer = internalViewerFor(entry, disabled);
  if (external || !viewer) {
    useWindowsStore
      .getState()
      .openFile(entry.path, undefined, projectId, origin)
      .catch((e) => console.error(e));
    return;
  }

  // A `.tex` opens (or focuses) the single TeX workspace tab for its document
  // instead of a bare editor tab — resolving the build root is async, so this is
  // fire-and-forget. `placeTab` threads the popout/drop seam straight through.
  if (viewer === "tex") {
    void openTexWorkspace(entry.path, placeTab, undefined, scope);
    return;
  }

  placeEmbedTab(
    {
      label: entry.name,
      cmd: "",
      cwd: projectDir,
      kind: "embed",
      embedPath: entry.path,
      viewer,
    },
    { placeTab: opts.placeTab, scope, newSubwindow, tabScope },
  );
}

/**
 * Open a folder as TensorBoard training runs (`docs/tensorboard_viewer_plan.md`):
 * a `tensorboard` embed tab whose path is the folder itself, which the viewer
 * lists for event files. Placed exactly like a file's viewer tab (focused
 * subwindow, a popout's `placeTab`, a scope, a new subwindow), and focuses the
 * tab already open for that folder.
 */
export function openTrainingRuns(opts: {
  entry: FileEntry;
  projectDir: string;
  /** The tab label, e.g. "Runs: logs" (the caller has the translation). */
  label: string;
  placeTab?: (tab: Omit<TabEntry, "key">) => void;
  scope?: string | null;
  newSubwindow?: boolean;
}): void {
  const { entry, projectDir, label, scope, newSubwindow } = opts;
  placeEmbedTab(
    {
      label,
      cmd: "",
      cwd: projectDir,
      kind: "embed",
      embedPath: entry.path,
      viewer: "tensorboard",
    },
    { placeTab: opts.placeTab, scope, newSubwindow, tabScope: scope ?? useTabsStore.getState().scope },
  );
}

/** The shared placement of an embed tab: see [`openFileEntry`] for the cases. */
function placeEmbedTab(
  tab: Omit<TabEntry, "key">,
  where: {
    placeTab?: (tab: Omit<TabEntry, "key">) => void;
    scope?: string | null;
    newSubwindow?: boolean;
    tabScope: string;
  },
): void {
  const { scope, newSubwindow, tabScope } = where;
  const placeTab = where.placeTab ?? (newSubwindow
    ? (tb: Omit<TabEntry, "key">) => openTabInNewSubwindow(tabScope, tb)
    : undefined);
  const sameFile = (t: TabEntry) =>
    t.kind === "embed" && t.viewer === tab.viewer && t.embedPath === tab.embedPath;
  if (newSubwindow && !where.placeTab) {
    openTabInNewSubwindow(tabScope, tab, sameFile);
    return;
  }
  if (placeTab) {
    placeTab(tab);
    return;
  }

  if (scope) {
    openTabInScope(scope, tab, sameFile);
    return;
  }

  // Main window: focus an existing viewer tab for this exact file if one is
  // open (same path + viewer), else add a fresh one to the focused subwindow.
  const store = useTabsStore.getState();
  const prior = store.tabs.find(sameFile);
  if (prior) store.setActive(prior.key);
  else store.addTab(tab);
}
