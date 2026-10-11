/**
 * #42: detached-subwindow message passing + pure reducers.
 *
 * Two WebViews (main + detached) are separate JS heaps and CANNOT share a
 * Zustand store, so the main window streams the detached group's tab payloads +
 * subtree to the detached window over Tauri events, and the detached window
 * streams edits back. The MAIN window remains the single owner of project.json
 * writes — the detached window never persists.
 *
 * This module holds the pure, unit-testable bits: the `?detached=` URL parser
 * and the seed/edit payload builders + appliers. The wiring (listeners) lives in
 * `DetachedApp` / the main shell.
 */
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useTabsStore,
  orderedTabKeys,
  findGroupOfTab,
  mapGroup,
  removeKeyFromTree,
  splitSubtree,
  applyResize,
  moveKeyInTree,
  allGroups,
  isPtyTabKind,
  normalizeTodoId,
  type DetachedGroup,
  type DropEdge,
  type LayoutNode,
  type LocalityHost,
  type TabEntry,
  type TabLocation,
  type ViewerState,
  type WindowBounds,
} from "./tabs";
import { useProjectsStore } from "./projects";
import { noteClosedPopoutTabs, reopenClosedAgentTab } from "./agents/closedAgentTabs";
import {
  PRIMARY_HOST,
  hostStateOf,
  sshOf,
  useRemoteStatusStore,
  type ConnState,
  type HostConnState,
} from "./remote/remoteStatus";
import { BOX_SCOPE_PREFIX, boxFolderOfScope, useBoxesStore } from "./boxes";
import { useActivityStore, noteAgentResting, noteTurnCutOff, noteUserInput, type AttentionKind, type BusyKind } from "./activity";
import { bumpUsage } from "./usage";
import { useRemoteMachinesStore } from "./remote/remoteMachines";
import { useBigFoldersStore } from "./bigFolders";
import { resolveProjectDirectory, type ProjectBox, type ProjectEntry } from "../types";
import { isTabColor, type TabColor } from "../lib/theme/tabColors";
import { normalizeStackName } from "../lib/tabStacks";
import { isTabMark, type TabMark } from "../lib/tabMarks";

/** Parsed `?detached=<scope>:<groupId>` query. */
export interface DetachedParam {
  scope: string;
  groupId: string;
}

/**
 * Parse the query that selects the DetachedApp render branch. Returns null when
 * absent (→ render the normal AppShell).
 *
 * The backend now writes two keys — `?detached=<scope>&group=<groupId>` — so a
 * scope may contain anything: a box scope is `box:<id>` (#224), and the old
 * single-value form `?detached=<scope>:<groupId>` split on the FIRST colon, which
 * read that as scope `"box"` and group `"<id>:g-3"`. The host then found no
 * record, never answered the seed, and the popout destroyed itself after 8 s
 * with the group's tabs stranded in a `detached:true` record. The legacy form
 * is still accepted (a popout URL minted by an older backend) and splits on the
 * LAST colon: a group id (`g-3`, `s-12`) never contains one, a scope may.
 */
export function parseDetachedParam(search: string): DetachedParam | null {
  const params = new URLSearchParams(search);
  const raw = params.get("detached");
  if (!raw) return null;
  const group = params.get("group");
  if (group) {
    return raw ? { scope: raw, groupId: group } : null;
  }
  const idx = raw.lastIndexOf(":");
  if (idx < 0) return null;
  const scope = raw.slice(0, idx);
  const groupId = raw.slice(idx + 1);
  if (!scope || !groupId) return null;
  return { scope, groupId };
}

/**
 * Tauri event names. The SEED is namespaced by the detached window's label so a
 * targeted emit only re-seeds that one window. Edits/dock-back flow back on
 * single GLOBAL channels carrying their identity (`scope`/`groupId`/`label`),
 * because the main window doesn't statically know every detached label to
 * subscribe per-window.
 */
export const detachedSeedEvent = (label: string) => `detached-seed-${label}`;
/** The detached window emits this (with its label) to ask the main for a seed. */
export const DETACHED_REQUEST_SEED = "detached-request-seed";
/** Detached → main: a tab edit (activate/rename/close/reorder). */
export const DETACHED_EDIT = "detached-edit";
/** Detached → main: request to dock this group back into the main window. */
export const DETACHED_DOCK = "detached-dock";
/**
 * Detached → main: the popout's OS window was closed (WM/title-bar close). Unlike
 * DETACHED_DOCK, this CLOSES the group's tabs for good — they are not docked back
 * and do not restore on next launch.
 */
export const DETACHED_CLOSE = "detached-close";
/**
 * Detached → main: hide this popout into the main window's side-panel "Hidden
 * subwindows" list instead of docking it live (DETACHED_DOCK) or discarding it
 * (DETACHED_CLOSE). The group's tabs stay mounted (PTYs alive); the main window
 * parks its subtree in `hiddenGroupsByScope`, from which it is restored or closed
 * exactly like a hidden main-window subwindow. Same envelope shape as the dock.
 */
export const DETACHED_HIDE = "detached-hide";
/**
 * Detached → main: the popout's Ctrl+Shift+T. The closed-tab list lives in the
 * main window (`stores/agents/closedAgentTabs`), so the popout only asks; the
 * main window reopens the newest agent tab closed there (else in the scope)
 * into that popout. Same envelope shape as the dock.
 */
export const DETACHED_REOPEN = "detached-reopen";
/** Detached → main: the popout's OS geometry changed (persisted for respawn). */
export const DETACHED_BOUNDS = "detached-bounds";
/**
 * Detached → main: the popout's own UI zoom changed (Ctrl +/- in the popout).
 * Zoom is per-window, so the main window records it on the popout's detached
 * entry (persisted, and shipped back in the seed) — never touching the global
 * `ui_zoom` or any other window.
 */
export const DETACHED_ZOOM = "detached-zoom";
/**
 * #42: cross-window drag-to-dock. The detached window streams the gesture to the
 * main window, which renders the dock preview and docks the group on release.
 * START opens the preview, MOVE updates it, and END commits (or cancels). One
 * popout drags at a time, so MOVE/END carry no id.
 *
 * The streamed coords are OS-level desktop CURSOR coords in PHYSICAL desktop px
 * (the canonical cross-window space — see `lib/window/coords`), polled from
 * `cursorPosition()` — NOT DOM pointer-event coords. DOM `screenX/Y` units diverge
 * across engines under DPI scaling, and on WebKitGTK (esp. Wayland) DOM
 * pointermove/up don't cross the OS window boundary, so the DOM stream would die at
 * the popout's edge. Polling the OS cursor keeps MOVE flowing over the main window
 * in a single DPI-correct frame, and END carries the last polled cursor position so
 * the drop resolves where the cursor really is. The receiver converts physical →
 * its-own-client px at the leaf (`physToClient`), the only DPI-correct place.
 */
export const DETACHED_DRAG_START = "detached-drag-start";
export const DETACHED_DRAG_MOVE = "detached-drag-move";
export const DETACHED_DRAG_END = "detached-drag-end";

/**
 * Group B #234 — detached → main: what the user did in a popout's terminal, for
 * the activity classifier that lives ONLY in the main window. Main's "working" /
 * "done" derivation requires input this session (`stores/activity`'s
 * `noteUserInput`), and a popout's `TerminalView` used to record that input into
 * the popout's own, never-read activity store — so a popped-out agent never lit
 * the project pill. `seen` is the popout's equivalent of activating a tab
 * (`clearAttention`); `bell` is the terminal bell.
 */
export const DETACHED_ACTIVITY = "detached-activity";
export interface DetachedActivityEnvelope {
  ptyId: string;
  /** `interrupt` is input that cuts the agent off (a bare Escape, Ctrl+C) —
   *  the one keystroke the classifier reads differently (see
   *  `activity.noteUserInput`). `cutoff` is a spawn that found the tab's
   *  previous process died mid-turn (`activity.noteTurnCutOff`), `resting`
   *  one whose previous process finished its turn (`activity.noteAgentResting`). */
  kind: "input" | "interrupt" | "seen" | "bell" | "cutoff" | "resting";
}

