import { useEffect, useState, type ReactNode } from "react";
import {
  effectiveTabLocation,
  remoteHostIdOf,
  type TabEntry,
  type TabLocation,
} from "../../stores/tabs";
import {
  isLocatableKind,
  localityHostLabel,
  workerRunnable,
  type LocalityHost,
} from "../../stores/tabs/tabLocation";
import { useFileSourcesStore } from "../../stores/viewers/fileSources";
import { useRunHostPrefStore } from "../../stores/remote/runHostPref";
import { UntestedTag } from "../common/UntestedTag";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { useT } from "../../lib/i18n";
import { CloudIcon, HomeIcon, PlayMark } from "../common/icons/Icon";
import { useAgentModelsStore, agentTabLabel, tabModeMarks } from "../../stores/agents/agentModels";
import { screenModeMarks } from "../../lib/agents/agentModel";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { sendSteeringPrompt } from "../../lib/shortcuts/steeringAgent";
import { useAiOff } from "../../lib/aiSwitch";

/**
 * The two per-tab local/remote badges + the locality menu, factored out so the
 * main-window `TabBar` and each detached popout's tab strip render the SAME
 * controls (the user asked for parity, and drift between two copies is exactly
 * what an extraction prevents). Everything here reads the tab payload + the
 * streamed host list; WHERE a location change is applied is the caller's
 * `onChoose` (the main store directly, or a streamed edit from a popout).
 */

/** The open locality-menu state a strip owns: which tab, where to anchor it, and
 *  the two-level drill (`root` = Local↔Remote, `machines` = primary + workers). */
export interface LocalityMenuState {
  key: string;
  x: number;
  y: number;
  view: "root" | "machines";
}

/** A tab's effective location, or `"local"` for a missing tab — the `current`
 *  a `LocalityMenu` dots, without the caller importing the tabs helpers.
 *  `pinned`: the project lives only on its host (`isHostPinned`). */
export function tabLocation(tab: TabEntry | undefined, pinned = false): TabLocation {
  return tab ? effectiveTabLocation(tab, { hostPinned: pinned }) : pinned ? "remote" : "local";
}

/** The file-source badge on a viewer tab: a clickable Local/Remote toggle when
 *  the viewer published a switch (the file exists on both sides of a remote
 *  project), else the plain read-only glyph. Renders nothing on a local tab. */
export function TabSourceBadge({ tabKey }: { tabKey: string }) {
  const t = useT();
  const src = useFileSourcesStore((s) => s.byTab[tabKey]);
  const ctl = useFileSourcesStore((s) => s.controlsByTab[tabKey]);
  if (ctl) {
    const onRemote = ctl.current === "remote";
    const blocked = !onRemote && ctl.remoteDisabled;
    return (
      <button
        className={`tab-source clickable ${onRemote ? "remote" : "local"}${blocked ? " disabled" : ""}`}
        title={
          blocked
            ? t("tabLocality.noCopyTitle")
            : onRemote
              ? t("tabLocality.readingRemoteTitle")
              : t("tabLocality.readingLocalTitle")
        }
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (blocked) return;
          ctl.set(onRemote ? "local" : "remote");
        }}
      >
        {onRemote ? <CloudIcon /> : <HomeIcon />}
      </button>
    );
  }
  if (src !== "remote" && src !== "local") return null;
  return (
    <span
      className={`tab-source ${src}`}
      title={
        src === "remote"
          ? t("tabLocality.remoteNativeTitle")
          : t("tabLocality.localMirrorTitle")
      }
    >
      {src === "remote" ? <CloudIcon /> : <HomeIcon />}
    </span>
  );
}

/**
 * The TeX ⇄ PDF coupling mark: on a compiled-PDF tab it points back at the open
 * `.tex` that produces it, and on that source tab it points at the PDF — one
 * component for both halves, so the pair can never be marked asymmetrically.
 *
 * Deliberately the SAME 16px badge box as the locality/source badges rather than
 * a new visual language: the tab strip already reads left-to-right as
 * label → badges → close, and a coupled pair is one more fact about the tab, not
 * a new kind of chrome. The glyph is the mark and the button is the jump — a
 * click activates the partner tab (in whatever subwindow it lives), which is the
 * only thing anyone wants to do once they have noticed the pair.
 *
 * Renders nothing when the partner is not open, so an ordinary PDF tab and a
 * `.tex` with no build are untouched. `partner` is computed by the host from the
 * tab list it owns (`lib/viewers/tex/texPdfLink`'s `texPdfPartner`), keeping this leaf pure
 * and usable from both the main-window bar and a popout's strip.
 */
