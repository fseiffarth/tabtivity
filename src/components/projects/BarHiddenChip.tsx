import { useState } from "react";
import type { ProjectBox, ProjectEntry } from "../../types";
import { useT } from "../../lib/i18n";
import { boxColor } from "../../lib/theme/boxColor";
import { setBoxBarHidden, setProjectBarHidden } from "../../lib/projects/barHidden";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";
import { BoxSwatch, EyeIcon } from "../common/icons/Icon";

interface Props {
  /** Open projects hidden on their own (`bar_hidden_projects`). */
  projects: ProjectEntry[];
  /** Hidden boxes with the open members they keep off the strip. */
  byBox: { box: ProjectBox; members: ProjectEntry[] }[];
  /** Every known project / box id, so a toggle prunes stale ids. */
  aliveProjectIds: ReadonlySet<string>;
  aliveBoxIds: ReadonlySet<string>;
  onOpen: (projectId: string) => void;
}

/**
 * The tail of the "All projects" strip while some open projects are hidden
 * from it (`lib/projects/barHidden`): says how many, and its menu is the way
 * back — a name opens that project (its pill rejoins the strip while it is in
 * scope), the eye shows it, or a hidden box's members, on the strip again.
 */
export function BarHiddenChip({ projects, byBox, aliveProjectIds, aliveBoxIds, onOpen }: Props) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const count = projects.length + byBox.reduce((n, g) => n + g.members.length, 0);
  if (count === 0) return null;

  const open = (id: string) => {
    setMenu(null);
    onOpen(id);
  };

  return (
    <>
      <button
        type="button"
        className="bar-hidden-chip untested"
        title={t("barHidden.chipTitle", { count })}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setMenu((cur) => (cur ? null : { x: r.left, y: r.bottom + 2 }));
        }}
      >
        {t("barHidden.chip", { count })}
        <UntestedTag id="barHidden.chip" />
      </button>
      {menu && (
        <ContextMenuPortal
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          className="context-menu bar-hidden-menu"
          keepBelow
        >
          {projects.length > 0 && (
            <div className="context-menu-group">
              <div className="context-menu-group-label">{t("barHidden.projectsGroup")}</div>
              {projects.map((p) => (
                <div key={p.id} className="bar-hidden-row">
                  <button onClick={() => open(p.id)} title={t("barHidden.openTitle", { name: p.name })}>
                    {p.name}
                  </button>
                  <button
                    className="bar-hidden-show"
                    aria-label={t("barHidden.showProject", { name: p.name })}
                    title={t("barHidden.showProject", { name: p.name })}
                    onClick={() => void setProjectBarHidden(p.id, false, aliveProjectIds)}
                  >
                    <EyeIcon />
                  </button>
                </div>
              ))}
            </div>
          )}
          {byBox.map(({ box, members }) => (
            <div key={box.id} className="context-menu-group">
              <div className="bar-hidden-row bar-hidden-box">
                <div className="context-menu-group-label">
                  <BoxSwatch className="context-menu-box-swatch" color={boxColor(box)} />
                  {box.name}
                </div>
                <button
                  className="bar-hidden-show"
                  aria-label={t("barHidden.showBox", { name: box.name })}
                  title={t("barHidden.showBox", { name: box.name })}
                  onClick={() => void setBoxBarHidden(box.id, false, aliveBoxIds)}
                >
                  <EyeIcon />
                </button>
              </div>
              {members.map((p) => (
                <button key={p.id} onClick={() => open(p.id)} title={t("barHidden.openTitle", { name: p.name })}>
                  {p.name}
                </button>
              ))}
            </div>
          ))}
        </ContextMenuPortal>
      )}
    </>
  );
}
