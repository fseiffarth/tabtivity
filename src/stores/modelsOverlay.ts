import { create } from "zustand";
import { useRootOverlayStore } from "./rootOverlay";

/**
 * Which section the **Agents** and **Models** views of the console window
 * (`components/models/AgentsView`, `ModelsView`) show, and the doors into them.
 * These two views are what the Models & agents overlay was: Agents & CLIs,
 * Usage (the CLIs' plan and tokens) and Skills went to Agents, Local models and
 * Ollama to Models, and the overview grid of tiles went away.
 *
 * Whether either view is OPEN is not kept here: it is `rootOverlay.open` and
 * `rootOverlay.view` (`useViewShown`), the one source of truth for the window. What is kept is the section each view is on, so a door can deep-link
 * ("Manage CLIs…" lands on Agents & CLIs, a dropdown's Skills row on Skills)
 * and a plain open finds the section last used. Session-only.
 *
 * `ModelsOverlaySection` is the callers' vocabulary — the old overlay's four
 * plus `usage` — and maps to a view: agents / usage / skills -> Agents,
 * models / ollama -> Models.
 */
export type AgentsSection = "agents" | "usage" | "skills";
export type ModelsSection = "models" | "ollama";
export type ModelsOverlaySection = AgentsSection | ModelsSection;

/** The view a section lives in. */
export function viewOfSection(section: ModelsOverlaySection): "agents" | "models" {
  return section === "agents" || section === "usage" || section === "skills" ? "agents" : "models";
}

interface ModelsOverlayState {
  /** The Agents view's section. */
  agentsSection: AgentsSection;
  /** The Models view's section. */
  modelsSection: ModelsSection;
  setAgentsSection: (section: AgentsSection) => void;
  setModelsSection: (section: ModelsSection) => void;
  /** No argument opens the Models view on the section it was last on; a
   *  section deep-links to it (and opens the view that holds it). */
  openOverlay: (section?: ModelsOverlaySection) => void;
  /** Close the window if it is on one of these two views. */
  close: () => void;
}

export const useModelsOverlayStore = create<ModelsOverlayState>((set) => ({
  agentsSection: "agents",
  modelsSection: "models",
  setAgentsSection: (agentsSection) => set({ agentsSection }),
  setModelsSection: (modelsSection) => set({ modelsSection }),
  openOverlay: (section) => {
    if (!section) {
      useRootOverlayStore.getState().openView("models");
      return;
    }
    const view = viewOfSection(section);
    if (view === "agents") set({ agentsSection: section as AgentsSection });
    else set({ modelsSection: section as ModelsSection });
    useRootOverlayStore.getState().openView(view);
  },
  close: () => {
    const { open, view } = useRootOverlayStore.getState();
    if (open && (view === "agents" || view === "models")) useRootOverlayStore.getState().close();
  },
}));
