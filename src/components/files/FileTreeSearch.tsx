/**
 * In-tree search results for `FileTree` — the flat result list shown in place of
 * the browsed listing whenever the tree's search box holds a query. Two modes;
 * their backends walk the canonical local path, so `FileTree` mounts this for a
 * local-source tree, and for a host-pinned project (`hostPinned`), whose
 * backends answer from the host: the project's `directory` plus a
 * project-relative `relRoot` (a host folder cannot be resolved back to a
 * project), behind the HPC guard's one confirmed retry (`withHpcConfirm`):
 *
 *  - **name**: literal ranked filename/path search over the whole project tree
 *    (`list_project_paths`, ranked by `lib/projects/projectSearch`'s `rankNameMatches`).
 *    Fetched lazily on the first keystroke and cached per project dir.
 *  - **content**: literal line search inside files (`project_search` — this is
 *    its only frontend), debounced.
 *
 * Every result offers BOTH of the actions the feature asks for: **jump to this
 * path** (reveal + select the entry in the tree, via `onReveal`) and **open**
 * the file in a viewer tab (content hits open at the matched line). Which one is
 * the row's primary click depends on the mode — a filename hit reveals, a
 * content hit opens at its line — and the other is a trailing button.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTabScope } from "../../lib/tabs/tabScopeContext";
import { invoke } from "@tauri-apps/api/core";
import { useEditorJumpStore } from "../../stores/viewers/editorJump";
import { useSettingsStore } from "../../stores/settings";
import { basename, resolvePath } from "../../lib/paths";
import { disabledViewers, type FileEntry } from "../../lib/viewers/fileUtils";
import {
  CONTENT_DEBOUNCE_MS,
  MAX_CONTENT_RESULTS,
  MAX_NAME_RESULTS,
  MIN_CONTENT_LEN,
  matchParts,
  rankNameMatches,
  type PathEntry,
  type SearchMatch,
} from "../../lib/projects/projectSearch";
import { openFileEntry } from "../../lib/files/openFileEntry";
import { FileIcon } from "../common/icons/FileIcon";
import { useT } from "../../lib/i18n";
import { ArrowUpRightIcon } from "../common/icons/Icon";
import { confirmedArg, hpcGuardRefusal, withHpcConfirm } from "../../lib/remote/hpc/hpcGuard";

/** `error` state for a content search the user declined on a cluster. */
const DECLINED = "\u0000declined";

/** The `.ext` (lowercased, dot-included) of a path's basename, matching the
 *  shape `FileIcon` and `FileEntry.extension` use; "" when there is none. */
function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** Highlight the literal (case-insensitive) substring match in a path. */
function HighlightedPath({ text, query }: { text: string; query: string }) {
  const parts = matchParts(text, query, false);
  if (!parts) return <>{text}</>;
  return (
    <>
      {parts.before}
      <mark className="file-search-hl">{parts.hit}</mark>
      {parts.after}
    </>
  );
}

