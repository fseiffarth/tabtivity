import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useT } from "../../lib/i18n";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { submitScheduledAgentCommand } from "../../lib/agents/scheduledAgentInput";
import { readContextUsage, type ContextCategory, type ContextUsage } from "../../lib/agents/contextUsage";
import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";
import type { TabEntry } from "../../stores/tabs";
import { UntestedTag } from "../common/UntestedTag";

/** `/context` prints its card into the scrollback, listings and all: a few
 * screenfuls above the input box. */
const CONTEXT_ROWS = 400;
const PLAIN = { plain: true } as const;

/** The agents with a `/context` card the panel can read. Copilot prints one
 * too (`readContextUsage` reads it), but has no Chat view yet. */
export const CONTEXT_AGENTS: Partial<Record<string, true>> = { claude: true };

/** One colour per legend row in use, in the CLI's order. */
const SWATCHES = [
  "var(--accent)", "var(--info)", "var(--success)", "var(--warning)", "var(--accent-secondary)", "var(--danger)",
  "color-mix(in srgb, var(--info) 55%, var(--text-muted))", "color-mix(in srgb, var(--success) 55%, var(--accent))",
];

const swatchOf = (categories: readonly ContextCategory[], index: number) =>
  SWATCHES[categories.slice(0, index).filter((entry) => entry.kind === "used").length % SWATCHES.length];

/** A listing's figure as a number, for its bars: `~480`, `1.3k`, `2m`. */
function tokenCount(text: string | undefined): number {
  const match = text && /^~?([\d.]+)([kKmM]?)$/u.exec(text);
  if (!match) return 0;
  const unit = match[2].toLowerCase();
  return Number(match[1]) * (unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1);
}

