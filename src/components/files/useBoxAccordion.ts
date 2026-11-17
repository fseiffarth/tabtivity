import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSpringLoader } from "../../lib/projects/fileMove";
import { boxFolderOfScope, boxMembersOfScope, memberOfCwd, useBoxesStore } from "../../stores/boxes";
import { useBoxAccordionStore } from "../../stores/boxAccordion";
import { useDragStore } from "../../stores/drag/drag";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { SPRING_LOAD_MS } from "./fileTreeDrag";
import type { ProjectBox } from "../../types";

/**
 * The box side panel's sections: which member sections are expanded, the agent
 * count of each member, and the spring-open of a collapsed section a file is
 * dragged over.
 *
 * Any number of members can be expanded: a header click toggles that member and
 * touches no other. Which ones: what the user left open (persisted per box,
 * `boxAccordion`), else the active tab's member, else the first.
 *
 * The active tab moving to another member expands that member (a change, not
 * the mount: a remembered choice survives a remount). With at most one section
 * open the panel *follows* the tab, so the one before folds, as the
 * one-at-a-time accordion did; once the user keeps several open, nothing folds
 * by itself and the tab's member is opened beside them (`revealId` asks the
 * pane to scroll it into view, since the sections above may fill the panel).
 *
 * A collapsed section still takes a drop (its header carries the move-target
 * attributes) and opens after the folder rows' dwell. The open is transient while
 * the drag runs. When the drag ends, the last section the file dwelt over stays
 * expanded, beside the ones that already were.
 */