/**
 * Group B #234 — detached → main: one usage counter bump. The popout's own
 * `stores/usage` accumulator is never flushed (only AppShell flushes), so a
 * prompt typed in a popout never reached the daily recap.
 */
export const DETACHED_USAGE = "detached-usage";
export interface DetachedUsageEnvelope {
  scope: string;
  key: string;
  n: number;
}

/**
 * Group B #234 — main → detached: the classified status of THIS popout's tabs
 * (working / needs-decision / finished / interrupted), namespaced per label like the seed. The
 * popout's own activity store has no PTY history to classify from, so the main
 * window — which sees every PTY's output — mirrors its verdict over, and the
 * popout's strip paints the same lamps `TabBar` does.
 */
export const detachedStatusEvent = (label: string) => `detached-status-${label}`;
export type DetachedTabStatus =
  | "working"
  | "working-shell"
  | "working-both"
  | "needs-decision"
  | "finished"
  | "interrupted";
export interface DetachedStatusPayload {
  scope: string;
  /** tab key → status; a tab with nothing to say is absent. */
  status: Record<string, DetachedTabStatus>;
}

/**
 * Group B #233 — detached → main: open a dialog whose host is mounted only in
 * the main window. The stores behind these dialogs forward the request here when
 * they run in a popout heap (`isDetachedWindow`), because the alternative — a
 * button that flips a store nobody in this window renders — is a dead button.
 */
export const DETACHED_OPEN_DIALOG = "detached-open-dialog";
export interface DetachedOpenDialogEnvelope {
  kind: "remoteMachines" | "bigFolders";
  projectId: string;
}

/**
 * Group B #224 — backend → main: a `detached-*` window was destroyed. Emitted
 * from the `WindowEvent::Destroyed` hook for every popout death. Legitimate
 * teardowns drop the store record BEFORE the window goes, so the host finds no
 * record and does nothing; a record still standing means the popout died
 * behind the store's back (a display change, `xkill`, a renderer crash, a seed
 * timeout). The popout is reopened from that record; only one that has kept
 * giving up on its own (DETACHED_GAVE_UP) for minutes is docked back rather
 * than stranded.
 */
export const DETACHED_WINDOW_DESTROYED = "detached-window-destroyed";
export interface DetachedWindowDestroyedEnvelope {
  label: string;
}

/**
 * Popout → main, right before a popout destroys itself because no seed ever
 * arrived. Its death is then the window's own failure, which may end in a dock
 * back; any other death was done TO a working window (a compositor dropping it
 * while a monitor goes away) and only reopens it.
 */
export const DETACHED_GAVE_UP = "detached-gave-up";
export interface DetachedGaveUpEnvelope {
  label: string;
}

/**
 * #42: main → detached drop preview. The mirror image of the DETACHED_DRAG_*
 * stream: while a tab dragged OUT of the main window hovers over a popout, the
 * main window streams `active:true` on the popout's label-namespaced channel so
 * it highlights itself as a drop target; `active:false` (cursor left, released
 * elsewhere, or drag cancelled) clears it. The dock itself is a main-side store
 * mutation (`dockTabIntoDetached`) + re-seed — the popout only renders the
 * highlight, never owns the layout. Namespaced per label (like the seed) so the
 * main targets exactly the one popout under the cursor.
 */
export const detachedDropPreviewEvent = (label: string) =>
  `detached-drop-preview-${label}`;
/**
 * Main → detached: drive THIS popout's drop preview while a tab/file dragged out
 * of the main window hovers it. The host resolves WHICH pane the cursor is over
 * (synchronously, from the popout's reported geometry — see DETACHED_PANES) and
 * streams the resolved `target` here; the popout renders the per-pane split/merge
 * preview for it (no release race — the host already holds the target on release).
 * `active:false` clears the preview. `label` is the dragged item's name (ghost).
 */
export interface DetachedDropPreview {
  active: boolean;
  target?: { groupId: string; edge: DropEdge } | null;
  // OS cursor in PHYSICAL desktop px (see lib/window/coords) so the popout can position
  // its own drag ghost while the main-window item hovers (the main's ghost lives in
  // the main window and isn't visible over the popout). Cosmetic — the target
  // drives the drop.
  cursorPhysX?: number;
  cursorPhysY?: number;
  label?: string;
}

/**
 * Host → detached: ask a popout to report its per-pane geometry so the host can
 * hit-test the cursor against it. Sent once when a drag starts (the popout's tree
 * is fixed until the drop). Namespaced by label so only the addressed popout
 * replies. The popout answers on DETACHED_PANES.
 */
export const DETACHED_PANES_REQUEST = "detached-panes-request";
export interface DetachedPanesRequest {
  label: string;
}
/**
 * Detached → host: this popout's panes in CLIENT px (its own getBoundingClientRect
 * space). The host converts the physical cursor into THIS popout's client px via
 * its `innerPosition`/scale (`physToClient` — never `outerPosition`, so an
 * invisible frame/shadow can't skew it) before hit-testing against these: over a
 * bar → merge into that group; over a body → edge-split (pickEdge). One channel
 * carrying the label, so the host needs a single listener.
 */
export const DETACHED_PANES = "detached-panes";
export interface PaneRect {
  groupId: string;
  bar: { left: number; top: number; right: number; bottom: number };
  body: { left: number; top: number; right: number; bottom: number };
}
export interface DetachedPanes {
  label: string;
  panes: PaneRect[];
}

/**
 * Detached → main: begin a drag-to-dock. Without `tabKey`/`paneId` it drags the
 * WHOLE popout (the titlebar, or the bar grip of a single-pane popout); with
 * `tabKey` it drags that single tab, which the host docks on its own via
 * `attachDetachedTab`; with `paneId` it drags ONE pane (an inner group) of a
 * multi-pane popout, which the host docks via `attachDetachedPane` — never the
 * whole popout, so the sibling panes stay floating.
 */
export interface DetachedDragStart {
  scope: string;
  groupId: string;
  label: string;
  cursorPhysX: number;
  cursorPhysY: number;
  tabKey?: string;
  paneId?: string;
}
/** Detached → main: the OS cursor moved (physical desktop px — see lib/window/coords). */
export interface DetachedDragMove {
  cursorPhysX: number;
  cursorPhysY: number;
}
/**
 * Detached → main: the drag ended; `cancelled` skips docking. `cursorPhysX/Y` carry
 * the LAST OS-level cursor position (physical desktop px — see lib/window/coords), so the
 * main window resolves the drop against where the cursor actually is — not the
 * stale DOM coordinates of the release event, which on WebKitGTK fire inside the
 * popout even when the cursor is released over the main window. Absent only on a
 * cancel.
 */
export interface DetachedDragEnd {
  cancelled: boolean;
  cursorPhysX?: number;
  cursorPhysY?: number;
  /**
   * Shift held at release → keep the popout floating as its own window instead of
   * docking it back into the main window (mirrors the main-window tab rule where
   * Shift always means "new window"). For a drag that originates in a popout, the
   * popout already IS a separate window, so "always new window" = don't dock.
   */
  shift?: boolean;
}

/** The seed the main window ships to a freshly-opened detached window. */
export interface DetachedSeed {
  scope: string;
  groupId: string;
  tabs: TabEntry[];
  subtree: LayoutNode;
  /**
   * Set only when this seed is the result of a tab being docked INTO the popout
   * from another window (a cross-window merge): the docked tab's key, so the
   * popout plays the same drop-in landing flourish it would for an in-popout
   * merge. Absent on a plain (re)seed, so a refresh never re-animates.
   */
  landedKey?: string;
  /**
   * The popout's persisted per-window zoom (undefined = 100%). The popout applies
   * it to its OWN webview on the FIRST seed, restoring the zoom it was left at
   * (zoom is per-window, not the global `ui_zoom`). Later re-seeds carry the
   * up-to-date value but the popout ignores it — it owns its zoom once open.
   */
  zoom?: number;
  /**
   * The owning project's identity, captured at seed time — the detached window
   * is inert to the projects store, so this is how its tab strip renders the
   * locality badge/menu and names the machine a tab runs on
   * (`docs/multi_host_remote_plan.md`), and how its file viewers resolve a
   * project at all (#232). Present for EVERY project scope now, local ones
   * included — `primaryHost` is what says "remote"; a local project ships its
   * entry with no host. Absent only for the root scope. Refreshed by the host's
   * context subscriber whenever the entry or its SSH state changes (#238), so it
   * no longer waits for an unrelated reseed.
   */
  remote?: DetachedRemoteInfo;
}

