/**
 * The cockpit's four views — in their own module so `stores/cockpit` (roster,
 * filter and selection state) and `stores/rootOverlay` (which view the shared
 * window shows) can both name them without importing each other.
 */
export type CockpitView = "now" | "projects" | "tonight" | "usage";
export const COCKPIT_VIEWS: readonly CockpitView[] = ["now", "projects", "tonight", "usage"];
