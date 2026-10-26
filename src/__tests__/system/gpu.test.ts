import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatFan,
  formatMhz,
  formatTempC,
  formatWatts,
  gpuAdapterTooltip,
  gpuBusy,
  gpuLinkLabel,
  gpuPercent,
  gpuTone,
  gpuTooltip,
  gpuTotals,
  type GpuSample,
} from "../../lib/gpu";
import { registerDict } from "../../lib/i18n";
import { dict as de } from "../../lib/i18n/de";

/** The machine this was built on: a Strix APU — a 512 MB carve-out + a 61 GB GTT pool. */
const apu: GpuSample = {
  name: "Strix [Radeon 880M / 890M]",
  driver: "amdgpu",
  vram_used: 440_770_560,
  vram_total: 536_870_912,
  shared_used: 18_052_190_208,
  shared_total: 65_855_619_072,
  busy_percent: 95,
};

/** A discrete card: all its memory is its own, and there is no shared pool. */
const dgpu: GpuSample = {
  name: "NVIDIA GeForce RTX 4090",
  driver: "nvidia",
  vram_used: 8 * 1024 ** 3,
  vram_total: 24 * 1024 ** 3,
  shared_used: 0,
  shared_total: 0,
  busy_percent: 37,
};

describe("gpuTotals", () => {
  it("sums both pools, which is the only figure an APU can answer 'will it fit?' with", () => {
    const { used, total } = gpuTotals([apu]);
    expect(used).toBe(apu.vram_used + apu.shared_used);
    expect(total).toBe(apu.vram_total + apu.shared_total);
    // The dedicated pool alone would read 82% full and never move.
    expect(gpuPercent(apu.vram_used, apu.vram_total)).toBeGreaterThan(80);
    expect(gpuPercent(used, total)).toBeLessThan(30);
  });

  it("collapses to plain device VRAM on a discrete card", () => {
    expect(gpuTotals([dgpu])).toEqual({ used: 8 * 1024 ** 3, total: 24 * 1024 ** 3 });
  });

  it("sums across adapters, and is zero for none", () => {
    expect(gpuTotals([apu, dgpu]).total).toBe(
      apu.vram_total + apu.shared_total + dgpu.vram_total,
    );
    expect(gpuTotals([])).toEqual({ used: 0, total: 0 });
  });
});

describe("gpuTone", () => {
  it("tones by ratio, so a big-but-empty GPU is not 'hot'", () => {
    // 8 GB in use — the old absolute thresholds (hot at 2 GB) called this high.
    expect(gpuTone(8 * 1024 ** 3, 24 * 1024 ** 3)).toBe("low");
    expect(gpuTone(15 * 1024 ** 3, 24 * 1024 ** 3)).toBe("medium");
    expect(gpuTone(23 * 1024 ** 3, 24 * 1024 ** 3)).toBe("high");
  });

  it("does not divide by a total it does not have", () => {
    expect(gpuTone(0, 0)).toBe("low");
    expect(gpuPercent(1024, 0)).toBe(0);
  });
});

describe("gpuBusy", () => {
  it("takes the busiest adapter, and distinguishes unknown from idle", () => {
    expect(gpuBusy([apu, dgpu])).toBe(95);
    expect(gpuBusy([{ ...dgpu, busy_percent: null }])).toBeNull();
    expect(gpuBusy([{ ...dgpu, busy_percent: 0 }])).toBe(0);
    expect(gpuBusy([])).toBeNull();
  });
});