/** The slice of a project's identity a detached window needs (streamed in the
 *  seed since the projects store is unavailable there). Named for the remote
 *  case it started as; since #232 it is the popout's whole project context. */
export interface DetachedRemoteInfo {
  primaryHost?: string;
  computeHosts?: LocalityHost[];
  /**
   * A box scope's member projects (`box:<id>`), so a "Files — ⟨member⟩" tab in
   * a popped-out box subwindow can resolve its member by root the way the main
   * window's `ProjectFilesTab` does from the projects store.
   */
  boxMembers?: ProjectEntry[];
  /** The owning box record required by box-scoped selectors in the popout. */
  box?: ProjectBox;
  /**
   * The owning project entry, streamed because the popout is inert to the
   * projects store. Without it a docked (or popped-out) file viewer can't render
   * its Local/Remote source switch or the run-host picker — both are gated on
   * `project.remote`, and the popout otherwise resolves no project at all and
   * treats the tree as a plain local folder. Same seed-time-snapshot bargain as
   * `computeHosts`: it can go stale if the project's remote config changes while
   * the popout is open (re-seed only on a tab add/edit).
   */
  project?: ProjectEntry;
  /**
   * The primary host's live SSH state at seed time. The popout seeds its OWN
   * (otherwise empty) remoteStatus store with it so the file viewer's Remote side
   * isn't reported as blocked — the backend SFTP pool is shared across windows,
   * so a Remote read works from the popout once its status store says connected.
   * Stale between re-seeds (a connect made after pop-out lands at the next seed).
   */
  primarySsh?: ConnState;
  /** Live primary + worker connection state, keyed by host id. */
  hostStates?: Record<string, HostConnState>;
}

/** Build a seed payload from a detached popout's tabs + subtree. Pure. The
 *  subtree may be a split (multi-pane popout), so collect keys across the tree.
 *  `zoom` is the popout's persisted per-window zoom (from its detached entry);
 *  `remote` names the machines a locatable tab can run on (undefined = local). */
export function buildSeed(
  scope: string,
  groupId: string,
  allScopeTabs: TabEntry[],
  subtree: LayoutNode,
  zoom?: number,
  remote?: DetachedRemoteInfo,
): DetachedSeed {
  const keys = new Set(orderedTabKeys(subtree));
  // Ship only the popout's own tabs (it renders just this subtree).
  const tabs = allScopeTabs.filter((t) => keys.has(t.key));
  return { scope, groupId, tabs, subtree, zoom, remote };
}

/**
 * Edits the detached window streams back to the main window. Last-writer-wins;
 * one group, so conflicts are rare.
 */
export type DetachedEdit =
  | { kind: "activate"; key: string }
  | { kind: "rename"; key: string; label: string }
  // A tab colour picked in the popout's own right-click menu (#264). The colour
  // lives on the tab payload the MAIN window persists, so the popout forwards it
  // the way it forwards a rename.
  | { kind: "setColor"; key: string; color: TabColor | undefined }
  // A tab joining or leaving a tab group (`TabEntry.stack`) — payload-only,
  // forwarded like the colour.
  | { kind: "setStack"; key: string; stack: string | undefined }
  // A tab's Important / Urgent mark and its to-do card link
  // (`TabEntry.mark` / `.todoId`) — payload-only, forwarded like the colour.
  | { kind: "setMark"; key: string; mark: TabMark | undefined }
  | { kind: "setTodo"; key: string; todoId: string | undefined }
  // `user`: a close the user asked for in the popout (×, Ctrl+W, the tab menu),
  // remembered for "Reopen closed agent tab"; the experiment sweep leaves it off.
  | { kind: "close"; key: string; user?: boolean }
  | { kind: "reorder"; tabKeys: string[] }
  // Multi-host: change WHERE a locatable tab runs (local mirror / primary / a
  // worker), chosen from the popout's own locality badge. The detached tab's PTY
  // is owned by the MAIN window's flat pane layer, so the main window applies this
  // to `tabsByScope` (which respawns that pane on the new host); the popout applies
  // it to its own tab payload optimistically so the badge updates at once.
  | { kind: "setLocation"; key: string; location: TabLocation }
  // New tab created FROM the popout's own "+" menu, or a file dropped onto a pane
  // inside the popout. The detached window can't mint the store-unique tab key (or
  // own the PTY), so it ships the resolved payload + the popout group it should
  // land in; the MAIN window mints the key, adds the payload (spawning/owning the
  // PTY), and re-seeds the popout so it renders it. With `edge` set to a side
  // (left/right/top/bottom) the tab carves a NEW pane at that edge of the target
  // group (a file dropped on a body edge); omitted or "center" appends it to the
  // target group (the "+" menu, or a drop on a tab bar / pane centre).
  | { kind: "add"; tab: Omit<TabEntry, "key">; targetGroupId: string; edge?: DropEdge }
  // Multi-pane popouts: split `key` into a new pane at `edge` of `targetGroupId`.
  // The popout mints the new pane's ids (`mintDetachedSplitIds`) and ships them,
  // so the main store's copy of the tree names the pane exactly as the popout
  // does — each window has its own id counter, and a pane named differently on
  // the two sides is one the popout can report as a drop target but the main
  // store cannot find.
  | {
      kind: "split";
      key: string;
      targetGroupId: string;
      edge: DropEdge;
      newGroupId?: string;
      newSplitId?: string;
    }
  // Multi-pane popouts: resize the divider between children i and i+1 of a split.
  | { kind: "resize"; splitId: string; dividerIndex: number; fraction: number }
  // Multi-pane popouts: merge `key` into `targetGroupId` (at `index`, else append).
  | { kind: "move"; key: string; targetGroupId: string; index?: number }
  // Toggle/resize a group's docked file-viewer column (the per-subwindow right
  // file viewer), or record the folder it browsed to. Applied optimistically
  // popout-side, mirrored by the main window into its detached record so the
  // state persists + survives a dock.
  | { kind: "files"; groupId: string; open?: boolean; width?: number; folder?: string }
  // Group B #231 — pane writes forwarded by the popout's store seam
  // (`stores/detachedContext`): viewer state (scroll/zoom/breakpoints…), a tmux
  // session rename, a Files tab's browsed folder. Payload-only; no node change.
  | { kind: "setViewerState"; key: string; patch: ViewerState }
  | { kind: "setTmuxName"; key: string; name: string }
  | { kind: "setFolder"; key: string; folder: string }
  | { kind: "setUrl"; key: string; url: string }
  // A tab bound for ANOTHER scope's layout (an install command's root-scope tab
  // opened from a popout): the main window adds it there with `addTabToScope`.
  | { kind: "addToScope"; scope: string; tab: Omit<TabEntry, "key"> };

/** Envelope for a detached→main edit (identity + the edit itself). */
export interface DetachedEditEnvelope {
  scope: string;
  groupId: string;
  edit: DetachedEdit;
}

/** Envelope for a detached→main dock-back request. */
export interface DetachedDockEnvelope {
  scope: string;
  groupId: string;
  /** DETACHED_CLOSE only: the user closed these tabs (the last tab's ×, the
   *  window close's "Close tabs"), so their agent tabs are remembered for a
   *  reopen. Absent for the experiment sweep's close. */
  user?: boolean;
}

/** Envelope for a detached→main geometry update. */
export interface DetachedBoundsEnvelope {
  scope: string;
  groupId: string;
  bounds: WindowBounds;
}

/** Envelope for a detached→main per-window zoom update. */
export interface DetachedZoomEnvelope {
  scope: string;
  groupId: string;
  zoom: number;
}

/** Identity the detached window sends when requesting its seed. */
export interface DetachedSeedRequest {
  label: string;
  scope: string;
  groupId: string;
}

/**
 * Apply a `DetachedEdit` to a detached group's subtree, returning the new
 * subtree. Pure — used by the main window to keep its `detachedGroupsByScope`
 * entry in sync (and to recompute what the detached window should render). The
 * tab PAYLOAD updates (rename label) are applied to `tabs` separately by the
 * caller; this only updates the group node (tabKeys/activeKey).
 */
