import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { nextLimitCli, type HandoffCli } from "../../lib/agents/limitHandoff";
import {
  cliHandoffErrorIsFinal,
  cliHandoffErrorKey,
  cliHandoffRequest,
  type CliHandoffPrepared,
  type CliHandoffPreview,
} from "../../lib/agents/cliHandoff";
import { newAgentTabForDraft } from "../../lib/agents/prompt/newTab";
import { aiIsOff } from "../../lib/aiSwitch";
import { Dropdown } from "../common/Dropdown";
import { DialogShell } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";

/** How long a pick settles before its preview is read (the read parses the transcript and runs git). */
const PREVIEW_DELAY_MS = 200;

/**
 * Continue a tab's work in another installed CLI: the one dialog behind the tab
 * menu's "Continue with another CLI…" and the usage-limit notice
 * (`terminal/TerminalLimitHandoff`, which passes the quoted `line`).
 *
 * The backend reads the source conversation itself and writes it to a
 * `HANDOFF.md` in the agent home (`agent_cli_handoff_prepare`); nothing of the
 * conversation crosses IPC or is typed. Continue opens the successor through
 * the "+" menu's own tab spec (resumable, `TAB_UID`, session-id args) with one
 * short prompt naming that file. The source tab is never touched, so a failure
 * keeps this dialog open for another try.
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
  const tabRef = useRef(tab);
  useEffect(() => { tabRef.current = tab; });

  useEffect(() => {
    let stopped = false;
    invoke<HandoffCli[]>("list_agents")
      .then((list) => { if (!stopped) setRows(list); })
      .catch(() => { if (!stopped) setRows([]); });
    return () => { stopped = true; };
  }, []);

  // Every installed CLI but the source's own.
  const targets = useMemo(() => (rows ?? []).filter((row) => row.installed && row.bin !== tab.cmd), [rows, tab.cmd]);
  const settings = useSettingsStore((s) => s.settings);
  const fallback = useMemo(
    () => (rows ? nextLimitCli(tab.cmd, rows, settings?.agent_order, settings?.default_agent_cmd ?? "claude")?.bin : undefined),
    [rows, tab.cmd, settings?.agent_order, settings?.default_agent_cmd],
  );
  const pick = targets.find((row) => row.bin === picked) ?? targets.find((row) => row.bin === fallback) ?? targets[0];
  const sourceLabel = rows?.find((row) => row.bin === tab.cmd)?.label ?? tab.cmd;
  const pickBin = pick?.bin;

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
          const prepared = await invoke<CliHandoffPrepared>("agent_cli_handoff_prepare", cliHandoffRequest(scope, tabRef.current, cwd, pickBin, true));
          if (!stopped) setPreview(prepared.preview);
        } catch (failure) {
          if (stopped) return;
          setError(cliHandoffErrorKey(failure));
          setFinal(cliHandoffErrorIsFinal(failure));
        }
      })();
    }, PREVIEW_DELAY_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [pickBin, scope, cwd]);

  const dismiss = () => { if (!busy) onClose(); };

  // Always the user's click: a line on the screen is the agent's own output, so nothing switches by itself.
  const proceed = async () => {
    if (!pick || busy || aiIsOff()) return;
    setBusy(true);
    setError(null);
    try {
      const source = tabRef.current;
      const prepared = await invoke<CliHandoffPrepared>("agent_cli_handoff_prepare", cliHandoffRequest(scope, source, cwd, pick.bin, false));
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
        initialInput: t("cliHandoff.prompt", { agent: sourceLabel, file: prepared.file }),
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
  ] : [];

  return (
    <DialogShell
      frame="project-dialog"
      title={<>{t(line ? "terminal.limitHandoff.title" : "cliHandoff.title")} {line ? <UntestedTag id="terminal.limitHandoff" /> : <UntestedTag id="agent.cliHandoff" />}</>}
      onDismiss={dismiss}
      closeDisabled={busy}
    >
      <p>{t(line ? "terminal.limitHandoff.body" : "cliHandoff.body", { agent: sourceLabel })}</p>
      {line && <p data-testid="limit-line">{t("terminal.limitHandoff.line", { line })}</p>}
      {rows && targets.length === 0 ? <p>{t("cliHandoff.noTargets")}</p> : (
        <label>
          {t("cliHandoff.pick")}
          <Dropdown
            value={pick?.bin ?? ""}
            options={targets.map((row) => ({ value: row.bin, label: row.label }))}
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
      {error && <p role="alert">{t(error)}</p>}
      <div className="project-dialog-actions">
        <button type="button" disabled={busy} onClick={dismiss}>{t("common.cancel")}</button>
        <button type="button" className="btn-primary" disabled={busy || !pick || final || aiIsOff()} onClick={() => void proceed()}>
          {t("cliHandoff.continue", { next: pick?.label ?? "" })}
        </button>
      </div>
    </DialogShell>
  );
}
