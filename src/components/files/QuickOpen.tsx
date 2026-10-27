/**
 * Quick-open / fuzzy file finder (Dev B), à la VS Code's Ctrl/Cmd+P.
 *
 * Mounted once in AppShell with no props. Registers a global Ctrl/Cmd+P key
 * handler that opens a centered modal palette: a query input + a fuzzy-ranked
 * list of the active project's files (from `list_project_paths`). Arrow keys /
 * Enter / Esc navigate; picking a file opens it in an in-app viewer tab via
 * `openLinkedFile` + `viewerForPath` (the same channel markdown link-following
 * uses). Fuzzy match + scoring live in the pure, unit-tested `src/lib/fuzzy.ts`.
 *
 * Reads the active project from `useProjectsStore` directly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../stores/projects";
import { resolveProjectDirectory } from "../../types";
import { fuzzyMatch, fuzzyRank } from "../../lib/fuzzy";
import { basename, resolvePath } from "../../lib/paths";
import { IS_MAC } from "../../lib/platform";
import { openLinkedFile, viewerForPath } from "../embed/fileViewer/openLinked";
import { openTexWorkspace } from "../../lib/viewers/tex/openTexWorkspace";
import { useT } from "../../lib/i18n";
import "./QuickOpen.css";

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
    if (positions.has(i)) {
      out.push(
        <span key={i} className="qo-hl">
          {text[i]}
        </span>,
      );
    } else {
      out.push(text[i]);
    }
  }
  return <>{out}</>;
}

export function QuickOpen() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Guards against a stale fetch landing after the palette re-opened.
  const fetchToken = useRef(0);

  const activeProjectDir = useCallback((): string => {
    const { projects, activeId } = useProjectsStore.getState();
    const project = projects.find((p) => p.id === activeId);
    return project ? resolveProjectDirectory(project) : "";
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setSelected(0);
  }, []);

  const loadFiles = useCallback(
    async (projectDir: string) => {
      const token = ++fetchToken.current;
      setLoading(true);
      setFiles([]);
      try {
        const entries = await invoke<PathEntry[]>("list_project_paths", { projectDir });
        if (token !== fetchToken.current) return; // superseded by a newer open
        setFiles(entries.filter((e) => !e.is_dir).map((e) => e.path));
      } catch {
        if (token !== fetchToken.current) return;
        setFiles([]);
      } finally {
        if (token === fetchToken.current) setLoading(false);
      }
    },
    [],
  );

  // Global Ctrl/Cmd+P toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && (e.key === "p" || e.key === "P")) {
        const dir = activeProjectDir();
        if (!dir) return; // no active project → leave the event alone
        // A focused PDF prints with this chord, which is what Ctrl+P means while
        // you are looking at a document. This listener is on `window` in the
        // CAPTURE phase and stops propagation, so the pane's own handler would
        // never run unless the palette stands aside first. Focus is the whole
        // test: with the palette's chord free again the moment focus leaves the
        // page stack, opening files by name costs one click elsewhere.
        if ((e.target as Element | null)?.closest?.(".file-viewer-pdf-host")) return;
        e.preventDefault();
        e.stopPropagation();
        setQuery("");
        setSelected(0);
        setOpen(true);
        void loadFiles(dir);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeProjectDir, loadFiles]);

  // Autofocus the input whenever the palette opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const results = useMemo(
    () => fuzzyRank(query, files, (f) => f).slice(0, MAX_RESULTS),
    [query, files],
  );

  // Keep the selection in range as results change.
  useEffect(() => {
    setSelected((s) => (results.length === 0 ? 0 : Math.min(s, results.length - 1)));
  }, [results]);

  // Keep the selected row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected, results]);

  const openFile = useCallback(
    (rel: string) => {
      const projectDir = activeProjectDir();
      if (!projectDir) return;
      const absPath = resolvePath(projectDir, rel);
      // A `.tex` opens (or focuses) the single TeX workspace for its document,
      // consistent with the FileTree; every other type opens its viewer tab.
      if (viewerForPath(absPath) === "tex") {
        void openTexWorkspace(absPath);
      } else {
        openLinkedFile(undefined, projectDir, {
          path: absPath,
          viewer: viewerForPath(absPath),
          label: basename(absPath),
        });
      }
      close();
    },
    [activeProjectDir, close],
  );

  const onInputKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => (results.length === 0 ? 0 : (s + 1) % results.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) =>
          results.length === 0 ? 0 : (s - 1 + results.length) % results.length,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = results[selected];
        if (pick) openFile(pick);
      }
    },
    [results, selected, close, openFile],
  );

  if (!open) return null;

  return (
    <div className="qo-backdrop" onMouseDown={close}>
      <div className="qo-panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="qo-input"
          type="text"
          placeholder={t("quickOpen.placeholder")}
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
            <div className="qo-empty">{t("quickOpen.loading")}</div>
          ) : results.length === 0 ? (
            <div className="qo-empty">
              {files.length === 0 ? t("quickOpen.noFiles") : t("quickOpen.noMatches")}
            </div>
          ) : (
            results.map((rel, idx) => (
              <div
                key={rel}
                data-idx={idx}
                className={"qo-row" + (idx === selected ? " qo-row-sel" : "")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  openFile(rel);
                }}
                onMouseEnter={() => setSelected(idx)}
              >
                <HighlightedPath text={rel} query={query} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
