import { useState } from "react";
import { ApiError, setTabColor, type TabRow } from "../api";
import { TAB_COLORS, TAB_COLOR_IDS, TAB_COLOR_LABELS } from "../tabColors";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";

/** Paint one tab from the phone, or clear its colour (#264).
 *
 * `RenameSheet`'s sibling, and deliberately shaped like it: the tab is named by
 * its opaque id, the desktop owns the tab layout, and nothing here works
 * without desktop Tabtivity open — which is why the failure says so rather than
 * "request failed".
 *
 * It commits on the tap instead of holding a Save button. A colour is a label
 * rather than a destructive act (the close beside it is the one that asks), and
 * the swatch it lands on is the confirmation; what a phone needs from this is
 * one tap, not three. The sheet stays open after a pick so a second hue is one
 * more tap, and the ring follows the colour the DESKTOP answered with rather
 * than the one tapped, so a refused write cannot leave the sheet lying. */
export function ColorSheet({ tab, onClose, onColored }: {
  tab: TabRow;
  onClose: () => void;
  onColored: (color: string | undefined) => void;
}) {
  const t = useT();
  const [current, setCurrent] = useState<string | undefined>(tab.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pick = async (color: string | null) => {
    setBusy(true);
    setError("");
    try {
      const answer = await setTabColor(tab.id, color);
      // The desktop persists asynchronously, so the route may answer with the
      // stored id alone rather than a caught-up row; either is the authority.
      const stored = answer.tab ? answer.tab.color : (answer.color ?? undefined);
      setCurrent(stored ?? undefined);
      onColored(stored ?? undefined);
    } catch (cause) {
      setError(cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable")
        ? t("mobile.color.needsDesktop")
        : t("mobile.color.failed"));
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.project.colorTab", { label: tab.label })} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("common.close")}>✕</button><h2>{t("mobile.color.title")} {isUntested("mobile.sheet.color") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">{t("mobile.color.note", { label: tab.label })}</p>
      {error && <p className="sheet-note error" role="alert">{error}</p>}
      <div className="tab-color-grid" role="group" aria-label={t("mobile.color.title")}>
        <button
          type="button"
          className={`tab-color-chip none${current ? "" : " is-current"}`}
          disabled={busy}
          aria-pressed={!current}
          onClick={() => void pick(null)}
        >
          <span className="tab-color-chip-dot none" aria-hidden="true" />
          {t("mobile.color.none")}
        </button>
        {TAB_COLOR_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={`tab-color-chip${current === id ? " is-current" : ""}`}
            disabled={busy}
            aria-pressed={current === id}
            onClick={() => void pick(id)}
          >
            <span className="tab-color-chip-dot" style={{ background: TAB_COLORS[id] }} aria-hidden="true" />
            {TAB_COLOR_LABELS[id] ? t(TAB_COLOR_LABELS[id]) : id}
          </button>
        ))}
      </div>
      <div className="mobile-schedule-form">
        <div className="mobile-schedule-actions">
          <button disabled={busy} onClick={onClose}>{busy ? t("common.saving") : t("mobile.gitSheet.done")}</button>
        </div>
      </div>
    </section>
  </div>;
}
