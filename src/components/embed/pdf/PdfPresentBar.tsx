/**
 * The present window's bottom bar: everything a reader standing at the
 * projector might want to glance at or press, in one strip they can take away
 * with `H` when the room should see nothing but the sheet.
 *
 * Purely presentational — the present window owns every piece of state, because
 * its keys drive the same things this bar's buttons do. Clicks here never reach
 * the window's click-to-advance, and the buttons never take focus, so Space or
 * Enter after pressing one still turns a sheet instead of re-pressing it.
 */

import type { MouseEvent, ReactNode } from "react";
import { useT } from "../../../lib/i18n";
import { useUse24h } from "../../../lib/timeFormat";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  LaserIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  TimerIcon,
  WindowIcon,
} from "../../common/icons/Icon";
import { UntestedTag } from "../../common/UntestedTag";
import { type TalkClock, clockElapsed, clockTone, formatClock } from "./present";

export type PresentBlank = "black" | "white" | null;

export interface PdfPresentBarProps {
  fileName: string;
  page: number;
  count: number;
  /** Epoch ms of the last tick — the bar re-renders on it. */
  now: number;
  clock: TalkClock;
  /** Target talk length in minutes; 0 = none. */
  target: number;
  /** When the sheet on screen was turned to (epoch ms). */
  sheetSince: number;
  blank: PresentBlank;
  laser: boolean;
  fullscreen: boolean;
  onStep: (delta: number) => void;
  onFirst: () => void;
  onLast: () => void;
  onToggleClock: () => void;
  onResetClock: () => void;
  onCycleTarget: () => void;
  onBlank: (mode: "black" | "white") => void;
  onToggleLaser: () => void;
  onToggleFullscreen: () => void;
  onHide: () => void;
  onClose: () => void;
}

/** Keep a press here from also being the window's click-to-advance. */
const swallow = (e: MouseEvent) => e.stopPropagation();
/** And from taking focus, which would make the next Space press it again. */
const noFocus = (e: MouseEvent) => e.preventDefault();

function BarButton({
  title,
  onClick,
  active,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`pdf-present-bar-btn${active ? " is-active" : ""}${className ? ` ${className}` : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={noFocus}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function PdfPresentBar(p: PdfPresentBarProps) {
  const t = useT();
  const use24h = useUse24h();
  const elapsed = clockElapsed(p.clock, p.now);
  const paused = p.clock.since === null;
  const tone = clockTone(elapsed, p.target, paused);
  const left = p.target * 60_000 - elapsed;
  const wall = new Date(p.now).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: !use24h,
  });
  const progress = p.count > 1 ? ((p.page - 1) / (p.count - 1)) * 100 : 100;

  return (
    <div
      className="pdf-present-bar"
      role="toolbar"
      aria-label={t("pdfPresent.barLabel")}
      onClick={swallow}
      onContextMenu={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onWheel={swallow}
    >
      <div className="pdf-present-bar-progress" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="pdf-present-bar-group is-file">
        <span className="pdf-present-bar-name" title={p.fileName}>
          {p.fileName}
        </span>
        <UntestedTag id="pdfPresent.barLabel" />
      </div>

      <div className="pdf-present-bar-group is-nav">
        <BarButton title={t("pdfPresent.firstTitle")} onClick={p.onFirst}>
          <SkipBackIcon />
        </BarButton>
        <BarButton title={t("pdfPresent.prevTitle")} onClick={() => p.onStep(-1)}>
          <ArrowLeftIcon />
        </BarButton>
        <span className="pdf-present-bar-page" title={t("pdfPresent.gotoHint")}>
          {p.page} / {p.count}
        </span>
        <BarButton title={t("pdfPresent.nextTitle")} onClick={() => p.onStep(1)}>
          <ArrowRightIcon />
        </BarButton>
        <BarButton title={t("pdfPresent.lastTitle")} onClick={p.onLast}>
          <SkipForwardIcon />
        </BarButton>
        <span className="pdf-present-bar-dim" title={t("pdfPresent.sheetTimeTitle")}>
          {formatClock(p.now - p.sheetSince)}
        </span>
      </div>

      <div className="pdf-present-bar-group is-clock">
        <span
          className={`pdf-present-bar-timer is-${tone}`}
          title={paused ? t("pdfPresent.timerPausedTitle") : t("pdfPresent.timerTitle")}
        >
          {formatClock(elapsed)}
        </span>
        {p.target > 0 && (
          <span className={`pdf-present-bar-dim is-${tone}`} title={t("pdfPresent.remainingTitle")}>
            {left >= 0 ? `−${formatClock(left)}` : `+${formatClock(-left)}`}
          </span>
        )}
        <BarButton
          title={paused ? t("pdfPresent.resumeTimerTitle") : t("pdfPresent.pauseTimerTitle")}
          onClick={p.onToggleClock}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </BarButton>
        <BarButton title={t("pdfPresent.resetTimerTitle")} onClick={p.onResetClock}>
          ↺
        </BarButton>
        <BarButton title={t("pdfPresent.targetTitle")} onClick={p.onCycleTarget} active={p.target > 0}>
          {p.target > 0 ? t("pdfPresent.targetMinutes", { n: p.target }) : <TimerIcon />}
        </BarButton>
        <span className="pdf-present-bar-wall" title={t("pdfPresent.wallClockTitle")}>
          {wall}
        </span>
      </div>

      <div className="pdf-present-bar-group is-actions">
        <BarButton
          title={p.laser ? t("pdfPresent.laserOffTitle") : t("pdfPresent.laserOnTitle")}
          onClick={p.onToggleLaser}
          active={p.laser}
        >
          <LaserIcon />
        </BarButton>
        <BarButton
          title={t("pdfPresent.blackTitle")}
          onClick={() => p.onBlank("black")}
          active={p.blank === "black"}
        >
          <span className="pdf-present-swatch is-black" />
        </BarButton>
        <BarButton
          title={t("pdfPresent.whiteTitle")}
          onClick={() => p.onBlank("white")}
          active={p.blank === "white"}
        >
          <span className="pdf-present-swatch is-white" />
        </BarButton>
        <BarButton
          title={p.fullscreen ? t("pdfPresent.windowedTitle") : t("pdfPresent.fullscreenTitle")}
          onClick={p.onToggleFullscreen}
          active={!p.fullscreen}
        >
          <WindowIcon />
        </BarButton>
        <BarButton title={t("pdfPresent.hideBarTitle")} onClick={p.onHide} className="is-key">
          H
        </BarButton>
        <BarButton title={t("pdfPresent.closeTitle")} onClick={p.onClose}>
          ✕
        </BarButton>
      </div>
    </div>
  );
}
