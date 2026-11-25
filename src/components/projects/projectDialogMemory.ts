import { storageKey } from "../../lib/brand";

/**
 * The New / Import project dialog's last answers, so closing it (Cancel, ✕,
 * Escape, or a finished create) does not throw them away. One record per dialog
 * kind, in this browser's localStorage: a convenience, never project state.
 * The choices (location, git hosting, where it runs, Local models only, …) are
 * kept across creates; the typed name and description only until a project is
 * made from them, so a closed draft comes back but a used one does not.
 */
export interface ProjectDialogMemory {
  projectsRoot?: string;
  gitType?: string;
  publishProvider?: string;
  tierChoice?: "local" | "container" | "vm";
  localModelsOnly?: boolean;
  descriptionFillMode?: string;
  skipScaffold?: boolean;
  name?: string;
  description?: string;
}

const keyOf = (kind: "new" | "import") => storageKey(`projectDialog.${kind}`);

const TIERS = new Set(["local", "container", "vm"]);

/** The remembered answers, each field checked; anything unreadable is dropped. */
export function readProjectDialogMemory(kind: "new" | "import"): ProjectDialogMemory {
  let raw: unknown;
  try {
    const text = localStorage.getItem(keyOf(kind));
    raw = text ? JSON.parse(text) : null;
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  const out: ProjectDialogMemory = {
    projectsRoot: str(r.projectsRoot) || undefined,
    gitType: str(r.gitType),
    publishProvider: str(r.publishProvider),
    tierChoice: typeof r.tierChoice === "string" && TIERS.has(r.tierChoice)
      ? (r.tierChoice as ProjectDialogMemory["tierChoice"])
      : undefined,
    localModelsOnly: bool(r.localModelsOnly),
    descriptionFillMode: str(r.descriptionFillMode),
    skipScaffold: bool(r.skipScaffold),
    name: str(r.name),
    description: str(r.description),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as ProjectDialogMemory;
}

export function writeProjectDialogMemory(kind: "new" | "import", memory: ProjectDialogMemory): void {
  try {
    localStorage.setItem(keyOf(kind), JSON.stringify(memory));
  } catch {
    // Private window or full storage: the dialog simply starts fresh next time.
  }
}
