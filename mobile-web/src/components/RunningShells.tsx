import { useT } from "../../../src/lib/i18n";
import type { RunningShell } from "../api";

/** The shells a chat shows under its working row: one the agent waits on only
 * while it is at work — a call the CLI never answered (killed mid-command) is
 * not a shell at work — a background one while the desktop sees it still
 * running, the agent at work or not. The desktop Reader's rule. */
export function shownShells(shells: readonly RunningShell[] | undefined, waited: boolean): RunningShell[] {
  return (shells ?? []).filter((shell) => shell.background || waited);
}

/** The desktop Reader's "Shell is running…" lines, one per shell: the agent's
 * own few words on what it does and whether it runs in the background. The
 * command line itself never crosses the browser API (it carries host paths and
 * whatever the agent put inline), so the row offers the Terminal view, which
 * shows the screen, in its place. */
export function RunningShells({ shells, untested, onShowTerminal }: {
  shells: readonly RunningShell[];
  untested?: string;
  onShowTerminal?: () => void;
}) {
  return <>
    {shells.map((shell, index) => <ShellRow key={`${shell.at ?? ""}:${shell.description ?? ""}:${index}`} shell={shell} untested={untested} onShowTerminal={onShowTerminal} />)}
  </>;
}

function ShellRow({ shell, untested, onShowTerminal }: { shell: RunningShell; untested?: string; onShowTerminal?: () => void }) {
  const t = useT();
  const summary = shell.description;
  return <div className="transcript-shell-item">
    <div className="transcript-working transcript-shell" role="status">
      <span className="transcript-shell-mark" aria-hidden="true">$</span>
      {t(shell.background ? "terminal.reader.shellBackground" : "terminal.reader.shellWorking")}
      {(summary || untested) && <small className="transcript-working-facts transcript-shell-summary">
        {summary}
        {untested && <em>{summary && " · "}{untested}</em>}
      </small>}
      {onShowTerminal && <button type="button" className="transcript-shell-toggle transcript-shell-terminal" onClick={onShowTerminal}>{t("mobile.focus.shellInTerminal")}</button>}
    </div>
  </div>;
}