describe("gpuTooltip", () => {
  it("keeps the pools apart and names Ollama's share", () => {
    const tip = gpuTooltip([apu], 3 * 1024 ** 3);
    expect(tip).toContain("Strix [Radeon 880M / 890M] — 95% busy");
    expect(tip).toContain("VRAM    420 MB / 512 MB");
    expect(tip).toContain("Shared  16.8 GB / 61.3 GB");
    expect(tip).toContain("Ollama models: 3.0 GB");
  });

  it("omits the shared line for a card that has no shared pool", () => {
    expect(gpuTooltip([dgpu], 0)).not.toContain("Shared");
  });

  it("speaks the app language and keeps its values in one column", () => {
    registerDict("de", de);
    const tip = gpuTooltip([{ ...apu, temp_c: 58 }], 3 * 1024 ** 3, "de");
    expect(tip).toContain("Strix [Radeon 880M / 890M] — 95% ausgelastet");
    expect(tip).toContain("Ollama-Modelle: 3.0 GB");
    expect(tip).not.toContain("Shared");
    // Every row's value starts in the same column, whatever the labels' lengths.
    const rows = tip.split("\n").filter((row) => row.startsWith("  "));
    expect(rows.length).toBe(3);
    const column = rows[0].indexOf("420 MB");
    expect(column).toBeGreaterThan(2);
    for (const row of rows) {
      expect(row.slice(column - 2, column), row).toBe("  ");
      expect(row[column], row).not.toBe(" ");
    }
  });
});

describe("formatBytes", () => {
  it("reads MB below a GiB and GB above it", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(536_870_912)).toBe("512 MB");
    expect(formatBytes(18_052_190_208)).toBe("16.8 GB");
  });

  it("also reads a renderer's resident set (KiB × 1024) the way the side panel prints it", () => {
    const MB = 1024 * 1024;
    expect(formatBytes(912 * MB)).toBe("912 MB");
    expect(formatBytes(4736 * MB)).toBe("4.6 GB");
    expect(formatBytes(1024 * MB)).toBe("1.0 GB");
  });
});

describe("sensor formatters", () => {
  it("returns null for an unknown reading rather than a fake zero", () => {
    expect(formatTempC(null)).toBeNull();
    expect(formatTempC(undefined)).toBeNull();
    expect(formatWatts(null)).toBeNull();
    expect(formatMhz(null)).toBeNull();
    expect(formatFan(undefined)).toBeNull();
    // A real zero is a value, not "unknown".
    expect(formatFan(0)).toBe("0%");
    expect(formatTempC(0)).toBe("0 °C");
  });

  it("formats each unit, and power against its cap when known", () => {
    expect(formatTempC(58.4)).toBe("58 °C");
    expect(formatWatts(210.5)).toBe("211 W");
    expect(formatWatts(210.5, 450)).toBe("211 / 450 W");
    expect(formatMhz(2520)).toBe("2.52 GHz");
    expect(formatMhz(96)).toBe("96 MHz");
    expect(formatFan(41)).toBe("41%");
  });
});

describe("gpuLinkLabel", () => {
  it("joins gen and width, and drops whichever half is unknown", () => {
    expect(gpuLinkLabel({ ...dgpu, pcie_gen: 4, pcie_width: 16 })).toBe("PCIe 4.0 ×16");
    expect(gpuLinkLabel({ ...dgpu, pcie_gen: 3, pcie_width: null })).toBe("PCIe 3.0");
    expect(gpuLinkLabel({ ...dgpu, pcie_gen: null, pcie_width: 8 })).toBe("×8");
    expect(gpuLinkLabel(dgpu)).toBeNull();
  });
});

describe("gpuAdapterTooltip sensors", () => {
  it("appends only the sensors the driver reported", () => {
    const tip = gpuAdapterTooltip({
      ...dgpu,
      temp_c: 61,
      power_w: 210,
      power_cap_w: 450,
      sclk_mhz: 2520,
      mclk_mhz: 10501,
      pcie_gen: 4,
      pcie_width: 16,
    });
    expect(tip).toContain("Temp    61 °C");
    expect(tip).toContain("Power   210 / 450 W");
    expect(tip).toContain("Clocks  2.52 GHz / 10.50 GHz");
    expect(tip).toContain("Link    PCIe 4.0 ×16");
  });

  it("reads exactly as before for a card that exposes no sensors", () => {
    // The APU/dGPU fixtures carry no sensor fields — the tooltip must not sprout
    // empty sensor rows.
    expect(gpuAdapterTooltip(dgpu)).not.toContain("Temp");
    expect(gpuAdapterTooltip(dgpu)).not.toContain("Link");
  });
});
