import { useState } from "react";

import type { RosterRow } from "../../lib/cockpit/roster";
import { useT } from "../../lib/i18n";
import { clearTabMessages, deliverTabMessages } from "../../lib/window/tabsMcp";
import { queuePromptForTab } from "../../stores/agents/agentPrompts";
import { useProjectsStore } from "../../stores/projects";
import { unreadFor, useTabMessages } from "../../stores/tabMessages";
import { useTabsStore } from "../../stores/tabs";
import { useDialogs } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";
import { formatClock } from "./cockpitFormat";

/** Backend refusals of `tabs_mcp_deliver` the fold says in words. */
const DELIVER_ERRORS = ["off", "nothing_unread", "not_found"] as const;

/**
 * The Messages fold of the cockpit detail pane (`services::tabs_mcp`): every
 * message the shown tab sent or received, with sender, recipient, time and
 * the full text. The text is the sending agent's: plain React text, never
 * markup or a link, and never typed into a prompt. Deliver queues the host's
 * fixed notice (asking the tab to read its inbox) through the scheduler's
 * idle gate; Clear empties the project's mailbox. Project agent tabs only:
 * root, box and Tabby tabs are never on the lane.
 */
export function CockpitMessages({ row }: { row: RosterRow }) {
  const t = useT();
  const scope = row.scope.kind === "project" ? row.scope.id : undefined;
  const tabId = row.tab.id;
  const all = useTabMessages(scope, !!tabId);
  const tabs = useTabsStore((s) => (scope ? s.tabsByScope[scope] : undefined));
  const projectName = useProjectsStore((s) => s.projects.find((p) => p.id === scope)?.name ?? "");
  const { confirmAction, dialogs } = useDialogs();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  if (!scope || !tabId) return null;
  const messages = all.filter((m) => m.toTab === tabId || m.fromTab === tabId);
  if (messages.length === 0) return null;
  const unread = unreadFor(messages, tabId);
  const labelOf = (id: string) => tabs?.find((tab) => tab.id === id)?.label ?? t("tabsMcp.closedTab");

  const deliver = async () => {
    setBusy(true);
    try {
      const { notice, scheduleTargetId } = await deliverTabMessages(scope, tabId);
      await queuePromptForTab(scope, scheduleTargetId, notice);
      setStatus(t("tabsMcp.delivered"));
    } catch (error) {
      const code = String(error);
      const known = DELIVER_ERRORS.find((c) => c === code);
      setStatus(known ? t(`tabsMcp.error.${known}`) : code);
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    const ok = await confirmAction({
      title: t("tabsMcp.clearTitle"),
      body: t("tabsMcp.clearBody", { project: projectName }),
      confirmLabel: t("tabsMcp.clear"),
      danger: true,
    });
    if (!ok) return;
    await clearTabMessages(scope).catch(() => 0);
    setStatus("");
  };

  return (
    <details className="cockpit-detail-fold cockpit-agent-note" open={unread > 0}>
      <summary>
        {t("tabsMcp.fold", { count: messages.length })}
        {unread > 0 && <> · {t("tabsMcp.unreadCount", { count: unread })}</>} <UntestedTag id="tabs.mcp.traffic" />
      </summary>
      <p className="cockpit-meta">{t("tabsMcp.authored")}</p>
      {messages.map((m) => {
        const incoming = m.toTab === tabId;
        const other = labelOf(incoming ? m.fromTab : m.toTab);
        return (
          <div key={m.id} className="cockpit-note-field">
            <span className="cockpit-note-tag">
              {t(incoming ? "tabsMcp.from" : "tabsMcp.to", { tab: other })}
            </span>{" "}
            <span className="cockpit-meta">
              {formatClock(Date.parse(m.sentAt))} · {t(m.read ? "tabsMcp.read" : "tabsMcp.unread")}
            </span>
            <p className="cockpit-note-text">{m.text}</p>
          </div>
        );
      })}
      <p>
        <button
          type="button"
          className="settings-btn sm"
          disabled={busy || unread === 0}
          title={t("tabsMcp.deliverTitle")}
          onClick={() => void deliver()}
        >
          {t("tabsMcp.deliver")}
        </button>{" "}
        <UntestedTag id="tabs.mcp.deliver" />{" "}
        <button type="button" className="btn-quiet is-danger" onClick={() => void clear()}>
          {t("tabsMcp.clear")}
        </button>
      </p>
      {status && <p className="cockpit-meta" role="status">{status}</p>}
      {dialogs}
    </details>
  );
}
