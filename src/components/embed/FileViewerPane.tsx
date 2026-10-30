import { Suspense, useEffect, useMemo, useState } from "react";
import { useWindowsStore } from "../../stores/windows";
import { findTabByKey, useTabsStore } from "../../stores/tabs";
import { useExperimental } from "../../lib/experimental";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useRemoteMachinesStore } from "../../stores/remote/remoteMachines";
import { RemotePaneHold } from "../projects/RemotePaneHold";
import { PresentationOverlay } from "./PresentationOverlay";
import { usePresentationStore } from "../../stores/viewers/presentation";
import { type InternalViewer } from "../../lib/viewers/fileUtils";
import { basename, resolvePath } from "../../lib/paths";
import { useFileSourcesStore } from "../../stores/viewers/fileSources";
import {
  FileScopeContext,
  PaneVisibleContext,
  fileSource,
  FileSourceContext,
  type FileSource,
  readFileText,
  fileMtime,
} from "../../lib/files/fileAccess";
import { DiffView } from "./DiffView";
import { ViewerErrorBoundary } from "./ViewerErrorBoundary";
import { isTexDocumentRoot, resolveTexRoot } from "../../lib/viewers/tex/tex";
import {
  TableView,
  NotebookView,
  SqliteView,
  PdfView,
  DeckView,
  GifView,
  SyncMergeView,
  GitMergeView,
  OdtView,
  MediaView,
} from "./fileViewer/lazyViewers";
import { ViewerHeaderInfoContext, localMirrorRootFor, autoSyncRel } from "./fileViewer/ViewerHeader";
import { TextView } from "./fileViewer/TextView";
import { MarkdownView } from "./fileViewer/MarkdownView";
import { TexView } from "./fileViewer/TexView";
import { TexWorkspaceView } from "./fileViewer/TexWorkspaceView";
import { ImageView } from "./fileViewer/ImageView";
import { isHostPinned } from "../../lib/projectTabHost";
import { useDialogs } from "../common/PromptDialogs";
import { useT } from "../../lib/i18n";

interface Props {
  /** Which built-in viewer to render with. */
  viewer: InternalViewer;
  /** Absolute path of the file being viewed. */
  path: string;
  /** Owning project id (null in the root scope). */
  projectId: string | null;
  /** This viewer tab's key, so opened file links route to the SAME subwindow by
   *  default and drag-to-set-default can key its session-only override (#50). */
  tabKey?: string;
  /** Whether this pane is the active/visible tab of its group. Published to the
   *  nested viewers via `PaneVisibleContext`: display:none hides the pixels, but
   *  the standing work — the `file_mtime` auto-reload polls (an SFTP round trip
   *  each for a remote project), GIF playback — must stop too, or every hidden
   *  tab of every backgrounded project keeps paying it forever. */
  visible?: boolean;
  /** The subwindow (group) id hosting this pane, for proportional scroll-linking
   *  between two side-by-side viewer subwindows (see stores/viewers/scrollSync). Null/
   *  absent when the pane isn't in a syncable group; the sync hooks then no-op. */
  groupId?: string | null;
}

/**
 * Host for an in-app file viewer tab (TODO Group K #40). Unlike EmbedPane (which
 * opens the file in an external app), this renders the file's contents directly
 * inside the tab using a built-in viewer — independent of any external default
 * app:
 *   - "text"     → an editable code editor: a monospace textarea with a
 *                  line-number gutter, Tab/Shift+Tab indent, Ctrl+Shift+C
 *                  linewise comment toggle, and Ctrl+S save back to disk
 *                  (Python, Rust, JSON, config files, …).
 *   - "markdown" → rendered HTML via renderMarkdown, with an Edit/Preview toggle
 *                  that lets you edit the source and save it back to disk.
 *   - "yaml"     → YAML **and JSON** (which is YAML's flow syntax): the same
 *                  editor with a Tree/Source toggle, where the tree is an editable
 *                  structure view (rename a key, retype a value, add a key or a
 *                  list item, reorder, delete). It splices the file's own text, so
 *                  comments and layout survive, each collection keeps the style it
 *                  is written in (block or flow), and both modes share one draft.
 *   - "image"    → the bytes wrapped in a Blob URL, shown in a zoomable/pannable
 *                  <img> (wheel to zoom at cursor, drag to pan, Fit / 1:1).
 *   - "pdf"      → rendered with pdf.js into a scrolling stack of page canvases
 *                  with a zoom toolbar. Every surface is ours, so the surround
 *                  and scrollbar follow the app theme (a dark viewer in dark
 *                  themes); the pages render as authored.
 *   - "tex"      → the LaTeX viewer: the same code editor as "text", plus an
 *                  in-tab compile + PDF preview split when a TeX engine is on
 *                  PATH; it degrades to exactly the "text" editor otherwise.
 * An "Open externally" button is always offered as a fallback.
 */
