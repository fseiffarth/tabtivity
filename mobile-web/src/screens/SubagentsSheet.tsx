import { useEffect, useState } from "react";
import { getTranscript, type TabRow, type TranscriptEntry } from "../api";
import { openSubagent, splitByWork, subagentsIn, type SubagentStep } from "../terminal/subagents";
import { WorktreeChip, worktreeTitle } from "../components/AgentModeMarks";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { useBackLayer } from "../backStack";
import { startVisiblePoll } from "../visiblePoll";

/** As many turns as the Reader first reads (`Terminal`'s TRANSCRIPT_STEP), so
 * the siblings the opened subagent's bar steps through are the Reader's own. */
const SESSION_TURNS = 120;
const POLL = 5_000;

/** The subagents of one agent tab's session, reached from its card's
 * subagent pill: the ones at work above the finished, newest first in each,
 * and a tap opens the session straight on that subagent's own conversation
 * (`onOpen`). Read off
 * the stored session as the Reader reads it — only opaque handles cross. */
export function SubagentsSheet({ tab, onClose, onOpen }: {
  tab: TabRow;
  onClose: () => void;
  onOpen: (step: SubagentStep) => void;
}) {
  useBackLayer(onClose);
  const t = useT();
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let version: string | undefined;
    // Gated like the prompts sheet: a sheet left open with the screen off
    // must not keep a desktop round trip going.
    return startVisiblePoll((signal) => getTranscript(tab.id, version, SESSION_TURNS, signal).then(
      (next) => {
        if (signal.aborted || next.unchanged) return;
        version = next.version;
        setFailed(!next.available);
        setEntries(next.available ? next.entries : []);
      },
      () => {
        if (signal.aborted) return;
        setFailed(true);
        setEntries((current) => current ?? []);
      },
    ), POLL).stop;
  }, [tab.id]);

  const refs = entries ? subagentsIn(entries) : [];
  const busy = tab.agent_status === "working";
  const untested = isUntested("mobile.project.subagentList");
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet subagents-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.subagentSheet.title", { label: tab.label })} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("common.close")}>✕</button><h2>{t("mobile.subagentSheet.title", { label: tab.label })} {untested && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      {entries === null
        ? <p className="sheet-note" role="status">{t("mobile.subagentSheet.loading")}</p>
        : refs.length === 0
        ? <p className={failed ? "sheet-note error" : "sheet-note"} role={failed ? "alert" : "status"}>{t(failed ? "mobile.subagentSheet.failed" : "mobile.subagentSheet.none")}</p>
        : <div className="subagent-index-list">
          {([["running", "mobile.subagent.running"], ["finished", "mobile.subagent.finished"]] as const).map(([group, heading]) => {
            const rows = splitByWork(refs, busy)[group];
            if (rows.length === 0) return null;
            const title = t(heading, { count: rows.length });
            return <section key={group} className="subagent-index-group" aria-label={title}>
              <h3 className="subagent-index-head">{title}</h3>
              {[...rows].reverse().map((ref, index) => <button type="button" key={`${ref.token}:${index}`} aria-label={`${ref.role ?? t("mobile.subagent.region")} · ${ref.task}`} onClick={() => onOpen(openSubagent([], ref, entries, -1)[0])}>
                <small>{ref.role ?? t("mobile.subagent.region")}{group === "running" && <em> · {t("mobile.subagentSheet.atWork")}</em>}</small>
                <span>{ref.task}</span>
                {ref.worktree && <WorktreeChip worktree={ref.worktree} title={worktreeTitle(t, ref.worktree)} />}
              </button>)}
            </section>;
          })}
        </div>}
    </section>
  </div>;
}
