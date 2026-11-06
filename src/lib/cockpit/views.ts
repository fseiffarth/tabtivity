/**
 * The console window's views — in their own module so `stores/cockpit` (roster,
 * filter and selection state) and `stores/rootOverlay` (which view the shared
 * window shows) can both name them without importing each other.
 *
 * Eleven views in four groups (`VIEW_GROUPS`): the cockpit's own three, the
 * cross-project apps (mail, calendar, to-do), the machine's system pages
 * (agents, models, machines) and Root, the root console proper. Only the shown
 * one is mounted (mail's unsent composers excepted, `MailView`).
 */
export type CockpitView = "now" | "projects" | "tonight";
export const COCKPIT_VIEWS: readonly CockpitView[] = ["now", "projects", "tonight"];

/** The cross-project apps and system pages that used to float as overlays of
 *  their own and are views of the one window now. */
export type AppView = "mail" | "calendar" | "todo" | "agents" | "models" | "machines";
export const APP_VIEWS: readonly AppView[] = ["mail", "calendar", "todo", "agents", "models", "machines"];

/** Every view but Root. */
export type ConsoleView = CockpitView | AppView;

/** What the shared window shows: Root, or one of the others. */
export type WindowView = "root" | ConsoleView;

/** The title bar's strip, left to right; a divider sits between groups. */
export const VIEW_GROUPS: readonly (readonly WindowView[])[] = [
  ["now", "projects", "tonight"],
  ["mail", "calendar", "todo"],
  ["agents", "models", "machines"],
  ["root"],
];

export function isAppView(view: WindowView): view is AppView {
  return (APP_VIEWS as readonly string[]).includes(view);
}

export function isCockpitView(view: WindowView): view is CockpitView {
  return (COCKPIT_VIEWS as readonly string[]).includes(view);
}
