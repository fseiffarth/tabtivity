import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { usePoll, type PollRun } from "../../lib/usePoll";
import { useFastMode } from "../../lib/agents/fastMode";
import { useHeaderStatusReport } from "../../stores/headerStatus";
import {
  formatBytes,
  gpuBusy,
  gpuTone,
  gpuTooltip,
  gpuTotals,
  type GpuSample,
} from "../../lib/gpu";
import { useT } from "../../lib/i18n";
import { MeterIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";

interface AppResourceUsage {
  cpu_percent: number;
  rss_bytes: number;
  process_count: number;
  /** Ollama's *share* of the GPU: 0 when no model is resident. */
  vram_bytes: number;
  /** Every GPU in the machine; empty when none can be read (see `lib/gpu`). */
  gpus: GpuSample[];
}

/** The header readout's cadence. 5 s, not the old 2.5 s: the figure is a coarse
 *  readout of Tabtivity's own overhead, and each reading is an IPC round trip
 *  plus two jiffy sums over the process tree. The backend's relaxed tree cache
 *  (`sysstat::CACHE_TTL_RELAXED`) is sized to this, so every other poll skips
 *  the `/proc` walk; the GPU half is cached 10 s there (`GPU_SECTION_TTL`). */
export const RESOURCE_POLL_MS = 5_000;

function usageTone(kind: "cpu" | "ram", value: number): "low" | "medium" | "high" {
  // CPU is a percentage; RAM is a byte count with its own thresholds. The GPU
  // row tones by ratio instead (`gpuTone`) — its figure is the whole device's.
  const warn = kind === "cpu" ? 35 : 1024 * 1024 * 1024;
  const hot = kind === "cpu" ? 75 : 2 * 1024 * 1024 * 1024;
  if (value >= hot) return "high";
  if (value >= warn) return "medium";
  return "low";
}

/**
 * `folded`: the header status cluster has folded this readout away
 * (`display: none`, still mounted). It then takes no readings of its own — its
 * report never tones the summary lamp, so the fold toggle's tooltip is the only
 * thing still reading it — and samples once each time `peek` changes, which
 * the cluster bumps as the pointer reaches that toggle.
 */
export function AppResourceDisplay({ folded = false, peek = 0 }: { folded?: boolean; peek?: number } = {}) {
  const t = useT();
  // Each row defaults OFF (undefined → hidden) and is independent of debug mode.
  const showCpu = useSettingsStore((s) => s.settings?.show_cpu_usage ?? false);
  const showRam = useSettingsStore((s) => s.settings?.show_ram_usage ?? false);
  const showGpu = useSettingsStore((s) => s.settings?.show_gpu_usage ?? false);
  // Fast mode withdraws the readout: a poll every 5 s, forever, for a figure
  // that is by construction a readout of Tabtivity's own overhead — so the reading
  // and the cost of taking it are the same thing.
  const fastMode = useFastMode();
  const anyShown = (showCpu || showRam || showGpu) && !fastMode;
  const [usage, setUsage] = useState<AppResourceUsage | null>(null);
  useEffect(() => {
    if (!anyShown) setUsage(null);
  }, [anyShown]);

  const poll = useCallback(async (run: PollRun) => {
    try {
      // Skip GPU and Ollama reads when their row is hidden.
      const next = await invoke<AppResourceUsage>("debug_app_resource_usage", { gpu: showGpu });
      if (!run.stopped) setUsage(next);
    } catch {
      if (!run.stopped) setUsage(null);
    }
  }, [showGpu]);
  // Folded stops the poll but keeps the last reading: the cluster counts this
  // member by its report, and one that vanished on fold could drop the count
  // below the fold threshold and unfold the row again.
  usePoll(poll, RESOURCE_POLL_MS, { enabled: anyShown && !folded, onBlur: "widen" });

  // One reading for the folded tooltip. It shows CPU and RAM only, so the GPU
  // and Ollama reads are skipped and the last GPU figures carried over until
  // the expanded poll replaces them.
  useEffect(() => {
    if (!anyShown || !folded || peek === 0) return;
    let cancelled = false;
    invoke<AppResourceUsage>("debug_app_resource_usage", { gpu: false })
      .then((next) => {
        if (cancelled) return;
        setUsage((prev) => ({ ...next, gpus: prev?.gpus ?? [], vram_bytes: prev?.vram_bytes ?? 0 }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Only a new `peek` asks; folding or unfolding is not a hover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peek]);

  // Never tones up. A build pegs the CPU for minutes at a time, so toning this
  // `attention` would turn a collapsed header's summary lamp amber for the
  // whole of an ordinary compile — the one member whose "hot" is routine. It
  // reports `off` purely to be *counted* as a member of the cluster (and to put
  // its numbers in the collapsed tooltip, which is where they are still useful).
  useHeaderStatusReport(
    "resources",
    !anyShown || !usage
      ? null
      : {
          tone: "off",
          label: [
            showCpu ? `${t("appResource.cpuLabel")} ${usage.cpu_percent.toFixed(1)}%` : null,
            showRam ? `${t("appResource.ramLabel")} ${formatBytes(usage.rss_bytes)}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        },
  );

  if (!anyShown || !usage) return null;

  const tones = [
    showCpu ? usageTone("cpu", usage.cpu_percent) : "low",
    showRam ? usageTone("ram", usage.rss_bytes) : "low",
    showGpu ? gpuRowTone(usage.gpus, usage.vram_bytes) : "low",
  ];
  const worst = tones.includes("high") ? "high" : tones.includes("medium") ? "medium" : "low";
  const summary = [
    showCpu ? `${t("appResource.cpuLabel")} ${usage.cpu_percent.toFixed(1)}%` : null,
    showRam ? `${t("appResource.ramLabel")} ${formatBytes(usage.rss_bytes)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="app-resource-display" tabIndex={0} role="group" aria-label={summary}>
      <MeterIcon className={`header-status-glyph app-resource-meter ${worst}`} />
      {/* Stays mounted: the card opens on `:hover`/`:focus-within`, so a pointer
          reaching the meter costs no render and the figures are already there. */}
      <div className="project-pill-popup app-resource-card">
        {showCpu && (
          <span
            className={`app-resource-row ${usageTone("cpu", usage.cpu_percent)}`}
            title={t("appResource.cpuTitle")}
          >
            <span className="app-resource-symbol" aria-hidden>{t("appResource.cpuLabel")}</span>
            <span>{usage.cpu_percent.toFixed(1)}%</span>
          </span>
        )}
        {showRam && (
          <span
            className={`app-resource-row ${usageTone("ram", usage.rss_bytes)}`}
            title={t("appResource.ramTitle")}
          >
            <span className="app-resource-symbol" aria-hidden>{t("appResource.ramLabel")}</span>
            <span>{formatBytes(usage.rss_bytes)}</span>
          </span>
        )}
        {showGpu && <GpuRow gpus={usage.gpus} ollamaBytes={usage.vram_bytes} />}
        <span className="pill-popup-path">
          {t(
            usage.process_count === 1 ? "appResource.processCountOne" : "appResource.processCountMany",
            { count: usage.process_count },
          )}
        </span>
        <UntestedTag id="desktop.header.meter" />
      </div>
    </div>
  );
}

/** The GPU row's tone, shared with the meter so it takes the worst of three. */
function gpuRowTone(gpus: GpuSample[], ollamaBytes: number): "low" | "medium" | "high" {
  if (gpus.length === 0) return usageTone("ram", ollamaBytes);
  const { used, total } = gpuTotals(gpus);
  return gpuTone(used, total);
}

/**
 * The whole device's memory (both pools, every adapter) plus its utilization —
 * not just what Ollama holds, which is what this row used to show and now shows
 * as one line of its tooltip.
 */
function GpuRow({ gpus, ollamaBytes }: { gpus: GpuSample[]; ollamaBytes: number }) {
  const t = useT();
  // No GPU we can read (macOS, an Intel-only box, no `nvidia-smi`): fall back to
  // exactly what this row did before — Ollama's models, and "—" when none are
  // loaded. Better a narrow reading than a zero pretending to be a measurement.
  if (gpus.length === 0) {
    return (
      <span
        className={`app-resource-row ${gpuRowTone(gpus, ollamaBytes)}`}
        title={t("appResource.gpuNoDeviceTitle")}
      >
        <span className="app-resource-symbol" aria-hidden>{t("appResource.gpuLabel")}</span>
        <span>{ollamaBytes > 0 ? formatBytes(ollamaBytes) : "—"}</span>
      </span>
    );
  }

  const { used, total } = gpuTotals(gpus);
  const busy = gpuBusy(gpus);

  return (
    <span
      className={`app-resource-row ${gpuRowTone(gpus, ollamaBytes)}`}
      title={gpuTooltip(gpus, ollamaBytes)}
    >
      <span className="app-resource-symbol" aria-hidden>{t("appResource.gpuLabel")}</span>
      <span>
        {busy != null ? `${Math.round(busy)}% · ` : ""}
        {formatBytes(used)} / {formatBytes(total)}
      </span>
    </span>
  );
}
