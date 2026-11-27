import { storageKey } from "../../lib/brand";

/**
 * The New / Import project dialog's last answers, so closing it (Cancel, ✕,
 * Escape, or a finished create) does not throw them away. One record per dialog
 * kind, in this browser's localStorage: a convenience, never project state.
 * A closed draft comes back, but once a New project is made from it the whole
 * record is cleared, so the next New dialog opens on the defaults. Import keeps
 * its choices (location, where it runs, …) across imports and drops only the
 * typed name and description. Local models only is never remembered: every
 * dialog opens with it off, and an old record's `localModelsOnly` is ignored.
 */
export interface ProjectDialogMemory {
  projectsRoot?: string;
  gitType?: string;
  publishProvider?: string;
  tierChoice?: "local" | "container" | "vm";
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

/** Forget every remembered answer of a dialog kind (a New project was just made). */
export function clearProjectDialogMemory(kind: "new" | "import"): void {
  try {
    localStorage.removeItem(keyOf(kind));
  } catch {
    // Storage unavailable: nothing was remembered.
  }
}
