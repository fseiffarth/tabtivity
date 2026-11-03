import { useMemo, useState } from "react";
import type { ProjectBox, ProjectEntry } from "../../types";
import { useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { boxColor } from "../../lib/theme/boxColor";
import { useT } from "../../lib/i18n";
import { BoxSwatch, CheckboxIcon, SquareIcon } from "../common/icons/Icon";

/** A filter field appears once the list holds more rows than this. */
export const CHECKLIST_FILTER_FROM = 8;

interface Row {
  id: string;
  name: string;
  checked: boolean;
  /** A project that is closed (`status === "inactive"`): listed, labelled. */
  closed: boolean;
  /** The box's colour, on the rows that are boxes. */
  color?: string;
  title: string;
}

type Props =
  /** The projects of ONE box: a row per project (closed ones included), ticked = a member. */
  | { box: ProjectBox; project?: undefined }
  /** The boxes of ONE project: a row per box, ticked = the project is in it. */
  | { project: ProjectEntry; box?: undefined };

/**
 * The one membership checklist, behind the box pill's menu (the projects of a
 * box) and the project pill's Boxes group (the boxes of a project).
 *
 * - Stays open across toggles: a toggle is one additive `patch_box` add or
 *   remove (`addToBox` / `removeFromBox`, optimistic, reverted when refused),
 *   never a whole member list, so adding three projects is three clicks and a
 *   member added meanwhile elsewhere is not erased.
 * - Scrolls inside its own region (no row cap, no "more in the editor" dead end)
 *   and keeps the order it opened with: a ticked row does not jump to the top
 *   under the pointer.
 * - A filter field appears past {@link CHECKLIST_FILTER_FROM} rows.
 * - Closed projects are listed and can be added or removed, labelled "closed"
 *   (they stay closed; entering the box reopens them box-locally).
 *
 * Render it inside a menu; the caller owns the group caption.
 */
export function BoxMemberChecklist(props: Props) {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  const boxes = useBoxesStore((s) => s.boxes);
  const [filter, setFilter] = useState("");

  const subjectKey = props.box ? `box:${props.box.id}` : `project:${props.project.id}`;
  const boxMembers = props.box?.member_ids;
  const boxName = props.box?.name;
  const boxId = props.box?.id;
  const projectId = props.project?.id;

  // Natural order: a box's rows are its members first, then the rest, each by
  // position; a project's rows are the boxes by position.
  const natural = useMemo<Row[]>(() => {
    if (boxId !== undefined) {
      const members = new Set(boxMembers);
      const all = [...projects].sort((a, b) => a.position - b.position);
      return [...all.filter((p) => members.has(p.id)), ...all.filter((p) => !members.has(p.id))].map((p) => ({
        id: p.id,
        name: p.name,
        checked: members.has(p.id),
        closed: p.status === "inactive",
        title: t(members.has(p.id) ? "boxPill.removeMemberTitle" : "boxPill.addMemberTitle", {
          name: p.name,
          box: boxName ?? "",
        }),
      }));
    }
    return [...boxes]
      .sort((a, b) => a.position - b.position)
      .map((b) => {
        const checked = b.member_ids.includes(projectId ?? "");
        return {
          id: b.id,
          name: b.name,
          checked,
          closed: false,
          color: boxColor(b),
          title: t(checked ? "pill.leaveBoxTitle" : "pill.joinBoxTitle", { name: b.name }),
        };
      });
  }, [projects, boxes, boxId, boxMembers, boxName, projectId, t]);

  // The order the list opened with. Ticking a row must not move it (members
  // first would hop the row to the top under the pointer); a row that appears
  // later (a project added elsewhere) joins the end.
  const [opened] = useState(() => ({ key: subjectKey, order: new Map(natural.map((r, i) => [r.id, i])) }));
  const rows = useMemo(() => {
    if (opened.key !== subjectKey) return natural;
    const rank = (id: string) => opened.order.get(id) ?? Number.MAX_SAFE_INTEGER;
    return [...natural].sort((a, b) => rank(a.id) - rank(b.id));
  }, [natural, opened, subjectKey]);

  const needle = filter.trim().toLocaleLowerCase();
  const shown = needle ? rows.filter((r) => r.name.toLocaleLowerCase().includes(needle)) : rows;
  const filterable = rows.length > CHECKLIST_FILTER_FROM;
  const forBox = boxId !== undefined;

  const toggle = (row: Row) => {
    const store = useBoxesStore.getState();
    const [project, box] = forBox ? [row.id, boxId] : [projectId, row.id];
    if (!project || !box) return;
    if (row.checked) void store.removeFromBox(project, box);
    else void store.addToBox(project, box);
  };

  return (
    <div className="box-member-checklist" data-subject={forBox ? "box" : "project"}>
      {filterable && (
        <input
          type="text"
          className="box-member-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t(forBox ? "boxMembers.filterProjects" : "boxMembers.filterBoxes")}
          aria-label={t(forBox ? "boxMembers.filterProjects" : "boxMembers.filterBoxes")}
        />
      )}
      <div className="box-member-list">
        {shown.map((row) => (
          <button
            key={row.id}
            type="button"
            className="context-menu-check box-member-row"
            data-member-id={forBox ? row.id : undefined}
            data-row-id={row.id}
            aria-pressed={row.checked}
            title={row.title}
            onClick={() => toggle(row)}
          >
            <span className="context-menu-checkmark" aria-hidden>
              {row.checked ? <CheckboxIcon /> : <SquareIcon />}
            </span>
            {row.color && <BoxSwatch className="context-menu-box-swatch" color={row.color} />}
            <span className="box-member-name">{row.name}</span>
            {row.closed && <span className="box-member-closed">{t("boxMembers.closed")}</span>}
          </button>
        ))}
        {shown.length === 0 && rows.length > 0 && (
          <div className="context-menu-note">{t("boxMembers.noMatch")}</div>
        )}
        {rows.length === 0 && forBox && <div className="context-menu-note">{t("boxMembers.noProjects")}</div>}
      </div>
    </div>
  );
}
