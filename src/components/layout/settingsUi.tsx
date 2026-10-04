import { Dropdown } from "../common/Dropdown";
import { useId, useState, type ChangeEventHandler, type ReactNode } from "react";
import { Toggle } from "../common/Toggle";
import { useT } from "../../lib/i18n";

/**
 * The settings design system, in components.
 *
 * `styles/themes.css` (see "Settings design system") owns what these look
 * like; this file owns the *markup* every settings surface is built from, so a
 * panel cannot quietly invent a fifth kind of row. The whole Settings dialog —
 * main panel, every sub-panel, and the settings-shaped sections other dialogs
 * embed — is made of:
 *
 *   `SettingsHeader`   one title strip: ‹ Back, title, ✕
 *   `SettingsSection`  a section header, its intro copy, and its content
 *   `SettingsCard`     the one container
 *   `SettingRow`       a labelled control (+ its help) as a card
 *   `ToggleRow`        one switch line, for stacking several in one card
 *   `ToggleCard`       a single switch (+ its help) as a card
 *   `SettingsAdvanced` a collapsed "Advanced options" fold at a panel's foot
 *
 * The rule of thumb: **help text belongs to a control, not to the scroll**.
 * Pass it as `help` so it renders inside that control's card; a loose
 * `<p className="settings-help">` is for a section intro and nothing else.
 */

/** One header for every settings surface. `onBack` renders the sub-panel's
 *  return arrow on the left; `onClose` the dialog's ✕ on the right — a
 *  sub-panel gets both, so closing Settings never costs two clicks. */
