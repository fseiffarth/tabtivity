import { useEffect, useRef, useState } from "react";
import { useT, type TranslationKey } from "../../lib/i18n";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { submitScheduledAgentCommand } from "../../lib/agents/scheduledAgentInput";
import { codexRemaining, codexReset, readCodexStatus, type CodexStatusCard } from "../../lib/agents/codexStatus";
import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";
import { sessionLimits } from "../../../mobile-web/src/terminal/sessionUsage";
import { resetCountdown, resetText } from "../../../mobile-web/src/terminal/limitResets";
import type { SessionUsage } from "../../../mobile-web/src/api";
import type { TabEntry } from "../../stores/tabs";
import { UntestedTag } from "../common/UntestedTag";

const FIELD_KEYS: Record<string, TranslationKey> = {
  Directory: "terminal.reader.status.directory", Account: "terminal.reader.status.account",
  Session: "terminal.reader.status.session", Permissions: "terminal.reader.status.permissions",
  Approval: "terminal.reader.status.approval", Sandbox: "terminal.reader.status.sandbox",
  "Token usage": "terminal.reader.status.tokens", "Context window": "terminal.reader.status.context",
};

export function TerminalReaderStatus({ tab, ptyId, visible, canRefresh, request, model, effort, path, contextLeft, usage, onClose, onRefresh }: {
  tab: TabEntry; ptyId: string; visible: boolean; canRefresh: boolean; request: number;
  model?: string; effort?: string; path?: string; contextLeft?: string; usage?: SessionUsage; onClose: () => void; onRefresh: () => void;
}) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<{ card: CodexStatusCard; readAt: number } | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const refreshAllowed = useRef(canRefresh);
  refreshAllowed.current = canRefresh;
  // Opening the view is also an explicit /status request. It uses the existing
  // command path, which refuses to overwrite a busy agent's composer.
  useEffect(() => {
    if (!visible || !refreshAllowed.current || !tab.scheduleTargetId) return;
    let disposed = false;
    setRefreshing(true);
    setError(false);
    void submitScheduledAgentCommand(tab.scheduleTargetId, "/status")
      .catch(() => { if (!disposed) setError(true); });
    const wait = setTimeout(() => { if (!disposed) setRefreshing(false); }, 1500);
    return () => { disposed = true; clearTimeout(wait); };
    // Refresh only on the user's request, never when the agent becomes idle.
  }, [request, visible, tab.scheduleTargetId]);

  useEffect(() => {
    if (!visible) return;
    const read = () => {
      const term = terminalFor(ptyId);
      const next = term && readCodexStatus(readableScreen(term.buffer.active).lines);
      if (next) setSnapshot((previous) => previous?.card.raw === next.raw ? previous : { card: next, readAt: Date.now() });
      setNow(Date.now());
    };
    read();
    const timer = setInterval(read, 500);
    return () => clearInterval(timer);
  }, [visible, ptyId]);

  const card = snapshot?.card;
  const fields = card?.fields ?? [];
  const field = (label: string) => fields.find((entry) => entry.label === label)?.value;
  const clock = new Date(now);
  const limits = sessionLimits(usage, clock);
  const meters: { label: string; remaining: number; resets?: string; detail?: string }[] = [];
  const context = codexRemaining(field("Context window")) ?? usage?.contextLeft ?? codexRemaining(contextLeft ? `${contextLeft} left` : undefined);
  if (context != null && Number.isFinite(context) && context >= 0 && context <= 100) {
    meters.push({ label: t("terminal.reader.status.context"), remaining: context, detail: field("Context window")?.match(/\(([^)]+)\)/u)?.[1] });
  }
  for (const [label, native, fallback] of [
    [t("terminal.reader.status.sessionLimit"), "5h limit", limits.session],
    [t("terminal.reader.status.weekLimit"), "Weekly limit", limits.week],
  ] as const) {
    const value = field(native);
    const remaining = codexRemaining(value) ?? (fallback ? 100 - fallback.percent : undefined);
    if (remaining != null && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100) {
      meters.push({ label, remaining, resets: value ? codexReset(value) : fallback?.resets });
    }
  }
  const details = fields.filter((entry) => entry.label !== "Model" && !(codexRemaining(entry.value) != null && ["Context window", "5h limit", "Weekly limit"].includes(entry.label)));

  return <section className="terminal-reader-picker terminal-reader-status" role="dialog" aria-label={t("terminal.reader.status.title")}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="terminal-reader-picker-head">
      <strong>{t("terminal.reader.status.title")}</strong>
      <UntestedTag id="terminal.reader.codexStatus" />
      <button type="button" className="terminal-reader-fact-model" onClick={onRefresh} disabled={!canRefresh || refreshing || !tab.scheduleTargetId}>{t("terminal.reader.status.refresh")}</button>
      <button type="button" className="terminal-reader-picker-close" onClick={onClose} aria-label={t("common.close")}>✕</button>
    </div>
    <div className="terminal-reader-status-model">
      <span className="terminal-reader-status-label">{t("terminal.reader.model")}</span>
      <strong>{field("Model") ?? model ?? t("terminal.reader.status.unknown")}</strong>
      {!field("Model") && effort && <small>{t("terminal.reader.effort", { effort })}</small>}
    </div>
    <div className="terminal-reader-status-meters">
      {meters.map((meter) => {
        const remaining = Math.round(meter.remaining);
        const readAt = snapshot ? new Date(snapshot.readAt) : clock;
        const countdown = meter.resets ? resetCountdown(meter.resets, clock, readAt) : "";
        return <div key={meter.label} className={`terminal-reader-status-meter${remaining <= 10 ? " low" : ""}`}>
          <div className="terminal-reader-status-meter-head"><span>{meter.label}</span><strong>{t("terminal.reader.status.remaining", { percent: remaining })}</strong></div>
          <div className="terminal-reader-status-track" role="meter" aria-label={meter.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter.remaining} aria-valuetext={t("terminal.reader.status.remaining", { percent: remaining })}>
            <span style={{ width: `${meter.remaining}%` }} />
          </div>
          {meter.detail && <small>{meter.detail}</small>}
          {meter.resets && <small title={resetText(meter.resets, clock, readAt)}>{countdown ? t("mobile.facts.resetIn", { time: countdown }) : t("terminal.reader.status.resets", { time: meter.resets })}</small>}
        </div>;
      })}
    </div>
    <dl className="terminal-reader-status-details">
      {!card && path && <div><dt>{t("terminal.reader.status.directory")}</dt><dd>{path}</dd></div>}
      {!card && tab.sessionId && <div><dt>{t("terminal.reader.status.session")}</dt><dd>{tab.sessionId}</dd></div>}
      {details.map((entry, index) => <div key={`${entry.label}:${index}`}><dt>{FIELD_KEYS[entry.label] ? t(FIELD_KEYS[entry.label]) : entry.label}</dt><dd>{entry.value}</dd></div>)}
    </dl>
    <small className="terminal-reader-status-note">{t("terminal.reader.status.reported")}</small>
    {refreshing && <small role="status">{t("terminal.reader.status.refreshing")}</small>}
    {error && <small role="alert">{t("terminal.reader.status.failed")}</small>}
    {card && <details className="terminal-reader-status-raw"><summary>{t("terminal.reader.status.raw")}</summary><pre>{card.raw}</pre></details>}
  </section>;
}
