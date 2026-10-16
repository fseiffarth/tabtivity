import { useExperimental } from "../../lib/experimental";
import { useT } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import type { AssistantSettings as AssistantSettingsBlock } from "../../types";
import { Dropdown } from "../common/Dropdown";
import { SettingRow, SettingsCard } from "../layout/settingsUi";
import { AssistantSearchSetup } from "./AssistantSearchSetup";
import { useAssistantOptions } from "./useAssistantOptions";

/**
 * Settings → the assistant's page (below the section title the panel draws):
 * the CLI and model a new chat starts with, and the web lane's search backend
 * (`AssistantSearchSetup`, the form the overlay's setup card shares). The
 * switch itself is Settings → Experimental, and the phone's is in the Mobile
 * section.
 *
 * The CLI and model choices are stored (`Settings.assistant_settings`) and
 * only *preselect* the new-chat form; the backend validates whatever a chat is
 * actually started with. Options are read while this page is mounted.
 */
export function AssistantSettings() {
  const t = useT();
  const enabled = useExperimental("assistant");
  const stored = useSettingsStore((s) => s.settings?.assistant_settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { options, error, refresh } = useAssistantOptions(enabled);

  if (!enabled) {
    return <p className="settings-help">{t("assistant.settings.off")}</p>;
  }

  const write = (patch: Partial<AssistantSettingsBlock>) => {
    const next: AssistantSettingsBlock = { ...(stored ?? {}), ...patch };
    for (const k of ["default_cli", "default_model"] as const) if (!next[k]) delete next[k];
    void updateSettings({ assistant_settings: next });
  };

  const defaultCli = stored?.default_cli ?? "";
  const cli = options?.clis.find((c) => c.id === defaultCli);
  const models = options?.localModels ?? [];
  const defaultModel = stored?.default_model ?? "";

  return (
    <>
      <SettingsCard>
        <SettingRow
          label={t("assistant.settings.defaultCli")}
          help={t("assistant.settings.defaultCliHelp")}
          control={
            <Dropdown
              value={defaultCli}
              ariaLabel={t("assistant.settings.defaultCli")}
              options={[
                { value: "", label: t("assistant.settings.firstAvailable") },
                ...(options?.clis ?? []).map((c) => ({ value: c.id, label: c.label })),
              ]}
              onChange={(v) => write({ default_cli: v || undefined })}
            />
          }
        />
        {cli?.local && (
          <SettingRow
            label={t("assistant.settings.defaultModel")}
            help={models.length === 0 ? t("assistant.settings.noModels") : undefined}
            control={
              <Dropdown
                value={defaultModel}
                ariaLabel={t("assistant.settings.defaultModel")}
                options={[
                  { value: "", label: t("assistant.settings.firstAvailable") },
                  ...(defaultModel && !models.includes(defaultModel) ? [{ value: defaultModel, label: defaultModel }] : []),
                  ...models.map((m) => ({ value: m, label: m })),
                ]}
                onChange={(v) => write({ default_model: v || undefined })}
              />
            }
          />
        )}
        {error && <p className="project-dialog-error" role="alert">{t("assistant.optionsFailed", { reason: error })}</p>}
      </SettingsCard>
      <div className="settings-subheader">{t("assistant.settings.search")}</div>
      <p className="settings-help">{t("assistant.settings.searchHelp")}</p>
      <AssistantSearchSetup search={options?.search ?? null} onSaved={() => void refresh()} />
    </>
  );
}
