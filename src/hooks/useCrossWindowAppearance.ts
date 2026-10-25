import { listen } from "@tauri-apps/api/event";
import { useTauriListener } from "./useTauriListener";
import {
  applyAccent,
  applyCorners,
  applyCursor,
  applyTheme,
  applyThemeVars,
  APPEARANCE_CHANGED_EVENT,
  LANGUAGE_CHANGED_EVENT,
  THEME_CHANGED_EVENT,
  type AppearancePayload,
} from "../stores/settings";
import { applyLanguage } from "../lib/i18n";

/**
 * Follow the main window's live appearance changes. A popout, the PDF present
 * window and the deck's audience window are each their own JS runtime with their
 * own `document` and settings store: a theme, accent, corner style, cursor pack
 * or language picked in the main window's Settings only touches THAT window
 * unless the cross-window broadcast (see the `*_CHANGED_EVENT`s in
 * `stores/settings`) is applied here too. The initial values arrive with the
 * window's own `settings.load()`.
 */
export function useCrossWindowAppearance(): void {
  useTauriListener(() => listen<string>(THEME_CHANGED_EVENT, (e) => applyTheme(e.payload)), []);

  useTauriListener(
    () =>
      listen<AppearancePayload>(APPEARANCE_CHANGED_EVENT, (e) => {
        applyAccent(e.payload.accent);
        // After the accent, as everywhere else: an explicit token override wins
        // over the value applyAccent derives from the accent.
        applyThemeVars(e.payload.themeVars);
        applyCorners(e.payload.corners);
        // Last: the cursor art is drawn from the palette the three above set.
        applyCursor(e.payload.cursor);
      }),
    [],
  );

  useTauriListener(() => listen<string>(LANGUAGE_CHANGED_EVENT, (e) => applyLanguage(e.payload)), []);
}
