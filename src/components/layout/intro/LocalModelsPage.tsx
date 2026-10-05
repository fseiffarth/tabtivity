import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useT } from "../../../lib/i18n";
import { formatBytes } from "../../../lib/formatBytes";
import { IS_WINDOWS } from "../../../lib/platform";
import { runInstallInTab } from "../../../lib/installCommand";
import { useOllamaStatus } from "../../../lib/ollamaStatus";
import { listLocalDrivers, loadOllamaModel, type LocalDriverInfo } from "../../../lib/agents/localDrivers";
import type { GpuSample } from "../../../lib/gpu";
import { useSettingsStore } from "../../../stores/settings";
import { UntestedTag } from "../../common/UntestedTag";
import { GPU_SIZING_MIN_BYTES, recommendModel, sameModel, type ModelPick } from "./introData";
import { IntroActions, IntroStatus, IntroStep, IntroSteps, startLessonById } from "./introUi";
import { ErrorNote } from "../../common/ErrorNote";

/** Backend `OllamaInstallStrategy` (`ollama_install_strategy`). */
interface InstallStrategy {
  os: string;
  command: string;
  auto: boolean;
  download_url: string;
}

/** The slice of `list_ollama_models_detailed` this page reads. */
interface LocalModel {
  name: string;
  running: boolean;
  size_vram: number;
}

const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

/**
 * Intro page 4 — a local model, step by step: install Ollama, start it, pull a
 * model sized for this machine, load it onto the GPU, use it in a Local Model
 * tab, and (optionally) for autocomplete. Every probe is local (Ollama is on
 * this machine) and lives only while this page is mounted, i.e. visible; the
 * Ollama lamp rides the app's one shared poller (`useOllamaStatus`).
 */
