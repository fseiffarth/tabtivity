import { useState } from "react";
import type { ProjectBox, ProjectEntry } from "../../types";
import { useT } from "../../lib/i18n";
import { boxColor } from "../../lib/theme/boxColor";
import { setBoxBarHidden, setProjectBarHidden } from "../../lib/projects/barHidden";
import { UntestedTag } from "../common/UntestedTag";
import { BoxSwatch, EyeIcon } from "../common/icons/Icon";

/** What the "All projects" strip leaves out (`lib/projects/barHidden`). */
export interface BarHiddenSet {
  /** Open projects hidden on their own (`bar_hidden_projects`). */
  projects: ProjectEntry[];
  /** Hidden boxes with the open members they keep off the strip. */
  byBox: { box: ProjectBox; members: ProjectEntry[] }[];
  /** Every known project / box id, so a toggle prunes stale ids. */
  aliveProjectIds: ReadonlySet<string>;
  aliveBoxIds: ReadonlySet<string>;
  onOpen: (projectId: string) => void;
}

export function barHiddenCount(hidden: BarHiddenSet): number {
  return hidden.projects.length + hidden.byBox.reduce((n, g) => n + g.members.length, 0);
}

/**
 * The logo dropdown's "N hidden" entry (BoxScopeChip), the one way back to
 * projects hidden from the "All projects" strip: the entry unfolds the list in
 * place — a name opens that project (its pill rejoins the strip while it is in
 * scope), the eye shows it, or a hidden box's members, on the strip again. The
 * eyes leave the dropdown open; a name closes it (`onPicked`).
 */
export function BarHiddenSection({ hidden, onPicked }: { hidden: BarHiddenSet; onPicked: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const count = barHiddenCount(hidden);
  if (count === 0) return null;
  const { projects, byBox, aliveProjectIds, aliveBoxIds, onOpen } = hidden;

  const pick = (id: string) => {
    onPicked();
    onOpen(id);
  };

  return (
    <>
      <button
        type="button"
        className="bar-hidden-toggle"
        title={t("barHidden.chipTitle", { count })}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="bar-hidden-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="box-chip-menu-name">{t("barHidden.chip", { count })}</span>
        <UntestedTag id="barHidden.chip" />
      </button>
      {open && (
        <div className="bar-hidden-list">
          {projects.length > 0 && (
            <div className="box-chip-menu-label">{t("barHidden.projectsGroup")}</div>
          )}
          {projects.map((p) => (
            <div key={p.id} className="bar-hidden-row">
              <button onClick={() => pick(p.id)} title={t("barHidden.openTitle", { name: p.name })}>
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
          {byBox.map(({ box, members }) => (
            <div key={box.id} className="bar-hidden-group">
              <div className="bar-hidden-row">
                <div className="box-chip-menu-label bar-hidden-box">
                  <BoxSwatch className="project-pill-box-swatch" color={boxColor(box)} />
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
                <button key={p.id} onClick={() => pick(p.id)} title={t("barHidden.openTitle", { name: p.name })}>
                  {p.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
