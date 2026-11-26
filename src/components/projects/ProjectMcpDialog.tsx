import { useState } from "react";
import type { ProjectEntry, ProjectMcpLane, Settings } from "../../types";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";
import { DialogShell } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";

/** Every lane a project can switch off, in `project_lanes::LANES` order. */
export const PROJECT_MCP_LANES: readonly ProjectMcpLane[] = ["cockpit", "help", "schedule", "git", "markup", "print", "tabs"];

/** Whether a lane's global switch (Settings → Agents → Tools) is on, with
 *  each switch's own default: the schedule lane is off unless turned on, the
 *  rest are on unless turned off. */
function globallyOn(settings: Settings | null | undefined, lane: ProjectMcpLane): boolean {
  switch (lane) {
    case "cockpit": return settings?.cockpit_mcp !== false;
    case "help": return settings?.help_mcp !== false;
    case "schedule": return settings?.schedule_mcp === true;
    case "git": return settings?.git_push_mcp !== false;
    case "markup": return settings?.markup_mcp !== false;
    case "print": return settings?.print_mcp !== false;
    case "tabs": return settings?.tabs_mcp !== false;
  }
}

/**
 * A project's Tabtivity MCP tools: one switch per lane. Off keeps the lane
 * from the project's agent tabs (`services::project_lanes`, stored in
 * `projects.json`, never the folder); the global switches in Settings still
 * apply on top. Sibling: `AgentPrivacyDialog` (frame and switch cards).
 */
export function ProjectMcpDialog({ project, onClose }: { project: ProjectEntry; onClose: () => void }) {
  const t = useT();
  const setProjectMcpOff = useProjectsStore((s) => s.setProjectMcpOff);
  const settings = useSettingsStore((s) => s.settings);
  const [off, setOff] = useState<Set<ProjectMcpLane>>(() => new Set(project.mcp_off ?? []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stored = new Set(project.mcp_off ?? []);
  const changed = off.size !== stored.size || [...off].some((lane) => !stored.has(lane));

  const toggle = (lane: ProjectMcpLane, on: boolean) => {
    setOff((prev) => {
      const next = new Set(prev);
      if (on) next.delete(lane); else next.add(lane);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await setProjectMcpOff(project.id, PROJECT_MCP_LANES.filter((lane) => off.has(lane)));
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <DialogShell
      frame="project-dialog"
      className="project-mcp-dialog"
      scroll
      title={<>{project.name} — {t("projectMcp.title")} <UntestedTag id="projectMcp.dialog" /></>}
      onDismiss={onClose}
    >
      <div className="project-dialog-path">{t("projectMcp.intro")}</div>

      {PROJECT_MCP_LANES.map((lane) => {
        const on = !off.has(lane);
        const global = globallyOn(settings, lane);
        return (
          <label key={lane} className={`toggle-card${on && global ? " is-on" : ""}`}>
            <span className="toggle-card-body">
              <span className="toggle-card-title">{t(`projectMcp.${lane}`)}</span>
              <span className="toggle-card-desc">{t(`projectMcp.${lane}Desc`)}</span>
              {!global && <span className="toggle-card-desc">{t("projectMcp.globalOff")}</span>}
            </span>
            <span className="eld-switch">
              <input
                type="checkbox"
                aria-label={t(`projectMcp.${lane}`)}
                checked={on}
                disabled={saving}
                onChange={(e) => toggle(lane, e.target.checked)}
              />
              <span className="eld-switch-track" aria-hidden="true" />
            </span>
          </label>
        );
      })}

      {error && <div className="project-dialog-error">{error}</div>}

      <div className="project-dialog-actions">
        <button type="button" onClick={onClose} disabled={saving}>{t("common.cancel")}</button>
        <button type="button" onClick={() => void save()} disabled={saving || !changed}>
          {saving ? t("projectMcp.saving") : t("projectMcp.save")}
        </button>
      </div>
    </DialogShell>
  );
}
