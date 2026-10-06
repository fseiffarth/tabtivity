import { useHeaderMenu } from "../../hooks/useHeaderMenu";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ProjectPill } from "../projects/ProjectPill";
import { BoxScopeChip } from "../projects/BoxScopeChip";
import { usePillDragStore } from "../../stores/drag/pillDrag";
import { ProjectSearch } from "../projects/ProjectSearch";
import { ProjectDialog } from "../projects/ProjectDialog";
import { ProjectImportBundleDialog } from "../projects/ProjectImportBundleDialog";
import { SettingsDialog, type SettingsPanelKind } from "./SettingsPanel";
import { UntestedTag } from "../common/UntestedTag";
import { useHpcPipelineStore } from "../../stores/remote/hpc/hpcPipeline";
import { useBigFoldersStore } from "../../stores/bigFolders";
import { useProjectsStore } from "../../stores/projects";
import { BOX_SCOPE_PREFIX, useBoxMembership, useBoxesStore } from "../../stores/boxes";
import { useBoxEditorStore } from "../../stores/boxEditor";
import { usePillSelectionStore } from "../../stores/drag/pillSelection";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { ROOT_SCOPE, useTabsStore } from "../../stores/tabs";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { GIT_DOT_TICK_MS, gitDotsDue, useGitDirtyStore } from "../../stores/gitDirty";
import { useAgentFenceMarksStore } from "../../stores/agentFenceMarks";
import { projectStations, useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useQuiesce, saverInterval } from "../../stores/power";
import { useFastMode } from "../../lib/agents/fastMode";
import { resolveProjectDirectory, type ProjectBox, type ProjectEntry } from "../../types";
import { boxColor } from "../../lib/theme/boxColor";
import { useT } from "../../lib/i18n";
import { OPEN_PROJECT_DIALOG_EVENT } from "../../lib/projects/projectDialogEvent";
import { observeStripResize } from "../../lib/observeStripResize";

// Re-exported for tests and any external callers that imported these scaffold
// helpers from ProjectSwitcher before the dialog was extracted (the public
// import surface of this module is intentionally kept stable).
export {
  agentForScaffoldFillMode,
  buildDescriptionFillPrompt,
  buildScaffoldFillPrompt,
  collectScaffoldAgentFills,
} from "../projects/scaffold";

/** This bar's entry in the shared header hover-menu id (stores/headerHoverMenu). */
const ADD_MENU_ID = "project-add";