export function TabTexLinkBadge({
  partner,
  onFocus,
}: {
  /** The coupled tab, or null when this tab has no open counterpart. */
  partner: TabEntry | null;
  /** Activate the partner tab (main window: the store's `setActive`; a popout:
   *  its streamed activate). */
  onFocus: (key: string) => void;
}) {
  const t = useT();
  if (!partner) return null;
  const toPdf = partner.viewer === "pdf";
  return (
    <button
      className={`tab-texlink ${toPdf ? "pdf" : "tex"}`}
      title={
        toPdf
          ? t("tabLocality.texLinkToPdfTitle", { name: partner.label })
          : t("tabLocality.texLinkToTexTitle", { name: partner.label })
      }
      aria-label={
        toPdf
          ? t("tabLocality.texLinkToPdfTitle", { name: partner.label })
          : t("tabLocality.texLinkToTexTitle", { name: partner.label })
      }
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onFocus(partner.key);
      }}
    >
      ⇄
    </button>
  );
}

/** The locality badge (⌂ local / ☁ remote) on an agent/shell tab of a remote
 *  project — click to open the machine menu. Renders nothing for a non-locatable
 *  tab kind. Callers gate on the project being remote before rendering it. */
export function TabLocalityBadge({
  tab,
  pinned = false,
  primaryHost,
  computeHosts,
  onOpen,
}: {
  tab: TabEntry;
  /** The project lives only on its host (`isHostPinned`): the tab runs there
   *  whatever it stored, so the badge says ☁ and the menu has no Local row. */
  pinned?: boolean;
  primaryHost?: string;
  computeHosts?: LocalityHost[];
  /** Open the menu anchored under the badge; `startOnMachines` jumps straight to
   *  the machine list when the tab already runs remotely (one click closer to a
   *  remote→remote reassignment). */
  onOpen: (rect: DOMRect, startOnMachines: boolean) => void;
}) {
  const t = useT();
  if (!isLocatableKind(tab.kind)) return null;
  const loc = effectiveTabLocation(tab, { hostPinned: pinned });
  const hostId = remoteHostIdOf(loc);
  const label = localityHostLabel(loc, { primaryHost, computeHosts });
  return (
    <button
      className={`tab-locality ${hostId === null ? "local" : "remote"}`}
      title={t("tabLocality.runsOnClickTitle", { label })}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onOpen((e.currentTarget as HTMLElement).getBoundingClientRect(), hostId !== null);
      }}
    >
      {hostId === null ? <HomeIcon /> : <CloudIcon />}
    </button>
  );
}

/** The two-level locality menu (Local ↔ Remote, then a machine sub-picker). A
 *  worker that holds no code (not shared-fs, sync off) is offered disabled — sync
 *  always stays with the primary; the worker only runs scripts. Rendered in a
 *  portal with a click-away backdrop. On a `pinned` project it is the machine
 *  list alone: there is no local copy to run in, so no Local row to go back to. */
