import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { copyInstalledSkill, listInstalledSkills } from "../../lib/agents/skills";
import type { InstalledSkill, SkillTarget } from "../../types/skills";
import { DialogShell } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";

/** One place a skill can be copied to: another project, or the personal scope. */
export interface SkillCopyDestination {
  id: string;
  label: string;
  /** Tooltip — the project's folder, or what the personal scope reaches. */
  hint?: string;
  target: SkillTarget;
}

/**
 * The Installed view's "Copy to…" picker: tick any number of destinations and
 * copy one installed skill into each. Each destination's own skills folder is
 * read when the dialog opens, so one that already holds the skill says so on
 * its row — ticking it is the consent to overwrite, and the copy passes
 * `overwrite` only for those rows (one that appeared since is refused by the
 * backend, not replaced). A failure keeps the dialog open with the rows that
 * failed still ticked; the ones that worked are unticked and marked done.
 */
export function SkillCopyDialog({
  skill,
  from,
  destinations,
  onClose,
  onCopied,
}: {
  skill: InstalledSkill;
  from: SkillTarget;
  destinations: SkillCopyDestination[];
  onClose: () => void;
  /** Called after any copy landed, so the host re-reads its installed lists. */
  onCopied: () => void;
}) {
  const t = useT();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  /** Destinations that already hold a folder of this name. */
  const [present, setPresent] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      destinations.map((d) =>
        listInstalledSkills(d.target)
          .then((list: InstalledSkill[]) => (list.some((s) => s.folder === skill.folder) ? d.id : null))
          .catch(() => null),
      ),
    ).then((ids) => {
      if (!cancelled) setPresent(new Set(ids.filter((id): id is string => id !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [destinations, skill.folder]);

  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  async function copy() {
    setBusy(true);
    const failed: Record<string, string> = {};
    const landed: string[] = [];
    for (const d of destinations) {
      if (!ticked.has(d.id)) continue;
      try {
        await copyInstalledSkill(from, skill.folder, d.target, present.has(d.id));
        landed.push(d.id);
      } catch (e) {
        failed[d.id] = String(e);
      }
    }
    setBusy(false);
    if (landed.length > 0) onCopied();
    if (Object.keys(failed).length === 0) {
      onClose();
      return;
    }
    setErrors(failed);
    setDone((prev) => new Set([...prev, ...landed]));
    setTicked(new Set(Object.keys(failed)));
  }

  return (
    <DialogShell
      frame="project-dialog"
      className="skills-copy"
      scroll
      title={
        <>
          {t("skillsLibrary.copyTitle", { name: skill.name })} <UntestedTag id="skills.copyTo" />
        </>
      }
      onDismiss={onClose}
      closeDisabled={busy}
    >
      <div className="skills-copy-body">
        <div className="project-dialog-path">{t("skillsLibrary.copyIntro")}</div>
        {destinations.length === 0 ? (
          <div className="skills-copy-note">{t("skillsLibrary.copyNoDestinations")}</div>
        ) : (
          <ul className="skills-copy-list" aria-label={t("skillsLibrary.copyTo")}>
            {destinations.map((d) => (
              <li key={d.id}>
                <label title={d.hint}>
                  <input
                    type="checkbox"
                    checked={ticked.has(d.id)}
                    disabled={busy}
                    onChange={() => toggle(d.id)}
                  />
                  <span className="skills-copy-name">{d.label}</span>
                </label>
                {done.has(d.id) ? (
                  <small className="skills-copy-flag">{t("skillsLibrary.copyDone")}</small>
                ) : errors[d.id] ? (
                  <small className="skills-copy-flag is-error" title={errors[d.id]}>
                    {t("skillsLibrary.copyFailed")}
                  </small>
                ) : present.has(d.id) ? (
                  <small className="skills-copy-flag">{t("skillsLibrary.copyWillOverwrite")}</small>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {Object.keys(errors).length > 0 && (
          <div className="skills-copy-note" role="alert">
            {Object.values(errors)[0]}
          </div>
        )}
        <div className="project-dialog-actions">
          <button type="button" className="settings-btn" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn-primary" disabled={busy || ticked.size === 0} onClick={() => void copy()}>
            {t("skillsLibrary.copy")}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
