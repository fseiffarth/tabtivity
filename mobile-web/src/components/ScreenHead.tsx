import type { ReactNode } from "react";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { ChevronLeftIcon, RefreshIcon } from "../glyphs";

/**
 * The head Mail, To-do and Calendar share, in Home's idiom: a large title with
 * icon-only buttons at its right, and one level down a back row (a chevron and
 * the parent's name) above it. The buttons are Home's own `.home-head-button`
 * and each needs an `aria-label`; `onRefresh` draws the first one. `subtitle`
 * (text, or the screen's own button) sits under the title. `untested` joins the
 * screen's own register check to the head's pill (`mobile.design.toolHead`).
 * `compact` is for a long, free-text title (a mail subject): the buttons move
 * up to the back row's right end, so the title gets the full width, set one
 * size smaller and cut at three lines.
 */
export function ScreenHead({ title, subtitle, back, actions, onRefresh, refreshing, untested, compact }: {
  title: string;
  subtitle?: ReactNode;
  back?: { label: string; onClick: () => void };
  actions?: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  untested?: boolean;
  compact?: boolean;
}) {
  const t = useT();
  const buttons = (onRefresh || actions) && <div className="screen-head-actions">
    {onRefresh && <button className="home-head-button" onClick={onRefresh} disabled={refreshing} aria-label={t("common.refresh")} title={t("common.refresh")}><RefreshIcon size="22px" /></button>}
    {actions}
  </div>;
  const inBack = compact && !!back;
  return <header className={compact ? "screen-head screen-head-compact" : "screen-head"}>
    {back && <div className="screen-head-backrow">
      <button className="screen-head-back" onClick={back.onClick}><ChevronLeftIcon size="20px" />{back.label}</button>
      {inBack && buttons}
    </div>}
    <div className="projects-row">
      <div className="screen-head-main">
        <div className="screen-head-title">
          <h1>{title}</h1>
          {(untested || isUntested("mobile.design.toolHead")) && <span className="untested">{t("mobile.newTab.untested")}</span>}
        </div>
        {subtitle && <div className="screen-head-sub">{subtitle}</div>}
      </div>
      {!inBack && buttons}
    </div>
  </header>;
}