export function LocalityMenu({
  menu,
  current,
  pinned = false,
  primaryHost,
  computeHosts,
  onClose,
  onChangeView,
  onChoose,
  carriesConversation,
}: {
  menu: LocalityMenuState;
  /** The location currently selected (dotted in the menu). A tab's
   *  `effectiveTabLocation`, or a file viewer's run-host preference. */
  current: TabLocation;
  /** The project lives only on its host (`isHostPinned`). */
  pinned?: boolean;
  primaryHost?: string;
  computeHosts?: LocalityHost[];
  onClose: () => void;
  onChangeView: (view: "root" | "machines") => void;
  onChoose: (key: string, loc: TabLocation) => void;
  /** The tab is an agent whose conversation a switch takes along
   *  (`agentLocationSwitch`): the menu says so. */
  carriesConversation?: boolean;
}) {
  const t = useT();
  const cur = current;
  const onRemoteNow = remoteHostIdOf(cur) !== null;
  const choose = (loc: TabLocation) => {
    onChoose(menu.key, loc);
    onClose();
  };
  const machineItem = (
    loc: TabLocation,
    glyph: ReactNode,
    text: string,
    opts?: { disabled?: boolean; note?: string; title?: string; tag?: ReactNode },
  ) => (
    <button
      key={loc}
      className="tab-new-menu-item"
      title={opts?.title}
      disabled={opts?.disabled}
      onClick={() => !opts?.disabled && choose(loc)}
    >
      <span className="tab-new-menu-dot tab-new-menu-dot--accent">
        {cur === loc ? "●" : glyph}
      </span>
      {text}
      {opts?.note && <span className="tab-menu-hint">{opts.note}</span>}
      {opts?.tag}
    </button>
  );
  return (
    <ContextMenuPortal
      x={menu.x}
      y={menu.y}
      onClose={onClose}
      className="tab-new-menu"
    >
        {menu.view === "root" && !pinned ? (
          <>
            {carriesConversation && (
              <div className="tab-new-menu-hint" title={t("tabLocality.carriesConversationTitle")}>
                {t("tabLocality.carriesConversation")}
                <UntestedTag id="agentLocationSwitch.1" />
              </div>
            )}
            {machineItem("local", <HomeIcon />, t("tabLocality.localMirrorItem"))}
            <button
              className="tab-new-menu-item"
              onClick={() => onChangeView("machines")}
            >
              <span className="tab-new-menu-dot tab-new-menu-dot--accent">
                {onRemoteNow ? "●" : <CloudIcon />}
              </span>
              {t("tabLocality.remoteEllipsis")}
              <span className="tab-menu-hint">{t("tabLocality.chooseMachineHint")}</span>
            </button>
          </>
        ) : (
          <>
            {pinned ? (
              <div className="tab-new-menu-hint" title={t("tabLocality.pinnedHostTitle")}>
                {t("tabLocality.runOnMachine")}
                <UntestedTag id="tabLocality.pinnedHostTitle" />
              </div>
            ) : (
              <button
                className="tab-new-menu-item tab-menu-back"
                onClick={() => onChangeView("root")}
              >
                <span className="tab-new-menu-dot">‹</span>
                {t("tabLocality.runOnMachine")}
                <UntestedTag id="tabLocalityBadges.1" />
              </button>
            )}
            {machineItem(
              "remote",
              <CloudIcon />,
              primaryHost ? t("tabLocality.primaryWithHost", { host: primaryHost }) : t("tabLocality.primary"),
            )}
            {(computeHosts ?? []).map((h) =>
              machineItem(
                `host:${h.id}`,
                <CloudIcon />,
                h.label || h.host || h.id,
                workerRunnable(h, pinned)
                  ? undefined
                  : {
                      disabled: true,
                      note: t("tabLocality.syncOff"),
                      title: t(pinned ? "tabLocality.syncOffPinnedTitle" : "tabLocality.syncOffTitle"),
                      tag: pinned ? <UntestedTag id="tabLocality.syncedCopyPinned" /> : undefined,
                    },
              ),
            )}
          </>
        )}
    </ContextMenuPortal>
  );
}

/**
 * The file viewer's "run on machine" picker — a labelled control (beside the
 * Remote/Local *source* switch) that chooses WHICH machine a Run/Debug or shell
 * launched from this project runs on, distinct from which side its files are
 * *read* from. Writes the per-project run-host preference (`useRunHostPrefStore`)
 * that `lib/terminal/pythonRun` reads at launch. Reuses the same two-level `LocalityMenu`
 * as the tab badge, so the machine list + worker eligibility stay identical.
 * Shown only for remote projects (a local project has no machine axis).
 */
export function RunHostPicker({
  projectId,
  pinned = false,
  primaryHost,
  computeHosts,
}: {
  projectId: string;
  /** The project lives only on its host (`isHostPinned`): no "this computer"
   *  choice, and a stored `"local"` preference reads as the primary. */
  pinned?: boolean;
  primaryHost?: string;
  computeHosts?: LocalityHost[];
}) {
  const t = useT();
  const pref = useRunHostPrefStore((s) => s.byProject[projectId]);
  const setPref = useRunHostPrefStore((s) => s.set);
  const [menu, setMenu] = useState<LocalityMenuState | null>(null);
  // Unset ⇒ the primary, which is where a HOST-side run lands with no choice made
  // (`pythonRunPlan`) — and a host-side file is the only case this control is
  // rendered for, so the label cannot lie about a local run it never governs.
  const current: TabLocation = pref && !(pinned && pref === "local") ? pref : "remote";
  const label = localityHostLabel(current, { primaryHost, computeHosts });
  const onRemote = remoteHostIdOf(current) !== null;
  return (
    <>
      <button
        type="button"
        className="side-panel-run-host"
        // The label ellipsizes in a narrow (docked subwindow) row, so the full
        // machine name has to survive somewhere — the tooltip names it.
        title={`${t("tabLocality.runHostTitle", { label })}\n${t("tabLocality.runHostSubtitle")}`}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu({
            key: projectId,
            x: r.left,
            y: r.bottom + 2,
            view: onRemote || pinned ? "machines" : "root",
          });
        }}
      >
        <span aria-hidden="true">{onRemote ? <CloudIcon /> : <HomeIcon />}</span>
        <span className="run-host-label">{t("tabLocality.runLabel", { label })}</span>
      </button>
      {menu && (
        <LocalityMenu
          menu={menu}
          current={current}
          pinned={pinned}
          primaryHost={primaryHost}
          computeHosts={computeHosts}
          onClose={() => setMenu(null)}
          onChangeView={(view) => setMenu((m) => (m ? { ...m, view } : m))}
          onChoose={(_key, loc) => setPref(projectId, loc)}
        />
      )}
    </>
  );
}

