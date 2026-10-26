/**
 * The deck-wide index of TeX figures — every image object with a `texSrc`,
 * across every slide, in one clickable list.
 *
 * Exists because double-clicking a figure on the stage only reaches whichever
 * one is on the CURRENT slide. A talk with a dozen formulas scattered across
 * a dozen slides otherwise has no way to find "the TeX behind slide 7's second
 * figure" without hunting for it first — this mode is that hunt, done once.
 */

import type { Deck, ImageObject } from "../../../lib/viewers/deck/model";
import { useT } from "../../../lib/i18n";
import { basename } from "../../../lib/paths";

export interface TexFigureEntry {
  slideIndex: number;
  obj: ImageObject & { texSrc: string };
}

/** Every TeX-figure object in the deck, in slide order. */
export function texFigures(deck: Deck): TexFigureEntry[] {
  const out: TexFigureEntry[] = [];
  deck.slides.forEach((s, slideIndex) => {
    for (const o of s.objects) {
      if (o.kind === "image" && o.texSrc) out.push({ slideIndex, obj: o as ImageObject & { texSrc: string } });
    }
  });
  return out;
}

export interface DeckTexPanelProps {
  deck: Deck;
  /** Select this slide + object on the stage, without leaving TeX mode. */
  onJump: (slideIndex: number, objectId: string) => void;
  onEditTex: (obj: ImageObject) => void;
  onRecompileTex: (obj: ImageObject) => void;
  texBusyIds?: ReadonlySet<string>;
}

export function DeckTexPanel({ deck, onJump, onEditTex, onRecompileTex, texBusyIds }: DeckTexPanelProps) {
  const t = useT();
  const entries = texFigures(deck);

  return (
    <div className="deck-inspector deck-tex-panel">
      <div className="deck-inspector-head">{t("deckTexPanel.title")}</div>
      {entries.length === 0 ? (
        <p className="deck-inspector-empty">{t("deckTexPanel.empty")}</p>
      ) : (
        <ul className="deck-tex-list">
          {entries.map(({ slideIndex, obj }) => (
            <li key={obj.id} className="deck-tex-list-item">
              <button
                className="deck-tex-list-jump"
                onClick={() => onJump(slideIndex, obj.id)}
                title={obj.texSrc}
              >
                <span className="deck-tex-list-slide">
                  {t("deckTexPanel.slideLabel", { n: slideIndex + 1 })}
                </span>
                <span className="deck-tex-list-name">{basename(obj.texSrc)}</span>
              </button>
              <div className="deck-tex-list-actions">
                <button
                  className="deck-inspector-btn"
                  disabled={texBusyIds?.has(obj.id)}
                  onClick={() => onEditTex(obj)}
                >
                  {t("deckTexPanel.editBtn")}
                </button>
                <button
                  className="deck-inspector-btn"
                  disabled={texBusyIds?.has(obj.id)}
                  onClick={() => onRecompileTex(obj)}
                >
                  {texBusyIds?.has(obj.id) ? t("deckTexPanel.compiling") : t("deckTexPanel.recompile")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
