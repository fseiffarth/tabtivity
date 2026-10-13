import { useModalFocus } from "../../hooks/useModalFocus";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { useTimerStore } from "../../stores/timer";
import { useQuiesce, saverInterval } from "../../stores/power";
import { ActivityCalendar } from "../projects/ActivityCalendar";
import { useT, type TranslationKey } from "../../lib/i18n";

function formatTime(t: (key: TranslationKey) => string, secs: number): string {
  if (secs < 60) return t("projectHoverCard.timeUnderMinute");
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function GlobalActivityWindow({ onClose }: { onClose: () => void }) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  const [data, setData] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<Record<string, number>>("get_project_activity", { projectId: "" })
      .then(setData)
      .catch(() => setData({}))
      .finally(() => setLoading(false));
  }, []);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="activity-window" onMouseDown={(e) => e.stopPropagation()}>
        <div className="activity-window-header">
          <span className="activity-window-title">{t("appTimer.globalActivityTitle")}</span>
          <button className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="activity-window-body">
          {loading ? (
            <div className="activity-loading">{t("common.loading")}</div>
          ) : (
            <ActivityCalendar data={data} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function AppTimerDisplay({ inMenu = false }: { inMenu?: boolean }) {
  const t = useT();
  const paused = useTimerStore((s) => s.paused);
  const toggle = useTimerStore((s) => s.toggle);
  const [displayText, setDisplayText] = useState(t("projectHoverCard.timeUnderMinute"));
  const [showActivity, setShowActivity] = useState(false);
  const quiesce = useQuiesce();

  useEffect(() => {
    const update = () => {
      setDisplayText(formatTime(t, useTimerStore.getState().getAppSecs()));
    };
    update();
    if (paused) return;
    const id = setInterval(update, saverInterval(1000, quiesce));
    return () => clearInterval(id);
  }, [paused, quiesce, t]);

  return (
    <>
      <button
        className={`${inMenu ? "tab-new-menu-item app-timer-menu-item" : "app-timer-btn"}${paused ? " paused" : ""}`}
        title={`${t("projectHoverCard.todayPrefix")} ${displayText}\n${paused ? t("appTimer.pausedResumeHint") : t("appTimer.clickPauseHint")}`}
        onClick={() => void toggle()}
        onContextMenu={(e) => {
          e.preventDefault();
          setShowActivity(true);
        }}
      >
        <span className="app-timer-dot" />
        <span className="app-timer-text">{displayText}</span>
      </button>
      {showActivity && <GlobalActivityWindow onClose={() => setShowActivity(false)} />}
    </>
  );
}
