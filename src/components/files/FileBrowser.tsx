import { useEffect, useMemo, useState } from "react";
import { useTabScope } from "../tabs/tabScopeContext";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import { useWindowsStore } from "../../stores/windows";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { Dropdown } from "../common/Dropdown";
import {
  type FileEntry,
  type SortKey,
  STANDARD_PROJECT_FILES,
  disabledViewers,
  fmtModified,
  fmtSize,
  joinRel,
  parentRel,
  relFromAbs,
  visibleEntries,
} from "../../lib/viewers/fileUtils";
import { basename, dirname, isAbsolute } from "../../lib/paths";
import { closeTabsForDeletedPath, retargetTabsForRenamedPath } from "./fileTabSync";
import { openFileEntry } from "./openFileEntry";
import { useExperimental } from "../../lib/experimental";
import { createDeckFile } from "../../lib/viewers/deck/create";
import { UntestedTag } from "../common/UntestedTag";
import { RenameDialog, containingFolderLabel } from "./RenameDialog";
import { useDialogs } from "../common/PromptDialogs";
import { FileIcon } from "../common/icons/FileIcon";
import { useT, type TranslationKey } from "../../lib/i18n";
import { ErrorNote } from "../common/ErrorNote";

type ProjectJson = Record<string, unknown>;