export function TerminalReaderContext({ tab, ptyId, agentLabel, visible, canRefresh, request, onClose, onRefresh }: {
  tab: TabEntry; ptyId: string; agentLabel: string; visible: boolean; canRefresh: boolean; request: number;
  onClose: () => void; onRefresh: () => void;
}) {
  const t = useT();
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshAllowed = useRef(canRefresh);
  refreshAllowed.current = canRefresh;
  // Opening the view is also an explicit /context request, on the same
  // command path as /status: it refuses to overwrite a busy agent's composer.
  useEffect(() => {
    if (!visible || !refreshAllowed.current || !tab.scheduleTargetId) return;
    let disposed = false;
    setRefreshing(true);
    setError(false);
    void submitScheduledAgentCommand(tab.scheduleTargetId, "/context")
      .catch(() => { if (!disposed) setError(true); });
    const wait = setTimeout(() => { if (!disposed) setRefreshing(false); }, 1500);
    return () => { disposed = true; clearTimeout(wait); };
    // Refresh only on the user's request, never when the agent becomes idle.
  }, [request, visible, tab.scheduleTargetId]);

  useEffect(() => {
    if (!visible) return;
    const read = () => {
      const term = terminalFor(ptyId);
      const lines = term ? readableScreen(term.buffer.active, CONTEXT_ROWS, PLAIN).lines : [];
      const next = readContextUsage(lines);
      if (next) setUsage((previous) => previous?.raw === next.raw ? previous : next);
    };
    read();
    const timer = setInterval(read, 500);
    return () => clearInterval(timer);
  }, [visible, ptyId]);

  const categories = usage?.categories ?? [];
  const percent = usage?.percent;
  return <section className="terminal-reader-picker terminal-reader-status terminal-reader-context" role="dialog" aria-label={t("terminal.reader.context.title", { agent: agentLabel })}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="terminal-reader-picker-head">
      <strong>{t("terminal.reader.context.title", { agent: agentLabel })}</strong>
      <UntestedTag id="terminal.reader.context" />
      <button type="button" className="terminal-reader-fact-model" onClick={onRefresh} disabled={!canRefresh || refreshing || !tab.scheduleTargetId}>{t("terminal.reader.context.refresh")}</button>
      <button type="button" className="terminal-reader-picker-close" onClick={onClose} aria-label={t("common.close")}>✕</button>
    </div>
    {usage ? <>
      <div className="terminal-reader-context-total">
        <div>
          {usage.model && <span className="terminal-reader-status-label">{usage.model}</span>}
          <strong>{t("terminal.reader.context.used", { used: usage.used ?? "", total: usage.total ?? "" })}</strong>
        </div>
        {percent != null && <span className="terminal-reader-context-percent">{t("terminal.reader.context.percent", { percent: Math.round(percent) })}</span>}
      </div>
      <div className="terminal-reader-context-bar" role="img" aria-label={categories.map((entry) => `${entry.label}: ${entry.tokens}`).join(", ")}>
        {categories.map((entry, index) => entry.kind !== "free" && <span key={`${entry.label}:${index}`}
          className={entry.kind === "reserved" ? "reserved" : undefined} title={`${entry.label} · ${entry.tokens}`}
          style={{ width: `${entry.percent}%`, "--context-swatch": swatchOf(categories, index) } as CSSProperties} />)}
      </div>
      <ul className="terminal-reader-context-legend">
        {categories.map((entry, index) => <li key={`${entry.label}:${index}`} className={entry.kind === "used" ? undefined : entry.kind}
          style={{ "--context-swatch": swatchOf(categories, index) } as CSSProperties}>
          <span className="terminal-reader-context-swatch" aria-hidden="true" />
          <span className="terminal-reader-context-name">{entry.label}</span>
          <span className="terminal-reader-context-tokens">{entry.tokens}</span>
          <span className="terminal-reader-context-share">{entry.percent < 1 && entry.percent > 0 ? "<1%" : `${Math.round(entry.percent * 10) / 10}%`}</span>
        </li>)}
      </ul>
      {usage.notes.length > 0 && <dl className="terminal-reader-status-details">
        {usage.notes.map((note, index) => <div key={`${note.label}:${index}`}><dt>{note.label}</dt><dd>{note.value}</dd></div>)}
      </dl>}
      {usage.sections.map((section, index) => {
        const items = section.groups.flatMap((group) => group.items);
        const largest = Math.max(1, ...items.map((item) => tokenCount(item.tokens)));
        return <details key={`${section.title}:${index}`} className="terminal-reader-context-section">
          <summary><span>{section.title}</span>{section.hint && <small>{section.hint}</small>}<small>{items.length}</small></summary>
          {section.groups.map((group, groupIndex) => <div key={`${group.title ?? ""}:${groupIndex}`} className="terminal-reader-context-group">
            {group.title && <span className="terminal-reader-status-label">{group.title}</span>}
            <ul>
              {group.items.map((item, itemIndex) => <li key={`${item.name}:${itemIndex}`}>
                <span className="terminal-reader-context-name" title={item.name}>{item.name}</span>
                {item.tokens && <span className="terminal-reader-context-tokens">{item.tokens}</span>}
                {item.tokens && <span className="terminal-reader-context-item-bar" aria-hidden="true"><span style={{ width: `${(tokenCount(item.tokens) / largest) * 100}%` }} /></span>}
              </li>)}
            </ul>
          </div>)}
        </details>;
      })}
    </> : <small className="terminal-reader-status-note">{t("terminal.reader.context.none", { agent: agentLabel })}</small>}
    <small className="terminal-reader-status-note">{t("terminal.reader.context.reported", { agent: agentLabel })}</small>
    {refreshing && <small role="status">{t("terminal.reader.context.refreshing", { agent: agentLabel })}</small>}
    {error && <small role="alert">{t("terminal.reader.context.failed", { agent: agentLabel })}</small>}
    {usage && <details className="terminal-reader-status-raw"><summary>{t("terminal.reader.context.raw")}</summary><pre>{usage.raw}</pre></details>}
  </section>;
}
