import { SkeletonRows } from "../common/SkeletonRows";
import { useHeaderMenu } from "../../hooks/useHeaderMenu";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ProjectPill } from "../projects/ProjectPill";
import { BoxScopeChip } from "../projects/BoxScopeChip";
import { BarHiddenChip } from "../projects/BarHiddenChip";
import { barHiddenReason, setProjectBarHidden, useBarHidden } from "../../lib/projects/barHidden";
import { dissolveBoxSpec } from "../projects/BoxEditorDialog";
import { BoxEmptyLine } from "../projects/BoxEmptyLine";
import { useBoxNameCheck, useQuickCreateBox } from "../projects/useQuickCreateBox";
import { useDialogs } from "../common/PromptDialogs";
import { usePillDragStore } from "../../stores/drag/pillDrag";
import { ProjectSearch } from "../projects/ProjectSearch";
import type { SettingsPanelKind } from "./SettingsPanel";
import { UntestedTag } from "../common/UntestedTag";
import { useHpcPipelineStore } from "../../stores/remote/hpc/hpcPipeline";
import { useBigFoldersStore } from "../../stores/bigFolders";
import { useProjectsStore } from "../../stores/projects";
import { BOX_SCOPE_PREFIX, defaultBoxName, useBoxMembership, useBoxesStore } from "../../stores/boxes";
import { useBoxEditorStore } from "../../stores/boxEditor";
import { dissolveBox, stripProjects, useBoxSliceStore } from "../../stores/boxSlice";
import { usePillSelectionStore } from "../../stores/drag/pillSelection";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { ROOT_SCOPE, useTabsStore } from "../../stores/tabs";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { GIT_DOT_TICK_MS, gitDotProbedAt, gitDotsDue, remoteGitDotStep, useGitDirtyStore } from "../../stores/gitDirty";
import { useRemoteStatusStore, type ConnState } from "../../stores/remote/remoteStatus";
import { useAgentFenceMarksStore } from "../../stores/agentFenceMarks";
import { usePhonePresencePoll } from "../../stores/phonePresence";
import { projectStations, useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useQuiesce, saverInterval } from "../../stores/power";
import { useFastMode } from "../../lib/agents/fastMode";
import { resolveProjectDirectory, type ProjectBox, type ProjectEntry } from "../../types";
import { isHostPinned } from "../../lib/projectTabHost";
import { boxColor } from "../../lib/theme/boxColor";
import type { HeaderWidthTier } from "../../lib/headerPins";
import { useT } from "../../lib/i18n";
import { OPEN_PROJECT_DIALOG_EVENT } from "../../lib/projects/projectDialogEvent";
import { observeStripResize } from "../../lib/observeStripResize";
import { ChevronLeftIcon, ChevronRightIcon } from "../common/icons/Icon";

// Re-exported for tests and any external callers that imported these scaffold
// helpers from ProjectSwitcher before the dialog was extracted (the public
// import surface of this module is intentionally kept stable).
export {
  agentForScaffoldFillMode,
  buildDescriptionFillPrompt,
  buildScaffoldFillPrompt,
  collectScaffoldAgentFills,
} from "../../lib/projects/scaffold";

// Code-split (perf plan §6): Settings (with its sub-panels) and the project
// dialogs are opened by a click and mounted only while open, so their module
// graphs load on first open instead of with every window's startup chunk. The
// fallback is nothing, the same nothing a closed dialog renders; steering's
// settings region waits for the dialog to mount (`placeCursorSoon`).
const SettingsDialog = lazy(() =>
  import("./SettingsPanel").then((m) => ({ default: m.SettingsDialog })),
);
const ProjectDialog = lazy(() =>
  import("../projects/ProjectDialog").then((m) => ({ default: m.ProjectDialog })),
);
const ProjectImportBundleDialog = lazy(() =>
  import("../projects/ProjectImportBundleDialog").then((m) => ({
    default: m.ProjectImportBundleDialog,
  })),
);
const ProjectSetExportDialog = lazy(() =>
  import("../projects/ProjectSetExportDialog").then((m) => ({
    default: m.ProjectSetExportDialog,
  })),
);

/** This bar's entry in the shared header hover-menu id (stores/headerHoverMenu). */
const ADD_MENU_ID = "project-add";

