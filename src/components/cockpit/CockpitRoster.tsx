import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, CloseIcon, ClockIcon, CloudIcon, DotIcon, RefreshIcon } from "../common/icons/Icon";

import { AGENT_SORTS } from "../../../shared/agentSort";
import { formatAgo, formatClock, rosterTurnLabel } from "./cockpitFormat";
import type { Roster, RosterRow } from "../../lib/cockpit/roster";
import { rosterNote, stepSelection } from "../../lib/cockpit/roster";
import { useT, type TranslationKey } from "../../lib/i18n";
import { jumpToTab } from "../../lib/shortcuts/tabJump";
import { registerCockpitRoster } from "../../lib/shortcuts/steeringCockpit";
import { steeringKeyIs, type SteeringAction, type SteeringKeyMap } from "../../lib/shortcuts/steeringBindings";
import { sendSteeringPrompt } from "../../lib/shortcuts/steeringAgent";
import { aiIsOff } from "../../lib/aiSwitch";
import { useSettingsStore } from "../../stores/settings";
import { useBoxesStore } from "../../stores/boxes";
import { useCockpitStore, type CockpitRosterMode, type CockpitStateFilter } from "../../stores/cockpit";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { isDetachedWindow } from "../../stores/detachedContext";
import { ROOT_SCOPE } from "../../stores/tabs";
import { StarIcon } from "../layout/StarIcon";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { CockpitUntested } from "./CockpitUntested";
import { UntestedTag } from "../common/UntestedTag";
import { CONTINUE_PROMPT } from "../tabs/TabLocalityBadges";
import { tabColorCss } from "../../lib/theme/tabColors";

const STATE_LABEL: Record<RosterRow["state"], TranslationKey> = {
  question: "cockpit.state.asking",
  working: "cockpit.state.working",
  interrupted: "cockpit.state.interrupted",
  done: "cockpit.state.done",
  idle: "cockpit.state.idle",
};

const FILTERS: { id: CockpitStateFilter; label: TranslationKey }[] = [
  { id: "active", label: "cockpit.filter.active" },
  { id: "asking", label: "cockpit.filter.asking" },
  { id: "working", label: "cockpit.filter.working" },
  { id: "done", label: "cockpit.filter.done" },
  { id: "all", label: "cockpit.filter.all" },
];

const MODES: { id: CockpitRosterMode; label: TranslationKey }[] = [
  { id: "flat", label: "cockpit.mode.flat" },
  { id: "project", label: "cockpit.mode.project" },
  { id: "box", label: "cockpit.mode.box" },
];

const SORT_LABEL: Record<string, TranslationKey> = {
  lastWorking: "agentPrompts.sort.lastWorking",
  lastDone: "agentPrompts.sort.lastDone",
  native: "agentPrompts.sort.native",
};

/** Jump to the tab: show it in its own pane and close the cockpit. A root tab
 *  has no pane behind the window: the jump opens the Root view of this very
 *  window on it, so there is nothing to close (it would close what just opened). */
export function jumpToRow(ptyId: string) {
  const at = ptyId.indexOf(":");
  const scope = ptyId.slice(0, at);
  jumpToTab(scope, ptyId.slice(at + 1));
  if (scope !== ROOT_SCOPE || isDetachedWindow()) useRootOverlayStore.getState().close();
}

/** ▶ Continue an interrupted row — the tab strip's action, AI switch respected. */
export function continueRow(row: RosterRow) {
  if (row.state !== "interrupted" || aiIsOff() || !row.tab.scheduleTargetId) return;
  void sendSteeringPrompt(row.tab, CONTINUE_PROMPT).catch(() => {});
}

/** The scope's chip in a roster row / the detail head: its name; the root
 *  scope's wears the Root star (its agents are ordinary rows, marked as root's). */
