import type { TranscriptEntry } from "../../../../mobile-web/src/api";
import { answerHtml, promptHtml } from "../../../../mobile-web/src/terminal/answerMarkdown";
import { escapeHtml } from "../../textSafety";
import type { TrailPrompt } from "./trail";

/**
 * The Prompts panel's exports (`components/terminal/TerminalPromptStrip`):
 * the whole session — every prompt, answer, subagent and interruption the
 * CLI's transcript holds — as Markdown or as a chat-looking HTML page, or only
 * the user's prompts as Markdown. Pure, so the shape is unit-tested; the panel
 * saves the text through `agent_session_export_write`.
 */

/** What the headings say, already translated: the export is the user's
 * document, so it reads in the app's language. */
export interface ExportWords {
  title: string;
  you: string;
  agent: string;
  plan: string;
  subagent: string;
  interrupted: string;
  cut: string;
  /** Shown above the turns when earlier ones were not read. */
  earlier: string;
}

/** One prompt or turn to export: its text and, when known, its moment. */
export interface ExportPrompt {
  text: string;
  at?: number;
}

/** A moment as the export prints it, on the app's 12/24-hour clock. */
export function exportTime(at: number, use24h: boolean): string {
  return new Date(at).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: !use24h,
  });
}

function entryTime(at: string | undefined): number | undefined {
  if (!at) return undefined;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : undefined;
}

function heading(label: string, at: number | undefined, use24h: boolean): string {
  return at === undefined ? `## ${label}` : `## ${label} · ${exportTime(at, use24h)}`;
}

/** The text as a Markdown block: kept as written, with a cut marked. */
function body(text: string, cut: boolean | undefined, words: ExportWords): string {
  const trimmed = text.replace(/\s+$/, "");
  return cut ? `${trimmed}\n\n*${words.cut}*` : trimmed;
}

/** The whole session: every entry of the transcript, oldest first. An entry
 * still blocking on the agent's own screen is the live card's, not yet part of
 * the conversation, and is left out as the chat leaves it out. */
export function sessionMarkdown(
  entries: readonly TranscriptEntry[],
  opts: { words: ExportWords; use24h: boolean; truncated?: boolean },
): string {
  const { words, use24h } = opts;
  const parts: string[] = [`# ${words.title}`];
  if (opts.truncated) parts.push(`*${words.earlier}*`);
  for (const entry of entries) {
    if (entry.blocking) continue;
    const at = entryTime(entry.at);
    switch (entry.kind) {
      case "prompt": {
        const text = entry.setting ? `${entry.text} → ${entry.setting}` : entry.text;
        parts.push(heading(words.you, at, use24h), body(text, entry.cut, words));
        break;
      }
      case "answer":
        parts.push(heading(entry.plan ? words.plan : words.agent, at, use24h), body(entry.text, entry.cut, words));
        break;
      case "agent": {
        const label = entry.role ? `${words.subagent} (${entry.role})` : words.subagent;
        parts.push(heading(label, at, use24h), body(entry.text, entry.cut, words));
        break;
      }
      case "interrupted":
        parts.push(`*${words.interrupted}${entry.text ? ` — ${entry.text.trim()}` : ""}*`);
        break;
    }
  }
  return `${parts.join("\n\n")}\n`;
}

/** Only the user's prompts, oldest first, numbered. */
export function promptsMarkdown(
  prompts: readonly ExportPrompt[],
  opts: { words: ExportWords; use24h: boolean; truncated?: boolean },
): string {
  const { words, use24h } = opts;
  const parts: string[] = [`# ${words.title}`];
  if (opts.truncated) parts.push(`*${words.earlier}*`);
  prompts.forEach((prompt, i) => {
    parts.push(heading(`${i + 1}`, prompt.at, use24h), prompt.text.replace(/\s+$/, ""));
  });
  return `${parts.join("\n\n")}\n`;
}

/** The session's own prompts from its transcript, a slash command's setting
 * kept beside it. */
