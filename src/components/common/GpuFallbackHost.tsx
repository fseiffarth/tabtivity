import { DialogShell } from "./PromptDialogs";
import { UntestedTag } from "./UntestedTag";
import { useT } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";

/**
 * The one ask after the window's renderer crashed on the GPU path: the backend
 * turned the experimental `gpu_compositing` setting off and noted when
 * (`gpu_compositing_fallback`, `services::webkit_gpu`), so the next launch
 * paints on the CPU. Keeping it off is the default button; turning it back on
 * is the deliberate act. Either answer clears the note. Mounted in the main
 * window only (AppShell), so a popout never asks a second time.
 */
export function GpuFallbackHost() {
  const t = useT();
  const at = useSettingsStore((s) => s.settings?.gpu_compositing_fallback);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  if (!at) return null;
  const answer = (gpuBackOn: boolean) =>
    void updateSettings(
      gpuBackOn ? { gpu_compositing: true, gpu_compositing_fallback: null } : { gpu_compositing_fallback: null },
    );
  return (
    <DialogShell onDismiss={() => answer(false)}>
      <h2>
        {t("gpuFallback.title")} <UntestedTag id="gpuFallback.ask" />
      </h2>
      <p className="file-delete-body">{t("gpuFallback.body")}</p>
      <div className="file-delete-actions">
        <button type="button" autoFocus onClick={() => answer(false)}>
          {t("gpuFallback.keepOff")}
        </button>
        <button type="button" onClick={() => answer(true)}>
          {t("gpuFallback.turnBackOn")}
        </button>
      </div>
    </DialogShell>
  );
}
