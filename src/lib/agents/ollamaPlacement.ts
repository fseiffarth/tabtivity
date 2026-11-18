/** The fields of a resident model's backend `OllamaModelInfo` read here. */
export interface ResidentSizes {
  /** Total size on disk. */
  size: number;
  /** `/api/ps` `size`; absent or 0 when the backend did not report one. */
  loaded_size?: number;
  /** `/api/ps` `size_vram`. */
  size_vram: number;
}

/**
 * Whether `/api/ps`'s byte counts can describe the whole model. A model loaded
 * with a draft layer (Gemma 4's MTP models) fails Ollama's memory measurement
 * and reports only a fragment of itself: a 6.6 GB model as 352 MB, with `size`
 * and `size_vram` equally wrong (ollama/ollama#17251). A resident model holds
 * its weights plus a KV cache, so under half its disk size is not a real figure.
 * Partial offload is not caught by mistake: `loaded_size` still counts the
 * layers in RAM, which is why this never compares `size_vram` to the disk size.
 */
function residentSizeIsPlausible({ size, loaded_size }: ResidentSizes): boolean {
  return !loaded_size || !size || loaded_size * 2 >= size;
}

/** "GPU 3.2 GB" or "CPU"; just "GPU" when the byte count cannot be believed.
 *  The GPU/CPU verdict itself survives: only `size_vram > 0` decides it. */
export function placementLabel(m: ResidentSizes, format: (bytes: number) => string): string {
  if (m.size_vram <= 0) return "CPU";
  return residentSizeIsPlausible(m) ? `GPU ${format(m.size_vram)}` : "GPU";
}
