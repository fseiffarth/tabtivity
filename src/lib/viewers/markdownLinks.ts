/**
 * Clicks on links in rendered Markdown (`renderMarkdown`), for every host that
 * shows it: the markdown viewer, notebook cells, the Skills preview, the prompt
 * field's preview and the dev to-do board.
 *
 * A plain click on an `<a href>` without a `target` navigates the whole app
 * window away — on Linux that reloads the app and loses drafts; on Windows a
 * `\\host\x` href could put a remote page in the app window (threat recheck
 * gap 38). So every such click is caught here:
 *  - `#anchor` links scroll inside the preview `root`;
 *  - local file links (`file-link`) open in a Tabtivity tab through `open`
 *    when the host has a file to resolve them against (`basePath`), and do
 *    nothing otherwise;
 *  - any other anchor without a `target` is stopped.
 * External links carry `target="_blank"` from the renderer and keep their own
 * browsing context.
 */

import type React from "react";
import { dirname, fromFileUri, normalizePath, resolvePath } from "../paths";
import { matchAnchorId, splitLineHint } from "./markdown";

/** Resolve a markdown local-file href (relative/absolute/`file:`) to an absolute
 *  path against the directory of the markdown file `mdPath`. Drops any
 *  `?query`/`#fragment`, percent-decodes, and normalises `.`/`..` segments. The
 *  result keeps `mdPath`'s separator style, so it is correct on Windows (native
 *  backslashes + drive letter) as well as Unix. Returns null for an empty target. */
export function resolveLocalHref(mdPath: string, href: string): string | null {
  let h = splitLineHint(href.trim()).href.replace(/[?#].*$/, "");
  if (!h) return null;
  let resolved: string | null;
  if (/^file:\/\//i.test(h)) {
    const decoded = fromFileUri(h);
    resolved = decoded ? normalizePath(decoded) : null;
  } else {
    try { h = decodeURIComponent(h); } catch { /* keep the raw href */ }
    resolved = resolvePath(dirname(mdPath), h);
  }
  // A network path is only ever the markdown file's own share: an encoded
  // `%5C%5Chost/x` decodes to `\\host/x`, which Windows would open over SMB
  // (threat recheck gap 38, the same hazard as a `\\host` href).
  const share = resolved ? uncShare(resolved) : null;
  return share !== null && share !== uncShare(mdPath) ? null : resolved;
}

/** `server/share` (lowercased) of a UNC path (`\\server\share\…`, either
 *  slash), null for anything else. */
function uncShare(p: string): string | null {
  const m = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]*)/.exec(p);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export interface MarkdownLinkOptions {
  /** The rendered preview, for `#anchor` jumps; defaults to the clicked element's host. */
  root?: HTMLElement | null;
  /** The markdown file the text came from. Without one (a prompt draft, a
   *  skill from a catalog) local links are stopped and open nothing. */
  basePath?: string | null;
  /** Open a resolved local file; `href` is the authored link (line hint,
   *  fragment). The viewer and notebook pass `openMarkdownTarget`. */
  open?: (target: string, href: string) => void;
}

/** Handle a click inside rendered Markdown. Returns true when it landed on a
 *  link (handled, whatever the outcome), false when the host should go on with
 *  its own click handling. */
export function onMarkdownLinkClick(
  e: React.MouseEvent<HTMLElement>,
  { root, basePath, open }: MarkdownLinkOptions = {},
): boolean {
  const a = (e.target as Element | null)?.closest?.("a") as HTMLAnchorElement | null;
  if (!a) return false;
  const href = a.getAttribute("href") ?? "";
  if (href.startsWith("#")) {
    e.preventDefault();
    const scope = root ?? (e.currentTarget as HTMLElement | null);
    const els = Array.from(scope?.querySelectorAll<HTMLElement>("[id]") ?? []);
    const id = matchAnchorId(els.map((element) => element.id), href.slice(1));
    if (id) els.find((element) => element.id === id)?.scrollIntoView({ block: "start" });
    return true;
  }
  // An external link opens in its own browsing context, never this window.
  if (a.getAttribute("target")) return true;
  e.preventDefault();
  if (!a.classList.contains("file-link") || !basePath || !open) return true;
  const target = resolveLocalHref(basePath, href);
  if (target) open(target, href);
  return true;
}
