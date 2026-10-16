import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { assistantErrorCode, assistantSetSearch, type AssistantSearchState } from "../../lib/assistant";
import { useT, type TranslationKey } from "../../lib/i18n";
import { SETTINGS_CHANGED_EVENT, useSettingsStore } from "../../stores/settings";
import { Dropdown } from "../common/Dropdown";
import { PasswordInput } from "../common/PasswordInput";
import { UntestedTag } from "../common/UntestedTag";
import { SettingRow, SettingsCard } from "../layout/settingsUi";

type Kind = "none" | "searxng" | "ollama";

/** The wire codes `assistant_set_search` refuses with, in words. Anything else
 *  (the keychain's own text, a locked ring) is shown as it came. */
const ERROR_KEYS: Record<string, TranslationKey> = {
  invalid_url: "assistant.search.errUrl",
  url_required: "assistant.search.errUrlRequired",
  invalid_key: "assistant.search.errKey",
  key_required: "assistant.search.errKeyRequired",
};

/**
 * The web lane's search backend (plan decision 7): none, a SearXNG address, or
 * Ollama's web search with an API key. One form for both homes — Settings →
 * the assistant page, and the card the overlay shows when a local model has no
 * search yet — so they cannot disagree.
 *
 * The key field is **write-only**: the stored key is never read back (the
 * command does not return it), so the field is always empty and an empty field
 * means "keep what is stored". The key goes to the OS keychain only.
 */
export function AssistantSearchSetup({
  search,
  onSaved,
}: {
  /** What the backend reported; `null` before its first answer. */
  search: AssistantSearchState | null;
  /** The saved state, so the caller can show it without a re-read. */
  onSaved?: (search: AssistantSearchState) => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<Kind>(search?.kind ?? "none");
  const [url, setUrl] = useState(search?.searxngUrl ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Follow the stored state when it arrives or changes (the first answer, a
  // save from another window), without trampling what is being typed.
  const storedKind = search?.kind ?? "none";
  const storedUrl = search?.searxngUrl ?? "";
  useEffect(() => {
    setKind(storedKind);
    setUrl(storedUrl);
  }, [storedKind, storedUrl]);

  const keyStored = search?.ollamaKeyStored === true;
  const save = async (opts: { removeKey?: boolean } = {}) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    // A removed key leaves Ollama's search with nothing to authenticate by, so
    // that choice falls back to none (the backend refuses `ollama` without one).
    const effective: Kind = opts.removeKey && kind === "ollama" ? "none" : kind;
    try {
      const result = await assistantSetSearch(effective, {
        url: effective === "searxng" ? url.trim() : undefined,
        // Empty keeps the stored key; "remove" is an explicit empty string.
        key: opts.removeKey ? "" : key.trim() || undefined,
      });
      // Broadcast like any settings write: this window's store, then the others.
      useSettingsStore.setState({ settings: result.settings });
      void emit(SETTINGS_CHANGED_EVENT, result.settings).catch(() => {});
      setKey("");
      setKind(effective);
      setSaved(true);
      onSaved?.(result.search);
    } catch (err) {
      const code = assistantErrorCode(err);
      setError(ERROR_KEYS[code] ? t(ERROR_KEYS[code]) : String(err).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  const kindOptions = [
    { value: "none", label: t("assistant.search.none") },
    { value: "searxng", label: t("assistant.search.searxng") },
    { value: "ollama", label: t("assistant.search.ollama") },
  ];

  return (
    <SettingsCard className="assistant-search-setup">
      <SettingRow
        label={<>{t("assistant.search.kind")} <UntestedTag id="assistant.search" /></>}
        control={
          <Dropdown
            value={kind}
            options={kindOptions}
            ariaLabel={t("assistant.search.kind")}
            onChange={(v) => {
              setKind(v as Kind);
              setSaved(false);
            }}
          />
        }
      />
      {kind === "searxng" && (
        <label className="settings-field">
          {t("assistant.search.searxngUrl")}
          <input
            value={url}
            placeholder="https://search.example.org"
            onChange={(e) => {
              setUrl(e.target.value);
              setSaved(false);
            }}
          />
        </label>
      )}
      {kind === "ollama" && (
        <>
          <label className="settings-field">
            {t("assistant.search.ollamaKey")}
            {/* Write-only: never filled from the backend, stored or not. */}
            <PasswordInput
              value={key}
              autoComplete="off"
              placeholder={t(keyStored ? "assistant.search.keyKeep" : "assistant.search.keyPaste")}
              onChange={(e) => {
                setKey(e.target.value);
                setSaved(false);
              }}
            />
          </label>
          <p className="settings-help">
            {keyStored ? t("assistant.search.keyStored") : t("assistant.search.keyHelp")}
            {search?.keyring === "locked" ? ` ${t("assistant.search.keyringLocked")}` : ""}
          </p>
        </>
      )}
      {kind === "none" && <p className="settings-help">{t("assistant.search.noneHelp")}</p>}
      {kind === "searxng" && <p className="settings-help">{t("assistant.search.searxngHelp")}</p>}
      <div className="settings-link-row">
        <button type="button" className="settings-btn sm primary" disabled={busy} onClick={() => void save()}>
          {t("assistant.search.save")}
        </button>
        {keyStored && (
          <button type="button" className="settings-btn sm" disabled={busy} onClick={() => void save({ removeKey: true })}>
            {t("assistant.search.removeKey")}
          </button>
        )}
        {saved && <span className="settings-help" role="status">{t("assistant.search.saved")}</span>}
      </div>
      {error && <p className="project-dialog-error" role="alert">{error}</p>}
    </SettingsCard>
  );
}