function readStringList(project: ProjectJson | null, key: string): string[] {
  const raw = project?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

type ViewMode = "list" | "icons";
const SORT_LABEL_KEY: Record<SortKey, TranslationKey> = {
  name: "fileBrowser.sortName",
  type: "fileBrowser.sortType",
  size: "fileBrowser.sortSize",
  modified: "fileBrowser.sortModified",
  created: "fileBrowser.sortCreated",
};
type ContextMenuState =
  | { kind: "entry"; x: number; y: number; path: string }
  | { kind: "background"; x: number; y: number };

interface Props {
  projectDir: string;
  projectId: string | null;
  active: boolean;
}

export function FileBrowser({ projectDir, projectId, active }: Props) {
  const t = useT();
  const { openFile } = useWindowsStore();
  const projects = useProjectsStore((s) => s.projects);
  const viewerPrefs = useSettingsStore((s) => s.settings?.viewer_prefs);
  const disabledViewerSet = useMemo(() => disabledViewers(viewerPrefs), [viewerPrefs]);
  // Root console: opened viewers are root's tabs (see tabScopeContext).
  const tabScope = useTabScope();
  const [relPath, setRelPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<string[]>([]);
  const [future, setFuture] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [showStandardFiles, setShowStandardFiles] = useState(true);
  const [separateScaffold, setSeparateScaffold] = useState(true);
  const [showUserHidden, setShowUserHidden] = useState(false);
  const [hiddenEndings, setHiddenEndings] = useState<string[]>([]);
  const [hiddenPaths, setHiddenPaths] = useState<string[]>([]);
  const [shownPaths, setShownPaths] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);
  const [query, setQuery] = useState("");
  const [pathEntry, setPathEntry] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  /** The entry whose rename dialog is open; `RenameDialog` owns the typed name. */
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  // The browser's other questions, in the same chrome as the rename above —
  // the tree next to it asks them exactly this way (`FileTree`), and a prompt
  // that differs by which pane opened it is the drift the shared-viewer rule
  // exists to stop.
  const { promptText, confirmAction, showMessage, dialogs } = useDialogs();
  const deckEnabled = useExperimental("deck_presenter");

  const localFile = projects.find((p) => p.id === projectId)?.local_file ?? null;

  useEffect(() => {
    if (!localFile) {
      setHiddenEndings([]);
      setHiddenPaths([]);
      setShownPaths([]);
      return;
    }
    invoke<ProjectJson>("get_project_panel_prefs", { localFile })
      .then((project) => {
        setHiddenEndings(readStringList(project, "panel_hidden_endings"));
        setHiddenPaths(readStringList(project, "panel_hidden_paths"));
        setShownPaths(readStringList(project, "panel_shown_paths"));
      })
      .catch(() => {
        setHiddenEndings([]);
        setHiddenPaths([]);
        setShownPaths([]);
      });
  }, [localFile]);

  useEffect(() => {
    if (!projectDir) return;
    load("", { replace: true });
  }, [projectDir]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  const displayed = useMemo(
    () => visibleEntries(entries, {
      showHidden,
      showStandardFiles,
      query,
      sortKey,
      descending,
      relPath,
      hiddenEndings: showUserHidden ? [] : hiddenEndings,
      hiddenPaths: showUserHidden ? [] : hiddenPaths,
      shownPaths: showUserHidden ? [] : shownPaths,
    }),
    [entries, showHidden, showStandardFiles, query, sortKey, descending, relPath, showUserHidden, hiddenEndings, hiddenPaths, shownPaths],
  );

  async function load(nextRel: string, options: { replace?: boolean } = {}) {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<FileEntry[]>("list_dir", {
        projectDir,
        relPath: nextRel,
      });
      setEntries(result);
      setPathEntry(nextRel);
      setSelected(new Set());
      if (!options.replace && nextRel !== relPath) {
        setHistory((items) => [...items, relPath]);
        setFuture([]);
      }
      setRelPath(nextRel);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function goBack() {
    const prev = history[history.length - 1];
    if (prev === undefined) return;
    setHistory((items) => items.slice(0, -1));
    setFuture((items) => [relPath, ...items]);
    load(prev, { replace: true });
  }

  function goForward() {
    const next = future[0];
    if (next === undefined) return;
    setFuture((items) => items.slice(1));
    setHistory((items) => [...items, relPath]);
    load(next, { replace: true });
  }

  // Open on double-click. A folder navigates in; a file with a native in-app
  // viewer opens in the project's focused subwindow, while a type with no native
  // viewer — or a Shift+double-click — opens in the OS default app. The single
  // open-a-file policy shared with the FileTree (see `openFileEntry`).
  function activate(entry: FileEntry, ev?: React.MouseEvent) {
    if (entry.is_dir) {
      load(joinRel(relPath, entry.name));
      return;
    }
    openFileEntry({
      entry,
      projectDir,
      projectId,
      origin: "middle_file_browser",
      external: ev?.shiftKey ?? false,
      disabled: disabledViewerSet,
      scope: tabScope,
    });
  }

  function toggleSelected(entry: FileEntry, additive: boolean) {
    setSelected((current) => {
      if (!additive) return new Set([entry.path]);
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }

  function selectedEntries(): FileEntry[] {
    return entries.filter((entry) => selected.has(entry.path));
  }

  function firstSelectedEntry(): FileEntry | undefined {
    return selectedEntries()[0];
  }

  async function createEntry(kind: "file" | "folder") {
    await promptText(
      {
        title: t(kind === "file" ? "fileBrowser.newFile" : "fileBrowser.newFolder"),
        body: (
          <>
            {t("fileTree.newEntryIn")}{" "}
            <strong>{basename(relPath) || t("fileTree.projectRootFolder")}</strong>
          </>
        ),
        label: t(kind === "file" ? "fileBrowser.newFilePrompt" : "fileBrowser.newFolderPrompt"),
        confirmLabel: t("common.create"),
      },
      // Thrown, not swallowed into the status line: the dialog stays open with
      // the reason next to the name that caused it.
      async (name) => {
        await invoke(kind === "file" ? "create_file" : "create_dir", {
          projectDir,
          relPath: joinRel(relPath, name),
        });
        await load(relPath, { replace: true });
      },
    );
  }

  /**
   * Create an empty `.eldeck.json` in the browsed folder and open it in the
   * deck editor — the tree's from-blank path (`FileTree.createDeck`), offered
   * here too so the browser isn't the one file view where a presentation can't
   * be started. The write itself is the shared `createDeckFile`: "New File"
   * would leave the file empty, which `parseDeck` rejects.
   */
  async function createDeck() {
    await promptText(
      {
        title: t("fileTree.newPresentation"),
        body: (
          <>
            {t("fileTree.newEntryIn")}{" "}
            <strong>{basename(relPath) || t("fileTree.projectRootFolder")}</strong>
          </>
        ),
        label: t("fileTree.newPresentationPrompt"),
        initial: "talk",
        confirmLabel: t("common.create"),
      },
      async (name) => {
        const { fileName, abs } = await createDeckFile({
          projectDir,
          projectId,
          relDir: relPath,
          name,
        });
        await load(relPath, { replace: true });
        openFileEntry({
          entry: {
            name: fileName,
            path: abs,
            is_dir: false,
            size: 0,
            extension: "json",
            mime: "application/json",
          },
          projectDir,
          projectId,
          origin: "middle_file_browser",
          external: false,
          disabled: disabledViewerSet,
          scope: tabScope,
        });
      },
    );
  }

  function renameSelected() {
    const target = selectedEntries()[0];
    if (!target) return;
    // Same dialog the tree uses (`RenameDialog`) — a rename must not look or
    // behave differently depending on which pane it was started from.
    setRenameTarget(target);
  }

  /** The dialog's action. Throws on failure so the dialog keeps the typed name
   *  and shows the reason next to the field. */
  async function confirmRename(target: FileEntry, nextName: string) {
    setError(null);
    await invoke("rename_path", {
      projectDir,
      oldRel: relFromAbs(projectDir, target.path),
      newName: nextName,
    });
    // Retarget any open viewer tab of this file (main + detached) to the new
    // path — swap the basename on the entry's own absolute path (== embedPath).
    const oldAbs = target.path;
    const newAbs = `${oldAbs.slice(0, oldAbs.lastIndexOf("/") + 1)}${nextName}`;
    retargetTabsForRenamedPath(oldAbs, newAbs);
    setRenameTarget(null);
    await load(relPath, { replace: true });
  }

  async function deleteSelected() {
    const targets = selectedEntries();
    if (targets.length === 0) return;
    const confirmed = await confirmAction({
      title: t("common.delete"),
      body: t(
        targets.length === 1 ? "fileBrowser.confirmDeleteOne" : "fileBrowser.confirmDeleteMany",
        { count: targets.length },
      ),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      for (const target of targets) {
        await invoke(target.is_dir ? "delete_dir" : "delete_file", {
          projectDir,
          relPath: relFromAbs(projectDir, target.path),
        });
        // Close any open viewer tab for the deleted file/folder (main + detached).
        closeTabsForDeletedPath(target.path);
      }
      await load(relPath, { replace: true });
    } catch (e) {
      setError(String(e));
    }
  }

  function copySelectedPaths() {
    const paths = selectedEntries().map((entry) => entry.path);
    if (paths.length === 0) return;
    navigator.clipboard?.writeText(paths.join("\n")).catch(() => {});
  }

  function revealSelected() {
    const target = firstSelectedEntry();
    if (!target) return;
    const path = target.is_dir ? target.path : dirname(target.path);
    openFile(path, undefined, projectId, "middle_file_browser").catch((e) =>
      setError(String(e)),
    );
  }

  function showProperties() {
    const target = firstSelectedEntry();
    if (!target) return;
    const type = target.is_dir ? t("fileBrowser.folder") : target.mime || target.extension || t("fileBrowser.file");
    // The file's name titles the dialog, so the block below is the facts alone —
    // the native box had to repeat the name as its first line to have one.
    void showMessage({
      title: target.name,
      body: [
        `${t("fileBrowser.pathLabel")} ${target.path}`,
        `${t("fileBrowser.typeLabel")} ${type}`,
        target.is_dir ? "" : `${t("fileBrowser.sizeLabel")} ${fmtSize(target.size)}`,
        `${t("fileBrowser.modifiedLabel")} ${fmtModified(target.modified_secs) || t("fileBrowser.unknown")}`,
      ].filter(Boolean).join("\n"),
    });
  }

  function showEntryContextMenu(event: React.MouseEvent, entry: FileEntry) {
    event.preventDefault();
    event.stopPropagation();
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
    }
    setContextMenu({ kind: "entry", x: event.clientX, y: event.clientY, path: entry.path });
  }

  function showBackgroundContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    if (event.target !== event.currentTarget) return;
    setSelected(new Set());
    setContextMenu({ kind: "background", x: event.clientX, y: event.clientY });
  }

  function runContextAction(action: () => void) {
    setContextMenu(null);
    action();
  }

  function submitPath(event: React.FormEvent) {
    event.preventDefault();
    const raw = pathEntry.trim();
    const nextRel = isAbsolute(raw) ? relFromAbs(projectDir, raw) : raw.replace(/^\/+/, "");
    load(nextRel);
  }

  if (!projectDir) {
    return <div className="file-browser-empty">{t("common.noProjectSelected")}</div>;
  }

  const canMutate = selected.size > 0;

  // Delete key removes the current selection — the keyboard twin of the Delete
  // button / context-menu action. Ignored while a text field (path/search/rename
  // prompt) has focus so it never eats a keystroke there.
  function handleKeyDown(ev: React.KeyboardEvent) {
    if (ev.key !== "Delete" || selected.size === 0) return;
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    ev.preventDefault();
    void deleteSelected();
  }

  return (
    <section className={`file-browser ${active ? "active" : ""}`} tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="file-browser-toolbar">
        <button onClick={goBack} disabled={history.length === 0} title={t("common.back")}>‹</button>
        <button onClick={goForward} disabled={future.length === 0} title={t("fileBrowser.forward")}>›</button>
        <button onClick={() => load(parentRel(relPath))} disabled={!relPath} title={t("fileBrowser.up")}>↑</button>
        <button onClick={() => load(relPath, { replace: true })} title={t("common.refresh")}>↻</button>
        <form className="file-browser-path" onSubmit={submitPath}>
          <span>{basename(projectDir) || projectDir}</span>
          <input value={pathEntry} onChange={(e) => setPathEntry(e.target.value)} placeholder="/" />
        </form>
        <input
          className="file-browser-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("fileBrowser.searchPlaceholder")}
        />
        <button className={viewMode === "list" ? "selected" : ""} onClick={() => setViewMode("list")}>{t("fileBrowser.list")}</button>
        <button className={viewMode === "icons" ? "selected" : ""} onClick={() => setViewMode("icons")}>{t("fileBrowser.icons")}</button>
      </div>

      <div className="file-browser-actions">
        <button onClick={() => createEntry("file")}>{t("fileBrowser.newFile")}</button>
        <button onClick={() => createEntry("folder")}>{t("fileBrowser.newFolder")}</button>
        {deckEnabled && (
          <button onClick={() => void createDeck()}>
            {t("fileTree.newPresentation")}
            <UntestedTag id="fileBrowser.1" />
          </button>
        )}
        <button onClick={renameSelected} disabled={!canMutate}>{t("fileBrowser.rename")}</button>
        <button onClick={deleteSelected} disabled={!canMutate}>{t("fileBrowser.delete")}</button>
        <button onClick={copySelectedPaths} disabled={!canMutate}>{t("fileBrowser.copyPath")}</button>
        <button onClick={revealSelected} disabled={!canMutate}>{t("fileBrowser.reveal")}</button>
        <label><Toggle size="sm" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> {t("fileBrowser.hidden")}</label>
        <label><Toggle size="sm" checked={showStandardFiles} onChange={(e) => setShowStandardFiles(e.target.checked)} /> {t("fileBrowser.scaffold")}</label>
        <label><Toggle size="sm" checked={separateScaffold} onChange={(e) => setSeparateScaffold(e.target.checked)} /> {t("fileBrowser.separateScaffold")}</label>
        <label><Toggle size="sm" checked={showUserHidden} onChange={(e) => setShowUserHidden(e.target.checked)} /> {t("fileBrowser.userHidden")}</label>
        <Dropdown
          title={t("fileBrowser.sortByTitle")}
          value={sortKey}
          onChange={(v) => setSortKey(v as SortKey)}
          options={(Object.keys(SORT_LABEL_KEY) as SortKey[]).map((key) => ({
            value: key,
            label: t(SORT_LABEL_KEY[key]),
          }))}
        />
        <button onClick={() => setDescending((v) => !v)}>{t(descending ? "fileBrowser.desc" : "fileBrowser.asc")}</button>
      </div>

      <div className="file-browser-body">
        <aside className="file-browser-sidebar">
          <button className={!relPath ? "selected" : ""} onClick={() => load("")}>{t("fileBrowser.projectRootLabel")}</button>
          {entries.filter((e) => e.is_dir).slice(0, 80).map((entry) => (
            <button key={entry.path} onClick={() => load(joinRel(relPath, entry.name))}>
              {entry.name}
            </button>
          ))}
        </aside>
        <div className="file-browser-main" onContextMenu={showBackgroundContextMenu}>
          {loading && <div className="file-browser-message">{t("fileBrowser.loading")}</div>}
          {error && <ErrorNote className="file-browser-error" error={error} />}
          {!loading && displayed.length === 0 && <div className="file-browser-message">{t("fileBrowser.noFiles")}</div>}
          {(() => {
            const splitScaffold = !relPath && showStandardFiles && separateScaffold;
            const regular = splitScaffold ? displayed.filter((e) => !STANDARD_PROJECT_FILES.has(e.name)) : displayed;
            const scaffold = splitScaffold ? displayed.filter((e) => STANDARD_PROJECT_FILES.has(e.name)) : [];

            function renderListRow(entry: FileEntry, isScaffold = false) {
              return (
                <div
                  key={entry.path}
                  className={`file-browser-row${selected.has(entry.path) ? " selected" : ""}${isScaffold ? " scaffold" : ""}`}
                  onClick={(e) => toggleSelected(entry, e.ctrlKey || e.metaKey)}
                  onDoubleClick={(e) => activate(entry, e)}
                  onContextMenu={(e) => showEntryContextMenu(e, entry)}
                >
                  <span><b><FileIcon ext={entry.extension} isDir={entry.is_dir} /></b>{entry.name}</span>
                  <span>{entry.is_dir ? t("fileBrowser.folder") : entry.extension || entry.mime || t("fileBrowser.file")}</span>
                  <span>{entry.is_dir ? "" : fmtSize(entry.size)}</span>
                  <span>{fmtModified(entry.modified_secs)}</span>
                </div>
              );
            }

            function renderIconTile(entry: FileEntry, isScaffold = false) {
              return (
                <button
                  key={entry.path}
                  className={`file-browser-tile${selected.has(entry.path) ? " selected" : ""}${isScaffold ? " scaffold" : ""}`}
                  onClick={(e) => toggleSelected(entry, e.ctrlKey || e.metaKey)}
                  onDoubleClick={(e) => activate(entry, e)}
                  onContextMenu={(e) => showEntryContextMenu(e, entry)}
                >
                  <span><FileIcon ext={entry.extension} isDir={entry.is_dir} /></span>
                  <b>{entry.name}</b>
                </button>
              );
            }

            return viewMode === "list" ? (
              <div className="file-browser-list">
                <div className="file-browser-list-head">
                  <span>{t("fileBrowser.sortName")}</span>
                  <span>{t("fileBrowser.sortType")}</span>
                  <span>{t("fileBrowser.sortSize")}</span>
                  <span>{t("fileBrowser.sortModified")}</span>
                </div>
                {regular.map((e) => renderListRow(e, false))}
                {scaffold.length > 0 && (
                  <>
                    <div className="file-browser-section-divider">{t("fileBrowser.scaffoldDivider")}</div>
                    {scaffold.map((e) => renderListRow(e, true))}
                  </>
                )}
              </div>
            ) : (
              <div className="file-browser-icons">
                {regular.map((e) => renderIconTile(e, false))}
                {scaffold.length > 0 && (
                  <>
                    <div className="file-browser-section-divider file-browser-section-divider--icons">{t("fileBrowser.scaffoldDivider")}</div>
                    {scaffold.map((e) => renderIconTile(e, true))}
                  </>
                )}
              </div>
            );
          })()}
          {contextMenu && (
            <div
              className="context-menu file-browser-context-menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {contextMenu.kind === "entry" ? (
                <>
                  <button onClick={() => runContextAction(() => firstSelectedEntry() && activate(firstSelectedEntry()!))}>{t("fileBrowser.open")}</button>
                  <button onClick={() => runContextAction(copySelectedPaths)}>{t("fileBrowser.copyPath")}</button>
                  <button onClick={() => runContextAction(revealSelected)}>{t("fileBrowser.reveal")}</button>
                  <hr />
                  <button onClick={() => runContextAction(renameSelected)}>{t("fileBrowser.rename")}</button>
                  <button onClick={() => runContextAction(deleteSelected)}>{t("fileBrowser.delete")}</button>
                  <hr />
                  <button onClick={() => runContextAction(showProperties)}>{t("fileBrowser.properties")}</button>
                </>
              ) : (
                <>
                  <button onClick={() => runContextAction(() => createEntry("file"))}>{t("fileBrowser.newFile")}</button>
                  <button onClick={() => runContextAction(() => createEntry("folder"))}>{t("fileBrowser.newFolder")}</button>
                  {/* Tabtivity's own formats get their own caption: a `.eldeck.json`
                      is not a file "New File" can make (it must be written with
                      real contents to parse), so it reads as a separate thing to
                      create rather than a variant of the generic one. */}
                  {deckEnabled && (
                    <div className="context-menu-group">
                      <div className="context-menu-group-label">
                        {t("fileTree.appNativeGroup")}
                      </div>
                      <button
                        className="untested"
                        onClick={() => runContextAction(() => void createDeck())}
                      >
                        {t("fileTree.newPresentation")}
                        <UntestedTag id="fileBrowser.2" />
                      </button>
                    </div>
                  )}
                  <button onClick={() => runContextAction(() => load(relPath, { replace: true }))}>{t("common.refresh")}</button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {dialogs}
      {renameTarget && (
        <RenameDialog
          entryName={renameTarget.name}
          isDir={renameTarget.is_dir}
          folder={containingFolderLabel(renameTarget.path, t("fileTree.projectRootFolder"))}
          onCancel={() => setRenameTarget(null)}
          onRename={(next) => confirmRename(renameTarget, next)}
        />
      )}

      <footer className="file-browser-status">
        {t(
          displayed.length === 1 ? "fileBrowser.itemCountOne" : "fileBrowser.itemCountMany",
          { count: displayed.length },
        )}
        {selected.size > 0 ? t("fileBrowser.selectedCount", { count: selected.size }) : ""}
        {projectId ? ` · ${projectId}` : ""}
      </footer>
    </section>
  );
}
