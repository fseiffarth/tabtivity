import { useModalFocus } from "../../../hooks/useModalFocus";
/**
 * The icon picker: a searchable grid over the bundled library
 * (`lib/viewers/deck/icons.ts`).
 *
 * Renders each icon from the same path data the stage and the PDF exporter use,
 * so what you pick is exactly what lands on the slide and exactly what exports —
 * there is no separate preview asset that could drift.
 */

import { useMemo, useState } from "react";
import {
  type IconCategory,
  type IconDef,
  ICON_CATEGORIES,
  ICON_VIEWBOX,
  iconLabel,
  searchIcons,
} from "../../../lib/viewers/deck/icons";
import { useT } from "../../../lib/i18n";

export interface IconPickerProps {
  onPick: (icon: IconDef) => void;
  onClose: () => void;
}

export function IconPicker({ onPick, onClose }: IconPickerProps) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<IconCategory | null>(null);

  // A query searches the WHOLE library: filtering by a category you happen to
  // have open, while typing a name, reads as "the icon isn't there".
  const results = useMemo(
    () => searchIcons(query, t, query.trim() ? undefined : (category ?? undefined)),
    [query, category, t],
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="project-dialog deck-icon-picker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("deckIconPicker.ariaLabel")}
      >
        <div className="settings-title-row">
          <h3>{t("deckIconPicker.title")}</h3>
          <button className="dialog-close-btn" onClick={onClose} aria-label={t("common.close")}>
            ×
          </button>
        </div>

        <input
          className="deck-icon-search"
          autoFocus
          placeholder={t("deckIconPicker.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="deck-icon-cats">
          <button
            className={`deck-icon-cat${category === null ? " active" : ""}`}
            onClick={() => setCategory(null)}
          >
            {t("deckIconPicker.allCategory")}
          </button>
          {ICON_CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={`deck-icon-cat${category === c.id ? " active" : ""}`}
              onClick={() => setCategory(c.id)}
            >
              {t(c.labelKey)}
            </button>
          ))}
        </div>

        <div className="deck-icon-grid">
          {results.map((def) => (
            <button
              key={def.key}
              className="deck-icon-cell"
              title={iconLabel(def, t)}
              onClick={() => onPick(def)}
            >
              <svg viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`} width={26} height={26}>
                <g
                  transform={
                    def.rotate
                      ? `rotate(${def.rotate} ${ICON_VIEWBOX / 2} ${ICON_VIEWBOX / 2})`
                      : undefined
                  }
                >
                  {def.paths.map((d, i) => (
                    <path
                      key={i}
                      d={d}
                      fill={def.filled ? "currentColor" : "none"}
                      stroke={def.filled ? "none" : "currentColor"}
                      strokeWidth={def.filled ? undefined : 1.7}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}
                </g>
              </svg>
              <span className="deck-icon-label">{iconLabel(def, t)}</span>
            </button>
          ))}
          {results.length === 0 && <div className="deck-icon-empty">{t("deckIconPicker.noMatches")}</div>}
        </div>
      </div>
    </div>
  );
}
