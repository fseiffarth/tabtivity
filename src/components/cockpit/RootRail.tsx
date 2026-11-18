import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
import { NeedsYouChip, NeedsYouPopover, type NeedsYouAnchor } from "./NeedsYouPopover";
import { ColumnGrip, useColumnWidth } from "./useColumnWidth";
import {
  useCockpitScopes,
  useDecisionsFor,
  useLoadSchedules,
  useMarkupAsks,
  usePushRequests,
  useScheduleProposals,
} from "./useCockpitData";

const FOLD_KEY = storageKey("cockpitRootRail");
/** The open rail's remembered width; its own key, so Now's rail keeps its own. */
const WIDTH_KEY = storageKey("cockpitRootRailWidth");
const WIDTH_DEFAULT = 280;

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

/** The collapsed rail: live-store groups only (no backend read, no clock): what
 *  the header badge counts, schedule proposals included when something loaded
 *  them. With nothing waiting the 40 px column is not drawn, so the console gets
 *  it back; the push / schedule / markup groups need a read that only the open
 *  rail makes, so the "Needs you" chip stands in the window's bar instead (the
 *  rail as its popover), and the way to them is never gone. */
function RootRailCollapsed({
  onExpand,
  chipSlot,
}: {
  onExpand: (group: DecisionGroupId | null) => void;
  chipSlot: HTMLElement | null;
}) {
  const scopes = useCockpitScopes();
  const schedules = useScheduleProposals(scopes);
  const extras = useMemo(() => ({ push: [], schedules, markup: [] }), [schedules]);
  const { decisions } = useDecisionsFor(scopes, extras);
  if (decisions.groups.length === 0) return chipSlot ? createPortal(<RootRailChip />, chipSlot) : null;
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
  const width = useColumnWidth(WIDTH_KEY, WIDTH_DEFAULT, 1);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusGroup) return;
    ref.current?.querySelector(`[data-group="${focusGroup}"]`)?.scrollIntoView?.({ block: "start" });
  }, [focusGroup]);
  return (
    <>
      <div className="cockpit-root-rail-full" ref={ref} style={{ flexBasis: width.width }}>
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
      <ColumnGrip onPointerDown={width.onPointerDown} />
    </>
  );
}

/**
 * The narrow band's way to the rail (under 820 px, no room beside the console):
 * Now's "Needs you N" chip, in Root's sub-bar, opening the rail as Now's popover.
 * Closed it reads the live stores only (the header badge's counts); the popover
 * mounts the three loads while it is open.
 */
function RootRailChip() {
  const scopes = useCockpitScopes();
  const { decisions } = useDecisionsFor(scopes);
  const chipRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<NeedsYouAnchor | null>(null);
  const toggle = () => {
    if (anchor) return setAnchor(null);
    const rect = chipRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.left, y: rect.bottom + 4, group: null });
  };
  return (
    <>
      <NeedsYouChip chipRef={chipRef} decisions={decisions} open={anchor != null} onClick={toggle} />
      <UntestedTag id="cockpit.narrow" />
      {anchor && <RootRailPopover anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}

/** The chip's popover: the full rail with its reads, mounted only while open. */
function RootRailPopover({ anchor, onClose }: { anchor: NeedsYouAnchor; onClose: () => void }) {
  const scopes = useCockpitScopes();
  useLoadSchedules(scopes);
  const push = usePushRequests(scopes);
  const schedules = useScheduleProposals(scopes);
  const markup = useMarkupAsks(scopes);
  const extras = useMemo(() => ({ push, schedules, markup }), [push, schedules, markup]);
  const { decisions, alerts } = useDecisionsFor(scopes, extras);
  return <NeedsYouPopover anchor={anchor} decisions={decisions} alerts={alerts} selected={null} onPick={pickRow} onClose={onClose} />;
}

/**
 * Root's Needs-you column: a 40 px icon rail by default (while nothing waits, no
 * column: the chip in the bar instead), the full `CockpitRail` beside the console when opened, its
 * width dragged by the same grip as Now's and remembered. It reads the live
 * stores the header badge reads and nothing else while collapsed. In a narrow
 * window (under 820 px, `lib/window/frameBand`) there is no room for a column,
 * so none is mounted; the "Needs you N" chip takes its place in the window's
 * bar (`chipSlot`, where the Root view portals it).
 */
export function RootRail({ chipSlot }: { chipSlot: HTMLElement | null }) {
  const band = useFrameBandValue();
  const [open, setOpen] = useRailFold();
  const [focusGroup, setFocusGroup] = useState<DecisionGroupId | null>(null);
  if (band === "narrow") return chipSlot ? createPortal(<RootRailChip />, chipSlot) : null;
  return open ? (
    <RootRailFull focusGroup={focusGroup} onCollapse={() => setOpen(false)} />
  ) : (
    <RootRailCollapsed
      chipSlot={chipSlot}
      onExpand={(group) => {
        setFocusGroup(group);
        setOpen(true);
      }}
    />
  );
}