export function FileViewerPane({ viewer, path, projectId, tabKey, visible = true, groupId }: Props) {
  const fileName = basename(path) || path;

  // The native presenter is experimental; with the flag off a deck opens as the
  // JSON it physically is. Read up here because the dispatch below sits after an
  // early return, and a hook cannot.
  const deckOn = useExperimental("deck_presenter");

  // A talk in progress withdraws this pane's marker/laser overlay — see the note
  // at the render below, and `stores/viewers/presentation` for why it is a store.
  const presenting = usePresentationStore((s) => s.presenting > 0);

  // Resolve whether these bytes are remote-native (host SFTP) or the local
  // mirror, and publish it to the tab strip so the Remote/Local badge rides on
  // this tab itself instead of costing a whole viewer header row (see the
  // fileSources store). Only remote (SSH) projects yield anything but "none";
  // the query is cheap (no file read) and re-runs when the path/scope changes.
  // The published entry is dropped when the viewer unmounts (tab closed).
  // `null` = not resolved yet; used by the disconnected-gate below to hold
  // rather than flash a red read error before we know the source.
  const [source, setSource] = useState<FileSource | null>(null);
  useEffect(() => {
    let cancelled = false;
    fileSource(path, projectId)
      .then((s) => {
        if (cancelled) return;
        setSource(s);
      })
      .catch(() => {
        if (cancelled) return;
        setSource("none");
      });
    return () => {
      cancelled = true;
    };
  }, [path, projectId]);

  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  // A host-pinned project (VM, remote-only) has no local copy: every file it
  // shows is read from the host, there is no other side to switch to, and the
  // tab carries no source badge (on such a project it would say nothing).
  const hostPinned = isHostPinned(project);
  const t = useT();
  const { showMessage, dialogs } = useDialogs();

  // A viewer tab is opened against one fixed absolute path (mirror OR host). For
  // a remote project this manual override lets the SAME tab show the other side
  // instead — same rel path, root swapped — without touching the tab's
  // persisted path. Session-only: resets to "no override" when the tab is
  // retargeted to a different file, so `effectiveSource` falls back to the file's
  // OWN resolved side (`source`, from `fileSource(path)`) — i.e. the side the
  // path already points at. That is the load-bearing default: `openFileEntry`
  // hands the viewer a *host* path when the tree that opened it was on Remote and
  // a *mirror* path when it was on Local, so trusting the path is what makes
  // "opened from a Remote listing ⇒ shown over SFTP" hold. Seeding instead from a
  // shared per-project pref (the old behaviour) let a stale/other-surface value
  // silently rewrite a host path back to the mirror — the Files-tab / subwindow
  // sidebar use an *independent* source that never writes that pref, so a file
  // opened there on Remote was read locally. `null` = follow the path.
  const [sideOverride, setSideOverride] = useState<"local" | "remote" | null>(null);
  useEffect(() => {
    setSideOverride(null);
  }, [path, projectId]);
  const rel = useMemo(() => autoSyncRel(project, path), [project, path]);
  const mirrorRoot = useMemo(() => localMirrorRootFor(project), [project]);
  const effectiveSource: FileSource = hostPinned ? "remote" : (sideOverride ?? source ?? "none");
  const effectivePath = useMemo(() => {
    if (!project?.remote || !rel) return path;
    if (effectiveSource === "remote") return resolvePath(project.remote.remote_path, rel);
    if (effectiveSource === "local" && mirrorRoot) return resolvePath(mirrorRoot, rel);
    return path;
  }, [project, rel, effectiveSource, mirrorRoot, path]);

  useEffect(() => {
    if (tabKey && !hostPinned) useFileSourcesStore.getState().setSource(tabKey, effectiveSource);
    return () => {
      if (tabKey) useFileSourcesStore.getState().clearSource(tabKey);
    };
  }, [tabKey, effectiveSource, hostPinned]);

  // Disconnected remote project: reading a remote-native (SFTP) file would block
  // on the dead pool and each nested viewer would flash its own red read error.
  // Instead show the SAME "Not connected" placeholder the remote shell uses, so
  // the message is unified across terminal and file tabs. Local-mirror files
  // (source "local") and local projects ("none") work offline and render as
  // usual; while the source is still unknown on a disconnected remote we hold.
  // Gated on the EFFECTIVE side, not the tab's opened side, so flipping the
  // switch to Remote while offline surfaces the same Connect prompt a
  // remote-native tab would — the toggle itself stays put (matches
  // ProjectFilesPane's `useFileSource`).
  const sshState = useRemoteStatusStore((s) => (projectId ? s.byProject[projectId]?.ssh : undefined));
  const openRemoteMachines = useRemoteMachinesStore((s) => s.open);
  const remoteDisconnected = !!project?.remote && sshState !== "connected";

  // Does this file exist on the host? A local-only file (never synced) has no
  // host counterpart, so flipping the Local/Remote switch to Remote would only
  // strand the viewer on an SFTP read error — disable that segment instead. Only
  // knowable on a live pool; disconnected / not-yet-probed leaves it enabled (the
  // disconnected gate above owns that case). One cheap SFTP stat per remote tab.
  const [remoteMissing, setRemoteMissing] = useState(false);
  const remoteRoot = project?.remote?.remote_path;
  useEffect(() => {
    setRemoteMissing(false);
    // `visible`: a hidden viewer needs no live switch state — without the gate,
    // every mounted viewer tab of every backgrounded remote project fired an
    // SFTP stat the moment the pool (re)connected. Re-shown, this re-runs and
    // probes once.
    // A host-pinned project has no switch, so nothing to probe for.
    if (!remoteRoot || !rel || sshState !== "connected" || !visible || hostPinned) return;
    let cancelled = false;
    fileMtime(resolvePath(remoteRoot, rel), projectId)
      .then(() => { if (!cancelled) setRemoteMissing(false); })
      .catch(() => { if (!cancelled) setRemoteMissing(true); });
    return () => { cancelled = true; };
  }, [remoteRoot, rel, sshState, projectId, visible, hostPinned]);
  // Mirror the Local/Remote switch out to the tab strip so its file-source badge
  // is a clickable toggle (not just a glyph): switching applies only when this
  // remote project's file has a counterpart on the other side (`rel`). Cleared
  // when it doesn't, and on unmount. Owns no state — `setSideOverride` stays here.
  useEffect(() => {
    if (!tabKey) return;
    const store = useFileSourcesStore.getState();
    if (project?.remote && rel && !hostPinned) {
      store.setControls(tabKey, {
        current: effectiveSource === "remote" ? "remote" : "local",
        set: setSideOverride,
        remoteDisabled: remoteMissing,
      });
    } else {
      store.clearControls(tabKey);
    }
    return () => {
      if (tabKey) useFileSourcesStore.getState().clearControls(tabKey);
    };
  }, [tabKey, project?.remote, rel, effectiveSource, remoteMissing, hostPinned]);

  // A `.tex` tab that is really a WORKSPACE, healing itself (#tex-structure).
  // `viewer` is persisted, so a `.tex` opened as a bare editor before the
  // one-workspace-per-document policy — or by any path that still makes a plain
  // editor tab — comes back as a bare editor for ever: no structure sidebar, and
  // Ctrl+click on an `\input` scatters a new tab instead of switching the center.
  // Two conditions together say "this tab is a whole document, shown as a
  // fragment": nothing includes it (`resolveTexRoot` answers with itself) AND it
  // declares a `\documentclass`. The second is what keeps a DELIBERATE child
  // editor tab (a drop, a followed link) a plain editor when its parent has never
  // been compiled and so is in no root map — a fragment has no class line. The
  // store lookup confines the write to a real tab of this exact file, so a pane
  // rendering some other path never rewrites the tab it sits in.
  useEffect(() => {
    if (viewer !== "tex" || !tabKey) return;
    const tab = findTabByKey(useTabsStore.getState(), tabKey);
    if (!tab || tab.kind !== "embed" || tab.viewer !== "tex" || tab.embedPath !== path) return;
    let cancelled = false;
    void (async () => {
      const root = await resolveTexRoot(path);
      if (cancelled || root !== path) return;
      const text = await readFileText(path, projectId).catch(() => null);
      if (cancelled || text == null || !isTexDocumentRoot(text)) return;
      useTabsStore.getState().setTabViewer(tabKey, "texworkspace");
    })();
    return () => { cancelled = true; };
  }, [viewer, tabKey, path, projectId]);

  if (remoteDisconnected && effectiveSource !== "local" && effectiveSource !== "none") {
    return (
      <RemotePaneHold
        host={project?.remote?.host ?? ""}
        onConnect={() => { if (projectId) openRemoteMachines(projectId); }}
      />
    );
  }

  const openExternally = () => {
    // A host file is not on this computer, so no app here can open it: say
    // where a copy comes from (the file tree's Download to…) instead of
    // handing the OS a path it does not have — the tree's own rule.
    if (effectiveSource === "remote") {
      void showMessage({
        title: t("fileTree.hostFileExternalTitle"),
        body: t("fileTree.hostFileExternalBody", { name: fileName }),
      });
      return;
    }
    useWindowsStore
      .getState()
      .openFile(effectivePath, undefined, projectId, "side_file_tree")
      .catch((e) => console.error(e));
  };

  // Pick the concrete viewer, then publish this pane's owning project as the file
  // scope so every nested viewer/hook confines its file commands to this project
  // (and its box siblings) regardless of which project is globally current.
  // Every viewer below reads `effectivePath` — the tab's own opened path unless
  // the Local/Remote switch has retargeted it to the same rel path's other root
  // — EXCEPT "diff"/"syncdiff", which already compare both sides directly and
  // whose single `path` prop means something else in that mode.
  let view: React.ReactNode;
  if (viewer === "gif") {
    // Animated GIFs get the frame-transport viewer (#gifviewer); the plain
    // image viewer remains its opt-out fallback (VIEWER_FALLBACK).
    view = <GifView path={effectivePath} fileName={fileName} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "image") {
    view = <ImageView path={effectivePath} fileName={fileName} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "pdf") {
    view = <PdfView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} groupId={groupId} />;
  } else if (viewer === "markdown") {
    view = <MarkdownView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} groupId={groupId} />;
  } else if (viewer === "tex") {
    view = <TexView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "texworkspace") {
    // The LaTeX workspace: one tab hosting a structure sidebar + a center that
    // switches between the TeX editor and the image viewer for the selected file.
    // The compiled PDF opens as its OWN tab (SyncTeX both ways still works — the
    // reveal/jump channels are path-keyed, so they cross tab and window). `mainPath`
    // is the EFFECTIVE path so children enumerate on the same side (host SFTP vs
    // local mirror) as the shown main — the workspace follows one side per tab.
    view = (
      <TexWorkspaceView
        mainPath={effectivePath}
        projectId={projectId}
        tabKey={tabKey}
        groupId={groupId}
        onOpenExternally={openExternally}
      />
    );
  } else if (viewer === "table") {
    view = <TableView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "notebook") {
    view = <NotebookView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "diff") {
    view = <DiffView path={path} projectId={projectId} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "syncdiff") {
    view = <DiffView path={path} projectId={projectId} mode="sync" onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "syncmerge") {
    view = <SyncMergeView path={path} projectId={projectId} tabKey={tabKey} />;
  } else if (viewer === "gitmerge") {
    view = <GitMergeView path={path} projectId={projectId} tabKey={tabKey} />;
  } else if (viewer === "odt") {
    view = <OdtView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "media") {
    view = <MediaView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "html") {
    // HTML is now the editable base editor with a sandboxed live preview, keyed
    // to its own per-type prefs.
    view = <TextView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} type="html" groupId={groupId} />;
  } else if (viewer === "eldeck") {
    // The presenter is experimental. Gated HERE rather than in `naturalViewerFor`
    // so a deck still resolves to a viewer for drag-to-tab and the hover card; with
    // the flag off it opens as what it physically is — JSON — in the structure tree.
    view = deckOn ? (
      <DeckView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} groupId={groupId} />
    ) : (
      <TextView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} type="yaml" groupId={groupId} />
    );
  } else if (viewer === "sqlite") {
    view = <SqliteView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "yaml") {
    // YAML is the same base editor, with the structure tree as its "preview" half
    // (#yaml) and its own per-type prefs.
    view = <TextView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} type="yaml" groupId={groupId} />;
  } else if (viewer === "bib") {
    // A `.bib` is the same base editor too, with the bibliography CARD list as its
    // "preview" half (see BibCards) — one card per entry, editing this very draft.
    view = <TextView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} type="bib" groupId={groupId} />;
  } else {
    view = <TextView path={effectivePath} onOpenExternally={openExternally} tabKey={tabKey} groupId={groupId} />;
  }
  const sourceSwitch =
    project?.remote && rel && !hostPinned
      ? {
          current: (effectiveSource === "remote" ? "remote" : "local") as "local" | "remote",
          onChange: setSideOverride,
          remoteDisabled: remoteMissing,
        }
      : null;
  return (
    <FileScopeContext.Provider value={projectId}>
      <PaneVisibleContext.Provider value={visible}>
      {/* The side the viewer's bytes come from (`useFileSource`): the Mark up
          gate and SyncTeX read it. Until `file_source` answers, a remote
          project's file counts as remote — the side that offers less. */}
      <FileSourceContext.Provider
        value={hostPinned ? "remote" : (sideOverride ?? source ?? (project?.remote ? "remote" : "none"))}
      >
      <ViewerHeaderInfoContext.Provider value={{ path: effectivePath, projectId, sourceSwitch }}>
        {/* A single relative host so the marker/laser presentation overlay can
            sit over ANY viewer without each one wiring it in (see
            PresentationOverlay). `.presentation-host` is height:100% so the
            existing `.file-viewer` (also 100%) fills it unchanged.

            Withdrawn while a deck presenter is on screen: the presenter renders
            through a portal *over* this pane and mounts its own overlay, so this
            one is invisible and inert — but its window-level Escape listener is
            not, and a second handler competing for Escape mid-talk is exactly
            what made holstering the laser end the talk (TODO V #98). */}
        <div className="presentation-host">
          {/* Fallback null: a lazy viewer's chunk loads in milliseconds off
              local disk, and any placeholder would flash for exactly that. */}
          {/* One boundary for every viewer (threat model row 28): a viewer that
              throws while rendering shows a card in this pane instead of
              unmounting the window. Reset when the file or viewer changes. */}
          <ViewerErrorBoundary
            resetKey={`${viewer}\u0000${effectivePath}`}
            sourcePath={TEXT_SOURCE_VIEWERS.has(viewer) ? effectivePath : null}
            projectId={projectId}
            onOpenExternally={NO_OPEN_EXTERNALLY_VIEWERS.has(viewer) ? null : openExternally}
          >
            <Suspense fallback={null}>{view}</Suspense>
          </ViewerErrorBoundary>
          {!presenting && <PresentationOverlay />}
        </div>
        {dialogs}
      </ViewerHeaderInfoContext.Provider>
      </FileSourceContext.Provider>
      </PaneVisibleContext.Provider>
    </FileScopeContext.Provider>
  );
}

/** Viewers whose file is text, so the error boundary can offer it as plain
 *  source. Binary viewers (images, PDF, ODT, media, SQLite, spreadsheets) and
 *  the comparison views, whose `path` means something else, are left out. */
const TEXT_SOURCE_VIEWERS: ReadonlySet<InternalViewer> = new Set<InternalViewer>([
  "text", "markdown", "tex", "texworkspace", "html", "yaml", "bib", "eldeck", "notebook",
]);

/** Views whose header has no "Open externally" (the merge resolvers: their
 *  `path` names a conflict, not one file the OS should open), so the error
 *  boundary's card does not offer it either. */
const NO_OPEN_EXTERNALLY_VIEWERS: ReadonlySet<InternalViewer> = new Set<InternalViewer>([
  "syncmerge", "gitmerge",
]);
