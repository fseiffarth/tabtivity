import { useEffect, useState } from "react";
import { getTranscript, type TabRow, type TranscriptEntry } from "../api";
import { openSubagent, subagentAtWork, subagentsIn, type SubagentStep } from "../terminal/subagents";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";

/** As many turns as the Reader first reads (`Terminal`'s TRANSCRIPT_STEP), so
 * the siblings the opened subagent's bar steps through are the Reader's own. */
const SESSION_TURNS = 120;
const POLL = 5_000;

/** The subagents of one agent tab's session, reached from its card's
 * subagent pill: newest first, the ones at work marked, and a tap opens the
 * session straight on that subagent's own conversation (`onOpen`). Read off
 * the stored session as the Reader reads it — only opaque handles cross. */
export function SubagentsSheet({ tab, onClose, onOpen }: {
  tab: TabRow;
  onClose: () => void;
  onOpen: (step: SubagentStep) => void;
}) {
  const t = useT();
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stopped = false;
    let version: string | undefined;
    let inflight: AbortController | undefined;
    // Gated like the prompts sheet: a sheet left open with the screen off
    // must not keep a desktop round trip going.
    const read = () => {
      if (stopped || document.visibilityState === "hidden") return;
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      void getTranscript(tab.id, version, SESSION_TURNS, controller.signal).then(
        (next) => {
          if (stopped || controller.signal.aborted || next.unchanged) return;
          version = next.version;
          setFailed(!next.available);
          setEntries(next.available ? next.entries : []);
        },
        () => {
          if (stopped || controller.signal.aborted) return;
          setFailed(true);
          setEntries((current) => current ?? []);
        },
      );
    };
    read();
    const timer = window.setInterval(read, POLL);
    document.addEventListener("visibilitychange", read);
    return () => {
      stopped = true;
      inflight?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
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
          {refs.map((ref, index) => ({ ref, index })).reverse().map(({ ref, index }) => <button type="button" key={`${ref.token}:${index}`} aria-label={`${ref.role ?? t("mobile.subagent.region")} · ${ref.task}`} onClick={() => onOpen(openSubagent([], ref, entries, -1)[0])}>
            <small>{ref.role ?? t("mobile.subagent.region")}{subagentAtWork(ref, busy) && <em> · {t("mobile.subagentSheet.atWork")}</em>}</small>
            <span>{ref.task}</span>
          </button>)}
        </div>}
    </section>
  </div>;
}
