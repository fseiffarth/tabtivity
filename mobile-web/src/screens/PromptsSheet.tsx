import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  createPrompt,
  deletePrompt,
  getPrompts,
  sendPrompt,
  updatePrompt,
  type ProjectPrompt,
  type ProjectPromptList,
  type TabRow,
  wasApplied,
} from "../api";
import { describeFailure } from "../connection";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";

/** The project's collected prompts — text kept without a tab. Sending aims
 * one at an agent tab now (the desktop queues a one-time schedule at its own
 * current minute); Schedule hands the text to the per-tab schedule sheet. The
 * phone never learns project paths or tmux names: only opaque ids cross. */
export function PromptsSheet({ projectId, tabs, onClose, onSchedule }: {
  projectId: string;
  tabs: TabRow[];
  onClose: () => void;
  onSchedule: (tab: TabRow, message: string) => void;
}) {
  const t = useT();
  const agentTabs = tabs.filter((tab) => tab.kind === "agent" && tab.available);
  const [prompts, setPrompts] = useState<ProjectPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [targetId, setTargetId] = useState("");
  const target = agentTabs.find((tab) => tab.id === targetId) ?? agentTabs[0];

  const apply = useCallback((value: ProjectPromptList) => {
    setPrompts(value.prompts ?? []);
    // Listed off the host's files with no window open: the Mobile host
    // writes them itself (headless owner plan, H3); the note says so.
    setOffline(value.desktop_available === false);
    setError("");
  }, []);
  const fail = useCallback((cause: unknown) => {
    // Made on the desktop, only the refreshed list did not come back: say so,
    // rather than "could not be loaded" under a form that invites a resend.
    if (wasApplied(cause)) {
      setError(describeFailure(cause));
      return;
    }
    const unavailable = cause instanceof ApiError && (cause.status === 503 || cause.code === "desktop_unavailable");
    setOffline(unavailable);
    setError(t(unavailable ? "mobile.prompts.openDesktop" : "mobile.prompts.loadFailed"));
  }, [t]);
  // Held only when the host itself could not answer (a 503): with the window
  // closed the host writes the prompts itself (headless owner plan, H3).
  const held = offline && !!error;
  const refresh = useCallback(
    () => getPrompts(projectId).then(apply, fail).finally(() => setLoading(false)),
    [apply, fail, projectId],
  );
  useEffect(() => {
    // Gated like the project screen's poll: a sheet left open when the screen
    // went off kept a desktop round trip going every 5s all night.
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
    };
    void refresh();
    const timer = window.setInterval(tick, 5_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  const reset = () => {
    setEditing(null);
    setMessage("");
  };
  const save = async () => {
    if (!message.trim()) {
      setError(t("mobile.prompts.enterPrompt"));
      return;
    }
    setBusy(true);
    try {
      apply(editing ? await updatePrompt(projectId, editing, message) : await createPrompt(projectId, message));
      reset();
    } catch (cause) {
      if (wasApplied(cause)) reset();
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const send = async (prompt: ProjectPrompt) => {
    if (!target) return;
    setBusy(true);
    setNotice("");
    try {
      apply(await sendPrompt(projectId, prompt.id, target.id));
      setNotice(t("mobile.prompts.queued", { tab: target.label }));
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={t("agentPrompts.heading")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("common.close")}>✕</button><h2>{t("agentPrompts.heading")} {isUntested("mobile.sheet.prompts") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">{t("mobile.prompts.note")}</p>
      {agentTabs.length > 0
        ? <label className="mobile-prompt-target">{t("agentPrompts.target")}<select value={target?.id ?? ""} disabled={held} onChange={(event) => setTargetId(event.target.value)}>{agentTabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.label}</option>)}</select></label>
        : <p className="sheet-note">{t("mobile.prompts.openAgentTab")}</p>}
      {notice && <p className="sheet-note" role="status">{notice}</p>}
      {error && <p className="sheet-note error" role="alert">{error}</p>}
      {offline && !error && <p className="sheet-note" role="status">{t("mobile.headless.owner")} {isUntested("mobile.headless.prompts") && <span className="untested">{t("mobile.newTab.untested")}</span>}</p>}
      {loading ? <p className="sheet-note">{t("mobile.prompts.loading")}</p> : prompts.length === 0 ? <p className="sheet-note">{t("mobile.prompts.empty")}</p> : <div className="mobile-schedule-list">{prompts.map((prompt) => <article key={prompt.id}>
        <p>{prompt.message}</p>
        <div>
          <button className="primary" disabled={busy || held || !target} onClick={() => void send(prompt)} aria-label={t("mobile.prompts.sendNowAria", { message: prompt.message })}>{t("agentPrompts.send")}</button>
          <button disabled={busy || held || !target} onClick={() => target && onSchedule(target, prompt.message)}>{t("agentPrompts.schedule")}</button>
          <button disabled={busy || held} onClick={() => { setEditing(prompt.id); setMessage(prompt.message); }}>{t("common.edit")}</button>
          <button className="danger" disabled={busy || held} onClick={() => { setBusy(true); void deletePrompt(projectId, prompt.id).then(apply, fail).finally(() => setBusy(false)); }}>{t("common.delete")}</button>
        </div>
      </article>)}</div>}
      <div className="mobile-schedule-form" aria-disabled={held}>
        <h3>{t(editing ? "mobile.prompts.edit" : "agentPrompts.add")}</h3>
        <label>{t("agentSchedule.message")}<textarea rows={4} value={message} disabled={held} onChange={(event) => setMessage(event.target.value)} /></label>
        <div className="mobile-schedule-actions">{editing && <button disabled={busy} onClick={reset}>{t("common.cancel")}</button>}<button className="primary" disabled={busy || held} onClick={() => void save()}>{t(busy ? "common.saving" : "common.save")}</button></div>
      </div>
    </section>
  </div>;
}
