import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useActivityStore } from "../../stores/activity";
import { nextLimitCli, type HandoffCli } from "../../lib/agents/limitHandoff";
import {
  cliHandoffErrorIsFinal,
  cliHandoffErrorKey,
  cliHandoffRequest,
  newSummaryNonce,
  SUMMARY_MIN_CACHE_LEFT_MS,
  SUMMARY_POLL_MS,
  SUMMARY_WAIT_MS,
  summaryCacheLeftMs,
  summaryMarker,
  type CliHandoffPrepared,
  type CliHandoffPreview,
} from "../../lib/agents/cliHandoff";
import { sendSteeringPrompt } from "../../lib/shortcuts/steeringAgent";
import { newAgentTabForDraft } from "../../lib/agents/prompt/newTab";
import { aiIsOff } from "../../lib/aiSwitch";
import { Dropdown } from "../common/Dropdown";
import { DialogShell } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";

/** How long a pick settles before its preview is read (the read parses the transcript and runs git). */
const PREVIEW_DELAY_MS = 200;

/** Where the summary prompt stands. */
type SummaryState = "idle" | "waiting" | "timeout" | "sendFailed";

/**
 * Continue a tab's work in a fresh session: the one dialog behind the tab
 * menu's "Continue in a new session…" (the source's own CLI preselected) and
 * the usage-limit notice (`terminal/TerminalLimitHandoff`, which passes the
 * quoted `line`; another CLI only, since a fresh session hits the same limit).
 *
 * The backend reads the source conversation itself and writes it to a
 * `HANDOFF.md` in the agent home (`agent_cli_handoff_prepare`); nothing of the
 * conversation crosses IPC or is typed. Continue opens the successor through
 * the "+" menu's own tab spec (resumable, `TAB_UID`, session-id args) with one
 * short prompt naming that file. The source tab is never touched, so a failure
 * keeps this dialog open for another try.
 *
 * While the source's prompt cache is warm, Continue can first ask the source
 * session for a summary of its own work (`docs/session_memory_handoff_plan.md`):
 * one prompt carrying a random marker, then the backend is asked every
 * `SUMMARY_POLL_MS` whether the answer after that marker has come, and the file
 * gets it as the previous agent's unchecked claims. Past `SUMMARY_WAIT_MS`, or
 * on Continue without it, the file is the chat text alone.
 */
