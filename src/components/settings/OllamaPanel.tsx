import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import {
  SettingsAdvanced,
  SettingsCard,
  SettingsHeader,
  SettingsSection,
  ToggleRow,
} from "../layout/settingsUi";
import { formatBytes as fmtBytes } from "../../lib/formatBytes";
import { UntestedTag } from "../common/UntestedTag";
import { open } from "@tauri-apps/plugin-dialog";
import { Dropdown } from "../common/Dropdown";
import { useSettingsStore } from "../../stores/settings";
import { initLocalModelEvents, useOllamaActivityStore } from "../../stores/agents/ollamaActivity";
import { ollamaVersionStatus } from "../../lib/agents/localDrivers";
import { runOllamaUpdateCheck, upgradeOllamaInTab } from "../../lib/agents/ollamaUpdateActions";
import { runInstallInTab, type InstallShellKind } from "../../lib/installCommand";
import { useT, type TranslationKey } from "../../lib/i18n";
import { ErrorNote } from "../common/ErrorNote";
import { runWithProgress } from "../../lib/runWithProgress";
import type { SubPanelProps } from "./subPanelProps";

interface OllamaModelInfo {
  name: string;
  size: number;
  parameter_size: string | null;
  quantization: string | null;
  family: string | null;
  running: boolean;
  size_vram: number;
}

/** How a chosen models-download location would be applied (mirrors backend
 *  `OllamaModelsDirPlan`). `service_cmd` is empty unless the running server is a
 *  systemd unit *and* the path is safe to embed in a drop-in. */
interface OllamaModelsDirPlan {
  default_dir: string;
  systemd_service: boolean;
  service_cmd: string;
  shell_kind: string;
}

/** One row from the live Ollama registry search (mirrors backend RegistryModel). */
interface RegistryModel {
  /** `gemma4`, or `<user>/<name>` for a community upload. */
  name: string;
  community: boolean;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: string;
  updated: string;
}

/** A tag's headline facts (mirrors backend RegistryDetails), fetched lazily so a
 *  row that carries no size badge on the search card can still show its
 *  parameters and download size. */
interface RegistryDetails {
  size_bytes: number;
  params: string | null;
  quant: string | null;
  cloud: boolean;
}
/** Cached per-tag details, "loading" while the two registry reads are in flight,
 *  "error" when they could not be reached. */
type TagInfo = RegistryDetails | "loading" | "error";

/** One page of registry search results (mirrors backend RegistrySearchPage). */
interface RegistrySearchPage {
  models: RegistryModel[];
  hasMore: boolean;
}

/** Capability filters, Ollama's `c=` search param: a model must have all chosen. */
const REGISTRY_TYPES = ["tools", "vision", "thinking", "embedding", "audio"] as const;

/** Where a model runs, also a `c=` value on ollama.com — one or neither. */
const REGISTRY_RUNS = ["local", "cloud"] as const;

/** Download-size caps, Ollama's `s=` search param (GB; "over64" is the top bucket). */
const REGISTRY_DOWNLOAD_SIZES = ["8", "16", "32", "64", "over64"] as const;

/** Sort options for the registry browser, Ollama's own `o=` orders: every
 *  lazy-loaded page arrives already in order. */
const SORT_OPTIONS = [
  { key: "popular", labelKey: "ollama.sort.popular" },
  { key: "newest", labelKey: "ollama.sort.newest" },
  { key: "name", labelKey: "ollama.sort.name" },
] as const satisfies { key: string; labelKey: TranslationKey }[];
type SortKey = (typeof SORT_OPTIONS)[number]["key"];

// Fallback install command shown before the OS-specific strategy loads from the
// backend. The real command comes from `ollama_install_strategy` (winget on
// Windows, the install script on Linux/macOS).
const OLLAMA_INSTALL_CMD_FALLBACK = "curl -fsSL https://ollama.com/install.sh | sh";
const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";
// Fallback Vibe install command shown before the OS-specific strategy loads from
// the backend. The real command comes from `vibe_install_strategy` (a uv-based
// PowerShell command on Windows, the install script on Linux/macOS).
const VIBE_INSTALL_CMD = "curl -LsSf https://mistral.ai/vibe/install.sh | bash";

/** OS-dependent Vibe install guidance (mirrors backend `VibeInstallStrategy`). */
interface VibeInstallStrategy {
  os: string; // "windows" | "macos" | "linux" | "unknown"
  command: string;
  auto: boolean;
  docs: string;
}

/** OS-dependent Ollama install guidance (mirrors backend `OllamaInstallStrategy`). */
interface OllamaInstallStrategy {
  os: string; // "windows" | "macos" | "linux" | "unknown"
  command: string;
  auto: boolean;
  download_url: string;
}

