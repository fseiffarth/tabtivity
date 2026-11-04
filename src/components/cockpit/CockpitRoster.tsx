import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { CheckIcon, CloseIcon, ClockIcon, CloudIcon, DotIcon, QuestionIcon, RefreshIcon, RingIcon, StopIcon, type IconProps } from "../common/icons/Icon";

import { AGENT_SORTS, isAgentSort } from "../../../shared/agentSort";
import { formatClock, rosterTurnLabel } from "./cockpitFormat";
import type { Roster, RosterRow } from "../../lib/cockpit/roster";
import { stepSelection } from "../../lib/cockpit/roster";
import { useT, type TranslationKey } from "../../lib/i18n";
import { jumpToTab } from "../../lib/shortcuts/tabJump";
import { steeringKeyIs, type SteeringKeyMap } from "../../lib/shortcuts/steeringBindings";
import { sendSteeringPrompt } from "../../lib/shortcuts/steeringAgent";
import { aiIsOff } from "../../lib/aiSwitch";
import { useSettingsStore } from "../../stores/settings";
import { useBoxesStore } from "../../stores/boxes";
import { useCockpitStore, type CockpitRosterMode, type CockpitStateFilter } from "../../stores/cockpit";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { CONTINUE_PROMPT } from "../tabs/TabLocalityBadges";
import { tabColorCss } from "../../lib/theme/tabColors";

const STATE_MARK: Record<RosterRow["state"], (p: IconProps) => ReactElement> = {
  question: QuestionIcon,
  working: RingIcon,
  interrupted: StopIcon,
  done: CheckIcon,
  idle: DotIcon,
};

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

/** Jump to the tab: show it in its own pane and close the cockpit. */
export function jumpToRow(ptyId: string) {
  const at = ptyId.indexOf(":");
  jumpToTab(ptyId.slice(0, at), ptyId.slice(at + 1));
  useRootOverlayStore.getState().close();
}

/** ▶ Continue an interrupted row — the tab strip's action, AI switch respected. */
export function continueRow(row: RosterRow) {
  if (row.state !== "interrupted" || aiIsOff() || !row.tab.scheduleTargetId) return;
  void sendSteeringPrompt(row.tab, CONTINUE_PROMPT).catch(() => {});
}

function Row({ row, selected, now }: { row: RosterRow; selected: boolean; now: number }) {
  const t = useT();
  const { facts } = row;
  const turn = rosterTurnLabel(row, now, t);
  const Mark = STATE_MARK[row.state];
  return (
    <div
      role="option"
      aria-selected={selected}
      data-pty={row.ptyId}
      className={`cockpit-roster-row state-${row.state}${selected ? " selected" : ""}`}
      style={tabColorCss(row.tab.color) ? { borderLeftColor: tabColorCss(row.tab.color) } : undefined}
      onClick={() => useCockpitStore.getState().select(row.ptyId)}
      onDoubleClick={() => jumpToRow(row.ptyId)}
    >
      <div className="cockpit-roster-line">
        <span className="cockpit-state-mark" title={t(STATE_LABEL[row.state])} aria-label={t(STATE_LABEL[row.state])}>
          <Mark />
        </span>
        <span className="cockpit-roster-tab">{row.tab.label}</span>
        <span className="cockpit-chip">{row.scope.name}</span>
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
export function CockpitRoster({ roster, selected, now, onShow }: { roster: Roster; selected: string | null; now: number; onShow: (ptyId: string) => void }) {
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

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
    const keys = useSettingsStore.getState().settings?.steering_keys as SteeringKeyMap | undefined;
    const store = useCockpitStore.getState();
    const is = (action: Parameters<typeof steeringKeyIs>[1]) => steeringKeyIs(e, action, keys);
    if (is("cockpitDown") || is("cockpitUp")) {
      e.preventDefault();
      store.select(stepSelection(roster.rows, store.selected, is("cockpitDown") ? 1 : -1));
    } else if (is("cockpitJump")) {
      if (store.selected) {
        e.preventDefault();
        jumpToRow(store.selected);
      }
    } else if (is("cockpitShow")) {
      if (store.selected) {
        e.preventDefault();
        onShow(store.selected);
      }
    } else if (is("cockpitContinue")) {
      const row = roster.rows.find((r) => r.ptyId === store.selected);
      if (row) {
        e.preventDefault();
        continueRow(row);
      }
    } else if (is("cockpitFilter")) {
      e.preventDefault();
      filterRef.current?.focus();
    }
  };

  const groupLabel = (id: string, label: string) =>
    mode === "box" ? (boxes.find((b) => b.id === id)?.name ?? t("cockpit.roster.noBox")) : label;

  return (
    <section className="cockpit-roster" aria-label={t("cockpit.roster.title")}>
      <div className="cockpit-column-head">
        <span>
          {t("cockpit.roster.title")} <span className="cockpit-count">{roster.counts.total}</span>
        </span>
        <span className="cockpit-meta">
          {t("cockpit.roster.summary", { working: roster.counts.working, asking: roster.counts.asking })}
        </span>
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
        <select
          className="settings-select sm"
          value={sort}
          aria-label={t("cockpit.roster.sort")}
          onChange={(e) => isAgentSort(e.target.value) && useCockpitStore.getState().setSort(e.target.value)}
        >
          {AGENT_SORTS.map((id) => <option key={id} value={id}>{t(SORT_LABEL[id])}</option>)}
        </select>
        <div className="cockpit-chips" role="group" aria-label={t("cockpit.roster.grouping")}>
          {MODES.map((m) => (
            <button key={m.id} type="button" className={`cockpit-chip-btn${mode === m.id ? " on" : ""}`} aria-pressed={mode === m.id} onClick={() => useCockpitStore.getState().setRosterMode(m.id)}>
              {t(m.label)}
            </button>
          ))}
        </div>
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
            {group.rows.map((row) => <Row key={row.ptyId} row={row} selected={row.ptyId === selected} now={now} />)}
          </div>
        ))}
      </div>
    </section>
  );
}
