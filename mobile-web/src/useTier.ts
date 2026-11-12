import { useMediaQuery } from "./useMediaQuery";

/**
 * The tablet tiers of the phone app, in one place. A phone (anything else)
 * keeps the layout it always had; these two only switch rules on.
 *
 * - `TABLET_QUERY`: an iPad in portrait (744-834px wide) and up. The height
 *   guard keeps a phone turned on its side (844x390) a phone.
 * - `SPLIT_QUERY`: a tablet in landscape that is wide enough for Home's
 *   project list to stay beside the chosen project. It implies the tablet tier.
 *
 * The stylesheet cannot read these, so `style.css` spells the same two
 * queries in its one `Tablet tiers` block; `MobileTablet.test.ts` fails when
 * the two drift apart.
 */
export const TABLET_QUERY = "(min-width:700px) and (min-height:600px)";
export const SPLIT_QUERY = "(min-width:1000px) and (min-height:600px) and (orientation:landscape)";

export type Tier = "phone" | "tablet" | "split";

/** Which tier the window is in now, kept current as the screen turns or the
 * window is resized (Split View, Stage Manager). `phone` where there is no
 * `matchMedia` (tests, an old webview). */
export function useTier(): Tier {
  const tablet = useMediaQuery(TABLET_QUERY);
  const split = useMediaQuery(SPLIT_QUERY);
  return split ? "split" : tablet ? "tablet" : "phone";
}
