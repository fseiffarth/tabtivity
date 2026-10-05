import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useHeaderStatusReport, type HeaderStatusReport } from "../../stores/headerStatus";
import { useQuiesce, saverInterval } from "../../stores/power";
import { useProjectsStore } from "../../stores/projects";
import { openTabInRootConsole } from "../../stores/rootOverlay";
import { shellQuote } from "../../lib/terminal/shellScriptRun";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { ErrorNote } from "../common/ErrorNote";

/**
 * The background "Tabtivity (dev)" freeze that every commit queues
 * (`scripts/package-dev-auto.sh`, docs/context/dev_builds.md), as a header
 * chip: which step the build is on, for how long, and roughly how much is left
 * (the last successful build's duration is the estimate — nothing better is
 * knowable from a release `cargo build`).
 *
 * `dev_build_status` reads the script's own state files, and one action opens
 * a root-console tab tailing its log. The only build control is the user's
 * pause switch (`dev_build_set_paused`): pausing hands the machine back —
 * nothing queues and a running compile is cancelled — and resuming queues
 * HEAD if the snapshot fell behind meanwhile. While paused, "Build now"
 * (`dev_build_now`) builds HEAD once when it is newer than the snapshot and
 * stays paused. The other action is the user's own relaunch:
 * in the frozen window, once a newer snapshot is installed or built, "Relaunch
 * now" quits through the ordinary close and reopens via the launcher
 * (`dev_build_relaunch`).
 *
 * Only a binary built from a checkout answers (`TABTIVITY_DEV_SOURCE_ROOT`); a
 * release answers `null` and this renders nothing, so the chip is never a
 * cluster member there.
 *
 * As a cluster member a running or queued build reports `attention` and a
 * failed one `alert`, so a folded cluster's summary lamp turns amber / red.
 * Idle reports `ok`.
 */

type BuildState = "idle" | "waiting" | "building";
type BuildPhase = "prepare" | "frontend" | "mobile" | "cargo" | "install";

interface DevBuildStatus {
  state: BuildState;
  phase: BuildPhase | null;
  commit: string | null;
  startedAt: number | null;
  estimateSecs: number | null;
  queued: boolean;
  failed: { commit: string; status: string; when: string } | null;
  installed: string | null;
  behind: number | null;
  relaunch: boolean;
  adoptable: string | null;
  canRelaunch: boolean;
  paused: boolean;
  logPath: string;
}

const MENU_ID = "devBuild";
/** A build moves step to step in seconds; an idle one changes only on commit. */
const ACTIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 20_000;

const PHASE_KEY = {
  prepare: "devBuild.phase.prepare",
  frontend: "devBuild.phase.frontend",
  mobile: "devBuild.phase.mobile",
  cargo: "devBuild.phase.cargo",
  install: "devBuild.phase.install",
} as const;

export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Share of the estimate spent, held short of full: an estimate is not a
 *  finish line, and a bar parked at 100% while cargo still links reads as hung. */
export function buildProgress(elapsedSecs: number, estimateSecs: number | null): number | null {
  if (!estimateSecs || estimateSecs <= 0) return null;
  return Math.min(0.95, Math.max(0, elapsedSecs / estimateSecs));
}

