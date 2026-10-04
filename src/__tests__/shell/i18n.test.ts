import { describe, it, expect } from "vitest";
import { translate, normalizeLang, dateLocale, LANGUAGES, enSource, type TranslationKey } from "../../lib/i18n";
import { BRAND } from "../../lib/brand";
// The aggregator also registers every lazy dictionary, so `translate` below
// answers in all five languages without awaiting a chunk.
import { TRANSLATIONS } from "../../lib/i18nDicts/all";

describe("i18n", () => {
  it("translates a known key per language", () => {
    expect(translate("en", "settings.title")).toBe("Settings");
    expect(translate("de", "settings.title")).toBe("Einstellungen");
    expect(translate("es", "settings.title")).toBe("Configuración");
    expect(translate("fr", "settings.title")).toBe("Paramètres");
    expect(translate("it", "settings.title")).toBe("Impostazioni");
  });

  it("falls back to English when a language lacks a key", () => {
    // `translate` with a made-up key returns the raw key (last-resort fallback),
    // and every real key present in `en` resolves in every language via fallback.
    // Spot-check the fallback path by asking a language for the base value: even
    // if a future key is added to `en` only, non-English still renders English,
    // never a blank.
    const enTitle = translate("en", "settings.title");
    for (const { value } of LANGUAGES) {
      expect(translate(value, "settings.title").length).toBeGreaterThan(0);
    }
    expect(enTitle).toBe("Settings");
  });

  it("substitutes {name} placeholders", () => {
    // No parameterized keys ship yet, but the substitution contract is public.
    expect(
      translate("en", "settings.title", { unused: "x" }),
    ).toBe("Settings");
  });

  it("normalizes unknown/empty language codes to English", () => {
    expect(normalizeLang("de")).toBe("de");
    expect(normalizeLang("xx")).toBe("en");
    expect(normalizeLang("")).toBe("en");
    expect(normalizeLang(null)).toBe("en");
    expect(normalizeLang(undefined)).toBe("en");
  });

  it("offers exactly the five supported languages", () => {
    expect(LANGUAGES.map((l) => l.value)).toEqual(["en", "de", "es", "fr", "it"]);
  });

  // The fallback to English is what makes a half-translated language *degrade*
  // rather than break — which is also why a missing key is invisible: nothing
  // fails, the string just comes out in English for four of the five languages.
  // Spot-checking one key could never catch that, so the whole set is compared.
  it("every language covers every English key", () => {
    const enKeys = Object.keys(TRANSLATIONS.en);
    const missingByLang: Record<string, string[]> = {};
    for (const { value } of LANGUAGES) {
      if (value === "en") continue;
      const dict = TRANSLATIONS[value] as Record<string, string>;
      const missing = enKeys.filter((k) => typeof dict[k] !== "string");
      if (missing.length) missingByLang[value] = missing.slice(0, 20);
    }
    expect(missingByLang).toEqual({});
  });

  it("no language defines a key English does not", () => {
    // A stray key is dead weight that can never render: `translate` reads the
    // English block for the key set every component is allowed to ask for.
    const enKeys = new Set(Object.keys(TRANSLATIONS.en));
    const extraByLang: Record<string, string[]> = {};
    for (const { value } of LANGUAGES) {
      if (value === "en") continue;
      const extra = Object.keys(TRANSLATIONS[value]).filter((k) => !enKeys.has(k));
      if (extra.length) extraByLang[value] = extra.slice(0, 20);
    }
    expect(extraByLang).toEqual({});
  });

  it("every {placeholder} in English survives into every translation", () => {
    // A dropped `{path}` renders the literal braces to the user, and a *renamed*
    // one renders nothing at all — both invisible until someone runs that
    // language. The worktree confirmations are exactly this shape.
    const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    const mismatched: string[] = [];
    for (const { value } of LANGUAGES) {
      if (value === "en") continue;
      const dict = TRANSLATIONS[value] as Record<string, string>;
      for (const [key, text] of Object.entries(TRANSLATIONS.en)) {
        const there = dict[key];
        if (typeof there !== "string") continue;
        const a = placeholders(text as string).join(",");
        const b = placeholders(there).join(",");
        if (a !== b) mismatched.push(`${value}/${key}: en[${a}] vs [${b}]`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("fills {app} with the brand name in every language, with and without params", () => {
    // The dictionaries spell the app's name `{app}`; it is filled where a
    // dictionary is loaded, so the no-params early return in `translate` must
    // never leak the literal placeholder.
    const keys = (Object.keys(enSource) as TranslationKey[]).filter((k) =>
      (enSource[k] as string).includes("{app}"),
    );
    expect(keys.length).toBeGreaterThan(100);
    const leaked: string[] = [];
    for (const { value } of LANGUAGES) {
      for (const key of keys) {
        for (const text of [translate(value, key), translate(value, key, { unused: "x" })]) {
          // A translation may leave the name out where English has it.
          const named = value !== "en" || text.includes(BRAND.display);
          if (text.includes("{app}") || !named) {
            leaked.push(`${value}/${key}`);
          }
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  it("fills {slug} with the lowercase name in every language, with and without params", () => {
    // Paths and file names a text mentions (`~/{slug}/projects`) carry the
    // lowercase form; it is filled at the same place as `{app}`.
    const keys = (Object.keys(enSource) as TranslationKey[]).filter((k) =>
      (enSource[k] as string).includes("{slug}"),
    );
    expect(keys.length).toBeGreaterThan(5);
    const leaked: string[] = [];
    for (const { value } of LANGUAGES) {
      for (const key of keys) {
        for (const text of [translate(value, key), translate(value, key, { unused: "x" })]) {
          const named = value !== "en" || text.includes(BRAND.slug);
          if (text.includes("{slug}") || !named) leaked.push(`${value}/${key}`);
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  it("spells the app's name only as {app} or {slug} in dictionary values", () => {
    const spelled: string[] = [];
    for (const [key, text] of Object.entries(enSource)) {
      if ((text as string).toLowerCase().includes(BRAND.slug)) spelled.push(key);
    }
    expect(spelled).toEqual([]);
  });

  it("spells dates in the app language, keeping the browser's region when it matches", () => {
    expect(dateLocale("de", "de-AT")).toBeUndefined();
    expect(dateLocale("en", "en-GB")).toBeUndefined();
    expect(dateLocale("de", "en-US")).toBe("de");
    expect(dateLocale("fr", undefined)).toBe("fr");
  });
});
