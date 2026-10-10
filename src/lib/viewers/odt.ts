/**
 * Lightweight OpenDocument Text (`.odt`) → HTML rendering (#51).
 *
 * An `.odt` is a ZIP holding `content.xml` (the document body as ODF XML),
 * `styles.xml`, and embedded images under `Pictures/`. This module is the pure,
 * framework-free half: it turns the *already-unzipped* archive into safe HTML.
 * The ZIP is opened by `OdtView` (via `odtArchive.unzipOdt`, bounded), which hands the entry map to
 * `extractOdt`; keeping fflate out of here means the transform is unit-testable
 * with a plain `content.xml` string and no real archive.
 *
 * Scope is deliberately a readable v1 subset: headings, paragraphs, bold/italic/
 * underline runs, hyperlinks, ordered/unordered lists, tables, inline images,
 * line breaks, tabs and explicit spaces. Anything unrecognised degrades to its
 * inner text rather than failing. "Open externally" remains the faithful path.
 *
 * SECURITY: the returned HTML is assembled here tag-by-tag from a fixed
 * whitelist. Every run of document text and every attribute value is escaped
 * (`esc`/`escAttr`); no ODF-supplied markup is ever passed through, hyperlink
 * hrefs are protocol-filtered, and image `src`s are `data:` URLs built from the
 * archive's own bytes. The result is therefore safe to inject with
 * `dangerouslySetInnerHTML`, matching the no-DOMPurify policy the other viewers
 * follow (see NotebookView).
 */

/** Escape text for HTML body context (mirrors `escapeHtmlText` in the viewer). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a value destined for a double-quoted HTML attribute. */
function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

/** Map a `Pictures/…` entry name to an image MIME type by extension. */
function imageMime(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "bmp": return "image/bmp";
    case "svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

/** Base64-encode bytes in chunks so a large image can't blow the call stack of a
 *  single `String.fromCharCode(...)` spread. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Pull the renderable pieces out of an unzipped `.odt`: the `content.xml` text
 * and a map from each embedded image's archive path (e.g. `Pictures/100.png`,
 * the exact `xlink:href` ODF uses) to a `data:` URL. Throws when `content.xml`
 * is absent (not an ODF document). Accepts a plain `Record` so tests can pass a
 * hand-built map without fflate.
 */
import { translate, useI18nStore } from "../i18n";

export function extractOdt(
  entries: Record<string, Uint8Array>,
): { contentXml: string; images: Map<string, string> } {
  const contentBytes = entries["content.xml"];
  if (!contentBytes) {
    throw new Error(translate(useI18nStore.getState().lang, "odt.errNotOpenDocument"));
  }
  const contentXml = new TextDecoder("utf-8").decode(contentBytes);
  const images = new Map<string, string>();
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.startsWith("Pictures/") && bytes.length > 0) {
      images.set(name, `data:${imageMime(name)};base64,${bytesToBase64(bytes)}`);
    }
  }
  return { contentXml, images };
}