export function transcriptPrompts(entries: readonly TranscriptEntry[]): ExportPrompt[] {
  return entries
    .filter((entry) => entry.kind === "prompt" && entry.text.trim())
    .map((entry) => ({ text: entry.setting ? `${entry.text} → ${entry.setting}` : entry.text, at: entryTime(entry.at) }));
}

/** The panel's own list, for an agent whose transcript is not read. */
export function trailPrompts(trail: readonly TrailPrompt[]): ExportPrompt[] {
  return trail.map((entry) => ({ text: entry.text, at: entry.at }));
}

/** A day as the chat page's separator names it: in full, since the file is
 * read on other days than the one it was saved. */
function exportDay(at: number): string {
  return new Date(at).toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function exportClock(at: number, use24h: boolean): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: !use24h });
}

/** A prompt that is one slash command (`/model`, `/clear`): the chat draws it
 * as a rule, not a bubble. */
function isCommand(text: string): boolean {
  return /^\/[A-Za-z][\w:-]*(?:\s[^\n]*)?$/.test(text.trim());
}

/** The chat page's look: the desktop Chat's (`.terminal-reader-*` in
 * styles/subwindows.css) — a prompt as a soft accent bubble on the right, an
 * answer as a rimmed card on the left, day chips, commands and subagents as
 * thin rules — in a light and a dark scheme, and plain on paper. */
const CHAT_CSS = `
:root{--bg:#f6f5f9;--card:#fff;--ink:#1d1b24;--muted:#6b6878;--rim:#e2dfea;--accent:#6d5bd0;--user:#ebe7fb;--code:#f1eff6;--warn:#b5481f}
@media (prefers-color-scheme:dark){:root{--bg:#15141a;--card:#1f1d26;--ink:#e8e6ef;--muted:#9a96a8;--rim:#2f2c3a;--accent:#a596ff;--user:#2a2541;--code:#262330;--warn:#ff9a6b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{display:flex;flex-direction:column;gap:10px;max-width:920px;margin:0 auto;padding:24px 16px 48px}
h1.title{margin:0 0 8px;font-size:20px}
.note{color:var(--muted);font-style:italic;text-align:center;font-size:13px}
.day{display:flex;justify-content:center;margin:10px 0 2px;font-size:13px;color:var(--muted)}
.day span{padding:2px 12px;border-radius:999px;background:var(--rim)}
.turn{position:relative;max-width:min(760px,86%);padding:8px 12px 20px;border-radius:10px;overflow-wrap:anywhere}
.turn.user{align-self:flex-end;border-bottom-right-radius:4px;background:var(--user);margin-top:12px}
.turn.user+.turn.user{margin-top:0}
.turn.agent{align-self:flex-start;border-bottom-left-radius:4px;background:var(--card);border:1px solid var(--rim);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.turn.plan{border-color:var(--accent)}
.plan-head{display:block;margin-bottom:4px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--accent)}
.time{position:absolute;right:10px;bottom:4px;font-size:11px;color:var(--muted)}
.cut{display:block;margin-top:4px;font-size:12px;color:var(--muted);font-style:italic}
.rule{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--muted)}
.rule::before,.rule::after{content:"";flex:1;border-top:1px solid var(--rim)}
.rule.interrupted{color:var(--warn)}
.rule b{font-weight:600;color:var(--ink)}
.markdown-body>:first-child{margin-top:0}.markdown-body>:last-child{margin-bottom:0}
.markdown-body p{margin:.4em 0}
.markdown-body :is(h1,h2,h3,h4,h5,h6){margin:.7em 0 .3em;line-height:1.25}
.markdown-body h1{font-size:1.3em}.markdown-body h2{font-size:1.18em}.markdown-body h3{font-size:1.06em}
.markdown-body :is(ul,ol){margin:.4em 0;padding-left:1.4em}
.markdown-body code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 4px;border-radius:4px}
.markdown-body pre{background:var(--code);padding:8px 10px;border-radius:6px;overflow-x:auto}
.markdown-body pre code{padding:0;background:none;white-space:pre}
.markdown-body blockquote{margin:.4em 0;padding-left:10px;border-left:3px solid var(--rim);color:var(--muted)}
.markdown-body table{border-collapse:collapse;margin:.5em 0}
.markdown-body :is(th,td){border:1px solid var(--rim);padding:3px 8px;overflow-wrap:break-word}
.markdown-body .md-link{color:var(--accent);text-decoration:underline}
.markdown-body .md-alert{border-left:3px solid var(--accent);padding-left:10px}
@media print{body{background:#fff}.turn{break-inside:avoid;box-shadow:none}}
`;

