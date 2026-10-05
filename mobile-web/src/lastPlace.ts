import { api, type TabRow } from "./api";
import { storageKey } from "../../src/lib/brand";

/**
 * The key predates sections, when this slot held a bare `{ projectId, tabId }`
 * terminal route; a value in that old shape still reads back as the terminal it
 * named, so an update does not lose the phone's place.
 */
const LAST_PLACE_KEY = storageKey("mobile.lastTab");

/** The tab bar's four sections — App's `Tab`, defined here because this module validates it. */
export const MOBILE_SECTIONS = ["projects", "todo", "calendar", "mail"] as const;
export type MobileSection = (typeof MOBILE_SECTIONS)[number];

/**
 * Where the reader was standing when the app was last put down. A PWA is
 * unlocked and re-authenticated from scratch on every cold open, so without
 * this every return lands on the project list.
 *
 * `projectId`/`tabId` only mean anything under `projects`: the project whose
 * tab list was open, and the terminal open on top of it, if any.
 */
export interface LastPlace {
  section: MobileSection;
  projectId?: string;
  tabId?: string;
}

/** What `restoreLastPlace` resolved that reference to, with the tab re-read from the host. */
export interface RestoredPlace {
  section: MobileSection;
  projectId?: string;
  tab?: TabRow;
}

type LastPlaceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export function isSection(value: unknown): value is MobileSection {
  return MOBILE_SECTIONS.includes(value as MobileSection);
}

/** A place from untrusted input — storage, or a notification's launch URL —
 * checked field by field, or null. */
export function parsePlace(value: unknown): LastPlace | null {
  if (!value || typeof value !== "object") return null;
  const place = value as Partial<LastPlace>;
  // No section at all is the pre-sections shape: a terminal route under Projects.
  const section = place.section === undefined ? "projects" : place.section;
  if (!isSection(section)) return null;
  if (section !== "projects" || !validId(place.projectId)) return { section };
  return validId(place.tabId)
    ? { section, projectId: place.projectId, tabId: place.tabId }
    : { section, projectId: place.projectId };
}

export function readLastPlace(storage?: LastPlaceStorage): LastPlace | null {
  try {
    return parsePlace(JSON.parse((storage ?? localStorage).getItem(LAST_PLACE_KEY) ?? "null"));
  } catch {
    return null;
  }
}

export function rememberLastPlace(place: LastPlace, storage?: LastPlaceStorage): void {
  try {
    (storage ?? localStorage).setItem(LAST_PLACE_KEY, JSON.stringify(place));
  } catch {
    // Storage can be unavailable in a private browser; navigation still works
    // for the current session.
  }
}

export function forgetLastPlace(storage?: LastPlaceStorage): void {
  try {
    (storage ?? localStorage).removeItem(LAST_PLACE_KEY);
  } catch {
    // See rememberLastPlace.
  }
}

/**
 * Resolve the saved place against the host. Only the terminal needs the round
 * trip — a section is the phone's own business, and the tab's label and state
 * must come from the host rather than from a stale copy in storage.
 *
 * A tab that is gone, or that the host cannot answer for right now, degrades to
 * that project's tab list rather than to nothing: the reader still arrives one
 * tap from where they were, and the caller records the narrowed place as it
 * would any other navigation.
 */
export async function restoreLastPlace(): Promise<RestoredPlace | null> {
  const saved = readLastPlace();
  return saved ? resolvePlace(saved) : null;
}

/** `saved`, with its tab re-read from the host — `restoreLastPlace`'s rules,
 * for a place that came from somewhere else (a tapped notification). */
export async function resolvePlace(saved: LastPlace): Promise<RestoredPlace> {
  if (saved.section !== "projects" || !saved.projectId) return { section: saved.section };
  const place: RestoredPlace = { section: "projects", projectId: saved.projectId };
  if (!saved.tabId) return place;
  try {
    const { tab } = await api<{ tab: TabRow }>(`/api/v1/tabs/${encodeURIComponent(saved.tabId)}`);
    return tab.available ? { ...place, tab } : place;
  } catch {
    return place;
  }
}
