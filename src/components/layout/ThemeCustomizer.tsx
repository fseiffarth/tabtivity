import { useModalFocus } from "../../hooks/useModalFocus";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyAccent,
  applyThemeVars,
  normalizeAccent,
  normalizeThemePresets,
  normalizeThemeVars,
  THEME_PRESET_LIMIT,
  THEME_PRESET_NAME_MAX,
  useSettingsStore,
} from "../../stores/settings";
import {
  THEME_COLOR_RE,
  THEME_TOKEN_GROUPS,
  THEME_TOKENS,
  themeTokenExampleKey,
  type ThemeToken,
} from "../../lib/theme/themeTokens";
import {
  buildCursorPreview,
  CURSOR_PACKS,
  CURSOR_SIZE,
  type CursorPack,
} from "../../lib/theme/cursorPacks";
import { useT } from "../../lib/i18n";
import {
  THEMES,
  type CornerStyle,
  type Settings,
  type ThemePreset,
} from "../../types";
import { Dropdown } from "../common/Dropdown";
import { SettingsCard, SettingsHeader, SettingsSection, SettingRow } from "./settingsUi";
import { UntestedTag } from "../common/UntestedTag";
import { CloseIcon } from "../common/icons/Icon";

/**
 * The Theme Customizer: a window of its own for recoloring the active theme
 * token by token, plus the corner-style knob that shapes the same chrome.
 *
 * It edits `Settings.ui_theme_vars` (`lib/theme/themeTokens` is the allow-list) and,
 * for the accent row alone, `Settings.ui_accent` — that one already has a
 * cross-theme setting whose derived hover/active/pill family rides along, and
 * two settings writing `--accent` would be two sources of truth for one color.
 *
 * Two things are worth knowing before editing this file:
 *
 *  - **The current value of a token cannot be read.** `getComputedStyle` hands
 *    back a custom property's *token stream* — `color-mix(in srgb, …)`, a
 *    `var()` chain, a gradient — not a color. So each swatch is resolved by
 *    PAINTING it: a hidden probe takes `color: var(--token)` and its computed
 *    `color` is read back. A sentinel color on the probe's parent catches the
 *    values that are not colors at all (the "fancy" themes' gradient
 *    `--bg-header`), which fall back to the token's `probe` twin.
 *  - **The palette strip is that same readback, deduplicated.** "Colors in
 *    this theme" lists every distinct color the document paints right now —
 *    overrides included — so a new value can be matched to one already on
 *    screen. It is derived, never stored.
 *  - **Edits preview immediately and persist on a debounce.** A color input
 *    fires dozens of events per drag, and every commit is a settings.json
 *    write plus a cross-window broadcast — the same bargain the accent picker
 *    makes.
 */

/** The probe's sentinel: if a token does not resolve to a color, `color`
 *  inherits and the readback equals this. No real token is this value. */
const SENTINEL = "rgb(1, 2, 3)";

function componentToHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

/** `rgb()`/`rgba()` (comma or space separated) → `#rrggbb`, or `#rrggbbaa`
 *  when the color carries alpha. Anything else → null. */
