import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { copilotServes } from "../../../lib/viewers/completion/copilotCompletionProvider";
import { isProseLang } from "../../../lib/viewers/completion/autocomplete";
import { useTabsStore, type ViewerState } from "../../../stores/tabs";
import { useSettingsStore } from "../../../stores/settings";
import { useExperimental } from "../../../lib/experimental";
import { useProjectsStore } from "../../../stores/projects";
import { Dropdown } from "../../common/Dropdown";
import { languageForPath } from "../../../lib/viewers/highlight";
import { useOllamaStatus } from "../../../lib/ollamaStatus";
import { type InternalViewer } from "../../../lib/viewers/fileUtils";
import { UntestedTag } from "../../common/UntestedTag";
import { type AutocompleteMode, type AutocompleteTrigger } from "../../../types";
import { useFileScope } from "../../../lib/files/fileAccess";
import { useChordHint } from "../../../lib/shortcuts/shortcutHint";
import { useI18nStore, useT } from "../../../lib/i18n";
import {
  defaultSpellLanguage,
  dictionaryChoices,
  languageDisplayName,
  type CatalogDictionary,
  type InstalledDictionary,
} from "../../../lib/spellDictionaries";
import { ErrorNote } from "../../common/ErrorNote";
import { seedViewerState } from "./viewerState";

// #45 completion-length modes. Cycle order for the live Shift+Tab toggle (while
// a ghost suggestion is showing) and human labels for the status line / settings
// dropdown. Kept in sync with the Rust `CompletionMode`.
const AC_MODES: AutocompleteMode[] = ["sentence", "block", "scope"];
/** Next mode in the cycle (wraps), for the live Shift+Tab toggle. */
export function nextAcMode(m: AutocompleteMode): AutocompleteMode {
  return AC_MODES[(AC_MODES.indexOf(m) + 1) % AC_MODES.length];
}
/** Human label for a completion-length mode, shared by the live status line and
 *  the settings dropdown. A pure helper (not a component), so it takes `t` as an
 *  explicit parameter — mirrors `TableView.tsx`'s `delimiterLabel`. */
export function acModeLabel(m: AutocompleteMode, t: ReturnType<typeof useT>): string {
  if (m === "sentence") return t("projectSettings.sentence");
  if (m === "block") return t("projectSettings.block");
  return t("projectSettings.scope");
}

/** Resolve the per-type viewer prefs for an InternalViewer from settings (#48). */
export function useViewerPref(type: InternalViewer) {
  return useSettingsStore((s) => s.settings?.viewer_prefs?.[type]);
}

/** What {@link useTabAiPrefs} returns: the effective autocomplete/spelling config
 *  for the editor, plus the current control state + setters for the in-tab UI. */
export interface TabAiPrefs {
  ac: {
    enabled: boolean; preferred?: string; preferredProse?: string; mode: AutocompleteMode;
    /** Unset: the provider's default ({@link effectiveAcTrigger}). */
    trigger?: AutocompleteTrigger;
  };
  sc: { enabled: boolean; language?: string };
  autocomplete: boolean;
  spelling: boolean;
  mode: AutocompleteMode;
  trigger?: AutocompleteTrigger;
  toggleAutocomplete: () => void;
  toggleSpelling: () => void;
  setMode: (m: AutocompleteMode) => void;
  setTrigger: (t: AutocompleteTrigger) => void;
}

/** A tab's trigger, or the provider's default: Copilot asks only on request
 *  (each automatic request spends the account's completions), a local model
 *  after a typing pause (it costs nothing but the machine). */
export function effectiveAcTrigger(trigger: AutocompleteTrigger | undefined, copilot: boolean): AutocompleteTrigger {
  return trigger ?? (copilot ? "manual" : "auto");
}

/**
 * Tab-local AI-assist prefs (#45). Each editor tab gets its OWN autocomplete
 * on/off, completion-length mode, and spelling on/off, overriding the per-type
 * `viewer_prefs` default for that tab only. The override is seeded once from the
 * tab's persisted `viewerState` and written back there (like scroll/zoom), so it
 * survives reopening the file and a Tabtivity restart. Until the user touches a
 * control, the value tracks the per-type setting reactively; once toggled, that
 * tab pins its own value. The `preferred` autocomplete model is its 🧠-menu tag
 * (`ollama_roles.autocomplete`), falling back to `ollama_model`.
 */
