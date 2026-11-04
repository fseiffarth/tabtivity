import { useEffect, useMemo, useRef, useState } from "react";

import { storageKey } from "../../lib/brand";
import type { DecisionGroupId } from "../../lib/cockpit/decisions";
import type { RosterRow } from "../../lib/cockpit/roster";
import { useT } from "../../lib/i18n";
import { useFrameBandValue } from "../../lib/window/frameBand";
import { ChevronLeftIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";
import { CockpitRail } from "./CockpitRail";
import { CockpitRailIcons } from "./CockpitRailIcons";
import { jumpToRow } from "./CockpitRoster";
import {
  useCockpitScopes,
  useDecisionsFor,
  useLoadSchedules,
  useMarkupAsks,
  usePushRequests,
  useScheduleProposals,
} from "./useCockpitData";

const FOLD_KEY = storageKey("cockpitRootRail");

/** The rail's remembered fold (per machine; a convenience, never state):
 *  collapsed unless the user opened it. */
function useRailFold(): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(FOLD_KEY) === "open";
    } catch {
      return false;
    }
  });
  const setOpen = (next: boolean) => {
    setOpenState(next);
    try {
      localStorage.setItem(FOLD_KEY, next ? "open" : "closed");
    } catch {
      // Unavailable: the fold holds for this session.
    }
  };
  return [open, setOpen];
}

/** A tab row picked in the Root view's rail: there is no detail pane to fill,
 *  so it goes to the tab (`jumpToRow` shows a root tab in this very view). */
function pickRow(row: RosterRow) {
  jumpToRow(row.ptyId);
}

/** The collapsed rail: live-store groups only (no backend read, no clock). */
function RootRailCollapsed({ onExpand }: { onExpand: (group: DecisionGroupId | null) => void }) {
  const scopes = useCockpitScopes();
  const { decisions } = useDecisionsFor(scopes);
  return <CockpitRailIcons decisions={decisions} onExpand={onExpand} />;
}

/**
 * The open rail: the real `CockpitRail`, with the groups that need a read (push
 * requests, schedule proposals, markup asks). Mounted only while open, so
 * those loads exist only then.
 */
function RootRailFull({ focusGroup, onCollapse }: { focusGroup: DecisionGroupId | null; onCollapse: () => void }) {
  const t = useT();
  const scopes = useCockpitScopes();
  useLoadSchedules(scopes);
  const push = usePushRequests(scopes);
  const schedules = useScheduleProposals(scopes);
  const markup = useMarkupAsks(scopes);
  const extras = useMemo(() => ({ push, schedules, markup }), [push, schedules, markup]);
  const { decisions, alerts } = useDecisionsFor(scopes, extras);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusGroup) return;
    ref.current?.querySelector(`[data-group="${focusGroup}"]`)?.scrollIntoView?.({ block: "start" });
  }, [focusGroup]);
  return (
    <div className="cockpit-root-rail-full" ref={ref}>
      <CockpitRail
        decisions={decisions}
        selected={null}
        alerts={alerts}
        onPick={pickRow}
        headAction={
          <>
            <UntestedTag id="cockpit.rootRail" />
            <button
              type="button"
              className="cockpit-rail-icon cockpit-rail-collapse"
              title={t("cockpit.rail.collapse")}
              aria-label={t("cockpit.rail.collapse")}
              onClick={onCollapse}
            >
              <ChevronLeftIcon />
            </button>
          </>
        }
      />
    </div>
  );
}

/**
 * Root's Needs-you column (experiment on): a 40 px icon rail by default, the
 * full `CockpitRail` beside the console when opened. It reads the live stores
 * the header badge reads and nothing else while collapsed. In a narrow window
 * (under 820 px, `lib/window/frameBand`) there is no room for it beside the
 * console, so it is not mounted at all (and loads nothing).
 */
export function RootRail() {
  const band = useFrameBandValue();
  const [open, setOpen] = useRailFold();
  const [focusGroup, setFocusGroup] = useState<DecisionGroupId | null>(null);
  if (band === "narrow") return null;
  return open ? (
    <RootRailFull focusGroup={focusGroup} onCollapse={() => setOpen(false)} />
  ) : (
    <RootRailCollapsed
      onExpand={(group) => {
        setFocusGroup(group);
        setOpen(true);
      }}
    />
  );
}