function HammerIcon({ tone }: { tone: string }) {
  return (
    <svg
      className={`dev-build-icon ${tone}`}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* head */}
      <path
        d="M6.2 2.6h5.2l1.6 1.6v1.6H6.2z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      {/* handle */}
      <line x1="9" y1="5.8" x2="9" y2="13.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

export function DevBuildIndicator() {
  const t = useT();
  const quiesce = useQuiesce();
  const open = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const [status, setStatus] = useState<DevBuildStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [relaunching, setRelaunching] = useState(false);
  const [relaunchError, setRelaunchError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [startingBuild, setStartingBuild] = useState(false);
  const [buildNowError, setBuildNowError] = useState<string | null>(null);
  // Bumped after a pause/resume/build-now so the poll re-reads at once.
  const [refresh, setRefresh] = useState(0);
  const closeTimer = useRef<number | undefined>(undefined);

  const active = status?.state === "building" || status?.state === "waiting";

  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      invoke<DevBuildStatus | null>("dev_build_status")
        .then((next) => {
          if (!cancelled) setStatus(next ?? null);
        })
        // A backend without the command (a window served ahead of its binary)
        // simply has no chip.
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
    void poll();
    const id = window.setInterval(poll, saverInterval(active ? ACTIVE_POLL_MS : IDLE_POLL_MS, quiesce));
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, quiesce, refresh]);

  // The elapsed clock ticks locally between polls.
  const building = status?.state === "building";
  useEffect(() => {
    if (!building) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [building]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const elapsed = building && status?.startedAt ? now / 1000 - status.startedAt : null;
  const progress = elapsed === null ? null : buildProgress(elapsed, status?.estimateSecs ?? null);
  const failed = status?.state === "idle" ? status.failed : null;
  const tone = building || status?.state === "waiting" ? "active" : failed ? "error" : "idle";

  let headline = "";
  let chipText: string | null = null;
  if (status) {
    if (building) {
      const phase = t(PHASE_KEY[status.phase ?? "prepare"]);
      headline = t("devBuild.building", { commit: status.commit ?? "?", phase });
      chipText = elapsed === null ? phase : `${phase} ${formatDuration(elapsed)}`;
    } else if (status.state === "waiting") {
      headline = t("devBuild.waiting");
      chipText = t("devBuild.chipQueued");
    } else if (status.paused) {
      headline = t("devBuild.paused");
      chipText = t("devBuild.chipPaused");
    } else if (failed) {
      headline = t("devBuild.failed", { commit: failed.commit, status: failed.status });
      chipText = t("devBuild.chipFailed");
    } else if (status.behind) {
      headline = t("devBuild.behind", { count: status.behind });
    } else {
      headline = t("devBuild.upToDate", { commit: status.installed ?? "?" });
    }
  }

  const report: HeaderStatusReport | null = status
    ? {
        tone: tone === "active" ? "attention" : tone === "error" ? "alert" : "ok",
        label: `${t("devBuild.title")}: ${headline}`,
      }
    : null;
  useHeaderStatusReport("devBuild", report);

  if (!status) return null;

  const reveal = () => openMenu(MENU_ID);
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => closeMenu(MENU_ID), 250);
  };

  const followLog = () => {
    closeMenu(MENU_ID);
    openTabInRootConsole({
      label: t("devBuild.logTab"),
      cmd: "",
      cwd: useProjectsStore.getState().rootDir ?? "",
      kind: "shell",
      initialInput: `tail -n 60 -F ${shellQuote(status.logPath)}`,
      // A `tail -F` is re-openable from here at any time; left in a tmux
      // session it would outlive the app for nothing.
      ephemeral: true,
    });
  };

  const relaunchNow = () => {
    setRelaunching(true);
    setRelaunchError(null);
    // On success the window closes under us; only a refusal comes back.
    invoke("dev_build_relaunch").catch((e: unknown) => {
      setRelaunching(false);
      setRelaunchError(String(e));
    });
  };

  const setPaused = (paused: boolean) => {
    setPausing(true);
    setPauseError(null);
    invoke("dev_build_set_paused", { paused })
      .then(() => setStatus((s) => (s ? { ...s, paused } : s)))
      .catch((e: unknown) => setPauseError(String(e)))
      .finally(() => {
        setPausing(false);
        setRefresh((n) => n + 1);
      });
  };

  const buildNow = () => {
    setStartingBuild(true);
    setBuildNowError(null);
    invoke("dev_build_now")
      .catch((e: unknown) => setBuildNowError(String(e)))
      .finally(() => {
        setStartingBuild(false);
        setRefresh((n) => n + 1);
      });
  };
  // Paused and idle with HEAD ahead of the snapshot (or no snapshot to compare
  // against: the script itself skips a HEAD that is already installed).
  const canBuildNow = status.paused && !active && status.behind !== 0;

  let detail: string | null = null;
  if (building && elapsed !== null) {
    const est = status.estimateSecs;
    detail =
      est && est > elapsed
        ? t("devBuild.elapsedLeft", { elapsed: formatDuration(elapsed), left: formatDuration(est - elapsed) })
        : est
          ? t("devBuild.elapsedOver", { elapsed: formatDuration(elapsed), last: formatDuration(est) })
          : t("devBuild.elapsed", { elapsed: formatDuration(elapsed) });
  } else if (status.state === "waiting") {
    detail = t("devBuild.waitingDetail");
  } else if (status.paused) {
    detail = t("devBuild.pausedDetail");
  }

  return (
    <div
      className="global-apps-menu header-status-menu-anchor no-drag"
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="global-apps-menu-btn dev-build-btn"
        aria-label={`${t("devBuild.title")}: ${headline}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${t("devBuild.title")}: ${headline}`}
        onClick={reveal}
        onFocus={reveal}
      >
        <HammerIcon tone={tone} />
        {chipText && <span className={`vpn-indicator-label dev-build-chip-text ${tone}`}>{chipText}</span>}
        {progress !== null && (
          <span className="dev-build-bar" aria-hidden>
            <span style={{ width: `${progress * 100}%` }} />
          </span>
        )}
      </button>
      {open && (
        <div className="tab-new-menu mobile-indicator-menu" role="menu">
          <div className="tab-new-menu-group-label vpn-indicator-title">
            <span>
              {t("devBuild.title")} <UntestedTag id="devBuild.title" />
            </span>
            <button
              type="button"
              className="vpn-indicator-close"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={() => closeMenu(MENU_ID)}
            >
              ×
            </button>
          </div>
          <div className="mobile-indicator-body">
            <div className="mobile-indicator-status" aria-live="polite">
              <HammerIcon tone={tone} />
              <div>
                <strong>{headline}</strong>
                {detail && <span>{detail}</span>}
              </div>
            </div>
            {progress !== null && (
              <div className="dev-build-bar dev-build-bar-wide" aria-hidden>
                <span style={{ width: `${progress * 100}%` }} />
              </div>
            )}
            <div className="mobile-indicator-origin">
              {status.installed && <div>{t("devBuild.installed", { commit: status.installed })}</div>}
              {!!status.behind && (building || status.paused) && <div>{t("devBuild.behind", { count: status.behind })}</div>}
              {status.queued && building && <div>{t("devBuild.queuedNext")}</div>}
            </div>
            {failed && (
              <div className="mobile-indicator-error">{t("devBuild.failedWhen", { when: failed.when })}</div>
            )}
            {status.relaunch ? (
              <div className="mobile-indicator-notice">{t("devBuild.relaunch")}</div>
            ) : (
              status.canRelaunch &&
              status.adoptable && (
                <div className="mobile-indicator-notice">
                  {t("devBuild.adoptable", { commit: status.adoptable })}
                </div>
              )
            )}
            {relaunchError && <ErrorNote className="mobile-indicator-error" error={relaunchError} />}
            {pauseError && <ErrorNote className="mobile-indicator-error" error={pauseError} />}
            {buildNowError && <ErrorNote className="mobile-indicator-error" error={buildNowError} />}
            <div className="mobile-indicator-actions">
              {status.canRelaunch && (
                <button
                  type="button"
                  className="vpn-indicator-connect"
                  disabled={relaunching}
                  title={t("devBuild.relaunchNowHint")}
                  onClick={relaunchNow}
                >
                  {relaunching ? t("devBuild.relaunching") : t("devBuild.relaunchNow")}{" "}
                  <UntestedTag id="devBuild.relaunchNow" />
                </button>
              )}
              <button
                type="button"
                className="vpn-indicator-connect"
                disabled={pausing}
                aria-pressed={status.paused}
                title={t(status.paused ? "devBuild.resumeHint" : "devBuild.pauseHint")}
                onClick={() => setPaused(!status.paused)}
              >
                {t(status.paused ? "devBuild.resume" : "devBuild.pause")} <UntestedTag id="devBuild.pause" />
              </button>
              {canBuildNow && (
                <button
                  type="button"
                  className="vpn-indicator-connect"
                  disabled={startingBuild}
                  title={t("devBuild.buildNowHint")}
                  onClick={buildNow}
                >
                  {startingBuild ? t("devBuild.startingBuild") : t("devBuild.buildNow")}{" "}
                  <UntestedTag id="devBuild.buildNow" />
                </button>
              )}
              <button type="button" className="vpn-indicator-connect" onClick={followLog}>
                {t("devBuild.openLog")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