export function useTabAiPrefs(tabKey: string | undefined, type: InternalViewer): TabAiPrefs {
  const pref = useViewerPref(type);
  // Per-task model preference (🧠 menu role chips): autocomplete can pin a
  // loaded model, falling back to the default `ollama_model` when it has no
  // explicit assignment. Resolved against the resident set
  // at trigger time (see the request paths above).
  const defaultModel = useSettingsStore((s) => s.settings?.ollama_model as string | undefined);
  const acRole = useSettingsStore((s) => s.settings?.ollama_roles?.autocomplete as string | undefined);
  const acProseRole = useSettingsStore((s) => s.settings?.ollama_roles?.autocomplete_prose as string | undefined);
  const acPreferred = acRole ?? defaultModel;
  // Dictionary spell check: no model involved — its one setting is which
  // Hunspell dictionary, machine-wide (unset lets the backend pick).
  const spellLanguage = useSettingsStore(
    (s) => s.settings?.spell_language as string | undefined,
  );
  const defAutocomplete = pref?.autocomplete === true;
  const defSpelling = pref?.spell_check === true;
  const defMode: AutocompleteMode = AC_MODES.includes(pref?.autocomplete_mode as AutocompleteMode)
    ? (pref!.autocomplete_mode as AutocompleteMode)
    : "sentence";

  // Seed the tab-local override once from the persisted viewerState. `undefined`
  // for a field means "no override yet" → fall through to the per-type default.
  const [override, setOverride] = useState<{
    autocomplete?: boolean;
    spelling?: boolean;
    mode?: AutocompleteMode;
    trigger?: AutocompleteTrigger;
  }>(() => {
    const vs = seedViewerState(tabKey);
    return {
      autocomplete: vs?.autocomplete,
      spelling: vs?.spellCheck,
      mode: vs?.autocompleteMode,
      trigger: vs?.autocompleteTrigger === "auto" || vs?.autocompleteTrigger === "manual"
        ? vs.autocompleteTrigger : undefined,
    };
  });

  const persist = useCallback(
    (patch: ViewerState) => {
      if (tabKey) useTabsStore.getState().setViewerState(tabKey, patch);
    },
    [tabKey],
  );

  const autocomplete = override.autocomplete ?? defAutocomplete;
  const spelling = override.spelling ?? defSpelling;
  const mode = override.mode ?? defMode;

  const toggleAutocomplete = useCallback(() => {
    setOverride((o) => {
      const next = !(o.autocomplete ?? defAutocomplete);
      persist({ autocomplete: next });
      return { ...o, autocomplete: next };
    });
  }, [persist, defAutocomplete]);
  const toggleSpelling = useCallback(() => {
    setOverride((o) => {
      const next = !(o.spelling ?? defSpelling);
      persist({ spellCheck: next });
      return { ...o, spelling: next };
    });
  }, [persist, defSpelling]);
  const setMode = useCallback(
    (m: AutocompleteMode) => {
      persist({ autocompleteMode: m });
      setOverride((o) => ({ ...o, mode: m }));
    },
    [persist],
  );
  const setTrigger = useCallback(
    (trigger: AutocompleteTrigger) => {
      persist({ autocompleteTrigger: trigger });
      setOverride((o) => ({ ...o, trigger }));
    },
    [persist],
  );
  const trigger = override.trigger;

  return {
    ac: { enabled: autocomplete, preferred: acPreferred, preferredProse: acProseRole, mode, trigger },
    sc: { enabled: spelling, language: spellLanguage },
    autocomplete,
    spelling,
    mode,
    trigger,
    toggleAutocomplete,
    toggleSpelling,
    setMode,
    setTrigger,
  };
}

/**
 * Whether at least one local (Ollama) model is currently loaded into memory.
 * Local autocomplete runs only against a resident model, so its controls hide
 * when none is loaded. Mirrors the lamp logic in `LocalModelMenu`: `ollama_status` is
 * `"loaded"` iff `/api/ps` reports a resident model.
 *
 * Rides the app-wide shared poller (`lib/ollamaStatus`) rather than owning a
 * timer. This hook runs **per editable viewer tab**, so a private 5s interval
 * made the `/api/ps` request rate a function of how many tabs happened to be
 * open — asking the same machine-wide question N times over. One timer now
 * serves every surface, and they all flip on the same observation.
 */