export function LocalModelsPage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const tabsModel = settings?.ollama_roles?.tabs ?? settings?.ollama_model;

  const [installed, setInstalled] = useState<boolean | null>(null);
  const [strategy, setStrategy] = useState<InstallStrategy | null>(null);
  const [models, setModels] = useState<LocalModel[] | null>(null);
  const [pick, setPick] = useState<ModelPick | null>(null);
  const [machine, setMachine] = useState<{ ram: number; vram: number } | null>(null);
  const [pull, setPull] = useState<{ pct: number | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [drivers, setDrivers] = useState<LocalDriverInfo[] | null>(null);
  const [vibe, setVibe] = useState<boolean | null>(null);
  const [vibeStrategy, setVibeStrategy] = useState<{ os: string; command: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const status = useOllamaStatus(installed === true);
  const serverUp = status !== "stopped";

  const refreshModels = useCallback(() => {
    void invoke<LocalModel[]>("list_ollama_models_detailed")
      .then((m) => {
        if (live.current) setModels(m);
      })
      .catch(() => {
        if (live.current) setModels(null);
      });
  }, []);

  useEffect(() => {
    void invoke<boolean>("ollama_is_installed")
      .then((ok) => {
        if (live.current) setInstalled(ok);
      })
      .catch(() => {
        if (live.current) setInstalled(false);
      });
    void invoke<InstallStrategy>("ollama_install_strategy")
      .then((s) => {
        if (live.current) setStrategy(s);
      })
      .catch(() => {});
    // Mistral (Vibe) is the default Local Model tab runner.
    void invoke<boolean>("vibe_is_installed")
      .then((ok) => {
        if (live.current) setVibe(ok);
      })
      .catch(() => {
        if (live.current) setVibe(false);
      });
    void invoke<{ os: string; command: string }>("vibe_install_strategy")
      .then((v) => {
        if (live.current) setVibeStrategy(v);
      })
      .catch(() => {});
    // Machine size, once, for the recommendation. Both reads are cheap and local.
    void Promise.all([
      invoke<{ mem_total_bytes?: number }>("machine_load_snapshot").catch(() => null),
      invoke<GpuSample[]>("gpu_memory_snapshot").catch(() => [] as GpuSample[]),
    ]).then(([m, gpus]) => {
      if (!live.current) return;
      const ram = typeof m?.mem_total_bytes === "number" ? m.mem_total_bytes : 0;
      const vram = Math.max(0, ...(gpus ?? []).map((g) => g.vram_total ?? 0));
      setMachine({ ram, vram });
      setPick(recommendModel(ram, vram));
    });
  }, []);

  // The model list follows the server: read once it answers, cleared when it stops.
  useEffect(() => {
    if (serverUp) refreshModels();
    else setModels(null);
  }, [serverUp, status, refreshModels]);

  const installedNames = (models ?? []).map((m) => m.name);
  const has = (name: string) => installedNames.some((n) => sameModel(n, name));
  // The model the remaining steps act on: the one Local Model tabs already use,
  // else the recommendation once pulled, else whatever is installed first.
  const target =
    (tabsModel && has(tabsModel) ? tabsModel : undefined) ??
    (pick && has(pick.model) ? installedNames.find((n) => sameModel(n, pick.model)) : undefined) ??
    installedNames[0];
  const targetInfo = target ? models?.find((m) => sameModel(m.name, target)) : undefined;
  const onGpu = !!targetInfo?.running && targetInfo.size_vram > 0;
  const resident = !!targetInfo?.running;

  // Which agents can drive the target in a Local Model tab (Mistral Vibe,
  // Claude Code / Codex / OpenCode via `ollama launch`, …).
  useEffect(() => {
    if (!target) {
      setDrivers(null);
      return;
    }
    let cancelled = false;
    void listLocalDrivers(target)
      .then((d) => {
        if (!cancelled) setDrivers(d);
      })
      .catch(() => {
        if (!cancelled) setDrivers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  const installOllama = () => {
    const command = strategy?.command;
    if (!command) return;
    // The install script registers a system service and asks for sudo — a
    // visible terminal can answer that, the headless `install_ollama` cannot.
    const windows = strategy?.os ? strategy.os === "windows" : IS_WINDOWS;
    runInstallInTab(t("install.ollamaTabLabel"), command, windows ? "default" : "bash");
    onClose();
  };

  const recheckInstalled = () => {
    void invoke<boolean>("ollama_is_installed")
      .then((ok) => {
        if (live.current) setInstalled(ok);
      })
      .catch(() => {});
  };

  const startServer = () => {
    setError(null);
    void invoke("ensure_ollama_running")
      .then(refreshModels)
      .catch((e) => {
        if (live.current) setError(String(e));
      });
  };

  const pullModel = async (model: string) => {
    setError(null);
    setPull({ pct: null });
    // The same progress events the 🧠 menu and Settings follow, so this
    // download shows there too if the intro is closed mid-way.
    const unlisten = await listen<{ model: string; status: string; completed: number; total: number }>(
      "ollama-pull-progress",
      (e) => {
        if (!live.current || !sameModel(e.payload.model, model)) return;
        const { completed, total } = e.payload;
        setPull({ pct: total > 0 ? Math.round((completed / total) * 100) : null });
      },
    );
    try {
      await invoke("pull_ollama_model", { model });
      if (live.current) refreshModels();
    } catch (e) {
      if (live.current) setError(String(e));
    } finally {
      unlisten();
      if (live.current) setPull(null);
    }
  };

  const loadOnGpu = (model: string) => {
    setError(null);
    setLoading(true);
    void invoke("ensure_ollama_running")
      .then(() => loadOllamaModel(model, "gpu"))
      .then(() => {
        if (live.current) refreshModels();
      })
      .catch((e) => {
        if (live.current) setError(String(e));
      })
      .finally(() => {
        if (live.current) setLoading(false);
      });
  };

  const openSettings = (panel: string) => {
    window.dispatchEvent(new CustomEvent("app:open-settings", { detail: panel }));
    onClose();
  };

  const availableDrivers = (drivers ?? []).filter((d) => d.available);
  const runners = [...(vibe ? [t("intro.models.vibeRunner")] : []), ...availableDrivers.map((d) => d.label)];

  // The + menu reads `ollama_roles.tabs` before `ollama_model`, so a model
  // already pinned to the tabs role is the one to replace; otherwise the
  // default model is what the menu falls back to.
  const assignToTabs = (model: string) => {
    const roles = settings?.ollama_roles;
    void updateSettings(roles?.tabs ? { ollama_roles: { ...roles, tabs: model } } : { ollama_model: model });
  };

  const installVibe = () => {
    const command = vibeStrategy?.command;
    if (!command) return;
    runInstallInTab(t("install.vibeTabLabel"), command, vibeStrategy?.os === "windows" ? "powershell" : "bash");
    onClose();
  };

  return (
    <>
      <p className="settings-help">{t("intro.models.lead")}</p>
      <div className="intro-choice-row">
        <IntroStatus ok={installed === null ? null : installed && serverUp}>
          {installed === null
            ? t("intro.checking")
            : !installed
              ? t("intro.models.statusNotInstalled")
              : !serverUp
                ? t("intro.models.statusStopped")
                : t("intro.models.statusRunning", { count: models?.length ?? 0 })}
        </IntroStatus>
        <UntestedTag id="desktop.intro.localModels" />
      </div>

      <IntroSteps>
        <IntroStep num={1} title={t("intro.models.step1Title")} done={installed === true}>
          {installed === false && (
            <>
              <div className="settings-help">{t("intro.models.step1Body")}</div>
              {strategy?.command ? (
                <>
                  <code className="ollama-install-cmd">{strategy.command}</code>
                  <IntroActions>
                    <button type="button" className="settings-btn primary" onClick={installOllama}>
                      {t("intro.models.installOllama")}
                    </button>
                    <button type="button" className="settings-btn sm" onClick={recheckInstalled}>
                      {t("common.recheck")}
                    </button>
                  </IntroActions>
                </>
              ) : (
                <IntroActions>
                  <a href={strategy?.download_url || OLLAMA_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                    {t("intro.models.download")}
                  </a>
                  <button type="button" className="settings-btn sm" onClick={recheckInstalled}>
                    {t("common.recheck")}
                  </button>
                </IntroActions>
              )}
            </>
          )}
        </IntroStep>

        <IntroStep num={2} title={t("intro.models.step2Title")} done={installed === true && serverUp}>
          <div className="settings-help">{t("intro.models.step2Body")}</div>
          {installed === true && !serverUp && (
            <IntroActions>
              <button type="button" className="settings-btn sm" onClick={startServer}>
                {t("intro.models.startServer")}
              </button>
            </IntroActions>
          )}
        </IntroStep>

        <IntroStep num={3} title={t("intro.models.step3Title")} done={!!target}>
          <div className="settings-help">
            {pick && machine
              ? machine.vram >= GPU_SIZING_MIN_BYTES
                ? t("intro.models.recommendGpu", {
                    vram: formatBytes(machine.vram),
                    model: pick.model,
                    size: pick.sizeGb,
                  })
                : machine.ram > 0
                  ? t("intro.models.recommendRam", {
                      ram: formatBytes(machine.ram),
                      model: pick.model,
                      size: pick.sizeGb,
                    })
                  : t("intro.models.recommendUnknown", { model: pick.model, size: pick.sizeGb })
              : t("intro.checking")}
          </div>
          {installedNames.length > 0 && (
            <div className="settings-help">{t("intro.models.installedList", { list: installedNames.join(", ") })}</div>
          )}
          <IntroActions>
            {pick && !has(pick.model) && (
              <button
                type="button"
                className="settings-btn primary"
                disabled={!serverUp || pull !== null}
                onClick={() => void pullModel(pick.model)}
              >
                {pull
                  ? pull.pct === null
                    ? t("intro.models.pulling")
                    : t("intro.models.pullingPct", { pct: pull.pct })
                  : t("intro.models.pull", { model: pick.model })}
              </button>
            )}
            <button type="button" className="settings-btn sm" onClick={() => openSettings("ollama")}>
              {t("intro.models.browse")}
            </button>
          </IntroActions>
        </IntroStep>

        <IntroStep num={4} title={t("intro.models.step4Title")} done={onGpu}>
          <div className="settings-help">{t("intro.models.step4Body")}</div>
          {target && !onGpu && (
            <IntroActions>
              <button type="button" className="settings-btn sm" disabled={loading} onClick={() => loadOnGpu(target)}>
                {loading
                  ? t("intro.models.loading")
                  : resident
                    ? t("intro.models.reloadGpu", { model: target })
                    : t("intro.models.loadGpu", { model: target })}
              </button>
            </IntroActions>
          )}
        </IntroStep>

        <IntroStep num={5} title={t("intro.models.step5Title")} done={!!tabsModel && !!target && sameModel(target, tabsModel)}>
          <div className="settings-help">{t("intro.models.step5Body")}</div>
          {target && !(tabsModel && sameModel(target, tabsModel)) && (
            <IntroActions>
              <button
                type="button"
                className="settings-btn sm"
                onClick={() => assignToTabs(target)}
              >
                {t("intro.models.useForTabs", { model: target })}
              </button>
            </IntroActions>
          )}
          {vibe !== null && (
            <div className="settings-help">
              {runners.length > 0
                ? t("intro.models.drivers", { list: runners.join(", ") })
                : t("intro.models.noDrivers")}
            </div>
          )}
          <IntroActions>
            {vibe === false && vibeStrategy?.command && (
              <button type="button" className="settings-btn sm" onClick={installVibe}>
                {t("ollama.installVibe")}
              </button>
            )}
            <button type="button" className="settings-btn sm" onClick={() => startLessonById("local-model", onClose)}>
              {t("intro.walkMeThrough")}
            </button>
          </IntroActions>
        </IntroStep>

        <IntroStep num={6} title={t("intro.models.step6Title")}>
          <div className="settings-help">{t("intro.models.step6Body")}</div>
        </IntroStep>
      </IntroSteps>

      {error && <ErrorNote className="project-dialog-error" error={error} />}
      <p className="settings-help">{t("intro.terminalNote")}</p>
    </>
  );
}
