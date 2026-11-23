import type { TabRow } from "./api";
import type { Tier } from "./useTier";

/**
 * The pure half of the tabs rail beside a tablet's chat (`ChatTabsRail`):
 * when it is offered, what `main`'s `data-rail` says, and when a fresh read of
 * the project's tabs changes nothing the rail draws.
 */

/** From this window width the rail may stand unfolded; narrower, it is always
 * folded to its tiles (the stored preference is left alone). Only the script
 * reads it: the stylesheet keys off `data-rail`, which already says "folded". */
export const RAIL_WIDE_QUERY = "(min-width:1120px)";

/** The rail (landscape) or the strip (portrait) is offered: a tab inside a
 * project — not Tabby's chat, which has none — whose project has two tabs or
 * more. With one tab there is nothing to switch to. */
export function railOffered(project: string | undefined, tabs: readonly TabRow[] | null): boolean {
  return !!project && (tabs?.length ?? 0) >= 2;
}

/** `main`'s `data-rail`: the landscape rail open or folded, the portrait strip,
 * or nothing (a phone, or nothing offered). */
export type RailLayout = "open" | "folded" | "strip";

export function railLayout(tier: Tier, offered: boolean, folded: boolean): RailLayout | undefined {
  if (!offered || tier === "phone") return undefined;
  if (tier === "tablet") return "strip";
  return folded ? "folded" : "open";
}

/** The fields a rail row or a strip chip draws. */
const DRAWN: readonly (keyof TabRow)[] = ["id", "label", "kind", "agent_label", "agent_status", "agent_model", "agent_plan", "agent_goal", "available", "color", "done_at"];

/** The two lists draw the same: same tabs, same order, same drawn fields. A
 * poll that changed nothing the rail shows then keeps the old array, so the
 * chat does not draw again every five seconds. */
export function sameRailTabs(a: readonly TabRow[] | null, b: readonly TabRow[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((row, index) => DRAWN.every((key) => row[key] === b[index][key]));
}

/** The last list read per project, so the chat a rail tap opens (`App.tsx`
 * re-keys the screen) draws its rail at once instead of after its first read —
 * the columns would otherwise jump on every switch. In memory only. */
const lastTabs = new Map<string, readonly TabRow[]>();

export function rememberedRailTabs(project: string | undefined): readonly TabRow[] | null {
  return project ? lastTabs.get(project) ?? null : null;
}

export function rememberRailTabs(project: string, tabs: readonly TabRow[]): void {
  lastTabs.set(project, tabs);
}
