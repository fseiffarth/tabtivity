import { useState } from "react";
import { assistantNewChat, type AssistantCliOption, type AssistantOptions } from "../../lib/assistant";
import { useT } from "../../lib/i18n";
import { ensureAssistantScopeHydrated, mountAssistantChat } from "../../stores/assistantScope";
import { useSettingsStore } from "../../stores/settings";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { SettingRow } from "../layout/settingsUi";
import { CliBlockCard, SearchSetupCard } from "./AssistantCards";
import { cliBlock, type AssistantOptionsHandle } from "./useAssistantOptions";
import { isAiOffRefusal } from "../../lib/aiSwitch";

/** The CLI a new chat preselects: the user's default if it is offered, else
 *  the backend's, else the first one that can start a chat right now. */
export function defaultCliOf(options: AssistantOptions, preferred: string | undefined): AssistantCliOption | undefined {
  const byId = (id: string | null | undefined) => options.clis.find((c) => c.id === id);
  return byId(preferred) ?? byId(options.defaultCli) ?? options.clis.find((c) => cliBlock(c, options) === null) ?? options.clis[0];
}

/** The local model a new chat preselects, from the installed ones only. */
export function defaultModelOf(options: AssistantOptions, preferred: string | undefined): string {
  const models = options.localModels;
  if (preferred && models.includes(preferred)) return preferred;
  if (options.defaultModel && models.includes(options.defaultModel)) return options.defaultModel;
  return models[0] ?? "";
}

/**
 * The new-chat form: a CLI picker (cloud CLIs and the local-model profiles
 * `assistant_options` offers), a model picker for the local ones, and Start.
 * What stands in the way of the chosen CLI is a card with its one-click fix
 * (`CliBlockCard`); a local model with no search backend gets the setup card.
 *
 * Starting a chat is `assistant_new_chat`, then mounting the tab it made
 * (`mountAssistantChat`: hydrates the scope first, waits for the tab) — the
 * caller shows it through `onStarted`.
 */
export function AssistantNewChat({
  handle,
  onStarted,
}: {
  handle: AssistantOptionsHandle;
  onStarted: (chatKey: string) => void;
}) {
  const t = useT();
  const { options, error: optionsError, refresh } = handle;
  const stored = useSettingsStore((s) => s.settings?.assistant_settings);
  const [pickedCli, setPickedCli] = useState<string | null>(null);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!options) {
    return (
      <div className="assistant-new-chat">
        <p className="settings-help">
          {optionsError ? t("assistant.optionsFailed", { reason: optionsError }) : t("assistant.loading")}
        </p>
      </div>
    );
  }

  const cli = options.clis.find((c) => c.id === pickedCli) ?? defaultCliOf(options, stored?.default_cli);
  const model = pickedModel && options.localModels.includes(pickedModel)
    ? pickedModel
    : defaultModelOf(options, stored?.default_model);
  const block = cli ? cliBlock(cli, options) : null;
  const canStart = !!cli && block === null && (!cli.local || !!model) && !busy;

  const start = async () => {
    if (!cli || !canStart) return;
    setBusy(true);
    setError(null);
    try {
      // The scope first: a created tab arriving at an unhydrated scope is only
      // picked up by the hydrate (the restored chats would then be missed).
      await ensureAssistantScopeHydrated();
      const made = await assistantNewChat(cli.id, cli.local ? model : null);
      const tab = await mountAssistantChat(made.tabId);
      if (tab) onStarted(tab.key);
      else setError(t("assistant.newChat.vanished"));
    } catch (err) {
      setError(isAiOffRefusal(err)
        ? t("sidePanel.aiOffHint")
        : t("assistant.newChat.failed", { reason: String(err).replace(/^Error: /, "") }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="assistant-new-chat">
      <div className="assistant-new-chat-title">
        {t("assistant.newChat")} <UntestedTag id="assistant.newChat" />
      </div>
      <p className="settings-help">{t("assistant.newChat.intro")}</p>
      <div className="settings-card">
        <SettingRow
          label={t("assistant.newChat.cli")}
          control={
            <Dropdown
              value={cli?.id ?? ""}
              ariaLabel={t("assistant.newChat.cli")}
              options={options.clis.map((c) => ({ value: c.id, label: c.label }))}
              onChange={(v) => setPickedCli(v)}
            />
          }
        />
        {cli?.local && (
          <SettingRow
            label={t("assistant.newChat.model")}
            control={
              <Dropdown
                value={model}
                ariaLabel={t("assistant.newChat.model")}
                options={options.localModels.map((m) => ({ value: m, label: m }))}
                placeholder={t("assistant.newChat.noModel")}
                disabled={options.localModels.length === 0}
                onChange={(v) => setPickedModel(v)}
              />
            }
          />
        )}
      </div>
      {cli && block && <CliBlockCard block={block} cli={cli} onRecheck={() => void refresh()} />}
      {cli?.local && !block && <SearchSetupCard options={options} onSaved={() => void refresh()} />}
      {error && <p className="project-dialog-error" role="alert">{error}</p>}
      <div className="settings-link-row">
        <button type="button" className="settings-btn primary" disabled={!canStart} onClick={() => void start()}>
          {busy ? t("assistant.newChat.starting") : t("assistant.newChat.start")}
        </button>
      </div>
    </div>
  );
}
