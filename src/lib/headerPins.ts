import { MOBILE_HOST_KEY } from "./brand";
import { useSettingsStore } from "../stores/settings";
import type { Settings } from "../types";

/**
 * Which top-bar items stay in the bar and which fold behind the ‹ chevron.
 *
 * Every item a user may place has an id. By default the global apps and menus
 * (✉ 🗓 ☑ 📥 🧠 ?) and the VPN and Machines menus are pinned; the other
 * machine-state readouts (alerts, connection, battery, Mobile, CPU/RAM/GPU)
 * fold. `Settings.header_pins` holds only the user's overrides — `true` pins an
 * item, `false` folds it — so an id the user never touched follows this table
 * and a default changed here reaches everyone who did not choose.
 *
 * The one moving default is the phone icon (`headerPinDefaults`).
 *
 * The settings gear is an id so it can be dragged among the other icons, but it
 * is always pinned: it is the way back to every other setting, and a bar that
 * could hide it would need a second way in.
 */
export const HEADER_ITEM_IDS = [
  "mail",
  "calendar",
  "todo",
  "inbox",
  "models",
  "help",
  "settings",
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
  "vpn",
  "machines",
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
  if (id === "settings") return true;
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

/** The two places an item may sit: `apps` is the bar's own run (always shown),
 *  `status` the cluster that ends in the ‹ chevron (pinned ones shown, the rest
 *  folded). An item's built-in place is the group listed here; a drag across
 *  the boundary moves it to the other one. */
export const HEADER_GROUPS = {
  apps: ["mail", "calendar", "todo", "inbox", "models", "help", "settings"],
  status: ["alerts", "conn", "battery", "mobile", "vpn", "machines", "resources", "devBuild"],
} as const satisfies Record<string, readonly HeaderItemId[]>;

export type HeaderGroup = keyof typeof HEADER_GROUPS;

/** The group an item belongs to until the user drags it across. */
export function headerGroupOf(id: HeaderItemId): HeaderGroup {
  return (Object.keys(HEADER_GROUPS) as HeaderGroup[]).find((g) =>
    (HEADER_GROUPS[g] as readonly HeaderItemId[]).includes(id),
  )!;
}

interface Placed {
  id: HeaderItemId;
  group: HeaderGroup;
}

/** `Settings.header_order` entries are an id (placed in its built-in group) or
 *  `<group>:<id>` (placed in the other one). Unknown and repeated ids drop. */
function parseOrder(order: readonly string[] | undefined): Placed[] {
  const seen = new Set<string>();
  const out: Placed[] = [];
  for (const raw of order ?? []) {
    const m = /^(apps|status):(.+)$/.exec(raw);
    const id = (m ? m[2] : raw) as HeaderItemId;
    if (!(HEADER_ITEM_IDS as readonly string[]).includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, group: m ? (m[1] as HeaderGroup) : headerGroupOf(id) });
  }
  return out;
}

function encodePlaced({ id, group }: Placed): string {
  return group === headerGroupOf(id) ? id : `${group}:${id}`;
}

/** The group `id` is drawn in under the saved order. */
export function placedGroupOf(id: HeaderItemId, order: readonly string[] | undefined): HeaderGroup {
  return parseOrder(order).find((p) => p.id === id)?.group ?? headerGroupOf(id);
}

/** `group`'s ids in the user's saved order. `order` (`Settings.header_order`)
 *  lists ids the user has placed; an id it does not name (a newer build's item)
 *  follows the placed ones in its built-in position. */
export function orderedHeaderIds(group: HeaderGroup, order: readonly string[] | undefined): HeaderItemId[] {
  const parsed = parseOrder(order);
  const named = new Set(parsed.map((p) => p.id));
  const ids: readonly HeaderItemId[] = HEADER_GROUPS[group];
  return [
    ...parsed.filter((p) => p.group === group).map((p) => p.id),
    ...ids.filter((id) => !named.has(id)),
  ];
}

/** The saved order after moving `id` into `group`, in front of `beforeId`
 *  (`null`, or one not in that group → the end of it). Other groups' entries are
 *  kept as they were. */
export function moveHeaderItem(
  order: readonly string[] | undefined,
  id: HeaderItemId,
  beforeId: HeaderItemId | null,
  group: HeaderGroup = placedGroupOf(id, order),
): string[] {
  const ids = orderedHeaderIds(group, order).filter((x) => x !== id);
  const at = beforeId === null ? ids.length : ids.indexOf(beforeId);
  ids.splice(at < 0 ? ids.length : at, 0, id);
  const kept = parseOrder(order).filter((p) => p.group !== group && p.id !== id);
  return [...kept.map(encodePlaced), ...ids.map((x) => encodePlaced({ id: x, group }))];
}

/** The saved order with everything that belongs to `group` — built in or dragged
 *  into it — dropped (back to the built-in order). */
export function resetHeaderGroup(order: readonly string[] | undefined, group: HeaderGroup): string[] {
  return parseOrder(order)
    .filter((p) => p.group !== group && headerGroupOf(p.id) !== group)
    .map(encodePlaced);
}

/** The overrides after pinning (`true`) or folding (`false`) `id`; unchanged
 *  when it is already so. */
export function setHeaderPin(
  pins: HeaderPins | undefined,
  id: HeaderItemId,
  pinned: boolean,
  defaults: ReadonlySet<HeaderItemId> = PINNED_BY_DEFAULT,
): HeaderPins {
  return isHeaderPinned(pins, id, defaults) === pinned ? { ...pins } : toggleHeaderPin(pins, id, defaults);
}
