import { readFlag, writeFlag } from "./prefs";
import type { Tier } from "./useTier";

/** How Home's project list is drawn: one row per project, two tiles a line, or
 * each box folding its member projects under it. Remembered on this phone;
 * `projectsGrid` predates the box layout and still says grid. */
export type HomeLayout = "list" | "grid" | "boxes";

type FlagStore = Parameters<typeof readFlag>[2];

/** Whether the reader ever picked a layout on this phone. Both flags are
 * written on every pick (`writeLayout`), so an unset one means "never": a
 * flag that reads differently under the two fallbacks is unset. */
function isSet(name: "projectsGrid" | "projectsBoxes", storage?: FlagStore): boolean {
  return readFlag(name, true, storage) === readFlag(name, false, storage);
}

/** The layout the reader chose, or null when they never did. */
export function readChosenLayout(storage?: FlagStore): HomeLayout | null {
  if (!isSet("projectsGrid", storage) && !isSet("projectsBoxes", storage)) return null;
  return readFlag("projectsBoxes", false, storage) ? "boxes" : readFlag("projectsGrid", false, storage) ? "grid" : "list";
}

export function writeLayout(layout: HomeLayout, storage?: FlagStore): void {
  writeFlag("projectsGrid", layout === "grid", storage);
  writeFlag("projectsBoxes", layout === "boxes", storage);
}

/**
 * The layout Home draws now. A stored choice wins on a phone and in the
 * portrait tablet tier; the choice is never overwritten here. With none, a
 * phone gets the list it always had and a tablet in portrait the two-column
 * grid. In the split tier the left column is a narrow list whatever was
 * chosen: the choice is kept and applies again when the screen turns.
 */
export function effectiveLayout(chosen: HomeLayout | null, tier: Tier): HomeLayout {
  if (tier === "split") return "list";
  return chosen ?? (tier === "tablet" ? "grid" : "list");
}
