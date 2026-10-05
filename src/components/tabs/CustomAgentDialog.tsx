import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { runInstallInTab } from "../../lib/installCommand";
import { useT } from "../../lib/i18n";
import type { CustomAgent } from "../../types";
import { ErrorNote } from "../common/ErrorNote";

interface Props {
  onClose: () => void;
}

/** Split a whitespace-separated arg string into an argv, honoring simple
 *  single/double quoting so a value with spaces stays one arg. Empty → []. */
function parseArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

/** A minted id that doesn't depend on crypto being present in every webview. */
function mintId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `ca-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Manage the user's custom agents (Settings.custom_agents): list the existing
 * ones with a delete button, and an add form (label, command, optional args,
 * optional "continue last session" resume flag). Persisted globally via
 * `updateSettings`, so a new agent shows up in every add-tab menu's Agents group.
 *
 * A custom agent is only a launch command — Tabtivity spawns `cmd` (+ args/env) as
 * an `agent` tab. The resume flag is the one extra capability: set it and the
 * tab survives a restart (cwd-continue tier, like Qwen/OpenCode/Gemini); leave it
 * blank and the tab is launch-only, dropped on restart like Aider.
 */
export function CustomAgentDialog({ onClose }: Props) {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const agents = useMemo(() => settings?.custom_agents ?? [], [settings]);

  const [label, setLabel] = useState("");
  const [cmd, setCmd] = useState("");
  const [argsText, setArgsText] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [installText, setInstallText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Installed status of each agent's command, so a missing one can offer its
  // one-click install. `null` until the probe resolves (rows render without a
  // status hint rather than flashing "not installed").
  const [installed, setInstalled] = useState<Set<string> | null>(null);
  useEffect(() => {
    const cmds = agents.map((a) => a.cmd);
    if (cmds.length === 0) {
      setInstalled(new Set());
      return;
    }
    invoke<string[]>("probe_binaries", { bins: cmds })
      .then((found) => setInstalled(new Set(found)))
      .catch(() => setInstalled(new Set()));
  }, [agents]);

  const persist = async (next: CustomAgent[]) => {
    setBusy(true);
    setError(null);
    try {
      await updateSettings({ custom_agents: next });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const name = label.trim();
    const command = cmd.trim();
    if (!name || !command) {
      setError(t("customAgentDialog.requiredError"));
      return;
    }
    const args = parseArgs(argsText);
    const resumeArgs = parseArgs(resumeText);
    const install = installText.trim();
    const agent: CustomAgent = {
      id: mintId(),
      label: name,
      cmd: command,
      ...(args.length ? { args } : {}),
      ...(resumeArgs.length ? { resumeArgs } : {}),
      ...(install ? { installCmd: install } : {}),
    };
    await persist([...agents, agent]);
    setLabel("");
    setCmd("");
    setArgsText("");
    setResumeText("");
    setInstallText("");
  };

  const remove = (id: string) => void persist(agents.filter((a) => a.id !== id));

  // Run an agent's install command in a fresh root terminal tab (Tabtivity's
  // install-via-tab policy). Closes the dialog so the terminal is in view.
  const install = (a: CustomAgent) => {
    if (!a.installCmd) return;
    runInstallInTab(`Install ${a.label}`, a.installCmd, "default");
    onClose();
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="settings-dialog custom-agent-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{t("customAgentDialog.title")}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="dialog-scroll">
        <p className="settings-help">
          {t("customAgentDialog.helpPre")} <strong>{t("newTabMenu.groupAgents")}</strong>{" "}
          {t("customAgentDialog.helpPost")}
        </p>

        {agents.length > 0 && (
          <div className="custom-agent-list">
            {agents.map((a) => {
              const missing = installed != null && !installed.has(a.cmd);
              return (
                <div className="custom-agent-row" key={a.id}>
                  <span className="custom-agent-row-label">{a.label}</span>
                  <code className="custom-agent-row-cmd">
                    {[a.cmd, ...(a.args ?? [])].join(" ")}
                  </code>
                  {a.resumeArgs?.length ? (
                    <span className="custom-agent-row-tag" title={t("customAgentDialog.survivesRestartTitle")}>
                      {t("customAgentDialog.resumable")}
                    </span>
                  ) : null}
                  {missing &&
                    (a.installCmd ? (
                      <button
                        type="button"
                        className="custom-agent-install"
                        title={t("customAgentDialog.runTitle", { cmd: a.installCmd })}
                        onClick={() => install(a)}
                      >
                        {t("customAgentDialog.install")}
                      </button>
                    ) : (
                      <span
                        className="custom-agent-row-missing"
                        title={t("customAgentDialog.commandNotFoundTitle")}
                      >
                        {t("globalApps.notFoundPlaceholder")}
                      </span>
                    ))}
                  <button
                    type="button"
                    className="custom-agent-remove"
                    title={t("customAgentDialog.removeAgentTitle")}
                    disabled={busy}
                    onClick={() => remove(a.id)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="custom-agent-form">
          <label className="custom-agent-field">
            <span>{t("customAgentDialog.labelField")}</span>
            <input
              value={label}
              placeholder={t("customAgentDialog.labelPlaceholder")}
              autoFocus
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className="custom-agent-field">
            <span>{t("customAgentDialog.commandField")}</span>
            <input
              value={cmd}
              placeholder={t("customAgentDialog.commandPlaceholder")}
              spellCheck={false}
              onChange={(e) => setCmd(e.target.value)}
            />
          </label>
          <label className="custom-agent-field">
            <span>{t("customAgentDialog.argumentsField")} <em>{t("customAgentDialog.optional")}</em></span>
            <input
              value={argsText}
              placeholder={t("customAgentDialog.argumentsPlaceholder")}
              spellCheck={false}
              onChange={(e) => setArgsText(e.target.value)}
            />
          </label>
          <label className="custom-agent-field">
            <span>{t("customAgentDialog.resumeFlagField")} <em>{t("customAgentDialog.optional")}</em></span>
            <input
              value={resumeText}
              placeholder={t("customAgentDialog.resumeFlagPlaceholder")}
              spellCheck={false}
              onChange={(e) => setResumeText(e.target.value)}
            />
          </label>
          <label className="custom-agent-field">
            <span>{t("customAgentDialog.installCommandField")} <em>{t("customAgentDialog.optional")}</em></span>
            <input
              value={installText}
              placeholder={t("customAgentDialog.installCommandPlaceholder")}
              spellCheck={false}
              onChange={(e) => setInstallText(e.target.value)}
            />
          </label>
          <p className="settings-help">
            {t("customAgentDialog.installHelpPre")} <strong>{t("customAgentDialog.install")}</strong>{" "}
            {t("customAgentDialog.installHelpPost")}
          </p>
          <p className="settings-help">
            {t("customAgentDialog.resumeHelp")}
          </p>
        </div>

        {error && <ErrorNote className="settings-error" error={error} />}

        <div className="project-dialog-actions">
          <button type="button" onClick={onClose}>{t("machines.done")}</button>
          <button
            type="button"
            disabled={busy || !label.trim() || !cmd.trim()}
            onClick={() => void add()}
          >
            {t("customAgentDialog.addAgentButton")}
          </button>
        </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