export function OllamaPanel({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string | null>(null);
  // OS-dependent install strategy (command + whether one-click install works).
  const [strategy, setStrategy] = useState<OllamaInstallStrategy | null>(null);
  const installLogRef = useRef<HTMLPreElement>(null);
  // Vibe (local-model agent runtime) — required to launch Local Model tabs.
  const [vibeInstalled, setVibeInstalled] = useState<boolean | null>(null);
  // OS-dependent Vibe install command (uv/PowerShell on Windows, script elsewhere).
  const [vibeStrategy, setVibeStrategy] = useState<VibeInstallStrategy | null>(null);
  const [vibeInstalling, setVibeInstalling] = useState(false);
  const [vibeInstallLog, setVibeInstallLog] = useState<string | null>(null);
  const vibeInstallLogRef = useRef<HTMLPreElement>(null);
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [serverRunning, setServerRunning] = useState<boolean | null>(null);
  // The update check shared with the header dropdown (`lib/agents/
  // ollamaUpdateActions`): its verdicts live in the activity store, so a check
  // run there shows here and the other way round.
  const updateVerdicts = useOllamaActivityStore((s) => s.updates);
  const checkingUpdates = useOllamaActivityStore((s) => s.checkingUpdates);
  const checkResult = useOllamaActivityStore((s) => s.checkResult);
  const ollamaVersion = useOllamaActivityStore((s) => s.version);
  // Where Ollama downloads models (`settings.ollama_models_path`) and how the
  // chosen path would reach the running server. The plan is re-read whenever the
  // path changes — an empty path asks only for the default + systemd facts.
  const modelsPath = settings?.ollama_models_path ?? "";
  const [modelsDirPlan, setModelsDirPlan] = useState<OllamaModelsDirPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  // Models currently being loaded into memory, keyed by name. Driven by the
  // global `ollama-load-progress` events so a load started from the brain menu
  // shows here too; Ollama streams no load percentage, so it's indeterminate.
  // Live downloads and the session's paused pulls come from the same shared
  // store (`initLocalModelEvents` below), so a pull started or paused from the
  // 🧠 menu offers its Pause / Resume here too.
  const loads = useOllamaActivityStore((s) => s.loads);
  // Per-tag registry facts (size, parameters, quantization, cloud), fetched
  // lazily and cached. The parameter count and size are what the search card
  // omits for a model with no size badge, so it is fetched from the manifest.
  const [tagInfo, setTagInfo] = useState<Record<string, TagInfo>>({});
  // Which size/tag each registry card's picker shows (default: its first).
  const [variantPick, setVariantPick] = useState<Record<string, string>>({});
  // Live download progress per model ref, keyed by the exact ref passed to
  // `pull_ollama_model`. `pct` is null during non-download phases (manifest,
  // verify, write) where Ollama reports no byte totals.
  const pullProgress = useOllamaActivityStore((s) => s.downloads);
  // Model refs whose download was interrupted by a previous Tabtivity exit/crash,
  // persisted by the backend. Each can be resumed ("Continue") since Ollama
  // picks up a partially-fetched model where it left off.
  const [interrupted, setInterrupted] = useState<string[]>([]);
  // Model refs the user paused mid-download this session. A paused pull keeps its
  // partial blobs (so it can be resumed) and offers Resume / Delete.
  const paused = useOllamaActivityStore((s) => s.paused);
  // Orphaned partial layers in Ollama's blob cache with no recoverable model
  // name — surfaced only so the user can delete them to reclaim space.
  const [orphans, setOrphans] = useState<{ digest: string; size: number; path: string }[]>([]);
  // Live registry browser (ollama.com/search): query, filters, lazy-loaded pages.
  const [regQuery, setRegQuery] = useState("");
  const [regQueryLive, setRegQueryLive] = useState(""); // debounced
  const [regTypes, setRegTypes] = useState<Set<string>>(new Set()); // empty = any
  const [regRuns, setRegRuns] = useState(""); // "" = either, else a REGISTRY_RUNS value
  const [regDownload, setRegDownload] = useState(""); // "" = any, else a REGISTRY_DOWNLOAD_SIZES value
  const [sortBy, setSortBy] = useState<SortKey>("popular");
  const [regModels, setRegModels] = useState<RegistryModel[]>([]);
  const [regPage, setRegPage] = useState(0);
  const [regLoading, setRegLoading] = useState(false);
  const [regDone, setRegDone] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<() => void>(() => {});
  // Bumped by every registry fetch: an answer that is no longer the latest
  // request's (the query or a filter changed meanwhile) is dropped.
  const regSeq = useRef(0);

  // Fetch a tag's registry facts (size + parameters + quantization) once. Called
  // on hover for a tag button, and eagerly for a row with no size badge (below),
  // where the parameters and size would otherwise be invisible.
  const fetchTagInfo = (fullName: string) => {
    if (fullName in tagInfo) return;
    setTagInfo((p) => ({ ...p, [fullName]: "loading" }));
    invoke<RegistryDetails>("ollama_registry_details", { model: fullName })
      .then((d) => setTagInfo((p) => ({ ...p, [fullName]: d })))
      .catch(() => setTagInfo((p) => ({ ...p, [fullName]: "error" })));
  };

  // The " — 4.7 GB" suffix a tag button's tooltip carries once its size is known
  // (empty for a cloud model, which downloads nothing, and while still loading).
  const tagSizeSuffix = (info: TagInfo | undefined): string => {
    if (info === undefined) return "";
    if (info === "loading") return t("ollama.sizeLoadingSuffix");
    if (info === "error" || info.size_bytes <= 0) return "";
    return ` — ${fmtBytes(info.size_bytes)}`;
  };

  // The quiet "9.7B · Q4_K_M · 4.7 GB" line under a registry card's size picker —
  // what the selected tag is and whether it fits. A cloud model downloads
  // nothing, so it shows its parameter count only.
  const tagFactText = (info: TagInfo | undefined): string => {
    if (info === "loading") return "…";
    if (!info || info === "error") return "";
    return [info.params, info.quant, info.size_bytes > 0 ? fmtBytes(info.size_bytes) : ""]
      .filter(Boolean)
      .join(" · ");
  };

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<OllamaModelInfo[]>("list_ollama_models_detailed");
      setModels(result);
      setServerRunning(true);
    } catch (e) {
      if (String(e).includes("not_running")) {
        setServerRunning(false);
        setModels([]);
      } else {
        setError(String(e));
      }
    } finally {
      setLoading(false);
    }
  };

  // Load installed/running models once Ollama itself is present. When it is
  // missing we show the install flow instead. The registry browser below loads
  // independently (it queries ollama.com, not the local server).
  const loadAfterInstall = () => {
    void refresh();
  };

  useEffect(() => {
    void (async () => {
      const ok = await invoke<boolean>("ollama_is_installed").catch(() => false);
      setInstalled(ok);
      if (ok) loadAfterInstall();
      else setLoading(false);
    })();
    // OS-dependent install command/wording for the install panel below.
    invoke<OllamaInstallStrategy>("ollama_install_strategy").then(setStrategy).catch(() => {});
    // Vibe is independent of Ollama; check it regardless so its status shows in
    // both the install-Ollama and main panels.
    invoke<boolean>("vibe_is_installed").then(setVibeInstalled).catch(() => setVibeInstalled(false));
    invoke<VibeInstallStrategy>("vibe_install_strategy").then(setVibeStrategy).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The installed Ollama version — a local read, no network (the registry half
  // only runs when the user presses "Check for updates").
  useEffect(() => {
    if (!installed) return;
    ollamaVersionStatus(false)
      .then((v) => useOllamaActivityStore.getState().mergeInstalledVersion(v))
      .catch(() => {});
  }, [installed]);

  // Live download progress and loads-into-memory, from any surface, in the shared
  // activity store. A paused pull stops streaming there and moves into `paused`,
  // so its row offers Resume / Delete.
  useEffect(() => initLocalModelEvents(), []);

  // A load that just finished: re-read the model list so the row flips to its
  // resident state. A model leaving `loads` is a success (an error stays in it).
  const prevLoads = useRef(loads);
  useEffect(() => {
    const finished = Object.keys(prevLoads.current).some((m) => prevLoads.current[m] === "loading" && !(m in loads));
    prevLoads.current = loads;
    if (finished) void refresh();
  }, [loads]);

  // Drop a model's progress once its pull settles (success or error).
  const clearPullProgress = (model: string) => useOllamaActivityStore.getState().dropDownload(model);

  // Live button label for an in-flight pull: a percentage when Ollama is
  // streaming byte totals, otherwise the caller's fallback (e.g. "Pulling…").
  const pullText = (model: string, busyFallback: string) => {
    const pct = pullProgress[model]?.pct;
    return pct != null ? `${pct}%` : busyFallback;
  };

  // Load the persisted interrupted-pull list + orphaned partial blobs once
  // Ollama is present.
  useEffect(() => {
    if (installed !== true) return;
    invoke<string[]>("list_pending_ollama_pulls").then(setInterrupted).catch(() => {});
    invoke<{ digest: string; size: number; path: string }[]>("list_orphan_partial_blobs")
      .then(setOrphans)
      .catch(() => {});
  }, [installed]);

  // Delete an orphaned partial layer to reclaim its disk space. The list is
  // re-read afterwards rather than trimmed optimistically: a delete the OS
  // refused (the system service's cache, authorization declined) must leave the
  // row in place next to its error, not vanish and reappear on the next open.
  const deleteOrphan = (path: string) => {
    setError("");
    void invoke("delete_partial_blob", { path })
      .catch((e) => setError(String(e)))
      .finally(() => {
        invoke<{ digest: string; size: number; path: string }[]>("list_orphan_partial_blobs")
          .then(setOrphans)
          .catch(() => {});
      });
  };

  // Reconcile interrupted entries against what's actually installed: any model
  // that completed before the crash (or has since finished) is dropped and its
  // stale record cleared on the backend.
  useEffect(() => {
    if (interrupted.length === 0) return;
    const names = new Set(models.map((m) => m.name));
    const done = interrupted.filter(
      (ref) => names.has(ref) || (!ref.includes(":") && names.has(`${ref}:latest`)),
    );
    if (done.length === 0) return;
    setInterrupted((p) => p.filter((m) => !done.includes(m)));
    done.forEach((m) => void invoke("clear_pending_ollama_pull", { model: m }));
  }, [models, interrupted]);

  // Resume an interrupted download — Ollama continues from the partial blobs.
  const continuePull = (model: string) => {
    setInterrupted((p) => p.filter((m) => m !== model));
    void withBusy(`${model}:pull`, () => invoke("pull_ollama_model", { model }));
  };

  // Forget an interrupted download without resuming it.
  const dismissPull = (model: string) => {
    setInterrupted((p) => p.filter((m) => m !== model));
    void invoke("clear_pending_ollama_pull", { model });
  };

  // Pause an in-flight download. The backend stops the stream at the next chunk,
  // keeps the partial blobs, and emits a "paused" progress event that flips the
  // row into the paused state (Resume / Delete).
  const pausePull = (model: string) => {
    void invoke("pause_ollama_pull", { model });
  };

  // Resume a paused download — re-pull, which Ollama continues from the partials.
  const resumePull = (model: string) => {
    useOllamaActivityStore.getState().clearPaused(model);
    void withBusy(`${model}:pull`, () => invoke("pull_ollama_model", { model }));
  };

  // Delete a paused download: drop its partial blobs and clear its pending record.
  const deletePausedPull = (model: string) => {
    useOllamaActivityStore.getState().clearPaused(model);
    setInterrupted((p) => p.filter((m) => m !== model));
    void invoke("delete_ollama_pull", { model })
      .then(() => refresh())
      .catch((e) => setError(String(e)));
  };

  const installVibe = async () => {
    setVibeInstalling(true);
    setVibeInstallLog("");
    try {
      await runWithProgress<{ line: string }, string>(
        "vibe-install-progress",
        (p) => setVibeInstallLog((prev) => (prev ? `${prev}\n${p.line}` : p.line)),
        () => invoke<string>("install_vibe"),
      );
      setVibeInstalled(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setVibeInstalling(false);
    }
  };

  // Keep the live Vibe install log pinned to the latest line.
  useEffect(() => {
    const el = vibeInstallLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [vibeInstallLog]);

  const installOllama = async () => {
    setInstalling(true);
    setError(null);
    setInstallLog("");
    try {
      // Stream the installer's output line-by-line so the user sees live progress.
      await runWithProgress<{ line: string }, string>(
        "ollama-install-progress",
        (p) => setInstallLog((prev) => (prev ? `${prev}\n${p.line}` : p.line)),
        () => invoke<string>("install_ollama"),
      );
      setInstalled(true);
      // Start the server and load the model catalog so the user can immediately
      // pick what to install next.
      loadAfterInstall();
      await startServer();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  // Keep the live install log pinned to the latest line.
  useEffect(() => {
    const el = installLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [installLog]);

  const startServer = async () => {
    setError(null);
    try {
      await invoke("ensure_ollama_running");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  // Read the download-location plan on mount and whenever the chosen path
  // changes, so the default placeholder and the systemd apply-to-service command
  // (which depends on the exact path) stay in step with the setting.
  useEffect(() => {
    let cancelled = false;
    invoke<OllamaModelsDirPlan>("ollama_models_dir_plan", { path: modelsPath || null })
      .then((p) => {
        if (!cancelled) setModelsDirPlan(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [modelsPath]);

  const chooseModelsDir = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: modelsPath || undefined,
    });
    if (typeof picked === "string") {
      // Trailing slashes off so the stored value matches what the drop-in and
      // the placeholder show (mirrors the project-location picker).
      await updateSettings({ ollama_models_path: picked.replace(/\/+$/, "") });
    }
  };

  // Back to Ollama's own default — `null`, never `""`: the backend field is
  // skipped when absent, and a stored empty string would be a second spelling of
  // "unset" for every reader to special-case.
  const clearModelsDir = () => {
    void updateSettings({ ollama_models_path: null });
  };

  // Point the *running* server at the chosen folder (systemd drop-in), in a
  // visible terminal — it needs a root password and rewrites a service the user
  // is entitled to read first. The setting alone already covers a server Tabtivity
  // starts itself.
  const applyModelsDirToService = () => {
    if (!modelsDirPlan?.service_cmd) return;
    runInstallInTab(
      t("ollama.modelLocationApplyTabLabel"),
      modelsDirPlan.service_cmd,
      (modelsDirPlan.shell_kind || "bash") as InstallShellKind,
    );
  };

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy((prev) => ({ ...prev, [key]: true }));
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
      if (key.endsWith(":pull")) clearPullProgress(key.slice(0, -":pull".length));
    }
  };

  // Pull an arbitrary model ref typed into the registry search bar. Reuses the
  // same pull command as the catalog, so it accepts anything on the registry
  // (`name`, `name:tag`, `namespace/name:tag`) — not just the curated catalog.
  const pullTyped = async () => {
    const model = regQuery.trim();
    if (!model) return;
    const key = `${model}:pull`;
    setBusy((prev) => ({ ...prev, [key]: true }));
    setError(null);
    try {
      await invoke("pull_ollama_model", { model });
      setRegQuery(""); // clear only on success; errors keep the typed ref
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
      clearPullProgress(model);
    }
  };

  const installedNames = useMemo(() => new Set(models.map((m) => m.name)), [models]);

  // ── Live registry browser ────────────────────────────────────────────────
  // Filters and sort are ollama.com's own (see `search_ollama_registry`), so
  // every page arrives filtered and in order and scrolling just appends.
  const regCapabilities = [...regTypes, regRuns].filter(Boolean);
  const regFilterKey = `${regCapabilities.join(",")}|${regDownload}|${sortBy}`;

  // Fetch one page of ollama.com/search results. `reset` replaces the list
  // (new query/filter/sort); otherwise it appends, de-duping by name across
  // pages (a model published meanwhile shifts the pages by one).
  const loadRegistryPage = async (page: number, reset: boolean) => {
    const seq = ++regSeq.current;
    setRegLoading(true);
    setRegError(null);
    if (reset) {
      setRegModels([]);
      setRegPage(0);
      setRegDone(false);
    }
    try {
      const result = await invoke<RegistrySearchPage>("search_ollama_registry", {
        query: regQueryLive.trim(),
        capabilities: regCapabilities,
        size: regDownload,
        sort: sortBy,
        page,
      });
      if (seq !== regSeq.current) return;
      setRegPage(page);
      setRegDone(!result.hasMore);
      setRegModels((prev) => {
        if (reset) return result.models;
        const seen = new Set(prev.map((m) => m.name));
        return [...prev, ...result.models.filter((m) => !seen.has(m.name))];
      });
    } catch (e) {
      if (seq !== regSeq.current) return;
      setRegError(String(e));
      setRegDone(true);
    } finally {
      if (seq === regSeq.current) setRegLoading(false);
    }
  };

  // Debounce the query box so we don't hit ollama.com on every keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => setRegQueryLive(regQuery), 350);
    return () => window.clearTimeout(id);
  }, [regQuery]);

  // (Re)load page 1 whenever the query, a filter or the sort changes.
  useEffect(() => {
    if (installed !== true) return;
    void loadRegistryPage(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regQueryLive, regFilterKey, installed]);

  // Load the next page while the sentinel under the list is in (or near) view,
  // once page 1 is in (that one is the effect's above). The observer is
  // re-armed after every page: observing fires once with the current state, so
  // a page that still leaves the sentinel visible (a short page, a tall window)
  // pulls the next one instead of stalling.
  const canLoadMore = !regLoading && !regDone && regPage > 0;
  loadMoreRef.current = () => {
    if (canLoadMore) void loadRegistryPage(regPage + 1, false);
  };
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !canLoadMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreRef.current();
      },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canLoadMore, regPage]);

  const toggleType = (key: string) =>
    setRegTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Rows with no size badge on their search card (cloud models, single-variant
  // models) carry their parameter count and size only in the registry manifest,
  // not the search HTML — so fetch those few eagerly, or the card would show a
  // bare "pull"/"cloud" button with no parameters and no size to judge fit by.
  useEffect(() => {
    for (const m of regModels) {
      if (m.sizes.length === 0) {
        fetchTagInfo(`${m.name}:${m.capabilities.includes("cloud") ? "cloud" : "latest"}`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regModels]);

  // "Load on Tabtivity start" — which models `stores/agents/ollamaAutoload` warms into
  // memory at launch. Both controls write straight through: the per-model switch
  // on each downloaded card (the same setting the 🧠 menu's chip toggles, so the
  // two surfaces cannot disagree) and the Energy Saver opt-out, which flashes
  // "Saved" instead of hiding behind a Save button.
  const autoloadModels = settings?.ollama_autoload_models ?? [];
  const saverPref = settings?.ollama_autoload_in_energy_saver === true;
  const [saverSaved, setSaverSaved] = useState(false);
  const toggleAutoload = (name: string) => {
    const next = autoloadModels.includes(name)
      ? autoloadModels.filter((m) => m !== name)
      : [...autoloadModels, name];
    void updateSettings({ ollama_autoload_models: next });
  };
  const setSaverPref = (on: boolean) => {
    void updateSettings({ ollama_autoload_in_energy_saver: on }).then(() => {
      setSaverSaved(true);
      window.setTimeout(() => setSaverSaved(false), 2000);
    });
  };

  const runningModels = models.filter((m) => m.running);
  const loadedLabel =
    runningModels.length === 0
      ? serverRunning
        ? t("ollama.noModelLoaded")
        : t("ollama.noLoadedModel")
      : t("ollama.loadedModels", { names: runningModels.map((m) => m.name).join(", ") });

  // Vibe runtime — required to launch Local Model tabs. Its install steps (shown
  // only while it is missing) are shared by the install-Ollama page's card and
  // the running page's status card, where a ready runtime is a single line.
  const vibeInstallBlock = (
    <>
      <p className="settings-help">
        {t("ollama.vibeMissing1")} <code>vibe</code> {t("ollama.vibeMissing2")}
      </p>
      <div className="ollama-install-cmd-row">
        <button
          type="button"
          className="ollama-action-btn primary"
          disabled={vibeInstalling}
          onClick={() => void installVibe()}
        >
          {vibeInstalling ? t("ollama.installingEllipsis") : t("ollama.installVibe")}
        </button>
        {vibeInstalling && <span className="ollama-status-text">{t("ollama.runningInstaller")}</span>}
      </div>
      {vibeInstallLog !== null && (
        <pre className="ollama-install-log" ref={vibeInstallLogRef}>
          {vibeInstallLog || t("ollama.startingEllipsis")}
        </pre>
      )}
      <p className="settings-help">
        {t("ollama.orInstallInShellPre")} {vibeStrategy?.os === "windows" ? "PowerShell" : "terminal"}{" "}
        {t("ollama.orInstallInShellPost")}
      </p>
      <div className="ollama-install-cmd-row">
        <code className="ollama-install-cmd">{vibeStrategy?.command ?? VIBE_INSTALL_CMD}</code>
        <button
          type="button"
          className="ollama-action-btn primary"
          onClick={() =>
            runInstallInTab(
              t("install.vibeTabLabel"),
              vibeStrategy?.command ?? VIBE_INSTALL_CMD,
              vibeStrategy?.os === "windows" ? "powershell" : "bash",
            )
          }
        >
          {t("ollama.runInTerminal")}
        </button>
        <button
          type="button"
          className="ollama-action-btn"
          disabled={vibeInstalling}
          onClick={() =>
            void invoke<boolean>("vibe_is_installed")
              .then((ok) => {
                setVibeInstalled(ok);
                if (!ok)
                  setError(
                    vibeStrategy?.os === "windows"
                      ? t("ollama.vibeStillNotDetectedWindows")
                      : t("ollama.vibeStillNotDetectedOther"),
                  );
              })
              .catch(() => {})
          }
        >
          {t("common.recheck")}
        </button>
      </div>
    </>
  );

  // The install-Ollama page's runtime card.
  const vibeSection = (
    <SettingsCard className="ollama-vibe-section">
      <div className="settings-subheader">{t("ollama.vibeTitle")}</div>
      {vibeInstalled === null ? (
        <p className="settings-help">{t("ollama.vibeChecking")}</p>
      ) : vibeInstalled ? (
        <p className="settings-help">
          <span className="ollama-status-dot running" /> {t("ollama.vibeInstalled")}
        </p>
      ) : (
        vibeInstallBlock
      )}
    </SettingsCard>
  );

  // ── Not installed: show the (semi-)automated installer + manual steps ──────
  if (installed === false) {
    // OS-dependent install guidance from the backend (winget on Windows, the
    // install script on Linux/macOS); fall back to the script until it loads.
    const installCmd = strategy?.command ?? OLLAMA_INSTALL_CMD_FALLBACK;
    const downloadUrl = strategy?.download_url ?? OLLAMA_DOWNLOAD_URL;
    const isWindows = strategy?.os === "windows";
    return (
      <>
        <SettingsHeader title={t("ollama.installTitle")} onBack={onBack} onClose={onClose} />
        <div className="dialog-scroll">

        <p className="settings-help">{t("ollama.notInstalledHelp")}</p>

        <SettingsSection
          title={t("ollama.automaticInstall")}
          help={isWindows ? t("ollama.autoInstallHelpWindows") : t("ollama.autoInstallHelpOther")}
        />
        <div className="ollama-install-cmd-row">
          <button
            type="button"
            className="ollama-action-btn primary"
            disabled={installing}
            onClick={() => void installOllama()}
          >
            {installing ? t("ollama.installingEllipsis") : t("ollama.installBtn")}
          </button>
          {installing && <span className="ollama-status-text">{t("ollama.runningInstaller")}</span>}
        </div>

        {error && <ErrorNote className="project-dialog-error" error={error} />}
        {installLog !== null && (
          <pre className="ollama-install-log" ref={installLogRef}>
            {installLog || t("ollama.startingEllipsis")}
          </pre>
        )}

        <div className="settings-section-title">{t("ollama.installInTerminalTitle")}</div>
        <ol className="ollama-install-steps">
          <li>
            {t("ollama.runInstallerNewPre")}{" "}
            {isWindows ? "PowerShell" : "terminal"} {t("ollama.runInstallerNewPost")}
            <div className="ollama-install-cmd-row">
              <code className="ollama-install-cmd">{installCmd}</code>
              <button
                type="button"
                className="ollama-action-btn primary"
                onClick={() =>
                  runInstallInTab(t("install.ollamaTabLabel"), installCmd, isWindows ? "default" : "bash")
                }
              >
                {t("ollama.runInTerminal")}
              </button>
            </div>
            <span className="settings-help">
              {t("ollama.alsoDownloadFrom")}{" "}
              <code>{downloadUrl}</code>.
            </span>
          </li>
          <li>
            {isWindows ? t("ollama.approveUacPrompt") : t("ollama.enterPasswordSudo")}
          </li>
          <li>
            {t("ollama.onceFinishedClickPre")} <strong>{t("common.recheck")}</strong>{" "}
            {t("ollama.onceFinishedClickPost")}
          </li>
        </ol>
        <button
          type="button"
          className="ollama-action-btn"
          disabled={installing}
          onClick={() =>
            void (async () => {
              const ok = await invoke<boolean>("ollama_is_installed").catch(() => false);
              setInstalled(ok);
              if (ok) {
                loadAfterInstall();
                await startServer();
              } else {
                setError(t("ollama.stillNotDetected"));
              }
            })()
          }
        >
          {t("common.recheck")}
        </button>

        {vibeSection}
        </div>
      </>
    );
  }

  // A section's heading: sentence-case title, a quiet count, and room on the
  // right for that section's own controls.
  const sectionHead = (title: ReactNode, count?: number) => (
    <div className="ollama-section-head" role="heading" aria-level={3}>
      <span className="ollama-section-name">{title}</span>
      {count !== undefined && <span className="ollama-section-count">{count}</span>}
    </div>
  );

  // A typed query that is plainly a model reference (`name:tag`,
  // `namespace/name`, or an exact registry name) offers a direct pull beside
  // the search it is also feeding.
  const typedRef = regQuery.trim();
  const typedIsRef =
    typedRef !== "" &&
    !/\s/.test(typedRef) &&
    (/[:/]/.test(typedRef) || regModels.some((m) => m.name === typedRef));
  const typedBusy = !!busy[`${typedRef}:pull`];

  // One registry card: name, one-line description, capability badges, quiet
  // size/pulls text, and a real Pull button on the foot. A model with several
  // sizes gets a size picker; a bare "latest"/"cloud" model pulls directly.
  const registryCard = (m: RegistryModel) => {
    const isCloud = m.capabilities.includes("cloud");
    const hasSizes = m.sizes.length > 0;
    const picked = variantPick[m.name];
    const tag = hasSizes ? (picked && m.sizes.includes(picked) ? picked : m.sizes[0]) : isCloud ? "cloud" : "latest";
    const fullName = `${m.name}:${tag}`;
    const isInstalled = installedNames.has(fullName);
    const busyKey = `${fullName}:pull`;
    const info = tagInfo[fullName];
    const facts = tagFactText(info);
    const meta = [m.pulls && t("ollama.pullsSuffix", { pulls: m.pulls }), m.updated].filter(Boolean).join(" · ");
    // The registry page's badges are scraped as capabilities, and a cloud
    // model's pricing badge ("Medium usage $0.30 in · …") rides along: a
    // one-word capability stays a badge, anything longer is quiet text.
    const caps = m.capabilities.filter((c) => !/\s/.test(c));
    const notes = m.capabilities.filter((c) => /\s/.test(c));
    return (
      <div className="ollama-catalog-row" key={m.name}>
        <div className="ollama-catalog-header">
          <span className="ollama-model-name">{m.name}</span>
        </div>
        {meta && <div className="ollama-catalog-hint">{meta}</div>}
        {m.description && <div className="ollama-catalog-desc">{m.description}</div>}
        {(caps.length > 0 || m.community) && (
          <div className="ollama-caps">
            {m.community && (
              <span className="ollama-cap" title={t("ollama.communityTitle", { user: m.name.split("/")[0] })}>
                {t("ollama.communityBadge")}
              </span>
            )}
            {caps.map((c) => (
              <span className="ollama-cap" key={c}>
                {c}
              </span>
            ))}
          </div>
        )}
        {notes.map((n) => (
          <div className="ollama-catalog-hint" key={n}>
            {n}
          </div>
        ))}
        <div
          className="ollama-catalog-foot"
          onMouseEnter={() => fetchTagInfo(fullName)}
          onFocus={() => fetchTagInfo(fullName)}
        >
          <div className="ollama-catalog-pick">
            {hasSizes && (
              <Dropdown
                className="ollama-variant"
                value={tag}
                ariaLabel={t("ollama.variantLabel", { name: m.name })}
                onChange={(v) => {
                  setVariantPick((p) => ({ ...p, [m.name]: v }));
                  fetchTagInfo(`${m.name}:${v}`);
                }}
                options={m.sizes.map((s) => ({
                  value: s,
                  label: installedNames.has(`${m.name}:${s}`) ? `${s} ✓` : s,
                }))}
              />
            )}
            {facts && <span className="ollama-catalog-facts">{facts}</span>}
          </div>
          <button
            type="button"
            className={`ollama-action-btn${isInstalled ? "" : " primary"}`}
            disabled={!!busy[busyKey]}
            title={t(isInstalled ? "ollama.tagUpdateTitle" : "ollama.tagDownloadTitle", {
              name: fullName,
              size: tagSizeSuffix(info),
            })}
            onClick={() =>
              void withBusy(busyKey, () => invoke("pull_ollama_model", { model: fullName }))
            }
          >
            {busy[busyKey]
              ? pullText(fullName, t("ollama.pulling"))
              : isInstalled
                ? t("ollama.update")
                : t("ollama.pull")}
          </button>
        </div>
      </div>
    );
  };

  const filterGroup = (
    label: string,
    anyActive: boolean,
    onAny: () => void,
    items: { key: string; label: string; active: boolean; toggle: () => void }[],
  ) => (
    <div className="ollama-filter-group">
      <span className="ollama-filter-label">{label}</span>
      <div className="ollama-seg" role="group" aria-label={label}>
        <button type="button" className={anyActive ? "active" : ""} aria-pressed={anyActive} onClick={onAny}>
          {t("ollama.any")}
        </button>
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className={it.active ? "active" : ""}
            aria-pressed={it.active}
            onClick={it.toggle}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <SettingsHeader title={t("ollama.modelsTitle")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">

      <div className={`ollama-status-card${serverRunning === false ? " down" : ""}`}>
        <div className="ollama-status-main">
          <span className={`ollama-status-dot ${serverRunning ? "running" : "stopped"}`} />
          <div className="ollama-status-copy">
            <div className="ollama-status-title">
              {serverRunning === null
                ? t("ollama.checkingEllipsis")
                : serverRunning
                  ? t("ollama.serverRunning")
                  : t("ollama.serverNotRunning")}
            </div>
            {serverRunning === true && <div className="ollama-status-sub">{loadedLabel}</div>}
          </div>
          {serverRunning === false && (
            <button type="button" className="ollama-action-btn primary" onClick={() => void startServer()}>
              {t("ollama.start")}
            </button>
          )}
          {serverRunning === true && (
            <button
              type="button"
              className="ollama-action-btn"
              disabled={loading}
              onClick={() => void refresh()}
            >
              {loading ? "..." : t("ollama.refresh")}
            </button>
          )}
        </div>
        {installed && serverRunning === true && (
          <div className="ollama-runtime-row">
            <span className="ollama-runtime-name">
              {ollamaVersion?.current
                ? ollamaVersion.latest && !ollamaVersion.update_available
                  ? t("localModel.ollamaVersionCurrent", { current: ollamaVersion.current })
                  : t("localModel.ollamaVersion", { current: ollamaVersion.current })
                : "Ollama"}
            </span>
            <span className="lm-status-actions">
              {!checkingUpdates && checkResult && !(checkResult.ok && checkResult.updates > 0) && (
                <span className="lm-status-note">
                  {checkResult.ok ? t("localModel.updatesNone") : checkResult.reason}
                </span>
              )}
              {ollamaVersion?.update_available && (
                <button
                  type="button"
                  className="ollama-action-btn primary"
                  title={`${t("localModel.ollamaUpdateSentence", {
                    latest: ollamaVersion.latest,
                    current: ollamaVersion.current,
                  })} — ${t("localModel.ollamaUpgradeTitle", { latest: ollamaVersion.latest })}`}
                  onClick={() =>
                    upgradeOllamaInTab(
                      t,
                      ollamaVersion,
                      models.filter((m) => m.running).map((m) => m.name),
                    )
                  }
                >
                  {t("localModel.ov.upgradeTo", { latest: ollamaVersion.latest })}
                </button>
              )}
              {models.length > 0 && (
                <button
                  type="button"
                  className="ollama-action-btn"
                  disabled={checkingUpdates}
                  title={t("localModel.checkUpdatesTitle")}
                  onClick={() => runOllamaUpdateCheck(t)}
                >
                  {checkingUpdates ? t("localModel.checkingUpdates") : t("localModel.checkUpdates")}
                </button>
              )}
            </span>
          </div>
        )}
        <div className="ollama-runtime-row">
          <span className="ollama-runtime-name">{t("ollama.vibeTitle")}</span>
          <span className={`ollama-runtime-state${vibeInstalled ? " ok" : ""}`}>
            {vibeInstalled === null
              ? t("ollama.checkingEllipsis")
              : vibeInstalled
                ? t("ollama.vibeReady")
                : t("ollama.vibeNotInstalled")}
          </span>
        </div>
        {vibeInstalled === false && <div className="ollama-runtime-install">{vibeInstallBlock}</div>}
      </div>

      {error && <ErrorNote className="project-dialog-error" error={error} />}

      {(() => {
        // Interrupted entries not currently being (re)pulled — these get a
        // "Continue" action; live pulls show their streaming progress bar.
        const resumable = interrupted.filter((m) => !(m in pullProgress) && !paused.includes(m));
        if (
          Object.keys(pullProgress).length === 0 &&
          resumable.length === 0 &&
          paused.length === 0 &&
          orphans.length === 0
        )
          return null;
        return (
          <>
            {sectionHead(t("ollama.downloadingTitle"))}
            <div className="settings-list">
              {Object.entries(pullProgress).map(([model, pr]) => (
                <div className="ollama-model-row" key={model}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{model}</span>
                    <span className="ollama-model-size">
                      {pr.pct != null ? `${pr.pct}%` : "…"}
                    </span>
                  </div>
                  <div className="ollama-download-bar">
                    <div
                      className={`ollama-download-bar-fill${pr.pct == null ? " indeterminate" : ""}`}
                      style={pr.pct != null ? { width: `${pr.pct}%` } : undefined}
                    />
                  </div>
                  {pr.status && <div className="ollama-download-status">{pr.status}</div>}
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-action-btn"
                      title={t("ollama.pauseTitle")}
                      onClick={() => pausePull(model)}
                    >
                      {t("ollama.pause")}
                    </button>
                  </div>
                </div>
              ))}
              {paused.map((model) => (
                <div className="ollama-model-row" key={`paused:${model}`}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{model}</span>
                    <span className="ollama-model-size">{t("ollama.pausedBadge")}</span>
                  </div>
                  <div className="ollama-download-status">{t("ollama.downloadPaused")}</div>
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-action-btn primary"
                      onClick={() => resumePull(model)}
                    >
                      {t("ollama.resume")}
                    </button>
                    <button
                      type="button"
                      className="ollama-ghost-btn danger"
                      title={t("ollama.deletePartialTitle")}
                      onClick={() => deletePausedPull(model)}
                    >
                      {t("ollama.delete")}
                    </button>
                  </div>
                </div>
              ))}
              {resumable.map((model) => (
                <div className="ollama-model-row" key={`int:${model}`}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{model}</span>
                    <span className="ollama-model-size">{t("ollama.interruptedBadge")}</span>
                  </div>
                  <div className="ollama-download-status">{t("ollama.downloadInterrupted")}</div>
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-action-btn primary"
                      onClick={() => continuePull(model)}
                    >
                      {t("ollama.continueDownload")}
                    </button>
                    <button
                      type="button"
                      className="ollama-ghost-btn"
                      title={t("ollama.dismissTitle")}
                      onClick={() => dismissPull(model)}
                    >
                      {t("ollama.dismiss")}
                    </button>
                  </div>
                </div>
              ))}
              {orphans.length > 0 && (
                <div className="ollama-download-status">
                  {t(orphans.length === 1 ? "ollama.orphansSummaryOne" : "ollama.orphansSummaryMany", {
                    count: orphans.length,
                    size: fmtBytes(orphans.reduce((sum, o) => sum + o.size, 0)),
                  })}
                </div>
              )}
              {orphans.map((o) => (
                <div className="ollama-model-row" key={o.path}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{t("ollama.orphanLayer", { digest: o.digest })}</span>
                    <span className="ollama-model-size">{fmtBytes(o.size)}</span>
                  </div>
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-ghost-btn danger"
                      title={t("ollama.deleteLayerTitle")}
                      onClick={() => deleteOrphan(o.path)}
                    >
                      {t("ollama.delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        );
      })()}

      {sectionHead(t("ollama.downloadedModelsTitle"), loading ? undefined : models.length)}
      {loading ? (
        <div className="ollama-empty">{t("common.loading")}</div>
      ) : models.length === 0 ? (
        <div className="ollama-empty">{t("ollama.noModelsDownloaded")}</div>
      ) : (
        <div className="settings-list">
          {models.map((m) => {
            const loadingNow = busy[`${m.name}:load`] || loads[m.name] === "loading";
            const meta = [fmtBytes(m.size), m.parameter_size, m.quantization, m.family]
              .filter(Boolean)
              .join(" · ");
            return (
              <div className={`ollama-model-row ollama-model-card${m.running ? " running" : ""}`} key={m.name}>
                <div className="ollama-model-header">
                  <span className="ollama-model-name">{m.name}</span>
                  {m.running && (
                    <span className={`ollama-live${m.size_vram > 0 ? " gpu" : ""}`}>
                      {t("ollama.inMemory")} · {m.size_vram > 0 ? `GPU ${fmtBytes(m.size_vram)}` : "CPU"}
                    </span>
                  )}
                </div>
                <div className="ollama-model-meta">{meta}</div>
                <div className="ollama-model-actions">
                  {m.running ? (
                    <button
                      type="button"
                      className="ollama-action-btn"
                      disabled={busy[`${m.name}:stop`]}
                      title={t("ollama.unloadTitle")}
                      onClick={() =>
                        void withBusy(`${m.name}:stop`, () =>
                          invoke("stop_ollama_model", { model: m.name }),
                        )
                      }
                    >
                      {busy[`${m.name}:stop`] ? "..." : t("ollama.unload")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ollama-action-btn primary"
                      disabled={loadingNow}
                      title={t("ollama.loadTitle")}
                      onClick={() =>
                        void withBusy(`${m.name}:load`, () =>
                          invoke("load_ollama_model", { model: m.name }),
                        )
                      }
                    >
                      {loadingNow ? t("ollama.loading") : t("ollama.load")}
                    </button>
                  )}
                  <span className="ollama-model-actions-end">
                    <button
                      type="button"
                      className={`ollama-ghost-btn${updateVerdicts[m.name]?.update_available ? " primary" : ""}`}
                      disabled={busy[`${m.name}:pull`]}
                      title={t("ollama.updateTitle")}
                      onClick={() =>
                        void withBusy(`${m.name}:pull`, () =>
                          invoke("pull_ollama_model", { model: m.name }),
                        )
                      }
                    >
                      {busy[`${m.name}:pull`] ? pullText(m.name, t("ollama.updating")) : t("ollama.update")}
                    </button>
                    <button
                      type="button"
                      className="ollama-ghost-btn danger"
                      disabled={busy[`${m.name}:del`]}
                      title={t("ollama.deleteModelTitle")}
                      onClick={() =>
                        void withBusy(`${m.name}:del`, () =>
                          invoke("delete_ollama_model", { model: m.name }),
                        )
                      }
                    >
                      {busy[`${m.name}:del`] ? "..." : t("ollama.delete")}
                    </button>
                  </span>
                </div>
                {loadingNow && (
                  <div className="ollama-load-progress" title={t("ollama.loadingIntoMemoryTitle")}>
                    <div className="ollama-download-bar">
                      <div className="ollama-download-bar-fill indeterminate" />
                    </div>
                    <span className="ollama-download-status">{t("ollama.loadingIntoMemory")}</span>
                  </div>
                )}
                <label className="ollama-model-autostart">
                  <span>{t("ollama.loadAtStart")}</span>
                  <Toggle
                    size="sm"
                    checked={autoloadModels.includes(m.name)}
                    onChange={() => toggleAutoload(m.name)}
                    title={t("ollama.autostartToggleTitle", { name: m.name })}
                  />
                </label>
              </div>
            );
          })}
        </div>
      )}

      {models.length > 0 && (
        <SettingsCard className="ollama-startup">
          <div className="settings-subheader">
            {t("ollama.autostartTitle")} <UntestedTag id="ollama.autostartTitle" />
          </div>
          <ToggleRow
            label={t("ollama.autostartInSaver")}
            checked={saverPref}
            onChange={(e) => setSaverPref(e.target.checked)}
            aside={saverSaved ? <span className="ollama-status-text">{t("ollama.autostartSaved")}</span> : null}
          />
          <p className="settings-help">{t("ollama.autostartInSaverHelp")}</p>
        </SettingsCard>
      )}

      <SettingsAdvanced title={t("ollama.storageTitle")}>
        <SettingsCard>
          <div className="settings-subheader">
            {t("ollama.modelLocationTitle")} <UntestedTag id="ollama.modelLocationTitle" />
          </div>
          <div className="ollama-path-row">
            <code className="ollama-path" title={modelsPath || modelsDirPlan?.default_dir}>
              {modelsPath || modelsDirPlan?.default_dir || "…"}
            </code>
            {!modelsPath && <span className="ollama-path-default">{t("common.default")}</span>}
            <button type="button" className="ollama-action-btn" onClick={() => void chooseModelsDir()}>
              {t("ollama.modelLocationBrowse")}
            </button>
            {modelsPath && (
              <button type="button" className="ollama-action-btn" onClick={clearModelsDir}>
                {t("ollama.modelLocationReset")}
              </button>
            )}
          </div>
          <p className="settings-help">{t("ollama.modelLocationHelp")}</p>
          {modelsDirPlan?.systemd_service && (
            <>
              <p className="settings-help">{t("ollama.modelLocationSystemdHelp")}</p>
              {modelsDirPlan.service_cmd && (
                <div className="ollama-install-cmd-row">
                  <button
                    type="button"
                    className="ollama-action-btn primary"
                    title={modelsDirPlan.service_cmd}
                    onClick={applyModelsDirToService}
                  >
                    {t("ollama.modelLocationApply")}
                  </button>
                </div>
              )}
            </>
          )}
        </SettingsCard>
      </SettingsAdvanced>

      {sectionHead(
        <>
          {t("ollama.browseRegistry")} <UntestedTag id="ollama.browseRegistry" />
        </>,
      )}

      <div className="ollama-browse-bar">
        <input
          type="text"
          className="ollama-search-input"
          placeholder={t("ollama.searchOrPullPlaceholder")}
          aria-label={t("ollama.searchOrPullPlaceholder")}
          value={regQuery}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={typedBusy}
          onChange={(e) => setRegQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && typedIsRef) void pullTyped();
          }}
        />
        {typedIsRef && (
          <button
            type="button"
            className="ollama-action-btn primary ollama-pull-ref"
            disabled={typedBusy}
            title={typedRef}
            onClick={() => void pullTyped()}
          >
            {typedBusy ? pullText(typedRef, t("ollama.pulling")) : t("ollama.pullRef", { ref: typedRef })}
          </button>
        )}
      </div>

      <div className="ollama-filters">
        {filterGroup(
          t("ollama.filterType"),
          regTypes.size === 0,
          () => setRegTypes(new Set()),
          REGISTRY_TYPES.map((cap) => ({
            key: cap,
            label: t(`ollama.cap.${cap}` as TranslationKey),
            active: regTypes.has(cap),
            toggle: () => toggleType(cap),
          })),
        )}
        {filterGroup(
          t("ollama.filterRuns"),
          regRuns === "",
          () => setRegRuns(""),
          REGISTRY_RUNS.map((where) => ({
            key: where,
            label: t(`ollama.runs.${where}`),
            active: regRuns === where,
            toggle: () => setRegRuns((prev) => (prev === where ? "" : where)),
          })),
        )}
        {filterGroup(
          t("ollama.filterDownload"),
          regDownload === "",
          () => setRegDownload(""),
          REGISTRY_DOWNLOAD_SIZES.map((cap) => ({
            key: cap,
            label: cap === "over64" ? t("ollama.sizeOver", { gb: 64 }) : t("ollama.sizeUpTo", { gb: cap }),
            active: regDownload === cap,
            toggle: () => setRegDownload((prev) => (prev === cap ? "" : cap)),
          })),
        )}
        <label className="ollama-sort-label" title={t("ollama.sortBy")}>
          {t("ollama.sortBy")}
          <Dropdown
            className="ollama-catalog-sort"
            value={sortBy}
            onChange={(v) => setSortBy(v as SortKey)}
            options={SORT_OPTIONS.map((o) => ({ value: o.key, label: t(o.labelKey) }))}
          />
        </label>
      </div>

      {regError && (
        <div className="ollama-reg-error">
          <ErrorNote className="project-dialog-error" error={regError} />
          <button
            type="button"
            className="ollama-action-btn"
            disabled={regLoading}
            onClick={() => void loadRegistryPage(1, true)}
          >
            {t("ollama.refresh")}
          </button>
        </div>
      )}

      <div className="settings-list">
        {regModels.map(registryCard)}

        {/* Lazy-load sentinel + status line. */}
        {regLoading && <div className="ollama-empty">{t("common.loading")}</div>}
        {!regLoading && !regError && regModels.length === 0 && (
          <div className="ollama-empty">{t("ollama.noModelsFound")}</div>
        )}
        <div ref={sentinelRef} aria-hidden="true" />
        {regDone && regModels.length > 0 && (
          <div className="ollama-empty">{t("ollama.endOfResults")}</div>
        )}
      </div>
      </div>
    </>
  );
}
