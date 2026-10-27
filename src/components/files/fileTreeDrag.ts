// The file tree's drag gestures: the native OS drag-out (copy files out to
// another app — a warm-once preview icon and the platform split between our
// GTK drag and tauri-plugin-drag) and the pointer drag a row starts (to a tab
// bar, a popout, a new window, or a folder to move into).
import type React from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { subscribeTauri } from "../../hooks/useTauriListener";
import { useTabsStore } from "../../stores/tabs";
import { useDragStore, type EmbedCap, type FileDragItem } from "../../stores/drag/drag";
import { commitFileDrop, fileDropGoesToNewWindow } from "../tabs/commitFileDrop";
import { startDetachedDropSession } from "../tabs/detachedDropTargets";
import type { FileDropController } from "./fileDropContext";
import {
  startCursorPoll,
  desktopCursor,
  desktopCoordinatesSupported,
  snapshotFrame,
  physToClient,
  type PhysPoint,
  type WindowFrame,
} from "../../lib/window/coords";
import { bindDragRelease, dragPlatform, PLATFORM } from "../../lib/window/dragPlatform";
import { newDropToken, probeDropTarget } from "../../lib/window/dropClaim";
import { type FileEntry, type InternalViewer, internalViewerFor } from "../../lib/viewers/fileUtils";
import { resolveMoveTarget, createSpringLoader, type ResolvedMoveTarget } from "../../lib/projects/fileMove";
import { BRAND, NAMES } from "../../lib/brand";

// Native drag-out (tauri-plugin-drag) needs the OS drag-preview icon as a base64
// PNG data URL (its icon field rejects a bare path), read synchronously inside
// the `dragstart` gesture. The backend returns that data URL; cache it
// process-wide so every file row shares one warm-up (kicked off at mount) and
// reads it without awaiting.
let dragIconDataUrl = "";
let dragIconPromise: Promise<string> | null = null;
export function warmDragIcon(): Promise<string> {
  if (!dragIconPromise) {
    dragIconPromise = invoke<string>("drag_preview_icon")
      .then((p) => (dragIconDataUrl = p))
      .catch(() => "");
  }
  return dragIconPromise;
}

// Start the native OS drag-out (EXPORT/COPY to another app: a browser, Signal,
// a file manager, the desktop). Real OLE/NSDragging/GTK drag with an
// OS-rendered icon; copy semantics, so files are never MOVED out of the
// project. Reached two ways: a dir's HTML5 dragstart (handleEntryDragStart),
// and the mid-drag Ctrl handoff inside onEntryPointerDown.
export function beginNativeFileDrag(paths: string[]) {
  // Linux uses our own GTK drag (`start_file_drag`): tauri-plugin-drag's GTK
  // backend hands external targets an EMPTY payload — it tears down its
  // drag-data-get handler at drop-performed, before the target requests the
  // text/uri-list data — so a drop into a browser silently did nothing (it
  // also ships unencoded file:// URIs, which strict consumers discard).
  if (PLATFORM === "linux") {
    void invoke("start_file_drag", { paths }).catch((err) =>
      // Surfaces the most common failure: the backend wasn't rebuilt, so the
      // command doesn't exist yet — the drag silently no-ops otherwise.
      console.error(`[${BRAND.slug}] native file drag-out failed:`, err),
    );
    return;
  }
  const begin = (icon: string) =>
    startDrag({ item: paths, icon, mode: "copy" })
      .catch((err) => {
        // Same visibility for the plugin path (`plugin:drag|start_drag` and
        // `drag_preview_icon` only exist after a backend rebuild).
        console.error(`[${BRAND.slug}] native file drag-out failed:`, err);
      });
  // The icon data URL is normally warm by drag time; if not, resolve first.
  if (dragIconDataUrl) void begin(dragIconDataUrl);
  else void warmDragIcon().then(begin);
}

// Drag-to-move dwell before a hovered folder / crumb / ↑ spring-opens (the
// tree navigates there and the drag continues). Long enough that sweeping the
// cursor across folders toward a sibling never opens one by accident.
const SPRING_LOAD_MS = 650;

/** What a row's pointer drag reads from the tree it started in — the tree's
 *  state as of the render whose handler the press reached. */
