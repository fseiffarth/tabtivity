// The "Project docs" group's state in the file tree: the backend's per-doc
// status, and the group's persisted open/closed fold.
import { useCallback, useEffect, useState } from "react";
import {
  projectAgentMemory, projectDocsStatus, type AgentMemoryEntry, type DocStatus,
} from "../../lib/projects/projectDocs";
import { storageKey } from "../../lib/brand";

const DOCS_EXPANDED_PREFIX = "fileTree.docsExpanded.";

function readOpen(projectId: string | null): boolean {
  if (!projectId) return false;
  try {
    return localStorage.getItem(storageKey(DOCS_EXPANDED_PREFIX + projectId)) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether the group is unfolded, remembered per project so it survives a panel
 * hide/show and a relaunch (the gitignored section's idea, one key per project
 * because the docs differ from project to project). Closed until first opened.
 * The second element is the user's toggle (persists); the third unfolds without
 * persisting (a search reveal needs the row on screen, not a new preference).
 */
export function useDocsGroupOpen(projectId: string | null): [boolean, () => void, () => void] {
  const [state, setState] = useState(() => ({ id: projectId, open: readOpen(projectId) }));
  // A different project starts from its own remembered fold.
  if (state.id !== projectId) setState({ id: projectId, open: readOpen(projectId) });
  const toggle = useCallback(() => {
    setState((prev) => {
      const open = !prev.open;
      if (prev.id) {
        try { localStorage.setItem(storageKey(DOCS_EXPANDED_PREFIX + prev.id), open ? "1" : "0"); } catch { /* ignore storage failures */ }
      }
      return { ...prev, open };
    });
  }, []);
  const reveal = useCallback(() => setState((prev) => (prev.open ? prev : { ...prev, open: true })), []);
  return [state.open, toggle, reveal];
}

/**
 * The project's docs status, fetched while the tree is on screen and the root of
 * a local folder is listed. `listingKey` changes whenever the root listing does
 * (an fs-change refresh hands back new entries), which is what re-asks: a doc
 * edited away from its template, or created or deleted, shows up without a
 * timer. `null` while unknown — also for a project with no local folder.
 */
export function useProjectDocsStatus({
  projectId, enabled, listingKey,
}: {
  projectId: string | null;
  /** On screen, at the project root, a local listing, and the group switched on. */
  enabled: boolean;
  listingKey: unknown;
}): { status: DocStatus[] | null; refresh: () => void } {
  const [status, setStatus] = useState<DocStatus[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (!projectId || !enabled) return;
    let cancelled = false;
    projectDocsStatus(projectId)
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [projectId, enabled, listingKey, nonce]);
  // Another project (or no project) must not wear the last one's states.
  useEffect(() => { setStatus(null); }, [projectId]);
  return { status: enabled ? status : null, refresh };
}

/**
 * The agent CLIs' memory files for the project (read-only, empty when there are
 * none — the sub-group then stays hidden). They live in the agent home, not the
 * project folder, so no fs-change announces them: the list is asked when the
 * group is on screen and again each time `refreshKey` changes (the group being
 * unfolded).
 */
export function useAgentMemory({
  projectId, enabled, refreshKey,
}: {
  projectId: string | null;
  enabled: boolean;
  refreshKey: unknown;
}): AgentMemoryEntry[] {
  const [entries, setEntries] = useState<AgentMemoryEntry[]>([]);
  useEffect(() => {
    if (!projectId || !enabled) return;
    let cancelled = false;
    projectAgentMemory(projectId)
      .then((e) => { if (!cancelled) setEntries(Array.isArray(e) ? e : []); })
      .catch(() => { if (!cancelled) setEntries([]); });
    return () => { cancelled = true; };
  }, [projectId, enabled, refreshKey]);
  useEffect(() => { setEntries([]); }, [projectId]);
  return enabled ? entries : [];
}
