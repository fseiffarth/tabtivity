/**
 * The view strip's middle group sits on the title bar's centre
 * (`layout/RootViewStrip`). The strip fills the bar between the title and the
 * window controls, which differ in width, so two equal spacers would centre the
 * group between its neighbours instead. This splits the spacers' room so the
 * middle block lands on the bar's centre; where one side has too little room
 * it gets none and the block moves over rather than overlapping.
 *
 * All values are viewport x positions / widths in px. Returns the two spacers'
 * flex-grow weights (their flex-basis is 0, so the weights are their widths).
 */
export interface StripCentreInput {
  barLeft: number;
  barRight: number;
  /** Left edge of the spacer before the middle block. */
  freeLeft: number;
  /** Right edge of the spacer after the middle block. */
  freeRight: number;
  /** The middle block's width (its dividers included). */
  blockWidth: number;
}

export function stripCentreWeights({ barLeft, barRight, freeLeft, freeRight, blockWidth }: StripCentreInput): [number, number] {
  const free = freeRight - freeLeft - blockWidth;
  if (!(free > 0)) return [1, 1];
  const before = (barLeft + barRight) / 2 - blockWidth / 2 - freeLeft;
  const left = Math.min(Math.max(before, 0), free);
  return [left, free - left];
}
