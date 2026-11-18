import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { usePaneTab } from "../tabs/paneTabContext";
import { splitPtyId } from "../../lib/terminal/ptyId";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";
import { cliLimitNoticeLine, nextLimitCli, type HandoffCli } from "../../lib/agents/limitHandoff";
import { runsLocally } from "../../stores/agents/agentClearUndo";
import { aiIsOff } from "../../lib/aiSwitch";
import { CliHandoffDialog } from "../agents/CliHandoffDialog";

// Keep a dismissed notice dismissed across pane remounts until it leaves the screen.
const handled = new Set<string>();

export function TerminalLimitHandoff({ ptyId, visible, cwd }: { ptyId: string; visible: boolean; cwd: string }) {
  const parts = splitPtyId(ptyId);
  const scope = parts?.scope;
  const tab = usePaneTab(scope, parts?.key);
  /** The screen line that matched, as the dialog quotes it; null while the dialog is closed. */
  const [line, setLine] = useState<string | null>(null);
  const attempted = useRef(false);
  const identity = `${ptyId}:${tab?.sessionId ?? ""}:${tab?.relaunchSeq ?? 0}`;

  // A different tab, relaunch or hidden pane closes the dialog; a store update to the same tab does not.
  useEffect(() => { setLine(null); }, [identity, visible]);

  useEffect(() => {
    attempted.current = false;
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
        // Only a notice with somewhere to go opens the dialog; it preselects the same next CLI.
        if (!nextLimitCli(tab.cmd, rows, settings?.agent_order, settings?.default_agent_cmd ?? "claude")) return;
        attempted.current = true;
        handled.add(identity);
        setLine(matched);
      } catch { /* Retry a transient registry read on the next screen check. */ }
      finally { checking = false; }
    };
    void check();
    const timer = setInterval(() => void check(), 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [visible, identity, ptyId, scope, tab]);

  if (line === null || !visible || !scope || !tab) return null;
  return <CliHandoffDialog scope={scope} tab={tab} cwd={cwd} line={line} onClose={() => setLine(null)} />;
}