export function SettingsHeader({
  title,
  onBack,
  onClose,
}: {
  title: ReactNode;
  onBack?: () => void;
  onClose?: () => void;
}) {
  const t = useT();
  return (
    <div className="settings-title-row">
      {onBack && (
        <button type="button" className="settings-btn sm" onClick={onBack}>
          ‹ {t("common.back")}
        </button>
      )}
      <h2>{title}</h2>
      {onClose && (
        <button type="button" className="dialog-close-btn" aria-label={t("common.close")} onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
}

/** Page ids inside the main settings panel. `tabtivity:open-settings` may carry
 *  one as `{ panel, anchor }`, which is how a deep link from elsewhere in the
 *  app opens that page instead of the General one. */
export const SETTINGS_ANCHORS = {
  mobile: "settings-anchor-mobile",
} as const;

/** A section header, optionally introduced by a line of copy. Renders a
 *  fragment: the panel's scroll is a flex column and owns the spacing, so a
 *  wrapper element here would only add a second gap to reason about. The
 *  header carries the `anchor` id for the same reason: an extra wrapper purely
 *  to be scrolled to would change that spacing. */
export function SettingsSection({
  title,
  help,
  anchor,
  children,
}: {
  title: ReactNode;
  help?: ReactNode;
  anchor?: string;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="settings-section-title" role="heading" aria-level={3} tabIndex={anchor ? -1 : undefined} id={anchor}>{title}</div>
      {help && <p className="settings-help">{help}</p>}
      {children}
    </>
  );
}

/** The one fold for rarely-touched settings, closed on every open of its
 *  panel. Put it last in a panel's scroll, and put whole cards in it: it is a
 *  demotion of controls most users never need, not a place to hide a warning.
 *  The body is its own flex column (the scroll's gap does not reach inside a
 *  wrapper), and it is unmounted while closed, so a card inside it costs
 *  nothing until someone asks for it. */
export function SettingsAdvanced({
  title,
  help,
  children,
}: {
  title?: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className={`settings-advanced${open ? " open" : ""}`}>
      <button
        type="button"
        className="settings-advanced-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="settings-advanced-chevron" aria-hidden="true">
          ›
        </span>
        {title ?? t("settings.advancedOptions")}
      </button>
      {open && (
        <div id={bodyId} className="settings-advanced-body">
          {help && <p className="settings-help">{help}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

/** The one container. Hold several `ToggleRow`s to group switches that answer
 *  the same question; for a single control prefer `SettingRow`/`ToggleCard`. */
export function SettingsCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`settings-card${className ? ` ${className}` : ""}`}>{children}</div>
  );
}

/** A labelled control as its own card: label left, control in the shared
 *  control column, help attached underneath. `htmlFor` associates the label
 *  with an `<input>`; a `Dropdown` is a button and needs none. */
export function SettingRow({
  label,
  control,
  help,
  htmlFor,
}: {
  /** `ReactNode`, not `string`: a label may carry an `<UntestedTag />`. */
  label: ReactNode;
  control: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="settings-card">
      <div className="settings-card-row">
        {htmlFor ? (
          <label className="settings-card-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="settings-card-label">{label}</span>
        )}
        {control}
      </div>
      {help && <p className="settings-help">{help}</p>}
    </div>
  );
}

/** One switch line. A `<label>` so the whole row toggles it — which is why the
 *  row's own help (if any) renders *after* the label, never inside it. */
export function ToggleRow({
  label,
  checked,
  onChange,
  disabled,
  title,
  aside,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
  disabled?: boolean;
  title?: string;
  /** A control of the row's own before the switch (a compact `settings-btn
   *  sm`). The row is then a `<div>` whose label points at the switch, so the
   *  control is neither part of the switch's name nor a click on the label. */
  aside?: ReactNode;
}) {
  const id = useId();
  if (aside) {
    return (
      <div className="settings-card-row">
        <label className="settings-card-label" htmlFor={id}>{label}</label>
        {aside}
        <Toggle id={id} checked={checked} onChange={onChange} disabled={disabled} title={title} />
      </div>
    );
  }
  return (
    <label className="settings-card-row">
      <span>{label}</span>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} title={title} />
    </label>
  );
}

/** A single switch with its explanation, as one card. */
export function ToggleCard({
  label,
  checked,
  onChange,
  disabled,
  help,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
  disabled?: boolean;
  help?: ReactNode;
}) {
  return (
    <SettingsCard>
      <ToggleRow label={label} checked={checked} onChange={onChange} disabled={disabled} />
      {help && <p className="settings-help">{help}</p>}
    </SettingsCard>
  );
}

/** A list of repeated rows. `boxed` frames them as one table with hairline
 *  separators (download folders, shortcuts, file types); leave it off when the
 *  children are cards that already draw their own edges. */
export function SettingsList({
  children,
  boxed,
  className,
}: {
  children: ReactNode;
  boxed?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`settings-list${boxed ? " boxed" : ""}${className ? ` ${className}` : ""}`}
    >
      {children}
    </div>
  );
}

export interface SettingsNavEntry {
  value: string;
  label: string;
  /** Which of the page's settings matched the search box, shown under the
   *  label so a hit on "zoom" says *why* Layout is still listed. */
  hits?: string[];
}

export interface SettingsNavGroup {
  label: string;
  entries: SettingsNavEntry[];
}

/** Persistent category navigation: a search box, then the groups, each entry
 *  one page on the right. Compacted to the search box plus the shared dropdown
 *  on narrow windows. Enter in the search box opens the first match; Escape
 *  clears a query before it can close the dialog. */
export function SettingsNavigation({ value, groups, onChange, query, onQuery }: {
  value: string;
  groups: SettingsNavGroup[];
  onChange: (value: string) => void;
  query: string;
  onQuery: (query: string) => void;
}) {
  const t = useT();
  const flat = groups.flatMap((group) => group.entries);
  return <nav className="settings-navigation" aria-label={t("settings.categories")}>
    <input
      type="text"
      className="settings-navigation-search"
      value={query}
      placeholder={t("settings.search")}
      aria-label={t("settings.search")}
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => onQuery(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && flat[0]) {
          e.preventDefault();
          onChange(flat[0].value);
        } else if (e.key === "Escape" && query) {
          e.preventDefault();
          onQuery("");
        }
      }}
    />
    <div className="settings-navigation-compact">
      <Dropdown ariaLabel={t("settings.categories")} title={t("settings.categories")} value={value} options={flat} onChange={onChange} placeholder={t("settings.categories")} />
    </div>
    <div className="settings-navigation-links">
      {groups.map((group) => <div key={group.label} className="settings-navigation-group" role="group" aria-label={group.label}>
        <div className="settings-navigation-group-title">{group.label}</div>
        {group.entries.map((entry) => <button key={entry.value} type="button" className="settings-btn"
          aria-current={entry.value === value ? "location" : undefined}
          onClick={() => onChange(entry.value)}>
          {entry.label}
          {entry.hits && entry.hits.length > 0 && <span className="settings-navigation-hit">{entry.hits.join(" · ")}</span>}
        </button>)}
      </div>)}
      {flat.length === 0 && <div className="settings-empty">{t("settings.searchNoMatch")}</div>}
    </div>
  </nav>;
}
