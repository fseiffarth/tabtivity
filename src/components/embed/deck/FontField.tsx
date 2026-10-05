/**
 * The deck's font control — the three built-ins plus every embeddable face on
 * this machine (TODO V #120).
 *
 * Its whole job is to yield a `FontFamily`, which for a custom face is the font
 * **file's path**. That is deliberate and load-bearing: the path is the key
 * `deck/fonts.ts` measures by and `export.ts` embeds by, so a deck can never end
 * up laid out against one face and drawn with another. A family *name* would not
 * do — two files can claim one name, and the export would be a coin flip.
 *
 * The machine's font list is fetched **once per app run** and shared, because a
 * directory walk per deck tab (or per re-render of a panel) is pure waste for a
 * list that does not change while Tabtivity is open.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  type FontFamily,
  STANDARD_FAMILIES,
  customFontPath,
  fontKey,
} from "../../../lib/viewers/deck/model";
import { useT } from "../../../lib/i18n";

export interface FontFile {
  path: string;
  name: string;
}

/** Memoized at module scope — see the module note. */
let cached: Promise<FontFile[]> | null = null;

export function loadFontList(): Promise<FontFile[]> {
  if (!cached) {
    // Defensive on the shape as well as on the rejection: a build without the
    // command, or a host that answered with something else, must degrade to
    // "only the built-in families" rather than take the inspector down.
    cached = invoke<FontFile[]>("list_fonts")
      .then((f) => (Array.isArray(f) ? f : []))
      .catch(() => []);
  }
  return cached;
}

/** Drop the memo. Tests only. */
export function resetFontList(): void {
  cached = null;
}

export function useFontList(): FontFile[] {
  const [fonts, setFonts] = useState<FontFile[]>([]);
  useEffect(() => {
    let live = true;
    void loadFontList().then((f) => {
      if (live) setFonts(f);
    });
    return () => {
      live = false;
    };
  }, []);
  return fonts;
}

export interface FontFieldProps {
  value: FontFamily | undefined;
  onChange: (next: FontFamily) => void;
  /** Label above the control; omitted inside a row that already has one. */
  label?: string;
  /** Report a face the deck names but could not load, so the picker can say so
   *  rather than silently showing a font that is not what will be drawn. */
  missing?: boolean;
}

export function FontField({ value, onChange, label, missing }: FontFieldProps) {
  const t = useT();
  const resolvedLabel = label ?? t("deckFontField.defaultLabel");
  const fonts = useFontList();
  const current = value ?? "sans";
  const path = customFontPath(current);
  // A deck may name a font this machine does not have — opened on another
  // computer, or after the file moved. It stays selectable (removing it from the
  // list would silently rewrite the deck on the next change) and is marked.
  const orphan = path && !fonts.some((f) => f.path === path);

  return (
    <label className="deck-field">
      <span>
        {resolvedLabel}
        {missing && (
          <span className="deck-font-missing" title={t("deckFontField.missingTitle")}>
            {" · "}
            {t("deckFontField.missing")}
          </span>
        )}
      </span>
      <select
        value={fontKey(current)}
        onChange={(e) => {
          const v = e.target.value;
          onChange(
            v.startsWith("custom:") ? { custom: v.slice("custom:".length) } : (v as FontFamily),
          );
        }}
      >
        <optgroup label={t("deckFontField.builtInGroup")}>
          <option value="sans">Helvetica</option>
          <option value="serif">Times</option>
          <option value="mono">Courier</option>
        </optgroup>
        {orphan && (
          <optgroup label={t("deckFontField.namedNotFoundGroup")}>
            <option value={`custom:${path}`}>{path!.split("/").pop()}</option>
          </optgroup>
        )}
        {fonts.length > 0 && (
          <optgroup label={t("deckFontField.installedGroup")}>
            {fonts.map((f) => (
              <option key={f.path} value={`custom:${f.path}`} title={f.path}>
                {f.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/** The three built-ins, for anywhere that needs to name them. */
export const BUILT_IN_FAMILIES = STANDARD_FAMILIES;
