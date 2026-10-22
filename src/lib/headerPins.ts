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

export type HeaderPins = Record<string, boolean>;

/** Is `id` shown in the bar even while the chevron is collapsed? */
export function isHeaderPinned(pins: HeaderPins | undefined, id: HeaderItemId): boolean {
  return pins?.[id] ?? PINNED_BY_DEFAULT.has(id);
}

/** The overrides after flipping `id`. A flip back to the default drops the
 *  entry, so the saved map never holds a value the table already says. */
export function toggleHeaderPin(pins: HeaderPins | undefined, id: HeaderItemId): HeaderPins {
  const next: HeaderPins = { ...pins };
  const pinned = !isHeaderPinned(pins, id);
  if (pinned === PINNED_BY_DEFAULT.has(id)) delete next[id];
  else next[id] = pinned;
  return next;
}
