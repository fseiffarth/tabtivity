/**
 * Dictionary-picker helpers for the editors' spelling check (M#248) — the pure
 * half of `files/SpellDictionaryPicker.tsx` and the header's language select.
 *
 * The backend names dictionaries by their Hunspell stem (`de_DE`, `sr-Latn`,
 * `eo`) and deliberately carries no display names: a language's name in the
 * UI language is what `Intl.DisplayNames` exists for, and shipping sixty names
 * in five languages by hand would only drift. The code is kept beside the name
 * (`Deutsch (Deutschland) · de_DE`) because it is what the settings file and
 * the dictionaries folder are keyed by, so a user reconciling the two can.
 */

/** An installed dictionary as `spell_dictionaries` reports it. */
export interface InstalledDictionary {
  code: string;
  /** Lives in Tabtivity's own dictionaries folder (downloaded or dropped in), so
   *  it can be removed from here; a system dictionary cannot. */
  removable: boolean;
}

/** A downloadable dictionary as `spell_dictionaries` reports it. */
export interface CatalogDictionary {
  code: string;
  source: string;
}

export interface DictionaryChoice {
  code: string;
  label: string;
  removable: boolean;
}

/** `de_DE` → `de-DE` (what `Intl` understands); already-tagged codes pass. */
export function hunspellToBcp47(code: string): string {
  return code.replace(/_/g, "-");
}

/** The language's name in `uiLang` (falls back to the code when the engine
 *  has no `Intl.DisplayNames`, or no name for that tag). */
export function languageDisplayName(code: string, uiLang: string): string {
  try {
    const dn = new Intl.DisplayNames([uiLang], { type: "language" });
    const name = dn.of(hunspellToBcp47(code));
    if (name && name !== hunspellToBcp47(code)) return name;
  } catch {
    // Older engines: no Intl.DisplayNames, or an unknown tag.
  }
  return code;
}

/** `Deutsch (Deutschland) · de_DE` — name first, the stem the files are keyed
 *  by second. When the name is unavailable the code alone is shown. */
export function dictionaryLabel(code: string, uiLang: string): string {
  const name = languageDisplayName(code, uiLang);
  return name === code ? code : `${name} · ${code}`;
}

/** The backend's default when `spell_language` is unset: an English variant if
 *  installed, else the first. Mirrors `services::spell::default_language`. */
export function defaultSpellLanguage(installed: readonly { code: string }[]): string {
  return installed.find((d) => d.code.startsWith("en"))?.code ?? installed[0]?.code ?? "";
}

/**
 * The two lists the picker renders, labelled in `uiLang` and sorted by label:
 * what is installed (selectable), and what the catalog offers that is not yet
 * installed (downloadable). A catalog entry whose code is installed — from the
 * system or from an earlier download — is not offered twice.
 */
export function dictionaryChoices(
  installed: readonly InstalledDictionary[],
  catalog: readonly CatalogDictionary[],
  uiLang: string,
): { installed: DictionaryChoice[]; downloadable: DictionaryChoice[] } {
  const byLabel = (a: DictionaryChoice, b: DictionaryChoice) =>
    a.label.localeCompare(b.label, uiLang);
  const have = new Set(installed.map((d) => d.code));
  return {
    installed: installed
      .map((d) => ({ code: d.code, label: dictionaryLabel(d.code, uiLang), removable: d.removable }))
      .sort(byLabel),
    downloadable: catalog
      .filter((c) => !have.has(c.code))
      .map((c) => ({ code: c.code, label: dictionaryLabel(c.code, uiLang), removable: false }))
      .sort(byLabel),
  };
}
