import type { TranslationKey } from "../i18n";

/**
 * Parser-limit refusals from the backend viewers. `commands::sheets` (via
 * `services::sheet_reader`) and `commands::sqlite` answer a refused, timed-out
 * or crashed parse with one of these fixed codes instead of prose, so the
 * viewer can show it in the app's language. Keep in step with the `ERR_*`
 * constants there.
 */
const LIMIT_KEYS: Record<string, TranslationKey> = {
  "viewer-limit:sheet-too-large": "viewerLimit.sheetTooLarge",
  "viewer-limit:sheet-timeout": "viewerLimit.sheetTimeout",
  "viewer-limit:sheet-crashed": "viewerLimit.sheetCrashed",
  "viewer-limit:sheet-unsupported": "viewerLimit.sheetUnsupported",
  "viewer-limit:sqlite-timeout": "viewerLimit.sqliteTimeout",
  "viewer-limit:sqlite-too-large": "viewerLimit.sqliteTooLarge",
};

/** The translation key for a backend limit code, or `null` for any other error. */
export function viewerLimitKey(error: unknown): TranslationKey | null {
  return Object.prototype.hasOwnProperty.call(LIMIT_KEYS, String(error))
    ? LIMIT_KEYS[String(error)]
    : null;
}

/** A backend viewer error as display text: a limit code translated, anything
 *  else (an OS or SQLite message) as the backend wrote it. */
export function viewerErrorText(
  t: (key: TranslationKey) => string,
  error: unknown,
): string {
  const key = viewerLimitKey(error);
  return key ? t(key) : String(error);
}