/**
 * Ids for the nodes a popout-side split creates, minted in the POPOUT and sent
 * along with the `split` edit so the main store uses the same ones. Namespaced
 * by the popout's window label: the id counters of the two windows run
 * independently, so a bare `g-<n>` minted here could collide with a node the
 * main store already has. (Ids are regenerated anyway when a popout docks back.)
 */
let _detachedNodeCounter = 0;
export function mintDetachedSplitIds(
  label: string,
  /** Ids already in the popout's tree. The counter restarts at 0 when the popout's
   *  webview reloads (the renderer watchdog, the crash reporter), so without this
   *  a post-reload split could re-mint an id a pane minted before the reload still
   *  carries (#227) — and `splitSubtree` then silently swaps it for a fresh one
   *  the popout never learns. */
  taken?: Iterable<string>,
): { groupId: string; splitId: string } {
  const used = new Set(taken ?? []);
  for (;;) {
    const n = ++_detachedNodeCounter;
    const ids = { groupId: `g-${label}-${n}`, splitId: `s-${label}-${n}` };
    if (!used.has(ids.groupId) && !used.has(ids.splitId)) return ids;
  }
}

export function applyEditToSubtree(
  subtree: LayoutNode,
  edit: DetachedEdit,
): LayoutNode | null {
  switch (edit.kind) {
    case "activate": {
      const g = findGroupOfTab(subtree, edit.key);
      return g
        ? mapGroup(subtree, g.group.id, (grp) => ({ ...grp, activeKey: edit.key }))
        : subtree;
    }
    case "close":
      // Returns null if the popout emptied (caller closes the window).
      return removeKeyFromTree(subtree, edit.key);
    case "reorder": {
      // Find the group whose tab set the reordered list permutes, then reapply.
      const want = new Set(edit.tabKeys);
      const g = allGroups(subtree).find(
        (grp) =>
          grp.tabKeys.length === edit.tabKeys.length &&
          grp.tabKeys.every((k) => want.has(k)),
      );
      if (!g) return subtree;
      return mapGroup(subtree, g.id, (grp) => {
        const activeKey =
          grp.activeKey && edit.tabKeys.includes(grp.activeKey)
            ? grp.activeKey
            : (edit.tabKeys[0] ?? null);
        return { ...grp, tabKeys: edit.tabKeys, activeKey };
      });
    }
    case "split": {
      // Optimistic local split; null (invalid) leaves the popout unchanged.
      return (
        splitSubtree(subtree, edit.key, edit.targetGroupId, edit.edge, {
          groupId: edit.newGroupId,
          splitId: edit.newSplitId,
        }) ?? subtree
      );
    }
    case "resize":
      // Optimistic local divider resize (mirrors the main window's resizeSplit).
      return applyResize(subtree, edit.splitId, edit.dividerIndex, edit.fraction);
    case "move":
      // Optimistic local cross-group merge; null (invalid) leaves it unchanged.
      return moveKeyInTree(subtree, edit.key, edit.targetGroupId, edit.index) ?? subtree;
    case "files":
      // Optimistic local file-viewer toggle/resize on the target group.
      return mapGroup(subtree, edit.groupId, (grp) => ({
        ...grp,
        ...(edit.open != null ? { filesOpen: edit.open } : {}),
        ...(edit.width != null ? { filesWidth: edit.width } : {}),
        ...(edit.folder != null ? { filesFolder: edit.folder } : {}),
      }));
    case "add":
    case "addToScope":
      // The detached window can't mint the tab key — it leaves the subtree as-is
      // and waits for the main window's re-seed (with the real, keyed tab).
      return subtree;
    case "rename":
    case "setColor":
    case "setStack":
    case "setMark":
    case "setTodo":
    case "setViewerState":
    case "setTmuxName":
    case "setFolder":
    case "setUrl":
      // Payload-only edits — no node change.
      return subtree;
    case "setLocation":
      // Locality lives on the tab payload, not the group node — no node change.
      return subtree;
  }
}

/** Apply a `rename` edit to a tab payload list. Pure. */
export function applyRenameToTabs(
  tabs: TabEntry[],
  key: string,
  label: string,
): TabEntry[] {
  const next = label.trim();
  if (!next) return tabs;
  return tabs.map((t) => (t.key === key ? { ...t, label: next } : t));
}

/** Apply a `setColor` edit to a tab payload list (#264). Popout-side optimistic
 *  update, so the tab recolours under the open picker instead of a beat later,
 *  when the main window's re-seed lands. An id outside the palette clears the
 *  colour rather than reaching CSS. Pure. */
export function applyColorToTabs(
  tabs: TabEntry[],
  key: string,
  color: TabColor | undefined,
): TabEntry[] {
  const next = isTabColor(color) ? color : undefined;
  return tabs.map((t) => (t.key === key && t.color !== next ? { ...t, color: next } : t));
}

/** Apply a `setStack` edit to a tab payload list (popout-side optimistic
 *  update, so the chip regroups before the main window re-seeds). Pure. */
export function applyStackToTabs(
  tabs: TabEntry[],
  key: string,
  stack: string | undefined,
): TabEntry[] {
  const next = normalizeStackName(stack);
  return tabs.map((t) => (t.key === key && t.stack !== next ? { ...t, stack: next } : t));
}

/** Apply a `setMark` / `setTodo` edit to a tab payload list (popout-side
 *  optimistic update, so the tab's glyph flips before the re-seed). Pure. */
export function applyMarkToTabs(
  tabs: TabEntry[],
  key: string,
  mark: TabMark | undefined,
): TabEntry[] {
  const next = isTabMark(mark) ? mark : undefined;
  return tabs.map((t) => (t.key === key && t.mark !== next ? { ...t, mark: next } : t));
}

export function applyTodoToTabs(
  tabs: TabEntry[],
  key: string,
  todoId: string | undefined,
): TabEntry[] {
  const next = normalizeTodoId(todoId);
  return tabs.map((t) => (t.key === key && t.todoId !== next ? { ...t, todoId: next } : t));
}

/** Apply a `setLocation` edit to a tab payload list (popout-side optimistic
 *  update, so the locality badge flips before the main window's re-derive). Pure. */
export function applyLocationToTabs(
  tabs: TabEntry[],
  key: string,
  location: TabLocation,
): TabEntry[] {
  return tabs.map((t) => (t.key === key ? { ...t, location } : t));
}

/** #240: how close in time and space two title-bar presses must be to count as
 *  a double-click. Hand-rolled because the WM eats the DOM `dblclick` (see
 *  `DetachedCenterPanel.onTitlebarPointerDown`), so these stand in for the
 *  platform's own setting. */
export const TITLEBAR_DOUBLE_CLICK_MS = 400;
export const TITLEBAR_DOUBLE_CLICK_SLOP = 8;

/** One title-bar press: when it happened and where, in this window's client px. */
export interface TitlebarPress {
  t: number;
  x: number;
  y: number;
}

/**
 * #240: what a press on a popout's title bar means — start an OS window move, or
 * (second press of a double-click) fit the window back onto its screen. Pure, so
 * the discrimination below is unit-testable without a WM.
 *
 * The time+distance pair alone is NOT enough, and that is the whole reason this
 * is a function: a title-bar drag moves the WINDOW UNDER THE CURSOR, so the grab
 * point keeps the same CLIENT coordinates however far the window travelled. Drag
 * the popout, release, grab it again to carry on — the ordinary way anyone nudges
 * a window across a desk — and the second grab is, in client px, the same point
 * within a few hundred ms of the first: indistinguishable from a double-click.
 * That read every quick re-grab as "snap", and a snap consumes the press instead
 * of moving, so the popout stopped answering the drag that was under way.
 *
 * `lastMoveAt` breaks the tie: a press that follows an OS move of this window is
 * a re-grab of a window that just travelled, never the second half of a
 * double-click (which moves nothing). Its failure direction is the safe one — a
 * stray Moved event only costs one snap gesture, while a missed one costs the
 * user a window that will not move.
 */
