import { useState } from "react";
import { aiOffUntil, setAiOff, useAiOff } from "../../lib/aiSwitch";
import { formatTimelineInstant } from "../../lib/agents/prompt/timeline";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { useSettingsStore } from "../../stores/settings";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { RailPowerIcon } from "../common/EdgeRailIcons";
import { UntestedTag } from "../common/UntestedTag";

/** The rail menu's "off for N h" rows. */
const OFF_FOR_HOURS = [1, 2, 3, 5, 12];

/**
 * The AI switch (`lib/aiSwitch.ts`) as the edge rail's bottom button: machine-wide,
 * so it rides the rail — present in every scope, open panel or closed — rather
 * than a project's header. Not a view tab: `data-rail-action="ai"` keeps the
 * rail's hover-open dwell off it. While AI is on, a click opens a menu: off
 * until switched back on, or off for a few hours. While off, a click switches
 * it straight back on.
 */
export function RailAiSwitch() {
  const t = useT();
  const aiOff = useAiOff();
  const until = useSettingsStore((s) => (aiOff ? aiOffUntil(s.settings) : null));
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [custom, setCustom] = useState<string | null>(null);
  const close = () => {
    setMenu(null);
    setCustom(null);
  };
  const switchOff = (hours?: number) => {
    close();
    void setAiOff(true, hours);
  };
  const customHours = custom == null ? NaN : Number(custom.replace(",", "."));
  const customValid = Number.isFinite(customHours) && customHours > 0;
  let title = t("sidePanel.aiOnTitle");
  if (until != null) {
    const at = new Date(until);
    const sameDay = at.toDateString() === new Date().toDateString();
    title = t("sidePanel.aiOffUntilTitle", { time: formatTimelineInstant(at, lang, use24h, !sameDay) });
  } else if (aiOff) {
    title = t("sidePanel.aiOffTitle");
  }
  return (
    <>
      <button
        type="button"
        className={`side-panel-reveal-handle srh-ai${aiOff ? " off" : ""}`}
        data-rail-action="ai"
        onClick={(e) => {
          if (aiOff) {
            void setAiOff(false);
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.right, y: rect.top });
        }}
        aria-pressed={aiOff}
        aria-haspopup={aiOff ? undefined : "menu"}
        aria-label={t("sidePanel.aiAria")}
        title={title}
      >
        <RailPowerIcon />
        <UntestedTag id="sidePanel.aiSwitch" />
      </button>
      {menu && (
        <ContextMenuPortal x={menu.x} y={menu.y} onClose={close} className="tab-new-menu">
          <button type="button" className="tab-new-menu-item" onClick={() => switchOff()}>
            {t("sidePanel.aiMenuOff")}
          </button>
          {OFF_FOR_HOURS.map((hours) => (
            <button key={hours} type="button" className="tab-new-menu-item" onClick={() => switchOff(hours)}>
              {t("sidePanel.aiMenuFor", { hours })}
            </button>
          ))}
          {custom == null ? (
            <button type="button" className="tab-new-menu-item" onClick={() => setCustom("")}>
              {t("sidePanel.aiMenuCustom")}
              <UntestedTag id="sidePanel.aiTimer" />
            </button>
          ) : (
            <div className="vpn-indicator-row menu-form">
              <input
                type="text"
                inputMode="decimal"
                autoFocus
                placeholder={t("sidePanel.aiMenuHours")}
                aria-label={t("sidePanel.aiMenuHours")}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customValid) switchOff(customHours);
                }}
              />
              <div className="vpn-indicator-actions">
                <button
                  type="button"
                  className="vpn-indicator-connect"
                  disabled={!customValid}
                  onClick={() => switchOff(customHours)}
                >
                  {t("sidePanel.aiMenuApply")}
                </button>
                <button type="button" className="vpn-indicator-remove" onClick={() => setCustom(null)}>
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}
        </ContextMenuPortal>
      )}
    </>
  );
}
