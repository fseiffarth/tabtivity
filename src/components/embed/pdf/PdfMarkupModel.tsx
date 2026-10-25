/**
 * The markup strip's model chip: the model of the agent tab a Submit goes to,
 * and a click opens that session's own `/model` list under it — the Reader's
 * picker (`useSessionPicker`, `terminal-reader-picker`), so the round can go
 * to another model without leaving the PDF. Tabtivity picks nothing itself:
 * each answer is the user's, typed into the tab as its own keys.
 */
import { useEffect, useRef } from "react";
import { useT } from "../../../lib/i18n";
import { typePaneKeys } from "../../../lib/agents/paneKeys";
import { terminalFor } from "../../../lib/terminal/terminalRegistry";
import { modelPickOffered, useSessionPicker } from "../../../hooks/useSessionPicker";
import { agentTabLabel } from "../../../stores/agents/agentModels";
import type { TabEntry } from "../../../stores/tabs";
import { UntestedTag } from "../../common/UntestedTag";
import { isOpenCodeTab } from "../../../../mobile-web/src/terminal/openCodeMini";
import { groupOpenCodeModels, openCodeModelGroupTitle } from "../../../../mobile-web/src/terminal/openCodeModelGroups";

export function PdfMarkupModel({ tab, ptyId, label, model, agent, disabled }: {
  tab: TabEntry;
  ptyId: string;
  /** The target tab's name, for the chip's title. */
  label: string;
  /** Its model as the tab bar says it, when known. */
  model: string | undefined;
  /** What the target is doing: its list opens only while it is idle. */
  agent: "working" | "question" | "idle";
  /** A Submit is going out. */
  disabled: boolean;
}) {
  const t = useT();
  const session = useSessionPicker({
    tab,
    ptyId,
    agentLabel: agentTabLabel(tab),
    typeKeys: (keys) => typePaneKeys(ptyId, keys),
  });
  const { picking, picker, step, shownStep, busy, choose, close } = session;
  const boxRef = useRef<HTMLSpanElement>(null);
  // A click anywhere else closes the list, here and in the session.
  useEffect(() => {
    if (!picking) return;
    const away = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  });

  if (!modelPickOffered(tab)) return model ? <span className="file-viewer-pdf-redact-count">{model}</span> : null;
  // The list is read off the tab's screen, which must be in this window, and
  // opens once the agent is at its composer (the Reader's rule).
  const canPick = !!terminalFor(ptyId) && !!tab.scheduleTargetId && agent === "idle";
  return (
    <span ref={boxRef} className="file-viewer-pdf-markup-model">
      <button
        type="button"
        className={`file-viewer-zoom-btn file-viewer-zoom-text${picking ? " active" : ""}`}
        onClick={() => (picking ? close() : session.open("/model"))}
        disabled={!picking && (!canPick || disabled)}
        aria-haspopup="dialog"
        aria-expanded={picking}
        title={agent === "working" ? t("steering.prompt.chipWorking") : t("pdfMarkup.modelTitle", { tab: label })}
      >
        {model ?? t("terminal.reader.model")} ▾ <UntestedTag id="desktop.markup.model" />
      </button>
      {picking && (
        <div
          className="terminal-reader-picker"
          role="dialog"
          aria-label={shownStep?.title ?? t("terminal.reader.modelTitle")}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <div className="terminal-reader-picker-head">
            <strong>{shownStep?.title ?? t("terminal.reader.modelTitle")}</strong>
            <button type="button" className="terminal-reader-picker-close" onClick={close} aria-label={t("terminal.reader.modelClose")} title={t("terminal.reader.modelClose")}>✕</button>
          </div>
          {shownStep ? (
            <div className="terminal-reader-options">
              {(isOpenCodeTab(agentTabLabel(tab)) && shownStep.title === "Select model"
                ? groupOpenCodeModels(shownStep.options)
                : [{ key: "all", options: shownStep.options }]).map((group) => <div className="terminal-reader-option-group" key={group.key}>
                {group.key !== "all" && <div className="terminal-reader-option-group-title">{openCodeModelGroupTitle(group, t)}</div>}
                {group.options.map((option) => (
                <button
                  key={`${option.index}:${option.label}`}
                  type="button"
                  className={!session.remembered && picker && option.index === picker.current ? "terminal-reader-option current" : "terminal-reader-option"}
                  disabled={busy}
                  onClick={() => choose(option.index)}
                >
                  <span className="terminal-reader-option-number">{option.number}</span>
                  <span className="terminal-reader-option-label">
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
                ))}
              </div>)}
            </div>
          ) : (
            <small className="terminal-reader-question-more">{t("terminal.reader.modelWaiting")}</small>
          )}
          {step?.hidden ? <small className="terminal-reader-question-more">{t("terminal.reader.moreChoices")}</small> : null}
          {session.remembered && <small className="terminal-reader-question-more">{t("terminal.reader.modelRemembered")} <UntestedTag id="agents.modelRows.remembered" /></small>}
        </div>
      )}
    </span>
  );
}