export function decideTitlebarPress(input: {
  /** The previous press, or `t: 0` for "no press armed". */
  prev: TitlebarPress;
  now: TitlebarPress;
  /** When the OS last reported this window MOVED (0 = never). */
  lastMoveAt: number;
}): "snap" | "move" {
  const { prev, now, lastMoveAt } = input;
  if (!prev.t) return "move";
  if (now.t - prev.t >= TITLEBAR_DOUBLE_CLICK_MS) return "move";
  if (Math.hypot(now.x - prev.x, now.y - prev.y) >= TITLEBAR_DOUBLE_CLICK_SLOP) return "move";
  if (lastMoveAt > prev.t) return "move";
  return "snap";
}

/**
 * #42: the UNIFIED cross-window drop decision for a single dragged tab. Keyed on
 * the physical desktop cursor's relationship to the windows, this resolves a drag
 * to ONE destination the SAME way regardless of which window it started in — the
 * main window's `DETACHED_DRAG_END` host and (via the same ladder) `TabBar`'s own
 * commit both consult it. Pure, so every branch is unit-testable.
 *
 * Ladder (first match wins):
 *   1. `cancelled` → `local`. It carries BOTH of the two cases the source emits
 *      it for — an Escape/abort, and a release over the source popout that the
 *      popout already committed itself — and both mean the same thing to this
 *      window: leave everything alone. (`none` is therefore never returned by
 *      this function; it stays in the union as the callers' shared "do nothing"
 *      arm, which they handle identically to `local`.)
 *   2. `shift` → `newWindow` (Shift ALWAYS means "pop into its own window",
 *      mirroring the main-window tab rule; a lone-tab source is refused downstream,
 *      so it's a clean no-op rather than a hang).
 *   3. over a SIBLING popout → `dockDetached` into it.
 *   4. over the MAIN window → `dockMain` at the resolved pane target.
 *   5. free space (no Tabtivity window under the cursor) → `newWindow`.
 */
export type DetachedTabDrop =
  | { kind: "none" } // never returned here; the callers' shared "do nothing" arm
  | { kind: "local" } // the source popout already committed a within-popout drop
  | { kind: "newWindow" } // Shift, or released in free space → own new popout
  | { kind: "dockDetached"; toGroupId: string } // released over a sibling popout
  | { kind: "dockMain" }; // released over the main window (caller has the target)

export function decideDetachedTabDrop(input: {
  cancelled: boolean;
  shift: boolean;
  inMain: boolean;
  /** A sibling popout under the cursor, or null (none / it's the source popout). */
  overPopoutId: string | null;
  srcGroupId: string;
}): DetachedTabDrop {
  if (input.cancelled) return { kind: "local" };
  if (input.shift) return { kind: "newWindow" };
  if (input.overPopoutId && input.overPopoutId !== input.srcGroupId) {
    return { kind: "dockDetached", toGroupId: input.overPopoutId };
  }
  if (input.inMain) return { kind: "dockMain" };
  return { kind: "newWindow" };
}

/**
 * #42: the UNIFIED cross-window drop decision for a whole detached GROUP dragged
 * from a popout. A group is already its own OS window, so "new window" just means
 * "stay floating" (`float`). Docking a whole group into a SIBLING popout is out of
 * scope (there is no merge-group-into-popout action), so a group over a sibling
 * popout also stays floating. Pure/testable.
 */
export type DetachedGroupDrop =
  | { kind: "float" } // Shift, free space, or over a sibling popout → keep floating
  | { kind: "dockMain" }; // released over the main window (caller has the target)

export function decideDetachedGroupDrop(input: {
  cancelled: boolean;
  shift: boolean;
  inMain: boolean;
  overPopoutId: string | null;
  srcGroupId: string;
}): DetachedGroupDrop {
  if (input.cancelled || input.shift) return { kind: "float" };
  if (input.overPopoutId && input.overPopoutId !== input.srcGroupId) {
    return { kind: "float" };
  }
  if (input.inMain) return { kind: "dockMain" };
  return { kind: "float" };
}

/**
 * #42: the UNIFIED cross-window drop decision for ONE PANE (inner group) dragged
 * out of a MULTI-pane popout by its bar grip. The pane is a subwindow in its own
 * right, so it follows the single-tab ladder — dock JUST the pane into the main
 * window, or pop it into its own window — never the whole-popout one, which is
 * exactly the bug this exists to prevent: a pane drop docking every sibling pane
 * into the main window. Docking a pane into a SIBLING popout is out of scope
 * (same as whole groups) → stays put. Pure/testable.
 */
export type DetachedPaneDrop =
  | { kind: "none" } // cancelled / released over the source popout — stay put
  | { kind: "newWindow" } // Shift, or released in free space → own new popout
  | { kind: "dockMain" }; // released over the main window (caller has the target)

export function decideDetachedPaneDrop(input: {
  cancelled: boolean;
  shift: boolean;
  inMain: boolean;
  overPopoutId: string | null;
  srcGroupId: string;
}): DetachedPaneDrop {
  if (input.cancelled) return { kind: "none" };
  if (input.shift) return { kind: "newWindow" };
  if (input.overPopoutId && input.overPopoutId !== input.srcGroupId) {
    return { kind: "none" };
  }
  if (input.inMain) return { kind: "dockMain" };
  return { kind: "newWindow" };
}

/**
 * The project context a popout of `scope` needs — read from the MAIN window's
 * stores at seed time (#232). Every project scope gets its entry (a local
 * project's file viewers were a bare tree without one: no git bar, no history,
 * no Apps/Sessions, no remarks); a remote project additionally names its hosts
 * and ships the primary's live SSH state; a box scope ships its members. Only
 * the root scope has nothing to say.
 */
export function projectInfoForScope(scope: string): DetachedRemoteInfo | undefined {
  const projects = useProjectsStore.getState().projects;
  if (scope.startsWith(BOX_SCOPE_PREFIX)) {
    const box = useBoxesStore.getState().boxes.find((b) => `${BOX_SCOPE_PREFIX}${b.id}` === scope);
    if (!box) return undefined;
    const boxMembers = box.member_ids
      .map((id) => projects.find((p) => p.id === id))
      .filter((p): p is ProjectEntry => !!p);
    return { box, boxMembers };
  }
  const project = projects.find((p) => p.id === scope);
  if (!project) return undefined;
  if (!project.remote) return { project };
  const remoteStatus = useRemoteStatusStore.getState();
  const hostIds = [PRIMARY_HOST, ...(project.compute_hosts ?? []).map((host) => host.id)];
  const hostStates = Object.fromEntries(
    hostIds.map((hostId) => [hostId, hostStateOf(remoteStatus, project.id, hostId)]),
  );
  return {
    primaryHost: project.remote.host,
    computeHosts: project.compute_hosts,
    // Ship the whole entry + its primary SSH state so a docked/popped-out file
    // viewer can render the source switch + run-host picker and actually read the
    // host tree over the shared SFTP pool (see DetachedRemoteInfo).
    project,
    primarySsh: sshOf(remoteStatus, project.id),
    hostStates,
  };
}

/**
 * The folder a tab opened from a popout's "+" menu starts in — the same one the
 * main window's `CenterPanel` `newTabCwd` resolves: the box folder, else the
 * project directory, both from the streamed project context. A tab's own cwd
 * (the active tab's, then any) is only the fallback when the seed has none: a
 * viewer tab's cwd is its FILE's folder, so a Claude tab opened beside
 * `talk/main.pdf` used to start in `talk/` from a popout and in the project root
 * from the main window.
 */
export function detachedNewTabCwd(
  scope: string,
  info: DetachedRemoteInfo | undefined,
  groupTabCwds: (string | undefined)[],
): string {
  return (
    (info?.box ? boxFolderOfScope(scope, [info.box]) : "") ||
    resolveProjectDirectory(info?.project) ||
    groupTabCwds.find(Boolean) ||
    ""
  );
}

/**
 * Re-seed one popout from the main store's current record. `landedKey` tags the
 * seed so the popout plays the drop-in landing for a freshly-docked tab. THE one
 * reseed path (#230): the tab-drop, file-drop, delete/rename-retarget and host
 * paths all used to build their own seed, and the drop-side copy forgot the
 * project context — every dock into a remote project's popout wiped its locality
 * badges and turned its docked viewer into a plain local folder.
 */
