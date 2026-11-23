import { proseWord, type PdfWordPhrase } from "../../../lib/viewers/tex/reverseWord";
import { TEXT_LAYER_CLASS } from "./textSelection";

/** Measure the actual laid-out letters, including proportional advances, zoom
 * and page rotation. Hit testing the stack also works through a link overlay. */
export function clickedPdfWord(page: HTMLElement, x: number, y: number): PdfWordPhrase | undefined {
  const layer = page.querySelector(`.${TEXT_LAYER_CLASS}`);
  if (!layer) return;
  const span = document.elementsFromPoint?.(x, y).find(el =>
    el.matches('span[role="presentation"]') && layer.contains(el));
  const node = span?.firstChild;
  if (!span || node?.nodeType !== Node.TEXT_NODE) return;
  const range = document.createRange();
  const localWord = Array.from((node.textContent ?? "").matchAll(proseWord)).find(m => {
    range.setStart(node, m.index);
    range.setEnd(node, m.index + m[0].length);
    return Array.from(range.getClientRects()).some(r => x >= r.left && x < r.right && y >= r.top && y < r.bottom);
  });
  if (!localWord) return;

  // pdf.js emits explicit spaces and line breaks. A kern/font change can
  // split one word across spans, and TeX can hyphenate it across output rows.
  let text = "";
  let offset = -1;
  for (const run of layer.querySelectorAll('span[role="presentation"], br')) {
    if (run === span) offset = text.length + localWord.index;
    if (run.tagName === "BR") {
      text = /[-\u2010\u00ad]$/.test(text) ? text.slice(0, -1) : text + " ";
    } else {
      text += run.textContent ?? "";
    }
  }
  const tokens = Array.from(text.matchAll(proseWord));
  const hit = tokens.findIndex(m => m.index <= offset && offset < m.index + m[0].length);
  if (hit < 0) return;
  const start = Math.max(0, hit - 12);
  return { words: tokens.slice(start, hit + 13).map(m => m[0]), index: hit - start };
}
