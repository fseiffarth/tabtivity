/**
 * A stable colour per project box. Every place a box appears — its pill in the
 * row's leading segment, the swatch on each member's project pill, the rows of
 * the chip's dropdown and of a pill's Boxes menu — wears the same colour, so a
 * box is recognised by colour before it is read by name, and a member pill's
 * swatch answers "which box" without a tooltip.
 *
 * Hashed from the box's **id**, not its name: renaming a box must not recolour
 * it (the colour is what the eye has learned), and two boxes with the same
 * name still tell apart. Same hue/saturation/lightness recipe as
 * `categoryColor`, so box colours and category colours sit in one family and
 * stay legible on both light and dark headers.
 *
 * A colour the user picked (the box pill menu's Colour row) wins over the
 * hash. It is stored on the box as a `#rrggbb` string and validated here, at
 * the one place it turns into CSS: anything else in `boxes.json` (a hand edit,
 * a newer build's shape) reads as "no colour" and falls back to the hash,
 * never as a CSS value to render.
 */
import type { ProjectBox } from "../../types";
import { hashString } from "./categoryColor";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Whether `value` is a storable box colour (`#rrggbb`). */
export function isBoxColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** The colour a box is drawn in when the user has not picked one. */
export function autoBoxColor(boxId: string): string {
  // The djb2 hash of short, similar ids (ULIDs, uuids sharing a prefix) lands
  // on nearby hues; spreading by the golden angle keeps neighbours apart.
  const hue = Math.round((hashString(boxId) * 137.508) % 360);
  return `hsl(${hue} 62% 58%)`;
}

export function boxColor(box: Pick<ProjectBox, "id" | "color">): string {
  return isBoxColor(box.color) ? box.color : autoBoxColor(box.id);
}

/**
 * The dot colour of a box *member* (a project): hashed from the project's id in
 * the same hue space as the boxes', so a member wears one colour wherever it is
 * named in a box (tab chip, "+" fly-out, side-panel header, phone). Members are
 * always round dots and boxes rounded squares, so the shared space never makes
 * the two read alike. Not user-pickable: there is nothing to store.
 */
export function memberColor(projectId: string): string {
  return autoBoxColor(projectId);
}