export function ScopeChip({ scope }: { scope: RosterRow["scope"] }) {
  return (
    <span className={`cockpit-chip${scope.kind === "root" ? " root" : ""}`}>
      {scope.kind === "root" && <StarIcon />} {scope.name}
    </span>
  );
}

/**
 * Grouping and sort in one button, `<grouping> · <sort> ▾`, and the shared
 * popover (`ContextMenuPortal`, `.tab-new-menu`) under it. The same two
 * choices stay reachable by their rebindable steering keys' own store
 * setters; this is only the mouse's way.
 */
function RosterViewMenu({ mode, sort }: { mode: CockpitRosterMode; sort: string }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const close = () => setAnchor(null);
  const toggle = () => {
    if (anchor) return close();
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.left, y: rect.bottom + 4 });
  };
  const modeLabel = t(MODES.find((m) => m.id === mode)?.label ?? "cockpit.mode.flat");
  const sortLabel = t(SORT_LABEL[sort] ?? SORT_LABEL.lastWorking);
  const item = (key: string, on: boolean, label: string, pick: () => void) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={on}
      className={`tab-new-menu-item${on ? " selected" : ""}`}
      onClick={() => {
        pick();
        close();
      }}
    >
      <span className="cockpit-menu-check">{on && <CheckIcon />}</span>
      {label}
    </button>
  );
  return (
    <>
      <button
        type="button"
        ref={ref}
        className="settings-btn sm cockpit-view-menu-btn"
        aria-haspopup="menu"
        aria-expanded={anchor != null}
        title={`${t("cockpit.roster.grouping")} · ${t("cockpit.roster.sort")}`}
        onClick={toggle}
      >
        {modeLabel} · {sortLabel} <ChevronDownIcon />
      </button>
      {anchor && (
        <ContextMenuPortal x={anchor.x} y={anchor.y} keepBelow className="tab-new-menu cockpit-view-menu" onClose={close}>
          <div className="tab-new-menu-group-label">{t("cockpit.roster.grouping")}</div>
          {MODES.map((m) => item(m.id, mode === m.id, t(m.label), () => useCockpitStore.getState().setRosterMode(m.id)))}
          <div className="tab-new-menu-group-label">{t("cockpit.roster.sort")}</div>
          {AGENT_SORTS.map((id) => item(id, sort === id, t(SORT_LABEL[id]), () => useCockpitStore.getState().setSort(id)))}
        </ContextMenuPortal>
      )}
    </>
  );
}