/** The status glyph leading a tab's label, in its ring's colour: ▶ working,
 *  ? waiting on a decision, ✓ finished unseen. The ring alone left the three
 *  states to be told apart by colour and stroke; the glyph names them. Takes the
 *  strip's already-resolved state class (`busyStateClass`) so every strip marks
 *  exactly the tabs its ring marks.
 *
 *  A tab running a COMMAND wears the ▶ in the shell colour instead
 *  (`--status-shell-working`) — a shell tab, or an agent whose turn is over
 *  while a shell it started keeps going. When an agent is working AND has a
 *  BACKGROUNDED command of its own running (`working job`), it gets BOTH marks,
 *  one per colour: the two things are happening at once, and a single glyph
 *  could only name one of them. (The tool call an agent waits on is not a second
 *  thing — it IS the turn.) */
/** How many fixed mark cells a tab of `kind` keeps (see {@link TabStatusMark}'s
 *  `slots`): an agent tab two (its turn, and a command of its own beside it), a
 *  shell tab one (the command), and a tab that never runs anything none. */
export function statusMarkSlots(kind: TabEntry["kind"]): 0 | 1 | 2 {
  return kind === "agent" || kind === "local_agent" ? 2 : kind === "shell" ? 1 : 0;
}

export function TabStatusMark({ stateClass, slots }: { stateClass: string; slots?: 0 | 1 | 2 }) {
  const t = useT();
  const state = stateClass.includes("working")
    ? "working"
    : stateClass.includes("needs-decision")
      ? "decision"
      : stateClass.includes("finished")
        ? "done"
        : stateClass.includes("interrupted")
          ? "interrupted"
          : null;
  if (!state && !slots) return null;
  // ▶ is drawn (`PlayMark`): as a character, a window's font fallback could
  // swap it for a colour emoji. ■ (the stop square) is not emoji-capable.
  const glyph =
    state === "working" ? <PlayMark /> : state === "decision" ? "?" : state === "interrupted" ? "■" : "✓";
  const label = t(
    state === "working"
      ? "tabBar.statusWorking"
      : state === "decision"
        ? "tabBar.statusDecision"
        : state === "interrupted"
          ? "tabBar.statusInterrupted"
          : "tabBar.statusDone",
  );
  const shellLabel = t("tabBar.statusRunning");
  // `shell` alone: the command IS what the tab is doing, so the one mark is the
  // shell's. `job`: the agent's mark, then the command's beside it.
  const commandOnly = stateClass.includes("shell");
  const alsoCommand = stateClass.includes("job");
  const shellMark = (
    <span
      className="tab-status-mark working shell"
      title={shellLabel}
      aria-label={shellLabel}
    >
      <PlayMark />
    </span>
  );
  const ownMark = state ? (
    <span className={`tab-status-mark ${state}`} title={label} aria-label={label}>
      {glyph}
    </span>
  ) : null;
  if (!slots) {
    if (commandOnly) return shellMark;
    return (
      <>
        {ownMark}
        {alsoCommand && shellMark}
      </>
    );
  }
  // In a tab strip every mark has its own fixed cell, laid out whether or not
  // anything is in it: a command coming and going, or a turn swapping `?` for
  // ▶, must not change the tab's width — that shifts every tab after it, and a
  // busy agent did it several times a second. An agent tab's command mark
  // keeps the second cell even when it is the only mark, so it never jumps.
  const cells: ReactNode[] =
    slots === 2 ? [commandOnly ? null : ownMark, commandOnly || alsoCommand ? shellMark : null] : [commandOnly ? shellMark : ownMark];
  return (
    <span className="tab-status-marks">
      {cells.map((cell, i) => (
        <span key={i} className="tab-status-slot">
          {cell}
        </span>
      ))}
    </span>
  );
}

/** The word the Continue pill submits — the one the auto-continue switch sends
 *  at a rate-limit rollover, typed here on demand. */
const CONTINUE_PROMPT = "continue";

