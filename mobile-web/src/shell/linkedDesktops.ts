/**
 * The desktop switcher's list (`docs/phone_multi_desktop_plan.md`, Phase 3):
 * the other desktops the home — the desktop this phone app was installed
 * from — is linked with, as the home's `/api/v1/status` names them
 * (`linked_desktops: [{origin}]`), and which one is on screen.
 *
 * Cached in this phone's own storage, so a home that is down still opens the
 * switcher: the cached shell frames another desktop without the home's help.
 * Every origin is checked here as well as by the home's sidecar (`linked.rs`):
 * one exact `https://<machine>.<tailnet>.ts.net[:port]` origin in this page's
 * own tailnet, never this page's own origin, at most eight. Anything else —
 * another scheme, a path, another tailnet, a `*.c.ts.net` name, a shape this
 * build does not know — is dropped, never shown or framed.
 *
 * A small external store (`useSyncExternalStore`): the home's status refresh
 * (`App`) writes it, a framed desktop's `ready` names a row, the shell reads it.
 */
import { MAX_LINKED_DESKTOPS, normalizeOrigin, tailnetOf } from "../../../src/lib/linkedDesktops";
import { storageDashKey } from "../../../src/lib/brand";

export interface LinkedDesktop {
  origin: string;
  /** The desktop's own name, as its framed page last said (`ready`). */
  name?: string;
  /** Whether its framed page last said it reached its desktop. */
  available?: boolean;
}

export interface LinkedState {
  desktops: readonly LinkedDesktop[];
  /** The home's own name (`status.host`), for its row in the picker. */
  homeName?: string;
  /** The framed desktop on screen; null is the home. Always a listed origin. */
  selected: string | null;
}

const KEY = storageDashKey("linked-desktops");
const NAME_MAX = 64;
const EMPTY: LinkedState = { desktops: [], selected: null };

/** A display name from a desktop (its status or its frame): trimmed, bounded. */
function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().slice(0, NAME_MAX);
  return name || undefined;
}

/** `raw` as a listed desktop's origin, or null when it may not be one. */
export function linkedOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const origin = normalizeOrigin(raw);
  if (!origin) return null;
  const theirs = tailnetOf(origin);
  if (!theirs) return null;
  let own: string | null = null;
  try {
    own = normalizeOrigin(window.location.origin);
  } catch {
    return null;
  }
  // Only this page's own tailnet: the same site, where the frame's session
  // cookie is sent at all (`SameSite=Strict`).
  if (!own || origin === own || tailnetOf(own) !== theirs) return null;
  return origin;
}

/** The first DNS label of `origin`'s host: a desktop's name before it says one. */
export function firstLabel(origin: string): string {
  try {
    return new URL(origin).hostname.split(".")[0] || origin;
  } catch {
    return origin;
  }
}

/** The listed rows of `entries`: valid, distinct, at most eight; names kept from `known`. */
function cleanList(entries: unknown, known: readonly LinkedDesktop[] = []): LinkedDesktop[] {
  if (!Array.isArray(entries)) return [];
  const out: LinkedDesktop[] = [];
  for (const entry of entries) {
    if (out.length >= MAX_LINKED_DESKTOPS) break;
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const origin = linkedOrigin(record.origin);
    if (!origin || out.some((row) => row.origin === origin)) continue;
    const before = known.find((row) => row.origin === origin);
    const name = cleanName(record.name) ?? before?.name;
    const available = typeof record.available === "boolean" ? record.available : before?.available;
    out.push({ origin, ...(name ? { name } : {}), ...(available !== undefined ? { available } : {}) });
  }
  return out;
}

function parse(raw: string | null): LinkedState {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object") return EMPTY;
    const desktops = cleanList(value.desktops);
    const selected = desktops.find((row) => row.origin === value.selected)?.origin ?? null;
    const homeName = cleanName(value.homeName);
    return { desktops, selected, ...(homeName ? { homeName } : {}) };
  } catch {
    return EMPTY;
  }
}

let state: LinkedState | null = null;
const listeners = new Set<() => void>();

function current(): LinkedState {
  if (state) return state;
  try {
    state = parse(localStorage.getItem(KEY));
  } catch {
    state = EMPTY;
  }
  return state;
}

function commit(next: LinkedState) {
  state = next;
  try {
    if (next.desktops.length === 0 && !next.homeName) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage refused (private mode): the switcher still works for this page.
  }
  for (const listener of listeners) listener();
}

export function linkedSnapshot(): LinkedState {
  return current();
}

export function subscribeLinked(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The home's status answer: its list and its name. A desktop no longer
 * listed is no longer on screen either. An older home sends no list: none. */
export function noteHomeStatus(status: { linked_desktops?: unknown; host?: unknown }): void {
  const before = current();
  const desktops = cleanList(status.linked_desktops, before.desktops);
  const homeName = cleanName(status.host) ?? before.homeName;
  const selected = desktops.some((row) => row.origin === before.selected) ? before.selected : null;
  const next: LinkedState = { desktops, selected, ...(homeName ? { homeName } : {}) };
  if (JSON.stringify(next) !== JSON.stringify(before)) commit(next);
}

/** A framed desktop's `ready`: its name and whether it reached its desktop. */
export function noteDesktopReady(origin: string, name: unknown, available: boolean): void {
  const before = current();
  const clean = cleanName(name);
  let changed = false;
  const desktops = before.desktops.map((row) => {
    if (row.origin !== origin) return row;
    const next = { ...row, ...(clean ? { name: clean } : {}), available };
    changed = next.name !== row.name || next.available !== row.available;
    return next;
  });
  if (changed) commit({ ...before, desktops });
}

/** Put `origin` on screen (null: the home). An unlisted origin is refused. */
export function selectDesktop(origin: string | null): void {
  const before = current();
  const selected = origin !== null && before.desktops.some((row) => row.origin === origin) ? origin : null;
  if (selected !== before.selected) commit({ ...before, selected });
}

/** Everything above, gone (`forgetDeviceData`): a phone the home forgot. */
export function forgetLinkedDesktops(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // unavailable
  }
  state = EMPTY;
  for (const listener of listeners) listener();
}

/** Test hook: read the cache afresh on the next access. */
export function resetLinkedDesktopsForTests(): void {
  state = null;
}
