/**
 * Linked desktops, the desktop's add check (`docs/phone_multi_desktop_plan.md`,
 * Phase 2). Mirrors `src-tauri/src/services/mobile_control/linked.rs`
 * `validate_linked_origin` so Settings → Mobile can say *why* an address is
 * refused; the sidecar re-validates every entry on every request and stays the
 * authority (an entry this check let through but the sidecar drops is simply
 * not linked).
 */

/** At most this many linked desktops (`linked::MAX_LINKED`). */
export const MAX_LINKED_DESKTOPS = 8;

/** Why an address cannot be added — the sidecar's three codes plus the list's own. */
export type LinkRefusal = "invalid_origin" | "not_same_tailnet" | "own_origin" | "already_linked" | "limit";

/** `raw` as one exact `https://host[:port]` origin (`config::validate_origin`),
 *  or null: no path, credentials, query or fragment; the default port dropped. */
export function normalizeOrigin(raw: string): string | null {
  const text = raw.trim();
  // `URL` reads a bare `?` / `#` as empty; the sidecar's parser keeps them.
  if (text.includes("?") || text.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.pathname !== "/") return null;
  return `https://${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`;
}

/** `<tailnet>.ts.net` when `origin`'s host is exactly `<machine>.<tailnet>.ts.net`
 *  and not under the `*.c.ts.net` suffix (another site). */
export function tailnetOf(origin: string): string | null {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split(".");
  if (labels.length !== 4 || labels[2] !== "ts" || labels[3] !== "net") return null;
  const [machine, tailnet] = labels;
  if (!machine || !tailnet || tailnet === "c") return null;
  return `${tailnet}.ts.net`;
}

/** May this desktop (its saved Serve origin `own`) add `raw` to `list`? */
export function validateLinkedOrigin(
  own: string | undefined,
  raw: string,
  list: readonly string[],
): { ok: true; origin: string } | { ok: false; reason: LinkRefusal } {
  const origin = normalizeOrigin(raw);
  if (!origin) return { ok: false, reason: "invalid_origin" };
  const ownOrigin = own ? normalizeOrigin(own) : null;
  const theirs = tailnetOf(origin);
  if (!theirs || !ownOrigin || tailnetOf(ownOrigin) !== theirs) return { ok: false, reason: "not_same_tailnet" };
  if (origin === ownOrigin) return { ok: false, reason: "own_origin" };
  if (list.some((entry) => normalizeOrigin(entry) === origin)) return { ok: false, reason: "already_linked" };
  if (list.length >= MAX_LINKED_DESKTOPS) return { ok: false, reason: "limit" };
  return { ok: true, origin };
}

/** Can this desktop link at all: its saved Serve origin is a `ts.net` machine name? */
export function canLink(own: string | undefined): boolean {
  const ownOrigin = own ? normalizeOrigin(own) : null;
  return ownOrigin !== null && tailnetOf(ownOrigin) !== null;
}