/** A ▶ Continue pill on an agent tab whose turn the user cut off (the ■ mark,
 *  `interrupted` in the strip's state class): one click submits `continue` into
 *  that tab without switching to it, through the steering prompt box's path
 *  (`sendSteeringPrompt` — recorded as a prompt sent from this desktop, queued
 *  by the CLI if a turn has started meanwhile). Typing what the user could have
 *  typed, nothing more (AGENTS.md, agent authority). Hidden while AI is off,
 *  where the write would be refused. Shared by every tab strip. */
export function TabContinueButton({ tab, stateClass }: { tab: TabEntry; stateClass: string }) {
  const t = useT();
  const aiOff = useAiOff();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = tab.kind === "agent" || tab.kind === "local_agent";
  if (!agent || !tab.scheduleTargetId || aiOff || !stateClass.includes("interrupted")) return null;
  const title = error ? t("tabBar.continueFailed", { reason: error }) : t("tabBar.continueTitle");
  return (
    <>
      <button
        type="button"
        className="tab-continue"
        title={title}
        aria-label={title}
        disabled={sending}
        // Neither a drag, an activation nor a root-console tab switch: the
        // point is to set the agent going again without leaving this tab.
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setSending(true);
          setError(null);
          sendSteeringPrompt(tab, CONTINUE_PROMPT)
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setSending(false));
        }}
      >
        <PlayMark />
        {t("tabBar.continue")}
      </button>
      <UntestedTag id="tabBar.continue" />
    </>
  );
}

/** How often the tab in front has its own screen re-read for the marks. The
 *  xterm is local and the read is the footer's few rows, so this is cheap;
 *  it is what makes a Shift+Tab into plan mode show without waiting for a turn. */
const MODE_TICK_MS = 2_000;

/** The plan / goal marks on an agent tab: PLAN while the session's own status
 *  line says plan mode, GOAL while a `/goal` is running — per the session's own
 *  record where the CLI keeps one (`tabModeMarks`), else its footer. Read-only — the
 *  mode is the agent CLI's to set (see the note in `TabBar` about the removed
 *  Plan/Auto toggle); this only shows what the session prints, with the parser
 *  the phone's Mode chip uses (`lib/agents/agentModel.screenModeMarks`).
 *
 *  The tab in front reads its xterm every `MODE_TICK_MS` and records it in the
 *  models store, so the reading it leaves behind when the user switches away is
 *  current. A tab behind is re-read off its live tmux pane at each turn's start
 *  and end (`agentModels`' activity edges) — the only moments the agent itself
 *  changes either mode — and once on mount; a tab with no local tmux pane (a
 *  remote one) keeps what its xterm last said. Shared with the popout strip. */
export function TabAgentModeMarks({ scope, tab, isActive }: { scope: string; tab: TabEntry; isActive: boolean }) {
  const t = useT();
  const agent = tab.kind === "agent" || tab.kind === "local_agent";
  const ptyId = `${scope}:${tab.key}`;
  const modeByTab = useAgentModelsStore((state) => state.modeByTab);
  const goalByTab = useAgentModelsStore((state) => state.goalByTab);
  const marks = tabModeMarks({ modeByTab, goalByTab }, ptyId);
  useEffect(() => {
    if (!agent) return;
    const readXterm = () => {
      const term = terminalFor(ptyId);
      const read = term && screenModeMarks(term.buffer.active, agentTabLabel(tab));
      if (read) useAgentModelsStore.getState().noteModes(ptyId, read);
    };
    if (!isActive) {
      if (tab.tmuxSession) void useAgentModelsStore.getState().refreshScreen(scope, tab);
      else if (!useAgentModelsStore.getState().modeByTab[ptyId]) readXterm();
      return;
    }
    readXterm();
    const timer = window.setInterval(readXterm, MODE_TICK_MS);
    return () => window.clearInterval(timer);
    // `tab` is read for its cmd/label/tmux session, which a respawn changes
    // along with the key; re-running on every new tab object would restart
    // the timer on each store write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, isActive, ptyId, scope, tab.tmuxSession]);
  if (!agent || !marks || (!marks.plan && !marks.goal)) return null;
  return (
    <>
      {marks.plan && (
        <span className="tab-mode-mark plan" title={t("tabBar.modePlanTitle")}>
          {t("tabBar.modePlan")}
        </span>
      )}
      {marks.goal && (
        <span className="tab-mode-mark goal" title={t("tabBar.modeGoalTitle")}>
          {t("tabBar.modeGoal")}
        </span>
      )}
      <UntestedTag id="tabBar.modeMarks" />
    </>
  );
}
