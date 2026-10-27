import { Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { findTabByKey, useTabsStore, type ViewerState } from "../../../stores/tabs";
import { useSettingsStore } from "../../../stores/settings";
import { useEditorJumpStore } from "../../../stores/viewers/editorJump";
import { disabledViewers, type InternalViewer } from "../../../lib/viewers/fileUtils";
import { FileDropContext } from "../../files/fileDropContext";
import { UntestedTag } from "../../common/UntestedTag";
import { basename, dirname } from "../../../lib/paths";
import { PaneVisibleContext, usePaneVisible } from "../../../lib/files/fileAccess";
import {
  type TexFileDiagnostics,
  texRefCreation,
  addTexChildFile,
  gatherTexStructure,
  texStructureParent,
  type TexStructure,
  type TexFileNode,
} from "../../../lib/viewers/tex/tex";
import {
  chordLabel,
  chordMatches,
  resolveChord,
  type ShortcutMap,
} from "../../../lib/shortcuts/shortcuts";
import { TexStructureRail, TexStructureSidebar } from "../tex/TexStructureSidebar";
import { useDialogs } from "../../common/PromptDialogs";
import {
  compileTexWorkspace,
  registerTexWorkspace,
  unregisterTexWorkspace,
} from "../../../stores/viewers/texCenter";
import { useT } from "../../../lib/i18n";
import { PdfView } from "./lazyViewers";
import { seedViewerState } from "./viewerState";
import { openLinkedFile, viewerForPath } from "./openLinked";
import { jumpToSource } from "./sourceJump";
import { TextView } from "./TextView";
import { type TexCompileOpts, texCompileOptsFrom, texCompileViewerState } from "./texParts";
import { TexView } from "./TexView";
import { ImageView } from "./ImageView";

/** True when `path` is the main document or any enumerated child/graphic of the
 *  workspace structure — i.e. a target a sidebar/link switch should center rather
 *  than open in a new tab. */
function texWorkspaceContains(structure: TexStructure, path: string): boolean {
  const walk = (n: TexFileNode): boolean => {
    if (n.path === path) return true;
    if (n.graphics.some((g) => g.path === path)) return true;
    return n.children.some(walk);
  };
  return walk(structure.root);
}

// The most panes kept mounted in the workspace center at once. Switching between
// them is display:none, not remount, so an unsaved draft / undo / scroll of a
// file you flipped away from survives — the same guarantee two standalone `.tex`
// tabs have (CenterPanel keeps both mounted). Beyond the cap the LEAST-recently
// used CLEAN pane is dropped; a dirty pane (or the main file) is never evicted.
const TEX_WS_MAX_PANES = 12;
const TEX_WS_SIDEBAR_DEFAULT = 240;
// How many previously-centered files the workspace's ← button can walk back
// through. A cap rather than an unbounded list: nobody steps back through a
// hundred files, and the stack holds absolute paths for the life of the tab.
const TEX_WS_BACK_MAX = 50;

/**
 * The LaTeX WORKSPACE host: one tab that composes the left structure sidebar and
 * a keep-mounted center that switches between the reused `TexView` (a `.tex`) and
 * `ImageView`/`PdfView`/`TextView` (a graphic) for the selected file. The
 * compiled PDF is its OWN tab, opened beside the workspace via `openLinkedFile`.
 * SyncTeX still works both ways across that tab boundary: forward search lands via
 * the path-keyed `pdfSync` reveal, and a reverse click's `jumpToSource` routes
 * back into this workspace (`focusTexWorkspaceForSource`) to switch the center.
 *
 * It reuses the existing viewer components verbatim; the only new pieces are the
 * sidebar (a separate leaf) and this thin host. Everything the host needs is
 * already in `FileViewerPane`'s module scope (`TexView`, `ImageView`, `viewerForPath`,
 * `jumpToSource`), so it lives here inline rather than in its own file — that
 * avoids exporting the pane components and the `FileViewerPane ↔ workspace`
 * import cycle a separate file would create.
 *
 * One-side-per-tab: `mainPath` is the tab's EFFECTIVE path, so every child is
 * enumerated and shown on the same side (host SFTP vs local mirror) as the main.
 * Flipping the tab's Local/Remote switch re-roots `mainPath` and re-enumerates.
 */
export function TexWorkspaceView({
  mainPath,
  projectId,
  tabKey,
  groupId,
  onOpenExternally,
}: {
  mainPath: string;
  projectId: string | null;
  tabKey?: string;
  groupId?: string | null;
  onOpenExternally: () => void;
}) {
  const t = useT();
  const workspaceVisible = usePaneVisible();

  // The parsed document structure (children + graphics). Re-gathered on mount, on
  // a root/side change, and after each successful compile (structureVersion bump).
  // A gather failure degrades to a degenerate one-node structure so the sidebar —
  // and its UntestedTag pill — still render.
  const [structure, setStructure] = useState<TexStructure | null>(null);
  const [structureVersion, setStructureVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const disabled = disabledViewers(useSettingsStore.getState().settings?.viewer_prefs);
    gatherTexStructure(mainPath, projectId, disabled)
      .then((s) => { if (!cancelled) setStructure(s); })
      .catch(() => {
        if (!cancelled)
          setStructure({ root: { path: mainPath, label: basename(mainPath), graphics: [], children: [] } });
      });
    return () => { cancelled = true; };
  }, [mainPath, projectId, structureVersion]);

  // Where this tab's ViewerState (the centered file, the sidebar width) actually
  // lives. In the MAIN window the layout store owns it, and the reads below are
  // reactive so a sidebar/link switch re-renders. In a DETACHED popout the store
  // has NO entry for the tab — its tabs render from a Tauri seed into local React
  // state (see `seedViewerState`) — so a store read is forever undefined and a
  // store WRITE is a silent no-op, which pinned the center to the main file and
  // killed the sidebar-resize in a popout. So keep a local mirror seeded from the
  // persisted state, treat the
  // store as the source of truth only when it actually holds the tab, and persist
  // to BOTH (the store write round-trips through the main window's layout save;
  // in a popout it is a harmless no-op and the local mirror drives the UI).
  const storeVs = useTabsStore((s) =>
    tabKey ? findTabByKey(s, tabKey)?.viewerState : undefined,
  );
  const [localVs, setLocalVs] = useState<ViewerState>(() => seedViewerState(tabKey) ?? {});
  const patchViewerState = useCallback(
    (patch: ViewerState) => {
      setLocalVs((prev) => ({ ...prev, ...patch }));
      if (tabKey) useTabsStore.getState().setViewerState(tabKey, patch);
    },
    [tabKey],
  );

  // The centered file: the persisted `texActivePath` when it still resolves in the
  // structure, else the main document (a stale id is inert).
  const storedActive = storeVs?.texActivePath ?? localVs.texActivePath;
  const activePath = useMemo(() => {
    if (!storedActive || storedActive === mainPath) return mainPath;
    if (structure && !texWorkspaceContains(structure, storedActive)) return mainPath;
    return storedActive;
  }, [storedActive, mainPath, structure]);

  const setActivePath = useCallback((p: string) => patchViewerState({ texActivePath: p }), [patchViewerState]);

  // Where the center has BEEN, most-recent last — the back stack behind the ←
  // button. Clicking a child in the sidebar (or following a `\ref`, or a SyncTeX
  // reverse jump) replaces what is centered, and until this existed the only way
  // back to the chapter you came from was to find it in the tree again — which for
  // a graphic reached from a figure three files deep is a search rather than a
  // step. Session state, deliberately NOT persisted: a stack restored from disk
  // would offer to go "back" to a file this sitting never left, and where you were
  // ten minutes before a relaunch is not a thing anyone is holding in their head.
  // Bounded, because a long editing session walks a lot of files.
  const [backStack, setBackStack] = useState<string[]>([]);
  // A side switch (Local/Remote) re-roots every path in the workspace, so the
  // stack it was built from names files on the other side.
  useEffect(() => { setBackStack([]); }, [mainPath]);

  // THE navigation: every path that replaces the center goes through here — the
  // sidebar, an in-document link, a SyncTeX jump — so nothing can move the center
  // without the back stack learning about it. A re-select of what is already
  // centered is not a step, or ← would walk a file back onto itself.
  const goTo = useCallback(
    (p: string) => {
      if (p === activePath) return;
      setBackStack((prev) => [...prev, activePath].slice(-TEX_WS_BACK_MAX));
      setActivePath(p);
    },
    [activePath, setActivePath],
  );
  const backTarget = backStack[backStack.length - 1];
  const backLabel = backTarget ? basename(backTarget) : undefined;
  const goBack = useCallback(() => {
    if (backTarget === undefined) return;
    setBackStack((prev) => prev.slice(0, -1));
    setActivePath(backTarget);
  }, [backTarget, setActivePath]);

  // UP (#tex-structure-up): from a chapter to the `\input{chapter}` line of the
  // file that inputs it. Back retraces where the center has been; Up climbs the
  // document's own tree, so it works for a child reached by a sidebar click, a
  // SyncTeX jump or a restored tab alike — the parent need never have been
  // centered this sitting. It is a navigation like any other (through `goTo`,
  // so ← undoes it), followed by a caret jump to the reference itself: landing
  // at the parent's top would leave the reader searching the file for the line
  // they just came from, which is the whole thing this step exists to skip.
  const upTarget = useMemo(
    () => (structure ? texStructureParent(structure, activePath) : null),
    [structure, activePath],
  );
  const goUp = useCallback(() => {
    if (!upTarget) return;
    goTo(upTarget.path);
    if (upTarget.line) useEditorJumpStore.getState().requestJump(upTarget.path, upTarget.line, upTarget.column);
  }, [upTarget, goTo]);
  const upLabel = upTarget ? basename(upTarget.path) : undefined;

  // The two chords (Alt+Shift+↑ / Alt+Shift+↓ by default, rebindable in the
  // Keyboard Shortcuts panel). Listened for on the workspace's own root rather
  // than in `useKeyboard`: they mean nothing outside a workspace tab, so the
  // scope is "focus is somewhere in this workspace" — the editor's textarea,
  // the sidebar, a viewer in the center — which the bubbling keydown gives for
  // free, and which is exactly where the global hook's editable-target guard
  // would have dropped them. A workspace in a popout gets them the same way,
  // with no per-window wiring. Only a chord that can act is consumed.
  const shortcutOverrides = useSettingsStore((s) => s.settings?.keyboard_shortcuts) as
    | ShortcutMap
    | undefined;
  const upChord = useMemo(() => chordLabel(resolveChord("texUp", shortcutOverrides)), [shortcutOverrides]);
  const backChord = useMemo(() => chordLabel(resolveChord("texBack", shortcutOverrides)), [shortcutOverrides]);
  const onWorkspaceKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const ev = e.nativeEvent;
      if (upTarget && chordMatches(resolveChord("texUp", shortcutOverrides), ev)) {
        e.preventDefault();
        e.stopPropagation();
        goUp();
      } else if (backTarget !== undefined && chordMatches(resolveChord("texBack", shortcutOverrides), ev)) {
        e.preventDefault();
        e.stopPropagation();
        goBack();
      } else if (chordMatches(resolveChord("texCompile", shortcutOverrides), ev)) {
        // Compile from anywhere in the workspace that is not an editor pane —
        // the structure sidebar, the error list, the toolbar. A pane handles
        // the chord itself and stops it before it gets here; this is the
        // fallback, routed through the same registry the PDF's rebuild uses so
        // the mounted editor (which owns the draft and the options) runs the
        // build. Only consumed when someone answered.
        if (compileTexWorkspace(activePath) || compileTexWorkspace(mainPath)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    },
    [upTarget, backTarget, shortcutOverrides, goUp, goBack, activePath, mainPath],
  );

  // Advertise this workspace to SyncTeX reverse search (#42): a reverse click's
  // `focusTexWorkspaceForSource` centers it through the `texCenter` registry —
  // the ONLY route that reaches a popout, whose tabs store holds no entry a
  // `setViewerState(texActivePath)` could land in (the one-time `localVs` seed
  // above never re-reads the store, which is why the store-write route left a
  // popped-out workspace's center pinned and pdf→tex sync looking dead). Routed
  // through `goTo`, so the back stack records the step; `setActive` brings the
  // tab to the front of its group (in a popout it is forwarded as an ordinary
  // detached "activate" edit). The callback rides a ref so the registration is
  // one per mainPath, not one per render.
  const centerRef = useRef<(source: string) => void>(() => {});
  centerRef.current = (source: string) => {
    if (tabKey) useTabsStore.getState().setActive(tabKey);
    goTo(source);
  };
  useEffect(() => {
    const center = (source: string) => centerRef.current(source);
    registerTexWorkspace(mainPath, center);
    return () => unregisterTexWorkspace(mainPath, center);
  }, [mainPath]);

  // Keep-mounted center: the LRU list of mounted paths (most-recent last). The
  // active file is always mounted; the main file is pinned; a dirty pane is never
  // evicted (its unsaved draft would be lost).
  const [mounted, setMounted] = useState<string[]>(() => [mainPath]);
  const dirtyRef = useRef<Map<string, boolean>>(new Map());
  // Stable per-path dirty reporter, so TexView's onDirtyChange identity doesn't
  // churn every render.
  const dirtyHandlersRef = useRef<Map<string, (d: boolean) => void>>(new Map());
  const dirtyHandlerFor = useCallback((p: string) => {
    let h = dirtyHandlersRef.current.get(p);
    if (!h) {
      h = (d: boolean) => { dirtyRef.current.set(p, d); };
      dirtyHandlersRef.current.set(p, h);
    }
    return h;
  }, []);

  // Every mounted pane's `save`, so a Compile pressed in ANY pane first writes
  // EVERY pane's unsaved draft. Panes stay mounted (display:none) with their
  // drafts, and the build reads the files on disk: a chapter edited in one pane
  // and a Compile pressed in another built the chapter as last saved — and,
  // because nothing on disk had changed, latexmk reported "up-to-date" and the
  // old PDF came back as a success. Each `save` no-ops when its buffer is clean.
  const saveHandlersRef = useRef<Map<string, () => Promise<void>>>(new Map());
  const saveRegistrarsRef = useRef<Map<string, (save: () => Promise<void>) => () => void>>(
    new Map(),
  );
  const saveRegistrarFor = useCallback((p: string) => {
    let r = saveRegistrarsRef.current.get(p);
    if (!r) {
      r = (save: () => Promise<void>) => {
        saveHandlersRef.current.set(p, save);
        return () => {
          if (saveHandlersRef.current.get(p) === save) saveHandlersRef.current.delete(p);
        };
      };
      saveRegistrarsRef.current.set(p, r);
    }
    return r;
  }, []);
  const saveAllPanes = useCallback(async () => {
    await Promise.all([...saveHandlersRef.current.values()].map((save) => save()));
  }, []);

  // Follow the active file into the mounted LRU, evicting the least-recently-used
  // clean, non-main, non-active pane past the cap.
  useEffect(() => {
    setMounted((prev) => {
      if (prev[prev.length - 1] === activePath) return prev;
      const next = prev.filter((x) => x !== activePath);
      next.push(activePath);
      while (next.length > TEX_WS_MAX_PANES) {
        const idx = next.findIndex(
          (x) => x !== mainPath && x !== activePath && !dirtyRef.current.get(x),
        );
        if (idx < 0) break; // everything left is dirty/pinned — keep it
        next.splice(idx, 1);
      }
      return next;
    });
  }, [activePath, mainPath]);

  // Non-null inside a detached popout: the workspace's tabs render from a Tauri
  // seed into LOCAL state and the main tab store isn't ours, so a PDF tab has to
  // stream into THIS window through the file-drop controller (the Python-Run
  // seam), not `openLinkedFile` — which would silently add the tab to the main
  // window's store where this popout never renders it (the reported bug).
  const fileDrop = useContext(FileDropContext);

  // "Show the PDF" — the single path that puts the compiled PDF on screen, used
  // by both the compile's forward-search and the explicit Open-PDF button. The
  // PDF is its OWN tab, not docked in-tab, deduped by path so a recompile
  // refocuses the same tab (its own mtime poll reloads the fresh bytes) rather
  // than stacking a duplicate — in the main window via `openLinkedFile`, in a
  // popout via `fileDrop.openTab` (`addDetachedTab` does the same path dedupe).
  // Either way it lands in the workspace's own subwindow. TexView only calls this
  // once a PDF exists, so there is nothing to probe here.
  const openPdfTab = useCallback(
    (pdf: string) => {
      const label = basename(pdf);
      const cwd = dirname(pdf) || dirname(mainPath) || "/";
      if (fileDrop) {
        fileDrop.openTab({ label, cmd: "", cwd, kind: "embed", embedPath: pdf, viewer: "pdf" });
        return;
      }
      openLinkedFile(tabKey, cwd, { path: pdf, viewer: "pdf", label });
    },
    [tabKey, mainPath, fileDrop],
  );

  // A successful compile (from any mounted editor — a child builds the root too):
  // remember the output PDF, open/refocus its tab, and re-gather the structure (a
  // build may add an \input or a figure). Never auto-compiles on restore — this
  // only ever fires from an explicit build.
  const onCompiled = useCallback(
    (info: { pdfPath: string; pdfVersion: number }) => {
      setStructureVersion((v) => v + 1);
      openPdfTab(info.pdfPath);
    },
    [openPdfTab],
  );

  // Which FILE is broken, drawn on the structure tree (#tex-structure-errors).
  // The Errors/Warnings cards answer "what is wrong" from whichever pane the
  // reader is editing; in a document split across a dozen `\input`s that leaves
  // the more useful question open, and the sidebar is the one surface already
  // drawing the document as its files. Reported by every build, failed or not,
  // and reset when the workspace changes documents (a side switch re-roots every
  // path) — stale badges pointing at a previous document's lines would be worse
  // than none.
  const [diagnostics, setDiagnostics] = useState<Map<string, TexFileDiagnostics>>(new Map());
  useEffect(() => { setDiagnostics(new Map()); }, [mainPath]);

  // How this document is compiled, shared by every `.tex` pane in the workspace.
  // Every one of them builds the SAME main file (`resolve_tex_root` redirects a
  // child fragment to its parent), so the engine is a property of the document:
  // per-pane state meant compiling from a chapter rebuilt the parent under the
  // backend's default engine while the main file's own toolbar still read
  // `xelatex`. Persisted on the workspace tab like `texActivePath` beside it — a
  // document that only builds under `lualatex` builds under it in every sitting,
  // instead of reverting to the backend's default on the next launch and failing
  // the first compile of the day for a reason the toolbar no longer shows.
  // Read like `texActivePath` above: the store when it holds this tab, the local
  // mirror in a popout where it never will.
  const compileOpts = useMemo<TexCompileOpts>(
    () => texCompileOptsFrom({ ...localVs, ...storeVs }),
    [storeVs, localVs],
  );
  const patchCompileOpts = useCallback(
    (patch: Partial<TexCompileOpts>) => patchViewerState(texCompileViewerState(patch)),
    [patchViewerState],
  );

  // In-structure link/error targets switch the center; out-of-tree ones fall back
  // to the standalone tab open (a `.bib` → bib cards, an external file).
  const onFollowChild = useCallback(
    (resolved: { path: string; viewer: InternalViewer; label: string }) => {
      if (resolved.path === mainPath || (structure && texWorkspaceContains(structure, resolved.path))) {
        goTo(resolved.path);
        return true;
      }
      return false;
    },
    [mainPath, structure, goTo],
  );
  const onJumpToSource = useCallback(
    (input: string, line: number, column: number) => {
      if (input === mainPath || (structure && texWorkspaceContains(structure, input))) {
        goTo(input);
        useEditorJumpStore.getState().requestJump(input, line, column);
      } else {
        jumpToSource(input, line, column);
      }
    },
    [mainPath, structure, goTo],
  );

  // Sidebar width and fold, persisted per tab (store-or-local, see
  // `patchViewerState`). Absent `texSidebarHidden` means shown.
  const sidebarWidth = (storeVs?.texSidebarWidth ?? localVs.texSidebarWidth) ?? TEX_WS_SIDEBAR_DEFAULT;
  const sidebarHidden = (storeVs?.texSidebarHidden ?? localVs.texSidebarHidden) ?? false;
  const onResizeSidebar = useCallback(
    (w: number) => patchViewerState({ texSidebarWidth: w }),
    [patchViewerState],
  );
  const hideSidebar = useCallback(() => patchViewerState({ texSidebarHidden: true }), [patchViewerState]);
  const showSidebar = useCallback(() => patchViewerState({ texSidebarHidden: false }), [patchViewerState]);

  // The sidebar's ＋ (#tex-structure-newfile): name a file, get it created and
  // `\input` into the document, then centered. The reference lands in the file
  // currently being edited when that is a `.tex` (a chapter grows its own
  // sections), else in the main document — and a parent with unsaved edits is
  // refused up front, because splicing it on disk would be undone by the next
  // save of the older draft (`addTexChildFile` documents the precondition).
  const { promptText, dialogs } = useDialogs();
  const onNewFile = useCallback(() => {
    const parent = viewerForPath(activePath) === "tex" ? activePath : mainPath;
    const parentName = basename(parent);
    const disabled = disabledViewers(useSettingsStore.getState().settings?.viewer_prefs);
    void promptText(
      {
        title: (
          <>
            {t("texWorkspace.newFileTitle")} <UntestedTag id="texWorkspace.newFileTitle" />
          </>
        ),
        body: t("texWorkspace.newFileBody", { name: parentName }),
        label: t("texWorkspace.newFileLabel"),
        confirmLabel: t("common.create"),
        validate: (value) => {
          if (dirtyRef.current.get(parent)) return t("texWorkspace.newFileDirty", { name: parentName });
          return texRefCreation(parent, { command: "input", token: value }, disabled)
            ? null
            : t("texWorkspace.newFileInvalid");
        },
      },
      async (value) => {
        const added = await addTexChildFile(parent, value, projectId, disabled);
        if (!added) return; // validate already refused this shape
        setStructureVersion((v) => v + 1);
        goTo(added.path);
      },
    );
  }, [activePath, mainPath, projectId, promptText, goTo, t]);

  const centerFor = (p: string) => {
    const v = viewerForPath(p);
    const paneKey = p === mainPath ? tabKey : tabKey ? `${tabKey}#${p}` : undefined;
    if (v === "tex") {
      return (
        <TexView
          path={p}
          tabKey={paneKey}
          onOpenExternally={onOpenExternally}
          onOpenPdf={openPdfTab}
          onFollowChild={onFollowChild}
          onJumpToSource={onJumpToSource}
          onDirtyChange={dirtyHandlerFor(p)}
          onRegisterSave={saveRegistrarFor(p)}
          onSaveAll={saveAllPanes}
          onCompiled={onCompiled}
          onDiagnostics={setDiagnostics}
          compileOpts={compileOpts}
          onCompileOptsChange={patchCompileOpts}
        />
      );
    }
    if (v === "image") {
      return <ImageView path={p} fileName={basename(p)} tabKey={paneKey} onOpenExternally={onOpenExternally} />;
    }
    if (v === "pdf") {
      return <PdfView path={p} tabKey={paneKey} onOpenExternally={onOpenExternally} groupId={groupId} />;
    }
    // A `.tikz`/`.sty`/other graphic-adjacent source: the plain code editor.
    return <TextView path={p} tabKey={paneKey} onOpenExternally={onOpenExternally} groupId={groupId} />;
  };

  return (
    <div className="tex-workspace" onKeyDown={onWorkspaceKeyDown}>
      {sidebarHidden ? (
        <TexStructureRail
          onShow={showSidebar}
          onBack={backTarget ? goBack : undefined}
          backLabel={backLabel}
          backChord={backChord}
          onUp={upTarget ? goUp : undefined}
          upLabel={upLabel}
          upLine={upTarget?.line}
          upChord={upChord}
        />
      ) : structure ? (
        <TexStructureSidebar
          structure={structure}
          activePath={activePath}
          width={sidebarWidth}
          onSelect={(p, _v, line) => {
            goTo(p);
            // A badge click carries the line; a plain row click does not, and
            // leaves the caret where that file was last left.
            if (line) useEditorJumpStore.getState().requestJump(p, line, 1);
          }}
          diagnostics={diagnostics}
          onResize={onResizeSidebar}
          onHide={hideSidebar}
          onNewFile={onNewFile}
          onBack={backTarget ? goBack : undefined}
          backLabel={backLabel}
          backChord={backChord}
          onUp={upTarget ? goUp : undefined}
          upLabel={upLabel}
          upLine={upTarget?.line}
          upChord={upChord}
        />
      ) : (
        <div className="tex-structure-sidebar" style={{ width: sidebarWidth }}>
          <div className="tex-structure-header">
            <span className="tex-structure-title">{t("texWorkspace.structureTitle")}</span>
            <UntestedTag id="fileViewerPane.4" />
            <button
              type="button"
              className="tex-structure-chrome-btn tex-structure-fold"
              title={t("texWorkspace.hideStructure")}
              aria-label={t("texWorkspace.hideStructure")}
              onClick={hideSidebar}
            >
              ‹
            </button>
          </div>
        </div>
      )}
      <div className="tex-workspace-center">
        {mounted.map((p) => (
          <div
            key={p}
            className="tex-workspace-pane"
            style={{ display: p === activePath ? undefined : "none" }}
          >
            {/* PdfView is lazy (§5.1) and this center renders outside the
                pane-level Suspense above. */}
            <PaneVisibleContext.Provider value={workspaceVisible && p === activePath}>
              <Suspense fallback={null}>{centerFor(p)}</Suspense>
            </PaneVisibleContext.Provider>
          </div>
        ))}
      </div>
      {dialogs}
    </div>
  );
}
