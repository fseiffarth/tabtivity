import { describe, expect, it } from "vitest";
import { placementLabel } from "../../lib/agents/ollamaPlacement";

const GB = 1_000_000_000;
const format = (bytes: number) => `${bytes / GB} GB`;

describe("placementLabel", () => {
  it("names the bytes of a model Ollama measured", () => {
    expect(placementLabel({ size: 6 * GB, loaded_size: 7 * GB, size_vram: 7 * GB }, format)).toBe("GPU 7 GB");
  });

  it("keeps the figure of a partial offload, which is small only on the GPU side", () => {
    expect(placementLabel({ size: 6 * GB, loaded_size: 7 * GB, size_vram: 0.5 * GB }, format)).toBe("GPU 0.5 GB");
  });

  it("drops the figure of a draft model Ollama reports a fragment of", () => {
    const m = { size: 6.6 * GB, loaded_size: 369_371_380, size_vram: 369_371_380 };
    expect(placementLabel(m, format)).toBe("GPU");
  });

  it("still says CPU for a model with nothing on the GPU", () => {
    expect(placementLabel({ size: 6 * GB, loaded_size: 7 * GB, size_vram: 0 }, format)).toBe("CPU");
    expect(placementLabel({ size: 6 * GB, loaded_size: 1, size_vram: 0 }, format)).toBe("CPU");
  });

  it("trusts the figure when there is nothing to compare it with", () => {
    expect(placementLabel({ size: 6 * GB, size_vram: 3 * GB }, format)).toBe("GPU 3 GB");
    expect(placementLabel({ size: 0, loaded_size: 3 * GB, size_vram: 3 * GB }, format)).toBe("GPU 3 GB");
  });
});
