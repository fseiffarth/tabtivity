import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { runWithProgress } from "../../../lib/runWithProgress";
import { startInstallRun, useInstallRunsStore, type InstallRun } from "../../../stores/installRuns";
import { useT } from "../../../lib/i18n";
import { formatBytes } from "../../../lib/formatBytes";
import { IS_HOST_WINDOWS } from "../../../lib/platform";
import { chordLabel, modifierLabel } from "../../../lib/shortcuts/shortcuts";
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
/** `installRuns` keys — the backend's install-lock keys for the two. */
const OLLAMA_RUN = "ollama";
const VIBE_RUN = "vibe";

/**
 * Intro page 4 — a local model, step by step: install Ollama, start it, pull a
 * model sized for this machine, load it onto the GPU, use it in a Local Model
 * tab, and (optionally) for autocomplete. Every probe is local (Ollama is on
 * this machine) and lives only while this page is mounted, i.e. visible; the
 * Ollama lamp rides the app's one shared poller (`useOllamaStatus`).
 *
 * Installs run headless where Settings' own one-click path needs no password —
 * Vibe everywhere (per-user), Ollama on Windows (winget, per-user) — with a
 * live log, then re-detect, and the wizard stays open. The runs live in
 * `stores/installRuns`, so leaving this page mid-install and coming back shows
 * the same run, and its end is re-detected whichever mount sees it. On Linux
 * and macOS Ollama installs with ollama.com's `install.sh`, which may ask for
 * a sudo password; that one opens a terminal tab and the wizard steps aside.
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
  // The headless installs (`install_ollama` / `install_vibe`), shared with
  // every other view through the module-level run store.
  const ollamaRun = useInstallRunsStore((s) => s.runs[OLLAMA_RUN]);
  const vibeRun = useInstallRunsStore((s) => s.runs[VIBE_RUN]);
  const jobLogRef = useRef<HTMLPreElement>(null);
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
  // OpenCode / Pi / Claude Code / Codex via `ollama launch`, …).
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

  // Keep the live install log pinned to its latest line.
  useEffect(() => {
    const el = jobLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ollamaRun?.log, vibeRun?.log]);

  const windows = strategy?.os ? strategy.os === "windows" : IS_HOST_WINDOWS;
  // Settings' one-click path where it needs no password (winget, per-user);
  // Linux/macOS's script registers a system service and asks for sudo.
  const ollamaHeadless = windows && !!strategy?.auto;

  const installOllamaInTerminal = () => {
    const command = strategy?.command;
    if (!command) return;
    // The install script registers a system service and asks for sudo — a
    // visible terminal can answer that, the headless `install_ollama` cannot.
    runInstallInTab(t("install.ollamaTabLabel"), command, windows ? "default" : "bash");
    onClose();
  };

  const installOllama = () => {
    if (!ollamaHeadless) {
      installOllamaInTerminal();
      return;
    }
    // As Settings does after its install, the server is started on success —
    // by the run itself, so it happens even if this page was left meanwhile.
    void startInstallRun<{ line: string }>(OLLAMA_RUN, {
      event: "ollama-install-progress",
      line: (p) => p.line,
      command: "install_ollama",
      detect: () => invoke<boolean>("ollama_is_installed"),
      onSuccess: () => void invoke("ensure_ollama_running").catch(() => {}),
    });
  };

  // A run that ended well — started here, before this mount, or elsewhere —
  // is re-detected by whichever mount sees the end.
  const ollamaDone = ollamaRun?.succeeded ?? 0;
  const seenOllamaDone = useRef(ollamaDone);
  useEffect(() => {
    if (ollamaDone === seenOllamaDone.current) return;
    seenOllamaDone.current = ollamaDone;
    void invoke<boolean>("ollama_is_installed")
      .then((ok) => {
        if (!live.current) return;
        setInstalled(ok);
        if (ok) refreshModels();
      })
      .catch(() => {});
  }, [ollamaDone, refreshModels]);

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
    try {
      await runWithProgress<{ model: string; status: string; completed: number; total: number }, unknown>(
        "ollama-pull-progress",
        (p) => {
          if (!live.current || !sameModel(p.model, model)) return;
          setPull({ pct: p.total > 0 ? Math.round((p.completed / p.total) * 100) : null });
        },
        () => invoke("pull_ollama_model", { model }),
      );
      if (live.current) refreshModels();
    } catch (e) {
      if (live.current) setError(String(e));
    } finally {
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

  const installVibeInTerminal = () => {
    const command = vibeStrategy?.command;
    if (!command) return;
    runInstallInTab(t("install.vibeTabLabel"), command, vibeStrategy?.os === "windows" ? "powershell" : "bash");
    onClose();
  };

  // Vibe installs per-user (no password), so headless as Settings runs it.
  const installVibe = () => {
    void startInstallRun<{ line: string }>(VIBE_RUN, {
      event: "vibe-install-progress",
      line: (p) => p.line,
      command: "install_vibe",
      detect: () => invoke<boolean>("vibe_is_installed"),
    });
  };

  const vibeDone = vibeRun?.succeeded ?? 0;
  const seenVibeDone = useRef(vibeDone);
  useEffect(() => {
    if (vibeDone === seenVibeDone.current) return;
    seenVibeDone.current = vibeDone;
    void invoke<boolean>("vibe_is_installed")
      .then((ok) => {
        if (!live.current) return;
        setVibe(ok);
        if (!ok) {
          setError(
            vibeStrategy?.os === "windows" ? t("ollama.vibeStillNotDetectedWindows") : t("ollama.vibeStillNotDetectedOther"),
          );
        }
      })
      .catch(() => {});
  }, [vibeDone, vibeStrategy?.os, t]);

  const ollamaRunning = !!ollamaRun?.running;
  const vibeRunning = !!vibeRun?.running;
  const failed = (run: InstallRun | undefined) => !!run && !run.running && !!run.error;
  /** A run's progress: who holds it, the live log, or the failure. */
  const runView = (run: InstallRun | undefined) =>
    run && (
      <>
        {run.running && (
          <IntroStatus ok={null}>
            {run.elsewhere ? t("intro.models.installElsewhere") : t("ollama.runningInstaller")}
          </IntroStatus>
        )}
        {(run.running || run.error) && !run.elsewhere && (
          <pre className="ollama-install-log" ref={run.running ? jobLogRef : undefined} role="log">
            {run.log || t("ollama.startingEllipsis")}
          </pre>
        )}
        {failed(run) && <ErrorNote className="project-dialog-error" error={run.error ?? ""} role="alert" />}
      </>
    );
  // The pull's reason to wait, said beside the disabled button.
  const pullBlocked =
    installed === false
      ? t("intro.models.pullNeedsInstall")
      : installed === true && !serverUp
        ? t("intro.models.pullNeedsServer")
        : null;

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
              <div className="settings-help">
                {t(ollamaHeadless ? "intro.models.step1BodyWindows" : "intro.models.step1Body")}
              </div>
              {strategy?.command ? (
                <>
                  <code className="ollama-install-cmd">{strategy.command}</code>
                  <IntroActions>
                    <button
                      type="button"
                      className="settings-btn primary"
                      disabled={ollamaRunning}
                      onClick={installOllama}
                    >
                      {ollamaHeadless
                        ? ollamaRunning
                          ? t("ollama.installingEllipsis")
                          : t("ollama.installBtn")
                        : t("intro.models.installOllama")}
                    </button>
                    {/* The headless one failed: the terminal can answer what it could not. */}
                    {ollamaHeadless && failed(ollamaRun) && (
                      <button type="button" className="settings-btn sm" onClick={installOllamaInTerminal}>
                        {t("intro.models.installOllama")}
                      </button>
                    )}
                    <button type="button" className="settings-btn sm" disabled={ollamaRunning} onClick={recheckInstalled}>
                      {t("common.recheck")}
                    </button>
                    {ollamaHeadless && <UntestedTag id="desktop.intro.localModelsInlineInstall" />}
                  </IntroActions>
                  {runView(ollamaRun)}
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
                aria-describedby={pullBlocked ? "intro-models-pull-blocked" : undefined}
                onClick={() => void pullModel(pick.model)}
              >
                {pull ? t("intro.models.pulling") : t("intro.models.pull", { model: pick.model })}
              </button>
            )}
            <button type="button" className="settings-btn sm" onClick={() => openSettings("ollama")}>
              {t("intro.models.browse")}
            </button>
          </IntroActions>
          {pull && (
            <IntroStatus ok={null}>
              {pull.pct === null ? t("intro.models.pulling") : t("intro.models.pullingPct", { pct: pull.pct })}
            </IntroStatus>
          )}
          {pick && !has(pick.model) && pullBlocked && (
            <div className="settings-help" id="intro-models-pull-blocked">
              {pullBlocked}
            </div>
          )}
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
              <>
                <button type="button" className="settings-btn sm" disabled={vibeRunning} onClick={installVibe}>
                  {vibeRunning ? t("ollama.installingEllipsis") : t("ollama.installVibe")}
                </button>
                {failed(vibeRun) && (
                  <button type="button" className="settings-btn sm" onClick={installVibeInTerminal}>
                    {t("ollama.runInTerminal")}
                  </button>
                )}
                <UntestedTag id="desktop.intro.localModelsInlineInstall" />
              </>
            )}
            <button type="button" className="settings-btn sm" onClick={() => startLessonById("local-model", onClose)}>
              {t("intro.walkMeThrough")}
            </button>
          </IntroActions>
          {vibe === false && runView(vibeRun)}
        </IntroStep>

        <IntroStep num={6} title={t("intro.models.step6Title")}>
          <div className="settings-help">{t("intro.models.step6Body", { modifier: modifierLabel(), altRight: chordLabel({ key: "ArrowRight", alt: true }) })}</div>
        </IntroStep>
      </IntroSteps>

      {error && <ErrorNote className="project-dialog-error" error={error} />}
      <p className="settings-help">{t("intro.terminalNoteInline")}</p>
    </>
  );
}
