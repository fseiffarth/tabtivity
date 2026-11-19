/**
 * The command palette's door (`layout/CommandPalette` listens): a window event
 * any menu, chord or hook fires without importing the component.
 */

/** Opens the palette; a `CustomEvent` detail of `{ filter: "#" }` opens it on
 *  that filter. Every door (the chord, Quick open's chord, the menus) fires this. */
export const OPEN_PALETTE_EVENT = "app:open-palette";

/** The palette narrowed to the active project's files (Quick open). */
export const FILE_FILTER = "#";
/** The palette narrowed to tabs: the tab search. */
export const TAB_FILTER = "@";

/** Open the palette, on `filter` when given. */
export function openPalette(filter?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: filter ? { filter } : undefined }));
}

/** Open the palette as the tab search. */
export function openTabSearch() {
  openPalette(TAB_FILTER);
}