/** Inline character formatting resolved from an automatic text style. */
interface TextFmt {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** First attribute whose *local* name matches, ignoring the namespace prefix —
 *  ODF attributes are prefixed (`fo:font-weight`, `xlink:href`, …) and the
 *  prefix is not guaranteed, so we match on local name only. */
function attr(el: Element, local: string): string | null {
  for (const a of Array.from(el.attributes)) {
    if (a.localName === local) return a.value;
  }
  return null;
}

/** All descendant elements with the given local name, prefix-agnostic. */
function byLocal(root: Element, local: string): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (child.localName === local) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** First child element with the given local name, or null. */
function firstChild(el: Element, local: string): Element | null {
  for (const child of Array.from(el.children)) {
    if (child.localName === local) return child;
  }
  return null;
}

/** Build `style:name → TextFmt` from the document's automatic text styles. */
function collectTextStyles(root: Element): Map<string, TextFmt> {
  const map = new Map<string, TextFmt>();
  for (const st of byLocal(root, "style")) {
    if (attr(st, "family") !== "text") continue;
    const name = attr(st, "name");
    if (!name) continue;
    const tp = firstChild(st, "text-properties");
    if (!tp) continue;
    const fmt: TextFmt = {};
    if (attr(tp, "font-weight") === "bold") fmt.bold = true;
    if (attr(tp, "font-style") === "italic") fmt.italic = true;
    const ul = attr(tp, "text-underline-style");
    if (ul && ul !== "none") fmt.underline = true;
    map.set(name, fmt);
  }
  return map;
}

/** Build `style:name → "ol" | "ul"` from the document's list styles (a list is
 *  ordered when its first level is a number style, else bulleted). */
function collectListStyles(root: Element): Map<string, "ol" | "ul"> {
  const map = new Map<string, "ol" | "ul">();
  for (const ls of byLocal(root, "list-style")) {
    const name = attr(ls, "name");
    if (!name) continue;
    const firstLevel = Array.from(ls.children)[0];
    const ordered = firstLevel?.localName === "list-level-style-number";
    map.set(name, ordered ? "ol" : "ul");
  }
  return map;
}

/** Longest `<text:s>` run rendered; far past any real layout's padding. */
const MAX_SPACE_RUN = 1000;

/** Allow only safe, non-script hyperlink targets. */
function safeHref(href: string | null): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  return /^(https?:|mailto:|#)/i.test(trimmed) ? trimmed : null;
}

/**
 * Render the `content.xml` of an `.odt` to a sanitised HTML fragment. `images`
 * maps each embedded image's `xlink:href` to a `data:` URL (from `extractOdt`);
 * omit it and images are dropped. Throws on XML that fails to parse or that has
 * no document body.
 */
export function renderOdtDocument(
  contentXml: string,
  opts: { images?: Map<string, string> } = {},
): string {
  const images = opts.images;
  const doc = new DOMParser().parseFromString(contentXml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0 || !doc.documentElement) {
    throw new Error(translate(useI18nStore.getState().lang, "odt.errParse"));
  }
  const root = doc.documentElement;
  const body = byLocal(root, "text")[0]; // <office:text>
  if (!body) throw new Error(translate(useI18nStore.getState().lang, "odt.errNoBody"));

  const textStyles = collectTextStyles(root);
  const listStyles = collectListStyles(root);

  const renderImage = (imgEl: Element): string => {
    const href = attr(imgEl, "href");
    if (!href) return "";
    const url = images?.get(href) ?? images?.get(href.replace(/^\.\//, ""));
    return url ? `<img class="odt-image" src="${escAttr(url)}" alt="" />` : "";
  };

  const inlineChildren = (el: Element): string => {
    let out = "";
    for (const child of Array.from(el.childNodes)) out += renderInline(child);
    return out;
  };

  function renderInline(node: Node): string {
    if (node.nodeType === 3 /* text */) return esc(node.nodeValue ?? "");
    if (node.nodeType !== 1 /* element */) return "";
    const el = node as Element;
    switch (el.localName) {
      case "span": {
        const fmt = textStyles.get(attr(el, "style-name") ?? "") ?? {};
        let inner = inlineChildren(el);
        if (fmt.underline) inner = `<u>${inner}</u>`;
        if (fmt.italic) inner = `<em>${inner}</em>`;
        if (fmt.bold) inner = `<strong>${inner}</strong>`;
        return inner;
      }
      case "a": {
        const href = safeHref(attr(el, "href"));
        const inner = inlineChildren(el);
        return href
          ? `<a href="${escAttr(href)}" target="_blank" rel="noreferrer noopener">${inner}</a>`
          : inner;
      }
      case "line-break":
        return "<br/>";
      case "tab":
        return "    ";
      case "s": {
        // Capped: the count is document-supplied, and `c="1000000000"` would
        // otherwise ask for a gigabyte string and take the viewer down.
        const count = Math.min(MAX_SPACE_RUN, Math.max(1, parseInt(attr(el, "c") ?? "1", 10) || 1));
        return " ".repeat(count);
      }
      case "frame": {
        const img = byLocal(el, "image")[0];
        return img ? renderImage(img) : inlineChildren(el);
      }
      case "image":
        return renderImage(el);
      default:
        // Unknown inline wrapper: keep its text content.
        return inlineChildren(el);
    }
  }

  const renderListItem = (item: Element): string => {
    let out = "";
    for (const child of Array.from(item.children)) {
      if (child.localName === "list") out += renderList(child);
      else out += renderInline(child); // a <text:p> renders as inline li content
    }
    return `<li>${out}</li>`;
  };

  function renderList(el: Element): string {
    const kind = listStyles.get(attr(el, "style-name") ?? "") ?? "ul";
    let items = "";
    for (const child of Array.from(el.children)) {
      if (child.localName === "list-item") items += renderListItem(child);
    }
    return `<${kind}>${items}</${kind}>`;
  }

  const renderTable = (el: Element): string => {
    const rowsFrom = (parent: Element): string => {
      let rows = "";
      for (const child of Array.from(parent.children)) {
        if (child.localName === "table-header-rows") {
          rows += rowsFrom(child);
        } else if (child.localName === "table-row") {
          let cells = "";
          for (const cell of Array.from(child.children)) {
            if (cell.localName === "table-cell") {
              cells += `<td>${renderBlocks(cell)}</td>`;
            }
          }
          rows += `<tr>${cells}</tr>`;
        }
      }
      return rows;
    };
    return `<table class="odt-table"><tbody>${rowsFrom(el)}</tbody></table>`;
  };

  function renderBlocks(parent: Element): string {
    let out = "";
    for (const child of Array.from(parent.children)) {
      switch (child.localName) {
        case "h": {
          const n = parseInt(attr(child, "outline-level") ?? "1", 10);
          const lvl = Math.min(6, Math.max(1, Number.isNaN(n) ? 1 : n));
          out += `<h${lvl}>${renderInline(child)}</h${lvl}>`;
          break;
        }
        case "p":
          out += `<p>${inlineChildren(child)}</p>`;
          break;
        case "list":
          out += renderList(child);
          break;
        case "table":
          out += renderTable(child);
          break;
        default:
          // Wrappers like <text:section> / <text:soft-page-break>: recurse so
          // their block children still render.
          if (child.children.length > 0) out += renderBlocks(child);
      }
    }
    return out;
  }

  return renderBlocks(body);
}