export function useBoxAccordion({
  scope,
  box,
  memberOrder,
  active,
}: {
  scope: string;
  box: ProjectBox | null;
  memberOrder: string[];
  active: boolean;
}) {
  const boxId = box?.id ?? null;
  const boxes = useBoxesStore((s) => s.boxes);
  const projects = useProjectsStore((s) => s.projects);
  const row = useBoxAccordionStore((s) => (boxId ? s.byBox[boxId] : undefined));
  const setOpen = useBoxAccordionStore((s) => s.setOpen);
  const setBoxFolded = useBoxAccordionStore((s) => s.setBoxFolded);

  // Primitive selectors (strings) so a tab list change that moves no cwd
  // re-renders nothing. Only the scope on screen has its tabs in `s.tabs`.
  const activeCwd = useTabsStore((s) =>
    s.scope === scope ? s.tabs.find((t) => t.key === s.activeKey)?.cwd ?? "" : "",
  );
  // Whether the scope has an active tab at all. A first visit to a scope
  // mounts the pane before its tabs are hydrated from disk, so "no tab" -> "a
  // tab in member X" is the layout arriving, not the active tab moving.
  const hasActiveTab = useTabsStore(
    (s) => s.scope === scope && s.tabs.some((t) => t.key === s.activeKey),
  );
  const agentCwds = useTabsStore((s) =>
    s.scope === scope
      ? s.tabs
          .filter((t) => t.kind === "agent" || t.kind === "local_agent")
          .map((t) => t.cwd ?? "")
          .join("\0")
      : "",
  );

  const members = useMemo(
    () => boxMembersOfScope(scope, boxes, projects),
    [scope, boxes, projects],
  );
  const folder = useMemo(() => boxFolderOfScope(scope, boxes), [scope, boxes]);
  const activeMemberId = useMemo(
    () => memberOfCwd(activeCwd, members, folder)?.id ?? null,
    [activeCwd, members, folder],
  );
  const agentCounts = useMemo(() => {
    const out: Record<string, number> = {};
    if (!agentCwds) return out;
    for (const cwd of agentCwds.split("\0")) {
      const id = memberOfCwd(cwd, members, folder)?.id;
      if (id) out[id] = (out[id] ?? 0) + 1;
    }
    return out;
  }, [agentCwds, members, folder]);

  // The active tab moving to another member expands it.
  const expandedRef = useRef<string[]>([]);
  const [reveal, setReveal] = useState<{ id: string; nonce: number } | null>(null);
  const seenActive = useRef<{ boxId: string | null; id: string | null; had: boolean }>({
    boxId,
    id: activeMemberId,
    had: hasActiveTab,
  });
  useEffect(() => {
    const prev = seenActive.current;
    seenActive.current = { boxId, id: activeMemberId, had: hasActiveTab };
    if (!boxId || prev.boxId !== boxId || !prev.had || !activeMemberId || prev.id === activeMemberId) return;
    if (!memberOrder.includes(activeMemberId)) return;
    const open = expandedRef.current;
    if (open.includes(activeMemberId)) return;
    setOpen(boxId, open.length <= 1 ? [activeMemberId] : [...open, activeMemberId]);
    if (open.length > 1) setReveal((r) => ({ id: activeMemberId, nonce: (r?.nonce ?? 0) + 1 }));
  }, [boxId, activeMemberId, hasActiveTab, memberOrder, setOpen]);

  const fallbackId = activeMemberId && memberOrder.includes(activeMemberId)
    ? activeMemberId
    : memberOrder[0] ?? null;
  const stored = row?.open;
  const expandedIds = useMemo(() => {
    const fallback = fallbackId ? [fallbackId] : [];
    if (!stored) return fallback;
    if (stored.length === 0) return stored; // folded by a click
    const live = stored.filter((id) => memberOrder.includes(id));
    // Every remembered member has left the box: as if the user never chose.
    return live.length ? live : fallback;
  }, [stored, memberOrder, fallbackId]);
  expandedRef.current = expandedIds;

  // ── Spring-open while a file is dragged ────────────────────────────────
  const [dragOpen, setDragOpen] = useState<string[]>([]);
  const [armedId, setArmedId] = useState<string | null>(null);
  useEffect(() => {
    if (!boxId || !active) return;
    let opened: string[] = [];
    let wasDragging = false;
    let armed: string | null = null;
    const arm = (id: string | null) => {
      if (id === armed) return;
      armed = id;
      setArmedId(id);
    };
    const spring = createSpringLoader({
      delayMs: SPRING_LOAD_MS,
      onOpen: (id) => {
        if (opened.includes(id)) return;
        opened = [...opened, id];
        setDragOpen(opened);
      },
    });
    const finish = () => {
      spring.cancel();
      arm(null);
      const last = opened[opened.length - 1];
      opened = [];
      setDragOpen([]);
      if (!last) return;
      if (last === scope) setBoxFolded(boxId, false);
      else if (!expandedRef.current.includes(last)) setOpen(boxId, [...expandedRef.current, last]);
    };
    const unsub = useDragStore.subscribe((s) => {
      const d = s.drag;
      if (!d || d.kind !== "file") {
        if (wasDragging) finish();
        wasDragging = false;
        return;
      }
      wasDragging = true;
      const el = document
        .elementFromPoint(d.pointerX, d.pointerY)
        ?.closest<HTMLElement>("[data-spring-root]");
      const id = el?.getAttribute("data-spring-root") ?? null;
      arm(id);
      spring.hover(id, { x: d.pointerX, y: d.pointerY });
    });
    return () => {
      unsub();
      spring.cancel();
    };
  }, [boxId, active, scope, setOpen, setBoxFolded]);

  const toggleMember = useCallback(
    (id: string) => {
      if (!boxId) return;
      const open = expandedRef.current;
      setOpen(boxId, open.includes(id) ? open.filter((m) => m !== id) : [...open, id]);
    },
    [boxId, setOpen],
  );
  /** Expand exactly these members (the ⋯ menu's "only this" / "all"). */
  const openOnly = useCallback(
    (ids: string[]) => {
      if (boxId) setOpen(boxId, ids);
    },
    [boxId, setOpen],
  );
  const toggleBoxFolded = useCallback(() => {
    if (boxId) setBoxFolded(boxId, !row?.boxFolded);
  }, [boxId, row?.boxFolded, setBoxFolded]);

  return {
    boxId,
    expandedIds,
    fallbackId,
    reveal,
    boxFolded: !!row?.boxFolded,
    dragOpen,
    armedId,
    agentCounts,
    views: row?.views,
    toggleMember,
    openOnly,
    toggleBoxFolded,
  };
}
