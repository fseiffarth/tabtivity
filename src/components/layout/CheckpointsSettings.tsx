import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { experimentalEnabled } from "../../lib/experimental";
import { checkpointClear, checkpointSettingsGet, checkpointSettingsSet, sizeLabel, type CheckpointSettings } from "../../lib/agents/checkpoints";
import { useDialogs } from "../common/PromptDialogs";
import { useSettingsStore } from "../../stores/settings";
import { UntestedTag } from "../common/UntestedTag";
import { SettingsCard, ToggleCard } from "./settingsUi";

/**
 * Settings → Experimental · Per-turn checkpoints (`services::checkpoints`).
 * One switch: it turns on the window's controls (`turn_checkpoints`) and the
 * backend's capture (`checkpoints.json`) in the same click. When on, each
 * folder's store with its size and a Clear button; the stores live outside
 * every project, so they are never part of one.
 */
export function CheckpointsSettings() {
  const t = useT();
  const { confirmAction, dialogs } = useDialogs();
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const on = experimentalEnabled(settings, "turn_checkpoints");
  const [backend, setBackend] = useState<CheckpointSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read even while off: the switch needs to know whether git can run them.
  useEffect(() => {
    let cancelled = false;
    checkpointSettingsGet().then(
      (next) => {
        if (!cancelled) setBackend(next);
      },
      (reason) => {
        if (!cancelled) setError(String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [on]);

  const toggle = async (enabled: boolean) => {
    setError(null);
    try {
      setBackend(await checkpointSettingsSet(enabled));
      await updateSettings({ turn_checkpoints: enabled });
    } catch (reason) {
      setError(String(reason));
    }
  };

  const clear = async (key: string | undefined) => {
    const ok = await confirmAction({
      title: t("settings.checkpointsClear"),
      body: t(key ? "settings.checkpointsClearOne" : "settings.checkpointsClearAll"),
      confirmLabel: t("settings.checkpointsClear"),
      danger: true,
    });
    if (!ok) return;
    try {
      setBackend(await checkpointClear(key));
    } catch (reason) {
      setError(String(reason));
    }
  };

  // An old git can't turn them on; one that is already on can still go off.
  const gitTooOld = backend !== null && !backend.gitOk;
  const gitNote = gitTooOld
    ? backend.gitVersion
      ? t("settings.checkpointsGitOld", { version: backend.gitVersion })
      : t("settings.checkpointsNoGit")
    : null;

  return (
    <>
      {dialogs}
      <ToggleCard
        label={<>{t("settings.turnCheckpoints")} <UntestedTag id="settings.turnCheckpoints" /></>}
        checked={on}
        disabled={gitTooOld && !on}
        onChange={(event) => void toggle(event.target.checked)}
        help={<>
          {t("settings.turnCheckpointsHelp")}
          {gitNote && <><br /><span role="note">{gitNote}</span></>}
          {!on && error && <><br /><span role="alert">{error}</span></>}
        </>}
      />
      {on && (
        <SettingsCard className="checkpoint-stores">
          {error && <p className="settings-help" role="alert">{error}</p>}
          {backend && !backend.enabled && backend.gitOk && <p className="settings-help">{t("settings.checkpointsBackendOff")}</p>}
          {backend && backend.stores.length === 0 && <p className="settings-help">{t("settings.checkpointsEmpty")}</p>}
          {backend?.stores.map((store) => (
            <div className="settings-card-row" key={store.key}>
              <span title={store.folder}>{store.folder}</span>
              <small>{t("settings.checkpointsSize", { size: sizeLabel(store.bytes), n: store.count })}</small>
              <button type="button" className="settings-btn sm" onClick={() => void clear(store.key)}>{t("settings.checkpointsClear")}</button>
            </div>
          ))}
          {backend && backend.stores.length > 1 && (
            <div className="settings-card-row">
              <button type="button" className="settings-btn sm" onClick={() => void clear(undefined)}>{t("settings.checkpointsClearEverything")}</button>
            </div>
          )}
        </SettingsCard>
      )}
    </>
  );
}
