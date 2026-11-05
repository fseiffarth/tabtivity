import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { useModalFocus } from "../../hooks/useModalFocus";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { usePaneTab } from "../tabs/paneTabContext";
import { splitPtyId } from "../../lib/terminal/ptyId";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";
import { cliLimitNoticeLine, nextLimitCli, type HandoffCli } from "../../lib/agents/limitHandoff";
import { runsLocally } from "../../stores/agents/agentClearUndo";
import { readerRequest, type SessionTranscript } from "../../lib/agents/agentReader";
import { aiIsOff } from "../../lib/aiSwitch";
import { UntestedTag } from "../common/UntestedTag";

// Keep a dismissed notice dismissed across pane remounts until it leaves the screen.
const handled = new Set<string>();

export function TerminalLimitHandoff({ ptyId, visible, cwd }: { ptyId: string; visible: boolean; cwd: string }) {
  const t = useT();
  const parts = splitPtyId(ptyId);
  const scope = parts?.scope;
  const tab = usePaneTab(scope, parts?.key);
  const [next, setNext] = useState<HandoffCli | null>(null);
  /** The screen line that matched, as the dialog quotes it. */
  const [line, setLine] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false);
  const dismiss = () => { if (!busy) setNext(null); };
  const modal = useModalFocus(dismiss, !!next && visible);
  const identity = `${ptyId}:${tab?.sessionId ?? ""}:${tab?.relaunchSeq ?? 0}`;

  // Always the user's click: a line on the screen is the agent's own output, so it never switches by itself.
  const handoff = async (target: HandoffCli) => {
    if (!parts || !tab || aiIsOff()) return;
    setBusy(true);
    setFailed(false);
    try {
      const request = readerRequest(parts.scope, tab, cwd, undefined, 30);
      if (!request) throw new Error("no transcript");
      const transcript = await invoke<SessionTranscript>("agent_tab_transcript", request);
      if (!transcript.available || !transcript.entries.some((entry) => entry.kind === "prompt")) throw new Error("no conversation");
      const context = JSON.stringify(transcript.entries.filter((entry) => entry.kind === "prompt" || entry.kind === "answer")
        .slice(-20).map((entry) => ({ role: entry.kind, text: entry.text.slice(-1200) })));
      if (aiIsOff()) return;
      useTabsStore.getState().addTabToScope(parts.scope, {
        label: target.label, cmd: target.bin, args: [], env: {}, kind: "agent",
        cwd: tab.cwd || cwd, location: tab.location,
        initialInput: t("terminal.limitHandoff.prompt", { agent: tab.cmd, context }).replace(/\r?\n/g, " "),
      });
      setNext(null);
    } catch {
      setFailed(true);
      setNext(target);
    } finally { setBusy(false); }
  };

  useEffect(() => {
    attempted.current = false;
    setNext(null);
    setFailed(false);
    setLine("");
    if (!visible || !scope || !tab || tab.kind !== "agent" || tab.assistant || !runsLocally(scope, tab)) return;
    let stopped = false;
    let checking = false;
    const check = async () => {
      if (checking || aiIsOff()) return;
      const term = terminalFor(ptyId);
      if (!term) return;
      const matched = cliLimitNoticeLine(readableScreen(term.buffer.active, 25, { plain: true }).lines.join("\n"));
      if (matched === null) {
        handled.delete(identity);
        attempted.current = false;
        return;
      }
      if (attempted.current || handled.has(identity)) return;
      checking = true;
      try {
        const rows = await invoke<HandoffCli[]>("list_agents");
        if (stopped) return;
        const settings = useSettingsStore.getState().settings;
        const target = nextLimitCli(tab.cmd, rows, settings?.agent_order, settings?.default_agent_cmd ?? "claude");
        if (!target) return;
        attempted.current = true;
        handled.add(identity);
        setLine(matched);
        setNext(target);
      } catch { /* Retry a transient registry read on the next screen check. */ }
      finally { checking = false; }
    };
    void check();
    const timer = setInterval(() => void check(), 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [visible, identity, ptyId, scope, tab]);

  if (!next || !visible) return null;
  return createPortal(<div className="modal-backdrop" onClick={dismiss}>
    <div className="project-dialog" ref={modal} role="dialog" aria-modal="true" aria-labelledby="cli-limit-title" style={{ color: "var(--text-primary)" }} onClick={(event) => event.stopPropagation()}>
      <h2 id="cli-limit-title">{t("terminal.limitHandoff.title")} <UntestedTag id="terminal.limitHandoff" /></h2>
      <p>{t("terminal.limitHandoff.body", { agent: tab?.cmd ?? "", next: next.label })}</p>
      {line && <p data-testid="limit-line">{t("terminal.limitHandoff.line", { line })}</p>}
      {failed && <p role="alert">{t("terminal.limitHandoff.failed")}</p>}
      <div className="project-dialog-actions">
        <button type="button" disabled={busy} onClick={dismiss}>{t("common.cancel")}</button>
        <button type="button" disabled={busy} onClick={() => void handoff(next)}>{t("terminal.limitHandoff.switch", { next: next.label })}</button>
      </div>
    </div>
  </div>, document.body);
}
