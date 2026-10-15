/**
 * The GPU-memory arithmetic, shared by the three surfaces that show it (the
 * header readout, the system-monitor pane, the local-model menu). Pure — the
 * sampling lives in the backend's `gpustat`.
 *
 * The one thing worth internalizing is what "GPU memory" *is*. A GPU has two
 * pools and both are reported, because on an integrated GPU only one of them is
 * real: the dedicated **VRAM** carve-out (typically 512 MB on an APU — the
 * framebuffer, permanently ~full, so reading it alone says nothing useful) and
 * the **shared** pool the driver maps out of system RAM (amdgpu's GTT — where a
 * model actually lands). So the headline figure is the two summed: on a discrete
 * card the shared pool is 0 and it collapses to plain device VRAM, and on an APU
 * it becomes the number that answers "will this model fit?".
 */
import { translate, useI18nStore, type Language } from "./i18n";

/** One GPU, as sampled by the backend `gpustat::GpuSample`. */
export interface GpuSample {
  name: string;
  driver: string;
  /** Dedicated device memory. */
  vram_used: number;
  vram_total: number;
  /** System memory mapped for the GPU (GTT); 0 on a discrete card. */
  shared_used: number;
  shared_total: number;
  /** `null` when the driver won't report utilization — not the same as idle. */
  busy_percent: number | null;
  // Sensor readings. Each is `undefined`/`null` when the driver won't report it
  // (the backend omits absent ones), which is distinct from a real zero — an
  // unread temperature is unknown, not 0 °C. All optional so existing fixtures and
  // the memory-only `gpu_memory_snapshot` callers keep type-checking.
  /** GPU temperature, °C. */
  temp_c?: number | null;
  /** Board power draw, watts. */
  power_w?: number | null;
  /** Board power limit/cap, watts. */
  power_cap_w?: number | null;
  /** Core (shader) clock, MHz. */
  sclk_mhz?: number | null;
  /** Memory clock, MHz. */
  mclk_mhz?: number | null;
  /** Fan speed, 0–100% of range (not RPM). */
  fan_percent?: number | null;
  /** Driver version string (NVIDIA only). */
  driver_version?: string | null;
  /** Current PCIe link generation (1–5) and lane width. */
  pcie_gen?: number | null;
  pcie_width?: number | null;
}

/** One process's GPU memory, from the backend `gpustat::GpuProc`. */
export interface GpuProc {
  pid: number;
  name: string;
  mem_bytes: number;
}

/** Both pools of every adapter, summed: the machine's GPU memory. */
export function gpuTotals(gpus: GpuSample[]): { used: number; total: number } {
  return gpus.reduce(
    (acc, g) => ({
      used: acc.used + g.vram_used + g.shared_used,
      total: acc.total + g.vram_total + g.shared_total,
    }),
    { used: 0, total: 0 },
  );
}

/** Highest utilization across adapters; `null` when no driver reports any. */
export function gpuBusy(gpus: GpuSample[]): number | null {
  const busy = gpus.map((g) => g.busy_percent).filter((b): b is number => b != null);
  return busy.length > 0 ? Math.max(...busy) : null;
}

/**
 * Hottest adapter temperature in °C; `null` when no driver reports one. The
 * *max* rather than an average, for `mem_temp_c`'s reason on the Rust side: the
 * question a single number answers is "how hot is the GPU", and averaging a
 * loaded card with an idle one answers a question nobody asked.
 */
export function gpuHottest(gpus: GpuSample[]): number | null {
  const temps = gpus.map((g) => g.temp_c).filter((c): c is number => c != null);
  return temps.length > 0 ? Math.max(...temps) : null;
}

