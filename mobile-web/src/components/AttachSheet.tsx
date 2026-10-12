import type { ReactNode } from "react";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";

export interface AttachTile {
  key: string;
  label: string;
  /** What the tile adds, in a sentence: the tile's tooltip. */
  hint: string;
  /** Picks the tile's colour (`.attach-tile-<tone>`). */
  tone: "camera" | "gallery" | "files" | "desktop" | "project";
  icon: ReactNode;
  /** Its row in the untested register (`src/lib/untested.ts`). */
  untested?: string;
}

/**
 * The composer's ＋, as a messenger's attach tray: a row of round, coloured
 * icon tiles with a short name under each, instead of a list to read. It wears
 * the shared sheet (`.option-sheet`) and reports the tapped tile.
 */
export function AttachSheet({ title, tiles, onPick, onClose }: {
  title: string;
  tiles: AttachTile[];
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet attach-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("common.close")}>✕</button>
        <h2>{title}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      <ul className="attach-grid">{tiles.map((tile) => <li key={tile.key}>
        <button className={`attach-tile attach-tile-${tile.tone}`} title={tile.hint} onClick={() => onPick(tile.key)}>
          <span className="attach-icon" aria-hidden="true">{tile.icon}</span>
          <span className="attach-label">{tile.label}</span>
          {tile.untested && isUntested(tile.untested) && <span className="untested">{t("mobile.newTab.untested")}</span>}
        </button>
      </li>)}</ul>
    </section>
  </div>;
}