export function reseedDetached(scope: string, groupId: string, landedKey?: string): void {
  const store = useTabsStore.getState();
  const entry = store.detachedGroupsByScope[scope]?.find((d) => d.id === groupId);
  if (!entry) return;
  const seed = buildSeed(
    scope,
    groupId,
    store.tabsByScope[scope] ?? [],
    entry.subtree,
    entry.zoom,
    projectInfoForScope(scope),
  );
  void emit(detachedSeedEvent(entry.label), landedKey ? { ...seed, landedKey } : seed);
}

/** Persist `scope` through the store's scope-aware writer (#229). Root and box
 *  scopes have no project.json — they persist under their own session directory
 *  with an empty export path — so this must never be gated on `local_file`: a
 *  root popout closed while a project was active used to come back at the next
 *  launch because nothing rewrote `sessions/root/`. */
function persistScopeNow(scope: string): Promise<void> {
  const localFile = useProjectsStore.getState().projects.find((p) => p.id === scope)?.local_file;
  return useTabsStore.getState().persistScope(scope, localFile ?? "").catch(() => {});
}

/** Set while `shutdownDetachedWindows` destroys popouts on quit, so their
 *  `Destroyed` events are not mistaken for crashes and docked back. */
let shuttingDown = false;
/** Per label: when its popout's recent unexpected deaths happened. */
const unexpectedWindowDeaths = new Map<string, number[]>();
/** Labels whose popout announced DETACHED_GAVE_UP and has not died yet. */
const gaveUpWindows = new Set<string>();
/** Per label: the first and the latest death of its current give-up streak. */
const gaveUpStreaks = new Map<string, { since: number; last: number }>();

/** How long a popout must keep giving up on its seed, every respawn, before it
 *  is docked. A display switch stalls the main window and kills popouts for
 *  seconds, not minutes — docking on the third give-up within a minute put
 *  popouts back into the main window whenever a screen was disconnected. */
export const DETACHED_GIVE_UP_DOCK_MS = 180_000;
/** A give-up this long after the previous one starts a new streak (a streak's
 *  give-ups are at most the 8 s seed wait plus the 30 s backoff apart). */
const GIVE_UP_STREAK_GAP_MS = 90_000;

/** Record one give-up death of `label` at `now`; whether its streak has lasted
 *  long enough that the popout cannot render and its tabs must dock back. */
export function noteGiveUpStreak(label: string, now: number): boolean {
  const prev = gaveUpStreaks.get(label);
  const since = prev && now - prev.last < GIVE_UP_STREAK_GAP_MS ? prev.since : now;
  gaveUpStreaks.set(label, { since, last: now });
  return now - since >= DETACHED_GIVE_UP_DOCK_MS;
}

/** How long to wait before reopening a popout that died `deaths` times in the
 *  last minute. The first two come back at once; after that a window something
 *  keeps killing backs off, so a display that takes a while to settle is waited
 *  out instead of fought. Pure. */
export function detachedRespawnDelay(deaths: number): number {
  return deaths <= 2 ? 0 : Math.min(30_000, 1000 * 2 ** (deaths - 3));
}

/** The `DetachedTabStatus` map for one popout's keys, from the main window's
 *  classified activity — the same three states `TabBar` derives per tab. Pure. */
export function statusForEntry(
  scope: string,
  entry: DetachedGroup,
  tabs: TabEntry[],
  busyByTab: Record<string, boolean>,
  attentionByTab: Record<string, AttentionKind>,
  busyKindByTab: Record<string, BusyKind> = {},
): Record<string, DetachedTabStatus> {
  const out: Record<string, DetachedTabStatus> = {};
  const byKey = new Map(tabs.map((t) => [t.key, t] as const));
  for (const key of orderedTabKeys(entry.subtree)) {
    const tab = byKey.get(key);
    if (!tab) continue;
    const ptyId = `${scope}:${key}`;
    if (isPtyTabKind(tab.kind) && busyByTab[ptyId]) {
      // The busy KIND rides along, so a popout paints a running command and an
      // agent's own turn apart exactly as the docked strip does.
      const kind = busyKindByTab[ptyId] ?? (tab.kind === "shell" ? "shell" : "agent");
      out[key] = kind === "shell" ? "working-shell" : kind === "both" ? "working-both" : "working";
      continue;
    }
    if (tab.kind !== "agent" && tab.kind !== "local_agent") continue;
    const attn = attentionByTab[ptyId];
    if (attn === "decision") out[key] = "needs-decision";
    else if (attn === "done") out[key] = "finished";
    else if (attn === "interrupted") out[key] = "interrupted";
  }
  return out;
}

/**
 * MAIN window: wire the host side of the detached-subwindow protocol. Responds
 * to a detached window's seed request by shipping its group's tabs+subtree,
 * applies edits streamed back into `detachedGroupsByScope`, and docks a group
 * back on request (closing its OS window). Register once at app startup; returns
 * a combined unlisten. The detached window never calls this — it is inert.
 */
