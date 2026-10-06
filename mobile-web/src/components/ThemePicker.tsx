// The phone's theme as a list to tap, from the start page's "This device"
// sheet (the header's gear): the desktop's own themes under their desktop
// names, plus following the desktop, which is where an untouched phone starts.

import type { TranslationKey } from "../../../src/lib/i18n";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { PHONE_THEMES, readDesktopTheme, setPhoneTheme, type DesktopTheme, type PhoneTheme } from "../theme";
import { OptionSheet, type SheetOption } from "./OptionSheet";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

const THEME_NAME: Record<DesktopTheme, TranslationKey> = {
  system: "theme.name.system",
  fancy_dark: "theme.name.fancyDark",
  soft_dark: "theme.name.softDark",
  dark: "theme.name.dark",
  light: "theme.name.light",
  fancy_light: "theme.name.fancyLight",
  light_lavender: "theme.name.lightLavender",
};

/** What the row says it is set to. Following the desktop names the theme
 * that turned out to be, since "same as desktop" alone leaves the reader to
 * guess which. */
export function themeSummary(choice: PhoneTheme, t: Translate): string {
  if (choice !== "desktop") return t(THEME_NAME[choice]);
  return `${t("mobile.theme.desktop")} · ${t(THEME_NAME[readDesktopTheme()])}`;
}

export function ThemeRow({ choice, open, expanded }: { choice: PhoneTheme; open: () => void; expanded: boolean }) {
  const t = useT();
  return <li><button aria-haspopup="dialog" aria-expanded={expanded} onClick={open}>
    <span><strong>{t("mobile.theme.title")}{isUntested("mobile.theme") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{themeSummary(choice, t)}</small></span>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
  </button></li>;
}

export function ThemeSheet({ chosen, onChoose, onClose }: {
  chosen: PhoneTheme;
  onChoose: (choice: PhoneTheme) => void;
  onClose: () => void;
}) {
  const t = useT();
  const options: SheetOption[] = PHONE_THEMES.map((choice) => ({
    key: choice,
    label: choice === "desktop" ? t("mobile.theme.desktop") : t(THEME_NAME[choice]),
    description: choice === "desktop" ? t(THEME_NAME[readDesktopTheme()]) : undefined,
    current: choice === chosen,
  }));
  return <OptionSheet
    title={t("mobile.theme.title")}
    note={{ text: t("mobile.theme.hint") }}
    options={options}
    waiting=""
    busy={false}
    onPick={(key) => {
      const choice = key as PhoneTheme;
      setPhoneTheme(choice);
      onChoose(choice);
      onClose();
    }}
    onClose={onClose}
  />;
}