function Row({ row, selected, now, onOpen }: { row: RosterRow; selected: boolean; now: number; onOpen?: (ptyId: string) => void }) {
  const t = useT();
  const { facts } = row;
  const turn = rosterTurnLabel(row, now, t);
  const note = rosterNote(row, now);
  return (
    <div
      role="option"
      aria-selected={selected}
      data-pty={row.ptyId}
      className={`cockpit-roster-row state-${row.state}${selected ? " selected" : ""}`}
      style={tabColorCss(row.tab.color) ? { borderLeftColor: tabColorCss(row.tab.color) } : undefined}
      onClick={() => {
        useCockpitStore.getState().select(row.ptyId);
        onOpen?.(row.ptyId);
      }}
      onDoubleClick={() => jumpToRow(row.ptyId)}
    >
      <div className="cockpit-roster-line">
        {/* One filled dot in the state's colour (CSS, `.state-*`); the word is its title. */}
        <span className="cockpit-state-mark" title={t(STATE_LABEL[row.state])} role="img" aria-label={t(STATE_LABEL[row.state])}>
          <DotIcon />
        </span>
        <span className="cockpit-roster-tab">{row.tab.label}</span>
        <ScopeChip scope={row.scope} />
        {facts.model && <span className="cockpit-meta">{facts.model}</span>}
        {facts.plan && <small className="agent-mode-mark plan">{t("tabBar.modePlan")}</small>}
        {facts.goal && <small className="agent-mode-mark goal">{t("tabBar.modeGoal")}</small>}
        {!!facts.subagents && <span className="cockpit-meta">{t("cockpit.roster.subagents", { count: facts.subagents })}</span>}
        {row.host && (
          <span className={`cockpit-chip host${row.hostDown ? " down" : ""}`} title={row.hostDown ? t("cockpit.roster.connectFirst") : row.host}>
            <CloudIcon /> {row.hostDown ? t("cockpit.roster.connectFirst") : row.host}
          </span>
        )}
        <span className="cockpit-roster-trail">
          {row.tab.autoContinue && <span className="cockpit-meta" title={t("cockpit.roster.autoContinue")}><RefreshIcon /></span>}
          {row.nextScheduleAt !== undefined && (
            <span className="cockpit-meta" title={t("cockpit.roster.nextSchedule")}><ClockIcon /> {formatClock(row.nextScheduleAt)}</span>
          )}
          {turn && <span className="cockpit-meta">{turn}</span>}
        </span>
      </div>
      {row.lastPrompt && <div className="cockpit-roster-prompt">{row.lastPrompt}</div>}
      {/* What the agent says it is doing, or what it says blocks it (the blocker takes the line): its own words, marked and timed, apart from the detected state above. */}
      {note && (
        <div
          className={note.kind === "blocker" ? "cockpit-roster-note blocker" : "cockpit-roster-note"}
          title={t(note.kind === "blocker" ? "cockpit.notes.blockerTitle" : "cockpit.notes.activityTitle", { ago: formatAgo(note.setAt, now) })}
        >
          <span className="cockpit-note-tag">{t(note.kind === "blocker" ? "cockpit.notes.blockerTag" : "cockpit.notes.byAgent")}</span>
          <span className="cockpit-note-text">{note.text}</span>
          <span className="cockpit-meta">{formatAgo(note.setAt, now)}</span>
          {note.kind === "blocker" ? <UntestedTag id="cockpit.mcp.blocker" /> : <UntestedTag id="cockpit.mcp.activity" />}
        </div>
      )}
    </div>
  );
}

/**
 * The roster (`docs/desktop_cockpit_plan.md`, View 1 · middle): every agent
 * tab of every hydrated scope, with sort, Flat / By project / By box, state
 * chips and a text filter. Its keys are rebindable (Settings → Keyboard
 * steering · Cockpit): ↓/↑ (J/K) move, Enter jumps to the tab, Space (→)
 * shows it in the detail pane, C continues an interrupted row, / filters.
 */
