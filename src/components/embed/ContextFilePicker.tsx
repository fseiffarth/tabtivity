/**
 * QuickOpen-style file picker for attaching reference files as local-autocomplete
 * context (#45 context files). Modelled on `QuickOpen` but used as a controlled
 * modal (mounted while open) instead of a global Ctrl/Cmd+P singleton: it lists
 * the editor's project files via `list_project_paths`, fuzzy-ranks them with the
 * shared `src/lib/fuzzy.ts`, and calls `onPick(rel)` for the chosen file. Files
 * already attached are shown ticked and are picked-through to a no-op by the
 * caller. Reuses the `.qo-*` styles from QuickOpen.css.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { fuzzyMatch, fuzzyRank } from "../../lib/fuzzy";
import { useT } from "../../lib/i18n";
import { isHostPinned } from "../../lib/projectTabHost";
import { useProjectsStore } from "../../stores/projects";
import { sshOf, useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { confirmedArg, hpcGuardRefusal, withHpcConfirm } from "../../lib/remote/hpc/hpcGuard";
import { resolveProjectDirectory } from "../../types";
import "../files/QuickOpen.css";

interface PathEntry {
  path: string;
  is_dir: boolean;
}

const MAX_RESULTS = 50;

/** Render the rel path with the fuzzy-matched characters emphasised. */
function HighlightedPath({ text, query }: { text: string; query: string }) {
  const positions = useMemo(() => {
    if (!query) return null;
    const m = fuzzyMatch(query, text);
    return m ? new Set(m.positions) : null;
  }, [text, query]);

  if (!positions || positions.size === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  for (let i = 0; i < text.length; i++) {
    out.push(
      positions.has(i) ? (
        <span key={i} className="qo-hl">
          {text[i]}
        </span>
      ) : (
        text[i]
      ),
    );
  }
  return <>{out}</>;
}

export function ContextFilePicker({
  projectDir,
  roots,
  attached,
  onPick,
  onClose,
}: {
  /** Project root whose files are offered (empty → "No project"). */
  projectDir: string;
  /** Multi-root mode (a BOX scope): the roots to offer — box folder + member
   *  roots — with a selector row above the search. When set, the active root
   *  replaces `projectDir` as the listing root and `onPick` receives its dir.
   *  Single-project callers omit it and are unchanged. */
  roots?: { label: string; dir: string }[];
  /** Relative paths already attached, shown ticked. */
  attached: string[];
  /** Add the picked file (root-relative path). `dir` names the root the pick
   *  came from (multi-root mode); single-root callers can ignore it. The picker
   *  stays open so several files can be added; Esc / backdrop closes it. */
  onPick: (rel: string, dir?: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [rootIdx, setRootIdx] = useState(0);
  const activeRoot = roots && roots.length > 0 ? roots[Math.min(rootIdx, roots.length - 1)] : null;
  const listDir = activeRoot?.dir ?? projectDir;
  // A host-pinned project's files are listed on its host
  // (`list_project_paths` resolves its stored directory, the registry's exact
  // one matched here): only while that host is connected — a listing against a
  // dead session would only wait on it — and behind the HPC guard's retry.
  const pinned = useProjectsStore((s) =>
    listDir ? s.projects.find((p) => isHostPinned(p) && resolveProjectDirectory(p) === listDir) : undefined,
  );
  const pinnedDown = useRemoteStatusStore((s) => !!pinned && sshOf(s, pinned.id) !== "connected");
  const [declined, setDeclined] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const attachedSet = useMemo(() => new Set(attached), [attached]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setDeclined(false);
    if (!listDir || pinnedDown) {
      setFiles([]);
      setLoading(false);
      return;
    }
    withHpcConfirm((confirmed) =>
      invoke<PathEntry[]>("list_project_paths", { projectDir: listDir, ...confirmedArg(confirmed) }),
    )
      .then((entries) => {
        if (!alive) return;
        setFiles(entries.filter((e) => !e.is_dir).map((e) => e.path));
      })
      .catch((e) => {
        if (!alive) return;
        setDeclined(hpcGuardRefusal(e) !== null);
        setFiles([]);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [listDir, pinnedDown]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(
    () => fuzzyRank(query, files, (f) => f).slice(0, MAX_RESULTS),
    [query, files],
  );

  useEffect(() => {
    setSelected((s) => (results.length === 0 ? 0 : Math.min(s, results.length - 1)));
  }, [results]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selected, results]);

  const onInputKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => (results.length === 0 ? 0 : (s + 1) % results.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => (results.length === 0 ? 0 : (s - 1 + results.length) % results.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = results[selected];
        if (pick) onPick(pick, listDir);
      }
    },
    [results, selected, onClose, onPick, listDir],
  );

  // Portal out of the editor: the picker is mounted deep inside `.pane-layer`
  // (a `position:absolute; z-index:2` stacking context), so a `position:fixed`
  // backdrop rendered in place has its z-index resolved *within* that context and
  // paints under the rest of the UI (invisible). Portal it up to the app's root
  // element so `z-index` reaches the top of the page.
  //
  // Target `#root` (the React app surface, painted in BOTH the main and detached
  // windows) rather than `document.body`: a body-level portal can fail to paint
  // in the detached pop-out webview, so the overlay went missing there. `#root`
  // is still outside `.pane-layer`, so it escapes the trap just the same. Falls
  // back to `document.body` if `#root` isn't present (e.g. in tests).
  const portalTarget =
    (typeof document !== "undefined" && document.getElementById("root")) ||
    (typeof document !== "undefined" ? document.body : null);
  if (!portalTarget) return null;
  return createPortal(
    <div className="qo-backdrop qo-context-backdrop" onMouseDown={onClose}>
      <div className="qo-panel qo-context-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="qo-context-header">{t("contextFilePicker.title")}</div>
        {roots && roots.length > 1 && (
          // BOX scope: pick which root the page source comes from — the box
          // folder or any member project's tree.
          <div className="qo-root-row">
            {roots.map((r, idx) => (
              <button
                key={`${r.dir}|${idx}`}
                type="button"
                className={"qo-root-btn" + (idx === rootIdx ? " qo-root-sel" : "")}
                onClick={() => {
                  setRootIdx(idx);
                  setSelected(0);
                }}
                title={r.dir}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}
        <input
          ref={inputRef}
          className="qo-input"
          type="text"
          placeholder={t("contextFilePicker.placeholder")}
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onInputKey}
        />
        <div className="qo-list" ref={listRef}>
          {loading ? (
            <div className="qo-empty">{t("common.loading")}</div>
          ) : results.length === 0 ? (
            <div className="qo-empty">
              {!listDir
                ? t("contextFilePicker.noProject")
                : pinnedDown
                  ? t("projectFilesPane.disconnectedHostOnly", { host: pinned?.remote?.label || pinned?.remote?.host || "" })
                  : declined
                  ? t("search.hostDeclined")
                  : files.length === 0
                  ? t("quickOpen.noFiles")
                  : t("quickOpen.noMatches")}
            </div>
          ) : (
            results.map((rel, idx) => (
              <div
                key={rel}
                data-idx={idx}
                className={"qo-row" + (idx === selected ? " qo-row-sel" : "")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(rel, listDir);
                }}
                onMouseEnter={() => setSelected(idx)}
              >
                <span>
                  {attachedSet.has(rel) ? "✓ " : ""}
                  <HighlightedPath text={rel} query={query} />
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