export interface EntryDragContext {
  selected: Set<string>;
  entries: FileEntry[];
  disabledViewerSet: Set<InternalViewer>;
  relForEntry: (entry: FileEntry) => string;
  setMoveTarget: (target: ResolvedMoveTarget | null, crossEl?: HTMLElement | null) => void;
  projectId: string | null;
  projectDir: string;
  relPath: string;
  remoteListing: boolean;
  relPathRef: MutableRefObject<string>;
  load: (rel: string) => Promise<void>;
  fileDrop: FileDropController | null;
  moveTargetRef: MutableRefObject<ResolvedMoveTarget | null>;
  dragClickGuard: MutableRefObject<number>;
  moveEntryToFolder: (sourceRel: string, name: string, target: ResolvedMoveTarget, sourceAbs: string) => Promise<void>;
}

// Start a pointer-based drag from a file row, mirroring TabBar.onTabPointerDown.
// HTML5 native DnD is unreliable on WebKitGTK (it hijacks the pointer stream
// and fires pointercancel), so once the pointer crosses a 5px threshold we
// drive a "file" drag from plain window listeners. On drop, commitFileDrop
// either opens the file as a frameless embed tab (capability permitting) or
// falls back to an external launch.
//
// R6: we e.preventDefault() here to suppress native DnD and the row's
// `draggable`/onDragStart is disabled for files (see renderEntry), so both
// can't fire. The commit fires from THIS handler's window-pointerup — the
// only listener guaranteed to see the release before pointer capture on
// WebKitGTK — never from CenterPanel.
export function startEntryPointerDrag(
  ctx: EntryDragContext,
  e: React.PointerEvent,
  entry: FileEntry,
  dragTarget: InternalViewer | "embed" | null,
) {
  const {
    selected, entries, disabledViewerSet, relForEntry, setMoveTarget, projectId, projectDir,
    relPath, remoteListing, relPathRef, load, fileDrop, moveTargetRef, dragClickGuard,
    moveEntryToFolder,
  } = ctx;
  if (e.button !== 0) return;
  // A folder is dragged only to move it (`dragTarget` is null for one).
  // A built-in viewer drives the in-app drop; "embed" means an external
  // handler, so no viewer. `canTab` is whether this file can land on a tab bar
  // / new window at all — only such files take the commitFileDrop path on
  // release. Files without a tab target are still draggable, but ONLY to move
  // them into a folder (drag-to-move); released anywhere else they do nothing.
  const viewer = dragTarget === "embed" ? null : dragTarget;
  const canTab = dragTarget != null;
  // Multi-selection drag: if the pressed row belongs to a >1 selection, the
  // whole selection is dragged; otherwise just this row. `dragEntries` (files
  // + folders) drives drag-to-move; `dragFiles` (file members only, with their
  // built-in viewer resolved) is the tab/window drop payload — folders can move
  // but never become tabs. A release over a tab bar / split / new window
  // creates tabs when `canDrop`: for a single drag only a viewer/embed file
  // qualifies (unchanged); for a multi drag any file member becomes an embed
  // tab.
  const isMultiDrag = selected.has(entry.path) && selected.size > 1;
  const dragEntries = isMultiDrag ? entries.filter((en) => selected.has(en.path)) : [entry];
  const dragFiles: FileDragItem[] = dragEntries
    .filter((en) => !en.is_dir)
    .map((en) => ({ path: en.path, name: en.name, viewer: internalViewerFor(en, disabledViewerSet) ?? undefined }));
  const canDrop = isMultiDrag ? dragFiles.length > 0 : canTab;
  const draggedDirRels = dragEntries.filter((en) => en.is_dir).map(relForEntry);
  // Ctrl held → the user wants to EXPORT/COPY this file out to another app
  // (Signal, a browser, a file manager). The row arms HTML5 `draggable` while
  // `ctrlHeld` (see renderEntry); its onDragStart suppresses the broken
  // WebKitGTK drag and hands off to the native OS drag (handleEntryDragStart).
  // Bail out here without preventDefault so that gesture takes over instead of
  // the pointer drag-to-tab.
  if (e.ctrlKey) return;
  // Let the inline run (▶) button own its own clicks — don't seed a drag or
  // swallow the click when the press lands on it.
  if ((e.target as HTMLElement).closest(".file-run-btn")) return;
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  const pointerId = e.pointerId;
  const captureEl = e.currentTarget as HTMLElement;
  let dragging = false;
  // #42: an open popout of the current scope is a valid drop target — releasing
  // the file over one docks it there as an embed tab instead of spawning a new
  // window. SAME shared session the tab drag (TabBar) uses, so a file dragged
  // over a popout behaves exactly like one dragged over the main window.
  const detached = startDetachedDropSession();

  // Latest in-window client coords ("outside this window" test) and the latest
  // physical desktop cursor (cross-window hit-test, poll-driven — see lib/window/coords;
  // DOM screenX/Y units diverge across WebKitGTK/WebView2/WKWebView).
  let lastClient = { x: startX, y: startY };
  let lastPhys: PhysPoint | null = null;
  let stopPoll: (() => void) | null = null;

  // Mid-drag Ctrl → arms the native OS EXPORT drag (copy the file(s) out to
  // whatever app the cursor ends up over). Ctrl *before* the press is the
  // multi-select toggle, so export is armed by pressing Ctrl AFTER the drag
  // is underway — symmetric with Shift, which modifies the drop while
  // already dragging (see DragGhost's modifier highlight). Mirrors that:
  // holding Ctrl only MARKS the ghost's "copy out" option; the in-app hover
  // (ghost, folder highlight, popout hover) keeps running unchanged.
  //
  // The gesture then switches between two modes at the WINDOW BOUNDARY, and
  // can switch back and forth as often as the user likes:
  //  - leaving the window with Ctrl held → the OS drag takes over the still-
  //    held button (GTK can only BEGIN a drag while the button is physically
  //    down, so the crossing is the last moment this is possible), and a
  //    release out there drops into the external app.
  //  - coming back INTO the window → the OS drag is cancelled and the in-app
  //    ghost/hover resumes, so re-entering never leaves the user staring at
  //    an OS drag icon over Tabtivity's own window.
  // While the OS owns the drag the webview sees no pointer events at all, so
  // the boundary test runs off the OS-cursor poll (physical px → this
  // window's client px via the frame snapshot), which keeps ticking
  // regardless of who holds the pointer grab.
  let nativeActive = false;
  let frame: WindowFrame | null = null;
  // The `tabtivity:file-drag-ended` subscription (registered below, once the
  // gesture is real) and whether the gesture has already ended — `listen` is
  // async, so it can resolve after cleanup and must then unsubscribe at once.
  let unlistenEnded: (() => void) | null = null;
  let gestureOver = false;
  const inWindow = (c: { x: number; y: number }) =>
    c.x >= 0 && c.y >= 0 && c.x < window.innerWidth && c.y < window.innerHeight;
  const toNativeDrag = () => {
    if (!dragging || nativeActive) return;
    nativeActive = true;
    // The in-app drop targets are meaningless while the OS owns the drag.
    spring.cancel();
    setMoveTarget(null);
    detached.hover(null, { x: 0, y: 0 }, entry.name);
    beginNativeFileDrag(dragEntries.map((en) => en.path));
  };
  const backToInAppDrag = () => {
    if (!nativeActive) return;
    nativeActive = false;
    void invoke("cancel_file_drag").catch(() => {});
  };
  // Ctrl, tracked as gesture state rather than read off each pointer event.
  // Cancelling the GTK drag hands the pointer back, but NOT the implicit grab
  // the original pointerdown had: the webview then sees plain mousemove while
  // the cursor is over the window and NOTHING once it leaves. So after one
  // handoff, `PointerEvent.ctrlKey` stops arriving exactly where the next
  // handoff would need it — hence a flag the key events maintain, plus the
  // cursor poll below as the position source. (The keydown arm also covers
  // Ctrl pressed while the cursor already sits outside the window.)
  let ctrlDown = false;
  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key !== "Control") return;
    ctrlDown = true;
    if (dragging && !inWindow(lastClient)) toNativeDrag();
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    if (ev.key === "Control") ctrlDown = false;
  };

  const onMove = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      dragging = true;
      useDragStore.getState().startFileDrag({
        label: isMultiDrag ? `${dragEntries.length} items` : entry.name,
        pointerX: ev.clientX,
        pointerY: ev.clientY,
        filePath: entry.path,
        fileName: entry.name,
        viewer: viewer ?? undefined,
        files: isMultiDrag ? dragFiles : undefined,
      });
      // Built-in viewers render in-app and need no external handler, so skip
      // the embed-capability probe for them. For other embeddable files,
      // prefetch the capability so the drop can resolve embed-vs-external.
      if (!viewer && !entry.is_dir) {
        invoke<EmbedCap>("embed_capability", { path: entry.path, handler: null, projectId })
          .then((cap) => useDragStore.getState().setEmbedCap(cap))
          .catch(() => useDragStore.getState().setEmbedCap(null));
      }
      // Begin resolving popout drop targets now that a real drag is underway.
      void detached.resolve();
      // Capture the terminal pointer event on engines that don't keep delivering
      // it past the source window's HWND (Win/mac); WebKitGTK keeps the implicit
      // grab, so the flag leaves capture off there.
      if (dragPlatform.needsPointerCapture) {
        try {
          captureEl.setPointerCapture(pointerId);
        } catch {
          /* capture is best-effort; the OS-cursor poll does not depend on it */
        }
      }
      // This window's geometry, for mapping the polled OS cursor back into
      // client px while the OS drag owns the pointer (see `nativeActive`).
      void snapshotFrame()
        .then((f) => {
          frame = f;
        })
        .catch(() => {});
      // Poll the OS cursor (physical desktop px) to drive the popout hover past
      // the main viewport — DOM pointermove may not cross the OS window boundary.
      stopPoll = startCursorPoll((p) => {
        lastPhys = p;
        // The poll is the SOLE arbiter of the window boundary, in BOTH
        // directions. DOM pointer events can't be: once the OS drag has run
        // even once, the implicit grab is gone, so they stop at the window
        // edge — exactly where the crossing has to be detected.
        const c = frame ? physToClient(frame, p) : null;
        if (nativeActive) {
          if (!c) return;
          // The OS owns the pointer: this poll is also the only position
          // source, so keep the ghost tracking the cursor for the moment it
          // comes back in — whereupon the OS drag is cancelled and the
          // in-app hover takes over again.
          lastClient = c;
          useDragStore.getState().move(c.x, c.y);
          if (inWindow(c)) backToInAppDrag();
          return;
        }
        if (c && ctrlDown && !inWindow(c)) {
          toNativeDrag();
          return;
        }
        detached.hover(detached.at(p), p, entry.name);
      });
    }
    // While the OS drag owns the pointer, a stray DOM move must not fight the
    // poll for the ghost position or revive the in-app drop targets.
    if (nativeActive) return;
    ctrlDown = ev.ctrlKey;
    lastClient = { x: ev.clientX, y: ev.clientY };
    useDragStore.getState().move(ev.clientX, ev.clientY);
    hitTestMove(ev.clientX, ev.clientY);
    // Inside a detached popout, CenterPanel's window-wide drop authority isn't
    // there to resolve the pane under the cursor — do it here so the popout's
    // split/merge preview lights up and the release has a target to commit to.
    // (In the main window CenterPanel owns this; `fileDrop` is null there.)
    if (fileDrop) fileDrop.resolveTarget(ev.clientX, ev.clientY);
  };

  // Drag-to-move: highlight the folder row / breadcrumb / up button under the
  // cursor as the destination. The drag ghost is pointer-events:none, so
  // elementFromPoint reaches the rows beneath it — including rows of OTHER
  // mounted trees (a box member root, a Files tab of another project), so
  // every target carries its own tree's identity and `resolveMoveTarget`
  // decides what a drop there means: a same-tree move (dropping onto the
  // file's current folder is a no-op), a cross-project move (local↔local
  // only), or nothing. Runs on every pointermove, and once more after a
  // spring-load navigation lands (the rows under a still cursor changed).
  function hitTestMove(x: number, y: number) {
    const overEl = document.elementFromPoint(x, y) as HTMLElement | null;
    const moveEl = overEl?.closest<HTMLElement>("[data-move-rel]") ?? null;
    const target = moveEl
      ? {
          rel: moveEl.getAttribute("data-move-rel") ?? "",
          root: moveEl.getAttribute("data-move-root") ?? projectDir,
          remote: moveEl.getAttribute("data-move-remote") === "1",
        }
      : null;
    const resolved = resolveMoveTarget(target, {
      root: projectDir,
      folderRel: relPath,
      remote: remoteListing,
      draggedDirRels,
    });
    setMoveTarget(resolved, resolved?.crossRoot ? moveEl : null);
    // Spring-loading: hovering a folder row / crumb / ↑ of THIS tree navigates
    // there after a dwell, so the drag can reach folders the current listing
    // doesn't show. Same tree only — another tree's `load` is out of reach
    // from here. Not the folder already listed (nothing to open), and not a
    // folder that is itself being dragged (it can't hold itself).
    const springKey =
      target && target.root === projectDir && target.rel !== relPathRef.current
        ? target.rel
        : null;
    spring.hover(
      springKey !== null &&
        !dragEntries.some((de) => de.is_dir && relForEntry(de) === springKey)
        ? springKey
        : null,
      { x, y },
    );
  }
  const spring = createSpringLoader({
    delayMs: SPRING_LOAD_MS,
    onOpen: (rel) => {
      if (gestureOver || nativeActive) return;
      void load(rel).then(() => {
        // The listing under the (unmoved) cursor changed: re-resolve the drop
        // target against the new rows once React has painted them, so the
        // highlight and a release without further movement agree with what
        // the user sees.
        requestAnimationFrame(() => {
          if (!gestureOver && !nativeActive) hitTestMove(lastClient.x, lastClient.y);
        });
      });
    },
  });

  // Tear down the move listener, poll, popout highlight, and pointer capture —
  // however the gesture resolves.
  const cleanup = () => {
    gestureOver = true;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    spring.cancel();
    setMoveTarget(null);
    stopPoll?.();
    unlistenEnded?.();
    unlistenEnded = null;
    // Clear the popout highlight + tear down the panes listener. `targetAt`
    // still hit-tests the cached pane geometry for the commit below.
    detached.dispose();
    if (dragPlatform.needsPointerCapture) {
      try {
        captureEl.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  const commitRelease = async (shiftKey: boolean) => {
    const releasedAt = Date.now();
    // The OS owns the drag: it is dropping into an external app, and the
    // in-app drop targets don't apply. `tabtivity:file-drag-ended` ends the
    // gesture instead (a stray pointerup here must not ALSO spawn a tab or a
    // window on top of the export).
    if (nativeActive) return;
    // Read the drop-target folder BEFORE cleanup() runs — cleanup calls
    // setMoveTarget(null), which nulls moveTargetRef.current, so reading it
    // afterwards always saw null and silently dropped every drag-to-move (the
    // file just stayed put). See git dfcb6e0, which introduced the read below
    // the cleanup() call.
    const moveTarget = moveTargetRef.current;
    cleanup();
    // A release on the row the drag began on still fires its click, which on
    // a folder would navigate into it. Swallow that one click.
    if (dragging) dragClickGuard.current = Date.now();
    if (!dragging) {
      // Never moved → a plain click does NOT open. Opening a file is a
      // double-click (onDoubleClick → handleClick); dragging it onto a tab bar
      // is the other gesture. So a single click is a no-op here.
      return;
    }
    // Drag-to-move takes precedence: released over a folder / breadcrumb in the
    // tree → relocate the file(s) there. This is the one gesture available to
    // ALL files (even those with no tab/viewer target). When a multi-selection
    // is being dragged, every selected file moves. A cross-root target
    // (another project's tree in a box view, or another project's Files tab)
    // moves INTO that project — `move_path` confines each side to its own
    // root, so the two-root call is the supported shape.
    if (moveTarget != null) {
      useDragStore.getState().end();
      for (const de of dragEntries) {
        await moveEntryToFolder(relForEntry(de), de.name, moveTarget, de.path);
      }
      return;
    }
    const d = useDragStore.getState().drag;
    if (d == null) return;
    // A file with no tab/viewer/embed target can only be moved (handled above);
    // released anywhere else it does nothing — never leak it out as an external
    // open or an empty embed tab. (Multi drags qualify when any file member can
    // become a tab — see `canDrop`.)
    if (!canDrop) {
      useDragStore.getState().end();
      return;
    }
    // Inside a detached popout: commit against the pane resolved above by the
    // injected controller (a new embed tab into that pane, streamed to the main
    // window as an `add` edit). The main window's cross-window branches below —
    // dock into ANOTHER popout, spawn a new standalone window — don't apply
    // here (a popout can't own the main tab store), so this is the whole commit.
    if (fileDrop) {
      fileDrop.commit(d, projectDir);
      useDragStore.getState().end();
      return;
    }
    // Final physical cursor at release (a fresh read; falls back to the last
    // poll reading if the IPC fails). This is the canonical cross-window space.
    const phys = (await desktopCursor().catch(() => null)) ?? lastPhys;
    // Released over an open popout → dock the file into it as an embed tab,
    // landing in the SPECIFIC pane the popout resolved under the cursor (mirrors
    // a tab dragged onto a popout). BUT only if the popout is actually the front
    // window at the drop point: its bounds can geometrically contain the cursor
    // while it sits BEHIND the main window (the press raised the main window) or
    // another app. Docking into a popout the user can't see is wrong — treat an
    // occluded popout like a release into empty space so a NEW window opens.
    // Shift forces a brand-new standalone window even when released over a
    // front popout — the explicit "don't dock here, give me a fresh window"
    // override the user asked for.
    const overDetached = phys ? detached.at(phys) : null;
    const overFrontDetached =
      !shiftKey &&
      overDetached &&
      (await invoke<boolean>("detached_window_frontmost", {
        registryId: overDetached.label,
      }).catch(() => true));
    if (overDetached && overFrontDetached && phys) {
      commitFileDrop(d, projectId, projectDir, null, {
        scope: overDetached.scope,
        groupId: overDetached.groupId,
        target: detached.targetAt(overDetached, phys),
      });
      useDragStore.getState().end();
      return;
    }
    // Released OUTSIDE the main window (e.g. dragged onto another monitor):
    // open the file in its own standalone detached window at the cursor. Client
    // coords outside [0,inner) is the signal. The new window's bounds feed Rust
    // `.position(x,y)`, which is PHYSICAL → use the physical cursor, not DOM
    // screen coords.
    //
    // A popout under the cursor is NOT treated as "outside" here: a FRONT popout
    // was already docked into above; an OCCLUDED popout (behind the main window)
    // means the main window is what's actually under the cursor, so the release
    // must fall through to the in-window split — spawning a new window the user
    // can't see they're aiming at is exactly the bug this avoids.
    //
    // Shift forces a new window even when released INSIDE the main window: the
    // split/dock preview was suppressed during the drag (see CenterPanel's
    // pointer-move handler), so the only sensible commit is a fresh window.
    const outside = fileDropGoesToNewWindow({
      shiftKey,
      lastClient,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    });
    // No desktop geometry (native Wayland): `phys` is null, so the popout
    // hit-test above could not run — but a popout may well be under the
    // cursor. Ask this scope's windows to claim the release
    // (`lib/window/dropClaim`), exactly as a tab dragged out of the bar does;
    // the popout that receives the pointer answers with the pane under it.
    if (outside && !shiftKey && !phys && !(await desktopCoordinatesSupported())) {
      const scope = useTabsStore.getState().scope;
      const claim = await probeDropTarget({
        token: newDropToken(getCurrentWindow().label),
        scope,
        sourceLabel: getCurrentWindow().label,
        tabKey: "",
        label: d.label,
        releasedAt,
      });
      if (claim?.groupId) {
        commitFileDrop(d, projectId, projectDir, null, {
          scope,
          groupId: claim.groupId,
          target: claim.target ?? undefined,
        });
        useDragStore.getState().end();
        return;
      }
    }
    const detachBounds =
      outside && phys
        ? {
            x: Math.round(phys.x - 80),
            y: Math.round(phys.y - 8),
            w: 900,
            h: 640,
          }
        : null;
    commitFileDrop(d, projectId, projectDir, detachBounds);
    useDragStore.getState().end();
  };

  // Escape / blur / a genuine pointercancel (Win/mac) aborts: tear down and drop
  // any in-flight drag without committing.
  const onAbort = () => {
    cleanup();
    if (dragging) useDragStore.getState().end();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  const unbindRelease = bindDragRelease({
    onCommit: (shiftKey) => void commitRelease(shiftKey),
    onAbort,
  });
  // Once the OS drag owns the pointer, the webview never sees the release, so
  // the backend reports the drop (or the user's abort) that ends the whole
  // gesture. NOT fired by the cancel we ourselves issue on re-entry — that
  // hands control back to the in-app drag, which is still very much alive.
  // `listen` is async: the gesture can already be over when it resolves, and
  // `subscribeTauri` unlistens then.
  unlistenEnded = subscribeTauri(() => listen(NAMES.fileDragEndedEvent, () => {
    unbindRelease();
    onAbort();
  }));
}
