/**
 * The zoom that fits a page into a viewport of `availW` × `availH` CSS px.
 *
 * Fit width is the rule. The exception is a landscape page (a slide): at the
 * viewport's width it is often taller than the viewport, so its bottom is off
 * screen — there `wholePage` fits the page as a whole instead. A portrait page
 * is always fitted by width (an A4 sheet would otherwise shrink to a strip).
 * `fitsPage` says which of the two the returned scale is.
 */
export function pdfFitScale(
  availW: number,
  availH: number,
  pageW: number,
  pageH: number,
  wholePage: boolean,
): { scale: number; fitsPage: boolean } {
  const byWidth = availW / pageW;
  if (!wholePage || !(pageW > pageH) || !(availH > 0) || !(pageH > 0)) {
    return { scale: byWidth, fitsPage: false };
  }
  const byHeight = availH / pageH;
  return byHeight < byWidth ? { scale: byHeight, fitsPage: true } : { scale: byWidth, fitsPage: false };
}