export function ProjectSwitcher({ open = true }: { open?: boolean }) {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  const setActive = useProjectsStore((s) => s.setActive);
  const addProject = useProjectsStore((s) => s.addProject);
  const deactivateProject = useProjectsStore((s) => s.deactivateProject);
  const reorderProjects = useProjectsStore((s) => s.reorderProjects);
  const boxes = useBoxesStore((s) => s.boxes);
  const renameBox = useBoxesStore((s) => s.renameBox);
  const deleteBox = useBoxesStore((s) => s.deleteBox);
  const addToBox = useBoxesStore((s) => s.addToBox);
  const removeFromBox = useBoxesStore((s) => s.removeFromBox);
  const boxProjects = useBoxesStore((s) => s.boxProjects);
  const openBox = useBoxesStore((s) => s.openBox);
  const membership = useBoxMembership();
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
  const [settingsAnchor, setSettingsAnchor] = useState<string | undefined>(undefined);
  // "clone" is the import dialog opened straight onto its GitHub/GitLab source —
  // the same dialog, so the source can still be switched back inside it.
  const [dialog, setDialog] = useState<"new" | "import" | "clone" | "bundle" | null>(null);
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
        | { panel?: SettingsPanelKind; anchor?: string }
        | undefined;
      const named = typeof detail === "string" ? { panel: detail } : detail;
      setSettingsPanel(named?.panel ?? "main");
      setSettingsAnchor(named?.anchor);
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

  // On steering's projects level, every pill wears its station number
  // (the digit that jumps there — 1 is the root pill). Numbered from the SAME
  // ring the digit handler and cycleProject walk (projectStations), so badge
  // and jump can never disagree. On tabs and panes, digits open agent tabs,
  // so project station badges must disappear. Only the first nine stations
  // get a digit. A box slice hides some ring members — their digits still jump.
  const steeringOnProjects = useKeyboardSteeringStore((s) => s.active && s.level === "projects");
  const stationById = useMemo(() => {
    if (!steeringOnProjects) return null;
    const m = new Map<string, number>();
    projectStations().forEach((id, i) => {
      if (id && i < 9) m.set(id, i + 1);
    });
    return m;
    // `projects` re-mints the map when the strip changes; projectStations reads
    // the store imperatively, which the linter cannot see.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steeringOnProjects, projects]);

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
  // Fast mode withdraws the dots entirely: this is a `git status` per local
  // project every 12–36 s, for projects the user is not currently in, and the dot
  // it feeds is the definition of an aid — the project's own file view says the
  // same thing, on the project being worked in, for free.
  const fastMode = useFastMode();
  // When each project's dot was last probed. A ref, not effect-local: the effect
  // re-arms on every focus change (`quiesce`), and probing every project on each
  // re-arm made an alt-tab cost one `git status` per open project.
  const gitDotProbedAt = useRef(new Map<string, number>());
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
        gitDotsDue(gitDotTargets.map((t) => t.id), foreground(), gitDotProbedAt.current, now, tickMs),
      );
      for (const t of gitDotTargets) {
        if (!due.has(t.id)) continue;
        gitDotProbedAt.current.set(t.id, now);
        void refresh(t.id, t.dir);
      }
    };
    run();
    const id = window.setInterval(run, tickMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitDotSignature, quiesce, fastMode]);

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

  // Which box's slice the strip is showing (`null` = every active project).
  // A *view*, deliberately not the scope: clicking a member switches to that
  // project without collapsing the slice, so hopping between a box's projects
  // never reshuffles the row under the pointer. Session-only — a slice is where
  // you are looking right now, not a setting.
  const [boxFilter, setBoxFilter] = useState<string | null>(null);
  const [boxCandidateFilter, setBoxCandidateFilter] = useState("");

  // Entering a box scope by any other door (the search popover, a restored
  // scope at launch, a popout's stream) selects its slice. One-way: leaving the
  // scope does NOT clear it, which is exactly what keeps the strip still while
  // its projects are being visited.
  useEffect(() => {
    if (!scope.startsWith(BOX_SCOPE_PREFIX)) return;
    const id = scope.slice(BOX_SCOPE_PREFIX.length);
    setBoxFilter((cur) => (cur === id ? cur : id));
  }, [scope]);

  // A dissolved box takes its slice with it, or the strip would stay filtered
  // by something no menu can select any more.
  useEffect(() => {
    if (boxFilter && !boxes.some((b) => b.id === boxFilter)) setBoxFilter(null);
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
  // hand the scope back — otherwise the strip says "every project" while the
  // tabs below are still the box's and not one pill on the row is lit. Only
  // scopes seen while no slice was selected count: a member opened from inside
  // the slice was current in the BOX's view, not in this one. Root is a
  // legitimate value — it is where a session starts, and where a remembered
  // project that has since been closed lands.
  const lastUnslicedScope = useRef<string>(ROOT_SCOPE);
  useEffect(() => {
    if (boxFilter || scope.startsWith(BOX_SCOPE_PREFIX)) return;
    lastUnslicedScope.current = scope;
  }, [boxFilter, scope]);

  /** Pick a box's slice (and open its scope) or go back to every project. */
  const selectBox = (boxId: string | null) => {
    setBoxFilter(boxId);
    // Picking a box makes the BOX the current scope: its tabs, its pill lit.
    if (boxId) {
      void openBox(boxId);
      return;
    }
    // Back to every project — and to the project that view was last on (user,
    // 2026-09-05). Only from inside a box scope: once the user has hopped to a
    // member, strip and tabs already agree, and re-activating would be a
    // pointless project-runtime switch. `setActive` with the id it already
    // holds is the established way back out of a box (CenterPanel keys its
    // `setScope` off `switchGeneration` for exactly this).
    if (!scope.startsWith(BOX_SCOPE_PREFIX)) return;
    const back = lastUnslicedScope.current;
    const alive = projects.some((p) => p.id === back && p.status !== "inactive");
    void setActive(alive ? back : null);
  };

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
  const visibleProjects = useMemo<ProjectEntry[]>(() => {
    if (!currentBox) return activeProjects;
    return projects
      .filter((p) => currentBoxMemberIds.has(p.id) || p.id === scope)
      .sort((a, b) => a.position - b.position);
  }, [activeProjects, currentBox, currentBoxMemberIds, projects, scope]);

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
  // box it was already in; the user renames the new box via its chip.
  const groupProjects = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    await boxProjects([toId, fromId], { name: t("projectSwitcher.newBox") });
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
    if (project.remote) useBigFoldersStore.getState().openOnce(project.id);
  };

  return (
    <>
      {showSettings && createPortal(
        <SettingsDialog
          onClose={() => setShowSettings(false)}
          initialPanel={settingsPanel}
          initialAnchor={settingsAnchor}
        />,
        document.body,
      )}

      {dialog === "new" && createPortal(
        <ProjectDialog
          kind="new"
          onClose={() => setDialog(null)}
          onProject={(project) => void addAndAudit(project)}
        />,
        document.body,
      )}
      {(dialog === "import" || dialog === "clone") && createPortal(
        <ProjectDialog
          kind="import"
          initialImportSource={dialog === "clone" ? "git" : "folder"}
          onClose={() => setDialog(null)}
          onProject={(project) => void addAndAudit(project)}
        />,
        document.body,
      )}
      {dialog === "bundle" && (
        <ProjectImportBundleDialog
          onClose={() => setDialog(null)}
          onProject={(project) => void addAndAudit(project)}
        />
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
          className={`project-pills-region${pillOverflow.left ? " overflow-left" : ""}${
            pillOverflow.right ? " overflow-right" : ""
          }`}
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
            onSelect={selectBox}
            onRename={(boxId, name) => void renameBox(boxId, name)}
            // The pill's Delete is one right-click away on every box now, so it
            // asks the same question the editor's Dissolve does — and says the
            // same thing about what survives (folder, agent docs, members).
            onDelete={(boxId) => {
              const target = boxes.find((b) => b.id === boxId);
              if (!target) return;
              if (!window.confirm(t("boxEditor.dissolveConfirm", { name: target.name }))) return;
              void deleteBox(boxId);
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
            ‹
          </button>
          <div
            className="project-pills-scroll"
            ref={pillsScrollRef}
            // Pressing the bare strip (no pill under the cursor) drags the
            // window; pills/boxes are nested so their press is left untouched.
            onMouseDown={startWindowDrag}
          >
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
            ›
          </button>
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
                    onClick={() => { closeHeaderMenu(ADD_MENU_ID); openHpcWizard(); }}
                  >
                    {t("projectSwitcher.hpcPipeline")} <UntestedTag id="projectSwitcher.hpcPipeline" />
                  </button>
                  <button
                    className="untested"
                    onClick={() => {
                      closeHeaderMenu(ADD_MENU_ID);
                      useBoxEditorStore.getState().openCreate();
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
          onOpenBox={(id) => selectBox(id)}
        />
      </div>
    </>
  );
}
