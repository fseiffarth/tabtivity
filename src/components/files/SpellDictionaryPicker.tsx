/**
 * The spelling-dictionary rows of Project Settings' Native viewers card
 * (M#248): which installed Hunspell dictionary the editors' spelling check
 * reads (machine-wide — the language you write in is not per project), and a
 * download row that fetches any other language from the wooorm/dictionaries
 * collection into the dictionaries folder of Tabtivity's data directory.
 *
 * One backend round trip (`spell_dictionaries`) answers both rows; the split
 * into installed/downloadable, and every display name, is
 * `lib/spellDictionaries`. A dictionary Tabtivity put there (or the user dropped
 * in) can be removed again from the same row; a system one is the package
 * manager's and gets no × — the backend refuses anyway.
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { SettingRow } from "../layout/settingsUi";
import { useSettingsStore } from "../../stores/settings";
import { useI18nStore, useT } from "../../lib/i18n";
import {
  defaultSpellLanguage,
  dictionaryChoices,
  languageDisplayName,
  type CatalogDictionary,
  type InstalledDictionary,
} from "../../lib/spellDictionaries";

interface SpellDictionaries {
  installed: InstalledDictionary[];
  catalog: CatalogDictionary[];
}

export function SpellDictionaryPicker() {
  const t = useT();
  const uiLang = useI18nStore((s) => s.lang);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  // `null` until the listing lands, so "none installed" is never shown
  // prematurely (a local directory read + the static catalog, no network).
  const [dicts, setDicts] = useState<SpellDictionaries | null>(null);
  const [pick, setPick] = useState("");
  // The code being downloaded or removed, for the disabled state + status.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setDicts(await invoke<SpellDictionaries>("spell_dictionaries"));
    } catch {
      setDicts({ installed: [], catalog: [] });
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const choices = dicts ? dictionaryChoices(dicts.installed, dicts.catalog, uiLang) : null;
  const selected =
    (settings?.spell_language as string | undefined) ??
    defaultSpellLanguage(dicts?.installed ?? []);
  const selectedRemovable = choices?.installed.find((d) => d.code === selected)?.removable === true;

  const download = async () => {
    if (!pick || busy) return;
    setBusy(pick);
    setError(null);
    try {
      await invoke("spell_install_language", { code: pick });
      // Read it right away: the language you just fetched is the one you want.
      await updateSettings({ spell_language: pick });
      setPick("");
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!selectedRemovable || busy) return;
    setBusy(selected);
    setError(null);
    try {
      await invoke("spell_remove_language", { code: selected });
      const rest = (dicts?.installed ?? []).filter((d) => d.code !== selected);
      // Fall back the way the backend would with the setting unset — but
      // written out, so the dropdown and the checker agree on what is read.
      await updateSettings({ spell_language: defaultSpellLanguage(rest) });
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const busyName = busy ? languageDisplayName(busy, uiLang) : "";

  return (
    <>
      <SettingRow
        label={
          <>
            {t("projectSettings.spellLanguage")} <UntestedTag id="projectSettings.spellLanguage" />
          </>
        }
        help={t("projectSettings.spellLanguageHelp")}
        control={
          choices && choices.installed.length === 0 ? (
            <span className="settings-help">{t("projectSettings.spellNoDicts")}</span>
          ) : (
            <span className="spell-dict-control">
              <Dropdown
                value={selected}
                options={(choices?.installed ?? []).map((d) => ({ value: d.code, label: d.label }))}
                disabled={busy !== null}
                onChange={(v) => void updateSettings({ spell_language: v })}
              />
              {selectedRemovable && (
                <button
                  type="button"
                  className="settings-btn sm icon danger"
                  disabled={busy !== null}
                  title={t("projectSettings.spellRemove")}
                  aria-label={t("projectSettings.spellRemove")}
                  onClick={() => void remove()}
                >
                  ×
                </button>
              )}
            </span>
          )
        }
      />
      <SettingRow
        label={
          <>
            {t("projectSettings.spellAddLanguage")} <UntestedTag id="projectSettings.spellAddLanguage" />
          </>
        }
        help={
          <>
            {t("projectSettings.spellAddLanguageHelp")}
            {busy && (
              <>
                {" "}
                <span className="spell-dict-status">
                  {t("projectSettings.spellWorking", { lang: busyName })}
                </span>
              </>
            )}
            {error && (
              <>
                {" "}
                <span className="spell-dict-status danger" role="alert">
                  {t("projectSettings.spellDownloadFailed", { error })}
                </span>
              </>
            )}
          </>
        }
        control={
          <span className="spell-dict-control">
            <Dropdown
              value={pick}
              placeholder={t("projectSettings.spellPickLanguage")}
              options={(choices?.downloadable ?? []).map((d) => ({ value: d.code, label: d.label }))}
              disabled={busy !== null || !choices}
              onChange={setPick}
            />
            <button
              type="button"
              className="settings-btn sm primary"
              disabled={!pick || busy !== null}
              onClick={() => void download()}
            >
              {t("projectSettings.spellDownload")}
            </button>
          </span>
        }
      />
    </>
  );
}