function useLocalModelLoaded(): boolean {
  return useOllamaStatus() === "loaded";
}

/**
 * In-tab AI-assist controls for the editable viewers (#45): an Autocomplete
 * on/off toggle, always shown, and while it is on: the provider (local model
 * or Copilot, the one `code_completion_provider` setting, offered while the
 * experimental Copilot flag is on), when to ask (after a pause or only on
 * Ctrl+Space, tab-local) and the length mode (local only). The dictionary
 * Spelling toggle sits beside it. When the chosen provider cannot answer here
 * (no local model loaded, Copilot not allowed for this file), a short note
 * says why instead of the button vanishing.
 */
export function EditorAiControls({ ai, path }: { ai: TabAiPrefs; path: string }) {
  const t = useT();
  const chordHint = useChordHint();
  const modelLoaded = useLocalModelLoaded();
  const scope = useFileScope();
  const enabled = useExperimental("copilot_completion");
  const remote = useProjectsStore((s) => !!s.projects.find((p) => p.id === scope)?.remote);
  const language = languageForPath(path);
  const copilot = useSettingsStore((s) => copilotServes(s.settings, enabled, scope, remote, language, path));
  const provider = useSettingsStore((s) => s.settings?.code_completion_provider ?? "ollama");
  const policy = useSettingsStore((s) => (scope ? s.settings?.completion_project_policies?.[scope] : undefined));
  const trigger = effectiveAcTrigger(ai.trigger, copilot);
  // Why the chosen provider is silent here; the backend gates the same way.
  const note = !ai.autocomplete ? null
    : enabled && provider === "copilot" && !copilot
      ? remote ? t("fileViewer.copilotNoteRemote")
        : policy?.copilot === true && policy.local_only !== true && isProseLang(language) && policy.copilot_text !== true
          ? t("fileViewer.copilotNoteText")
          : t("fileViewer.copilotNoteConsent")
      : !copilot && !modelLoaded ? t("fileViewer.autocompleteNoteNoModel") : null;
  return (
    <div className="file-viewer-ai-controls" role="group" aria-label={t("fileViewer.aiAssistGroup")}>
      {/* Dictionary spelling needs no model, so it is offered regardless. */}
      <button
        type="button"
        className={`file-viewer-ai-btn${ai.spelling ? " active" : ""}`}
        onClick={ai.toggleSpelling}
        aria-pressed={ai.spelling}
        title={
          ai.spelling
            ? t("fileViewer.spellingOnHint")
            : t("fileViewer.spellingOffHint")
        }
      >
        {t("fileViewer.spellingLabel")}
      </button>
      {ai.spelling && <SpellLanguageSelect />}
      <button
        type="button"
        className={`file-viewer-ai-btn${ai.autocomplete ? " active" : ""}`}
        onClick={ai.toggleAutocomplete}
        aria-pressed={ai.autocomplete}
        title={
          copilot ? chordHint(t("fileViewer.copilotToggleHint"), "editorAutocomplete") : ai.autocomplete
            ? chordHint(t("fileViewer.autocompleteOnHint"), "editorAutocomplete")
            : t("fileViewer.autocompleteOffHint")
        }
      >
        {t("fileViewer.autocompleteLabel")} <UntestedTag id="fileViewer.autocompleteLabel" />
      </button>
      {ai.autocomplete && (
        <>
          {enabled && (
            <Dropdown
              className="file-viewer-ai-mode"
              value={provider}
              title={t("fileViewer.autocompleteProviderTitle")}
              onChange={(v) => void useSettingsStore.getState().updateSettings({
                code_completion_provider: v as "ollama" | "copilot",
              })}
              options={[
                { value: "ollama", label: t("fileViewer.autocompleteProviderLocal") },
                { value: "copilot", label: t("fileViewer.autocompleteProviderCopilot") },
              ]}
            />
          )}
          <Dropdown
            className="file-viewer-ai-mode"
            value={trigger}
            title={chordHint(t("fileViewer.autocompleteTriggerTitle"), "editorAutocomplete")}
            onChange={(v) => ai.setTrigger(v as AutocompleteTrigger)}
            options={[
              { value: "auto", label: t("fileViewer.autocompleteTriggerAuto") },
              { value: "manual", label: t("fileViewer.autocompleteTriggerManual") },
            ]}
          />
          {!copilot && (
            <Dropdown
              className="file-viewer-ai-mode"
              value={ai.mode}
              title={t("fileViewer.completionLengthTitle")}
              onChange={(v) => ai.setMode(v as AutocompleteMode)}
              options={[
                { value: "sentence", label: t("projectSettings.sentence") },
                { value: "block", label: t("projectSettings.block") },
                { value: "scope", label: t("projectSettings.scope") },
              ]}
            />
          )}
          <UntestedTag id="fileViewer.autocompleteProvider" />
          {note && <span className="file-viewer-ai-note">{note}</span>}
        </>
      )}
    </div>
  );
}

