// The phone's app language as a list to tap, from the start page's "This
// phone" section. The phone is its own origin, so it never saw the desktop's
// choice and stayed in English; the pick is kept by `applyLanguage`'s own
// cache, which the next load paints in before anything else, and switches
// every `useT()` reader in place — no reload.

import { applyLanguage, LANGUAGES, useI18nStore, useT, type Language } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { OptionSheet, type SheetOption } from "./OptionSheet";

function languageLabel(lang: Language): string {
  return LANGUAGES.find((language) => language.value === lang)?.label ?? lang;
}

export function LanguageRow({ open, expanded }: { open: () => void; expanded: boolean }) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  return <li><button aria-haspopup="dialog" aria-expanded={expanded} onClick={open}>
    <span><strong>{t("mobile.language.title")}{isUntested("mobile.language") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{languageLabel(lang)}</small></span>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
  </button></li>;
}

export function LanguageSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const options: SheetOption[] = LANGUAGES.map((language) => ({
    key: language.value,
    label: language.label,
    current: language.value === lang,
  }));
  return <OptionSheet
    title={t("mobile.language.title")}
    note={{ text: t("mobile.language.hint") }}
    options={options}
    waiting=""
    busy={false}
    onPick={(key) => {
      applyLanguage(key);
      onClose();
    }}
    onClose={onClose}
  />;
}