export function ProjectSwitcher({
  open = true,
  widthTier = 0,
}: {
  open?: boolean;
  /** The header's width tier (`HeaderBar` owns it): how many box pills the
   *  leading row may hold (`boxPillBudget`). Wide when omitted. */
  widthTier?: HeaderWidthTier;
}) {
  const t = useT();
  const { confirmAction, dialogs } = useDialogs();
  const projects = useProjectsStore((s) => s.projects);
  const setActive = useProjectsStore((s) => s.setActive);
  const addProject = useProjectsStore((s) => s.addProject);
  const deactivateProject = useProjectsStore((s) => s.deactivateProject);
  const reorderProjects = useProjectsStore((s) => s.reorderProjects);
  const boxes = useBoxesStore((s) => s.boxes);
  const renameBox = useBoxesStore((s) => s.renameBox);
  const addToBox = useBoxesStore((s) => s.addToBox);
  const removeFromBox = useBoxesStore((s) => s.removeFromBox);
  const boxProjects = useBoxesStore((s) => s.boxProjects);
  const membership = useBoxMembership();
  const barHidden = useBarHidden();
  // Box names are validated now (empty, taken, too long): a rename or an
  // Alt-drag grouping the backend refuses says why instead of failing silently.
  const { messageOf } = useBoxNameCheck();
  const toastFailure = (error: unknown) => useProjectsStore.setState({ switchToast: messageOf(error) });
  // The "+" menu's New Box row: name it, Enter, you are in (the one create door).
  const { quickCreateBox, dialogs: quickCreateDialogs } = useQuickCreateBox();
  const openHpcWizard = useHpcPipelineStore((s) => s.openWizard);
  // Multi-select (3b): Escape clears the Ctrl/Cmd-click pill selection.
  const anySelected = usePillSelectionStore((s) => s.selected.length > 0);
  useEffect(() => {
    if (!anySelected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") usePillSelectionStore.getState().clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anySelected]);
  // The currently-displayed scope is the single source of truth for which pill
  // is highlighted (the box chip keys off it too). Opening a box moves the scope but
  // not `activeId`, so highlighting on `activeId` would leave the previously
  // active project pill stuck-on while a box is open — drive it off scope.
  const scope = useTabsStore((s) => s.scope);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<SettingsPanelKind>("main");
  const projectsLoaded = useProjectsStore((s) => s.loaded);
  const [settingsAnchor, setSettingsAnchor] = useState<string | undefined>(undefined);
  const [settingsReveal, setSettingsReveal] = useState<{ path: string[]; open?: boolean } | undefined>(undefined);
  // "clone" is the import dialog opened straight onto its GitHub/GitLab source —
  // the same dialog, so the source can still be switched back inside it.
  const [dialog, setDialog] = useState<"new" | "import" | "clone" | "bundle" | "exportSet" | null>(null);
  const addMenu = useHeaderMenu(ADD_MENU_ID);
  const showAddMenu = addMenu.open;
  const closeHeaderMenu = useHeaderHoverMenuStore((s) => s.close);
  const revealAddMenu = () => {
    setShowSettings(false);
    addMenu.reveal();
  };

  useEffect(() => {
    if (!open) {
      closeHeaderMenu(ADD_MENU_ID);
      setShowSettings(false);
      setDialog(null);
    }
  }, [open, closeHeaderMenu]);

  const pillsScrollRef = useRef<HTMLDivElement>(null);
  const [pillOverflow, setPillOverflow] = useState({ left: false, right: false });

  // Allow other components (e.g. the header's Local Model button) to open the
  // settings dialog on a specific panel via a window event.
  useEffect(() => {
    const onOpenSettings = (e: Event) => {
      // Either a bare panel name, or `{ panel, anchor }` when the caller also
      // wants the main panel scrolled to one of its sections (the Mobile setup
      // guide's "Open Mobile settings").
      const detail = (e as CustomEvent).detail as
        | SettingsPanelKind
        | { panel?: SettingsPanelKind; anchor?: string; reveal?: { path: string[]; open?: boolean } }
        | undefined;
      const named = typeof detail === "string" ? { panel: detail } : detail;
      setSettingsPanel(named?.panel ?? "main");
      setSettingsAnchor(named?.anchor);
      setSettingsReveal(named?.reveal);
      setShowSettings(true);
    };
    // Steering's Escape out of the settings region closes the dialog again.
    const onCloseSettings = () => setShowSettings(false);
    window.addEventListener("app:open-settings", onOpenSettings);
    window.addEventListener("app:close-settings", onCloseSettings);
    return () => {
      window.removeEventListener("app:open-settings", onOpenSettings);
      window.removeEventListener("app:close-settings", onCloseSettings);
    };
  }, []);

  // The intro wizard's New / Import / Clone buttons open the very dialogs the
  // + menu opens — this bar owns them, so they arrive as a window event (the
  // `tabtivity:open-settings` pattern above) rather than a second copy.
  useEffect(() => {
    const onOpenProjectDialog = (e: Event) => {
      const kind = (e as CustomEvent).detail;
      if (kind === "new" || kind === "import" || kind === "clone") {
        closeHeaderMenu(ADD_MENU_ID);
        setDialog(kind);
      }
    };
    window.addEventListener(OPEN_PROJECT_DIALOG_EVENT, onOpenProjectDialog);
    return () => window.removeEventListener(OPEN_PROJECT_DIALOG_EVENT, onOpenProjectDialog);
  }, [closeHeaderMenu]);

  const activeProjects = useMemo(() => {
    return projects
      .filter((p) => p.status !== "inactive")
      .sort((a, b) => a.position - b.position);
    // Keep the actual project objects live. A signature containing only the
    // bucketing fields pinned the old object when a local project finished
    // extending to remote, so ProjectPill never saw `remote` and did not add
    // its connection lamp until an unrelated signature field changed/reload.
    // The same stale-object bug affected any other pill-visible metadata that
    // was not copied into that signature.
  }, [projects]);

  // Per-pill git "dirty" dots: poll every active local project's git state on a
  // shared interval (one loop for all pills, deduped by project id) and store
  // the result in the gitDirty store, where each ProjectPill subscribes to its
  // own entry. Remote (sshfs) projects are skipped — running git over the mount
  // is slow. SidePanel also live-updates the active project's dot on edits.
  const gitDotTargets = useMemo(
    () =>
      activeProjects
        .filter((p) => !p.remote)
        .map((p) => ({ id: p.id, dir: resolveProjectDirectory(p) }))
        .filter((t) => !!t.dir),
    [activeProjects],
  );
  const gitDotSignature = useMemo(
    () => gitDotTargets.map((t) => `${t.id}:${t.dir}`).join("|"),
    [gitDotTargets],
  );
  const quiesce = useQuiesce();
  // Feeds the phone marks on the pills and tabs.
  usePhonePresencePoll();
  // Fast mode withdraws the dots entirely: this is a `git status` per local
  // project every 12–36 s, for projects the user is not currently in, and the dot
  // it feeds is the definition of an aid — the project's own file view says the
  // same thing, on the project being worked in, for free.
  const fastMode = useFastMode();
  // When each project's dot was last probed: the store's map, not effect-local
  // — the effect re-arms on every focus change (`quiesce`), and probing every
  // project on each re-arm made an alt-tab cost one `git status` per open
  // project — and shared with the Files view's `.git`-watcher refresh, so a
  // project whose tree is on screen is probed by its watcher, not this timer.
  useEffect(() => {
    if (gitDotTargets.length === 0 || fastMode) return;
    const refresh = useGitDirtyStore.getState().refresh;
    const tickMs = saverInterval(GIT_DOT_TICK_MS, quiesce);
    // The project on screen (or every member of the open box) keeps the 12 s
    // cadence; the rest are probed every third tick (`gitDotsDue`). Read at each
    // tick, so a switch needs no re-arm.
    const foreground = (): Set<string> => {
      const scope = useTabsStore.getState().scope;
      const box = useBoxesStore.getState().boxes.find((b) => `${BOX_SCOPE_PREFIX}${b.id}` === scope);
      return new Set(box ? box.member_ids : [scope]);
    };
    const run = () => {
      const now = Date.now();
      const due = new Set(
        gitDotsDue(gitDotTargets.map((t) => t.id), foreground(), gitDotProbedAt, now, tickMs),
      );
      for (const t of gitDotTargets) {
        if (!due.has(t.id)) continue;
        void refresh(t.id, t.dir);
      }
    };
    run();
    const id = window.setInterval(run, tickMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitDotSignature, quiesce, fastMode]);

  // A remote project's dot follows its SSH lamp instead (`remoteGitDotStep`):
  // the timer above never probes a remote tree, and the Files view stops
  // reading one once the pool is down, so a dropped VPN used to leave the pill
  // painting its last reading for a tree nobody could reach.
  const remoteDotTargets = useMemo(
    () =>
      activeProjects
        .filter((p) => !!p.remote)
        .map((p) => ({ id: p.id, dir: resolveProjectDirectory(p) }))
        .filter((t) => !!t.dir),
    [activeProjects],
  );
  const remoteDotSignature = useRemoteStatusStore((s) =>
    remoteDotTargets.map((t) => `${t.id}:${t.dir}:${s.byProject[t.id]?.ssh ?? "off"}`).join("|"),
  );
  const remoteDotSsh = useRef(new Map<string, ConnState>());
  useEffect(() => {
    const byProject = useRemoteStatusStore.getState().byProject;
    const dots = useGitDirtyStore.getState();
    const seen = remoteDotSsh.current;
    // A project closed and reopened starts over, so its first connect probes.
    for (const id of seen.keys()) {
      if (!remoteDotTargets.some((t) => t.id === id)) seen.delete(id);
    }
    for (const t of remoteDotTargets) {
      const ssh = byProject[t.id]?.ssh ?? "off";
      const step = remoteGitDotStep(seen.get(t.id), ssh);
      seen.set(t.id, ssh);
      if (step === "unknown") dots.set(t.id, "unknown");
      // Fast mode withdraws the dots' probes, as for the timer above.
      else if (step === "probe" && !fastMode) void dots.refresh(t.id, t.dir);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteDotSignature, fastMode]);

  // Per-pill agent-fence markers: one `agent_fence_marks` call for every local
  // pill. Remote (and VM) projects are left out — their agents run on the far
  // host, where the local fence means nothing. Unlike the git dots this stays
  // on in fast mode: it is a warning about what agents can reach, not an aid.
  const fenceMarkSignature = useMemo(
    () =>
      activeProjects
        .filter((p) => !p.remote)
        .map((p) => p.id)
        .join("|"),
    [activeProjects],
  );
  useEffect(() => {
    if (!fenceMarkSignature) return;
    const ids = fenceMarkSignature.split("|");
    const refresh = useAgentFenceMarksStore.getState().refresh;
    const run = () => void refresh(ids);
    run();
    const id = window.setInterval(run, saverInterval(15000, quiesce));
    return () => window.clearInterval(id);
  }, [fenceMarkSignature, quiesce]);

  // Which box's slice the strip is showing (`null` = every active project) lives
  // in `stores/boxSlice`, so the ✕, the palette and the search can reach it too;
  // the effects that keep it in step with the scope and the boxes stay here.
  const boxFilter = useBoxSliceStore((s) => s.sliceBoxId);
  const selectBox = useBoxSliceStore((s) => s.selectBox);
  const leaveBox = useBoxSliceStore((s) => s.leaveBox);
  const [boxCandidateFilter, setBoxCandidateFilter] = useState("");

  // Entering a box scope by any other door (the search popover, a restored
  // scope at launch, a popout's stream) selects its slice. One-way: leaving the
  // scope does NOT clear it, which is exactly what keeps the strip still while
  // its projects are being visited.
  useEffect(() => {
    useBoxSliceStore.getState().followScope(scope);
  }, [scope]);

  // A dissolved box takes its slice with it, or the strip would stay filtered
  // by something no menu can select any more.
  useEffect(() => {
    useBoxSliceStore.getState().dropIfGone(boxes.map((b) => b.id));
  }, [boxes, boxFilter]);

  // Membership mode follows the selected slice rather than the current tab
  // scope. Opening a member changes `scope`, but the + and × controls must keep
  // editing the Box the strip is still showing.
  const currentBox = useMemo(
    () => (boxFilter ? boxes.find((b) => b.id === boxFilter) ?? null : null),
    [boxes, boxFilter],
  );
  const currentBoxMemberIds = useMemo(
    () => new Set(currentBox?.member_ids ?? []),
    [currentBox],
  );

  useEffect(() => {
    setBoxCandidateFilter("");
  }, [currentBox?.id]);

  // Where the UNSLICED strip last stood. A slice is a detour the scope takes
  // with it (`openBox` enters the box), so leaving it by "All projects" has to
  // hand the scope back (`boxSlice.selectBox(null)`) — otherwise the strip says
  // "every project" while the tabs below are still the box's and not one pill
  // on the row is lit.
  useEffect(() => {
    useBoxSliceStore.getState().noteScope(scope);
  }, [boxFilter, scope]);

  // The built-in root scope, picked from the same chip as the boxes.
  // Root is no longer a place to switch to: it opens as the root console over
  // whatever is on screen (`stores/rootOverlay`), so picking it costs neither
  // the project in scope nor the slice. With no project open the root scope is
  // still what the center shows — the overlay simply floats over it.
  const selectRoot = () => {
    useRootOverlayStore.getState().show();
  };

  // The pills the strip renders. A slice shows its box's members — plus the
  // project currently in scope even when it is not one, since a strip that
  // hides the project you are working in is a strip that has lost you.
  // Members show REGARDLESS of status: a member closed in the general strip is
  // still open inside its box (openBox restored its tabs box-locally), so the
  // slice keeps its pill while the general strip — activeProjects — does not.
  // The unsliced strip leaves out what the user hid from it, one by one or a
  // whole box's members (`lib/projects/barHidden`) — except the project in
  // scope, for the same reason a slice keeps it. A slice ignores the lists:
  // looking into a box is where its hidden members are still found.
  const barHiddenSplit = useMemo(() => {
    const shown: ProjectEntry[] = [];
    const own: ProjectEntry[] = [];
    const byBox = new Map<string, ProjectEntry[]>();
    for (const p of activeProjects) {
      const why = p.id === scope ? null : barHiddenReason(p.id, membership.get(p.id), barHidden);
      if (!why) shown.push(p);
      else if (why.kind === "project") own.push(p);
      else byBox.set(why.boxId, [...(byBox.get(why.boxId) ?? []), p]);
    }
    const groups = boxes
      .filter((b) => byBox.has(b.id))
      .sort((a, b) => a.position - b.position)
      .map((box) => ({ box, members: byBox.get(box.id) ?? [] }));
    return { shown, own, groups };
  }, [activeProjects, barHidden, boxes, membership, scope]);
  const aliveProjectIds = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);
  const aliveBoxIds = useMemo(() => new Set(boxes.map((b) => b.id)), [boxes]);

  const visibleProjects = useMemo<ProjectEntry[]>(() => {
    if (!currentBox) return barHiddenSplit.shown;
    return stripProjects(projects, currentBox, scope);
  }, [barHiddenSplit, currentBox, projects, scope]);

  // On steering's projects level, every pill wears its station number
  // (the digit that jumps there — 1 is the root pill). Numbered from the SAME
  // ring the digit handler and cycleProject walk (projectStations), so badge
  // and jump can never disagree. On tabs and panes, digits open agent tabs,
  // so project station badges must disappear. Only the first nine stations
  // get a digit. A slice narrows the ring to the pills it shows (inactive
  // members included), so the badges count the visible strip.
  const steeringOnProjects = useKeyboardSteeringStore((s) => s.active && s.level === "projects");
  const stationById = useMemo(() => {
    if (!steeringOnProjects) return null;
    const m = new Map<string, number>();
    projectStations().forEach((id, i) => {
      if (id && i < 9) m.set(id, i + 1);
    });
    return m;
    // `visibleProjects` re-mints the map when the strip (projects, slice,
    // scope) changes; projectStations reads the stores imperatively, which the
    // linter cannot see.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steeringOnProjects, visibleProjects]);

  const boxCandidates = useMemo(() => {
    if (!currentBox) return [];
    const needle = boxCandidateFilter.trim().toLocaleLowerCase();
    return activeProjects.filter(
      (project) =>
        !currentBoxMemberIds.has(project.id) &&
        (!needle || project.name.toLocaleLowerCase().includes(needle)),
    );
  }, [activeProjects, boxCandidateFilter, currentBox, currentBoxMemberIds]);

  // Pointer-driven pill reorder (stores/drag/pillDrag): every OTHER visible project
  // pill "parts" to open the dragged one's landing slot — a `shiftPx` per id,
  // computed here (not in each pill) since it needs the FULL rendered order.
  // Mirrors MachinesIndicator's row-parting FLIP math, generalized to width:
  // removing an item of the dragged pill's own width from the strip and
  // reinserting it elsewhere shifts every OTHER pill between the old and new
  // slot by exactly that width, regardless of their own widths — so idx
  // (this pill's index in the full project-only list) vs. fromIdx (the
  // dragged pill's) and overIndex (the without-self landing index the drag
  // gesture computed) alone decide the shift; a box-assign or Alt-group
  // target suppresses it entirely (nothing will actually move).
  const pillDrag = usePillDragStore((s) => s.drag);
  const pillShifts = useMemo(() => {
    const shifts = new Map<string, number>();
    if (!pillDrag || pillDrag.overBoxId || pillDrag.groupTargetId) return shifts;
    const fromIdx = visibleProjects.findIndex((p) => p.id === pillDrag.id);
    if (fromIdx < 0) return shifts;
    visibleProjects.forEach((p, idx) => {
      if (idx === fromIdx) return;
      const shift =
        idx > fromIdx && idx <= pillDrag.overIndex
          ? -pillDrag.width
          : idx < fromIdx && idx >= pillDrag.overIndex
            ? pillDrag.width
            : 0;
      if (shift) shifts.set(p.id, shift);
    });
    return shifts;
  }, [pillDrag, visibleProjects]);

  // Signature of what the strip renders, so the overflow/edge-fade effect
  // re-runs when the slice changes and not just on a count change (S3) —
  // switching between two same-sized boxes is exactly that case.
  const bucketSignature = useMemo(
    () => `${boxFilter ?? ""}|${visibleProjects.map((p) => p.id).join(",")}`,
    [boxFilter, visibleProjects],
  );

  // Drive the edge-fade affordance: mark which side(s) of the pill row have
  // scrolled-off pills so CSS can fade only that edge. Re-checks on scroll,
  // window resize, and whenever the set of active pills changes.
  useEffect(() => {
    const el = pillsScrollRef.current;
    if (!el) return;
    const update = () => {
      const maxScroll = el.scrollWidth - el.clientWidth;
      setPillOverflow({
        left: el.scrollLeft > 1,
        right: el.scrollLeft < maxScroll - 1,
      });
    };
    // Redirect vertical wheel motion to horizontal scroll so the mouse wheel
    // moves the pill row when hovering it (the webview doesn't do this on its
    // own). Non-passive so preventDefault can suppress the no-op vertical scroll.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX !== 0) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    // The row and each pill (a pill widening in a capped row resizes no row
    // box); a no-op in jsdom, where the scroll/wheel/resize listeners still wire up.
    const stopResize = observeStripResize(el, update);
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      el.removeEventListener("wheel", onWheel);
      stopResize();
      window.removeEventListener("resize", update);
    };
    // Re-run when the rendered bucket shape changes (count alone misses a
    // box ⇄ ungrouped regroup that keeps the same active-pill count) (S3).
  }, [bucketSignature]);

  // Alt-drop one pill onto another: spin up a fresh box holding both projects
  // (phone-style "drag onto" grouping). Additive — neither project leaves any
  // box it was already in. The box takes the next free "Box N" and its pill goes
  // straight into rename, so a gesture with no name prompt still ends named.
  const groupProjects = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    // Box names are unique now, so a second "New Box" would be refused: take the
    // next free "Box N" (the user renames it via its pill).
    const name = defaultBoxName(useBoxesStore.getState().boxes, (n) => t("boxName.default", { n }));
    try {
      const created = await boxProjects([toId, fromId], { name });
      if (!created) return;
      // In the box (its pill is then on the row), with the pill's name field
      // open: `selectBox` sets the slice before it awaits, so the field mounts
      // on a pill that stands there.
      const entered = selectBox(created.id);
      useBoxEditorStore.getState().startRename(created.id);
      await entered;
    } catch (error) {
      toastFailure(error);
    }
  };

  // Empty pill-strip space doubles as a window-drag handle: pressing the bare
  // strip (where no project pills are) starts a native window move, so the
  // project bar behaves like titlebar dead-space. Pills/boxes are nested
  // children, so a press on one lands on it (target !== currentTarget) and is
  // left alone. Bypasses the header's `.no-drag` by dragging directly. (#dnd)
  const startWindowDrag = (e: React.MouseEvent) => {
    // `button` (singular, 0 = left), not `buttons`: WebKitGTK reports
    // `buttons === 0` on the opening mousedown, which swallowed the drag on Linux.
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return;
    getCurrentWindow().startDragging().catch(() => {});
  };

  const scrollPills = (dir: -1 | 1) => {
    const el = pillsScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" });
  };

  // Continuous scroll while a chevron is hovered: rAF loop nudges the pill row
  // each frame until the pointer leaves (or the component unmounts).
  const hoverScrollRef = useRef<number | null>(null);
  const stopHoverScroll = () => {
    if (hoverScrollRef.current !== null) {
      cancelAnimationFrame(hoverScrollRef.current);
      hoverScrollRef.current = null;
    }
  };
  const startHoverScroll = (dir: -1 | 1) => {
    stopHoverScroll();
    const step = () => {
      const el = pillsScrollRef.current;
      if (!el) return;
      el.scrollLeft += dir * 6;
      hoverScrollRef.current = requestAnimationFrame(step);
    };
    hoverScrollRef.current = requestAnimationFrame(step);
  };
  useEffect(() => stopHoverScroll, []);

  /**
   * Add a just-created/imported project and, for a **remote** one, ask about its
   * giant folders once. An import in particular can register a folder holding a
   * `.venv`, a `node_modules` or a data drop, and byte-sync does not read
   * `.gitignore` — so without this the first sync pass is the moment the user
   * finds out. The prompt handles the not-yet-connected case itself (it walks
   * the local side and fills in the host column when the pool comes up).
   */
  const addAndAudit = async (project: ProjectEntry) => {
    await addProject(project);
    // The big-folder ask is about what to sync into the mirror: a project pinned
    // to its host (remote-only or VM) has none.
    if (project.remote && !isHostPinned(project)) useBigFoldersStore.getState().openOnce(project.id);
  };

  return (
    <>
      {showSettings && createPortal(
        <Suspense fallback={null}>
          <SettingsDialog
            onClose={() => setShowSettings(false)}
            initialPanel={settingsPanel}
            initialAnchor={settingsAnchor}
            initialReveal={settingsReveal}
          />
        </Suspense>,
        document.body,
      )}

      {dialog === "new" && createPortal(
        <Suspense fallback={null}>
          <ProjectDialog
            kind="new"
            onClose={() => setDialog(null)}
            onProject={(project) => void addAndAudit(project)}
          />
        </Suspense>,
        document.body,
      )}
      {(dialog === "import" || dialog === "clone") && createPortal(
        <Suspense fallback={null}>
          <ProjectDialog
            kind="import"
            initialImportSource={dialog === "clone" ? "git" : "folder"}
            onClose={() => setDialog(null)}
            onProject={(project) => void addAndAudit(project)}
          />
        </Suspense>,
        document.body,
      )}
      {dialog === "bundle" && (
        <Suspense fallback={null}>
          <ProjectImportBundleDialog
            onClose={() => setDialog(null)}
            onProject={(project) => void addAndAudit(project)}
          />
        </Suspense>
      )}
      {dialog === "exportSet" && (
        <Suspense fallback={null}>
          <ProjectSetExportDialog onClose={() => setDialog(null)} />
        </Suspense>
      )}

      <div
        className="project-switcher"
        onClick={() => {
          setShowSettings(false);
          closeHeaderMenu(ADD_MENU_ID);
        }}
        // Suppress the webview's default Reload/Inspect menu over the bar so a
        // right-click only ever surfaces our own pill context menu.
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* No leading divider: this strip opens the whole bar — its box chip
            (the Tabtivity logo) is the leftmost thing in the window — so there is
            nothing on its left to divide it from. */}
        <div
          // A slice tints the whole strip in its box's colour (static tint, see
          // `.project-pills-region.is-sliced`), so "I am looking at a box" reads
          // across the row, not only on the one pill.
          className={`project-pills-region${pillOverflow.left ? " overflow-left" : ""}${
            pillOverflow.right ? " overflow-right" : ""
          }${currentBox ? " is-sliced" : ""}`}
          style={currentBox ? ({ "--slice-color": boxColor(currentBox) } as CSSProperties) : undefined}
        >
          {/* The row's leading segment: ONE chip for every scope that is not a
              project pill — the root terminal and the boxes. It sits outside .project-pills-scroll, which is what pins
              it: the pills scroll past underneath and this never leaves the
              left edge, because the head of the row is what answers "where am
              I". Root used to be a pinned pill of its own here; it was spending
              permanent header width on a destination reached by name rather
              than by pointing, so it moved into the chip's
              dropdown (see BoxScopeChip) and the strip got the space back.
              Everything reads its state off `scope`, like every pill beside it
              — activeId would keep a pill lit while a box is open. */}
          <BoxScopeChip
            boxes={boxes}
            selectedId={boxFilter}
            onSelect={(id) => void selectBox(id)}
            onLeave={() => void leaveBox()}
            widthTier={widthTier}
            onRename={(boxId, name) => void renameBox(boxId, name).catch(toastFailure)}
            // "Dissolve box…" on the pill asks the same question the editor's
            // Dissolve does — and says the same thing about what survives
            // (folder, agent docs, members). Dissolving the box you are in
            // leaves it first, or the scope would stay `box:<id>` of a box that
            // is gone.
            onDissolve={(boxId) => {
              const target = boxes.find((b) => b.id === boxId);
              if (!target) return;
              void confirmAction(dissolveBoxSpec(t, target.name, target.folder)).then(async (ok) => {
                if (!ok) return;
                try {
                  await dissolveBox(boxId);
                } catch (error) {
                  toastFailure(error);
                }
              });
            }}
            active={!!boxFilter && scope === `${BOX_SCOPE_PREFIX}${boxFilter}`}
            rootActive={scope === ROOT_SCOPE}
            onSelectRoot={selectRoot}
            // Steering station 1 is the ring's root (`null`) head, which
            // `stationById` cannot carry precisely because it has no id.
            rootStation={steeringOnProjects ? 1 : undefined}
          />
          {/* Hairline between the fixed leading segment (★ · ⬡) and the
              scrolling project strip, so the two zones read as two zones. */}
          {/* The pending-proposals count used to stand here as a second copy of
              the console's own badge. Tabtivity's tools and what they propose are
              the root console's subject, so both live there and only there
              (RootOverlay's ⚿ chip and the ✓ button beside it); the project bar
              keeps its width for the projects. */}
          <div className="pills-lead-sep" aria-hidden />
          <button
            type="button"
            className="pills-scroll-btn left"
            tabIndex={-1}
            aria-label={t("projectSwitcher.scrollLeft")}
            onMouseEnter={() => startHoverScroll(-1)}
            onMouseLeave={stopHoverScroll}
            onClick={(e) => {
              e.stopPropagation();
              scrollPills(-1);
            }}
          >
            <ChevronLeftIcon />
          </button>
          <div
            className="project-pills-scroll"
            ref={pillsScrollRef}
            // Pressing the bare strip (no pill under the cursor) drags the
            // window; pills/boxes are nested so their press is left untouched.
            onMouseDown={startWindowDrag}
          >
            {!projectsLoaded && <SkeletonRows count={3} className="project-pills-skeleton" />}
            {projectsLoaded && currentBox && visibleProjects.length === 0 && (
              <BoxEmptyLine boxId={currentBox.id} className="box-empty-strip" />
            )}
            {visibleProjects.map((project) => {
              const isCurrentBoxMember = currentBoxMemberIds.has(project.id);
              // The swatches a member pill wears: one per box it is in, in the
              // box's own colour. Inside a slice every pill is a member of the
              // box being looked at, so only that box is worth a swatch there.
              const boxTags = (currentBox
                ? isCurrentBoxMember
                  ? [currentBox]
                  : []
                : (membership.get(project.id) ?? [])
                    .map((boxId) => boxes.find((b) => b.id === boxId))
                    .filter((b): b is ProjectBox => !!b)
              ).map((b) => ({ id: b.id, name: b.name, color: boxColor(b) }));
              return (
                <ProjectPill
                  key={project.id}
                  project={project}
                  active={scope === project.id}
                  onClick={() => {
                    // A plain activation click clears the multi-selection (3b).
                    usePillSelectionStore.getState().clear();
                    void setActive(project.id);
                  }}
                  onClose={currentBox
                    ? isCurrentBoxMember
                      ? () => removeFromBox(project.id, currentBox.id)
                      : undefined
                    : () => deactivateProject(project.id)}
                  closeTitle={currentBox && isCurrentBoxMember
                    ? t("projectSwitcher.removeFromBox", {
                        name: project.name,
                        box: currentBox.name,
                      })
                    : undefined}
                  onReorder={(fromId, toId) => void reorderProjects(fromId, toId)}
                  onGroup={(fromId, toId) => void groupProjects(fromId, toId)}
                  onAssignToBox={(boxId) => void addToBox(project.id, boxId)}
                  boxTags={boxTags}
                  isDragged={pillDrag?.id === project.id}
                  dragDx={pillDrag?.id === project.id ? pillDrag.dx : undefined}
                  shiftPx={pillShifts.get(project.id)}
                  groupHintActive={pillDrag?.groupTargetId === project.id}
                  station={stationById?.get(project.id)}
                  barHidden={barHidden.projects.has(project.id)}
                  onToggleBarHidden={(hide) => void setProjectBarHidden(project.id, hide, aliveProjectIds)}
                />
              );
            })}
          </div>
          <button
            type="button"
            className="pills-scroll-btn right"
            tabIndex={-1}
            aria-label={t("projectSwitcher.scrollRight")}
            onMouseEnter={() => startHoverScroll(1)}
            onMouseLeave={stopHoverScroll}
            onClick={(e) => {
              e.stopPropagation();
              scrollPills(1);
            }}
          >
            <ChevronRightIcon />
          </button>
          {/* Outside the scroller, so "N hidden" never scrolls out of reach. */}
          {!currentBox && (
            <BarHiddenChip
              projects={barHiddenSplit.own}
              byBox={barHiddenSplit.groups}
              aliveProjectIds={aliveProjectIds}
              aliveBoxIds={aliveBoxIds}
              onOpen={(id) => void setActive(id)}
            />
          )}
        </div>
        <div className="project-switcher-separator" />

        <div
          className="project-switcher-add-wrap"
          ref={addMenu.ref}
          onKeyDown={addMenu.onKeyDown}
          onBlur={addMenu.onBlur}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={revealAddMenu}
          onMouseLeave={addMenu.scheduleClose}
        >
          <button
            type="button"
            className="project-switcher-add-btn"
            aria-label={t(currentBox ? "projectSwitcher.addProjectsToBox" : "projectSwitcher.addOrImport")}
            data-hint-anchor="add-project"
            title={t(currentBox
              ? "projectSwitcher.addProjectsToBox"
              : "projectSwitcher.addOrImport")}
            // Hover-opened, like its sibling header menus (SettingsMenu,
            // LocalModelMenu, VpnIndicator). Click reveals rather than toggling: a
            // click also fires mouseenter, so a toggle here would open on enter and
            // immediately shut.
            onClick={revealAddMenu}
            aria-haspopup="menu"
            aria-expanded={showAddMenu}
          >
            +
          </button>
          {showAddMenu && (
            <div className={`project-switcher-add-menu${currentBox ? " box-membership" : ""}`}>
              {currentBox ? (
                <>
                  <div className="project-switcher-box-add-title">
                    {t("projectSwitcher.addProjectsToBox")} <UntestedTag id="projectSwitcher.addProjectsToBox" />
                  </div>
                  <input
                    className="project-switcher-box-add-filter"
                    value={boxCandidateFilter}
                    onChange={(e) => setBoxCandidateFilter(e.target.value)}
                    placeholder={t("projectSwitcher.filterBoxCandidates")}
                    aria-label={t("projectSwitcher.filterBoxCandidates")}
                    autoFocus
                  />
                  <div className="project-switcher-box-add-list">
                    {boxCandidates.map((project) => (
                      <button
                        type="button"
                        key={project.id}
                        data-project-id={project.id}
                        onClick={() => void addToBox(project.id, currentBox.id)}
                      >
                        {project.name}
                      </button>
                    ))}
                    {boxCandidates.length === 0 && (
                      <div className="project-switcher-box-add-empty">
                        {t("projectSwitcher.noBoxCandidates")}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <button onClick={() => { closeHeaderMenu(ADD_MENU_ID); setDialog("new"); }}>
                    {t("projectSwitcher.newProject")}
                  </button>
                  <button onClick={() => { closeHeaderMenu(ADD_MENU_ID); setDialog("import"); }}>
                    {t("projectSwitcher.importProject")}
                  </button>
                  <button onClick={() => { closeHeaderMenu(ADD_MENU_ID); setDialog("clone"); }}>
                    {t("projectSwitcher.importFromGitHub")}
                  </button>
                  <button
                    className="untested"
                    onClick={() => { closeHeaderMenu(ADD_MENU_ID); setDialog("bundle"); }}
                    title={t("projectSwitcher.importBundleTitle")}
                  >
                    {t("projectSwitcher.importBundle")} <UntestedTag id="transfer.import" />
                  </button>
                  <button
                    className="untested"
                    onClick={() => { closeHeaderMenu(ADD_MENU_ID); setDialog("exportSet"); }}
                    title={t("projectSwitcher.exportSetTitle")}
                  >
                    {t("projectSwitcher.exportSet")} <UntestedTag id="transfer.exportSet" />
                  </button>
                  <button
                    className="untested"
                    onClick={() => { closeHeaderMenu(ADD_MENU_ID); openHpcWizard(); }}
                  >
                    {t("projectSwitcher.hpcPipeline")} <UntestedTag id="projectSwitcher.hpcPipeline" />
                  </button>
                  <button
                    className="untested"
                    onClick={() => {
                      closeHeaderMenu(ADD_MENU_ID);
                      void quickCreateBox();
                    }}
                  >
                    {t("projectSwitcher.newBox")} <UntestedTag id="projectSwitcher.newBox" />
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Right of the + rather than left of the pills: the box searches the
            projects that are *not* on the strip, so it belongs with the control
            that adds one, not in front of the ones already there. Its popover
            is right-anchored (see .project-search-popover) since it now opens
            near the header's right half. */}
        <ProjectSearch
          projects={projects}
          boxes={boxes}
          onActivateProject={(id) => void setActive(id)}
          onOpenBox={(id) => void selectBox(id)}
        />
      </div>
      {dialogs}
      {quickCreateDialogs}
    </>
  );
}