export function gpuPercent(used: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/**
 * Tone by **ratio**, not by absolute bytes. The old GPU row warned at 1 GB and
 * went hot at 2 GB — thresholds that made sense for a figure counting only
 * Ollama's models, and that a system-wide reading would trip permanently.
 */
export function gpuTone(used: number, total: number): "low" | "medium" | "high" {
  const pct = gpuPercent(used, total);
  if (pct >= 85) return "high";
  if (pct >= 60) return "medium";
  return "low";
}

/** Byte formatter shared by the GPU readouts (MB under a GiB, else GB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const mib = bytes / 1024 / 1024;
  if (mib < 1024) return `${Math.round(mib)} MB`;
  return `${(mib / 1024).toFixed(1)} GB`;
}

/** Temperature as `NN °C`, or `null` when unknown. */
export function formatTempC(c: number | null | undefined): string | null {
  return c == null ? null : `${Math.round(c)} °C`;
}

/**
 * Power as `NN W`, or `NN / MM W` when a cap is known — the draw against its
 * ceiling. `null` when the draw itself is unknown.
 */
export function formatWatts(
  draw: number | null | undefined,
  cap?: number | null,
): string | null {
  if (draw == null) return null;
  return cap != null ? `${Math.round(draw)} / ${Math.round(cap)} W` : `${Math.round(draw)} W`;
}

/** A clock as `N.NN GHz` (or `NNN MHz` below a GHz), or `null` when unknown. */
export function formatMhz(mhz: number | null | undefined): string | null {
  if (mhz == null) return null;
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${mhz} MHz`;
}

/** Fan speed as `NN%`, or `null` when unknown. */
export function formatFan(pct: number | null | undefined): string | null {
  return pct == null ? null : `${Math.round(pct)}%`;
}

/** PCIe link as `PCIe 4.0 ×16`, dropping whichever half is unknown; `null` for none. */
export function gpuLinkLabel(gpu: GpuSample): string | null {
  const gen = gpu.pcie_gen != null ? `PCIe ${gpu.pcie_gen}.0` : null;
  const width = gpu.pcie_width != null ? `×${gpu.pcie_width}` : null;
  const parts = [gen, width].filter((p): p is string => p != null);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The tooltip's row labels in the app language, padded to one column so the
 *  values line up whichever of them a card reports (and in every language). */
function tipLabels(lang: Language) {
  const raw = {
    vram: translate(lang, "gpu.tip.vram"),
    shared: translate(lang, "gpu.tip.shared"),
    temp: translate(lang, "gpu.tip.temp"),
    power: translate(lang, "gpu.tip.power"),
    clocks: translate(lang, "gpu.tip.clocks"),
    link: translate(lang, "gpu.tip.link"),
  };
  const width = Math.max(...Object.values(raw).map((l) => l.length)) + 2;
  const pad = (l: string) => `  ${l.padEnd(width)}`;
  return {
    vram: pad(raw.vram),
    shared: pad(raw.shared),
    temp: pad(raw.temp),
    power: pad(raw.power),
    clocks: pad(raw.clocks),
    link: pad(raw.link),
  };
}

/** One adapter, named and split back into its two pools, then its live sensors. */
export function gpuAdapterTooltip(
  gpu: GpuSample,
  lang: Language = useI18nStore.getState().lang,
): string {
  const label = tipLabels(lang);
  const head =
    gpu.busy_percent != null
      ? translate(lang, "gpu.tip.busy", { name: gpu.name, pct: Math.round(gpu.busy_percent) })
      : gpu.name;
  const vram = `${label.vram}${formatBytes(gpu.vram_used)} / ${formatBytes(gpu.vram_total)}`;
  const shared =
    gpu.shared_total > 0
      ? `\n${label.shared}${formatBytes(gpu.shared_used)} / ${formatBytes(gpu.shared_total)}`
      : "";
  // Append only the sensors the driver actually reported, so a card that exposes
  // none reads exactly as it did before these fields existed.
  const sensors: string[] = [];
  const temp = formatTempC(gpu.temp_c);
  const power = formatWatts(gpu.power_w, gpu.power_cap_w);
  const clocks = [formatMhz(gpu.sclk_mhz), formatMhz(gpu.mclk_mhz)].filter(Boolean).join(" / ");
  const link = gpuLinkLabel(gpu);
  if (temp) sensors.push(`${label.temp}${temp}`);
  if (power) sensors.push(`${label.power}${power}`);
  if (clocks) sensors.push(`${label.clocks}${clocks}`);
  if (link) sensors.push(`${label.link}${link}`);
  const tail = sensors.length > 0 ? `\n${sensors.join("\n")}` : "";
  return `${head}\n${vram}${shared}${tail}`;
}

/**
 * The header's breakdown: every adapter's two pools, then Ollama's share of it
 * all — the figure this readout used to consist of, now one line of context.
 */
export function gpuTooltip(
  gpus: GpuSample[],
  ollamaBytes: number,
  lang: Language = useI18nStore.getState().lang,
): string {
  return [
    ...gpus.map((gpu) => gpuAdapterTooltip(gpu, lang)),
    translate(lang, "gpu.tip.ollama", { size: formatBytes(ollamaBytes) }),
  ].join("\n");
}