export function FileTreeSearch({
  projectDir,
  projectId,
  query,
  mode,
  caseSensitive,
  scopeRel,
  hostPinned = false,
  onReveal,
}: {
  projectDir: string;
  projectId: string | null;
  query: string;
  mode: "name" | "content";
  caseSensitive: boolean;
  /** Project-relative folder to confine the search to ("" = whole project).
   *  Filenames are filtered to this subtree; content search walks only it. */
  scopeRel: string;
  /** The project lives only on its host (`isHostPinned`): search there, with
   *  `projectDir` (its stored directory) and `scopeRel` as `relRoot`. */
  hostPinned?: boolean;
  onReveal: (rel: string, isDir: boolean) => void;
}) {
  const t = useT();
  const viewerPrefs = useSettingsStore((s) => s.settings?.viewer_prefs);
  const disabledViewerSet = useMemo(() => disabledViewers(viewerPrefs), [viewerPrefs]);
  // Root console: opened viewers are root's tabs (see tabScopeContext).
  const tabScope = useTabScope();

  // The absolute directory the search is confined to (content search walks it;
  // name results are filtered to it). Rel-path bookkeeping stays project-rooted:
  // a content hit's project-relative path is `scopeRel` + the backend's `rel`.
  const scopeDir = scopeRel ? resolvePath(projectDir, scopeRel) : projectDir;

  // Name-mode source: the whole project path list, fetched lazily on first use
  // and cached for this projectDir (cleared when the dir changes).
  const [paths, setPaths] = useState<PathEntry[]>([]);
  const [namesLoaded, setNamesLoaded] = useState(false);
  // The HPC question for the host listing was declined: say so, and do not ask
  // again on every keystroke (the dir change resets it).
  const [namesDeclined, setNamesDeclined] = useState(false);
  const pathsFor = useRef<string | null>(null);

  const [content, setContent] = useState<SearchMatch[]>([]);
  const [contentSearched, setContentSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const trimmed = query.trim();

  // Fetch the project path list once per projectDir, only when name search is
  // actually used (a query in name mode). The fetch is keyed to the *directory*,
  // not the query — every keystroke re-runs this effect (via `trimmed`), so it
  // must NOT abort the in-flight fetch on a query change: the once-per-dir guard
  // (`pathsFor.current === projectDir`) would then skip re-fetching and the
  // results would never load ("Searching…" forever). Instead we tag the request
  // with the dir it was for and drop only results whose dir is no longer current
  // — so a second keystroke can never strand the first (and only) fetch.
  useEffect(() => {
    if (mode !== "name" || !projectDir || !trimmed) return;
    if (pathsFor.current === projectDir) return; // already fetched/fetching this dir
    pathsFor.current = projectDir;
    setNamesLoaded(false);
    setNamesDeclined(false);
    setPaths([]);
    const forDir = projectDir;
    withHpcConfirm((confirmed) =>
      invoke<PathEntry[]>("list_project_paths", { projectDir, ...confirmedArg(confirmed) }),
    )
      .then((entries) => {
        if (pathsFor.current !== forDir) return; // dir changed since; stale result
        setPaths(entries);
        setNamesLoaded(true);
      })
      .catch((e) => {
        if (pathsFor.current !== forDir) return;
        const declined = hpcGuardRefusal(e) !== null;
        // A declined walk stays declined for this dir; anything else may retry.
        if (!declined) pathsFor.current = null;
        setNamesDeclined(declined);
        setPaths([]);
        setNamesLoaded(true);
      });
  }, [mode, projectDir, trimmed]);

  // A dir change needs no separate reset effect: the fetch above already keys on
  // `projectDir`, so a genuine switch re-runs it (`pathsFor.current !== new dir`)
  // and it clears + re-fetches for the new dir. With an empty query the stale
  // `paths` are never shown either — `nameResults` guards on `!trimmed`. A second
  // effect resetting `pathsFor` here would only race and strand that fetch.

  const nameResults = useMemo(() => {
    if (mode !== "name" || !trimmed) return [];
    return rankNameMatches(paths, trimmed, scopeRel);
  }, [mode, trimmed, paths, scopeRel]);

  // Content search: debounced call into the shared literal search backend,
  // confined to `scopeDir`.
  useEffect(() => {
    if (mode !== "content" || !scopeDir) return;
    if (trimmed.length < MIN_CONTENT_LEN) {
      setContent([]);
      setContentSearched(false);
      setError(null);
      setLoading(false);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    const timer = setTimeout(() => {
      // A host-pinned project names its folder scope relative to the project:
      // the host walk resolves it below the project's root.
      const where = hostPinned
        ? { projectDir, ...(scopeRel ? { relRoot: scopeRel } : {}) }
        : { projectDir: scopeDir };
      withHpcConfirm((confirmed) =>
        invoke<SearchMatch[]>("project_search", {
          ...where,
          query: trimmed,
          caseSensitive,
          maxResults: MAX_CONTENT_RESULTS,
          ...confirmedArg(confirmed),
        }),
      )
        .then((matches) => {
          if (reqId.current !== id) return;
          setContent(matches);
          setContentSearched(true);
          setError(null);
          setLoading(false);
        })
        .catch((e) => {
          if (reqId.current !== id) return;
          setContent([]);
          setContentSearched(true);
          // A declined HPC question is an answer, worded at render.
          setError(hpcGuardRefusal(e) ? DECLINED : String(e));
          setLoading(false);
        });
    }, CONTENT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [mode, scopeDir, trimmed, caseSensitive, hostPinned, projectDir, scopeRel]);

  // Opens through the same shared policy `FileTree`/`FileBrowser` use (native
  // viewer in the focused subwindow, reusing an already-open tab for that exact
  // file instead of stacking a duplicate) rather than always launching the OS
  // default app — a name-mode result can be any file in the project, and a
  // content-mode hit needs its tab open before `requestJump` can scroll it.
  function openEntry(rel: string, isDir: boolean, line?: number, col?: number) {
    if (isDir) {
      onReveal(rel, true);
      return;
    }
    const abs = resolvePath(projectDir, rel);
    const entry: FileEntry = {
      name: basename(abs),
      path: abs,
      is_dir: false,
      size: 0,
      extension: extensionOf(abs) || null,
      mime: null,
    };
    openFileEntry({
      entry,
      projectDir,
      projectId,
      origin: "side_file_tree",
      external: false,
      disabled: disabledViewerSet,
      scope: tabScope,
    });
    if (line != null) useEditorJumpStore.getState().requestJump(abs, line, col ?? 0);
  }

  if (mode === "content" && trimmed.length > 0 && trimmed.length < MIN_CONTENT_LEN) {
    return (
      <div className="file-tree-empty">
        {t("search.tooShort", { count: MIN_CONTENT_LEN })}
      </div>
    );
  }

  if (mode === "name") {
    if (!namesLoaded && paths.length === 0) {
      return <div className="file-tree-empty">{t("search.searching")}</div>;
    }
    if (namesDeclined) {
      return <div className="file-tree-empty">{t("search.hostDeclined")}</div>;
    }
    if (nameResults.length === 0) {
      return <div className="file-tree-empty">{t("fileTreeSearch.noMatchingFiles")}</div>;
    }
    return (
      <div className="file-search-results">
        <div className="file-search-count">
          {t(
            nameResults.length >= MAX_NAME_RESULTS
              ? nameResults.length === 1
                ? "fileTreeSearch.fileCountOnePlus"
                : "fileTreeSearch.fileCountManyPlus"
              : nameResults.length === 1
                ? "fileTreeSearch.fileCountOne"
                : "fileTreeSearch.fileCountMany",
            { count: nameResults.length },
          )}
        </div>
        {nameResults.map((e) => {
          // Display the path relative to the browsed scope; reveal/open stay
          // project-rooted (`e.path`).
          const displayPath = scopeRel ? e.path.slice(scopeRel.length + 1) : e.path;
          return (
          <div
            key={e.path}
            className={`file-entry file-search-row ${e.is_dir ? "dir" : "file"}`}
            title={t("fileTreeSearch.revealTitle", { path: e.path })}
            onClick={() => onReveal(e.path, e.is_dir)}
            onDoubleClick={() => openEntry(e.path, e.is_dir)}
          >
            <span className="file-icon"><FileIcon ext={extensionOf(e.path)} isDir={e.is_dir} /></span>
            <span className="file-name file-search-path">
              <HighlightedPath text={displayPath} query={trimmed} />
            </span>
            {!e.is_dir && (
              <button
                type="button"
                className="file-search-act"
                title={t("fileTreeSearch.openInViewerTab")}
                aria-label={t("fileTreeSearch.openFile")}
                onClick={(ev) => {
                  ev.stopPropagation();
                  openEntry(e.path, false);
                }}
              >
                <ArrowUpRightIcon />
              </button>
            )}
          </div>
          );
        })}
      </div>
    );
  }

  // content mode
  if (error === DECLINED) {
    return <div className="file-tree-empty">{t("search.hostDeclined")}</div>;
  }
  if (error) {
    return (
      <div className="file-tree-error" style={{ padding: "6px 8px", wordBreak: "break-all" }}>
        {error}
      </div>
    );
  }
  if (loading && content.length === 0) {
    return <div className="file-tree-empty">{t("search.searching")}</div>;
  }
  if (contentSearched && content.length === 0) {
    return <div className="file-tree-empty">{t("search.noResults")}</div>;
  }
  return (
    <div className="file-search-results">
      {content.length > 0 && (
        <div className="file-search-count">
          {t(
            content.length >= MAX_CONTENT_RESULTS
              ? content.length === 1
                ? "search.matchCountOnePlus"
                : "search.matchCountManyPlus"
              : content.length === 1
                ? "search.matchCountOne"
                : "search.matchCountMany",
            { count: content.length },
          )}
        </div>
      )}
      {content.map((m, i) => {
        const parts = matchParts(m.text, trimmed, caseSensitive);
        // The backend's `rel` is relative to `scopeDir`; re-root it at the
        // project so reveal/open address the same path the tree uses.
        const projectRel = scopeRel ? `${scopeRel}/${m.rel}` : m.rel;
        return (
          <div
            key={`${projectRel}:${m.line}:${m.col}:${i}`}
            className="file-entry file-search-row file-search-content"
            title={t("fileTreeSearch.openTitle", { path: `${projectRel}:${m.line}` })}
            onClick={() => openEntry(projectRel, false, m.line, m.col)}
          >
            <div className="file-search-content-body">
              <span className="file-search-loc">
                {m.rel}:{m.line}
              </span>
              <span className="file-search-line">
                {parts ? (
                  <>
                    {parts.before}
                    <mark className="file-search-hl">{parts.hit}</mark>
                    {parts.after}
                  </>
                ) : (
                  m.text
                )}
              </span>
            </div>
            <button
              type="button"
              className="file-search-act"
              title={t("fileTreeSearch.revealInTree")}
              aria-label={t("fileTreeSearch.revealInTree")}
              onClick={(ev) => {
                ev.stopPropagation();
                onReveal(projectRel, false);
              }}
            >
              ◎
            </button>
          </div>
        );
      })}
    </div>
  );
}
