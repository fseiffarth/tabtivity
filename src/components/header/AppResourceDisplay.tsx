import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { useQuiesce, saverInterval } from "../../stores/power";
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

interface AppResourceUsage {
  cpu_percent: number;
  rss_bytes: number;
  process_count: number;
  /** Ollama's *share* of the GPU: 0 when no model is resident. */
  vram_bytes: number;
  /** Every GPU in the machine; empty when none can be read (see `lib/gpu`). */
  gpus: GpuSample[];
}

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
  // Each row defaults ON (undefined → shown) and is independent of debug mode.
  const showCpu = useSettingsStore((s) => s.settings?.show_cpu_usage ?? true);
  const showRam = useSettingsStore((s) => s.settings?.show_ram_usage ?? true);
  const showGpu = useSettingsStore((s) => s.settings?.show_gpu_usage ?? true);
  // Fast mode withdraws the readout: a poll every 2.5 s, forever, for a figure
  // that is by construction a readout of Tabtivity's own overhead — so the reading
  // and the cost of taking it are the same thing.
  const fastMode = useFastMode();
  const anyShown = (showCpu || showRam || showGpu) && !fastMode;
  const [usage, setUsage] = useState<AppResourceUsage | null>(null);
  const quiesce = useQuiesce();

  useEffect(() => {
    if (!anyShown) {
      setUsage(null);
      return;
    }
    // Folded keeps the last reading rather than clearing it: the cluster
    // counts this member by its report, and a member that vanished on fold
    // could drop the count below the fold threshold and unfold the row again.
    if (folded) return;

    let cancelled = false;
    // `gpu: false` with the GPU row hidden: the backend then skips its GPU and
    // Ollama reads instead of sampling what nobody will see.
    const poll = () => {
      invoke<AppResourceUsage>("debug_app_resource_usage", { gpu: showGpu })
        .then((next) => {
          if (!cancelled) setUsage(next);
        })
        .catch(() => {
          if (!cancelled) setUsage(null);
        });
    };

    poll();
    const id = window.setInterval(poll, saverInterval(2_500, quiesce));
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [anyShown, showGpu, quiesce, folded]);

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
            showCpu ? `CPU ${usage.cpu_percent.toFixed(1)}%` : null,
            showRam ? `RAM ${formatBytes(usage.rss_bytes)}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        },
  );

  if (!anyShown || !usage) return null;

  return (
    <div
      className="app-resource-display"
      title={t(
        usage.process_count === 1 ? "appResource.processCountOne" : "appResource.processCountMany",
        { count: usage.process_count },
      )}
    >
      {showCpu && (
        <span className={`app-resource-row ${usageTone("cpu", usage.cpu_percent)}`} title="CPU">
          <span className="app-resource-symbol" aria-hidden>CPU</span>
          <span>{usage.cpu_percent.toFixed(1)}%</span>
        </span>
      )}
      {showRam && (
        <span className={`app-resource-row ${usageTone("ram", usage.rss_bytes)}`} title="RAM">
          <span className="app-resource-symbol" aria-hidden>RAM</span>
          <span>{formatBytes(usage.rss_bytes)}</span>
        </span>
      )}
      {showGpu && <GpuRow gpus={usage.gpus} ollamaBytes={usage.vram_bytes} />}
    </div>
  );
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
        className={`app-resource-row ${usageTone("ram", ollamaBytes)}`}
        title={t("appResource.gpuNoDeviceTitle")}
      >
        <span className="app-resource-symbol" aria-hidden>GPU</span>
        <span>{ollamaBytes > 0 ? formatBytes(ollamaBytes) : "—"}</span>
      </span>
    );
  }

  const { used, total } = gpuTotals(gpus);
  const busy = gpuBusy(gpus);

  return (
    <span
      className={`app-resource-row ${gpuTone(used, total)}`}
      title={gpuTooltip(gpus, ollamaBytes)}
    >
      <span className="app-resource-symbol" aria-hidden>GPU</span>
      <span>
        {busy != null ? `${Math.round(busy)}% · ` : ""}
        {formatBytes(used)} / {formatBytes(total)}
      </span>
    </span>
  );
}
