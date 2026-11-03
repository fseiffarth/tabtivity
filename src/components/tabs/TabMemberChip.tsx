import { useEffect, useMemo, useRef } from "react";
import type { ProjectBox, ProjectEntry } from "../../types";
import type { TabEntry, TabKind } from "../../stores/tabs";
import {
  BOX_SCOPE_PREFIX,
  boxFolderOfScope,
  boxMembersOfScope,
  boxScopeId,
  memberOfCwd,
  useBoxesStore,
  type BoxMemberDir,
} from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { boxColor, memberColor } from "../../lib/theme/boxColor";
import { isPathWithin } from "../../lib/paths";
import { useT } from "../../lib/i18n";

/**
 * The tab strip's ownership chip (box redesign, plan step 10): inside a box a
 * tab says which member it works in. A round dot in the member's colour plus a
 * short name for a member; a rounded square in the box's colour for a tab in the
 * box folder itself (the whole-box agent). Members are always dots and boxes
 * always rounded squares, never swapped.
 *
 * Derived from `tab.cwd` on every render, never stored on the tab, so a rename
 * cannot erase it and a tab saved before the chip existed still resolves.
 * Shared by the main window's `TabBar` and the popout strip
 * (`DetachedCenterPanel`), and by the hover card's "member" row.
 */

/** Tab kinds that run in a launch directory a member can own. A viewer's cwd is its file's folder and a monitor has none. */
const CHIP_KINDS: ReadonlySet<TabKind> = new Set<TabKind>(["shell", "agent", "local_agent", "files", "projectfiles"]);

/** A box scope's member table: what `memberOfCwd` needs plus the box itself (name, colour). */
export interface MemberTable {
  box: ProjectBox;
  members: BoxMemberDir[];
  boxFolder: string;
}

/** What a tab belongs to inside the box: one member, or the whole box. */
export type TabMemberInfo =
  | { kind: "member"; id: string; name: string; color: string }
  | { kind: "box"; name: string; color: string };

/**
 * The member table of the box behind `scope`, from the two lists. `null` outside
 * a box scope or for an unknown box. Pure; the popout builds it from its seed
 * (`remoteInfo.box` / `boxMembers`), the main window from the stores.
 */
export function memberTableOf(
  scope: string,
  boxes: readonly ProjectBox[],
  projects: readonly ProjectEntry[],
): MemberTable | null {
  if (!scope.startsWith(BOX_SCOPE_PREFIX)) return null;
  const list = [...boxes];
  const box = list.find((b) => boxScopeId(b.id) === scope);
  if (!box) return null;
  return {
    box,
    members: boxMembersOfScope(scope, list, [...projects]),
    boxFolder: boxFolderOfScope(scope, list),
  };
}

const NO_BOXES: ProjectBox[] = [];
const NO_PROJECTS: ProjectEntry[] = [];

/** [`memberTableOf`] over the main window's stores; `null` (and no subscription cost) outside a box scope. */
export function useScopeMemberTable(scope: string): MemberTable | null {
  const inBox = scope.startsWith(BOX_SCOPE_PREFIX);
  const boxes = useBoxesStore((s) => (inBox ? s.boxes : NO_BOXES));
  const projects = useProjectsStore((s) => (inBox ? s.projects : NO_PROJECTS));
  return useMemo(() => (inBox ? memberTableOf(scope, boxes, projects) : null), [inBox, scope, boxes, projects]);
}

/**
 * Which member (or the whole box) a tab belongs to, or `null` when it gets no
 * chip: outside a box, a kind that has no launch directory, no cwd, or a
 * directory that is neither under a member nor under the box folder (a guess
 * would be worse than no chip, e.g. a remote member with no local copy).
 */
export function tabMemberInfo(tab: Pick<TabEntry, "kind" | "cwd">, table: MemberTable | null): TabMemberInfo | null {
  if (!table || !CHIP_KINDS.has(tab.kind) || !tab.cwd) return null;
  const member = memberOfCwd(tab.cwd, table.members, table.boxFolder);
  if (member) return { kind: "member", id: member.id, name: member.name, color: memberColor(member.id) };
  // A box with no folder yet cannot say where "the box" is: every other cwd is the whole box then.
  if (table.boxFolder && !isPathWithin(tab.cwd, table.boxFolder)) return null;
  return { kind: "box", name: table.box.name, color: boxColor(table.box) };
}

/**
 * Whether a label already names `name` as a word, as a tab saved with the
 * old " — name" suffix does ("Claude — api"). The chip then keeps only its dot,
 * so the name is not printed twice. A rename that keeps the name counts too;
 * one that drops it brings the chip's text back.
 */
export function labelNamesMember(label: string, name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(label);
}

/** The tab bar is narrower than this (px): chips show their dot only. */
export const NARROW_BAR_PX = 520;

// One observer per bar, shared by every chip in it, writes `data-narrow-chips`
// on the bar element itself (React never manages that attribute), so a resize
// costs no re-render. Reference-counted so the last chip to leave disconnects.
const watchedBars = new Map<Element, { count: number; ro: ResizeObserver | null }>();

function watchBar(bar: Element): () => void {
  let entry = watchedBars.get(bar);
  if (!entry) {
    const apply = () => bar.toggleAttribute("data-narrow-chips", bar.getBoundingClientRect().width < NARROW_BAR_PX);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    ro?.observe(bar);
    apply();
    entry = { count: 0, ro };
    watchedBars.set(bar, entry);
  }
  entry.count += 1;
  return () => {
    const e = watchedBars.get(bar);
    if (!e) return;
    e.count -= 1;
    if (e.count <= 0) {
      e.ro?.disconnect();
      bar.removeAttribute("data-narrow-chips");
      watchedBars.delete(bar);
    }
  };
}

/**
 * The chip itself. Renders nothing for a tab with no member info. In a narrow
 * bar (CSS `.tab-bar[data-narrow-chips]`) only the dot or square remains; the
 * name is then in the hover card.
 */
export function TabMemberChip({ info, label }: { info: TabMemberInfo | null; label: string }) {
  const t = useT();
  const ref = useRef<HTMLSpanElement>(null);
  const present = info !== null;
  useEffect(() => {
    const bar = present ? ref.current?.closest(".tab-bar") : null;
    return bar ? watchBar(bar) : undefined;
  }, [present]);
  if (!info) return null;
  const isBox = info.kind === "box";
  const named = tabMemberTitle(info, t);
  return (
    <span
      ref={ref}
      className={`tab-member-chip${isBox ? " box" : ""}`}
      role="img"
      aria-label={named}
      data-member-kind={info.kind}
    >
      <span className="tab-member-mark" style={{ background: info.color }} aria-hidden="true" />
      {!labelNamesMember(label, info.name) && (
        <span className="tab-member-name" aria-hidden="true">
          {info.name}
        </span>
      )}
    </span>
  );
}

/** The chip's name for assistive tech, the fast-mode tooltip and the hover card. */
export function tabMemberTitle(info: TabMemberInfo, t: ReturnType<typeof useT>): string {
  return info.kind === "box" ? t("tabMember.wholeBox", { name: info.name }) : info.name;
}
