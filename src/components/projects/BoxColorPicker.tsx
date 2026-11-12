import { TAB_COLORS, TAB_COLOR_IDS } from "../../lib/theme/tabColors";
import { autoBoxColor, isBoxColor } from "../../lib/theme/boxColor";
import { useT } from "../../lib/i18n";
import type { ProjectBox } from "../../types";
import { UntestedTag } from "../common/UntestedTag";

/**
 * The Colour row of a box pill's context menu.
 *
 * The tab picker's swatch grid (`TabColorPicker`, same classes) — one app
 * palette, so a box and a tab tinted "blue" are the same blue — with two
 * differences a box needs:
 *
 *  - The leading chip is **Automatic**, not "no colour": a box always has a
 *    colour (its members wear it as a swatch), so clearing returns it to the
 *    one hashed from its id, and the chip shows that colour.
 *  - A trailing **custom** chip opens the native colour picker, for a box that
 *    must match something outside the palette. Box colours stay on the
 *    desktop, so unlike a tab's they need not be a closed set.
 */
export function BoxColorPicker({
  box,
  onPick,
}: {
  box: ProjectBox;
  onPick: (color: string | undefined) => void;
}) {
  const t = useT();
  return (
    <div className="context-menu-group">
      <div className="context-menu-group-label">
        {t("boxPill.colorGroup")} <UntestedTag id="boxPill.colorGroup" />
      </div>
      <BoxColorSwatches boxId={box.id} color={box.color} onPick={onPick} />
    </div>
  );
}

/**
 * The swatch grid alone — automatic, the app palette, a custom chip — for a
 * box of id `boxId` wearing `color`. The pill menu's Colour row and the box
 * sheet's colour row are both this, so the two can never offer different
 * palettes.
 */
export function BoxColorSwatches({
  boxId,
  color,
  onPick,
}: {
  boxId: string;
  color: string | undefined;
  onPick: (color: string | undefined) => void;
}) {
  const t = useT();
  const current = isBoxColor(color) ? color.toLowerCase() : undefined;
  const paletteHit = TAB_COLOR_IDS.find((id) => TAB_COLORS[id] === current);
  const custom = current && !paletteHit ? current : undefined;
  return (
    <div
      className="tab-color-swatches"
      role="group"
      aria-label={t("boxPill.colorGroup")}
    >
      <button
        type="button"
        className={`tab-color-swatch${current ? "" : " is-current"}`}
        style={{ background: autoBoxColor(boxId) }}
        title={t("boxPill.colorAuto")}
        aria-label={t("boxPill.colorAuto")}
        aria-pressed={!current}
        onClick={() => onPick(undefined)}
      />
      {TAB_COLOR_IDS.map((id) => (
        <button
          key={id}
          type="button"
          className={`tab-color-swatch${paletteHit === id ? " is-current" : ""}`}
          style={{ background: TAB_COLORS[id] }}
          title={t(`tabColor.${id}`)}
          aria-label={t(`tabColor.${id}`)}
          aria-pressed={paletteHit === id}
          onClick={() => onPick(TAB_COLORS[id])}
        />
      ))}
      <label
        className={`tab-color-swatch box-color-custom${custom ? " is-current" : ""}`}
        style={custom ? { background: custom } : undefined}
        title={t("boxPill.colorCustom")}
      >
        <input
          type="color"
          aria-label={t("boxPill.colorCustom")}
          value={current ?? "#4aa3df"}
          onChange={(e) => onPick(e.currentTarget.value)}
        />
      </label>
    </div>
  );
}
