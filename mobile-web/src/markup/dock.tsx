/**
 * The markup dock's six slots as both views draw them — the desktop's
 * `PdfMarkupDock` and the phone's palette (`MarkupView`): each slot's icon
 * and name, the eraser's and the lasso's modes, and the Proof slot's marks
 * (`docs/markup_notes_style_plan.md`). Pure drawing and keys, no state.
 */
import type { ReactNode } from "react";
import type { TranslationKey } from "../../../src/lib/i18n";
import type { DockTool, EraserMode, LassoMode, ProofPick } from "./pen";

export const DOCK_LABEL_KEYS: Record<DockTool, TranslationKey> = {
  ink: "mobile.markup.tool.ink",
  highlight: "mobile.markup.tool.highlight",
  eraser: "mobile.markup.tool.eraser",
  select: "mobile.markup.tool.lasso",
  text: "mobile.markup.tool.text",
  proof: "mobile.markup.tool.proof",
};

export const ERASER_MODE_KEYS: Record<EraserMode, TranslationKey> = {
  stroke: "mobile.markup.eraser.stroke",
  partial: "mobile.markup.eraser.partial",
  area: "mobile.markup.eraser.areaShort",
};

export const LASSO_KEYS: Record<LassoMode, TranslationKey> = { free: "mobile.markup.lasso.free", rect: "mobile.markup.lasso.rect" };

const PROOF_KEYS: Record<ProofPick, TranslationKey> = {
  box: "mobile.markup.proof.box",
  strike: "mobile.markup.textMark.strike",
  underline: "mobile.markup.textMark.underline",
  highlight: "mobile.markup.textMark.highlight",
  insert: "mobile.markup.stamp.insert",
  delete: "mobile.markup.stamp.delete",
  paragraph: "mobile.markup.stamp.paragraph",
  swap: "mobile.markup.stamp.swap",
};

/** A proofreading mark's name. */
export function proofKey(pick: ProofPick): TranslationKey {
  return PROOF_KEYS[pick];
}

/** A proofreading mark's glyph: the box, "ab" for the text marks (the caller
 * strikes, underlines or highlights it), or the stamp's symbol. */
export const PROOF_GLYPHS: Record<ProofPick, string> = {
  box: "▭",
  strike: "ab",
  underline: "ab",
  highlight: "ab",
  insert: "⁁",
  delete: "✕",
  paragraph: "¶",
  swap: "⇄",
};

const PATHS: Record<DockTool, ReactNode> = {
  ink: <><path d="M4 20l1-4L16 5l3 3L8 19z" /><path d="M14 7l3 3" /></>,
  highlight: <><path d="M9 14l7-7 3 3-7 7" /><path d="M9 14l-2 2 3 3 2-2" /><path d="M7 16l-3 3h4" /><path d="M13 21h7" strokeWidth="3" /></>,
  eraser: <><path d="M15 4l5 5-9 9H7l-3-3z" /><path d="M9 10l5 5" /><path d="M11 20h9" /></>,
  select: <><ellipse cx="12" cy="10" rx="8" ry="5.5" strokeDasharray="3 2.6" /><path d="M7 14.5c-1.5 2-.5 4.5 2 5" /></>,
  text: <><path d="M5 7V5h14v2" /><path d="M12 5v14" /><path d="M9 19h6" /></>,
  proof: <><path d="M5 19l5-9 5 9" /><path d="M3 6h9" /><path d="M16 4l5 5M21 4l-5 5" /></>,
};

/** A dock slot's icon, stroke-drawn so it takes the text colour. */
export function DockIcon({ tool, size = 18 }: { tool: DockTool; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[tool]}
    </svg>
  );
}
