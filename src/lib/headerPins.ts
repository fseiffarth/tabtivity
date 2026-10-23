import { MOBILE_HOST_KEY } from "./brand";
import { useSettingsStore } from "../stores/settings";
import type { Settings } from "../types";

/**
 * Which top-bar items stay in the bar and which fold behind the ‹ chevron.
 *
 * Every item a user may place has an id. The default is the bar's old shape:
 * the global apps and menus (✉ 🗓 ☑ 📥 🧠 ?) are pinned, the machine-state
 * readouts (alerts, connection, battery, Mobile, VPN, Machines, CPU/RAM/GPU)
 * fold. `Settings.header_pins` holds only the user's overrides — `true` pins an
 * item, `false` folds it — so an id the user never touched follows this table
 * and a default changed here reaches everyone who did not choose.
 *
 * The one moving default is the phone icon (`headerPinDefaults`).
 *
 * The settings gear is not an id on purpose: it is the way back to every other
 * setting, and a bar that could hide it would need a second way in.
 */
export const HEADER_ITEM_IDS = [
  "mail",
  "calendar",
  "todo",
  "inbox",
  "models",
  "help",
  "alerts",
  "conn",
  "battery",
  "mobile",
  "vpn",
  "machines",
  "resources",
  "devBuild",
] as const;

export type HeaderItemId = (typeof HEADER_ITEM_IDS)[number];

const PINNED_BY_DEFAULT: ReadonlySet<HeaderItemId> = new Set([
  "mail",
  "calendar",
  "todo",
  "inbox",
  "models",
  "help",
]);

/** The table above plus the phone icon, while it is the way into Mobile. */
const PINNED_WITH_MOBILE_NUDGE: ReadonlySet<HeaderItemId> = new Set([...PINNED_BY_DEFAULT, "mobile"]);

/**
 * The defaults in force. Folded, the dimmed phone icon is the door to Mobile
 * that nobody finds, so until Mobile is switched on — or its setup guide has
 * been opened once (`mobile_setup_seen`) — it stays in the bar. Settings not
 * loaded yet count as no nudge: an enabled Mobile must not flash in and out.
 */
export function headerPinDefaults(settings: Settings | null | undefined): ReadonlySet<HeaderItemId> {
  const nudge = settings != null && !settings[MOBILE_HOST_KEY]?.enabled && !settings.mobile_setup_seen;
  return nudge ? PINNED_WITH_MOBILE_NUDGE : PINNED_BY_DEFAULT;
}

/** `headerPinDefaults` for the current settings. */
export function useHeaderPinDefaults(): ReadonlySet<HeaderItemId> {
  return useSettingsStore((s) => headerPinDefaults(s.settings));
}

export type HeaderPins = Record<string, boolean>;

/** Is `id` shown in the bar even while the chevron is collapsed? */
export function isHeaderPinned(
  pins: HeaderPins | undefined,
  id: HeaderItemId,
  defaults: ReadonlySet<HeaderItemId> = PINNED_BY_DEFAULT,
): boolean {
  return pins?.[id] ?? defaults.has(id);
}

/** The overrides after flipping `id`. A flip back to the default drops the
 *  entry, so the saved map never holds a value the table already says. */
export function toggleHeaderPin(
  pins: HeaderPins | undefined,
  id: HeaderItemId,
  defaults: ReadonlySet<HeaderItemId> = PINNED_BY_DEFAULT,
): HeaderPins {
  const next: HeaderPins = { ...pins };
  const pinned = !isHeaderPinned(pins, id, defaults);
  if (pinned === defaults.has(id)) delete next[id];
  else next[id] = pinned;
  return next;
}

/** The places an item may be dragged within. Items never cross groups: the apps
 *  and menus live in `HeaderBar`, the readouts in `StatusCluster`, and the gaps
 *  and the gear between them are what keep the three groups readable. */
export const HEADER_GROUPS = {
  apps: ["mail", "calendar", "todo", "inbox"],
  menus: ["models", "help"],
  status: ["alerts", "conn", "battery", "mobile", "vpn", "machines", "resources", "devBuild"],
} as const satisfies Record<string, readonly HeaderItemId[]>;

export type HeaderGroup = keyof typeof HEADER_GROUPS;

export function headerGroupOf(id: HeaderItemId): HeaderGroup {
  return (Object.keys(HEADER_GROUPS) as HeaderGroup[]).find((g) =>
    (HEADER_GROUPS[g] as readonly HeaderItemId[]).includes(id),
  )!;
}

/** `group`'s ids in the user's saved order. `order` (`Settings.header_order`)
 *  lists ids the user has placed; an id it does not name (a newer build's item)
 *  follows the placed ones in its built-in position. */
export function orderedHeaderIds(group: HeaderGroup, order: readonly string[] | undefined): HeaderItemId[] {
  const ids: readonly HeaderItemId[] = HEADER_GROUPS[group];
  const placed = (order ?? []).filter((id, i, all): id is HeaderItemId =>
    (ids as readonly string[]).includes(id) && all.indexOf(id) === i,
  );
  return [...placed, ...ids.filter((id) => !placed.includes(id))];
}

/** The saved order after moving `id` in front of `beforeId` (`null` → the end of
 *  its group). Other groups' entries are kept as they were. */
export function moveHeaderItem(
  order: readonly string[] | undefined,
  id: HeaderItemId,
  beforeId: HeaderItemId | null,
): string[] {
  const group = headerGroupOf(id);
  const ids = orderedHeaderIds(group, order).filter((x) => x !== id);
  const at = beforeId === null ? ids.length : ids.indexOf(beforeId);
  ids.splice(at < 0 ? ids.length : at, 0, id);
  const members = HEADER_GROUPS[group] as readonly string[];
  return [...(order ?? []).filter((x) => !members.includes(x)), ...ids];
}

/** The saved order with `group`'s entries dropped (back to the built-in order). */
export function resetHeaderGroup(order: readonly string[] | undefined, group: HeaderGroup): string[] {
  const members = HEADER_GROUPS[group] as readonly string[];
  return (order ?? []).filter((x) => !members.includes(x));
}
