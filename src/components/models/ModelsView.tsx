import { useEffect, useState } from "react";
import { useModelsOverlayStore, type ModelsSection } from "../../stores/modelsOverlay";
import { initLocalModelEvents, useOllamaActivityStore } from "../../stores/agents/ollamaActivity";
import { useT, type TranslationKey } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { ViewSubTabs } from "../layout/viewBarSlots";
import { OllamaPanel } from "../settings/OllamaPanel";
import { LocalModelsSection, MachineMeters } from "./ModelsHubSections";
import { useModelsHub } from "./useModelsHub";

const SECTIONS: readonly ModelsSection[] = ["models", "ollama"];

const SECTION_LABEL: Record<ModelsSection, TranslationKey> = {
  models: "modelsView.tab.models",
  ollama: "modelsView.tab.ollama",
};

/**
 * The **Models** view of the console window: what the Models & agents
 * overlay's Local models and Ollama sections were. Two sections, shown as tabs
 * in the window's sub-bar:
 *  - **Local models** — the hub sections (`ModelsHubSections`) over the shared
 *    `stores/agents/ollamaActivity`, drawn as cards: status bar, Machine
 *    meters, then Running (each with its Unload) / On disk;
 *  - **Ollama** — Settings' `OllamaPanel` (install, storage, pulls, catalog).
 *
 * A section mounts the first time it is shown and stays mounted, hidden, while
 * the view is (an install log is component state).
 */
export function ModelsView() {
  const t = useT();
  const section = useModelsOverlayStore((s) => s.modelsSection);
  const setSection = useModelsOverlayStore((s) => s.setModelsSection);
  const [visited, setVisited] = useState<ReadonlySet<ModelsSection>>(() => new Set([section]));
  useEffect(() => {
    setVisited((v) => (v.has(section) ? v : new Set(v).add(section)));
  }, [section]);
  const mounted = (id: ModelsSection) => id === section || visited.has(id);

  return (
    <div className="app-view app-view-models models-overlay-body">
      <ViewSubTabs
        items={SECTIONS.map((id) => ({ id, label: t(SECTION_LABEL[id]) }))}
        value={section}
        onChange={setSection}
        ariaLabel={t("modelsView.tabs")}
        extra={<UntestedTag id="modelsView.tabs" />}
      />
      {SECTIONS.map((id) =>
        mounted(id) ? (
          <div
            key={id}
            role="tabpanel"
            aria-label={t(SECTION_LABEL[id])}
            className={`models-overlay-pane models-overlay-pane-${id}`}
            hidden={id !== section}
          >
            {id === "models" && (
              <ModelsTab active={section === "models"} onManageModels={() => setSection("ollama")} />
            )}
            {id === "ollama" && <OllamaPanel />}
          </div>
        ) : null,
      )}
    </div>
  );
}

/**
 * The Local models section at full size: a status bar, notices, the Machine
 * meters, then a card per model (`LocalModelsSection` `layout="overlay"` — the
 * dropdown keeps its menu rows). `useModelsHub(active)` gates the 2 s
 * GPU/machine poll and the GPU-status read on this section being the visible
 * one; the list and version are re-read each time it becomes visible, as a
 * hover does — but not the agents, which this section doesn't show.
 */
function ModelsTab({ active, onManageModels }: { active: boolean; onManageModels: () => void }) {
  const hub = useModelsHub(active);
  const installed = useOllamaActivityStore((s) => s.installed);
  // The progress events, ref-counted with the header button's own subscription:
  // the section stays live even if that button is ever not mounted.
  useEffect(() => initLocalModelEvents(), []);
  useEffect(() => {
    if (active) hub.refreshModels();
    // `refreshModels` is a fresh closure every render; what should re-run it is the
    // section becoming visible (or Ollama turning up installed while it is).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, installed]);
  return (
    <div className="dialog-scroll models-overlay-models">
      <LocalModelsSection
        hub={hub}
        layout="overlay"
        onManageModels={onManageModels}
        machine={<MachineMeters hub={hub} layout="overlay" />}
      />
      {hub.dialogs}
    </div>
  );
}
