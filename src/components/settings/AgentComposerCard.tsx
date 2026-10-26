import { useState } from "react";
import { SettingsList } from "../layout/settingsUi";
import { Dropdown } from "../common/Dropdown";
import { useSettingsStore } from "../../stores/settings";
import { useT, type TranslationKey } from "../../lib/i18n";
import {
  DEFAULT_PREFACE_COMMANDS,
  MAX_PREFACE_COMMANDS,
  agentComposerKey,
  agentModelsFor,
  prefaceCommandsFor,
  sanitizePrefaceCommand,
} from "../../lib/agents/agentPrefaces";
import { ErrorNote } from "../common/ErrorNote";
import type { AgentInfo } from "./agentTypes";

/**
 * The prefix chips and model names the side panel's per-tab agent composer
 * offers, per agent.
 *
 * Editable rather than hardcoded because both lists date faster than the app
 * ships: a CLI adds a slash command in a point release and renames its models
 * more often than that. What is NOT offered here is a permission or plan mode —
 * an agent's authority is set through the agent's own CLI, and every entry in
 * these lists is literally typed into it (see `lib/agents/agentPrefaces`).
 *
 * An agent the user has never touched carries no stored entry at all and falls
 * back to the defaults; "Use defaults" deletes the key rather than writing the
 * defaults out, so a later change to them still reaches that agent. An
 * explicitly EMPTY list is kept, because "no chips for this one" is a decision.
 */
export function AgentComposerCard({ agents }: { agents: AgentInfo[] | null }) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const [agentId, setAgentId] = useState("claude");
  const [command, setCommand] = useState("");
  const [modelName, setModelName] = useState("");
  const [error, setError] = useState("");

  const installed = (agents ?? []).filter((agent) => agent.installed);
  // Fall back to the agents that have defaults, so the card is usable before
  // `list_agents` lands and on a machine with nothing installed yet.
  const options = installed.length > 0
    ? installed.map((agent) => ({ value: agent.id, label: agent.label }))
    : Object.keys(DEFAULT_PREFACE_COMMANDS).map((id) => ({ value: id, label: id }));
  const key = agentComposerKey(agentId);
  const commands = prefaceCommandsFor(agentId, settings?.agent_preface_commands);
  const models = agentModelsFor(agentId, settings?.agent_models);

  const writeCommands = (next: string[]) => {
    void updateSettings({
      agent_preface_commands: { ...(settings?.agent_preface_commands ?? {}), [key]: next },
    });
  };
  const writeModels = (next: string[]) => {
    void updateSettings({
      agent_models: { ...(settings?.agent_models ?? {}), [key]: next },
    });
  };
  const useDefaults = () => {
    const { [key]: _dropCommands, ...restCommands } = settings?.agent_preface_commands ?? {};
    const { [key]: _dropModels, ...restModels } = settings?.agent_models ?? {};
    void updateSettings({ agent_preface_commands: restCommands, agent_models: restModels });
    setError("");
  };

  const move = (list: string[], index: number, delta: number): string[] => {
    const target = index + delta;
    if (target < 0 || target >= list.length) return list;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  };

  const addCommand = () => {
    const clean = sanitizePrefaceCommand(command);
    if (!clean) {
      setError(t("agents.composerInvalidCommand"));
      return;
    }
    if (commands.length >= MAX_PREFACE_COMMANDS) {
      setError(t("agents.composerLimit", { count: String(MAX_PREFACE_COMMANDS) }));
      return;
    }
    setError("");
    setCommand("");
    if (!commands.includes(clean)) writeCommands([...commands, clean]);
  };

  const addModel = () => {
    const clean = modelName.trim();
    if (!clean) return;
    setModelName("");
    if (!models.includes(clean)) writeModels([...models, clean]);
  };

  const listEditor = (
    entries: string[],
    write: (next: string[]) => void,
    emptyKey: TranslationKey,
  ) => (
    entries.length === 0 ? (
      <p className="settings-help">{t(emptyKey)}</p>
    ) : (
      <SettingsList boxed>
        {entries.map((entry, index) => (
          <div className="settings-row" key={entry}>
            <code style={{ flex: 1, minWidth: 0 }}>{entry}</code>
            <button
              type="button"
              className="settings-btn sm icon"
              title={t("agents.composerMoveUp")}
              disabled={index === 0}
              onClick={() => write(move(entries, index, -1))}
            >
              ↑
            </button>
            <button
              type="button"
              className="settings-btn sm icon"
              title={t("agents.composerMoveDown")}
              disabled={index === entries.length - 1}
              onClick={() => write(move(entries, index, 1))}
            >
              ↓
            </button>
            <button
              type="button"
              className="settings-btn sm icon danger"
              title={t("agents.composerRemove")}
              onClick={() => write(entries.filter((_, at) => at !== index))}
            >
              ✕
            </button>
          </div>
        ))}
      </SettingsList>
    )
  );

  return (
    <div className="agents-stack">
      <p className="settings-help">{t("agents.composerHelp")}</p>
      <div className="settings-card-row">
        <span>{t("agents.composerAgent")}</span>
        <Dropdown
          value={agentId}
          options={options}
          onChange={(value) => { setAgentId(value); setError(""); }}
          title={t("agents.composerAgent")}
        />
        <button type="button" className="settings-btn sm" onClick={useDefaults}>
          {t("agents.composerReset")}
        </button>
      </div>

      <div className="settings-subheader">{t("agents.composerCommands")}</div>
      {listEditor(commands, writeCommands, "agents.composerNoCommands")}
      <div className="ollama-install-cmd-row">
        <input
          type="text"
          className="ollama-pull-input"
          placeholder={t("agents.composerAddCommand")}
          aria-label={t("agents.composerAddCommand")}
          value={command}
          spellCheck={false}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") addCommand(); }}
        />
        <button type="button" className="settings-btn sm" onClick={addCommand}>
          {t("agents.composerAdd")}
        </button>
      </div>
      {error && <ErrorNote className="project-dialog-error" error={error} />}

      <div className="settings-subheader">{t("agents.composerModels")}</div>
      {listEditor(models, writeModels, "agents.composerNoModels")}
      <div className="ollama-install-cmd-row">
        <input
          type="text"
          className="ollama-pull-input"
          placeholder={t("agents.composerAddModel")}
          aria-label={t("agents.composerAddModel")}
          value={modelName}
          spellCheck={false}
          onChange={(event) => setModelName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") addModel(); }}
        />
        <button type="button" className="settings-btn sm" onClick={addModel}>
          {t("agents.composerAdd")}
        </button>
      </div>
    </div>
  );
}
