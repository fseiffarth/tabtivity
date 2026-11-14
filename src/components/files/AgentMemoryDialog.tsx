import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { DialogShell } from "../common/PromptDialogs";
import { ErrorNote } from "../common/ErrorNote";
import { UntestedTag } from "../common/UntestedTag";
import { renderMarkdown } from "../../lib/viewers/markdown";
import { onMarkdownLinkClick } from "../../lib/viewers/markdownLinks";
import { projectAgentMemoryRead, type AgentMemoryEntry } from "../../lib/projects/projectDocs";

/** The CLI product names; never translated. */
export const AGENT_MEMORY_CLI_NAME: Record<AgentMemoryEntry["cli"], string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * Read-only preview of one agent memory file. It is not the markdown viewer tab:
 * the viewer's files are scope-confined project paths, and the agent home these
 * files live in must never be added to that scope. The text arrives through
 * `project_agent_memory_read` (a name from the listing, never a path) and is
 * rendered like the skills library renders a skill body.
 */
export function AgentMemoryDialog({
  projectId, entry, onClose,
}: {
  projectId: string;
  entry: AgentMemoryEntry;
  onClose: () => void;
}) {
  const t = useT();
  const cli = AGENT_MEMORY_CLI_NAME[entry.cli];
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    projectAgentMemoryRead(projectId, entry)
      .then((s) => { if (!cancelled) setText(s); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [projectId, entry]);
  const html = useMemo(() => (text === null ? "" : renderMarkdown(text)), [text]);
  return (
    <DialogShell
      frame="project-dialog"
      scroll
      title={<>{t("agentMemory.dialogTitle", { name: entry.name, cli })} <UntestedTag id="fileTree.agentMemory" /></>}
      onDismiss={onClose}
    >
      <div className="project-dialog-path">{t("agentMemory.readOnlyNote", { cli })}</div>
      {error !== null && <ErrorNote className="project-dialog-error" error={t("agentMemory.unavailable")} />}
      {error === null && text === null && <div className="scaffold-empty">{t("agentMemory.loading")}</div>}
      {text !== null && (
        <div
          className="markdown-body agent-memory-body"
          onClick={(e) => onMarkdownLinkClick(e)}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </DialogShell>
  );
}