/** The whole session as a self-contained HTML page that looks like the Chat.
 * Prompts and answers go through the chat's own formatter (`answerHtml`,
 * `promptHtml`: escape-first, then an allowlist that keeps formatting only,
 * a link as its label), and the page's CSP lets nothing load or run. As in
 * the chat, a question still blocking on the agent's own screen is left out. */
export function sessionHtml(
  entries: readonly TranscriptEntry[],
  opts: { words: ExportWords; use24h: boolean; truncated?: boolean },
): string {
  const { words, use24h } = opts;
  const parts: string[] = [`<h1 class="title">${escapeHtml(words.title)}</h1>`];
  if (opts.truncated) parts.push(`<p class="note">${escapeHtml(words.earlier)}</p>`);
  let lastDay = "";
  const time = (at: number | undefined) => (at === undefined ? "" : `<time class="time">${escapeHtml(exportClock(at, use24h))}</time>`);
  const cut = (entry: TranscriptEntry) => (entry.cut ? `<span class="cut">${escapeHtml(words.cut)}</span>` : "");
  for (const entry of entries) {
    if (entry.blocking) continue;
    const at = entryTime(entry.at);
    if (at !== undefined) {
      const day = exportDay(at);
      if (day !== lastDay) parts.push(`<div class="day" role="separator"><span>${escapeHtml(day)}</span></div>`);
      lastDay = day;
    }
    switch (entry.kind) {
      case "prompt":
        if (isCommand(entry.text)) {
          const setting = entry.setting ? ` → ${escapeHtml(entry.setting)}` : "";
          parts.push(`<div class="rule"><span><b>${escapeHtml(entry.text.trim())}</b>${setting}</span></div>`);
        } else {
          parts.push(`<div class="turn user"><div class="markdown-body">${promptHtml(entry.text)}</div>${cut(entry)}${time(at)}</div>`);
        }
        break;
      case "answer": {
        const head = entry.plan ? `<span class="plan-head">${escapeHtml(words.plan)}</span>` : "";
        parts.push(`<div class="turn agent${entry.plan ? " plan" : ""}">${head}<div class="markdown-body">${answerHtml(entry.text)}</div>${cut(entry)}${time(at)}</div>`);
        break;
      }
      case "agent": {
        const label = entry.role ? `${words.subagent} (${entry.role})` : words.subagent;
        parts.push(`<div class="rule"><span><b>${escapeHtml(label)}</b> · ${escapeHtml(entry.text.trim())}</span></div>`);
        break;
      }
      case "interrupted":
        parts.push(`<div class="rule interrupted"><span>${escapeHtml(words.interrupted)}</span></div>`);
        break;
    }
  }
  return [
    "<!doctype html>",
    `<html><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(words.title)}</title>`,
    `<style>${CHAT_CSS}</style></head>`,
    `<body><main>${parts.join("\n")}</main></body></html>`,
    "",
  ].join("\n");
}

/** A file name for the save dialog: the tab's label, made safe on every OS,
 * then what was exported. */
export function exportFileName(label: string | undefined, what: "session" | "prompts" | "chat"): string {
  const printable = [...(label ?? "").normalize("NFC")].map((ch) => (ch.charCodeAt(0) < 0x20 ? " " : ch)).join("");
  const stem = printable
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80)
    .trim();
  return `${stem || "agent"}-${what}.${what === "chat" ? "html" : "md"}`;
}
