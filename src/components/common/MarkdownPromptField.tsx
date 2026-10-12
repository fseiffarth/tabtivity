import { useLayoutEffect, useRef, useState } from "react";
import {
  continueList,
  cycleHeading,
  indentLines,
  makeLink,
  markerAt,
  toggleInline,
  toggleLinePrefix,
  type EditResult,
} from "../../lib/viewers/markdownEdit";
import { renderMarkdown } from "../../lib/viewers/markdown";
import { onMarkdownLinkClick } from "../../lib/viewers/markdownLinks";
import { useT } from "../../lib/i18n";
import { LinkIcon } from "./icons/Icon";

interface Props {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  /** Extra classes for the textarea itself, so a host keeps its own layout
   *  rules (`.agent-prompts-edit`, the composer's sizing) unchanged. */
  className?: string;
  /** The host's own keys — Ctrl/⌘+Enter to send, Escape to cancel — run first
   *  and win: a handled key never reaches the Markdown handling below. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * A prompt textarea that knows it is holding Markdown: a formatting toolbar
 * (the file viewer's own `MarkdownToolbar` buttons, minus the document-scale
 * table of contents), list/quote continuation on Enter, Tab to nest a list
 * level, and a Preview flip that renders the draft through the repo's
 * escape-first `renderMarkdown`.
 *
 * A prompt is Markdown wherever it lands — every agent CLI reads headings,
 * lists and fenced code as structure — so the affordances for writing one
 * belong in the field, not in the user's memory. The transforms are the file
 * viewer's (`lib/viewers/markdownEdit`), applied through the same
 * value/selection contract, which is what keeps a bullet typed here identical
 * to a bullet typed in a `.md` tab.
 */
export function MarkdownPromptField({
  value,
  onChange,
  rows = 4,
  placeholder,
  ariaLabel,
  autoFocus,
  className,
  onKeyDown,
}: Props) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [preview, setPreview] = useState(false);
  // Where the caret has to land once React has painted the new value: a
  // transform is a value + a selection, and setting the value alone would park
  // the caret at the end of the buffer after every button press.
  const pending = useRef<[number, number] | null>(null);

  useLayoutEffect(() => {
    const sel = pending.current;
    const el = ref.current;
    if (!sel || !el) return;
    pending.current = null;
    el.focus();
    el.setSelectionRange(sel[0], sel[1]);
  });

  const apply = (fn: (v: string, s: number, e: number) => EditResult | null) => {
    const el = ref.current;
    if (!el) return false;
    const result = fn(el.value, el.selectionStart, el.selectionEnd);
    if (!result) return false;
    pending.current = [result.selStart, result.selEnd];
    onChange(result.value);
    return true;
  };

  const btn = (
    label: React.ReactNode,
    title: string,
    fn: (v: string, s: number, e: number) => EditResult,
  ) => (
    <button
      type="button"
      className="file-viewer-md-btn"
      title={title}
      aria-label={title}
      // Keep the selection the action's target: focus must not leave the
      // textarea on mousedown.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => apply(fn)}
    >
      {label}
    </button>
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      const inline =
        key === "b" ? "**" : key === "i" ? "_" : key === "e" ? "`" : null;
      if (inline) {
        event.preventDefault();
        apply((v, s, e) => toggleInline(v, s, e, inline));
        return;
      }
      if (key === "k") {
        event.preventDefault();
        apply((v, s, e) => makeLink(v, s, e));
        return;
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !mod) {
      const el = ref.current;
      if (el && el.selectionStart === el.selectionEnd && apply((v, s) => continueList(v, s))) {
        event.preventDefault();
      }
      return;
    }
    // Tab only belongs to the field while the caret is in a list or quote —
    // everywhere else it stays the key that leaves the field.
    if (event.key === "Tab") {
      const el = ref.current;
      if (!el) return;
      const spans = el.selectionStart !== el.selectionEnd;
      if (!spans && !markerAt(el.value, el.selectionStart)) return;
      event.preventDefault();
      apply((v, s, e) => indentLines(v, s, e, event.shiftKey));
    }
  };

  return (
    <div className="md-prompt">
      <div className="md-prompt-bar">
        <div
          className="file-viewer-md-toolbar"
          role="group"
          aria-label={t("fileViewer.formattingGroup")}
        >
          {btn(<b>B</b>, t("fileViewer.mdBold"), (v, s, e) => toggleInline(v, s, e, "**"))}
          {btn(<i>I</i>, t("fileViewer.mdItalic"), (v, s, e) => toggleInline(v, s, e, "_"))}
          {btn(
            <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{"<>"}</span>,
            t("fileViewer.mdInlineCode"),
            (v, s, e) => toggleInline(v, s, e, "`"),
          )}
          {btn("H", t("fileViewer.mdCycleHeading"), (v, s) => cycleHeading(v, s))}
          {btn("•", t("fileViewer.mdBulletedList"), (v, s, e) => toggleLinePrefix(v, s, e, "- "))}
          {btn("1.", t("mdPrompt.numberedList"), (v, s, e) => toggleLinePrefix(v, s, e, "1. "))}
          {btn("☐", t("mdPrompt.taskList"), (v, s, e) => toggleLinePrefix(v, s, e, "- [ ] "))}
          {btn("❝", t("mdPrompt.quote"), (v, s, e) => toggleLinePrefix(v, s, e, "> "))}
          {btn(<LinkIcon />, t("fileViewer.mdLink"), (v, s, e) => makeLink(v, s, e))}
          {btn("```", t("mdPrompt.codeBlock"), (v, s, e) => {
            const sel = v.slice(s, e);
            const block = `\`\`\`\n${sel}\n\`\`\`\n`;
            return {
              value: v.slice(0, s) + block + v.slice(e),
              selStart: s + 4,
              selEnd: s + 4 + sel.length,
            };
          })}
        </div>
        {/* One button, not the viewer's Edit/Preview pair: a row of collected
            prompts already has an Edit button, and two of them in the same row
            is one too many. It stays the viewer's segmented-toggle look, held
            down while the preview is up. */}
        <div className="file-viewer-modes md-prompt-modes">
          <button
            type="button"
            className={`file-viewer-mode${preview ? " active" : ""}`}
            aria-pressed={preview}
            title={t("mdPrompt.previewTitle")}
            onClick={() => setPreview((on) => !on)}
          >
            {t("fileViewer.modePreview")}
          </button>
        </div>
      </div>
      {preview ? (
        value.trim() ? (
          <div
            className="markdown-body md-prompt-preview"
            data-testid="md-prompt-preview"
            // A draft has no file to resolve links against: a click on one
            // never navigates the app window away (threat recheck gap 38).
            onClick={(e) => onMarkdownLinkClick(e)}
            // `renderMarkdown` is this repo's escape-first renderer (no raw HTML
            // passes through it) — the same call the notebook viewer makes.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }}
          />
        ) : (
          <div className="md-prompt-preview file-tree-empty" data-testid="md-prompt-preview">
            {t("mdPrompt.previewEmpty")}
          </div>
        )
      ) : (
        <textarea
          ref={ref}
          className={className ? `md-prompt-input ${className}` : "md-prompt-input"}
          rows={rows}
          value={value}
          placeholder={placeholder}
          aria-label={ariaLabel}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      )}
    </div>
  );
}
