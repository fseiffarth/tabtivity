import { useT } from "../../../src/lib/i18n";
import type { RunningShell } from "../api";

/** The shells a chat shows under its working row: one the agent waits on only
 * while it is at work — a call the CLI never answered (killed mid-command) is
 * not a shell at work — a background one while the desktop sees it still
 * running, the agent at work or not. The desktop Reader's rule. */
export function shownShells(shells: readonly RunningShell[] | undefined, waited: boolean): RunningShell[] {
  return (shells ?? []).filter((shell) => shell.background || waited);
}

/** The desktop Reader's "Shell is running…" lines, one per shell, each with
 * the agent's own few words on what it does. The command line is never sent to
 * the phone (the desktop strips it), so there is nothing to expand. */
export function RunningShells({ shells, untested }: { shells: readonly RunningShell[]; untested?: string }) {
  const t = useT();
  return <>
    {shells.map((shell, index) => (
      <div className="transcript-working transcript-shell" role="status" key={`${shell.at ?? ""}:${shell.description ?? ""}:${index}`}>
        <span className="transcript-shell-mark" aria-hidden="true">$</span>
        {t(shell.background ? "terminal.reader.shellBackground" : "terminal.reader.shellWorking")}
        {(shell.description || untested) && <small className="transcript-working-facts transcript-shell-summary">
          {shell.description}
          {untested && <em>{shell.description && " · "}{untested}</em>}
        </small>}
      </div>
    ))}
  </>;
}
