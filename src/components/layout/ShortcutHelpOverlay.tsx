import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import {
  SHORTCUT_DEFS,
  SHORTCUT_GROUPS,
  STEERING_CONTEXTS,
  STEERING_KEYS,
  chordLabel,
  modifierLabel,
  resolveChord,
  steeringRowLabel,
  type ShortcutMap,
} from "../../lib/shortcuts/shortcuts";
import type { SteeringKeyMap } from "../../lib/shortcuts/steeringBindings";

/**
 * The keyboard-shortcut cheat sheet (part 2 of the keyboard-only steering
 * system) — opened by the `shortcutHelp` chord (F1 by default), by `?` inside
 * steering mode, and from the header ⚙ menu; all three doors dispatch the one
 * `tabtivity:open-shortcut-help` window event this host listens for.
 *
 * Every key it shows renders from `lib/shortcuts/shortcuts` — `SHORTCUT_DEFS` through
 * `resolveChord`, so a user rebind shows its *effective* chord (marked
 * "customized"), plus the `STEERING_KEYS` rows through the user's steering
 * bindings (`steeringRowLabel`) — never a hardcoded key string, so the sheet
 * cannot drift from what `useKeyboard` acts on. Mounted once in `AppShell` on the shared `.modal-backdrop` like the
 * overlay family there.
 */
export function ShortcutHelpOverlay() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const overrides = useSettingsStore(
    (s) => s.settings?.keyboard_shortcuts,
  ) as ShortcutMap | undefined;
  const steerKeys = useSettingsStore((s) => s.settings?.steering_keys) as SteeringKeyMap | undefined;

  useEffect(() => {
    const openIt = () => setOpen(true);
    window.addEventListener("app:open-shortcut-help", openIt);
    return () => window.removeEventListener("app:open-shortcut-help", openIt);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    // Focus the scroll body so the sheet is keyboard-walkable from the F1/?
    // press that opened it — arrows and PageUp/Down scroll with no pointer.
    scrollRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const close = () => setOpen(false);

  return (
    /* The canonical framed-dialog chrome, applied as the calendar/mail overlays
       apply it (accent header band + divider, `.dialog-close-btn`); the
       `.dialog-scroll` child does the scrolling inside the frame's curve. */
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="project-dialog dialog-framed shortcut-help-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcutHelp.title")}
      >
        <div className="settings-title-row">
          <h2>
            {t("shortcutHelp.title")} <UntestedTag id="shortcutHelp.title" />
          </h2>
          <button
            type="button"
            className="dialog-close-btn"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={close}
          >
            ×
          </button>
        </div>
        <div className="dialog-scroll" ref={scrollRef} tabIndex={-1}>
          {SHORTCUT_GROUPS.map((g) => (
            <section className="shortcut-help-section" key={g.id}>
              <h3>{t(g.labelKey)}</h3>
              {SHORTCUT_DEFS.filter((d) => d.group === g.id).map((d) => (
                <div className="shortcut-help-row" key={d.action}>
                  <kbd>{chordLabel(resolveChord(d.action, overrides))}</kbd>
                  <span className="shortcut-help-label">
                    {t(d.labelKey)}
                    {overrides?.[d.action] && (
                      <span className="shortcut-help-custom">
                        {" "}
                        ({t("shortcutHelp.customized")})
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </section>
          ))}
          <section className="shortcut-help-section">
            {/* The legend itself stays free of pills: they would crowd the
                level name it shows. Its untested features are tagged here. */}
            <h3>
              {t("shortcutHelp.steeringTitle")}
              <UntestedTag id="steering.agentKeysStay" />
              <UntestedTag id="steering.overlays" />
              <UntestedTag id="steering.scroll" />
              <UntestedTag id="steering.scrollDocument" />
              <UntestedTag id="steering.legendGroups" />
              <UntestedTag id="steering.handoffLegend" />
              <UntestedTag id="steering.dim" />
              <UntestedTag id="steering.popout" />
              <UntestedTag id="steering.pointer" />
              <UntestedTag id="steering.landOnTabs" />
              <UntestedTag id="steering.shiftPanes" />
            </h3>
            <p className="shortcut-help-intro">
              {t("shortcutHelp.steeringIntro", {
                chord: chordLabel(resolveChord("steeringMode", overrides)),
              })}
            </p>
            {/* One block per level, each key under the first level it acts on
                (B, P, the status jumps and ? work on every tab-bar level; they
                are listed once). */}
            {STEERING_CONTEXTS.map((level) => {
              const rows = STEERING_KEYS.filter((k) => k.levels[0] === level.id);
              if (rows.length === 0) return null;
              return (
                <div className="shortcut-help-steering-level" key={level.id}>
                  <h4>{t(level.labelKey)}</h4>
                  {rows.map((k) => (
                    <div className="shortcut-help-row" key={`${k.actions.join(",")}|${k.labelKey}`}>
                      <kbd>{steeringRowLabel(k, steerKeys)}</kbd>
                      <span className="shortcut-help-label">
                        {t(k.labelKey)}
                        <span className="shortcut-help-desc"> — {t(k.descKey, { modifier: modifierLabel() })}</span>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </section>
          <p className="shortcut-help-footer">
            {t("shortcutHelp.footer", { panel: t("nav.shortcuts.title") })}
          </p>
        </div>
      </div>
    </div>
  );
}