export function CliHandoffDialog({
  scope,
  tab,
  cwd,
  line,
  onClose,
}: {
  scope: string;
  tab: TabEntry;
  cwd: string;
  /** The screen line a usage-limit notice matched; quoted when present. */
  line?: string;
  onClose: () => void;
}) {
  const t = useT();
  const [rows, setRows] = useState<HandoffCli[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [preview, setPreview] = useState<CliHandoffPreview | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [final, setFinal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);
  const [askSummary, setAskSummary] = useState(true);
  const [summaryState, setSummaryState] = useState<SummaryState>("idle");
  const tabRef = useRef(tab);
  useEffect(() => { tabRef.current = tab; });
  /** The nonce of the summary prompt once it went in: every later prepare names it. */
  const sentNonce = useRef<string | undefined>(undefined);
  const wait = useRef({ skip: false, closed: false });

  useEffect(() => {
    let stopped = false;
    invoke<HandoffCli[]>("list_agents")
      .then((list) => { if (!stopped) setRows(list); })
      .catch(() => { if (!stopped) setRows([]); });
    return () => { stopped = true; };
  }, []);

  // From the tab menu: the source's own CLI first (a fresh session of it), then
  // every other installed CLI. From a limit notice: the other CLIs only.
  const sameAllowed = !line;
  const targets = useMemo(() => {
    const installed = (rows ?? []).filter((row) => row.installed && (sameAllowed || row.bin !== tab.cmd));
    return [...installed.filter((row) => row.bin === tab.cmd), ...installed.filter((row) => row.bin !== tab.cmd)];
  }, [rows, tab.cmd, sameAllowed]);
  const settings = useSettingsStore((s) => s.settings);
  const fallback = useMemo(
    () => (rows ? nextLimitCli(tab.cmd, rows, settings?.agent_order, settings?.default_agent_cmd ?? "claude")?.bin : undefined),
    [rows, tab.cmd, settings?.agent_order, settings?.default_agent_cmd],
  );
  const preferred = sameAllowed ? tab.cmd : fallback;
  const pick = targets.find((row) => row.bin === picked) ?? targets.find((row) => row.bin === preferred) ?? targets[0];
  const sourceLabel = rows?.find((row) => row.bin === tab.cmd)?.label ?? tab.cmd;
  const pickBin = pick?.bin;
  const targetLabel = (row: HandoffCli) => (row.bin === tab.cmd ? t("cliHandoff.sameCli", { agent: row.label }) : row.label);

  // Re-read the counts when the pick changes, once it has settled.
  useEffect(() => {
    setPreview(null);
    setError(null);
    setFinal(false);
    if (!pickBin) return;
    let stopped = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const prepared = await invoke<CliHandoffPrepared>("agent_cli_handoff_prepare", cliHandoffRequest(scope, tabRef.current, cwd, pickBin, true, sentNonce.current));
          if (stopped) return;
          setPreview(prepared.preview);
          setNow(Date.now());
        } catch (failure) {
          if (stopped) return;
          setError(cliHandoffErrorKey(failure));
          setFinal(cliHandoffErrorIsFinal(failure));
        }
      })();
    }, PREVIEW_DELAY_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [pickBin, scope, cwd]);

  useEffect(() => () => { wait.current.closed = true; }, []);

  const waiting = summaryState === "waiting";
  // Closing while the summary is awaited only stops the wait: the prompt has gone in either way.
  const dismiss = () => {
    if (busy && !waiting) return;
    wait.current.closed = true;
    onClose();
  };

  const cacheLeft = line ? null : summaryCacheLeftMs(preview?.cache, now);
  const summaryOffered = cacheLeft !== null && cacheLeft >= SUMMARY_MIN_CACHE_LEFT_MS && summaryState === "idle" && !sentNonce.current;
  const cacheCold = cacheLeft !== null && cacheLeft < SUMMARY_MIN_CACHE_LEFT_MS && summaryState === "idle";

  /** Until the source session's answer to the summary prompt is in its
   * conversation and its turn is over; `false` past the wait, on skip or close. */
  const waitForSummary = async (nonce: string, target: string): Promise<boolean> => {
    const ptyId = `${scope}:${tabRef.current.key}`;
    const deadline = Date.now() + SUMMARY_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SUMMARY_POLL_MS));
      if (wait.current.closed || wait.current.skip) return false;
      const activity = useActivityStore.getState();
      if (activity.busyByTab[ptyId] && activity.busyKindByTab[ptyId] !== "shell") continue;
      try {
        const prepared = await invoke<CliHandoffPrepared>("agent_cli_handoff_prepare", cliHandoffRequest(scope, tabRef.current, cwd, target, true, nonce));
        if (prepared.preview.summary) return true;
      } catch { /* not readable this time: keep waiting */ }
    }
    return false;
  };

  // Always the user's click: a line on the screen is the agent's own output, so nothing switches by itself.
  const proceed = async () => {
    if (!pick || busy || aiIsOff()) return;
    setBusy(true);
    setError(null);
    try {
      const source = tabRef.current;
      if (summaryOffered && askSummary) {
        const nonce = newSummaryNonce();
        try {
          await sendSteeringPrompt(source, `${summaryMarker(nonce)} ${t("cliHandoff.summaryPrompt")}`);
        } catch {
          setSummaryState("sendFailed");
          return;
        }
        sentNonce.current = nonce;
        wait.current.skip = false;
        setSummaryState("waiting");
        const got = await waitForSummary(nonce, pick.bin);
        if (wait.current.closed) return;
        if (!got && !wait.current.skip) {
          setSummaryState("timeout");
          return;
        }
        setSummaryState("idle");
        if (aiIsOff()) return;
      }
      const prepared = await invoke<CliHandoffPrepared>("agent_cli_handoff_prepare", cliHandoffRequest(scope, source, cwd, pick.bin, false, sentNonce.current));
      if (!prepared.file) throw new Error("no_file");
      if (aiIsOff()) return;
      // The "+" menu's own tab spec: session id, tab uid env and session-id args, so the tab is
      // resumable (kept at restart) and the Reader can find its conversation. Auto tab names cover the label.
      const { tab: spec } = newAgentTabForDraft({
        agent: pick.bin, customAgents: useSettingsStore.getState().settings?.custom_agents,
        cwd: source.cwd || cwd, projectName: "", t,
      });
      useTabsStore.getState().addTabToScope(scope, {
        ...spec, location: source.location,
        initialInput: t(pick.bin === source.cmd ? "cliHandoff.promptSame" : "cliHandoff.prompt", { agent: sourceLabel, file: prepared.file }),
      });
      onClose();
    } catch (failure) {
      setError(cliHandoffErrorKey(failure));
      setFinal(cliHandoffErrorIsFinal(failure));
    } finally { setBusy(false); }
  };

  const facts: string[] = preview ? [
    t("cliHandoff.preview.entries", { entries: preview.entries, total: preview.total }),
    ...(preview.truncated ? [t("cliHandoff.preview.truncated")] : []),
    t(preview.firstRequest ? "cliHandoff.preview.firstRequest" : "cliHandoff.preview.noFirstRequest"),
    t("cliHandoff.preview.changedFiles", { count: preview.changedFiles }),
    ...(preview.notes ? [t("cliHandoff.preview.notes")] : []),
    ...(preview.summary ? [t("cliHandoff.preview.summary", { agent: sourceLabel })] : []),
  ] : [];

  return (
    <DialogShell
      frame="project-dialog"
      title={<>{t(line ? "terminal.limitHandoff.title" : "cliHandoff.title")} {line ? <UntestedTag id="terminal.limitHandoff" /> : <UntestedTag id="agent.cliHandoff" />}</>}
      onDismiss={dismiss}
      closeDisabled={busy && !waiting}
    >
      <p>{t(line ? "terminal.limitHandoff.body" : "cliHandoff.body", { agent: sourceLabel })}</p>
      {line && <p data-testid="limit-line">{t("terminal.limitHandoff.line", { line })}</p>}
      {rows && targets.length === 0 ? <p>{t("cliHandoff.noTargets")}</p> : (
        <label>
          {t("cliHandoff.pick")}
          <Dropdown
            value={pick?.bin ?? ""}
            options={targets.map((row) => ({ value: row.bin, label: targetLabel(row) }))}
            onChange={setPicked}
            disabled={busy || !pick}
            ariaLabel={t("cliHandoff.pick")}
          />
        </label>
      )}
      {facts.length > 0 && (
        <div data-testid="cli-handoff-preview">
          {facts.map((fact) => <div key={fact} className="project-dialog-path">{fact}</div>)}
        </div>
      )}
      {(summaryOffered || waiting) && (
        <label className="cli-handoff-summary">
          <input type="checkbox" checked={askSummary} disabled={busy} onChange={(event) => setAskSummary(event.target.checked)} />
          <span>
            <span>{t("cliHandoff.summary.ask", { agent: sourceLabel })} <UntestedTag id="agent.cliHandoffSummary" /></span>
            <small className="settings-help">{t("cliHandoff.summary.warm", { minutes: Math.floor((cacheLeft ?? 0) / 60_000) })}</small>
          </span>
        </label>
      )}
      {cacheCold && <p className="project-dialog-path">{t("cliHandoff.summary.cold", { agent: sourceLabel })}</p>}
      {waiting && <p role="status">{t("cliHandoff.summary.waiting", { agent: sourceLabel })}</p>}
      {summaryState === "timeout" && <p role="status">{t("cliHandoff.summary.timeout")}</p>}
      {summaryState === "sendFailed" && <p role="alert">{t("cliHandoff.summary.sendFailed", { agent: sourceLabel })}</p>}
      {error && <p role="alert">{t(error)}</p>}
      <div className="project-dialog-actions">
        <button type="button" disabled={busy && !waiting} onClick={dismiss}>{t("common.cancel")}</button>
        {waiting ? (
          <button type="button" className="btn-primary" onClick={() => { wait.current.skip = true; }}>
            {t("cliHandoff.summary.skip")}
          </button>
        ) : (
          <button type="button" className="btn-primary" disabled={busy || !pick || final || aiIsOff()} onClick={() => void proceed()}>
            {t("cliHandoff.continue", { next: pick ? targetLabel(pick) : "" })}
          </button>
        )}
      </div>
    </DialogShell>
  );
}
