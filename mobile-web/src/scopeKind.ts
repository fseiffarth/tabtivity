import { useEffect, useState } from "react";
import { api, type ProjectDetail, type ScopeKind } from "./api";

/**
 * What kind of scope a project id names, as this phone last saw it.
 *
 * The Focus screen is opened with only a project id, and it must know whether
 * it is a chat of the assistant scope: that scope has no folder behind it, so
 * the screen hides every affordance that reaches one (the files drawer, the
 * outbox, the inbox uploads, Commit, Mark up). The home list and the project
 * screen record the kind they read; a screen reached any other way (the
 * cross-project Agents list) asks the host once.
 */
const known = new Map<string, ScopeKind>();

export function rememberScopeKind(id: string, kind: ScopeKind | undefined): void {
  known.set(id, kind ?? "project");
}

export function isAssistantScope(id: string | undefined): boolean {
  return !!id && known.get(id) === "assistant";
}

/** The scope's kind, `undefined` until the host has said. */
export function useScopeKind(id: string | undefined): ScopeKind | undefined {
  const [kind, setKind] = useState<ScopeKind | undefined>(() => (id ? known.get(id) : undefined));
  useEffect(() => {
    if (!id) { setKind(undefined); return; }
    const remembered = known.get(id);
    if (remembered) { setKind(remembered); return; }
    const controller = new AbortController();
    api<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((detail) => { rememberScopeKind(id, detail.project.kind); setKind(detail.project.kind ?? "project"); })
      .catch(() => {});
    return () => controller.abort();
  }, [id]);
  return kind;
}
