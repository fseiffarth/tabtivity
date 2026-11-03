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
 * The box side panel's accordion: which member section is expanded, the agent
 * count of each member, and the spring-open of a collapsed section a file is
 * dragged over.
 *
 * Exactly one member is expanded. Which one: the last the user clicked
 * (persisted per box, `boxAccordion`), else the active tab's member, else the
 * first. The active tab moving to another member expands that member (a change,
 * not the mount — a remembered click survives a remount).
 *
 * A collapsed section still takes a drop (its header carries the move-target
 * attributes) and opens after the folder rows' dwell. The open is transient while
 * the drag runs and does NOT fold the others: the section the file is dragged
 * out of must stay mounted, or its gesture would lose its tree. When the drag
 * ends, the last section the file dwelt over becomes the expanded one.
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
  const seenActive = useRef<{ boxId: string | null; id: string | null }>({ boxId, id: activeMemberId });
  useEffect(() => {
    const prev = seenActive.current;
    seenActive.current = { boxId, id: activeMemberId };
    if (!boxId || prev.boxId !== boxId || !activeMemberId || prev.id === activeMemberId) return;
    if (memberOrder.includes(activeMemberId)) setOpen(boxId, activeMemberId);
  }, [boxId, activeMemberId, memberOrder, setOpen]);

  const fallbackId = activeMemberId && memberOrder.includes(activeMemberId)
    ? activeMemberId
    : memberOrder[0] ?? null;
  const stored = row?.open;
  const expandedId =
    stored === null ? null : stored && memberOrder.includes(stored) ? stored : fallbackId;

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
      else setOpen(boxId, last);
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
      if (boxId) setOpen(boxId, expandedId === id ? null : id);
    },
    [boxId, expandedId, setOpen],
  );
  const toggleBoxFolded = useCallback(() => {
    if (boxId) setBoxFolded(boxId, !row?.boxFolded);
  }, [boxId, row?.boxFolded, setBoxFolded]);

  return {
    boxId,
    expandedId,
    boxFolded: !!row?.boxFolded,
    dragOpen,
    armedId,
    agentCounts,
    views: row?.views,
    toggleMember,
    toggleBoxFolded,
  };
}
