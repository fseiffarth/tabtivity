import { BRAND } from "../brand";

/** Navigation only: these targets never carry commands, paths or setting values. */
export type AppLink =
  | { kind: "settings"; page: string; setting?: string }
  | { kind: "project"; id: string }
  | { kind: "tab"; scope: string; id: string };

export const APP_LINK_SCHEME = `${BRAND.slug}://`;
const SEGMENT = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,255}$/;
// Box scopes (`box:<id>`) and tab keys can contain colons. They remain one
// decoded identifier, never a filesystem path or another URL.
const ID_SEGMENT = /^[a-zA-Z0-9_-][a-zA-Z0-9_.:-]{0,255}$/;

export function isAppLink(raw: string): boolean {
  return raw.trim().toLowerCase().startsWith(`${BRAND.slug}:`);
}

/** Parse the authored string, without URL normalization hiding traversal or controls. */
export function parseAppLink(raw: string | null | undefined): AppLink | null {
  if (!raw || raw.length > 1024 || !raw.startsWith(APP_LINK_SCHEME)) return null;
  const [kind, ...encoded] = raw.slice(APP_LINK_SCHEME.length).split("/");
  let parts: string[];
  try {
    parts = encoded.map(decodeURIComponent);
  } catch {
    return null;
  }
  const segment = kind === "settings" ? SEGMENT : ID_SEGMENT;
  if (!parts.every((part) => segment.test(part))) return null;
  if (kind === "settings" && (parts.length === 1 || parts.length === 2)) {
    return { kind, page: parts[0], ...(parts[1] ? { setting: parts[1] } : {}) };
  }
  if (kind === "project" && parts.length === 1) return { kind, id: parts[0] };
  if (kind === "tab" && parts.length === 2) return { kind, scope: parts[0], id: parts[1] };
  return null;
}

export function formatAppLink(target: AppLink): string {
  const parts = target.kind === "settings" ? [target.page, ...(target.setting ? [target.setting] : [])]
    : target.kind === "tab" ? [target.scope, target.id] : [target.id];
  const url = `${APP_LINK_SCHEME}${target.kind}/${parts.map(encodeURIComponent).join("/")}`;
  if (!parseAppLink(url)) throw new Error("Invalid app link target");
  return url;
}