export function cssColorToHex(value: string): string | null {
  const m = value.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return null;
  const parts = m[1].split(/[,/\s]+/).filter((p) => p.length > 0);
  if (parts.length < 3) return null;
  const [r, g, b] = parts.slice(0, 3).map((p) => Number.parseFloat(p));
  if (![r, g, b].every((n) => Number.isFinite(n))) return null;
  let hex = `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
  if (parts.length >= 4) {
    const a = Number.parseFloat(parts[3]);
    if (Number.isFinite(a) && a < 1) hex += componentToHex(a * 255);
  }
  return hex;
}

/** Resolve every catalog token to a hex color as the document paints it right
 *  now — theme values, and any override already applied. One probe, one pass. */
function readTokenColors(tokens: readonly ThemeToken[]): Record<string, string> {
  const out: Record<string, string> = {};
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden;color:" +
    SENTINEL;
  const probe = document.createElement("span");
  host.appendChild(probe);
  document.body.appendChild(host);
  const read = (name: string): string | null => {
    probe.style.color = `var(${name})`;
    const painted = window.getComputedStyle(probe).color;
    if (!painted || painted === SENTINEL) return null;
    return cssColorToHex(painted);
  };
  try {
    for (const tk of tokens) {
      out[tk.name] = read(tk.name) ?? (tk.probe ? read(tk.probe) : null) ?? "#000000";
    }
  } finally {
    host.remove();
  }
  return out;
}

/** The 6-digit form a native color input can hold (it has no alpha channel). */
function hex6(value: string): string {
  return /^#[0-9a-f]{8}$/i.test(value) ? value.slice(0, 7) : value;
}

/** One color the active theme paints, and the tokens painting it. */
export interface PaletteEntry {
  hex: string;
  tokens: string[];
}

/** The resolved palette collapsed to its DISTINCT colors, in catalog order.
 *
 *  Catalog order rather than sorted-by-hue: the catalog runs accent → surfaces
 *  → text → …, so the strip reads as the theme's own structure, and the color
 *  somebody is looking for sits near the tokens they were just editing. A
 *  theme reuses one value across a dozen tokens, so this is a short list — the
 *  point of showing it at all is that "the color already on screen" is
 *  reachable rather than eyeballed. */
export function paletteFromColors(
  colors: Record<string, string>,
  tokens: readonly ThemeToken[],
): PaletteEntry[] {
  const byHex = new Map<string, PaletteEntry>();
  for (const tk of tokens) {
    const hex = colors[tk.name];
    if (!hex) continue;
    const hit = byHex.get(hex);
    if (hit) hit.tokens.push(tk.name);
    else byHex.set(hex, { hex, tokens: [tk.name] });
  }
  return [...byHex.values()];
}

/** The used-color strip that drops out of a row's palette button. Purely
 *  presentational: the picking is the row's, so a palette color commits down
 *  the same debounced path a typed hex does. */
function ThemePalette({
  palette,
  onPick,
}: {
  palette: readonly PaletteEntry[];
  onPick: (hex: string) => void;
}) {
  const t = useT();
  return (
    <div className="theme-palette">
      <span className="theme-palette-title">{t("theme.palette")}</span>
      <div className="theme-palette-strip">
        {palette.map((entry) => (
          <button
            key={entry.hex}
            type="button"
            className="accent-swatch theme-palette-swatch"
            style={{ background: entry.hex }}
            title={`${entry.hex} — ${entry.tokens.join(", ")}`}
            aria-label={entry.hex}
            onClick={() => onPick(entry.hex)}
          />
        ))}
      </div>
    </div>
  );
}

/** The button that opens a row's palette strip. Its own component only so the
 *  accent row and every token row show the same affordance in the same place. */
function PaletteToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className={"settings-btn sm theme-palette-toggle" + (open ? " active" : "")}
      title={t("theme.palette.pick")}
      aria-label={t("theme.palette.pick")}
      aria-expanded={open}
      onClick={onToggle}
    >
      ▤
    </button>
  );
}

/** The accent swatch strip. One hue per major theme accent plus the status
 *  greens/ambers' warm neighbours — a handful, the highlighter-pen rule, with
 *  the native color input as the way to any other hue. */
const ACCENT_PRESETS = [
  "#36c5f0",
  "#4f8cff",
  "#7c5cdb",
  "#b388ff",
  "#ff5c8a",
  "#f47868",
  "#e3a13a",
  "#14b8a6",
  "#3fb950",
];

/** The accent-color control: preset swatches, a native color input for any
 *  other hue, and a reset back to the theme's own accent. Purely
 *  presentational — the preview and the debounced write are `setAccent`'s,
 *  below, so the accent and every other token commit through one path. It
 *  lived in the Settings panel until the customizer existed; the accent is a
 *  theme color like the rest and belongs in the window that edits them. */
function AccentPicker({
  value,
  onPick,
}: {
  value: string | null;
  onPick: (v: string | null) => void;
}) {
  const t = useT();
  return (
    <div className="accent-picker">
      {ACCENT_PRESETS.map((c) => (
        <button
          key={c}
          type="button"
          className={"accent-swatch" + (value === c ? " active" : "")}
          style={{ background: c }}
          title={c}
          aria-label={c}
          onClick={() => onPick(c)}
        />
      ))}
      <input
        type="color"
        className="accent-custom"
        value={value ?? "#36c5f0"}
        title={t("settings.accent.custom")}
        aria-label={t("settings.accent.custom")}
        onChange={(e) => onPick(e.target.value.toLowerCase())}
      />
      <button
        type="button"
        className="settings-btn sm"
        disabled={value === null}
        onClick={() => onPick(null)}
      >
        {t("settings.accent.reset")}
      </button>
    </div>
  );
}

/** A token's name and, under it, an example of what it paints. The name alone
 *  says where a value sits in the design system; the example says what moves
 *  on screen when it changes, which is the question actually being asked at
 *  this panel. Keyed off the name (`themeTokenExampleKey`), so a catalog entry
 *  cannot arrive without one. */
function TokenLabel({ name }: { name: string }) {
  const t = useT();
  return (
    <span className="theme-var-label">
      <code className="theme-var-name">{name}</code>
      <span className="theme-var-example">
        {t(themeTokenExampleKey(name) as "theme.var.bg-main")}
      </span>
    </span>
  );
}

/** One token: swatch, its CSS variable name, an editable hex, and a reset that
 *  appears only while the token is actually overridden. The hex field keeps a
 *  local draft — a half-typed `#1a2` must not reach the root style, where an
 *  invalid value drops every rule reading the token. */
function TokenRow({
  token,
  current,
  override,
  palette,
  onChange,
}: {
  token: ThemeToken;
  /** What the document paints for this token right now. */
  current: string;
  /** The stored override, or null when the theme's own value stands. */
  override: string | null;
  /** The colors this theme already paints, offered under the row. */
  palette: readonly PaletteEntry[];
  onChange: (value: string | null) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const shown = draft ?? override ?? current;
  const invalid = draft !== null && !THEME_COLOR_RE.test(draft);
  return (
    <div className="theme-var-item">
      <div className={"theme-var-row" + (override ? " overridden" : "")}>
        <input
          type="color"
          className="accent-custom theme-var-swatch"
          value={hex6(shown)}
          aria-label={token.name}
          onChange={(e) => {
            setDraft(null);
            onChange(e.target.value.toLowerCase());
          }}
        />
        <TokenLabel name={token.name} />
        <input
          type="text"
          className={"theme-var-hex" + (invalid ? " invalid" : "")}
          value={shown}
          spellCheck={false}
          aria-label={token.name}
          onChange={(e) => {
            const v = e.target.value.trim().toLowerCase();
            setDraft(v);
            if (THEME_COLOR_RE.test(v)) onChange(v);
          }}
          onBlur={() => setDraft(null)}
        />
        <PaletteToggle open={paletteOpen} onToggle={() => setPaletteOpen((v) => !v)} />
        <button
          type="button"
          className="settings-btn sm theme-var-reset"
          disabled={!override}
          title={t("theme.resetOne")}
          aria-label={t("theme.resetOne")}
          onClick={() => {
            setDraft(null);
            onChange(null);
          }}
        >
          ⟲
        </button>
      </div>
      {paletteOpen && (
        <ThemePalette
          palette={palette}
          onPick={(hex) => {
            setDraft(null);
            onChange(hex);
          }}
        />
      )}
    </div>
  );
}

/** The accent's row: the swatch strip instead of a hex field, plus the same
 *  palette drawer every other row has. The accent keeps its presets rather than
 *  becoming a plain hex row — they ARE the control most of the time — and its
 *  reset doubles as this row's. A palette color arrives 6-digit: `ui_accent`
 *  has no alpha channel, and a translucent accent would fade every control
 *  derived from it. */
function AccentRow({
  name,
  accent,
  palette,
  onPick,
}: {
  name: string;
  accent: string | null;
  palette: readonly PaletteEntry[];
  onPick: (value: string | null) => void;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  return (
    <div className="theme-var-item">
      <div className={"theme-var-row accent-row" + (accent ? " overridden" : "")}>
        <TokenLabel name={name} />
        <AccentPicker value={accent} onPick={onPick} />
        <PaletteToggle open={paletteOpen} onToggle={() => setPaletteOpen((v) => !v)} />
      </div>
      {paletteOpen && (
        <ThemePalette palette={palette} onPick={(hex) => onPick(hex6(hex))} />
      )}
    </div>
  );
}

export function ThemeCustomizerDialog({
  onClose,
  onBack,
}: {
  onClose: () => void;
  /** Return to the Settings window this was opened from. */
  onBack?: () => void;
}) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  const { settings, updateSettings } = useSettingsStore();

  const stored = useMemo(
    () => normalizeThemeVars(settings?.ui_theme_vars),
    [settings?.ui_theme_vars],
  );
  const accent = normalizeAccent(settings?.ui_accent);
  // Live edits live here so a drag repaints at once; the store catches up on
  // the debounce below. Seeded from — and re-seeded by — what is persisted.
  const [vars, setVars] = useState<Record<string, string>>(stored);
  useEffect(() => setVars(stored), [stored]);

  // Re-resolve the painted palette whenever anything that feeds it changes:
  // the theme, the accent, or the overrides themselves.
  const [tick, setTick] = useState(0);
  const current = useMemo(
    () => readTokenColors(THEME_TOKENS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, settings?.color_scheme, accent],
  );

  const palette = useMemo(() => paletteFromColors(current, THEME_TOKENS), [current]);

  // The saved looks. Normalized on READ like everything else that reaches the
  // root style: settings.json is hand-editable and Load is one click.
  const presets = useMemo(
    () => normalizeThemePresets(settings?.ui_theme_presets),
    [settings?.ui_theme_presets],
  );
  const [presetName, setPresetName] = useState("");
  /** The preset whose × has been pressed once. Deleting a look somebody built
   *  by hand has no undo, so the button asks before it acts. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const commit = (next: Record<string, string>) => {
    setVars(next);
    applyThemeVars(next);
    setTick((n) => n + 1);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void updateSettings({
        ui_theme_vars: Object.keys(next).length > 0 ? next : undefined,
      });
    }, 400);
  };

  const setToken = (name: string, value: string | null) => {
    const next = { ...vars };
    if (value) next[name] = value;
    else delete next[name];
    commit(next);
  };

  const setAccent = (value: string | null) => {
    applyAccent(value);
    // The accent's derived family is re-set by applyAccent, which would undo a
    // hand-picked --accent-hover; re-assert the overrides on top of it.
    applyThemeVars(vars);
    setTick((n) => n + 1);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void updateSettings({ ui_accent: value ?? undefined });
    }, 400);
  };

  /** The active pack's own art, as plain images. It is the same render (and
   *  the same cache) the pointer itself uses, so the strip cannot show one
   *  thing while the cursor is another — and it is keyed on `tick` as well as
   *  the pack, because the art is drawn from the palette this window edits. */
  const cursorPreview = useMemo(
    () => buildCursorPreview(settings?.ui_cursor ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` is the palette's change signal
    [settings?.ui_cursor, tick],
  );

  const overrideCount = Object.keys(vars).length + (accent ? 1 : 0);

  /** The look as it stands, ready to be stored: the base theme it sits on, the
   *  accent, the token overrides and the corner knob — everything this window
   *  can change, since a palette without its base theme comes back as a
   *  different look entirely. */
  const buildPreset = (id: string, name: string): ThemePreset => {
    const entry: ThemePreset = { id, name, vars: { ...vars }, saved: Date.now() };
    const theme = settings?.color_scheme;
    const known = THEMES.find((x) => x.value === theme);
    if (known) entry.theme = known.value;
    if (accent) entry.accent = accent;
    if (settings?.ui_corners) entry.corners = settings.ui_corners;
    if (settings?.ui_cursor) entry.cursor = settings.ui_cursor;
    return entry;
  };

  const writePresets = (next: ThemePreset[]) => {
    setPendingDelete(null);
    void updateSettings({ ui_theme_presets: next.length > 0 ? next : undefined });
  };

  /** Save under the typed name — replacing the saved theme of the same name
   *  rather than growing a second entry that claims to be it. */
  const savePreset = () => {
    const name = presetName.trim().slice(0, THEME_PRESET_NAME_MAX);
    if (!name) return;
    const existing = presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!existing && presets.length >= THEME_PRESET_LIMIT) return;
    const entry = buildPreset(existing?.id ?? crypto.randomUUID(), name);
    writePresets(
      existing ? presets.map((p) => (p.id === existing.id ? entry : p)) : [...presets, entry],
    );
    setPresetName("");
  };

  /** Apply a saved look. One patch, so the theme, accent, overrides and corners
   *  land together — `updateSettings` applies them in the order the accent's
   *  derived family expects, and broadcasts to the popout windows. A color edit
   *  still waiting on the debounce is dropped: it belongs to the look being
   *  replaced, and letting it land afterwards would repaint one token of the
   *  old palette on top of the new one. */
  const loadPreset = async (preset: ThemePreset) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setPendingDelete(null);
    setVars(preset.vars);
    const patch: Partial<Settings> = {
      ui_accent: preset.accent,
      ui_corners: preset.corners,
      ui_cursor: preset.cursor ?? null,
      ui_theme_vars: Object.keys(preset.vars).length > 0 ? preset.vars : undefined,
    };
    if (preset.theme) patch.color_scheme = preset.theme;
    await updateSettings(patch);
    setTick((n) => n + 1);
  };

  const presetMeta = (preset: ThemePreset): string => {
    const known = THEMES.find((x) => x.value === preset.theme);
    const theme = known ? t(known.labelKey) : "—";
    const n = Object.keys(preset.vars).length;
    return n > 0
      ? t("theme.presets.meta", { theme, n })
      : t("theme.presets.metaPlain", { theme });
  };

  /** A few of the preset's own colors, so the list is scannable by look and not
   *  only by name. The accent leads — it is what a saved theme is usually
   *  recognised by. */
  const presetDots = (preset: ThemePreset): string[] =>
    [preset.accent, ...Object.values(preset.vars)].filter((c): c is string => !!c).slice(0, 6);

  const resetAll = () => {
    setVars({});
    applyThemeVars({});
    applyAccent(null);
    setTick((n) => n + 1);
    if (timer.current !== null) window.clearTimeout(timer.current);
    void updateSettings({ ui_theme_vars: undefined, ui_accent: undefined });
  };

  return (
    <div className="modal-backdrop how-to-start-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("theme.title")}
        className="settings-dialog theme-customizer"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <SettingsHeader
          title={
            <>
              {t("theme.title")} <UntestedTag id="theme.title" />
            </>
          }
          onBack={onBack}
          onClose={onClose}
        />
        <div className="dialog-scroll">
          <p className="settings-help">{t("theme.intro")}</p>

          <SettingsCard>
            <div className="settings-card-row">
              <span className="settings-card-label">
                {overrideCount > 0
                  ? t("theme.overridden", { n: overrideCount })
                  : t("theme.none")}
              </span>
              <button
                type="button"
                className="settings-btn sm"
                disabled={overrideCount === 0}
                onClick={resetAll}
              >
                {t("theme.reset")}
              </button>
            </div>
          </SettingsCard>

          <SettingsSection
            title={
              <>
                {t("theme.presets")} <UntestedTag id="theme.presets" />
              </>
            }
            help={t("theme.presets.help")}
          >
            <SettingsCard className="theme-preset-card">
              <div className="theme-preset-save">
                <input
                  type="text"
                  className="theme-preset-name"
                  value={presetName}
                  maxLength={THEME_PRESET_NAME_MAX}
                  spellCheck={false}
                  placeholder={t("theme.presets.name")}
                  aria-label={t("theme.presets.name")}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") savePreset();
                  }}
                />
                <button
                  type="button"
                  className="settings-btn sm"
                  disabled={
                    presetName.trim().length === 0 ||
                    (presets.length >= THEME_PRESET_LIMIT &&
                      !presets.some(
                        (p) => p.name.toLowerCase() === presetName.trim().toLowerCase(),
                      ))
                  }
                  title={
                    presets.length >= THEME_PRESET_LIMIT
                      ? t("theme.presets.full", { n: THEME_PRESET_LIMIT })
                      : t("theme.presets.replace")
                  }
                  onClick={savePreset}
                >
                  {t("theme.presets.save")}
                </button>
              </div>
              {presets.length === 0 ? (
                <div className="theme-preset-empty">{t("theme.presets.none")}</div>
              ) : (
                presets.map((preset) => (
                  <div key={preset.id} className="theme-preset-row">
                    <span className="theme-preset-label">
                      <span className="theme-preset-title">{preset.name}</span>
                      <span className="theme-preset-meta">{presetMeta(preset)}</span>
                    </span>
                    <span className="theme-preset-dots" aria-hidden="true">
                      {presetDots(preset).map((c, i) => (
                        <span
                          key={`${c}-${i}`}
                          className="theme-preset-dot"
                          style={{ background: c }}
                        />
                      ))}
                    </span>
                    <button
                      type="button"
                      className="settings-btn sm"
                      title={t("theme.presets.loadHelp")}
                      onClick={() => void loadPreset(preset)}
                    >
                      {t("theme.presets.load")}
                    </button>
                    <button
                      type="button"
                      className="settings-btn sm"
                      title={t("theme.presets.update")}
                      aria-label={t("theme.presets.update")}
                      onClick={() =>
                        writePresets(
                          presets.map((p) =>
                            p.id === preset.id ? buildPreset(p.id, p.name) : p,
                          ),
                        )
                      }
                    >
                      ⭮
                    </button>
                    <button
                      type="button"
                      className={
                        "settings-btn sm theme-preset-delete" +
                        (pendingDelete === preset.id ? " armed" : "")
                      }
                      title={t("theme.presets.delete")}
                      aria-label={t("theme.presets.delete")}
                      onClick={() => {
                        if (pendingDelete === preset.id) {
                          writePresets(presets.filter((p) => p.id !== preset.id));
                        } else {
                          setPendingDelete(preset.id);
                        }
                      }}
                    >
                      {pendingDelete === preset.id ? t("theme.presets.confirm") : <CloseIcon />}
                    </button>
                  </div>
                ))
              )}
            </SettingsCard>
          </SettingsSection>

          <SettingRow
            label={
              <>
                {t("settings.corners")} <UntestedTag id="settings.corners" />
              </>
            }
            help={t("settings.corners.help")}
            control={
              <Dropdown
                value={settings?.ui_corners ?? "default"}
                onChange={(v) =>
                  void updateSettings({
                    ui_corners: v === "default" ? undefined : (v as CornerStyle),
                  })
                }
                options={[
                  { value: "default", label: t("settings.corners.default") },
                  { value: "square", label: t("settings.corners.square") },
                  { value: "rounded", label: t("settings.corners.rounded") },
                ]}
              />
            }
          />

          <SettingRow
            label={
              <>
                {t("settings.cursor")} <UntestedTag id="settings.cursor" />
              </>
            }
            help={t("settings.cursor.help")}
            control={
              <div className="cursor-setting">
                <Dropdown
                  value={settings?.ui_cursor ?? "system"}
                  onChange={(v) =>
                    void updateSettings({
                      // `null`, never `undefined`: an undefined property is
                      // dropped by the JSON that carries the patch, so "System"
                      // would leave the stored pack in place.
                      ui_cursor: v === "system" ? null : (v as CursorPack),
                    })
                  }
                  options={[
                    { value: "system", label: t("settings.cursor.system") },
                    ...CURSOR_PACKS.map((pack) => ({
                      value: pack,
                      label: t(`settings.cursor.${pack}` as "settings.cursor.aurora"),
                    })),
                  ]}
                />
                {cursorPreview.length > 0 && (
                  <div className="cursor-preview" aria-hidden="true">
                    {cursorPreview.map((src) => (
                      <img
                        key={src.slice(-24)}
                        src={src}
                        alt=""
                        width={CURSOR_SIZE}
                        height={CURSOR_SIZE}
                      />
                    ))}
                  </div>
                )}
              </div>
            }
          />

          {THEME_TOKEN_GROUPS.map((group) => (
            <SettingsSection
              key={group.id}
              title={
                <>
                  {t(`theme.group.${group.id}` as "theme.group.surfaces")}
                  {/* The two groups nobody has seen paint yet; drop the pill
                      once the top bar and a tab bar have been recolored
                      live. */}
                  {(group.id === "topframe" || group.id === "subwindow") && (
                    <>
                      {" "}
                      <UntestedTag id="themeCustomizer.1" />
                    </>
                  )}
                </>
              }
              help={t(`theme.group.${group.id}.help` as "theme.group.surfaces.help")}
            >
              <SettingsCard className="theme-var-card">
                {group.tokens.map((token) =>
                  token.linked === "accent" ? (
                    <AccentRow
                      key={token.name}
                      name={token.name}
                      accent={accent}
                      palette={palette}
                      onPick={setAccent}
                    />
                  ) : (
                    <TokenRow
                      key={token.name}
                      token={token}
                      current={current[token.name] ?? "#000000"}
                      override={vars[token.name] ?? null}
                      palette={palette}
                      onChange={(v) => setToken(token.name, v)}
                    />
                  ),
                )}
              </SettingsCard>
            </SettingsSection>
          ))}
        </div>
      </div>
    </div>
  );
}
