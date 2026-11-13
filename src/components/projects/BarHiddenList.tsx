import { useState } from "react";
import type { ProjectBox, ProjectEntry } from "../../types";
import { useT } from "../../lib/i18n";
import { boxColor } from "../../lib/theme/boxColor";
import { setBarSolo, setBoxBarHidden, setProjectBarHidden, useBarHidden } from "../../lib/projects/barHidden";
import { UntestedTag } from "../common/UntestedTag";
import { BoxSwatch, CheckboxIcon, EyeIcon, SquareIcon } from "../common/icons/Icon";

/** What the "All projects" strip leaves out (`lib/projects/barHidden`). */
export interface BarHiddenSet {
  /** Open projects hidden on their own (`bar_hidden_projects`). */
  projects: ProjectEntry[];
  /** Hidden boxes with the open members they keep off the strip. */
  byBox: { box: ProjectBox; members: ProjectEntry[] }[];
  /** Open projects off the strip only because hide mode (`bar_solo`) is on. */
  others: ProjectEntry[];
  /** Every known project / box id, so a toggle prunes stale ids. */
  aliveProjectIds: ReadonlySet<string>;
  aliveBoxIds: ReadonlySet<string>;
  onOpen: (projectId: string) => void;
}

export function barHiddenCount(hidden: BarHiddenSet): number {
  return (
    hidden.projects.length + hidden.byBox.reduce((n, g) => n + g.members.length, 0) + hidden.others.length
  );
}

/**
 * The logo dropdown's hide-mode switch (`bar_solo`): on, the "All projects"
 * strip keeps only the project in scope; the rest wait in the "N hidden" list
 * below it. Stays open across toggles, like the box-pill checkboxes.
 */
export function BarSoloToggle() {
  const t = useT();
  const { solo } = useBarHidden();
  return (
    <button
      type="button"
      className="context-menu-check bar-solo-toggle"
      role="menuitemcheckbox"
      aria-checked={solo}
      title={t("barHidden.soloTitle")}
      onClick={() => void setBarSolo(!solo)}
    >
      <span className="context-menu-checkmark" aria-hidden>
        {solo ? <CheckboxIcon /> : <SquareIcon />}
      </span>
      <span className="box-chip-menu-name">{t("barHidden.solo")}</span>
      <UntestedTag id="barHidden.solo" />
    </button>
  );
}

/**
 * The logo dropdown's "N hidden" entry (BoxScopeChip), the one way back to
 * projects hidden from the "All projects" strip: the entry unfolds the list in
 * place — hide mode's projects (names only: the switch shows them all), then
 * the hidden lists — a name opens that project (its pill rejoins the strip while it is in
 * scope), the eye shows it, or a hidden box's members, on the strip again. The
 * eyes leave the dropdown open; a name closes it (`onPicked`).
 */
export function BarHiddenSection({ hidden, onPicked }: { hidden: BarHiddenSet; onPicked: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const count = barHiddenCount(hidden);
  if (count === 0) return null;
  const { projects, byBox, others, aliveProjectIds, aliveBoxIds, onOpen } = hidden;

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
          {/* Hide mode's projects first: they are the open projects one click
              away, and turning the mode off (the switch above) shows them all. */}
          {others.length > 0 && (
            <div className="box-chip-menu-label">{t("barHidden.soloGroup")}</div>
          )}
          {others.map((p) => (
            <button key={p.id} onClick={() => pick(p.id)} title={t("barHidden.openTitle", { name: p.name })}>
              {p.name}
            </button>
          ))}
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