/**
 * The dictionary the spelling chip reads, beside it — so the language can be
 * switched where the writing happens instead of in Project Settings. The
 * choice is `Settings.spell_language`, machine-wide (the backend's default,
 * an installed English variant, is what an unset value shows). Beside it, a
 * "＋ Language" menu downloads any other catalog language (the same
 * `spell_install_language` Project Settings' picker uses) and selects it —
 * shown even with nothing installed, which is when it is needed most.
 * Re-lists whenever the setting moves, which is also how a download made in
 * Settings while this tab is open reaches the list.
 */
function SpellLanguageSelect() {
  const t = useT();
  const uiLang = useI18nStore((s) => s.lang);
  const spellLanguage = useSettingsStore(
    (s) => s.settings?.spell_language as string | undefined,
  );
  const [dicts, setDicts] = useState<{
    installed: InstalledDictionary[];
    catalog: CatalogDictionary[];
  } | null>(null);
  // Bumped after a download: re-downloading the language the setting already
  // names (its files were missing) moves no setting, yet must re-list.
  const [listEpoch, setListEpoch] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    invoke<{ installed: InstalledDictionary[]; catalog: CatalogDictionary[] }>("spell_dictionaries")
      .then((d) => {
        if (live) setDicts(d);
      })
      .catch(() => {
        if (live) setDicts({ installed: [], catalog: [] });
      });
    return () => {
      live = false;
    };
  }, [spellLanguage, listEpoch]);
  if (!dicts) return null;
  const choices = dictionaryChoices(dicts.installed, dicts.catalog, uiLang);

  const download = async (code: string) => {
    if (busy) return;
    setBusy(code);
    setError(null);
    try {
      await invoke("spell_install_language", { code });
      // Read it right away: the language you just fetched is the one you want.
      await useSettingsStore.getState().updateSettings({ spell_language: code });
      setListEpoch((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {choices.installed.length > 0 && (
        <Dropdown
          className="file-viewer-ai-mode"
          value={spellLanguage ?? defaultSpellLanguage(dicts.installed)}
          title={t("fileViewer.spellingLanguageTitle")}
          options={choices.installed.map((d) => ({ value: d.code, label: d.label }))}
          disabled={busy !== null}
          onChange={(v) => void useSettingsStore.getState().updateSettings({ spell_language: v })}
        />
      )}
      {choices.downloadable.length > 0 && (
        <>
          <Dropdown
            className="file-viewer-ai-mode"
            value=""
            placeholder={
              busy
                ? t("fileViewer.spellingDownloading", { lang: languageDisplayName(busy, uiLang) })
                : t("fileViewer.spellingAddLanguage")
            }
            title={t("fileViewer.spellingAddLanguageTitle")}
            options={choices.downloadable.map((d) => ({ value: d.code, label: d.label }))}
            disabled={busy !== null}
            onChange={(v) => void download(v)}
          />
          <UntestedTag id="fileViewer.spellingAddLanguage" />
        </>
      )}
      {error && (
        <ErrorNote
          as="span"
          role="alert"
          className="file-viewer-spell-error"
          error={t("projectSettings.spellDownloadFailed", { error })}
        />
      )}
    </>
  );
}
