import { useId, useState } from "react";
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
 * own few words on what it does (else the command's first line), and on a tap
 * the whole command, as the desktop Reader's line opens it. */
export function RunningShells({ shells, untested }: { shells: readonly RunningShell[]; untested?: string }) {
  return <>
    {shells.map((shell, index) => <ShellRow key={`${shell.at ?? ""}:${shell.description ?? ""}:${index}`} shell={shell} untested={untested} />)}
  </>;
}

function ShellRow({ shell, untested }: { shell: RunningShell; untested?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const commandId = useId();
  const summary = shell.description || shell.command.split("\n", 1)[0];
  return <div className="transcript-shell-item">
    <div className="transcript-working transcript-shell" role="status">
      <span className="transcript-shell-mark" aria-hidden="true">$</span>
      {t(shell.background ? "terminal.reader.shellBackground" : "terminal.reader.shellWorking")}
      {(summary || untested) && <small className="transcript-working-facts transcript-shell-summary">
        {summary}
        {untested && <em>{summary && " · "}{untested}</em>}
      </small>}
      {shell.command && <button type="button" className="transcript-shell-toggle" aria-expanded={open} aria-controls={commandId}
        aria-label={t(open ? "terminal.reader.shellHide" : "terminal.reader.shellShow")} title={t(open ? "terminal.reader.shellHide" : "terminal.reader.shellShow")}
        onClick={() => setOpen((shown) => !shown)}><span aria-hidden="true">{open ? "▴" : "▾"}</span></button>}
    </div>
    {open && shell.command && <pre id={commandId} className="transcript-shell-command">{shell.command}{shell.cut && "…"}</pre>}
  </div>;
}
