// The web links a conversation names, as the Chat makes them clickable and
// nothing else: each message is rendered the way the Chat draws it
// (`promptHtml` / `answerHtml`, whose allowlist keeps a `data-href` only where
// `chatLinkUrl` accepts it) and the `.md-link[data-href]` it carries are read
// back. No second link parser, so this list and the Chat cannot disagree. The
// desktop's Files view lists them (open-only, through the Chat's own confirm);
// the phone can add a group on the same rows later.
import { answerHtml, chatLinkUrl, promptHtml } from "./answerMarkdown";

/** One link of the conversation, ready to list. */
export interface ChatLink {
  /** The address, normalized (`chatLinkUrl`): what a confirmation names. */
  url: string;
  /** Its host (with the port), `www.` dropped, in punycode as `chatLinkUrl` returns it. */
  host: string;
  /** Its path and query, empty for a bare host. */
  rest: string;
  /** The words the message put on it, only when they are not an address themselves. */
  label?: string;
  from: "you" | "agent";
  /** The message's own stamp, as `TranscriptTurn.stamp`. */
  at?: string;
}

/** The part of a `TranscriptTurn` that decides whether the Chat shows links. */
export interface LinkTurn {
  kind: string;
  text: string;
  stamp?: string;
  command?: unknown;
  questions?: unknown;
}

/** Links a list holds at most (the newest). */
export const MAX_CHAT_LINKS = 100;
const CACHE_MAX = 500;
const MENTIONS = /https?:\/\/|www\./i;
const ADDRESS_LABEL = /^(?:https?:\/\/|www\.)/i;

interface Found { url: string; label?: string }

/** Per message text: its links in document order. A live transcript re-lists
 * every tick; this keeps each message from being rendered again. */
const cache = new Map<string, readonly Found[]>();

function foundIn(kind: "prompt" | "answer", text: string): readonly Found[] {
  const key = `${kind}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const template = document.createElement("template");
  template.innerHTML = kind === "prompt" ? promptHtml(text) : answerHtml(text);
  const links: Found[] = [];
  template.content.querySelectorAll<HTMLElement>(".md-link[data-href]").forEach((element) => {
    const url = chatLinkUrl(element.getAttribute("data-href"));
    if (!url) return;
    const words = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    links.push(words && !ADDRESS_LABEL.test(words) ? { url, label: words } : { url });
  });
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, links);
  return links;
}

/** `url` without its `#fragment`: two links to one page are one row. */
function pageOf(url: string): string {
  const at = url.indexOf("#");
  return at < 0 ? url : url.slice(0, at);
}

function shown(url: string): { host: string; rest: string } {
  const parsed = new URL(url);
  const host = parsed.host.replace(/^www\./i, "");
  const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
  return { host, rest };
}

/**
 * The links the Chat shows clickable in `turns`, newest message first, within
 * one message first mention first, one row per page (the first sighting wins),
 * at most `max`. Only the turns the Chat draws as formatted text count: a
 * prompt that is not a slash command and an answer that is not a question
 * card. A link the reader pasted in a prompt is included, marked `you`.
 */
export function chatLinksOf(turns: readonly LinkTurn[], max = MAX_CHAT_LINKS): ChatLink[] {
  const out: ChatLink[] = [];
  const seen = new Set<string>();
  for (let index = turns.length - 1; index >= 0 && out.length < max; index -= 1) {
    const turn = turns[index];
    const from = turn.kind === "prompt" && !turn.command ? "you"
      : turn.kind === "answer" && !turn.questions ? "agent" : null;
    if (!from || !MENTIONS.test(turn.text)) continue;
    for (const found of foundIn(from === "you" ? "prompt" : "answer", turn.text)) {
      const page = pageOf(found.url);
      if (seen.has(page)) continue;
      seen.add(page);
      out.push({ url: found.url, ...shown(found.url), ...(found.label ? { label: found.label } : {}), from, ...(turn.stamp ? { at: turn.stamp } : {}) });
      if (out.length >= max) break;
    }
  }
  return out;
}
