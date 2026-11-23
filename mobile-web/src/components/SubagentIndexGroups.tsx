import { useState } from "react";
import { useT } from "../../../src/lib/i18n";
import type { TranscriptEntry } from "../api";
import { splitByWork } from "../terminal/subagents";
import { AgentStatusMark } from "./AgentStatusPill";

const GROUPS = [["running", "mobile.subagent.running"], ["finished", "mobile.subagent.finished"]] as const;

/**
 * The session's subagents in their Running and Finished groups
 * (`splitByWork`), each a row that opens the subagent's conversation: the
 * chat's index strip and the landscape iPad's session overview
 * (`ChatOverview`) draw the same rows inside a `.subagent-index-list`.
 * `finishedCap` keeps the Finished group to its newest few, with a Show all
 * that expands in place.
 */
export function SubagentIndexGroups({ agents, busy, onOpen, finishedCap }: {
  agents: readonly TranscriptEntry[];
  /** The session is in a turn: what has not reported back is still running. */
  busy: boolean;
  onOpen: (entry: TranscriptEntry) => void;
  finishedCap?: number;
}) {
  const t = useT();
  const [all, setAll] = useState(false);
  const groups = splitByWork(agents, busy);
  return <>{GROUPS.map(([group, heading]) => {
    const rows = groups[group];
    if (rows.length === 0) return null;
    const capped = group === "finished" && finishedCap !== undefined && !all && rows.length > finishedCap;
    // The list runs oldest first: the newest few are its end.
    const shown = capped ? rows.slice(-finishedCap) : rows;
    const title = t(heading, { count: rows.length });
    return <section key={group} className="subagent-index-group" aria-label={title}>
      <h3 className="subagent-index-head">{title}</h3>
      {shown.map((entry, index) => {
        const status = group === "running" ? "working" : entry.finished ? "done" : null;
        return <button type="button" key={`${entry.at ?? index}:${index}`} className={status ? "has-status" : undefined} disabled={!entry.subagent} aria-label={`${entry.role ?? t("mobile.subagent.region")} · ${entry.text}`} onClick={() => onOpen(entry)}>
          <small>{entry.role ?? t("mobile.subagent.region")}</small>
          <span>{entry.text}{entry.cut && "…"}</span>
          {status && <AgentStatusMark status={status} />}
        </button>;
      })}
      {capped && <button type="button" className="chat-overview-more" onClick={() => setAll(true)}>{t("mobile.chatOverview.showAll", { count: rows.length })}</button>}
    </section>;
  })}</>;
}