export function CockpitRoster({
  roster,
  selected,
  now,
  onShow,
  onOpen,
  headExtra,
}: {
  roster: Roster;
  selected: string | null;
  now: number;
  onShow: (ptyId: string) => void;
  /** A click on a row (after it was selected): the narrow window opens the detail on it. */
  onOpen?: (ptyId: string) => void;
  /** Controls at the right end of the head (the narrow band's Needs-you chip). */
  headExtra?: ReactNode;
}) {
  const t = useT();
  const mode = useCockpitStore((s) => s.rosterMode);
  const stateFilter = useCockpitStore((s) => s.stateFilter);
  const sort = useCockpitStore((s) => s.sort);
  const query = useCockpitStore((s) => s.query);
  const scopeFilter = useCockpitStore((s) => s.scopeFilter);
  const boxes = useBoxesStore((s) => s.boxes);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The selection follows the keys into view, in one jump (no smooth scroll).
  useEffect(() => {
    if (!selected) return;
    listRef.current?.querySelector<HTMLElement>(`[data-pty="${CSS.escape(selected)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const runAction = (action: SteeringAction) => {
    const store = useCockpitStore.getState();
    if (action === "cockpitDown" || action === "cockpitUp") {
      store.select(stepSelection(roster.rows, store.selected, action === "cockpitDown" ? 1 : -1));
    } else if (action === "cockpitJump" && store.selected) jumpToRow(store.selected);
    else if (action === "cockpitShow" && store.selected) onShow(store.selected);
    else if (action === "cockpitContinue") {
      const row = roster.rows.find((r) => r.ptyId === store.selected);
      if (row) continueRow(row);
    } else if (action === "cockpitFilter") filterRef.current?.focus();
  };
  const latestAction = useRef(runAction);
  latestAction.current = runAction;
  useEffect(() => registerCockpitRoster((action, ptyId) => {
    if (ptyId) useCockpitStore.getState().select(ptyId);
    latestAction.current(action);
    return useCockpitStore.getState().selected;
  }), []);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
    const keys = useSettingsStore.getState().settings?.steering_keys as SteeringKeyMap | undefined;
    const actions: SteeringAction[] = ["cockpitDown", "cockpitUp", "cockpitJump", "cockpitShow", "cockpitContinue", "cockpitFilter"];
    const action = actions.find((a) => steeringKeyIs(e, a, keys));
    if (action) { e.preventDefault(); runAction(action); }
  };

  const groupLabel = (id: string, label: string) =>
    mode === "box" ? (boxes.find((b) => b.id === id)?.name ?? t("cockpit.roster.noBox")) : label;

  return (
    <section className="cockpit-roster" aria-label={t("cockpit.roster.title")}>
      <div className="cockpit-column-head">
        <span>
          {t("cockpit.roster.title")}{" "}
          <span className="cockpit-count">
            {roster.rows.length < roster.counts.total
              ? t("cockpit.roster.countOf", { shown: roster.rows.length, total: roster.counts.total })
              : roster.counts.total}
          </span>
        </span>
        <CockpitUntested view="now" /><UntestedTag id="steering.cockpit" />
        <span className="cockpit-meta">
          {t("cockpit.roster.summary", { working: roster.counts.working, asking: roster.counts.asking })}
        </span>
        {headExtra}
      </div>
      <div className="cockpit-roster-controls">
        {scopeFilter && (
          <button type="button" className="cockpit-chip-btn on" onClick={() => useCockpitStore.getState().showScope(null)} title={t("cockpit.roster.clearScope")}>
            {t("cockpit.roster.onlyScope", { name: roster.rows[0]?.scope.name ?? scopeFilter })} <CloseIcon />
          </button>
        )}
        <input
          ref={filterRef}
          type="search"
          className="settings-input sm cockpit-filter"
          value={query}
          placeholder={t("cockpit.roster.filter")}
          aria-label={t("cockpit.roster.filter")}
          onChange={(e) => useCockpitStore.getState().setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              useCockpitStore.getState().setQuery("");
            } else if (e.key === "Enter" || e.key === "ArrowDown") {
              e.preventDefault();
              listRef.current?.focus();
            }
          }}
        />
        <RosterViewMenu mode={mode} sort={sort} />
        <div className="cockpit-chips" role="group" aria-label={t("cockpit.roster.stateFilter")}>
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`cockpit-chip-btn${stateFilter === f.id ? " on" : ""}`} aria-pressed={stateFilter === f.id} onClick={() => useCockpitStore.getState().setStateFilter(f.id)}>
              {t(f.label)}
            </button>
          ))}
        </div>
      </div>
      <div ref={listRef} className="cockpit-column-scroll cockpit-roster-list" role="listbox" tabIndex={0} aria-label={t("cockpit.roster.title")} onKeyDown={onKeyDown}>
        {roster.rows.length === 0 && <p className="cockpit-empty">{t("cockpit.roster.empty")}</p>}
        {roster.groups.map((group) => (
          <div key={group.id || "all"} className="cockpit-roster-group">
            {mode !== "flat" && <div className="tab-new-menu-group-label">{groupLabel(group.id, group.label)}</div>}
            {group.rows.map((row) => <Row key={row.ptyId} row={row} selected={row.ptyId === selected} now={now} onOpen={onOpen} />)}
          </div>
        ))}
      </div>
    </section>
  );
}