export async function listenDetachedHost(): Promise<() => void> {
  // Registering Tauri listeners requires an IPC round trip apiece. A popout may
  // request its seed after the first listener is live but before the edit/close
  // listeners are; answering then lets it render and speak a protocol the host
  // cannot yet hear. Queue seeds until the complete host is ready.
  let hostReady = false;
  const queuedSeeds: DetachedSeedRequest[] = [];
  let publishStatus = (_force = false) => {};
  const answerSeed = ({ label, scope, groupId }: DetachedSeedRequest) => {
    const store = useTabsStore.getState();
    const entry = (store.detachedGroupsByScope[scope] ?? []).find(
      (d) => d.id === groupId,
    );
    if (!entry) return;
    const seed = buildSeed(
      scope,
      groupId,
      store.tabsByScope[scope] ?? [],
      entry.subtree,
      entry.zoom,
      projectInfoForScope(scope),
    );
    void emit(detachedSeedEvent(label), seed);
    publishStatus(true);
  };

  const unSeed = await listen<DetachedSeedRequest>(DETACHED_REQUEST_SEED, (ev) => {
    if (!hostReady) {
      queuedSeeds.push(ev.payload);
      return;
    }
    answerSeed(ev.payload);
  });

  const unEdit = await listen<DetachedEditEnvelope>(DETACHED_EDIT, (ev) => {
    const { scope, groupId, edit } = ev.payload;
    const store = useTabsStore.getState();
    if (edit.kind === "add") {
      // The main window owns tab creation + the PTY: mint the tab into the
      // popout's subtree (spawning the pane in the main window's flat pane layer),
      // then re-seed the popout so it re-renders — attaching to the new PTY — and
      // plays the drop-in landing for the freshly-added tab. A side `edge` carves
      // the tab into a NEW pane at that edge (a file dropped on a body edge);
      // otherwise it appends to the target group (the "+" menu / a pane-centre or
      // tab-bar drop).
      const key =
        edit.edge && edit.edge !== "center"
          ? store.addDetachedTabSplit(scope, groupId, edit.tab, edit.targetGroupId, edit.edge)
          : store.addDetachedTab(scope, groupId, edit.tab, edit.targetGroupId);
      if (!key) return;
      reseedDetached(scope, groupId, key);
      return;
    }
    if (edit.kind === "addToScope") {
      // A tab a popout opened for ANOTHER scope (an install command's root tab):
      // it belongs in that scope's own layout, which only this window holds.
      store.addTabToScope(edit.scope, edit.tab);
      return;
    }
    if (edit.kind === "close" && edit.user) noteClosedPopoutTabs(scope, groupId, [edit.key]);
    store.applyDetachedEdit(scope, groupId, edit);
  });

  const unBounds = await listen<DetachedBoundsEnvelope>(DETACHED_BOUNDS, (ev) => {
    const { scope, groupId, bounds } = ev.payload;
    useTabsStore.getState().setDetachedBounds(scope, groupId, bounds);
  });

  const unZoom = await listen<DetachedZoomEnvelope>(DETACHED_ZOOM, (ev) => {
    const { scope, groupId, zoom } = ev.payload;
    useTabsStore.getState().setDetachedZoom(scope, groupId, zoom);
  });

  const unDock = await listen<DetachedDockEnvelope>(DETACHED_DOCK, (ev) => {
    const { scope, groupId } = ev.payload;
    // `attachGroup` operates on the ACTIVE scope's live layout, so it can only
    // re-inject a group whose scope is currently active. When the detached
    // group's scope is the active one, dock it back into the live layout. When
    // it isn't (e.g. the WM closed a parked/hidden detached window of an
    // inactive project), `dropDetachedGroup` re-injects the subtree into that
    // scope's STORED layout (so its tabs still persist) and closes the OS
    // window — instead of stranding the group. Both paths close the OS window
    // via `attach_subwindow`. Persisted afterwards for the same reason the close
    // and hide paths are: a parked scope has nothing else to write it (#229).
    const store = useTabsStore.getState();
    if (store.scope === scope) {
      store.attachGroup(groupId);
    } else {
      store.dropDetachedGroup(scope, groupId);
    }
    void persistScopeNow(scope);
  });

  const unClose = await listen<DetachedDockEnvelope>(DETACHED_CLOSE, (ev) => {
    const { scope, groupId, user } = ev.payload;
    const store = useTabsStore.getState();
    if (user) {
      const entry = store.detachedGroupsByScope[scope]?.find((d) => d.id === groupId);
      if (entry) noteClosedPopoutTabs(scope, groupId, orderedTabKeys(entry.subtree));
    }
    // Closing the popout closes ITS tabs for good (no dock-back, no restore).
    store.closeDetachedGroup(scope, groupId);
    // Persist so the dropped tabs don't come back on next launch. For the active
    // scope CenterPanel's debounced save also covers this, but a parked
    // (inactive) scope has nothing else to write its session — persist it
    // explicitly, for EVERY scope (root and box scopes persist too; #229).
    void persistScopeNow(scope);
  });

  const unReopen = await listen<DetachedDockEnvelope>(DETACHED_REOPEN, (ev) => {
    const { scope, groupId } = ev.payload;
    // A parked scope has nothing else to write the new tab (see the close handler).
    if (reopenClosedAgentTab(scope, undefined, groupId)) void persistScopeNow(scope);
  });

  const unHide = await listen<DetachedDockEnvelope>(DETACHED_HIDE, (ev) => {
    const { scope, groupId } = ev.payload;
    const store = useTabsStore.getState();
    // Park the popout in the scope's Hidden list (tabs stay mounted). Works for
    // the active scope (shows in the side panel now) and an inactive one (shows
    // when that project is next activated) — `hiddenGroupsByScope` is per-scope.
    store.hideDetachedGroup(scope, groupId);
    // Persist so the group is saved as HIDDEN (not detached) and restores into the
    // Hidden list on next launch (every scope, see the close handler).
    void persistScopeNow(scope);
  });

  // #234: a popout's terminal input / tab activation / bell reach the classifier.
  const unActivity = await listen<DetachedActivityEnvelope>(DETACHED_ACTIVITY, (ev) => {
    const { ptyId, kind } = ev.payload;
    if (kind === "input") noteUserInput(ptyId);
    else if (kind === "interrupt") noteUserInput(ptyId, true);
    else if (kind === "seen") useActivityStore.getState().clearAttention(ptyId);
    else if (kind === "bell") useActivityStore.getState().noteBell(ptyId);
    else if (kind === "cutoff") noteTurnCutOff(ptyId);
    else if (kind === "resting") noteAgentResting(ptyId);
  });

  // #234: a popout's usage counters land in the one accumulator that is flushed.
  const unUsage = await listen<DetachedUsageEnvelope>(DETACHED_USAGE, (ev) => {
    const { scope, key, n } = ev.payload;
    bumpUsage(scope, key, n);
  });

  // #233: dialogs hosted only here, requested from a popout. Focus the main
  // window so the dialog is not raised behind the popout the click came from.
  const unDialog = await listen<DetachedOpenDialogEnvelope>(DETACHED_OPEN_DIALOG, (ev) => {
    const { kind, projectId } = ev.payload;
    if (kind === "remoteMachines") useRemoteMachinesStore.getState().open(projectId);
    else if (kind === "bigFolders") useBigFoldersStore.getState().open(projectId);
    try {
      void getCurrentWindow().setFocus().catch(() => {});
    } catch {
      /* no Tauri window (tests) */
    }
  });

  const unGaveUp = await listen<DetachedGaveUpEnvelope>(DETACHED_GAVE_UP, (ev) => {
    gaveUpWindows.add(ev.payload.label);
  });

  // A compositor can discard a popout during a monitor change — once per step
  // of it, and switching to one screen takes several — and the main window can
  // stall long enough meanwhile that a respawned popout gives up on its seed.
  // Reopen it from its existing detached record (the backend puts it on the
  // main window's screen when its own is gone) instead of docking it into the
  // main window and persisting that as the new layout. Only a popout that has
  // kept giving up on its own (no seed, so it cannot render) for minutes is
  // docked, so its tabs stay reachable. Quit teardown destroys popouts with
  // their records intact, hence the flag.
  const unDestroyed = await listen<DetachedWindowDestroyedEnvelope>(
    DETACHED_WINDOW_DESTROYED,
    (ev) => {
      if (shuttingDown) return;
      const { label } = ev.payload;
      const gaveUp = gaveUpWindows.delete(label);
      const store = useTabsStore.getState();
      for (const [scope, entries] of Object.entries(store.detachedGroupsByScope)) {
        const entry = entries?.find((d) => d.label === label);
        if (!entry) continue;
        // An inactive scope will recreate its popouts on the next setScope.
        // Opening one now could expose a parked project's tabs on screen.
        if (store.scope !== scope) return;
        const now = Date.now();
        const recent = (unexpectedWindowDeaths.get(label) ?? [])
          .filter((time) => now - time < 60_000);
        recent.push(now);
        // A death that was not a give-up ends whatever give-up streak there was.
        if (!gaveUp) gaveUpStreaks.delete(label);
        else if (noteGiveUpStreak(label, now)) {
          unexpectedWindowDeaths.delete(label);
          gaveUpStreaks.delete(label);
          store.recoverDetachedGroup(scope, entry.id);
          void persistScopeNow(scope);
          return;
        }
        unexpectedWindowDeaths.set(label, recent);
        const delay = detachedRespawnDelay(recent.length);
        if (delay === 0) {
          store.respawnDetachedForScope(scope);
        } else {
          setTimeout(() => {
            const latest = useTabsStore.getState();
            if (latest.scope === scope) latest.respawnDetachedForScope(scope);
          }, delay);
        }
        return;
      }
    },
  );

  // ── Main → popout sync (#238 "reaches a popout only on the next unrelated
  // reseed"). A popout renders from streamed props, so anything the main store
  // changes about its tabs — an agent retitle, a rename from the main strip, a
  // host switch, a project's compute hosts or SSH state — has to be pushed. One
  // subscriber per store, keyed per popout label, debounced so a burst of edits
  // costs one seed. No echo loop: a reseed changes nothing in the main store.
  const lastSig = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleReseed = (scope: string, entry: DetachedGroup, sig: string) => {
    if (lastSig.get(entry.label) === sig) return;
    lastSig.set(entry.label, sig);
    const prev = timers.get(entry.label);
    if (prev) clearTimeout(prev);
    timers.set(
      entry.label,
      setTimeout(() => {
        timers.delete(entry.label);
        reseedDetached(scope, entry.id);
      }, 150),
    );
  };
  // Identity of a project entry object without stringifying it each time.
  const projectRefs = {
    ids: new WeakMap<ProjectEntry, number>(),
    next: 0,
    id(p: ProjectEntry): number {
      let n = this.ids.get(p);
      if (n === undefined) {
        n = ++this.next;
        this.ids.set(p, n);
      }
      return n;
    },
  };
  const tabRefs = {
    ids: new WeakMap<TabEntry, number>(),
    next: 0,
    id(t: TabEntry): number {
      let n = this.ids.get(t);
      if (n === undefined) {
        n = ++this.next;
        this.ids.set(t, n);
      }
      return n;
    },
  };
  const nodeRefs = new WeakMap<LayoutNode, number>();
  let nodeNext = 0;
  const nodeId = (n: LayoutNode): number => {
    let id = nodeRefs.get(n);
    if (id === undefined) {
      id = ++nodeNext;
      nodeRefs.set(n, id);
    }
    return id;
  };
  const contextSig = (scope: string): string => {
    const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
    const remoteStatus = useRemoteStatusStore.getState();
    const states = project?.remote
      ? [PRIMARY_HOST, ...(project.compute_hosts ?? []).map((host) => host.id)]
          .map((hostId) => `${hostId}:${JSON.stringify(hostStateOf(remoteStatus, project.id, hostId))}`)
          .join(",")
      : "-";
    // Reference identity of the entry is the cheapest "did it change" — the
    // projects store replaces an entry object on every edit — plus the SSH word.
    return `${project ? projectRefs.id(project) : "-"}|${states}`;
  };
  const sweep = () => {
    const store = useTabsStore.getState();
    const live = new Set<string>();
    for (const [scope, entries] of Object.entries(store.detachedGroupsByScope)) {
      const tabs = store.tabsByScope[scope] ?? [];
      const byKey = new Map(tabs.map((t) => [t.key, t] as const));
      for (const entry of entries ?? []) {
        live.add(entry.label);
        const payloadSig = orderedTabKeys(entry.subtree)
          .map((k) => {
            const t = byKey.get(k);
            return t ? tabRefs.id(t) : 0;
          })
          .join(",");
        const sig = `${nodeId(entry.subtree)}|${payloadSig}|${contextSig(scope)}`;
        if (!lastSig.has(entry.label)) {
          // First sighting: the popout's own seed request covers it. Record the
          // signature so only a LATER change reseeds.
          lastSig.set(entry.label, sig);
          continue;
        }
        scheduleReseed(scope, entry, sig);
      }
    }
    for (const label of [...lastSig.keys()]) {
      if (!live.has(label)) {
        lastSig.delete(label);
        const t = timers.get(label);
        if (t) clearTimeout(t);
        timers.delete(label);
      }
    }
  };
  const unTabsSync = useTabsStore.subscribe(sweep);
  const unProjectsSync = useProjectsStore.subscribe(sweep);
  const unRemoteSync = useRemoteStatusStore.subscribe(sweep);

  // #234: mirror each popout's tab statuses whenever the classifier moves.
  const lastStatus = new Map<string, string>();
  publishStatus = (force = false) => {
    const store = useTabsStore.getState();
    const { busyByTab, busyKindByTab, attentionByTab } = useActivityStore.getState();
    const live = new Set<string>();
    for (const [scope, entries] of Object.entries(store.detachedGroupsByScope)) {
      const tabs = store.tabsByScope[scope] ?? [];
      for (const entry of entries ?? []) {
        live.add(entry.label);
        const status = statusForEntry(scope, entry, tabs, busyByTab, attentionByTab, busyKindByTab);
        const sig = JSON.stringify(status);
        if (!force && lastStatus.get(entry.label) === sig) continue;
        lastStatus.set(entry.label, sig);
        const payload: DetachedStatusPayload = { scope, status };
        void emit(detachedStatusEvent(entry.label), payload);
      }
    }
    // Drop the memory of popouts that are gone, the way the reseed sweep prunes
    // `lastSig`. Labels are derived from scope+group, so a respawned popout can
    // reuse one — `answerSeed`'s forced publish already covers that case, but a
    // map that only ever grows in a session that runs for days should not be
    // the asymmetric one here.
    for (const label of [...lastStatus.keys()]) {
      if (!live.has(label)) lastStatus.delete(label);
    }
  };
  const unActivitySync = useActivityStore.subscribe((s, prev) => {
    if (s.busyByTab !== prev.busyByTab || s.attentionByTab !== prev.attentionByTab) {
      publishStatus();
    }
  });

  // Prime signatures before the first real change. Without this, the first SSH
  // or project update after an initial seed was mistaken for "first sight" and
  // deliberately skipped; only the second update reached the popout.
  sweep();
  hostReady = true;
  for (const request of queuedSeeds.splice(0)) answerSeed(request);

  return () => {
    unSeed();
    unEdit();
    unBounds();
    unZoom();
    unDock();
    unClose();
    unHide();
    unReopen();
    unActivity();
    unUsage();
    unDialog();
    unGaveUp();
    unDestroyed();
    unTabsSync();
    unProjectsSync();
    unRemoteSync();
    unActivitySync();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}

/**
 * Group B #225: destroy every popout window the store knows nothing about.
 *
 * Called once as the MAIN window's shell mounts. At that instant the tabs store
 * is empty — nothing has been restored yet — so any live `detached-*` window is
 * necessarily a leftover from a PREVIOUS page load of this same renderer: the
 * memory watchdog reloading the window (U#223), the crash reporter, a dev full
 * reload. A fresh app launch has no popout windows at all, so nothing here can
 * kill a window that matters.
 *
 * That leftover was the whole bug. A reload re-hydrates the scope from disk,
 * which mints fresh tab keys and group ids, and the `detached: true` groups then
 * queue a respawn that opens NEW popouts under NEW labels (`detach_subwindow` is
 * idempotent by label, so it never reused the old window). Nothing told the old
 * ones: they stayed on screen showing stale tabs, re-requesting a seed nobody
 * answers, their edits hitting no record and being dropped, their PTY ids
 * orphaned in the backend registry — still interactive, in a window that had
 * become a zombie. Two popouts, one group, and the terminals in the visible one
 * wired to nothing. Destroying them first is the "never both old and new" rule:
 * the tabs come back in the freshly respawned window, which is seeded and live.
 *
 * `destroy()` rather than `close()`, deliberately: the old window's own close
 * handler would emit `DETACHED_CLOSE` and take the group's tabs with it.
 * Best-effort throughout — this must never block startup.
 */
export async function closeOrphanedPopouts(): Promise<void> {
  const known = new Set(
    Object.values(useTabsStore.getState().detachedGroupsByScope)
      .flat()
      .map((d) => d?.label)
      .filter((l): l is string => !!l),
  );
  let windows: Awaited<ReturnType<typeof getAllWebviewWindows>>;
  try {
    windows = await getAllWebviewWindows();
  } catch {
    return;
  }
  for (const win of windows) {
    if (!win.label.startsWith("detached-") || known.has(win.label)) continue;
    try {
      await win.destroy();
    } catch {
      /* best-effort: keep going */
    }
  }
}

/**
 * App-quit teardown for every open popout. Called from the MAIN window's
 * `onCloseRequested` before it destroys itself: a detached `WebviewWindow` lives
 * in the same process but is NOT a child of the main window, so closing the main
 * window alone strands the popouts on screen. For each scope that has detached
 * groups we (1) persist that scope so its `detached: true` flag + latest streamed
 * bounds reach project.json, then (2) `destroy()` each popout's OS window.
 *
 * We use `destroy()`, not `close()`, precisely to BYPASS the popout's own
 * `onCloseRequested` (which emits DETACHED_CLOSE → drops the group's tabs for
 * good). On a full-app quit the popouts must SURVIVE and re-open at their saved
 * bounds on next launch (via the docked→re-detach respawn path), exactly like the
 * main window's docked tabs — only an explicit per-popout WM close discards them.
 * Best-effort throughout: a failure here must never block the app from quitting.
 */
export async function shutdownDetachedWindows(): Promise<void> {
  const store = useTabsStore.getState();
  const projects = useProjectsStore.getState().projects;
  // From here on a popout's `Destroyed` is ours, not a crash (#224): the records
  // must survive so the popouts respawn at their saved bounds next launch.
  shuttingDown = true;
  for (const [scope, entries] of Object.entries(store.detachedGroupsByScope)) {
    if (!entries || entries.length === 0) continue;
    // Persist the detached set + bounds durably — for EVERY scope (#229). Root
    // and box scopes persist under their own session directory with no export
    // copy (`localFile` empty), so their popouts respawn like a project's.
    const localFile = projects.find((p) => p.id === scope)?.local_file ?? "";
    await store.persistScope(scope, localFile).catch(() => {});
    for (const entry of entries) {
      try {
        const win = await WebviewWindow.getByLabel(entry.label);
        await win?.destroy();
      } catch {
        /* best-effort: keep tearing down the rest */
      }
    }
  }
}
